//! The single entry point for service mode and console mode. It loads the
//! state, builds the first snapshot and runs the IPC servers (Step 6); the other
//! tasks of Section 5.2 are added in later steps.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{bail, Context};
use rulebox_ipc::types::{
    AgentSnapshot, ConnectionStatus, DeviceInfo, DisplayMode, EnrollmentStatus, KioskPhase,
    KioskStatus, ShellHealth, ShellStatus,
};
use rulebox_ipc::{ADMIN_PIPE, SHELL_PIPE, SIM_SUFFIX};
use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, watch};
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

use crate::admin_exit::{run_exit, AdminExit, AdminExitDeps, ExitRequest};
use crate::agent_policy::AgentPolicy;
use crate::audit::{run_audit_task, AuditHandle, AuditQueue, AuditSink};
use crate::directory::EmployeeDirectory;
use crate::employee_cache::EmployeeCache;
use crate::fixtures;
use crate::ipc_admin::{self, AdminPipe, NotAvailableYet, WithStatusExtra};
use crate::ipc_shell::{self, ShellBroadcast, ShellExtension, ShellPipe, ShellSignal};
use crate::lockout::LockoutStore;
use crate::paths::{DataPaths, InstallPaths};
use crate::platform::Platform;
use crate::session::{SessionDeps, SessionManager, SessionTimeouts};
use crate::state::{read_json, unix_ms, AgentState, KioskApplied, StateStore};

/// RAM at or below this many MB selects Lite mode (PRD 22.5).
const LITE_MODE_MAX_RAM_MB: u64 = 4352;
/// How long `run` waits for the IPC tasks to wind down after shutdown.
const TASK_WIND_DOWN: Duration = Duration::from_secs(5);
/// The folder under the Staff profile that holds every employee's files folder.
const FILES_BASE_DIR: &str = "RuleboxFiles";
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
}

impl Default for AgentConfig {
    fn default() -> Self {
        Self { kill_hung_shell: true, fixture_directory: false }
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
    PowerResumed,
}

/// Everything `run` needs from the outside. The backend factory is added in Step 8.
pub struct Deps {
    pub platform: Arc<dyn Platform>,
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
    let kiosk = KioskStatus {
        enabled: state.kiosk.applied == KioskApplied::Enabled,
        phase: match state.kiosk.applied {
            KioskApplied::NotApplied => KioskPhase::NotApplied,
            _ if state.kiosk.last_error.is_some() => KioskPhase::Failed,
            _ => KioskPhase::Applied,
        },
        error_code: state.kiosk.last_error.clone(),
    };
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

/// The **stand-in** exit task of Step 6b (Step 9 replaces it with the reconciler,
/// which adds the exit hold of plan Section 5.10): takes the requests of
/// `adminExit.submit` one at a time and runs the sign-out flow for each.
async fn stand_in_exit_task(
    mut requests: mpsc::Receiver<ExitRequest>,
    platform: Arc<dyn Platform>,
    snapshot_rx: watch::Receiver<AgentSnapshot>,
    simulate: bool,
    broadcast: ShellBroadcast,
    shutdown: CancellationToken,
) {
    loop {
        let request = tokio::select! {
            () = shutdown.cancelled() => return,
            request = requests.recv() => match request {
                Some(request) => request,
                None => return,
            },
        };
        // The same fact as "kiosk.applied == Enabled" of the loaded state.
        let kiosk_enabled = snapshot_rx.borrow().kiosk.enabled;
        tokio::select! {
            () = shutdown.cancelled() => return,
            result = run_exit(Arc::clone(&platform), kiosk_enabled, simulate, request, broadcast.clone()) => {
                if let Err(error) = result {
                    tracing::error!("admin exit did not complete: {error}");
                }
            }
        }
    }
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
    // demo mode, otherwise the cached one (Step 8 keeps it current). No document
    // means no exit PIN, so the admin exit is off.
    let policy_doc = if deps.sim.demo {
        Some(fixtures::demo_document())
    } else {
        load_cached_desired(&deps.paths).map(|cached| cached.doc)
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
    if deps.sim.demo {
        fixtures::apply_demo_snapshot(&mut first_snapshot, deps.sim.offline);
    }
    let (snapshot_tx, snapshot_rx) = watch::channel(first_snapshot);
    // The policy travels in its own channel, so the PIN hash is never inside the
    // snapshot. Step 8 sends the next policy whenever a document is accepted.
    let (_policy_tx, policy_rx) = watch::channel(policy);

    if deps.simulate {
        tracing::info!(demo = deps.sim.demo, offline = deps.sim.offline, "agent started (simulate)");
    } else {
        tracing::info!("agent started");
    }
    tracing::debug!(display_mode = ?snapshot_tx.borrow().display_mode, "initial snapshot built");

    // The Staff account's SID: the shell pipe exists only while it is known. Later
    // steps (enrollment, unenrollment) send changes through `_staff_sid_tx`.
    let (_staff_sid_tx, staff_sid_rx) =
        watch::channel(state.staff.as_ref().map(|staff| staff.sid.clone()));
    let (signals_tx, signals_rx) = mpsc::unbounded_channel::<ShellSignal>();
    let broadcast = ShellBroadcast::new();

    // (1.1) Employee session, lockouts, offline cache and audit queue.
    let now_ms: Arc<dyn Fn() -> u64 + Send + Sync> = Arc::new(unix_ms);
    let clock_floor = state.last_wall_clock_ms;
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
        // Step 8 keeps `last_wall_clock_ms` current; until then the loaded value.
        clock_floor_ms: Arc::new(move || clock_floor),
        timeouts: SessionTimeouts::default(),
    });

