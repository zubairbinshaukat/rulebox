//! Web app windows (plan Step 15, PRD 6.2, 5.3, 24.1).
//!
//! A web app is an ordinary site in its own native window. It gets no Tauri
//! IPC at all (no capability matches `web-*`), only addresses on its
//! allow-list, no prompts, and a browser profile of its own per employee.

pub mod allow;
pub mod bar;
mod barhost;
pub mod blocked;
pub mod download;
mod hooks;
pub mod icon;
pub mod idle;
pub mod nav;
pub mod permissions;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use rulebox_desktop::placement::scale_px;
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri::webview::{DownloadEvent, NewWindowResponse};

use self::allow::AllowList;
use self::download::DownloadDecision;
use crate::appwin::{area_for, cascade_rect, focus_window, place};
use crate::model::{AppEntry, AppKind, NoticeTone, SessionState, WebPermissions};
use crate::state::AppState;

/// 1100 x 720 logical pixels, before clamping to the work area.
const WINDOW_SIZE: (i32, i32) = (1100, 720);
const CASCADE_LOGICAL: i32 = 28;

/// What the handlers of one web window know. Cheap to share.
pub struct WebWindow {
    pub label: String,
    pub app_id: String,
    pub app_name: String,
    pub employee_id: String,
    pub allow: AllowList,
    pub permissions: WebPermissions,
    /// The last allowed address shown: where "Go back" on the blocked page leads.
    last_allowed: Mutex<String>,
    /// The window is built at `about:blank`; that one navigation is let through.
    initial_blank: AtomicBool,
    /// What the bar above the site shows (see `nav.rs`, `bar.rs`).
    pub nav: Mutex<nav::NavState>,
    /// (Phase 6 Step 19) Hidden, audible, capturing: what the idle close needs (`idle.rs`).
    pub activity: idle::Activity,
}

impl WebWindow {
    fn remember(&self, url: &Url) {
        if let Ok(mut slot) = self.last_allowed.lock() {
            *slot = url.to_string();
        }
    }

    fn last_allowed(&self) -> String {
        self.last_allowed.lock().map(|slot| slot.clone()).unwrap_or_default()
    }

    /// True once, for the `about:blank` the window is built at. A page that
    /// sends itself to `about:blank` later is treated like any other address.
    fn take_initial_blank(&self, url: &Url) -> bool {
        blocked::is_blank_page(url) && self.initial_blank.swap(false, Ordering::SeqCst)
    }
}

#[derive(Default)]
struct Inner {
    next: u32,
    windows: HashMap<String, Arc<WebWindow>>,
    /// (Phase 6 Step 19) The app the employee wanted to open when the window cap stopped it: it opens once they pick a window to close.
    pending: Option<String>,
}

/// The web windows that are open.
#[derive(Default)]
pub struct WebApps {
    inner: Mutex<Inner>,
}

/// (Phase 6 Step 19) One open window in the "close one first" dialog.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapWindow {
    pub label: String,
    pub app_name: String,
}

/// (Phase 6 Step 19) What the "close one first" dialog shows: the cap, the app waiting to open and the windows that could be closed.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapPrompt {
    pub cap: usize,
    pub app_name: String,
    pub windows: Vec<CapWindow>,
}

/// (Phase 6 Step 19) The result of picking a window to close.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CapOutcome {
    /// The window was closed and the app opened.
    Opened,
    /// Still at the cap (it was lowered meanwhile): ask again.
    StillFull,
    /// Nothing is waiting, or that window is not one of ours.
    Nothing,
}

/// A web window for tests of the code around the window list (no real window behind it).
#[doc(hidden)]
#[allow(clippy::expect_used)] // a fixed, valid address
pub fn test_window(label: &str, app_id: &str, app_name: &str) -> Arc<WebWindow> {
    Arc::new(WebWindow {
        label: label.to_string(),
        app_id: app_id.to_string(),
        app_name: app_name.to_string(),
        employee_id: "e1".to_string(),
        allow: AllowList::new("https://example.com/", &[]).expect("a valid start address"),
        permissions: WebPermissions::default(),
        last_allowed: Mutex::new("https://example.com/".to_string()),
        initial_blank: AtomicBool::new(false),
        nav: Mutex::new(nav::NavState::default()),
        activity: idle::Activity::default(),
    })
}

