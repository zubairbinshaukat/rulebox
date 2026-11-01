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
    Rig {
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
    assert_eq!(rig.record("a1").unwrap().last_exit_code, Some(3010));
    rig.stop().await;
    // Restarted before a reboot: still pending.
    let book = InstallBook::open(rig.paths.installs());
    rig.book = book;
    rig.start();
    rig.settle().await;
    assert_eq!(rig.report.restart_pending(), Some(true));
    rig.stop().await;
    // The PC booted after it: cleared.
    rig.sim.with_world(|w| w.boot_time_ms = since + 1);
    rig.start();
    rig.until("cleared", |r| r.report.restart_pending().is_none()).await;
    assert_eq!(rig.book.snapshot().restart_pending_since_ms, None);
    rig.stop().await;
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
    assert!(matches!(sim.run_installer(&cmd, Duration::from_secs(1)), Err(PlatformError::Other(_))));
    assert!(sim.with_world(|w| w.installer_runs.is_empty()));
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
