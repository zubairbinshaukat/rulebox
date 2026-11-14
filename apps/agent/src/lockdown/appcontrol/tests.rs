//! Tests of L4, App Control (plan Step 6): the XML sources, the embedded binaries, the decision
//! table, and the layer against `SimPlatform`. Nothing touches the machine.

use std::sync::Arc;

use rulebox_policy::lockdown::{AppControlSetting, LockdownPolicy};
use rulebox_policy::AgentDoc;

use super::*;
use crate::journal::{self, EntryPhase, JournalCtx, JournalEntry, JournalTarget, OriginalValue};
use crate::lockdown::apply::{apply as apply_all, APPLY_ORDER};
use crate::lockdown::invariants::Facts;
use crate::platform::sim::{SimOp, SimPlatform};
use crate::platform::Platform;
use crate::state::{AgentState, SharedState, StateStore};
use crate::testutil::TempDir;

const BLOCKS_XML: &str = include_str!("../../../policies/appcontrol/recommended-blocks.xml");
const ALLOW_XML: &str = include_str!("../../../policies/appcontrol/allowlist.xml");
const FOREIGN: &str = "d2bda982-ccf6-4344-ac5b-0b44427b6816";

/// Skips a test that needs the embedded policy binaries when this build has none (fresh
/// clone, CI, Windows Home: `build.rs` warned and set `APPCONTROL_BUILT` to false).
macro_rules! skip_unless_built {
    () => {
        if !APPCONTROL_BUILT {
            eprintln!("skipped: target\\appcontrol was not built (pwsh scripts/appcontrol-build.ps1)");
            return;
        }
    };
}

// ---------------------------------------------------------------- a small XML reader

/// Checks that the document is well formed: tags nest and close, comments and the
/// declaration are skipped, attribute values are quoted.
fn well_formed(xml: &str) -> Result<(), String> {
    let mut stack: Vec<String> = Vec::new();
    let mut rest = xml;
    let mut roots = 0;
    while let Some(at) = rest.find('<') {
        let text = rest[..at].trim();
        if !text.is_empty() && stack.is_empty() {
            return Err(format!("text outside the root: {text:?}"));
        }
        rest = &rest[at..];
        if let Some(body) = rest.strip_prefix("<!--") {
            let end = body.find("-->").ok_or("a comment is not closed")?;
            if body[..end].contains("--") {
                return Err("`--` inside a comment".into());
            }
            rest = &body[end + 3..];
        } else if let Some(body) = rest.strip_prefix("<?") {
            let end = body.find("?>").ok_or("a declaration is not closed")?;
            rest = &body[end + 2..];
        } else {
            let end = rest.find('>').ok_or("a tag is not closed")?;
            let tag = &rest[1..end];
            rest = &rest[end + 1..];
            if let Some(name) = tag.strip_prefix('/') {
                match stack.pop() {
                    Some(open) if open == name.trim() => {}
                    other => return Err(format!("</{name}> closes {other:?}")),
                }
            } else {
                let self_closing = tag.ends_with('/');
                let body = tag.trim_end_matches('/');
                let name = body.split_whitespace().next().ok_or("an empty tag")?;
                if !body.matches('"').count().is_multiple_of(2) {
                    return Err(format!("unbalanced quotes in <{name}>"));
                }
                if stack.is_empty() {
                    roots += 1;
                }
                if !self_closing {
                    stack.push(name.to_string());
                }
            }
        }
    }
    if !stack.is_empty() {
        return Err(format!("not closed: {stack:?}"));
    }
    if roots != 1 {
        return Err(format!("{roots} root elements"));
    }
    Ok(())
}

/// The raw text of every start tag called `name` (`<Allow ... />`).
fn tags<'a>(xml: &'a str, name: &str) -> Vec<&'a str> {
    let open = format!("<{name} ");
    let mut out = Vec::new();
    let mut rest = xml;
    while let Some(at) = rest.find(&open) {
        let from = &rest[at..];
        let end = from.find('>').unwrap_or(from.len());
        out.push(&from[..end]);
        rest = &from[end..];
    }
    out
}

fn attr<'a>(tag: &'a str, name: &str) -> Option<&'a str> {
    let key = format!(" {name}=\"");
    let start = tag.find(&key)? + key.len();
    Some(&tag[start..start + tag[start..].find('"')?])
}

fn element<'a>(xml: &'a str, name: &str) -> Option<&'a str> {
    let open = format!("<{name}>");
    let start = xml.find(&open)? + open.len();
    Some(xml[start..start + xml[start..].find(&format!("</{name}>"))?].trim())
}

fn options(xml: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut rest = xml;
    while let Some(at) = rest.find("<Option>") {
        let body = &rest[at + 8..];
        let end = body.find("</Option>").unwrap_or(0);
        out.push(&body[..end]);
        rest = &body[end..];
    }
    out
}

// ---------------------------------------------------------------- the XML sources

