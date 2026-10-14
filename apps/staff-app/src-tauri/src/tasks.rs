//! The task list: tracked windows of every program → `TaskItem`s for the
//! taskbar, plus the `rbicon://` protocol that serves their icons (plan
//! Step 7).
//!
//! `TaskTable` is pure (windows and labels in, items out) so grouping and
//! change handling are unit-tested. `TaskHost` and `IconStore` are the thin
//! glue to Tauri state and the icon worker.

use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rulebox_desktop::tracker::WindowEvent;
use rulebox_desktop::windows::WindowInfo;
use tauri::{AppHandle, Manager};

use crate::launcher::Launcher;
use crate::model::{AppEntry, AppKind, BuiltinTool, TaskItem};
use crate::state::AppState;

/// Browsers re-request after this; the server cache uses the same lifetime.
const ICON_MAX_AGE: Duration = Duration::from_secs(60);
const ICON_CACHE_LIMIT: usize = 256;
const ICON_DEFAULT_SIZE: u32 = 48;

// ---------------------------------------------------------------------------
// Labels: which of the windows are ours.
// ---------------------------------------------------------------------------

/// What a window label says about a window.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LabelKind {
    /// `shell-*`: the desktop, taskbar, popup and exit windows. Never listed.
    Shell,
    /// `app-<n>`: a built-in app window.
    Builtin,
    /// `web-<appId>-<n>`: a web app window.
    Web { app_id: String },
}

pub fn parse_label(label: &str) -> Option<LabelKind> {
    if label.starts_with("shell-") {
        return Some(LabelKind::Shell);
    }
    if label.starts_with("app-") {
        return Some(LabelKind::Builtin);
    }
    let rest = label.strip_prefix("web-")?;
    // `web-<appId>-<n>`: the id may itself contain dashes, the counter does not.
    let (id, counter) = rest.rsplit_once('-')?;
    if id.is_empty() || counter.is_empty() || !counter.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some(LabelKind::Web {
        app_id: id.to_string(),
    })
}

/// HWND → window label, for every window Tauri owns.
pub type Labels = HashMap<isize, String>;

fn labels_of(app: &AppHandle) -> Labels {
    app.webview_windows()
        .into_iter()
        .filter_map(|(label, window)| {
            window
                .hwnd()
                .ok()
                .map(|hwnd| (hwnd.0 as isize, label))
        })
        .collect()
}

// ---------------------------------------------------------------------------
// The table.
// ---------------------------------------------------------------------------

