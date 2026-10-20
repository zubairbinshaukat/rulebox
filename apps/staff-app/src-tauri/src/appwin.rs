//! Built-in app windows (plan Step 11).
//!
//! Standard mode: one `app-<n>` window per document; opening the same file
//! again focuses that window. Lite mode: a single `app-0` window with at
//! most eight tabs. Positions are remembered per employee and per kind in
//! `windows.json`, next to the theme file, and restored only when the
//! rectangle still fits the work area above the taskbar strip.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use rulebox_desktop::placement::{scale_px, usable_bounds, Rect};
use rulebox_desktop::workarea::{self, MonitorRect};
use rulebox_desktop::ShellMode;
use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};

use crate::model::{NoticeTone, SessionState, ShellModeDto};
use crate::state::AppState;

const CASCADE_LOGICAL: i32 = 28;
const MIN_W: i32 = 380;
const MIN_H: i32 = 280;
pub const MAX_TABS: usize = 8;
const LITE_LABEL: &str = "app-0";

/// A document. `path` is relative to the employee root (empty = the root).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AppDoc {
    Files { path: String },
    View { path: String },
}

/// Where a built-in window snaps. Rectangles come from the work area.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SnapZone {
    Left,
    Right,
    TopLeft,
    TopRight,
    BottomLeft,
    BottomRight,
    Maximize,
    Restore,
}

/// Which default size and saved rectangle a document uses.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DocKind {
    Files,
    Image,
    Pdf,
    Text,
    Csv,
    Docx,
    Xlsx,
    Media,
    /// Allowed to be listed but nothing here can show it: the window offers "Open with".
    Unsupported,
}

/// One remembered rectangle. Physical pixels.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedPlace {
    pub kind: String,
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
    pub maximized: bool,
}

/// A tab the lite window is showing.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OpenTab {
    pub key: String,
    pub title: String,
    pub kind: String,
    pub path: String,
}

/// What opening a document does to the tab list.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TabAction {
    Select(usize),
    Append(OpenTab),
    /// The ninth document: ask the person to close one. Nothing is added.
    AskToClose,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppView {
    pub label: String,
    pub lite: bool,
    pub maximized: bool,
    pub selected: usize,
    pub tabs: Vec<TabDto>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TabDto {
    pub title: String,
    pub kind: String,
    pub path: String,
}

/// Empty, or a relative path with no `..`, drive, or leading slash.
pub fn check_relative(path: &str) -> Result<String, String> {
    if path.is_empty() {
        return Ok(String::new());
    }
    let path = path.replace('\\', "/");
    if path.starts_with('/') || path.chars().nth(1) == Some(':') {
        return Err("path must stay inside the employee's folder".into());
    }
    if path
        .split('/')
        .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err("path must stay inside the employee's folder".into());
    }
    Ok(path)
}

pub fn doc_key(doc: &AppDoc) -> String {
    match doc {
        AppDoc::Files { path } => format!("files:{path}"),
        AppDoc::View { path } => format!("view:{path}"),
    }
}

pub fn kind_of(doc: &AppDoc) -> DocKind {
    match doc {
        AppDoc::Files { .. } => DocKind::Files,
        AppDoc::View { path } => kind_from_extension(path),
    }
}

pub fn kind_name(kind: DocKind) -> &'static str {
    match kind {
        DocKind::Files => "files",
        DocKind::Image => "image",
        DocKind::Pdf => "pdf",
        DocKind::Text => "text",
        DocKind::Media => "media",
        DocKind::Csv => "csv",
        DocKind::Docx => "docx",
        DocKind::Xlsx => "xlsx",
        DocKind::Unsupported => "unsupported",
    }
}

/// Logical pixels, before DPI scale and before clamping to the work area.
pub fn default_logical_size(kind: DocKind) -> (i32, i32) {
    match kind {
        DocKind::Files => (860, 540),
        DocKind::Image => (820, 600),
        DocKind::Pdf => (820, 700),
        DocKind::Text => (780, 700),
        DocKind::Media => (980, 580),
        DocKind::Csv => (860, 520),
        DocKind::Docx => (820, 700),
        DocKind::Xlsx => (860, 520),
        DocKind::Unsupported => (560, 360),
    }
}

