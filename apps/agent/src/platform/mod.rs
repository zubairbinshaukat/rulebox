//! The `Platform` seam (plan Section 5.3): all OS access goes through this trait
//! so the agent logic is testable without Win32. `SimPlatform` keeps everything
//! in memory; `WindowsPlatform` (Step 10) forwards to `rulebox-win32`.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

pub mod sim;
pub mod windows;

// (Phase 5 Step 3, plan 4.5) The value types of the new seam methods are the ones
// `rulebox-win32` defines, so the two sides cannot drift apart.
pub use rulebox_win32::accounts::LockoutPolicy;
pub use rulebox_win32::applocker::{AppLockerState, Mechanism as AppLockerMechanism};
pub use rulebox_win32::etw::{ProcessSink, ProcessStart, TraceHandle, TraceStats};
pub use rulebox_win32::eventlog::EventRecord;
// (Phase 6 Step 8) The kind of an entry written to the Application event log.
pub use rulebox_win32::eventwrite::Kind as EventKind;
pub use rulebox_win32::fileid::{FileIdentity, FileStamp};
pub use rulebox_win32::process::ProcessInfo;
pub use rulebox_win32::posture::SecurityPosture;
pub use rulebox_win32::printing::{PortProtocol, PortSpec, PrinterInfo, PrinterSpec};
pub use rulebox_win32::service::ServiceConfig;
pub use rulebox_win32::wlan::WlanState;

/// (Phase 5 Step 3, plan 4.5 and its guard rules) Every `Platform` method that changes
/// the machine, or is only allowed on a test machine. `WindowsPlatform` must start each
/// of them with `guard()?;` (after, at most, a pure rule check that touches nothing);
/// `apps/agent/tests/guard_coverage.rs` reads this list and `platform/windows.rs` as
/// text and fails when one is missing or unguarded. A new mutating trait method that is
/// not added here fails the same test.
// (Phase 5 Step 3) Nothing calls the new seam yet: the layers of Steps 4 to 20 do.
#[allow(dead_code)]
pub const MUTATING_METHODS: &[&str] = &[
    "create_staff_user",
    "set_user_password",
    "test_logon",
    "ensure_profile",
    "delete_staff_user",
    "write_machine_value",
    "lsa_secret_get",
    "lsa_secret_set",
    "set_staff_shell",
    "set_staff_user_policy",
    "logoff_session",
    "launch_in_session",
    "terminate_process",
    "secrets_save",
    "run_installer",
    "place_portable",
    "remove_portable",
    "reset_folder",
    // Phase 5 Step 3.
    "write_staff_value",
    "delete_staff_value",
    "deploy_ci_policy",
    "remove_ci_policy",
    "set_applocker_policy",
    "clear_applocker_policy",
    "set_service_start",
    "set_service_security",
    "set_service_required_privileges",
    "set_account_lockout",
    "wlan_set_profile",
    "wlan_delete_profile",
    "wlan_set_filters",
    "printer_add",
    "printer_delete",
    "printer_set_security",
    // Phase 5 Step 14.
    "printer_port_add",
    "printer_port_delete",
    // Phase 5 Step 14b.
    "driver_package_delete",
    "printer_share_connect",
    "printer_share_disconnect",
    "bcd_set",
    "start_process_trace",
    "stop_process_trace",
    "set_path_acl",
    // Phase 5 Step 5.
    "remove_safe_boot_entry",
    // Phase 5 Step 6.
    "refresh_ci_policies",
    // Phase 6 Step 8.
    "write_install_marker",
    "run_webview_bootstrapper",
    "report_event",
];

