//! `SimPlatform`: the whole machine in memory, for tests and `--simulate`.
//! It holds no real secrets: `secrets_*` keep plaintext in a file under the
//! data directory.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};

use std::time::Duration;

use tokio_util::sync::CancellationToken;

use super::{
    acl_target_allowed, AppLockerMechanism, AppLockerState, BootIdentity, EventRecord, InstallerCommand, InstallerExit,
    FileIdentity, FileStamp, LocalUser, LockoutPolicy, OsInfo, Platform, PlatformError, PortSpec, PrinterInfo, PrinterSpec,
    ProcessInfo, ProcessSink, ProcessStart, RegData, RegValueRef, ResetOutcome, SecurityPosture, ServiceConfig,
    SessionInfo, ShellBinaries, ShellMechanism, StaffUserSpec, TraceHandle, TraceStats, WlanState,
};
use super::{EventKind, FolderAcl, InstallMarkerValue, LocalAdminAccount, SignerCert};
use rulebox_win32::posture::{BitLocker, SecureBoot, Tpm};
use rulebox_win32::{applocker, bcd, codeintegrity, eventlog, machinereg, printing, service, staffreg, wlan};

use super::windows::map_err;
use crate::cleanup::resolve_reset;
use crate::installs::{
    hex_lower, installer_command_allowed, is_published_inf, portable_dir_ok, portable_target_ok, MSI_REBOOT_INITIATED, MSI_REBOOT_REQUIRED,
    MSI_SUCCESS, MSI_UNKNOWN_PRODUCT,
};
use crate::state::write_atomic;
use sha2::{Digest, Sha256};

