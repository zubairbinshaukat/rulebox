//! Journal v2 (Phase 5 Step 2, plan 4.4): the list of everything Rulebox changed on
//! this PC, with the original of each, so "Disable kiosk", `unenroll` and `recover`
//! can put it back exactly (PRD 22.3, "restore is exact").
//!
//! Three rules hold the design together:
//!
//! - **One writer.** Every layer changes the machine through [`change`]; none writes
//!   to the system any other way.
//! - **Original first.** [`change`] saves the entry as `Pending` (with the value read
//!   from the system) *before* the platform call, and marks it `Applied` after. A
//!   value Rulebox wrote is never recorded as the original: an entry that exists keeps
//!   its `original` for good.
//! - **Reverse order out.** [`restore_all`] / [`restore_owner`] walk the journal
//!   backwards; a restore that fails leaves the entry in `Restoring` with an error
//!   code and is retried by the next call. [`startup_recover`] settles what a crash
//!   or power cut left half done.
//!
//! The state file keeps the store (`state.rs` re-exports these types). Step 2 knows
//! the `MachineValue` target; the other targets of 4.4 are in the enum so a file
//! written by a later step loads. Step 3 added the Staff-hive target (StaffValue; the
//! seam has its read-back); the others get their journal calls from the layer that uses
//! them (Steps 4 to 19). A
//! target this build does not know at all ([`JournalTarget::Unknown`]) is never
//! touched and stops every apply (`journal_unknown_target`, invariant I8).

use serde::{Deserialize, Serialize};

use crate::network::SecretText;
use crate::platform::{AppLockerMechanism, LockoutPolicy, Platform, PlatformError, RegData, RegValueRef};
use crate::state::{unix_ms, AgentState, SharedState};

/// The error code of an apply that is refused because the journal holds a target
/// this build cannot restore (plan 4.4, edge case 52).
pub const JOURNAL_UNKNOWN_TARGET: &str = "journal_unknown_target";

// -- types ------------------------------------------------------------------------------

/// Who wrote an entry: the layer of plan 4.1, or one of the feature owners.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum JournalOwner {
    Kiosk,
    L1,
    L2,
    L3,
    L4,
    L7,
    Wifi,
    Printer,
    Perf,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum EntryPhase {
    /// Saved before the system was changed.
    Pending,
    /// The system was changed.
    Applied,
    /// A restore started (or failed) and will be done again.
    Restoring,
}

/// What an entry is about. Externally tagged and camelCase on disk. A value this
/// build does not know (a file written by a newer agent that was then rolled back)
/// loads as [`JournalTarget::Unknown`] with its JSON kept, so it can be written back
/// unchanged by a later save.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum JournalTarget {
    /// HKLM, only under `machinereg::ALLOWED_ROOTS` (Step 3).
    MachineValue(RegValueRef),
    /// The Staff hive, only under `staffreg::ALLOWED_ROOTS` (Step 3).
    StaffValue { path: String, name: String },
    ServiceStart { name: String },
    CiPolicy { policy_id: String },
    AppLockerPolicy,
    WlanProfile { name: String },
    WlanFilters,
    Printer { name: String },
    PrinterPort { name: String },
    PrinterSecurity { printer_key: String },
    BcdElement { object: String, element: String },
    AccountLockoutPolicy,
    SafeBootEntry { mode: String },
    ServiceSecurity { name: String },
    ServicePrivileges { name: String },
    #[serde(untagged)]
    Unknown(serde_json::Value),
}

