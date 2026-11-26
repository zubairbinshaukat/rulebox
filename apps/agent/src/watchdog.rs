//! The launcher watchdog (plan Section 5.7, Step 13).
//!
//! Two tiers. `rulebox-shell.exe` (the launcher) restarts the Staff App by itself:
//! fast, inside the session, and it works while the agent is down. This agent is the
//! backup and does exactly two things:
//!
//! 1. It makes sure `rulebox-shell.exe` is running in the Staff session and starts it
//!    when it is not (the launcher died, or Winlogon never started it).
//! 2. It ends a Staff App whose heartbeats stopped, after which the launcher starts it
//!    again.
//!
//! It never fights the launcher: it starts a launcher only when **no** `rulebox-shell.exe`
//! exists in the Staff session, and it ends a Staff App only when 30 seconds have passed
//! without `shell.heartbeat` from a client that had said `shell.ready`. A Staff App that
//! never becomes ready (crash loop, or Phase 2 where `rulebox-staff.exe` does not exist
//! yet, so the launcher shows its fallback screen) is only reported as `unhealthy`: that
//! is the launcher's case, and the agent leaves it alone.
//!
//! Two layers:
//!
//! - [`Watchdog`] is a pure decision function over a [`WatchdogInput`] and a clock value.
//! - [`WatchdogTask`] gathers the input from `Platform` and the shell-pipe signals,
//!   executes the action through `Platform` and writes `shell.health` into the snapshot.
//!   [`run`] is its loop: every 5 seconds, on every session event, and on the shell
//!   signals that can change a decision.
//!
//! The launcher connects to the shell pipe only briefly (role `launcher`) and never
//! holds a connection, so its presence is decided by looking for its process, never by
//! a connection.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use rulebox_ipc::types::{ClientRole, ShellHealth};
use rulebox_ipc::HEARTBEAT_TIMEOUT;
use tokio::sync::mpsc;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use crate::ipc_shell::ShellSignal;
use crate::lockdown::lkg::ShellHealthSink;
use crate::paths::InstallPaths;
use crate::platform::windows::staff_app_exe;
use crate::platform::{Platform, PlatformError, SessionState};
use crate::state::{unix_ms, KioskApplied, SharedState, SnapshotHandle};

/// How often the task looks, while the kiosk is enabled.
pub const TICK: Duration = Duration::from_secs(5);
/// How long the launcher may be missing before the agent starts it (Winlogon may still
/// be starting it).
pub const LAUNCHER_GRACE: Duration = Duration::from_secs(3);
/// Without `shell.ready` for this long the health is `unhealthy` (never a kill).
pub const READY_TIMEOUT: Duration = Duration::from_secs(30);
/// At most one terminate per this interval.
pub const TERMINATE_INTERVAL: Duration = Duration::from_secs(60);
/// Failed launches in a row after which the health is `failed`.
pub const FAILURES_BEFORE_FAILED: u32 = 5;
/// The wait between launch attempts once the health is `failed`.
pub const FAILED_RETRY: Duration = Duration::from_secs(30);
/// A launcher that stays for this long ends the failure streak. One that vanishes
/// sooner after we started it counts as another failure.
pub const LAUNCHER_STABLE: Duration = Duration::from_secs(30);

/// The Staff account SID and session of a simulated agent started with
/// `--sim-staff-session` (the simulated Staff session of Step 13's check).
pub const SIM_STAFF_SID: &str = "S-1-5-21-1000-2000-3000-2001";
pub const SIM_STAFF_SESSION: u32 = 2;