/// Operations a test can make fail with `SimPlatform::fail_next`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
// (Phase 5 Step 3) Nothing calls the new seam yet: the layers of Steps 4 to 20 do.
#[allow(dead_code)]
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
    // Phase 5 Step 3 (plan 4.5). Reads first, then the mutating ones.
    ListMachineValueNames,
    /// (Q-A7) Read-only.
    MachineKeyExists,
    ReadStaffValue,
    // Phase 5 Step 18 (read-only).
    ListStaffValueNames,
    ListCiPolicies,
    ReadCiPolicy,
    GetApplockerPolicy,
    QueryService,
    GetServiceSecurity,
    GetServiceRequiredPrivileges,
    GetAccountLockout,
    WlanList,
    PrinterList,
    PrinterGetSecurity,
    PrinterDrivers,
    PrinterPorts,
    BcdGet,
    ReadEventLog,
    ReadSecurityPosture,
    GetPathAcl,
    WriteStaffValue,
    DeleteStaffValue,
    /// (Phase 6 Step 17) Removing an emptied browser policy key.
    DeleteStaffKeyIfEmpty,
    /// (Q-A7) Removing an emptied HKLM policy key Rulebox created.
    DeleteMachineKeyIfEmpty,
    DeployCiPolicy,
    RemoveCiPolicy,
    RefreshCiPolicies,
    SetApplockerPolicy,
    ClearApplockerPolicy,
    SetServiceStart,
    SetServiceSecurity,
    SetServiceRequiredPrivileges,
    SetAccountLockout,
    WlanSetProfile,
    WlanDeleteProfile,
    WlanSetFilters,
    PrinterAdd,
    PrinterDelete,
    PrinterSetSecurity,
    PrinterPortAdd,
    PrinterPortDelete,
    // Phase 5 Step 14b.
    DriverPackageDelete,
    DriverStoreInfs,
    // Phase 6 Step 15 (spike X-1 and S-11): the first three only read.
    DriverPackageModels,
    FileSignerCert,
    TrustedPublisherHas,
    PrinterDriverInstall,
    PrinterDriverDelete,
    TrustedPublisherAdd,
    TrustedPublisherRemove,
    PrinterShareConnect,
    PrinterShareDisconnect,
    BcdSet,
    StartProcessTrace,
    StopProcessTrace,
    SetPathAcl,
    // Phase 5 Step 5.
    EnabledLocalAdminAccounts,
    RemoveSafeBootEntry,
    // Phase 5 Step 7.
    EnabledLocalAccountSids,
    FolderAcls,
    // Phase 5 Step 8 (all read-only).
    ProcessInfo,
    SessionProcesses,
    FileStamp,
    FileIdentity,
    FileSha256,
    ProcessTraceStats,
    // Phase 6 Step 6 (read-only).
    Webview2Version,
    ProtectedPrintOn,
    // Phase 6 Step 11 (all read-only).
    FileVersion,
    ListFolderNames,
    WatchProcessExit,
    // Phase 6 Step 14 (read-only).
    FindFileBelow,
    // Phase 6 Step 8 (all three change the machine).
    WriteInstallMarker,
    RunWebviewBootstrapper,
    ReportEvent,
    // Phase 6 Step 20 (changes the machine: it starts the MSI upgrade of Rulebox itself).
    StartSelfUpgrade,
    // Phase 6 Step 22 run A2 (changes the machine: it ends processes).
    EndStaleLaunchers,
    // Phase 6 Q-A3 (changes the machine: it ends the Staff App before an agent-driven upgrade).
    EndStaffShell,
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
                | SimOp::ListMachineValueNames
                | SimOp::MachineKeyExists
                | SimOp::ReadStaffValue
                | SimOp::ListStaffValueNames
                | SimOp::ListCiPolicies
                | SimOp::ReadCiPolicy
                | SimOp::GetApplockerPolicy
                | SimOp::QueryService
                | SimOp::GetServiceSecurity
                | SimOp::GetServiceRequiredPrivileges
                | SimOp::GetAccountLockout
                | SimOp::WlanList
                | SimOp::PrinterList
                | SimOp::PrinterGetSecurity
                | SimOp::PrinterDrivers
                | SimOp::PrinterPorts
                | SimOp::DriverStoreInfs
                | SimOp::DriverPackageModels
                | SimOp::FileSignerCert
                | SimOp::TrustedPublisherHas
                | SimOp::BcdGet
                | SimOp::ReadEventLog
                | SimOp::ReadSecurityPosture
                | SimOp::GetPathAcl
                | SimOp::EnabledLocalAdminAccounts
                | SimOp::EnabledLocalAccountSids
                | SimOp::FolderAcls
                | SimOp::ProcessInfo
                | SimOp::SessionProcesses
                | SimOp::FileStamp
                | SimOp::FileIdentity
                | SimOp::FileSha256
                | SimOp::ProcessTraceStats
                | SimOp::Webview2Version
                | SimOp::ProtectedPrintOn
                | SimOp::FileVersion
                | SimOp::ListFolderNames
                | SimOp::WatchProcessExit
                | SimOp::FindFileBelow
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
// (Phase 5 Step 3) Nothing calls the new seam yet: the layers of Steps 4 to 20 do.
#[allow(dead_code)]
pub struct SimWorld {
    pub os: OsInfo,
    pub computer_name: String,
    /// SIDs of other enabled local administrators.
    pub admins: Vec<String>,
    /// (Phase 5 Step 5) Account name per administrator SID (a SID with no entry is
    /// named `Admin<last part of the SID>`).
    pub admin_names: HashMap<String, String>,
    /// (Phase 5 Step 5) `write_machine_value` applies `machinereg::check_write` (off by default).
    pub strict_machine_keys: bool,
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
    /// (Phase 6 Step 14) The timeout each installer run was given (`installer_runs`, same order).
    pub installer_timeouts: Vec<Duration>,
    /// (Phase 6 Step 11) The file version of a program (lowercase path to `a.b.c.d`).
    pub file_versions: HashMap<String, String>,
    /// (Phase 6 Step 11) The version a successful install of the installer file named by this SHA-256 gives its
    /// program (`file_versions` of the expected exe). An installer without an entry leaves the version alone.
    pub installer_versions: HashMap<String, String>,
    /// (Step 14b) The `oem<N>.inf` packages of the fake driver store, and the number the next one gets.
    pub driver_store: std::collections::BTreeSet<String>,
    pub next_oem: u32,
    /// (Step 14b) False: `pnputil /add-driver` succeeds but adds no new name (the package was already in the store).
    pub driver_add_publishes: bool,
    /// (Step 14b) Every `driver_package_delete` call (including those that failed), and whether the next ones fail.
    pub driver_deletes: Vec<String>,
    pub driver_delete_fails: bool,
    /// (Phase 6 Step 15, spike X-1) The model names each package of the fake store lists (`oem<N>.inf` to names): what
    /// `driver_package_models` answers and what `printer_driver_install` may register with the spooler. Like Windows,
    /// `driver_package_delete` refuses a package while the spooler still holds a printer driver of one of its models.
    pub driver_models: std::collections::BTreeMap<String, Vec<String>>,
    /// What changed the printer side, in order: `queue:<name>`, `spooler-install:<driver>`, `spooler-delete:<driver>`,
    /// `package:<oem<N>.inf>`. The removal-order tests read it.
    pub driver_events: Vec<String>,
    /// (Phase 6 Step 15, spike S-11) The certificate that signed a file (path key as `programs`), what
    /// `file_signer_cert` answers.
    pub signer_certs: HashMap<String, SignerCert>,
    /// `LocalMachine\TrustedPublisher`: SHA-1 thumbprint to DER, and every add / remove in order (`add:<sha1>`, `remove:<sha1>`).
    pub trusted_publishers: std::collections::BTreeMap<String, Vec<u8>>,
    pub trusted_publisher_log: Vec<String>,
    /// When set to a SHA-1 thumbprint, `pnputil /add-driver` fails as an untrusted publisher until that certificate is in
    /// `trusted_publishers` (a package signed by a publisher that is not WHQL).
    pub driver_requires_trust: Option<String>,
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
    // -- Phase 5 Step 3 (plan 4.5): what the new seam methods read and write. --
    /// Staff hive values: (SID, lowercase key path, lowercase value name).
    pub staff_values: HashMap<(String, String, String), RegData>,
    /// (Phase 6 Step 17) The emptied browser policy keys `delete_staff_key_if_empty` removed (lowercase paths, in order).
    pub staff_keys_removed: Vec<String>,
    /// (Q-A7) HKLM keys that exist without being a prefix of a value in `machine_values` (lowercase paths): a key a value was
    /// written in and deleted from stays, as in the registry. A key that is a prefix of some value exists as well.
    pub machine_keys: std::collections::BTreeSet<String>,
    /// Active App Control policies: id (lowercase GUID) to the binary.
    pub ci_policies: std::collections::BTreeMap<String, Vec<u8>>,
    /// (Step 6) How many times `refresh_ci_policies` ran.
    pub ci_refreshes: u32,
    /// What the AppLocker store holds, and the last policy XML written with its mechanism.
    pub applocker: AppLockerState,
    pub applocker_policy: Option<(String, AppLockerMechanism)>,
    pub services: HashMap<String, SimService>,
    pub lockout: LockoutPolicy,
    /// Wireless interfaces, profiles (name to XML; the XML holds the passphrase, so it is
    /// never printed) and the permit list.
    pub wlan_interfaces: usize,
    pub wlan_profiles: std::collections::BTreeMap<String, String>,
    pub wlan_allowed: Vec<String>,
    /// (Step 20) The SSID the simulated PC is connected to, and the Rulebox profiles whose last
    /// connection attempt failed.
    pub wlan_connected: Option<String>,
    pub wlan_connect_failures: Vec<String>,
    pub printers: Vec<SimPrinter>,
    /// (Step 14) The driver store, the ports (`PORTPROMPT:`, `FILE:` and the `Rulebox_` ones) and the per-machine share
    /// connections. A printer needs an installed driver and an existing port (or, for IPP, its URL), as on Windows.
    pub printer_drivers: Vec<String>,
    pub printer_ports: Vec<SimPort>,
    pub printer_shares: Vec<String>,
    /// BCD elements: (object, element) to value.
    pub bcd: HashMap<(String, String), String>,
    /// Event logs by channel; `read_event_log` filters by record number.
    pub event_logs: HashMap<String, Vec<EventRecord>>,
    pub posture: SecurityPosture,
    /// (Phase 6 Step 6) The WebView2 Runtime's `pv` text (`None`: not installed) and whether
    /// Windows protected print mode is on.
    pub webview2_pv: Option<String>,
    pub protected_print: bool,
    /// (Phase 6 Step 8) Every accepted `run_webview_bootstrapper` call (the exe and the hash it
    /// was given), what the run answers, and what the runtime's `pv` becomes after a success
    /// (`None`: the run changes nothing, as when it was blocked or failed quietly).
    pub bootstrapper_runs: Vec<(PathBuf, String)>,
    pub bootstrapper_exit: InstallerExit,
    pub bootstrapper_installs_pv: Option<String>,
    /// (Phase 6 Step 8) Every `report_event` call: kind, id, text.
    pub events: Vec<(super::EventKind, u32, String)>,
    /// (Phase 6 Step 20) Every accepted `start_self_upgrade` call: the MSI, the hash it was given and the log. The
    /// simulated msiexec changes nothing: a test plays the new version by setting the snapshot's `agent_version`.
    pub self_upgrades: Vec<(PathBuf, String, PathBuf)>,
    /// DACLs of files and folders (lowercase path to SDDL).
    pub path_acls: HashMap<String, String>,
    /// (Step 8) Program files the watchdog can ask about (lowercase path to what the file says).
    pub programs: HashMap<String, SimProgram>,
    /// (Step 8) What `process_trace_stats` answers for a running trace.
    pub trace_stats: TraceStats,
    /// (Step 8) Every `terminate_process` call: process id, expected image, expected owner.
    pub terminations: Vec<(u32, PathBuf, String)>,
    /// (Phase 6 Step 22 run A2) The name Toolhelp reports for a process whose image file was moved away while it ran
    /// (a process without an entry is named after its image's file name).
    pub exe_names: HashMap<u32, String>,
    /// (Phase 6 Step 22 run A2) Every process id `end_stale_launchers` ended, in order.
    pub stale_ended: Vec<u32>,
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
            admin_names: HashMap::new(),
            strict_machine_keys: false,
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
            installer_timeouts: Vec::new(),
            file_versions: HashMap::new(),
            installer_versions: HashMap::new(),
            driver_store: std::collections::BTreeSet::new(),
            next_oem: 1,
            driver_add_publishes: true,
            driver_deletes: Vec::new(),
            driver_delete_fails: false,
            driver_models: std::collections::BTreeMap::new(),
            driver_events: Vec::new(),
            signer_certs: HashMap::new(),
            trusted_publishers: std::collections::BTreeMap::new(),
            trusted_publisher_log: Vec::new(),
            driver_requires_trust: None,
            probe_lock: false,
            lock_probes: Vec::new(),
            dirs: std::collections::HashSet::new(),
            reparse_points: std::collections::HashSet::new(),
            open_files: std::collections::HashSet::new(),
            profile_dirs: HashMap::new(),
            app_data_redirected: Some(false),
            reset_hang: None,
            staff_values: HashMap::new(),
            staff_keys_removed: Vec::new(),
            machine_keys: std::collections::BTreeSet::new(),
            ci_policies: std::collections::BTreeMap::new(),
            ci_refreshes: 0,
            applocker: AppLockerState::default(),
            applocker_policy: None,
            services: sim_services(),
            lockout: LockoutPolicy { threshold: 0, duration_s: 1800, window_s: 1800 },
            wlan_interfaces: 1,
            wlan_profiles: std::collections::BTreeMap::new(),
            wlan_allowed: Vec::new(),
            wlan_connected: None,
            wlan_connect_failures: Vec::new(),
            printers: vec![SimPrinter {
                info: PrinterInfo {
                    name: "Microsoft Print to PDF".into(),
                    port: "PORTPROMPT:".into(),
                    driver: "Microsoft Print To PDF".into(),
                    attributes: 64,
                    comment: String::new(),
                },
                sddl: Some("D:(A;;LCSWSDRCWDWO;;;WD)(A;OIIO;RPWPSDRCWDWO;;;WD)".into()),
            }],
            printer_drivers: [
                "Microsoft IPP Class Driver",
                "Microsoft PCL6 Class Driver",
                "Microsoft PS Class Driver",
                "Generic / Text Only",
                "Microsoft Print To PDF",
            ]
            .map(String::from)
            .to_vec(),
            printer_ports: vec![SimPort::named("PORTPROMPT:"), SimPort::named("FILE:")],
            printer_shares: Vec::new(),
            bcd: HashMap::new(),
            event_logs: HashMap::new(),
            posture: SecurityPosture {
                secure_boot: SecureBoot::On,
                bit_locker: BitLocker::Off,
                tpm: Tpm::Present,
                ci_policies: Vec::new(),
            },
            webview2_pv: Some("130.0.2849.80".into()),
            protected_print: false,
            self_upgrades: Vec::new(),
            bootstrapper_runs: Vec::new(),
            bootstrapper_exit: InstallerExit::Code(0),
            bootstrapper_installs_pv: Some("131.0.2903.51".into()),
            events: Vec::new(),
            path_acls: HashMap::new(),
            programs: HashMap::new(),
            trace_stats: TraceStats::default(),
            terminations: Vec::new(),
            exe_names: HashMap::new(),
            stale_ended: Vec::new(),
            next_rid: 2000,
            next_pid: 4000,
        }
    }
}

/// (Step 8) A simulated program file: its stamp, what the signature check and the version
/// resource say, and its hash.
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct SimProgram {
    pub stamp: FileStamp,
    pub identity: FileIdentity,
    pub sha256: Option<String>,
}

