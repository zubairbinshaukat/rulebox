//! The machine guard. Everything in this crate that changes the machine calls
//! `require_armed_machine()` first (plan Phase 6, Section 4.11). There are exactly
//! two doors, and no third: no environment variable, no command-line switch, no
//! flag, and no cargo feature that opens the guard by itself.
//!
//! 1. **The test-machine door** (dev and VM builds, as in Phase 2): the value
//!    `HKLM\SOFTWARE\Rulebox\TestMachine\ComputerName` names this computer. The
//!    marker is created only by the user, by hand, on a VM. `require_test_machine()`
//!    and `is_test_machine()` check this door alone; they are for test-only helpers
//!    (demo employees, simulate flags, crash triggers), never for production.
//! 2. **The production door** (an installed release): all of these hold at once.
//!    The crate was built with the cargo feature `production` (turned on only by the
//!    release workflow); it is not a debug build; `HKLM\SOFTWARE\Rulebox\Install`
//!    exists and its `InstallDir` is the folder of the running exe; that folder is
//!    admin-only (its DACL is the install or protected DACL, owned by SYSTEM or
//!    Administrators, not a reparse point); and the `ComputerName` the agent wrote
//!    into the install marker is this computer. A copy of the exe in another folder
//!    fails the `InstallDir` condition.
//!
//! This module only ever reads: it never creates either marker. The decision is a
//! pure function ([`evaluate`]) over [`Inputs`], so every branch is unit-tested
//! without touching the machine. Every read that fails counts as "not met": the
//! guard fails closed.

use std::path::Path;

use windows::core::PCWSTR;
use windows::Win32::Foundation::ERROR_SUCCESS;
use windows::Win32::System::Registry::{
    RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ, RRF_SUBKEY_WOW6464KEY,
};

use crate::error::{Result, Win32Error};
use crate::security::{same_dacl, INSTALL_DIR_SDDL, PROTECTED_DIR_SDDL};
use crate::sid::Sid;
use crate::util::to_wide;

pub const MARKER_KEY: &str = r"SOFTWARE\Rulebox\TestMachine";
pub const MARKER_VALUE: &str = "ComputerName";

/// The install marker, written by the MSI (`InstallDir`, `Version`) and completed by
/// the agent at its first start (`ComputerName`).
pub const INSTALL_KEY: &str = r"SOFTWARE\Rulebox\Install";
pub const INSTALL_DIR_VALUE: &str = "InstallDir";
pub const INSTALL_COMPUTER_VALUE: &str = "ComputerName";

/// True when this crate was built with the cargo feature `production`.
pub const PRODUCTION_FEATURE: bool = cfg!(feature = "production");
/// True in a debug build (`debug_assertions`).
pub const DEBUG_BUILD: bool = cfg!(debug_assertions);

/// Which door opened the guard.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Door {
    /// The test-machine marker names this computer.
    TestMarker,
    /// An installed release build: all six production conditions hold.
    Production,
}

/// One condition of a door: what was checked, whether it holds, and why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Condition {
    pub name: &'static str,
    pub met: bool,
    pub detail: String,
}

/// The outcome of the guard: which door opened it (if any) and every condition of both.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Evaluation {
    pub door: Option<Door>,
    pub test_door: Vec<Condition>,
    pub production_door: Vec<Condition>,
}

/// A value that was read from the machine, or why it could not be.
pub type Read<T> = std::result::Result<T, String>;

/// Everything the decision needs, read in advance. Tests build these by hand.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Inputs {
    pub computer: Read<String>,
    pub test_marker: Read<String>,
    pub production_feature: bool,
    pub debug_build: bool,
    pub install_dir: Read<String>,
    pub install_computer: Read<String>,
    /// The folder of the running exe.
    pub exe_dir: Read<String>,
    /// The install folder is admin-only (see [`folder_is_admin_only`]).
    pub folder_admin_only: Read<bool>,
}