#[test]
fn both_sources_are_well_formed() {
    assert_eq!(well_formed(BLOCKS_XML), Ok(()));
    assert_eq!(well_formed(ALLOW_XML), Ok(()));
    // The checker itself notices the usual faults.
    assert!(well_formed("<a><b></a></b>").is_err());
    assert!(well_formed("<a>").is_err());
    assert!(well_formed("<a/><b/>").is_err());
    assert!(well_formed("<a x=\"1/>").is_err());
    assert!(well_formed("<!-- a -- b --><a/>").is_err());
}

#[test]
fn the_sources_are_base_policies_with_the_fixed_ids_and_versions() {
    for (xml, id, name) in [(BLOCKS_XML, BLOCKS_ID, "recommended-blocks"), (ALLOW_XML, ALLOW_ID, "allowlist")] {
        let policy_id = element(xml, "PolicyID").unwrap().trim_matches(|c| c == '{' || c == '}').to_ascii_lowercase();
        let base_id = element(xml, "BasePolicyID").unwrap().trim_matches(|c| c == '{' || c == '}').to_ascii_lowercase();
        assert_eq!(policy_id, id, "{name}");
        assert_eq!(base_id, id, "{name}: a base policy is its own base");
        assert!(xml.contains("PolicyType=\"Base Policy\""), "{name}");
        assert!(!xml.contains("<PolicyTypeID>"), "{name}: the single-policy format is gone");
        let version = element(xml, "VersionEx").unwrap();
        assert_eq!(POLICY_VERSIONS.iter().find(|(n, _)| *n == name).map(|(_, v)| *v), Some(version), "{name}");
        let parts: Vec<_> = version.split('.').collect();
        assert!(parts.len() == 4 && parts.iter().all(|p| p.parse::<u16>().is_ok()), "{name}: {version}");
        // Unsigned, with the way back at start-up and user-mode rules.
        let options = options(xml);
        for needed in ["Enabled:Unsigned System Integrity Policy", "Enabled:Advanced Boot Options Menu", "Enabled:UMCI"] {
            assert!(options.contains(&needed), "{name}: {needed}");
        }
        for banned in ["Enabled:Boot Menu Protection", "Enabled:Required WHQL", "Enabled:Intelligent Security Graph Authorization"] {
            assert!(!options.contains(&banned), "{name}: {banned}");
        }
    }
    assert_ne!(BLOCKS_ID, ALLOW_ID);
}

#[test]
fn the_blocks_policy_is_microsofts_list_and_allows_everything_else() {
    let allows = tags(BLOCKS_XML, "Allow");
    let ids: Vec<_> = allows.iter().filter_map(|tag| attr(tag, "ID")).collect();
    assert_eq!(ids, ["ID_ALLOW_A_1", "ID_ALLOW_A_2"], "Microsoft's two allow-all rules, nothing else");
    assert!(allows.iter().all(|tag| attr(tag, "FileName") == Some("*")));
    let denies = tags(BLOCKS_XML, "Deny");
    assert!(denies.len() > 100, "{} deny rules", denies.len());
    for name in ["mshta.exe", "wscript.exe", "cscript.exe", "msbuild.exe", "wmic.exe", "bash.exe"] {
        assert!(
            denies.iter().any(|tag| attr(tag, "FileName").is_some_and(|file| file.eq_ignore_ascii_case(name))),
            "{name} is on Microsoft's list"
        );
    }
    // Plan Do NOT: no rule of our own. The Rulebox files, Windows itself and the admin tools
    // (invariant I6) are never denied.
    for tag in &denies {
        let file = attr(tag, "FileName").unwrap_or("").to_ascii_lowercase();
        assert!(!file.contains("rulebox"), "{tag}");
        assert!(!["rulebox-agent.exe", "explorer.exe", "msiexec.exe", "cmd.exe", "powershell.exe"].contains(&file.as_str()), "{tag}");
    }
    assert!(tags(BLOCKS_XML, "Allow").iter().all(|tag| attr(tag, "FilePath").is_none()), "no path rules");
    assert!(!BLOCKS_XML.contains("FilePath="));
    // The comment names the source page and the date (licence: THIRD_PARTY_NOTICES.md).
    assert!(BLOCKS_XML.contains("learn.microsoft.com") && BLOCKS_XML.contains("2026-11-08"));
}

