//! The WebView2 Runtime bootstrap of Rulebox Setup (Phase 6 Step 8, plan 4.10 and 4.12).
//!
//! The MSI installs Microsoft's Evergreen bootstrapper (`MicrosoftEdgeWebview2Setup.exe`) into
//! the install folder and never runs it. Setup, and the service for a silent install, run it
//! only when the runtime is missing or older than version 125, and only after its SHA-256 equals
//! the value compiled into this agent ([`PINNED_SHA256`], from
//! `apps/installer/webview2-bootstrapper.sha256`). While nothing is pinned the bootstrapper is
//! never started (`Outcome::NotPinned`). The run itself goes through
//! `Platform::run_webview_bootstrapper`, which checks the file's place and hash again.
//!
//! The steps: read the version; if it is good, stop; refuse when nothing is pinned; hash the
//! file; run it and wait; read the version again; report what happened. No WebView is hosted
//! here: the agent only starts a process and reads the registry.

use std::path::Path;
use std::time::Duration;

use tokio_util::sync::CancellationToken;

use crate::compat::webview2_is_good;
use crate::platform::{InstallerExit, Platform};

// `pub const PINNED_SHA256: Option<&str>`, written by build.rs from the pin file.
include!(concat!(env!("OUT_DIR"), "/webview2_pin.rs"));

/// The bootstrapper's file name in the install folder (`Package.wxs`).
pub const BOOTSTRAPPER_FILE: &str = "MicrosoftEdgeWebview2Setup.exe";
/// Microsoft's silent switches for the Evergreen bootstrapper.
pub const BOOTSTRAPPER_ARGS: [&str; 2] = ["/silent", "/install"];
/// The bootstrapper is about 1.8 MB; anything over this is not it.
pub const MAX_BOOTSTRAPPER_BYTES: u64 = 16 * 1024 * 1024;
/// How long one run may take (a slow connection downloads the runtime in it).
pub const RUN_TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// What a bootstrap attempt came to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// The runtime is there and new enough; nothing was started.
    NotNeeded { version: String },
    /// The bootstrapper ran and the runtime is there now.
    Installed { version: String },
    /// No hash is compiled in, so the bootstrapper was not started.
    NotPinned,
    /// There is no bootstrapper file in the install folder.
    BootstrapperMissing,
    /// The file's SHA-256 is not the pinned one, so it was not started.
    HashMismatch,
    /// The run could not start, timed out, was cancelled or ended with an error.
    RunFailed { detail: String },
    /// The run ended without an error but the runtime is still missing or too old.
    StillTooOld { version: Option<String> },
}

impl Outcome {
    /// True when the runtime is fine now.
    pub fn is_good(&self) -> bool {
        matches!(self, Outcome::NotNeeded { .. } | Outcome::Installed { .. })
    }
}

/// `exe` is the bootstrapper file of the install folder (case-insensitive, no other folder, no
/// `..`, no other name). Pure.
pub fn bootstrapper_path_ok(install_root: &Path, exe: &Path) -> bool {
    fn normal(path: &Path) -> String {
        path.to_string_lossy().replace('/', "\\").trim_end_matches('\\').to_ascii_lowercase()
    }
    let plain = !exe.components().any(|part| matches!(part, std::path::Component::ParentDir | std::path::Component::CurDir));
    plain
        && exe.file_name().is_some_and(|name| name.eq_ignore_ascii_case(BOOTSTRAPPER_FILE))
        && exe.parent().is_some_and(|parent| normal(parent) == normal(install_root))
}

fn good_version(platform: &dyn Platform) -> Result<Result<String, Option<String>>, String> {
    let raw = platform.webview2_version().map_err(|error| format!("cannot read the WebView2 version ({error})"))?;
    Ok(if webview2_is_good(raw.clone()) { Ok(raw.unwrap_or_default().trim().to_string()) } else { Err(raw.map(|v| v.trim().to_string()).filter(|v| !v.is_empty())) })
}

