//! (Phase 5 Step 14b, plan "Drivers") The install engine's driver jobs: the signed document's `drivers` list is put on
//! the PC with the same machinery as an app's installer, and nothing of it ever shows as a tile.
//!
//! - **Desired set:** `policy.drivers`. Each has a [`DriverRecord`] in `installs.json` (`drivers`).
//! - **An install** (one operation at a time, in the engine's one task): free disk -> download into the protected
//!   downloads folder (`<sha256>.zip|exe|msi`) -> the file is opened locked against writers and hashed again through that
//!   handle -> then, by kind:
//!   * `inf`: the zip is unpacked into `<data>\drivers\work\<sha256>` (`unzip.rs`: no unsafe path, link, bomb), the
//!     `.inf` must be there, and **every `CatalogFile=` of its `[Version]` section must exist and be validly signed**
//!     (`Platform::file_identity`). One that is not -> `failed / unsigned_driver` and `pnputil` is never started (Windows
//!     would prompt for it; a prompt in the Staff session is a bug). Then `pnputil /add-driver <inf> /install` runs as
//!     SYSTEM in the job object, without a window. The package name Windows gave (`oem<N>.inf`) is learned by comparing the
//!     driver store before and after, written into the journal (a restore removes it) and into the record;
//!   * `exe` / `msi`: the vendor installer with its silent arguments (an msi through `msiexec /i /qn /norestart`).
//!
//!   Exit codes are read like an app's: 0, the listed success codes, and 3010 / 1641 (restart pending until the next
//!   boot, never restarted by the agent); 1618 is busy and retried without counting; every other failure waits 1, 5, 15,
//!   60, 360 minutes and the sixth is final until the entry's revision changes (the dashboard's Retry).
//! - **A removal** happens only for packages Rulebox published itself (`DriverRecord::packages`) and only through the
//!   journal: the file `%SystemRoot%\INF\oem<N>.inf` must still have the SHA-256 Rulebox recorded, else nothing is
//!   deleted. Exe and msi drivers, and an INF package that was already in the store, are never removed.
//! - Results go to the server through the install report channel under the driver's id.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use rulebox_policy::paths::PathRoots;

use super::*;
use crate::installs::drivers_probe::{has_seagull_marker, inf_facts, protected_print_refuses, seagull_warning, InfFacts};
use crate::installs::drivers_rules::{
    catalog_files, catalog_name_ok, check_driver, decode_inf, exe_driver_command, inf_file, msi_driver_command,
    pnputil_add_command, DriverPackage, DriverPlan, DriverRecordKind, MAX_INF_BYTES,
};
use crate::installs::unzip::{extract, remove_tree};
use crate::journal::{self, JournalCtx};

/// An `oem<N>.inf` is hashed up to this size.
const MAX_PUBLISHED_INF_BYTES: u64 = 64 * 1024 * 1024;

/// An unpacked and judged INF package: the absolute path of the `.inf` and what its text says (class, Seagull marker).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedInf {
    pub inf: PathBuf,
    pub facts: InfFacts,
}

/// Unpacks a driver zip and judges its INF. Blocking (file and signature reads); the extraction folder is deleted again on
/// every failure.
pub fn prepare_inf_package(platform: &dyn Platform, zip: &Path, work: &Path, inf_rel: &str) -> Result<PreparedInf, Detail> {
    let result = prepare_inner(platform, zip, work, inf_rel);
    if result.is_err() {
        remove_tree(work);
    }
    result
}

fn is_plain_file(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|meta| meta.is_file() && !meta.file_type().is_symlink()) && matches!(is_reparse_point(path), Ok(false))
}

fn prepare_inner(platform: &dyn Platform, zip: &Path, work: &Path, inf_rel: &str) -> Result<PreparedInf, Detail> {
    if let Err(error) = extract(zip, work) {
        tracing::warn!("a driver package was refused: {error}");
        return Err(Detail::BadPackage);
    }
    let inf = inf_file(work, inf_rel);
    if !is_plain_file(&inf) {
        tracing::warn!("a driver package does not hold the .inf its entry names");
        return Err(Detail::BadPackage);
    }
    let bytes = match std::fs::metadata(&inf) {
        Ok(meta) if meta.len() <= MAX_INF_BYTES as u64 => std::fs::read(&inf).map_err(|_| Detail::BadPackage)?,
        _ => return Err(Detail::BadPackage),
    };
    let text = decode_inf(&bytes);
    let catalogs = catalog_files(&text);
    // An INF without a catalog cannot be signed: Windows would prompt for it.
    if catalogs.is_empty() {
        tracing::warn!("a driver INF names no catalog file; refused as unsigned");
        return Err(Detail::UnsignedDriver);
    }
    let folder = inf.parent().ok_or(Detail::BadPackage)?;
    for name in catalogs {
        if !catalog_name_ok(&name) {
            return Err(Detail::BadPackage);
        }
        let path = folder.join(&name);
        if !is_plain_file(&path) {
            tracing::warn!("a driver INF names a catalog file that is not in the package; refused as unsigned");
            return Err(Detail::UnsignedDriver);
        }
        match platform.file_identity(&path) {
            Ok(Some(identity)) if identity.signer.is_some() => {}
            _ => {
                tracing::warn!("a driver catalog is not validly signed; refused");
                return Err(Detail::UnsignedDriver);
            }
        }
    }
    Ok(PreparedInf { facts: inf_facts(&text), inf })
}