#[test]
fn the_allowlist_allows_the_rulebox_folder_windows_and_program_files_and_no_writable_folder() {
    let paths: Vec<(&str, &str)> = tags(ALLOW_XML, "Allow")
        .into_iter()
        .filter_map(|tag| Some((attr(tag, "ID")?, attr(tag, "FilePath")?)))
        .collect();
    let find = |id: &str| paths.iter().find(|(rule, _)| *rule == id).map(|(_, path)| *path);
    assert_eq!(find("ID_ALLOW_PATH_RULEBOX"), Some(r"%OSDRIVE%\Program Files\Rulebox\*"));
    assert_eq!(find("ID_ALLOW_PATH_WINDOWS"), Some(r"%WINDIR%\*"));
    assert_eq!(find("ID_ALLOW_PATH_PROGRAMFILES"), Some(r"%OSDRIVE%\Program Files\*"));
    assert_eq!(find("ID_ALLOW_PATH_PROGRAMFILES_X86"), Some(r"%OSDRIVE%\Program Files (x86)\*"));
    assert_eq!(find("ID_ALLOW_PATH_PROGRAMFILES_ARM"), Some(r"%OSDRIVE%\Program Files (Arm)\*"));
    assert_eq!(paths.len(), 5, "no other path rule");
    for (_, path) in &paths {
        let lower = path.to_ascii_lowercase();
        for writable in ["users", "appdata", "temp", "programdata", "%userprofile%", "%temp%", "downloads", "\\public"] {
            assert!(!lower.contains(writable), "{path} opens a user-writable folder");
        }
        assert!(path.ends_with('*') && !path.starts_with('*'));
    }
    // The user-mode scenario references every path rule, so the Rulebox folder is allowed.
    let umci_start = ALLOW_XML.find("ID_SIGNINGSCENARIO_UMCI").unwrap();
    let umci = &ALLOW_XML[umci_start..];
    for (id, _) in &paths {
        assert!(umci.contains(&format!("<FileRuleRef RuleID=\"{id}\" />")), "{id} is not in the user-mode scenario");
    }
    // Kernel mode: allow all, no driver rules.
    let kernel = &ALLOW_XML[ALLOW_XML.find("ID_SIGNINGSCENARIO_KMCI").unwrap()..umci_start];
    assert!(kernel.contains("ID_ALLOW_KERNEL_ALL") && !kernel.contains("AllowedSigner"));
    assert!(tags(ALLOW_XML, "Deny").is_empty(), "the allow list has no deny rule");
    assert_eq!(attr(tags(ALLOW_XML, "Allow")[0], "FileName"), Some("*"));
    // Every referenced rule and signer exists.
    for reference in tags(ALLOW_XML, "FileRuleRef") {
        let rule = attr(reference, "RuleID").unwrap();
        assert!(ALLOW_XML.contains(&format!("ID=\"{rule}\"")), "{rule}");
    }
    for reference in tags(ALLOW_XML, "AllowedSigner") {
        let signer = attr(reference, "SignerId").unwrap();
        assert!(ALLOW_XML.contains(&format!("<Signer ID=\"{signer}\"")), "{signer}");
    }
}

// ---------------------------------------------------------------- the embedded binaries

/// The policy id a `.cip` names after its 4-byte format version (mixed-endian GUID).
fn binary_policy_id(bytes: &[u8]) -> String {
    let hex = |slice: &[u8]| slice.iter().map(|b| format!("{b:02x}")).collect::<String>();
    let reversed = |slice: &[u8]| hex(&slice.iter().rev().copied().collect::<Vec<u8>>());
    format!(
        "{}-{}-{}-{}-{}",
        reversed(&bytes[4..8]),
        reversed(&bytes[8..10]),
        reversed(&bytes[10..12]),
        hex(&bytes[12..14]),
        hex(&bytes[14..20])
    )
}

#[test]
fn four_binaries_are_embedded_and_match_their_sources() {
    skip_unless_built!();
    assert_eq!(EMBEDDED.len(), 4);
    for id in RULEBOX_POLICY_IDS {
        for variant in [Variant::Audit, Variant::Enforce] {
            let policy = embedded(id, variant).unwrap_or_else(|| panic!("{id} {variant:?}"));
            assert!(policy.bytes.len() > 100, "{} bytes", policy.bytes.len());
            assert_eq!(binary_policy_id(policy.bytes), id, "the binary names its own policy");
            assert_eq!(policy.sha256, journal::policy_hash(policy.bytes));
            let version = POLICY_VERSIONS.iter().find(|(n, _)| *n == policy.name).map(|(_, v)| *v);
            assert_eq!(version, Some(policy.version));
        }
        let audit = embedded(id, Variant::Audit).unwrap();
        let enforce = embedded(id, Variant::Enforce).unwrap();
        assert_ne!(audit.sha256, enforce.sha256, "the audit option changes the binary");
    }
    assert_eq!(embedded(BLOCKS_ID, Variant::Audit).unwrap().name, "recommended-blocks");
    assert_eq!(embedded(ALLOW_ID, Variant::Enforce).unwrap().name, "allowlist");
    assert!(embedded(FOREIGN, Variant::Audit).is_none());
}

// ---------------------------------------------------------------- the decision table

