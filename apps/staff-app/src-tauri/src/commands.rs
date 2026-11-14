//! Thin `#[tauri::command]` wrappers. Every command checks the caller's
//! window label prefix before doing anything.

use std::sync::Arc;

use rulebox_desktop::placement::{self, Rect};
use tauri::{AppHandle, Manager, State, Window};

use crate::appwin::{self, AppView, AppWindows, SnapZone};
use crate::model::{SessionState, ShellState, SignInOutcome, ThemeDto, VerifyOutcome};
use crate::session;
use crate::shellwin::{AnchorRect, DesktopHost, PopupKind};
use crate::state::AppState;
use crate::taskops;
use crate::tasks::TaskServices;

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
    Ok(state.wire_snapshot())
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

/// A line from the UI for the log (frame-meter results, which logo callback
/// fired). Debug builds only; a release build ignores it.
#[tauri::command]
pub fn dev_note(window: Window, text: String) -> Result<(), CommandError> {
    require_label(&window, "shell-")?;
    if cfg!(debug_assertions) {
        let line: String = text.chars().take(400).collect();
        tracing::info!(note = %line, "ui note");
    }
    Ok(())
}

/// Debug builds: post a notice (and so a toast) to see how it looks and behaves.
/// `tone` is a `NoticeTone` name. A release build ignores it.
#[tauri::command]
pub fn dev_toast(
    window: Window,
    state: State<'_, AppState>,
    tone: crate::model::NoticeTone,
    title: String,
    detail: Option<String>,
) -> Result<(), CommandError> {
    require_label(&window, "shell-")?;
    if cfg!(debug_assertions) {
        let title: String = title.chars().take(120).collect();
        let detail = detail.map(|text| text.chars().take(300).collect::<String>());
        state.notify(tone, title, detail);
    }
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

/// Clear the bell count. The notices stay in the list.
#[tauri::command]
pub fn notices_seen(window: Window, state: State<'_, AppState>) -> Result<(), CommandError> {
    require_label(&window, "shell-")?;
    state.mark_notices_read();
    Ok(())
}

/// Master volume, 0–1. Clamped. No sound device is an error the UI already hides.
#[tauri::command]
pub fn set_volume(
    window: Window,
    host: State<'_, Arc<DesktopHost>>,
    level: f32,
) -> Result<(), CommandError> {
    require_label(&window, "shell-")?;
    host.watch()
        .set_volume(level)
        .map_err(|error| CommandError::Failed(error.to_string()))
}

#[tauri::command]
pub fn set_muted(
    window: Window,
    host: State<'_, Arc<DesktopHost>>,
    muted: bool,
) -> Result<(), CommandError> {
    require_label(&window, "shell-")?;
    host.watch()
        .set_muted(muted)
        .map_err(|error| CommandError::Failed(error.to_string()))
}

#[tauri::command]
pub fn set_brightness(
    window: Window,
    host: State<'_, Arc<DesktopHost>>,
    level: u8,
) -> Result<(), CommandError> {
    require_label(&window, "shell-")?;
    host.watch()
        .set_brightness(level)
        .map_err(|error| CommandError::Failed(error.to_string()))
}

/// Per-employee theme. Signed out, this is the organization setting.
#[tauri::command]
pub fn set_theme(
    window: Window,
    state: State<'_, AppState>,
    theme: ThemeDto,
) -> Result<(), CommandError> {
    require_label(&window, "shell-")?;
    crate::system::set_theme(&state, theme);
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

/// The taskbar page reports where its pills are (physical pixels, relative to the
/// taskbar window). Only those areas take mouse input; the transparent strip
/// between and around them lets clicks reach the window behind. An empty list
/// gives the whole strip back.
#[tauri::command]
pub fn taskbar_shape(window: Window, rects: Vec<AnchorRect>) -> Result<(), CommandError> {
    require_label(&window, crate::shellwin::TASKBAR)?;
    // More pills than the bar can have is a broken page; keep the strip whole.
    if rects.len() > 8 {
        return Err(CommandError::Failed("too many taskbar areas".into()));
    }
    let hwnd = window
        .hwnd()
        .map_err(|error| CommandError::Failed(error.to_string()))?
        .0 as isize;
    let scale = window.scale_factor().unwrap_or(1.0);
    let size = window
        .inner_size()
        .map_err(|error| CommandError::Failed(error.to_string()))?;
    let margin = placement::scale_px(placement::TASKBAR_SHAPE_MARGIN_LOGICAL, scale);
    let radius = placement::scale_px(
        placement::TASKBAR_PILL_RADIUS_LOGICAL + placement::TASKBAR_SHAPE_MARGIN_LOGICAL,
        scale,
    );
    let shape: Vec<Rect> = rects
        .iter()
        .filter(|rect| {
            rect.x.is_finite() && rect.y.is_finite() && rect.width.is_finite() && rect.height.is_finite()
        })
        .filter_map(|rect| {
            let pill = Rect::new(
                rect.x.round() as i32,
                rect.y.round() as i32,
                (rect.x + rect.width).round() as i32,
                (rect.y + rect.height).round() as i32,
            );
            placement::taskbar_shape_rect(pill, margin, size.width as i32, size.height as i32)
        })
        .collect();
    // Nothing usable reported: the strip stays clickable (the window is taller
    // than the strip, so "no region" would block the area above it).
    let (shape, radius) = if shape.is_empty() {
        let zone = placement::taskbar_strip_in_window(size.width as i32, size.height as i32, scale);
        (vec![zone], 0)
    } else {
        (shape, radius)
    };
    let began = std::time::Instant::now();
    let result = rulebox_desktop::windows::set_shape(hwnd, &shape, radius)
        .map_err(|error| CommandError::Failed(error.to_string()));
    tracing::debug!(pills = shape.len(), ms = began.elapsed().as_millis() as u64, "taskbar_shape applied");
    result
}

// ---- Thumbnails (plan Step 16, Standard mode) ----------------------------------

/// What the thumbnail popup shows for the window it is about.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThumbInfo {
    pub task_id: String,
    pub title: String,
    pub icon_key: String,
    pub minimized: bool,
}

/// Open the preview above a task button. `false` means "no preview" (Lite mode,
/// or the window is gone): the taskbar then shows only its tooltip.
#[tauri::command]
pub fn thumb_open(
    window: Window,
    app: AppHandle,
    host: State<'_, Arc<DesktopHost>>,
    state: State<'_, AppState>,
    services: State<'_, TaskServices>,
    task_id: String,
    anchor: AnchorRect,
) -> Result<bool, CommandError> {
    require_label(&window, "shell-")?;
    if state.read(|shell| shell.display.lite) || services.registry.lookup(&task_id).is_none() {
        return Ok(false);
    }
    host.set_thumb_task(Some(task_id));
    popup_open(window, app, host, PopupKind::Thumb, Some(anchor))?;
    Ok(true)
}

/// The popup page asks what it is previewing.
#[tauri::command]
pub fn thumb_state(
    window: Window,
    host: State<'_, Arc<DesktopHost>>,
    state: State<'_, AppState>,
) -> Result<Option<ThumbInfo>, CommandError> {
    require_label(&window, "shell-popup")?;
    let Some(task_id) = host.thumb_task() else {
        return Ok(None);
    };
    Ok(state.read(|shell| {
        shell.tasks.iter().find(|task| task.id == task_id).map(|task| ThumbInfo {
            task_id: task.id.clone(),
            title: task.title.clone(),
            icon_key: task.icon_key.clone(),
            minimized: task.minimized,
        })
    }))
}

/// The popup page reports where its empty rectangle is (physical pixels, relative to
/// the popup); DWM then draws the live picture there. `false` when there is nothing to draw.
#[tauri::command]
pub fn thumb_attach(
    window: Window,
    host: State<'_, Arc<DesktopHost>>,
    services: State<'_, TaskServices>,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<bool, CommandError> {
    require_label(&window, "shell-popup")?;
    let Some(task_id) = host.thumb_task() else {
        return Ok(false);
    };
    let Some((source, facts)) = services.registry.lookup(&task_id) else {
        return Ok(false);
    };
    // A minimized window has nothing to show: the page shows its icon and title instead.
    if facts.minimized {
        return Ok(false);
    }
    let Some(dest) = window.hwnd().ok().map(|hwnd| hwnd.0 as isize) else {
        return Ok(false);
    };
    let bounds = Rect::new(
        x.round() as i32,
        y.round() as i32,
        (x + width).round() as i32,
        (y + height).round() as i32,
    );
    match rulebox_desktop::thumbs::show(dest, source, bounds) {
        Ok(thumb) => {
            host.attach_thumb(thumb);
            Ok(true)
        }
        Err(error) => {
            tracing::debug!(%error, "no live thumbnail for this window");
            Ok(false)
        }
    }
}

// ---- Administrator exit (plan Section 7.11) ------------------------------------

fn require_exit_window(window: &Window) -> Result<(), CommandError> {
    if window.label() == crate::exit::EXIT {
        Ok(())
    } else {
        Err(CommandError::Forbidden)
    }
}

/// Open the exit dialog. Any shell or built-in window may ask; it is done in Rust.
#[tauri::command]
pub async fn admin_exit_open(
    window: Window,
    app: AppHandle,
    host: State<'_, Arc<DesktopHost>>,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    require_shell_or_app(&window)?;
    // Builds a window: never on the UI thread (see `open_doc`).
    let (host, state) = (host.inner().clone(), state.inner().clone());
    blocking(move || crate::exit::open(&app, &host, &state))
        .await?
        .map_err(CommandError::Failed)
}

/// The key combination the page listeners match; `None` when the exit is off.
#[tauri::command]
pub fn admin_exit_hotkey(window: Window, state: State<'_, AppState>) -> Result<Option<String>, CommandError> {
    require_shell_or_app(&window)?;
    Ok(crate::exit::hotkey_text(&state))
}

#[tauri::command]
pub fn admin_exit_state(
    window: Window,
    state: State<'_, AppState>,
) -> Result<crate::exit::AdminExitView, CommandError> {
    require_exit_window(&window)?;
    Ok(crate::exit::view(&state))
}

/// Relay a PIN to the agent. The agent checks it; nothing here does.
#[tauri::command]
pub async fn admin_exit_submit(
    window: Window,
    state: State<'_, AppState>,
    pin: String,
) -> Result<crate::exit::ExitAnswer, CommandError> {
    require_exit_window(&window)?;
    Ok(crate::exit::submit(state.inner(), pin).await)
}

#[tauri::command]
pub fn admin_exit_close(window: Window) -> Result<(), CommandError> {
    require_exit_window(&window)?;
    window.destroy().map_err(|error| CommandError::Failed(error.to_string()))
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
    session::switch_user(&state)
}

fn desktop_window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    app.get_webview_window(crate::shellwin::DESKTOP)
}

