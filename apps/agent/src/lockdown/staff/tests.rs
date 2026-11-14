//! Tests of L1 (plan Step 4): every catalogue item on, off and on again; the exact
//! original comes back (absent, DWORD, string); the Staff hive being signed out or
//! failing; and the rules that keep the layer inside `staffreg::ALLOWED_ROOTS`. All
//! against `SimPlatform`; nothing touches the machine.

use std::sync::Arc;

use rulebox_policy::lockdown::{
    KeyboardPolicy, LockdownPolicy, MachineRestrictions, StaffRestrictions, UsbPolicy, UsbStorageMode, UsbSwitch, WinCombos,
};
use rulebox_policy::AgentDoc;

use super::*;
use crate::journal::{EntryPhase, JournalCtx, OriginalValue};
use crate::lockdown::invariants::Facts;
use crate::platform::sim::{SimOp, SimPlatform};
use crate::platform::{Platform, PlatformError, StaffUserSpec};
use crate::state::{AgentState, SharedState, StaffAccount, StateStore};
use crate::testutil::TempDir;

struct Rig {
    _dir: TempDir,
    platform: Arc<SimPlatform>,
    shared: Arc<SharedState>,
    sid: String,
    /// Mutating calls made by the setup itself (creating the account).
    base_calls: usize,
}

impl Rig {
    fn new() -> Self {
        Self::build(true)
    }

    fn build(with_staff: bool) -> Self {
        let dir = TempDir::new();
        let platform = Arc::new(SimPlatform::new(dir.path().to_path_buf()));
        let spec = StaffUserSpec { user_name: "RuleboxStaff".into(), full_name: "Staff".into(), comment: "c".into() };
        let sid = platform.create_staff_user(&spec, "pw").unwrap();
        let state = AgentState {
            staff: with_staff.then(|| StaffAccount { sid: sid.clone(), user_name: "RuleboxStaff".into(), profile_dir: None }),
            ..AgentState::default()
        };
        let dyn_platform: Arc<dyn Platform> = platform.clone();
        let shared = SharedState::new(StateStore::open(&dir.path().join("state")).unwrap(), state, dyn_platform);
        let base_calls = platform.calls().iter().filter(|op| op.is_mutating()).count();
        Self { _dir: dir, platform, shared, sid, base_calls }
    }

    fn ctx(&self) -> ApplyCtx<'_> {
        ApplyCtx {
            journal: JournalCtx { platform: self.platform.as_ref(), shared: self.shared.as_ref() },
            facts: Facts::default(),
            now_ms: 1_000,
            version: 7,
        }
    }

    fn apply(&self, policy: Option<&LockdownPolicy>) -> LayerState {
        let doc = AgentDoc { lockdown: policy.cloned(), ..AgentDoc::default() };
        apply(&self.ctx(), &doc)
    }

    fn value(&self, row: &StaffRow) -> Option<RegData> {
        self.platform.read_staff_value(&self.sid, row.path, row.name).unwrap()
    }

    fn set(&self, row: &StaffRow, data: RegData) {
        self.platform.write_staff_value(&self.sid, row.path, row.name, &data).unwrap();
    }

    fn mutating_calls(&self) -> usize {
        self.platform.calls().iter().filter(|op| op.is_mutating()).count() - self.base_calls
    }

    fn staff_value_count(&self) -> usize {
        self.platform.with_world(|w| w.staff_values.len())
    }

    fn journal_len(&self) -> usize {
        self.shared.read(|s| s.journal.len())
    }
}

fn item(key: &str) -> &'static StaffItem {
    STAFF_ITEMS.iter().find(|item| item.key == key).unwrap_or_else(|| panic!("no item {key}"))
}

fn flag_row(path_end: &str) -> &'static StaffRow {
    ACCESSIBILITY_ROWS.iter().find(|row| row.path.ends_with(path_end)).unwrap()
}

/// Everything off: no Staff restriction, no wake-password rule, Windows keys pass, USB allowed.
fn base_off() -> LockdownPolicy {
    LockdownPolicy {
        staff: StaffRestrictions {
            task_manager: false,
            run: false,
            command_prompt: false,
            registry_tools: false,
            settings: false,
            sign_out: false,
            change_password: false,
            hide_drives: false,
            accessibility_hotkeys: false,
            office_macros: false,
        },
        machine: MachineRestrictions { no_wake_password: false, ..MachineRestrictions::default() },
        keyboard: KeyboardPolicy { win_combos: WinCombos::Pass },
        usb: UsbPolicy::default(),
        ..LockdownPolicy::default()
    }
}

