//! Window facts and small operations on **our own** windows.
//!
//! Enumeration and the task filter of other programs' windows land in
//! Step 7. The two functions here only touch windows the Staff App created.

use std::ffi::c_void;
use std::path::PathBuf;

use windows::Win32::Foundation::HWND;
use windows::Win32::UI::WindowsAndMessaging::{
    GetWindowLongPtrW, SetWindowLongPtrW, SetWindowPos, GWL_EXSTYLE, HWND_BOTTOM,
    SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, WS_EX_TOOLWINDOW,
};

use crate::error::{DesktopError, Result};
use crate::mode::ShellToken;

/// What the tracker knows about one top-level window.
#[derive(Clone, Debug)]
pub struct WindowInfo {
    pub hwnd: isize,
    pub pid: u32,
    pub title: String,
    pub exe: Option<PathBuf>,
    pub aumid: Option<String>,
    pub minimized: bool,
    pub cloaked: bool,
    pub class: String,
}

fn hwnd_from(raw: isize) -> HWND {
    HWND(raw as *mut c_void)
}

/// Give one of our own windows `WS_EX_TOOLWINDOW` (Tauri has no option for
/// it). Such a window has no taskbar button of its own and never shows in
/// Alt+Tab, which is what the taskbar strip and the popup need.
pub fn set_tool_window(hwnd: isize) -> Result<()> {
    let hwnd = hwnd_from(hwnd);
    // SAFETY: plain window-long read and write on a handle of our own window;
    // an invalid handle makes the call fail, it does not corrupt memory.
    unsafe {
        let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, style | WS_EX_TOOLWINDOW.0 as isize);
        SetWindowPos(
            hwnd,
            None,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
        )
        .map_err(|e| DesktopError::win32("SetWindowPos", &e))
    }
}

/// Put one of our own windows at the bottom of the z-order without moving,
/// resizing or activating it. Shell mode only: the desktop window lives
/// there so every program window is above it.
pub fn send_to_bottom(_token: &ShellToken, hwnd: isize) -> Result<()> {
    // SAFETY: as above.
    unsafe {
        SetWindowPos(
            hwnd_from(hwnd),
            Some(HWND_BOTTOM),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        )
        .map_err(|e| DesktopError::win32("SetWindowPos", &e))
    }
}
