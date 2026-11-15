//! (Phase 5 Step 12, plan 4.12, 4.13 and 4.17) The agent's side of what the Staff App shows
//! and reports in protocol 1.3: the **broadcast list** of the snapshot, the **acknowledgement
//! queue**, and the two requests `broadcast.acknowledge` and `webapp.reportDenials`.
//!
//! * The device lock itself reaches the snapshot through `AgentPolicy::apply_to_snapshot`; the
//!   hub only tells the clients (`device.lockChanged`) when it changes. What the agent *does*
//!   about a lock (Step 15): `SessionManager::on_policy` ends the session and refuses sign-in,
//!   `AgentState.device_lock` keeps it across restarts, offline periods and revocations.
//! * Broadcasts expire by **server time** (the device clock plus the offset learned at ping
//!   time, plan 4.16), so a PC whose clock is two days wrong still drops them on time. The agent
//!   removes an expired one from the snapshot itself; `broadcasts.changed` goes out at most once
//!   per [`EVENT_GAP`].
//! * An acknowledgement is queued once per broadcast, on disk (`broadcast-acks.json`), as
//!   `{ broadcastId, atMs }`, the exact entry of `deviceApi:reportAcks`. [`run_ack_sender`] sends
//!   the queue (Step 15): one call per flush, at most [`MAX_ACKS_PER_CALL`] entries, when a flush
//!   is asked for ([`NoticeHub::flush_acks_now`], the apply report path of Step 20) or
//!   [`ACK_FLUSH_AFTER`] after the first one was queued, whichever comes first, only while online.
//!   No employee is ever recorded.
//! * Denial counters from the Staff App are untrusted input: the app must be in the device
//!   catalogue, the kind one of the eight permission names, unknown entries are dropped, one
//!   call carries at most 100 entries and 10,000 per entry. They are added to the daily security
//!   counters of `lockdown::daily` (never the page, origin or time, plan rule 6).

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::future::BoxFuture;
use futures_util::FutureExt;
use rulebox_ipc::methods::{BroadcastAcknowledge, Method, WebappReportDenials};
use rulebox_ipc::requests::{
    BroadcastAckParams, OkResult, ReportDenialsParams, MAX_DENIAL_COUNT, MAX_DENIAL_ENTRIES, PERMISSION_KINDS,
};
use rulebox_ipc::types::{AgentSnapshot, BroadcastView, ConnectionStatus, EnrollmentStatus};
use rulebox_ipc::{ErrorCode, RpcError, CAP_BROADCASTS, CAP_DEVICE_LOCK, CAP_KEYBOARD_POLICY, CAP_PERMISSION_REPORTS};
use rulebox_policy::lockdown::MAX_ID_CHARS;
use rulebox_policy::notice::{Broadcast, MAX_ACTIVE_BROADCASTS};
use serde::{Deserialize, Serialize};
use tokio::sync::{watch, Notify};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use crate::agent_policy::AgentPolicy;
use crate::backend::reports::LockdownCall;
use crate::backend::{BackendError, BackendLink};
use crate::ipc_conn::{rpc_error, PeerCtx};
use crate::ipc_shell::{ShellBroadcast, ShellExtension};
use crate::lockdown::daily::server_day;
#[cfg(test)]
use crate::lockdown::daily::DailyCounters;
use crate::report::backoff_delay;
use crate::state::{lock, read_json, write_atomic, SnapshotHandle};

/// `broadcasts.changed` goes out at most this often (plan 4.12).
pub const EVENT_GAP: Duration = Duration::from_secs(2);
/// The hub looks at the clock again at least this often (a clock that moved, a very distant expiry).
const MAX_SLEEP: Duration = Duration::from_secs(3_600);
/// Acknowledgement records kept on disk: far more than the five active broadcasts can need.
pub const MAX_ACK_RECORDS: usize = 100;
/// Entries in one `deviceApi:reportAcks` call (`MAX_ACKS_PER_CALL` of `convex/lib/limits.ts`).
pub const MAX_ACKS_PER_CALL: usize = 20;
/// An acknowledgement waits at most this long for an apply report to carry it (plan 4.17).
pub const ACK_FLUSH_AFTER: Duration = Duration::from_secs(600);
/// After the server refused the call, ask again no sooner than this.
const ACK_REJECTED_RETRY: Duration = Duration::from_secs(3_600);

