//! Thin `#[tauri::command]` wrappers. Every command checks the caller's
//! window label prefix before doing anything.

use std::sync::Arc;

use rulebox_desktop::placement::Rect;
use tauri::{AppHandle, State, Window};

use crate::model::{ShellState, SignInOutcome, ThemeDto};
use crate::session;
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

fn require_shell_desktop(window: &Window) -> Result<(), CommandError> {
    if window.label() == "shell-desktop" {
        Ok(())
    } else {
        Err(CommandError::Forbidden)
    }
}

#[tauri::command]
pub async fn sign_in(
    window: Window,
    state: State<'_, AppState>,
    username: String,
    password: String,
) -> Result<SignInOutcome, CommandError> {
    require_shell_desktop(&window)?;
    session::sign_in(&state, username, password).await
}

#[tauri::command]
pub async fn sign_in_last(
    window: Window,
    state: State<'_, AppState>,
    password: String,
) -> Result<SignInOutcome, CommandError> {
    require_shell_desktop(&window)?;
    session::sign_in_last(&state, password).await
}

#[tauri::command]
pub fn switch_user(window: Window, state: State<'_, AppState>) -> Result<(), CommandError> {
    require_shell_desktop(&window)?;
    session::switch_user(&state);
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

/// Apply a debug boot/display patch (also used by the temp-file poller).
#[cfg(debug_assertions)]
pub fn apply_dev_boot(
    state: &AppState,
    link: Option<crate::model::AgentLinkDto>,
    enrollment: Option<crate::model::EnrollmentDto>,
    kiosk_phase: Option<crate::model::KioskPhaseDto>,
    clock_suspect: Option<bool>,
    lite: Option<bool>,
    theme: Option<ThemeDto>,
) {
    if link.is_some() || enrollment.is_some() || kiosk_phase.is_some() {
        state.set_dev_hold_link(true);
    }
    // Clearing hold when explicitly resetting to linked + enrolled + applied.
    if matches!(link, Some(crate::model::AgentLinkDto::Linked))
        && matches!(enrollment, Some(crate::model::EnrollmentDto::Enrolled))
        && matches!(kiosk_phase, Some(crate::model::KioskPhaseDto::Applied))
    {
        state.set_dev_hold_link(false);
    }

    state.update(|s| {
        if let Some(link) = link {
            s.link = link;
        }
        if let Some(lite) = lite {
            s.display.lite = lite;
        }
        if let Some(theme) = theme {
            s.display.theme = theme;
        }
        if s.agent.is_none() {
            s.agent = Some(crate::model::AgentSummary {
                enrollment: crate::model::EnrollmentDto::Enrolled,
                connection: crate::model::ConnectionDto::Online,
                kiosk_phase: crate::model::KioskPhaseDto::Applied,
                clock_suspect: false,
                org_name: Some("Demo Org".into()),
            });
        }
        if let Some(agent) = s.agent.as_mut() {
            if let Some(enrollment) = enrollment {
                agent.enrollment = enrollment;
            }
            if let Some(kiosk_phase) = kiosk_phase {
                agent.kiosk_phase = kiosk_phase;
            }
            if let Some(clock_suspect) = clock_suspect {
                agent.clock_suspect = clock_suspect;
            }
        }
    });
}

/// Debug: force link / enrollment for boot-state screenshots. Release: Forbidden.
#[tauri::command]
pub fn dev_set_boot(
    window: Window,
    state: State<'_, AppState>,
    link: Option<crate::model::AgentLinkDto>,
    enrollment: Option<crate::model::EnrollmentDto>,
    kiosk_phase: Option<crate::model::KioskPhaseDto>,
    clock_suspect: Option<bool>,
) -> Result<(), CommandError> {
    require_label(&window, "shell-")?;
    #[cfg(debug_assertions)]
    {
        apply_dev_boot(
            &state,
            link,
            enrollment,
            kiosk_phase,
            clock_suspect,
            None,
            None,
        );
        Ok(())
    }
    #[cfg(not(debug_assertions))]
    {
        let _ = (state, link, enrollment, kiosk_phase, clock_suspect);
        Err(CommandError::Forbidden)
    }
}

/// Launch an approved app. Step 8 wires the real launcher; until then a notice.
#[tauri::command]
pub fn launch_app(window: Window, state: State<'_, AppState>, id: String) -> Result<(), CommandError> {
    require_label(&window, "shell-")?;
    let _ = id;
    state.notify(
        crate::model::NoticeTone::Neutral,
        "Not available yet",
        Some("App launch arrives in a later step.".into()),
    );
    Ok(())
}

/// Re-fetch the employee catalogue (empty / error desktop actions).
#[tauri::command]
pub async fn refresh_catalogue(
    window: Window,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    require_label(&window, "shell-")?;
    state.update(|s| {
        s.apps.status = crate::model::CatalogStatus::Loading;
    });
    session::load_catalogue(&state).await;
    Ok(())
}

/// Poll `%TEMP%\rulebox-staff-dev-cmd.json` for screenshot automation (debug only).
#[cfg(debug_assertions)]
pub fn spawn_dev_cmd_poller(state: AppState) {
    use std::time::Duration;

    use serde::Deserialize;

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct DevCmd {
        id: i64,
        #[serde(default)]
        link: Option<crate::model::AgentLinkDto>,
        #[serde(default)]
        enrollment: Option<crate::model::EnrollmentDto>,
        #[serde(default)]
        kiosk_phase: Option<crate::model::KioskPhaseDto>,
        #[serde(default)]
        clock_suspect: Option<bool>,
        #[serde(default)]
        lite: Option<bool>,
        #[serde(default)]
        theme: Option<ThemeDto>,
        /// Override the signed-in catalogue size for Step 6 screenshots.
        #[serde(default)]
        demo_apps: Option<usize>,
    }

    tauri::async_runtime::spawn(async move {
        let path = std::env::temp_dir().join("rulebox-staff-dev-cmd.json");
        let mut last_id = -1_i64;
        tracing::info!(path = %path.display(), "dev cmd poller watching");
        loop {
            tokio::time::sleep(Duration::from_millis(300)).await;
            let Ok(bytes) = std::fs::read(&path) else {
                continue;
            };
            let Ok(cmd) = serde_json::from_slice::<DevCmd>(&bytes) else {
                continue;
            };
            if cmd.id == last_id {
                continue;
            }
            last_id = cmd.id;
            tracing::info!(id = cmd.id, "dev cmd applied");
            apply_dev_boot(
                &state,
                cmd.link,
                cmd.enrollment,
                cmd.kiosk_phase,
                cmd.clock_suspect,
                cmd.lite,
                cmd.theme,
            );
            if let Some(n) = cmd.demo_apps {
                let items = crate::agent::demo::sample_apps_for(Some(n));
                state.update(|s| {
                    s.apps = crate::model::CatalogState {
                        status: crate::model::CatalogStatus::Ready,
                        items,
                    };
                });
            }
        }
    });
}
