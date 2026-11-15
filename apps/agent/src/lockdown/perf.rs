//! Per-user tuning (PRD 22.2) and the kiosk performance profile (PRD 22.3), plan Step 18.
//! Reported as the `performance` layer state.
//!
//! * **Staff tuning** (`performance.staffTuning`) writes only to the Staff account's own hive,
//!   through `staffreg` and its fixed roots: [`STAFF_TUNING`] is the complete list of values,
//!   and the Staff start-up entries (`...\CurrentVersion\Run`) are removed one by one. The
//!   admin account is never touched.
//! * **The kiosk profile** (`performance.kioskProfile`) is machine-wide: the services of
//!   [`KIOSK_SERVICES`] get the start type "disabled", the diagnostic data level goes to the
//!   lowest the edition honours, and Delivery Optimization stops sharing with other PCs.
//!   The Print Spooler joins the list only when `performance.noPrinting` is set **and** no
//!   printer is assigned (`network::printers::spooler_required`, plan 4.15, edge case 39).
//! * Every write goes through `journal::change` with owner `Perf`, so the original start type
//!   or value is saved first and "Disable kiosk", `unenroll` and `recover` put it back
//!   exactly. A part that the document switches off is restored the same way. A second run
//!   with the same document writes nothing.
//! * Defender and Windows Update are never touched: [`NEVER_TOUCH_SERVICES`] names them and
//!   the services an administrator needs for recovery, and a service that is not in the
//!   profile's own list is refused before any call.
//!
//! A start type takes effect at the next start of Windows; a service that is running keeps
//! running until then (the seam cannot stop a service, on purpose).

use rulebox_policy::lockdown::PerformancePolicy;
use rulebox_policy::AgentDoc;
use rulebox_win32::machinereg::{DATA_COLLECTION, DELIVERY_OPTIMIZATION};
use rulebox_win32::service::START_DISABLED;

use super::apply::ApplyCtx;
use super::staff::Tally;
use super::{LayerState, ReportedMode};
use crate::journal::{self, Change, JournalEntry, JournalOwner, JournalTarget};
use crate::network::printers::spooler_required;
use crate::platform::{RegData, RegValueRef};

// ---------------------------------------------------------------- the Staff catalogue

const ADVANCED: &str = r"Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced";
const BACKGROUND_APPS: &str = r"Software\Microsoft\Windows\CurrentVersion\BackgroundAccessApplications";
const COPILOT: &str = r"Software\Policies\Microsoft\Windows\WindowsCopilot";
const CLOUD_CONTENT: &str = r"Software\Policies\Microsoft\Windows\CloudContent";
const POL_EXPLORER: &str = r"Software\Policies\Microsoft\Windows\Explorer";
const VISUAL_EFFECTS: &str = r"Software\Microsoft\Windows\CurrentVersion\Explorer\VisualEffects";
const WINDOW_METRICS: &str = r"Control Panel\Desktop\WindowMetrics";
/// The Staff account's start-up entries.
pub const RUN: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";

/// At most this many start-up entries are removed in one apply (the journal stays bounded).
pub const MAX_STARTUP_ENTRIES: usize = 64;

/// What a tuning row writes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TuningValue {
    Dword(u32),
    Text(&'static str),
}

/// One value in the Staff hive.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TuningRow {
    /// Relative to the hive; under `staffreg::ALLOWED_ROOTS`.
    pub path: &'static str,
    pub name: &'static str,
    pub value: TuningValue,
    /// Windows may protect this value from being written (newer builds guard a few taskbar
    /// values). A refused write is then a note (`tuning_value_protected`), not a failure.
    pub best_effort: bool,
}

const fn dword(path: &'static str, name: &'static str, value: u32) -> TuningRow {
    TuningRow { path, name, value: TuningValue::Dword(value), best_effort: false }
}

/// One line of PRD 22.2.
pub struct TuningItem {
    pub key: &'static str,
    pub rows: &'static [TuningRow],
}

