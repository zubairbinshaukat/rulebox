//! Tests of the safety invariants (plan 4.6): every refusal code is reachable, a
//! refusal writes nothing, and invariant I10 holds for every USB switch combination,
//! for hand-built deny lists and for retroactive removal. Owner rule 2026-11-08:
//! keyboards, mice, touchpads, touch screens, pens, wedge barcode scanners, USB hubs,
//! composite parents, Bluetooth input and built-in devices are never blocked.

use std::sync::Arc;

use rulebox_policy::lockdown::{LockdownPolicy, UsbPolicy, UsbStorageMode, UsbSwitch};
use rulebox_policy::AgentDoc;
use serde_json::json;

use super::*;
use crate::journal::{JournalCtx, JournalEntry, JournalTarget, OriginalValue};
use crate::lockdown::apply::{apply, ApplyCtx, ApplyRefusal};
use crate::lockdown::usb::tests::{all_policies, MUST_SURVIVE, MUST_SURVIVE_IDS};
use crate::lockdown::usb::{
    generate, retroactive_targets, DenyClass, DeviceBus, InstalledDevice, StaffUsbRules, STAFF_WPD_GUIDS,
};
use crate::platform::sim::SimPlatform;
use crate::platform::{Platform, RegValueRef, StaffUserSpec};
use crate::state::{AgentState, SharedState, StaffAccount, StateStore};
use crate::testutil::TempDir;
use rulebox_policy::lockdown::UsbGroup;

fn verified() -> Facts {
    Facts { admin_signin_verified: true, ..Facts::default() }
}

fn doc_with(lockdown: LockdownPolicy) -> AgentDoc {
    AgentDoc { lockdown: Some(lockdown), ..AgentDoc::default() }
}

fn usb_doc(usb: UsbPolicy) -> AgentDoc {
    doc_with(LockdownPolicy { usb, ..LockdownPolicy::default() })
}

fn json_doc(value: serde_json::Value) -> AgentDoc {
    AgentDoc::from_doc(&value).unwrap()
}

fn denying(guid: &str, ids: &[&str], retroactive: bool) -> DenyTables {
    DenyTables {
        machine: vec![DenyClass {
            group: UsbGroup::Other,
            name: "hand-built".into(),
            guid: guid.to_string(),
            compatible_ids: ids.iter().map(|id| (*id).to_string()).collect(),
            retroactive_ok: true,
        }],
        staff: StaffUsbRules::default(),
        retroactive,
    }
}

fn facts_with_usb(tables: DenyTables) -> Facts {
    Facts { generated: Generated { usb: Some(tables), ..Generated::default() }, ..verified() }
}

fn wifi(ssid: &str) -> serde_json::Value {
    json!({ "id": format!("w-{ssid}"), "ssid": ssid, "hidden": false, "security": "open", "autoConnect": true, "revision": 1 })
}

// -- the table of codes ----------------------------------------------------------------

#[test]
fn the_codes_are_the_ones_of_the_plan_and_each_names_its_invariant() {
    let codes: Vec<&str> = Refusal::ALL.iter().map(|r| r.code()).collect();
    assert_eq!(
        codes,
        vec![
            "would_block_rulebox",
            "would_block_exit",
            "managed_networks_empty",
            "would_disconnect",
            "would_block_admin",
            "admin_signin_unverified",
            "lockout_threshold_too_low",
            "journal_unknown_target",
            "would_block_input_device",
        ]
    );
    let mut unique = codes.clone();
    unique.sort_unstable();
    unique.dedup();
    assert_eq!(unique.len(), codes.len());
    assert_eq!(Refusal::WouldBlockInputDevice.invariant(), "I10");
    assert_eq!(Refusal::AdminSigninUnverified.invariant(), "I7");
    // I8 is the apply's own check; its code is the one the journal exports.
    assert_eq!(Refusal::JournalUnknownTarget.code(), crate::journal::JOURNAL_UNKNOWN_TARGET);
    assert_eq!(ApplyRefusal::JournalUnknownTarget.code(), Refusal::JournalUnknownTarget.code());
}

#[test]
fn a_quiet_document_passes_and_so_does_a_phase_4_document() {
    assert_eq!(validate(&AgentDoc::default(), &Facts::default()), Ok(()));
    assert_eq!(validate(&doc_with(LockdownPolicy::default()), &verified()), Ok(()));
}

