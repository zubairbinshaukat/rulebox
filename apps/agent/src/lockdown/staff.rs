//! L1: the Staff policy catalogue of plan 4.7, as data, and the code that applies and
//! restores it.
//!
//! * [`STAFF_ITEMS`] is the complete list (adding one is a plan change). Every row is a
//!   value in the Staff account's own hive under `staffreg::ALLOWED_ROOTS`; a test
//!   checks that with the real `staffreg::check_write`.
//! * Every write goes through `journal::change` with owner `L1`: the original is saved
//!   first and "Disable kiosk", `unenroll` and `recover` put it back exactly (absent,
//!   DWORD or string). An item that is not wanted any more is restored the same way.
//! * The accessibility flags are computed from the value that is there (only the
//!   hotkey bit changes) and the original string is what the journal restores.
//! * `DisableLockWorkstation` is in the catalogue but stays owned by the Phase 2 kiosk
//!   code (`kiosk.rs`, `recover.rs`): L1 neither writes nor restores it (see
//!   [`ItemOwner::Kiosk`]).
//! * `usb.storage` and `usb.phones` (4.7a) are items like the rest; what they write is
//!   decided by `usb::generate`, the same lists invariant I10 checks.

use rulebox_policy::lockdown::{LockdownPolicy, WinCombos};
use rulebox_policy::AgentDoc;

use super::apply::ApplyCtx;
use super::usb::{self, StaffStorage};
use super::{LayerState, LayerStatus, ReportedMode};
use crate::journal::{self, Change, ChangeOutcome, JournalOwner};
use crate::platform::RegData;

const POL_SYSTEM: &str = r"Software\Microsoft\Windows\CurrentVersion\Policies\System";
const POL_EXPLORER: &str = r"Software\Microsoft\Windows\CurrentVersion\Policies\Explorer";
const WIN_SYSTEM: &str = r"Software\Policies\Microsoft\Windows\System";
const DESKTOP: &str = r"Software\Policies\Microsoft\Windows\Control Panel\Desktop";
const REMOVABLE: &str = r"Software\Policies\Microsoft\Windows\RemovableStorageDevices";
const OFFICE: &str = r"Software\Policies\Microsoft\Office\16.0";
const ACCESSIBILITY: &str = r"Control Panel\Accessibility";

/// The accessibility hotkey bit of `StickyKeys`, `FilterKeys`, `ToggleKeys` and
/// `MouseKeys` `Flags` (`*KF_HOTKEYACTIVE`, 0x4).
pub const HOTKEY_ACTIVE: u32 = 0x4;

/// What a row writes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RowValue {
    Dword(u32),
    Text(&'static str),
    /// `Flags` (REG_SZ): the current value with [`HOTKEY_ACTIVE`] cleared. `default` is
    /// Windows' own value, used only when the Staff hive has none (unverified, VM run).
    AccessibilityFlags { default: &'static str },
}

/// One value in the Staff hive.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StaffRow {
    /// Relative to the hive; under `staffreg::ALLOWED_ROOTS`.
    pub path: &'static str,
    pub name: &'static str,
    pub value: RowValue,
}

const fn dword(path: &'static str, name: &'static str, value: u32) -> StaffRow {
    StaffRow { path, name, value: RowValue::Dword(value) }
}

/// Who writes an item.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ItemOwner {
    /// This layer, journal owner `L1`.
    L1,
    /// The Phase 2 kiosk code (it has its own record and restore).
    Kiosk,
}

/// One line of the catalogue of 4.7.
pub struct StaffItem {
    /// The document key (`taskManager`, `usb.storage`, ...).
    pub key: &'static str,
    pub owner: ItemOwner,
    /// Whether the document wants this item written.
    pub wanted: fn(&LockdownPolicy) -> bool,
    pub rows: &'static [StaffRow],
    /// The checklist rows of the plan.
    pub checklist: &'static str,
}

fn always(_: &LockdownPolicy) -> bool {
    true
}

fn usb_staff(policy: &LockdownPolicy) -> usb::StaffUsbRules {
    usb::generate(&policy.usb).staff
}