/// What was there before Rulebox changed it. The first four are the Phase 2 values
/// and keep their v1 spelling on disk.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum OriginalValue {
    Absent,
    Dword(u32),
    String(String),
    /// The value is sensitive and lives in `Secrets`.
    InSecrets,
    Qword(u64),
    MultiString(Vec<String>),
    /// Base64.
    Binary(String),
    Sddl(String),
    ServiceStart(u32),
    LockoutPolicy { threshold: u32, duration_s: u32, window_s: u32 },
    BcdValue(Option<String>),
    /// The object did not exist: restore deletes it.
    NotPresent,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JournalEntry {
    /// Stable key, for example `hklm:SOFTWARE\...\System|HideFastUserSwitching`.
    pub id: String,
    pub owner: JournalOwner,
    pub target: JournalTarget,
    pub original: OriginalValue,
    pub phase: EntryPhase,
    /// The document version that first wrote it (the last-known-good rollback
    /// restores by this, plan 4.11).
    pub since_version: u64,
    pub recorded_at_ms: u64,
    /// A fixed code, set when a restore of this entry failed; never Windows text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

impl JournalEntry {
    /// An `Applied` entry for an HKLM value (what the Phase 2 migration makes), for
    /// the tests to build.
    #[cfg(test)]
    pub fn machine(key: RegValueRef, original: OriginalValue, since_version: u64) -> Self {
        Self {
            id: machine_id(&key),
            owner: JournalOwner::Kiosk,
            target: JournalTarget::MachineValue(key),
            original,
            phase: EntryPhase::Applied,
            since_version,
            recorded_at_ms: 0,
            last_error: None,
        }
    }

    /// The HKLM value this entry is about, when it is one.
    pub fn machine_key(&self) -> Option<&RegValueRef> {
        match &self.target {
            JournalTarget::MachineValue(key) => Some(key),
            _ => None,
        }
    }

    /// The value name of an HKLM entry (for the tests); empty for other targets.
    #[cfg(test)]
    pub fn key_name(&self) -> &str {
        self.machine_key().map_or("", |key| key.name.as_str())
    }
}

/// `hklm:<path>|<name>`.
pub fn machine_id(key: &RegValueRef) -> String {
    format!("hklm:{}|{}", key.path, key.name)
}

/// `staff:<path>|<name>` (plan 4.4, the `StaffValue` target).
// (Phase 5 Step 3) First used by L1 (Step 4).
#[allow(dead_code)]
pub fn staff_id(path: &str, name: &str) -> String {
    format!("staff:{path}|{name}")
}

/// `ci:<policy id>` (plan 4.4, the `CiPolicy` target; the id is a lowercase GUID).
pub fn ci_id(policy_id: &str) -> String {
    format!("ci:{policy_id}")
}

/// The SHA-256 of a policy file as the journal compares it (lowercase hex).
pub fn policy_hash(binary: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(binary).iter().map(|b| format!("{b:02x}")).collect()
}

/// The first entry whose target this build does not know, if any.
pub fn unknown_target(state: &AgentState) -> Option<&JournalEntry> {
    state.journal.iter().find(|entry| matches!(entry.target, JournalTarget::Unknown(_)))
}

// -- errors -----------------------------------------------------------------------------

#[derive(Debug, thiserror::Error)]
pub enum JournalError {
    #[error("{0}")]
    Platform(#[from] PlatformError),
    /// The state or secrets file could not be written; the step is treated as failed
    /// because a journal that is not on disk is worth nothing after a crash.
    #[error("cannot save the agent state: {0}")]
    Persist(String),
    /// The entry is of a kind this build cannot restore.
    #[error("{JOURNAL_UNKNOWN_TARGET}")]
    UnknownTarget,
    /// A test stopped the process at this point ([`CrashPoint`]).
    #[cfg(test)]
    #[error("crash injected")]
    Crashed,
}

/// A short fixed code for `lastError` (never the Windows text).
pub fn error_code(error: &JournalError) -> &'static str {
    match error {
        JournalError::Platform(PlatformError::AccessDenied) => "access_denied",
        JournalError::Platform(PlatformError::Guard(_)) => "guard_blocked",
        JournalError::Platform(_) => "platform_error",
        JournalError::Persist(_) => "state_not_saved",
        JournalError::UnknownTarget => JOURNAL_UNKNOWN_TARGET,
        #[cfg(test)]
        JournalError::Crashed => "crashed",
    }
}

/// Where a test stops [`change`] to play a crash (power loss) there.
#[cfg(test)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[allow(clippy::enum_variant_names)]
pub enum CrashPoint {
    /// The `Pending` entry is on disk; the system is not changed yet.
    AfterPending,
    /// The system is changed; the entry is still `Pending`.
    AfterWrite,
    /// The entry is `Applied` (nothing is left to settle).
    AfterApplied,
}

#[cfg(test)]
thread_local! {
    static CRASH_AT: std::cell::Cell<Option<CrashPoint>> = const { std::cell::Cell::new(None) };
}

/// Arms (or, with `None`, clears) the crash point for the current test thread.
#[cfg(test)]
pub fn set_crash_point(point: Option<CrashPoint>) {
    CRASH_AT.with(|cell| cell.set(point));
}

#[cfg(test)]
fn crash_check(point: CrashPoint) -> Result<(), JournalError> {
    if CRASH_AT.with(std::cell::Cell::get) == Some(point) {
        return Err(JournalError::Crashed);
    }
    Ok(())
}

// Outside tests the crash points do not exist; the call sites use this macro so the
// production build carries no trace of them.
macro_rules! crash_point {
    ($point:ident) => {{
        #[cfg(test)]
        crash_check(CrashPoint::$point)?;
    }};
}

// -- the change --------------------------------------------------------------------------

/// What the journal needs from the machine and the state.
#[derive(Clone, Copy)]
pub struct JournalCtx<'a> {
    pub platform: &'a dyn Platform,
    pub shared: &'a SharedState,
}

/// One change to the system. Build it with [`Change::machine`].
#[derive(Debug, Clone)]
pub struct Change {
    pub id: String,
    pub owner: JournalOwner,
    pub target: JournalTarget,
    pub desired: Desired,
    pub since_version: u64,
    /// Record the original even when the system already holds the wanted value (a
    /// value that something else changes later, such as the admin exit's
    /// `AutoAdminLogon`).
    pub always_record: bool,
    /// The original is sensitive: a text original goes to `Secrets` and the entry says
    /// `InSecrets` (the owner's plaintext auto sign-in password).
    pub secret_original: bool,
}

/// The value to write. The other targets' kinds arrive with the layers that use them
/// (Step 3 added the seam for them, plan 4.5; Step 5 added the next three).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Desired {
    /// `None` deletes the value.
    Machine(Option<RegData>),
    /// A value in the Staff hive (Step 3: the seam has `read_staff_value`). `None` deletes it.
    #[allow(dead_code)] // first used by L1 (Step 4)
    Staff(Option<RegData>),
    /// (Step 5) The machine's account lockout policy (`NetUserModals` level 3).
    Lockout(LockoutPolicy),
    /// (Step 5) `Yes` or `No` for one BCD element.
    Bcd(String),
    /// (Step 5) The agent is registered for Safe Mode: `SafeBoot\<mode>\RuleboxAgent` exists
    /// with the default value [`SAFE_BOOT_VALUE`].
    SafeBoot,
    /// (Step 6) An App Control policy file with exactly these bytes in the active folder
    /// (`ci:<policy id>`). The embedded binaries are `'static`.
    CiPolicy(&'static [u8]),
    /// (Step 7) The AppLocker policy XML, installed through `mechanism`. `hash` is the SHA-256
    /// of the XML: the agent state remembers it ([`AppLockerMark`]) so a second apply of the
    /// same policy writes nothing.
    AppLocker { xml: String, mechanism: AppLockerMechanism, hash: String },
    /// (Step 7) A service start type (2 automatic, 3 manual, 4 disabled): `AppIDSvc`.
    ServiceStart(u32),
    /// (Step 7) The DACL of a print queue, as SDDL.
    PrinterSddl(String),
    /// (Step 13) A Wi-Fi profile: the XML (with the passphrase inside, so a [`SecretText`]) and the
    /// mark the agent keeps for it (`AgentState.wlan_marks`; never derived from the passphrase).
    WlanProfile { xml: SecretText, mark: String },
    /// (Step 13) The WLAN user permit list (managed networks only): the allowed SSIDs.
    WlanFilters(Vec<String>),
}

/// (Step 7) What the agent state remembers about the AppLocker policy it installed: the hash of
/// the XML and the mechanism, so the next apply can tell "already installed" and a restore
/// uses the same mechanism.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppLockerMark {
    pub hash: String,
    /// `local` or `csp`.
    pub mechanism: String,
}

/// `local` / `csp`: how a mechanism is spelled in the journal id and in [`AppLockerMark`].
pub fn mechanism_word(mechanism: AppLockerMechanism) -> &'static str {
    match mechanism {
        AppLockerMechanism::Local => "local",
        AppLockerMechanism::Csp => "csp",
    }
}

