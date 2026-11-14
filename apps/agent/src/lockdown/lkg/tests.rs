//! Tests of the last-known-good store and the rollback (plan 4.11, Phase 5 Step 9): probation, the
//! 180 s window, crash loops, the Staff session rule, owner-scoped restore, the refused list.

use std::sync::Arc;

use rulebox_policy::lockdown::{LockdownPolicy, MachineRestrictions, Ring, UsbPolicy};
use rulebox_policy::AgentDoc;

use super::*;
use crate::lockdown::apply::ApplyCtx;
use crate::journal::JournalCtx;
use crate::lockdown::invariants::Facts;
use crate::platform::sim::SimPlatform;
use crate::platform::Platform;
use crate::state::{AgentState, SharedState, StateStore};
use crate::testutil::signing::{envelope, test_key, test_key_2, trusted_of};
use crate::testutil::TempDir;

const ORG: &str = "org-1";
const DEVICE: &str = "dev-1";
const T0: u64 = 1_800_000_000_000;
const SEC: u64 = 1_000;

struct Rig {
    dir: TempDir,
    platform: Arc<SimPlatform>,
    shared: Arc<SharedState>,
    monitor: LkgMonitor,
    trusted: Vec<TrustedKey>,
}

fn rig() -> Rig {
    let dir = TempDir::new();
    let platform = Arc::new(SimPlatform::new(dir.path().to_path_buf()));
    let dyn_platform: Arc<dyn Platform> = platform.clone();
    let shared = SharedState::new(StateStore::open(&dir.path().join("state")).unwrap(), AgentState::default(), dyn_platform);
    let monitor = LkgMonitor::open(dir.path().join("lkg.json")).unwrap();
    Rig { dir, platform, shared, monitor, trusted: vec![trusted_of(&test_key())] }
}

fn policy(hide_switch_user: bool, no_wake_password: bool) -> LockdownPolicy {
    LockdownPolicy {
        machine: MachineRestrictions {
            hide_switch_user,
            hide_sign_in_power: false,
            deny_elevation_requests: false,
            hide_admin_tiles: false,
            no_wake_password,
            restrict_printer_drivers: false,
            file_output_printers: false,
            account_lockout: None,
        },
        usb: UsbPolicy::default(),
        ..LockdownPolicy::default()
    }
}

fn doc(policy: Option<LockdownPolicy>) -> AgentDoc {
    AgentDoc { lockdown: policy, ..AgentDoc::default() }
}

fn config(version: u64) -> ConfigRef {
    ConfigRef { group_id: "g1".into(), version, ring: Ring::Pilot }
}

fn signed(version: u64, doc: &AgentDoc) -> SignedEnvelope {
    let mut json = serde_json::to_value(doc).unwrap();
    json["version"] = serde_json::json!(version);
    envelope(&test_key(), ORG, DEVICE, version, &json)
}

impl Rig {
    fn apply_ctx(&self, now_ms: u64, version: u64) -> ApplyCtx<'_> {
        ApplyCtx {
            journal: JournalCtx { platform: self.platform.as_ref(), shared: self.shared.as_ref() },
            facts: Facts { admin_signin_verified: true, ..Facts::default() },
            now_ms,
            version,
        }
    }

    /// The reconciler's part: apply, then tell the monitor.
    fn apply_doc(&self, version: u64, doc: &AgentDoc, now_ms: u64) {
        apply::apply(&self.apply_ctx(now_ms, version), doc).unwrap();
        self.monitor.on_applied(
            AppliedDoc { version, config: doc.config.clone(), has_lockdown: doc.lockdown.is_some(), envelope: signed(version, doc) },
            now_ms,
        );
    }

    fn journal_len(&self) -> usize {
        self.shared.read(|state| state.journal.len())
    }

    fn newest_entry_version(&self) -> u64 {
        self.shared.read(|state| state.journal.iter().map(|entry| entry.since_version).max().unwrap_or(0))
    }

    fn roll_back(&self, reason: RollbackReason, now_ms: u64) -> Option<RollbackOutcome> {
        let ctx = self.apply_ctx(now_ms, 0);
        roll_back(&self.monitor, &RollbackInputs { apply: &ctx, trusted: &self.trusted, org_id: ORG, device_id: DEVICE }, reason)
    }

    /// A version that is applied, proven healthy and past its watch: the LKG.
    fn make_lkg(&self, version: u64, doc: &AgentDoc, at: u64) -> u64 {
        self.apply_doc(version, doc, at);
        assert_eq!(self.monitor.on_ui_alive(at + 5 * SEC), None);
        let promoted_at = at + CRASH_WATCH_MS + SEC;
        assert_eq!(self.monitor.tick(promoted_at), Some(LkgEvent::Promoted { version }));
        promoted_at
    }
}

