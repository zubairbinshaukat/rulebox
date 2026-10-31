//! The `backend` task of plan Section 5.2 (behaviour in Section 5.8, Phase 4
//! Step 9): the one subscription to the device's head, the signed documents and
//! roster it announces, the trust store, the heartbeat, the clock and the
//! `desired-state.json` cache.
//!
//! Data rules it follows (CLAUDE.md "Data access rules"):
//!
//! - **One subscription, no polling.** The head subscription pushes every new
//!   version; the agent fetches a body (`fetchDesired`) or roster delta
//!   (`fetchRoster`) only when the head says there is something new.
//! - **Write only on change.** A heartbeat carries the status object only when it
//!   differs from the last one the server accepted, and a document that is
//!   identical to the accepted one changes nothing and writes nothing.
//! - **Jitter.** After each transition to online the first heartbeat waits a random
//!   0 to 10 seconds (PRD 13.6 #5); every later one is scheduled from the server's
//!   `nextPingInMs` with +-10 %. A failed heartbeat waits for the next scheduled
//!   time; there is no retry loop.
//!
//! Signed documents (plan 4.5): nothing is applied from the (unsigned) head. The
//! body is verified first (`verify_for_head`: trusted key, strict Ed25519 over
//! the bytes as received, then org, device, versions and the head's key id) and
//! only then parsed and applied. Any failure fails closed: the previous state,
//! policy and cache stay, the status reports `desired_state_untrusted`, and the
//! same version is not fetched again. A version below the one applied is a
//! rollback and is never fetched.

use std::sync::Arc;
use std::time::Duration;

use futures_util::FutureExt;
use rulebox_ipc::types::{AgentSnapshot, ConnectionStatus, EnrollmentStatus};
use rulebox_policy::envelope::{verify_for_head, HeadRef, Payload, PublishedKey, SignedEnvelope, VerifyError};
use rulebox_policy::DesiredState;
use serde::Serialize;
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use super::{
    Backend, BackendError, BackendEvent, BackendFactory, DesiredFetch, DeviceAuth, Head, HeartbeatResponse,
    StatusReport, CODE_NOT_FOUND,
};
use crate::agent::{load_verified_cache, CachedDesired};
use crate::agent_policy::AgentPolicy;
use crate::compat;
use crate::kiosk_control::KioskControl;
use crate::paths::DataPaths;
use crate::platform::Platform;
use crate::roster::{self, RosterError, RosterState};
use crate::session::SessionManager;
use crate::state::{write_atomic, SharedState, SnapshotHandle};
use crate::trust;

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
/// A failed body or roster fetch is retried after this, doubling up to the max.
const FETCH_RETRY_BASE: Duration = Duration::from_secs(5);
const FETCH_RETRY_MAX: Duration = Duration::from_secs(300);
/// What the heartbeat reports when a document was received but did not parse.
pub const PROBLEM_DESIRED_STATE_INVALID: &str = "desired_state_invalid";
/// (Phase 4 Step 9) What the heartbeat reports when a document failed
/// verification (as `kioskError`): the dashboard shows "Re-enroll this PC" for a
/// device that trusts no key.
pub const PROBLEM_DESIRED_STATE_UNTRUSTED: &str = "desired_state_untrusted";

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

/// What `DesiredSync::accept` did with a verified document.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DocOutcome {
    /// New content: cached, shown in the snapshot, reconciler told.
    Applied,
    /// Identical to the accepted document: nothing changed.
    Unchanged,
    /// A lower version than one already applied: ignored.
    Stale,
    /// The same version as the accepted document with other content: a signed
    /// version never changes, so it is refused.
    Refused,
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

/// Decides what to do with each verified document (Section 5.6 and 5.8): stale
/// ones are ignored, unparseable ones keep the previous state, accepted ones are
/// cached (as the signed envelope).
pub struct DesiredSync {
    /// The highest version applied or cached: a lower one is stale.
    floor: u64,
    /// The last accepted version and its payload as received.
    accepted: Option<(u64, String)>,
    /// `doc.rosterGroupId` of the accepted document.
    roster_group: Option<String>,
    /// Set while the newest document did not verify or did not parse.
    pub problem: Option<&'static str>,
}

impl DesiredSync {
    pub fn new(last_applied_version: u64) -> Self {
        Self { floor: last_applied_version, accepted: None, roster_group: None, problem: None }
    }

    /// Reads `desired-state.json` once at start, verifies it again with the keys
    /// trusted now and applies it (without writing it back), so the snapshot and
    /// the policy show the cached state while offline. An unsigned (Phase 2) or
    /// failing cache is ignored (logged by `load_verified_cache`).
    pub fn load_cached(&mut self, ctx: &TaskContext) {
        let state = ctx.shared.get();
        let Some((envelope, payload)) = load_verified_cache(&ctx.paths, &state) else {
            return;
        };
        self.floor = self.floor.max(payload.version);
        self.apply(ctx, &envelope, payload, false);
    }

    pub fn accepted_version(&self) -> Option<u64> {
        self.accepted.as_ref().map(|(version, _)| *version)
    }

    /// Whether the head's `version` is worth a fetch: above everything applied, or
    /// the applied version itself while no document of it is held (the cache was
    /// lost or did not verify).
    pub fn wants(&self, version: u64) -> bool {
        version > self.floor || (version == self.floor && self.accepted_version() != Some(version))
    }

    pub fn roster_group(&self) -> Option<&str> {
        self.roster_group.as_deref()
    }

