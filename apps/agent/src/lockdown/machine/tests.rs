//! Tests of L2 (plan Step 5): every item journalled and restored exactly; the account
//! lockout; admin tiles found by SID; the device-class rules written only from the
//! generated tables, never HID or hubs; the temporary allow ending on time. All against
//! `SimPlatform`; nothing touches the machine.

use std::sync::Arc;

use rulebox_policy::lockdown::{
    AccountLockout, LockdownPolicy, MachineRestrictions, UsbGroup, UsbPolicy, UsbScope, UsbStorageMode, UsbSwitch, UsbTempAllow,
};
use rulebox_policy::AgentDoc;
use rulebox_win32::machinereg;
use rulebox_win32::registry::RegValue;

use super::*;
use crate::journal::{JournalCtx, OriginalValue};
use crate::lockdown::apply::{apply as apply_all, ApplyRefusal};
use crate::lockdown::invariants::Facts;
use crate::lockdown::usb::tests::{all_policies, MUST_SURVIVE, MUST_SURVIVE_IDS};
use crate::lockdown::usb::{DenyClass, NEVER_BLOCK};
use crate::platform::sim::{SimOp, SimPlatform};
use crate::platform::Platform;
use crate::state::{AgentState, SharedState, StateStore};
use crate::testutil::TempDir;

const ADMIN_1: &str = "S-1-5-21-1000-2000-3000-1001";
const ADMIN_2: &str = "S-1-5-21-1000-2000-3000-1002";

struct Rig {
    _dir: TempDir,
    platform: Arc<SimPlatform>,
    shared: Arc<SharedState>,
}

impl Rig {
    fn new() -> Self {
        let dir = TempDir::new();
        let platform = Arc::new(SimPlatform::new(dir.path().to_path_buf()));
        platform.with_world(|w| w.strict_machine_keys = true);
        let dyn_platform: Arc<dyn Platform> = platform.clone();
        let shared = SharedState::new(StateStore::open(&dir.path().join("state")).unwrap(), AgentState::default(), dyn_platform);
        Self { _dir: dir, platform, shared }
    }

    fn ctx_at(&self, now_ms: u64, verified: bool) -> ApplyCtx<'_> {
        ApplyCtx {
            journal: JournalCtx { platform: self.platform.as_ref(), shared: self.shared.as_ref() },
            facts: Facts { admin_signin_verified: verified, ..Facts::default() },
            now_ms,
            version: 7,
        }
    }

    fn ctx(&self) -> ApplyCtx<'_> {
        self.ctx_at(1_000, true)
    }

    fn apply(&self, policy: Option<&LockdownPolicy>) -> LayerState {
        let doc = AgentDoc { lockdown: policy.cloned(), ..AgentDoc::default() };
        apply(&self.ctx(), &doc)
    }

    fn value(&self, path: &str, name: &str) -> Option<RegData> {
        self.platform.read_machine_value(&key_of(path, name)).unwrap()
    }

    fn set(&self, path: &str, name: &str, data: RegData) {
        self.platform.with_world(|w| {
            w.machine_values.insert(key_of(path, name), data);
        });
    }

    fn mutating(&self) -> usize {
        self.platform.calls().iter().filter(|op| op.is_mutating()).count()
    }

    fn journal_len(&self) -> usize {
        self.shared.read(|s| s.journal.len())
    }

    fn machine_values(&self) -> usize {
        self.platform.with_world(|w| w.machine_values.len())
    }

    /// The class GUIDs in the deny list, normalised.
    fn deny_guids(&self) -> Vec<String> {
        let key = deny_list_key();
        let mut out: Vec<String> = self
            .platform
            .list_machine_value_names(&key)
            .unwrap()
            .iter()
            .filter_map(|name| match self.value(&key, name) {
                Some(RegData::String(text)) => Some(usb::norm_guid(&text)),
                _ => None,
            })
            .collect();
        out.sort();
        out
    }
}

/// Every machine switch off, no lockout, USB allowed: nothing wanted.
fn off() -> LockdownPolicy {
    LockdownPolicy {
        machine: MachineRestrictions {
            hide_switch_user: false,
            hide_sign_in_power: false,
            deny_elevation_requests: false,
            hide_admin_tiles: false,
            no_wake_password: false,
            restrict_printer_drivers: false,
            file_output_printers: false,
            account_lockout: None,
        },
        usb: UsbPolicy::default(),
        ..LockdownPolicy::default()
    }
}

fn with_usb(usb: UsbPolicy) -> LockdownPolicy {
    LockdownPolicy { usb, ..off() }
}

fn printers_blocked() -> UsbPolicy {
    UsbPolicy { printers: UsbSwitch::Block, ..UsbPolicy::default() }
}

