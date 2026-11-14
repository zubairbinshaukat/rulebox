//! Tests of L5, the process watchdog (plan Step 8): the matcher over the compiled allow-list, the
//! never-terminate list, audit and enforce, the signature cache, the bounded queue, the snapshot
//! fallback and the lost-event catch-up, the layer, and a burst of 1,000 starts. Every event is
//! synthetic and goes through `SimPlatform`; no trace session is ever started and nothing is
//! ended on this machine.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc::sync_channel;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rulebox_policy::lockdown::{
    ExceptionKind, ExceptionLayer, ExceptionRule, LayerSetting, LockdownPolicy, PublisherMatch,
};
use rulebox_policy::AgentDoc;

use super::*;
use crate::journal::JournalCtx;
use crate::lockdown::invariants::Facts;
use crate::platform::sim::{sim_path_roots, SimOp, SimPlatform, SimProcess, SimUser};
use crate::platform::{FolderAcl, SessionInfo, TraceStats};
use crate::state::{AgentState, SharedState, StaffAccount, StateStore};
use crate::testutil::TempDir;

const STAFF: &str = "S-1-5-21-1-1-1-2001";
const ADMIN: &str = "S-1-5-21-1000-2000-3000-1001";
const SYSTEM: &str = "S-1-5-18";
const ADMIN_ONLY: &str = "D:PAI(A;OICI;FA;;;BA)(A;OICI;FA;;;SY)(A;OICI;0x1200a9;;;BU)";
const MS: &str = "CN=Microsoft Windows, O=Microsoft Corporation, L=Redmond, S=Washington, C=US";
const OWN_PID: u32 = 4242;

fn protected() -> Vec<String> {
    vec![r"C:\Program Files\Rulebox".into(), r"C:\Program Files (x86)\Microsoft\EdgeWebView".into()]
}

fn publisher_exception(subject: &str, product: Option<&str>, layers: Vec<ExceptionLayer>) -> ExceptionRule {
    ExceptionRule {
        id: "ex-publisher".into(),
        app_id: None,
        kind: ExceptionKind::Publisher,
        publisher: Some(PublisherMatch { subject: subject.into(), product: product.map(str::to_string), file_name: None }),
        sha256: None,
        path: None,
        layers,
    }
}

fn hash_exception(layers: Vec<ExceptionLayer>) -> ExceptionRule {
    ExceptionRule {
        id: "ex-hash".into(),
        app_id: None,
        kind: ExceptionKind::Hash,
        publisher: None,
        sha256: Some("ab".repeat(32)),
        path: None,
        layers,
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
        layers: vec![ExceptionLayer::ProcWatch],
    }
}

fn allow_list(exceptions: &[ExceptionRule], accessibility: bool) -> AllowList {
    let roots = sim_path_roots();
    let protected = protected();
    let catalogue = vec![r"C:\Program Files\Catalogue".to_string()];
    let inputs = Inputs {
        roots: &roots,
        protected: &protected,
        catalogue_folders: &catalogue,
        exceptions,
        accessibility_tools: accessibility,
        windows_scan: &[FolderAcl { path: r"C:\Windows\Vendor\Cache".into(), sddl: "D:(A;OICI;0x1301bf;;;BU)".into() }],
        staff_sid: STAFF,
    };
    allowlist::build_for(&inputs, ExceptionLayer::ProcWatch, |_| Ok(Some(ADMIN_ONLY.to_string()))).unwrap()
}

fn config(mode: Mode, exceptions: &[ExceptionRule]) -> Config {
    Config { mode, staff_sid: STAFF.into(), allow: allow_list(exceptions, false), protected: protected(), own_pid: OWN_PID }
}

fn matcher(exceptions: &[ExceptionRule], accessibility: bool) -> Matcher {
    Matcher::new(&allow_list(exceptions, accessibility), &protected(), STAFF, OWN_PID)
}

fn info(pid: u32, image: &str, sid: &str) -> ProcessInfo {
    ProcessInfo { pid, session_id: 2, image: PathBuf::from(image), user_sid: sid.into() }
}

fn identity(signer: Option<&str>, original: Option<&str>, product: Option<&str>) -> FileIdentity {
    FileIdentity {
        signer: signer.map(str::to_string),
        original_name: original.map(str::to_string),
        product: product.map(str::to_string),
    }
}

/// A `Lookup` that answers from a table and counts the questions.
#[derive(Default)]
struct Fake {
    identities: HashMap<String, FileIdentity>,
    hashes: HashMap<String, String>,
    identity_calls: usize,
    hash_calls: usize,
}

impl Fake {
    fn with_identity(mut self, path: &str, id: FileIdentity) -> Self {
        self.identities.insert(path.to_ascii_lowercase(), id);
        self
    }
}

impl Lookup for Fake {
    fn identity(&mut self, image: &Path) -> Option<FileIdentity> {
        self.identity_calls += 1;
        self.identities.get(&image.to_string_lossy().to_ascii_lowercase()).cloned()
    }

    fn sha256(&mut self, image: &Path) -> Option<String> {
        self.hash_calls += 1;
        self.hashes.get(&image.to_string_lossy().to_ascii_lowercase()).cloned()
    }
}

fn decide(matcher: &Matcher, pid: u32, image: &str, sid: &str, fake: &mut Fake) -> Verdict {
    matcher.decide(&info(pid, image, sid), fake)
}

// ---------------------------------------------------------------- the matcher

#[test]
fn a_process_of_another_account_is_never_looked_at() {
    let matcher = matcher(&[], false);
    let mut fake = Fake::default();
    for sid in [ADMIN, SYSTEM, "S-1-5-19"] {
        // Even a denied program of the deny list: it is not the Staff account's.
        assert_eq!(decide(&matcher, 10, r"C:\Windows\System32\cmd.exe", sid, &mut fake), Verdict::NotStaff);
        assert_eq!(decide(&matcher, 11, r"C:\Users\x\evil.exe", sid, &mut fake), Verdict::NotStaff);
    }
    assert_eq!(fake.identity_calls + fake.hash_calls, 0);
}

