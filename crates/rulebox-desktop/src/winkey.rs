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
//! **The hook runs in a helper process**, the same exe started with
//! [`HELPER_SWITCH`]. Windows does not call a low-level keyboard hook whose
//! process owns the foreground window (seen on the VM: with a Rulebox window
//! in front the hook got no key at all, unless another program's hook sat
//! ahead of it in the chain). The shell owns the foreground most of the
//! time, so the hook lives in a windowless child that never does. The child
//! posts [`WM_WINKEY_START`] to the shell's message window and ends when the
//! shell process or that window is gone. The exe's `main` must call
//! [`helper_main`] before anything else.
//!
//! The decision logic is [`WinKeyState::step`], a pure function over key
//! events, tested with recorded sequences. Shell mode only (needs a `ShellToken`).

use std::cell::{Cell, RefCell};
use std::ffi::OsString;
use std::os::windows::process::CommandExt;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicU32, Ordering};
use std::sync::{mpsc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use windows::Win32::Foundation::{CloseHandle, HINSTANCE, HWND, LPARAM, LRESULT, WAIT_OBJECT_0, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::{
    GetCurrentThreadId, OpenProcess, WaitForSingleObject, CREATE_NO_WINDOW, PROCESS_SYNCHRONIZE,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LWIN, VK_RWIN};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, GetMessageW, IsWindow, PostMessageW, PostThreadMessageW, SetWindowsHookExW,
    UnhookWindowsHookEx, KBDLLHOOKSTRUCT, LLKHF_INJECTED, MSG, WH_KEYBOARD_LL, WM_APP, WM_KEYDOWN, WM_KEYUP,
    WM_QUIT, WM_SYSKEYDOWN, WM_SYSKEYUP,
};

use crate::error::{DesktopError, Result};
use crate::mode::ShellToken;

/// The one switch for the whole feature. When a security product objects,
/// turn this off: Start still opens by click.
pub const WINKEY_HOOK_ENABLED: bool = true;

/// Posted to the message window when the pattern is seen; the loop turns it
/// into the Start hotkey event.
pub const WM_WINKEY_START: u32 = WM_APP + 1;

/// The command-line switch that starts the exe as the hook helper:
/// `<exe> --rulebox-winkey-hook <message window> <shell process id>`.
pub const HELPER_SWITCH: &str = "--rulebox-winkey-hook";

/// A hook that takes longer than this in one call is on its way to being
/// removed by Windows (`LowLevelHooksTimeout`, about 300 ms).
const SLOW_CALL_MS: u128 = 150;

/// How often the helper looks at the shell and at its own health.
const HELPER_CHECK: Duration = Duration::from_secs(5);

/// The helper's exit codes. The shell restarts a helper that ended for any
/// reason but [`EXIT_TOO_SLOW`], a limited number of times.
const EXIT_DONE: i32 = 0;
const EXIT_BAD_ARGS: i32 = 2;
const EXIT_INSTALL_FAILED: i32 = 3;
const EXIT_TOO_SLOW: i32 = 4;

/// How many times the shell starts a helper again after it ended.
const MAX_RESTARTS: u32 = 3;

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

// ---- The hook itself (in the helper process) ---------------------------------

/// The state the callback uses. Only the hook's own thread touches it.
static STATE: Mutex<WinKeyState> = Mutex::new(WinKeyState {
    win_down: false,
    clean: false,
});
static TARGET: AtomicIsize = AtomicIsize::new(0);
static SLOW_CALLS: AtomicU32 = AtomicU32::new(0);
static INSTALLED: AtomicBool = AtomicBool::new(false);

/// The installed hook. It lives on a thread of its own that does nothing but
/// pump messages: Windows silently removes a low-level hook whose thread is
/// slow to answer. Dropping this stops that thread, which removes the hook.
struct Hook {
    thread_id: u32,
    thread: Option<JoinHandle<()>>,
}

impl Drop for Hook {
    fn drop(&mut self) {
        // SAFETY: posting WM_QUIT to a thread id is sound; a gone thread just fails.
        let _ = unsafe { PostThreadMessageW(self.thread_id, WM_QUIT, WPARAM(0), LPARAM(0)) };
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        INSTALLED.store(false, Ordering::SeqCst);
    }
}

/// The hook thread: install, pump messages until `WM_QUIT`, remove.
fn hook_thread(ready: mpsc::Sender<Result<u32>>) {
    // SAFETY: the callback has the required signature and stays valid for the life of the process.
    let installed = unsafe {
        GetModuleHandleW(None)
            .map_err(|e| DesktopError::win32("GetModuleHandleW", &e))
            .and_then(|module| {
                SetWindowsHookExW(WH_KEYBOARD_LL, Some(callback), Some(HINSTANCE(module.0)), 0)
                    .map_err(|e| DesktopError::win32("SetWindowsHookExW", &e))
            })
    };
    let handle = match installed {
        Ok(handle) => handle,
        Err(error) => {
            let _ = ready.send(Err(error));
            return;
        }
    };
    // SAFETY: plain query of the calling thread's id.
    if ready.send(Ok(unsafe { GetCurrentThreadId() })).is_err() {
        // `install_hook` gave up waiting: nobody owns this hook, so remove it.
        // SAFETY: the handle came from SetWindowsHookExW above and is removed once.
        let _ = unsafe { UnhookWindowsHookEx(handle) };
        INSTALLED.store(false, Ordering::SeqCst);
        return;
    }
    let mut message = MSG::default();
    // SAFETY: `message` is a valid out-parameter; GetMessageW returns 0 on WM_QUIT and -1 on error.
    while unsafe { GetMessageW(&mut message, None, 0, 0) }.0 > 0 {}
    // SAFETY: the handle came from SetWindowsHookExW above and is removed once.
    let _ = unsafe { UnhookWindowsHookEx(handle) };
}

/// Install the hook on its own thread, once. `hwnd` gets `WM_WINKEY_START`.
fn install_hook(hwnd: isize) -> Result<Hook> {
    if INSTALLED.swap(true, Ordering::SeqCst) {
        return Err(DesktopError::Refused("the Windows-key hook is already installed".into()));
    }
    TARGET.store(hwnd, Ordering::SeqCst);
    SLOW_CALLS.store(0, Ordering::SeqCst);
    if let Ok(mut state) = STATE.lock() {
        *state = WinKeyState::default();
    }
    let (ready, answer) = mpsc::channel();
    let thread = std::thread::Builder::new()
        .name("winkey-hook".into())
        .spawn(move || hook_thread(ready))
        .map_err(|e| {
            INSTALLED.store(false, Ordering::SeqCst);
            DesktopError::Message(format!("could not start the Windows-key hook thread: {e}"))
        })?;
    match answer.recv_timeout(Duration::from_secs(5)) {
        Ok(Ok(thread_id)) => Ok(Hook {
            thread_id,
            thread: Some(thread),
        }),
        Ok(Err(error)) => {
            let _ = thread.join();
            INSTALLED.store(false, Ordering::SeqCst);
            Err(error)
        }
        // INSTALLED stays set: the thread may still be on its way. When it finds
        // nobody listening it removes its own hook and clears the flag.
        Err(_) => Err(DesktopError::Message("the Windows-key hook thread did not answer".into())),
    }
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

/// Pure: the helper's arguments after the exe name, when they ask for the
/// helper. `Some(None)` is the switch with unusable arguments.
fn parse_helper_args(args: &[OsString]) -> Option<Option<(isize, u32)>> {
    if args.first()?.to_str() != Some(HELPER_SWITCH) {
        return None;
    }
    let number = |at: usize| args.get(at).and_then(|arg| arg.to_str());
    let hwnd = number(1).and_then(|text| text.parse::<isize>().ok()).filter(|hwnd| *hwnd != 0);
    let parent = number(2).and_then(|text| text.parse::<u32>().ok()).filter(|pid| *pid != 0);
    Some(hwnd.zip(parent))
}

/// Run as the hook helper when the command line asks for it; returns the exit
/// code then. `None`: this is a normal start, carry on.
pub fn helper_main(args: impl IntoIterator<Item = OsString>) -> Option<i32> {
    let args: Vec<OsString> = args.into_iter().skip(1).collect();
    let Some((hwnd, parent)) = parse_helper_args(&args)? else {
        return Some(EXIT_BAD_ARGS);
    };
    if !WINKEY_HOOK_ENABLED {
        return Some(EXIT_DONE);
    }
    // SAFETY: plain open of a process handle that is only waited on.
    let Ok(parent) = (unsafe { OpenProcess(PROCESS_SYNCHRONIZE, false, parent) }) else {
        return Some(EXIT_BAD_ARGS);
    };
    let code = run_helper(hwnd, |timeout| {
        // SAFETY: `parent` is a valid handle until it is closed below.
        unsafe { WaitForSingleObject(parent, timeout.as_millis() as u32) == WAIT_OBJECT_0 }
    });
    // SAFETY: the handle came from OpenProcess above and is closed once.
    let _ = unsafe { CloseHandle(parent) };
    Some(code)
}

/// The helper's life: hook installed, then every few seconds check the shell
/// is still there and the hook is healthy. `parent_gone` waits up to the
/// given time and says whether the shell process ended.
fn run_helper(hwnd: isize, parent_gone: impl Fn(Duration) -> bool) -> i32 {
    let Ok(mut hook) = install_hook(hwnd) else {
        return EXIT_INSTALL_FAILED;
    };
    let mut reinstalls = 0;
    let code = loop {
        if parent_gone(HELPER_CHECK) {
            break EXIT_DONE;
        }
        // SAFETY: IsWindow only checks a handle value.
        if !unsafe { IsWindow(Some(HWND(hwnd as *mut std::ffi::c_void))) }.as_bool() {
            break EXIT_DONE;
        }
        match health(SLOW_CALLS.load(Ordering::SeqCst), reinstalls) {
            Health::Fine => {}
            Health::Reinstall => {
                reinstalls += 1;
                drop(hook);
                match install_hook(hwnd) {
                    Ok(new) => hook = new,
                    Err(_) => return EXIT_INSTALL_FAILED,
                }
            }
            Health::GiveUp => break EXIT_TOO_SLOW,
        }
    };
    drop(hook);
    code
}

// ---- The shell's side: starting and watching the helper -----------------------

/// Whether a Windows key is held right now. Holding it can take the focus from
/// an open Start menu before the release toggles it; the shell asks this to
/// tell that focus loss from a click elsewhere. Reads those two keys only.
pub fn win_key_down() -> bool {
    // SAFETY: plain key-state queries.
    let held = |vk: u16| unsafe { GetAsyncKeyState(i32::from(vk)) } < 0;
    held(VK_LWIN.0) || held(VK_RWIN.0)
}

/// The running helper. Dropping it ends the helper (which removes the hook).
pub struct Helper {
    child: Child,
}

impl Drop for Helper {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Start the helper for the message window `hwnd`.
pub fn install(_token: &ShellToken, hwnd: isize) -> Result<Helper> {
    if !WINKEY_HOOK_ENABLED {
        return Err(DesktopError::Refused("the Windows-key hook is switched off".into()));
    }
    let exe = std::env::current_exe()
        .map_err(|e| DesktopError::Message(format!("could not find the app's own exe: {e}")))?;
    let child = Command::new(exe)
        .arg(HELPER_SWITCH)
        .arg(hwnd.to_string())
        .arg(std::process::id().to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW.0)
        .spawn()
        .map_err(|e| DesktopError::Message(format!("could not start the Windows-key helper: {e}")))?;
    Ok(Helper { child })
}

thread_local! {
    /// The helper belongs to the loop thread: started, checked and ended there.
    static HELPER: RefCell<Option<Helper>> = const { RefCell::new(None) };
    static RESTARTS: Cell<u32> = const { Cell::new(0) };
}

/// Start the helper and keep it on this (the loop) thread.
pub fn install_on_loop(token: &ShellToken, hwnd: isize) -> Result<()> {
    let helper = install(token, hwnd)?;
    HELPER.with(|slot| *slot.borrow_mut() = Some(helper));
    Ok(())
}

/// End the helper if it is running. Safe to call anywhere on the loop thread.
pub fn remove_on_loop() {
    HELPER.with(|slot| drop(slot.borrow_mut().take()));
}

/// Pure: start a helper again after it ended with `code`?
fn restart_after(code: Option<i32>, restarts_done: u32) -> bool {
    code != Some(EXIT_TOO_SLOW) && restarts_done < MAX_RESTARTS
}

/// Look at the helper and start it again when it ended (a few times, then
/// give up). Called from the loop every few seconds.
pub fn tick(token: &ShellToken, hwnd: isize) {
    let ended = HELPER.with(|slot| {
        let mut slot = slot.borrow_mut();
        let status = slot.as_mut()?.child.try_wait().ok().flatten()?;
        slot.take();
        Some(status.code())
    });
    let Some(code) = ended else {
        return;
    };
    let restarts = RESTARTS.with(Cell::get);
    if !restart_after(code, restarts) {
        tracing::warn!(?code, "the Windows-key helper ended and stays off; Start opens by click");
        return;
    }
    RESTARTS.with(|count| count.set(restarts + 1));
    match install_on_loop(token, hwnd) {
        Ok(()) => tracing::warn!(?code, "the Windows-key helper ended and was started again"),
        Err(error) => tracing::warn!(%error, "the Windows-key helper could not be started again"),
    }
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

    #[test]
    fn a_helper_is_restarted_a_few_times_but_not_after_giving_up() {
        assert!(restart_after(Some(EXIT_INSTALL_FAILED), 0));
        assert!(restart_after(None, 2), "killed from outside");
        assert!(!restart_after(Some(EXIT_DONE), MAX_RESTARTS));
        assert!(!restart_after(Some(EXIT_TOO_SLOW), 0), "a slow hook stays off");
    }

    #[test]
    fn only_the_switch_starts_the_helper() {
        let args = |list: &[&str]| list.iter().map(OsString::from).collect::<Vec<_>>();
        assert_eq!(parse_helper_args(&args(&[])), None);
        assert_eq!(parse_helper_args(&args(&["--other", "1", "2"])), None);
        assert_eq!(parse_helper_args(&args(&[HELPER_SWITCH, "4242", "77"])), Some(Some((4242, 77))));
        assert_eq!(parse_helper_args(&args(&[HELPER_SWITCH, "x", "77"])), Some(None));
        assert_eq!(parse_helper_args(&args(&[HELPER_SWITCH, "0", "77"])), Some(None));
        assert_eq!(parse_helper_args(&args(&[HELPER_SWITCH, "4242"])), Some(None));
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
        // The guard is checked on the flag, without touching the real hook.
        INSTALLED.store(true, Ordering::SeqCst);
        assert!(install_hook(1).is_err());
        INSTALLED.store(false, Ordering::SeqCst);
    }
}