/// The document that turns exactly one catalogue item on (the "mode" of that item).
fn only(key: &str) -> LockdownPolicy {
    let mut policy = base_off();
    match key {
        "taskManager" => policy.staff.task_manager = true,
        "signOut" => policy.staff.sign_out = true,
        "changePassword" => policy.staff.change_password = true,
        "run" => policy.staff.run = true,
        "commandPrompt" => policy.staff.command_prompt = true,
        "registryTools" => policy.staff.registry_tools = true,
        "settings" => policy.staff.settings = true,
        "hideDrives" => policy.staff.hide_drives = true,
        "(with keyboard) noWinKeys" => policy.keyboard.win_combos = WinCombos::Swallow,
        "accessibilityHotkeys" => policy.staff.accessibility_hotkeys = true,
        "officeMacros" => policy.staff.office_macros = true,
        "(always with noWakePassword) screenSaverIsSecure" => policy.machine.no_wake_password = true,
        "usb.storage=readOnly" => policy.usb.storage = UsbStorageMode::ReadOnly,
        "usb.storage=block" => policy.usb.storage = UsbStorageMode::Block,
        "usb.phones=block" => policy.usb.phones = UsbSwitch::Block,
        other => panic!("no document for {other}"),
    }
    policy
}

fn l1_items() -> impl Iterator<Item = &'static StaffItem> {
    STAFF_ITEMS.iter().filter(|item| item.owner == ItemOwner::L1)
}

fn expected(row: &StaffRow) -> RegData {
    match row.value {
        RowValue::Dword(value) => RegData::Dword(value),
        RowValue::Text(text) => RegData::String(text.to_string()),
        RowValue::AccessibilityFlags { default } => RegData::String(clear_hotkey_bit(default).unwrap()),
    }
}

// -- the catalogue ----------------------------------------------------------------------

#[test]
fn every_row_is_inside_the_staff_roots_and_never_the_shell() {
    for item in STAFF_ITEMS {
        assert!(!item.rows.is_empty() && !item.checklist.is_empty(), "{}", item.key);
        for row in item.rows {
            assert!(rulebox_win32::staffreg::check_write(row.path, row.name).is_ok(), "{} {}", row.path, row.name);
            assert!(!row.name.eq_ignore_ascii_case("Shell"));
        }
    }
}

#[test]
fn the_catalogue_is_the_set_of_plan_4_7() {
    let keys: Vec<&str> = STAFF_ITEMS.iter().map(|item| item.key).collect();
    assert_eq!(keys.len(), 16);
    for key in [
        "taskManager",
        "signOut",
        "changePassword",
        "(always) lockWorkstation",
        "run",
        "commandPrompt",
        "registryTools",
        "settings",
        "hideDrives",
        "(with keyboard) noWinKeys",
        "accessibilityHotkeys",
        "officeMacros",
        "(always with noWakePassword) screenSaverIsSecure",
        "usb.storage=readOnly",
        "usb.storage=block",
        "usb.phones=block",
    ] {
        assert!(keys.contains(&key), "{key}");
    }
    // Row ids are unique: two items never write the same value.
    let mut ids: Vec<String> = STAFF_ITEMS.iter().flat_map(|item| item.rows.iter().map(row_id)).collect();
    let all = ids.len();
    ids.sort();
    ids.dedup();
    assert_eq!(ids.len(), all);
    // Phase 2 keeps DisableLockWorkstation.
    let kiosk: Vec<&str> = STAFF_ITEMS.iter().filter(|i| i.owner == ItemOwner::Kiosk).flat_map(|i| i.rows.iter().map(|r| r.name)).collect();
    assert_eq!(kiosk, vec!["DisableLockWorkstation"]);
}

