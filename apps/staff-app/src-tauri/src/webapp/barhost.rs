//! The web app bar on the WebView2 side (plan 7.10, Step 15).
//!
//! Every web window is one native window with the site's WebView2 in it (made by Tauri / wry). This
//! module adds the bar: a **second WebView2 controller made from the same environment**, so it shares
//! the site's browser process, GPU process and profile folder and costs one small renderer, not a
//! second browser. It is created after the site has started loading and never delays it.
//!
//! - Layout: the bar owns the top strip and the site is moved down to start below it (`bar::place`),
//!   so nothing of the site is ever covered. A window subclass re-lays both out after wry's own
//!   `WM_SIZE` handling (which resets the site to the full window) and on `WM_DPICHANGED`.
//! - State comes from the real WebView2 of the site: `CanGoBack`, `CanGoForward`, `Source` and the
//!   navigation, history and source events (`NavState` decides what changed).
//! - The bar is Rulebox's own page (`bar::page()`), locked down: it can only be navigated once (by
//!   us, with `NavigateToString`), opens no windows, downloads nothing and is denied every permission.
//!   Its messages are read strictly (`nav::parse_command`). Nothing it says can navigate the site
//!   anywhere but through the history, Reload and Stop, so the allow-list gate (`gate_navigation`)
//!   still decides every address.
//! - Full screen (the page's `ContainsFullScreenElement`) hides the bar; leaving it brings it back.
//!
//! This is the second place outside `rulebox-desktop` that uses `unsafe` (see `hooks.rs`). Everything
//! here runs on the UI thread, so the shared state is `Rc` / `Cell`, and the COM handlers hold `Weak`.

use std::cell::{Cell, RefCell};
use std::rc::{Rc, Weak};
use std::sync::Arc;

use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2, ICoreWebView2Controller, ICoreWebView2Controller2, ICoreWebView2Environment, ICoreWebView2_4,
    COREWEBVIEW2_COLOR, COREWEBVIEW2_KEY_EVENT_KIND, COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN,
    COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN, COREWEBVIEW2_MOVE_FOCUS_REASON,
    COREWEBVIEW2_MOVE_FOCUS_REASON_NEXT, COREWEBVIEW2_MOVE_FOCUS_REASON_PREVIOUS,
    COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC, COREWEBVIEW2_PERMISSION_STATE_DENY,
    COREWEBVIEW2_PHYSICAL_KEY_STATUS,
};
use webview2_com::{
    take_pwstr, AcceleratorKeyPressedEventHandler, ContainsFullScreenElementChangedEventHandler,
    CreateCoreWebView2ControllerCompletedHandler, DownloadStartingEventHandler, FocusChangedEventHandler,
    HistoryChangedEventHandler, MoveFocusRequestedEventHandler, NavigationCompletedEventHandler,
    NavigationStartingEventHandler, NewWindowRequestedEventHandler, PermissionRequestedEventHandler,
    SourceChangedEventHandler, WebMessageReceivedEventHandler,
};
use windows::core::{Interface, BOOL, HSTRING, PWSTR};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::UI::HiDpi::GetDpiForWindow;
use windows::Win32::UI::Input::KeyboardAndMouse::GetKeyState;
use windows::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
use windows::Win32::UI::WindowsAndMessaging::{GetClientRect, GetParent, SIZE_MINIMIZED, WM_DPICHANGED, WM_NCDESTROY, WM_SIZE};

use super::bar::{self, ActionContext, Rect};
use super::hooks::{self, HookContext};
use super::nav::{self, BarCommand, Modifiers, NavAction, NavState};

/// Which subclass of the window is ours (wry has its own ids; this one is "RBAR").
const SUBCLASS_ID: usize = 0x5242_4152;

