//! Control of other programs' windows: bring to the front, minimize,
//! restore, close, end the program of a frozen window (plan Step 8).
//!
//! Every call that talks to another program's window uses a timeout or
//! `SMTO_ABORTIFHUNG`, so a frozen program can never freeze the shell.
//! Call these from a worker thread, not from the message loop.

use std::ffi::c_void;
use std::mem::size_of;
use std::time::Duration;

use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, WPARAM};
use windows::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP,
    VK_MENU,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetForegroundWindow, GetLastActivePopup, GetWindowLongPtrW, IsHungAppWindow, IsIconic,
    IsWindow, PostMessageW, SendMessageTimeoutW, SetForegroundWindow, SwitchToThisWindow, GWL_STYLE,
    SC_CLOSE, SC_MINIMIZE, SC_RESTORE, SMTO_ABORTIFHUNG, WM_SYSCOMMAND, WS_MINIMIZEBOX,
};

use crate::error::{DesktopError, Result};
use crate::windows::root_owner;

/// How long a program gets to answer a system command.
const COMMAND_TIMEOUT_MS: u32 = 200;
/// After each activation attempt: how long to wait for the foreground to move.
const SETTLE: Duration = Duration::from_millis(40);

/// Which step of the activation ladder made the window the foreground
/// window. Logged, so a real-shell run shows which one is needed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ActivationRung {
    /// Plain `SetForegroundWindow` (after restoring, when minimized).
    Direct,
    /// A synthetic Alt tap first, which lifts the foreground lock.
    AltTap,
    /// `SwitchToThisWindow`.
    SwitchTo,
}

fn hwnd_from(raw: isize) -> HWND {
    HWND(raw as *mut c_void)
}

/// Has the program stopped answering messages for about five seconds?
/// Read-only; cheap enough to call for each visible task every few seconds.
pub fn is_hung(hwnd: isize) -> bool {
    // SAFETY: a handle query; a stale handle answers `false`.
    unsafe { IsHungAppWindow(hwnd_from(hwnd)) }.as_bool()
}

/// Does Windows still have this window? A stale handle answers `false`.
pub fn is_open(hwnd: isize) -> bool {
    if hwnd == 0 {
        return false;
    }
    // SAFETY: a handle query only.
    unsafe { IsWindow(Some(hwnd_from(hwnd))) }.as_bool()
}

/// Is this window (or the window it belongs to) the foreground window?
fn is_foreground(hwnd: isize) -> bool {
    // SAFETY: handle query only.
    let foreground = unsafe { GetForegroundWindow() };
    if foreground.0.is_null() {
        return false;
    }
    let foreground = foreground.0 as isize;
    foreground == hwnd || root_owner(foreground) == root_owner(hwnd)
}

fn send_system_command(hwnd: isize, command: u32) -> Result<()> {
    let mut result = 0usize;
    // SAFETY: `result` outlives the call; SMTO_ABORTIFHUNG returns at once for
    // a program that is not answering.
    let sent = unsafe {
        SendMessageTimeoutW(
            hwnd_from(hwnd),
            WM_SYSCOMMAND,
            WPARAM(command as usize),
            LPARAM(0),
            SMTO_ABORTIFHUNG,
            COMMAND_TIMEOUT_MS,
            Some(&mut result),
        )
    };
    if sent.0 == 0 {
        return Err(DesktopError::Message(
            "the program did not answer in time".into(),
        ));
    }
    Ok(())
}

fn alt_tap() {
    let key = |flags: KEYBD_EVENT_FLAGS| INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VK_MENU,
                dwFlags: flags,
                ..Default::default()
            },
        },
    };
    let inputs = [key(KEYBD_EVENT_FLAGS(0)), key(KEYEVENTF_KEYUP)];
    // SAFETY: two well-formed INPUT structures and their real size.
    let sent = unsafe { SendInput(&inputs, size_of::<INPUT>() as i32) };
    if sent != inputs.len() as u32 {
        tracing::debug!(sent, "the Alt tap was not fully delivered");
    }
}