// -- the pure decision --------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WatchdogAction {
    None,
    /// Start `rulebox-shell.exe` in this session.
    LaunchLauncher { session_id: u32 },
    /// End this Staff App process (the executor re-checks image and owner).
    TerminateShell { pid: u32 },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WatchdogInput {
    /// Kiosk applied and the device enrolled (a revoked PC keeps its kiosk).
    pub kiosk_enabled: bool,
    /// The `Active` session of the Staff account, if any.
    pub staff_session: Option<u32>,
    /// Processes of `<install>\rulebox-shell.exe` in that session.
    pub launcher_pids: Vec<u32>,
    /// Connections whose `hello` role was `shell`. A `launcher` connection (the
    /// fallback screen's short calls) is not a Staff App and is never in here.
    pub shell_clients: Vec<ShellClient>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ShellClient {
    pub pid: u32,
    pub ready_at: Option<Instant>,
    pub last_heartbeat: Option<Instant>,
}

/// The decision state: timers and counters, nothing about the machine.
#[derive(Debug)]
pub struct Watchdog {
    kill_hung_shell: bool,
    session: Option<u32>,
    launcher_missing_since: Option<Instant>,
    launcher_present_since: Option<Instant>,
    /// Start of the current "no ready client" stretch.
    starting_since: Option<Instant>,
    had_ready: bool,
    launch_failures: u32,
    last_launch_attempt: Option<Instant>,
    /// When we last started a launcher successfully and it has not yet proven stable.
    last_launch_ok: Option<Instant>,
    last_terminate: Option<Instant>,
}

impl Watchdog {
    pub fn new(kill_hung_shell: bool) -> Self {
        Self {
            kill_hung_shell,
            session: None,
            launcher_missing_since: None,
            launcher_present_since: None,
            starting_since: None,
            had_ready: false,
            launch_failures: 0,
            last_launch_attempt: None,
            last_launch_ok: None,
            last_terminate: None,
        }
    }

    fn reset(&mut self) {
        *self = Self::new(self.kill_hung_shell);
    }

    /// Consecutive launch failures (for the log).
    pub fn launch_failures(&self) -> u32 {
        self.launch_failures
    }

    /// The caller reports what became of a `LaunchLauncher`.
    pub fn record_launch(&mut self, ok: bool, now: Instant) {
        self.last_launch_attempt = Some(now);
        if ok {
            self.last_launch_ok = Some(now);
        } else {
            self.launch_failures = self.launch_failures.saturating_add(1);
            self.last_launch_ok = None;
        }
    }

    /// Called on every tick, session event and shell signal.
    pub fn decide(&mut self, input: &WatchdogInput, now: Instant) -> (WatchdogAction, ShellHealth) {
        // Rule 1: kiosk enabled and an Active Staff session, or nothing to do.
        let session = match (input.kiosk_enabled, input.staff_session) {
            (true, Some(session)) => session,
            _ => {
                self.reset();
                return (WatchdogAction::None, ShellHealth::NotRunning);
            }
        };
        if self.session != Some(session) {
            self.reset();
            self.session = Some(session);
        }
        if input.launcher_pids.is_empty() {
            return self.launcher_missing(session, now);
        }

        // The launcher is there.
        self.launcher_missing_since = None;
        let present_since = *self.launcher_present_since.get_or_insert(now);
        if now.saturating_duration_since(present_since) >= LAUNCHER_STABLE {
            self.launch_failures = 0;
            self.last_launch_ok = None;
        }

        // Clients that said `shell.ready`, each with the time of its latest sign of life.
        let ready: Vec<(&ShellClient, Instant)> = input
            .shell_clients
            .iter()
            .filter_map(|client| {
                let ready_at = client.ready_at?;
                Some((client, client.last_heartbeat.map_or(ready_at, |beat| beat.max(ready_at))))
            })
            .collect();

        if ready.is_empty() {
            // Starting, or a Staff App that never becomes ready: the launcher's case.
            if self.had_ready {
                self.had_ready = false;
                self.starting_since = Some(now);
            }
            let since = *self.starting_since.get_or_insert(present_since);
            let health = if now.saturating_duration_since(since) >= READY_TIMEOUT {
                ShellHealth::Unhealthy
            } else {
                ShellHealth::Starting
            };
            return (WatchdogAction::None, health);
        }

        self.had_ready = true;
        self.starting_since = None;
        let newest = ready.iter().map(|(_, beat)| *beat).fold(None, |best: Option<Instant>, beat| {
            Some(best.map_or(beat, |best| best.max(beat)))
        });
        let silent = newest.map_or(Duration::ZERO, |beat| now.saturating_duration_since(beat));
        if silent < HEARTBEAT_TIMEOUT {
            return (WatchdogAction::None, ShellHealth::Healthy);
        }

        // Hung: ready once, and no heartbeat on any shell connection for 30 s.
        let may_terminate = self.kill_hung_shell
            && self
                .last_terminate
                .is_none_or(|at| now.saturating_duration_since(at) >= TERMINATE_INTERVAL);
        if may_terminate {
            if let Some((client, _)) = ready.iter().min_by_key(|(_, beat)| *beat) {
                self.last_terminate = Some(now);
                return (WatchdogAction::TerminateShell { pid: client.pid }, ShellHealth::Unhealthy);
            }
        }
        (WatchdogAction::None, ShellHealth::Unhealthy)
    }

    fn launcher_missing(&mut self, session_id: u32, now: Instant) -> (WatchdogAction, ShellHealth) {
        self.launcher_present_since = None;
        self.starting_since = None;
        self.had_ready = false;
        if self.launcher_missing_since.is_none() {
            self.launcher_missing_since = Some(now);
            // Started by us and gone again before it proved stable: a failure, so a
            // launcher that dies at once is not restarted every few seconds forever.
            if let Some(started) = self.last_launch_ok.take() {
                if now.saturating_duration_since(started) < LAUNCHER_STABLE {
                    self.launch_failures = self.launch_failures.saturating_add(1);
                }
            }
        }
        let missing_for = self
            .launcher_missing_since
            .map_or(Duration::ZERO, |since| now.saturating_duration_since(since));
        let failed = self.launch_failures >= FAILURES_BEFORE_FAILED;
        let gap = if failed { FAILED_RETRY } else { LAUNCHER_GRACE };
        let gap_passed =
            self.last_launch_attempt.is_none_or(|at| now.saturating_duration_since(at) >= gap);
        let action = if missing_for >= LAUNCHER_GRACE && gap_passed {
            WatchdogAction::LaunchLauncher { session_id }
        } else {
            WatchdogAction::None
        };
        (action, if failed { ShellHealth::Failed } else { ShellHealth::NotRunning })
    }
}

// -- gathering and executing ----------------------------------------------------------

/// What the task reads about the kiosk each time: kept as a function so tests and the
/// simulated Staff session can supply their own.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Gate {
    pub kiosk_enabled: bool,
    pub staff_sid: Option<String>,
}

