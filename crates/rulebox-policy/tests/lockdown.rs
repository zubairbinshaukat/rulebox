//! Phase 5 Step 1: the agent-only keys (plan 4.3) through the public API only.
//! The vectors are `tests/vectors/lockdown.json` (hand-written shapes) and
//! `tests/vectors/seal.json` (written by `scripts/vectors/seal.mjs`).

#![allow(clippy::unwrap_used, clippy::expect_used)]

use rulebox_policy::lockdown::{
    ExceptionKind, ExceptionLayer, ExceptionRule, LayerMode, LimitError, LockdownPolicy, UsbStorageMode, UsbSwitch,
};
use rulebox_policy::network::{PrinterKind, PrinterSpec, WifiProfile, WifiSecurity};
use rulebox_policy::notice::{Broadcast, BroadcastStyle, DeviceLock};
use rulebox_policy::seal::{open_sealed, SealError, SealedBox};
use rulebox_policy::{AgentDoc, DesiredState};
use serde_json::{json, Value};

const NOW: u64 = 1_760_990_000_000;

fn read(name: &str) -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("vectors").join(name);
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// The Phase 4 document merged with every Phase 5 key.
fn full_doc() -> Value {
    let v = read("lockdown.json");
    let mut doc = v["phase4"].clone();
    for (key, value) in v["phase5Keys"].as_object().unwrap() {
        doc[key] = value.clone();
    }
    doc
}

#[test]
fn phase_4_document_means_no_phase_5_keys() {
    let v = read("lockdown.json");
    let agent = AgentDoc::from_doc(&v["phase4"]).unwrap();
    assert_eq!(agent, AgentDoc::default());
    assert!(agent.lockdown.is_none(), "absent lockdown = every layer off and restored");
    assert!(agent.wifi.is_empty() && agent.printers.is_empty() && agent.broadcasts.is_empty());
    assert!(!agent.wifi_managed_only);
    assert!(agent.device_lock.is_none() && agent.usb_temp_allow.is_none() && agent.config.is_none());
    assert_eq!(agent.check_limits(NOW), Ok(()));
}

#[test]
fn defaults_round_trip() {
    let agent = AgentDoc::default();
    let value = serde_json::to_value(&agent).unwrap();
    // The documented order of the keys (serde_json::Value sorts keys, so look at the text).
    let text = serde_json::to_string(&agent).unwrap();
    let order = ["lockdown", "wifi", "wifiManagedOnly", "printers", "deviceLock", "usbTempAllow", "broadcasts", "config"];
    let at: Vec<usize> = order.iter().map(|key| text.find(&format!("\"{key}\":")).unwrap()).collect();
    assert!(at.windows(2).all(|pair| pair[0] < pair[1]), "{text}");
    assert_eq!(value.as_object().unwrap().len(), order.len());
    assert_eq!(AgentDoc::from_doc(&value).unwrap(), agent);

    let policy = LockdownPolicy::default();
    let again: LockdownPolicy = serde_json::from_value(serde_json::to_value(&policy).unwrap()).unwrap();
    assert_eq!(again, policy);
}

#[test]
fn full_document_parses_and_serializes_back_exactly() {
    let v = read("lockdown.json");
    let agent = AgentDoc::from_doc(&full_doc()).unwrap();

    let lockdown = agent.lockdown.as_ref().unwrap();
    assert_eq!(lockdown.app_locker.mode, LayerMode::Enforce);
    assert_eq!(lockdown.usb.storage, UsbStorageMode::ReadOnly);
    assert_eq!(lockdown.usb.imaging, UsbSwitch::Block);
    assert!(lockdown.usb.retroactive);
    assert_eq!(lockdown.exceptions.len(), 3);
    assert_eq!(lockdown.exceptions[0].kind, ExceptionKind::Hash);
    assert_eq!(lockdown.exceptions[0].layers, vec![ExceptionLayer::AppLocker, ExceptionLayer::ProcWatch]);
    assert!(lockdown.exceptions.iter().all(|e| e.validate().is_ok()));
    assert_eq!(agent.wifi[0].security, WifiSecurity::Wpa2Personal);
    assert!(agent.wifi[0].sealed.is_some());
    assert!(agent.wifi_managed_only);
    assert_eq!(agent.printers[0].kind, PrinterKind::Ipp);
    assert_eq!(agent.broadcasts[0].style, BroadcastStyle::Banner);
    assert_eq!(agent.usb_temp_allow.unwrap().until_ms, 1_760_995_000_000);
    assert_eq!(agent.config.as_ref().unwrap().version, 14);
    assert_eq!(agent.check_limits(NOW), Ok(()));

    assert_eq!(serde_json::to_value(&agent).unwrap(), v["phase5Keys"]);
}

