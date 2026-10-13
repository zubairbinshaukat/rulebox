//! `rulebox-shell.exe`: the launcher (plan Section 4.1 and Step 12).
//!
//! It is the registered shell of the Staff account. It starts the Staff App from
//! `current.json`, starts it again whenever it ends, and shows a native fallback
//! screen when that does not work. It never exits on its own (debug builds allow
//! closing the fallback window with Alt+F4). No WebView, no network, no async code
//! in the supervise loop; the only pipe use is the hidden exit in `exit.rs`.

#![cfg_attr(not(test), windows_subsystem = "windows")]

mod backoff;
mod current;
mod exit;
mod fallback;
mod log;
mod process;

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use rulebox_win32::util::{to_wide, OwnedHandle};
use windows::core::PCWSTR;
use windows::Win32::Foundation::{GetLastError, ERROR_ALREADY_EXISTS};
use windows::Win32::System::Threading::CreateMutexW;

use backoff::{CrashTracker, Next};
use current::Current;
use fallback::FallbackChoice;
use process::RunError;

/// One launcher per session.
const MUTEX_NAME: &str = r"Local\RuleboxShellLauncher";
/// An intentional exit (code 0) that comes back faster than this still waits, so a
/// Staff App that exits 0 at once cannot spin the CPU.
const MIN_RUN: Duration = Duration::from_secs(1);

fn main() {
    // Held for the life of the process.
    let _single_instance = match single_instance() {
        Instance::First(handle) => handle,
        Instance::Duplicate => return, // another launcher already runs in this session
    };

    let Some(install_dir) = install_dir() else {
        log::line("cannot find the folder of the running exe; nothing to start");
        return;
    };
    log::line(&format!("launcher {} started in {}", env!("CARGO_PKG_VERSION"), install_dir.display()));

    let mut host = RealHost { install_dir };
    supervise(&mut host);
    log::line("launcher ends (the fallback window was closed in a debug build)");
}

enum Instance {
    /// This is the first launcher. The handle is `None` if it could not be kept.
    First(Option<OwnedHandle>),
    Duplicate,
}

/// If the mutex cannot be created at all, the launcher still runs: a missing
/// launcher is worse than a duplicate one, and the Staff App is single-instance.
fn single_instance() -> Instance {
    let name = to_wide(MUTEX_NAME);
    // SAFETY: `name` is NUL-terminated and outlives the call.
    let created = unsafe { CreateMutexW(None, false, PCWSTR(name.as_ptr())) };
    match created {
        Ok(handle) => {
            // SAFETY: read straight after the call, on the same thread.
            let already = unsafe { GetLastError() } == ERROR_ALREADY_EXISTS;
            let owned = OwnedHandle::new(handle).ok();
            if already {
                Instance::Duplicate
            } else {
                Instance::First(owned)
            }
        }
        Err(_) => Instance::First(None),
    }
}

fn install_dir() -> Option<PathBuf> {
    std::env::current_exe().ok()?.parent().map(Path::to_path_buf)
}

/// Everything the supervise loop needs from the outside world, so the loop itself
/// can be tested with a script.
trait Host {
    /// Reads and validates `current.json`. `Err` carries the sentence for the fallback screen.
    fn load_current(&mut self) -> Result<Current, String>;
    /// Starts the Staff App and waits for it to end.
    fn run(&mut self, exe: &Path) -> Result<u32, RunError>;
    fn fallback(&mut self, reason: &str) -> FallbackChoice;
    fn sleep(&mut self, duration: Duration);
    fn now(&mut self) -> Instant;
}

struct RealHost {
    install_dir: PathBuf,
}

impl Host for RealHost {
    fn load_current(&mut self) -> Result<Current, String> {
        let path = self.install_dir.join("current.json");
        let json = std::fs::read_to_string(&path)
            .map_err(|_| "Rulebox can't find its version file (current.json).".to_string())?;
        current::resolve(&self.install_dir, &json).map_err(|e| e.describe().to_string())
    }

