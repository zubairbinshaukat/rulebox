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

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rulebox_ipc::requests::AppUpdateState;
use rulebox_ipc::types::{AgentSnapshot, ConnectionStatus, EnrollmentStatus};
use rulebox_policy::catalog::{ApplyWhen, CatalogApp, InstallKind, InstallSpec, UpdateMode};
use rulebox_policy::paths::{check_args, exe_pattern, expand_exe, PathRoots};
use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, watch};
use tokio_util::sync::CancellationToken;

use super::download::{check_https, part_path, Downloader};
use super::drivers_rules::DriverRecord;
use super::report::report_of;
use super::version::{
    self as versions, boot_window_open, check_installed, detection, kept_file_name, may_keep, publisher_matches,
    resolve_pattern, vendor_needs_bootstrap, verify_step, VerifyStep, VersionCheck, WindowInputs, MAX_UPDATE_FAILURES,
    UPDATE_RETRY_GAP,
};
use super::{
    download_deadline, exe_install_command, icons, is_reparse_point, is_safe_id, is_sha256, judge_install,
    judge_removal, msi_install_command, msi_removal_command, open_verified, product_code, Detail, ExitVerdict,
    FileCheckError, BACKOFF_MINUTES, BUSY_RETRY, BUSY_WINDOW, EXE_POLL, KEEP_MSI_LOGS, MAX_DOWNLOAD_BYTES,
    MAX_FAILURES, MSI_REBOOT_INITIATED, MSI_REBOOT_REQUIRED,
};
use crate::agent_policy::AgentPolicy;
use crate::backend::InstallReport;
use crate::paths::DataPaths;
use crate::platform::{BootIdentity, ExitWatch, InstallerCommand, InstallerExit, Platform, PlatformError};
use crate::report::ReportQueue;
use crate::state::{lock, read_json, remove_file_if_exists, write_atomic, SharedState};

/// `installs.json` schema. 1 -> 2 (Phase 6 Step 11, plan 4.6): a record gains `version`, `installedVersion`,
/// `mode`, `previous` and the update fields. A schema 1 file loads with defaults (and is saved as 2 at its
/// next change); an agent from before Phase 6 refuses a schema 2 file and starts empty.
pub const INSTALLS_SCHEMA: u32 = 2;
/// The oldest schema this agent still reads.
const INSTALLS_SCHEMA_OLDEST: u32 = 1;

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

    // -- (Phase 6 Step 11, journal schema 2) A schema 1 file has none of these: each has a default. --
    /// The catalogue's `desktop.version` of the installer this record follows.
    #[serde(default)]
    pub version: Option<String>,
    /// The version the PC has (plan 4.4.1): the program's file version, else the version the engine last installed.
    /// Reported as `installedVersion` when it changes.
    #[serde(default)]
    pub installed_version: Option<String>,
    /// How the version is kept (plan 4.4). `Unknown` is stored as `Pinned`.
    #[serde(default = "pinned")]
    pub mode: UpdateMode,
    /// `applyWhen: when_closed` (plan 4.4.5 window 3).
    #[serde(default)]
    pub when_closed: bool,
    /// An app that **is installed** gets another version (plan 4.6 "Upgrade test"): the record keeps its
    /// state (`installed`, the program works and its tile stays) and the work is staged, waits for an apply
    /// window and runs. Only terminal states are reported for it.
    #[serde(default)]
    pub update: bool,
    /// The update's installer is downloaded and verified: only the apply window is missing.
    #[serde(default)]
    pub staged: bool,
    /// While an update runs: the old version still works. Cleared when the installer starts, set again by a
    /// roll-back, or by an update that failed before the installer ran.
    #[serde(default = "works")]
    pub old_works: bool,
    /// The installer of the version on the PC, kept on disk for a roll-back (Managed with `rollbackOnFail` only).
    #[serde(default)]
    pub kept: Option<KeptInstaller>,
    /// The installer of the version before the last update, until the new one was healthy for one sign-in.
    #[serde(default)]
    pub previous: Option<KeptInstaller>,
    /// `previous` is deleted at the next employee sign-in (the new version ran healthy long enough to sign in).
    #[serde(default)]
    pub heal_pending: bool,
    /// Vendor mode (plan 4.4.3): the first miss, or the last look, of a program that is not at its path (Unix ms).
    #[serde(default)]
    pub verifying_since_ms: Option<u64>,
    /// Looks after the first miss.
    #[serde(default)]
    pub verify_looks: u32,
}

/// An installer file kept in the downloads folder (`<sha256>.<ext>`), with what a roll-back needs to run it again.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KeptInstaller {
    pub sha256: String,
    /// `msi` or `exe` (checked again by [`versions::kept_file_name`] before the file is used).
    pub ext: String,
    pub version: Option<String>,
    pub kind: RecordKind,
    pub silent_args: Vec<String>,
    pub success_exit_codes: Vec<i32>,
}

impl KeptInstaller {
    /// The file name in the downloads folder, `None` for a hash or extension that is not what it must be.
    fn file_name(&self) -> Option<String> {
        kept_file_name(&self.sha256, &self.ext)
    }
}

fn pinned() -> UpdateMode {
    UpdateMode::Pinned
}

