//! The lockdown part of the agent-only desired-state keys (plan Phase 5, Section
//! 4.3 and 4.7a): `lockdown`, `usbTempAllow` and `config`. Pure data: no I/O, no
//! Windows calls. The agent parses these from the verified document (`AgentDoc`);
//! the dashboard and the Convex builder use the generated TypeScript types.
//!
//! * Every enum uses [`unknown_on_new_values!`]: a value this build does not know
//!   becomes `Unknown`. What to do with it (keep the last applied value of that
//!   section, report `section_unknown_value`, plan 4.3 rule 2) is the apply
//!   code's job, not this module's.
//! * Every struct has `#[serde(default)]`: a missing sub-key takes the default of
//!   4.3 (restricted, layers in `audit`, USB allowed). An unknown JSON key is
//!   ignored (no `deny_unknown_fields`), like the rest of the document.
//! * The USB scope of a class (Staff only or whole PC) is [`UsbGroup::scope`], the
//!   one place to change when the owner decides otherwise.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::paths::{exception_path_problem, PathProblem};

// ---------------------------------------------------------------- limits (4.3 rule 4)

/// `lockdown.exceptions`.
pub const MAX_EXCEPTIONS: usize = 200;
/// `ExceptionRule.publisher.subject`, in characters.
pub const MAX_PUBLISHER_SUBJECT: usize = 200;
/// `publisher.product` and `publisher.fileName`, in characters.
pub const MAX_PUBLISHER_FIELD: usize = 100;
/// `ExceptionRule.id`, `appId`, in characters (a Convex id).
pub const MAX_ID_CHARS: usize = 64;
/// A temporary USB allow lasts at most this long (plan 4.3 `usbTempAllow`): 8 hours.
pub const MAX_USB_TEMP_ALLOW_MS: u64 = 8 * 60 * 60 * 1000;

/// A limit of plan 4.3 rule 4 was exceeded. The whole document is refused
/// (`policy_rejected`); fixed texts only, never the value.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum LimitError {
    #[error("more than 200 exceptions")]
    TooManyExceptions,
    #[error("more than 20 Wi-Fi profiles")]
    TooManyWifi,
    #[error("more than 20 printers")]
    TooManyPrinters,
    #[error("more than 20 drivers")]
    TooManyDrivers,
    #[error("more than 5 active broadcasts")]
    TooManyBroadcasts,
    #[error("a text is longer than its limit")]
    TextTooLong,
    #[error("a text is empty")]
    TextEmpty,
    #[error("a Wi-Fi network name must be 1 to 32 bytes")]
    BadSsid,
    #[error("a printer port must be 1 to 65535")]
    BadPort,
    /// (Phase 6, plan 4.3) More than 60 web apps that open in Chrome or Edge.
    #[error("more than 60 browser web apps")]
    TooManyBrowserApps,
    /// (Phase 6) More than 800 browser URL patterns on one device.
    #[error("more than 800 browser URL patterns")]
    TooManyBrowserPatterns,
    /// (Phase 6, plan 4.14) `webWindowCap` outside 1 to 12.
    #[error("the web window cap must be 1 to 12")]
    BadWindowCap,
    /// (Phase 6) `webIdleCloseMin` that is neither 0 nor 5 to 240.
    #[error("the idle-close time must be 0 or 5 to 240 minutes")]
    BadIdleClose,
    /// (Phase 6, plan 4.17) `ruleboxRelease` without an ordered version, an https URL
    /// or a SHA-256.
    #[error("the Rulebox release needs an ordered version, an https URL and a SHA-256")]
    BadRelease,
    /// (Phase 6 Step 14) An installer's `silentArgs` break the rules of `check_silent_args` (a limit, a control
    /// character, or a `{...}` that is not `{AnswerFile}` or `{LogFile}`).
    #[error("an installer's silent arguments break the rules")]
    BadSilentArgs,
}

// ---------------------------------------------------------------- enums

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum LayerMode {
    Off,
    Audit,
    Enforce,
    Unknown,
}
unknown_on_new_values!(LayerMode { Off => "off", Audit => "audit", Enforce => "enforce" });

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum AppControlLevel {
    RecommendedBlocks,
    Allowlist,
    Unknown,
}
unknown_on_new_values!(AppControlLevel { RecommendedBlocks => "recommendedBlocks", Allowlist => "allowlist" });

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ExceptionKind {
    Publisher,
    Hash,
    Path,
    Unknown,
}
unknown_on_new_values!(ExceptionKind { Publisher => "publisher", Hash => "hash", Path => "path" });

