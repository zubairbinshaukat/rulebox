//! Work area, minimized-window hiding and the taskman window.
//!
//! Everything that changes session-wide state takes `&ShellToken`, so none of
//! it can run in dev mode. The one exception is [`restore_saved_work_area`]:
//! it only does anything when a token-guarded call changed the work area
//! first, and the message loop calls it on exit.

use std::ffi::c_void;
use std::sync::Mutex;

use windows::core::{s, w, BOOL};
use windows::Win32::Foundation::{HWND, POINT, RECT};
use windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MonitorFromPoint, MONITORINFO, MONITOR_DEFAULTTOPRIMARY,
};
use windows::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};
use windows::Win32::UI::HiDpi::{
    GetDpiForMonitor, SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
    MDT_EFFECTIVE_DPI,
};
use windows::Win32::UI::WindowsAndMessaging::{
    SystemParametersInfoW, ARW_HIDE, MINIMIZEDMETRICS, MINIMIZEDMETRICS_ARRANGE,
    SPIF_SENDCHANGE, SPI_GETMINIMIZEDMETRICS, SPI_SETMINIMIZEDMETRICS, SPI_SETWORKAREA,
    SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS,
};

use crate::error::{DesktopError, Result};
use crate::mode::ShellToken;
use crate::placement::{work_area_after_reserve, Rect};

/// The primary monitor in physical pixels.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MonitorRect {
    /// The whole monitor.
    pub rect: Rect,
    /// The Windows work area on it, right now.
    pub work: Rect,
    /// Effective DPI (96 = 100 %).
    pub dpi: u32,
    /// `dpi / 96`.
    pub scale: f64,
}

/// The work area as it was before Rulebox first changed it.
static ORIGINAL_WORK_AREA: Mutex<Option<Rect>> = Mutex::new(None);

fn from_win(rect: RECT) -> Rect {
    Rect::new(rect.left, rect.top, rect.right, rect.bottom)
}

fn to_win(rect: Rect) -> RECT {
    RECT {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
    }
}

/// Make this process per-monitor DPI aware (v2) so every coordinate in this
/// crate is a physical pixel. Safe to call more than once; Tauri's own
/// start-up may already have done it, which is fine.
pub fn ensure_dpi_aware() {
    // SAFETY: no pointers; fails harmlessly when the awareness is already set.
    let _ = unsafe { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
}

/// The primary monitor: physical pixels and scale.
pub fn primary_monitor() -> Result<MonitorRect> {
    // SAFETY: MonitorFromPoint takes a plain value; GetMonitorInfoW is given a
    // MONITORINFO whose cbSize is set; GetDpiForMonitor writes two u32.
    unsafe {
        let monitor = MonitorFromPoint(POINT { x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY);
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if !GetMonitorInfoW(monitor, &mut info).as_bool() {
            return Err(DesktopError::Message("GetMonitorInfoW failed".into()));
        }
        let (mut dpi_x, mut dpi_y) = (96u32, 96u32);
        // Falls back to 96 when the call fails (very old display drivers).
        let _ = GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, &mut dpi_x, &mut dpi_y);
        let dpi = dpi_x.max(96);
        Ok(MonitorRect {
            rect: from_win(info.rcMonitor),
            work: from_win(info.rcWork),
            dpi,
            scale: f64::from(dpi) / 96.0,
        })
    }
}

fn set_work_area(rect: Rect) -> Result<()> {
    let mut win = to_win(rect);
    // SAFETY: pvParam points to a RECT that outlives the call. No
    // SPIF_UPDATEINIFILE: the change lasts for this session only.
    unsafe {
        SystemParametersInfoW(
            SPI_SETWORKAREA,
            0,
            Some(&mut win as *mut RECT as *mut c_void),
            SPIF_SENDCHANGE,
        )
        .map_err(|e| DesktopError::win32("SystemParametersInfoW(SPI_SETWORKAREA)", &e))
    }
}

/// Reserve `px_physical` pixels at the bottom of the primary monitor for the
/// taskbar strip (shell mode). The first call remembers the original work
/// area so it can be put back.
pub fn set_bottom_reserve(_token: &ShellToken, px_physical: i32) -> Result<()> {
    let monitor = primary_monitor()?;
    {
        let mut saved = ORIGINAL_WORK_AREA.lock().unwrap_or_else(|e| e.into_inner());
        if saved.is_none() {
            *saved = Some(monitor.work);
        }
    }
    set_work_area(work_area_after_reserve(monitor.rect, px_physical))
}

/// Put the work area back as Rulebox found it. No effect when
/// `set_bottom_reserve` was never called.
pub fn restore_work_area(_token: &ShellToken) -> Result<()> {
    restore_saved_work_area()
}

/// Same as [`restore_work_area`] without the token. Only the message loop's
/// shutdown calls it; it is a no-op unless a token-guarded call changed the
/// work area first.
pub(crate) fn restore_saved_work_area() -> Result<()> {
    let saved = ORIGINAL_WORK_AREA
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take();
    match saved {
        Some(original) => set_work_area(original),
        None => Ok(()),
    }
}

/// Hide minimized windows (`ARW_HIDE`) instead of letting them pile up as
/// little title bars at the corner of the desktop. Session only.
pub fn hide_minimized(_token: &ShellToken) -> Result<()> {
    let mut metrics = MINIMIZEDMETRICS {
        cbSize: std::mem::size_of::<MINIMIZEDMETRICS>() as u32,
        ..Default::default()
    };
    // SAFETY: pvParam points to a MINIMIZEDMETRICS with cbSize set; it lives
    // across both calls.
    unsafe {
        SystemParametersInfoW(
            SPI_GETMINIMIZEDMETRICS,
            metrics.cbSize,
            Some(&mut metrics as *mut MINIMIZEDMETRICS as *mut c_void),
            SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
        )
        .map_err(|e| DesktopError::win32("SystemParametersInfoW(GET_MINIMIZEDMETRICS)", &e))?;
        metrics.iArrange = MINIMIZEDMETRICS_ARRANGE(metrics.iArrange.0 | ARW_HIDE);
        SystemParametersInfoW(
            SPI_SETMINIMIZEDMETRICS,
            metrics.cbSize,
            Some(&mut metrics as *mut MINIMIZEDMETRICS as *mut c_void),
            SPIF_SENDCHANGE,
        )
        .map_err(|e| DesktopError::win32("SystemParametersInfoW(SET_MINIMIZEDMETRICS)", &e))
    }
}

/// Tell Windows this window is the task manager window (`SetTaskmanWindow`,
/// an undocumented `user32` export). It makes Windows send the shell-hook
/// messages the tracker needs when no Explorer is running.
pub fn register_taskman(_token: &ShellToken, hwnd: isize) -> Result<()> {
    type SetTaskmanWindow = unsafe extern "system" fn(HWND) -> BOOL;
    // SAFETY: user32.dll is always loaded; the export has this signature on
    // every supported Windows version (it is what Explorer itself calls).
    unsafe {
        let module = LoadLibraryW(w!("user32.dll"))
            .map_err(|e| DesktopError::win32("LoadLibraryW(user32)", &e))?;
        let address = GetProcAddress(module, s!("SetTaskmanWindow"))
            .ok_or_else(|| DesktopError::Message("SetTaskmanWindow is not exported".into()))?;
        let call: SetTaskmanWindow = std::mem::transmute(address);
        if call(HWND(hwnd as *mut c_void)).as_bool() {
            Ok(())
        } else {
            Err(DesktopError::Message("SetTaskmanWindow failed".into()))
        }
    }
}