#[test]
fn the_phone_rows_name_exactly_the_wpd_guids_of_the_usb_table() {
    let rows = item("usb.phones=block").rows;
    let mut seen: Vec<String> = Vec::new();
    for row in rows {
        let (parent, guid) = row.path.rsplit_once('\\').unwrap();
        assert_eq!(parent, REMOVABLE);
        assert!(matches!(row.name, "Deny_Read" | "Deny_Write"));
        if !seen.contains(&guid.to_string()) {
            seen.push(guid.to_string());
        }
    }
    let table: Vec<String> = usb::STAFF_WPD_GUIDS.iter().map(|g| g.to_string()).collect();
    assert_eq!(seen, table);
    assert_eq!(rows.len(), table.len() * 2);
}

#[test]
fn each_item_is_wanted_by_exactly_its_own_document() {
    for item in l1_items() {
        let policy = only(item.key);
        for other in l1_items() {
            assert_eq!((other.wanted)(&policy), other.key == item.key, "document for {} vs item {}", item.key, other.key);
        }
    }
    assert_eq!(planned_rows(None).len(), 0);
    assert_eq!(planned_rows(Some(&base_off())).len(), 0);
}

#[test]
fn the_defaults_of_4_3_want_the_staff_restrictions_and_no_usb_rows() {
    let rows = planned_rows(Some(&LockdownPolicy::default()));
    let names: Vec<&str> = rows.iter().map(|r| r.name).collect();
    assert!(names.contains(&"DisableTaskMgr") && names.contains(&"NoWinKeys") && names.contains(&"ScreenSaverIsSecure"));
    assert!(!names.contains(&"Deny_Write") && !names.contains(&"Deny_All") && !names.contains(&"Deny_Read"));
    assert!(!names.contains(&"DisableLockWorkstation"));
}

// -- on / off / on --------------------------------------------------------------------------

#[test]
fn each_item_on_off_on_again_is_idempotent_and_restores_to_absent() {
    for item in l1_items() {
        let rig = Rig::new();
        let on = only(item.key);

        let first = rig.apply(Some(&on));
        assert_eq!((first.mode, first.state, first.detail.clone()), (ReportedMode::On, LayerStatus::Ok, None), "{}", item.key);
        for row in item.rows {
            assert_eq!(rig.value(row), Some(expected(row)), "{} {}", item.key, row.name);
        }
        assert_eq!(rig.staff_value_count(), item.rows.len(), "{} wrote something else", item.key);
        assert_eq!(rig.journal_len(), item.rows.len(), "{}", item.key);
        assert!(rig.shared.read(|s| s.journal.iter().all(|e| e.owner == JournalOwner::L1
            && e.since_version == 7
            && e.phase == EntryPhase::Applied
            && e.original == OriginalValue::Absent)));

        // Same document again: not one more write.
        let calls = rig.mutating_calls();
        assert_eq!(rig.apply(Some(&on)), first, "{}", item.key);
        assert_eq!(rig.mutating_calls(), calls, "{} is not idempotent", item.key);

        // Off: everything this item wrote is gone and the journal is empty.
        let off = rig.apply(Some(&base_off()));
        assert_eq!((off.mode, off.state), (ReportedMode::On, LayerStatus::Ok), "{}", item.key);
        assert_eq!(rig.staff_value_count(), 0, "{}", item.key);
        assert_eq!(rig.journal_len(), 0, "{}", item.key);
        let calls = rig.mutating_calls();
        rig.apply(Some(&base_off()));
        assert_eq!(rig.mutating_calls(), calls, "{} off is not idempotent", item.key);

        // On again.
        assert_eq!(rig.apply(Some(&on)).state, LayerStatus::Ok);
        for row in item.rows {
            assert_eq!(rig.value(row), Some(expected(row)), "{} {} (second time)", item.key, row.name);
        }
        // No document at all (Phase 4 style): off again.
        let none = rig.apply(None);
        assert_eq!((none.mode, none.state), (ReportedMode::Off, LayerStatus::Ok));
        assert_eq!(rig.staff_value_count(), 0);
        assert_eq!(rig.journal_len(), 0);
    }
}

