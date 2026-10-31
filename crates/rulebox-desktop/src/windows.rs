//! Window facts: reading other programs' top-level windows (read-only), the
//! taskbar filter, and two small operations on **our own** windows.

use std::ffi::c_void;
use std::path::PathBuf;

use windows::core::{w, PWSTR};
use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
use windows::Win32::Graphics::Gdi::{
    ClientToScreen, CombineRgn, CreateRectRgn, CreateRoundRectRgn, DeleteObject, SetWindowRgn,
    RGN_OR,
};
use windows::Win32::Storage::EnhancedStorage::PKEY_AppUserModel_ID;
use windows::Win32::System::Com::CoTaskMemFree;
use windows::Win32::System::Com::StructuredStorage::{PropVariantClear, PropVariantToStringAlloc};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Shell::PropertiesSystem::{IPropertyStore, SHGetPropertyStoreForWindow};
use windows::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, FindWindowExW, GetAncestor, GetClassNameW, GetDesktopWindow, GetPropW,
    GetWindow, GetWindowLongPtrW, GetWindowRect, GetWindowTextLengthW, GetWindowTextW,
    GetWindowThreadProcessId, IsIconic, IsWindow, IsWindowVisible, SetWindowLongPtrW,
    SetWindowPos, GA_PARENT, GA_ROOTOWNER, GWL_EXSTYLE, GWL_STYLE, GW_OWNER, HWND_BOTTOM,
    MA_NOACTIVATE, STYLESTRUCT, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
    SWP_NOZORDER, WM_MOUSEACTIVATE, WM_NCACTIVATE, WM_NCDESTROY, WM_NCPAINT, WM_STYLECHANGING,
    WS_CAPTION, WS_EX_APPWINDOW, WS_EX_CLIENTEDGE, WS_EX_DLGMODALFRAME, WS_EX_NOACTIVATE,
    WS_EX_STATICEDGE, WS_EX_TOOLWINDOW, WS_EX_WINDOWEDGE, WS_MAXIMIZEBOX, WS_MINIMIZEBOX,
    WS_SYSMENU, WS_THICKFRAME,
};

use crate::error::{DesktopError, Result};
use crate::mode::ShellToken;
use crate::placement::Rect;

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

/// The window-style bits that make Windows draw a title bar, buttons or a sizing
/// frame (`WS_CAPTION` already includes `WS_BORDER` and `WS_DLGFRAME`).
const FRAME_STYLE_BITS: u32 =
    WS_CAPTION.0 | WS_SYSMENU.0 | WS_MINIMIZEBOX.0 | WS_MAXIMIZEBOX.0 | WS_THICKFRAME.0;

/// The extended-style bits that add an edge or a taskbar button to a window.
const FRAME_EX_STYLE_BITS: u32 = WS_EX_APPWINDOW.0
    | WS_EX_WINDOWEDGE.0
    | WS_EX_CLIENTEDGE.0
    | WS_EX_STATICEDGE.0
    | WS_EX_DLGMODALFRAME.0;

/// Pure: a style word with every frame bit removed.
pub fn without_frame_style(style: u32) -> u32 {
    style & !FRAME_STYLE_BITS
}

/// Pure: an extended style word for an overlay (the taskbar strip, the popup):
/// a tool window (no taskbar button, no Alt+Tab entry), no edges.
pub fn overlay_ex_style(ex_style: u32) -> u32 {
    (ex_style | WS_EX_TOOLWINDOW.0) & !FRAME_EX_STYLE_BITS
}

/// Drop the caption styles of one of our own windows; `true` when any were set.
/// The taskbar and popup pages have no frame, but Tauri's undecorated windows keep
/// `WS_CAPTION` (the toolkit hides the frame by answering `WM_NCCALCSIZE`), and it
/// puts the bits back whenever it re-applies its window flags (showing the window
/// does). The window guard (`guard_overlay_frame`) stops that for good; this is the
/// belt to its braces and runs again with every shape update.
fn strip_caption(hwnd: HWND) -> bool {
    // SAFETY: plain window-long read and write on a handle of our own window.
    unsafe {
        let style = GetWindowLongPtrW(hwnd, GWL_STYLE);
        let wanted = without_frame_style(style as u32) as isize;
        // Keep the high bits of a pointer-sized value (`WS_POPUP` is the top bit).
        let wanted = (style & !(u32::MAX as isize)) | wanted;
        if wanted == style {
            return false;
        }
        SetWindowLongPtrW(hwnd, GWL_STYLE, wanted);
        true
    }
}

