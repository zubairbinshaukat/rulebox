//! `WindowsPlatform`: the real `Platform`, a thin map onto `rulebox-win32`
//! (plan Section 5.3, Step 10). It holds no logic of its own beyond three rules:
//!
//! - every mutating method checks the machine guard (`require_armed_machine`: the test
//!   marker, or an armed production install) **first**, before any lookup, so the dev
//!   machine can never reach a half-way change;
//! - machine writes are limited to `rulebox_win32::machinereg::ALLOWED_ROOTS` and Staff
//!   hive writes to `staffreg::ALLOWED_ROOTS`, checked before the guard (Phase 5 Step 3);
//! - the secrets file is protected with DPAPI under the service's own key.

use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{bail, Context};
use rulebox_win32::{
    accounts, applocker, bcd, codeintegrity, etw, eventlog, eventwrite, fileid, installmarker, machinereg, posture, printing,
    service, staffreg, wlan,
};
use rulebox_win32::guard::require_armed_machine;
use rulebox_win32::registry::{self, get_hklm, RegValue};
use rulebox_win32::shellreg::{self, Mechanism};
use rulebox_win32::sid::Sid;
use rulebox_win32::job::{self, KillOnCloseJob};
use rulebox_win32::tree::{self, Refusal, TreeOutcome};
use rulebox_win32::{dpapi, lsa, osinfo, process, security, session, Win32Error};
use serde::Deserialize;
use tokio_util::sync::CancellationToken;

use super::{EventKind, InstallMarkerValue};
use super::{
    acl_target_allowed, AppLockerMechanism, AppLockerState, BootIdentity, EventRecord, InstallerCommand, InstallerExit,
    FileIdentity, FileStamp, LocalUser, LockoutPolicy, OsInfo, Platform, PlatformError, PortSpec, PrinterInfo, PrinterSpec,
    ProcessInfo, ProcessSink, RegData, RegValueRef, ResetOutcome, SecurityPosture, ServiceConfig, SessionInfo,
    SessionState, ShellBinaries, ShellMechanism, StaffUserSpec, TraceHandle, TraceStats, WlanState,
};
use super::{FolderAcl, LocalAdminAccount};
use crate::cleanup::{resolve_reset, shell_folder_is_default};
use crate::installs::{
    installer_command_allowed, is_in_use, is_published_inf, is_reparse_point, portable_dir_ok, portable_target_ok, split_nsis_dir_tail,
    wait_for_installer, InstallerWait, RunTemp, RunningInstaller, INSTALLER_TAIL_GRACE,
};
use crate::installs::drivers_rules::pnputil_delete_command;
use crate::installs::msiexec_path;
use crate::paths::{data_dir_action, DataDirAction, DataPaths, InstallPaths};
use crate::state::write_atomic;

const WINLOGON_KEY: &str = rulebox_win32::autologon::WINLOGON_KEY;
const POLICIES_SYSTEM_KEY: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System";
/// (Phase 6 Step 6) Where the WebView2 Runtime keeps its version (`pv`), in the order they are tried.
const WEBVIEW2_KEYS: [&str; 2] = [
    r"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
    r"SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
];
/// (Phase 6 Step 15, plan 4.8) Windows protected print mode, as seen on build 26300 (VM spike S-12, 2026-11-25): the
/// effective state the print service keeps, the value the Settings switch writes, and the value the Group Policy
/// writes (the last one read from `Printing.admx`, not driven on the VM). Any one at 1 means on.
const PROTECTED_PRINT_VALUES: [(&str, &str); 3] = [
    (r"SYSTEM\CurrentControlSet\Control\Print", "WindowsProtectedPrintState"),
    (r"SOFTWARE\Policies\Microsoft\Windows NT\Printers\WPP", "WindowsProtectedPrintMode"),
    (r"SOFTWARE\Policies\Microsoft\Windows NT\Printers\WPP", "WindowsProtectedPrintGroupPolicyState"),
];
/// (Phase 5 Step 7) The most folders one `folder_acls` scan returns.
const FOLDER_SCAN_LIMIT: usize = 60_000;

pub struct WindowsPlatform {
    install: InstallPaths,
    data: DataPaths,
}

impl WindowsPlatform {
    pub fn new(install: InstallPaths, data: DataPaths) -> Self {
        Self { install, data }
    }
}

pub(super) fn map_err(error: Win32Error) -> PlatformError {
    match error {
        Win32Error::Guard(message) => PlatformError::Guard(message),
        Win32Error::AlreadyExists => PlatformError::AlreadyExists,
        Win32Error::NotFound => PlatformError::NotFound,
        Win32Error::PasswordPolicy => PlatformError::PasswordPolicy,
        Win32Error::Api { code: 5, .. } => PlatformError::AccessDenied,
        Win32Error::Api { api, code } => PlatformError::Win32 { api, code },
        Win32Error::Nt { api, status } => PlatformError::Win32 { api, code: status as u32 },
        Win32Error::Busy => PlatformError::Other("busy".into()),
        // A write outside an allow-list (Phase 5 Step 3): the same kind of refusal the
        // Phase 2 list check gave, with the same wording.
        Win32Error::Invalid(message) | Win32Error::Forbidden(message) => PlatformError::Other(message),
        Win32Error::Unsupported(what) => PlatformError::Refused(what),
    }
}

/// The machine guard (a test machine, or an armed production install), as a `PlatformError`.
fn guard() -> Result<(), PlatformError> {
    require_armed_machine().map_err(map_err)
}

/// (Phase 6 Step 8) The guard of the install-marker write only: the same, except that the marker
/// may not name this computer yet (`rulebox_win32::guard::marker_write_allowed`).
fn marker_guard() -> Result<(), PlatformError> {
    rulebox_win32::guard::require_marker_writable().map_err(map_err)
}

fn parse_sid(sid: &str) -> Result<Sid, PlatformError> {
    Sid::parse(sid).map_err(map_err)
}

fn to_mechanism(mechanism: ShellMechanism) -> Mechanism {
    match mechanism {
        ShellMechanism::PolicyShell => Mechanism::PolicyShell,
        ShellMechanism::WinlogonShell => Mechanism::WinlogonShell,
    }
}

fn reg_text(key: &str, name: &str) -> Result<Option<String>, PlatformError> {
    Ok(match get_hklm(key, name).map_err(map_err)? {
        Some(RegValue::String(text)) => Some(text),
        _ => None,
    })
}

/// `current.json`: `{ "version": "...", "exe": "versions\\<v>\\rulebox-staff.exe" }`.
#[derive(Deserialize)]
struct CurrentJson {
    exe: String,
}

/// The Staff App path named by `current.json`, only if it stays inside
/// `<install>\versions\` (no absolute path, no `..`, no stream or wildcard).
pub(crate) fn staff_app_exe(install_root: &Path, json: &str) -> Option<PathBuf> {
    let current: CurrentJson = serde_json::from_str(json).ok()?;
    let exe = current.exe.replace('/', "\\");
    if exe.is_empty() || exe.contains(':') || exe.contains('*') || exe.contains('?') {
        return None;
    }
    let relative = Path::new(&exe);
    if relative.is_absolute() || relative.has_root() {
        return None;
    }
    let mut components = relative.components();
    match components.next() {
        Some(std::path::Component::Normal(first)) if first.eq_ignore_ascii_case("versions") => {}
        _ => return None,
    }
    let mut rest = 0;
    for component in components {
        match component {
            std::path::Component::Normal(_) => rest += 1,
            _ => return None,
        }
    }
    (rest > 0).then(|| install_root.join(relative))
}

fn io_err(error: std::io::Error) -> PlatformError {
    PlatformError::Other(format!("file error: {error}"))
}

/// (Phase 6 Step 11) The real wait for a process to end: `rulebox_win32::procexit`.
struct WinExitWatch(rulebox_win32::procexit::ExitWatch);

impl super::ExitWatch for WinExitWatch {
    fn wait(&self) -> bool {
        self.0.wait()
    }

    fn cancel(&self) {
        self.0.cancel();
    }
}

impl Platform for WindowsPlatform {
    fn os_info(&self) -> Result<OsInfo, PlatformError> {
        let version = osinfo::os_version().map_err(map_err)?;
        let join = osinfo::join_state().map_err(map_err)?;
        let system_drive = osinfo::system_drive().map_err(map_err)?;
        Ok(OsInfo {
            build: version.build,
            ubr: version.ubr,
            display_version: version.display_version,
            edition_id: version.edition_id,
            product_type: osinfo::product_type().map_err(map_err)?,
            arch: osinfo::arch(),
            s_mode: osinfo::s_mode().map_err(map_err)?,
            domain_joined: join.domain_joined,
            entra_joined: join.entra_joined,
            ram_mb: osinfo::memory_mb().map_err(map_err)?,
            system_disk_free_gb: osinfo::disk_free_gb(&system_drive).map_err(map_err)?,
        })
    }

    fn computer_name(&self) -> Result<String, PlatformError> {
        osinfo::computer_name().map_err(map_err)
    }

    fn other_enabled_local_admins(&self, exclude_sid: Option<&str>) -> Result<Vec<String>, PlatformError> {
        let admins = accounts::enabled_local_admins().map_err(map_err)?;
        Ok(admins
            .into_iter()
            .map(|user| user.sid.as_str().to_string())
            .filter(|sid| Some(sid.as_str()) != exclude_sid)
            .collect())
    }

    fn legal_notice_present(&self) -> Result<bool, PlatformError> {
        for key in [WINLOGON_KEY, POLICIES_SYSTEM_KEY] {
            for name in ["LegalNoticeCaption", "LegalNoticeText"] {
                if reg_text(key, name)?.is_some_and(|text| !text.trim().is_empty()) {
                    return Ok(true);
                }
            }
        }
        Ok(false)
    }

    fn find_local_user(&self, user_name: &str) -> Result<Option<LocalUser>, PlatformError> {
        Ok(accounts::find_user(user_name).map_err(map_err)?.map(|user| LocalUser {
            sid: user.sid.as_str().to_string(),
            comment: user.comment,
            disabled: user.disabled,
        }))
    }

    fn read_machine_value(&self, key: &RegValueRef) -> Result<Option<RegData>, PlatformError> {
        Ok(get_hklm(&key.path, &key.name).map_err(map_err)?.map(|value| match value {
            RegValue::Dword(number) => RegData::Dword(number),
            RegValue::String(text) => RegData::String(text),
        }))
    }

