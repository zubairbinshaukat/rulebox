//! Admin-pipe params and results (used by `rulebox-agent enroll|status|unenroll`).
//! Not exported to TypeScript: only the agent and its CLI speak this pipe.

use serde::{Deserialize, Serialize};

use crate::methods::{Empty, Method};
use crate::types::{AgentSnapshot, KioskStatus};

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AdminStatusResult {
    pub snapshot: AgentSnapshot,
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
}
