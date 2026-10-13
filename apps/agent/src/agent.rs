//! The single entry point for service mode and console mode. It loads the
//! state, builds the first snapshot and runs the IPC servers (Step 6); the other
//! tasks of Section 5.2 are added in later steps.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{bail, Context};
use rulebox_ipc::types::{
    AgentSnapshot, ConnectionStatus, DeviceInfo, DisplayMode, EnrollmentStatus, ShellHealth, ShellStatus,
};
use rulebox_ipc::{ADMIN_PIPE, SHELL_PIPE, SIM_SUFFIX};
use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, watch};
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

use crate::admin_exit::{AdminExit, AdminExitDeps, ExitRequest};
use crate::agent_policy::AgentPolicy;
use crate::audit::{run_audit_task, AuditHandle, AuditQueue, AuditSink};
use crate::backend::task::{apply_to_snapshot, note_clock, os_jitter, BackendRunner, TaskContext};
use crate::backend::BackendFactory;
use crate::directory::EmployeeDirectory;
use crate::employee_cache::EmployeeCache;
use crate::enroll::{EnrollDeps, Enroller, Timings};
use crate::fixtures;
use crate::ipc_admin::{self, AdminPipe, WithStatusExtra};
use crate::ipc_shell::{self, ShellBroadcast, ShellExtension, ShellPipe, ShellSignal};
use crate::kiosk::{kiosk_status, spawn_reconciler, ReconcilerDeps};
use crate::kiosk_control::KioskControl;
use crate::lockout::LockoutStore;
use crate::paths::{DataPaths, InstallPaths};
use crate::platform::{Platform, ShellMechanism};
use crate::session::{SessionDeps, SessionManager, SessionTimeouts};
use crate::state::{read_json, unix_ms, AgentState, SharedState, SnapshotHandle, StateStore};

/// RAM at or below this many MB selects Lite mode (PRD 22.5).
const LITE_MODE_MAX_RAM_MB: u64 = 4352;
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
    /// (1.1) Asks for the demo employee directory. Honoured on a real agent only
    /// when the test-machine marker is present too (`directory::choose`).
    pub fixture_directory: bool,
    /// (Step 9) Where the Staff account's shell value is written: `"policyShell"`
    /// (default) or `"winlogonShell"` (plan Section 10.2, "Sign-in and shell").
    pub shell_mechanism: ShellMechanism,
}

impl Default for AgentConfig {
    fn default() -> Self {
        Self { kill_hung_shell: true, fixture_directory: false, shell_mechanism: ShellMechanism::default() }
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
    /// (1.1) The employee directory seam. The caller applies `directory::choose`;
    /// Phase 4 replaces only this value.
    pub directory: Arc<dyn EmployeeDirectory>,
    /// (1.1) Where the audit queue is delivered.
    pub audit_sink: Arc<dyn AuditSink>,
    pub sim: SimOptions,
}

pub fn load_config(paths: &DataPaths) -> anyhow::Result<AgentConfig> {
    let loaded = read_json(&paths.agent_config()).context("read agent-config.json")?;
    Ok(loaded.unwrap_or_default())
}

/// `desired-state.json`: the last document the backend sent, as received. `doc`
/// is the **raw** document, so the agent-only keys of Section 5.10 (the exit PIN
/// hash among them) survive a restart while offline. Step 8 writes the file;
/// Step 6b only reads it.
#[derive(Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CachedDesired {
    pub version: u64,
    pub doc: serde_json::Value,
    #[serde(default)]
    pub signature: Option<String>,
}

