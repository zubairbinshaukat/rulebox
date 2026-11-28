//! `rulebox-agent`: service host and CLI. `run --console`, the admin-pipe commands
//! `status`, `enroll` and `unenroll`, `compat`, `hash-pin`, and (Step 11) the
//! service host and its commands `service run|install|uninstall` and `recover`.
//! (Phase 6 Step 8) `setup`: Rulebox Setup, a small native window.

mod admin_exit;
mod agent;
mod agent_policy;
mod audit;
mod backend;
mod browser_profiles;
mod catalog;
mod cleanup;
mod cli;
mod compat;
mod config;
mod directory;
mod employee_cache;
mod enroll;
mod enroll_code;
mod fixtures;
mod install_marker;
mod installs;
mod ipc_admin;
mod ipc_conn;
mod ipc_shell;
mod journal;
mod kdf;
mod kiosk;
mod kiosk_control;
mod lockdown;
mod lockout;
mod logging;
mod network;
mod notice;
mod paths;
mod platform;
mod purge;
mod recover;
mod report;
mod roster;
mod secrets;
mod selfupdate;
mod service;
mod session;
mod setup;
mod state;
#[cfg(test)]
mod testutil;
mod trust;
mod watchdog;

use std::backtrace::Backtrace;
use std::io::Write;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::{Arc, OnceLock};

/// This agent's version: the release tag's x.y.z in a release build (`RULEBOX_VERSION`, set by the
/// release workflow), else the package version. Everything that reports or compares the agent's
/// version uses this, never `CARGO_PKG_VERSION` (see `build.rs`, `embed_version`).
pub const AGENT_VERSION: &str = env!("RULEBOX_AGENT_VERSION");

use anyhow::Context;
use clap::Parser;
use rulebox_ipc::admin::{AdminEnrollParams, AdminTrustKeyParams, AdminUnenrollParams};
use rulebox_ipc::client::ClientConfig;
use tokio_util::sync::CancellationToken;

use crate::agent::{Deps, DirectorySetup, PipeNames, SimOptions, SinkSetup};
use crate::cli::{Cli, Command, ServiceAction};
use crate::paths::{DataPaths, InstallPaths};
use crate::platform::sim::SimPlatform;

/// Set once the log directory is known, so the panic hook can append to `agent-panic.log`.
static PANIC_LOG_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Logs the panic (message, location, backtrace), appends the same text to
/// `<logs>\agent-panic.log` synchronously, then ends the process with a failure
/// code so the service manager restarts it. It never reports a clean stop.
fn install_panic_hook() {
    std::panic::set_hook(Box::new(|info| {
        let text = format!("panic: {info}\n{}", Backtrace::force_capture());
        tracing::error!("{text}");
        eprintln!("{text}");
        if let Some(dir) = PANIC_LOG_DIR.get() {
            let line = format!("[{}] {text}\n", state::unix_ms());
            if let Ok(mut file) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(dir.join("agent-panic.log"))
            {
                let _ = file.write_all(line.as_bytes());
                let _ = file.sync_all();
            }
        }
        std::process::exit(101);
    }));
}

fn main() -> ExitCode {
    install_panic_hook();
    match dispatch(Cli::parse()) {
        Ok(code) => ExitCode::from(code),
        Err(error) => {
            eprintln!("error: {error:#}");
            ExitCode::FAILURE
        }
    }
}

