//! Tests of the install engine with `SimPlatform` (nothing is executed) and
//! `FakeDownloader` (nothing is downloaded). Time is paused: retries are driven
//! with `tokio::time::advance`.

use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

use rulebox_ipc::types::{AgentSnapshot, ConnectionStatus, EnrollmentStatus};
use serde_json::json;
use sha2::{Digest, Sha256};
use tokio::task::JoinHandle;

use crate::audit::{AuditHandle, AuditQueue};
use crate::backend::InstallState;
use crate::catalog::AppResolver;
use crate::installs::download::fake::FakeDownloader;
use crate::installs::download::DownloadError;
use crate::installs::hex_lower;
use crate::platform::sim::{SimOp, SimPlatform};
use crate::testutil::{test_snapshot, TempDir};

const BASE_MS: u64 = 1_760_000_000_000;
const DEPLOYMENT: &str = "https://happy-otter-123.convex.cloud";
const CODE: &str = "{23170F69-40C1-2702-2408-000001000000}";

fn sha(bytes: &[u8]) -> String {
    hex_lower(&Sha256::digest(bytes))
}

fn url(id: &str, bytes: &[u8]) -> String {
    format!("https://downloads.example.com/{id}/{}", &sha(bytes)[..8])
}

/// A desktop app with an install of `kind`, program `{ProgramFiles}\<id>\<id>.exe`
/// (portable: `{RuleboxApps}\<id>\tool.exe`).
fn app(id: &str, kind: &str, bytes: &[u8], revision: u64, remove: bool) -> CatalogApp {
    let exe = if kind == "portable" { format!(r"{{RuleboxApps}}\{id}\tool.exe") } else { format!(r"{{ProgramFiles}}\{id}\{id}.exe") };
    serde_json::from_value(json!({
        "id": id, "name": id, "description": null, "kind": "desktop", "builtin": null, "web": null,
        "desktop": { "exe": exe, "args": [], "fileArgTemplate": [], "resetFolders": [],
            "install": {
                "kind": kind, "url": url(id, bytes), "sha256": sha(bytes), "sizeBytes": bytes.len(),
                "silentArgs": if kind == "exe" { json!(["/S", r"/D=C:\Program Files\X Y"]) } else { json!([]) },
                "productCode": if kind == "msi" { json!(CODE) } else { json!(null) },
                "successExitCodes": [0], "removeWhenUnassigned": remove } },
        "pinnedTaskbar": false, "pinnedDesktop": false, "hue": null, "icon": null,
        "audience": "everyone", "employeeIds": [], "revision": revision
    }))
    .unwrap()
}

fn exe_of(app: &CatalogApp) -> PathBuf {
    let roots = crate::platform::sim::sim_path_roots();
    PathBuf::from(check_spec(app, &roots).unwrap().exe)
}

struct Rig {
    dir: TempDir,
    sim: Arc<SimPlatform>,
    downloader: FakeDownloader,
    book: Arc<InstallBook>,
    report: Arc<ReportQueue>,
    paths: DataPaths,
    policy_tx: watch::Sender<AgentPolicy>,
    snapshot_tx: watch::Sender<AgentSnapshot>,
    /// (Phase 6 Step 11) Whether an employee is signed in (`false` at the start: the apply window is open).
    presence_tx: watch::Sender<bool>,
    shared: Arc<SharedState>,
    shutdown: CancellationToken,
    task: Option<JoinHandle<()>>,
    visible_calls: Arc<AtomicUsize>,
    start: tokio::time::Instant,
}

fn enrolled_snapshot() -> AgentSnapshot {
    let mut snapshot = test_snapshot();
    snapshot.enrollment = EnrollmentStatus::Enrolled;
    snapshot.connection = ConnectionStatus::Online;
    snapshot.convex_url = Some(DEPLOYMENT.into());
    snapshot
}

fn rig_in(dir: TempDir) -> Rig {
    let paths = DataPaths::new(dir.path().to_path_buf());
    std::fs::create_dir_all(paths.state_dir()).unwrap();
    let sim = Arc::new(SimPlatform::new(dir.path().to_path_buf()));
    let (snapshot_tx, snapshot_rx) = watch::channel(enrolled_snapshot());
    let audit = AuditHandle::new(AuditQueue::open(paths.audit_queue()).unwrap(), snapshot_rx, Arc::new(|| 1));
    let report = ReportQueue::new(audit);
    let book = InstallBook::open(paths.installs());
    {
        let book = Arc::clone(&book);
        report.set_install_ack(Arc::new(move |r| book.ack(r)));
    }
    let policy = AgentPolicy { has_document: true, ..AgentPolicy::default() };
    let shared = SharedState::new(
        crate::state::StateStore::open(&dir.path().join("agent-state")).unwrap(),
        crate::state::AgentState::default(),
        Arc::clone(&sim) as Arc<dyn Platform>,
    );
    Rig {
        shared,
        dir,
        sim,
        downloader: FakeDownloader::new(),
        book,
        report,
        paths,
        policy_tx: watch::channel(policy).0,
        snapshot_tx,
        presence_tx: watch::channel(false).0,
        shutdown: CancellationToken::new(),
        task: None,
        visible_calls: Arc::new(AtomicUsize::new(0)),
        start: tokio::time::Instant::now(),
    }
}

fn rig() -> Rig {
    rig_in(TempDir::new())
}

impl Rig {
    fn start(&mut self) {
        let start = self.start;
        let visible = Arc::clone(&self.visible_calls);
        let deps = EngineDeps {
            platform: Arc::clone(&self.sim) as Arc<dyn Platform>,
            downloader: Arc::new(self.downloader.clone()),
            paths: self.paths.clone(),
            book: Arc::clone(&self.book),
            report: Arc::clone(&self.report),
            now_ms: Arc::new(move || BASE_MS + start.elapsed().as_millis() as u64),
            on_visible_change: Arc::new(move || {
                visible.fetch_add(1, Ordering::SeqCst);
            }),
            on_driver_change: Arc::new(|| {}),
            install_timeout: Duration::from_secs(1800),
            exe_wait: Duration::from_secs(10),
            shared: Arc::clone(&self.shared),
            signed_in: self.presence_tx.subscribe(),
        };
        self.task = Some(tokio::spawn(run_install_task(
            deps,
            self.policy_tx.subscribe(),
            self.snapshot_tx.subscribe(),
            self.shutdown.clone(),
        )));
    }

    async fn stop(&mut self) {
        self.shutdown.cancel();
        if let Some(task) = self.task.take() {
            task.await.unwrap();
        }
        self.shutdown = CancellationToken::new();
    }

    fn set_catalog(&self, catalog: Vec<CatalogApp>) {
        self.policy_tx.send_modify(|p| p.catalog = catalog);
    }

    fn serve(&self, app: &CatalogApp, bytes: &[u8]) {
        self.downloader.serve(&install_of(app).unwrap().url, bytes);
    }

    fn record(&self, id: &str) -> Option<InstallRecord> {
        self.book.snapshot().apps.get(id).cloned()
    }

    fn state(&self, id: &str) -> Option<LocalState> {
        self.record(id).map(|r| r.state)
    }

    fn runs(&self) -> Vec<InstallerCommand> {
        self.sim.with_world(|w| w.installer_runs.clone())
    }

    fn visible(&self, catalog: &[CatalogApp]) -> Vec<String> {
        let resolver = AppResolver::with_installs(Arc::clone(&self.sim) as Arc<dyn Platform>, Arc::clone(&self.book), self.paths.icons_dir());
        resolver.visible(catalog, "emp1").into_iter().map(|a| a.id).collect()
    }

    fn downloads(&self) -> Vec<String> {
        match std::fs::read_dir(self.paths.downloads_dir()) {
            Ok(entries) => entries.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect(),
            Err(_) => Vec::new(),
        }
    }

    /// Lets the engine (and its blocking threads) run until `cond` holds.
    async fn until(&self, what: &str, cond: impl Fn(&Rig) -> bool) {
        for _ in 0..3000 {
            if cond(self) {
                return;
            }
            tokio::task::yield_now().await;
            std::thread::sleep(Duration::from_micros(200));
        }
        panic!("never happened: {what}; records: {:?}", self.book.snapshot().apps);
    }

    /// Lets everything that can run, run (nothing is expected to change).
    async fn settle(&self) {
        for _ in 0..200 {
            tokio::task::yield_now().await;
            std::thread::sleep(Duration::from_micros(100));
        }
    }
}

async fn advance(d: Duration) {
    tokio::time::advance(d).await;
}

#[tokio::test(start_paused = true)]
async fn msi_success_reports_installed_and_becomes_visible() {
    let mut rig = rig();
    let bytes = b"7-zip msi bytes";
    let msi = app("app7zip", "msi", bytes, 1, true);
    rig.serve(&msi, bytes);
    rig.set_catalog(vec![msi.clone()]);
    assert!(rig.visible(std::slice::from_ref(&msi)).is_empty());
    rig.start();
    rig.until("installed", |r| r.state("app7zip") == Some(LocalState::Installed)).await;
    let runs = rig.runs();
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].program, Path::new(r"C:\Windows\System32\msiexec.exe"));
    let file = rig.paths.downloads_dir().join(format!("{}.msi", sha(bytes)));
    assert_eq!(runs[0].args[..2], ["/i".to_string(), file.to_string_lossy().into_owned()]);
    assert_eq!(runs[0].args[2..4], ["/qn", "/norestart"]);
    assert_eq!(rig.visible(std::slice::from_ref(&msi)), ["app7zip"]);
    assert!(rig.visible_calls.load(Ordering::SeqCst) >= 1, "apps.changed is triggered");
    let queued = rig.report.queued_installs();
    assert_eq!((queued.len(), queued[0].state, queued[0].attempts), (1, InstallState::Installed, 0));
    assert!(rig.downloads().is_empty(), "the installer is deleted after success");
    assert_eq!(rig.report.restart_pending(), None);
    rig.stop().await;
}

#[tokio::test(start_paused = true)]
async fn the_installer_file_is_locked_while_it_runs() {
    // TOCTOU: the verified file cannot be written while the installer runs.
    let mut rig = rig();
    rig.sim.with_world(|w| w.probe_lock = true);
    let bytes = b"exe installer";
    let exe = app("appexe", "exe", bytes, 1, false);
    rig.serve(&exe, bytes);
    rig.set_catalog(vec![exe.clone()]);
    rig.start();
    rig.until("installed", |r| r.state("appexe") == Some(LocalState::Installed)).await;
    assert_eq!(rig.sim.with_world(|w| w.lock_probes.clone()), [true]);
    let run = &rig.runs()[0];
    assert_eq!(run.program, rig.paths.downloads_dir().join(format!("{}.exe", sha(bytes))));
    assert_eq!(run.args, ["/S", r"/D=C:\Program Files\X Y"], "silent arguments one by one, unchanged");
    rig.stop().await;
}

#[tokio::test(start_paused = true)]
async fn exit_3010_sets_restart_pending_until_the_next_boot() {
    let mut rig = rig();
    let bytes = b"msi";
    let msi = app("a1", "msi", bytes, 1, true);
    rig.serve(&msi, bytes);
    rig.set_catalog(vec![msi]);
    rig.sim.with_world(|w| w.installer_exits.push_back(InstallerExit::Code(3010)));
    rig.start();
    rig.until("installed", |r| r.state("a1") == Some(LocalState::Installed)).await;
    assert_eq!(rig.report.restart_pending(), Some(true));
    let since = rig.book.snapshot().restart_pending_since_ms.unwrap();
    assert_eq!(rig.book.snapshot().restart_boot, Some(BootMark { boot_id: Some(100), uptime_ms: 3_600_000 }));
    assert_eq!(rig.record("a1").unwrap().last_exit_code, Some(3010));
    rig.stop().await;
    // Restarted before a reboot, after the clock was corrected forward (the old
    // "wall clock minus uptime" rule would have seen a boot after the 3010): still
    // pending, the boot counter did not change.
    rig.sim.with_world(|w| {
        w.boot_time_ms = since + 3_600_000;
        w.uptime_ms += 60_000;
    });
    let book = InstallBook::open(rig.paths.installs());
    rig.book = book;
    rig.start();
    rig.settle().await;
    assert_eq!(rig.report.restart_pending(), Some(true));
    rig.stop().await;
    // The PC booted after it (even with the clock set back): cleared.
    rig.sim.with_world(|w| {
        w.boot_id = Some(101);
        w.boot_time_ms = since - 3_600_000;
    });
    rig.start();
    rig.until("cleared", |r| r.report.restart_pending().is_none()).await;
    assert_eq!(rig.book.snapshot().restart_pending_since_ms, None);
    assert_eq!(rig.book.snapshot().restart_boot, None);
    rig.stop().await;
}

#[test]
fn a_reboot_is_seen_without_the_wall_clock() {
    let now = |boot_id, uptime_ms, boot_time_ms| BootIdentity { boot_id, uptime_ms, boot_time_ms };
    let mark = BootMark { boot_id: Some(7), uptime_ms: 600_000 };
    // The boot counter decides when both are known, whatever the clocks say.
    assert!(!rebooted_since(Some(&mark), 5_000, &now(Some(7), 10, 9_999_999)));
    assert!(rebooted_since(Some(&mark), 5_000, &now(Some(8), 9_999_999, 0)));
    // No counter: a smaller uptime can only be a new boot.
    let no_id = BootMark { boot_id: None, uptime_ms: 600_000 };
    assert!(rebooted_since(Some(&no_id), 5_000, &now(None, 30_000, 0)));
    assert!(rebooted_since(Some(&mark), 5_000, &now(None, 30_000, 0)));
    assert!(!rebooted_since(Some(&no_id), 5_000, &now(None, 700_000, 9_999_999)), "a clock jump is not a boot");
    // A record from before the mark: the old rule.
    assert!(rebooted_since(None, 5_000, &now(None, 1, 5_001)));
    assert!(!rebooted_since(None, 5_000, &now(Some(1), 1, 4_999)));
}

#[tokio::test(start_paused = true)]
async fn exit_1618_retries_without_counting() {
    let mut rig = rig();
    let bytes = b"msi";
    let msi = app("a1", "msi", bytes, 1, true);
    rig.serve(&msi, bytes);
    rig.set_catalog(vec![msi]);
    rig.sim.with_world(|w| w.installer_exits.push_back(InstallerExit::Code(1618)));
    rig.start();
    rig.until("first run", |r| r.runs().len() == 1).await;
    rig.settle().await;
    let record = rig.record("a1").unwrap();
    assert_eq!((record.state, record.attempts), (LocalState::Pending, 0));
    assert!(rig.report.queued_installs().iter().all(|r| r.state == InstallState::Pending), "busy is not reported");
    advance(Duration::from_secs(110)).await;
    rig.settle().await;
    assert_eq!(rig.runs().len(), 1, "not before 2 minutes");
    advance(Duration::from_secs(15)).await;
    rig.until("installed", |r| r.state("a1") == Some(LocalState::Installed)).await;
    assert_eq!(rig.record("a1").unwrap().attempts, 0);
    rig.stop().await;
}

/// Drives `n` failures of `id` (exit 1603), advancing through each backoff.
async fn fail_times(rig: &Rig, id: &str, n: usize) {
    for k in 1..=n {
        rig.until("a failed run", |r| r.runs().len() >= k && r.record(id).is_some_and(|x| x.attempts as usize == k)).await;
        let record = rig.record(id).unwrap();
        assert_eq!((record.state, record.last_exit_code), (LocalState::Failed, Some(1603)));
        assert_eq!(record.detail.as_deref(), Some("exit_code"));
        if let Some(wait) = backoff_after(k as u32) {
            advance(wait - Duration::from_secs(1)).await;
            rig.settle().await;
            assert_eq!(rig.runs().len(), k, "no retry before {wait:?}");
            advance(Duration::from_secs(2)).await;
        }
    }
}

#[tokio::test(start_paused = true)]
async fn failure_backs_off_1_5_15_60_360_then_stops() {
    let waits: Vec<u64> = (1..=6).map(|n| backoff_after(n).map_or(0, |d| d.as_secs() / 60)).collect();
    assert_eq!(waits, [1, 5, 15, 60, 360, 0]);
    let mut rig = rig();
    let bytes = b"msi";
    let msi = app("a1", "msi", bytes, 1, true);
    rig.serve(&msi, bytes);
    rig.set_catalog(vec![msi.clone()]);
    rig.sim.with_world(|w| w.installer_exits.extend(std::iter::repeat_n(InstallerExit::Code(1603), 6)));
    rig.start();
    fail_times(&rig, "a1", 6).await;
    advance(Duration::from_secs(7 * 24 * 3600)).await;
    rig.settle().await;
    assert_eq!(rig.runs().len(), 6, "final after the 6th failure");
    let queued = rig.report.queued_installs();
    assert_eq!((queued[0].state, queued[0].attempts, queued[0].exit_code), (InstallState::Failed, 6, Some(1603)));
    assert!(rig.downloads().is_empty(), "a final failure drops its download");
    assert!(rig.visible(&[msi]).is_empty());
    rig.stop().await;
}

#[tokio::test(start_paused = true)]
async fn new_revision_resets_attempts() {
    let mut rig = rig();
    let bytes = b"msi";
    let msi = app("a1", "msi", bytes, 1, true);
    rig.serve(&msi, bytes);
    rig.set_catalog(vec![msi]);
    rig.sim.with_world(|w| w.installer_exits.extend(std::iter::repeat_n(InstallerExit::Code(1603), 6)));
    rig.start();
    fail_times(&rig, "a1", 6).await;
    // The dashboard's Retry bumps the revision.
    rig.set_catalog(vec![app("a1", "msi", bytes, 2, true)]);
    rig.until("installed", |r| r.state("a1") == Some(LocalState::Installed)).await;
    let record = rig.record("a1").unwrap();
    assert_eq!((record.attempts, record.revision), (0, 2));
    rig.stop().await;
}

#[tokio::test(start_paused = true)]
async fn hash_mismatch_deletes_the_file() {
    let mut rig = rig();
    let mut msi = app("a1", "msi", b"the expected bytes", 1, true);
    // Size unknown, so the hash (not the size) is what refuses it.
    msi.desktop.as_mut().unwrap().install.as_mut().unwrap().size_bytes = 0;
    rig.serve(&msi, b"something else entirely");
    rig.set_catalog(vec![msi.clone()]);
    rig.start();
    rig.until("failed", |r| r.state("a1") == Some(LocalState::Failed)).await;
    assert_eq!(rig.record("a1").unwrap().detail.as_deref(), Some("hash_mismatch"));
    assert!(rig.runs().is_empty(), "nothing ran");
    assert!(rig.downloads().is_empty(), "nothing stays: {:?}", rig.downloads());
    assert!(rig.visible(&[msi]).is_empty());
    rig.stop().await;
}

