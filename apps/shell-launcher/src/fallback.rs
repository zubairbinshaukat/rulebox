//! The native "Contact your administrator" screen (plan Step 12).
//!
//! A fullscreen, topmost, plain Win32 window: `CreateWindowExW`, `DrawTextW` and
//! two kinds of child control (`BUTTON`, `EDIT`). No images, no font files, no
//! WebView. It is shown when the Staff App crashes five times in a minute, when
//! `current.json` or the Staff App file is unusable, or when the process cannot
//! be started.
//!
//! (1.1) The hidden admin exit lives here too, because there is no Staff App to
//! offer it: the key combination opens a small PIN panel inside this window and
//! `exit::submit` carries the PIN to the agent. The combination is never drawn.
//!
//! Threading: everything below runs on the window's own thread. The two pipe calls
//! (`exit::load_settings`, `exit::submit`) run on short-lived worker threads and
//! hand their answer back through `Shared` plus `PostMessageW`.

use std::cell::Cell;
use std::ffi::c_void;
use std::sync::{Arc, Mutex, MutexGuard, Once};
use std::time::{Duration, Instant};

use rulebox_ipc::hotkey::Hotkey;
use rulebox_win32::util::to_wide;
use windows::core::PCWSTR;
use windows::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{
    BeginPaint, CreateFontW, CreatePen, CreateSolidBrush, DeleteObject, DrawTextW, EndPaint,
    FillRect, GetDC, InvalidateRect, ReleaseDC, RoundRect, SelectObject,
    SetBkMode, SetTextColor, CLEARTYPE_QUALITY, CLIP_DEFAULT_PRECIS, DEFAULT_CHARSET,
    DRAW_TEXT_FORMAT, DT_CALCRECT, DT_CENTER, DT_NOPREFIX, DT_WORDBREAK, HBRUSH, HDC, HFONT,
    OUT_DEFAULT_PRECIS, PAINTSTRUCT, PS_SOLID, TRANSPARENT,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    EnableWindow, GetKeyState, RegisterHotKey, SetFocus, UnregisterHotKey, HOT_KEY_MODIFIERS,
    MOD_ALT, MOD_CONTROL, MOD_NOREPEAT, MOD_SHIFT, VK_CONTROL, VK_ESCAPE, VK_F4, VK_MENU,
    VK_RETURN, VK_SHIFT,
};
use windows::Win32::UI::WindowsAndMessaging::{
    BringWindowToTop, CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW,
    GetClientRect, GetForegroundWindow, GetMessageW, GetParent, GetSystemMetrics,
    GetWindowLongPtrW, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, KillTimer,
    LoadCursorW, MoveWindow, PostMessageW, PostQuitMessage, RegisterClassExW, SendMessageW,
    SetForegroundWindow, SetProcessDPIAware, SetTimer, SetWindowLongPtrW, SetWindowTextW,
    ShowWindow, TranslateMessage, BS_PUSHBUTTON, CREATESTRUCTW, CS_HREDRAW, CS_VREDRAW,
    ES_AUTOHSCROLL, ES_CENTER, ES_NUMBER, ES_PASSWORD, GWLP_USERDATA, HMENU, IDC_ARROW, MSG,
    SM_CXSCREEN, SM_CYSCREEN, SW_HIDE, SW_SHOW, WINDOW_EX_STYLE, WINDOW_STYLE, WM_APP, WM_CLOSE,
    WM_COMMAND, WM_CREATE, WM_DESTROY, WM_DISPLAYCHANGE, WM_ERASEBKGND, WM_HOTKEY, WM_KEYDOWN,
    WM_NCCREATE, WM_NCDESTROY, WM_PAINT, WM_SETFONT, WM_SIZE, WM_SYSKEYDOWN, WM_TIMER,
    WNDCLASSEXW, WS_BORDER, WS_CHILD, WS_EX_TOPMOST, WS_POPUP, WS_TABSTOP, WS_VISIBLE,
};

use crate::exit::{self, ExitSettings, ExitView, SIGN_OUT_FAILED_TEXT, SIGN_OUT_GRACE};
use crate::log;

/// How the screen ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FallbackChoice {
    /// "Try again" was clicked (or Enter was pressed).
    TryAgain,
    /// Nobody did anything for 30 seconds.
    Timeout,
    /// The window was closed. Only possible in debug builds (Alt+F4).
    Closed,
}

/// The window retries by itself after this long without a click.
pub const AUTO_RETRY: Duration = Duration::from_secs(30);

const TITLE: &str = "Rulebox can't start.";
const SUBTITLE: &str = "Please contact your administrator.";
const HINT: &str = "Administrators: restart and hold Shift to reach the Windows sign-in screen.";
const PANEL_TITLE: &str = "Administrator exit";
const SIGN_OUT_LABEL: &str = "Sign out to Windows";

const ID_TRY_AGAIN: i32 = 101;
const ID_EDIT: i32 = 102;
const ID_SIGN_OUT: i32 = 103;
const ID_CANCEL: i32 = 104;

const TIMER_RETRY: usize = 1;
const TIMER_TICK: usize = 2;
const HOTKEY_ID: i32 = 1;

/// `WM_APP + 1`: the worker finished `adminExit.submit` (wParam = submit generation).
const WM_SUBMIT_DONE: u32 = WM_APP + 1;
/// `WM_APP + 2`: the worker finished `state.get`.
const WM_SETTINGS_DONE: u32 = WM_APP + 2;