/// A simulated service (Phase 5 Step 3): start type, DACL and required privileges.
#[derive(Debug, Clone)]
// (Phase 5 Step 3) Nothing calls the new seam yet: the layers of Steps 4 to 20 do.
#[allow(dead_code)]
pub struct SimService {
    pub start: u32,
    pub sddl: String,
    pub privileges: Vec<String>,
}

/// A simulated printer port; `spec` is set for the ones the agent created.
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct SimPort {
    pub name: String,
    pub spec: Option<PortSpec>,
}

impl SimPort {
    fn named(name: &str) -> Self {
        Self { name: name.to_string(), spec: None }
    }
}

/// A simulated print queue and its DACL.
#[derive(Debug, Clone)]
// (Phase 5 Step 3) Nothing calls the new seam yet: the layers of Steps 4 to 20 do.
#[allow(dead_code)]
pub struct SimPrinter {
    pub info: PrinterInfo,
    pub sddl: Option<String>,
}

fn sim_services() -> HashMap<String, SimService> {
    let default_sddl = "D:(A;;CCLCSWRPWPDTLOCRRC;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)(A;;CCLCSWLOCRRC;;;IU)";
    [("RuleboxAgent", 2u32), ("AppIDSvc", 3), ("Spooler", 2), ("SysMain", 2), ("WSearch", 2)]
        .into_iter()
        .map(|(name, start)| {
            (name.to_string(), SimService { start, sddl: default_sddl.to_string(), privileges: Vec::new() })
        })
        .collect()
}

/// (Phase 6 Step 11) One simulated wait for a process to end: `wait` blocks on a condition variable (no polling, like
/// the real one) until the process left the machine (`true`) or the wait was cancelled (`false`).
pub struct SimExit {
    done: Mutex<Option<bool>>,
    wake: std::sync::Condvar,
}

impl SimExit {
    fn new() -> Self {
        Self { done: Mutex::new(None), wake: std::sync::Condvar::new() }
    }

    fn finish(&self, ended: bool) {
        let mut done = lock(&self.done);
        done.get_or_insert(ended);
        self.wake.notify_all();
    }
}

impl super::ExitWatch for SimExit {
    fn wait(&self) -> bool {
        let mut done = lock(&self.done);
        loop {
            if let Some(ended) = *done {
                return ended;
            }
            done = self.wake.wait(done).unwrap_or_else(PoisonError::into_inner);
        }
    }

    fn cancel(&self) {
        self.finish(false);
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

// (Phase 5 Step 3) Nothing calls the new seam yet: the layers of Steps 4 to 20 do.
#[allow(dead_code)]
pub struct SimPlatform {
    world: Mutex<SimWorld>,
    /// Per operation, one entry per upcoming call: `Some` fails it, `None` lets it
    /// through (used by `fail_nth` to skip calls).
    failures: Mutex<HashMap<SimOp, VecDeque<Option<PlatformError>>>>,
    data_dir: PathBuf,
    /// Running process traces (Phase 5 Step 3); tests feed them with `emit_process_start`.
    traces: Mutex<Vec<(TraceHandle, ProcessSink)>>,
    /// (Phase 6 Step 11) The waits for a process to end that are running (`watch_process_exit`); a process that
    /// leaves the simulated machine ends the waits of its id.
    exit_waiters: Mutex<Vec<(u32, std::sync::Arc<SimExit>)>>,
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
            traces: Mutex::new(Vec::new()),
            exit_waiters: Mutex::new(Vec::new()),
            #[cfg(test)]
            calls: Mutex::new(Vec::new()),
        }
    }

    /// (Phase 6 Step 11) A process left the machine: the waits for it end.
    fn signal_exit(&self, pid: u32) {
        let mut waiters = lock(&self.exit_waiters);
        waiters.retain(|(waiting_for, watch)| {
            if *waiting_for == pid {
                watch.finish(true);
                false
            } else {
                true
            }
        });
    }

    /// (Phase 6 Step 11, tests) The process `pid` ends: it leaves the machine and every wait for it returns.
    #[cfg(test)]
    pub fn end_process(&self, pid: u32) {
        lock(&self.world).processes.retain(|p| p.pid != pid);
        self.signal_exit(pid);
    }

    /// (Phase 6 Step 11, tests) How many waits for a process end are running.
    #[cfg(test)]
    pub fn exit_waits_running(&self) -> usize {
        lock(&self.exit_waiters).iter().filter(|(_, watch)| lock(&watch.done).is_none()).count()
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
        world.staff_values.retain(|(s, _, _), _| s != sid);
        Ok(())
    }