/// Subclass id of the frame guard (a constant of ours, one per window).
const GUARD_ID: usize = 0x5242_4752;

/// `dwRefData` flag: a click on this window must never activate it.
const GUARD_NEVER_ACTIVATE: usize = 1;

/// Window procedure of the frame guard. It runs before the toolkit's own and
/// keeps a frame-less overlay frame-less:
///
/// - `WM_STYLECHANGING`: whoever sets the styles (the toolkit does, on show,
///   focus and always-on-top changes) gets the frame bits removed from the new
///   value before it is applied. DWM then never sees a caption, not even for an
///   instant.
/// - `WM_NCACTIVATE`: activation changes (every click on the strip activates
///   and deactivates it) must not repaint the non-client area; DWM paints the
///   caption of the window that is being activated, through the translucent
///   pills, until the window is next re-framed.
/// - `WM_NCPAINT`: nothing to paint, the page covers the whole window.
/// - `WM_MOUSEACTIVATE`: the taskbar strip is never made the active window by
///   a click, so the program the user was working in keeps the focus.
unsafe extern "system" fn guard_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _id: usize,
    data: usize,
) -> LRESULT {
    match message {
        WM_STYLECHANGING if lparam.0 != 0 => {
            // SAFETY: for this message `lparam` points at a STYLESTRUCT that
            // Windows owns for the duration of the call.
            let change = unsafe { &mut *(lparam.0 as *mut STYLESTRUCT) };
            if wparam.0 as i32 == GWL_STYLE.0 {
                change.styleNew = without_frame_style(change.styleNew);
            } else if wparam.0 as i32 == GWL_EXSTYLE.0 {
                change.styleNew = overlay_ex_style(change.styleNew);
            }
            // SAFETY: forwards the same message to the next procedure.
            unsafe { DefSubclassProc(hwnd, message, wparam, lparam) }
        }
        // lParam -1: "do not repaint the non-client area".
        // SAFETY: as above.
        WM_NCACTIVATE => unsafe { DefSubclassProc(hwnd, message, wparam, LPARAM(-1)) },
        WM_NCPAINT => LRESULT(0),
        WM_MOUSEACTIVATE if data & GUARD_NEVER_ACTIVATE != 0 => LRESULT(MA_NOACTIVATE as isize),
        WM_NCDESTROY => {
            // SAFETY: the window is going away; drop our hook first.
            let _ = unsafe { RemoveWindowSubclass(hwnd, Some(guard_proc), GUARD_ID) };
            // SAFETY: as above.
            unsafe { DefSubclassProc(hwnd, message, wparam, lparam) }
        }
        // SAFETY: as above.
        _ => unsafe { DefSubclassProc(hwnd, message, wparam, lparam) },
    }
}

/// Keep one of our own overlay windows (the taskbar strip, the popup) free of
/// frame styles for its whole life, and stop its activation changes from
/// painting a frame. Call once per window, from the thread that owns it.
/// `never_activate`: a click on the window does not activate it (the strip).
pub fn guard_overlay_frame(hwnd: isize, never_activate: bool) -> Result<()> {
    let hwnd = hwnd_from(hwnd);
    let data = if never_activate { GUARD_NEVER_ACTIVATE } else { 0 };
    // SAFETY: SetWindowSubclass only works from the thread that created the
    // window and fails (returns false) otherwise; `guard_proc` is a plain
    // function that lives for the whole program.
    let installed = unsafe { SetWindowSubclass(hwnd, Some(guard_proc), GUARD_ID, data) };
    if !installed.as_bool() {
        return Err(DesktopError::Message("SetWindowSubclass failed".into()));
    }
    Ok(())
}