pub type GateFn = Arc<dyn Fn() -> Gate + Send + Sync>;

/// The real gate: the kiosk is applied and the device is enrolled (or revoked: a
/// revoked PC keeps its kiosk, Q11), and the Staff account is known.
pub fn state_gate(shared: Arc<SharedState>) -> GateFn {
    Arc::new(move || {
        shared.read(|state| Gate {
            kiosk_enabled: state.enrollment.is_some() && state.kiosk.applied == KioskApplied::Enabled,
            staff_sid: state.staff.as_ref().map(|staff| staff.sid.clone()),
        })
    })
}

/// The gate of a simulated agent started with `--sim-staff-session`.
pub fn sim_gate() -> GateFn {
    Arc::new(|| Gate { kiosk_enabled: true, staff_sid: Some(SIM_STAFF_SID.to_string()) })
}

pub struct WatchdogDeps {
    pub platform: Arc<dyn Platform>,
    pub snapshot: SnapshotHandle,
    pub install: InstallPaths,
    /// `agent-config.json` -> `killHungShell`.
    pub kill_hung_shell: bool,
    /// Simulate mode: a hung Staff App is only logged. The shell clients there are real
    /// processes that `SimPlatform` does not know.
    pub simulate: bool,
    pub gate: GateFn,
    /// (Phase 6 Q-A3) While held, the watchdog neither starts the launcher nor ends the Staff App.
    pub hold: ShellHold,
}