/// Everything about one window's bar. UI thread only.
struct BarUi {
    context: Arc<HookContext>,
    site: ICoreWebView2Controller,
    site_core: ICoreWebView2,
    /// The top-level window (the parent of the container both web views live in).
    window: HWND,
    bar: RefCell<Option<ICoreWebView2Controller>>,
    bar_core: RefCell<Option<ICoreWebView2>>,
    /// The bar could not be made: the site then takes the whole window, as it did before the bar.
    failed: Cell<bool>,
    /// The bar's page said it is listening.
    ready: Cell<bool>,
    fullscreen: Cell<bool>,
    /// The bar's menu is open: its web view covers the window.
    expanded: Cell<bool>,
}

impl Drop for BarUi {
    fn drop(&mut self) {
        if let Some(bar) = self.bar.get_mut().take() {
            // SAFETY: closing a controller we made; it is not used again.
            let _ = unsafe { bar.Close() };
        }
    }
}

fn win_rect(rect: Rect) -> RECT {
    RECT {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
    }
}

impl BarUi {
    /// Put the bar and the site where `bar::place` says, for the window's current size and DPI.
    fn layout(&self) {
        let mut client = RECT::default();
        // SAFETY: plain reads of the window's own geometry.
        let (ok, dpi) = unsafe { (GetClientRect(self.window, &mut client).is_ok(), GetDpiForWindow(self.window)) };
        let (width, height) = (client.right - client.left, client.bottom - client.top);
        // A minimized window has no client area; the next real size lays it out.
        if !ok || width <= 0 || height <= 0 {
            return;
        }
        let placement = bar::place(
            width,
            height,
            dpi,
            self.fullscreen.get() || self.failed.get(),
            self.expanded.get(),
        );
        // SAFETY: both controllers are live for as long as `self`.
        unsafe {
            let _ = self.site.SetBounds(win_rect(placement.site));
            if let Some(bar) = self.bar.borrow().as_ref() {
                match placement.bar {
                    Some(rect) => {
                        let _ = bar.SetBounds(win_rect(rect));
                        let _ = bar.SetIsVisible(true);
                    }
                    None => {
                        let _ = bar.SetIsVisible(false);
                    }
                }
            }
        }
    }

    /// The site's address, as WebView2 reports it.
    fn source(&self) -> String {
        let mut raw = PWSTR::null();
        // SAFETY: writes the out-parameter, which `take_pwstr` frees.
        match unsafe { self.site_core.Source(&mut raw) } {
            Ok(()) => take_pwstr(raw),
            Err(_) => String::new(),
        }
    }

    /// Read WebView2's own flags, let `edit` record the event, and tell the bar if it would change.
    /// `force` sends even when nothing changed (the bar's page was just loaded).
    fn push(&self, force: bool, edit: impl FnOnce(&mut NavState)) {
        let (mut back, mut forward) = (BOOL::default(), BOOL::default());
        // SAFETY: both only write the out-parameter they are given.
        let (_, _) = unsafe { (self.site_core.CanGoBack(&mut back), self.site_core.CanGoForward(&mut forward)) };
        let source = self.source();
        let look = hooks::look(&self.context);
        let message = {
            let Ok(mut state) = self.context.window.nav.lock() else {
                return;
            };
            state.history(back.as_bool(), forward.as_bool());
            state.navigated(&source);
            edit(&mut state);
            state.next_message(force, look, &self.context.window.app_name)
        };
        if let Some(json) = message {
            self.post(&json);
        }
    }

    fn post(&self, json: &str) {
        if !self.ready.get() {
            return;
        }
        if let Some(core) = self.bar_core.borrow().as_ref() {
            // SAFETY: `core` is live; the call copies the string.
            let _ = unsafe { core.PostWebMessageAsJson(&HSTRING::from(json)) };
        }
    }

    fn go(&self, action: NavAction) {
        // SAFETY: `site_core` is live; these only start a navigation of the site's own history.
        let _ = unsafe {
            match action {
                NavAction::Back => self.site_core.GoBack(),
                NavAction::Forward => self.site_core.GoForward(),
                NavAction::Reload => self.site_core.Reload(),
                NavAction::Stop => self.site_core.Stop(),
            }
        };
    }

