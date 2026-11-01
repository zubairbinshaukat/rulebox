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

use futures_util::future::FusedFuture;
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
    sha256_hex, Backend, BackendError, BackendEvent, BackendFactory, BackendLink, DesiredFetch, DeviceAuth, Head,
    PingResponse, StatusReport, CODE_CONFLICT, CODE_DEVICE_REJECTED, CODE_NOT_FOUND, CODE_NOT_READY,
};
use crate::report::{backoff_delay, ReportQueue};
use rulebox_ipc::requests::SessionEndReason;
use crate::agent::{load_verified_cache, CachedDesired};
use crate::agent_policy::AgentPolicy;
use crate::compat;
use crate::kiosk_control::KioskControl;
use crate::paths::DataPaths;
use crate::platform::Platform;
use crate::roster::{self, RosterError, RosterState};
use crate::session::SessionManager;
use crate::state::{write_atomic, SharedState, SnapshotHandle};
use crate::trust::{self, TrustError};

/// First ping after a transition to online: a random wait up to this long.
const FIRST_PING_JITTER_MS: u64 = 10_000;
/// (A13) After an outage longer than [`LONG_OUTAGE`], the first ping waits a
/// random time up to this long instead, so a fleet coming back does not ping at once.
const OUTAGE_PING_JITTER_MS: u64 = 120_000;
const LONG_OUTAGE: Duration = Duration::from_secs(300);
/// (A13) A changed `pingNonce` ("Check now"): one ping within this long.
const NONCE_PING_JITTER_MS: u64 = 5_000;
/// (A13) While `now < fastUntil` (watch mode): a ping every minute.
const FAST_PING_MS: u64 = 60_000;
/// The watch window is also bounded by a local monotonic timer from the moment
/// its head arrived, and never lasts longer than this: `fastUntil` is server time,
/// and a PC whose clock is days behind would otherwise ping every minute for days.
const FAST_WINDOW_MAX: Duration = Duration::from_secs(15 * 60);
/// Two credential rotation attempts on this PC are at least this far apart (the
/// startup retry of a pending secret excepted): a server that answers
/// `rotateCredential: true` on every ping cannot make the agent rewrite its
/// secrets file and resubscribe every minute.
const ROTATION_MIN_GAP: Duration = Duration::from_secs(3600);
/// Used until the head says otherwise (the server default is 30 minutes).
const DEFAULT_PING_MS: u64 = 1_800_000;
/// (A12) The interval is clamped to this range, so a buggy value neither makes a
/// tight loop nor silences the device for a day.
const MIN_PING_MS: u64 = 60_000;
const MAX_PING_MS: u64 = 21_600_000;
/// A failed ping is retried with full-jitter backoff (`report::backoff_delay`),
/// never sooner than this.
const MIN_RETRY: Duration = Duration::from_secs(1);
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
    /// (Step 13) Set while the task runs: the directory and the report sink use it.
    pub link: Arc<BackendLink>,
    /// (Step 13) The status goes out with the report, not the ping.
    pub report: Arc<ReportQueue>,
    /// (Step 13) Every verified roster that was saved (the session layer reads it).
    pub roster_tx: Arc<watch::Sender<RosterState>>,
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

    /// A document that could not even be checked because the PC has no
    /// organization (fail closed): same effect as a failed verification.
    pub fn reject_untrusted_store(&mut self, version: u64, error: TrustError) {
        tracing::error!(version, %error, "policy_rejected: the desired state was not applied (no organization id)");
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
        // The anti-rollback floor is persisted NOW, at accept time (not when the
        // reconciler has applied it, not only in the cache file): a lost or
        // unverifiable `desired-state.json` must not let an older signed document
        // back in.
        let (_, saved) = ctx.shared.update_if(|state| {
            if state.accepted_version < version {
                state.accepted_version = version;
                ((), true)
            } else {
                ((), false)
            }
        });
        if let Err(error) = saved {
            tracing::error!("cannot save the accepted version: {error}");
        }

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

/// The server stopped sending its time: the stored offset is no longer current.
pub fn clear_server_time(ctx: &TaskContext) {
    ctx.snapshot.update(|snapshot| snapshot.server_time_offset_ms = None);
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
        // (Step 14) Set by the install engine after an MSI returned 3010 / 1641.
        restart_pending: ctx.report.restart_pending(),
    })
}

// -- the task ---------------------------------------------------------------------

/// What a spawned ping reports back.
struct PingDone {
    /// Set when the ping used the pending (rotating) secret: a check, and why it
    /// was made. The reason travels with the request, so the answer is always read
    /// for the question that was asked.
    probe: Option<ProbeWhy>,
    result: Result<PingResponse, BackendError>,
}

/// What a spawned `rotateCredential` reports back.
struct RotateDone {
    new_secret: String,
    result: Result<(), BackendError>,
}

/// What a spawned fetch reports back.
enum FetchDone {
    Desired { head: Head, result: Result<SignedEnvelope, BackendError> },
    Roster { group_id: String, target: u64, result: Result<RosterState, RosterError> },
}

/// `base_ms` (clamped to `[60 s, 6 h]`) with +-10 % jitter.
fn ping_delay(ctx: &TaskContext, base_ms: u64) -> Duration {
    let base = base_ms.clamp(MIN_PING_MS, MAX_PING_MS);
    let spread = base / 10;
    Duration::from_millis(base - spread + (ctx.jitter)(2 * spread))
}

fn is_code(error: &BackendError, code: &str) -> bool {
    matches!(error, BackendError::Rejected { code: got } if got == code)
}

/// The ping schedule (A4, A12, A13): the interval from the head, a ping 0-5 s
/// after a changed nonce, every minute while `fastUntil` is ahead, full-jitter
/// backoff after an error, and a longer first wait after a long outage.
struct Pinger {
    next_at: Option<Instant>,
    /// From the head; the ping answer's value only while no head is known.
    interval_ms: u64,
    head_interval: bool,
    nonce: Option<u64>,
    /// The `fastUntil` (server time) of the last head, to tell a repeated head from
    /// a new watch window.
    fast_seen_ms: u64,
    /// The end of the watch window on the local monotonic clock.
    fast_deadline: Option<Instant>,
    failures: u32,
    task: Option<JoinHandle<()>>,
    offline_since: Option<Instant>,
    plan_state: String,
}

impl Pinger {
    fn new() -> Self {
        Self {
            next_at: None,
            interval_ms: DEFAULT_PING_MS,
            head_interval: false,
            nonce: None,
            fast_seen_ms: 0,
            fast_deadline: None,
            failures: 0,
            task: None,
            offline_since: None,
            plan_state: "ok".into(),
        }
    }

    fn sooner(&mut self, at: Instant) {
        self.next_at = Some(self.next_at.map_or(at, |next| next.min(at)));
    }

    fn fast(&self) -> bool {
        self.fast_deadline.is_some_and(|deadline| Instant::now() < deadline)
    }

    /// The local end of a watch window that the server ends at `fast_until_ms`
    /// (server time): the smaller of the time left by the server's clock (this PC's
    /// clock plus the last known offset) and [`FAST_WINDOW_MAX`], counted from now.
    fn fast_window(ctx: &TaskContext, fast_until_ms: u64) -> Option<Instant> {
        let offset = ctx.snapshot.current().server_time_offset_ms.unwrap_or(0);
        let server_now = i128::from((ctx.now_ms)()) + i128::from(offset);
        let left_ms = i128::from(fast_until_ms) - server_now;
        if left_ms <= 0 {
            return None;
        }
        let left = Duration::from_millis(u64::try_from(left_ms).unwrap_or(u64::MAX));
        Some(Instant::now() + left.min(FAST_WINDOW_MAX))
    }

    /// The connection changed.
    fn on_connection(&mut self, ctx: &TaskContext, was_online: bool, online: bool) {
        if online && !was_online {
            let long = self.offline_since.is_some_and(|since| since.elapsed() > LONG_OUTAGE);
            let max = if long { OUTAGE_PING_JITTER_MS } else { FIRST_PING_JITTER_MS };
            self.next_at = Some(Instant::now() + Duration::from_millis((ctx.jitter)(max)));
            self.offline_since = None;
        }
        if !online {
            self.next_at = None;
            if self.offline_since.is_none() {
                self.offline_since = Some(Instant::now());
            }
        }
    }

    /// A head arrived: interval, nonce, watch mode.
    fn on_head(&mut self, ctx: &TaskContext, head: &Head, online: bool) {
        self.interval_ms = head.ping_interval_ms.clamp(MIN_PING_MS, MAX_PING_MS);
        self.head_interval = true;
        let nonce_changed = self.nonce.is_some_and(|nonce| nonce != head.ping_nonce);
        self.nonce = Some(head.ping_nonce);
        // A repeated head (the same `fastUntil`) does not start the window again.
        if head.fast_until != self.fast_seen_ms {
            self.fast_seen_ms = head.fast_until;
            self.fast_deadline = Self::fast_window(ctx, head.fast_until);
        }
        if !online {
            return;
        }
        if nonce_changed {
            tracing::info!("the dashboard asked for a check; pinging");
            self.sooner(Instant::now() + Duration::from_millis((ctx.jitter)(NONCE_PING_JITTER_MS)));
        }
        if self.fast() {
            self.sooner(Instant::now() + Duration::from_millis(FAST_PING_MS));
        } else if let Some(next) = self.next_at {
            // A shorter interval takes effect now, not after the old long wait.
            let latest = Instant::now() + ping_delay(ctx, self.interval_ms);
            if next > latest {
                self.next_at = Some(latest);
            }
        }
    }