impl std::fmt::Debug for CachedDesired {
    // Not derived: `doc` can hold the PIN hash.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CachedDesired")
            .field("version", &self.version)
            .field("signed", &self.signature.is_some())
            .finish_non_exhaustive()
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

/// The snapshot shown to the Staff App before any backend contact. The protocol
/// 1.1 fields `adminExit`, `power` and `orgName` come from `policy` (never the
/// PIN hash).
pub fn initial_snapshot(
    state: &AgentState,
    platform: &dyn Platform,
    _config: &AgentConfig,
    policy: &AgentPolicy,
) -> AgentSnapshot {
    let ram_mb = platform.os_info().map(|os| os.ram_mb);
    let display_mode = match ram_mb {
        Ok(mb) if mb <= LITE_MODE_MAX_RAM_MB => DisplayMode::Lite,
        _ => DisplayMode::Standard,
    };
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
    };
    policy.apply_to_snapshot(&mut snapshot);
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
    let store = StateStore::open(&deps.paths.state_dir()).context("open the state directory")?;
    let state = store.load().context("load the agent state")?;
    // (1.1) The agent-only keys of the desired-state document: the demo document in
    // demo mode, otherwise the cached one (the backend task keeps it current). No
    // document means no exit PIN, so the admin exit is off.
    let cached = if deps.sim.demo { None } else { load_cached_desired(&deps.paths) };
    let policy_doc = if deps.sim.demo {
        Some(fixtures::demo_document())
    } else {
        cached.as_ref().map(|cached| cached.doc.clone())
    };
    let policy = AgentPolicy::from_doc(policy_doc.as_ref());
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
    if let (Some(cached), Some(_)) = (&cached, &state.enrollment) {
        if let Ok(desired) = serde_json::from_value::<rulebox_policy::DesiredState>(cached.doc.clone()) {
            apply_to_snapshot(&mut first_snapshot, &desired, cached.version, &policy);
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
    let session = SessionManager::new(SessionDeps {
        directory: Arc::clone(&deps.directory),
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
    let admin_exit = AdminExit::new(AdminExitDeps {
        policy_rx,
        lockouts: Arc::clone(&lockouts),
        audit: Arc::clone(&audit),
        session: Arc::clone(&session),
        exit_tx,
        now_ms: Arc::clone(&now_ms),
    });

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
    tasks.spawn(run_audit_task(
        Arc::clone(&audit),
        Arc::clone(&deps.audit_sink),
        snapshot_rx.clone(),
        shutdown.clone(),
    ));
    tasks.spawn(clear_session_when_not_enrolled(
        snapshot_rx.clone(),
        Arc::clone(&session),
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
            ],
            staff_sid_rx,
        },
        shutdown.clone(),
    ));
    tasks.spawn(log_shell_signals(signals_rx, shutdown.clone()));

    loop {
        tokio::select! {
            () = shutdown.cancelled() => break,
            event = control_rx.recv() => match event {
                Some(ControlEvent::SessionChanged { .. }) => reconciler.session_changed(),
                Some(ControlEvent::SessionLocked { session_id }) => reconciler.session_locked(session_id),
                Some(ControlEvent::PowerResumed) => reconciler.power_resumed(),
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

/// Consumes the shell connection signals until the watchdog (Step 13) takes them
/// over. Logs `shell.ready`, the first heartbeat of each connection at `info`
/// and the rest at `debug`.
async fn log_shell_signals(
    mut signals: mpsc::UnboundedReceiver<ShellSignal>,
    shutdown: CancellationToken,
) {
    let mut beating: HashSet<u64> = HashSet::new();
    loop {
        let signal = tokio::select! {
            () = shutdown.cancelled() => return,
            signal = signals.recv() => match signal {
                Some(signal) => signal,
                None => return,
            },
        };
        match signal {
            ShellSignal::Connected { .. } => {}
            ShellSignal::Ready { connection_id, pid } => {
                tracing::info!(connection_id, pid, "shell.ready");
            }
            ShellSignal::Heartbeat { connection_id, pid } => {
                if beating.insert(connection_id) {
                    tracing::info!(connection_id, pid, "shell.heartbeat (first on this connection)");
                } else {
                    tracing::debug!(connection_id, pid, "shell.heartbeat");
                }
            }
            ShellSignal::Closed { connection_id } => {
                beating.remove(&connection_id);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rulebox_ipc::types::KioskPhase;

    use crate::platform::sim::SimPlatform;
    use crate::state::{Enrollment, KioskApplied, KioskRecord};
    use crate::testutil::{unique_pipe_name, TempDir};

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
        let text = r#"{ "version": 7, "doc": { "adminExit": { "pinHash": "$argon2id$secret" }, "x": 1 },
                        "signature": "sig" }"#;
        std::fs::write(paths.desired_state(), text).unwrap();
        let cached = load_cached_desired(&paths).expect("a cached document");
        assert_eq!(cached.version, 7);
        assert_eq!(cached.doc["x"], 1);
        assert_eq!(cached.signature.as_deref(), Some("sig"));
        let debug = format!("{cached:?}");
        assert!(!debug.contains("argon2") && !debug.contains("pinHash"), "{debug}");

        // No signature in the file is fine (it is written unsigned until Phase 5).
        std::fs::write(paths.desired_state(), r#"{ "version": 1, "doc": {} }"#).unwrap();
        assert_eq!(load_cached_desired(&paths).unwrap().signature, None);

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
            directory: Arc::new(crate::directory::UnavailableDirectory),
            audit_sink: Arc::new(crate::audit::LogAuditSink),
            sim: SimOptions::default(),
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
        deps.directory = Arc::new(crate::directory::FixtureDirectory::new(false));
        deps.sim = SimOptions { demo: true, offline: false };
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
                assert_eq!(hello.capabilities, ["state", "health", "adminExit", "session", "apps"]);
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
        assert_eq!(client.call::<AppsList>(Empty {}).await.unwrap().apps.len(), 4);

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
        deps.sim = SimOptions { demo: true, offline: false };
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
                assert_eq!((hello.protocol.major, hello.protocol.minor), (1, 1));
                // No employee directory: no `session` or `apps`; the exit is always listed.
                assert_eq!(hello.capabilities, ["state", "health", "adminExit"]);
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
            directory: Arc::new(crate::directory::FixtureDirectory::new(false)),
            audit_sink: Arc::new(crate::audit::LogAuditSink),
            sim: SimOptions::default(),
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
        fake.push(BackendEvent::Desired(DesiredFetch::Doc { version, doc, signature: None }));
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

        // The first heartbeat comes after the 0 to 10 s jitter; it is the only
        // thing the agent sends on its own.
        fake.wait_until("a heartbeat", |f| !f.heartbeat_calls().is_empty()).await;
        let first = fake.heartbeat_calls()[0].clone();
        assert_eq!(first.auth.device_id, "dev-1");
        let status = first.status.expect("the first heartbeat carries the status");
        assert_eq!(status.agent_version, env!("CARGO_PKG_VERSION"));
        // Step 9: the reconciler writes `last_applied_version` after a successful
        // reconcile, so the heartbeat reports 3. A heartbeat that fired in the
        // milliseconds before that reconcile finished reports 0; the next one (minutes
        // later) carries the change, so both are right here.
        assert!(matches!(status.applied_version, Some(0 | 3)), "{:?}", status.applied_version);
        assert_eq!(status.kiosk_phase.as_deref(), Some("applied"));
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
