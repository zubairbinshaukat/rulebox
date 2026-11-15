//! Tests of the lockdown reporter (plan 4.11 and 4.19, Phase 5 Step 9): the apply report's hash
//! skip and coalescing, findings flushes, the daily summary riding along, offline and retries.
//! The task runs on a paused clock against `FakeBackend`; the "real clock versus fake clock"
//! mistake is avoided by deriving the reporter's wall clock from the paused tokio clock.

use super::*;
use crate::backend::fake::FakeBackend;
use crate::backend::reports::{ApplyState, WifiItemState};
use crate::backend::{Backend, DeviceAuth};
use crate::lockdown::daily::{day_string, BlockLayer};
use crate::lockdown::findings::{FindingLayer, Observation, Outcome};
use crate::lockdown::{LayerStates, LayerStatus};
use crate::testutil::{test_snapshot, TempDir};

const BASE: u64 = 1_800_000_000_000;
const DAY_MS: i64 = 86_400_000;

fn apply_report(version: u64) -> ApplyReport {
    ApplyReport {
        applied_version: version,
        config: None,
        state: ApplyState::Applied,
        refusal: None,
        layers: LayerStates::all_off(),
        wifi: Vec::new(),
        printers: Vec::new(),
        lkg_version: None,
        capabilities: Vec::new(),
    }
}

fn flipped(version: u64) -> ApplyReport {
    let mut report = apply_report(version);
    report.layers.app_locker.state = LayerStatus::Partial;
    report
}

fn observation(name: &str) -> Observation {
    Observation {
        layer: FindingLayer::AppLocker,
        outcome: Outcome::Audit,
        file_name: name.into(),
        folder_class: "userTemp",
        signer: None,
        product: None,
        sha256: None,
    }
}

// ---------------------------------------------------------------- the apply outbox

#[test]
fn an_unchanged_report_is_skipped_and_a_changed_one_waits_to_be_coalesced() {
    let dir = TempDir::new();
    let mut outbox = ApplyOutbox::open(dir.path().join("apply-report.json")).unwrap();
    outbox.offer(apply_report(3), 1_000);
    assert_eq!(outbox.due_at(), Some(1_000 + APPLY_COALESCE_MS));
    // A change within the wait replaces the report; the wait started with the first.
    outbox.offer(flipped(3), 10_000);
    assert_eq!(outbox.due_at(), Some(1_000 + APPLY_COALESCE_MS));
    assert_eq!(outbox.pending(), Some(&flipped(3)));
    let report = outbox.pending().cloned().unwrap();
    outbox.delivered(&report, 31_000);
    assert!(outbox.pending().is_none() && outbox.due_at().is_none());
    // The same content again: nothing to send.
    outbox.offer(flipped(3), 40_000);
    assert!(outbox.pending().is_none());
    // A different one: not within a minute of the last call, and not within an hour for the same version.
    outbox.offer(apply_report(3), 50_000);
    assert_eq!(outbox.due_at(), Some(31_000 + SAME_VERSION_RESEND_MS));
    outbox.offer(apply_report(4), 51_000);
    assert_eq!(outbox.due_at(), Some(31_000 + APPLY_MIN_GAP_MS), "a new version only keeps the 60-second gap");
}

#[test]
fn a_waiting_report_that_becomes_what_the_server_has_is_dropped() {
    let dir = TempDir::new();
    let mut outbox = ApplyOutbox::open(dir.path().join("apply-report.json")).unwrap();
    outbox.offer(apply_report(3), 0);
    outbox.delivered(&apply_report(3), 31_000);
    outbox.offer(flipped(3), 100_000);
    assert!(outbox.pending().is_some());
    outbox.offer(apply_report(3), 110_000);
    assert!(outbox.pending().is_none(), "the layer went back before anything was sent");
}

#[test]
fn what_the_server_has_and_what_waits_survive_a_restart() {
    let dir = TempDir::new();
    let path = dir.path().join("apply-report.json");
    let mut outbox = ApplyOutbox::open(path.clone()).unwrap();
    outbox.offer(apply_report(3), 0);
    outbox.delivered(&apply_report(3), 31_000);
    outbox.offer(flipped(4), 60_000);
    let mut again = ApplyOutbox::open(path).unwrap();
    assert_eq!(again.pending(), Some(&flipped(4)));
    again.offer(apply_report(3), 70_000);
    assert!(again.pending().is_none(), "a restart does not make the server's own report new again");
}

