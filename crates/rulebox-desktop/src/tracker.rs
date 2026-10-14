//! Window tracking: the shell hook plus a handful of WinEvent hooks feed one
//! [`WindowEvent`] stream (plan Step 7).
//!
//! Everything here runs on the message loop thread: the shell hook arrives
//! as a message to the hidden window, and out-of-context WinEvent callbacks
//! are delivered through that thread's message queue. State therefore lives
//! in a thread-local and needs no locking.
//!
//! The thread-local is never borrowed while a Win32 call is made; a callback
//! that arrives re-entrantly is dropped instead of panicking.

use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use windows::core::w;
use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
use windows::Win32::UI::Accessibility::{HWINEVENTHOOK, SetWinEventHook, UnhookWinEvent};
use windows::Win32::UI::WindowsAndMessaging::{
    DeregisterShellHookWindow, GetForegroundWindow, RegisterShellHookWindow,
    RegisterWindowMessageW, EVENT_OBJECT_CLOAKED, EVENT_OBJECT_HIDE, EVENT_OBJECT_NAMECHANGE,
    EVENT_OBJECT_SHOW, EVENT_OBJECT_UNCLOAKED, EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_MINIMIZEEND,
    EVENT_SYSTEM_MINIMIZESTART, OBJID_WINDOW, WINEVENT_OUTOFCONTEXT,
};

use crate::error::{DesktopError, Result};
use crate::msgloop::{emit_from_loop_thread, DesktopEvent, LoopCtx};
use crate::windows::{self as win, WindowInfo, WindowLight};

/// `REDRAW` fires for every title change; the icon is only re-read this often.
const ICON_REFRESH_MIN_GAP: Duration = Duration::from_secs(2);

#[derive(Clone, Debug)]
pub enum WindowEvent {
    Added(WindowInfo),
    Removed(isize),
    Changed(WindowInfo),
    Activated(Option<isize>),
    Flash(isize, bool),
    /// The window's icon may have changed; fetch it again.
    IconChanged(isize),
}

// ---------------------------------------------------------------------------
// Pure part: the set of known windows and the events a change produces.
// ---------------------------------------------------------------------------

/// What the tracker has told the rest of the app so far.
#[derive(Default)]
pub(crate) struct Known {
    windows: HashMap<isize, WindowInfo>,
    active: Option<isize>,
    flashing: HashMap<isize, bool>,
}

impl Known {
    pub(crate) fn contains(&self, hwnd: isize) -> bool {
        self.windows.contains_key(&hwnd)
    }

    /// `info` is the window's state now: `Some` when it is a task window,
    /// `None` when it is gone or no longer qualifies.
    pub(crate) fn reconcile(
        &mut self,
        hwnd: isize,
        info: Option<WindowInfo>,
        out: &mut Vec<WindowEvent>,
    ) {
        match (self.windows.get(&hwnd), info) {
            (None, Some(info)) => {
                self.windows.insert(hwnd, info.clone());
                out.push(WindowEvent::Added(info));
            }
            (Some(old), Some(info)) => {
                if *old != info {
                    self.windows.insert(hwnd, info.clone());
                    out.push(WindowEvent::Changed(info));
                }
            }
            (Some(_), None) => self.remove(hwnd, out),
            (None, None) => {}
        }
    }

    pub(crate) fn remove(&mut self, hwnd: isize, out: &mut Vec<WindowEvent>) {
        if self.windows.remove(&hwnd).is_none() {
            return;
        }
        self.flashing.remove(&hwnd);
        out.push(WindowEvent::Removed(hwnd));
        if self.active == Some(hwnd) {
            self.active = None;
            out.push(WindowEvent::Activated(None));
        }
    }

    /// Apply a cheap title / minimized / cloaked refresh to a known window.
    pub(crate) fn refresh_light(
        &mut self,
        hwnd: isize,
        light: WindowLight,
        out: &mut Vec<WindowEvent>,
    ) {
        let Some(info) = self.windows.get_mut(&hwnd) else {
            return;
        };
        if info.title == light.title
            && info.minimized == light.minimized
            && info.cloaked == light.cloaked
        {
            return;
        }
        info.title = light.title;
        info.minimized = light.minimized;
        info.cloaked = light.cloaked;
        out.push(WindowEvent::Changed(info.clone()));
    }