// ---------------------------------------------------------------- the broadcast list

/// Pure: the broadcasts the snapshot shows at `server_now_ms`: not expired, newest first, at most
/// five, each id once. `acked` is the set of ids this PC has queued an acknowledgement for.
pub fn broadcast_views(list: &[Broadcast], acked: &HashSet<String>, server_now_ms: u64) -> Vec<BroadcastView> {
    let mut seen = HashSet::new();
    let mut active: Vec<&Broadcast> =
        list.iter().filter(|broadcast| broadcast.is_active(server_now_ms) && seen.insert(broadcast.id.as_str())).collect();
    // Stable: broadcasts issued at the same moment keep the document's order.
    active.sort_by_key(|broadcast| std::cmp::Reverse(broadcast.issued_at_ms));
    active
        .into_iter()
        .take(MAX_ACTIVE_BROADCASTS)
        .map(|broadcast| BroadcastView {
            id: broadcast.id.clone(),
            style: broadcast.style,
            title: broadcast.title.clone(),
            body: broadcast.body.clone(),
            ack_required: broadcast.ack_required,
            acknowledged: acked.contains(&broadcast.id),
        })
        .collect()
}

/// Pure: the earliest expiry (server time) above `server_now_ms`, if any broadcast has one.
pub fn next_expiry_ms(list: &[Broadcast], server_now_ms: u64) -> Option<u64> {
    list.iter().filter_map(|broadcast| broadcast.expires_at_ms).filter(|expires| *expires > server_now_ms).min()
}

// ---------------------------------------------------------------- acknowledgements

/// One acknowledgement as `deviceApi:reportAcks` takes it. `at_ms` is server time.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Ack {
    pub broadcast_id: String,
    pub at_ms: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
struct AckRecord {
    broadcast_id: String,
    at_ms: u64,
    /// The server has it.
    sent: bool,
}

#[derive(Serialize, Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
struct AckFile {
    schema: u32,
    acks: Vec<AckRecord>,
}

/// `broadcast-acks.json`: what the employees pressed "OK" on, until the server has it.
pub struct AckQueue {
    path: PathBuf,
    file: AckFile,
}

impl AckQueue {
    /// A missing file is empty; a corrupt one is set aside by `read_json`.
    pub fn open(path: PathBuf) -> std::io::Result<Self> {
        let mut file = read_json::<AckFile>(&path)?.unwrap_or_default();
        file.schema = 1;
        Ok(Self { path, file })
    }

    fn save(&self) {
        let saved = serde_json::to_vec_pretty(&self.file)
            .map_err(std::io::Error::other)
            .and_then(|bytes| write_atomic(&self.path, &bytes));
        if let Err(error) = saved {
            tracing::error!("cannot save broadcast-acks.json: {error}");
        }
    }

    pub fn contains(&self, broadcast_id: &str) -> bool {
        self.file.acks.iter().any(|record| record.broadcast_id == broadcast_id)
    }

    /// The ids that have a record, sent or not.
    pub fn acknowledged(&self) -> HashSet<String> {
        self.file.acks.iter().map(|record| record.broadcast_id.clone()).collect()
    }

    /// Queues one acknowledgement. `false` when the broadcast already has one (a second "OK" on
    /// another monitor or after a restart writes nothing).
    pub fn queue(&mut self, broadcast_id: &str, at_ms: u64) -> bool {
        if self.contains(broadcast_id) {
            return false;
        }
        if self.file.acks.len() >= MAX_ACK_RECORDS {
            // Room: the oldest record the server already has, else the oldest of all.
            let at = self.file.acks.iter().position(|record| record.sent).unwrap_or(0);
            self.file.acks.remove(at);
        }
        self.file.acks.push(AckRecord { broadcast_id: broadcast_id.to_string(), at_ms, sent: false });
        self.save();
        true
    }

    /// The acknowledgements the server has not taken yet, oldest first, at most one call's worth.
    pub fn pending(&self) -> Vec<Ack> {
        self.file
            .acks
            .iter()
            .filter(|record| !record.sent)
            .take(MAX_ACKS_PER_CALL)
            .map(|record| Ack { broadcast_id: record.broadcast_id.clone(), at_ms: record.at_ms })
            .collect()
    }

