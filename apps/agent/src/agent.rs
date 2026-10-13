//! The single entry point for service mode and console mode. For now it loads
//! the state, builds the first snapshot and waits for shutdown; the tasks of
//! Section 5.2 are added in later steps.

use std::sync::Arc;

use anyhow::Context;
use rulebox_ipc::types::{
    AgentSnapshot, ConnectionStatus, DeviceInfo, DisplayMode, EnrollmentStatus, KioskPhase,
    KioskStatus, ShellHealth, ShellStatus,
};
use serde::Deserialize;
use tokio::sync::{mpsc, watch};
use tokio_util::sync::CancellationToken;

use crate::paths::DataPaths;
use crate::platform::Platform;
use crate::state::{read_json, AgentState, KioskApplied, StateStore};

/// RAM at or below this many MB selects Lite mode (PRD 22.5).
const LITE_MODE_MAX_RAM_MB: u64 = 4352;

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
    pub config: AgentConfig,
    pub simulate: bool,
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
    let (snapshot_tx, _snapshot_rx) =
        watch::channel(initial_snapshot(&state, deps.platform.as_ref(), &deps.config));

    if deps.simulate {
        tracing::info!("agent started (simulate)");
    } else {
        tracing::info!("agent started");
    }
    tracing::debug!(display_mode = ?snapshot_tx.borrow().display_mode, "initial snapshot built");

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
    tracing::info!("agent stopped");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::sim::SimPlatform;
    use crate::state::{Enrollment, KioskRecord};
    use crate::testutil::TempDir;

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

    #[tokio::test]
    async fn run_waits_for_shutdown() {
        let dir = TempDir::new();
        let deps = Deps {
            platform: Arc::new(SimPlatform::new(dir.path().to_path_buf())),
            paths: DataPaths::new(dir.path().to_path_buf()),
            config: AgentConfig::default(),
            simulate: true,
        };
        let shutdown = CancellationToken::new();
        let (_control_tx, control_rx) = mpsc::unbounded_channel();
        let task = tokio::spawn(run(deps, shutdown.clone(), control_rx));
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert!(!task.is_finished());
        shutdown.cancel();
        task.await.unwrap().unwrap();
    }
}