/// A window label allows letters, digits and `-`, `_`, `/`, `:`.
fn label_part(text: &str) -> String {
    text.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect()
}

fn employee_folder(employee_id: &str) -> String {
    let clean = label_part(employee_id);
    if clean.is_empty() {
        "unknown".to_string()
    } else {
        clean
    }
}

/// `%LOCALAPPDATA%\dev.rulebox.staff\web\<employeeId>`: one profile per
/// employee, shared by that person's web apps (one browser process), never by
/// two people (their cookies and logins stay apart).
fn data_directory(employee_id: &str) -> Option<PathBuf> {
    let local = std::env::var_os("LOCALAPPDATA")?;
    Some(
        PathBuf::from(local)
            .join("dev.rulebox.staff")
            .join("web")
            .join(employee_folder(employee_id)),
    )
}

impl WebApps {
    pub fn count_open(&self) -> usize {
        self.inner.lock().map_or(0, |inner| inner.windows.len())
    }

    /// `(window label, app name)` of every open web window (the resource monitor's labels).
    pub fn open_windows(&self) -> Vec<(String, String)> {
        self.inner.lock().map_or_else(
            |_| Vec::new(),
            |inner| {
                inner
                    .windows
                    .iter()
                    .map(|(label, window)| (label.clone(), window.app_name.clone()))
                    .collect()
            },
        )
    }