    fn focus_page(&self) {
        // SAFETY: `site` is live.
        let _ = unsafe { self.site.MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC) };
    }

    /// Whether `action` does anything now (Back at the first page does not).
    fn applies(&self, action: NavAction) -> bool {
        let view = self.context.window.nav.lock().map(|state| state.view()).unwrap_or_default();
        nav::applies(action, view.back, view.forward)
    }

    fn command(&self, command: BarCommand) {
        match command {
            BarCommand::Ready => {
                self.ready.set(true);
                self.push(true, |_| {});
            }
            BarCommand::Nav { action, mouse } => {
                if !self.applies(action) {
                    return;
                }
                self.go(action);
                if mouse {
                    self.focus_page();
                }
            }
            BarCommand::Action(id) => {
                if let Some(action) = bar::find(bar::ACTIONS, &id) {
                    (action.run)(&ActionContext {
                        app_id: &self.context.window.app_id,
                        app_name: &self.context.window.app_name,
                    });
                }
            }
            BarCommand::Menu(open) => {
                self.expanded.set(open && !self.fullscreen.get());
                self.layout();
            }
            BarCommand::FocusPage => self.focus_page(),
        }
    }

    /// The page asked for (or left) HTML full screen.
    fn set_fullscreen(&self, full: bool) {
        self.fullscreen.set(full);
        if full {
            self.expanded.set(false);
        }
        self.layout();
    }

    fn bar_failed(&self, error: &windows::core::Error) {
        tracing::warn!(%error, "the web app bar could not be created; the site takes the whole window");
        self.failed.set(true);
        self.layout();
    }
}

/// Add the bar to a web window. Called once from `hooks::setup`, on the UI thread, before the site is
/// sent to its first page. When it fails the site simply has the whole window (no Back / Reload buttons;
/// the keys still work), and the hardening of the site is untouched.
///
/// # Safety
/// `site` and `env` must be the live controller and environment of the window's WebView2.
pub unsafe fn attach(
    site: &ICoreWebView2Controller,
    env: &ICoreWebView2Environment,
    context: &Arc<HookContext>,
) -> windows::core::Result<()> {
    // SAFETY: the caller guarantees `site` is live.
    let site_core = unsafe { site.CoreWebView2()? };
    let mut container = HWND::default();
    // SAFETY: writes the out-parameter.
    unsafe { site.ParentWindow(&mut container)? };
    // SAFETY: a plain query.
    let window = unsafe { GetParent(container)? };
    let ui = Rc::new(BarUi {
        context: Arc::clone(context),
        site: site.clone(),
        site_core: site_core.clone(),
        window,
        bar: RefCell::new(None),
        bar_core: RefCell::new(None),
        failed: Cell::new(false),
        ready: Cell::new(false),
        fullscreen: Cell::new(false),
        expanded: Cell::new(false),
    });
    // The strip is reserved at once, so the site never starts under the bar and never jumps.
    ui.layout();

    // SAFETY: as documented on the callee; `ui` outlives every use (the subclass owns a strong `Rc`).
    let result = unsafe {
        install_subclass(window, &ui)
            .and_then(|()| site_events(&site_core, site, &ui))
            .and_then(|()| create_bar(env, container, &ui))
    };
    if let Err(error) = &result {
        ui.bar_failed(error);
    }
    result
}

// ---- the window subclass: layout --------------------------------------------------------------

/// The window procedure of our subclass (layout after wry's own handling).
///
/// # Safety
/// Only Windows may call this, through `SetWindowSubclass` (see `install_subclass`): `hwnd` is the
/// subclassed window, the message arguments are the ones for this message, it runs on the window's
/// (UI) thread, and `data` is either 0 or the `Box<Rc<BarUi>>` pointer registered with the subclass.
/// That box stays valid until `WM_NCDESTROY`, which is the last message and frees it exactly once.
unsafe extern "system" fn subclass_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _id: usize,
    data: usize,
) -> LRESULT {
    // Wry's subclass (installed first, so further in) resizes the site to the whole window on
    // WM_SIZE; the bar's layout is applied after it, in the same message, so nothing flickers.
    // SAFETY: forwarding the message we were given.
    let result = unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) };
    if data != 0 {
        // SAFETY: `data` is the `Box<Rc<BarUi>>` leaked by `install_subclass`; it lives until WM_NCDESTROY.
        let ui = unsafe { &*(data as *const Rc<BarUi>) };
        match msg {
            WM_SIZE if wparam.0 != SIZE_MINIMIZED as usize => ui.layout(),
            WM_DPICHANGED => ui.layout(),
            WM_NCDESTROY => {
                // SAFETY: the last message the window gets; the box is freed once, here.
                unsafe {
                    let _ = RemoveWindowSubclass(hwnd, Some(subclass_proc), SUBCLASS_ID);
                    drop(Box::from_raw(data as *mut Rc<BarUi>));
                }
            }
            _ => {}
        }
    }
    result
}

