//! Web apps opened in Chrome or Edge (Phase 6 Step 18, plan 4.9, PRD 7.3).
//!
//! The administrator may choose a browser for a web app (`web.browser`). The agent writes that browser's policies and says
//! `browserReady` once they are in place; this module decides, when the employee clicks the tile, whether the app opens in the
//! browser or in the built-in window, builds the one fixed command line, maps the browser's windows back to their apps and counts
//! them for the window cap.
//!
//! * **Pure rules first.** [`choose`], [`launch_args`], [`match_browser_app`] and the cap helpers take plain data, so every rule is
//!   tested without a browser. [`open`] is the thin glue that starts the process.
//! * **Built-in window instead of the browser** in Lite mode, below 8 GB RAM (unless the administrator forced the display mode on
//!   purpose, S-4), when the agent has not marked the policies ready, and when the program is missing or is not the expected
//!   `chrome.exe` / `msedge.exe` (plan 4.9.1).
//! * **The command line is Rulebox's own**: `--app=<https start address> --user-data-dir=<profile> --no-first-run
//!   --no-default-browser-check --disk-cache-size=52428800`. Nothing else, no `--kiosk` (plan 4.9.2). The address passes through
//!   the URL parser, so spaces and quotes are percent-encoded and what is left is one argument.
//! * **Windows are told apart by their AppUserModelID** (plan 4.9.5, S-3): Chromium gives every `--app` window
//!   `<Chrome|MSEdge>.<host>_<path>.<profile folder>.Default`. Windows with no id (Edge's "Translate page" bubble) are never mapped
//!   to a web app.
//! * The browser profile is `%LOCALAPPDATA%\dev.rulebox.staff\browser\<chrome|edge>\<employee>`: never the built-in WebView2
//!   folder (`...\web\<employee>`). The agent deletes old ones (`apps/agent/src/browser_profiles.rs`).

use std::path::{Path, PathBuf};
use std::sync::Arc;

use rulebox_policy::catalog::BrowserKind;
use tauri::AppHandle;
use url::Url;

use crate::model::{AppEntry, AppKind, SessionState, TaskItem, WebApp};
use crate::state::AppState;
use crate::tasks::TaskServices;
use crate::webapp::allow::AllowList;

/// Browser mode needs at least this much physical memory (megabytes) unless the administrator forced the display mode. An 8 GB PC
/// reports about 7.3 to 7.9 GB (shared graphics memory), so the line sits below that (S-4: a first window costs 305 MB in Chrome,
/// 397 MB in Edge, over the 350 MB budget of Section 14).
pub const MIN_RAM_MB: u64 = 7168;
/// The browser's disk cache, in bytes (plan 4.9.2).
const DISK_CACHE_BYTES: u64 = 52_428_800;
/// The longest start address handed to a browser.
const MAX_ADDRESS_CHARS: usize = 2048;
/// Prefix of the label a browser window carries in the "close one first" dialog (followed by the window's task id).
pub const BROWSER_LABEL_PREFIX: &str = "browser-";

/// The two browsers a web app can open in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Browser {
    Chrome,
    Edge,
}

impl Browser {
    /// The browser an administrator's choice means; `Builtin` and anything unknown mean none.
    pub fn of_kind(kind: BrowserKind) -> Option<Self> {
        match kind.effective() {
            BrowserKind::Chrome => Some(Self::Chrome),
            BrowserKind::Edge => Some(Self::Edge),
            BrowserKind::Builtin | BrowserKind::Unknown => None,
        }
    }

    /// The program file name (compared without regard to case).
    pub fn exe_name(self) -> &'static str {
        match self {
            Self::Chrome => "chrome.exe",
            Self::Edge => "msedge.exe",
        }
    }

    /// The folder of this browser's profiles.
    pub fn folder(self) -> &'static str {
        match self {
            Self::Chrome => "chrome",
            Self::Edge => "edge",
        }
    }

    /// The first part of the AppUserModelID of its `--app` windows.
    fn aumid_prefix(self) -> &'static str {
        match self {
            Self::Chrome => "Chrome",
            Self::Edge => "MSEdge",
        }
    }

    /// The browser a program file belongs to.
    pub fn of_exe(exe: &Path) -> Option<Self> {
        let name = exe.file_name()?.to_string_lossy();
        [Self::Chrome, Self::Edge].into_iter().find(|browser| name.eq_ignore_ascii_case(browser.exe_name()))
    }
}