// ---------------------------------------------------------------- the probation

#[test]
fn a_healthy_shell_makes_the_candidate_the_lkg_after_the_watch() {
    let rig = rig();
    rig.monitor.on_staff_session(true, T0);
    rig.apply_doc(1, &doc(Some(policy(true, false))), T0);
    assert_eq!((rig.monitor.candidate_version(), rig.monitor.lkg_version()), (Some(1), None));
    assert_eq!(rig.monitor.on_ui_alive(T0 + 5 * SEC), None);
    // Still on probation: the crash watch is not over.
    assert_eq!(rig.monitor.tick(T0 + 60 * SEC), None);
    assert_eq!(rig.monitor.lkg_version(), None);
    assert_eq!(rig.monitor.tick(T0 + CRASH_WATCH_MS + SEC), Some(LkgEvent::Promoted { version: 1 }));
    assert_eq!((rig.monitor.candidate_version(), rig.monitor.lkg_version()), (None, Some(1)));
    assert_eq!(rig.monitor.next_deadline(), None, "no candidate, no timer");
}

#[test]
fn a_lockdown_change_followed_by_three_crashes_restores_the_lkg_and_reports_rolled_back() {
    let rig = rig();
    rig.monitor.on_staff_session(true, T0);
    let now = rig.make_lkg(1, &doc(Some(policy(true, false))), T0);
    let journal_at_lkg = rig.journal_len();
    assert!(journal_at_lkg > 0, "the first version wrote something");

    // Version 2 switches more on, and the Staff App starts to crash.
    let bad = AgentDoc { config: Some(config(7)), ..doc(Some(policy(true, true))) };
    rig.apply_doc(2, &bad, now);
    assert!(rig.journal_len() > journal_at_lkg);
    assert_eq!(rig.newest_entry_version(), 2);
    assert_eq!(rig.monitor.on_shell_crash(now + 10 * SEC), None);
    assert_eq!(rig.monitor.on_shell_crash(now + 20 * SEC), None);
    assert_eq!(rig.monitor.on_shell_crash(now + 30 * SEC), Some(LkgEvent::Rollback(RollbackReason::CrashLoop)));
    assert_eq!(rig.monitor.take_pending(), Some(RollbackReason::CrashLoop));

    let outcome = rig.roll_back(RollbackReason::CrashLoop, now + 31 * SEC).unwrap();
    assert_eq!((outcome.failed_version, outcome.lkg_version, outcome.reason), (2, Some(1), RollbackReason::CrashLoop));
    assert!(outcome.restored > 0 && outcome.restore_failed == 0);
    assert!(outcome.reapplied.is_ok());
    assert_eq!(rig.journal_len(), journal_at_lkg, "only what version 2 wrote went back");
    assert_eq!(rig.newest_entry_version(), 1);

    // The report: rolledBack, the failed configuration, the version the PC is on now.
    let report = outcome.report(Vec::new(), Vec::new(), Vec::new());
    assert_eq!((report.state, report.applied_version, report.lkg_version), (ApplyState::RolledBack, 1, Some(1)));
    assert_eq!(report.config, Some(config(7)));
    assert_eq!(outcome.audit_detail(), "crash_loop");
    let text = serde_json::to_string(&report).unwrap();
    assert!(!text.contains("SOFTWARE") && !text.contains('\\'), "no path in a report: {text}");

    // Refused locally; the next document of that configuration is not applied again.
    assert!(rig.monitor.is_refused(2, Some(&config(7))));
    assert!(!rig.monitor.is_refused(2, Some(&config(8))));
    assert!(!rig.monitor.is_refused(2, None), "a document version is refused only when it had no configuration");
    assert_eq!(rig.monitor.candidate_version(), None);
    assert!(rig.roll_back(RollbackReason::CrashLoop, now + 40 * SEC).is_none(), "a second call has nothing to do");
}