    /// The server took these.
    pub fn mark_sent(&mut self, ids: &[String]) {
        let mut changed = false;
        for record in &mut self.file.acks {
            if !record.sent && ids.contains(&record.broadcast_id) {
                record.sent = true;
                changed = true;
            }
        }
        if changed {
            self.save();
        }
    }

    /// Drops the records the server has of broadcasts that are no longer in the document: they
    /// can never be shown again, so the flag is not needed. Unsent ones stay until sent.
    pub fn prune(&mut self, listed: &HashSet<&str>) {
        let before = self.file.acks.len();
        self.file.acks.retain(|record| !record.sent || listed.contains(record.broadcast_id.as_str()));
        if self.file.acks.len() != before {
            self.save();
        }
    }

    /// Unenroll: the acknowledgements belong to the organization the PC is leaving.
    pub fn clear(&mut self) -> std::io::Result<()> {
        self.file = AckFile { schema: 1, ..AckFile::default() };
        crate::state::remove_file_if_exists(&self.path)
    }
}

// ---------------------------------------------------------------- the event gate

/// "At most one event per [`EVENT_GAP`]": the first change goes out at once, a change inside the
/// gap is held and goes out when the gap is over (so the last state is always announced).
#[derive(Debug, Default)]
pub struct EventGate {
    last: Option<Instant>,
    held: bool,
}

impl EventGate {
    /// A change happened. `true` = send the event now.
    pub fn offer(&mut self, now: Instant) -> bool {
        match self.last {
            Some(last) if now.duration_since(last) < EVENT_GAP => {
                self.held = true;
                false
            }
            _ => {
                self.last = Some(now);
                self.held = false;
                true
            }
        }
    }

    /// When a held-back event may go out.
    pub fn due(&self) -> Option<Instant> {
        if self.held {
            self.last.map(|last| last + EVENT_GAP)
        } else {
            None
        }
    }

    /// `true` when a held-back event is due at `now` (and records it as sent).
    pub fn take_due(&mut self, now: Instant) -> bool {
        match self.due() {
            Some(due) if now >= due => {
                self.held = false;
                self.last = Some(now);
                true
            }
            _ => false,
        }
    }
}

// ---------------------------------------------------------------- the hub

struct HubState {
    list: Vec<Broadcast>,
    lock_id: Option<String>,
    acks: AckQueue,
    gate: EventGate,
}

/// Owns the snapshot's `broadcasts`, the acknowledgement queue and the two events.
pub struct NoticeHub {
    state: Mutex<HubState>,
    snapshot: SnapshotHandle,
    events: ShellBroadcast,
    now_ms: Arc<dyn Fn() -> u64 + Send + Sync>,
    /// A new acknowledgement was queued, or a flush was asked for: [`run_ack_sender`] looks again.
    ack_wake: Notify,
    /// Send the queue now (an apply report is going out, plan 4.17) instead of waiting for [`ACK_FLUSH_AFTER`].
    flush_requested: AtomicBool,
}

impl NoticeHub {
    pub fn new(
        acks: AckQueue,
        snapshot: SnapshotHandle,
        events: ShellBroadcast,
        now_ms: Arc<dyn Fn() -> u64 + Send + Sync>,
    ) -> Arc<Self> {
        let state = HubState { list: Vec::new(), lock_id: None, acks, gate: EventGate::default() };
        Arc::new(Self {
            state: Mutex::new(state),
            snapshot,
            events,
            now_ms,
            ack_wake: Notify::new(),
            flush_requested: AtomicBool::new(false),
        })
    }

    /// The server's clock: the device's plus the offset the agent learned (none yet = trusted).
    fn server_now_ms(&self) -> u64 {
        let offset = self.snapshot.current().server_time_offset_ms.unwrap_or(0);
        (self.now_ms)().saturating_add_signed(offset)
    }

    /// A new policy: the lock, the broadcast list and the acknowledgements of what is gone.
    pub fn on_policy(&self, policy: &AgentPolicy) {
        let lock_changed = {
            let mut guard = lock(&self.state);
            // Disjoint fields of one struct: the list is read while the queue is changed.
            let state = &mut *guard;
            state.list = policy.broadcasts.clone();
            let listed: HashSet<&str> = state.list.iter().map(|broadcast| broadcast.id.as_str()).collect();
            state.acks.prune(&listed);
            let new_id = policy.device_lock.as_ref().map(|device_lock| device_lock.lock_id.clone());
            let changed = state.lock_id != new_id;
            state.lock_id = new_id;
            changed
        };
        if lock_changed {
            self.events.device_lock_changed();
        }
        self.refresh();
    }

