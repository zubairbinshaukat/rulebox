//! The report queue (plan Phase 4, Step 13 amendment 10; A12): the status
//! snapshot, install results and audit records leave the PC together, in one
//! `deviceApi:report` call, at most once per 60 seconds. Security records (a
//! successful admin exit, an admin-exit lockout, an employee lockout) are sent at
//! once.
//!
//! - **Status:** the backend task installs a [`StatusSource`] while it runs; the
//!   status is built when a report goes out and sent only when it differs from the
//!   last one the server accepted (a full snapshot, so "unchanged" is safe to skip).
//! - **Installs:** the newest result per app (Step 14's engine pushes them); an
//!   app's entry is removed only when the server accepted exactly that result.
//! - **Audit:** the on-disk queue of `audit.rs`, acked only when the server counts
//!   every record of the batch (`accepted == records.len()`; it counts duplicates,
//!   unknown kinds and bad ids too, so this cannot stall). The ids make a replay
//!   harmless (`eventKey`).
//!
//! Errors: any failure keeps everything and retries with full-jitter exponential
//! backoff (5 s doubling to 10 minutes) while online; while offline it waits for
//! the connection (CLAUDE.md data rule 6: no polling). After an outage of more than 5
//! minutes the first ordinary report waits a random 0 to 120 s (security records do not).

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::FutureExt;
use rulebox_ipc::types::{AgentSnapshot, ConnectionStatus};
use tokio::sync::{watch, Notify};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use crate::audit::{AuditHandle, AuditSink, AuditSinkError, BATCH_SIZE};
use crate::backend::{InstallReport, ReportBatch, StatusReport};
use crate::state::lock;

/// At most one report per this long (security records excepted).
pub const MIN_REPORT_INTERVAL: Duration = Duration::from_secs(60);
/// Full-jitter backoff after a failed report: base, doubling up to the cap.
pub const BACKOFF_BASE: Duration = Duration::from_secs(5);
pub const BACKOFF_MAX: Duration = Duration::from_secs(600);
/// (A13, as the ping) After an outage longer than [`LONG_OUTAGE`] the first report
/// waits a random time up to this long, so a whole fleet coming back does not
/// report at once. Security records are not held back.
pub const OUTAGE_REPORT_JITTER_MS: u64 = 120_000;
pub const LONG_OUTAGE: Duration = Duration::from_secs(300);

/// Builds the current status snapshot, or `None` when the machine cannot be read.
pub type StatusSource = Arc<dyn Fn() -> Option<StatusReport> + Send + Sync>;

/// (Step 14) Told about every install result the server accepted (the engine
/// marks it acknowledged in `installs.json`).
pub type InstallAck = Arc<dyn Fn(&InstallReport) + Send + Sync>;

/// The full-jitter delay of the `failures`-th consecutive failure (1-based):
/// a random time in `0..=min(cap, base * 2^(failures-1))`.
pub fn backoff_delay(failures: u32, jitter: &dyn Fn(u64) -> u64) -> Duration {
    let base = BACKOFF_BASE.as_millis() as u64;
    let cap = BACKOFF_MAX.as_millis() as u64;
    let exp = base.saturating_mul(1u64 << failures.saturating_sub(1).min(20));
    Duration::from_millis(jitter(exp.min(cap)))
}

pub struct ReportQueue {
    audit: Arc<AuditHandle>,
    installs: Mutex<BTreeMap<String, InstallReport>>,
    status_source: Mutex<Option<StatusSource>>,
    /// The serialized status the server last accepted.
    last_status: Mutex<Option<String>>,
    /// (Step 14) An installer asked for a restart since the last boot.
    restart_pending: Mutex<bool>,
    /// (Phase 5 Step 20) A lockdown layer waits for a restart (App Control, AppLocker, a service
    /// start type). Its own flag: the install engine sets and clears `restart_pending` by itself.
    lockdown_restart_pending: Mutex<bool>,
    /// (Phase 5 Step 20) The physical-protection report of the last lockdown pass, and the
    /// agent's capabilities.
    security: Mutex<Option<serde_json::Value>>,
    capabilities: Mutex<Option<Vec<String>>>,
    install_ack: Mutex<Option<InstallAck>>,
    wake: Notify,
}