    pub(crate) fn activate(&mut self, hwnd: Option<isize>, out: &mut Vec<WindowEvent>) {
        let hwnd = hwnd.filter(|&h| h != 0);
        if self.active == hwnd {
            return;
        }
        self.active = hwnd;
        out.push(WindowEvent::Activated(hwnd));
        // Activating a window answers its flashing.
        if let Some(h) = hwnd {
            if self.flashing.remove(&h) == Some(true) {
                out.push(WindowEvent::Flash(h, false));
            }
        }
    }

    pub(crate) fn flash(&mut self, hwnd: isize, on: bool, out: &mut Vec<WindowEvent>) {
        if !self.windows.contains_key(&hwnd) {
            return;
        }
        let was = self.flashing.get(&hwnd).copied().unwrap_or(false);
        if was == on {
            return;
        }
        if on {
            self.flashing.insert(hwnd, true);
        } else {
            self.flashing.remove(&hwnd);
        }
        out.push(WindowEvent::Flash(hwnd, on));
    }

    /// A full re-enumeration: add what appeared, remove what is gone, update
    /// what differs.
    pub(crate) fn resync(&mut self, current: Vec<WindowInfo>, out: &mut Vec<WindowEvent>) {
        let live: Vec<isize> = current.iter().map(|info| info.hwnd).collect();
        let gone: Vec<isize> = self
            .windows
            .keys()
            .copied()
            .filter(|hwnd| !live.contains(hwnd))
            .collect();
        for hwnd in gone {
            self.remove(hwnd, out);
        }
        for info in current {
            self.reconcile(info.hwnd, Some(info), out);
        }
    }
}

/// The shell hook's `wParam` codes (winuser.h) the tracker acts on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ShellHookKind {
    Created,
    Destroyed,
    Activated,
    Redraw,
    Flash,
    Replaced,
    Replacing,
}

