//! Tests of L3, AppLocker (plan Step 7): the mechanism table, deterministic XML, the golden
//! files, the checks on generated output, what Staff can and cannot start under the generated
//! rules (the Rulebox programs, the Staff App, the launcher, WebView2 and catalogue apps keep
//! running), and the layer against `SimPlatform`. Nothing touches the machine.
//!
//! The golden files are `apps/agent/tests/golden/applocker/*.xml`. Set
//! `RULEBOX_BLESS_GOLDEN=1` and run the golden test to write them; read the diff before you
//! commit it.

use std::path::PathBuf;
use std::sync::Arc;

use rulebox_policy::lockdown::{
    ExceptionKind, ExceptionLayer, ExceptionRule, LayerSetting, LockdownPolicy, PublisherMatch,
};
use rulebox_policy::AgentDoc;
use rulebox_win32::applocker as win32;

use super::*;
use crate::journal::{EntryPhase, JournalCtx, JournalEntry, JournalTarget, OriginalValue};
use crate::lockdown::allowlist::{writable_by_staff, KNOWN_WRITABLE_WINDOWS_FOLDERS};
use crate::lockdown::apply::{apply as apply_all, ApplyRefusal};
use crate::lockdown::invariants::Facts;
use crate::platform::sim::{sim_path_roots, SimOp, SimPlatform, SimUser};
use crate::platform::{FolderAcl, Platform, PlatformError};
use crate::state::{AgentState, SharedState, StaffAccount, StateStore};
use crate::testutil::TempDir;

const STAFF: &str = "S-1-5-21-1-1-1-2001";
const ADMIN: &str = "S-1-5-21-1000-2000-3000-1001";
const OTHER: &str = "S-1-5-21-1000-2000-3000-1002";
const ADMIN_ONLY: &str = "D:PAI(A;OICI;FA;;;BA)(A;OICI;FA;;;SY)(A;OICI;0x1200a9;;;BU)";

fn protected() -> Vec<String> {
    vec![r"C:\Program Files\Rulebox".into(), r"C:\Program Files (x86)\Microsoft\EdgeWebView".into()]
}

fn scan_fixture() -> Vec<FolderAcl> {
    [
        (r"C:\Windows", ADMIN_ONLY),
        (r"C:\Windows\System32", ADMIN_ONLY),
        (r"C:\Windows\Logs", ADMIN_ONLY),
        (r"C:\Windows\Vendor\Cache", "D:(A;OICI;0x1301bf;;;BU)"),
        (r"C:\Windows\Vendor\Cache\deeper", "D:(A;OICI;0x1301bf;;;BU)"),
        (r"C:\Windows\Vendor\Reports", "D:(A;OICI;FA;;;S-1-5-21-1-1-1-2001)"),
    ]
    .iter()
    .map(|(path, sddl)| FolderAcl { path: (*path).into(), sddl: (*sddl).into() })
    .collect()
}

fn others() -> Vec<String> {
    vec![ADMIN.to_string(), OTHER.to_string()]
}

fn publisher_exception() -> ExceptionRule {
    ExceptionRule {
        id: "ex-publisher".into(),
        app_id: None,
        kind: ExceptionKind::Publisher,
        publisher: Some(PublisherMatch { subject: "O=Acme & Sons, CN=\"Acme\"".into(), product: Some("Tool".into()), file_name: None }),
        sha256: None,
        path: None,
        layers: vec![ExceptionLayer::AppLocker],
    }
}

fn hash_exception() -> ExceptionRule {
    ExceptionRule {
        id: "ex-hash".into(),
        app_id: None,
        kind: ExceptionKind::Hash,
        publisher: None,
        sha256: Some("ab".repeat(32)),
        path: None,
        layers: vec![ExceptionLayer::AppLocker, ExceptionLayer::ProcWatch],
    }
}

fn path_exception() -> ExceptionRule {
    ExceptionRule {
        id: "ex-path".into(),
        app_id: None,
        kind: ExceptionKind::Path,
        publisher: None,
        sha256: None,
        path: Some(r"{ProgramFiles}\Acme\tool.exe".into()),
        layers: vec![ExceptionLayer::AppLocker],
    }
}

/// The fixed fixture of the golden files: the scan above, two other accounts, the Rulebox and
/// WebView2 folders, one admin-only catalogue app.
fn compiled(enforcement: Enforcement, exceptions: &[ExceptionRule], accessibility: bool) -> (String, AllowList) {
    let roots = sim_path_roots();
    let protected = protected();
    let scan = scan_fixture();
    let catalogue = vec![r"C:\Program Files\Acme".to_string()];
    let inputs = Inputs {
        roots: &roots,
        protected: &protected,
        catalogue_folders: &catalogue,
        exceptions,
        accessibility_tools: accessibility,
        windows_scan: &scan,
        staff_sid: STAFF,
    };
    let allow = allowlist::build(&inputs, |_| Ok(Some(ADMIN_ONLY.to_string()))).unwrap();
    let others = others();
    let xml = compile(&CompileInput { enforcement, staff_sid: STAFF, other_sids: &others, allow: &allow });
    (xml, allow)
}

// ---------------------------------------------------------------- the mechanism

