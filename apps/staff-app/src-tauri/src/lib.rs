//! Rulebox Staff App (Tauri). Privileged work goes through the agent over IPC.

pub mod agent;
pub mod appwin;
pub mod commands;
pub mod exit;
pub mod files;
pub mod known_folders;
pub mod launcher;
mod logging;
pub mod model;
pub mod monitor;
pub mod session;
pub mod shortcuts;
pub mod shellwin;
pub mod system;
pub mod state;
pub mod taskops;
pub mod tasks;
pub mod webapp;

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

    // Icons, control state and launched apps of the task list.
    let services = tasks::TaskServices::default();
    let protocol_icons = Arc::clone(&services.icons);

    // Agent selection (especially `IpcClient::spawn`) needs a Tokio runtime.
    // Tauri installs one before `setup`, so connect there — not earlier.
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|_app, _argv, _cwd| {
            // Second start: nothing to focus yet (the sign-in layer is Step 5).
        }))
        .register_asynchronous_uri_scheme_protocol("rbicon", move |ctx, request, responder| {
            // Window icons are for the shell's own windows only, never a web app's page.
            if !ctx.webview_label().starts_with("shell-") {
                files::protocol::refuse(responder);
                return;
            }
            tasks::serve_icon(&protocol_icons, request, responder);
        })
        // The only local page a web app window may show: "this site is not allowed".
        .register_uri_scheme_protocol("rbblocked", |_ctx, request| webapp::blocked::serve(request))
        .register_asynchronous_uri_scheme_protocol("rbfile", |ctx, request, responder| {
            // A web app's page must never read the employee's files (not even as an image).
            if !files::protocol::label_may_read(ctx.webview_label()) {
                files::protocol::refuse(responder);
                return;
            }
            files::protocol::serve_request(ctx.app_handle(), request, responder);
        })
        .on_menu_event(|app, event| commands::on_menu_event(app, event.id().as_ref()))
        .invoke_handler(tauri::generate_handler![
            commands::shell_state,
            commands::ui_ready,
            commands::ui_alive,
            commands::dismiss_notice,
            commands::notices_seen,
            commands::set_volume,
            commands::set_muted,
            commands::set_brightness,
            commands::set_theme,
            commands::dev_set_display,
            commands::dev_set_boot,
            commands::popup_open,
            commands::popup_close,
            commands::thumb_open,
            commands::thumb_state,
            commands::thumb_attach,
            commands::admin_exit_open,
            commands::admin_exit_hotkey,
            commands::admin_exit_state,
            commands::admin_exit_submit,
            commands::admin_exit_close,
            commands::sign_in,
            commands::sign_in_last,
            commands::switch_user,
            commands::sign_out,
            commands::closing_apps,
            commands::lock,
            commands::unlock,
            commands::power_sleep,
            commands::power_restart,
            commands::power_shut_down,
            commands::restart_rulebox,
            commands::launch_app,
            commands::task_click,
            commands::task_close,
            commands::task_end,
            commands::task_menu,
            commands::show_desktop,
            commands::refresh_catalogue,
            commands::open_doc,
            commands::win_minimize,
            commands::win_toggle_maximize,
            commands::win_close,
            commands::win_snap,
            commands::app_snapshot,
            commands::app_select_tab,
            commands::app_close_tab,
            files::commands::fs_list,
            files::commands::fs_stat,
            files::commands::fs_mkdir,
            files::commands::fs_rename,
            files::commands::fs_copy,
            files::commands::fs_move,
            files::commands::fs_trash,
            files::commands::fs_trash_list,
            files::commands::fs_restore,
            files::commands::fs_purge,
            files::commands::fs_usage,
            files::commands::fs_search,
            files::commands::fs_recent,
            files::commands::fs_files,
            files::commands::fs_clip_set,
            files::commands::fs_clip_get,
            files::commands::fs_paste,
            files::commands::fs_handler,
            files::commands::fs_open,
            files::commands::fs_open_with,
            files::commands::fs_read_text,
            files::commands::fs_read_csv,
            files::commands::fs_office_check,
            files::commands::fs_image_info,
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
            let can_power_off = rulebox_desktop::power::can_power_off();
            let can_sleep = rulebox_desktop::power::can_sleep();
            tracing::info!(can_power_off, can_sleep, "shutdown privilege and sleep support");
            app_state.update(|shell| {
                shell.system.can_power_off = can_power_off;
                shell.system.can_sleep = can_sleep;
            });
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

            app.manage(services.clone());
            app.manage(std::sync::Arc::new(appwin::AppWindows::default()));
            app.manage(std::sync::Arc::new(webapp::WebApps::default()));
            let host = shellwin::init(app.handle(), mode, services.clone())?;
            app.manage(host);
            // Debug builds: live CPU and memory per app in the taskbar (developer aid).
            monitor::start(app.handle());
            // Nobody is signed in yet. If the app died while someone was,
            // their folder is still Documents, Desktop and Downloads: undo it.
            let startup = app.handle().clone();
            tauri::async_runtime::spawn_blocking(move || known_folders::restore(Some(&startup)));
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