/// `C:\Foo\Bar.EXE` and `c:/foo/bar.exe` and `\\?\C:\Foo\Bar.exe` compare equal.
fn normalize_path(path: &str) -> String {
    let path = path.strip_prefix(r"\\?\").unwrap_or(path);
    path.replace('/', "\\").to_lowercase()
}

/// Which catalogue app a program window belongs to: first by the job the
/// shell started it in (`launched`: pid → app id), then by program file.
/// (The catalogue has no AUMIDs yet.)
fn match_catalogue_app(
    info: &WindowInfo,
    catalogue: &[AppEntry],
    launched: &HashMap<u32, String>,
) -> Option<String> {
    if let Some(app_id) = launched.get(&info.pid) {
        return Some(app_id.clone());
    }
    let exe = normalize_path(&info.exe.as_ref()?.to_string_lossy());
    catalogue.iter().find_map(|app| match &app.kind {
        AppKind::Desktop(desktop) if normalize_path(&desktop.exe) == exe => Some(app.id.clone()),
        _ => None,
    })
}

#[derive(Default)]
pub struct TaskTable {
    order: Vec<isize>,
    windows: HashMap<isize, WindowInfo>,
    active: Option<isize>,
    flashing: HashSet<isize>,
    hung: HashSet<isize>,
    icon_rev: HashMap<isize, u32>,
    /// Built-in windows that show a catalogue app (the Files window): hwnd →
    /// app id, so the window groups under that app's pinned button.
    builtin_apps: HashMap<isize, String>,
}

impl TaskTable {
    /// Apply one tracker event. Returns `true` when the list may look
    /// different (the caller republishes).
    pub fn apply(&mut self, event: &WindowEvent, labels: &Labels) -> bool {
        match event {
            WindowEvent::Added(info) => {
                if !self.windows.contains_key(&info.hwnd) {
                    self.order.push(info.hwnd);
                }
                self.windows.insert(info.hwnd, info.clone());
                true
            }
            WindowEvent::Changed(info) => match self.windows.get_mut(&info.hwnd) {
                Some(slot) if slot != info => {
                    *slot = info.clone();
                    true
                }
                Some(_) => false,
                None => {
                    self.order.push(info.hwnd);
                    self.windows.insert(info.hwnd, info.clone());
                    true
                }
            },
            WindowEvent::Removed(hwnd) => {
                self.flashing.remove(hwnd);
                self.hung.remove(hwnd);
                self.icon_rev.remove(hwnd);
                let existed = self.windows.remove(hwnd).is_some();
                self.order.retain(|h| h != hwnd);
                if self.active == Some(*hwnd) {
                    self.active = None;
                }
                existed
            }
            WindowEvent::Activated(target) => {
                let next = match target {
                    None => None,
                    Some(hwnd) => match labels.get(hwnd).and_then(|l| parse_label(l)) {
                        // The desktop took focus: nothing is active.
                        Some(LabelKind::Shell) if labels.get(hwnd).map(String::as_str) == Some("shell-desktop") => None,
                        // Popup / exit dialog: the program under it stays active.
                        Some(LabelKind::Shell) => self.active,
                        // Kept even when the window is not listed (yet): a
                        // new window often takes the focus before its
                        // `Added` event is handled. A handle that never gets
                        // listed (a tool window) simply marks nothing active.
                        _ => Some(*hwnd),
                    },
                };
                let changed = self.active != next;
                self.active = next;
                changed
            }
            WindowEvent::Flash(hwnd, on) => {
                if *on {
                    self.flashing.insert(*hwnd)
                } else {
                    self.flashing.remove(hwnd)
                }
            }
            WindowEvent::IconChanged(hwnd) => {
                if self.windows.contains_key(hwnd) {
                    *self.icon_rev.entry(*hwnd).or_insert(0) += 1;
                    true
                } else {
                    false
                }
            }
        }
    }

    /// Tell the table which built-in windows show a catalogue app. Returns
    /// `true` when that changed.
    pub fn set_builtin_apps(&mut self, apps: HashMap<isize, String>) -> bool {
        if self.builtin_apps == apps {
            return false;
        }
        self.builtin_apps = apps;
        true
    }

    /// Replace the set of hung windows. Returns `true` when it changed.
    pub fn set_hung(&mut self, hung: HashSet<isize>) -> bool {
        if self.hung == hung {
            return false;
        }
        self.hung = hung;
        true
    }

    /// Windows worth a hung check: everything that is not minimized.
    pub fn visible_handles(&self) -> Vec<isize> {
        self.order
            .iter()
            .filter(|hwnd| self.windows.get(hwnd).is_some_and(|w| !w.minimized))
            .copied()
            .collect()
    }

    /// Where each tracked window's icon can come from.
    pub fn tracked(&self) -> Vec<(isize, IconSource)> {
        self.order
            .iter()
            .filter_map(|hwnd| self.windows.get(hwnd))
            .map(|info| {
                (
                    info.hwnd,
                    IconSource {
                        exe: info.exe.clone(),
                        // Only the frame of a packaged app: its own icon is
                        // the generic one of ApplicationFrameHost.
                        packaged_aumid: (info.class == "ApplicationFrameWindow")
                            .then(|| info.aumid.clone())
                            .flatten(),
                    },
                )
            })
            .collect()
    }

    /// Process ids of every tracked window.
    pub fn pids(&self) -> HashSet<u32> {
        self.windows.values().map(|info| info.pid).collect()
    }

    /// What the commands may act on: every listed (non-shell) window.
    pub fn facts(&self, labels: &Labels) -> Vec<(isize, TaskFacts)> {
        self.order
            .iter()
            .filter_map(|hwnd| {
                let info = self.windows.get(hwnd)?;
                let own = match labels.get(hwnd).and_then(|label| parse_label(label)) {
                    Some(LabelKind::Shell) => return None,
                    Some(_) => true,
                    None => false,
                };
                Some((
                    *hwnd,
                    TaskFacts {
                        pid: info.pid,
                        own,
                        minimized: info.minimized,
                        active: self.active == Some(*hwnd),
                        hung: self.hung.contains(hwnd),
                    },
                ))
            })
            .collect()
    }

    /// The taskbar's list, in the order windows appeared. `launched` maps
    /// the processes of apps the shell started to their catalogue app id.
    pub fn items(
        &self,
        labels: &Labels,
        catalogue: &[AppEntry],
        launched: &HashMap<u32, String>,
    ) -> Vec<TaskItem> {
        let mut items = Vec::with_capacity(self.order.len());
        for hwnd in &self.order {
            let Some(info) = self.windows.get(hwnd) else {
                continue;
            };
            let kind = labels.get(hwnd).and_then(|label| parse_label(label));
            let (own, app_id) = match kind {
                Some(LabelKind::Shell) => continue,
                Some(LabelKind::Builtin) => (true, self.builtin_apps.get(hwnd).cloned()),
                Some(LabelKind::Web { app_id }) => (true, Some(app_id)),
                None => (false, match_catalogue_app(info, catalogue, launched)),
            };
            items.push(TaskItem {
                id: hwnd.to_string(),
                app_id,
                title: info.title.clone(),
                icon_key: format!("hwnd:{hwnd}:{}", self.icon_rev.get(hwnd).copied().unwrap_or(0)),
                active: self.active == Some(*hwnd),
                minimized: info.minimized,
                flashing: self.flashing.contains(hwnd),
                hung: self.hung.contains(hwnd),
                own,
            });
        }
        items
    }
}

/// What the control commands know about a listed window.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TaskFacts {
    pub pid: u32,
    /// One of our own windows (`app-*`, `web-*`).
    pub own: bool,
    pub minimized: bool,
    pub active: bool,
    pub hung: bool,
}

