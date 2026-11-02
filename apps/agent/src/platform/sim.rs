//! `SimPlatform`: the whole machine in memory, for tests and `--simulate`.
//! It holds no real secrets: `secrets_*` keep plaintext in a file under the
//! data directory.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};

use std::time::Duration;

use tokio_util::sync::CancellationToken;

use super::{
    BootIdentity, InstallerCommand, InstallerExit, LocalUser, OsInfo, Platform, PlatformError, RegData, RegValueRef,
    ResetOutcome, SessionInfo, ShellBinaries, ShellMechanism, StaffUserSpec,
};
use crate::cleanup::resolve_reset;
use crate::installs::{
    installer_program_allowed, portable_dir_ok, portable_target_ok, MSI_REBOOT_INITIATED, MSI_REBOOT_REQUIRED,
    MSI_SUCCESS, MSI_UNKNOWN_PRODUCT,
};
use crate::state::write_atomic;

/// Operations a test can make fail with `SimPlatform::fail_next`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SimOp {
    OsInfo,
    ComputerName,
    OtherEnabledLocalAdmins,
    LegalNoticePresent,
    FindLocalUser,
    ReadMachineValue,
    Sessions,
    FindProcesses,
    ShellBinariesOk,
    CreateStaffUser,
    SetUserPassword,
    TestLogon,
    EnsureProfile,
    DeleteStaffUser,
    WriteMachineValue,
    LsaSecretGet,
    LsaSecretSet,
    SetStaffShell,
    SetStaffUserPolicy,
    LogoffSession,
    LaunchInSession,
    TerminateProcess,
    SecretsLoad,
    SecretsSave,
    DiskFreeBytes,
    BootTimeMs,
    RunInstaller,
    PlacePortable,
    RemovePortable,
    ResetFolder,
    StaffProfileDir,
    AppDataRedirected,
}

impl SimOp {
    /// The calls of the `mutating` group of plan Section 5.3 (`test_logon` is in it:
    /// it is a sign-in attempt that counts towards the account lockout).
    #[cfg(test)]
    pub fn is_mutating(self) -> bool {
        !matches!(
            self,
            SimOp::OsInfo
                | SimOp::ComputerName
                | SimOp::OtherEnabledLocalAdmins
                | SimOp::LegalNoticePresent
                | SimOp::FindLocalUser
                | SimOp::ReadMachineValue
                | SimOp::Sessions
                | SimOp::FindProcesses
                | SimOp::ShellBinariesOk
                | SimOp::LsaSecretGet
                | SimOp::SecretsLoad
                | SimOp::DiskFreeBytes
                | SimOp::BootTimeMs
                | SimOp::StaffProfileDir
                | SimOp::AppDataRedirected
        )
    }
}

#[derive(Debug, Clone)]
pub struct SimUser {
    pub sid: String,
    pub comment: String,
    pub disabled: bool,
    pub password: String,
}

#[derive(Debug, Clone)]
pub struct SimProcess {
    pub pid: u32,
    pub session_id: u32,
    pub image: PathBuf,
    pub user_sid: String,
}