const EN_CHANGE: u32 = 0x0300;
/// EM_SETLIMITTEXT lives in the controls feature, which is not worth enabling for one constant.
const EM_SETLIMITTEXT: u32 = 0x00C5;
const MIN_PIN_LEN: usize = 4;
const MAX_PIN_LEN: usize = 12;

// COLORREF is 0x00BBGGRR. Warm paper neutrals, one ink, one error red.
const BACKGROUND: COLORREF = rgb(244, 240, 232);
const INK: COLORREF = rgb(38, 35, 31);
const MUTED: COLORREF = rgb(107, 101, 92);
const ERROR: COLORREF = rgb(180, 35, 24);
const CARD: COLORREF = rgb(252, 250, 246);
const CARD_EDGE: COLORREF = rgb(214, 207, 195);

const fn rgb(r: u32, g: u32, b: u32) -> COLORREF {
    COLORREF(r | (g << 8) | (b << 16))
}

/// What the worker threads leave for the window thread to pick up.
#[derive(Default)]
struct Shared {
    settings: Mutex<Option<ExitSettings>>,
    submit: Mutex<Option<ExitView>>,
}

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// GDI font handles (plain Copy values; deleted in WM_NCDESTROY).
#[derive(Clone, Copy)]
struct Fonts {
    title: HFONT,
    subtitle: HFONT,
    body: HFONT,
    small: HFONT,
    edit: HFONT,
    panel_title: HFONT,
    button: HFONT,
}

struct Window {
    reason: String,
    shared: Arc<Shared>,
    /// Pixels per design unit (screen height / 1080).
    unit: f32,
    fonts: Cell<Option<Fonts>>,

    edit: Cell<HWND>,
    try_again: Cell<HWND>,
    sign_out: Cell<HWND>,
    cancel: Cell<HWND>,

    result: Cell<Option<FallbackChoice>>,
    settings: Cell<ExitSettings>,
    hotkey_registered: Cell<Option<Hotkey>>,
    panel_open: Cell<bool>,
    view: Cell<ExitView>,
    /// Bumped whenever the panel closes, so a late answer is not shown in a later panel.
    generation: Cell<usize>,
    lock_deadline: Cell<Option<Instant>>,
    sign_out_deadline: Cell<Option<Instant>>,
    sign_out_failed: Cell<bool>,
}

/// Shows the screen and returns when "Try again" is clicked or `AUTO_RETRY` passes.
pub fn show(reason: &str) -> FallbackChoice {
    log::line(&format!("fallback: shown ({reason})"));

    // SAFETY: no preconditions; best effort (fails only when already set).
    let _ = unsafe { SetProcessDPIAware() };
    let (screen_w, screen_h) = screen_size();
    let unit = (screen_h as f32 / 1080.0).clamp(0.7, 2.0);

    let window = Box::new(Window {
        reason: reason.to_string(),
        shared: Arc::new(Shared::default()),
        unit,
        fonts: Cell::new(None),
        edit: Cell::new(HWND::default()),
        try_again: Cell::new(HWND::default()),
        sign_out: Cell::new(HWND::default()),
        cancel: Cell::new(HWND::default()),
        result: Cell::new(None),
        settings: Cell::new(ExitSettings::fallback()),
        hotkey_registered: Cell::new(None),
        panel_open: Cell::new(false),
        view: Cell::new(ExitView::Ready),
        generation: Cell::new(0),
        lock_deadline: Cell::new(None),
        sign_out_deadline: Cell::new(None),
        sign_out_failed: Cell::new(false),
    });
    let ptr = Box::into_raw(window);

    register_class();
    let class = to_wide(CLASS_NAME);
    let title = to_wide("Rulebox");
    // SAFETY: `ptr` stays valid until it is turned back into a Box below, after the
    // message loop has ended and the window is gone.
    let created = unsafe {
        let module = GetModuleHandleW(None).unwrap_or_default();
        CreateWindowExW(
            WS_EX_TOPMOST,
            PCWSTR(class.as_ptr()),
            PCWSTR(title.as_ptr()),
            WS_POPUP | WS_VISIBLE,
            0,
            0,
            screen_w,
            screen_h,
            None,
            None,
            Some(module.into()),
            Some(ptr as *const c_void),
        )
    };

    let choice = match created {
        Ok(hwnd) => {
            bring_to_front(hwnd);
            message_loop(hwnd, ptr);
            // SAFETY: the window is destroyed, nobody else touches `ptr` any more.
            let window = unsafe { Box::from_raw(ptr) };
            window.result.get().unwrap_or(FallbackChoice::Closed)
        }
        Err(e) => {
            // SAFETY: the window was never created, so `ptr` is still ours alone.
            drop(unsafe { Box::from_raw(ptr) });
            log::line(&format!("fallback: cannot create the window ({e}); waiting instead"));
            // Without a window the launcher still must not spin: wait one retry period.
            std::thread::sleep(AUTO_RETRY);
            FallbackChoice::Timeout
        }
    };
    log::line(&format!("fallback: left ({choice:?})"));
    choice
}

const CLASS_NAME: &str = "RuleboxShellFallback";