#[tokio::test(start_paused = true)]
async fn a_tampered_cached_download_is_replaced() {
    let mut rig = rig();
    let bytes = b"good";
    let msi = app("a1", "msi", bytes, 1, true);
    std::fs::create_dir_all(rig.paths.downloads_dir()).unwrap();
    std::fs::write(rig.paths.downloads_dir().join(format!("{}.msi", sha(bytes))), b"planted").unwrap();
    rig.serve(&msi, bytes);
    rig.set_catalog(vec![msi]);
    rig.start();
    rig.until("installed", |r| r.state("a1") == Some(LocalState::Installed)).await;
    assert_eq!(rig.downloader.calls().len(), 1, "downloaded again, the planted file was not used");
    rig.stop().await;
}

#[tokio::test(start_paused = true)]
async fn size_over_limit_refused() {
    let mut rig = rig();
    let mut msi = app("a1", "msi", b"0123456789", 1, true);
    msi.desktop.as_mut().unwrap().install.as_mut().unwrap().size_bytes = 3;
    rig.serve(&msi, b"0123456789");
    rig.set_catalog(vec![msi]);
    rig.start();
    rig.until("failed", |r| r.state("a1") == Some(LocalState::Failed)).await;
    assert_eq!(rig.record("a1").unwrap().detail.as_deref(), Some("too_large"));
    assert!(rig.runs().is_empty() && rig.downloads().is_empty());
    rig.stop().await;
}

#[tokio::test(start_paused = true)]
async fn low_disk_refused() {
    let mut rig = rig();
    let bytes = vec![1u8; 1000];
    let msi = app("a1", "msi", &bytes, 1, true);
    rig.serve(&msi, &bytes);
    rig.sim.with_world(|w| w.disk_free_bytes = 2999);
    rig.set_catalog(vec![msi]);
    rig.start();
    rig.until("failed", |r| r.state("a1") == Some(LocalState::Failed)).await;
    assert_eq!(rig.record("a1").unwrap().detail.as_deref(), Some("low_disk"));
    assert!(rig.downloader.calls().is_empty(), "nothing downloaded");
    assert!(rig.runs().is_empty());
    rig.stop().await;
}

#[tokio::test(start_paused = true)]
async fn exe_missing_after_install_is_failure() {
    let mut rig = rig();
    let bytes = b"msi";
    let msi = app("a1", "msi", bytes, 1, true);
    rig.serve(&msi, bytes);
    rig.sim.with_world(|w| w.installer_creates_exe = false);
    rig.set_catalog(vec![msi.clone()]);
    rig.start();
    rig.until("ran", |r| r.runs().len() == 1).await;
    for _ in 0..12 {
        advance(Duration::from_secs(1)).await;
        rig.settle().await;
    }
    rig.until("failed", |r| r.state("a1") == Some(LocalState::Failed)).await;
    let record = rig.record("a1").unwrap();
    assert_eq!((record.detail.as_deref(), record.last_exit_code), (Some("exe_missing_after_install"), Some(0)));
    assert!(rig.visible(&[msi]).is_empty());
    rig.stop().await;
}

#[tokio::test(start_paused = true)]
async fn network_cut_retries_with_no_half_installed_tile() {
    let mut rig = rig();
    let bytes = b"msi";
    let msi = app("a1", "msi", bytes, 1, true);
    rig.serve(&msi, bytes);
    rig.downloader.fail_next(&install_of(&msi).unwrap().url, DownloadError::Network("connection reset".into()));
    rig.set_catalog(vec![msi.clone()]);
    rig.start();
    rig.until("failed", |r| r.state("a1") == Some(LocalState::Failed)).await;
    assert_eq!(rig.record("a1").unwrap().detail.as_deref(), Some("download_failed"));
    assert!(rig.visible(std::slice::from_ref(&msi)).is_empty(), "no tile");
    assert!(rig.downloads().is_empty(), "no partial file");
    advance(Duration::from_secs(61)).await;
    rig.until("installed", |r| r.state("a1") == Some(LocalState::Installed)).await;
    assert_eq!(rig.visible(&[msi]), ["a1"]);
    rig.stop().await;
}

#[tokio::test(start_paused = true)]
async fn offline_waits_for_the_connection_and_not_enrolled_does_nothing() {
    let mut rig = rig();
    let bytes = b"msi";
    let msi = app("a1", "msi", bytes, 1, true);
    rig.serve(&msi, bytes);
    rig.set_catalog(vec![msi]);
    rig.snapshot_tx.send_modify(|s| s.enrollment = EnrollmentStatus::NotEnrolled);
    rig.start();
    rig.settle().await;
    assert!(rig.record("a1").is_none() && rig.downloader.calls().is_empty());
    rig.snapshot_tx.send_modify(|s| {
        s.enrollment = EnrollmentStatus::Enrolled;
        s.connection = ConnectionStatus::Offline;
    });
    rig.until("pending", |r| r.state("a1") == Some(LocalState::Pending)).await;
    advance(Duration::from_secs(3600)).await;
    rig.settle().await;
    assert!(rig.downloader.calls().is_empty(), "no download while offline");
    rig.snapshot_tx.send_modify(|s| s.connection = ConnectionStatus::Online);
    rig.until("installed", |r| r.state("a1") == Some(LocalState::Installed)).await;
    rig.stop().await;
}

#[tokio::test(start_paused = true)]
async fn new_sha_triggers_reinstall() {
    let mut rig = rig();
    let msi = app("a1", "msi", b"v1", 1, true);
    rig.serve(&msi, b"v1");
    rig.set_catalog(vec![msi]);
    rig.start();
    rig.until("v1", |r| r.state("a1") == Some(LocalState::Installed)).await;
    let v2 = app("a1", "msi", b"v2", 2, true);
    rig.serve(&v2, b"v2");
    rig.downloader.hold();
    rig.report.accept_installs();
    rig.set_catalog(vec![v2.clone()]);
    rig.until("pending v2", |r| r.record("a1").is_some_and(|x| x.sha256 == sha(b"v2"))).await;
    // (Phase 6 Step 11) The old version works while the new one downloads: the tile stays, and only terminal states go
    // out for an upgrade (no `pending`).
    rig.settle().await;
    assert_eq!(rig.visible(std::slice::from_ref(&v2)), ["a1"], "the installed app keeps its tile while its update downloads");
    assert!(rig.report.queued_installs().is_empty(), "no progress state for an upgrade: {:?}", rig.report.queued_installs());
    rig.stop().await;
    rig.downloader = FakeDownloader::new();
    rig.serve(&v2, b"v2");
    rig.start();
    rig.until("v2", |r| r.state("a1") == Some(LocalState::Installed)).await;
    assert_eq!(rig.runs().len(), 2);
    assert_eq!(rig.visible(&[v2]), ["a1"]);
    rig.stop().await;
}

#[tokio::test(start_paused = true)]
async fn unassigned_msi_with_remove_flag_uninstalls() {
    let mut rig = rig();
    let msi = app("a1", "msi", b"m", 1, true);
    rig.serve(&msi, b"m");
    rig.set_catalog(vec![msi.clone()]);
    rig.start();
    rig.until("installed", |r| r.state("a1") == Some(LocalState::Installed)).await;
    assert!(rig.sim.file_exists(&exe_of(&msi)));
    rig.report.accept_installs();
    rig.set_catalog(Vec::new());
    rig.until("removed", |r| r.state("a1") == Some(LocalState::Removed)).await;
    let runs = rig.runs();
    assert_eq!(runs[1].args[..4], ["/x", CODE, "/qn", "/norestart"]);
    assert!(runs[1].removal);
    assert!(!rig.sim.file_exists(&exe_of(&msi)));
    let acked = rig.report.accept_installs();
    assert_eq!(acked[0].state, InstallState::Removed);
    assert!(rig.record("a1").is_none(), "forgotten once the server took it");
    rig.stop().await;
}

#[tokio::test(start_paused = true)]
async fn unassigned_exe_is_only_hidden() {
    let mut rig = rig();
    let exe = app("a1", "exe", b"e", 1, true);
    let msi_no_flag = app("a2", "msi", b"m", 1, false);
    rig.serve(&exe, b"e");
    rig.serve(&msi_no_flag, b"m");
    rig.set_catalog(vec![exe.clone(), msi_no_flag.clone()]);
    rig.start();
    rig.until("installed", |r| r.state("a1") == Some(LocalState::Installed) && r.state("a2") == Some(LocalState::Installed)).await;
    rig.report.accept_installs();
    rig.set_catalog(Vec::new());
    rig.until("dropped", |r| r.record("a1").is_none() && r.record("a2").is_none()).await;
    rig.settle().await;
    assert_eq!(rig.runs().len(), 2, "nothing was uninstalled");
    assert!(rig.sim.file_exists(&exe_of(&exe)) && rig.sim.file_exists(&exe_of(&msi_no_flag)));
    assert!(rig.report.queued_installs().is_empty(), "nothing reported");
    rig.stop().await;
}

#[tokio::test(start_paused = true)]
async fn portable_placed_and_removed() {
    let mut rig = rig();
    let portable = app("a1", "portable", b"tool", 1, true);
    rig.serve(&portable, b"tool");
    rig.set_catalog(vec![portable.clone()]);
    rig.start();
    rig.until("installed", |r| r.state("a1") == Some(LocalState::Installed)).await;
    let exe = exe_of(&portable);
    assert_eq!(exe, Path::new(r"C:\Program Files\Rulebox\apps\a1\tool.exe"));
    assert!(rig.sim.file_exists(&exe));
    assert!(rig.runs().is_empty(), "a portable app runs no installer");
    assert_eq!(rig.visible(std::slice::from_ref(&portable)), ["a1"]);
    rig.set_catalog(Vec::new());
    rig.until("removed", |r| r.state("a1") == Some(LocalState::Removed)).await;
    assert!(!rig.sim.file_exists(&exe));
    let calls = rig.sim.calls();
    assert!(calls.contains(&SimOp::PlacePortable) && calls.contains(&SimOp::RemovePortable));
    rig.stop().await;
}

#[tokio::test(start_paused = true)]
async fn deny_listed_program_refused_and_preinstalled_needs_nothing() {
    let mut rig = rig();
    let mut denied = app("a1", "exe", b"e", 1, false);
    denied.desktop.as_mut().unwrap().exe = r"{ProgramFiles}\PowerShell\7\pwsh.exe".into();
    rig.serve(&denied, b"e");
    let already = app("a2", "msi", b"m", 1, true);
    rig.sim.add_file(exe_of(&already).to_str().unwrap());
    rig.set_catalog(vec![denied.clone(), already.clone()]);
    rig.start();
    rig.until("both settled", |r| r.state("a1") == Some(LocalState::Unsupported) && r.state("a2") == Some(LocalState::Installed)).await;
    assert_eq!(rig.record("a1").unwrap().detail.as_deref(), Some("unsupported"));
    rig.settle().await;
    assert!(rig.downloader.calls().is_empty() && rig.runs().is_empty(), "nothing downloaded or run");
    rig.stop().await;
}

#[tokio::test(start_paused = true)]
async fn one_operation_at_a_time_and_revoked_stops_after_current_operation() {
    let mut rig = rig();
    let a = app("a1", "msi", b"a", 1, true);
    let b = app("a2", "msi", b"b", 1, true);
    rig.serve(&a, b"a");
    rig.serve(&b, b"b");
    let gate = rig.downloader.hold();
    rig.set_catalog(vec![a.clone(), b.clone()]);
    rig.start();
    rig.until("first download started", |r| r.downloader.calls().len() == 1).await;
    rig.settle().await;
    assert_eq!(rig.downloader.calls().len(), 1, "one at a time");
    assert!(rig.runs().is_empty());
    // Revoked while the first one runs: it finishes, nothing new starts.
    rig.snapshot_tx.send_modify(|s| s.enrollment = EnrollmentStatus::Revoked);
    gate.add_permits(1);
    rig.until("first installed", |r| r.state("a1") == Some(LocalState::Installed)).await;
    gate.add_permits(10);
    advance(Duration::from_secs(3600)).await;
    rig.settle().await;
    assert_eq!(rig.downloader.calls().len(), 1);
    assert_eq!(rig.state("a2"), Some(LocalState::Pending));
    rig.stop().await;
}

#[tokio::test(start_paused = true)]
async fn reports_only_accepted_and_terminal_unacknowledged_transitions() {
    let mut rig = rig();
    let msi = app("a1", "msi", b"m", 1, true);
    rig.serve(&msi, b"m");
    let gate = rig.downloader.hold();
    rig.set_catalog(vec![msi.clone()]);
    let exe = exe_of(&msi).to_string_lossy().into_owned();
    rig.start();
    rig.until("download started", |r| r.downloader.calls().len() == 1).await;
    // While downloading: only the accepted job.
    let queued = rig.report.queued_installs();
    assert_eq!(queued.iter().map(|r| r.state).collect::<Vec<_>>(), [InstallState::Pending]);
    rig.report.accept_installs();
    assert!(rig.record("a1").unwrap().acked);
    gate.add_permits(1);
    rig.until("installed", |r| r.state("a1") == Some(LocalState::Installed)).await;
    assert_eq!(rig.report.queued_installs().iter().map(|r| r.state).collect::<Vec<_>>(), [InstallState::Installed]);
    rig.stop().await;
    // Not acknowledged: sent again after a restart (new queue, same file).
    let dir = std::mem::replace(&mut rig.dir, TempDir::new());
    let mut again = rig_in(dir);
    // A new simulated machine: the installed program is still on it.
    again.sim.add_file(&exe);
    again.set_catalog(vec![msi.clone()]);
    again.start();
    again.until("re-sent", |r| r.report.queued_installs().len() == 1).await;
    again.report.accept_installs();
    again.stop().await;
    // Acknowledged: never again.
    let dir = std::mem::replace(&mut again.dir, TempDir::new());
    let mut third = rig_in(dir);
    third.sim.add_file(&exe);
    third.set_catalog(vec![msi]);
    third.start();
    third.settle().await;
    assert!(third.report.queued_installs().is_empty());
    third.stop().await;
}

#[tokio::test(start_paused = true)]
async fn crash_recovery_counts_an_interrupted_install_and_restarts_a_download() {
    let dir = TempDir::new();
    let paths = DataPaths::new(dir.path().to_path_buf());
    std::fs::create_dir_all(paths.state_dir()).unwrap();
    std::fs::create_dir_all(paths.downloads_dir()).unwrap();
    let a = app("a1", "msi", b"a", 1, true);
    let b = app("a2", "msi", b"b", 1, true);
    let mut file = InstallsFile::default();
    let mut ra = InstallRecord::new("a1", RecordKind::Msi, &sha(b"a"), 1, LocalState::Installing);
    ra.exe = Some(exe_of(&a).to_string_lossy().into_owned());
    let rb = InstallRecord::new("a2", RecordKind::Msi, &sha(b"b"), 1, LocalState::Downloading);
    file.apps.insert("a1".into(), ra);
    file.apps.insert("a2".into(), rb);
    std::fs::write(paths.installs(), serde_json::to_vec(&file).unwrap()).unwrap();
    std::fs::write(paths.downloads_dir().join(format!("{}.msi.part", sha(b"b"))), b"half").unwrap();
    let mut rig = rig_in(dir);
    rig.serve(&a, b"a");
    rig.serve(&b, b"b");
    rig.set_catalog(vec![a, b]);
    let gate = rig.downloader.hold();
    rig.start();
    // a2 (was downloading) restarts without a counted failure ...
    rig.until("a2 downloading again", |r| r.downloader.calls().len() == 1).await;
    let ra = rig.record("a1").unwrap();
    assert_eq!((ra.state, ra.attempts), (LocalState::Failed, 1), "the interrupted install counts");
    assert_eq!(rig.record("a2").unwrap().attempts, 0);
    // The stale `.part` of the interrupted download was deleted at start (the held
    // fetch has not written yet).
    assert!(!rig.downloads().iter().any(|n| n.ends_with(".part")), "{:?}", rig.downloads());
    assert!(rig.report.queued_installs().iter().any(|r| r.app_id == "a1" && r.state == InstallState::Failed));
    gate.add_permits(10);
    rig.until("a2 installed", |r| r.state("a2") == Some(LocalState::Installed)).await;
    // ... and a1 is retried after its backoff.
    advance(Duration::from_secs(61)).await;
    rig.until("a1 installed", |r| r.state("a1") == Some(LocalState::Installed)).await;
    rig.stop().await;
}

#[tokio::test(start_paused = true)]
async fn no_document_or_a_broken_catalogue_removes_nothing() {
    let mut rig = rig();
    let msi = app("a1", "msi", b"m", 1, true);
    rig.serve(&msi, b"m");
    rig.set_catalog(vec![msi]);
    rig.start();
    rig.until("installed", |r| r.state("a1") == Some(LocalState::Installed)).await;
    rig.policy_tx.send_modify(|p| {
        p.catalog.clear();
        p.catalog_problem = Some("catalog_invalid".into());
    });
    rig.settle().await;
    rig.policy_tx.send_modify(|p| {
        p.catalog_problem = None;
        p.has_document = false;
    });
    rig.settle().await;
    assert_eq!(rig.state("a1"), Some(LocalState::Installed));
    assert_eq!(rig.runs().len(), 1);
    rig.stop().await;
}

#[test]
fn http_url_and_bad_specs_are_unsupported() {
    let roots = crate::platform::sim::sim_path_roots();
    let good = app("a1", "msi", b"m", 1, true);
    assert!(check_spec(&good, &roots).is_ok());
    let mut http = good.clone();
    http.desktop.as_mut().unwrap().install.as_mut().unwrap().url = "http://downloads.example.com/a.msi".into();
    assert!(check_spec(&http, &roots).is_err());
    let mut code = good.clone();
    code.desktop.as_mut().unwrap().install.as_mut().unwrap().product_code = Some("{x} /qb".into());
    assert!(check_spec(&code, &roots).is_err());
    let mut exe = app("a2", "exe", b"e", 1, true);
    exe.desktop.as_mut().unwrap().install.as_mut().unwrap().silent_args.clear();
    assert!(check_spec(&exe, &roots).is_err(), "an exe needs silent arguments");
    let mut control = app("a2", "exe", b"e", 1, true);
    control.desktop.as_mut().unwrap().install.as_mut().unwrap().silent_args = vec!["/S\r\ncalc".into()];
    assert!(check_spec(&control, &roots).is_err());
    let mut id = good.clone();
    id.id = r"..\..\x".into();
    assert!(check_spec(&id, &roots).is_err());
    // An exe is never removable, whatever the catalogue says.
    assert!(!check_spec(&app("a3", "exe", b"e", 1, true), &roots).unwrap().remove_when_unassigned);
}