/// (Phase 6 Q-A3) "Leave the Staff App alone until this time": set by the self-update task right after it closed the launcher
/// and the Staff App for an MSI upgrade, so the watchdog does not start them again while Windows Installer replaces their
/// files (they would be in use again, which is what closing them avoided). It is a deadline, not a switch: if the MSI never
/// stops this service (it was refused early) the watchdog looks again when the deadline passes. A new agent process after
/// the upgrade starts with no hold. Cheap to clone; every clone is the same hold.
#[derive(Clone, Default)]
pub struct ShellHold(Arc<std::sync::atomic::AtomicU64>);

impl ShellHold {
    /// Holds until `unix_ms` (the wall clock, like `state::unix_ms`).
    pub fn hold_until(&self, unix_ms: u64) {
        self.0.store(unix_ms, std::sync::atomic::Ordering::SeqCst);
    }

    /// Lets the watchdog act again at once.
    pub fn release(&self) {
        self.0.store(0, std::sync::atomic::Ordering::SeqCst);
    }

    /// Whether `now_ms` is before the deadline.
    pub fn active(&self, now_ms: u64) -> bool {
        now_ms < self.0.load(std::sync::atomic::Ordering::SeqCst)
    }
}

/// Wakes the task on a session or power event.
#[derive(Clone)]
pub struct WatchdogHandle {
    tx: mpsc::UnboundedSender<()>,
}

impl WatchdogHandle {
    pub fn session_changed(&self) {
        // The task is gone only while the agent shuts down.
        let _ = self.tx.send(());
    }
}

pub fn channel() -> (WatchdogHandle, mpsc::UnboundedReceiver<()>) {
    let (tx, rx) = mpsc::unbounded_channel();
    (WatchdogHandle { tx }, rx)
}

struct Observed {
    kiosk_enabled: bool,
    staff_sid: Option<String>,
    staff_session: Option<u32>,
    launcher_pids: Vec<u32>,
}

/// Reads the session list and the launcher processes. With the kiosk off or no Staff
/// SID it reads nothing.
fn observe(platform: &dyn Platform, install: &InstallPaths, gate: Gate) -> Result<Observed, PlatformError> {
    let Gate { kiosk_enabled, staff_sid } = gate;
    let Some(sid) = staff_sid.clone().filter(|_| kiosk_enabled) else {
        return Ok(Observed { kiosk_enabled: false, staff_sid, staff_session: None, launcher_pids: Vec::new() });
    };
    let sessions = platform.sessions()?;
    // Active only: a Disconnected session is left alone (plan edge case 19). The
    // console session wins if there is ever more than one.
    let staff_session = sessions
        .iter()
        .filter(|session| {
            session.state == SessionState::Active
                && session.user_sid.as_deref().is_some_and(|user| user.eq_ignore_ascii_case(&sid))
        })
        .min_by_key(|session| (!session.is_console, session.id))
        .map(|session| session.id);
    let launcher_pids = match staff_session {
        Some(id) => platform.find_processes(id, &install.shell_exe())?,
        None => Vec::new(),
    };
    Ok(Observed { kiosk_enabled, staff_sid, staff_session, launcher_pids })
}

/// Ends the Staff App `pid` if it is the file `current.json` names and belongs to the
/// Staff account (`terminate_process` checks both again at the process).
fn terminate_hung(platform: &dyn Platform, install: &InstallPaths, pid: u32, staff_sid: &str) -> Result<(), String> {
    let json = std::fs::read_to_string(install.current_json())
        .map_err(|error| format!("cannot read current.json: {error}"))?;
    let image = staff_app_exe(install.root(), &json)
        .ok_or_else(|| "current.json does not name a Staff App inside versions\\".to_string())?;
    platform.terminate_process(pid, &image, staff_sid).map_err(|error| error.to_string())
}

