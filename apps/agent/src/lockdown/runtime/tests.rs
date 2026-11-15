//! Tests of the lockdown runtime (Phase 5 Step 20): the full cycle enable -> enforce -> disable
//! against `SimPlatform` (deep compare), and every piece the earlier steps left unwired.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use serde_json::json;

use super::*;
use crate::agent::{initial_snapshot, AgentConfig, CachedDesired};
use crate::agent_policy::AgentPolicy;
use crate::audit::AuditQueue;
use crate::backend::reports::LockdownCall;
use crate::kiosk::{EnableOptions, Kiosk};
use crate::lockdown::lkg::{CRASH_WATCH_MS, EXPECTED_EXIT_MS};
use crate::lockdown::reporting::LockdownOutbox;
use crate::notice::DenialSink;
use crate::platform::sim::{sim_path_roots, SimOp, SimPlatform};
use crate::platform::PlatformError;
use crate::state::{Enrollment, StateStore};
use crate::testutil::signing::{envelope, test_key, trusted_of};
use crate::testutil::TempDir;

const ORG: &str = "org-1";
const DEVICE: &str = "dev-1";
const T0: u64 = 1_800_000_000_000;
const PCL: &str = "Microsoft PCL6 Class Driver";

pub(in crate::lockdown) struct Rig {
    _dir: TempDir,
    pub sim: Arc<SimPlatform>,
    pub shared: Arc<SharedState>,
    pub paths: DataPaths,
    pub install: InstallPaths,
    pub runtime: Arc<LockdownRuntime>,
    pub audit: Arc<AuditHandle>,
    pub report: Arc<ReportQueue>,
    pub clock: Arc<AtomicU64>,
}

pub(in crate::lockdown) fn rig() -> Rig {
    let dir = TempDir::new();
    let paths = DataPaths::new(dir.path().to_path_buf());
    let install = InstallPaths::new(PathBuf::from(sim_path_roots().program_files).join("Rulebox"));
    let sim = Arc::new(SimPlatform::new(dir.path().to_path_buf()));
    // The two Rulebox folders exist, with ACLs somebody else set.
    sim.with_world(|w| {
        for folder in [install.root().to_path_buf(), paths.state_dir()] {
            w.path_acls.insert(folder.to_string_lossy().to_ascii_lowercase(), "D:(A;OICI;FA;;;WD)".to_string());
        }
    });
    let state = AgentState {
        enrollment: Some(Enrollment {
            convex_url: "https://x.convex.cloud".into(),
            device_id: DEVICE.into(),
            org_id: ORG.into(),
            device_name: "Desk".into(),
            enrolled_at_ms: 1,
            revoked: false,
            allow_joined: false,
        }),
        trusted_keys: vec![trusted_of(&test_key())],
        ..AgentState::default()
    };
    let platform: Arc<dyn Platform> = sim.clone();
    let shared = SharedState::new(StateStore::open(&paths.state_dir()).unwrap(), state.clone(), Arc::clone(&platform));
    let clock = Arc::new(AtomicU64::new(T0));
    let now_ms: Arc<dyn Fn() -> u64 + Send + Sync> = {
        let clock = Arc::clone(&clock);
        Arc::new(move || clock.load(Ordering::SeqCst))
    };
    let (snapshot, snapshot_rx) =
        SnapshotHandle::new(initial_snapshot(&state, sim.as_ref(), &AgentConfig::default(), &AgentPolicy::default()));
    let audit = AuditHandle::new(AuditQueue::open(paths.audit_queue()).unwrap(), snapshot_rx, Arc::clone(&now_ms));
    let report = ReportQueue::new(Arc::clone(&audit));
    let runtime = LockdownRuntime::new(RuntimeDeps {
        platform,
        shared: Arc::clone(&shared),
        paths: paths.clone(),
        install: install.clone(),
        admin_signin_verified: true,
        reporter: LockdownReporter::new(LockdownOutbox::open(&paths).unwrap(), Arc::clone(&now_ms)),
        lkg: Arc::new(LkgMonitor::open_in(&paths).unwrap()),
        audit: Arc::clone(&audit),
        report: Arc::clone(&report),
        snapshot,
        now_ms,
        on_blocked: None,
    });
    Rig { _dir: dir, sim, shared, paths, install, runtime, audit, report, clock }
}

