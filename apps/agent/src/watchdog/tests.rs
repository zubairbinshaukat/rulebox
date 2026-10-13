//! Watchdog tests (plan Step 13): the pure decisions with a fake clock, then the task
//! over `SimPlatform` with a paused tokio clock. In tests the blocking platform work
//! runs inline (see `blocking`), so the paused clock never moves by itself.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rulebox_ipc::types::ClientRole;

use super::*;
use crate::platform::sim::{SimOp, SimPlatform, SimProcess};
use crate::state::{AgentState, Enrollment, KioskRecord, StaffAccount, StateStore};
use crate::testutil::{test_snapshot, TempDir};

const STAFF: &str = "S-1-5-21-1-2-3-1001";
const OTHER: &str = "S-1-5-21-1-2-3-1002";

fn secs(n: u64) -> Duration {
    Duration::from_secs(n)
}

// -- the pure decision -----------------------------------------------------------------

fn input(kiosk: bool, session: Option<u32>, launchers: &[u32], clients: Vec<ShellClient>) -> WatchdogInput {
    WatchdogInput {
        kiosk_enabled: kiosk,
        staff_session: session,
        launcher_pids: launchers.to_vec(),
        shell_clients: clients,
    }
}

fn ready_client(pid: u32, ready_at: Instant, last_heartbeat: Option<Instant>) -> ShellClient {
    ShellClient { pid, ready_at: Some(ready_at), last_heartbeat }
}

#[test]
fn kiosk_disabled_is_none_and_not_running() {
    let t0 = Instant::now();
    let mut dog = Watchdog::new(true);
    let (action, health) = dog.decide(&input(false, Some(2), &[], vec![]), t0);
    assert_eq!((action, health), (WatchdogAction::None, ShellHealth::NotRunning));
    // Even a long absence of the launcher does nothing while the kiosk is off.
    let (action, health) = dog.decide(&input(false, Some(2), &[], vec![]), t0 + secs(120));
    assert_eq!((action, health), (WatchdogAction::None, ShellHealth::NotRunning));
    // No Staff session either.
    let (action, health) = dog.decide(&input(true, None, &[], vec![]), t0 + secs(240));
    assert_eq!((action, health), (WatchdogAction::None, ShellHealth::NotRunning));
}

#[test]
fn a_missing_launcher_is_started_after_three_seconds() {
    let t0 = Instant::now();
    let mut dog = Watchdog::new(true);
    let missing = input(true, Some(2), &[], vec![]);
    assert_eq!(dog.decide(&missing, t0).0, WatchdogAction::None);
    assert_eq!(dog.decide(&missing, t0 + secs(2)).0, WatchdogAction::None);
    let (action, health) = dog.decide(&missing, t0 + secs(3));
    assert_eq!(action, WatchdogAction::LaunchLauncher { session_id: 2 });
    assert_eq!(health, ShellHealth::NotRunning);
}

#[test]
fn a_launcher_that_comes_back_inside_the_grace_is_never_started() {
    let t0 = Instant::now();
    let mut dog = Watchdog::new(true);
    dog.decide(&input(true, Some(2), &[], vec![]), t0);
    let present = input(true, Some(2), &[900], vec![]);
    assert_eq!(dog.decide(&present, t0 + secs(2)).0, WatchdogAction::None);
    // Gone again: the grace starts over.
    let missing = input(true, Some(2), &[], vec![]);
    assert_eq!(dog.decide(&missing, t0 + secs(6)).0, WatchdogAction::None);
    assert_eq!(dog.decide(&missing, t0 + secs(8)).0, WatchdogAction::None);
    assert_eq!(dog.decide(&missing, t0 + secs(9)).0, WatchdogAction::LaunchLauncher { session_id: 2 });
}

#[test]
fn not_ready_for_31_seconds_is_unhealthy_and_never_a_terminate() {
    let t0 = Instant::now();
    let mut dog = Watchdog::new(true);
    let connected = input(
        true,
        Some(2),
        &[900],
        vec![ShellClient { pid: 77, ready_at: None, last_heartbeat: None }],
    );
    assert_eq!(dog.decide(&connected, t0), (WatchdogAction::None, ShellHealth::Starting));
    assert_eq!(dog.decide(&connected, t0 + secs(29)), (WatchdogAction::None, ShellHealth::Starting));
    assert_eq!(dog.decide(&connected, t0 + secs(31)), (WatchdogAction::None, ShellHealth::Unhealthy));
    // A very long time later: still only unhealthy, never a kill.
    assert_eq!(dog.decide(&connected, t0 + secs(3600)), (WatchdogAction::None, ShellHealth::Unhealthy));
}

