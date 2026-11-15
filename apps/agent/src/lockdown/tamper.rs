//! L7, the tamper part (plan 4.16, Step 17): what keeps a Staff process from stopping or
//! changing the agent, and what tells the owner when somebody with more rights did.
//!
//! * **Service DACL.** `RuleboxAgent` gets `service::AGENT_SERVICE_SDDL`: SYSTEM and
//!   Administrators everything, everybody else "query the status" only. Journalled as
//!   `svc-sec:RuleboxAgent` with the DACL that was there.
//! * **Required privileges.** The service keeps `service::AGENT_REQUIRED_PRIVILEGES` only
//!   (Windows applies the list at the next service start). Journalled as
//!   `svc-priv:RuleboxAgent`.
//! * **Folder ACLs.** The install folder (`security::INSTALL_DIR_SDDL`) and the `state` folder
//!   (`security::PROTECTED_DIR_SDDL`, the Phase 2 DACL). Journalled as `path-acl:install` and
//!   `path-acl:state`.
//! * **Self-check.** [`apply`] runs with the boot layer on every reconcile pass. An item that
//!   was applied and no longer holds its value is written again by `journal::change`, which
//!   notes it (`SharedState::note_tamper`). [`TamperTracker::finish_pass`] turns the notes into
//!   `deviceSecurityDaily.tamper`, one `device.tamperDetected` audit record per item per server
//!   day, and the two report fields `serviceAcl` / `aclDrift`.
//! * **Clock.** [`ClockWatch`] compares the wall clock with the time since boot. A jump of more
//!   than ten minutes is audited once (`device.clockJump`); a jump backwards also raises the
//!   "highest clock seen" floor of Phase 2 by the time that really passed, so setting the clock
//!   back never extends the offline sign-in period.
//!
//! None of this protects against an administrator: an administrator can stop the service,
//! change its files and undo every item here. Such a change is put back and reported, no more.
//!
//! The items are on while the document has a `lockdown` section and are restored (the journal
//! puts the originals back) when it has none, like the rest of L7.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use rulebox_win32::security::{same_dacl, INSTALL_DIR_SDDL, PROTECTED_DIR_SDDL};
use rulebox_win32::service::{AGENT_REQUIRED_PRIVILEGES, AGENT_SERVICE, AGENT_SERVICE_SDDL};

use super::apply::ApplyCtx;
use super::boot::SecurityReport;
use super::daily::{server_day, DailyCounters};
use super::staff::Tally;
use crate::audit::AuditKind;
use crate::journal::{self, Change, ChangeOutcome, JournalCtx, JournalOwner};
use crate::platform::{BootIdentity, Platform};
use crate::state::SharedState;

/// The layer note when an item was written but does not read back as written (Windows spelled
/// the value another way). Not a failure and not counted as tampering.
pub const READBACK_DIFFERS: &str = "acl_readback_differs";

/// The two folders whose ACLs are checked (plan 4.16).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuleboxFolders {
    /// `%ProgramFiles%\Rulebox`.
    pub install_root: PathBuf,
    /// `%ProgramData%\Rulebox\state`.
    pub state_dir: PathBuf,
}

/// One thing tamper protection keeps as it should be.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Item {
    ServiceAcl,
    ServicePrivileges,
    InstallAcl,
    StateAcl,
}

impl Item {
    pub const ALL: [Item; 4] = [Item::ServiceAcl, Item::ServicePrivileges, Item::InstallAcl, Item::StateAcl];

