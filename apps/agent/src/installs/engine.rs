//! The install engine's state machine (plan 4.8 "Install engine", Step 14 item 3).
//!
//! **Desired set:** the desktop apps of the signed catalogue that have an
//! `install`. Each has a record in `<data>\state\installs.json` (`schema: 1`,
//! atomic writes, a file that does not parse is moved aside and the engine starts
//! empty: the Phase 2 rule of `read_json`).
//!
//! **Needs work:** an assigned app that is not installed and whose program is
//! missing (a program already at its path counts as installed, but is marked
//! `preexisting` and is never uninstalled or deleted: review fix); an installed app
//! whose SHA-256 changed (a new version) or whose program vanished; an app that
//! left the catalogue with `removeWhenUnassigned`, if it is an MSI with a product
//! code or a portable app (an exe is only hidden: it cannot be uninstalled).
//!
//! **One operation at a time**, in this one task. It runs at start, when the
//! policy (the verified document) or the snapshot (enrollment, connection)
//! changes, and when the earliest retry comes due (a timer, never a poll). It does
//! nothing while the device is not enrolled or is revoked; a revocation during an
//! operation lets that operation finish and starts nothing new. Downloads wait for
//! the connection (a PC offline does not burn its attempts); removals do not.
//!
//! **An install:** free disk (`sizeBytes x 3`) -> download into the protected
//! downloads folder (`<sha256>.<msi|exe>`, reused when it still matches) -> the
//! file is opened locked against writers and hashed again through that handle ->
//! msiexec / the exe / the portable copy runs while the handle is held -> the exit
//! code is read -> the program must exist within 10 s. Only then is the state
//! `installed` and the tile shown (PRD 13.5: never a half-installed app).
//!
//! **Retries:** a failure waits 1, 5, 15, 60, 360 minutes; the 6th failure is
//! final until the app's `revision` changes (the dashboard's Retry). `1618`
//! (another install running) or a running portable program waits 2 minutes and is
//! not counted, for at most 2 hours (then one counted failure). A stop of the
//! agent ends the running installer and its children; that run is not counted.
//!
//! **Crash recovery** (at start): `downloading` goes back to `pending` (the
//! `.part` file is deleted, nothing is counted); `installing` means the agent died
//! while an installer ran: one counted failure, then the normal retry (installers
//! are re-runnable: msiexec repairs or answers success for an installed product);
//! a removal simply runs again (`1605` "unknown product" counts as removed).

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rulebox_ipc::types::{AgentSnapshot, ConnectionStatus, EnrollmentStatus};
use rulebox_policy::catalog::{CatalogApp, InstallKind, InstallSpec};
use rulebox_policy::paths::{check_args, expand_exe, PathRoots};
use serde::{Deserialize, Serialize};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use super::download::{check_https, part_path, Downloader};
use super::drivers_rules::DriverRecord;
use super::report::report_of;
use super::{
    download_deadline, exe_install_command, icons, is_reparse_point, is_safe_id, is_sha256, judge_install,
    judge_removal, msi_install_command, msi_removal_command, open_verified, product_code, Detail, ExitVerdict,
    FileCheckError, BACKOFF_MINUTES, BUSY_RETRY, BUSY_WINDOW, EXE_POLL, KEEP_MSI_LOGS, MAX_DOWNLOAD_BYTES,
    MAX_FAILURES, MSI_REBOOT_INITIATED, MSI_REBOOT_REQUIRED,
};
use crate::agent_policy::AgentPolicy;
use crate::backend::InstallReport;
use crate::paths::DataPaths;
use crate::platform::{BootIdentity, InstallerCommand, InstallerExit, Platform, PlatformError};
use crate::report::ReportQueue;
use crate::state::{lock, read_json, remove_file_if_exists, write_atomic, SharedState};

pub const INSTALLS_SCHEMA: u32 = 1;

/// The local state of one app. Only `pending` and the terminal states are
/// reported (`report.rs`).
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum LocalState {
    Pending,
    Downloading,
    Installing,
    Installed,
    Failed,
    /// A removal waiting or running (an unassigned app).
    Removing,
    Removed,
    Unsupported,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RecordKind {
    Msi,
    Exe,
    Portable,
}

impl RecordKind {
    fn of(kind: InstallKind) -> Option<Self> {
        match kind {
            InstallKind::Msi => Some(RecordKind::Msi),
            InstallKind::Exe => Some(RecordKind::Exe),
            InstallKind::Portable => Some(RecordKind::Portable),
            InstallKind::Unknown => None,
        }
    }

    /// The extension of the downloaded file (a portable app is a single exe).
    fn ext(self) -> &'static str {
        match self {
            RecordKind::Msi => "msi",
            RecordKind::Exe | RecordKind::Portable => "exe",
        }
    }
}

/// One app in `installs.json` (`{ appId, sha256, state, attempts, nextTryMs,
/// lastExitCode }` of plan 4.8, plus what a removal and the reporting need).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InstallRecord {
    pub app_id: String,
    pub kind: RecordKind,
    pub sha256: String,
    /// The catalogue entry's revision this record follows.
    pub revision: u64,
    pub state: LocalState,
    /// Failures counted since the last new version or revision.
    #[serde(default)]
    pub attempts: u32,
    /// Unix ms of the next try; 0 = now. Ignored once `attempts` is final.
    #[serde(default)]
    pub next_try_ms: u64,
    #[serde(default)]
    pub last_exit_code: Option<i64>,
    /// One of the fixed `Detail` texts.
    #[serde(default)]
    pub detail: Option<String>,
    /// MSI: the checked product code (removal).
    #[serde(default)]
    pub product_code: Option<String>,
    /// The expanded program path.
    #[serde(default)]
    pub exe: Option<String>,
    #[serde(default)]
    pub remove_when_unassigned: bool,
    /// True once the app left the catalogue and this record is its removal.
    #[serde(default)]
    pub removal: bool,
    /// The last result handed to the report queue ...
    #[serde(default)]
    pub reported: Option<InstallReport>,
    /// ... and whether the server accepted exactly that result.
    #[serde(default)]
    pub acked: bool,
    /// (Review fix) The program was already on the PC when Rulebox first saw the
    /// app (it was taken as installed without running an installer), or the record
    /// is older than this field (unknown origin). Never cleared: such an app is
    /// never uninstalled or deleted by Rulebox, only hidden when unassigned.
    #[serde(default = "unknown_origin")]
    pub preexisting: bool,
    /// (Review fix, `unsupported` records) Rulebox may have put a version of the app
    /// on the PC before its catalogue entry became unusable (a later unassignment
    /// still removes it).
    #[serde(default)]
    pub on_pc: bool,
    /// (Review fix) Unix ms of the first busy answer (`1618`, or a portable program
    /// in use) since the last other outcome; after `BUSY_WINDOW` a busy answer counts.
    #[serde(default)]
    pub busy_since_ms: Option<u64>,
}