/// Steps 2–7 of log out. Safe to call again while already signing out.
async fn run_sign_out(
    app: &AppHandle,
    state: &AppState,
    services: &TaskServices,
    host: &Arc<DesktopHost>,
) -> Result<(), CommandError> {
    // Decided and changed under one lock: two callers cannot both start it.
    let employee = state.modify(|shell| match &shell.session {
        SessionState::SignedIn { employee, .. } => {
            let employee = employee.clone();
            shell.session = SessionState::SigningOut;
            Ok(Some(employee))
        }
        SessionState::SigningOut => Ok(None),
        _ => Err(CommandError::Failed("nobody is signed in".into())),
    })?;
    let Some(employee) = employee else {
        return Ok(());
    };
    sign_out_steps(app, state, services, host, employee).await
}

/// Steps 3–7 of log out, for a session that is already `SigningOut`.
async fn sign_out_steps(
    app: &AppHandle,
    state: &AppState,
    services: &TaskServices,
    host: &Arc<DesktopHost>,
    employee: crate::model::Employee,
) -> Result<(), CommandError> {
    crate::shellwin::popup_close(app, host);
    if let Some(apps) = app.try_state::<Arc<crate::appwin::AppWindows>>() {
        apps.close_all(app);
    }
    if let Some(desktop) = desktop_window(app) {
        let _ = desktop.set_always_on_top(false);
    }
    let (state, services, employee) = (state.clone(), services.clone(), employee);
    blocking(move || session::perform_sign_out(&state, &services, &employee)).await
}

