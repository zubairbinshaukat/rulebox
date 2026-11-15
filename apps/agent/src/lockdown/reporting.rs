//! Sending the lockdown reports (plan 4.11 "Apply report", 4.19): change-driven, coalesced,
//! never on a timer that has nothing to say.
//!
//! Three kinds of call leave the PC through [`LockdownOutbox`], each with its own rule:
//!
//! | Call | Goes out when | Skipped when |
//! |---|---|---|
//! | `reportApply` | the report changed (version, a layer state, Wi-Fi or printer state, LKG), 30 s after the first change, never within 60 s of the last call, and a changed report of the *same* version not within an hour | its content hash equals the one the server accepted |
//! | `reportFindings` | a **new** fingerprint exists: `FindingsStore::flush_due` | everything the store holds is reported |
//! | `reportSecurityDaily` | a completed server day has a non-zero counter, and an apply report or a heartbeat is going out anyway | the day was quiet |
//!
//! Audit records for device events (`device.lockdownRefused`, `...RolledBack`, `...DriftReasserted`)
//! do not come here: they use the Phase 4 audit queue (`audit.rs`, at most 50 per call, batched
//! with the 60-second report of `report.rs`).
//!
//! A failed call keeps everything and tries again with the Phase 4 full-jitter backoff while the
//! PC is online; offline it waits for the connection (no polling). A server that answers
//! `Rejected` (the function does not exist yet, the device is unknown) is asked again only after
//! [`REJECTED_RETRY`]: nothing is written by a refused call, but it is not free either.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rulebox_ipc::types::{AgentSnapshot, ConnectionStatus};
use serde::{Deserialize, Serialize};
use tokio::sync::{watch, Notify};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use super::daily::{next_day_start_ms, server_day, DailyCounters};
use super::findings::Collector;
use crate::backend::reports::{ApplyReport, LockdownCall};
use crate::backend::{BackendError, BackendLink};
use crate::network::sealkey::{self, SealPublic};
use crate::paths::DataPaths;
use crate::report::{backoff_delay, LONG_OUTAGE, OUTAGE_REPORT_JITTER_MS};
use crate::state::{lock, read_json, write_atomic};

/// A changed apply report waits this long for further changes (one report for a burst).
pub const APPLY_COALESCE_MS: u64 = 30_000;
/// Two apply reports are at least this far apart.
pub const APPLY_MIN_GAP_MS: u64 = 60_000;
/// A changed report of the version the server already has (a layer flipped state) is re-sent at
/// most once an hour (plan 4.19: 24 a day worst case).
pub const SAME_VERSION_RESEND_MS: u64 = 3_600_000;
/// After the server refused a call, ask again no sooner than this.
pub const REJECTED_RETRY: Duration = Duration::from_secs(3_600);

// ---------------------------------------------------------------- the apply report

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct SentApply {
    hash: String,
    applied_version: u64,
    at_ms: u64,
}

#[derive(Serialize, Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
struct ApplyFile {
    schema: u32,
    /// The newest report that has not been accepted.
    pending: Option<ApplyReport>,
    pending_since_ms: Option<u64>,
    /// What the server holds.
    sent: Option<SentApply>,
}

/// `apply-report.json`: the report waiting and the hash the server last accepted, so a restart
/// does not send the same report again.
pub struct ApplyOutbox {
    path: PathBuf,
    file: ApplyFile,
}

impl ApplyOutbox {
    pub fn open(path: PathBuf) -> std::io::Result<Self> {
        let mut file = read_json::<ApplyFile>(&path)?.unwrap_or_default();
        file.schema = 1;
        Ok(Self { path, file })
    }

    fn save(&self) {
        let saved = serde_json::to_vec_pretty(&self.file).map_err(std::io::Error::other).and_then(|bytes| write_atomic(&self.path, &bytes));
        if let Err(error) = saved {
            tracing::error!("cannot save apply-report.json: {error}");
        }
    }

    /// The apply finished with this report. Equal to what the server holds: nothing to send (and
    /// a waiting report that has become equal again is dropped). Otherwise it replaces any waiting
    /// one; the 30-second wait counts from the first change.
    pub fn offer(&mut self, report: ApplyReport, now_ms: u64) {
        let hash = report.content_hash();
        let known = self.file.sent.as_ref().is_some_and(|sent| sent.hash == hash);
        if known {
            if self.file.pending.take().is_some() {
                self.file.pending_since_ms = None;
                self.save();
            }
            return;
        }
        if self.file.pending.as_ref() == Some(&report) {
            return;
        }
        if self.file.pending.is_none() {
            self.file.pending_since_ms = Some(now_ms);
        }
        self.file.pending = Some(report);
        self.save();
    }