/// (Phase 5 Step 3, plan 4.5 rule 2) Whether `path` may get a new ACL: it is the install
/// folder or the agent's `state` folder, or below one of them (case-insensitive, whole
/// folder names, no `..`). Checked before the guard in `WindowsPlatform` and in
/// `SimPlatform`.
// (Phase 5 Step 3) Nothing calls the new seam yet: the layers of Steps 4 to 20 do.
#[allow(dead_code)]
pub fn acl_target_allowed(install_root: &Path, state_dir: &Path, path: &Path) -> bool {
    fn normal(path: &Path) -> Option<String> {
        let text = path.to_string_lossy().replace('/', "\\").to_ascii_lowercase();
        let trimmed = text.trim_end_matches('\\').to_string();
        let plain = !trimmed.is_empty() && trimmed.split('\\').all(|part| !matches!(part, "" | "." | ".."));
        // A UNC or device path starts with an empty segment and is not plain.
        (plain && trimmed.len() > 2 && trimmed.as_bytes()[1] == b':').then_some(trimmed)
    }
    let Some(target) = normal(path) else {
        return false;
    };
    [install_root, state_dir].into_iter().filter_map(normal).any(|root| {
        target == root || (target.starts_with(&root) && target.as_bytes().get(root.len()) == Some(&b'\\'))
    })
}

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

/// (Phase 5 Step 5) An enabled local account with administrator rights.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalAdminAccount {
    pub sid: String,
    /// The account name (`SpecialAccounts\UserList` is keyed by it).
    pub name: String,
}

/// (Phase 5 Step 7) One folder and its DACL, as the writable-folder scan reads them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FolderAcl {
    pub path: String,
    /// The DACL as SDDL (`D:...`).
    pub sddl: String,
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
/// (`installs::installer_command_allowed`: also `pnputil` with two fixed command lines, Step 14b); anything else is refused before it
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
    /// (Phase 6 Step 14, plan 4.6 "Timeout") Like `TimedOut` (it was killed with everything it started), but just before
    /// that the installer had used almost no CPU for the last five minutes, or showed a window on the service desktop:
    /// it was waiting for somebody to answer a question nobody can see (`needs_interaction`).
    Stalled,
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

/// (Phase 6 Step 8) One value of the install marker `HKLM\SOFTWARE\Rulebox\Install` that the
/// agent keeps (the MSI writes `InstallDir` and `Version`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InstallMarkerValue {
    /// What the production guard compares with this computer.
    ComputerName(String),
    /// What the MSI's uninstall guard reads: 1 while the kiosk is on.
    KioskOn(bool),
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

/// (Phase 6 Step 11) One wait for a process to end ([`Platform::watch_process_exit`]). `wait` blocks (call it from a
/// blocking thread) until the process ended (`true`) or `cancel` was called (`false`). No polling on the real
/// platform: it waits on the process handle.
pub trait ExitWatch: Send + Sync {
    fn wait(&self) -> bool;
    fn cancel(&self);
}