#[test]
fn the_staff_sid_comparison_ignores_case() {
    let matcher = matcher(&[], false);
    let verdict = decide(&matcher, 10, r"C:\Users\x\evil.exe", &STAFF.to_ascii_lowercase(), &mut Fake::default());
    assert_eq!(verdict, Verdict::Denied(Denied::NotInAllowList));
}

#[test]
fn the_rulebox_programs_webview2_and_the_agent_are_never_ended() {
    let matcher = matcher(&[], false);
    let mut fake = Fake::default();
    for image in [
        r"C:\Program Files\Rulebox\rulebox-agent.exe",
        r"C:\Program Files\Rulebox\rulebox-shell.exe",
        r"C:\Program Files\Rulebox\versions\0.1.0\rulebox-staff.exe",
        r"C:\Program Files\Rulebox\apps\Tool\tool.exe",
        r"C:\Program Files (x86)\Microsoft\EdgeWebView\Application\126.0\msedgewebview2.exe",
    ] {
        assert_eq!(decide(&matcher, 10, image, STAFF, &mut fake), Verdict::Allowed(Allowed::NeverTerminate), "{image}");
    }
    // The agent's own process id, wherever its image is.
    assert_eq!(decide(&matcher, OWN_PID, r"D:\odd\place\agent.exe", STAFF, &mut fake), Verdict::Allowed(Allowed::NeverTerminate));
    assert_eq!(fake.identity_calls, 0, "the folder settles it; no signature read");
}

#[test]
fn windows_own_session_processes_are_never_ended_but_a_copy_with_the_same_name_is() {
    let matcher = matcher(&[], false);
    let mut fake = Fake::default();
    for name in ["csrss.exe", "winlogon.exe", "dwm.exe", "fontdrvhost.exe", "ctfmon.exe", "conhost.exe"] {
        for folder in [r"C:\Windows\System32", r"C:\Windows\SysWOW64"] {
            let image = format!(r"{folder}\{name}");
            assert_eq!(decide(&matcher, 10, &image, STAFF, &mut fake), Verdict::Allowed(Allowed::NeverTerminate), "{image}");
        }
        // The same name in a place Staff can reach has no protection.
        let copy = format!(r"C:\Users\Staff\Downloads\{name}");
        assert_eq!(decide(&matcher, 10, &copy, STAFF, &mut fake), Verdict::Denied(Denied::NotInAllowList), "{copy}");
    }
    assert_eq!(
        decide(&matcher, 10, r"C:\Windows\SystemApps\MicrosoftWindows.Client.CBS_cw5n1h2txyewy\TextInputHost.exe", STAFF, &mut fake),
        Verdict::Allowed(Allowed::NeverTerminate)
    );
    assert_eq!(decide(&matcher, 10, r"C:\Users\Staff\TextInputHost.exe", STAFF, &mut fake), Verdict::Denied(Denied::NotInAllowList));
}

#[test]
fn the_never_terminate_list_is_the_one_of_the_plan() {
    let mut names: Vec<&str> = NEVER_TERMINATE_SYSTEM32.iter().chain(NEVER_TERMINATE_SYSTEM_APPS).copied().collect();
    names.sort_unstable();
    assert_eq!(
        names,
        ["conhost.exe", "csrss.exe", "ctfmon.exe", "dwm.exe", "fontdrvhost.exe", "textinputhost.exe", "winlogon.exe"]
    );
}

#[test]
fn programs_of_the_windows_folder_run_except_the_deny_list() {
    let matcher = matcher(&[], false);
    let mut fake = Fake::default();
    for image in [
        r"C:\Windows\System32\notepad.exe",
        r"C:\Windows\System32\calc.exe",
        r"C:\Windows\SystemApps\Microsoft.Windows.StartMenuExperienceHost_cw5n1h2txyewy\StartMenuExperienceHost.exe",
        r"C:\Windows\SysWOW64\mspaint.exe",
    ] {
        assert_eq!(decide(&matcher, 10, image, STAFF, &mut fake), Verdict::Allowed(Allowed::WindowsFolder), "{image}");
    }
    for image in [
        r"C:\Windows\System32\cmd.exe",
        r"C:\Windows\SysWOW64\cmd.exe",
        r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe",
        r"C:\Windows\explorer.exe",
        r"C:\Windows\regedit.exe",
        r"C:\Windows\System32\taskmgr.exe",
        r"c:\windows\system32\CMD.EXE",
    ] {
        assert_eq!(decide(&matcher, 10, image, STAFF, &mut fake), Verdict::Denied(Denied::WindowsBinary), "{image}");
    }
    assert_eq!(fake.identity_calls, 0, "the path settles the Windows folder; no signature read");
}

#[test]
fn accessibility_tools_follow_the_switch() {
    let mut fake = Fake::default();
    let osk = r"C:\Windows\System32\osk.exe";
    assert_eq!(decide(&matcher(&[], false), 10, osk, STAFF, &mut fake), Verdict::Denied(Denied::WindowsBinary));
    assert_eq!(decide(&matcher(&[], true), 10, osk, STAFF, &mut fake), Verdict::Allowed(Allowed::WindowsFolder));
}

#[test]
fn folders_outside_the_list_are_denied_and_the_catalogue_folder_is_allowed() {
    let matcher = matcher(&[], false);
    let mut fake = Fake::default();
    assert_eq!(decide(&matcher, 10, r"C:\Program Files\Catalogue\app.exe", STAFF, &mut fake), Verdict::Allowed(Allowed::CatalogueFolder));
    for image in [
        r"C:\Users\Staff\Downloads\setup.exe",
        r"C:\Users\Staff\AppData\Local\Temp\x.exe",
        r"C:\Program Files\Other\other.exe",
        r"C:\Program Files (x86)\Other\other.exe",
        r"D:\portable\tool.exe",
        r"\\server\share\tool.exe",
    ] {
        assert_eq!(decide(&matcher, 10, image, STAFF, &mut fake), Verdict::Denied(Denied::NotInAllowList), "{image}");
    }
}