#[test]
fn program_outside_downloads_refused_by_the_simulated_platform() {
    let dir = TempDir::new();
    let sim = SimPlatform::new(dir.path().to_path_buf());
    let cmd = InstallerCommand {
        program: PathBuf::from(r"C:\Windows\System32\cmd.exe"),
        args: vec!["/c".into(), "calc".into()],
        working_dir: dir.path().to_path_buf(),
        expected_exe: None,
        removal: false,
    };
    assert!(matches!(sim.run_installer(&cmd, Duration::from_secs(1), &CancellationToken::new()), Err(PlatformError::Other(_))));
    assert!(sim.with_world(|w| w.installer_runs.is_empty()));
}

// --- Review fixes (security review of Step 14) ---

#[tokio::test(start_paused = true)]
async fn a_program_found_on_the_pc_is_never_uninstalled() {
    // Finding 1: an MSI with a product code and removeWhenUnassigned, already at its
    // path: shown as installed, but Rulebox never runs `msiexec /x` on it.
    let mut rig = rig();
    let msi = app("a1", "msi", b"m", 1, true);
    let portable = app("a2", "portable", b"p", 1, true);
    rig.sim.add_file(exe_of(&msi).to_str().unwrap());
    rig.sim.add_file(exe_of(&portable).to_str().unwrap());
    rig.set_catalog(vec![msi.clone(), portable.clone()]);
    rig.start();
    rig.until("found", |r| r.state("a1") == Some(LocalState::Installed) && r.state("a2") == Some(LocalState::Installed)).await;
    assert!(rig.record("a1").unwrap().preexisting && rig.record("a2").unwrap().preexisting);
    assert_eq!(rig.visible(&[msi.clone(), portable.clone()]), ["a1", "a2"], "the tiles show as before");
    rig.report.accept_installs();
    rig.set_catalog(Vec::new());
    rig.until("dropped", |r| r.record("a1").is_none() && r.record("a2").is_none()).await;
    rig.settle().await;
    assert!(rig.runs().is_empty(), "no msiexec /x");
    assert!(!rig.sim.calls().contains(&SimOp::RemovePortable), "no portable delete");
    assert!(rig.sim.file_exists(&exe_of(&msi)) && rig.sim.file_exists(&exe_of(&portable)));
    assert!(rig.report.queued_installs().is_empty(), "nothing reported");
    rig.stop().await;
}

#[tokio::test(start_paused = true)]
async fn the_preexisting_mark_survives_a_new_version_and_a_removal_round_trip() {
    let mut rig = rig();
    let v1 = app("a1", "msi", b"v1", 1, true);
    rig.sim.add_file(exe_of(&v1).to_str().unwrap());
    rig.set_catalog(vec![v1]);
    rig.start();
    rig.until("found", |r| r.state("a1") == Some(LocalState::Installed)).await;
    // A new version is installed over it by Rulebox: still never removed.
    let v2 = app("a1", "msi", b"v2", 2, true);
    rig.serve(&v2, b"v2");
    rig.set_catalog(vec![v2.clone()]);
    rig.until("v2", |r| r.record("a1").is_some_and(|x| x.sha256 == sha(b"v2") && x.state == LocalState::Installed)).await;
    assert!(rig.record("a1").unwrap().preexisting, "never cleared");
    rig.set_catalog(Vec::new());
    rig.until("dropped", |r| r.record("a1").is_none()).await;
    assert_eq!(rig.runs().len(), 1, "only the install ran, no removal");

    // Rulebox installs a3 itself, removes it when unassigned, and someone puts it
    // back before it is assigned again: found, so preexisting from then on.
    let a3 = app("a3", "msi", b"m3", 1, true);
    rig.serve(&a3, b"m3");
    rig.set_catalog(vec![a3.clone()]);
    rig.until("a3 installed", |r| r.state("a3") == Some(LocalState::Installed)).await;
    assert!(!rig.record("a3").unwrap().preexisting);
    rig.set_catalog(Vec::new());
    rig.until("a3 removed", |r| r.state("a3") == Some(LocalState::Removed)).await;
    rig.sim.add_file(exe_of(&a3).to_str().unwrap());
    rig.set_catalog(vec![a3]);
    rig.until("a3 found", |r| r.state("a3") == Some(LocalState::Installed)).await;
    assert!(rig.record("a3").unwrap().preexisting);
    rig.stop().await;
}

/// A record as an agent before the review wrote it (no `preexisting`, `onPc`,
/// `busySinceMs`).
fn legacy_json(record: &InstallRecord) -> serde_json::Value {
    let mut value = serde_json::to_value(record).unwrap();
    let object = value.as_object_mut().unwrap();
    for key in ["preexisting", "onPc", "busySinceMs"] {
        assert!(object.remove(key).is_some(), "{key} is written");
    }
    value
}

#[tokio::test(start_paused = true)]
async fn a_record_from_before_the_mark_is_never_removed() {
    // Back-compatibility: an old `installed` record with no attempts may be a
    // program Rulebox found (the old code did not say), so a record without the
    // field is treated as found. Rulebox-installed apps of that age are then only
    // hidden when unassigned (the safe side; nothing was shipped with the old file).
    let dir = TempDir::new();
    let paths = DataPaths::new(dir.path().to_path_buf());
    std::fs::create_dir_all(paths.state_dir()).unwrap();
    let a = app("a1", "msi", b"a", 1, true);
    let b = app("a2", "msi", b"b", 1, true);
    let mut ra = InstallRecord::new("a1", RecordKind::Msi, &sha(b"a"), 1, LocalState::Installed);
    ra.exe = Some(exe_of(&a).to_string_lossy().into_owned());
    ra.product_code = Some(CODE.into());
    ra.remove_when_unassigned = true;
    // An old removal already queued (the old code queued found programs too).
    let mut rb = InstallRecord::new("a2", RecordKind::Msi, &sha(b"b"), 1, LocalState::Removing);
    rb.exe = Some(exe_of(&b).to_string_lossy().into_owned());
    rb.product_code = Some(CODE.into());
    rb.remove_when_unassigned = true;
    rb.removal = true;
    let file = json!({ "schema": 1, "restartPendingSinceMs": null, "apps": { "a1": legacy_json(&ra), "a2": legacy_json(&rb) } });
    std::fs::write(paths.installs(), serde_json::to_vec(&file).unwrap()).unwrap();
    let book = InstallBook::open(paths.installs());
    let loaded = book.snapshot();
    assert!(loaded.apps.values().all(|r| r.preexisting && !r.on_pc && r.busy_since_ms.is_none()));
    assert_eq!(loaded.restart_boot, None);
    drop(book);

    let mut rig = rig_in(dir);
    rig.sim.add_file(exe_of(&a).to_str().unwrap());
    rig.sim.add_file(exe_of(&b).to_str().unwrap());
    rig.start();
    rig.until("both dropped", |r| r.record("a1").is_none() && r.record("a2").is_none()).await;
    rig.settle().await;
    assert!(rig.runs().is_empty(), "no msiexec /x for a program of unknown origin");
    // A record written now says what it is.
    let fresh = InstallRecord::new("a3", RecordKind::Msi, &sha(b"c"), 1, LocalState::Pending);
    let back: InstallRecord = serde_json::from_value(serde_json::to_value(&fresh).unwrap()).unwrap();
    assert_eq!(back, fresh);
    assert!(!back.preexisting);
    rig.stop().await;
}

#[tokio::test(start_paused = true)]
async fn an_installed_app_that_turns_unsupported_is_still_removed_when_unassigned() {
    // Finding 7: the version on the PC is carried into the `unsupported` record.
    let mut rig = rig();
    let msi = app("a1", "msi", b"m", 1, true);
    rig.serve(&msi, b"m");
    rig.set_catalog(vec![msi.clone()]);
    rig.start();
    rig.until("installed", |r| r.state("a1") == Some(LocalState::Installed)).await;
    let mut broken = app("a1", "msi", b"m", 2, true);
    broken.desktop.as_mut().unwrap().install.as_mut().unwrap().url = "http://downloads.example.com/a.msi".into();
    rig.set_catalog(vec![broken]);
    rig.until("unsupported", |r| r.state("a1") == Some(LocalState::Unsupported)).await;
    let record = rig.record("a1").unwrap();
    assert!(record.on_pc && !record.preexisting);
    rig.set_catalog(Vec::new());
    rig.until("removed", |r| r.state("a1") == Some(LocalState::Removed)).await;
    assert_eq!(rig.runs()[1].args[..2], ["/x", CODE]);
    rig.stop().await;

    // A found program that turns unsupported is still never removed.
    let mut rig = self::rig();
    let found = app("a2", "msi", b"f", 1, true);
    rig.sim.add_file(exe_of(&found).to_str().unwrap());
    rig.set_catalog(vec![found]);
    rig.start();
    rig.until("found", |r| r.state("a2") == Some(LocalState::Installed)).await;
    let mut broken = app("a2", "msi", b"f", 2, true);
    broken.desktop.as_mut().unwrap().install.as_mut().unwrap().url = "http://downloads.example.com/f.msi".into();
    rig.set_catalog(vec![broken]);
    rig.until("unsupported", |r| r.state("a2") == Some(LocalState::Unsupported)).await;
    assert!(rig.record("a2").unwrap().preexisting);
    rig.set_catalog(Vec::new());
    rig.until("dropped", |r| r.record("a2").is_none()).await;
    assert!(rig.runs().is_empty());
    rig.stop().await;
}

#[tokio::test(start_paused = true)]
async fn busy_is_retried_for_two_hours_then_counted_as_exit_code() {
    // Finding 9: 1618 forever no longer retries forever, and `busy` never goes out.
    let mut rig = rig();
    let msi = app("a1", "msi", b"m", 1, true);
    rig.serve(&msi, b"m");
    rig.set_catalog(vec![msi]);
    rig.sim.with_world(|w| w.installer_exits.extend(std::iter::repeat_n(InstallerExit::Code(1618), 100)));
    rig.start();
    let mut last_try = 0;
    for _ in 0..70 {
        // The run was written down (a new retry time, or the counted failure).
        rig.until("busy recorded", |r| {
            r.record("a1").is_some_and(|x| x.next_try_ms > last_try || x.state == LocalState::Failed)
        })
        .await;
        let record = rig.record("a1").unwrap();
        if record.state == LocalState::Failed {
            break;
        }
        assert_eq!(record.attempts, 0, "not counted while busy");
        assert!(record.busy_since_ms.is_some());
        last_try = record.next_try_ms;
        advance(BUSY_RETRY + Duration::from_secs(1)).await;
    }
    let record = rig.record("a1").unwrap();
    assert_eq!((record.attempts, record.last_exit_code, record.detail.as_deref()), (1, Some(1618), Some("exit_code")));
    assert_eq!(record.busy_since_ms, None);
    assert!((60..=62).contains(&rig.runs().len()), "{} runs", rig.runs().len());
    assert!(rig.report.queued_installs().iter().all(|r| r.detail.as_deref() != Some("busy")));
    rig.stop().await;
}

#[tokio::test(start_paused = true)]
async fn a_running_portable_program_makes_the_upgrade_wait_not_fail() {
    // Finding 10: the old exe is running (sharing violation at the rename).
    let mut rig = rig();
    let portable = app("a1", "portable", b"tool", 1, true);
    rig.serve(&portable, b"tool");
    rig.sim.fail_next(SimOp::PlacePortable, PlatformError::InUse);
    rig.set_catalog(vec![portable]);
    rig.start();
    rig.until("busy", |r| r.record("a1").is_some_and(|x| x.busy_since_ms.is_some())).await;
    let record = rig.record("a1").unwrap();
    assert_eq!((record.state, record.attempts), (LocalState::Pending, 0));
    advance(BUSY_RETRY + Duration::from_secs(1)).await;
    rig.until("installed", |r| r.state("a1") == Some(LocalState::Installed)).await;
    assert_eq!(rig.record("a1").unwrap().busy_since_ms, None);
    // Its removal while it runs waits the same way.
    rig.sim.fail_next(SimOp::RemovePortable, PlatformError::InUse);
    rig.set_catalog(Vec::new());
    rig.until("removal busy", |r| r.record("a1").is_some_and(|x| x.busy_since_ms.is_some() && x.state == LocalState::Removing)).await;
    advance(BUSY_RETRY + Duration::from_secs(1)).await;
    rig.until("removed", |r| r.state("a1") == Some(LocalState::Removed)).await;
    rig.stop().await;
}

#[tokio::test(start_paused = true)]
async fn stopping_the_agent_ends_the_installer_and_does_not_count_it() {
    // Finding 5: the install step follows `shutdown`; the run is not a failure.
    let mut rig = rig();
    let msi = app("a1", "msi", b"m", 1, true);
    rig.serve(&msi, b"m");
    rig.set_catalog(vec![msi]);
    rig.sim.with_world(|w| w.installer_hangs = true);
    rig.start();
    rig.until("running", |r| r.runs().len() == 1 && r.state("a1") == Some(LocalState::Installing)).await;
    rig.stop().await;
    let record = rig.record("a1").unwrap();
    assert_eq!((record.state, record.attempts), (LocalState::Pending, 0), "back to waiting, not counted");
    assert!(rig.report.queued_installs().iter().all(|r| r.state != InstallState::Failed));
    // The next start installs it.
    rig.sim.with_world(|w| w.installer_hangs = false);
    rig.start();
    rig.until("installed", |r| r.state("a1") == Some(LocalState::Installed)).await;
    assert_eq!(rig.record("a1").unwrap().attempts, 0);
    rig.stop().await;
}

#[tokio::test(start_paused = true)]
async fn a_download_that_drips_forever_ends_at_its_deadline() {
    // Finding 4: a total deadline, not only a gap between reads.
    let mut rig = rig();
    let bytes = vec![3u8; 4096];
    let msi = app("a1", "msi", &bytes, 1, true);
    rig.serve(&msi, &bytes);
    let _gate = rig.downloader.hold();
    rig.set_catalog(vec![msi]);
    rig.start();
    rig.until("downloading", |r| r.downloader.calls().len() == 1).await;
    let deadline = download_deadline(4096);
    advance(deadline - Duration::from_secs(1)).await;
    rig.settle().await;
    assert_eq!(rig.state("a1"), Some(LocalState::Downloading), "still within its time");
    advance(Duration::from_secs(2)).await;
    rig.until("failed", |r| r.state("a1") == Some(LocalState::Failed)).await;
    assert_eq!(rig.record("a1").unwrap().detail.as_deref(), Some("download_failed"));
    assert!(rig.downloads().is_empty(), "no partial file");
    rig.stop().await;
}

#[tokio::test(start_paused = true)]
async fn an_unknown_size_still_checks_the_disk() {
    // Finding 6: `sizeBytes` 0 checks for the 4 GiB a download may write.
    let mut rig = rig();
    let mut msi = app("a1", "msi", b"m", 1, true);
    msi.desktop.as_mut().unwrap().install.as_mut().unwrap().size_bytes = 0;
    rig.serve(&msi, b"m");
    rig.sim.with_world(|w| w.disk_free_bytes = 3 * 1024 * 1024 * 1024);
    rig.set_catalog(vec![msi]);
    rig.start();
    rig.until("failed", |r| r.state("a1") == Some(LocalState::Failed)).await;
    assert_eq!(rig.record("a1").unwrap().detail.as_deref(), Some("low_disk"));
    assert!(rig.downloader.calls().is_empty(), "nothing downloaded");
    rig.stop().await;
}

#[tokio::test(start_paused = true)]
async fn installer_temp_folders_left_by_a_crash_are_deleted_at_start() {
    // Finding 2: the per-run TEMP folders do not pile up.
    let mut rig = rig();
    let left = rig.paths.installer_temp_dir().join("run-0123456789abcdef");
    std::fs::create_dir_all(&left).unwrap();
    std::fs::write(left.join("is-ABC.tmp"), b"x").unwrap();
    rig.start();
    rig.until("swept", |_| !left.exists()).await;
    rig.stop().await;
}

#[test]
fn a_corrupt_installs_file_is_moved_aside() {
    let dir = TempDir::new();
    let path = dir.path().join("installs.json");
    std::fs::write(&path, "{ not json").unwrap();
    let book = InstallBook::open(path.clone());
    assert!(book.snapshot().apps.is_empty());
    assert!(!path.exists(), "moved aside");
}

// ---------------------------------------------------------------- Phase 5 Step 14b: drivers

use crate::installs::drivers_rules::{DriverRecord, DriverRecordKind};
use crate::platform::FileIdentity;
use rulebox_policy::network::{DriverKind, DriverSpec};

fn zip_bytes(entries: &[(&str, &[u8])]) -> Vec<u8> {
    use std::io::Write;
    let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    for (name, bytes) in entries {
        writer.start_file(*name, options).unwrap();
        writer.write_all(bytes).unwrap();
    }
    writer.finish().unwrap().into_inner()
}

fn inf_text(catalogs: &[&str]) -> String {
    let mut text = String::from("[Version]\r\nSignature=\"$Windows NT$\"\r\nClass=Printer\r\n");
    for name in catalogs {
        text.push_str(&format!("CatalogFile={name}\r\n"));
    }
    text.push_str("[Manufacturer]\r\n\"Brother\"=Brother,NTamd64\r\n");
    text
}

/// A package whose INF is `x64/b.inf` and names `b.cat`.
fn good_zip() -> Vec<u8> {
    zip_bytes(&[("x64/b.inf", inf_text(&["b.cat"]).as_bytes()), ("x64/b.cat", b"cat"), ("x64/b.sys", b"sys")])
}

fn driver(id: &str, kind: DriverKind, bytes: &[u8], revision: u64) -> DriverSpec {
    DriverSpec {
        id: id.into(),
        name: format!("Driver {id}"),
        kind,
        url: url(id, bytes),
        sha256: sha(bytes),
        size_bytes: bytes.len() as u64,
        inf: (kind == DriverKind::Inf).then(|| "x64/b.inf".to_string()),
        silent_args: if kind == DriverKind::Exe { vec!["/S".into(), "/quiet".into()] } else { Vec::new() },
        success_exit_codes: vec![0],
        revision,
        source: None,
    }
}

