//! `rulebox-agent`: service host and CLI. `run --console --simulate` (Step 5) and
//! the admin-pipe commands `status`, `enroll` and `unenroll` (Step 6) are
//! implemented; the other commands arrive in later steps.

// The skeleton defines the full Platform seam, state and secrets types before the
// tasks that use them exist (Steps 6 to 11). Remove this allow in Step 11.
#![allow(dead_code)]

mod agent;
mod cli;
mod ipc_admin;
mod ipc_conn;
mod ipc_shell;
mod logging;
mod paths;
mod platform;
mod secrets;
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

use crate::agent::{Deps, PipeNames};
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
        Command::Run { simulate: true, data_dir, .. } => run_simulated(data_dir).map(|()| 0),
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
    }
}

/// `run --console --simulate`: in-memory platform, throwaway data directory,
/// stops on Ctrl+C. Touches nothing outside the data directory.
fn run_simulated(data_dir: Option<PathBuf>) -> anyhow::Result<()> {
    let paths = match data_dir {
        Some(dir) => DataPaths::new(dir),
        None => DataPaths::simulate_default()?,
    };
    let guard = logging::init(&paths.logs_dir(), true)?;
    let _ = PANIC_LOG_DIR.set(paths.logs_dir());
    tracing::info!("simulate mode: data directory {}", paths.root().display());

    let config = agent::load_config(&paths)?;
    let deps = Deps {
        platform: Arc::new(SimPlatform::new(paths.root().to_path_buf())),
        // Simulate mode checks no binary paths; this is a placeholder.
        install: InstallPaths::new(paths.root().join("install")),
        paths,
        config,
        simulate: true,
        pipes: PipeNames::for_mode(true),
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
