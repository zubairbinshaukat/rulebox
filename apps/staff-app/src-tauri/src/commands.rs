//! Thin `#[tauri::command]` wrappers. Every command checks the caller's
//! window label prefix before doing anything.

use std::sync::Arc;

use rulebox_desktop::placement::Rect;
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
    let employee = match state.snapshot().session {
        SessionState::SignedIn { employee, .. } => employee,
        SessionState::SigningOut => return Ok(()),
        _ => return Err(CommandError::Failed("nobody is signed in".into())),
    };
    state.update(|shell| {
        shell.session = SessionState::SigningOut;
    });
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
        let _ = desktop.set_always_on_top(true);
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
    blocking(action)
        .await?
        .map_err(|error| CommandError::Failed(error.to_string()))
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
    blocking(move || taskops::launch(&app, &services, &state, &id)).await
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
#[tauri::command]
pub fn open_doc(
    window: Window,
    app: AppHandle,
    state: State<'_, AppState>,
    host: State<'_, Arc<AppWindows>>,
    kind: String,
    path: String,
) -> Result<String, CommandError> {
    require_shell_or_app(&window)?;
    let doc = appwin::parse_doc(&kind, &path).map_err(CommandError::Failed)?;
    host.open(&app, state.inner(), doc)
        .map_err(map_open_error(state.inner()))
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
    }

    #[derive(Debug, Deserialize)]
    struct DevSignIn {
        username: String,
        password: String,
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
            if let Some(n) = cmd.demo_apps {
                let items = crate::agent::demo::sample_apps_for(Some(n));
                state.update(|s| {
                    s.apps = crate::model::CatalogState {
                        status: crate::model::CatalogStatus::Ready,
                        items,
                    };
                });
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