#[test]
fn a_ready_client_with_a_recent_heartbeat_is_healthy() {
    let t0 = Instant::now();
    let mut dog = Watchdog::new(true);
    let client = ready_client(77, t0, Some(t0 + secs(20)));
    let (action, health) = dog.decide(&input(true, Some(2), &[900], vec![client]), t0 + secs(30));
    assert_eq!((action, health), (WatchdogAction::None, ShellHealth::Healthy));
}

#[test]
fn a_silent_ready_client_is_terminated_once_per_60_seconds() {
    let t0 = Instant::now();
    let mut dog = Watchdog::new(true);
    let client = ready_client(77, t0, Some(t0 + secs(5)));
    let hung = input(true, Some(2), &[900], vec![client]);
    // 31 s after the last heartbeat.
    let (action, health) = dog.decide(&hung, t0 + secs(36));
    assert_eq!(action, WatchdogAction::TerminateShell { pid: 77 });
    assert_eq!(health, ShellHealth::Unhealthy);
    // Five seconds later the same client is still there: no second kill.
    assert_eq!(dog.decide(&hung, t0 + secs(41)), (WatchdogAction::None, ShellHealth::Unhealthy));
    assert_eq!(dog.decide(&hung, t0 + secs(95)).0, WatchdogAction::None);
    // 60 s after the first one it may happen again.
    assert_eq!(dog.decide(&hung, t0 + secs(96)).0, WatchdogAction::TerminateShell { pid: 77 });
}

#[test]
fn kill_hung_shell_false_never_terminates() {
    let t0 = Instant::now();
    let mut dog = Watchdog::new(false);
    let hung = input(true, Some(2), &[900], vec![ready_client(77, t0, None)]);
    for step in [31, 100, 1000] {
        let (action, health) = dog.decide(&hung, t0 + secs(step));
        assert_eq!((action, health), (WatchdogAction::None, ShellHealth::Unhealthy));
    }
}

#[test]
fn any_fresh_connection_keeps_the_staff_app_alive() {
    let t0 = Instant::now();
    let mut dog = Watchdog::new(true);
    let clients = vec![
        ready_client(77, t0, Some(t0 + secs(1))),
        ready_client(78, t0, Some(t0 + secs(55))),
    ];
    let (action, health) = dog.decide(&input(true, Some(2), &[900], clients), t0 + secs(60));
    assert_eq!((action, health), (WatchdogAction::None, ShellHealth::Healthy));
}

#[test]
fn the_stalest_ready_client_is_the_target() {
    let t0 = Instant::now();
    let mut dog = Watchdog::new(true);
    let clients = vec![
        ready_client(78, t0, Some(t0 + secs(10))),
        ready_client(77, t0, Some(t0 + secs(2))),
    ];
    let (action, _) = dog.decide(&input(true, Some(2), &[900], clients), t0 + secs(80));
    assert_eq!(action, WatchdogAction::TerminateShell { pid: 77 });
}

#[test]
fn five_failed_launches_are_failed_and_the_next_attempt_comes_30_seconds_later() {
    let t0 = Instant::now();
    let mut dog = Watchdog::new(true);
    let missing = input(true, Some(2), &[], vec![]);
    let mut now = t0;
    dog.decide(&missing, now);
    for attempt in 1..=5 {
        now += secs(3);
        let (action, _) = dog.decide(&missing, now);
        assert_eq!(action, WatchdogAction::LaunchLauncher { session_id: 2 }, "attempt {attempt}");
        dog.record_launch(false, now);
    }
    let (action, health) = dog.decide(&missing, now + secs(5));
    assert_eq!((action, health), (WatchdogAction::None, ShellHealth::Failed));
    assert_eq!(dog.decide(&missing, now + secs(29)).0, WatchdogAction::None);
    let (action, health) = dog.decide(&missing, now + secs(30));
    assert_eq!(action, WatchdogAction::LaunchLauncher { session_id: 2 });
    assert_eq!(health, ShellHealth::Failed);
    // And if that one works, the next look sees a launcher and the health follows it.
    dog.record_launch(true, now + secs(30));
    let (action, health) = dog.decide(&input(true, Some(2), &[901], vec![]), now + secs(35));
    assert_eq!((action, health), (WatchdogAction::None, ShellHealth::Starting));
}

#[test]
fn four_failures_are_retried_at_once_not_after_30_seconds() {
    let t0 = Instant::now();
    let mut dog = Watchdog::new(true);
    let missing = input(true, Some(2), &[], vec![]);
    dog.decide(&missing, t0);
    let mut now = t0;
    for _ in 0..4 {
        now += secs(3);
        assert_eq!(dog.decide(&missing, now).0, WatchdogAction::LaunchLauncher { session_id: 2 });
        dog.record_launch(false, now);
    }
    let (action, health) = dog.decide(&missing, now + secs(3));
    assert_eq!((action, health), (WatchdogAction::LaunchLauncher { session_id: 2 }, ShellHealth::NotRunning));
}

