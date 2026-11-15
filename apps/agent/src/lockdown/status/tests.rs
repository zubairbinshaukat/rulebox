//! Tests of `lockdown-status` (Phase 5 Step 20): expected against reported, the live checks, the
//! invariant self-check, the journal summary, and that it changes nothing.

use std::sync::Arc;

use serde_json::json;

use super::*;
use crate::lockdown::runtime::tests::{rig, wifi, Rig};
use crate::platform::Platform;

fn status_of(rig: &Rig) -> LockdownStatus {
    let platform: Arc<dyn Platform> = rig.sim.clone();
    let env = StatusEnv { platform, paths: &rig.paths, install: &rig.install, admin_signin_verified: true, now_ms: rig.now() };
    gather(&env, &read_state(&rig.paths).unwrap())
}

/// A lockdown whose every layer can be `ok` in the simulated PC (App Control policies are not
/// embedded in a test build, so that layer stays off).
fn green_doc() -> serde_json::Value {
    json!({
        "lockdown": { "appControl": { "mode": "off" }, "procWatch": { "mode": "enforce" }, "performance": { "kioskProfile": false } },
        "wifi": [wifi("w1", "Office")],
        "config": { "groupId": "g1", "version": 4, "ring": "early" }
    })
}

fn files_in(dir: &std::path::Path) -> Vec<(String, u64)> {
    let mut files: Vec<(String, u64)> = std::fs::read_dir(dir)
        .unwrap()
        .map(|entry| {
            let entry = entry.unwrap();
            (entry.file_name().to_string_lossy().into_owned(), entry.metadata().unwrap().len())
        })
        .collect();
    files.sort();
    files
}

#[test]
fn an_applied_lockdown_is_all_green_and_the_command_changes_nothing() {
    let rig = rig();
    rig.enable();
    rig.publish(7, green_doc());
    assert_eq!(rig.runtime.pass().refusal, None);

    let calls = rig.sim.calls().len();
    let files = files_in(&rig.paths.state_dir());
    let state = std::fs::read(rig.paths.agent_state()).unwrap();
    let status = status_of(&rig);
    assert!(status.all_green(), "{:#?}", status.problems);
    assert!(status.enrolled && status.kiosk_enabled);
    assert_eq!((status.document.version, status.document.verified, status.document.has_lockdown), (Some(7), true, true));
    assert_eq!(status.document.config.as_ref().map(|c| c.version), Some(4));
    assert_eq!(status.invariants, "ok");
    assert_eq!(status.layers.len(), 7);
    assert!(status.layers.iter().all(|line| line.ok && line.reported.is_some()));
    let proc_watch = status.layers.iter().find(|line| line.layer == "procWatch").unwrap();
    assert_eq!(proc_watch.expected, ReportedMode::Enforce);
    assert!(status.live.iter().any(|check| check.name == "wifi profile Rulebox-w1" && check.ok == Some(true)));
    assert!(status.live.iter().any(|check| check.name == "tamper: service_acl" && check.ok == Some(true)));
    assert_eq!(status.journal.entries, rig.journal_ids().len());
    assert_eq!((status.journal.pending, status.journal.restoring, status.journal.unknown_targets), (0, 0, 0));
    assert!(status.journal.by_owner.contains_key("L1 staff") && status.journal.by_owner.contains_key("kiosk"));
    assert_eq!(status.lkg.candidate_version, Some(7));
    assert_eq!(status.posture.as_ref().unwrap()["safeModeAgent"], true);

    // Read-only: no mutating platform call, no file made, changed or renamed.
    assert!(rig.sim.calls()[calls..].iter().all(|op| !op.is_mutating()), "{:?}", &rig.sim.calls()[calls..]);
    assert_eq!(files_in(&rig.paths.state_dir()), files);
    assert_eq!(std::fs::read(rig.paths.agent_state()).unwrap(), state);

    let mut text = Vec::new();
    print(&status, &mut text).unwrap();
    let text = String::from_utf8(text).unwrap();
    assert!(text.contains("Result: all green.") && text.contains("procWatch") && text.contains("invariants    : ok"), "{text}");
    assert!(!text.contains("pinHash") && !text.contains("sealed"));
    assert!(serde_json::to_value(&status).unwrap()["journal"]["byOwner"].is_object());
}

#[test]
fn what_is_missing_on_the_pc_or_was_refused_is_named() {
    let rig = rig();
    rig.enable();
    rig.publish(7, green_doc());
    rig.runtime.pass();
    // Somebody deleted the profile and loosened the service DACL.
    rig.sim.with_world(|w| {
        w.wlan_profiles.clear();
        w.services.get_mut("RuleboxAgent").unwrap().sddl = "D:(A;;GA;;;WD)".into();
    });
    let status = status_of(&rig);
    assert!(!status.all_green());
    assert!(status.problems.iter().any(|p| p.contains("wifi profile Rulebox-w1")), "{:?}", status.problems);
    assert!(status.problems.iter().any(|p| p.contains("tamper: service_acl")), "{:?}", status.problems);

    // A document the invariants refuse: the self-check says the code the service reported.
    rig.sim.with_world(|w| w.wlan_connected = Some("Cafe".into()));
    let mut doc = green_doc();
    doc["wifiManagedOnly"] = json!(true);
    rig.publish(8, doc);
    rig.runtime.pass();
    let status = status_of(&rig);
    assert_eq!(status.invariants, "would_disconnect");
    assert!(status.problems.iter().any(|p| p.contains("refused: would_disconnect")), "{:?}", status.problems);
    let mut text = Vec::new();
    print(&status, &mut text).unwrap();
    assert!(String::from_utf8(text).unwrap().contains("thing(s) to look at"));
}

#[test]
fn a_pc_without_a_kiosk_expects_every_layer_off() {
    let rig = rig();
    let status = status_of(&rig);
    assert!(status.all_green(), "{:?}", status.problems);
    assert!(!status.kiosk_enabled);
    assert_eq!(status.invariants, "not_checked");
    assert!(status.layers.iter().all(|line| line.expected == ReportedMode::Off && line.reported.is_none()));
    assert_eq!(status.journal, JournalSummary::default());
}