#[test]
fn a_report_that_changed_while_it_was_in_flight_stays_waiting() {
    let dir = TempDir::new();
    let mut outbox = ApplyOutbox::open(dir.path().join("apply-report.json")).unwrap();
    outbox.offer(apply_report(3), 0);
    let in_flight = outbox.pending().cloned().unwrap();
    outbox.offer(flipped(4), 10_000);
    outbox.delivered(&in_flight, 31_000);
    assert_eq!(outbox.pending(), Some(&flipped(4)));
    assert_eq!(outbox.due_at(), Some(31_000 + APPLY_COALESCE_MS.max(APPLY_MIN_GAP_MS)));
}

// ---------------------------------------------------------------- the task

struct Rig {
    dir: TempDir,
    reporter: Arc<LockdownReporter>,
    fake: FakeBackend,
    snapshot_tx: watch::Sender<AgentSnapshot>,
    shutdown: CancellationToken,
    task: tokio::task::JoinHandle<()>,
    start: Instant,
}

fn rig() -> Rig {
    let dir = TempDir::new();
    let paths = DataPaths::new(dir.path().to_path_buf());
    std::fs::create_dir_all(paths.state_dir()).unwrap();
    let fake = FakeBackend::new();
    let link = BackendLink::new();
    link.set(Arc::new(fake.clone()) as Arc<dyn Backend>, DeviceAuth { device_id: "dev-1".into(), device_secret: "s".into() });
    let mut snapshot = test_snapshot();
    snapshot.connection = ConnectionStatus::Online;
    let (snapshot_tx, snapshot_rx) = watch::channel(snapshot);
    let start = Instant::now();
    let reporter = LockdownReporter::new(
        LockdownOutbox::open(&paths).unwrap(),
        Arc::new(move || BASE + start.elapsed().as_millis() as u64),
    );
    let shutdown = CancellationToken::new();
    let jitter: Arc<dyn Fn(u64) -> u64 + Send + Sync> = Arc::new(|max| max);
    let task = tokio::spawn(run_lockdown_reporter(Arc::clone(&reporter), link, snapshot_rx, jitter, shutdown.clone()));
    Rig { dir, reporter, fake, snapshot_tx, shutdown, task, start }
}

async fn settle() {
    for _ in 0..30 {
        tokio::task::yield_now().await;
    }
}

impl Rig {
    async fn after(&self, secs: u64) {
        tokio::time::sleep(Duration::from_secs(secs)).await;
        settle().await;
    }

    fn calls(&self) -> Vec<LockdownCall> {
        self.fake.lockdown_calls().into_iter().map(|record| record.call).collect()
    }

    fn elapsed_s(&self) -> u64 {
        self.start.elapsed().as_secs()
    }

    async fn stop(self) {
        self.shutdown.cancel();
        self.task.await.unwrap();
        drop(self.dir);
    }
}

#[tokio::test(start_paused = true)]
async fn an_apply_report_goes_out_30_seconds_after_the_first_change_and_a_burst_is_one_call() {
    let rig = rig();
    settle().await;
    rig.reporter.offer_apply(apply_report(3));
    rig.after(10).await;
    rig.reporter.offer_apply(flipped(3));
    rig.after(19).await;
    assert!(rig.calls().is_empty(), "nothing within the 30 seconds");
    rig.after(2).await;
    assert_eq!(rig.calls(), [LockdownCall::Apply(Box::new(flipped(3)))], "one call with the newest content");
    // Nothing more, however long we wait: no timer reports an unchanged state.
    rig.after(48 * 3_600).await;
    assert_eq!(rig.calls().len(), 1);
    rig.stop().await;
}

#[tokio::test(start_paused = true)]
async fn an_unchanged_report_is_never_sent_twice() {
    let rig = rig();
    settle().await;
    rig.reporter.offer_apply(apply_report(3));
    rig.after(31).await;
    assert_eq!(rig.calls().len(), 1);
    for _ in 0..5 {
        rig.reporter.offer_apply(apply_report(3));
        rig.after(3_600).await;
    }
    assert_eq!(rig.calls().len(), 1, "the server's hash equals ours: zero calls");
    rig.stop().await;
}

#[tokio::test(start_paused = true)]
async fn a_layer_that_flips_state_inside_one_version_is_re_sent_once_an_hour_at_most() {
    let rig = rig();
    settle().await;
    rig.reporter.offer_apply(apply_report(3));
    rig.after(31).await;
    let first = rig.elapsed_s();
    rig.reporter.offer_apply(flipped(3));
    rig.after(3_000).await;
    assert_eq!(rig.calls().len(), 1, "not within the hour");
    rig.after(700).await;
    assert_eq!(rig.calls().len(), 2);
    assert!(rig.elapsed_s() - first >= 3_600 - 1);
    // A new version only waits for the 60-second gap.
    let before = rig.elapsed_s();
    rig.reporter.offer_apply(apply_report(4));
    rig.after(61).await;
    assert_eq!(rig.calls().len(), 3);
    assert!(rig.elapsed_s() - before >= 30);
    rig.stop().await;
}

