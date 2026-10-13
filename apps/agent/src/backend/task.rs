//! The `backend` task of plan Section 5.2 (behaviour in Section 5.8): the one
//! subscription to the device's own desired state, the heartbeat, the clock and the
//! `desired-state.json` cache.
//!
//! Data rules it follows (CLAUDE.md "Data access rules"):
//!
//! - **One subscription, no polling.** Nothing here asks the server for the desired
//!   state; the subscription pushes it.
//! - **Write only on change.** A heartbeat carries the status object only when it
//!   differs from the last one the server accepted, and a document that is
//!   identical to the accepted one changes nothing and writes nothing.
//! - **Jitter.** After each transition to online the first heartbeat waits a random
//!   0 to 10 seconds (PRD 13.6 #5); every later one is scheduled from the server's
//!   `nextPingInMs` with +-10 %. A failed heartbeat waits for the next scheduled
//!   time; there is no retry loop.

use std::sync::Arc;
use std::time::Duration;

use futures_util::FutureExt;
use rulebox_ipc::types::{AgentSnapshot, ConnectionStatus, EnrollmentStatus};
use rulebox_policy::DesiredState;
use serde::Serialize;
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use super::{
    Backend, BackendError, BackendEvent, BackendFactory, DesiredFetch, DeviceAuth, HeartbeatResponse,
    StatusReport,
};
use crate::agent::{load_cached_desired, CachedDesired};
use crate::agent_policy::AgentPolicy;
use crate::compat;
use crate::kiosk_control::KioskControl;
use crate::paths::DataPaths;
use crate::platform::Platform;
use crate::session::SessionManager;
use crate::state::{write_atomic, SharedState, SnapshotHandle};

/// First heartbeat after a transition to online: a random wait up to this long.
const FIRST_HEARTBEAT_JITTER_MS: u64 = 10_000;
/// Used until the server says otherwise (it says 300,000 in Phase 2).
const DEFAULT_PING_MS: u64 = 300_000;
/// The server's `nextPingInMs` is clamped to this range, so a buggy value neither
/// makes a tight loop nor silences the device for a day.
const MIN_PING_MS: u64 = 5_000;
const MAX_PING_MS: u64 = 3_600_000;
/// More than this behind the highest clock seen: `clockSuspect` (Section 5.8).
const CLOCK_SUSPECT_MS: u64 = 24 * 3_600_000;
/// `last_wall_clock_ms` is rewritten to disk when it moved by at least this much.
const CLOCK_SAVE_STEP_MS: u64 = 60_000;
/// The server-time offset in the snapshot changes only by at least this much, so
/// network latency does not produce a `state.changed` on every heartbeat.
const OFFSET_STEP_MS: i64 = 2_000;
/// Events from the subscription wait here for the task.
const EVENT_QUEUE: usize = 16;
/// What the heartbeat reports when a document was received but did not parse.
pub const PROBLEM_DESIRED_STATE_INVALID: &str = "desired_state_invalid";

/// Everything the task and the enrollment flow share.
pub struct TaskContext {
    pub shared: Arc<SharedState>,
    pub paths: DataPaths,
    pub snapshot: SnapshotHandle,
    /// The agent-only keys of the accepted document (`AgentPolicy`).
    pub policy_tx: Arc<watch::Sender<AgentPolicy>>,
    pub session: Arc<SessionManager>,
    pub control: Arc<dyn KioskControl>,
    pub platform: Arc<dyn Platform>,
    pub factory: BackendFactory,
    /// The wall clock, in Unix milliseconds.
    pub now_ms: Arc<dyn Fn() -> u64 + Send + Sync>,
    /// A random number in `0..=max`.
    pub jitter: Arc<dyn Fn(u64) -> u64 + Send + Sync>,
}

/// A random number in `0..=max` from the OS random source.
pub fn os_jitter(max: u64) -> u64 {
    if max == 0 {
        return 0;
    }
    let mut bytes = [0u8; 8];
    if getrandom::fill(&mut bytes).is_err() {
        return max / 2;
    }
    u64::from_le_bytes(bytes) % (max + 1)
}

// -- applying a document ----------------------------------------------------------

/// What `DesiredSync::accept` did with a document.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DocOutcome {
    /// New content: cached, shown in the snapshot, reconciler told.
    Applied,
    /// Identical to the accepted document: nothing changed.
    Unchanged,
    /// A lower version than one already applied: ignored.
    Stale,
    /// `doc` is not a `DesiredState`: the previous state and policy stay.
    Invalid,
}

/// Puts an accepted document into the snapshot: the `DesiredState`, its version
/// and the protocol 1.1 fields that come from the agent-only keys.
pub fn apply_to_snapshot(
    snapshot: &mut AgentSnapshot,
    desired: &DesiredState,
    version: u64,
    policy: &AgentPolicy,
) {
    snapshot.desired_state = Some(desired.clone());
    snapshot.desired_state_version = version;
    policy.apply_to_snapshot(snapshot);
}

/// Sends `policy` on the channel when it differs from the current one.
pub fn publish_policy(tx: &watch::Sender<AgentPolicy>, policy: AgentPolicy) -> bool {
    tx.send_if_modified(|current| {
        if *current == policy {
            false
        } else {
            *current = policy;
            true
        }
    })
}