    fn sessions(&self) -> Result<Vec<SessionInfo>, PlatformError> {
        let sessions = session::list_sessions().map_err(map_err)?;
        Ok(sessions
            .into_iter()
            .map(|s| SessionInfo {
                id: s.id,
                state: match s.state {
                    session::SessionState::Active => SessionState::Active,
                    session::SessionState::Connected => SessionState::Connected,
                    session::SessionState::Disconnected => SessionState::Disconnected,
                    session::SessionState::Other => SessionState::Other,
                },
                user_sid: s.user_sid.map(|sid| sid.as_str().to_string()),
                is_console: s.is_console,
            })
            .collect())
    }

    fn find_processes(&self, session_id: u32, image_path: &Path) -> Result<Vec<u32>, PlatformError> {
        process::find_by_image(session_id, image_path).map_err(map_err)
    }

    fn shell_binaries_ok(&self) -> Result<ShellBinaries, PlatformError> {
        let launcher_ok = self.install.shell_exe().is_file();
        let staff_app_ok = match std::fs::read_to_string(self.install.current_json()) {
            Ok(json) => staff_app_exe(self.install.root(), &json).is_some_and(|exe| exe.is_file()),
            Err(_) => false,
        };
        Ok(ShellBinaries { launcher_ok, staff_app_ok })
    }

    fn file_exists(&self, path: &Path) -> bool {
        path.is_file()
    }

    /// `{ProgramFiles}` is the parent of the install root (`FOLDERID_ProgramFiles`
    /// plus `Rulebox`); the x86 folder and the Windows folder come from the
    /// `ProgramFiles(x86)` and `SystemRoot` variables of the service's own
    /// environment (set by Windows for every process, SYSTEM included). A variable
    /// that is missing or not an absolute path leaves that root out (`None`): only
    /// the templates that start with it are refused, never the others.
    fn path_roots(&self) -> Result<rulebox_policy::paths::PathRoots, PlatformError> {
        let program_files = self
            .install
            .root()
            .parent()
            .ok_or_else(|| PlatformError::Other("the install root has no parent".into()))?;
        let var = |name: &str| {
            let value = std::env::var(name).ok().filter(|value| Path::new(value).is_absolute());
            if value.is_none() {
                tracing::debug!("the {name} folder is not known; templates that need it are refused");
            }
            value
        };
        Ok(rulebox_policy::paths::PathRoots {
            program_files: program_files.to_string_lossy().into_owned(),
            program_files_x86: var("ProgramFiles(x86)"),
            system_root: var("SystemRoot"),
            rulebox_apps: self.install.root().join("apps").to_string_lossy().into_owned(),
        })
    }

    fn create_staff_user(&self, spec: &StaffUserSpec, password: &str) -> Result<String, PlatformError> {
        guard()?;
        let sid = accounts::create_standard_user(&spec.user_name, &spec.full_name, &spec.comment, password)
            .map_err(map_err)?;
        Ok(sid.as_str().to_string())
    }

    fn set_user_password(&self, user_name: &str, password: &str) -> Result<(), PlatformError> {
        guard()?;
        accounts::set_password(user_name, password).map_err(map_err)
    }

    fn test_logon(&self, user_name: &str, password: &str) -> Result<bool, PlatformError> {
        guard()?;
        accounts::test_logon(user_name, password).map_err(map_err)
    }

    fn ensure_profile(&self, sid: &str, user_name: &str) -> Result<PathBuf, PlatformError> {
        guard()?;
        accounts::ensure_profile(&parse_sid(sid)?, user_name).map_err(map_err)
    }

    fn delete_staff_user(&self, sid: &str, user_name: &str) -> Result<(), PlatformError> {
        guard()?;
        accounts::delete_user_and_profile(&parse_sid(sid)?, user_name).map_err(map_err)
    }

    fn write_machine_value(&self, key: &RegValueRef, data: Option<&RegData>) -> Result<(), PlatformError> {
        let value = data.map(|data| match data {
            RegData::Dword(number) => RegValue::Dword(*number),
            RegData::String(text) => RegValue::String(text.clone()),
        });
        // The key list check comes first (and fails without touching anything), then
        // the guard, which `machinereg` applies again before the write.
        machinereg::check_write(&key.path, &key.name, value.as_ref()).map_err(map_err)?;
        guard()?;
        machinereg::set_machine_value(&key.path, &key.name, value.as_ref()).map_err(map_err)
    }

    fn lsa_secret_get(&self, name: &str) -> Result<Option<String>, PlatformError> {
        guard()?;
        lsa::secret_get(name).map_err(map_err)
    }

    fn lsa_secret_set(&self, name: &str, value: Option<&str>) -> Result<(), PlatformError> {
        guard()?;
        lsa::secret_set(name, value).map_err(map_err)
    }

    fn set_staff_shell(
        &self,
        sid: &str,
        mechanism: ShellMechanism,
        command: Option<&str>,
    ) -> Result<(), PlatformError> {
        guard()?;
        let sid = parse_sid(sid)?;
        // The account may be gone already: the reconciler treats NotFound as "cleared".
        let profile = accounts::profile_path(&sid).map_err(map_err)?;
        shellreg::set_user_shell(&sid, &profile, to_mechanism(mechanism), command).map_err(map_err)
    }

    fn set_staff_user_policy(&self, sid: &str, name: &str, value: Option<u32>) -> Result<(), PlatformError> {
        guard()?;
        let sid = parse_sid(sid)?;
        let profile = accounts::profile_path(&sid).map_err(map_err)?;
        shellreg::set_user_policy_dword(&sid, &profile, name, value).map_err(map_err)
    }

    fn logoff_session(&self, session_id: u32) -> Result<(), PlatformError> {
        guard()?;
        session::logoff(session_id).map_err(map_err)
    }

    fn launch_in_session(&self, session_id: u32, expected_sid: &str, exe: &Path) -> Result<u32, PlatformError> {
        guard()?;
        process::launch_in_session(session_id, &parse_sid(expected_sid)?, exe).map_err(map_err)
    }

    fn terminate_process(&self, pid: u32, expected_image: &Path, expected_sid: &str) -> Result<(), PlatformError> {
        guard()?;
        process::terminate(pid, expected_image, &parse_sid(expected_sid)?).map_err(map_err)
    }

    fn secrets_load(&self) -> Result<Option<Vec<u8>>, PlatformError> {
        match std::fs::read(self.data.secrets()) {
            Ok(blob) => dpapi::unprotect(&blob).map(Some).map_err(map_err),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(io_err(error)),
        }
    }

    fn secrets_save(&self, plaintext: &[u8]) -> Result<(), PlatformError> {
        guard()?;
        let blob = dpapi::protect(plaintext).map_err(map_err)?;
        std::fs::create_dir_all(self.data.state_dir()).map_err(io_err)?;
        write_atomic(&self.data.secrets(), &blob).map_err(io_err)
    }

    fn disk_free_bytes(&self) -> Result<u64, PlatformError> {
        let drive = osinfo::system_drive().map_err(map_err)?;
        osinfo::disk_free_bytes(&drive).map_err(map_err)
    }

    /// Windows' boot counter (`BootId` under the prefetch parameters: a value Windows
    /// raises at every boot; not a documented API, so missing or unreadable is
    /// `None` and the engine falls back to the uptime) and the tick count.
    fn boot_identity(&self) -> Result<BootIdentity, PlatformError> {
        let boot_id = match get_hklm(BOOT_ID_KEY, "BootId") {
            Ok(Some(RegValue::Dword(id))) => Some(id),
            Ok(_) => None,
            Err(error) => {
                tracing::debug!("cannot read BootId ({error}); the uptime decides");
                None
            }
        };
        Ok(BootIdentity { boot_id, uptime_ms: osinfo::uptime_ms(), boot_time_ms: osinfo::boot_time_ms() })
    }