#[test]
fn a_launcher_that_dies_right_after_we_start_it_ends_up_failed_not_in_a_tight_loop() {
    let t0 = Instant::now();
    let mut dog = Watchdog::new(true);
    let missing = input(true, Some(2), &[], vec![]);
    let present = input(true, Some(2), &[900], vec![]);
    let mut now = t0;
    dog.decide(&missing, now);
    let mut launches = 0;
    // Start, seen alive 5 s later, gone 5 s after that, again and again.
    for _ in 0..40 {
        now += secs(1);
        let (action, _) = dog.decide(&missing, now);
        if action != WatchdogAction::None {
            launches += 1;
            dog.record_launch(true, now);
            now += secs(5);
            dog.decide(&present, now);
            now += secs(5);
        }
    }
    // Five quick vanishings make it failed, after which attempts are 30 s apart.
    assert!(dog.launch_failures() >= FAILURES_BEFORE_FAILED);
    assert!(launches < 15, "{launches} launches in {} s", (now - t0).as_secs());
    assert_eq!(dog.decide(&missing, now).1, ShellHealth::Failed);
}

#[test]
fn a_launcher_that_stays_30_seconds_ends_the_failure_streak() {
    let t0 = Instant::now();
    let mut dog = Watchdog::new(true);
    let missing = input(true, Some(2), &[], vec![]);
    let present = input(true, Some(2), &[900], vec![]);
    dog.decide(&missing, t0);
    dog.record_launch(false, t0 + secs(3));
    dog.record_launch(false, t0 + secs(6));
    assert_eq!(dog.launch_failures(), 2);
    dog.record_launch(true, t0 + secs(9));
    dog.decide(&present, t0 + secs(10));
    assert_eq!(dog.launch_failures(), 2);
    dog.decide(&present, t0 + secs(40));
    assert_eq!(dog.launch_failures(), 0);
    // It dying later is a fresh problem, not a streak.
    dog.decide(&missing, t0 + secs(50));
    assert_eq!(dog.launch_failures(), 0);
}

#[test]
fn the_staff_session_ending_resets_everything() {
    let t0 = Instant::now();
    let mut dog = Watchdog::new(true);
    let hung = input(true, Some(2), &[900], vec![ready_client(77, t0, None)]);
    assert_eq!(dog.decide(&hung, t0 + secs(40)).0, WatchdogAction::TerminateShell { pid: 77 });
    // The session ends.
    let gone = input(true, None, &[], vec![]);
    assert_eq!(dog.decide(&gone, t0 + secs(41)), (WatchdogAction::None, ShellHealth::NotRunning));
    // A new session starts: the kill limit and the timers start fresh.
    let again = input(true, Some(3), &[950], vec![ready_client(78, t0 + secs(50), None)]);
    assert_eq!(dog.decide(&again, t0 + secs(52)), (WatchdogAction::None, ShellHealth::Healthy));
    assert_eq!(dog.decide(&again, t0 + secs(81)).0, WatchdogAction::TerminateShell { pid: 78 });
}

#[test]
fn a_new_session_id_starts_over() {
    let t0 = Instant::now();
    let mut dog = Watchdog::new(true);
    dog.decide(&input(true, Some(2), &[], vec![]), t0);
    // Session 3 replaces session 2 without the Staff App ever showing as "no session":
    // the grace is counted from the first look at session 3.
    assert_eq!(dog.decide(&input(true, Some(3), &[], vec![]), t0 + secs(5)).0, WatchdogAction::None);
    assert_eq!(
        dog.decide(&input(true, Some(3), &[], vec![]), t0 + secs(8)).0,
        WatchdogAction::LaunchLauncher { session_id: 3 }
    );
}

#[test]
fn the_launcher_alone_follows_the_launcher_rules_only() {
    // (1.1) A `launcher`-role connection is filtered out by the task, so the input has
    // no shell client: starting, then unhealthy after 30 s, never a terminate.
    let t0 = Instant::now();
    let mut dog = Watchdog::new(true);
    let alone = input(true, Some(2), &[900], vec![]);
    assert_eq!(dog.decide(&alone, t0), (WatchdogAction::None, ShellHealth::Starting));
    assert_eq!(dog.decide(&alone, t0 + secs(20)), (WatchdogAction::None, ShellHealth::Starting));
    assert_eq!(dog.decide(&alone, t0 + secs(31)), (WatchdogAction::None, ShellHealth::Unhealthy));
    assert_eq!(dog.decide(&alone, t0 + secs(600)), (WatchdogAction::None, ShellHealth::Unhealthy));
}