impl Rig {
    pub fn now(&self) -> u64 {
        self.clock.load(Ordering::SeqCst)
    }

    fn advance(&self, ms: u64) {
        self.clock.fetch_add(ms, Ordering::SeqCst);
    }

    fn kiosk(&self) -> Kiosk<'_> {
        static CONFIG: std::sync::OnceLock<AgentConfig> = std::sync::OnceLock::new();
        Kiosk {
            platform: self.sim.as_ref(),
            shared: self.shared.as_ref(),
            config: CONFIG.get_or_init(AgentConfig::default),
            install: &self.install,
        }
    }

    pub fn enable(&self) {
        self.kiosk().enable(EnableOptions::default()).unwrap();
    }

    /// A signed document becomes the cached one, as the backend task leaves it.
    pub fn publish(&self, version: u64, mut doc: serde_json::Value) {
        doc["version"] = json!(version);
        let signed = envelope(&test_key(), ORG, DEVICE, version, &doc);
        let bytes = serde_json::to_vec(&CachedDesired::from_envelope(&signed)).unwrap();
        std::fs::write(self.paths.desired_state(), bytes).unwrap();
    }

    fn last(&self) -> LastPass {
        LastPass::read(&self.paths).expect("a pass was recorded")
    }

    pub fn journal_ids(&self) -> Vec<String> {
        self.shared.read(|state| state.journal.iter().map(|entry| entry.id.clone()).collect())
    }
}

pub(in crate::lockdown) fn wifi(id: &str, ssid: &str) -> serde_json::Value {
    json!({ "id": id, "ssid": ssid, "hidden": false, "security": "open", "autoConnect": true, "revision": 1 })
}

fn printer(id: &str, driver: &str) -> serde_json::Value {
    json!({
        "id": id, "name": format!("Front {id}"), "kind": "raw", "address": "10.0.0.21", "port": null, "queue": null,
        "driver": driver, "isDefault": true, "revision": 1
    })
}

fn config(version: u64) -> serde_json::Value {
    json!({ "groupId": "g1", "version": version, "ring": "pilot" })
}

/// What the simulated PC looks like, without the Staff account and Rulebox's own files (the two
/// things Disable keeps, plan Step 21 run 8).
fn image(sim: &SimPlatform) -> BTreeMap<String, String> {
    sim.with_world(|w| {
        let mut out = BTreeMap::new();
        for (key, value) in &w.machine_values {
            out.insert(format!("hklm|{}|{}", key.path, key.name), format!("{value:?}"));
        }
        for (key, value) in &w.staff_values {
            out.insert(format!("staff|{key:?}"), format!("{value:?}"));
        }
        for (sid, (_, command)) in &w.staff_shell {
            if let Some(command) = command {
                out.insert(format!("shell|{sid}"), command.clone());
            }
        }
        for (key, value) in &w.staff_policies {
            out.insert(format!("staff-policy|{key:?}"), value.to_string());
        }
        for (name, value) in &w.lsa_secrets {
            out.insert(format!("lsa|{name}"), value.clone());
        }
        for (id, binary) in &w.ci_policies {
            out.insert(format!("ci|{id}"), binary.len().to_string());
        }
        out.insert("applocker".into(), format!("{:?} {:?}", w.applocker, w.applocker_policy.as_ref().map(|(xml, m)| (xml.len(), *m))));
        for (name, service) in &w.services {
            let mut privileges = service.privileges.clone();
            privileges.sort();
            out.insert(format!("service|{name}"), format!("{} {} {privileges:?}", service.start, service.sddl));
        }
        out.insert("lockout".into(), format!("{:?}", w.lockout));
        out.insert("wlan".into(), format!("{:?} {:?}", w.wlan_profiles.keys().collect::<Vec<_>>(), w.wlan_allowed));
        out.insert("printers".into(), format!("{:?}", w.printers));
        out.insert("printer-ports".into(), format!("{:?}", w.printer_ports));
        out.insert("printer-shares".into(), format!("{:?}", w.printer_shares));
        // An absent `recoveryenabled` means "Yes" to Windows, and that is what a restore writes
        // (the seam cannot delete a BCD element, Step 5): the two are the same machine.
        out.insert("bcd|recoveryenabled".into(), "Yes".into());
        for ((object, element), value) in &w.bcd {
            let key = if element.eq_ignore_ascii_case("recoveryenabled") { "bcd|recoveryenabled".to_string() } else { format!("bcd|{object}|{element}") };
            out.insert(key, value.clone());
        }
        for (path, sddl) in &w.path_acls {
            out.insert(format!("acl|{path}"), sddl.clone());
        }
        out
    })
}