fn expected_machine_guids(usb: &UsbPolicy) -> Vec<String> {
    let mut out: Vec<String> = usb::generate(usb).machine.iter().map(|class| usb::norm_guid(&class.guid)).collect();
    out.sort();
    out
}

// ---------------------------------------------------------------- the catalogue

#[test]
fn the_catalogue_is_the_fixed_part_of_plan_4_8() {
    let keys: Vec<&str> = MACHINE_ITEMS.iter().map(|item| item.key).collect();
    assert_eq!(keys, ["hideSwitchUser", "hideSignInPower", "denyElevationRequests", "noWakePassword", "restrictPrinterDrivers"]);
    let rows: Vec<(&str, u32)> = MACHINE_ITEMS.iter().flat_map(|i| i.rows.iter()).map(|r| (r.name, r.value)).collect();
    assert_eq!(
        rows,
        [
            ("HideFastUserSwitching", 1),
            ("ShutdownWithoutLogon", 0),
            ("ConsentPromptBehaviorUser", 0),
            ("ACSettingIndex", 0),
            ("DCSettingIndex", 0),
            ("RestrictDriverInstallationToAdministrators", 1)
        ]
    );
    for item in MACHINE_ITEMS {
        assert!(!item.checklist.is_empty());
    }
}

#[test]
fn every_row_and_computed_key_is_inside_the_machine_allow_list() {
    // The real rule of `machinereg`, the one `WindowsPlatform` and the sim apply.
    for item in MACHINE_ITEMS {
        for row in item.rows {
            assert!(machinereg::check_write(row.path, row.name, Some(&RegValue::Dword(row.value))).is_ok(), "{}", item.key);
        }
    }
    assert!(machinereg::check_write(USER_LIST, "Owner", Some(&RegValue::Dword(0))).is_ok());
    assert!(machinereg::check_write(DEVICE_INSTALL_RESTRICTIONS, DENY_FLAG, Some(&RegValue::Dword(1))).is_ok());
    assert!(machinereg::check_write(DEVICE_INSTALL_RESTRICTIONS, DENY_RETROACTIVE, Some(&RegValue::Dword(1))).is_ok());
    let guid = RegValue::String("{4d36e979-e325-11ce-bfc1-08002be10318}".into());
    assert!(machinereg::check_write(&deny_list_key(), "1", Some(&guid)).is_ok());
}

#[test]
fn nothing_in_the_catalogue_can_reach_the_values_that_open_the_way_back() {
    for item in MACHINE_ITEMS {
        for row in item.rows {
            assert!(
                !rulebox_win32::autologon::FORBIDDEN_WINLOGON_VALUES.iter().any(|name| name.eq_ignore_ascii_case(row.name)),
                "{}",
                row.name
            );
        }
    }
}

// ---------------------------------------------------------------- journal and restore

#[test]
fn every_item_is_journalled_and_restored_exactly_whatever_was_there() {
    for original in [None, Some(RegData::Dword(7)), Some(RegData::String("seven".into()))] {
        let rig = Rig::new();
        for item in MACHINE_ITEMS {
            for row in item.rows {
                if let Some(data) = &original {
                    rig.set(row.path, row.name, data.clone());
                }
            }
        }
        let before = rig.machine_values();
        let on = rig.apply(Some(&LockdownPolicy::default()));
        assert_eq!((on.mode, on.state), (ReportedMode::On, super::super::LayerStatus::Ok), "{on:?}");
        for item in MACHINE_ITEMS {
            for row in item.rows {
                assert_eq!(rig.value(row.path, row.name), Some(RegData::Dword(row.value)), "{}", item.key);
            }
        }
        // Each journalled value says what was there.
        for item in MACHINE_ITEMS {
            for row in item.rows {
                let id = row_id(row);
                let entry = rig.shared.read(|s| s.journal.iter().find(|e| e.id == id).cloned()).unwrap();
                assert_eq!(entry.owner, JournalOwner::L2);
                let expected = match &original {
                    None => OriginalValue::Absent,
                    Some(RegData::Dword(n)) => OriginalValue::Dword(*n),
                    Some(RegData::String(s)) => OriginalValue::String(s.clone()),
                };
                assert_eq!(entry.original, expected, "{}", item.key);
            }
        }
        // Not wanted any more: the exact original comes back, nothing stays behind.
        let gone = rig.apply(Some(&off()));
        assert_eq!(gone.state, super::super::LayerStatus::Ok);
        for item in MACHINE_ITEMS {
            for row in item.rows {
                assert_eq!(rig.value(row.path, row.name), original, "{}", item.key);
            }
        }
        assert_eq!(rig.machine_values(), before);
        assert_eq!(rig.journal_len(), 0);
    }
}