/// The windows the control commands may act on. Commands take an id from
/// React and look it up here, so a made-up handle controls nothing.
#[derive(Default)]
pub struct TaskRegistry {
    windows: Mutex<HashMap<isize, TaskFacts>>,
    /// Windows the last "show desktop" minimized, to restore on the next one.
    desktop_minimized: Mutex<Vec<isize>>,
}

impl TaskRegistry {
    pub fn sync(&self, facts: Vec<(isize, TaskFacts)>) {
        *self.windows.lock().unwrap_or_else(|e| e.into_inner()) = facts.into_iter().collect();
    }

    /// Facts of a listed window; `id` is the decimal HWND string of a `TaskItem`.
    pub fn lookup(&self, id: &str) -> Option<(isize, TaskFacts)> {
        let hwnd = id.parse::<isize>().ok()?;
        self.windows
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&hwnd)
            .map(|facts| (hwnd, *facts))
    }

    /// Every listed window, for log out and lock. Shell windows are not listed.
    pub fn snapshot(&self) -> Vec<(isize, TaskFacts)> {
        self.windows
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .map(|(hwnd, facts)| (*hwnd, *facts))
            .collect()
    }

    /// `(hwnd, minimized)` of every listed window.
    pub fn listed(&self) -> Vec<(isize, bool)> {
        self.windows
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .map(|(hwnd, facts)| (*hwnd, facts.minimized))
            .collect()
    }

    pub fn desktop_minimized(&self) -> Vec<isize> {
        self.desktop_minimized
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    pub fn set_desktop_minimized(&self, windows: Vec<isize>) {
        *self
            .desktop_minimized
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = windows;
    }
}

/// What a click on a window's button does.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClickAction {
    Restore,
    Minimize,
    Focus,
}

/// Restore if minimized; minimize if it is the active window; else focus.
pub fn click_action(minimized: bool, active: bool) -> ClickAction {
    if minimized {
        ClickAction::Restore
    } else if active {
        ClickAction::Minimize
    } else {
        ClickAction::Focus
    }
}

/// What "show desktop" does next.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ShowDesktopPlan {
    Minimize(Vec<isize>),
    Restore(Vec<isize>),
}

/// First call: minimize everything that is open. Second call: restore what
/// the first one minimized and that is still minimized (a window the person
/// restored by hand in between is left alone; if none is left, the call
/// starts over and minimizes again).
pub fn plan_show_desktop(remembered: &[isize], listed: &[(isize, bool)]) -> ShowDesktopPlan {
    let to_restore: Vec<isize> = remembered
        .iter()
        .copied()
        .filter(|hwnd| listed.iter().any(|(h, minimized)| h == hwnd && *minimized))
        .collect();
    if !to_restore.is_empty() {
        return ShowDesktopPlan::Restore(to_restore);
    }
    ShowDesktopPlan::Minimize(
        listed
            .iter()
            .filter(|(_, minimized)| !minimized)
            .map(|(hwnd, _)| *hwnd)
            .collect(),
    )
}

/// Everything the task commands and the window event task share.
#[derive(Clone, Default)]
pub struct TaskServices {
    pub icons: Arc<IconStore>,
    pub registry: Arc<TaskRegistry>,
    pub launcher: Arc<Launcher>,
}