#[test]
fn a_restarted_staff_app_is_starting_again() {
    let t0 = Instant::now();
    let mut dog = Watchdog::new(true);
    let up = input(true, Some(2), &[900], vec![ready_client(77, t0, Some(t0 + secs(10)))]);
    assert_eq!(dog.decide(&up, t0 + secs(12)).1, ShellHealth::Healthy);
    // It was killed or crashed: no client for a while.
    let down = input(true, Some(2), &[900], vec![]);
    assert_eq!(dog.decide(&down, t0 + secs(100)).1, ShellHealth::Starting);
    assert_eq!(dog.decide(&down, t0 + secs(120)).1, ShellHealth::Starting);
    assert_eq!(dog.decide(&down, t0 + secs(131)).1, ShellHealth::Unhealthy);
}

// -- the task, over SimPlatform ---------------------------------------------------------

struct Rig {
    _dir: TempDir,
    sim: Arc<SimPlatform>,
    snapshot: SnapshotHandle,
    gate: Arc<Mutex<Gate>>,
    install: InstallPaths,
    task: WatchdogTask,
}

impl Rig {
    fn new() -> Self {
        Self::with(true, false)
    }

    fn with(kill_hung_shell: bool, simulate: bool) -> Self {
        let dir = TempDir::new();
        let sim = Arc::new(SimPlatform::new(dir.path().to_path_buf()));
        let install = InstallPaths::new(dir.path().join("install"));
        std::fs::create_dir_all(install.root().join("versions").join("1.0")).unwrap();
        std::fs::write(
            install.current_json(),
            r#"{ "version": "1.0", "exe": "versions\\1.0\\rulebox-staff.exe" }"#,
        )
        .unwrap();
        sim.add_session(2, Some(STAFF), true);
        let (snapshot, _rx) = SnapshotHandle::new(test_snapshot());
        let gate = Arc::new(Mutex::new(Gate { kiosk_enabled: true, staff_sid: Some(STAFF.to_string()) }));
        let gate_for_task = Arc::clone(&gate);
        let task = WatchdogTask::new(WatchdogDeps {
            platform: sim.clone(),
            snapshot: snapshot.clone(),
            install: install.clone(),
            kill_hung_shell,
            simulate,
            gate: Arc::new(move || crate::state::lock(&gate_for_task).clone()),
        });
        Self { _dir: dir, sim, snapshot, gate, install, task }
    }

    fn launcher_exe(&self) -> PathBuf {
        self.install.shell_exe()
    }

    fn staff_exe(&self) -> PathBuf {
        self.install.root().join("versions").join("1.0").join("rulebox-staff.exe")
    }

    fn add_process(&self, pid: u32, session_id: u32, image: PathBuf, sid: &str) {
        self.sim.with_world(|world| {
            world.processes.push(SimProcess { pid, session_id, image, user_sid: sid.to_string() });
        });
    }

    fn add_launcher(&self) {
        self.add_process(900, 2, self.launcher_exe(), STAFF);
    }

    fn processes_in(&self, image: &Path) -> Vec<u32> {
        self.sim.with_world(|world| {
            world.processes.iter().filter(|p| p.image == image).map(|p| p.pid).collect()
        })
    }

    fn calls(&self, op: SimOp) -> usize {
        self.sim.calls().iter().filter(|call| **call == op).count()
    }

    fn health(&self) -> ShellHealth {
        self.snapshot.current().shell.health
    }

    /// Moves the clock and looks once.
    async fn step(&mut self, seconds: u64) {
        tokio::time::advance(secs(seconds)).await;
        self.task.evaluate().await;
    }

    /// A Staff App client: connects, says ready.
    fn staff_app_connects(&mut self, connection_id: u64, pid: u32) {
        let now = Instant::now();
        self.task.on_signal(ShellSignal::Connected { connection_id, pid, role: ClientRole::Shell }, now);
        self.task.on_signal(ShellSignal::Ready { connection_id, pid }, now);
    }

    fn heartbeat(&mut self, connection_id: u64, pid: u32) -> bool {
        self.task.on_signal(ShellSignal::Heartbeat { connection_id, pid }, Instant::now())
    }

    fn set_gate(&self, change: impl FnOnce(&mut Gate)) {
        change(&mut crate::state::lock(&self.gate));
    }
}