    /// `CreateProcessW` through `std::process::Command` (no shell: each argument is
    /// quoted by the MSVC rules), `CREATE_NO_WINDOW | CREATE_SUSPENDED`, the standard
    /// handles to NUL, as SYSTEM (the service's own token), with TEMP / TMP / TMPDIR
    /// set to a fresh folder of this run inside the protected data directory (never
    /// `C:\Windows\Temp`, which standard users can write to). The suspended process
    /// is put in a kill-on-close job before it runs, so everything it starts is in
    /// the job too: a timeout or a stop ends the whole tree, and so does a crash of
    /// the agent (the job handle closes). Returns once nothing of the run is left;
    /// the temp folder is deleted afterwards on every path. The program rule is
    /// checked first, then the guard: nothing ever starts on a machine without the
    /// marker.
    fn run_installer(
        &self,
        cmd: &InstallerCommand,
        timeout: Duration,
        cancel: &CancellationToken,
    ) -> Result<InstallerExit, PlatformError> {
        use std::os::windows::io::AsHandle;
        use std::os::windows::process::CommandExt;
        let system_root = system_root();
        if !installer_command_allowed(&cmd.program, &cmd.args, system_root.as_deref(), &self.data.downloads_dir(), &self.data.drivers_dir()) {
            return Err(PlatformError::Other("program not allowed".into()));
        }
        guard()?;
        // The downloads folder itself must not be a link (the file is opened and
        // locked by the engine; this keeps the folder from being redirected).
        if is_reparse_point(&self.data.downloads_dir()).map_err(io_err)? {
            return Err(PlatformError::Other("the downloads folder is a link".into()));
        }
        let temp = RunTemp::create(&self.data.installer_temp_dir()).map_err(io_err)?;
        let job = KillOnCloseJob::new().map_err(map_err)?;
        // (Per-user installs, Tier A) A last argument `/D=<folder>` is NSIS's raw switch: it must not be quoted.
        let (plain_args, raw_tail) = split_nsis_dir_tail(&cmd.args);
        let mut command = std::process::Command::new(&cmd.program);
        command.args(plain_args);
        if let Some(tail) = raw_tail {
            command.raw_arg(tail);
        }
        let child = command
            .current_dir(&cmd.working_dir)
            .env("TEMP", temp.path())
            .env("TMP", temp.path())
            .env("TMPDIR", temp.path())
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED)
            .spawn()
            .map_err(io_err)?;
        let mut run = JobRun { child, job };
        // In the job before its first instruction: it cannot start a child outside.
        let started = run.job.assign(run.child.as_handle()).and_then(|()| job::resume_process(run.child.id()));
        if let Err(error) = started {
            // Not in the job, or never resumed: end it (still suspended, nothing ran).
            let _ = run.child.kill();
            let _ = run.child.wait();
            return Err(map_err(error));
        }
        let start = std::time::Instant::now();
        let wait = InstallerWait { timeout, tail_grace: INSTALLER_TAIL_GRACE, poll: INSTALLER_POLL };
        let ended = wait_for_installer(
            &mut run,
            wait,
            &|| cancel.is_cancelled(),
            &|| start.elapsed(),
            &|pause| std::thread::sleep(pause),
        );
        // The job first (nothing of the run is left), then the temp folder.
        drop(run);
        drop(temp);
        ended.map_err(io_err)
    }

    fn driver_package_delete(&self, published: &str) -> Result<(), PlatformError> {
        if !is_published_inf(published) {
            return Err(PlatformError::Refused("not a published driver name"));
        }
        guard()?;
        let published = published.to_ascii_lowercase();
        let root = system_root().ok_or_else(|| PlatformError::Other("the Windows folder is not known".into()))?;
        // The one command line `installer_command_allowed` lets pnputil run for a removal (built in `drivers_rules`, tested there).
        let cmd = pnputil_delete_command(&root, &published).ok_or(PlatformError::Refused("not a published driver name"))?;
        match self.run_installer(&cmd, Duration::from_secs(10 * 60), &CancellationToken::new())? {
            InstallerExit::Code(0 | 3010) => Ok(()),
            InstallerExit::Code(_) => {
                // pnputil answers a generic failure for a package that is not there; the store says which it was.
                if self.driver_store_infs()?.contains(&published) {
                    Err(PlatformError::Other("pnputil could not delete the package".into()))
                } else {
                    Err(PlatformError::NotFound)
                }
            }
            InstallerExit::TimedOut | InstallerExit::Stalled => Err(PlatformError::Other("pnputil did not finish in time".into())),
            InstallerExit::Cancelled => Err(PlatformError::Other("cancelled".into())),
        }
    }

    fn printer_driver_install(&self, name: &str) -> Result<(), PlatformError> {
        printing::check_plain_name(name).map_err(map_err)?;
        guard()?;
        printing::install_driver_from_store(name).map_err(map_err)
    }

    fn printer_driver_delete(&self, name: &str) -> Result<(), PlatformError> {
        printing::check_plain_name(name).map_err(map_err)?;
        guard()?;
        printing::delete_driver(name).map_err(map_err)
    }

    fn trusted_publisher_add(&self, der: &[u8]) -> Result<(), PlatformError> {
        guard()?;
        rulebox_win32::publisher::add(der).map_err(map_err)
    }

    fn trusted_publisher_remove(&self, sha1: &str) -> Result<(), PlatformError> {
        guard()?;
        rulebox_win32::publisher::remove(sha1).map_err(map_err)
    }

    fn place_portable(&self, from: &Path, to: &Path) -> Result<(), PlatformError> {
        let apps = self.install.root().join("apps");
        if !portable_target_ok(&apps, to) {
            return Err(PlatformError::Other("not inside the apps folder".into()));
        }
        guard()?;
        let folder = to.parent().ok_or_else(|| PlatformError::Other("no app folder".into()))?;
        refuse_links(&[self.install.root(), &apps, folder])?;
        std::fs::create_dir_all(folder).map_err(io_err)?;
        // Again after creating: nothing may have been swapped in meanwhile.
        refuse_links(&[&apps, folder, to])?;
        let mut tmp_name = to.file_name().map(|n| n.to_os_string()).unwrap_or_default();
        tmp_name.push(".tmp");
        let tmp = to.with_file_name(tmp_name);
        std::fs::copy(from, &tmp).map_err(io_err)?;
        std::fs::rename(&tmp, to).map_err(|error| {
            let _ = std::fs::remove_file(&tmp);
            // The copy beside it worked, so the folder is writable: the old
            // program is running (an upgrade waits like a busy installer).
            if is_in_use(&error) {
                PlatformError::InUse
            } else {
                io_err(error)
            }
        })
    }

    fn remove_portable(&self, app_dir: &Path) -> Result<(), PlatformError> {
        let apps = self.install.root().join("apps");
        if !portable_dir_ok(&apps, app_dir) {
            return Err(PlatformError::Other("not inside the apps folder".into()));
        }
        guard()?;
        refuse_links(&[self.install.root(), &apps, app_dir])?;
        match std::fs::remove_dir_all(app_dir) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            // The program is running: retried like a busy installer.
            Err(error) if is_in_use(&error) => Err(PlatformError::InUse),
            Err(error) => Err(io_err(error)),
        }
    }

    /// (Step 16 review) The template rule first (incl. the deny list), then the
    /// guard, then `rulebox_win32::tree::reset_below`: no path string is resolved
    /// below the profile folder; every folder is opened relative to its parent's
    /// held handle without crossing a reparse point, a link or a case-sensitive
    /// folder on the way refuses the entry, and everything is deleted through its
    /// own handle (a link inside is deleted itself). See that module for the
    /// threat. `Stopped` (cancelled) is reported as `InUse`: not finished.
    fn reset_folder(
        &self,
        profile_dir: &Path,
        template: &str,
        cancel: &CancellationToken,
    ) -> Result<ResetOutcome, PlatformError> {
        let target = resolve_reset(profile_dir, template)?;
        guard()?;
        let (shared, own) = target.components.split_at(SHARED_COMPONENTS.min(target.components.len()));
        let shared: Vec<&str> = shared.iter().map(String::as_str).collect();
        let own: Vec<&str> = own.iter().map(String::as_str).collect();
        let outcome =
            tree::reset_below(profile_dir, &shared, &own, &|| cancel.is_cancelled()).map_err(map_err)?;
        match outcome {
            TreeOutcome::Removed => Ok(ResetOutcome::Removed),
            TreeOutcome::Absent => Ok(ResetOutcome::Absent),
            TreeOutcome::InUse | TreeOutcome::Stopped => Ok(ResetOutcome::InUse),
            TreeOutcome::Refused(Refusal::Link) => Err(PlatformError::Refused("a folder on the way is a link")),
            TreeOutcome::Refused(Refusal::CaseSensitive) => {
                Err(PlatformError::Refused("a folder on the way is case-sensitive"))
            }
        }
    }

    fn staff_profile_dir(&self, sid: &str) -> Result<Option<PathBuf>, PlatformError> {
        match accounts::profile_path(&parse_sid(sid)?) {
            Ok(path) => Ok(Some(path)),
            Err(Win32Error::NotFound) => Ok(None),
            Err(error) => Err(map_err(error)),
        }
    }

    /// Reads `User Shell Folders` from the Staff hive only when it is loaded (the
    /// Staff account is signed in); `RegGetValueW` expands `%USERPROFILE%` with the
    /// service's own profile, which [`shell_folder_is_default`] accepts too.
    fn staff_app_data_redirected(&self, sid: &str, profile: &Path) -> Result<Option<bool>, PlatformError> {
        let sid = parse_sid(sid)?;
        let service_profile = std::env::var_os("USERPROFILE").map(PathBuf::from);
        let mut redirected = false;
        for (name, sub) in [("AppData", "Roaming"), ("Local AppData", "Local")] {
            match registry::get_loaded_user_value(&sid, USER_SHELL_FOLDERS_KEY, name).map_err(map_err)? {
                None => return Ok(None),
                Some(None) => {}
                Some(Some(RegValue::String(value))) => {
                    redirected |= !shell_folder_is_default(&value, profile, service_profile.as_deref(), sub);
                }
                Some(Some(RegValue::Dword(_))) => redirected = true,
            }
        }
        Ok(Some(redirected))
    }

    // -- Phase 5 Step 3 (plan 4.5) ----------------------------------------------------

    fn list_machine_value_names(&self, path: &str) -> Result<Vec<String>, PlatformError> {
        machinereg::list_value_names(path).map_err(map_err)
    }

    fn machine_key_exists(&self, path: &str) -> Result<bool, PlatformError> {
        machinereg::key_exists(path).map_err(map_err)
    }

    fn read_staff_value(&self, sid: &str, path: &str, name: &str) -> Result<Option<RegData>, PlatformError> {
        let sid = parse_sid(sid)?;
        // The account (and with it the hive) may be gone: nothing is there to read.
        let profile = match accounts::profile_path(&sid) {
            Ok(profile) => profile,
            Err(Win32Error::NotFound) => return Ok(None),
            Err(error) => return Err(map_err(error)),
        };
        let value = staffreg::read_value(&sid, &profile, path, name).map_err(map_err)?;
        Ok(value.map(reg_data))
    }

    fn list_staff_value_names(&self, sid: &str, path: &str) -> Result<Vec<String>, PlatformError> {
        let sid = parse_sid(sid)?;
        // The account (and with it the hive) may be gone: nothing is there to list.
        let profile = match accounts::profile_path(&sid) {
            Ok(profile) => profile,
            Err(Win32Error::NotFound) => return Ok(Vec::new()),
            Err(error) => return Err(map_err(error)),
        };
        staffreg::list_value_names(&sid, &profile, path).map_err(map_err)
    }

    fn list_ci_policies(&self) -> Result<Vec<String>, PlatformError> {
        codeintegrity::list_policies().map_err(map_err)
    }

    fn read_ci_policy(&self, policy_id: &str) -> Result<Option<Vec<u8>>, PlatformError> {
        codeintegrity::read_policy(policy_id).map_err(map_err)
    }

    fn get_applocker_policy(&self) -> Result<AppLockerState, PlatformError> {
        applocker::get_policy().map_err(map_err)
    }

    fn query_service(&self, name: &str) -> Result<Option<ServiceConfig>, PlatformError> {
        service::query(name).map_err(map_err)
    }

    fn get_service_security(&self, name: &str) -> Result<Option<String>, PlatformError> {
        service::get_security(name).map_err(map_err)
    }

    fn get_service_required_privileges(&self, name: &str) -> Result<Vec<String>, PlatformError> {
        service::get_required_privileges(name).map_err(map_err)
    }

    fn get_account_lockout(&self) -> Result<LockoutPolicy, PlatformError> {
        accounts::get_account_lockout().map_err(map_err)
    }

    fn wlan_list(&self) -> Result<WlanState, PlatformError> {
        wlan::list().map_err(map_err)
    }

    fn wlan_current_ssid(&self) -> Result<Option<String>, PlatformError> {
        wlan::current_ssid().map_err(map_err)
    }

    fn wlan_last_connect_failures(&self) -> Result<Vec<String>, PlatformError> {
        wlan::last_connect_failures().map_err(map_err)
    }

    fn printer_list(&self) -> Result<Vec<PrinterInfo>, PlatformError> {
        printing::list().map_err(map_err)
    }

    fn printer_get_security(&self, name: &str) -> Result<Option<String>, PlatformError> {
        printing::get_security(name).map_err(map_err)
    }

    fn printer_drivers(&self) -> Result<Vec<String>, PlatformError> {
        printing::list_drivers().map_err(map_err)
    }

    fn printer_ports(&self) -> Result<Vec<String>, PlatformError> {
        printing::list_ports().map_err(map_err)
    }

    fn driver_store_infs(&self) -> Result<Vec<String>, PlatformError> {
        let root = system_root().ok_or_else(|| PlatformError::Other("the Windows folder is not known".into()))?;
        let mut names: Vec<String> = std::fs::read_dir(root.join("INF"))
            .map_err(io_err)?
            .flatten()
            .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
            .map(|entry| entry.file_name().to_string_lossy().to_ascii_lowercase())
            .filter(|name| is_published_inf(name))
            .collect();
        names.sort();
        Ok(names)
    }

    fn driver_package_models(&self, published: &str) -> Result<Vec<String>, PlatformError> {
        if !is_published_inf(published) {
            return Err(PlatformError::Refused("not a published driver name"));
        }
        let root = system_root().ok_or_else(|| PlatformError::Other("the Windows folder is not known".into()))?;
        let file = root.join("INF").join(published.to_ascii_lowercase());
        let bytes = match std::fs::metadata(&file) {
            Ok(meta) if meta.is_file() && meta.len() <= crate::installs::drivers_rules::MAX_INF_BYTES as u64 => std::fs::read(&file).map_err(io_err)?,
            Ok(meta) if meta.is_file() => return Err(PlatformError::Other("the package INF is too large to read".into())),
            Ok(_) => return Ok(Vec::new()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(io_err(error)),
        };
        Ok(crate::installs::drivers_rules::inf_models(&crate::installs::drivers_rules::decode_inf(&bytes)))
    }

    fn file_signer_cert(&self, path: &Path) -> Result<Option<super::SignerCert>, PlatformError> {
        fileid::signer_cert(path).map_err(map_err)
    }

    fn trusted_publisher_has(&self, sha1: &str) -> Result<bool, PlatformError> {
        rulebox_win32::publisher::trusted_publisher_has(sha1).map_err(map_err)
    }

    fn bcd_get(&self, object: &str, element: &str) -> Result<Option<String>, PlatformError> {
        bcd::get(object, element).map_err(map_err)
    }

    fn read_event_log(&self, channel: &str, after_record_id: u64, max: usize) -> Result<Vec<EventRecord>, PlatformError> {
        eventlog::read(channel, after_record_id, max).map_err(map_err)
    }

    fn read_security_posture(&self) -> Result<SecurityPosture, PlatformError> {
        posture::read_security_posture().map_err(map_err)
    }

    /// The Evergreen Runtime registers its `pv` under the 32-bit view of EdgeUpdate (`WOW6432Node`)
    /// on a 64-bit Windows; the native path is the fallback. Per-machine only: the Staff account
    /// is another user, so a runtime installed for someone else's profile is no use to it.
    fn webview2_version(&self) -> Result<Option<String>, PlatformError> {
        for path in WEBVIEW2_KEYS {
            if let Some(RegValue::String(text)) = get_hklm(path, "pv").map_err(map_err)? {
                if !text.trim().is_empty() {
                    return Ok(Some(text));
                }
            }
        }
        Ok(None)
    }

    /// Plan 4.8 (values seen in VM spike S-12): `Control\Print\WindowsProtectedPrintState`,
    /// `WPP\WindowsProtectedPrintMode` (Settings switch) and `WPP\WindowsProtectedPrintGroupPolicyState`
    /// (Group Policy, from the ADMX); any one at 1 counts as on.
    fn protected_print_on(&self) -> Result<bool, PlatformError> {
        for (path, name) in PROTECTED_PRINT_VALUES {
            if let Some(RegValue::Dword(1)) = get_hklm(path, name).map_err(map_err)? {
                return Ok(true);
            }
        }
        Ok(false)
    }

    fn get_path_acl(&self, path: &Path) -> Result<Option<String>, PlatformError> {
        security::get_path_dacl(path).map_err(map_err)
    }

    fn enabled_local_admin_accounts(&self) -> Result<Vec<LocalAdminAccount>, PlatformError> {
        let admins = accounts::enabled_local_admins().map_err(map_err)?;
        Ok(admins
            .into_iter()
            .map(|user| LocalAdminAccount { sid: user.sid.as_str().to_string(), name: user.name })
            .collect())
    }

    fn enabled_local_account_sids(&self) -> Result<Vec<String>, PlatformError> {
        let accounts = accounts::enabled_local_accounts().map_err(map_err)?;
        Ok(accounts.into_iter().map(|user| user.sid.as_str().to_string()).collect())
    }

    fn folder_acls(&self, root: &Path, max_depth: u32) -> Result<Vec<FolderAcl>, PlatformError> {
        // WinSxS is the component store: huge, and not writable by standard users.
        let folders = security::list_folder_dacls(root, max_depth, &["WinSxS"], FOLDER_SCAN_LIMIT).map_err(map_err)?;
        Ok(folders.into_iter().map(|(path, sddl)| FolderAcl { path, sddl }).collect())
    }

    fn process_info(&self, pid: u32) -> Result<Option<ProcessInfo>, PlatformError> {
        process::process_info(pid).map_err(map_err)
    }

    fn session_processes(&self, session_id: u32) -> Result<Vec<ProcessInfo>, PlatformError> {
        process::session_processes(session_id).map_err(map_err)
    }

    fn file_stamp(&self, path: &Path) -> Result<Option<FileStamp>, PlatformError> {
        fileid::file_stamp(path).map_err(map_err)
    }

    fn file_identity(&self, path: &Path) -> Result<Option<FileIdentity>, PlatformError> {
        fileid::file_identity(path).map_err(map_err)
    }

    fn file_sha256(&self, path: &Path, max_bytes: u64) -> Result<Option<String>, PlatformError> {
        use sha2::{Digest, Sha256};
        use std::io::Read;
        let mut file = match std::fs::File::open(path) {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(io_err(e)),
        };
        if file.metadata().map_err(io_err)?.len() > max_bytes {
            return Ok(None);
        }
        let mut hasher = Sha256::new();
        let mut chunk = vec![0u8; 64 * 1024];
        loop {
            let read = file.read(&mut chunk).map_err(io_err)?;
            if read == 0 {
                break;
            }
            hasher.update(&chunk[..read]);
        }
        Ok(Some(hasher.finalize().iter().map(|byte| format!("{byte:02x}")).collect()))
    }

    fn process_trace_stats(&self, handle: TraceHandle) -> Result<TraceStats, PlatformError> {
        etw::trace_stats(handle).map_err(map_err)
    }

    fn file_version(&self, path: &Path) -> Result<Option<String>, PlatformError> {
        Ok(rulebox_win32::version::file_version(path))
    }

    fn list_folder_names(&self, dir: &Path) -> Result<Vec<String>, PlatformError> {
        let entries = match std::fs::read_dir(dir) {
            Ok(entries) => entries,
            Err(e) if matches!(e.kind(), std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory) => return Ok(Vec::new()),
            Err(e) => return Err(io_err(e)),
        };
        let mut names = Vec::new();
        for entry in entries.flatten() {
            // `file_type` does not follow a link: a junction or symbolic link is not a folder here.
            if entry.file_type().is_ok_and(|kind| kind.is_dir() && !kind.is_symlink()) {
                if let Ok(name) = entry.file_name().into_string() {
                    names.push(name);
                }
            }
        }
        names.sort();
        Ok(names)
    }

    fn find_file_below(&self, root: &Path, file_name: &str, max_depth: u32) -> Result<bool, PlatformError> {
        if file_name.is_empty() || file_name.contains(['\\', '/', ':']) {
            return Ok(false);
        }
        // A breadth-first walk with a budget: the profile of SYSTEM is small, but a hostile or broken tree must not hold
        // the engine. Links are never entered (`file_type` does not follow them).
        let mut level = vec![root.to_path_buf()];
        let mut seen = 0usize;
        for depth in 0..=max_depth {
            let mut next = Vec::new();
            for dir in &level {
                let entries = match std::fs::read_dir(dir) {
                    Ok(entries) => entries,
                    Err(e) if matches!(e.kind(), std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory) => continue,
                    Err(e) => return Err(io_err(e)),
                };
                for entry in entries.flatten() {
                    seen += 1;
                    if seen > FIND_FILE_MAX_ENTRIES {
                        return Ok(false);
                    }
                    let Ok(kind) = entry.file_type() else { continue };
                    if kind.is_symlink() {
                        continue;
                    }
                    if kind.is_file() && entry.file_name().to_string_lossy().eq_ignore_ascii_case(file_name) {
                        return Ok(true);
                    }
                    if kind.is_dir() && depth < max_depth {
                        next.push(entry.path());
                    }
                }
            }
            level = next;
        }
        Ok(false)
    }

    fn watch_process_exit(&self, pid: u32) -> Result<Option<std::sync::Arc<dyn super::ExitWatch>>, PlatformError> {
        Ok(rulebox_win32::procexit::ExitWatch::open(pid)
            .map_err(map_err)?
            .map(|watch| std::sync::Arc::new(WinExitWatch(watch)) as std::sync::Arc<dyn super::ExitWatch>))
    }

    fn write_staff_value(&self, sid: &str, path: &str, name: &str, data: &RegData) -> Result<(), PlatformError> {
        staffreg::check_write(path, name).map_err(map_err)?;
        guard()?;
        let sid = parse_sid(sid)?;
        let profile = accounts::profile_path(&sid).map_err(map_err)?;
        staffreg::write_value(&sid, &profile, path, name, &reg_value(data)).map_err(map_err)
    }

    fn delete_staff_value(&self, sid: &str, path: &str, name: &str) -> Result<(), PlatformError> {
        staffreg::check_write(path, name).map_err(map_err)?;
        guard()?;
        let sid = parse_sid(sid)?;
        let profile = accounts::profile_path(&sid).map_err(map_err)?;
        staffreg::delete_value(&sid, &profile, path, name).map_err(map_err)
    }

    fn delete_staff_key_if_empty(&self, sid: &str, path: &str) -> Result<bool, PlatformError> {
        staffreg::check_browser_key(path).map_err(map_err)?;
        guard()?;
        let sid = parse_sid(sid)?;
        let profile = accounts::profile_path(&sid).map_err(map_err)?;
        staffreg::delete_key_if_empty(&sid, &profile, path).map_err(map_err)
    }

    fn delete_machine_key_if_empty(&self, path: &str) -> Result<bool, PlatformError> {
        machinereg::check_created_key(path).map_err(map_err)?;
        guard()?;
        machinereg::delete_key_if_empty(path).map_err(map_err)
    }

    fn deploy_ci_policy(&self, policy_id: &str, binary: &[u8]) -> Result<(), PlatformError> {
        codeintegrity::check_policy_id(policy_id).map_err(map_err)?;
        guard()?;
        codeintegrity::deploy_policy(policy_id, binary).map_err(map_err)
    }

    fn remove_ci_policy(&self, policy_id: &str) -> Result<(), PlatformError> {
        codeintegrity::check_policy_id(policy_id).map_err(map_err)?;
        guard()?;
        codeintegrity::remove_policy(policy_id).map_err(map_err)
    }

    fn refresh_ci_policies(&self) -> Result<(), PlatformError> {
        guard()?;
        codeintegrity::refresh().map_err(map_err)
    }

    fn set_applocker_policy(&self, xml: &str, mechanism: AppLockerMechanism) -> Result<(), PlatformError> {
        guard()?;
        applocker::set_policy(xml, mechanism).map_err(map_err)
    }

    fn clear_applocker_policy(&self, mechanism: AppLockerMechanism) -> Result<(), PlatformError> {
        guard()?;
        applocker::clear_policy(mechanism).map_err(map_err)
    }

    fn set_service_start(&self, name: &str, start: u32) -> Result<(), PlatformError> {
        service::check_start(name, start).map_err(map_err)?;
        guard()?;
        service::set_start(name, start).map_err(map_err)
    }

    fn set_service_security(&self, name: &str, sddl: &str) -> Result<(), PlatformError> {
        service::check_agent_only(name).map_err(map_err)?;
        service::check_service_sddl(sddl).map_err(map_err)?;
        guard()?;
        service::set_security(name, sddl).map_err(map_err)
    }

    fn set_service_required_privileges(&self, name: &str, privileges: &[&str]) -> Result<(), PlatformError> {
        service::check_agent_only(name).map_err(map_err)?;
        service::check_required_privileges(privileges).map_err(map_err)?;
        guard()?;
        service::set_required_privileges(name, privileges).map_err(map_err)
    }

    fn set_account_lockout(&self, policy: LockoutPolicy) -> Result<(), PlatformError> {
        guard()?;
        accounts::set_account_lockout(policy).map_err(map_err)
    }

    fn wlan_set_profile(&self, xml_with_key: &str) -> Result<(), PlatformError> {
        wlan::check_profile_xml(xml_with_key).map_err(map_err)?;
        guard()?;
        wlan::set_profile(xml_with_key).map_err(map_err)
    }

    fn wlan_delete_profile(&self, name: &str) -> Result<(), PlatformError> {
        wlan::check_profile_name(name).map_err(map_err)?;
        guard()?;
        wlan::delete_profile(name).map_err(map_err)
    }

    fn wlan_set_filters(&self, ssids: &[&str]) -> Result<(), PlatformError> {
        wlan::check_filters(ssids).map_err(map_err)?;
        guard()?;
        wlan::set_filters(ssids).map_err(map_err)
    }

    fn printer_add(&self, spec: &PrinterSpec) -> Result<(), PlatformError> {
        printing::check_spec(spec).map_err(map_err)?;
        guard()?;
        printing::add(spec).map_err(map_err)
    }

    fn printer_delete(&self, name: &str) -> Result<(), PlatformError> {
        printing::check_own_name(name).map_err(map_err)?;
        guard()?;
        printing::delete(name).map_err(map_err)
    }

    fn printer_set_security(&self, name: &str, sddl: &str) -> Result<(), PlatformError> {
        printing::check_plain_name(name).map_err(map_err)?;
        guard()?;
        printing::set_security(name, sddl).map_err(map_err)
    }

    fn printer_port_add(&self, spec: &PortSpec) -> Result<(), PlatformError> {
        printing::check_port_spec(spec).map_err(map_err)?;
        guard()?;
        printing::add_port(spec).map_err(map_err)
    }

    fn printer_port_delete(&self, name: &str) -> Result<(), PlatformError> {
        printing::check_own_port_name(name).map_err(map_err)?;
        guard()?;
        printing::delete_port(name).map_err(map_err)
    }

    fn printer_share_connect(&self, unc: &str) -> Result<(), PlatformError> {
        printing::check_share_name(unc).map_err(map_err)?;
        guard()?;
        printing::connect_share(unc).map_err(map_err)
    }

    fn printer_share_disconnect(&self, unc: &str) -> Result<(), PlatformError> {
        printing::check_share_name(unc).map_err(map_err)?;
        guard()?;
        printing::disconnect_share(unc).map_err(map_err)
    }

    fn bcd_set(&self, object: &str, element: &str, value: &str) -> Result<(), PlatformError> {
        bcd::check_set(object, element, value).map_err(map_err)?;
        guard()?;
        bcd::set(object, element, value).map_err(map_err)
    }

    fn start_process_trace(&self, sink: ProcessSink) -> Result<TraceHandle, PlatformError> {
        guard()?;
        etw::start_trace(sink).map_err(map_err)
    }

    fn stop_process_trace(&self, handle: TraceHandle) -> Result<(), PlatformError> {
        guard()?;
        etw::stop_trace(handle).map_err(map_err)
    }

    fn set_path_acl(&self, path: &Path, sddl: &str) -> Result<(), PlatformError> {
        if !acl_target_allowed(self.install.root(), &self.data.state_dir(), path) {
            return Err(PlatformError::Refused("not a Rulebox folder"));
        }
        guard()?;
        // A link on the target would send the new ACL somewhere else.
        if is_reparse_point(path).unwrap_or(false) {
            return Err(PlatformError::Refused("the folder is a link"));
        }
        security::set_path_dacl(path, sddl).map_err(map_err)
    }

    fn remove_safe_boot_entry(&self, mode: &str) -> Result<(), PlatformError> {
        machinereg::check_safe_boot_mode(mode).map_err(map_err)?;
        guard()?;
        machinereg::delete_safe_boot_entry(mode).map_err(map_err)
    }

    /// (Phase 6 Step 8) The marker guard is the production door without its last condition (the
    /// marker is what is being written); `installmarker` checks it again.
    fn write_install_marker(&self, value: &InstallMarkerValue) -> Result<bool, PlatformError> {
        marker_guard()?;
        let wrote = match value {
            InstallMarkerValue::ComputerName(name) => installmarker::write_computer_name(name),
            InstallMarkerValue::KioskOn(on) => installmarker::write_kiosk_on(*on),
        };
        wrote.map(|written| written == installmarker::MarkerWrite::Written).map_err(map_err)
    }

    /// (Phase 6 Step 8) Only `MicrosoftEdgeWebview2Setup.exe` in the install folder, and only when
    /// its SHA-256 is the pinned one right now. Same job object as an installer: the bootstrapper
    /// and everything it starts end on a timeout or a cancel (and when this process ends).
    fn run_webview_bootstrapper(
        &self,
        exe: &Path,
        expected_sha256: &str,
        timeout: Duration,
        cancel: &CancellationToken,
    ) -> Result<InstallerExit, PlatformError> {
        use std::os::windows::io::AsHandle;
        use std::os::windows::process::CommandExt;
        if !crate::setup::webview2::bootstrapper_path_ok(self.install.root(), exe) {
            return Err(PlatformError::Refused("not the WebView2 bootstrapper of the install folder"));
        }
        guard()?;
        let actual = self.file_sha256(exe, crate::setup::webview2::MAX_BOOTSTRAPPER_BYTES)?;
        if !actual.is_some_and(|hash| hash.eq_ignore_ascii_case(expected_sha256)) {
            return Err(PlatformError::Refused("the WebView2 bootstrapper is not the pinned file"));
        }
        let job = KillOnCloseJob::new().map_err(map_err)?;
        let child = std::process::Command::new(exe)
            .args(crate::setup::webview2::BOOTSTRAPPER_ARGS)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED)
            .spawn()
            .map_err(io_err)?;
        let mut run = JobRun { child, job };
        let started = run.job.assign(run.child.as_handle()).and_then(|()| job::resume_process(run.child.id()));
        if let Err(error) = started {
            let _ = run.child.kill();
            let _ = run.child.wait();
            return Err(map_err(error));
        }
        let start = std::time::Instant::now();
        loop {
            if let Some(code) = run.try_exit().map_err(io_err)? {
                return Ok(InstallerExit::Code(code));
            }
            if cancel.is_cancelled() {
                run.kill_all();
                return Ok(InstallerExit::Cancelled);
            }
            if start.elapsed() >= timeout {
                run.kill_all();
                return Ok(InstallerExit::TimedOut);
            }
            std::thread::sleep(INSTALLER_POLL);
        }
    }

    fn report_event(&self, kind: EventKind, event_id: u32, message: &str) -> Result<(), PlatformError> {
        guard()?;
        eventwrite::report(eventwrite::SOURCE, kind, event_id, message).map_err(map_err)
    }

    /// (Phase 6 Step 20, plan 4.17) Only `<sha256>.msi` of the agent's own `selfupdate` folder, and only when its SHA-256 is
    /// the verified one right now. The process is **not** put in a kill-on-close job and not waited for: it is detached
    /// (no console, its own process group), so the upgrade goes on when the MSI stops this service. (The install itself
    /// runs inside the Windows Installer service, which is not our child either.) Nothing is read from its output.
    fn start_self_upgrade(&self, msi: &Path, expected_sha256: &str, log: &Path) -> Result<u32, PlatformError> {
        use std::os::windows::process::CommandExt;
        if !crate::selfupdate::upgrade_files_ok(&self.data.selfupdate_dir(), &self.data.logs_dir(), msi, expected_sha256, log) {
            return Err(PlatformError::Refused("not the staged Rulebox MSI"));
        }
        guard()?;
        let Some(root) = system_root() else {
            return Err(PlatformError::Other("the Windows folder is not known".into()));
        };
        // A link on the folder would let the file be swapped under the check below.
        if is_reparse_point(&self.data.selfupdate_dir()).map_err(io_err)? {
            return Err(PlatformError::Refused("the selfupdate folder is a link"));
        }
        let actual = self.file_sha256(msi, crate::selfupdate::MAX_RELEASE_BYTES)?;
        if !actual.is_some_and(|hash| hash.eq_ignore_ascii_case(expected_sha256)) {
            return Err(PlatformError::Refused("the Rulebox MSI is not the verified file"));
        }
        let child = std::process::Command::new(msiexec_path(&root))
            .args(["/i"])
            .arg(msi)
            .args(["/qn", "/norestart", "/l*v"])
            .arg(log)
            .current_dir(self.data.selfupdate_dir())
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP)
            .spawn()
            .map_err(io_err)?;
        let pid = child.id();
        // Dropping a `Child` neither waits for nor ends the process.
        drop(child);
        Ok(pid)
    }

    /// (Phase 6 Step 22 run A2) By the Toolhelp name, never by the image: the old launcher's file was moved by the MSI.
    fn end_stale_launchers(&self, session_id: u32, installed_launcher: &Path, staff_sid: &str) -> Result<Vec<u32>, PlatformError> {
        if !installed_launcher.file_name().is_some_and(|name| name.eq_ignore_ascii_case(LAUNCHER_EXE_NAME)) {
            return Err(PlatformError::Refused("not the launcher's path"));
        }
        guard()?;
        process::end_stale_by_name(session_id, LAUNCHER_EXE_NAME, installed_launcher, &parse_sid(staff_sid)?).map_err(map_err)
    }

    /// (Phase 6 Q-A3) The launcher first (its kill-on-close job ends the Staff App with it), then any Staff App that is left.
    fn end_staff_shell(&self, staff_sid: &str) -> Result<Vec<u32>, PlatformError> {
        guard()?;
        let owner = parse_sid(staff_sid)?;
        let mut ended = Vec::new();
        for session in self.sessions()?.iter().filter(|s| s.user_sid.as_deref().is_some_and(|user| user.eq_ignore_ascii_case(staff_sid))) {
            for name in [LAUNCHER_EXE_NAME, STAFF_APP_EXE_NAME] {
                ended.extend(process::end_all_by_name(session.id, name, &owner).map_err(map_err)?);
            }
        }
        Ok(ended)
    }
}

