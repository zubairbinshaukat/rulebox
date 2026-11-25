//! (Phase 6 Step 14, plan 4.6 "Timeout" and "Per-user installer") The two questions the engine asks after an
//! installer that did not do what it should: *was it waiting for somebody?* and *did it install for the wrong
//! account?* The rules are pure functions here; reading the machine is the platform's job (`RunningInstaller`,
//! `Platform::find_file_below`).
//!
//! **needs_interaction (heuristic):** an installer that ran into the timeout and, in the last five minutes, used
//! under one second of CPU time (the whole process tree together), or has a visible window on the service desktop,
//! is not slow, it is stuck on a question nobody can answer (the agent runs it as SYSTEM without any window the
//! Staff can see). A heuristic: a download that waits on the network looks the same, so the detail only says
//! "probably", and the dashboard text must not promise more. Never verified on a real PC outside the VM runs.
//!
//! **installed_per_user (heuristic):** the installer said success, the program is not at its path, and a file with
//! the program's name sits in the profile of SYSTEM (`<SystemRoot>\System32\config\systemprofile\AppData`, or its
//! `SysWOW64` twin for a 32-bit installer): the installer put the app in the account it ran as, not in Program Files.
//! Only that profile is looked at, read-only, at most [`PER_USER_MAX_DEPTH`] folders deep.

use std::path::{Path, PathBuf};
use std::time::Duration;

/// How far back the CPU use is judged (plan 4.6: five minutes).
pub const CPU_WINDOW: Duration = Duration::from_secs(5 * 60);
/// Less CPU time than this in [`CPU_WINDOW`] counts as idle (plan 4.6: one second).
pub const IDLE_CPU: Duration = Duration::from_secs(1);
/// How many folders below `AppData` the search for a per-user install goes (plan 4.6: 4).
pub const PER_USER_MAX_DEPTH: u32 = 4;

/// The installer ran into its timeout: was it waiting for somebody? `cpu_then` is the CPU time of the whole tree
/// [`CPU_WINDOW`] before the timeout (or at its start when the timeout is not longer than that), `cpu_now` at the
/// timeout. A window is always a yes; an unreadable CPU time (`None`) is never a yes by itself, so the failure stays a
/// plain `timeout` when nothing could be measured.
pub fn looks_stuck(cpu_then: Option<Duration>, cpu_now: Option<Duration>, has_window: bool) -> bool {
    if has_window {
        return true;
    }
    match (cpu_then, cpu_now) {
        (Some(then), Some(now)) => now.saturating_sub(then) < IDLE_CPU,
        _ => false,
    }
}

/// Where the CPU time is read before the timeout: `timeout - CPU_WINDOW`, never before the start.
pub fn cpu_sample_at(timeout: Duration) -> Duration {
    timeout.saturating_sub(CPU_WINDOW)
}

/// The `AppData` folders of SYSTEM's profile, where an installer that runs as SYSTEM puts what it installs "for the
/// current user": `<SystemRoot>\System32\config\systemprofile\AppData` for a 64-bit installer and
/// `<SystemRoot>\SysWOW64\config\systemprofile\AppData` for a 32-bit one. File system redirection sends a 32-bit
/// process's `System32` to `SysWOW64`, so a 32-bit NSIS stub's files land there even though the uninstall entry it
/// writes says `system32` (VM spike S-9, 2026-11-25: Tauri NSIS, Zahras POS Dev 1.0.2).
pub fn systemprofile_appdata(system_root: &Path) -> [PathBuf; 2] {
    let under = |bits: &str| system_root.join(bits).join("config").join("systemprofile").join("AppData");
    [under("System32"), under("SysWOW64")]
}

/// The file name to look for: the last part of the program's path template (a `*` or a bare name is not one).
pub fn program_file_name(exe: &str) -> Option<&str> {
    let name = exe.rsplit('\\').next()?;
    (!name.is_empty() && !name.contains(['*', '?', ':', '/'])).then_some(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn secs(n: u64) -> Option<Duration> {
        Some(Duration::from_secs(n))
    }

    #[test]
    fn an_idle_tree_or_a_window_is_stuck_and_a_busy_one_is_not() {
        // Under one second of CPU in the window: idle.
        assert!(looks_stuck(secs(100), secs(100), false));
        assert!(looks_stuck(secs(100), Some(Duration::from_millis(100_999)), false));
        // One second or more: working.
        assert!(!looks_stuck(secs(100), secs(101), false));
        assert!(!looks_stuck(secs(0), secs(250), false));
        // A window on the service desktop wins over a busy CPU.
        assert!(looks_stuck(secs(0), secs(250), true));
        assert!(looks_stuck(None, None, true));
        // Nothing measured and no window: an ordinary timeout.
        assert!(!looks_stuck(None, None, false));
        assert!(!looks_stuck(secs(1), None, false));
        assert!(!looks_stuck(None, secs(1), false));
        // A counter that went backwards (it cannot) is idle, not a panic.
        assert!(looks_stuck(secs(9), secs(3), false));
    }

    #[test]
    fn the_cpu_sample_is_five_minutes_before_the_timeout_and_never_before_the_start() {
        assert_eq!(cpu_sample_at(Duration::from_secs(30 * 60)), Duration::from_secs(25 * 60));
        assert_eq!(cpu_sample_at(Duration::from_secs(5 * 60)), Duration::ZERO);
        assert_eq!(cpu_sample_at(Duration::from_secs(60)), Duration::ZERO);
    }

    #[test]
    fn the_per_user_search_looks_only_in_the_system_profile_and_names_the_program() {
        assert_eq!(
            systemprofile_appdata(Path::new(r"C:\Windows")),
            [
                PathBuf::from(r"C:\Windows\System32\config\systemprofile\AppData"),
                PathBuf::from(r"C:\Windows\SysWOW64\config\systemprofile\AppData"),
            ]
        );
        assert_eq!(program_file_name(r"C:\Program Files\Vendor\App\app.exe"), Some("app.exe"));
        assert_eq!(program_file_name("app.exe"), Some("app.exe"));
        for bad in ["", r"C:\Program Files\Vendor\", r"C:\Program Files\app-*\app.exe\*", "C:app.exe:stream", "a/b.exe"] {
            assert_eq!(program_file_name(bad), None, "{bad:?}");
        }
        // A pattern ends in a real file name: the `*` is in a folder above it.
        assert_eq!(program_file_name(r"C:\Program Files\Vendor\app-*\app.exe"), Some("app.exe"));
        assert_eq!(PER_USER_MAX_DEPTH, 4);
    }
}