    /// The fixed code of the audit record's `detail` (never a path or a name from the PC).
    pub fn code(self) -> &'static str {
        match self {
            Item::ServiceAcl => "service_acl",
            Item::ServicePrivileges => "service_privileges",
            Item::InstallAcl => "install_acl",
            Item::StateAcl => "state_acl",
        }
    }

    /// The journal id.
    pub fn id(self) -> String {
        match self {
            Item::ServiceAcl => journal::service_security_id(AGENT_SERVICE),
            Item::ServicePrivileges => journal::service_privileges_id(AGENT_SERVICE),
            Item::InstallAcl => journal::path_acl_id("install"),
            Item::StateAcl => journal::path_acl_id("state"),
        }
    }

    fn from_id(id: &str) -> Option<Item> {
        Item::ALL.into_iter().find(|item| item.id() == id)
    }

    fn folder(self, folders: &RuleboxFolders) -> Option<(&Path, &'static str)> {
        match self {
            Item::InstallAcl => Some((&folders.install_root, INSTALL_DIR_SDDL)),
            Item::StateAcl => Some((&folders.state_dir, PROTECTED_DIR_SDDL)),
            Item::ServiceAcl | Item::ServicePrivileges => None,
        }
    }
}

/// The journal change of `item`; `None` for a folder item when the folders are not known.
fn change_of(item: Item, folders: Option<&RuleboxFolders>) -> Option<Change> {
    let change = match item {
        Item::ServiceAcl => Change::service_security(JournalOwner::L7, AGENT_SERVICE, AGENT_SERVICE_SDDL),
        Item::ServicePrivileges => Change::service_privileges(JournalOwner::L7, AGENT_SERVICE, AGENT_REQUIRED_PRIVILEGES),
        Item::InstallAcl | Item::StateAcl => {
            let (path, sddl) = item.folder(folders?)?;
            let label = if item == Item::InstallAcl { "install" } else { "state" };
            Change::path_acl(JournalOwner::L7, label, path, sddl)
        }
    };
    // Always recorded: the original must be the value from before Rulebox, also when that
    // value already was the wanted one (else a later repair would record the tampered value).
    Some(change.always_record())
}

/// Whether `item` holds its wanted value now. `None`: it cannot be read, or it is not there.
/// Read-only.
pub fn holds(platform: &dyn Platform, folders: Option<&RuleboxFolders>, item: Item) -> Option<bool> {
    match item {
        Item::ServiceAcl => {
            platform.get_service_security(AGENT_SERVICE).ok().flatten().map(|now| same_dacl(&now, AGENT_SERVICE_SDDL))
        }
        Item::ServicePrivileges => {
            let mut now = platform.get_service_required_privileges(AGENT_SERVICE).ok()?;
            let mut wanted: Vec<String> = AGENT_REQUIRED_PRIVILEGES.iter().map(|p| (*p).to_string()).collect();
            now.sort();
            wanted.sort();
            Some(now == wanted)
        }
        Item::InstallAcl | Item::StateAcl => {
            let (path, sddl) = item.folder(folders?)?;
            platform.get_path_acl(path).ok().flatten().map(|now| same_dacl(&now, sddl))
        }
    }
}

/// Asserts one item through the journal and counts the result.
fn assert_item(ctx: &ApplyCtx<'_>, item: Item, tally: &mut Tally) {
    let folders = ctx.facts.rulebox_folders.as_ref();
    let Some(change) = change_of(item, folders) else {
        return;
    };
    let change = change.since(ctx.version);
    match journal::change(&ctx.journal, &change) {
        Ok(ChangeOutcome::Written) => {
            if holds(ctx.journal.platform, folders, item) == Some(false) {
                // Written, but Windows hands the value back in another spelling. Writing it
                // again every pass must not look like somebody tampering with it.
                ctx.journal.shared.forget_tamper(&change.id);
                tally.note.get_or_insert(READBACK_DIFFERS);
            }
            tally.record(Ok(()));
        }
        Ok(_) => tally.record(Ok(())),
        Err(error) => tally.record(Err(journal::error_code(&error))),
    }
}

