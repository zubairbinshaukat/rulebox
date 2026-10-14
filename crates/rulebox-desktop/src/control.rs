//! Activate, minimize, restore, maximize, close (the rest lands in Step 8).

use std::ffi::c_void;

use windows::Win32::Foundation::HWND;
use windows::Win32::UI::WindowsAndMessaging::IsHungAppWindow;

/// Has the program stopped answering messages for about five seconds?
/// Read-only; cheap enough to call for each visible task every few seconds.
pub fn is_hung(hwnd: isize) -> bool {
    // SAFETY: a handle query; a stale handle answers `false`.
    unsafe { IsHungAppWindow(HWND(hwnd as *mut c_void)) }.as_bool()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_window_is_not_hung() {
        assert!(!is_hung(0));
    }
}