/// `applocker:<mechanism>` (plan 4.9: the journal records which mechanism applied, so restore
/// uses the same one; the one `AppLockerPolicy` target carries no field, the id does).
pub fn applocker_id(mechanism: AppLockerMechanism) -> String {
    format!("applocker:{}", mechanism_word(mechanism))
}

/// `svc-start:<name>`.
pub fn service_start_id(name: &str) -> String {
    format!("svc-start:{name}")
}

/// `printer-sec:<queue name>`.
pub fn printer_security_id(name: &str) -> String {
    format!("printer-sec:{name}")
}

/// `wlan:<profile name>` (the `WlanProfile` target; the name starts with `Rulebox-`).
pub fn wlan_profile_id(name: &str) -> String {
    format!("{WLAN_ID_PREFIX}{name}")
}

/// The id prefix of the Wi-Fi profile entries.
pub const WLAN_ID_PREFIX: &str = "wlan:";
/// The id of the WLAN permit-list entry (`wlan:filters`; no profile name can be `filters`, they
/// all start with `Rulebox-`).
pub const WLAN_FILTERS_ID: &str = "wlan:filters";

/// The default value of the agent's Safe Mode key (plan 4.16).
pub const SAFE_BOOT_VALUE: &str = "Service";

/// What a target holds, as the journal compares it (registry value, lockout policy, BCD).
#[derive(Debug, Clone, PartialEq, Eq)]
enum Value {
    Reg(Option<RegData>),
    Lockout(LockoutPolicy),
    Bcd(Option<String>),
    /// (Step 6) The SHA-256 (lowercase hex) of the policy file, None when there is none.
    Ci(Option<String>),
    /// (Step 7) The hash of the AppLocker policy the agent installed, None when none is there.
    /// Anything else in the store reads as "unmanaged".
    AppLocker(Option<String>),
    /// (Step 7) A service's start type; None when there is no such service.
    Service(Option<u32>),
    /// (Step 7) A print queue's DACL; None when there is no such queue.
    Sddl(Option<String>),
    /// (Step 13) A Wi-Fi profile: None when there is none of that name, else the mark of what the
    /// agent installed (`unmanaged` when the profile is there but the agent has no mark for it).
    Wlan(Option<String>),
    /// (Step 13) The WLAN user permit list.
    WlanFilters(Vec<String>),
}

impl Change {
    pub fn machine(owner: JournalOwner, key: RegValueRef, desired: Option<RegData>) -> Self {
        Self {
            id: machine_id(&key),
            owner,
            target: JournalTarget::MachineValue(key),
            desired: Desired::Machine(desired),
            since_version: 0,
            always_record: false,
            secret_original: false,
        }
    }

    /// A value in the Staff hive: `path` is relative to the hive and under
    /// `staffreg::ALLOWED_ROOTS`; the Staff account is the one recorded in the state.
    #[allow(dead_code)] // first used by L1 (Step 4)
    pub fn staff(owner: JournalOwner, path: &str, name: &str, desired: Option<RegData>) -> Self {
        Self {
            id: staff_id(path, name),
            owner,
            target: JournalTarget::StaffValue { path: path.to_string(), name: name.to_string() },
            desired: Desired::Staff(desired),
            since_version: 0,
            always_record: false,
            secret_original: false,
        }
    }

    /// (Step 5) The account lockout policy, journal id `netmodals:lockout`.
    pub fn lockout(owner: JournalOwner, policy: LockoutPolicy) -> Self {
        Self {
            id: "netmodals:lockout".to_string(),
            owner,
            target: JournalTarget::AccountLockoutPolicy,
            desired: Desired::Lockout(policy),
            since_version: 0,
            always_record: false,
            secret_original: false,
        }
    }

    /// (Step 5) One BCD element (`Yes` / `No`), journal id `bcd:<object>|<element>`.
    pub fn bcd(owner: JournalOwner, object: &str, element: &str, value: &str) -> Self {
        Self {
            id: format!("bcd:{object}|{element}"),
            owner,
            target: JournalTarget::BcdElement { object: object.to_string(), element: element.to_string() },
            desired: Desired::Bcd(value.to_string()),
            since_version: 0,
            always_record: false,
            secret_original: false,
        }
    }

    /// (Step 5) The Safe Mode registration of `mode` (`Minimal` / `Network`), id `safeboot:<mode>`.
    pub fn safe_boot(owner: JournalOwner, mode: &str) -> Self {
        Self {
            id: format!("safeboot:{mode}"),
            owner,
            target: JournalTarget::SafeBootEntry { mode: mode.to_string() },
            desired: Desired::SafeBoot,
            since_version: 0,
            always_record: false,
            secret_original: false,
        }
    }

    /// (Step 6) An App Control policy file `{policy_id}.cip` with these bytes, id `ci:<policy id>`.
    /// policy_id is a lowercase GUID without braces.
    pub fn ci_policy(owner: JournalOwner, policy_id: &str, binary: &'static [u8]) -> Self {
        Self {
            id: ci_id(policy_id),
            owner,
            target: JournalTarget::CiPolicy { policy_id: policy_id.to_string() },
            desired: Desired::CiPolicy(binary),
            since_version: 0,
            always_record: false,
            secret_original: false,
        }
    }

    /// (Step 7) The AppLocker policy `xml` through `mechanism`, id `applocker:<mechanism>`.
    pub fn app_locker(owner: JournalOwner, xml: &str, mechanism: AppLockerMechanism) -> Self {
        Self {
            id: applocker_id(mechanism),
            owner,
            target: JournalTarget::AppLockerPolicy,
            desired: Desired::AppLocker { xml: xml.to_string(), mechanism, hash: policy_hash(xml.as_bytes()) },
            since_version: 0,
            always_record: false,
            secret_original: false,
        }
    }

    /// (Step 7) A service start type, id `svc-start:<name>`.
    pub fn service_start(owner: JournalOwner, name: &str, start: u32) -> Self {
        Self {
            id: service_start_id(name),
            owner,
            target: JournalTarget::ServiceStart { name: name.to_string() },
            desired: Desired::ServiceStart(start),
            since_version: 0,
            always_record: false,
            secret_original: false,
        }
    }

    /// (Step 7) The DACL of print queue `name`, id `printer-sec:<name>`.
    pub fn printer_security(owner: JournalOwner, name: &str, sddl: &str) -> Self {
        Self {
            id: printer_security_id(name),
            owner,
            target: JournalTarget::PrinterSecurity { printer_key: name.to_string() },
            desired: Desired::PrinterSddl(sddl.to_string()),
            since_version: 0,
            always_record: false,
            secret_original: false,
        }
    }