/// The tamper part of the boot layer (called by `boot::apply`). `on`: the document has a
/// `lockdown` section. Off: the ids go to `restore` and the journal puts the originals back.
/// Idempotent; every write goes through `journal::change`.
pub(super) fn apply(ctx: &ApplyCtx<'_>, on: bool, tally: &mut Tally, restore: &mut Vec<String>) {
    if !on {
        restore.extend(Item::ALL.into_iter().map(Item::id));
        return;
    }
    let platform = ctx.journal.platform;

    // The service. The privileges go first: changing them needs the "change configuration"
    // right, which the DACL of 4.16 leaves to SYSTEM (the agent) and Administrators anyway.
    match platform.get_service_security(AGENT_SERVICE) {
        Ok(Some(_)) => {
            assert_item(ctx, Item::ServicePrivileges, tally);
            assert_item(ctx, Item::ServiceAcl, tally);
        }
        // No service (the agent runs in a console for debugging): nothing to protect.
        Ok(None) => {}
        Err(_) => tally.record(Err("service_unreadable")),
    }

    // The folders. One that does not exist has nothing to protect.
    if let Some(folders) = ctx.facts.rulebox_folders.as_ref() {
        for item in [Item::InstallAcl, Item::StateAcl] {
            let Some((path, _)) = item.folder(folders) else {
                continue;
            };
            match platform.get_path_acl(path) {
                Ok(Some(_)) => assert_item(ctx, item, tally),
                Ok(None) => {}
                Err(_) => tally.record(Err("acl_unreadable")),
            }
        }
    }
}

// ---------------------------------------------------------------- counting and reporting

/// What one pass found.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct TamperOutcome {
    /// Items that had to be put back in this pass.
    pub repaired: Vec<Item>,
    /// How many of them were audited (the first of each item per server day).
    pub audited: u64,
}

/// Turns the journal's tamper notes into counters, audit records and report fields. Held by
/// the lockdown runtime (Step 20), which calls [`finish_pass`](Self::finish_pass) after every apply.
#[derive(Default)]
pub struct TamperTracker {
    /// `(item, server day)` pairs already audited.
    audited: HashSet<(Item, String)>,
    /// Folder ACL repairs since the agent started (`aclDrift`).
    acl_repairs: u64,
    /// The service DACL had to be put back in the last pass.
    service_repaired: bool,
}

impl TamperTracker {
    pub fn new() -> Self {
        Self::default()
    }

    /// Reads the items the journal put back during the pass that just ran: each one counts in
    /// `deviceSecurityDaily.tamper`; the first of each item per server day is audited
    /// (`device.tamperDetected`, the item's fixed code as the detail).
    pub fn finish_pass(
        &mut self,
        shared: &SharedState,
        daily: &mut DailyCounters,
        now_ms: u64,
        server_offset_ms: Option<i64>,
        audit: &mut dyn FnMut(AuditKind, String),
    ) -> TamperOutcome {
        let day = server_day(now_ms, server_offset_ms);
        self.audited.retain(|(_, audited_day)| *audited_day == day);
        self.service_repaired = false;
        let mut outcome = TamperOutcome::default();
        for item in shared.take_tampered().iter().filter_map(|id| Item::from_id(id)) {
            match item {
                Item::ServiceAcl => self.service_repaired = true,
                Item::InstallAcl | Item::StateAcl => self.acl_repairs = self.acl_repairs.saturating_add(1),
                Item::ServicePrivileges => {}
            }
            if self.audited.insert((item, day.clone())) {
                audit(AuditKind::DeviceTamperDetected, item.code().to_string());
                outcome.audited += 1;
            }
            outcome.repaired.push(item);
        }
        daily.add_tamper(&day, outcome.repaired.len() as u64);
        outcome
    }

    /// Fills `serviceAcl` and `aclDrift` of the security report (plan 4.16). Both stay absent
    /// while tamper protection is off (no journal entry for the service DACL). `serviceAcl` is
    /// `"drift"` when the last pass had to put the DACL back, or when it does not hold now.
    pub fn fill_report(&self, ctx: &JournalCtx<'_>, report: &mut SecurityReport) {
        let id = Item::ServiceAcl.id();
        if !ctx.shared.read(|state| state.journal.iter().any(|entry| entry.id == id)) {
            return;
        }
        let holds_now = holds(ctx.platform, None, Item::ServiceAcl) == Some(true);
        report.service_acl = Some(if self.service_repaired || !holds_now { "drift" } else { "ok" });
        report.acl_drift = Some(self.acl_repairs);
    }
}

// ---------------------------------------------------------------- the clock