#[tokio::test(start_paused = true)]
async fn a_missing_launcher_is_relaunched_in_the_staff_session() {
    let mut rig = Rig::new();
    rig.task.evaluate().await;
    assert_eq!(rig.calls(SimOp::LaunchInSession), 0);
    rig.step(2).await;
    assert_eq!(rig.calls(SimOp::LaunchInSession), 0);
    assert_eq!(rig.health(), ShellHealth::NotRunning);

    rig.step(1).await;
    assert_eq!(rig.calls(SimOp::LaunchInSession), 1);
    let launched = rig.sim.with_world(|world| world.processes.clone());
    assert_eq!(launched.len(), 1);
    assert_eq!(launched[0].image, rig.launcher_exe());
    assert_eq!((launched[0].session_id, launched[0].user_sid.as_str()), (2, STAFF));

    // The next look finds it and the health is "starting"; nothing else happens.
    rig.step(5).await;
    assert_eq!(rig.health(), ShellHealth::Starting);
    assert_eq!(rig.calls(SimOp::LaunchInSession), 1);
}

#[tokio::test(start_paused = true)]
async fn a_present_launcher_is_left_alone_for_ten_minutes() {
    let mut rig = Rig::new();
    rig.add_launcher();
    rig.task.evaluate().await;
    assert_eq!(rig.health(), ShellHealth::Starting);
    for _ in 0..120 {
        rig.step(5).await;
    }
    // The Staff App never showed up (Phase 2: the launcher's fallback screen): the
    // agent reports it and does nothing at all.
    assert_eq!(rig.health(), ShellHealth::Unhealthy);
    assert_eq!(rig.calls(SimOp::LaunchInSession), 0);
    assert_eq!(rig.calls(SimOp::TerminateProcess), 0);
    assert_eq!(rig.processes_in(&rig.launcher_exe()), [900]);
}

/// Connects a Staff App at pid 7001, lets it beat for a while, then silence.
async fn hung_staff_app(rig: &mut Rig, process_sid: &str) {
    rig.add_launcher();
    rig.add_process(7001, 2, rig.staff_exe(), process_sid);
    rig.staff_app_connects(1, 7001);
    rig.task.evaluate().await;
    assert_eq!(rig.health(), ShellHealth::Healthy);
    for _ in 0..3 {
        rig.step(10).await;
        rig.heartbeat(1, 7001);
    }
    rig.step(10).await;
    assert_eq!(rig.health(), ShellHealth::Healthy);
    // `h` in fake_staff: heartbeats stop. 29 s of silence is still fine.
    rig.step(19).await;
    assert_eq!(rig.health(), ShellHealth::Healthy);
    assert_eq!(rig.calls(SimOp::TerminateProcess), 0);
    rig.step(2).await;
}

#[tokio::test(start_paused = true)]
async fn a_hung_staff_app_is_terminated_when_its_identity_matches() {
    let mut rig = Rig::new();
    hung_staff_app(&mut rig, STAFF).await;
    assert_eq!(rig.calls(SimOp::TerminateProcess), 1);
    assert!(rig.processes_in(&rig.staff_exe()).is_empty(), "the hung Staff App must be gone");
    // The launcher (a separate program in real life) is untouched.
    assert_eq!(rig.processes_in(&rig.launcher_exe()), [900]);
    assert_eq!(rig.health(), ShellHealth::Unhealthy);
}

#[tokio::test(start_paused = true)]
async fn a_process_of_another_user_is_never_terminated() {
    let mut rig = Rig::new();
    hung_staff_app(&mut rig, OTHER).await;
    // The attempt was made (and refused by the identity check) ...
    assert_eq!(rig.calls(SimOp::TerminateProcess), 1);
    assert_eq!(rig.processes_in(&rig.staff_exe()), [7001]);
    // ... and is not repeated within 60 seconds.
    for _ in 0..11 {
        rig.step(5).await;
    }
    assert_eq!(rig.calls(SimOp::TerminateProcess), 1);
    rig.step(10).await;
    assert_eq!(rig.calls(SimOp::TerminateProcess), 2);
}

#[tokio::test(start_paused = true)]
async fn a_process_that_is_not_the_staff_app_named_by_current_json_is_never_terminated() {
    let mut rig = Rig::new();
    // The version file names another exe than the process that is connected.
    std::fs::write(
        rig.install.current_json(),
        r#"{ "version": "2.0", "exe": "versions\\2.0\\rulebox-staff.exe" }"#,
    )
    .unwrap();
    hung_staff_app(&mut rig, STAFF).await;
    assert_eq!(rig.processes_in(&rig.staff_exe()), [7001]);

    // A damaged or missing current.json: nothing is terminated either.
    let mut rig = Rig::new();
    std::fs::write(rig.install.current_json(), "{ not json").unwrap();
    hung_staff_app(&mut rig, STAFF).await;
    assert_eq!(rig.processes_in(&rig.staff_exe()), [7001]);
}

#[tokio::test(start_paused = true)]
async fn kill_hung_shell_false_only_reports() {
    let mut rig = Rig::with(false, false);
    hung_staff_app(&mut rig, STAFF).await;
    for _ in 0..30 {
        rig.step(5).await;
    }
    assert_eq!(rig.calls(SimOp::TerminateProcess), 0);
    assert_eq!(rig.processes_in(&rig.staff_exe()), [7001]);
    assert_eq!(rig.health(), ShellHealth::Unhealthy);
}