/// (Phase 6 Q-A3) The Staff App's file name (`versions\<version>\rulebox-staff.exe`), as Toolhelp reports it.
const STAFF_APP_EXE_NAME: &str = "rulebox-staff.exe";

/// (Phase 6 Step 22 run A2) The launcher's file name, as Toolhelp reports it.
const LAUNCHER_EXE_NAME: &str = "rulebox-shell.exe";

// (Phase 5 Step 3) Nothing calls the new seam yet: the layers of Steps 4 to 20 do.
#[allow(dead_code)]
fn reg_data(value: RegValue) -> RegData {
    match value {
        RegValue::Dword(number) => RegData::Dword(number),
        RegValue::String(text) => RegData::String(text),
    }
}

// (Phase 5 Step 3) Nothing calls the new seam yet: the layers of Steps 4 to 20 do.
#[allow(dead_code)]
fn reg_value(data: &RegData) -> RegValue {
    match data {
        RegData::Dword(number) => RegValue::Dword(*number),
        RegData::String(text) => RegValue::String(text.clone()),
    }
}

/// `<profile>`'s `AppData` and `Local`/`Roaming`: shared with the Staff session
/// (held with read and write sharing); the rest of a template's components are
/// the app's own folders.
const SHARED_COMPONENTS: usize = 2;
/// Below a user's hive.
const USER_SHELL_FOLDERS_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders";