    /// When the waiting report may go out.
    pub fn due_at(&self) -> Option<u64> {
        let pending = self.file.pending.as_ref()?;
        let since = self.file.pending_since_ms.unwrap_or(0);
        let mut due = since.saturating_add(APPLY_COALESCE_MS);
        if let Some(sent) = &self.file.sent {
            due = due.max(sent.at_ms.saturating_add(APPLY_MIN_GAP_MS));
            if sent.applied_version == pending.applied_version {
                due = due.max(sent.at_ms.saturating_add(SAME_VERSION_RESEND_MS));
            }
        }
        Some(due)
    }

    pub fn pending(&self) -> Option<&ApplyReport> {
        self.file.pending.as_ref()
    }

    /// The server took `report`. A newer one that arrived meanwhile stays waiting.
    pub fn delivered(&mut self, report: &ApplyReport, now_ms: u64) {
        self.file.sent = Some(SentApply { hash: report.content_hash(), applied_version: report.applied_version, at_ms: now_ms });
        if self.file.pending.as_ref().is_some_and(|pending| pending == report) {
            self.file.pending = None;
            self.file.pending_since_ms = None;
        } else {
            self.file.pending_since_ms = Some(now_ms);
        }
        self.save();
    }

    pub fn clear(&mut self) -> std::io::Result<()> {
        self.file = ApplyFile { schema: 1, ..ApplyFile::default() };
        crate::state::remove_file_if_exists(&self.path)
    }
}

// ---------------------------------------------------------------- everything that can go out

/// The three outboxes.
pub struct LockdownOutbox {
    pub apply: ApplyOutbox,
    pub collector: Collector,
    pub daily: DailyCounters,
    /// The server day to send is due now because an apply report just went out.
    piggyback: bool,
    /// (Step 20, plan 4.18) The device sealing key the server does not have yet: one
    /// `registerSealKey` call, sent before anything else. In memory only: the runtime offers it
    /// again after a restart until `AgentState.seal_key_registered` says the server has it.
    seal_pending: Option<SealPublic>,
    /// The key id the server just took; the runtime writes it into the agent state.
    seal_done: Option<String>,
}

impl LockdownOutbox {
    pub fn open(paths: &DataPaths) -> std::io::Result<Self> {
        Ok(Self {
            apply: ApplyOutbox::open(paths.apply_report())?,
            collector: Collector::open(paths.findings(), paths.findings_state())?,
            daily: DailyCounters::open(paths.security_daily())?,
            piggyback: false,
            seal_pending: None,
            seal_done: None,
        })
    }

    /// (Step 20) The sealing key to register (`None`: the server has it). Offering the same key
    /// twice changes nothing.
    pub fn offer_seal_key(&mut self, key: Option<SealPublic>) {
        self.seal_pending = key;
    }

    /// The id of a key the server took since the last call.
    pub fn take_seal_registered(&mut self) -> Option<String> {
        self.seal_done.take()
    }

    /// The next call that is due, or `None`. `heartbeat`: the PC is talking to the server anyway
    /// (a ping went out), so a finished day may ride along.
    pub fn next_call(&mut self, now_ms: u64, offset: Option<i64>, heartbeat: bool) -> Option<LockdownCall> {
        // The key first: without it the server cannot seal a Wi-Fi passphrase to this PC.
        if let Some(call) = self.seal_pending.as_ref().and_then(|key| sealkey::pending_registration(None, key)) {
            return Some(call);
        }
        if self.apply.due_at().is_some_and(|due| due <= now_ms) {
            return self.apply.pending().cloned().map(|report| LockdownCall::Apply(Box::new(report)));
        }
        let day = server_day(now_ms, offset);
        let next_day = next_day_start_ms(now_ms, offset);
        if self.collector.store.flush_due(now_ms, &day, next_day).is_some_and(|due| due <= now_ms) {
            let findings = self.collector.store.next_flush();
            if !findings.is_empty() {
                return Some(LockdownCall::Findings(findings));
            }
        }
        if heartbeat || self.piggyback {
            if let Some(summary) = self.daily.due(&day).into_iter().find(|summary| !summary.is_zero()) {
                return Some(LockdownCall::SecurityDaily(summary));
            }
        }
        None
    }