/// What the choice depends on besides the app itself.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Facts {
    /// Lite display mode (the agent's effective mode).
    pub lite: bool,
    /// Physical memory in megabytes; `None` when it could not be read (treated as too little).
    pub ram_mb: Option<u64>,
    /// The administrator forced the display mode for the group or the PC (`displayModeSource` is `group` or `device`): the
    /// RAM line does not apply (plan 4.9.1 "unless the group opted in").
    pub display_forced: bool,
}

/// Why a browser web app opens in the built-in window.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fallback {
    /// The app is a built-in web app.
    NotChosen,
    /// Lite mode.
    Lite,
    /// Less than 8 GB RAM and no forced display mode.
    LowRam,
    /// The agent has not journalled the browser's policies yet.
    NotReady,
    /// The program is missing or no path was given.
    NoProgram,
    /// The path is not an absolute path to the expected `chrome.exe` / `msedge.exe`.
    BadProgram,
}

/// Where a web app opens.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Choice {
    Browser { browser: Browser, exe: PathBuf },
    Builtin(Fallback),
}

/// Pure: the browser for this app now, or the reason for the built-in window. `exe_exists` answers whether a file is there.
pub fn choose(web: &WebApp, facts: &Facts, exe_exists: &dyn Fn(&Path) -> bool) -> Choice {
    let Some(browser) = Browser::of_kind(web.browser.kind) else {
        return Choice::Builtin(Fallback::NotChosen);
    };
    if facts.lite {
        return Choice::Builtin(Fallback::Lite);
    }
    if !facts.display_forced && facts.ram_mb.is_none_or(|ram| ram < MIN_RAM_MB) {
        return Choice::Builtin(Fallback::LowRam);
    }
    if !web.browser.ready {
        return Choice::Builtin(Fallback::NotReady);
    }
    let Some(exe) = web.browser.exe.as_deref().map(str::trim).filter(|exe| !exe.is_empty()) else {
        return Choice::Builtin(Fallback::NoProgram);
    };
    let exe = PathBuf::from(exe);
    // The agent is trusted, but the Staff App starts nothing it has not checked itself: an absolute path to the one program
    // of the chosen browser.
    if !exe.is_absolute() || Browser::of_exe(&exe) != Some(browser) {
        return Choice::Builtin(Fallback::BadProgram);
    }
    if !exe_exists(&exe) {
        return Choice::Builtin(Fallback::NoProgram);
    }
    Choice::Browser { browser, exe }
}

/// Why no command line could be made.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum ArgError {
    #[error("the start address is not an https address")]
    BadAddress,
    #[error("the start address is too long")]
    TooLong,
    #[error("the profile folder is not usable")]
    BadProfile,
}

/// The start address as one safe argument value: `https` only with a host, no login in it, no more than 2,048 characters and
/// nothing a command line could misread. The URL parser has already turned spaces, quotes and angle brackets of the path, query
/// and fragment into `%xx`; anything that still looks like whitespace or a control or quote character is refused.
/// A `--` inside the address is harmless: the address is the value of `--app=`, never an argument of its own.
pub fn safe_address(start_url: &str) -> Result<String, ArgError> {
    // The same rule as the built-in window: https with a host.
    AllowList::new(start_url, &[]).map_err(|_| ArgError::BadAddress)?;
    let url = Url::parse(start_url.trim()).map_err(|_| ArgError::BadAddress)?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err(ArgError::BadAddress);
    }
    let text = url.as_str();
    if text.chars().any(|c| c.is_whitespace() || c.is_control() || c == '"') {
        return Err(ArgError::BadAddress);
    }
    if text.chars().count() > MAX_ADDRESS_CHARS {
        return Err(ArgError::TooLong);
    }
    Ok(text.to_string())
}