/// A record written before `preexisting` existed: nobody knows whether Rulebox
/// installed that app or found it, so it is treated as found (never removed).
fn unknown_origin() -> bool {
    true
}

/// Whether Rulebox may have put (a version of) this app on the PC: it is
/// installed (by an installer run or found, see `preexisting`), an installer ran
/// for it, or a removal is queued for it; an `unsupported` record keeps what its
/// predecessor said (`on_pc`). A finished removal is not on the PC any more.
fn rulebox_may_have_installed(record: &InstallRecord) -> bool {
    match record.state {
        LocalState::Removed => false,
        LocalState::Installed => true,
        LocalState::Unsupported => record.on_pc,
        _ => record.removal || record.attempts > 0,
    }
}

impl InstallRecord {
    pub fn new(app_id: &str, kind: RecordKind, sha256: &str, revision: u64, state: LocalState) -> Self {
        Self {
            app_id: app_id.to_string(),
            kind,
            sha256: sha256.to_string(),
            revision,
            state,
            attempts: 0,
            next_try_ms: 0,
            last_exit_code: None,
            detail: None,
            product_code: None,
            exe: None,
            remove_when_unassigned: false,
            removal: false,
            reported: None,
            acked: false,
            preexisting: false,
            on_pc: false,
            busy_since_ms: None,
        }
    }

    /// Whether an operation is waiting for this record (time aside).
    fn runnable(&self) -> bool {
        match self.state {
            LocalState::Pending => !self.removal,
            LocalState::Removing => self.removal,
            LocalState::Failed => self.attempts < MAX_FAILURES,
            _ => false,
        }
    }

    fn file_name(&self) -> String {
        format!("{}.{}", self.sha256, self.kind.ext())
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct InstallsFile {
    pub schema: u32,
    /// Unix ms when an installer last answered 3010 / 1641; cleared once the PC
    /// booted after it.
    pub restart_pending_since_ms: Option<u64>,
    /// (Review fix) The boot an installer asked for the restart in; compared
    /// without the wall clock (`rebooted_since`).
    pub restart_boot: Option<BootMark>,
    pub apps: BTreeMap<String, InstallRecord>,
    /// (Phase 5 Step 14b) The drivers of the signed document, by driver id. Never a tile: nothing reads this for
    /// visibility. A file written before Step 14b has no such map.
    pub drivers: BTreeMap<String, DriverRecord>,
}

impl Default for InstallsFile {
    fn default() -> Self {
        Self { schema: INSTALLS_SCHEMA, restart_pending_since_ms: None, restart_boot: None, apps: BTreeMap::new(), drivers: BTreeMap::new() }
    }
}

/// Which boot a restart was asked for in (`BootIdentity` without the wall clock).
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BootMark {
    #[serde(default)]
    pub boot_id: Option<u32>,
    pub uptime_ms: u64,
}

/// Whether the PC booted since the restart was asked for:
/// - both boot counters known: they differ;
/// - otherwise: the uptime is smaller now than it was then (the tick count only
///   grows within one boot). A reboot after which the PC already ran longer than
///   it had then is missed (the flag stays: the safe side);
/// - a record from before the boot mark: the old wall-clock rule.
///
/// A clock correction changes none of the first two.
pub fn rebooted_since(mark: Option<&BootMark>, since_ms: u64, now: &BootIdentity) -> bool {
    match mark {
        Some(mark) => match (mark.boot_id, now.boot_id) {
            (Some(then), Some(current)) => then != current,
            _ => now.uptime_ms < mark.uptime_ms,
        },
        None => now.boot_time_ms > since_ms,
    }
}

/// `installs.json`, shared by the engine (the only writer of states), the report
/// queue's acknowledgements and the app visibility of `catalog.rs`. Every change
/// is saved before the call returns, and only when something changed.
pub struct InstallBook {
    path: PathBuf,
    file: Mutex<InstallsFile>,
}

impl InstallBook {
    pub fn open(path: PathBuf) -> Arc<Self> {
        let file = match read_json::<InstallsFile>(&path) {
            Ok(Some(file)) if file.schema == INSTALLS_SCHEMA => file,
            Ok(Some(file)) => {
                tracing::error!(schema = file.schema, "installs.json has an unknown schema; starting without install records");
                InstallsFile::default()
            }
            Ok(None) => InstallsFile::default(),
            Err(error) => {
                tracing::error!("cannot read installs.json ({error}); starting without install records");
                InstallsFile::default()
            }
        };
        Arc::new(Self { path, file: Mutex::new(file) })
    }

    /// A copy of the records.
    pub fn snapshot(&self) -> InstallsFile {
        lock(&self.file).clone()
    }

    /// Applies `f` and saves when the records changed.
    fn update<R>(&self, f: impl FnOnce(&mut InstallsFile) -> R) -> R {
        let mut file = lock(&self.file);
        let before = file.clone();
        let result = f(&mut file);
        if *file != before {
            let saved = serde_json::to_vec_pretty(&*file)
                .map_err(std::io::Error::other)
                .and_then(|bytes| write_atomic(&self.path, &bytes));
            if let Err(error) = saved {
                tracing::error!("cannot save installs.json: {error}");
            }
        }
        result
    }

    /// The app is installed in this version (`sha256`).
    pub fn is_installed(&self, app_id: &str, sha256: &str) -> bool {
        lock(&self.file)
            .apps
            .get(app_id)
            .is_some_and(|r| r.state == LocalState::Installed && !r.removal && r.sha256 == sha256)
    }

    fn installed_ids(&self) -> BTreeSet<String> {
        lock(&self.file)
            .apps
            .values()
            .filter(|r| r.state == LocalState::Installed && !r.removal)
            .map(|r| r.app_id.clone())
            .collect()
    }

    /// The server accepted `report`: mark it, and forget a finished removal.
    pub fn ack(&self, report: &InstallReport) {
        self.update(|file| {
            // (Step 14b) A driver's result travels the same way, under the driver's id.
            if let Some(record) = file.drivers.get_mut(&report.app_id) {
                if record.reported.as_ref() == Some(report) {
                    record.acked = true;
                    if record.removal && record.state == LocalState::Removed {
                        file.drivers.remove(&report.app_id);
                    }
                }
                return;
            }
            let Some(record) = file.apps.get_mut(&report.app_id) else { return };
            if record.reported.as_ref() != Some(report) {
                return;
            }
            record.acked = true;
            if record.removal && record.state == LocalState::Removed {
                file.apps.remove(&report.app_id);
            }
        });
    }
}

/// Marks `record`'s current result as handed to the queue; `None` for a state
/// that stays local.
fn mark(record: &mut InstallRecord) -> Option<InstallReport> {
    let report = report_of(record)?;
    record.reported = Some(report.clone());
    record.acked = false;
    Some(report)
}

/// The wait after the `failures`-th failure, or `None` when it was the last one.
pub fn backoff_after(failures: u32) -> Option<Duration> {
    if failures >= MAX_FAILURES {
        return None;
    }
    let index = (failures.max(1) - 1) as usize;
    BACKOFF_MINUTES.get(index).map(|minutes| Duration::from_secs(minutes * 60))
}

fn ms(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

/// Counts a failure on `record`.
fn fail_record(record: &mut InstallRecord, detail: Option<Detail>, exit_code: Option<i64>, now: u64) {
    record.attempts = record.attempts.saturating_add(1);
    record.state = LocalState::Failed;
    record.detail = detail.map(|d| d.as_str().to_string());
    record.last_exit_code = exit_code;
    record.next_try_ms = backoff_after(record.attempts).map_or(0, |wait| now.saturating_add(ms(wait)));
}

/// What one download needs (an app's installer, or a driver's file).
struct DownloadFile<'a> {
    url: &'a str,
    sha256: &'a str,
    size_bytes: u64,
    ext: &'static str,
}

/// What the engine installs, checked from a catalogue entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Spec {
    pub kind: RecordKind,
    pub url: String,
    pub sha256: String,
    pub size_bytes: u64,
    pub silent_args: Vec<String>,
    pub product_code: Option<String>,
    pub success_exit_codes: Vec<i32>,
    pub remove_when_unassigned: bool,
    /// The expanded program path.
    pub exe: String,
}

pub fn install_of(app: &CatalogApp) -> Option<&InstallSpec> {
    app.desktop.as_ref()?.install.as_ref()
}

/// Checks a catalogue entry with an `install` again on the PC (the document is
/// signed; this is defence in depth): a safe id, a known kind, `https://`, a real
/// hash, a size within 4 GiB, a program path that passes the server's template
/// rules and is not on the deny list, valid silent arguments for an exe (at least
/// one), a well-formed product code for an MSI. The reason names no value.
pub fn check_spec(app: &CatalogApp, roots: &PathRoots) -> Result<Spec, &'static str> {
    let desktop = app.desktop.as_ref().ok_or("not a desktop app")?;
    let install = desktop.install.as_ref().ok_or("no install")?;
    if !is_safe_id(&app.id) {
        return Err("the app id cannot name a file");
    }
    let kind = RecordKind::of(install.kind).ok_or("unknown install kind")?;
    check_https(&install.url).map_err(|_| "the installer URL is not https://")?;
    if !is_sha256(&install.sha256) {
        return Err("the installer hash is not a SHA-256");
    }
    if install.size_bytes > MAX_DOWNLOAD_BYTES {
        return Err("the installer is larger than 4 GiB");
    }
    // The deny list (PRD 7.3) is part of the template rules.
    let exe = expand_exe(&desktop.exe, &app.id, kind == RecordKind::Portable, roots).map_err(|problem| match problem {
        rulebox_policy::paths::PathProblem::Denied => "the program is on the deny list",
        _ => "the program path does not pass the template rules",
    })?;
    let mut product = None;
    match kind {
        RecordKind::Exe => {
            if install.silent_args.is_empty() {
                return Err("an exe needs silent arguments");
            }
            check_args(&install.silent_args).map_err(|_| "the silent arguments do not pass the rules")?;
        }
        RecordKind::Msi => {
            if roots.system_root.is_none() {
                return Err("the Windows folder is not known (msiexec)");
            }
            if let Some(code) = &install.product_code {
                product = Some(product_code(code).ok_or("the product code is not a {GUID}")?);
            }
        }
        RecordKind::Portable => {}
    }
    Ok(Spec {
        kind,
        url: install.url.clone(),
        sha256: install.sha256.clone(),
        size_bytes: install.size_bytes,
        silent_args: if kind == RecordKind::Exe { install.silent_args.clone() } else { Vec::new() },
        product_code: product,
        success_exit_codes: install.success_exit_codes.clone(),
        // An exe cannot be uninstalled in Phase 4: never "removable".
        remove_when_unassigned: install.remove_when_unassigned && kind != RecordKind::Exe,
        exe,
    })
}

