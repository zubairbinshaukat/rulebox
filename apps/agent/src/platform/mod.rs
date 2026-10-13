//! The `Platform` seam (plan Section 5.3): all OS access goes through this trait
//! so the agent logic is testable without Win32. `SimPlatform` keeps everything
//! in memory; `WindowsPlatform` (Step 10) forwards to `rulebox-win32`.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub mod sim;
pub mod windows;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OsInfo {
    pub build: u32,
    pub ubr: u32,
    pub display_version: String,
    pub edition_id: String,
    pub product_type: u32,
    pub arch: String,
    pub s_mode: bool,
    pub domain_joined: bool,
    pub entra_joined: bool,
    pub ram_mb: u64,
    pub system_disk_free_gb: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionInfo {
    pub id: u32,
    pub state: SessionState,
    pub user_sid: Option<String>,
    pub is_console: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionState {
    Active,
    Connected,
    Disconnected,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalUser {
    pub sid: String,
    pub comment: String,
    pub disabled: bool,
}

/// What the Staff account is created with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StaffUserSpec {
    pub user_name: String,
    pub full_name: String,
    pub comment: String,
}

/// Whether the launcher and the Staff App it points to exist.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ShellBinaries {
    pub launcher_ok: bool,
    pub staff_app_ok: bool,
}

/// Where the Staff account's shell value is written. `agent-config.json` key
/// `shellMechanism`: `"policyShell"` (default) or `"winlogonShell"`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ShellMechanism {
    #[default]
    PolicyShell,
    WinlogonShell,
}

impl ShellMechanism {
    /// The other mechanism: its location is cleared when this one is written.
    pub fn other(self) -> Self {
        match self {
            ShellMechanism::PolicyShell => ShellMechanism::WinlogonShell,
            ShellMechanism::WinlogonShell => ShellMechanism::PolicyShell,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            ShellMechanism::PolicyShell => "policyShell",
            ShellMechanism::WinlogonShell => "winlogonShell",
        }
    }
}

/// A value under HKLM.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct RegValueRef {
    pub path: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RegData {
    Dword(u32),
    String(String),
}

#[derive(thiserror::Error, Debug)]
pub enum PlatformError {
    #[error("blocked by the test-machine guard: {0}")]
    Guard(String),
    #[error("already exists")]
    AlreadyExists,
    #[error("not found")]
    NotFound,
    #[error("access denied")]
    AccessDenied,
    #[error("password rejected by local policy")]
    PasswordPolicy,
    #[error("win32 error {code} in {api}")]
    Win32 { api: &'static str, code: u32 },
    #[error("{0}")]
    Other(String),
}

pub trait Platform: Send + Sync + 'static {
    // read-only
    fn os_info(&self) -> Result<OsInfo, PlatformError>;
    fn computer_name(&self) -> Result<String, PlatformError>;
    fn other_enabled_local_admins(&self, exclude_sid: Option<&str>) -> Result<Vec<String>, PlatformError>;
    fn legal_notice_present(&self) -> Result<bool, PlatformError>;
    fn find_local_user(&self, user_name: &str) -> Result<Option<LocalUser>, PlatformError>;
    fn read_machine_value(&self, key: &RegValueRef) -> Result<Option<RegData>, PlatformError>;
    fn sessions(&self) -> Result<Vec<SessionInfo>, PlatformError>;
    fn find_processes(&self, session_id: u32, image_path: &Path) -> Result<Vec<u32>, PlatformError>;
    /// Launcher and `current.json` target exist.
    fn shell_binaries_ok(&self) -> Result<ShellBinaries, PlatformError>;

    // mutating: every `WindowsPlatform` implementation calls `guard::require_test_machine()` first
    fn create_staff_user(&self, spec: &StaffUserSpec, password: &str) -> Result<String, PlatformError>;
    fn set_user_password(&self, user_name: &str, password: &str) -> Result<(), PlatformError>;
    fn test_logon(&self, user_name: &str, password: &str) -> Result<bool, PlatformError>;
    fn ensure_profile(&self, sid: &str, user_name: &str) -> Result<PathBuf, PlatformError>;
    fn delete_staff_user(&self, sid: &str, user_name: &str) -> Result<(), PlatformError>;
    /// `None` deletes the value.
    fn write_machine_value(&self, key: &RegValueRef, data: Option<&RegData>) -> Result<(), PlatformError>;
    fn lsa_secret_get(&self, name: &str) -> Result<Option<String>, PlatformError>;
    fn lsa_secret_set(&self, name: &str, value: Option<&str>) -> Result<(), PlatformError>;
    fn set_staff_shell(
        &self,
        sid: &str,
        mechanism: ShellMechanism,
        command: Option<&str>,
    ) -> Result<(), PlatformError>;
    fn set_staff_user_policy(&self, sid: &str, name: &str, value: Option<u32>) -> Result<(), PlatformError>;
    fn logoff_session(&self, session_id: u32) -> Result<(), PlatformError>;
    /// Returns the new process id.
    fn launch_in_session(&self, session_id: u32, expected_sid: &str, exe: &Path) -> Result<u32, PlatformError>;
    fn terminate_process(&self, pid: u32, expected_image: &Path, expected_sid: &str) -> Result<(), PlatformError>;
    /// Already unprotected.
    fn secrets_load(&self) -> Result<Option<Vec<u8>>, PlatformError>;
    fn secrets_save(&self, plaintext: &[u8]) -> Result<(), PlatformError>;
}