impl ReportQueue {
    pub fn new(audit: Arc<AuditHandle>) -> Arc<Self> {
        Arc::new(Self {
            audit,
            installs: Mutex::new(BTreeMap::new()),
            status_source: Mutex::new(None),
            last_status: Mutex::new(None),
            restart_pending: Mutex::new(false),
            lockdown_restart_pending: Mutex::new(false),
            security: Mutex::new(None),
            capabilities: Mutex::new(None),
            install_ack: Mutex::new(None),
            wake: Notify::new(),
        })
    }

    /// (Step 14) Sets `restartPending` for the next status (a change wakes the task).
    pub fn set_restart_pending(&self, pending: bool) {
        let changed = std::mem::replace(&mut *lock(&self.restart_pending), pending) != pending;
        if changed {
            self.wake.notify_one();
        }
    }

    /// (Step 14) The status field: `Some(true)` while a restart is pending, else
    /// left out (an absent field clears the stored value).
    pub fn restart_pending(&self) -> Option<bool> {
        (*lock(&self.restart_pending) || *lock(&self.lockdown_restart_pending)).then_some(true)
    }

    /// (Phase 5 Step 20) A lockdown layer waits for a restart, or no longer does.
    pub fn set_lockdown_restart_pending(&self, pending: bool) {
        let changed = std::mem::replace(&mut *lock(&self.lockdown_restart_pending), pending) != pending;
        if changed {
            self.wake.notify_one();
        }
    }

    /// (Phase 5 Step 20) The security posture for the next status (a change wakes the task).
    pub fn set_security(&self, security: Option<serde_json::Value>) {
        let mut current = lock(&self.security);
        if *current != security {
            *current = security;
            self.wake.notify_one();
        }
    }

    pub fn security(&self) -> Option<serde_json::Value> {
        lock(&self.security).clone()
    }

    /// (Phase 5 Step 20) What this agent can do (`lockdown/1`).
    pub fn set_capabilities(&self, capabilities: Vec<String>) {
        *lock(&self.capabilities) = Some(capabilities);
    }

    pub fn capabilities(&self) -> Option<Vec<String>> {
        lock(&self.capabilities).clone()
    }

    /// (Step 14) Where accepted install results are confirmed.
    pub fn set_install_ack(&self, ack: InstallAck) {
        *lock(&self.install_ack) = Some(ack);
    }

    /// The backend task starts (`Some`) or stops (`None`).
    pub fn set_status_source(&self, source: Option<StatusSource>) {
        let had = std::mem::replace(&mut *lock(&self.status_source), source).is_some();
        if !had {
            self.wake.notify_one();
        }
    }

    /// Something in the status may have changed (a document was applied, the
    /// connection came back): build it again at the next report.
    pub fn status_changed(&self) {
        self.wake.notify_one();
    }

    /// (Step 14) An install result; replaces an older one of the same app.
    pub fn push_install(&self, report: InstallReport) {
        lock(&self.installs).insert(report.app_id.clone(), report);
        self.wake.notify_one();
    }

    /// Unenrollment or a new enrollment: the next status goes out in full.
    pub fn forget_status(&self) {
        *lock(&self.last_status) = None;
        lock(&self.installs).clear();
    }

    /// The status the next report would build (tests).
    #[cfg(test)]
    pub fn build_status_now(&self) -> Option<StatusReport> {
        let source = lock(&self.status_source).clone();
        source.and_then(|source| source())
    }

    /// Install results waiting (tests).
    #[cfg(test)]
    pub fn installs_queued(&self) -> usize {
        lock(&self.installs).len()
    }

    /// The install results waiting, by app id (tests).
    #[cfg(test)]
    pub fn queued_installs(&self) -> Vec<InstallReport> {
        lock(&self.installs).values().cloned().collect()
    }

    /// (Tests) As if the server accepted every waiting install result.
    #[cfg(test)]
    pub fn accept_installs(&self) -> Vec<InstallReport> {
        let batch = ReportBatch { installs: self.queued_installs(), ..ReportBatch::default() };
        let count = batch.installs.len();
        self.accepted(&batch, None, count, 0);
        batch.installs
    }

