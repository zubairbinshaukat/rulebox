//! Tests of the USB class tables and the generator (plan 4.7a, invariant I10). They
//! check **generated output** against a list of class GUIDs written out again here, so
//! a wrong GUID in `NEVER_BLOCK` or `USB_CLASSES` is caught by a second source.

use super::*;

/// Class GUIDs that must never be denied, typed out independently of `NEVER_BLOCK`.
pub const MUST_SURVIVE: &[(&str, &str)] = &[
    ("HIDClass", "745a17a0-74d3-11d0-b6fe-00a0c90f57da"),
    ("Keyboard", "4d36e96b-e325-11ce-bfc1-08002be10318"),
    ("Mouse", "4d36e96f-e325-11ce-bfc1-08002be10318"),
    ("USB (hubs, root hubs, composite parents)", "36fc9e60-c465-11cf-8056-444553540000"),
    ("Bluetooth", "e0cbf06c-cd8b-4647-bb8a-263b43f0f974"),
    ("System", "4d36e97d-e325-11ce-bfc1-08002be10318"),
    ("Display", "4d36e968-e325-11ce-bfc1-08002be10318"),
    ("Monitor", "4d36e96e-e325-11ce-bfc1-08002be10318"),
    ("Computer", "4d36e966-e325-11ce-bfc1-08002be10318"),
];

/// Compatible IDs of devices that must never be reached.
pub const MUST_SURVIVE_IDS: &[&str] = &[
    r"USB\Class_03",
    r"USB\Class_03&SubClass_01&Prot_01",
    r"USB\Class_03&SubClass_01&Prot_02",
    r"USB\CLASS_09",
    r"USB\Class_09&SubClass_00&Prot_01",
    r"USB\COMPOSITE",
    r"USB\ROOT_HUB",
    r"USB\ROOT_HUB20",
    r"USB\ROOT_HUB30",
    r"USB\USB20_HUB",
    r"USB\USB30_HUB",
    r"USB\Class_E0&SubClass_01&Prot_01",
    r"HID\VID_046D&PID_C52B",
    r"BTHENUM\{00001124-0000-1000-8000-00805f9b34fb}",
    r"BTH\MS_BTHBRB",
    r"ACPI\PNP0303",
    r"PCI\VEN_8086&DEV_9D2F",
];

fn guid_of(entry: &DenyClass) -> String {
    norm_guid(&entry.guid)
}

fn dev(guid: &str, ids: &[&str]) -> DeviceFunction {
    DeviceFunction { class_guid: format!("{{{}}}", guid.to_ascii_uppercase()), compatible_ids: ids.iter().map(|id| (*id).to_string()).collect() }
}

fn installed(id: &str, guid: &str, ids: &[&str], bus: DeviceBus) -> InstalledDevice {
    InstalledDevice {
        instance_id: id.to_string(),
        class_guid: guid.to_string(),
        compatible_ids: ids.iter().map(|id| (*id).to_string()).collect(),
        bus,
    }
}

const STORAGES: [UsbStorageMode; 4] = [UsbStorageMode::Allow, UsbStorageMode::ReadOnly, UsbStorageMode::Block, UsbStorageMode::Unknown];
const SWITCHES: [UsbSwitch; 3] = [UsbSwitch::Allow, UsbSwitch::Block, UsbSwitch::Unknown];

/// The five switches and `retroactive`, every combination (4 x 3^4 x 2 = 648).
pub fn all_policies() -> Vec<UsbPolicy> {
    let mut out = Vec::new();
    for storage in STORAGES {
        for printers in SWITCHES {
            for imaging in SWITCHES {
                for phones in SWITCHES {
                    for other in SWITCHES {
                        for retroactive in [false, true] {
                            out.push(UsbPolicy { storage, printers, imaging, phones, other, retroactive });
                        }
                    }
                }
            }
        }
    }
    out
}

fn everything_blocked(retroactive: bool) -> UsbPolicy {
    UsbPolicy {
        storage: UsbStorageMode::Block,
        printers: UsbSwitch::Block,
        imaging: UsbSwitch::Block,
        phones: UsbSwitch::Block,
        other: UsbSwitch::Block,
        retroactive,
    }
}