#[test]
fn renamed_copies_are_judged_by_where_they_are_and_what_they_say_they_are() {
    let matcher = matcher(&[], false);
    // A copy of cmd.exe in a user folder: outside the allow-list whatever it is called.
    let mut fake = Fake::default().with_identity(r"C:\Users\Staff\notes.exe", identity(Some(MS), Some("cmd.exe"), None));
    assert_eq!(decide(&matcher, 10, r"C:\Users\Staff\notes.exe", STAFF, &mut fake), Verdict::Denied(Denied::NotInAllowList));

    // A Microsoft-signed cmd.exe under another name in a Windows folder Staff can write to.
    let temp = r"C:\Windows\Temp\notes.exe";
    let mut fake = Fake::default().with_identity(temp, identity(Some(MS), Some("CMD.EXE"), None));
    assert_eq!(decide(&matcher, 10, temp, STAFF, &mut fake), Verdict::Denied(Denied::RenamedWindowsBinary));

    // A Microsoft-signed program that is not on the list: Windows' own, left alone (edge case 46).
    let mut fake = Fake::default().with_identity(temp, identity(Some(MS), Some("notepad.exe"), None));
    assert_eq!(decide(&matcher, 10, temp, STAFF, &mut fake), Verdict::Allowed(Allowed::WindowsFolder));

    // Not Microsoft's, or not signed, or unreadable: somebody's program in a writable folder.
    for id in [Some(identity(Some("CN=Evil"), Some("cmd.exe"), None)), Some(identity(None, None, None)), None] {
        let mut fake = Fake::default();
        if let Some(id) = id {
            fake = fake.with_identity(temp, id);
        }
        assert_eq!(decide(&matcher, 10, temp, STAFF, &mut fake), Verdict::Denied(Denied::WritableWindowsFolder));
    }
    // The scan found a writable vendor folder too.
    let mut fake = Fake::default();
    assert_eq!(decide(&matcher, 10, r"C:\Windows\Vendor\Cache\x.exe", STAFF, &mut fake), Verdict::Denied(Denied::WritableWindowsFolder));
}

#[test]
fn a_publisher_exception_allows_a_signed_program_and_narrows_by_product() {
    let rule = publisher_exception("O=Acme Inc, L=Town, C=US", Some("Acme Tool"), vec![ExceptionLayer::ProcWatch]);
    let matcher = matcher(&[rule], false);
    let image = r"C:\Users\Staff\AppData\Local\Acme\tool.exe";
    let signed = |product: &str| identity(Some("CN=Acme Tool Signing, O=Acme Inc, L=Town, C=US"), None, Some(product));
    // The exception names the subject without its CN, the form AppLocker publishers use.
    let mut fake = Fake::default().with_identity(image, signed("Acme Tool"));
    assert_eq!(decide(&matcher, 10, image, STAFF, &mut fake), Verdict::Allowed(Allowed::PublisherException));
    let mut fake = Fake::default().with_identity(image, signed("Other Product"));
    assert_eq!(decide(&matcher, 10, image, STAFF, &mut fake), Verdict::Denied(Denied::NotInAllowList));
    // Unsigned, or signed by somebody else.
    let mut fake = Fake::default().with_identity(image, identity(None, None, Some("Acme Tool")));
    assert_eq!(decide(&matcher, 10, image, STAFF, &mut fake), Verdict::Denied(Denied::NotInAllowList));
    let mut fake = Fake::default().with_identity(image, identity(Some("CN=Evil, O=Evil Inc"), None, Some("Acme Tool")));
    assert_eq!(decide(&matcher, 10, image, STAFF, &mut fake), Verdict::Denied(Denied::NotInAllowList));
}

#[test]
fn a_hash_is_read_only_when_a_hash_rule_exists_and_only_for_programs_the_folders_did_not_allow() {
    let image = r"C:\Users\Staff\Downloads\tool.exe";
    // No hash rule: the hash is never read.
    let mut fake = Fake::default();
    fake.hashes.insert(image.to_ascii_lowercase(), "ab".repeat(32));
    assert_eq!(decide(&matcher(&[], false), 10, image, STAFF, &mut fake), Verdict::Denied(Denied::NotInAllowList));
    assert_eq!(fake.hash_calls, 0);

    let with_rule = matcher(&[hash_exception(vec![ExceptionLayer::ProcWatch])], false);
    assert_eq!(decide(&with_rule, 10, image, STAFF, &mut fake), Verdict::Allowed(Allowed::HashException));
    assert_eq!(fake.hash_calls, 1);
    // A different file does not match; an allowed folder never asks.
    fake.hashes.insert(image.to_ascii_lowercase(), "cd".repeat(32));
    assert_eq!(decide(&with_rule, 10, image, STAFF, &mut fake), Verdict::Denied(Denied::NotInAllowList));
    let before = fake.hash_calls;
    decide(&with_rule, 10, r"C:\Windows\System32\notepad.exe", STAFF, &mut fake);
    decide(&with_rule, 10, r"C:\Program Files\Catalogue\a.exe", STAFF, &mut fake);
    assert_eq!(fake.hash_calls, before);
}

#[test]
fn a_path_exception_allows_exactly_that_file() {
    let matcher = matcher(&[path_exception()], false);
    let mut fake = Fake::default();
    assert_eq!(decide(&matcher, 10, r"C:\Program Files\Acme\tool.exe", STAFF, &mut fake), Verdict::Allowed(Allowed::PathException));
    assert_eq!(decide(&matcher, 10, r"c:\program files\acme\TOOL.EXE", STAFF, &mut fake), Verdict::Allowed(Allowed::PathException));
    assert_eq!(decide(&matcher, 10, r"C:\Program Files\Acme\other.exe", STAFF, &mut fake), Verdict::Denied(Denied::NotInAllowList));
}