    /// (Step 13) A Wi-Fi profile `name` (`Rulebox-<id>`), id `wlan:<name>`. The original is always
    /// "not present": the name is Rulebox's, so restore deletes the profile.
    pub fn wlan_profile(name: &str, xml: SecretText, mark: &str) -> Self {
        Self {
            id: wlan_profile_id(name),
            owner: JournalOwner::Wifi,
            target: JournalTarget::WlanProfile { name: name.to_string() },
            desired: Desired::WlanProfile { xml, mark: mark.to_string() },
            since_version: 0,
            always_record: false,
            secret_original: false,
        }
    }

    /// (Step 13) The WLAN user permit list, id `wlan:filters`.
    pub fn wlan_filters(ssids: Vec<String>) -> Self {
        Self {
            id: WLAN_FILTERS_ID.to_string(),
            owner: JournalOwner::Wifi,
            target: JournalTarget::WlanFilters,
            desired: Desired::WlanFilters(ssids),
            since_version: 0,
            always_record: false,
            secret_original: false,
        }
    }

    pub fn since(mut self, version: u64) -> Self {
        self.since_version = version;
        self
    }

    pub fn always_record(mut self) -> Self {
        self.always_record = true;
        self
    }

    pub fn secret_original(mut self) -> Self {
        self.secret_original = true;
        self
    }
}

/// What [`change`] did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChangeOutcome {
    /// The system already had the value and nothing needed recording.
    Unchanged,
    /// The original was recorded; the system already had the value.
    Recorded,
    /// The system was changed.
    Written,
}

fn persist(ctx: &JournalCtx<'_>, edit: impl FnOnce(&mut AgentState)) -> Result<(), JournalError> {
    ctx.shared.update(edit).map_err(|error| JournalError::Persist(error.to_string()))
}

fn find_entry(ctx: &JournalCtx<'_>, id: &str) -> Option<JournalEntry> {
    ctx.shared.read(|state| state.journal.iter().find(|entry| entry.id == id).cloned())
}

fn set_phase(ctx: &JournalCtx<'_>, id: &str, phase: EntryPhase) -> Result<(), JournalError> {
    persist(ctx, |state| {
        if let Some(entry) = state.journal.iter_mut().find(|entry| entry.id == id) {
            entry.phase = phase;
        }
    })
}

/// The original of a target's current value as the journal keeps it.
fn original_of(
    ctx: &JournalCtx<'_>,
    target: &JournalTarget,
    current: &Value,
    secret: bool,
) -> Result<OriginalValue, JournalError> {
    let current = match current {
        Value::Reg(current) => current,
        Value::Lockout(policy) => {
            return Ok(OriginalValue::LockoutPolicy {
                threshold: policy.threshold,
                duration_s: policy.duration_s,
                window_s: policy.window_s,
            })
        }
        Value::Bcd(value) => return Ok(OriginalValue::BcdValue(value.clone())),
        // A policy file under a Rulebox id is Rulebox's own (the ids are fixed): whatever is there
        // now, restore removes it.
        Value::Ci(_) => return Ok(OriginalValue::NotPresent),
        // (Step 7) The layer refuses to touch a foreign AppLocker policy before it gets here, so
        // whatever is installed now is not Rulebox's to keep: restore removes the policy.
        Value::AppLocker(_) => return Ok(OriginalValue::NotPresent),
        Value::Service(Some(start)) => return Ok(OriginalValue::ServiceStart(*start)),
        Value::Service(None) => return Err(JournalError::Platform(PlatformError::NotFound)),
        Value::Sddl(Some(sddl)) => return Ok(OriginalValue::Sddl(sddl.clone())),
        Value::Sddl(None) => return Err(JournalError::Platform(PlatformError::NotFound)),
        // (Step 13) A Rulebox-named profile is Rulebox's: whatever is there now, restore removes it.
        Value::Wlan(_) => return Ok(OriginalValue::NotPresent),
        Value::WlanFilters(list) if list.is_empty() => return Ok(OriginalValue::NotPresent),
        Value::WlanFilters(list) => return Ok(OriginalValue::MultiString(list.clone())),
    };
    Ok(match current {
        // A Safe Mode key that was not there is restored by deleting the key.
        None if matches!(target, JournalTarget::SafeBootEntry { .. }) => OriginalValue::NotPresent,
        None => OriginalValue::Absent,
        Some(RegData::Dword(value)) => OriginalValue::Dword(*value),
        // The owner's plaintext password goes to the secrets file, never into
        // `agent-state.json`.
        Some(RegData::String(text)) if secret => {
            ctx.shared
                .update_secrets(|secrets| secrets.original_default_password_registry = Some(text.clone()))
                .map_err(JournalError::Platform)?;
            OriginalValue::InSecrets
        }
        Some(RegData::String(text)) => OriginalValue::String(text.clone()),
    })
}

