//! Redirects the Windows account's Documents, Desktop and Downloads folders.
//!
//! Staff share one Windows account, but desktop apps such as Notepad save to
//! that account's known folders. At sign-in the shell points these three at
//! the employee's own folder; at sign-out (and once at start-up, in case the
//! app crashed while someone was signed in) it puts the account's defaults
//! back. The change is per user and needs no administrator rights: it only
//! rewrites `HKCU\...\User Shell Folders` through `SHSetKnownFolderPath`.
//!
//! Everything that changes anything takes `&ShellToken`, so dev mode cannot
//! reach it. What to change is decided by pure functions (`plan`,
//! `needs_change`) that the tests cover; the Win32 calls are not unit tested
//! because running them on a developer PC would change that PC's folders.

use std::ffi::OsString;
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::os::windows::fs::MetadataExt;
use std::path::{Path, PathBuf};

use windows::core::{GUID, PCWSTR};
use windows::Win32::System::Com::CoTaskMemFree;
use windows::Win32::UI::Shell::{
    FOLDERID_Desktop, FOLDERID_Documents, FOLDERID_Downloads, FOLDERID_Profile, SHChangeNotify,
    SHGetKnownFolderPath, SHSetKnownFolderPath, KNOWN_FOLDER_FLAG, SHCNE_UPDATEDIR,
    SHCNF_FLUSHNOWAIT, SHCNF_PATHW,
};

use crate::error::{DesktopError, Result};
use crate::mode::ShellToken;

/// `FILE_ATTRIBUTE_REPARSE_POINT`: a symlink or a junction.
const REPARSE_POINT: u32 = 0x400;

/// The folders that are redirected. Nothing else is ever touched.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KnownFolder {
    Documents,
    Desktop,
    Downloads,
}

/// Every redirected folder, in the order they are applied.
pub const ALL: [KnownFolder; 3] = [
    KnownFolder::Documents,
    KnownFolder::Desktop,
    KnownFolder::Downloads,
];

impl KnownFolder {
    /// The subfolder name, both inside an employee's folder and inside the
    /// Windows profile. The Files app already uses `Documents` and
    /// `Downloads` (web-app downloads land in `Downloads`), so everything
    /// ends up in one place.
    pub fn dir_name(self) -> &'static str {
        match self {
            KnownFolder::Documents => "Documents",
            KnownFolder::Desktop => "Desktop",
            KnownFolder::Downloads => "Downloads",
        }
    }

    fn id(self) -> &'static GUID {
        match self {
            KnownFolder::Documents => &FOLDERID_Documents,
            KnownFolder::Desktop => &FOLDERID_Desktop,
            KnownFolder::Downloads => &FOLDERID_Downloads,
        }
    }
}

/// One folder and where it should point.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Redirect {
    pub folder: KnownFolder,
    pub target: PathBuf,
}

/// Pure: where each folder lives under `base`. With the employee's folder
/// this is the redirect plan; with the Windows profile it is the account's
/// defaults.
pub fn plan(base: &Path) -> Vec<Redirect> {
    ALL.iter()
        .map(|folder| Redirect {
            folder: *folder,
            target: base.join(folder.dir_name()),
        })
        .collect()
}

/// Pure: the same folder, ignoring case, `/` versus `\` and a trailing slash.
pub fn same_path(a: &Path, b: &Path) -> bool {
    fn norm(path: &Path) -> String {
        let text = path.to_string_lossy().replace('/', "\\").to_lowercase();
        text.trim_end_matches('\\').to_string()
    }
    norm(a) == norm(b)
}

/// Pure: a write is needed unless the folder already points at `target`.
/// An unreadable current value counts as "needs a change".
pub fn needs_change(current: Option<&Path>, target: &Path) -> bool {
    match current {
        Some(current) => !same_path(current, target),
        None => true,
    }
}

/// What one call did, folder by folder. Failures never stop the others.
#[derive(Debug, Default)]
pub struct Report {
    /// Pointed at a new place.
    pub changed: Vec<KnownFolder>,
    /// Already pointed at the right place.
    pub unchanged: Vec<KnownFolder>,
    /// Could not be changed, with the reason.
    pub failed: Vec<(KnownFolder, String)>,
}