#[test]
fn a_document_without_a_lockdown_section_restores_everything_and_reports_off() {
    let rig = Rig::new();
    rig.apply(Some(&LockdownPolicy::default()));
    assert!(rig.journal_len() > 0);
    let state = rig.apply(None);
    assert_eq!((state.mode, state.state), (ReportedMode::Off, super::super::LayerStatus::Ok));
    assert_eq!(rig.journal_len(), 0);
    assert_eq!(rig.machine_values(), 0);
    assert_eq!(rig.platform.with_world(|w| w.lockout.threshold), 0);
}

#[test]
fn a_second_apply_with_the_same_document_writes_nothing() {
    let rig = Rig::new();
    let policy = LockdownPolicy { usb: printers_blocked(), ..LockdownPolicy::default() };
    rig.apply(Some(&policy));
    let calls = rig.mutating();
    let journal = rig.shared.read(|s| s.journal.clone());
    let state = rig.apply(Some(&policy));
    assert_eq!(state.state, super::super::LayerStatus::Ok);
    assert_eq!(rig.mutating(), calls, "no mutating call on the second run");
    assert_eq!(rig.shared.read(|s| s.journal.clone()), journal);
}

#[test]
fn an_empty_document_makes_no_mutating_call_at_all() {
    let rig = Rig::new();
    let before = rig.mutating();
    let state = rig.apply(None);
    assert_eq!(state, LayerState::off_ok());
    assert_eq!(rig.mutating(), before);
}

#[test]
fn a_failing_write_is_reported_and_the_other_items_still_go_on() {
    let rig = Rig::new();
    rig.platform.fail_next(SimOp::WriteMachineValue, PlatformError::AccessDenied);
    let state = rig.apply(Some(&LockdownPolicy { machine: MachineRestrictions { hide_admin_tiles: false, ..MachineRestrictions::default() }, ..LockdownPolicy::default() }));
    assert_eq!(state.state, super::super::LayerStatus::Partial);
    assert_eq!(state.detail.as_deref(), Some("access_denied"));
    // Run again: the failed value is written now.
    let again = rig.apply(Some(&LockdownPolicy { machine: MachineRestrictions { hide_admin_tiles: false, ..MachineRestrictions::default() }, ..LockdownPolicy::default() }));
    assert_eq!(again.state, super::super::LayerStatus::Ok);
    for item in MACHINE_ITEMS {
        for row in item.rows {
            assert_eq!(rig.value(row.path, row.name), Some(RegData::Dword(row.value)));
        }
    }
}

use crate::platform::PlatformError;
use super::super::LayerStatus;

// ---------------------------------------------------------------- account lockout

fn lockout_policy(threshold: u32, duration_min: u32, window_min: u32) -> LockdownPolicy {
    LockdownPolicy {
        machine: MachineRestrictions { account_lockout: Some(AccountLockout { threshold, duration_min, window_min }), ..off().machine },
        ..off()
    }
}

#[test]
fn the_lockout_policy_is_set_in_seconds_and_the_original_comes_back_exactly() {
    let rig = Rig::new();
    let original = rig.platform.with_world(|w| w.lockout);
    let state = rig.apply(Some(&lockout_policy(10, 15, 10)));
    assert_eq!(state.state, LayerStatus::Ok);
    assert_eq!(rig.platform.with_world(|w| w.lockout), LockoutPolicy { threshold: 10, duration_s: 900, window_s: 600 });
    let entry = rig.shared.read(|s| s.journal.iter().find(|e| e.id == LOCKOUT_ID).cloned()).unwrap();
    assert_eq!(entry.owner, JournalOwner::L2);
    assert_eq!(
        entry.original,
        OriginalValue::LockoutPolicy { threshold: original.threshold, duration_s: original.duration_s, window_s: original.window_s }
    );
    // `null` in the document: leave the machine's own setting, i.e. put the original back.
    rig.apply(Some(&off()));
    assert_eq!(rig.platform.with_world(|w| w.lockout), original);
    assert_eq!(rig.journal_len(), 0);
}

#[test]
fn a_threshold_under_five_is_refused_and_nothing_is_set() {
    let rig = Rig::new();
    for threshold in [0, 1, 4] {
        let before = rig.mutating();
        let state = rig.apply(Some(&lockout_policy(threshold, 15, 15)));
        assert_eq!(state.state, LayerStatus::Failed, "{threshold}");
        assert_eq!(state.detail.as_deref(), Some("lockout_threshold_too_low"));
        assert_eq!(rig.mutating(), before);
        // The whole apply says so before it writes anything (invariant I7).
        let doc = AgentDoc { lockdown: Some(lockout_policy(threshold, 15, 15)), ..AgentDoc::default() };
        let refusal = apply_all(&rig.ctx(), &doc).unwrap_err();
        assert_eq!(refusal, ApplyRefusal::Refused("lockout_threshold_too_low"));
    }
    assert_eq!(rig.platform.with_world(|w| w.lockout.threshold), 0);
    // Five is the lowest that goes.
    assert_eq!(rig.apply(Some(&lockout_policy(5, 15, 15))).state, LayerStatus::Ok);
}