/// The only way to change the system (plan 4.4). The write order:
///
/// 1. An entry with this id keeps its `original`; otherwise the current value is read
///    through the read-only seam and a `Pending` entry is saved.
/// 2. The mutating `Platform` method is called (only when the value differs).
/// 3. The entry is saved as `Applied`.
pub fn change(ctx: &JournalCtx<'_>, change: &Change) -> Result<ChangeOutcome, JournalError> {
    let desired = match (&change.target, &change.desired) {
        (JournalTarget::MachineValue(_), Desired::Machine(desired)) => Value::Reg(desired.clone()),
        (JournalTarget::StaffValue { .. }, Desired::Staff(desired)) => Value::Reg(desired.clone()),
        (JournalTarget::SafeBootEntry { .. }, Desired::SafeBoot) => {
            Value::Reg(Some(RegData::String(SAFE_BOOT_VALUE.to_string())))
        }
        (JournalTarget::AccountLockoutPolicy, Desired::Lockout(policy)) => Value::Lockout(*policy),
        (JournalTarget::BcdElement { .. }, Desired::Bcd(value)) => Value::Bcd(Some(value.clone())),
        (JournalTarget::CiPolicy { .. }, Desired::CiPolicy(binary)) => Value::Ci(Some(policy_hash(binary))),
        (JournalTarget::AppLockerPolicy, Desired::AppLocker { hash, .. }) => Value::AppLocker(Some(hash.clone())),
        (JournalTarget::ServiceStart { .. }, Desired::ServiceStart(start)) => Value::Service(Some(*start)),
        (JournalTarget::PrinterSecurity { .. }, Desired::PrinterSddl(sddl)) => Value::Sddl(Some(sddl.clone())),
        (JournalTarget::WlanProfile { .. }, Desired::WlanProfile { mark, .. }) => Value::Wlan(Some(mark.clone())),
        (JournalTarget::WlanFilters, Desired::WlanFilters(list)) => Value::WlanFilters(list.clone()),
        _ => return Err(JournalError::Platform(PlatformError::Refused("unsupported journal target"))),
    };
    let current = read_current(ctx, &change.target)?;
    let existing = find_entry(ctx, &change.id);

    let recorded_now = match &existing {
        Some(_) => false,
        None => {
            if current == desired && !change.always_record {
                return Ok(ChangeOutcome::Unchanged);
            }
            let original = original_of(ctx, &change.target, &current, change.secret_original)?;
            let entry = JournalEntry {
                id: change.id.clone(),
                owner: change.owner,
                target: change.target.clone(),
                original,
                phase: EntryPhase::Pending,
                since_version: change.since_version,
                recorded_at_ms: unix_ms(),
                last_error: None,
            };
            persist(ctx, |state| state.journal.push(entry))?;
            true
        }
    };
    crash_point!(AfterPending);

    let needs_write = current != desired;
    // (Phase 5 Step 9, plan 4.11 "Drift") A target Rulebox already applied that no longer holds
    // its value was changed by something else. A target the drift guard has muted ("fighting")
    // is left alone; otherwise the write below is noted so the reconcile pass can count it.
    let applied_before = existing.as_ref().is_some_and(|entry| entry.phase == EntryPhase::Applied && entry.last_error.is_none());
    let drifted = needs_write && applied_before;
    if drifted && ctx.shared.is_muted(&change.id) {
        return Ok(ChangeOutcome::Unchanged);
    }
    if needs_write {
        match (&change.target, &change.desired) {
            (JournalTarget::CiPolicy { policy_id }, Desired::CiPolicy(binary)) => {
                ctx.platform.deploy_ci_policy(policy_id, binary)?;
            }
            (JournalTarget::AppLockerPolicy, Desired::AppLocker { xml, mechanism, hash }) => {
                ctx.platform.set_applocker_policy(xml, *mechanism)?;
                let mark = AppLockerMark { hash: hash.clone(), mechanism: mechanism_word(*mechanism).to_string() };
                persist(ctx, |state| state.applocker = Some(mark))?;
            }
            (JournalTarget::WlanProfile { name }, Desired::WlanProfile { xml, mark }) => {
                ctx.platform.wlan_set_profile(xml.expose())?;
                persist(ctx, |state| {
                    state.wlan_marks.insert(name.clone(), mark.clone());
                })?;
            }
            _ => write_value(ctx, &change.target, &desired)?,
        }
    }
    crash_point!(AfterWrite);
    if drifted {
        ctx.shared.note_rewrite(&change.id, change.owner);
    }

    let needs_mark = recorded_now
        || existing.as_ref().is_some_and(|entry| entry.phase != EntryPhase::Applied || entry.last_error.is_some());
    if needs_mark {
        persist(ctx, |state| {
            if let Some(entry) = state.journal.iter_mut().find(|entry| entry.id == change.id) {
                entry.phase = EntryPhase::Applied;
                entry.last_error = None;
            }
        })?;
    }
    crash_point!(AfterApplied);

    Ok(if needs_write {
        ChangeOutcome::Written
    } else if recorded_now {
        ChangeOutcome::Recorded
    } else {
        ChangeOutcome::Unchanged
    })
}

/// The id of the Staff account the state records, if there is one.
fn staff_sid(ctx: &JournalCtx<'_>) -> Option<String> {
    ctx.shared.read(|state| state.staff.as_ref().map(|staff| staff.sid.clone()))
}

/// The default value of the agent's Safe Mode key for `mode` (the registration's marker).
fn safe_boot_key(mode: &str) -> Result<RegValueRef, JournalError> {
    let path = rulebox_win32::machinereg::check_safe_boot_mode(mode)
        .map_err(|_| JournalError::Platform(PlatformError::Refused("not a Safe Mode registration")))?;
    Ok(RegValueRef { path, name: String::new() })
}

/// The value a target holds now, through the read-only seam.
fn read_current(ctx: &JournalCtx<'_>, target: &JournalTarget) -> Result<Value, JournalError> {
    match target {
        JournalTarget::MachineValue(key) => Ok(Value::Reg(ctx.platform.read_machine_value(key)?)),
        JournalTarget::StaffValue { path, name } => {
            let sid = staff_sid(ctx)
                .ok_or_else(|| JournalError::Platform(PlatformError::Other("no Staff account is recorded".to_string())))?;
            Ok(Value::Reg(ctx.platform.read_staff_value(&sid, path, name)?))
        }
        JournalTarget::SafeBootEntry { mode } => {
            Ok(Value::Reg(ctx.platform.read_machine_value(&safe_boot_key(mode)?)?))
        }
        JournalTarget::AccountLockoutPolicy => Ok(Value::Lockout(ctx.platform.get_account_lockout()?)),
        JournalTarget::BcdElement { object, element } => Ok(Value::Bcd(ctx.platform.bcd_get(object, element)?)),
        JournalTarget::CiPolicy { policy_id } => {
            Ok(Value::Ci(ctx.platform.read_ci_policy(policy_id)?.map(|binary| policy_hash(&binary))))
        }
        JournalTarget::AppLockerPolicy => {
            let mark = ctx.shared.read(|state| state.applocker.clone());
            let store = ctx.platform.get_applocker_policy()?;
            // The MDM bridge's policy does not show in the local store, so for it the mark
            // alone says what is installed; for the local store the rules must be there too.
            let hash = match mark {
                Some(mark) if mark.mechanism == "csp" || store.has_rules() => Some(mark.hash),
                _ if store.has_rules() => Some("unmanaged".to_string()),
                _ => None,
            };
            Ok(Value::AppLocker(hash))
        }
        JournalTarget::ServiceStart { name } => Ok(Value::Service(ctx.platform.query_service(name)?.map(|svc| svc.start))),
        JournalTarget::PrinterSecurity { printer_key } => Ok(Value::Sddl(ctx.platform.printer_get_security(printer_key)?)),
        JournalTarget::WlanProfile { name } => {
            let present = ctx.platform.wlan_list()?.profiles.iter().any(|profile| profile == name);
            Ok(Value::Wlan(present.then(|| {
                ctx.shared.read(|state| state.wlan_marks.get(name).cloned()).unwrap_or_else(|| "unmanaged".to_string())
            })))
        }
        JournalTarget::WlanFilters => {
            // Sorted: the permit list is a set, and Windows may hand it back in another order.
            let mut list = ctx.platform.wlan_list()?.allowed_ssids;
            list.sort();
            Ok(Value::WlanFilters(list))
        }
        _ => Err(JournalError::Platform(PlatformError::Refused("unsupported journal target"))),
    }
}