/// Everything the simulated machine contains. Tests may read and edit it with
/// `SimPlatform::with_world`.
#[derive(Debug)]
pub struct SimWorld {
    pub os: OsInfo,
    pub computer_name: String,
    /// SIDs of other enabled local administrators.
    pub admins: Vec<String>,
    pub legal_notice: bool,
    pub shell_binaries: ShellBinaries,
    pub users: HashMap<String, SimUser>,
    pub machine_values: HashMap<RegValueRef, RegData>,
    pub lsa_secrets: HashMap<String, String>,
    pub sessions: Vec<SessionInfo>,
    pub processes: Vec<SimProcess>,
    /// Staff hive: shell command per SID.
    pub staff_shell: HashMap<String, (ShellMechanism, Option<String>)>,
    /// Staff hive: policy DWORDs per (SID, name).
    pub staff_policies: HashMap<(String, String), u32>,
    /// (Step 13) Files that exist on the simulated machine (`file_exists`).
    pub files: std::collections::HashSet<PathBuf>,
    /// (Step 14) Free bytes on the system drive.
    pub disk_free_bytes: u64,
    /// (Step 14) When the simulated PC started (Unix ms; only for old records).
    pub boot_time_ms: u64,
    /// (Step 14 review) The simulated boot counter (`None`: not readable) and
    /// milliseconds since the boot.
    pub boot_id: Option<u32>,
    pub uptime_ms: u64,
    /// (Step 14 review) The next installer runs until the agent stops (`Cancelled`).
    pub installer_hangs: bool,
    /// (Step 14) The exits of the next installer runs (default `Code(0)`).
    pub installer_exits: VecDeque<InstallerExit>,
    /// (Step 14) Whether a successful install creates its program (false: the
    /// installer "succeeds" without putting the exe where the catalogue says).
    pub installer_creates_exe: bool,
    /// (Step 14) Every installer run, in order (nothing is ever executed).
    pub installer_runs: Vec<InstallerCommand>,
    /// (Step 14, tests) At each run, try to open the installer file for writing
    /// and record whether that was refused (the engine must hold it locked).
    pub probe_lock: bool,
    pub lock_probes: Vec<bool>,
    /// (Step 16) Folders that exist (a folder also exists when a file or folder
    /// below it does).
    pub dirs: std::collections::HashSet<PathBuf>,
    /// (Step 16) Paths that are reparse points (junctions, links). Their targets are
    /// not modelled: deleting one removes only the link.
    pub reparse_points: std::collections::HashSet<PathBuf>,
    /// (Step 16) Files another process holds open: a reset cannot delete them.
    pub open_files: std::collections::HashSet<PathBuf>,
    /// (Step 16 review) `ProfileList` per SID (`staff_profile_dir`); `ensure_profile`
    /// fills it.
    pub profile_dirs: HashMap<String, PathBuf>,
    /// (Step 16 review) What `staff_app_data_redirected` answers.
    pub app_data_redirected: Option<bool>,
    /// (Step 16 review) A reset of this template blocks (an oplock, a huge tree)
    /// until released (or cancelled, when it honours cancellation).
    pub reset_hang: Option<SimHang>,
    next_rid: u32,
    next_pid: u32,
}

impl SimWorld {
    fn new() -> Self {
        Self {
            os: OsInfo {
                build: 26100,
                ubr: 0,
                display_version: "24H2".into(),
                edition_id: "Professional".into(),
                product_type: 1,
                arch: "x86_64".into(),
                s_mode: false,
                domain_joined: false,
                entra_joined: false,
                ram_mb: 8192,
                system_disk_free_gb: 100,
            },
            computer_name: "SIM-PC".into(),
            admins: vec!["S-1-5-21-1000-2000-3000-1001".into()],
            legal_notice: false,
            shell_binaries: ShellBinaries { launcher_ok: true, staff_app_ok: true },
            users: HashMap::new(),
            machine_values: HashMap::new(),
            lsa_secrets: HashMap::new(),
            sessions: Vec::new(),
            processes: Vec::new(),
            staff_shell: HashMap::new(),
            staff_policies: HashMap::new(),
            files: std::collections::HashSet::new(),
            disk_free_bytes: 100 * 1024 * 1024 * 1024,
            boot_time_ms: 1_700_000_000_000,
            boot_id: Some(100),
            uptime_ms: 3_600_000,
            installer_hangs: false,
            installer_exits: VecDeque::new(),
            installer_creates_exe: true,
            installer_runs: Vec::new(),
            probe_lock: false,
            lock_probes: Vec::new(),
            dirs: std::collections::HashSet::new(),
            reparse_points: std::collections::HashSet::new(),
            open_files: std::collections::HashSet::new(),
            profile_dirs: HashMap::new(),
            app_data_redirected: Some(false),
            reset_hang: None,
            next_rid: 2000,
            next_pid: 4000,
        }
    }
}

