//! Web app windows (plan Step 15, PRD 6.2, 5.3, 24.1).
//!
//! A web app is an ordinary site in its own native window. It gets no Tauri
//! IPC at all (no capability matches `web-*`), only addresses on its
//! allow-list, no prompts, and a browser profile of its own per employee.

pub mod allow;
pub mod blocked;
pub mod download;
mod hooks;
pub mod permissions;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use rulebox_desktop::placement::scale_px;
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri::webview::{DownloadEvent, NewWindowResponse};

use self::allow::AllowList;
use self::download::DownloadDecision;
use crate::appwin::{area_for, cascade_rect, focus_window, place};
use crate::model::{AppEntry, AppKind, NoticeTone, SessionState, WebApp, WebPermissions};
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
}

#[derive(Default)]
struct Inner {
    next: u32,
    windows: HashMap<String, Arc<WebWindow>>,
}

/// The web windows that are open.
#[derive(Default)]
pub struct WebApps {
    inner: Mutex<Inner>,
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

    fn forget(&self, label: &str) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.windows.remove(label);
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
        });

        let window = build_window(app, state, &info, start, data_dir, web)?;
        if let Ok(mut inner) = self.inner.lock() {
            inner.windows.insert(label.clone(), Arc::clone(&info));
        }
        self.watch(&window, &label);
        hooks::install(
            &window,
            Arc::new(hooks::HookContext {
                window: Arc::clone(&info),
                state: state.clone(),
            }),
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
    fn watch(self: &Arc<Self>, window: &WebviewWindow, label: &str) {
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
                }
            }
            _ => {}
        });
    }
}

fn build_window(
    app: &AppHandle,
    state: &AppState,
    info: &Arc<WebWindow>,
    start: Url,
    data_dir: PathBuf,
    web: &WebApp,
) -> Result<WebviewWindow, String> {
    let nav_app = app.clone();
    let nav_info = Arc::clone(info);
    let new_app = app.clone();
    let new_info = Arc::clone(info);
    let download_info = Arc::clone(info);
    let download_state = state.clone();
    let _ = web;

    WebviewWindowBuilder::new(app, &info.label, WebviewUrl::External(start))
        .title(&info.app_name)
        // The page gets a normal title bar; there is no Rulebox chrome around a site.
        .decorations(true)
        .resizable(true)
        .visible(false)
        .focused(true)
        .data_directory(data_dir)
        // Replaces the defaults on purpose: SmartScreen stays on for remote content.
        .additional_browser_args("--disable-features=msWebOOUI,msPdfOOUI")
        .devtools(false)
        .zoom_hotkeys_enabled(false)
        .general_autofill_enabled(false)
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
        .on_download(move |_, event| handle_download(&download_state, &download_info, event))
        .build()
        .map_err(|error| format!("create {}: {error}", info.label))
}

/// `true` lets the navigation go on. A refused address shows the blocked page instead.
fn gate_navigation(app: &AppHandle, info: &Arc<WebWindow>, url: &Url) -> bool {
    if blocked::is_blocked_page(url) {
        return true;
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
                state.note_web_denial(&info.app_id);
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
            match download::finish(&session, &path, success) {
                download::Finished::Saved { name } => {
                    state.notify(NoticeTone::Success, format!("Saved {name}"), Some(info.app_name.clone()))
                }
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
                download::Finished::Failed => {
                    state.notify(NoticeTone::Warning, "The download did not finish.", Some(info.app_name.clone()))
                }
                download::Finished::Misplaced => tracing::warn!("a download finished outside the employee's folder"),
            }
            true
        }
        _ => true,
    }
}

pub fn focus(app: &AppHandle, label: &str) {
    focus_window(app, label);
}
