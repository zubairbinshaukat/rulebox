//! Rulebox Staff App (Tauri). Privileged work goes through the agent over IPC.

pub mod agent;
pub mod commands;
mod logging;
pub mod model;
pub mod session;
pub mod shellwin;
pub mod state;
pub mod tasks;

use std::backtrace::Backtrace;
use std::fs::OpenOptions;
use std::io::Write;
use std::sync::{Arc, OnceLock};

use tauri::{Manager, RunEvent};
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

fn shell_mode_dto(mode: rulebox_desktop::ShellMode) -> ShellModeDto {
    match mode {
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

    // Every coordinate the shell handles is a physical pixel.
    rulebox_desktop::workarea::ensure_dpi_aware();
    // Decided once. Shell mode only when no Explorer owns the shell window.
    let mode = rulebox_desktop::mode::detect();

    // Icons of tracked windows, served to the taskbar by `rbicon://`.
    let icons = Arc::new(tasks::IconStore::default());
    let protocol_icons = Arc::clone(&icons);

    // Agent selection (especially `IpcClient::spawn`) needs a Tokio runtime.
    // Tauri installs one before `setup`, so connect there — not earlier.
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|_app, _argv, _cwd| {
            // Second start: nothing to focus yet (the sign-in layer is Step 5).
        }))
        .register_asynchronous_uri_scheme_protocol("rbicon", move |_ctx, request, responder| {
            tasks::serve_icon(&protocol_icons, request, responder);
        })
        .invoke_handler(tauri::generate_handler![
            commands::shell_state,
            commands::ui_ready,
            commands::ui_alive,
            commands::dismiss_notice,
            commands::dev_set_display,
            commands::dev_set_boot,
            commands::popup_open,
            commands::popup_close,
            commands::sign_in,
            commands::sign_in_last,
            commands::switch_user,
            commands::launch_app,
            commands::refresh_catalogue,
        ])
        .setup(move |app| {
            // `IpcClient::spawn` calls `tokio::spawn`; run inside Tauri's runtime.
            let agent = tauri::async_runtime::block_on(async { agent::select_agent() });
            let mut initial = ShellState::initial(shell_mode_dto(mode));
            if let Some(last) = session::load_last_user() {
                initial.session = crate::model::SessionState::SignedOut { last: Some(last) };
            }
            let app_state = AppState::new(agent, initial);
            app_state.bind_app(app.handle().clone());
            spawn_agent_tasks(app_state.clone());
            // Screenshot automation: any process of this user can write the
            // file it polls, so it runs only in dev mode and only when asked.
            #[cfg(debug_assertions)]
            if mode == rulebox_desktop::ShellMode::Dev
                && std::env::var_os("RULEBOX_STAFF_DEV_CMD").is_some()
            {
                commands::spawn_dev_cmd_poller(app_state.clone());
            }
            app.manage(app_state);

            let host = shellwin::init(app.handle(), mode, Arc::clone(&icons))?;
            app.manage(host);
            tracing::info!(?mode, "shell windows ready");
            Ok(())
        });

    let app = match builder.build(tauri::generate_context!()) {
        Ok(app) => app,
        Err(error) => {
            tracing::error!("error while building Rulebox Staff App: {error}");
            std::process::exit(1);
        }
    };

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            // Gives the Windows work area back in shell mode.
            if let Some(host) = handle.try_state::<std::sync::Arc<shellwin::DesktopHost>>() {
                host.shutdown();
            }
        }
    });
}