    /// Recomputes the snapshot's list at the server's time; when it changed, announces it (gated).
    pub fn refresh(&self) {
        let server_now = self.server_now_ms();
        let announce = {
            let mut state = lock(&self.state);
            let views = broadcast_views(&state.list, &state.acks.acknowledged(), server_now);
            let changed = self.snapshot.update(|snapshot| {
                if snapshot.broadcasts != views {
                    snapshot.broadcasts = views;
                }
            });
            changed && state.gate.offer(Instant::now())
        };
        if announce {
            self.events.broadcasts_changed();
        }
    }

    /// Sends the held-back `broadcasts.changed` when its gap is over.
    pub fn flush_held_event(&self) {
        let due = lock(&self.state).gate.take_due(Instant::now());
        if due {
            self.events.broadcasts_changed();
        }
    }

    /// How long the task may sleep: until the next expiry or the held event, whichever is first.
    pub fn next_wake(&self) -> Duration {
        let server_now = self.server_now_ms();
        let state = lock(&self.state);
        let mut wake = MAX_SLEEP;
        if let Some(expires) = next_expiry_ms(&state.list, server_now) {
            wake = wake.min(Duration::from_millis(expires - server_now));
        }
        if let Some(due) = state.gate.due() {
            wake = wake.min(due.saturating_duration_since(Instant::now()));
        }
        // Never a busy loop, and the expiry itself must have passed when the timer fires.
        wake.max(Duration::from_millis(5))
    }

    /// The employee pressed "OK". `false` when the id is not an active broadcast of this PC. A
    /// second "OK" for the same broadcast is `true` and queues nothing.
    pub fn acknowledge(&self, id: &str) -> bool {
        let server_now = self.server_now_ms();
        {
            let mut state = lock(&self.state);
            let known = state.list.iter().any(|broadcast| broadcast.id == id && broadcast.is_active(server_now));
            if !known {
                return false;
            }
            state.acks.queue(id, server_now);
        }
        // The `acknowledged` flag of the view changed.
        self.refresh();
        self.ack_wake.notify_one();
        true
    }

    /// The acknowledgements waiting for the server.
    pub fn pending_acks(&self) -> Vec<Ack> {
        lock(&self.state).acks.pending()
    }

    /// The server took these acknowledgements.
    pub fn acks_sent(&self, ids: &[String]) {
        lock(&self.state).acks.mark_sent(ids);
    }

    /// An apply report is going out (Step 20 calls this when it sends one): the waiting acknowledgements
    /// ride along instead of waiting for [`ACK_FLUSH_AFTER`].
    pub fn flush_acks_now(&self) {
        self.flush_requested.store(true, Ordering::SeqCst);
        self.ack_wake.notify_one();
    }

    /// Unenroll: the acknowledgements belong to the organization the PC left.
    fn forget_acks(&self) {
        if let Err(error) = lock(&self.state).acks.clear() {
            tracing::error!("cannot delete broadcast-acks.json: {error}");
        }
    }
}