#[test]
fn the_mechanism_follows_the_edition() {
    use AppLockerMechanism::{Csp, Local};
    for (edition, expected) in [
        ("Enterprise", Some(Local)),
        ("EnterpriseS", Some(Local)),
        ("IoTEnterprise", Some(Local)),
        ("Education", Some(Local)),
        ("ServerStandard", Some(Local)),
        ("ServerDatacenter", Some(Local)),
        ("Professional", Some(Csp)),
        ("ProfessionalN", Some(Csp)),
        ("ProfessionalWorkstation", Some(Csp)),
        ("ProfessionalEducation", Some(Csp)),
        ("Core", None),
        ("CoreN", None),
        ("CoreSingleLanguage", None),
        ("CloudN", None),
        ("", None),
        ("SomethingNew", None),
    ] {
        assert_eq!(mechanism_for(edition), expected, "{edition}");
    }
    assert_eq!(mechanism_for("enterprise"), Some(Local), "case does not matter");
}

// ---------------------------------------------------------------- determinism

#[test]
fn the_same_input_gives_the_same_bytes_and_the_ids_are_unique_guids() {
    let (a, _) = compiled(Enforcement::AuditOnly, &[publisher_exception(), hash_exception(), path_exception()], false);
    let (b, _) = compiled(Enforcement::AuditOnly, &[publisher_exception(), hash_exception(), path_exception()], false);
    assert_eq!(a, b);
    assert!(!a.contains('\r') && a.ends_with("</AppLockerPolicy>\n"));
    // The same set of accounts in another order is the same policy.
    let roots = sim_path_roots();
    let protected = protected();
    let scan = scan_fixture();
    let inputs = Inputs {
        roots: &roots,
        protected: &protected,
        catalogue_folders: &[],
        exceptions: &[],
        accessibility_tools: false,
        windows_scan: &scan,
        staff_sid: STAFF,
    };
    let allow = allowlist::build(&inputs, |_| Ok(None)).unwrap();
    let forward = vec![ADMIN.to_string(), OTHER.to_string(), STAFF.to_string()];
    let backward = vec![STAFF.to_string(), OTHER.to_string(), ADMIN.to_string(), OTHER.to_string()];
    let one = compile(&CompileInput { enforcement: Enforcement::Enabled, staff_sid: STAFF, other_sids: &forward, allow: &allow });
    let two = compile(&CompileInput { enforcement: Enforcement::Enabled, staff_sid: STAFF, other_sids: &backward, allow: &allow });
    assert_eq!(one, two, "the order and a repeat do not matter; Staff is never in the list of others");

    // Every id is a GUID and no id repeats inside a collection.
    let collections = win32::check_policy(&a).unwrap();
    assert_eq!(collections.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), COLLECTIONS);
    for collection in &collections {
        let mut ids: Vec<&str> = collection.rules.iter().map(|r| r.id.as_str()).collect();
        let count = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), count, "{}", collection.name);
        for id in ids {
            assert_eq!(id.len(), 36);
            assert_eq!(&id[14..15], "8", "version nibble");
            assert!(matches!(&id[19..20], "8" | "9" | "a" | "b"), "variant");
        }
    }
    // A change in one rule changes its id and no other (Exe collection, hash exception).
    let (c, _) = compiled(Enforcement::AuditOnly, &[publisher_exception(), path_exception()], false);
    let ids = |xml: &str| -> Vec<String> { win32::check_policy(xml).unwrap()[0].rules.iter().map(|r| r.id.clone()).collect() };
    let (before, after) = (ids(&a), ids(&c));
    assert_eq!(before.len(), after.len() + 1);
    assert!(after.iter().all(|id| before.contains(id)), "the rules that stayed keep their ids");
}

#[test]
fn text_from_the_document_is_escaped_in_the_xml() {
    let (xml, _) = compiled(Enforcement::AuditOnly, &[publisher_exception()], false);
    assert!(xml.contains("PublisherName=\"O=Acme &amp; Sons, CN=&quot;Acme&quot;\""), "{xml}");
    // It still splits as a policy, and the text is back as it was.
    assert!(win32::check_policy(&xml).is_ok());
    let rules = parse_rules(&xml);
    assert!(rules.iter().all(|r| !r.sid.is_empty()));
}

#[test]
fn rule_ids_are_name_based_guids() {
    let id = rule_id("Exe|S-1-5-32-544|x");
    assert_eq!(id, rule_id("Exe|S-1-5-32-544|x"));
    assert_ne!(id, rule_id("Exe|S-1-5-32-544|y"));
    assert_eq!(id.len(), 36);
    assert_eq!(id.matches('-').count(), 4);
    assert_eq!(&id[14..15], "8");
}

// ---------------------------------------------------------------- the golden files

fn golden_path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests").join("golden").join("applocker").join(name)
}

fn golden_cases() -> Vec<(&'static str, String)> {
    let all = [publisher_exception(), hash_exception(), path_exception()];
    vec![
        ("default-audit.xml", compiled(Enforcement::AuditOnly, &[], false).0),
        ("default-enforce.xml", compiled(Enforcement::Enabled, &[], false).0),
        ("exceptions-audit.xml", compiled(Enforcement::AuditOnly, &all, false).0),
        ("exceptions-enforce.xml", compiled(Enforcement::Enabled, &all, false).0),
        ("accessibility-audit.xml", compiled(Enforcement::AuditOnly, &[], true).0),
    ]
}

#[test]
fn the_golden_files_match_the_generated_policies() {
    let bless = std::env::var("RULEBOX_BLESS_GOLDEN").is_ok_and(|v| v == "1");
    for (name, xml) in golden_cases() {
        let path = golden_path(name);
        if bless {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, &xml).unwrap();
        }
        let expected = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e} (RULEBOX_BLESS_GOLDEN=1 writes it)", path.display()));
        assert_eq!(expected.replace("\r\n", "\n"), xml, "{name} changed; review the diff and bless it on purpose");
    }
}