/// `session.ended`: the agent has already cleared its session, so this is the
/// log-out sequence without asking (apps closed, memory cleared) and the reason
/// on the sign-in screen. Works in every state (see `session::apply_session_ended`).
pub async fn end_session_from_agent(state: &AppState, reason: crate::model::SessionEndedReason) {
    end_session(state, reason, None).await;
}

/// `end_session_from_agent`, optionally only for the session of one employee.
pub async fn end_session(
    state: &AppState,
    reason: crate::model::SessionEndedReason,
    only_for: Option<&str>,
) {
    use session::EndedPlan;

    let plan = state.modify(|shell| session::apply_session_ended(shell, reason, only_for));
    let EndedPlan::SignOut(employee) = plan else {
        return;
    };
    tracing::info!(?reason, "the agent ended the session");

    // Too early for the windows (the shell is still starting): the employee must
    // still be signed out, just without anything to close.
    let parts = state.app_handle().and_then(|app| {
        let services = app.try_state::<TaskServices>()?.inner().clone();
        let host = app.try_state::<Arc<DesktopHost>>()?.inner().clone();
        Some((app, services, host))
    });
    let Some((app, services, host)) = parts else {
        tracing::warn!("session.ended before the shell was ready; signing out without windows");
        session::sign_out_without_windows(state, &employee).await;
        return;
    };
    if let Err(error) = sign_out_steps(&app, state, &services, &host, employee.clone()).await {
        // The worker did not finish: do not leave the session half closed.
        tracing::warn!(%error, "could not close the session the agent ended");
        session::sign_out_without_windows(state, &employee).await;
    }
}