/// Makes the new window the active one. Windows only lets the foreground
/// process do that, so the input queue of the current foreground thread is
/// attached for the length of the call (the usual remedy).
fn bring_to_front(hwnd: HWND) {
    // SAFETY: plain window and thread queries; the attachment is undone before returning.
    unsafe {
        let foreground = GetForegroundWindow();
        let theirs = if foreground.is_invalid() { 0 } else { GetWindowThreadProcessId(foreground, None) };
        let ours = GetCurrentThreadId();
        let attached = theirs != 0 && theirs != ours && AttachThreadInput(ours, theirs, true).as_bool();
        let _ = BringWindowToTop(hwnd);
        let _ = SetForegroundWindow(hwnd);
        let _ = SetFocus(Some(hwnd));
        if attached {
            let _ = AttachThreadInput(ours, theirs, false);
        }
    }
}

fn register_class() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        let class = to_wide(CLASS_NAME);
        // SAFETY: plain registration of a window class with a static window procedure.
        unsafe {
            let module = GetModuleHandleW(None).unwrap_or_default();
            let cursor = LoadCursorW(None, IDC_ARROW).unwrap_or_default();
            let brush = CreateSolidBrush(BACKGROUND);
            let class_info = WNDCLASSEXW {
                cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
                style: CS_HREDRAW | CS_VREDRAW,
                lpfnWndProc: Some(wnd_proc),
                hInstance: module.into(),
                hCursor: cursor,
                hbrBackground: brush,
                lpszClassName: PCWSTR(class.as_ptr()),
                ..Default::default()
            };
            RegisterClassExW(&class_info);
        }
    });
}

fn screen_size() -> (i32, i32) {
    // SAFETY: no preconditions.
    unsafe { (GetSystemMetrics(SM_CXSCREEN).max(640), GetSystemMetrics(SM_CYSCREEN).max(480)) }
}

/// Runs until `WM_QUIT`. Keys are looked at before they reach a child control, so
/// the exit combination, Enter and Escape work wherever the focus is.
fn message_loop(hwnd: HWND, window: *const Window) {
    let mut msg = MSG::default();
    loop {
        // SAFETY: `msg` is a valid out parameter; 0 means WM_QUIT, -1 an error.
        let got = unsafe { GetMessageW(&mut msg, None, 0, 0) };
        if got.0 <= 0 {
            break;
        }
        if msg.message == WM_KEYDOWN || msg.message == WM_SYSKEYDOWN {
            // SAFETY: the pointer is valid while the loop runs (see `show`).
            let w = unsafe { &*window };
            // SAFETY: plain query on a window handle.
            let ours = msg.hwnd == hwnd || unsafe { GetParent(msg.hwnd) }.is_ok_and(|p| p == hwnd);
            if ours && w.on_key(hwnd, msg.wParam.0 as u32) {
                continue;
            }
        }
        // SAFETY: `msg` came from GetMessageW.
        unsafe {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

unsafe extern "system" fn wnd_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if msg == WM_NCCREATE {
        // SAFETY: for WM_NCCREATE `lparam` points to the CREATESTRUCTW.
        unsafe {
            let create = lparam.0 as *const CREATESTRUCTW;
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, (*create).lpCreateParams as isize);
            return DefWindowProcW(hwnd, msg, wparam, lparam);
        }
    }
    // SAFETY: the value was set from a live `Window` in WM_NCCREATE and is cleared
    // in WM_NCDESTROY; `Window` is only ever used through shared references.
    let window = unsafe { (GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *const Window).as_ref() };
    let Some(window) = window else {
        // SAFETY: forwarding the unchanged message.
        return unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) };
    };
    let handled = window.handle(hwnd, msg, wparam);
    if msg == WM_NCDESTROY {
        // SAFETY: the window is going away; later messages find no `Window`.
        unsafe { SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0) };
    }
    match handled {
        Some(result) => result,
        // SAFETY: forwarding the unchanged message.
        None => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
    }
}

impl Window {
    fn px(&self, design_units: i32) -> i32 {
        (design_units as f32 * self.unit).round() as i32
    }

    fn handle(&self, hwnd: HWND, msg: u32, wparam: WPARAM) -> Option<LRESULT> {
        match msg {
            WM_CREATE => {
                self.on_create(hwnd);
                Some(LRESULT(0))
            }
            WM_SIZE | WM_DISPLAYCHANGE => {
                if msg == WM_DISPLAYCHANGE {
                    let (w, h) = screen_size();
                    // SAFETY: valid window handle on its own thread.
                    unsafe {
                        let _ = MoveWindow(hwnd, 0, 0, w, h, true);
                    }
                }
                self.layout(hwnd);
                None
            }
            WM_ERASEBKGND => Some(LRESULT(1)),
            WM_PAINT => {
                self.paint(hwnd);
                Some(LRESULT(0))
            }
            WM_COMMAND => {
                let id = (wparam.0 & 0xFFFF) as i32;
                let code = ((wparam.0 >> 16) & 0xFFFF) as u32;
                self.on_command(hwnd, id, code);
                Some(LRESULT(0))
            }
            WM_HOTKEY if wparam.0 as i32 == HOTKEY_ID => {
                self.open_panel(hwnd);
                Some(LRESULT(0))
            }
            WM_KEYDOWN | WM_SYSKEYDOWN => {
                if self.on_key(hwnd, wparam.0 as u32) {
                    Some(LRESULT(0))
                } else {
                    None
                }
            }
            WM_TIMER => {
                self.on_timer(hwnd, wparam.0);
                Some(LRESULT(0))
            }
            WM_SUBMIT_DONE => {
                self.on_submit_done(hwnd, wparam.0);
                Some(LRESULT(0))
            }
            WM_SETTINGS_DONE => {
                self.on_settings_done(hwnd);
                Some(LRESULT(0))
            }
            WM_CLOSE => {
                // A kiosk shell cannot be closed. Debug builds allow Alt+F4 so the
                // window can be looked at on a dev machine (plan Step 12).
                if cfg!(debug_assertions) {
                    self.result.set(Some(FallbackChoice::Closed));
                    // SAFETY: valid window handle on its own thread.
                    unsafe {
                        let _ = DestroyWindow(hwnd);
                    }
                }
                Some(LRESULT(0))
            }
            WM_DESTROY => {
                self.unregister_hotkey(hwnd);
                // SAFETY: valid window handle; the timers belong to it.
                unsafe {
                    let _ = KillTimer(Some(hwnd), TIMER_RETRY);
                    let _ = KillTimer(Some(hwnd), TIMER_TICK);
                    PostQuitMessage(0);
                }
                Some(LRESULT(0))
            }
            WM_NCDESTROY => {
                self.delete_fonts();
                None
            }
            _ => None,
        }
    }