#[test]
fn the_default_document_writes_every_staff_row_and_an_absent_one_restores_them_all() {
    let rig = Rig::new();
    let policy = LockdownPolicy::default();
    assert_eq!(rig.apply(Some(&policy)).state, LayerStatus::Ok);
    let rows = planned_rows(Some(&policy));
    assert_eq!(rig.staff_value_count(), rows.len());
    for row in &rows {
        assert_eq!(rig.value(row), Some(expected(row)), "{}", row.name);
    }
    assert_eq!(rig.journal_len(), rows.len());
    assert_eq!(rig.apply(None).mode, ReportedMode::Off);
    assert_eq!(rig.staff_value_count(), 0);
}

#[test]
fn a_phase_4_document_with_no_lockdown_writes_nothing_at_all() {
    let rig = Rig::new();
    let state = rig.apply(None);
    assert_eq!((state.mode, state.state, state.detail), (ReportedMode::Off, LayerStatus::Ok, None));
    assert_eq!(rig.mutating_calls(), 0);
    assert_eq!(rig.journal_len(), 0);
}

#[test]
fn changing_the_usb_storage_mode_swaps_the_rows() {
    let rig = Rig::new();
    let deny_write = &item("usb.storage=readOnly").rows[0];
    let deny_all = &item("usb.storage=block").rows[0];

    rig.apply(Some(&only("usb.storage=block")));
    assert_eq!((rig.value(deny_all), rig.value(deny_write)), (Some(RegData::Dword(1)), None));
    rig.apply(Some(&only("usb.storage=readOnly")));
    assert_eq!((rig.value(deny_all), rig.value(deny_write)), (None, Some(RegData::Dword(1))));
    rig.apply(Some(&base_off()));
    assert_eq!((rig.value(deny_all), rig.value(deny_write)), (None, None));
    assert_eq!(rig.journal_len(), 0);

    // Phones follow their own switch; an Unknown value is not a block.
    rig.apply(Some(&only("usb.phones=block")));
    assert_eq!(rig.staff_value_count(), 4);
    let mut unknown = base_off();
    unknown.usb.phones = UsbSwitch::Unknown;
    unknown.usb.storage = UsbStorageMode::Unknown;
    rig.apply(Some(&unknown));
    assert_eq!(rig.staff_value_count(), 0);
}

#[test]
fn the_usb_machine_wide_switches_write_nothing_in_the_staff_hive() {
    let rig = Rig::new();
    let mut policy = base_off();
    policy.usb = UsbPolicy {
        printers: UsbSwitch::Block,
        imaging: UsbSwitch::Block,
        other: UsbSwitch::Block,
        retroactive: true,
        ..UsbPolicy::default()
    };
    assert_eq!(rig.apply(Some(&policy)).state, LayerStatus::Ok);
    assert_eq!(rig.mutating_calls(), 0);
}

// -- the exact original ---------------------------------------------------------------------

#[test]
fn restore_returns_the_exact_original_absent_dword_and_string() {
    let rig = Rig::new();
    let no_run = &item("run").rows[0];
    let task_mgr = &item("taskManager").rows[0];
    let hide_drives = &item("hideDrives").rows[0];
    let screen_saver = &item("(always with noWakePassword) screenSaverIsSecure").rows[0];
    let vba = &item("officeMacros").rows[0];
    // Absent: task_mgr. A DWORD that differs, one that already equals the wanted value, a
    // string, and a DWORD where a string policy is wanted later.
    rig.set(no_run, RegData::Dword(0));
    rig.set(hide_drives, RegData::Dword(0x03FF_FFFF));
    rig.set(screen_saver, RegData::String("1".into()));
    rig.set(vba, RegData::Dword(2));

    assert_eq!(rig.apply(Some(&LockdownPolicy::default())).state, LayerStatus::Ok);
    assert_eq!(rig.value(no_run), Some(RegData::Dword(1)));
    assert_eq!(rig.value(task_mgr), Some(RegData::Dword(1)));
    assert_eq!(rig.value(screen_saver), Some(RegData::String("0".into())));
    assert_eq!(rig.value(vba), Some(RegData::Dword(4)));
    // The entry exists even where the value already was the wanted one? No: nothing to undo.
    assert!(rig.shared.read(|s| s.journal.iter().all(|e| e.id != row_id(hide_drives))));

    // "Disable kiosk" restores the whole journal.
    let report = journal::restore_all(&rig.ctx().journal);
    assert!(report.is_complete(), "{:?}", report.failed_ids());
    assert_eq!(rig.value(no_run), Some(RegData::Dword(0)));
    assert_eq!(rig.value(task_mgr), None);
    assert_eq!(rig.value(hide_drives), Some(RegData::Dword(0x03FF_FFFF)));
    assert_eq!(rig.value(screen_saver), Some(RegData::String("1".into())));
    assert_eq!(rig.value(vba), Some(RegData::Dword(2)));
    assert_eq!(rig.journal_len(), 0);
    // Only the three that existed before are left in the hive, plus the row 'vba' siblings: none.
    assert_eq!(rig.staff_value_count(), 4);
}