/// Runs a command and returns the process exit code (0 = success; see
/// `ipc_admin::EXIT_*` for the admin commands).
fn dispatch(cli: Cli) -> anyhow::Result<u8> {
    match cli.command {
        Command::Run { simulate: true, data_dir, sim_demo, sim_offline, sim_staff_session, .. } => {
            run_simulated(data_dir, sim_demo, sim_offline, sim_staff_session).map(|()| 0)
        }
        Command::Run { simulate: false, .. } => run_real(),
        // Step 11. The service host, its install and uninstall, and the offline
        // recovery. The last three change the machine and start with the guard.
        Command::Service { action: ServiceAction::Run } => Ok(service::run_dispatcher(&mut std::io::stderr().lock())),
        Command::Service { action: ServiceAction::Install } => {
            Ok(service::run_install(&mut std::io::stdout().lock(), &mut std::io::stderr().lock()))
        }
        Command::Service { action: ServiceAction::Uninstall { force } } => {
            Ok(service::run_uninstall(force, &mut std::io::stdout().lock(), &mut std::io::stderr().lock()))
        }
        Command::Recover { yes, forget: None } => Ok(recover::run_recover(
            yes,
            &mut std::io::stdin().lock(),
            &mut std::io::stdout().lock(),
            &mut std::io::stderr().lock(),
        )),
        // (Q-A8) One journal entry whose value is already back; the rest of `recover` does not run.
        Command::Recover { yes, forget: Some(id) } => Ok(recover::run_forget(
            &id,
            yes,
            &mut std::io::stdin().lock(),
            &mut std::io::stdout().lock(),
            &mut std::io::stderr().lock(),
        )),
        // (Q-A6) The MSI's uninstall-only step: everything in the data directory but `logs\`.
        Command::PurgeData => Ok(purge::run_purge_data(&mut std::io::stdout().lock(), &mut std::io::stderr().lock())),
        // The admin commands talk to the running service over the admin pipe. They
        // start no logging and open no data directory (plan Section 5.1).
        Command::Status { json, simulate } => {
            let code = ipc_admin::run_status(
                ClientConfig::admin(simulate).with_timeout(ipc_admin::DEFAULT_TIMEOUT),
                json,
                &mut std::io::stdout().lock(),
                &mut std::io::stderr().lock(),
            );
            // `recover` left a flag: say so (a stat of one file; nothing is opened).
            if code == 0 && !json && !simulate {
                let line = DataPaths::from_known_folders().ok().and_then(|paths| recover::status_line(&paths));
                if let Some(line) = line {
                    let _ = writeln!(std::io::stdout().lock(), "{line}");
                }
            }
            Ok(code)
        }
        Command::Enroll { code, name, allow_joined, simulate } => Ok(ipc_admin::run_enroll(
            ClientConfig::admin(simulate).with_timeout(ipc_admin::ENROLL_TIMEOUT),
            AdminEnrollParams { code, device_name: name, allow_joined },
            &mut std::io::stdout().lock(),
            &mut std::io::stderr().lock(),
        )),
        Command::Unenroll { remove_staff_account, simulate } => Ok(ipc_admin::run_unenroll(
            ClientConfig::admin(simulate).with_timeout(ipc_admin::DEFAULT_TIMEOUT),
            AdminUnenrollParams { remove_staff_account },
            &mut std::io::stdout().lock(),
            &mut std::io::stderr().lock(),
        )),
        Command::TrustKey { public_key, simulate } => Ok(ipc_admin::run_trust_key(
            ClientConfig::admin(simulate).with_timeout(ipc_admin::DEFAULT_TIMEOUT),
            AdminTrustKeyParams { public_key },
            &mut std::io::stdout().lock(),
            &mut std::io::stderr().lock(),
        )),
        Command::Compat { json } => run_compat(json, &mut std::io::stdout().lock()),
        // (Phase 5 Step 20) Read-only, like `compat`: no logging, no pipe, nothing written.
        Command::LockdownStatus { json } => {
            logging::init_stderr_only();
            Ok(lockdown::status::run(json, &mut std::io::stdout().lock(), &mut std::io::stderr().lock()))
        }
        // (Phase 6 Step 5) Read-only: the machine guard's conditions. No logging, no pipe.
        Command::GuardStatus { json } => Ok(config::run_guard_status(json, &mut std::io::stdout().lock())),
        Command::HashPin => Ok(hash_pin(
            &mut std::io::stdin().lock(),
            &mut std::io::stdout().lock(),
            &mut std::io::stderr().lock(),
        )),
        // (Phase 6 Step 8) Rulebox Setup: no data directory and no logging of its own (the
        // checks are read-only; the changes go through the service and the guarded seam).
        Command::Setup { simulate, relaunched } => Ok(setup::run(simulate, relaunched, &mut std::io::stderr().lock())),
    }
}