#[test]
fn the_full_cycle_enable_enforce_disable_leaves_the_machine_as_it_was() {
    let rig = rig();
    let before = image(&rig.sim);
    rig.enable();

    // Audit first (the defaults), with a Wi-Fi profile, the permit list and a printer.
    rig.publish(
        1,
        json!({
            "lockdown": { "usb": { "storage": "block", "printers": "block" } },
            "wifi": [wifi("w1", "Office")], "wifiManagedOnly": true,
            "printers": [printer("p1", PCL)],
            "config": config(1)
        }),
    );
    let first = rig.runtime.pass();
    assert_eq!(first.refusal, None);
    assert!(rig.runtime.procwatch().running().is_some(), "L5 is wired: the watch runs");
    let audit_layers = rig.last().layers;
    assert_eq!(audit_layers.proc_watch.mode, ReportedMode::Audit);
    assert_eq!(audit_layers.app_locker.mode, ReportedMode::Audit);

    // Then enforce.
    rig.publish(
        2,
        json!({
            "lockdown": {
                "appLocker": { "mode": "enforce" }, "appControl": { "mode": "enforce" }, "procWatch": { "mode": "enforce" },
                "usb": { "storage": "block", "printers": "block" }
            },
            "wifi": [wifi("w1", "Office")], "wifiManagedOnly": true,
            "printers": [printer("p1", PCL)],
            "config": config(2)
        }),
    );
    let second = rig.runtime.pass();
    assert_eq!(second.refusal, None);
    let layers = rig.last().layers;
    assert_eq!(layers.proc_watch.mode, ReportedMode::Enforce);
    assert_eq!(layers.app_locker.mode, ReportedMode::Enforce);
    assert_eq!((layers.staff.mode, layers.machine.mode, layers.boot.mode), (ReportedMode::On, ReportedMode::On, ReportedMode::On));

    // Every kind of target is in the journal now.
    let ids = rig.journal_ids();
    for prefix in ["hklm:", "staff:", "safeboot:", "svc-start:", "svc-sec:", "svc-priv:", "path-acl:", "wlan:", "printer:", "printer-port:", "applocker:"] {
        assert!(ids.iter().any(|id| id.starts_with(prefix)), "no {prefix} entry in {ids:?}");
    }
    assert_ne!(image(&rig.sim), before, "the lockdown changed the machine");

    // Disable: the journal restores owner by owner, last written first; the runtime lets go.
    rig.kiosk().disable().unwrap();
    rig.runtime.on_disabled(false);
    assert!(rig.journal_ids().is_empty(), "nothing is left in the journal: {:?}", rig.journal_ids());
    assert!(rig.runtime.procwatch().running().is_none(), "the process watch stopped");
    assert!(rig.shared.read(|state| state.wlan_marks.is_empty() && state.printer_marks.is_empty() && state.applocker.is_none()));
    let after = image(&rig.sim);
    let differences: Vec<String> = before
        .keys()
        .chain(after.keys())
        .filter(|key| before.get(*key) != after.get(*key))
        .map(|key| format!("{key}: {:?} -> {:?}", before.get(key), after.get(key)))
        .collect();
    assert!(differences.is_empty(), "the machine is not as it was:\n{}", differences.join("\n"));
    // The report after Disable says every layer is off.
    assert_eq!(rig.last().layers, LayerStates::all_off());
    assert_eq!(rig.runtime.lkg().candidate_version(), None, "nothing stays on probation");
}