/// Writes the wanted value of a target (a registry value with `None` is deleted).
fn write_value(ctx: &JournalCtx<'_>, target: &JournalTarget, value: &Value) -> Result<(), JournalError> {
    match (target, value) {
        (JournalTarget::MachineValue(key), Value::Reg(data)) => Ok(ctx.platform.write_machine_value(key, data.as_ref())?),
        (JournalTarget::StaffValue { path, name }, Value::Reg(data)) => {
            let sid = staff_sid(ctx)
                .ok_or_else(|| JournalError::Platform(PlatformError::Other("no Staff account is recorded".to_string())))?;
            match data {
                Some(data) => Ok(ctx.platform.write_staff_value(&sid, path, name, data)?),
                None => Ok(ctx.platform.delete_staff_value(&sid, path, name)?),
            }
        }
        (JournalTarget::SafeBootEntry { mode }, Value::Reg(Some(data))) => {
            Ok(ctx.platform.write_machine_value(&safe_boot_key(mode)?, Some(data))?)
        }
        (JournalTarget::AccountLockoutPolicy, Value::Lockout(policy)) => Ok(ctx.platform.set_account_lockout(*policy)?),
        (JournalTarget::BcdElement { object, element }, Value::Bcd(Some(word))) => {
            Ok(ctx.platform.bcd_set(object, element, word)?)
        }
        (JournalTarget::ServiceStart { name }, Value::Service(Some(start))) => Ok(ctx.platform.set_service_start(name, *start)?),
        (JournalTarget::PrinterSecurity { printer_key }, Value::Sddl(Some(sddl))) => {
            Ok(ctx.platform.printer_set_security(printer_key, sddl)?)
        }
        (JournalTarget::WlanFilters, Value::WlanFilters(list)) => {
            let refs: Vec<&str> = list.iter().map(String::as_str).collect();
            Ok(ctx.platform.wlan_set_filters(&refs)?)
        }
        _ => Err(JournalError::Platform(PlatformError::Refused("unsupported journal target"))),
    }
}

// -- restore -----------------------------------------------------------------------------

/// What a restore run did.
#[derive(Debug, Default)]
pub struct RestoreReport {
    /// Ids that went back and were removed from the journal.
    pub restored: Vec<String>,
    /// Ids that did not (they stay in `Restoring`), with why.
    pub failed: Vec<(String, JournalError)>,
    /// Errors that belong to no entry (the secrets cleanup).
    pub other: Vec<JournalError>,
}

impl RestoreReport {
    // Used by the unenroll and last-known-good flows of Step 20.
    #[allow(dead_code)]
    pub fn is_complete(&self) -> bool {
        self.failed.is_empty() && self.other.is_empty()
    }

    /// The failed entries' ids (the device report's `restore_incomplete` list).
    pub fn failed_ids(&self) -> Vec<&str> {
        self.failed.iter().map(|(id, _)| id.as_str()).collect()
    }

    /// Every error, in the order it happened.
    pub fn into_errors(self) -> Vec<JournalError> {
        self.failed.into_iter().map(|(_, error)| error).chain(self.other).collect()
    }
}

/// Restores every entry of `owner`, last written first.
// Used by the per-layer "off" path and the last-known-good rollback (Steps 4 to 20).
#[allow(dead_code)]
pub fn restore_owner(ctx: &JournalCtx<'_>, owner: JournalOwner) -> RestoreReport {
    restore_matching(ctx, |entry| entry.owner == owner)
}

/// (Phase 5 Step 9, plan 4.11 "Last-known-good") Restores the entries of `owners` that were
/// first written by a document newer than `version`, last written first. Entries written at or
/// before `version` stay; the caller then applies the last-known-good document over them.
pub fn restore_owned_after(ctx: &JournalCtx<'_>, owners: &[JournalOwner], version: u64) -> RestoreReport {
    restore_matching(ctx, |entry| owners.contains(&entry.owner) && entry.since_version > version)
}

/// Restores the entries with these ids, last written first (a layer item that the
/// document no longer wants). Ids with no entry are ignored.
// Used by L1 (Step 4) and the layers after it; nothing outside `lockdown` calls it yet.
#[allow(dead_code)]
pub fn restore_ids(ctx: &JournalCtx<'_>, ids: &[String]) -> RestoreReport {
    restore_matching(ctx, |entry| ids.contains(&entry.id))
}

/// Restores the whole journal, last written first.
pub fn restore_all(ctx: &JournalCtx<'_>) -> RestoreReport {
    restore_matching(ctx, |_| true)
}

fn restore_matching(ctx: &JournalCtx<'_>, wanted: impl Fn(&JournalEntry) -> bool) -> RestoreReport {
    let mut report = RestoreReport::default();
    let entries: Vec<JournalEntry> = ctx.shared.read(|state| state.journal.iter().filter(|e| wanted(e)).cloned().collect());
    for entry in entries.into_iter().rev() {
        match restore_one(ctx, &entry) {
            Ok(()) => report.restored.push(entry.id),
            Err(error) => report.failed.push((entry.id, error)),
        }
    }
    // The owner's kept password is no longer needed once no entry points at it.
    let secret_still_needed =
        ctx.shared.read(|state| state.journal.iter().any(|entry| entry.original == OriginalValue::InSecrets));
    if !secret_still_needed {
        let kept = ctx.shared.secrets(|secrets| secrets.original_default_password_registry.is_some());
        if matches!(kept, Ok(true)) {
            if let Err(error) = ctx.shared.update_secrets(|secrets| secrets.original_default_password_registry = None) {
                report.other.push(JournalError::Platform(error));
            }
        }
    }
    report
}