#[test]
fn procwatch_uses_the_exceptions_that_name_it_and_applocker_the_ones_that_name_it() {
    let both = hash_exception(vec![ExceptionLayer::AppLocker, ExceptionLayer::ProcWatch]);
    let watch_only = path_exception();
    let locker_only = ExceptionRule { layers: vec![ExceptionLayer::AppLocker], ..publisher_exception("O=Acme", None, vec![]) };
    let exceptions = [both, watch_only, locker_only];
    let roots = sim_path_roots();
    let protected = protected();
    let inputs = Inputs {
        roots: &roots,
        protected: &protected,
        catalogue_folders: &[],
        exceptions: &exceptions,
        accessibility_tools: false,
        windows_scan: &[],
        staff_sid: STAFF,
    };
    let for_watch = allowlist::build_for(&inputs, ExceptionLayer::ProcWatch, |_| Ok(Some(ADMIN_ONLY.into()))).unwrap();
    let for_locker = allowlist::build(&inputs, |_| Ok(Some(ADMIN_ONLY.into()))).unwrap();
    assert_eq!(for_watch.exceptions.len(), 2, "the shared hash and the watchdog's path");
    assert!(for_watch.exceptions.iter().all(|e| !matches!(e, AllowException::Publisher { .. })));
    assert_eq!(for_locker.exceptions.len(), 2, "the shared hash and the publisher; not the watchdog's path");
    assert!(for_locker.exceptions.iter().all(|e| !matches!(e, AllowException::Path(_))));
}

#[test]
fn folder_classes_never_carry_a_path() {
    let protected = protected();
    let class = |image: &str| folder_class(image, r"C:\Windows", &protected);
    assert_eq!(class(r"C:\Windows\System32\cmd.exe"), "windows");
    assert_eq!(class(r"C:\Program Files\Other\a.exe"), "programFiles");
    assert_eq!(class(r"C:\Program Files (x86)\Other\a.exe"), "programFiles");
    assert_eq!(class(r"C:\Program Files\Rulebox\versions\1\app.exe"), "rulebox");
    assert_eq!(class(r"C:\Users\Staff\Documents\a.exe"), "userProfile");
    assert_eq!(class(r"C:\Users\Staff\AppData\Local\Temp\a.exe"), "userTemp");
    assert_eq!(class(r"C:\Windows\Temp\a.exe"), "userTemp");
    assert_eq!(class(r"\\server\share\a.exe"), "network");
    assert_eq!(class(r"D:\stuff\a.exe"), "other");
}

// ---------------------------------------------------------------- the signature cache

#[test]
fn the_cache_drops_the_oldest_entry_and_a_changed_stamp() {
    let stamp = |size| FileStamp { created: 1, modified: 1, size };
    let entry = |size| CacheEntry { stamp: stamp(size), identity: None, sha256: None };
    let mut cache = IdentityCache::new(2);
    cache.insert("a".into(), entry(1));
    cache.insert("b".into(), entry(1));
    cache.insert("c".into(), entry(1));
    assert_eq!(cache.len(), 2);
    assert!(cache.fresh("a", stamp(1)).is_none(), "the oldest went first");
    assert!(cache.fresh("b", stamp(1)).is_some());
    assert!(cache.fresh("b", stamp(2)).is_none(), "a replaced file is looked at again");
    assert_eq!(cache.len(), 1);
}

// ---------------------------------------------------------------- the engine against SimPlatform

struct Rig {
    _dir: TempDir,
    platform: Arc<SimPlatform>,
}

impl Rig {
    fn new() -> Self {
        let dir = TempDir::new();
        let platform = Arc::new(SimPlatform::new(dir.path().to_path_buf()));
        platform.with_world(|w| {
            w.sessions.push(SessionInfo { id: 2, state: SessionState::Active, user_sid: Some(STAFF.into()), is_console: true });
            w.users.insert("RuleboxStaff".into(), SimUser { sid: STAFF.into(), comment: String::new(), disabled: false, password: String::new() });
        });
        Self { _dir: dir, platform }
    }

    fn dyn_platform(&self) -> Arc<dyn Platform> {
        self.platform.clone()
    }

    fn process(&self, pid: u32, image: &str, sid: &str) {
        self.platform.with_world(|w| {
            w.processes.push(SimProcess { pid, session_id: 2, image: PathBuf::from(image), user_sid: sid.into() });
        });
    }

    fn engine(&self, mode: Mode, exceptions: &[ExceptionRule]) -> Engine {
        Engine::new(self.dyn_platform(), &config(mode, exceptions), None)
    }

    fn alive(&self, pid: u32) -> bool {
        self.platform.with_world(|w| w.processes.iter().any(|p| p.pid == pid))
    }

    fn terminations(&self) -> Vec<(u32, PathBuf, String)> {
        self.platform.with_world(|w| w.terminations.clone())
    }
}

fn start_event(pid: u32) -> ProcessStart {
    ProcessStart { pid, parent_pid: 4, session_id: 2, image: PathBuf::from(r"\Device\HarddiskVolume3\whatever.exe") }
}