#[test]
fn a_document_without_a_lockdown_section_writes_nothing() {
    let rig = rig();
    rig.enable();
    let journal = rig.journal_ids();
    rig.publish(1, json!({ "kioskEnabled": true }));
    let pass = rig.runtime.pass();
    assert_eq!(pass.state, Some(ApplyState::Applied));
    assert_eq!(rig.journal_ids(), journal, "a Phase 4 document adds no journal entry");
    assert!(rig.runtime.procwatch().running().is_none());
    // It is the last-known-good at once: there is nothing to roll back to but "all off".
    assert_eq!(rig.runtime.lkg().lkg_version(), Some(1));
}

#[test]
fn an_admin_exit_is_not_a_crash_and_never_rolls_a_change_back() {
    let rig = rig();
    rig.enable();
    rig.publish(1, json!({ "lockdown": {}, "config": config(1) }));
    rig.runtime.pass();
    let lkg = Arc::clone(rig.runtime.lkg());
    assert_eq!(lkg.candidate_version(), Some(1));
    lkg.on_staff_session(true, rig.now());

    // Three deliberate exits in a row (the Staff App closes each time): no decision.
    for round in 0..3u64 {
        rig.runtime.expect_shell_exit();
        assert_eq!(lkg.on_shell_crash(rig.now() + round), None);
        // The session ends with the exit and comes back when Staff is signed in again.
        lkg.on_staff_session(false, rig.now() + round);
        lkg.on_staff_session(true, rig.now() + round);
    }
    assert_eq!(lkg.take_pending(), None, "a deliberate admin exit never triggers a rollback");
    assert_eq!(lkg.candidate_version(), Some(1));

    // The expectation ends by itself: a real crash loop long after an exit still counts.
    rig.runtime.expect_shell_exit();
    let later = rig.now() + EXPECTED_EXIT_MS + 1;
    assert_eq!(lkg.on_shell_crash(later), None);
    assert_eq!(lkg.on_shell_crash(later + 1), None);
    assert!(lkg.on_shell_crash(later + 2).is_some(), "three real crashes are a crash loop");
    assert!(lkg.take_pending().is_some());
}

#[test]
fn a_crash_loop_rolls_back_to_the_last_known_good_and_the_pass_reports_it() {
    let rig = rig();
    rig.enable();
    rig.publish(1, json!({ "lockdown": { "machine": { "hideSwitchUser": false } }, "config": config(1) }));
    rig.runtime.pass();
    let lkg = Arc::clone(rig.runtime.lkg());
    lkg.on_staff_session(true, rig.now());
    lkg.on_ui_alive(rig.now() + 1_000);
    rig.advance(CRASH_WATCH_MS + 1_000);
    assert!(matches!(rig.runtime.tick(), Some(LkgEvent::Promoted { version: 1 })));
    let entries_v1 = rig.journal_ids().len();

    rig.publish(2, json!({ "lockdown": { "machine": { "hideSwitchUser": true } }, "config": config(2) }));
    rig.runtime.pass();
    assert_eq!(lkg.candidate_version(), Some(2));
    assert!(rig.journal_ids().len() > entries_v1, "version 2 wrote something new");
    for n in 0..3 {
        lkg.on_shell_crash(rig.now() + n);
    }
    let reason = lkg.take_pending().expect("a crash loop was decided");
    let audits = rig.audit.queued();
    assert!(rig.runtime.roll_back(reason));
    assert_eq!(rig.audit.queued(), audits + 1, "device.lockdownRolledBack");
    assert!(!rig.runtime.roll_back(reason), "a second call has nothing to roll back");

    let pass = rig.runtime.pass();
    assert_eq!(pass.state, Some(ApplyState::RolledBack));
    let last = rig.last();
    assert_eq!((last.state, last.lkg_version), (ApplyState::RolledBack, Some(1)));
    assert_eq!(last.config.map(|c| c.version), Some(2), "the failed configuration is named");
    assert_eq!(rig.journal_ids().len(), entries_v1, "what version 2 wrote is gone");
    assert_eq!(lkg.refused().len(), 1);
    // The same document again changes nothing: the PC stays on the last-known-good lockdown.
    assert_eq!(rig.runtime.pass().state, Some(ApplyState::RolledBack));
    assert_eq!(lkg.candidate_version(), None);
}