#[test]
fn without_an_lkg_everything_the_failed_version_wrote_goes_back() {
    let rig = rig();
    rig.monitor.on_staff_session(true, T0);
    rig.apply_doc(1, &doc(Some(policy(true, true))), T0);
    assert!(rig.journal_len() > 0);
    let outcome = rig.roll_back(RollbackReason::NoUiAlive, T0 + 200 * SEC).unwrap();
    assert_eq!((outcome.lkg_version, outcome.reapplied.clone()), (None, Ok(LayerStates::all_off())));
    assert_eq!(rig.journal_len(), 0);
    let report = outcome.report(Vec::new(), Vec::new(), Vec::new());
    assert_eq!((report.applied_version, report.lkg_version), (0, None));
    assert!(rig.monitor.is_refused(1, None));
}

#[test]
fn no_ui_alive_inside_the_window_while_a_session_is_active_rolls_back() {
    let rig = rig();
    rig.monitor.on_staff_session(true, T0);
    rig.apply_doc(1, &doc(Some(policy(true, false))), T0);
    assert_eq!(rig.monitor.next_deadline(), Some(T0 + LKG_HEALTH_WINDOW_MS + 1));
    assert_eq!(rig.monitor.tick(T0 + 179 * SEC), None);
    assert_eq!(rig.monitor.tick(T0 + 181 * SEC), Some(LkgEvent::Rollback(RollbackReason::NoUiAlive)));
    assert_eq!(rig.monitor.take_pending(), Some(RollbackReason::NoUiAlive));
}

#[test]
fn a_ui_alive_after_the_window_is_too_late() {
    let rig = rig();
    rig.monitor.on_staff_session(true, T0);
    rig.apply_doc(1, &doc(Some(policy(true, false))), T0);
    assert_eq!(rig.monitor.on_ui_alive(T0 + 200 * SEC), Some(LkgEvent::Rollback(RollbackReason::NoUiAlive)));
}

#[test]
fn no_staff_session_means_no_window_and_no_rollback() {
    let rig = rig();
    // Applied while nobody is signed in to Windows.
    rig.apply_doc(1, &doc(Some(policy(true, false))), T0);
    assert_eq!(rig.monitor.next_deadline(), None, "no window, no timer");
    assert_eq!(rig.monitor.tick(T0 + 3_600 * SEC), None);
    assert_eq!(rig.monitor.take_pending(), None);
    // The window starts at the next sign-in, and a heartbeat inside it is enough.
    let signed_in = T0 + 7_200 * SEC;
    rig.monitor.on_staff_session(true, signed_in);
    assert_eq!(rig.monitor.next_deadline(), Some(signed_in + LKG_HEALTH_WINDOW_MS + 1));
    assert_eq!(rig.monitor.on_ui_alive(signed_in + 12 * SEC), None);
    assert_eq!(rig.monitor.tick(signed_in + 400 * SEC), Some(LkgEvent::Promoted { version: 1 }));
}