#[test]
fn desired_state_is_byte_for_byte_unchanged_by_the_phase_5_keys() {
    let v = read("lockdown.json");
    let expected = v["desiredStateJson"].as_str().unwrap();

    // The Phase 4 document: the Staff-visible part is exactly the Phase 2 part.
    let phase4: DesiredState = serde_json::from_value(v["phase4"].clone()).unwrap();
    assert_eq!(serde_json::to_string(&phase4).unwrap(), expected);

    // The same document with every Phase 5 key (the "unknown keys are ignored by the
    // Phase 4 parser" rule, pinned): same value, same bytes, no new field.
    let full: DesiredState = serde_json::from_value(full_doc()).unwrap();
    assert_eq!(full, phase4);
    assert_eq!(serde_json::to_string(&full).unwrap(), expected);
    let mut keys: Vec<String> = serde_json::to_value(&full).unwrap().as_object().unwrap().keys().cloned().collect();
    keys.sort();
    assert_eq!(keys, ["allowedSites", "apps", "branding", "fileHandlers", "kioskEnabled", "storage", "version"]);
}

#[test]
fn old_and_unknown_keys_are_ignored_by_the_phase_5_parser() {
    // `usbStorage` was the pre-2026-11-08 shape; it is gone, not translated.
    let mut doc = full_doc();
    doc["usbStorage"] = json!("block");
    doc["lockdown"]["usbStorage"] = json!("block");
    doc["aFutureKey"] = json!({ "x": 1 });
    let agent = AgentDoc::from_doc(&doc).unwrap();
    assert_eq!(agent.lockdown.unwrap().usb.storage, UsbStorageMode::ReadOnly);
}

#[test]
fn unknown_enum_values_become_unknown() {
    let doc = json!({
        "lockdown": { "appLocker": { "mode": "paranoid" }, "usb": { "storage": "encrypt", "phones": "maybe" } },
        "wifi": [{ "id": "w", "ssid": "x", "hidden": false, "security": "wpa9", "autoConnect": true, "revision": 1 }],
        "printers": [{ "id": "p", "name": "n", "kind": "pigeon", "address": "a", "driver": "d", "isDefault": false, "revision": 1 }],
        "broadcasts": [{ "id": "b", "style": "hologram", "title": "t", "body": "b", "ackRequired": false, "issuedAtMs": 1 }],
        "config": { "groupId": "g", "version": 1, "ring": "moon" }
    });
    let agent = AgentDoc::from_doc(&doc).unwrap();
    let lockdown = agent.lockdown.unwrap();
    assert_eq!(lockdown.app_locker.mode, LayerMode::Unknown);
    assert_eq!(lockdown.usb.storage, UsbStorageMode::Unknown);
    assert_eq!(lockdown.usb.phones, UsbSwitch::Unknown);
    // A sub-key that is missing is the default, not "unknown".
    assert_eq!(lockdown.usb.printers, UsbSwitch::Allow);
    assert_eq!(agent.wifi[0].security, WifiSecurity::Unknown);
    assert_eq!(agent.printers[0].kind, PrinterKind::Unknown);
    assert_eq!(agent.broadcasts[0].style, BroadcastStyle::Unknown);
    assert_eq!(serde_json::to_value(agent.config.unwrap().ring).unwrap(), "unknown");
}

fn wifi(i: usize) -> WifiProfile {
    WifiProfile {
        id: format!("w{i}"),
        ssid: format!("net{i}"),
        hidden: false,
        security: WifiSecurity::Wpa2Personal,
        auto_connect: true,
        revision: 1,
        sealed: None,
    }
}

fn printer(i: usize) -> PrinterSpec {
    PrinterSpec {
        id: format!("p{i}"),
        name: format!("printer {i}"),
        kind: PrinterKind::Ipp,
        address: "https://10.0.0.20:631/ipp/print".into(),
        port: None,
        queue: None,
        driver: "Microsoft IPP Class Driver".into(),
        is_default: false,
        revision: 1,
    }
}

fn broadcast(i: usize, expires: Option<u64>) -> Broadcast {
    Broadcast {
        id: format!("b{i}"),
        style: BroadcastStyle::Banner,
        title: "t".into(),
        body: "b".into(),
        expires_at_ms: expires,
        ack_required: false,
        issued_at_ms: 1,
    }
}

