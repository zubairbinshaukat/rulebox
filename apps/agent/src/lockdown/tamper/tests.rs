//! Tests of the tamper part of L7 (plan Step 17): the service DACL and privileges, the folder
//! ACL self-check, drift -> repair -> counted, the exact restore, and the clock watch. All
//! against `SimPlatform`; nothing touches the machine.

use std::path::Path;
use std::sync::Arc;

use rulebox_policy::lockdown::{AutoRecovery, BootPolicy, LockdownPolicy};
use rulebox_policy::AgentDoc;

use super::*;
use crate::journal::{EntryPhase, JournalEntry, JournalTarget, OriginalValue};
use crate::lockdown::boot;
use crate::lockdown::invariants::Facts;
use crate::lockdown::{LayerState, LayerStatus, ReportedMode};
use crate::platform::sim::{SimOp, SimPlatform};
use crate::platform::PlatformError;
use crate::state::{AgentState, StateStore};
use crate::testutil::TempDir;

const T0: u64 = 1_800_000_000_000;
const MIN: u64 = 60_000;
const HOUR: u64 = 3_600_000;
const INSTALL: &str = r"C:\Program Files\Rulebox";
/// What Windows gives a folder under Program Files (shortened): inherited, Users can read.
const INSTALL_ORIGINAL: &str = "D:AI(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)(A;OICIID;0x1200a9;;;BU)";
/// The Phase 2 DACL as Windows hands it back (with the flag it adds).
const STATE_ORIGINAL: &str = "D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)";
/// An administrator let everybody stop the service.
const WEAK_SERVICE: &str = "D:(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)(A;;CCLCSWRPWPLOCRRC;;;IU)";
const WEAK_FOLDER: &str = "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;WD)";

struct Rig {
    dir: TempDir,
    platform: Arc<SimPlatform>,
    shared: Arc<SharedState>,
    tracker: TamperTracker,
    daily: DailyCounters,
    audits: Vec<(AuditKind, String)>,
    folders: Option<RuleboxFolders>,
}

fn key(path: &Path) -> String {
    path.to_string_lossy().replace('/', "\\").trim_end_matches('\\').to_ascii_lowercase()
}

impl Rig {
    fn new() -> Self {
        let dir = TempDir::new();
        let platform = Arc::new(SimPlatform::new(dir.path().to_path_buf()));
        let dyn_platform: Arc<dyn Platform> = platform.clone();
        let shared = SharedState::new(StateStore::open(&dir.path().join("state")).unwrap(), AgentState::default(), dyn_platform);
        let daily = DailyCounters::open(dir.path().join("security-daily.json")).unwrap();
        let folders = RuleboxFolders { install_root: INSTALL.into(), state_dir: dir.path().join("state") };
        platform.with_world(|w| {
            w.path_acls.insert(key(&folders.install_root), INSTALL_ORIGINAL.into());
            w.path_acls.insert(key(&folders.state_dir), STATE_ORIGINAL.into());
        });
        Self { dir, platform, shared, tracker: TamperTracker::new(), daily, audits: Vec::new(), folders: Some(folders) }
    }