/// Ok when one of the two doors is open. Read-only. Never creates a marker.
pub fn require_armed_machine() -> Result<()> {
    let evaluation = evaluate(&read_inputs(false));
    if evaluation.door.is_some() {
        return Ok(());
    }
    Err(Win32Error::Guard(evaluation.refusal()))
}

pub fn is_armed_machine() -> bool {
    require_armed_machine().is_ok()
}

/// Ok only if `HKLM\SOFTWARE\Rulebox\TestMachine\ComputerName` (REG_SZ) equals
/// this computer's name (case-insensitive). Read-only. Never creates the marker.
/// For test-only helpers; mutating functions use [`require_armed_machine`].
pub fn require_test_machine() -> Result<()> {
    let marker = read_sz(MARKER_KEY, MARKER_VALUE, "the test-machine marker")?;
    let computer = computer_name()?;
    if marker_matches(&marker, &computer) {
        Ok(())
    } else {
        Err(Win32Error::Guard(format!(
            "the marker names a different computer ({marker:?}, this one is {computer:?})"
        )))
    }
}

pub fn is_test_machine() -> bool {
    require_test_machine().is_ok()
}

/// Reads everything and evaluates both doors, for `rulebox-agent guard-status`.
pub fn inspect() -> Evaluation {
    evaluate(&read_inputs(true))
}

impl Evaluation {
    /// One line that says why the guard refused: the failed condition of each door.
    pub fn refusal(&self) -> String {
        let first = |conditions: &[Condition]| {
            conditions.iter().find(|c| !c.met).map(|c| format!("{}: {}", c.name, c.detail)).unwrap_or_default()
        };
        format!(
            "this machine is not armed (test door: {}; production door: {})",
            first(&self.test_door),
            first(&self.production_door)
        )
    }
}

fn condition(name: &'static str, met: bool, detail: impl Into<String>) -> Condition {
    Condition { name, met, detail: detail.into() }
}

/// The decision. Pure: nothing is read here.
pub fn evaluate(inputs: &Inputs) -> Evaluation {
    // Test door.
    let test_marker = match (&inputs.test_marker, &inputs.computer) {
        (Ok(marker), Ok(computer)) if marker_matches(marker, computer) => {
            condition("test_marker", true, format!("the marker names this computer ({computer})"))
        }
        (Ok(marker), Ok(computer)) => {
            condition("test_marker", false, format!("the marker names a different computer ({marker:?}, this one is {computer:?})"))
        }
        (Err(why), _) | (_, Err(why)) => condition("test_marker", false, why.clone()),
    };

    // Production door.
    let feature = condition(
        "production_feature",
        inputs.production_feature,
        if inputs.production_feature { "built with the cargo feature `production`" } else { "not built with the cargo feature `production`" },
    );
    let release = condition(
        "release_build",
        !inputs.debug_build,
        if inputs.debug_build { "this is a debug build" } else { "this is a release build" },
    );
    let marker = match &inputs.install_dir {
        Ok(dir) if !dir.trim().is_empty() => condition("install_marker", true, format!("InstallDir is {dir}")),
        Ok(_) => condition("install_marker", false, "InstallDir is empty"),
        Err(why) => condition("install_marker", false, why.clone()),
    };
    let folder = match (&inputs.install_dir, &inputs.exe_dir) {
        (Ok(install), Ok(exe)) if same_folder(install, exe) => {
            condition("install_dir_is_exe_folder", true, format!("the exe runs from {exe}"))
        }
        (Ok(install), Ok(exe)) => condition(
            "install_dir_is_exe_folder",
            false,
            format!("InstallDir is {install:?} but the exe runs from {exe:?}"),
        ),
        (Err(why), _) | (_, Err(why)) => condition("install_dir_is_exe_folder", false, why.clone()),
    };
    let admin_only = match &inputs.folder_admin_only {
        Ok(true) => condition("install_folder_admin_only", true, "only SYSTEM and Administrators can change the folder"),
        Ok(false) => condition("install_folder_admin_only", false, "the folder can be changed by other accounts, or is not owned by SYSTEM or Administrators"),
        Err(why) => condition("install_folder_admin_only", false, why.clone()),
    };
    let computer = match (&inputs.install_computer, &inputs.computer) {
        (Ok(marker), Ok(computer)) if marker_matches(marker, computer) => {
            condition("install_computer_matches", true, format!("the install marker names this computer ({computer})"))
        }
        (Ok(marker), Ok(computer)) => condition(
            "install_computer_matches",
            false,
            format!("the install marker names a different computer ({marker:?}, this one is {computer:?})"),
        ),
        (Err(why), _) | (_, Err(why)) => condition("install_computer_matches", false, why.clone()),
    };

    let test_door = vec![test_marker];
    let production_door = vec![feature, release, marker, folder, admin_only, computer];
    let door = if test_door.iter().all(|c| c.met) {
        Some(Door::TestMarker)
    } else if production_door.iter().all(|c| c.met) {
        Some(Door::Production)
    } else {
        None
    };
    Evaluation { door, test_door, production_door }
}

