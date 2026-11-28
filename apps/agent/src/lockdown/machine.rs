//! L2: the machine policy catalogue of plan 4.8, as data, and the code that applies and
//! restores it. These values affect every account on the PC.
//!
//! * [`MACHINE_ITEMS`] is the fixed part of the catalogue (a DWORD each). Three more
//!   things are computed: the admin tiles (one value per enabled local administrator, found
//!   by the account's SID through the seam; the account **name** is only the registry value
//!   name `SpecialAccounts\UserList` is keyed by), the account lockout policy
//!   (`LockoutPolicy` in the journal), and the device-class rules of 4.7a.
//! * Every write goes through `journal::change` with owner `L2`; an item the document no
//!   longer wants is restored from its journalled original. A second run with the same
//!   document writes nothing.
//! * The USB deny lists come from `usb::generate` only (the lists invariant I10 checks).
//!   Right before they are written they pass `invariants::check_tables` once more, and the
//!   retroactive flag is written only when **every** class in the list allows it (Windows
//!   applies the flag to the whole list; a disk class in it would reach the machine's own
//!   disks), otherwise it is left out and the layer says `usb_retroactive_skipped`.
//! * `fileOutputPrinters` (Step 7) is in `printers.rs` and runs as part of this layer; `boot.*`
//!   is not here (`boot.rs`, layer L7).

use std::collections::HashSet;

use rulebox_policy::lockdown::{LockdownPolicy, UsbPolicy};
use rulebox_policy::AgentDoc;
use rulebox_win32::machinereg::DEVICE_INSTALL_RESTRICTIONS;

use super::apply::ApplyCtx;
use super::invariants::{self, Generated, MIN_LOCKOUT_THRESHOLD};
use super::printers;
use super::staff::Tally;
use super::usb::{self, DenyTables};
use super::{LayerState, ReportedMode};
use crate::journal::{self, Change, ChangeOutcome, JournalEntry, JournalOwner};
use crate::platform::{LockoutPolicy, RegData, RegValueRef};

const POL_SYSTEM: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System";
/// The admin-tile list: a value `<account name> = 0` hides the account on the sign-in screen.
pub const USER_LIST: &str = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon\SpecialAccounts\UserList";
/// "Require a password when a computer wakes" (GUID of the power setting).
const WAKE_PASSWORD: &str = r"SOFTWARE\Policies\Microsoft\Power\PowerSettings\0e796bdb-100d-47d6-a2d5-f7d2daa51f51";
const POINT_AND_PRINT: &str = r"SOFTWARE\Policies\Microsoft\Windows NT\Printers\PointAndPrint";
/// The value that switches the device-class deny list on, and the one for "also apply to
/// matching devices that are already installed".
pub const DENY_FLAG: &str = "DenyDeviceClasses";
pub const DENY_RETROACTIVE: &str = "DenyDeviceClassesRetroactive";
/// The journal id of the account lockout policy (`netmodals:lockout`, plan 4.4).
pub const LOCKOUT_ID: &str = "netmodals:lockout";

/// The list subkey of the class GUIDs: `...\Restrictions\DenyDeviceClasses`.
pub fn deny_list_key() -> String {
    format!(r"{DEVICE_INSTALL_RESTRICTIONS}\{DENY_FLAG}")
}

/// One DWORD value under HKLM.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MachineRow {
    /// Under `machinereg::ALLOWED_ROOTS`.
    pub path: &'static str,
    pub name: &'static str,
    pub value: u32,
}

const fn row(path: &'static str, name: &'static str, value: u32) -> MachineRow {
    MachineRow { path, name, value }
}

/// One fixed line of the catalogue of 4.8.
pub struct MachineItem {
    /// The document key (`hideSwitchUser`, ...).
    pub key: &'static str,
    pub wanted: fn(&LockdownPolicy) -> bool,
    pub rows: &'static [MachineRow],
    /// The checklist rows of the plan.
    pub checklist: &'static str,
}

