//! `rulebox-agent purge-data` (Phase 6 Step 22 run A3, Q-A6, owner-approved 2026-11-28): what an uninstall leaves behind.
//!
//! The MSI runs it **only at a real uninstall** (`REMOVE="ALL" AND NOT UPGRADINGPRODUCTCODE`, never in a major upgrade) after the
//! service has stopped and before the agent's files are removed. It deletes **everything in `C:\ProgramData\Rulebox` except
//! `logs\`**: `state\` (including `secrets.bin`, the roster, the journal), `downloads\`, `selfupdate\`, `installer-temp\`, `icons\`,
//! `drivers\` and any file next to them. The logs stay (the owner kept "logs stay", Q-A2).
//!
//! It does nothing the kiosk's own undo does not already do first: the uninstall guard (`Checks.wxs`) refuses while the kiosk is
//! on, and `unenroll --remove-staff-account` has already told the backend and restored the PC. A folder that cannot be removed
//! (a file still open) is reported and the rest goes on; the MSI ignores the result, like the unenroll action.
//!
//! Like `recover`, it works only on an armed machine and an elevated prompt, and it never follows a link: a reparse point inside
//! the data directory is removed as a link, never entered, and a data directory that is itself a link or not protected as
//! expected is refused (nothing is deleted).

use std::io::Write;
use std::path::Path;

use rulebox_win32::security::DirCheck;

use crate::paths::DataPaths;
use crate::state::unix_ms;

/// The one entry of the data directory that stays (compared without case).
pub const KEEP: &str = "logs";
/// The line the purge leaves in the kept logs, for the administrator (and the VM run).
pub const LOG_FILE: &str = "purge-data.log";

/// What a purge did, by entry name (never a file name below one).
#[derive(Debug, Default, PartialEq, Eq)]
pub struct PurgeReport {
    pub removed: Vec<String>,
    pub kept: Vec<String>,
    /// Entries that could not be removed, with the reason.
    pub failed: Vec<String>,
}

/// Deletes every direct child of the data directory except `logs`. A child that is a link goes as a link (the target is never
/// entered). One failing child never stops the others.
pub fn purge(paths: &DataPaths) -> std::io::Result<PurgeReport> {
    let mut report = PurgeReport::default();
    for entry in std::fs::read_dir(paths.root())? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.eq_ignore_ascii_case(KEEP) {
            report.kept.push(name);
            continue;
        }
        let path = entry.path();
        let result = match entry.file_type() {
            // `remove_dir_all` removes a symlink or junction itself and never follows it.
            Ok(kind) if kind.is_dir() || kind.is_symlink() && path.is_dir() => std::fs::remove_dir_all(&path),
            Ok(_) => std::fs::remove_file(&path),
            Err(error) => Err(error),
        };
        match result {
            Ok(()) => report.removed.push(name),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => report.removed.push(name),
            Err(error) => report.failed.push(format!("{name}: {error}")),
        }
    }
    report.removed.sort();
    report.kept.sort();
    report.failed.sort();
    Ok(report)
}

/// `purge-data`. Returns the exit code (0 = everything but the logs is gone, or there was nothing to remove).
pub fn run_purge_data(out: &mut dyn Write, err: &mut dyn Write) -> u8 {
    let paths = match DataPaths::from_known_folders() {
        Ok(paths) => paths,
        Err(error) => {
            let _ = writeln!(err, "error: {error:#}");
            return crate::ipc_admin::EXIT_ERROR;
        }
    };
    // The guard first: on a machine that is not armed nothing is read or deleted.
    if let Err(error) = crate::service::guard_armed("purge-data") {
        let _ = writeln!(err, "error: {error:#}");
        return crate::ipc_admin::EXIT_ERROR;
    }
    match rulebox_win32::security::process_is_elevated() {
        Ok(true) => {}
        Ok(false) => {
            let _ = writeln!(err, "error: run `purge-data` from an elevated (Run as administrator) prompt.");
            return crate::ipc_admin::EXIT_ERROR;
        }
        Err(error) => {
            let _ = writeln!(err, "error: cannot tell whether this prompt is elevated: {error}");
            return crate::ipc_admin::EXIT_ERROR;
        }
    }
    run_purge_data_at(&paths, &rulebox_win32::security::verify_protected_dir, out, err)
}

