//! `rulebox-agent`: service host and CLI. Only `run --console --simulate` is
//! implemented so far (Phase 2, Step 5); the other commands arrive in later steps.

// The skeleton defines the full Platform seam, state and secrets types before the
// tasks that use them exist (Steps 6 to 11). Remove this allow in Step 11.
#![allow(dead_code)]

mod agent;
mod cli;
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
use tokio_util::sync::CancellationToken;

use crate::agent::Deps;
use crate::cli::{Cli, Command};
use crate::paths::DataPaths;
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
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("error: {error:#}");
            ExitCode::FAILURE
        }
    }
}

fn dispatch(cli: Cli) -> anyhow::Result<()> {
    match cli.command {
        Command::Run { simulate: true, data_dir, .. } => run_simulated(data_dir),
        Command::Run { simulate: false, .. } => bail!(
            "`run --console` without --simulate needs WindowsPlatform, which arrives in Step 10 \
             (and only runs on a test machine)"
        ),
        Command::Service { .. } | Command::Recover { .. } => bail!("not implemented yet (Phase 2, Step 11)"),
        Command::Enroll { .. } | Command::Status { .. } | Command::Unenroll { .. } => {
            bail!("not implemented yet (Phase 2, Steps 6 and 8)")
        }
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
        paths,
        config,
        simulate: true,
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