/// Collapse a burst of events: of several `Changed` for one window only the
/// last matters, and a `Changed` before that window's `Removed` is moot.
pub fn coalesce(events: Vec<WindowEvent>) -> Vec<WindowEvent> {
    let mut keep = vec![true; events.len()];
    let mut last_changed: HashMap<isize, usize> = HashMap::new();
    for (index, event) in events.iter().enumerate() {
        match event {
            WindowEvent::Changed(info) => {
                if let Some(previous) = last_changed.insert(info.hwnd, index) {
                    keep[previous] = false;
                }
            }
            WindowEvent::Removed(hwnd) => {
                if let Some(previous) = last_changed.remove(hwnd) {
                    keep[previous] = false;
                }
            }
            _ => {}
        }
    }
    events
        .into_iter()
        .zip(keep)
        .filter_map(|(event, keep)| keep.then_some(event))
        .collect()
}

// ---------------------------------------------------------------------------
// Icons.
// ---------------------------------------------------------------------------

/// `hwnd:<n>:<rev>` → `(n, rev)`. The revision only exists so a changed icon
/// gets a new URL; it is not needed to find the window.
pub fn parse_icon_key(key: &str) -> Option<isize> {
    let rest = key.strip_prefix("hwnd:")?;
    let (hwnd, rev) = rest.split_once(':').unwrap_or((rest, "0"));
    rev.parse::<u32>().ok()?;
    hwnd.parse::<isize>().ok().filter(|hwnd| *hwnd != 0)
}

/// Query string `s=<px>` → clamped size.
pub fn parse_icon_size(query: Option<&str>) -> u32 {
    query
        .into_iter()
        .flat_map(|q| q.split('&'))
        .find_map(|pair| pair.strip_prefix("s="))
        .and_then(|value| value.parse::<u32>().ok())
        .map_or(ICON_DEFAULT_SIZE, |size| size.clamp(16, 256))
}

struct CachedIcon {
    at: Instant,
    png: Arc<Vec<u8>>,
}

/// What an icon can be rendered from, besides the window itself.
#[derive(Clone, Debug, Default)]
pub struct IconSource {
    pub exe: Option<PathBuf>,
    pub packaged_aumid: Option<String>,
}

/// Which windows the icon protocol may answer for, and what it has rendered.
#[derive(Default)]
pub struct IconStore {
    tracked: Mutex<HashMap<isize, IconSource>>,
    cache: Mutex<HashMap<(isize, u32, u32), CachedIcon>>,
}

impl IconStore {
    pub fn sync(&self, windows: Vec<(isize, IconSource)>) {
        let mut tracked = self.tracked.lock().unwrap_or_else(|e| e.into_inner());
        *tracked = windows.into_iter().collect();
        let mut cache = self.cache.lock().unwrap_or_else(|e| e.into_inner());
        cache.retain(|(hwnd, _, _), _| tracked.contains_key(hwnd));
    }

    /// Render (or fetch) the icon for a key. Blocking: call from a worker.
    pub fn render(&self, key: &str, size: u32) -> Option<Arc<Vec<u8>>> {
        let hwnd = parse_icon_key(key)?;
        let rev = key.rsplit(':').next().and_then(|r| r.parse().ok()).unwrap_or(0);
        let source = {
            let tracked = self.tracked.lock().unwrap_or_else(|e| e.into_inner());
            // Only windows the tracker listed: this is not a way to probe
            // arbitrary handles.
            tracked.get(&hwnd)?.clone()
        };
        let cache_key = (hwnd, size, rev);
        {
            let cache = self.cache.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(hit) = cache.get(&cache_key) {
                if hit.at.elapsed() < ICON_MAX_AGE {
                    return Some(Arc::clone(&hit.png));
                }
            }
        }
        // A packaged app's frame only has the host's generic icon: ask the
        // shell for the app's own first.
        let packaged = source
            .packaged_aumid
            .as_deref()
            .and_then(|aumid| rulebox_desktop::icons::app_icon_png(aumid, size));
        let png = packaged
            .or_else(|| rulebox_desktop::icons::icon_png(hwnd, size))
            .or_else(|| {
                source
                    .exe
                    .as_deref()
                    .and_then(|exe| rulebox_desktop::icons::exe_icon_png(exe, size))
            })?;
        let png = Arc::new(png);
        let mut cache = self.cache.lock().unwrap_or_else(|e| e.into_inner());
        if cache.len() >= ICON_CACHE_LIMIT {
            cache.clear();
        }
        cache.insert(
            cache_key,
            CachedIcon {
                at: Instant::now(),
                png: Arc::clone(&png),
            },
        );
        Some(png)
    }
}