/// Every golden file passes the same checks the layer runs before it writes, and the ones of
/// plan Step 7: Rulebox folders, WebView2 and Administrators allow-all present; no path rule
/// under a writable folder; a rule for Staff alone is ever restrictive.
#[test]
fn every_golden_file_passes_the_invariant_checks() {
    let roots = sim_path_roots();
    for (name, _) in golden_cases() {
        let xml = std::fs::read_to_string(golden_path(name)).unwrap().replace("\r\n", "\n");
        assert_eq!(check_compiled(&xml, &protected(), STAFF, &roots), Ok(()), "{name}");
        let rules = parse_rules(&xml);
        for collection in COLLECTIONS {
            assert!(
                rules.iter().any(|r| r.collection == collection && r.sid == ADMINISTRATORS && r.action == "Allow" && (r.paths == ["*"] || r.any_publisher)),
                "{name}: Administrators allow-all in {collection}"
            );
        }
        for collection in ["Exe", "Msi", "Script"] {
            for folder in protected() {
                let glob = format!("{folder}\\*");
                assert!(
                    rules.iter().any(|r| r.collection == collection && r.sid == EVERYONE && r.paths == [glob.clone()]),
                    "{name}: {folder} in {collection}"
                );
            }
        }
        // WebView2 explicitly.
        assert!(xml.contains(r"C:\Program Files (x86)\Microsoft\EdgeWebView\*"), "{name}");
        // No deny rule at all; no allow path rule for Staff or Everyone under a writable folder.
        assert!(rules.iter().all(|r| r.action == "Allow"), "{name}");
        for rule in rules.iter().filter(|r| r.sid == STAFF || r.sid == EVERYONE) {
            for path in &rule.paths {
                assert!(!path.contains(r"\Users\") && !path.contains("ProgramData") && !path.contains(r"\Temp"), "{name}: {path}");
            }
        }
        // The DLL collection is off.
        assert!(!xml.contains("Type=\"Dll\""), "{name}");
        // The writer's splitter takes the file as it is.
        let parts = win32::check_policy(&xml).unwrap();
        assert_eq!(parts.len(), 4, "{name}");
        let mode = if name.contains("enforce") { win32::ENFORCE_ENABLED } else { win32::ENFORCE_AUDIT_ONLY };
        assert!(parts.iter().all(|c| c.enforcement == mode), "{name}");
    }
}

#[test]
fn the_golden_files_differ_in_exactly_what_they_should() {
    let cases: std::collections::HashMap<&str, String> = golden_cases().into_iter().collect();
    let (audit, enforce) = (&cases["default-audit.xml"], &cases["default-enforce.xml"]);
    assert_eq!(audit.replace("AuditOnly", "Enabled").lines().count(), enforce.lines().count());
    // Only the mode word differs between audit and enforce: the rule ids do not depend on it.
    assert_eq!(audit.replace("EnforcementMode=\"AuditOnly\"", "EnforcementMode=\"Enabled\""), *enforce);
    let with = &cases["exceptions-audit.xml"];
    assert!(with.contains("FileHashRule") && with.contains("FilePublisherRule") && with.contains(r"C:\Program Files\Acme\tool.exe"));
    assert!(with.contains("SHA256") && with.contains("0xABABAB"));
    assert!(!audit.contains("FileHashRule"));
    let access = &cases["accessibility-audit.xml"];
    assert!(audit.contains("NARRATOR.EXE") && !access.contains("NARRATOR.EXE"));
    assert!(access.contains("CMD.EXE"));
}

// ---------------------------------------------------------------- the checks on output

fn roots() -> PathRoots {
    sim_path_roots()
}

#[test]
fn the_check_names_what_a_broken_policy_would_do() {
    let (xml, _) = compiled(Enforcement::Enabled, &[], false);
    let r = roots();
    let p = protected();
    assert_eq!(check_compiled(&xml, &p, STAFF, &r), Ok(()));

    // I6: Administrators lose their allow-all in one collection.
    let no_admin = xml.replacen(&format!("UserOrGroupSid=\"{ADMINISTRATORS}\""), "UserOrGroupSid=\"S-1-5-32-545\"", 1);
    assert_eq!(check_compiled(&no_admin, &p, STAFF, &r), Err("would_block_admin"));

    // I1, I2: the Rulebox folder rule goes (Everyone becomes someone else).
    let glob = format!("Path=\"{}\\*\"", p[0]);
    let at = xml.find(&glob).unwrap();
    let rule_start = xml[..at].rfind("<FilePathRule").unwrap();
    let sid_at = xml[rule_start..].find("UserOrGroupSid=\"S-1-1-0\"").unwrap() + rule_start;
    let no_rulebox = format!("{}UserOrGroupSid=\"S-1-5-32-545\"{}", &xml[..sid_at], &xml[sid_at + "UserOrGroupSid=\"S-1-1-0\"".len()..]);
    assert_eq!(check_compiled(&no_rulebox, &p, STAFF, &r), Err("would_block_rulebox"));
    // ... or an exception of the Staff rule cuts into it.
    let cut = xml.replacen(
        "<Exceptions>\n",
        &format!("<Exceptions>\n        <FilePathCondition Path=\"{}\\versions\\*\"/>\n", p[0]),
        1,
    );
    assert_eq!(check_compiled(&cut, &p, STAFF, &r), Err("would_block_rulebox"));
    // A protected folder the policy never heard of has no rule.
    assert_eq!(check_compiled(&xml, &[r"C:\Other\Thing".to_string()], STAFF, &r), Err("would_block_rulebox"));

    // Edge case 13: an allow path rule for Staff under a user-writable folder.
    let writable = xml.replacen(
        "<FilePathCondition Path=\"C:\\Program Files\\Acme\\*\"/>",
        "<FilePathCondition Path=\"C:\\Users\\Staff\\Downloads\\*\"/>",
        1,
    );
    assert_eq!(check_compiled(&writable, &p, STAFF, &r), Err("writable_path_rule"));
    let temp = xml.replacen("Path=\"C:\\Windows\\*\"", "Path=\"C:\\Windows\\Temp\\*\"", 1);
    assert_eq!(check_compiled(&temp, &p, STAFF, &r), Err("writable_path_rule"));
    let root_drive = xml.replacen("Path=\"C:\\Windows\\*\"", "Path=\"D:\\*\"", 1);
    assert_eq!(check_compiled(&root_drive, &p, STAFF, &r), Err("writable_path_rule"));

    // Only the Staff SID may ever get a restrictive rule.
    let deny_other = xml.replacen(&format!("UserOrGroupSid=\"{OTHER}\" Action=\"Allow\""), &format!("UserOrGroupSid=\"{OTHER}\" Action=\"Deny\""), 1);
    assert_eq!(check_compiled(&deny_other, &p, STAFF, &r), Err("restrictive_rule_not_staff"));
}

// ---------------------------------------------------------------- what Staff can start

/// A tiny AppLocker evaluator over the parsed rules: the rules whose SID the token holds, a
/// path condition (`*`, `<folder>\*`, an exact file), and the exceptions of that rule (paths and
/// original file names). Publisher and hash conditions are not evaluated.
fn allowed(xml: &str, collection: &str, token: &[&str], path: &str, original_name: Option<&str>) -> bool {
    let name = original_name.map_or_else(|| path.rsplit('\\').next().unwrap_or(path).to_ascii_uppercase(), str::to_ascii_uppercase);
    let matches = |pattern: &str| -> bool {
        let (pattern, path) = (pattern.to_ascii_lowercase(), path.to_ascii_lowercase());
        if pattern == "*" {
            true
        } else if let Some(folder) = pattern.strip_suffix("\\*") {
            path.starts_with(&format!("{folder}\\"))
        } else {
            path == pattern
        }
    };
    parse_rules(xml).iter().filter(|r| r.collection == collection && r.action == "Allow" && token.contains(&r.sid.as_str())).any(|rule| {
        rule.paths.iter().any(|p| matches(p))
            && !rule.exception_paths.iter().any(|p| matches(p))
            && !rule.exception_names.iter().any(|n| n.to_ascii_uppercase() == name)
    })
}

#[test]
fn staff_keeps_rulebox_webview2_and_catalogue_apps_and_loses_the_tools() {
    let (xml, _) = compiled(Enforcement::Enabled, &[path_exception()], false);
    let staff = [STAFF, EVERYONE];
    for path in [
        r"C:\Program Files\Rulebox\rulebox-agent.exe",
        r"C:\Program Files\Rulebox\rulebox-shell.exe",
        r"C:\Program Files\Rulebox\versions\1.2.3\rulebox-staff.exe",
        r"C:\Program Files\Rulebox\apps\app1\tool.exe",
        r"C:\Program Files (x86)\Microsoft\EdgeWebView\Application\126.0\msedgewebview2.exe",
        // A catalogue app in its admin-only folder, and the path exception.
        r"C:\Program Files\Acme\acme.exe",
        r"C:\Program Files\Acme\tool.exe",
        // Windows' own programs.
        r"C:\Windows\System32\notepad.exe",
        r"C:\Windows\System32\spoolsv.exe",
        r"C:\Windows\System32\ctfmon.exe",
    ] {
        assert!(allowed(&xml, "Exe", &staff, path, None), "Staff must be able to start {path}");
    }
    for path in [
        r"C:\Windows\System32\cmd.exe",
        r"C:\Windows\SysWOW64\cmd.exe",
        r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe",
        r"C:\Windows\regedit.exe",
        r"C:\Windows\explorer.exe",
        r"C:\Windows\System32\taskmgr.exe",
        r"C:\Windows\System32\mmc.exe",
        r"C:\Windows\System32\wscript.exe",
        // Writable folders inside Windows, from the scan and from the known list.
        r"C:\Windows\Temp\dropped.exe",
        r"C:\Windows\Vendor\Cache\dropped.exe",
        r"C:\Windows\Vendor\Cache\deeper\dropped.exe",
        r"C:\Windows\Tasks\x.exe",
        r"C:\Windows\System32\spool\drivers\color\x.exe",
        // Not in the allow-list at all.
        r"C:\Users\Staff\Downloads\setup.exe",
        r"C:\Users\Staff\AppData\Local\Temp\x.exe",
        r"C:\ProgramData\x.exe",
        r"C:\Program Files\Other\other.exe",
        r"D:\portable\tool.exe",
        r"E:\autorun.exe",
    ] {
        assert!(!allowed(&xml, "Exe", &staff, path, None), "Staff must not be able to start {path}");
    }
    // A renamed copy of a denied program inside the Windows folder keeps its original name.
    assert!(!allowed(&xml, "Exe", &staff, r"C:\Windows\System32\notes.exe", Some("CMD.EXE")));
    assert!(allowed(&xml, "Exe", &staff, r"C:\Windows\System32\notes.exe", Some("NOTES.EXE")));
    // The same rules protect the other program collections.
    assert!(allowed(&xml, "Msi", &staff, r"C:\Program Files\Rulebox\x.msi", None));
    assert!(!allowed(&xml, "Msi", &staff, r"C:\Windows\Temp\x.msi", None));
    assert!(!allowed(&xml, "Script", &staff, r"C:\Users\Staff\x.ps1", None));
}

#[test]
fn administrators_other_accounts_and_system_principals_are_not_restricted() {
    let (xml, _) = compiled(Enforcement::Enabled, &[], false);
    for path in [r"C:\Windows\System32\cmd.exe", r"C:\Users\Admin\Downloads\setup.exe", r"D:\x.exe", r"C:\Program Files\Rulebox\rulebox-agent.exe"] {
        assert!(allowed(&xml, "Exe", &[ADMINISTRATORS, EVERYONE], path, None), "an administrator runs {path}");
        assert!(allowed(&xml, "Exe", &[OTHER], path, None), "another local account runs {path}");
        assert!(allowed(&xml, "Exe", &["S-1-5-18"], path, None), "SYSTEM runs {path}");
        assert!(allowed(&xml, "Exe", &["S-1-5-19"], path, None));
        assert!(allowed(&xml, "Exe", &["S-1-5-20"], path, None));
        assert!(allowed(&xml, "Exe", &["S-1-5-6"], path, None));
        assert!(allowed(&xml, "Exe", &["S-1-5-90-0"], path, None));
    }
    // Staff's own SID is the only one with exceptions: no rule for anyone else carries one.
    for rule in parse_rules(&xml).iter().filter(|r| r.sid != STAFF) {
        assert!(rule.exception_paths.is_empty() && rule.exception_names.is_empty(), "{}", rule.sid);
    }
    // And Staff's own SID is never given an allow-everything rule.
    assert!(!parse_rules(&xml).iter().any(|r| r.sid == STAFF && (r.paths.iter().any(|p| p == "*") || r.any_publisher)));
}

#[test]
fn packaged_apps_are_limited_for_staff_only() {
    let (xml, _) = compiled(Enforcement::Enabled, &[], false);
    let rules: Vec<ParsedRule> = parse_rules(&xml).into_iter().filter(|r| r.collection == "Appx").collect();
    let staff_rules = rules.iter().filter(|r| r.sid == STAFF).count();
    assert_eq!(staff_rules, STAFF_ALLOWED_PACKAGES.len());
    assert!(!rules.iter().any(|r| r.sid == STAFF && r.any_publisher), "Staff has no allow-all publisher rule");
    assert!(rules.iter().any(|r| r.sid == ADMINISTRATORS && r.any_publisher));
    assert!(xml.contains("ProductName=\"Microsoft.Windows.ShellExperienceHost\""));
    assert!(xml.contains(&format!("PublisherName=\"{MICROSOFT_WINDOWS_PUBLISHER}\"")));
}

// ---------------------------------------------------------------- the layer

struct Rig {
    _dir: TempDir,
    platform: Arc<SimPlatform>,
    shared: Arc<SharedState>,
}

impl Rig {
    fn new() -> Self {
        Self::build(true)
    }

    fn build(with_staff: bool) -> Self {
        let dir = TempDir::new();
        let platform = Arc::new(SimPlatform::new(dir.path().to_path_buf()));
        platform.with_world(|w| {
            w.admins = vec![ADMIN.to_string()];
            w.users.insert("RuleboxStaff".into(), SimUser { sid: STAFF.into(), comment: String::new(), disabled: false, password: String::new() });
            w.users.insert("Gone".into(), SimUser { sid: "S-1-5-21-1000-2000-3000-1999".into(), comment: String::new(), disabled: true, password: String::new() });
            w.users.insert("Other".into(), SimUser { sid: OTHER.into(), comment: String::new(), disabled: false, password: String::new() });
        });
        let dyn_platform: Arc<dyn Platform> = platform.clone();
        let state = AgentState {
            staff: with_staff.then(|| StaffAccount { sid: STAFF.into(), user_name: "RuleboxStaff".into(), profile_dir: None }),
            ..AgentState::default()
        };
        let shared = SharedState::new(StateStore::open(&dir.path().join("state")).unwrap(), state, dyn_platform);
        Self { _dir: dir, platform, shared }
    }

    fn facts(&self) -> Facts {
        Facts { protected_paths: protected(), ..Facts::default() }
    }

    fn ctx(&self, facts: Facts) -> ApplyCtx<'_> {
        ApplyCtx { journal: JournalCtx { platform: self.platform.as_ref(), shared: self.shared.as_ref() }, facts, now_ms: 1_000, version: 7 }
    }

    fn doc(mode: LayerMode) -> AgentDoc {
        AgentDoc {
            lockdown: Some(LockdownPolicy { app_locker: LayerSetting { mode }, ..LockdownPolicy::default() }),
            ..AgentDoc::default()
        }
    }

    fn apply(&self, mode: LayerMode) -> LayerState {
        apply(&self.ctx(self.facts()), &Self::doc(mode))
    }

    fn apply_doc(&self, doc: &AgentDoc) -> LayerState {
        apply(&self.ctx(self.facts()), doc)
    }

    fn edition(&self, edition: &str) {
        self.platform.with_world(|w| w.os.edition_id = edition.to_string());
    }

    fn policy(&self) -> Option<(String, AppLockerMechanism)> {
        self.platform.with_world(|w| w.applocker_policy.clone())
    }

    fn mutating(&self) -> usize {
        self.platform.calls().iter().filter(|op| op.is_mutating()).count()
    }

    fn entry(&self, id: &str) -> Option<JournalEntry> {
        self.shared.read(|s| s.journal.iter().find(|e| e.id == id).cloned())
    }

    fn service_start(&self) -> u32 {
        self.platform.with_world(|w| w.services["AppIDSvc"].start)
    }
}

#[test]
fn audit_on_pro_installs_through_the_csp_with_everything_journalled() {
    let rig = Rig::new();
    let state = rig.apply(LayerMode::Audit);
    assert_eq!((state.mode, state.state, state.detail.as_deref()), (ReportedMode::Audit, LayerStatus::RestartPending, Some("restart_needed")));

    let (xml, mechanism) = rig.policy().expect("a policy was installed");
    assert_eq!(mechanism, AppLockerMechanism::Csp, "Professional takes the CSP");
    assert!(xml.contains("EnforcementMode=\"AuditOnly\"") && !xml.contains("EnforcementMode=\"Enabled\""));
    // The accounts: the other enabled ones get allow-all, the disabled one and Staff do not.
    assert!(xml.contains(&format!("UserOrGroupSid=\"{ADMIN}\"")) && xml.contains(&format!("UserOrGroupSid=\"{OTHER}\"")));
    assert!(!xml.contains("S-1-5-21-1000-2000-3000-1999"));
    assert!(!parse_rules(&xml).iter().any(|r| r.sid == STAFF && r.paths.iter().any(|p| p == "*")));

    let entry = rig.entry("applocker:csp").unwrap();
    assert_eq!((entry.owner, entry.phase, entry.original.clone()), (JournalOwner::L3, EntryPhase::Applied, OriginalValue::NotPresent));
    assert_eq!(entry.target, JournalTarget::AppLockerPolicy);
    assert_eq!(entry.since_version, 7);
    let service = rig.entry("svc-start:AppIDSvc").unwrap();
    assert_eq!((service.owner, service.original.clone()), (JournalOwner::L3, OriginalValue::ServiceStart(3)));
    assert_eq!(rig.service_start(), 2, "automatic");
    assert!(rig.shared.read(|s| s.applocker.clone()).is_some_and(|m| m.mechanism == "csp"));
}

#[test]
fn a_second_apply_writes_nothing_and_the_restart_mark_clears_after_a_boot() {
    let rig = Rig::new();
    rig.apply(LayerMode::Enforce);
    let before = rig.mutating();
    let again = rig.apply(LayerMode::Enforce);
    assert_eq!(again.state, LayerStatus::RestartPending, "the PC has not restarted yet");
    assert_eq!(rig.mutating(), before, "nothing is written twice");
    assert_eq!(rig.shared.read(|s| s.journal.len()), 2);

    rig.platform.with_world(|w| w.boot_id = Some(101));
    let booted = rig.apply(LayerMode::Enforce);
    assert_eq!((booted.state, booted.detail), (LayerStatus::Ok, None));
    assert!(rig.shared.read(|s| s.applocker_restart).is_none());
    assert_eq!(rig.mutating(), before);
}

#[test]
fn enforce_changes_the_mode_word_and_nothing_else() {
    let rig = Rig::new();
    rig.apply(LayerMode::Audit);
    let (audit, _) = rig.policy().unwrap();
    let state = rig.apply(LayerMode::Enforce);
    assert_eq!(state.mode, ReportedMode::Enforce);
    let (enforce, _) = rig.policy().unwrap();
    assert_eq!(audit.replace("AuditOnly", "Enabled"), enforce);
    // Still one entry per target: the first original is kept.
    assert_eq!(rig.shared.read(|s| s.journal.len()), 2);
    assert_eq!(rig.entry("svc-start:AppIDSvc").unwrap().original, OriginalValue::ServiceStart(3));
}

#[test]
fn enterprise_uses_the_local_policy_store_and_a_second_apply_finds_it_there() {
    let rig = Rig::new();
    rig.edition("Enterprise");
    rig.apply(LayerMode::Audit);
    assert_eq!(rig.policy().unwrap().1, AppLockerMechanism::Local);
    let store = rig.platform.get_applocker_policy().unwrap();
    assert!(store.has_rules() && store.collections.len() == 4);
    assert!(rig.entry("applocker:local").is_some());
    // The rules in the store are ours (the journal says so): no foreign-policy refusal.
    let before = rig.mutating();
    let again = rig.apply(LayerMode::Audit);
    assert_ne!(again.detail.as_deref(), Some("applocker_foreign_policy"));
    assert_eq!(rig.mutating(), before);
    // A rule that someone removed from the store is put back.
    rig.platform.with_world(|w| w.applocker_policy = None);
    rig.apply(LayerMode::Audit);
    assert!(rig.policy().is_some());
}

#[test]
fn a_policy_the_agent_did_not_install_is_never_touched() {
    let rig = Rig::new();
    rig.edition("Enterprise");
    rig.platform.with_world(|w| {
        w.applocker.collections.push(win32::CollectionState { name: "Exe".into(), enforcement: Some(1), rules: 3 });
    });
    let state = rig.apply(LayerMode::Enforce);
    assert_eq!((state.state, state.detail.as_deref()), (LayerStatus::Failed, Some("applocker_foreign_policy")));
    assert_eq!(rig.mutating(), 0);
    assert!(rig.policy().is_none() && rig.shared.read(|s| s.journal.is_empty()));
    // `off` does not remove it either: the journal holds nothing of it.
    let off = rig.apply_doc(&Rig::doc(LayerMode::Off));
    assert_eq!((off.state, off.mode), (LayerStatus::Ok, ReportedMode::Off));
    assert_eq!(rig.mutating(), 0);
    assert!(rig.platform.with_world(|w| w.applocker.has_rules()));
}

#[test]
fn home_has_no_applocker_and_nothing_is_written() {
    let rig = Rig::new();
    rig.edition("Core");
    let state = rig.apply(LayerMode::Audit);
    assert_eq!((state.state, state.detail.as_deref()), (LayerStatus::Unsupported, Some("applocker_not_on_this_edition")));
    assert_eq!(rig.mutating(), 0);
}

#[test]
fn without_a_staff_account_nothing_is_written() {
    let rig = Rig::build(false);
    let state = rig.apply(LayerMode::Audit);
    assert_eq!((state.state, state.detail.as_deref()), (LayerStatus::Failed, Some("no_staff_account")));
    assert_eq!(rig.mutating(), 0);
}

#[test]
fn off_unknown_and_a_missing_section_restore_everything() {
    for restore_with in [Rig::doc(LayerMode::Off), AgentDoc::default()] {
        let rig = Rig::new();
        rig.apply(LayerMode::Audit);
        assert!(rig.policy().is_some() && rig.service_start() == 2);
        let state = rig.apply_doc(&restore_with);
        assert_eq!((state.mode, state.state), (ReportedMode::Off, LayerStatus::Ok));
        assert!(rig.policy().is_none(), "the policy is gone");
        assert_eq!(rig.service_start(), 3, "the service is back to manual");
        assert!(rig.shared.read(|s| s.journal.is_empty() && s.applocker.is_none() && s.applocker_restart.is_none()));
    }
    // An unknown mode changes nothing (plan 4.3 rule 2).
    let rig = Rig::new();
    rig.apply(LayerMode::Audit);
    let before = rig.mutating();
    let unknown = rig.apply(LayerMode::Unknown);
    assert_eq!(unknown.detail.as_deref(), Some("section_unknown_value"));
    assert_eq!(rig.mutating(), before);
    assert!(rig.policy().is_some());
}

#[test]
fn disable_kiosk_and_recover_restore_it_through_the_journal() {
    let rig = Rig::new();
    rig.edition("Enterprise");
    rig.apply(LayerMode::Enforce);
    let report = journal::restore_all(&JournalCtx { platform: rig.platform.as_ref(), shared: rig.shared.as_ref() });
    assert!(report.is_complete(), "{:?}", report.failed_ids());
    assert!(rig.policy().is_none() && !rig.platform.with_world(|w| w.applocker.has_rules()));
    assert_eq!(rig.service_start(), 3);
    assert!(rig.shared.read(|s| s.journal.is_empty() && s.applocker.is_none()));
}

#[test]
fn a_new_local_account_changes_the_policy_at_the_next_apply() {
    let rig = Rig::new();
    rig.apply(LayerMode::Audit);
    let (first, _) = rig.policy().unwrap();
    let before = rig.mutating();
    rig.platform.with_world(|w| w.admins.push("S-1-5-21-1000-2000-3000-1777".into()));
    rig.apply(LayerMode::Audit);
    let (second, _) = rig.policy().unwrap();
    assert!(second.contains("S-1-5-21-1000-2000-3000-1777") && !first.contains("S-1-5-21-1000-2000-3000-1777"));
    assert!(rig.mutating() > before);
    // The edition changing the mechanism removes the old one first.
    rig.edition("Enterprise");
    rig.apply(LayerMode::Audit);
    assert_eq!(rig.policy().unwrap().1, AppLockerMechanism::Local);
    assert!(rig.entry("applocker:csp").is_none() && rig.entry("applocker:local").is_some());
}

#[test]
fn a_writable_catalogue_folder_is_refused_but_the_rest_is_installed() {
    let rig = Rig::new();
    let facts = Facts {
        catalogue_exe_folders: vec![r"C:\Program Files\Acme".into(), r"C:\Users\Staff\AppData\Local\Portable".into()],
        ..rig.facts()
    };
    let state = apply(&rig.ctx(facts), &Rig::doc(LayerMode::Audit));
    assert_eq!(state.state, LayerStatus::Partial);
    assert_eq!(state.detail.as_deref(), Some("catalogue_folder_writable"));
    let (xml, _) = rig.policy().unwrap();
    assert!(xml.contains(r"C:\Program Files\Acme\*") && !xml.contains("Portable"));
}

#[test]
fn a_failed_scan_is_reported_and_the_known_folders_are_still_cut_out() {
    let rig = Rig::new();
    rig.platform.fail_next(SimOp::FolderAcls, PlatformError::AccessDenied);
    let state = rig.apply(LayerMode::Audit);
    assert_eq!((state.state, state.detail.as_deref()), (LayerStatus::Partial, Some("windows_scan_failed")));
    let (xml, _) = rig.policy().unwrap();
    for folder in KNOWN_WRITABLE_WINDOWS_FOLDERS {
        assert!(xml.contains(&format!(r"C:\Windows\{folder}\*")), "{folder}");
    }
}

#[test]
fn the_scan_of_the_sim_windows_folder_finds_what_the_dacls_say() {
    let rig = Rig::new();
    rig.platform.with_world(|w| {
        w.path_acls.insert(r"c:\windows\vendor\cache".into(), "D:(A;OICI;0x1301bf;;;BU)".into());
        w.path_acls.insert(r"c:\windows\winsxs\x".into(), "D:(A;OICI;0x1301bf;;;BU)".into());
        w.path_acls.insert(r"c:\windows\a\b\c\d\e\f\g\h".into(), "D:(A;OICI;0x1301bf;;;BU)".into());
        w.path_acls.insert(r"c:\other\x".into(), "D:(A;OICI;0x1301bf;;;BU)".into());
    });
    rig.apply(LayerMode::Audit);
    let (xml, _) = rig.policy().unwrap();
    assert!(xml.contains(r"c:\windows\vendor\cache\*"), "found by the scan");
    assert!(!xml.contains("winsxs") && !xml.contains(r"c:\other") && !xml.contains(r"\a\b\c"), "WinSxS, other trees and too-deep folders are not scanned");
    let scanned = rig.platform.folder_acls(std::path::Path::new(r"C:\Windows"), SCAN_DEPTH).unwrap();
    assert!(scanned.iter().all(|f| writable_by_staff(&f.sddl, STAFF)));
}

#[test]
fn failures_are_reported_with_a_code_and_the_next_apply_finishes() {
    let rig = Rig::new();
    rig.platform.fail_next(SimOp::SetApplockerPolicy, PlatformError::AccessDenied);
    let state = rig.apply(LayerMode::Audit);
    assert_ne!(state.state, LayerStatus::Ok);
    assert_eq!(state.detail.as_deref(), Some("access_denied"));
    assert!(rig.policy().is_none());
    // The pending entry is there; the retry installs the policy.
    let retry = rig.apply(LayerMode::Audit);
    assert!(rig.policy().is_some());
    assert_eq!(retry.state, LayerStatus::RestartPending);
    assert_eq!(rig.entry("applocker:csp").unwrap().phase, EntryPhase::Applied);

    // A missing Application Identity service is a failure of that part only.
    let rig = Rig::new();
    rig.platform.with_world(|w| {
        w.services.remove("AppIDSvc");
    });
    let state = rig.apply(LayerMode::Audit);
    assert_eq!((state.state, state.detail.as_deref()), (LayerStatus::Partial, Some("app_id_service_missing")));
    assert!(rig.policy().is_some());

    // The accounts cannot be listed: the policy would lock them out, so nothing is written.
    let rig = Rig::new();
    rig.platform.fail_next(SimOp::EnabledLocalAccountSids, PlatformError::AccessDenied);
    let state = rig.apply(LayerMode::Audit);
    assert_eq!((state.state, state.detail.as_deref()), (LayerStatus::Failed, Some("accounts_unreadable")));
    assert_eq!(rig.mutating(), 0);
}

#[test]
fn the_service_is_set_to_automatic_only_when_it_is_not() {
    let rig = Rig::new();
    rig.platform.with_world(|w| w.services.get_mut("AppIDSvc").unwrap().start = 2);
    let state = rig.apply(LayerMode::Audit);
    assert_eq!(state.state, LayerStatus::Ok, "already automatic: nothing to restart");
    assert!(rig.entry("svc-start:AppIDSvc").is_none(), "nothing journalled for a value that was already right");
    // Disabled by someone: set to automatic, the original (4) is what restore brings back.
    let rig = Rig::new();
    rig.platform.with_world(|w| w.services.get_mut("AppIDSvc").unwrap().start = 4);
    rig.apply(LayerMode::Audit);
    assert_eq!(rig.service_start(), 2);
    assert_eq!(rig.entry("svc-start:AppIDSvc").unwrap().original, OriginalValue::ServiceStart(4));
}

// ---------------------------------------------------------------- invariants on the whole apply

#[test]
fn the_whole_apply_validates_the_generated_rules_and_runs_l3_in_its_place() {
    let rig = Rig::new();
    let doc = Rig::doc(LayerMode::Audit);
    // I7 wants the E-71 flag for the default `hideAdminTiles`; the other layers run as well.
    let facts = Facts { admin_signin_verified: true, ..rig.facts() };
    let outcome = apply_all(&rig.ctx(facts), &doc).unwrap();
    let l3 = &outcome.layers.app_locker;
    assert_eq!((l3.mode, l3.state), (ReportedMode::Audit, LayerStatus::RestartPending));
    assert!(rig.policy().is_some());
}

#[test]
fn a_cut_that_reaches_a_protected_folder_refuses_the_document_before_anything_is_written() {
    let rig = Rig::new();
    // The Rulebox folder claims to sit in a place the Windows rule has to cut out.
    let facts = Facts { protected_paths: vec![r"C:\Windows\Temp\Rulebox".into()], ..Facts::default() };
    let refusal = apply_all(&rig.ctx(facts), &Rig::doc(LayerMode::Audit)).unwrap_err();
    assert_eq!(refusal, ApplyRefusal::Refused("would_block_rulebox"));
    assert_eq!(rig.mutating(), 0);
}

#[test]
fn the_default_protected_folders_come_from_the_install_roots_when_the_facts_have_none() {
    let rig = Rig::new();
    let state = apply(&rig.ctx(Facts::default()), &Rig::doc(LayerMode::Audit));
    assert_ne!(state.state, LayerStatus::Failed);
    let (xml, _) = rig.policy().unwrap();
    assert!(xml.contains(r"C:\Program Files\Rulebox\*") && xml.contains(r"C:\Program Files (x86)\Microsoft\EdgeWebView\*"));
}

#[test]
fn off_does_not_touch_the_platform_for_anything_but_the_journalled_entries() {
    let rig = Rig::new();
    let state = rig.apply_doc(&Rig::doc(LayerMode::Off));
    assert_eq!(state, LayerState { mode: ReportedMode::Off, state: LayerStatus::Ok, detail: None });
    assert_eq!(rig.mutating(), 0);
}
