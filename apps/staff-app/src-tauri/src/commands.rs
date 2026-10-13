//! Thin `#[tauri::command]` wrappers. Every command checks the caller's
//! window label prefix before doing anything.

use std::sync::Arc;

use rulebox_desktop::placement::Rect;
use tauri::{AppHandle, State, Window};

use crate::model::{ShellState, ThemeDto};
use crate::shellwin::{AnchorRect, DesktopHost, PopupKind};
use crate::state::AppState;

/// Why a command refused to run.
#[derive(Debug, thiserror::Error)]
pub enum CommandError {
    #[error("forbidden")]
    Forbidden,
    #[error("{0}")]
    Failed(String),
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

/// Open the shared popup. `anchor` is the control that opened it, in
/// **physical** pixels relative to the calling window's client area.
#[tauri::command]
pub fn popup_open(
    window: Window,
    app: AppHandle,
    host: State<'_, Arc<DesktopHost>>,
    kind: PopupKind,
    anchor: Option<AnchorRect>,
) -> Result<(), CommandError> {
    require_label(&window, "shell-")?;
    let anchor = match anchor {
        Some(rect) => {
            let origin = window
                .inner_position()
                .map_err(|error| CommandError::Failed(error.to_string()))?;
            let left = origin.x + rect.x.round() as i32;
            let top = origin.y + rect.y.round() as i32;
            Some(Rect::new(
                left,
                top,
                left + rect.width.round() as i32,
                top + rect.height.round() as i32,
            ))
        }
        None => None,
    };
    crate::shellwin::popup_open(&app, &host, kind, anchor).map_err(CommandError::Failed)
}

#[tauri::command]
pub fn popup_close(
    window: Window,
    app: AppHandle,
    host: State<'_, Arc<DesktopHost>>,
) -> Result<(), CommandError> {
    require_label(&window, "shell-")?;
    crate::shellwin::popup_close(&app, &host);
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