    fn forget(&self, label: &str) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.windows.remove(label);
        }
    }

    /// Adds a window to the list without a real window behind it (tests only).
    #[doc(hidden)]
    pub fn insert_for_test(&self, window: Arc<WebWindow>) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.windows.insert(window.label.clone(), window);
        }
    }

    /// Would one more window pass the cap? (Browser windows of Phase 6 Step 18 will be counted here too.)
    pub fn at_cap(&self, cap: usize) -> bool {
        idle::at_cap(self.count_open(), cap)
    }

    /// The app that waits for the employee to close a window (the cap stopped it). A newer request replaces an older one.
    pub fn set_pending(&self, app_id: &str) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.pending = Some(app_id.to_string());
        }
    }

    fn take_pending(&self) -> Option<String> {
        self.inner.lock().ok().and_then(|mut inner| inner.pending.take())
    }

    /// Forgets what waited for a window to close (the employee cancelled).
    pub fn cancel_pending(&self) {
        let _ = self.take_pending();
    }

    /// What the "close one first" dialog shows, or `None` when nothing waits. Windows are listed by app name, then label.
    pub fn cap_prompt(&self, cap: usize, catalogue: &[AppEntry]) -> Option<CapPrompt> {
        let inner = self.inner.lock().ok()?;
        let waiting = inner.pending.as_deref()?;
        let app_name = catalogue.iter().find(|app| app.id == waiting).map_or_else(|| "this app".to_string(), |app| app.name.clone());
        let mut windows: Vec<CapWindow> = inner
            .windows
            .values()
            .map(|window| CapWindow { label: window.label.clone(), app_name: window.app_name.clone() })
            .collect();
        windows.sort_by(|a, b| (a.app_name.to_lowercase(), &a.label).cmp(&(b.app_name.to_lowercase(), &b.label)));
        Some(CapPrompt { cap, app_name, windows })
    }

    /// The employee picked `label` to close. Only a window of this list is closed; the waiting app is returned
    /// (`None`: nothing was waiting or the label is not one of ours, and nothing was closed). The window is removed from the
    /// list at once, so the cap sees the room without waiting for the window's own destroy event.
    pub fn take_for_close(&self, label: &str) -> Option<(Arc<WebWindow>, String)> {
        let mut inner = self.inner.lock().ok()?;
        if inner.pending.is_none() || !inner.windows.contains_key(label) {
            return None;
        }
        let window = inner.windows.remove(label)?;
        let waiting = inner.pending.take()?;
        Some((window, waiting))
    }

    /// The facts the idle close needs about every open window. `modal_open` answers whether a dialog is open over a label.
    pub fn idle_facts(&self, now: std::time::Instant, modal_open: impl Fn(&str) -> bool) -> Vec<idle::WindowFacts> {
        let windows: Vec<Arc<WebWindow>> = self.inner.lock().map_or_else(|_| Vec::new(), |inner| inner.windows.values().cloned().collect());
        windows
            .into_iter()
            .map(|window| {
                let quiet_for = window.activity.quiet_for(now);
                idle::WindowFacts {
                    label: window.label.clone(),
                    app_id: window.app_id.clone(),
                    quiet_for,
                    capturing: window.activity.capturing(),
                    // Only a hidden window is a candidate, so only its dialogs are looked up (a Win32 call each).
                    modal_open: quiet_for.is_some() && modal_open(&window.label),
                }
            })
            .collect()
    }

    /// (Phase 6 Step 19) One look at the open windows (the once-a-minute timer calls this): every window that has been hidden
    /// and silent for the idle time, with no capture and no dialog open, is closed, and its app gets the "paused" mark. Nothing is
    /// closed while nobody is signed in or when no idle time applies.
    pub fn idle_tick(&self, app: &AppHandle, state: &AppState) {
        let signed_in = state.read(|shell| matches!(shell.session, SessionState::SignedIn { .. }));
        if !signed_in {
            if state.read(|shell| !shell.paused_apps.is_empty()) {
                state.update(|shell| shell.paused_apps.clear());
            }
            return;
        }
        let Some(idle) = state.web_idle_close() else { return };
        let facts = self.idle_facts(std::time::Instant::now(), |label| {
            app.get_webview_window(label)
                .and_then(|window| window.hwnd().ok())
                .is_some_and(|hwnd| rulebox_desktop::control::has_modal_dialog(hwnd.0 as isize))
        });
        for candidate in idle::idle_candidates(&facts, idle) {
            let result = pause_then_close(state, &candidate.app_id, || match app.get_webview_window(&candidate.label) {
                Some(window) => window.close().map_err(|error| error.to_string()),
                None => Ok(()),
            });
            match result {
                Ok(()) => tracing::info!(app = %candidate.app_id, "an idle web window was closed and its app paused"),
                Err(error) => tracing::warn!(%error, app = %candidate.app_id, "an idle web window could not be closed"),
            }
        }
    }

    /// Open a window for a catalogue web app. Returns its label.
    pub fn open(self: &Arc<Self>, app: &AppHandle, state: &AppState, entry: &AppEntry) -> Result<String, String> {
        let AppKind::Web(web) = &entry.kind else {
            return Err("that is not a web app".into());
        };
        let employee_id = state
            .read(|shell| match &shell.session {
                SessionState::SignedIn {
                    employee,
                    locked: false,
                    ..
                } => Some(employee.id.clone()),
                _ => None,
            })
            .ok_or_else(|| "nobody is signed in".to_string())?;
        let allow = AllowList::new(&web.url, &web.allowed_domains).map_err(|error| error.to_string())?;
        let start = Url::parse(&web.url).map_err(|error| error.to_string())?;
        let data_dir = data_directory(&employee_id).ok_or_else(|| "LOCALAPPDATA is not set".to_string())?;
        std::fs::create_dir_all(&data_dir).map_err(|error| format!("profile folder: {error}"))?;

        let (index, label) = {
            let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            let n = inner.next;
            inner.next += 1;
            (n, format!("web-{}-{n}", label_part(&entry.id)))
        };
        let info = Arc::new(WebWindow {
            label: label.clone(),
            app_id: entry.id.clone(),
            app_name: entry.name.clone(),
            employee_id,
            allow,
            permissions: web.permissions,
            last_allowed: Mutex::new(start.to_string()),
            initial_blank: AtomicBool::new(true),
            nav: Mutex::new(nav::NavState::default()),
            activity: idle::Activity::default(),
        });
        // (Phase 6 Step 19) Opening a paused app starts it fresh at its start address: the mark goes.
        if state.read(|shell| shell.paused_apps.contains(&entry.id)) {
            state.update(|shell| shell.paused_apps.retain(|id| id != &entry.id));
        }

        // The window starts on `about:blank`, never on the app's address: the
        // hardening hooks are installed first, and only then does the same UI-thread
        // call that installed them send the window to `start`. If the hooks cannot
        // be installed the page is never loaded at all.
        let window = build_window(app, state, &info, data_dir, entry.icon_url.as_deref())?;
        if let Ok(mut inner) = self.inner.lock() {
            inner.windows.insert(label.clone(), Arc::clone(&info));
        }
        self.watch(&window, &label, Arc::clone(&info));
        hooks::install(
            &window,
            Arc::new(hooks::HookContext {
                window: Arc::clone(&info),
                state: state.clone(),
            }),
            start,
        );

        let mode = state.read(|shell| match shell.mode {
            crate::model::ShellModeDto::Shell => rulebox_desktop::ShellMode::Shell,
            crate::model::ShellModeDto::Dev => rulebox_desktop::ShellMode::Dev,
        });
        let (area, scale) = area_for(mode);
        let size = (scale_px(WINDOW_SIZE.0, scale), scale_px(WINDOW_SIZE.1, scale));
        let rect = cascade_rect(index, size, area, scale_px(CASCADE_LOGICAL, scale));
        place(&window, rect);
        window.show().map_err(|error| format!("show {label}: {error}"))?;
        let _ = window.set_focus();
        Ok(label)
    }

    /// Forget a closed window; pause the page of a minimized one.
    fn watch(self: &Arc<Self>, window: &WebviewWindow, label: &str, info: Arc<WebWindow>) {
        let host = Arc::clone(self);
        let label = label.to_string();
        let handle = window.clone();
        let suspended = std::sync::atomic::AtomicBool::new(false);
        window.on_window_event(move |event| match event {
            WindowEvent::Destroyed => host.forget(&label),
            WindowEvent::Resized(_) => {
                // A minimized page does no work until it is shown again.
                let minimized = handle.is_minimized().unwrap_or(false);
                if suspended.swap(minimized, std::sync::atomic::Ordering::SeqCst) != minimized {
                    hooks::set_suspended(&handle, minimized);
                    // Phase 6 Step 19: the idle close counts the time a window stays minimized.
                    info.activity.set_hidden(minimized, std::time::Instant::now());
                }
            }
            _ => {}
        });
    }
}