/// The complete Staff tuning list (PRD 22.2). "Explorer not running" is the shell
/// replacement of Phase 2; "no startup apps" is [`RUN`], handled entry by entry.
pub const STAFF_TUNING: &[TuningItem] = &[
    TuningItem { key: "backgroundApps", rows: &[dword(BACKGROUND_APPS, "GlobalUserDisabled", 1)] },
    TuningItem {
        key: "widgets",
        // There is no per-user widgets policy (the policy is machine-wide and would reach the
        // admin). With no Explorer there is no widgets board; this hides the button as well.
        rows: &[TuningRow { path: ADVANCED, name: "TaskbarDa", value: TuningValue::Dword(0), best_effort: true }],
    },
    TuningItem {
        key: "copilot",
        rows: &[dword(COPILOT, "TurnOffWindowsCopilot", 1), dword(ADVANCED, "ShowCopilotButton", 0)],
    },
    TuningItem {
        key: "tips",
        rows: &[
            dword(CLOUD_CONTENT, "DisableWindowsSpotlightFeatures", 1),
            dword(CLOUD_CONTENT, "DisableTailoredExperiencesWithDiagnosticData", 1),
            dword(CLOUD_CONTENT, "DisableThirdPartySuggestions", 1),
            dword(POL_EXPLORER, "DisableSearchBoxSuggestions", 1),
            dword(ADVANCED, "ShowSyncProviderNotifications", 0),
            dword(ADVANCED, "Start_IrisRecommendations", 0),
        ],
    },
    TuningItem {
        key: "visualEffects",
        rows: &[
            // 2 = "Adjust for best performance".
            dword(VISUAL_EFFECTS, "VisualFXSetting", 2),
            dword(ADVANCED, "TaskbarAnimations", 0),
            dword(ADVANCED, "ListviewAlphaSelect", 0),
            dword(ADVANCED, "ListviewShadow", 0),
            TuningRow { path: WINDOW_METRICS, name: "MinAnimate", value: TuningValue::Text("0"), best_effort: false },
        ],
    },
];

/// Every fixed row of the Staff tuning, in catalogue order.
pub fn tuning_rows() -> impl Iterator<Item = &'static TuningRow> {
    STAFF_TUNING.iter().flat_map(|item| item.rows.iter())
}

// ---------------------------------------------------------------- the kiosk profile

/// The services the kiosk profile disables (PRD 22.3): Windows Search, SysMain and the Xbox
/// services. One that does not exist on this edition is skipped.
pub const KIOSK_SERVICES: &[&str] = &["WSearch", "SysMain", "XblAuthManager", "XblGameSave", "XboxNetApiSvc", "XboxGipSvc"];

/// The Print Spooler: disabled only with `noPrinting` and no assigned printer.
pub const SPOOLER: &str = "Spooler";

/// Services this layer must never name: Defender, Windows Update and what an administrator
/// needs to recover the PC (plan Step 18, "Do NOT"). A test compares the lists.
pub const NEVER_TOUCH_SERVICES: &[&str] = &[
    // Defender and the Security Center.
    "WinDefend",
    "WdNisSvc",
    "WdNisDrv",
    "WdFilter",
    "WdBoot",
    "MDCoreSvc",
    "Sense",
    "SecurityHealthService",
    "wscsvc",
    "mpssvc",
    // Windows Update and what it needs.
    "wuauserv",
    "UsoSvc",
    "WaaSMedicSvc",
    "BITS",
    "DoSvc",
    "TrustedInstaller",
    "CryptSvc",
    // Recovery and remote administration.
    "RpcSs",
    "RpcEptMapper",
    "DcomLaunch",
    "EventLog",
    "WinRM",
    "Winmgmt",
    "Schedule",
    "LSM",
    "SamSs",
    "TermService",
    // The network (the way "Disable kiosk" arrives).
    "Dhcp",
    "Dnscache",
    "NlaSvc",
    "nsi",
    "WlanSvc",
    // Rulebox itself and the AppLocker service (owned by L3).
    "RuleboxAgent",
    "AppIDSvc",
];

/// Whether this layer may set the start type of `name`: the profile's own list, nothing else.
pub fn profile_service(name: &str) -> bool {
    KIOSK_SERVICES.iter().chain([&SPOOLER]).any(|service| service.eq_ignore_ascii_case(name))
        && !NEVER_TOUCH_SERVICES.iter().any(|service| service.eq_ignore_ascii_case(name))
}

/// Whether this document has the Print Spooler disabled: the kiosk profile is on, the admin
/// marked the PC "no printing" and no printer is assigned.
pub fn spooler_disabled(doc: &AgentDoc) -> bool {
    performance(doc).is_some_and(|p| p.kiosk_profile && p.no_printing) && !spooler_required(doc)
}