// -- I1, I2 ---------------------------------------------------------------------------------

#[test]
fn a_rule_over_the_rulebox_folder_or_the_webview_runtime_is_refused() {
    let facts = |blocked: &str| Facts {
        protected_paths: vec![r"C:\Program Files\Rulebox".into(), r"C:\Program Files (x86)\Microsoft\EdgeWebView\Application".into()],
        generated: Generated { blocked_paths: vec![blocked.into()], ..Generated::default() },
        ..verified()
    };
    let doc = AgentDoc::default();
    for hit in [
        r"C:\Program Files\Rulebox",
        r"c:/program files/rulebox/",
        r"C:\Program Files",
        r"C:\Program Files\Rulebox\versions\1.2.3\rulebox-shell.exe",
        r"C:\Program Files (x86)\Microsoft\EdgeWebView\Application\msedgewebview2.exe",
        r"C:\Program Files (x86)\Microsoft\EdgeWebView",
    ] {
        assert_eq!(validate(&doc, &facts(hit)), Err(Refusal::WouldBlockRulebox), "{hit}");
    }
    for fine in [r"C:\Program Files\Other", r"C:\Program Files\RuleboxOther", r"C:\Users\Staff\Downloads", ""] {
        assert_eq!(validate(&doc, &facts(fine)), Ok(()), "{fine}");
    }
}

// -- I3, I4 ---------------------------------------------------------------------------------

#[test]
fn a_hook_or_winlogon_write_that_could_cost_the_exit_is_refused() {
    let doc = AgentDoc::default();
    let hotkeys = |keys: &[&str]| Facts {
        generated: Generated { hooked_hotkeys: keys.iter().map(|k| k.to_string()).collect(), ..Generated::default() },
        ..verified()
    };
    assert_eq!(validate(&doc, &hotkeys(&["Win+R", "Win+E", "win+d"])), Ok(()));
    for bad in ["Ctrl+Shift+Esc", "Alt+Tab", "Shift", "Ctrl+Alt+Del", "Ctrl+Win+Q"] {
        assert_eq!(validate(&doc, &hotkeys(&["Win+R", bad])), Err(Refusal::WouldBlockExit), "{bad}");
    }
    let winlogon = |names: &[&str]| Facts {
        generated: Generated { winlogon_writes: names.iter().map(|k| k.to_string()).collect(), ..Generated::default() },
        ..verified()
    };
    assert_eq!(validate(&doc, &winlogon(&["AutoAdminLogon", "DefaultUserName"])), Ok(()));
    for bad in ["Shell", "shell", "Userinit", "IgnoreShiftOverride", "ForceAutoLogon"] {
        assert_eq!(validate(&doc, &winlogon(&["AutoAdminLogon", bad])), Err(Refusal::WouldBlockExit), "{bad}");
    }
}

#[test]
fn the_staff_rows_themselves_never_touch_a_forbidden_winlogon_name() {
    for policy in all_policies().into_iter().take(40) {
        let doc = usb_doc(policy);
        assert_eq!(check_exit(&doc, &verified()), Ok(()));
    }
}

// -- I5 -------------------------------------------------------------------------------------

#[test]
fn wifi_managed_only_needs_a_managed_network_and_must_not_cut_the_current_link() {
    let empty = json_doc(json!({ "wifiManagedOnly": true }));
    assert_eq!(validate(&empty, &verified()), Err(Refusal::ManagedNetworksEmpty));

    let office = json_doc(json!({ "wifiManagedOnly": true, "wifi": [wifi("Office")] }));
    assert_eq!(validate(&office, &verified()), Ok(()));
    let on_office = Facts { current_ssid: Some("Office".into()), ..verified() };
    assert_eq!(validate(&office, &on_office), Ok(()));
    let on_cafe = Facts { current_ssid: Some("Cafe".into()), ..verified() };
    assert_eq!(validate(&office, &on_cafe), Err(Refusal::WouldDisconnect));

    // Not "managed only": nothing is checked.
    let open = json_doc(json!({ "wifi": [wifi("Office")] }));
    assert_eq!(validate(&open, &on_cafe), Ok(()));
}

// -- I6 -------------------------------------------------------------------------------------