/// A wall-clock change of more than this against the time since boot is a jump (plan 4.16).
pub const CLOCK_JUMP_MS: u64 = 600_000;
/// The comparison starts again after this long without a jump, so the slow drift between the
/// two clocks of a PC that is never restarted does not add up to a "jump".
const REBASE_AFTER_MS: u64 = 86_400_000;

/// What [`ClockWatch::observe`] found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClockJump {
    /// How far the wall clock moved beyond the time that passed (negative: it was set back).
    pub delta_ms: i64,
    /// A jump backwards only: the value the "highest clock seen" must be raised to (its value
    /// at the last look plus the time that really passed).
    pub raise_floor_to: Option<u64>,
}

impl ClockJump {
    /// The audit record's `detail`: `back` or `forward`.
    pub fn code(&self) -> &'static str {
        if self.delta_ms < 0 {
            "back"
        } else {
            "forward"
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct ClockBase {
    boot_id: Option<u32>,
    wall_ms: u64,
    uptime_ms: u64,
    floor_ms: u64,
}

/// Compares the wall clock with the monotonic clock (the tick count since boot, which also
/// runs while the PC sleeps). In memory only: the first look after a start or a restart of
/// Windows only sets the base.
#[derive(Debug, Default)]
pub struct ClockWatch {
    base: Option<ClockBase>,
}

impl ClockWatch {
    pub fn new() -> Self {
        Self::default()
    }

    /// One look. `wall_ms` is the device clock, `boot` the boot counter and tick count,
    /// `floor_ms` the highest clock the agent has seen (`state.last_wall_clock_ms`). Returns a
    /// jump once: the base moves to the new clock, so the same change is not found again.
    pub fn observe(&mut self, wall_ms: u64, boot: &BootIdentity, floor_ms: u64) -> Option<ClockJump> {
        let fresh = ClockBase { boot_id: boot.boot_id, wall_ms, uptime_ms: boot.uptime_ms, floor_ms };
        let Some(base) = self.base else {
            self.base = Some(fresh);
            return None;
        };
        // Another boot, or a tick count that went back: the two looks cannot be compared.
        if base.boot_id != boot.boot_id || boot.uptime_ms < base.uptime_ms {
            self.base = Some(fresh);
            return None;
        }
        let elapsed = boot.uptime_ms - base.uptime_ms;
        let expected = base.wall_ms.saturating_add(elapsed);
        let delta_ms = i64::try_from(wall_ms).unwrap_or(i64::MAX).saturating_sub(i64::try_from(expected).unwrap_or(i64::MAX));
        if delta_ms.unsigned_abs() <= CLOCK_JUMP_MS {
            if elapsed >= REBASE_AFTER_MS {
                self.base = Some(fresh);
            }
            return None;
        }
        // The floor as it was at the base plus the time that passed: the device clock that was
        // just set is not trusted for it.
        let raise_floor_to = (delta_ms < 0).then(|| base.floor_ms.saturating_add(elapsed));
        self.base = Some(ClockBase { floor_ms: floor_ms.max(raise_floor_to.unwrap_or(0)), ..fresh });
        Some(ClockJump { delta_ms, raise_floor_to })
    }
}

/// One clock check of the agent (Step 20 calls it where it keeps the wall clock current): on a
/// jump, audits `device.clockJump` once and, when the clock went back, raises the "highest clock
/// seen" so the offline sign-in period keeps running (`employee_cache::is_expired` uses the
/// larger of the two clocks, the Phase 2 rule).
pub fn note_clock(
    watch: &mut ClockWatch,
    shared: &SharedState,
    wall_ms: u64,
    boot: &BootIdentity,
    audit: &mut dyn FnMut(AuditKind, String),
) -> Option<ClockJump> {
    let jump = watch.observe(wall_ms, boot, shared.last_wall_clock_ms())?;
    if let Some(floor) = jump.raise_floor_to {
        if let Err(error) = shared.note_wall_clock(floor, 0) {
            tracing::warn!("cannot save the wall clock: {error}");
        }
    }
    audit(AuditKind::DeviceClockJump, jump.code().to_string());
    Some(jump)
}

#[cfg(test)]
mod tests;