/// `AllowTelemetry`: 0 (diagnostic data off) is honoured only by the Enterprise, Education,
/// IoT and Server editions; every other edition's minimum is 1 (required data only).
pub fn telemetry_floor(edition_id: &str) -> u32 {
    let edition = edition_id.to_ascii_lowercase();
    // "ProfessionalEducation" is a Pro edition: its minimum is 1.
    let off_allowed = edition.starts_with("enterprise")
        || edition.starts_with("education")
        || edition.starts_with("iot")
        || edition.starts_with("server");
    u32::from(!off_allowed)
}

const ALLOW_TELEMETRY: &str = "AllowTelemetry";
const DO_DOWNLOAD_MODE: &str = "DODownloadMode";
/// `DODownloadMode` 0: downloads from Microsoft only, no sharing with other PCs.
const DO_HTTP_ONLY: u32 = 0;

fn performance(doc: &AgentDoc) -> Option<PerformancePolicy> {
    doc.lockdown.as_ref().map(|policy| policy.performance)
}

// ---------------------------------------------------------------- apply

/// Applies or restores the tuning and the profile for a verified document. Idempotent.
/// `Off` when the document has no `lockdown` section or both switches are off (then
/// everything this layer wrote is restored).
pub fn apply(ctx: &ApplyCtx<'_>, doc: &AgentDoc) -> LayerState {
    let policy = performance(doc);
    let staff_on = policy.is_some_and(|p| p.staff_tuning);
    let kiosk_on = policy.is_some_and(|p| p.kiosk_profile);
    let mode = if staff_on || kiosk_on { ReportedMode::On } else { ReportedMode::Off };
    let mut tally = Tally::default();

    if staff_on {
        apply_staff_tuning(ctx, &mut tally);
    } else {
        restore_where(ctx, &mut tally, |entry| matches!(entry.target, JournalTarget::StaffValue { .. }));
    }

    if kiosk_on {
        for name in KIOSK_SERVICES {
            disable_service(ctx, name, &mut tally);
        }
        if spooler_disabled(doc) {
            disable_service(ctx, SPOOLER, &mut tally);
        } else {
            let spooler_id = journal::service_start_id(SPOOLER);
            restore_where(ctx, &mut tally, |entry| entry.id == spooler_id);
            // Edge case 39: "no printing" asked for while printers are assigned.
            if policy.is_some_and(|p| p.no_printing) {
                tally.note = Some("no_printing_ignored");
            }
        }
        apply_machine_values(ctx, &mut tally);
    } else {
        restore_where(ctx, &mut tally, |entry| {
            matches!(entry.target, JournalTarget::ServiceStart { .. } | JournalTarget::MachineValue(_))
        });
    }

    LayerState { mode, state: tally.status(), detail: tally.detail() }
}

fn staff_sid(ctx: &ApplyCtx<'_>) -> Option<String> {
    ctx.journal.shared.read(|state| state.staff.as_ref().map(|staff| staff.sid.clone()))
}

fn apply_staff_tuning(ctx: &ApplyCtx<'_>, tally: &mut Tally) {
    let Some(sid) = staff_sid(ctx) else {
        tally.record(Err("no_staff_account"));
        return;
    };
    for row in tuning_rows() {
        let desired = match row.value {
            TuningValue::Dword(value) => RegData::Dword(value),
            TuningValue::Text(text) => RegData::String(text.to_string()),
        };
        let change = Change::staff(JournalOwner::Perf, row.path, row.name, Some(desired)).since(ctx.version);
        match journal::change(&ctx.journal, &change) {
            Ok(_) => tally.record(Ok(())),
            Err(error) if row.best_effort && journal::error_code(&error) == "access_denied" => {
                // Nothing was written: the entry that was saved first has nothing to restore.
                forget_entry(ctx, &change.id);
                tally.note = Some("tuning_value_protected");
            }
            Err(error) => tally.record(Err(journal::error_code(&error))),
        }
    }
    remove_startup_entries(ctx, &sid, tally);
}

/// Drops the journal entry of a write Windows refused, when it is still the `Pending` one
/// this apply saved (an entry that was applied before stays).
fn forget_entry(ctx: &ApplyCtx<'_>, id: &str) {
    let dropped = ctx.journal.shared.update(|state| {
        state.journal.retain(|entry| !(entry.id == id && entry.phase == journal::EntryPhase::Pending));
    });
    if let Err(error) = dropped {
        tracing::warn!("cannot drop the journal entry of a protected tuning value: {error}");
    }
}