/// The acknowledgement sender (Step 15, plan 4.17): one `deviceApi:reportAcks` call per flush, never while
/// offline, never on a timer that has nothing to say. A failed call keeps the queue and tries again with the
/// Phase 4 full-jitter backoff; a server that refuses the call is asked again after an hour. A PC that is no
/// longer enrolled forgets its acknowledgements.
pub async fn run_ack_sender(
    hub: Arc<NoticeHub>,
    link: Arc<BackendLink>,
    mut snapshot_rx: watch::Receiver<AgentSnapshot>,
    jitter: Arc<dyn Fn(u64) -> u64 + Send + Sync>,
    shutdown: CancellationToken,
) {
    let mut failures: u32 = 0;
    let mut retry_at: Option<Instant> = None;
    // When the oldest acknowledgement still waiting was first seen.
    let mut waiting_since: Option<Instant> = None;
    // No backend link (revoked, stopped): nothing can be sent until something wakes us.
    let mut parked = false;
    loop {
        let (online, enrolled) = {
            let snapshot = snapshot_rx.borrow_and_update();
            (snapshot.connection == ConnectionStatus::Online, snapshot.enrollment != EnrollmentStatus::NotEnrolled)
        };
        if !enrolled {
            hub.forget_acks();
        }
        let pending = hub.pending_acks();
        if pending.is_empty() {
            waiting_since = None;
            hub.flush_requested.store(false, Ordering::SeqCst);
        } else if waiting_since.is_none() {
            waiting_since = Some(Instant::now());
        }
        let due = match waiting_since {
            Some(_) if hub.flush_requested.load(Ordering::SeqCst) => Some(Instant::now()),
            Some(since) => Some(since + ACK_FLUSH_AFTER),
            None => None,
        };
        let at = if online && !parked { due.map(|due| [Some(due), retry_at].into_iter().flatten().max().unwrap_or(due)) } else { None };
        let timer = async {
            match at {
                Some(at) => tokio::time::sleep_until(at).await,
                None => std::future::pending::<()>().await,
            }
        };
        tokio::select! {
            () = shutdown.cancelled() => return,
            () = hub.ack_wake.notified() => { parked = false; continue; }
            changed = snapshot_rx.changed() => {
                if changed.is_err() {
                    shutdown.cancelled().await;
                    return;
                }
                parked = false;
                continue;
            }
            () = timer => {}
        }

        // Send what is waiting, one call (<= MAX_ACKS_PER_CALL entries) at a time.
        loop {
            let batch = hub.pending_acks();
            if batch.is_empty() {
                break;
            }
            let Some((backend, auth)) = link.get() else {
                parked = true;
                break;
            };
            let ids: Vec<String> = batch.iter().map(|ack| ack.broadcast_id.clone()).collect();
            match backend.lockdown_report(&auth, &LockdownCall::Acks(batch)).await {
                Ok(()) => {
                    failures = 0;
                    retry_at = None;
                    hub.acks_sent(&ids);
                }
                Err(error) => {
                    failures = failures.saturating_add(1);
                    let delay = match error {
                        BackendError::Rejected { .. } => ACK_REJECTED_RETRY.max(backoff_delay(failures, jitter.as_ref())),
                        _ => backoff_delay(failures, jitter.as_ref()),
                    };
                    tracing::debug!(failures, delay_ms = delay.as_millis() as u64, "acknowledgements not delivered; retrying later");
                    retry_at = Some(Instant::now() + delay);
                    break;
                }
            }
        }
        // What was sent no longer waits; a new one starts its own 10 minutes.
        if hub.pending_acks().is_empty() {
            waiting_since = None;
            hub.flush_requested.store(false, Ordering::SeqCst);
        }
    }
}

/// The hub's task: follows the policy and the clock until `shutdown`.
pub async fn run_notices(hub: Arc<NoticeHub>, mut policy_rx: watch::Receiver<AgentPolicy>, shutdown: CancellationToken) {
    let first = policy_rx.borrow_and_update().clone();
    hub.on_policy(&first);
    loop {
        let wake = hub.next_wake();
        tokio::select! {
            () = shutdown.cancelled() => return,
            changed = policy_rx.changed() => {
                if changed.is_err() {
                    shutdown.cancelled().await;
                    return;
                }
                let policy = policy_rx.borrow_and_update().clone();
                hub.on_policy(&policy);
            }
            () = tokio::time::sleep(wake) => {
                hub.refresh();
                hub.flush_held_event();
            }
        }
    }
}

// ---------------------------------------------------------------- the requests

/// Where the denial counters go. `day` is the server's UTC day.
pub trait DenialSink: Send + Sync + 'static {
    fn add(&self, day: &str, app_id: &str, kind: &str, count: u64);
}

/// The daily counters of `lockdown::daily` behind a lock (`security-daily.json`). Since Step 20
/// the live agent's sink is the `LockdownReporter` (one owner of the file, cleared on unenroll);
/// this one stays for the tests of the counting itself.
#[cfg(test)]
pub struct DailyDenials(Mutex<DailyCounters>);

#[cfg(test)]
impl DailyDenials {
    pub fn new(counters: DailyCounters) -> Self {
        Self(Mutex::new(counters))
    }
}

#[cfg(test)]
impl DenialSink for DailyDenials {
    fn add(&self, day: &str, app_id: &str, kind: &str, count: u64) {
        let mut counters = lock(&self.0);
        counters.add_permission_denials(day, app_id, kind, count);
        if let Err(error) = counters.save_if_dirty() {
            tracing::error!("cannot save security-daily.json: {error}");
        }
    }
}

