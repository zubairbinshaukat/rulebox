//! Declares every Tauri command so each one needs an explicit capability
//! permission (`allow-<command>`).

/// Commands callable from `shell-*` windows.
const SHELL_COMMANDS: &[&str] = &[
    "shell_state",
    "ui_ready",
    "ui_alive",
    "dev_note",
    "dismiss_notice",
    "notices_seen",
    "set_volume",
    "set_muted",
    "set_brightness",
    "set_theme",
    "dev_set_display",
    "dev_set_boot",
    "popup_open",
    "popup_close",
    "thumb_open",
    "admin_exit_open",
    "admin_exit_hotkey",
    "sign_in",
    "sign_in_last",
    "switch_user",
    "sign_out",
    "closing_apps",
    "lock",
    "unlock",
    "power_sleep",
    "power_restart",
    "power_shut_down",
    "restart_rulebox",
    "launch_app",
    "task_click",
    "task_close",
    "task_end",
    "task_menu",
    "show_desktop",
    "refresh_catalogue",
    "open_doc",
    // Files (Step 12): the desktop panel and the Start menu only read.
    "fs_list",
    "fs_search",
    "fs_recent",
    "fs_files",
    "fs_open",
];

/// Commands callable from `app-*` windows. A name may also appear in
/// `SHELL_COMMANDS`.
const APP_COMMANDS: &[&str] = &[
    "shell_state",
    "dismiss_notice",
    "open_doc",
    "win_minimize",
    "win_toggle_maximize",
    "win_close",
    "win_snap",
    "app_snapshot",
    "app_select_tab",
    "app_close_tab",
    "admin_exit_open",
    "admin_exit_hotkey",
    "fs_list",
    "fs_stat",
    "fs_mkdir",
    "fs_rename",
    "fs_copy",
    "fs_move",
    "fs_trash",
    "fs_trash_list",
    "fs_restore",
    "fs_purge",
    "fs_usage",
    "fs_search",
    "fs_recent",
    "fs_files",
    "fs_clip_set",
    "fs_clip_get",
    "fs_paste",
    "fs_handler",
    "fs_open",
    "fs_open_with",
    "fs_read_text",
    "fs_read_csv",
    "fs_office_check",
    "fs_image_info",
];

/// Commands only the popup page may call (the thumbnail preview).
const POPUP_COMMANDS: &[&str] = &["thumb_state", "thumb_attach"];

/// Commands only the administrator-exit dialog may call.
const EXIT_COMMANDS: &[&str] = &["admin_exit_state", "admin_exit_submit", "admin_exit_close", "admin_exit_hotkey"];

fn main() {
    let commands = merge(&merge(SHELL_COMMANDS, APP_COMMANDS), &merge(POPUP_COMMANDS, EXIT_COMMANDS));
    // `AppManifest::commands` wants a `&'static [&'static str]`.
    let commands: &'static [&'static str] = Box::leak(commands.into_boxed_slice());
    let attributes = tauri_build::Attributes::new()
        .app_manifest(tauri_build::AppManifest::new().commands(commands));
    if let Err(error) = tauri_build::try_build(attributes) {
        panic!("failed to run tauri-build: {error}");
    }
}

fn merge(a: &[&'static str], b: &[&'static str]) -> Vec<&'static str> {
    let mut out = Vec::with_capacity(a.len() + b.len());
    for name in a.iter().chain(b.iter()) {
        if !out.contains(name) {
            out.push(*name);
        }
    }
    out
}