pub fn doc_title(doc: &AppDoc) -> String {
    match doc {
        AppDoc::Files { path } if path.is_empty() => "Files".into(),
        AppDoc::Files { path } => file_name(path),
        AppDoc::View { path } if path.is_empty() => "View".into(),
        AppDoc::View { path } => file_name(path),
    }
}

/// Half and quarter rectangles of `area`. `Restore` has no rectangle of its own.
pub fn snap_rect(zone: SnapZone, area: Rect) -> Option<Rect> {
    let width = area.width().max(1);
    let height = area.height().max(1);
    let half_w = width / 2;
    let half_h = height / 2;
    let right_w = width - half_w;
    let bottom_h = height - half_h;
    let rect = match zone {
        SnapZone::Left => Rect::new(area.left, area.top, area.left + half_w, area.bottom),
        SnapZone::Right => Rect::new(area.right - right_w, area.top, area.right, area.bottom),
        SnapZone::TopLeft => Rect::new(area.left, area.top, area.left + half_w, area.top + half_h),
        SnapZone::TopRight => {
            Rect::new(area.right - right_w, area.top, area.right, area.top + half_h)
        }
        SnapZone::BottomLeft => Rect::new(
            area.left,
            area.bottom - bottom_h,
            area.left + half_w,
            area.bottom,
        ),
        SnapZone::BottomRight => Rect::new(
            area.right - right_w,
            area.bottom - bottom_h,
            area.right,
            area.bottom,
        ),
        SnapZone::Maximize => area,
        SnapZone::Restore => return None,
    };
    Some(rect)
}

/// `index` steps of `step` down and right, wrapping before the window leaves `area`.
pub fn cascade_rect(index: u32, size: (i32, i32), area: Rect, step: i32) -> Rect {
    let width = size.0.min(area.width()).max(1);
    let height = size.1.min(area.height()).max(1);
    let step = step.max(1);
    let max_x = (area.width() - width).max(0);
    let max_y = (area.height() - height).max(0);
    let span = max_x.min(max_y);
    let slots = (span / step).max(0) + 1;
    let offset = (index % slots as u32) as i32 * step;
    let left = area.left + offset.min(max_x);
    let top = area.top + offset.min(max_y);
    Rect::new(left, top, left + width, top + height)
}

/// The same document selects its tab. A new one is appended until `max`.
pub fn consider_tab(tabs: &[OpenTab], doc: &AppDoc, max: usize) -> TabAction {
    let key = doc_key(doc);
    if let Some(index) = tabs.iter().position(|tab| tab.key == key) {
        return TabAction::Select(index);
    }
    if tabs.len() >= max {
        return TabAction::AskToClose;
    }
    let kind = kind_of(doc);
    TabAction::Append(OpenTab {
        key,
        title: doc_title(doc),
        kind: kind_name(kind).into(),
        path: doc_path(doc),
    })
}

/// Use the saved rectangle when it lies entirely inside `area`.
/// A maximized window becomes `area`. Anything else is opened at the default.
pub fn restore_if_fits(saved: &SavedPlace, area: Rect) -> Option<Rect> {
    if saved.maximized {
        return Some(area);
    }
    if saved.w < 1 || saved.h < 1 {
        return None;
    }
    let rect = Rect::new(saved.x, saved.y, saved.x + saved.w, saved.y + saved.h);
    if rect.left >= area.left
        && rect.top >= area.top
        && rect.right <= area.right
        && rect.bottom <= area.bottom
    {
        Some(rect)
    } else {
        None
    }
}

pub fn parse_places(text: &str) -> Vec<SavedPlace> {
    serde_json::from_str(text).unwrap_or_default()
}

struct Slot {
    tabs: Vec<OpenTab>,
    selected: usize,
    unsnapped: Option<Rect>,
    maximized: bool,
    /// Ignore the move/resize events caused by our own placement.
    applying: bool,
}

struct Inner {
    next: u32,
    cascade: u32,
    mode: ShellMode,
    slots: HashMap<String, Slot>,
    places: HashMap<String, SavedPlace>,
    employee: Option<String>,
    dirty: bool,
    save_scheduled: bool,
}