#[test]
fn limits_are_refused_just_above_the_edge() {
    let exception = |i: usize| ExceptionRule {
        id: format!("e{i}"),
        app_id: None,
        kind: ExceptionKind::Hash,
        publisher: None,
        sha256: Some("a".repeat(64)),
        path: None,
        layers: vec![ExceptionLayer::AppLocker],
    };
    let mut agent = AgentDoc {
        lockdown: Some(LockdownPolicy { exceptions: (0..200).map(exception).collect(), ..LockdownPolicy::default() }),
        wifi: (0..20).map(wifi).collect(),
        printers: (0..20).map(printer).collect(),
        broadcasts: (0..5).map(|i| broadcast(i, None)).collect(),
        device_lock: Some(DeviceLock { lock_id: "l".into(), message: "m".repeat(300), contact: None, locked_at_ms: 1 }),
        ..AgentDoc::default()
    };
    assert_eq!(agent.check_limits(NOW), Ok(()), "the worst case is accepted");

    agent.lockdown.as_mut().unwrap().exceptions.push(exception(200));
    assert_eq!(agent.check_limits(NOW), Err(LimitError::TooManyExceptions));
    agent.lockdown.as_mut().unwrap().exceptions.pop();

    agent.wifi.push(wifi(20));
    assert_eq!(agent.check_limits(NOW), Err(LimitError::TooManyWifi));
    agent.wifi.pop();

    agent.printers.push(printer(20));
    assert_eq!(agent.check_limits(NOW), Err(LimitError::TooManyPrinters));
    agent.printers.pop();

    agent.broadcasts.push(broadcast(5, None));
    assert_eq!(agent.check_limits(NOW), Err(LimitError::TooManyBroadcasts));
    // An expired broadcast that is still listed is not "active".
    agent.broadcasts.pop();
    agent.broadcasts.push(broadcast(5, Some(NOW - 1)));
    assert_eq!(agent.check_limits(NOW), Ok(()));
    agent.broadcasts.pop();

    agent.device_lock.as_mut().unwrap().message.push('x');
    assert_eq!(agent.check_limits(NOW), Err(LimitError::TextTooLong));
}

#[test]
fn a_worst_case_document_is_well_under_64_kb() {
    let rule = |i: usize| {
        json!({ "id": format!("ex_{i:04}"), "appId": null, "kind": "publisher",
                "publisher": { "subject": "C".repeat(200), "product": "P".repeat(100), "fileName": "F".repeat(100) },
                "sha256": null, "path": null, "layers": ["appLocker", "procWatch"] })
    };
    let mut doc = full_doc();
    doc["lockdown"]["exceptions"] = Value::Array((0..200).map(rule).collect());
    let agent = AgentDoc::from_doc(&doc).unwrap();
    assert_eq!(agent.check_limits(NOW), Ok(()));
    assert!(agent.lockdown.as_ref().unwrap().exceptions.iter().all(|e| e.validate().is_ok()));
    // 200 exceptions with maximum-length strings: bigger than the plan's "typical", still bounded.
    assert!(serde_json::to_vec(&doc).unwrap().len() < 128 * 1024);
}

// ---------------------------------------------------------------- sealed boxes

fn b64_32(value: &Value) -> [u8; 32] {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.decode(value.as_str().unwrap()).unwrap().try_into().unwrap()
}

#[test]
fn seal_vectors_open_and_a_box_for_another_device_does_not() {
    let v = read("seal.json");
    let secret = b64_32(&v["deviceSecret"]);
    for case in v["cases"].as_array().unwrap() {
        let sealed: SealedBox = serde_json::from_value(case["box"].clone()).unwrap();
        let (org, device, profile) =
            (case["orgId"].as_str().unwrap(), case["deviceId"].as_str().unwrap(), case["profileId"].as_str().unwrap());
        let opened = open_sealed(&sealed, &secret, org, device, profile).unwrap();
        assert_eq!(std::str::from_utf8(&opened).unwrap(), case["plaintext"].as_str().unwrap());
        // Same box, different deviceId: does not open.
        assert_eq!(open_sealed(&sealed, &secret, org, "dev_other", profile), Err(SealError::Open));
    }
    for case in v["negative"].as_array().unwrap() {
        let sealed: SealedBox = serde_json::from_value(case["box"].clone()).unwrap();
        let got = open_sealed(
            &sealed,
            &secret,
            case["orgId"].as_str().unwrap(),
            case["deviceId"].as_str().unwrap(),
            case["profileId"].as_str().unwrap(),
        );
        assert!(got.is_err(), "{} must not open", case["name"]);
    }
}