/// Pure: the one command line of plan 4.9.2. The profile must be an absolute path without quotes, control characters or a
/// trailing backslash (that would escape the closing quote).
pub fn launch_args(start_url: &str, profile: &Path) -> Result<Vec<String>, ArgError> {
    let address = safe_address(start_url)?;
    let profile_text = profile.to_string_lossy();
    if !profile.is_absolute()
        || profile_text.chars().any(|c| c.is_control() || c == '"')
        || profile_text.ends_with(['\\', '/'])
    {
        return Err(ArgError::BadProfile);
    }
    Ok(vec![
        format!("--app={address}"),
        format!("--user-data-dir={profile_text}"),
        "--no-first-run".to_string(),
        "--no-default-browser-check".to_string(),
        format!("--disk-cache-size={DISK_CACHE_BYTES}"),
    ])
}

/// `<local app data>\dev.rulebox.staff\browser\<chrome|edge>\<employee folder>`: one profile per employee and browser, so one
/// person's web apps in a browser share its process and single sign-on, and nobody else's cookies.
pub fn profile_path(local_app_data: &Path, browser: Browser, employee_id: &str) -> PathBuf {
    local_app_data
        .join("dev.rulebox.staff")
        .join("browser")
        .join(browser.folder())
        .join(crate::webapp::employee_folder(employee_id))
}

/// The AppUserModelID Chromium gives the `--app` window of `start_url` (S-3): `<Chrome|MSEdge>.<host>_<path>.<profile folder>.Default`.
/// `None` when the address has no host.
pub fn app_aumid(browser: Browser, start_url: &str, employee_folder: &str) -> Option<String> {
    let url = Url::parse(start_url.trim()).ok()?;
    let host = url.host_str()?;
    Some(format!("{}.{host}_{}.{employee_folder}.Default", browser.aumid_prefix(), url.path()))
}

/// Pure: the catalogue web app a browser window belongs to, by its AppUserModelID. A window with no id, a program that is not
/// `chrome.exe` / `msedge.exe`, or an id no browser web app of that browser produces, belongs to no web app.
pub fn match_browser_app(
    aumid: Option<&str>,
    exe: Option<&Path>,
    catalogue: &[AppEntry],
    employee_folder: &str,
) -> Option<String> {
    let aumid = aumid.filter(|id| !id.is_empty())?;
    let browser = Browser::of_exe(exe?)?;
    catalogue.iter().find_map(|app| {
        let AppKind::Web(web) = &app.kind else { return None };
        if Browser::of_kind(web.browser.kind) != Some(browser) {
            return None;
        }
        let expected = app_aumid(browser, &web.url, employee_folder)?;
        expected.eq_ignore_ascii_case(aumid).then(|| app.id.clone())
    })
}

/// The windows that are web apps open in a browser: not our own windows (`own` is false) and listed under a web app.
fn browser_windows<'a>(catalogue: &'a [AppEntry], tasks: &'a [TaskItem]) -> impl Iterator<Item = (&'a TaskItem, &'a AppEntry)> {
    tasks.iter().filter(|task| !task.own).filter_map(move |task| {
        let app_id = task.app_id.as_deref()?;
        let entry = catalogue.iter().find(|app| app.id == app_id)?;
        matches!(entry.kind, AppKind::Web(_)).then_some((task, entry))
    })
}

/// How many browser windows of web apps are open (they count toward the window cap, plan 4.14).
pub fn browser_window_count(catalogue: &[AppEntry], tasks: &[TaskItem]) -> usize {
    browser_windows(catalogue, tasks).count()
}

/// One browser window in the "close one first" dialog: `(label, app name)`; the label is `browser-<task id>`.
pub fn cap_windows(catalogue: &[AppEntry], tasks: &[TaskItem]) -> Vec<(String, String)> {
    browser_windows(catalogue, tasks).map(|(task, entry)| (format!("{BROWSER_LABEL_PREFIX}{}", task.id), entry.name.clone())).collect()
}