/// `StickyKeys`, `FilterKeys`, `ToggleKeys` and `MouseKeys`: with the hotkey bit set,
/// Windows' defaults are 510, 126, 62 and 190 (unverified until the VM run).
const ACCESSIBILITY_ROWS: &[StaffRow] = &[
    StaffRow {
        path: r"Control Panel\Accessibility\StickyKeys",
        name: "Flags",
        value: RowValue::AccessibilityFlags { default: "510" },
    },
    StaffRow {
        path: r"Control Panel\Accessibility\Keyboard Response",
        name: "Flags",
        value: RowValue::AccessibilityFlags { default: "126" },
    },
    StaffRow {
        path: r"Control Panel\Accessibility\ToggleKeys",
        name: "Flags",
        value: RowValue::AccessibilityFlags { default: "62" },
    },
    StaffRow {
        path: r"Control Panel\Accessibility\MouseKeys",
        name: "Flags",
        value: RowValue::AccessibilityFlags { default: "190" },
    },
];

/// The complete Staff catalogue (plan 4.7). `FilterKeys` lives under `Keyboard Response`.
pub const STAFF_ITEMS: &[StaffItem] = &[
    StaffItem {
        key: "taskManager",
        owner: ItemOwner::L1,
        wanted: |p| p.staff.task_manager,
        rows: &[dword(POL_SYSTEM, "DisableTaskMgr", 1)],
        checklist: "E-01..E-09",
    },
    StaffItem {
        key: "signOut",
        owner: ItemOwner::L1,
        wanted: |p| p.staff.sign_out,
        rows: &[dword(POL_EXPLORER, "NoLogoff", 1)],
        checklist: "E-01..E-09",
    },
    StaffItem {
        key: "changePassword",
        owner: ItemOwner::L1,
        wanted: |p| p.staff.change_password,
        rows: &[dword(POL_SYSTEM, "DisableChangePassword", 1)],
        checklist: "E-01..E-09",
    },
    // Phase 2: written by `kiosk.rs` when the kiosk is enabled, removed by Disable and `recover`.
    StaffItem {
        key: "(always) lockWorkstation",
        owner: ItemOwner::Kiosk,
        wanted: always,
        rows: &[dword(POL_SYSTEM, "DisableLockWorkstation", 1)],
        checklist: "E-01..E-09",
    },
    StaffItem {
        key: "run",
        owner: ItemOwner::L1,
        wanted: |p| p.staff.run,
        rows: &[dword(POL_EXPLORER, "NoRun", 1)],
        checklist: "E-10..E-19",
    },
    StaffItem {
        key: "commandPrompt",
        owner: ItemOwner::L1,
        wanted: |p| p.staff.command_prompt,
        rows: &[dword(WIN_SYSTEM, "DisableCMD", 1)],
        checklist: "E-30..E-39",
    },
    StaffItem {
        key: "registryTools",
        owner: ItemOwner::L1,
        wanted: |p| p.staff.registry_tools,
        rows: &[dword(POL_SYSTEM, "DisableRegistryTools", 1)],
        checklist: "E-30..E-39",
    },
    StaffItem {
        key: "settings",
        owner: ItemOwner::L1,
        wanted: |p| p.staff.settings,
        rows: &[dword(POL_EXPLORER, "NoControlPanel", 1)],
        checklist: "E-20..E-29",
    },
    StaffItem {
        key: "hideDrives",
        owner: ItemOwner::L1,
        wanted: |p| p.staff.hide_drives,
        rows: &[dword(POL_EXPLORER, "NoDrives", 0x03FF_FFFF)],
        checklist: "E-20..E-29",
    },
    // "(with keyboard)": the Windows-key shortcuts are off while the hook swallows them.
    StaffItem {
        key: "(with keyboard) noWinKeys",
        owner: ItemOwner::L1,
        wanted: |p| p.keyboard.win_combos == WinCombos::Swallow,
        rows: &[dword(POL_EXPLORER, "NoWinKeys", 1)],
        checklist: "E-10..E-19",
    },
    StaffItem {
        key: "accessibilityHotkeys",
        owner: ItemOwner::L1,
        wanted: |p| p.staff.accessibility_hotkeys,
        rows: ACCESSIBILITY_ROWS,
        checklist: "E-50..E-59",
    },
    StaffItem {
        key: "officeMacros",
        owner: ItemOwner::L1,
        wanted: |p| p.staff.office_macros,
        rows: &[
            dword(r"Software\Policies\Microsoft\Office\16.0\word\security", "VBAWarnings", 4),
            dword(r"Software\Policies\Microsoft\Office\16.0\excel\security", "VBAWarnings", 4),
            dword(r"Software\Policies\Microsoft\Office\16.0\powerpoint\security", "VBAWarnings", 4),
            dword(r"Software\Policies\Microsoft\Office\16.0\word\security", "blockcontentexecutionfrominternet", 1),
            dword(r"Software\Policies\Microsoft\Office\16.0\excel\security", "blockcontentexecutionfrominternet", 1),
            dword(r"Software\Policies\Microsoft\Office\16.0\powerpoint\security", "blockcontentexecutionfrominternet", 1),
        ],
        checklist: "E-20..E-29",
    },
    StaffItem {
        key: "(always with noWakePassword) screenSaverIsSecure",
        owner: ItemOwner::L1,
        wanted: |p| p.machine.no_wake_password,
        rows: &[StaffRow { path: DESKTOP, name: "ScreenSaverIsSecure", value: RowValue::Text("0") }],
        checklist: "E-01..E-09",
    },
    StaffItem {
        key: "usb.storage=readOnly",
        owner: ItemOwner::L1,
        wanted: |p| usb_staff(p).storage == Some(StaffStorage::ReadOnly),
        rows: &[dword(REMOVABLE, "Deny_Write", 1)],
        checklist: "E-39, E-66..E-69",
    },
    StaffItem {
        key: "usb.storage=block",
        owner: ItemOwner::L1,
        wanted: |p| usb_staff(p).storage == Some(StaffStorage::Block),
        rows: &[dword(REMOVABLE, "Deny_All", 1)],
        checklist: "E-39, E-66..E-69",
    },
    // The two WPD GUIDs of `usb::STAFF_WPD_GUIDS` (a test compares them).
    StaffItem {
        key: "usb.phones=block",
        owner: ItemOwner::L1,
        wanted: |p| !usb_staff(p).wpd_guids.is_empty(),
        rows: &[
            dword(r"Software\Policies\Microsoft\Windows\RemovableStorageDevices\{6AC27878-A6FA-4155-BA85-F98F491D4F33}", "Deny_Read", 1),
            dword(r"Software\Policies\Microsoft\Windows\RemovableStorageDevices\{6AC27878-A6FA-4155-BA85-F98F491D4F33}", "Deny_Write", 1),
            dword(r"Software\Policies\Microsoft\Windows\RemovableStorageDevices\{F33FDC04-D1AC-4E8E-9A30-19BBD4B108AE}", "Deny_Read", 1),
            dword(r"Software\Policies\Microsoft\Windows\RemovableStorageDevices\{F33FDC04-D1AC-4E8E-9A30-19BBD4B108AE}", "Deny_Write", 1),
        ],
        checklist: "E-66..E-69",
    },
];