#[test]
fn a_window_longer_than_the_duration_is_reported_and_not_sent_to_windows() {
    let rig = Rig::new();
    let state = rig.apply(Some(&lockout_policy(10, 10, 30)));
    assert_eq!((state.state, state.detail.as_deref()), (LayerStatus::Failed, Some("lockout_window_too_long")));
    assert!(rig.platform.calls().iter().all(|op| *op != SimOp::SetAccountLockout));
}

// ---------------------------------------------------------------- admin tiles

fn tiles_on() -> LockdownPolicy {
    LockdownPolicy { machine: MachineRestrictions { hide_admin_tiles: true, ..off().machine }, ..off() }
}

fn name_admins(rig: &Rig, admins: &[(&str, &str)]) {
    rig.platform.with_world(|w| {
        w.admins = admins.iter().map(|(sid, _)| (*sid).to_string()).collect();
        w.admin_names = admins.iter().map(|(sid, name)| ((*sid).to_string(), (*name).to_string())).collect();
    });
}

#[test]
fn a_tile_is_hidden_for_each_enabled_administrator_found_by_sid() {
    let rig = Rig::new();
    name_admins(&rig, &[(ADMIN_1, "Owner"), (ADMIN_2, "Boss Two")]);
    let state = rig.apply(Some(&tiles_on()));
    assert_eq!(state.state, LayerStatus::Ok);
    assert_eq!(rig.value(USER_LIST, "Owner"), Some(RegData::Dword(0)));
    assert_eq!(rig.value(USER_LIST, "Boss Two"), Some(RegData::Dword(0)));
    // The Staff account is not an administrator: no tile of it is touched.
    assert_eq!(rig.value(USER_LIST, "RuleboxStaff"), None);
    assert!(rig.platform.calls().contains(&SimOp::EnabledLocalAdminAccounts));
    // An account that is not an administrator any more gets its tile back, the other stays hidden.
    name_admins(&rig, &[(ADMIN_1, "Owner")]);
    rig.apply(Some(&tiles_on()));
    assert_eq!(rig.value(USER_LIST, "Boss Two"), None);
    assert_eq!(rig.value(USER_LIST, "Owner"), Some(RegData::Dword(0)));
    // A new administrator is picked up on the next apply.
    name_admins(&rig, &[(ADMIN_1, "Owner"), (ADMIN_2, "Newcomer")]);
    rig.apply(Some(&tiles_on()));
    assert_eq!(rig.value(USER_LIST, "Newcomer"), Some(RegData::Dword(0)));
    // Switched off: everything back.
    rig.apply(Some(&off()));
    assert_eq!(rig.value(USER_LIST, "Owner"), None);
    assert_eq!(rig.value(USER_LIST, "Newcomer"), None);
    assert_eq!(rig.journal_len(), 0);
}

#[test]
fn an_existing_tile_value_is_remembered_and_restored() {
    let rig = Rig::new();
    name_admins(&rig, &[(ADMIN_1, "Owner")]);
    rig.set(USER_LIST, "Owner", RegData::Dword(1));
    rig.apply(Some(&tiles_on()));
    assert_eq!(rig.value(USER_LIST, "Owner"), Some(RegData::Dword(0)));
    rig.apply(None);
    assert_eq!(rig.value(USER_LIST, "Owner"), Some(RegData::Dword(1)));
}

