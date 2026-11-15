//! Test hook for the VM run of Phase 5 Step 21 (row 4-02): make the Staff App crash on every start.
//!
//! The Staff App already has the debug-only flag `--simulate-crash-loop` (it ends itself
//! with 0xC0000005 five seconds after it said `shell.ready`). Nothing passed it, because
//! the launcher starts the Staff App with no arguments. In a **debug build only**, the
//! launcher now passes it when BOTH are true:
//!
//! 1. the flag file `simulate-crash-loop.flag` exists next to `rulebox-shell.exe`
//!    (the install folder, which the Staff user cannot write to), and
//! 2. the test-machine marker is present and names this computer
//!    (`rulebox_win32::guard`, the same check every destructive call makes).
//!
//! A release build compiles all of this out: `staff_args` is an empty function there and
//! the flag file is never looked at (plan Section 6.9: the launcher passes no arguments).
//! The marker is only read. Nothing here creates or deletes a file.

#[cfg(debug_assertions)]
use std::path::Path;

/// The file a tester creates (an empty file is enough) in the install folder.
#[cfg(debug_assertions)]
pub const FLAG_FILE: &str = "simulate-crash-loop.flag";
/// The Staff App's own debug flag.
#[cfg(debug_assertions)]
pub const STAFF_ARG: &str = "--simulate-crash-loop";

/// The extra command-line arguments for the Staff App. Empty unless the flag file and the
/// test-machine marker are both there. Read again before every start, so deleting the
/// file ends the crash loop at the next start.
#[cfg(debug_assertions)]
pub fn staff_args(install_dir: &Path) -> Vec<&'static str> {
    let present = install_dir.join(FLAG_FILE).is_file();
    let args = decide(present, rulebox_win32::guard::is_test_machine);
    if present && args.is_empty() {
        crate::log::line("simulate-crash-loop.flag ignored: this is not a marked test machine");
    } else if !args.is_empty() {
        crate::log::line("simulate-crash-loop.flag found on a marked test machine: starting the Staff App with --simulate-crash-loop");
    }
    args
}

/// Release build: no arguments, no file lookup, no marker check.
#[cfg(not(debug_assertions))]
pub fn staff_args(_install_dir: &std::path::Path) -> Vec<&'static str> {
    Vec::new()
}

/// The rule itself, separate from the disk and the registry so it can be tested.
/// The marker is only asked when the flag file is present.
#[cfg(debug_assertions)]
fn decide(flag_file_present: bool, is_test_machine: impl FnOnce() -> bool) -> Vec<&'static str> {
    if flag_file_present && is_test_machine() {
        vec![STAFF_ARG]
    } else {
        Vec::new()
    }
}

#[cfg(all(test, debug_assertions))]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn flag_file_and_marker_pass_the_flag() {
        assert_eq!(decide(true, || true), vec!["--simulate-crash-loop"]);
    }

    #[test]
    fn flag_file_without_the_marker_is_ignored() {
        assert!(decide(true, || false).is_empty());
    }

    #[test]
    fn marker_without_the_flag_file_does_nothing_and_is_not_even_read() {
        let asked = Cell::new(false);
        assert!(decide(false, || {
            asked.set(true);
            true
        })
        .is_empty());
        assert!(!asked.get());
    }

    #[test]
    fn staff_arg_is_the_flag_the_staff_app_reads() {
        assert_eq!(STAFF_ARG, "--simulate-crash-loop");
    }

    /// The dev machine has no marker (a guard test in rulebox-win32 proves it), so a flag
    /// file here must still change nothing. Reads the registry and the disk only.
    #[test]
    fn a_flag_file_on_an_unmarked_machine_passes_nothing() {
        let dir = std::env::temp_dir().join(format!("rulebox-crashflag-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(FLAG_FILE), b"").unwrap();
        let args = staff_args(&dir);
        let _ = std::fs::remove_dir_all(&dir);
        // On a marked test machine the same call must pass the flag; anywhere else nothing.
        if rulebox_win32::guard::is_test_machine() {
            assert_eq!(args, vec![STAFF_ARG]);
        } else {
            assert!(args.is_empty());
        }
    }

    #[test]
    fn no_flag_file_passes_nothing() {
        let dir = std::env::temp_dir().join(format!("rulebox-crashflag-test-empty-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let args = staff_args(&dir);
        let _ = std::fs::remove_dir_all(&dir);
        assert!(args.is_empty());
    }
}