fn fresh_record(app: &CatalogApp, spec: &Spec, state: LocalState) -> InstallRecord {
    let mut record = InstallRecord::new(&app.id, spec.kind, &spec.sha256, app.revision, state);
    copy_spec(&mut record, spec);
    record
}

fn copy_spec(record: &mut InstallRecord, spec: &Spec) {
    record.kind = spec.kind;
    record.product_code = spec.product_code.clone();
    record.exe = Some(spec.exe.clone());
    record.remove_when_unassigned = spec.remove_when_unassigned;
}

/// Everything the engine needs.
pub struct EngineDeps {
    pub platform: Arc<dyn Platform>,
    pub downloader: Arc<dyn Downloader>,
    pub paths: DataPaths,
    pub book: Arc<InstallBook>,
    pub report: Arc<ReportQueue>,
    /// The wall clock, Unix ms (`nextTryMs` is stored in it).
    pub now_ms: Arc<dyn Fn() -> u64 + Send + Sync>,
    /// A desktop app became visible or hidden, or an icon arrived: the session
    /// recomputes the signed-in employee's apps (and sends `apps.changed`).
    pub on_visible_change: Arc<dyn Fn() + Send + Sync>,
    /// (Phase 5 Step 20) A driver job ended (installed, removed or failed): the reconciler applies
    /// the printers again, so one that waited for a delivered driver (`driver_missing`) is created.
    pub on_driver_change: Arc<dyn Fn() + Send + Sync>,
    pub install_timeout: Duration,
    /// After a successful install the program must exist within this long.
    pub exe_wait: Duration,
    /// (Step 14b) The agent state: a driver package the engine published is written into the journal, so a restore of
    /// everything (un-enrolling) removes it again.
    pub shared: Arc<SharedState>,
}

struct Engine {
    deps: EngineDeps,
    /// Icon hashes tried in this run (a failing icon is not fetched in a loop).
    icons_tried: HashSet<String>,
}

/// The next operation: an app or a driver (Step 14b), an install or a removal.
struct Job {
    id: String,
    removal: bool,
    driver: bool,
}