/// Runs blocking platform work. Tests run it inline so a paused clock stays
/// deterministic (a paused runtime auto-advances while a blocking task is in flight).
/// `None` means the blocking task itself failed.
async fn blocking<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> Option<T> {
    #[cfg(test)]
    {
        Some(work())
    }
    #[cfg(not(test))]
    {
        match tokio::task::spawn_blocking(work).await {
            Ok(value) => Some(value),
            Err(error) => {
                tracing::error!("the watchdog's blocking task failed: {error}");
                None
            }
        }
    }
}

// -- the shell connections ---------------------------------------------------------

struct Conn {
    pid: u32,
    ready_at: Option<Instant>,
    last_heartbeat: Option<Instant>,
}

/// The shell-role connections the agent has seen, by connection id.
#[derive(Default)]
struct ClientTable {
    shells: HashMap<u64, Conn>,
    /// Connections of any other role (the launcher's short calls): never watched.
    others: HashMap<u64, ClientRole>,
}

impl ClientTable {
    fn clients(&self) -> Vec<ShellClient> {
        self.shells
            .values()
            .map(|conn| ShellClient { pid: conn.pid, ready_at: conn.ready_at, last_heartbeat: conn.last_heartbeat })
            .collect()
    }
}

// -- the task ------------------------------------------------------------------------

pub struct WatchdogTask {
    deps: WatchdogDeps,
    watchdog: Watchdog,
    table: ClientTable,
    health: ShellHealth,
    /// The last lookup failed (logged once until a lookup works again).
    lookup_failed: bool,
    /// (Phase 5 Step 9) Where the Staff App's sign of life and its crashes go: the last-known-good
    /// monitor. `ui_alive` is the `shell.ready` / `shell.heartbeat` signal.
    health_sink: Option<Arc<dyn ShellHealthSink>>,
    /// The Staff session was active at the last look (what the sink was last told).
    staff_active: bool,
}

impl WatchdogTask {
    pub fn new(deps: WatchdogDeps) -> Self {
        let watchdog = Watchdog::new(deps.kill_hung_shell);
        let health = deps.snapshot.current().shell.health;
        Self {
            deps,
            watchdog,
            table: ClientTable::default(),
            health,
            lookup_failed: false,
            health_sink: None,
            staff_active: false,
        }
    }

    /// (Phase 5 Step 9) Tells `sink` about heartbeats, crashes and the Staff session: the agent's
    /// last-known-good monitor (wired by [`run`], Step 20).
    pub fn set_health_sink(&mut self, sink: Arc<dyn ShellHealthSink>) {
        self.health_sink = Some(sink);
    }

    /// Records a shell-pipe signal. Returns true when a decision may have changed.
    pub fn on_signal(&mut self, signal: ShellSignal, now: Instant) -> bool {
        match signal {
            ShellSignal::Connected { connection_id, pid, role } => {
                if role == ClientRole::Shell {
                    tracing::debug!(connection_id, pid, "shell client connected");
                    self.table.shells.insert(connection_id, Conn { pid, ready_at: None, last_heartbeat: None });
                    true
                } else {
                    // The launcher's fallback screen (and anything else): never a
                    // Staff App, never a hang-detection target.
                    tracing::debug!(connection_id, pid, ?role, "non-shell client connected; not watched");
                    self.table.others.insert(connection_id, role);
                    false
                }
            }
            ShellSignal::Ready { connection_id, pid } => match self.table.shells.get_mut(&connection_id) {
                Some(conn) => {
                    conn.ready_at = Some(now);
                    tracing::info!(connection_id, pid, "shell.ready");
                    if let Some(sink) = &self.health_sink {
                        sink.ui_alive(unix_ms());
                    }
                    true
                }
                None => false,
            },
            ShellSignal::Heartbeat { connection_id, pid } => match self.table.shells.get_mut(&connection_id) {
                Some(conn) => {
                    // A heartbeat without `shell.ready` (for example after an agent
                    // restart, when the Staff App kept beating) also proves it is
                    // alive, so it arms hang detection.
                    let first = conn.last_heartbeat.is_none();
                    conn.last_heartbeat = Some(now);
                    conn.ready_at.get_or_insert(now);
                    if let Some(sink) = &self.health_sink {
                        sink.ui_alive(unix_ms());
                    }
                    if first {
                        tracing::info!(connection_id, pid, "shell.heartbeat (first on this connection)");
                    } else {
                        tracing::debug!(connection_id, pid, "shell.heartbeat");
                    }
                    // A heartbeat only matters while the health is not `healthy`.
                    self.health != ShellHealth::Healthy
                }
                None => false,
            },
            ShellSignal::Closed { connection_id } => {
                self.table.others.remove(&connection_id);
                let gone = self.table.shells.remove(&connection_id);
                // A Staff App that had said it was ready, gone while the Staff session is active, is
                // a crash for the last-known-good probation (a hung one ended by `terminate` is too).
                if let (Some(conn), Some(sink)) = (&gone, &self.health_sink) {
                    if conn.ready_at.is_some() && self.staff_active {
                        sink.shell_crashed(unix_ms());
                    }
                }
                gone.is_some()
            }
        }
    }