    /// A document that failed verification: nothing changes but the problem.
    pub fn reject(&mut self, version: u64, error: VerifyError) {
        tracing::error!(version, reason = error.reason(), "policy_rejected: the desired state was not applied");
        self.problem = Some(PROBLEM_DESIRED_STATE_UNTRUSTED);
    }

    /// Handles a VERIFIED document (`payload` is what `verify_for_head` returned
    /// for `envelope`).
    pub fn accept(&mut self, ctx: &TaskContext, envelope: &SignedEnvelope, payload: Payload) -> DocOutcome {
        let version = payload.version;
        if version < self.floor {
            tracing::info!(version, floor = self.floor, "ignoring a stale desired state");
            return DocOutcome::Stale;
        }
        if let Some((accepted_version, accepted_payload)) = &self.accepted {
            if *accepted_version == version {
                if *accepted_payload == envelope.payload {
                    return DocOutcome::Unchanged;
                }
                tracing::error!(version, "a different document arrived with the same version; refused");
                return DocOutcome::Refused;
            }
        }
        self.apply(ctx, envelope, payload, true)
    }

    fn apply(&mut self, ctx: &TaskContext, envelope: &SignedEnvelope, payload: Payload, write_cache: bool) -> DocOutcome {
        let version = payload.version;
        let doc = payload.doc;
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
            let cached = CachedDesired::from_envelope(envelope);
            let written = serde_json::to_vec_pretty(&cached)
                .map_err(std::io::Error::other)
                .and_then(|bytes| write_atomic(&ctx.paths.desired_state(), &bytes));
            if let Err(error) = written {
                tracing::error!("cannot save desired-state.json: {error}");
            }
        }
        if ctx.shared.read(|state| state.last_doc_key_id.as_deref() != Some(envelope.key_id.as_str())) {
            let key_id = envelope.key_id.clone();
            if let Err(error) = ctx.shared.update(|state| state.last_doc_key_id = Some(key_id)) {
                tracing::error!("cannot save the key id of the accepted document: {error}");
            }
        }
        // (A13) Reserved: parsed and ignored until tenant moves exist.
        if doc.get("relocate").is_some_and(|relocate| !relocate.is_null()) {
            tracing::warn!(version, "the document asks for a relocation; relocation not supported yet");
        }
        self.roster_group = doc.get("rosterGroupId").and_then(serde_json::Value::as_str).map(str::to_string);

        let policy = AgentPolicy::from_doc(Some(&doc));
        ctx.snapshot.update(|snapshot| apply_to_snapshot(snapshot, &desired, version, &policy));
        publish_policy(&ctx.policy_tx, policy);
        self.accepted = Some((version, envelope.payload.clone()));
        tracing::info!(version, kiosk_enabled = desired.kiosk_enabled, key_id = %envelope.key_id, "desired state accepted");
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
        trusted_key_ids: Some(trust::trusted_key_ids(&state.trusted_keys)),
        restart_pending: None,
    })
}

// -- the task ---------------------------------------------------------------------

/// What a spawned heartbeat call reports back.
struct HeartbeatDone {
    result: Result<HeartbeatResponse, BackendError>,
    /// The serialized status that was sent, when one was.
    sent_status: Option<String>,
}

/// What a spawned fetch reports back.
enum FetchDone {
    Desired { head: Head, result: Result<SignedEnvelope, BackendError> },
    Roster { group_id: String, target: u64, result: Result<RosterState, RosterError> },
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

/// The signed side of the task: the latest head, the fetch in flight and what
/// must not be fetched again.
struct Fetcher {
    head: Option<Head>,
    keys: Vec<PublishedKey>,
    retired: Vec<String>,
    task: Option<JoinHandle<()>>,
    retry_at: Option<Instant>,
    backoff: Duration,
    /// A version whose body failed verification: not fetched again until the
    /// head names another version.
    failed_version: Option<u64>,
    /// The body was pruned (`not_found`): wait for the next head.
    wait_for_head: bool,
    roster: RosterState,
    /// `(group, epoch)` a roster sync could not reach: not tried again until the
    /// head's epoch (or the group) changes.
    roster_failed: Option<(String, u64)>,
}

impl Fetcher {
    fn new(roster: RosterState) -> Self {
        Self {
            head: None,
            keys: Vec::new(),
            retired: Vec::new(),
            task: None,
            retry_at: None,
            backoff: FETCH_RETRY_BASE,
            failed_version: None,
            wait_for_head: false,
            roster,
            roster_failed: None,
        }
    }

    fn busy(&self) -> bool {
        self.task.as_ref().is_some_and(|task| !task.is_finished()) || self.retry_at.is_some()
    }

    fn retry_later(&mut self, what: &str, error: &dyn std::fmt::Display) {
        tracing::warn!("cannot fetch the {what} ({error}); retrying in {} s", self.backoff.as_secs());
        self.retry_at = Some(Instant::now() + self.backoff);
        self.backoff = (self.backoff * 2).min(FETCH_RETRY_MAX);
    }

    /// A new head-state result: trust first (a new key may sign the new body).
    fn on_head(&mut self, ctx: &TaskContext, head: Option<Head>, keys: Vec<PublishedKey>, retired: Vec<String>, sync: &DesiredSync) {
        trust::update(&ctx.shared, &keys, &retired);
        self.keys = keys;
        self.retired = retired;
        self.wait_for_head = false;
        match &head {
            None => tracing::debug!("the backend has no desired state for this device yet"),
            Some(head) => {
                if self.failed_version.is_some_and(|failed| failed != head.version) {
                    self.failed_version = None;
                }
                if head.version < sync.accepted_version().unwrap_or(0) {
                    tracing::warn!(version = head.version, "the head names an older version than the one applied; ignored");
                }
            }
        }
        self.head = head;
    }