/// Sets `Restoring`, puts the original back, removes the entry. On a failure the
/// entry stays `Restoring` with an error code.
fn restore_one(ctx: &JournalCtx<'_>, entry: &JournalEntry) -> Result<(), JournalError> {
    if matches!(entry.target, JournalTarget::Unknown(_)) {
        return Err(JournalError::UnknownTarget);
    }
    // A marker that cannot be saved does not stop the restore: restores are
    // idempotent, and putting the PC back matters more than the marker.
    if entry.phase != EntryPhase::Restoring {
        if let Err(error) = set_phase(ctx, &entry.id, EntryPhase::Restoring) {
            tracing::warn!("cannot mark journal entry {} as restoring: {error}", entry.id);
        }
    }
    match write_original(ctx, entry) {
        Ok(()) => persist(ctx, |state| state.journal.retain(|e| e.id != entry.id)),
        Err(error) => {
            let code = error_code(&error).to_string();
            let _ = persist(ctx, |state| {
                if let Some(stored) = state.journal.iter_mut().find(|e| e.id == entry.id) {
                    stored.phase = EntryPhase::Restoring;
                    stored.last_error = Some(code);
                }
            });
            Err(error)
        }
    }
}

fn write_original(ctx: &JournalCtx<'_>, entry: &JournalEntry) -> Result<(), JournalError> {
    match &entry.target {
        JournalTarget::MachineValue(key) => {
            let data = machine_data(ctx, &entry.original)?;
            ctx.platform.write_machine_value(key, data.as_ref())?;
            Ok(())
        }
        JournalTarget::StaffValue { .. } => {
            // The value lives in the Staff hive: with no Staff account (deleted, or
            // never recorded) there is nothing left to put back.
            if staff_sid(ctx).is_none() {
                return Ok(());
            }
            let data = machine_data(ctx, &entry.original)?;
            match write_value(ctx, &entry.target, &Value::Reg(data)) {
                Err(JournalError::Platform(PlatformError::NotFound)) => Ok(()),
                other => other,
            }
        }
        // (Step 5) The Safe Mode registration: a key that was not there is deleted, one that
        // was (with another default value) gets that value back.
        JournalTarget::SafeBootEntry { mode } => match &entry.original {
            OriginalValue::NotPresent | OriginalValue::Absent => Ok(ctx.platform.remove_safe_boot_entry(mode)?),
            OriginalValue::String(text) => {
                Ok(ctx.platform.write_machine_value(&safe_boot_key(mode)?, Some(&RegData::String(text.clone())))?)
            }
            _ => Err(JournalError::Platform(PlatformError::Refused("original does not fit a Safe Mode key"))),
        },
        JournalTarget::AccountLockoutPolicy => match &entry.original {
            OriginalValue::LockoutPolicy { threshold, duration_s, window_s } => Ok(ctx.platform.set_account_lockout(
                LockoutPolicy { threshold: *threshold, duration_s: *duration_s, window_s: *window_s },
            )?),
            _ => Err(JournalError::Platform(PlatformError::Refused("original does not fit the lockout policy"))),
        },
        // `recoveryenabled` that was not set restores to `Yes`, what Windows uses when the
        // element is absent (the seam has no delete for BCD elements).
        JournalTarget::BcdElement { object, element } => match &entry.original {
            OriginalValue::BcdValue(value) => {
                Ok(ctx.platform.bcd_set(object, element, value.as_deref().unwrap_or("Yes"))?)
            }
            _ => Err(JournalError::Platform(PlatformError::Refused("original does not fit a BCD element"))),
        },
        // (Step 6) The policy file was not there before Rulebox put it: remove it again.
        JournalTarget::CiPolicy { policy_id } => match &entry.original {
            OriginalValue::NotPresent | OriginalValue::Absent => Ok(ctx.platform.remove_ci_policy(policy_id)?),
            _ => Err(JournalError::Platform(PlatformError::Refused("original does not fit a policy file"))),
        },
        // (Step 7) The AppLocker policy was not there before Rulebox put it: remove it again,
        // through the mechanism the id names (both when it names none), and forget the mark.
        JournalTarget::AppLockerPolicy => match &entry.original {
            OriginalValue::NotPresent | OriginalValue::Absent => {
                let mechanisms: &[AppLockerMechanism] = if entry.id == applocker_id(AppLockerMechanism::Local) {
                    &[AppLockerMechanism::Local]
                } else if entry.id == applocker_id(AppLockerMechanism::Csp) {
                    &[AppLockerMechanism::Csp]
                } else {
                    &[AppLockerMechanism::Local, AppLockerMechanism::Csp]
                };
                for mechanism in mechanisms {
                    ctx.platform.clear_applocker_policy(*mechanism)?;
                }
                persist(ctx, |state| state.applocker = None)
            }
            _ => Err(JournalError::Platform(PlatformError::Refused("original does not fit an AppLocker policy"))),
        },
        // (Step 7) A service start type goes back to what it was.
        JournalTarget::ServiceStart { name } => match &entry.original {
            OriginalValue::ServiceStart(start) => match ctx.platform.set_service_start(name, *start) {
                Err(PlatformError::NotFound) => Ok(()),
                other => Ok(other?),
            },
            _ => Err(JournalError::Platform(PlatformError::Refused("original does not fit a service start type"))),
        },
        // (Step 7) A print queue's DACL goes back; a queue that is gone has nothing to restore.
        JournalTarget::PrinterSecurity { printer_key } => match &entry.original {
            OriginalValue::Sddl(sddl) => match ctx.platform.printer_set_security(printer_key, sddl) {
                Err(PlatformError::NotFound) => Ok(()),
                other => Ok(other?),
            },
            _ => Err(JournalError::Platform(PlatformError::Refused("original does not fit a print queue's DACL"))),
        },
        // (Step 13) A Wi-Fi profile that Rulebox added is deleted (one that is already gone is fine),
        // and its mark forgotten.
        JournalTarget::WlanProfile { name } => match &entry.original {
            OriginalValue::NotPresent | OriginalValue::Absent => {
                ctx.platform.wlan_delete_profile(name)?;
                persist(ctx, |state| {
                    state.wlan_marks.remove(name);
                })
            }
            _ => Err(JournalError::Platform(PlatformError::Refused("original does not fit a Wi-Fi profile"))),
        },
        // (Step 13) The permit list goes back to what it was (none: removed).
        JournalTarget::WlanFilters => match &entry.original {
            OriginalValue::NotPresent | OriginalValue::Absent => Ok(ctx.platform.wlan_set_filters(&[])?),
            OriginalValue::MultiString(list) => {
                let refs: Vec<&str> = list.iter().map(String::as_str).collect();
                Ok(ctx.platform.wlan_set_filters(&refs)?)
            }
            _ => Err(JournalError::Platform(PlatformError::Refused("original does not fit the WLAN permit list"))),
        },
        JournalTarget::Unknown(_) => Err(JournalError::UnknownTarget),
        // The layers of Steps 8 to 19 give the rest a restore; until then a journal that
        // holds one cannot be restored here.
        _ => Err(JournalError::Platform(PlatformError::Refused("no restore for this journal target yet"))),
    }
}

