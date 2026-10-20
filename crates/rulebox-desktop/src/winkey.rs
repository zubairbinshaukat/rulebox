//! The Windows key alone opens Start (plan Step 16, P7). The only keyboard
//! hook in the app, and a deliberately small one.
//!
//! * It acts on one pattern: a Windows key press and release with **no other
//!   key event in between**. Injected events and auto-repeats are ignored.
//! * It never handles a combination: when anything else happens while the
//!   Windows key is down, it stands aside (Win+R, Win+E, Win+L... are not its
//!   business).
//! * It reads no key content. The state is two flags; there is no buffer of
//!   key codes or characters, nothing is written anywhere, nothing is logged
//!   from the callback.
//! * It never swallows an event. The plan also wanted the release swallowed
//!   "so nothing else reacts"; but a release that never arrives leaves the
//!   Windows key logically down for the whole system (every later key would
//!   behave as Win+key). With no Explorer in a shell-mode session nothing else
//!   reacts to a lone Windows key anyway, so every event is passed on.
//! * The callback does flag updates and one `PostMessageW`, nothing else.
//!
//! The decision logic is [`WinKeyState::step`], a pure function over key
//! events, tested with recorded sequences. Shell mode only (needs a `ShellToken`).

use std::cell::RefCell;
use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::Instant;

use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Input::KeyboardAndMouse::{VK_LWIN, VK_RWIN};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, PostMessageW, SetWindowsHookExW, UnhookWindowsHookEx, HHOOK, KBDLLHOOKSTRUCT, LLKHF_INJECTED,
    WH_KEYBOARD_LL, WM_APP, WM_KEYDOWN, WM_KEYUP, WM_SYSKEYDOWN, WM_SYSKEYUP,
};

use crate::error::{DesktopError, Result};
use crate::mode::ShellToken;

/// The one switch for the whole feature. When a security product objects,
/// turn this off: Start still opens by click and Ctrl+Esc.
pub const WINKEY_HOOK_ENABLED: bool = true;

/// Posted to the message window when the pattern is seen; the loop turns it
/// into the Start hotkey event.
pub const WM_WINKEY_START: u32 = WM_APP + 1;

/// A hook that takes longer than this in one call is on its way to being
/// removed by Windows (`LowLevelHooksTimeout`, about 300 ms).
const SLOW_CALL_MS: u128 = 150;

/// One key event, reduced to what the pattern needs. No key content.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct KeyInput {
    pub vk: u32,
    pub up: bool,
    pub injected: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    Nothing,
    /// Toggle the Start menu.
    ToggleStart,
}

/// Two flags and nothing else: no key code, no character, no timestamp buffer.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct WinKeyState {
    win_down: bool,
    /// No other key event since the Windows key went down.
    clean: bool,
}

fn is_win(vk: u32) -> bool {
    vk == u32::from(VK_LWIN.0) || vk == u32::from(VK_RWIN.0)
}

impl WinKeyState {
    pub fn step(&mut self, key: KeyInput) -> Action {
        // Events other programs injected are never ours to act on, and never
        // count as "another key": they cannot spoil or fake the pattern.
        if key.injected {
            return Action::Nothing;
        }
        if is_win(key.vk) {
            if !key.up {
                // A repeat of the held key changes nothing.
                if !self.win_down {
                    self.win_down = true;
                    self.clean = true;
                }
                return Action::Nothing;
            }
            let toggle = self.win_down && self.clean;
            self.win_down = false;
            self.clean = false;
            return if toggle { Action::ToggleStart } else { Action::Nothing };
        }
        // Any other key, down or up, while the Windows key is held: a combination.
        if self.win_down {
            self.clean = false;
        }
        Action::Nothing
    }
}

// ---- The hook itself --------------------------------------------------------

/// The state the callback uses. Only the hook's own thread touches it.
static STATE: Mutex<WinKeyState> = Mutex::new(WinKeyState {
    win_down: false,
    clean: false,
});
static TARGET: AtomicIsize = AtomicIsize::new(0);
static SLOW_CALLS: AtomicU32 = AtomicU32::new(0);
static INSTALLED: AtomicBool = AtomicBool::new(false);

/// The installed hook. Dropping it removes the hook; do that on the thread that installed it.
pub struct Hook {
    handle: HHOOK,
}

impl Drop for Hook {
    fn drop(&mut self) {
        // SAFETY: the handle came from SetWindowsHookExW and is removed once.
        let _ = unsafe { UnhookWindowsHookEx(self.handle) };
        INSTALLED.store(false, Ordering::SeqCst);
    }
}