    fn ctx(&self) -> ApplyCtx<'_> {
        ApplyCtx {
            journal: self.journal(),
            facts: Facts { admin_signin_verified: true, rulebox_folders: self.folders.clone(), ..Facts::default() },
            now_ms: T0,
            version: 7,
        }
    }

    fn journal(&self) -> JournalCtx<'_> {
        JournalCtx { platform: self.platform.as_ref(), shared: self.shared.as_ref() }
    }

    /// One pass of the boot layer, with or without a `lockdown` section.
    fn apply(&self, on: bool) -> LayerState {
        // The other boot items are left alone, so every write seen here is tamper protection.
        let boot = BootPolicy { auto_recovery: AutoRecovery::Leave, safe_mode_guard: false };
        let doc = AgentDoc {
            lockdown: on.then(|| LockdownPolicy { boot, ..LockdownPolicy::default() }),
            ..AgentDoc::default()
        };
        boot::apply(&self.ctx(), &doc)
    }

    fn pass(&mut self, now_ms: u64) -> TamperOutcome {
        let Rig { shared, tracker, daily, audits, .. } = self;
        tracker.finish_pass(shared, daily, now_ms, None, &mut |kind, detail| audits.push((kind, detail)))
    }

    fn service_sddl(&self) -> String {
        self.platform.get_service_security(AGENT_SERVICE).unwrap().unwrap()
    }

    fn privileges(&self) -> Vec<String> {
        self.platform.get_service_required_privileges(AGENT_SERVICE).unwrap()
    }

    fn acl(&self, path: &Path) -> String {
        self.platform.get_path_acl(path).unwrap().unwrap()
    }

    fn install(&self) -> &Path {
        Path::new(INSTALL)
    }

    fn state_dir(&self) -> std::path::PathBuf {
        self.dir.path().join("state")
    }

    fn mutating(&self) -> usize {
        self.platform.calls().iter().filter(|op| op.is_mutating()).count()
    }

    fn entry(&self, item: Item) -> Option<JournalEntry> {
        let id = item.id();
        self.shared.read(|s| s.journal.iter().find(|e| e.id == id).cloned())
    }

    fn tamper_today(&self) -> u64 {
        self.daily.today().map_or(0, |day| day.tamper)
    }

    fn report(&self) -> boot::SecurityReport {
        let mut report = boot::read_report(self.platform.as_ref()).unwrap();
        self.tracker.fill_report(&self.journal(), &mut report);
        report
    }
}

fn wanted_privileges() -> Vec<String> {
    AGENT_REQUIRED_PRIVILEGES.iter().map(|p| (*p).to_string()).collect()
}

// ---------------------------------------------------------------- apply and restore

#[test]
fn a_lockdown_document_protects_the_service_and_the_folders_and_journals_the_originals() {
    let rig = Rig::new();
    let service_original = rig.service_sddl();
    let state = rig.apply(true);
    assert_eq!((state.mode, state.state, state.detail), (ReportedMode::On, LayerStatus::Ok, None));

    // The DACL string is exactly the expected SDDL of plan 4.16.
    assert_eq!(rig.service_sddl(), AGENT_SERVICE_SDDL);
    assert_eq!(
        rig.service_sddl(),
        "D:(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)(A;;LC;;;IU)(A;;LC;;;AU)"
    );
    assert_eq!(rig.privileges(), wanted_privileges());
    assert_eq!(rig.acl(rig.install()), INSTALL_DIR_SDDL);
    // The state folder already had the Phase 2 DACL (Windows only added a flag): not written.
    assert_eq!(rig.acl(&rig.state_dir()), STATE_ORIGINAL);
    let writes: Vec<SimOp> = rig.platform.calls().into_iter().filter(|op| op.is_mutating()).collect();
    assert_eq!(writes, [SimOp::SetServiceRequiredPrivileges, SimOp::SetServiceSecurity, SimOp::SetPathAcl]);

    // Four entries, owner L7, each with the value from before.
    let service = rig.entry(Item::ServiceAcl).unwrap();
    assert_eq!(service.id, "svc-sec:RuleboxAgent");
    assert_eq!(service.target, JournalTarget::ServiceSecurity { name: "RuleboxAgent".into() });
    assert_eq!(service.original, OriginalValue::Sddl(service_original));
    assert_eq!((service.owner, service.phase, service.since_version), (JournalOwner::L7, EntryPhase::Applied, 7));
    let privileges = rig.entry(Item::ServicePrivileges).unwrap();
    assert_eq!(privileges.id, "svc-priv:RuleboxAgent");
    assert_eq!(privileges.original, OriginalValue::MultiString(Vec::new()), "no limit before");
    let install = rig.entry(Item::InstallAcl).unwrap();
    assert_eq!(install.id, "path-acl:install", "the id never holds the path");
    assert_eq!(install.target, JournalTarget::PathAcl { path: INSTALL.into() });
    assert_eq!(install.original, OriginalValue::Sddl(INSTALL_ORIGINAL.into()));
    // Recorded although nothing was written: a later repair must not record a tampered value.
    let state_entry = rig.entry(Item::StateAcl).unwrap();
    assert_eq!(state_entry.original, OriginalValue::Sddl(STATE_ORIGINAL.into()));
    assert_eq!(rig.shared.get().journal.len(), 4);
}