    fn run(&mut self, exe: &Path) -> Result<u32, RunError> {
        process::run_to_exit(exe)
    }

    fn fallback(&mut self, reason: &str) -> FallbackChoice {
        fallback::show(reason)
    }

    fn sleep(&mut self, duration: Duration) {
        std::thread::sleep(duration);
    }

    fn now(&mut self) -> Instant {
        Instant::now()
    }
}

/// Starts the Staff App, waits, starts it again. Returns only when the fallback
/// window was closed (possible in debug builds only).
fn supervise(host: &mut impl Host) {
    let mut tracker = CrashTracker::new();
    loop {
        let current = match host.load_current() {
            Ok(current) => current,
            Err(reason) => {
                log::line(&format!("cannot start: {reason}"));
                if host.fallback(&reason) == FallbackChoice::Closed {
                    return;
                }
                continue;
            }
        };

        let started = host.now();
        tracker.record_start(started);
        log::line(&format!("starting Staff App {} ({})", current.version, current.exe.display()));

        let code = match host.run(&current.exe) {
            Ok(code) => code,
            Err(error) => {
                let reason = match error {
                    RunError::Create(code) => {
                        format!("The Staff App could not be started (Windows error {code}).")
                    }
                    RunError::Wait(code) => {
                        format!("Rulebox lost track of the Staff App (Windows error {code}).")
                    }
                };
                log::line(&format!("cannot run: {reason}"));
                if host.fallback(&reason) == FallbackChoice::Closed {
                    return;
                }
                continue;
            }
        };

        let now = host.now();
        log::line(&format!("Staff App exited with code {}", exit_code_text(code)));
        match tracker.record_exit(code, now) {
            Next::RestartNow => {
                let ran = now.saturating_duration_since(started);
                if ran < MIN_RUN {
                    host.sleep(MIN_RUN - ran);
                }
            }
            Next::RestartAfter(delay) => host.sleep(delay),
            Next::Fallback => {
                let reason = format!(
                    "The Staff App stopped {} times (exit code {}).",
                    tracker.recent_crashes(),
                    exit_code_text(code)
                );
                log::line(&format!("crash loop: {reason}"));
                if host.fallback(&reason) == FallbackChoice::Closed {
                    return;
                }
            }
        }
    }
}

