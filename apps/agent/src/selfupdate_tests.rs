//! Tests of Rulebox's own update (Phase 6 Step 20) with `SimPlatform` (nothing is executed: `start_self_upgrade` only records
//! the call) and `FakeDownloader` (nothing is downloaded). Time is paused: the retries and the attempt's grace time are driven
//! with `tokio::time::advance`.

use super::*;
use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};

use rulebox_ipc::types::AgentSnapshot;
use sha2::{Digest, Sha256};
use tokio::task::JoinHandle;

use crate::installs::download::fake::FakeDownloader;
use crate::installs::hex_lower;
use crate::platform::sim::{SimOp, SimPlatform};
use crate::platform::{FileIdentity, PlatformError};
use crate::testutil::{test_snapshot, TempDir};

const BASE_MS: u64 = 1_760_000_000_000;
const RUNNING: &str = "0.1.0";
const AGENT_EXE: &str = r"C:\Program Files\Rulebox\rulebox-agent.exe";
const SIGNER: &str = "CN=SignPath Foundation, O=SignPath Foundation, L=Lewes, S=Delaware, C=US";
const OTHER_SIGNER: &str = "CN=Some Other Project, O=Some Other Project, C=US";

fn sha(bytes: &[u8]) -> String {
    hex_lower(&Sha256::digest(bytes))
}

fn msi_bytes(version: &str) -> Vec<u8> {
    format!("rulebox msi {version}").into_bytes()
}

/// The release of `version`: its URL, the SHA-256 and size of `msi_bytes(version)`.
fn release(version: &str) -> RuleboxRelease {
    let bytes = msi_bytes(version);
    RuleboxRelease {
        version: version.to_string(),
        url: format!("https://dl.example.test/rulebox-{version}.msi"),
        sha256: sha(&bytes),
        size_bytes: bytes.len() as u64,
    }
}

fn identity(signer: Option<&str>) -> FileIdentity {
    FileIdentity { signer: signer.map(str::to_string), ..FileIdentity::default() }
}

struct Rig {
    _dir: TempDir,
    sim: Arc<SimPlatform>,
    downloader: FakeDownloader,
    paths: DataPaths,
    policy_tx: watch::Sender<AgentPolicy>,
    snapshot_tx: watch::Sender<AgentSnapshot>,
    /// Whether an employee is signed in (`false` at the start: the apply window is open).
    presence_tx: watch::Sender<bool>,
    busy: Arc<AtomicBool>,
    /// (Q-A3) The hold the self-update sets and the Staff account it closes (`None`: no kiosk).
    hold: crate::watchdog::ShellHold,
    staff_sid: Arc<std::sync::Mutex<Option<String>>>,
    shutdown: CancellationToken,
    task: Option<JoinHandle<()>>,
    start: tokio::time::Instant,
}

fn enrolled_snapshot(version: &str) -> AgentSnapshot {
    let mut snapshot = test_snapshot();
    snapshot.enrollment = EnrollmentStatus::Enrolled;
    snapshot.connection = ConnectionStatus::Online;
    snapshot.agent_version = version.to_string();
    snapshot
}

fn rig() -> Rig {
    let dir = TempDir::new();
    let paths = DataPaths::new(dir.path().to_path_buf());
    std::fs::create_dir_all(paths.state_dir()).unwrap();
    let sim = Arc::new(SimPlatform::new(dir.path().to_path_buf()));
    // The running agent's own exe exists on the simulated PC, unsigned unless a test says otherwise.
    sim.add_program(AGENT_EXE, identity(None), None);
    Rig {
        _dir: dir,
        sim,
        downloader: FakeDownloader::new(),
        paths,
        policy_tx: watch::channel(AgentPolicy { has_document: true, ..AgentPolicy::default() }).0,
        snapshot_tx: watch::channel(enrolled_snapshot(RUNNING)).0,
        presence_tx: watch::channel(false).0,
        busy: Arc::new(AtomicBool::new(false)),
        hold: crate::watchdog::ShellHold::default(),
        staff_sid: Arc::new(std::sync::Mutex::new(None)),
        shutdown: CancellationToken::new(),
        task: None,
        start: tokio::time::Instant::now(),
    }
}

impl Rig {
    fn shell(&self) -> UpgradeShell {
        let staff = Arc::clone(&self.staff_sid);
        UpgradeShell { hold: self.hold.clone(), staff_sid: Arc::new(move || staff.lock().unwrap().clone()) }
    }