#[test]
fn the_original_survives_a_second_document_and_a_restart_of_the_layer() {
    let rig = Rig::new();
    let no_run = &item("run").rows[0];
    rig.set(no_run, RegData::Dword(0));
    rig.apply(Some(&only("run")));
    // A different document keeps the first original, never the value Rulebox wrote.
    let mut other = only("run");
    other.staff.task_manager = true;
    rig.apply(Some(&other));
    rig.apply(Some(&only("run")));
    assert!(rig.shared.read(|s| s.journal.iter().any(|e| e.id == row_id(no_run) && e.original == OriginalValue::Dword(0))));
    rig.apply(None);
    assert_eq!(rig.value(no_run), Some(RegData::Dword(0)));
}

// -- accessibility flags ----------------------------------------------------------------------

#[test]
fn the_accessibility_flags_change_only_the_hotkey_bit_and_the_original_string_comes_back() {
    assert_eq!(clear_hotkey_bit("510").as_deref(), Some("506"));
    assert_eq!(clear_hotkey_bit("506").as_deref(), Some("506"));
    assert_eq!(clear_hotkey_bit(" 511 ").as_deref(), Some("507"));
    assert_eq!(clear_hotkey_bit("0004").as_deref(), Some("0"));
    assert_eq!(clear_hotkey_bit("abc"), None);
    assert_eq!(clear_hotkey_bit(""), None);
    assert_eq!(clear_hotkey_bit("-4"), None);

    let rig = Rig::new();
    let sticky = flag_row("StickyKeys");
    let filter = flag_row("Keyboard Response");
    let toggle = flag_row("ToggleKeys");
    let mouse = flag_row("MouseKeys");
    // A customised value (sound and indicator bits), an untouched default (no value at all),
    // a value that has no hotkey bit set, and one with padding the journal must give back as it was.
    rig.set(sticky, RegData::String("511".into()));
    rig.set(toggle, RegData::String("58".into()));
    rig.set(mouse, RegData::String(" 190 ".into()));

    let state = rig.apply(Some(&only("accessibilityHotkeys")));
    assert_eq!((state.mode, state.state), (ReportedMode::On, LayerStatus::Ok));
    assert_eq!(rig.value(sticky), Some(RegData::String("507".into())));
    assert_eq!(rig.value(filter), Some(RegData::String("122".into())), "Windows' default 126 without the hotkey bit");
    assert_eq!(rig.value(toggle), Some(RegData::String("58".into())));
    assert_eq!(rig.value(mouse), Some(RegData::String("186".into())));
    // A value that already lacked the bit is not journalled (nothing changed).
    assert!(rig.shared.read(|s| s.journal.iter().all(|e| e.id != row_id(toggle))));

    rig.apply(Some(&base_off()));
    assert_eq!(rig.value(sticky), Some(RegData::String("511".into())));
    assert_eq!(rig.value(filter), None);
    assert_eq!(rig.value(toggle), Some(RegData::String("58".into())));
    assert_eq!(rig.value(mouse), Some(RegData::String(" 190 ".into())));
}

#[test]
fn an_accessibility_value_that_cannot_be_read_as_flags_is_left_alone_and_reported() {
    let rig = Rig::new();
    let sticky = flag_row("StickyKeys");
    let toggle = flag_row("ToggleKeys");
    rig.set(sticky, RegData::String("not a number".into()));
    rig.set(toggle, RegData::Dword(62));
    let state = rig.apply(Some(&only("accessibilityHotkeys")));
    assert_eq!(state.state, LayerStatus::Partial);
    assert_eq!(state.detail.as_deref(), Some("accessibility_flags_unreadable"));
    assert_eq!(rig.value(sticky), Some(RegData::String("not a number".into())));
    assert_eq!(rig.value(toggle), Some(RegData::Dword(62)));
    assert_eq!(rig.value(flag_row("Keyboard Response")), Some(RegData::String("122".into())));
    assert_eq!(rig.journal_len(), 2, "FilterKeys and MouseKeys were written");
}