// ---------------------------------------------------------------- planning

/// The rows L1 writes for this document, in catalogue order. `None` (no `lockdown`
/// key) is "everything restored": no rows.
pub fn planned_rows(policy: Option<&LockdownPolicy>) -> Vec<&'static StaffRow> {
    let Some(policy) = policy else {
        return Vec::new();
    };
    STAFF_ITEMS
        .iter()
        .filter(|item| item.owner == ItemOwner::L1 && (item.wanted)(policy))
        .flat_map(|item| item.rows.iter())
        .collect()
}

/// The journal id of a row.
pub fn row_id(row: &StaffRow) -> String {
    journal::staff_id(row.path, row.name)
}

/// The text with the hotkey bit cleared. `None` when the text is not a plain decimal
/// number (then the value is left alone and reported).
pub fn clear_hotkey_bit(flags: &str) -> Option<String> {
    let number: u32 = flags.trim().parse().ok()?;
    Some((number & !HOTKEY_ACTIVE).to_string())
}

// ---------------------------------------------------------------- apply

/// Applies or restores L1 for a verified document (4.11, step 3). Idempotent: a second
/// run with the same document writes nothing. The layer reports `On` when the document
/// has a `lockdown` section and `Off` (everything restored) when it has none.
pub fn apply(ctx: &ApplyCtx<'_>, doc: &AgentDoc) -> LayerState {
    let policy = doc.lockdown.as_ref();
    let mode = if policy.is_some() { ReportedMode::On } else { ReportedMode::Off };
    let journal_ctx = &ctx.journal;
    let mut tally = Tally::default();

    let has_staff = journal_ctx.shared.read(|state| state.staff.is_some());
    let mut to_restore: Vec<String> = Vec::new();
    for item in STAFF_ITEMS.iter().filter(|item| item.owner == ItemOwner::L1) {
        let wanted = policy.is_some_and(|p| (item.wanted)(p));
        if !wanted {
            to_restore.extend(item.rows.iter().map(row_id));
            continue;
        }
        for row in item.rows {
            if !has_staff {
                tally.record(Err("no_staff_account"));
            } else {
                tally.record(write_row(ctx, row).map(|_| ()));
            }
        }
    }

    // Items that are no longer wanted: put the original back (an item that was never
    // written has no journal entry and costs nothing).
    let present: Vec<String> = journal_ctx
        .shared
        .read(|state| to_restore.iter().filter(|id| state.journal.iter().any(|entry| &entry.id == *id)).cloned().collect());
    if !present.is_empty() {
        let report = journal::restore_ids(journal_ctx, &present);
        for _ in &report.restored {
            tally.record(Ok(()));
        }
        for (_, error) in &report.failed {
            tally.record(Err(journal::error_code(error)));
        }
    }

    // (Phase 6 Step 17) The browser policies of browser web apps (owner `L1-browser`) are part of this layer.
    let browser = super::browser::apply(ctx, doc, &mut tally);
    let mode = if browser.active { ReportedMode::On } else { mode };

    LayerState { mode, state: tally.status(), detail: tally.first_error.map(str::to_string) }
}