/// Install the hook. Call on the message-loop thread (the hook needs its
/// message loop), once. `hwnd` is the loop's window, which gets `WM_WINKEY_START`.
pub fn install(_token: &ShellToken, hwnd: isize) -> Result<Hook> {
    if !WINKEY_HOOK_ENABLED {
        return Err(DesktopError::Refused("the Windows-key hook is switched off".into()));
    }
    if INSTALLED.swap(true, Ordering::SeqCst) {
        return Err(DesktopError::Refused("the Windows-key hook is already installed".into()));
    }
    TARGET.store(hwnd, Ordering::SeqCst);
    SLOW_CALLS.store(0, Ordering::SeqCst);
    if let Ok(mut state) = STATE.lock() {
        *state = WinKeyState::default();
    }
    // SAFETY: the callback has the required signature and stays valid for the life of the process.
    let handle = unsafe {
        let module = GetModuleHandleW(None).map_err(|e| DesktopError::win32("GetModuleHandleW", &e))?;
        SetWindowsHookExW(WH_KEYBOARD_LL, Some(callback), Some(HINSTANCE(module.0)), 0)
    };
    match handle {
        Ok(handle) => Ok(Hook { handle }),
        Err(error) => {
            INSTALLED.store(false, Ordering::SeqCst);
            Err(DesktopError::win32("SetWindowsHookExW", &error))
        }
    }
}

/// How many calls were slow since the hook was installed. The loop reads this
/// and reinstalls once, then gives up, when Windows is about to drop the hook.
pub fn slow_calls() -> u32 {
    SLOW_CALLS.load(Ordering::SeqCst)
}

unsafe extern "system" fn callback(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    // HC_ACTION is 0; anything else must be passed on untouched.
    if code == 0 {
        let started = Instant::now();
        let message = wparam.0 as u32;
        let is_key = matches!(message, WM_KEYDOWN | WM_KEYUP | WM_SYSKEYDOWN | WM_SYSKEYUP);
        if is_key && lparam.0 != 0 {
            // SAFETY: for WH_KEYBOARD_LL, lparam points to a KBDLLHOOKSTRUCT.
            let info = unsafe { &*(lparam.0 as *const KBDLLHOOKSTRUCT) };
            let key = KeyInput {
                vk: info.vkCode,
                up: matches!(message, WM_KEYUP | WM_SYSKEYUP),
                injected: info.flags.0 & LLKHF_INJECTED.0 != 0,
            };
            // `try_lock`: never wait for anything inside the hook.
            let action = match STATE.try_lock() {
                Ok(mut state) => state.step(key),
                Err(_) => Action::Nothing,
            };
            if action == Action::ToggleStart {
                let target = TARGET.load(Ordering::SeqCst);
                if target != 0 {
                    // SAFETY: posting to a window handle is always sound; a dead handle fails.
                    let _ = unsafe {
                        PostMessageW(
                            Some(HWND(target as *mut std::ffi::c_void)),
                            WM_WINKEY_START,
                            WPARAM(0),
                            LPARAM(0),
                        )
                    };
                }
            }
        }
        if started.elapsed().as_millis() > SLOW_CALL_MS {
            SLOW_CALLS.fetch_add(1, Ordering::SeqCst);
        }
    }
    // Every event goes on to the next hook and the program that gets it.
    // SAFETY: forwarding the arguments we were given.
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}


// ---- Keeping the hook on the loop thread, and its health ----------------------

thread_local! {
    /// The hook belongs to the loop thread: it is installed, checked and removed there.
    static HOOK: RefCell<Option<Hook>> = const { RefCell::new(None) };
}

static REINSTALLS: AtomicU32 = AtomicU32::new(0);

/// What to do about a hook that has been slow.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Health {
    Fine,
    /// Reinstall it, once.
    Reinstall,
    /// It was slow again after a reinstall: leave it off.
    GiveUp,
}

/// Pure: slow calls seen since the last install, and reinstalls done so far.
pub fn health(slow_calls: u32, reinstalls_done: u32) -> Health {
    match (slow_calls, reinstalls_done) {
        (0, _) => Health::Fine,
        (_, 0) => Health::Reinstall,
        _ => Health::GiveUp,
    }
}

/// Install and keep the hook on this (the loop) thread.
pub fn install_on_loop(token: &ShellToken, hwnd: isize) -> Result<()> {
    let hook = install(token, hwnd)?;
    HOOK.with(|slot| *slot.borrow_mut() = Some(hook));
    Ok(())
}

/// Remove the hook if it is installed. Safe to call anywhere on the loop thread.
pub fn remove_on_loop() {
    HOOK.with(|slot| drop(slot.borrow_mut().take()));
}

/// Look at the hook's health and act on it (reinstall once, then give up).
/// Called from the loop every few seconds. Returns what it found.
pub fn tick(token: &ShellToken, hwnd: isize) -> Health {
    let installed = HOOK.with(|slot| slot.borrow().is_some());
    if !installed {
        return Health::Fine;
    }
    let verdict = health(slow_calls(), REINSTALLS.load(Ordering::SeqCst));
    match verdict {
        Health::Fine => {}
        Health::Reinstall => {
            REINSTALLS.fetch_add(1, Ordering::SeqCst);
            remove_on_loop();
            if let Err(error) = install_on_loop(token, hwnd) {
                tracing::warn!(%error, "the Windows-key hook could not be reinstalled");
            } else {
                tracing::warn!("the Windows-key hook was slow and has been reinstalled once");
            }
        }
        Health::GiveUp => {
            remove_on_loop();
            tracing::warn!("the Windows-key hook was slow again and is now off; Start opens by click and Ctrl+Esc");
        }
    }
    verdict
}