#[test]
fn unenroll_forgets_the_denial_counters_the_reports_and_the_last_known_good() {
    let rig = rig();
    rig.enable();
    rig.publish(1, json!({ "lockdown": {}, "config": config(1) }));
    rig.runtime.pass();
    let reporter = Arc::clone(rig.runtime.reporter());
    DenialSink::add(reporter.as_ref(), "2027-01-15", "orders-web", "camera", 3);
    assert!(rig.paths.security_daily().is_file());
    assert!(rig.paths.apply_report().is_file() && rig.paths.lkg().is_file() && rig.paths.lockdown_last().is_file());
    assert!(reporter.with_outbox(|outbox| outbox.daily.today().is_some()));

    rig.kiosk().disable().unwrap();
    rig.runtime.on_disabled(true);
    assert!(reporter.with_outbox(|outbox| outbox.daily.today().is_none()), "the denial counters are gone");
    for file in [rig.paths.security_daily(), rig.paths.apply_report(), rig.paths.lkg(), rig.paths.lockdown_last()] {
        assert!(!file.exists(), "{} was left behind", file.display());
    }
    assert_eq!(reporter.with_outbox(|outbox| outbox.next_call(rig.now() + 86_400_000, None, true)), None);
    assert_eq!(rig.report.security(), None);
}

#[test]
fn a_temporary_usb_allow_names_its_end_and_the_blocks_come_back_after_it() {
    let rig = rig();
    rig.enable();
    let until = rig.now() + 3_600_000;
    let doc = json!({
        "lockdown": { "usb": { "storage": "block", "printers": "block", "imaging": "block" } },
        "usbTempAllow": { "untilMs": until }
    });
    rig.publish(1, doc);
    let pass = rig.runtime.pass();
    assert_eq!(pass.wake_at_ms, Some(until), "the reconciler's timer is the end of the allow");
    let lifted = rig.journal_ids().len();

    rig.advance(3_600_001);
    let pass = rig.runtime.pass();
    assert_eq!(pass.wake_at_ms, None, "no timer once the allow has ended");
    assert!(rig.journal_ids().len() > lifted, "the USB class blocks are written again");
}

#[test]
fn a_printer_waits_for_its_delivered_driver_and_is_created_when_it_lands() {
    let rig = rig();
    rig.enable();
    rig.publish(1, json!({ "printers": [printer("p9", "Acme Laser 3000")] }));
    rig.runtime.pass();
    let item = rig.last().printers.remove(0);
    assert_eq!((item.state.as_str(), item.detail.as_deref()), ("failed", Some("driver_missing")));
    assert!(!rig.journal_ids().iter().any(|id| id.starts_with("printer:")));

    // The install engine publishes the driver package; its hook triggers the next pass.
    rig.sim.with_world(|w| w.printer_drivers.push("Acme Laser 3000".into()));
    rig.runtime.pass();
    let item = rig.last().printers.remove(0);
    assert_eq!((item.state.as_str(), item.detail), ("applied", None));
    assert!(rig.journal_ids().iter().any(|id| id == "printer:p9"));
}

#[test]
fn the_sealing_key_is_made_once_and_registered_until_the_server_has_it() {
    let rig = rig();
    rig.enable();
    rig.publish(1, json!({}));
    rig.runtime.pass();
    let reporter = Arc::clone(rig.runtime.reporter());
    let call = reporter.with_outbox(|outbox| outbox.next_call(rig.now(), None, false)).expect("the key is due");
    let LockdownCall::RegisterSealKey { public_key } = &call else {
        panic!("the sealing key goes first, not {call:?}");
    };
    assert_eq!(public_key.len(), 44, "32 bytes in base64");
    assert_eq!(rig.shared.read(|state| state.seal_key_registered.clone()), None);

    // The server took it: the next pass records the key id and nothing is due any more.
    reporter.with_outbox(|outbox| outbox.delivered(&call, rig.now(), None));
    rig.runtime.pass();
    let registered = rig.shared.read(|state| state.seal_key_registered.clone()).expect("recorded");
    assert_eq!(registered.len(), 16);
    let next = reporter.with_outbox(|outbox| outbox.next_call(rig.now(), None, false));
    assert!(!matches!(next, Some(LockdownCall::RegisterSealKey { .. })), "registered once");
    // The private half never reaches the state file.
    let secret = rig.shared.secrets(|secrets| secrets.seal_secret.clone()).unwrap().unwrap();
    assert!(!std::fs::read_to_string(rig.paths.agent_state()).unwrap().contains(&secret));
}