#[test]
fn hiding_tiles_before_e_71_skips_only_that_option_and_reports_a_warning() {
    let rig = Rig::new();
    name_admins(&rig, &[(ADMIN_1, "Owner")]);
    // The rest of the section is on as well: it must still be applied (owner decision 2026-11-28, guard I7).
    let policy = LockdownPolicy { machine: MachineRestrictions { hide_switch_user: true, ..tiles_on().machine }, ..off() };
    let doc = AgentDoc { lockdown: Some(policy), ..AgentDoc::default() };
    // The whole apply is not refused.
    assert!(apply_all(&rig.ctx_at(1_000, false), &doc).is_ok());
    // The layer: ok, one warning note, the other item written, no tile touched and the list not even read.
    let before = rig.mutating();
    let state = apply(&rig.ctx_at(1_000, false), &doc);
    assert_eq!((state.mode, state.state, state.detail.as_deref()), (ReportedMode::On, LayerStatus::Ok, Some("admin_tiles_skipped")));
    assert_eq!(rig.mutating(), before, "a second run writes nothing");
    assert_eq!(rig.value(POL_SYSTEM, "HideFastUserSwitching"), Some(RegData::Dword(1)));
    assert_eq!(rig.value(USER_LIST, "Owner"), None);
    assert!(!rig.platform.calls().contains(&SimOp::EnabledLocalAdminAccounts));
    // A real failure still wins over the warning.
    rig.platform.fail_next(SimOp::WriteMachineValue, PlatformError::AccessDenied);
    let power = LockdownPolicy { machine: MachineRestrictions { hide_sign_in_power: true, ..tiles_on().machine }, ..off() };
    let power_doc = AgentDoc { lockdown: Some(power), ..AgentDoc::default() };
    let failed = apply(&rig.ctx_at(1_000, false), &power_doc);
    assert_eq!(failed.detail.as_deref(), Some("access_denied"));
    apply(&rig.ctx_at(1_000, false), &doc);
    // After the user records E-71 the tiles are hidden and the warning is gone.
    let state = apply(&rig.ctx_at(1_000, true), &doc);
    assert_eq!((state.state, state.detail), (LayerStatus::Ok, None));
    assert_eq!(rig.value(USER_LIST, "Owner"), Some(RegData::Dword(0)));
    // The flag taken back (config edited): the tiles come back and the warning returns.
    let state = apply(&rig.ctx_at(1_000, false), &doc);
    assert_eq!(state.detail.as_deref(), Some("admin_tiles_skipped"));
    assert_eq!(rig.value(USER_LIST, "Owner"), None);
}

#[test]
fn tiles_off_or_verified_report_no_warning() {
    let rig = Rig::new();
    name_admins(&rig, &[(ADMIN_1, "Owner")]);
    let off_doc = AgentDoc { lockdown: Some(off()), ..AgentDoc::default() };
    assert_eq!(apply(&rig.ctx_at(1_000, false), &off_doc).detail, None);
    let on_doc = AgentDoc { lockdown: Some(tiles_on()), ..AgentDoc::default() };
    assert_eq!(apply(&rig.ctx_at(1_000, true), &on_doc).detail, None);
}

#[test]
fn an_unreadable_admin_list_changes_nothing_and_keeps_the_tiles() {
    let rig = Rig::new();
    name_admins(&rig, &[(ADMIN_1, "Owner")]);
    rig.apply(Some(&tiles_on()));
    rig.platform.fail_next(SimOp::EnabledLocalAdminAccounts, PlatformError::AccessDenied);
    let state = rig.apply(Some(&tiles_on()));
    assert_eq!((state.state, state.detail.as_deref()), (LayerStatus::Failed, Some("admin_list_unreadable")));
    assert_eq!(rig.value(USER_LIST, "Owner"), Some(RegData::Dword(0)));
}

// ---------------------------------------------------------------- device classes (4.7a)

#[test]
fn every_usb_combination_writes_exactly_the_generated_classes_and_never_an_input_device() {
    for usb_policy in all_policies() {
        let rig = Rig::new();
        let state = rig.apply(Some(&with_usb(usb_policy)));
        let unknown = usb_policy.storage == UsbStorageMode::Unknown
            || [usb_policy.printers, usb_policy.imaging, usb_policy.phones, usb_policy.other].contains(&UsbSwitch::Unknown);
        let guids = rig.deny_guids();
        if unknown {
            // 4.3 rule 2: an unknown value keeps what was applied (here: nothing) and says so.
            assert!(guids.is_empty(), "{usb_policy:?}");
            assert_eq!(state.detail.as_deref(), Some("section_unknown_value"));
            continue;
        }
        assert_eq!(state.state, LayerStatus::Ok, "{usb_policy:?} {state:?}");
        assert_eq!(guids, expected_machine_guids(&usb_policy), "{usb_policy:?}");
        for guid in &guids {
            assert!(usb::never_block_hit(guid, &[]).is_none(), "{guid} is a never-block class");
            assert!(MUST_SURVIVE.iter().all(|(_, never)| never != guid), "{guid}");
        }
        for (_, never) in MUST_SURVIVE {
            assert!(!guids.contains(&(*never).to_string()));
        }
        // The flags: set exactly when there is a list; retroactive only when asked.
        let any = !guids.is_empty();
        assert_eq!(rig.value(DEVICE_INSTALL_RESTRICTIONS, DENY_FLAG), any.then_some(RegData::Dword(1)), "{usb_policy:?}");
        assert_eq!(
            rig.value(DEVICE_INSTALL_RESTRICTIONS, DENY_RETROACTIVE),
            (any && usb_policy.retroactive).then_some(RegData::Dword(1)),
            "{usb_policy:?}"
        );
        // Whatever was written is outside the never-block compatible IDs as well.
        for id in MUST_SURVIVE_IDS {
            assert!(usb::generate(&usb_policy).machine.iter().all(|c| !c.compatible_ids.iter().any(|x| usb::compatible_ids_collide(x, id))));
        }
        // And all of it goes again.
        rig.apply(Some(&off()));
        assert!(rig.deny_guids().is_empty());
        assert_eq!(rig.machine_values(), 0, "{usb_policy:?}");
        assert_eq!(rig.journal_len(), 0);
    }
}