/// The built-in windows this process opened.
pub struct AppWindows {
    inner: Mutex<Inner>,
}

impl Default for AppWindows {
    fn default() -> Self {
        Self {
            inner: Mutex::new(Inner {
                next: 1,
                cascade: 0,
                mode: ShellMode::Dev,
                slots: HashMap::new(),
                places: HashMap::new(),
                employee: None,
                dirty: false,
                save_scheduled: false,
            }),
        }
    }
}

impl AppWindows {
    pub fn open(
        self: &Arc<Self>,
        app: &AppHandle,
        state: &AppState,
        doc: AppDoc,
    ) -> Result<String, String> {
        let (employee, lite, mode) = session_of(state)?;
        self.load_employee(&employee, mode);
        if lite {
            self.open_lite(app, state, doc, mode)
        } else {
            self.open_standard(app, doc, mode)
        }
    }

    pub fn snapshot(&self, label: &str) -> Option<AppView> {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let slot = inner.slots.get(label)?;
        Some(view_of(label, label == LITE_LABEL, slot))
    }

    pub fn select_tab(&self, app: &AppHandle, label: &str, index: usize) -> Result<(), String> {
        let view = {
            let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            let slot = inner
                .slots
                .get_mut(label)
                .ok_or("that window is not open")?;
            if index >= slot.tabs.len() {
                return Err("that tab is not open".into());
            }
            slot.selected = index;
            view_of(label, label == LITE_LABEL, slot)
        };
        let _ = app.emit_to(label, "app://state", &view);
        Ok(())
    }

    pub fn close_tab(&self, app: &AppHandle, label: &str, index: usize) -> Result<(), String> {
        let close_window = {
            let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            let Some(slot) = inner.slots.get_mut(label) else {
                return Err("that window is not open".into());
            };
            if index >= slot.tabs.len() {
                return Err("that tab is not open".into());
            }
            slot.tabs.remove(index);
            if slot.tabs.is_empty() {
                inner.slots.remove(label);
                true
            } else {
                if slot.selected >= slot.tabs.len() {
                    slot.selected = slot.tabs.len() - 1;
                } else if index < slot.selected {
                    slot.selected -= 1;
                }
                let view = view_of(label, label == LITE_LABEL, slot);
                let _ = app.emit_to(label, "app://state", &view);
                false
            }
        };
        if close_window {
            if let Some(window) = app.get_webview_window(label) {
                let _ = window.close();
            }
        }
        Ok(())
    }

    pub fn minimize(app: &AppHandle, label: &str) -> Result<(), String> {
        app.get_webview_window(label)
            .ok_or_else(|| "that window is not open".to_string())?
            .minimize()
            .map_err(|error| format!("minimize: {error}"))
    }

    pub fn close(app: &AppHandle, label: &str) -> Result<(), String> {
        app.get_webview_window(label)
            .ok_or_else(|| "that window is not open".to_string())?
            .close()
            .map_err(|error| format!("close: {error}"))
    }

    /// Maximize toggles back to the rectangle from before the snap.
    pub fn toggle_maximize(self: &Arc<Self>, app: &AppHandle, label: &str) -> Result<(), String> {
        let maximized = self
            .inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .slots
            .get(label)
            .map(|slot| slot.maximized)
            .unwrap_or(false);
        let zone = if maximized {
            SnapZone::Restore
        } else {
            SnapZone::Maximize
        };
        self.snap(app, label, zone)
    }

    pub fn snap(self: &Arc<Self>, app: &AppHandle, label: &str, zone: SnapZone) -> Result<(), String> {
        let window = app
            .get_webview_window(label)
            .ok_or_else(|| "that window is not open".to_string())?;
        let (area, scale) = self.area();
        let (rect, view) = {
            let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            let slot = inner
                .slots
                .get_mut(label)
                .ok_or("that window is not open")?;
            if !slot.maximized {
                if let Some(current) = window_rect(&window) {
                    if !matches!(zone, SnapZone::Restore) {
                        slot.unsnapped = Some(current);
                    }
                }
            }
            let rect = match zone {
                SnapZone::Restore => slot.unsnapped.unwrap_or_else(|| {
                    let kind = slot
                        .tabs
                        .get(slot.selected)
                        .map(|tab| tab.kind.as_str())
                        .unwrap_or("files");
                    default_rect(kind, area, scale)
                }),
                SnapZone::Maximize => area,
                other => snap_rect(other, area).unwrap_or(area),
            };
            slot.maximized = matches!(zone, SnapZone::Maximize);
            slot.applying = true;
            let view = view_of(label, label == LITE_LABEL, slot);
            (rect, view)
        };
        place(&window, rect);
        self.note_geometry(label, rect, matches!(zone, SnapZone::Maximize));
        if let Ok(mut inner) = self.inner.lock() {
            if let Some(slot) = inner.slots.get_mut(label) {
                slot.applying = false;
            }
        }
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        let _ = app.emit_to(label, "app://state", &view);
        Ok(())
    }