impl Rig {
    fn set_drivers(&self, drivers: Vec<DriverSpec>) {
        self.policy_tx.send_modify(|p| p.drivers = drivers);
    }

    fn serve_driver(&self, spec: &DriverSpec, bytes: &[u8]) {
        self.downloader.serve(&spec.url, bytes);
    }

    fn driver_record(&self, id: &str) -> Option<DriverRecord> {
        self.book.snapshot().drivers.get(id).cloned()
    }

    fn driver_state(&self, id: &str) -> Option<LocalState> {
        self.driver_record(id).map(|r| r.state)
    }

    /// Marks `x64/<name>` of the package with this SHA-256 as validly signed.
    fn sign(&self, zip_sha: &str, name: &str) {
        let path = self.paths.driver_work_dir(zip_sha).join("x64").join(name);
        let identity = FileIdentity { signer: Some("CN=Vendor, O=Vendor Ltd".into()), original_name: None, product: None };
        self.sim.add_program(&path.to_string_lossy(), identity, None);
    }

    fn journal_ids(&self) -> Vec<String> {
        self.shared.read(|state| state.journal.iter().map(|entry| entry.id.clone()).collect())
    }

    fn store(&self) -> Vec<String> {
        self.sim.with_world(|w| w.driver_store.iter().cloned().collect())
    }

    fn deletes(&self) -> Vec<String> {
        self.sim.with_world(|w| w.driver_deletes.clone())
    }

    fn work_dir_exists(&self) -> bool {
        self.paths.drivers_dir().join("work").exists() && std::fs::read_dir(self.paths.drivers_dir().join("work")).is_ok_and(|mut d| d.next().is_some())
    }

    /// The reports the server would get for `id`, the last one first.
    fn driver_reports(&self, id: &str) -> Vec<crate::backend::InstallReport> {
        self.report.queued_installs().into_iter().filter(|r| r.app_id == id).collect()
    }
}

const OEM_SHA_A: &str = "1111111111111111111111111111111111111111111111111111111111111111";

#[tokio::test(start_paused = true)]
async fn an_inf_driver_is_installed_with_pnputil_journalled_and_is_never_a_tile() {
    let mut rig = rig();
    let bytes = good_zip();
    let spec = driver("drv1", DriverKind::Inf, &bytes, 1);
    rig.serve_driver(&spec, &bytes);
    rig.sign(&spec.sha256, "b.cat");
    rig.set_drivers(vec![spec.clone()]);
    rig.start();
    rig.until("installed", |r| r.driver_state("drv1") == Some(LocalState::Installed)).await;

    let runs = rig.runs();
    assert_eq!(runs.len(), 1);
    let work = rig.paths.driver_work_dir(&spec.sha256);
    assert_eq!(runs[0].program, Path::new(r"C:\Windows\System32\pnputil.exe"));
    assert_eq!(runs[0].args, ["/add-driver".to_string(), work.join("x64").join("b.inf").to_string_lossy().into_owned(), "/install".to_string()]);
    assert_eq!(runs[0].expected_exe, None);
    assert_eq!(rig.store(), ["oem1.inf"]);
    let record = rig.driver_record("drv1").unwrap();
    assert_eq!(record.packages.len(), 1);
    assert_eq!(record.packages[0].published, "oem1.inf");
    assert_eq!(rig.journal_ids(), ["driver:drv1:oem1.inf"]);
    // Nothing of the run is left on disk, and the zip is deleted after success.
    assert!(!rig.work_dir_exists(), "the extraction folder is deleted");
    assert!(rig.downloads().is_empty());
    // Reported under the driver's id, like an app's result.
    let reports = rig.driver_reports("drv1");
    assert_eq!((reports.len(), reports[0].state, reports[0].attempts, reports[0].exit_code), (1, InstallState::Installed, 0, None));
    // Never a tile: no app is installed or visible, and the apps' records are untouched.
    assert!(rig.book.installed_ids().is_empty());
    assert!(rig.book.snapshot().apps.is_empty());
    assert_eq!(rig.visible_calls.load(Ordering::SeqCst), 0, "no apps.changed for a driver");
    rig.stop().await;
}

async fn refused_as(detail: &str, zip: Vec<u8>, sign_cat: bool) {
    let mut rig = rig();
    let spec = driver("drv1", DriverKind::Inf, &zip, 1);
    rig.serve_driver(&spec, &zip);
    if sign_cat {
        rig.sign(&spec.sha256, "b.cat");
    }
    rig.set_drivers(vec![spec]);
    rig.start();
    rig.until("failed", |r| r.driver_state("drv1") == Some(LocalState::Failed)).await;
    let record = rig.driver_record("drv1").unwrap();
    assert_eq!(record.detail.as_deref(), Some(detail));
    assert!(rig.runs().is_empty(), "pnputil is never started: {detail}");
    assert!(rig.store().is_empty() && rig.journal_ids().is_empty());
    assert!(!rig.work_dir_exists(), "nothing stays extracted");
    assert!(rig.downloads().is_empty(), "the refused zip is deleted");
    let reports = rig.driver_reports("drv1");
    assert_eq!((reports[0].state, reports[0].detail.as_deref()), (InstallState::Failed, Some(detail)));
    rig.stop().await;
}

#[tokio::test(start_paused = true)]
async fn an_unsigned_inf_catalog_is_refused_and_pnputil_never_runs() {
    // The catalog is there but has no valid signature.
    refused_as("unsigned_driver", good_zip(), false).await;
    // The INF names no catalog at all.
    refused_as("unsigned_driver", zip_bytes(&[("x64/b.inf", inf_text(&[]).as_bytes()), ("x64/b.sys", b"sys")]), true).await;
    // The INF names a catalog that is not in the package.
    refused_as("unsigned_driver", zip_bytes(&[("x64/b.inf", inf_text(&["gone.cat"]).as_bytes())]), true).await;
    // One of two catalogs is unsigned (only b.cat is marked).
    refused_as(
        "unsigned_driver",
        zip_bytes(&[("x64/b.inf", inf_text(&["b.cat", "c.cat"]).as_bytes()), ("x64/b.cat", b"1"), ("x64/c.cat", b"2")]),
        true,
    )
    .await;
}

#[tokio::test(start_paused = true)]
async fn an_unsafe_zip_or_a_missing_inf_is_refused_before_anything_runs() {
    refused_as("bad_package", zip_bytes(&[("../evil.inf", b"x"), ("x64/b.inf", inf_text(&["b.cat"]).as_bytes())]), true).await;
    refused_as("bad_package", zip_bytes(&[("x64/b.inf", b"x"), ("/abs.cat", b"x")]), true).await;
    refused_as("bad_package", zip_bytes(&[("other/a.inf", inf_text(&["b.cat"]).as_bytes())]), true).await;
    refused_as("bad_package", b"MZ this is not a zip".to_vec(), true).await;
    // The INF entry of the document names a path that is not plain: the entry is unsupported, nothing is downloaded.
    let mut rig = rig();
    let bytes = good_zip();
    let mut spec = driver("drv1", DriverKind::Inf, &bytes, 1);
    spec.inf = Some("../x64/b.inf".into());
    rig.serve_driver(&spec, &bytes);
    rig.set_drivers(vec![spec]);
    rig.start();
    rig.until("unsupported", |r| r.driver_state("drv1") == Some(LocalState::Unsupported)).await;
    assert!(rig.runs().is_empty() && rig.downloader.calls().is_empty());
    assert_eq!(rig.driver_reports("drv1")[0].detail.as_deref(), Some("unsupported"));
    rig.stop().await;
}

#[tokio::test(start_paused = true)]
async fn a_hash_mismatch_runs_nothing() {
    let mut rig = rig();
    let bytes = good_zip();
    let spec = driver("drv1", DriverKind::Inf, &bytes, 1);
    // The server hands out other bytes than the signed document's hash.
    rig.serve_driver(&spec, b"tampered package");
    rig.sign(&spec.sha256, "b.cat");
    rig.set_drivers(vec![spec]);
    rig.start();
    rig.until("failed", |r| r.driver_state("drv1") == Some(LocalState::Failed)).await;
    assert_eq!(rig.driver_record("drv1").unwrap().detail.as_deref(), Some("hash_mismatch"));
    assert!(rig.runs().is_empty() && rig.store().is_empty() && !rig.work_dir_exists());
    assert!(rig.downloads().is_empty(), "no file of the mismatching download stays");
    rig.stop().await;
}

#[tokio::test(start_paused = true)]
async fn a_driver_that_asks_for_a_restart_is_installed_and_the_restart_clears_after_the_boot() {
    let mut rig = rig();
    let bytes = good_zip();
    let spec = driver("drv1", DriverKind::Inf, &bytes, 1);
    rig.serve_driver(&spec, &bytes);
    rig.sign(&spec.sha256, "b.cat");
    rig.set_drivers(vec![spec]);
    rig.sim.with_world(|w| w.installer_exits.push_back(InstallerExit::Code(3010)));
    rig.start();
    rig.until("installed", |r| r.driver_state("drv1") == Some(LocalState::Installed)).await;
    assert_eq!(rig.report.restart_pending(), Some(true));
    assert!(rig.book.snapshot().restart_pending_since_ms.is_some());
    assert_eq!(rig.driver_record("drv1").unwrap().last_exit_code, Some(3010));
    assert_eq!(rig.driver_reports("drv1")[0].exit_code, Some(3010), "the dashboard shows restart needed");
    assert_eq!(rig.store(), ["oem1.inf"], "3010 still published the package");
    rig.stop().await;

    // The PC booted: the flag and the driver's "restart needed" go, and the new result is reported.
    rig.sim.with_world(|w| w.boot_id = Some(101));
    rig.start();
    rig.until("cleared", |r| r.report.restart_pending().is_none()).await;
    rig.until("re-reported", |r| r.driver_reports("drv1").first().is_some_and(|x| x.exit_code.is_none())).await;
    let record = rig.driver_record("drv1").unwrap();
    assert_eq!((record.state, record.last_exit_code), (LocalState::Installed, None));
    assert_eq!(rig.runs().len(), 1, "not installed again");
    rig.stop().await;
}

#[tokio::test(start_paused = true)]
async fn a_busy_installer_is_retried_without_counting_and_a_failure_backs_off() {
    let mut rig = rig();
    let bytes = good_zip();
    let spec = driver("drv1", DriverKind::Inf, &bytes, 1);
    rig.serve_driver(&spec, &bytes);
    rig.sign(&spec.sha256, "b.cat");
    rig.set_drivers(vec![spec.clone()]);
    rig.sim.with_world(|w| {
        w.installer_exits.push_back(InstallerExit::Code(1618));
        w.installer_exits.push_back(InstallerExit::Code(1));
    });
    rig.start();
    rig.until("first run", |r| r.runs().len() == 1).await;
    rig.settle().await;
    let record = rig.driver_record("drv1").unwrap();
    assert_eq!((record.state, record.attempts), (LocalState::Pending, 0));
    assert!(rig.driver_reports("drv1").iter().all(|r| r.state == InstallState::Pending), "busy is not reported");
    assert!(!rig.work_dir_exists());
    advance(BUSY_RETRY + Duration::from_secs(5)).await;
    rig.until("second run", |r| r.runs().len() == 2).await;
    rig.until("failed", |r| r.driver_state("drv1") == Some(LocalState::Failed)).await;
    let record = rig.driver_record("drv1").unwrap();
    assert_eq!((record.attempts, record.last_exit_code, record.detail.as_deref()), (1, Some(1), Some("exit_code")));
    assert!(rig.store().is_empty(), "a failed pnputil published nothing");
    // The next try after one minute succeeds (sign again: the extraction was deleted and made anew).
    advance(Duration::from_secs(61)).await;
    rig.until("installed", |r| r.driver_state("drv1") == Some(LocalState::Installed)).await;
    assert_eq!(rig.runs().len(), 3);
    rig.stop().await;
}

#[tokio::test(start_paused = true)]
async fn removal_deletes_only_the_packages_rulebox_published() {
    let mut rig = rig();
    // A package of someone else is in the store already.
    rig.sim.with_world(|w| {
        w.driver_store.insert("oem9.inf".to_string());
        w.next_oem = 10;
    });
    rig.sim.add_program(r"C:\Windows\INF\oem9.inf", FileIdentity::default(), Some(OEM_SHA_A));
    let bytes = good_zip();
    let spec = driver("drv1", DriverKind::Inf, &bytes, 1);
    rig.serve_driver(&spec, &bytes);
    rig.sign(&spec.sha256, "b.cat");
    rig.set_drivers(vec![spec]);
    rig.start();
    rig.until("installed", |r| r.driver_state("drv1") == Some(LocalState::Installed)).await;
    assert_eq!(rig.store(), ["oem10.inf", "oem9.inf"]);
    assert_eq!(rig.driver_record("drv1").unwrap().packages.iter().map(|p| p.published.clone()).collect::<Vec<_>>(), ["oem10.inf"]);

    // Unassigned: Rulebox removes its own package and leaves the other one alone.
    rig.set_drivers(Vec::new());
    rig.until("removed", |r| r.driver_state("drv1") == Some(LocalState::Removed)).await;
    assert_eq!(rig.deletes(), ["oem10.inf"]);
    assert_eq!(rig.store(), ["oem9.inf"]);
    assert!(rig.journal_ids().is_empty(), "the entry is gone with the package");
    assert_eq!(rig.driver_reports("drv1")[0].state, InstallState::Removed);
    // Acknowledged: the record is forgotten.
    rig.report.accept_installs();
    rig.until("forgotten", |r| r.driver_record("drv1").is_none()).await;
    rig.stop().await;
}

#[tokio::test(start_paused = true)]
async fn a_package_whose_file_changed_is_not_deleted() {
    // Windows reused the name `oem1.inf` for another package: Rulebox's record no longer matches the file.
    let mut rig = rig();
    let bytes = good_zip();
    let spec = driver("drv1", DriverKind::Inf, &bytes, 1);
    rig.serve_driver(&spec, &bytes);
    rig.sign(&spec.sha256, "b.cat");
    rig.set_drivers(vec![spec]);
    rig.start();
    rig.until("installed", |r| r.driver_state("drv1") == Some(LocalState::Installed)).await;
    rig.sim.add_program(r"C:\Windows\INF\oem1.inf", FileIdentity::default(), Some(OEM_SHA_A));
    rig.set_drivers(Vec::new());
    rig.until("removed", |r| r.driver_state("drv1") == Some(LocalState::Removed)).await;
    assert!(rig.deletes().is_empty(), "nothing is deleted: {:?}", rig.deletes());
    assert_eq!(rig.store(), ["oem1.inf"]);
    assert!(rig.journal_ids().is_empty(), "the entry is forgotten, never restored later");
    rig.stop().await;
}

#[tokio::test(start_paused = true)]
async fn a_package_that_was_already_in_the_store_is_never_removed() {
    let mut rig = rig();
    rig.sim.with_world(|w| w.driver_add_publishes = false);
    let bytes = good_zip();
    let spec = driver("drv1", DriverKind::Inf, &bytes, 1);
    rig.serve_driver(&spec, &bytes);
    rig.sign(&spec.sha256, "b.cat");
    rig.set_drivers(vec![spec]);
    rig.start();
    rig.until("installed", |r| r.driver_state("drv1") == Some(LocalState::Installed)).await;
    assert!(rig.driver_record("drv1").unwrap().packages.is_empty() && rig.journal_ids().is_empty());
    rig.set_drivers(Vec::new());
    rig.until("dropped", |r| r.driver_record("drv1").is_none()).await;
    rig.settle().await;
    assert!(rig.deletes().is_empty());
    assert_eq!(rig.runs().len(), 1, "only the add ran");
    rig.stop().await;
}

#[tokio::test(start_paused = true)]
async fn a_failing_removal_is_retried_and_keeps_the_package_recorded() {
    let mut rig = rig();
    let bytes = good_zip();
    let spec = driver("drv1", DriverKind::Inf, &bytes, 1);
    rig.serve_driver(&spec, &bytes);
    rig.sign(&spec.sha256, "b.cat");
    rig.set_drivers(vec![spec]);
    rig.start();
    rig.until("installed", |r| r.driver_state("drv1") == Some(LocalState::Installed)).await;
    rig.sim.with_world(|w| w.driver_delete_fails = true);
    rig.set_drivers(Vec::new());
    rig.until("failed", |r| r.driver_state("drv1") == Some(LocalState::Failed)).await;
    let record = rig.driver_record("drv1").unwrap();
    assert_eq!((record.removal, record.detail.as_deref(), record.packages.len()), (true, Some("remove_failed"), 1));
    assert_eq!(rig.journal_ids().len(), 1, "still journalled: a restore can try again");
    rig.sim.with_world(|w| w.driver_delete_fails = false);
    // A removal does not wait for the connection; the retry comes after the backoff.
    advance(Duration::from_secs(61)).await;
    rig.until("removed", |r| r.driver_state("drv1") == Some(LocalState::Removed)).await;
    assert!(rig.store().is_empty());
    rig.stop().await;
}

#[tokio::test(start_paused = true)]
async fn exe_and_msi_drivers_run_once_and_are_never_removed() {
    let mut rig = rig();
    let exe_bytes = b"vendor exe";
    let msi_bytes = b"vendor msi";
    let exe = driver("drvexe", DriverKind::Exe, exe_bytes, 1);
    let msi = driver("drvmsi", DriverKind::Msi, msi_bytes, 1);
    rig.serve_driver(&exe, exe_bytes);
    rig.serve_driver(&msi, msi_bytes);
    rig.set_drivers(vec![exe.clone(), msi.clone()]);
    rig.start();
    rig.until("both installed", |r| {
        r.driver_state("drvexe") == Some(LocalState::Installed) && r.driver_state("drvmsi") == Some(LocalState::Installed)
    })
    .await;
    let runs = rig.runs();
    assert_eq!(runs.len(), 2);
    let exe_run = runs.iter().find(|r| r.program.extension().is_some_and(|e| e == "exe") && r.program.starts_with(rig.paths.downloads_dir())).unwrap();
    assert_eq!(exe_run.args, ["/S", "/quiet"], "silent arguments one by one");
    assert_eq!(exe_run.expected_exe, None);
    let msi_run = runs.iter().find(|r| r.program == Path::new(r"C:\Windows\System32\msiexec.exe")).unwrap();
    assert_eq!(&msi_run.args[2..4], ["/qn", "/norestart"]);
    assert!(rig.book.installed_ids().is_empty() && rig.store().is_empty());
    // Restarting the agent does not install them again.
    rig.stop().await;
    rig.book = InstallBook::open(rig.paths.installs());
    rig.start();
    rig.settle().await;
    assert_eq!(rig.runs().len(), 2);
    // Unassigned: forgotten, never uninstalled (there is nothing Rulebox can remove).
    rig.set_drivers(Vec::new());
    rig.until("forgotten", |r| r.book.snapshot().drivers.is_empty()).await;
    rig.settle().await;
    assert_eq!(rig.runs().len(), 2);
    assert!(rig.deletes().is_empty());
    rig.stop().await;
}