/// Counts what the layer did, for its state. (Shared with the machine and boot layers.)
#[derive(Default)]
pub(super) struct Tally {
    attempts: usize,
    failures: usize,
    pub(super) first_error: Option<&'static str>,
    /// A fixed code that is not a failure (reported as the detail when nothing failed).
    pub(super) note: Option<&'static str>,
}

impl Tally {
    pub(super) fn record(&mut self, result: Result<(), &'static str>) {
        self.attempts += 1;
        if let Err(code) = result {
            self.failures += 1;
            self.first_error.get_or_insert(code);
        }
    }

    pub(super) fn status(&self) -> LayerStatus {
        match (self.failures, self.attempts) {
            (0, _) => LayerStatus::Ok,
            (failed, all) if failed >= all => LayerStatus::Failed,
            _ => LayerStatus::Partial,
        }
    }

    /// The detail code of the layer state: the first failure, else the note.
    pub(super) fn detail(&self) -> Option<String> {
        self.first_error.or(self.note).map(str::to_string)
    }
}
/// Writes one row through the journal. The error is a fixed code.
fn write_row(ctx: &ApplyCtx<'_>, row: &StaffRow) -> Result<ChangeOutcome, &'static str> {
    let desired = match row.value {
        RowValue::Dword(value) => RegData::Dword(value),
        RowValue::Text(text) => RegData::String(text.to_string()),
        RowValue::AccessibilityFlags { default } => {
            let sid = ctx
                .journal
                .shared
                .read(|state| state.staff.as_ref().map(|staff| staff.sid.clone()))
                .ok_or("no_staff_account")?;
            let current = ctx
                .journal
                .platform
                .read_staff_value(&sid, row.path, row.name)
                .map_err(|_| "staff_value_unreadable")?;
            let text = match current {
                None => default.to_string(),
                Some(RegData::String(text)) => text,
                Some(RegData::Dword(_)) => return Err("accessibility_flags_unreadable"),
            };
            RegData::String(clear_hotkey_bit(&text).ok_or("accessibility_flags_unreadable")?)
        }
    };
    let change = Change::staff(JournalOwner::L1, row.path, row.name, Some(desired)).since(ctx.version);
    journal::change(&ctx.journal, &change).map_err(|error| journal::error_code(&error))
}

#[cfg(test)]
mod tests;