impl Engine {
    fn set_driver_state(&self, id: &str, state: LocalState) {
        self.deps.book.update(|file| {
            if let Some(record) = file.drivers.get_mut(id) {
                record.state = state;
            }
        });
    }

    /// Brings the driver records in line with the document (no operation runs here).
    pub(super) fn reconcile_drivers(&self, policy: &AgentPolicy) {
        if !policy.has_document {
            return;
        }
        let system_root = match self.deps.platform.path_roots() {
            Ok(roots) => roots.system_root,
            Err(error) => {
                tracing::warn!("cannot read the program folders ({error}); driver installs wait");
                return;
            }
        };
        let (reports, doomed) = self.deps.book.update(|file| {
            let mut out = Vec::new();
            let mut doomed = Vec::new();
            let mut wanted = HashSet::new();
            for spec in &policy.drivers {
                wanted.insert(spec.id.clone());
                match check_driver(spec, system_root.as_deref()) {
                    Err(reason) => {
                        let same = file
                            .drivers
                            .get(&spec.id)
                            .is_some_and(|r| r.state == LocalState::Unsupported && r.revision == spec.revision && r.sha256 == spec.sha256);
                        if same {
                            continue;
                        }
                        tracing::warn!(driver_id = %spec.id, "this driver cannot be installed: {reason}");
                        if !is_safe_id(&spec.id) {
                            continue;
                        }
                        let kind = DriverRecordKind::of_spec(spec.kind).unwrap_or(DriverRecordKind::Exe);
                        let mut record = DriverRecord::new(&spec.id, kind, &spec.sha256, spec.revision, LocalState::Unsupported);
                        record.detail = Some(Detail::Unsupported.as_str().to_string());
                        if let Some(old) = file.drivers.get(&spec.id) {
                            record.packages = old.packages.clone();
                        }
                        out.extend(record.mark());
                        file.drivers.insert(spec.id.clone(), record);
                    }
                    Ok(plan) => match file.drivers.get_mut(&spec.id) {
                        None => {
                            let mut record = DriverRecord::new(&spec.id, plan.kind, &plan.sha256, spec.revision, LocalState::Pending);
                            out.extend(record.mark());
                            file.drivers.insert(spec.id.clone(), record);
                        }
                        Some(record) => {
                            let restart = record.sha256 != plan.sha256
                                || record.kind != plan.kind
                                || record.removal
                                || record.state == LocalState::Unsupported;
                            if restart {
                                // A new version (always installed again; the old package stays in the store, still
                                // Rulebox's to remove), a re-assignment, or an entry that became usable.
                                if record.sha256 != plan.sha256 || record.kind != plan.kind {
                                    doomed.push(record.file_name());
                                }
                                let packages = std::mem::take(&mut record.packages);
                                *record = DriverRecord::new(&spec.id, plan.kind, &plan.sha256, spec.revision, LocalState::Pending);
                                record.packages = packages;
                                out.extend(record.mark());
                                continue;
                            }
                            if record.revision != spec.revision {
                                record.revision = spec.revision;
                                if record.state == LocalState::Failed {
                                    // Retry: a new revision starts the attempts again.
                                    record.state = LocalState::Pending;
                                    record.attempts = 0;
                                    record.next_try_ms = 0;
                                    record.detail = None;
                                    record.last_exit_code = None;
                                }
                                out.extend(record.mark());
                            }
                        }
                    },
                }
            }
            // Drivers that left the document.
            let gone: Vec<String> = file.drivers.keys().filter(|id| !wanted.contains(*id)).cloned().collect();
            for id in gone {
                let Some(record) = file.drivers.get_mut(&id) else { continue };
                if record.removal {
                    // A removal that already runs or finished stays until it is acknowledged; one with nothing of
                    // Rulebox's to remove is dropped.
                    if record.packages.is_empty() && record.state != LocalState::Removed {
                        file.drivers.remove(&id);
                    }
                    continue;
                }
                if record.kind == DriverRecordKind::Inf && !record.packages.is_empty() {
                    tracing::info!(driver_id = %id, "unassigned; its Rulebox-installed package(s) will be removed");
                    record.removal = true;
                    record.state = LocalState::Removing;
                    record.attempts = 0;
                    record.next_try_ms = 0;
                    record.detail = None;
                    record.last_exit_code = None;
                } else {
                    tracing::info!(driver_id = %id, "unassigned; nothing of it is removed");
                    doomed.push(record.file_name());
                    file.drivers.remove(&id);
                }
            }
            (out, doomed)
        });
        for name in doomed {
            self.delete_download(&name);
        }
        self.push(reports);
    }

