//! The audit queue (plan Section 5.11): every use of the hidden admin exit and
//! every employee lockout is written to disk first, then delivered to the backend
//! through the [`AuditSink`] seam. The audit log itself is Phase 4; until then the
//! real agent queues (up to the cap) and the simulated agent logs.

use std::fmt::Write as _;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use futures_util::future::BoxFuture;
use futures_util::FutureExt;
use rulebox_ipc::types::{AgentSnapshot, ConnectionStatus};
use serde::{Deserialize, Serialize};
use tokio::sync::{watch, Notify};
use tokio_util::sync::CancellationToken;

use crate::state::{lock, read_json, write_atomic};

/// Records kept on disk; when full the oldest is dropped and counted.
pub const MAX_RECORDS: usize = 500;
/// Records per delivery.
pub const BATCH_SIZE: usize = 50;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AuditRecord {
    /// 32 hex characters, random; the backend uses it to drop duplicates.
    pub id: String,
    /// Device wall clock.
    pub at_ms: u64,
    /// As known when recorded, so the backend can correct `at_ms`.
    #[serde(default)]
    pub server_time_offset_ms: Option<i64>,
    pub kind: AuditKind,
    /// Employee lockouts only.
    #[serde(default)]
    pub username: Option<String>,
    /// Short, fixed texts only; never a PIN, password or hash.
    #[serde(default)]
    pub detail: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AuditKind {
    AdminExitSuccess,
    AdminExitWrongPin,
    AdminExitLockedOut,
    AdminExitFailed,
    EmployeeLockedOut,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuditSinkError {
    /// This build cannot deliver at all.
    Unavailable,
    /// The backend could not be reached; try again on the next trigger.
    Unreachable,
}

/// Where the queue is delivered. Phase 4 adds the Convex sink.
pub trait AuditSink: Send + Sync + 'static {
    /// Deliver a batch. `Ok` = the backend has all of them (it must accept a
    /// repeated id silently).
    fn deliver<'a>(&'a self, batch: &'a [AuditRecord]) -> BoxFuture<'a, Result<(), AuditSinkError>>;
}

/// The real agent until Phase 4: nothing is delivered, records stay queued up to
/// the cap.
pub struct NullAuditSink;

impl AuditSink for NullAuditSink {
    fn deliver<'a>(&'a self, _batch: &'a [AuditRecord]) -> BoxFuture<'a, Result<(), AuditSinkError>> {
        std::future::ready(Err(AuditSinkError::Unavailable)).boxed()
    }
}

/// Simulate mode: logs each record at `info` and accepts it.
pub struct LogAuditSink;

impl AuditSink for LogAuditSink {
    fn deliver<'a>(&'a self, batch: &'a [AuditRecord]) -> BoxFuture<'a, Result<(), AuditSinkError>> {
        for record in batch {
            tracing::info!(
                id = %record.id,
                at_ms = record.at_ms,
                kind = ?record.kind,
                username = ?record.username,
                detail = ?record.detail,
                "audit record"
            );
        }
        std::future::ready(Ok(())).boxed()
    }
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase", default)]
struct QueueFile {
    schema: u32,
    dropped: u64,
    records: Vec<AuditRecord>,
}

impl Default for QueueFile {
    fn default() -> Self {
        Self { schema: 1, dropped: 0, records: Vec::new() }
    }
}

/// `audit-queue.json`.
pub struct AuditQueue {
    path: PathBuf,
    records: Vec<AuditRecord>,
    dropped: u64,
}

impl AuditQueue {
    /// A missing file is an empty queue; a corrupt one is renamed aside
    /// (`state::read_json`).
    pub fn open(path: PathBuf) -> std::io::Result<Self> {
        let file = read_json::<QueueFile>(&path)?.unwrap_or_default();
        let mut records = file.records;
        let mut dropped = file.dropped;
        if records.len() > MAX_RECORDS {
            let extra = records.len() - MAX_RECORDS;
            records.drain(..extra);
            dropped = dropped.saturating_add(extra as u64);
        }
        Ok(Self { path, records, dropped })
    }

    /// Appends and saves atomically. The record stays queued in memory even when
    /// the write fails.
    pub fn push(&mut self, record: AuditRecord) -> std::io::Result<()> {
        self.records.push(record);
        if self.records.len() > MAX_RECORDS {
            self.records.remove(0);
            self.dropped = self.dropped.saturating_add(1);
        }
        self.save()
    }

    /// Up to `max` records, oldest first.
    pub fn peek(&self, max: usize) -> &[AuditRecord] {
        &self.records[..max.min(self.records.len())]
    }

    /// Removes the first `count` records and saves.
    pub fn ack(&mut self, count: usize) -> std::io::Result<()> {
        self.ack_reported(count, 0)
    }

    /// Like [`ack`](Self::ack), and also takes `reported_dropped` off the dropped
    /// counter: that many were reported in the batch that was just accepted.
    pub fn ack_reported(&mut self, count: usize, reported_dropped: u64) -> std::io::Result<()> {
        self.records.drain(..count.min(self.records.len()));
        self.dropped = self.dropped.saturating_sub(reported_dropped);
        self.save()
    }

    pub fn len(&self) -> usize {
        self.records.len()
    }

    pub fn is_empty(&self) -> bool {
        self.records.is_empty()
    }

    /// Records dropped since the last accepted batch that reported them.
    pub fn dropped(&self) -> u64 {
        self.dropped
    }

    /// Drops everything, including the dropped counter, and deletes the file
    /// (unenrollment). Returns how many records had not been delivered.
    pub fn clear(&mut self) -> std::io::Result<usize> {
        let undelivered = self.records.len();
        self.records.clear();
        self.dropped = 0;
        crate::state::remove_file_if_exists(&self.path)?;
        Ok(undelivered)
    }

    fn save(&self) -> std::io::Result<()> {
        let file = QueueFile { schema: 1, dropped: self.dropped, records: self.records.clone() };
        let bytes = serde_json::to_vec_pretty(&file).map_err(std::io::Error::other)?;
        write_atomic(&self.path, &bytes)
    }
}

static FALLBACK_COUNTER: AtomicU64 = AtomicU64::new(0);

/// 32 hex characters from the OS random source.
fn random_id() -> String {
    let mut bytes = [0u8; 16];
    if getrandom::fill(&mut bytes).is_err() {
        // Unique enough for de-duplication; the OS source failing is not expected.
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos());
        let count = FALLBACK_COUNTER.fetch_add(1, Ordering::Relaxed);
        bytes.copy_from_slice(&(nanos ^ (u128::from(count) << 96)).to_le_bytes());
    }
    let mut id = String::with_capacity(32);
    for byte in bytes {
        // Writing to a String cannot fail.
        let _ = write!(id, "{byte:02x}");
    }
    id
}

/// What the rest of the agent holds: the queue plus the wake-up for the delivery
/// task.
pub struct AuditHandle {
    queue: Mutex<AuditQueue>,
    notify: Notify,
    snapshot_rx: watch::Receiver<AgentSnapshot>,
    now_ms: Arc<dyn Fn() -> u64 + Send + Sync>,
}

impl AuditHandle {
    pub fn new(
        queue: AuditQueue,
        snapshot_rx: watch::Receiver<AgentSnapshot>,
        now_ms: Arc<dyn Fn() -> u64 + Send + Sync>,
    ) -> Arc<Self> {
        Arc::new(Self { queue: Mutex::new(queue), notify: Notify::new(), snapshot_rx, now_ms })
    }

    /// Writes the record to disk, then wakes the delivery task. Never blocks on
    /// the network; logs an error when the disk write fails.
    pub fn record(&self, kind: AuditKind, username: Option<String>, detail: Option<String>) {
        let record = AuditRecord {
            id: random_id(),
            at_ms: (self.now_ms)(),
            server_time_offset_ms: self.snapshot_rx.borrow().server_time_offset_ms,
            kind,
            username,
            detail,
        };
        let pushed = lock(&self.queue).push(record);
        if let Err(error) = pushed {
            tracing::error!("cannot save the audit queue: {error}");
        }
        self.notify.notify_one();
    }

    /// Records waiting for delivery.
    pub fn queued(&self) -> usize {
        lock(&self.queue).len()
    }

    /// Unenrollment: the queue belongs to the organization the PC is leaving.
    /// Returns how many records had not been delivered.
    pub fn discard_all(&self) -> usize {
        match lock(&self.queue).clear() {
            Ok(undelivered) => undelivered,
            Err(error) => {
                tracing::error!("cannot delete the audit queue: {error}");
                0
            }
        }
    }

    /// A copy of everything queued, oldest first (tests).
    #[cfg(test)]
    pub fn records(&self) -> Vec<AuditRecord> {
        let queue = lock(&self.queue);
        queue.peek(queue.len()).to_vec()
    }
}

/// The next batch and how many dropped records it reports.
fn next_batch(handle: &AuditHandle) -> (Vec<AuditRecord>, u64) {
    let queue = lock(&handle.queue);
    let mut batch = queue.peek(BATCH_SIZE).to_vec();
    let dropped = queue.dropped();
    if dropped > 0 {
        if let Some(first) = batch.first_mut() {
            first.detail = Some(match first.detail.take() {
                Some(detail) => format!("dropped:{dropped};{detail}"),
                None => format!("dropped:{dropped}"),
            });
            return (batch, dropped);
        }
    }
    (batch, 0)
}

/// Delivers batches, oldest first, until the queue is empty or the sink fails.
async fn deliver_all(handle: &AuditHandle, sink: &dyn AuditSink) {
    loop {
        let (batch, reported_dropped) = next_batch(handle);
        if batch.is_empty() {
            return;
        }
        match sink.deliver(&batch).await {
            Ok(()) => {
                let acked = lock(&handle.queue).ack_reported(batch.len(), reported_dropped);
                if let Err(error) = acked {
                    tracing::error!("cannot save the audit queue: {error}");
                }
            }
            Err(error) => {
                tracing::debug!(?error, queued = batch.len(), "audit delivery failed; waiting for the next trigger");
                return;
            }
        }
    }
}

/// The `audit` task of plan Section 5.2. It delivers once at start, then when a
/// record is pushed and when `connection` becomes `online`. On any error it stops
/// and waits for the next trigger; it never loops on a timer (CLAUDE.md data
/// rule 6).
pub async fn run_audit_task(
    handle: Arc<AuditHandle>,
    sink: Arc<dyn AuditSink>,
    mut snapshot_rx: watch::Receiver<AgentSnapshot>,
    shutdown: CancellationToken,
) {
    let mut was_online = snapshot_rx.borrow_and_update().connection == ConnectionStatus::Online;
    loop {
        // Use up a wake-up that is already stored: whatever caused it was pushed
        // before this point, so the delivery below sees it. Without this a record
        // that arrived during the previous delivery would give one extra attempt
        // right after a failure.
        let _ = handle.notify.notified().now_or_never();
        deliver_all(&handle, sink.as_ref()).await;
        loop {
            tokio::select! {
                () = shutdown.cancelled() => return,
                () = handle.notify.notified() => break,
                changed = snapshot_rx.changed() => {
                    if changed.is_err() {
                        // The snapshot sender is gone; only new records and shutdown matter now.
                        tokio::select! {
                            () = shutdown.cancelled() => return,
                            () = handle.notify.notified() => break,
                        }
                    }
                    let online = snapshot_rx.borrow_and_update().connection == ConnectionStatus::Online;
                    let became_online = online && !was_online;
                    was_online = online;
                    if became_online {
                        break;
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use std::time::Duration;

    use tokio::sync::mpsc;

    use crate::testutil::{test_snapshot, TempDir};

    fn record(n: u64) -> AuditRecord {
        AuditRecord {
            id: format!("{n:032x}"),
            at_ms: n,
            server_time_offset_ms: None,
            kind: AuditKind::AdminExitWrongPin,
            username: None,
            detail: None,
        }
    }

    #[test]
    fn push_survives_a_reopen_and_ack_removes_from_the_front() {
        let dir = TempDir::new();
        let path = dir.path().join("audit-queue.json");
        let mut queue = AuditQueue::open(path.clone()).unwrap();
        for n in 1..=3 {
            queue.push(record(n)).unwrap();
        }
        let mut reopened = AuditQueue::open(path).unwrap();
        assert_eq!(reopened.len(), 3);
        assert_eq!(reopened.peek(2), &[record(1), record(2)]);
        reopened.ack(2).unwrap();
        assert_eq!(reopened.peek(10), &[record(3)]);
        assert_eq!(reopened.dropped(), 0);
    }

    #[test]
    fn the_501st_push_drops_the_oldest_and_counts_it() {
        let dir = TempDir::new();
        let path = dir.path().join("audit-queue.json");
        let mut queue = AuditQueue::open(path.clone()).unwrap();
        for n in 0..=MAX_RECORDS as u64 {
            queue.push(record(n)).unwrap();
        }
        assert_eq!(queue.len(), MAX_RECORDS);
        assert_eq!(queue.dropped(), 1);
        assert_eq!(queue.peek(1), &[record(1)]);
        // The counter is on disk too.
        let reopened = AuditQueue::open(path).unwrap();
        assert_eq!((reopened.len(), reopened.dropped()), (MAX_RECORDS, 1));
    }

    #[test]
    fn the_kind_and_fields_are_camel_case_on_disk() {
        let dir = TempDir::new();
        let path = dir.path().join("audit-queue.json");
        let mut queue = AuditQueue::open(path.clone()).unwrap();
        let mut r = record(1);
        r.kind = AuditKind::EmployeeLockedOut;
        r.username = Some("maya".into());
        queue.push(r).unwrap();
        let text = std::fs::read_to_string(path).unwrap();
        for needle in ["\"schema\": 1", "\"employeeLockedOut\"", "\"atMs\"", "\"username\": \"maya\""] {
            assert!(text.contains(needle), "{needle} in {text}");
        }
    }

    #[test]
    fn ids_are_32_hex_characters_and_differ() {
        let (a, b) = (random_id(), random_id());
        assert_eq!(a.len(), 32);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }

    /// A sink that reports every batch on a channel and fails the first
    /// `failures` calls.
    struct ScriptedSink {
        failures: AtomicUsize,
        calls: AtomicUsize,
        seen: mpsc::UnboundedSender<(usize, Vec<AuditRecord>, bool)>,
    }

    impl AuditSink for ScriptedSink {
        fn deliver<'a>(&'a self, batch: &'a [AuditRecord]) -> BoxFuture<'a, Result<(), AuditSinkError>> {
            let call = self.calls.fetch_add(1, Ordering::SeqCst) + 1;
            let fail = self.failures.load(Ordering::SeqCst) > 0;
            if fail {
                self.failures.fetch_sub(1, Ordering::SeqCst);
            }
            let _ = self.seen.send((call, batch.to_vec(), !fail));
            std::future::ready(if fail { Err(AuditSinkError::Unreachable) } else { Ok(()) }).boxed()
        }
    }

    struct Rig {
        handle: Arc<AuditHandle>,
        snapshot_tx: watch::Sender<AgentSnapshot>,
        seen: mpsc::UnboundedReceiver<(usize, Vec<AuditRecord>, bool)>,
        shutdown: CancellationToken,
        task: tokio::task::JoinHandle<()>,
        _dir: TempDir,
    }

    fn rig(failures: usize) -> Rig {
        let dir = TempDir::new();
        let (snapshot_tx, snapshot_rx) = watch::channel(test_snapshot());
        let queue = AuditQueue::open(dir.path().join("audit-queue.json")).unwrap();
        let handle = AuditHandle::new(queue, snapshot_rx.clone(), Arc::new(|| 1_000));
        let (seen_tx, seen) = mpsc::unbounded_channel();
        let sink = Arc::new(ScriptedSink {
            failures: AtomicUsize::new(failures),
            calls: AtomicUsize::new(0),
            seen: seen_tx,
        });
        let shutdown = CancellationToken::new();
        let task = tokio::spawn(run_audit_task(Arc::clone(&handle), sink, snapshot_rx, shutdown.clone()));
        Rig { handle, snapshot_tx, seen, shutdown, task, _dir: dir }
    }

    async fn next_call(rig: &mut Rig) -> (usize, Vec<AuditRecord>, bool) {
        tokio::time::timeout(Duration::from_secs(5), rig.seen.recv())
            .await
            .expect("a delivery within 5 s")
            .expect("the sink is alive")
    }

    #[tokio::test(start_paused = true)]
    async fn a_failed_delivery_waits_for_the_next_trigger_and_never_polls() {
        let mut rig = rig(1);
        rig.handle.record(AuditKind::AdminExitWrongPin, None, None);
        let (call, batch, accepted) = next_call(&mut rig).await;
        assert_eq!((call, batch.len(), accepted), (1, 1, false));
        assert_eq!(rig.handle.queued(), 1);

        // An hour passes: nothing calls the sink.
        tokio::time::advance(Duration::from_secs(3600)).await;
        for _ in 0..10 {
            tokio::task::yield_now().await;
        }
        assert!(rig.seen.try_recv().is_err(), "the sink was called without a trigger");

        // The next record triggers; both are delivered, oldest first.
        rig.handle.record(AuditKind::AdminExitLockedOut, None, None);
        let (call, batch, accepted) = next_call(&mut rig).await;
        assert_eq!((call, accepted), (2, true));
        assert_eq!(
            batch.iter().map(|r| r.kind).collect::<Vec<_>>(),
            [AuditKind::AdminExitWrongPin, AuditKind::AdminExitLockedOut]
        );
        for _ in 0..10 {
            tokio::task::yield_now().await;
        }
        assert_eq!(rig.handle.queued(), 0);
        rig.shutdown.cancel();
        rig.task.await.unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn the_connection_becoming_online_triggers_delivery() {
        let mut rig = rig(1);
        rig.handle.record(AuditKind::AdminExitSuccess, None, None);
        let (_, _, accepted) = next_call(&mut rig).await;
        assert!(!accepted);

        // Another snapshot change that is not "became online" does nothing.
        rig.snapshot_tx.send_modify(|s| s.desired_state_version += 1);
        for _ in 0..10 {
            tokio::task::yield_now().await;
        }
        assert!(rig.seen.try_recv().is_err());

        rig.snapshot_tx.send_modify(|s| s.connection = ConnectionStatus::Online);
        let (call, batch, accepted) = next_call(&mut rig).await;
        assert_eq!((call, batch.len(), accepted), (2, 1, true));
        rig.shutdown.cancel();
        rig.task.await.unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn dropped_records_are_reported_once_in_the_first_record_of_a_batch() {
        let mut rig = rig(0);
        // Fill the queue past the cap while the task is busy elsewhere: push directly.
        {
            let mut queue = lock(&rig.handle.queue);
            for n in 0..(MAX_RECORDS as u64 + 3) {
                queue.push(record(n)).unwrap();
            }
        }
        rig.handle.notify.notify_one();
        let (_, batch, accepted) = next_call(&mut rig).await;
        assert!(accepted);
        assert_eq!(batch.len(), BATCH_SIZE);
        assert_eq!(batch[0].detail.as_deref(), Some("dropped:3"));
        assert_eq!(batch[1].detail, None);
        // The remaining batches carry no marker.
        let mut seen = batch.len();
        while seen < MAX_RECORDS {
            let (_, batch, _) = next_call(&mut rig).await;
            assert!(batch.iter().all(|r| r.detail.is_none()));
            seen += batch.len();
        }
        assert_eq!(rig.handle.queued(), 0);
        assert_eq!(lock(&rig.handle.queue).dropped(), 0);
        rig.shutdown.cancel();
        rig.task.await.unwrap();
    }

    #[tokio::test]
    async fn the_null_sink_is_unavailable_and_the_log_sink_accepts() {
        let batch = [record(1)];
        assert_eq!(NullAuditSink.deliver(&batch).await, Err(AuditSinkError::Unavailable));
        assert_eq!(LogAuditSink.deliver(&batch).await, Ok(()));
    }
}
