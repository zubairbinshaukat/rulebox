//! The audit queue (plan Section 5.11): every use of the hidden admin exit and
//! every employee lockout is written to disk first, then delivered to the backend
//! through the [`AuditSink`] seam.
//!
//! (Phase 4 Step 13, A12) The sink delivers one [`ReportBatch`]: the audit
//! records together with the status snapshot and install results
//! (`report.rs` builds it). [`ConvexAuditSink`] sends it as `deviceApi:report`
//! through the [`BackendLink`]; `--sim-demo` keeps [`LogAuditSink`].

use std::fmt::Write as _;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use futures_util::future::BoxFuture;
use futures_util::FutureExt;
use rulebox_ipc::types::AgentSnapshot;
use serde::{Deserialize, Serialize};
use tokio::sync::{watch, Notify};

use crate::backend::{BackendLink, ReportAccepted, ReportBatch};
use crate::state::{lock, read_json, write_atomic};

/// Records kept on disk; when full the oldest non-urgent record is dropped and
/// counted (a security record only when nothing else is left to drop).
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
    // (Phase 5 Step 9, plan 4.2) Events a device reports about its own lockdown. On the
    // wire they are `deviceLockdownRefused` and so on; the server (Step 10) records them
    // as `device.lockdownRefused`, ... `detail` is a fixed code, never a path or free text.
    DeviceLockdownRefused,
    DeviceLockdownRolledBack,
    DeviceTamperDetected,
    /// The first drift per item per day only.
    DeviceDriftReasserted,
    DeviceSafeModeBlocked,
    DeviceClockJump,
}

impl AuditKind {
    /// (A12) Security records are reported at once, not with the next 60-second
    /// batch: a successful admin exit and every lockout.
    pub fn is_urgent(self) -> bool {
        matches!(self, AuditKind::AdminExitSuccess | AuditKind::AdminExitLockedOut | AuditKind::EmployeeLockedOut)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuditSinkError {
    /// This build cannot deliver at all (the test sink; kept for a build without a backend).
    #[allow(dead_code)]
    Unavailable,
    /// The backend could not be reached or refused the call (`rate_limited`,
    /// `device_rejected`, ...): nothing is acked, try again later.
    Unreachable,
}

/// Where the reports go.
pub trait AuditSink: Send + Sync + 'static {
    /// Deliver one batch. The answer says how many audit records and install
    /// results the backend now has (a repeated id counts as accepted).
    fn deliver<'a>(&'a self, batch: &'a ReportBatch) -> BoxFuture<'a, Result<ReportAccepted, AuditSinkError>>;
}

/// Nothing is delivered; records stay queued up to the cap (tests).
#[cfg(test)]
pub struct NullAuditSink;

#[cfg(test)]
impl AuditSink for NullAuditSink {
    fn deliver<'a>(&'a self, _batch: &'a ReportBatch) -> BoxFuture<'a, Result<ReportAccepted, AuditSinkError>> {
        std::future::ready(Err(AuditSinkError::Unavailable)).boxed()
    }
}

/// `--sim-demo`: logs each record at `info` and accepts everything.
pub struct LogAuditSink;

impl AuditSink for LogAuditSink {
    fn deliver<'a>(&'a self, batch: &'a ReportBatch) -> BoxFuture<'a, Result<ReportAccepted, AuditSinkError>> {
        for record in &batch.audit {
            tracing::info!(
                id = %record.id,
                at_ms = record.at_ms,
                kind = ?record.kind,
                username = ?record.username,
                detail = ?record.detail,
                "audit record"
            );
        }
        if batch.dropped > 0 {
            tracing::info!(dropped = batch.dropped, "audit records were dropped on this PC");
        }
        let accepted = ReportAccepted { installs: batch.installs.len(), audit: batch.audit.len() };
        std::future::ready(Ok(accepted)).boxed()
    }
}

/// (Step 13) The real agent and `--simulate` without `--sim-demo`:
/// `deviceApi:report` through the backend link. No link (not enrolled, revoked,
/// stopped) is `Unreachable`; so is every backend error, so nothing is acked.
pub struct ConvexAuditSink {
    link: Arc<BackendLink>,
}

impl ConvexAuditSink {
    pub fn new(link: Arc<BackendLink>) -> Self {
        Self { link }
    }
}

impl AuditSink for ConvexAuditSink {
    fn deliver<'a>(&'a self, batch: &'a ReportBatch) -> BoxFuture<'a, Result<ReportAccepted, AuditSinkError>> {
        let link = self.link.get();
        async move {
            let Some((backend, auth)) = link else {
                return Err(AuditSinkError::Unreachable);
            };
            match backend.report(&auth, batch).await {
                Ok(accepted) => Ok(accepted),
                Err(error) => {
                    tracing::debug!("report failed ({error}); kept for the next try");
                    Err(AuditSinkError::Unreachable)
                }
            }
        }
        .boxed()
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
        let mut queue = Self { path, records: file.records, dropped: file.dropped };
        while queue.records.len() > MAX_RECORDS {
            queue.evict_one();
        }
        Ok(queue)
    }

