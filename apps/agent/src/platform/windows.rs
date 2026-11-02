//! `WindowsPlatform`: the real `Platform`, a thin map onto `rulebox-win32`
//! (plan Section 5.3, Step 10). It holds no logic of its own beyond three rules:
//!
//! - every mutating method checks the test-machine guard **first**, before any
//!   lookup, so the dev machine can never reach a half-way change;
//! - machine writes are limited to the short list in
//!   `rulebox_win32::autologon::set_machine_value`, checked before the guard;
//! - the secrets file is protected with DPAPI under the service's own key.

use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{bail, Context};
use rulebox_win32::accounts;
use rulebox_win32::autologon::set_machine_value;
use rulebox_win32::guard::require_test_machine;
use rulebox_win32::registry::{get_hklm, RegValue};
use rulebox_win32::shellreg::{self, Mechanism};
use rulebox_win32::sid::Sid;
use rulebox_win32::job::{self, KillOnCloseJob};
use rulebox_win32::{dpapi, lsa, osinfo, process, security, session, Win32Error};
use serde::Deserialize;
use tokio_util::sync::CancellationToken;

use super::{
    BootIdentity, InstallerCommand, InstallerExit, LocalUser, OsInfo, Platform, PlatformError, RegData, RegValueRef,
    SessionInfo, SessionState, ShellBinaries, ShellMechanism, StaffUserSpec,
};
use crate::installs::{
    installer_program_allowed, is_in_use, is_reparse_point, portable_dir_ok, portable_target_ok, wait_for_installer,
    InstallerWait, RunTemp, RunningInstaller, INSTALLER_TAIL_GRACE,
};
use crate::paths::{data_dir_action, DataDirAction, DataPaths, InstallPaths};
use crate::state::write_atomic;

const WINLOGON_KEY: &str = rulebox_win32::autologon::WINLOGON_KEY;
const POLICIES_SYSTEM_KEY: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System";

pub struct WindowsPlatform {
    install: InstallPaths,
    data: DataPaths,
}

impl WindowsPlatform {
    pub fn new(install: InstallPaths, data: DataPaths) -> Self {
        Self { install, data }
    }
}

fn map_err(error: Win32Error) -> PlatformError {
    match error {
        Win32Error::Guard(message) => PlatformError::Guard(message),
        Win32Error::AlreadyExists => PlatformError::AlreadyExists,
        Win32Error::NotFound => PlatformError::NotFound,
        Win32Error::PasswordPolicy => PlatformError::PasswordPolicy,
        Win32Error::Api { code: 5, .. } => PlatformError::AccessDenied,
        Win32Error::Api { api, code } => PlatformError::Win32 { api, code },
        Win32Error::Nt { api, status } => PlatformError::Win32 { api, code: status as u32 },
        Win32Error::Busy => PlatformError::Other("busy".into()),
        Win32Error::Invalid(message) => PlatformError::Other(message),
    }
}

/// The test-machine guard, as a `PlatformError`.
fn guard() -> Result<(), PlatformError> {
    require_test_machine().map_err(map_err)
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
        // The list check comes first (and fails without touching anything); the
        // guard is applied inside `set_machine_value`.
        set_machine_value(&key.path, &key.name, value.as_ref()).map_err(map_err)
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
        if !installer_program_allowed(&cmd.program, system_root.as_deref(), &self.data.downloads_dir()) {
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
        let child = std::process::Command::new(&cmd.program)
            .args(&cmd.args)
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
}

/// `CREATE_NO_WINDOW`.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
/// `CREATE_SUSPENDED`: the installer is put in its job before it runs.
const CREATE_SUSPENDED: u32 = 0x0000_0004;
/// How often a running installer (and the agent's stop) is checked.
const INSTALLER_POLL: Duration = Duration::from_millis(500);
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
    // even the removal of an empty folder) happens on a machine that is not a test
    // machine.
    match data_dir_action(&check, is_empty) {
        DataDirAction::Use => return Ok(()),
        DataDirAction::Refuse(reason) => bail!("the data directory {} is not safe to use: {reason}", root.display()),
        DataDirAction::Create | DataDirAction::FixDacl => {
            require_test_machine().context("the data directory needs creating or repairing")?;
            security::create_protected_dir(root).context("create or repair the data directory")?;
        }
        DataDirAction::Recreate => {
            require_test_machine().context("the data directory needs creating or repairing")?;
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
        !rulebox_win32::guard::is_test_machine()
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
        let outside = Path::new(r"C:\rulebox-test-no-such-install\rulebox-agent.exe");
        assert!(matches!(p.place_portable(outside, outside), Err(PlatformError::Other(_))));
        assert!(matches!(p.remove_portable(Path::new(r"C:\rulebox-test-no-such-install")), Err(PlatformError::Other(_))));
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