    fn start(&mut self) {
        let start = self.start;
        let busy = Arc::clone(&self.busy);
        let deps = SelfUpdateDeps {
            platform: Arc::clone(&self.sim) as Arc<dyn Platform>,
            downloader: Arc::new(self.downloader.clone()),
            paths: self.paths.clone(),
            agent_exe: PathBuf::from(AGENT_EXE),
            now_ms: Arc::new(move || BASE_MS + start.elapsed().as_millis() as u64),
            signed_in: self.presence_tx.subscribe(),
            installer_busy: Arc::new(move || busy.load(AtomicOrdering::SeqCst)),
            shell: self.shell(),
        };
        self.task = Some(tokio::spawn(run_self_update_task(
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

    /// The document names `release` (and the file server has its bytes).
    fn publish(&self, release: &RuleboxRelease) {
        self.downloader.serve(&release.url, &msi_bytes(&release.version));
        self.policy_tx.send_modify(|p| p.rulebox_release = Some(release.clone()));
    }

    fn msi_path(&self, release: &RuleboxRelease) -> PathBuf {
        self.paths.selfupdate_dir().join(format!("{}.msi", release.sha256))
    }

    /// The running agent is signed by `signer` (signing is live on this PC).
    fn sign_agent(&self, signer: &str) {
        self.sim.add_program(AGENT_EXE, identity(Some(signer)), None);
    }

    /// What the signature check says about the downloaded MSI of `release`.
    fn sign_msi(&self, release: &RuleboxRelease, signer: Option<&str>) {
        self.sim.add_program(&self.msi_path(release).to_string_lossy(), identity(signer), None);
    }

    fn set_running(&self, version: &str) {
        self.snapshot_tx.send_modify(|s| s.agent_version = version.to_string());
    }

    fn started(&self) -> Vec<(PathBuf, String, PathBuf)> {
        self.sim.with_world(|w| w.self_upgrades.clone())
    }

    fn file(&self) -> SelfUpdateFile {
        read_json::<SelfUpdateFile>(&self.paths.selfupdate_state()).unwrap().unwrap_or_default()
    }

    fn events(&self) -> Vec<u32> {
        self.sim.with_world(|w| w.events.iter().map(|(_, id, _)| *id).collect())
    }

    fn staged_files(&self) -> Vec<String> {
        std::fs::read_dir(self.paths.selfupdate_dir())
            .map(|dir| dir.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect())
            .unwrap_or_default()
    }

    async fn until(&self, what: &str, cond: impl Fn(&Rig) -> bool) {
        for _ in 0..3000 {
            if cond(self) {
                return;
            }
            tokio::task::yield_now().await;
            std::thread::sleep(Duration::from_micros(200));
        }
        panic!("never happened: {what}; file: {:?}; started: {:?}", self.file(), self.started());
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

// ------------------------------------------------------------------------------------------------ the happy path

#[tokio::test(start_paused = true)]
async fn a_higher_release_is_downloaded_verified_and_started_with_nobody_signed_in() {
    let mut rig = rig();
    let r = release("0.1.1");
    rig.publish(&r);
    rig.start();
    rig.until("started", |rig| rig.started().len() == 1).await;
    let (msi, hash, log) = rig.started().remove(0);
    assert_eq!(msi, rig.msi_path(&r), "only the staged <sha256>.msi");
    assert_eq!(hash, r.sha256);
    assert_eq!(log, rig.paths.selfupdate_log());
    assert_eq!(std::fs::read(&msi).unwrap(), msi_bytes("0.1.1"));
    // The attempt is on disk before anything else can happen to the service.
    let file = rig.file();
    let attempt = file.attempt.expect("the attempt is recorded");
    assert_eq!((attempt.version.as_str(), attempt.from_version.as_str()), ("0.1.1", RUNNING));
    assert_eq!(attempt.sha256, r.sha256);
    assert!(rig.events().contains(&EVENT_STARTING));
    // The separate, guarded method; the install engine's `run_installer` is never used.
    let calls = rig.sim.calls();
    assert!(calls.contains(&SimOp::StartSelfUpgrade));
    assert!(!calls.contains(&SimOp::RunInstaller));
    assert_eq!(rig.downloader.calls(), vec![r.url.clone()]);
    rig.stop().await;
}

#[tokio::test(start_paused = true)]
async fn the_new_agent_sees_its_new_version_and_the_attempt_is_done() {
    let mut rig = rig();
    let r = release("0.1.1");
    rig.publish(&r);
    rig.start();
    rig.until("started", |rig| rig.started().len() == 1).await;
    // The MSI replaced the service: it restarts with the new version.
    rig.stop().await;
    rig.set_running("0.1.1");
    rig.start();
    rig.until("attempt settled", |rig| rig.file().attempt.is_none()).await;
    assert!(rig.file().failed.is_empty());
    assert!(rig.events().contains(&EVENT_UPDATED));
    assert!(rig.staged_files().is_empty(), "the MSI is deleted once it took");
    // Nothing starts again: the release is the running version.
    rig.settle().await;
    assert_eq!(rig.started().len(), 1);
    rig.stop().await;
}

// ------------------------------------------------------------------------------------------------ the Staff App is closed first (Q-A3)

const STAFF: &str = "S-1-5-21-1000-2000-3000-2001";

/// The Staff account is signed in on session 2 with the launcher and the Staff App running, and so is another user.
fn staff_with_shell(rig: &Rig) {
    rig.sim.add_session(2, Some(STAFF), true);
    *rig.staff_sid.lock().unwrap() = Some(STAFF.to_string());
    rig.sim.with_world(|world| {
        let process = |pid, session_id, image: &str, sid: &str| crate::platform::sim::SimProcess {
            pid,
            session_id,
            image: PathBuf::from(image),
            user_sid: sid.to_string(),
        };
        world.processes.push(process(900, 2, r"C:\Program Files\Rulebox\rulebox-shell.exe", STAFF));
        world.processes.push(process(901, 2, r"C:\Program Files\Rulebox\versions\0.1.0\rulebox-staff.exe", STAFF));
        world.processes.push(process(902, 1, r"C:\Program Files\Rulebox\rulebox-shell.exe", "S-1-5-21-1000-2000-3000-1999"));
    });
}

fn processes(rig: &Rig) -> Vec<u32> {
    let mut pids = rig.sim.with_world(|world| world.processes.iter().map(|p| p.pid).collect::<Vec<_>>());
    pids.sort_unstable();
    pids
}

#[tokio::test(start_paused = true)]
async fn the_staff_app_is_closed_before_msiexec_starts_and_the_watchdog_is_held() {
    let mut rig = rig();
    staff_with_shell(&rig);
    let r = release("0.1.1");
    rig.publish(&r);
    rig.start();
    rig.until("started", |rig| rig.started().len() == 1).await;
    let calls = rig.sim.calls();
    let position = |op: SimOp| calls.iter().position(|call| *call == op);
    assert!(position(SimOp::EndStaffShell) < position(SimOp::StartSelfUpgrade), "closed first: {calls:?}");
    // The launcher and the Staff App are gone; another user's process is not touched.
    assert_eq!(processes(&rig), [902]);
    // The watchdog is held for minutes (the wall clock of the test starts at BASE_MS), not for ever.
    assert!(rig.hold.active(BASE_MS + 60_000));
    assert!(!rig.hold.active(BASE_MS + 10 * 60_000));
    rig.stop().await;
}

#[tokio::test(start_paused = true)]
async fn nothing_is_closed_without_a_staff_account_or_while_an_employee_is_signed_in() {
    let mut rig = rig();
    // No kiosk: no Staff account to close, the upgrade starts as before.
    let r = release("0.1.1");
    rig.publish(&r);
    rig.start();
    rig.until("started", |rig| rig.started().len() == 1).await;
    assert!(!rig.sim.calls().contains(&SimOp::EndStaffShell));
    assert!(!rig.hold.active(BASE_MS));
    rig.stop().await;

    // An employee is signed in: the window is closed and nothing is touched, however long it waits.
    let mut rig = self::rig();
    staff_with_shell(&rig);
    rig.presence_tx.send_replace(true);
    let r = release("0.1.1");
    rig.publish(&r);
    rig.start();
    rig.until("staged", |rig| rig.msi_path(&r).exists()).await;
    advance(Duration::from_secs(3600)).await;
    rig.settle().await;
    assert!(!rig.sim.calls().contains(&SimOp::EndStaffShell));
    assert_eq!(processes(&rig), [900, 901, 902]);
    rig.stop().await;
}

#[tokio::test(start_paused = true)]
async fn a_failure_to_close_the_staff_app_does_not_stop_the_upgrade_and_releases_the_hold() {
    let mut rig = rig();
    staff_with_shell(&rig);
    rig.sim.fail_next(SimOp::EndStaffShell, PlatformError::AccessDenied);
    let r = release("0.1.1");
    rig.publish(&r);
    rig.start();
    rig.until("started", |rig| rig.started().len() == 1).await;
    assert!(!rig.hold.active(BASE_MS), "nothing was closed: the watchdog may act");
    assert_eq!(processes(&rig), [900, 901, 902]);
    rig.stop().await;
}

#[tokio::test(start_paused = true)]
async fn a_refused_start_releases_the_hold_so_the_staff_app_comes_back() {
    let mut rig = rig();
    staff_with_shell(&rig);
    rig.sim.fail_next(SimOp::StartSelfUpgrade, PlatformError::Guard("not an armed machine".into()));
    let r = release("0.1.1");
    rig.publish(&r);
    rig.start();
    rig.until("failed", |rig| rig.file().failed.iter().any(|f| f.reason == reason::START_REFUSED)).await;
    assert!(!rig.hold.active(BASE_MS), "the watchdog starts the launcher again at once");
    rig.stop().await;
}

// ------------------------------------------------------------------------------------------------ never while signed in

#[tokio::test(start_paused = true)]
async fn never_while_an_employee_is_signed_in() {
    let mut rig = rig();
    rig.presence_tx.send_replace(true);
    let r = release("0.1.1");
    rig.publish(&r);
    rig.start();
    // The file may be downloaded meanwhile, but msiexec is not started, however long it waits.
    rig.until("staged", |rig| rig.msi_path(&r).exists()).await;
    advance(Duration::from_secs(6 * 3600)).await;
    rig.settle().await;
    assert!(rig.started().is_empty(), "an employee is signed in");
    assert!(rig.file().attempt.is_none());
    assert!(!rig.sim.calls().contains(&SimOp::StartSelfUpgrade), "not even the platform call");
    // Signing out opens the window: the sign-out wakes the task.
    rig.presence_tx.send_replace(false);
    rig.until("started after sign-out", |rig| rig.started().len() == 1).await;
    assert_eq!(rig.downloader.calls().len(), 1, "the staged file was reused");
    rig.stop().await;
}

#[tokio::test(start_paused = true)]
async fn the_install_engine_running_an_installer_makes_it_wait() {
    let mut rig = rig();
    rig.busy.store(true, AtomicOrdering::SeqCst);
    let r = release("0.1.1");
    rig.publish(&r);
    rig.start();
    rig.until("staged", |rig| rig.msi_path(&r).exists()).await;
    rig.settle().await;
    assert!(rig.started().is_empty());
    rig.busy.store(false, AtomicOrdering::SeqCst);
    advance(Duration::from_secs(125)).await;
    rig.until("started when the engine is idle", |rig| rig.started().len() == 1).await;
    rig.stop().await;
}

#[test]
fn the_window_is_open_only_when_nobody_is_signed_in() {
    assert!(window_open(false));
    assert!(!window_open(true));
}

// ------------------------------------------------------------------------------------------------ hash and signer

#[tokio::test(start_paused = true)]
async fn a_hash_mismatch_is_refused_and_the_file_is_gone() {
    let mut rig = rig();
    let r = release("0.1.1");
    // The server's file is not the one the signed document names.
    rig.downloader.serve(&r.url, &vec![b'x'; r.size_bytes as usize]);
    rig.policy_tx.send_modify(|p| p.rulebox_release = Some(r.clone()));
    rig.start();
    rig.until("failed", |rig| rig.file().failed.len() == 1).await;
    let failed = rig.file().failed.remove(0);
    assert_eq!((failed.version.as_str(), failed.reason.as_str()), ("0.1.1", reason::HASH_MISMATCH));
    assert!(rig.started().is_empty());
    assert!(rig.staged_files().is_empty(), "nothing unverified stays on disk");
    assert!(rig.events().contains(&EVENT_REFUSED));
    // The same release is not downloaded again.
    rig.policy_tx.send_modify(|p| p.rulebox_release = Some(r.clone()));
    rig.settle().await;
    advance(Duration::from_secs(3 * 3600)).await;
    rig.settle().await;
    assert_eq!(rig.downloader.calls().len(), 1);
    rig.stop().await;
}

#[tokio::test(start_paused = true)]
async fn a_staged_file_that_was_changed_is_never_run() {
    let mut rig = rig();
    rig.presence_tx.send_replace(true);
    let r = release("0.1.1");
    rig.publish(&r);
    rig.start();
    rig.until("staged", |rig| rig.msi_path(&r).exists()).await;
    rig.settle().await;
    // Somebody (SYSTEM only: the folder is protected) replaces the verified file while the window is closed.
    std::fs::write(rig.msi_path(&r), b"swapped").unwrap();
    rig.presence_tx.send_replace(false);
    rig.until("started", |rig| rig.started().len() == 1).await;
    // The swapped file was thrown away and the verified one downloaded again: what runs is what was signed.
    assert_eq!(std::fs::read(&rig.started()[0].0).unwrap(), msi_bytes("0.1.1"));
    assert_eq!(rig.downloader.calls().len(), 2);
    rig.stop().await;
}

#[test]
fn a_file_swapped_right_before_the_start_is_refused_and_the_release_fails() {
    // The last check: between the staging and the start the file is opened locked and hashed again. (The task heals a swap it
    // sees while waiting by downloading again; this is the swap it cannot see coming.)
    let rig = rig();
    let r = release("0.1.1");
    let deps = SelfUpdateDeps {
        platform: Arc::clone(&rig.sim) as Arc<dyn Platform>,
        downloader: Arc::new(rig.downloader.clone()),
        paths: rig.paths.clone(),
        agent_exe: PathBuf::from(AGENT_EXE),
        now_ms: Arc::new(|| BASE_MS),
        signed_in: rig.presence_tx.subscribe(),
        installer_busy: Arc::new(|| false),
        shell: rig.shell(),
    };
    let mut updater = Updater::open(deps);
    std::fs::create_dir_all(rig.paths.selfupdate_dir()).unwrap();
    std::fs::write(rig.msi_path(&r), b"swapped").unwrap();
    assert_eq!(updater.start(&r, RUNNING, BASE_MS), None);
    assert!(rig.started().is_empty(), "nothing ran");
    assert!(!rig.sim.calls().contains(&SimOp::StartSelfUpgrade));
    let file = rig.file();
    assert_eq!(file.failed.len(), 1);
    assert_eq!(file.failed[0].reason, reason::HASH_MISMATCH);
    assert!(file.attempt.is_none());
    assert!(rig.staged_files().is_empty());
}
#[tokio::test(start_paused = true)]
async fn a_signer_mismatch_is_refused_once_signing_is_on() {
    let mut rig = rig();
    rig.sign_agent(SIGNER);
    let r = release("0.1.1");
    rig.sign_msi(&r, Some(OTHER_SIGNER));
    rig.publish(&r);
    rig.start();
    rig.until("failed", |rig| rig.file().failed.len() == 1).await;
    assert_eq!(rig.file().failed[0].reason, reason::PUBLISHER_MISMATCH);
    assert!(rig.started().is_empty());
    assert!(rig.staged_files().is_empty());
    assert!(rig.file().attempt.is_none());
    rig.stop().await;
}

#[tokio::test(start_paused = true)]
async fn an_unsigned_msi_is_refused_once_signing_is_on() {
    let mut rig = rig();
    rig.sign_agent(SIGNER);
    let r = release("0.1.1");
    // The MSI has no valid signature at all.
    rig.sign_msi(&r, None);
    rig.publish(&r);
    rig.start();
    rig.until("failed", |rig| rig.file().failed.len() == 1).await;
    assert_eq!(rig.file().failed[0].reason, reason::PUBLISHER_MISMATCH);
    assert!(rig.started().is_empty());
    rig.stop().await;
}

#[tokio::test(start_paused = true)]
async fn the_right_signer_is_accepted_once_signing_is_on() {
    let mut rig = rig();
    rig.sign_agent(SIGNER);
    let r = release("0.1.1");
    rig.sign_msi(&r, Some(SIGNER));
    rig.publish(&r);
    rig.start();
    rig.until("started", |rig| rig.started().len() == 1).await;
    assert!(rig.file().failed.is_empty());
    rig.stop().await;
}

#[tokio::test(start_paused = true)]
async fn with_signing_off_the_hash_alone_decides() {
    // The only path that accepts an unsigned MSI: the running agent is unsigned too (a pilot or `-unsigned` build).
    let mut rig = rig();
    let r = release("0.1.1");
    rig.sign_msi(&r, None);
    rig.publish(&r);
    rig.start();
    rig.until("started", |rig| rig.started().len() == 1).await;
    rig.stop().await;
}

#[tokio::test(start_paused = true)]
async fn a_running_agent_whose_signature_cannot_be_read_pauses_the_update() {
    // The rule is unknown: never assume "unsigned".
    let mut rig = rig();
    rig.sim.fail_next(SimOp::FileIdentity, PlatformError::AccessDenied);
    let r = release("0.1.1");
    rig.publish(&r);
    rig.start();
    rig.until("staged", |rig| rig.msi_path(&r).exists()).await;
    rig.settle().await;
    assert!(rig.started().is_empty());
    assert!(rig.file().failed.is_empty(), "a pause is not a failed release");
    // The next try (an hour later) reads it and goes on.
    advance(Duration::from_secs(3601)).await;
    rig.until("started", |rig| rig.started().len() == 1).await;
    rig.stop().await;
}

#[test]
fn the_signer_rule_comes_from_the_running_agent() {
    assert_eq!(signer_rule(None), SignerRule::Unsigned);
    assert_eq!(signer_rule(Some("  ")), SignerRule::Unsigned);
    let rule = signer_rule(Some(SIGNER));
    assert_eq!(rule, SignerRule::Subject(SIGNER.to_string()));
    assert!(signer_ok(&SignerRule::Unsigned, None));
    assert!(signer_ok(&SignerRule::Unsigned, Some(OTHER_SIGNER)), "signing off: only the hash decides");
    assert!(signer_ok(&rule, Some(SIGNER)));
    assert!(signer_ok(&rule, Some(&SIGNER.to_ascii_lowercase())), "case does not matter");
    assert!(!signer_ok(&rule, Some(OTHER_SIGNER)));
    assert!(!signer_ok(&rule, None), "no valid signature");
    assert!(!signer_ok(&rule, Some("")));
}

// ------------------------------------------------------------------------------------------------ versions

fn failed(version: &str, release: &RuleboxRelease) -> FailedRelease {
    FailedRelease { version: version.to_string(), sha256: release.sha256.clone(), reason: reason::DID_NOT_TAKE.to_string() }
}

#[test]
fn only_a_higher_version_updates() {
    let up = release("0.1.1");
    assert_eq!(decide("0.1.0", &up, &[]), Decision::Update);
    assert_eq!(decide("0.1.1", &up, &[]), Decision::Current);
    assert_eq!(decide("0.1.2", &up, &[]), Decision::Refuse(Refusal::Lower), "never a downgrade");
    assert_eq!(decide("0.2.0", &release("0.1.9"), &[]), Decision::Refuse(Refusal::Lower));
    // 0.10 is higher than 0.9: the ordering is the shared one, not text.
    assert_eq!(decide("0.9.0", &release("0.10.0"), &[]), Decision::Update);
    // A release candidate is below its release.
    assert_eq!(decide("0.1.1", &release("0.1.1-rc.1"), &[]), Decision::Refuse(Refusal::Lower));
    let mut odd = release("0.1.1");
    odd.version = "banana".into();
    assert_eq!(decide("0.1.0", &odd, &[]), Decision::Refuse(Refusal::Unordered));
    assert_eq!(decide("not a version", &up, &[]), Decision::Refuse(Refusal::Unordered));
    let mut big = release("0.1.1");
    big.size_bytes = MAX_RELEASE_BYTES + 1;
    assert_eq!(decide("0.1.0", &big, &[]), Decision::Refuse(Refusal::TooLarge));
}

#[tokio::test(start_paused = true)]
async fn a_lower_or_equal_version_is_refused_without_a_download() {
    let mut rig = rig();
    rig.set_running("0.2.0");
    rig.start();
    for version in ["0.1.9", "0.2.0"] {
        let r = release(version);
        rig.publish(&r);
        rig.settle().await;
    }
    assert!(rig.downloader.calls().is_empty(), "nothing is downloaded for a version that cannot be installed");
    assert!(rig.started().is_empty());
    assert!(!rig.sim.calls().contains(&SimOp::StartSelfUpgrade));
    assert!(rig.staged_files().is_empty());
    rig.stop().await;
}

// ------------------------------------------------------------------------------------------------ failed versions

#[tokio::test(start_paused = true)]
async fn a_failed_version_is_not_retried_until_a_new_release() {
    let mut rig = rig();
    let r = release("0.1.1");
    rig.publish(&r);
    rig.start();
    rig.until("started", |rig| rig.started().len() == 1).await;
    // The MSI rolled back by itself: the same agent still runs after the grace time.
    advance(Duration::from_secs(31 * 60)).await;
    rig.until("did not take", |rig| rig.file().failed.len() == 1).await;
    let file = rig.file();
    assert_eq!(file.failed[0], failed("0.1.1", &r));
    assert!(file.attempt.is_none());
    assert!(rig.events().contains(&EVENT_DID_NOT_TAKE));
    assert!(rig.staged_files().is_empty());
    // The same document again, a restart, hours: no second start and no new download.
    rig.policy_tx.send_modify(|p| p.rulebox_release = Some(r.clone()));
    rig.settle().await;
    rig.stop().await;
    rig.start();
    advance(Duration::from_secs(5 * 3600)).await;
    rig.settle().await;
    assert_eq!(rig.started().len(), 1);
    assert_eq!(rig.downloader.calls().len(), 1);
    // A new release (another version) is tried.
    let next = release("0.1.2");
    rig.publish(&next);
    rig.until("the new release starts", |rig| rig.started().len() == 2).await;
    assert_eq!(rig.started()[1].1, next.sha256);
    // The old failure is still remembered.
    assert_eq!(rig.file().failed.len(), 1);
    rig.stop().await;
}

#[tokio::test(start_paused = true)]
async fn the_same_version_with_another_hash_is_a_new_release() {
    let mut rig = rig();
    let r = release("0.1.1");
    rig.publish(&r);
    rig.start();
    rig.until("started", |rig| rig.started().len() == 1).await;
    advance(Duration::from_secs(31 * 60)).await;
    rig.until("failed", |rig| rig.file().failed.len() == 1).await;
    // The owner rebuilt 0.1.1: another file, so another release.
    let bytes = b"rulebox msi 0.1.1, rebuilt".to_vec();
    let rebuilt = RuleboxRelease { sha256: sha(&bytes), size_bytes: bytes.len() as u64, ..r.clone() };
    rig.downloader.serve(&rebuilt.url, &bytes);
    rig.policy_tx.send_modify(|p| p.rulebox_release = Some(rebuilt.clone()));
    rig.until("started again", |rig| rig.started().len() == 2).await;
    assert_eq!(rig.started()[1].1, rebuilt.sha256);
    rig.stop().await;
}

#[tokio::test(start_paused = true)]
async fn a_restart_during_the_grace_time_does_not_start_it_twice_or_fail_it_early() {
    let mut rig = rig();
    let r = release("0.1.1");
    rig.publish(&r);
    rig.start();
    rig.until("started", |rig| rig.started().len() == 1).await;
    // The agent restarts while msiexec may still be running: the attempt is still open.
    rig.stop().await;
    advance(Duration::from_secs(5 * 60)).await;
    rig.start();
    rig.settle().await;
    assert_eq!(rig.started().len(), 1, "no second start");
    assert!(rig.file().attempt.is_some());
    assert!(rig.file().failed.is_empty(), "not failed before the grace time is over");
    // The grace time ends with the old version still running: failed.
    advance(Duration::from_secs(26 * 60)).await;
    rig.until("failed", |rig| rig.file().failed.len() == 1).await;
    assert_eq!(rig.started().len(), 1);
    rig.stop().await;
}

#[tokio::test(start_paused = true)]
async fn a_platform_that_refuses_the_start_fails_the_release() {
    let mut rig = rig();
    rig.sim.fail_next(SimOp::StartSelfUpgrade, PlatformError::Guard("not an armed machine".into()));
    let r = release("0.1.1");
    rig.publish(&r);
    rig.start();
    rig.until("failed", |rig| rig.file().failed.len() == 1).await;
    assert_eq!(rig.file().failed[0].reason, reason::START_REFUSED);
    assert!(rig.file().attempt.is_none(), "no attempt stays open for a start that never happened");
    assert!(rig.started().is_empty());
    rig.stop().await;
}

#[test]
fn only_the_last_failed_releases_are_remembered() {
    let mut list: Vec<FailedRelease> = (0..KEEP_FAILED + 3).map(|i| failed(&format!("0.{i}.0"), &release("0.1.1"))).collect();
    let excess = list.len().saturating_sub(KEEP_FAILED);
    list.drain(..excess);
    assert_eq!(list.len(), KEEP_FAILED);
    assert_eq!(list[0].version, "0.3.0");
    // And the file survives a round trip with its defaults (a file from the future is not read).
    let file = SelfUpdateFile { schema: SCHEMA, attempt: None, failed: list };
    let text = serde_json::to_string(&file).unwrap();
    assert_eq!(serde_json::from_str::<SelfUpdateFile>(&text).unwrap(), file);
    assert_eq!(serde_json::from_str::<SelfUpdateFile>("{}").unwrap(), SelfUpdateFile::default());
}

// ------------------------------------------------------------------------------------------------ downloads

#[tokio::test(start_paused = true)]
async fn a_download_that_cannot_finish_is_not_a_failed_release() {
    let mut rig = rig();
    let r = release("0.1.1");
    for _ in 0..3 {
        rig.downloader.fail_next(&r.url, DownloadError::Network("connection reset".into()));
    }
    rig.publish(&r);
    rig.start();
    rig.until("first try", |rig| rig.downloader.calls().len() == 1).await;
    advance(Duration::from_secs(3601)).await;
    rig.until("second try", |rig| rig.downloader.calls().len() == 2).await;
    advance(Duration::from_secs(3601)).await;
    rig.until("third try", |rig| rig.downloader.calls().len() == 3).await;
    // Three in a row: it waits for a new document or the next agent start.
    advance(Duration::from_secs(4 * 3600)).await;
    rig.settle().await;
    assert_eq!(rig.downloader.calls().len(), 3);
    assert!(rig.file().failed.is_empty(), "the release itself did not fail");
    assert!(rig.started().is_empty());
    // The next agent start tries again, and now the network works.
    rig.stop().await;
    rig.start();
    rig.until("started", |rig| rig.started().len() == 1).await;
    rig.stop().await;
}

#[tokio::test(start_paused = true)]
async fn nothing_is_downloaded_while_offline_or_not_enrolled() {
    let mut rig = rig();
    rig.snapshot_tx.send_modify(|s| s.connection = ConnectionStatus::Offline);
    let r = release("0.1.1");
    rig.publish(&r);
    rig.start();
    rig.settle().await;
    assert!(rig.downloader.calls().is_empty(), "offline");
    rig.snapshot_tx.send_modify(|s| s.connection = ConnectionStatus::Online);
    rig.until("started when online", |rig| rig.started().len() == 1).await;
    rig.stop().await;

    let mut rig = rig_not_enrolled();
    let r = release("0.1.1");
    rig.publish(&r);
    rig.start();
    rig.settle().await;
    assert!(rig.downloader.calls().is_empty(), "not enrolled");
    assert!(rig.started().is_empty());
    rig.stop().await;
}

fn rig_not_enrolled() -> Rig {
    let rig = rig();
    rig.snapshot_tx.send_modify(|s| s.enrollment = EnrollmentStatus::NotEnrolled);
    rig
}

#[tokio::test(start_paused = true)]
async fn taking_the_release_out_of_the_document_deletes_the_staged_file() {
    let mut rig = rig();
    rig.presence_tx.send_replace(true);
    let r = release("0.1.1");
    rig.publish(&r);
    rig.start();
    rig.until("staged", |rig| rig.msi_path(&r).exists()).await;
    rig.policy_tx.send_modify(|p| p.rulebox_release = None);
    rig.until("cleaned", |rig| rig.staged_files().is_empty()).await;
    rig.stop().await;
}

// ------------------------------------------------------------------------------------------------ the platform seam

fn staged_msi(rig: &Rig, bytes: &[u8]) -> (PathBuf, String) {
    let hash = sha(bytes);
    std::fs::create_dir_all(rig.paths.selfupdate_dir()).unwrap();
    let msi = rig.paths.selfupdate_dir().join(format!("{hash}.msi"));
    std::fs::write(&msi, bytes).unwrap();
    (msi, hash)
}

#[test]
fn the_platform_starts_only_the_staged_file_with_its_own_hash() {
    let rig = rig();
    let log = rig.paths.selfupdate_log();
    let (msi, hash) = staged_msi(&rig, b"rulebox msi");
    // The file in the right place with the right hash.
    assert!(rig.sim.start_self_upgrade(&msi, &hash, &log).is_ok());
    assert_eq!(rig.started().len(), 1);
    // Another hash than the file's.
    let other = sha(b"another file");
    let mismatch = rig.sim.start_self_upgrade(&msi, &other, &log);
    assert!(matches!(mismatch, Err(PlatformError::Refused(_))), "{mismatch:?}");
    // A file that is not in the selfupdate folder, in the downloads folder, or in a subfolder.
    let elsewhere = rig.paths.downloads_dir().join(format!("{hash}.msi"));
    assert!(matches!(rig.sim.start_self_upgrade(&elsewhere, &hash, &log), Err(PlatformError::Refused(_))));
    let nested = rig.paths.selfupdate_dir().join("sub").join(format!("{hash}.msi"));
    assert!(matches!(rig.sim.start_self_upgrade(&nested, &hash, &log), Err(PlatformError::Refused(_))));
    // A log outside the logs folder.
    assert!(matches!(rig.sim.start_self_upgrade(&msi, &hash, &rig.paths.state_dir().join("x.log")), Err(PlatformError::Refused(_))));
    assert_eq!(rig.started().len(), 1, "only the first call was accepted");
}

#[test]
fn the_file_rule_names_the_two_places_and_nothing_else() {
    let sel = Path::new(r"C:\ProgramData\Rulebox\selfupdate");
    let logs = Path::new(r"C:\ProgramData\Rulebox\logs");
    let hash = sha(b"x");
    let msi = sel.join(format!("{hash}.msi"));
    let log = logs.join("selfupdate-msi.log");
    assert!(upgrade_files_ok(sel, logs, &msi, &hash, &log));
    // Case and a trailing separator in the folder do not matter.
    assert!(upgrade_files_ok(Path::new(r"c:\programdata\rulebox\SELFUPDATE\"), logs, &msi, &hash, &log));
    // The name must be the hash that was verified, in lower case, with the msi extension.
    assert!(!upgrade_files_ok(sel, logs, &msi, &sha(b"y"), &log));
    assert!(!upgrade_files_ok(sel, logs, &msi, &hash.to_uppercase(), &log));
    assert!(!upgrade_files_ok(sel, logs, &sel.join(format!("{hash}.exe")), &hash, &log));
    assert!(!upgrade_files_ok(sel, logs, &sel.join(format!("{hash}.msi.txt")), &hash, &log));
    // Not below another folder, not through `..`, not relative.
    assert!(!upgrade_files_ok(sel, logs, &Path::new(r"C:\ProgramData\Rulebox\downloads").join(format!("{hash}.msi")), &hash, &log));
    assert!(!upgrade_files_ok(sel, logs, &sel.join("..").join("downloads").join(format!("{hash}.msi")), &hash, &log));
    assert!(!upgrade_files_ok(sel, logs, &sel.join("a").join(format!("{hash}.msi")), &hash, &log));
    assert!(!upgrade_files_ok(sel, logs, Path::new(&format!("{hash}.msi")), &hash, &log));
    // The log: a `.log` with a plain name directly in the logs folder.
    assert!(!upgrade_files_ok(sel, logs, &msi, &hash, &sel.join("selfupdate-msi.log")));
    assert!(!upgrade_files_ok(sel, logs, &msi, &hash, &logs.join("evil.dll")));
    assert!(!upgrade_files_ok(sel, logs, &msi, &hash, &logs.join("a b.log")));
    assert!(!upgrade_files_ok(sel, logs, &msi, &hash, &logs.join(".log")));
    assert!(!upgrade_files_ok(sel, logs, &msi, &hash, Path::new("selfupdate-msi.log")));
}

// ------------------------------------------------------------------------------------------------ the "Do NOT"s

/// Every `.rs` file below `dir`, with its text.
fn sources(dir: &Path, out: &mut Vec<(PathBuf, String)>) {
    for entry in std::fs::read_dir(dir).unwrap().flatten() {
        let path = entry.path();
        if path.is_dir() {
            sources(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push((path.clone(), std::fs::read_to_string(&path).unwrap()));
        }
    }
}

#[test]
fn only_the_self_update_task_starts_the_upgrade_and_it_never_touches_the_versions_flow() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut all = Vec::new();
    sources(&src, &mut all);
    for (path, text) in &all {
        let name = path.strip_prefix(&src).unwrap().to_string_lossy().replace('\\', "/");
        if text.contains(".start_self_upgrade(") {
            // The task, its tests, and the platform seam's own implementations and tests. Nothing that serves the Staff
            // session (`ipc_shell`, `session`, `ipc_conn`) or an admin command may start it.
            assert!(
                name == "selfupdate.rs" || name == "selfupdate_tests.rs" || name.starts_with("platform/"),
                "{name} starts the Rulebox upgrade"
            );
        }
    }
    let task = std::fs::read_to_string(src.join("selfupdate.rs")).unwrap();
    let code = task.split("#[cfg(test)]").next().unwrap();
    for forbidden in [".run_installer(", "current_json", "versions_dir", "current.json", "launch_in_session", "KillOnCloseJob"] {
        assert!(!code.contains(forbidden), "selfupdate.rs must not use {forbidden}");
    }
}
