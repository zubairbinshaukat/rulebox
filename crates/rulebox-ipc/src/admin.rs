//! Admin-pipe params and results (used by `rulebox-agent enroll|status|unenroll`).
//! Not exported to TypeScript: only the agent and its CLI speak this pipe.

use serde::{Deserialize, Serialize};

use crate::methods::{Empty, Method};
use crate::types::{AgentSnapshot, KioskStatus};

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AdminStatusResult {
    pub snapshot: AgentSnapshot,
    /// (1.1) What `status` shows beyond the snapshot. Filled from Step 6a on;
    /// `None` from an agent that does not send it.
    #[serde(default)]
    pub extra: Option<AdminStatusExtra>,
}

/// (1.1) Operator-facing details for `rulebox-agent status`. Counters and states
/// only: never the PIN hash or any password material.
#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct AdminStatusExtra {
    /// Display name of the signed-in employee, if any.
    pub employee: Option<String>,
    /// Wrong admin-exit PINs since the last correct one.
    pub admin_exit_failures: u32,
    /// Milliseconds the admin exit stays locked, when it is locked.
    pub admin_exit_locked_for_ms: Option<u64>,
    /// Why the admin exit is unavailable (for example no PIN set).
    pub admin_exit_problem: Option<String>,
    /// Audit records waiting to be uploaded.
    pub audit_queued: u32,
}

/// (1.1) `data` of an `operation_failed` error response on the admin pipe.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OperationFailure {
    pub reason: String,
    #[serde(default)]
    pub details: Option<serde_json::Value>,
}

/// Values of `OperationFailure::reason`.
pub mod reasons {
    /// A method whose step is not built yet.
    pub const NOT_AVAILABLE_YET: &str = "not_available_yet";
    pub const ALREADY_ENROLLED: &str = "already_enrolled";
    /// details: `{ "kind": "badPrefix" | "badEncoding" | "malformed" | "badUrl" | "badToken" }`.
    pub const CODE_INVALID: &str = "code_invalid";
    /// details: `{ "blockers": ["no_other_admin", ...] }`.
    pub const COMPAT_BLOCKED: &str = "compat_blocked";
    /// Retryable.
    pub const BACKEND_UNREACHABLE: &str = "backend_unreachable";
    pub const TOKEN_INVALID: &str = "token_invalid";
    pub const TOKEN_EXPIRED: &str = "token_expired";
    pub const TOKEN_USED_UP: &str = "token_used_up";
    pub const TOKEN_REVOKED: &str = "token_revoked";
    /// Any other server code; details: `{ "serverCode": "..." }`.
    pub const BACKEND_REJECTED: &str = "backend_rejected";
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AdminEnrollParams {
    /// The `RBX1.<base64>#<token>` enrollment code.
    pub code: String,
    pub device_name: Option<String>,
    /// `--allow-joined`: enroll a domain- or Entra-joined PC anyway.
    pub allow_joined: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AdminEnrollResult {
    pub device_id: String,
    pub device_name: String,
    pub kiosk: KioskStatus,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AdminUnenrollParams {
    pub remove_staff_account: bool,
}

pub struct AdminStatus;
impl Method for AdminStatus {
    const NAME: &'static str = "admin.status";
    type Params = Empty;
    type Result = AdminStatusResult;
}

pub struct AdminEnroll;
impl Method for AdminEnroll {
    const NAME: &'static str = "admin.enroll";
    type Params = AdminEnrollParams;
    type Result = AdminEnrollResult;
}

pub struct AdminUnenroll;
impl Method for AdminUnenroll {
    const NAME: &'static str = "admin.unenroll";
    type Params = AdminUnenrollParams;
    type Result = Empty;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enroll_params_use_camel_case() {
        let params = AdminEnrollParams { code: "RBX1.x#y".into(), device_name: None, allow_joined: true };
        let value = serde_json::to_value(&params).unwrap();
        assert_eq!(value, serde_json::json!({ "code": "RBX1.x#y", "deviceName": null, "allowJoined": true }));
    }

    #[test]
    fn operation_failure_round_trips_the_contract_example() {
        // Section 6.7: the `data` of an `operation_failed` error.
        let value = serde_json::json!({ "reason": "already_enrolled", "details": null });
        let parsed: OperationFailure = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(parsed, OperationFailure { reason: reasons::ALREADY_ENROLLED.into(), details: None });
        assert_eq!(serde_json::to_value(&parsed).unwrap(), value);

        let with_details = serde_json::json!({ "reason": "compat_blocked",
                                               "details": { "blockers": ["no_other_admin"] } });
        let parsed: OperationFailure = serde_json::from_value(with_details.clone()).unwrap();
        assert_eq!(parsed.reason, reasons::COMPAT_BLOCKED);
        assert_eq!(serde_json::to_value(&parsed).unwrap(), with_details);

        // A missing `details` reads as `None`.
        let bare: OperationFailure = serde_json::from_str(r#"{ "reason": "token_expired" }"#).unwrap();
        assert_eq!(bare.details, None);
    }

    #[test]
    fn operation_failure_travels_inside_an_error_frame() {
        use crate::envelope::{ErrorCode, Frame};
        let text = r#"{ "t": "res", "id": 1, "ok": false,
            "error": { "code": "operation_failed", "message": "This PC is already enrolled.",
                       "retryable": false,
                       "data": { "reason": "already_enrolled", "details": null } } }"#;
        let Frame::Response { error: Some(error), .. } = serde_json::from_str(text).unwrap() else {
            panic!("expected an error response");
        };
        assert_eq!(error.code, ErrorCode::OperationFailed);
        let failure: OperationFailure = serde_json::from_value(error.data.unwrap()).unwrap();
        assert_eq!(failure.reason, reasons::ALREADY_ENROLLED);
    }

    #[test]
    fn admin_status_extra_is_optional_and_camel_case() {
        use crate::types::{
            AgentSnapshot, ConnectionStatus, DisplayMode, EnrollmentStatus, KioskPhase, KioskStatus,
            ShellHealth, ShellStatus,
        };
        let snapshot = AgentSnapshot {
            agent_version: "0.0.0".into(),
            enrollment: EnrollmentStatus::NotEnrolled,
            device: None,
            convex_url: None,
            connection: ConnectionStatus::Offline,
            kiosk: KioskStatus { enabled: false, phase: KioskPhase::NotApplied, error_code: None },
            shell: ShellStatus { health: ShellHealth::NotRunning },
            display_mode: DisplayMode::Standard,
            desired_state: None,
            desired_state_version: 0,
            server_time_offset_ms: None,
            clock_suspect: false,
            admin_exit: None,
            power: None,
            org_name: None,
        };
        // A 1.0 agent sends no `extra`.
        let mut value = serde_json::json!({ "snapshot": serde_json::to_value(&snapshot).unwrap() });
        let parsed: AdminStatusResult = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(parsed.extra, None);

        value["extra"] = serde_json::json!({
            "employee": "Maya Chen", "adminExitFailures": 2, "adminExitLockedForMs": 60000,
            "adminExitProblem": null, "auditQueued": 5
        });
        let parsed: AdminStatusResult = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(
            parsed.extra,
            Some(AdminStatusExtra {
                employee: Some("Maya Chen".into()),
                admin_exit_failures: 2,
                admin_exit_locked_for_ms: Some(60_000),
                admin_exit_problem: None,
                audit_queued: 5,
            })
        );
        assert_eq!(serde_json::to_value(&parsed).unwrap(), value);
    }
}