/// Subclass `window` so the bar is laid out after wry's own `WM_SIZE` handling. The subclass owns one
/// strong `Rc` of `ui` (leaked into a `Box`), which `subclass_proc` frees on `WM_NCDESTROY`.
///
/// # Safety
/// `window` must be the live top-level window, and this must run on the thread that owns it (the UI
/// thread), because `SetWindowSubclass` only works from the window's own thread.
unsafe fn install_subclass(window: HWND, ui: &Rc<BarUi>) -> windows::core::Result<()> {
    let data = Box::into_raw(Box::new(Rc::clone(ui)));
    // SAFETY: `window` is the live top-level window; `data` is freed in WM_NCDESTROY or below.
    let installed = unsafe { SetWindowSubclass(window, Some(subclass_proc), SUBCLASS_ID, data as usize) };
    if installed.as_bool() {
        Ok(())
    } else {
        // SAFETY: the subclass was not installed, so nothing else holds `data`.
        drop(unsafe { Box::from_raw(data) });
        Err(windows::core::Error::from_thread())
    }
}

// ---- the site's events ----------------------------------------------------------------------

/// Watch the site's history, address, navigation, full-screen, focus and key events and mirror them to
/// the bar. The handlers hold only `Weak<BarUi>`, so they never keep the bar alive.
///
/// # Safety
/// `core` and `controller` must be the live core and controller of the site's WebView2, and this must
/// run on the UI thread that owns them (the handlers are not `Send` and are called on that thread).
unsafe fn site_events(core: &ICoreWebView2, controller: &ICoreWebView2Controller, ui: &Rc<BarUi>) -> windows::core::Result<()> {
    let mut token = Default::default();
    // SAFETY: `core` and `controller` are live (caller's obligation) and every call is made on the UI
    // thread. Each handler is a COM object that WebView2 takes its own reference to, and it captures
    // only a `Weak<BarUi>`, so it frees itself with the web view. `token` is a plain out-parameter that
    // is overwritten and never used (the handlers are not removed). Inside the handlers, `sender` and
    // `args` are interfaces WebView2 hands over live for the duration of the callback, and the calls
    // on them only read or set that event's own fields.
    unsafe {
        let weak = Rc::downgrade(ui);
        core.add_HistoryChanged(
            &HistoryChangedEventHandler::create(Box::new(move |_, _| {
                if let Some(ui) = weak.upgrade() {
                    ui.push(false, |_| {});
                }
                Ok(())
            })),
            &mut token,
        )?;
        let weak = Rc::downgrade(ui);
        core.add_SourceChanged(
            &SourceChangedEventHandler::create(Box::new(move |_, _| {
                if let Some(ui) = weak.upgrade() {
                    ui.push(false, |_| {});
                }
                Ok(())
            })),
            &mut token,
        )?;
        let weak = Rc::downgrade(ui);
        core.add_NavigationStarting(
            &NavigationStartingEventHandler::create(Box::new(move |_, args| {
                let (Some(ui), Some(args)) = (weak.upgrade(), args) else {
                    return Ok(());
                };
                // The gate (Tauri's `on_navigation`) runs first and cancels what is not allowed;
                // a refused navigation loads nothing and ends no spinner of its own.
                let mut refused = BOOL::default();
                args.Cancel(&mut refused)?;
                let refused = refused.as_bool();
                ui.push(false, |state| {
                    if refused {
                        state.refused();
                    } else {
                        state.started();
                    }
                });
                Ok(())
            })),
            &mut token,
        )?;
        let weak = Rc::downgrade(ui);
        core.add_NavigationCompleted(
            &NavigationCompletedEventHandler::create(Box::new(move |_, _| {
                if let Some(ui) = weak.upgrade() {
                    ui.push(false, NavState::completed);
                }
                Ok(())
            })),
            &mut token,
        )?;
        // Full screen: the bar steps aside, the site takes the window, and both come back.
        let weak = Rc::downgrade(ui);
        core.add_ContainsFullScreenElementChanged(
            &ContainsFullScreenElementChangedEventHandler::create(Box::new(move |sender, _| {
                if let (Some(ui), Some(core)) = (weak.upgrade(), sender) {
                    let mut full = BOOL::default();
                    core.ContainsFullScreenElement(&mut full)?;
                    ui.set_fullscreen(full.as_bool());
                }
                Ok(())
            })),
            &mut token,
        )?;
        // Tab past the end (or before the start) of the page goes to the bar, like a browser.
        let weak = Rc::downgrade(ui);
        controller.add_MoveFocusRequested(
            &MoveFocusRequestedEventHandler::create(Box::new(move |_, args| {
                let (Some(ui), Some(args)) = (weak.upgrade(), args) else {
                    return Ok(());
                };
                if ui.fullscreen.get() {
                    return Ok(());
                }
                let mut reason = COREWEBVIEW2_MOVE_FOCUS_REASON::default();
                args.Reason(&mut reason)?;
                if reason == COREWEBVIEW2_MOVE_FOCUS_REASON_NEXT || reason == COREWEBVIEW2_MOVE_FOCUS_REASON_PREVIOUS {
                    if let Some(bar) = ui.bar.borrow().as_ref() {
                        if bar.MoveFocus(reason).is_ok() {
                            args.SetHandled(true)?;
                        }
                    }
                }
                Ok(())
            })),
            &mut token,
        )?;
        // Whoever gets the focus is a moment to catch up with a theme change (a no-op otherwise).
        let weak = Rc::downgrade(ui);
        controller.add_GotFocus(
            &FocusChangedEventHandler::create(Box::new(move |_, _| {
                if let Some(ui) = weak.upgrade() {
                    ui.push(false, |_| {});
                }
                Ok(())
            })),
            &mut token,
        )?;
        add_keys(controller, ui)?;
    }
    Ok(())
}