/// [`run_purge_data`] on an explicit folder with an explicit directory check (the tests use temporary ones).
pub fn run_purge_data_at(
    paths: &DataPaths,
    verify: &dyn Fn(&Path) -> rulebox_win32::Result<DirCheck>,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> u8 {
    let check = match verify(paths.root()) {
        Ok(check) => check,
        Err(error) => {
            let _ = writeln!(err, "error: the data directory could not be checked ({error}); nothing was deleted.");
            return crate::ipc_admin::EXIT_ERROR;
        }
    };
    if !check.exists {
        let _ = writeln!(out, "There is no Rulebox data directory; nothing to remove.");
        return 0;
    }
    if let Some(problem) = crate::recover::dir_problem(&check) {
        let _ = writeln!(err, "error: the data directory is not used ({problem}); nothing was deleted.");
        return crate::ipc_admin::EXIT_ERROR;
    }
    let report = match purge(paths) {
        Ok(report) => report,
        Err(error) => {
            let _ = writeln!(err, "error: cannot read the data directory: {error}; nothing was deleted.");
            return crate::ipc_admin::EXIT_ERROR;
        }
    };
    let _ = writeln!(out, "Removed from the Rulebox data directory: {}.", list(&report.removed));
    let _ = writeln!(out, "Kept: {}.", list(&report.kept));
    for line in &report.failed {
        let _ = writeln!(err, "could not remove {line}");
    }
    note_in_logs(paths, &report);
    if report.failed.is_empty() {
        0
    } else {
        crate::ipc_admin::EXIT_ERROR
    }
}

fn list(names: &[String]) -> String {
    if names.is_empty() {
        "nothing".to_string()
    } else {
        names.join(", ")
    }
}

/// One line in the kept logs (best effort: the uninstall must not depend on it).
fn note_in_logs(paths: &DataPaths, report: &PurgeReport) {
    let line = format!(
        "[{}] purge-data: removed [{}], kept [{}], failed [{}]\r\n",
        unix_ms(),
        list(&report.removed),
        list(&report.kept),
        list(&report.failed)
    );
    let write = std::fs::create_dir_all(paths.logs_dir()).and_then(|()| {
        std::fs::OpenOptions::new().create(true).append(true).open(paths.logs_dir().join(LOG_FILE)).and_then(|mut file| file.write_all(line.as_bytes()))
    });
    if let Err(error) = write {
        tracing::warn!("cannot write the purge note into the logs: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use rulebox_win32::sid::Sid;

    use crate::testutil::TempDir;

    fn ok_dir() -> DirCheck {
        DirCheck { exists: true, is_reparse_point: false, owner: Some(Sid::system()), dacl_matches: true }
    }

    /// A data directory like a PC that ran Rulebox for a while.
    fn used_data_dir() -> (TempDir, DataPaths) {
        let dir = TempDir::new();
        let paths = DataPaths::new(dir.path().join("Rulebox"));
        for sub in ["state", "downloads", "selfupdate", "installer-temp", "icons", "drivers/work/abc", "logs"] {
            std::fs::create_dir_all(paths.root().join(sub)).unwrap();
        }
        for file in [
            "state/secrets.bin",
            "state/agent-state.json",
            "state/recovered.flag",
            "downloads/abc.msi",
            "downloads/def.exe.part",
            "selfupdate/x.msi",
            "drivers/work/abc/one.inf",
            "logs/agent.log",
            "logs/selfupdate-msi.log",
            "loose.txt",
        ] {
            std::fs::write(paths.root().join(file), b"x").unwrap();
        }
        (dir, paths)
    }

    fn names(paths: &DataPaths) -> Vec<String> {
        let mut found: Vec<String> =
            std::fs::read_dir(paths.root()).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        found.sort();
        found
    }

    #[test]
    fn everything_but_the_logs_goes_state_secrets_and_downloads_included() {
        let (_dir, paths) = used_data_dir();
        let report = purge(&paths).unwrap();
        assert_eq!(names(&paths), ["logs"]);
        assert_eq!(report.kept, ["logs"]);
        assert!(report.failed.is_empty());
        assert_eq!(report.removed, ["downloads", "drivers", "icons", "installer-temp", "loose.txt", "selfupdate", "state"]);
        assert!(!paths.secrets().exists() && !paths.downloads_dir().exists() && !paths.state_dir().exists());
        // The logs keep their contents.
        assert!(paths.logs_dir().join("agent.log").is_file() && paths.logs_dir().join("selfupdate-msi.log").is_file());
    }

    #[test]
    fn the_logs_folder_is_matched_without_case_and_a_second_run_finds_nothing_to_do() {
        let (_dir, paths) = used_data_dir();
        std::fs::rename(paths.root().join("logs"), paths.root().join("Logs")).unwrap();
        purge(&paths).unwrap();
        assert_eq!(names(&paths), ["Logs"]);
        let again = purge(&paths).unwrap();
        assert!(again.removed.is_empty() && again.failed.is_empty());
        assert_eq!(names(&paths), ["Logs"]);
    }

    #[test]
    fn an_open_file_is_reported_and_the_rest_still_goes() {
        let (_dir, paths) = used_data_dir();
        // A file that is open without delete sharing cannot be removed on Windows; elsewhere nothing blocks it, so the
        // test only asserts what must hold on both: the rest went, and the failure (if any) names the entry.
        let held = std::fs::File::open(paths.downloads_dir().join("abc.msi")).unwrap();
        let report = purge(&paths).unwrap();
        drop(held);
        assert!(!paths.state_dir().exists() && paths.logs_dir().is_dir());
        for line in &report.failed {
            assert!(line.starts_with("downloads: "), "{line}");
        }
    }

    #[test]
    fn the_command_prints_what_went_and_writes_one_line_into_the_kept_logs() {
        let (_dir, paths) = used_data_dir();
        let (mut out, mut err) = (Vec::new(), Vec::new());
        assert_eq!(run_purge_data_at(&paths, &|_| Ok(ok_dir()), &mut out, &mut err), 0);
        let out = String::from_utf8(out).unwrap();
        assert!(out.contains("Removed from the Rulebox data directory: downloads, drivers"), "{out}");
        assert!(out.contains("Kept: logs."), "{out}");
        assert!(err.is_empty());
        assert_eq!(names(&paths), ["logs"]);
        let note = std::fs::read_to_string(paths.logs_dir().join(LOG_FILE)).unwrap();
        assert!(note.contains("purge-data: removed [downloads, drivers"), "{note}");
        assert!(paths.logs_dir().join("agent.log").is_file());
    }

    #[test]
    fn a_data_directory_that_is_not_ours_or_cannot_be_checked_is_never_touched() {
        let (_dir, paths) = used_data_dir();
        let before = names(&paths);
        let link = DirCheck { is_reparse_point: true, ..ok_dir() };
        let unprotected = DirCheck { dacl_matches: false, ..ok_dir() };
        for check in [link, unprotected] {
            let (mut out, mut err) = (Vec::new(), Vec::new());
            assert_eq!(run_purge_data_at(&paths, &|_| Ok(check.clone()), &mut out, &mut err), crate::ipc_admin::EXIT_ERROR);
            assert!(String::from_utf8(err).unwrap().contains("nothing was deleted"));
        }
        let (mut out, mut err) = (Vec::new(), Vec::new());
        let failing = |_: &Path| -> rulebox_win32::Result<DirCheck> { Err(rulebox_win32::Win32Error::Invalid("no access".into())) };
        assert_eq!(run_purge_data_at(&paths, &failing, &mut out, &mut err), crate::ipc_admin::EXIT_ERROR);
        assert_eq!(names(&paths), before);
        assert!(paths.secrets().is_file());
    }

    #[test]
    fn a_missing_data_directory_is_nothing_to_do() {
        let dir = TempDir::new();
        let paths = DataPaths::new(dir.path().join("Rulebox"));
        let (mut out, mut err) = (Vec::new(), Vec::new());
        let missing = DirCheck { exists: false, ..ok_dir() };
        assert_eq!(run_purge_data_at(&paths, &|_| Ok(missing.clone()), &mut out, &mut err), 0);
        assert!(String::from_utf8(out).unwrap().contains("nothing to remove"));
        assert!(!paths.root().exists(), "it never creates the directory");
    }
}