    /// Starts the next fetch when nothing is in flight or waiting to be retried.
    fn kick(
        &mut self,
        ctx: &TaskContext,
        backend: &Arc<dyn Backend>,
        auth: &DeviceAuth,
        sync: &DesiredSync,
        done_tx: &mpsc::Sender<FetchDone>,
    ) {
        if self.busy() {
            return;
        }
        let Some(head) = self.head.clone() else {
            return;
        };
        if sync.wants(head.version) && self.failed_version != Some(head.version) && !self.wait_for_head {
            let (backend, auth, done_tx) = (Arc::clone(backend), auth.clone(), done_tx.clone());
            self.task = Some(tokio::spawn(async move {
                let result = backend.fetch_desired(&auth, head.version).await;
                let _ = done_tx.send(FetchDone::Desired { head, result }).await;
            }));
            return;
        }
        // The roster of the accepted document's group.
        if sync.accepted_version().is_none() {
            return;
        }
        let Some(group_id) = sync.roster_group().map(str::to_string) else {
            if self.roster.group_id.is_some() {
                self.save_roster(ctx, RosterState::for_group(None));
            }
            return;
        };
        let target = head.roster_epoch;
        let current = self.roster.group_id.as_deref() == Some(group_id.as_str()) && self.roster.epoch == target;
        if current || self.roster_failed.as_ref() == Some(&(group_id.clone(), target)) {
            return;
        }
        let (backend, auth, done_tx) = (Arc::clone(backend), auth.clone(), done_tx.clone());
        let roster = self.roster.clone();
        let (trusted, org_id) = ctx.shared.read(|state| {
            (state.trusted_keys.clone(), state.enrollment.as_ref().map(|e| e.org_id.clone()).unwrap_or_default())
        });
        self.task = Some(tokio::spawn(async move {
            let result = roster::sync(backend.as_ref(), &auth, roster, target, &trusted, &org_id, &group_id).await;
            let _ = done_tx.send(FetchDone::Roster { group_id, target, result }).await;
        }));
    }

    fn save_roster(&mut self, ctx: &TaskContext, roster: RosterState) {
        if roster == self.roster {
            return;
        }
        if let Err(error) = roster.save(&ctx.paths.roster()) {
            tracing::error!("cannot save roster.json: {error}");
        }
        tracing::info!(epoch = roster.epoch, members = roster.members.len(), "roster updated");
        self.roster = roster;
    }

    /// A fetch finished. Returns whether a document was applied.
    fn on_done(&mut self, ctx: &TaskContext, auth: &DeviceAuth, sync: &mut DesiredSync, done: FetchDone) -> bool {
        match done {
            FetchDone::Desired { head, result: Ok(envelope) } => {
                self.backoff = FETCH_RETRY_BASE;
                let (trusted, org_id) = ctx.shared.read(|state| {
                    (state.trusted_keys.clone(), state.enrollment.as_ref().map(|e| e.org_id.clone()).unwrap_or_default())
                });
                let head_ref = HeadRef { version: head.version, key_id: &head.key_id };
                match verify_for_head(&envelope, &trusted, &org_id, &auth.device_id, &head_ref) {
                    Ok(payload) => {
                        let outcome = sync.accept(ctx, &envelope, payload);
                        if outcome == DocOutcome::Applied {
                            // A document of the new key may let a retired key go.
                            trust::update(&ctx.shared, &self.keys, &self.retired);
                            return true;
                        }
                        if outcome != DocOutcome::Unchanged {
                            self.failed_version = Some(head.version);
                        }
                    }
                    Err(error) => {
                        sync.reject(head.version, error);
                        self.failed_version = Some(head.version);
                    }
                }
            }
            FetchDone::Desired { head, result: Err(BackendError::Rejected { code }) } if code == CODE_NOT_FOUND => {
                tracing::info!(version = head.version, "that version is gone; waiting for the next head");
                self.wait_for_head = true;
            }
            FetchDone::Desired { result: Err(error), .. } => self.retry_later("desired state", &error),
            FetchDone::Roster { group_id, target, result } => match result {
                Ok(roster) => {
                    self.backoff = FETCH_RETRY_BASE;
                    if roster.epoch != target {
                        tracing::warn!(epoch = roster.epoch, target, "the roster did not reach the head's epoch");
                        self.roster_failed = Some((group_id, target));
                    }
                    self.save_roster(ctx, roster);
                }
                Err(RosterError::Backend(error)) => self.retry_later("roster", &error),
                Err(error) => {
                    tracing::error!("roster_rejected: {error}; the stored roster stays");
                    self.roster_failed = Some((group_id, target));
                }
            },
        }
        false
    }

