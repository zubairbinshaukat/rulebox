//! The single entry point for service mode and console mode. It loads the
//! state, builds the first snapshot and runs the tasks of Section 5.2: the IPC
//! servers (Step 6), the backend and reconciler (Steps 8 and 9) and the launcher
//! watchdog (Step 13).

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{bail, Context};
use rulebox_ipc::types::{
    AgentSnapshot, ConnectionStatus, DeviceInfo, DisplayMode, EnrollmentStatus, ShellHealth, ShellStatus, LITE_MAX_RAM_MB,
};
use rulebox_ipc::{ADMIN_PIPE, SHELL_PIPE, SIM_SUFFIX};
use rulebox_policy::envelope::{verify_envelope, Payload, SignedEnvelope};
use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, watch};
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

use crate::admin_exit::{AdminExit, AdminExitDeps, ExitRequest};
use crate::agent_policy::AgentPolicy;
use crate::audit::{AuditHandle, AuditQueue, AuditSink, ConvexAuditSink};
use crate::backend::task::{apply_to_snapshot, note_clock, os_jitter, BackendRunner, TaskContext};
use crate::backend::{BackendFactory, BackendLink};
use crate::catalog::AppResolver;
use crate::cleanup::{self, CleanupDeps, CleanupGate, CleanupTimings, StaffRef};
use crate::directory::{ConvexDirectory, EmployeeDirectory};
use crate::report::{run_report_task, ReportQueue};
use crate::roster::RosterState;
use crate::session::run_session_events;
use crate::employee_cache::EmployeeCache;
use crate::enroll::{EnrollDeps, Enroller, Timings};
use crate::fixtures;
use crate::installs::download::Downloader;
use crate::installs::engine::{run_install_task, EngineDeps, InstallBook};
use crate::installs::{EXE_WAIT, INSTALL_TIMEOUT};
use crate::ipc_admin::{self, AdminPipe, WithStatusExtra};
use crate::ipc_shell::{self, ShellBroadcast, ShellExtension, ShellPipe, ShellSignal};
use crate::kiosk::{kiosk_status, spawn_reconciler, ReconcilerDeps};
use crate::kiosk_control::KioskControl;
use crate::lockdown::lkg::{LkgMonitor, ShellHealthSink};
use crate::lockdown::procwatch::BlockedProgram;
use crate::lockdown::reporting::{run_lockdown_reporter, LockdownOutbox, LockdownReporter};
use crate::lockdown::runtime::{LockdownRuntime, RuntimeDeps};
use crate::lockout::LockoutStore;
use crate::notice::{run_ack_sender, run_notices, AckQueue, DenialSink, NoticeExtension, NoticeHub};
use crate::paths::{DataPaths, InstallPaths};
use crate::platform::{Platform, ShellMechanism};
use crate::session::{SessionDeps, SessionManager, SessionTimeouts};
use crate::state::{read_json, unix_ms, AgentState, SharedState, SnapshotHandle, StateStore};
use crate::watchdog::{self, WatchdogDeps};

/// How long `run` waits for the IPC tasks to wind down after shutdown.
const TASK_WIND_DOWN: Duration = Duration::from_secs(5);
/// The folder under the Staff profile that holds every employee's files folder.
pub(crate) const FILES_BASE_DIR: &str = "RuleboxFiles";
/// Pending exit requests: the PIN gate lets one through at a time, so this is only
/// slack.
const EXIT_QUEUE: usize = 4;

/// The two pipe names. Tests use unique ones so they never meet a real agent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PipeNames {
    pub shell: String,
    pub admin: String,
}

impl PipeNames {
    /// The production names, or the same with `.sim` appended in simulate mode.
    pub fn for_mode(simulate: bool) -> Self {
        let suffix = if simulate { SIM_SUFFIX } else { "" };
        Self { shell: format!("{SHELL_PIPE}{suffix}"), admin: format!("{ADMIN_PIPE}{suffix}") }
    }
}

/// Optional `agent-config.json` in the state directory.
#[derive(Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentConfig {
    pub kill_hung_shell: bool,
    /// (Step 9) Where the Staff account's shell value is written: `"policyShell"`
    /// (default) or `"winlogonShell"` (plan Section 10.2, "Sign-in and shell").
    pub shell_mechanism: ShellMechanism,
    /// (Phase 5 Step 4, plan 4.6 I7) The user sets this after checklist row E-71 passed on
    /// the VM: an administrator can still sign in with the admin tiles hidden. Until then
    /// a document with `hideAdminTiles` is refused (`admin_signin_unverified`).
    pub admin_signin_verified: bool,
}

impl Default for AgentConfig {
    fn default() -> Self {
        Self { kill_hung_shell: true, shell_mechanism: ShellMechanism::default(), admin_signin_verified: false }
    }
}

/// (1.1) What `--sim-demo` and `--sim-offline` ask for. Both are false on a real
/// agent; `run` refuses `demo` unless `Deps::simulate` is set.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SimOptions {
    /// The demo world of plan Section 6.11: enrolled, kiosk applied, demo
    /// employees and catalogue.
    pub demo: bool,
    /// The demo world with `connection: "offline"`.
    pub offline: bool,
    /// (Step 13) `--sim-staff-session`: the watchdog behaves as if the kiosk were on
    /// and the simulated Staff session of `SIM_STAFF_SID` were signed in (the caller
    /// adds that session to `SimPlatform`). Simulate mode only.
    pub staff_session: bool,
}

/// Events from the service host (session changes, power) that the reconciler reacts to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ControlEvent {
    SessionChanged { session_id: u32 },
    /// A session was locked (`WTS_SESSION_LOCK`): the Staff console is signed out 10
    /// seconds later if it is still the active console session (plan Section 5.6).
    SessionLocked { session_id: u32 },
    PowerResumed,
}

/// Everything `run` needs from the outside.
pub struct Deps {
    pub platform: Arc<dyn Platform>,
    /// (Step 8) Builds the backend client for one deployment URL: `ConvexBackend` on
    /// a real or simulated agent, a scripted fake in tests.
    pub backend_factory: BackendFactory,
    pub paths: DataPaths,
    /// Where the Rulebox binaries live (peer verification, Section 6.2 check 3).
    /// Unused in simulate mode.
    pub install: InstallPaths,
    pub config: AgentConfig,
    pub simulate: bool,
    pub pipes: PipeNames,
    /// (1.1) The employee directory seam. The caller applies `directory::choose`.
    pub directory: DirectorySetup,
    /// (1.1) Where the reports (audit queue, status, installs) are delivered.
    pub audit_sink: SinkSetup,
    pub sim: SimOptions,
    /// (Phase 4 Step 14) Installer and icon downloads: `HttpDownloader` on a real
    /// or simulated agent, a fake in tests (tests never download).
    pub downloader: Arc<dyn Downloader>,
}

/// (Step 13) The directory: a ready one, or the Convex one, which `run` builds
/// because it needs the backend link and the policy channel made there.
pub enum DirectorySetup {
    Use(Arc<dyn EmployeeDirectory>),
    Convex,
}

/// (Step 13) The report sink, likewise.
pub enum SinkSetup {
    Use(Arc<dyn AuditSink>),
    Convex,
}

pub fn load_config(paths: &DataPaths) -> anyhow::Result<AgentConfig> {
    let loaded = read_json(&paths.agent_config()).context("read agent-config.json")?;
    Ok(loaded.unwrap_or_default())
}

/// `desired-state.json`: the last accepted document, as the signed envelope it
/// was received in (Phase 4 Step 9), so the agent-only keys of Section 5.10 (the
/// exit PIN hash among them) survive a restart while offline. It is verified
/// again at every start ([`load_verified_cache`]). A Phase 2 file (an unsigned
/// `doc`, no `payload`) parses but is ignored.
#[derive(Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CachedDesired {
    pub version: u64,
    /// The signed payload exactly as received.
    #[serde(default)]
    pub payload: Option<String>,
    #[serde(default)]
    pub signature: Option<String>,
    #[serde(default)]
    pub key_id: Option<String>,
}

impl CachedDesired {
    pub fn from_envelope(envelope: &SignedEnvelope) -> Self {
        Self {
            version: envelope.version,
            payload: Some(envelope.payload.clone()),
            signature: Some(envelope.signature.clone()),
            key_id: Some(envelope.key_id.clone()),
        }
    }

    /// The envelope, or `None` for a Phase 2 file.
    pub fn envelope(&self) -> Option<SignedEnvelope> {
        Some(SignedEnvelope {
            version: self.version,
            payload: self.payload.clone()?,
            signature: self.signature.clone()?,
            key_id: self.key_id.clone()?,
        })
    }
}

impl std::fmt::Debug for CachedDesired {
    // Not derived: `payload` holds the PIN hash.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CachedDesired")
            .field("version", &self.version)
            .field("signed", &self.signature.is_some())
            .finish_non_exhaustive()
    }
}

/// The cached document when it is signed and still verifies for this device
/// with the keys it trusts now. A Phase 2 (unsigned) file, a file that fails
/// verification, or a PC that is not enrolled gives `None` (logged): the
/// effective state then falls back to the enrollment default.
pub fn load_verified_cache(paths: &DataPaths, state: &AgentState) -> Option<(SignedEnvelope, Payload)> {
    let cached = load_cached_desired(paths)?;
    let enrollment = state.enrollment.as_ref()?;
    let Some(envelope) = cached.envelope() else {
        tracing::error!(version = cached.version, "desired-state.json is unsigned (Phase 2 format); ignored");
        return None;
    };
    match verify_envelope(&envelope, &state.trusted_keys, &enrollment.org_id, &enrollment.device_id) {
        Ok(payload) => Some((envelope, payload)),
        Err(error) => {
            tracing::error!(version = cached.version, "desired-state.json does not verify ({error}); ignored");
            None
        }
    }
}

/// The cached document, or `None` when there is none (or it cannot be read; the
/// reason is logged and, for a file that does not parse, the file is moved aside by
/// `read_json`).
pub fn load_cached_desired(paths: &DataPaths) -> Option<CachedDesired> {
    match read_json::<CachedDesired>(&paths.desired_state()) {
        Ok(cached) => cached,
        Err(error) => {
            tracing::error!("cannot read desired-state.json: {error}");
            None
        }
    }
}

/// The display mode the PC's RAM selects on its own (PRD 22.5): Lite at `LITE_MAX_RAM_MB` or less. An unreadable RAM size
/// means Standard. (Phase 6 Step 19: the administrator's override is applied on top by `AgentPolicy::apply_display`.)
pub fn ram_display_mode(platform: &dyn Platform) -> DisplayMode {
    match platform.os_info() {
        Ok(os) if os.ram_mb <= LITE_MAX_RAM_MB => DisplayMode::Lite,
        _ => DisplayMode::Standard,
    }
}