/// `CREATE_NO_WINDOW`.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
/// `CREATE_SUSPENDED`: the installer is put in its job before it runs.
const CREATE_SUSPENDED: u32 = 0x0000_0004;
/// (Phase 6 Step 20) `DETACHED_PROCESS` and `CREATE_NEW_PROCESS_GROUP`: the self-upgrade's msiexec has no console and is not
/// in the agent's process group (it also never joins a job: see `start_self_upgrade`).
const DETACHED_PROCESS: u32 = 0x0000_0008;
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
/// How often a running installer (and the agent's stop) is checked.
const INSTALLER_POLL: Duration = Duration::from_millis(500);
/// (Phase 6 Step 14) The most directory entries `find_file_below` looks at.
const FIND_FILE_MAX_ENTRIES: usize = 20_000;
/// After ending the job, how long to wait for its processes to be gone.
const KILL_DRAIN: Duration = Duration::from_secs(10);
/// Where Windows keeps its boot counter (`BootId`, DWORD).
const BOOT_ID_KEY: &str = r"SYSTEM\CurrentControlSet\Control\Session Manager\Memory Management\PrefetchParameters";

/// A started installer in its job (see `run_installer`). Dropping it closes the
/// job, which ends anything still in it.
struct JobRun {
    child: std::process::Child,
    job: KillOnCloseJob,
}