/// Where Windows currently says `folder` is. Read only.
pub fn current(folder: KnownFolder) -> Result<PathBuf> {
    read_known_folder("SHGetKnownFolderPath", folder.id())
}

/// The account's profile folder (`C:\Users\<name>`). Read only.
pub fn profile_dir() -> Result<PathBuf> {
    read_known_folder("SHGetKnownFolderPath(Profile)", &FOLDERID_Profile)
}

fn read_known_folder(call: &'static str, id: &GUID) -> Result<PathBuf> {
    // SAFETY: `id` points to a valid GUID for the whole call; the flags are 0
    // and no token means the current user. On success Windows hands us a
    // string it allocated, which we free below.
    let raw = unsafe { SHGetKnownFolderPath(id, KNOWN_FOLDER_FLAG(0), None) }
        .map_err(|error| DesktopError::win32(call, &error))?;
    // SAFETY: `raw` is a valid NUL-terminated wide string returned just above.
    let path = PathBuf::from(OsString::from_wide(unsafe { raw.as_wide() }));
    // SAFETY: `raw` was allocated by the shell with CoTaskMemAlloc and is not
    // used again after this.
    unsafe { CoTaskMemFree(Some(raw.0 as *const core::ffi::c_void)) };
    Ok(path)
}

/// True for a symlink or a junction (any reparse point).
fn is_reparse_point(path: &Path) -> std::io::Result<bool> {
    let meta = std::fs::symlink_metadata(path)?;
    Ok(meta.file_attributes() & REPARSE_POINT != 0)
}

/// Point one folder at `path`, then tell the shell. `path` must exist.
fn set(folder: KnownFolder, path: &Path) -> Result<()> {
    let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
    wide.push(0);
    // SAFETY: `wide` is a NUL-terminated UTF-16 string that outlives the call;
    // the id is a valid GUID; flags 0 and no token mean the current user.
    unsafe { SHSetKnownFolderPath(folder.id(), 0, None, PCWSTR(wide.as_ptr())) }
        .map_err(|error| DesktopError::win32("SHSetKnownFolderPath", &error))?;
    // SAFETY: the item is a NUL-terminated wide path that lives through the
    // call; FLUSHNOWAIT posts the notice and returns without waiting.
    unsafe {
        SHChangeNotify(
            SHCNE_UPDATEDIR,
            SHCNF_PATHW | SHCNF_FLUSHNOWAIT,
            Some(wide.as_ptr() as *const core::ffi::c_void),
            None,
        );
    }
    Ok(())
}

/// Apply a plan folder by folder. With `create_missing` a missing target is
/// created (only for the account's own profile); otherwise it must exist.
/// A target that is a symlink or junction is always refused.
fn apply(plan: &[Redirect], create_missing: bool) -> Report {
    let mut report = Report::default();
    for item in plan {
        let folder = item.folder;
        match is_reparse_point(&item.target) {
            Ok(true) => {
                report
                    .failed
                    .push((folder, "the target is a link; refused".to_string()));
                continue;
            }
            Ok(false) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && create_missing => {
                if let Err(error) = std::fs::create_dir_all(&item.target) {
                    report.failed.push((folder, format!("create the folder: {error}")));
                    continue;
                }
            }
            Err(error) => {
                report.failed.push((folder, format!("check the target: {error}")));
                continue;
            }
        }
        if !item.target.is_dir() {
            report
                .failed
                .push((folder, "the target is not a folder".to_string()));
            continue;
        }
        let now = current(folder).ok();
        if !needs_change(now.as_deref(), &item.target) {
            report.unchanged.push(folder);
            continue;
        }
        match set(folder, &item.target) {
            Ok(()) => report.changed.push(folder),
            Err(error) => report.failed.push((folder, error.to_string())),
        }
    }
    report
}

/// Point Documents, Desktop and Downloads at the given plan (see `plan`).
/// The target folders must already exist and must not be links. Shell mode
/// only.
pub fn redirect(_token: &ShellToken, plan: &[Redirect]) -> Report {
    apply(plan, false)
}

