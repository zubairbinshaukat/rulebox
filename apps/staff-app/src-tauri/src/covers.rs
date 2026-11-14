//! The lock view and the full-screen notice on **every** monitor (Phase 5 Step 12, plan P13 and
//! the "Multiple monitors" edge case).
//!
//! Until now the Staff App was one desktop window on the primary monitor and the other monitors were
//! blank (Phase 3 P13). That stays so, with two exceptions that must leave no monitor showing
//! anything usable: an administrator's **device lock** and a **full-screen broadcast** that still
//! waits for "OK". While either is wanted, one borderless, always-on-top *cover window* (label
//! `shell-cover-<n>`, page `shell.html#/cover`) sits on each monitor and shows the same plain
//! surface; a blank monitor gets that plain surface too. The taskbar strip and the popup are hidden
//! meanwhile so nothing of the desktop can be clicked. The covers disappear when nothing is wanted.
//!
//! * **Shell mode only.** In dev mode (Explorer running) nothing session-wide is touched: the desktop
//!   window itself shows the view, and no other window is created on the developer's monitors.
//! * The decisions are pure ([`want`], [`rects_from`], [`plan`]) and tested. Building a window must
//!   never happen on the UI thread inside a WebView2 callback (it froze the app on the VM), so the
//!   work runs on a blocking worker.
//! * One WebView2 per monitor, only while a cover is wanted; none otherwise (4 GB target).
//! * A cover never takes a sign-in: its page is the same read-only view, "OK" and the hidden exit.

use std::sync::{Arc, Mutex};

use rulebox_desktop::Rect;
use tauri::{
    AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};

use crate::model::{BroadcastDto, ShellState};
use crate::shellwin::{DesktopHost, TASKBAR};
use crate::state::AppState;

/// Label prefix of the cover windows (the `cover` capability matches `shell-cover-*`).
pub const COVER_PREFIX: &str = "shell-cover-";

/// Why the monitors are covered.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CoverKind {
    /// The device lock: the organization name, the message, the contact. No sign-in field.
    Lock,
    /// A full-screen broadcast that has not been acknowledged.
    Notice,
}

/// Pure: what the shell state wants covered. A lock wins over a notice.
pub fn want(shell: &ShellState) -> Option<CoverKind> {
    if shell.device_lock.is_some() {
        Some(CoverKind::Lock)
    } else if shell.broadcasts.iter().any(BroadcastDto::needs_full_screen) {
        Some(CoverKind::Notice)
    } else {
        None
    }
}

/// Pure: monitors as `(x, y, width, height)` in physical pixels to rectangles. A monitor that reports
/// no area is skipped; the order is left to right, then top to bottom, so labels stay stable.
pub fn rects_from(monitors: &[(i32, i32, u32, u32)]) -> Vec<Rect> {
    let mut rects: Vec<Rect> = monitors
        .iter()
        .filter(|(_, _, width, height)| *width > 0 && *height > 0)
        .map(|(x, y, width, height)| {
            Rect::new(
                *x,
                *y,
                x.saturating_add(i32::try_from(*width).unwrap_or(i32::MAX)),
                y.saturating_add(i32::try_from(*height).unwrap_or(i32::MAX)),
            )
        })
        .collect();
    rects.sort_by_key(|rect| (rect.left, rect.top));
    rects
}

/// The label of the cover on the n-th monitor.
pub fn label_of(index: usize) -> String {
    format!("{COVER_PREFIX}{index}")
}

/// What to do with the cover windows to reach a wanted set of rectangles.
#[derive(Debug, PartialEq, Eq)]
pub struct Plan {
    /// New windows: label and where.
    pub create: Vec<(String, Rect)>,
    /// Windows that stay: label and (possibly new) place.
    pub keep: Vec<(String, Rect)>,
    /// Windows no monitor needs any more.
    pub destroy: Vec<String>,
}

/// Pure: `existing` are the labels of the cover windows now, `rects` the monitors to cover (empty =
/// nothing wanted, so every existing cover goes).
pub fn plan(existing: &[String], rects: &[Rect]) -> Plan {
    let mut create = Vec::new();
    let mut keep = Vec::new();
    for (index, rect) in rects.iter().enumerate() {
        let label = label_of(index);
        if existing.contains(&label) {
            keep.push((label, *rect));
        } else {
            create.push((label, *rect));
        }
    }
    let wanted: Vec<String> = (0..rects.len()).map(label_of).collect();
    let destroy = existing.iter().filter(|label| !wanted.contains(label)).cloned().collect();
    Plan { create, keep, destroy }
}

/// What was last applied, so a state change that does not touch the covers does no window work.
static APPLIED: Mutex<Option<CoverKind>> = Mutex::new(None);
/// The taskbar strip was hidden by a cover (and must be shown again when the cover goes).
static TASKBAR_HIDDEN_BY_COVER: Mutex<bool> = Mutex::new(false);

/// Called after every state emit: when the wanted cover changed, the windows follow.
pub fn follow_state(app: &AppHandle, state: &AppState) {
    let wanted = state.read(want);
    {
        let mut applied = APPLIED.lock().unwrap_or_else(|e| e.into_inner());
        if *applied == wanted {
            return;
        }
        *applied = wanted;
    }
    sync(app, wanted);
}