#[test]
fn the_decision_table_covers_mode_level_and_build() {
    use AppControlLevel::{Allowlist, RecommendedBlocks, Unknown as UnknownLevel};
    use LayerMode::{Audit, Enforce, Off, Unknown as UnknownMode};
    let levels = [RecommendedBlocks, Allowlist, UnknownLevel];
    for build in [17763, 18361, 18362, 19045, 22000, 22621, 26100, 26300] {
        for level in levels {
            // off removes, on every build and at every level.
            assert_eq!(decide(Off, level, build), Plan::Remove, "{build} {level:?}");
            // An unknown mode changes nothing.
            assert_eq!(decide(UnknownMode, level, build), Plan::LeaveAlone("section_unknown_value"));
        }
        for (mode, variant) in [(Audit, Variant::Audit), (Enforce, Variant::Enforce)] {
            assert_eq!(decide(mode, UnknownLevel, build), Plan::LeaveAlone("section_unknown_value"));
            let (blocks, allow) = (
                decide(mode, RecommendedBlocks, build),
                decide(mode, Allowlist, build),
            );
            if build < MIN_BUILD_MULTIPLE_POLICY {
                assert_eq!(blocks, Plan::Unsupported("os_too_old_for_app_control"), "{build}");
                assert_eq!(allow, Plan::Unsupported("os_too_old_for_app_control"), "{build}");
            } else {
                assert_eq!(blocks, Plan::Deploy(vec![(BLOCKS_ID, variant)]), "{build}");
                // Q1: the allow list never comes alone; Microsoft's blocks always go with it.
                assert_eq!(allow, Plan::Deploy(vec![(BLOCKS_ID, variant), (ALLOW_ID, variant)]), "{build}");
            }
        }
        let expected = if build >= MIN_BUILD_CITOOL { Activation::Refresh } else { Activation::Restart };
        assert_eq!(activation_for(build), expected, "{build}");
    }
    // The default of a new organization (audit, recommended blocks) deploys one audit policy.
    assert_eq!(
        decide(AppControlSetting::default().mode, AppControlSetting::default().level, 26100),
        Plan::Deploy(vec![(BLOCKS_ID, Variant::Audit)])
    );
    assert!(Plan::Remove.wanted().is_empty() && Plan::Unsupported("x").wanted().is_empty());
}

#[test]
fn the_allow_list_level_is_refused_for_an_app_outside_the_allowed_folders() {
    let roots = rulebox_policy::paths::PathRoots {
        program_files: r"C:\Program Files".into(),
        program_files_x86: Some(r"C:\Program Files (x86)".into()),
        system_root: Some(r"C:\Windows".into()),
        rulebox_apps: r"C:\Program Files\Rulebox\apps".into(),
    };
    let facts = |folders: &[&str]| Facts { catalogue_exe_folders: folders.iter().map(|f| (*f).to_string()).collect(), ..Facts::default() };
    assert_eq!(check_allowlist_level(&facts(&[]), &roots), Ok(()));
    assert_eq!(
        check_allowlist_level(
            &facts(&[
                r"C:\Program Files\Acme",
                r"c:\program files (x86)\Old",
                r"C:\Program Files (Arm)\Arm",
                r"C:\Windows\System32",
                r"C:\Program Files\Rulebox\apps\app1",
            ]),
            &roots
        ),
        Ok(())
    );
    for bad in [
        r"C:\Users\Staff\AppData\Local\Acme",
        r"C:\ProgramData\Acme",
        r"C:\Program Files Evil\x",
        r"D:\Program Files\Acme",
        r"C:\Windows2\x",
    ] {
        assert_eq!(check_allowlist_level(&facts(&[r"C:\Program Files\Acme", bad]), &roots), Err(ALLOWLIST_USER_INSTALL), "{bad}");
    }
}

// ---------------------------------------------------------------- the layer

struct Rig {
    _dir: TempDir,
    platform: Arc<SimPlatform>,
    shared: Arc<SharedState>,
}

impl Rig {
    fn new() -> Self {
        let dir = TempDir::new();
        let platform = Arc::new(SimPlatform::new(dir.path().to_path_buf()));
        let dyn_platform: Arc<dyn Platform> = platform.clone();
        let shared = SharedState::new(StateStore::open(&dir.path().join("state")).unwrap(), AgentState::default(), dyn_platform);
        Self { _dir: dir, platform, shared }
    }

    fn with_build(build: u32) -> Self {
        let rig = Self::new();
        rig.platform.with_world(|w| w.os.build = build);
        rig
    }

    fn ctx(&self, facts: Facts) -> ApplyCtx<'_> {
        ApplyCtx {
            journal: JournalCtx { platform: self.platform.as_ref(), shared: self.shared.as_ref() },
            facts,
            now_ms: 1_000,
            version: 7,
        }
    }

    fn doc(mode: LayerMode, level: AppControlLevel) -> AgentDoc {
        AgentDoc {
            lockdown: Some(LockdownPolicy { app_control: AppControlSetting { mode, level }, ..LockdownPolicy::default() }),
            ..AgentDoc::default()
        }
    }

    fn apply(&self, mode: LayerMode, level: AppControlLevel) -> LayerState {
        apply(&self.ctx(admin_facts()), &Self::doc(mode, level))
    }

    fn apply_doc(&self, doc: &AgentDoc) -> LayerState {
        apply(&self.ctx(admin_facts()), doc)
    }

    fn policies(&self) -> Vec<String> {
        self.platform.with_world(|w| w.ci_policies.keys().cloned().collect())
    }

    fn file(&self, id: &str) -> Option<Vec<u8>> {
        self.platform.with_world(|w| w.ci_policies.get(id).cloned())
    }

    fn refreshes(&self) -> u32 {
        self.platform.with_world(|w| w.ci_refreshes)
    }

    fn mutating(&self) -> usize {
        self.platform.calls().iter().filter(|op| op.is_mutating()).count()
    }

    fn entry(&self, id: &str) -> Option<JournalEntry> {
        let entry_id = journal::ci_id(id);
        self.shared.read(|s| s.journal.iter().find(|e| e.id == entry_id).cloned())
    }

    fn journal_len(&self) -> usize {
        self.shared.read(|s| s.journal.len())
    }

    fn put_foreign(&self) {
        self.platform.with_world(|w| w.ci_policies.insert(FOREIGN.to_string(), b"someone-elses-policy".to_vec()));
    }
}

