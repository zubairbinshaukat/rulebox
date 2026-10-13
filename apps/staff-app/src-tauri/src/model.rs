//! Types shared with React (ts-rs → `@rulebox/types`). Wire IPC types stay in
//! `rulebox_ipc`; this module is the Staff App DTO surface.
//!
//! **AppKind serde:** internally tagged with `tag = "type"` (camelCase).
//! Examples: `{ "type": "builtin", "tool": "files" }`,
//! `{ "type": "web", "url": "…", "allowedDomains": […], "permissions": {…} }`,
//! `{ "type": "desktop" }` — `DesktopApp` exe/args/`fileArgTemplate` use
//! `#[serde(skip)]` so they never reach React.
//!
//! **SessionState serde:** internally tagged with `tag = "status"`.

use std::fmt;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ShellState {
    pub mode: ShellModeDto,
    pub link: AgentLinkDto,
    pub agent: Option<AgentSummary>,
    pub display: DisplayPrefs,
    pub session: SessionState,
    pub apps: CatalogState,
    pub tasks: Vec<TaskItem>,
    pub system: SystemState,
    pub notices: Vec<NoticeItem>,
    pub banner: Option<BannerDto>,
    pub capabilities: Vec<String>,
}

impl ShellState {
    pub fn initial(mode: ShellModeDto) -> Self {
        Self {
            mode,
            link: AgentLinkDto::Disconnected,
            agent: None,
            display: DisplayPrefs::default(),
            session: SessionState::SignedOut { last: None },
            apps: CatalogState {
                status: CatalogStatus::Idle,
                items: Vec::new(),
            },
            tasks: Vec::new(),
            system: SystemState::default(),
            notices: Vec::new(),
            banner: None,
            capabilities: Vec::new(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ShellModeDto {
    Shell,
    Dev,
}

/// Link state shown in React (same variants as the agent port's `AgentLink`).
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum AgentLinkDto {
    Disconnected,
    Connecting,
    Linked,
    VersionMismatch,
}

pub type AgentLink = AgentLinkDto;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AgentSummary {
    pub enrollment: EnrollmentDto,
    pub connection: ConnectionDto,
    pub kiosk_phase: KioskPhaseDto,
    pub clock_suspect: bool,
    pub org_name: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum EnrollmentDto {
    NotEnrolled,
    Enrolled,
    Revoked,
    Unknown,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ConnectionDto {
    Offline,
    Connecting,
    Online,
    Unknown,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum KioskPhaseDto {
    NotApplied,
    Applying,
    Applied,
    Failed,
    Unknown,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DisplayPrefs {
    pub lite: bool,
    pub theme: ThemeDto,
    /// Filled from the media query in React; Rust keeps the last known value.
    pub reduced_motion: bool,
}

impl Default for DisplayPrefs {
    fn default() -> Self {
        Self {
            lite: false,
            theme: ThemeDto::Auto,
            reduced_motion: false,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ThemeDto {
    Light,
    Dark,
    Auto,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, TS)]
#[serde(tag = "status", rename_all = "camelCase")]
#[ts(export)]
pub enum SessionState {
    SignedOut { last: Option<EmployeeBrief> },
    SigningIn,
    SignedIn {
        employee: Employee,
        locked: bool,
        offline: bool,
    },
    SigningOut,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Employee {
    pub id: String,
    pub username: String,
    pub name: String,
    pub role: Option<String>,
    #[ts(type = "number")]
    pub quota_bytes: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct EmployeeBrief {
    pub username: String,
    pub name: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CatalogState {
    pub status: CatalogStatus,
    pub items: Vec<AppEntry>,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum CatalogStatus {
    Idle,
    Loading,
    Ready,
    Error,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AppEntry {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub kind: AppKind,
    pub icon_key: Option<String>,
    pub hue: Option<u16>,
    pub pinned_taskbar: bool,
    pub pinned_desktop: bool,
    pub badge: Option<u32>,
}

/// Internally tagged (`type`) for React. See module docs.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(export)]
pub enum AppKind {
    Builtin { tool: BuiltinTool },
    Web(WebApp),
    Desktop(DesktopApp),
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum BuiltinTool {
    Files,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct WebApp {
    pub url: String,
    pub allowed_domains: Vec<String>,
    pub permissions: WebPermissions,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct WebPermissions {
    pub camera: bool,
    pub microphone: bool,
    pub screen_share: bool,
    pub clipboard_read: bool,
    pub notifications: bool,
    pub downloads: bool,
    pub printing: bool,
    pub geolocation: bool,
}

impl Default for WebPermissions {
    fn default() -> Self {
        Self {
            camera: false,
            microphone: false,
            screen_share: false,
            clipboard_read: false,
            notifications: true,
            downloads: true,
            printing: false,
            geolocation: false,
        }
    }
}

/// Launch details for desktop apps. Never serialized to React.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DesktopApp {
    #[serde(skip)]
    pub exe: String,
    #[serde(skip)]
    pub args: Vec<String>,
    #[serde(skip)]
    pub file_arg_template: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TaskItem {
    /// HWND as a decimal string.
    pub id: String,
    pub app_id: Option<String>,
    pub title: String,
    pub icon_key: String,
    pub active: bool,
    pub minimized: bool,
    pub flashing: bool,
    pub hung: bool,
    pub own: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SystemState {
    pub volume: Option<VolumeDto>,
    pub battery: Option<BatteryDto>,
    pub network: NetworkDto,
    pub can_power_off: bool,
}

impl Default for SystemState {
    fn default() -> Self {
        Self {
            volume: None,
            battery: None,
            network: NetworkDto::None,
            can_power_off: false,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct VolumeDto {
    pub level: f32,
    pub muted: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BatteryDto {
    /// 0–100 when known.
    pub percent: Option<u8>,
    pub charging: bool,
    /// Estimated minutes remaining, when known.
    pub minutes_left: Option<u32>,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum NetworkDto {
    None,
    Local,
    Internet,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct NoticeItem {
    pub id: u32,
    pub tone: NoticeTone,
    pub title: String,
    pub detail: Option<String>,
    #[ts(type = "number")]
    pub at_ms: u64,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum NoticeTone {
    Neutral,
    Accent,
    Success,
    Warning,
    Danger,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BannerDto {
    pub reason: BannerReason,
    #[ts(type = "number")]
    pub grace_ms: u64,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum BannerReason {
    Stop,
    KioskDisabled,
    AdminExit,
    Unknown,
}

/// Parameters of `AgentPort::sign_in`. Password is redacted in `Debug`.
#[allow(dead_code)] // AgentPort surface; sign-in command is Step 5.
#[derive(Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SignInRequest {
    pub username: String,
    pub password: String,
}

impl fmt::Debug for SignInRequest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SignInRequest")
            .field("username", &self.username)
            .field("password", &"<redacted>")
            .finish()
    }
}

/// Staff-side sign-in outcome (tagged). Mapped from flat `rulebox_ipc` results.
#[allow(dead_code)] // AgentPort surface; sign-in command is Step 5.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SignInOutcome {
    Ok {
        employee: Employee,
        files_root: String,
        offline: bool,
    },
    WrongCredentials,
    Disabled,
    LockedOut {
        retry_after_ms: u64,
    },
    OfflineNeverSignedIn,
    OfflineExpired,
    /// Flat wire sent an unknown outcome string.
    Unknown,
}

#[allow(dead_code)] // AgentPort surface; unlock is a later step.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum VerifyOutcome {
    Ok,
    WrongCredentials,
    LockedOut { retry_after_ms: u64 },
    Unknown,
}

#[allow(dead_code)] // AgentPort surface; admin exit is a later step.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AdminExitOutcome {
    SigningOut,
    WrongPin { attempts_left: Option<u32> },
    LockedOut { retry_after_ms: u64 },
    Disabled,
    Unknown,
}

/// Map a protocol-1.1 wire `AppEntry` onto the Staff DTO (adds `iconKey`/`badge`,
/// folds kind + payload into an internally tagged `AppKind`).
#[allow(dead_code)] // Called from `IpcAgent::apps` (port method unused until Step 5+).
pub fn map_wire_app(wire: rulebox_ipc::requests::AppEntry) -> Option<AppEntry> {
    use rulebox_ipc::requests::AppKind as WireKind;

    let kind = match wire.kind {
        WireKind::Builtin => {
            let tool = wire.builtin?.tool;
            let tool = match tool.as_str() {
                "files" => BuiltinTool::Files,
                _ => return None,
            };
            AppKind::Builtin { tool }
        }
        WireKind::Web => {
            let web = wire.web?;
            AppKind::Web(WebApp {
                url: web.url,
                allowed_domains: web.allowed_domains,
                permissions: WebPermissions {
                    camera: web.permissions.camera,
                    microphone: web.permissions.microphone,
                    screen_share: web.permissions.screen_share,
                    clipboard_read: web.permissions.clipboard_read,
                    notifications: web.permissions.notifications,
                    downloads: web.permissions.downloads,
                    printing: web.permissions.printing,
                    geolocation: web.permissions.geolocation,
                },
            })
        }
        WireKind::Desktop => {
            let desktop = wire.desktop?;
            AppKind::Desktop(DesktopApp {
                exe: desktop.exe,
                args: desktop.args,
                file_arg_template: desktop.file_arg_template,
            })
        }
        WireKind::Unknown => return None,
    };

    Some(AppEntry {
        id: wire.id,
        name: wire.name,
        description: wire.description,
        kind,
        icon_key: None,
        hue: wire.hue,
        pinned_taskbar: wire.pinned_taskbar,
        pinned_desktop: wire.pinned_desktop,
        badge: None,
    })
}

#[allow(dead_code)] // Called from flat→tagged IPC mappers (port unused until Step 5+).
pub fn map_wire_employee(wire: rulebox_ipc::requests::Employee) -> Employee {
    Employee {
        id: wire.id,
        username: wire.username,
        name: wire.name,
        role: wire.role,
        quota_bytes: wire.quota_bytes,
    }
}

#[allow(dead_code)] // Called from `IpcAgent::sign_in` (port unused until Step 5).
pub fn map_sign_in_result(wire: rulebox_ipc::requests::SignInResult) -> SignInOutcome {
    use rulebox_ipc::requests::SignInOutcome as Wire;

    match wire.outcome {
        Wire::Ok => match (wire.employee, wire.files_root) {
            (Some(employee), Some(files_root)) => SignInOutcome::Ok {
                employee: map_wire_employee(employee),
                files_root,
                offline: wire.offline,
            },
            _ => SignInOutcome::Unknown,
        },
        Wire::WrongCredentials => SignInOutcome::WrongCredentials,
        Wire::Disabled => SignInOutcome::Disabled,
        Wire::LockedOut => SignInOutcome::LockedOut {
            retry_after_ms: wire.retry_after_ms.unwrap_or(30_000),
        },
        Wire::OfflineNeverSignedIn => SignInOutcome::OfflineNeverSignedIn,
        Wire::OfflineExpired => SignInOutcome::OfflineExpired,
        Wire::Unknown => SignInOutcome::Unknown,
    }
}

#[allow(dead_code)] // Called from `IpcAgent::verify_password` (later step).
pub fn map_verify_result(wire: rulebox_ipc::requests::VerifyPasswordResult) -> VerifyOutcome {
    use rulebox_ipc::requests::VerifyOutcome as Wire;

    match wire.outcome {
        Wire::Ok => VerifyOutcome::Ok,
        Wire::WrongCredentials => VerifyOutcome::WrongCredentials,
        Wire::LockedOut => VerifyOutcome::LockedOut {
            retry_after_ms: wire.retry_after_ms.unwrap_or(30_000),
        },
        Wire::Unknown => VerifyOutcome::Unknown,
    }
}

#[allow(dead_code)] // Called from `IpcAgent::admin_exit` (later step).
pub fn map_admin_exit_result(
    wire: rulebox_ipc::requests::AdminExitSubmitResult,
) -> AdminExitOutcome {
    use rulebox_ipc::requests::AdminExitOutcome as Wire;

    match wire.outcome {
        Wire::SigningOut => AdminExitOutcome::SigningOut,
        Wire::WrongPin => AdminExitOutcome::WrongPin {
            attempts_left: wire.attempts_left,
        },
        Wire::LockedOut => AdminExitOutcome::LockedOut {
            retry_after_ms: wire.retry_after_ms.unwrap_or(60_000),
        },
        Wire::Disabled => AdminExitOutcome::Disabled,
        Wire::Unknown => AdminExitOutcome::Unknown,
    }
}

pub fn agent_summary_from_snapshot(snap: &rulebox_ipc::types::AgentSnapshot) -> AgentSummary {
    use rulebox_ipc::types::{ConnectionStatus, EnrollmentStatus, KioskPhase};

    AgentSummary {
        enrollment: match snap.enrollment {
            EnrollmentStatus::NotEnrolled => EnrollmentDto::NotEnrolled,
            EnrollmentStatus::Enrolled => EnrollmentDto::Enrolled,
            EnrollmentStatus::Revoked => EnrollmentDto::Revoked,
            EnrollmentStatus::Unknown => EnrollmentDto::Unknown,
        },
        connection: match snap.connection {
            ConnectionStatus::Offline => ConnectionDto::Offline,
            ConnectionStatus::Connecting => ConnectionDto::Connecting,
            ConnectionStatus::Online => ConnectionDto::Online,
            ConnectionStatus::Unknown => ConnectionDto::Unknown,
        },
        kiosk_phase: match snap.kiosk.phase {
            KioskPhase::NotApplied => KioskPhaseDto::NotApplied,
            KioskPhase::Applying => KioskPhaseDto::Applying,
            KioskPhase::Applied => KioskPhaseDto::Applied,
            KioskPhase::Failed => KioskPhaseDto::Failed,
            KioskPhase::Unknown => KioskPhaseDto::Unknown,
        },
        clock_suspect: snap.clock_suspect,
        org_name: snap.org_name.clone().or_else(|| {
            snap.desired_state
                .as_ref()
                .map(|d| d.branding.name.clone())
        }),
    }
}
