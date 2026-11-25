//! Rulebox's own update through the MSI (Phase 6 Step 20, plan 4.17, PRD 23.1, 23.2, 23.9). The minimal pilot path: the
//! `versions\` flow with "Restart Rulebox" prompts, channels and deadlines (PRD 23.3, 23.4, 23.6) stays v1.x.
//!
//! **What it does.** The signed document's agent-only key `ruleboxRelease { version, url, sha256, sizeBytes }` names the
//! Rulebox build the organization wants. When it is **higher** than the running agent's version, this task
//!
//! 1. downloads the MSI into `<data>\selfupdate\<sha256>.msi` through the install engine's [`Downloader`] (https only, size
//!    cap, streamed through SHA-256, deleted when the hash is wrong; a different file never reaches the folder),
//! 2. waits for an apply window: **no employee signed in** (the sign-in screen, the boot window, a locked PC). The Staff
//!    session never sees a prompt and an employee is never signed out for this,
//! 3. just before the start: holds the file open locked against writers and hashes it again, checks the Authenticode
//!    signer, writes the attempt record, and starts `msiexec /i <msi> /qn /norestart` through the **separate, guarded**
//!    `Platform::start_self_upgrade`, which is **outside** the kill-on-close job (the MSI stops this very service),
//! 4. after the restart, the new agent reads its own version: at or above the attempt's version = updated; below it (the
//!    MSI rolled back by itself, or never ran) after a grace time = **failed**.
//!
//! **Refusals** (each one logged, written to the Windows event log where it matters, and never silently retried):
//!
//! | Case | Result |
//! |---|---|
//! | a lower version than the running one, or an unordered version | never installed (no downgrade) |
//! | the release is the running version | nothing |
//! | the SHA-256 of the download or of the staged file differs | `failed` (`hash_mismatch`), file deleted |
//! | signing is on and the MSI's signer is not the running agent's | `failed` (`publisher_mismatch`), file deleted |
//! | the MSI did not take (the version after the restart is still lower) | `failed` (`did_not_take`) |
//! | the platform refused to start it (the guard, a link in the way) | `failed` (`start_refused`) |
//! | an employee is signed in | waits (the presence wakes this task) |
//!
//! A **failed** release is remembered in `<data>\state\selfupdate.json` by `(version, sha256)` and is **not retried until a
//! new release** (another version or another hash). A download that cannot finish (network, disk full) is not a failure of
//! the release: it waits an hour, three times, and then waits for a new document or the next agent start.
//!
//! **The signer rule ("once signing is live").** There is no setting. If the *running* agent's exe carries a valid
//! Authenticode signature, signing is live for this PC and the new MSI must be signed by the same subject. If the running
//! agent is unsigned (a dev, pilot or `-unsigned` build, see `docs/guides/release.md`), only the SHA-256 of the signed
//! document decides. A signed fleet therefore never accepts an unsigned MSI, and nothing needs configuring when signing
//! goes live. The signer is a second check, not the first: SignPath signs other projects with the same certificate, so
//! the SHA-256 named by the signed document is the identity of the build. A running exe whose signature cannot be read
//! pauses the update (the rule is unknown) instead of assuming "unsigned".
//!
//! **What wakes it:** the signed document, the snapshot (enrollment, connection), the employee's sign-in or sign-out, and
//! one timer (a retry, the busy installer, the end of an attempt's grace time). No poll.

use std::cmp::Ordering;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use rulebox_ipc::types::{ConnectionStatus, EnrollmentStatus};
use rulebox_policy::{version, RuleboxRelease};
use serde::{Deserialize, Serialize};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use crate::agent_policy::AgentPolicy;
use crate::installs::download::{DownloadError, Downloader};
use crate::installs::version::publisher_matches;
use crate::installs::{download_deadline, is_sha256, open_verified, FileCheckError};
use crate::paths::DataPaths;
use crate::platform::{EventKind, Platform};
use crate::state::{read_json, remove_file_if_exists, write_atomic};

