//! The single entry point for service mode and console mode. It loads the
//! state, builds the first snapshot and runs the IPC servers (Step 6); the other
//! tasks of Section 5.2 are added in later steps.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Context;
use rulebox_ipc::types::{
    AgentSnapshot, ConnectionStatus, DeviceInfo, DisplayMode, EnrollmentStatus, KioskPhase,
    KioskStatus, ShellHealth, ShellStatus,
};
use rulebox_ipc::{ADMIN_PIPE, SHELL_PIPE, SIM_SUFFIX};
use serde::Deserialize;
use tokio::sync::{mpsc, watch};
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

use crate::ipc_admin::{self, AdminPipe, NotAvailableYet};
use crate::ipc_shell::{self, ShellBroadcast, ShellPipe, ShellSignal};
use crate::paths::{DataPaths, InstallPaths};
use crate::platform::Platform;
use crate::state::{read_json, AgentState, KioskApplied, StateStore};

/// RAM at or below this many MB selects Lite mode (PRD 22.5).
const LITE_MODE_MAX_RAM_MB: u64 = 4352;
/// How long `run` waits for the IPC tasks to wind down after shutdown.
const TASK_WIND_DOWN: Duration = Duration::from_secs(5);

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
}

impl Default for AgentConfig {
    fn default() -> Self {
        Self { kill_hung_shell: true }
    }
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
}

pub fn load_config(paths: &DataPaths) -> anyhow::Result<AgentConfig> {
    let loaded = read_json(&paths.agent_config()).context("read agent-config.json")?;
    Ok(loaded.unwrap_or_default())
}

/// The snapshot shown to the Staff App before any backend contact.
pub fn initial_snapshot(
    state: &AgentState,
    platform: &dyn Platform,
    _config: &AgentConfig,
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
    AgentSnapshot {
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
        // Protocol 1.1 fields; Step 6b fills `admin_exit`, Phase 4 the other two.
        admin_exit: None,
        power: None,
        org_name: None,
    }
}

pub async fn run(
    deps: Deps,
    shutdown: CancellationToken,
    mut control_rx: mpsc::UnboundedReceiver<ControlEvent>,
) -> anyhow::Result<()> {
    let store = StateStore::open(&deps.paths.state_dir()).context("open the state directory")?;
    let state = store.load().context("load the agent state")?;
    let (snapshot_tx, snapshot_rx) =
        watch::channel(initial_snapshot(&state, deps.platform.as_ref(), &deps.config));

    if deps.simulate {
        tracing::info!("agent started (simulate)");
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

    let tasks = TaskTracker::new();
    tasks.spawn(ipc_admin::run_pipe(
        AdminPipe {
            name: deps.pipes.admin.clone(),
            simulate: deps.simulate,
            snapshot_rx: snapshot_rx.clone(),
            // Steps 8 and 11 replace this with the real enroll and unenroll.
            handler: Arc::new(NotAvailableYet),
        },
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
            // Steps 6a and 6b add the session and admin-exit extensions here.
            extensions: Vec::new(),
            staff_sid_rx,
        },
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
        let snapshot = initial_snapshot(&AgentState::default(), &sim, &AgentConfig::default());
        assert_eq!(snapshot.enrollment, EnrollmentStatus::NotEnrolled);
        assert_eq!(snapshot.display_mode, DisplayMode::Standard);
        assert_eq!(snapshot.kiosk.phase, KioskPhase::NotApplied);
        assert!(snapshot.device.is_none() && snapshot.desired_state.is_none());
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
        let snapshot = initial_snapshot(&state, &sim, &AgentConfig::default());
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
                assert_eq!(hello.capabilities, ["state", "health"]);
            }
            other => panic!("unexpected {other:?}"),
        }
        let snapshot = client.call::<StateGet>(Empty {}).await.unwrap();
        assert_eq!(snapshot.enrollment, EnrollmentStatus::NotEnrolled);
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
