//! Types that cross the shell pipe (plan Section 6.6). TypeScript is generated
//! with ts-rs into `packages/types/src/generated/` (run `pnpm gen:types`).
//!
//! Every enum has an `Unknown` variant, filled by the `unknown_on_new_values!`
//! macro (see `lib.rs`), so a newer agent can add values without breaking an
//! older client (plan Section 6.5).

use rulebox_policy::lockdown::WinCombos;
use rulebox_policy::notice::BroadcastStyle;
use rulebox_policy::DesiredState;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// RAM at or below this many MB selects Lite mode (PRD 22.5). The one definition:
/// the agent's display-mode choice and its compatibility report both import it
/// (Phase 6 Step 3).
pub const LITE_MAX_RAM_MB: u64 = 4352;

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
    /// (1.1) `rulebox-shell.exe`, the launcher.
    Launcher,
    /// (1.1) The agent CLI on the admin pipe.
    Admin,
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
    /// (1.1) The hidden admin exit. A 1.1 agent always sends it; null (or
    /// missing) from a 1.0 agent.
    #[serde(default)]
    pub admin_exit: Option<AdminExitInfo>,
    /// (1.1) Power buttons the employee may use. Null means all three.
    #[serde(default)]
    pub power: Option<PowerOptions>,
    /// (1.1) Organization name. Null means use `desiredState.branding.name`.
    #[serde(default)]
    pub org_name: Option<String>,
    /// (1.3) Set while the device is locked by the administrator (plan Phase 5, 4.12 and
    /// 4.17). A 1.2 agent never sends it; a reader treats missing and `null` alike.
    #[serde(default)]
    pub device_lock: Option<DeviceLockView>,
    /// (1.3) Active broadcasts, newest first, at most 5. The agent drops expired ones.
    #[serde(default)]
    pub broadcasts: Vec<BroadcastView>,
    /// (1.3) Keyboard policy. `None` from a 1.2 agent: Windows-key combinations pass.
    #[serde(default)]
    pub keyboard: Option<KeyboardView>,
    /// (1.3) Whether the PC has printers the organization set up. `None` from a 1.2
    /// agent: a web app's own `printing` permission alone decides.
    #[serde(default)]
    pub printing: Option<PrintingView>,
    /// (1.3) Status of the managed Wi-Fi (Phase 3 P11: status only).
    #[serde(default)]
    pub network: Option<NetworkView>,
}

/// (1.3) What the lock view shows. Nothing secret, never an employee.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DeviceLockView {
    pub lock_id: String,
    pub message: String,
    #[serde(default)]
    pub contact: Option<String>,
}

/// (1.3) One announcement for the Staff session. `title` and `body` are plain text:
/// a client must never render them as HTML.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BroadcastView {
    pub id: String,
    pub style: BroadcastStyle,
    pub title: String,
    pub body: String,
    pub ack_required: bool,
    /// True once this PC has queued an acknowledgement for it.
    pub acknowledged: bool,
}

/// (1.3) `keyboard` of the snapshot. `Unknown` (a value a newer agent adds) is
/// treated like `swallow` by the Staff App: the stricter reading.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct KeyboardView {
    pub win_combos: WinCombos,
}

/// (1.3) `printers` is non-empty (and the Spooler runs).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PrintingView {
    pub available: bool,
}

/// (1.3) Managed Wi-Fi status.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct NetworkView {
    pub managed_only: bool,
    pub ssids: Vec<String>,
}

/// (1.1) Whether the hidden admin exit is available and its key combination.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AdminExitInfo {
    /// True only when the exit is not disabled by the organization and a valid
    /// PIN is set.
    pub enabled: bool,
    /// Canonical key-combination text (see `hotkey`), for example `Ctrl+Shift+F12`.
    pub hotkey: String,
}