#[test]
fn a_session_that_ends_mid_window_restarts_the_window_at_the_next_sign_in() {
    let rig = rig();
    rig.monitor.on_staff_session(true, T0);
    rig.apply_doc(1, &doc(Some(policy(true, false))), T0);
    rig.monitor.on_staff_session(false, T0 + 100 * SEC);
    assert_eq!(rig.monitor.tick(T0 + 400 * SEC), None, "nobody is signed in: nothing to judge");
    rig.monitor.on_staff_session(true, T0 + 500 * SEC);
    assert_eq!(rig.monitor.tick(T0 + 600 * SEC), None);
    assert_eq!(rig.monitor.tick(T0 + 681 * SEC), Some(LkgEvent::Rollback(RollbackReason::NoUiAlive)));
}

#[test]
fn crashes_count_only_inside_the_watch_and_the_window() {
    let rig = rig();
    rig.monitor.on_staff_session(true, T0);
    rig.apply_doc(1, &doc(Some(policy(true, false))), T0);
    rig.monitor.on_ui_alive(T0 + SEC);
    // Two crashes, then a long quiet stretch: the third is a fresh start, not a loop.
    assert_eq!(rig.monitor.on_shell_crash(T0 + 10 * SEC), None);
    assert_eq!(rig.monitor.on_shell_crash(T0 + 20 * SEC), None);
    assert_eq!(rig.monitor.on_shell_crash(T0 + 20 * SEC + CRASH_WINDOW_MS + SEC), None);
    // Past the watch of the candidate (5 minutes after the apply) crashes no longer judge it.
    let late = T0 + CRASH_WATCH_MS + 10 * SEC;
    for n in 0..5 {
        assert_eq!(rig.monitor.on_shell_crash(late + n * SEC), None);
    }
    // Crashes with no candidate on probation are nobody's business.
    assert_eq!(rig.monitor.tick(late + 10 * SEC), Some(LkgEvent::Promoted { version: 1 }));
    assert_eq!(rig.monitor.on_shell_crash(late + 20 * SEC), None);
}

#[test]
fn a_crash_loop_after_a_healthy_start_still_rolls_back_to_the_previous_lkg() {
    let rig = rig();
    rig.monitor.on_staff_session(true, T0);
    let now = rig.make_lkg(1, &doc(Some(policy(true, false))), T0);
    rig.apply_doc(2, &doc(Some(policy(true, true))), now);
    // Healthy at first ...
    rig.monitor.on_ui_alive(now + 5 * SEC);
    // ... then the loop starts inside the watch.
    for n in 0..2 {
        assert_eq!(rig.monitor.on_shell_crash(now + 60 * SEC + n * SEC), None);
    }
    assert_eq!(rig.monitor.on_shell_crash(now + 63 * SEC), Some(LkgEvent::Rollback(RollbackReason::CrashLoop)));
    assert_eq!(rig.monitor.lkg_version(), Some(1), "version 2 never became the LKG");
}

#[test]
fn a_document_without_a_lockdown_section_is_the_lkg_at_once() {
    let rig = rig();
    rig.monitor.on_staff_session(true, T0);
    rig.make_lkg(1, &doc(Some(policy(true, false))), T0);
    rig.apply_doc(2, &doc(None), T0 + 1_000 * SEC);
    assert_eq!((rig.monitor.candidate_version(), rig.monitor.lkg_version()), (None, Some(2)));
    assert_eq!(rig.monitor.next_deadline(), None);
}

#[test]
fn a_healthy_candidate_is_promoted_when_the_next_document_arrives_in_its_watch() {
    let rig = rig();
    rig.monitor.on_staff_session(true, T0);
    rig.apply_doc(1, &doc(Some(policy(true, false))), T0);
    rig.monitor.on_ui_alive(T0 + 5 * SEC);
    rig.apply_doc(2, &doc(Some(policy(true, true))), T0 + 60 * SEC);
    assert_eq!((rig.monitor.lkg_version(), rig.monitor.candidate_version()), (Some(1), Some(2)));
    // An unhealthy one that is replaced is not promoted.
    rig.apply_doc(3, &doc(Some(policy(false, true))), T0 + 90 * SEC);
    assert_eq!((rig.monitor.lkg_version(), rig.monitor.candidate_version()), (Some(1), Some(3)));
}

// ---------------------------------------------------------------- persistence and verification