#[tokio::test(start_paused = true)]
async fn a_new_fingerprint_is_sent_once_and_never_again() {
    let rig = rig();
    settle().await;
    rig.reporter.with_outbox(|outbox| {
        outbox.collector.store.ingest(&observation("a.exe"), BASE);
    });
    rig.after(200).await;
    assert!(rig.calls().is_empty(), "a new fingerprint waits for company");
    rig.after(120).await;
    let calls = rig.calls();
    assert_eq!(calls.len(), 1);
    let LockdownCall::Findings(findings) = &calls[0] else { panic!("{calls:?}") };
    assert_eq!((findings.len(), findings[0].file_name.as_str(), findings[0].folder_class.as_str()), (1, "a.exe", "userTemp"));
    // Seen again, many times: nothing.
    for _ in 0..10 {
        rig.reporter.with_outbox(|outbox| {
            outbox.collector.store.ingest(&observation("a.exe"), BASE);
        });
        rig.after(600).await;
    }
    assert_eq!(rig.calls().len(), 1);
    // A second new one waits for the two-hour gap, then goes.
    let now = BASE + rig.start.elapsed().as_millis() as u64;
    rig.reporter.with_outbox(|outbox| {
        outbox.collector.store.ingest(&observation("b.exe"), now);
    });
    rig.after(600).await;
    assert_eq!(rig.calls().len(), 1, "two hours after the last call, not before");
    rig.after(1_000).await;
    assert_eq!(rig.calls().len(), 2);
    rig.stop().await;
}

fn finished_day(rig: &Rig) {
    let yesterday = day_string(BASE as i64 - DAY_MS);
    rig.reporter.with_outbox(|outbox| {
        outbox.daily.add_blocked(&yesterday, BlockLayer::ProcWatch, 3);
        outbox.daily.add_drift(&yesterday, 1);
    });
}

#[tokio::test(start_paused = true)]
async fn a_finished_day_rides_a_heartbeat_but_never_goes_alone() {
    let rig = rig();
    settle().await;
    finished_day(&rig);
    rig.after(48 * 3_600).await;
    assert!(rig.calls().is_empty(), "no timer sends the summary");
    rig.reporter.heartbeat();
    rig.after(1).await;
    let calls = rig.calls();
    assert_eq!(calls.len(), 1);
    let LockdownCall::SecurityDaily(daily) = &calls[0] else { panic!("{calls:?}") };
    assert_eq!(daily.day, day_string(BASE as i64 - DAY_MS));
    assert_eq!((daily.blocked.proc_watch, daily.drift), (3, 1));
    // Taken: the next heartbeat sends nothing.
    rig.reporter.heartbeat();
    rig.after(1).await;
    assert_eq!(rig.calls().len(), 1);
    rig.stop().await;
}

#[tokio::test(start_paused = true)]
async fn a_finished_day_rides_the_apply_report() {
    let rig = rig();
    settle().await;
    finished_day(&rig);
    rig.reporter.offer_apply(apply_report(3));
    rig.after(31).await;
    let calls = rig.calls();
    assert!(matches!(calls.as_slice(), [LockdownCall::Apply(_), LockdownCall::SecurityDaily(_)]), "{calls:?}");
    rig.stop().await;
}

#[tokio::test(start_paused = true)]
async fn a_quiet_day_is_never_sent() {
    let rig = rig();
    settle().await;
    let yesterday = day_string(BASE as i64 - DAY_MS);
    rig.reporter.with_outbox(|outbox| outbox.daily.add_blocked(&yesterday, BlockLayer::ProcWatch, 0));
    rig.reporter.heartbeat();
    rig.reporter.offer_apply(apply_report(3));
    rig.after(31).await;
    assert!(matches!(rig.calls().as_slice(), [LockdownCall::Apply(_)]));
    rig.stop().await;
}