    // ----- creation and layout ---------------------------------------------

    fn on_create(&self, hwnd: HWND) {
        let fonts = Fonts {
            title: self.make_font(46, true),
            subtitle: self.make_font(30, false),
            body: self.make_font(21, false),
            small: self.make_font(18, false),
            edit: self.make_font(30, false),
            panel_title: self.make_font(30, true),
            button: self.make_font(20, false),
        };
        self.fonts.set(Some(fonts));

        let button = |text: &str, id: i32, shown: bool| {
            let mut style = WS_CHILD | WS_TABSTOP | WINDOW_STYLE(BS_PUSHBUTTON as u32);
            if shown {
                style |= WS_VISIBLE;
            }
            self.make_child(hwnd, "BUTTON", text, style, id, fonts.button)
        };
        self.try_again.set(button("Try again", ID_TRY_AGAIN, true));
        self.sign_out.set(button(SIGN_OUT_LABEL, ID_SIGN_OUT, false));
        self.cancel.set(button("Cancel", ID_CANCEL, false));

        let edit_style = WS_CHILD
            | WS_TABSTOP
            | WS_BORDER
            | WINDOW_STYLE(ES_PASSWORD as u32 | ES_NUMBER as u32 | ES_CENTER as u32 | ES_AUTOHSCROLL as u32);
        let edit = self.make_child(hwnd, "EDIT", "", edit_style, ID_EDIT, fonts.edit);
        // SAFETY: valid control handle created above.
        unsafe {
            SendMessageW(edit, EM_SETLIMITTEXT, Some(WPARAM(MAX_PIN_LEN)), None);
        }
        self.edit.set(edit);

        self.register_hotkey(hwnd, self.settings.get().hotkey);
        self.start_retry_timer(hwnd);
        self.layout(hwnd);

        // Ask the agent which combination applies; the default works until then.
        let shared = Arc::clone(&self.shared);
        let addr = hwnd.0 as usize;
        std::thread::spawn(move || {
            let settings = exit::load_settings();
            *locked(&shared.settings) = Some(settings);
            post(addr, WM_SETTINGS_DONE, 0);
        });
    }

    fn make_font(&self, design_height: i32, bold: bool) -> HFONT {
        let face = to_wide("Segoe UI");
        // SAFETY: plain GDI call with a NUL-terminated face name.
        unsafe {
            CreateFontW(
                -self.px(design_height),
                0,
                0,
                0,
                if bold { 700 } else { 400 },
                0,
                0,
                0,
                DEFAULT_CHARSET,
                OUT_DEFAULT_PRECIS,
                CLIP_DEFAULT_PRECIS,
                CLEARTYPE_QUALITY,
                0,
                PCWSTR(face.as_ptr()),
            )
        }
    }

    fn make_child(&self, parent: HWND, class: &str, text: &str, style: WINDOW_STYLE, id: i32, font: HFONT) -> HWND {
        let class = to_wide(class);
        let text = to_wide(text);
        // SAFETY: both strings are NUL-terminated and outlive the call; the control id
        // travels in the menu parameter as the API requires.
        unsafe {
            let module = GetModuleHandleW(None).unwrap_or_default();
            let hwnd = CreateWindowExW(
                WINDOW_EX_STYLE(0),
                PCWSTR(class.as_ptr()),
                PCWSTR(text.as_ptr()),
                style,
                0,
                0,
                10,
                10,
                Some(parent),
                Some(HMENU(id as usize as *mut c_void)),
                Some(module.into()),
                None,
            )
            .unwrap_or_default();
            if !hwnd.is_invalid() {
                SendMessageW(hwnd, WM_SETFONT, Some(WPARAM(font.0 as usize)), Some(LPARAM(1)));
            }
            hwnd
        }
    }

    fn delete_fonts(&self) {
        if let Some(f) = self.fonts.take() {
            for font in [f.title, f.subtitle, f.body, f.small, f.edit, f.panel_title, f.button] {
                // SAFETY: each font was created by `make_font` and is deleted once.
                unsafe {
                    let _ = DeleteObject(font.into());
                }
            }
        }
    }

    fn font(&self, pick: impl Fn(&Fonts) -> HFONT) -> HFONT {
        self.fonts.get().map(|f| pick(&f)).unwrap_or_default()
    }