/// Makes sure the runtime is installed and at least version [`MIN_WEBVIEW2_MAJOR`]. `pinned` is
/// [`PINNED_SHA256`] in the real program. Blocking (the run waits for the bootstrapper): call it
/// from a worker thread.
pub fn ensure(
    platform: &dyn Platform,
    install_root: &Path,
    pinned: Option<&str>,
    timeout: Duration,
    cancel: &CancellationToken,
) -> Outcome {
    match good_version(platform) {
        Ok(Ok(version)) => return Outcome::NotNeeded { version },
        Ok(Err(_)) => {}
        Err(detail) => return Outcome::RunFailed { detail },
    }
    let Some(pinned) = pinned else {
        tracing::warn!("the WebView2 bootstrapper is not started: no SHA-256 is pinned in this build");
        return Outcome::NotPinned;
    };
    let exe = install_root.join(BOOTSTRAPPER_FILE);
    match platform.file_sha256(&exe, MAX_BOOTSTRAPPER_BYTES) {
        Ok(Some(hash)) if hash.eq_ignore_ascii_case(pinned) => {}
        Ok(Some(_)) => {
            tracing::error!("the WebView2 bootstrapper is not the pinned file; not started");
            return Outcome::HashMismatch;
        }
        Ok(None) => return Outcome::BootstrapperMissing,
        Err(error) => return Outcome::RunFailed { detail: format!("cannot check the installer file ({error})") },
    }
    tracing::info!("starting the WebView2 bootstrapper (hash verified)");
    let exit = match platform.run_webview_bootstrapper(&exe, pinned, timeout, cancel) {
        Ok(exit) => exit,
        // A refusal after our own check (the file changed in between) is the same as a mismatch.
        Err(crate::platform::PlatformError::Refused(_)) => return Outcome::HashMismatch,
        Err(error) => return Outcome::RunFailed { detail: error.to_string() },
    };
    // Whatever the exit says, the registry decides.
    match good_version(platform) {
        Ok(Ok(version)) => Outcome::Installed { version },
        Ok(Err(version)) => match exit {
            InstallerExit::Code(0) => Outcome::StillTooOld { version },
            InstallerExit::Code(code) => Outcome::RunFailed { detail: format!("exit code {code}") },
            InstallerExit::TimedOut => Outcome::RunFailed { detail: "it did not finish in time".to_string() },
            InstallerExit::Cancelled => Outcome::RunFailed { detail: "it was cancelled".to_string() },
        },
        Err(detail) => Outcome::RunFailed { detail },
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;
    use crate::compat::MIN_WEBVIEW2_MAJOR;
    use crate::platform::sim::{SimOp, SimPlatform, SimProgram};
    use crate::platform::{FileIdentity, FileStamp, PlatformError};
    use crate::testutil::TempDir;

    const ROOT: &str = r"C:\Program Files\Rulebox";
    const GOOD_HASH: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn exe() -> PathBuf {
        PathBuf::from(ROOT).join(BOOTSTRAPPER_FILE)
    }

    /// A machine with the bootstrapper file in place and the given runtime version.
    fn machine(pv: Option<&str>, file_hash: Option<&str>) -> (TempDir, SimPlatform) {
        let dir = TempDir::new();
        let sim = SimPlatform::new(dir.path().to_path_buf());
        sim.with_world(|world| {
            world.webview2_pv = pv.map(str::to_string);
            if let Some(hash) = file_hash {
                world.programs.insert(
                    exe().to_string_lossy().to_ascii_lowercase(),
                    SimProgram {
                        stamp: FileStamp { created: 1, modified: 1, size: 1_800_000 },
                        identity: FileIdentity::default(),
                        sha256: Some(hash.to_string()),
                    },
                );
            }
        });
        (dir, sim)
    }

    fn run(sim: &SimPlatform, pinned: Option<&str>) -> Outcome {
        ensure(sim, Path::new(ROOT), pinned, Duration::from_secs(1), &CancellationToken::new())
    }

    fn runs(sim: &SimPlatform) -> usize {
        sim.with_world(|world| world.bootstrapper_runs.len())
    }

    #[test]
    fn a_good_runtime_starts_nothing() {
        for pv in ["125.0.0.0", "130.0.2849.80", "131.1"] {
            let (_dir, sim) = machine(Some(pv), Some(GOOD_HASH));
            assert_eq!(run(&sim, Some(GOOD_HASH)), Outcome::NotNeeded { version: pv.to_string() });
            assert_eq!(runs(&sim), 0, "{pv}");
        }
    }

    #[test]
    fn a_missing_runtime_triggers_the_bootstrap_call_and_the_version_is_read_again() {
        let (_dir, sim) = machine(None, Some(GOOD_HASH));
        let outcome = run(&sim, Some(GOOD_HASH));
        assert_eq!(outcome, Outcome::Installed { version: "131.0.2903.51".into() });
        assert!(outcome.is_good());
        assert_eq!(sim.with_world(|world| world.bootstrapper_runs.clone()), vec![(exe(), GOOD_HASH.to_string())]);
        // Read before the run (to decide) and after it (to report): two reads.
        assert_eq!(sim.calls().iter().filter(|op| **op == SimOp::Webview2Version).count(), 2);
    }

    #[test]
    fn an_old_or_zero_runtime_is_updated_too() {
        for pv in ["124.0.2478.51", "0.0.0.0", "", "garbage"] {
            let (_dir, sim) = machine(Some(pv), Some(GOOD_HASH));
            assert!(matches!(run(&sim, Some(GOOD_HASH)), Outcome::Installed { .. }), "{pv:?}");
            assert_eq!(runs(&sim), 1, "{pv:?}");
        }
    }

    #[test]
    fn a_wrong_bootstrapper_hash_refuses_to_run_it() {
        let other = "f".repeat(64);
        let (_dir, sim) = machine(None, Some(&other));
        let outcome = run(&sim, Some(GOOD_HASH));
        assert_eq!(outcome, Outcome::HashMismatch);
        assert!(!outcome.is_good());
        assert_eq!(runs(&sim), 0, "the bootstrapper never started");
        assert!(!sim.calls().contains(&SimOp::RunWebviewBootstrapper), "not even the platform call was made");
    }

    #[test]
    fn the_platform_checks_the_hash_again_at_the_start() {
        // The file changes between the caller's check and the start: the platform refuses.
        let (_dir, sim) = machine(None, Some(GOOD_HASH));
        let other = "a".repeat(64);
        let result = sim.run_webview_bootstrapper(&exe(), &other, Duration::from_secs(1), &CancellationToken::new());
        assert!(matches!(result, Err(PlatformError::Refused(_))), "{result:?}");
        assert_eq!(runs(&sim), 0);
        // And a file that is not the bootstrapper of the install folder is never started.
        let elsewhere = PathBuf::from(r"C:\Users\Someone\Downloads").join(BOOTSTRAPPER_FILE);
        let result = sim.run_webview_bootstrapper(&elsewhere, GOOD_HASH, Duration::from_secs(1), &CancellationToken::new());
        assert!(matches!(result, Err(PlatformError::Refused(_))), "{result:?}");
    }

    #[test]
    fn nothing_pinned_means_the_bootstrapper_is_never_started() {
        let (_dir, sim) = machine(None, Some(GOOD_HASH));
        assert_eq!(run(&sim, None), Outcome::NotPinned);
        assert_eq!(runs(&sim), 0);
        assert!(!sim.calls().contains(&SimOp::RunWebviewBootstrapper));
        // A good runtime does not need the pin.
        let (_dir, good) = machine(Some("130.0.0.1"), None);
        assert!(matches!(run(&good, None), Outcome::NotNeeded { .. }));
    }

    #[test]
    fn a_missing_bootstrapper_file_is_reported_and_nothing_runs() {
        let (_dir, sim) = machine(None, None);
        assert_eq!(run(&sim, Some(GOOD_HASH)), Outcome::BootstrapperMissing);
        assert_eq!(runs(&sim), 0);
    }

    #[test]
    fn a_run_that_changes_nothing_or_fails_is_reported_as_it_is() {
        // Exit 0 but the registry still says no.
        let (_dir, sim) = machine(Some("120.0.1"), Some(GOOD_HASH));
        sim.with_world(|world| world.bootstrapper_installs_pv = None);
        assert_eq!(run(&sim, Some(GOOD_HASH)), Outcome::StillTooOld { version: Some("120.0.1".into()) });
        // An error exit, a timeout, a cancel.
        for (exit, detail) in [
            (InstallerExit::Code(5), "exit code 5"),
            (InstallerExit::TimedOut, "it did not finish in time"),
            (InstallerExit::Cancelled, "it was cancelled"),
        ] {
            let (_dir, sim) = machine(None, Some(GOOD_HASH));
            sim.with_world(|world| {
                world.bootstrapper_exit = exit;
                world.bootstrapper_installs_pv = None;
            });
            assert_eq!(run(&sim, Some(GOOD_HASH)), Outcome::RunFailed { detail: detail.into() }, "{exit:?}");
        }
        // The bootstrapper fails to start at all.
        let (_dir, sim) = machine(None, Some(GOOD_HASH));
        sim.fail_next(SimOp::RunWebviewBootstrapper, PlatformError::AccessDenied);
        assert!(matches!(run(&sim, Some(GOOD_HASH)), Outcome::RunFailed { .. }));
    }

    #[test]
    fn the_path_rule_accepts_only_the_bootstrapper_of_the_install_folder() {
        let root = Path::new(ROOT);
        for good in [
            r"C:\Program Files\Rulebox\MicrosoftEdgeWebview2Setup.exe",
            r"c:\program files\rulebox\microsoftedgewebview2setup.EXE",
            r"C:/Program Files/Rulebox/MicrosoftEdgeWebview2Setup.exe",
        ] {
            assert!(bootstrapper_path_ok(root, Path::new(good)), "{good}");
        }
        for bad in [
            r"C:\Program Files\Rulebox\other.exe",
            r"C:\Program Files\Rulebox\sub\MicrosoftEdgeWebview2Setup.exe",
            r"C:\Program Files\Rulebox-evil\MicrosoftEdgeWebview2Setup.exe",
            r"C:\Program Files\Rulebox\..\Other\MicrosoftEdgeWebview2Setup.exe",
            r"C:\Users\Someone\Downloads\MicrosoftEdgeWebview2Setup.exe",
            r"C:\Program Files\Rulebox",
            "",
        ] {
            assert!(!bootstrapper_path_ok(root, Path::new(bad)), "{bad}");
        }
    }

    #[test]
    fn the_silent_switches_are_microsofts() {
        assert_eq!(BOOTSTRAPPER_ARGS, ["/silent", "/install"]);
        assert_eq!(BOOTSTRAPPER_FILE, "MicrosoftEdgeWebview2Setup.exe");
        assert_eq!(MIN_WEBVIEW2_MAJOR, 125);
    }

    // -- the compiled-in pin ------------------------------------------------------------------------

    /// The pin file as the build read it. `include_str!` is relative to this file:
    /// `apps/agent/src/setup/` to `apps/installer/`.
    const PIN_FILE: &str = include_str!("../../../installer/webview2-bootstrapper.sha256");

    #[test]
    fn the_compiled_in_hash_is_what_the_pin_file_says() {
        let from_file = crate::setup::pin_parse::parse_pin(PIN_FILE).expect("the pin file is well formed");
        assert_eq!(PINNED_SHA256.map(str::to_string), from_file);
        if let Some(hash) = PINNED_SHA256 {
            assert_eq!(hash.len(), 64);
            assert!(hash.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()), "lowercase hex");
        }
    }

    #[test]
    fn the_pin_file_reader_accepts_comments_and_one_hash_line() {
        use crate::setup::pin_parse::parse_pin;
        assert_eq!(parse_pin("# only comments\n\n   # another\n"), Ok(None));
        assert_eq!(parse_pin(""), Ok(None));
        let hash = "AB".repeat(32);
        let lower = hash.to_ascii_lowercase();
        assert_eq!(parse_pin(&format!("# c\n{hash}  MicrosoftEdgeWebview2Setup.exe\n")), Ok(Some(lower.clone())));
        assert_eq!(parse_pin(&format!("{lower}\r\n")), Ok(Some(lower)));
        for bad in ["nothex", &"a".repeat(63), &"a".repeat(65), &format!("{} x", "g".repeat(64))] {
            assert!(parse_pin(bad).is_err(), "{bad}");
        }
    }
}