#[test]
fn the_never_block_const_names_every_class_of_the_owner_rule() {
    for (name, guid) in MUST_SURVIVE {
        assert!(NEVER_BLOCK.iter().any(|entry| entry.guid == Some(*guid)), "{name} is missing from NEVER_BLOCK");
        assert!(never_block_hit(guid, &[]).is_some(), "{name}");
        // Braces and capitals do not hide it.
        assert!(never_block_hit(&format!("{{{}}}", guid.to_ascii_uppercase()), &[]).is_some(), "{name}");
    }
    for id in MUST_SURVIVE_IDS {
        assert!(never_block_hit("00000000-0000-0000-0000-000000000000", &[(*id).to_string()]).is_some(), "{id}");
        assert!(never_block_hit("", &[id.to_ascii_lowercase()]).is_some(), "{id} in lower case");
    }
}

#[test]
fn no_usb_class_of_the_tables_is_a_never_block_class() {
    for (group, classes) in USB_CLASSES {
        assert!(!classes.is_empty(), "{group:?}");
        for class in *classes {
            let ids: Vec<String> = class.compatible_ids.iter().map(|id| (*id).to_string()).collect();
            assert_eq!(never_block_hit(class.guid, &ids).map(|hit| hit.name), None, "{}", class.name);
            for (name, guid) in MUST_SURVIVE {
                assert_ne!(norm_guid(class.guid), *guid, "{} equals {name}", class.name);
            }
            assert_eq!(class.guid, class.guid.to_ascii_lowercase());
        }
    }
    // Every group is in the table exactly once.
    for group in UsbGroup::ALL {
        assert_eq!(USB_CLASSES.iter().filter(|(g, _)| *g == group).count(), 1, "{group:?}");
    }
    for guid in STAFF_WPD_GUIDS {
        assert!(never_block_hit(guid, &[]).is_none());
    }
}

#[test]
fn every_usb_switch_combination_generates_tables_without_input_devices() {
    let policies = all_policies();
    assert_eq!(policies.len(), 648);
    for policy in &policies {
        let tables = generate(policy);
        assert_eq!(tables.input_device_conflicts(), Vec::<String>::new(), "{policy:?}");
        let guids = tables.all_guids();
        for (name, survivor) in MUST_SURVIVE {
            assert!(!guids.iter().any(|g| g == *survivor), "{name} is named by {policy:?}");
        }
        // Compatible IDs too.
        for class in tables.machine.iter() {
            for id in &class.compatible_ids {
                for forbidden in MUST_SURVIVE_IDS {
                    assert!(!compatible_ids_collide(id, forbidden), "{id} reaches {forbidden} via {policy:?}");
                }
            }
        }
        // Nothing is generated for a group that is allowed (and an unknown value is not a block).
        if !policy.restricts(UsbGroup::Printers) {
            assert!(tables.machine.iter().all(|c| c.group != UsbGroup::Printers), "{policy:?}");
        }
        // The retroactive list is a subset of the deny list, and empty without the flag.
        let retro = tables.retroactive_classes();
        assert!(retro.iter().all(|c| tables.machine.contains(c)));
        assert_eq!(retro.is_empty(), !policy.retroactive || tables.machine.iter().all(|c| !c.retroactive_ok), "{policy:?}");
    }
}

#[test]
fn the_tables_stay_clean_if_the_owner_moves_a_group_to_the_other_scope() {
    for scope in [UsbScope::Staff, UsbScope::Machine] {
        for policy in all_policies() {
            let tables = generate_with(&policy, |_| scope);
            assert!(tables.input_device_conflicts().is_empty(), "{scope:?} {policy:?}");
        }
    }
    // Machine scope for everything: storage and phones do get class entries.
    let tables = generate_with(&everything_blocked(true), |_| UsbScope::Machine);
    let names: Vec<&str> = tables.machine.iter().map(|c| c.name.as_str()).collect();
    assert!(names.contains(&"DiskDrive") && names.contains(&"WPD"));
    assert_eq!(tables.staff, StaffUsbRules::default());
    // ... but the disk classes are never removed retroactively (the system disk is one).
    let retro: Vec<&str> = tables.retroactive_classes().iter().map(|c| c.name.as_str()).collect();
    assert!(!retro.contains(&"DiskDrive") && !retro.contains(&"CDROM") && retro.contains(&"WPD"));
}