#[test]
fn each_group_maps_to_its_classes_and_the_staff_only_groups_to_none() {
    let class_guids = |group: UsbGroup| -> Vec<String> {
        let mut g: Vec<String> = usb::classes_of(group).iter().map(|c| usb::norm_guid(c.guid)).collect();
        g.sort();
        g
    };
    for (policy, group) in [
        (printers_blocked(), UsbGroup::Printers),
        (UsbPolicy { imaging: UsbSwitch::Block, ..UsbPolicy::default() }, UsbGroup::Imaging),
        (UsbPolicy { other: UsbSwitch::Block, ..UsbPolicy::default() }, UsbGroup::Other),
    ] {
        assert_eq!(UsbGroup::scope(group), UsbScope::Machine);
        let rig = Rig::new();
        rig.apply(Some(&with_usb(policy)));
        assert_eq!(rig.deny_guids(), class_guids(group), "{group:?}");
    }
    // Storage and phones are decided by `UsbGroup::scope()` alone: with the current rule
    // (Staff) the machine key has no entry for them.
    for policy in [
        UsbPolicy { storage: UsbStorageMode::Block, ..UsbPolicy::default() },
        UsbPolicy { storage: UsbStorageMode::ReadOnly, ..UsbPolicy::default() },
        UsbPolicy { phones: UsbSwitch::Block, ..UsbPolicy::default() },
    ] {
        let rig = Rig::new();
        rig.apply(Some(&with_usb(policy)));
        assert_eq!(rig.deny_guids(), expected_machine_guids(&policy));
    }
}

#[test]
fn the_deny_keys_are_restored_to_the_exact_original_present_or_absent() {
    let rig = Rig::new();
    let list = deny_list_key();
    // An administrator's own policy: the switch is present but 0, one other class listed.
    rig.set(DEVICE_INSTALL_RESTRICTIONS, DENY_FLAG, RegData::Dword(0));
    rig.set(&list, "1", RegData::String("{36fc9e60-c465-11cf-8056-444553540001}".into()));
    let before = rig.platform.with_world(|w| w.machine_values.clone());
    rig.apply(Some(&with_usb(UsbPolicy { printers: UsbSwitch::Block, retroactive: true, ..UsbPolicy::default() })));
    assert_eq!(rig.value(DEVICE_INSTALL_RESTRICTIONS, DENY_FLAG), Some(RegData::Dword(1)));
    assert_eq!(rig.value(DEVICE_INSTALL_RESTRICTIONS, DENY_RETROACTIVE), Some(RegData::Dword(1)));
    // Ours takes the first free number; theirs is untouched.
    assert_eq!(rig.value(&list, "1"), Some(RegData::String("{36fc9e60-c465-11cf-8056-444553540001}".into())));
    assert_eq!(rig.value(&list, "2"), Some(RegData::String("{4d36e979-e325-11ce-bfc1-08002be10318}".into())));
    let entry = rig.shared.read(|s| s.journal.iter().find(|e| e.id == journal::machine_id(&key_of(&list, "2"))).cloned()).unwrap();
    assert_eq!((entry.owner, entry.original), (JournalOwner::L2, OriginalValue::Absent));
    // Back: DenyDeviceClasses is 0 again (present), the retroactive flag and our class are gone.
    rig.apply(Some(&off()));
    assert_eq!(rig.platform.with_world(|w| w.machine_values.clone()), before);
    assert_eq!(rig.journal_len(), 0);
    // Absent originals: everything disappears.
    let fresh = Rig::new();
    fresh.apply(Some(&with_usb(printers_blocked())));
    assert_eq!(fresh.machine_values(), 2);
    fresh.apply(None);
    assert_eq!(fresh.machine_values(), 0);
}

#[test]
fn a_class_already_in_the_list_is_not_added_twice_and_not_removed_with_ours() {
    let rig = Rig::new();
    let list = deny_list_key();
    rig.set(&list, "1", RegData::String("{4D36E979-E325-11CE-BFC1-08002BE10318}".into()));
    rig.apply(Some(&with_usb(printers_blocked())));
    assert_eq!(rig.platform.list_machine_value_names(&list).unwrap(), ["1"], "no second entry for the same class");
    rig.apply(Some(&off()));
    assert_eq!(rig.value(&list, "1"), Some(RegData::String("{4D36E979-E325-11CE-BFC1-08002BE10318}".into())));
    assert_eq!(rig.value(DEVICE_INSTALL_RESTRICTIONS, DENY_FLAG), None, "the switch we set is gone");
}

