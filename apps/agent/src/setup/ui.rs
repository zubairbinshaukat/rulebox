//! Rulebox Setup's window (Phase 6 Step 8, plan 4.10.1): a small **native** Win32 window, the same
//! toolkit as the launcher's fallback screen (`apps/shell-launcher/src/fallback.rs`): plain
//! `CreateWindowExW`, `STATIC`, `EDIT` and `BUTTON` controls, GDI fonts, no image, no font file and
//! **no WebView**. All decisions live in `flow.rs`; this file only draws a [`View`] and turns
//! clicks and keys into [`Event`]s.
//!
//! - **Keyboard only works**: Tab and Shift+Tab move between the code box and the buttons, Enter
//!   presses the focused button (or the default one from the code box), Esc presses Close.
//! - **200 % scaling**: the process is DPI aware; every size is a design unit times the screen's
//!   dots per inch over 96, shrunk if the window would not fit the work area.
//! - **Threads**: everything here runs on the window's thread. A [`Job`] runs on a short-lived worker
//!   thread that hands its [`Event`] back through `Shared` plus `PostMessageW`.
//! - The enrollment code is read from the box once, passed to the one job and cleared from the
//!   box; the text buffers are wiped. Nothing about it is logged.
//!
//! This is the one file of the agent that imports `windows::` (the agent had none): plan 4.10.1
//! asks for the launcher's toolkit here, and a native window needs it.

use std::cell::{Cell, RefCell};
use std::ffi::c_void;
use std::sync::{Arc, Mutex, MutexGuard, Once};

use windows::core::PCWSTR;
use windows::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{
    CreateFontW, CreateSolidBrush, DeleteObject, GetDC, GetDeviceCaps, ReleaseDC, SetBkColor, SetBkMode, SetTextColor,
    CLEARTYPE_QUALITY, CLIP_DEFAULT_PRECIS, DEFAULT_CHARSET, HBRUSH, HDC, HFONT, LOGPIXELSY, OPAQUE, OUT_DEFAULT_PRECIS,
};
use windows::Win32::System::Console::{FreeConsole, GetConsoleProcessList};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Input::KeyboardAndMouse::{EnableWindow, GetFocus, SetFocus, VK_ESCAPE, VK_RETURN};
use windows::Win32::UI::WindowsAndMessaging::{
    AdjustWindowRectEx, CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetDlgCtrlID, GetMessageW,
    GetSystemMetrics, GetWindowLongPtrW, GetWindowTextLengthW, GetWindowTextW, IsDialogMessageW, LoadCursorW, MoveWindow,
    PostMessageW, PostQuitMessage, RegisterClassExW, SendMessageW, SetForegroundWindow, SetProcessDPIAware, SetWindowLongPtrW,
    SetWindowTextW, ShowWindow, SystemParametersInfoW, TranslateMessage, BS_DEFPUSHBUTTON, BS_PUSHBUTTON, CREATESTRUCTW,
    CS_HREDRAW, CS_VREDRAW, ES_AUTOHSCROLL, GWLP_USERDATA, HMENU, IDC_ARROW, MSG, SM_CXSCREEN, SM_CYSCREEN, SPI_GETWORKAREA,
    SW_HIDE, SW_SHOW, SW_SHOWNORMAL, SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS, WINDOW_EX_STYLE, WINDOW_STYLE, WM_APP, WM_CLOSE,
    WM_COMMAND, WM_CREATE, WM_CTLCOLORSTATIC, WM_DESTROY, WM_KEYDOWN, WM_NCCREATE, WM_NCDESTROY, WM_SETFONT, WNDCLASSEXW,
    WS_BORDER, WS_CAPTION, WS_CHILD, WS_MINIMIZEBOX, WS_OVERLAPPED, WS_SYSMENU, WS_TABSTOP, WS_VISIBLE,
};

use rulebox_win32::util::to_wide;

use crate::setup::flow::{run_job, Action, Backend, Effect, Event, Flow, View};
use crate::setup::pending::MAX_CODE_LEN;
use crate::setup::strings;

const CLASS_NAME: &str = "RuleboxSetupWindow";

const ID_TITLE: i32 = 201;
const ID_BODY: i32 = 202;
const ID_LABEL: i32 = 203;
const ID_EDIT: i32 = 204;
const ID_ERROR: i32 = 205;
const ID_BUTTON_FIRST: i32 = 211;
const BUTTON_COUNT: usize = 2;