/// Put the account's own Documents, Desktop and Downloads back (under the
/// profile folder), creating them if they are missing. Safe to call again
/// and again: a folder that is already at its default is left alone.
/// Shell mode only.
pub fn restore_defaults(_token: &ShellToken) -> Result<Report> {
    let profile = profile_dir()?;
    Ok(apply(&plan(&profile), true))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::expect_used)]
    use super::*;

    // These tests never call `SHSetKnownFolderPath`: running it would change
    // the folders of the PC the tests run on.

    #[test]
    fn plan_uses_the_names_the_files_app_already_has() {
        let root = Path::new(r"C:\Users\RuleboxStaff\RuleboxFiles\emp-1");
        let planned = plan(root);
        assert_eq!(
            planned,
            vec![
                Redirect {
                    folder: KnownFolder::Documents,
                    target: root.join("Documents")
                },
                Redirect {
                    folder: KnownFolder::Desktop,
                    target: root.join("Desktop")
                },
                Redirect {
                    folder: KnownFolder::Downloads,
                    target: root.join("Downloads")
                },
            ]
        );
    }

    #[test]
    fn plan_covers_each_folder_once() {
        let planned = plan(Path::new(r"D:\x"));
        for folder in ALL {
            assert_eq!(planned.iter().filter(|r| r.folder == folder).count(), 1);
        }
        assert_eq!(planned.len(), 3);
    }

    #[test]
    fn defaults_are_the_same_plan_over_the_profile() {
        let profile = Path::new(r"C:\Users\RuleboxStaff");
        let defaults = plan(profile);
        assert_eq!(defaults[0].target, Path::new(r"C:\Users\RuleboxStaff\Documents"));
        assert_eq!(defaults[1].target, Path::new(r"C:\Users\RuleboxStaff\Desktop"));
        assert_eq!(defaults[2].target, Path::new(r"C:\Users\RuleboxStaff\Downloads"));
    }

    #[test]
    fn same_path_ignores_case_slashes_and_a_trailing_slash() {
        assert!(same_path(
            Path::new(r"C:\Users\Staff\Documents"),
            Path::new("c:/users/staff/DOCUMENTS/")
        ));
        assert!(!same_path(
            Path::new(r"C:\Users\Staff\Documents"),
            Path::new(r"C:\Users\Staff\Documents2")
        ));
        assert!(!same_path(
            Path::new(r"C:\Users\Staff\Documents"),
            Path::new(r"D:\Users\Staff\Documents")
        ));
    }

    #[test]
    fn needs_change_is_false_when_already_there() {
        let target = Path::new(r"C:\Users\Staff\Desktop");
        assert!(!needs_change(Some(Path::new(r"c:\users\staff\desktop\")), target));
        assert!(needs_change(Some(Path::new(r"C:\Other")), target));
        assert!(needs_change(None, target));
    }

    #[test]
    fn reading_is_allowed_and_returns_absolute_paths() {
        // Read only: asks Windows where the folders are today.
        let profile = profile_dir().expect("profile folder");
        assert!(profile.is_absolute());
        for folder in ALL {
            let path = current(folder).expect("known folder");
            assert!(path.is_absolute(), "{folder:?} -> {path:?}");
        }
    }

    #[test]
    fn a_link_target_is_refused_before_anything_is_written() {
        // `apply` checks the target first, so no Win32 write is reached.
        let base = std::env::temp_dir().join(format!("rb-kf-link-{}", std::process::id()));
        let real = base.join("real");
        let link = base.join("link");
        std::fs::create_dir_all(&real).expect("make real");
        let made = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(&real)
            .output()
            .map(|out| out.status.success())
            .unwrap_or(false);
        if made {
            let report = apply(
                &[Redirect {
                    folder: KnownFolder::Documents,
                    target: link.clone(),
                }],
                false,
            );
            assert_eq!(report.failed.len(), 1);
            assert!(report.changed.is_empty() && report.unchanged.is_empty());
            let _ = std::fs::remove_dir(&link);
        }
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_missing_target_is_refused_without_create_missing() {
        let missing = std::env::temp_dir().join(format!("rb-kf-missing-{}", std::process::id()));
        let report = apply(
            &[Redirect {
                folder: KnownFolder::Desktop,
                target: missing,
            }],
            false,
        );
        assert_eq!(report.failed.len(), 1);
        assert!(report.changed.is_empty());
    }
}