    /// Positions for both modes. Measures text, so it needs the window for a DC.
    fn geometry(&self, hwnd: HWND) -> Geometry {
        let client = client_rect(hwnd);
        let width = client.right - client.left;
        let height = client.bottom - client.top;

        // Main screen: one centered column.
        let column = (width - 2 * self.px(40)).clamp(self.px(200), self.px(980));
        let left = (width - column) / 2;
        // SAFETY: DC obtained and released on this thread.
        let hdc = unsafe { GetDC(Some(hwnd)) };
        let h_title = measure(hdc, self.font(|f| f.title), TITLE, column);
        let h_sub = measure(hdc, self.font(|f| f.subtitle), SUBTITLE, column);
        let h_reason = measure(hdc, self.font(|f| f.body), &self.reason, column);
        let h_hint = measure(hdc, self.font(|f| f.small), HINT, column);
        // SAFETY: matches the GetDC above.
        unsafe {
            ReleaseDC(Some(hwnd), hdc);
        }
        let button_w = self.px(220);
        let button_h = self.px(54);
        let gap = self.px(14);
        let big_gap = self.px(36);
        let total = h_title + gap + h_sub + big_gap + h_reason + gap + h_hint + big_gap + button_h;
        let mut y = ((height - total) * 40 / 100).max(self.px(24));
        let mut take = |h: i32, extra: i32| {
            let r = RECT { left, top: y, right: left + column, bottom: y + h };
            y += h + extra;
            r
        };
        let title = take(h_title, gap);
        let subtitle = take(h_sub, big_gap);
        let reason = take(h_reason, gap);
        let hint = take(h_hint, big_gap);
        let button_left = (width - button_w) / 2;
        let try_again = RECT { left: button_left, top: y, right: button_left + button_w, bottom: y + button_h };

        // PIN panel: a card in the middle of the window.
        let card_w = (width - 2 * self.px(24)).min(self.px(580));
        let card_h = self.px(400);
        let card_left = (width - card_w) / 2;
        let card_top = ((height - card_h) * 40 / 100).max(self.px(12));
        let card = RECT { left: card_left, top: card_top, right: card_left + card_w, bottom: card_top + card_h };
        let inner = card_w - 2 * self.px(32);
        let card_title = RECT {
            left: card_left + self.px(32),
            top: card_top + self.px(32),
            right: card_left + self.px(32) + inner,
            bottom: card_top + self.px(32) + self.px(44),
        };
        let edit_w = self.px(320).min(inner);
        let edit_top = card_top + self.px(104);
        let edit_left = card_left + (card_w - edit_w) / 2;
        let edit = RECT { left: edit_left, top: edit_top, right: edit_left + edit_w, bottom: edit_top + self.px(56) };
        let message = RECT {
            left: card_left + self.px(32),
            top: edit_top + self.px(56) + self.px(18),
            right: card_left + self.px(32) + inner,
            bottom: edit_top + self.px(56) + self.px(18) + self.px(96),
        };
        let btn_h = self.px(52);
        let btn_top = card.bottom - self.px(32) - btn_h;
        let sign_w = self.px(250).min(inner * 2 / 3);
        let cancel_w = self.px(140).min(inner / 3 - self.px(12));
        let row_w = sign_w + self.px(16) + cancel_w;
        let row_left = card_left + (card_w - row_w) / 2;
        let sign_out = RECT { left: row_left, top: btn_top, right: row_left + sign_w, bottom: btn_top + btn_h };
        let cancel_left = row_left + sign_w + self.px(16);
        let cancel = RECT { left: cancel_left, top: btn_top, right: cancel_left + cancel_w, bottom: btn_top + btn_h };

        Geometry { title, subtitle, reason, hint, try_again, card, card_title, edit, message, sign_out, cancel }
    }

    fn layout(&self, hwnd: HWND) {
        if self.fonts.get().is_none() {
            return;
        }
        let g = self.geometry(hwnd);
        for (control, r) in [
            (self.try_again.get(), g.try_again),
            (self.edit.get(), g.edit),
            (self.sign_out.get(), g.sign_out),
            (self.cancel.get(), g.cancel),
        ] {
            if control.is_invalid() {
                continue;
            }
            // SAFETY: valid child window handle on its own thread.
            unsafe {
                let _ = MoveWindow(control, r.left, r.top, r.right - r.left, r.bottom - r.top, true);
            }
        }
    }

    // ----- painting ---------------------------------------------------------

    fn paint(&self, hwnd: HWND) {
        let mut ps = PAINTSTRUCT::default();
        // SAFETY: standard BeginPaint/EndPaint pair on this window.
        let hdc = unsafe { BeginPaint(hwnd, &mut ps) };
        let client = client_rect(hwnd);
        // SAFETY: valid DC from BeginPaint; the brush is deleted right after use.
        unsafe {
            let brush: HBRUSH = CreateSolidBrush(BACKGROUND);
            FillRect(hdc, &client, brush);
            let _ = DeleteObject(brush.into());
            SetBkMode(hdc, TRANSPARENT);
        }
        let g = self.geometry(hwnd);
        if self.panel_open.get() {
            self.paint_card(hdc, &g);
        } else {
            let centered = DT_CENTER | DT_WORDBREAK | DT_NOPREFIX;
            draw(hdc, self.font(|f| f.title), INK, TITLE, g.title, centered);
            draw(hdc, self.font(|f| f.subtitle), INK, SUBTITLE, g.subtitle, centered);
            draw(hdc, self.font(|f| f.body), MUTED, &self.reason, g.reason, centered);
            draw(hdc, self.font(|f| f.small), MUTED, HINT, g.hint, centered);
        }
        // SAFETY: matches BeginPaint.
        unsafe {
            let _ = EndPaint(hwnd, &ps);
        }
    }

