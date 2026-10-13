//! Declares every Tauri command so each one needs an explicit capability
//! permission (`allow-<command>`).

/// Commands callable from `shell-*` windows.
const SHELL_COMMANDS: &[&str] = &[];

/// Commands callable from `app-*` windows. A name may also appear in
/// `SHELL_COMMANDS`.
const APP_COMMANDS: &[&str] = &[];

fn main() {
    let commands = merge(SHELL_COMMANDS, APP_COMMANDS);
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