#[tokio::test(start_paused = true)]
async fn a_simulated_agent_only_logs_the_terminate() {
    let mut rig = Rig::with(true, true);
    hung_staff_app(&mut rig, STAFF).await;
    assert_eq!(rig.calls(SimOp::TerminateProcess), 0);
    assert_eq!(rig.processes_in(&rig.staff_exe()), [7001]);
}

#[tokio::test(start_paused = true)]
async fn a_staff_app_that_heartbeats_again_before_30_seconds_is_never_touched() {
    let mut rig = Rig::new();
    rig.add_launcher();
    rig.add_process(7001, 2, rig.staff_exe(), STAFF);
    rig.staff_app_connects(1, 7001);
    for _ in 0..30 {
        rig.step(10).await;
        rig.heartbeat(1, 7001);
    }
    assert_eq!(rig.health(), ShellHealth::Healthy);
    assert_eq!(rig.calls(SimOp::TerminateProcess), 0);
    // A heartbeat while healthy needs no look at the machine.
    let sessions_before = rig.calls(SimOp::Sessions);
    assert!(!rig.heartbeat(1, 7001));
    assert_eq!(rig.calls(SimOp::Sessions), sessions_before);
}

#[tokio::test(start_paused = true)]
async fn a_launcher_role_connection_is_not_a_staff_app() {
    let mut rig = Rig::new();
    rig.add_launcher();
    let now = Instant::now();
    // The fallback screen's short calls.
    assert!(!rig.task.on_signal(
        ShellSignal::Connected { connection_id: 5, pid: 900, role: ClientRole::Launcher },
        now
    ));
    assert!(!rig.task.on_signal(ShellSignal::Ready { connection_id: 5, pid: 900 }, now));
    assert!(!rig.task.on_signal(ShellSignal::Heartbeat { connection_id: 5, pid: 900 }, now));
    rig.task.evaluate().await;
    assert_eq!(rig.health(), ShellHealth::Starting);
    for _ in 0..30 {
        rig.step(5).await;
    }
    // Following the launcher rules only: unhealthy, and nothing is terminated.
    assert_eq!(rig.health(), ShellHealth::Unhealthy);
    assert_eq!(rig.calls(SimOp::TerminateProcess), 0);
    assert_eq!(rig.calls(SimOp::LaunchInSession), 0);
}

#[tokio::test(start_paused = true)]
async fn a_closed_connection_is_forgotten() {
    let mut rig = Rig::new();
    rig.add_launcher();
    rig.staff_app_connects(1, 7001);
    rig.task.evaluate().await;
    assert_eq!(rig.health(), ShellHealth::Healthy);
    assert!(rig.task.on_signal(ShellSignal::Closed { connection_id: 1 }, Instant::now()));
    rig.step(1).await;
    assert_eq!(rig.health(), ShellHealth::Starting);
    // A Staff App that was killed does not leave a ghost that is "hung" later.
    for _ in 0..30 {
        rig.step(5).await;
    }
    assert_eq!(rig.calls(SimOp::TerminateProcess), 0);
}

#[tokio::test(start_paused = true)]
async fn launch_failures_become_failed_and_are_retried_every_30_seconds() {
    let mut rig = Rig::new();
    for _ in 0..5 {
        rig.sim.fail_next(SimOp::LaunchInSession, PlatformError::AccessDenied);
    }
    rig.task.evaluate().await;
    for _ in 0..14 {
        rig.step(1).await;
    }
    // Attempts at 3, 6, 9, 12 s.
    assert_eq!(rig.calls(SimOp::LaunchInSession), 4);
    assert_eq!(rig.health(), ShellHealth::NotRunning);
    rig.step(1).await;
    // The fifth, at 15 s, makes it failed at once.
    assert_eq!(rig.calls(SimOp::LaunchInSession), 5);
    assert_eq!(rig.health(), ShellHealth::Failed);
    for _ in 0..29 {
        rig.step(1).await;
    }
    assert_eq!(rig.calls(SimOp::LaunchInSession), 5, "no attempt inside the 30 s wait");
    rig.step(1).await;
    assert_eq!(rig.calls(SimOp::LaunchInSession), 6);
    // That one worked: the launcher exists and the health follows it.
    rig.step(5).await;
    assert_eq!(rig.health(), ShellHealth::Starting);
    assert_eq!(rig.calls(SimOp::LaunchInSession), 6);
}