    pub(super) async fn run_driver_job(&self, id: &str, removal: bool, policy: &AgentPolicy, shutdown: &CancellationToken) {
        let roots = match self.deps.platform.path_roots() {
            Ok(roots) => roots,
            Err(error) => {
                tracing::warn!("cannot read the program folders ({error})");
                return self.finish_driver(id, Outcome::Wait);
            }
        };
        let outcome = if removal {
            let Some(record) = self.deps.book.snapshot().drivers.get(id).cloned() else { return };
            self.remove_driver(&record).await
        } else {
            let plan = policy.drivers.iter().find(|d| d.id == id).map(|d| check_driver(d, roots.system_root.as_deref()));
            let Some(Ok(plan)) = plan else {
                return self.finish_driver(id, Outcome::Wait);
            };
            self.install_driver(id, &plan, &roots, shutdown).await
        };
        self.finish_driver(id, outcome);
        // (Step 20) A printer of the document may have been waiting for this driver.
        (self.deps.on_driver_change)();
    }

    async fn install_driver(&self, id: &str, plan: &DriverPlan, roots: &PathRoots, shutdown: &CancellationToken) -> Outcome {
        self.set_driver_state(id, LocalState::Downloading);
        let file = DownloadFile { url: &plan.url, sha256: &plan.sha256, size_bytes: plan.size_bytes, ext: plan.kind.ext(), cap: MAX_DOWNLOAD_BYTES };
        let dest = match self.download_file(id, &file, shutdown).await {
            Ok(dest) => dest,
            Err(Some(detail)) => return Outcome::Failed { detail: Some(detail), exit_code: None },
            Err(None) => return Outcome::Abandoned,
        };
        self.set_driver_state(id, LocalState::Installing);
        let verified = match open_verified(&dest, &plan.sha256) {
            Ok(verified) => verified,
            Err(FileCheckError::Mismatch | FileCheckError::NotPlain) => {
                tracing::error!(driver_id = id, "the driver file changed after its download; deleted, nothing ran");
                let _ = remove_file_if_exists(&dest);
                return Outcome::Failed { detail: Some(Detail::HashMismatch), exit_code: None };
            }
            Err(FileCheckError::Io(error)) => {
                tracing::error!(driver_id = id, "cannot open the driver file: {error}");
                return Outcome::Failed { detail: Some(Detail::DownloadFailed), exit_code: None };
            }
        };
        let Some(system_root) = roots.system_root.as_deref().map(PathBuf::from) else {
            return Outcome::Failed { detail: Some(Detail::Unsupported), exit_code: None };
        };
        let downloads = self.deps.paths.downloads_dir();
        tracing::info!(driver_id = id, kind = ?plan.kind, "installing a driver");
        let mut before: Option<Vec<String>> = None;
        // (Step 15) A warning that rides on the `installed` result (`seagull_driver_present`).
        let warning: Option<Detail>;
        let ran = match plan.kind {
            DriverRecordKind::Inf => {
                let work = self.deps.paths.driver_work_dir(&plan.sha256);
                let inf_rel = plan.inf.clone().unwrap_or_default();
                let platform = Arc::clone(&self.deps.platform);
                let (zip, folder) = (verified.path().to_path_buf(), work.clone());
                let prepared = tokio::task::spawn_blocking(move || prepare_inf_package(platform.as_ref(), &zip, &folder, &inf_rel))
                    .await
                    .unwrap_or(Err(Detail::BadPackage));
                let PreparedInf { inf, facts } = match prepared {
                    Ok(prepared) => prepared,
                    Err(detail) => {
                        // The zip itself was the one the administrator uploaded and is no use: it goes.
                        drop(verified);
                        let _ = remove_file_if_exists(&dest);
                        return Outcome::Failed { detail: Some(detail), exit_code: None };
                    }
                };
                // Windows protected print mode removes printers that use a third-party driver: a printer driver is not
                // installed while it is on. The zip is kept (it is fine; the mode may be switched off before the retry).
                if protected_print_refuses(self.deps.platform.as_ref(), facts.printer_class) {
                    tracing::warn!(driver_id = id, "protected print mode is on; the printer driver is not installed");
                    remove_tree(&work);
                    return Outcome::Failed { detail: Some(Detail::ProtectedPrintOn), exit_code: None };
                }
                warning = seagull_warning(self.deps.platform.as_ref(), facts.seagull_based || has_seagull_marker(&plan.name));
                match self.deps.platform.driver_store_infs() {
                    Ok(list) => before = Some(list),
                    Err(error) => tracing::warn!("cannot read the driver store ({error}); a new package cannot be told apart"),
                }
                let cmd = pnputil_add_command(&system_root, &inf, &work);
                let ran = self.run_installer(cmd, shutdown).await;
                remove_tree(&work);
                ran
            }
            // A vendor exe or msi is opaque: only the driver's name in the document can say it is Seagull-based, and
            // whether it is a printer driver at all is unknown (so protected print mode never refuses it).
            DriverRecordKind::Exe => {
                warning = seagull_warning(self.deps.platform.as_ref(), has_seagull_marker(&plan.name));
                self.run_installer(exe_driver_command(verified.path(), &plan.silent_args, &downloads), shutdown).await
            }
            DriverRecordKind::Msi => {
                warning = seagull_warning(self.deps.platform.as_ref(), has_seagull_marker(&plan.name));
                self.prune_msi_logs();
                let _ = std::fs::create_dir_all(self.deps.paths.logs_dir());
                let log = self.deps.paths.install_log(&format!("drv-{id}"));
                self.run_installer(msi_driver_command(&system_root, verified.path(), &log, &downloads), shutdown).await
            }
        };
        // Held until the installer and everything it started are gone.
        drop(verified);
        match ran {
            Err(PlatformError::InUse) => Outcome::Busy { exit_code: None },
            Err(error) => {
                tracing::error!(driver_id = id, "the driver installer did not run: {error}");
                Outcome::Failed { detail: None, exit_code: None }
            }
            Ok(InstallerExit::Cancelled) => Outcome::Interrupted,
            // (Step 14) A driver's installer that stalled is a timeout for now; `needs_interaction` is for apps.
            Ok(InstallerExit::TimedOut | InstallerExit::Stalled) => {
                tracing::warn!(driver_id = id, "the driver installer did not finish in time and was stopped");
                Outcome::Failed { detail: Some(Detail::Timeout), exit_code: None }
            }
            // pnputil and msiexec speak MSI exit codes (3010 restart); a vendor exe only what its entry lists.
            Ok(InstallerExit::Code(code)) => match judge_install(plan.kind != DriverRecordKind::Exe, &plan.success_exit_codes, code) {
                ExitVerdict::Busy => Outcome::Busy { exit_code: Some(i64::from(code)) },
                ExitVerdict::Failure => {
                    tracing::warn!(driver_id = id, code, "the driver installer failed");
                    Outcome::Failed { detail: Some(Detail::ExitCode), exit_code: Some(i64::from(code)) }
                }
                ExitVerdict::Success { restart } => {
                    if restart {
                        self.note_restart();
                    }
                    if plan.kind == DriverRecordKind::Inf {
                        self.record_published(id, before.as_deref(), roots);
                    }
                    let _ = remove_file_if_exists(&dest);
                    Outcome::Installed { exit_code: code, warning }
                }
            },
        }
    }