/// `WM_APP + 1`: a worker finished a job; its event waits in `Shared`.
const WM_JOB_DONE: u32 = WM_APP + 1;
/// `BM_CLICK` and `BM_SETSTYLE` (the buttons feature is not worth enabling for two constants).
const BM_CLICK: u32 = 0x00F5;
const BM_SETSTYLE: u32 = 0x00F4;
const EM_SETLIMITTEXT: u32 = 0x00C5;
const EM_SETSEL: u32 = 0x00B1;

// The same warm paper neutrals as the launcher's screen. COLORREF is 0x00BBGGRR.
const BACKGROUND: COLORREF = rgb(244, 240, 232);
const INK: COLORREF = rgb(38, 35, 31);
const ERROR: COLORREF = rgb(180, 35, 24);

const fn rgb(r: u32, g: u32, b: u32) -> COLORREF {
    COLORREF(r | (g << 8) | (b << 16))
}

/// The window's size in design units (a unit is one pixel at 100 % scaling).
const DESIGN_WIDTH: i32 = 620;
const DESIGN_HEIGHT: i32 = 480;
const MARGIN: i32 = 28;

#[derive(Default)]
struct Shared {
    event: Mutex<Option<Event>>,
}

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[derive(Clone, Copy)]
struct Fonts {
    title: HFONT,
    body: HFONT,
    edit: HFONT,
    button: HFONT,
}

struct Window {
    backend: Arc<dyn Backend>,
    flow: RefCell<Flow>,
    shared: Arc<Shared>,
    /// Pixels per design unit.
    unit: f32,
    fonts: Cell<Option<Fonts>>,
    brush: Cell<HBRUSH>,
    title: Cell<HWND>,
    body: Cell<HWND>,
    label: Cell<HWND>,
    edit: Cell<HWND>,
    error: Cell<HWND>,
    buttons: [Cell<HWND>; BUTTON_COUNT],
    /// What each visible button does.
    actions: RefCell<Vec<Action>>,
}

/// Shows the window and returns when it is closed. `simulate` only changes the title.
pub fn show(backend: Arc<dyn Backend>, simulate: bool) {
    hide_own_console();
    // SAFETY: no preconditions; best effort (fails only when already set).
    let _ = unsafe { SetProcessDPIAware() };
    let (unit, outer_w, outer_h, left, top) = geometry();

    let window = Box::new(Window {
        backend,
        flow: RefCell::new(Flow::new()),
        shared: Arc::new(Shared::default()),
        unit,
        fonts: Cell::new(None),
        brush: Cell::new(HBRUSH::default()),
        title: Cell::new(HWND::default()),
        body: Cell::new(HWND::default()),
        label: Cell::new(HWND::default()),
        edit: Cell::new(HWND::default()),
        error: Cell::new(HWND::default()),
        buttons: [Cell::new(HWND::default()), Cell::new(HWND::default())],
        actions: RefCell::new(Vec::new()),
    });
    let ptr = Box::into_raw(window);

    register_class();
    let class = to_wide(CLASS_NAME);
    let title = to_wide(&if simulate { format!("{} (simulation)", strings::WINDOW_TITLE) } else { strings::WINDOW_TITLE.to_string() });
    // SAFETY: `ptr` stays valid until it is turned back into a Box below, after the message loop
    // has ended and the window is gone.
    let created = unsafe {
        let module = GetModuleHandleW(None).unwrap_or_default();
        CreateWindowExW(
            WINDOW_EX_STYLE(0),
            PCWSTR(class.as_ptr()),
            PCWSTR(title.as_ptr()),
            WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX,
            left,
            top,
            outer_w,
            outer_h,
            None,
            None,
            Some(module.into()),
            Some(ptr as *const c_void),
        )
    };
    match created {
        Ok(hwnd) => {
            // SAFETY: valid window handle on its own thread.
            unsafe {
                let _ = ShowWindow(hwnd, SW_SHOWNORMAL);
                let _ = SetForegroundWindow(hwnd);
            }
            message_loop(hwnd, ptr);
            // SAFETY: the window is destroyed, nobody else touches `ptr` any more.
            drop(unsafe { Box::from_raw(ptr) });
        }
        Err(error) => {
            // SAFETY: the window was never created, so `ptr` is still ours alone.
            drop(unsafe { Box::from_raw(ptr) });
            eprintln!("error: cannot open the Rulebox Setup window ({error}). Use `rulebox-agent compat` and `rulebox-agent enroll <code>` instead.");
        }
    }
}