/// The snapshot shown to the Staff App before any backend contact. The protocol
/// 1.1 fields `adminExit`, `power` and `orgName` come from `policy` (never the
/// PIN hash).
pub fn initial_snapshot(
    state: &AgentState,
    platform: &dyn Platform,
    _config: &AgentConfig,
    policy: &AgentPolicy,
) -> AgentSnapshot {
    // The RAM picks the mode on its own; the administrator's override is applied by `apply_display` below.
    let display_mode = ram_display_mode(platform);
    let enrollment = match &state.enrollment {
        None => EnrollmentStatus::NotEnrolled,
        Some(e) if e.revoked => EnrollmentStatus::Revoked,
        Some(_) => EnrollmentStatus::Enrolled,
    };
    // The same mapping the reconciler uses after every reconcile.
    let kiosk = kiosk_status(&state.kiosk);
    let mut snapshot = AgentSnapshot {
        agent_version: env!("CARGO_PKG_VERSION").to_string(),
        enrollment,
        device: state
            .enrollment
            .as_ref()
            .map(|e| DeviceInfo { id: e.device_id.clone(), name: e.device_name.clone() }),
        convex_url: state.enrollment.as_ref().map(|e| e.convex_url.clone()),
        connection: ConnectionStatus::Offline,
        kiosk,
        shell: ShellStatus { health: ShellHealth::NotRunning },
        display_mode,
        desired_state: None,
        desired_state_version: state.last_applied_version,
        server_time_offset_ms: None,
        clock_suspect: false,
        // Protocol 1.1 fields: set from the policy just below.
        admin_exit: None,
        power: None,
        org_name: None,
        // Protocol 1.3 fields: set from the policy just below (the broadcasts by the notice hub).
        device_lock: None,
        broadcasts: Vec::new(),
        keyboard: None,
        printing: None,
        network: None,
        // Protocol 1.4 fields: filled by `apply_display` just below (Phase 6 Step 19).
        web_window_cap: None,
        web_idle_close_min: None,
        display_mode_source: Default::default(),
    };
    policy.apply_to_snapshot(&mut snapshot);
    policy.apply_display(&mut snapshot, display_mode);
    snapshot
}