    /// When [`next_call`](Self::next_call) has something to send without further events: the
    /// earliest of the two timers there are. The daily summary has none (it rides along).
    pub fn next_wakeup(&self, now_ms: u64, offset: Option<i64>) -> Option<u64> {
        let day = server_day(now_ms, offset);
        let findings = self.collector.store.flush_due(now_ms, &day, next_day_start_ms(now_ms, offset));
        let seal = self.seal_pending.as_ref().map(|_| now_ms);
        [self.apply.due_at(), findings, seal].into_iter().flatten().min()
    }

    /// The server took `call`.
    pub fn delivered(&mut self, call: &LockdownCall, now_ms: u64, offset: Option<i64>) {
        match call {
            LockdownCall::Apply(report) => {
                self.apply.delivered(report, now_ms);
                // A day that finished rides on the next call, which is right now.
                self.piggyback = true;
            }
            LockdownCall::Findings(findings) => {
                let ids: Vec<String> = findings.iter().map(|finding| finding.fingerprint.clone()).collect();
                self.collector.store.mark_reported(&ids, now_ms, &server_day(now_ms, offset));
                self.collector.save();
            }
            // The runtime records the key id in `AgentState.seal_key_registered` at its next pass.
            LockdownCall::RegisterSealKey { public_key } => {
                if self.seal_pending.as_ref().is_some_and(|key| key.public_b64 == *public_key) {
                    self.seal_done = self.seal_pending.take().map(|key| key.key_id);
                }
            }
            // (Step 15) The acknowledgement queue marks its own records sent (`notice::run_ack_sender`).
            LockdownCall::Acks(_) => {}
            LockdownCall::SecurityDaily(summary) => {
                self.daily.ack(&summary.day);
                if let Err(error) = self.daily.save_if_dirty() {
                    tracing::error!("cannot save security-daily.json: {error}");
                }
            }
        }
    }

    /// The loop that drains calls is idle again.
    pub fn settled(&mut self) {
        self.piggyback = false;
    }

    /// Unenroll: the reports belong to the organization the PC is leaving.
    pub fn clear(&mut self) -> std::io::Result<()> {
        self.seal_pending = None;
        self.seal_done = None;
        self.piggyback = false;
        // Every part is cleared even when an earlier one failed; the first error is the answer.
        let apply = self.apply.clear();
        let findings = self.collector.clear();
        let daily = self.daily.clear();
        apply.and(findings).and(daily)
    }
}

// ---------------------------------------------------------------- the task

/// The shared handle of the reporter: the reconciler offers reports, the watchdog and the findings
/// collection add what they saw, the task sends.
pub struct LockdownReporter {
    outbox: Mutex<LockdownOutbox>,
    wake: Notify,
    heartbeat: AtomicBool,
    now_ms: Arc<dyn Fn() -> u64 + Send + Sync>,
    /// (Step 20) Called each time the server took an apply report: the broadcast
    /// acknowledgements ride along (`NoticeHub::flush_acks_now`).
    on_apply_sent: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
}

impl LockdownReporter {
    pub fn new(outbox: LockdownOutbox, now_ms: Arc<dyn Fn() -> u64 + Send + Sync>) -> Arc<Self> {
        Arc::new(Self {
            outbox: Mutex::new(outbox),
            wake: Notify::new(),
            heartbeat: AtomicBool::new(false),
            now_ms,
            on_apply_sent: Mutex::new(None),
        })
    }

    /// (Step 20) What runs when an apply report was delivered.
    pub fn set_on_apply_sent(&self, hook: Arc<dyn Fn() + Send + Sync>) {
        *lock(&self.on_apply_sent) = Some(hook);
    }

    /// An apply finished (or was refused, or rolled back): offer its report.
    pub fn offer_apply(&self, report: ApplyReport) {
        let now = (self.now_ms)();
        lock(&self.outbox).apply.offer(report, now);
        self.wake.notify_one();
    }

    /// Runs `f` on the outboxes (the findings collection, the daily counters) and wakes the task,
    /// which looks at its timers again. Do not call it from the task's own thread while holding
    /// nothing else: it takes the outbox lock.
    pub fn with_outbox<R>(&self, f: impl FnOnce(&mut LockdownOutbox) -> R) -> R {
        let result = f(&mut lock(&self.outbox));
        self.wake.notify_one();
        result
    }

    /// A ping went out: a finished server day may ride along.
    pub fn heartbeat(&self) {
        self.heartbeat.store(true, Ordering::SeqCst);
        self.wake.notify_one();
    }
}

fn is_online(rx: &watch::Receiver<AgentSnapshot>) -> bool {
    rx.borrow().connection == ConnectionStatus::Online
}