/// `rulebox-agent hash-pin`: prompts on stderr, reads one line from `input`, and
/// prints the Argon2id hash of a PIN of 6 to 12 ASCII digits on `out` (exit code
/// 0). Anything else is refused with exit code 1. Starts no logging and touches no
/// file, pipe or registry key, so it is safe on every machine.
fn hash_pin(
    input: &mut dyn std::io::BufRead,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> u8 {
    // A failed write to stderr is not worth a second error.
    let _ = write!(err, "PIN (6 to 12 digits): ");
    let _ = err.flush();
    let mut line = String::new();
    if let Err(error) = input.read_line(&mut line) {
        let _ = writeln!(err, "error: cannot read the PIN: {error}");
        return ipc_admin::EXIT_ERROR;
    }
    match admin_exit::hash_pin_line(&line) {
        Ok(hash) => {
            let _ = writeln!(out, "{hash}");
            0
        }
        Err(error) => {
            let _ = writeln!(err, "error: {error}");
            ipc_admin::EXIT_ERROR
        }
    }
}

/// `run --console --simulate`: in-memory platform, throwaway data directory,
/// stops on Ctrl+C. Touches nothing outside the data directory. `--sim-demo` adds
/// the demo world (plan Section 6.11) and `--sim-offline` makes it offline.
/// `--sim-staff-session` (Step 13) adds a simulated signed-in Staff session, so the
/// watchdog has something to watch.
fn run_simulated(
    data_dir: Option<PathBuf>,
    sim_demo: bool,
    sim_offline: bool,
    sim_staff_session: bool,
) -> anyhow::Result<()> {
    let paths = match data_dir {
        Some(dir) => DataPaths::new(dir),
        None => DataPaths::simulate_default()?,
    };
    let guard = logging::init(&paths.logs_dir(), true)?;
    let _ = PANIC_LOG_DIR.set(paths.logs_dir());
    tracing::info!("simulate mode: data directory {}", paths.root().display());

    let config = agent::load_config(&paths)?;
    // (Step 13) Fixture employees only in the demo world; otherwise the Convex
    // directory and report sink, like the real agent.
    let choice = directory::choose(sim_demo);
    let platform = SimPlatform::new(paths.root().to_path_buf());
    if sim_staff_session {
        platform.add_session(watchdog::SIM_STAFF_SESSION, Some(watchdog::SIM_STAFF_SID), true);
    }
    let deps = Deps {
        platform: Arc::new(platform),
        backend_factory: backend::convex::ConvexBackend::factory(),
        // Simulate mode checks no binary paths; this is a placeholder.
        install: InstallPaths::new(paths.root().join("install")),
        paths,
        config,
        simulate: true,
        pipes: PipeNames::for_mode(true),
        directory: match choice {
            directory::DirectoryChoice::Fixture => DirectorySetup::Use(Arc::new(directory::FixtureDirectory::new(sim_offline))),
            directory::DirectoryChoice::Convex => DirectorySetup::Convex,
        },
        audit_sink: if sim_demo { SinkSetup::Use(Arc::new(audit::LogAuditSink)) } else { SinkSetup::Convex },
        sim: SimOptions { demo: sim_demo, offline: sim_offline, staff_session: sim_staff_session },
        // (Phase 4 Step 14) Real downloads into the simulate data directory; the
        // installs themselves are faked by `SimPlatform`.
        downloader: Arc::new(installs::download::HttpDownloader::new()?),
    };

    let result = run_with_runtime(deps);
    drop(guard);
    result
}

/// Runs the agent on its own tokio runtime until Ctrl+C.
fn run_with_runtime(deps: Deps) -> anyhow::Result<()> {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .context("start the async runtime")?;
    let shutdown = CancellationToken::new();
    // Console mode has no session or power events (the service host feeds those, see
    // `service.rs`); the sender stays open so the receiver keeps waiting for shutdown.
    let (_control_tx, control_rx) = tokio::sync::mpsc::unbounded_channel();
    let result = runtime.block_on(async {
        let on_ctrl_c = shutdown.clone();
        tokio::spawn(async move {
            if tokio::signal::ctrl_c().await.is_ok() {
                tracing::info!("Ctrl+C received, stopping");
                on_ctrl_c.cancel();
            }
        });
        agent::run(deps, shutdown, control_rx).await
    });
    if let Err(error) = &result {
        tracing::error!("agent failed: {error:#}");
    }
    result
}

/// `run --console` without `--simulate`: the real platform on the real data
/// directory. The protected-directory check (plan Section 5.1) runs first, before
/// anything is read or written and before logging, which lives in that directory.
/// If the check refuses, nothing is created and the exit code is 1. Creating or
/// repairing the directory is guarded, so on a machine that is not armed (no test
/// marker, no production install) this ends here.
fn run_real() -> anyhow::Result<u8> {
    let paths = DataPaths::from_known_folders()?;
    let install = InstallPaths::from_known_folders()?;
    if let Err(error) = platform::windows::ensure_data_dir(paths.root()) {
        eprintln!("error: {error:#}");
        return Ok(1);
    }
    let guard = logging::init(&paths.logs_dir(), true)?;
    let _ = PANIC_LOG_DIR.set(paths.logs_dir());
    tracing::info!("console mode: data directory {}", paths.root().display());

    let result = real_deps(paths, install).and_then(run_with_runtime);
    drop(guard);
    result.map(|()| 0)
}

/// The dependencies of the real agent on this PC, shared by console mode and the
/// service host. The data directory has been checked by the caller, which also
/// started logging.
pub(crate) fn real_deps(paths: DataPaths, install: InstallPaths) -> anyhow::Result<Deps> {
    let config = agent::load_config(&paths)?;
    Ok(Deps {
        platform: Arc::new(platform::windows::WindowsPlatform::new(install.clone(), paths.clone())),
        backend_factory: backend::convex::ConvexBackend::factory(),
        install,
        paths,
        config,
        simulate: false,
        pipes: PipeNames::for_mode(false),
        // (Step 13) The real directory and report sink.
        directory: DirectorySetup::Convex,
        audit_sink: SinkSetup::Convex,
        sim: SimOptions::default(),
        downloader: Arc::new(installs::download::HttpDownloader::new()?),
    })
}

/// `compat [--json]`: reads this PC and prints the compatibility report. It builds
/// a `WindowsPlatform` but never checks or opens the data directory, never starts
/// file logging and never opens the state store, so it is safe on every machine.
fn run_compat(json: bool, out: &mut dyn Write) -> anyhow::Result<u8> {
    logging::init_stderr_only();
    let platform = platform::windows::WindowsPlatform::new(
        InstallPaths::from_known_folders()?,
        DataPaths::from_known_folders()?,
    );
    let report = compat::build(&platform, None, false).context("read this PC")?;
    if json {
        writeln!(out, "{}", serde_json::to_string_pretty(&report.to_json())?)?;
    } else {
        report.write_text(out)?;
    }
    Ok(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(input: &str) -> (u8, String, String) {
        let (mut out, mut err) = (Vec::new(), Vec::new());
        let code = hash_pin(&mut input.as_bytes(), &mut out, &mut err);
        (code, String::from_utf8(out).unwrap(), String::from_utf8(err).unwrap())
    }

    #[test]
    fn hash_pin_prompts_on_stderr_and_prints_only_the_hash_on_stdout() {
        let (code, out, err) = run("246810\r\n");
        assert_eq!(code, 0);
        assert!(out.starts_with("$argon2id$v=19$m=19456,t=2,p=1$"), "{out}");
        assert_eq!(out.lines().count(), 1);
        assert!(kdf::verify_secret("246810", out.trim()).unwrap());
        assert_eq!(err, "PIN (6 to 12 digits): ");
    }

    #[test]
    fn hash_pin_rejects_anything_that_is_not_six_to_twelve_digits() {
        for bad in ["12\n", "2468\n", "12345\n", "12a456\n", "1234567890123\n", "\n", ""] {
            let (code, out, err) = run(bad);
            assert_eq!(code, 1, "{bad:?}");
            assert!(out.is_empty(), "nothing on stdout for {bad:?}");
            assert!(err.contains("6 to 12 digits"), "{err}");
        }
    }

    #[test]
    fn the_agent_version_is_the_release_version_or_the_package_version_and_has_an_order() {
        // Self-update compares the release with this value (Step 22 run A: a release agent said 0.0.0).
        match option_env!("RULEBOX_VERSION").map(str::trim).filter(|v| !v.is_empty()) {
            Some(release) => assert_eq!(AGENT_VERSION, release),
            None => assert_eq!(AGENT_VERSION, env!("CARGO_PKG_VERSION")),
        }
        assert!(rulebox_policy::version::cmp(AGENT_VERSION, "0.0.0").is_some(), "{AGENT_VERSION} must be ordered");
        let help = <cli::Cli as clap::CommandFactory>::command().render_version().to_string();
        assert_eq!(help.trim(), format!("rulebox-agent {AGENT_VERSION}"), "--version prints the same number build.ps1 checks");
    }
}