/// `selfupdate.json` schema.
pub const SCHEMA: u32 = 1;
/// The largest Rulebox MSI the agent downloads, whatever the document says (the real one is a few tens of MB).
pub const MAX_RELEASE_BYTES: u64 = 1024 * 1024 * 1024;
/// Free disk needed when the document does not say how big the file is.
const UNKNOWN_SIZE_DISK_NEED: u64 = 1024 * 1024 * 1024;
/// A download that could not finish (network, disk) is tried again after this long ...
const RETRY_GAP: Duration = Duration::from_secs(3600);
/// ... at most this many times in a row; then it waits for a new document or the next agent start.
const MAX_DOWNLOAD_FAILURES: u32 = 3;
/// Another installation is running (the install engine, or Windows itself): look again after this long. Not counted.
const BUSY_GAP: Duration = Duration::from_secs(120);
/// After msiexec was started, the agent that still runs this long afterwards decides the upgrade did not take.
const ATTEMPT_GRACE: Duration = Duration::from_secs(30 * 60);
/// How many failed releases are remembered (the oldest go first).
const KEEP_FAILED: usize = 8;

// Event log ids (Application log, source "Rulebox Agent"; Setup uses 1000 to 1004).
pub const EVENT_UPDATED: u32 = 1100;
pub const EVENT_STARTING: u32 = 1101;
pub const EVENT_REFUSED: u32 = 1102;
pub const EVENT_DID_NOT_TAKE: u32 = 1103;

/// Why a release failed (the closed list stored in `selfupdate.json`).
pub mod reason {
    pub const HASH_MISMATCH: &str = "hash_mismatch";
    pub const PUBLISHER_MISMATCH: &str = "publisher_mismatch";
    pub const DID_NOT_TAKE: &str = "did_not_take";
    pub const START_REFUSED: &str = "start_refused";
    pub const TOO_LARGE: &str = "too_large";
    pub const BAD_RELEASE: &str = "bad_release";
}

// ------------------------------------------------------------------------------------------------ the record

/// `<data>\state\selfupdate.json`: the attempt in flight and the releases that failed.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct SelfUpdateFile {
    pub schema: u32,
    /// Written **before** msiexec starts, so a crash or the service stopping in the middle never loses it.
    pub attempt: Option<Attempt>,
    /// Releases that failed, by `(version, sha256)`. Not retried.
    pub failed: Vec<FailedRelease>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Attempt {
    pub version: String,
    pub sha256: String,
    /// The version that started it.
    pub from_version: String,
    /// Unix ms.
    pub started_ms: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FailedRelease {
    pub version: String,
    pub sha256: String,
    /// One of [`reason`].
    pub reason: String,
}

// ------------------------------------------------------------------------------------------------ pure rules

/// What the document's release means for the running agent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    /// The release is the version that runs.
    Current,
    /// Higher, not failed before, a size that is allowed: update.
    Update,
    Refuse(Refusal),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    /// A version without an order (it cannot be compared with the running one).
    Unordered,
    /// Lower than the running version: never a downgrade.
    Lower,
    /// This `(version, sha256)` failed before; a new release is needed.
    AlreadyFailed,
    /// Larger than [`MAX_RELEASE_BYTES`].
    TooLarge,
}

impl Refusal {
    fn text(self) -> &'static str {
        match self {
            Refusal::Unordered => "its version has no order",
            Refusal::Lower => "it is lower than the running version",
            Refusal::AlreadyFailed => "this release failed before",
            Refusal::TooLarge => "it is larger than allowed",
        }
    }
}

/// Plan 4.17: the release against the version that runs. A higher version is the only thing that updates.
pub fn decide(running: &str, release: &RuleboxRelease, failed: &[FailedRelease]) -> Decision {
    match version::cmp(&release.version, running) {
        None => Decision::Refuse(Refusal::Unordered),
        Some(Ordering::Less) => Decision::Refuse(Refusal::Lower),
        Some(Ordering::Equal) => Decision::Current,
        Some(Ordering::Greater) => {
            if failed.iter().any(|f| f.version == release.version && f.sha256.eq_ignore_ascii_case(&release.sha256)) {
                Decision::Refuse(Refusal::AlreadyFailed)
            } else if release.size_bytes > MAX_RELEASE_BYTES {
                Decision::Refuse(Refusal::TooLarge)
            } else {
                Decision::Update
            }
        }
    }
}