/// "No startup apps": every text entry under the Staff account's `Run` key is deleted, with
/// its command line kept in the journal. An entry of another type cannot be put back exactly
/// (the seam knows text and numbers only), so it is left and the layer says
/// `startup_entry_kept`.
fn remove_startup_entries(ctx: &ApplyCtx<'_>, sid: &str, tally: &mut Tally) {
    let platform = ctx.journal.platform;
    let names = match platform.list_staff_value_names(sid, RUN) {
        Ok(names) => names,
        Err(_) => {
            tally.record(Err("startup_entries_unreadable"));
            return;
        }
    };
    if names.len() > MAX_STARTUP_ENTRIES {
        tally.note = Some("startup_entries_capped");
    }
    for name in names.iter().take(MAX_STARTUP_ENTRIES) {
        // The key's default value, and a name `staffreg` never writes.
        if name.is_empty() || name.eq_ignore_ascii_case("Shell") {
            continue;
        }
        match platform.read_staff_value(sid, RUN, name) {
            Ok(Some(RegData::String(_))) => {
                let change = Change::staff(JournalOwner::Perf, RUN, name, None).since(ctx.version);
                tally.record(journal::change(&ctx.journal, &change).map(|_| ()).map_err(|error| journal::error_code(&error)));
            }
            Ok(None) => {}
            Ok(Some(RegData::Dword(_))) | Err(_) => tally.note = Some("startup_entry_kept"),
        }
    }
}

fn disable_service(ctx: &ApplyCtx<'_>, name: &str, tally: &mut Tally) {
    if !profile_service(name) {
        tally.record(Err("service_not_in_profile"));
        return;
    }
    match ctx.journal.platform.query_service(name) {
        // Not on this edition: nothing to do.
        Ok(None) => {}
        Ok(Some(_)) => {
            let change = Change::service_start(JournalOwner::Perf, name, START_DISABLED).since(ctx.version);
            tally.record(journal::change(&ctx.journal, &change).map(|_| ()).map_err(|error| journal::error_code(&error)));
        }
        Err(_) => tally.record(Err("service_unreadable")),
    }
}

/// The two machine policies of the profile. A value that is already at least as strict (set by
/// the owner or a management tool) is left alone and not journalled.
fn apply_machine_values(ctx: &ApplyCtx<'_>, tally: &mut Tally) {
    let floor = ctx.journal.platform.os_info().map_or(1, |os| telemetry_floor(&os.edition_id));
    machine_value(ctx, DATA_COLLECTION, ALLOW_TELEMETRY, floor, |now| now <= floor, tally);
    // 99 and 100 ("bypass", "simple") do not share with other PCs either.
    machine_value(ctx, DELIVERY_OPTIMIZATION, DO_DOWNLOAD_MODE, DO_HTTP_ONLY, |now| matches!(now, 0 | 99 | 100), tally);
}

fn machine_value(ctx: &ApplyCtx<'_>, path: &str, name: &str, value: u32, strict_enough: impl Fn(u32) -> bool, tally: &mut Tally) {
    let key = RegValueRef { path: path.to_string(), name: name.to_string() };
    let id = journal::machine_id(&key);
    let ours = ctx.journal.shared.read(|state| state.journal.iter().any(|entry| entry.id == id));
    if !ours {
        match ctx.journal.platform.read_machine_value(&key) {
            Ok(Some(RegData::Dword(now))) if strict_enough(now) => return,
            Ok(_) => {}
            Err(_) => {
                tally.record(Err("machine_value_unreadable"));
                return;
            }
        }
    }
    let change = Change::machine(JournalOwner::Perf, key, Some(RegData::Dword(value))).since(ctx.version);
    tally.record(journal::change(&ctx.journal, &change).map(|_| ()).map_err(|error| journal::error_code(&error)));
}

/// Restores this layer's journal entries that `wanted` picks (a part the document switched off).
fn restore_where(ctx: &ApplyCtx<'_>, tally: &mut Tally, wanted: impl Fn(&JournalEntry) -> bool) {
    let ids: Vec<String> = ctx.journal.shared.read(|state| {
        state
            .journal
            .iter()
            .filter(|entry| entry.owner == JournalOwner::Perf && wanted(entry))
            .map(|entry| entry.id.clone())
            .collect()
    });
    if ids.is_empty() {
        return;
    }
    let report = journal::restore_ids(&ctx.journal, &ids);
    for _ in &report.restored {
        tally.record(Ok(()));
    }
    for (_, error) in &report.failed {
        tally.record(Err(journal::error_code(error)));
    }
}

#[cfg(test)]
mod tests;