    fn write_machine_value(&self, key: &RegValueRef, data: Option<&RegData>) -> Result<(), PlatformError> {
        self.check(SimOp::WriteMachineValue)?;
        let mut world = lock(&self.world);
        // (Phase 5 Step 5) Opt-in: the real key rule, as in `WindowsPlatform`. The layer
        // tests switch it on, so a layer that writes outside `machinereg::ALLOWED_ROOTS`
        // fails in its test, not first on the VM. (Phase 2 tests write fake keys.)
        if world.strict_machine_keys {
            let value = data.map(|data| match data {
                RegData::Dword(number) => rulebox_win32::registry::RegValue::Dword(*number),
                RegData::String(text) => rulebox_win32::registry::RegValue::String(text.clone()),
            });
            machinereg::check_write(&key.path, &key.name, value.as_ref()).map_err(map_err)?;
        }
        match data {
            Some(data) => {
                // Writing a value creates the key and every missing parent (`RegCreateKeyEx`).
                let mut path = key.path.trim_matches('\\').to_ascii_lowercase();
                loop {
                    world.machine_keys.insert(path.clone());
                    match path.rsplit_once('\\') {
                        Some((parent, _)) => path = parent.to_string(),
                        None => break,
                    }
                }
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
        let ended: Vec<u32> = world.processes.iter().filter(|p| p.session_id == session_id).map(|p| p.pid).collect();
        world.processes.retain(|p| p.session_id != session_id);
        drop(world);
        for pid in ended {
            self.signal_exit(pid);
        }
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
        world.terminations.push((pid, expected_image.to_path_buf(), expected_sid.to_string()));
        let found = world
            .processes
            .iter()
            .position(|p| p.pid == pid && p.image == expected_image && p.user_sid == expected_sid);
        match found {
            Some(index) => {
                world.processes.remove(index);
                drop(world);
                self.signal_exit(pid);
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
        timeout: Duration,
        cancel: &CancellationToken,
    ) -> Result<InstallerExit, PlatformError> {
        self.check(SimOp::RunInstaller)?;
        let system_root = sim_path_roots().system_root.map(PathBuf::from);
        let downloads = self.data_dir.join("downloads");
        if !installer_command_allowed(&cmd.program, &cmd.args, system_root.as_deref(), &downloads, &self.data_dir.join("drivers")) {
            return Err(PlatformError::Other("program not allowed".into()));
        }
        let hangs = {
            let mut world = lock(&self.world);
            world.installer_runs.push(cmd.clone());
            world.installer_timeouts.push(timeout);
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
        let mut exit = world.installer_exits.pop_front().unwrap_or(InstallerExit::Code(0));
        // (Spike S-11) A package signed by a publisher that is not trusted is refused by `pnputil /add-driver` (setupapi
        // `0xE0000242`): the fake store only takes it once the certificate is in `trusted_publishers`.
        let is_add = cmd.program.file_name().is_some_and(|n| n.eq_ignore_ascii_case("pnputil.exe")) && cmd.args.first().map(String::as_str) == Some("/add-driver");
        if is_add && world.driver_requires_trust.as_ref().is_some_and(|sha1| !world.trusted_publishers.contains_key(sha1)) {
            exit = InstallerExit::Code(crate::installs::drivers_rules::PNPUTIL_UNTRUSTED_PUBLISHER);
        }
        // (Step 14b) pnputil: a success publishes (or deletes) an `oem<N>.inf` of the fake store.
        if let (InstallerExit::Code(MSI_SUCCESS | MSI_REBOOT_REQUIRED | MSI_REBOOT_INITIATED), Some(root)) = (exit, &system_root) {
            if cmd.program.file_name().is_some_and(|n| n.eq_ignore_ascii_case("pnputil.exe")) {
                let inf_dir = root.join("INF");
                match cmd.args.first().map(String::as_str) {
                    Some("/add-driver") if world.driver_add_publishes => {
                        let name = format!("oem{}.inf", world.next_oem);
                        world.next_oem += 1;
                        let bytes = cmd.args.get(1).cloned().unwrap_or_default();
                        let sha = hex_lower(&Sha256::digest(bytes.as_bytes()));
                        world.programs.insert(
                            acl_key(&inf_dir.join(&name)),
                            SimProgram { stamp: FileStamp { created: 1, modified: 1, size: 100 }, identity: FileIdentity::default(), sha256: Some(sha) },
                        );
                        world.driver_store.insert(name);
                    }
                    Some("/delete-driver") => {
                        if let Some(name) = cmd.args.get(1) {
                            world.driver_store.remove(&name.to_ascii_lowercase());
                            world.programs.remove(&acl_key(&inf_dir.join(name)));
                        }
                    }
                    _ => {}
                }
            }
        }
        if let (InstallerExit::Code(code), Some(exe)) = (exit, &cmd.expected_exe) {
            let success = matches!(code, MSI_SUCCESS | MSI_REBOOT_REQUIRED | MSI_REBOOT_INITIATED)
                || (cmd.removal && code == MSI_UNKNOWN_PRODUCT);
            if success && cmd.removal {
                world.files.remove(exe);
                world.file_versions.remove(&acl_key(exe));
            } else if success && world.installer_creates_exe {
                world.files.insert(exe.clone());
                // (Phase 6 Step 11) The file version the installer file gives its program: by the installer's SHA-256
                // (the file stem of the exe, or of the `.msi` that msiexec was given).
                let is_msiexec = cmd.program.file_name().is_some_and(|n| n.eq_ignore_ascii_case("msiexec.exe"));
                let file = if is_msiexec { cmd.args.get(1).map(PathBuf::from) } else { Some(cmd.program.clone()) };
                let stem = file.and_then(|f| f.file_stem().map(|s| s.to_string_lossy().to_ascii_lowercase()));
                if let Some(version) = stem.and_then(|stem| world.installer_versions.get(&stem).cloned()) {
                    world.file_versions.insert(acl_key(exe), version);
                }
            }
        }
        Ok(exit)
    }

    fn driver_package_delete(&self, published: &str) -> Result<(), PlatformError> {
        self.check(SimOp::DriverPackageDelete)?;
        if !is_published_inf(published) {
            return Err(PlatformError::Refused("not a published driver name"));
        }
        let name = published.to_ascii_lowercase();
        let mut world = lock(&self.world);
        world.driver_deletes.push(name.clone());
        world.driver_events.push(format!("package:{name}"));
        if world.driver_delete_fails {
            return Err(PlatformError::Other("pnputil could not delete the package".into()));
        }
        if !world.driver_store.contains(&name) {
            return Err(PlatformError::NotFound);
        }
        // Spike X-1: "One or more devices are presently installed using the specified INF" (0xE000023D) while the spooler
        // still holds a printer driver of the package.
        let held = world.driver_models.get(&name).is_some_and(|models| {
            models.iter().any(|model| world.printer_drivers.iter().any(|driver| driver.eq_ignore_ascii_case(model)))
        });
        if held {
            return Err(PlatformError::Other("pnputil could not delete the package".into()));
        }
        world.driver_store.remove(&name);
        if let Some(root) = sim_path_roots().system_root {
            world.programs.remove(&acl_key(&Path::new(&root).join("INF").join(&name)));
        }
        Ok(())
    }

    fn printer_driver_install(&self, name: &str) -> Result<(), PlatformError> {
        self.check(SimOp::PrinterDriverInstall)?;
        printing::check_plain_name(name).map_err(map_err)?;
        let mut world = lock(&self.world);
        if world.printer_drivers.iter().any(|driver| driver.eq_ignore_ascii_case(name)) {
            return Ok(());
        }
        // Only a model of a package that is in the store (as on Windows: nothing is fetched from anywhere else).
        let staged = world.driver_store.iter().any(|oem| {
            world.driver_models.get(oem).is_some_and(|models| models.iter().any(|model| model.eq_ignore_ascii_case(name)))
        });
        if !staged {
            return Err(PlatformError::Win32 { api: "InstallPrinterDriverFromPackageW", code: 1797 });
        }
        world.driver_events.push(format!("spooler-install:{name}"));
        world.printer_drivers.push(name.to_string());
        Ok(())
    }

    fn printer_driver_delete(&self, name: &str) -> Result<(), PlatformError> {
        self.check(SimOp::PrinterDriverDelete)?;
        printing::check_plain_name(name).map_err(map_err)?;
        let mut world = lock(&self.world);
        if !world.printer_drivers.iter().any(|driver| driver.eq_ignore_ascii_case(name)) {
            return Err(PlatformError::NotFound);
        }
        // ERROR_PRINTER_DRIVER_IN_USE: a queue still uses it.
        if world.printers.iter().any(|printer| printer.info.driver.eq_ignore_ascii_case(name)) {
            return Err(PlatformError::Win32 { api: "DeletePrinterDriverExW", code: 3001 });
        }
        world.driver_events.push(format!("spooler-delete:{name}"));
        world.printer_drivers.retain(|driver| !driver.eq_ignore_ascii_case(name));
        Ok(())
    }

    fn trusted_publisher_add(&self, der: &[u8]) -> Result<(), PlatformError> {
        self.check(SimOp::TrustedPublisherAdd)?;
        rulebox_win32::publisher::check_der(der).map_err(map_err)?;
        // The fake store keys by the thumbprint the test certificate carries (`test_cert`: the DER's second byte repeated).
        let sha1 = format!("{:02x}", der[1]).repeat(20);
        let mut world = lock(&self.world);
        world.trusted_publisher_log.push(format!("add:{sha1}"));
        world.trusted_publishers.entry(sha1).or_insert_with(|| der.to_vec());
        Ok(())
    }

    fn trusted_publisher_remove(&self, sha1: &str) -> Result<(), PlatformError> {
        self.check(SimOp::TrustedPublisherRemove)?;
        rulebox_win32::publisher::check_sha1(sha1).map_err(map_err)?;
        let mut world = lock(&self.world);
        world.trusted_publisher_log.push(format!("remove:{sha1}"));
        world.trusted_publishers.remove(&sha1.to_ascii_lowercase());
        Ok(())
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

    // -- Phase 5 Step 3 (plan 4.5): the new seam in memory. Rules are the real ones
    //    (`rulebox-win32`'s pure `check_*` functions), the effect is on `SimWorld`. --

    fn list_machine_value_names(&self, path: &str) -> Result<Vec<String>, PlatformError> {
        self.check(SimOp::ListMachineValueNames)?;
        let path = path.trim_matches('\\');
        Ok(lock(&self.world)
            .machine_values
            .keys()
            .filter(|key| key.path.trim_matches('\\').eq_ignore_ascii_case(path))
            .map(|key| key.name.clone())
            .collect())
    }

    fn machine_key_exists(&self, path: &str) -> Result<bool, PlatformError> {
        self.check(SimOp::MachineKeyExists)?;
        Ok(sim_machine_key_exists(&lock(&self.world), path))
    }

    fn read_staff_value(&self, sid: &str, path: &str, name: &str) -> Result<Option<RegData>, PlatformError> {
        self.check(SimOp::ReadStaffValue)?;
        staffreg::check_path(path).map_err(map_err)?;
        Ok(lock(&self.world).staff_values.get(&staff_key(sid, path, name)).cloned())
    }

    fn list_staff_value_names(&self, sid: &str, path: &str) -> Result<Vec<String>, PlatformError> {
        self.check(SimOp::ListStaffValueNames)?;
        staffreg::check_path(path).map_err(map_err)?;
        let (sid, path, _) = staff_key(sid, path, "");
        let mut names: Vec<String> = lock(&self.world)
            .staff_values
            .keys()
            .filter(|(s, p, _)| *s == sid && *p == path)
            .map(|(_, _, name)| name.clone())
            .collect();
        names.sort();
        Ok(names)
    }

    fn list_ci_policies(&self) -> Result<Vec<String>, PlatformError> {
        self.check(SimOp::ListCiPolicies)?;
        Ok(lock(&self.world).ci_policies.keys().cloned().collect())
    }

    fn read_ci_policy(&self, policy_id: &str) -> Result<Option<Vec<u8>>, PlatformError> {
        self.check(SimOp::ReadCiPolicy)?;
        let id = codeintegrity::check_policy_id(policy_id).map_err(map_err)?;
        Ok(lock(&self.world).ci_policies.get(&id).cloned())
    }

    fn get_applocker_policy(&self) -> Result<AppLockerState, PlatformError> {
        self.check(SimOp::GetApplockerPolicy)?;
        let world = lock(&self.world);
        let mut state = world.applocker.clone();
        // A policy installed through the local mechanism shows in the store; the MDM bridge's
        // does not (the real reader only reads the local store).
        if let Some((xml, AppLockerMechanism::Local)) = &world.applocker_policy {
            for collection in applocker::check_policy(xml).map_err(map_err)? {
                state.collections.retain(|c| c.name != collection.name);
                state.collections.push(applocker::CollectionState {
                    name: collection.name.clone(),
                    enforcement: Some(collection.enforcement),
                    rules: u32::try_from(collection.rules.len()).unwrap_or(u32::MAX),
                });
            }
        }
        Ok(state)
    }

    fn query_service(&self, name: &str) -> Result<Option<ServiceConfig>, PlatformError> {
        self.check(SimOp::QueryService)?;
        Ok(lock(&self.world).services.get(name).map(|svc| ServiceConfig { start: svc.start }))
    }

    fn get_service_security(&self, name: &str) -> Result<Option<String>, PlatformError> {
        self.check(SimOp::GetServiceSecurity)?;
        Ok(lock(&self.world).services.get(name).map(|svc| svc.sddl.clone()))
    }

    fn get_service_required_privileges(&self, name: &str) -> Result<Vec<String>, PlatformError> {
        self.check(SimOp::GetServiceRequiredPrivileges)?;
        Ok(lock(&self.world).services.get(name).map(|svc| svc.privileges.clone()).unwrap_or_default())
    }

    fn get_account_lockout(&self) -> Result<LockoutPolicy, PlatformError> {
        self.check(SimOp::GetAccountLockout)?;
        Ok(lock(&self.world).lockout)
    }

    fn wlan_list(&self) -> Result<WlanState, PlatformError> {
        self.check(SimOp::WlanList)?;
        let world = lock(&self.world);
        Ok(WlanState {
            interfaces: world.wlan_interfaces,
            profiles: world.wlan_profiles.keys().cloned().collect(),
            allowed_ssids: world.wlan_allowed.clone(),
        })
    }

    fn wlan_current_ssid(&self) -> Result<Option<String>, PlatformError> {
        self.check(SimOp::WlanList)?;
        Ok(lock(&self.world).wlan_connected.clone())
    }

    fn wlan_last_connect_failures(&self) -> Result<Vec<String>, PlatformError> {
        self.check(SimOp::WlanList)?;
        Ok(lock(&self.world).wlan_connect_failures.clone())
    }

    fn printer_list(&self) -> Result<Vec<PrinterInfo>, PlatformError> {
        self.check(SimOp::PrinterList)?;
        Ok(lock(&self.world).printers.iter().map(|printer| printer.info.clone()).collect())
    }

    fn printer_drivers(&self) -> Result<Vec<String>, PlatformError> {
        self.check(SimOp::PrinterDrivers)?;
        Ok(lock(&self.world).printer_drivers.clone())
    }

    fn driver_store_infs(&self) -> Result<Vec<String>, PlatformError> {
        self.check(SimOp::DriverStoreInfs)?;
        Ok(lock(&self.world).driver_store.iter().cloned().collect())
    }

    fn driver_package_models(&self, published: &str) -> Result<Vec<String>, PlatformError> {
        self.check(SimOp::DriverPackageModels)?;
        if !is_published_inf(published) {
            return Err(PlatformError::Refused("not a published driver name"));
        }
        Ok(lock(&self.world).driver_models.get(&published.to_ascii_lowercase()).cloned().unwrap_or_default())
    }

    fn file_signer_cert(&self, path: &Path) -> Result<Option<SignerCert>, PlatformError> {
        self.check(SimOp::FileSignerCert)?;
        Ok(lock(&self.world).signer_certs.get(&acl_key(path)).cloned())
    }

    fn trusted_publisher_has(&self, sha1: &str) -> Result<bool, PlatformError> {
        self.check(SimOp::TrustedPublisherHas)?;
        rulebox_win32::publisher::check_sha1(sha1).map_err(map_err)?;
        Ok(lock(&self.world).trusted_publishers.contains_key(&sha1.to_ascii_lowercase()))
    }

    fn printer_ports(&self) -> Result<Vec<String>, PlatformError> {
        self.check(SimOp::PrinterPorts)?;
        Ok(lock(&self.world).printer_ports.iter().map(|p| p.name.clone()).collect())
    }

    fn printer_get_security(&self, name: &str) -> Result<Option<String>, PlatformError> {
        self.check(SimOp::PrinterGetSecurity)?;
        printing::check_plain_name(name).map_err(map_err)?;
        Ok(lock(&self.world).printers.iter().find(|p| p.info.name == name).and_then(|p| p.sddl.clone()))
    }

    fn bcd_get(&self, object: &str, element: &str) -> Result<Option<String>, PlatformError> {
        self.check(SimOp::BcdGet)?;
        bcd::check_element(object, element).map_err(map_err)?;
        Ok(lock(&self.world).bcd.get(&bcd_key(object, element)).cloned())
    }

    fn read_event_log(&self, channel: &str, after_record_id: u64, max: usize) -> Result<Vec<EventRecord>, PlatformError> {
        self.check(SimOp::ReadEventLog)?;
        eventlog::check_channel(channel).map_err(map_err)?;
        let world = lock(&self.world);
        let mut records: Vec<EventRecord> = world
            .event_logs
            .iter()
            .filter(|(name, _)| name.eq_ignore_ascii_case(channel))
            .flat_map(|(_, records)| records.iter())
            .filter(|record| record.record_id > after_record_id)
            .cloned()
            .collect();
        records.sort_by_key(|record| record.record_id);
        records.truncate(max.min(eventlog::MAX_EVENTS));
        Ok(records)
    }

    fn read_security_posture(&self) -> Result<SecurityPosture, PlatformError> {
        self.check(SimOp::ReadSecurityPosture)?;
        let world = lock(&self.world);
        let mut posture = world.posture.clone();
        posture.ci_policies = world.ci_policies.keys().cloned().collect();
        Ok(posture)
    }

    fn webview2_version(&self) -> Result<Option<String>, PlatformError> {
        self.check(SimOp::Webview2Version)?;
        Ok(lock(&self.world).webview2_pv.clone())
    }

    fn protected_print_on(&self) -> Result<bool, PlatformError> {
        self.check(SimOp::ProtectedPrintOn)?;
        Ok(lock(&self.world).protected_print)
    }

    fn get_path_acl(&self, path: &Path) -> Result<Option<String>, PlatformError> {
        self.check(SimOp::GetPathAcl)?;
        Ok(lock(&self.world).path_acls.get(&acl_key(path)).cloned())
    }

    fn enabled_local_admin_accounts(&self) -> Result<Vec<LocalAdminAccount>, PlatformError> {
        self.check(SimOp::EnabledLocalAdminAccounts)?;
        let world = lock(&self.world);
        Ok(world
            .admins
            .iter()
            .map(|sid| LocalAdminAccount {
                sid: sid.clone(),
                name: world
                    .admin_names
                    .get(sid)
                    .cloned()
                    .unwrap_or_else(|| format!("Admin{}", sid.rsplit('-').next().unwrap_or("0"))),
            })
            .collect())
    }

    fn enabled_local_account_sids(&self) -> Result<Vec<String>, PlatformError> {
        self.check(SimOp::EnabledLocalAccountSids)?;
        let world = lock(&self.world);
        let mut sids: Vec<String> = world.admins.clone();
        for user in world.users.values().filter(|user| !user.disabled) {
            if !sids.contains(&user.sid) {
                sids.push(user.sid.clone());
            }
        }
        Ok(sids)
    }

    fn folder_acls(&self, root: &Path, max_depth: u32) -> Result<Vec<FolderAcl>, PlatformError> {
        self.check(SimOp::FolderAcls)?;
        let root = acl_key(root);
        let world = lock(&self.world);
        let mut out: Vec<FolderAcl> = world
            .path_acls
            .iter()
            .filter_map(|(path, sddl)| {
                let rest = if *path == root { "" } else { path.strip_prefix(&format!("{root}\\"))? };
                let parts: Vec<&str> = rest.split('\\').filter(|part| !part.is_empty()).collect();
                let in_reach = u32::try_from(parts.len()).is_ok_and(|depth| depth <= max_depth);
                (in_reach && !parts.iter().any(|part| part.eq_ignore_ascii_case("winsxs")))
                    .then(|| FolderAcl { path: path.clone(), sddl: sddl.clone() })
            })
            .collect();
        out.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(out)
    }

    fn process_info(&self, pid: u32) -> Result<Option<ProcessInfo>, PlatformError> {
        self.check(SimOp::ProcessInfo)?;
        Ok(lock(&self.world).processes.iter().find(|p| p.pid == pid).map(sim_process_info))
    }

    fn session_processes(&self, session_id: u32) -> Result<Vec<ProcessInfo>, PlatformError> {
        self.check(SimOp::SessionProcesses)?;
        Ok(lock(&self.world).processes.iter().filter(|p| p.session_id == session_id).map(sim_process_info).collect())
    }

    fn file_stamp(&self, path: &Path) -> Result<Option<FileStamp>, PlatformError> {
        self.check(SimOp::FileStamp)?;
        Ok(lock(&self.world).programs.get(&acl_key(path)).map(|p| p.stamp))
    }

    fn file_identity(&self, path: &Path) -> Result<Option<FileIdentity>, PlatformError> {
        self.check(SimOp::FileIdentity)?;
        Ok(lock(&self.world).programs.get(&acl_key(path)).map(|p| p.identity.clone()))
    }

    fn file_sha256(&self, path: &Path, max_bytes: u64) -> Result<Option<String>, PlatformError> {
        self.check(SimOp::FileSha256)?;
        Ok(lock(&self.world)
            .programs
            .get(&acl_key(path))
            .filter(|p| p.stamp.size <= max_bytes)
            .and_then(|p| p.sha256.clone()))
    }

    fn file_version(&self, path: &Path) -> Result<Option<String>, PlatformError> {
        self.check(SimOp::FileVersion)?;
        Ok(lock(&self.world).file_versions.get(&acl_key(path)).cloned())
    }

    fn find_file_below(&self, root: &Path, file_name: &str, max_depth: u32) -> Result<bool, PlatformError> {
        self.check(SimOp::FindFileBelow)?;
        if file_name.is_empty() || file_name.contains(['\\', '/', ':']) {
            return Ok(false);
        }
        let world = lock(&self.world);
        Ok(world.files.iter().any(|path| {
            let Ok(rest) = path.strip_prefix(root) else { return false };
            let parts: Vec<_> = rest.components().collect();
            // The file itself is the last part; `max_depth` counts the folders above it.
            !parts.is_empty()
                && parts.len() <= max_depth as usize + 1
                && parts.last().is_some_and(|last| last.as_os_str().to_string_lossy().eq_ignore_ascii_case(file_name))
        }))
    }

    fn list_folder_names(&self, dir: &Path) -> Result<Vec<String>, PlatformError> {
        self.check(SimOp::ListFolderNames)?;
        let world = lock(&self.world);
        let mut names: Vec<String> = Vec::new();
        // A folder is named by the first part below `dir` of anything inside it (a file needs a second part).
        let inside = world
            .files
            .iter()
            .map(|path| (path, 2))
            .chain(world.dirs.iter().map(|path| (path, 1)))
            .filter_map(|(path, needed)| {
                let rest: Vec<_> = path.strip_prefix(dir).ok()?.components().collect();
                (rest.len() >= needed).then(|| rest[0].as_os_str().to_string_lossy().into_owned())
            });
        for name in inside {
            if !names.contains(&name) {
                names.push(name);
            }
        }
        names.sort();
        Ok(names)
    }

    fn watch_process_exit(&self, pid: u32) -> Result<Option<std::sync::Arc<dyn super::ExitWatch>>, PlatformError> {
        self.check(SimOp::WatchProcessExit)?;
        if !lock(&self.world).processes.iter().any(|p| p.pid == pid) {
            return Ok(None);
        }
        let watch = std::sync::Arc::new(SimExit::new());
        lock(&self.exit_waiters).push((pid, std::sync::Arc::clone(&watch)));
        Ok(Some(watch))
    }

    fn process_trace_stats(&self, handle: TraceHandle) -> Result<TraceStats, PlatformError> {
        self.check(SimOp::ProcessTraceStats)?;
        if !lock(&self.traces).iter().any(|(h, _)| *h == handle) {
            return Err(PlatformError::NotFound);
        }
        Ok(lock(&self.world).trace_stats)
    }

    fn write_staff_value(&self, sid: &str, path: &str, name: &str, data: &RegData) -> Result<(), PlatformError> {
        self.check(SimOp::WriteStaffValue)?;
        staffreg::check_write(path, name).map_err(map_err)?;
        let mut world = lock(&self.world);
        if !world.users.values().any(|user| user.sid == sid) {
            return Err(PlatformError::NotFound);
        }
        world.staff_values.insert(staff_key(sid, path, name), data.clone());
        Ok(())
    }

    fn delete_staff_value(&self, sid: &str, path: &str, name: &str) -> Result<(), PlatformError> {
        self.check(SimOp::DeleteStaffValue)?;
        staffreg::check_write(path, name).map_err(map_err)?;
        let mut world = lock(&self.world);
        if !world.users.values().any(|user| user.sid == sid) {
            return Err(PlatformError::NotFound);
        }
        world.staff_values.remove(&staff_key(sid, path, name));
        Ok(())
    }

    /// (Phase 6 Step 17) A key is only a path prefix of the values here, so "empty" means no value at
    /// or below the path. The same key rule as `WindowsPlatform` (the browser roots only).
    fn delete_staff_key_if_empty(&self, sid: &str, path: &str) -> Result<bool, PlatformError> {
        self.check(SimOp::DeleteStaffKeyIfEmpty)?;
        staffreg::check_browser_key(path).map_err(map_err)?;
        let mut world = lock(&self.world);
        if !world.users.values().any(|user| user.sid == sid) {
            return Err(PlatformError::NotFound);
        }
        let (sid, key, _) = staff_key(sid, path, "");
        let below = format!("{key}\\");
        if world.staff_values.keys().any(|(s, p, _)| *s == sid && (*p == key || p.starts_with(&below))) {
            return Ok(false);
        }
        world.staff_keys_removed.push(key);
        Ok(true)
    }

    /// (Q-A7) The same rule as `WindowsPlatform` (`machinereg::check_created_key`); "empty" = no value and no subkey at or below.
    fn delete_machine_key_if_empty(&self, path: &str) -> Result<bool, PlatformError> {
        self.check(SimOp::DeleteMachineKeyIfEmpty)?;
        machinereg::check_created_key(path).map_err(map_err)?;
        let mut world = lock(&self.world);
        let key = path.trim_matches('\\').to_ascii_lowercase();
        if !sim_machine_key_exists(&world, &key) {
            return Ok(true);
        }
        let below = format!("{key}\\");
        let holds_value = world.machine_values.keys().any(|k| {
            let p = k.path.trim_matches('\\').to_ascii_lowercase();
            p == key || p.starts_with(&below)
        });
        let holds_subkey = world.machine_keys.iter().any(|k| k.starts_with(&below));
        if holds_value || holds_subkey {
            return Ok(false);
        }
        world.machine_keys.remove(&key);
        Ok(true)
    }

    fn deploy_ci_policy(&self, policy_id: &str, binary: &[u8]) -> Result<(), PlatformError> {
        self.check(SimOp::DeployCiPolicy)?;
        let id = codeintegrity::check_policy_id(policy_id).map_err(map_err)?;
        if binary.is_empty() {
            return Err(PlatformError::Other("an empty policy file".into()));
        }
        lock(&self.world).ci_policies.insert(id, binary.to_vec());
        Ok(())
    }

    fn remove_ci_policy(&self, policy_id: &str) -> Result<(), PlatformError> {
        self.check(SimOp::RemoveCiPolicy)?;
        let id = codeintegrity::check_policy_id(policy_id).map_err(map_err)?;
        lock(&self.world).ci_policies.remove(&id);
        Ok(())
    }

    fn refresh_ci_policies(&self) -> Result<(), PlatformError> {
        self.check(SimOp::RefreshCiPolicies)?;
        lock(&self.world).ci_refreshes += 1;
        Ok(())
    }

    fn set_applocker_policy(&self, xml: &str, mechanism: AppLockerMechanism) -> Result<(), PlatformError> {
        self.check(SimOp::SetApplockerPolicy)?;
        applocker::check_policy(xml).map_err(map_err)?;
        lock(&self.world).applocker_policy = Some((xml.to_string(), mechanism));
        Ok(())
    }

    fn clear_applocker_policy(&self, _mechanism: AppLockerMechanism) -> Result<(), PlatformError> {
        self.check(SimOp::ClearApplockerPolicy)?;
        lock(&self.world).applocker_policy = None;
        Ok(())
    }

    fn set_service_start(&self, name: &str, start: u32) -> Result<(), PlatformError> {
        self.check(SimOp::SetServiceStart)?;
        service::check_start(name, start).map_err(map_err)?;
        match lock(&self.world).services.get_mut(name) {
            Some(svc) => {
                svc.start = start;
                Ok(())
            }
            None => Err(PlatformError::NotFound),
        }
    }

    fn set_service_security(&self, name: &str, sddl: &str) -> Result<(), PlatformError> {
        self.check(SimOp::SetServiceSecurity)?;
        service::check_agent_only(name).map_err(map_err)?;
        // (Step 17) Administrators are never locked out of the service.
        service::check_service_sddl(sddl).map_err(map_err)?;
        match lock(&self.world).services.get_mut(name) {
            Some(svc) => {
                svc.sddl = sddl.to_string();
                Ok(())
            }
            None => Err(PlatformError::NotFound),
        }
    }

    fn set_service_required_privileges(&self, name: &str, privileges: &[&str]) -> Result<(), PlatformError> {
        self.check(SimOp::SetServiceRequiredPrivileges)?;
        service::check_agent_only(name).map_err(map_err)?;
        // (Step 17) A list without `SeChangeNotifyPrivilege` would stop the service from starting.
        service::check_required_privileges(privileges).map_err(map_err)?;
        match lock(&self.world).services.get_mut(name) {
            Some(svc) => {
                svc.privileges =privileges.iter().map(|p| (*p).to_string()).collect();
                Ok(())
            }
            None => Err(PlatformError::NotFound),
        }
    }

    fn set_account_lockout(&self, policy: LockoutPolicy) -> Result<(), PlatformError> {
        self.check(SimOp::SetAccountLockout)?;
        lock(&self.world).lockout = policy;
        Ok(())
    }

    fn wlan_set_profile(&self, xml_with_key: &str) -> Result<(), PlatformError> {
        self.check(SimOp::WlanSetProfile)?;
        let name = wlan::check_profile_xml(xml_with_key).map_err(map_err)?;
        let mut world = lock(&self.world);
        if world.wlan_interfaces == 0 {
            return Err(PlatformError::NotFound);
        }
        world.wlan_profiles.insert(name, xml_with_key.to_string());
        Ok(())
    }

    fn wlan_delete_profile(&self, name: &str) -> Result<(), PlatformError> {
        self.check(SimOp::WlanDeleteProfile)?;
        wlan::check_profile_name(name).map_err(map_err)?;
        lock(&self.world).wlan_profiles.remove(name);
        Ok(())
    }

    fn wlan_set_filters(&self, ssids: &[&str]) -> Result<(), PlatformError> {
        self.check(SimOp::WlanSetFilters)?;
        wlan::check_filters(ssids).map_err(map_err)?;
        lock(&self.world).wlan_allowed = ssids.iter().map(|s| (*s).to_string()).collect();
        Ok(())
    }

    fn printer_add(&self, spec: &PrinterSpec) -> Result<(), PlatformError> {
        self.check(SimOp::PrinterAdd)?;
        printing::check_spec(spec).map_err(map_err)?;
        let mut world = lock(&self.world);
        // As on Windows: an unknown driver (1797) or port (1796) is refused. An IPP printer's port is its URL.
        if !world.printer_drivers.iter().any(|d| d.eq_ignore_ascii_case(&spec.driver)) {
            return Err(PlatformError::Win32 { api: "AddPrinterW", code: 1797 });
        }
        let is_url = spec.port.starts_with("ipp://") || spec.port.starts_with("https://");
        if !is_url && !world.printer_ports.iter().any(|p| p.name == spec.port) {
            return Err(PlatformError::Win32 { api: "AddPrinterW", code: 1796 });
        }
        let info = PrinterInfo {
            name: spec.name.clone(),
            port: spec.port.clone(),
            driver: spec.driver.clone(),
            attributes: 64,
            comment: spec.comment.clone(),
        };
        match world.printers.iter_mut().find(|p| p.info.name == spec.name) {
            Some(existing) => existing.info = info,
            None => world.printers.push(SimPrinter { info, sddl: Some("D:(A;;LCSWSDRCWDWO;;;WD)".into()) }),
        }
        Ok(())
    }

    fn printer_delete(&self, name: &str) -> Result<(), PlatformError> {
        self.check(SimOp::PrinterDelete)?;
        printing::check_own_name(name).map_err(map_err)?;
        let mut world = lock(&self.world);
        if world.printers.iter().any(|p| p.info.name == name) {
            world.driver_events.push(format!("queue:{name}"));
        }
        world.printers.retain(|p| p.info.name != name);
        Ok(())
    }

    fn printer_set_security(&self, name: &str, sddl: &str) -> Result<(), PlatformError> {
        self.check(SimOp::PrinterSetSecurity)?;
        printing::check_plain_name(name).map_err(map_err)?;
        match lock(&self.world).printers.iter_mut().find(|p| p.info.name == name) {
            Some(printer) => {
                printer.sddl = Some(sddl.to_string());
                Ok(())
            }
            None => Err(PlatformError::NotFound),
        }
    }

    fn printer_port_add(&self, spec: &PortSpec) -> Result<(), PlatformError> {
        self.check(SimOp::PrinterPortAdd)?;
        printing::check_port_spec(spec).map_err(map_err)?;
        let mut world = lock(&self.world);
        if world.printer_ports.iter().any(|p| p.name == spec.name) {
            return Err(PlatformError::AlreadyExists);
        }
        world.printer_ports.push(SimPort { name: spec.name.clone(), spec: Some(spec.clone()) });
        Ok(())
    }

    fn printer_port_delete(&self, name: &str) -> Result<(), PlatformError> {
        self.check(SimOp::PrinterPortDelete)?;
        printing::check_own_port_name(name).map_err(map_err)?;
        let mut world = lock(&self.world);
        // Windows refuses to delete a port a queue still uses (ERROR_BUSY, 170).
        if world.printers.iter().any(|p| p.info.port == name) {
            return Err(PlatformError::Win32 { api: "XcvDataW", code: 170 });
        }
        world.printer_ports.retain(|p| p.name != name);
        Ok(())
    }

    fn printer_share_connect(&self, unc: &str) -> Result<(), PlatformError> {
        self.check(SimOp::PrinterShareConnect)?;
        printing::check_share_name(unc).map_err(map_err)?;
        let mut world = lock(&self.world);
        if !world.printer_shares.iter().any(|s| s == unc) {
            world.printer_shares.push(unc.to_string());
        }
        Ok(())
    }

    fn printer_share_disconnect(&self, unc: &str) -> Result<(), PlatformError> {
        self.check(SimOp::PrinterShareDisconnect)?;
        printing::check_share_name(unc).map_err(map_err)?;
        lock(&self.world).printer_shares.retain(|s| s != unc);
        Ok(())
    }

    fn bcd_set(&self, object: &str, element: &str, value: &str) -> Result<(), PlatformError> {
        self.check(SimOp::BcdSet)?;
        bcd::check_set(object, element, value).map_err(map_err)?;
        lock(&self.world).bcd.insert(bcd_key(object, element), value.to_string());
        Ok(())
    }

    fn start_process_trace(&self, sink: ProcessSink) -> Result<TraceHandle, PlatformError> {
        self.check(SimOp::StartProcessTrace)?;
        let mut traces = lock(&self.traces);
        let handle = TraceHandle(traces.iter().map(|(h, _)| h.0).max().unwrap_or(0) + 1);
        traces.push((handle, sink));
        Ok(handle)
    }

    fn stop_process_trace(&self, handle: TraceHandle) -> Result<(), PlatformError> {
        self.check(SimOp::StopProcessTrace)?;
        lock(&self.traces).retain(|(h, _)| *h != handle);
        Ok(())
    }

    fn remove_safe_boot_entry(&self, mode: &str) -> Result<(), PlatformError> {
        self.check(SimOp::RemoveSafeBootEntry)?;
        let path = machinereg::check_safe_boot_mode(mode).map_err(map_err)?;
        // The key and the values below it go; nothing else.
        lock(&self.world).machine_values.retain(|key, _| !key.path.eq_ignore_ascii_case(&path));
        Ok(())
    }

    fn set_path_acl(&self, path: &Path, sddl: &str) -> Result<(), PlatformError> {
        self.check(SimOp::SetPathAcl)?;
        let install_root = PathBuf::from(sim_path_roots().program_files).join("Rulebox");
        if !acl_target_allowed(&install_root, &self.data_dir.join("state"), path) {
            return Err(PlatformError::Refused("not a Rulebox folder"));
        }
        lock(&self.world).path_acls.insert(acl_key(path), sddl.to_string());
        Ok(())
    }

    /// (Phase 6 Step 8) Like `WindowsPlatform`: only when the MSI's `Install` key exists (it
    /// holds `InstallDir`); nothing is created otherwise.
    fn write_install_marker(&self, value: &InstallMarkerValue) -> Result<bool, PlatformError> {
        self.check(SimOp::WriteInstallMarker)?;
        let install_dir = RegValueRef { path: rulebox_win32::guard::INSTALL_KEY.into(), name: rulebox_win32::guard::INSTALL_DIR_VALUE.into() };
        let mut world = lock(&self.world);
        if !world.machine_values.contains_key(&install_dir) {
            return Ok(false);
        }
        let (name, data) = match value {
            InstallMarkerValue::ComputerName(name) => {
                rulebox_win32::installmarker::check_computer_name(name).map_err(map_err)?;
                (rulebox_win32::guard::INSTALL_COMPUTER_VALUE, RegData::String(name.clone()))
            }
            InstallMarkerValue::KioskOn(on) => (rulebox_win32::installmarker::KIOSK_ON_VALUE, RegData::Dword(u32::from(*on))),
        };
        world.machine_values.insert(RegValueRef { path: rulebox_win32::guard::INSTALL_KEY.into(), name: name.into() }, data);
        Ok(true)
    }

    /// (Phase 6 Step 8) The same refusals as `WindowsPlatform` (the file's place, then its pinned
    /// hash), then the scripted answer; a success changes the runtime's `pv` as scripted.
    fn run_webview_bootstrapper(
        &self,
        exe: &Path,
        expected_sha256: &str,
        _timeout: Duration,
        _cancel: &CancellationToken,
    ) -> Result<InstallerExit, PlatformError> {
        self.check(SimOp::RunWebviewBootstrapper)?;
        let install_root = PathBuf::from(sim_path_roots().program_files).join("Rulebox");
        if !crate::setup::webview2::bootstrapper_path_ok(&install_root, exe) {
            return Err(PlatformError::Refused("not the WebView2 bootstrapper of the install folder"));
        }
        let mut world = lock(&self.world);
        let actual = world.programs.get(&acl_key(exe)).and_then(|program| program.sha256.clone());
        if !actual.is_some_and(|hash| hash.eq_ignore_ascii_case(expected_sha256)) {
            return Err(PlatformError::Refused("the WebView2 bootstrapper is not the pinned file"));
        }
        world.bootstrapper_runs.push((exe.to_path_buf(), expected_sha256.to_string()));
        let exit = world.bootstrapper_exit;
        if exit == InstallerExit::Code(0) {
            if let Some(pv) = world.bootstrapper_installs_pv.clone() {
                world.webview2_pv = Some(pv);
            }
        }
        Ok(exit)
    }

    fn report_event(&self, kind: EventKind, event_id: u32, message: &str) -> Result<(), PlatformError> {
        self.check(SimOp::ReportEvent)?;
        lock(&self.world).events.push((kind, event_id, rulebox_win32::eventwrite::clip_message(message)));
        Ok(())
    }

    /// (Phase 6 Step 20) The same refusals as `WindowsPlatform` (the file's place, then its hash read from the real file
    /// of the test's data folder), then it only records the call: nothing is executed.
    fn start_self_upgrade(&self, msi: &Path, expected_sha256: &str, log: &Path) -> Result<u32, PlatformError> {
        self.check(SimOp::StartSelfUpgrade)?;
        if !crate::selfupdate::upgrade_files_ok(&self.data_dir.join("selfupdate"), &self.data_dir.join("logs"), msi, expected_sha256, log) {
            return Err(PlatformError::Refused("not the staged Rulebox MSI"));
        }
        let actual = std::fs::read(msi).ok().map(|bytes| hex_lower(&Sha256::digest(bytes)));
        if !actual.is_some_and(|hash| hash.eq_ignore_ascii_case(expected_sha256)) {
            return Err(PlatformError::Refused("the Rulebox MSI is not the verified file"));
        }
        let mut world = lock(&self.world);
        world.self_upgrades.push((msi.to_path_buf(), expected_sha256.to_string(), log.to_path_buf()));
        Ok(4242)
    }

    /// (Phase 6 Step 22 run A2) The same rule as `WindowsPlatform`: the Toolhelp name (`exe_names`, else the image's file
    /// name), the session and the owner, and an image that is not the installed launcher.
    fn end_stale_launchers(&self, session_id: u32, installed_launcher: &Path, staff_sid: &str) -> Result<Vec<u32>, PlatformError> {
        self.check(SimOp::EndStaleLaunchers)?;
        let wanted = "rulebox-shell.exe";
        if !installed_launcher.file_name().is_some_and(|name| name.eq_ignore_ascii_case(wanted)) {
            return Err(PlatformError::Refused("not the launcher's path"));
        }
        let mut world = lock(&self.world);
        let stale: Vec<u32> = world
            .processes
            .iter()
            .filter(|p| {
                let name = world.exe_names.get(&p.pid).cloned().or_else(|| {
                    p.image.file_name().map(|name| name.to_string_lossy().into_owned())
                });
                name.is_some_and(|name| name.eq_ignore_ascii_case(wanted))
                    && p.session_id == session_id
                    && p.user_sid == staff_sid
                    && p.image != installed_launcher
            })
            .map(|p| p.pid)
            .collect();
        world.processes.retain(|p| !stale.contains(&p.pid));
        world.stale_ended.extend(&stale);
        drop(world);
        for pid in &stale {
            self.signal_exit(*pid);
        }
        Ok(stale)
    }

    /// (Phase 6 Q-A3) The same rule as `WindowsPlatform`: the launcher and the Staff App (by the Toolhelp name, else the
    /// image's file name) of the Staff account in any of its sessions, installed copy or not.
    fn end_staff_shell(&self, staff_sid: &str) -> Result<Vec<u32>, PlatformError> {
        self.check(SimOp::EndStaffShell)?;
        let mut world = lock(&self.world);
        let sessions: Vec<u32> = world
            .sessions
            .iter()
            .filter(|s| s.user_sid.as_deref().is_some_and(|user| user.eq_ignore_ascii_case(staff_sid)))
            .map(|s| s.id)
            .collect();
        let ended: Vec<u32> = world
            .processes
            .iter()
            .filter(|p| {
                let name = world.exe_names.get(&p.pid).cloned().or_else(|| p.image.file_name().map(|name| name.to_string_lossy().into_owned()));
                name.is_some_and(|name| name.eq_ignore_ascii_case("rulebox-shell.exe") || name.eq_ignore_ascii_case("rulebox-staff.exe"))
                    && sessions.contains(&p.session_id)
                    && p.user_sid.eq_ignore_ascii_case(staff_sid)
            })
            .map(|p| p.pid)
            .collect();
        world.processes.retain(|p| !ended.contains(&p.pid));
        world.stale_ended.extend(&ended);
        drop(world);
        for pid in &ended {
            self.signal_exit(*pid);
        }
        Ok(ended)
    }
}

/// Registry names are case-insensitive: so are the simulated Staff-hive keys.
// (Phase 5 Step 3) Nothing calls the new seam yet: the layers of Steps 4 to 20 do.
#[allow(dead_code)]
/// (Q-A7) A key exists when it was created (`machine_keys`) or some value sits at or below it.
fn sim_machine_key_exists(world: &SimWorld, path: &str) -> bool {
    let key = path.trim_matches('\\').to_ascii_lowercase();
    let below = format!("{key}\\");
    world.machine_keys.contains(&key)
        || world.machine_values.keys().any(|k| {
            let p = k.path.trim_matches('\\').to_ascii_lowercase();
            p == key || p.starts_with(&below)
        })
}

fn staff_key(sid: &str, path: &str, name: &str) -> (String, String, String) {
    (sid.to_string(), path.trim_matches('\\').to_ascii_lowercase(), name.to_ascii_lowercase())
}

// (Phase 5 Step 3) Nothing calls the new seam yet: the layers of Steps 4 to 20 do.
#[allow(dead_code)]
fn bcd_key(object: &str, element: &str) -> (String, String) {
    (object.to_ascii_lowercase(), element.to_ascii_lowercase())
}

// (Phase 5 Step 3) Nothing calls the new seam yet: the layers of Steps 4 to 20 do.
#[allow(dead_code)]
fn acl_key(path: &Path) -> String {
    path.to_string_lossy().replace('/', "\\").trim_end_matches('\\').to_ascii_lowercase()
}

fn sim_process_info(process: &SimProcess) -> ProcessInfo {
    ProcessInfo {
        pid: process.pid,
        session_id: process.session_id,
        image: process.image.clone(),
        user_sid: process.user_sid.clone(),
    }
}

impl SimPlatform {
    /// (Step 8) Makes a program file exist for the watchdog: what the signature check and the
    /// version resource say about it. `size` and `modified` build the cache stamp.
    #[cfg(test)]
    pub fn add_program(&self, path: &str, identity: FileIdentity, sha256: Option<&str>) {
        let stamp = FileStamp { created: 1, modified: 1, size: 1024 };
        lock(&self.world)
            .programs
            .insert(acl_key(Path::new(path)), SimProgram { stamp, identity, sha256: sha256.map(str::to_string) });
    }

    /// (Phase 6 Step 15) Says which certificate validly signed a file (the answer of `file_signer_cert`).
    #[cfg(test)]
    pub fn add_signer_cert(&self, path: &str, cert: SignerCert) {
        lock(&self.world).signer_certs.insert(acl_key(Path::new(path)), cert);
    }
}

/// (Phase 6 Step 15) A certificate for tests: the thumbprints are the byte `n` repeated (so two certificates differ by
/// `n`), the DER is a fake `SEQUENCE` of the size `check_der` accepts.
#[cfg(test)]
pub fn test_cert(subject: &str, n: u8) -> SignerCert {
    let hex = |len: usize| format!("{n:02x}").repeat(len);
    let mut der = vec![n; 128];
    der[0] = 0x30;
    SignerCert { subject: subject.to_string(), sha1: hex(20), sha256: hex(32), der }
}

impl SimPlatform {
    /// (Phase 5 Step 3) Delivers a process start to every running trace, as the ETW
    /// session would; returns how many traces got it. Tests and `--simulate` use it.
    #[allow(dead_code)]
    pub fn emit_process_start(&self, event: &ProcessStart) -> usize {
        let traces = lock(&self.traces);
        for (_, sink) in traces.iter() {
            sink(event.clone());
        }
        traces.len()
    }

    /// The number of running process traces.
    #[cfg(test)]
    pub fn running_traces(&self) -> usize {
        lock(&self.traces).len()
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

#[cfg(test)]
mod step3_tests;