    /// When the next regular ping is due, from now.
    fn schedule(&mut self, ctx: &TaskContext) {
        let delay = if self.fast() { Duration::from_millis(FAST_PING_MS) } else { ping_delay(ctx, self.interval_ms) };
        self.next_at = Some(Instant::now() + delay);
    }

    fn failed(&mut self, ctx: &TaskContext) {
        self.failures = self.failures.saturating_add(1);
        let delay = backoff_delay(self.failures, ctx.jitter.as_ref()).max(MIN_RETRY);
        self.next_at = Some(Instant::now() + delay);
    }

    fn in_flight(&self) -> bool {
        self.task.as_ref().is_some_and(|task| !task.is_finished())
    }

    fn note_plan_state(&mut self, plan_state: &str) {
        if plan_state != self.plan_state {
            // (Step 13 item 12) Logged only: the PC keeps its last signed document
            // and stays locked; nothing is unlocked to save resources.
            tracing::warn!(plan_state, "the organization's plan state changed; nothing changes on this PC");
            self.plan_state = plan_state.to_string();
        }
    }
}

/// A credential rotation (Step 13 item 8; Step 12 contract). The new secret is
/// saved as `rotating_device_secret` before its hash is sent; the old secret
/// stays `device_secret` (and in use) until the server confirmed the new one, so
/// the PC never holds neither. A lost answer is retried with the SAME pending
/// secret (the server answers ok again).
struct Rotation {
    pending: Option<String>,
    task: Option<JoinHandle<()>>,
    /// `not_ready` (no credentials row on the server): not tried again by this task.
    blocked: bool,
    /// The subscription said `unknownDevice` while a rotation was pending: the
    /// pending secret is being tried before that counts as a revocation.
    unknown_device: bool,
    /// When the last `rotateCredential` call of this run started.
    last_attempt: Option<Instant>,
}

impl Rotation {
    /// A call is in flight (cleared when its result is taken from the channel, so
    /// a call that has finished but not been read yet still counts).
    fn busy(&self) -> bool {
        self.task.is_some()
    }

    /// Whether [`ROTATION_MIN_GAP`] has passed since the last attempt.
    fn gap_over(&self) -> bool {
        self.last_attempt.is_none_or(|at| at.elapsed() >= rotation_min_gap())
    }
}

#[cfg(test)]
thread_local! {
    /// Tests that exercise the single-flight rules alone switch the gap off.
    static TEST_GAP: std::cell::Cell<Option<Duration>> = const { std::cell::Cell::new(None) };
}

fn rotation_min_gap() -> Duration {
    #[cfg(test)]
    if let Some(gap) = TEST_GAP.with(std::cell::Cell::get) {
        return gap;
    }
    ROTATION_MIN_GAP
}

/// The check of the pending secret with a ping (`ProbeWhy` says which question it
/// answers). Single flight: at most one is running, and while one runs (or waits
/// to be retried) no rotation starts and no second check is made, so an answer is
/// never read for another question than the one it was asked for.
#[derive(Default)]
struct Probe {
    task: Option<JoinHandle<()>>,
    /// The last check got no answer: ask the same question again at the next ping time.
    retry: Option<ProbeWhy>,
}

impl Probe {
    fn active(&self) -> bool {
        self.task.is_some() || self.retry.is_some()
    }
}

/// Saves a new pending secret (first) and returns it.
fn new_pending_secret(ctx: &TaskContext) -> Option<String> {
    let secret = match crate::enroll::new_device_secret() {
        Ok(secret) => secret,
        Err(_) => {
            tracing::error!("cannot make a new device secret (no random numbers); rotation not started");
            return None;
        }
    };
    match ctx.shared.update_secrets(|secrets| secrets.rotating_device_secret = Some(secret.clone())) {
        Ok(()) => Some(secret),
        Err(error) => {
            // Nothing was sent: the server still has only the old secret.
            tracing::error!("cannot save the new device secret ({error}); rotation not started");
            None
        }
    }
}

/// Makes the confirmed new secret the device secret. False when it could not be
/// saved: the old one stays in use (still valid until the new one is used) and
/// the rotation is retried.
fn adopt_secret(ctx: &TaskContext, new_secret: &str) -> bool {
    let saved = ctx.shared.update_secrets(|secrets| {
        secrets.device_secret = Some(new_secret.to_string());
        secrets.rotating_device_secret = None;
    });
    match saved {
        Ok(()) => {
            tracing::info!("the device credential was rotated");
            true
        }
        Err(error) => {
            tracing::error!("cannot save the rotated device secret ({error}); keeping the old one for now");
            false
        }
    }
}

