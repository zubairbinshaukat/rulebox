//! Window facts: reading other programs' top-level windows (read-only), the
//! taskbar filter, and two small operations on **our own** windows.

use std::ffi::c_void;
use std::path::PathBuf;

use windows::core::{w, PWSTR};
use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
use windows::Win32::Storage::EnhancedStorage::PKEY_AppUserModel_ID;
use windows::Win32::System::Com::CoTaskMemFree;
use windows::Win32::System::Com::StructuredStorage::{PropVariantClear, PropVariantToStringAlloc};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Shell::PropertiesSystem::{IPropertyStore, SHGetPropertyStoreForWindow};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, FindWindowExW, GetAncestor, GetClassNameW, GetDesktopWindow, GetPropW,
    GetWindow, GetWindowLongPtrW, GetWindowTextLengthW, GetWindowTextW,
    GetWindowThreadProcessId, IsIconic, IsWindow, IsWindowVisible, SetWindowLongPtrW,
    SetWindowPos, GA_PARENT, GA_ROOTOWNER, GWL_EXSTYLE, GW_OWNER, HWND_BOTTOM, SWP_FRAMECHANGED,
    SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, WS_EX_APPWINDOW, WS_EX_NOACTIVATE,
    WS_EX_TOOLWINDOW, WS_EX_WINDOWEDGE,
};

use crate::error::{DesktopError, Result};
use crate::mode::ShellToken;

/// Long titles are cut here; a taskbar tooltip never needs more.
const MAX_TITLE_CHARS: usize = 512;

/// What the tracker knows about one top-level window.
#[derive(Clone, Debug, PartialEq, Eq)]
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

/// The fast-changing part of [`WindowInfo`]. Title and state events refresh
/// only this, so a chatty window costs one `GetWindowText`, not a process
/// query.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WindowLight {
    pub title: String,
    pub minimized: bool,
    pub cloaked: bool,
}

/// Everything the taskbar filter looks at, as plain data (so the rule is
/// tested without real windows).
#[derive(Clone, Debug, Default)]
pub struct TaskFlags {
    pub is_window: bool,
    pub visible: bool,
    pub has_owner: bool,
    pub ex_appwindow: bool,
    pub ex_toolwindow: bool,
    pub ex_noactivate: bool,
    pub ex_windowedge: bool,
    /// The `ITaskList_Deleted` window property is set.
    pub deleted_prop: bool,
    pub cloaked: bool,
    pub class: String,
}

/// The taskbar rule (the one ManagedShell uses): which windows get a button.
pub fn passes_task_filter(flags: &TaskFlags) -> bool {
    if !flags.is_window || !flags.visible {
        return false;
    }
    if flags.has_owner && !flags.ex_appwindow {
        return false;
    }
    if flags.ex_toolwindow {
        return false;
    }
    if flags.ex_noactivate && !flags.ex_appwindow {
        return false;
    }
    if flags.deleted_prop || flags.cloaked {
        return false;
    }
    match flags.class.as_str() {
        // The inner window of a UWP app; its frame window is the task.
        "Windows.UI.Core.CoreWindow" | "StartMenuSizingFrame" | "Shell_LightDismissOverlay" => {
            false
        }
        // A frame without WS_EX_WINDOWEDGE is the empty host of a suspended app.
        "ApplicationFrameWindow" => flags.ex_windowedge,
        _ => true,
    }
}

fn hwnd_from(raw: isize) -> HWND {
    HWND(raw as *mut c_void)
}

fn read_class(hwnd: HWND) -> String {
    let mut buffer = [0u16; 256];
    // SAFETY: the buffer outlives the call; a dead handle gives length 0.
    let length = unsafe { GetClassNameW(hwnd, &mut buffer) };
    if length <= 0 {
        return String::new();
    }
    String::from_utf16_lossy(&buffer[..length as usize])
}

fn read_title(hwnd: HWND) -> String {
    // SAFETY: both calls only read window text; for another process's window
    // Windows copies the stored caption and never waits on that program.
    unsafe {
        let length = GetWindowTextLengthW(hwnd);
        if length <= 0 {
            return String::new();
        }
        let mut buffer = vec![0u16; (length as usize).min(MAX_TITLE_CHARS) + 1];
        let copied = GetWindowTextW(hwnd, &mut buffer);
        if copied <= 0 {
            return String::new();
        }
        String::from_utf16_lossy(&buffer[..copied as usize])
    }
}

fn is_cloaked(hwnd: HWND) -> bool {
    let mut cloaked = 0u32;
    // SAFETY: the out pointer is a u32 and the size says so.
    let result = unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_CLOAKED,
            &mut cloaked as *mut u32 as *mut c_void,
            std::mem::size_of::<u32>() as u32,
        )
    };
    result.is_ok() && cloaked != 0
}