/// (Step 16 review) A reset that blocks: see [`SimWorld::reset_hang`].
#[derive(Debug, Clone)]
pub struct SimHang {
    pub template: String,
    /// True: a cancel stops it (`InUse`). False: only `release` does (a call stuck
    /// in the kernel).
    pub honours_cancel: bool,
    pub release: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

pub struct SimPlatform {
    world: Mutex<SimWorld>,
    /// Per operation, one entry per upcoming call: `Some` fails it, `None` lets it
    /// through (used by `fail_nth` to skip calls).
    failures: Mutex<HashMap<SimOp, VecDeque<Option<PlatformError>>>>,
    data_dir: PathBuf,
    /// Every operation in the order it was called (tests only).
    #[cfg(test)]
    calls: Mutex<Vec<SimOp>>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

impl SimPlatform {
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            world: Mutex::new(SimWorld::new()),
            failures: Mutex::new(HashMap::new()),
            data_dir,
            #[cfg(test)]
            calls: Mutex::new(Vec::new()),
        }
    }

    /// The operations called so far, oldest first (tests only).
    #[cfg(test)]
    pub fn calls(&self) -> Vec<SimOp> {
        lock(&self.calls).clone()
    }

    /// The next call of `op` returns `err` (queued: one error per call).
    #[cfg(test)]
    pub fn fail_next(&self, op: SimOp, err: PlatformError) {
        lock(&self.failures).entry(op).or_default().push_back(Some(err));
    }

    /// The call of `op` that comes after `skip` more calls of it fails (`skip` 0 is
    /// the same as `fail_next`). Counted from the calls still to come.
    #[cfg(test)]
    pub fn fail_nth(&self, op: SimOp, skip: usize, err: PlatformError) {
        let mut failures = lock(&self.failures);
        let queue = failures.entry(op).or_default();
        queue.extend(std::iter::repeat_with(|| None).take(skip));
        queue.push_back(Some(err));
    }

    /// Reads or edits the simulated machine.
    #[cfg(test)]
    pub fn with_world<R>(&self, f: impl FnOnce(&mut SimWorld) -> R) -> R {
        f(&mut lock(&self.world))
    }

    fn check(&self, op: SimOp) -> Result<(), PlatformError> {
        #[cfg(test)]
        lock(&self.calls).push(op);
        match lock(&self.failures).get_mut(&op).and_then(VecDeque::pop_front) {
            Some(Some(err)) => Err(err),
            Some(None) | None => Ok(()),
        }
    }

    fn secrets_path(&self) -> PathBuf {
        self.data_dir.join("sim-secrets.json")
    }
}

/// The roots `SimPlatform` expands templates to (a pretend Windows layout).
pub fn sim_path_roots() -> rulebox_policy::paths::PathRoots {
    rulebox_policy::paths::PathRoots {
        program_files: r"C:\Program Files".into(),
        program_files_x86: Some(r"C:\Program Files (x86)".into()),
        system_root: Some(r"C:\Windows".into()),
        rulebox_apps: r"C:\Program Files\Rulebox\apps".into(),
    }
}

impl SimPlatform {
    /// (Step 13) Makes `path` exist on the simulated machine.
    #[cfg(test)]
    pub fn add_file(&self, path: &str) {
        lock(&self.world).files.insert(PathBuf::from(path));
    }
}

fn io_err(e: std::io::Error) -> PlatformError {
    PlatformError::Other(e.to_string())
}

impl Platform for SimPlatform {
    fn os_info(&self) -> Result<OsInfo, PlatformError> {
        self.check(SimOp::OsInfo)?;
        Ok(lock(&self.world).os.clone())
    }

    fn computer_name(&self) -> Result<String, PlatformError> {
        self.check(SimOp::ComputerName)?;
        Ok(lock(&self.world).computer_name.clone())
    }

    fn other_enabled_local_admins(&self, exclude_sid: Option<&str>) -> Result<Vec<String>, PlatformError> {
        self.check(SimOp::OtherEnabledLocalAdmins)?;
        let world = lock(&self.world);
        Ok(world.admins.iter().filter(|sid| Some(sid.as_str()) != exclude_sid).cloned().collect())
    }

    fn legal_notice_present(&self) -> Result<bool, PlatformError> {
        self.check(SimOp::LegalNoticePresent)?;
        Ok(lock(&self.world).legal_notice)
    }

