//! A viewer's fullscreen video must cover the taskbar.
//!
//! The taskbar is its own always-on-top window, and WebView2 does not make the
//! app window fullscreen when a `<video>` element does. So while a viewer window
//! is fullscreen, its page asks (`viewer_fullscreen`) for two things: the window
//! itself covers the monitor, and the taskbar window is hidden. Both are undone
//! on every way out, so the taskbar can never stay hidden:
//!
//! - the page leaves fullscreen (Esc, button) or unmounts: it says so;
//! - the window is closed or destroyed: a window event restores it;
//! - the window loses focus (Alt+Tab, a popup): the taskbar comes back for as
//!   long as it is not in front, and goes away again on return;
//! - the page stops answering (renderer crash): the page repeats its request
//!   every couple of seconds, and a watcher restores the taskbar when the
//!   repeats stop.
//!
//! The decisions are a small pure state machine ([`Cover`]); the Tauri parts
//! only carry them out.

use std::collections::HashSet;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, Window, WindowEvent};

use crate::shellwin::TASKBAR;

/// The page repeats its request this often while fullscreen.
pub const BEAT_EVERY: Duration = Duration::from_secs(2);
/// No request for this long: the page is gone, give the taskbar back.
pub const BEAT_TIMEOUT: Duration = Duration::from_secs(7);

/// What to do to the screen after one event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    None,
    /// Hide the taskbar; make this window cover the monitor.
    Cover { label: String },
    /// Show the taskbar. `leave_fullscreen`: the window also stops covering the monitor.
    Uncover { label: String, leave_fullscreen: bool },
}

/// Which window wants the cover, and whether the taskbar is hidden right now.
#[derive(Debug, Default)]
pub struct Cover {
    /// The window that asked, and when it last said so.
    wanted: Option<(String, Instant)>,
    hidden: bool,
}

impl Cover {
    pub fn is_idle(&self) -> bool {
        self.wanted.is_none() && !self.hidden
    }

    /// The page asked to start (`on`) or stop covering. Asking again is a heartbeat.
    pub fn request(&mut self, label: &str, on: bool, now: Instant) -> Action {
        if on {
            self.wanted = Some((label.to_string(), now));
            if self.hidden {
                return Action::None;
            }
            self.hidden = true;
            return Action::Cover { label: label.to_string() };
        }
        if self.owner() != Some(label) {
            return Action::None;
        }
        self.wanted = None;
        self.release(label, true)
    }

    /// The window gained or lost the focus.
    pub fn focus_changed(&mut self, label: &str, focused: bool) -> Action {
        if self.owner() != Some(label) {
            return Action::None;
        }
        if focused && !self.hidden {
            self.hidden = true;
            return Action::Cover { label: label.to_string() };
        }
        if !focused {
            // Still wanted: it covers again when the focus returns.
            return self.release(label, false);
        }
        Action::None
    }

    /// The window is gone.
    pub fn destroyed(&mut self, label: &str) -> Action {
        if self.owner() != Some(label) {
            return Action::None;
        }
        self.wanted = None;
        self.release(label, false)
    }

    /// Called about once a second while something is covered.
    pub fn tick(&mut self, now: Instant) -> Action {
        let Some((label, last)) = self.wanted.clone() else {
            return Action::None;
        };
        if now.saturating_duration_since(last) < BEAT_TIMEOUT {
            return Action::None;
        }
        self.wanted = None;
        self.release(&label, true)
    }

    fn owner(&self) -> Option<&str> {
        self.wanted.as_ref().map(|(label, _)| label.as_str())
    }

    fn release(&mut self, label: &str, leave_fullscreen: bool) -> Action {
        // Leaving fullscreen is always carried out (showing a visible taskbar is a no-op).
        if !self.hidden && !leave_fullscreen {
            return Action::None;
        }
        self.hidden = false;
        Action::Uncover { label: label.to_string(), leave_fullscreen }
    }
}