#[test]
fn the_real_scope_rule_is_staff_for_storage_and_phones_machine_for_the_rest() {
    let tables = generate(&everything_blocked(false));
    assert_eq!(tables.staff.storage, Some(StaffStorage::Block));
    assert_eq!(tables.staff.wpd_guids, STAFF_WPD_GUIDS.iter().map(|g| g.to_string()).collect::<Vec<_>>());
    let groups: Vec<UsbGroup> = tables.machine.iter().map(|c| c.group).collect();
    assert!(groups.iter().all(|g| matches!(g, UsbGroup::Printers | UsbGroup::Imaging | UsbGroup::Other)));
    for group in [UsbGroup::Printers, UsbGroup::Imaging, UsbGroup::Other] {
        assert!(groups.contains(&group), "{group:?}");
    }
    let read_only = generate(&UsbPolicy { storage: UsbStorageMode::ReadOnly, ..UsbPolicy::default() });
    assert_eq!(read_only.staff.storage, Some(StaffStorage::ReadOnly));
    assert!(read_only.machine.is_empty());
    assert_eq!(generate(&UsbPolicy::default()), DenyTables::default());
}

#[test]
fn blocking_other_names_the_fixed_list_and_never_hid_or_hubs() {
    let tables = generate(&UsbPolicy { other: UsbSwitch::Block, retroactive: true, ..UsbPolicy::default() });
    let mut names: Vec<&str> = tables.machine.iter().map(|c| c.name.as_str()).collect();
    names.sort_unstable();
    assert_eq!(names, vec!["1394", "Infrared", "Modem", "Ports"]);
    assert_eq!(tables.staff, StaffUsbRules::default());
    let guids: Vec<String> = tables.machine.iter().map(guid_of).collect();
    for (name, survivor) in MUST_SURVIVE {
        assert!(!guids.iter().any(|g| g == *survivor), "{name}");
    }
    // No network adapter class either (edge case 65): the document has no key for it.
    assert!(!guids.contains(&"4d36e972-e325-11ce-bfc1-08002be10318".to_string()));
    // Retroactive removal covers the same four classes and nothing else.
    let mut retro: Vec<&str> = tables.retroactive_classes().iter().map(|c| c.name.as_str()).collect();
    retro.sort_unstable();
    assert_eq!(retro, names);
}

#[test]
fn a_printer_only_group_keeps_printers_and_hid_and_blocks_storage_for_staff() {
    // printers allowed, storage blocked, everything else allowed; with and without retroactive.
    for retroactive in [false, true] {
        let policy = UsbPolicy { storage: UsbStorageMode::Block, retroactive, ..UsbPolicy::default() };
        let tables = generate(&policy);
        assert!(tables.machine.is_empty(), "storage is Staff-scope: no machine deny class");
        assert!(tables.retroactive_classes().is_empty());
        assert_eq!(tables.staff.storage, Some(StaffStorage::Block));

        let keyboard = dev("745a17a0-74d3-11d0-b6fe-00a0c90f57da", &[r"USB\Class_03&SubClass_01&Prot_01"]);
        let printer = dev("4d36e979-e325-11ce-bfc1-08002be10318", &[r"USB\Class_07"]);
        let stick = dev("4d36e967-e325-11ce-bfc1-08002be10318", &[r"USB\Class_08"]);
        let hub = dev("36fc9e60-c465-11cf-8056-444553540000", &[r"USB\CLASS_09"]);
        for allowed in [&keyboard, &printer, &hub] {
            assert!(!tables.blocks_machine(allowed) && !tables.blocks_for_staff(allowed), "{allowed:?}");
        }
        assert!(tables.blocks_for_staff(&stick), "a USB stick is not available to Staff");
    }
}