/// Decides what to do with each document (Section 5.6 and 5.8): stale ones are
/// ignored, unparseable ones keep the previous state, accepted ones are cached.
pub struct DesiredSync {
    /// The highest version applied or cached: a lower one is stale.
    floor: u64,
    /// The last accepted version and its raw document.
    accepted: Option<(u64, serde_json::Value)>,
    /// Set while the newest document did not parse.
    pub problem: Option<&'static str>,
}

impl DesiredSync {
    pub fn new(last_applied_version: u64) -> Self {
        Self { floor: last_applied_version, accepted: None, problem: None }
    }

    /// Reads `desired-state.json` once at start and applies it (without writing it
    /// back), so the snapshot and the policy show the cached state while offline.
    pub fn load_cached(&mut self, ctx: &TaskContext) {
        let Some(cached) = load_cached_desired(&ctx.paths) else {
            return;
        };
        self.floor = self.floor.max(cached.version);
        self.apply(ctx, cached.version, cached.doc, cached.signature, false);
    }

    /// Handles a document from the subscription.
    pub fn accept(
        &mut self,
        ctx: &TaskContext,
        version: u64,
        doc: serde_json::Value,
        signature: Option<String>,
    ) -> DocOutcome {
        if version < self.floor {
            tracing::info!(version, floor = self.floor, "ignoring a stale desired state");
            return DocOutcome::Stale;
        }
        if let Some((accepted_version, accepted_doc)) = &self.accepted {
            if *accepted_version == version {
                if *accepted_doc == doc {
                    return DocOutcome::Unchanged;
                }
                tracing::warn!(version, "a different document arrived with the same version; applying it");
            }
        }
        self.apply(ctx, version, doc, signature, true)
    }

    fn apply(
        &mut self,
        ctx: &TaskContext,
        version: u64,
        doc: serde_json::Value,
        signature: Option<String>,
        write_cache: bool,
    ) -> DocOutcome {
        let desired = match serde_json::from_value::<DesiredState>(doc.clone()) {
            Ok(desired) => desired,
            Err(error) => {
                // The error names DesiredState fields only (never `adminExit`), so it
                // cannot quote the exit PIN hash.
                tracing::error!(version, "{PROBLEM_DESIRED_STATE_INVALID}: {error}");
                self.problem = Some(PROBLEM_DESIRED_STATE_INVALID);
                return DocOutcome::Invalid;
            }
        };
        self.problem = None;
        self.floor = self.floor.max(version);

        if write_cache {
            // Cache first, so a restart that follows sees what the kiosk was told.
            let cached = CachedDesired { version, doc: doc.clone(), signature };
            let written = serde_json::to_vec_pretty(&cached)
                .map_err(std::io::Error::other)
                .and_then(|bytes| write_atomic(&ctx.paths.desired_state(), &bytes));
            if let Err(error) = written {
                tracing::error!("cannot save desired-state.json: {error}");
            }
        }

        let policy = AgentPolicy::from_doc(Some(&doc));
        ctx.snapshot.update(|snapshot| apply_to_snapshot(snapshot, &desired, version, &policy));
        publish_policy(&ctx.policy_tx, policy);
        self.accepted = Some((version, doc));
        tracing::info!(version, kiosk_enabled = desired.kiosk_enabled, "desired state accepted");
        DocOutcome::Applied
    }
}

// -- clock ------------------------------------------------------------------------

/// Keeps `last_wall_clock_ms` current and `clockSuspect` right (Section 5.8).
///
/// The agent never rejects anything because of its own clock. `clockSuspect` is set
/// when the clock is more than 24 hours behind the highest one seen, or when the
/// server says it is more than 24 hours off. A clock that the server says is far off
/// does not raise the stored highest value: one wrong "forward" reading (a flat
/// CMOS battery can give any date) would otherwise count as the floor forever.
pub fn note_clock(ctx: &TaskContext) {
    let now = (ctx.now_ms)();
    let floor = ctx.shared.last_wall_clock_ms();
    let behind = floor > now && floor - now > CLOCK_SUSPECT_MS;
    let server_says_off = ctx
        .snapshot
        .current()
        .server_time_offset_ms
        .is_some_and(|offset| offset.unsigned_abs() > CLOCK_SUSPECT_MS);
    if !server_says_off {
        if let Err(error) = ctx.shared.note_wall_clock(now, CLOCK_SAVE_STEP_MS) {
            tracing::warn!("cannot save the wall clock: {error}");
        }
    }
    let suspect = behind || server_says_off;
    let changed = ctx.snapshot.update(|snapshot| snapshot.clock_suspect = suspect);
    if changed && suspect {
        tracing::warn!(
            behind,
            server_says_off,
            "the device clock looks wrong; check the date and time (TLS fails with a wrong clock)"
        );
    }
}

/// Stores `serverTimeMs - localNowMs` in the snapshot (when it moved enough).
pub fn note_server_time(ctx: &TaskContext, server_time_ms: i64) {
    let local = i64::try_from((ctx.now_ms)()).unwrap_or(i64::MAX);
    let offset = server_time_ms.saturating_sub(local);
    ctx.snapshot.update(|snapshot| {
        let keep = snapshot
            .server_time_offset_ms
            .is_some_and(|current| (current - offset).abs() < OFFSET_STEP_MS);
        if !keep {
            snapshot.server_time_offset_ms = Some(offset);
        }
    });
}

// -- status -----------------------------------------------------------------------

/// The wire text of a serializable enum value.
fn wire<T: Serialize>(value: &T) -> Option<String> {
    match serde_json::to_value(value) {
        Ok(serde_json::Value::String(text)) => Some(text),
        _ => None,
    }
}