/// The fixed items of plan 4.8. `hideAdminTiles`, `accountLockout` and the `usb.*` rows
/// are computed (see the module comment).
pub const MACHINE_ITEMS: &[MachineItem] = &[
    MachineItem {
        key: "hideSwitchUser",
        wanted: |p| p.machine.hide_switch_user,
        rows: &[row(POL_SYSTEM, "HideFastUserSwitching", 1)],
        checklist: "E-01..E-09",
    },
    MachineItem {
        key: "hideSignInPower",
        wanted: |p| p.machine.hide_sign_in_power,
        rows: &[row(POL_SYSTEM, "ShutdownWithoutLogon", 0)],
        checklist: "E-60..E-69",
    },
    MachineItem {
        key: "denyElevationRequests",
        wanted: |p| p.machine.deny_elevation_requests,
        rows: &[row(POL_SYSTEM, "ConsentPromptBehaviorUser", 0)],
        checklist: "E-30..E-39",
    },
    MachineItem {
        key: "noWakePassword",
        wanted: |p| p.machine.no_wake_password,
        rows: &[row(WAKE_PASSWORD, "ACSettingIndex", 0), row(WAKE_PASSWORD, "DCSettingIndex", 0)],
        checklist: "E-01..E-09",
    },
    MachineItem {
        key: "restrictPrinterDrivers",
        wanted: |p| p.machine.restrict_printer_drivers,
        rows: &[row(POINT_AND_PRINT, "RestrictDriverInstallationToAdministrators", 1)],
        checklist: "E-20..E-29",
    },
];

fn key_of(path: &str, name: &str) -> RegValueRef {
    RegValueRef { path: path.to_string(), name: name.to_string() }
}

/// The journal id of a fixed row.
pub fn row_id(row: &MachineRow) -> String {
    journal::machine_id(&key_of(row.path, row.name))
}

/// Every fixed row L2 writes for this document, in catalogue order.
pub fn planned_rows(policy: Option<&LockdownPolicy>) -> Vec<&'static MachineRow> {
    let Some(policy) = policy else {
        return Vec::new();
    };
    MACHINE_ITEMS.iter().filter(|item| (item.wanted)(policy)).flat_map(|item| item.rows.iter()).collect()
}

// ---------------------------------------------------------------- the lockout policy

/// The lockout policy a document asks for, in seconds. `None`: leave the machine's own.
pub fn wanted_lockout(policy: Option<&LockdownPolicy>) -> Option<LockoutPolicy> {
    let lockout = policy?.machine.account_lockout?;
    Some(LockoutPolicy {
        threshold: lockout.threshold,
        duration_s: lockout.duration_min.saturating_mul(60),
        window_s: lockout.window_min.saturating_mul(60),
    })
}

// ---------------------------------------------------------------- generated output for I10

/// Puts what this layer will write into the facts the invariants check (plan 4.6: they
/// look at generated output). The USB tables are those of the document as the layers see
/// it, a running `usbTempAllow` included. A table a test or an earlier step already put
/// there is kept and checked as well.
pub fn fill_generated(doc: &AgentDoc, generated: &mut Generated, now_ms: u64) {
    let doc = usb::with_temp_allow(doc, now_ms);
    if let Some(lockdown) = &doc.lockdown {
        generated.usb.get_or_insert_with(|| usb::generate(&lockdown.usb));
    }
}

// ---------------------------------------------------------------- apply

/// Applies or restores L2 for a verified document (plan 4.11 step 3). Idempotent: a
/// second run with the same document writes nothing. The layer reports `On` when the
/// document has a `lockdown` section and `Off` (everything restored) when it has none.
pub fn apply(ctx: &ApplyCtx<'_>, doc: &AgentDoc) -> LayerState {
    let doc = usb::with_temp_allow(doc, ctx.now_ms);
    let policy = doc.lockdown.as_ref();
    let mode = if policy.is_some() { ReportedMode::On } else { ReportedMode::Off };
    let mut tally = Tally::default();
    let mut restore: Vec<String> = Vec::new();

    for item in MACHINE_ITEMS {
        let wanted = policy.is_some_and(|p| (item.wanted)(p));
        for row in item.rows {
            if wanted {
                tally.record(write_row(ctx, row));
            } else {
                restore.push(row_id(row));
            }
        }
    }
    admin_tiles(ctx, policy, &mut tally, &mut restore);
    lockout(ctx, policy, &mut tally, &mut restore);
    device_classes(ctx, policy, &mut tally, &mut restore);
    // (Step 7) `fileOutputPrinters`: a deny-Print ACE for Staff on the file-output queues.
    printers::apply(ctx, policy, &mut tally, &mut restore);

    restore_present(ctx, &restore, &mut tally);
    LayerState { mode, state: tally.status(), detail: tally.detail() }
}

/// Restores the entries among `ids` that the journal holds (an item that was never
/// written costs nothing) and counts the result.
pub(super) fn restore_present(ctx: &ApplyCtx<'_>, ids: &[String], tally: &mut Tally) {
    let present: Vec<String> = ctx
        .journal
        .shared
        .read(|state| ids.iter().filter(|id| state.journal.iter().any(|entry| &entry.id == *id)).cloned().collect());
    if present.is_empty() {
        return;
    }
    let report = journal::restore_ids(&ctx.journal, &present);
    for _ in &report.restored {
        tally.record(Ok(()));
    }
    for (_, error) in &report.failed {
        tally.record(Err(journal::error_code(error)));
    }
}