#[test]
fn a_composite_keyboard_with_a_card_reader_keeps_its_keyboard_function() {
    let parent = dev("36fc9e60-c465-11cf-8056-444553540000", &[r"USB\COMPOSITE"]);
    let keyboard = dev("745a17a0-74d3-11d0-b6fe-00a0c90f57da", &[r"USB\Class_03&SubClass_01&Prot_01"]);
    let reader = dev("4d36e967-e325-11ce-bfc1-08002be10318", &[r"USB\Class_08"]);
    let webcam = dev("ca3e7ab9-b4c3-4ae6-8251-579ef933890f", &[r"USB\Class_0E"]);
    let headset_audio = dev("4d36e96c-e325-11ce-bfc1-08002be10318", &[r"USB\Class_01"]);
    for retroactive in [false, true] {
        let tables = generate(&everything_blocked(retroactive));
        // The storage function is blocked (for Staff), the HID function and the parent are not.
        assert!(tables.blocks_for_staff(&reader));
        assert!(!tables.blocks_for_staff(&keyboard) && !tables.blocks_machine(&keyboard));
        assert!(!tables.blocks_machine(&parent) && !tables.blocks_for_staff(&parent));
        // A webcam with HID buttons: the camera function follows `imaging`, the buttons stay.
        assert!(tables.blocks_machine(&webcam));
        assert!(!tables.blocks_machine(&dev("745a17a0-74d3-11d0-b6fe-00a0c90f57da", &[r"USB\Class_03"])));
        // A headset keeps its audio.
        assert!(!tables.blocks_machine(&headset_audio) && !tables.blocks_for_staff(&headset_audio));
    }
}

#[test]
fn retroactive_removal_never_touches_hid_hubs_or_built_in_devices() {
    let devices = vec![
        installed("USB\\VID_1\\kbd", "{745A17A0-74D3-11D0-B6FE-00A0C90F57DA}", &[r"USB\Class_03&SubClass_01&Prot_01"], DeviceBus::Usb),
        installed("USB\\VID_1\\mouse", "{4D36E96F-E325-11CE-BFC1-08002BE10318}", &[], DeviceBus::Usb),
        installed("USB\\ROOT_HUB30\\1", "{36fc9e60-c465-11cf-8056-444553540000}", &[r"USB\ROOT_HUB30"], DeviceBus::Usb),
        installed("USB\\VID_2\\hub", "{36fc9e60-c465-11cf-8056-444553540000}", &[r"USB\Class_09"], DeviceBus::Usb),
        installed("USB\\VID_3\\combo", "{36fc9e60-c465-11cf-8056-444553540000}", &[r"USB\COMPOSITE"], DeviceBus::Usb),
        installed("BTHENUM\\kbd", "{745a17a0-74d3-11d0-b6fe-00a0c90f57da}", &[r"BTHENUM\GENERIC"], DeviceBus::Bluetooth),
        installed("ACPI\\PNP0303", "{4d36e96b-e325-11ce-bfc1-08002be10318}", &[r"ACPI\PNP0303"], DeviceBus::BuiltIn),
        // A built-in serial port is in a denied class but is not a USB device.
        installed("ACPI\\PNP0501", "{4d36e978-e325-11ce-bfc1-08002be10318}", &[], DeviceBus::BuiltIn),
        // A device that lies: a denied class but its compatible ID says keyboard.
        installed("USB\\VID_4\\liar", "{4d36e978-e325-11ce-bfc1-08002be10318}", &[r"USB\Class_03"], DeviceBus::Usb),
        // What may go.
        installed("USB\\VID_5\\printer", "{4d36e979-e325-11ce-bfc1-08002be10318}", &[r"USB\Class_07"], DeviceBus::Usb),
        installed("USB\\VID_6\\webcam", "{ca3e7ab9-b4c3-4ae6-8251-579ef933890f}", &[r"USB\Class_0E"], DeviceBus::Usb),
        installed("USB\\VID_7\\serial", "{4d36e978-e325-11ce-bfc1-08002be10318}", &[], DeviceBus::Usb),
        // The storage class is not a retroactive class at all.
        installed("USB\\VID_8\\stick", "{4d36e967-e325-11ce-bfc1-08002be10318}", &[r"USB\Class_08"], DeviceBus::Usb),
    ];
    let tables = generate(&everything_blocked(true));
    let ids: Vec<&str> = retroactive_targets(&tables, &devices).iter().map(|d| d.instance_id.as_str()).collect();
    assert_eq!(ids, vec!["USB\\VID_5\\printer", "USB\\VID_6\\webcam", "USB\\VID_7\\serial"]);

    // Without the flag nothing is removed; with machine scope for everything the disks stay.
    assert!(retroactive_targets(&generate(&everything_blocked(false)), &devices).is_empty());
    let machine = generate_with(&everything_blocked(true), |_| UsbScope::Machine);
    let ids: Vec<&str> = retroactive_targets(&machine, &devices).iter().map(|d| d.instance_id.as_str()).collect();
    assert!(!ids.contains(&"USB\\VID_8\\stick"));
    // No policy at all removes an input device.
    for policy in all_policies() {
        for scope in [UsbScope::Staff, UsbScope::Machine] {
            let tables = generate_with(&policy, |_| scope);
            for removed in retroactive_targets(&tables, &devices) {
                assert!(never_block_hit(&removed.class_guid, &removed.compatible_ids).is_none(), "{removed:?} via {policy:?}");
                assert_eq!(removed.bus, DeviceBus::Usb);
            }
        }
    }
}