#[test]
fn the_lkg_and_the_refused_list_survive_a_restart_and_are_verified_again() {
    let rig = rig();
    rig.monitor.on_staff_session(true, T0);
    let now = rig.make_lkg(1, &doc(Some(policy(true, false))), T0);
    rig.apply_doc(2, &AgentDoc { config: Some(config(7)), ..doc(Some(policy(true, true))) }, now);
    rig.monitor.on_shell_crash(now + SEC);
    rig.monitor.on_shell_crash(now + 2 * SEC);
    rig.monitor.on_shell_crash(now + 3 * SEC);
    rig.roll_back(RollbackReason::CrashLoop, now + 4 * SEC).unwrap();

    let again = LkgMonitor::open(rig.dir.path().join("lkg.json")).unwrap();
    assert_eq!(again.lkg_version(), Some(1));
    assert!(again.is_refused(2, Some(&config(7))));
    // With the keys the device trusts the copy verifies; with other keys it does not.
    assert!(again.lkg_doc(&rig.trusted, ORG, DEVICE).is_some());
    assert!(again.lkg_doc(&[trusted_of(&test_key_2())], ORG, DEVICE).is_none());
    assert!(again.lkg_doc(&rig.trusted, "org-2", DEVICE).is_none(), "another organization's copy is not ours");
    assert!(again.lkg_doc(&rig.trusted, ORG, "dev-2").is_none());
}

#[test]
fn an_lkg_that_no_longer_verifies_is_not_applied_and_says_why() {
    let rig = rig();
    rig.monitor.on_staff_session(true, T0);
    let now = rig.make_lkg(1, &doc(Some(policy(true, false))), T0);
    rig.apply_doc(2, &doc(Some(policy(true, true))), now);
    let ctx = rig.apply_ctx(now + 10 * SEC, 0);
    let other_keys = [trusted_of(&test_key_2())];
    let outcome = roll_back(
        &rig.monitor,
        &RollbackInputs { apply: &ctx, trusted: &other_keys, org_id: ORG, device_id: DEVICE },
        RollbackReason::NoUiAlive,
    )
    .unwrap();
    assert_eq!(outcome.reapplied, Err("lkg_unverifiable"));
    // What version 2 wrote still went back.
    assert_eq!(rig.newest_entry_version(), 1);
    let report = outcome.report(Vec::new(), Vec::new(), Vec::new());
    assert_eq!((report.state, report.refusal.as_deref()), (ApplyState::RolledBack, Some("lkg_unverifiable")));
}

#[test]
fn heartbeats_do_not_write_the_file_once_the_candidate_is_healthy() {
    let rig = rig();
    rig.monitor.on_staff_session(true, T0);
    rig.apply_doc(1, &doc(Some(policy(true, false))), T0);
    rig.monitor.on_ui_alive(T0 + 5 * SEC);
    let path = rig.dir.path().join("lkg.json");
    let before = (std::fs::read(&path).unwrap(), std::fs::metadata(&path).unwrap().modified().unwrap());
    std::thread::sleep(std::time::Duration::from_millis(30));
    for n in 0..20 {
        rig.monitor.on_ui_alive(T0 + (10 + n * 10) * SEC);
        rig.monitor.tick(T0 + (10 + n * 10) * SEC);
    }
    let after = (std::fs::read(&path).unwrap(), std::fs::metadata(&path).unwrap().modified().unwrap());
    assert_eq!(before, after, "twenty heartbeats, no write");
}