/// Small codes in decimal, Windows status codes (`0xC0000005`) in hex.
fn exit_code_text(code: u32) -> String {
    if code <= 0xFFFF {
        code.to_string()
    } else {
        format!("0x{code:08X}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    /// A scripted world: the clock only moves when something sleeps or runs.
    struct Script {
        clock: Instant,
        currents: VecDeque<Result<Current, String>>,
        runs: VecDeque<(Duration, Result<u32, RunError>)>,
        fallbacks: VecDeque<FallbackChoice>,
        slept: Vec<Duration>,
        reasons: Vec<String>,
        launched: Vec<PathBuf>,
    }

    impl Script {
        fn new() -> Self {
            Self {
                clock: Instant::now(),
                currents: VecDeque::new(),
                runs: VecDeque::new(),
                fallbacks: VecDeque::new(),
                slept: Vec::new(),
                reasons: Vec::new(),
                launched: Vec::new(),
            }
        }

        fn good_current() -> Result<Current, String> {
            Ok(Current { version: "1.0.0".into(), exe: PathBuf::from(r"C:\Rulebox\versions\1.0.0\rulebox-staff.exe") })
        }
    }

    impl Host for Script {
        fn load_current(&mut self) -> Result<Current, String> {
            self.currents.pop_front().unwrap_or_else(Script::good_current)
        }

        fn run(&mut self, exe: &Path) -> Result<u32, RunError> {
            self.launched.push(exe.to_path_buf());
            let (length, outcome) = self.runs.pop_front().unwrap_or((Duration::ZERO, Err(RunError::Create(2))));
            self.clock += length;
            outcome
        }

        fn fallback(&mut self, reason: &str) -> FallbackChoice {
            self.reasons.push(reason.to_string());
            // The fallback screen itself takes time (the 30-second retry).
            self.clock += Duration::from_secs(30);
            self.fallbacks.pop_front().unwrap_or(FallbackChoice::Closed)
        }

        fn sleep(&mut self, duration: Duration) {
            self.slept.push(duration);
            self.clock += duration;
        }

        fn now(&mut self) -> Instant {
            self.clock
        }
    }

    const SHORT: Duration = Duration::from_millis(200);

    #[test]
    fn a_crash_loop_backs_off_then_shows_the_fallback() {
        let mut script = Script::new();
        script.runs = (0..5).map(|_| (SHORT, Ok(1))).collect();
        supervise(&mut script);
        assert_eq!(
            script.slept,
            vec![
                Duration::from_millis(500),
                Duration::from_secs(1),
                Duration::from_secs(2),
                Duration::from_secs(5)
            ]
        );
        assert_eq!(script.reasons, vec!["The Staff App stopped 5 times (exit code 1).".to_string()]);
        assert_eq!(script.launched.len(), 5);
    }

    #[test]
    fn exit_zero_restarts_without_a_crash_count_but_never_spins() {
        let mut script = Script::new();
        // Three instant clean exits, then a run that cannot be created ends the script.
        script.runs = (0..3).map(|_| (Duration::ZERO, Ok(0))).collect();
        supervise(&mut script);
        assert_eq!(script.slept, vec![MIN_RUN; 3]);
        assert_eq!(script.launched.len(), 4);
        assert!(script.reasons[0].starts_with("The Staff App could not be started"));
    }

    #[test]
    fn a_long_clean_run_restarts_at_once() {
        let mut script = Script::new();
        script.runs = VecDeque::from([(Duration::from_secs(3600), Ok(0))]);
        supervise(&mut script);
        assert!(script.slept.is_empty());
    }

    #[test]
    fn an_unusable_current_json_shows_the_fallback_and_is_read_again() {
        let mut script = Script::new();
        script.currents = VecDeque::from([
            Err("The Rulebox version file (current.json) is damaged.".to_string()),
            Err("Rulebox can't find its version file (current.json).".to_string()),
        ]);
        script.fallbacks = VecDeque::from([FallbackChoice::Timeout, FallbackChoice::TryAgain]);
        supervise(&mut script);
        // Two failures, then the good file; its run fails to start and ends the script.
        assert_eq!(script.reasons.len(), 3);
        assert!(script.reasons[0].contains("damaged"));
        assert!(script.reasons[1].contains("can't find"));
        assert_eq!(script.launched.len(), 1);
    }

    #[test]
    fn a_process_that_cannot_be_started_shows_the_windows_error() {
        let mut script = Script::new();
        script.runs = VecDeque::from([(Duration::ZERO, Err(RunError::Create(5)))]);
        supervise(&mut script);
        assert_eq!(script.reasons, vec!["The Staff App could not be started (Windows error 5).".to_string()]);
    }

    #[test]
    fn after_a_fallback_one_failed_retry_shows_it_again_without_flapping() {
        let mut script = Script::new();
        script.runs = (0..6).map(|_| (SHORT, Ok(1))).collect();
        script.fallbacks = VecDeque::from([FallbackChoice::Timeout]);
        supervise(&mut script);
        // Five crashes -> fallback (retry) -> one more crash -> fallback again (closed).
        assert_eq!(script.launched.len(), 6);
        assert_eq!(script.reasons.len(), 2);
        assert_eq!(script.slept.len(), 4);
    }

    #[test]
    fn exit_codes_read_well() {
        assert_eq!(exit_code_text(0), "0");
        assert_eq!(exit_code_text(1), "1");
        assert_eq!(exit_code_text(0xC000_0005), "0xC0000005");
    }
}
