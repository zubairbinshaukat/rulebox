//! The `Platform` seam (plan Section 5.3): all OS access goes through this trait
//! so the agent logic is testable without Win32. `SimPlatform` keeps everything
//! in memory; `WindowsPlatform` (Step 10) forwards to `rulebox-win32`.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

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

/// (Phase 4 Step 14) One installer run. `program` must be
/// `%SystemRoot%\System32\msiexec.exe` or a file inside `<data>\downloads\`
/// (`installs::installer_program_allowed`); anything else is refused before it
/// starts. `args` are passed one by one with the Windows quoting rules of
/// `std::process::Command` (no shell is involved, so a quote or `&` in an argument
/// is never a second command).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstallerCommand {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub working_dir: PathBuf,
    /// The program an install creates or a removal deletes. `WindowsPlatform`
    /// ignores it (the engine checks the disk afterwards); `SimPlatform` uses it to
    /// play the effect on its fake file set.
    pub expected_exe: Option<PathBuf>,
    /// True for a removal (`msiexec /x`).
    pub removal: bool,
}

/// How an installer ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstallerExit {
    Code(i32),
    /// Still running at the timeout: it was killed (with everything it started).
    TimedOut,
    /// (Review fix) The agent is stopping: the installer and everything it started
    /// were ended. Not a failed attempt.
    Cancelled,
}

/// (Phase 4 Step 14 review) Which boot this is, read without trusting the wall
/// clock: `boot_id` is Windows' boot counter when it can be read, `uptime_ms` the
/// tick count since the boot. `boot_time_ms` (wall clock minus uptime) is only for
/// records written before this existed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BootIdentity {
    pub boot_id: Option<u32>,
    pub uptime_ms: u64,
    pub boot_time_ms: u64,
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
    /// (Phase 4 Step 14 review) A file to replace or delete is in use (a portable
    /// app's program is running): retried like a busy installer.
    #[error("the file is in use")]
    InUse,
    /// (Phase 4 Step 16) A safety rule refused the call before anything changed (a
    /// template that breaks the rules, a link on the way). A fixed text: never a path.
    #[error("refused: {0}")]
    Refused(&'static str),
    #[error("{0}")]
    Other(String),
}

/// (Phase 4 Step 16) What [`Platform::reset_folder`] did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResetOutcome {
    /// The folder (and everything in it) is gone.
    Removed,
    /// There was nothing to remove (the folder, or a folder above it, is missing).
    Absent,
    /// A file in it is open (sharing violation): what could be deleted is deleted,
    /// the rest stays for the retry.
    InUse,
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
    /// Ids of the processes of `image_path` in `session_id` (the watchdog, Step 13).
    fn find_processes(&self, session_id: u32, image_path: &Path) -> Result<Vec<u32>, PlatformError>;
    /// Launcher and `current.json` target exist.
    fn shell_binaries_ok(&self) -> Result<ShellBinaries, PlatformError>;
    /// (Phase 4 Step 13) Whether `path` is an existing file. Read-only: a desktop
    /// app is "installed" when its exe exists until Step 14's install records.
    fn file_exists(&self, path: &Path) -> bool;
    /// (Phase 4 Step 13) The roots a catalogue path template expands to.
    fn path_roots(&self) -> Result<rulebox_policy::paths::PathRoots, PlatformError>;
    /// (Phase 4 Step 14) Free bytes on the system drive (the install disk check).
    fn disk_free_bytes(&self) -> Result<u64, PlatformError>;
    /// (Step 14) Which boot this is (clears `restartPending` once it changed).
    fn boot_identity(&self) -> Result<BootIdentity, PlatformError>;

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
    /// Ends `pid` only if its image and its owner are the expected ones.
    fn terminate_process(&self, pid: u32, expected_image: &Path, expected_sid: &str) -> Result<(), PlatformError>;
    /// Already unprotected.
    fn secrets_load(&self) -> Result<Option<Vec<u8>>, PlatformError>;
    fn secrets_save(&self, plaintext: &[u8]) -> Result<(), PlatformError>;
    /// (Phase 4 Step 14) Runs one installer as SYSTEM, without a window, in a
    /// kill-on-close job with its own fresh TEMP folder, and waits for it and
    /// everything it starts at most `timeout` (then ends them all: `TimedOut`).
    /// `cancel` (the agent is stopping) ends them all too (`Cancelled`). Returns only
    /// once nothing of the run is left. Blocking: call it from `spawn_blocking`.
    /// The program rule is checked before the guard.
    fn run_installer(
        &self,
        cmd: &InstallerCommand,
        timeout: Duration,
        cancel: &CancellationToken,
    ) -> Result<InstallerExit, PlatformError>;
    /// (Step 14) Copies a verified portable exe to `to`, which must be below
    /// `<install>\apps\`; creates the parent folders; refuses reparse points.
    /// `InUse` when the old program is running.
    fn place_portable(&self, from: &Path, to: &Path) -> Result<(), PlatformError>;
    /// (Step 14) Deletes a portable app's folder, only below `<install>\apps\`;
    /// refuses reparse points. A folder that is not there is fine. `InUse` when the
    /// program is running.
    fn remove_portable(&self, app_dir: &Path) -> Result<(), PlatformError>;
    /// (Phase 4 Step 16, PRD 5.3) Deletes one session-cleanup folder of the Staff
    /// profile. `template` is `{LocalAppData}\<rel>` or `{RoamingAppData}\<rel>`; it
    /// is checked again here (`cleanup::resolve_reset`) and resolved below
    /// `<profile_dir>\AppData\Local` or `\Roaming`, never anywhere else. Every
    /// existing folder from the profile down to the target is checked: a reparse
    /// point (link, junction) anywhere on the way is `Refused` and nothing is
    /// deleted. Links inside the folder are removed themselves, never followed.
    /// Blocking: call it from `spawn_blocking`.
    fn reset_folder(&self, profile_dir: &Path, template: &str) -> Result<ResetOutcome, PlatformError>;
}