/// Case-insensitive comparison; an empty marker never matches.
fn marker_matches(marker: &str, computer: &str) -> bool {
    !marker.is_empty() && marker.to_uppercase() == computer.to_uppercase()
}

/// `\\?\C:\x` becomes `C:\x`; a `\\?\UNC\` path is left alone (it is never a local folder).
fn strip_verbatim(path: &str) -> &str {
    if path.starts_with(r"\\?\UNC\") {
        path
    } else {
        path.strip_prefix(r"\\?\").unwrap_or(path)
    }
}

/// Whether two folder paths name the same folder: case-insensitive, `/` as `\`, no
/// trailing separator, no `\\?\` prefix. Empty never matches. No API call.
pub fn same_folder(a: &str, b: &str) -> bool {
    fn norm(path: &str) -> String {
        strip_verbatim(path.trim()).replace('/', "\\").trim_end_matches('\\').to_uppercase()
    }
    let (a, b) = (norm(a), norm(b));
    !a.is_empty() && a == b
}

/// The folder's DACL is the install DACL or the protected DACL, and the folder exists,
/// is no reparse point and is owned by SYSTEM or Administrators. No API call.
pub fn folder_is_admin_only(exists: bool, reparse_point: bool, owner_is_admin: bool, dacl_sddl: &str) -> bool {
    exists
        && !reparse_point
        && owner_is_admin
        && (same_dacl(dacl_sddl, INSTALL_DIR_SDDL) || same_dacl(dacl_sddl, PROTECTED_DIR_SDDL))
}

fn guard_err(what: &str, code: u32) -> Win32Error {
    Win32Error::Guard(format!("{what} (Win32 error {code})"))
}

/// The NetBIOS name, the same value as `$env:COMPUTERNAME`. Any failure is a guard error.
fn computer_name() -> Result<String> {
    crate::osinfo::computer_name()
        .map_err(|e| guard_err("could not read the computer name", e.code().unwrap_or(0)))
}

/// Reads the inputs. The install facts are read only when `full` is set (guard-status) or
/// when this build has a production door at all; otherwise they are reported as not read.
fn read_inputs(full: bool) -> Inputs {
    let guard_text = |e: Win32Error| match e {
        Win32Error::Guard(message) => message,
        other => other.to_string(),
    };
    let production_door_exists = PRODUCTION_FEATURE && !DEBUG_BUILD;
    let read_install = full || production_door_exists;
    let skipped = || -> Read<String> { Err("not read: this build has no production door".into()) };

    let (install_dir, install_computer, exe_dir, folder_admin_only) = if read_install {
        let install_dir = read_sz(INSTALL_KEY, INSTALL_DIR_VALUE, "the install marker").map_err(guard_text);
        let install_computer = read_sz(INSTALL_KEY, INSTALL_COMPUTER_VALUE, "the install marker").map_err(guard_text);
        let exe_dir = running_exe_folder();
        // The folder to judge is the one the running exe is in, as the install marker must
        // name it too; a different one fails the `install_dir_is_exe_folder` condition.
        let folder_admin_only = match &exe_dir {
            Ok(dir) => read_folder_admin_only(dir),
            Err(why) => Err(why.clone()),
        };
        (install_dir, install_computer, exe_dir, folder_admin_only)
    } else {
        (skipped(), skipped(), skipped(), Err("not read: this build has no production door".into()))
    };

    Inputs {
        computer: computer_name().map_err(guard_text),
        test_marker: read_sz(MARKER_KEY, MARKER_VALUE, "the test-machine marker").map_err(guard_text),
        production_feature: PRODUCTION_FEATURE,
        debug_build: DEBUG_BUILD,
        install_dir,
        install_computer,
        exe_dir,
        folder_admin_only,
    }
}

/// The canonical folder of the running exe, without the `\\?\` prefix.
fn running_exe_folder() -> Read<String> {
    let exe = std::env::current_exe().map_err(|e| format!("cannot find the running exe: {e}"))?;
    let folder = exe.parent().ok_or_else(|| "the running exe has no folder".to_string())?;
    let canonical = std::fs::canonicalize(folder).map_err(|e| format!("cannot resolve the exe folder: {e}"))?;
    Ok(strip_verbatim(&canonical.to_string_lossy()).to_string())
}

fn read_folder_admin_only(folder: &str) -> Read<bool> {
    let path = Path::new(folder);
    let check = crate::security::verify_protected_dir(path).map_err(|e| format!("cannot read the folder owner: {e}"))?;
    let sddl = crate::security::get_path_dacl(path)
        .map_err(|e| format!("cannot read the folder DACL: {e}"))?
        .ok_or_else(|| "the folder does not exist".to_string())?;
    let owner_is_admin = check.owner.as_ref().is_some_and(|o| *o == Sid::system() || *o == Sid::builtin_admins());
    Ok(folder_is_admin_only(check.exists, check.is_reparse_point, owner_is_admin, &sddl))
}

/// Reads one REG_SZ value of `HKLM\<key>` (64-bit view). Any failure, including "not
/// there", is a guard error so the guard fails closed.
fn read_sz(key: &str, value: &str, what: &str) -> Result<String> {
    let key = to_wide(key);
    let value = to_wide(value);
    let flags = RRF_RT_REG_SZ | RRF_SUBKEY_WOW6464KEY;

    let mut size = 0u32;
    // SAFETY: both strings are NUL-terminated and outlive the call; a null data
    // pointer with a size out pointer only queries the required size.
    let status = unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            PCWSTR(key.as_ptr()),
            PCWSTR(value.as_ptr()),
            flags,
            None,
            None,
            Some(&mut size),
        )
    };
    if status != ERROR_SUCCESS {
        return Err(guard_err(&format!("{what} is not present"), status.0));
    }

    let mut buf = vec![0u16; (size as usize).div_ceil(2) + 1];
    let mut size = (buf.len() * 2) as u32;
    // SAFETY: `buf` holds `size` bytes; the strings are NUL-terminated.
    let status = unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            PCWSTR(key.as_ptr()),
            PCWSTR(value.as_ptr()),
            flags,
            None,
            Some(buf.as_mut_ptr().cast()),
            Some(&mut size),
        )
    };
    if status != ERROR_SUCCESS {
        return Err(guard_err(&format!("could not read {what}"), status.0));
    }
    let chars = (size as usize / 2).min(buf.len());
    let text = String::from_utf16_lossy(&buf[..chars]);
    Ok(text.trim_end_matches('\0').to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const EXE: &str = r"C:\Program Files\Rulebox";

    /// A machine that satisfies the production door completely.
    fn installed() -> Inputs {
        Inputs {
            computer: Ok("PC-01".into()),
            test_marker: Err("the test-machine marker is not present".into()),
            production_feature: true,
            debug_build: false,
            install_dir: Ok(EXE.into()),
            install_computer: Ok("pc-01".into()),
            exe_dir: Ok(EXE.into()),
            folder_admin_only: Ok(true),
        }
    }

    fn failed(inputs: &Inputs) -> Vec<&'static str> {
        evaluate(inputs).production_door.iter().filter(|c| !c.met).map(|c| c.name).collect()
    }

    #[test]
    fn marker_comparison_is_case_insensitive() {
        assert!(marker_matches("test-vm-01", "TEST-VM-01"));
        assert!(!marker_matches("TEST-VM-01", "OTHER-PC"));
        assert!(!marker_matches("", ""));
    }

    #[test]
    fn computer_name_is_readable() {
        assert!(!computer_name().unwrap().is_empty());
    }

    #[test]
    fn an_installed_release_opens_the_production_door() {
        let evaluation = evaluate(&installed());
        assert_eq!(evaluation.door, Some(Door::Production));
        assert!(evaluation.production_door.iter().all(|c| c.met));
        assert_eq!(evaluation.production_door.len(), 6);
    }

    #[test]
    fn the_test_marker_opens_the_test_door_whatever_the_build() {
        let mut inputs = installed();
        inputs.production_feature = false;
        inputs.debug_build = true;
        inputs.install_dir = Err("absent".into());
        inputs.test_marker = Ok("Pc-01".into());
        assert_eq!(evaluate(&inputs).door, Some(Door::TestMarker));
        // A marker for another computer, or none, does not.
        inputs.test_marker = Ok("OTHER".into());
        assert_eq!(evaluate(&inputs).door, None);
        inputs.test_marker = Ok(String::new());
        assert_eq!(evaluate(&inputs).door, None);
    }

    #[test]
    fn without_the_feature_the_install_marker_is_ignored() {
        let mut inputs = installed();
        inputs.production_feature = false;
        assert_eq!(evaluate(&inputs).door, None);
        assert_eq!(failed(&inputs), ["production_feature"]);
    }

    #[test]
    fn a_debug_build_ignores_the_install_marker() {
        let mut inputs = installed();
        inputs.debug_build = true;
        assert_eq!(evaluate(&inputs).door, None);
        assert_eq!(failed(&inputs), ["release_build"]);
    }

    #[test]
    fn a_missing_install_marker_fails() {
        let mut inputs = installed();
        inputs.install_dir = Err("the install marker is not present".into());
        inputs.install_computer = Err("the install marker is not present".into());
        assert_eq!(evaluate(&inputs).door, None);
        assert!(failed(&inputs).contains(&"install_marker"));
        inputs.install_dir = Ok("  ".into());
        assert!(failed(&inputs).contains(&"install_marker"));
    }

    #[test]
    fn a_copy_of_the_exe_in_another_folder_fails_the_install_dir_check() {
        let mut inputs = installed();
        inputs.exe_dir = Ok(r"C:\Users\Someone\Downloads\Rulebox".into());
        assert_eq!(evaluate(&inputs).door, None);
        assert_eq!(failed(&inputs), ["install_dir_is_exe_folder"]);
        // A folder that merely starts with the install folder is another folder.
        inputs.exe_dir = Ok(r"C:\Program Files\Rulebox\versions\1.0".into());
        assert_eq!(failed(&inputs), ["install_dir_is_exe_folder"]);
        inputs.exe_dir = Err("cannot find the running exe".into());
        assert!(failed(&inputs).contains(&"install_dir_is_exe_folder"));
    }

    #[test]
    fn a_folder_that_other_accounts_can_write_fails() {
        let mut inputs = installed();
        inputs.folder_admin_only = Ok(false);
        assert_eq!(evaluate(&inputs).door, None);
        assert_eq!(failed(&inputs), ["install_folder_admin_only"]);
        inputs.folder_admin_only = Err("cannot read the folder DACL".into());
        assert_eq!(failed(&inputs), ["install_folder_admin_only"]);
    }

    #[test]
    fn an_install_marker_for_another_computer_fails() {
        let mut inputs = installed();
        inputs.install_computer = Ok("OTHER-PC".into());
        assert_eq!(evaluate(&inputs).door, None);
        assert_eq!(failed(&inputs), ["install_computer_matches"]);
        inputs.install_computer = Ok(String::new());
        assert_eq!(failed(&inputs), ["install_computer_matches"]);
        inputs.install_computer = Ok("PC-01".into());
        inputs.computer = Err("could not read the computer name".into());
        assert_eq!(evaluate(&inputs).door, None);
    }

    #[test]
    fn folders_compare_without_case_slashes_or_the_verbatim_prefix() {
        assert!(same_folder(r"C:\Program Files\Rulebox", r"c:\program files\rulebox\"));
        assert!(same_folder(r"\\?\C:\Program Files\Rulebox", r"C:\Program Files\Rulebox"));
        assert!(same_folder("C:/Program Files/Rulebox", r"C:\Program Files\Rulebox"));
        assert!(!same_folder(r"C:\Program Files\Rulebox", r"C:\Program Files\Rulebox2"));
        assert!(!same_folder("", ""));
        assert!(!same_folder(r"\\?\UNC\server\share", r"UNC\server\share"));
    }

    #[test]
    fn admin_only_means_the_install_or_protected_dacl_owned_by_an_admin() {
        assert!(folder_is_admin_only(true, false, true, INSTALL_DIR_SDDL));
        assert!(folder_is_admin_only(true, false, true, PROTECTED_DIR_SDDL));
        assert!(folder_is_admin_only(true, false, true, "D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;BU)"));
        // Users may write.
        assert!(!folder_is_admin_only(true, false, true, "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;BU)"));
        // Inherits from the parent (not protected).
        assert!(!folder_is_admin_only(true, false, true, "D:AI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;BU)"));
        // Owner, reparse point, missing folder.
        assert!(!folder_is_admin_only(true, false, false, INSTALL_DIR_SDDL));
        assert!(!folder_is_admin_only(true, true, true, INSTALL_DIR_SDDL));
        assert!(!folder_is_admin_only(false, false, true, INSTALL_DIR_SDDL));
    }

    #[test]
    fn the_refusal_names_the_failed_condition_of_each_door() {
        let mut inputs = installed();
        inputs.production_feature = false;
        let text = evaluate(&inputs).refusal();
        assert!(text.contains("test_marker"), "{text}");
        assert!(text.contains("production_feature"), "{text}");
    }

    /// The feature is off in a plain `cargo test`; the production tests run with it on.
    #[cfg(not(feature = "production"))]
    #[test]
    fn a_default_build_has_no_production_door() {
        assert!(!std::hint::black_box(PRODUCTION_FEATURE));
        let read = read_inputs(false);
        assert!(!read.production_feature);
        assert!(read.install_dir.is_err());
    }

    /// If this fails the dev machine carries the test-machine marker: stop and
    /// tell the user. The test only reads the registry.
    #[test]
    fn dev_machine_is_not_a_test_machine() {
        assert!(matches!(require_test_machine(), Err(Win32Error::Guard(_))));
        assert!(!is_test_machine());
    }

    /// If this fails the dev machine is armed (either marker present): stop and tell the
    /// user. Debug builds never open the production door, so in this build only the test
    /// marker could.
    #[test]
    fn dev_machine_is_not_armed() {
        assert!(matches!(require_armed_machine(), Err(Win32Error::Guard(_))));
        assert!(!is_armed_machine());
        let evaluation = inspect();
        assert_eq!(evaluation.door, None);
        assert!(evaluation.production_door.iter().any(|c| !c.met));
    }
}
