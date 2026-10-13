//! Thin `#[tauri::command]` wrappers. Every command checks the caller's
//! window label prefix before doing anything.

use tauri::{State, Window};

use crate::model::{ShellState, ThemeDto};
use crate::state::AppState;

/// Why a command refused to run.
#[derive(Debug, thiserror::Error)]
pub enum CommandError {
    #[error("forbidden")]
    Forbidden,
    #[error("{0}")]
    Agent(#[from] crate::agent::AgentError),
}

impl serde::Serialize for CommandError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(self.to_string().as_ref())
    }
}

/// Return `Forbidden` unless the window label starts with `prefix`
/// (`"shell-"` or `"app-"`).
pub fn require_label(window: &Window, prefix: &str) -> Result<(), CommandError> {
    if window.label().starts_with(prefix) {
        Ok(())
    } else {
        Err(CommandError::Forbidden)
    }
}

fn require_shell_or_app(window: &Window) -> Result<(), CommandError> {
    let label = window.label();
    if label.starts_with("shell-") || label.starts_with("app-") {
        Ok(())
    } else {
        Err(CommandError::Forbidden)
    }
}

#[tauri::command]
pub fn shell_state(window: Window, state: State<'_, AppState>) -> Result<ShellState, CommandError> {
    require_shell_or_app(&window)?;
    Ok(state.snapshot())
}

#[tauri::command]
pub async fn ui_ready(window: Window, state: State<'_, AppState>) -> Result<(), CommandError> {
    require_label(&window, "shell-")?;
    state.mark_ui_alive();
    if state.take_ready_slot() {
        state.agent().ready().await?;
    }
    Ok(())
}

#[tauri::command]
pub fn ui_alive(window: Window, state: State<'_, AppState>) -> Result<(), CommandError> {
    require_label(&window, "shell-")?;
    state.mark_ui_alive();
    Ok(())
}

#[tauri::command]
pub fn dismiss_notice(
    window: Window,
    state: State<'_, AppState>,
    id: u32,
) -> Result<(), CommandError> {
    require_shell_or_app(&window)?;
    state.dismiss_notice(id);
    Ok(())
}

/// Debug overlay only. Release builds keep the ACL entry but always refuse.
#[tauri::command]
pub fn dev_set_display(
    window: Window,
    state: State<'_, AppState>,
    lite: bool,
    theme: ThemeDto,
) -> Result<(), CommandError> {
    require_label(&window, "shell-")?;
    #[cfg(debug_assertions)]
    {
        state.update(|s| {
            s.display.lite = lite;
            s.display.theme = theme;
        });
        Ok(())
    }
    #[cfg(not(debug_assertions))]
    {
        let _ = (state, lite, theme);
        Err(CommandError::Forbidden)
    }
}