// (Phase 5 Step 3) Nothing calls the new seam yet: the layers of Steps 4 to 20 do.
#[allow(dead_code)]
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
    /// Already unprotected. (Moved up from the mutating group in Phase 5 Step 3: it only
    /// reads, and `MUTATING_METHODS` is checked against the groups.)
    fn secrets_load(&self) -> Result<Option<Vec<u8>>, PlatformError>;
    /// (Phase 4 Step 13) The roots a catalogue path template expands to.
    fn path_roots(&self) -> Result<rulebox_policy::paths::PathRoots, PlatformError>;
    /// (Phase 4 Step 14) Free bytes on the system drive (the install disk check).
    fn disk_free_bytes(&self) -> Result<u64, PlatformError>;
    /// (Step 14) Which boot this is (clears `restartPending` once it changed).
    fn boot_identity(&self) -> Result<BootIdentity, PlatformError>;
    /// (Phase 4 Step 16 review) The profile folder Windows has for `sid` now
    /// (`ProfileList\<SID>\ProfileImagePath`); `None` when it has none. Read again
    /// before every cleanup round instead of trusting the path saved at setup.
    fn staff_profile_dir(&self, sid: &str) -> Result<Option<PathBuf>, PlatformError>;
    /// (Step 16 review) Whether the Staff account's `AppData` / `Local AppData`
    /// shell folders (`HKCU\...\User Shell Folders`) point away from
    /// `<profile>\AppData\Roaming` / `\Local` (then apps keep their data where the
    /// cleanup does not look). `None` when it cannot tell: the hive is not loaded.
    /// Read-only: it never loads the hive.
    fn staff_app_data_redirected(&self, sid: &str, profile: &Path) -> Result<Option<bool>, PlatformError>;

    // read-only, Phase 5 Step 3 (plan 4.5). None of these changes a value. The journal
    // reads the original of each through them before a layer writes (plan 4.4).
    /// The names of the values directly under an HKLM key (empty when the key is absent).
    /// Lets the device-class rules pick free names in the deny list and check it (4.7a).
    fn list_machine_value_names(&self, path: &str) -> Result<Vec<String>, PlatformError>;
    /// A value in the Staff hive (`path` relative to the hive, under
    /// `staffreg::ALLOWED_ROOTS`). `Ok(None)`: absent, or the Staff account is gone. On a
    /// machine that is not a test machine a signed-out Staff hive cannot be read (mounting
    /// it is guarded) and the answer is a `Guard` error.
    fn read_staff_value(&self, sid: &str, path: &str, name: &str) -> Result<Option<RegData>, PlatformError>;
    /// (Phase 5 Step 18) The names of the values directly under a Staff hive key (`path` under
    /// `staffreg::ALLOWED_ROOTS`): the Staff start-up entries. Empty when the key is absent or
    /// the Staff account is gone. Same guard rule as `read_staff_value` for a signed-out hive.
    fn list_staff_value_names(&self, sid: &str, path: &str) -> Result<Vec<String>, PlatformError>;
    /// Ids (lowercase GUIDs) of the `.cip` files in the active App Control folder.
    fn list_ci_policies(&self) -> Result<Vec<String>, PlatformError>;
    /// (Phase 5 Step 6) The bytes of `{policy_id}.cip` in the active folder; `Ok(None)`:
    /// no such file. The journal compares them with the embedded policy.
    fn read_ci_policy(&self, policy_id: &str) -> Result<Option<Vec<u8>>, PlatformError>;
    fn get_applocker_policy(&self) -> Result<AppLockerState, PlatformError>;
    /// `Ok(None)`: no such service.
    fn query_service(&self, name: &str) -> Result<Option<ServiceConfig>, PlatformError>;
    /// The service's DACL as SDDL (the journal's `Sddl` original). `Ok(None)`: no such service.
    fn get_service_security(&self, name: &str) -> Result<Option<String>, PlatformError>;
    /// The service's required privileges (the journal's `MultiString` original).
    fn get_service_required_privileges(&self, name: &str) -> Result<Vec<String>, PlatformError>;
    fn get_account_lockout(&self) -> Result<LockoutPolicy, PlatformError>;
    fn wlan_list(&self) -> Result<WlanState, PlatformError>;
    /// (Phase 5 Step 20, invariant I5) The Wi-Fi network the PC is connected to now; `None`:
    /// wired, offline or no wireless adapter. Read-only.
    fn wlan_current_ssid(&self) -> Result<Option<String>, PlatformError>;
    /// (Phase 5 Step 20, edge case 32) The names of the Rulebox profiles (`Rulebox-<id>`) whose
    /// last connection attempt failed, as the WLAN service's notifications said (no polling, no
    /// scan). Empty until an attempt failed since the agent started. Read-only.
    fn wlan_last_connect_failures(&self) -> Result<Vec<String>, PlatformError>;
    fn printer_list(&self) -> Result<Vec<PrinterInfo>, PlatformError>;
    /// A queue's DACL as SDDL (the journal's `Sddl` original). `Ok(None)`: no such queue.
    fn printer_get_security(&self, name: &str) -> Result<Option<String>, PlatformError>;
    /// (Phase 5 Step 14) The names of the printer drivers in the driver store. Read-only: the agent never installs one.
    fn printer_drivers(&self) -> Result<Vec<String>, PlatformError>;
    /// (Phase 5 Step 14b) The `oem<N>.inf` packages in the driver store (`%SystemRoot%\INF`), lower case, sorted. Read-only:
    /// the install engine compares it before and after `pnputil /add-driver` to learn the name Windows gave a package.
    fn driver_store_infs(&self) -> Result<Vec<String>, PlatformError>;
    /// (Phase 5 Step 14b) The names of the printer ports on this machine.
    fn printer_ports(&self) -> Result<Vec<String>, PlatformError>;
    fn bcd_get(&self, object: &str, element: &str) -> Result<Option<String>, PlatformError>;
    /// Up to `max` events of an audit channel after `after_record_id`, oldest first.
    fn read_event_log(&self, channel: &str, after_record_id: u64, max: usize) -> Result<Vec<EventRecord>, PlatformError>;
    fn read_security_posture(&self) -> Result<SecurityPosture, PlatformError>;
    /// (Phase 6 Step 6, plan 4.12) The WebView2 Runtime's `pv` value as the registry holds it
    /// (`EdgeUpdate\Clients\{F3017226-...}`, per machine), `Ok(None)` when no key or no value.
    /// Not interpreted here: `compat` decides that empty or `0.0.0.0` means absent.
    fn webview2_version(&self) -> Result<Option<String>, PlatformError>;
    /// (Phase 6 Step 6, plan 4.8 and 4.12) Whether Windows protected print mode is on (Windows
    /// would remove printers that use third-party drivers). Read-only; `false` when the policy
    /// is absent.
    fn protected_print_on(&self) -> Result<bool, PlatformError>;
    /// The DACL of a file or folder as SDDL (flags included). `Ok(None)`: it does not exist.
    fn get_path_acl(&self, path: &Path) -> Result<Option<String>, PlatformError>;
    /// (Phase 5 Step 5) Every enabled local account with administrator rights, by SID with
    /// its account name (the admin-tile list is keyed by name; the SID is how an account
    /// is recognised). Read-only.
    fn enabled_local_admin_accounts(&self) -> Result<Vec<LocalAdminAccount>, PlatformError>;
    /// (Phase 5 Step 7) The SID of every enabled local account (administrators and standard
    /// users, the Staff account included). The AppLocker layer gives each one that is not
    /// the Staff account an allow-all rule. Read-only.
    fn enabled_local_account_sids(&self) -> Result<Vec<String>, PlatformError>;
    /// (Phase 5 Step 7) The DACL of `root` and of the folders below it, down to `max_depth`
    /// levels (links are never followed; `WinSxS` is skipped). The AppLocker layer's
    /// writable-folder scan of the Windows folder. Read-only.
    fn folder_acls(&self, root: &Path, max_depth: u32) -> Result<Vec<FolderAcl>, PlatformError>;
    // (Phase 5 Step 8) What the process watchdog (L5) reads. None of these changes anything.
    /// The image, session and owner of a process; `Ok(None)`: it has ended or cannot be opened.
    fn process_info(&self, pid: u32) -> Result<Option<ProcessInfo>, PlatformError>;
    /// Every describable process of a session (the watchdog's snapshot fallback and catch-up).
    fn session_processes(&self, session_id: u32) -> Result<Vec<ProcessInfo>, PlatformError>;
    /// Size and times of a file: the key of the signature cache. `Ok(None)`: no such file.
    fn file_stamp(&self, path: &Path) -> Result<Option<FileStamp>, PlatformError>;
    /// The signer and the version-resource names of a file. `Ok(None)`: no such file.
    fn file_identity(&self, path: &Path) -> Result<Option<FileIdentity>, PlatformError>;
    /// The SHA-256 (lower-case hex) of a file of at most `max_bytes`; `Ok(None)`: no such file or
    /// it is bigger.
    fn file_sha256(&self, path: &Path, max_bytes: u64) -> Result<Option<String>, PlatformError>;
    /// The kernel's loss counters of a running process trace (edge case 45).
    fn process_trace_stats(&self, handle: TraceHandle) -> Result<TraceStats, PlatformError>;
    /// (Phase 6 Step 11, plan 4.4.1) The file version of a program: the fixed numbers of its version resource as
    /// `a.b.c.d`. `Ok(None)`: no such file, or it has no version. Read-only.
    fn file_version(&self, path: &Path) -> Result<Option<String>, PlatformError>;
    /// (Phase 6 Step 11, plan 4.4.3) The names of the folders directly inside `dir`, for a versioned program
    /// folder (`app-1.2.3`). `Ok(empty)`: no such folder. Read-only; never follows a link.
    fn list_folder_names(&self, dir: &Path) -> Result<Vec<String>, PlatformError>;
    /// (Phase 6 Step 14, plan 4.6 "Per-user installer") Whether a file named `file_name` (a bare name, compared without
    /// regard to case) exists in `root` or in a folder at most `max_depth` levels below it. Read-only; never follows a
    /// link; bounded (it stops after a fixed number of entries and then says `false`). `Ok(false)`: no such file, or
    /// no such folder.
    fn find_file_below(&self, root: &Path, file_name: &str, max_depth: u32) -> Result<bool, PlatformError>;
    /// (Phase 6 Step 11, plan 4.4.5) Something that wakes when process `pid` ends, so the install engine learns that an
    /// app closed without a timer. `Ok(None)`: the process is gone or cannot be watched. Read-only.
    fn watch_process_exit(&self, pid: u32) -> Result<Option<Arc<dyn ExitWatch>>, PlatformError>;

    // mutating: every `WindowsPlatform` implementation calls `guard::require_armed_machine()` first (via `guard()`)
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
    /// (Phase 5 Step 14b) Deletes one package Rulebox published, `pnputil /delete-driver <oem<N>.inf> /uninstall`, through
    /// the same job-object run as an installer. Only a name of the form `oem<N>.inf` is accepted (anything else is
    /// `Refused` before the guard). `NotFound`: no such package. Blocking.
    fn driver_package_delete(&self, published: &str) -> Result<(), PlatformError>;
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
    /// (Review) `WindowsPlatform` opens every folder relative to its parent's held
    /// handle and deletes through handles (`rulebox_win32::tree`). `cancel` stops
    /// the work between entries (what was deleted stays deleted: `InUse`).
    /// Blocking: call it from `spawn_blocking`.
    fn reset_folder(
        &self,
        profile_dir: &Path,
        template: &str,
        cancel: &CancellationToken,
    ) -> Result<ResetOutcome, PlatformError>;

    // mutating, Phase 5 Step 3 (plan 4.5): each `WindowsPlatform` method checks its
    // allow-list (if it has one) and then the guard before anything else, and the
    // `rulebox-win32` function it calls does the same again.
    /// Writes a value in the Staff hive. `path` must be under `staffreg::ALLOWED_ROOTS`
    /// and `Shell` is never written here (`Refused`/`Other` before the guard).
    fn write_staff_value(&self, sid: &str, path: &str, name: &str, data: &RegData) -> Result<(), PlatformError>;
    fn delete_staff_value(&self, sid: &str, path: &str, name: &str) -> Result<(), PlatformError>;
    /// Copies a binary App Control policy into the active folder as `{policy_id}.cip`.
    fn deploy_ci_policy(&self, policy_id: &str, binary: &[u8]) -> Result<(), PlatformError>;
    fn remove_ci_policy(&self, policy_id: &str) -> Result<(), PlatformError>;
    /// (Phase 5 Step 6) `CiTool --refresh`: load the policies of the active folder now
    /// (Windows 11 22H2 and later). An error means the change waits for a restart.
    fn refresh_ci_policies(&self) -> Result<(), PlatformError>;
    fn set_applocker_policy(&self, xml: &str, mechanism: AppLockerMechanism) -> Result<(), PlatformError>;
    fn clear_applocker_policy(&self, mechanism: AppLockerMechanism) -> Result<(), PlatformError>;
    /// `start`: 2 automatic, 3 manual, 4 disabled. The agent's own service stays automatic.
    fn set_service_start(&self, name: &str, start: u32) -> Result<(), PlatformError>;
    /// The Rulebox agent service only.
    fn set_service_security(&self, name: &str, sddl: &str) -> Result<(), PlatformError>;
    /// The Rulebox agent service only. An empty list removes the limit.
    fn set_service_required_privileges(&self, name: &str, privileges: &[&str]) -> Result<(), PlatformError>;
    fn set_account_lockout(&self, policy: LockoutPolicy) -> Result<(), PlatformError>;
    /// The profile name inside the XML must start with `Rulebox-`.
    fn wlan_set_profile(&self, xml_with_key: &str) -> Result<(), PlatformError>;
    fn wlan_delete_profile(&self, name: &str) -> Result<(), PlatformError>;
    /// The user permit list; empty removes the filter.
    fn wlan_set_filters(&self, ssids: &[&str]) -> Result<(), PlatformError>;
    fn printer_add(&self, spec: &PrinterSpec) -> Result<(), PlatformError>;
    /// Only a queue named `<display name> (Rulebox)`.
    fn printer_delete(&self, name: &str) -> Result<(), PlatformError>;
    fn printer_set_security(&self, name: &str, sddl: &str) -> Result<(), PlatformError>;
    /// (Phase 5 Step 14) A Standard TCP/IP port (raw or LPR) named `Rulebox_<id>`; `AlreadyExists` when it is there.
    fn printer_port_add(&self, spec: &PortSpec) -> Result<(), PlatformError>;
    /// Only a port named `Rulebox_<id>`; one that is not there is fine.
    fn printer_port_delete(&self, name: &str) -> Result<(), PlatformError>;
    /// (Phase 5 Step 14) A per-machine connection to `\\server\queue`.
    fn printer_share_connect(&self, unc: &str) -> Result<(), PlatformError>;
    fn printer_share_disconnect(&self, unc: &str) -> Result<(), PlatformError>;
    /// Only `{current}` `recoveryenabled` (`Yes` / `No`).
    fn bcd_set(&self, object: &str, element: &str, value: &str) -> Result<(), PlatformError>;
    /// Starts the process-start trace; events arrive in `sink` on the trace's thread.
    fn start_process_trace(&self, sink: ProcessSink) -> Result<TraceHandle, PlatformError>;
    fn stop_process_trace(&self, handle: TraceHandle) -> Result<(), PlatformError>;
    /// Replaces the DACL of a file or folder. Only the install folder and the agent's
    /// `state` folder, or below them ([`acl_target_allowed`]).
    fn set_path_acl(&self, path: &Path, sddl: &str) -> Result<(), PlatformError>;
    /// (Phase 5 Step 5) Deletes `SafeBoot\<mode>\RuleboxAgent` (`Minimal` or `Network`), the
    /// agent's own Safe Mode key, and nothing else.
    fn remove_safe_boot_entry(&self, mode: &str) -> Result<(), PlatformError>;

    // mutating, Phase 6 Step 8 (plan 4.10): the install marker, the WebView2 bootstrapper and one
    // event log entry. The first one is allowed one condition less than the others (the marker
    // cannot name this computer before it has been written); see `guard::marker_write_allowed`.
    /// Sets one value of the install marker. `Ok(false)`: the marker (the MSI's `Install` key) does
    /// not exist, so nothing was written and nothing was created (a dev PC, a VM, no MSI).
    fn write_install_marker(&self, value: &InstallMarkerValue) -> Result<bool, PlatformError>;
    /// Runs Microsoft's WebView2 bootstrapper (`/silent /install`) and waits for it, at most
    /// `timeout`. `exe` must be `MicrosoftEdgeWebview2Setup.exe` in the install folder, and its
    /// SHA-256 must equal `expected_sha256` at the moment of the start (checked again here, after
    /// the caller's own check). The process and everything it starts are ended on a timeout or a
    /// cancel. Blocking: call it from a worker thread.
    fn run_webview_bootstrapper(
        &self,
        exe: &Path,
        expected_sha256: &str,
        timeout: Duration,
        cancel: &CancellationToken,
    ) -> Result<InstallerExit, PlatformError>;
    /// Writes one entry to the Windows Application event log (source `Rulebox Agent`). The text
    /// must never hold a secret.
    fn report_event(&self, kind: EventKind, event_id: u32, message: &str) -> Result<(), PlatformError>;
}
