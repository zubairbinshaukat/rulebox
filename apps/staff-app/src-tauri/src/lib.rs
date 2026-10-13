//! Rulebox Staff App (Tauri). Privileged work goes through the agent over IPC.

pub mod agent;
pub mod commands;
mod logging;
pub mod model;
pub mod state;

use std::backtrace::Backtrace;
use std::fs::OpenOptions;
use std::io::Write;
use std::sync::OnceLock;

use tauri::Manager;
use tracing_appender::non_blocking::WorkerGuard;

use crate::model::{ShellModeDto, ShellState};
use crate::state::{spawn_agent_tasks, AppState};

/// Kept alive so buffered log lines flush on exit.
static LOG_GUARD: OnceLock<WorkerGuard> = OnceLock::new();
static PANIC_LOG_DIR: OnceLock<std::path::PathBuf> = OnceLock::new();

fn install_panic_hook() {
    std::panic::set_hook(Box::new(|info| {
        let text = format!("panic: {info}\n{}", Backtrace::force_capture());
        tracing::error!("{text}");
        eprintln!("{text}");
        if let Some(dir) = PANIC_LOG_DIR.get() {
            if let Ok(mut file) = OpenOptions::new()
                .create(true)
                .append(true)
                .open(dir.join("staff-panic.log"))
            {
                let _ = writeln!(file, "{text}");
                let _ = file.sync_all();
            }
        }
        std::process::exit(1);
    }));
}

fn shell_mode_dto() -> ShellModeDto {
    match rulebox_desktop::mode::detect() {
        rulebox_desktop::ShellMode::Shell => ShellModeDto::Shell,
        rulebox_desktop::ShellMode::Dev => ShellModeDto::Dev,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    install_panic_hook();

    match logging::init() {
        Ok(guard) => {
            let _ = LOG_GUARD.set(guard);
            if let Some(dir) = logging::log_dir() {
                let _ = PANIC_LOG_DIR.set(dir);
            }
        }
        Err(error) => {
            eprintln!("logging init failed: {error}");
        }
    }

    // Agent selection (especially `IpcClient::spawn`) needs a Tokio runtime.
    // Tauri installs one before `setup`, so connect there — not earlier.
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|_app, _argv, _cwd| {
            // Second start: do nothing (no windows to focus until Step 4).
        }))
        .invoke_handler(tauri::generate_handler![
            commands::shell_state,
            commands::ui_ready,
            commands::ui_alive,
            commands::dismiss_notice,
            commands::dev_set_display,
        ])
        .setup(|app| {
            // `IpcClient::spawn` calls `tokio::spawn`; run inside Tauri's runtime.
            let agent =
                tauri::async_runtime::block_on(async { agent::select_agent() });
            let app_state = AppState::new(agent, ShellState::initial(shell_mode_dto()));
            app_state.bind_app(app.handle().clone());
            spawn_agent_tasks(app_state.clone());
            app.manage(app_state);
            tracing::info!(
                mode = ?shell_mode_dto(),
                "AppState ready (no windows yet — Step 4)"
            );
            Ok(())
        });

    if let Err(error) = builder.run(tauri::generate_context!()) {
        tracing::error!("error while running Rulebox Staff App: {error}");
        std::process::exit(1);
    }
}