pub async fn run(
    deps: Deps,
    shutdown: CancellationToken,
    mut control_rx: mpsc::UnboundedReceiver<ControlEvent>,
) -> anyhow::Result<()> {
    // The demo world exists only in the simulated agent (README answers table, 1.1).
    if deps.sim.demo && !deps.simulate {
        bail!("the demo world (--sim-demo) is only available together with --simulate");
    }
    // (Phase 6 Step 5) A release build has no demo employees, test marker or not.
    if deps.sim.demo && !crate::config::demo_world_allowed() {
        bail!(crate::config::DEMO_REFUSED);
    }
    if deps.sim.staff_session && !deps.simulate {
        bail!("--sim-staff-session is only available together with --simulate");
    }
    let store = StateStore::open(&deps.paths.state_dir()).context("open the state directory")?;
    let state = store.load().context("load the agent state")?;
    // (1.1) The agent-only keys of the desired-state document: the demo document in
    // demo mode, otherwise the cached one (the backend task keeps it current), only
    // when it still verifies (Phase 4 Step 9). No document means no exit PIN, so
    // the admin exit is off.
    let cached = if deps.sim.demo { None } else { load_verified_cache(&deps.paths, &state) };
    let policy_doc = if deps.sim.demo {
        Some(fixtures::demo_document())
    } else {
        cached.as_ref().map(|(_, payload)| payload.doc.clone())
    };
    // (Phase 5 Step 15) A device lock survives a lost or unverifiable cache (`AgentState.device_lock`).
    let cache_is_newest = cached.as_ref().is_some_and(|(_, payload)| payload.version >= state.accepted_version);
    let policy = AgentPolicy::from_doc(policy_doc.as_ref())
        .with_persisted_lock(state.device_lock.as_ref(), deps.sim.demo || cache_is_newest);
    drop(policy_doc);
    tracing::info!(
        enabled = policy.admin_exit.enabled,
        hotkey = %policy.admin_exit.hotkey,
        problem = ?policy.admin_exit.problem,
        "admin exit settings"
    );
    let mut first_snapshot = initial_snapshot(&state, deps.platform.as_ref(), &deps.config, &policy);
    // Offline at boot: the cached document fills the snapshot before any backend
    // contact (plan Section 5.8), so the Staff App has the state from the start.
    if let Some((_, payload)) = &cached {
        if let Ok(desired) = serde_json::from_value::<rulebox_policy::DesiredState>(payload.doc.clone()) {
            apply_to_snapshot(&mut first_snapshot, &desired, payload.version, &policy);
        }
    }
    drop(cached);
    if deps.sim.demo {
        fixtures::apply_demo_snapshot(&mut first_snapshot, deps.sim.offline);
    }
    let (snapshot_handle, snapshot_rx) = SnapshotHandle::new(first_snapshot);
    // The policy travels in its own channel, so the PIN hash is never inside the
    // snapshot. The backend task sends the next policy whenever a document is
    // accepted.
    let (policy_tx, policy_rx) = watch::channel(policy);
    let policy_tx = Arc::new(policy_tx);

    if deps.simulate {
        tracing::info!(demo = deps.sim.demo, offline = deps.sim.offline, "agent started (simulate)");
    } else {
        tracing::info!("agent started");
    }
    tracing::debug!(display_mode = ?snapshot_rx.borrow().display_mode, "initial snapshot built");

    // The Staff account's SID: the shell pipe exists only while it is known. The
    // reconciler sends changes through `staff_sid_tx` (after enable creates the
    // account, and when the record changes).
    let (staff_sid_tx, staff_sid_rx) =
        watch::channel(state.staff.as_ref().map(|staff| staff.sid.clone()));
    let (signals_tx, signals_rx) = mpsc::unbounded_channel::<ShellSignal>();
    let broadcast = ShellBroadcast::new();

    // State and secrets, shared by the backend task and the enrollment flow.
    let shared = SharedState::new(store, state.clone(), Arc::clone(&deps.platform));
    // (Phase 5 Step 2) Settle what a crash or power cut left in the journal before
    // anything is applied: a `Pending` entry whose value never changed is dropped, one
    // that changed becomes `Applied`, a `Restoring` one is restored again.
    {
        let ctx = crate::journal::JournalCtx { platform: deps.platform.as_ref(), shared: shared.as_ref() };
        let report = crate::journal::startup_recover(&ctx);
        if !report.unknown.is_empty() {
            tracing::error!(
                code = crate::journal::JOURNAL_UNKNOWN_TARGET,
                count = report.unknown.len(),
                "the journal holds targets this agent cannot restore; nothing new is applied"
            );
        }
        if !report.restore.failed.is_empty() {
            tracing::warn!(ids = ?report.restore.failed_ids(), "restore_incomplete: a restore will be tried again");
        }
        if !report.dropped.is_empty() || !report.kept.is_empty() {
            tracing::info!(dropped = report.dropped.len(), kept = report.kept.len(), "settled the journal after a restart");
        }
    }

    // (1.1) Employee session, lockouts, offline cache and audit queue.
    let now_ms: Arc<dyn Fn() -> u64 + Send + Sync> = Arc::new(unix_ms);
    let lockouts = Arc::new(Mutex::new(
        LockoutStore::open(deps.paths.lockouts()).context("open lockouts.json")?,
    ));
    let cache = EmployeeCache::open(deps.paths.employee_cache()).context("open employee-cache.json")?;
    let audit = AuditHandle::new(
        AuditQueue::open(deps.paths.audit_queue()).context("open audit-queue.json")?,
        snapshot_rx.clone(),
        Arc::clone(&now_ms),
    );
    let files_base = if deps.sim.demo {
        Some(deps.paths.sim_files())
    } else {
        state
            .staff
            .as_ref()
            .and_then(|staff| staff.profile_dir.as_deref())
            .map(|profile| PathBuf::from(profile).join(FILES_BASE_DIR))
    };
    // (Step 13) The backend link, the reports and the verified roster. The
    // directory and the report sink are built before any enrollment and read the
    // link at each call.
    let link = BackendLink::new();
    let report = ReportQueue::new(Arc::clone(&audit));
    // (Step 14) The install records: the engine writes them, the report queue
    // confirms what the server took, and app visibility reads them.
    let installs = InstallBook::open(deps.paths.installs());
    {
        let book = Arc::clone(&installs);
        report.set_install_ack(Arc::new(move |accepted| book.ack(accepted)));
    }
    let install_policy_rx = policy_rx.clone();
    // (Step 16) The session cleanup reads the catalogue when a round starts.
    let cleanup_policy_rx = policy_rx.clone();
    // (Phase 5 Step 12) The notice hub (broadcasts, acknowledgements) and the 1.3 requests.
    let notice_policy_rx = policy_rx.clone();
    let notice_ext_policy_rx = policy_rx.clone();
    let (roster_tx, roster_rx) = watch::channel(RosterState::load(&deps.paths.roster()));
    let roster_tx = Arc::new(roster_tx);
    let directory: Arc<dyn EmployeeDirectory> = match deps.directory {
        DirectorySetup::Use(directory) => directory,
        DirectorySetup::Convex => Arc::new(ConvexDirectory::new(
            Arc::clone(&link),
            policy_rx.clone(),
            AppResolver::with_installs(Arc::clone(&deps.platform), Arc::clone(&installs), deps.paths.icons_dir()),
        )),
    };
    let audit_sink: Arc<dyn AuditSink> = match deps.audit_sink {
        SinkSetup::Use(sink) => sink,
        SinkSetup::Convex => Arc::new(ConvexAuditSink::new(Arc::clone(&link))),
    };
    let session = SessionManager::new(SessionDeps {
        directory,
        cache,
        lockouts: Arc::clone(&lockouts),
        audit: Arc::clone(&audit),
        snapshot_rx: snapshot_rx.clone(),
        files_base,
        now_ms: Arc::clone(&now_ms),
        // The highest wall clock seen; the backend task keeps it current.
        clock_floor_ms: {
            let shared = Arc::clone(&shared);
            Arc::new(move || shared.last_wall_clock_ms())
        },
        timeouts: SessionTimeouts::default(),
    });

    // (1.1) The hidden admin exit: the PIN gate. The reconciler owns the receiving
    // end of the exit requests (plan Section 5.10 and Step 9).
    let (exit_tx, exit_rx) = mpsc::channel::<ExitRequest>(EXIT_QUEUE);
    // (Step 13) `apps.changed` / `session.ended`, and the roster and catalogue rules
    // applied whenever a document or a roster arrives.
    let (session_events_tx, session_events_rx) = mpsc::unbounded_channel();
    session.set_events(session_events_tx);
    let session_sync = (policy_rx.clone(), roster_rx);
    let admin_exit = AdminExit::new(AdminExitDeps {
        policy_rx,
        lockouts: Arc::clone(&lockouts),
        audit: Arc::clone(&audit),
        session: Arc::clone(&session),
        exit_tx,
        now_ms: Arc::clone(&now_ms),
    });

    // (Phase 5 Step 20) The lockdown runtime: the layers, the process watch, the last-known-good
    // monitor and the reports, driven by the reconciler below. The demo world has no lockdown.
    let lockdown: Option<Arc<LockdownRuntime>> = if deps.sim.demo {
        None
    } else {
        let outbox = LockdownOutbox::open(&deps.paths).context("open the lockdown report files")?;
        let lkg = Arc::new(LkgMonitor::open_in(&deps.paths).context("open lkg.json")?);
        let blocked = broadcast.clone();
        Some(LockdownRuntime::new(RuntimeDeps {
            platform: Arc::clone(&deps.platform),
            shared: Arc::clone(&shared),
            paths: deps.paths.clone(),
            install: deps.install.clone(),
            admin_signin_verified: deps.config.admin_signin_verified,
            reporter: LockdownReporter::new(outbox, Arc::clone(&now_ms)),
            lkg,
            audit: Arc::clone(&audit),
            report: Arc::clone(&report),
            snapshot: snapshot_handle.clone(),
            now_ms: Arc::clone(&now_ms),
            // program.blocked: the process watch says it once per program per session.
            on_blocked: Some(Arc::new(move |program: BlockedProgram| blocked.program_blocked(&program.display_name))),
        }))
    };

    // The kiosk reconciler (Step 9): the only task that changes the machine. It is
    // the `KioskControl` of the backend task and the enrollment flow, and the
    // receiver of the exit requests.
    let tasks = TaskTracker::new();
    let reconciler = spawn_reconciler(
        ReconcilerDeps {
            platform: Arc::clone(&deps.platform),
            shared: Arc::clone(&shared),
            snapshot: snapshot_handle.clone(),
            session: Arc::clone(&session),
            broadcast: broadcast.clone(),
            config: deps.config.clone(),
            install: deps.install.clone(),
            simulate: deps.simulate,
            staff_sid_tx,
            recovered_flag: deps.paths.recovered_flag(),
            lockdown: lockdown.clone(),
        },
        exit_rx,
        shutdown.clone(),
        &tasks,
    );

    // The backend task, and the enrollment flow behind `admin.enroll` and
    // `admin.unenroll`.
    let control: Arc<dyn KioskControl> = Arc::new(reconciler.clone());
    let task_ctx = Arc::new(TaskContext {
        shared: Arc::clone(&shared),
        paths: deps.paths.clone(),
        snapshot: snapshot_handle.clone(),
        policy_tx,
        session: Arc::clone(&session),
        control,
        platform: Arc::clone(&deps.platform),
        factory: Arc::clone(&deps.backend_factory),
        now_ms: Arc::clone(&now_ms),
        jitter: Arc::new(os_jitter),
        link: Arc::clone(&link),
        report: Arc::clone(&report),
        roster_tx,
        lockdown: lockdown.clone(),
    });
    let runner = BackendRunner::new(Arc::clone(&task_ctx), shutdown.clone());
    let enroller = Arc::new(Enroller::new(EnrollDeps {
        ctx: Arc::clone(&task_ctx),
        runner: Arc::clone(&runner),
        audit: Arc::clone(&audit),
        lockouts: Arc::clone(&lockouts),
        timings: Timings::default(),
    }));
    // The demo world is not enrolled in the state file, so it starts no backend.
    if !deps.sim.demo {
        note_clock(&task_ctx);
        if runner.start_from_state().await {
            tracing::info!("syncing with the backend");
        }
    }

    // (Phase 6 Step 8) The enrollment code a silent install left (`msiexec ... ENROLLCODE=<code>`):
    // read once, enroll, delete, in every outcome. Nothing happens when there is none. The
    // simulated agent has no installer; a real or simulated PC without the value does nothing.
    if !deps.sim.demo {
        tasks.spawn(crate::setup::pending::run(
            Arc::clone(&deps.platform),
            Arc::clone(&enroller),
            Arc::clone(&shared),
            deps.install.root().to_path_buf(),
            shutdown.clone(),
        ));
        // (Phase 6 Step 8) `KioskOn` of the install marker, which the MSI's uninstall guard reads:
        // filled at every start (a major upgrade wipes the key) and kept while the kiosk changes.
        tasks.spawn(crate::install_marker::run_kiosk_marker(
            Arc::clone(&deps.platform),
            Arc::clone(&shared),
            snapshot_rx.clone(),
            shutdown.clone(),
        ));
    }

    tasks.spawn(ipc_admin::run_pipe(
        AdminPipe {
            name: deps.pipes.admin.clone(),
            simulate: deps.simulate,
            snapshot_rx: snapshot_rx.clone(),
            handler: Arc::new(WithStatusExtra::new(
                enroller,
                Arc::clone(&session),
                Arc::clone(&audit),
                Arc::clone(&admin_exit),
            )),
        },
        shutdown.clone(),
    ));
    tasks.spawn(run_report_task(
        Arc::clone(&report),
        audit_sink,
        snapshot_rx.clone(),
        Arc::new(os_jitter),
        shutdown.clone(),
    ));
    // (Step 14) The install engine: one operation at a time, only while enrolled.
    // The demo world has no enrollment and no real catalogue: no engine.
    if !deps.sim.demo {
        let session_for_installs = Arc::clone(&session);
        tasks.spawn(run_install_task(
            EngineDeps {
                platform: Arc::clone(&deps.platform),
                downloader: Arc::clone(&deps.downloader),
                paths: deps.paths.clone(),
                book: Arc::clone(&installs),
                report: Arc::clone(&report),
                now_ms: Arc::clone(&now_ms),
                // A tile appeared or went: recompute the employee's apps
                // (`apps.changed` when they differ).
                on_visible_change: Arc::new(move || session_for_installs.resync()),
                // (Phase 5 Step 20) A printer may have waited for this driver (`driver_missing`).
                on_driver_change: {
                    let reconciler = reconciler.clone();
                    Arc::new(move || reconciler.lockdown_changed())
                },
                install_timeout: INSTALL_TIMEOUT,
                exe_wait: EXE_WAIT,
                shared: Arc::clone(&shared),
                // (Phase 6 Step 11) The apply windows of app updates follow the employee's sign-in.
                signed_in: session.presence(),
            },
            install_policy_rx,
            snapshot_rx.clone(),
            shutdown.clone(),
        ));
    }
    // (Step 16) Session cleanup: every end of an employee session resets the
    // catalogue apps' folders in the Staff profile (PRD 5.3). The demo world has no
    // Staff profile and no real catalogue: no cleanup.
    // (Review) The "cleanup owed" marker is read before the shell pipe starts: a
    // sign-in after a restart waits for the rounds the marker asks for.
    if !deps.sim.demo {
        let gate = CleanupGate::open(deps.paths.cleanup_owed());
        let (cleanup_tx, cleanup_rx) = mpsc::unbounded_channel();
        gate.set_requests(cleanup_tx);
        session.set_cleanup(Arc::clone(&gate));
        let staff_shared = Arc::clone(&shared);
        let active_session = Arc::clone(&session);
        tasks.spawn(cleanup::run_cleanup(
            CleanupDeps {
                platform: Arc::clone(&deps.platform),
                policy_rx: cleanup_policy_rx,
                staff: Arc::new(move || {
                    staff_shared.read(|state| {
                        state.staff.as_ref().map(|staff| StaffRef {
                            sid: staff.sid.clone(),
                            saved_profile: staff.profile_dir.as_ref().map(PathBuf::from),
                        })
                    })
                }),
                // Weak: the session manager holds the gate that feeds this task.
                // Gone (the agent is stopping) counts as active: nothing is deleted.
                session_active: {
                    let weak = Arc::downgrade(&active_session);
                    Arc::new(move || weak.upgrade().is_none_or(|session| session.is_active()))
                },
                gate,
                timings: CleanupTimings::default(),
            },
            cleanup_rx,
            shutdown.clone(),
        ));
    }
    tasks.spawn(run_session_events(session_events_rx, broadcast.clone(), shutdown.clone()));
    // (Phase 5 Step 12) The broadcast list of the snapshot, the acknowledgement queue and the
    // events of protocol 1.3. The denial counters of the Staff App go to the daily security
    // counters (the demo world has none): they live in the lockdown reporter's outbox, which
    // sends a finished day and forgets everything on unenroll (Step 20).
    let notice_hub = NoticeHub::new(
        AckQueue::open(deps.paths.broadcast_acks()).context("open broadcast-acks.json")?,
        snapshot_handle.clone(),
        broadcast.clone(),
        Arc::clone(&now_ms),
    );
    let denial_sink: Option<Arc<dyn DenialSink>> =
        lockdown.as_ref().map(|runtime| Arc::clone(runtime.reporter()) as Arc<dyn DenialSink>);
    // (Step 20) The lockdown reports (apply, findings, daily counters, the sealing key). When an
    // apply report went out, the waiting broadcast acknowledgements ride along.
    if let Some(runtime) = &lockdown {
        let hub = Arc::clone(&notice_hub);
        runtime.reporter().set_on_apply_sent(Arc::new(move || hub.flush_acks_now()));
        tasks.spawn(run_lockdown_reporter(
            Arc::clone(runtime.reporter()),
            Arc::clone(&link),
            snapshot_rx.clone(),
            Arc::new(os_jitter),
            shutdown.clone(),
        ));
    }
    let notice_extension = NoticeExtension::new(
        Arc::clone(&notice_hub),
        notice_ext_policy_rx,
        snapshot_rx.clone(),
        denial_sink,
        Arc::clone(&now_ms),
    );
    // (Step 15) The acknowledgements are sent by their own small task (the demo world has no backend).
    if !deps.sim.demo {
        tasks.spawn(run_ack_sender(
            Arc::clone(&notice_hub),
            Arc::clone(&link),
            snapshot_rx.clone(),
            Arc::new(os_jitter),
            shutdown.clone(),
        ));
    }
    tasks.spawn(run_notices(notice_hub, notice_policy_rx, shutdown.clone()));
    tasks.spawn(sync_session(session_sync.0, session_sync.1, Arc::clone(&session), shutdown.clone()));
    tasks.spawn(clear_session_when_not_enrolled(
        snapshot_rx.clone(),
        Arc::clone(&session),
        shutdown.clone(),
    ));
    // (Step 13) The launcher watchdog: launcher presence and hang detection. It reads
    // the kiosk and Staff account from the shared state, never from the snapshot.
    let (watchdog, watchdog_events) = watchdog::channel();
    let gate = if deps.simulate && deps.sim.staff_session {
        watchdog::sim_gate()
    } else {
        watchdog::state_gate(Arc::clone(&shared))
    };
    tasks.spawn(watchdog::run(
        WatchdogDeps {
            platform: Arc::clone(&deps.platform),
            snapshot: snapshot_handle.clone(),
            install: deps.install.clone(),
            kill_hung_shell: deps.config.kill_hung_shell,
            simulate: deps.simulate,
            gate,
        },
        signals_rx,
        watchdog_events,
        // (Phase 5 Step 20) Heartbeats, crashes and the Staff session feed the probation.
        lockdown.as_ref().map(|runtime| Arc::clone(runtime.lkg()) as Arc<dyn ShellHealthSink>),
        shutdown.clone(),
    ));
    tasks.spawn(ipc_shell::run_pipe(
        ShellPipe {
            name: deps.pipes.shell.clone(),
            simulate: deps.simulate,
            install: deps.install.clone(),
            platform: Arc::clone(&deps.platform),
            snapshot_rx: snapshot_rx.clone(),
            signals: signals_tx,
            broadcast: broadcast.clone(),
            // The order is the order of the capability list in `hello`.
            extensions: vec![
                Arc::clone(&admin_exit) as Arc<dyn ShellExtension>,
                Arc::clone(&session) as Arc<dyn ShellExtension>,
                Arc::new(notice_extension) as Arc<dyn ShellExtension>,
            ],
            staff_sid_rx,
        },
        shutdown.clone(),
    ));

    loop {
        tokio::select! {
            () = shutdown.cancelled() => break,
            event = control_rx.recv() => match event {
                Some(ControlEvent::SessionChanged { .. }) => {
                    reconciler.session_changed();
                    watchdog.session_changed();
                }
                Some(ControlEvent::SessionLocked { session_id }) => reconciler.session_locked(session_id),
                Some(ControlEvent::PowerResumed) => {
                    reconciler.power_resumed();
                    watchdog.session_changed();
                }
                // The host dropped its sender: nothing more can arrive, keep waiting for shutdown.
                None => {
                    shutdown.cancelled().await;
                    break;
                }
            },
        }
    }

    // The pipe tasks watch the same token: they tell their clients and close. So
    // does the backend task; wait for it too.
    tasks.close();
    if tokio::time::timeout(TASK_WIND_DOWN, tasks.wait()).await.is_err() {
        tracing::warn!("the IPC tasks did not stop within {} s", TASK_WIND_DOWN.as_secs());
    }
    if tokio::time::timeout(TASK_WIND_DOWN, runner.stop()).await.is_err() {
        tracing::warn!("the backend task did not stop within {} s", TASK_WIND_DOWN.as_secs());
    }
    tracing::info!("agent stopped");
    Ok(())
}