#[tokio::test(start_paused = true)]
async fn a_new_revision_retries_a_failed_driver_and_a_new_version_installs_again() {
    let mut rig = rig();
    let exe_bytes = b"vendor exe v1";
    let spec = driver("drv1", DriverKind::Exe, exe_bytes, 1);
    rig.serve_driver(&spec, exe_bytes);
    rig.sim.with_world(|w| w.installer_exits.extend((0..6).map(|_| InstallerExit::Code(5))));
    rig.set_drivers(vec![spec.clone()]);
    rig.start();
    for (step, wait) in [(1usize, 0u64), (2, 61), (3, 301), (4, 901), (5, 3601), (6, 21_601)] {
        advance(Duration::from_secs(wait)).await;
        rig.until("a failed run", |r| r.runs().len() >= step && r.driver_record("drv1").is_some_and(|x| x.attempts as usize == step)).await;
    }
    assert_eq!(rig.driver_record("drv1").unwrap().attempts, 6);
    advance(Duration::from_secs(100_000)).await;
    rig.settle().await;
    assert_eq!(rig.runs().len(), 6, "the sixth failure is final until the revision changes");
    // Retry: the same file, a new revision.
    rig.set_drivers(vec![DriverSpec { revision: 2, ..spec.clone() }]);
    rig.until("installed", |r| r.driver_state("drv1") == Some(LocalState::Installed)).await;
    assert_eq!(rig.driver_record("drv1").unwrap().revision, 2);
    // A new version (another hash) is installed again.
    let v2 = b"vendor exe v2";
    let spec2 = DriverSpec { revision: 3, ..driver("drv1", DriverKind::Exe, v2, 3) };
    rig.serve_driver(&spec2, v2);
    rig.set_drivers(vec![spec2]);
    rig.until("v2 run", |r| r.runs().len() == 8).await;
    rig.until("v2 installed", |r| r.driver_record("drv1").is_some_and(|x| x.sha256 == sha(v2) && x.state == LocalState::Installed)).await;
    rig.stop().await;
}

#[tokio::test(start_paused = true)]
async fn an_unknown_driver_kind_is_unsupported_and_nothing_is_downloaded() {
    let mut rig = rig();
    let bytes = b"x";
    let spec = driver("drv1", DriverKind::Unknown, bytes, 1);
    rig.serve_driver(&spec, bytes);
    rig.set_drivers(vec![spec]);
    rig.start();
    rig.until("unsupported", |r| r.driver_state("drv1") == Some(LocalState::Unsupported)).await;
    assert!(rig.runs().is_empty() && rig.downloader.calls().is_empty());
    rig.stop().await;
}

#[tokio::test(start_paused = true)]
async fn restoring_everything_removes_the_rulebox_installed_packages_and_only_those() {
    use crate::journal::{restore_all, JournalCtx};
    let mut rig = rig();
    rig.sim.with_world(|w| {
        w.driver_store.insert("oem9.inf".to_string());
        w.next_oem = 10;
    });
    rig.sim.add_program(r"C:\Windows\INF\oem9.inf", FileIdentity::default(), Some(OEM_SHA_A));
    let bytes = good_zip();
    let spec = driver("drv1", DriverKind::Inf, &bytes, 1);
    rig.serve_driver(&spec, &bytes);
    rig.sign(&spec.sha256, "b.cat");
    rig.set_drivers(vec![spec]);
    rig.start();
    rig.until("installed", |r| r.driver_state("drv1") == Some(LocalState::Installed)).await;
    rig.stop().await;
    let platform = Arc::clone(&rig.sim) as Arc<dyn Platform>;
    let ctx = JournalCtx { platform: platform.as_ref(), shared: rig.shared.as_ref() };
    let report = restore_all(&ctx);
    assert!(report.failed.is_empty(), "{:?}", report.failed);
    assert_eq!(rig.deletes(), ["oem10.inf"]);
    assert_eq!(rig.store(), ["oem9.inf"]);
    assert!(rig.journal_ids().is_empty());
}

#[test]
fn installs_json_from_before_drivers_loads_and_a_driver_record_survives_a_round_trip() {
    let old = r#"{"schema":1,"restartPendingSinceMs":null,"restartBoot":null,"apps":{}}"#;
    let file: InstallsFile = serde_json::from_str(old).unwrap();
    assert!(file.drivers.is_empty());
    let mut file = file;
    let mut record = DriverRecord::new("drv1", DriverRecordKind::Inf, &"a".repeat(64), 3, LocalState::Installed);
    record.add_package(crate::installs::drivers_rules::DriverPackage { published: "oem3.inf".into(), sha256: "b".repeat(64) });
    file.drivers.insert("drv1".into(), record.clone());
    let text = serde_json::to_string(&file).unwrap();
    let back: InstallsFile = serde_json::from_str(&text).unwrap();
    assert_eq!(back.drivers.get("drv1"), Some(&record));
    // The file on disk through the book.
    let dir = TempDir::new();
    let path = dir.path().join("installs.json");
    std::fs::write(&path, &text).unwrap();
    let book = InstallBook::open(path);
    assert_eq!(book.snapshot().drivers.len(), 1);
    assert!(book.installed_ids().is_empty(), "a driver is never an installed app");
}

#[tokio::test(start_paused = true)]
async fn driver_folders_a_crash_left_behind_are_deleted_at_start() {
    let mut rig = rig();
    let stale = rig.paths.driver_work_dir(&"c".repeat(64));
    std::fs::create_dir_all(stale.join("x64")).unwrap();
    std::fs::write(stale.join("x64").join("b.inf"), b"left over").unwrap();
    rig.start();
    rig.until("swept", |r| !r.work_dir_exists()).await;
    rig.stop().await;
}

// ===================================================================== Phase 6 Step 11
//
// Versions, update modes, apply windows, keep-previous and roll-back (plan 4.4, 4.6). Everything runs on `SimPlatform`
// (nothing is executed, nothing touches the real PC) with the clock paused: only an event can wake the engine, so a
// test that advances the clock by days and sees nothing happen is a test that no timer was added.

use crate::backend::InstallReport;
use crate::platform::sim::SimProcess;

const GIB: u64 = 1024 * 1024 * 1024;
const ACME: &str = "CN=Acme Ltd, O=Acme Ltd, L=Oslo, C=NO";
const STAFF_SID: &str = "S-1-5-21-1-2-3-1001";

fn with_update(mut app: CatalogApp, version: &str, update: serde_json::Value) -> CatalogApp {
    let desktop = app.desktop.as_mut().unwrap();
    desktop.version = Some(version.into());
    desktop.update = Some(serde_json::from_value(update).unwrap());
    app
}

fn managed(app: CatalogApp, version: &str) -> CatalogApp {
    with_update(app, version, json!({ "mode": "managed" }))
}

fn pinned(app: CatalogApp, version: &str) -> CatalogApp {
    with_update(app, version, json!({ "mode": "pinned" }))
}

fn vendor(app: CatalogApp, version: &str, min_version: Option<&str>) -> CatalogApp {
    let mut update = json!({ "mode": "vendor", "publisher": "O=Acme Ltd" });
    if let Some(min) = min_version {
        update["minVersion"] = json!(min);
    }
    with_update(app, version, update)
}

fn key(path: &Path) -> String {
    path.to_string_lossy().replace('/', "\\").to_ascii_lowercase()
}

impl Rig {
    fn installer_file(&self, bytes: &[u8], ext: &str) -> PathBuf {
        self.paths.downloads_dir().join(format!("{}.{ext}", sha(bytes)))
    }

    /// The installer of `bytes` is signed by `signer`.
    fn sign_installer(&self, bytes: &[u8], ext: &str, signer: &str) {
        let identity = FileIdentity { signer: Some(signer.to_string()), original_name: None, product: None };
        self.sim.add_program(self.installer_file(bytes, ext).to_str().unwrap(), identity, None);
    }

    /// A successful install of `bytes` gives the program this file version.
    fn installs_version(&self, bytes: &[u8], version: &str) {
        self.sim.with_world(|w| w.installer_versions.insert(sha(bytes), version.to_string()));
    }

    /// The program of `app` has this file version now (`None`: no version resource).
    fn set_file_version(&self, app: &CatalogApp, version: Option<&str>) {
        let key = key(&exe_of(app));
        self.sim.with_world(|w| match version {
            Some(version) => w.file_versions.insert(key, version.to_string()),
            None => w.file_versions.remove(&key),
        });
    }

    /// A reconcile occasion (something the engine listens for changed): the document is sent again.
    fn poke(&self) {
        self.policy_tx.send_modify(|_| {});
    }

    /// The app runs in an employee's session.
    fn run_app(&self, app: &CatalogApp, pid: u32) {
        let exists = self.sim.with_world(|w| w.sessions.iter().any(|s| s.id == 2));
        if !exists {
            self.sim.add_session(2, Some(STAFF_SID), true);
        }
        self.sim.with_world(|w| {
            w.processes.push(SimProcess { pid, session_id: 2, image: exe_of(app), user_sid: STAFF_SID.into() });
        });
    }

    fn reports(&self) -> Vec<InstallReport> {
        self.report.queued_installs()
    }

    fn assert_every_run_is_allowed(&self) {
        let downloads = self.paths.downloads_dir();
        let drivers = self.paths.drivers_dir();
        for run in self.runs() {
            assert!(
                crate::installs::installer_command_allowed(&run.program, &run.args, Some(Path::new(r"C:\Windows")), &downloads, &drivers),
                "outside the allowed program list: {run:?}"
            );
        }
    }
}

/// Installs `v1` and returns the rig (started, `v1` installed, the report queue empty).
async fn rig_with_installed(v1: &CatalogApp, bytes: &[u8]) -> Rig {
    let mut rig = rig();
    rig.serve(v1, bytes);
    rig.set_catalog(vec![v1.clone()]);
    rig.start();
    rig.until("v1 installed", |r| r.state(&v1.id) == Some(LocalState::Installed)).await;
    rig.report.accept_installs();
    rig
}

// ---------------------------------------------------------------- journal schema 2

#[tokio::test(start_paused = true)]
async fn a_schema_1_record_of_an_agent_before_phase_6_loads_and_upgrades_cleanly() {
    let dir = TempDir::new();
    let paths = DataPaths::new(dir.path().to_path_buf());
    std::fs::create_dir_all(paths.state_dir()).unwrap();
    let v1 = app("a1", "msi", b"v1", 1, true);
    let mut record = InstallRecord::new("a1", RecordKind::Msi, &sha(b"v1"), 1, LocalState::Installed);
    record.exe = Some(exe_of(&v1).to_string_lossy().into_owned());
    record.product_code = Some(CODE.into());
    record.remove_when_unassigned = true;
    // What a 1.3-era agent wrote: none of the Phase 6 keys.
    let mut value = serde_json::to_value(&record).unwrap();
    for name in [
        "version", "installedVersion", "mode", "whenClosed", "update", "staged", "oldWorks", "kept", "previous", "healPending",
        "verifyingSinceMs", "verifyLooks",
    ] {
        assert!(value.as_object_mut().unwrap().remove(name).is_some(), "{name} is written by this agent");
    }
    let file = json!({ "schema": 1, "restartPendingSinceMs": null, "apps": { "a1": value } });
    std::fs::write(paths.installs(), serde_json::to_vec(&file).unwrap()).unwrap();

    let book = InstallBook::open(paths.installs());
    let loaded = book.snapshot();
    assert_eq!(loaded.schema, INSTALLS_SCHEMA, "read as schema 2");
    let old = &loaded.apps["a1"];
    assert_eq!((old.mode, old.update, old.staged, old.old_works), (UpdateMode::Pinned, false, false, true));
    assert_eq!((old.version.as_deref(), old.installed_version.as_deref()), (None, None));
    assert!(old.kept.is_none() && old.previous.is_none() && old.verifying_since_ms.is_none() && !old.heal_pending);
    drop(book);

    // An unknown (newer) schema is still refused: the engine starts without records.
    let future = json!({ "schema": 3, "restartPendingSinceMs": null, "apps": { "a1": { "appId": "a1" } } });
    let elsewhere = dir.path().join("future-installs.json");
    std::fs::write(&elsewhere, serde_json::to_vec(&future).unwrap()).unwrap();
    assert!(InstallBook::open(elsewhere).snapshot().apps.is_empty());

    // The agent starts on the old file: the installed app is left alone, and the next version installs as an update.
    let mut rig = rig_in(dir);
    rig.sim.add_file(exe_of(&v1).to_str().unwrap());
    rig.set_catalog(vec![v1]);
    rig.start();
    rig.settle().await;
    assert!(rig.runs().is_empty());
    assert_eq!(rig.state("a1"), Some(LocalState::Installed));
    let v2 = app("a1", "msi", b"v2", 2, true);
    rig.serve(&v2, b"v2");
    rig.set_catalog(vec![v2.clone()]);
    rig.until("v2", |r| r.record("a1").is_some_and(|x| x.sha256 == sha(b"v2") && x.state == LocalState::Installed && !x.update)).await;
    assert_eq!(rig.runs().len(), 1);
    let on_disk: serde_json::Value = serde_json::from_slice(&std::fs::read(rig.paths.installs()).unwrap()).unwrap();
    assert_eq!(on_disk["schema"], 2, "saved as schema 2 with the first change");
    assert_eq!(rig.visible(&[v2]), ["a1"]);
    rig.stop().await;
}

// ---------------------------------------------------------------- unknown mode, Pinned

#[tokio::test(start_paused = true)]
async fn an_unknown_update_mode_behaves_as_pinned() {
    let v1 = with_update(app("a1", "msi", b"v1", 1, true), "1.0", json!({ "mode": "hologram" }));
    let mut rig = rig_with_installed(&v1, b"v1").await;
    let record = rig.record("a1").unwrap();
    assert_eq!(record.mode, UpdateMode::Pinned, "stored as Pinned");
    assert!(record.kept.is_none(), "a Pinned app keeps no installer");
    assert!(rig.downloads().is_empty());
    // A different SHA-256 installs again (nothing adopts it as a Vendor app would).
    let v2 = with_update(app("a1", "msi", b"v2", 2, true), "2.0", json!({ "mode": "hologram" }));
    rig.serve(&v2, b"v2");
    rig.set_catalog(vec![v2]);
    rig.until("v2", |r| r.record("a1").is_some_and(|x| x.sha256 == sha(b"v2") && x.state == LocalState::Installed && !x.update)).await;
    assert_eq!(rig.runs().len(), 2);
    rig.stop().await;
}

#[tokio::test(start_paused = true)]
async fn a_pinned_update_that_fails_is_not_rolled_back_and_keeps_nothing() {
    let v1 = pinned(app("a1", "msi", b"v1", 1, true), "1.0");
    let mut rig = rig_with_installed(&v1, b"v1").await;
    let v2 = pinned(app("a1", "msi", b"v2", 2, true), "2.0");
    rig.serve(&v2, b"v2");
    rig.sim.with_world(|w| w.installer_exits.push_back(InstallerExit::Code(1603)));
    rig.set_catalog(vec![v2]);
    rig.until("failed", |r| r.state("a1") == Some(LocalState::Failed)).await;
    assert_eq!(rig.runs().len(), 2, "no roll-back run");
    let record = rig.record("a1").unwrap();
    assert_eq!((record.detail.as_deref(), record.attempts, record.old_works), (Some("exit_code"), 1, false));
    assert!(record.previous.is_none() && record.kept.is_none());
    rig.stop().await;
}

// ---------------------------------------------------------------- apply windows (plan 4.4.5)

#[tokio::test(start_paused = true)]
async fn an_update_waits_for_the_employee_to_sign_out_and_no_timer_wakes_it() {
    let v1 = app("a1", "msi", b"v1", 1, true);
    let mut rig = rig_with_installed(&v1, b"v1").await;
    // An employee signs in: the window "signed out" is closed (the default `boot_or_signed_out`).
    rig.presence_tx.send_replace(true);
    rig.settle().await;
    let v2 = app("a1", "msi", b"v2", 2, true);
    rig.serve(&v2, b"v2");
    rig.set_catalog(vec![v2.clone()]);
    // The download happens at once, in the background; the installer waits.
    rig.until("staged", |r| r.record("a1").is_some_and(|x| x.staged)).await;
    rig.settle().await;
    assert_eq!(rig.runs().len(), 1, "the installer of the update did not run");
    assert_eq!(rig.visible(std::slice::from_ref(&v2)), ["a1"], "the tile stays while the update waits");
    assert!(rig.installer_file(b"v2", "msi").exists(), "the installer is downloaded and verified");
    // One terminal result says so: installed, with the detail `waiting_for_close`, and no `pending`.
    let waiting = rig.reports();
    assert_eq!(waiting.len(), 1);
    assert_eq!((waiting[0].state, waiting[0].app_revision), (InstallState::Installed, 2));
    assert_eq!(waiting[0].detail.as_deref(), Some("waiting_for_close"));
    // However long it waits, nothing wakes the engine: no timer, no polling.
    advance(Duration::from_secs(30 * 24 * 3600)).await;
    rig.settle().await;
    assert_eq!(rig.runs().len(), 1);
    assert_eq!(rig.downloader.calls().len(), 2, "the installer was downloaded once");
    // The employee signs out: the update runs and says installed.
    rig.presence_tx.send_replace(false);
    rig.until("v2 installed", |r| r.record("a1").is_some_and(|x| x.state == LocalState::Installed && !x.update && x.sha256 == sha(b"v2"))).await;
    assert_eq!(rig.runs().len(), 2);
    let done = rig.reports();
    assert_eq!((done.len(), done[0].state, done[0].detail.clone()), (1, InstallState::Installed, None));
    rig.assert_every_run_is_allowed();
    rig.stop().await;
}