/// (Phase 6 Step 19) The app gets its "paused" mark **before** its window is closed, so no window ever goes away without the mark;
/// when closing fails the mark is taken back.
pub fn pause_then_close<E>(state: &AppState, app_id: &str, close: impl FnOnce() -> Result<(), E>) -> Result<(), E> {
    if !state.read(|shell| shell.paused_apps.iter().any(|id| id == app_id)) {
        state.update(|shell| shell.paused_apps.push(app_id.to_string()));
    }
    let result = close();
    if result.is_err() {
        state.update(|shell| shell.paused_apps.retain(|id| id != app_id));
    }
    result
}

/// (Phase 6 Step 19) Starts the one coarse timer of the idle close (once a minute). Keep the guard: dropping it stops the timer.
pub fn start_idle_watch(app: AppHandle, state: AppState, web: Arc<WebApps>) -> idle::Ticker {
    idle::spawn_ticker(idle::TICK, move || {
        let (app, state, web) = (app.clone(), state.clone(), Arc::clone(&web));
        // The look reads Win32 state: a worker thread, never the timer's own.
        tauri::async_runtime::spawn_blocking(move || web.idle_tick(&app, &state));
    })
}

fn build_window(
    app: &AppHandle,
    state: &AppState,
    info: &Arc<WebWindow>,
    data_dir: PathBuf,
    icon_url: Option<&str>,
) -> Result<WebviewWindow, String> {
    let nav_app = app.clone();
    let nav_info = Arc::clone(info);
    let new_app = app.clone();
    let new_info = Arc::clone(info);
    let download_info = Arc::clone(info);
    let download_state = state.clone();

    let mut builder = WebviewWindowBuilder::new(app, &info.label, WebviewUrl::External(blank_page()?))
        .title(&info.app_name)
        // The page gets a normal title bar; there is no Rulebox chrome around a site.
        .decorations(true)
        .resizable(true)
        .visible(false)
        .focused(true)
        .data_directory(data_dir)
        // Replaces the defaults on purpose: SmartScreen stays on for remote content.
        .additional_browser_args(&browser_args())
        .devtools(false)
        .zoom_hotkeys_enabled(false)
        .general_autofill_enabled(false)
        // The colour behind the bar's strip and the site before either has painted: the bar's
        // background, in the employee's theme. (The bar itself is added in `hooks::install`.)
        .background_color(bar_background(state))
        .on_navigation(move |url| gate_navigation(&nav_app, &nav_info, url))
        .on_new_window(move |url, _| {
            // A site never gets a window of its own: an allowed address opens here.
            if new_info.allow.allows_url(&url) {
                new_info.remember(&url);
                go_to(&new_app, &new_info.label, url);
            } else {
                show_blocked(&new_app, &new_info, &url);
            }
            NewWindowResponse::Deny
        })
        .on_download(move |_, event| handle_download(&download_state, &download_info, event));

    // The app's own icon in the title bar and on the Rulebox taskbar button, like an
    // installed PWA. No icon, or one that does not decode: the default icon, never an error.
    if let Some(icon) = icon_url.and_then(icon::window_icon) {
        let image = tauri::image::Image::new_owned(icon.pixels, icon.width, icon.height);
        builder = builder
            .icon(image)
            .map_err(|error| format!("icon of {}: {error}", info.label))?;
    }

    builder.build().map_err(|error| format!("create {}: {error}", info.label))
}

