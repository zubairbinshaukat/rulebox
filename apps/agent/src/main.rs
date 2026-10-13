//! `rulebox-agent`: service host and CLI. `run --console --simulate` (Step 5) and
//! the admin-pipe commands `status`, `enroll` and `unenroll` (Step 6) are
//! implemented; the other commands arrive in later steps.

// The skeleton defines the full Platform seam, state and secrets types before the
// tasks that use them exist (Steps 6 to 11). Remove this allow in Step 11.
#![allow(dead_code)]

mod admin_exit;
mod agent;
mod agent_policy;
mod audit;
mod backend;
mod cli;
mod compat;
mod directory;
mod employee_cache;
mod enroll;
mod enroll_code;
mod fixtures;
mod ipc_admin;
mod ipc_conn;
mod ipc_shell;
mod kdf;
mod kiosk;
mod kiosk_control;
mod lockout;
mod logging;
mod paths;
mod platform;
mod secrets;
mod session;
mod state;
#[cfg(test)]
mod testutil;

use std::backtrace::Backtrace;
use std::io::Write;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::{Arc, OnceLock};

use anyhow::{bail, Context};
use clap::Parser;
use rulebox_ipc::admin::{AdminEnrollParams, AdminUnenrollParams};
use rulebox_ipc::client::ClientConfig;
use tokio_util::sync::CancellationToken;

use crate::agent::{Deps, PipeNames, SimOptions};
use crate::cli::{Cli, Command};
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
        Command::Run { simulate: true, data_dir, sim_demo, sim_offline, .. } => {
            run_simulated(data_dir, sim_demo, sim_offline).map(|()| 0)
        }
        Command::Run { simulate: false, .. } => bail!(
            "`run --console` without --simulate needs WindowsPlatform, which arrives in Step 10 \
             (and only runs on a test machine)"
        ),
        Command::Service { .. } | Command::Recover { .. } => bail!("not implemented yet (Phase 2, Step 11)"),
        // The admin commands talk to the running service over the admin pipe. They
        // start no logging and open no data directory (plan Section 5.1).
        Command::Status { json, simulate } => Ok(ipc_admin::run_status(
            ClientConfig::admin(simulate).with_timeout(ipc_admin::DEFAULT_TIMEOUT),
            json,
            &mut std::io::stdout().lock(),
            &mut std::io::stderr().lock(),
        )),
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
        Command::Compat { .. } => bail!("not implemented yet (Phase 2, a later step)"),
        Command::HashPin => Ok(hash_pin(
            &mut std::io::stdin().lock(),
            &mut std::io::stdout().lock(),
            &mut std::io::stderr().lock(),
        )),
    }
}

/// `rulebox-agent hash-pin`: prompts on stderr, reads one line from `input`, and
/// prints the Argon2id hash of a PIN of 4 to 12 ASCII digits on `out` (exit code
/// 0). Anything else is refused with exit code 1. Starts no logging and touches no
/// file, pipe or registry key, so it is safe on every machine.
fn hash_pin(
    input: &mut dyn std::io::BufRead,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> u8 {
    // A failed write to stderr is not worth a second error.
    let _ = write!(err, "PIN (4 to 12 digits): ");
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
fn run_simulated(data_dir: Option<PathBuf>, sim_demo: bool, sim_offline: bool) -> anyhow::Result<()> {
    let paths = match data_dir {
        Some(dir) => DataPaths::new(dir),
        None => DataPaths::simulate_default()?,
    };
    let guard = logging::init(&paths.logs_dir(), true)?;
    let _ = PANIC_LOG_DIR.set(paths.logs_dir());
    tracing::info!("simulate mode: data directory {}", paths.root().display());

    let config = agent::load_config(&paths)?;
    // The one decision about fixture employees (also used by the real agent in
    // Steps 10 and 11): the demo world, or both the config key and the marker.
    let choice = directory::choose(&config, rulebox_win32::guard::is_test_machine(), sim_demo);
    let deps = Deps {
        platform: Arc::new(SimPlatform::new(paths.root().to_path_buf())),
        backend_factory: backend::convex::ConvexBackend::factory(),
        // Simulate mode checks no binary paths; this is a placeholder.
        install: InstallPaths::new(paths.root().join("install")),
        paths,
        config,
        simulate: true,
        pipes: PipeNames::for_mode(true),
        directory: directory::build(choice, sim_offline),
        audit_sink: Arc::new(audit::LogAuditSink),
        sim: SimOptions { demo: sim_demo, offline: sim_offline },
    };

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .context("start the async runtime")?;
    let shutdown = CancellationToken::new();
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
    drop(guard);
    result
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
        let (code, out, err) = run("2468\r\n");
        assert_eq!(code, 0);
        assert!(out.starts_with("$argon2id$v=19$m=19456,t=2,p=1$"), "{out}");
        assert_eq!(out.lines().count(), 1);
        assert!(kdf::verify_secret("2468", out.trim()).unwrap());
        assert_eq!(err, "PIN (4 to 12 digits): ");
    }

    #[test]
    fn hash_pin_rejects_anything_that_is_not_four_to_twelve_digits() {
        for bad in ["12\n", "12a4\n", "1234567890123\n", "\n", ""] {
            let (code, out, err) = run(bad);
            assert_eq!(code, 1, "{bad:?}");
            assert!(out.is_empty(), "nothing on stdout for {bad:?}");
            assert!(err.contains("4 to 12 digits"), "{err}");
        }
    }
}