/// Alt+Left, Alt+Right, F5 and Ctrl+R, on the site and on the bar. WebView2 raises this only for the
/// window that has the focus, so a key never acts on another window. (The browser's own accelerators
/// stay off; the keys are handled here, from the pure table in `nav.rs`.) Rulebox's global hotkeys are
/// other combinations (Alt+Tab, the exit chord), and the Windows-key hook only looks at that key.
///
/// # Safety
/// `controller` must be a live WebView2 controller, and this must run on the UI thread that owns it.
unsafe fn add_keys(controller: &ICoreWebView2Controller, ui: &Rc<BarUi>) -> windows::core::Result<()> {
    let weak = Rc::downgrade(ui);
    let mut token = Default::default();
    // SAFETY: `controller` is live (caller's obligation) and this is the UI thread. The handler is a
    // COM object WebView2 keeps its own reference to; it captures only a `Weak<BarUi>`. `args` is live
    // for the duration of the callback, and the calls on it only read or set that event's own fields.
    // `token` is a plain out-parameter that is never used (the handler is not removed).
    unsafe {
        controller.add_AcceleratorKeyPressed(
            &AcceleratorKeyPressedEventHandler::create(Box::new(move |_, args| {
                let (Some(ui), Some(args)) = (weak.upgrade(), args) else {
                    return Ok(());
                };
                let mut kind = COREWEBVIEW2_KEY_EVENT_KIND::default();
                args.KeyEventKind(&mut kind)?;
                if kind != COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN && kind != COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN {
                    return Ok(());
                }
                let mut vk = 0u32;
                args.VirtualKey(&mut vk)?;
                let mut status = COREWEBVIEW2_PHYSICAL_KEY_STATUS::default();
                args.PhysicalKeyStatus(&mut status)?;
                let keys = Modifiers {
                    // SAFETY: reads the keyboard state of this thread.
                    ctrl: GetKeyState(0x11) < 0,
                    alt: status.IsMenuKeyDown.as_bool(),
                    shift: GetKeyState(0x10) < 0,
                };
                let Some(action) = nav::shortcut(vk, keys) else {
                    return Ok(());
                };
                if !ui.applies(action) {
                    return Ok(());
                }
                args.SetHandled(true)?;
                // A held key is swallowed once, not repeated.
                if !status.WasKeyDown.as_bool() {
                    ui.go(action);
                }
                Ok(())
            })),
            &mut token,
        )?;
    }
    Ok(())
}