#[tokio::test(start_paused = true)]
async fn a_running_app_makes_the_update_wait_even_when_nobody_is_signed_in_and_its_exit_wakes_the_engine() {
    let v1 = app("a1", "msi", b"v1", 1, true);
    let mut rig = rig_with_installed(&v1, b"v1").await;
    rig.run_app(&v1, 777);
    let v2 = app("a1", "msi", b"v2", 2, true);
    rig.serve(&v2, b"v2");
    rig.set_catalog(vec![v2.clone()]);
    rig.until("staged", |r| r.record("a1").is_some_and(|x| x.staged)).await;
    // The engine waits on the process itself (the exit is the wake source), not on a timer.
    rig.until("watching the process", |r| r.sim.exit_waits_running() == 1).await;
    advance(Duration::from_secs(7 * 24 * 3600)).await;
    rig.settle().await;
    assert_eq!(rig.runs().len(), 1, "an installer never runs over a running app");
    assert!(!rig.sim.calls().contains(&SimOp::TerminateProcess), "a running app is never closed");
    assert_eq!(rig.reports().iter().map(|r| r.detail.clone()).collect::<Vec<_>>(), [Some("waiting_for_close".to_string())]);
    // The app closes: the update runs.
    rig.sim.end_process(777);
    rig.until("v2 installed", |r| r.record("a1").is_some_and(|x| x.state == LocalState::Installed && x.sha256 == sha(b"v2") && !x.update)).await;
    assert_eq!(rig.runs().len(), 2);
    assert_eq!(rig.sim.exit_waits_running(), 0);
    rig.stop().await;
}

#[tokio::test(start_paused = true)]
async fn when_closed_lets_an_update_run_for_a_signed_in_employee_once_the_app_is_closed() {
    let v1 = with_update(app("a1", "msi", b"v1", 1, true), "1.0", json!({ "mode": "pinned", "applyWhen": "when_closed" }));
    let mut rig = rig_with_installed(&v1, b"v1").await;
    rig.presence_tx.send_replace(true);
    rig.run_app(&v1, 901);
    rig.settle().await;
    let v2 = with_update(app("a1", "msi", b"v2", 2, true), "2.0", json!({ "mode": "pinned", "applyWhen": "when_closed" }));
    rig.serve(&v2, b"v2");
    rig.set_catalog(vec![v2.clone()]);
    rig.until("waiting", |r| r.book.update_state("a1") == Some(AppUpdateState::WaitingForClose)).await;
    // The tile says "Waiting for the app to close".
    let resolver = AppResolver::with_installs(Arc::clone(&rig.sim) as Arc<dyn Platform>, Arc::clone(&rig.book), rig.paths.icons_dir());
    let entries = resolver.visible(std::slice::from_ref(&v2), "emp1");
    assert_eq!(entries.iter().map(|e| e.update).collect::<Vec<_>>(), [Some(AppUpdateState::WaitingForClose)]);
    assert_eq!(rig.runs().len(), 1);
    // The employee closes the app (still signed in): the update runs.
    rig.sim.end_process(901);
    rig.until("v2 installed", |r| r.record("a1").is_some_and(|x| x.state == LocalState::Installed && x.sha256 == sha(b"v2") && !x.update)).await;
    assert_eq!(rig.runs().len(), 2);
    assert_eq!(rig.book.update_state("a1"), None);
    rig.stop().await;
}

#[tokio::test(start_paused = true)]
async fn an_update_in_progress_reports_nothing_and_the_tile_says_updating() {
    let v1 = app("a1", "msi", b"v1", 1, true);
    let mut rig = rig_with_installed(&v1, b"v1").await;
    let v2 = app("a1", "msi", b"v2", 2, true);
    rig.serve(&v2, b"v2");
    rig.sim.with_world(|w| w.installer_hangs = true);
    rig.set_catalog(vec![v2.clone()]);
    rig.until("the installer runs", |r| r.runs().len() == 2).await;
    rig.settle().await;
    assert_eq!(rig.state("a1"), Some(LocalState::Installing));
    assert_eq!(rig.book.update_state("a1"), Some(AppUpdateState::Updating));
    assert!(rig.reports().is_empty(), "no progress state for an upgrade: {:?}", rig.reports());
    let resolver = AppResolver::with_installs(Arc::clone(&rig.sim) as Arc<dyn Platform>, Arc::clone(&rig.book), rig.paths.icons_dir());
    let entries = resolver.visible(std::slice::from_ref(&v2), "emp1");
    assert_eq!(entries.iter().map(|e| (e.id.as_str(), e.update)).collect::<Vec<_>>(), [("a1", Some(AppUpdateState::Updating))]);
    // The agent stops: the installer is ended, nothing is counted, and the update runs again at the next start.
    rig.stop().await;
    let record = rig.record("a1").unwrap();
    assert_eq!((record.state, record.attempts, record.update), (LocalState::Installed, 0, true));
    rig.sim.with_world(|w| w.installer_hangs = false);
    rig.start();
    rig.until("v2 installed", |r| r.record("a1").is_some_and(|x| x.state == LocalState::Installed && !x.update && x.sha256 == sha(b"v2"))).await;
    rig.stop().await;
}

#[tokio::test(start_paused = true)]
async fn a_window_that_closes_during_the_download_defers_the_installer() {
    let v1 = app("a1", "msi", b"v1", 1, true);
    let mut rig = rig_with_installed(&v1, b"v1").await;
    let v2 = app("a1", "msi", b"v2", 2, true);
    rig.serve(&v2, b"v2");
    rig.sim.with_world(|w| w.installer_exits.push_back(InstallerExit::Code(1603)));
    rig.set_catalog(vec![v2.clone()]);
    rig.until("failed once", |r| r.record("a1").is_some_and(|x| x.state == LocalState::Failed && x.attempts == 1)).await;
    // The retry an hour later downloads again (the file is gone) and an employee signs in meanwhile.
    std::fs::remove_file(rig.installer_file(b"v2", "msi")).unwrap();
    let gate = rig.downloader.hold();
    advance(Duration::from_secs(3601)).await;
    rig.until("downloading", |r| r.downloader.calls().len() == 3).await;
    rig.presence_tx.send_replace(true);
    rig.settle().await;
    gate.add_permits(10);
    rig.until("deferred", |r| r.record("a1").is_some_and(|x| x.state == LocalState::Installed && x.staged && x.update)).await;
    assert_eq!(rig.runs().len(), 2, "nothing ran while the employee was signed in");
    rig.presence_tx.send_replace(false);
    rig.until("v2 installed", |r| r.record("a1").is_some_and(|x| x.state == LocalState::Installed && !x.update && x.sha256 == sha(b"v2"))).await;
    assert_eq!(rig.runs().len(), 3);
    rig.stop().await;
}

// ---------------------------------------------------------------- keep previous, roll back, retries (plan 4.6)

/// A Managed app: v1 installed (its installer is kept), then a v2 whose installer fails with 1603 and is rolled back.
async fn rolled_back_rig(retries: usize) -> (Rig, CatalogApp, CatalogApp) {
    let v1 = managed(app("a1", "msi", b"v1", 1, true), "1.0.0");
    let v2 = managed(app("a1", "msi", b"v2", 2, true), "2.0.0");
    let mut rig = rig();
    rig.installs_version(b"v1", "1.0.0.0");
    rig.installs_version(b"v2", "2.0.0.0");
    rig.serve(&v1, b"v1");
    rig.serve(&v2, b"v2");
    rig.set_catalog(vec![v1.clone()]);
    rig.start();
    rig.until("v1 installed", |r| r.state("a1") == Some(LocalState::Installed)).await;
    rig.report.accept_installs();
    // Each attempt: the installer of v2 fails, msiexec removes it by product code, the installer of v1 comes back.
    for _ in 0..retries {
        rig.sim.with_world(|w| {
            w.installer_exits.push_back(InstallerExit::Code(1603));
            w.installer_exits.push_back(InstallerExit::Code(0));
            w.installer_exits.push_back(InstallerExit::Code(0));
        });
    }
    (rig, v1, v2)
}

#[tokio::test(start_paused = true)]
async fn a_managed_installer_is_kept_and_a_failed_update_rolls_back_and_reports_once() {
    let (mut rig, v1, v2) = rolled_back_rig(1).await;
    let before = rig.record("a1").unwrap();
    assert_eq!(before.installed_version.as_deref(), Some("1.0.0.0"));
    let kept = before.kept.clone().expect("the installer of v1 is kept for a roll-back");
    assert_eq!((kept.sha256.as_str(), kept.ext.as_str(), kept.version.as_deref()), (sha(b"v1").as_str(), "msi", Some("1.0.0")));
    assert_eq!(rig.downloads(), [format!("{}.msi", sha(b"v1"))], "only the kept installer is on disk");
    rig.set_catalog(vec![v2.clone()]);
    rig.until("rolled back", |r| r.record("a1").is_some_and(|x| x.state == LocalState::Failed && x.attempts == 1)).await;
    // v1 installer, v2 installer (fails), msiexec /x by the product code, v1 installer again.
    let runs = rig.runs();
    assert_eq!(runs.len(), 4);
    assert_eq!(runs[1].args[..2], ["/i".to_string(), rig.installer_file(b"v2", "msi").to_string_lossy().into_owned()]);
    assert_eq!(runs[2].args[..2], ["/x", CODE]);
    assert_eq!(runs[3].args[..2], ["/i".to_string(), rig.installer_file(b"v1", "msi").to_string_lossy().into_owned()]);
    rig.assert_every_run_is_allowed();
    let record = rig.record("a1").unwrap();
    assert_eq!((record.detail.as_deref(), record.last_exit_code, record.old_works), (Some("update_rolled_back"), Some(1603), true));
    assert_eq!(record.installed_version.as_deref(), Some("1.0.0.0"), "the old version is back");
    assert!(record.previous.is_none() && record.kept.is_some());
    assert_eq!(rig.visible(&[v1, v2]), ["a1"], "the old version works: the tile stays");
    // Exactly one result, a terminal one: failed, rolled back, with the version the PC has.
    let reports = rig.reports();
    assert_eq!(reports.len(), 1, "{reports:?}");
    assert_eq!((reports[0].state, reports[0].attempts, reports[0].exit_code), (InstallState::Failed, 1, Some(1603)));
    assert_eq!(reports[0].detail.as_deref(), Some("update_rolled_back"));
    assert_eq!(reports[0].installed_version, Some(Some("1.0.0.0".to_string())));
    rig.stop().await;
}

#[tokio::test(start_paused = true)]
async fn an_update_that_failed_is_retried_at_the_next_window_three_times_an_hour_apart_then_is_final() {
    let (mut rig, _v1, v2) = rolled_back_rig(3).await;
    rig.set_catalog(vec![v2.clone()]);
    rig.until("first failure", |r| r.record("a1").is_some_and(|x| x.attempts == 1 && x.state == LocalState::Failed)).await;
    assert_eq!(rig.runs().len(), 4);
    // Not before an hour.
    advance(Duration::from_secs(59 * 60)).await;
    rig.settle().await;
    assert_eq!(rig.runs().len(), 4, "not retried inside the hour");
    advance(Duration::from_secs(2 * 60)).await;
    rig.until("second failure", |r| r.record("a1").is_some_and(|x| x.attempts == 2 && x.state == LocalState::Failed)).await;
    assert_eq!(rig.runs().len(), 7);
    advance(Duration::from_secs(61 * 60)).await;
    rig.until("third failure", |r| r.record("a1").is_some_and(|x| x.attempts == 3 && x.state == LocalState::Failed)).await;
    assert_eq!(rig.runs().len(), 10);
    // Final until a new revision (Retry).
    advance(Duration::from_secs(10 * 24 * 3600)).await;
    rig.settle().await;
    assert_eq!(rig.runs().len(), 10, "three attempts, then final");
    let reports = rig.reports();
    assert_eq!((reports.len(), reports[0].attempts), (1, 3));
    assert_eq!(rig.visible(&[v2]), ["a1"], "the old version works after every roll-back");
    // A new revision starts the attempts again.
    let retry = managed(app("a1", "msi", b"v2", 3, true), "2.0.0");
    rig.sim.with_world(|w| w.installer_exits.extend([InstallerExit::Code(0)]));
    rig.set_catalog(vec![retry]);
    rig.until("installed", |r| r.record("a1").is_some_and(|x| x.state == LocalState::Installed && x.sha256 == sha(b"v2") && !x.update)).await;
    assert_eq!(rig.record("a1").unwrap().installed_version.as_deref(), Some("2.0.0.0"));
    rig.stop().await;
}

#[tokio::test(start_paused = true)]
async fn a_new_version_that_installs_keeps_the_old_installer_until_the_next_sign_in() {
    let v1 = managed(app("a1", "msi", b"v1", 1, true), "1.0.0");
    let v2 = managed(app("a1", "msi", b"v2", 2, true), "2.0.0");
    let mut rig = rig();
    rig.installs_version(b"v2", "2.0.0.0");
    rig.serve(&v1, b"v1");
    rig.serve(&v2, b"v2");
    rig.set_catalog(vec![v1]);
    rig.start();
    rig.until("v1", |r| r.state("a1") == Some(LocalState::Installed)).await;
    rig.set_catalog(vec![v2.clone()]);
    rig.until("v2", |r| r.record("a1").is_some_and(|x| x.sha256 == sha(b"v2") && x.state == LocalState::Installed && !x.update)).await;
    let record = rig.record("a1").unwrap();
    assert_eq!(record.previous.as_ref().map(|p| p.sha256.clone()), Some(sha(b"v1")));
    assert_eq!(record.kept.as_ref().map(|k| k.sha256.clone()), Some(sha(b"v2")));
    assert!(record.heal_pending);
    let mut on_disk = rig.downloads();
    on_disk.sort();
    let mut expected = vec![format!("{}.msi", sha(b"v1")), format!("{}.msi", sha(b"v2"))];
    expected.sort();
    assert_eq!(on_disk, expected, "the new installer and the one before it");
    // An employee signs in: the new version ran healthy long enough; the old installer goes.
    rig.presence_tx.send_replace(true);
    rig.until("healed", |r| r.record("a1").is_some_and(|x| x.previous.is_none() && !x.heal_pending)).await;
    assert_eq!(rig.downloads(), [format!("{}.msi", sha(b"v2"))]);
    rig.stop().await;
}

#[tokio::test(start_paused = true)]
async fn an_msi_without_a_product_code_cannot_be_rolled_back() {
    let mut v1 = managed(app("a1", "msi", b"v1", 1, true), "1.0.0");
    let mut v2 = managed(app("a1", "msi", b"v2", 2, true), "2.0.0");
    for app in [&mut v1, &mut v2] {
        app.desktop.as_mut().unwrap().install.as_mut().unwrap().product_code = None;
    }
    let mut rig = rig_with_installed(&v1, b"v1").await;
    rig.serve(&v2, b"v2");
    rig.sim.with_world(|w| w.installer_exits.push_back(InstallerExit::Code(1603)));
    rig.set_catalog(vec![v2.clone()]);
    rig.until("failed", |r| r.state("a1") == Some(LocalState::Failed)).await;
    rig.settle().await;
    let record = rig.record("a1").unwrap();
    assert_eq!((record.detail.as_deref(), record.old_works), (Some("rollback_unsupported"), false));
    assert_eq!(rig.runs().len(), 2, "neither msiexec /x nor the old installer ran");
    assert!(rig.visible(&[v2]).is_empty(), "the old version is not known to work");
    let reports = rig.reports();
    assert_eq!((reports.len(), reports[0].detail.as_deref()), (1, Some("rollback_unsupported")));
    assert_eq!(reports[0].installed_version, Some(None), "the version the PC has is unknown: cleared");
    rig.stop().await;
}

#[tokio::test(start_paused = true)]
async fn a_rollback_whose_previous_installer_fails_says_so() {
    let (mut rig, _v1, v2) = rolled_back_rig(1).await;
    // The old installer fails too (the last of the three scripted exits).
    rig.sim.with_world(|w| {
        w.installer_exits.clear();
        w.installer_exits.extend([InstallerExit::Code(1603), InstallerExit::Code(0), InstallerExit::Code(1603)]);
    });
    rig.set_catalog(vec![v2]);
    rig.until("failed", |r| r.state("a1") == Some(LocalState::Failed)).await;
    let record = rig.record("a1").unwrap();
    assert_eq!((record.detail.as_deref(), record.old_works), (Some("rollback_failed"), false));
    assert_eq!(rig.runs().len(), 4);
    // A hand-edited `installs.json` cannot make the roll-back start anything else: a kept file is a hash and `.msi` / `.exe`.
    rig.stop().await;
}

#[tokio::test(start_paused = true)]
async fn a_tampered_kept_installer_is_never_started() {
    let (mut rig, _v1, v2) = rolled_back_rig(1).await;
    // The kept file changed on disk: its SHA-256 no longer matches, so it is not run (and the update's failure stays).
    std::fs::write(rig.installer_file(b"v1", "msi"), b"planted").unwrap();
    rig.set_catalog(vec![v2]);
    rig.until("failed", |r| r.state("a1") == Some(LocalState::Failed)).await;
    assert_eq!(rig.record("a1").unwrap().detail.as_deref(), Some("rollback_failed"));
    let runs = rig.runs();
    assert!(runs.iter().all(|run| !run.args.iter().any(|a| a.contains("planted"))));
    assert_eq!(runs.len(), 3, "the install of v1, the failed v2 and the uninstall of v2: the planted file never ran");
    rig.assert_every_run_is_allowed();
    rig.stop().await;
}

#[tokio::test(start_paused = true)]
async fn low_disk_keeps_no_installer_and_the_failed_update_then_has_nothing_to_roll_back_to() {
    let v1 = managed(app("a1", "msi", b"v1", 1, true), "1.0.0");
    let v2 = managed(app("a1", "msi", b"v2", 2, true), "2.0.0");
    let mut rig = rig();
    rig.sim.with_world(|w| w.disk_free_bytes = 2 * GIB);
    rig.serve(&v1, b"v1");
    rig.serve(&v2, b"v2");
    rig.set_catalog(vec![v1]);
    rig.start();
    rig.until("v1", |r| r.state("a1") == Some(LocalState::Installed)).await;
    assert!(rig.record("a1").unwrap().kept.is_none(), "under 3 GiB free: nothing is kept");
    assert!(rig.downloads().is_empty());
    rig.sim.with_world(|w| w.installer_exits.push_back(InstallerExit::Code(1603)));
    rig.set_catalog(vec![v2]);
    rig.until("failed", |r| r.state("a1") == Some(LocalState::Failed)).await;
    let record = rig.record("a1").unwrap();
    assert_eq!((record.detail.as_deref(), record.old_works), (Some("exit_code"), false), "the installer's own failure");
    assert_eq!(rig.runs().len(), 2, "no roll-back run");
    rig.stop().await;
}