#[test]
fn a_group_switched_off_alone_removes_only_its_classes() {
    let rig = Rig::new();
    rig.apply(Some(&with_usb(UsbPolicy { printers: UsbSwitch::Block, imaging: UsbSwitch::Block, ..UsbPolicy::default() })));
    assert_eq!(rig.deny_guids().len(), 3);
    rig.apply(Some(&with_usb(UsbPolicy { imaging: UsbSwitch::Block, ..UsbPolicy::default() })));
    assert_eq!(rig.deny_guids(), expected_machine_guids(&UsbPolicy { imaging: UsbSwitch::Block, ..UsbPolicy::default() }));
    assert_eq!(rig.value(DEVICE_INSTALL_RESTRICTIONS, DENY_FLAG), Some(RegData::Dword(1)));
}

#[test]
fn the_retroactive_flag_is_written_only_when_every_class_in_the_list_allows_it() {
    // Printers only: every class allows it.
    let rig = Rig::new();
    let mut tally = Tally::default();
    let mut restore = Vec::new();
    let policy = UsbPolicy { printers: UsbSwitch::Block, retroactive: true, ..UsbPolicy::default() };
    apply_tables(&rig.ctx(), &usb::generate(&policy), &mut tally, &mut restore);
    assert_eq!(rig.value(DEVICE_INSTALL_RESTRICTIONS, DENY_RETROACTIVE), Some(RegData::Dword(1)));
    assert_eq!(tally.note, None);

    // If the owner moved storage to the whole PC, the disk classes are in the list and the
    // flag would reach the machine's own disks: it is left out and the layer says so.
    let rig = Rig::new();
    let mut tally = Tally::default();
    let mut restore = Vec::new();
    let policy = UsbPolicy { printers: UsbSwitch::Block, storage: UsbStorageMode::Block, retroactive: true, ..UsbPolicy::default() };
    let tables = usb::generate_with(&policy, |_| UsbScope::Machine);
    assert!(tables.machine.iter().any(|class| !class.retroactive_ok));
    apply_tables(&rig.ctx(), &tables, &mut tally, &mut restore);
    assert_eq!(rig.value(DEVICE_INSTALL_RESTRICTIONS, DENY_RETROACTIVE), None);
    assert_eq!(rig.value(DEVICE_INSTALL_RESTRICTIONS, DENY_FLAG), Some(RegData::Dword(1)));
    assert_eq!(tally.note, Some("usb_retroactive_skipped"));
    assert_eq!(rig.deny_guids().len(), 3);
}

#[test]
fn a_hand_built_list_with_an_input_device_class_is_refused_before_anything_is_written() {
    let rig = Rig::new();
    let mut tables = usb::generate(&printers_blocked());
    let hid = NEVER_BLOCK.iter().find(|entry| entry.name == "HIDClass").unwrap();
    tables.machine.push(DenyClass {
        group: UsbGroup::Other,
        name: "HIDClass".into(),
        guid: hid.guid.unwrap().to_string(),
        compatible_ids: vec![],
        retroactive_ok: true,
    });
    let mut tally = Tally::default();
    let mut restore = Vec::new();
    apply_tables(&rig.ctx(), &tables, &mut tally, &mut restore);
    assert_eq!(tally.status(), LayerStatus::Failed);
    assert_eq!(tally.detail().as_deref(), Some("would_block_input_device"));
    assert_eq!(rig.mutating(), 0);
    assert_eq!(rig.machine_values(), 0);

    // One that names a hub only by its compatible ID is refused too.
    let mut tables = usb::generate(&printers_blocked());
    tables.machine.push(DenyClass {
        group: UsbGroup::Other,
        name: "odd".into(),
        guid: "00000000-0000-0000-0000-000000000000".into(),
        compatible_ids: vec![r"USB\ROOT_HUB30".into()],
        retroactive_ok: true,
    });
    let mut tally = Tally::default();
    apply_tables(&rig.ctx(), &tables, &mut tally, &mut restore);
    assert_eq!(tally.detail().as_deref(), Some("would_block_input_device"));
    assert_eq!(rig.mutating(), 0);
}