#[test]
fn a_rule_set_that_would_block_administrators_is_refused() {
    let facts = Facts { generated: Generated { blocks_administrators: true, ..Generated::default() }, ..verified() };
    assert_eq!(validate(&AgentDoc::default(), &facts), Err(Refusal::WouldBlockAdmin));
}

// -- I7 -------------------------------------------------------------------------------------

#[test]
fn hide_admin_tiles_without_the_e_71_flag_is_no_refusal_and_the_lockout_threshold_is_at_least_5() {
    // Owner decision 2026-11-28: the document is not refused; the machine layer skips only that option
    // (`machine::tests::hiding_tiles_before_e_71_skips_only_that_option_and_reports_a_warning`).
    let hidden = doc_with(LockdownPolicy::default());
    assert!(hidden.lockdown.as_ref().unwrap().machine.hide_admin_tiles);
    assert_eq!(validate(&hidden, &Facts::default()), Ok(()));
    assert_eq!(validate(&hidden, &verified()), Ok(()));

    let shown = json_doc(json!({ "lockdown": { "machine": { "hideAdminTiles": false } } }));
    assert_eq!(validate(&shown, &Facts::default()), Ok(()), "tiles shown: nothing to verify");

    for (threshold, ok) in [(0, false), (1, false), (4, false), (5, true), (10, true)] {
        let doc = json_doc(json!({ "lockdown": { "machine": { "accountLockout": { "threshold": threshold, "durationMin": 15, "windowMin": 15 } } } }));
        let expected = if ok { Ok(()) } else { Err(Refusal::LockoutThresholdTooLow) };
        assert_eq!(validate(&doc, &verified()), expected, "threshold {threshold}");
    }
    // `null` leaves the machine's setting alone: nothing to refuse.
    let leave = json_doc(json!({ "lockdown": { "machine": { "accountLockout": null } } }));
    assert_eq!(validate(&leave, &verified()), Ok(()));
}

// -- a refusal writes nothing ------------------------------------------------------------------

struct Rig {
    _dir: TempDir,
    platform: Arc<SimPlatform>,
    shared: Arc<SharedState>,
    base_calls: usize,
}

impl Rig {
    fn new() -> Self {
        let dir = TempDir::new();
        let platform = Arc::new(SimPlatform::new(dir.path().to_path_buf()));
        let spec = StaffUserSpec { user_name: "RuleboxStaff".into(), full_name: "Staff".into(), comment: "c".into() };
        let sid = platform.create_staff_user(&spec, "pw").unwrap();
        let state = AgentState {
            staff: Some(StaffAccount { sid, user_name: "RuleboxStaff".into(), profile_dir: None }),
            ..AgentState::default()
        };
        let dyn_platform: Arc<dyn Platform> = platform.clone();
        let shared = SharedState::new(StateStore::open(&dir.path().join("state")).unwrap(), state, dyn_platform);
        let base_calls = platform.calls().iter().filter(|op| op.is_mutating()).count();
        Self { _dir: dir, platform, shared, base_calls }
    }

    fn ctx(&self, facts: Facts) -> ApplyCtx<'_> {
        ApplyCtx {
            journal: JournalCtx { platform: self.platform.as_ref(), shared: self.shared.as_ref() },
            facts,
            now_ms: 1_000,
            version: 3,
        }
    }

    fn mutating_calls(&self) -> usize {
        self.platform.calls().iter().filter(|op| op.is_mutating()).count() - self.base_calls
    }

    fn staff_values(&self) -> usize {
        self.platform.with_world(|w| w.staff_values.len())
    }
}

#[test]
fn a_refused_document_writes_nothing_and_keeps_the_previous_applied_state() {
    let rig = Rig::new();
    // A good document is applied first.
    let good = doc_with(LockdownPolicy::default());
    assert!(apply(&rig.ctx(verified()), &good).is_ok());
    let (values, journal, calls) = (rig.staff_values(), rig.shared.read(|s| s.journal.clone()), rig.mutating_calls());
    assert!(values > 10);

    // Every kind of refusal that apply can reach leaves all three exactly as they were.
    let wrong_exit = Facts { generated: Generated { hooked_hotkeys: vec!["Alt+F4".into()], ..Generated::default() }, ..verified() };
    let hand_built = facts_with_usb(denying("745a17a0-74d3-11d0-b6fe-00a0c90f57da", &[], false));
    let low_lockout = json_doc(json!({ "lockdown": { "machine": { "accountLockout": { "threshold": 2, "durationMin": 15, "windowMin": 15 } } } }));
    let cases = [
        (&low_lockout, verified(), "lockout_threshold_too_low"),
        (&good, wrong_exit, "would_block_exit"),
        (&good, hand_built, "would_block_input_device"),
        (&AgentDoc::default(), facts_with_usb(denying("36fc9e60-c465-11cf-8056-444553540000", &[], true)), "would_block_input_device"),
    ];
    for (doc, facts, code) in cases {
        let refusal = apply(&rig.ctx(facts), doc).unwrap_err();
        assert_eq!(refusal, ApplyRefusal::Refused(code));
        assert_eq!(refusal.code(), code);
        assert_eq!(rig.staff_values(), values);
        assert_eq!(rig.shared.read(|s| s.journal.clone()), journal);
        assert_eq!(rig.mutating_calls(), calls);
    }
}