    fn find_local_user(&self, user_name: &str) -> Result<Option<LocalUser>, PlatformError> {
        self.check(SimOp::FindLocalUser)?;
        Ok(lock(&self.world).users.get(user_name).map(|u| LocalUser {
            sid: u.sid.clone(),
            comment: u.comment.clone(),
            disabled: u.disabled,
        }))
    }

    fn read_machine_value(&self, key: &RegValueRef) -> Result<Option<RegData>, PlatformError> {
        self.check(SimOp::ReadMachineValue)?;
        Ok(lock(&self.world).machine_values.get(key).cloned())
    }

    fn sessions(&self) -> Result<Vec<SessionInfo>, PlatformError> {
        self.check(SimOp::Sessions)?;
        Ok(lock(&self.world).sessions.clone())
    }

    fn find_processes(&self, session_id: u32, image_path: &Path) -> Result<Vec<u32>, PlatformError> {
        self.check(SimOp::FindProcesses)?;
        Ok(lock(&self.world)
            .processes
            .iter()
            .filter(|p| p.session_id == session_id && p.image == image_path)
            .map(|p| p.pid)
            .collect())
    }

    fn shell_binaries_ok(&self) -> Result<ShellBinaries, PlatformError> {
        self.check(SimOp::ShellBinariesOk)?;
        Ok(lock(&self.world).shell_binaries)
    }

    fn file_exists(&self, path: &Path) -> bool {
        lock(&self.world).files.contains(path)
    }

    /// Fixed fake roots: nothing on the real disk is ever looked at.
    fn path_roots(&self) -> Result<rulebox_policy::paths::PathRoots, PlatformError> {
        Ok(sim_path_roots())
    }

    fn create_staff_user(&self, spec: &StaffUserSpec, password: &str) -> Result<String, PlatformError> {
        self.check(SimOp::CreateStaffUser)?;
        let mut world = lock(&self.world);
        if world.users.contains_key(&spec.user_name) {
            return Err(PlatformError::AlreadyExists);
        }
        world.next_rid += 1;
        let sid = format!("S-1-5-21-1000-2000-3000-{}", world.next_rid);
        world.users.insert(
            spec.user_name.clone(),
            SimUser {
                sid: sid.clone(),
                comment: spec.comment.clone(),
                disabled: false,
                password: password.to_string(),
            },
        );
        Ok(sid)
    }

    fn set_user_password(&self, user_name: &str, password: &str) -> Result<(), PlatformError> {
        self.check(SimOp::SetUserPassword)?;
        let mut world = lock(&self.world);
        let user = world.users.get_mut(user_name).ok_or(PlatformError::NotFound)?;
        user.password = password.to_string();
        Ok(())
    }

    fn test_logon(&self, user_name: &str, password: &str) -> Result<bool, PlatformError> {
        self.check(SimOp::TestLogon)?;
        Ok(lock(&self.world).users.get(user_name).is_some_and(|u| !u.disabled && u.password == password))
    }

    fn ensure_profile(&self, sid: &str, user_name: &str) -> Result<PathBuf, PlatformError> {
        self.check(SimOp::EnsureProfile)?;
        let mut world = lock(&self.world);
        if !world.users.get(user_name).is_some_and(|u| u.sid == sid) {
            return Err(PlatformError::NotFound);
        }
        let dir = self.data_dir.join("sim-profiles").join(user_name);
        world.profile_dirs.insert(sid.to_string(), dir.clone());
        Ok(dir)
    }

    fn delete_staff_user(&self, sid: &str, user_name: &str) -> Result<(), PlatformError> {
        self.check(SimOp::DeleteStaffUser)?;
        let mut world = lock(&self.world);
        match world.users.get(user_name) {
            Some(u) if u.sid == sid => {}
            _ => return Err(PlatformError::NotFound),
        }
        world.users.remove(user_name);
        world.profile_dirs.remove(sid);
        world.staff_shell.remove(sid);
        world.staff_policies.retain(|(s, _), _| s != sid);
        Ok(())
    }

