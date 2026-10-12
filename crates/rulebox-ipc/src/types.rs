//! Types that cross the shell pipe (plan Section 6.6). TypeScript is generated
//! with ts-rs into `packages/types/src/generated/` (run `pnpm gen:types`).
//!
//! Every enum has an `Unknown` variant (`#[serde(other)]`) so a newer agent can
//! add values without breaking an older client (plan Section 6.5).

use rulebox_policy::DesiredState;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Deserializes an enum from a string; any value not listed becomes `Unknown`.
/// Written by hand because ts-rs cannot parse `#[serde(other)]` (it warns on
/// every build); the wire format is the same.
macro_rules! unknown_on_new_values {
    ($ty:ident { $($variant:ident => $text:literal),+ $(,)? }) => {
        impl<'de> Deserialize<'de> for $ty {
            fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
                let text = String::deserialize(d)?;
                Ok(match text.as_str() {
                    $($text => Self::$variant,)+
                    _ => Self::Unknown,
                })
            }
        }
    };
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ProtocolVersion {
    pub major: u16,
    pub minor: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HelloParams {
    pub protocol: ProtocolVersion,
    pub client: ClientInfo,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ClientInfo {
    pub role: ClientRole,
    pub name: String,
    pub version: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ClientRole {
    Shell,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HelloResult {
    pub protocol: ProtocolVersion,
    pub agent_version: String,
    pub capabilities: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum EnrollmentStatus {
    NotEnrolled,
    Enrolled,
    Revoked,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DeviceInfo {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ConnectionStatus {
    Offline,
    Connecting,
    Online,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum KioskPhase {
    NotApplied,
    Applying,
    Applied,
    Failed,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct KioskStatus {
    pub enabled: bool,
    pub phase: KioskPhase,
    pub error_code: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ShellHealth {
    NotRunning,
    Starting,
    Healthy,
    Unhealthy,
    Failed,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ShellStatus {
    pub health: ShellHealth,
}

/// PRD 22.5: RAM <= 4,352 MB selects `Lite`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum DisplayMode {
    Standard,
    Lite,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AgentSnapshot {
    pub agent_version: String,
    pub enrollment: EnrollmentStatus,
    pub device: Option<DeviceInfo>,
    /// Deployment URL from the enrollment code.
    pub convex_url: Option<String>,
    pub connection: ConnectionStatus,
    pub kiosk: KioskStatus,
    pub shell: ShellStatus,
    pub display_mode: DisplayMode,
    pub desired_state: Option<DesiredState>,
    /// Monotonic version; JSON number (stays well below 2^53).
    #[ts(type = "number")]
    pub desired_state_version: u64,
    #[ts(type = "number | null")]
    pub server_time_offset_ms: Option<i64>,
    pub clock_suspect: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ShutdownReason {
    Stop,
    KioskDisabled,
    Unknown,
}

/// Data of the `agent.shuttingDown` event.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ShuttingDownData {
    pub reason: ShutdownReason,
    #[ts(type = "number")]
    pub grace_ms: u64,
}

unknown_on_new_values!(ClientRole { Shell => "shell" });
unknown_on_new_values!(EnrollmentStatus {
    NotEnrolled => "notEnrolled",
    Enrolled => "enrolled",
    Revoked => "revoked",
});
unknown_on_new_values!(ConnectionStatus {
    Offline => "offline",
    Connecting => "connecting",
    Online => "online",
});
unknown_on_new_values!(KioskPhase {
    NotApplied => "notApplied",
    Applying => "applying",
    Applied => "applied",
    Failed => "failed",
});
unknown_on_new_values!(ShellHealth {
    NotRunning => "notRunning",
    Starting => "starting",
    Healthy => "healthy",
    Unhealthy => "unhealthy",
    Failed => "failed",
});
unknown_on_new_values!(DisplayMode { Standard => "standard", Lite => "lite" });
unknown_on_new_values!(ShutdownReason { Stop => "stop", KioskDisabled => "kioskDisabled" });
#[cfg(test)]
mod tests {
    use super::*;
    use rulebox_policy::EXAMPLE_DESIRED_STATE_JSON;
    use serde_json::json;

    fn full_snapshot() -> AgentSnapshot {
        AgentSnapshot {
            agent_version: "0.0.0".into(),
            enrollment: EnrollmentStatus::Enrolled,
            device: Some(DeviceInfo { id: "dev_123".into(), name: "Front desk".into() }),
            convex_url: Some("https://happy-animal-123.convex.cloud".into()),
            connection: ConnectionStatus::Online,
            kiosk: KioskStatus {
                enabled: true,
                phase: KioskPhase::Failed,
                error_code: Some("staff_logon_failed".into()),
            },
            shell: ShellStatus { health: ShellHealth::Healthy },
            display_mode: DisplayMode::Lite,
            desired_state: Some(serde_json::from_str(EXAMPLE_DESIRED_STATE_JSON).unwrap()),
            desired_state_version: 42,
            server_time_offset_ms: Some(-1500),
            clock_suspect: true,
        }
    }

    /// Pins the wire format of the snapshot.
    #[test]
    fn snapshot_golden_json() {
        let expected = json!({
            "agentVersion": "0.0.0",
            "enrollment": "enrolled",
            "device": { "id": "dev_123", "name": "Front desk" },
            "convexUrl": "https://happy-animal-123.convex.cloud",
            "connection": "online",
            "kiosk": { "enabled": true, "phase": "failed", "errorCode": "staff_logon_failed" },
            "shell": { "health": "healthy" },
            "displayMode": "lite",
            "desiredState": {
                "kioskEnabled": true,
                "apps": ["orders-web", "zoom", "tally", "libreoffice"],
                "allowedSites": ["portal.company.com"],
                "fileHandlers": { ".docx": "libreoffice" },
                "storage": { "defaultQuotaGb": 10 },
                "branding": { "name": "Company OS", "logo": "..." },
                "version": 42
            },
            "desiredStateVersion": 42,
            "serverTimeOffsetMs": -1500,
            "clockSuspect": true
        });
        let snapshot = full_snapshot();
        assert_eq!(serde_json::to_value(&snapshot).unwrap(), expected);
        assert_eq!(serde_json::from_value::<AgentSnapshot>(expected).unwrap(), snapshot);
    }

    #[test]
    fn snapshot_with_nothing_set_serializes_nulls() {
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
        };
        let value = serde_json::to_value(&snapshot).unwrap();
        assert_eq!(value["device"], json!(null));
        assert_eq!(value["desiredState"], json!(null));
        assert_eq!(value["serverTimeOffsetMs"], json!(null));
        assert_eq!(value["kiosk"]["errorCode"], json!(null));
        assert_eq!(serde_json::from_value::<AgentSnapshot>(value).unwrap(), snapshot);
    }

    #[test]
    fn unknown_fields_are_ignored() {
        let mut value = serde_json::to_value(full_snapshot()).unwrap();
        value["addedInMinor2"] = json!({ "x": 1 });
        value["kiosk"]["alsoNew"] = json!(true);
        assert_eq!(serde_json::from_value::<AgentSnapshot>(value).unwrap(), full_snapshot());
    }

    #[test]
    fn unknown_enum_values_map_to_unknown() {
        let from = |s: &str| format!("\"{s}\"");
        assert_eq!(serde_json::from_str::<ClientRole>(&from("kiosk")).unwrap(), ClientRole::Unknown);
        assert_eq!(serde_json::from_str::<EnrollmentStatus>(&from("pending")).unwrap(), EnrollmentStatus::Unknown);
        assert_eq!(serde_json::from_str::<ConnectionStatus>(&from("roaming")).unwrap(), ConnectionStatus::Unknown);
        assert_eq!(serde_json::from_str::<KioskPhase>(&from("rolling")).unwrap(), KioskPhase::Unknown);
        assert_eq!(serde_json::from_str::<ShellHealth>(&from("sleepy")).unwrap(), ShellHealth::Unknown);
        assert_eq!(serde_json::from_str::<DisplayMode>(&from("ultra")).unwrap(), DisplayMode::Unknown);
        assert_eq!(serde_json::from_str::<ShutdownReason>(&from("crash")).unwrap(), ShutdownReason::Unknown);
        // Known values still map normally.
        assert_eq!(serde_json::from_str::<ClientRole>(&from("shell")).unwrap(), ClientRole::Shell);
        assert_eq!(serde_json::from_str::<EnrollmentStatus>(&from("notEnrolled")).unwrap(), EnrollmentStatus::NotEnrolled);
    }

    #[test]
    fn every_enum_value_round_trips() {
        fn check<T: Serialize + serde::de::DeserializeOwned + PartialEq + std::fmt::Debug>(all: &[T]) {
            for v in all {
                let text = serde_json::to_string(v).unwrap();
                assert_eq!(&serde_json::from_str::<T>(&text).unwrap(), v, "{text}");
            }
        }
        use {ConnectionStatus as C, DisplayMode as D, EnrollmentStatus as E, KioskPhase as K, ShellHealth as H};
        check(&[ClientRole::Shell, ClientRole::Unknown]);
        check(&[E::NotEnrolled, E::Enrolled, E::Revoked, E::Unknown]);
        check(&[C::Offline, C::Connecting, C::Online, C::Unknown]);
        check(&[K::NotApplied, K::Applying, K::Applied, K::Failed, K::Unknown]);
        check(&[H::NotRunning, H::Starting, H::Healthy, H::Unhealthy, H::Failed, H::Unknown]);
        check(&[D::Standard, D::Lite, D::Unknown]);
        check(&[ShutdownReason::Stop, ShutdownReason::KioskDisabled, ShutdownReason::Unknown]);
    }
    #[test]
    fn hello_and_shutdown_wire_format() {
        let params = HelloParams {
            protocol: ProtocolVersion { major: 1, minor: 0 },
            client: ClientInfo { role: ClientRole::Shell, name: "rulebox-staff".into(), version: "0.0.0".into() },
        };
        assert_eq!(
            serde_json::to_value(&params).unwrap(),
            json!({ "protocol": { "major": 1, "minor": 0 },
                    "client": { "role": "shell", "name": "rulebox-staff", "version": "0.0.0" } })
        );
        let event = ShuttingDownData { reason: ShutdownReason::KioskDisabled, grace_ms: 5000 };
        assert_eq!(
            serde_json::to_value(&event).unwrap(),
            json!({ "reason": "kioskDisabled", "graceMs": 5000 })
        );
    }
}
