//! L7, the boot part (plan 4.16): the agent's Safe Mode registration, the Safe Mode
//! behaviour, automatic failover to the recovery environment and the physical-protection
//! report. (Service security, privileges and ACL self-checks are Step 17: `tamper.rs`, which
//! [`apply`] calls.)
//!
//! * **Safe Mode registration.** `SafeBoot\Minimal\RuleboxAgent` and
//!   `SafeBoot\Network\RuleboxAgent`, default value `Service`, journalled as
//!   `safeboot:<mode>` (a key that was not there is deleted again on restore).
//! * **Safe Mode behaviour.** [`in_safe_mode`] reads
//!   `SafeBoot\Option\OptionValue` (read-only, works inside a service). The Phase 2 kiosk
//!   code asks it when it writes the Winlogon values and keeps `AutoAdminLogon` at `"0"`
//!   while it is true: the hold lasts for that boot only, because the next normal boot
//!   writes `"1"` again and Disable puts the journalled original back as always.
//! * **Auto-recovery.** `boot.autoRecovery = off` sets BCD `{current}` `recoveryenabled`
//!   to `No`, and only when BitLocker is plainly off: on, suspended or unreadable leave
//!   the element alone (changing the boot configuration of a protected volume may cost a
//!   recovery prompt). Such a layer reports the fixed note `bitlocker_protects_os_volume`.
//! * **Posture.** [`report_from`] maps what the seam reads to the report enums.

use rulebox_policy::lockdown::AutoRecovery;
use rulebox_policy::AgentDoc;
use rulebox_win32::bcd::{CURRENT_OBJECT, RECOVERY_ENABLED};
use rulebox_win32::posture::{BitLocker, SecureBoot, SecurityPosture, Tpm};
use serde::Serialize;

use super::apply::ApplyCtx;
use super::machine::restore_present;
use super::staff::Tally;
use super::{LayerState, ReportedMode};
use crate::journal::{self, Change, JournalOwner};
use crate::platform::{Platform, PlatformError, RegData, RegValueRef};

/// The two Safe Mode flavours the agent registers for (plan 4.16, edge case 60).
pub const SAFE_MODES: [&str; 2] = ["Minimal", "Network"];

const OPTION_KEY: &str = r"SYSTEM\CurrentControlSet\Control\SafeBoot\Option";
const OPTION_VALUE: &str = "OptionValue";

/// The journal id of the auto-recovery change (`bcd:{current}|recoveryenabled`).
pub fn bcd_id() -> String {
    format!("bcd:{CURRENT_OBJECT}|{RECOVERY_ENABLED}")
}

/// The journal id of the Safe Mode registration of `mode`.
pub fn safe_boot_id(mode: &str) -> String {
    format!("safeboot:{mode}")
}

/// True while this boot is a Safe Mode boot (`OptionValue` 1 = Minimal, 2 = Network).
/// Read-only. A value that cannot be read counts as a normal boot.
pub fn in_safe_mode(platform: &dyn Platform) -> bool {
    let key = RegValueRef { path: OPTION_KEY.to_string(), name: OPTION_VALUE.to_string() };
    matches!(platform.read_machine_value(&key), Ok(Some(RegData::Dword(value))) if value != 0)
}

/// Whether the boot configuration may be changed: BitLocker is off (not on, not suspended,
/// not unknown).
fn bitlocker_allows_bcd(platform: &dyn Platform) -> Result<bool, &'static str> {
    platform.read_security_posture().map(|p| p.bit_locker == BitLocker::Off).map_err(|_| "posture_unreadable")
}