    fn write_machine_value(&self, key: &RegValueRef, data: Option<&RegData>) -> Result<(), PlatformError> {
        self.check(SimOp::WriteMachineValue)?;
        let mut world = lock(&self.world);
        match data {
            Some(data) => {
                world.machine_values.insert(key.clone(), data.clone());
            }
            None => {
                world.machine_values.remove(key);
            }
        }
        Ok(())
    }

    fn lsa_secret_get(&self, name: &str) -> Result<Option<String>, PlatformError> {
        self.check(SimOp::LsaSecretGet)?;
        Ok(lock(&self.world).lsa_secrets.get(name).cloned())
    }

    fn lsa_secret_set(&self, name: &str, value: Option<&str>) -> Result<(), PlatformError> {
        self.check(SimOp::LsaSecretSet)?;
        let mut world = lock(&self.world);
        match value {
            Some(value) => {
                world.lsa_secrets.insert(name.to_string(), value.to_string());
            }
            None => {
                world.lsa_secrets.remove(name);
            }
        }
        Ok(())
    }

    fn set_staff_shell(
        &self,
        sid: &str,
        mechanism: ShellMechanism,
        command: Option<&str>,
    ) -> Result<(), PlatformError> {
        self.check(SimOp::SetStaffShell)?;
        let mut world = lock(&self.world);
        match command {
            Some(command) => {
                world.staff_shell.insert(sid.to_string(), (mechanism, Some(command.to_string())));
            }
            None => {
                world.staff_shell.remove(sid);
            }
        }
        Ok(())
    }

    fn set_staff_user_policy(&self, sid: &str, name: &str, value: Option<u32>) -> Result<(), PlatformError> {
        self.check(SimOp::SetStaffUserPolicy)?;
        let mut world = lock(&self.world);
        let key = (sid.to_string(), name.to_string());
        match value {
            Some(value) => {
                world.staff_policies.insert(key, value);
            }
            None => {
                world.staff_policies.remove(&key);
            }
        }
        Ok(())
    }

    fn logoff_session(&self, session_id: u32) -> Result<(), PlatformError> {
        self.check(SimOp::LogoffSession)?;
        let mut world = lock(&self.world);
        world.sessions.retain(|s| s.id != session_id);
        world.processes.retain(|p| p.session_id != session_id);
        Ok(())
    }

    fn launch_in_session(&self, session_id: u32, expected_sid: &str, exe: &Path) -> Result<u32, PlatformError> {
        self.check(SimOp::LaunchInSession)?;
        let mut world = lock(&self.world);
        let in_session = world
            .sessions
            .iter()
            .any(|s| s.id == session_id && s.user_sid.as_deref() == Some(expected_sid));
        if !in_session {
            return Err(PlatformError::NotFound);
        }
        world.next_pid += 1;
        let pid = world.next_pid;
        world.processes.push(SimProcess {
            pid,
            session_id,
            image: exe.to_path_buf(),
            user_sid: expected_sid.to_string(),
        });
        Ok(pid)
    }

    fn terminate_process(&self, pid: u32, expected_image: &Path, expected_sid: &str) -> Result<(), PlatformError> {
        self.check(SimOp::TerminateProcess)?;
        let mut world = lock(&self.world);
        let found = world
            .processes
            .iter()
            .position(|p| p.pid == pid && p.image == expected_image && p.user_sid == expected_sid);
        match found {
            Some(index) => {
                world.processes.remove(index);
                Ok(())
            }
            None => Err(PlatformError::NotFound),
        }
    }