    pub fn minimize_all(&self, app: &AppHandle) {
        for label in self.labels() {
            let _ = Self::minimize(app, &label);
        }
    }

    pub fn close_all(&self, app: &AppHandle) {
        let labels = self.labels();
        if let Ok(mut inner) = self.inner.lock() {
            inner.slots.clear();
        }
        for label in labels {
            if let Some(window) = app.get_webview_window(&label) {
                let _ = window.close();
            }
        }
    }

    fn open_standard(
        self: &Arc<Self>,
        app: &AppHandle,
        doc: AppDoc,
        mode: ShellMode,
    ) -> Result<String, String> {
        let key = doc_key(&doc);
        let existing = {
            let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            inner.slots.iter().find_map(|(label, slot)| {
                slot.tabs.iter().any(|tab| tab.key == key).then(|| label.clone())
            })
        };
        if let Some(label) = existing {
            focus_window(app, &label);
            return Ok(label);
        }
        let label = {
            let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            let label = format!("app-{}", inner.next);
            inner.next += 1;
            label
        };
        let tab = match consider_tab(&[], &doc, MAX_TABS) {
            TabAction::Append(tab) => tab,
            TabAction::Select(_) | TabAction::AskToClose => {
                return Err("could not open the document".into());
            }
        };
        self.create_window(app, label, vec![tab], 0, mode, false)
    }

    fn open_lite(
        self: &Arc<Self>,
        app: &AppHandle,
        state: &AppState,
        doc: AppDoc,
        mode: ShellMode,
    ) -> Result<String, String> {
        let action = {
            let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            let tabs = inner
                .slots
                .get(LITE_LABEL)
                .map(|slot| slot.tabs.clone())
                .unwrap_or_default();
            consider_tab(&tabs, &doc, MAX_TABS)
        };
        match action {
            TabAction::AskToClose => {
                let (tone, title, detail) = tab_limit_notice();
                state.notify(tone, title, Some(detail.into()));
                Err("close a tab first".into())
            }
            TabAction::Select(index) => {
                self.select_tab(app, LITE_LABEL, index)?;
                focus_window(app, LITE_LABEL);
                Ok(LITE_LABEL.into())
            }
            TabAction::Append(tab) => {
                let exists = self
                    .inner
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .slots
                    .contains_key(LITE_LABEL);
                if exists {
                    let view = {
                        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
                        let slot = inner.slots.get_mut(LITE_LABEL).ok_or("the window is gone")?;
                        slot.tabs.push(tab);
                        slot.selected = slot.tabs.len() - 1;
                        view_of(LITE_LABEL, true, slot)
                    };
                    focus_window(app, LITE_LABEL);
                    let _ = app.emit_to(LITE_LABEL, "app://state", &view);
                    Ok(LITE_LABEL.into())
                } else {
                    self.create_window(app, LITE_LABEL.into(), vec![tab], 0, mode, true)
                }
            }
        }
    }