/// The apply window of Rulebox's own update: no employee is signed in. (Unlike an app's update there is no "when closed":
/// the agent and the Staff App are replaced together, so an employee's session is never in the way.)
pub fn window_open(signed_in: bool) -> bool {
    !signed_in
}

/// Who must have signed the new MSI.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SignerRule {
    /// The running agent is not signed: signing is not live on this PC, the SHA-256 alone decides.
    Unsigned,
    /// The running agent is signed by this subject: the MSI must be too.
    Subject(String),
}

/// The rule from the signer of the running agent's exe (`None`: unsigned or not trusted).
pub fn signer_rule(running_signer: Option<&str>) -> SignerRule {
    match running_signer.map(str::trim).filter(|subject| !subject.is_empty()) {
        Some(subject) => SignerRule::Subject(subject.to_string()),
        None => SignerRule::Unsigned,
    }
}

/// Whether the MSI's signer (`None`: unsigned, or a signature that is not valid) satisfies the rule.
pub fn signer_ok(rule: &SignerRule, msi_signer: Option<&str>) -> bool {
    match rule {
        SignerRule::Unsigned => true,
        SignerRule::Subject(wanted) => msi_signer.is_some_and(|signer| publisher_matches(signer, wanted)),
    }
}

/// `path` as a comparable text (`\` separators, no trailing one, lower case) when it is absolute and has no `.`, `..` or
/// empty component; `None` otherwise.
fn plain(path: &Path) -> Option<String> {
    if !path.is_absolute() || path.components().any(|c| matches!(c, Component::CurDir | Component::ParentDir)) {
        return None;
    }
    let text = path.to_string_lossy().replace('/', "\\").to_ascii_lowercase();
    let text = text.trim_end_matches('\\').to_string();
    let ok = text.len() > 2 && text.as_bytes()[1] == b':' && text.split('\\').skip(1).all(|part| !part.is_empty() && part != "." && part != "..");
    ok.then_some(text)
}

/// The rule behind `Platform::start_self_upgrade`, shared by `WindowsPlatform` and `SimPlatform`: `msi` is
/// `<expected_sha256>.msi` directly in `selfupdate_dir`, `log` is a `.log` file directly in `logs_dir`, both plain absolute
/// paths with no quote or separator tricks in the file names. Nothing else is ever started.
pub fn upgrade_files_ok(selfupdate_dir: &Path, logs_dir: &Path, msi: &Path, expected_sha256: &str, log: &Path) -> bool {
    let directly_in = |dir: &Path, file: &Path| match (plain(dir), plain(file), file.parent().and_then(plain)) {
        (Some(dir), Some(_), Some(parent)) => dir == parent,
        _ => false,
    };
    let name = |file: &Path| file.file_name().and_then(|n| n.to_str()).map(str::to_string);
    let msi_name_ok = name(msi).is_some_and(|n| n == format!("{expected_sha256}.msi"));
    let log_name_ok = name(log).is_some_and(|n| {
        n.to_ascii_lowercase().ends_with(".log") && n.len() > 4 && n.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
    });
    is_sha256(expected_sha256) && directly_in(selfupdate_dir, msi) && directly_in(logs_dir, log) && msi_name_ok && log_name_ok
}

// ------------------------------------------------------------------------------------------------ the task

/// Everything the task needs.
pub struct SelfUpdateDeps {
    pub platform: Arc<dyn Platform>,
    pub downloader: Arc<dyn Downloader>,
    pub paths: DataPaths,
    /// The running agent's own exe: its signer is the signer rule.
    pub agent_exe: PathBuf,
    /// The wall clock, Unix ms.
    pub now_ms: Arc<dyn Fn() -> u64 + Send + Sync>,
    /// Whether an employee is signed in (`SessionManager::presence`).
    pub signed_in: watch::Receiver<bool>,
    /// Whether the install engine is running an installer (Windows allows one MSI at a time: the upgrade would answer 1618).
    pub installer_busy: Arc<dyn Fn() -> bool + Send + Sync>,
}

/// What an attempt in `selfupdate.json` says now.
enum Settle {
    /// No attempt in flight: go on.
    Free,
    /// msiexec was started and the answer is not known yet; look again at this Unix ms.
    Pending(u64),
}