/// The full status snapshot for the heartbeat, or `None` when the machine could not
/// be read (the heartbeat then goes without `status` and the stored one stays).
/// `lockdownLevel` is left out: Phase 2 has no lockdown levels.
pub fn build_status(ctx: &TaskContext, desired_problem: Option<&str>) -> Option<StatusReport> {
    let state = ctx.shared.get();
    let os = match ctx.platform.os_info() {
        Ok(os) => os,
        Err(error) => {
            tracing::debug!("status skipped: cannot read the OS information: {error}");
            return None;
        }
    };
    let staff_sid = state.staff.as_ref().map(|staff| staff.sid.as_str());
    let report = match compat::build(ctx.platform.as_ref(), staff_sid, false) {
        Ok(report) => report,
        Err(error) => {
            tracing::debug!("status skipped: cannot build the compatibility report: {error}");
            return None;
        }
    };
    let snapshot = ctx.snapshot.current();
    Some(StatusReport {
        agent_version: snapshot.agent_version.clone(),
        os: Some(format!("Windows {}", if os.build >= 22_000 { 11 } else { 10 })),
        os_build: Some(format!("{}.{}", os.build, os.ubr)),
        os_edition: Some(os.edition_id.clone()),
        ram_mb: Some(os.ram_mb),
        disk_free_gb: Some(os.system_disk_free_gb),
        lockdown_level: None,
        kiosk_phase: wire(&snapshot.kiosk.phase),
        kiosk_error: snapshot
            .kiosk
            .error_code
            .clone()
            .or_else(|| desired_problem.map(str::to_string)),
        applied_version: Some(state.last_applied_version),
        shell_health: wire(&snapshot.shell.health),
        compat: report.to_json(),
    })
}

// -- the task ---------------------------------------------------------------------

/// What a spawned heartbeat call reports back.
struct HeartbeatDone {
    result: Result<HeartbeatResponse, BackendError>,
    /// The serialized status that was sent, when one was.
    sent_status: Option<String>,
}

/// `base_ms` with +-10 % jitter.
fn ping_delay(ctx: &TaskContext, base_ms: u64) -> Duration {
    let base = base_ms.clamp(MIN_PING_MS, MAX_PING_MS);
    let spread = base / 10;
    Duration::from_millis(base - spread + (ctx.jitter)(2 * spread))
}

fn handle_revoked(ctx: &TaskContext, unknown: bool) {
    tracing::warn!(
        unknown,
        "this device was revoked on the backend: the kiosk state stays as it is and syncing stops"
    );
    let saved = ctx.shared.update(|state| {
        if let Some(enrollment) = state.enrollment.as_mut() {
            enrollment.revoked = true;
        }
    });
    if let Err(error) = saved {
        tracing::error!("cannot save the revoked state: {error}");
    }
    ctx.snapshot.update(|snapshot| {
        snapshot.enrollment = EnrollmentStatus::Revoked;
        snapshot.connection = ConnectionStatus::Offline;
    });
    ctx.session.clear("revoked");
}