#[tokio::test(start_paused = true)]
async fn rollback_on_fail_false_keeps_no_installer() {
    let v1 = with_update(app("a1", "msi", b"v1", 1, true), "1.0.0", json!({ "mode": "managed", "rollbackOnFail": false }));
    let mut rig = rig_with_installed(&v1, b"v1").await;
    assert!(rig.record("a1").unwrap().kept.is_none());
    assert!(rig.downloads().is_empty());
    rig.stop().await;
}

// ---------------------------------------------------------------- version detection (plan 4.6 "Detection")

#[tokio::test(start_paused = true)]
async fn a_version_below_the_catalogues_is_a_failure_for_managed_and_a_warning_for_pinned() {
    // Managed: the installer ran, but the program says 1.5 and the catalogue says 2.0.
    let managed_app = managed(app("m1", "msi", b"m", 1, true), "2.0.0");
    let pinned_app = pinned(app("p1", "msi", b"p", 1, true), "2.0.0");
    let mut rig = rig();
    rig.installs_version(b"m", "1.5.0.0");
    rig.installs_version(b"p", "1.5.0.0");
    rig.serve(&managed_app, b"m");
    rig.serve(&pinned_app, b"p");
    rig.set_catalog(vec![managed_app, pinned_app]);
    rig.start();
    rig.until("both ended", |r| r.state("m1") == Some(LocalState::Failed) && r.state("p1") == Some(LocalState::Installed)).await;
    let m = rig.record("m1").unwrap();
    assert_eq!((m.detail.as_deref(), m.last_exit_code), (Some("version_too_low"), Some(0)));
    let p = rig.record("p1").unwrap();
    assert_eq!((p.detail.as_deref(), p.installed_version.as_deref()), (Some("version_too_low"), Some("1.5.0.0")));
    let reports = rig.reports();
    let pinned_report = reports.iter().find(|r| r.app_id == "p1").unwrap();
    assert_eq!((pinned_report.state, pinned_report.detail.as_deref()), (InstallState::Installed, Some("version_too_low")));
    assert_eq!(pinned_report.installed_version, Some(Some("1.5.0.0".to_string())));
    rig.stop().await;
}

#[tokio::test(start_paused = true)]
async fn a_program_without_a_version_resource_has_the_version_the_engine_installed() {
    let v1 = pinned(app("a1", "msi", b"v1", 1, true), "7.1");
    let mut rig = rig();
    rig.serve(&v1, b"v1");
    rig.set_catalog(vec![v1]);
    rig.start();
    rig.until("v1", |r| r.state("a1") == Some(LocalState::Installed)).await;
    assert_eq!(rig.record("a1").unwrap().installed_version.as_deref(), Some("7.1"));
    assert_eq!(rig.reports()[0].installed_version, Some(Some("7.1".to_string())));
    rig.stop().await;
}

// ---------------------------------------------------------------- the publisher of an installer file (plan 4.4.3)

#[tokio::test(start_paused = true)]
async fn an_installer_not_signed_by_the_publisher_does_not_run() {
    let mut a1 = app("a1", "msi", b"signed", 1, true);
    a1.desktop.as_mut().unwrap().install.as_mut().unwrap().publisher = Some("O=Acme Ltd".into());
    let mut rig = rig();
    rig.serve(&a1, b"signed");
    rig.set_catalog(vec![a1.clone()]);
    // Signed by somebody else.
    rig.sign_installer(b"signed", "msi", "CN=Evil Corp, O=Evil Corp, C=US");
    rig.start();
    rig.until("refused", |r| r.state("a1") == Some(LocalState::Failed)).await;
    assert_eq!(rig.record("a1").unwrap().detail.as_deref(), Some("publisher_mismatch"));
    assert!(rig.runs().is_empty(), "nothing ran");
    // Unsigned: refused too (no signer is not the publisher).
    rig.sim.with_world(|w| w.programs.clear());
    let again = {
        let mut next = app("a1", "msi", b"signed", 2, true);
        next.desktop.as_mut().unwrap().install.as_mut().unwrap().publisher = Some("O=Acme Ltd".into());
        next
    };
    rig.set_catalog(vec![again.clone()]);
    rig.until("refused again", |r| r.record("a1").is_some_and(|x| x.revision == 2 && x.state == LocalState::Failed)).await;
    assert!(rig.runs().is_empty());
    // Signed by the publisher: it runs.
    rig.sign_installer(b"signed", "msi", ACME);
    let third = {
        let mut next = app("a1", "msi", b"signed", 3, true);
        next.desktop.as_mut().unwrap().install.as_mut().unwrap().publisher = Some("O=Acme Ltd".into());
        next
    };
    rig.set_catalog(vec![third]);
    rig.until("installed", |r| r.state("a1") == Some(LocalState::Installed)).await;
    assert_eq!(rig.runs().len(), 1);
    rig.stop().await;
}

// ---------------------------------------------------------------- Vendor self-update: every row of the table of 4.4.3

/// A Vendor app whose bootstrap (`bytes`) is signed by the vendor, with the program preinstalled at `file_version`.
fn signed_vendor(rig: &Rig, id: &str, bytes: &[u8], version: &str, min: Option<&str>, revision: u64) -> CatalogApp {
    let app = vendor(app(id, "msi", bytes, revision, true), version, min);
    rig.serve(&app, bytes);
    rig.sign_installer(bytes, "msi", ACME);
    app
}

#[tokio::test(start_paused = true)]
async fn vendor_row_1_not_installed_installs_the_bootstrap_after_the_publisher_check() {
    let mut rig = rig();
    let boot = vendor(app("a1", "msi", b"boot", 1, true), "1.0", None);
    rig.serve(&boot, b"boot");
    rig.set_catalog(vec![boot.clone()]);
    rig.sign_installer(b"boot", "msi", "CN=Evil Corp, O=Evil Corp, C=US");
    rig.start();
    rig.until("refused", |r| r.state("a1") == Some(LocalState::Failed)).await;
    assert_eq!(rig.record("a1").unwrap().detail.as_deref(), Some("publisher_mismatch"));
    assert!(rig.runs().is_empty());
    // The vendor's own signature: the bootstrap runs, like a Pinned install.
    rig.sign_installer(b"boot", "msi", ACME);
    let again = vendor(app("a1", "msi", b"boot", 2, true), "1.0", None);
    rig.set_catalog(vec![again]);
    rig.until("installed", |r| r.state("a1") == Some(LocalState::Installed)).await;
    let record = rig.record("a1").unwrap();
    assert_eq!((record.mode, record.version.as_deref()), (UpdateMode::Vendor, Some("1.0")));
    assert!(record.kept.is_none(), "a Vendor bootstrap is not kept");
    assert_eq!(rig.runs().len(), 1);
    rig.stop().await;
}

#[tokio::test(start_paused = true)]
async fn vendor_row_2_a_new_bootstrap_hash_changes_nothing_on_a_pc_that_has_the_app() {
    let mut rig = rig();
    rig.installs_version(b"boot1", "1.0.0.0");
    let boot1 = signed_vendor(&rig, "a1", b"boot1", "1.0", None, 1);
    rig.set_catalog(vec![boot1.clone()]);
    rig.start();
    rig.until("installed", |r| r.state("a1") == Some(LocalState::Installed)).await;
    rig.report.accept_installs();
    let calls_before = rig.downloader.calls().len();
    let boot2 = signed_vendor(&rig, "a1", b"boot2", "2.0", None, 2);
    rig.set_catalog(vec![boot2.clone()]);
    rig.until("followed", |r| r.record("a1").is_some_and(|x| x.sha256 == sha(b"boot2"))).await;
    rig.settle().await;
    assert_eq!(rig.runs().len(), 1, "no reinstall");
    assert_eq!(rig.downloader.calls().len(), calls_before, "not even a download");
    let record = rig.record("a1").unwrap();
    assert_eq!((record.state, record.update, record.version.as_deref(), record.revision), (LocalState::Installed, false, Some("2.0"), 2));
    assert_eq!(record.installed_version.as_deref(), Some("1.0.0.0"), "the vendor's updater owns the version");
    assert_eq!(rig.visible(&[boot2]), ["a1"], "the tile stays");
    // The record keeps the new values: its result carries the new revision.
    let reports = rig.reports();
    assert_eq!((reports.len(), reports[0].app_revision, reports[0].state), (1, 2, InstallState::Installed));
    rig.stop().await;
}

#[tokio::test(start_paused = true)]
async fn vendor_row_3_a_missing_program_is_looked_for_twice_and_never_while_the_updater_runs() {
    let mut rig = rig();
    let boot = signed_vendor(&rig, "a1", b"boot", "1.0", None, 1);
    rig.set_catalog(vec![boot.clone()]);
    rig.start();
    rig.until("installed", |r| r.state("a1") == Some(LocalState::Installed)).await;
    let exe = exe_of(&boot);
    rig.sim.with_world(|w| {
        w.files.remove(&exe);
    });
    let minutes = |n: u64| Duration::from_secs(n * 60);
    // First miss: nothing is installed, the looking starts (a local state, never reported).
    rig.report.accept_installs();
    rig.poke();
    rig.settle().await;
    let record = rig.record("a1").unwrap();
    assert!(record.verifying_since_ms.is_some() && record.verify_looks == 0);
    assert_eq!(rig.runs().len(), 1);
    assert!(rig.reports().is_empty(), "`verifying` is not reported");
    // Reconcile occasions inside 15 minutes change nothing.
    advance(minutes(14)).await;
    rig.poke();
    rig.settle().await;
    assert_eq!(rig.record("a1").unwrap().verify_looks, 0);
    // The first look, 15 minutes after the miss.
    advance(minutes(2)).await;
    rig.poke();
    rig.settle().await;
    assert_eq!(rig.record("a1").unwrap().verify_looks, 1);
    assert_eq!(rig.runs().len(), 1);
    // A program signed by the vendor runs as SYSTEM (its updater): the second look waits, however late.
    let updater = r"C:\Program Files\Acme\updater.exe";
    rig.sim.add_program(updater, FileIdentity { signer: Some(ACME.into()), original_name: None, product: None }, None);
    rig.sim.with_world(|w| w.processes.push(SimProcess { pid: 31, session_id: 0, image: PathBuf::from(updater), user_sid: "S-1-5-18".into() }));
    advance(minutes(60)).await;
    rig.poke();
    rig.settle().await;
    assert_eq!(rig.runs().len(), 1, "never while the vendor's updater runs");
    assert_eq!(rig.record("a1").unwrap().verify_looks, 1);
    // A SYSTEM process of somebody else does not count.
    rig.sim.with_world(|w| w.processes.clear());
    rig.sim.add_program(r"C:\Windows\System32\other.exe", FileIdentity { signer: Some("CN=Other, O=Other".into()), original_name: None, product: None }, None);
    rig.sim.with_world(|w| w.processes.push(SimProcess { pid: 32, session_id: 0, image: PathBuf::from(r"C:\Windows\System32\other.exe"), user_sid: "S-1-5-18".into() }));
    // The second look still finds nothing: the bootstrap is installed again.
    rig.poke();
    rig.until("installed again", |r| r.runs().len() == 2 && r.state("a1") == Some(LocalState::Installed)).await;
    assert_eq!(rig.record("a1").unwrap().verifying_since_ms, None);
    rig.stop().await;
}

#[tokio::test(start_paused = true)]
async fn vendor_row_3_a_program_that_comes_back_ends_the_looking() {
    let mut rig = rig();
    let boot = signed_vendor(&rig, "a1", b"boot", "1.0", None, 1);
    rig.set_catalog(vec![boot.clone()]);
    rig.start();
    rig.until("installed", |r| r.state("a1") == Some(LocalState::Installed)).await;
    let exe = exe_of(&boot);
    rig.sim.with_world(|w| {
        w.files.remove(&exe);
    });
    rig.poke();
    rig.settle().await;
    assert!(rig.record("a1").unwrap().verifying_since_ms.is_some());
    // The vendor's updater put it back.
    rig.sim.add_file(exe.to_str().unwrap());
    rig.poke();
    rig.settle().await;
    assert_eq!(rig.record("a1").unwrap().verifying_since_ms, None);
    advance(Duration::from_secs(3 * 3600)).await;
    rig.poke();
    rig.settle().await;
    assert_eq!(rig.runs().len(), 1, "nothing was reinstalled");
    rig.stop().await;
}

#[tokio::test(start_paused = true)]
async fn vendor_row_4_below_the_minimum_the_bootstrap_runs_at_the_next_apply_window() {
    let mut rig = rig();
    let boot = signed_vendor(&rig, "a1", b"boot", "3.0", Some("2.0"), 1);
    // The PC has 1.0 of the program; the bootstrap brings 3.0.
    rig.sim.add_file(exe_of(&boot).to_str().unwrap());
    rig.set_file_version(&boot, Some("1.0.0.0"));
    rig.installs_version(b"boot", "3.0.0.0");
    // An employee is signed in: the window is closed.
    rig.presence_tx.send_replace(true);
    rig.set_catalog(vec![boot.clone()]);
    rig.start();
    rig.until("staged", |r| r.record("a1").is_some_and(|x| x.update && x.staged)).await;
    rig.settle().await;
    assert!(rig.runs().is_empty(), "no run while the employee is signed in");
    assert_eq!(rig.record("a1").unwrap().installed_version.as_deref(), Some("1.0.0.0"));
    // Signed out: the current bootstrap runs, and the new version is reported once.
    rig.report.accept_installs();
    rig.presence_tx.send_replace(false);
    rig.until("updated", |r| r.record("a1").is_some_and(|x| !x.update && x.state == LocalState::Installed && x.installed_version.as_deref() == Some("3.0.0.0"))).await;
    assert_eq!(rig.runs().len(), 1);
    let reports = rig.reports();
    assert_eq!((reports.len(), reports[0].installed_version.clone()), (1, Some(Some("3.0.0.0".to_string()))));
    // A bootstrap that does not reach the minimum is a failure, not a loop.
    rig.stop().await;
}

#[tokio::test(start_paused = true)]
async fn vendor_row_4_a_bootstrap_that_does_not_reach_the_minimum_fails_once_and_does_not_loop() {
    let mut rig = rig();
    let boot = signed_vendor(&rig, "a1", b"boot", "3.0", Some("2.0"), 1);
    rig.sim.add_file(exe_of(&boot).to_str().unwrap());
    rig.set_file_version(&boot, Some("1.0.0.0"));
    // The bootstrap runs but leaves the program at 1.5 (an old payload).
    rig.installs_version(b"boot", "1.5.0.0");
    rig.set_catalog(vec![boot]);
    rig.start();
    rig.until("failed", |r| r.state("a1") == Some(LocalState::Failed)).await;
    assert_eq!(rig.record("a1").unwrap().detail.as_deref(), Some("version_too_low"));
    // Three tries at the most, an hour apart, then final: never a loop.
    advance(Duration::from_secs(5 * 3600)).await;
    rig.settle().await;
    assert!(rig.runs().len() <= 3, "{} runs", rig.runs().len());
    advance(Duration::from_secs(10 * 24 * 3600)).await;
    rig.settle().await;
    assert!(rig.runs().len() <= 3);
    rig.stop().await;
}

#[tokio::test(start_paused = true)]
async fn vendor_row_5_an_installed_version_above_the_bootstrap_is_left_alone_never_a_downgrade() {
    let mut rig = rig();
    let boot = signed_vendor(&rig, "a1", b"boot", "3.0", Some("2.0"), 1);
    rig.sim.add_file(exe_of(&boot).to_str().unwrap());
    rig.set_file_version(&boot, Some("5.0.0.0"));
    rig.set_catalog(vec![boot.clone()]);
    rig.start();
    rig.until("found", |r| r.state("a1") == Some(LocalState::Installed)).await;
    rig.settle().await;
    assert!(rig.runs().is_empty() && rig.downloader.calls().is_empty());
    assert_eq!(rig.record("a1").unwrap().installed_version.as_deref(), Some("5.0.0.0"));
    // An older bootstrap arrives (hash and version change): nothing runs either.
    let older = signed_vendor(&rig, "a1", b"older", "2.5", Some("2.0"), 2);
    rig.set_catalog(vec![older]);
    rig.until("followed", |r| r.record("a1").is_some_and(|x| x.sha256 == sha(b"older"))).await;
    rig.settle().await;
    assert!(rig.runs().is_empty() && rig.downloader.calls().is_empty());
    assert_eq!(rig.record("a1").unwrap().installed_version.as_deref(), Some("5.0.0.0"));
    // A minimum that is above the bootstrap itself is not run either (the server refuses that save; this is the second check).
    let broken = signed_vendor(&rig, "a1", b"older", "2.5", Some("9.0"), 3);
    rig.set_catalog(vec![broken]);
    rig.settle().await;
    assert!(rig.runs().is_empty());
    rig.stop().await;
}

#[tokio::test(start_paused = true)]
async fn vendor_row_6_a_version_that_changes_by_itself_is_reported_once() {
    let mut rig = rig();
    let boot = signed_vendor(&rig, "a1", b"boot", "1.0", None, 1);
    rig.sim.add_file(exe_of(&boot).to_str().unwrap());
    rig.set_file_version(&boot, Some("1.0.0.0"));
    rig.set_catalog(vec![boot.clone()]);
    rig.start();
    rig.until("found", |r| r.state("a1") == Some(LocalState::Installed)).await;
    assert_eq!(rig.reports()[0].installed_version, Some(Some("1.0.0.0".to_string())));
    rig.report.accept_installs();
    // The vendor's updater moved the program to 1.4.
    rig.set_file_version(&boot, Some("1.4.0.0"));
    rig.poke();
    rig.until("noticed", |r| r.record("a1").is_some_and(|x| x.installed_version.as_deref() == Some("1.4.0.0"))).await;
    let reports = rig.reports();
    assert_eq!((reports.len(), reports[0].installed_version.clone()), (1, Some(Some("1.4.0.0".to_string()))));
    // The same version again: nothing is sent.
    rig.report.accept_installs();
    rig.poke();
    rig.settle().await;
    assert!(rig.reports().is_empty());
    assert!(rig.runs().is_empty());
    rig.stop().await;
}

