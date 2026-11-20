//! Rulebox Setup, `rulebox-agent setup` (Phase 6 Step 8, plan 4.10.1) and the enrollment hand-off
//! from the MSI (plan 4.10).
//!
//! - `flow.rs`: the screens and what each event does, no window (tested against `SimPlatform`).
//! - `ui.rs`: the native Win32 window (no WebView) that draws a screen and feeds events in.
//! - `backend.rs`: the checks and the bootstrap on any `Platform`, and the service over the
//!   admin pipe.
//! - `webview2.rs`: the hash-verified WebView2 bootstrapper run, with the pin compiled in.
//! - `pending.rs`: the enrollment code of a silent install: read once, enroll, delete.
//! - `strings.rs`: every English string, in one table.
//! - `pin_parse.rs`: reads the pin file; shared with `build.rs`.
//!
//! Setup changes nothing by itself: the WebView2 install goes through
//! `Platform::run_webview_bootstrapper` (guarded) and the enrollment through the service's admin
//! pipe, the same path as `rulebox-agent enroll`. Setup never starts the kiosk: the service does,
//! after the enrollment succeeded and the document says so.

pub mod backend;
pub mod flow;
pub mod pending;
pub mod strings;
pub mod ui;
pub mod webview2;

#[cfg(test)]
#[path = "pin_parse.rs"]
pub mod pin_parse;

use std::io::Write;
use std::sync::Arc;

use crate::paths::{DataPaths, InstallPaths};
use crate::platform::sim::SimPlatform;
use crate::platform::windows::WindowsPlatform;
use crate::setup::backend::{PipeAgent, PlatformBackend, SimAgent};
use crate::setup::flow::Backend;

/// What `setup` does about administrator rights.
#[derive(Debug, PartialEq, Eq)]
enum Start {
    /// Open the window in this process.
    Here,
    /// Ask Windows for administrator rights by starting this program again, then end.
    Relaunch,
    /// Cannot go on; the text says why.
    Cannot(String),
}

/// The decision, pure. The simulation touches nothing and needs no rights. `relaunched` means this
/// process is the copy Windows started for the prompt: if it still has no rights, asking again
/// would only loop.
fn start_plan(simulate: bool, relaunched: bool, elevated: Result<bool, String>) -> Start {
    if simulate {
        return Start::Here;
    }
    match (elevated, relaunched) {
        (Ok(true), _) => Start::Here,
        (Ok(false), false) => Start::Relaunch,
        (Ok(false), true) => Start::Cannot("Windows did not give this program administrator rights.".to_string()),
        (Err(why), _) => Start::Cannot(format!("cannot tell whether this program has administrator rights ({why})")),
    }
}

/// `rulebox-agent setup [--simulate]`. Returns the exit code.
///
/// Without `--simulate` the real PC is read and the real service is asked. With it, everything is
/// in memory: a simulated PC, a simulated service, no pipe, no registry, no elevation prompt. The
/// window looks the same, so it can be looked at on any machine.
pub fn run(simulate: bool, relaunched: bool, err: &mut dyn Write) -> u8 {
    let elevated = if simulate { Ok(true) } else { rulebox_win32::security::process_is_elevated().map_err(|e| e.to_string()) };
    match start_plan(simulate, relaunched, elevated) {
        Start::Here => {}
        Start::Relaunch => {
            return match rulebox_win32::security::relaunch_setup_elevated() {
                Ok(()) => 0,
                Err(error) => {
                    let _ = writeln!(
                        err,
                        "error: Rulebox Setup needs administrator rights ({error}). Choose Yes at the Windows prompt, or run `rulebox-agent setup` from an administrator prompt."
                    );
                    crate::ipc_admin::EXIT_ERROR
                }
            };
        }
        Start::Cannot(why) => {
            let _ = writeln!(err, "error: Rulebox Setup cannot start: {why} Run `rulebox-agent setup` from an administrator prompt.");
            return crate::ipc_admin::EXIT_ERROR;
        }
    }
    let backend = match build_backend(simulate) {
        Ok(backend) => backend,
        Err(error) => {
            let _ = writeln!(err, "error: Rulebox Setup cannot read this PC's Rulebox folders: {error:#}");
            return crate::ipc_admin::EXIT_ERROR;
        }
    };
    ui::show(backend, simulate);
    0
}

fn build_backend(simulate: bool) -> anyhow::Result<Arc<dyn Backend>> {
    if simulate {
        // `SimPlatform::new` only remembers the folder; it creates nothing.
        let platform = Arc::new(SimPlatform::new(std::env::temp_dir().join("rulebox-setup-simulation")));
        return Ok(Arc::new(PlatformBackend {
            platform,
            install_root: std::path::PathBuf::from(r"C:\Program Files\Rulebox"),
            pinned: None,
            agent: Box::new(SimAgent),
        }));
    }
    let install = InstallPaths::from_known_folders()?;
    let paths = DataPaths::from_known_folders()?;
    let install_root = install.root().to_path_buf();
    Ok(Arc::new(PlatformBackend {
        platform: Arc::new(WindowsPlatform::new(install, paths)),
        install_root,
        pinned: webview2::PINNED_SHA256.map(str::to_string),
        agent: Box::new(PipeAgent),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn setup_asks_for_rights_once_and_never_in_a_loop() {
        assert_eq!(start_plan(false, false, Ok(true)), Start::Here);
        assert_eq!(start_plan(false, true, Ok(true)), Start::Here);
        assert_eq!(start_plan(false, false, Ok(false)), Start::Relaunch);
        // The copy Windows started still has no rights: say so, do not ask again.
        assert!(matches!(start_plan(false, true, Ok(false)), Start::Cannot(_)));
        assert!(matches!(start_plan(false, false, Err("x".into())), Start::Cannot(_)));
    }

    #[test]
    fn the_simulation_never_asks_for_rights_or_looks_at_the_machine() {
        for relaunched in [false, true] {
            for elevated in [Ok(true), Ok(false), Err("boom".to_string())] {
                assert_eq!(start_plan(true, relaunched, elevated), Start::Here);
            }
        }
        // And its backend is built from memory only.
        assert!(build_backend(true).is_ok());
    }

    #[test]
    fn the_simulated_setup_reports_a_healthy_pc_and_enrolls() {
        let backend = build_backend(true).unwrap();
        let check = backend.check(false).unwrap();
        assert_eq!(check.enrolled, None);
        assert!(check.report.blockers.is_empty());
        assert!(backend.install_webview2().is_good());
    }
}