struct Updater {
    deps: SelfUpdateDeps,
    file: SelfUpdateFile,
    /// Download failures in a row for the release `identity` (in memory: an agent start gives a fresh try).
    download_failures: u32,
    /// Earliest next try after a download failure, a busy installer or a paused rule (Unix ms).
    retry_at_ms: Option<u64>,
    /// The release the counters above are about, `(version, sha256)`.
    identity: Option<(String, String)>,
    /// The last refusal that was logged, so a document that stays the same does not log again at every wake.
    logged: Option<(String, String, Refusal)>,
}

fn ms(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

impl Updater {
    fn open(deps: SelfUpdateDeps) -> Self {
        let file = match read_json::<SelfUpdateFile>(&deps.paths.selfupdate_state()) {
            Ok(Some(file)) if file.schema <= SCHEMA => file,
            Ok(Some(file)) => {
                tracing::warn!(schema = file.schema, "selfupdate.json has an unknown schema; starting without it");
                SelfUpdateFile::default()
            }
            Ok(None) => SelfUpdateFile::default(),
            Err(error) => {
                tracing::warn!("cannot read selfupdate.json ({error}); starting without it");
                SelfUpdateFile::default()
            }
        };
        Self { deps, file, download_failures: 0, retry_at_ms: None, identity: None, logged: None }
    }

    fn now(&self) -> u64 {
        (self.deps.now_ms)()
    }

    /// Saves the record; `false` when it could not be written (nothing is started then).
    fn save(&mut self) -> bool {
        self.file.schema = SCHEMA;
        let path = self.deps.paths.selfupdate_state();
        let saved = serde_json::to_vec_pretty(&self.file).map_err(std::io::Error::other).and_then(|bytes| {
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            write_atomic(&path, &bytes)
        });
        match saved {
            Ok(()) => true,
            Err(error) => {
                tracing::error!("cannot save selfupdate.json: {error}");
                false
            }
        }
    }

    fn event(&self, kind: EventKind, id: u32, text: &str) {
        if let Err(error) = self.deps.platform.report_event(kind, id, text) {
            tracing::warn!("cannot write the event log entry {id}: {error}");
        }
    }

    fn msi_path(&self, sha256: &str) -> PathBuf {
        self.deps.paths.selfupdate_dir().join(format!("{sha256}.msi"))
    }

    /// Deletes everything in the `selfupdate` folder but `<keep>.msi` (plain files only; a link is removed, never followed).
    fn clean_staged(&self, keep: Option<&str>) {
        let dir = self.deps.paths.selfupdate_dir();
        let Ok(entries) = std::fs::read_dir(&dir) else { return };
        let keep_name = keep.map(|sha| format!("{sha}.msi"));
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
            if keep_name.as_deref() == Some(name.as_str()) {
                continue;
            }
            let removed = match entry.file_type() {
                Ok(kind) if kind.is_dir() && !kind.is_symlink() => std::fs::remove_dir_all(entry.path()),
                _ => std::fs::remove_file(entry.path()),
            };
            if let Err(error) = removed {
                tracing::warn!("cannot delete an old Rulebox download: {error}");
            }
        }
    }

    /// Remembers `release` as failed (until a new release), deletes what was staged and writes the event.
    fn fail_release(&mut self, release: &RuleboxRelease, why: &'static str) {
        tracing::error!(version = %release.version, why, "the Rulebox update is refused; it is not tried again until a new release");
        self.file.failed.retain(|f| !(f.version == release.version && f.sha256 == release.sha256));
        self.file.failed.push(FailedRelease { version: release.version.clone(), sha256: release.sha256.clone(), reason: why.to_string() });
        let excess = self.file.failed.len().saturating_sub(KEEP_FAILED);
        self.file.failed.drain(..excess);
        self.save();
        self.clean_staged(None);
        self.event(
            EventKind::Warning,
            EVENT_REFUSED,
            &format!("The update of Rulebox to version {} was refused ({why}). It is not tried again until a new release.", release.version),
        );
    }

    /// An attempt written before msiexec started: updated, still waiting, or failed.
    fn settle_attempt(&mut self, running: &str, now: u64) -> Settle {
        let Some(attempt) = self.file.attempt.clone() else { return Settle::Free };
        if matches!(version::cmp(running, &attempt.version), Some(Ordering::Equal | Ordering::Greater)) {
            tracing::info!(version = %attempt.version, "Rulebox was updated");
            self.file.attempt = None;
            self.save();
            self.clean_staged(None);
            self.event(EventKind::Information, EVENT_UPDATED, &format!("Rulebox was updated from version {} to {running}.", attempt.from_version));
            return Settle::Free;
        }
        let age = now.saturating_sub(attempt.started_ms);
        if age < ms(ATTEMPT_GRACE) {
            // The installer may still be running (or this agent restarted in the middle of it). A clock that went backwards
            // waits at most one grace time more.
            return Settle::Pending(now.saturating_add(ms(ATTEMPT_GRACE) - age.min(ms(ATTEMPT_GRACE))));
        }
        tracing::error!(version = %attempt.version, "the Rulebox upgrade did not take effect; the old version still runs");
        self.file.attempt = None;
        self.file.failed.retain(|f| !(f.version == attempt.version && f.sha256 == attempt.sha256));
        self.file.failed.push(FailedRelease { version: attempt.version.clone(), sha256: attempt.sha256.clone(), reason: reason::DID_NOT_TAKE.to_string() });
        let excess = self.file.failed.len().saturating_sub(KEEP_FAILED);
        self.file.failed.drain(..excess);
        self.save();
        self.clean_staged(None);
        self.event(
            EventKind::Error,
            EVENT_DID_NOT_TAKE,
            &format!("The update of Rulebox to version {} did not take effect; version {running} still runs. It is not tried again until a new release.", attempt.version),
        );
        Settle::Free
    }

    /// One pass. Returns when the task should look again by itself (Unix ms), or `None` to wait for a wake.
    async fn step(
        &mut self,
        policy: &AgentPolicy,
        running: &str,
        enrolled: bool,
        online: bool,
        shutdown: &CancellationToken,
    ) -> Option<u64> {
        let now = self.now();
        if let Settle::Pending(at) = self.settle_attempt(running, now) {
            return Some(at);
        }
        if !enrolled || !policy.has_document {
            return None;
        }
        let Some(release) = policy.rulebox_release.clone() else {
            self.clean_staged(None);
            return None;
        };
        let identity = (release.version.clone(), release.sha256.clone());
        if self.identity.as_ref() != Some(&identity) {
            // A new release: the counters start again.
            self.identity = Some(identity.clone());
            self.download_failures = 0;
            self.retry_at_ms = None;
        }
        match decide(running, &release, &self.file.failed) {
            Decision::Current => {
                self.clean_staged(None);
                None
            }
            Decision::Refuse(why) => {
                if self.logged.as_ref() != Some(&(identity.0.clone(), identity.1.clone(), why)) {
                    tracing::warn!(version = %release.version, "the Rulebox update is not done: {}", why.text());
                    self.logged = Some((identity.0, identity.1, why));
                }
                self.clean_staged(None);
                None
            }
            Decision::Update => self.update(&release, running, online, shutdown).await,
        }
    }

    async fn update(&mut self, release: &RuleboxRelease, running: &str, online: bool, shutdown: &CancellationToken) -> Option<u64> {
        let now = self.now();
        if self.download_failures >= MAX_DOWNLOAD_FAILURES {
            return None;
        }
        if let Some(at) = self.retry_at_ms {
            if now < at {
                return Some(at);
            }
            self.retry_at_ms = None;
        }
        // 1. The file: downloaded and verified (any time, so the window only has to start it).
        if self.stage(release, online, shutdown).await.is_none() {
            return self.retry_at_ms;
        }
        // 2. The apply window: nobody signed in.
        if !window_open(*self.deps.signed_in.borrow()) {
            tracing::info!(version = %release.version, "the Rulebox update waits for the employee to sign out");
            return None;
        }
        // 3. Windows installs one MSI at a time.
        if (self.deps.installer_busy)() {
            tracing::info!("the install engine is running an installer; the Rulebox update waits");
            self.retry_at_ms = Some(now.saturating_add(ms(BUSY_GAP)));
            return self.retry_at_ms;
        }
        self.start(release, running, now)
    }

    /// The MSI is in the selfupdate folder and its SHA-256 is the document's; `None` when it is not (yet).
    async fn stage(&mut self, release: &RuleboxRelease, online: bool, shutdown: &CancellationToken) -> Option<()> {
        let now = self.now();
        let dir = self.deps.paths.selfupdate_dir();
        if let Err(error) = std::fs::create_dir_all(&dir) {
            tracing::error!("cannot create the selfupdate folder: {error}");
            self.retry_at_ms = Some(now.saturating_add(ms(RETRY_GAP)));
            return None;
        }
        if !matches!(crate::installs::is_reparse_point(&dir), Ok(false)) {
            tracing::error!("the selfupdate folder is a link (or cannot be read); nothing is downloaded");
            self.retry_at_ms = Some(now.saturating_add(ms(RETRY_GAP)));
            return None;
        }
        self.clean_staged(Some(&release.sha256));
        let dest = self.msi_path(&release.sha256);
        if dest.exists() {
            if open_verified(&dest, &release.sha256).is_ok() {
                return Some(());
            }
            let _ = remove_file_if_exists(&dest);
        }
        if !online {
            return None;
        }
        let need = if release.size_bytes > 0 { release.size_bytes.saturating_mul(3) } else { UNKNOWN_SIZE_DISK_NEED };
        match self.deps.platform.disk_free_bytes() {
            Ok(free) if free < need => {
                tracing::warn!("not enough free disk space for the Rulebox update; it waits");
                self.retry_at_ms = Some(now.saturating_add(ms(RETRY_GAP)));
                return None;
            }
            Ok(_) => {}
            Err(error) => tracing::warn!("cannot read the free disk space ({error}); trying anyway"),
        }
        let max = if release.size_bytes > 0 { release.size_bytes.min(MAX_RELEASE_BYTES) } else { MAX_RELEASE_BYTES };
        let deadline = download_deadline(release.size_bytes);
        tracing::info!(version = %release.version, "downloading the Rulebox update");
        let fetched = tokio::select! {
            () = shutdown.cancelled() => return None,
            result = tokio::time::timeout(deadline, self.deps.downloader.fetch(&release.url, &dest, &release.sha256, max)) => result,
        };
        match fetched {
            Ok(Ok(())) => Some(()),
            Ok(Err(DownloadError::HashMismatch)) => {
                self.fail_release(release, reason::HASH_MISMATCH);
                None
            }
            Ok(Err(DownloadError::TooLarge)) => {
                self.fail_release(release, reason::TOO_LARGE);
                None
            }
            Ok(Err(DownloadError::NotHttps)) => {
                self.fail_release(release, reason::BAD_RELEASE);
                None
            }
            Ok(Err(error)) => {
                tracing::warn!("the Rulebox download failed: {error}");
                self.download_failed(now);
                None
            }
            Err(_) => {
                tracing::warn!("the Rulebox download did not finish in time");
                let _ = remove_file_if_exists(&crate::installs::download::part_path(&dest));
                self.download_failed(now);
                None
            }
        }
    }

    fn download_failed(&mut self, now: u64) {
        self.download_failures += 1;
        if self.download_failures >= MAX_DOWNLOAD_FAILURES {
            tracing::error!("the Rulebox download failed {MAX_DOWNLOAD_FAILURES} times; it waits for a new document or the next start");
            self.retry_at_ms = None;
        } else {
            self.retry_at_ms = Some(now.saturating_add(ms(RETRY_GAP)));
        }
    }

    /// The last checks and the start. Everything that can be refused is refused here, before the attempt is written.
    fn start(&mut self, release: &RuleboxRelease, running: &str, now: u64) -> Option<u64> {
        let msi = self.msi_path(&release.sha256);
        // Locked against writers and hashed again through the handle that stays open until the start returned.
        let verified = match open_verified(&msi, &release.sha256) {
            Ok(verified) => verified,
            Err(FileCheckError::Mismatch | FileCheckError::NotPlain) => {
                tracing::error!("the staged Rulebox MSI changed after its download; deleted, nothing ran");
                let _ = remove_file_if_exists(&msi);
                self.fail_release(release, reason::HASH_MISMATCH);
                return None;
            }
            Err(FileCheckError::Io(error)) => {
                tracing::error!("cannot open the staged Rulebox MSI: {error}");
                self.download_failed(now);
                return self.retry_at_ms;
            }
        };
        // The signer: the rule comes from the running agent. Unknown rule = pause, never "unsigned".
        let rule = match self.deps.platform.file_identity(&self.deps.agent_exe) {
            Ok(Some(identity)) => signer_rule(identity.signer.as_deref()),
            Ok(None) | Err(_) => {
                tracing::warn!("cannot read the signature of the running agent; the Rulebox update waits");
                self.retry_at_ms = Some(now.saturating_add(ms(RETRY_GAP)));
                return self.retry_at_ms;
            }
        };
        let msi_signer = match self.deps.platform.file_identity(verified.path()) {
            Ok(Some(identity)) => identity.signer,
            Ok(None) | Err(_) => None,
        };
        if !signer_ok(&rule, msi_signer.as_deref()) {
            tracing::error!("the Rulebox MSI is not signed by the signer of the running agent; deleted, nothing ran");
            drop(verified);
            self.fail_release(release, reason::PUBLISHER_MISMATCH);
            return None;
        }
        // The window is read again right before the start (an employee may have signed in during the checks).
        if !window_open(*self.deps.signed_in.borrow()) {
            return None;
        }
        let _ = std::fs::create_dir_all(self.deps.paths.logs_dir());
        // The attempt first: the start may stop this very process.
        self.file.attempt = Some(Attempt { version: release.version.clone(), sha256: release.sha256.clone(), from_version: running.to_string(), started_ms: now });
        if !self.save() {
            self.file.attempt = None;
            self.retry_at_ms = Some(now.saturating_add(ms(RETRY_GAP)));
            return self.retry_at_ms;
        }
        self.event(EventKind::Information, EVENT_STARTING, &format!("Updating Rulebox from version {running} to {}.", release.version));
        tracing::info!(from = running, to = %release.version, "starting the Rulebox upgrade (msiexec /i /qn /norestart)");
        match self.deps.platform.start_self_upgrade(verified.path(), &release.sha256, &self.deps.paths.selfupdate_log()) {
            Ok(pid) => {
                tracing::info!(pid, "msiexec started outside the agent's job");
                Some(now.saturating_add(ms(ATTEMPT_GRACE)))
            }
            Err(error) => {
                tracing::error!("the Rulebox upgrade could not be started: {error}");
                drop(verified);
                self.file.attempt = None;
                self.fail_release(release, reason::START_REFUSED);
                None
            }
        }
    }
}