    /// Builds the next batch. `status_due`: build the status as well.
    fn next_batch(&self, status_due: bool) -> (ReportBatch, Option<String>) {
        let mut batch = ReportBatch::default();
        let mut status_text = None;
        if status_due {
            let source = lock(&self.status_source).clone();
            if let Some(status) = source.and_then(|source| source()) {
                let text = serde_json::to_string(&status).ok();
                if text.is_some() && *lock(&self.last_status) != text {
                    batch.status = Some(status);
                    status_text = text;
                }
            }
        }
        batch.installs = lock(&self.installs).values().take(BATCH_SIZE).cloned().collect();
        let (records, dropped) = self.audit.next_batch();
        batch.audit = records;
        batch.dropped = dropped;
        (batch, status_text)
    }

    /// The server accepted `batch` with these counts.
    fn accepted(&self, batch: &ReportBatch, status_text: Option<String>, installs: usize, audit: usize) -> bool {
        let mut complete = true;
        if let Some(text) = status_text {
            *lock(&self.last_status) = Some(text);
        }
        if installs == batch.installs.len() {
            {
                let mut queued = lock(&self.installs);
                for sent in &batch.installs {
                    // A newer result of the same app that arrived meanwhile stays.
                    if queued.get(&sent.app_id) == Some(sent) {
                        queued.remove(&sent.app_id);
                    }
                }
            }
            // Outside the queue lock: the engine writes `installs.json` here.
            let ack = lock(&self.install_ack).clone();
            if let Some(ack) = ack {
                for sent in &batch.installs {
                    ack(sent);
                }
            }
        } else {
            tracing::warn!(sent = batch.installs.len(), accepted = installs, "the backend did not take every install result");
            complete = false;
        }
        if audit == batch.audit.len() {
            if !batch.audit.is_empty() || batch.dropped > 0 {
                // By id: the queue may have changed at the front while the batch was out.
                let ids: Vec<String> = batch.audit.iter().map(|record| record.id.clone()).collect();
                self.audit.ack(&ids, batch.dropped);
            }
        } else {
            tracing::warn!(sent = batch.audit.len(), accepted = audit, "the backend did not take every audit record; kept");
            complete = false;
        }
        complete
    }

    fn has_work(&self) -> bool {
        !lock(&self.installs).is_empty() || self.audit.queued() > 0 || self.audit.next_batch().1 > 0
    }
}

fn is_online(snapshot_rx: &watch::Receiver<AgentSnapshot>) -> bool {
    snapshot_rx.borrow().connection == ConnectionStatus::Online
}