/// Make `hwnd` the foreground window.
///
/// In order, stopping at the first rung that works: (1) restore when
/// minimized, then `SetForegroundWindow(GetLastActivePopup(hwnd))`; (2) an
/// Alt tap, then retry; (3) `SwitchToThisWindow`. Never `AttachThreadInput`:
/// it can hang on a frozen program.
pub fn activate(hwnd: isize) -> Result<ActivationRung> {
    let handle = hwnd_from(hwnd);
    // A gone window must not get as far as the Alt tap, which is a real
    // key press for whatever has the focus.
    // SAFETY: handle query only.
    if hwnd == 0 || !unsafe { IsWindow(Some(handle)) }.as_bool() {
        return Err(DesktopError::Refused("the window is gone".into()));
    }
    // SAFETY: handle queries only.
    if unsafe { IsIconic(handle) }.as_bool() {
        // Best effort: a window that will not restore may still activate.
        if let Err(error) = send_system_command(hwnd, SC_RESTORE) {
            tracing::debug!(%error, "restore before activation failed");
        }
    }
    // SAFETY: handle query only.
    let popup = unsafe { GetLastActivePopup(handle) };
    let target = if popup.0.is_null() { handle } else { popup };

    // SAFETY: handle call; a refused request just returns FALSE.
    let _ = unsafe { SetForegroundWindow(target) };
    std::thread::sleep(SETTLE);
    if is_foreground(hwnd) {
        return Ok(ActivationRung::Direct);
    }

    alt_tap();
    // SAFETY: as above.
    let _ = unsafe { SetForegroundWindow(target) };
    std::thread::sleep(SETTLE);
    if is_foreground(hwnd) {
        return Ok(ActivationRung::AltTap);
    }

    // SAFETY: as above.
    unsafe { SwitchToThisWindow(target, true) };
    std::thread::sleep(SETTLE);
    if is_foreground(hwnd) {
        return Ok(ActivationRung::SwitchTo);
    }
    Err(DesktopError::NotForeground)
}

/// Minimize, when the window has a minimize box (a dialog does not).
pub fn minimize(hwnd: isize) -> Result<()> {
    let handle = hwnd_from(hwnd);
    // SAFETY: handle query only.
    let style = unsafe { GetWindowLongPtrW(handle, GWL_STYLE) } as u32;
    if style & WS_MINIMIZEBOX.0 == 0 {
        return Err(DesktopError::Refused(
            "this window cannot be minimized".into(),
        ));
    }
    // SAFETY: posting a message never blocks on the target.
    unsafe {
        PostMessageW(
            Some(handle),
            WM_SYSCOMMAND,
            WPARAM(SC_MINIMIZE as usize),
            LPARAM(0),
        )
    }
    .map_err(|e| DesktopError::win32("PostMessageW", &e))
}

/// Restore a minimized window and bring it to the front.
pub fn restore(hwnd: isize) -> Result<()> {
    send_system_command(hwnd, SC_RESTORE)?;
    activate(hwnd).map(|_| ())
}

/// Ask the window to close, the way its own close button would.
pub fn close(hwnd: isize) -> Result<()> {
    send_system_command(hwnd, SC_CLOSE)
}

/// Programs below this id are the system itself.
const FIRST_USER_PID: u32 = 8;

/// Terminate a program. Only for a window that is not responding, and only
/// a process of the same user (Windows refuses anything else). Refuses the
/// Staff App's own process.
pub fn end_process(pid: u32) -> Result<()> {
    if pid < FIRST_USER_PID {
        return Err(DesktopError::Refused("not a user program".into()));
    }
    if pid == std::process::id() {
        return Err(DesktopError::Refused("that is the shell itself".into()));
    }
    // SAFETY: the handle is closed below; TerminateProcess needs only the
    // PROCESS_TERMINATE right requested here.
    unsafe {
        let process = OpenProcess(PROCESS_TERMINATE, false, pid)
            .map_err(|e| DesktopError::win32("OpenProcess", &e))?;
        let result = TerminateProcess(process, 1);
        let _ = CloseHandle(process);
        result.map_err(|e| DesktopError::win32("TerminateProcess", &e))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_window_is_not_hung() {
        assert!(!is_hung(0));
    }

    #[test]
    fn a_missing_window_cannot_be_activated_closed_or_minimized() {
        assert!(activate(0).is_err());
        assert!(close(0).is_err());
        assert!(minimize(0).is_err());
    }

    #[test]
    fn a_program_of_the_same_user_can_be_ended() {
        let ping = std::path::Path::new(r"C:\Windows\System32\ping.exe");
        if !ping.exists() {
            return;
        }
        let mut child = std::process::Command::new(ping)
            .args(["-n", "30", "127.0.0.1"])
            .stdout(std::process::Stdio::null())
            .spawn()
            .expect("spawn");
        end_process(child.id()).expect("end the process");
        let status = child.wait().expect("wait");
        assert!(!status.success());
    }

    #[test]
    fn system_and_own_processes_are_never_ended() {
        assert!(matches!(end_process(0), Err(DesktopError::Refused(_))));
        assert!(matches!(end_process(4), Err(DesktopError::Refused(_))));
        assert!(matches!(
            end_process(std::process::id()),
            Err(DesktopError::Refused(_))
        ));
    }
}