/// The self-update task. Runs while the agent runs; ends with `shutdown`.
pub async fn run_self_update_task(
    deps: SelfUpdateDeps,
    mut policy_rx: watch::Receiver<AgentPolicy>,
    mut snapshot_rx: watch::Receiver<rulebox_ipc::types::AgentSnapshot>,
    shutdown: CancellationToken,
) {
    let mut presence_rx = deps.signed_in.clone();
    let mut updater = Updater::open(deps);
    let mut presence_open = true;
    loop {
        if shutdown.is_cancelled() {
            return;
        }
        let policy = policy_rx.borrow_and_update().clone();
        let (running, enrolled, online) = {
            let snapshot = snapshot_rx.borrow_and_update();
            (
                snapshot.agent_version.clone(),
                snapshot.enrollment == EnrollmentStatus::Enrolled,
                snapshot.connection == ConnectionStatus::Online,
            )
        };
        let _ = presence_rx.borrow_and_update();
        let wake = updater.step(&policy, &running, enrolled, online, &shutdown).await;
        if shutdown.is_cancelled() {
            return;
        }
        let now = updater.now();
        let timer = async {
            match wake {
                Some(at) => tokio::time::sleep(Duration::from_millis(at.saturating_sub(now))).await,
                None => std::future::pending::<()>().await,
            }
        };
        tokio::select! {
            () = shutdown.cancelled() => return,
            changed = policy_rx.changed() => {
                if changed.is_err() {
                    shutdown.cancelled().await;
                    return;
                }
            }
            changed = snapshot_rx.changed() => {
                if changed.is_err() {
                    shutdown.cancelled().await;
                    return;
                }
            }
            changed = presence_rx.changed(), if presence_open => {
                if changed.is_err() {
                    presence_open = false;
                }
            }
            () = timer => {}
        }
    }
}

#[cfg(test)]
#[path = "selfupdate_tests.rs"]
mod tests;