fn read_flags(hwnd: HWND) -> TaskFlags {
    // SAFETY: plain reads on a window handle; a stale handle yields defaults.
    unsafe {
        let is_window = IsWindow(Some(hwnd)).as_bool();
        if !is_window {
            return TaskFlags::default();
        }
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
        TaskFlags {
            is_window,
            visible: IsWindowVisible(hwnd).as_bool(),
            has_owner: GetWindow(hwnd, GW_OWNER).is_ok_and(|owner| !owner.0.is_null()),
            ex_appwindow: ex & WS_EX_APPWINDOW.0 != 0,
            ex_toolwindow: ex & WS_EX_TOOLWINDOW.0 != 0,
            ex_noactivate: ex & WS_EX_NOACTIVATE.0 != 0,
            ex_windowedge: ex & WS_EX_WINDOWEDGE.0 != 0,
            deleted_prop: !GetPropW(hwnd, w!("ITaskList_Deleted")).is_invalid(),
            cloaked: is_cloaked(hwnd),
            class: read_class(hwnd),
        }
    }
}

/// Does this window get a taskbar button?
pub fn is_task_window(hwnd: isize) -> bool {
    passes_task_filter(&read_flags(hwnd_from(hwnd)))
}

/// Is `hwnd` a top-level window (its parent is the desktop or none)?
pub fn is_top_level(hwnd: isize) -> bool {
    let hwnd = hwnd_from(hwnd);
    // SAFETY: handle queries only.
    unsafe {
        let parent = GetAncestor(hwnd, GA_PARENT);
        parent.0.is_null() || parent == GetDesktopWindow()
    }
}

/// The owner at the top of the chain (a dialog's main window), or `hwnd`
/// itself when it has no owner.
pub fn root_owner(hwnd: isize) -> isize {
    // SAFETY: handle query only.
    let root = unsafe { GetAncestor(hwnd_from(hwnd), GA_ROOTOWNER) };
    if root.0.is_null() {
        hwnd
    } else {
        root.0 as isize
    }
}

/// Title, minimized and cloaked state of a window; `None` when it is gone.
pub fn read_light(hwnd: isize) -> Option<WindowLight> {
    let hwnd = hwnd_from(hwnd);
    // SAFETY: handle queries only.
    if !unsafe { IsWindow(Some(hwnd)) }.as_bool() {
        return None;
    }
    Some(WindowLight {
        title: read_title(hwnd),
        // SAFETY: as above.
        minimized: unsafe { IsIconic(hwnd) }.as_bool(),
        cloaked: is_cloaked(hwnd),
    })
}

fn process_id(hwnd: HWND) -> u32 {
    let mut pid = 0u32;
    // SAFETY: the out pointer is a u32 that lives across the call.
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    pid
}

fn process_image(pid: u32) -> Option<PathBuf> {
    if pid == 0 {
        return None;
    }
    // SAFETY: the handle is closed below; the buffer length is passed in and
    // updated by the call.
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buffer = vec![0u16; 4096];
        let mut length = buffer.len() as u32;
        let result = QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_WIN32,
            PWSTR(buffer.as_mut_ptr()),
            &mut length,
        );
        let _ = CloseHandle(process);
        result.ok()?;
        Some(PathBuf::from(String::from_utf16_lossy(&buffer[..length as usize])))
    }
}

fn read_aumid(hwnd: HWND) -> Option<String> {
    // SAFETY: the property store is a COM object released on drop; the
    // PROPVARIANT is cleared and the allocated string freed on every path.
    unsafe {
        let store: IPropertyStore = SHGetPropertyStoreForWindow(hwnd).ok()?;
        let mut value = store.GetValue(&PKEY_AppUserModel_ID).ok()?;
        let text = PropVariantToStringAlloc(&value).ok().map(|string| {
            let owned = string.to_string().unwrap_or_default();
            CoTaskMemFree(Some(string.0 as *const c_void));
            owned
        });
        let _ = PropVariantClear(&mut value);
        text.filter(|text| !text.is_empty())
    }
}

/// Everything about one window, or `None` when it is not a task window.
pub fn window_info(hwnd: isize) -> Option<WindowInfo> {
    let handle = hwnd_from(hwnd);
    let flags = read_flags(handle);
    if !passes_task_filter(&flags) {
        return None;
    }
    let mut pid = process_id(handle);
    if flags.class == "ApplicationFrameWindow" {
        // The frame belongs to ApplicationFrameHost.exe; the app's own
        // process owns the CoreWindow inside it.
        // SAFETY: handle query only.
        let inner = unsafe {
            FindWindowExW(Some(handle), None, w!("Windows.UI.Core.CoreWindow"), None)
        };
        if let Ok(inner) = inner {
            let inner_pid = process_id(inner);
            if inner_pid != 0 {
                pid = inner_pid;
            }
        }
    }
    let light = read_light(hwnd)?;
    Some(WindowInfo {
        hwnd,
        pid,
        title: light.title,
        exe: process_image(pid),
        aumid: read_aumid(handle),
        minimized: light.minimized,
        cloaked: light.cloaked,
        class: flags.class,
    })
}