/// The task id inside a dialog label, when the label names a browser window that is open now.
pub fn browser_task_of_label<'a>(label: &'a str, catalogue: &[AppEntry], tasks: &[TaskItem]) -> Option<&'a str> {
    let id = label.strip_prefix(BROWSER_LABEL_PREFIX)?;
    browser_windows(catalogue, tasks).any(|(task, _)| task.id == id).then_some(id)
}

/// What [`open`] did.
#[derive(Debug, PartialEq, Eq)]
pub enum Opened {
    /// The browser was started (its window appears by itself and the tracker maps it).
    Started(u32),
    /// Open the built-in window instead.
    Builtin,
    /// Nothing opened; the text is for the notice.
    Failed(String),
}

/// The facts of this PC now: the display mode, the memory, whether the display mode was forced by an administrator.
pub fn system_facts(state: &AppState) -> Facts {
    Facts {
        lite: state.read(|shell| shell.display.lite),
        ram_mb: rulebox_desktop::procstats::memory().map(|(total, _)| total / (1024 * 1024)),
        display_forced: state.display_forced(),
    }
}

/// Start `entry` in its browser when the rules say so. Blocks on a process start: call it from a worker thread.
pub fn open(_app: &AppHandle, services: &TaskServices, state: &AppState, entry: &AppEntry) -> Opened {
    let AppKind::Web(web) = &entry.kind else {
        return Opened::Builtin;
    };
    let facts = system_facts(state);
    let (browser, exe) = match choose(web, &facts, &|path| path.is_file()) {
        Choice::Browser { browser, exe } => (browser, exe),
        Choice::Builtin(reason) => {
            if reason != Fallback::NotChosen {
                tracing::info!(app = %entry.id, ?reason, "a browser web app opens in the built-in window");
            }
            return Opened::Builtin;
        }
    };
    let employee_id = state.read(|shell| match &shell.session {
        SessionState::SignedIn { employee, locked: false, .. } => Some(employee.id.clone()),
        _ => None,
    });
    let Some(employee_id) = employee_id else {
        return Opened::Failed("nobody is signed in".into());
    };
    let Some(local) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) else {
        return Opened::Failed("LOCALAPPDATA is not set".into());
    };
    let profile = profile_path(&local, browser, &employee_id);
    let args = match launch_args(&web.url, &profile) {
        Ok(args) => args,
        Err(error) => {
            // The built-in window refuses the same address with its own message.
            tracing::warn!(app = %entry.id, %error, "no browser command line; using the built-in window");
            return Opened::Builtin;
        }
    };
    if let Err(error) = std::fs::create_dir_all(&profile) {
        tracing::warn!(app = %entry.id, %error, "the browser profile folder could not be made; using the built-in window");
        return Opened::Builtin;
    }
    match services.launcher.start_browser(&entry.id, &exe, &args) {
        Ok(pid) => {
            tracing::info!(app = %entry.id, pid, browser = browser.folder(), "web app opened in the browser");
            Opened::Started(pid)
        }
        Err(error) => {
            // A browser that cannot start (a rule of the PC, a broken install) must not leave the tile dead.
            tracing::warn!(app = %entry.id, %error, "the browser did not start; using the built-in window");
            Opened::Builtin
        }
    }
}

/// Open a web app now (the window cap was checked): in its browser when the rules say so, else the built-in window.
pub fn open_now(
    app: &AppHandle,
    services: &TaskServices,
    state: &AppState,
    web: &Arc<crate::webapp::WebApps>,
    entry: &AppEntry,
) -> Result<(), String> {
    match open(app, services, state, entry) {
        Opened::Started(_) => Ok(()),
        Opened::Failed(error) => Err(error),
        Opened::Builtin => web.open(app, state, entry).map(|_| ()),
    }
}

/// Closing a browser window for the cap: `true` when Windows no longer has it. Polls for a short time: a page that asks "leave
/// this site?" keeps its window.
pub fn wait_gone(hwnd: isize) -> bool {
    for _ in 0..30 {
        if !rulebox_desktop::control::is_open(hwnd) {
            return true;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    !rulebox_desktop::control::is_open(hwnd)
}