/// Runs until `shutdown`, or until the backend says the device is revoked (or
/// unknown). Never calls the reconciler's `disable`: a remote revocation must not
/// unlock a PC (README answer Q11).
pub async fn run_backend_task(
    ctx: Arc<TaskContext>,
    backend: Arc<dyn Backend>,
    auth: DeviceAuth,
    shutdown: CancellationToken,
) {
    tracing::warn!("policy signatures are not verified until Phase 4");

    let mut sync = DesiredSync::new(ctx.shared.read(|state| state.last_applied_version));
    sync.load_cached(&ctx);
    note_clock(&ctx);

    let (event_tx, mut events) = mpsc::channel::<BackendEvent>(EVENT_QUEUE);
    let mut subscription = backend.subscribe(auth.clone(), event_tx, shutdown.clone()).fuse();
    let (done_tx, mut done_rx) = mpsc::channel::<HeartbeatDone>(1);
    let mut heartbeat: Option<JoinHandle<()>> = None;
    let mut heartbeat_at: Option<Instant> = None;
    let mut online = false;
    let mut last_sent: Option<String> = None;
    let mut next_ping_ms = DEFAULT_PING_MS;
    let mut revoked = false;

    loop {
        let timer = async {
            match heartbeat_at {
                Some(at) => tokio::time::sleep_until(at).await,
                None => std::future::pending::<()>().await,
            }
        };
        tokio::select! {
            () = shutdown.cancelled() => break,
            () = &mut subscription => {
                // The subscription future only ends by itself when its channel is
                // gone; the fuse keeps this branch quiet afterwards.
                tracing::warn!("the desired-state subscription ended");
            }
            Some(event) = events.recv() => match event {
                BackendEvent::Connection(status) => {
                    ctx.snapshot.update(|snapshot| snapshot.connection = status);
                    let now_online = status == ConnectionStatus::Online;
                    if now_online && !online {
                        let wait = Duration::from_millis((ctx.jitter)(FIRST_HEARTBEAT_JITTER_MS));
                        heartbeat_at = Some(Instant::now() + wait);
                    }
                    if !now_online {
                        heartbeat_at = None;
                    }
                    online = now_online;
                }
                BackendEvent::Desired(DesiredFetch::None) => {
                    tracing::debug!("the backend has no desired state for this device yet");
                }
                BackendEvent::Desired(DesiredFetch::Doc { version, doc, signature }) => {
                    if sync.accept(&ctx, version, doc, signature) == DocOutcome::Applied {
                        ctx.control.desired_changed();
                    }
                }
                BackendEvent::Desired(DesiredFetch::Revoked) => {
                    handle_revoked(&ctx, false);
                    revoked = true;
                    break;
                }
                BackendEvent::Desired(DesiredFetch::UnknownDevice) => {
                    handle_revoked(&ctx, true);
                    revoked = true;
                    break;
                }
            },
            () = timer => {
                heartbeat_at = None;
                let in_flight = heartbeat.as_ref().is_some_and(|task| !task.is_finished());
                if online && !in_flight {
                    let status = build_status(&ctx, sync.problem);
                    let text = status.as_ref().and_then(|status| serde_json::to_string(status).ok());
                    // Only a status that differs from the last accepted one is sent.
                    let send = match (&status, &text) {
                        (Some(status), Some(text)) if last_sent.as_deref() != Some(text.as_str()) => {
                            Some((status.clone(), text.clone()))
                        }
                        _ => None,
                    };
                    let backend = Arc::clone(&backend);
                    let auth = auth.clone();
                    let done_tx = done_tx.clone();
                    heartbeat = Some(tokio::spawn(async move {
                        let (status, sent_status) = match send {
                            Some((status, text)) => (Some(status), Some(text)),
                            None => (None, None),
                        };
                        let result = backend.heartbeat(&auth, status).await;
                        let _ = done_tx.send(HeartbeatDone { result, sent_status }).await;
                    }));
                }
            }
            Some(done) = done_rx.recv() => {
                match done.result {
                    Ok(answer) => {
                        if let Some(text) = done.sent_status {
                            last_sent = Some(text);
                        }
                        next_ping_ms = answer.next_ping_in_ms;
                        note_server_time(&ctx, answer.server_time_ms);
                        note_clock(&ctx);
                    }
                    Err(BackendError::Rejected { .. }) => {
                        // The subscription decides what a rejection means.
                        tracing::warn!("the backend rejected the heartbeat");
                        last_sent = None;
                    }
                    Err(error) => {
                        tracing::debug!("heartbeat failed ({error}); waiting for the next one");
                    }
                }
                if online {
                    heartbeat_at = Some(Instant::now() + ping_delay(&ctx, next_ping_ms));
                }
            }
        }
    }

    if let Some(task) = heartbeat.take() {
        task.abort();
    }
    if !revoked {
        // Not syncing any more: do not leave "online" behind.
        ctx.snapshot.update(|snapshot| snapshot.connection = ConnectionStatus::Offline);
    }
}

// -- starting and stopping --------------------------------------------------------

struct Running {
    cancel: CancellationToken,
    handle: JoinHandle<()>,
}

/// Owns the backend task: starts it for an enrolled device, stops it for
/// unenrollment, and tells whether it is running. The task ends by itself when the
/// device is revoked.
pub struct BackendRunner {
    ctx: Arc<TaskContext>,
    parent: CancellationToken,
    running: tokio::sync::Mutex<Option<Running>>,
}

impl BackendRunner {
    pub fn new(ctx: Arc<TaskContext>, parent: CancellationToken) -> Arc<Self> {
        Arc::new(Self { ctx, parent, running: tokio::sync::Mutex::new(None) })
    }

    /// Starts the task with `backend` (stopping a running one first).
    pub async fn start(&self, backend: Arc<dyn Backend>, auth: DeviceAuth) {
        let mut running = self.running.lock().await;
        Self::stop_locked(&mut running).await;
        let cancel = self.parent.child_token();
        let handle = tokio::spawn(run_backend_task(
            Arc::clone(&self.ctx),
            backend,
            auth,
            cancel.clone(),
        ));
        *running = Some(Running { cancel, handle });
    }

    /// Starts the task from the saved enrollment and device secret. Returns false
    /// (with the reason logged) when the PC is not enrolled, was revoked, or the
    /// secret is missing.
    pub async fn start_from_state(&self) -> bool {
        let state = self.ctx.shared.get();
        let Some(enrollment) = state.enrollment.filter(|enrollment| !enrollment.revoked) else {
            return false;
        };
        let secret = match self.ctx.shared.secrets(|secrets| secrets.device_secret.clone()) {
            Ok(Some(secret)) => secret,
            Ok(None) => {
                tracing::error!("this PC is enrolled but has no device secret; it cannot sync");
                return false;
            }
            Err(error) => {
                tracing::error!("cannot read the device secret: {error}");
                return false;
            }
        };
        let backend = match (self.ctx.factory)(&enrollment.convex_url) {
            Ok(backend) => backend,
            Err(error) => {
                tracing::error!("cannot create the backend client: {error}");
                return false;
            }
        };
        self.start(backend, DeviceAuth { device_id: enrollment.device_id, device_secret: secret })
            .await;
        true
    }

    /// Stops the task and waits for it to end. Safe to call when it is not running.
    pub async fn stop(&self) {
        let mut running = self.running.lock().await;
        Self::stop_locked(&mut running).await;
    }

    async fn stop_locked(running: &mut Option<Running>) {
        if let Some(task) = running.take() {
            task.cancel.cancel();
            let _ = task.handle.await;
        }
    }