/// Every top-level window that gets a taskbar button right now.
pub fn enumerate() -> Vec<WindowInfo> {
    unsafe extern "system" fn collect(hwnd: HWND, lparam: LPARAM) -> windows::core::BOOL {
        // SAFETY: lparam is the `&mut Vec<isize>` passed below, alive for the
        // whole EnumWindows call.
        let handles = unsafe { &mut *(lparam.0 as *mut Vec<isize>) };
        handles.push(hwnd.0 as isize);
        true.into()
    }

    let mut handles: Vec<isize> = Vec::new();
    // SAFETY: see `collect`.
    let result = unsafe { EnumWindows(Some(collect), LPARAM(&mut handles as *mut _ as isize)) };
    if let Err(error) = result {
        tracing::warn!(%error, "EnumWindows failed");
    }
    handles.into_iter().filter_map(window_info).collect()
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

#[cfg(test)]
mod tests {
    use super::*;

    /// A plain, visible, unowned window: passes.
    fn plain() -> TaskFlags {
        TaskFlags {
            is_window: true,
            visible: true,
            class: "Notepad".into(),
            ..TaskFlags::default()
        }
    }

    #[test]
    fn a_plain_visible_window_gets_a_button() {
        assert!(passes_task_filter(&plain()));
    }

    #[test]
    fn dead_or_hidden_windows_do_not() {
        assert!(!passes_task_filter(&TaskFlags {
            is_window: false,
            ..plain()
        }));
        assert!(!passes_task_filter(&TaskFlags {
            visible: false,
            ..plain()
        }));
    }

    #[test]
    fn an_owned_window_needs_appwindow() {
        assert!(!passes_task_filter(&TaskFlags {
            has_owner: true,
            ..plain()
        }));
        assert!(passes_task_filter(&TaskFlags {
            has_owner: true,
            ex_appwindow: true,
            ..plain()
        }));
    }

    #[test]
    fn tool_windows_never_do() {
        assert!(!passes_task_filter(&TaskFlags {
            ex_toolwindow: true,
            ..plain()
        }));
        // Even with APPWINDOW: the plan's rule is unconditional.
        assert!(!passes_task_filter(&TaskFlags {
            ex_toolwindow: true,
            ex_appwindow: true,
            ..plain()
        }));
    }

    #[test]
    fn noactivate_needs_appwindow() {
        assert!(!passes_task_filter(&TaskFlags {
            ex_noactivate: true,
            ..plain()
        }));
        assert!(passes_task_filter(&TaskFlags {
            ex_noactivate: true,
            ex_appwindow: true,
            ..plain()
        }));
    }

    #[test]
    fn deleted_property_hides_a_window() {
        assert!(!passes_task_filter(&TaskFlags {
            deleted_prop: true,
            ..plain()
        }));
    }

    #[test]
    fn cloaked_windows_do_not() {
        assert!(!passes_task_filter(&TaskFlags {
            cloaked: true,
            ..plain()
        }));
    }

    #[test]
    fn uwp_core_window_is_never_a_task() {
        assert!(!passes_task_filter(&TaskFlags {
            class: "Windows.UI.Core.CoreWindow".into(),
            ..plain()
        }));
    }

    #[test]
    fn uwp_frame_counts_once_and_only_with_windowedge() {
        assert!(passes_task_filter(&TaskFlags {
            class: "ApplicationFrameWindow".into(),
            ex_windowedge: true,
            ..plain()
        }));
        assert!(!passes_task_filter(&TaskFlags {
            class: "ApplicationFrameWindow".into(),
            ex_windowedge: false,
            ..plain()
        }));
    }

    #[test]
    fn start_menu_helper_classes_are_excluded() {
        for class in ["StartMenuSizingFrame", "Shell_LightDismissOverlay"] {
            assert!(!passes_task_filter(&TaskFlags {
                class: class.into(),
                ..plain()
            }));
        }
    }

    #[test]
    fn a_real_desktop_window_is_not_a_task_window_of_zero() {
        // The null handle is not a window at all.
        assert!(!is_task_window(0));
    }

    #[test]
    fn enumerate_runs_and_returns_consistent_windows() {
        for info in enumerate() {
            assert_ne!(info.hwnd, 0);
            assert!(!info.class.is_empty());
        }
    }
}