#[tokio::test(start_paused = true)]
async fn a_failed_lookup_never_starts_anything() {
    let mut rig = Rig::new();
    for _ in 0..40 {
        rig.sim.fail_next(SimOp::Sessions, PlatformError::Other("wts".into()));
    }
    for _ in 0..40 {
        rig.step(5).await;
    }
    assert_eq!(rig.calls(SimOp::LaunchInSession), 0);
    // The process lookup failing is the same.
    let mut rig = Rig::new();
    for _ in 0..40 {
        rig.sim.fail_next(SimOp::FindProcesses, PlatformError::Other("toolhelp".into()));
    }
    for _ in 0..40 {
        rig.step(5).await;
    }
    assert_eq!(rig.calls(SimOp::LaunchInSession), 0);
    assert_eq!(rig.health(), ShellHealth::NotRunning);
}

fn shared_state(dir: &Path, sim: &Arc<SimPlatform>, enrolled: bool, applied: KioskApplied) -> Arc<SharedState> {
    let store = StateStore::open(&dir.join("state")).unwrap();
    let state = AgentState {
        enrollment: enrolled.then(|| Enrollment {
            convex_url: "https://x.convex.cloud".into(),
            device_id: "d1".into(),
            org_id: "o1".into(),
            device_name: "Desk".into(),
            enrolled_at_ms: 1,
            revoked: false,
            allow_joined: false,
        }),
        staff: Some(StaffAccount { sid: STAFF.into(), user_name: "RuleboxStaff".into(), profile_dir: None }),
        kiosk: KioskRecord { applied, ..KioskRecord::default() },
        ..AgentState::default()
    };
    SharedState::new(store, state, sim.clone())
}

#[tokio::test(start_paused = true)]
async fn the_real_gate_follows_enrollment_and_the_kiosk() {
    let dir = TempDir::new();
    let sim = Arc::new(SimPlatform::new(dir.path().to_path_buf()));
    sim.add_session(2, Some(STAFF), true);
    let install = InstallPaths::new(dir.path().join("install"));
    let shared = shared_state(dir.path(), &sim, true, KioskApplied::Enabled);
    let (snapshot, _rx) = SnapshotHandle::new(test_snapshot());
    let mut task = WatchdogTask::new(WatchdogDeps {
        platform: sim.clone(),
        snapshot: snapshot.clone(),
        install: install.clone(),
        kill_hung_shell: true,
        simulate: false,
        gate: state_gate(Arc::clone(&shared)),
    });
    let launches = |sim: &SimPlatform| sim.calls().iter().filter(|c| **c == SimOp::LaunchInSession).count();

    // Enrolled and enabled: the missing launcher is started.
    task.evaluate().await;
    tokio::time::advance(secs(3)).await;
    task.evaluate().await;
    assert_eq!(launches(&sim), 1);
    task.evaluate().await;
    assert_eq!(snapshot.current().shell.health, ShellHealth::Starting);

    // Revoked: the PC keeps its kiosk (Q11), so the watchdog keeps watching.
    shared.update(|state| state.enrollment.as_mut().unwrap().revoked = true).unwrap();
    sim.with_world(|world| world.processes.clear());
    task.evaluate().await;
    tokio::time::advance(secs(3)).await;
    task.evaluate().await;
    assert_eq!(launches(&sim), 2);

    // The kiosk is switched off (Disable): no launcher is started and nothing is read.
    shared.update(|state| state.kiosk.applied = KioskApplied::Disabled).unwrap();
    sim.with_world(|world| world.processes.clear());
    let sessions_before = sim.calls().iter().filter(|c| **c == SimOp::Sessions).count();
    for _ in 0..6 {
        tokio::time::advance(secs(5)).await;
        task.evaluate().await;
    }
    assert_eq!(launches(&sim), 2);
    assert_eq!(sim.calls().iter().filter(|c| **c == SimOp::Sessions).count(), sessions_before);
    assert_eq!(snapshot.current().shell.health, ShellHealth::NotRunning);

    // Not enrolled at all (after `unenroll`), whatever the record says.
    shared
        .update(|state| {
            state.enrollment = None;
            state.kiosk.applied = KioskApplied::Enabled;
        })
        .unwrap();
    for _ in 0..6 {
        tokio::time::advance(secs(5)).await;
        task.evaluate().await;
    }
    assert_eq!(launches(&sim), 2);
    assert_eq!(snapshot.current().shell.health, ShellHealth::NotRunning);
}