#[test]
fn a_second_pass_writes_nothing_and_finds_no_tampering() {
    let mut rig = Rig::new();
    rig.apply(true);
    let before = rig.mutating();
    for n in 0..3 {
        assert_eq!(rig.apply(true).state, LayerStatus::Ok);
        assert_eq!(rig.pass(T0 + n * 10 * MIN), TamperOutcome::default());
    }
    assert_eq!(rig.mutating(), before);
    assert!(rig.audits.is_empty());
    assert_eq!(rig.tamper_today(), 0);
}

#[test]
fn the_journal_file_spells_the_new_targets_in_camel_case() {
    let rig = Rig::new();
    rig.apply(true);
    let value = serde_json::to_value(rig.entry(Item::InstallAcl).unwrap()).unwrap();
    assert_eq!(value["target"], serde_json::json!({ "pathAcl": { "path": INSTALL } }));
    assert_eq!(value["original"], serde_json::json!({ "sddl": INSTALL_ORIGINAL }));
    let back: JournalEntry = serde_json::from_value(value).unwrap();
    assert_eq!(back, rig.entry(Item::InstallAcl).unwrap());
}

#[test]
fn a_document_without_lockdown_puts_every_original_back() {
    let rig = Rig::new();
    let service_original = rig.service_sddl();
    rig.apply(true);
    let state = rig.apply(false);
    assert_eq!((state.mode, state.state), (ReportedMode::Off, LayerStatus::Ok));
    assert_eq!(rig.service_sddl(), service_original);
    assert!(rig.privileges().is_empty(), "the limit is removed again");
    assert_eq!(rig.acl(rig.install()), INSTALL_ORIGINAL);
    assert_eq!(rig.acl(&rig.state_dir()), STATE_ORIGINAL);
    assert!(rig.shared.get().journal.is_empty());
    // Off again: nothing to do.
    let before = rig.mutating();
    rig.apply(false);
    assert_eq!(rig.mutating(), before);
}

#[test]
fn disable_kiosk_restores_everything_through_the_journal() {
    let rig = Rig::new();
    let service_original = rig.service_sddl();
    rig.apply(true);
    // Tampered and repaired in between: the originals must not change.
    rig.platform.with_world(|w| w.services.get_mut(AGENT_SERVICE).unwrap().sddl = WEAK_SERVICE.into());
    rig.apply(true);
    let report = journal::restore_all(&rig.journal());
    assert!(report.is_complete(), "{:?}", report.failed_ids());
    assert_eq!(report.restored.len(), 4);
    assert_eq!(rig.service_sddl(), service_original);
    assert!(rig.privileges().is_empty());
    assert_eq!(rig.acl(rig.install()), INSTALL_ORIGINAL);
    assert!(rig.shared.get().journal.is_empty());
}

#[test]
fn a_restore_of_a_service_or_folder_that_is_gone_is_complete() {
    let rig = Rig::new();
    rig.apply(true);
    rig.platform.with_world(|w| {
        w.services.remove(AGENT_SERVICE);
    });
    let report = journal::restore_all(&rig.journal());
    assert!(report.is_complete(), "{:?}", report.failed_ids());
    assert!(rig.shared.get().journal.is_empty());
}