    fn paint_card(&self, hdc: HDC, g: &Geometry) {
        // SAFETY: GDI objects are selected, used and released within this block.
        unsafe {
            let brush = CreateSolidBrush(CARD);
            let pen = CreatePen(PS_SOLID, self.px(2).max(1), CARD_EDGE);
            let old_brush = SelectObject(hdc, brush.into());
            let old_pen = SelectObject(hdc, pen.into());
            let radius = self.px(26);
            let _ = RoundRect(hdc, g.card.left, g.card.top, g.card.right, g.card.bottom, radius, radius);
            SelectObject(hdc, old_brush);
            SelectObject(hdc, old_pen);
            let _ = DeleteObject(brush.into());
            let _ = DeleteObject(pen.into());
        }
        let centered = DT_CENTER | DT_WORDBREAK | DT_NOPREFIX;
        draw(hdc, self.font(|f| f.panel_title), INK, PANEL_TITLE, g.card_title, centered);
        let text = self.message_text();
        if !text.is_empty() {
            let color = if self.message_is_problem() { ERROR } else { MUTED };
            draw(hdc, self.font(|f| f.small), color, &text, g.message, centered);
        }
    }

    fn remaining_lock_ms(&self) -> u64 {
        self.lock_deadline
            .get()
            .map_or(0, |d| u64::try_from(d.saturating_duration_since(Instant::now()).as_millis()).unwrap_or(u64::MAX))
    }

    fn message_text(&self) -> String {
        if self.sign_out_failed.get() {
            return SIGN_OUT_FAILED_TEXT.to_string();
        }
        exit::message(&self.view.get(), self.remaining_lock_ms())
    }

    fn message_is_problem(&self) -> bool {
        self.sign_out_failed.get()
            || matches!(
                self.view.get(),
                ExitView::WrongPin { .. } | ExitView::LockedOut { .. } | ExitView::Unavailable
            )
    }

    fn invalidate(&self, hwnd: HWND) {
        // SAFETY: valid window handle on its own thread.
        unsafe {
            let _ = InvalidateRect(Some(hwnd), None, false);
        }
    }

    // ----- hotkey, keys, commands, timers -----------------------------------

    fn register_hotkey(&self, hwnd: HWND, hotkey: Hotkey) {
        self.unregister_hotkey(hwnd);
        let mut modifiers = MOD_NOREPEAT;
        if hotkey.ctrl {
            modifiers |= MOD_CONTROL;
        }
        if hotkey.alt {
            modifiers |= MOD_ALT;
        }
        if hotkey.shift {
            modifiers |= MOD_SHIFT;
        }
        // SAFETY: registers against this window; failure only means the key
        // matching in `on_key` has to do the work.
        let registered = unsafe { RegisterHotKey(Some(hwnd), HOTKEY_ID, HOT_KEY_MODIFIERS(modifiers.0), hotkey.virtual_key()) };
        if registered.is_ok() {
            self.hotkey_registered.set(Some(hotkey));
        }
    }

    fn unregister_hotkey(&self, hwnd: HWND) {
        if self.hotkey_registered.take().is_some() {
            // SAFETY: undoes the registration made for this window.
            unsafe {
                let _ = UnregisterHotKey(Some(hwnd), HOTKEY_ID);
            }
        }
    }

    /// Returns true when the key was ours.
    fn on_key(&self, hwnd: HWND, vk: u32) -> bool {
        if self.panel_open.get() {
            return match vk {
                v if v == u32::from(VK_RETURN.0) => {
                    self.submit_pin(hwnd);
                    true
                }
                v if v == u32::from(VK_ESCAPE.0) => {
                    if self.view.get() != ExitView::SigningOut {
                        self.close_panel(hwnd);
                    }
                    true
                }
                _ => false,
            };
        }
        if vk == u32::from(VK_F4.0) {
            return false; // Alt+F4 goes to the default handler (debug builds close).
        }
        if self.settings.get().enabled && hotkey_matches(&self.settings.get().hotkey, vk) {
            self.open_panel(hwnd);
            return true;
        }
        if vk == u32::from(VK_RETURN.0) {
            self.finish(hwnd, FallbackChoice::TryAgain);
            return true;
        }
        false
    }

    fn on_command(&self, hwnd: HWND, id: i32, code: u32) {
        match (id, code) {
            (ID_TRY_AGAIN, 0) => self.finish(hwnd, FallbackChoice::TryAgain),
            (ID_SIGN_OUT, 0) => self.submit_pin(hwnd),
            (ID_CANCEL, 0) => self.close_panel(hwnd),
            (ID_EDIT, EN_CHANGE) => self.refresh_controls(),
            _ => {}
        }
    }

    fn on_timer(&self, hwnd: HWND, id: usize) {
        match id {
            TIMER_RETRY => {
                if !self.panel_open.get() {
                    self.finish(hwnd, FallbackChoice::Timeout);
                }
            }
            TIMER_TICK => self.tick(hwnd),
            _ => {}
        }
    }

    fn finish(&self, hwnd: HWND, choice: FallbackChoice) {
        self.result.set(Some(choice));
        // SAFETY: valid window handle on its own thread.
        unsafe {
            let _ = DestroyWindow(hwnd);
        }
    }