// -- the hive, the account, failures ---------------------------------------------------------------

#[test]
fn a_signed_out_staff_hive_is_written_and_restored_like_any_other() {
    // The Sim has no session for the Staff account at all: the hive "is not loaded" and the
    // seam mounts it (the real mount is in rulebox-win32 and runs on the VM only).
    let rig = Rig::new();
    assert!(rig.platform.sessions().unwrap().is_empty());
    assert_eq!(rig.apply(Some(&LockdownPolicy::default())).state, LayerStatus::Ok);
    assert!(rig.staff_value_count() > 10);
    assert_eq!(rig.apply(None).state, LayerStatus::Ok);
    assert_eq!(rig.staff_value_count(), 0);
}

#[test]
fn no_staff_account_is_a_failed_layer_with_a_code_and_writes_nothing() {
    let rig = Rig::build(false);
    let state = rig.apply(Some(&LockdownPolicy::default()));
    assert_eq!((state.mode, state.state), (ReportedMode::On, LayerStatus::Failed));
    assert_eq!(state.detail.as_deref(), Some("no_staff_account"));
    assert_eq!(rig.mutating_calls(), 0);
    // Off with nothing to restore is fine without an account.
    assert_eq!(rig.apply(None).state, LayerStatus::Ok);
}

#[test]
fn a_failing_write_is_partial_with_a_fixed_code_and_the_next_apply_finishes_the_job() {
    let rig = Rig::new();
    rig.platform.fail_next(SimOp::WriteStaffValue, PlatformError::Guard("not a test machine".into()));
    let state = rig.apply(Some(&LockdownPolicy::default()));
    assert_eq!(state.state, LayerStatus::Partial);
    assert_eq!(state.detail.as_deref(), Some("guard_blocked"));
    assert!(!state.detail.unwrap().contains("test machine"), "never Windows text");

    // The journal saved the original before the failed write; the retry completes everything.
    assert_eq!(rig.apply(Some(&LockdownPolicy::default())).state, LayerStatus::Ok);
    let rows = planned_rows(Some(&LockdownPolicy::default()));
    for row in &rows {
        assert_eq!(rig.value(row), Some(expected(row)), "{}", row.name);
    }
    assert_eq!(rig.journal_len(), rows.len());
    assert!(rig.shared.read(|s| s.journal.iter().all(|e| e.phase == EntryPhase::Applied)));
}

#[test]
fn a_failing_restore_stays_in_the_journal_and_is_retried() {
    let rig = Rig::new();
    rig.apply(Some(&only("run")));
    rig.platform.fail_next(SimOp::DeleteStaffValue, PlatformError::AccessDenied);
    let state = rig.apply(Some(&base_off()));
    assert_eq!(state.state, LayerStatus::Failed);
    assert_eq!(state.detail.as_deref(), Some("access_denied"));
    assert_eq!(rig.journal_len(), 1);
    assert_eq!(rig.apply(Some(&base_off())).state, LayerStatus::Ok);
    assert_eq!(rig.journal_len(), 0);
    assert_eq!(rig.staff_value_count(), 0);
}

#[test]
fn l1_never_touches_disable_lock_workstation_or_the_shell() {
    let rig = Rig::new();
    // Phase 2 wrote this one through its own seam method and keeps it.
    rig.platform.set_staff_user_policy(&rig.sid, "DisableLockWorkstation", Some(1)).unwrap();
    rig.apply(Some(&LockdownPolicy::default()));
    rig.apply(None);
    assert_eq!(rig.platform.with_world(|w| w.staff_policies.get(&(rig.sid.clone(), "DisableLockWorkstation".to_string())).copied()), Some(1));
    assert!(rig.platform.with_world(|w| w.staff_values.keys().all(|(_, _, name)| name != "disablelockworkstation" && name != "shell")));
    assert!(!planned_rows(Some(&LockdownPolicy::default())).iter().any(|r| r.name == "DisableLockWorkstation"));
}
