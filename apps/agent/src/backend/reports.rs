//! (Phase 5 Step 9, plan 4.11 and 4.19) The payloads of the lockdown device reports and
//! the arguments they become. Step 10 writes the Convex functions that receive them
//! (`deviceApi:reportApply`, `reportFindings`, `reportSecurityDaily`); the agent side is
//! complete without them, and nothing sends these calls until Step 20 wires the reconciler.
//!
//! Every field is a number, a fixed code or a hash. **No path, window title, command
//! line, document name or URL ever appears here** (plan rule 6); `findings` carries the
//! file name and a folder class, never the folder.
//!
//! Each call is change-driven and small: see `lockdown::reporting` for when they go out
//! and plan 4.19 for the writes per device per day.

use std::collections::BTreeMap;

use convex::Value;
use rulebox_policy::lockdown::ConfigRef;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::value::from_json;
use super::DeviceAuth;
use crate::lockdown::LayerStates;

/// Convex function names (Step 10 creates them).
pub const FN_REPORT_APPLY: &str = "deviceApi:reportApply";
pub const FN_REPORT_FINDINGS: &str = "deviceApi:reportFindings";
pub const FN_REPORT_SECURITY_DAILY: &str = "deviceApi:reportSecurityDaily";

/// At most this many fingerprints in one `reportFindings` call (plan 4.19).
pub const MAX_FINDINGS_PER_CALL: usize = 50;
/// At most this many Wi-Fi profiles or printers in an apply report (plan 4.2).
pub const MAX_ITEM_STATES: usize = 50;
/// At most this many permission-denial rows in a daily summary (plan 4.2).
pub const MAX_PERMISSION_DENIALS: usize = 100;

/// `deviceApplyReports.state` (plan 4.2).
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ApplyState {
    Applied,
    Partial,
    Refused,
    Failed,
    RolledBack,
}

/// One Wi-Fi profile's state (`wifi[]`): a fixed code, never free text from Windows.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WifiItemState {
    pub profile_id: String,
    pub revision: u64,
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// One printer's state (`printers[]`).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PrinterItemState {
    pub printer_id: String,
    pub revision: u64,
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// `deviceApi:reportApply` (plan 4.11). The server upserts `deviceApplyReports` only when
/// [`ApplyReport::content_hash`] differs from the stored one.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ApplyReport {
    pub applied_version: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config: Option<ConfigRef>,
    pub state: ApplyState,
    /// The code of 4.6 (`would_block_exit`, ...), `policy_rejected` or `journal_unknown_target`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refusal: Option<String>,
    pub layers: LayerStates,
    pub wifi: Vec<WifiItemState>,
    pub printers: Vec<PrinterItemState>,
    /// The version of the device's last-known-good copy.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lkg_version: Option<u64>,
    pub capabilities: Vec<String>,
}

impl ApplyReport {
    /// SHA-256 (hex) of the report's JSON. The fields are in a fixed order and none of them
    /// is a time, so equal content gives an equal hash.
    pub fn content_hash(&self) -> String {
        let text = serde_json::to_string(self).unwrap_or_default();
        Sha256::digest(text.as_bytes()).iter().map(|byte| format!("{byte:02x}")).collect()
    }
}

/// One new finding (plan 4.10): the fingerprint and what the dashboard shows.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FindingReport {
    pub fingerprint: String,
    /// `appLocker | appControl | procWatch`.
    pub layer: String,
    pub file_name: String,
    pub folder_class: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signer: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub product: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
}

/// `blocked` of a daily summary: programs stopped per layer, and elevation prompts refused.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BlockedCounts {
    pub app_locker: u64,
    pub app_control: u64,
    pub proc_watch: u64,
    pub elevation: u64,
}

impl BlockedCounts {
    pub fn total(&self) -> u64 {
        self.app_locker + self.app_control + self.proc_watch + self.elevation
    }
}

/// One web-app permission that was asked for and refused (a count per app and kind).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PermissionDenial {
    pub app_id: String,
    pub kind: String,
    pub count: u64,
}

/// `deviceApi:reportSecurityDaily`: one device's counters for one server (UTC) day.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SecurityDaily {
    /// `YYYY-MM-DD`, the server's UTC day.
    pub day: String,
    pub blocked: BlockedCounts,
    pub permission_denials: Vec<PermissionDenial>,
    pub drift: u64,
    pub tamper: u64,
}