/// Give one of our own windows `WS_EX_TOOLWINDOW` (Tauri has no option for
/// it) and remove its frame styles. Such a window has no taskbar button of its
/// own and never shows in Alt+Tab, which is what the taskbar strip and the popup
/// need. Also installs the frame guard so the toolkit cannot undo it.
pub fn set_tool_window(hwnd: isize, never_activate: bool) -> Result<()> {
    guard_overlay_frame(hwnd, never_activate)?;
    let hwnd = hwnd_from(hwnd);
    // SAFETY: plain window-long read and write on a handle of our own window;
    // an invalid handle makes the call fail, it does not corrupt memory.
    unsafe {
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, overlay_ex_style(ex as u32) as isize | (ex & !(u32::MAX as isize)));
        strip_caption(hwnd);
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

/// Move and size one of our own windows so its outer rectangle is exactly
/// `rect` (physical pixels). Tauri's size call leaves a frame outside that
/// rectangle, which would sit on the taskbar strip.
pub fn place_outer(hwnd: isize, rect: Rect) -> Result<()> {
    // SAFETY: SetWindowPos on a handle of our own window. A bad handle fails
    // the call; it does not write through a pointer.
    unsafe {
        SetWindowPos(
            hwnd_from(hwnd),
            None,
            rect.left,
            rect.top,
            rect.width().max(1),
            rect.height().max(1),
            SWP_NOZORDER | SWP_NOACTIVATE,
        )
        .map_err(|e| DesktopError::win32("SetWindowPos", &e))
    }
}

/// Limit one of our own windows to the union of rounded rectangles `rects`
/// (physical pixels, relative to the **client** area; `radius` is the corner
/// radius). Everything outside is neither drawn nor hit: mouse input goes to
/// the window behind. This is how the taskbar's transparent strip between its
/// pills lets clicks through, which `WS_EX_TRANSPARENT` cannot do per area and
/// `HTTRANSPARENT` cannot do across the WebView2 process boundary.
///
/// An empty `rects` removes the shape (the whole window takes input again).
pub fn set_shape(hwnd: isize, rects: &[Rect], radius: i32) -> Result<()> {
    let hwnd = hwnd_from(hwnd);
    if strip_caption(hwnd) {
        // SAFETY: our own window; only asks it to recompute its frame.
        let _ = unsafe {
            SetWindowPos(
                hwnd,
                None,
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
            )
        };
    }
    if rects.is_empty() {
        // SAFETY: a null region removes the window's region; no pointer is read.
        let cleared = unsafe { SetWindowRgn(hwnd, None, true) };
        return if cleared == 0 {
            Err(DesktopError::Message("SetWindowRgn(clear) failed".into()))
        } else {
            Ok(())
        };
    }
    // SAFETY: every GDI region created here is either deleted in this
    // function or handed to `SetWindowRgn`, which then owns it. The RECT and
    // POINT are locals the calls write into.
    unsafe {
        let mut window = RECT::default();
        GetWindowRect(hwnd, &mut window).map_err(|e| DesktopError::win32("GetWindowRect", &e))?;
        // A region is in window coordinates; the page reports client ones.
        let mut origin = POINT { x: 0, y: 0 };
        if !ClientToScreen(hwnd, &mut origin).as_bool() {
            return Err(DesktopError::Message("ClientToScreen failed".into()));
        }
        let dx = origin.x - window.left;
        let dy = origin.y - window.top;
        let diameter = radius.max(0) * 2;

        let combined = CreateRectRgn(0, 0, 0, 0);
        for rect in rects {
            // Right and bottom of a round-rect region are exclusive and one short.
            let piece = CreateRoundRectRgn(
                rect.left + dx,
                rect.top + dy,
                rect.right + dx + 1,
                rect.bottom + dy + 1,
                diameter,
                diameter,
            );
            CombineRgn(Some(combined), Some(combined), Some(piece), RGN_OR);
            let _ = DeleteObject(piece.into());
        }
        if SetWindowRgn(hwnd, Some(combined), true) == 0 {
            let _ = DeleteObject(combined.into());
            return Err(DesktopError::Message("SetWindowRgn failed".into()));
        }
        Ok(())
    }
}

/// The outer rectangle of a window, in physical pixels (read-only).
pub fn outer_rect(hwnd: isize) -> Option<Rect> {
    let mut rect = windows::Win32::Foundation::RECT::default();
    // SAFETY: GetWindowRect only writes the RECT we pass; a stale handle makes it fail.
    unsafe { windows::Win32::UI::WindowsAndMessaging::GetWindowRect(hwnd_from(hwnd), &mut rect).ok()? };
    Some(Rect::new(rect.left, rect.top, rect.right, rect.bottom))
}

/// Pure: does `window` hide everything inside `area`? A window that reaches
/// the edges within `slack` pixels counts (a maximized window's outer
/// rectangle overshoots the work area by its invisible frame).
pub fn covers(window: Rect, area: Rect, slack: i32) -> bool {
    window.left <= area.left + slack
        && window.top <= area.top + slack
        && window.right >= area.right - slack
        && window.bottom >= area.bottom - slack
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

    #[test]
    fn covers_counts_a_maximized_frame_but_not_a_smaller_window() {
        let area = Rect::new(0, 0, 1366, 728);
        // A maximized window's outer rectangle overshoots by its invisible frame.
        assert!(covers(Rect::new(-8, -8, 1374, 736), area, 2));
        assert!(covers(area, area, 0));
        // One pixel short on any side is not covering (with no slack).
        assert!(!covers(Rect::new(1, 0, 1366, 728), area, 0));
        assert!(!covers(Rect::new(0, 0, 1366, 700), area, 2));
        // A window in the middle of the screen, or parked off-screen when minimized.
        assert!(!covers(Rect::new(200, 100, 900, 600), area, 2));
        assert!(!covers(Rect::new(-32000, -32000, -31840, -31972), area, 2));
    }

    #[test]
    fn frame_bits_are_removed_and_the_rest_is_kept() {
        // What the toolkit sets on an undecorated window: caption, system menu,
        // both boxes, visible and clip-siblings.
        let toolkit = WS_CAPTION.0 | WS_SYSMENU.0 | WS_MINIMIZEBOX.0 | WS_MAXIMIZEBOX.0 | 0x1400_0000;
        assert_eq!(without_frame_style(toolkit), 0x1400_0000);
        // The border and dialog-frame halves of WS_CAPTION go too.
        assert_eq!(without_frame_style(0x0080_0000 | 0x0040_0000), 0);
        assert_eq!(without_frame_style(WS_THICKFRAME.0 | 0x1000_0000), 0x1000_0000);
        // Nothing to remove: unchanged.
        assert_eq!(without_frame_style(0x1400_0000), 0x1400_0000);
        // The popup bit (the top bit) survives.
        assert_eq!(without_frame_style(0x8000_0000 | WS_CAPTION.0), 0x8000_0000);
    }

    #[test]
    fn an_overlay_is_a_tool_window_without_edges_or_a_button() {
        let toolkit = WS_EX_WINDOWEDGE.0 | WS_EX_APPWINDOW.0 | 0x10 | WS_EX_NOACTIVATE.0 | 0x8;
        let overlay = overlay_ex_style(toolkit);
        assert_eq!(overlay & WS_EX_TOOLWINDOW.0, WS_EX_TOOLWINDOW.0);
        assert_eq!(overlay & WS_EX_APPWINDOW.0, 0);
        assert_eq!(overlay & WS_EX_WINDOWEDGE.0, 0);
        // Always-on-top, accept-files and no-activate are left alone.
        assert_eq!(overlay & (0x10 | WS_EX_NOACTIVATE.0 | 0x8), 0x10 | WS_EX_NOACTIVATE.0 | 0x8);
        // Idempotent.
        assert_eq!(overlay_ex_style(overlay), overlay);
    }

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