/// Close the shell's apps and return to sign-in. Windows the shell did not
/// launch are left open.
#[tauri::command]
pub async fn sign_out(
    window: Window,
    app: AppHandle,
    state: State<'_, AppState>,
    services: State<'_, TaskServices>,
    host: State<'_, Arc<DesktopHost>>,
) -> Result<(), CommandError> {
    require_label(&window, "shell-")?;
    run_sign_out(&app, &state, &services, &host).await
}

/// Names of the apps the next log out will close. Foreign windows are omitted.
#[tauri::command]
pub fn closing_apps(
    window: Window,
    state: State<'_, AppState>,
    services: State<'_, TaskServices>,
) -> Result<Vec<String>, CommandError> {
    require_label(&window, "shell-")?;
    Ok(session::apps_closing(&state, &services))
}

/// Employee lock: apps stay open, the desktop covers them.
#[tauri::command]
pub async fn lock(
    window: Window,
    app: AppHandle,
    state: State<'_, AppState>,
    services: State<'_, TaskServices>,
    host: State<'_, Arc<DesktopHost>>,
) -> Result<(), CommandError> {
    require_label(&window, "shell-")?;
    let dev_mode = host.mode() == rulebox_desktop::ShellMode::Dev;
    let Some(hwnds) = session::begin_lock(&state, &services, dev_mode) else {
        return Err(CommandError::Failed("nobody is signed in".into()));
    };
    crate::shellwin::popup_close(&app, &host);
    if let Some(apps) = app.try_state::<Arc<crate::appwin::AppWindows>>() {
        apps.minimize_all(&app);
    }
    if let Some(desktop) = desktop_window(&app) {
        // Only the real shell covers everything. In dev mode the desktop is an
        // ordinary window and must not pin itself above the developer's apps.
        if !dev_mode {
            let _ = desktop.set_always_on_top(true);
        }
        let _ = desktop.set_focus();
    }
    blocking(move || {
        for hwnd in hwnds {
            if let Err(error) = rulebox_desktop::control::minimize(hwnd) {
                tracing::debug!(%error, hwnd, "lock: could not minimize");
            }
        }
    })
    .await
}

/// `shell-desktop` only, same as sign-in. The password is not logged.
#[tauri::command]
pub async fn unlock(
    window: Window,
    app: AppHandle,
    state: State<'_, AppState>,
    password: String,
) -> Result<VerifyOutcome, CommandError> {
    require_shell_desktop(&window)?;
    let outcome = session::unlock(&state, password).await?;
    if matches!(outcome, VerifyOutcome::Ok) {
        if let Some(desktop) = desktop_window(&app) {
            let _ = desktop.set_always_on_top(false);
        }
    }
    Ok(outcome)
}

async fn run_power(
    app: &AppHandle,
    state: &AppState,
    services: &TaskServices,
    host: &Arc<DesktopHost>,
    sign_out_first: bool,
    action: fn() -> rulebox_desktop::Result<()>,
) -> Result<(), CommandError> {
    if !rulebox_desktop::power::can_power_off() {
        return Err(CommandError::Failed(
            "This account cannot shut the PC down.".into(),
        ));
    }
    let signed_in = matches!(state.snapshot().session, SessionState::SignedIn { .. });
    if sign_out_first && signed_in {
        run_sign_out(app, state, services, host).await?;
    }
    let result = blocking(action)
        .await?
        .map_err(|error| CommandError::Failed(error.to_string()));
    if let Err(error) = &result {
        // The button has no other way to say that nothing happened.
        tracing::warn!(%error, "power action failed");
        state.notify(
            crate::model::NoticeTone::Warning,
            "That did not work.",
            Some("Windows did not accept the request.".into()),
        );
    }
    result
}

#[tauri::command]
pub async fn power_sleep(
    window: Window,
    app: AppHandle,
    state: State<'_, AppState>,
    services: State<'_, TaskServices>,
    host: State<'_, Arc<DesktopHost>>,
) -> Result<(), CommandError> {
    require_label(&window, "shell-")?;
    run_power(&app, &state, &services, &host, false, rulebox_desktop::power::sleep).await
}

#[tauri::command]
pub async fn power_restart(
    window: Window,
    app: AppHandle,
    state: State<'_, AppState>,
    services: State<'_, TaskServices>,
    host: State<'_, Arc<DesktopHost>>,
) -> Result<(), CommandError> {
    require_label(&window, "shell-")?;
    run_power(
        &app,
        &state,
        &services,
        &host,
        true,
        rulebox_desktop::power::restart,
    )
    .await
}

#[tauri::command]
pub async fn power_shut_down(
    window: Window,
    app: AppHandle,
    state: State<'_, AppState>,
    services: State<'_, TaskServices>,
    host: State<'_, Arc<DesktopHost>>,
) -> Result<(), CommandError> {
    require_label(&window, "shell-")?;
    run_power(
        &app,
        &state,
        &services,
        &host,
        true,
        rulebox_desktop::power::shut_down,
    )
    .await
}