// ---- the bar's own web view -----------------------------------------------------------------

/// Ask for the bar's controller. The answer arrives later on the UI thread's message loop, so the
/// site is not held up: until then the strip is the window's own background (the bar's colour).
///
/// # Safety
/// `env` must be the live environment of the site's WebView2 and `container` the live window both web
/// views sit in (the controller is created as its child), and this must run on the UI thread, whose
/// message loop delivers the completion handler.
unsafe fn create_bar(env: &ICoreWebView2Environment, container: HWND, ui: &Rc<BarUi>) -> windows::core::Result<()> {
    let weak = Rc::downgrade(ui);
    let handler = CreateCoreWebView2ControllerCompletedHandler::create(Box::new(move |result, controller| {
        let Some(ui) = weak.upgrade() else {
            return Ok(());
        };
        let made = result.and_then(|()| controller.ok_or_else(|| windows::core::Error::from(windows::Win32::Foundation::E_POINTER)));
        match made.and_then(|controller| bar_created(&ui, controller)) {
            Ok(()) => {}
            Err(error) => ui.bar_failed(&error),
        }
        Ok(())
    }));
    // SAFETY: `env` and `container` are live; the result is delivered to the handler.
    unsafe { env.CreateCoreWebView2Controller(container, &handler) }
}

fn bar_created(ui: &Rc<BarUi>, controller: ICoreWebView2Controller) -> windows::core::Result<()> {
    // SAFETY: `controller` was just made for us and is live.
    unsafe {
        let core = controller.CoreWebView2()?;
        hooks::settings(&core)?;
        lock_down(&core)?;
        // Transparent: the bar's page paints its own strip, and below it (while a menu is open) the
        // site stays visible.
        if let Ok(more) = controller.cast::<ICoreWebView2Controller2>() {
            more.SetDefaultBackgroundColor(COREWEBVIEW2_COLOR { R: 0, G: 0, B: 0, A: 0 })?;
        }
        messages(&core, ui)?;
        add_keys(&controller, ui)?;

        let weak = Rc::downgrade(ui);
        let mut token = Default::default();
        controller.add_MoveFocusRequested(
            &MoveFocusRequestedEventHandler::create(Box::new(move |_, args| {
                let (Some(ui), Some(args)) = (weak.upgrade(), args) else {
                    return Ok(());
                };
                let mut reason = COREWEBVIEW2_MOVE_FOCUS_REASON::default();
                args.Reason(&mut reason)?;
                let leaving = reason == COREWEBVIEW2_MOVE_FOCUS_REASON_NEXT || reason == COREWEBVIEW2_MOVE_FOCUS_REASON_PREVIOUS;
                if leaving && ui.site.MoveFocus(reason).is_ok() {
                    args.SetHandled(true)?;
                }
                Ok(())
            })),
            &mut token,
        )?;
        let weak = Rc::downgrade(ui);
        controller.add_GotFocus(
            &FocusChangedEventHandler::create(Box::new(move |_, _| {
                if let Some(ui) = weak.upgrade() {
                    ui.push(false, |_| {});
                }
                Ok(())
            })),
            &mut token,
        )?;

        *ui.bar.borrow_mut() = Some(controller.clone());
        *ui.bar_core.borrow_mut() = Some(core.clone());
        ui.layout();
        core.NavigateToString(&HSTRING::from(bar::page()))?;
    }
    Ok(())
}