/// The layers an exception can apply to. There is no App Control value on purpose:
/// App Control is never loosened by an exception (plan 4.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ExceptionLayer {
    AppLocker,
    ProcWatch,
    Unknown,
}
unknown_on_new_values!(ExceptionLayer { AppLocker => "appLocker", ProcWatch => "procWatch" });

/// `keyboard.winCombos` (Q7).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum WinCombos {
    Pass,
    Swallow,
    Unknown,
}
unknown_on_new_values!(WinCombos { Pass => "pass", Swallow => "swallow" });

/// `usb.storage` (Q4).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum UsbStorageMode {
    Allow,
    ReadOnly,
    Block,
    Unknown,
}
unknown_on_new_values!(UsbStorageMode { Allow => "allow", ReadOnly => "readOnly", Block => "block" });

/// `usb.printers`, `usb.imaging`, `usb.phones`, `usb.other` (4.7a).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum UsbSwitch {
    Allow,
    Block,
    Unknown,
}
unknown_on_new_values!(UsbSwitch { Allow => "allow", Block => "block" });

/// `boot.autoRecovery` (4.16).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum AutoRecovery {
    Leave,
    Off,
    Unknown,
}
unknown_on_new_values!(AutoRecovery { Leave => "leave", Off => "off" });

/// The rollout ring of a configuration (4.14).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum Ring {
    Pilot,
    Early,
    Everyone,
    Unknown,
}
unknown_on_new_values!(Ring { Pilot => "pilot", Early => "early", Everyone => "everyone" });

// ---------------------------------------------------------------- USB groups (4.7a)

/// Who a USB group applies to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UsbScope {
    /// Only the Staff account (per-user policy in the Staff hive); administrators unaffected.
    Staff,
    /// The whole PC, administrators included (device installation restrictions).
    Machine,
}

/// The five USB device groups of 4.7a. Not part of the wire format; the keys of
/// [`UsbPolicy`] are.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UsbGroup {
    Storage,
    Printers,
    Imaging,
    Phones,
    Other,
}

impl UsbGroup {
    pub const ALL: [UsbGroup; 5] =
        [UsbGroup::Storage, UsbGroup::Printers, UsbGroup::Imaging, UsbGroup::Phones, UsbGroup::Other];

    /// Plan 4.7a "Scope rule" (pending the owner's confirmation): storage and phones
    /// are Staff-only, printers, imaging and other are machine-wide. This is the only
    /// place that says so; the apply code asks it.
    pub const fn scope(self) -> UsbScope {
        match self {
            UsbGroup::Storage | UsbGroup::Phones => UsbScope::Staff,
            UsbGroup::Printers | UsbGroup::Imaging | UsbGroup::Other => UsbScope::Machine,
        }
    }
}

// ---------------------------------------------------------------- structs

/// `lockdown.staff`: `true` = restricted (4.7). Everything restricted by default.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct StaffRestrictions {
    pub task_manager: bool,
    pub run: bool,
    pub command_prompt: bool,
    pub registry_tools: bool,
    pub settings: bool,
    pub sign_out: bool,
    pub change_password: bool,
    pub hide_drives: bool,
    pub accessibility_hotkeys: bool,
    pub office_macros: bool,
}

impl Default for StaffRestrictions {
    fn default() -> Self {
        Self {
            task_manager: true,
            run: true,
            command_prompt: true,
            registry_tools: true,
            settings: true,
            sign_out: true,
            change_password: true,
            hide_drives: true,
            accessibility_hotkeys: true,
            office_macros: true,
        }
    }
}

/// `machine.accountLockout`; `null` in the document = leave the machine's setting alone (4.8).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AccountLockout {
    pub threshold: u32,
    pub duration_min: u32,
    pub window_min: u32,
}

impl Default for AccountLockout {
    fn default() -> Self {
        Self { threshold: 10, duration_min: 15, window_min: 15 }
    }
}

fn default_account_lockout() -> Option<AccountLockout> {
    Some(AccountLockout::default())
}