#[tokio::test(start_paused = true)]
async fn offline_waits_for_the_connection_and_never_polls() {
    let rig = rig();
    settle().await;
    rig.snapshot_tx.send_modify(|snapshot| snapshot.connection = ConnectionStatus::Offline);
    settle().await;
    rig.reporter.offer_apply(apply_report(3));
    rig.reporter.with_outbox(|outbox| {
        outbox.collector.store.ingest(&observation("a.exe"), BASE);
    });
    rig.after(3 * 3_600).await;
    assert!(rig.calls().is_empty());
    rig.snapshot_tx.send_modify(|snapshot| snapshot.connection = ConnectionStatus::Online);
    // After a long outage the first call waits the random delay (the test's jitter is the maximum).
    rig.after(100).await;
    assert!(rig.calls().is_empty());
    rig.after(30).await;
    assert!(!rig.calls().is_empty());
    rig.stop().await;
}

#[tokio::test(start_paused = true)]
async fn a_failed_call_is_kept_and_retried_after_a_backoff() {
    let rig = rig();
    settle().await;
    rig.fake.script_lockdown(Err(BackendError::Unreachable));
    rig.reporter.offer_apply(apply_report(3));
    rig.after(31).await;
    assert_eq!(rig.calls().len(), 1, "the first try failed");
    rig.after(3).await;
    assert_eq!(rig.calls().len(), 1, "the backoff is 5 seconds");
    rig.after(3).await;
    assert_eq!(rig.calls().len(), 2);
    assert_eq!(rig.calls()[0], rig.calls()[1], "the same report");
    rig.after(3_600).await;
    assert_eq!(rig.calls().len(), 2, "delivered: nothing more");
    rig.stop().await;
}

#[tokio::test(start_paused = true)]
async fn a_server_that_refuses_the_call_is_asked_again_only_after_an_hour() {
    let rig = rig();
    settle().await;
    rig.fake.script_lockdown(Err(BackendError::Rejected { code: "server_error".into() }));
    rig.reporter.offer_apply(apply_report(3));
    rig.after(31).await;
    assert_eq!(rig.calls().len(), 1);
    rig.after(3_000).await;
    assert_eq!(rig.calls().len(), 1, "no hammering");
    rig.after(700).await;
    assert_eq!(rig.calls().len(), 2);
    rig.stop().await;
}

#[tokio::test(start_paused = true)]
async fn a_quiet_agent_makes_no_calls_at_all() {
    let rig = rig();
    settle().await;
    rig.after(7 * 24 * 3_600).await;
    assert!(rig.calls().is_empty());
    rig.stop().await;
}

#[tokio::test(start_paused = true)]
async fn the_wifi_and_printer_states_are_part_of_the_hash() {
    let rig = rig();
    settle().await;
    let mut with_wifi = apply_report(3);
    with_wifi.wifi.push(WifiItemState { profile_id: "w1".into(), revision: 1, state: "applied".into(), detail: None });
    rig.reporter.offer_apply(apply_report(3));
    rig.after(31).await;
    rig.reporter.offer_apply(with_wifi);
    rig.after(3_700).await;
    assert_eq!(rig.calls().len(), 2);
    rig.stop().await;
}

// ---------------------------------------------------------------- Step 20

#[tokio::test(start_paused = true)]
async fn a_delivered_apply_report_flushes_the_acknowledgements_and_nothing_else_does() {
    let rig = rig();
    let flushed = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    {
        let flushed = Arc::clone(&flushed);
        rig.reporter.set_on_apply_sent(Arc::new(move || {
            flushed.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }));
    }
    settle().await;
    rig.reporter.heartbeat();
    rig.after(5).await;
    assert_eq!(flushed.load(std::sync::atomic::Ordering::SeqCst), 0, "no apply report went out");
    rig.reporter.offer_apply(apply_report(3));
    rig.after(31).await;
    assert_eq!(rig.calls().len(), 1);
    assert_eq!(flushed.load(std::sync::atomic::Ordering::SeqCst), 1, "once per delivered apply report");
    rig.stop().await;
}

#[tokio::test(start_paused = true)]
async fn the_sealing_key_is_registered_first_and_only_once() {
    use crate::network::sealkey::SealPublic;
    let rig = rig();
    settle().await;
    let key = SealPublic { public_b64: "AAAA".into(), key_id: "d280093620494f96".into() };
    rig.reporter.with_outbox(|outbox| outbox.offer_seal_key(Some(key.clone())));
    rig.after(1).await;
    assert_eq!(rig.calls(), [LockdownCall::RegisterSealKey { public_key: "AAAA".into() }]);
    assert_eq!(rig.reporter.with_outbox(|outbox| outbox.take_seal_registered()).as_deref(), Some("d280093620494f96"));
    // Taken once; nothing is left to send, however long we wait.
    assert_eq!(rig.reporter.with_outbox(|outbox| outbox.take_seal_registered()), None);
    rig.after(48 * 3_600).await;
    assert_eq!(rig.calls().len(), 1);
    rig.stop().await;
}