/// (1.1) Which power actions the employee is offered.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PowerOptions {
    pub sleep: bool,
    pub restart: bool,
    pub shut_down: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ShutdownReason {
    Stop,
    KioskDisabled,
    /// (1.1) A correct admin-exit PIN; the Staff session is signed out after the grace.
    AdminExit,
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

unknown_on_new_values!(ClientRole {
    Shell => "shell",
    Launcher => "launcher",
    Admin => "admin",
});
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
unknown_on_new_values!(ShutdownReason {
    Stop => "stop",
    KioskDisabled => "kioskDisabled",
    AdminExit => "adminExit",
});

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
            admin_exit: Some(AdminExitInfo { enabled: true, hotkey: "Ctrl+Shift+F12".into() }),
            power: Some(PowerOptions { sleep: true, restart: false, shut_down: true }),
            org_name: Some("Demo Company".into()),
            device_lock: Some(DeviceLockView {
                lock_id: "lock_1".into(),
                message: "Call IT".into(),
                contact: Some("it@example.test".into()),
            }),
            broadcasts: vec![BroadcastView {
                id: "bc_1".into(),
                style: BroadcastStyle::Fullscreen,
                title: "Maintenance".into(),
                body: "Back at <b>noon</b> & later.".into(),
                ack_required: true,
                acknowledged: false,
            }],
            keyboard: Some(KeyboardView { win_combos: WinCombos::Swallow }),
            printing: Some(PrintingView { available: true }),
            network: Some(NetworkView { managed_only: true, ssids: vec!["Shop".into()] }),
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
                "fileHandlers": { ".docx": "libreoffice", ".txt": "notepad", ".csv": "notepad" },
                "storage": { "defaultQuotaGb": 10 },
                "branding": { "name": "Company OS", "logo": "..." },
                "version": 42
            },
            "desiredStateVersion": 42,
            "serverTimeOffsetMs": -1500,
            "clockSuspect": true,
            "adminExit": { "enabled": true, "hotkey": "Ctrl+Shift+F12" },
            "power": { "sleep": true, "restart": false, "shutDown": true },
            "orgName": "Demo Company",
            "deviceLock": { "lockId": "lock_1", "message": "Call IT", "contact": "it@example.test" },
            "broadcasts": [{ "id": "bc_1", "style": "fullscreen", "title": "Maintenance",
                             "body": "Back at <b>noon</b> & later.", "ackRequired": true,
                             "acknowledged": false }],
            "keyboard": { "winCombos": "swallow" },
            "printing": { "available": true },
            "network": { "managedOnly": true, "ssids": ["Shop"] }
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
            admin_exit: None,
            power: None,
            org_name: None,
            device_lock: None,
            broadcasts: Vec::new(),
            keyboard: None,
            printing: None,
            network: None,
        };
        let value = serde_json::to_value(&snapshot).unwrap();
        assert_eq!(value["device"], json!(null));
        assert_eq!(value["desiredState"], json!(null));
        assert_eq!(value["serverTimeOffsetMs"], json!(null));
        assert_eq!(value["kiosk"]["errorCode"], json!(null));
        // The 1.1 fields are present and null, never omitted.
        assert_eq!(value["adminExit"], json!(null));
        assert_eq!(value["power"], json!(null));
        assert_eq!(value["orgName"], json!(null));
        // The 1.3 fields are present too: null, or an empty list.
        assert_eq!(value["deviceLock"], json!(null));
        assert_eq!(value["broadcasts"], json!([]));
        assert_eq!(value["keyboard"], json!(null));
        assert_eq!(value["printing"], json!(null));
        assert_eq!(value["network"], json!(null));
        assert_eq!(serde_json::from_value::<AgentSnapshot>(value).unwrap(), snapshot);
    }

    /// A 1.2 agent does not send the five 1.3 keys; a 1.3 client reads "nothing".
    #[test]
    fn snapshot_from_a_1_2_agent_parses() {
        let mut value = serde_json::to_value(full_snapshot()).unwrap();
        let object = value.as_object_mut().unwrap();
        for key in ["deviceLock", "broadcasts", "keyboard", "printing", "network"] {
            assert!(object.remove(key).is_some());
        }
        let parsed = serde_json::from_value::<AgentSnapshot>(value).unwrap();
        assert_eq!(parsed.device_lock, None);
        assert!(parsed.broadcasts.is_empty());
        assert_eq!((parsed.keyboard, parsed.printing, parsed.network), (None, None, None));
        assert_eq!(parsed.org_name.as_deref(), Some("Demo Company"));
    }

    #[test]
    fn new_1_3_enum_values_from_a_later_agent_are_unknown() {
        let view: BroadcastView = serde_json::from_value(json!({
            "id": "b", "style": "hologram", "title": "t", "body": "b", "ackRequired": false, "acknowledged": true
        }))
        .unwrap();
        assert_eq!(view.style, BroadcastStyle::Unknown);
        let keyboard: KeyboardView = serde_json::from_value(json!({ "winCombos": "explode" })).unwrap();
        assert_eq!(keyboard.win_combos, WinCombos::Unknown);
    }

    /// A 1.0 agent does not send the three 1.1 keys; a 1.1 client reads `None`.
    #[test]
    fn snapshot_from_a_1_0_agent_parses() {
        let mut value = serde_json::to_value(full_snapshot()).unwrap();
        let object = value.as_object_mut().unwrap();
        for key in ["adminExit", "power", "orgName"] {
            assert!(object.remove(key).is_some());
        }
        let parsed = serde_json::from_value::<AgentSnapshot>(value).unwrap();
        assert_eq!(parsed.admin_exit, None);
        assert_eq!(parsed.power, None);
        assert_eq!(parsed.org_name, None);
        assert_eq!(parsed.desired_state_version, 42);
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
        assert_eq!(serde_json::from_str::<ClientRole>(&from("launcher")).unwrap(), ClientRole::Launcher);
        assert_eq!(serde_json::from_str::<ClientRole>(&from("admin")).unwrap(), ClientRole::Admin);
        assert_eq!(serde_json::from_str::<ShutdownReason>(&from("adminExit")).unwrap(), ShutdownReason::AdminExit);
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
        check(&[ClientRole::Shell, ClientRole::Launcher, ClientRole::Admin, ClientRole::Unknown]);
        check(&[E::NotEnrolled, E::Enrolled, E::Revoked, E::Unknown]);
        check(&[C::Offline, C::Connecting, C::Online, C::Unknown]);
        check(&[K::NotApplied, K::Applying, K::Applied, K::Failed, K::Unknown]);
        check(&[H::NotRunning, H::Starting, H::Healthy, H::Unhealthy, H::Failed, H::Unknown]);
        check(&[D::Standard, D::Lite, D::Unknown]);
        check(&[
            ShutdownReason::Stop,
            ShutdownReason::KioskDisabled,
            ShutdownReason::AdminExit,
            ShutdownReason::Unknown,
        ]);
    }

    #[test]
    fn new_enum_values_use_the_camel_case_strings() {
        assert_eq!(serde_json::to_string(&ClientRole::Launcher).unwrap(), r#""launcher""#);
        assert_eq!(serde_json::to_string(&ClientRole::Admin).unwrap(), r#""admin""#);
        assert_eq!(serde_json::to_string(&ShutdownReason::AdminExit).unwrap(), r#""adminExit""#);
        let event = ShuttingDownData { reason: ShutdownReason::AdminExit, grace_ms: 2000 };
        assert_eq!(
            serde_json::to_value(&event).unwrap(),
            json!({ "reason": "adminExit", "graceMs": 2000 })
        );
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