/// `lockdown.machine` (4.8). Booleans: `true` = restricted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct MachineRestrictions {
    pub hide_switch_user: bool,
    pub hide_sign_in_power: bool,
    pub deny_elevation_requests: bool,
    pub hide_admin_tiles: bool,
    pub no_wake_password: bool,
    pub restrict_printer_drivers: bool,
    pub file_output_printers: bool,
    /// Missing = the default `{10, 15, 15}`; an explicit `null` = leave the machine's setting.
    #[serde(default = "default_account_lockout")]
    pub account_lockout: Option<AccountLockout>,
}

impl Default for MachineRestrictions {
    fn default() -> Self {
        Self {
            hide_switch_user: true,
            hide_sign_in_power: true,
            deny_elevation_requests: true,
            hide_admin_tiles: true,
            no_wake_password: true,
            restrict_printer_drivers: true,
            file_output_printers: true,
            account_lockout: default_account_lockout(),
        }
    }
}

/// `appLocker` and `procWatch`: just a mode, `audit` by default (rule 4).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct LayerSetting {
    pub mode: LayerMode,
}

impl Default for LayerSetting {
    fn default() -> Self {
        Self { mode: LayerMode::Audit }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct AppControlSetting {
    pub mode: LayerMode,
    pub level: AppControlLevel,
}

impl Default for AppControlSetting {
    fn default() -> Self {
        Self { mode: LayerMode::Audit, level: AppControlLevel::RecommendedBlocks }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct KeyboardPolicy {
    pub win_combos: WinCombos,
}

impl Default for KeyboardPolicy {
    fn default() -> Self {
        Self { win_combos: WinCombos::Swallow }
    }
}

/// `lockdown.usb` (4.3, 4.7a). Replaces the earlier single `usbStorage` switch.
/// Keyboards, mice, touch, hubs and built-in devices have no key here on purpose
/// (invariant I10): they cannot be named by any document.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct UsbPolicy {
    pub storage: UsbStorageMode,
    pub printers: UsbSwitch,
    pub imaging: UsbSwitch,
    pub phones: UsbSwitch,
    pub other: UsbSwitch,
    /// Also act on devices that are already installed (never input devices, I10).
    pub retroactive: bool,
}

impl Default for UsbPolicy {
    fn default() -> Self {
        Self {
            storage: UsbStorageMode::Allow,
            printers: UsbSwitch::Allow,
            imaging: UsbSwitch::Allow,
            phones: UsbSwitch::Allow,
            other: UsbSwitch::Allow,
            retroactive: false,
        }
    }
}

impl UsbPolicy {
    /// True when the group is restricted in any way (`storage` counts `readOnly`).
    /// An `Unknown` value counts as not restricted here; the apply code treats an
    /// unknown value as "keep the last applied value" (4.3 rule 2).
    pub fn restricts(&self, group: UsbGroup) -> bool {
        match group {
            UsbGroup::Storage => matches!(self.storage, UsbStorageMode::ReadOnly | UsbStorageMode::Block),
            UsbGroup::Printers => self.printers == UsbSwitch::Block,
            UsbGroup::Imaging => self.imaging == UsbSwitch::Block,
            UsbGroup::Phones => self.phones == UsbSwitch::Block,
            UsbGroup::Other => self.other == UsbSwitch::Block,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct BootPolicy {
    pub auto_recovery: AutoRecovery,
    pub safe_mode_guard: bool,
}

impl Default for BootPolicy {
    fn default() -> Self {
        Self { auto_recovery: AutoRecovery::Off, safe_mode_guard: true }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct PerformancePolicy {
    pub staff_tuning: bool,
    pub kiosk_profile: bool,
    pub no_printing: bool,
}

impl Default for PerformancePolicy {
    fn default() -> Self {
        Self { staff_tuning: true, kiosk_profile: true, no_printing: false }
    }
}

/// The match of a `publisher` exception: the signer's subject, optionally narrowed
/// to a product and a file name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PublisherMatch {
    pub subject: String,
    #[serde(default)]
    pub product: Option<String>,
    #[serde(default)]
    pub file_name: Option<String>,
}

/// Why an [`ExceptionRule`] is refused. Fixed texts only.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum ExceptionProblem {
    #[error("exception kind or layer is not known")]
    UnknownValue,
    #[error("exception needs exactly the field of its kind")]
    WrongFields,
    #[error("exception has no layer")]
    NoLayers,
    #[error("publisher subject, product or file name is empty or too long")]
    BadPublisher,
    #[error("hash must be 64 lower-case hex characters")]
    BadHash,
    #[error("path is not an allowed template: {0}")]
    BadPath(PathProblem),
    #[error("id is empty or too long")]
    BadId,
}

/// One exception of `lockdown.exceptions` (4.3, 4.9): loosens AppLocker and/or the
/// process watchdog for one publisher, hash or path. Never App Control.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ExceptionRule {
    /// Convex `lockdownExceptions` id.
    pub id: String,
    /// Catalogue id the exception belongs to; `None` = group-wide.
    #[serde(default)]
    pub app_id: Option<String>,
    pub kind: ExceptionKind,
    #[serde(default)]
    pub publisher: Option<PublisherMatch>,
    /// 64 lower-case hex characters.
    #[serde(default)]
    pub sha256: Option<String>,
    /// A path TEMPLATE (`{ProgramFiles}\…`), never a real or user folder.
    #[serde(default)]
    pub path: Option<String>,
    pub layers: Vec<ExceptionLayer>,
}

fn present_and_short(text: &str, max: usize) -> bool {
    !text.trim().is_empty() && text.chars().count() <= max
}

impl ExceptionRule {
    /// Defence in depth (the document is signed): exactly one of publisher / hash /
    /// path is set and it matches `kind`; the value fits its rules; `layers` is not
    /// empty and holds only known layers (the type has no App Control value).
    pub fn validate(&self) -> Result<(), ExceptionProblem> {
        if !present_and_short(&self.id, MAX_ID_CHARS)
            || self.app_id.as_deref().is_some_and(|id| !present_and_short(id, MAX_ID_CHARS))
        {
            return Err(ExceptionProblem::BadId);
        }
        if self.layers.is_empty() {
            return Err(ExceptionProblem::NoLayers);
        }
        if self.layers.contains(&ExceptionLayer::Unknown) {
            return Err(ExceptionProblem::UnknownValue);
        }
        match self.kind {
            ExceptionKind::Unknown => Err(ExceptionProblem::UnknownValue),
            ExceptionKind::Publisher => {
                if self.sha256.is_some() || self.path.is_some() {
                    return Err(ExceptionProblem::WrongFields);
                }
                let Some(publisher) = &self.publisher else {
                    return Err(ExceptionProblem::WrongFields);
                };
                let optional_ok = |value: &Option<String>| {
                    value.as_deref().is_none_or(|text| present_and_short(text, MAX_PUBLISHER_FIELD))
                };
                if !present_and_short(&publisher.subject, MAX_PUBLISHER_SUBJECT)
                    || !optional_ok(&publisher.product)
                    || !optional_ok(&publisher.file_name)
                {
                    return Err(ExceptionProblem::BadPublisher);
                }
                Ok(())
            }
            ExceptionKind::Hash => {
                if self.publisher.is_some() || self.path.is_some() {
                    return Err(ExceptionProblem::WrongFields);
                }
                let Some(hash) = &self.sha256 else {
                    return Err(ExceptionProblem::WrongFields);
                };
                if hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
                    Ok(())
                } else {
                    Err(ExceptionProblem::BadHash)
                }
            }
            ExceptionKind::Path => {
                if self.publisher.is_some() || self.sha256.is_some() {
                    return Err(ExceptionProblem::WrongFields);
                }
                let Some(path) = &self.path else {
                    return Err(ExceptionProblem::WrongFields);
                };
                match exception_path_problem(path) {
                    None => Ok(()),
                    Some(problem) => Err(ExceptionProblem::BadPath(problem)),
                }
            }
        }
    }
}

/// The `lockdown` section of the document (4.3). Absent from the document = every
/// layer off and everything restored (compatibility rule 1), which is `None` in
/// [`crate::AgentDoc::lockdown`], not this type's `Default`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct LockdownPolicy {
    pub staff: StaffRestrictions,
    pub machine: MachineRestrictions,
    pub app_locker: LayerSetting,
    pub app_control: AppControlSetting,
    pub proc_watch: LayerSetting,
    pub exceptions: Vec<ExceptionRule>,
    pub keyboard: KeyboardPolicy,
    pub usb: UsbPolicy,
    pub accessibility_tools: bool,
    pub boot: BootPolicy,
    pub performance: PerformancePolicy,
}

impl LockdownPolicy {
    /// The limits of plan 4.3 rule 4 that belong to this section: at most 200
    /// exceptions. (The per-exception rules are [`ExceptionRule::validate`].)
    pub fn check_limits(&self) -> Result<(), LimitError> {
        if self.exceptions.len() > MAX_EXCEPTIONS {
            return Err(LimitError::TooManyExceptions);
        }
        Ok(())
    }
}

/// `usbTempAllow`: lifts the USB class blocks for this PC until `untilMs`. Live (not
/// ring-gated) and never adds an input-device rule. At most 8 hours.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct UsbTempAllow {
    #[ts(type = "number")]
    pub until_ms: u64,
}

impl UsbTempAllow {
    /// The moment the allow really ends: `untilMs`, but never more than 8 hours after
    /// `now_ms` (a document with a longer value is capped, not trusted). `None` when
    /// it has already ended.
    pub fn effective_until(&self, now_ms: u64) -> Option<u64> {
        if self.until_ms <= now_ms {
            return None;
        }
        Some(self.until_ms.min(now_ms.saturating_add(MAX_USB_TEMP_ALLOW_MS)))
    }
}

/// `config`: which configuration version of which group this document carries
/// (rollout rings, 4.14).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ConfigRef {
    pub group_id: String,
    #[ts(type = "number")]
    pub version: u64,
    pub ring: Ring,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sha(c: char) -> String {
        c.to_string().repeat(64)
    }

    fn hash_rule() -> ExceptionRule {
        ExceptionRule {
            id: "ex1".into(),
            app_id: None,
            kind: ExceptionKind::Hash,
            publisher: None,
            sha256: Some(sha('a')),
            path: None,
            layers: vec![ExceptionLayer::AppLocker],
        }
    }

    #[test]
    fn empty_object_gives_every_default_of_4_3() {
        let policy: LockdownPolicy = serde_json::from_str("{}").unwrap();
        assert_eq!(policy, LockdownPolicy::default());
        assert!(policy.staff.task_manager && policy.staff.office_macros);
        assert!(policy.machine.hide_admin_tiles && policy.machine.file_output_printers);
        assert_eq!(policy.machine.account_lockout, Some(AccountLockout { threshold: 10, duration_min: 15, window_min: 15 }));
        assert_eq!(policy.app_locker.mode, LayerMode::Audit);
        assert_eq!((policy.app_control.mode, policy.app_control.level), (LayerMode::Audit, AppControlLevel::RecommendedBlocks));
        assert_eq!(policy.proc_watch.mode, LayerMode::Audit);
        assert!(policy.exceptions.is_empty());
        assert_eq!(policy.keyboard.win_combos, WinCombos::Swallow);
        assert_eq!(policy.usb, UsbPolicy::default());
        assert!(!policy.usb.retroactive);
        for group in UsbGroup::ALL {
            assert!(!policy.usb.restricts(group));
        }
        assert!(!policy.accessibility_tools);
        assert_eq!((policy.boot.auto_recovery, policy.boot.safe_mode_guard), (AutoRecovery::Off, true));
        assert_eq!(policy.performance, PerformancePolicy { staff_tuning: true, kiosk_profile: true, no_printing: false });
    }

    #[test]
    fn missing_sub_keys_take_defaults_and_unknown_keys_are_ignored() {
        let policy: LockdownPolicy = serde_json::from_str(
            r#"{ "staff": { "run": false, "somethingNew": 1 }, "usb": { "storage": "readOnly" },
                 "futureSection": { "x": 1 }, "machine": { "accountLockout": null } }"#,
        )
        .unwrap();
        assert!(!policy.staff.run && policy.staff.task_manager);
        assert_eq!(policy.usb.storage, UsbStorageMode::ReadOnly);
        assert_eq!(policy.usb.printers, UsbSwitch::Allow);
        // An explicit null is "leave the machine's setting"; a missing key is the default.
        assert_eq!(policy.machine.account_lockout, None);
        assert!(policy.machine.hide_switch_user);
    }