/// The reporter task. Its triggers are an offered report, a new finding, a heartbeat, the PC
/// coming online, and the two timers of [`LockdownOutbox::next_wakeup`] (only while something is
/// waiting). Without work it sleeps until woken.
pub async fn run_lockdown_reporter(
    reporter: Arc<LockdownReporter>,
    link: Arc<BackendLink>,
    mut snapshot_rx: watch::Receiver<AgentSnapshot>,
    jitter: Arc<dyn Fn(u64) -> u64 + Send + Sync>,
    shutdown: CancellationToken,
) {
    let mut failures: u32 = 0;
    let mut retry_at: Option<Instant> = None;
    let mut was_online = is_online(&snapshot_rx);
    let mut offline_since: Option<Instant> = (!was_online).then(Instant::now);
    let mut settle_until: Option<Instant> = None;
    // No backend link (not enrolled, revoked, stopped): nothing can be sent until something wakes us.
    let mut parked = false;
    loop {
        let online = is_online(&snapshot_rx);
        let offset = snapshot_rx.borrow().server_time_offset_ms;
        let now_ms = (reporter.now_ms)();
        let wake_at = lock(&reporter.outbox).next_wakeup(now_ms, offset);
        let heartbeat = reporter.heartbeat.load(Ordering::SeqCst);
        // When may the next call go out? Never while offline.
        let at = match (online && !parked, wake_at, heartbeat) {
            (false, _, _) => None,
            (true, Some(due), _) => Some(Instant::now() + Duration::from_millis(due.saturating_sub(now_ms))),
            (true, None, true) => Some(Instant::now()),
            (true, None, false) => None,
        }
        .map(|at| [Some(at), retry_at, settle_until].into_iter().flatten().max().unwrap_or(at));
        let timer = async {
            match at {
                Some(at) => tokio::time::sleep_until(at).await,
                None => std::future::pending::<()>().await,
            }
        };
        tokio::select! {
            () = shutdown.cancelled() => return,
            () = reporter.wake.notified() => { parked = false; continue; }
            changed = snapshot_rx.changed() => {
                if changed.is_err() {
                    shutdown.cancelled().await;
                    return;
                }
                let now_online = is_online(&snapshot_rx);
                if !now_online && was_online {
                    offline_since = Some(Instant::now());
                }
                if now_online && !was_online {
                    retry_at = None;
                    if offline_since.take().is_some_and(|since| since.elapsed() > LONG_OUTAGE) {
                        settle_until = Some(Instant::now() + Duration::from_millis(jitter(OUTAGE_REPORT_JITTER_MS)));
                    }
                }
                was_online = now_online;
                parked = false;
                continue;
            }
            () = timer => {}
        }

        // Send what is due, one call at a time, until nothing is.
        settle_until = None;
        let heartbeat = reporter.heartbeat.swap(false, Ordering::SeqCst);
        loop {
            let now_ms = (reporter.now_ms)();
            let offset = snapshot_rx.borrow().server_time_offset_ms;
            let call = lock(&reporter.outbox).next_call(now_ms, offset, heartbeat);
            let Some(call) = call else {
                lock(&reporter.outbox).settled();
                break;
            };
            let Some((backend, auth)) = link.get() else {
                // Keep everything; the connection coming back (or the next offer) wakes the loop.
                parked = true;
                reporter.heartbeat.fetch_or(heartbeat, Ordering::SeqCst);
                break;
            };
            match backend.lockdown_report(&auth, &call).await {
                Ok(()) => {
                    failures = 0;
                    retry_at = None;
                    let now_ms = (reporter.now_ms)();
                    lock(&reporter.outbox).delivered(&call, now_ms, offset);
                    if matches!(call, LockdownCall::Apply(_)) {
                        let hook = lock(&reporter.on_apply_sent).clone();
                        if let Some(hook) = hook {
                            hook();
                        }
                    }
                }
                Err(error) => {
                    failures = failures.saturating_add(1);
                    let delay = match error {
                        BackendError::Rejected { .. } => REJECTED_RETRY.max(backoff_delay(failures, jitter.as_ref())),
                        _ => backoff_delay(failures, jitter.as_ref()),
                    };
                    tracing::debug!(failures, delay_ms = delay.as_millis() as u64, "lockdown report not delivered; retrying later");
                    retry_at = Some(Instant::now() + delay);
                    reporter.heartbeat.fetch_or(heartbeat, Ordering::SeqCst);
                    break;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests;