// ---------------------------------------------------------------- a program in a versioned folder (plan 4.4.3)

#[tokio::test(start_paused = true)]
async fn a_program_in_a_versioned_folder_is_found_at_the_highest_version() {
    let mut a1 = app("a1", "exe", b"boot", 1, false);
    a1.desktop.as_mut().unwrap().exe = r"{ProgramFiles}\Vendor\App\app-*\app.exe".into();
    let low = r"C:\Program Files\Vendor\App\app-1.2.0\app.exe";
    let high = r"C:\Program Files\Vendor\App\app-1.10.0\app.exe";
    let mut rig = rig();
    rig.sim.add_file(low);
    rig.sim.add_file(high);
    rig.sim.add_file(r"C:\Program Files\Vendor\App\readme.txt");
    rig.sim.with_world(|w| {
        w.file_versions.insert(key(Path::new(high)), "1.10.0.0".into());
        w.file_versions.insert(key(Path::new(low)), "1.2.0.0".into());
    });
    rig.set_catalog(vec![a1.clone()]);
    rig.start();
    rig.until("found", |r| r.state("a1") == Some(LocalState::Installed)).await;
    assert!(rig.runs().is_empty() && rig.downloader.calls().is_empty(), "it is installed: nothing to do");
    assert_eq!(rig.record("a1").unwrap().installed_version.as_deref(), Some("1.10.0.0"));
    // The employee's app list carries the resolved path.
    let resolver = AppResolver::with_installs(Arc::clone(&rig.sim) as Arc<dyn Platform>, Arc::clone(&rig.book), rig.paths.icons_dir());
    let entries = resolver.visible(std::slice::from_ref(&a1), "emp1");
    assert_eq!(entries.iter().map(|e| e.desktop.as_ref().unwrap().exe.clone()).collect::<Vec<_>>(), [high]);
    rig.stop().await;
}

// ---------------------------------------------------------------- what wakes the engine (plan 4.6 "No new timer")

#[test]
fn wake_sources_are_listed_and_nothing_else_wakes_the_engine() {
    use crate::installs::version::WAKE_SOURCES;
    let source = include_str!("engine.rs");
    let start = source.find("async fn run_loop(").expect("the engine's loop");
    let end = start + source[start..].find("#[path = \"drivers.rs\"]").expect("the end of the loop");
    let body = &source[start..end];
    // The one `select!` of the loop: every arm, and no more.
    let select = &body[body.find("tokio::select! {").expect("the select")..];
    let select = &select[..select.find("\n        }\n").expect("the end of the select")];
    let arms: Vec<&str> = select.lines().filter(|line| line.contains(" => ")).collect();
    assert_eq!(arms.len(), 6, "{arms:#?}");
    for (arm, name) in [
        ("shutdown.cancelled()", "(stopping)"),
        ("policy_rx.changed()", "policy"),
        ("snapshot_rx.changed()", "snapshot"),
        ("presence_rx.changed()", "presence"),
        ("exit_rx.recv()", "app_exit"),
        ("timer", "retry_timer"),
    ] {
        assert!(arms.iter().any(|line| line.contains(arm)), "{name}: no arm for {arm}");
    }
    assert_eq!(WAKE_SOURCES, ["policy", "snapshot", "presence", "app_exit", "retry_timer"]);
    assert_eq!(WAKE_SOURCES.len() + 1, arms.len(), "every arm but the stop is a listed wake source");
    // No interval, and only two sleeps in the whole engine: the retry timer, and the bounded wait for the program to
    // appear right after an installer (a job step, not a wake source).
    let code = &source[..source.find("#[path = \"drivers.rs\"]").unwrap()];
    assert!(!code.contains("tokio::time::interval") && !code.contains("std::thread::sleep"), "no polling loop");
    assert_eq!(code.matches("tokio::time::sleep(").count(), 2);
    assert_eq!(body.matches("tokio::time::sleep(").count(), 1, "the loop's only timer is the retry timer");
    // The sources that wait for events are channels and handles, never a period.
    let drivers = include_str!("drivers.rs");
    assert!(!drivers.contains("tokio::time::interval"));
}

#[tokio::test(start_paused = true)]
async fn an_update_that_waits_contributes_no_timer_to_the_plan() {
    // The plan of an engine whose only work is an update that waits for its window has no wake time at all.
    let v1 = app("a1", "msi", b"v1", 1, true);
    let mut rig = rig_with_installed(&v1, b"v1").await;
    rig.presence_tx.send_replace(true);
    rig.settle().await;
    let v2 = app("a1", "msi", b"v2", 2, true);
    rig.serve(&v2, b"v2");
    rig.set_catalog(vec![v2]);
    rig.until("staged", |r| r.record("a1").is_some_and(|x| x.staged)).await;
    rig.stop().await;
    // Rebuild an engine on the same records and ask it.
    let (exit_tx, _exit_rx) = mpsc::unbounded_channel::<u32>();
    let deps = EngineDeps {
        platform: Arc::clone(&rig.sim) as Arc<dyn Platform>,
        downloader: Arc::new(rig.downloader.clone()),
        paths: rig.paths.clone(),
        book: Arc::clone(&rig.book),
        report: Arc::clone(&rig.report),
        now_ms: Arc::new(|| BASE_MS),
        on_visible_change: Arc::new(|| {}),
        on_driver_change: Arc::new(|| {}),
        install_timeout: Duration::from_secs(1800),
        exe_wait: Duration::from_secs(10),
        shared: Arc::clone(&rig.shared),
        signed_in: rig.presence_tx.subscribe(),
    };
    let engine = Engine {
        deps,
        icons_tried: HashSet::new(),
        started_ms: BASE_MS,
        ever_signed_in: true,
        was_signed_in: true,
        exit_watches: HashMap::new(),
        exit_tx,
    };
    let plan = engine.plan(true, true);
    assert!(plan.job.is_none() && plan.wake.is_none(), "waiting for an event, not for a time");
    // Signed out: the same record is a job.
    let plan = engine.plan(true, false);
    assert!(plan.job.is_some_and(|job| job.id == "a1" && !job.stage));
}

// ---------------------------------------------------------------- roll-back of EXE and portable installs, Deferred, ordering

#[tokio::test(start_paused = true)]
async fn an_exe_update_that_fails_is_rolled_back_by_running_the_previous_installer_again() {
    let v1 = managed(app("a1", "exe", b"v1", 1, true), "1.0.0");
    let v2 = managed(app("a1", "exe", b"v2", 2, true), "2.0.0");
    let mut rig = rig();
    rig.installs_version(b"v1", "1.0.0.0");
    rig.installs_version(b"v2", "2.0.0.0");
    rig.serve(&v1, b"v1");
    rig.serve(&v2, b"v2");
    rig.set_catalog(vec![v1.clone()]);
    rig.start();
    rig.until("v1 installed", |r| r.state("a1") == Some(LocalState::Installed)).await;
    rig.report.accept_installs();
    let kept = rig.record("a1").unwrap().kept.expect("the installer of v1 is kept");
    assert_eq!((kept.ext.as_str(), kept.kind), ("exe", RecordKind::Exe));
    // The installer of v2 fails; the roll-back is the old installer, run again (an EXE needs no uninstall first).
    rig.sim.with_world(|w| {
        w.installer_exits.push_back(InstallerExit::Code(1));
        w.installer_exits.push_back(InstallerExit::Code(0));
    });
    rig.set_catalog(vec![v2.clone()]);
    rig.until("rolled back", |r| r.record("a1").is_some_and(|x| x.state == LocalState::Failed && x.attempts == 1)).await;
    let runs = rig.runs();
    assert_eq!(runs.len(), 3, "v1, the failed v2, v1 again: {runs:?}");
    assert_eq!(runs[1].program, rig.installer_file(b"v2", "exe"));
    assert_eq!(runs[2].program, rig.installer_file(b"v1", "exe"), "the previous installer, by its own hash");
    assert_eq!(runs[2].args.first().map(String::as_str), Some("/S"), "with its own silent arguments");
    assert!(runs.iter().all(|run| !run.args.iter().any(|a| a == "/x")), "no uninstall for an EXE");
    rig.assert_every_run_is_allowed();
    let record = rig.record("a1").unwrap();
    assert_eq!((record.detail.as_deref(), record.last_exit_code, record.old_works), (Some("update_rolled_back"), Some(1), true));
    assert_eq!(record.installed_version.as_deref(), Some("1.0.0.0"), "the old version is back");
    assert!(record.previous.is_none() && record.kept.is_some());
    assert_eq!(rig.visible(&[v1, v2]), ["a1"], "the old version works: the tile stays");
    let reports = rig.reports();
    assert_eq!(reports.len(), 1, "{reports:?}");
    assert_eq!((reports[0].state, reports[0].detail.as_deref()), (InstallState::Failed, Some("update_rolled_back")));
    assert_eq!(reports[0].installed_version, Some(Some("1.0.0.0".to_string())));
    rig.stop().await;
}

#[tokio::test(start_paused = true)]
async fn a_portable_update_that_fails_is_rolled_back_by_placing_the_previous_file_again() {
    let v1 = managed(app("a1", "portable", b"v1", 1, true), "1.0.0");
    let v2 = managed(app("a1", "portable", b"v2", 2, true), "2.0.0");
    let mut rig = rig();
    // The simulated platform does not read a version out of a placed file: the program says 1.5 all the time, which is
    // fine for v1 (1.0.0) and too low for v2 (2.0.0), so the update fails after the file was replaced.
    rig.set_file_version(&v1, Some("1.5.0.0"));
    rig.serve(&v1, b"v1");
    rig.serve(&v2, b"v2");
    rig.set_catalog(vec![v1.clone()]);
    rig.start();
    rig.until("v1 placed", |r| r.state("a1") == Some(LocalState::Installed)).await;
    rig.report.accept_installs();
    let kept = rig.record("a1").unwrap().kept.expect("the file of v1 is kept");
    assert_eq!((kept.ext.as_str(), kept.kind), ("exe", RecordKind::Portable));
    let places = |rig: &Rig| rig.sim.calls().iter().filter(|op| **op == SimOp::PlacePortable).count();
    assert_eq!(places(&rig), 1);
    rig.set_catalog(vec![v2.clone()]);
    rig.until("rolled back", |r| r.record("a1").is_some_and(|x| x.state == LocalState::Failed && x.attempts == 1)).await;
    assert_eq!(places(&rig), 3, "v1, v2, then v1 again");
    assert!(rig.runs().is_empty(), "a portable app never runs an installer");
    assert!(rig.sim.file_exists(&exe_of(&v1)), "the program is there again");
    let record = rig.record("a1").unwrap();
    assert_eq!((record.detail.as_deref(), record.old_works), (Some("update_rolled_back"), true));
    assert!(record.previous.is_none() && record.kept.is_some());
    assert_eq!(rig.visible(&[v1, v2]), ["a1"]);
    let reports = rig.reports();
    assert_eq!(reports.len(), 1, "{reports:?}");
    assert_eq!((reports[0].state, reports[0].detail.as_deref()), (InstallState::Failed, Some("update_rolled_back")));
    rig.stop().await;
}

#[tokio::test(start_paused = true)]
async fn an_update_whose_when_closed_window_closes_during_the_download_is_deferred_until_the_app_closes() {
    let v1 = with_update(app("a1", "msi", b"v1", 1, true), "1.0", json!({ "mode": "pinned", "applyWhen": "when_closed" }));
    let mut rig = rig_with_installed(&v1, b"v1").await;
    // An employee is signed in and the app is closed: for `when_closed` the window is open.
    rig.presence_tx.send_replace(true);
    rig.settle().await;
    let v2 = with_update(app("a1", "msi", b"v2", 2, true), "2.0", json!({ "mode": "pinned", "applyWhen": "when_closed" }));
    rig.serve(&v2, b"v2");
    rig.sim.with_world(|w| w.installer_exits.push_back(InstallerExit::Code(1603)));
    rig.set_catalog(vec![v2.clone()]);
    rig.until("failed once", |r| r.record("a1").is_some_and(|x| x.state == LocalState::Failed && x.attempts == 1)).await;
    assert_eq!(rig.runs().len(), 2, "the window was open: the installer ran");
    // The retry an hour later downloads again; the employee starts the app while the download is on its way.
    std::fs::remove_file(rig.installer_file(b"v2", "msi")).unwrap();
    let gate = rig.downloader.hold();
    advance(Duration::from_secs(3601)).await;
    rig.until("downloading", |r| r.downloader.calls().len() == 3).await;
    rig.run_app(&v1, 902);
    rig.settle().await;
    gate.add_permits(10);
    // Deferred: downloaded and verified, kept, not started; it says it waits for the app to close.
    rig.until("deferred", |r| r.record("a1").is_some_and(|x| x.state == LocalState::Installed && x.staged && x.update)).await;
    rig.until("says so", |r| r.book.update_state("a1") == Some(AppUpdateState::WaitingForClose)).await;
    assert_eq!(rig.runs().len(), 2, "nothing ran over the open app");
    assert!(rig.installer_file(b"v2", "msi").exists());
    assert!(!rig.sim.calls().contains(&SimOp::TerminateProcess), "a running app is never closed");
    // The employee closes the app (still signed in): the update runs.
    rig.sim.end_process(902);
    rig.until("v2 installed", |r| r.record("a1").is_some_and(|x| x.state == LocalState::Installed && !x.update && x.sha256 == sha(b"v2"))).await;
    assert_eq!(rig.runs().len(), 3);
    assert_eq!(rig.book.update_state("a1"), None);
    rig.stop().await;
}

/// Two installed apps (`a1`, `a2`) with an update each, staged while an employee is signed in.
async fn two_staged_updates() -> (Rig, CatalogApp, CatalogApp) {
    let (a1, a2) = (app("a1", "msi", b"a1v1", 1, true), app("a2", "msi", b"a2v1", 1, true));
    let mut rig = rig();
    rig.serve(&a1, b"a1v1");
    rig.serve(&a2, b"a2v1");
    rig.set_catalog(vec![a2.clone(), a1.clone()]);
    rig.start();
    rig.until("both installed", |r| r.state("a1") == Some(LocalState::Installed) && r.state("a2") == Some(LocalState::Installed)).await;
    rig.report.accept_installs();
    rig.presence_tx.send_replace(true);
    rig.settle().await;
    let (n1, n2) = (app("a1", "msi", b"a1v2", 2, true), app("a2", "msi", b"a2v2", 2, true));
    rig.serve(&n1, b"a1v2");
    rig.serve(&n2, b"a2v2");
    rig.set_catalog(vec![n2.clone(), n1.clone()]);
    rig.until("both staged", |r| r.record("a1").is_some_and(|x| x.staged) && r.record("a2").is_some_and(|x| x.staged)).await;
    rig.settle().await;
    assert_eq!(rig.runs().len(), 2, "no installer of an update ran while the employee was signed in");
    (rig, n1, n2)
}

#[tokio::test(start_paused = true)]
async fn two_updates_that_wait_run_one_at_a_time_in_the_order_of_the_app_ids_when_the_window_opens() {
    let (mut rig, _n1, _n2) = two_staged_updates().await;
    // Each says it waits, once.
    let waiting: Vec<_> = rig.reports().iter().map(|r| (r.app_id.clone(), r.detail.clone())).collect();
    assert_eq!(waiting.len(), 2, "{waiting:?}");
    assert!(waiting.iter().all(|(_, detail)| detail.as_deref() == Some("waiting_for_close")));
    rig.presence_tx.send_replace(false);
    rig.until("both updated", |r| {
        r.record("a1").is_some_and(|x| x.sha256 == sha(b"a1v2") && !x.update && x.state == LocalState::Installed)
            && r.record("a2").is_some_and(|x| x.sha256 == sha(b"a2v2") && !x.update && x.state == LocalState::Installed)
    })
    .await;
    let runs = rig.runs();
    assert_eq!(runs.len(), 4);
    // The catalogue lists a2 first; the engine goes by the app ids: a1, then a2. One at a time (the SimPlatform
    // runs an installer to its end before the next).
    assert_eq!(runs[2].args[1], rig.installer_file(b"a1v2", "msi").to_string_lossy());
    assert_eq!(runs[3].args[1], rig.installer_file(b"a2v2", "msi").to_string_lossy());
    rig.assert_every_run_is_allowed();
    // Two terminal results, one per app, no failure.
    let done = rig.reports();
    assert_eq!(done.len(), 2, "{done:?}");
    assert!(done.iter().all(|r| r.state == InstallState::Installed && r.detail.is_none()));
    rig.stop().await;
}

#[tokio::test(start_paused = true)]
async fn of_two_updates_only_the_one_whose_app_is_closed_runs_and_the_other_waits_for_its_own_app() {
    let (mut rig, n1, n2) = two_staged_updates().await;
    // a1 is running: a2 (later in id order) must not be held back by it, and a1 must not be updated under its user.
    let old_a1 = app("a1", "msi", b"a1v1", 1, true);
    rig.run_app(&old_a1, 311);
    rig.presence_tx.send_replace(false);
    rig.until("a2 updated", |r| r.record("a2").is_some_and(|x| x.sha256 == sha(b"a2v2") && !x.update && x.state == LocalState::Installed)).await;
    rig.settle().await;
    let runs = rig.runs();
    assert_eq!(runs.len(), 3, "only a2's installer ran");
    assert_eq!(runs[2].args[1], rig.installer_file(b"a2v2", "msi").to_string_lossy());
    assert!(rig.record("a1").is_some_and(|x| x.update && x.staged && x.state == LocalState::Installed), "a1 still waits");    assert_eq!(rig.book.update_state("a2"), None);
    assert!(!rig.sim.calls().contains(&SimOp::TerminateProcess));
    // a1's app closes: its update runs now.
    rig.sim.end_process(311);
    rig.until("a1 updated", |r| r.record("a1").is_some_and(|x| x.sha256 == sha(b"a1v2") && !x.update && x.state == LocalState::Installed)).await;
    let runs = rig.runs();
    assert_eq!(runs.len(), 4);
    assert_eq!(runs[3].args[1], rig.installer_file(b"a1v2", "msi").to_string_lossy());
    assert_eq!(rig.visible(&[n1, n2]), ["a1", "a2"]);
    rig.stop().await;
}