    fn create_window(
        self: &Arc<Self>,
        app: &AppHandle,
        label: String,
        tabs: Vec<OpenTab>,
        selected: usize,
        mode: ShellMode,
        _lite: bool,
    ) -> Result<String, String> {
        let kind = tabs
            .get(selected)
            .map(|tab| tab.kind.clone())
            .unwrap_or_else(|| "files".into());
        let title = tabs
            .get(selected)
            .map(|tab| tab.title.clone())
            .unwrap_or_else(|| "Files".into());
        let (area, scale) = area_for(mode);
        let rect = self.opening_rect(&kind, area, scale);
        let maximized = self
            .inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .places
            .get(&kind)
            .is_some_and(|place| place.maximized && restore_if_fits(place, area).is_some());

        let window = WebviewWindowBuilder::new(
            app,
            &label,
            WebviewUrl::App("apps.html#/host".into()),
        )
        .title(&title)
        .decorations(false)
        .resizable(true)
        .shadow(true)
        .min_inner_size(MIN_W as f64, MIN_H as f64)
        .visible(false)
        .focused(true)
        .devtools(cfg!(debug_assertions))
        .disable_drag_drop_handler()
        .build()
        .map_err(|error| format!("create {label}: {error}"))?;

        {
            let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            inner.slots.insert(
                label.clone(),
                Slot {
                    tabs,
                    selected,
                    unsnapped: None,
                    maximized,
                    applying: true,
                },
            );
        }
        place(&window, rect);
        self.note_geometry(&label, rect, maximized);
        if let Ok(mut inner) = self.inner.lock() {
            if let Some(slot) = inner.slots.get_mut(&label) {
                slot.applying = false;
                if !maximized {
                    slot.unsnapped = Some(rect);
                }
            }
        }
        self.watch(app, &window, &label);
        window
            .show()
            .map_err(|error| format!("show {label}: {error}"))?;
        let _ = window.set_focus();
        if let Some(view) = self.snapshot(&label) {
            let _ = app.emit_to(&label, "app://state", &view);
        }
        Ok(label)
    }

    fn opening_rect(&self, kind: &str, area: Rect, scale: f64) -> Rect {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(saved) = inner.places.get(kind) {
            if let Some(rect) = restore_if_fits(saved, area) {
                return rect;
            }
        }
        let rect = cascade_rect(
            inner.cascade,
            default_px(kind, area, scale),
            area,
            scale_px(CASCADE_LOGICAL, scale),
        );
        inner.cascade += 1;
        rect
    }

    fn watch(self: &Arc<Self>, app: &AppHandle, window: &WebviewWindow, label: &str) {
        let host = Arc::clone(self);
        let handle = app.clone();
        let label = label.to_string();
        window.on_window_event(move |event| match event {
            WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
                let Some(window) = handle.get_webview_window(&label) else {
                    return;
                };
                let applying = host
                    .inner
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .slots
                    .get(&label)
                    .is_some_and(|slot| slot.applying);
                if applying {
                    return;
                }
                let Some(rect) = window_rect(&window) else {
                    return;
                };
                let area = host.area().0;
                let maximized = nearly_same(rect, area);
                if let Ok(mut inner) = host.inner.lock() {
                    if let Some(slot) = inner.slots.get_mut(&label) {
                        slot.maximized = maximized;
                        if !maximized {
                            slot.unsnapped = Some(rect);
                        }
                    }
                }
                host.note_geometry(&label, rect, maximized);
            }
            WindowEvent::Destroyed => {
                if let Ok(mut inner) = host.inner.lock() {
                    inner.slots.remove(&label);
                }
            }
            _ => {}
        });
    }

    fn labels(&self) -> Vec<String> {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .slots
            .keys()
            .cloned()
            .collect()
    }

    fn load_employee(&self, employee: &str, mode: ShellMode) {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.mode = mode;
        if inner.employee.as_deref() == Some(employee) {
            return;
        }
        inner.employee = Some(employee.to_string());
        inner.places.clear();
        if let Some(path) = windows_path(employee) {
            if let Ok(text) = fs::read_to_string(path) {
                for place in parse_places(&text) {
                    inner.places.insert(place.kind.clone(), place);
                }
            }
        }
    }

    fn note_geometry(self: &Arc<Self>, label: &str, rect: Rect, maximized: bool) {
        let spawn = {
            let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            let kind = inner
                .slots
                .get(label)
                .and_then(|slot| slot.tabs.get(slot.selected))
                .map(|tab| tab.kind.clone());
            let Some(kind) = kind else {
                return;
            };
            inner.places.insert(
                kind.clone(),
                SavedPlace {
                    kind,
                    x: rect.left,
                    y: rect.top,
                    w: rect.width(),
                    h: rect.height(),
                    maximized,
                },
            );
            inner.dirty = true;
            if inner.save_scheduled {
                false
            } else {
                inner.save_scheduled = true;
                true
            }
        };
        if spawn {
            self.spawn_save();
        }
    }

    fn spawn_save(self: &Arc<Self>) {
        let host = Arc::clone(self);
        thread::spawn(move || loop {
            thread::sleep(Duration::from_millis(350));
            let (places, employee) = {
                let mut inner = host.inner.lock().unwrap_or_else(|e| e.into_inner());
                if !inner.dirty {
                    inner.save_scheduled = false;
                    return;
                }
                inner.dirty = false;
                (
                    inner.places.values().cloned().collect::<Vec<_>>(),
                    inner.employee.clone(),
                )
            };
            if let Some(employee) = employee {
                let _ = write_places(&employee, &places);
            }
        });
    }

    fn area(&self) -> (Rect, f64) {
        let mode = self
            .inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .mode;
        area_for(mode)
    }
}