#[cfg(test)]
mod health_tests {
    use super::*;

    #[test]
    fn a_hook_timeout_reinstalls_once_then_gives_up() {
        assert_eq!(health(0, 0), Health::Fine);
        assert_eq!(health(0, 1), Health::Fine);
        assert_eq!(health(1, 0), Health::Reinstall);
        assert_eq!(health(5, 0), Health::Reinstall);
        assert_eq!(health(1, 1), Health::GiveUp);
        assert_eq!(health(3, 7), Health::GiveUp);
    }
}
#[cfg(test)]
mod tests {
    use super::*;

    const LWIN: u32 = 0x5B;
    const RWIN: u32 = 0x5C;
    const R: u32 = 0x52;
    const E: u32 = 0x45;
    const CTRL: u32 = 0xA2;

    fn down(vk: u32) -> KeyInput {
        KeyInput { vk, up: false, injected: false }
    }

    fn up(vk: u32) -> KeyInput {
        KeyInput { vk, up: true, injected: false }
    }

    /// Run a recorded sequence; the actions it produced, in order.
    fn run(sequence: &[KeyInput]) -> Vec<Action> {
        let mut state = WinKeyState::default();
        sequence.iter().map(|key| state.step(*key)).collect()
    }

    fn toggles(sequence: &[KeyInput]) -> usize {
        run(sequence).iter().filter(|a| **a == Action::ToggleStart).count()
    }

    #[test]
    fn a_lone_windows_key_press_toggles_start_on_release() {
        assert_eq!(run(&[down(LWIN), up(LWIN)]), vec![Action::Nothing, Action::ToggleStart]);
        assert_eq!(toggles(&[down(RWIN), up(RWIN)]), 1, "the right key too");
    }

    #[test]
    fn a_combination_is_never_handled() {
        // Win+R, Win+E, Win+L...: nothing happens on the Windows key's release.
        assert_eq!(toggles(&[down(LWIN), down(R), up(R), up(LWIN)]), 0);
        assert_eq!(toggles(&[down(LWIN), down(E), up(LWIN), up(E)]), 0);
        // Another key's release in between also spoils the pattern.
        assert_eq!(toggles(&[down(LWIN), up(CTRL), up(LWIN)]), 0);
    }

    #[test]
    fn key_repeats_of_the_windows_key_do_not_matter() {
        assert_eq!(toggles(&[down(LWIN), down(LWIN), down(LWIN), up(LWIN)]), 1);
    }

    #[test]
    fn injected_events_are_ignored_and_cannot_spoil_the_pattern() {
        let injected = |vk, up| KeyInput { vk, up, injected: true };
        assert_eq!(toggles(&[injected(LWIN, false), injected(LWIN, true)]), 0, "a program cannot fake a press");
        assert_eq!(toggles(&[down(LWIN), injected(R, false), injected(R, true), up(LWIN)]), 1);
    }

    #[test]
    fn two_quick_taps_are_two_toggles() {
        assert_eq!(toggles(&[down(LWIN), up(LWIN), down(LWIN), up(LWIN)]), 2);
    }

    #[test]
    fn the_state_is_reset_by_each_release() {
        // After a combination, the next lone press works again.
        assert_eq!(toggles(&[down(LWIN), down(R), up(LWIN), down(LWIN), up(LWIN)]), 1);
        // A release with no press seen (the key went down before we were installed) does nothing.
        assert_eq!(toggles(&[up(LWIN)]), 0);
        // Ordinary typing never toggles anything.
        assert_eq!(toggles(&[down(R), up(R), down(E), up(E)]), 0);
    }

    #[test]
    fn the_state_holds_two_flags_and_no_key_content() {
        // A pin on the privacy rule: the whole state is two booleans.
        assert_eq!(std::mem::size_of::<WinKeyState>(), 2);
        let mut state = WinKeyState::default();
        for vk in [R, E, CTRL, 0x41, 0x30] {
            state.step(down(vk));
            state.step(up(vk));
        }
        assert_eq!(state, WinKeyState::default(), "typing leaves no trace");
    }

    #[test]
    fn the_hook_cannot_be_installed_twice() {
        // `install` needs a ShellToken (shell mode only), so the guard is checked on the flag.
        INSTALLED.store(true, Ordering::SeqCst);
        assert!(INSTALLED.swap(true, Ordering::SeqCst));
        INSTALLED.store(false, Ordering::SeqCst);
    }
}