#[test]
fn the_unknown_journal_target_refusal_comes_from_apply() {
    let rig = Rig::new();
    let mut entry = JournalEntry::machine(RegValueRef { path: r"SOFTWARE\X".into(), name: "Y".into() }, OriginalValue::Absent, 1);
    entry.target = JournalTarget::Unknown(json!({ "futureThing": {} }));
    rig.shared.update(|s| s.journal.push(entry)).unwrap();
    let refusal = apply(&rig.ctx(verified()), &doc_with(LockdownPolicy::default())).unwrap_err();
    assert_eq!(refusal.code(), Refusal::JournalUnknownTarget.code());
    assert_eq!(rig.mutating_calls(), 0);
}

// -- I10: generated output ---------------------------------------------------------------------

#[test]
fn i10_holds_for_every_combination_of_the_five_usb_switches_and_retroactive() {
    let policies = all_policies();
    assert_eq!(policies.len(), 648);
    for policy in policies {
        let doc = usb_doc(policy);
        assert_eq!(check_input_devices(&doc, &Facts::default()), Ok(()), "{policy:?}");
        assert_eq!(validate(&doc, &verified()), Ok(()), "{policy:?}");

        let tables = generate(&policy);
        assert!(tables.input_device_conflicts().is_empty(), "{policy:?}");
        let guids = tables.all_guids();
        for (name, survivor) in MUST_SURVIVE {
            assert!(!guids.iter().any(|g| g == *survivor), "{name} is denied by {policy:?}");
        }
        // The Staff-hive rows L1 would write for it stay out of the input classes as well.
        for row in crate::lockdown::staff::planned_rows(doc.lockdown.as_ref()) {
            assert!(
                !MUST_SURVIVE.iter().any(|(_, guid)| row.path.to_ascii_lowercase().contains(guid)),
                "{} names an input class",
                row.path
            );
        }
    }
}

#[test]
fn a_document_cannot_name_an_input_class_at_all() {
    // The usb object has these six keys and no others: there is nothing to switch.
    let keys: Vec<String> = serde_json::to_value(UsbPolicy::default()).unwrap().as_object().unwrap().keys().cloned().collect();
    assert_eq!(keys, vec!["storage", "printers", "imaging", "phones", "other", "retroactive"]);

    // A hostile document that tries anyway: the unknown keys are ignored and the generated
    // tables are the same as without them.
    let honest = json_doc(json!({ "lockdown": { "usb": { "other": "block", "retroactive": true } } }));
    let hostile = json_doc(json!({ "lockdown": { "usb": {
        "other": "block", "retroactive": true,
        "hid": "block", "keyboard": "block", "mouse": "block", "hubs": "block", "bluetooth": "block",
        "all": "block", "everything": "block", "unlisted": "block", "default": "deny", "catchAll": true,
        "classes": ["{745a17a0-74d3-11d0-b6fe-00a0c90f57da}", "{36fc9e60-c465-11cf-8056-444553540000}"],
        "denyClasses": ["{4d36e96b-e325-11ce-bfc1-08002be10318}"],
        "compatibleIds": ["USB\\Class_03", "USB\\COMPOSITE"],
        "retroactiveClasses": ["{745a17a0-74d3-11d0-b6fe-00a0c90f57da}"]
    } } }));
    assert_eq!(honest.lockdown, hostile.lockdown);
    assert_eq!(check_input_devices(&hostile, &Facts::default()), Ok(()));
    assert_eq!(generate(&hostile.lockdown.unwrap().usb), generate(&honest.lockdown.unwrap().usb));
}

