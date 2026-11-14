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
            install_timeout: Duration::from_secs(1800),
            exe_wait: Duration::from_secs(10),
            shared: Arc::clone(&self.shared),
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
    rig.set_catalog(vec![v2.clone()]);
    rig.until("pending v2", |r| r.record("a1").is_some_and(|x| x.sha256 == sha(b"v2"))).await;
    assert!(rig.visible(std::slice::from_ref(&v2)).is_empty(), "hidden while the new version installs");
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