    /// One look at the machine, one decision, its action, and the health in the
    /// snapshot.
    pub async fn evaluate(&mut self) {
        // (Phase 6 Q-A3) The self-update closed the Staff App for an MSI upgrade: do not start it again until the
        // deadline (or until the upgraded agent starts and has no hold).
        if self.deps.hold.active(unix_ms()) {
            tracing::debug!("the watchdog is held off while Rulebox updates itself");
            return;
        }
        let platform = Arc::clone(&self.deps.platform);
        let install = self.deps.install.clone();
        let gate = (self.deps.gate)();
        let observed = blocking(move || observe(platform.as_ref(), &install, gate)).await;
        let observed = match observed {
            Some(Ok(observed)) => {
                self.lookup_failed = false;
                observed
            }
            Some(Err(error)) => {
                // Never act on a lookup that failed: not seeing the launcher is not
                // the same as the launcher being gone.
                if !self.lookup_failed {
                    tracing::warn!("the watchdog cannot read the sessions or processes: {error}");
                }
                self.lookup_failed = true;
                return;
            }
            None => return,
        };

        let now = Instant::now();
        let staff_active = observed.kiosk_enabled && observed.staff_session.is_some();
        if staff_active != self.staff_active {
            self.staff_active = staff_active;
            if let Some(sink) = &self.health_sink {
                sink.staff_session(staff_active, unix_ms());
            }
        }
        let input = WatchdogInput {
            kiosk_enabled: observed.kiosk_enabled,
            staff_session: observed.staff_session,
            launcher_pids: observed.launcher_pids,
            shell_clients: self.table.clients(),
        };
        let (action, health) = self.watchdog.decide(&input, now);
        self.publish(health);
        let Some(staff_sid) = observed.staff_sid else {
            return;
        };
        match action {
            WatchdogAction::None => {}
            WatchdogAction::LaunchLauncher { session_id } => self.launch(session_id, &staff_sid, now).await,
            WatchdogAction::TerminateShell { pid } => self.terminate(pid, &staff_sid).await,
        }
    }

    fn publish(&mut self, health: ShellHealth) {
        if self.deps.snapshot.update(|snapshot| snapshot.shell.health = health) {
            tracing::info!(?health, "shell health changed");
        }
        self.health = health;
    }