#[test]
fn blocking_other_devices_does_not_include_hid_hubs_or_composite_parents() {
    for retroactive in [false, true] {
        let doc = usb_doc(UsbPolicy { other: UsbSwitch::Block, retroactive, ..UsbPolicy::default() });
        assert_eq!(validate(&doc, &verified()), Ok(()));
        let tables = generate(&doc.lockdown.as_ref().unwrap().usb);
        let mut names: Vec<&str> = tables.machine.iter().map(|c| c.name.as_str()).collect();
        names.sort_unstable();
        assert_eq!(names, vec!["1394", "Infrared", "Modem", "Ports"]);
        for class in &tables.machine {
            for (name, survivor) in MUST_SURVIVE {
                assert_ne!(norm_guid_of(class), *survivor, "{name} in `other`");
            }
            for id in &class.compatible_ids {
                for forbidden in MUST_SURVIVE_IDS {
                    assert!(!crate::lockdown::usb::compatible_ids_collide(id, forbidden), "{id} vs {forbidden}");
                }
            }
        }
    }
}

fn norm_guid_of(class: &DenyClass) -> String {
    crate::lockdown::usb::norm_guid(&class.guid)
}

#[test]
fn a_printer_only_group_keeps_hid_with_storage_blocked() {
    // printers allowed, storage blocked, nothing else restricted.
    for retroactive in [false, true] {
        let doc = usb_doc(UsbPolicy { storage: UsbStorageMode::Block, retroactive, ..UsbPolicy::default() });
        assert_eq!(validate(&doc, &verified()), Ok(()));
        let tables = generate(&doc.lockdown.as_ref().unwrap().usb);
        assert!(tables.machine.is_empty(), "no machine-wide class is denied");
        let rows: Vec<&str> =
            crate::lockdown::staff::planned_rows(doc.lockdown.as_ref()).iter().filter(|r| r.name.starts_with("Deny_")).map(|r| r.name).collect();
        assert_eq!(rows, vec!["Deny_All"], "only the Staff-hive storage policy");
    }
}

// -- I10: hand-built lists ------------------------------------------------------------------------

#[test]
fn a_hand_built_deny_list_naming_an_input_class_is_refused_before_any_write() {
    for (name, guid) in MUST_SURVIVE {
        for spelling in [guid.to_string(), format!("{{{}}}", guid.to_ascii_uppercase())] {
            for retroactive in [false, true] {
                // With a clean document, a document that restricts nothing, and none at all.
                for doc in [usb_doc(UsbPolicy::default()), usb_doc(UsbPolicy { other: UsbSwitch::Block, ..UsbPolicy::default() }), AgentDoc::default()] {
                    let facts = facts_with_usb(denying(&spelling, &[], retroactive));
                    assert_eq!(validate(&doc, &facts), Err(Refusal::WouldBlockInputDevice), "{name} {spelling}");
                }
            }
        }
    }
}