    fn secrets_load(&self) -> Result<Option<Vec<u8>>, PlatformError> {
        self.check(SimOp::SecretsLoad)?;
        match std::fs::read(self.secrets_path()) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(io_err(e)),
        }
    }

    fn secrets_save(&self, plaintext: &[u8]) -> Result<(), PlatformError> {
        self.check(SimOp::SecretsSave)?;
        std::fs::create_dir_all(&self.data_dir).map_err(io_err)?;
        write_atomic(&self.secrets_path(), plaintext).map_err(io_err)
    }

    fn disk_free_bytes(&self) -> Result<u64, PlatformError> {
        self.check(SimOp::DiskFreeBytes)?;
        Ok(lock(&self.world).disk_free_bytes)
    }

    fn boot_identity(&self) -> Result<BootIdentity, PlatformError> {
        self.check(SimOp::BootTimeMs)?;
        let world = lock(&self.world);
        Ok(BootIdentity { boot_id: world.boot_id, uptime_ms: world.uptime_ms, boot_time_ms: world.boot_time_ms })
    }

    /// Never executes anything. Same program rule as `WindowsPlatform` (the fake
    /// Windows folder, the real downloads folder of the simulate data directory);
    /// answers the next scripted exit and, on success, plays the effect on the fake
    /// file set (the program appears, or goes for a removal). With
    /// `installer_hangs` it waits for `cancel` and answers `Cancelled`.
    fn run_installer(
        &self,
        cmd: &InstallerCommand,
        _timeout: Duration,
        cancel: &CancellationToken,
    ) -> Result<InstallerExit, PlatformError> {
        self.check(SimOp::RunInstaller)?;
        let system_root = sim_path_roots().system_root.map(PathBuf::from);
        let downloads = self.data_dir.join("downloads");
        if !installer_program_allowed(&cmd.program, system_root.as_deref(), &downloads) {
            return Err(PlatformError::Other("program not allowed".into()));
        }
        let hangs = {
            let mut world = lock(&self.world);
            world.installer_runs.push(cmd.clone());
            world.installer_hangs
        };
        if hangs {
            while !cancel.is_cancelled() {
                std::thread::sleep(Duration::from_millis(1));
            }
            return Ok(InstallerExit::Cancelled);
        }
        let mut world = lock(&self.world);
        if world.probe_lock && !cmd.removal {
            let is_msiexec = cmd.program.file_name().is_some_and(|n| n.eq_ignore_ascii_case("msiexec.exe"));
            let file = if is_msiexec { cmd.args.get(1).map(PathBuf::from) } else { Some(cmd.program.clone()) };
            let refused = file.is_some_and(|f| std::fs::OpenOptions::new().write(true).open(f).is_err());
            world.lock_probes.push(refused);
        }
        let exit = world.installer_exits.pop_front().unwrap_or(InstallerExit::Code(0));
        if let (InstallerExit::Code(code), Some(exe)) = (exit, &cmd.expected_exe) {
            let success = matches!(code, MSI_SUCCESS | MSI_REBOOT_REQUIRED | MSI_REBOOT_INITIATED)
                || (cmd.removal && code == MSI_UNKNOWN_PRODUCT);
            if success && cmd.removal {
                world.files.remove(exe);
            } else if success && world.installer_creates_exe {
                world.files.insert(exe.clone());
            }
        }
        Ok(exit)
    }

    fn place_portable(&self, from: &Path, to: &Path) -> Result<(), PlatformError> {
        self.check(SimOp::PlacePortable)?;
        let apps = PathBuf::from(sim_path_roots().rulebox_apps);
        if !portable_target_ok(&apps, to) {
            return Err(PlatformError::Other("not inside the apps folder".into()));
        }
        if !from.is_file() {
            return Err(PlatformError::NotFound);
        }
        lock(&self.world).files.insert(to.to_path_buf());
        Ok(())
    }

    fn remove_portable(&self, app_dir: &Path) -> Result<(), PlatformError> {
        self.check(SimOp::RemovePortable)?;
        let apps = PathBuf::from(sim_path_roots().rulebox_apps);
        if !portable_dir_ok(&apps, app_dir) {
            return Err(PlatformError::Other("not inside the apps folder".into()));
        }
        lock(&self.world).files.retain(|file| !file.starts_with(app_dir));
        Ok(())
    }

    /// (Step 16) Same rules as `WindowsPlatform` on the fake file set: the template
    /// check, then every folder from the profile down; a reparse point on the way is
    /// `Refused` (nothing deleted), a missing one is `Absent`. Below the target,
    /// open files stay (`InUse`), everything else goes; a link inside is removed
    /// itself (what it points to is untouched).
    ///
    /// The check and the deletion happen under one lock, so the sim cannot model
    /// the swap race against a held folder: that is `WindowsPlatform`'s job
    /// (`rulebox_win32::tree`) and a VM checklist item.
    fn reset_folder(
        &self,
        profile_dir: &Path,
        template: &str,
        cancel: &CancellationToken,
    ) -> Result<ResetOutcome, PlatformError> {
        self.check(SimOp::ResetFolder)?;
        let target = resolve_reset(profile_dir, template)?;
        let hang = lock(&self.world).reset_hang.clone().filter(|hang| hang.template == template);
        if let Some(hang) = hang {
            while !hang.release.load(std::sync::atomic::Ordering::SeqCst) {
                if hang.honours_cancel && cancel.is_cancelled() {
                    return Ok(ResetOutcome::InUse);
                }
                std::thread::sleep(Duration::from_millis(1));
            }
        }
        let mut world = lock(&self.world);
        for path in &target.chain {
            if world.reparse_points.contains(path) {
                return Err(PlatformError::Refused("a folder on the way is a link"));
            }
            if !world.exists(path) {
                return Ok(ResetOutcome::Absent);
            }
        }
        let root = target.target().to_path_buf();
        let busy: Vec<PathBuf> = world.open_files.iter().filter(|file| file.starts_with(&root)).cloned().collect();
        world.files.retain(|file| !file.starts_with(&root) || busy.contains(file));
        world.dirs.retain(|dir| !dir.starts_with(&root) || busy.iter().any(|file| file.starts_with(dir)));
        world.reparse_points.retain(|link| !link.starts_with(&root));
        Ok(if busy.is_empty() { ResetOutcome::Removed } else { ResetOutcome::InUse })
    }

    fn staff_profile_dir(&self, sid: &str) -> Result<Option<PathBuf>, PlatformError> {
        self.check(SimOp::StaffProfileDir)?;
        Ok(lock(&self.world).profile_dirs.get(sid).cloned())
    }

    fn staff_app_data_redirected(&self, _sid: &str, _profile: &Path) -> Result<Option<bool>, PlatformError> {
        self.check(SimOp::AppDataRedirected)?;
        Ok(lock(&self.world).app_data_redirected)
    }
}