pub fn parse_doc(kind: &str, path: &str) -> Result<AppDoc, String> {
    let path = check_relative(path)?;
    match kind {
        "files" => Ok(AppDoc::Files { path }),
        "view" => Ok(AppDoc::View { path }),
        _ => Err("unknown document".into()),
    }
}

/// Open the still-empty Files window at the employee's folder.
pub fn open_files(host: &Arc<AppWindows>, app: &AppHandle, state: &AppState) -> Result<String, String> {
    host.open(app, state, AppDoc::Files { path: String::new() })
}

fn session_of(state: &AppState) -> Result<(String, bool, ShellMode), String> {
    state.read(|shell| match &shell.session {
        SessionState::SignedIn {
            employee, locked, ..
        } if !locked => {
            let mode = match shell.mode {
                ShellModeDto::Shell => ShellMode::Shell,
                ShellModeDto::Dev => ShellMode::Dev,
            };
            Ok((employee.id.clone(), shell.display.lite, mode))
        }
        _ => Err("nobody is signed in".into()),
    })
}

/// The same table the files backend uses to pick a viewer, so a window and
/// `fs_open` never disagree. A name no viewer takes is `Unsupported`.
fn kind_from_extension(path: &str) -> DocKind {
    use crate::files::types::{viewer_for_name, ViewerKind};
    match viewer_for_name(path) {
        Some(ViewerKind::Image) => DocKind::Image,
        Some(ViewerKind::Media) => DocKind::Media,
        Some(ViewerKind::Pdf) => DocKind::Pdf,
        Some(ViewerKind::Text) => DocKind::Text,
        Some(ViewerKind::Csv) => DocKind::Csv,
        Some(ViewerKind::Docx) => DocKind::Docx,
        Some(ViewerKind::Xlsx) => DocKind::Xlsx,
        None => DocKind::Unsupported,
    }
}
fn file_name(path: &str) -> String {
    path.rsplit(['/', '\\'])
        .next()
        .filter(|name| !name.is_empty())
        .unwrap_or(path)
        .to_string()
}

fn doc_path(doc: &AppDoc) -> String {
    match doc {
        AppDoc::Files { path } | AppDoc::View { path } => path.clone(),
    }
}

fn view_of(label: &str, lite: bool, slot: &Slot) -> AppView {
    AppView {
        label: label.into(),
        lite,
        maximized: slot.maximized,
        selected: slot.selected,
        tabs: slot
            .tabs
            .iter()
            .map(|tab| TabDto {
                title: tab.title.clone(),
                kind: tab.kind.clone(),
                path: tab.path.clone(),
            })
            .collect(),
    }
}