#[test]
fn a_failed_permit_list_is_a_layer_code_and_a_failed_connection_marks_the_profile() {
    let rig = rig();
    rig.enable();
    // (App Control is off: its policies are not embedded in a test build.)
    rig.publish(1, json!({ "lockdown": { "appControl": { "mode": "off" } }, "wifi": [wifi("w1", "Office")], "wifiManagedOnly": true }));
    rig.sim.fail_next(SimOp::WlanSetFilters, PlatformError::AccessDenied);
    rig.runtime.pass();
    let last = rig.last();
    assert_eq!((last.layers.machine.state, last.layers.machine.detail.as_deref()), (LayerStatus::Partial, Some(WIFI_FILTERS_ERROR)));
    assert_eq!(last.state, ApplyState::Partial);
    assert_eq!(last.wifi[0].state, "applied");

    // The next pass sets the list; a connection attempt with the profile failed meanwhile.
    rig.sim.with_world(|w| w.wlan_connect_failures = vec!["Rulebox-w1".into()]);
    rig.runtime.pass();
    let last = rig.last();
    assert_eq!(last.layers.machine.detail, None);
    assert_eq!((last.wifi[0].state.as_str(), last.wifi[0].detail.as_deref()), ("failed", Some(CONNECT_FAILED)));
    assert_eq!(rig.sim.with_world(|w| w.wlan_allowed.clone()), ["Office"]);

    // It connected after all.
    rig.sim.with_world(|w| w.wlan_connect_failures.clear());
    rig.runtime.pass();
    assert_eq!((rig.last().wifi[0].state.as_str(), rig.last().wifi[0].detail.clone()), ("applied", None));
}

#[test]
fn managed_networks_only_is_refused_while_it_would_disconnect_until_the_admin_confirmed() {
    let rig = rig();
    rig.enable();
    rig.sim.with_world(|w| w.wlan_connected = Some("Cafe".into()));
    let doc = json!({ "lockdown": {}, "wifi": [wifi("w1", "Office")], "wifiManagedOnly": true });
    rig.publish(1, doc.clone());
    let audits = rig.audit.queued();
    let entries = rig.journal_ids();
    let pass = rig.runtime.pass();
    assert_eq!((pass.state, pass.refusal.as_deref()), (Some(ApplyState::Refused), Some("would_disconnect")));
    assert_eq!(rig.journal_ids(), entries, "a refusal writes nothing");
    assert_eq!(rig.audit.queued(), audits + 1, "device.lockdownRefused, once");
    rig.runtime.pass();
    assert_eq!(rig.audit.queued(), audits + 1, "the same refusal is not audited again");
    assert_eq!(rig.last().refusal.as_deref(), Some("would_disconnect"));

    // "I understand this PC will go offline until it sees a managed network."
    let mut confirmed = doc;
    confirmed["wifiManagedOnlyConfirmed"] = json!(true);
    rig.publish(2, confirmed);
    let pass = rig.runtime.pass();
    assert_eq!(pass.refusal, None);
    assert_eq!(rig.sim.with_world(|w| w.wlan_allowed.clone()), ["Office"]);
    // An empty list is still refused, confirmed or not.
    rig.publish(3, json!({ "lockdown": {}, "wifi": [], "wifiManagedOnly": true, "wifiManagedOnlyConfirmed": true }));
    assert_eq!(rig.runtime.pass().refusal.as_deref(), Some("managed_networks_empty"));
}