fn wait_for(what: &str, mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !done() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[test]
fn audit_records_a_finding_and_ends_nothing() {
    let rig = Rig::new();
    rig.process(100, r"C:\Users\Staff\Downloads\game.exe", STAFF);
    rig.process(101, r"C:\Windows\System32\notepad.exe", STAFF);
    rig.platform.add_program(r"C:\Users\Staff\Downloads\game.exe", identity(Some("CN=Game Co, O=Game Co, L=X, C=US"), Some("game.exe"), Some("The Game")), None);
    let engine = rig.engine(Mode::Audit, &[]);
    engine.on_event(&start_event(100));
    engine.on_event(&start_event(101));
    let counters = engine.counters.view();
    assert_eq!((counters.events, counters.denied, counters.allowed, counters.terminated), (2, 1, 1, 0));
    assert!(rig.alive(100) && rig.alive(101));
    assert!(rig.terminations().is_empty(), "audit never calls the terminate method");

    let findings = engine.take_findings();
    assert_eq!(findings.len(), 1);
    let finding = &findings[0].finding;
    assert_eq!((finding.file_name.as_str(), finding.folder_class, finding.layer), ("game.exe", "userProfile", "procWatch"));
    assert_eq!(finding.signer.as_deref(), Some("CN=Game Co, O=Game Co"));
    assert_eq!(finding.reason, "not_in_allow_list");
    // The full path, the user name and the command line are nowhere in the finding.
    let text = format!("{finding:?}");
    assert!(!text.contains("Downloads") && !text.contains("Staff"), "{text}");
    assert!(engine.take_findings().is_empty(), "drained");
}

#[test]
fn the_same_program_is_one_finding_with_a_count() {
    let rig = Rig::new();
    for pid in 100..105 {
        rig.process(pid, r"C:\Users\Staff\Downloads\game.exe", STAFF);
    }
    let engine = rig.engine(Mode::Audit, &[]);
    for pid in 100..105 {
        engine.on_event(&start_event(pid));
    }
    let findings = engine.take_findings();
    assert_eq!((findings.len(), findings[0].count), (1, 5));
}

#[test]
fn enforce_ends_a_denied_staff_process_with_its_image_and_owner() {
    let rig = Rig::new();
    let image = r"C:\Users\Staff\Downloads\game.exe";
    rig.process(100, image, STAFF);
    let engine = rig.engine(Mode::Enforce, &[]);
    engine.on_event(&start_event(100));
    assert_eq!(rig.terminations(), vec![(100, PathBuf::from(image), STAFF.to_string())]);
    assert!(!rig.alive(100));
    assert_eq!(engine.counters.view().terminated, 1);
    assert_eq!(engine.take_findings().len(), 1);
}

#[test]
fn enforce_ends_nothing_that_is_allowed_never_listed_or_not_staffs() {
    let rig = Rig::new();
    let kept = [
        (200, r"C:\Windows\System32\dwm.exe", STAFF),
        (201, r"C:\Windows\System32\notepad.exe", STAFF),
        (202, r"C:\Program Files\Rulebox\rulebox-staff.exe", STAFF),
        (203, r"C:\Program Files\Catalogue\app.exe", STAFF),
        // Denied paths, but another account's: a service, an administrator.
        (204, r"C:\Windows\System32\cmd.exe", SYSTEM),
        (205, r"C:\Users\Admin\tool.exe", ADMIN),
        (206, r"C:\Windows\System32\csrss.exe", SYSTEM),
    ];
    for (pid, image, sid) in kept {
        rig.process(pid, image, sid);
    }
    let engine = rig.engine(Mode::Enforce, &[]);
    for (pid, _, _) in kept {
        engine.on_event(&start_event(pid));
    }
    assert!(rig.terminations().is_empty());
    assert!(kept.iter().all(|(pid, _, _)| rig.alive(*pid)));
    let counters = engine.counters.view();
    assert_eq!((counters.allowed, counters.not_staff, counters.denied), (4, 3, 0));
}

#[test]
fn a_process_that_ended_before_it_was_read_is_counted_and_skipped() {
    let rig = Rig::new();
    let engine = rig.engine(Mode::Enforce, &[]);
    engine.on_event(&start_event(999));
    let counters = engine.counters.view();
    assert_eq!((counters.gone, counters.denied), (1, 0));
    // A failed read does not stop anything either.
    rig.platform.fail_next(SimOp::ProcessInfo, PlatformError::AccessDenied);
    engine.on_event(&start_event(998));
    assert_eq!(engine.counters.view().events, 2);
}

#[test]
fn a_terminate_that_fails_is_counted_and_the_guard_refusal_is_its_own_count() {
    let rig = Rig::new();
    rig.process(100, r"C:\Users\Staff\a.exe", STAFF);
    rig.process(101, r"C:\Users\Staff\b.exe", STAFF);
    rig.process(102, r"C:\Users\Staff\c.exe", STAFF);
    let engine = rig.engine(Mode::Enforce, &[]);
    rig.platform.fail_next(SimOp::TerminateProcess, PlatformError::Guard("not a test machine".into()));
    rig.platform.fail_next(SimOp::TerminateProcess, PlatformError::AccessDenied);
    for pid in [100, 101, 102] {
        engine.on_event(&start_event(pid));
    }
    let counters = engine.counters.view();
    assert_eq!((counters.guarded, counters.terminate_failed, counters.terminated), (1, 1, 1));
}

#[test]
fn the_notice_goes_out_once_per_program_until_the_next_session() {
    let rig = Rig::new();
    rig.platform.add_program(r"C:\Users\Staff\a\game.exe", identity(None, None, Some("The Game")), None);
    for (pid, image) in [(100, r"C:\Users\Staff\a\game.exe"), (101, r"C:\Users\Staff\b\GAME.EXE"), (102, r"C:\Users\Staff\other.exe")] {
        rig.process(pid, image, STAFF);
    }
    let names = Arc::new(Mutex::new(Vec::new()));
    let hook: BlockedHook = {
        let names = Arc::clone(&names);
        Arc::new(move |blocked: BlockedProgram| names.lock().unwrap().push(blocked.display_name))
    };
    let engine = Engine::new(rig.dyn_platform(), &config(Mode::Enforce, &[]), Some(hook));
    for pid in [100, 101, 102] {
        engine.on_event(&start_event(pid));
    }
    assert_eq!(*names.lock().unwrap(), ["The Game", "other.exe"], "the product name when known, else the file name; game.exe once");
    engine.new_session();
    rig.process(103, r"C:\Users\Staff\c\game.exe", STAFF);
    engine.on_event(&start_event(103));
    assert_eq!(names.lock().unwrap().len(), 3);
}

#[test]
fn the_display_name_is_cut_at_100_characters() {
    let rig = Rig::new();
    let image = r"C:\Users\Staff\x.exe";
    rig.platform.add_program(image, identity(None, None, Some(&"P".repeat(300))), None);
    rig.process(100, image, STAFF);
    let names = Arc::new(Mutex::new(Vec::new()));
    let hook: BlockedHook = {
        let names = Arc::clone(&names);
        Arc::new(move |blocked: BlockedProgram| names.lock().unwrap().push(blocked.display_name))
    };
    Engine::new(rig.dyn_platform(), &config(Mode::Enforce, &[]), Some(hook)).on_event(&start_event(100));
    assert_eq!(names.lock().unwrap()[0].chars().count(), 100);
}

#[test]
fn a_signature_is_read_once_per_file_until_the_file_changes() {
    let rig = Rig::new();
    let image = r"C:\Windows\Temp\copy.exe";
    rig.platform.add_program(image, identity(Some(MS), Some("notepad.exe"), None), None);
    for pid in 100..110 {
        rig.process(pid, image, STAFF);
    }
    let engine = rig.engine(Mode::Audit, &[]);
    for pid in 100..110 {
        engine.on_event(&start_event(pid));
    }
    let counters = engine.counters.view();
    assert_eq!(counters.allowed, 10);
    assert_eq!(counters.identity_reads, 1, "{counters:?}");
    assert_eq!(counters.cache_hits, 9);
    // The file is replaced (new size): the next start reads it again.
    rig.platform.with_world(|w| {
        if let Some(p) = w.programs.get_mut(&image.to_ascii_lowercase()) {
            p.stamp.size += 1;
            p.identity = identity(Some("CN=Evil"), Some("cmd.exe"), None);
        }
    });
    rig.process(120, image, STAFF);
    engine.on_event(&start_event(120));
    assert_eq!(engine.counters.view().identity_reads, 2);
    assert_eq!(engine.counters.view().denied, 1);
}

#[test]
fn a_hash_rule_reads_the_hash_once_and_matches() {
    let rig = Rig::new();
    let image = r"C:\Users\Staff\Downloads\tool.exe";
    rig.platform.add_program(image, identity(None, None, None), Some(&"ab".repeat(32)));
    rig.process(100, image, STAFF);
    rig.process(101, image, STAFF);
    let engine = rig.engine(Mode::Enforce, &[hash_exception(vec![ExceptionLayer::ProcWatch])]);
    engine.on_event(&start_event(100));
    engine.on_event(&start_event(101));
    let counters = engine.counters.view();
    assert_eq!((counters.allowed, counters.terminated, counters.hash_reads), (2, 0, 1));
}

#[test]
fn a_snapshot_checks_what_was_running_and_decides_each_process_once() {
    let rig = Rig::new();
    rig.process(100, r"C:\Users\Staff\a.exe", STAFF);
    rig.process(101, r"C:\Windows\System32\notepad.exe", STAFF);
    // A process in a session that is not the Staff session is not in the snapshot.
    rig.platform.with_world(|w| {
        w.processes.push(SimProcess { pid: 300, session_id: 5, image: PathBuf::from(r"C:\Users\Other\z.exe"), user_sid: STAFF.into() });
    });
    let engine = rig.engine(Mode::Enforce, &[]);
    engine.snapshot();
    engine.snapshot();
    let counters = engine.counters.view();
    assert_eq!((counters.snapshots, counters.denied, counters.terminated, counters.allowed), (2, 1, 1, 1));
    assert!(!rig.alive(100) && rig.alive(300));
    // An event for a process the snapshot already decided is not decided again.
    engine.on_event(&start_event(101));
    assert_eq!(engine.counters.view().allowed, 1);
}

#[test]
fn a_snapshot_of_a_pc_with_nobody_signed_in_reads_nothing() {
    let rig = Rig::new();
    rig.platform.with_world(|w| w.sessions.clear());
    rig.engine(Mode::Enforce, &[]).snapshot();
    assert!(!rig.platform.calls().contains(&SimOp::SessionProcesses));
}

#[test]
fn lost_events_trigger_one_catch_up_snapshot() {
    let rig = Rig::new();
    let config = config(Mode::Enforce, &[]);
    let engine = Arc::new(Engine::new(rig.dyn_platform(), &config, None));
    let sink = ProcWatch::sink(&engine, sync_channel(4).0);
    let handle = rig.platform.start_process_trace(sink).unwrap();
    *lock(&engine.trace) = Some(handle);

    engine.check_losses();
    assert_eq!(engine.counters.view().snapshots, 0, "nothing lost, nothing to catch up");
    rig.platform.with_world(|w| w.trace_stats = TraceStats { events_lost: 3, buffers_lost: 2 });
    engine.check_losses();
    let counters = engine.counters.view();
    assert_eq!((counters.snapshots, counters.lost), (1, 5));
    engine.check_losses();
    assert_eq!(engine.counters.view().snapshots, 1, "the same losses are not counted twice");
    rig.platform.with_world(|w| w.trace_stats.events_lost = 4);
    engine.check_losses();
    assert_eq!((engine.counters.view().snapshots, engine.counters.view().lost), (2, 6));
}

#[test]
fn the_sink_drops_session_zero_and_a_full_queue_without_growing() {
    let rig = Rig::new();
    let engine = Arc::new(rig.engine(Mode::Audit, &[]));
    let (tx, rx) = sync_channel::<Msg>(2);
    let sink = ProcWatch::sink(&engine, tx);
    sink(ProcessStart { pid: 1, parent_pid: 0, session_id: 0, image: PathBuf::new() });
    for pid in 10..15 {
        sink(start_event(pid));
    }
    let counters = engine.counters.view();
    assert_eq!((counters.session_zero, counters.dropped), (1, 3));
    assert!(engine.overflow.load(Ordering::Relaxed), "a catch-up snapshot is asked for");
    assert_eq!(rx.try_iter().count(), 2, "the queue never holds more than its capacity");
}

// ---------------------------------------------------------------- the running watch

#[test]
fn a_running_watch_decides_events_from_the_trace_and_stops_cleanly() {
    let rig = Rig::new();
    rig.process(100, r"C:\Users\Staff\Downloads\game.exe", STAFF);
    let mut watch = ProcWatch::start(rig.dyn_platform(), &config(Mode::Enforce, &[]), None).unwrap();
    assert_eq!(watch.source(), Source::Trace);
    assert_eq!(rig.platform.running_traces(), 1);
    // The start-up catch-up ends the program that was already running.
    wait_for("the catch-up", || !rig.alive(100));

    rig.process(101, r"C:\Users\Staff\Downloads\other.exe", STAFF);
    rig.process(102, r"C:\Windows\System32\notepad.exe", STAFF);
    assert_eq!(rig.platform.emit_process_start(&start_event(101)), 1);
    assert_eq!(rig.platform.emit_process_start(&start_event(102)), 1);
    wait_for("the events", || watch.engine().counters.view().events >= 2);
    wait_for("the end of 101", || !rig.alive(101));
    assert!(rig.alive(102));

    assert_eq!(watch.layer_state(), LayerState { mode: ReportedMode::Enforce, state: LayerStatus::Ok, detail: None });
    watch.stop();
    assert_eq!(rig.platform.running_traces(), 0, "the session is stopped with the watch");
    assert_eq!(rig.platform.emit_process_start(&start_event(101)), 0);
    watch.stop();
}

#[test]
fn dropping_a_watch_stops_the_trace() {
    let rig = Rig::new();
    let watch = ProcWatch::start(rig.dyn_platform(), &config(Mode::Audit, &[]), None).unwrap();
    assert_eq!(rig.platform.running_traces(), 1);
    drop(watch);
    assert_eq!(rig.platform.running_traces(), 0);
}

#[test]
fn a_trace_that_cannot_start_falls_back_to_snapshots_and_still_ends_programs() {
    let rig = Rig::new();
    rig.process(100, r"C:\Users\Staff\Downloads\game.exe", STAFF);
    rig.platform.fail_next(SimOp::StartProcessTrace, PlatformError::Win32 { api: "StartTraceW", code: 1450 });
    let watch = ProcWatch::start(rig.dyn_platform(), &config(Mode::Enforce, &[]), None).unwrap();
    assert_eq!(watch.source(), Source::Snapshot);
    assert_eq!(
        watch.layer_state(),
        LayerState { mode: ReportedMode::Enforce, state: LayerStatus::Partial, detail: Some("snapshot_fallback".into()) }
    );
    wait_for("the catch-up", || !rig.alive(100));
    assert_eq!(rig.platform.running_traces(), 0);
}

#[test]
fn the_guard_refusing_the_trace_is_a_failure_not_a_fallback() {
    let rig = Rig::new();
    rig.platform.fail_next(SimOp::StartProcessTrace, PlatformError::Guard("not a test machine".into()));
    assert_eq!(ProcWatch::start(rig.dyn_platform(), &config(Mode::Enforce, &[]), None).err(), Some(StartError::Guard));
}

// ---------------------------------------------------------------- the layer

struct Host {
    rig: Rig,
    shared: Arc<SharedState>,
    host: ProcWatchHost,
}

impl Host {
    fn new(with_staff: bool) -> Self {
        let rig = Rig::new();
        let state = AgentState {
            staff: with_staff.then(|| StaffAccount { sid: STAFF.into(), user_name: "RuleboxStaff".into(), profile_dir: None }),
            ..AgentState::default()
        };
        let shared = SharedState::new(StateStore::open(&rig._dir.path().join("state")).unwrap(), state, rig.dyn_platform());
        let host = ProcWatchHost::new(rig.dyn_platform(), None);
        Self { rig, shared, host }
    }

    fn doc(mode: LayerMode) -> AgentDoc {
        AgentDoc {
            lockdown: Some(LockdownPolicy { proc_watch: LayerSetting { mode }, ..LockdownPolicy::default() }),
            ..AgentDoc::default()
        }
    }

    fn apply(&self, doc: &AgentDoc) -> LayerState {
        let facts = Facts { protected_paths: protected(), ..Facts::default() };
        let ctx = ApplyCtx {
            journal: JournalCtx { platform: self.rig.platform.as_ref(), shared: self.shared.as_ref() },
            facts,
            now_ms: 1_000,
            version: 7,
        };
        self.host.apply(&ctx, doc)
    }
}

#[test]
fn the_layer_starts_audit_keeps_the_watch_for_the_same_document_and_restarts_on_a_change() {
    let host = Host::new(true);
    let state = host.apply(&Host::doc(LayerMode::Audit));
    assert_eq!(state, LayerState { mode: ReportedMode::Audit, state: LayerStatus::Ok, detail: None });
    assert_eq!(host.rig.platform.running_traces(), 1);
    assert_eq!(host.host.running(), Some((Mode::Audit, Source::Trace)));

    // The same document again: the same session, not a new one.
    host.apply(&Host::doc(LayerMode::Audit));
    let starts = host.rig.platform.calls().iter().filter(|op| **op == SimOp::StartProcessTrace).count();
    assert_eq!(starts, 1);

    let state = host.apply(&Host::doc(LayerMode::Enforce));
    assert_eq!(state.mode, ReportedMode::Enforce);
    assert_eq!(host.rig.platform.running_traces(), 1, "the old session is stopped, one new one runs");
    assert_eq!(host.host.running(), Some((Mode::Enforce, Source::Trace)));
}

#[test]
fn the_layer_off_or_without_a_lockdown_section_stops_the_watch() {
    let host = Host::new(true);
    host.apply(&Host::doc(LayerMode::Enforce));
    assert_eq!(host.rig.platform.running_traces(), 1);
    assert_eq!(host.apply(&Host::doc(LayerMode::Off)), LayerState::off_ok());
    assert_eq!(host.rig.platform.running_traces(), 0);
    assert_eq!(host.host.running(), None);

    host.apply(&Host::doc(LayerMode::Audit));
    assert_eq!(host.apply(&AgentDoc::default()), LayerState::off_ok());
    assert_eq!(host.rig.platform.running_traces(), 0);
    // No machine value was written for any of this.
    assert!(host.rig.platform.calls().iter().all(|op| !op.is_mutating() || matches!(op, SimOp::StartProcessTrace | SimOp::StopProcessTrace)));
}

#[test]
fn the_layer_reports_failures_with_fixed_codes() {
    let host = Host::new(false);
    let state = host.apply(&Host::doc(LayerMode::Enforce));
    assert_eq!((state.state, state.detail.as_deref()), (LayerStatus::Failed, Some("no_staff_account")));
    assert_eq!(host.rig.platform.running_traces(), 0);

    let host = Host::new(true);
    host.rig.platform.fail_next(SimOp::StartProcessTrace, PlatformError::Guard("x".into()));
    let state = host.apply(&Host::doc(LayerMode::Enforce));
    assert_eq!((state.mode, state.state, state.detail.as_deref()), (ReportedMode::Enforce, LayerStatus::Failed, Some("blocked_by_guard")));

    // A mode this build does not know is off, like the other layers.
    let unknown = Host::doc(LayerMode::Unknown);
    let state = host.apply(&unknown);
    assert_eq!((state.mode, state.state, state.detail.as_deref()), (ReportedMode::Off, LayerStatus::Ok, Some("section_unknown_value")));
}

#[test]
fn the_layer_cuts_the_writable_windows_folders_found_by_the_scan_out_of_the_list() {
    let host = Host::new(true);
    host.rig.platform.with_world(|w| {
        w.path_acls.insert(r"c:\windows".into(), ADMIN_ONLY.into());
        w.path_acls.insert(r"c:\windows\vendor\cache".into(), "D:(A;OICI;0x1301bf;;;BU)".into());
    });
    host.apply(&Host::doc(LayerMode::Enforce));
    let config = lock(&host.host.current).as_ref().map(|(config, _)| config.clone()).unwrap();
    assert!(config.allow.windows_excluded_folders.iter().any(|f| f.eq_ignore_ascii_case(r"C:\windows\vendor\cache")), "{:?}", config.allow.windows_excluded_folders);
    assert_eq!(config.staff_sid, STAFF);
    assert_eq!(config.protected, protected());
}

// ---------------------------------------------------------------- the burst

#[test]
fn a_burst_of_a_thousand_starts_stays_inside_the_budget() {
    let rig = Rig::new();
    let images = [
        r"C:\Windows\System32\notepad.exe",
        r"C:\Windows\System32\cmd.exe",
        r"C:\Program Files\Catalogue\app.exe",
        r"C:\Users\Staff\Downloads\game.exe",
        r"C:\Program Files\Rulebox\rulebox-staff.exe",
        r"C:\Windows\Temp\copy.exe",
        r"C:\Windows\System32\dwm.exe",
    ];
    rig.platform.add_program(r"C:\Windows\Temp\copy.exe", identity(Some(MS), Some("calc.exe"), None), None);
    rig.platform.add_program(r"C:\Users\Staff\Downloads\game.exe", identity(Some("CN=Game, O=Game"), None, Some("Game")), None);
    let total: u32 = 1_000;
    for index in 0..total {
        rig.process(1_000 + index, images[index as usize % images.len()], if index % 11 == 0 { SYSTEM } else { STAFF });
    }
    // Audit: every decision is made, none ends a process (a fixed workload either way).
    let engine = rig.engine(Mode::Audit, &[hash_exception(vec![ExceptionLayer::ProcWatch])]);
    let started = Instant::now();
    for index in 0..total {
        engine.on_event(&start_event(1_000 + index));
    }
    let elapsed = started.elapsed();
    let per_event = elapsed / total;
    eprintln!("procwatch bench: {total} starts in {elapsed:?} ({per_event:?} per start, debug build)");
    let counters = engine.counters.view();
    assert_eq!(counters.events, u64::from(total));
    assert_eq!(counters.allowed + counters.denied + counters.not_staff, u64::from(total));
    assert!(counters.cache_hits > counters.identity_reads, "the cache absorbs repeats: {counters:?}");
    assert!(per_event < Duration::from_millis(2), "a decision must stay under 2 ms, took {per_event:?}");

    // The matcher alone, with no platform behind it.
    let matcher = matcher(&[], false);
    let mut fake = Fake::default();
    let started = Instant::now();
    for index in 0..total {
        decide(&matcher, 1_000 + index, images[index as usize % images.len()], STAFF, &mut fake);
    }
    let per_decision = started.elapsed() / total;
    eprintln!("procwatch bench: matcher alone {per_decision:?} per decision");
    assert!(per_decision < Duration::from_millis(2));
}

#[test]
fn the_queue_and_the_cache_have_fixed_bounds() {
    assert_eq!(QUEUE_CAPACITY, 256);
    assert_eq!(CACHE_CAPACITY, 2_000);
    assert_eq!(FINDINGS_CAPACITY, 500);
    assert_eq!(STATS_INTERVAL, Duration::from_secs(60));
    assert_eq!(POLL_INTERVAL, Duration::from_secs(2));
}

#[test]
fn findings_are_capped_and_the_oldest_goes_first() {
    let rig = Rig::new();
    let engine = rig.engine(Mode::Audit, &[]);
    for index in 0..(FINDINGS_CAPACITY as u32 + 20) {
        rig.process(1_000 + index, &format!(r"C:\Users\Staff\Downloads\p{index}.exe"), STAFF);
        engine.on_event(&start_event(1_000 + index));
    }
    let findings = engine.take_findings();
    assert_eq!(findings.len(), FINDINGS_CAPACITY);
    assert_eq!(findings[0].finding.file_name, "p20.exe");
}