/// The bar shows one page of ours and nothing else.
///
/// # Safety
/// `core` must be the live core of the bar's WebView2, and this must run on the UI thread that owns it.
unsafe fn lock_down(core: &ICoreWebView2) -> windows::core::Result<()> {
    let mut token = Default::default();
    // SAFETY: `core` is live (caller's obligation) and this is the UI thread. `settings` is a COM
    // interface owned here and released on drop. The handlers are COM objects WebView2 keeps its own
    // reference to; they capture nothing. `args` is live for the duration of its callback, and the calls
    // on it only read or set that event's own fields (`take_pwstr` frees the string `Uri` returns).
    // `token` is a plain out-parameter that is never used (the handlers are not removed).
    unsafe {
        let settings = core.Settings()?;
        settings.SetAreHostObjectsAllowed(false)?;
        settings.SetAreDefaultScriptDialogsEnabled(false)?;
        settings.SetIsBuiltInErrorPageEnabled(false)?;

        // The page we load is a `data:` document; every other address, in the page or a frame, is refused.
        core.add_NavigationStarting(
            &NavigationStartingEventHandler::create(Box::new(|_, args| {
                if let Some(args) = args {
                    let mut uri = PWSTR::null();
                    args.Uri(&mut uri)?;
                    if !take_pwstr(uri).starts_with("data:text/html") {
                        args.SetCancel(true)?;
                    }
                }
                Ok(())
            })),
            &mut token,
        )?;
        core.add_FrameNavigationStarting(
            &NavigationStartingEventHandler::create(Box::new(|_, args| {
                if let Some(args) = args {
                    args.SetCancel(true)?;
                }
                Ok(())
            })),
            &mut token,
        )?;
        core.add_NewWindowRequested(
            &NewWindowRequestedEventHandler::create(Box::new(|_, args| {
                if let Some(args) = args {
                    args.SetHandled(true)?;
                }
                Ok(())
            })),
            &mut token,
        )?;
        core.add_PermissionRequested(
            &PermissionRequestedEventHandler::create(Box::new(|_, args| {
                if let Some(args) = args {
                    args.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY)?;
                }
                Ok(())
            })),
            &mut token,
        )?;
        if let Ok(core4) = core.cast::<ICoreWebView2_4>() {
            core4.add_DownloadStarting(
                &DownloadStartingEventHandler::create(Box::new(|_, args| {
                    if let Some(args) = args {
                        args.SetCancel(true)?;
                    }
                    Ok(())
                })),
                &mut token,
            )?;
        }
    }
    Ok(())
}

/// What the bar's page says goes to `BarUi::command`, after `nav::parse_command` has read it strictly.
///
/// # Safety
/// `core` must be the live core of the bar's WebView2, and this must run on the UI thread that owns it.
unsafe fn messages(core: &ICoreWebView2, ui: &Rc<BarUi>) -> windows::core::Result<()> {
    let weak: Weak<BarUi> = Rc::downgrade(ui);
    let mut token = Default::default();
    // SAFETY: `core` is live (caller's obligation) and this is the UI thread. The handler is a COM
    // object WebView2 keeps its own reference to; it captures only a `Weak<BarUi>`. `args` is live for
    // the duration of the callback, and `take_pwstr` frees the string `WebMessageAsJson` returns.
    // `token` is a plain out-parameter that is never used (the handler is not removed).
    unsafe {
        core.add_WebMessageReceived(
            &WebMessageReceivedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()) };
                let mut raw = PWSTR::null();
                args.WebMessageAsJson(&mut raw)?;
                let json = take_pwstr(raw);
                if let (Some(ui), Some(command)) = (weak.upgrade(), nav::parse_command(&json)) {
                    ui.command(command);
                }
                Ok(())
            })),
            &mut token,
        )?;
    }
    Ok(())
}