    fn start_retry_timer(&self, hwnd: HWND) {
        // SAFETY: valid window handle; a timer with the same id is replaced.
        unsafe {
            SetTimer(Some(hwnd), TIMER_RETRY, AUTO_RETRY.as_millis() as u32, None);
        }
    }

    // ----- the PIN panel ------------------------------------------------------

    fn open_panel(&self, hwnd: HWND) {
        if self.panel_open.get() || !self.settings.get().enabled {
            return;
        }
        log::line("admin exit: opened");
        self.panel_open.set(true);
        self.view.set(ExitView::Ready);
        self.sign_out_failed.set(false);
        self.lock_deadline.set(None);
        self.sign_out_deadline.set(None);
        // The window's own 30-second retry is paused while the panel is open.
        // SAFETY: valid window and control handles on this thread.
        unsafe {
            let _ = KillTimer(Some(hwnd), TIMER_RETRY);
            let _ = ShowWindow(self.try_again.get(), SW_HIDE);
            let _ = SetWindowTextW(self.edit.get(), PCWSTR(to_wide("").as_ptr()));
            let _ = ShowWindow(self.edit.get(), SW_SHOW);
            let _ = ShowWindow(self.sign_out.get(), SW_SHOW);
            let _ = ShowWindow(self.cancel.get(), SW_SHOW);
        }
        self.apply_state(hwnd, true);
    }

    fn close_panel(&self, hwnd: HWND) {
        if !self.panel_open.get() {
            return;
        }
        self.panel_open.set(false);
        self.generation.set(self.generation.get().wrapping_add(1));
        self.view.set(ExitView::Ready);
        self.sign_out_failed.set(false);
        self.lock_deadline.set(None);
        self.sign_out_deadline.set(None);
        // SAFETY: valid window and control handles on this thread.
        unsafe {
            let _ = KillTimer(Some(hwnd), TIMER_TICK);
            let _ = SetWindowTextW(self.edit.get(), PCWSTR(to_wide("").as_ptr()));
            let _ = ShowWindow(self.edit.get(), SW_HIDE);
            let _ = ShowWindow(self.sign_out.get(), SW_HIDE);
            let _ = ShowWindow(self.cancel.get(), SW_HIDE);
            let _ = ShowWindow(self.try_again.get(), SW_SHOW);
        }
        self.start_retry_timer(hwnd);
        self.invalidate(hwnd);
    }

    /// Reads and clears the field. `None` unless it holds 4 to 12 ASCII digits.
    /// The text only ever lives in the returned `String` and in buffers wiped here.
    fn take_pin(&self) -> Option<String> {
        let mut buffer = [0u16; MAX_PIN_LEN + 4];
        // SAFETY: `buffer` is a valid writable slice for the control's text.
        let length = unsafe { GetWindowTextW(self.edit.get(), &mut buffer) }.max(0) as usize;
        let text = String::from_utf16_lossy(&buffer[..length.min(buffer.len())]);
        buffer.fill(0);
        std::hint::black_box(&buffer);
        // SAFETY: clears the field at once, before anything else happens.
        unsafe {
            let _ = SetWindowTextW(self.edit.get(), PCWSTR(to_wide("").as_ptr()));
        }
        let valid = (MIN_PIN_LEN..=MAX_PIN_LEN).contains(&text.len()) && text.bytes().all(|b| b.is_ascii_digit());
        if valid {
            Some(text)
        } else {
            exit::wipe(text);
            None
        }
    }

    fn accepting_input(&self) -> bool {
        matches!(self.view.get(), ExitView::Ready | ExitView::WrongPin { .. } | ExitView::Unavailable)
    }

    fn submit_pin(&self, hwnd: HWND) {
        if !self.panel_open.get() || !self.accepting_input() {
            return;
        }
        let Some(pin) = self.take_pin() else {
            self.refresh_controls();
            return;
        };
        self.view.set(ExitView::Checking);
        self.apply_state(hwnd, false);

        let shared = Arc::clone(&self.shared);
        let addr = hwnd.0 as usize;
        let generation = self.generation.get();
        std::thread::spawn(move || {
            // `submit` owns and wipes the PIN; nothing about it is logged.
            let view = exit::submit(pin);
            *locked(&shared.submit) = Some(view);
            post(addr, WM_SUBMIT_DONE, generation);
        });
    }

    fn on_submit_done(&self, hwnd: HWND, generation: usize) {
        let Some(view) = locked(&self.shared.submit).take() else { return };
        log::line(match view {
            ExitView::WrongPin { .. } => "admin exit: wrong",
            ExitView::LockedOut { .. } => "admin exit: locked",
            ExitView::SigningOut => "admin exit: signing out",
            ExitView::Disabled => "admin exit: disabled",
            _ => "admin exit: unavailable",
        });
        if !self.panel_open.get() || generation != self.generation.get() {
            return;
        }
        match view {
            ExitView::Disabled => {
                self.close_panel(hwnd);
                return;
            }
            ExitView::LockedOut { retry_after_ms } => {
                self.lock_deadline.set(Some(Instant::now() + Duration::from_millis(retry_after_ms)));
            }
            ExitView::SigningOut => {
                self.sign_out_deadline.set(Some(Instant::now() + SIGN_OUT_GRACE));
            }
            _ => {}
        }
        self.view.set(view);
        self.apply_state(hwnd, true);
    }