fn dword_change(ctx: &ApplyCtx<'_>, path: &str, name: &str, value: u32) -> Result<ChangeOutcome, &'static str> {
    let change = Change::machine(JournalOwner::L2, key_of(path, name), Some(RegData::Dword(value))).since(ctx.version);
    journal::change(&ctx.journal, &change).map_err(|error| journal::error_code(&error))
}

fn write_row(ctx: &ApplyCtx<'_>, row: &MachineRow) -> Result<(), &'static str> {
    dword_change(ctx, row.path, row.name, row.value).map(|_| ())
}

/// The journal entries of owner `L2` whose HKLM value is `path` or below it.
fn l2_entries_under(ctx: &ApplyCtx<'_>, root: &str) -> Vec<JournalEntry> {
    let root = root.trim_matches('\\').to_ascii_lowercase();
    ctx.journal.shared.read(|state| {
        state
            .journal
            .iter()
            .filter(|entry| entry.owner == JournalOwner::L2)
            .filter(|entry| {
                entry.machine_key().is_some_and(|key| {
                    let path = key.path.trim_matches('\\').to_ascii_lowercase();
                    path == root || path.starts_with(&format!("{root}\\"))
                })
            })
            .cloned()
            .collect()
    })
}

// ---------------------------------------------------------------- admin tiles

/// The note a layer reports when `hideAdminTiles` is on but E-71 is not recorded (not a failure).
pub const ADMIN_TILES_SKIPPED: &str = "admin_tiles_skipped";

/// `hideAdminTiles` (Q5): `UserList\<account name> = 0` for each enabled local
/// administrator. Held back unless the E-71 flag is set (I7, owner decision 2026-11-28): only
/// this option is skipped, the rest of the document applies, and the layer reports the note
/// [`ADMIN_TILES_SKIPPED`]. Tiles written earlier (the flag was set before) are put back, as for
/// an option that is off. A list that cannot be read changes nothing.
fn admin_tiles(ctx: &ApplyCtx<'_>, policy: Option<&LockdownPolicy>, tally: &mut Tally, restore: &mut Vec<String>) {
    let wanted = policy.is_some_and(|p| p.machine.hide_admin_tiles);
    let mut keep: HashSet<String> = HashSet::new();
    if wanted && !ctx.facts.admin_signin_verified {
        tally.note.get_or_insert(ADMIN_TILES_SKIPPED);
    } else if wanted {
        let admins = match ctx.journal.platform.enabled_local_admin_accounts() {
            Ok(admins) => admins,
            Err(_) => {
                tally.record(Err("admin_list_unreadable"));
                return;
            }
        };
        for admin in admins.iter().filter(|admin| !admin.name.is_empty()) {
            keep.insert(journal::machine_id(&key_of(USER_LIST, &admin.name)).to_ascii_lowercase());
            tally.record(dword_change(ctx, USER_LIST, &admin.name, 0).map(|_| ()));
        }
    }
    // Tiles of accounts that are gone or no longer wanted go back to what they were.
    for entry in l2_entries_under(ctx, USER_LIST) {
        if !keep.contains(&entry.id.to_ascii_lowercase()) {
            restore.push(entry.id);
        }
    }
}

// ---------------------------------------------------------------- account lockout

fn lockout(ctx: &ApplyCtx<'_>, policy: Option<&LockdownPolicy>, tally: &mut Tally, restore: &mut Vec<String>) {
    let Some(wanted) = wanted_lockout(policy) else {
        restore.push(LOCKOUT_ID.to_string());
        return;
    };
    if wanted.threshold < MIN_LOCKOUT_THRESHOLD {
        tally.record(Err("lockout_threshold_too_low"));
        return;
    }
    if wanted.window_s > wanted.duration_s {
        tally.record(Err("lockout_window_too_long"));
        return;
    }
    let change = Change::lockout(JournalOwner::L2, wanted).since(ctx.version);
    tally.record(journal::change(&ctx.journal, &change).map(|_| ()).map_err(|error| journal::error_code(&error)));
}

// ---------------------------------------------------------------- device classes (4.7a)

/// `{guid}` with braces, lower case: the form the policy list holds.
fn braced(guid: &str) -> String {
    format!("{{{}}}", usb::norm_guid(guid))
}

/// True when the usb section has a value this agent does not know (4.3 rule 2: keep the
/// last applied rules and report `section_unknown_value`).
fn usb_has_unknown(usb: &UsbPolicy) -> bool {
    use rulebox_policy::lockdown::{UsbStorageMode, UsbSwitch};
    usb.storage == UsbStorageMode::Unknown
        || [usb.printers, usb.imaging, usb.phones, usb.other].contains(&UsbSwitch::Unknown)
}

/// The machine-wide deny classes: `DeviceInstall\Restrictions`, from [`DenyTables`] only.
fn device_classes(ctx: &ApplyCtx<'_>, policy: Option<&LockdownPolicy>, tally: &mut Tally, restore: &mut Vec<String>) {
    if policy.is_some_and(|p| usb_has_unknown(&p.usb)) {
        tally.note.get_or_insert("section_unknown_value");
        return;
    }
    let tables: DenyTables = policy.map(|p| usb::generate(&p.usb)).unwrap_or_default();
    apply_tables(ctx, &tables, tally, restore);
}

/// Writes the machine part of `tables` (and queues the restore of what is no longer
/// wanted). Split from [`device_classes`] so the checks run on exactly the lists written.
fn apply_tables(ctx: &ApplyCtx<'_>, tables: &DenyTables, tally: &mut Tally, restore: &mut Vec<String>) {
    // I10 again, on the exact lists about to be written. Nothing is written on a refusal.
    if let Err(refusal) = invariants::check_tables(tables) {
        tally.record(Err(refusal.code()));
        return;
    }
    let mut keep: HashSet<String> = HashSet::new();
    if !tables.machine.is_empty() {
        let list_key = deny_list_key();
        let Ok(existing) = ctx.journal.platform.list_machine_value_names(&list_key) else {
            tally.record(Err("device_list_unreadable"));
            return;
        };

        keep.insert(journal::machine_id(&key_of(DEVICE_INSTALL_RESTRICTIONS, DENY_FLAG)).to_ascii_lowercase());
        tally.record(dword_change(ctx, DEVICE_INSTALL_RESTRICTIONS, DENY_FLAG, 1).map(|_| ()));

        // Retroactive: one flag for the whole list, so only when every class allows it.
        if tables.retroactive {
            if tables.retroactive_classes().len() == tables.machine.len() {
                keep.insert(journal::machine_id(&key_of(DEVICE_INSTALL_RESTRICTIONS, DENY_RETROACTIVE)).to_ascii_lowercase());
                tally.record(dword_change(ctx, DEVICE_INSTALL_RESTRICTIONS, DENY_RETROACTIVE, 1).map(|_| ()));
            } else {
                tally.note.get_or_insert("usb_retroactive_skipped");
            }
        }

        // One value per class GUID. A GUID that is already in the list (ours, or an
        // administrator's own policy) is not added twice; a free name is the lowest number.
        let mut taken: HashSet<String> = existing.iter().map(|name| name.to_ascii_lowercase()).collect();
        for class in &tables.machine {
            let guid = braced(&class.guid);
            let holder = existing.iter().find(|name| {
                matches!(
                    ctx.journal.platform.read_machine_value(&key_of(&list_key, name)),
                    Ok(Some(RegData::String(text))) if usb::norm_guid(&text) == usb::norm_guid(&guid)
                )
            });
            if let Some(name) = holder {
                let id = journal::machine_id(&key_of(&list_key, name));
                if l2_entries_under(ctx, &list_key).iter().any(|entry| entry.id == id) {
                    keep.insert(id.to_ascii_lowercase());
                }
                continue;
            }
            let Some(name) = (1u32..).map(|n| n.to_string()).find(|n| !taken.contains(n)) else {
                tally.record(Err("device_list_full"));
                continue;
            };
            taken.insert(name.clone());
            keep.insert(journal::machine_id(&key_of(&list_key, &name)).to_ascii_lowercase());
            let change = Change::machine(JournalOwner::L2, key_of(&list_key, &name), Some(RegData::String(guid)))
                .since(ctx.version);
            tally.record(journal::change(&ctx.journal, &change).map(|_| ()).map_err(|error| journal::error_code(&error)));
        }
    }
    // Everything of ours under the restrictions key that this document does not need.
    for entry in l2_entries_under(ctx, DEVICE_INSTALL_RESTRICTIONS) {
        if !keep.contains(&entry.id.to_ascii_lowercase()) {
            restore.push(entry.id);
        }
    }
}

#[cfg(test)]
mod tests;