/// How an operation ended, before it is written down.
enum Outcome {
    Installed { exit_code: i32 },
    Removed,
    /// `1618`, or a portable program in use: retried in 2 minutes, not counted,
    /// for at most `BUSY_WINDOW` (then a counted failure with this exit code).
    Busy { exit_code: Option<i64> },
    /// Something kept the job from starting (the program folders, the entry):
    /// retried in 2 minutes, never counted.
    Wait,
    Failed { detail: Option<Detail>, exit_code: Option<i64> },
    /// The agent is stopping in the middle of a download: nothing is recorded
    /// (the start-up recovery handles the `downloading` state).
    Abandoned,
    /// The agent is stopping while an installer ran: it and everything it started
    /// were ended; the job waits again, not counted.
    Interrupted,
    /// (Defence in depth) A removal of an app Rulebox did not install: the record
    /// is dropped, nothing is removed or reported.
    Dropped,
}

impl Engine {
    fn now(&self) -> u64 {
        (self.deps.now_ms)()
    }

    /// Hands the results to the report queue (after they were saved).
    fn push(&self, reports: Vec<InstallReport>) {
        for report in reports {
            self.deps.report.push_install(report);
        }
    }

    fn visible_changed(&self, before: &BTreeSet<String>) {
        if self.deps.book.installed_ids() != *before {
            (self.deps.on_visible_change)();
        }
    }

    fn set_state(&self, app_id: &str, state: LocalState) {
        self.deps.book.update(|file| {
            if let Some(record) = file.apps.get_mut(app_id) {
                record.state = state;
            }
        });
    }

    /// Start-up: crash recovery, the unacknowledged results, the restart flag and
    /// the downloads folder.
    fn recover(&self) {
        let now = self.now();
        let reports = self.deps.book.update(|file| {
            let mut out = Vec::new();
            for record in file.apps.values_mut() {
                match record.state {
                    LocalState::Downloading => {
                        tracing::info!(app_id = %record.app_id, "a download was interrupted; it starts again");
                        record.state = if record.removal { LocalState::Removing } else { LocalState::Pending };
                    }
                    LocalState::Installing => {
                        tracing::warn!(app_id = %record.app_id, "the agent stopped while an installer ran; counted as a failed attempt");
                        fail_record(record, None, None, now);
                        out.extend(mark(record));
                    }
                    _ => {}
                }
            }
            for record in file.apps.values() {
                if !record.acked {
                    if let Some(report) = &record.reported {
                        if !out.iter().any(|r: &InstallReport| r.app_id == report.app_id) {
                            out.push(report.clone());
                        }
                    }
                }
            }
            // (Step 14b) The same for drivers.
            for record in file.drivers.values_mut() {
                match record.state {
                    LocalState::Downloading => {
                        tracing::info!("a driver download was interrupted; it starts again");
                        record.state = if record.removal { LocalState::Removing } else { LocalState::Pending };
                    }
                    LocalState::Installing => {
                        tracing::warn!("the agent stopped while a driver installer ran; counted as a failed attempt");
                        record.fail(None, None, now);
                        out.extend(record.mark());
                    }
                    _ => {}
                }
                if !record.acked {
                    if let Some(report) = &record.reported {
                        if !out.iter().any(|r: &InstallReport| r.app_id == report.app_id) {
                            out.push(report.clone());
                        }
                    }
                }
            }
            out
        });
        self.push(reports);

        let file = self.deps.book.snapshot();
        if let Some(since) = file.restart_pending_since_ms {
            match self.deps.platform.boot_identity() {
                Ok(now) if rebooted_since(file.restart_boot.as_ref(), since, &now) => {
                    let reports = self.deps.book.update(|file| {
                        file.restart_pending_since_ms = None;
                        file.restart_boot = None;
                        // (Step 14b) The restart a driver asked for happened: its "restart needed" (installed with exit
                        // code 3010 / 1641) goes away on the dashboard.
                        let mut out = Vec::new();
                        for record in file.drivers.values_mut() {
                            if record.state == LocalState::Installed
                                && record.last_exit_code.is_some_and(|code| code == i64::from(MSI_REBOOT_REQUIRED) || code == i64::from(MSI_REBOOT_INITIATED))
                            {
                                record.last_exit_code = None;
                                out.extend(record.mark());
                            }
                        }
                        out
                    });
                    self.push(reports);
                    self.deps.report.set_restart_pending(false);
                }
                Ok(_) => self.deps.report.set_restart_pending(true),
                Err(error) => {
                    tracing::warn!("cannot read the boot identity ({error}); the restart stays pending");
                    self.deps.report.set_restart_pending(true);
                }
            }
        }
        self.clean_downloads();
        // TEMP folders of installer runs a crash left behind.
        super::sweep_run_temps(&self.deps.paths.installer_temp_dir());
        // (Step 14b) Driver zips a crash left extracted.
        super::unzip::remove_tree(&self.deps.paths.drivers_dir().join("work"));
    }