/// The registry data an original stands for (`None` = delete the value).
fn machine_data(ctx: &JournalCtx<'_>, original: &OriginalValue) -> Result<Option<RegData>, JournalError> {
    match original {
        OriginalValue::Absent | OriginalValue::NotPresent => Ok(None),
        OriginalValue::Dword(value) => Ok(Some(RegData::Dword(*value))),
        OriginalValue::String(text) => Ok(Some(RegData::String(text.clone()))),
        OriginalValue::InSecrets => {
            let kept = ctx
                .shared
                .secrets(|secrets| secrets.original_default_password_registry.clone())
                .map_err(JournalError::Platform)?;
            match kept {
                Some(text) => Ok(Some(RegData::String(text))),
                None => Err(JournalError::Platform(PlatformError::Other(
                    "the original auto sign-in password is not in the secrets file".to_string(),
                ))),
            }
        }
        _ => Err(JournalError::Platform(PlatformError::Refused("original does not fit a registry value"))),
    }
}

// -- start-up recovery -------------------------------------------------------------------

/// What [`startup_recover`] settled.
#[derive(Debug, Default)]
pub struct StartupReport {
    /// `Pending` entries whose system value was still the original: dropped.
    pub dropped: Vec<String>,
    /// `Pending` entries whose value had changed (or could not be compared): kept as
    /// `Applied`.
    pub kept: Vec<String>,
    /// Entries this build cannot restore; nothing is applied while one exists.
    pub unknown: Vec<String>,
    /// The restore of every entry that was in `Restoring`.
    pub restore: RestoreReport,
}

/// Settles what a crash or power cut left in the journal (plan 4.4, "Start-up
/// recovery"): a `Pending` entry whose current value equals its original is dropped
/// (the change never happened); otherwise it becomes `Applied` (a later restore puts
/// the original back). An entry in `Restoring` is restored again. Run once at start,
/// before anything is applied.
pub fn startup_recover(ctx: &JournalCtx<'_>) -> StartupReport {
    let mut report = StartupReport::default();
    let entries: Vec<JournalEntry> = ctx.shared.read(|state| state.journal.clone());
    let mut restoring: Vec<String> = Vec::new();
    for entry in &entries {
        match (&entry.target, entry.phase) {
            (JournalTarget::Unknown(_), _) => report.unknown.push(entry.id.clone()),
            (_, EntryPhase::Restoring) => restoring.push(entry.id.clone()),
            (_, EntryPhase::Applied) => {}
            (target, EntryPhase::Pending) => {
                let untouched = match target {
                    JournalTarget::MachineValue(_)
                    | JournalTarget::StaffValue { .. }
                    | JournalTarget::SafeBootEntry { .. }
                    | JournalTarget::AccountLockoutPolicy
                    | JournalTarget::BcdElement { .. }
                    | JournalTarget::CiPolicy { .. }
                    | JournalTarget::WlanProfile { .. }
                    | JournalTarget::WlanFilters => {
                        match read_current(ctx, target) {
                            Ok(current) => original_matches(ctx, &current, &entry.original),
                            // Cannot compare: keep it as it is and look again at the next start.
                            Err(_) => continue,
                        }
                    }
                    // The other targets get their read-back from the layer that uses them;
                    // until then they are treated as applied, which restores them (restore
                    // is idempotent).
                    _ => false,
                };
                let outcome = if untouched {
                    persist(ctx, |state| state.journal.retain(|e| e.id != entry.id)).map(|()| true)
                } else {
                    set_phase(ctx, &entry.id, EntryPhase::Applied).map(|()| false)
                };
                match outcome {
                    Ok(true) => report.dropped.push(entry.id.clone()),
                    Ok(false) => report.kept.push(entry.id.clone()),
                    Err(error) => tracing::error!("cannot settle journal entry {}: {error}", entry.id),
                }
            }
        }
    }
    if !restoring.is_empty() {
        report.restore = restore_matching(ctx, |entry| restoring.contains(&entry.id));
    }
    report
}

fn original_matches(ctx: &JournalCtx<'_>, current: &Value, original: &OriginalValue) -> bool {
    let current = match (current, original) {
        (Value::Lockout(now), OriginalValue::LockoutPolicy { threshold, duration_s, window_s }) => {
            return now.threshold == *threshold && now.duration_s == *duration_s && now.window_s == *window_s
        }
        (Value::Bcd(now), OriginalValue::BcdValue(was)) => return now == was,
        (Value::Ci(now), OriginalValue::NotPresent | OriginalValue::Absent) => return now.is_none(),
        (Value::Wlan(now), OriginalValue::NotPresent | OriginalValue::Absent) => return now.is_none(),
        (Value::WlanFilters(now), OriginalValue::NotPresent | OriginalValue::Absent) => return now.is_empty(),
        (Value::WlanFilters(now), OriginalValue::MultiString(was)) => return now == was,
        (Value::Reg(current), _) => current,
        _ => return false,
    };
    match (current, original) {
        (None, OriginalValue::Absent | OriginalValue::NotPresent) => true,
        (Some(RegData::Dword(a)), OriginalValue::Dword(b)) => a == b,
        (Some(RegData::String(a)), OriginalValue::String(b)) => a == b,
        (Some(RegData::String(a)), OriginalValue::InSecrets) => ctx
            .shared
            .secrets(|secrets| secrets.original_default_password_registry.clone())
            .ok()
            .flatten()
            .is_some_and(|kept| &kept == a),
        _ => false,
    }
}

#[cfg(test)]
mod tests;