static COVER: Mutex<Option<Cover>> = Mutex::new(None);
static WATCHED: Mutex<Option<HashSet<String>>> = Mutex::new(None);
static WATCHER_RUNNING: Mutex<bool> = Mutex::new(false);

fn with_cover<T>(work: impl FnOnce(&mut Cover) -> T) -> T {
    let mut guard = COVER.lock().unwrap_or_else(|e| e.into_inner());
    work(guard.get_or_insert_with(Cover::default))
}

/// Carry an action out. Failures are logged: a viewer must never break because of this.
fn apply(app: &AppHandle, action: Action) {
    match action {
        Action::None => {}
        Action::Cover { label } => {
            if let Some(taskbar) = app.get_webview_window(TASKBAR) {
                if let Err(error) = taskbar.hide() {
                    tracing::warn!(%error, "hiding the taskbar for fullscreen video failed");
                }
            }
            if let Some(window) = app.get_webview_window(&label) {
                if let Err(error) = window.set_fullscreen(true) {
                    tracing::warn!(%error, "making the viewer window fullscreen failed");
                }
            }
        }
        Action::Uncover { label, leave_fullscreen } => {
            if leave_fullscreen {
                if let Some(window) = app.get_webview_window(&label) {
                    if let Err(error) = window.set_fullscreen(false) {
                        tracing::warn!(%error, "leaving fullscreen failed");
                    }
                }
            }
            if let Some(taskbar) = app.get_webview_window(TASKBAR) {
                if let Err(error) = taskbar.show() {
                    tracing::warn!(%error, "showing the taskbar after fullscreen video failed");
                }
            }
        }
    }
}

/// Restores the taskbar when the repeats stop (a crashed or hung page).
fn ensure_watcher(app: &AppHandle) {
    {
        let mut running = WATCHER_RUNNING.lock().unwrap_or_else(|e| e.into_inner());
        if *running {
            return;
        }
        *running = true;
    }
    let app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(1));
        let (action, idle) = with_cover(|cover| {
            let action = cover.tick(Instant::now());
            (action, cover.is_idle())
        });
        apply(&app, action);
        if idle {
            let mut running = WATCHER_RUNNING.lock().unwrap_or_else(|e| e.into_inner());
            // Re-check under the lock: a request may have arrived since.
            if with_cover(|cover| cover.is_idle()) {
                *running = false;
                return;
            }
        }
    });
}

/// Once per window: its destruction and focus changes feed the state machine.
fn watch_window(window: &Window) {
    let label = window.label().to_string();
    {
        let mut watched = WATCHED.lock().unwrap_or_else(|e| e.into_inner());
        if !watched.get_or_insert_with(HashSet::new).insert(label.clone()) {
            return;
        }
    }
    let app = window.app_handle().clone();
    window.on_window_event(move |event| {
        let action = match event {
            WindowEvent::Destroyed => {
                if let Ok(mut watched) = WATCHED.lock() {
                    if let Some(set) = watched.as_mut() {
                        set.remove(&label);
                    }
                }
                with_cover(|cover| cover.destroyed(&label))
            }
            WindowEvent::Focused(focused) => with_cover(|cover| cover.focus_changed(&label, *focused)),
            _ => Action::None,
        };
        apply(&app, action);
    });
}