#[test]
fn a_crash_between_the_journal_and_the_write_is_settled_at_the_next_start() {
    let rig = Rig::new();
    let service_original = rig.service_sddl();
    journal::set_crash_point(Some(journal::CrashPoint::AfterPending));
    let state = rig.apply(true);
    journal::set_crash_point(None);
    assert_eq!(state.state, LayerStatus::Failed);
    assert_eq!(rig.mutating(), 0, "nothing was written before the crash");
    assert!(rig.shared.get().journal.iter().all(|entry| entry.phase == EntryPhase::Pending));
    // The values are still the originals: the pending entries are dropped.
    let report = journal::startup_recover(&rig.journal());
    assert_eq!(report.dropped.len(), rig.shared.get().journal.len() + report.dropped.len());
    assert!(report.kept.is_empty() && rig.shared.get().journal.is_empty());
    assert_eq!(rig.service_sddl(), service_original);
    // And the next pass applies everything.
    assert_eq!(rig.apply(true).state, LayerStatus::Ok);
    assert_eq!(rig.service_sddl(), AGENT_SERVICE_SDDL);
}

// ---------------------------------------------------------------- drift -> repair -> counted

#[test]
fn drift_is_repaired_counted_and_audited_once_per_item_per_day() {
    let mut rig = Rig::new();
    rig.apply(true);
    assert_eq!(rig.pass(T0), TamperOutcome::default(), "the first apply is not tampering");
    let originals: Vec<OriginalValue> = Item::ALL.iter().map(|item| rig.entry(*item).unwrap().original).collect();

    // An administrator weakens all four.
    let state_dir = rig.state_dir();
    rig.platform.with_world(|w| {
        let service = w.services.get_mut(AGENT_SERVICE).unwrap();
        service.sddl = WEAK_SERVICE.into();
        service.privileges.clear();
        w.path_acls.insert(key(Path::new(INSTALL)), WEAK_FOLDER.into());
        w.path_acls.insert(key(&state_dir), WEAK_FOLDER.into());
    });
    assert_eq!(holds(rig.platform.as_ref(), rig.folders.as_ref(), Item::ServiceAcl), Some(false));

    // The next pass repairs them ...
    assert_eq!(rig.apply(true).state, LayerStatus::Ok);
    assert_eq!(rig.service_sddl(), AGENT_SERVICE_SDDL);
    assert_eq!(rig.privileges(), wanted_privileges());
    assert_eq!(rig.acl(rig.install()), INSTALL_DIR_SDDL);
    assert_eq!(rig.acl(&state_dir), PROTECTED_DIR_SDDL);
    for item in Item::ALL {
        assert_eq!(holds(rig.platform.as_ref(), rig.folders.as_ref(), item), Some(true), "{item:?}");
    }
    // ... and they are counted and audited, with fixed codes and no path.
    let outcome = rig.pass(T0 + 10 * MIN);
    assert_eq!(outcome.repaired.len(), 4);
    assert_eq!(outcome.audited, 4);
    assert_eq!(rig.tamper_today(), 4);
    let mut details: Vec<&str> = rig.audits.iter().map(|(_, detail)| detail.as_str()).collect();
    details.sort_unstable();
    assert_eq!(details, ["install_acl", "service_acl", "service_privileges", "state_acl"]);
    assert!(rig.audits.iter().all(|(kind, _)| *kind == AuditKind::DeviceTamperDetected));
    // Not counted a second time as plain drift.
    assert!(rig.shared.take_rewrites().is_empty());
    // The originals are still the values from before Rulebox.
    let after: Vec<OriginalValue> = Item::ALL.iter().map(|item| rig.entry(*item).unwrap().original).collect();
    assert_eq!(after, originals);

    // The same item again on the same server day: counted, not audited again.
    rig.platform.with_world(|w| w.services.get_mut(AGENT_SERVICE).unwrap().sddl = WEAK_SERVICE.into());
    rig.apply(true);
    let outcome = rig.pass(T0 + 20 * MIN);
    assert_eq!((outcome.repaired.clone(), outcome.audited), (vec![Item::ServiceAcl], 0));
    assert_eq!((rig.tamper_today(), rig.audits.len()), (5, 4));

    // The next server day: audited again, once.
    for n in 0..2 {
        rig.platform.with_world(|w| w.services.get_mut(AGENT_SERVICE).unwrap().sddl = WEAK_SERVICE.into());
        rig.apply(true);
        rig.pass(T0 + 25 * HOUR + n * MIN);
    }
    assert_eq!(rig.audits.len(), 5);
    assert_eq!(rig.tamper_today(), 2, "a new day's bucket");
}