/// Debug overlay only. Exit code 0 asks the launcher to bring Rulebox back.
#[tauri::command]
pub fn restart_rulebox(window: Window) -> Result<(), CommandError> {
    require_shell_desktop(&window)?;
    #[cfg(debug_assertions)]
    {
        tracing::info!("restarting Rulebox (exit 0)");
        std::process::exit(0);
    }
    #[cfg(not(debug_assertions))]
    {
        Err(CommandError::Forbidden)
    }
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
        let signed_in = matches!(state.snapshot().session, SessionState::SignedIn { .. });
        state.update(|s| {
            s.display.lite = lite;
            s.display.theme = theme;
        });
        if !signed_in {
            state.set_org_theme(theme);
        }
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
    if let Some(theme) = theme {
        if !matches!(state.snapshot().session, SessionState::SignedIn { .. }) {
            state.set_org_theme(theme);
        }
    }
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

/// Run blocking Win32 work off the UI threads.
async fn blocking<F, R>(work: F) -> Result<R, CommandError>
where
    F: FnOnce() -> R + Send + 'static,
    R: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| CommandError::Failed(error.to_string()))
}

/// Open an app from the catalogue: focus it when it is open, else start it.
/// React sends an id; the program path comes only from the catalogue.
#[tauri::command]
pub async fn launch_app(
    window: Window,
    state: State<'_, AppState>,
    services: State<'_, TaskServices>,
    id: String,
) -> Result<(), CommandError> {
    require_label(&window, "shell-")?;
    let app = window.app_handle().clone();
    let (state, services) = (state.inner().clone(), services.inner().clone());
    tracing::debug!(app = %id, "launch_app: begin");
    let began = std::time::Instant::now();
    let result = blocking(move || taskops::launch(&app, &services, &state, &id)).await;
    tracing::debug!(ms = began.elapsed().as_millis() as u64, "launch_app: end");
    result
}

/// A click on a window's taskbar button (restore / minimize / focus).
#[tauri::command]
pub async fn task_click(
    window: Window,
    state: State<'_, AppState>,
    services: State<'_, TaskServices>,
    id: String,
) -> Result<(), CommandError> {
    require_label(&window, "shell-")?;
    let (state, services) = (state.inner().clone(), services.inner().clone());
    blocking(move || taskops::click(&services, &state, &id))
        .await?
        .map_err(CommandError::Failed)
}

#[tauri::command]
pub async fn task_close(
    window: Window,
    state: State<'_, AppState>,
    services: State<'_, TaskServices>,
    id: String,
) -> Result<(), CommandError> {
    require_label(&window, "shell-")?;
    let (state, services) = (state.inner().clone(), services.inner().clone());
    blocking(move || taskops::close(&services, &state, &id))
        .await?
        .map_err(CommandError::Failed)
}

/// End the program of a window that is not responding.
#[tauri::command]
pub async fn task_end(
    window: Window,
    state: State<'_, AppState>,
    services: State<'_, TaskServices>,
    id: String,
) -> Result<(), CommandError> {
    require_label(&window, "shell-")?;
    let (state, services) = (state.inner().clone(), services.inner().clone());
    blocking(move || taskops::end(&services, &state, &id))
        .await?
        .map_err(CommandError::Failed)
}

/// Minimize every open window; the next call restores them.
#[tauri::command]
pub async fn show_desktop(
    window: Window,
    services: State<'_, TaskServices>,
) -> Result<(), CommandError> {
    require_label(&window, "shell-")?;
    let services = services.inner().clone();
    blocking(move || taskops::show_desktop(&services)).await
}

/// Open a built-in document. The path is relative to the employee root.
///
/// `async` on purpose: a plain `fn` command runs on the UI (main) thread, inside the
/// WebView2 request callback of the page that called it, and creating a window there
/// waits for the new WebView2 with a nested message loop that can never finish
/// (found on the VM, 2026-10-31: the whole Staff App froze on a double-click). Any
/// command that builds a window must run on the blocking pool, like `launch_app`.
#[tauri::command]
pub async fn open_doc(
    window: Window,
    app: AppHandle,
    state: State<'_, AppState>,
    host: State<'_, Arc<AppWindows>>,
    kind: String,
    path: String,
) -> Result<String, CommandError> {
    require_shell_or_app(&window)?;
    let doc = appwin::parse_doc(&kind, &path).map_err(CommandError::Failed)?;
    let (state, host) = (state.inner().clone(), host.inner().clone());
    let opened = blocking(move || {
        host.open(&app, &state, doc)
            .map_err(|error| map_open_error(&state)(error))
    })
    .await?;
    opened
}