#[test]
fn the_facts_the_invariants_check_carry_what_the_layer_will_write() {
    let doc = AgentDoc { lockdown: Some(with_usb(printers_blocked())), ..AgentDoc::default() };
    let mut generated = Generated::default();
    fill_generated(&doc, &mut generated, 1_000);
    assert_eq!(generated.usb, Some(usb::generate(&printers_blocked())));
    // A table that is already there is kept (and checked as well).
    let mut kept = Generated { usb: Some(DenyTables::default()), ..Generated::default() };
    fill_generated(&doc, &mut kept, 1_000);
    assert_eq!(kept.usb, Some(DenyTables::default()));
    let mut none = Generated::default();
    fill_generated(&AgentDoc::default(), &mut none, 1_000);
    assert_eq!(none.usb, None);
}

// ---------------------------------------------------------------- the temporary allow

#[test]
fn a_temporary_allow_lifts_the_deny_keys_and_they_come_back_when_it_ends() {
    let rig = Rig::new();
    let policy = with_usb(printers_blocked());
    let printer_guid = expected_machine_guids(&printers_blocked());
    let plain = AgentDoc { lockdown: Some(policy.clone()), ..AgentDoc::default() };
    let allowing = AgentDoc { usb_temp_allow: Some(UsbTempAllow { until_ms: 61_000 }), ..plain.clone() };

    // t = 1 s: blocked.
    assert!(apply_all(&rig.ctx_at(1_000, true), &plain).is_ok());
    assert_eq!(rig.deny_guids(), printer_guid);
    // t = 2 s: the allow is running; the keys go (restored from the journal).
    assert!(apply_all(&rig.ctx_at(2_000, true), &allowing).is_ok());
    assert!(rig.deny_guids().is_empty());
    assert_eq!(rig.value(DEVICE_INSTALL_RESTRICTIONS, DENY_FLAG), None);
    assert_eq!(rig.shared.read(|s| s.journal.iter().filter(|e| e.owner == JournalOwner::L2).count()), 0);
    // Still running just before the end ...
    assert_eq!(usb::temp_allow_deadline(&allowing, 60_999), Some(61_000));
    assert!(apply_all(&rig.ctx_at(60_999, true), &allowing).is_ok());
    assert!(rig.deny_guids().is_empty());
    // ... and over at its time: the next apply (the agent's timer) writes them again.
    assert_eq!(usb::temp_allow_deadline(&allowing, 61_000), None);
    assert!(apply_all(&rig.ctx_at(61_000, true), &allowing).is_ok());
    assert_eq!(rig.deny_guids(), printer_guid);
    assert_eq!(rig.value(DEVICE_INSTALL_RESTRICTIONS, DENY_FLAG), Some(RegData::Dword(1)));
}

#[test]
fn a_temporary_allow_cannot_be_longer_than_eight_hours_and_never_adds_a_rule() {
    let doc = AgentDoc {
        lockdown: Some(with_usb(printers_blocked())),
        usb_temp_allow: Some(UsbTempAllow { until_ms: u64::MAX }),
        ..AgentDoc::default()
    };
    let now = 5_000;
    assert_eq!(usb::temp_allow_deadline(&doc, now), Some(now + rulebox_policy::lockdown::MAX_USB_TEMP_ALLOW_MS));
    // The lifted document is the same document with `usb` at its defaults; nothing else changes.
    let lifted = usb::with_temp_allow(&doc, now);
    let mut expected = doc.clone();
    expected.lockdown.as_mut().unwrap().usb = UsbPolicy::default();
    assert_eq!(*lifted, expected);
    // No lockdown section: nothing to lift, nothing to add.
    let bare = AgentDoc { usb_temp_allow: doc.usb_temp_allow, ..AgentDoc::default() };
    assert_eq!(*usb::with_temp_allow(&bare, now), bare);
}

// ---------------------------------------------------------------- the whole transaction

#[test]
fn the_apply_transaction_runs_l2_and_reports_it() {
    let rig = Rig::new();
    let doc = AgentDoc {
        lockdown: Some(LockdownPolicy { usb: printers_blocked(), ..LockdownPolicy::default() }),
        ..AgentDoc::default()
    };
    let outcome = apply_all(&rig.ctx(), &doc).unwrap();
    assert_eq!((outcome.layers.machine.mode, outcome.layers.machine.state), (ReportedMode::On, LayerStatus::Ok));
    assert_eq!(rig.deny_guids(), expected_machine_guids(&printers_blocked()));
    assert_eq!(rig.platform.with_world(|w| w.lockout.threshold), 10);
    // Disable (a document without lockdown): all of it restored.
    let outcome = apply_all(&rig.ctx(), &AgentDoc::default()).unwrap();
    assert_eq!(outcome.layers.machine, LayerState::off_ok());
    assert_eq!(rig.machine_values(), 0);
    assert_eq!(rig.platform.with_world(|w| w.lockout.threshold), 0);
}