impl DenialSink for crate::lockdown::reporting::LockdownReporter {
    fn add(&self, day: &str, app_id: &str, kind: &str, count: u64) {
        self.with_outbox(|outbox| {
            outbox.daily.add_permission_denials(day, app_id, kind, count);
            if let Err(error) = outbox.daily.save_if_dirty() {
                tracing::error!("cannot save security-daily.json: {error}");
            }
        });
    }
}

/// The 1.3 requests and capabilities of the shell pipe.
pub struct NoticeExtension {
    hub: Arc<NoticeHub>,
    policy_rx: watch::Receiver<AgentPolicy>,
    snapshot_rx: watch::Receiver<AgentSnapshot>,
    sink: Option<Arc<dyn DenialSink>>,
    now_ms: Arc<dyn Fn() -> u64 + Send + Sync>,
}

impl NoticeExtension {
    pub fn new(
        hub: Arc<NoticeHub>,
        policy_rx: watch::Receiver<AgentPolicy>,
        snapshot_rx: watch::Receiver<AgentSnapshot>,
        sink: Option<Arc<dyn DenialSink>>,
        now_ms: Arc<dyn Fn() -> u64 + Send + Sync>,
    ) -> Self {
        Self { hub, policy_rx, snapshot_rx, sink, now_ms }
    }

    fn acknowledge(&self, params: serde_json::Value) -> Result<serde_json::Value, RpcError> {
        let params: BroadcastAckParams = serde_json::from_value(params).map_err(|_| invalid_params())?;
        if params.id.is_empty() || params.id.chars().count() > MAX_ID_CHARS {
            return Err(invalid_params());
        }
        let ok = self.hub.acknowledge(&params.id);
        serde_json::to_value(OkResult { ok }).map_err(|_| internal())
    }

    fn report_denials(&self, params: serde_json::Value) -> Result<serde_json::Value, RpcError> {
        let params: ReportDenialsParams = serde_json::from_value(params).map_err(|_| invalid_params())?;
        if params.counts.len() > MAX_DENIAL_ENTRIES {
            return Err(invalid_params());
        }
        // Untrusted input: only an app of this PC's catalogue and one of the eight kinds is counted.
        let mut sums: HashMap<(&str, &str), u64> = HashMap::new();
        {
            let policy = self.policy_rx.borrow();
            let catalogue: HashSet<&str> = policy.catalog.iter().map(|app| app.id.as_str()).collect();
            for entry in &params.counts {
                if entry.count == 0
                    || !catalogue.contains(entry.app_id.as_str())
                    || !PERMISSION_KINDS.contains(&entry.kind.as_str())
                {
                    continue;
                }
                let sum = sums.entry((entry.app_id.as_str(), entry.kind.as_str())).or_insert(0);
                *sum = sum.saturating_add(entry.count).min(MAX_DENIAL_COUNT);
            }
        }
        if let Some(sink) = &self.sink {
            let offset = self.snapshot_rx.borrow().server_time_offset_ms;
            let day = server_day((self.now_ms)(), offset);
            for ((app_id, kind), count) in sums {
                sink.add(&day, app_id, kind, count);
            }
        }
        serde_json::to_value(OkResult { ok: true }).map_err(|_| internal())
    }
}

impl ShellExtension for NoticeExtension {
    fn capabilities(&self) -> Vec<&'static str> {
        vec![CAP_DEVICE_LOCK, CAP_BROADCASTS, CAP_KEYBOARD_POLICY, CAP_PERMISSION_REPORTS]
    }

    fn handle(
        &self,
        _peer: &PeerCtx,
        method: &str,
        params: serde_json::Value,
    ) -> Option<BoxFuture<'static, Result<serde_json::Value, RpcError>>> {
        // Both are quick and never block: the answer is computed now.
        let answer = match method {
            BroadcastAcknowledge::NAME => self.acknowledge(params),
            WebappReportDenials::NAME => self.report_denials(params),
            _ => return None,
        };
        Some(std::future::ready(answer).boxed())
    }
}

fn invalid_params() -> RpcError {
    rpc_error(ErrorCode::InvalidParams, "The parameters are not valid.", false)
}

fn internal() -> RpcError {
    rpc_error(ErrorCode::Internal, "Internal error.", true)
}

#[cfg(test)]
mod tests;