/// Minimize the calling built-in window only.
#[tauri::command]
pub fn win_minimize(window: Window, app: AppHandle) -> Result<(), CommandError> {
    require_label(&window, "app-")?;
    AppWindows::minimize(&app, window.label()).map_err(CommandError::Failed)
}

/// Maximize or restore the calling built-in window only.
#[tauri::command]
pub fn win_toggle_maximize(
    window: Window,
    app: AppHandle,
    host: State<'_, Arc<AppWindows>>,
) -> Result<(), CommandError> {
    require_label(&window, "app-")?;
    host.toggle_maximize(&app, window.label())
        .map_err(CommandError::Failed)
}

/// Close the calling built-in window only.
#[tauri::command]
pub fn win_close(window: Window, app: AppHandle) -> Result<(), CommandError> {
    require_label(&window, "app-")?;
    AppWindows::close(&app, window.label()).map_err(CommandError::Failed)
}

/// Snap the calling built-in window to a zone of the work area.
#[tauri::command]
pub fn win_snap(
    window: Window,
    app: AppHandle,
    host: State<'_, Arc<AppWindows>>,
    zone: SnapZone,
) -> Result<(), CommandError> {
    require_label(&window, "app-")?;
    host.snap(&app, window.label(), zone)
        .map_err(CommandError::Failed)
}

/// What the calling built-in window is showing.
#[tauri::command]
pub fn app_snapshot(
    window: Window,
    host: State<'_, Arc<AppWindows>>,
) -> Result<AppView, CommandError> {
    require_label(&window, "app-")?;
    host.snapshot(window.label())
        .ok_or_else(|| CommandError::Failed("that window is not open".into()))
}

/// Select a tab in the calling window (Lite mode).
#[tauri::command]
pub fn app_select_tab(
    window: Window,
    app: AppHandle,
    host: State<'_, Arc<AppWindows>>,
    index: u32,
) -> Result<(), CommandError> {
    require_label(&window, "app-")?;
    host.select_tab(&app, window.label(), index as usize)
        .map_err(CommandError::Failed)
}

/// Close a tab in the calling window. The last tab closes the window.
#[tauri::command]
pub fn app_close_tab(
    window: Window,
    app: AppHandle,
    host: State<'_, Arc<AppWindows>>,
    index: u32,
) -> Result<(), CommandError> {
    require_label(&window, "app-")?;
    host.close_tab(&app, window.label(), index as usize)
        .map_err(CommandError::Failed)
}

fn map_open_error(state: &AppState) -> impl Fn(String) -> CommandError + '_ {
    move |error| {
        if error == "close a tab first" {
            // `open` already posted the notice.
            return CommandError::Failed(error);
        }
        state.notify(
            crate::model::NoticeTone::Warning,
            "That window could not be opened.",
            Some(error.clone()),
        );
        CommandError::Failed(error)
    }
}

/// Right-click menu of a taskbar button: for a window (`id`) or for a pinned
/// app that is not open (`app_id`). A native menu, so it does not depend on
/// the shared popup window.
#[tauri::command]
pub async fn task_menu(
    window: Window,
    app: AppHandle,
    services: State<'_, TaskServices>,
    id: Option<String>,
    app_id: Option<String>,
) -> Result<(), CommandError> {
    use tauri::menu::{ContextMenu, Menu, MenuItem};

    require_label(&window, "shell-")?;
    let build = |error: tauri::Error| CommandError::Failed(error.to_string());

    let mut items: Vec<MenuItem<tauri::Wry>> = Vec::new();
    if let Some(id) = &id {
        let (_, facts) = services
            .registry
            .lookup(id)
            .ok_or_else(|| CommandError::Failed("that window is not listed".into()))?;
        items.push(
            MenuItem::with_id(&app, format!("task-close:{id}"), "Close window", true, None::<&str>)
                .map_err(build)?,
        );
        if facts.hung && !facts.own {
            items.push(
                MenuItem::with_id(
                    &app,
                    format!("task-end:{id}"),
                    "End app (not responding)",
                    true,
                    None::<&str>,
                )
                .map_err(build)?,
            );
        }
    } else if let Some(app_id) = &app_id {
        items.push(
            MenuItem::with_id(&app, format!("app-open:{app_id}"), "Open", true, None::<&str>)
                .map_err(build)?,
        );
    }
    if items.is_empty() {
        return Ok(());
    }
    // The borrowed trait objects are not `Send`: keep them out of the
    // future's state by finishing with them before the await below.
    let menu = {
        let refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> = items
            .iter()
            .map(|item| item as &dyn tauri::menu::IsMenuItem<tauri::Wry>)
            .collect();
        Menu::with_items(&app, &refs).map_err(build)?
    };
    drop(items);
    // Blocks until the menu closes; the choice arrives as a menu event.
    blocking(move || menu.popup(window)).await?.map_err(build)
}