fn admin_facts() -> Facts {
    Facts { admin_signin_verified: true, ..Facts::default() }
}

fn fail() -> crate::platform::PlatformError {
    crate::platform::PlatformError::Other("injected".into())
}

fn bytes_of(id: &str, variant: Variant) -> Vec<u8> {
    embedded(id, variant).unwrap().bytes.to_vec()
}

use AppControlLevel::{Allowlist, RecommendedBlocks};
use LayerMode::{Audit, Enforce, Off};

#[test]
fn a_document_without_lockdown_does_nothing() {
    let rig = Rig::new();
    let state = rig.apply_doc(&AgentDoc::default());
    assert_eq!(state, LayerState::off_ok());
    assert_eq!(rig.mutating(), 0);
    assert_eq!(rig.journal_len(), 0);
}

#[test]
fn a_build_without_the_binaries_deploys_nothing_and_says_why() {
    // Drives the "not built" build explicitly, so it runs whether or not the binaries exist.
    let rig = Rig::new();
    for (mode, level) in [(Audit, RecommendedBlocks), (Enforce, RecommendedBlocks), (Audit, Allowlist), (Enforce, Allowlist)] {
        let state = apply_with(&rig.ctx(admin_facts()), &Rig::doc(mode, level), false);
        assert_eq!((state.state, state.detail.as_deref()), (LayerStatus::Failed, Some("appcontrol_not_built")), "{mode:?} {level:?}");
        assert_eq!(state.mode, if mode == Audit { ReportedMode::Audit } else { ReportedMode::Enforce });
    }
    assert_eq!(NOT_BUILT, "appcontrol_not_built");
    assert_eq!(rig.mutating(), 0, "nothing written, nothing refreshed");
    assert_eq!((rig.journal_len(), rig.policies().len(), rig.refreshes()), (0, 0, 0));
    // `off` and a document without the section still work without binaries.
    assert_eq!(apply_with(&rig.ctx(admin_facts()), &Rig::doc(Off, RecommendedBlocks), false).state, LayerStatus::Ok);
    assert_eq!(apply_with(&rig.ctx(admin_facts()), &AgentDoc::default(), false), LayerState::off_ok());
    // The build's own flag and list agree.
    assert_eq!(APPCONTROL_BUILT, !EMBEDDED.is_empty());
}

#[test]
fn audit_deploys_the_audit_blocks_through_the_journal_and_refreshes_once() {
    skip_unless_built!();
    let rig = Rig::new();
    let state = rig.apply(Audit, RecommendedBlocks);
    assert_eq!((state.mode, state.state, state.detail.as_deref()), (ReportedMode::Audit, LayerStatus::Ok, None));
    assert_eq!(rig.policies(), [BLOCKS_ID]);
    assert_eq!(rig.file(BLOCKS_ID).unwrap(), bytes_of(BLOCKS_ID, Variant::Audit));
    assert_eq!(rig.refreshes(), 1);

    let entry = rig.entry(BLOCKS_ID).unwrap();
    assert_eq!(entry.owner, journal::JournalOwner::L4);
    assert_eq!(entry.target, JournalTarget::CiPolicy { policy_id: BLOCKS_ID.into() });
    assert_eq!((entry.original, entry.phase, entry.since_version), (OriginalValue::NotPresent, EntryPhase::Applied, 7));

    // Idempotent: nothing is written or refreshed again.
    let before = rig.mutating();
    assert_eq!(rig.apply(Audit, RecommendedBlocks), state);
    assert_eq!((rig.mutating(), rig.refreshes()), (before, 1));
}

#[test]
fn enforce_replaces_the_audit_binary() {
    skip_unless_built!();
    let rig = Rig::new();
    rig.apply(Audit, RecommendedBlocks);
    let state = rig.apply(Enforce, RecommendedBlocks);
    assert_eq!((state.mode, state.state), (ReportedMode::Enforce, LayerStatus::Ok));
    assert_eq!(rig.file(BLOCKS_ID).unwrap(), bytes_of(BLOCKS_ID, Variant::Enforce));
    assert_eq!(rig.refreshes(), 2);
    assert_eq!(rig.journal_len(), 1, "still one entry, with its first original");
    // And back to audit.
    rig.apply(Audit, RecommendedBlocks);
    assert_eq!(rig.file(BLOCKS_ID).unwrap(), bytes_of(BLOCKS_ID, Variant::Audit));
}