/// (Step 13) Applies every new policy and verified roster to the session layer
/// (`SessionManager::resync`): dropped cache entries, an ended session,
/// recomputed apps.
async fn sync_session(
    mut policy_rx: watch::Receiver<AgentPolicy>,
    mut roster_rx: watch::Receiver<RosterState>,
    session: Arc<SessionManager>,
    shutdown: CancellationToken,
) {
    let policy = policy_rx.borrow_and_update().clone();
    session.on_policy(&policy);
    let roster = roster_rx.borrow_and_update().clone();
    session.on_roster(&roster);
    loop {
        tokio::select! {
            () = shutdown.cancelled() => return,
            changed = policy_rx.changed() => {
                if changed.is_err() {
                    return;
                }
                let policy = policy_rx.borrow_and_update().clone();
                session.on_policy(&policy);
            }
            changed = roster_rx.changed() => {
                if changed.is_err() {
                    return;
                }
                let roster = roster_rx.borrow_and_update().clone();
                session.on_roster(&roster);
            }
        }
    }
}

/// Ends the employee session when the device stops being enrolled or is revoked
/// (plan Section 5.9). The other end-of-session events (the Staff Windows session
/// ends, a correct exit PIN) come from the reconciler and Step 6b through
/// `SessionManager::clear`.
async fn clear_session_when_not_enrolled(
    mut snapshot_rx: watch::Receiver<AgentSnapshot>,
    session: Arc<SessionManager>,
    shutdown: CancellationToken,
) {
    loop {
        if snapshot_rx.borrow_and_update().enrollment != EnrollmentStatus::Enrolled {
            session.clear("enrollment ended");
        }
        tokio::select! {
            () = shutdown.cancelled() => return,
            changed = snapshot_rx.changed() => {
                if changed.is_err() {
                    return;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rulebox_ipc::types::{DisplayModeSource, KioskPhase};

    use crate::platform::sim::SimPlatform;
    use crate::state::{Enrollment, KioskApplied, KioskRecord};
    use crate::testutil::{signing, unique_pipe_name, TempDir};

    #[test]
    fn fresh_snapshot_is_not_enrolled_and_standard() {
        let dir = TempDir::new();
        let sim = SimPlatform::new(dir.path().to_path_buf());
        let snapshot =
            initial_snapshot(&AgentState::default(), &sim, &AgentConfig::default(), &AgentPolicy::default());
        assert_eq!(snapshot.enrollment, EnrollmentStatus::NotEnrolled);
        assert_eq!(snapshot.display_mode, DisplayMode::Standard);
        assert_eq!(snapshot.kiosk.phase, KioskPhase::NotApplied);
        assert!(snapshot.device.is_none() && snapshot.desired_state.is_none());
        // A 1.1 agent always sends `adminExit`; with no PIN it is off.
        assert_eq!(
            snapshot.admin_exit,
            Some(rulebox_ipc::types::AdminExitInfo { enabled: false, hotkey: "Ctrl+Shift+F12".into() })
        );
        assert!(snapshot.power.is_none() && snapshot.org_name.is_none());
    }

    #[test]
    fn the_snapshot_takes_the_policy_fields_and_never_the_hash() {
        let dir = TempDir::new();
        let sim = SimPlatform::new(dir.path().to_path_buf());
        let document = serde_json::json!({
            "adminExit": { "pinHash": crate::kdf::hash_secret("2468").unwrap(), "hotkey": "ctrl+alt+k" },
            "power": { "sleep": false, "restart": true, "shutDown": true },
            "orgName": "Corner Shop"
        });
        let policy = AgentPolicy::from_doc(Some(&document));
        let snapshot = initial_snapshot(&AgentState::default(), &sim, &AgentConfig::default(), &policy);
        assert_eq!(
            snapshot.admin_exit,
            Some(rulebox_ipc::types::AdminExitInfo { enabled: true, hotkey: "Ctrl+Alt+K".into() })
        );
        assert_eq!(snapshot.org_name.as_deref(), Some("Corner Shop"));
        assert_eq!(snapshot.power.map(|p| p.sleep), Some(false));
        let wire = serde_json::to_string(&snapshot).unwrap();
        assert!(!wire.contains("pinHash") && !wire.contains("argon2"), "{wire}");
    }

    #[test]
    fn the_cached_document_is_read_from_desired_state_json_and_debug_hides_it() {
        let dir = TempDir::new();
        let paths = DataPaths::new(dir.path().to_path_buf());
        assert_eq!(load_cached_desired(&paths), None);

        std::fs::create_dir_all(paths.state_dir()).unwrap();
        let envelope = signing::envelope(
            &signing::test_key(),
            "o1",
            "d1",
            7,
            &serde_json::json!({ "adminExit": { "pinHash": "$argon2id$secret" }, "x": 1, "version": 7 }),
        );
        let text = serde_json::to_vec(&CachedDesired::from_envelope(&envelope)).unwrap();
        std::fs::write(paths.desired_state(), text).unwrap();
        let cached = load_cached_desired(&paths).expect("a cached document");
        assert_eq!(cached.version, 7);
        assert_eq!(cached.envelope(), Some(envelope));
        let debug = format!("{cached:?}");
        assert!(!debug.contains("argon2") && !debug.contains("pinHash"), "{debug}");

        // It verifies only for its own device, with a trusted key.
        let mut state = AgentState {
            enrollment: Some(Enrollment {
                convex_url: "https://x.convex.cloud".into(),
                device_id: "d1".into(),
                org_id: "o1".into(),
                device_name: "Desk".into(),
                enrolled_at_ms: 1,
                revoked: false,
                allow_joined: false,
            }),
            ..AgentState::default()
        };
        assert!(load_verified_cache(&paths, &state).is_none(), "no trusted key");
        state.trusted_keys = vec![signing::trusted_of(&signing::test_key())];
        let (_, payload) = load_verified_cache(&paths, &state).expect("verifies");
        assert_eq!(payload.doc["x"], 1);
        state.enrollment.as_mut().unwrap().device_id = "d2".into();
        assert!(load_verified_cache(&paths, &state).is_none(), "another device");

        // phase2_cache_is_ignored: the Phase 2 file (an unsigned `doc`) parses but is
        // never used.
        state.enrollment.as_mut().unwrap().device_id = "d1".into();
        std::fs::write(paths.desired_state(), r#"{ "version": 1, "doc": { "kioskEnabled": false } }"#).unwrap();
        assert_eq!(load_cached_desired(&paths).unwrap().envelope(), None);
        assert!(load_verified_cache(&paths, &state).is_none());

        // A file that does not parse is moved aside and treated as missing.
        std::fs::write(paths.desired_state(), "{ not json").unwrap();
        assert_eq!(load_cached_desired(&paths), None);
        assert!(!paths.desired_state().exists());
    }

    #[test]
    fn low_ram_selects_lite_and_enrollment_shows() {
        let dir = TempDir::new();
        let sim = SimPlatform::new(dir.path().to_path_buf());
        sim.with_world(|w| w.os.ram_mb = 4096);
        let state = AgentState {
            enrollment: Some(Enrollment {
                convex_url: "https://x.convex.cloud".into(),
                device_id: "d1".into(),
                org_id: "o1".into(),
                device_name: "Desk".into(),
                enrolled_at_ms: 1,
                revoked: false,
                allow_joined: false,
            }),
            kiosk: KioskRecord { applied: KioskApplied::Enabled, ..KioskRecord::default() },
            last_applied_version: 7,
            ..AgentState::default()
        };
        let snapshot = initial_snapshot(&state, &sim, &AgentConfig::default(), &AgentPolicy::default());
        assert_eq!(snapshot.display_mode, DisplayMode::Lite);
        assert_eq!(snapshot.enrollment, EnrollmentStatus::Enrolled);
        assert_eq!(snapshot.device.map(|d| d.id), Some("d1".to_string()));
        assert_eq!(snapshot.kiosk.phase, KioskPhase::Applied);
        assert_eq!(snapshot.desired_state_version, 7);
    }

    /// (Phase 6 Step 19, plan 4.14) Effective mode = the document's winner (device over group), else the RAM; the
    /// snapshot says whose choice it was and carries the resolved window cap and idle close.
    #[test]
    fn the_override_beats_the_ram_and_the_snapshot_says_whose_it_is() {
        let dir = TempDir::new();
        let sim = SimPlatform::new(dir.path().to_path_buf());
        let snapshot_for = |ram_mb: u64, document: serde_json::Value| {
            sim.with_world(|w| w.os.ram_mb = ram_mb);
            let policy = AgentPolicy::from_doc(Some(&document));
            initial_snapshot(&AgentState::default(), &sim, &AgentConfig::default(), &policy)
        };
        let low = 4096;
        let high = 16_384;

        // No override: the RAM decides; the defaults of the mode apply.
        let s = snapshot_for(low, serde_json::json!({}));
        assert_eq!((s.display_mode, s.display_mode_source), (DisplayMode::Lite, DisplayModeSource::Auto));
        assert_eq!((s.web_window_cap, s.web_idle_close_min), (Some(3), Some(30)));
        let s = snapshot_for(high, serde_json::json!({}));
        assert_eq!((s.display_mode, s.display_mode_source), (DisplayMode::Standard, DisplayModeSource::Auto));
        assert_eq!((s.web_window_cap, s.web_idle_close_min), (Some(8), Some(0)));

        // A group override beats the RAM both ways; a device override is reported as the device's.
        let s = snapshot_for(high, serde_json::json!({ "displayMode": "lite", "displayModeSource": "group" }));
        assert_eq!((s.display_mode, s.display_mode_source), (DisplayMode::Lite, DisplayModeSource::Group));
        assert_eq!((s.web_window_cap, s.web_idle_close_min), (Some(3), Some(30)));
        let s = snapshot_for(low, serde_json::json!({ "displayMode": "standard", "displayModeSource": "device" }));
        assert_eq!((s.display_mode, s.display_mode_source), (DisplayMode::Standard, DisplayModeSource::Device));
        assert_eq!((s.web_window_cap, s.web_idle_close_min), (Some(8), Some(0)));

        // "auto", an unknown value and a wrong type fall through to the RAM.
        for bad in [serde_json::json!("auto"), serde_json::json!("dim"), serde_json::json!(5)] {
            let s = snapshot_for(low, serde_json::json!({ "displayMode": bad, "displayModeSource": "device" }));
            assert_eq!((s.display_mode, s.display_mode_source), (DisplayMode::Lite, DisplayModeSource::Auto));
        }
        // An override with no source still applies (source `auto`); an unknown source reads `unknown` (the Staff App treats it as auto).
        let s = snapshot_for(high, serde_json::json!({ "displayMode": "lite" }));
        assert_eq!((s.display_mode, s.display_mode_source), (DisplayMode::Lite, DisplayModeSource::Auto));
        let s = snapshot_for(high, serde_json::json!({ "displayMode": "lite", "displayModeSource": "fleet" }));
        assert_eq!((s.display_mode, s.display_mode_source), (DisplayMode::Lite, DisplayModeSource::Unknown));

        // The cap and the idle close come from the document when set; out-of-range values are ignored.
        let s = snapshot_for(high, serde_json::json!({ "webWindowCap": 12, "webIdleCloseMin": 5 }));
        assert_eq!((s.web_window_cap, s.web_idle_close_min), (Some(12), Some(5)));
        let s = snapshot_for(low, serde_json::json!({ "webWindowCap": 1, "webIdleCloseMin": 0 }));
        assert_eq!((s.web_window_cap, s.web_idle_close_min), (Some(1), Some(0)));
        for bad in [0, 13, 99] {
            let s = snapshot_for(low, serde_json::json!({ "webWindowCap": bad }));
            assert_eq!(s.web_window_cap, Some(3), "{bad}");
        }
        for bad in [1, 4, 241] {
            let s = snapshot_for(low, serde_json::json!({ "webIdleCloseMin": bad }));
            assert_eq!(s.web_idle_close_min, Some(30), "{bad}");
        }
    }

    /// A simulated agent on pipe names of its own.
    fn test_deps(dir: &TempDir) -> Deps {
        Deps {
            platform: Arc::new(SimPlatform::new(dir.path().to_path_buf())),
            // No test reaches a backend through this: a call would be unreachable.
            backend_factory: Arc::new(|_| Err(crate::backend::BackendError::Unreachable)),
            paths: DataPaths::new(dir.path().to_path_buf()),
            install: InstallPaths::new(dir.path().join("install")),
            config: AgentConfig::default(),
            simulate: true,
            pipes: PipeNames {
                shell: unique_pipe_name(),
                admin: unique_pipe_name(),
            },
            directory: DirectorySetup::Use(Arc::new(crate::directory::UnavailableDirectory)),
            audit_sink: SinkSetup::Use(Arc::new(crate::audit::LogAuditSink)),
            sim: SimOptions::default(),
            downloader: Arc::new(crate::installs::download::fake::NoDownloads),
        }
    }

    #[tokio::test]
    async fn run_waits_for_shutdown() {
        let dir = TempDir::new();
        let deps = test_deps(&dir);
        let shutdown = CancellationToken::new();
        let (_control_tx, control_rx) = mpsc::unbounded_channel();
        let task = tokio::spawn(run(deps, shutdown.clone(), control_rx));
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert!(!task.is_finished());
        shutdown.cancel();
        task.await.unwrap().unwrap();
    }

    /// The demo world end to end through `run`: the demo snapshot, a sign-in over the
    /// shell pipe, the extra line of `status`, and that nothing is created in the
    /// employee's files folder (the agent only names it).
    #[tokio::test]
    async fn the_demo_world_signs_an_employee_in_and_status_names_them() {
        use rulebox_ipc::admin::{AdminStatus, AdminStatusResult};
        use rulebox_ipc::client::{ClientConfig, ClientEvent, IpcClient};
        use rulebox_ipc::methods::{AdminExitSubmit, AppsList, Empty, SessionGet, SessionSignIn};
        use rulebox_ipc::requests::{
            AdminExitOutcome, AdminExitSubmitParams, SignInOutcome, SignInParams,
        };
        use rulebox_ipc::types::{ClientInfo, ClientRole};
        use rulebox_win32::sid::current_user_sid;

        let dir = TempDir::new();
        let mut deps = test_deps(&dir);
        deps.directory = DirectorySetup::Use(Arc::new(crate::directory::FixtureDirectory::new(false)));
        deps.sim = SimOptions { demo: true, ..SimOptions::default() };
        let (shell_name, admin_name) = (deps.pipes.shell.clone(), deps.pipes.admin.clone());
        let sim_files = deps.paths.sim_files();
        let shutdown = CancellationToken::new();
        let (_control_tx, control_rx) = mpsc::unbounded_channel();
        let task = tokio::spawn(run(deps, shutdown.clone(), control_rx));

        let me = current_user_sid().unwrap();
        let config = |name: String| ClientConfig {
            pipe_name: name,
            trusted_owner: me.clone(),
            request_timeout: Duration::from_secs(10),
            require_session_zero: false,
        };
        let info = ClientInfo { role: ClientRole::Shell, name: "test".into(), version: "0.0.0".into() };
        let (client, mut events) = IpcClient::spawn_with(info, config(shell_name));
        match tokio::time::timeout(Duration::from_secs(10), events.recv()).await.unwrap().unwrap() {
            ClientEvent::Linked(hello) => {
                assert_eq!(
                    hello.capabilities,
                    [
                        "state",
                        "health",
                        "adminExit",
                        "session",
                        "apps",
                        "appsChanged",
                        "sessionEnded",
                        "deviceLock",
                        "broadcasts",
                        "keyboardPolicy",
                        "permissionReports"
                    ]
                );
            }
            other => panic!("unexpected {other:?}"),
        }

        let snapshot = client.call::<rulebox_ipc::methods::StateGet>(Empty {}).await.unwrap();
        assert_eq!(snapshot.enrollment, EnrollmentStatus::Enrolled);
        assert_eq!(snapshot.connection, ConnectionStatus::Online);
        assert_eq!(snapshot.device.as_ref().map(|d| d.id.as_str()), Some("sim-device"));
        // The demo document's agent-only keys reach the snapshot, the hash does not.
        assert_eq!(
            snapshot.admin_exit,
            Some(rulebox_ipc::types::AdminExitInfo { enabled: true, hotkey: "Ctrl+Shift+F12".into() })
        );
        assert_eq!(snapshot.org_name.as_deref(), Some("Demo Company"));
        assert_eq!(
            snapshot.power,
            Some(rulebox_ipc::types::PowerOptions { sleep: true, restart: true, shut_down: true })
        );
        assert!(!serde_json::to_string(&snapshot).unwrap().contains("argon2"));

        let signed_in = client
            .call::<SessionSignIn>(SignInParams { username: "maya".into(), password: "demo".into() })
            .await
            .unwrap();
        assert_eq!(signed_in.outcome, SignInOutcome::Ok);
        assert!(signed_in.files_root.is_some_and(|root| root.starts_with(sim_files.to_str().unwrap())));
        assert!(!sim_files.exists(), "the agent must not create the files folder");
        assert_eq!(client.call::<AppsList>(Empty {}).await.unwrap().apps.len(), 7);

        let admin_config = config(admin_name);
        let status = tokio::task::spawn_blocking(move || {
            let info = ClientInfo { role: ClientRole::Admin, name: "test".into(), version: "0.0.0".into() };
            rulebox_ipc::client::call_once::<AdminStatus>(admin_config, info, Empty {})
        })
        .await
        .unwrap();
        let AdminStatusResult { extra, .. } = status.unwrap();
        let extra = extra.expect("a 1.1 agent sends extra");
        assert_eq!(extra.employee.as_deref(), Some("Maya Chen"));
        assert_eq!(extra.audit_queued, 0);
        assert_eq!((extra.admin_exit_failures, extra.admin_exit_locked_for_ms), (0, None));

        // The hidden exit end to end: a wrong PIN, then the demo PIN.
        let wrong = client
            .call::<AdminExitSubmit>(AdminExitSubmitParams { pin: "1111".into() })
            .await
            .unwrap();
        assert_eq!((wrong.outcome, wrong.attempts_left), (AdminExitOutcome::WrongPin, Some(4)));
        let right = client
            .call::<AdminExitSubmit>(AdminExitSubmitParams { pin: "2468".into() })
            .await
            .unwrap();
        assert_eq!(right.outcome, AdminExitOutcome::SigningOut);
        // The employee session went with it, and the client was told why.
        let session = client.call::<SessionGet>(Empty {}).await.unwrap();
        assert!(session.employee.is_none());
        let mut told = None;
        while let Ok(Some(event)) = tokio::time::timeout(Duration::from_secs(5), events.recv()).await {
            if let ClientEvent::ShuttingDown { reason, grace_ms } = event {
                told = Some((reason, grace_ms));
                break;
            }
        }
        assert_eq!(told, Some((rulebox_ipc::types::ShutdownReason::AdminExit, 2000)));

        shutdown.cancel();
        task.await.unwrap().unwrap();
        // The state files of Step 6a are in the state directory.
        let state = dir.path().join("state");
        assert!(state.join("employee-cache.json").is_file());
        assert!(state.join("lockouts.json").is_file());
    }

    #[tokio::test]
    async fn the_demo_world_is_refused_on_a_real_agent() {
        let dir = TempDir::new();
        let mut deps = test_deps(&dir);
        deps.simulate = false;
        deps.sim = SimOptions { demo: true, ..SimOptions::default() };
        let (_control_tx, control_rx) = mpsc::unbounded_channel();
        let error = run(deps, CancellationToken::new(), control_rx).await.unwrap_err();
        assert!(error.to_string().contains("--sim-demo"), "{error:#}");
    }

    #[test]
    fn pipe_names_follow_the_mode() {
        let production = PipeNames::for_mode(false);
        assert_eq!(production.shell, r"\\.\pipe\dev.rulebox.agent.shell");
        assert_eq!(production.admin, r"\\.\pipe\dev.rulebox.agent.admin");
        let simulated = PipeNames::for_mode(true);
        assert_eq!(simulated.shell, r"\\.\pipe\dev.rulebox.agent.shell.sim");
        assert_eq!(simulated.admin, r"\\.\pipe\dev.rulebox.agent.admin.sim");
    }

    /// Step 6 end to end on the simulated agent: both pipes start at once, the
    /// shell pipe says protocol 1.1 and the snapshot, the admin pipe answers
    /// `status`, and shutdown reaches the connected client.
    #[tokio::test]
    async fn run_serves_both_pipes_in_simulate_mode() {
        use rulebox_ipc::client::{CallError, ClientConfig, ClientEvent, IpcClient};
        use rulebox_ipc::methods::{Empty, ShellHeartbeat, ShellReady, StateGet};
        use rulebox_ipc::types::{ClientInfo, ClientRole};
        use rulebox_win32::sid::current_user_sid;

        let dir = TempDir::new();
        let deps = test_deps(&dir);
        let (shell_name, admin_name) = (deps.pipes.shell.clone(), deps.pipes.admin.clone());
        let shutdown = CancellationToken::new();
        let (_control_tx, control_rx) = mpsc::unbounded_channel();
        let task = tokio::spawn(run(deps, shutdown.clone(), control_rx));

        let me = current_user_sid().unwrap();
        let config = |name: String| ClientConfig {
            pipe_name: name,
            trusted_owner: me.clone(),
            request_timeout: Duration::from_secs(5),
            require_session_zero: false,
        };
        let info = ClientInfo { role: ClientRole::Shell, name: "test".into(), version: "0.0.0".into() };
        let (client, mut events) = IpcClient::spawn_with(info, config(shell_name));
        let linked = tokio::time::timeout(Duration::from_secs(10), events.recv()).await.unwrap().unwrap();
        match linked {
            ClientEvent::Linked(hello) => {
                assert_eq!((hello.protocol.major, hello.protocol.minor), (1, 4));
                // No employee directory: no `session` or `apps`; the exit and the 1.3 capabilities
                // are always listed.
                assert_eq!(
                    hello.capabilities,
                    ["state", "health", "adminExit", "deviceLock", "broadcasts", "keyboardPolicy", "permissionReports"]
                );
            }
            other => panic!("unexpected {other:?}"),
        }
        let snapshot = client.call::<StateGet>(Empty {}).await.unwrap();
        assert_eq!(snapshot.enrollment, EnrollmentStatus::NotEnrolled);
        // No document, so no PIN: the exit is off and says so.
        assert_eq!(snapshot.admin_exit.as_ref().map(|exit| exit.enabled), Some(false));
        let disabled = client
            .call::<rulebox_ipc::methods::AdminExitSubmit>(rulebox_ipc::requests::AdminExitSubmitParams {
                pin: "2468".into(),
            })
            .await
            .unwrap();
        assert_eq!(disabled.outcome, rulebox_ipc::requests::AdminExitOutcome::Disabled);
        client.call::<ShellReady>(Empty {}).await.unwrap();
        client.call::<ShellHeartbeat>(Empty {}).await.unwrap();

        // The admin pipe: status works, enroll is not available yet.
        let admin_config = config(admin_name);
        let (status, enroll) = tokio::task::spawn_blocking(move || {
            use rulebox_ipc::admin::{AdminEnroll, AdminEnrollParams, AdminStatus};
            let info = ClientInfo { role: ClientRole::Admin, name: "test".into(), version: "0.0.0".into() };
            let status = rulebox_ipc::client::call_once::<AdminStatus>(admin_config.clone(), info.clone(), Empty {});
            let params = AdminEnrollParams { code: "RBX1.x".into(), device_name: None, allow_joined: false };
            let enroll = rulebox_ipc::client::call_once::<AdminEnroll>(admin_config, info, params);
            (status, enroll)
        })
        .await
        .unwrap();
        assert_eq!(status.unwrap().snapshot, snapshot);
        match enroll {
            Err(CallError::Rpc(error)) => {
                assert_eq!(error.code, rulebox_ipc::ErrorCode::OperationFailed);
            }
            other => panic!("unexpected {other:?}"),
        }

        shutdown.cancel();
        let mut saw_shutting_down = false;
        while let Ok(Some(event)) = tokio::time::timeout(Duration::from_secs(5), events.recv()).await {
            if matches!(event, ClientEvent::ShuttingDown { .. }) {
                saw_shutting_down = true;
                break;
            }
        }
        assert!(saw_shutting_down, "the client must be told the agent is stopping");
        task.await.unwrap().unwrap();
    }
}

/// Step 8 end to end: the real `run`, a scripted backend, and the admin and shell
/// pipes (the CLI helpers of `ipc_admin` are the code `rulebox-agent enroll`,
/// `status` and `unenroll` run).
#[cfg(test)]
mod backend_tests {
    use super::*;

    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine as _;
    use rulebox_ipc::client::{ClientConfig, ClientEvent, IpcClient};
    use rulebox_ipc::methods::{AdminExitSubmit, Empty, SessionGet, SessionSignIn, StateGet};
    use rulebox_ipc::requests::{AdminExitOutcome, AdminExitSubmitParams, SignInOutcome, SignInParams};
    use rulebox_ipc::types::{ClientInfo, ClientRole};
    use rulebox_win32::sid::current_user_sid;
    use serde_json::json;

    use crate::backend::fake::FakeBackend;
    use crate::backend::{Backend, BackendError, BackendEvent, DesiredFetch};
    use crate::platform::sim::SimPlatform;
    use crate::state::{StaffAccount, StateStore};
    use crate::testutil::{unique_pipe_name, TempDir};

    const TOKEN: &str = "0123456789ABCDEFGHJK";
    const PIN: &str = "2468";

    fn code() -> String {
        format!("RBX1.{}", URL_SAFE_NO_PAD.encode(format!("https://test.convex.cloud#{TOKEN}")))
    }

    fn deps_for(dir: &std::path::Path, fake: &FakeBackend) -> Deps {
        let fake = fake.clone();
        Deps {
            platform: Arc::new(SimPlatform::new(dir.to_path_buf())),
            backend_factory: Arc::new(move |_| Ok(Arc::new(fake.clone()) as Arc<dyn Backend>)),
            paths: DataPaths::new(dir.to_path_buf()),
            install: InstallPaths::new(dir.join("install")),
            config: AgentConfig::default(),
            simulate: true,
            pipes: PipeNames { shell: unique_pipe_name(), admin: unique_pipe_name() },
            directory: DirectorySetup::Use(Arc::new(crate::directory::FixtureDirectory::new(false))),
            // (Step 13) The reports go to the fake backend.
            audit_sink: SinkSetup::Convex,
            sim: SimOptions::default(),
            downloader: Arc::new(crate::installs::download::fake::NoDownloads),
        }
    }

    struct Running {
        shutdown: CancellationToken,
        task: tokio::task::JoinHandle<anyhow::Result<()>>,
        shell: String,
        admin: String,
    }

    impl Running {
        /// Starts the agent and waits until its admin pipe answers.
        async fn start(deps: Deps) -> Self {
            let (shell, admin) = (deps.pipes.shell.clone(), deps.pipes.admin.clone());
            let shutdown = CancellationToken::new();
            let (control_tx, control_rx) = mpsc::unbounded_channel();
            // Keep the control sender alive for as long as the agent runs.
            std::mem::forget(control_tx);
            let task = tokio::spawn(run(deps, shutdown.clone(), control_rx));
            let running = Self { shutdown, task, shell, admin };
            let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
            loop {
                let config = running.config(&running.admin);
                let exit = tokio::task::spawn_blocking(move || {
                    ipc_admin::run_status(config, false, &mut Vec::new(), &mut Vec::new())
                })
                .await
                .unwrap();
                if exit == 0 {
                    break;
                }
                assert!(tokio::time::Instant::now() < deadline, "the admin pipe never came up");
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            running
        }

        async fn stop(self) {
            self.shutdown.cancel();
            self.task.await.unwrap().unwrap();
        }

        fn config(&self, pipe: &str) -> ClientConfig {
            ClientConfig {
                pipe_name: pipe.to_string(),
                trusted_owner: current_user_sid().unwrap(),
                request_timeout: Duration::from_secs(10),
                require_session_zero: false,
            }
        }

        async fn enroll(&self, code: String) -> (u8, String, String) {
            let config = self.config(&self.admin);
            tokio::task::spawn_blocking(move || {
                let (mut out, mut err) = (Vec::new(), Vec::new());
                let params = rulebox_ipc::admin::AdminEnrollParams {
                    code,
                    device_name: Some("Front desk".into()),
                    allow_joined: false,
                };
                let exit = ipc_admin::run_enroll(config, params, &mut out, &mut err);
                (exit, String::from_utf8(out).unwrap(), String::from_utf8(err).unwrap())
            })
            .await
            .unwrap()
        }

        async fn unenroll(&self, remove_staff_account: bool) -> (u8, String, String) {
            let config = self.config(&self.admin);
            tokio::task::spawn_blocking(move || {
                let (mut out, mut err) = (Vec::new(), Vec::new());
                let params = rulebox_ipc::admin::AdminUnenrollParams { remove_staff_account };
                let exit = ipc_admin::run_unenroll(config, params, &mut out, &mut err);
                (exit, String::from_utf8(out).unwrap(), String::from_utf8(err).unwrap())
            })
            .await
            .unwrap()
        }

        async fn status(&self) -> String {
            let config = self.config(&self.admin);
            tokio::task::spawn_blocking(move || {
                let (mut out, mut err) = (Vec::new(), Vec::new());
                let exit = ipc_admin::run_status(config, false, &mut out, &mut err);
                assert_eq!(exit, 0, "{}", String::from_utf8_lossy(&err));
                String::from_utf8(out).unwrap()
            })
            .await
            .unwrap()
        }

        /// Polls `status` until every fragment is in it.
        async fn wait_status(&self, fragments: &[&str]) -> String {
            let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
            loop {
                let text = self.status().await;
                if fragments.iter().all(|fragment| text.contains(fragment)) {
                    return text;
                }
                assert!(tokio::time::Instant::now() < deadline, "status never showed {fragments:?}:\n{text}");
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }

        async fn shell_client(&self) -> (IpcClient, mpsc::Receiver<ClientEvent>) {
            let info = ClientInfo { role: ClientRole::Shell, name: "test".into(), version: "0.0.0".into() };
            let (client, mut events) = IpcClient::spawn_with(info, self.config(&self.shell));
            match tokio::time::timeout(Duration::from_secs(10), events.recv()).await.unwrap().unwrap() {
                ClientEvent::Linked(_) => {}
                other => panic!("unexpected {other:?}"),
            }
            (client, events)
        }
    }

    fn document(version: u64, kiosk_enabled: bool, hotkey: Option<&str>) -> serde_json::Value {
        let mut admin_exit = json!({ "pinHash": crate::kdf::hash_secret(PIN).unwrap() });
        if let Some(hotkey) = hotkey {
            admin_exit["hotkey"] = json!(hotkey);
        }
        json!({
            "kioskEnabled": kiosk_enabled, "apps": [], "allowedSites": [], "fileHandlers": {},
            "storage": { "defaultQuotaGb": 0 }, "branding": { "name": "Rulebox" }, "version": version,
            "adminExit": admin_exit
        })
    }

    fn push(fake: &FakeBackend, version: u64, doc: serde_json::Value) {
        fake.publish_doc(version, doc);
    }

    #[tokio::test]
    async fn the_cli_path_enrolls_syncs_reports_and_unenrolls_against_a_fake_backend() {
        let dir = TempDir::new();
        let fake = FakeBackend::new();
        let agent = Running::start(deps_for(dir.path(), &fake)).await;

        let text = agent.status().await;
        assert!(text.contains("enrollment    : notEnrolled"), "{text}");

        // `rulebox-agent enroll <code>`
        let (exit, out, err) = agent.enroll(code()).await;
        assert_eq!(exit, 0, "{err}");
        assert_eq!(out, "Enrolled as \"Front desk\" (dev-1).\n");
        let calls = fake.enroll_calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].token, TOKEN);
        assert_eq!(calls[0].device_name, "Front desk");

        // The same command again: `error: already_enrolled: ...`, exit code 3, and no
        // second call reached the backend.
        let (exit, out, err) = agent.enroll(code()).await;
        assert_eq!((exit, out.as_str()), (3, ""));
        assert!(err.starts_with("error: already_enrolled: "), "{err}");
        assert_eq!(fake.enroll_calls().len(), 1);

        // `status`: enrolled; online once the connection comes up; the document
        // arrives without anyone asking for it.
        // (Step 9) The reconciler enabled the kiosk right after enrollment (Q12).
        agent
            .wait_status(&[
                "enrollment    : enrolled",
                "device        : Front desk (dev-1)",
                "enabled=true phase=applied error=-",
            ])
            .await;
        fake.push(BackendEvent::Connection(ConnectionStatus::Online));
        push(&fake, 3, document(3, true, Some("ctrl+alt+k")));
        let text = agent
            .wait_status(&["connection    : online", "policy        : version 3", "admin exit    : on (Ctrl+Alt+K)"])
            .await;
        assert!(!text.contains("argon2"), "{text}");

        // (Step 13) The status leaves with the first report (the ping carries
        // none); it is sent soon after the connection came up.
        fake.wait_until("a report with the status", |f| f.report_calls().iter().any(|r| r.batch.status.is_some())).await;
        let first = fake.report_calls().into_iter().find(|r| r.batch.status.is_some()).unwrap();
        assert_eq!(first.auth.device_id, "dev-1");
        let status = first.batch.status.expect("the report carries the status");
        assert_eq!(status.agent_version, env!("CARGO_PKG_VERSION"));
        // Step 9: the reconciler writes `last_applied_version` after a successful
        // reconcile, so the report says 3. A report that went in the
        // milliseconds before that reconcile finished reports 0; the next one (minutes
        // later) carries the change, so both are right here.
        assert!(matches!(status.applied_version, Some(0 | 3)), "{:?}", status.applied_version);
        // The first report goes out as soon as the connection is up, possibly while the
        // first reconcile still runs (the next one, a minute later, has the change).
        assert!(matches!(status.kiosk_phase.as_deref(), Some("applied" | "applying" | "notApplied")), "{:?}", status.kiosk_phase);
        let state_file = dir.path().join("state").join("agent-state.json");
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        loop {
            let saved = std::fs::read_to_string(&state_file).unwrap();
            if saved.contains("\"lastAppliedVersion\": 3") {
                break;
            }
            assert!(tokio::time::Instant::now() < deadline, "the applied version was never saved:\n{saved}");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }

        // `rulebox-agent unenroll`
        let (exit, out, err) = agent.unenroll(false).await;
        assert_eq!(exit, 0, "{err}");
        assert_eq!(out, "This PC is no longer enrolled.\n");
        assert_eq!(fake.unenroll_calls().len(), 1);
        let text = agent.wait_status(&["enrollment    : notEnrolled", "connection    : offline"]).await;
        assert!(text.contains("admin exit    : off"), "{text}");
        // Unenrolling switched the kiosk off first (Section 5.6 "Disable").
        assert!(text.contains("enabled=false phase=applied error=-"), "{text}");
        assert!(!dir.path().join("state").join("desired-state.json").exists());

        // And it can be enrolled again.
        let (exit, _, err) = agent.enroll(code()).await;
        assert_eq!(exit, 0, "{err}");
        agent.stop().await;
    }

    #[tokio::test]
    async fn every_enrollment_failure_reaches_the_cli_with_its_reason_and_exit_code_3() {
        let cases = [
            (BackendError::Rejected { code: "token_used_up".into() }, "token_used_up", false),
            (BackendError::Rejected { code: "token_expired".into() }, "token_expired", false),
            (BackendError::Rejected { code: "token_revoked".into() }, "token_revoked", false),
            (BackendError::Rejected { code: "token_invalid".into() }, "token_invalid", false),
            (BackendError::Rejected { code: "invalid_request".into() }, "backend_rejected", false),
            (BackendError::Timeout, "backend_unreachable", true),
            (BackendError::Unreachable, "backend_unreachable", true),
        ];
        for (backend_error, reason, retryable) in cases {
            let dir = TempDir::new();
            let fake = FakeBackend::new();
            fake.script_enroll(Err(backend_error.clone()));
            let agent = Running::start(deps_for(dir.path(), &fake)).await;
            let (exit, _, err) = agent.enroll(code()).await;
            assert_eq!(exit, 3, "{backend_error:?}");
            assert!(err.starts_with(&format!("error: {reason}: ")), "{backend_error:?}: {err}");
            assert_eq!(err.trim_end().ends_with("Try again."), retryable, "{backend_error:?}: {err}");
            agent.stop().await;
        }

        // A code that is not a code, and a PC that is blocked: no backend call.
        let dir = TempDir::new();
        let fake = FakeBackend::new();
        let deps = deps_for(dir.path(), &fake);
        let platform = Arc::new(SimPlatform::new(dir.path().to_path_buf()));
        platform.with_world(|w| w.legal_notice = true);
        let deps = Deps { platform, ..deps };
        let agent = Running::start(deps).await;
        let (exit, _, err) = agent.enroll("not-a-code".into()).await;
        assert_eq!(exit, 3);
        assert!(err.starts_with("error: code_invalid: "), "{err}");
        let (exit, _, err) = agent.enroll(code()).await;
        assert_eq!(exit, 3);
        assert!(err.starts_with("error: compat_blocked: ") && err.contains("  - legal_notice"), "{err}");
        assert!(fake.enroll_calls().is_empty());
        agent.stop().await;
    }

    /// Plan Step 8 tests 12 to 14 and Section 5.8 end to end: the exit PIN lives in
    /// the cached document, survives a restart with no connection, rotates and
    /// disappears with the document, and a revocation keeps it while it ends the
    /// employee's session.
    #[tokio::test]
    async fn the_document_drives_the_exit_across_restarts_and_a_revocation_keeps_it() {
        let dir = TempDir::new();
        // The Staff profile is known, so the fixture employees can sign in.
        {
            let paths = DataPaths::new(dir.path().to_path_buf());
            let store = StateStore::open(&paths.state_dir()).unwrap();
            let state = AgentState {
                staff: Some(StaffAccount {
                    sid: "S-1-5-21-1-1-1-2001".into(),
                    user_name: "RuleboxStaff".into(),
                    profile_dir: Some(dir.path().join("profile").to_string_lossy().into_owned()),
                }),
                ..AgentState::default()
            };
            store.save(&state).unwrap();
        }

        // Run 1: enroll, go online, receive a document with a PIN.
        let fake = FakeBackend::new();
        let agent = Running::start(deps_for(dir.path(), &fake)).await;
        let (exit, _, err) = agent.enroll(code()).await;
        assert_eq!(exit, 0, "{err}");
        fake.push(BackendEvent::Connection(ConnectionStatus::Online));
        push(&fake, 5, document(5, true, None));
        agent.wait_status(&["admin exit    : on (Ctrl+Shift+F12)", "policy        : version 5"]).await;
        let cache = std::fs::read_to_string(dir.path().join("state").join("desired-state.json")).unwrap();
        assert!(cache.contains("argon2id"), "the cache keeps the hash");
        // The snapshot the Staff App reads does not.
        let (client, mut events) = agent.shell_client().await;
        let snapshot = client.call::<StateGet>(Empty {}).await.unwrap();
        assert!(snapshot.admin_exit.as_ref().unwrap().enabled);
        assert!(!serde_json::to_string(&snapshot).unwrap().contains("argon2"));

        // A different hotkey: exactly one state.changed, with the canonical text.
        while tokio::time::timeout(Duration::from_millis(300), events.recv()).await.is_ok() {}
        push(&fake, 6, document(6, true, Some("shift+ctrl+f11")));
        let mut changed = Vec::new();
        while let Ok(Some(event)) = tokio::time::timeout(Duration::from_millis(800), events.recv()).await {
            if let ClientEvent::StateChanged(snapshot) = event {
                changed.push(snapshot);
            }
        }
        assert_eq!(changed.len(), 1, "{changed:?}");
        assert_eq!(changed[0].admin_exit.as_ref().unwrap().hotkey, "Ctrl+Shift+F11");

        // An employee signs in online, then the device is revoked remotely.
        let signed_in = client
            .call::<SessionSignIn>(SignInParams { username: "maya".into(), password: "demo".into() })
            .await
            .unwrap();
        assert_eq!(signed_in.outcome, SignInOutcome::Ok);
        fake.push(BackendEvent::Desired(DesiredFetch::Revoked));
        agent.wait_status(&["enrollment    : revoked", "connection    : offline"]).await;
        let session = client.call::<SessionGet>(Empty {}).await.unwrap();
        assert!(session.employee.is_none(), "a revocation ends the employee session");
        // The exit PIN keeps working on a revoked PC, and the kiosk is untouched:
        // no kiosk-disable was triggered (the state file still has no kiosk record
        // change and the cached document is still there).
        assert!(dir.path().join("state").join("desired-state.json").exists());
        let right = client
            .call::<AdminExitSubmit>(AdminExitSubmitParams { pin: PIN.into() })
            .await
            .unwrap();
        assert_eq!(right.outcome, AdminExitOutcome::SigningOut);
        drop(client);
        agent.stop().await;

        // Run 2: a restart with a backend that never connects. The revoked
        // enrollment is remembered, nothing is synced, and the exit still works.
        let silent = FakeBackend::new();
        let agent = Running::start(deps_for(dir.path(), &silent)).await;
        let (client, _events) = agent.shell_client().await;
        let snapshot = client.call::<StateGet>(Empty {}).await.unwrap();
        assert_eq!(snapshot.enrollment, EnrollmentStatus::Revoked);
        assert_eq!(snapshot.connection, ConnectionStatus::Offline);
        assert_eq!(snapshot.desired_state_version, 6);
        assert!(snapshot.admin_exit.as_ref().unwrap().enabled);
        assert!(silent.subscriptions().is_empty(), "a revoked device does not subscribe");
        let right = client
            .call::<AdminExitSubmit>(AdminExitSubmitParams { pin: PIN.into() })
            .await
            .unwrap();
        assert_eq!(right.outcome, AdminExitOutcome::SigningOut);
        drop(client);

        // It can be unenrolled locally; the backend answering "rejected" is fine.
        silent.script_unenroll(Err(BackendError::Rejected { code: "rejected".into() }));
        let (exit, _, err) = agent.unenroll(false).await;
        assert_eq!(exit, 0, "{err}");
        agent.wait_status(&["enrollment    : notEnrolled", "admin exit    : off"]).await;
        agent.stop().await;
    }

    /// `document` with the device lock of plan 4.17.
    fn locked_document(version: u64, lock_id: &str) -> serde_json::Value {
        let mut doc = document(version, true, None);
        doc["deviceLock"] = json!({ "lockId": lock_id, "message": "Call the front desk", "contact": "Ext 12", "lockedAtMs": 1 });
        doc
    }

    /// Plan Step 15 tests: lock while an employee is signed in (session ended, sign-in refused), the admin
    /// exit does not lift it, a restart offline keeps it, a lost cache keeps it, a revocation keeps it, and
    /// only a newer verified document without a lock clears it (for good, also across a restart).
    #[tokio::test]
    async fn a_device_lock_ends_the_session_and_survives_exit_restart_lost_cache_and_revocation_until_a_document_unlocks() {
        let dir = TempDir::new();
        {
            let paths = DataPaths::new(dir.path().to_path_buf());
            let store = StateStore::open(&paths.state_dir()).unwrap();
            let state = AgentState {
                staff: Some(StaffAccount {
                    sid: "S-1-5-21-1-1-1-2001".into(),
                    user_name: "RuleboxStaff".into(),
                    profile_dir: Some(dir.path().join("profile").to_string_lossy().into_owned()),
                }),
                ..AgentState::default()
            };
            store.save(&state).unwrap();
        }
        let state_file = dir.path().join("state").join("agent-state.json");
        let saved_lock = || std::fs::read_to_string(&state_file).unwrap().contains("\"deviceLock\"");

        // Run 1: an employee is signed in, then the lock arrives.
        let fake = FakeBackend::new();
        let agent = Running::start(deps_for(dir.path(), &fake)).await;
        let (exit, _, err) = agent.enroll(code()).await;
        assert_eq!(exit, 0, "{err}");
        fake.push(BackendEvent::Connection(ConnectionStatus::Online));
        push(&fake, 5, document(5, true, None));
        agent.wait_status(&["policy        : version 5"]).await;
        let (client, mut events) = agent.shell_client().await;
        assert!(client.call::<StateGet>(Empty {}).await.unwrap().device_lock.is_none());
        let signed_in =
            client.call::<SessionSignIn>(SignInParams { username: "maya".into(), password: "demo".into() }).await.unwrap();
        assert_eq!(signed_in.outcome, SignInOutcome::Ok);
        assert!(!saved_lock());

        push(&fake, 6, locked_document(6, "lock-1"));
        let ended = loop {
            match tokio::time::timeout(Duration::from_secs(10), events.recv()).await.unwrap().unwrap() {
                ClientEvent::SessionEnded(reason) => break reason,
                _ => continue,
            }
        };
        assert_eq!(ended, rulebox_ipc::requests::SessionEndReason::DeviceLocked);
        assert!(client.call::<SessionGet>(Empty {}).await.unwrap().employee.is_none());
        let snapshot = client.call::<StateGet>(Empty {}).await.unwrap();
        assert_eq!(snapshot.device_lock.as_ref().map(|lock| lock.lock_id.as_str()), Some("lock-1"));
        assert_eq!(snapshot.device_lock.as_ref().and_then(|lock| lock.contact.as_deref()), Some("Ext 12"));
        let refused =
            client.call::<SessionSignIn>(SignInParams { username: "maya".into(), password: "demo".into() }).await.unwrap();
        assert_eq!(refused.outcome, SignInOutcome::DeviceLocked);
        assert!(saved_lock(), "the lock is on disk at accept time");

        // The hidden admin exit still works, and it does not lift the lock.
        let right = client.call::<AdminExitSubmit>(AdminExitSubmitParams { pin: PIN.into() }).await.unwrap();
        assert_eq!(right.outcome, AdminExitOutcome::SigningOut);
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(client.call::<StateGet>(Empty {}).await.unwrap().device_lock.is_some());
        assert!(saved_lock());
        drop(client);
        agent.stop().await;

        // Run 2: a restart with no connection and the cache GONE: still locked, sign-in refused.
        std::fs::remove_file(dir.path().join("state").join("desired-state.json")).unwrap();
        let silent = FakeBackend::new();
        let agent = Running::start(deps_for(dir.path(), &silent)).await;
        let (client, _events) = agent.shell_client().await;
        let snapshot = client.call::<StateGet>(Empty {}).await.unwrap();
        assert_eq!(snapshot.connection, ConnectionStatus::Offline);
        assert_eq!(snapshot.device_lock.as_ref().map(|lock| lock.lock_id.as_str()), Some("lock-1"));
        let refused =
            client.call::<SessionSignIn>(SignInParams { username: "maya".into(), password: "demo".into() }).await.unwrap();
        assert_eq!(refused.outcome, SignInOutcome::DeviceLocked);
        drop(client);

        // Revoked while locked: the lock stays.
        silent.push(BackendEvent::Desired(DesiredFetch::Revoked));
        agent.wait_status(&["enrollment    : revoked"]).await;
        let (client, _events) = agent.shell_client().await;
        assert!(client.call::<StateGet>(Empty {}).await.unwrap().device_lock.is_some());
        drop(client);
        agent.stop().await;

        // Run 3: still revoked and locked after another restart. (A revoked PC does not sync, so nothing can unlock it.)
        let silent = FakeBackend::new();
        let agent = Running::start(deps_for(dir.path(), &silent)).await;
        let (client, _events) = agent.shell_client().await;
        let snapshot = client.call::<StateGet>(Empty {}).await.unwrap();
        assert_eq!((snapshot.enrollment, snapshot.device_lock.is_some()), (EnrollmentStatus::Revoked, true));
        drop(client);
        agent.stop().await;
    }

    #[tokio::test]
    async fn only_a_newer_verified_document_without_a_lock_unlocks_and_the_unlock_is_remembered() {
        let dir = TempDir::new();
        let state_file = dir.path().join("state").join("agent-state.json");
        let fake = FakeBackend::new();
        let agent = Running::start(deps_for(dir.path(), &fake)).await;
        agent.enroll(code()).await;
        fake.push(BackendEvent::Connection(ConnectionStatus::Online));
        push(&fake, 5, locked_document(5, "lock-1"));
        agent.wait_status(&["policy        : version 5"]).await;
        let (client, _events) = agent.shell_client().await;
        assert!(client.call::<StateGet>(Empty {}).await.unwrap().device_lock.is_some());

        // The same version again, or an older document: not an unlock.
        push(&fake, 4, document(4, true, None));
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(client.call::<StateGet>(Empty {}).await.unwrap().device_lock.is_some(), "an older document cannot unlock");

        // A newer one without the lock does.
        push(&fake, 6, document(6, true, None));
        agent.wait_status(&["policy        : version 6"]).await;
        assert!(client.call::<StateGet>(Empty {}).await.unwrap().device_lock.is_none());
        assert!(!std::fs::read_to_string(&state_file).unwrap().contains("\"deviceLock\""));
        drop(client);
        agent.stop().await;

        let silent = FakeBackend::new();
        let agent = Running::start(deps_for(dir.path(), &silent)).await;
        let (client, _events) = agent.shell_client().await;
        assert!(client.call::<StateGet>(Empty {}).await.unwrap().device_lock.is_none(), "the unlock survives a restart");
        drop(client);
        agent.stop().await;
    }

    #[tokio::test]
    async fn an_older_cache_than_the_newest_accepted_document_keeps_the_lock_of_that_document() {
        // The cache says "locked" (v5) but the newest accepted document (v6) said "unlocked" and the cache write
        // was lost: the lock of the newest accepted document wins (and the other way round).
        let dir = TempDir::new();
        let fake = FakeBackend::new();
        let agent = Running::start(deps_for(dir.path(), &fake)).await;
        agent.enroll(code()).await;
        fake.push(BackendEvent::Connection(ConnectionStatus::Online));
        push(&fake, 5, locked_document(5, "lock-1"));
        agent.wait_status(&["policy        : version 5"]).await;
        agent.stop().await;
        let paths = DataPaths::new(dir.path().to_path_buf());
        let store = StateStore::open(&paths.state_dir()).unwrap();
        let mut state = store.load().unwrap();
        state.accepted_version = 6;
        state.device_lock = None;
        store.save(&state).unwrap();

        let silent = FakeBackend::new();
        let agent = Running::start(deps_for(dir.path(), &silent)).await;
        let (client, _events) = agent.shell_client().await;
        assert!(client.call::<StateGet>(Empty {}).await.unwrap().device_lock.is_none());
        drop(client);
        agent.stop().await;
    }

    #[tokio::test]
    async fn an_enrolled_agent_that_restarts_offline_shows_the_cached_state_and_offline() {
        let dir = TempDir::new();
        let fake = FakeBackend::new();
        let agent = Running::start(deps_for(dir.path(), &fake)).await;
        agent.enroll(code()).await;
        fake.push(BackendEvent::Connection(ConnectionStatus::Online));
        push(&fake, 8, document(8, false, None));
        agent.wait_status(&["policy        : version 8", "connection    : online"]).await;
        agent.stop().await;

        let silent = FakeBackend::new();
        let agent = Running::start(deps_for(dir.path(), &silent)).await;
        let text = agent
            .wait_status(&["enrollment    : enrolled", "connection    : offline", "policy        : version 8"])
            .await;
        assert!(text.contains("admin exit    : on"), "{text}");
        // It subscribes with the saved secret; a document older than the cached one
        // is stale and changes nothing.
        silent.wait_for_subscription().await;
        assert_eq!(silent.subscriptions()[0].device_id, "dev-1");
        push(&silent, 2, document(2, true, None));
        tokio::time::sleep(Duration::from_millis(300)).await;
        let text = agent.status().await;
        assert!(text.contains("policy        : version 8"), "{text}");
        agent.stop().await;
    }
}
