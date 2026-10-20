//! The three shell windows: `shell-desktop`, `shell-taskbar`, `shell-popup`
//! (plan Section 5.1 and Step 4). Rust creates them, places them in physical
//! pixels and keeps them in place; React only draws the content.
//!
//! Shell mode (no Explorer, VM): the desktop covers the monitor at the
//! bottom of the z-order, the taskbar strip is the bottom 84 px, and the
//! Windows work area is reduced to what is above the strip. Dev mode
//! (Explorer running): a normal decorated window and a strip directly above
//! the Windows taskbar; **nothing session-wide is touched**.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use rulebox_desktop::placement::{
    self, popup_rect, taskbar_rect, taskbar_zone_px, usable_bounds, Rect, POPUP_GAP_LOGICAL,
};
use rulebox_desktop::tracker;
use rulebox_desktop::workarea::{self, MonitorRect};
use rulebox_desktop::{DesktopEvent, MsgLoop, ShellMode, ShellToken};
use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender};

use crate::tasks::{TaskHost, TaskServices};

pub const DESKTOP: &str = "shell-desktop";
pub const TASKBAR: &str = "shell-taskbar";
pub const POPUP: &str = "shell-popup";

/// Bursts of display messages (one per monitor property) become one re-place.
const REAPPLY_DEBOUNCE: Duration = Duration::from_millis(150);
/// Window events are batched for this long: well inside the 300 ms budget
/// of the taskbar, long enough to fold a flurry of title changes.
const WINDOW_EVENT_SETTLE: Duration = Duration::from_millis(40);
/// How often visible windows are checked for "not responding".
const HUNG_CHECK_INTERVAL: Duration = Duration::from_secs(5);

/// What the shared popup window is showing. The page picks its content from
/// `popup://show { kind }`. Sizes are provisional; the steps that build each
/// popup adjust them.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PopupKind {
    Start,
    QuickSettings,
    Account,
    Switcher,
    Thumb,
    Confirm,
}

impl PopupKind {
    /// Size in logical pixels.
    pub fn logical_size(self) -> (i32, i32) {
        match self {
            PopupKind::Start => (560, 640),
            PopupKind::QuickSettings => (380, 560),
            PopupKind::Account => (300, 220),
            PopupKind::Switcher => (720, 232),
            PopupKind::Thumb => (272, 196),
            PopupKind::Confirm => (400, 220),
        }
    }
}

/// A control's rectangle in **physical** pixels, relative to the client area
/// of the window that reports it (the taskbar page multiplies
/// `getBoundingClientRect()` by `devicePixelRatio`).
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
pub struct AnchorRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// What the thumbnail popup shows. Dropping the Thumb removes the live picture.
#[derive(Default)]
struct ThumbSlot {
    task_id: Option<String>,
    thumb: Option<rulebox_desktop::thumbs::Thumb>,
}

/// Owns the message loop and the shell-mode token.
pub struct DesktopHost {
    mode: ShellMode,
    token: Option<Arc<ShellToken>>,
    msgloop: Mutex<Option<MsgLoop>>,
    /// Lets window events (DPI change) join the Win32 event stream.
    events: UnboundedSender<DesktopEvent>,
    popup: Mutex<Option<PopupKind>>,
    /// The window the thumbnail popup is about, and the live DWM thumbnail drawn in it.
    thumb: Mutex<ThumbSlot>,
    /// Volume, network and brightness. Lives on its own MTA thread.
    system: rulebox_desktop::system::Watch,
}

impl DesktopHost {
    pub fn mode(&self) -> ShellMode {
        self.mode
    }

    /// Stop the message loop (restores the work area in shell mode).
    pub fn shutdown(&self) {
        let taken = self
            .msgloop
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
        if let Some(msgloop) = taken {
            msgloop.stop();
        }
    }

    pub fn watch(&self) -> &rulebox_desktop::system::Watch {
        &self.system
    }

    /// True in shell mode: global hotkeys and the keyboard hook may exist.
    pub fn token_available(&self) -> bool {
        self.token.is_some()
    }