#[test]
fn a_hand_built_deny_list_naming_an_input_compatible_id_is_refused() {
    for id in MUST_SURVIVE_IDS.iter().chain([r"USB\"].iter()) {
        for retroactive in [false, true] {
            let facts = facts_with_usb(denying("00000000-0000-0000-0000-000000000000", &[*id], retroactive));
            assert_eq!(validate(&AgentDoc::default(), &facts), Err(Refusal::WouldBlockInputDevice), "{id}");
        }
    }
    // A clean list is accepted, so the refusals above are about the entries.
    let clean = facts_with_usb(denying("6bdd1fc6-810f-11d0-bec7-08002be2092f", &[r"USB\Class_06"], true));
    assert_eq!(validate(&AgentDoc::default(), &clean), Ok(()));
}

#[test]
fn an_input_class_hidden_in_the_staff_hive_list_or_added_to_a_generated_list_is_refused() {
    for (name, guid) in MUST_SURVIVE {
        let staff_list = DenyTables {
            staff: StaffUsbRules { storage: None, wpd_guids: vec![format!("{{{}}}", guid.to_ascii_uppercase())] },
            ..DenyTables::default()
        };
        assert_eq!(validate(&AgentDoc::default(), &facts_with_usb(staff_list)), Err(Refusal::WouldBlockInputDevice), "{name}");

        // The real generated list for "block everything" plus one extra class.
        let mut tables = generate(&UsbPolicy {
            storage: UsbStorageMode::Block,
            printers: UsbSwitch::Block,
            imaging: UsbSwitch::Block,
            phones: UsbSwitch::Block,
            other: UsbSwitch::Block,
            retroactive: true,
        });
        assert_eq!(validate(&AgentDoc::default(), &facts_with_usb(tables.clone())), Ok(()));
        tables.machine.push(denying(guid, &[], true).machine.remove(0));
        assert_eq!(validate(&AgentDoc::default(), &facts_with_usb(tables)), Err(Refusal::WouldBlockInputDevice), "{name}");
    }
    assert_eq!(STAFF_WPD_GUIDS.len(), 2);
}

// -- I10: retroactive removal ----------------------------------------------------------------------

#[test]
fn retroactive_removal_never_reaches_hid_hubs_composite_parents_bluetooth_or_built_in_devices() {
    let device = |id: &str, guid: &str, ids: &[&str], bus| InstalledDevice {
        instance_id: id.into(),
        class_guid: guid.into(),
        compatible_ids: ids.iter().map(|s| s.to_string()).collect(),
        bus,
    };
    let protected = vec![
        device("kbd", "{745a17a0-74d3-11d0-b6fe-00a0c90f57da}", &[r"USB\Class_03&SubClass_01&Prot_01"], DeviceBus::Usb),
        device("touch", "{745a17a0-74d3-11d0-b6fe-00a0c90f57da}", &[r"USB\Class_03"], DeviceBus::Usb),
        device("pen", "{745a17a0-74d3-11d0-b6fe-00a0c90f57da}", &[r"HID\VID_056A"], DeviceBus::Usb),
        device("wedge-scanner", "{745a17a0-74d3-11d0-b6fe-00a0c90f57da}", &[r"USB\Class_03&SubClass_01&Prot_01"], DeviceBus::Usb),
        device("mouse", "{4d36e96f-e325-11ce-bfc1-08002be10318}", &[], DeviceBus::Usb),
        device("hub", "{36fc9e60-c465-11cf-8056-444553540000}", &[r"USB\Class_09"], DeviceBus::Usb),
        device("root-hub", "{36fc9e60-c465-11cf-8056-444553540000}", &[r"USB\ROOT_HUB30"], DeviceBus::Usb),
        device("composite", "{36fc9e60-c465-11cf-8056-444553540000}", &[r"USB\COMPOSITE"], DeviceBus::Usb),
        device("bt-radio", "{e0cbf06c-cd8b-4647-bb8a-263b43f0f974}", &[r"USB\Class_E0"], DeviceBus::Usb),
        device("bt-mouse", "{4d36e96f-e325-11ce-bfc1-08002be10318}", &[r"BTHENUM\x"], DeviceBus::Bluetooth),
        device("internal-kbd", "{4d36e96b-e325-11ce-bfc1-08002be10318}", &[r"ACPI\PNP0303"], DeviceBus::BuiltIn),
        device("internal-display", "{4d36e968-e325-11ce-bfc1-08002be10318}", &[], DeviceBus::BuiltIn),
        // A device that claims a denied class while it is a keyboard by compatible ID.
        device("class-liar", "{4d36e978-e325-11ce-bfc1-08002be10318}", &[r"USB\Class_03"], DeviceBus::Usb),
    ];
    let mut devices = protected.clone();
    devices.push(device("printer", "{4d36e979-e325-11ce-bfc1-08002be10318}", &[r"USB\Class_07"], DeviceBus::Usb));
    devices.push(device("camera", "{ca3e7ab9-b4c3-4ae6-8251-579ef933890f}", &[r"USB\Class_0E"], DeviceBus::Usb));

    for policy in all_policies() {
        let tables = generate(&policy);
        let removed = retroactive_targets(&tables, &devices);
        for gone in &removed {
            assert!(!protected.iter().any(|p| p.instance_id == gone.instance_id), "{} removed by {policy:?}", gone.instance_id);
        }
        // Only a restricted printer or imaging group with the flag on removes anything.
        let expected = usize::from(policy.retroactive && policy.printers == UsbSwitch::Block)
            + usize::from(policy.retroactive && policy.imaging == UsbSwitch::Block);
        assert_eq!(removed.len(), expected, "{policy:?}");
    }
}