fn works() -> bool {
    true
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
            version: None,
            installed_version: None,
            mode: UpdateMode::Pinned,
            when_closed: false,
            update: false,
            staged: false,
            old_works: true,
            kept: None,
            previous: None,
            heal_pending: false,
            verifying_since_ms: None,
            verify_looks: 0,
        }
    }

    /// The failures after which this record gives up until its revision changes: 6 for an install, 3 for an update
    /// (plan 4.6 "Update retries").
    fn max_failures(&self) -> u32 {
        if self.update {
            MAX_UPDATE_FAILURES
        } else {
            MAX_FAILURES
        }
    }

    /// Whether an operation is waiting for this record (time aside, and for an update the apply window aside).
    fn runnable(&self) -> bool {
        match self.state {
            LocalState::Pending => !self.removal,
            LocalState::Removing => self.removal,
            LocalState::Failed => self.attempts < self.max_failures(),
            // An installed app with an update waiting: stage it, then run it in a window.
            LocalState::Installed => self.update && !self.removal,
            _ => false,
        }
    }

    /// Whether the app's tile may be shown: it is installed and works, or it is being updated and the old version
    /// still does (or the installer is running: the tile then says "Updating..." and cannot be started).
    pub fn visible(&self) -> bool {
        if self.removal {
            return false;
        }
        match self.state {
            LocalState::Installed => true,
            LocalState::Installing => self.update,
            LocalState::Downloading => self.update && self.old_works,
            LocalState::Failed => self.update && self.old_works,
            _ => false,
        }
    }

    fn file_name(&self) -> String {
        format!("{}.{}", self.sha256, self.kind.ext())
    }

    /// The installer files this record keeps on disk besides its own (`kept`, `previous`).
    fn kept_files(&self) -> impl Iterator<Item = String> + '_ {
        [self.kept.as_ref(), self.previous.as_ref()].into_iter().flatten().filter_map(KeptInstaller::file_name)
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
            // A schema 1 file (an agent before Phase 6) loads as it is: every new field has a default. It is saved
            // as schema 2 with the first change.
            Ok(Some(mut file)) if (INSTALLS_SCHEMA_OLDEST..=INSTALLS_SCHEMA).contains(&file.schema) => {
                file.schema = INSTALLS_SCHEMA;
                file
            }
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

    /// The app is installed in this version (`sha256`), or is being updated to it and the old version still works.
    pub fn is_installed(&self, app_id: &str, sha256: &str) -> bool {
        lock(&self.file).apps.get(app_id).is_some_and(|r| r.visible() && r.sha256 == sha256)
    }

    /// (Phase 6 Step 11, plan 4.4.5) What the tile of `app_id` says about an update: "Updating..." while the installer
    /// runs, "Waiting for the app to close" while an update that needs the app closed (`applyWhen: when_closed`) waits.
    pub fn update_state(&self, app_id: &str) -> Option<AppUpdateState> {
        let file = lock(&self.file);
        let record = file.apps.get(app_id)?;
        if !record.update || record.removal {
            return None;
        }
        match record.state {
            LocalState::Installing => Some(AppUpdateState::Updating),
            LocalState::Installed
                if record.when_closed && record.detail.as_deref() == Some(Detail::WaitingForClose.as_str()) =>
            {
                Some(AppUpdateState::WaitingForClose)
            }
            _ => None,
        }
    }

    /// The ids of the apps whose tile may show.
    #[cfg(test)]
    fn installed_ids(&self) -> std::collections::BTreeSet<String> {
        lock(&self.file).apps.values().filter(|r| r.visible()).map(|r| r.app_id.clone()).collect()
    }

    /// The apps whose tile may show and what each says about an update: when it changes, the session recomputes
    /// the employee's apps.
    fn visible_apps(&self) -> BTreeMap<String, Option<AppUpdateState>> {
        let ids: Vec<String> = lock(&self.file).apps.values().filter(|r| r.visible()).map(|r| r.app_id.clone()).collect();
        ids.into_iter().map(|id| { let state = self.update_state(&id); (id, state) }).collect()
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

/// Counts a failure on `record`. An install waits 1, 5, 15, 60, 360 minutes; an update (plan 4.6) waits an hour
/// at least, for its next apply window, and gives up after 3.
fn fail_record(record: &mut InstallRecord, detail: Option<Detail>, exit_code: Option<i64>, now: u64) {
    record.attempts = record.attempts.saturating_add(1);
    record.state = LocalState::Failed;
    record.detail = detail.map(|d| d.as_str().to_string());
    record.last_exit_code = exit_code;
    record.staged = false;
    record.next_try_ms = if record.attempts >= record.max_failures() {
        0
    } else if record.update {
        now.saturating_add(ms(UPDATE_RETRY_GAP))
    } else {
        backoff_after(record.attempts).map_or(0, |wait| now.saturating_add(ms(wait)))
    };
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
    /// The expanded program path (a pattern with one `*` for a program in a versioned folder, plan 4.4.3).
    pub exe: String,
    /// (Phase 6 Step 11) `desktop.version`.
    pub version: Option<String>,
    /// The update mode the engine acts on (`Unknown` is `Pinned`).
    pub mode: UpdateMode,
    /// `applyWhen: when_closed`.
    pub when_closed: bool,
    /// Managed: undo a failed update with the previous installer (absent = true).
    pub rollback_on_fail: bool,
    /// Vendor: an installed version below this runs the bootstrap again.
    pub min_version: Option<String>,
    /// The Authenticode subject the installer file must be signed by (`install.publisher`, else the Vendor
    /// updater's `update.publisher`). `None`: no check.
    pub publisher: Option<String>,
    /// Vendor: the signer of the vendor's own updater and programs (`update.publisher`).
    pub updater_publisher: Option<String>,
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
    let mode = desktop.update_mode();
    let update = desktop.update.as_ref();
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
        version: desktop.version.clone(),
        mode,
        when_closed: update.is_some_and(|u| u.apply_when() == ApplyWhen::WhenClosed),
        rollback_on_fail: update.is_none_or(|u| u.rollback_on_fail()),
        min_version: if mode == UpdateMode::Vendor { update.and_then(|u| u.min_version.clone()) } else { None },
        publisher: install
            .publisher
            .clone()
            .or_else(|| if mode == UpdateMode::Vendor { update.and_then(|u| u.publisher.clone()) } else { None })
            .filter(|subject| !subject.trim().is_empty()),
        updater_publisher: if mode == UpdateMode::Vendor {
            update.and_then(|u| u.publisher.clone()).filter(|subject| !subject.trim().is_empty())
        } else {
            None
        },
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
    record.version = spec.version.clone();
    record.mode = spec.mode;
    record.when_closed = spec.when_closed;
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
    /// (Phase 6 Step 11, plan 4.4.5) Whether an employee is signed in (`SessionManager::presence`). The apply window
    /// reads it; a sign-in or sign-out wakes the engine.
    pub signed_in: watch::Receiver<bool>,
}

struct Engine {
    deps: EngineDeps,
    /// Icon hashes tried in this run (a failing icon is not fetched in a loop).
    icons_tried: HashSet<String>,
    /// (Phase 6 Step 11) When this engine started (Unix ms): the boot window of plan 4.4.5 counts from it.
    started_ms: u64,
    /// An employee has been signed in since the engine started (the boot window is over for good).
    ever_signed_in: bool,
    /// The sign-in state the last pass saw (a change to `true` is a sign-in: the previous installers go).
    was_signed_in: bool,
    /// Waits for processes of apps whose update needs them closed, by process id (`WAKE_SOURCES`: `app_exit`).
    exit_watches: HashMap<u32, Arc<dyn ExitWatch>>,
    /// A watched process ended: wakes the loop.
    exit_tx: mpsc::UnboundedSender<u32>,
}

/// The next operation: an app or a driver (Step 14b), an install or a removal.
struct Job {
    id: String,
    removal: bool,
    driver: bool,
    /// (Phase 6 Step 11) Only download and verify the installer of an update; its run waits for an apply window.
    stage: bool,
}

/// What the engine does next, and what it waits for when there is nothing to do.
struct Plan {
    job: Option<Job>,
    /// When the earliest waiting operation comes due (Unix ms): the `retry_timer` wake source.
    wake: Option<u64>,
}

/// What reconcile reads from the PC for one app (a program path, its file version, the vendor's updater).
struct AppFacts {
    /// The program, resolved (`None`: it is not at its path).
    exe: Option<PathBuf>,
    /// The program's file version.
    detected: Option<String>,
    /// A program signed by the app's vendor runs as SYSTEM (only asked of a Vendor app whose program is missing).
    publisher_busy: bool,
}

/// The account the services run as; the vendor's updater, when it is a service, is its process.
const SYSTEM_SID: &str = "S-1-5-18";

/// The program of `spec_exe` as it is on this PC: a plain path as it is, a template with one `*` resolved to the highest
/// version folder that has the program (plan 4.4.3). `None`: the program is not there.
pub fn resolve_program(platform: &dyn Platform, spec_exe: &str) -> Option<PathBuf> {
    if !versions::is_pattern(spec_exe) {
        let path = PathBuf::from(spec_exe);
        return platform.file_exists(&path).then_some(path);
    }
    let pattern = exe_pattern(spec_exe)?;
    let names = platform.list_folder_names(Path::new(&pattern.folder)).unwrap_or_default();
    let path = PathBuf::from(resolve_pattern(&pattern, &names)?);
    platform.file_exists(&path).then_some(path)
}

/// The state of a record whose operation did not end: `removing` for a removal, `installed` for an app that is being
/// updated (it still is installed), `pending` for a first install.
fn wait_state(record: &InstallRecord) -> LocalState {
    if record.removal {
        LocalState::Removing
    } else if record.update {
        LocalState::Installed
    } else {
        LocalState::Pending
    }
}

/// Plan 4.4.3: a Vendor app that is installed and below its `minVersion` runs the bootstrap again, in an apply window.
fn vendor_minimum(record: &mut InstallRecord, spec: &Spec, revision: u64) {
    if spec.mode == UpdateMode::Vendor
        && record.state == LocalState::Installed
        && !record.update
        && vendor_needs_bootstrap(record.installed_version.as_deref(), spec.min_version.as_deref(), spec.version.as_deref())
    {
        tracing::info!(app_id = %record.app_id, "a vendor-updated app is below its minimum version; the bootstrap runs in an apply window");
        start_update(record, revision);
    }
}

/// An app that is installed gets another installer (plan 4.6 "Upgrade test"): the record keeps working, stages the
/// installer, and waits for an apply window. Nothing is reported for it until it ends.
fn start_update(record: &mut InstallRecord, revision: u64) {
    record.revision = revision;
    record.update = true;
    record.staged = false;
    record.state = LocalState::Installed;
    record.attempts = 0;
    record.next_try_ms = 0;
    record.last_exit_code = None;
    record.detail = None;
    record.busy_since_ms = None;
    record.old_works = true;
    record.verifying_since_ms = None;
    record.verify_looks = 0;
}

/// How an operation ended, before it is written down.
enum Outcome {
    /// A driver's install ended well (apps use [`Outcome::AppInstalled`]).
    Installed { exit_code: i32 },
    /// (Phase 6 Step 11) An app's install ended well. `warning` is a detail that rides on the `installed` result
    /// (`version_too_low` for a Pinned app).
    AppInstalled { exit_code: i32, warning: Option<Detail> },
    /// (Phase 6 Step 11) An update's installer is downloaded and verified; it waits for its apply window.
    Staged,
    /// (Phase 6 Step 11) The apply window closed between the download and the start of the installer: nothing ran,
    /// the update waits again (a sign-in, or the app started).
    Deferred,
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

    /// A tile appeared or went, or its update state changed: the session recomputes the employee's apps.
    fn visible_changed(&self, before: &BTreeMap<String, Option<AppUpdateState>>) {
        if self.deps.book.visible_apps() != *before {
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
                        // An update's app is still installed: it goes back to waiting for its update, not to `pending`.
                        record.state = wait_state(record);
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
            // (Phase 6 Step 11) The installers kept for a roll-back (the version on the PC, the one before the last update).
            .chain(file.apps.values().filter(|r| !r.removal).flat_map(InstallRecord::kept_files))
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

    // ---------------------------------------------------------------- what the PC says (Phase 6 Step 11)

    /// The program of `spec_exe`: a plain path as it is, a template with one `*` resolved to the highest version
    /// folder that has the program (plan 4.4.3). `None`: the program is not there.
    fn resolve_exe(&self, spec_exe: &str) -> Option<PathBuf> {
        resolve_program(self.deps.platform.as_ref(), spec_exe)
    }

    /// Whether a process of `exe` runs in any session. A question that cannot be answered counts as "yes": the
    /// agent never closes a running app, so it never updates one it cannot see is closed.
    fn app_running(&self, exe: &Path) -> bool {
        let Ok(sessions) = self.deps.platform.sessions() else { return true };
        for session in sessions {
            match self.deps.platform.find_processes(session.id, exe) {
                Ok(pids) if pids.is_empty() => {}
                Ok(_) | Err(_) => return true,
            }
        }
        false
    }

    /// Whether a program signed by `publisher` runs as SYSTEM (plan 4.4.3: the vendor's updater may be replacing the
    /// program right now). A process list that cannot be read counts as "yes".
    fn publisher_process_running(&self, publisher: &str) -> bool {
        let Ok(processes) = self.deps.platform.session_processes(0) else { return true };
        let mut checked: HashMap<PathBuf, bool> = HashMap::new();
        for process in processes.into_iter().filter(|p| p.user_sid == SYSTEM_SID) {
            let hit = *checked.entry(process.image.clone()).or_insert_with(|| {
                matches!(self.deps.platform.file_identity(&process.image), Ok(Some(identity))
                    if identity.signer.as_deref().is_some_and(|signer| publisher_matches(signer, publisher)))
            });
            if hit {
                return true;
            }
        }
        false
    }

    /// What reconcile needs to know about the PC for one app, read **before** the records are locked.
    fn app_facts(&self, spec: &Spec, record: Option<&InstallRecord>) -> AppFacts {
        let exe = self.resolve_exe(&spec.exe);
        let detected = exe.as_deref().and_then(|path| self.deps.platform.file_version(path).ok().flatten());
        // Only a Vendor app that is installed but whose program is not there asks about the vendor's updater.
        let publisher_busy = spec.mode == UpdateMode::Vendor
            && exe.is_none()
            && record.is_some_and(|r| r.state == LocalState::Installed && !r.removal && !r.update)
            && spec.updater_publisher.as_deref().is_some_and(|publisher| self.publisher_process_running(publisher));
        AppFacts { exe, detected, publisher_busy }
    }

    // ---------------------------------------------------------------- reconcile

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
        let now = self.now();
        let before = self.deps.book.visible_apps();
        // (Phase 6 Step 11) What the PC says about every app, before the records are locked: a file version or a
        // process list takes a while and the install records are read by the session meanwhile.
        let known = self.deps.book.snapshot();
        let mut facts: HashMap<String, AppFacts> = HashMap::new();
        for app in &policy.catalog {
            if install_of(app).is_none() {
                continue;
            }
            if let Ok(spec) = check_spec(app, &roots) {
                facts.insert(app.id.clone(), self.app_facts(&spec, known.apps.get(&app.id)));
            }
        }
        let (reports, doomed) = self.deps.book.update(|file| {
            let mut out = Vec::new();
            let mut doomed: Vec<String> = Vec::new();
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
                            record.installed_version = old.installed_version.clone();
                            // The installers kept for a roll-back go with the entry that cannot be installed.
                            doomed.extend(old.kept_files());
                        }
                        out.extend(mark(&mut record));
                        file.apps.insert(app.id.clone(), record);
                        continue;
                    }
                };
                let Some(fact) = facts.get(&app.id) else { continue };
                let exe_exists = fact.exe.is_some();
                match file.apps.get_mut(&app.id) {
                    None => {
                        // A program already at its path is taken as installed (its
                        // tile shows), but Rulebox did not install it: it is marked
                        // and will never be uninstalled or deleted by Rulebox.
                        let state = if exe_exists { LocalState::Installed } else { LocalState::Pending };
                        let mut record = fresh_record(app, &spec, state);
                        record.preexisting = exe_exists;
                        record.installed_version = fact.detected.clone();
                        out.extend(mark(&mut record));
                        vendor_minimum(&mut record, &spec, app.revision);
                        file.apps.insert(app.id.clone(), record);
                    }
                    Some(record) => {
                        let sha_changed = record.sha256 != spec.sha256;
                        // The app is installed and works (or its update failed and the old version still does): a
                        // new version is an update, not a first install.
                        let upgradable = !record.removal
                            && (record.state == LocalState::Installed
                                || (record.state == LocalState::Failed && record.update && record.old_works));
                        let restart = record.removal
                            || record.state == LocalState::Unsupported
                            || (sha_changed && !upgradable);
                        if restart {
                            // A new version of an app that is not installed, a re-assignment or an entry that
                            // became usable: a first install again.
                            let state = if record.sha256 == spec.sha256 && exe_exists {
                                LocalState::Installed
                            } else {
                                LocalState::Pending
                            };
                            if record.sha256 != spec.sha256 {
                                doomed.push(record.file_name());
                            }
                            doomed.extend(record.kept_files());
                            // Found again at its path without Rulebox having put it
                            // there (for example after Rulebox removed it): preexisting.
                            let preexisting = record.preexisting
                                || (state == LocalState::Installed && !rulebox_may_have_installed(record));
                            let installed_version = if exe_exists { fact.detected.clone() } else { None };
                            *record = fresh_record(app, &spec, state);
                            record.preexisting = preexisting;
                            record.installed_version = installed_version;
                            out.extend(mark(record));
                            vendor_minimum(record, &spec, app.revision);
                            continue;
                        }
                        if sha_changed {
                            // Plan 4.6 "Upgrade test": the installer changed for an app that is installed.
                            let old_file = record.file_name();
                            match spec.mode {
                                // Vendor (plan 4.4.3): the bootstrap changed, the vendor's updater owns the version.
                                // Nothing runs; the record follows the catalogue so the tile stays.
                                UpdateMode::Vendor => {
                                    tracing::info!(app_id = %app.id, "the bootstrap of a vendor-updated app changed; nothing is reinstalled");
                                    record.sha256 = spec.sha256.clone();
                                    copy_spec(record, &spec);
                                    record.revision = app.revision;
                                    record.state = LocalState::Installed;
                                    record.update = false;
                                    record.staged = false;
                                    record.attempts = 0;
                                    record.next_try_ms = 0;
                                    record.detail = None;
                                    record.last_exit_code = None;
                                    record.old_works = true;
                                    out.extend(mark(record));
                                }
                                _ => {
                                    tracing::info!(app_id = %app.id, "a new version is waiting for an apply window");
                                    record.sha256 = spec.sha256.clone();
                                    copy_spec(record, &spec);
                                    start_update(record, app.revision);
                                }
                            }
                            if !record.kept_files().any(|name| name == old_file) {
                                doomed.push(old_file);
                            }
                        } else {
                            copy_spec(record, &spec);
                            if record.revision != app.revision {
                                record.revision = app.revision;
                                if record.state == LocalState::Failed {
                                    // Retry: a new revision starts the attempts again (an update goes back to waiting
                                    // for its window, a first install back to `pending`).
                                    record.state = wait_state(record);
                                    record.staged = false;
                                    record.attempts = 0;
                                    record.next_try_ms = 0;
                                    record.detail = None;
                                    record.last_exit_code = None;
                                    out.extend(mark(record));
                                }
                            }
                        }
                        if record.state == LocalState::Installed && !exe_exists {
                            if spec.mode == UpdateMode::Vendor && !record.update {
                                // Plan 4.4.3: the vendor's updater may be mid-update. Look again at the next two
                                // reconcile occasions, at least 15 minutes apart; then install the bootstrap again.
                                match verify_step(record.verifying_since_ms, record.verify_looks, now, fact.publisher_busy) {
                                    VerifyStep::Start => {
                                        tracing::info!(app_id = %app.id, "the program of a vendor-updated app is not there; looking again later");
                                        record.verifying_since_ms = Some(now);
                                        record.verify_looks = 0;
                                    }
                                    VerifyStep::Wait => {}
                                    VerifyStep::Look => {
                                        record.verifying_since_ms = Some(now);
                                        record.verify_looks += 1;
                                    }
                                    VerifyStep::Reinstall => {
                                        tracing::warn!(app_id = %app.id, "the program of a vendor-updated app is still missing; installing the bootstrap again");
                                        record.verifying_since_ms = None;
                                        record.verify_looks = 0;
                                        record.state = LocalState::Pending;
                                        record.attempts = 0;
                                        record.next_try_ms = 0;
                                        out.extend(mark(record));
                                    }
                                }
                            } else {
                                tracing::warn!(app_id = %app.id, "the program of an installed app is gone; installing it again");
                                record.state = LocalState::Pending;
                                record.update = false;
                                record.staged = false;
                                record.old_works = true;
                                record.attempts = 0;
                                record.next_try_ms = 0;
                                out.extend(mark(record));
                            }
                        } else if record.state == LocalState::Installed {
                            record.verifying_since_ms = None;
                            record.verify_looks = 0;
                            // The version the PC has (plan 4.4.1); reported once, when it changes.
                            if !record.update {
                                let current = detection(fact.detected.clone(), record.installed_version.as_deref());
                                if current != record.installed_version {
                                    record.installed_version = current;
                                    out.extend(mark(record));
                                }
                            }
                            vendor_minimum(record, &spec, app.revision);
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
                        doomed.extend(record.kept_files());
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
                // The installers kept for a roll-back go with the assignment.
                doomed.extend(record.kept_files());
                record.kept = None;
                record.previous = None;
                record.heal_pending = false;
                if record.remove_when_unassigned && can_remove && on_pc && !record.preexisting {
                    tracing::info!(app_id = %id, "unassigned; it will be removed");
                    record.removal = true;
                    record.update = false;
                    record.staged = false;
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

    // ---------------------------------------------------------------- apply windows (plan 4.4.5)

    /// Reads whether an employee is signed in. A sign-in ends the boot window for good and deletes the installers kept
    /// from before the last update (the new version ran long enough for an employee to sign in).
    fn refresh_presence(&mut self, rx: &mut watch::Receiver<bool>) -> bool {
        let signed_in = *rx.borrow_and_update();
        if signed_in {
            self.ever_signed_in = true;
            if !self.was_signed_in {
                self.forget_previous_installers();
            }
        }
        self.was_signed_in = signed_in;
        signed_in
    }

    /// The installers kept for a roll-back are deleted once the new version has been healthy for one sign-in.
    fn forget_previous_installers(&self) {
        let doomed = self.deps.book.update(|file| {
            let mut doomed = Vec::new();
            for record in file.apps.values_mut().filter(|r| r.heal_pending) {
                record.heal_pending = false;
                if let Some(previous) = record.previous.take() {
                    // The file of the version on the PC (`kept`) is never the one that goes.
                    if record.kept.as_ref().map(|k| &k.sha256) != Some(&previous.sha256) {
                        doomed.extend(previous.file_name());
                    }
                }
            }
            doomed
        });
        for name in doomed {
            self.delete_download(&name);
        }
    }

    /// Whether the update of `record` may run now: an apply window is open and the app is not running.
    fn window_open(&self, record: &InstallRecord, signed_in: bool) -> bool {
        let now = self.now();
        let running = record
            .exe
            .as_deref()
            .and_then(|exe| self.resolve_exe(exe))
            .is_some_and(|path| self.app_running(&path));
        versions::window(WindowInputs {
            signed_in,
            boot_open: boot_window_open(self.started_ms, now, self.ever_signed_in),
            when_closed: record.when_closed,
            app_running: running,
        })
        .is_some()
    }

    /// An update that is ready and waits for its window says so once (`installed` with the detail
    /// `waiting_for_close`: the dashboard shows "Waiting for the app to close"); it stops saying so when it runs.
    fn evaluate_waiting(&self, signed_in: bool) {
        let file = self.deps.book.snapshot();
        let mut verdicts: Vec<(String, bool)> = Vec::new();
        for record in file.apps.values() {
            if record.update && !record.removal && record.state == LocalState::Installed && record.staged {
                verdicts.push((record.app_id.clone(), self.window_open(record, signed_in)));
            }
        }
        if verdicts.is_empty() {
            return;
        }
        let before = self.deps.book.visible_apps();
        let waiting = Detail::WaitingForClose.as_str();
        let reports = self.deps.book.update(|file| {
            let mut out = Vec::new();
            for (id, open) in &verdicts {
                let Some(record) = file.apps.get_mut(id) else { continue };
                let says_waiting = record.detail.as_deref() == Some(waiting);
                if !open && !says_waiting {
                    tracing::info!(app_id = %id, "an update is ready and waits for an apply window");
                    record.detail = Some(waiting.to_string());
                    out.extend(mark(record));
                } else if *open && says_waiting {
                    // The next result (installed or failed) replaces it; nothing is reported for the change.
                    record.detail = None;
                }
            }
            out
        });
        self.push(reports);
        self.visible_changed(&before);
    }

    /// The wake source `app_exit` (plan 4.4.5): for an update that waits and whose app runs, one wait on each process
    /// handle. The wait is the operating system's, not a timer; it ends the moment the process does.
    fn watch_exits(&mut self) {
        let file = self.deps.book.snapshot();
        let sessions = self.deps.platform.sessions().unwrap_or_default();
        for record in file.apps.values() {
            let waits = record.update && !record.removal && (record.staged || record.state == LocalState::Failed);
            if !waits {
                continue;
            }
            let Some(exe) = record.exe.as_deref().and_then(|exe| self.resolve_exe(exe)) else { continue };
            for session in &sessions {
                for pid in self.deps.platform.find_processes(session.id, &exe).unwrap_or_default() {
                    if self.exit_watches.contains_key(&pid) {
                        continue;
                    }
                    match self.deps.platform.watch_process_exit(pid) {
                        Ok(Some(watch)) => {
                            self.exit_watches.insert(pid, Arc::clone(&watch));
                            let tx = self.exit_tx.clone();
                            drop(tokio::task::spawn_blocking(move || {
                                if watch.wait() {
                                    let _ = tx.send(pid);
                                }
                            }));
                        }
                        Ok(None) => {}
                        Err(error) => tracing::warn!("cannot watch a process for its exit: {error}"),
                    }
                }
            }
        }
    }

    /// The engine stops: every wait for a process ends (its blocking thread returns).
    fn cancel_exit_watches(&mut self) {
        for (_, watch) in self.exit_watches.drain() {
            watch.cancel();
        }
    }

    // ---------------------------------------------------------------- what to do next

    /// The next operation that is due and what the engine waits for when there is none. Installs wait for the
    /// connection. An update that is ready waits for its apply window and contributes **no timer** while it does:
    /// a sign-in, a sign-out or the app's exit wakes the engine (`WAKE_SOURCES`).
    fn plan(&self, online: bool, signed_in: bool) -> Plan {
        let now = self.now();
        let file = self.deps.book.snapshot();
        let mut wake: Option<u64> = None;
        for record in file.apps.values() {
            if !record.runnable() || !(record.removal || online) {
                continue;
            }
            // Staging (the download) is not gated; running an update's installer is.
            let stage = record.update && !record.removal && record.state == LocalState::Installed && !record.staged;
            let gated = record.update && !record.removal && !stage;
            if gated && !self.window_open(record, signed_in) {
                continue;
            }
            if record.next_try_ms <= now {
                return Plan { job: Some(Job { id: record.app_id.clone(), removal: record.removal, driver: false, stage }), wake: None };
            }
            wake = Some(wake.map_or(record.next_try_ms, |w| w.min(record.next_try_ms)));
        }
        // (Step 14b) Apps first, then drivers.
        for record in file.drivers.values() {
            if !record.runnable() || !(record.removal || online) {
                continue;
            }
            if record.next_try_ms <= now {
                return Plan { job: Some(Job { id: record.driver_id.clone(), removal: record.removal, driver: true, stage: false }), wake: None };
            }
            wake = Some(wake.map_or(record.next_try_ms, |w| w.min(record.next_try_ms)));
        }
        Plan { job: None, wake }
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
    async fn wait_for_exe(&self, spec_exe: &str, shutdown: &CancellationToken) -> Option<bool> {
        let deadline = tokio::time::Instant::now() + self.deps.exe_wait;
        loop {
            // A program in a versioned folder (plan 4.4.3) is found by its template.
            if self.resolve_exe(spec_exe).is_some() {
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

    /// Whether the apply window of the update of `app_id` is still open (read again right before the installer starts: an
    /// employee may have signed in, or the app been started, while the installer downloaded).
    fn window_still_open(&self, app_id: &str) -> bool {
        let Some(record) = self.deps.book.snapshot().apps.get(app_id).cloned() else { return false };
        self.window_open(&record, *self.deps.signed_in.borrow())
    }

    /// The installer file's signer is the `wanted` publisher (plan 4.4.3). A file that is not signed, or whose signature
    /// cannot be read, is not.
    fn publisher_ok(&self, file: &Path, wanted: &str) -> bool {
        match self.deps.platform.file_identity(file) {
            Ok(Some(identity)) => identity.signer.as_deref().is_some_and(|signer| publisher_matches(signer, wanted)),
            Ok(None) | Err(_) => false,
        }
    }

    /// Runs one package: `msiexec /i`, the installer exe with its silent arguments, or the portable copy. `Err(InUse)`:
    /// a portable program is running. `spec_exe` may be a template with a `*` (a versioned folder): then no one path is
    /// expected to appear.
    #[allow(clippy::too_many_arguments)]
    async fn run_package(
        &self,
        app_id: &str,
        kind: RecordKind,
        file: &Path,
        silent_args: &[String],
        spec_exe: &str,
        roots: &PathRoots,
        shutdown: &CancellationToken,
    ) -> Result<InstallerExit, PlatformError> {
        let exe = PathBuf::from(spec_exe);
        let downloads = self.deps.paths.downloads_dir();
        let expected = !versions::is_pattern(spec_exe);
        match kind {
            RecordKind::Msi => {
                let Some(system_root) = roots.system_root.as_deref() else {
                    return Err(PlatformError::Refused("the Windows folder is not known"));
                };
                self.prune_msi_logs();
                let _ = std::fs::create_dir_all(self.deps.paths.logs_dir());
                let log = self.deps.paths.install_log(app_id);
                let mut cmd = msi_install_command(Path::new(system_root), file, &log, &downloads, &exe);
                if !expected {
                    cmd.expected_exe = None;
                }
                self.run_installer(cmd, shutdown).await
            }
            RecordKind::Exe => {
                let mut cmd = exe_install_command(file, silent_args, &downloads, &exe);
                if !expected {
                    cmd.expected_exe = None;
                }
                self.run_installer(cmd, shutdown).await
            }
            RecordKind::Portable => {
                let platform = Arc::clone(&self.deps.platform);
                let (from, to) = (file.to_path_buf(), exe);
                tokio::task::spawn_blocking(move || platform.place_portable(&from, &to))
                    .await
                    .unwrap_or_else(|error| Err(PlatformError::Other(error.to_string())))
                    .map(|()| InstallerExit::Code(0))
            }
        }
    }

    /// One install or update of an app. `update`: the app is installed and gets another installer (only terminal states
    /// are reported, the old version stays usable until the installer starts). `stage_only`: download and verify the
    /// installer and stop; its run waits for an apply window.
    async fn install(
        &self,
        app_id: &str,
        spec: &Spec,
        roots: &PathRoots,
        shutdown: &CancellationToken,
        update: bool,
        stage_only: bool,
    ) -> Outcome {
        self.set_state(app_id, LocalState::Downloading);
        let dest = match self.download(app_id, spec, shutdown).await {
            Ok(dest) => dest,
            Err(Some(detail)) => return Outcome::Failed { detail: Some(detail), exit_code: None },
            Err(None) => return Outcome::Abandoned,
        };
        let staged = |staged: bool| {
            self.deps.book.update(|file| {
                if let Some(record) = file.apps.get_mut(app_id) {
                    record.staged = staged;
                }
            });
        };
        if stage_only {
            tracing::info!(app_id, "the update is downloaded and waits for an apply window");
            staged(true);
            return Outcome::Staged;
        }
        // The window may have closed while the installer downloaded (an employee signed in, the app was started).
        if update && !self.window_still_open(app_id) {
            tracing::info!(app_id, "the apply window closed before the update could start; it waits again");
            staged(true);
            return Outcome::Deferred;
        }
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
        // (Phase 6 Step 11, plan 4.4.3) Signed by the publisher the catalogue names, or it does not run.
        if let Some(wanted) = &spec.publisher {
            if !self.publisher_ok(verified.path(), wanted) {
                tracing::error!(app_id, "the installer is not signed by the app's publisher; nothing ran");
                drop(verified);
                return Outcome::Failed { detail: Some(Detail::PublisherMismatch), exit_code: None };
            }
        }
        if update {
            // The installer is about to touch the old version: it may not work afterwards. The installer of the version
            // that is on the PC becomes `previous` (what a roll-back runs); the tile says "Updating...".
            let doomed = self.deps.book.update(|file| {
                let mut doomed = Vec::new();
                if let Some(record) = file.apps.get_mut(app_id) {
                    record.old_works = false;
                    record.detail = None;
                    let new_previous = record.kept.clone();
                    // A `previous` of an earlier update that was never healed is replaced: its file goes (unless it is the
                    // very file that is kept now).
                    if let Some(old) = record.previous.take() {
                        if new_previous.as_ref().map(|k| &k.sha256) != Some(&old.sha256) {
                            doomed.extend(old.file_name());
                        }
                    }
                    record.previous = new_previous;
                }
                doomed
            });
            for name in doomed {
                self.delete_download(&name);
            }
            (self.deps.on_visible_change)();
        }
        tracing::info!(app_id, kind = ?spec.kind, update, "installing");
        let ran = self.run_package(app_id, spec.kind, verified.path(), &spec.silent_args, &spec.exe, roots, shutdown).await;
        // Held until the installer and everything it started are gone (the
        // platform returns only then).
        drop(verified);
        let outcome = self.judge(app_id, spec, &dest, ran, shutdown).await;
        // Plan 4.6 "Rollback on failure": a Managed update that failed after the installer touched the old version.
        let touched = self.deps.book.snapshot().apps.get(app_id).is_some_and(|record| !record.old_works);
        if update && touched && spec.mode == UpdateMode::Managed && spec.rollback_on_fail && matches!(outcome, Outcome::Failed { .. }) {
            return self.roll_back(app_id, spec, roots, shutdown, outcome).await;
        }
        outcome
    }

    /// How an installer run ended, as an [`Outcome`].
    async fn judge(
        &self,
        app_id: &str,
        spec: &Spec,
        dest: &Path,
        ran: Result<InstallerExit, PlatformError>,
        shutdown: &CancellationToken,
    ) -> Outcome {
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
                    match self.wait_for_exe(&spec.exe, shutdown).await {
                        Some(true) => self.installed(app_id, spec, dest, code),
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

    /// The installer succeeded and the program is there: check its version (plan 4.6 "Detection"), decide what to keep
    /// for a roll-back and write down the version the PC has.
    fn installed(&self, app_id: &str, spec: &Spec, dest: &Path, code: i32) -> Outcome {
        let file_version = self
            .resolve_exe(&spec.exe)
            .and_then(|path| self.deps.platform.file_version(&path).ok().flatten());
        let too_low = check_installed(file_version.as_deref(), spec.version.as_deref()) == VersionCheck::TooLow;
        // A Vendor app that has to reach its `minVersion` and did not, fails like a Managed one: nothing else would
        // ever stop the engine from running the bootstrap again.
        let below_min = match (file_version.as_deref(), spec.min_version.as_deref()) {
            (Some(file), Some(min)) => versions::is_lower(file, min) == Some(true),
            _ => false,
        };
        if (too_low && spec.mode == UpdateMode::Managed) || below_min {
            tracing::warn!(app_id, "the program's version is lower than the version this install delivers");
            return Outcome::Failed { detail: Some(Detail::VersionTooLow), exit_code: Some(i64::from(code)) };
        }
        let version = detection(file_version, spec.version.as_deref());
        let keep = self.keep_installer(app_id, spec, dest);
        if keep.is_none() {
            let _ = remove_file_if_exists(dest);
        }
        let doomed = self.deps.book.update(|file| {
            let mut doomed = Vec::new();
            if let Some(record) = file.apps.get_mut(app_id) {
                record.installed_version = version;
                let replaced = record.kept.take();
                record.kept = keep;
                record.heal_pending = record.previous.is_some();
                // The file of the version that was on the PC stays while it is `previous`; else it is not needed.
                if let Some(old) = replaced {
                    let still_needed = record.previous.as_ref().is_some_and(|p| p.sha256 == old.sha256)
                        || record.kept.as_ref().is_some_and(|k| k.sha256 == old.sha256);
                    if !still_needed {
                        doomed.extend(old.file_name());
                    }
                }
            }
            doomed
        });
        for name in doomed {
            self.delete_download(&name);
        }
        Outcome::AppInstalled { exit_code: code, warning: too_low.then_some(Detail::VersionTooLow) }
    }

    /// Plan 4.6 "Previous installer": a Managed app with `rollbackOnFail` keeps the installer it was just installed
    /// from, so the next update can be undone. Nothing is kept while the system drive has less than 3 GiB free, or when
    /// all kept installers would pass 2 GiB.
    fn keep_installer(&self, app_id: &str, spec: &Spec, dest: &Path) -> Option<KeptInstaller> {
        if spec.mode != UpdateMode::Managed || !spec.rollback_on_fail {
            return None;
        }
        let size = std::fs::metadata(dest).ok()?.len();
        let free = self.deps.platform.disk_free_bytes().ok()?;
        if !may_keep(free, self.kept_bytes(app_id), size) {
            tracing::info!(app_id, "the installer is not kept for a roll-back (not enough free disk, or the kept installers are at their limit)");
            return None;
        }
        Some(KeptInstaller {
            sha256: spec.sha256.clone(),
            ext: spec.kind.ext().to_string(),
            version: spec.version.clone(),
            kind: spec.kind,
            silent_args: spec.silent_args.clone(),
            success_exit_codes: spec.success_exit_codes.clone(),
        })
    }

    /// The bytes of the installers kept for a roll-back: every app's `previous`, and every other app's `kept` (this
    /// app's `kept` is replaced by the one being decided).
    fn kept_bytes(&self, app_id: &str) -> u64 {
        let dir = self.deps.paths.downloads_dir();
        let file = self.deps.book.snapshot();
        file.apps
            .values()
            .flat_map(|record| {
                let own = record.app_id == app_id;
                [record.kept.as_ref().filter(|_| !own), record.previous.as_ref()].into_iter().flatten().filter_map(KeptInstaller::file_name)
            })
            .map(|name| std::fs::metadata(dir.join(name)).map_or(0, |meta| meta.len()))
            .sum()
    }

    /// Plan 4.6 "Rollback on failure": the update failed after the installer touched the old version; run the previous
    /// installer once. The result is `failed` with `update_rolled_back` (the old version works), `rollback_failed`, or
    /// `rollback_unsupported` (an MSI cannot be installed over a newer one, and the new one's product code is not known
    /// to uninstall it first). `failed` is the update's own failure, returned when there is nothing to roll back to.
    async fn roll_back(&self, app_id: &str, spec: &Spec, roots: &PathRoots, shutdown: &CancellationToken, failed: Outcome) -> Outcome {
        let Outcome::Failed { exit_code, .. } = &failed else { return failed };
        let exit_code = *exit_code;
        let record = self.deps.book.snapshot().apps.get(app_id).cloned();
        let Some(previous) = record.and_then(|r| r.previous).filter(|p| p.file_name().is_some()) else {
            tracing::warn!(app_id, "the update failed and there is no previous installer to roll back to");
            return failed;
        };
        let Some(name) = previous.file_name() else { return failed };
        tracing::warn!(app_id, "the update failed; rolling back to the previous installer");
        let rolled = |detail: Detail| Outcome::Failed { detail: Some(detail), exit_code };
        let file = self.deps.paths.downloads_dir().join(name);
        // An MSI cannot be installed over a newer version of itself: the new one is uninstalled first, by its product code.
        if previous.kind == RecordKind::Msi {
            let (Some(code), Some(system_root)) = (spec.product_code.as_deref(), roots.system_root.as_deref()) else {
                tracing::warn!(app_id, "an MSI cannot be installed over a newer one and the product code of the new one is not known");
                return rolled(Detail::RollbackUnsupported);
            };
            self.prune_msi_logs();
            let _ = std::fs::create_dir_all(self.deps.paths.logs_dir());
            let log = self.deps.paths.install_log(app_id);
            let cmd = msi_removal_command(Path::new(system_root), code, &log, &self.deps.paths.downloads_dir(), None);
            match self.run_installer(cmd, shutdown).await {
                Ok(InstallerExit::Cancelled) => return Outcome::Interrupted,
                Ok(InstallerExit::Code(removed)) if matches!(judge_removal(removed), ExitVerdict::Success { .. }) => {}
                _ => return rolled(Detail::RollbackFailed),
            }
        }
        let Ok(verified) = open_verified(&file, &previous.sha256) else {
            tracing::error!(app_id, "the previous installer is missing or changed; no roll-back");
            return rolled(Detail::RollbackFailed);
        };
        let ran = self.run_package(app_id, previous.kind, verified.path(), &previous.silent_args, &spec.exe, roots, shutdown).await;
        drop(verified);
        let succeeded = match ran {
            Ok(InstallerExit::Cancelled) => return Outcome::Interrupted,
            Ok(InstallerExit::Code(code)) => match judge_install(previous.kind == RecordKind::Msi, &previous.success_exit_codes, code) {
                ExitVerdict::Success { restart } => {
                    if restart {
                        self.note_restart();
                    }
                    true
                }
                ExitVerdict::Busy | ExitVerdict::Failure => false,
            },
            Ok(InstallerExit::TimedOut) | Err(_) => false,
        };
        if !succeeded || self.wait_for_exe(&spec.exe, shutdown).await != Some(true) {
            tracing::error!(app_id, "the roll-back did not bring the old version back");
            return rolled(Detail::RollbackFailed);
        }
        let file_version = self.resolve_exe(&spec.exe).and_then(|path| self.deps.platform.file_version(&path).ok().flatten());
        let version = detection(file_version, previous.version.as_deref());
        self.deps.book.update(|file| {
            if let Some(record) = file.apps.get_mut(app_id) {
                record.old_works = true;
                record.installed_version = version;
                record.previous = None;
                record.heal_pending = false;
            }
        });
        tracing::info!(app_id, "rolled back: the old version works again");
        rolled(Detail::UpdateRolledBack)
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
            // Back to waiting (not counted) after an uncounted interruption. An app that is being updated is still
            // installed: it goes back to `installed`, not to `pending`.
            let wait_again = |record: &mut InstallRecord| {
                if matches!(record.state, LocalState::Downloading | LocalState::Installing) {
                    record.state = wait_state(record);
                }
            };
            let outcome = match outcome {
                Outcome::Installed { exit_code } => Outcome::AppInstalled { exit_code, warning: None },
                other => other,
            };
            match outcome {
                Outcome::Installed { .. } => None,
                Outcome::AppInstalled { exit_code, warning } => {
                    tracing::info!(app_id, "installed");
                    record.state = LocalState::Installed;
                    // A warning rides on the result (`version_too_low` for an app that is not Managed).
                    record.detail = warning.map(|detail| detail.as_str().to_string());
                    record.last_exit_code = (exit_code != 0).then_some(i64::from(exit_code));
                    record.next_try_ms = 0;
                    record.busy_since_ms = None;
                    record.update = false;
                    record.staged = false;
                    record.old_works = true;
                    record.verifying_since_ms = None;
                    record.verify_looks = 0;
                    mark(record)
                }
                // An update's installer is ready, or its window closed: the app stays installed and nothing is reported.
                Outcome::Staged | Outcome::Deferred => {
                    wait_again(record);
                    None
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
                    if record.attempts >= record.max_failures() {
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
            if record.state == LocalState::Failed && record.attempts >= record.max_failures() {
                // Not the file the version on the PC was installed from (`kept`): a roll-back needs that one.
                if !record.kept_files().any(|name| name == record.file_name()) {
                    self.delete_download(&record.file_name());
                }
            }
        }
    }

    async fn run_job(&self, app_id: &str, removal: bool, stage: bool, policy: &AgentPolicy, shutdown: &CancellationToken) {
        // Anything that keeps the job from starting waits like a busy installer (not
        // counted), so the loop never spins on it.
        let roots = match self.deps.platform.path_roots() {
            Ok(roots) => roots,
            Err(error) => {
                tracing::warn!("cannot read the program folders ({error})");
                return self.finish(app_id, Outcome::Wait);
            }
        };
        let before = self.deps.book.visible_apps();
        let outcome = if removal {
            let Some(record) = self.deps.book.snapshot().apps.get(app_id).cloned() else { return };
            self.remove(&record, &roots, shutdown).await
        } else {
            let spec = policy.catalog.iter().find(|a| a.id == app_id).map(|app| check_spec(app, &roots));
            let Some(Ok(spec)) = spec else {
                return self.finish(app_id, Outcome::Wait);
            };
            let update = self.deps.book.snapshot().apps.get(app_id).is_some_and(|record| record.update);
            self.install(app_id, &spec, &roots, shutdown, update, stage).await
        };
        self.finish(app_id, outcome);
        self.visible_changed(&before);
    }
}

/// The `installs` task (started by `agent::run`).
///
/// **What wakes it** is [`WAKE_SOURCES`](versions::WAKE_SOURCES) and nothing else: the signed document (`policy`),
/// enrollment and the connection (`snapshot`), an employee signing in or out (`presence`), a watched process of an app
/// that has an update waiting ending (`app_exit`), and the earliest retry that is due (`retry_timer`). There is no
/// interval and no polling: an update that waits for an apply window sleeps until one of the first four happens.
pub async fn run_install_task(
    deps: EngineDeps,
    policy_rx: watch::Receiver<AgentPolicy>,
    snapshot_rx: watch::Receiver<AgentSnapshot>,
    shutdown: CancellationToken,
) {
    tracing::debug!(wake_sources = ?versions::WAKE_SOURCES, "the install engine starts");
    let (exit_tx, exit_rx) = mpsc::unbounded_channel();
    let presence_rx = deps.signed_in.clone();
    let signed_in_now = *presence_rx.borrow();
    let started_ms = (deps.now_ms)();
    let mut engine = Engine {
        deps,
        icons_tried: HashSet::new(),
        started_ms,
        ever_signed_in: signed_in_now,
        was_signed_in: signed_in_now,
        exit_watches: HashMap::new(),
        exit_tx,
    };
    engine.recover();
    run_loop(&mut engine, policy_rx, snapshot_rx, presence_rx, exit_rx, &shutdown).await;
    // Every wait for a process ends with the engine (its blocking thread returns).
    engine.cancel_exit_watches();
}

async fn run_loop(
    engine: &mut Engine,
    mut policy_rx: watch::Receiver<AgentPolicy>,
    mut snapshot_rx: watch::Receiver<AgentSnapshot>,
    mut presence_rx: watch::Receiver<bool>,
    mut exit_rx: mpsc::UnboundedReceiver<u32>,
    shutdown: &CancellationToken,
) {
    let mut catalog_seen: Option<Vec<CatalogApp>> = None;
    let mut presence_open = true;
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
        let signed_in = engine.refresh_presence(&mut presence_rx);
        let mut wake = None;
        if enrolled {
            engine.reconcile(&policy);
            engine.reconcile_drivers(&policy);
            engine.evaluate_waiting(signed_in);
            if online && policy.has_document {
                if catalog_seen.as_ref() != Some(&policy.catalog) {
                    // A new catalogue: icons that failed before may work now.
                    engine.icons_tried.clear();
                    catalog_seen = Some(policy.catalog.clone());
                }
                engine.fetch_icons(&policy, deployment.as_deref(), shutdown).await;
                if shutdown.is_cancelled() {
                    return;
                }
            }
            let plan = engine.plan(online, signed_in);
            if let Some(job) = plan.job {
                if job.driver {
                    engine.run_driver_job(&job.id, job.removal, &policy, shutdown).await;
                } else {
                    engine.run_job(&job.id, job.removal, job.stage, &policy, shutdown).await;
                }
                continue;
            }
            // Nothing to do now: an update that waits for the app to close is woken by the app's exit.
            engine.watch_exits();
            wake = plan.wake;
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
            changed = presence_rx.changed(), if presence_open => {
                if changed.is_err() {
                    // No session layer any more: sign-in state stops changing, nothing else is affected.
                    presence_open = false;
                }
            }
            ended = exit_rx.recv() => {
                if let Some(pid) = ended {
                    engine.exit_watches.remove(&pid);
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