pub(crate) fn focus_window(app: &AppHandle, label: &str) {
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub(crate) fn area_for(mode: ShellMode) -> (Rect, f64) {
    let monitor = match workarea::primary_monitor() {
        Ok(monitor) => monitor,
        Err(error) => {
            tracing::error!(%error, "cannot read the monitor; using 1366x768");
            let rect = Rect::new(0, 0, 1366, 768);
            MonitorRect {
                rect,
                work: rect,
                dpi: 96,
                scale: 1.0,
            }
        }
    };
    (
        usable_bounds(mode, monitor.rect, monitor.work, monitor.scale),
        monitor.scale,
    )
}

fn default_px(kind: &str, area: Rect, scale: f64) -> (i32, i32) {
    let logical = match kind {
        "image" => default_logical_size(DocKind::Image),
        "pdf" => default_logical_size(DocKind::Pdf),
        "text" => default_logical_size(DocKind::Text),
        "media" => default_logical_size(DocKind::Media),
        "csv" => default_logical_size(DocKind::Csv),
        "docx" => default_logical_size(DocKind::Docx),
        "xlsx" => default_logical_size(DocKind::Xlsx),
        "unsupported" => default_logical_size(DocKind::Unsupported),
        _ => default_logical_size(DocKind::Files),
    };
    let width = scale_px(logical.0, scale).clamp(1, area.width().max(1));
    let height = scale_px(logical.1, scale).clamp(1, area.height().max(1));
    (width, height)
}

fn default_rect(kind: &str, area: Rect, scale: f64) -> Rect {
    cascade_rect(0, default_px(kind, area, scale), area, scale_px(CASCADE_LOGICAL, scale))
}

fn nearly_same(a: Rect, b: Rect) -> bool {
    (a.left - b.left).abs() <= 4
        && (a.top - b.top).abs() <= 4
        && (a.right - b.right).abs() <= 4
        && (a.bottom - b.bottom).abs() <= 4
}

pub(crate) fn place(window: &WebviewWindow, rect: Rect) {
    if let Some(hwnd) = window.hwnd().ok().map(|handle| handle.0 as isize) {
        if rulebox_desktop::windows::place_outer(hwnd, rect).is_ok() {
            return;
        }
    }
    if let Err(error) = window.set_position(PhysicalPosition::new(rect.left, rect.top)) {
        tracing::warn!(label = window.label(), %error, "set_position failed");
    }
    let size = PhysicalSize::new(rect.width().max(1) as u32, rect.height().max(1) as u32);
    if let Err(error) = window.set_size(size) {
        tracing::warn!(label = window.label(), %error, "set_size failed");
    }
}

fn window_rect(window: &WebviewWindow) -> Option<Rect> {
    let pos = window.outer_position().ok()?;
    let size = window.outer_size().ok()?;
    Some(Rect::new(
        pos.x,
        pos.y,
        pos.x + size.width as i32,
        pos.y + size.height as i32,
    ))
}

fn windows_path(employee_id: &str) -> Option<PathBuf> {
    if !crate::system::plain_employee_id(employee_id) {
        return None;
    }
    let local = std::env::var_os("LOCALAPPDATA")?;
    Some(
        PathBuf::from(local)
            .join("dev.rulebox.staff")
            .join("employees")
            .join(employee_id)
            .join("windows.json"),
    )
}

fn write_places(employee_id: &str, places: &[SavedPlace]) -> Result<(), String> {
    let path = windows_path(employee_id).ok_or_else(|| "employee id is not a plain identifier".to_string())?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let body = serde_json::to_string_pretty(places).map_err(|error| error.to_string())?;
    fs::write(path, body).map_err(|error| error.to_string())
}

/// Test hook: read places from a directory the way sign-in would.
pub fn load_places_at(root: &Path, employee_id: &str) -> Vec<SavedPlace> {
    if !crate::system::plain_employee_id(employee_id) {
        return Vec::new();
    }
    let path = root.join(employee_id).join("windows.json");
    fs::read_to_string(path)
        .ok()
        .map(|text| parse_places(&text))
        .unwrap_or_default()
}

pub fn write_places_at(root: &Path, employee_id: &str, places: &[SavedPlace]) -> Result<(), String> {
    if !crate::system::plain_employee_id(employee_id) {
        return Err("employee id is not a plain identifier".into());
    }
    let path = root.join(employee_id).join("windows.json");
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let body = serde_json::to_string_pretty(places).map_err(|error| error.to_string())?;
    fs::write(path, body).map_err(|error| error.to_string())
}

/// The ninth tab is a notice, not a new window.
pub fn tab_limit_notice() -> (NoticeTone, &'static str, &'static str) {
    (
        NoticeTone::Neutral,
        "Close a tab first",
        "This window holds eight tabs.",
    )
}