    /// True while the task is alive (false after a revocation ended it).
    #[cfg(test)]
    pub async fn is_running(&self) -> bool {
        self.running.lock().await.as_ref().is_some_and(|task| !task.handle.is_finished())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::Ordering;

    use serde_json::json;

    use crate::backend::fake::FakeBackend;
    use crate::backend::sha256_hex;
    use crate::platform::sim::SimPlatform;
    use crate::kiosk_control::FakeKioskControl;
    use crate::state::{AgentState, Enrollment, StateStore};
    use crate::testutil::{test_snapshot, TempDir};

    const START_MS: u64 = 1_760_000_000_000;

    struct Rig {
        // Held only so the directory is removed on drop.
        #[allow(dead_code)]
        dir: TempDir,
        ctx: Arc<TaskContext>,
        control: Arc<FakeKioskControl>,
        policy_rx: watch::Receiver<AgentPolicy>,
        snapshot_rx: watch::Receiver<AgentSnapshot>,
        clock: Arc<std::sync::atomic::AtomicU64>,
        jitter_ms: Arc<std::sync::atomic::AtomicU64>,
    }

    impl Rig {
        fn new() -> Self {
            Self::with_state(AgentState {
                enrollment: Some(Enrollment {
                    convex_url: "https://test.convex.cloud".into(),
                    device_id: "dev-1".into(),
                    org_id: "org-1".into(),
                    device_name: "Desk".into(),
                    enrolled_at_ms: 1,
                    revoked: false,
                    allow_joined: false,
                }),
                ..AgentState::default()
            })
        }

        fn with_state(state: AgentState) -> Self {
            let dir = TempDir::new();
            let platform: Arc<dyn Platform> = Arc::new(SimPlatform::new(dir.path().to_path_buf()));
            let paths = DataPaths::new(dir.path().to_path_buf());
            let store = StateStore::open(&paths.state_dir()).unwrap();
            let shared = SharedState::new(store, state.clone(), Arc::clone(&platform));
            let mut first = test_snapshot();
            if state.enrollment.is_some() {
                first.enrollment = EnrollmentStatus::Enrolled;
            }
            let (snapshot, snapshot_rx) = SnapshotHandle::new(first);
            let (policy_tx, policy_rx) = watch::channel(AgentPolicy::default());
            let clock = Arc::new(std::sync::atomic::AtomicU64::new(START_MS));
            let now_ms: Arc<dyn Fn() -> u64 + Send + Sync> = {
                let clock = Arc::clone(&clock);
                Arc::new(move || clock.load(Ordering::SeqCst))
            };
            let jitter_ms = Arc::new(std::sync::atomic::AtomicU64::new(0));
            let jitter: Arc<dyn Fn(u64) -> u64 + Send + Sync> = {
                let jitter_ms = Arc::clone(&jitter_ms);
                Arc::new(move |max| jitter_ms.load(Ordering::SeqCst).min(max))
            };
            let session = crate::testutil::test_session(dir.path(), snapshot_rx.clone());
            let control = Arc::new(FakeKioskControl::new());
            let ctx = Arc::new(TaskContext {
                shared,
                paths,
                snapshot,
                policy_tx: Arc::new(policy_tx),
                session,
                control: Arc::clone(&control) as Arc<dyn KioskControl>,
                platform,
                factory: Arc::new(|_| Err(BackendError::Unreachable)),
                now_ms,
                jitter,
            });
            Self { dir, ctx, control, policy_rx, snapshot_rx, clock, jitter_ms }
        }

        fn snapshot(&self) -> AgentSnapshot {
            self.snapshot_rx.borrow().clone()
        }

        fn start(&self, fake: &FakeBackend) -> (CancellationToken, JoinHandle<()>) {
            let cancel = CancellationToken::new();
            let handle = tokio::spawn(run_backend_task(
                Arc::clone(&self.ctx),
                Arc::new(fake.clone()),
                DeviceAuth { device_id: "dev-1".into(), device_secret: "ab".repeat(32) },
                cancel.clone(),
            ));
            (cancel, handle)
        }

        fn cache_path(&self) -> std::path::PathBuf {
            self.ctx.paths.desired_state()
        }
    }

    fn doc(version: u64, kiosk_enabled: bool) -> serde_json::Value {
        json!({
            "kioskEnabled": kiosk_enabled, "apps": [], "allowedSites": [], "fileHandlers": {},
            "storage": { "defaultQuotaGb": 0 }, "branding": { "name": "Rulebox" }, "version": version
        })
    }

    fn push_doc(fake: &FakeBackend, version: u64, doc: serde_json::Value) {
        fake.push(BackendEvent::Desired(DesiredFetch::Doc { version, doc, signature: None }));
    }

    /// Lets queued work run under paused time.
    async fn settle() {
        for _ in 0..20 {
            tokio::task::yield_now().await;
        }
    }

    async fn stop(cancel: CancellationToken, handle: JoinHandle<()>) {
        cancel.cancel();
        handle.await.unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn a_document_is_cached_raw_shown_and_announced() {
        let rig = Rig::new();
        let fake = FakeBackend::new();
        let (cancel, handle) = rig.start(&fake);
        let pin_hash = crate::kdf::hash_secret("2468").unwrap();
        let mut document = doc(3, true);
        document["adminExit"] = json!({ "pinHash": pin_hash, "hotkey": "ctrl+alt+k" });
        document["orgName"] = json!("Corner Shop");
        push_doc(&fake, 3, document.clone());
        settle().await;

        let snapshot = rig.snapshot();
        assert_eq!(snapshot.desired_state.as_ref().map(|d| d.version), Some(3));
        assert_eq!(snapshot.desired_state_version, 3);
        assert_eq!(snapshot.admin_exit.as_ref().map(|e| (e.enabled, e.hotkey.as_str())), Some((true, "Ctrl+Alt+K")));
        assert_eq!(snapshot.org_name.as_deref(), Some("Corner Shop"));
        // The serialized snapshot never contains the hash.
        assert!(!serde_json::to_string(&snapshot).unwrap().contains("argon2"));
        // The policy channel has it (that is where the exit task reads it).
        assert!(rig.policy_rx.borrow().admin_exit.enabled);
        // The cache file holds the RAW document, hash included, version and signature.
        let cached = load_cached_desired(&rig.ctx.paths).unwrap();
        assert_eq!(cached.version, 3);
        assert_eq!(cached.doc, document);
        assert_eq!(rig.control.changed.load(Ordering::SeqCst), 1);
        stop(cancel, handle).await;
    }

    #[tokio::test(start_paused = true)]
    async fn stale_and_unparseable_documents_keep_the_previous_state() {
        let rig = Rig::with_state(AgentState {
            last_applied_version: 5,
            enrollment: Some(Enrollment {
                convex_url: "https://test.convex.cloud".into(),
                device_id: "dev-1".into(),
                org_id: "o".into(),
                device_name: "Desk".into(),
                enrolled_at_ms: 1,
                revoked: false,
                allow_joined: false,
            }),
            ..AgentState::default()
        });
        let fake = FakeBackend::new();
        let (cancel, handle) = rig.start(&fake);

        // Lower than last_applied_version: ignored, nothing written.
        push_doc(&fake, 3, doc(3, true));
        settle().await;
        assert!(rig.snapshot().desired_state.is_none());
        assert!(!rig.cache_path().exists());
        assert_eq!(rig.control.changed.load(Ordering::SeqCst), 0);

        // A good newer document is applied.
        push_doc(&fake, 6, doc(6, true));
        settle().await;
        assert_eq!(rig.snapshot().desired_state_version, 6);
        let accepted_policy = rig.policy_rx.borrow().clone();

        // Unparseable (wrong type): the previous state, the previous policy and the
        // cache all stay.
        let mut broken = doc(7, true);
        broken["kioskEnabled"] = json!("yes");
        broken["adminExit"] = json!({ "pinHash": crate::kdf::hash_secret("1357").unwrap() });
        push_doc(&fake, 7, broken);
        settle().await;
        assert_eq!(rig.snapshot().desired_state_version, 6);
        assert_eq!(*rig.policy_rx.borrow(), accepted_policy);
        assert_eq!(load_cached_desired(&rig.ctx.paths).unwrap().version, 6);
        assert_eq!(rig.control.changed.load(Ordering::SeqCst), 1);

        // An older one after a newer one is stale too.
        push_doc(&fake, 5, doc(5, false));
        settle().await;
        assert_eq!(rig.snapshot().desired_state_version, 6);
        assert!(rig.snapshot().desired_state.unwrap().kiosk_enabled);
        stop(cancel, handle).await;
    }

    #[tokio::test(start_paused = true)]
    async fn an_identical_document_is_not_applied_or_written_again() {
        let rig = Rig::new();
        let fake = FakeBackend::new();
        let (cancel, handle) = rig.start(&fake);
        push_doc(&fake, 2, doc(2, true));
        settle().await;
        let first_write = std::fs::metadata(rig.cache_path()).unwrap().modified().unwrap();
        push_doc(&fake, 2, doc(2, true));
        settle().await;
        assert_eq!(rig.control.changed.load(Ordering::SeqCst), 1);
        assert_eq!(std::fs::metadata(rig.cache_path()).unwrap().modified().unwrap(), first_write);

        // The same version with different content is applied (and warned about).
        push_doc(&fake, 2, doc(2, false));
        settle().await;
        assert!(!rig.snapshot().desired_state.unwrap().kiosk_enabled);
        assert_eq!(rig.control.changed.load(Ordering::SeqCst), 2);
        stop(cancel, handle).await;
    }

    #[tokio::test(start_paused = true)]
    async fn revoked_marks_the_enrollment_stops_the_task_and_never_disables_the_kiosk() {
        let rig = Rig::new();
        let fake = FakeBackend::new();
        let (cancel, handle) = rig.start(&fake);
        fake.push(BackendEvent::Connection(ConnectionStatus::Online));
        push_doc(&fake, 1, doc(1, true));
        settle().await;
        assert_eq!(rig.snapshot().connection, ConnectionStatus::Online);

        fake.push(BackendEvent::Desired(DesiredFetch::Revoked));
        // The task ends by itself.
        tokio::time::timeout(Duration::from_secs(5), handle).await.unwrap().unwrap();
        let snapshot = rig.snapshot();
        assert_eq!(snapshot.enrollment, EnrollmentStatus::Revoked);
        assert_eq!(snapshot.connection, ConnectionStatus::Offline);
        assert!(rig.ctx.shared.get().enrollment.unwrap().revoked);
        // No kiosk-disable trigger of any kind; the cached document stays.
        assert_eq!(rig.control.disables.load(Ordering::SeqCst), 0);
        assert_eq!(rig.control.changed.load(Ordering::SeqCst), 1);
        assert!(rig.cache_path().exists());
        drop(cancel);
    }

    #[tokio::test(start_paused = true)]
    async fn an_unknown_device_is_handled_like_a_revoked_one() {
        let rig = Rig::new();
        let fake = FakeBackend::new();
        let (_cancel, handle) = rig.start(&fake);
        fake.push(BackendEvent::Desired(DesiredFetch::UnknownDevice));
        tokio::time::timeout(Duration::from_secs(5), handle).await.unwrap().unwrap();
        assert_eq!(rig.snapshot().enrollment, EnrollmentStatus::Revoked);
        assert!(rig.ctx.shared.get().enrollment.unwrap().revoked);
    }

    #[tokio::test(start_paused = true)]
    async fn the_cache_alone_fills_the_snapshot_while_the_backend_never_connects() {
        let rig = Rig::new();
        std::fs::create_dir_all(rig.ctx.paths.state_dir()).unwrap();
        let hash = crate::kdf::hash_secret("2468").unwrap();
        let mut document = doc(9, true);
        document["adminExit"] = json!({ "pinHash": hash });
        let cached = CachedDesired { version: 9, doc: document, signature: None };
        std::fs::write(rig.cache_path(), serde_json::to_vec(&cached).unwrap()).unwrap();

        let fake = FakeBackend::new();
        let (cancel, handle) = rig.start(&fake);
        settle().await;
        let snapshot = rig.snapshot();
        assert_eq!(snapshot.desired_state.as_ref().map(|d| d.version), Some(9));
        assert_eq!(snapshot.desired_state_version, 9);
        assert_eq!(snapshot.connection, ConnectionStatus::Offline);
        assert!(snapshot.admin_exit.as_ref().unwrap().enabled);
        assert!(rig.policy_rx.borrow().admin_exit.enabled);
        // Loading from the cache is not a new document: no reconcile trigger, no rewrite.
        assert_eq!(rig.control.changed.load(Ordering::SeqCst), 0);
        // A version below the cached one is stale even though last_applied_version is 0.
        push_doc(&fake, 4, doc(4, false));
        settle().await;
        assert_eq!(rig.snapshot().desired_state_version, 9);
        stop(cancel, handle).await;
    }

    #[tokio::test(start_paused = true)]
    async fn heartbeat_waits_for_jitter_sends_status_once_and_schedules_from_next_ping() {
        let rig = Rig::new();
        rig.jitter_ms.store(4_000, Ordering::SeqCst);
        let fake = FakeBackend::new();
        // Ask for 100 s; the client schedules the next one within +-10 %.
        for _ in 0..4 {
            fake.script_heartbeat(Ok(HeartbeatResponse { next_ping_in_ms: 100_000, server_time_ms: 1_760_000_000_500 }));
        }
        let (cancel, handle) = rig.start(&fake);
        let t0 = Instant::now();
        fake.push(BackendEvent::Connection(ConnectionStatus::Online));
        settle().await;
        // Nothing before the jitter has passed.
        tokio::time::sleep(Duration::from_millis(3_900)).await;
        settle().await;
        assert!(fake.heartbeat_calls().is_empty());
        tokio::time::sleep(Duration::from_millis(200)).await;
        fake.wait_for_heartbeats(1).await;
        let first = fake.heartbeat_calls()[0].clone();
        assert!(first.at - t0 >= Duration::from_millis(4_000) && first.at - t0 < Duration::from_millis(4_500));
        let status = first.status.expect("the first heartbeat carries the status");
        assert_eq!(status.os_edition.as_deref(), Some("Professional"));
        assert_eq!(status.ram_mb, Some(8192));
        assert_eq!(status.os.as_deref(), Some("Windows 11"));
        assert!(status.compat["blockers"].is_array());

        // The second one: not before 0.9 x 100 s, and without a status (unchanged).
        tokio::time::sleep(Duration::from_secs(89)).await;
        settle().await;
        assert_eq!(fake.heartbeat_calls().len(), 1, "too early");
        tokio::time::sleep(Duration::from_secs(22)).await;
        fake.wait_for_heartbeats(2).await;
        let second = fake.heartbeat_calls()[1].clone();
        let gap = second.at - first.at;
        assert!(gap >= Duration::from_secs(90) && gap <= Duration::from_secs(110), "{gap:?}");
        assert!(second.status.is_none(), "an unchanged status is not sent again");

        // The status changes (kiosk failed): the next heartbeat carries it again.
        rig.ctx.snapshot.update(|s| s.kiosk.error_code = Some("compat_blocked".into()));
        tokio::time::sleep(Duration::from_secs(111)).await;
        fake.wait_for_heartbeats(3).await;
        let third = fake.heartbeat_calls()[2].clone();
        assert_eq!(third.status.unwrap().kiosk_error.as_deref(), Some("compat_blocked"));
        // The server's clock is recorded as an offset.
        assert_eq!(rig.snapshot().server_time_offset_ms, Some(500));
        stop(cancel, handle).await;
    }

    #[tokio::test(start_paused = true)]
    async fn no_heartbeat_while_offline_and_a_failed_one_waits_for_the_next_slot() {
        let rig = Rig::new();
        let fake = FakeBackend::new();
        fake.script_heartbeat(Err(BackendError::Timeout));
        let (cancel, handle) = rig.start(&fake);
        settle().await;
        tokio::time::sleep(Duration::from_secs(600)).await;
        settle().await;
        assert!(fake.heartbeat_calls().is_empty(), "offline: nothing is sent");

        fake.push(BackendEvent::Connection(ConnectionStatus::Online));
        fake.wait_for_heartbeats(1).await;
        // The failed call is not retried in a tight loop: the next one comes about
        // 5 minutes (the default) later, and it carries the status again.
        tokio::time::sleep(Duration::from_secs(30)).await;
        settle().await;
        assert_eq!(fake.heartbeat_calls().len(), 1);
        tokio::time::sleep(Duration::from_secs(300)).await;
        fake.wait_for_heartbeats(2).await;
        assert!(fake.heartbeat_calls()[1].status.is_some());

        // Going offline cancels the schedule.
        fake.push(BackendEvent::Connection(ConnectionStatus::Offline));
        settle().await;
        tokio::time::sleep(Duration::from_secs(900)).await;
        settle().await;
        assert_eq!(fake.heartbeat_calls().len(), 2);
        stop(cancel, handle).await;
    }

    #[tokio::test(start_paused = true)]
    async fn clock_floor_follows_the_clock_and_suspect_needs_24_hours() {
        let rig = Rig::new();
        rig.ctx.shared.update(|s| s.last_wall_clock_ms = START_MS - 1000).unwrap();
        let fake = FakeBackend::new();
        let (cancel, handle) = rig.start(&fake);
        settle().await;
        // At start the floor moves up to the clock.
        assert_eq!(rig.ctx.shared.last_wall_clock_ms(), START_MS);
        assert!(!rig.snapshot().clock_suspect);

        // The clock goes back by 23 hours: not suspect yet. By 25 hours: suspect.
        rig.clock.store(START_MS - 23 * 3_600_000, Ordering::SeqCst);
        note_clock(&rig.ctx);
        assert!(!rig.snapshot().clock_suspect);
        rig.clock.store(START_MS - 25 * 3_600_000, Ordering::SeqCst);
        note_clock(&rig.ctx);
        assert!(rig.snapshot().clock_suspect);
        // The floor never moves down: setting the clock back cannot shorten anything.
        assert_eq!(rig.ctx.shared.last_wall_clock_ms(), START_MS);

        // Corrected: not suspect any more.
        rig.clock.store(START_MS + 5_000, Ordering::SeqCst);
        note_clock(&rig.ctx);
        assert!(!rig.snapshot().clock_suspect);
        assert_eq!(rig.ctx.shared.last_wall_clock_ms(), START_MS + 5_000);
        stop(cancel, handle).await;
    }

    #[tokio::test(start_paused = true)]
    async fn a_clock_the_server_calls_wrong_neither_raises_the_floor_nor_goes_unnoticed() {
        let rig = Rig::new();
        let fake = FakeBackend::new();
        // The server's time is 3 days behind this PC's clock.
        fake.script_heartbeat(Ok(HeartbeatResponse {
            next_ping_in_ms: 300_000,
            server_time_ms: (START_MS - 3 * 86_400_000) as i64,
        }));
        let (cancel, handle) = rig.start(&fake);
        fake.push(BackendEvent::Connection(ConnectionStatus::Online));
        fake.wait_for_heartbeats(1).await;
        settle().await;
        assert!(rig.snapshot().clock_suspect);
        stop(cancel, handle).await;
    }

    #[tokio::test(start_paused = true)]
    async fn the_task_subscribes_with_the_device_credentials() {
        let rig = Rig::new();
        let fake = FakeBackend::new();
        let (cancel, handle) = rig.start(&fake);
        fake.wait_for_subscription().await;
        let used = fake.subscriptions();
        assert_eq!(used.len(), 1);
        assert_eq!(used[0].device_id, "dev-1");
        // The hash enrolled earlier is the hash of this exact secret text.
        assert_eq!(sha256_hex(&used[0].device_secret).len(), 64);
        stop(cancel, handle).await;
    }

    #[tokio::test(start_paused = true)]
    async fn the_runner_starts_stops_and_notices_a_revocation() {
        let rig = Rig::new();
        let fake = FakeBackend::new();
        let runner = BackendRunner::new(Arc::clone(&rig.ctx), CancellationToken::new());
        assert!(!runner.is_running().await);
        runner
            .start(Arc::new(fake.clone()), DeviceAuth { device_id: "dev-1".into(), device_secret: "s".into() })
            .await;
        assert!(runner.is_running().await);
        fake.wait_for_subscription().await;
        runner.stop().await;
        assert!(!runner.is_running().await);
        // Stopping again is fine.
        runner.stop().await;

        // A revocation ends the task by itself.
        let fake = FakeBackend::new();
        runner
            .start(Arc::new(fake.clone()), DeviceAuth { device_id: "dev-1".into(), device_secret: "s".into() })
            .await;
        fake.push(BackendEvent::Desired(DesiredFetch::Revoked));
        for _ in 0..50 {
            if !runner.is_running().await {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(!runner.is_running().await);
    }

    #[test]
    fn ping_delay_stays_within_ten_percent_and_is_clamped() {
        let rig = Rig::new();
        for jitter in [0, 30_000, 60_000] {
            rig.jitter_ms.store(jitter, Ordering::SeqCst);
            let delay = ping_delay(&rig.ctx, 300_000);
            assert!(delay >= Duration::from_millis(270_000) && delay <= Duration::from_millis(330_000));
        }
        // A silly value is clamped before the jitter is applied.
        rig.jitter_ms.store(0, Ordering::SeqCst);
        assert_eq!(ping_delay(&rig.ctx, 1), Duration::from_millis(4_500));
        assert_eq!(ping_delay(&rig.ctx, u64::MAX), Duration::from_millis(3_240_000));
    }

    #[test]
    fn os_jitter_is_in_range() {
        for _ in 0..200 {
            assert!(os_jitter(10) <= 10);
        }
        assert_eq!(os_jitter(0), 0);
    }

}