    /// Appends and saves atomically. The record stays queued in memory even when
    /// the write fails.
    pub fn push(&mut self, record: AuditRecord) -> std::io::Result<()> {
        self.records.push(record);
        if self.records.len() > MAX_RECORDS {
            self.evict_one();
        }
        self.save()
    }

    /// Drops one record to make room and counts it: the oldest record that is not
    /// urgent (a security record is the last to go), else the oldest of all.
    fn evict_one(&mut self) {
        let victim = self.records.iter().position(|record| !record.kind.is_urgent()).unwrap_or(0);
        self.records.remove(victim);
        self.dropped = self.dropped.saturating_add(1);
    }

    /// Up to `max` records, oldest first.
    pub fn peek(&self, max: usize) -> &[AuditRecord] {
        &self.records[..max.min(self.records.len())]
    }

    /// Removes the records with these ids and saves. By id, not by count: while a
    /// report was in flight the queue may have changed at the front (a full queue
    /// drops its oldest), and a record that was never sent must not be acked.
    #[cfg(test)]
    pub fn ack(&mut self, ids: &[String]) -> std::io::Result<()> {
        self.ack_reported(ids, 0)
    }

    /// Like [`ack`](Self::ack), and also takes `reported_dropped` off the dropped
    /// counter: that many were reported in the batch that was just accepted.
    pub fn ack_reported(&mut self, ids: &[String], reported_dropped: u64) -> std::io::Result<()> {
        self.records.retain(|record| !ids.contains(&record.id));
        self.dropped = self.dropped.saturating_sub(reported_dropped);
        self.save()
    }

    pub fn len(&self) -> usize {
        self.records.len()
    }

    // The companion of `len` (clippy `len_without_is_empty`); nothing asks yet.
    #[allow(dead_code)]
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
    /// Wakes the report task (`report.rs`).
    pub(crate) notify: Notify,
    /// A security record is queued (A12: report at once).
    urgent: AtomicBool,
    snapshot_rx: watch::Receiver<AgentSnapshot>,
    now_ms: Arc<dyn Fn() -> u64 + Send + Sync>,
}

impl AuditHandle {
    pub fn new(
        queue: AuditQueue,
        snapshot_rx: watch::Receiver<AgentSnapshot>,
        now_ms: Arc<dyn Fn() -> u64 + Send + Sync>,
    ) -> Arc<Self> {
        // Records left from before a restart may hold a lockout: send them soon.
        let urgent = queue.records.iter().any(|record| record.kind.is_urgent());
        Arc::new(Self { queue: Mutex::new(queue), notify: Notify::new(), urgent: AtomicBool::new(urgent), snapshot_rx, now_ms })
    }

    /// Whether a security record waits (cleared when its batch is acked).
    pub(crate) fn has_urgent(&self) -> bool {
        self.urgent.load(Ordering::SeqCst)
    }

    /// The next batch, oldest first, and the dropped count it reports. The
    /// dropped count travels in the report's own `dropped` field; no record is
    /// changed.
    pub(crate) fn next_batch(&self) -> (Vec<AuditRecord>, u64) {
        let queue = lock(&self.queue);
        (queue.peek(BATCH_SIZE).to_vec(), queue.dropped())
    }