/// A console window that was opened only for this process (the Start menu shortcut or the
/// installer's finish page starts a console program) is closed; a console the user typed the
/// command into stays.
fn hide_own_console() {
    let mut processes = [0u32; 2];
    // SAFETY: the slice is a valid out buffer of two ids.
    let attached = unsafe { GetConsoleProcessList(&mut processes) };
    if attached == 1 {
        // SAFETY: detaches this process from its own console; nothing else uses it.
        let _ = unsafe { FreeConsole() };
    }
}

/// The scale, the outer window size and its top-left corner: centered in the work area, and
/// shrunk when the scaled design would not fit.
fn geometry() -> (f32, i32, i32, i32, i32) {
    // SAFETY: a DC of the screen, released below.
    let dpi = unsafe {
        let hdc = GetDC(None);
        let dpi = GetDeviceCaps(Some(hdc), LOGPIXELSY);
        ReleaseDC(None, hdc);
        dpi
    };
    let mut work = RECT::default();
    // SAFETY: `work` is a RECT, the out parameter of SPI_GETWORKAREA.
    let have_work = unsafe {
        SystemParametersInfoW(SPI_GETWORKAREA, 0, Some(std::ptr::from_mut(&mut work).cast()), SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0))
    }
    .is_ok();
    if !have_work {
        // SAFETY: no preconditions.
        work = unsafe { RECT { left: 0, top: 0, right: GetSystemMetrics(SM_CXSCREEN).max(800), bottom: GetSystemMetrics(SM_CYSCREEN).max(600) } };
    }
    let mut unit = (dpi.max(96) as f32 / 96.0).clamp(1.0, 4.0);
    let room_w = (work.right - work.left - 24).max(320) as f32;
    let room_h = (work.bottom - work.top - 24).max(240) as f32;
    // The title bar and border add a little; leave 8 % for them.
    unit = unit.min(room_w / DESIGN_WIDTH as f32 * 0.96).min(room_h / DESIGN_HEIGHT as f32 * 0.92);
    let client_w = (DESIGN_WIDTH as f32 * unit).round() as i32;
    let client_h = (DESIGN_HEIGHT as f32 * unit).round() as i32;
    let mut outer = RECT { left: 0, top: 0, right: client_w, bottom: client_h };
    // SAFETY: `outer` is a valid RECT; the style matches the window's.
    unsafe {
        let _ = AdjustWindowRectEx(&mut outer, WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX, false, WINDOW_EX_STYLE(0));
    }
    let width = outer.right - outer.left;
    let height = outer.bottom - outer.top;
    let left = work.left + ((work.right - work.left) - width).max(0) / 2;
    let top = work.top + ((work.bottom - work.top) - height).max(0) / 3;
    (unit, width, height, left, top)
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