/// The report task. Triggers: a new record, install result or status change, a
/// change of the snapshot (kiosk, shell, version: the status), the connection
/// coming back, and the 60-second slot or the backoff timer.
pub async fn run_report_task(
    queue: Arc<ReportQueue>,
    sink: Arc<dyn AuditSink>,
    mut snapshot_rx: watch::Receiver<AgentSnapshot>,
    jitter: Arc<dyn Fn(u64) -> u64 + Send + Sync>,
    shutdown: CancellationToken,
) {
    let mut status_due = true;
    let mut last_sent: Option<Instant> = None;
    let mut failures: u32 = 0;
    let mut retry_at: Option<Instant> = None;
    let mut was_online = is_online(&snapshot_rx);
    // Since when the connection is down, and the earliest time an ordinary report
    // may go out after a long outage.
    let mut offline_since: Option<Instant> = (!was_online).then(Instant::now);
    let mut settle_until: Option<Instant> = None;
    // True when something was asked for and may not have been sent yet.
    let mut wanted = true;
    let mut sink_unavailable = false;
    loop {
        // When may the next report go out?
        let online = is_online(&snapshot_rx);
        let pending = wanted && !sink_unavailable;
        let at = if pending {
            let urgent = queue.audit.has_urgent();
            let mut slot = if urgent {
                Instant::now()
            } else {
                last_sent.map_or_else(Instant::now, |sent| sent + MIN_REPORT_INTERVAL)
            };
            if let (false, Some(settle)) = (urgent, settle_until) {
                slot = slot.max(settle);
            }
            match retry_at {
                // A backoff timer runs only while online; offline waits for the connection.
                Some(retry) if online => Some(slot.max(retry)),
                Some(_) => None,
                None => Some(slot),
            }
        } else {
            None
        };
        let timer = async {
            match at {
                Some(at) => tokio::time::sleep_until(at).await,
                None => std::future::pending::<()>().await,
            }
        };
        tokio::select! {
            () = shutdown.cancelled() => return,
            () = queue.wake.notified() => { wanted = true; status_due = true; continue; }
            () = queue.audit.notify.notified() => { wanted = true; sink_unavailable = false; continue; }
            changed = snapshot_rx.changed() => {
                if changed.is_err() {
                    // The snapshot sender is gone: the agent is stopping.
                    shutdown.cancelled().await;
                    return;
                }
                let now_online = is_online(&snapshot_rx);
                if !now_online && was_online {
                    offline_since = Some(Instant::now());
                }
                if now_online && !was_online {
                    // Back online: whatever failed is tried now (no backoff wait) ...
                    retry_at = None;
                    // ... but after a long outage every PC would do so at the same time.
                    if offline_since.take().is_some_and(|since| since.elapsed() > LONG_OUTAGE) {
                        let wait = Duration::from_millis(jitter(OUTAGE_REPORT_JITTER_MS));
                        settle_until = Some(Instant::now() + wait);
                    }
                }
                was_online = now_online;
                wanted = true;
                status_due = true;
                continue;
            }
            () = timer => {}
        }

        // Send: one batch, then more right away while a backlog remains.
        settle_until = None;
        loop {
            let (batch, status_text) = queue.next_batch(status_due);
            if batch.is_empty() {
                status_due = false;
                wanted = false;
                break;
            }
            let sent_audit = batch.audit.len();
            let result = sink.deliver(&batch).await;
            last_sent = Some(Instant::now());
            match result {
                Ok(accepted) => {
                    status_due = false;
                    if queue.accepted(&batch, status_text, accepted.installs, accepted.audit) {
                        failures = 0;
                        retry_at = None;
                        if !(sent_audit == BATCH_SIZE && queue.has_work()) {
                            wanted = queue.has_work();
                            break;
                        }
                    } else {
                        failures = failures.saturating_add(1);
                        retry_at = Some(Instant::now() + backoff_delay(failures, jitter.as_ref()));
                        wanted = true;
                        break;
                    }
                }
                Err(AuditSinkError::Unavailable) => {
                    // This build cannot deliver: keep the queue, wait for new records.
                    sink_unavailable = true;
                    wanted = false;
                    break;
                }
                Err(AuditSinkError::Unreachable) => {
                    failures = failures.saturating_add(1);
                    let delay = backoff_delay(failures, jitter.as_ref());
                    tracing::debug!(failures, delay_ms = delay.as_millis() as u64, "report not delivered; retrying later");
                    retry_at = Some(Instant::now() + delay);
                    wanted = true;
                    break;
                }
            }
        }
        // A wake-up stored during the delivery was for something it already saw.
        let _ = queue.wake.notified().now_or_never();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};

    use futures_util::future::BoxFuture;
    use tokio::sync::mpsc;

    use crate::audit::{AuditKind, AuditQueue, AuditRecord, MAX_RECORDS};
    use crate::backend::{InstallState, ReportAccepted};
    use crate::testutil::{test_snapshot, TempDir};

    /// A sink that reports every batch on a channel, fails the first `failures`
    /// calls, and can be told to accept fewer audit records than sent.
    struct ScriptedSink {
        failures: AtomicUsize,
        short_audit: AtomicUsize,
        seen: mpsc::UnboundedSender<(ReportBatch, bool)>,
    }

    impl AuditSink for ScriptedSink {
        fn deliver<'a>(&'a self, batch: &'a ReportBatch) -> BoxFuture<'a, Result<ReportAccepted, AuditSinkError>> {
            let fail = self.failures.load(Ordering::SeqCst) > 0;
            if fail {
                self.failures.fetch_sub(1, Ordering::SeqCst);
            }
            let short = self.short_audit.swap(0, Ordering::SeqCst);
            let _ = self.seen.send((batch.clone(), !fail));
            let accepted =
                ReportAccepted { installs: batch.installs.len(), audit: batch.audit.len().saturating_sub(short) };
            std::future::ready(if fail { Err(AuditSinkError::Unreachable) } else { Ok(accepted) }).boxed()
        }
    }

    struct Rig {
        queue: Arc<ReportQueue>,
        audit: Arc<AuditHandle>,
        sink: Arc<ScriptedSink>,
        snapshot_tx: watch::Sender<AgentSnapshot>,
        seen: mpsc::UnboundedReceiver<(ReportBatch, bool)>,
        shutdown: CancellationToken,
        task: tokio::task::JoinHandle<()>,
        status_calls: Arc<AtomicU64>,
        dir: TempDir,
    }

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

    fn rig_with(failures: usize, prefill: u64) -> Rig {
        let dir = TempDir::new();
        let mut snapshot = test_snapshot();
        snapshot.connection = ConnectionStatus::Online;
        let (snapshot_tx, snapshot_rx) = watch::channel(snapshot);
        let path = dir.path().join("audit-queue.json");
        let mut file = AuditQueue::open(path.clone()).unwrap();
        for n in 0..prefill {
            file.push(record(n)).unwrap();
        }
        let audit = AuditHandle::new(file, snapshot_rx.clone(), Arc::new(|| 1_000));
        let queue = ReportQueue::new(Arc::clone(&audit));
        let (seen_tx, seen) = mpsc::unbounded_channel();
        let sink = Arc::new(ScriptedSink {
            failures: AtomicUsize::new(failures),
            short_audit: AtomicUsize::new(0),
            seen: seen_tx,
        });
        let shutdown = CancellationToken::new();
        // The jitter answers its maximum, so the backoff is the exponential cap.
        let jitter: Arc<dyn Fn(u64) -> u64 + Send + Sync> = Arc::new(|max| max);
        let task = tokio::spawn(run_report_task(
            Arc::clone(&queue),
            Arc::clone(&sink) as Arc<dyn AuditSink>,
            snapshot_rx,
            jitter,
            shutdown.clone(),
        ));
        Rig { queue, audit, sink, snapshot_tx, seen, shutdown, task, status_calls: Arc::new(AtomicU64::new(0)), dir }
    }

    fn rig(failures: usize) -> Rig {
        rig_with(failures, 0)
    }

    impl Rig {
        fn with_status(&self, kiosk_error: Option<&'static str>) {
            let calls = Arc::clone(&self.status_calls);
            self.queue.set_status_source(Some(Arc::new(move || {
                calls.fetch_add(1, Ordering::SeqCst);
                let mut status = crate::testutil::sample_status();
                status.kiosk_error = kiosk_error.map(str::to_string);
                Some(status)
            })));
        }

        async fn next(&mut self) -> (ReportBatch, bool) {
            tokio::time::timeout(Duration::from_secs(3600), self.seen.recv())
                .await
                .expect("a report within the hour")
                .expect("the sink is alive")
        }

        async fn nothing_for(&mut self, secs: u64) {
            tokio::time::sleep(Duration::from_secs(secs)).await;
            settle().await;
            assert!(self.seen.try_recv().is_err(), "nothing should have been sent");
        }

        async fn stop(self) {
            self.shutdown.cancel();
            self.task.await.unwrap();
            drop(self.dir);
        }
    }

    async fn settle() {
        for _ in 0..30 {
            tokio::task::yield_now().await;
        }
    }

    #[tokio::test(start_paused = true)]
    async fn audit_sink_acks_only_when_all_accepted() {
        let mut rig = rig(0);
        rig.audit.record(AuditKind::AdminExitWrongPin, None, None);
        rig.audit.record(AuditKind::AdminExitWrongPin, None, None);
        rig.sink.short_audit.store(1, Ordering::SeqCst);
        let (batch, _) = rig.next().await;
        assert_eq!(batch.audit.len(), 2);
        // One short: nothing is acked, both stay on disk.
        settle().await;
        assert_eq!(rig.audit.queued(), 2);
        // The retry (after the backoff) sends the same two records, same ids.
        let (again, _) = rig.next().await;
        assert_eq!(again.audit.iter().map(|r| &r.id).collect::<Vec<_>>(), batch.audit.iter().map(|r| &r.id).collect::<Vec<_>>());
        settle().await;
        assert_eq!(rig.audit.queued(), 0);
        rig.stop().await;
    }

    #[tokio::test(start_paused = true)]
    async fn report_queue_flushes_security_at_once() {
        let mut rig = rig(0);
        rig.with_status(None);
        // The first report (the status) goes at once.
        let (first, _) = rig.next().await;
        assert!(first.status.is_some());
        let t0 = Instant::now();
        // A wrong PIN waits for the 60-second slot.
        rig.audit.record(AuditKind::AdminExitWrongPin, None, None);
        rig.nothing_for(30).await;
        let (batch, _) = rig.next().await;
        assert!(Instant::now() - t0 >= MIN_REPORT_INTERVAL);
        assert_eq!(batch.audit[0].kind, AuditKind::AdminExitWrongPin);
        // The status did not change: not sent again.
        assert!(batch.status.is_none());
        // A lockout goes at once, inside the slot.
        let t1 = Instant::now();
        rig.audit.record(AuditKind::EmployeeLockedOut, Some("maya".into()), Some("password_lockout".into()));
        let (urgent, _) = rig.next().await;
        assert!(Instant::now() - t1 < Duration::from_secs(1));
        assert_eq!(urgent.audit[0].kind, AuditKind::EmployeeLockedOut);
        rig.stop().await;
    }

    #[tokio::test(start_paused = true)]
    async fn the_status_is_sent_only_when_it_changed() {
        let mut rig = rig(0);
        rig.with_status(None);
        let (first, _) = rig.next().await;
        assert!(first.status.is_some());
        // The snapshot changes (the version, say) but the status is the same: nothing.
        rig.snapshot_tx.send_modify(|s| s.desired_state_version += 1);
        rig.nothing_for(120).await;
        // A changed status goes out, in the next slot.
        rig.with_status(Some("compat_blocked"));
        rig.queue.status_changed();
        let (second, _) = rig.next().await;
        assert_eq!(second.status.unwrap().kiosk_error.as_deref(), Some("compat_blocked"));
        rig.stop().await;
    }

    #[tokio::test(start_paused = true)]
    async fn backoff_is_jittered_and_capped() {
        // Full jitter: random in 0..=min(cap, 5 s * 2^(n-1)).
        let max = |n| backoff_delay(n, &|m| m);
        assert_eq!(max(1), Duration::from_secs(5));
        assert_eq!(max(2), Duration::from_secs(10));
        assert_eq!(max(5), Duration::from_secs(80));
        assert_eq!(max(8), Duration::from_secs(600));
        assert_eq!(max(60), Duration::from_secs(600));
        assert_eq!(backoff_delay(3, &|_| 0), Duration::ZERO);
        let half = |m: u64| m / 2;
        assert_eq!(backoff_delay(2, &half), Duration::from_secs(5));

        // In the task: failures back off 5, 10, 20 s (the jitter here is the maximum).
        let mut rig = rig(3);
        rig.audit.record(AuditKind::AdminExitWrongPin, None, None);
        let (_, ok) = rig.next().await;
        assert!(!ok);
        let mut at = Instant::now();
        for (expected, should_succeed) in [(5, false), (10, false), (20, true)] {
            let (_, ok) = rig.next().await;
            let waited = Instant::now() - at;
            // At least the backoff, and the 60-second slot after the previous try.
            assert!(waited >= Duration::from_secs(expected), "{waited:?} < {expected} s");
            assert_eq!(ok, should_succeed);
            at = Instant::now();
        }
        settle().await;
        assert_eq!(rig.audit.queued(), 0);
        rig.stop().await;
    }

    #[tokio::test(start_paused = true)]
    async fn the_first_report_after_a_long_outage_waits_but_security_records_do_not() {
        let mut rig = rig(0);
        rig.with_status(None);
        let _ = rig.next().await;
        let set = |rig: &Rig, status| rig.snapshot_tx.send_modify(|s| s.connection = status);

        // A short outage: the record goes out at once.
        set(&rig, ConnectionStatus::Offline);
        settle().await;
        tokio::time::sleep(Duration::from_secs(120)).await;
        set(&rig, ConnectionStatus::Online);
        settle().await;
        rig.audit.record(AuditKind::AdminExitWrongPin, None, None);
        let back = Instant::now();
        let _ = rig.next().await;
        assert!(Instant::now() - back < Duration::from_secs(1), "no wait after a short outage");

        // A long outage: an ordinary record waits for the random delay (the test's
        // jitter answers the maximum, 120 s) ...
        set(&rig, ConnectionStatus::Offline);
        settle().await;
        tokio::time::sleep(Duration::from_secs(600)).await;
        set(&rig, ConnectionStatus::Online);
        settle().await;
        rig.audit.record(AuditKind::AdminExitWrongPin, None, None);
        let back = Instant::now();
        rig.nothing_for(119).await;
        let _ = rig.next().await;
        let waited = Instant::now() - back;
        assert!(waited >= Duration::from_secs(119) && waited <= Duration::from_secs(121), "{waited:?}");

        // ... a security record does not.
        set(&rig, ConnectionStatus::Offline);
        settle().await;
        tokio::time::sleep(Duration::from_secs(600)).await;
        set(&rig, ConnectionStatus::Online);
        settle().await;
        rig.audit.record(AuditKind::EmployeeLockedOut, Some("maya".into()), None);
        let back = Instant::now();
        let (batch, _) = rig.next().await;
        assert!(Instant::now() - back < Duration::from_secs(1), "a lockout is reported at once");
        assert_eq!(batch.audit[0].kind, AuditKind::EmployeeLockedOut);
        rig.stop().await;
    }

    #[tokio::test(start_paused = true)]
    async fn offline_waits_for_the_connection_and_never_polls() {
        let mut rig = rig(1);
        rig.audit.record(AuditKind::AdminExitWrongPin, None, None);
        let (_, ok) = rig.next().await;
        assert!(!ok);
        rig.snapshot_tx.send_modify(|s| s.connection = ConnectionStatus::Offline);
        settle().await;
        // An hour offline: no timer-driven retries.
        rig.nothing_for(3600).await;
        rig.snapshot_tx.send_modify(|s| s.connection = ConnectionStatus::Online);
        let (batch, ok) = rig.next().await;
        assert!(ok && batch.audit.len() == 1);
        rig.stop().await;
    }

    #[tokio::test(start_paused = true)]
    async fn a_backlog_drains_in_batches_and_dropped_is_reported_once() {
        let mut rig = rig_with(0, MAX_RECORDS as u64 + 3);
        let (first, _) = rig.next().await;
        assert_eq!(first.audit.len(), BATCH_SIZE);
        assert_eq!(first.dropped, 3);
        // The records themselves are not changed (the server's detail rule).
        assert!(first.audit.iter().all(|r| r.detail.is_none()));
        let mut seen = first.audit.len();
        while seen < MAX_RECORDS {
            let (batch, _) = rig.next().await;
            assert_eq!(batch.dropped, 0);
            seen += batch.audit.len();
        }
        settle().await;
        assert_eq!(rig.audit.queued(), 0);
        rig.stop().await;
    }

    #[tokio::test(start_paused = true)]
    async fn queued_records_survive_a_restart_and_keep_their_ids() {
        // No replay duplicates: a record that was sent but not acked is sent again
        // with the same id (the server's `eventKey`), never a new one.
        let mut rig = rig(1);
        rig.audit.record(AuditKind::AdminExitSuccess, None, None);
        let (sent, ok) = rig.next().await;
        assert!(!ok);
        let path = rig.dir.path().join("audit-queue.json");
        let reopened = AuditQueue::open(path).unwrap();
        assert_eq!(reopened.peek(10), &sent.audit[..]);
        rig.stop().await;
    }

    #[tokio::test(start_paused = true)]
    async fn install_status_reporting() {
        let mut rig = rig(0);
        let result = |state, attempts| InstallReport {
            app_id: "app1".into(),
            state,
            app_revision: 2,
            attempts,
            exit_code: None,
            detail: None,
            installed_version: None,
        };
        rig.queue.push_install(result(InstallState::Pending, 0));
        let (batch, _) = rig.next().await;
        assert_eq!(batch.installs, [result(InstallState::Pending, 0)]);
        settle().await;
        assert_eq!(rig.queue.installs_queued(), 0);
        // A newer result replaces an unsent older one: only the newest goes.
        rig.queue.push_install(result(InstallState::Failed, 1));
        rig.queue.push_install(InstallReport { exit_code: Some(1603), detail: Some("exit_code".into()), ..result(InstallState::Failed, 2) });
        let (batch, _) = rig.next().await;
        assert_eq!(batch.installs.len(), 1);
        assert_eq!((batch.installs[0].attempts, batch.installs[0].exit_code), (2, Some(1603)));
        rig.stop().await;
    }
}