impl RunningInstaller for JobRun {
    fn try_exit(&mut self) -> std::io::Result<Option<i32>> {
        Ok(self.child.try_wait()?.map(|status| status.code().unwrap_or(-1)))
    }

    fn active(&mut self) -> std::io::Result<u32> {
        self.job.active_processes().map_err(std::io::Error::other)
    }

    fn cpu_time(&mut self) -> Option<Duration> {
        self.job.cpu_time().ok()
    }

    fn has_window(&mut self) -> bool {
        self.job.has_visible_window().unwrap_or(false)
    }

    fn kill_all(&mut self) {
        if let Err(error) = self.job.terminate(1) {
            tracing::warn!("cannot end the installer's job ({error}); ending its process");
            let _ = self.child.kill();
        }
        let deadline = std::time::Instant::now() + KILL_DRAIN;
        while self.job.active_processes().is_ok_and(|n| n > 0) && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(100));
        }
        let _ = self.child.try_wait();
    }
}

/// `%SystemRoot%` of the service's environment, when it is an absolute path.
fn system_root() -> Option<PathBuf> {
    std::env::var_os("SystemRoot").map(PathBuf::from).filter(|path| path.is_absolute())
}

/// Fails when one of `paths` is a reparse point (a link or junction).
fn refuse_links(paths: &[&Path]) -> Result<(), PlatformError> {
    for path in paths {
        if is_reparse_point(path).map_err(io_err)? {
            return Err(PlatformError::Other("a folder of the app is a link; refused".into()));
        }
    }
    Ok(())
}