#[test]
fn a_changed_service_start_type_is_restart_pending_until_windows_started_again() {
    let rig = rig();
    rig.enable();
    assert_eq!(rig.report.restart_pending(), None);
    rig.publish(1, json!({ "lockdown": {} }));
    rig.runtime.pass();
    assert!(rig.journal_ids().iter().any(|id| id.starts_with("svc-start:")), "the kiosk profile disabled a service");
    assert_eq!(rig.last().layers.performance.state, LayerStatus::RestartPending);
    assert_eq!(rig.report.restart_pending(), Some(true));
    // The same boot: still pending, and nothing new is marked.
    rig.runtime.pass();
    assert_eq!(rig.report.restart_pending(), Some(true));

    // Windows restarted.
    rig.sim.with_world(|w| {
        w.boot_id = w.boot_id.map(|id| id + 1);
        w.uptime_ms = 60_000;
    });
    rig.runtime.pass();
    assert_eq!(rig.last().layers.performance.state, LayerStatus::Ok);
    assert_eq!(rig.report.restart_pending(), None);
    assert_eq!(rig.shared.read(|state| state.perf_restart), None);
}

#[test]
fn tampering_is_counted_audited_and_shown_in_the_posture_and_a_clock_jump_is_audited_once() {
    let rig = rig();
    rig.enable();
    rig.publish(1, json!({ "lockdown": {} }));
    rig.runtime.pass();
    let security = rig.report.security().expect("the posture is part of the status");
    assert_eq!(security["serviceAcl"], "ok");
    assert_eq!(security["aclDrift"], 0);
    assert_eq!(security["safeModeAgent"], true);
    assert_eq!(rig.report.capabilities(), Some(vec![CAPABILITY_LOCKDOWN.to_string()]));
    let reporter = Arc::clone(rig.runtime.reporter());
    assert_eq!(reporter.with_outbox(|outbox| outbox.daily.today().map(|day| day.tamper)).unwrap_or(0), 0);

    // An administrator loosens the service DACL and a folder ACL behind the agent's back.
    let state_key = rig.paths.state_dir().to_string_lossy().to_ascii_lowercase();
    rig.sim.with_world(|w| {
        w.services.get_mut("RuleboxAgent").unwrap().sddl = "D:(A;;GA;;;WD)".into();
        w.path_acls.insert(state_key.clone(), "D:(A;OICI;FA;;;WD)".into());
    });
    let audits = rig.audit.queued();
    rig.runtime.pass();
    assert_eq!(reporter.with_outbox(|outbox| outbox.daily.today().map(|day| day.tamper)), Some(2));
    assert_eq!(rig.audit.queued(), audits + 2, "device.tamperDetected, once per item per day");
    let security = rig.report.security().unwrap();
    assert_eq!((security["serviceAcl"].as_str(), security["aclDrift"].as_u64()), (Some("drift"), Some(1)));
    // Put back: the next quiet pass says ok again and counts nothing.
    rig.runtime.pass();
    assert_eq!(rig.report.security().unwrap()["serviceAcl"], "ok");
    assert_eq!(reporter.with_outbox(|outbox| outbox.daily.today().map(|day| day.tamper)), Some(2));

    // The clock: the first look sets the base, an hour forward with no time passed is a jump.
    let audits = rig.audit.queued();
    rig.runtime.note_clock();
    rig.advance(3_600_000);
    rig.runtime.note_clock();
    assert_eq!(rig.audit.queued(), audits + 1, "device.clockJump");
    rig.runtime.note_clock();
    assert_eq!(rig.audit.queued(), audits + 1, "the same jump is found once");
}

#[test]
fn a_revoked_or_unenrolled_pc_and_a_missing_document_are_left_alone() {
    let rig = rig();
    rig.enable();
    // No cached document: the enrollment default has no lockdown.
    assert_eq!(rig.runtime.pass(), PassResult::default());
    // A document that does not verify (another device's) is never applied.
    let doc = json!({ "lockdown": {}, "version": 1 });
    let foreign = envelope(&test_key(), ORG, "another-device", 1, &doc);
    std::fs::write(rig.paths.desired_state(), serde_json::to_vec(&CachedDesired::from_envelope(&foreign)).unwrap()).unwrap();
    let journal = rig.journal_ids();
    assert_eq!(rig.runtime.pass().state, None);
    assert_eq!(rig.journal_ids(), journal);
    // Not enrolled: nothing at all, not even a sealing key.
    rig.shared.update(|state| state.enrollment = None).unwrap();
    assert_eq!(rig.runtime.pass(), PassResult::default());
}