impl SecurityDaily {
    /// True when a report would say nothing (such a day is never sent).
    pub fn is_zero(&self) -> bool {
        self.blocked.total() == 0 && self.permission_denials.is_empty() && self.drift == 0 && self.tamper == 0
    }
}

/// One lockdown report call.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LockdownCall {
    Apply(Box<ApplyReport>),
    /// At most [`MAX_FINDINGS_PER_CALL`] new fingerprints.
    Findings(Vec<FindingReport>),
    SecurityDaily(SecurityDaily),
}

impl LockdownCall {
    /// The Convex function the call goes to.
    pub fn function(&self) -> &'static str {
        match self {
            LockdownCall::Apply(_) => FN_REPORT_APPLY,
            LockdownCall::Findings(_) => FN_REPORT_FINDINGS,
            LockdownCall::SecurityDaily(_) => FN_REPORT_SECURITY_DAILY,
        }
    }

    /// The call's data without the credentials, as JSON.
    pub fn body(&self) -> serde_json::Value {
        match self {
            LockdownCall::Apply(report) => {
                let mut body = serde_json::to_value(report).unwrap_or(serde_json::Value::Null);
                if let Some(object) = body.as_object_mut() {
                    object.insert("contentHash".to_string(), serde_json::Value::String(report.content_hash()));
                }
                body
            }
            LockdownCall::Findings(findings) => serde_json::json!({ "findings": findings }),
            LockdownCall::SecurityDaily(daily) => serde_json::to_value(daily).unwrap_or(serde_json::Value::Null),
        }
    }
}

/// The arguments of a lockdown call: the device credentials and the call's own keys.
pub fn lockdown_args(auth: &DeviceAuth, call: &LockdownCall) -> BTreeMap<String, Value> {
    let mut args = super::convex::auth_args(auth);
    if let serde_json::Value::Object(fields) = call.body() {
        for (key, field) in fields {
            args.insert(key, from_json(&field));
        }
    }
    args
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lockdown::LayerStates;

    fn apply() -> ApplyReport {
        ApplyReport {
            applied_version: 7,
            config: None,
            state: ApplyState::Applied,
            refusal: None,
            layers: LayerStates::all_off(),
            wifi: Vec::new(),
            printers: Vec::new(),
            lkg_version: None,
            capabilities: Vec::new(),
        }
    }

    #[test]
    fn the_apply_report_is_camel_case_and_its_hash_follows_its_content() {
        let report = apply();
        let json = serde_json::to_value(&report).unwrap();
        assert_eq!(json["appliedVersion"], 7);
        assert_eq!(json["state"], "applied");
        assert!(json.get("refusal").is_none() && json.get("lkgVersion").is_none());
        assert_eq!(report.content_hash(), apply().content_hash());
        assert_eq!(report.content_hash().len(), 64);
        let rolled = ApplyReport { state: ApplyState::RolledBack, ..apply() };
        assert_ne!(rolled.content_hash(), report.content_hash());
        assert_eq!(serde_json::to_value(&rolled).unwrap()["state"], "rolledBack");
    }

    #[test]
    fn the_call_arguments_hold_the_credentials_and_the_report_only() {
        let auth = DeviceAuth { device_id: "dev1".into(), device_secret: "s".into() };
        let args = lockdown_args(&auth, &LockdownCall::Apply(Box::new(apply())));
        assert!(args.contains_key("deviceId") && args.contains_key("deviceSecret"));
        assert!(args.contains_key("appliedVersion") && args.contains_key("contentHash"));
        assert!(args.contains_key("layers"));
        let findings = lockdown_args(&auth, &LockdownCall::Findings(Vec::new()));
        assert!(findings.contains_key("findings"));
        let daily = lockdown_args(&auth, &LockdownCall::SecurityDaily(SecurityDaily { day: "2026-11-08".into(), ..SecurityDaily::default() }));
        assert!(daily.contains_key("day") && daily.contains_key("blocked"));
    }

    #[test]
    fn a_day_without_counters_says_nothing() {
        assert!(SecurityDaily { day: "2026-11-08".into(), ..SecurityDaily::default() }.is_zero());
        let blocked = SecurityDaily { blocked: BlockedCounts { proc_watch: 1, ..BlockedCounts::default() }, ..SecurityDaily::default() };
        assert!(!blocked.is_zero());
    }
}