    /// Deletes `.part` files and every download no waiting install needs.
    fn clean_downloads(&self) {
        let file = self.deps.book.snapshot();
        let keep: HashSet<String> = file
            .apps
            .values()
            .filter(|r| !r.removal && r.runnable())
            .map(InstallRecord::file_name)
            // (Step 14b) A driver still waiting for its download or install keeps its file too.
            .chain(file.drivers.values().filter(|r| !r.removal && r.runnable()).map(DriverRecord::file_name))
            .collect();
        let dir = self.deps.paths.downloads_dir();
        let Ok(entries) = std::fs::read_dir(&dir) else { return };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
            let is_file = entry.file_type().is_ok_and(|t| t.is_file());
            if is_file && !keep.contains(&name) {
                if let Err(error) = std::fs::remove_file(entry.path()) {
                    tracing::warn!("cannot delete an old download: {error}");
                }
            }
        }
    }

    fn delete_download(&self, record_file_name: &str) {
        let path = self.deps.paths.downloads_dir().join(record_file_name);
        if let Err(error) = remove_file_if_exists(&path) {
            tracing::warn!("cannot delete a download: {error}");
        }
    }

    /// Brings the records in line with the catalogue (no operation runs here).
    fn reconcile(&self, policy: &AgentPolicy) {
        // No verified document, or a catalogue that did not parse: nothing is
        // removed because of it (fail safe), nothing new starts.
        if !policy.has_document || policy.catalog_problem.is_some() {
            return;
        }
        let roots = match self.deps.platform.path_roots() {
            Ok(roots) => roots,
            Err(error) => {
                tracing::warn!("cannot read the program folders ({error}); installs wait");
                return;
            }
        };
        let platform = &self.deps.platform;
        let before = self.deps.book.installed_ids();
        let (reports, doomed) = self.deps.book.update(|file| {
            let mut out = Vec::new();
            let mut doomed = Vec::new();
            let mut wanted = HashSet::new();
            for app in &policy.catalog {
                let Some(install) = install_of(app) else { continue };
                wanted.insert(app.id.clone());
                let spec = match check_spec(app, &roots) {
                    Ok(spec) => spec,
                    Err(reason) => {
                        let same = file.apps.get(&app.id).is_some_and(|r| {
                            r.state == LocalState::Unsupported && r.revision == app.revision && r.sha256 == install.sha256
                        });
                        if same {
                            continue;
                        }
                        tracing::warn!(app_id = %app.id, "this app cannot be installed: {reason}");
                        let kind = RecordKind::of(install.kind).unwrap_or(RecordKind::Exe);
                        let mut record = InstallRecord::new(&app.id, kind, &install.sha256, app.revision, LocalState::Unsupported);
                        record.detail = Some(Detail::Unsupported.as_str().to_string());
                        if let Some(old) = file.apps.get(&app.id) {
                            // What a later removal needs about the version on the PC:
                            // how to remove it, whether Rulebox may have put it there,
                            // and whether it was found there (never removed).
                            record.kind = old.kind;
                            record.product_code = old.product_code.clone();
                            record.exe = old.exe.clone();
                            record.remove_when_unassigned = old.remove_when_unassigned;
                            record.on_pc = rulebox_may_have_installed(old);
                            record.preexisting = old.preexisting;
                        }
                        out.extend(mark(&mut record));
                        file.apps.insert(app.id.clone(), record);
                        continue;
                    }
                };
                let exe_exists = platform.file_exists(Path::new(&spec.exe));
                match file.apps.get_mut(&app.id) {
                    None => {
                        // A program already at its path is taken as installed (its
                        // tile shows), but Rulebox did not install it: it is marked
                        // and will never be uninstalled or deleted by Rulebox.
                        let state = if exe_exists { LocalState::Installed } else { LocalState::Pending };
                        let mut record = fresh_record(app, &spec, state);
                        record.preexisting = exe_exists;
                        out.extend(mark(&mut record));
                        file.apps.insert(app.id.clone(), record);
                    }
                    Some(record) => {
                        let restart = record.sha256 != spec.sha256 || record.removal || record.state == LocalState::Unsupported;
                        if restart {
                            // A new version (always installed again), a re-assignment
                            // or an entry that became usable.
                            let state = if record.sha256 == spec.sha256 && exe_exists {
                                LocalState::Installed
                            } else {
                                LocalState::Pending
                            };
                            if record.sha256 != spec.sha256 {
                                doomed.push(record.file_name());
                            }
                            // Found again at its path without Rulebox having put it
                            // there (for example after Rulebox removed it): preexisting.
                            let preexisting = record.preexisting
                                || (state == LocalState::Installed && !rulebox_may_have_installed(record));
                            *record = fresh_record(app, &spec, state);
                            record.preexisting = preexisting;
                            out.extend(mark(record));
                            continue;
                        }
                        copy_spec(record, &spec);
                        if record.revision != app.revision {
                            record.revision = app.revision;
                            if record.state == LocalState::Failed {
                                // Retry: a new revision starts the attempts again.
                                record.state = LocalState::Pending;
                                record.attempts = 0;
                                record.next_try_ms = 0;
                                record.detail = None;
                                record.last_exit_code = None;
                                out.extend(mark(record));
                            }
                        }
                        if record.state == LocalState::Installed && !exe_exists {
                            tracing::warn!(app_id = %app.id, "the program of an installed app is gone; installing it again");
                            record.state = LocalState::Pending;
                            record.attempts = 0;
                            record.next_try_ms = 0;
                            out.extend(mark(record));
                        }
                    }
                }
            }
            // Apps that left the catalogue.
            let gone: Vec<String> = file.apps.keys().filter(|id| !wanted.contains(*id)).cloned().collect();
            for id in gone {
                let Some(record) = file.apps.get_mut(&id) else { continue };
                if record.removal {
                    // A queued removal of an app Rulebox did not install (a record
                    // from before `preexisting`): dropped, never run.
                    if record.preexisting && record.state != LocalState::Removed {
                        tracing::info!(app_id = %id, "not installed by Rulebox; its removal is dropped (hidden only)");
                        file.apps.remove(&id);
                    }
                    continue;
                }
                let can_remove = match record.kind {
                    RecordKind::Msi => record.product_code.is_some(),
                    RecordKind::Portable => record.exe.is_some(),
                    RecordKind::Exe => false,
                };
                // Something Rulebox put there may be on the PC: installed, an
                // install that ran, or the version before an `unsupported` entry.
                let on_pc = rulebox_may_have_installed(record);
                if record.remove_when_unassigned && can_remove && on_pc && !record.preexisting {
                    tracing::info!(app_id = %id, "unassigned; it will be removed");
                    record.removal = true;
                    record.state = LocalState::Removing;
                    record.attempts = 0;
                    record.next_try_ms = 0;
                    record.detail = None;
                    record.last_exit_code = None;
                } else {
                    tracing::info!(app_id = %id, "unassigned; hidden (not removed)");
                    doomed.push(record.file_name());
                    file.apps.remove(&id);
                }
            }
            (out, doomed)
        });
        for name in doomed {
            self.delete_download(&name);
        }
        self.push(reports);
        self.visible_changed(&before);
    }

    /// The next operation that is due: `(app id, is a removal)`. Installs wait for
    /// the connection.
    fn next_job(&self, online: bool) -> Option<Job> {
        let now = self.now();
        let file = self.deps.book.snapshot();
        file.apps
            .values()
            .find(|r| r.runnable() && r.next_try_ms <= now && (r.removal || online))
            .map(|r| Job { id: r.app_id.clone(), removal: r.removal, driver: false })
            // (Step 14b) Apps first, then drivers.
            .or_else(|| {
                file.drivers
                    .values()
                    .find(|r| r.runnable() && r.next_try_ms <= now && (r.removal || online))
                    .map(|r| Job { id: r.driver_id.clone(), removal: r.removal, driver: true })
            })
    }

    /// When the earliest waiting operation comes due (Unix ms).
    fn next_wake(&self, online: bool) -> Option<u64> {
        let file = self.deps.book.snapshot();
        file.apps
            .values()
            .filter(|r| r.runnable() && (r.removal || online))
            .map(|r| r.next_try_ms)
            .chain(file.drivers.values().filter(|r| r.runnable() && (r.removal || online)).map(|r| r.next_try_ms))
            .min()
    }

    /// The missing icons; stops as soon as the agent stops.
    async fn fetch_icons(&mut self, policy: &AgentPolicy, deployment_url: Option<&str>, shutdown: &CancellationToken) {
        let dir = self.deps.paths.icons_dir();
        let fetched = tokio::select! {
            () = shutdown.cancelled() => false,
            any = icons::fetch_missing(&policy.catalog, deployment_url, self.deps.downloader.as_ref(), &dir, &mut self.icons_tried) => any,
        };
        if fetched {
            (self.deps.on_visible_change)();
        }
    }

    /// Runs one installer in a blocking thread; `shutdown` ends it (and everything
    /// it started) at the platform's next poll.
    async fn run_installer(&self, cmd: InstallerCommand, shutdown: &CancellationToken) -> Result<InstallerExit, PlatformError> {
        let platform = Arc::clone(&self.deps.platform);
        let timeout = self.deps.install_timeout;
        let cancel = shutdown.clone();
        tokio::task::spawn_blocking(move || platform.run_installer(&cmd, timeout, &cancel))
            .await
            .unwrap_or_else(|error| Err(PlatformError::Other(format!("the installer thread failed: {error}"))))
    }

    /// `Some(found)`, or `None` when the agent stopped before the program appeared.
    async fn wait_for_exe(&self, exe: &Path, shutdown: &CancellationToken) -> Option<bool> {
        let deadline = tokio::time::Instant::now() + self.deps.exe_wait;
        loop {
            if self.deps.platform.file_exists(exe) {
                return Some(true);
            }
            if tokio::time::Instant::now() >= deadline {
                return Some(false);
            }
            tokio::select! {
                () = shutdown.cancelled() => return None,
                () = tokio::time::sleep(EXE_POLL) => {}
            }
        }
    }

    /// Free disk for `need` bytes; `Err(LowDisk)` when there is less.
    fn check_disk(&self, app_id: &str, need: u64) -> Result<(), Option<Detail>> {
        match self.deps.platform.disk_free_bytes() {
            Ok(free) if free < need => {
                tracing::warn!(app_id, free, need, "not enough free disk space for this install");
                Err(Some(Detail::LowDisk))
            }
            Ok(_) => Ok(()),
            Err(error) => {
                tracing::warn!(app_id, "cannot read the free disk space ({error}); trying anyway");
                Ok(())
            }
        }
    }

    /// Keeps at most `KEEP_MSI_LOGS - 1` older MSI logs (the next run adds one).
    fn prune_msi_logs(&self) {
        let Ok(entries) = std::fs::read_dir(self.deps.paths.logs_dir()) else { return };
        let mut logs: Vec<(std::time::SystemTime, PathBuf)> = entries
            .flatten()
            .filter(|e| {
                let name = e.file_name().to_string_lossy().to_ascii_lowercase();
                name.starts_with("install-") && name.ends_with(".log")
            })
            .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
            .collect();
        logs.sort_by_key(|log| std::cmp::Reverse(log.0));
        for (_, path) in logs.into_iter().skip(KEEP_MSI_LOGS - 1) {
            let _ = std::fs::remove_file(path);
        }
    }

    /// Download (or reuse) the installer; `Err(None)` = the agent is stopping.
    async fn download(&self, app_id: &str, spec: &Spec, shutdown: &CancellationToken) -> Result<PathBuf, Option<Detail>> {
        let file = DownloadFile { url: &spec.url, sha256: &spec.sha256, size_bytes: spec.size_bytes, ext: spec.kind.ext() };
        self.download_file(app_id, &file, shutdown).await
    }

    /// The download of any installer file (an app's, or a driver's zip / exe / msi, Step 14b).
    async fn download_file(&self, app_id: &str, spec: &DownloadFile<'_>, shutdown: &CancellationToken) -> Result<PathBuf, Option<Detail>> {
        let dir = self.deps.paths.downloads_dir();
        if let Err(error) = std::fs::create_dir_all(&dir) {
            tracing::error!("cannot create the downloads folder: {error}");
            return Err(Some(Detail::DownloadFailed));
        }
        if !matches!(is_reparse_point(&dir), Ok(false)) {
            tracing::error!("the downloads folder is a link (or cannot be read); nothing is downloaded");
            return Err(Some(Detail::DownloadFailed));
        }
        // The download, then the installed files (twice its size). An unknown size
        // (0): the most a download may write (4 GiB) now, and twice the real size
        // once it is known.
        let need = if spec.size_bytes > 0 { spec.size_bytes.saturating_mul(3) } else { MAX_DOWNLOAD_BYTES };
        self.check_disk(app_id, need)?;
        let dest = dir.join(format!("{}.{}", spec.sha256, spec.ext));
        let mut reused = false;
        if dest.exists() {
            match open_verified(&dest, spec.sha256) {
                Ok(_) => {
                    tracing::info!(app_id, "reusing the installer downloaded earlier");
                    reused = true;
                }
                Err(_) => {
                    let _ = remove_file_if_exists(&dest);
                }
            }
        }
        if !reused {
            let max = if spec.size_bytes > 0 { spec.size_bytes.min(MAX_DOWNLOAD_BYTES) } else { MAX_DOWNLOAD_BYTES };
            let deadline = download_deadline(spec.size_bytes);
            tracing::info!(app_id, "downloading the installer");
            tokio::select! {
                () = shutdown.cancelled() => return Err(None),
                result = tokio::time::timeout(deadline, self.deps.downloader.fetch(spec.url, &dest, spec.sha256, max)) => match result {
                    Ok(Ok(())) => {}
                    Ok(Err(error)) => {
                        tracing::warn!(app_id, "download failed: {error}");
                        return Err(Some(error.detail()));
                    }
                    Err(_) => {
                        tracing::warn!(app_id, minutes = deadline.as_secs() / 60, "the download did not finish in time");
                        let _ = remove_file_if_exists(&part_path(&dest));
                        return Err(Some(Detail::DownloadFailed));
                    }
                },
            }
        }
        if spec.size_bytes == 0 {
            let size = std::fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);
            if let Err(low) = self.check_disk(app_id, size.saturating_mul(2)) {
                let _ = remove_file_if_exists(&dest);
                return Err(low);
            }
        }
        Ok(dest)
    }

    async fn install(&self, app_id: &str, spec: &Spec, roots: &PathRoots, shutdown: &CancellationToken) -> Outcome {
        self.set_state(app_id, LocalState::Downloading);
        let dest = match self.download(app_id, spec, shutdown).await {
            Ok(dest) => dest,
            Err(Some(detail)) => return Outcome::Failed { detail: Some(detail), exit_code: None },
            Err(None) => return Outcome::Abandoned,
        };
        self.set_state(app_id, LocalState::Installing);
        // Locked and hashed again through the handle that stays open while the
        // installer runs: what runs is what was verified.
        let verified = match open_verified(&dest, &spec.sha256) {
            Ok(verified) => verified,
            Err(FileCheckError::Mismatch | FileCheckError::NotPlain) => {
                tracing::error!(app_id, "the installer changed after its download; deleted, nothing ran");
                let _ = remove_file_if_exists(&dest);
                return Outcome::Failed { detail: Some(Detail::HashMismatch), exit_code: None };
            }
            Err(FileCheckError::Io(error)) => {
                tracing::error!(app_id, "cannot open the installer: {error}");
                return Outcome::Failed { detail: Some(Detail::DownloadFailed), exit_code: None };
            }
        };
        let exe = PathBuf::from(&spec.exe);
        let downloads = self.deps.paths.downloads_dir();
        tracing::info!(app_id, kind = ?spec.kind, "installing");
        let ran = match spec.kind {
            RecordKind::Msi => {
                let Some(system_root) = roots.system_root.as_deref() else {
                    return Outcome::Failed { detail: Some(Detail::Unsupported), exit_code: None };
                };
                self.prune_msi_logs();
                let _ = std::fs::create_dir_all(self.deps.paths.logs_dir());
                let log = self.deps.paths.install_log(app_id);
                let cmd = msi_install_command(Path::new(system_root), verified.path(), &log, &downloads, &exe);
                self.run_installer(cmd, shutdown).await
            }
            RecordKind::Exe => {
                let cmd = exe_install_command(verified.path(), &spec.silent_args, &downloads, &exe);
                self.run_installer(cmd, shutdown).await
            }
            RecordKind::Portable => {
                let platform = Arc::clone(&self.deps.platform);
                let (from, to) = (verified.path().to_path_buf(), exe.clone());
                tokio::task::spawn_blocking(move || platform.place_portable(&from, &to))
                    .await
                    .unwrap_or_else(|error| Err(PlatformError::Other(error.to_string())))
                    .map(|()| InstallerExit::Code(0))
            }
        };
        // Held until the installer and everything it started are gone (the
        // platform returns only then).
        drop(verified);
        match ran {
            Err(PlatformError::InUse) => {
                tracing::info!(app_id, "the old program is running; the upgrade waits");
                Outcome::Busy { exit_code: None }
            }
            Err(error) => {
                tracing::error!(app_id, "the installer did not run: {error}");
                Outcome::Failed { detail: None, exit_code: None }
            }
            Ok(InstallerExit::Cancelled) => Outcome::Interrupted,
            Ok(InstallerExit::TimedOut) => {
                tracing::warn!(app_id, "the installer did not finish in time and was stopped");
                Outcome::Failed { detail: Some(Detail::Timeout), exit_code: None }
            }
            Ok(InstallerExit::Code(code)) => match judge_install(spec.kind == RecordKind::Msi, &spec.success_exit_codes, code) {
                ExitVerdict::Busy => Outcome::Busy { exit_code: Some(i64::from(code)) },
                ExitVerdict::Failure => {
                    tracing::warn!(app_id, code, "the installer failed");
                    Outcome::Failed { detail: Some(Detail::ExitCode), exit_code: Some(i64::from(code)) }
                }
                ExitVerdict::Success { restart } => {
                    if restart {
                        self.note_restart();
                    }
                    match self.wait_for_exe(&exe, shutdown).await {
                        Some(true) => {
                            let _ = remove_file_if_exists(&dest);
                            Outcome::Installed { exit_code: code }
                        }
                        Some(false) => {
                            tracing::warn!(app_id, "the installer succeeded but the program is not at its path");
                            Outcome::Failed { detail: Some(Detail::ExeMissingAfterInstall), exit_code: Some(i64::from(code)) }
                        }
                        // Stopping: the next start runs it again (installers are
                        // re-runnable), not counted.
                        None => Outcome::Interrupted,
                    }
                }
            },
        }
    }

    async fn remove(&self, record: &InstallRecord, roots: &PathRoots, shutdown: &CancellationToken) -> Outcome {
        let app_id = record.app_id.as_str();
        if record.preexisting {
            // Never reached through `reconcile` (it never queues one); a hand-edited
            // file must not make Rulebox uninstall what it did not install.
            tracing::warn!(app_id, "not installed by Rulebox; nothing is removed");
            return Outcome::Dropped;
        }
        tracing::info!(app_id, "removing an unassigned app");
        match record.kind {
            RecordKind::Msi => {
                let (Some(code), Some(system_root)) =
                    (record.product_code.as_deref().and_then(product_code), roots.system_root.as_deref())
                else {
                    return Outcome::Failed { detail: Some(Detail::RemoveFailed), exit_code: None };
                };
                self.prune_msi_logs();
                let _ = std::fs::create_dir_all(self.deps.paths.logs_dir());
                let log = self.deps.paths.install_log(app_id);
                let exe = record.exe.as_deref().map(Path::new);
                let cmd = msi_removal_command(Path::new(system_root), &code, &log, &self.deps.paths.downloads_dir(), exe);
                match self.run_installer(cmd, shutdown).await {
                    Ok(InstallerExit::Cancelled) => Outcome::Interrupted,
                    Ok(InstallerExit::Code(code)) => match judge_removal(code) {
                        ExitVerdict::Success { restart } => {
                            if restart {
                                self.note_restart();
                            }
                            Outcome::Removed
                        }
                        ExitVerdict::Busy => Outcome::Busy { exit_code: Some(i64::from(code)) },
                        ExitVerdict::Failure => Outcome::Failed { detail: Some(Detail::RemoveFailed), exit_code: Some(i64::from(code)) },
                    },
                    Ok(InstallerExit::TimedOut) => Outcome::Failed { detail: Some(Detail::Timeout), exit_code: None },
                    Err(error) => {
                        tracing::error!(app_id, "msiexec did not run: {error}");
                        Outcome::Failed { detail: Some(Detail::RemoveFailed), exit_code: None }
                    }
                }
            }
            RecordKind::Portable => {
                let dir = Path::new(&roots.rulebox_apps).join(app_id);
                let platform = Arc::clone(&self.deps.platform);
                let removed = tokio::task::spawn_blocking(move || platform.remove_portable(&dir))
                    .await
                    .unwrap_or_else(|error| Err(PlatformError::Other(error.to_string())));
                match removed {
                    Ok(()) => Outcome::Removed,
                    Err(PlatformError::InUse) => {
                        tracing::info!(app_id, "the portable program is running; its removal waits");
                        Outcome::Busy { exit_code: None }
                    }
                    Err(error) => {
                        tracing::error!(app_id, "cannot delete the portable app: {error}");
                        Outcome::Failed { detail: Some(Detail::RemoveFailed), exit_code: None }
                    }
                }
            }
            // Never queued (an exe is not removable); nothing to do.
            RecordKind::Exe => Outcome::Removed,
        }
    }

    fn note_restart(&self) {
        let now = self.now();
        let boot = match self.deps.platform.boot_identity() {
            Ok(boot) => Some(BootMark { boot_id: boot.boot_id, uptime_ms: boot.uptime_ms }),
            Err(error) => {
                tracing::warn!("cannot read the boot identity ({error}); the wall clock decides");
                None
            }
        };
        self.deps.book.update(|file| {
            file.restart_pending_since_ms = Some(now);
            file.restart_boot = boot;
        });
        self.deps.report.set_restart_pending(true);
    }

    /// Writes down how an operation ended (and reports it).
    fn finish(&self, app_id: &str, outcome: Outcome) {
        let now = self.now();
        let report = self.deps.book.update(|file| {
            if matches!(outcome, Outcome::Dropped) {
                file.apps.remove(app_id);
                return None;
            }
            let record = file.apps.get_mut(app_id)?;
            // Back to waiting (not counted) after an uncounted interruption.
            let wait_again = |record: &mut InstallRecord| {
                if matches!(record.state, LocalState::Downloading | LocalState::Installing) {
                    record.state = if record.removal { LocalState::Removing } else { LocalState::Pending };
                }
            };
            match outcome {
                Outcome::Installed { exit_code } => {
                    tracing::info!(app_id, "installed");
                    record.state = LocalState::Installed;
                    record.detail = None;
                    record.last_exit_code = (exit_code != 0).then_some(i64::from(exit_code));
                    record.next_try_ms = 0;
                    record.busy_since_ms = None;
                    mark(record)
                }
                Outcome::Removed => {
                    tracing::info!(app_id, "removed");
                    record.state = LocalState::Removed;
                    record.detail = None;
                    record.last_exit_code = None;
                    record.busy_since_ms = None;
                    mark(record)
                }
                Outcome::Busy { exit_code } => {
                    let first = *record.busy_since_ms.get_or_insert(now);
                    if now.saturating_sub(first) >= ms(BUSY_WINDOW) {
                        tracing::warn!(app_id, "still busy after 2 hours; counted as a failed attempt");
                        record.busy_since_ms = None;
                        // Never `busy` on the wire: the exit code says what happened.
                        let detail = if record.removal {
                            Some(Detail::RemoveFailed)
                        } else {
                            exit_code.map(|_| Detail::ExitCode)
                        };
                        fail_record(record, detail, exit_code, now);
                        return mark(record);
                    }
                    tracing::info!(app_id, "busy (another installation, or the program is in use); trying again in 2 minutes");
                    wait_again(record);
                    record.next_try_ms = now.saturating_add(ms(BUSY_RETRY));
                    None
                }
                Outcome::Wait => {
                    wait_again(record);
                    record.next_try_ms = now.saturating_add(ms(BUSY_RETRY));
                    None
                }
                Outcome::Failed { detail, exit_code } => {
                    record.busy_since_ms = None;
                    fail_record(record, detail, exit_code, now);
                    if record.attempts >= MAX_FAILURES {
                        tracing::warn!(app_id, attempts = record.attempts, "giving up until the app changes (Retry)");
                    }
                    mark(record)
                }
                Outcome::Interrupted => {
                    tracing::info!(app_id, "the agent is stopping; the installer was ended and runs again at the next start");
                    wait_again(record);
                    None
                }
                Outcome::Abandoned | Outcome::Dropped => None,
            }
        });
        self.push(report.into_iter().collect());
        // Exhausted: its download is not needed any more.
        let file = self.deps.book.snapshot();
        if let Some(record) = file.apps.get(app_id) {
            if record.state == LocalState::Failed && record.attempts >= MAX_FAILURES {
                self.delete_download(&record.file_name());
            }
        }
    }

    async fn run_job(&self, app_id: &str, removal: bool, policy: &AgentPolicy, shutdown: &CancellationToken) {
        // Anything that keeps the job from starting waits like a busy installer (not
        // counted), so the loop never spins on it.
        let roots = match self.deps.platform.path_roots() {
            Ok(roots) => roots,
            Err(error) => {
                tracing::warn!("cannot read the program folders ({error})");
                return self.finish(app_id, Outcome::Wait);
            }
        };
        let before = self.deps.book.installed_ids();
        let outcome = if removal {
            let Some(record) = self.deps.book.snapshot().apps.get(app_id).cloned() else { return };
            self.remove(&record, &roots, shutdown).await
        } else {
            let spec = policy.catalog.iter().find(|a| a.id == app_id).map(|app| check_spec(app, &roots));
            let Some(Ok(spec)) = spec else {
                return self.finish(app_id, Outcome::Wait);
            };
            self.install(app_id, &spec, &roots, shutdown).await
        };
        self.finish(app_id, outcome);
        self.visible_changed(&before);
    }
}