#[test]
fn flags_windows_adds_and_the_order_of_privileges_are_not_tampering() {
    let mut rig = Rig::new();
    rig.apply(true);
    rig.pass(T0);
    let before = rig.mutating();
    rig.platform.with_world(|w| {
        // Windows hands the folder DACL back with `AI`, and the privileges in its own order.
        w.path_acls.insert(key(Path::new(INSTALL)), INSTALL_DIR_SDDL.replace("D:P", "D:PAI"));
        w.services.get_mut(AGENT_SERVICE).unwrap().privileges.reverse();
    });
    assert_eq!(rig.apply(true).state, LayerStatus::Ok);
    assert_eq!(rig.mutating(), before, "nothing is written");
    assert_eq!(rig.pass(T0 + 10 * MIN), TamperOutcome::default());
}

#[test]
fn a_repair_that_fails_is_a_partial_layer_and_is_not_counted() {
    let mut rig = Rig::new();
    rig.apply(true);
    rig.platform.with_world(|w| w.services.get_mut(AGENT_SERVICE).unwrap().sddl = WEAK_SERVICE.into());
    rig.platform.fail_next(SimOp::SetServiceSecurity, PlatformError::AccessDenied);
    let state = rig.apply(true);
    assert_eq!((state.state, state.detail.as_deref()), (LayerStatus::Partial, Some("access_denied")));
    assert_eq!(rig.pass(T0), TamperOutcome::default());
    assert_eq!(rig.report().service_acl, Some("drift"), "it does not hold");
    // The next pass gets through; the tampering is counted then.
    assert_eq!(rig.apply(true).state, LayerStatus::Ok);
    assert_eq!(rig.service_sddl(), AGENT_SERVICE_SDDL);
    assert_eq!(rig.pass(T0 + 10 * MIN).repaired, [Item::ServiceAcl]);
}

#[test]
fn an_unreadable_service_or_folder_is_reported_and_nothing_is_written() {
    let rig = Rig::new();
    rig.platform.fail_next(SimOp::GetServiceSecurity, PlatformError::AccessDenied);
    rig.platform.fail_next(SimOp::GetPathAcl, PlatformError::AccessDenied);
    let state = rig.apply(true);
    assert_eq!((state.state, state.detail.as_deref()), (LayerStatus::Partial, Some("service_unreadable")));
    assert!(rig.entry(Item::ServiceAcl).is_none() && rig.entry(Item::InstallAcl).is_none());
    assert!(rig.entry(Item::StateAcl).is_some(), "the other folder is still checked");
}

#[test]
fn without_a_service_or_folders_there_is_nothing_to_protect() {
    // The agent in a console (no service), folders unknown.
    let mut rig = Rig::new();
    rig.folders = None;
    rig.platform.with_world(|w| {
        w.services.remove(AGENT_SERVICE);
    });
    let state = rig.apply(true);
    assert_eq!((state.state, state.detail), (LayerStatus::Ok, None));
    assert_eq!(rig.mutating(), 0);
    assert!(rig.shared.get().journal.is_empty());

    // Folders known, but they do not exist (a dev checkout): skipped without a word.
    let rig = Rig::new();
    rig.platform.with_world(|w| w.path_acls.clear());
    let state = rig.apply(true);
    assert_eq!((state.state, state.detail), (LayerStatus::Ok, None));
    assert!(rig.entry(Item::InstallAcl).is_none() && rig.entry(Item::StateAcl).is_none());
    assert!(rig.entry(Item::ServiceAcl).is_some());
}

// ---------------------------------------------------------------- the rules