    /// The package(s) `pnputil` just added: the names that are in the store now and were not before. Each goes into the
    /// journal first (a restore of everything removes it), then into the record.
    fn record_published(&self, id: &str, before: Option<&[String]>, roots: &PathRoots) {
        let (Some(before), Some(system_root)) = (before, roots.system_root.as_deref()) else { return };
        let after = match self.deps.platform.driver_store_infs() {
            Ok(list) => list,
            Err(error) => {
                tracing::warn!("cannot read the driver store ({error}); the package stays unrecorded and is never removed");
                return;
            }
        };
        for name in after.iter().filter(|name| !before.contains(name)) {
            let file = Path::new(system_root).join("INF").join(name);
            let sha = match self.deps.platform.file_sha256(&file, MAX_PUBLISHED_INF_BYTES) {
                Ok(Some(sha)) => sha,
                _ => {
                    tracing::warn!("cannot hash a package that was just published; it stays unrecorded and is never removed");
                    continue;
                }
            };
            let ctx = JournalCtx { platform: self.deps.platform.as_ref(), shared: self.deps.shared.as_ref() };
            if let Err(error) = journal::record_driver_package(&ctx, id, name, &sha, 0) {
                tracing::error!("cannot journal a published driver package ({error}); it is never removed");
                continue;
            }
            self.deps.book.update(|file| {
                if let Some(record) = file.drivers.get_mut(id) {
                    record.add_package(DriverPackage { published: name.clone(), sha256: sha.clone() });
                }
            });
        }
    }