#[test]
fn the_allow_list_level_adds_the_second_policy_and_leaving_it_removes_only_that_one() {
    skip_unless_built!();
    let rig = Rig::new();
    rig.apply(Enforce, RecommendedBlocks);
    let state = rig.apply(Enforce, Allowlist);
    assert_eq!(state.state, LayerStatus::Ok);
    assert_eq!(rig.policies(), [BLOCKS_ID, ALLOW_ID]);
    assert_eq!(rig.file(ALLOW_ID).unwrap(), bytes_of(ALLOW_ID, Variant::Enforce));
    assert_eq!(rig.file(BLOCKS_ID).unwrap(), bytes_of(BLOCKS_ID, Variant::Enforce));
    assert_eq!(rig.journal_len(), 2);

    let state = rig.apply(Enforce, RecommendedBlocks);
    assert_eq!(state.state, LayerStatus::Ok);
    assert_eq!(rig.policies(), [BLOCKS_ID]);
    assert!(rig.entry(ALLOW_ID).is_none() && rig.entry(BLOCKS_ID).is_some());
}

#[test]
fn off_removes_what_the_agent_deployed_and_the_journal_is_empty() {
    skip_unless_built!();
    let rig = Rig::new();
    rig.apply(Audit, Allowlist);
    assert_eq!(rig.policies().len(), 2);
    let refreshes = rig.refreshes();
    let state = rig.apply(Off, RecommendedBlocks);
    assert_eq!((state.mode, state.state, state.detail), (ReportedMode::Off, LayerStatus::Ok, None));
    assert!(rig.policies().is_empty());
    assert_eq!(rig.journal_len(), 0);
    assert_eq!(rig.refreshes(), refreshes + 1, "one refresh for the removal");
    // A document that no longer has a lockdown section does the same.
    rig.apply(Audit, RecommendedBlocks);
    rig.apply_doc(&AgentDoc::default());
    assert!(rig.policies().is_empty() && rig.journal_len() == 0);
}

#[test]
fn disable_kiosk_restores_the_policies_through_the_journal() {
    skip_unless_built!();
    let rig = Rig::new();
    rig.apply(Enforce, Allowlist);
    let report = journal::restore_all(&JournalCtx { platform: rig.platform.as_ref(), shared: rig.shared.as_ref() });
    assert!(report.is_complete(), "{:?}", report.failed_ids());
    assert!(rig.policies().is_empty() && rig.journal_len() == 0);
}

#[test]
fn the_full_apply_runs_l4_in_its_place_in_the_order() {
    skip_unless_built!();
    let rig = Rig::new();
    let doc = Rig::doc(Audit, RecommendedBlocks);
    let outcome = apply_all(&rig.ctx(admin_facts()), &doc).unwrap();
    assert_eq!(outcome.ran, APPLY_ORDER);
    assert_eq!((outcome.layers.app_control.mode, outcome.layers.app_control.state), (ReportedMode::Audit, LayerStatus::Ok));
    assert_eq!(rig.policies(), [BLOCKS_ID]);
    // (Step 7) L3 is real now: this rig records no Staff account, so it refuses with its code
    // and writes nothing. The layers that are not built yet are still off.
    assert_eq!(
        (outcome.layers.app_locker.mode, outcome.layers.app_locker.state, outcome.layers.app_locker.detail.as_deref()),
        (ReportedMode::Audit, LayerStatus::Failed, Some("no_staff_account"))
    );
    assert_eq!(outcome.layers.proc_watch, LayerState::off_ok());
}

#[test]
fn windows_10_has_no_citool_so_the_change_waits_for_a_restart_until_the_pc_booted() {
    skip_unless_built!();
    let rig = Rig::with_build(19045);
    let state = rig.apply(Enforce, RecommendedBlocks);
    assert_eq!((state.mode, state.state), (ReportedMode::Enforce, LayerStatus::RestartPending));
    assert_eq!(state.detail.as_deref(), Some("restart_needed"));
    assert_eq!(rig.refreshes(), 0, "CiTool is never asked on this build");
    assert_eq!(rig.file(BLOCKS_ID).unwrap(), bytes_of(BLOCKS_ID, Variant::Enforce));
    assert!(rig.shared.read(|s| s.ci_restart).is_some());

    // Still waiting on the next apply, with nothing written.
    let before = rig.mutating();
    assert_eq!(rig.apply(Enforce, RecommendedBlocks).state, LayerStatus::RestartPending);
    assert_eq!(rig.mutating(), before);

    // The PC booted: the mark goes and the layer is ok.
    rig.platform.with_world(|w| w.boot_id = Some(101));
    let state = rig.apply(Enforce, RecommendedBlocks);
    assert_eq!((state.state, state.detail), (LayerStatus::Ok, None));
    assert!(rig.shared.read(|s| s.ci_restart).is_none());
}

#[test]
fn a_failed_refresh_also_waits_for_a_restart_and_the_file_stays() {
    skip_unless_built!();
    let rig = Rig::new();
    rig.platform.fail_next(SimOp::RefreshCiPolicies, fail());
    let state = rig.apply(Audit, RecommendedBlocks);
    assert_eq!(state.state, LayerStatus::RestartPending);
    assert_eq!(rig.policies(), [BLOCKS_ID]);
    assert!(rig.shared.read(|s| s.ci_restart).is_some());
}