#[test]
fn a_privilege_list_without_change_notify_never_reaches_the_service() {
    let rig = Rig::new();
    let without: Vec<&str> =
        AGENT_REQUIRED_PRIVILEGES.iter().copied().filter(|name| *name != "SeChangeNotifyPrivilege").collect();
    // The seam refuses it ...
    let error = rig.platform.set_service_required_privileges(AGENT_SERVICE, &without).unwrap_err();
    assert!(matches!(&error, PlatformError::Other(text) if text.contains("would not start")), "{error:?}");
    // ... so a journal change with such a list fails and the service keeps what it had.
    let change = Change::service_privileges(JournalOwner::L7, AGENT_SERVICE, &without);
    assert!(journal::change(&rig.journal(), &change).is_err());
    assert!(rig.privileges().is_empty());
    // The list the agent uses has it.
    assert!(AGENT_REQUIRED_PRIVILEGES.contains(&"SeChangeNotifyPrivilege"));
}

#[test]
fn the_service_stays_stoppable_for_administrators() {
    let rig = Rig::new();
    // A DACL without full rights for Administrators is refused by the seam.
    let locked = "D:(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;SY)(A;;LC;;;BA)";
    let error = rig.platform.set_service_security(AGENT_SERVICE, locked).unwrap_err();
    assert!(matches!(&error, PlatformError::Other(text) if text.contains("Administrators")), "{error:?}");
    let change = Change::service_security(JournalOwner::L7, AGENT_SERVICE, locked);
    assert!(journal::change(&rig.journal(), &change).is_err());
    // The one Rulebox sets gives Administrators and SYSTEM every right and the rest status only.
    let aces: Vec<&str> = AGENT_SERVICE_SDDL.trim_start_matches("D:").split_inclusive(')').collect();
    assert_eq!(aces.len(), 4);
    assert!(aces[0].ends_with(";SY)") && aces[1].ends_with(";BA)") && aces[0].contains("WP") && aces[1].contains("WPDT"));
    assert_eq!(&aces[2..], ["(A;;LC;;;IU)", "(A;;LC;;;AU)"]);
}

#[test]
fn only_the_two_rulebox_folders_get_an_acl() {
    let mut rig = Rig::new();
    rig.folders = Some(RuleboxFolders { install_root: r"C:\Windows".into(), state_dir: r"C:\Users".into() });
    rig.platform.with_world(|w| {
        w.path_acls.insert(r"c:\windows".into(), INSTALL_ORIGINAL.into());
        w.path_acls.insert(r"c:\users".into(), INSTALL_ORIGINAL.into());
    });
    let state = rig.apply(true);
    assert_eq!(state.state, LayerStatus::Partial, "the seam refuses any other folder");
    assert_eq!(rig.acl(Path::new(r"C:\Windows")), INSTALL_ORIGINAL);
    assert_eq!(rig.acl(Path::new(r"C:\Users")), INSTALL_ORIGINAL);
}

// ---------------------------------------------------------------- the report

#[test]
fn the_report_says_ok_or_drift_and_counts_folder_repairs() {
    let mut rig = Rig::new();
    // Off: both fields stay out of the report.
    let report = rig.report();
    assert_eq!((report.service_acl, report.acl_drift), (None, None));
    let json = serde_json::to_value(&report).unwrap();
    assert!(json.get("serviceAcl").is_none() && json.get("aclDrift").is_none());

    rig.apply(true);
    rig.pass(T0);
    let report = rig.report();
    assert_eq!((report.service_acl, report.acl_drift), (Some("ok"), Some(0)));
    assert_eq!(serde_json::to_value(&report).unwrap()["serviceAcl"], "ok");

    // A folder ACL is repaired: counted; the service is still fine.
    rig.platform.with_world(|w| w.path_acls.insert(key(Path::new(INSTALL)), WEAK_FOLDER.into()));
    rig.apply(true);
    rig.pass(T0 + 10 * MIN);
    let report = rig.report();
    assert_eq!((report.service_acl, report.acl_drift), (Some("ok"), Some(1)));
    assert_eq!(serde_json::to_value(&report).unwrap()["aclDrift"], 1);

    // The service DACL is repaired: `drift` for that pass, `ok` after the next clean one.
    rig.platform.with_world(|w| w.services.get_mut(AGENT_SERVICE).unwrap().sddl = WEAK_SERVICE.into());
    assert_eq!(rig.report().service_acl, Some("drift"), "it does not hold right now");
    rig.apply(true);
    rig.pass(T0 + 20 * MIN);
    assert_eq!(rig.report().service_acl, Some("drift"));
    rig.apply(true);
    rig.pass(T0 + 30 * MIN);
    let report = rig.report();
    assert_eq!((report.service_acl, report.acl_drift), (Some("ok"), Some(1)));
}