/// A viewer window's video went fullscreen (`on`) or left it. The page repeats
/// `on: true` every [`BEAT_EVERY`] while it stays fullscreen.
#[tauri::command]
pub async fn viewer_fullscreen(window: Window, on: bool) -> Result<(), String> {
    // Built-in app windows only; a web app's page never gets this command.
    if !window.label().starts_with("app-") {
        return Err("not allowed".into());
    }
    if on {
        watch_window(&window);
    }
    let action = with_cover(|cover| cover.request(window.label(), on, Instant::now()));
    let app = window.app_handle().clone();
    if on {
        ensure_watcher(&app);
    }
    apply(&app, action);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cover(label: &str) -> Action {
        Action::Cover { label: label.into() }
    }

    fn uncover(label: &str, leave_fullscreen: bool) -> Action {
        Action::Uncover { label: label.into(), leave_fullscreen }
    }

    #[test]
    fn going_fullscreen_hides_the_taskbar_once_and_leaving_restores_it() {
        let mut state = Cover::default();
        let t0 = Instant::now();
        assert!(state.is_idle());
        assert_eq!(state.request("app-1", true, t0), cover("app-1"));
        // The page repeats its request: nothing more to do.
        assert_eq!(state.request("app-1", true, t0 + BEAT_EVERY), Action::None);
        assert!(!state.is_idle());
        assert_eq!(state.request("app-1", false, t0 + BEAT_EVERY * 2), uncover("app-1", true));
        assert!(state.is_idle());
        // Leaving twice does nothing.
        assert_eq!(state.request("app-1", false, t0), Action::None);
    }

    #[test]
    fn another_window_cannot_end_the_cover() {
        let mut state = Cover::default();
        let t0 = Instant::now();
        state.request("app-1", true, t0);
        assert_eq!(state.request("app-2", false, t0), Action::None);
        assert_eq!(state.destroyed("app-2"), Action::None);
        assert_eq!(state.focus_changed("app-2", false), Action::None);
        assert!(!state.is_idle());
    }

    #[test]
    fn closing_the_window_restores_the_taskbar() {
        let mut state = Cover::default();
        state.request("app-1", true, Instant::now());
        assert_eq!(state.destroyed("app-1"), uncover("app-1", false));
        assert!(state.is_idle());
        assert_eq!(state.destroyed("app-1"), Action::None);
    }

    #[test]
    fn losing_the_focus_gives_the_taskbar_back_and_returning_hides_it_again() {
        let mut state = Cover::default();
        state.request("app-1", true, Instant::now());
        assert_eq!(state.focus_changed("app-1", false), uncover("app-1", false));
        // Still fullscreen, so it is not idle and the watcher keeps running.
        assert!(!state.is_idle());
        assert_eq!(state.focus_changed("app-1", false), Action::None);
        assert_eq!(state.focus_changed("app-1", true), cover("app-1"));
        assert_eq!(state.focus_changed("app-1", true), Action::None);
    }

    #[test]
    fn a_page_that_stops_repeating_loses_the_cover() {
        let mut state = Cover::default();
        let t0 = Instant::now();
        state.request("app-1", true, t0);
        assert_eq!(state.tick(t0 + BEAT_EVERY), Action::None);
        // A heartbeat resets the clock.
        state.request("app-1", true, t0 + BEAT_EVERY * 3);
        assert_eq!(state.tick(t0 + BEAT_EVERY * 3 + BEAT_TIMEOUT - Duration::from_millis(1)), Action::None);
        assert_eq!(state.tick(t0 + BEAT_EVERY * 3 + BEAT_TIMEOUT), uncover("app-1", true));
        assert!(state.is_idle());
        assert_eq!(state.tick(t0 + Duration::from_secs(60)), Action::None);
    }

    #[test]
    fn a_timeout_while_unfocused_still_ends_the_request() {
        let mut state = Cover::default();
        let t0 = Instant::now();
        state.request("app-1", true, t0);
        state.focus_changed("app-1", false);
        // The taskbar is already back; the window still leaves fullscreen.
        assert_eq!(state.tick(t0 + BEAT_TIMEOUT), uncover("app-1", true));
        assert!(state.is_idle());
        assert_eq!(state.focus_changed("app-1", true), Action::None);
    }

    #[test]
    fn the_beat_is_well_inside_the_timeout() {
        assert!(BEAT_EVERY * 3 < BEAT_TIMEOUT + BEAT_EVERY);
        assert!(BEAT_EVERY < BEAT_TIMEOUT);
    }
}