#[tokio::test(start_paused = true)]
async fn session_changes_are_followed() {
    let mut rig = Rig::new();
    rig.add_launcher();
    rig.task.evaluate().await;
    assert_eq!(rig.health(), ShellHealth::Starting);

    // The Staff user signs out: no session, nothing to do.
    rig.sim.with_world(|world| {
        world.sessions.clear();
        world.processes.clear();
    });
    rig.step(1).await;
    assert_eq!(rig.health(), ShellHealth::NotRunning);
    rig.step(60).await;
    assert_eq!(rig.calls(SimOp::LaunchInSession), 0);

    // A disconnected Staff session is left alone, too (plan edge case 19).
    rig.sim.add_session(4, Some(STAFF), false);
    rig.step(60).await;
    assert_eq!(rig.calls(SimOp::LaunchInSession), 0);
    assert_eq!(rig.health(), ShellHealth::NotRunning);

    // A new Active session: its launcher is started there, after the grace.
    rig.sim.with_world(|world| world.sessions.clear());
    rig.sim.add_session(5, Some(STAFF), true);
    rig.step(0).await;
    rig.step(3).await;
    assert_eq!(rig.calls(SimOp::LaunchInSession), 1);
    let sessions: Vec<u32> = rig.sim.with_world(|world| world.processes.iter().map(|p| p.session_id).collect());
    assert_eq!(sessions, [5]);

    // Another user's session is not the Staff session.
    rig.sim.add_session(6, Some(OTHER), true);
    for _ in 0..12 {
        rig.step(5).await;
    }
    assert_eq!(rig.calls(SimOp::LaunchInSession), 1);
}

#[tokio::test(start_paused = true)]
async fn the_gate_can_hold_the_whole_task_idle() {
    let mut rig = Rig::new();
    rig.set_gate(|gate| gate.kiosk_enabled = false);
    for _ in 0..12 {
        rig.step(5).await;
    }
    assert_eq!(rig.calls(SimOp::LaunchInSession), 0);
    assert_eq!(rig.calls(SimOp::Sessions), 0);
    rig.set_gate(|gate| gate.staff_sid = None);
    rig.set_gate(|gate| gate.kiosk_enabled = true);
    for _ in 0..12 {
        rig.step(5).await;
    }
    assert_eq!(rig.calls(SimOp::LaunchInSession), 0);
}

#[tokio::test(start_paused = true)]
async fn the_loop_ticks_wakes_on_session_events_and_stops_on_shutdown() {
    let dir = TempDir::new();
    let sim = Arc::new(SimPlatform::new(dir.path().to_path_buf()));
    sim.add_session(2, Some(STAFF), true);
    let (snapshot, _rx) = SnapshotHandle::new(test_snapshot());
    let (signals_tx, signals_rx) = mpsc::unbounded_channel();
    let (handle, events_rx) = channel();
    let shutdown = CancellationToken::new();
    let deps = WatchdogDeps {
        platform: sim.clone(),
        snapshot: snapshot.clone(),
        install: InstallPaths::new(dir.path().join("install")),
        kill_hung_shell: true,
        simulate: false,
        gate: Arc::new(|| Gate { kiosk_enabled: true, staff_sid: Some(STAFF.to_string()) }),
    };
    let join = tokio::spawn(run(deps, signals_rx, events_rx, shutdown.clone()));
    let settle = || async {
        for _ in 0..20 {
            tokio::task::yield_now().await;
        }
    };
    let count = |op: SimOp| sim.calls().iter().filter(|c| **c == op).count();

    settle().await;
    assert_eq!(count(SimOp::Sessions), 1, "the first look is immediate");

    // The 5-second tick.
    tokio::time::advance(secs(5)).await;
    settle().await;
    assert_eq!(count(SimOp::Sessions), 2);
    assert_eq!(count(SimOp::LaunchInSession), 1, "missing for 5 s: started");

    // A session event is looked at at once, not at the next tick.
    handle.session_changed();
    settle().await;
    assert_eq!(count(SimOp::Sessions), 3);
    assert_eq!(snapshot.current().shell.health, ShellHealth::Starting);

    // Shell signals reach the table: ready and heartbeats make it healthy.
    signals_tx
        .send(ShellSignal::Connected { connection_id: 1, pid: 7001, role: ClientRole::Shell })
        .unwrap();
    signals_tx.send(ShellSignal::Ready { connection_id: 1, pid: 7001 }).unwrap();
    settle().await;
    assert_eq!(snapshot.current().shell.health, ShellHealth::Healthy);
    // A heartbeat while healthy is not a look at the machine.
    let before = count(SimOp::Sessions);
    signals_tx.send(ShellSignal::Heartbeat { connection_id: 1, pid: 7001 }).unwrap();
    settle().await;
    assert_eq!(count(SimOp::Sessions), before);

    shutdown.cancel();
    join.await.unwrap();
}

#[test]
fn the_simulated_staff_session_gate_is_always_on() {
    let gate = sim_gate();
    assert_eq!(gate(), Gate { kiosk_enabled: true, staff_sid: Some(SIM_STAFF_SID.to_string()) });
}