/// A choice in the task menu (`Builder::on_menu_event`).
pub fn on_menu_event(app: &AppHandle, menu_id: &str) {
    let Some(services) = app.try_state::<TaskServices>() else {
        return;
    };
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let (services, state) = (services.inner().clone(), state.inner().clone());
    let menu_id = menu_id.to_string();
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        tracing::info!(menu_id, "task menu choice");
        if let Some(id) = menu_id.strip_prefix("task-close:") {
            if let Err(error) = taskops::close(&services, &state, id) {
                tracing::warn!(%error, "task menu: close failed");
            }
        } else if let Some(id) = menu_id.strip_prefix("task-end:") {
            match taskops::end(&services, &state, id) {
                Ok(()) => tracing::info!("task menu: app ended"),
                Err(error) => tracing::warn!(%error, "task menu: end failed"),
            }
        } else if let Some(app_id) = menu_id.strip_prefix("app-open:") {
            taskops::launch(&app, &services, &state, app_id);
        }
    });
}

/// (Protocol 1.3) The employee pressed "OK" on a broadcast. Only an id the shell is showing is
/// forwarded; the agent queues one acknowledgement (never the employee) and the next snapshot marks
/// the broadcast as acknowledged. An agent without broadcasts has nothing to acknowledge.
#[tauri::command]
pub async fn broadcast_ack(
    window: Window,
    state: State<'_, AppState>,
    id: String,
) -> Result<(), CommandError> {
    require_label(&window, "shell-")?;
    if !state.read(|shell| shell.broadcasts.iter().any(|broadcast| broadcast.id == id)) {
        return Ok(());
    }
    match state.agent().ack_broadcast(id).await {
        Ok(_) => Ok(()),
        Err(error) if error.is_unsupported() => Ok(()),
        Err(error) => Err(CommandError::Failed(error.to_string())),
    }
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
        /// Sign in as a demo employee without typing into the screen.
        #[serde(default)]
        sign_in: Option<DevSignIn>,
        /// Open a built-in document (`kind` is `files` or `view`).
        #[serde(default)]
        open_doc: Option<DevOpenDoc>,
        /// Launch a catalogue app by id, as a tile click would.
        #[serde(default)]
        launch: Option<String>,
        /// Run a probe script inside a web app window (see below).
        #[serde(default)]
        eval_web: Option<DevEvalWeb>,
        /// Act as a shortcut: `switcher`, `start` or `exit` (no hotkeys exist in dev mode).
        #[serde(default)]
        shortcut: Option<String>,
        /// Show the lock screen (what the Lock button does to the session).
        #[serde(default)]
        lock: Option<bool>,
        /// Make the demo agent send `apps.changed` (protocol 1.2).
        #[serde(default)]
        apps_changed: Option<bool>,
        /// Make the demo agent send `session.ended` with this reason (protocol 1.2).
        #[serde(default)]
        session_ended: Option<crate::model::SessionEndedReason>,
        /// (Protocol 1.3) Lock the demo device (`on: true`, with a message) or unlock it.
        #[serde(default)]
        device_lock: Option<DevLock>,
        /// (Protocol 1.3) Replace the demo agent's broadcast list.
        #[serde(default)]
        broadcasts: Option<Vec<DevBroadcast>>,
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct DevLock {
        on: bool,
        #[serde(default)]
        message: String,
        #[serde(default)]
        contact: Option<String>,
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct DevBroadcast {
        id: String,
        /// `banner` or `fullscreen`.
        style: String,
        title: String,
        body: String,
        #[serde(default)]
        ack_required: bool,
    }

    #[derive(Debug, Deserialize)]
    struct DevSignIn {
        username: String,
        password: String,
    }

    #[derive(Debug, Deserialize)]
    struct DevEvalWeb {
        /// Catalogue app id of the web window.
        app: String,
        /// The script. It reports by setting `window.name` is not visible from here, so it
        /// navigates to the local blocked page with its result as the host.
        js: String,
    }

    #[derive(Debug, Deserialize)]
    struct DevOpenDoc {
        kind: String,
        path: String,
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
            if let Some(creds) = cmd.sign_in {
                match session::sign_in(&state, creds.username, creds.password).await {
                    Ok(outcome) => tracing::info!(?outcome, "dev cmd sign-in"),
                    Err(error) => tracing::warn!(%error, "dev cmd sign-in failed"),
                }
            }
            if cmd.lock == Some(true) {
                state.update(|s| {
                    if let Some(next) = session::lock_transition(&s.session, session::LockEvent::Lock) {
                        s.session = next;
                    }
                });
            }
            if cmd.apps_changed == Some(true) {
                state.agent().dev_emit(crate::model::AgentEvent::AppsChanged);
            }
            if let Some(reason) = cmd.session_ended {
                state.agent().dev_emit(crate::model::AgentEvent::SessionEnded(reason));
            }
            if let Some(lock) = cmd.device_lock {
                let view = lock.on.then(|| rulebox_ipc::types::DeviceLockView {
                    lock_id: "dev-lock".into(),
                    message: lock.message,
                    contact: lock.contact,
                });
                state.agent().dev_set_lock(view);
            }
            if let Some(list) = cmd.broadcasts {
                let views = list
                    .into_iter()
                    .map(|item| rulebox_ipc::types::BroadcastView {
                        id: item.id,
                        style: if item.style == "fullscreen" {
                            rulebox_policy::notice::BroadcastStyle::Fullscreen
                        } else {
                            rulebox_policy::notice::BroadcastStyle::Banner
                        },
                        title: item.title,
                        body: item.body,
                        ack_required: item.ack_required,
                        acknowledged: false,
                    })
                    .collect();
                state.agent().dev_set_broadcasts(views);
            }
            if let Some(n) = cmd.demo_apps {
                let items = crate::agent::demo::sample_apps_for(Some(n));
                state.update(|s| {
                    s.apps = crate::model::CatalogState {
                        status: crate::model::CatalogStatus::Ready,
                        items,
                    };
                });
            }
            if let Some(app_id) = cmd.launch {
                if let Some(handle) = state.app_handle() {
                    let services = handle.state::<TaskServices>();
                    let (state, services) = (state.clone(), services.inner().clone());
                    let handle = handle.clone();
                    std::thread::spawn(move || taskops::launch(&handle, &services, &state, &app_id));
                }
            }
            if let Some(name) = cmd.shortcut {
                if let Some(handle) = state.app_handle() {
                    let id = match name.as_str() {
                        "switcher" => Some(rulebox_desktop::hotkeys::HotkeyId::SWITCHER),
                        "start" => Some(rulebox_desktop::hotkeys::HotkeyId::START),
                        "exit" => Some(rulebox_desktop::hotkeys::HotkeyId::ADMIN_EXIT),
                        _ => None,
                    };
                    match id {
                        Some(id) => match handle.try_state::<Arc<DesktopHost>>() {
                            Some(host) => crate::shortcuts::on_hotkey(&handle, host.inner(), id),
                            None => tracing::warn!(name, "dev cmd shortcut: shell not ready yet"),
                        },
                        None => tracing::warn!(name, "dev cmd shortcut unknown"),
                    }
                }
            }
            if let Some(probe) = cmd.eval_web {
                if let Some(handle) = state.app_handle() {
                    let prefix = format!("web-{}-", probe.app);
                    for (label, window) in handle.webview_windows() {
                        if label.starts_with(&prefix) {
                            if let Err(error) = window.eval(&probe.js) {
                                tracing::warn!(%error, label, "dev cmd eval_web failed");
                            }
                        }
                    }
                }
            }
            if let Some(doc) = cmd.open_doc {
                let Some(handle) = state.app_handle() else {
                    continue;
                };
                match appwin::parse_doc(&doc.kind, &doc.path) {
                    Ok(parsed) => {
                        let host = handle.state::<Arc<AppWindows>>();
                        if let Err(error) = host.open(&handle, &state, parsed) {
                            tracing::warn!(%error, "dev cmd open_doc failed");
                        }
                    }
                    Err(error) => tracing::warn!(%error, "dev cmd open_doc refused"),
                }
            }
        }
    });
}

#[cfg(test)]
mod window_thread_tests {
    /// A plain `fn` command runs on the UI thread, inside the WebView2 request
    /// callback of the calling page. Building a window there waits for a new
    /// WebView2 with a nested message loop and freezes the whole app (VM, 2026-10-31).
    /// So no sync command may open or build a window; those must be `async` and
    /// use `blocking(..)`.
    #[test]
    fn no_sync_command_builds_a_window() {
        let source = include_str!("commands.rs");
        let production = source.split("#[cfg(test)]\nmod window_thread_tests").next().unwrap_or(source);
        let forbidden = ["host.open(", "exit::open(", "WebviewWindowBuilder", "web.open(", "open_files(", ".build()"];
        for chunk in production.split("#[tauri::command").skip(1) {
            let head: String = chunk.lines().skip_while(|l| !l.contains("fn ")).take(1).collect();
            if !head.contains("pub fn ") {
                continue; // async commands run on the runtime, not the UI thread
            }
            let end = chunk.find("\n}\n").unwrap_or(chunk.len());
            let body = &chunk[..end];
            for word in forbidden {
                assert!(!body.contains(word), "sync command `{}` uses `{word}`", head.trim());
            }
        }
    }
}