#[test]
fn removal_on_windows_10_also_needs_a_restart() {
    skip_unless_built!();
    let rig = Rig::with_build(19045);
    rig.apply(Audit, RecommendedBlocks);
    rig.platform.with_world(|w| w.boot_id = Some(101));
    assert_eq!(rig.apply(Audit, RecommendedBlocks).state, LayerStatus::Ok);
    let state = rig.apply(Off, RecommendedBlocks);
    assert_eq!((state.mode, state.state), (ReportedMode::Off, LayerStatus::RestartPending));
    assert!(rig.policies().is_empty());
}

#[test]
fn a_build_before_the_multiple_policy_format_is_unsupported_and_writes_nothing() {
    let rig = Rig::with_build(17763);
    let state = rig.apply(Enforce, Allowlist);
    assert_eq!((state.mode, state.state), (ReportedMode::Enforce, LayerStatus::Unsupported));
    assert_eq!(state.detail.as_deref(), Some("os_too_old_for_app_control"));
    assert_eq!(rig.mutating(), 0);
    assert_eq!(rig.journal_len(), 0);
    // Off still works there (nothing to remove, nothing fails).
    assert_eq!(rig.apply(Off, RecommendedBlocks), LayerState::off_ok());
}

#[test]
fn an_unknown_mode_or_level_changes_nothing() {
    skip_unless_built!();
    let rig = Rig::new();
    rig.apply(Enforce, RecommendedBlocks);
    let before = (rig.mutating(), rig.refreshes(), rig.file(BLOCKS_ID));
    for (mode, level) in [(LayerMode::Unknown, RecommendedBlocks), (Enforce, AppControlLevel::Unknown), (Audit, AppControlLevel::Unknown)] {
        let state = rig.apply(mode, level);
        assert_eq!((state.state, state.detail.as_deref()), (LayerStatus::Ok, Some("section_unknown_value")));
        assert_eq!((rig.mutating(), rig.refreshes(), rig.file(BLOCKS_ID)), before);
    }
    assert_eq!(rig.journal_len(), 1);
}

#[test]
fn the_allow_list_level_is_refused_while_a_catalogue_app_runs_from_a_user_folder() {
    skip_unless_built!();
    let rig = Rig::new();
    let facts = Facts { catalogue_exe_folders: vec![r"C:\Users\Staff\AppData\Local\Acme".into()], ..admin_facts() };
    let doc = Rig::doc(Enforce, Allowlist);
    let state = apply(&rig.ctx(facts), &doc);
    assert_eq!((state.mode, state.state), (ReportedMode::Enforce, LayerStatus::Failed));
    assert_eq!(state.detail.as_deref(), Some("allowlist_level_with_user_install"));
    assert_eq!(rig.mutating(), 0);
    assert!(rig.policies().is_empty());
    // Machine-wide apps are fine.
    let facts = Facts { catalogue_exe_folders: vec![r"C:\Program Files\Acme".into()], ..admin_facts() };
    assert_eq!(apply(&rig.ctx(facts), &doc).state, LayerStatus::Ok);
    assert_eq!(rig.policies(), [BLOCKS_ID, ALLOW_ID]);
    // The blocks-only level never looks at the catalogue.
    let rig = Rig::new();
    let facts = Facts { catalogue_exe_folders: vec![r"C:\Users\Staff\AppData\Local\Acme".into()], ..admin_facts() };
    assert_eq!(apply(&rig.ctx(facts), &Rig::doc(Enforce, RecommendedBlocks)).state, LayerStatus::Ok);
}

#[test]
fn a_policy_the_agent_did_not_deploy_is_never_touched() {
    skip_unless_built!();
    let rig = Rig::new();
    rig.put_foreign();
    let foreign = rig.file(FOREIGN);
    for (mode, level) in [(Audit, RecommendedBlocks), (Enforce, Allowlist), (Enforce, RecommendedBlocks), (Off, RecommendedBlocks)] {
        rig.apply(mode, level);
        assert_eq!(rig.file(FOREIGN), foreign, "{mode:?} {level:?}");
    }
    assert_eq!(rig.policies(), [FOREIGN]);
    let restore = journal::restore_all(&JournalCtx { platform: rig.platform.as_ref(), shared: rig.shared.as_ref() });
    assert!(restore.is_complete());
    assert_eq!(rig.file(FOREIGN), foreign);
}

#[test]
fn a_rulebox_id_without_a_journal_entry_is_left_when_off_and_taken_over_when_wanted() {
    skip_unless_built!();
    let rig = Rig::new();
    let old = b"an-older-rulebox-build".to_vec();
    rig.platform.with_world(|w| w.ci_policies.insert(BLOCKS_ID.to_string(), old.clone()));
    // Off: it is not ours to remove (no entry says we deployed it).
    rig.apply(Off, RecommendedBlocks);
    assert_eq!(rig.file(BLOCKS_ID), Some(old));
    assert_eq!(rig.mutating(), 0);
    // Wanted: replaced, journalled with "was not there as ours", removed again on Disable.
    rig.apply(Enforce, RecommendedBlocks);
    assert_eq!(rig.file(BLOCKS_ID).unwrap(), bytes_of(BLOCKS_ID, Variant::Enforce));
    assert_eq!(rig.entry(BLOCKS_ID).unwrap().original, OriginalValue::NotPresent);
    rig.apply(Off, RecommendedBlocks);
    assert!(rig.policies().is_empty());
}