/// Runs until `WM_QUIT`. Enter and Esc are handled here (so they work from the code box too); Tab
/// and the arrow keys go through `IsDialogMessageW`, which moves the focus between `WS_TABSTOP`
/// controls.
fn message_loop(hwnd: HWND, window: *const Window) {
    let mut msg = MSG::default();
    loop {
        // SAFETY: `msg` is a valid out parameter; 0 means WM_QUIT, -1 an error.
        let got = unsafe { GetMessageW(&mut msg, None, 0, 0) };
        if got.0 <= 0 {
            break;
        }
        if msg.message == WM_KEYDOWN {
            // SAFETY: the pointer is valid while the loop runs (see `show`).
            let w = unsafe { &*window };
            if w.on_key(hwnd, msg.wParam.0 as u32) {
                continue;
            }
        }
        // SAFETY: `msg` came from GetMessageW; `hwnd` is the live top-level window.
        unsafe {
            if !IsDialogMessageW(hwnd, &msg).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
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
    // SAFETY: the value was set from a live `Window` in WM_NCCREATE and is cleared in
    // WM_NCDESTROY; `Window` is only ever used through shared references.
    let window = unsafe { (GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *const Window).as_ref() };
    let Some(window) = window else {
        // SAFETY: forwarding the unchanged message.
        return unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) };
    };
    let handled = window.handle(hwnd, msg, wparam, lparam);
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

    fn handle(&self, hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> Option<LRESULT> {
        match msg {
            WM_CREATE => {
                self.on_create(hwnd);
                Some(LRESULT(0))
            }
            WM_CTLCOLORSTATIC => {
                let hdc = HDC(wparam.0 as *mut c_void);
                let control = HWND(lparam.0 as *mut c_void);
                // SAFETY: `hdc` is the control's DC for this message; the control handle is live.
                unsafe {
                    let id = GetDlgCtrlID(control);
                    SetTextColor(hdc, if id == ID_ERROR { ERROR } else { INK });
                    SetBkColor(hdc, BACKGROUND);
                    SetBkMode(hdc, OPAQUE);
                }
                Some(LRESULT(self.brush.get().0 as isize))
            }
            WM_COMMAND => {
                let id = (wparam.0 & 0xFFFF) as i32;
                let code = ((wparam.0 >> 16) & 0xFFFF) as u32;
                if code == 0 && (ID_BUTTON_FIRST..ID_BUTTON_FIRST + BUTTON_COUNT as i32).contains(&id) {
                    self.on_button(hwnd, (id - ID_BUTTON_FIRST) as usize);
                }
                Some(LRESULT(0))
            }
            WM_JOB_DONE => {
                if let Some(event) = locked(&self.shared.event).take() {
                    self.dispatch(hwnd, event);
                }
                Some(LRESULT(0))
            }
            WM_CLOSE => {
                self.dispatch(hwnd, Event::Close);
                Some(LRESULT(0))
            }
            WM_DESTROY => {
                // SAFETY: ends the message loop of this thread.
                unsafe { PostQuitMessage(0) };
                Some(LRESULT(0))
            }
            WM_NCDESTROY => {
                self.delete_gdi();
                None
            }
            _ => None,
        }
    }

    // ----- creation ------------------------------------------------------------------------------

    fn on_create(&self, hwnd: HWND) {
        let fonts = Fonts {
            title: self.make_font(26, true),
            body: self.make_font(15, false),
            edit: self.make_font(16, false),
            button: self.make_font(15, false),
        };
        self.fonts.set(Some(fonts));
        // SAFETY: plain GDI call; the brush is deleted in `delete_gdi`.
        self.brush.set(unsafe { CreateSolidBrush(BACKGROUND) });

        let visible = WS_CHILD | WS_VISIBLE;
        self.title.set(self.make_child(hwnd, "STATIC", "", visible, ID_TITLE, fonts.title));
        self.body.set(self.make_child(hwnd, "STATIC", "", visible, ID_BODY, fonts.body));
        self.label.set(self.make_child(hwnd, "STATIC", "", WS_CHILD, ID_LABEL, fonts.body));
        let edit = self.make_child(
            hwnd,
            "EDIT",
            "",
            WS_CHILD | WS_TABSTOP | WS_BORDER | WINDOW_STYLE(ES_AUTOHSCROLL as u32),
            ID_EDIT,
            fonts.edit,
        );
        // SAFETY: valid control handle created above.
        unsafe {
            SendMessageW(edit, EM_SETLIMITTEXT, Some(WPARAM(MAX_CODE_LEN + 16)), None);
        }
        self.edit.set(edit);
        self.error.set(self.make_child(hwnd, "STATIC", "", WS_CHILD, ID_ERROR, fonts.body));
        for (index, slot) in self.buttons.iter().enumerate() {
            slot.set(self.make_child(
                hwnd,
                "BUTTON",
                "",
                WS_CHILD | WS_TABSTOP | WINDOW_STYLE(BS_PUSHBUTTON as u32),
                ID_BUTTON_FIRST + index as i32,
                fonts.button,
            ));
        }
        self.dispatch(hwnd, Event::Start);
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
        // SAFETY: both strings are NUL-terminated and outlive the call; the control id travels in
        // the menu parameter as the API requires.
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

    fn delete_gdi(&self) {
        if let Some(f) = self.fonts.take() {
            for font in [f.title, f.body, f.edit, f.button] {
                // SAFETY: each font was created by `make_font` and is deleted once.
                unsafe {
                    let _ = DeleteObject(font.into());
                }
            }
        }
        let brush = self.brush.replace(HBRUSH::default());
        if !brush.is_invalid() {
            // SAFETY: the brush was created in `on_create` and is deleted once.
            unsafe {
                let _ = DeleteObject(brush.into());
            }
        }
    }

    // ----- events ----------------------------------------------------------------------------------

    /// Feeds one event to the flow, starts the job it asks for, redraws.
    fn dispatch(&self, hwnd: HWND, event: Event) {
        let effect = self.flow.borrow_mut().on(event);
        match effect {
            Effect::Nothing => {}
            Effect::Quit => {
                // SAFETY: valid window handle on its own thread.
                unsafe {
                    let _ = DestroyWindow(hwnd);
                }
                return;
            }
            Effect::Run(job) => {
                let backend = Arc::clone(&self.backend);
                let shared = Arc::clone(&self.shared);
                let address = hwnd.0 as usize;
                std::thread::spawn(move || {
                    let event = run_job(backend.as_ref(), job);
                    *locked(&shared.event) = Some(event);
                    post(address, WM_JOB_DONE);
                });
            }
        }
        self.apply_view(hwnd);
    }

    fn on_button(&self, hwnd: HWND, index: usize) {
        let action = self.actions.borrow().get(index).copied();
        match action {
            Some(Action::Enroll) => {
                let text = self.read_code();
                self.dispatch(hwnd, Event::Submit(text));
                // The code left the box with the job; a refused one is typed again.
                if self.flow.borrow().busy() {
                    // SAFETY: valid control handle on this thread.
                    unsafe {
                        let _ = SetWindowTextW(self.edit.get(), PCWSTR(to_wide("").as_ptr()));
                    }
                }
            }
            Some(Action::CheckAgain) => self.dispatch(hwnd, Event::CheckAgain),
            Some(Action::Close) => self.dispatch(hwnd, Event::Close),
            None => {}
        }
    }

    /// Enter presses the focused button, or the default one from anywhere else; Esc presses Close.
    /// Returns true when the key was ours.
    fn on_key(&self, hwnd: HWND, vk: u32) -> bool {
        let actions = self.actions.borrow().clone();
        if actions.is_empty() {
            return false;
        }
        // SAFETY: plain query.
        let focus = unsafe { GetFocus() };
        if vk == u32::from(VK_RETURN.0) {
            let focused = self.buttons.iter().position(|slot| slot.get() == focus).filter(|index| *index < actions.len());
            let target = focused.or_else(|| self.default_index());
            if let Some(index) = target {
                self.click(index);
                return true;
            }
        } else if vk == u32::from(VK_ESCAPE.0) {
            if let Some(index) = actions.iter().position(|action| *action == Action::Close) {
                self.click(index);
                return true;
            }
        }
        let _ = hwnd;
        false
    }

    fn default_index(&self) -> Option<usize> {
        let view = self.flow.borrow().view();
        view.buttons.iter().position(|button| button.default)
    }

    fn click(&self, index: usize) {
        // SAFETY: valid control handle on this thread; a disabled button ignores the click.
        unsafe {
            SendMessageW(self.buttons[index].get(), BM_CLICK, None, None);
        }
    }

    /// The code box's text. The UTF-16 buffer is wiped after it is turned into text.
    fn read_code(&self) -> String {
        // SAFETY: valid control handle on this thread.
        let length = unsafe { GetWindowTextLengthW(self.edit.get()) }.max(0) as usize;
        let mut buffer = vec![0u16; length.min(MAX_CODE_LEN + 16) + 1];
        // SAFETY: `buffer` is a valid writable slice for the control's text.
        let copied = unsafe { GetWindowTextW(self.edit.get(), &mut buffer) }.max(0) as usize;
        let text = String::from_utf16_lossy(&buffer[..copied.min(buffer.len())]);
        buffer.fill(0);
        std::hint::black_box(&buffer);
        text
    }

    // ----- drawing --------------------------------------------------------------------------------------

    fn apply_view(&self, hwnd: HWND) {
        let view = self.flow.borrow().view();
        self.draw(hwnd, &view);
    }

    fn draw(&self, hwnd: HWND, view: &View) {
        set_text(self.title.get(), &view.title);
        set_text(self.body.get(), &view.lines.join("\r\n"));
        let has_input = view.input.is_some();
        if let Some(input) = &view.input {
            set_text(self.label.get(), input.label);
            set_text(self.error.get(), input.error.as_deref().unwrap_or(""));
        }
        let mut actions = Vec::new();
        for (index, slot) in self.buttons.iter().enumerate() {
            let control = slot.get();
            match view.buttons.get(index) {
                Some(button) => {
                    set_text(control, button.label);
                    let style = if button.default { BS_DEFPUSHBUTTON } else { BS_PUSHBUTTON };
                    // SAFETY: valid control handles on this thread.
                    unsafe {
                        SendMessageW(control, BM_SETSTYLE, Some(WPARAM(style as usize)), Some(LPARAM(1)));
                        let _ = EnableWindow(control, !view.busy);
                        let _ = ShowWindow(control, SW_SHOW);
                    }
                    actions.push(button.action);
                }
                None => {
                    // SAFETY: valid control handle on this thread.
                    unsafe {
                        let _ = ShowWindow(control, SW_HIDE);
                    }
                }
            }
        }
        *self.actions.borrow_mut() = actions;
        // SAFETY: valid control handles on this thread.
        unsafe {
            for control in [self.label.get(), self.edit.get(), self.error.get()] {
                let _ = ShowWindow(control, if has_input { SW_SHOW } else { SW_HIDE });
            }
        }
        self.layout(has_input);
        self.focus(hwnd, view, has_input);
    }

    /// Positions the controls (design units scaled by `px`). The body takes the room the code
    /// box does not use.
    fn layout(&self, has_input: bool) {
        let width = DESIGN_WIDTH - 2 * MARGIN;
        let place = |control: HWND, x: i32, y: i32, w: i32, h: i32| {
            // SAFETY: valid control handle on this thread.
            unsafe {
                let _ = MoveWindow(control, self.px(x), self.px(y), self.px(w), self.px(h), true);
            }
        };
        place(self.title.get(), MARGIN, 24, width, 44);
        let buttons_top = DESIGN_HEIGHT - MARGIN - 40;
        if has_input {
            place(self.body.get(), MARGIN, 84, width, 190);
            place(self.label.get(), MARGIN, 282, width, 22);
            place(self.edit.get(), MARGIN, 306, width, 32);
            place(self.error.get(), MARGIN, 344, width, 52);
        } else {
            place(self.body.get(), MARGIN, 84, width, buttons_top - 84 - 12);
        }
        // Right aligned: the first button (the default one) is the left of the two.
        let (first_w, second_w, gap) = (170, 130, 12);
        let total = first_w + gap + second_w;
        let left = DESIGN_WIDTH - MARGIN - total;
        place(self.buttons[0].get(), left, buttons_top, first_w, 40);
        place(self.buttons[1].get(), left + first_w + gap, buttons_top, second_w, 40);
        // A lone button (Finish, Close) sits at the right edge.
        if self.actions.borrow().len() == 1 {
            place(self.buttons[0].get(), DESIGN_WIDTH - MARGIN - first_w, buttons_top, first_w, 40);
        }
    }

    fn focus(&self, hwnd: HWND, view: &View, has_input: bool) {
        // SAFETY: valid window and control handles on this thread.
        unsafe {
            if view.busy {
                let _ = SetFocus(Some(hwnd));
            } else if has_input {
                let edit = self.edit.get();
                let _ = SetFocus(Some(edit));
                SendMessageW(edit, EM_SETSEL, Some(WPARAM(0)), Some(LPARAM(-1)));
            } else if let Some(index) = view.buttons.iter().position(|button| button.default) {
                let _ = SetFocus(Some(self.buttons[index].get()));
            }
        }
    }
}

fn set_text(control: HWND, text: &str) {
    let wide = to_wide(text);
    // SAFETY: valid control handle on this thread; the string is NUL-terminated.
    unsafe {
        let _ = SetWindowTextW(control, PCWSTR(wide.as_ptr()));
    }
}

/// `PostMessageW` from a worker thread (a window handle travels as an integer).
fn post(window: usize, message: u32) {
    let hwnd = HWND(window as *mut c_void);
    // SAFETY: posting to a window that may be gone is allowed and simply fails.
    unsafe {
        let _ = PostMessageW(Some(hwnd), message, WPARAM(0), LPARAM(0));
    }
}