/// The `rbicon` protocol: `http://rbicon.localhost/hwnd:<n>:<rev>?s=<px>`.
pub fn serve_icon(
    store: &Arc<IconStore>,
    request: tauri::http::Request<Vec<u8>>,
    responder: tauri::UriSchemeResponder,
) {
    let key = request.uri().path().trim_start_matches('/').to_string();
    let size = parse_icon_size(request.uri().query());
    let store = Arc::clone(store);
    tauri::async_runtime::spawn_blocking(move || {
        let response = match store.render(&key, size) {
            Some(png) => tauri::http::Response::builder()
                .status(200)
                .header("Content-Type", "image/png")
                .header("Cache-Control", "max-age=60")
                .body(Cow::Owned(png.as_ref().clone())),
            None => tauri::http::Response::builder()
                .status(404)
                .header("Cache-Control", "no-store")
                .body(Cow::Borrowed(&[][..])),
        };
        match response {
            Ok(response) => responder.respond(response),
            Err(error) => tracing::warn!(%error, "could not build the icon response"),
        }
    });
}

// ---------------------------------------------------------------------------
// Glue.
// ---------------------------------------------------------------------------

/// Which built-in windows show a catalogue app: a Files window (its selected
/// tab) belongs to the catalogue's Files app. Viewers belong to no app.
fn builtin_apps_of(app: &AppHandle, state: &AppState, labels: &Labels) -> HashMap<isize, String> {
    let files_app = state.read(|s| {
        s.apps.items.iter().find_map(|entry| match &entry.kind {
            AppKind::Builtin {
                tool: BuiltinTool::Files,
            } => Some(entry.id.clone()),
            _ => None,
        })
    });
    let (Some(files_app), Some(windows)) = (
        files_app,
        app.try_state::<Arc<crate::appwin::AppWindows>>(),
    ) else {
        return HashMap::new();
    };
    labels
        .iter()
        .filter(|(_, label)| matches!(parse_label(label), Some(LabelKind::Builtin)))
        .filter_map(|(hwnd, label)| {
            let view = windows.snapshot(label)?;
            let tab = view.tabs.get(view.selected)?;
            (tab.kind == "files").then(|| (*hwnd, files_app.clone()))
        })
        .collect()
}

/// Owns the table; lives inside the desktop event task.
pub struct TaskHost {
    table: TaskTable,
    services: TaskServices,
}

impl TaskHost {
    pub fn new(services: TaskServices) -> Self {
        Self {
            table: TaskTable::default(),
            services,
        }
    }

    /// Apply a batch of tracker events and publish once.
    pub fn on_events(&mut self, app: &AppHandle, events: Vec<WindowEvent>) {
        let labels = labels_of(app);
        let mut changed = false;
        for event in &coalesce(events) {
            changed |= self.table.apply(event, &labels);
            // A program that handed off to another process still gets its
            // window counted as the launched app's.
            if let WindowEvent::Added(info) = event {
                self.services
                    .launcher
                    .adopt(info.hwnd, info.pid, info.exe.as_deref());
            }
        }
        if changed {
            self.publish(app, &labels);
        }
    }

    /// Re-check which windows are hung (every few seconds). Also re-resolves
    /// labels and catalogue matches, which can change without a window event.
    pub fn refresh(&mut self, app: &AppHandle) {
        let hung: HashSet<isize> = self
            .table
            .visible_handles()
            .into_iter()
            .filter(|hwnd| rulebox_desktop::control::is_hung(*hwnd))
            .collect();
        self.table.set_hung(hung);
        let labels = labels_of(app);
        self.publish(app, &labels);
    }

    fn publish(&mut self, app: &AppHandle, labels: &Labels) {
        self.services.icons.sync(self.table.tracked());
        self.services.registry.sync(self.table.facts(labels));
        let Some(state) = app.try_state::<AppState>() else {
            return;
        };
        let launched = self.services.launcher.pid_map(&self.table.pids());
        self.table
            .set_builtin_apps(builtin_apps_of(app, &state, labels));
        let items = state.read(|s| self.table.items(labels, &s.apps.items, &launched));
        let differs = state.read(|s| s.tasks != items);
        if differs {
            state.update(|s| s.tasks = items);
        }
    }
}