    fn on_settings_done(&self, hwnd: HWND) {
        let Some(settings) = locked(&self.shared.settings).take() else { return };
        self.settings.set(settings);
        if self.hotkey_registered.get() != Some(settings.hotkey) {
            self.register_hotkey(hwnd, settings.hotkey);
        }
        if !settings.enabled && self.panel_open.get() && self.accepting_input() {
            self.close_panel(hwnd);
        }
    }

    /// Once a second while a lock or a sign-out is pending.
    fn tick(&self, hwnd: HWND) {
        match self.view.get() {
            ExitView::LockedOut { .. } => {
                if self.remaining_lock_ms() == 0 {
                    self.lock_deadline.set(None);
                    self.view.set(ExitView::Ready);
                    self.apply_state(hwnd, true);
                } else {
                    self.invalidate(hwnd);
                }
            }
            ExitView::SigningOut => {
                let waited_out = self.sign_out_deadline.get().is_some_and(|d| Instant::now() >= d);
                if waited_out {
                    // The session is still here: say so and let the person try again.
                    self.sign_out_deadline.set(None);
                    self.sign_out_failed.set(true);
                    self.view.set(ExitView::Ready);
                    log::line("admin exit: unavailable (the session did not end)");
                    self.apply_state(hwnd, true);
                }
            }
            _ => {
                // SAFETY: valid window handle on its own thread.
                unsafe {
                    let _ = KillTimer(Some(hwnd), TIMER_TICK);
                }
            }
        }
    }

    /// Enables the controls that fit the current view. Does not move the focus.
    fn refresh_controls(&self) {
        if !self.panel_open.get() {
            return;
        }
        let accepting = self.accepting_input();
        // SAFETY: valid control handles on this thread. Only the length is read here.
        unsafe {
            let length = GetWindowTextLengthW(self.edit.get()).max(0) as usize;
            let _ = EnableWindow(self.edit.get(), accepting);
            let _ = EnableWindow(self.sign_out.get(), accepting && length >= MIN_PIN_LEN);
            let _ = EnableWindow(self.cancel.get(), self.view.get() != ExitView::SigningOut);
        }
    }

    /// After the view changed: controls, the tick timer, a repaint, optionally the focus.
    fn apply_state(&self, hwnd: HWND, focus: bool) {
        self.refresh_controls();
        let ticking = matches!(self.view.get(), ExitView::LockedOut { .. } | ExitView::SigningOut);
        // SAFETY: valid window and control handles on this thread.
        unsafe {
            if ticking {
                SetTimer(Some(hwnd), TIMER_TICK, 1000, None);
            } else {
                let _ = KillTimer(Some(hwnd), TIMER_TICK);
            }
            if focus && self.accepting_input() {
                let _ = SetFocus(Some(self.edit.get()));
            }
        }
        self.invalidate(hwnd);
    }
}

struct Geometry {
    title: RECT,
    subtitle: RECT,
    reason: RECT,
    hint: RECT,
    try_again: RECT,
    card: RECT,
    card_title: RECT,
    edit: RECT,
    message: RECT,
    sign_out: RECT,
    cancel: RECT,
}

fn client_rect(hwnd: HWND) -> RECT {
    let mut rect = RECT::default();
    // SAFETY: valid window handle and out parameter.
    unsafe {
        let _ = GetClientRect(hwnd, &mut rect);
    }
    rect
}

/// Height of `text` wrapped to `width` in `font`.
fn measure(hdc: HDC, font: HFONT, text: &str, width: i32) -> i32 {
    let mut rect = RECT { left: 0, top: 0, right: width, bottom: 0 };
    let mut wide: Vec<u16> = text.encode_utf16().collect();
    // SAFETY: `hdc` is a live DC; the font is selected only for the measurement.
    unsafe {
        let old = SelectObject(hdc, font.into());
        DrawTextW(hdc, &mut wide, &mut rect, DT_CALCRECT | DT_WORDBREAK | DT_NOPREFIX);
        SelectObject(hdc, old);
    }
    rect.bottom - rect.top
}

fn draw(hdc: HDC, font: HFONT, color: COLORREF, text: &str, mut rect: RECT, format: DRAW_TEXT_FORMAT) {
    let mut wide: Vec<u16> = text.encode_utf16().collect();
    // SAFETY: `hdc` is a live DC from BeginPaint; the previous font is restored.
    unsafe {
        let old = SelectObject(hdc, font.into());
        SetTextColor(hdc, color);
        DrawTextW(hdc, &mut wide, &mut rect, format);
        SelectObject(hdc, old);
    }
}

fn key_down(vk: u16) -> bool {
    // SAFETY: no preconditions.
    unsafe { GetKeyState(i32::from(vk)) < 0 }
}

/// The key plus exactly the modifiers of `hotkey`.
fn hotkey_matches(hotkey: &Hotkey, vk: u32) -> bool {
    vk == hotkey.virtual_key()
        && key_down(VK_CONTROL.0) == hotkey.ctrl
        && key_down(VK_MENU.0) == hotkey.alt
        && key_down(VK_SHIFT.0) == hotkey.shift
}

/// `PostMessageW` from a worker thread (a window handle travels as an integer).
fn post(window: usize, message: u32, wparam: usize) {
    let hwnd = HWND(window as *mut c_void);
    // SAFETY: posting to a window that may be gone is allowed and simply fails.
    unsafe {
        let _ = PostMessageW(Some(hwnd), message, WPARAM(wparam), LPARAM(0));
    }
}