/// The bar's background for the person signed in (`auto` counts as light until the bar paints).
fn bar_background(state: &AppState) -> tauri::window::Color {
    let dark = state.read(|shell| shell.display.theme == crate::model::ThemeDto::Dark);
    let (r, g, b) = bar::surface_rgb(dark);
    tauri::window::Color(r, g, b, 255)
}

/// What every web window's browser is started with. Debug builds append
/// `RULEBOX_WEB_BROWSER_ARGS`, so a flag can be measured without a rebuild.
fn browser_args() -> String {
    let mut args = String::from("--disable-features=msWebOOUI,msPdfOOUI");
    if cfg!(debug_assertions) {
        if let Ok(extra) = std::env::var("RULEBOX_WEB_BROWSER_ARGS") {
            args.push(' ');
            args.push_str(extra.trim());
        }
    }
    args
}

/// The page every web window is built at, before its hooks exist.
fn blank_page() -> Result<Url, String> {
    Url::parse(blocked::BLANK).map_err(|error| error.to_string())
}

/// `true` lets the navigation go on. A refused address shows the blocked page instead.
fn gate_navigation(app: &AppHandle, info: &Arc<WebWindow>, url: &Url) -> bool {
    if blocked::is_blocked_page(url) || info.take_initial_blank(url) {
        return true;
    }
    if blocked::is_blank_page(url) {
        // Back stepped onto the window's own start page (or a page sent itself there). It is not
        // a site and shows nothing: stay where we are, and tell the bar Back is used up.
        if let Ok(mut nav) = info.nav.lock() {
            nav.blank_below();
        }
        return false;
    }
    if info.allow.allows_url(url) {
        info.remember(url);
        return true;
    }
    show_blocked(app, info, url);
    false
}

fn show_blocked(app: &AppHandle, info: &Arc<WebWindow>, refused: &Url) {
    let host = refused.host_str().unwrap_or("that site");
    let Some(page) = blocked::blocked_url(host, &info.last_allowed()) else {
        return;
    };
    go_to(app, &info.label, page);
}