#[test]
fn a_failed_deploy_is_reported_and_the_next_apply_finishes_it() {
    skip_unless_built!();
    let rig = Rig::new();
    rig.platform.fail_next(SimOp::DeployCiPolicy, fail());
    let state = rig.apply(Enforce, RecommendedBlocks);
    assert_eq!((state.state, state.detail.as_deref()), (LayerStatus::Failed, Some("platform_error")));
    assert!(rig.policies().is_empty());
    assert_eq!(rig.refreshes(), 0, "nothing changed, nothing to load");
    assert_eq!(rig.entry(BLOCKS_ID).unwrap().phase, EntryPhase::Pending);

    let state = rig.apply(Enforce, RecommendedBlocks);
    assert_eq!(state.state, LayerStatus::Ok);
    assert_eq!(rig.entry(BLOCKS_ID).unwrap().phase, EntryPhase::Applied);
    assert_eq!(rig.file(BLOCKS_ID).unwrap(), bytes_of(BLOCKS_ID, Variant::Enforce));
}

#[test]
fn a_failed_removal_keeps_the_journal_entry_for_a_retry() {
    skip_unless_built!();
    let rig = Rig::new();
    rig.apply(Audit, RecommendedBlocks);
    rig.platform.fail_next(SimOp::RemoveCiPolicy, fail());
    let state = rig.apply(Off, RecommendedBlocks);
    assert_eq!(state.state, LayerStatus::Failed);
    assert_eq!(rig.entry(BLOCKS_ID).unwrap().phase, EntryPhase::Restoring);
    assert_eq!(rig.apply(Off, RecommendedBlocks).state, LayerStatus::Ok);
    assert!(rig.policies().is_empty() && rig.journal_len() == 0);
}

#[test]
fn a_crash_after_the_pending_entry_is_settled_at_the_next_start() {
    skip_unless_built!();
    let rig = Rig::new();
    journal::set_crash_point(Some(journal::CrashPoint::AfterPending));
    let state = rig.apply(Enforce, RecommendedBlocks);
    journal::set_crash_point(None);
    assert_eq!((state.state, state.detail.as_deref()), (LayerStatus::Failed, Some("crashed")));
    assert!(rig.policies().is_empty());
    let report = journal::startup_recover(&JournalCtx { platform: rig.platform.as_ref(), shared: rig.shared.as_ref() });
    assert_eq!(report.dropped, [journal::ci_id(BLOCKS_ID)], "the file never arrived, so the entry goes");
    assert_eq!(rig.journal_len(), 0);

    // A crash after the file was written keeps the entry, so Disable removes the file.
    journal::set_crash_point(Some(journal::CrashPoint::AfterWrite));
    rig.apply(Enforce, RecommendedBlocks);
    journal::set_crash_point(None);
    assert_eq!(rig.policies(), [BLOCKS_ID]);
    let report = journal::startup_recover(&JournalCtx { platform: rig.platform.as_ref(), shared: rig.shared.as_ref() });
    assert_eq!(report.kept, [journal::ci_id(BLOCKS_ID)]);
    assert!(journal::restore_all(&JournalCtx { platform: rig.platform.as_ref(), shared: rig.shared.as_ref() }).is_complete());
    assert!(rig.policies().is_empty());
}

#[test]
fn the_report_lists_rulebox_policies_only_and_names_the_variant() {
    skip_unless_built!();
    let rig = Rig::new();
    rig.put_foreign();
    assert_eq!(report(rig.platform.as_ref()).unwrap(), AppControlReport::default());
    rig.apply(Audit, Allowlist);
    let report_now = report(rig.platform.as_ref()).unwrap();
    assert_eq!(report_now.ci_policies, [BLOCKS_ID, ALLOW_ID]);
    assert!(report_now.deployed.iter().all(|policy| policy.variant == Some("audit")));
    assert!(!report_now.ci_policies.iter().any(|id| id == FOREIGN));
    rig.apply(Enforce, Allowlist);
    assert!(report(rig.platform.as_ref()).unwrap().deployed.iter().all(|policy| policy.variant == Some("enforce")));
    // Some other content under a Rulebox id is shown, with no variant.
    rig.platform.with_world(|w| w.ci_policies.insert(ALLOW_ID.to_string(), b"changed".to_vec()));
    let changed = report(rig.platform.as_ref()).unwrap();
    assert_eq!(changed.deployed.iter().find(|p| p.id == ALLOW_ID).unwrap().variant, None);
    let json = serde_json::to_value(&changed).unwrap();
    assert!(json.get("ciPolicies").is_some());
}

#[test]
fn the_layer_only_ever_names_its_own_ids() {
    skip_unless_built!();
    // Every id the code can pass to the seam is one of the two constants, and both are GUIDs
    // the seam accepts.
    for id in RULEBOX_POLICY_IDS {
        assert_eq!(rulebox_win32::codeintegrity::check_policy_id(id).unwrap(), id);
    }
    for policy in EMBEDDED {
        assert!(RULEBOX_POLICY_IDS.contains(&policy.id));
    }
}