/// Applies or restores the boot part of L7. Idempotent. The layer reports `On` when the
/// document has a `lockdown` section and `Off` when it has none.
pub fn apply(ctx: &ApplyCtx<'_>, doc: &AgentDoc) -> LayerState {
    let policy = doc.lockdown.as_ref();
    let mode = if policy.is_some() { ReportedMode::On } else { ReportedMode::Off };
    let mut tally = Tally::default();
    let mut restore: Vec<String> = Vec::new();

    // Safe Mode registration.
    let guard = policy.is_some_and(|p| p.boot.safe_mode_guard);
    for safe_mode in SAFE_MODES {
        if guard {
            let change = Change::safe_boot(JournalOwner::L7, safe_mode).since(ctx.version);
            tally.record(journal::change(&ctx.journal, &change).map(|_| ()).map_err(|e| journal::error_code(&e)));
        } else {
            restore.push(safe_boot_id(safe_mode));
        }
    }

    // Automatic failover to the recovery environment.
    let has_entry = ctx.journal.shared.read(|state| state.journal.iter().any(|entry| entry.id == bcd_id()));
    match policy.map(|p| p.boot.auto_recovery) {
        Some(AutoRecovery::Unknown) => {
            tally.note.get_or_insert("section_unknown_value");
        }
        Some(AutoRecovery::Off) => match bitlocker_allows_bcd(ctx.journal.platform) {
            Ok(true) => {
                let change = Change::bcd(JournalOwner::L7, CURRENT_OBJECT, RECOVERY_ENABLED, "No").since(ctx.version);
                tally.record(journal::change(&ctx.journal, &change).map(|_| ()).map_err(|e| journal::error_code(&e)));
            }
            Ok(false) => {
                tally.note.get_or_insert("bitlocker_protects_os_volume");
            }
            Err(code) => tally.record(Err(code)),
        },
        Some(AutoRecovery::Leave) | None => {
            if has_entry {
                match bitlocker_allows_bcd(ctx.journal.platform) {
                    Ok(true) => restore.push(bcd_id()),
                    Ok(false) => {
                        tally.note.get_or_insert("bitlocker_protects_os_volume");
                    }
                    Err(code) => tally.record(Err(code)),
                }
            }
        }
    }

    // (Step 17) Tamper protection: the service DACL and privileges, the folder ACLs.
    super::tamper::apply(ctx, policy.is_some(), &mut tally, &mut restore);

    restore_present(ctx, &restore, &mut tally);
    LayerState { mode, state: tally.status(), detail: tally.detail() }
}

// ---------------------------------------------------------------- the report

/// What a device reports about its physical protection (`deviceReports.security`,
/// plan 4.16), in the report's own words. Rulebox-owned App Control ids are added by the
/// layer that owns them (Step 6); other products' policy ids are never reported.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SecurityReport {
    pub secure_boot: &'static str,
    pub bit_locker: &'static str,
    pub tpm: &'static str,
    /// `"off"` only when BCD says `recoveryenabled No`; anything else is `"on"`.
    pub auto_recovery: &'static str,
    /// The agent is registered for both Safe Mode flavours.
    pub safe_mode_agent: bool,
    /// (Step 17) `"ok"` or `"drift"`; absent while tamper protection is off. Filled by
    /// `tamper::TamperTracker::fill_report`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub service_acl: Option<&'static str>,
    /// (Step 17) Folder ACL repairs since the agent started; absent while tamper protection is off.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub acl_drift: Option<u64>,
}

/// Maps the raw readings to the report. `recovery_enabled` is `bcd_get` of the element.
pub fn report_from(posture: &SecurityPosture, recovery_enabled: Option<&str>, safe_mode_agent: bool) -> SecurityReport {
    SecurityReport {
        secure_boot: match posture.secure_boot {
            SecureBoot::On => "on",
            SecureBoot::Off => "off",
            SecureBoot::Unsupported => "unsupported",
        },
        bit_locker: match posture.bit_locker {
            BitLocker::On => "on",
            BitLocker::Off => "off",
            BitLocker::Suspended => "suspended",
            BitLocker::Unknown => "unknown",
        },
        tpm: match posture.tpm {
            Tpm::Ready => "ready",
            Tpm::Present => "present",
            Tpm::Absent => "absent",
            // The report has no "unknown" TPM state: not confirmed means not ready.
            Tpm::Unknown => "present",
        },
        auto_recovery: if recovery_enabled.is_some_and(|word| word.eq_ignore_ascii_case("No")) { "off" } else { "on" },
        safe_mode_agent,
        service_acl: None,
        acl_drift: None,
    }
}

/// Reads everything the report needs. Read-only.
pub fn read_report(platform: &dyn Platform) -> Result<SecurityReport, PlatformError> {
    let posture = platform.read_security_posture()?;
    // A BCD reader that cannot answer is "not confirmed off".
    let recovery = platform.bcd_get(CURRENT_OBJECT, RECOVERY_ENABLED).unwrap_or(None);
    let registered = SAFE_MODES.iter().all(|safe_mode| {
        let path = format!(r"SYSTEM\CurrentControlSet\Control\SafeBoot\{safe_mode}\RuleboxAgent");
        matches!(
            platform.read_machine_value(&RegValueRef { path, name: String::new() }),
            Ok(Some(RegData::String(text))) if text == journal::SAFE_BOOT_VALUE
        )
    });
    Ok(report_from(&posture, recovery.as_deref(), registered))
}

#[cfg(test)]
mod tests;