fn hand_built(class_guid: &str, ids: &[&str], retroactive: bool) -> DenyTables {
    DenyTables {
        machine: vec![DenyClass {
            group: UsbGroup::Other,
            name: "hand-built".into(),
            guid: class_guid.to_string(),
            compatible_ids: ids.iter().map(|id| (*id).to_string()).collect(),
            retroactive_ok: true,
        }],
        staff: StaffUsbRules::default(),
        retroactive,
    }
}

#[test]
fn a_hand_built_deny_list_with_an_input_class_or_id_is_a_conflict() {
    for (name, guid) in MUST_SURVIVE {
        for retroactive in [false, true] {
            for spelling in [guid.to_string(), format!("{{{}}}", guid.to_ascii_uppercase())] {
                let tables = hand_built(&spelling, &[], retroactive);
                assert_eq!(tables.input_device_conflicts().len(), if retroactive { 2 } else { 1 }, "{name} {spelling}");
            }
        }
    }
    for id in MUST_SURVIVE_IDS.iter().chain([r"USB\"].iter()) {
        let tables = hand_built("00000000-0000-0000-0000-000000000000", &[*id], false);
        assert_eq!(tables.input_device_conflicts().len(), 1, "{id}");
        let broader = hand_built("00000000-0000-0000-0000-000000000000", &[id.to_ascii_lowercase().as_str()], true);
        assert!(!broader.input_device_conflicts().is_empty(), "{id}");
    }
    // A Staff-hive class subkey that is an input class.
    for (name, guid) in MUST_SURVIVE {
        let tables = DenyTables {
            staff: StaffUsbRules { storage: None, wpd_guids: vec![format!("{{{}}}", guid.to_ascii_uppercase())] },
            ..DenyTables::default()
        };
        assert_eq!(tables.input_device_conflicts().len(), 1, "{name}");
    }
    // A retroactive-only entry is found even if the machine list is clean (they are one list here,
    // so build the case by turning the flag on for a class that is clean only without it).
    assert!(hand_built("6bdd1fc6-810f-11d0-bec7-08002be2092f", &[r"USB\Class_06"], true).input_device_conflicts().is_empty());
}

#[test]
fn compatible_id_matching_is_by_whole_component() {
    assert!(compatible_ids_collide(r"USB\Class_03", r"USB\Class_03&SubClass_01&Prot_01"));
    assert!(compatible_ids_collide(r"usb\class_03&subclass_01", r"USB\CLASS_03"));
    assert!(compatible_ids_collide(r"HID\", r"HID\VID_1&PID_2"));
    assert!(compatible_ids_collide(r"USB\", r"USB\Class_08"), "the whole enumerator covers everything below it");
    assert!(!compatible_ids_collide(r"USB\Class_0", r"USB\Class_08"));
    assert!(!compatible_ids_collide(r"USB\Class_08", r"USB\Class_09"));
    assert!(!compatible_ids_collide(r"USB\Class_07", r"USB\Class_0E"));
    assert!(!compatible_ids_collide("", r"USB\Class_09"));
}