    // (1.1) The hidden admin exit: the PIN gate, and the stand-in task that signs
    // the Staff session out (the reconciler of Step 9 takes that over).
    let (exit_tx, exit_rx) = mpsc::channel::<ExitRequest>(EXIT_QUEUE);
    let admin_exit = AdminExit::new(AdminExitDeps {
        policy_rx,
        lockouts: Arc::clone(&lockouts),
        audit: Arc::clone(&audit),
        session: Arc::clone(&session),
        exit_tx,
        now_ms,
    });

    let tasks = TaskTracker::new();
    tasks.spawn(ipc_admin::run_pipe(
        AdminPipe {
            name: deps.pipes.admin.clone(),
            simulate: deps.simulate,
            snapshot_rx: snapshot_rx.clone(),
            // Steps 8 and 11 replace the inner handler with the real enroll and unenroll.
            handler: Arc::new(WithStatusExtra::new(
                Arc::new(NotAvailableYet),
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
    tasks.spawn(stand_in_exit_task(
        exit_rx,
        Arc::clone(&deps.platform),
        snapshot_rx.clone(),
        deps.simulate,
        broadcast.clone(),
        shutdown.clone(),
    ));
    tasks.spawn(log_shell_signals(signals_rx, shutdown.clone()));

    loop {
        tokio::select! {
            () = shutdown.cancelled() => break,
            event = control_rx.recv() => match event {
                Some(event) => tracing::debug!(?event, "control event (ignored until the reconciler exists)"),
                // The host dropped its sender: nothing more can arrive, keep waiting for shutdown.
                None => {
                    shutdown.cancelled().await;
                    break;
                }
            },
        }
    }

    // The pipe tasks watch the same token: they tell their clients and close.
    tasks.close();
    if tokio::time::timeout(TASK_WIND_DOWN, tasks.wait()).await.is_err() {
        tracing::warn!("the IPC tasks did not stop within {} s", TASK_WIND_DOWN.as_secs());
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
    use crate::platform::sim::SimPlatform;
    use crate::state::{Enrollment, KioskRecord};
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