    /// Run  on the message-loop thread with the shell token. None in dev
    /// mode (nothing session-wide may be touched) or when the loop has stopped.
    pub fn run_on_loop<T, F>(&self, f: F) -> Option<tokio::sync::oneshot::Receiver<T>>
    where
        T: Send + 'static,
        F: FnOnce(&rulebox_desktop::LoopCtx, &ShellToken) -> T + Send + 'static,
    {
        let token = self.token.clone()?;
        let guard = self.msgloop.lock().unwrap_or_else(|e| e.into_inner());
        let msgloop = guard.as_ref()?;
        Some(msgloop.run(move |ctx| f(ctx, &token)))
    }

    /// What the shared popup is showing, if it is open.
    pub fn popup_kind(&self) -> Option<PopupKind> {
        *self.popup.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn thumb_task(&self) -> Option<String> {
        self.thumb.lock().unwrap_or_else(|e| e.into_inner()).task_id.clone()
    }

    pub fn set_thumb_task(&self, id: Option<String>) {
        let mut slot = self.thumb.lock().unwrap_or_else(|e| e.into_inner());
        slot.task_id = id;
        slot.thumb = None;
    }

    pub fn attach_thumb(&self, thumb: rulebox_desktop::thumbs::Thumb) {
        self.thumb.lock().unwrap_or_else(|e| e.into_inner()).thumb = Some(thumb);
    }

    fn drop_thumb(&self) {
        let mut slot = self.thumb.lock().unwrap_or_else(|e| e.into_inner());
        slot.thumb = None;
        slot.task_id = None;
    }

    fn request_reapply(&self) {
        let _ = self.events.send(DesktopEvent::DpiChanged);
    }
}

/// Fallback when Windows cannot tell us about the monitor: a small desktop so
/// the shell still comes up and the problem is visible in the log.
fn fallback_monitor() -> MonitorRect {
    let rect = Rect::new(0, 0, 1366, 768);
    MonitorRect {
        rect,
        work: rect,
        dpi: 96,
        scale: 1.0,
    }
}

fn current_monitor() -> MonitorRect {
    match workarea::primary_monitor() {
        Ok(monitor) => monitor,
        Err(error) => {
            tracing::error!(%error, "cannot read the primary monitor; using 1366x768");
            fallback_monitor()
        }
    }
}

fn place(window: &WebviewWindow, rect: Rect) {
    if let Err(error) = window.set_position(PhysicalPosition::new(rect.left, rect.top)) {
        tracing::warn!(label = window.label(), %error, "set_position failed");
    }
    let size = PhysicalSize::new(rect.width().max(1) as u32, rect.height().max(1) as u32);
    if let Err(error) = window.set_size(size) {
        tracing::warn!(label = window.label(), %error, "set_size failed");
    }
}

fn raw_hwnd(window: &WebviewWindow) -> Option<isize> {
    window.hwnd().ok().map(|hwnd| hwnd.0 as isize)
}

/// Create the three windows, start the message loop and (shell mode) take
/// over the work area. Call once, from `setup`.
pub fn init(
    app: &AppHandle,
    mode: ShellMode,
    services: TaskServices,
) -> Result<Arc<DesktopHost>, String> {
    let (events_tx, events_rx) = tokio::sync::mpsc::unbounded_channel();
    let msgloop = MsgLoop::start(mode, events_tx.clone())
        .map_err(|error| format!("start the desktop message loop: {error}"))?;

    let host = Arc::new(DesktopHost {
        mode,
        token: ShellToken::acquire(mode).map(Arc::new),
        msgloop: Mutex::new(Some(msgloop)),
        events: events_tx.clone(),
        popup: Mutex::new(None),
        thumb: Mutex::new(ThumbSlot::default()),
        system: rulebox_desktop::system::Watch::start(events_tx),
    });

    create_windows(app, &host)?;
    take_over_session(&host);
    reapply(app, &host);
    show_initial(app);
    start_tracking(&host);
    if let Some(state) = app.try_state::<crate::state::AppState>() {
        crate::shortcuts::start(app, &host, state.inner().clone());
    }

    let task_app = app.clone();
    let task_host = Arc::clone(&host);
    tauri::async_runtime::spawn(async move {
        consume_events(task_app, task_host, events_rx, services).await;
    });

    tracing::info!(mode = ?mode, "shell windows created");
    Ok(host)
}

/// The settings of one shell window (the table in plan Step 4).
struct Spec {
    label: &'static str,
    route: &'static str,
    title: &'static str,
    decorations: bool,
    resizable: bool,
    always_on_top: bool,
    focusable: bool,
    focused: bool,
}

fn build_window(app: &AppHandle, spec: &Spec) -> Result<WebviewWindow, String> {
    let label = spec.label;
    let url = WebviewUrl::App(format!("shell.html#/{}", spec.route).into());
    WebviewWindowBuilder::new(app, label, url)
        .title(spec.title)
        .decorations(spec.decorations)
        .resizable(spec.resizable)
        .always_on_top(spec.always_on_top)
        .focusable(spec.focusable)
        .focused(spec.focused)
        // Created hidden, placed in physical pixels, then shown: the builder's
        // own position is logical and would flash at the wrong scale.
        .visible(false)
        .shadow(false)
        .devtools(cfg!(debug_assertions))
        .disable_drag_drop_handler()
        .build()
        .map_err(|error| format!("create {label}: {error}"))
}

fn create_windows(app: &AppHandle, host: &Arc<DesktopHost>) -> Result<(), String> {
    let shell = host.mode == ShellMode::Shell;

    let desktop = build_window(
        app,
        &Spec {
            label: DESKTOP,
            route: "desktop",
            title: if shell { "Rulebox" } else { "Rulebox (dev)" },
            decorations: !shell,
            resizable: !shell,
            always_on_top: false,
            focusable: true,
            focused: true,
        },
    )?;
    let taskbar = build_window(
        app,
        &Spec {
            label: TASKBAR,
            route: "taskbar",
            title: "Rulebox taskbar",
            decorations: false,
            resizable: false,
            always_on_top: shell,
            focusable: false,
            focused: false,
        },
    )?;
    let popup = build_window(
        app,
        &Spec {
            label: POPUP,
            route: "popup",
            title: "Rulebox",
            decorations: false,
            resizable: false,
            always_on_top: true,
            focusable: true,
            focused: false,
        },
    )?;

    if !shell {
        // Dev mode: an ordinary window the developer can move around.
        let _ = desktop.set_size(tauri::LogicalSize::new(1280.0, 800.0));
        let _ = desktop.center();
    }

    // Our own strip and popup never get a taskbar button of their own.
    for window in [&taskbar, &popup] {
        if let Some(hwnd) = raw_hwnd(window) {
            if let Err(error) = rulebox_desktop::windows::set_tool_window(hwnd) {
                tracing::warn!(label = window.label(), %error, "WS_EX_TOOLWINDOW failed");
            }
        }
    }

    wire_events(&desktop, host, WindowRole::Desktop);
    wire_events(&taskbar, host, WindowRole::Taskbar);
    wire_events(&popup, host, WindowRole::Popup);
    Ok(())
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum WindowRole {
    Desktop,
    Taskbar,
    Popup,
}

fn wire_events(window: &WebviewWindow, host: &Arc<DesktopHost>, role: WindowRole) {
    let host = Arc::clone(host);
    let handle = window.app_handle().clone();
    let label = window.label().to_string();
    window.on_window_event(move |event| match event {
        // The desktop and the taskbar live for the whole run.
        WindowEvent::CloseRequested { api, .. } if role != WindowRole::Popup => {
            api.prevent_close();
        }
        WindowEvent::Focused(true) if role == WindowRole::Desktop => {
            // Click-away: a click on the desktop dismisses the popup even when
            // the popup never managed to take the focus (blur never fires).
            hide_popup(&handle, &host);
            // Keep the desktop under every program window.
            if let (Some(token), Some(window)) = (&host.token, handle.get_webview_window(&label)) {
                if let Some(hwnd) = raw_hwnd(&window) {
                    if let Err(error) = rulebox_desktop::windows::send_to_bottom(token, hwnd) {
                        tracing::warn!(%error, "could not send the desktop to the bottom");
                    }
                }
            }
        }
        WindowEvent::Focused(false) if role == WindowRole::Popup => {
            hide_popup(&handle, &host);
        }
        WindowEvent::ScaleFactorChanged { .. } => host.request_reapply(),
        _ => {}
    });
}

/// Shell-mode start-up, in this order: taskman window, hide minimized
/// windows, reserve the bottom strip. Runs on the message loop thread.
fn take_over_session(host: &Arc<DesktopHost>) {
    let Some(token) = host.token.clone() else {
        return;
    };
    let guard = host.msgloop.lock().unwrap_or_else(|e| e.into_inner());
    let Some(msgloop) = guard.as_ref() else {
        return;
    };
    // Fire and forget: failures are logged on the loop thread.
    drop(msgloop.run(move |ctx| {
        if let Err(error) = workarea::register_taskman(&token, ctx.hwnd) {
            tracing::warn!(%error, "SetTaskmanWindow failed");
        }
        if let Err(error) = workarea::hide_minimized(&token) {
            tracing::warn!(%error, "hiding minimized windows failed");
        }
        // The work area itself is reserved by `reapply`, which knows the scale.
    }));
}

/// Place the windows for the monitor as it is now. Shell mode also
/// (re)reserves the work area.
pub fn reapply(app: &AppHandle, host: &Arc<DesktopHost>) {
    let monitor = current_monitor();
    let zone = taskbar_zone_px(monitor.scale);
    let strip = taskbar_rect(host.mode, monitor.rect, monitor.work, monitor.scale);

    if let Some(taskbar) = app.get_webview_window(TASKBAR) {
        place(&taskbar, strip);
    }

    if host.mode == ShellMode::Shell {
        if let Some(desktop) = app.get_webview_window(DESKTOP) {
            place(&desktop, monitor.rect);
        }
        if let Some(token) = host.token.clone() {
            let guard = host.msgloop.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(msgloop) = guard.as_ref() {
                drop(msgloop.run(move |_| {
                    if let Err(error) = workarea::set_bottom_reserve(&token, zone) {
                        tracing::warn!(%error, "reserving the work area failed");
                    }
                }));
            }
        }
    }
}

fn show_initial(app: &AppHandle) {
    for label in [DESKTOP, TASKBAR] {
        if let Some(window) = app.get_webview_window(label) {
            if let Err(error) = window.show() {
                tracing::warn!(label, %error, "show failed");
            }
        }
    }
}

/// Follow every top-level window (read-only; harmless in dev mode, where it
/// acts as a second taskbar). Events arrive on the desktop event stream.
fn start_tracking(host: &Arc<DesktopHost>) {
    let guard = host.msgloop.lock().unwrap_or_else(|e| e.into_inner());
    let Some(msgloop) = guard.as_ref() else {
        return;
    };
    let started = msgloop.run(tracker::start);
    tauri::async_runtime::spawn(async move {
        match started.await {
            Ok(Ok(())) => tracing::info!("window tracking started"),
            Ok(Err(error)) => tracing::error!(%error, "window tracking did not start"),
            Err(_) => tracing::error!("window tracking did not start: the loop stopped"),
        }
    });
}

/// Ask the loop thread to re-enumerate windows (after a display change or a
/// resume, when events may have been missed).
fn resync_tracking(host: &Arc<DesktopHost>) {
    let guard = host.msgloop.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(msgloop) = guard.as_ref() {
        drop(msgloop.run(|_| tracker::resync()));
    }
}

fn is_system_event(event: &DesktopEvent) -> bool {
    matches!(
        event,
        DesktopEvent::VolumeChanged
            | DesktopEvent::NetworkChanged
            | DesktopEvent::PowerChanged
            | DesktopEvent::Resumed
    )
}

fn is_display_event(event: &DesktopEvent) -> bool {
    matches!(
        event,
        DesktopEvent::DisplayChanged | DesktopEvent::DpiChanged | DesktopEvent::Resumed
    )
}

async fn consume_events(
    app: AppHandle,
    host: Arc<DesktopHost>,
    mut events: UnboundedReceiver<DesktopEvent>,
    services: TaskServices,
) {
    let mut tasks = TaskHost::new(services);
    let mut hung_tick = tokio::time::interval(HUNG_CHECK_INTERVAL);
    hung_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        let first = tokio::select! {
            next = events.recv() => match next {
                Some(event) => event,
                None => break,
            },
            _ = hung_tick.tick() => {
                tasks.refresh(&app);
                continue;
            }
        };

        // Let a burst settle, then handle it as one batch: window events a
        // little (the taskbar must feel instant), display events longer.
        let settle = if is_display_event(&first) {
            REAPPLY_DEBOUNCE
        } else {
            WINDOW_EVENT_SETTLE
        };
        tokio::time::sleep(settle).await;
        let mut batch = vec![first];
        while let Ok(next) = events.try_recv() {
            batch.push(next);
        }

        let mut replace = false;
        let mut refresh_system = false;
        let mut window_events = Vec::new();
        let mut hotkeys = Vec::new();
        for event in batch {
            match event {
                DesktopEvent::Window(event) => window_events.push(event),
                DesktopEvent::Hotkey(id) => hotkeys.push(id),
                other => {
                    replace |= is_display_event(&other);
                    refresh_system |= is_system_event(&other);
                    if !is_display_event(&other) && !is_system_event(&other) {
                        tracing::debug!(event = ?other, "desktop event");
                    }
                }
            }
        }
        if replace {
            reapply(&app, &host);
            resync_tracking(&host);
        }
        if refresh_system {
            if let Some(state) = app.try_state::<crate::state::AppState>() {
                crate::system::apply_snapshot(&state, &host.watch().snapshot());
            }
        }
        if !window_events.is_empty() {
            tasks.on_events(&app, window_events);
        }
        for id in hotkeys {
            crate::shortcuts::on_hotkey(&app, &host, id);
        }
    }
}

/// Open the shared popup for `kind`, above `anchor` (physical pixels, screen
/// coordinates) or in the bottom-left corner without one.
pub fn popup_open(
    app: &AppHandle,
    host: &Arc<DesktopHost>,
    kind: PopupKind,
    anchor: Option<Rect>,
) -> Result<(), String> {
    let popup = app
        .get_webview_window(POPUP)
        .ok_or_else(|| "the popup window does not exist".to_string())?;
    let monitor = current_monitor();
    let bounds = usable_bounds(host.mode, monitor.rect, monitor.work, monitor.scale);
    let (width, height) = kind.logical_size();
    let size = (
        placement::scale_px(width, monitor.scale),
        placement::scale_px(height, monitor.scale),
    );
    let gap = placement::scale_px(POPUP_GAP_LOGICAL, monitor.scale);
    // Switching menus (Start → confirm) keeps the bottom edge, so the panel
    // stays by the taskbar instead of jumping to the corner.
    let switching = host
        .popup
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .is_some();
    let rect = if kind == PopupKind::Switcher {
        placement::centered_rect(size, bounds)
    } else if anchor.is_none() && switching {
        match (popup.outer_position(), popup.outer_size()) {
            (Ok(pos), Ok(cur)) => {
                let bottom = pos.y + cur.height as i32;
                let raw = Rect::new(pos.x, bottom - size.1, pos.x + size.0, bottom);
                placement::clamp_into(raw, bounds)
            }
            _ => popup_rect(size, anchor, bounds, gap),
        }
    } else {
        popup_rect(size, anchor, bounds, gap)
    };
    place(&popup, rect);

    *host.popup.lock().unwrap_or_else(|e| e.into_inner()) = Some(kind);
    app.emit_to(POPUP, "popup://show", serde_json::json!({ "kind": kind }))
        .map_err(|error| format!("emit popup://show: {error}"))?;
    // A preview must not take the focus from the program under the pointer.
    let takes_focus = kind != PopupKind::Thumb;
    let _ = popup.set_focusable(takes_focus);
    popup.show().map_err(|error| format!("show popup: {error}"))?;
    // The click that opened the popup counts as recent input, so Windows lets
    // us take the foreground. If it ever does not, the popup stays open until
    // the next click on the desktop (Step 9 adds a click-away fallback).
    if takes_focus {
        if let Err(error) = popup.set_focus() {
            tracing::warn!(%error, "popup could not take focus");
        }
    }
    Ok(())
}

pub fn popup_close(app: &AppHandle, host: &Arc<DesktopHost>) {
    hide_popup(app, host);
}

fn hide_popup(app: &AppHandle, host: &Arc<DesktopHost>) {
    host.drop_thumb();
    let was_open = host
        .popup
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take()
        .is_some();
    if let Some(popup) = app.get_webview_window(POPUP) {
        let _ = popup.hide();
    }
    if was_open {
        let _ = app.emit_to(POPUP, "popup://hide", ());
    }
}