fn drop_pending_secret(ctx: &TaskContext) {
    if let Err(error) = ctx.shared.update_secrets(|secrets| secrets.rotating_device_secret = None) {
        tracing::error!("cannot clear the pending device secret: {error}");
    }
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
    ctx.link.clear();
    // (Step 13) The Staff App hears why.
    ctx.session.end(SessionEndReason::Revoked);
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

    /// Forgets the failures that depended on the trust store.
    fn retry_after_trust_change(&mut self) {
        let had_failure = self.failed_version.take().is_some();
        let had_roster_failure = self.roster_failed.take().is_some();
        if had_failure || had_roster_failure {
            tracing::info!("the trusted keys changed; retrying what failed verification");
        }
    }

    /// A new head-state result: trust first (a new key may sign the new body).
    fn on_head(&mut self, ctx: &TaskContext, head: Option<Head>, keys: Vec<PublishedKey>, retired: Vec<String>, sync: &DesiredSync) {
        match trust::update(&ctx.shared, &keys, &retired) {
            // The trust store changed: whatever failed before (an unknown key, say)
            // may verify now, and a legitimate higher version must always recover.
            Ok(change) if !change.is_empty() => self.retry_after_trust_change(),
            Ok(_) => {}
            Err(error) => tracing::error!(%error, "the trust store was not updated"),
        }
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
                // The floors are kept: a later document may name the group again.
                let cleared = self.roster.restarted(None);
                if let Err(error) = self.save_roster(ctx, cleared) {
                    tracing::error!("roster_rejected: {error}; the stored roster stays");
                }
            }
            return;
        };
        let target = head.roster_epoch;
        // A head epoch BELOW the stored one is never followed (the head is unsigned
        // and the roster epoch never decreases).
        let current = self.roster.group_id.as_deref() == Some(group_id.as_str()) && self.roster.epoch >= target;
        if current || self.roster_failed.as_ref() == Some(&(group_id.clone(), target)) {
            return;
        }
        let (trusted, org_id) = match trust::verification_inputs(&ctx.shared) {
            Ok(inputs) => inputs,
            Err(error) => {
                tracing::error!(%error, "roster_rejected: the roster was not checked (no organization id)");
                return;
            }
        };
        let (backend, auth, done_tx) = (Arc::clone(backend), auth.clone(), done_tx.clone());
        let roster = self.roster.clone();
        self.task = Some(tokio::spawn(async move {
            let result = roster::sync(backend.as_ref(), &auth, roster, target, &trusted, &org_id, &group_id).await;
            let _ = done_tx.send(FetchDone::Roster { group_id, target, result }).await;
        }));
    }

    /// Replaces the stored roster. The epoch of a group never decreases: a roster
    /// below the highest verified epoch is refused (nothing saved), and the floors
    /// of both are merged.
    fn save_roster(&mut self, ctx: &TaskContext, roster: RosterState) -> Result<(), RosterError> {
        self.roster.check_monotonic(&roster)?;
        let roster = self.roster.succeeded_by(roster);
        if roster == self.roster {
            return Ok(());
        }
        if let Err(error) = roster.save(&ctx.paths.roster()) {
            tracing::error!("cannot save roster.json: {error}");
        }
        tracing::info!(epoch = roster.epoch, members = roster.members.len(), "roster updated");
        // (Step 13) Only a roster that passed the monotonic check reaches the
        // session layer.
        ctx.roster_tx.send_replace(roster.clone());
        self.roster = roster;
        Ok(())
    }

    /// A fetch finished. Returns whether a document was applied.
    fn on_done(&mut self, ctx: &TaskContext, auth: &DeviceAuth, sync: &mut DesiredSync, done: FetchDone) -> bool {
        match done {
            FetchDone::Desired { head, result: Ok(envelope) } => {
                self.backoff = FETCH_RETRY_BASE;
                let (trusted, org_id) = match trust::verification_inputs(&ctx.shared) {
                    Ok(inputs) => inputs,
                    Err(error) => {
                        // Fail closed: no organization id, nothing is verified or applied.
                        sync.reject_untrusted_store(head.version, error);
                        self.failed_version = Some(head.version);
                        return false;
                    }
                };
                let head_ref = HeadRef { version: head.version, key_id: &head.key_id };
                match verify_for_head(&envelope, &trusted, &org_id, &auth.device_id, &head_ref) {
                    Ok(payload) => {
                        let outcome = sync.accept(ctx, &envelope, payload);
                        if outcome == DocOutcome::Applied {
                            // A document of the new key may let a retired key go.
                            match trust::update(&ctx.shared, &self.keys, &self.retired) {
                                Ok(change) if !change.is_empty() => self.retry_after_trust_change(),
                                Ok(_) => {}
                                Err(error) => tracing::error!(%error, "the trust store was not updated"),
                            }
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
                    if roster.epoch < target {
                        tracing::warn!(epoch = roster.epoch, target, "the roster did not reach the head's epoch");
                        self.roster_failed = Some((group_id.clone(), target));
                    }
                    if let Err(error) = self.save_roster(ctx, roster) {
                        tracing::error!(reason = error.reason(), "roster_rejected: {error}; the stored roster stays");
                        self.roster_failed = Some((group_id, target));
                    }
                }
                Err(RosterError::Backend(error)) => self.retry_later("roster", &error),
                Err(error) => {
                    tracing::error!(reason = error.reason(), "roster_rejected: {error}; the stored roster stays");
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

/// Why the pending secret is being tried with a ping.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProbeWhy {
    /// `rotateCredential` answered `conflict`: the old secret still works.
    Conflict,
    /// `rotateCredential` refused the old secret (`device_rejected`).
    OldRejected,
    /// The subscription answered `unknownDevice` for the old secret.
    UnknownDevice,
}

/// Runs until `shutdown`, or until the backend says the device is revoked (or
/// unknown, with every secret it might know tried). Never calls the reconciler's
/// `disable`: a remote revocation must not unlock a PC (README answer Q11).
pub async fn run_backend_task(
    ctx: Arc<TaskContext>,
    backend: Arc<dyn Backend>,
    auth: DeviceAuth,
    shutdown: CancellationToken,
) {
    let mut auth = auth;
    // The anti-rollback floor: the highest of every version accepted or applied
    // (`agent-state.json`), then the cache's (`load_cached`).
    let mut sync = DesiredSync::new(ctx.shared.read(|state| state.version_floor()));
    sync.load_cached(&ctx);
    if ctx.shared.read(|state| state.trusted_keys.is_empty()) {
        tracing::error!("this PC trusts no policy key (enrolled before Phase 4?): no document can be applied; re-enroll it");
    }
    note_clock(&ctx);
    ctx.link.set(Arc::clone(&backend), auth.clone());

    // The status leaves with the report (A12); the report task builds it from here.
    let problem: Arc<std::sync::Mutex<Option<&'static str>>> = Arc::new(std::sync::Mutex::new(sync.problem));
    {
        let (status_ctx, status_problem) = (Arc::clone(&ctx), Arc::clone(&problem));
        ctx.report.set_status_source(Some(Arc::new(move || {
            let current = *crate::state::lock(&status_problem);
            build_status(&status_ctx, current)
        })));
    }

    let (event_tx, mut events) = mpsc::channel::<BackendEvent>(EVENT_QUEUE);
    let mut sub_cancel = shutdown.child_token();
    let mut subscription = backend.subscribe(auth.clone(), event_tx.clone(), sub_cancel.clone()).fuse();
    let (ping_tx, mut ping_rx) = mpsc::channel::<PingDone>(2);
    let (rotate_tx, mut rotate_rx) = mpsc::channel::<RotateDone>(1);
    let (fetch_tx, mut fetch_rx) = mpsc::channel::<FetchDone>(1);
    let mut fetcher = Fetcher::new(RosterState::load(&ctx.paths.roster()));
    ctx.roster_tx.send_replace(fetcher.roster.clone());
    let mut pinger = Pinger::new();
    let pending = match ctx.shared.secrets(|secrets| secrets.rotating_device_secret.clone()) {
        Ok(pending) => pending,
        Err(error) => {
            tracing::error!("cannot read the secrets: {error}");
            None
        }
    };
    let mut rotation = Rotation { pending, task: None, blocked: false, unknown_device: false, last_attempt: None };
    let mut probe = Probe::default();
    let mut online = false;
    let mut revoked = false;

    let spawn_rotate = |rotation: &mut Rotation, auth: &DeviceAuth, new_secret: String| {
        let (backend, auth, tx) = (Arc::clone(&backend), auth.clone(), rotate_tx.clone());
        rotation.last_attempt = Some(Instant::now());
        rotation.task = Some(tokio::spawn(async move {
            let result = backend.rotate_credential(&auth, &sha256_hex(&new_secret)).await;
            let _ = tx.send(RotateDone { new_secret, result }).await;
        }));
    };
    let spawn_ping = |auth: DeviceAuth, probe: Option<ProbeWhy>| {
        let (backend, tx) = (Arc::clone(&backend), ping_tx.clone());
        tokio::spawn(async move {
            let result = backend.ping(&auth).await;
            let _ = tx.send(PingDone { probe, result }).await;
        })
    };
    // Starts the one check of the pending secret. Single flight: when a check is
    // already running, that one decides and this call does nothing.
    let start_probe = |probe: &mut Probe, auth: &DeviceAuth, secret: String, why: ProbeWhy| {
        if probe.task.is_some() {
            return;
        }
        probe.retry = None;
        let probe_auth = DeviceAuth { device_id: auth.device_id.clone(), device_secret: secret };
        probe.task = Some(spawn_ping(probe_auth, Some(why)));
    };

    // (Step 13 item 8) A rotation that was under way when the agent stopped: ask
    // again with the old secret and the same new hash (idempotent on the server).
    if let Some(new_secret) = rotation.pending.clone() {
        tracing::info!("a credential rotation was not finished; asking the backend again");
        spawn_rotate(&mut rotation, &auth, new_secret);
    }

    loop {
        let timer = async {
            match pinger.next_at {
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
        let mut resubscribe = false;
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
                    pinger.on_connection(&ctx, online, now_online);
                    if now_online && !online {
                        ctx.report.status_changed();
                    }
                    online = now_online;
                }
                BackendEvent::Desired(DesiredFetch::Ok { head, keys, retired_key_ids }) => {
                    if rotation.unknown_device {
                        // The (new) secret is known after all.
                        rotation.unknown_device = false;
                    }
                    if let Some(head) = &head {
                        pinger.on_head(&ctx, head, online);
                    }
                    fetcher.on_head(&ctx, head, keys, retired_key_ids, &sync);
                    fetcher.kick(&ctx, &backend, &auth, &sync, &fetch_tx);
                }
                BackendEvent::Desired(DesiredFetch::Revoked) => {
                    handle_revoked(&ctx, false);
                    revoked = true;
                    break;
                }
                BackendEvent::Desired(DesiredFetch::UnknownDevice) => {
                    match rotation.pending.clone() {
                        // (Step 13 item 8) Not a revocation until both secrets were tried.
                        Some(new_secret) if !rotation.unknown_device => {
                            tracing::warn!("the backend does not know the current secret; trying the pending one");
                            rotation.unknown_device = true;
                            // Single flight: a rotation call or a check that is under way
                            // answers first; the flag makes its end ask the question again.
                            if !rotation.busy() && !probe.active() {
                                start_probe(&mut probe, &auth, new_secret, ProbeWhy::UnknownDevice);
                            }
                        }
                        Some(_) => {}
                        None => {
                            handle_revoked(&ctx, true);
                            revoked = true;
                            break;
                        }
                    }
                }
            },
            Some(done) = fetch_rx.recv() => {
                // The fetch has sent its result: it is over even if its task has
                // not quite returned yet.
                fetcher.task = None;
                if fetcher.on_done(&ctx, &auth, &mut sync, done) {
                    ctx.control.desired_changed();
                }
                let changed = {
                    let mut current = crate::state::lock(&problem);
                    let changed = *current != sync.problem;
                    *current = sync.problem;
                    changed
                };
                if changed || sync.accepted_version().is_some() {
                    ctx.report.status_changed();
                }
                fetcher.kick(&ctx, &backend, &auth, &sync, &fetch_tx);
            }
            () = retry => {
                fetcher.retry_at = None;
                fetcher.kick(&ctx, &backend, &auth, &sync, &fetch_tx);
            }
            () = timer => {
                pinger.next_at = None;
                // A check of the pending secret that got no answer is asked again (the
                // same question); `start_probe` keeps it from running next to another.
                if let Some(why) = probe.retry {
                    match rotation.pending.clone() {
                        Some(new_secret) => start_probe(&mut probe, &auth, new_secret, why),
                        None => probe.retry = None,
                    }
                }
                if online && !pinger.in_flight() {
                    pinger.task = Some(spawn_ping(auth.clone(), None));
                }
            }
            Some(done) = ping_rx.recv() => {
                if let Some(why) = done.probe {
                    probe.task = None;
                    match done.result {
                        Ok(answer) => {
                            // The backend knows the pending secret: it is the one.
                            probe.retry = None;
                            if let Some(new_secret) = rotation.pending.take() {
                                if adopt_secret(&ctx, &new_secret) {
                                    auth = DeviceAuth { device_id: auth.device_id.clone(), device_secret: new_secret };
                                    ctx.link.set_auth(auth.clone());
                                    resubscribe = true;
                                } else {
                                    rotation.pending = Some(new_secret);
                                }
                            }
                            rotation.unknown_device = false;
                            pinger.note_plan_state(&answer.plan_state);
                            pinger.schedule(&ctx);
                        }
                        // The server answered this very check: the pending secret is
                        // not known to it. What that means depends on the question.
                        Err(error) if is_code(&error, CODE_DEVICE_REJECTED) => {
                            probe.retry = None;
                            match why {
                                ProbeWhy::UnknownDevice => {
                                    tracing::warn!("neither the current nor the pending secret is known to the backend");
                                    handle_revoked(&ctx, true);
                                    revoked = true;
                                    break;
                                }
                                ProbeWhy::Conflict => {
                                    // The old secret works (the server answered `conflict` to
                                    // it); the pending one is not the server's. Keep the old
                                    // one and stop rotating until asked again.
                                    tracing::error!("credential rotation conflict; staying on the current secret");
                                    rotation.pending = None;
                                    drop_pending_secret(&ctx);
                                    rotation.blocked = true;
                                    if rotation.unknown_device {
                                        // The subscription said `unknownDevice` meanwhile: it
                                        // is asked again and answers for the secret now in use.
                                        rotation.unknown_device = false;
                                        resubscribe = true;
                                    }
                                }
                                ProbeWhy::OldRejected => {
                                    // Both refused. Revocation is the subscription's call, not
                                    // ours: it is asked again, and an `unknownDevice` from it
                                    // checks the pending secret once more.
                                    tracing::warn!("the backend refused both device secrets; the subscription decides");
                                    rotation.unknown_device = false;
                                    resubscribe = true;
                                }
                            }
                        }
                        Err(error) => {
                            // No answer (offline, timeout): never a conclusion. The same
                            // question is asked again at the next ping time.
                            tracing::debug!("cannot try the pending secret ({error}); trying again later");
                            probe.retry = Some(why);
                            pinger.failed(&ctx);
                        }
                    }
                } else {
                    pinger.task = None;
                    match done.result {
                        Ok(answer) => {
                            pinger.failures = 0;
                            if !pinger.head_interval {
                                pinger.interval_ms = answer.next_ping_in_ms.clamp(MIN_PING_MS, MAX_PING_MS);
                            }
                            match answer.server_time_ms {
                                Some(server_time_ms) => note_server_time(&ctx, server_time_ms),
                                // A server that stops sending its time leaves no stale offset.
                                None => clear_server_time(&ctx),
                            }
                            note_clock(&ctx);
                            pinger.note_plan_state(&answer.plan_state);
                            pinger.schedule(&ctx);
                            // Single flight: no rotation starts while a rotation call or a
                            // check of the pending secret is under way (or waits for a retry),
                            // and never within ROTATION_MIN_GAP of the last attempt.
                            if !rotation.blocked && !rotation.busy() && !probe.active() && rotation.gap_over() {
                                if let Some(new_secret) = rotation.pending.clone() {
                                    // An earlier try got no answer: the same secret again.
                                    spawn_rotate(&mut rotation, &auth, new_secret);
                                } else if answer.rotate_credential {
                                    if let Some(new_secret) = new_pending_secret(&ctx) {
                                        tracing::info!("the backend asked for a new device credential; rotating");
                                        rotation.pending = Some(new_secret.clone());
                                        spawn_rotate(&mut rotation, &auth, new_secret);
                                    }
                                }
                            }
                        }
                        Err(error) => {
                            if is_code(&error, CODE_DEVICE_REJECTED) {
                                // The subscription decides what a rejection means.
                                tracing::warn!("the backend rejected the ping");
                            } else {
                                tracing::debug!("ping failed ({error}); backing off");
                            }
                            pinger.failed(&ctx);
                        }
                    }
                }
            }
            Some(done) = rotate_rx.recv() => {
                rotation.task = None;
                match done.result {
                    Ok(()) => {
                        if adopt_secret(&ctx, &done.new_secret) {
                            rotation.pending = None;
                            rotation.unknown_device = false;
                            auth = DeviceAuth { device_id: auth.device_id.clone(), device_secret: done.new_secret };
                            ctx.link.set_auth(auth.clone());
                            resubscribe = true;
                        }
                    }
                    Err(error) if is_code(&error, CODE_CONFLICT) => {
                        tracing::warn!("the backend holds another new credential; trying the pending secret");
                        start_probe(&mut probe, &auth, done.new_secret, ProbeWhy::Conflict);
                    }
                    Err(error) if is_code(&error, CODE_NOT_READY) => {
                        // Nothing changed on the server (no credentials row yet).
                        tracing::warn!("the backend cannot rotate this device's credential yet (not_ready)");
                        rotation.pending = None;
                        drop_pending_secret(&ctx);
                        rotation.blocked = true;
                        if rotation.unknown_device {
                            rotation.unknown_device = false;
                            resubscribe = true;
                        }
                    }
                    Err(error) if is_code(&error, CODE_DEVICE_REJECTED) => {
                        tracing::warn!("the backend refused the current secret during rotation; trying the pending one");
                        start_probe(&mut probe, &auth, done.new_secret, ProbeWhy::OldRejected);
                    }
                    Err(error) => {
                        // Lost answer or offline: both secrets stay; the next ping asks again.
                        tracing::warn!("credential rotation got no answer ({error}); trying again at the next ping");
                        if rotation.unknown_device {
                            // The subscription's question is still open: ask it now.
                            start_probe(&mut probe, &auth, done.new_secret, ProbeWhy::UnknownDevice);
                        }
                    }
                }
            }
        }
        if resubscribe {
            // The subscription carries the credentials: start it again with the new
            // secret (the first call with it lets the server drop the old one).
            sub_cancel.cancel();
            if !subscription.is_terminated() {
                (&mut subscription).await;
            }
            sub_cancel = shutdown.child_token();
            subscription = backend.subscribe(auth.clone(), event_tx.clone(), sub_cancel.clone()).fuse();
        }
    }

    for task in [pinger.task.take(), rotation.task.take(), probe.task.take()].into_iter().flatten() {
        task.abort();
    }
    fetcher.stop();
    ctx.report.set_status_source(None);
    ctx.link.clear();
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
            let parts = crate::testutil::test_session_parts(dir.path(), snapshot_rx.clone());
            let (session, audit) = (parts.session, parts.audit);
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
                link: BackendLink::new(),
                report: crate::report::ReportQueue::new(audit),
                roster_tx: Arc::new(watch::channel(RosterState::default()).0),
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
        // (Step 13) The status goes out with the report; the task feeds its source.
        let status = rig.ctx.report.build_status_now().unwrap();
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

    #[tokio::test(start_paused = true)]
    async fn the_accepted_version_floor_survives_a_lost_cache() {
        let rig = Rig::new();
        let fake = FakeBackend::new();
        let (cancel, handle) = rig.start(&fake);
        push_doc(&fake, 5, doc(5, true));
        settle().await;
        // Accepted, but the reconciler never ran (the fake control): only the
        // accept-time floor can know about version 5.
        let state = rig.ctx.shared.get();
        assert_eq!((state.accepted_version, state.last_applied_version), (5, 0));
        let on_disk = std::fs::read_to_string(rig.ctx.paths.agent_state()).unwrap();
        assert!(on_disk.contains("\"acceptedVersion\": 5"), "{on_disk}");
        stop(cancel, handle).await;

        // The cache is lost; the agent restarts. A validly signed older document is
        // still a rollback: never even fetched.
        std::fs::remove_file(rig.cache_path()).unwrap();
        let fake = FakeBackend::new();
        let (cancel, handle) = rig.start(&fake);
        push_doc(&fake, 3, doc(3, false));
        settle().await;
        assert!(fake.desired_calls().is_empty());
        assert!(!rig.cache_path().exists());
        // The body of 3 behind a head for 7 is refused too, and 6 is accepted.
        let old = envelope(&test_key(), "org-1", "dev-1", 3, &doc(3, false));
        fake.store_body(7, Ok(old.clone()));
        fake.push(FakeBackend::head_event(&SignedEnvelope { version: 7, ..old }, 0, FakeBackend::test_keys()));
        settle().await;
        assert!(!rig.cache_path().exists());
        push_doc(&fake, 6, doc(6, true));
        settle().await;
        assert_eq!(rig.snapshot().desired_state_version, 6);
        assert_eq!(rig.ctx.shared.get().accepted_version, 6);
        stop(cancel, handle).await;

        // An unparseable cache does not lower it either, and re-enrolling resets it
        // (enroll.rs tests).
        std::fs::write(rig.cache_path(), b"{ not json").unwrap();
        let fake = FakeBackend::new();
        let (cancel, handle) = rig.start(&fake);
        push_doc(&fake, 4, doc(4, false));
        settle().await;
        assert!(fake.desired_calls().is_empty());
        stop(cancel, handle).await;
    }

    #[tokio::test(start_paused = true)]
    async fn a_failed_version_is_retried_after_the_trust_store_changes() {
        let rig = Rig::new();
        let fake = FakeBackend::new();
        let (cancel, handle) = rig.start(&fake);
        let (k1, k2) = (test_key(), test_key_2());
        // Version 2 is signed by k2, which this PC does not trust yet and the first
        // answer does not list: UnknownKey, kept as failed.
        let env = envelope(&k2, "org-1", "dev-1", 2, &doc(2, true));
        fake.store_body(2, Ok(env.clone()));
        fake.push(head_state(&env, vec![published(&k1, None)], vec![]));
        settle().await;
        assert_eq!(fake.desired_calls(), [2]);
        assert!(rig.snapshot().desired_state.is_none());
        // The same head with nothing new: not fetched again.
        fake.push(head_state(&env, vec![published(&k1, None)], vec![]));
        settle().await;
        assert_eq!(fake.desired_calls(), [2]);
        // The SAME head, now with k2 endorsed by k1: the trust store changes, the
        // failure is forgotten and version 2 is fetched and applied.
        fake.push(head_state(&env, vec![published(&k1, None), published(&k2, Some(&k1))], vec![]));
        settle().await;
        assert_eq!(fake.desired_calls(), [2, 2]);
        assert_eq!(rig.snapshot().desired_state_version, 2);
        assert_eq!(rig.trusted_ids().len(), 2);
        stop(cancel, handle).await;
    }

    #[tokio::test(start_paused = true)]
    async fn without_an_organization_nothing_is_verified_or_applied() {
        let rig = Rig::with_state(AgentState { trusted_keys: vec![trusted_of(&test_key())], ..AgentState::default() });
        let fake = FakeBackend::new();
        let (cancel, handle) = rig.start(&fake);
        push_doc(&fake, 1, doc(1, true));
        settle().await;
        assert!(rig.snapshot().desired_state.is_none());
        assert!(!rig.cache_path().exists());
        assert_eq!(rig.ctx.shared.get().accepted_version, 0);
        assert_eq!(rig.changed(), 0);
        stop(cancel, handle).await;
    }

    #[tokio::test(start_paused = true)]
    async fn the_roster_epoch_never_decreases() {
        let rig = Rig::new();
        let key = test_key();
        std::fs::create_dir_all(rig.ctx.paths.state_dir()).unwrap();
        let stored = RosterState {
            group_id: Some("grp-1".into()),
            epoch: 5,
            members: std::collections::BTreeMap::from([("emp-1".to_string(), 1), ("emp-2".to_string(), 1)]),
            ..RosterState::default()
        };
        stored.save(&rig.ctx.paths.roster()).unwrap();
        let fake = FakeBackend::new();
        // The head says 6. The first answer has a gap (start over from 0), the
        // second is a signed PREFIX of the log (epochs 1 to 3, the removal of emp-2
        // comes later): refused, the stored roster stays.
        fake.script_roster(Ok(RosterFetch::Entries {
            epoch: 9,
            entries: vec![roster_entry(&key, "org-1", "grp-1", 9, "emp-9", Some(1))],
        }));
        fake.script_roster(Ok(RosterFetch::Entries {
            epoch: 3,
            entries: vec![
                roster_entry(&key, "org-1", "grp-1", 1, "emp-1", Some(1)),
                roster_entry(&key, "org-1", "grp-1", 2, "emp-2", Some(1)),
                roster_entry(&key, "org-1", "grp-1", 3, "emp-3", Some(1)),
            ],
        }));
        let (cancel, handle) = rig.start(&fake);
        let env = envelope(&key, "org-1", "dev-1", 1, &grouped_doc(1, "grp-1"));
        fake.store_body(1, Ok(env.clone()));
        fake.push(FakeBackend::head_event(&env, 6, FakeBackend::test_keys()));
        settle().await;
        assert_eq!(fake.roster_calls(), [5, 0, 3]);
        assert_eq!(RosterState::load(&rig.ctx.paths.roster()), stored);

        // An unsigned head that names a LOWER epoch changes nothing and fetches nothing.
        fake.push(FakeBackend::head_event(&env, 2, FakeBackend::test_keys()));
        settle().await;
        assert_eq!(fake.roster_calls().len(), 3);
        assert_eq!(RosterState::load(&rig.ctx.paths.roster()), stored);
        stop(cancel, handle).await;
    }

    #[tokio::test]
    async fn save_roster_refuses_a_lower_epoch() {
        let rig = Rig::new();
        std::fs::create_dir_all(rig.ctx.paths.state_dir()).unwrap();
        let at = |epoch: u64| RosterState { group_id: Some("grp-1".into()), epoch, ..RosterState::default() };
        let mut fetcher = Fetcher::new(at(5));
        assert_eq!(fetcher.save_roster(&rig.ctx, at(3)), Err(RosterError::Rollback { floor: 5, got: 3 }));
        assert_eq!(fetcher.roster.epoch, 5);
        assert!(!rig.ctx.paths.roster().exists(), "nothing was written");
        assert_eq!(fetcher.save_roster(&rig.ctx, at(6)), Ok(()));
        assert_eq!(RosterState::load(&rig.ctx.paths.roster()).epoch, 6);
        // Clearing the group (a document without one) keeps the floor.
        let cleared = fetcher.roster.restarted(None);
        assert_eq!(fetcher.save_roster(&rig.ctx, cleared), Ok(()));
        assert_eq!(fetcher.roster.group_id, None);
        assert_eq!(fetcher.save_roster(&rig.ctx, at(2)), Err(RosterError::Rollback { floor: 6, got: 2 }));
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

    fn head(version: u64, interval_ms: u64, nonce: u64, fast_until: u64) -> BackendEvent {
        let env = envelope(&test_key(), "org-1", "dev-1", version, &doc(version, true));
        let BackendEvent::Desired(DesiredFetch::Ok { head: Some(mut head), keys, retired_key_ids }) =
            FakeBackend::head_event(&env, 0, FakeBackend::test_keys())
        else {
            unreachable!()
        };
        head.ping_interval_ms = interval_ms;
        head.ping_nonce = nonce;
        head.fast_until = fast_until;
        BackendEvent::Desired(DesiredFetch::Ok { head: Some(head), keys, retired_key_ids })
    }

    const OLD: &str = "abababababababababababababababababababababababababababababababab";

    fn with_old_secret(rig: &Rig) {
        rig.ctx.shared.update_secrets(|s| s.device_secret = Some(OLD.to_string())).unwrap();
    }

    fn secrets(rig: &Rig) -> (Option<String>, Option<String>) {
        rig.ctx.shared.secrets(|s| (s.device_secret.clone(), s.rotating_device_secret.clone())).unwrap()
    }

    #[tokio::test(start_paused = true)]
    async fn ping_interval_comes_from_head() {
        let rig = Rig::new();
        let fake = FakeBackend::new();
        let (cancel, handle) = rig.start(&fake);
        // Two hours from the head; the ping answers say 30 minutes, which loses.
        fake.push(head(1, 7_200_000, 0, 0));
        fake.push(BackendEvent::Connection(ConnectionStatus::Online));
        fake.wait_for_pings(1).await;
        let first = fake.ping_calls()[0].at;
        tokio::time::sleep(Duration::from_secs(6_000)).await;
        settle().await;
        assert_eq!(fake.ping_calls().len(), 1, "not after 30 minutes");
        tokio::time::sleep(Duration::from_secs(1_300)).await;
        fake.wait_for_pings(2).await;
        let gap = fake.ping_calls()[1].at - first;
        assert!(gap >= Duration::from_secs(6_480) && gap <= Duration::from_secs(7_920), "{gap:?}");
        // The pings carry no status: that is the report's job.
        assert!(fake.report_calls().iter().all(|r| r.batch.audit.is_empty()));
        stop(cancel, handle).await;
    }

    #[tokio::test(start_paused = true)]
    async fn nonce_change_pings_once() {
        let rig = Rig::new();
        let fake = FakeBackend::new();
        let (cancel, handle) = rig.start(&fake);
        fake.push(head(1, 1_800_000, 4, 0));
        fake.push(BackendEvent::Connection(ConnectionStatus::Online));
        fake.wait_for_pings(1).await;
        tokio::time::sleep(Duration::from_secs(600)).await;
        settle().await;
        assert_eq!(fake.ping_calls().len(), 1);
        // "Check now": the nonce moves; one ping within 0-5 s.
        let asked = Instant::now();
        fake.push(head(1, 1_800_000, 5, 0));
        fake.wait_for_pings(2).await;
        assert!(fake.ping_calls()[1].at - asked <= Duration::from_secs(5));
        // The same nonce again (another head change): no extra ping.
        fake.push(head(1, 1_800_000, 5, 0));
        tokio::time::sleep(Duration::from_secs(600)).await;
        settle().await;
        assert_eq!(fake.ping_calls().len(), 2);
        stop(cancel, handle).await;
    }

    #[tokio::test(start_paused = true)]
    async fn fast_until_pings_every_minute_then_stops() {
        let rig = Rig::new();
        let fake = FakeBackend::new();
        let (cancel, handle) = rig.start(&fake);
        // Watched for five minutes from now (server clock = this clock here).
        fake.push(head(1, 1_800_000, 0, START_MS + 300_000));
        fake.push(BackendEvent::Connection(ConnectionStatus::Online));
        fake.wait_for_pings(1).await;
        for minute in 1..=4u64 {
            rig.clock.store(START_MS + minute * 60_000, Ordering::SeqCst);
            tokio::time::sleep(Duration::from_secs(60)).await;
            fake.wait_for_pings(1 + minute as usize).await;
        }
        // Past `fastUntil`: back to the 30-minute interval.
        rig.clock.store(START_MS + 360_000, Ordering::SeqCst);
        tokio::time::sleep(Duration::from_secs(61)).await;
        settle().await;
        let after = fake.ping_calls().len();
        tokio::time::sleep(Duration::from_secs(20 * 60)).await;
        settle().await;
        assert_eq!(fake.ping_calls().len(), after, "no more minute pings");
        stop(cancel, handle).await;
    }

    #[tokio::test(start_paused = true)]
    async fn first_ping_after_outage_is_delayed() {
        let rig = Rig::new();
        // The jitter answers 200 s, capped by each wait's own maximum.
        rig.jitter_ms.store(200_000, Ordering::SeqCst);
        let fake = FakeBackend::new();
        let (cancel, handle) = rig.start(&fake);
        let t0 = Instant::now();
        fake.push(BackendEvent::Connection(ConnectionStatus::Online));
        fake.wait_for_pings(1).await;
        assert!(fake.ping_calls()[0].at - t0 <= Duration::from_secs(10), "a short first wait");
        fake.push(BackendEvent::Connection(ConnectionStatus::Offline));
        settle().await;
        tokio::time::sleep(Duration::from_secs(600)).await;
        let back = Instant::now();
        fake.push(BackendEvent::Connection(ConnectionStatus::Online));
        tokio::time::sleep(Duration::from_secs(119)).await;
        settle().await;
        assert_eq!(fake.ping_calls().len(), 1, "not before 120 s after a 10-minute outage");
        fake.wait_for_pings(2).await;
        assert!(fake.ping_calls()[1].at - back <= Duration::from_secs(121));
        stop(cancel, handle).await;
    }

    #[tokio::test(start_paused = true)]
    async fn a_failed_ping_backs_off_and_never_spins() {
        let rig = Rig::new();
        rig.jitter_ms.store(u64::MAX, Ordering::SeqCst);
        let fake = FakeBackend::new();
        for _ in 0..3 {
            fake.script_ping(Err(BackendError::Timeout));
        }
        let (cancel, handle) = rig.start(&fake);
        fake.push(BackendEvent::Connection(ConnectionStatus::Online));
        fake.wait_for_pings(4).await;
        let at: Vec<Instant> = fake.ping_calls().iter().map(|c| c.at).collect();
        // Full jitter at its maximum: 5, 10, 20 s.
        assert_eq!(at[1] - at[0], Duration::from_secs(5));
        assert_eq!(at[2] - at[1], Duration::from_secs(10));
        assert_eq!(at[3] - at[2], Duration::from_secs(20));
        stop(cancel, handle).await;
    }

    #[tokio::test(start_paused = true)]
    async fn plan_state_over_limit_changes_nothing() {
        let rig = Rig::new();
        let fake = FakeBackend::new();
        fake.script_ping(Ok(PingResponse { plan_state: "suspended".into(), ..crate::backend::fake::ping_ok(1_800_000) }));
        let (cancel, handle) = rig.start(&fake);
        push_doc(&fake, 1, doc(1, true));
        fake.push(BackendEvent::Connection(ConnectionStatus::Online));
        fake.wait_for_pings(1).await;
        settle().await;
        // The document stays and nothing is disabled.
        assert_eq!(rig.snapshot().desired_state_version, 1);
        assert_eq!(rig.control.disables.load(Ordering::SeqCst), 0);
        stop(cancel, handle).await;
    }

    #[tokio::test(start_paused = true)]
    async fn rotation_happy_path() {
        let rig = Rig::new();
        with_old_secret(&rig);
        let fake = FakeBackend::new();
        fake.script_ping(Ok(PingResponse { rotate_credential: true, ..crate::backend::fake::ping_ok(1_800_000) }));
        let (cancel, handle) = rig.start(&fake);
        fake.push(BackendEvent::Connection(ConnectionStatus::Online));
        fake.wait_until("the second subscription", |f| f.subscriptions().len() >= 2).await;
        let (auth, hash) = fake.rotate_calls()[0].clone();
        // Asked with the OLD secret; only the hash of the new one travelled.
        assert_eq!(auth.device_secret, OLD);
        let (current, pending) = secrets(&rig);
        let new = current.unwrap();
        assert_ne!(new, OLD);
        assert_eq!((new.len(), pending), (64, None));
        assert_eq!(hash, sha256_hex(&new));
        // The subscription and the link use the new secret now.
        assert_eq!(fake.subscriptions()[1].device_secret, new);
        assert_eq!(rig.ctx.link.get().unwrap().1.device_secret, new);
        stop(cancel, handle).await;
        assert!(rig.ctx.link.get().is_none(), "the link is cleared when the task stops");
    }

    #[tokio::test(start_paused = true)]
    async fn rotation_lost_answer_recovers_at_start() {
        let rig = Rig::new();
        with_old_secret(&rig);
        let fake = FakeBackend::new();
        fake.script_ping(Ok(PingResponse { rotate_credential: true, ..crate::backend::fake::ping_ok(1_800_000) }));
        fake.script_rotate(Err(BackendError::Timeout));
        let (cancel, handle) = rig.start(&fake);
        fake.push(BackendEvent::Connection(ConnectionStatus::Online));
        fake.wait_until("a rotation", |f| !f.rotate_calls().is_empty()).await;
        settle().await;
        // The answer was lost: both secrets are kept, the old one still in use.
        let (current, pending) = secrets(&rig);
        assert_eq!(current.as_deref(), Some(OLD));
        let pending = pending.expect("the new secret is kept");
        stop(cancel, handle).await;

        // The agent restarts: the same hash is sent again with the old secret
        // (the server answers ok), and the new secret is adopted.
        let fake = FakeBackend::new();
        let (cancel, handle) = rig.start(&fake);
        fake.wait_until("the rotation at start", |f| f.subscriptions().len() >= 2).await;
        let (auth, hash) = fake.rotate_calls()[0].clone();
        assert_eq!((auth.device_secret.as_str(), hash), (OLD, sha256_hex(&pending)));
        assert_eq!(secrets(&rig), (Some(pending), None));
        stop(cancel, handle).await;
    }

    #[tokio::test(start_paused = true)]
    async fn rotation_conflict_keeps_the_old_secret_and_stops_rotating() {
        let rig = Rig::new();
        with_old_secret(&rig);
        let fake = FakeBackend::new();
        let rotate = || Ok(PingResponse { rotate_credential: true, ..crate::backend::fake::ping_ok(60_000) });
        fake.script_ping(rotate());
        fake.script_rotate(Err(BackendError::Rejected { code: "conflict".into() }));
        // The probe with the pending secret: the server does not know it.
        fake.script_ping(Err(BackendError::Rejected { code: "device_rejected".into() }));
        fake.script_ping(rotate());
        let (cancel, handle) = rig.start(&fake);
        fake.push(BackendEvent::Connection(ConnectionStatus::Online));
        fake.wait_for_pings(3).await;
        settle().await;
        assert_eq!(secrets(&rig), (Some(OLD.to_string()), None));
        assert!(fake.ping_calls()[1].auth.device_secret != OLD, "the probe used the pending secret");
        // Asked again: no new rotation from this task (no `conflict` loop).
        assert_eq!(fake.rotate_calls().len(), 1);
        assert!(rig.ctx.shared.get().enrollment.unwrap().revoked.eq(&false));
        stop(cancel, handle).await;
    }

    #[tokio::test(start_paused = true)]
    async fn rotation_not_ready_drops_the_new_secret_and_keeps_working() {
        let rig = Rig::new();
        with_old_secret(&rig);
        let fake = FakeBackend::new();
        let rotate = || Ok(PingResponse { rotate_credential: true, ..crate::backend::fake::ping_ok(60_000) });
        fake.script_ping(rotate());
        fake.script_ping(rotate());
        fake.script_rotate(Err(BackendError::Rejected { code: "not_ready".into() }));
        let (cancel, handle) = rig.start(&fake);
        fake.push(BackendEvent::Connection(ConnectionStatus::Online));
        fake.wait_for_pings(2).await;
        settle().await;
        assert_eq!(secrets(&rig), (Some(OLD.to_string()), None));
        assert_eq!(fake.rotate_calls().len(), 1);
        assert_eq!(fake.subscriptions().len(), 1);
        stop(cancel, handle).await;
    }

    #[tokio::test(start_paused = true)]
    async fn unknown_device_during_rotation_is_not_revocation() {
        let rig = Rig::new();
        with_old_secret(&rig);
        let pending = "cd".repeat(32);
        rig.ctx.shared.update_secrets(|s| s.rotating_device_secret = Some(pending.clone())).unwrap();
        let fake = FakeBackend::new();
        // The rotation at start gets no answer.
        fake.script_rotate(Err(BackendError::Timeout));
        let (cancel, handle) = rig.start(&fake);
        fake.wait_until("the rotation at start", |f| !f.rotate_calls().is_empty()).await;
        // The server already uses the new secret: the old one is unknown to it.
        fake.push(BackendEvent::Desired(DesiredFetch::UnknownDevice));
        fake.wait_until("the second subscription", |f| f.subscriptions().len() >= 2).await;
        assert!(!rig.ctx.shared.get().enrollment.unwrap().revoked);
        assert_eq!(rig.snapshot().enrollment, EnrollmentStatus::Enrolled);
        assert_eq!(secrets(&rig), (Some(pending.clone()), None));
        assert_eq!(fake.subscriptions()[1].device_secret, pending);
        stop(cancel, handle).await;

        // Both secrets unknown: that is a revocation.
        let rig = Rig::new();
        with_old_secret(&rig);
        rig.ctx.shared.update_secrets(|s| s.rotating_device_secret = Some(pending.clone())).unwrap();
        let fake = FakeBackend::new();
        fake.script_rotate(Err(BackendError::Timeout));
        fake.reject_secret(&pending);
        let (_cancel, handle) = rig.start(&fake);
        fake.wait_until("the rotation at start", |f| !f.rotate_calls().is_empty()).await;
        fake.push(BackendEvent::Desired(DesiredFetch::UnknownDevice));
        tokio::time::timeout(Duration::from_secs(5), handle).await.unwrap().unwrap();
        assert!(rig.ctx.shared.get().enrollment.unwrap().revoked);
        // The old secret is never thrown away by a revocation.
        assert_eq!(secrets(&rig).0.as_deref(), Some(OLD));
    }

    fn asks_to_rotate(next_ping_in_ms: u64) -> Result<PingResponse, BackendError> {
        Ok(PingResponse { rotate_credential: true, ..crate::backend::fake::ping_ok(next_ping_in_ms) })
    }

    fn conflict() -> Result<(), BackendError> {
        Err(BackendError::Rejected { code: "conflict".into() })
    }

    /// Pings made with the OLD secret (the ordinary ones), as opposed to checks of
    /// the pending secret.
    fn ordinary_pings(fake: &FakeBackend) -> usize {
        fake.ping_calls().iter().filter(|call| call.auth.device_secret == OLD).count()
    }

    fn pending_pings(fake: &FakeBackend) -> usize {
        fake.ping_calls().iter().filter(|call| call.auth.device_secret != OLD).count()
    }

    /// The cloned-image case: another copy of this PC rotated first, so the server
    /// answers `conflict`, and it never heard of OUR pending secret.
    fn cloned_image(fake: &FakeBackend) {
        for _ in 0..400 {
            fake.script_ping(asks_to_rotate(60_000));
        }
        for _ in 0..4 {
            fake.script_rotate(conflict());
        }
        fake.accept_only(&[OLD]);
    }

    /// The hour between rotation attempts would hide a missing single-flight rule
    /// in these tests: switch it off (this test thread only).
    fn no_rotation_gap() {
        TEST_GAP.with(|gap| gap.set(Some(Duration::ZERO)));
    }

    fn assert_enrolled_on_old_secret(rig: &Rig) {
        assert!(!rig.ctx.shared.get().enrollment.unwrap().revoked, "a conflict is not a revocation");
        assert_eq!(rig.snapshot().enrollment, EnrollmentStatus::Enrolled);
        assert_eq!(secrets(rig), (Some(OLD.to_string()), None));
    }

    #[tokio::test(start_paused = true)]
    async fn a_ping_that_succeeds_while_the_conflict_check_runs_starts_no_second_rotation() {
        no_rotation_gap();
        let rig = Rig::new();
        with_old_secret(&rig);
        let fake = FakeBackend::new();
        cloned_image(&fake);
        // The check of the pending secret is slow (ten minutes).
        fake.delay_pings_except(OLD, Duration::from_secs(600));
        let (cancel, handle) = rig.start(&fake);
        fake.push(BackendEvent::Connection(ConnectionStatus::Online));
        fake.wait_until("the conflict", |f| !f.rotate_calls().is_empty()).await;
        fake.wait_until("a check of the pending secret", |f| pending_pings(f) == 1).await;
        // Ordinary pings keep succeeding (each asks to rotate) while the check runs.
        let before = ordinary_pings(&fake);
        tokio::time::sleep(Duration::from_secs(300)).await;
        settle().await;
        assert!(ordinary_pings(&fake) >= before + 4, "ordinary pings went on");
        assert_eq!(fake.rotate_calls().len(), 1, "no second rotation while the check is out");
        assert_eq!(pending_pings(&fake), 1, "and no second check");

        // The check ends: the server does not know the pending secret.
        tokio::time::sleep(Duration::from_secs(700)).await;
        settle().await;
        assert_enrolled_on_old_secret(&rig);
        assert_eq!(fake.rotate_calls().len(), 1);
        assert_eq!(fake.subscriptions().len(), 1);
        assert!(!handle.is_finished(), "the task keeps running");
        // The device keeps working on the old secret.
        let now = ordinary_pings(&fake);
        tokio::time::sleep(Duration::from_secs(600)).await;
        settle().await;
        assert!(ordinary_pings(&fake) > now);
        assert_eq!(fake.rotate_calls().len(), 1, "blocked after the conflict");
        stop(cancel, handle).await;
    }

    #[tokio::test(start_paused = true)]
    async fn two_conflicts_back_to_back_never_revoke_the_device() {
        no_rotation_gap();
        let rig = Rig::new();
        with_old_secret(&rig);
        let fake = FakeBackend::new();
        cloned_image(&fake);
        // The checks get no answer at first.
        fake.fail_pings_except(OLD, Some(BackendError::Timeout));
        let (cancel, handle) = rig.start(&fake);
        fake.push(BackendEvent::Connection(ConnectionStatus::Online));
        fake.wait_until("an unanswered check", |f| pending_pings(f) >= 1).await;
        tokio::time::sleep(Duration::from_secs(30)).await;
        settle().await;
        // The check was asked again, and ordinary pings succeeded meanwhile and asked to
        // rotate; the waiting check keeps them from starting a second rotation (which
        // would answer `conflict` again and overwrite the first check).
        assert!(pending_pings(&fake) >= 2);
        assert!(ordinary_pings(&fake) >= 2);
        assert_eq!(fake.rotate_calls().len(), 1);
        // The server answers now: the pending secret is not known to it.
        fake.fail_pings_except(OLD, None);
        tokio::time::sleep(Duration::from_secs(900)).await;
        settle().await;
        assert_enrolled_on_old_secret(&rig);
        assert_eq!(fake.rotate_calls().len(), 1);
        assert!(!handle.is_finished());
        stop(cancel, handle).await;
    }

    #[tokio::test(start_paused = true)]
    async fn a_cloned_image_ends_enrolled_and_working_on_the_old_secret() {
        no_rotation_gap();
        let rig = Rig::new();
        with_old_secret(&rig);
        let fake = FakeBackend::new();
        cloned_image(&fake);
        fake.delay_pings_except(OLD, Duration::from_secs(200));
        let (cancel, handle) = rig.start(&fake);
        fake.push(BackendEvent::Connection(ConnectionStatus::Online));
        tokio::time::sleep(Duration::from_secs(3 * 3600)).await;
        settle().await;
        assert_enrolled_on_old_secret(&rig);
        assert!(ordinary_pings(&fake) > 100, "still pinging");
        assert_eq!(fake.rotate_calls().len(), 1, "one attempt, then blocked");
        assert_eq!(pending_pings(&fake), 1);
        assert!(!handle.is_finished());
        stop(cancel, handle).await;

        // After a restart it is still the same enrolled device, and the one attempt
        // of the new run ends the same way.
        let fake = FakeBackend::new();
        cloned_image(&fake);
        let (cancel, handle) = rig.start(&fake);
        fake.push(BackendEvent::Connection(ConnectionStatus::Online));
        tokio::time::sleep(Duration::from_secs(3600)).await;
        settle().await;
        assert_enrolled_on_old_secret(&rig);
        assert_eq!(fake.rotate_calls().len(), 1);
        assert!(!handle.is_finished());
        stop(cancel, handle).await;
    }

    #[tokio::test(start_paused = true)]
    async fn the_subscription_reporting_unknown_during_a_conflict_check_asks_again_and_may_then_revoke() {
        // `unknownDevice` arrives while the check of the pending secret is out: the
        // check answers first; its refusal makes the subscription answer again, and
        // only that answer (for the secret in use, nothing pending) revokes.
        let rig = Rig::new();
        with_old_secret(&rig);
        let fake = FakeBackend::new();
        fake.script_ping(asks_to_rotate(60_000));
        fake.script_rotate(conflict());
        fake.accept_only(&[OLD]);
        fake.delay_pings_except(OLD, Duration::from_secs(300));
        let (cancel, handle) = rig.start(&fake);
        fake.push(BackendEvent::Connection(ConnectionStatus::Online));
        fake.wait_until("a check of the pending secret", |f| pending_pings(f) == 1).await;
        fake.push(BackendEvent::Desired(DesiredFetch::UnknownDevice));
        settle().await;
        assert_eq!(pending_pings(&fake), 1, "the running check is not joined by a second one");
        assert!(!rig.ctx.shared.get().enrollment.unwrap().revoked, "no verdict yet");
        // The check ends (refused): the subscription is started again.
        tokio::time::sleep(Duration::from_secs(310)).await;
        settle().await;
        assert_eq!(fake.subscriptions().len(), 2);
        assert!(!rig.ctx.shared.get().enrollment.unwrap().revoked);
        // It still says the device is unknown, and nothing is pending any more.
        fake.push(BackendEvent::Desired(DesiredFetch::UnknownDevice));
        tokio::time::timeout(Duration::from_secs(5), handle).await.unwrap().unwrap();
        assert!(rig.ctx.shared.get().enrollment.unwrap().revoked);
        drop(cancel);
    }

    #[tokio::test(start_paused = true)]
    async fn a_server_that_always_asks_for_a_rotation_gets_one_per_hour() {
        let rig = Rig::new();
        with_old_secret(&rig);
        let fake = FakeBackend::new();
        for _ in 0..400 {
            fake.script_ping(asks_to_rotate(60_000));
        }
        let (cancel, handle) = rig.start(&fake);
        fake.push(BackendEvent::Connection(ConnectionStatus::Online));
        fake.wait_until("the first rotation", |f| !f.rotate_calls().is_empty()).await;
        // Pings every minute all asking to rotate: nothing for almost an hour ...
        tokio::time::sleep(Duration::from_secs(58 * 60)).await;
        settle().await;
        assert_eq!(fake.rotate_calls().len(), 1);
        // ... then one more, and again nothing for the next hour.
        tokio::time::sleep(Duration::from_secs(5 * 60)).await;
        settle().await;
        assert_eq!(fake.rotate_calls().len(), 2);
        // Each was a real rotation with the secret then in use.
        let calls = fake.rotate_calls();
        assert_eq!(calls[0].0.device_secret, OLD);
        assert_ne!(calls[1].0.device_secret, OLD);
        stop(cancel, handle).await;
    }

    #[tokio::test(start_paused = true)]
    async fn a_pending_secret_is_retried_at_start_whatever_the_gap() {
        // The gap counts attempts of one run: a restart retries at once.
        let rig = Rig::new();
        with_old_secret(&rig);
        let pending = "cd".repeat(32);
        rig.ctx.shared.update_secrets(|s| s.rotating_device_secret = Some(pending.clone())).unwrap();
        for _ in 0..2 {
            let fake = FakeBackend::new();
            fake.script_rotate(Err(BackendError::Timeout));
            let (cancel, handle) = rig.start(&fake);
            fake.wait_until("the rotation at start", |f| f.rotate_calls().len() == 1).await;
            settle().await;
            // Not asked again by the pings of the same run within the hour.
            fake.push(BackendEvent::Connection(ConnectionStatus::Online));
            tokio::time::sleep(Duration::from_secs(1800)).await;
            settle().await;
            assert_eq!(fake.rotate_calls().len(), 1);
            stop(cancel, handle).await;
        }
    }

    #[tokio::test(start_paused = true)]
    async fn the_watch_window_is_bounded_when_the_local_clock_is_far_behind() {
        let rig = Rig::new();
        let fake = FakeBackend::new();
        let (cancel, handle) = rig.start(&fake);
        // `fastUntil` is ten days ahead of this PC's clock (or the clock is behind).
        let until = START_MS + 10 * 24 * 3_600_000;
        fake.push(head(1, 1_800_000, 0, until));
        fake.push(BackendEvent::Connection(ConnectionStatus::Online));
        fake.wait_for_pings(1).await;
        let t0 = Instant::now();
        // A repeat of the same head does not start the window again.
        tokio::time::sleep(Duration::from_secs(10 * 60)).await;
        fake.push(head(1, 1_800_000, 0, until));
        tokio::time::sleep(Duration::from_secs(6 * 60)).await;
        settle().await;
        let in_window = fake.ping_calls().len();
        assert!((14..=18).contains(&in_window), "about a ping a minute for 15 minutes, got {in_window}");
        // Past the 15 minutes: back to the regular interval, no more minute pings.
        assert!(Instant::now() - t0 > FAST_WINDOW_MAX);
        tokio::time::sleep(Duration::from_secs(20 * 60)).await;
        settle().await;
        assert_eq!(fake.ping_calls().len(), in_window);
        stop(cancel, handle).await;
    }

    #[tokio::test(start_paused = true)]
    async fn the_watch_window_uses_the_server_clock_when_it_is_known() {
        let rig = Rig::new();
        let fake = FakeBackend::new();
        // This PC is three days behind the server, which says so in its ping answer.
        let server_now = START_MS as i64 + 3 * 24 * 3_600_000;
        fake.script_ping(Ok(PingResponse { server_time_ms: Some(server_now), ..crate::backend::fake::ping_ok(1_800_000) }));
        let (cancel, handle) = rig.start(&fake);
        fake.push(BackendEvent::Connection(ConnectionStatus::Online));
        fake.wait_for_pings(1).await;
        settle().await;
        assert_eq!(rig.snapshot().server_time_offset_ms, Some(3 * 24 * 3_600_000));
        // Watched for three more minutes by the SERVER's clock.
        fake.push(head(1, 1_800_000, 0, server_now as u64 + 180_000));
        settle().await;
        tokio::time::sleep(Duration::from_secs(5 * 60)).await;
        settle().await;
        let in_window = fake.ping_calls().len();
        assert!((3..=5).contains(&in_window), "got {in_window}");
        tokio::time::sleep(Duration::from_secs(20 * 60)).await;
        settle().await;
        assert_eq!(fake.ping_calls().len(), in_window);
        stop(cancel, handle).await;
    }

    #[tokio::test(start_paused = true)]
    async fn the_offset_is_cleared_when_the_server_stops_sending_its_time() {
        let rig = Rig::new();
        let fake = FakeBackend::new();
        fake.script_ping(Ok(PingResponse {
            server_time_ms: Some(START_MS as i64 + 60_000),
            ..crate::backend::fake::ping_ok(60_000)
        }));
        let (cancel, handle) = rig.start(&fake);
        fake.push(BackendEvent::Connection(ConnectionStatus::Online));
        fake.wait_for_pings(1).await;
        settle().await;
        assert_eq!(rig.snapshot().server_time_offset_ms, Some(60_000));
        // The next answer carries no time (an older server): no stale offset stays.
        fake.wait_for_pings(2).await;
        settle().await;
        assert_eq!(rig.snapshot().server_time_offset_ms, None);
        stop(cancel, handle).await;
    }

    #[tokio::test(start_paused = true)]
    async fn the_roster_reaches_the_session_layer_only_after_its_checks() {
        let rig = Rig::new();
        let key = test_key();
        let mut roster_rx = rig.ctx.roster_tx.subscribe();
        let fake = FakeBackend::new();
        fake.script_roster(Ok(RosterFetch::Entries {
            epoch: 1,
            entries: vec![roster_entry(&key, "org-1", "grp-1", 1, "emp-1", Some(1))],
        }));
        let (cancel, handle) = rig.start(&fake);
        let env = envelope(&key, "org-1", "dev-1", 1, &grouped_doc(1, "grp-1"));
        fake.store_body(1, Ok(env.clone()));
        fake.push(FakeBackend::head_event(&env, 1, FakeBackend::test_keys()));
        settle().await;
        let published = roster_rx.borrow_and_update().clone();
        assert_eq!((published.epoch, published.members.len()), (1, 1));
        // A forged entry is refused: nothing new is published.
        let mut forged = roster_entry(&key, "org-1", "grp-1", 2, "emp-1", None);
        forged.employee_id = "emp-2".into();
        fake.script_roster(Ok(RosterFetch::Entries { epoch: 2, entries: vec![forged.clone()] }));
        fake.script_roster(Ok(RosterFetch::Entries { epoch: 2, entries: vec![forged] }));
        fake.push(FakeBackend::head_event(&env, 2, FakeBackend::test_keys()));
        settle().await;
        assert!(!roster_rx.has_changed().unwrap());
        assert_eq!(roster_rx.borrow().epoch, 1);
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
        fake.script_ping(Ok(PingResponse {
            server_time_ms: Some((START_MS - 3 * 86_400_000) as i64),
            ..crate::backend::fake::ping_ok(300_000)
        }));
        let (cancel, handle) = rig.start(&fake);
        fake.push(BackendEvent::Connection(ConnectionStatus::Online));
        fake.wait_for_pings(1).await;
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
        // (A12) `[60 s, 6 h]`.
        assert_eq!(ping_delay(&rig.ctx, 1), Duration::from_millis(54_000));
        assert_eq!(ping_delay(&rig.ctx, u64::MAX), Duration::from_millis(19_440_000));
    }

    #[test]
    fn os_jitter_is_in_range() {
        for _ in 0..200 {
            assert!(os_jitter(10) <= 10);
        }
        assert_eq!(os_jitter(0), 0);
    }
}