// ---------------------------------------------------------------- the clock

fn boot_at(uptime_ms: u64) -> BootIdentity {
    BootIdentity { boot_id: Some(41), uptime_ms, boot_time_ms: 0 }
}

#[test]
fn a_clock_that_runs_with_the_tick_count_is_not_a_jump() {
    let mut watch = ClockWatch::new();
    assert_eq!(watch.observe(T0, &boot_at(5_000), T0), None, "the first look only sets the base");
    for n in 1..=200u64 {
        // A little off each time (clock corrections), never ten minutes.
        let wall = T0 + n * 10 * MIN + (n % 7) * 1_000;
        assert_eq!(watch.observe(wall, &boot_at(5_000 + n * 10 * MIN), wall), None, "{n}");
    }
    // Exactly ten minutes is not "more than ten minutes".
    let mut watch = ClockWatch::new();
    watch.observe(T0, &boot_at(0), T0);
    assert_eq!(watch.observe(T0 + MIN + CLOCK_JUMP_MS, &boot_at(MIN), T0), None);
}

#[test]
fn a_jump_forward_is_found_once() {
    let mut watch = ClockWatch::new();
    watch.observe(T0, &boot_at(0), T0);
    // One minute passed; the clock says 12 minutes.
    let jump = watch.observe(T0 + 12 * MIN, &boot_at(MIN), T0).unwrap();
    assert_eq!((jump.delta_ms, jump.raise_floor_to, jump.code()), (11 * MIN as i64, None, "forward"));
    // The new time is the base now: not found again.
    assert_eq!(watch.observe(T0 + 13 * MIN, &boot_at(2 * MIN), T0 + 12 * MIN), None);
}

#[test]
fn a_jump_back_is_found_once_and_says_where_the_floor_belongs() {
    let mut watch = ClockWatch::new();
    watch.observe(T0, &boot_at(0), T0);
    // Five minutes passed; the clock was set back two days.
    let wall = T0 + 5 * MIN - 48 * HOUR;
    let jump = watch.observe(wall, &boot_at(5 * MIN), T0 + 4 * MIN).unwrap();
    assert_eq!(jump.code(), "back");
    assert_eq!(jump.delta_ms, -((48 * HOUR) as i64));
    // The floor as it was at the base plus the five minutes that passed.
    assert_eq!(jump.raise_floor_to, Some(T0 + 5 * MIN));
    assert_eq!(watch.observe(wall + MIN, &boot_at(6 * MIN), T0 + 5 * MIN), None);
}

#[test]
fn small_steps_back_add_up_to_a_jump() {
    // Nine minutes back every nine minutes: the clock never moves, the tick count does.
    let mut watch = ClockWatch::new();
    watch.observe(T0, &boot_at(0), T0);
    assert_eq!(watch.observe(T0, &boot_at(9 * MIN), T0), None, "9 minutes behind");
    let jump = watch.observe(T0, &boot_at(18 * MIN), T0).unwrap();
    assert_eq!((jump.delta_ms, jump.raise_floor_to), (-((18 * MIN) as i64), Some(T0 + 18 * MIN)));
    // It goes on: the floor keeps following the time that really passes.
    assert_eq!(watch.observe(T0, &boot_at(27 * MIN), T0 + 18 * MIN), None);
    let jump = watch.observe(T0, &boot_at(36 * MIN), T0 + 18 * MIN).unwrap();
    assert_eq!(jump.raise_floor_to, Some(T0 + 36 * MIN));
}