    #[test]
    fn defaults_round_trip_and_serialize_in_the_documented_order() {
        let policy = LockdownPolicy::default();
        let text = serde_json::to_string(&policy).unwrap();
        let again: LockdownPolicy = serde_json::from_str(&text).unwrap();
        assert_eq!(again, policy);
        let keys: Vec<&str> = ["staff", "machine", "appLocker", "appControl", "procWatch", "exceptions", "keyboard", "usb",
            "accessibilityTools", "boot", "performance"].to_vec();
        let mut last = 0;
        for key in keys {
            let at = text.find(&format!("\"{key}\":")).unwrap_or_else(|| panic!("{key} missing"));
            assert!(at >= last, "{key} is out of order");
            last = at;
        }
        assert!(text.contains("\"usb\":{\"storage\":\"allow\",\"printers\":\"allow\",\"imaging\":\"allow\",\"phones\":\"allow\",\"other\":\"allow\",\"retroactive\":false}"));
        // The old single switch is gone.
        assert!(!text.contains("usbStorage"));
    }

    #[test]
    fn unknown_enum_values_become_unknown_never_off() {
        let policy: LockdownPolicy = serde_json::from_str(
            r#"{ "appLocker": { "mode": "paranoid" }, "appControl": { "level": "everything" },
                 "keyboard": { "winCombos": "explode" },
                 "usb": { "storage": "encrypted", "printers": "ask", "phones": "x", "imaging": "x", "other": "x" },
                 "boot": { "autoRecovery": "later" } }"#,
        )
        .unwrap();
        assert_eq!(policy.app_locker.mode, LayerMode::Unknown);
        assert_eq!(policy.app_control.level, AppControlLevel::Unknown);
        assert_eq!(policy.keyboard.win_combos, WinCombos::Unknown);
        assert_eq!(policy.usb.storage, UsbStorageMode::Unknown);
        assert_eq!(policy.usb.printers, UsbSwitch::Unknown);
        assert_eq!(policy.boot.auto_recovery, AutoRecovery::Unknown);
        // "Unknown" is not "restricted" and not "allowed" for the apply code to guess from.
        assert!(!policy.usb.restricts(UsbGroup::Storage));
    }

    #[test]
    fn usb_scope_follows_plan_4_7a() {
        let staff: Vec<UsbGroup> = UsbGroup::ALL.into_iter().filter(|g| g.scope() == UsbScope::Staff).collect();
        assert_eq!(staff, vec![UsbGroup::Storage, UsbGroup::Phones]);
        for group in [UsbGroup::Printers, UsbGroup::Imaging, UsbGroup::Other] {
            assert_eq!(group.scope(), UsbScope::Machine);
        }
        let policy = UsbPolicy { storage: UsbStorageMode::ReadOnly, printers: UsbSwitch::Block, ..UsbPolicy::default() };
        assert!(policy.restricts(UsbGroup::Storage) && policy.restricts(UsbGroup::Printers));
        assert!(!policy.restricts(UsbGroup::Imaging));
    }

    #[test]
    fn exceptions_over_200_are_refused() {
        let mut policy = LockdownPolicy { exceptions: vec![hash_rule(); MAX_EXCEPTIONS], ..LockdownPolicy::default() };
        assert_eq!(policy.check_limits(), Ok(()));
        policy.exceptions.push(hash_rule());
        assert_eq!(policy.check_limits(), Err(LimitError::TooManyExceptions));
    }

    #[test]
    fn exception_validate_accepts_each_kind() {
        assert_eq!(hash_rule().validate(), Ok(()));
        let publisher = ExceptionRule {
            kind: ExceptionKind::Publisher,
            sha256: None,
            publisher: Some(PublisherMatch { subject: "O=Acme Ltd".into(), product: Some("Tool".into()), file_name: None }),
            layers: vec![ExceptionLayer::AppLocker, ExceptionLayer::ProcWatch],
            ..hash_rule()
        };
        assert_eq!(publisher.validate(), Ok(()));
        for path in [r"{ProgramFiles}\Acme\tool.exe", r"{ProgramFilesX86}\Acme\tool.exe", r"{RuleboxApps}\app1\tool.exe"] {
            let rule = ExceptionRule { kind: ExceptionKind::Path, sha256: None, path: Some(path.into()), ..hash_rule() };
            assert_eq!(rule.validate(), Ok(()), "{path}");
        }
    }

    #[test]
    fn exception_validate_refuses_bad_rules() {
        let publisher_ok = PublisherMatch { subject: "O=Acme".into(), product: None, file_name: None };
        let path_rule = |path: &str| ExceptionRule { kind: ExceptionKind::Path, sha256: None, path: Some(path.into()), ..hash_rule() };
        let cases: Vec<(ExceptionRule, ExceptionProblem)> = vec![
            // kind and field do not match
            (ExceptionRule { sha256: None, ..hash_rule() }, ExceptionProblem::WrongFields),
            (ExceptionRule { path: Some(r"{ProgramFiles}\a\b.exe".into()), ..hash_rule() }, ExceptionProblem::WrongFields),
            (ExceptionRule { publisher: Some(publisher_ok.clone()), ..hash_rule() }, ExceptionProblem::WrongFields),
            (ExceptionRule { kind: ExceptionKind::Publisher, sha256: None, publisher: None, ..hash_rule() }, ExceptionProblem::WrongFields),
            (ExceptionRule { kind: ExceptionKind::Path, sha256: None, path: None, ..hash_rule() }, ExceptionProblem::WrongFields),
            (ExceptionRule { kind: ExceptionKind::Unknown, ..hash_rule() }, ExceptionProblem::UnknownValue),
            // layers
            (ExceptionRule { layers: vec![], ..hash_rule() }, ExceptionProblem::NoLayers),
            (ExceptionRule { layers: vec![ExceptionLayer::Unknown], ..hash_rule() }, ExceptionProblem::UnknownValue),
            // values
            (ExceptionRule { sha256: Some(sha('A')), ..hash_rule() }, ExceptionProblem::BadHash),
            (ExceptionRule { sha256: Some("abc".into()), ..hash_rule() }, ExceptionProblem::BadHash),
            (ExceptionRule { sha256: Some(sha('g')), ..hash_rule() }, ExceptionProblem::BadHash),
            (ExceptionRule { id: String::new(), ..hash_rule() }, ExceptionProblem::BadId),
            (
                ExceptionRule {
                    kind: ExceptionKind::Publisher,
                    sha256: None,
                    publisher: Some(PublisherMatch { subject: "x".repeat(201), ..publisher_ok.clone() }),
                    ..hash_rule()
                },
                ExceptionProblem::BadPublisher,
            ),
            (
                ExceptionRule {
                    kind: ExceptionKind::Publisher,
                    sha256: None,
                    publisher: Some(PublisherMatch { subject: " ".into(), ..publisher_ok.clone() }),
                    ..hash_rule()
                },
                ExceptionProblem::BadPublisher,
            ),
            // paths: roots, user folders, traversal, shells
            (path_rule(r"C:\Users\x\a.exe"), ExceptionProblem::BadPath(PathProblem::UnknownRoot)),
            (path_rule(r"{LocalAppData}\a.exe"), ExceptionProblem::BadPath(PathProblem::UnknownRoot)),
            (path_rule(r"{SystemRoot}\System32\notepad.exe"), ExceptionProblem::BadPath(PathProblem::UnknownRoot)),
            (path_rule(r"{ProgramFiles}\..\x.exe"), ExceptionProblem::BadPath(PathProblem::BadComponent)),
            (path_rule(r"{ProgramFiles}\a\b.bat"), ExceptionProblem::BadPath(PathProblem::NotExe)),
            (path_rule(r"{ProgramFiles}\PowerShell\7\pwsh.exe"), ExceptionProblem::BadPath(PathProblem::Denied)),
            (path_rule(r"{ProgramFiles}\"), ExceptionProblem::BadPath(PathProblem::BadComponent)),
        ];
        for (rule, expected) in cases {
            assert_eq!(rule.validate(), Err(expected), "{rule:?}");
        }
    }

    #[test]
    fn app_control_is_not_an_exception_layer() {
        let rule: ExceptionRule = serde_json::from_str(
            r#"{ "id": "e", "kind": "hash", "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
                 "layers": ["appControl"] }"#,
        )
        .unwrap();
        assert_eq!(rule.layers, vec![ExceptionLayer::Unknown]);
        assert_eq!(rule.validate(), Err(ExceptionProblem::UnknownValue));
    }

    #[test]
    fn usb_temp_allow_is_capped_at_eight_hours() {
        let now = 1_000_000;
        assert_eq!(UsbTempAllow { until_ms: now }.effective_until(now), None);
        assert_eq!(UsbTempAllow { until_ms: now - 1 }.effective_until(now), None);
        assert_eq!(UsbTempAllow { until_ms: now + 60_000 }.effective_until(now), Some(now + 60_000));
        assert_eq!(UsbTempAllow { until_ms: now + MAX_USB_TEMP_ALLOW_MS }.effective_until(now), Some(now + MAX_USB_TEMP_ALLOW_MS));
        assert_eq!(UsbTempAllow { until_ms: now + 24 * 3_600_000 }.effective_until(now), Some(now + MAX_USB_TEMP_ALLOW_MS));
        assert_eq!(UsbTempAllow { until_ms: u64::MAX }.effective_until(u64::MAX - 5), Some(u64::MAX));
    }
}