    fn stop(&mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
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
    let mut sync = DesiredSync::new(ctx.shared.read(|state| state.last_applied_version));
    sync.load_cached(&ctx);
    if ctx.shared.read(|state| state.trusted_keys.is_empty()) {
        tracing::error!("this PC trusts no policy key (enrolled before Phase 4?): no document can be applied; re-enroll it");
    }
    note_clock(&ctx);

    let (event_tx, mut events) = mpsc::channel::<BackendEvent>(EVENT_QUEUE);
    let mut subscription = backend.subscribe(auth.clone(), event_tx, shutdown.clone()).fuse();
    let (done_tx, mut done_rx) = mpsc::channel::<HeartbeatDone>(1);
    let (fetch_tx, mut fetch_rx) = mpsc::channel::<FetchDone>(1);
    let mut fetcher = Fetcher::new(RosterState::load(&ctx.paths.roster()));
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
        let retry = async {
            match fetcher.retry_at {
                Some(at) => tokio::time::sleep_until(at).await,
                None => std::future::pending::<()>().await,
            }
        };
        tokio::select! {
            () = shutdown.cancelled() => break,
            () = &mut subscription => {
                // The subscription future only ends by itself when its channel is
                // gone; the fuse keeps this branch quiet afterwards.
                tracing::warn!("the head subscription ended");
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
                BackendEvent::Desired(DesiredFetch::Ok { head, keys, retired_key_ids }) => {
                    fetcher.on_head(&ctx, head, keys, retired_key_ids, &sync);
                    fetcher.kick(&ctx, &backend, &auth, &sync, &fetch_tx);
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
            Some(done) = fetch_rx.recv() => {
                // The fetch has sent its result: it is over even if its task has
                // not quite returned yet.
                fetcher.task = None;
                if fetcher.on_done(&ctx, &auth, &mut sync, done) {
                    ctx.control.desired_changed();
                }
                fetcher.kick(&ctx, &backend, &auth, &sync, &fetch_tx);
            }
            () = retry => {
                fetcher.retry_at = None;
                fetcher.kick(&ctx, &backend, &auth, &sync, &fetch_tx);
            }
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
    fetcher.stop();
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

    use rulebox_policy::roster::RosterEntry;
    use serde_json::json;

    use crate::agent::load_cached_desired;
    use crate::backend::fake::FakeBackend;
    use crate::backend::{sha256_hex, RosterFetch};
    use crate::kiosk_control::FakeKioskControl;
    use crate::platform::sim::SimPlatform;
    use crate::state::{AgentState, Enrollment, StateStore};
    use crate::testutil::signing::{endorse, envelope, roster_entry, test_key, test_key_2, trusted_of};
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

    fn enrollment() -> Enrollment {
        Enrollment {
            convex_url: "https://test.convex.cloud".into(),
            device_id: "dev-1".into(),
            org_id: "org-1".into(),
            device_name: "Desk".into(),
            enrolled_at_ms: 1,
            revoked: false,
            allow_joined: false,
        }
    }

    impl Rig {
        /// Enrolled as `dev-1` of `org-1`, trusting the test-1 key.
        fn new() -> Self {
            Self::with_state(AgentState {
                enrollment: Some(enrollment()),
                trusted_keys: vec![trusted_of(&test_key())],
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

        fn changed(&self) -> usize {
            self.control.changed.load(Ordering::SeqCst)
        }

        fn trusted_ids(&self) -> Vec<String> {
            trust::trusted_key_ids(&self.ctx.shared.get().trusted_keys)
        }

        fn status(&self) -> StatusReport {
            build_status(&self.ctx, None).unwrap()
        }
    }

    fn doc(version: u64, kiosk_enabled: bool) -> serde_json::Value {
        json!({
            "kioskEnabled": kiosk_enabled, "apps": [], "allowedSites": [], "fileHandlers": {},
            "storage": { "defaultQuotaGb": 0 }, "branding": { "name": "Rulebox", "logo": null }, "version": version
        })
    }

    fn push_doc(fake: &FakeBackend, version: u64, doc: serde_json::Value) {
        fake.publish_doc(version, doc);
    }

    /// Lets queued work (and the spawned fetches) run under paused time.
    async fn settle() {
        for _ in 0..60 {
            tokio::task::yield_now().await;
        }
    }

    async fn stop(cancel: CancellationToken, handle: JoinHandle<()>) {
        cancel.cancel();
        handle.await.unwrap();
    }

    fn published(key: &ed25519_dalek::SigningKey, by: Option<&ed25519_dalek::SigningKey>) -> PublishedKey {
        let t = trusted_of(key);
        PublishedKey { key_id: t.key_id, public_key: t.public_key, endorsement: by.map(|by| endorse(by, "org-1", key)) }
    }

    fn head_state(env: &SignedEnvelope, keys: Vec<PublishedKey>, retired: Vec<String>) -> BackendEvent {
        let BackendEvent::Desired(DesiredFetch::Ok { head, .. }) = FakeBackend::head_event(env, 0, Vec::new()) else {
            unreachable!()
        };
        BackendEvent::Desired(DesiredFetch::Ok { head, keys, retired_key_ids: retired })
    }

    #[tokio::test(start_paused = true)]
    async fn signed_doc_is_applied() {
        let rig = Rig::new();
        let fake = FakeBackend::new();
        let (cancel, handle) = rig.start(&fake);
        let pin_hash = crate::kdf::hash_secret("2468").unwrap();
        let mut document = doc(3, true);
        document["adminExit"] = json!({ "pinHash": pin_hash, "hotkey": "ctrl+alt+k" });
        document["orgName"] = json!("Corner Shop");
        push_doc(&fake, 3, document.clone());
        settle().await;

        // The head announced version 3; the body was fetched once.
        assert_eq!(fake.desired_calls(), [3]);
        let snapshot = rig.snapshot();
        assert_eq!(snapshot.desired_state.as_ref().map(|d| d.version), Some(3));
        assert_eq!(snapshot.desired_state_version, 3);
        assert_eq!(snapshot.admin_exit.as_ref().map(|e| (e.enabled, e.hotkey.as_str())), Some((true, "Ctrl+Alt+K")));
        assert_eq!(snapshot.org_name.as_deref(), Some("Corner Shop"));
        // The serialized snapshot never contains the hash.
        assert!(!serde_json::to_string(&snapshot).unwrap().contains("argon2"));
        // The policy channel has it (that is where the exit task reads it).
        assert!(rig.policy_rx.borrow().admin_exit.enabled);
        // The cache holds the signed envelope exactly as received, hash included.
        let cached = load_cached_desired(&rig.ctx.paths).unwrap();
        let expected = envelope(&test_key(), "org-1", "dev-1", 3, &document);
        assert_eq!(cached.envelope(), Some(expected.clone()));
        assert!(cached.payload.unwrap().contains("argon2"));
        assert_eq!(rig.changed(), 1);
        assert_eq!(rig.ctx.shared.get().last_doc_key_id, Some(expected.key_id));

        // The same head again (a ping-interval change, say): no fetch, no change.
        push_doc(&fake, 3, document);
        settle().await;
        assert_eq!(fake.desired_calls(), [3]);
        assert_eq!(rig.changed(), 1);
        stop(cancel, handle).await;
    }

    #[tokio::test(start_paused = true)]
    async fn forged_doc_keeps_previous_state_and_reports_untrusted() {
        let rig = Rig::new();
        let fake = FakeBackend::new();
        let (cancel, handle) = rig.start(&fake);
        push_doc(&fake, 2, doc(2, true));
        settle().await;
        assert_eq!(rig.snapshot().desired_state_version, 2);
        let policy = rig.policy_rx.borrow().clone();

        // Version 3, kiosk off, with one byte changed after signing.
        let mut forged = envelope(&test_key(), "org-1", "dev-1", 3, &doc(3, true));
        forged.payload = forged.payload.replacen("\"kioskEnabled\":true", "\"kioskEnabled\":fals", 1);
        fake.publish(forged.clone());
        settle().await;
        assert_eq!(rig.snapshot().desired_state_version, 2);
        assert!(rig.snapshot().desired_state.unwrap().kiosk_enabled);
        assert_eq!(*rig.policy_rx.borrow(), policy);
        assert_eq!(load_cached_desired(&rig.ctx.paths).unwrap().version, 2);
        assert_eq!(rig.changed(), 1);
        // The status says so (as `kioskError`).
        let task_problem = build_status(&rig.ctx, Some(PROBLEM_DESIRED_STATE_UNTRUSTED)).unwrap();
        assert_eq!(task_problem.kiosk_error.as_deref(), Some("desired_state_untrusted"));
        // The same head again: the forged body is not fetched a second time.
        fake.publish(forged);
        settle().await;
        assert_eq!(fake.desired_calls(), [2, 3]);

        // A good version 4 clears it.
        push_doc(&fake, 4, doc(4, false));
        settle().await;
        assert_eq!(rig.snapshot().desired_state_version, 4);
        stop(cancel, handle).await;
    }

    #[tokio::test(start_paused = true)]
    async fn the_untrusted_problem_reaches_the_heartbeat() {
        let rig = Rig::new();
        let fake = FakeBackend::new();
        let mut forged = envelope(&test_key(), "org-1", "dev-1", 3, &doc(3, true));
        forged.signature = envelope(&test_key(), "org-1", "dev-1", 4, &doc(4, true)).signature;
        let (cancel, handle) = rig.start(&fake);
        fake.publish(forged);
        settle().await;
        fake.push(BackendEvent::Connection(ConnectionStatus::Online));
        fake.wait_for_heartbeats(1).await;
        let status = fake.heartbeat_calls()[0].status.clone().unwrap();
        assert_eq!(status.kiosk_error.as_deref(), Some("desired_state_untrusted"));
        assert_eq!(status.trusted_key_ids, Some(vec!["21fe31dfa154a261".to_string()]));
        stop(cancel, handle).await;
    }

    #[tokio::test(start_paused = true)]
    async fn replayed_doc_of_other_device_is_refused() {
        let rig = Rig::new();
        let fake = FakeBackend::new();
        let (cancel, handle) = rig.start(&fake);
        // Validly signed, for another device (and, below, another organization).
        fake.publish(envelope(&test_key(), "org-1", "dev-2", 3, &doc(3, false)));
        settle().await;
        assert!(rig.snapshot().desired_state.is_none());
        fake.publish(envelope(&test_key(), "org-2", "dev-1", 4, &doc(4, false)));
        settle().await;
        assert!(rig.snapshot().desired_state.is_none());
        assert!(!rig.cache_path().exists());
        assert_eq!(rig.changed(), 0);
        stop(cancel, handle).await;
    }

    #[tokio::test(start_paused = true)]
    async fn rolled_back_version_is_ignored() {
        let rig = Rig::with_state(AgentState {
            last_applied_version: 5,
            enrollment: Some(enrollment()),
            trusted_keys: vec![trusted_of(&test_key())],
            ..AgentState::default()
        });
        let fake = FakeBackend::new();
        let (cancel, handle) = rig.start(&fake);

        // Lower than last_applied_version, validly signed: never even fetched.
        push_doc(&fake, 3, doc(3, true));
        settle().await;
        assert!(fake.desired_calls().is_empty());
        assert!(rig.snapshot().desired_state.is_none());
        assert!(!rig.cache_path().exists());

        // A newer one is applied.
        push_doc(&fake, 6, doc(6, true));
        settle().await;
        assert_eq!(rig.snapshot().desired_state_version, 6);

        // A head for 7 answered with the (valid) body of 5: refused as a replay.
        let old = envelope(&test_key(), "org-1", "dev-1", 5, &doc(5, false));
        fake.store_body(7, Ok(old.clone()));
        fake.push(FakeBackend::head_event(
            &SignedEnvelope { version: 7, ..old },
            0,
            FakeBackend::test_keys(),
        ));
        settle().await;
        assert_eq!(rig.snapshot().desired_state_version, 6);
        assert!(rig.snapshot().desired_state.unwrap().kiosk_enabled);

        // An older head after a newer one is not fetched either.
        push_doc(&fake, 5, doc(5, false));
        settle().await;
        assert_eq!(fake.desired_calls(), [6, 7]);
        assert_eq!(rig.snapshot().desired_state_version, 6);
        stop(cancel, handle).await;
    }

    #[tokio::test(start_paused = true)]
    async fn an_unparseable_signed_document_keeps_the_previous_state() {
        let rig = Rig::new();
        let fake = FakeBackend::new();
        let (cancel, handle) = rig.start(&fake);
        push_doc(&fake, 6, doc(6, true));
        settle().await;
        let accepted_policy = rig.policy_rx.borrow().clone();
        let mut broken = doc(7, true);
        broken["kioskEnabled"] = json!("yes");
        broken["adminExit"] = json!({ "pinHash": crate::kdf::hash_secret("1357").unwrap() });
        push_doc(&fake, 7, broken);
        settle().await;
        assert_eq!(rig.snapshot().desired_state_version, 6);
        assert_eq!(*rig.policy_rx.borrow(), accepted_policy);
        assert_eq!(load_cached_desired(&rig.ctx.paths).unwrap().version, 6);
        assert_eq!(rig.changed(), 1);
        stop(cancel, handle).await;
    }

    #[tokio::test(start_paused = true)]
    async fn same_version_different_content_is_refused() {
        let rig = Rig::new();
        let fake = FakeBackend::new();
        let (cancel, handle) = rig.start(&fake);
        push_doc(&fake, 2, doc(2, true));
        settle().await;
        let first_write = std::fs::metadata(rig.cache_path()).unwrap().modified().unwrap();
        // The server now has another (validly signed) body under version 2.
        push_doc(&fake, 2, doc(2, false));
        settle().await;
        assert!(rig.snapshot().desired_state.unwrap().kiosk_enabled);
        assert_eq!(rig.changed(), 1);
        assert_eq!(std::fs::metadata(rig.cache_path()).unwrap().modified().unwrap(), first_write);

        // And straight into the sync: identical is Unchanged, different is Refused.
        let mut sync = DesiredSync::new(0);
        let a = envelope(&test_key(), "org-1", "dev-1", 2, &doc(2, true));
        let b = envelope(&test_key(), "org-1", "dev-1", 2, &doc(2, false));
        let trusted = [trusted_of(&test_key())];
        let verify = |e: &SignedEnvelope| rulebox_policy::envelope::verify_envelope(e, &trusted, "org-1", "dev-1").unwrap();
        assert_eq!(sync.accept(&rig.ctx, &a, verify(&a)), DocOutcome::Applied);
        assert_eq!(sync.accept(&rig.ctx, &a, verify(&a)), DocOutcome::Unchanged);
        assert_eq!(sync.accept(&rig.ctx, &b, verify(&b)), DocOutcome::Refused);
        stop(cancel, handle).await;
    }

    #[tokio::test(start_paused = true)]
    async fn no_trusted_key_accepts_nothing_and_says_untrusted() {
        // A device enrolled before Phase 4: no trust store, no trust on first use.
        let rig = Rig::with_state(AgentState { enrollment: Some(enrollment()), ..AgentState::default() });
        let fake = FakeBackend::new();
        let (cancel, handle) = rig.start(&fake);
        push_doc(&fake, 1, doc(1, false));
        settle().await;
        assert!(rig.snapshot().desired_state.is_none());
        assert!(rig.trusted_ids().is_empty(), "a listed key is never trusted without an endorsement");
        assert_eq!(rig.status().trusted_key_ids, Some(Vec::new()));
        stop(cancel, handle).await;
    }

    #[tokio::test(start_paused = true)]
    async fn endorsed_next_key_becomes_trusted_and_is_reported() {
        let rig = Rig::new();
        let fake = FakeBackend::new();
        let (cancel, handle) = rig.start(&fake);
        assert_eq!(rig.status().trusted_key_ids, Some(vec!["21fe31dfa154a261".to_string()]));
        let (k1, k2) = (test_key(), test_key_2());
        // Rotation prepared: the next key is listed with k1's endorsement; the body is
        // still signed by k1.
        let env = envelope(&k1, "org-1", "dev-1", 1, &doc(1, true));
        fake.store_body(1, Ok(env.clone()));
        fake.push(head_state(&env, vec![published(&k1, None), published(&k2, Some(&k1))], vec![]));
        settle().await;
        assert_eq!(rig.trusted_ids(), ["21fe31dfa154a261", "39f713d0a644253f"]);
        assert_eq!(
            rig.status().trusted_key_ids,
            Some(vec!["21fe31dfa154a261".to_string(), "39f713d0a644253f".to_string()])
        );
        // Persisted.
        let saved = std::fs::read_to_string(rig.ctx.paths.agent_state()).unwrap();
        assert!(saved.contains("39f713d0a644253f"), "{saved}");
        // Rotation finished: a body signed by k2 is accepted.
        let env = envelope(&k2, "org-1", "dev-1", 2, &doc(2, false));
        fake.store_body(2, Ok(env.clone()));
        fake.push(head_state(&env, vec![published(&k1, None), published(&k2, Some(&k1))], vec![]));
        settle().await;
        assert_eq!(rig.snapshot().desired_state_version, 2);
        stop(cancel, handle).await;
    }

    #[tokio::test(start_paused = true)]
    async fn retired_key_is_dropped_only_after_a_newer_signed_doc() {
        let (k1, k2) = (test_key(), test_key_2());
        let rig = Rig::with_state(AgentState {
            enrollment: Some(enrollment()),
            trusted_keys: vec![trusted_of(&k1), trusted_of(&k2)],
            last_doc_key_id: Some(trusted_of(&k1).key_id),
            ..AgentState::default()
        });
        let fake = FakeBackend::new();
        let (cancel, handle) = rig.start(&fake);
        let keys = vec![published(&k1, None), published(&k2, Some(&k1))];
        let retired = vec![trusted_of(&k1).key_id];
        // k1 retired, but the last document was signed by k1 and the new body is not
        // fetched yet (pruned): k1 stays.
        let env = envelope(&k2, "org-1", "dev-1", 3, &doc(3, true));
        fake.push(head_state(&env, keys.clone(), retired.clone()));
        settle().await;
        assert_eq!(rig.trusted_ids().len(), 2);
        // The k2 document arrives: k1 goes, right after it is applied.
        fake.store_body(3, Ok(env.clone()));
        fake.push(head_state(&env, keys, retired));
        settle().await;
        assert_eq!(rig.snapshot().desired_state_version, 3);
        assert_eq!(rig.trusted_ids(), [trusted_of(&k2).key_id]);
        // A document of the retired key is now refused.
        fake.publish(envelope(&k1, "org-1", "dev-1", 4, &doc(4, false)));
        settle().await;
        assert_eq!(rig.snapshot().desired_state_version, 3);
        stop(cancel, handle).await;
    }

    #[tokio::test(start_paused = true)]
    async fn last_key_is_never_dropped() {
        let rig = Rig::new();
        let fake = FakeBackend::new();
        let (cancel, handle) = rig.start(&fake);
        push_doc(&fake, 1, doc(1, true));
        settle().await;
        // The only trusted key is listed as retired, and a document of it was accepted
        // earlier with another key id recorded: it still stays.
        rig.ctx.shared.update(|s| s.last_doc_key_id = Some("ffffffffffffffff".into())).unwrap();
        let env = envelope(&test_key(), "org-1", "dev-1", 1, &doc(1, true));
        fake.push(head_state(&env, FakeBackend::test_keys(), vec![trusted_of(&test_key()).key_id]));
        settle().await;
        assert_eq!(rig.trusted_ids(), ["21fe31dfa154a261"]);
        stop(cancel, handle).await;
    }

    #[tokio::test(start_paused = true)]
    async fn cache_is_reverified_at_start() {
        let rig = Rig::new();
        std::fs::create_dir_all(rig.ctx.paths.state_dir()).unwrap();
        let hash = crate::kdf::hash_secret("2468").unwrap();
        let mut document = doc(9, true);
        document["adminExit"] = json!({ "pinHash": hash });
        let good = envelope(&test_key(), "org-1", "dev-1", 9, &document);
        std::fs::write(rig.cache_path(), serde_json::to_vec(&CachedDesired::from_envelope(&good)).unwrap()).unwrap();

        let fake = FakeBackend::new();
        let (cancel, handle) = rig.start(&fake);
        settle().await;
        let snapshot = rig.snapshot();
        assert_eq!(snapshot.desired_state_version, 9);
        assert_eq!(snapshot.connection, ConnectionStatus::Offline);
        assert!(snapshot.admin_exit.as_ref().unwrap().enabled);
        assert!(rig.policy_rx.borrow().admin_exit.enabled);
        // Loading from the cache is not a new document: no reconcile trigger, no rewrite.
        assert_eq!(rig.changed(), 0);
        // A version below the cached one is stale even though last_applied_version is 0.
        push_doc(&fake, 4, doc(4, false));
        settle().await;
        assert_eq!(rig.snapshot().desired_state_version, 9);
        assert!(fake.desired_calls().is_empty());
        stop(cancel, handle).await;

        // The same cache with the kiosk switched off in the file: ignored at start.
        let rig = Rig::new();
        std::fs::create_dir_all(rig.ctx.paths.state_dir()).unwrap();
        let mut tampered = good.clone();
        tampered.payload = tampered.payload.replace("\"kioskEnabled\":true", "\"kioskEnabled\":false");
        std::fs::write(rig.cache_path(), serde_json::to_vec(&CachedDesired::from_envelope(&tampered)).unwrap())
            .unwrap();
        let fake = FakeBackend::new();
        let (cancel, handle) = rig.start(&fake);
        settle().await;
        assert!(rig.snapshot().desired_state.is_none());
        assert!(!rig.policy_rx.borrow().admin_exit.enabled);
        stop(cancel, handle).await;
    }

    #[tokio::test(start_paused = true)]
    async fn phase2_cache_is_ignored() {
        let rig = Rig::new();
        std::fs::create_dir_all(rig.ctx.paths.state_dir()).unwrap();
        let phase2 = json!({ "version": 9, "doc": doc(9, false), "signature": null });
        std::fs::write(rig.cache_path(), serde_json::to_vec(&phase2).unwrap()).unwrap();
        let fake = FakeBackend::new();
        let (cancel, handle) = rig.start(&fake);
        settle().await;
        assert!(rig.snapshot().desired_state.is_none());
        // The server's version 9 (the floor is 0) is fetched and applied.
        push_doc(&fake, 9, doc(9, true));
        settle().await;
        assert_eq!(rig.snapshot().desired_state_version, 9);
        stop(cancel, handle).await;
    }

    #[tokio::test(start_paused = true)]
    async fn no_head_yet_then_a_pruned_body_then_the_next_head() {
        let rig = Rig::new();
        let fake = FakeBackend::new();
        let (cancel, handle) = rig.start(&fake);
        // Just enrolled: the publisher has not reached the device yet.
        fake.push(BackendEvent::Desired(DesiredFetch::Ok {
            head: None,
            keys: FakeBackend::test_keys(),
            retired_key_ids: vec![],
        }));
        settle().await;
        assert!(fake.desired_calls().is_empty());
        // A head whose body is already gone: one call, then wait.
        let env = envelope(&test_key(), "org-1", "dev-1", 2, &doc(2, true));
        fake.push(FakeBackend::head_event(&env, 0, FakeBackend::test_keys()));
        settle().await;
        tokio::time::sleep(Duration::from_secs(600)).await;
        settle().await;
        assert_eq!(fake.desired_calls(), [2]);
        // The next head: fetched again.
        fake.publish(envelope(&test_key(), "org-1", "dev-1", 3, &doc(3, true)));
        settle().await;
        assert_eq!(fake.desired_calls(), [2, 3]);
        assert_eq!(rig.snapshot().desired_state_version, 3);
        stop(cancel, handle).await;
    }

    #[tokio::test(start_paused = true)]
    async fn a_failed_fetch_is_retried_with_backoff() {
        let rig = Rig::new();
        let fake = FakeBackend::new();
        let (cancel, handle) = rig.start(&fake);
        let env = envelope(&test_key(), "org-1", "dev-1", 2, &doc(2, true));
        fake.store_body(2, Err(BackendError::Timeout));
        fake.push(FakeBackend::head_event(&env, 0, FakeBackend::test_keys()));
        settle().await;
        assert_eq!(fake.desired_calls(), [2]);
        tokio::time::sleep(Duration::from_secs(4)).await;
        settle().await;
        assert_eq!(fake.desired_calls().len(), 1, "not before 5 s");
        tokio::time::sleep(Duration::from_secs(2)).await;
        settle().await;
        assert_eq!(fake.desired_calls().len(), 2);
        // Then 10 s; it answers this time.
        fake.store_body(2, Ok(env));
        tokio::time::sleep(Duration::from_secs(11)).await;
        settle().await;
        assert_eq!(fake.desired_calls().len(), 3);
        assert_eq!(rig.snapshot().desired_state_version, 2);
        stop(cancel, handle).await;
    }

    fn grouped_doc(version: u64, group: &str) -> serde_json::Value {
        let mut d = doc(version, true);
        d["rosterGroupId"] = json!(group);
        d
    }

    #[tokio::test(start_paused = true)]
    async fn the_roster_follows_the_heads_epoch_and_is_saved() {
        let rig = Rig::new();
        let fake = FakeBackend::new();
        let key = test_key();
        let entries: Vec<RosterEntry> = vec![
            roster_entry(&key, "org-1", "grp-1", 1, "emp-1", Some(2)),
            roster_entry(&key, "org-1", "grp-1", 2, "emp-2", Some(1)),
        ];
        fake.script_roster(Ok(RosterFetch::Entries { epoch: 2, entries }));
        let (cancel, handle) = rig.start(&fake);
        let env = envelope(&key, "org-1", "dev-1", 1, &grouped_doc(1, "grp-1"));
        fake.store_body(1, Ok(env.clone()));
        fake.push(FakeBackend::head_event(&env, 2, FakeBackend::test_keys()));
        settle().await;
        assert_eq!(fake.roster_calls(), [0]);
        let saved = RosterState::load(&rig.ctx.paths.roster());
        assert_eq!((saved.group_id.as_deref(), saved.epoch, saved.members.len()), (Some("grp-1"), 2, 2));

        // The epoch moves: one delta fetch from 2. A forged entry is refused (twice:
        // the delta, then from the start) and the stored roster stays.
        let mut forged = roster_entry(&key, "org-1", "grp-1", 3, "emp-3", Some(1));
        forged.employee_id = "emp-4".into();
        fake.script_roster(Ok(RosterFetch::Entries { epoch: 3, entries: vec![forged.clone()] }));
        fake.script_roster(Ok(RosterFetch::Entries { epoch: 3, entries: vec![forged] }));
        fake.push(FakeBackend::head_event(&env, 3, FakeBackend::test_keys()));
        settle().await;
        assert_eq!(fake.roster_calls(), [0, 2, 0]);
        assert_eq!(RosterState::load(&rig.ctx.paths.roster()), saved);
        // Not tried again for the same epoch.
        fake.push(FakeBackend::head_event(&env, 3, FakeBackend::test_keys()));
        settle().await;
        assert_eq!(fake.roster_calls().len(), 3);
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
        assert_eq!(rig.changed(), 1);
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