/// Runs the Section 5.1 check and repair on the data directory `root`. Creating
/// or repairing is guarded (test machine only). `Err` means: refuse to start;
/// nothing has been written into the directory.
pub fn ensure_data_dir(root: &Path) -> anyhow::Result<()> {
    let check = security::verify_protected_dir(root).context("check the data directory")?;
    let is_empty = if check.exists && !check.is_reparse_point {
        std::fs::read_dir(root)
            .with_context(|| format!("read {}", root.display()))?
            .next()
            .is_none()
    } else {
        true
    };
    // Every branch that changes the disk checks the guard first, so nothing (not
    // even the removal of an empty folder) happens on a machine that is not armed
    // (a test machine, or an installed production build).
    match data_dir_action(&check, is_empty) {
        DataDirAction::Use => return Ok(()),
        DataDirAction::Refuse(reason) => bail!("the data directory {} is not safe to use: {reason}", root.display()),
        DataDirAction::Create | DataDirAction::FixDacl => {
            require_armed_machine().context("the data directory needs creating or repairing")?;
            security::create_protected_dir(root).context("create or repair the data directory")?;
        }
        DataDirAction::Recreate => {
            require_armed_machine().context("the data directory needs creating or repairing")?;
            std::fs::remove_dir(root)
                .with_context(|| format!("remove the unprotected empty directory {}", root.display()))?;
            security::create_protected_dir(root).context("re-create the data directory")?;
        }
    }
    let again = security::verify_protected_dir(root).context("check the data directory again")?;
    if !again.is_ok() {
        bail!(
            "the data directory {} is still not protected after repair (changed by someone else?)",
            root.display()
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn platform() -> WindowsPlatform {
        WindowsPlatform::new(
            InstallPaths::new(PathBuf::from(r"C:\rulebox-test-no-such-install")),
            DataPaths::new(PathBuf::from(r"C:\rulebox-test-no-such-data")),
        )
    }

    fn on_dev_machine() -> bool {
        !rulebox_win32::guard::is_armed_machine()
    }

    #[test]
    fn os_info_reports_the_real_machine() {
        let os = platform().os_info().unwrap();
        assert!(os.build >= 19045, "{os:?}");
        assert!(os.ram_mb > 0);
        assert!(!os.arch.is_empty());
        assert!(!platform().computer_name().unwrap().is_empty());
    }

    #[test]
    fn find_file_below_walks_a_bounded_tree_read_only() {
        // (Phase 6 Step 14) The per-user probe on a real folder: a name, at most `max_depth` folders down, any case.
        let dir = crate::testutil::TempDir::new();
        let four = dir.path().join("a").join("b").join("c").join("d");
        let six = four.join("e").join("f");
        std::fs::create_dir_all(&six).unwrap();
        std::fs::write(four.join("App.exe"), b"x").unwrap();
        std::fs::write(six.join("deep.exe"), b"x").unwrap();
        std::fs::write(dir.path().join("top.exe"), b"x").unwrap();
        let p = platform();
        assert!(p.find_file_below(dir.path(), "app.exe", 4).unwrap());
        assert!(p.find_file_below(dir.path(), "APP.EXE", 5).unwrap());
        assert!(!p.find_file_below(dir.path(), "app.exe", 3).unwrap(), "one folder too deep");
        assert!(!p.find_file_below(dir.path(), "deep.exe", 4).unwrap());
        assert!(p.find_file_below(dir.path(), "deep.exe", 6).unwrap());
        assert!(p.find_file_below(dir.path(), "top.exe", 0).unwrap());
        // Folders are not files; a missing root and a name with a separator are plain `false`.
        assert!(!p.find_file_below(dir.path(), "a", 4).unwrap());
        assert!(!p.find_file_below(&dir.path().join("missing"), "app.exe", 4).unwrap());
        for bad in ["", r"a\App.exe", "a/App.exe", "App.exe:stream"] {
            assert!(!p.find_file_below(dir.path(), bad, 6).unwrap(), "{bad:?}");
        }
    }

    #[test]
    fn the_staff_account_does_not_exist_on_the_dev_machine() {
        // Plan test 2: if this fails, stop and tell the user.
        assert!(platform().find_local_user("RuleboxStaff").unwrap().is_none());
    }

    #[test]
    fn a_machine_write_outside_the_list_is_refused_before_the_guard() {
        let key = RegValueRef {
            path: r"SOFTWARE\Microsoft\Windows\CurrentVersion\Run".into(),
            name: "Rulebox".into(),
        };
        match platform().write_machine_value(&key, Some(&RegData::String("x".into()))) {
            Err(PlatformError::Other(message)) => assert!(message.contains("not one Rulebox writes"), "{message}"),
            other => panic!("expected a list refusal, got {other:?}"),
        }
        let userinit = RegValueRef { path: WINLOGON_KEY.into(), name: "Userinit".into() };
        assert!(matches!(platform().write_machine_value(&userinit, None), Err(PlatformError::Other(_))));
    }

    #[test]
    fn every_mutating_method_is_blocked_by_the_guard_on_the_dev_machine() {
        if !on_dev_machine() {
            return;
        }
        let p = platform();
        let sid = "S-1-5-21-1-2-3-1001";
        let spec = StaffUserSpec { user_name: "RuleboxStaff".into(), full_name: "Staff".into(), comment: "c".into() };
        let key = RegValueRef { path: WINLOGON_KEY.into(), name: "AutoAdminLogon".into() };
        let exe = Path::new(r"C:\rulebox-test-no-such\x.exe");

        fn blocked<T: std::fmt::Debug>(name: &str, result: Result<T, PlatformError>) {
            assert!(matches!(result, Err(PlatformError::Guard(_))), "{name}: {result:?}");
        }
        blocked("create_staff_user", p.create_staff_user(&spec, "pw"));
        blocked("set_user_password", p.set_user_password("RuleboxStaff", "pw"));
        blocked("test_logon", p.test_logon("RuleboxStaff", "pw"));
        blocked("ensure_profile", p.ensure_profile(sid, "RuleboxStaff"));
        blocked("delete_staff_user", p.delete_staff_user(sid, "RuleboxStaff"));
        blocked("write_machine_value", p.write_machine_value(&key, Some(&RegData::String("1".into()))));
        blocked("lsa_secret_get", p.lsa_secret_get("DefaultPassword"));
        blocked("lsa_secret_set", p.lsa_secret_set("DefaultPassword", Some("x")));
        blocked("set_staff_shell", p.set_staff_shell(sid, ShellMechanism::PolicyShell, Some("x")));
        blocked("set_staff_user_policy", p.set_staff_user_policy(sid, "DisableLockWorkstation", Some(1)));
        blocked("logoff_session", p.logoff_session(1));
        blocked("launch_in_session", p.launch_in_session(1, sid, exe));
        blocked("terminate_process", p.terminate_process(1, exe, sid));
        blocked("end_stale_launchers", p.end_stale_launchers(1, Path::new(r"C:\rulebox-test-no-such\rulebox-shell.exe"), sid));
        blocked("end_staff_shell", p.end_staff_shell(sid));
        blocked("secrets_save", p.secrets_save(b"x"));

        // (Step 14) An installer the rule allows still meets the guard first.
        let downloads = DataPaths::new(PathBuf::from(r"C:\rulebox-test-no-such-data")).downloads_dir();
        let cmd = InstallerCommand {
            program: downloads.join(format!("{}.exe", "a".repeat(64))),
            args: vec!["/S".into()],
            working_dir: downloads.clone(),
            expected_exe: None,
            removal: false,
        };
        blocked("run_installer", p.run_installer(&cmd, Duration::from_secs(1), &CancellationToken::new()));
        let apps = Path::new(r"C:\rulebox-test-no-such-install\apps");
        blocked("place_portable", p.place_portable(exe, &apps.join(r"app1\tool.exe")));
        blocked("remove_portable", p.remove_portable(&apps.join("app1")));
        // (Step 16) A template the rules allow, below a profile that does not exist.
        let never = CancellationToken::new();
        blocked(
            "reset_folder",
            p.reset_folder(Path::new(r"C:\rulebox-test-no-such-profile"), r"{LocalAppData}\Acme", &never),
        );

        // (Phase 5 Step 3) Every new mutating method, with arguments that pass its own
        // rule check, so the guard is what stops it.
        let staff_key = r"Software\Microsoft\Windows\CurrentVersion\Policies\System";
        let policy = "8a6eb3cd-ba2e-4a97-a1f9-4f4a3b1c0001";
        let wlan_xml = "<WLANProfile><name>Rulebox-ab12</name></WLANProfile>";
        let spec = PrinterSpec { name: "Front (Rulebox)".into(), port: "IP_1".into(), driver: "Driver".into(), comment: String::new() };
        blocked("write_staff_value", p.write_staff_value(sid, staff_key, "NoRun", &RegData::Dword(1)));
        blocked("delete_staff_value", p.delete_staff_value(sid, staff_key, "NoRun"));
        blocked("delete_staff_key_if_empty", p.delete_staff_key_if_empty(sid, r"Software\Policies\Microsoft\Edge"));
        blocked("deploy_ci_policy", p.deploy_ci_policy(policy, b"cip"));
        blocked("remove_ci_policy", p.remove_ci_policy(policy));
        blocked("refresh_ci_policies", p.refresh_ci_policies());
        blocked("set_applocker_policy", p.set_applocker_policy("<AppLockerPolicy/>", AppLockerMechanism::Local));
        blocked("clear_applocker_policy", p.clear_applocker_policy(AppLockerMechanism::Csp));
        blocked("set_service_start", p.set_service_start("Spooler", 4));
        blocked("set_service_security", p.set_service_security("RuleboxAgent", service::AGENT_SERVICE_SDDL));
        blocked("set_service_required_privileges", p.set_service_required_privileges("RuleboxAgent", &[]));
        blocked("set_account_lockout", p.set_account_lockout(LockoutPolicy { threshold: 5, duration_s: 900, window_s: 900 }));
        blocked("wlan_set_profile", p.wlan_set_profile(wlan_xml));
        blocked("wlan_delete_profile", p.wlan_delete_profile("Rulebox-ab12"));
        blocked("wlan_set_filters", p.wlan_set_filters(&["Acme"]));
        blocked("printer_add", p.printer_add(&spec));
        blocked("printer_delete", p.printer_delete("Front (Rulebox)"));
        blocked("printer_set_security", p.printer_set_security("Microsoft Print to PDF", "D:P(A;;GA;;;SY)"));
        let port = PortSpec { name: "Rulebox_k7".into(), protocol: crate::platform::PortProtocol::RawTcp, host: "10.0.0.20".into(), number: 9100, queue: String::new() };
        blocked("printer_port_add", p.printer_port_add(&port));
        blocked("printer_port_delete", p.printer_port_delete("Rulebox_k7"));
        blocked("driver_package_delete", p.driver_package_delete("oem12.inf"));
        // (Phase 6 Step 15) The spooler's printer drivers and the TrustedPublisher store.
        blocked("printer_driver_install", p.printer_driver_install("BIXOLON SRP-350III"));
        blocked("printer_driver_delete", p.printer_driver_delete("BIXOLON SRP-350III"));
        blocked("trusted_publisher_add", p.trusted_publisher_add(&[0x30; 100]));
        blocked("trusted_publisher_remove", p.trusted_publisher_remove(&"ab".repeat(20)));
        assert!(matches!(p.driver_package_models("netcfg.inf"), Err(PlatformError::Refused(_))), "only a published name is read");
        assert_eq!(p.driver_package_models("oem99999.inf").unwrap_or_default().len(), 0, "no such package: nothing");
        assert!(p.trusted_publisher_has(&"00".repeat(20)).is_ok_and(|has| !has));
        blocked("printer_share_connect", p.printer_share_connect(r"\\print01\hp"));
        blocked("printer_share_disconnect", p.printer_share_disconnect(r"\\print01\hp"));
        blocked("bcd_set", p.bcd_set("{current}", "recoveryenabled", "No"));
        blocked("remove_safe_boot_entry", p.remove_safe_boot_entry("Minimal"));
        blocked("start_process_trace", p.start_process_trace(Box::new(|_| {})));
        blocked("stop_process_trace", p.stop_process_trace(TraceHandle(1)));
        blocked(
            "set_path_acl",
            p.set_path_acl(&InstallPaths::new(PathBuf::from(r"C:\rulebox-test-no-such-install")).root().join("x"), "D:P(A;;GA;;;SY)"),
        );
    }

    /// (Phase 5 Step 3, plan 4.5 rule 2) A value outside an allow-list is refused before
    /// the guard, on every machine, and nothing is touched.
    #[test]
    fn writes_outside_the_allow_lists_are_refused_before_the_guard() {
        let p = platform();
        let sid = "S-1-5-21-1-2-3-1001";
        let other = |result: Result<(), PlatformError>, needle: &str| match result {
            Err(PlatformError::Other(message)) => assert!(message.contains(needle), "{message}"),
            other => panic!("expected a list refusal, got {other:?}"),
        };
        // Machine keys: the Run key, a service key, the Safe Mode root itself.
        for path in [
            r"SOFTWARE\Microsoft\Windows\CurrentVersion\Run",
            r"SYSTEM\CurrentControlSet\Services\RuleboxAgent",
            r"SYSTEM\CurrentControlSet\Control\SafeBoot\Minimal",
            r"SOFTWARE\Policies\Microsoft\Windows\DeviceInstall\Settings",
        ] {
            let key = RegValueRef { path: path.into(), name: "X".into() };
            other(p.write_machine_value(&key, Some(&RegData::Dword(1))), "not one Rulebox writes");
        }
        // Inside the roots the guard is next (device installation restrictions, Safe Mode).
        let guarded = |path: &str, name: &str| {
            let key = RegValueRef { path: path.into(), name: name.into() };
            p.write_machine_value(&key, Some(&RegData::Dword(1)))
        };
        if on_dev_machine() {
            for (path, name) in [
                (r"SOFTWARE\Policies\Microsoft\Windows\DeviceInstall\Restrictions", "DenyDeviceClasses"),
                (r"SOFTWARE\Policies\Microsoft\Windows\DeviceInstall\Restrictions\DenyDeviceClasses", "1"),
                (r"SYSTEM\CurrentControlSet\Control\SafeBoot\Minimal\RuleboxAgent", ""),
                (r"SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System", "HideFastUserSwitching"),
            ] {
                assert!(matches!(guarded(path, name), Err(PlatformError::Guard(_))), "{path}");
            }
        }
        // Staff keys and the shell value.
        other(p.write_staff_value(sid, r"Software\Classes", "X", &RegData::Dword(1)), "not one Rulebox writes");
        other(p.delete_staff_value(sid, r"Software\Microsoft\Windows\CurrentVersion\RunOnce", "X"), "not one Rulebox writes");
        // (Phase 6 Step 17) Only the browser policy keys can be removed, never another Staff root.
        other(
            p.delete_staff_key_if_empty(sid, r"Software\Microsoft\Windows\CurrentVersion\Policies\System").map(|_| ()),
            "not one Rulebox writes",
        );
        other(
            p.write_staff_value(sid, r"Software\Microsoft\Windows\CurrentVersion\Policies\System", "Shell", &RegData::String("x".into())),
            "set_user_shell",
        );
        // The other rules.
        other(p.deploy_ci_policy("not-a-guid", b"x"), "GUID");
        other(p.set_service_start("RuleboxAgent", 4), "automatically");
        other(p.set_service_security("Spooler", "D:"), "agent service");
        // (Step 17) Refused before the guard: Administrators locked out, no SeChangeNotifyPrivilege.
        other(p.set_service_security("RuleboxAgent", "D:P(A;;GA;;;SY)"), "Administrators");
        other(p.set_service_required_privileges("RuleboxAgent", &["SeTcbPrivilege"]), "would not start");
        other(p.wlan_set_profile("<WLANProfile><name>Home</name></WLANProfile>"), "Rulebox");
        other(p.wlan_delete_profile("Home"), "Rulebox");
        other(p.printer_delete("Microsoft Print to PDF"), "Rulebox made");
        other(p.printer_port_delete("IP_10.0.0.20"), "port Rulebox made");
        other(p.printer_share_connect("print01\\hp"), "printer share name");
        other(p.bcd_set("{bootmgr}", "displayorder", "x"), "not one Rulebox changes");
        other(p.remove_safe_boot_entry("Option"), "not one Rulebox writes");
        assert!(matches!(
            p.set_path_acl(Path::new(r"C:\Windows"), "D:P(A;;GA;;;SY)"),
            Err(PlatformError::Refused(_))
        ));
        assert!(matches!(
            p.set_path_acl(Path::new(r"C:\rulebox-test-no-such-install\..\Windows"), "D:P(A;;GA;;;SY)"),
            Err(PlatformError::Refused(_))
        ));
    }

    /// (Phase 5 Step 3) The read-only methods answer on the dev machine and change
    /// nothing. `#[ignore]`d: they read the real registry, service manager, spooler,
    /// WLAN service and event log, so the user runs them by hand.
    #[test]
    #[ignore = "reads the real machine (services, spooler, WLAN, event log); run by hand"]
    fn smoke_read_only_seam_methods() {
        let p = platform();
        println!("posture: {:?}", p.read_security_posture().unwrap());
        println!("ci policies: {:?}", p.list_ci_policies().unwrap());
        println!("applocker: {:?}", p.get_applocker_policy().unwrap());
        println!("wlan: {:?}", p.wlan_list().unwrap());
        println!("printers: {:?}", p.printer_list().unwrap());
        println!("lockout: {:?}", p.get_account_lockout().unwrap());
        println!("event log: {}", p.read_event_log("Microsoft-Windows-CodeIntegrity/Operational", 0, 5).unwrap().len());
        assert!(p.query_service("EventLog").unwrap().is_some());
        assert!(p.query_service("RuleboxNoSuchService").unwrap().is_none());
        assert!(p.get_service_security("EventLog").unwrap().is_some());
        assert!(p.get_path_acl(Path::new(&std::env::var("SystemRoot").unwrap())).unwrap().is_some());
        assert!(!p.list_machine_value_names(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion").unwrap().is_empty());
        // (Step 5) The BCD reader runs `bcdedit /enum {current}` (read-only).
        println!("recoveryenabled: {:?}", p.bcd_get("{current}", "recoveryenabled"));
        println!("local admins: {:?}", p.enabled_local_admin_accounts().unwrap());
    }

    #[test]
    fn reset_folder_refuses_bad_templates_before_the_guard() {
        // Refused on every machine, before the guard and before any file is opened.
        let p = platform();
        let never = CancellationToken::new();
        let profile = Path::new(r"C:\rulebox-test-no-such-profile");
        for template in [
            r"{LocalAppData}\..\..",
            r"C:\Windows",
            r"{SystemRoot}\System32",
            r"{LocalAppData}\",
            // (Review) The deny list.
            r"{RoamingAppData}\Microsoft\Protect",
            r"{LocalAppData}\dev.rulebox.staff",
        ] {
            assert!(matches!(p.reset_folder(profile, template, &never), Err(PlatformError::Refused(_))), "{template}");
        }
        assert!(matches!(
            p.reset_folder(Path::new(r"rulebox-test\relative"), r"{LocalAppData}\Acme", &never),
            Err(PlatformError::Refused(_))
        ));
    }

    #[test]
    fn staff_profile_reads_are_read_only_and_answer_on_the_dev_machine() {
        // An account that does not exist has no profile; its hive is not loaded.
        let p = platform();
        let sid = "S-1-5-21-1-2-3-999999";
        assert_eq!(p.staff_profile_dir(sid).unwrap(), None);
        assert_eq!(p.staff_app_data_redirected(sid, Path::new(r"C:\Users\x")).unwrap(), None);
        // The current user's own hive is loaded: it answers (redirected or not).
        let me = rulebox_win32::sid::current_user_sid().unwrap();
        let profile = p.staff_profile_dir(me.as_str()).unwrap().unwrap();
        assert!(p.staff_app_data_redirected(me.as_str(), &profile).unwrap().is_some());
    }

    #[test]
    fn program_outside_downloads_refused_before_the_guard() {
        // Refused on every machine, before anything else is looked at.
        let p = platform();
        let downloads = DataPaths::new(PathBuf::from(r"C:\rulebox-test-no-such-data")).downloads_dir();
        for program in [
            PathBuf::from(r"C:\Windows\System32\cmd.exe"),
            PathBuf::from(r"C:\Users\Public\setup.exe"),
            downloads.join("setup.exe"),
            downloads.join(r"..\x.exe"),
        ] {
            let cmd = InstallerCommand {
                program,
                args: Vec::new(),
                working_dir: downloads.clone(),
                expected_exe: None,
                removal: false,
            };
            match p.run_installer(&cmd, Duration::from_secs(1), &CancellationToken::new()) {
                Err(PlatformError::Other(message)) => assert_eq!(message, "program not allowed"),
                other => panic!("expected a refusal, got {other:?}"),
            }
        }
        // (Step 14b) pnputil only with its two fixed command lines: any other arguments are refused first.
        let pnputil = crate::installs::pnputil_path(&system_root().unwrap());
        for args in [vec!["/delete-driver", "*", "/uninstall"], vec!["/enum-drivers"], vec!["/add-driver", "*.inf", "/install"]] {
            let cmd = InstallerCommand {
                program: pnputil.clone(),
                args: args.iter().map(|a| (*a).to_string()).collect(),
                working_dir: downloads.clone(),
                expected_exe: None,
                removal: false,
            };
            match p.run_installer(&cmd, Duration::from_secs(1), &CancellationToken::new()) {
                Err(PlatformError::Other(message)) => assert_eq!(message, "program not allowed", "{args:?}"),
                other => panic!("expected a refusal, got {other:?}"),
            }
        }
        assert!(matches!(p.driver_package_delete(r"..\x.inf"), Err(PlatformError::Refused(_))));
        assert!(matches!(p.driver_package_delete("*"), Err(PlatformError::Refused(_))));
        assert!(matches!(p.driver_package_delete("netcfg.inf"), Err(PlatformError::Refused(_))));
        let outside = Path::new(r"C:\rulebox-test-no-such-install\rulebox-agent.exe");
        assert!(matches!(p.place_portable(outside, outside), Err(PlatformError::Other(_))));
        assert!(matches!(p.remove_portable(Path::new(r"C:\rulebox-test-no-such-install")), Err(PlatformError::Other(_))));
    }

    #[test]
    fn the_driver_store_is_listed_read_only_with_published_names_only() {
        let names = platform().driver_store_infs().unwrap();
        assert!(names.iter().all(|name| is_published_inf(name) && *name == name.to_ascii_lowercase()), "{names:?}");
        let mut sorted = names.clone();
        sorted.sort();
        assert_eq!(names, sorted);
    }

    #[test]
    fn disk_and_boot_time_are_readable() {
        assert!(platform().disk_free_bytes().unwrap() > 0);
        let boot = platform().boot_identity().unwrap();
        assert!(boot.boot_time_ms > 1_600_000_000_000 && boot.uptime_ms > 0, "{boot:?}");
        // Windows keeps a boot counter on every supported build (read, not written).
        assert!(boot.boot_id.is_some(), "{boot:?}");
        assert_eq!(platform().boot_identity().unwrap().boot_id, boot.boot_id, "the same boot");
    }

    #[test]
    fn missing_secrets_file_loads_as_none() {
        assert_eq!(platform().secrets_load().unwrap(), None);
    }

    #[test]
    fn dpapi_round_trips_on_the_dev_machine() {
        let blob = dpapi::protect(b"abc").unwrap();
        assert_eq!(dpapi::unprotect(&blob).unwrap(), b"abc");
    }

    #[test]
    fn shell_binaries_are_missing_in_a_folder_that_does_not_exist() {
        assert_eq!(
            platform().shell_binaries_ok().unwrap(),
            ShellBinaries { launcher_ok: false, staff_app_ok: false }
        );
    }

    #[test]
    fn current_json_must_stay_inside_versions() {
        let root = Path::new(r"C:\Program Files\Rulebox");
        let good = r#"{"version":"1","exe":"versions\\1.0.0\\rulebox-staff.exe"}"#;
        assert_eq!(
            staff_app_exe(root, good).unwrap(),
            root.join(r"versions\1.0.0\rulebox-staff.exe")
        );
        let forward = r#"{"exe":"Versions/1.0.0/rulebox-staff.exe"}"#;
        assert!(staff_app_exe(root, forward).is_some());
        for bad in [
            r#"{"exe":"C:\\Windows\\System32\\cmd.exe"}"#,
            r#"{"exe":"\\Windows\\System32\\cmd.exe"}"#,
            r#"{"exe":"versions\\..\\..\\cmd.exe"}"#,
            r#"{"exe":"other\\1.0.0\\rulebox-staff.exe"}"#,
            r#"{"exe":"versions"}"#,
            r#"{"exe":"versions\\1.0.0\\a.exe:stream"}"#,
            r#"{"exe":"versions\\*\\a.exe"}"#,
            r#"{"exe":""}"#,
            "not json",
        ] {
            assert!(staff_app_exe(root, bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn data_dir_creation_is_refused_on_the_dev_machine_and_creates_nothing() {
        if !on_dev_machine() {
            return;
        }
        let root = std::env::temp_dir().join(format!("rulebox-datadir-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let error = ensure_data_dir(&root).unwrap_err();
        assert!(format!("{error:#}").contains("test-machine guard"), "{error:#}");
        assert!(!root.exists(), "nothing may be created");
    }

    #[test]
    fn an_unprotected_temp_directory_is_not_trusted() {
        if !on_dev_machine() {
            return;
        }
        let root = std::env::temp_dir().join(format!("rulebox-datadir-owned-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        // Empty, with an inherited DACL: it is repaired or re-created (depending on
        // whether Windows made the current user or the Administrators group its
        // owner, which depends on elevation), which the guard blocks here.
        let check = security::verify_protected_dir(&root).unwrap();
        assert!(!check.is_ok());
        assert!(matches!(
            data_dir_action(&check, true),
            DataDirAction::Recreate | DataDirAction::FixDacl
        ));
        assert!(ensure_data_dir(&root).is_err());
        assert!(root.exists(), "the guard must leave the directory alone");
        std::fs::remove_dir_all(&root).unwrap();
    }
}