impl SimWorld {
    /// (Step 16) A file or folder at `path`, or anything below it.
    fn exists(&self, path: &Path) -> bool {
        self.files.iter().chain(self.dirs.iter()).chain(self.reparse_points.iter()).any(|p| p.starts_with(path))
    }
}


impl SimPlatform {
    /// Adds a signed-in (or disconnected) session. Tests use it, and so does
    /// `--sim-staff-session` (the simulated Staff session of Step 13).
    pub fn add_session(&self, id: u32, user_sid: Option<&str>, active: bool) {
        lock(&self.world).sessions.push(SessionInfo {
            id,
            state: if active { super::SessionState::Active } else { super::SessionState::Disconnected },
            user_sid: user_sid.map(str::to_string),
            is_console: true,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempDir;

    fn spec() -> StaffUserSpec {
        StaffUserSpec {
            user_name: "RuleboxStaff".into(),
            full_name: "Staff".into(),
            comment: "Managed by Rulebox. Do not edit or delete.".into(),
        }
    }

    #[test]
    fn default_machine_is_windows_11_pro_with_8_gb() {
        let dir = TempDir::new();
        let sim = SimPlatform::new(dir.path().to_path_buf());
        let os = sim.os_info().unwrap();
        assert_eq!((os.build, os.edition_id.as_str(), os.ram_mb), (26100, "Professional", 8192));
        assert!(!sim.other_enabled_local_admins(None).unwrap().is_empty());
    }

    #[test]
    fn staff_user_lifecycle() {
        let dir = TempDir::new();
        let sim = SimPlatform::new(dir.path().to_path_buf());
        let sid = sim.create_staff_user(&spec(), "pw1").unwrap();
        assert!(matches!(sim.create_staff_user(&spec(), "pw1"), Err(PlatformError::AlreadyExists)));
        assert_eq!(sim.find_local_user("RuleboxStaff").unwrap().unwrap().sid, sid);
        assert!(sim.test_logon("RuleboxStaff", "pw1").unwrap());
        sim.set_user_password("RuleboxStaff", "pw2").unwrap();
        assert!(!sim.test_logon("RuleboxStaff", "pw1").unwrap());
        sim.delete_staff_user(&sid, "RuleboxStaff").unwrap();
        assert!(sim.find_local_user("RuleboxStaff").unwrap().is_none());
    }

    #[test]
    fn registry_and_lsa_values() {
        let dir = TempDir::new();
        let sim = SimPlatform::new(dir.path().to_path_buf());
        let key = RegValueRef { path: "SOFTWARE\\X".into(), name: "Y".into() };
        assert_eq!(sim.read_machine_value(&key).unwrap(), None);
        sim.write_machine_value(&key, Some(&RegData::Dword(1))).unwrap();
        assert_eq!(sim.read_machine_value(&key).unwrap(), Some(RegData::Dword(1)));
        sim.write_machine_value(&key, None).unwrap();
        assert_eq!(sim.read_machine_value(&key).unwrap(), None);
        sim.lsa_secret_set("DefaultPassword", Some("x")).unwrap();
        assert_eq!(sim.lsa_secret_get("DefaultPassword").unwrap().as_deref(), Some("x"));
    }

    #[test]
    fn fail_next_fails_exactly_once() {
        let dir = TempDir::new();
        let sim = SimPlatform::new(dir.path().to_path_buf());
        sim.fail_next(SimOp::CreateStaffUser, PlatformError::AccessDenied);
        assert!(matches!(sim.create_staff_user(&spec(), "pw"), Err(PlatformError::AccessDenied)));
        assert!(sim.create_staff_user(&spec(), "pw").is_ok());
    }

    #[test]
    fn fail_nth_skips_the_calls_before_it() {
        let dir = TempDir::new();
        let sim = SimPlatform::new(dir.path().to_path_buf());
        let key = RegValueRef { path: "SOFTWARE\\X".into(), name: "Y".into() };
        sim.fail_nth(SimOp::WriteMachineValue, 2, PlatformError::AccessDenied);
        assert!(sim.write_machine_value(&key, Some(&RegData::Dword(1))).is_ok());
        assert!(sim.write_machine_value(&key, Some(&RegData::Dword(2))).is_ok());
        assert!(matches!(
            sim.write_machine_value(&key, Some(&RegData::Dword(3))),
            Err(PlatformError::AccessDenied)
        ));
        assert!(sim.write_machine_value(&key, Some(&RegData::Dword(4))).is_ok());
        assert_eq!(sim.read_machine_value(&key).unwrap(), Some(RegData::Dword(4)));
    }

    #[test]
    fn launch_and_terminate_check_identity() {
        let dir = TempDir::new();
        let sim = SimPlatform::new(dir.path().to_path_buf());
        let sid = sim.create_staff_user(&spec(), "pw").unwrap();
        sim.add_session(2, Some(&sid), true);
        let exe = Path::new("versions/1/rulebox-staff.exe");
        assert!(matches!(sim.launch_in_session(2, "S-1-5-21-other", exe), Err(PlatformError::NotFound)));
        let pid = sim.launch_in_session(2, &sid, exe).unwrap();
        assert_eq!(sim.find_processes(2, exe).unwrap(), [pid]);
        assert!(matches!(sim.terminate_process(pid, exe, "S-1-5-21-other"), Err(PlatformError::NotFound)));
        sim.terminate_process(pid, exe, &sid).unwrap();
        assert!(sim.find_processes(2, exe).unwrap().is_empty());
    }

    #[test]
    fn secrets_file_round_trip() {
        let dir = TempDir::new();
        let sim = SimPlatform::new(dir.path().to_path_buf());
        assert_eq!(sim.secrets_load().unwrap(), None);
        sim.secrets_save(b"abc").unwrap();
        assert_eq!(sim.secrets_load().unwrap().as_deref(), Some(&b"abc"[..]));
    }
}