/// The `installs` task (started by `agent::run`).
pub async fn run_install_task(
    deps: EngineDeps,
    mut policy_rx: watch::Receiver<AgentPolicy>,
    mut snapshot_rx: watch::Receiver<AgentSnapshot>,
    shutdown: CancellationToken,
) {
    let mut engine = Engine { deps, icons_tried: HashSet::new() };
    engine.recover();
    let mut catalog_seen: Option<Vec<CatalogApp>> = None;
    loop {
        if shutdown.is_cancelled() {
            return;
        }
        let policy = policy_rx.borrow_and_update().clone();
        let (enrolled, online, deployment) = {
            let snapshot = snapshot_rx.borrow_and_update();
            (
                snapshot.enrollment == EnrollmentStatus::Enrolled,
                snapshot.connection == ConnectionStatus::Online,
                snapshot.convex_url.clone(),
            )
        };
        let mut wake = None;
        if enrolled {
            engine.reconcile(&policy);
            engine.reconcile_drivers(&policy);
            if online && policy.has_document {
                if catalog_seen.as_ref() != Some(&policy.catalog) {
                    // A new catalogue: icons that failed before may work now.
                    engine.icons_tried.clear();
                    catalog_seen = Some(policy.catalog.clone());
                }
                engine.fetch_icons(&policy, deployment.as_deref(), &shutdown).await;
                if shutdown.is_cancelled() {
                    return;
                }
            }
            if let Some(job) = engine.next_job(online) {
                if job.driver {
                    engine.run_driver_job(&job.id, job.removal, &policy, &shutdown).await;
                } else {
                    engine.run_job(&job.id, job.removal, &policy, &shutdown).await;
                }
                continue;
            }
            wake = engine.next_wake(online);
        }
        let now = engine.now();
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
            () = timer => {}
        }
    }
}

#[path = "drivers.rs"]
mod drivers;

#[cfg(test)]
#[path = "engine_tests.rs"]
mod tests;