#[test]
fn another_boot_or_a_long_quiet_time_starts_the_comparison_again() {
    let mut watch = ClockWatch::new();
    watch.observe(T0, &boot_at(50 * MIN), T0);
    // Windows restarted: the tick count starts again; the clock may be anything.
    let restarted = BootIdentity { boot_id: Some(42), uptime_ms: MIN, boot_time_ms: 0 };
    assert_eq!(watch.observe(T0 + 30 * 24 * HOUR, &restarted, T0), None);
    // A tick count that went back without a new boot id (no boot id on this PC).
    let mut watch = ClockWatch::new();
    let no_id = |uptime_ms| BootIdentity { boot_id: None, uptime_ms, boot_time_ms: 0 };
    watch.observe(T0, &no_id(50 * MIN), T0);
    assert_eq!(watch.observe(T0 + 5 * HOUR, &no_id(MIN), T0), None);

    // Slow drift between the two clocks: 8 minutes a day never adds up, the base moves daily.
    let mut watch = ClockWatch::new();
    watch.observe(T0, &boot_at(0), T0);
    for day in 1..=5u64 {
        let wall = T0 + day * 24 * HOUR + day * 8 * MIN;
        assert_eq!(watch.observe(wall, &boot_at(day * 24 * HOUR), wall), None, "day {day}");
    }
}

#[test]
fn a_clock_set_back_is_audited_once_and_does_not_extend_the_offline_period() {
    let rig = Rig::new();
    let mut watch = ClockWatch::new();
    let mut audits: Vec<(AuditKind, String)> = Vec::new();
    rig.shared.note_wall_clock(T0, 0).unwrap();
    assert_eq!(note_clock(&mut watch, &rig.shared, T0, &boot_at(0), &mut |k, d| audits.push((k, d))), None);

    // Three hours later somebody sets the clock back three days.
    let wall = T0 + 3 * HOUR - 72 * HOUR;
    let jump = note_clock(&mut watch, &rig.shared, wall, &boot_at(3 * HOUR), &mut |k, d| audits.push((k, d))).unwrap();
    assert_eq!(jump.code(), "back");
    assert_eq!(audits, [(AuditKind::DeviceClockJump, "back".to_string())]);
    // The highest clock seen moved on by the three hours that really passed (and is saved).
    assert_eq!(rig.shared.last_wall_clock_ms(), T0 + 3 * HOUR);
    assert_eq!(rig.shared.get().last_wall_clock_ms, T0 + 3 * HOUR);

    // The same clock a minute later: no second record.
    assert_eq!(note_clock(&mut watch, &rig.shared, wall + MIN, &boot_at(3 * HOUR + MIN), &mut |k, d| audits.push((k, d))), None);
    assert_eq!(audits.len(), 1);

    // E-78: an offline sign-in that had two hours left at T0 is over, whatever the clock says.
    // (`employee_cache::is_expired` takes the larger of the device clock and the floor.)
    let (last_online, period) = (T0 - 22 * HOUR, 24 * HOUR);
    let expired = |now: u64, floor: u64| now.max(floor).saturating_sub(last_online) > period;
    assert!(!expired(T0, T0));
    assert!(expired(wall + MIN, rig.shared.last_wall_clock_ms()));
    assert!(!expired(wall + MIN, T0), "without the monotonic check the period would still run");

    // A jump forward is audited too; the floor is left to the normal clock keeping.
    let floor = rig.shared.last_wall_clock_ms();
    let forward = wall + 40 * MIN;
    note_clock(&mut watch, &rig.shared, forward, &boot_at(3 * HOUR + 2 * MIN), &mut |k, d| audits.push((k, d))).unwrap();
    assert_eq!(audits.last(), Some(&(AuditKind::DeviceClockJump, "forward".to_string())));
    assert_eq!(rig.shared.last_wall_clock_ms(), floor);
}
