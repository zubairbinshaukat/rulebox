//! Rulebox Staff App (Tauri). Privileged work goes through the agent over IPC.

mod commands;
mod logging;

use std::backtrace::Backtrace;
use std::fs::OpenOptions;
use std::io::Write;
use std::sync::OnceLock;

use tracing_appender::non_blocking::WorkerGuard;

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

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|_app, _argv, _cwd| {
            // Second start: do nothing (no windows to focus in Step 1).
        }))
        .setup(|_app| {
            tracing::info!("no windows yet");
            Ok(())
        });

    if let Err(error) = builder.run(tauri::generate_context!()) {
        tracing::error!("error while running Rulebox Staff App: {error}");
        std::process::exit(1);
    }
}