pub(crate) fn shell_hook_kind(code: usize) -> Option<ShellHookKind> {
    // HSHELL_HIGHBIT = 0x8000.
    match code {
        1 => Some(ShellHookKind::Created),
        2 => Some(ShellHookKind::Destroyed),
        // WINDOWACTIVATED, and RUDEAPPACTIVATED (= WINDOWACTIVATED | HIGHBIT).
        4 | 0x8004 => Some(ShellHookKind::Activated),
        6 => Some(ShellHookKind::Redraw),
        // FLASH = REDRAW | HIGHBIT.
        0x8006 => Some(ShellHookKind::Flash),
        13 => Some(ShellHookKind::Replaced),
        14 => Some(ShellHookKind::Replacing),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Win32 part.
// ---------------------------------------------------------------------------

struct Active {
    hwnd: HWND,
    shell_message: u32,
    known: Known,
    hooks: Vec<HWINEVENTHOOK>,
    last_icon_refresh: HashMap<isize, Instant>,
}

thread_local! {
    static ACTIVE: RefCell<Option<Active>> = const { RefCell::new(None) };
}

static SHELL_MESSAGE: OnceLock<u32> = OnceLock::new();

/// The registered message id of `"SHELLHOOK"`.
fn shell_message() -> u32 {
    *SHELL_MESSAGE.get_or_init(|| {
        // SAFETY: registering a message name has no preconditions.
        unsafe { RegisterWindowMessageW(w!("SHELLHOOK")) }
    })
}

/// Run `f` on the tracker state unless it is already borrowed (a re-entrant
/// callback) or the tracker is not running.
fn with_active<R>(f: impl FnOnce(&mut Active) -> R) -> Option<R> {
    ACTIVE.with(|cell| {
        let mut guard = cell.try_borrow_mut().ok()?;
        guard.as_mut().map(f)
    })
}

fn publish(events: Vec<WindowEvent>) {
    for event in events {
        emit_from_loop_thread(DesktopEvent::Window(event));
    }
}

/// Start tracking. Must run on the message loop thread (`MsgLoop::run`).
/// Emits `Added` for every window that exists now, then follows changes.
pub fn start(ctx: &LoopCtx) -> Result<()> {
    if with_active(|_| ()).is_some() {
        return Ok(());
    }
    let hwnd = HWND(ctx.hwnd as *mut std::ffi::c_void);
    let shell_message = shell_message();

    // SAFETY: `hwnd` is the loop's own window, alive for the whole thread.
    if !unsafe { RegisterShellHookWindow(hwnd) }.as_bool() {
        return Err(DesktopError::Message(
            "RegisterShellHookWindow failed".to_string(),
        ));
    }

    let ranges: [(u32, u32); 5] = [
        (EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND),
        (EVENT_SYSTEM_MINIMIZESTART, EVENT_SYSTEM_MINIMIZEEND),
        (EVENT_OBJECT_SHOW, EVENT_OBJECT_HIDE),
        (EVENT_OBJECT_CLOAKED, EVENT_OBJECT_UNCLOAKED),
        (EVENT_OBJECT_NAMECHANGE, EVENT_OBJECT_NAMECHANGE),
    ];
    let mut hooks = Vec::with_capacity(ranges.len());
    for (min, max) in ranges {
        // SAFETY: out-of-context hook; the callback is a plain function that
        // only touches this thread's state.
        let hook = unsafe {
            SetWinEventHook(min, max, None, Some(win_event_proc), 0, 0, WINEVENT_OUTOFCONTEXT)
        };
        if hook.0.is_null() {
            tracing::warn!(min, max, "SetWinEventHook failed");
        } else {
            hooks.push(hook);
        }
    }

    let mut known = Known::default();
    let mut events = Vec::new();
    known.resync(win::enumerate(), &mut events);
    // SAFETY: handle query only.
    let foreground = unsafe { GetForegroundWindow() };
    if !foreground.0.is_null() {
        let target = win::root_owner(foreground.0 as isize);
        known.activate(Some(target), &mut events);
    }

    ACTIVE.with(|cell| {
        *cell.borrow_mut() = Some(Active {
            hwnd,
            shell_message,
            known,
            hooks,
            last_icon_refresh: HashMap::new(),
        });
    });
    publish(events);
    Ok(())
}

/// Unhook everything. Call on the loop thread before it ends.
pub fn stop() {
    let taken = ACTIVE.with(|cell| cell.try_borrow_mut().ok().and_then(|mut slot| slot.take()));
    let Some(active) = taken else { return };
    for hook in active.hooks {
        // SAFETY: the hook came from SetWinEventHook on this thread.
        let _ = unsafe { UnhookWinEvent(hook) };
    }
    // SAFETY: the window was registered in `start` and is still alive.
    let _ = unsafe { DeregisterShellHookWindow(active.hwnd) };
}

/// Re-enumerate and emit the difference. Run it on the loop thread after a
/// display change or a resume from sleep.
pub fn resync() {
    let current = win::enumerate();
    let events = with_active(|active| {
        let mut events = Vec::new();
        active.known.resync(current, &mut events);
        events
    });
    publish(events.unwrap_or_default());
}

/// Called by the window procedure for every registered-range message.
/// Returns `true` when it was the shell hook message.
pub(crate) fn handle_message(msg: u32, wparam: WPARAM, lparam: LPARAM) -> bool {
    let is_shell = with_active(|active| active.shell_message == msg).unwrap_or(false);
    if !is_shell {
        return false;
    }
    let Some(kind) = shell_hook_kind(wparam.0) else {
        return true;
    };
    let hwnd = lparam.0;
    match kind {
        ShellHookKind::Created | ShellHookKind::Replacing => reconcile_full(hwnd),
        ShellHookKind::Destroyed | ShellHookKind::Replaced => {
            let events = with_active(|active| {
                let mut events = Vec::new();
                active.known.remove(hwnd, &mut events);
                active.last_icon_refresh.remove(&hwnd);
                events
            });
            publish(events.unwrap_or_default());
        }
        ShellHookKind::Activated => activate(hwnd),
        ShellHookKind::Redraw => {
            reconcile_full(hwnd);
            icon_changed(hwnd);
            let events = with_active(|active| {
                let mut events = Vec::new();
                active.known.flash(hwnd, false, &mut events);
                events
            });
            publish(events.unwrap_or_default());
        }
        ShellHookKind::Flash => {
            let events = with_active(|active| {
                let mut events = Vec::new();
                active.known.flash(hwnd, true, &mut events);
                events
            });
            publish(events.unwrap_or_default());
        }
    }
    true
}

fn reconcile_full(hwnd: isize) {
    if hwnd == 0 {
        return;
    }
    // Read the window outside the borrow: these calls can pump COM.
    let info = if win::is_top_level(hwnd) {
        win::window_info(hwnd)
    } else {
        None
    };
    let events = with_active(|active| {
        let mut events = Vec::new();
        active.known.reconcile(hwnd, info, &mut events);
        events
    });
    publish(events.unwrap_or_default());
}

fn activate(hwnd: isize) {
    let target = if hwnd == 0 {
        None
    } else {
        Some(win::root_owner(hwnd))
    };
    let events = with_active(|active| {
        let mut events = Vec::new();
        active.known.activate(target, &mut events);
        events
    });
    publish(events.unwrap_or_default());
}

fn icon_changed(hwnd: isize) {
    let due = with_active(|active| {
        if !active.known.contains(hwnd) {
            return false;
        }
        let now = Instant::now();
        match active.last_icon_refresh.get(&hwnd) {
            Some(at) if now.duration_since(*at) < ICON_REFRESH_MIN_GAP => false,
            _ => {
                active.last_icon_refresh.insert(hwnd, now);
                true
            }
        }
    })
    .unwrap_or(false);
    if due {
        publish(vec![WindowEvent::IconChanged(hwnd)]);
    }
}

fn refresh_light(hwnd: isize) {
    if !with_active(|active| active.known.contains(hwnd)).unwrap_or(false) {
        return;
    }
    let Some(light) = win::read_light(hwnd) else {
        return;
    };
    let events = with_active(|active| {
        let mut events = Vec::new();
        active.known.refresh_light(hwnd, light, &mut events);
        events
    });
    publish(events.unwrap_or_default());
}

unsafe extern "system" fn win_event_proc(
    _hook: HWINEVENTHOOK,
    event: u32,
    hwnd: HWND,
    id_object: i32,
    id_child: i32,
    _thread: u32,
    _time: u32,
) {
    // Only the window object itself, never its children or accessibles.
    if hwnd.0.is_null() || id_object != OBJID_WINDOW.0 || id_child != 0 {
        return;
    }
    let handle = hwnd.0 as isize;
    // Nothing may unwind into Windows.
    let result = std::panic::catch_unwind(|| match event {
        EVENT_SYSTEM_FOREGROUND => activate(handle),
        EVENT_SYSTEM_MINIMIZESTART | EVENT_SYSTEM_MINIMIZEEND | EVENT_OBJECT_NAMECHANGE => {
            refresh_light(handle);
        }
        EVENT_OBJECT_SHOW | EVENT_OBJECT_HIDE | EVENT_OBJECT_CLOAKED | EVENT_OBJECT_UNCLOAKED => {
            reconcile_full(handle);
        }
        _ => {}
    });
    if result.is_err() {
        tracing::error!(event, "a window event callback panicked");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(hwnd: isize, title: &str) -> WindowInfo {
        WindowInfo {
            hwnd,
            pid: 100 + hwnd as u32,
            title: title.into(),
            exe: None,
            aumid: None,
            minimized: false,
            cloaked: false,
            class: "Test".into(),
        }
    }

    fn light(title: &str, minimized: bool) -> WindowLight {
        WindowLight {
            title: title.into(),
            minimized,
            cloaked: false,
        }
    }

    #[test]
    fn a_new_window_is_added_once() {
        let mut known = Known::default();
        let mut out = Vec::new();
        known.reconcile(1, Some(info(1, "a")), &mut out);
        known.reconcile(1, Some(info(1, "a")), &mut out);
        assert_eq!(out.len(), 1);
        assert!(matches!(out[0], WindowEvent::Added(_)));
    }

    #[test]
    fn a_changed_window_is_reported_and_an_unchanged_one_is_not() {
        let mut known = Known::default();
        let mut out = Vec::new();
        known.reconcile(1, Some(info(1, "a")), &mut out);
        out.clear();
        known.reconcile(1, Some(info(1, "b")), &mut out);
        assert!(matches!(out.as_slice(), [WindowEvent::Changed(i)] if i.title == "b"));
        out.clear();
        known.reconcile(1, Some(info(1, "b")), &mut out);
        assert!(out.is_empty());
    }

    #[test]
    fn a_window_that_stops_qualifying_is_removed() {
        let mut known = Known::default();
        let mut out = Vec::new();
        known.reconcile(1, Some(info(1, "a")), &mut out);
        out.clear();
        known.reconcile(1, None, &mut out);
        assert!(matches!(out.as_slice(), [WindowEvent::Removed(1)]));
        assert!(!known.contains(1));
    }

    #[test]
    fn removing_the_active_window_clears_the_active_one() {
        let mut known = Known::default();
        let mut out = Vec::new();
        known.reconcile(1, Some(info(1, "a")), &mut out);
        known.activate(Some(1), &mut out);
        out.clear();
        known.remove(1, &mut out);
        assert!(matches!(
            out.as_slice(),
            [WindowEvent::Removed(1), WindowEvent::Activated(None)]
        ));
    }

    #[test]
    fn light_refresh_only_reports_real_changes() {
        let mut known = Known::default();
        let mut out = Vec::new();
        known.reconcile(1, Some(info(1, "a")), &mut out);
        out.clear();
        known.refresh_light(1, light("a", false), &mut out);
        assert!(out.is_empty());
        known.refresh_light(1, light("a", true), &mut out);
        assert!(matches!(out.as_slice(), [WindowEvent::Changed(i)] if i.minimized));
        out.clear();
        // Unknown windows are ignored.
        known.refresh_light(9, light("x", false), &mut out);
        assert!(out.is_empty());
    }

    #[test]
    fn activation_is_reported_on_change_only() {
        let mut known = Known::default();
        let mut out = Vec::new();
        known.activate(Some(5), &mut out);
        known.activate(Some(5), &mut out);
        assert_eq!(out.len(), 1);
        known.activate(None, &mut out);
        assert!(matches!(out.last(), Some(WindowEvent::Activated(None))));
    }

    #[test]
    fn flashing_stops_when_the_window_is_activated() {
        let mut known = Known::default();
        let mut out = Vec::new();
        known.reconcile(1, Some(info(1, "a")), &mut out);
        known.flash(1, true, &mut out);
        known.flash(1, true, &mut out); // repeated flash: no second event
        out.clear();
        known.activate(Some(1), &mut out);
        assert!(matches!(
            out.as_slice(),
            [WindowEvent::Activated(Some(1)), WindowEvent::Flash(1, false)]
        ));
    }

    #[test]
    fn flash_of_an_unknown_window_is_ignored() {
        let mut known = Known::default();
        let mut out = Vec::new();
        known.flash(7, true, &mut out);
        assert!(out.is_empty());
    }

    #[test]
    fn resync_adds_removes_and_updates() {
        let mut known = Known::default();
        let mut out = Vec::new();
        known.resync(vec![info(1, "a"), info(2, "b")], &mut out);
        assert_eq!(out.len(), 2);
        out.clear();
        known.resync(vec![info(2, "b2"), info(3, "c")], &mut out);
        let removed = out
            .iter()
            .filter(|e| matches!(e, WindowEvent::Removed(1)))
            .count();
        let changed = out
            .iter()
            .filter(|e| matches!(e, WindowEvent::Changed(i) if i.hwnd == 2))
            .count();
        let added = out
            .iter()
            .filter(|e| matches!(e, WindowEvent::Added(i) if i.hwnd == 3))
            .count();
        assert_eq!((removed, changed, added), (1, 1, 1));
    }

    #[test]
    fn shell_hook_codes_map_to_kinds() {
        assert_eq!(shell_hook_kind(1), Some(ShellHookKind::Created));
        assert_eq!(shell_hook_kind(2), Some(ShellHookKind::Destroyed));
        assert_eq!(shell_hook_kind(4), Some(ShellHookKind::Activated));
        assert_eq!(shell_hook_kind(0x8004), Some(ShellHookKind::Activated));
        assert_eq!(shell_hook_kind(6), Some(ShellHookKind::Redraw));
        assert_eq!(shell_hook_kind(0x8006), Some(ShellHookKind::Flash));
        assert_eq!(shell_hook_kind(3), None);
        assert_eq!(shell_hook_kind(7), None);
    }
}