    /// Removes the packages Rulebox published for this driver, through the journal (which deletes a package only while it
    /// is still the file Rulebox published). A driver with nothing of Rulebox's is just forgotten.
    async fn remove_driver(&self, record: &DriverRecord) -> Outcome {
        if record.kind != DriverRecordKind::Inf || record.packages.is_empty() {
            return Outcome::Dropped;
        }
        tracing::info!(driver_id = %record.driver_id, "removing an unassigned driver");
        let ids: Vec<String> = record.packages.iter().map(|p| journal::driver_id(&record.driver_id, &p.published)).collect();
        let (platform, shared) = (Arc::clone(&self.deps.platform), Arc::clone(&self.deps.shared));
        let report = tokio::task::spawn_blocking(move || {
            let ctx = JournalCtx { platform: platform.as_ref(), shared: shared.as_ref() };
            journal::restore_ids(&ctx, &ids)
        })
        .await;
        match report {
            Ok(report) if report.failed.is_empty() => Outcome::Removed,
            _ => {
                tracing::error!(driver_id = %record.driver_id, "a driver package could not be removed");
                Outcome::Failed { detail: Some(Detail::RemoveFailed), exit_code: None }
            }
        }
    }

    /// Writes down how a driver operation ended (and reports it). Same rules as an app's `finish`.
    fn finish_driver(&self, id: &str, outcome: Outcome) {
        let now = self.now();
        let report = self.deps.book.update(|file| {
            if matches!(outcome, Outcome::Dropped) {
                file.drivers.remove(id);
                return None;
            }
            let record = file.drivers.get_mut(id)?;
            let wait_again = |record: &mut DriverRecord| {
                if matches!(record.state, LocalState::Downloading | LocalState::Installing) {
                    record.state = if record.removal { LocalState::Removing } else { LocalState::Pending };
                }
            };
            match outcome {
                Outcome::Installed { exit_code, warning } => {
                    tracing::info!(driver_id = id, "driver installed");
                    record.state = LocalState::Installed;
                    // A warning rides on the result (`seagull_driver_present`); it is not a failure.
                    record.detail = warning.map(|detail| detail.as_str().to_string());
                    record.last_exit_code = (exit_code != 0).then_some(i64::from(exit_code));
                    record.next_try_ms = 0;
                    record.busy_since_ms = None;
                    record.mark()
                }
                Outcome::Removed => {
                    tracing::info!(driver_id = id, "driver removed");
                    record.state = LocalState::Removed;
                    record.detail = None;
                    record.last_exit_code = None;
                    record.busy_since_ms = None;
                    record.packages.clear();
                    record.mark()
                }
                Outcome::Busy { exit_code } => {
                    let first = *record.busy_since_ms.get_or_insert(now);
                    if now.saturating_sub(first) >= ms(BUSY_WINDOW) {
                        tracing::warn!(driver_id = id, "still busy after 2 hours; counted as a failed attempt");
                        record.busy_since_ms = None;
                        let detail = if record.removal { Some(Detail::RemoveFailed) } else { exit_code.map(|_| Detail::ExitCode) };
                        record.fail(detail, exit_code, now);
                        return record.mark();
                    }
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
                    record.fail(detail, exit_code, now);
                    if record.attempts >= MAX_FAILURES {
                        tracing::warn!(driver_id = id, "giving up until the entry changes (Retry)");
                    }
                    record.mark()
                }
                Outcome::Interrupted => {
                    wait_again(record);
                    None
                }
                // (Phase 6 Step 11) What only an app's install can end in.
                Outcome::Abandoned | Outcome::Dropped | Outcome::Staged | Outcome::Deferred | Outcome::AppInstalled { .. } => None,
            }
        });
        self.push(report.into_iter().collect());
        let file = self.deps.book.snapshot();
        if let Some(record) = file.drivers.get(id) {
            if record.state == LocalState::Failed && record.attempts >= MAX_FAILURES {
                self.delete_download(&record.file_name());
            }
        }
    }
}