#[test]
fn the_watchdog_sink_feeds_the_same_decisions() {
    let rig = rig();
    let sink: &dyn ShellHealthSink = &rig.monitor;
    sink.staff_session(true, T0);
    rig.apply_doc(1, &doc(Some(policy(true, false))), T0);
    sink.shell_crashed(T0 + SEC);
    sink.shell_crashed(T0 + 2 * SEC);
    sink.shell_crashed(T0 + 3 * SEC);
    assert_eq!(rig.monitor.take_pending(), Some(RollbackReason::CrashLoop));
    // The heartbeat comes through the same trait.
    let other = self::rig();
    let sink: &dyn ShellHealthSink = &other.monitor;
    sink.staff_session(true, T0);
    other.apply_doc(1, &doc(Some(policy(true, false))), T0);
    sink.ui_alive(T0 + 10 * SEC);
    assert_eq!(other.monitor.tick(T0 + CRASH_WATCH_MS + SEC), Some(LkgEvent::Promoted { version: 1 }));
}

// ---------------------------------------------------------------- refused configurations

#[test]
fn a_refused_configuration_is_replaced_by_the_lkgs_but_locks_and_broadcasts_still_apply() {
    use rulebox_policy::notice::DeviceLock;
    let rig = rig();
    rig.monitor.on_staff_session(true, T0);
    let now = rig.make_lkg(1, &doc(Some(policy(true, false))), T0);
    rig.apply_doc(2, &AgentDoc { config: Some(config(7)), ..doc(Some(policy(true, true))) }, now);
    for n in 1..=3 {
        rig.monitor.on_shell_crash(now + n * SEC);
    }
    rig.roll_back(RollbackReason::CrashLoop, now + 4 * SEC).unwrap();

    // Version 3 carries the same configuration and a device lock.
    let lock = DeviceLock { lock_id: "lock-1".into(), message: "Locked".into(), contact: None, locked_at_ms: 5 };
    let incoming = AgentDoc { config: Some(config(7)), device_lock: Some(lock.clone()), ..doc(Some(policy(true, true))) };
    let safe = rig.monitor.without_refused(incoming.clone(), 3, &rig.trusted, ORG, DEVICE);
    assert_eq!(safe.lockdown, doc(Some(policy(true, false))).lockdown, "the LKG's lockdown section");
    assert_eq!(safe.device_lock, Some(lock), "the lock still applies");
    assert_eq!(safe.config, incoming.config);

    // A different configuration is not touched.
    let fresh = AgentDoc { config: Some(config(8)), ..doc(Some(policy(true, true))) };
    assert_eq!(rig.monitor.without_refused(fresh.clone(), 4, &rig.trusted, ORG, DEVICE), fresh);
}

#[test]
fn a_refused_configuration_without_an_lkg_means_every_layer_off() {
    let rig = rig();
    rig.monitor.on_staff_session(true, T0);
    rig.apply_doc(1, &AgentDoc { config: Some(config(7)), ..doc(Some(policy(true, true))) }, T0);
    rig.roll_back(RollbackReason::NoUiAlive, T0 + 200 * SEC).unwrap();
    let incoming = AgentDoc { config: Some(config(7)), ..doc(Some(policy(true, true))) };
    let safe = rig.monitor.without_refused(incoming, 2, &rig.trusted, ORG, DEVICE);
    assert_eq!(safe.lockdown, None);
    assert!(safe.wifi.is_empty() && safe.printers.is_empty());
}

#[test]
fn the_refused_list_is_bounded() {
    let rig = rig();
    for version in 1..=(MAX_REFUSED as u64 + 5) {
        rig.monitor.on_staff_session(true, T0);
        rig.apply_doc(version, &AgentDoc { config: Some(config(version)), ..doc(Some(policy(true, false))) }, T0 + version);
        rig.roll_back(RollbackReason::NoUiAlive, T0 + version + 1).unwrap();
    }
    let refused = rig.monitor.refused();
    assert_eq!(refused.len(), MAX_REFUSED);
    assert_eq!(refused.first().map(|r| r.version), Some(6), "the oldest went first");
}

#[test]
fn clear_forgets_everything() {
    let rig = rig();
    rig.monitor.on_staff_session(true, T0);
    rig.make_lkg(1, &doc(Some(policy(true, false))), T0);
    rig.monitor.clear().unwrap();
    assert_eq!(rig.monitor.lkg_version(), None);
    assert!(!rig.dir.path().join("lkg.json").exists());
}