    async fn launch(&mut self, session_id: u32, staff_sid: &str, now: Instant) {
        let platform = Arc::clone(&self.deps.platform);
        let exe = self.deps.install.shell_exe();
        let sid = staff_sid.to_string();
        // (Phase 6 Step 22 run A2) A launcher an MSI upgrade left running (its file moved to `C:\Config.Msi`) is not found by
        // its image, yet still holds the launcher's mutex, so a new one would exit at once: end it first. Simulate mode
        // never ends processes (see `terminate`).
        let simulate = self.deps.simulate;
        let outcome = {
            let exe = exe.clone();
            blocking(move || {
                let ended = if simulate { Ok(Vec::new()) } else { platform.end_stale_launchers(session_id, &exe, &sid) };
                (ended, platform.launch_in_session(session_id, &sid, &exe))
            })
            .await
        };
        let result = outcome.map(|(ended, result)| {
            match ended {
                Ok(pids) if !pids.is_empty() => {
                    tracing::info!(session_id, ?pids, "ended a stale rulebox-shell.exe left by an update");
                }
                Ok(_) => {}
                Err(error) => tracing::warn!(session_id, "cannot end a stale rulebox-shell.exe: {error}; starting the launcher anyway"),
            }
            result
        });
        match result {
            Some(Ok(pid)) => {
                tracing::info!(session_id, pid, "rulebox-shell.exe was not running in the Staff session; started it");
                self.watchdog.record_launch(true, now);
            }
            Some(Err(error)) => {
                self.watchdog.record_launch(false, now);
                let failures = self.watchdog.launch_failures();
                if failures == FAILURES_BEFORE_FAILED {
                    tracing::error!(
                        session_id,
                        failures,
                        "cannot start rulebox-shell.exe ({error}); health is failed, retrying every {} s",
                        FAILED_RETRY.as_secs()
                    );
                    self.publish(ShellHealth::Failed);
                } else if failures > FAILURES_BEFORE_FAILED {
                    tracing::warn!(session_id, failures, "cannot start rulebox-shell.exe: {error}");
                } else {
                    tracing::warn!(session_id, failures, "cannot start rulebox-shell.exe: {error}; will try again");
                }
            }
            None => self.watchdog.record_launch(false, now),
        }
    }

    async fn terminate(&mut self, pid: u32, staff_sid: &str) {
        if self.deps.simulate {
            tracing::warn!(
                pid,
                "simulate: the Staff App has not sent a heartbeat for {} s; the agent would terminate it now \
                 (the launcher would start it again)",
                HEARTBEAT_TIMEOUT.as_secs()
            );
            return;
        }
        let platform = Arc::clone(&self.deps.platform);
        let install = self.deps.install.clone();
        let sid = staff_sid.to_string();
        let result = blocking(move || terminate_hung(platform.as_ref(), &install, pid, &sid)).await;
        match result {
            Some(Ok(())) => tracing::warn!(
                pid,
                "the Staff App sent no heartbeat for {} s; terminated it, the launcher starts it again",
                HEARTBEAT_TIMEOUT.as_secs()
            ),
            // Not terminated: the process is not the Staff App of current.json, or
            // not the Staff account's. The 60-second limit still applies.
            Some(Err(reason)) => tracing::warn!(pid, "the hung Staff App was not terminated: {reason}"),
            None => {}
        }
    }
}

/// The watchdog task. The first evaluation runs at once, so an agent that starts
/// after the shell finds it by itself.
pub async fn run(
    deps: WatchdogDeps,
    mut signals: mpsc::UnboundedReceiver<ShellSignal>,
    mut events: mpsc::UnboundedReceiver<()>,
    health_sink: Option<Arc<dyn ShellHealthSink>>,
    shutdown: CancellationToken,
) {
    let mut task = WatchdogTask::new(deps);
    // (Phase 5 Step 20) The last-known-good monitor hears about heartbeats, crashes and the session.
    if let Some(sink) = health_sink {
        task.set_health_sink(sink);
    }
    let mut tick = tokio::time::interval(TICK);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut events_open = true;
    loop {
        let evaluate = tokio::select! {
            () = shutdown.cancelled() => break,
            signal = signals.recv() => match signal {
                Some(signal) => task.on_signal(signal, Instant::now()),
                None => {
                    // The pipe task is gone (shutdown); nothing more can arrive.
                    shutdown.cancelled().await;
                    break;
                }
            },
            event = events.recv(), if events_open => {
                if event.is_none() {
                    events_open = false;
                }
                event.is_some()
            }
            _ = tick.tick() => true,
        };
        if evaluate {
            tokio::select! {
                () = shutdown.cancelled() => break,
                () = task.evaluate() => {}
            }
        }
    }
}

#[cfg(test)]
mod tests;