    /// The backend has the records with these `ids` (the ones that were sent) and
    /// the `dropped` count that went with them.
    pub(crate) fn ack(&self, ids: &[String], dropped: u64) {
        let mut queue = lock(&self.queue);
        if let Err(error) = queue.ack_reported(ids, dropped) {
            tracing::error!("cannot save the audit queue: {error}");
        }
        let still = queue.records.iter().any(|record| record.kind.is_urgent());
        self.urgent.store(still, Ordering::SeqCst);
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
        if kind.is_urgent() {
            self.urgent.store(true, Ordering::SeqCst);
        }
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


#[cfg(test)]
mod tests {
    use super::*;


    use crate::testutil::TempDir;

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
        reopened.ack(&[record(1).id, record(2).id]).unwrap();
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

    fn urgent(n: u64) -> AuditRecord {
        AuditRecord { kind: AuditKind::AdminExitSuccess, ..record(n) }
    }

    #[test]
    fn a_full_queue_drops_non_urgent_records_first() {
        let dir = TempDir::new();
        let mut queue = AuditQueue::open(dir.path().join("audit-queue.json")).unwrap();
        // The oldest record is a security record; the rest are not.
        queue.push(urgent(0)).unwrap();
        for n in 1..MAX_RECORDS as u64 {
            queue.push(record(n)).unwrap();
        }
        assert_eq!((queue.len(), queue.dropped()), (MAX_RECORDS, 0));
        queue.push(record(900)).unwrap();
        // The oldest NON-urgent record (1) went, the urgent one stays at the front.
        assert_eq!((queue.len(), queue.dropped()), (MAX_RECORDS, 1));
        assert_eq!(queue.peek(2), &[urgent(0), record(2)]);
        // A queue of nothing but security records still takes a new one: the oldest goes.
        let mut all = AuditQueue::open(dir.path().join("all.json")).unwrap();
        for n in 0..=MAX_RECORDS as u64 {
            all.push(urgent(n)).unwrap();
        }
        assert_eq!((all.len(), all.dropped()), (MAX_RECORDS, 1));
        assert_eq!(all.peek(1), &[urgent(1)]);
        // A new ordinary record never pushes out security records: it is the one dropped.
        all.push(record(7_000)).unwrap();
        assert_eq!((all.len(), all.dropped()), (MAX_RECORDS, 2));
        assert!(all.peek(MAX_RECORDS).iter().all(|r| r.kind == AuditKind::AdminExitSuccess));
        // The cap also applies to an oversized file on disk.
        let mut big = AuditQueue::open(dir.path().join("big.json")).unwrap();
        big.records = (0..MAX_RECORDS as u64 + 3).map(|n| if n < 2 { urgent(n) } else { record(n) }).collect();
        big.save().unwrap();
        let reopened = AuditQueue::open(dir.path().join("big.json")).unwrap();
        assert_eq!((reopened.len(), reopened.dropped()), (MAX_RECORDS, 3));
        assert_eq!(reopened.peek(2), &[urgent(0), urgent(1)]);
    }

    #[test]
    fn the_ack_removes_the_records_that_were_sent_not_the_first_n() {
        let dir = TempDir::new();
        let mut queue = AuditQueue::open(dir.path().join("audit-queue.json")).unwrap();
        for n in 0..MAX_RECORDS as u64 {
            queue.push(record(n)).unwrap();
        }
        // A batch goes out ...
        let sent: Vec<AuditRecord> = queue.peek(BATCH_SIZE).to_vec();
        let reported = queue.dropped();
        // ... and while it is in flight the full queue takes a new record, which
        // drops the oldest (it was in the batch).
        queue.push(record(1_000)).unwrap();
        assert_eq!(queue.dropped(), reported + 1);
        let ids: Vec<String> = sent.iter().map(|r| r.id.clone()).collect();
        queue.ack_reported(&ids, reported).unwrap();
        // Exactly the 49 sent records that were still queued are gone; record 50 (never
        // sent) and the new one stay; the dropped record stays counted for the next report.
        assert_eq!(queue.len(), MAX_RECORDS - (BATCH_SIZE - 1));
        assert_eq!(queue.peek(1), &[record(BATCH_SIZE as u64)]);
        assert!(queue.peek(MAX_RECORDS).contains(&record(1_000)));
        assert_eq!(queue.dropped(), 1);
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

    #[tokio::test]
    async fn the_null_sink_is_unavailable_and_the_log_sink_accepts() {
        let batch = ReportBatch { audit: vec![record(1)], ..ReportBatch::default() };
        assert_eq!(NullAuditSink.deliver(&batch).await, Err(AuditSinkError::Unavailable));
        assert_eq!(LogAuditSink.deliver(&batch).await, Ok(ReportAccepted { installs: 0, audit: 1 }));
    }

    #[tokio::test]
    async fn the_convex_sink_needs_a_link_and_reports_through_it() {
        use crate::backend::fake::FakeBackend;
        use crate::backend::{BackendError, DeviceAuth};
        let link = BackendLink::new();
        let sink = ConvexAuditSink::new(Arc::clone(&link));
        let batch = ReportBatch { audit: vec![record(1), record(2)], dropped: 1, ..ReportBatch::default() };
        // Not enrolled (or revoked): nothing can be sent.
        assert_eq!(sink.deliver(&batch).await, Err(AuditSinkError::Unreachable));
        let fake = FakeBackend::new();
        link.set(Arc::new(fake.clone()), DeviceAuth { device_id: "dev-1".into(), device_secret: "s".into() });
        assert_eq!(sink.deliver(&batch).await, Ok(ReportAccepted { installs: 0, audit: 2 }));
        let sent = &fake.report_calls()[0].batch;
        assert_eq!((sent.audit.len(), sent.dropped), (2, 1));
        // A rejection (rate limited, say) acks nothing.
        fake.script_report(Err(BackendError::Rejected { code: "rate_limited".into() }));
        assert_eq!(sink.deliver(&batch).await, Err(AuditSinkError::Unreachable));
        link.clear();
        assert_eq!(sink.deliver(&batch).await, Err(AuditSinkError::Unreachable));
    }

    #[test]
    fn security_records_are_urgent() {
        assert!(AuditKind::AdminExitSuccess.is_urgent());
        assert!(AuditKind::AdminExitLockedOut.is_urgent());
        assert!(AuditKind::EmployeeLockedOut.is_urgent());
        assert!(!AuditKind::AdminExitWrongPin.is_urgent());
        assert!(!AuditKind::AdminExitFailed.is_urgent());
    }
}