/// After a display change: the monitors may be different now, so the covers are placed again.
pub fn reapply(app: &AppHandle) {
    let wanted = *APPLIED.lock().unwrap_or_else(|e| e.into_inner());
    if wanted.is_some() {
        sync(app, wanted);
    }
}

fn sync(app: &AppHandle, wanted: Option<CoverKind>) {
    let Some(host) = app.try_state::<Arc<DesktopHost>>() else {
        return;
    };
    let host = host.inner().clone();
    if !host.token_available() {
        // Dev mode: the desktop window shows the view; nothing is created or hidden.
        if wanted.is_some() {
            tracing::info!(?wanted, "dev mode: no cover windows on the other monitors");
        }
        return;
    }
    let app = app.clone();
    // Window work off the caller's thread (see the module note).
    tauri::async_runtime::spawn_blocking(move || apply(&app, &host, wanted));
}

fn monitors_of(app: &AppHandle) -> Vec<(i32, i32, u32, u32)> {
    match app.available_monitors() {
        Ok(monitors) => monitors
            .iter()
            .map(|monitor| {
                let (position, size) = (monitor.position(), monitor.size());
                (position.x, position.y, size.width, size.height)
            })
            .collect(),
        Err(error) => {
            tracing::warn!(%error, "cannot list the monitors; covering the primary one only");
            app.primary_monitor()
                .ok()
                .flatten()
                .map(|monitor| vec![(monitor.position().x, monitor.position().y, monitor.size().width, monitor.size().height)])
                .unwrap_or_default()
        }
    }
}

fn existing_labels(app: &AppHandle) -> Vec<String> {
    app.webview_windows().keys().filter(|label| label.starts_with(COVER_PREFIX)).cloned().collect()
}

fn place(window: &WebviewWindow, rect: Rect) {
    if let Err(error) = window.set_position(PhysicalPosition::new(rect.left, rect.top)) {
        tracing::warn!(label = window.label(), %error, "cover: set_position failed");
    }
    let size = PhysicalSize::new(rect.width().max(1) as u32, rect.height().max(1) as u32);
    if let Err(error) = window.set_size(size) {
        tracing::warn!(label = window.label(), %error, "cover: set_size failed");
    }
}

fn build(app: &AppHandle, label: &str) -> Result<WebviewWindow, String> {
    let url = WebviewUrl::App("shell.html#/cover".into());
    let builder = WebviewWindowBuilder::new(app, label, url);
    let builder = if cfg!(debug_assertions) {
        builder.initialization_script("window.__RB_DEBUG__ = true;")
    } else {
        builder
    };
    let builder = match crate::shellwin::local_browser_args() {
        Some(args) => builder.additional_browser_args(&args),
        None => builder,
    };
    builder
        .title("Rulebox")
        .decorations(false)
        .resizable(false)
        .always_on_top(true)
        .focusable(true)
        .focused(false)
        .skip_taskbar(true)
        // Created hidden, placed in physical pixels, then shown (the builder's position is logical).
        .visible(false)
        .shadow(false)
        .devtools(cfg!(debug_assertions))
        .disable_drag_drop_handler()
        .build()
        .map_err(|error| format!("create {label}: {error}"))
}

/// Runs on a blocking worker. Brings the cover windows to what `wanted` says.
fn apply(app: &AppHandle, host: &Arc<DesktopHost>, wanted: Option<CoverKind>) {
    let rects = if wanted.is_some() { rects_from(&monitors_of(app)) } else { Vec::new() };
    let existing = existing_labels(app);
    let plan = plan(&existing, &rects);

    for label in &plan.destroy {
        if let Some(window) = app.get_webview_window(label) {
            // `destroy`, not `close`: a cover refuses close requests (Alt+F4 must not remove it).
            if let Err(error) = window.destroy() {
                tracing::warn!(label, %error, "cover: destroy failed");
            }
        }
    }
    for (label, rect) in &plan.keep {
        if let Some(window) = app.get_webview_window(label) {
            place(&window, *rect);
        }
    }
    for (label, rect) in &plan.create {
        match build(app, label) {
            Ok(window) => {
                window.on_window_event(|event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                    }
                });
                place(&window, *rect);
                if let Err(error) = window.show() {
                    tracing::warn!(label, %error, "cover: show failed");
                }
            }
            Err(error) => tracing::error!(%error, "cover window could not be created"),
        }
    }

    // While a cover is up, nothing of the desktop may be clicked: no Start, no taskbar buttons.
    let mut hidden = TASKBAR_HIDDEN_BY_COVER.lock().unwrap_or_else(|e| e.into_inner());
    if wanted.is_some() {
        crate::shellwin::popup_close(app, host);
        if let Some(taskbar) = app.get_webview_window(TASKBAR) {
            if taskbar.hide().is_ok() {
                *hidden = true;
            }
        }
    } else if std::mem::take(&mut *hidden) {
        if let Some(taskbar) = app.get_webview_window(TASKBAR) {
            let _ = taskbar.show();
        }
    }
    tracing::info!(?wanted, monitors = rects.len(), "cover windows follow the state");
}