/// Navigate a window from off the navigation callback (calling it from inside is not safe).
fn go_to(app: &AppHandle, label: &str, url: Url) {
    let app = app.clone();
    let label = label.to_string();
    std::thread::spawn(move || {
        if let Some(window) = app.get_webview_window(&label) {
            if let Err(error) = window.navigate(url) {
                tracing::warn!(%error, label, "navigation failed");
            }
        }
    });
}

fn handle_download(state: &AppState, info: &Arc<WebWindow>, event: DownloadEvent<'_>) -> bool {
    let files = state.files();
    let session = files.session();
    match event {
        DownloadEvent::Requested { destination, .. } => {
            let Some(session) = session else {
                return false;
            };
            let name = destination
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            let decision = download::decide_download(
                info.permissions.downloads,
                download::is_blocked_name(&name),
                session.quota_full(),
            );
            let refusal = match decision {
                DownloadDecision::Allow => None,
                DownloadDecision::NotAllowed => Some("Downloads are not allowed for this app."),
                DownloadDecision::BlockedType => Some("This type of file can't be saved on this PC."),
                DownloadDecision::QuotaFull => Some("Storage is full. Delete files to save new ones."),
            };
            if let Some(text) = refusal {
                // Only "this app may not download" is a permission refusal; a blocked file type or a
                // full folder is not, and is not part of the report.
                let kind = (decision == DownloadDecision::NotAllowed).then_some(permissions::DenialKind::Downloads);
                state.note_web_denial(&info.app_id, kind);
                state.notify(NoticeTone::Warning, text, Some(info.app_name.clone()));
                return false;
            }
            match download::destination(session.root(), &name) {
                Ok(path) => {
                    *destination = path;
                    true
                }
                Err(error) => {
                    tracing::warn!(%error, "no place for the download");
                    state.notify(NoticeTone::Warning, "The file could not be saved.", Some(info.app_name.clone()));
                    false
                }
            }
        }
        DownloadEvent::Finished { path, success, .. } => {
            let (Some(session), Some(path)) = (session, path) else {
                return true;
            };
            // This handler runs on the WebView2 thread. The content check and the
            // folder re-count read the disk, so they run on a worker instead and
            // the window never waits for them.
            let state = state.clone();
            let app_name = info.app_name.clone();
            tauri::async_runtime::spawn_blocking(move || {
                announce(&state, &app_name, download::finish(&session, &path, success));
            });
            true
        }
        _ => true,
    }
}

/// Tell the employee how a finished download ended.
fn announce(state: &AppState, app_name: &str, finished: download::Finished) {
    let app = Some(app_name.to_string());
    match finished {
        download::Finished::Saved { name } => state.notify(NoticeTone::Success, format!("Saved {name}"), app),
        download::Finished::RemovedUnsafe { name } => state.notify(
            NoticeTone::Warning,
            format!("{name} was removed."),
            Some("This type of file can't be kept on this PC.".into()),
        ),
        download::Finished::RemovedOverQuota { name } => state.notify(
            NoticeTone::Warning,
            format!("{name} was removed."),
            Some("Storage is full. Delete files to save new ones.".into()),
        ),
        download::Finished::Failed => state.notify(NoticeTone::Warning, "The download did not finish.", app),
        download::Finished::Misplaced => tracing::warn!("a download finished outside the employee's folder"),
    }
}

/// The WebView2 browser process behind a web window (for the developer resource monitor).
pub fn browser_pid(window: &WebviewWindow, done: impl FnOnce(u32) + Send + 'static) {
    hooks::browser_pid(window, done);
}

/// Stop a page nobody can see from painting and hold less memory for it (the
/// closed popup, a minimized built-in window). Its scripts keep running.
pub fn set_hidden(window: &WebviewWindow, hidden: bool) {
    hooks::set_hidden(window, hidden);
}

/// Ask for less memory for a page that is on screen but covered (the desktop
/// behind a maximized window).
pub fn set_low_memory(window: &WebviewWindow, low: bool) {
    hooks::set_low_memory(window, low);
}

pub fn focus(app: &AppHandle, label: &str) {
    focus_window(app, label);
}
