//! One dedicated thread owns a hidden top-level window and runs the Win32
//! message loop. It is **not** a message-only window: those do not receive
//! broadcast messages (display change, power, setting change).
//!
//! The window procedure never blocks: it turns a message into a
//! [`DesktopEvent`], pushes it into the channel and returns. Work that must
//! run on this thread (hooks, hotkeys) is posted with [`MsgLoop::run`].

use std::collections::VecDeque;
use std::ffi::c_void;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicIsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::oneshot;
use windows::core::w;
use windows::Win32::Foundation::{ERROR_CLASS_ALREADY_EXISTS, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::RemoteDesktop::{
    WTSRegisterSessionNotification, WTSUnRegisterSessionNotification, NOTIFY_FOR_THIS_SESSION,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, GetWindowLongPtrW,
    PostMessageW, PostQuitMessage, RegisterClassExW, SetWindowLongPtrW, TranslateMessage,
    CREATESTRUCTW, CW_USEDEFAULT, GWLP_USERDATA, MSG, WM_APP, WM_CLOSE, WM_DESTROY,
    WM_NCCREATE, WM_POWERBROADCAST, WNDCLASSEXW, WS_EX_TOOLWINDOW, WS_POPUP,
};

use crate::error::{DesktopError, Result};
use crate::hotkeys::HotkeyId;
use crate::mode::ShellMode;
use crate::notify::{map_message, WM_WTSSESSION_CHANGE};
use crate::tracker::WindowEvent;
use crate::workarea;

/// Everything the shell learns from Windows, in one stream.
#[derive(Clone, Debug)]
pub enum DesktopEvent {
    Window(WindowEvent),
    DisplayChanged,
    DpiChanged,
    Resumed,
    SessionLocked,
    SessionUnlocked,
    PowerChanged,
    Hotkey(HotkeyId),
    VolumeChanged,
    NetworkChanged,
}

/// What a job running on the loop thread can see.
#[derive(Clone, Copy, Debug)]
pub struct LoopCtx {
    /// The hidden window. Hooks and hotkeys are registered against it.
    pub hwnd: isize,
    pub mode: ShellMode,
}

type Job = Box<dyn FnOnce(&LoopCtx) + Send>;

struct Shared {
    queue: Mutex<VecDeque<Job>>,
}

/// Lives on the loop thread's stack; the window procedure borrows it.
struct WndState {
    shared: Arc<Shared>,
    events: UnboundedSender<DesktopEvent>,
    mode: ShellMode,
    hwnd: AtomicIsize,
}

impl WndState {
    fn ctx(&self) -> LoopCtx {
        LoopCtx {
            hwnd: self.hwnd.load(Ordering::SeqCst),
            mode: self.mode,
        }
    }

    fn send(&self, event: DesktopEvent) {
        // A closed receiver only means the app is shutting down.
        let _ = self.events.send(event);
    }

    fn drain_jobs(&self) {
        let ctx = self.ctx();
        loop {
            let job = self
                .shared
                .queue
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .pop_front();
            let Some(job) = job else { break };
            // A panicking job must not unwind through the window procedure.
            if catch_unwind(AssertUnwindSafe(|| job(&ctx))).is_err() {
                tracing::error!("a job on the desktop message loop panicked");
            }
        }
    }
}

/// Handle to the message loop thread.
pub struct MsgLoop {
    hwnd: isize,
    mode: ShellMode,
    shared: Arc<Shared>,
    thread: Option<JoinHandle<()>>,
}

const CLASS_NAME: windows::core::PCWSTR = w!("RuleboxShellMessageWindow");

impl MsgLoop {
    /// Start the thread and wait until its window exists.
    pub fn start(
        mode: ShellMode,
        events: UnboundedSender<DesktopEvent>,
    ) -> Result<MsgLoop> {
        let shared = Arc::new(Shared {
            queue: Mutex::new(VecDeque::new()),
        });
        let (ready_tx, ready_rx) = mpsc::channel::<Result<isize>>();
        let thread_shared = Arc::clone(&shared);

        let thread = std::thread::Builder::new()
            .name("rulebox-msgloop".into())
            .spawn(move || {
                let state = WndState {
                    shared: thread_shared,
                    events,
                    mode,
                    hwnd: AtomicIsize::new(0),
                };
                thread_main(&state, ready_tx);
            })
            .map_err(|e| DesktopError::Message(format!("start the message loop thread: {e}")))?;

        match ready_rx.recv_timeout(Duration::from_secs(5)) {
            Ok(Ok(hwnd)) => Ok(MsgLoop {
                hwnd,
                mode,
                shared,
                thread: Some(thread),
            }),
            Ok(Err(error)) => {
                let _ = thread.join();
                Err(error)
            }
            Err(_) => Err(DesktopError::Message(
                "the message loop did not start within 5 seconds".into(),
            )),
        }
    }

    /// The hidden window's handle (for `register_taskman`, hooks, hotkeys).
    pub fn hwnd(&self) -> isize {
        self.hwnd
    }

    pub fn mode(&self) -> ShellMode {
        self.mode
    }

    /// Run `f` on the loop thread. The result arrives on the returned
    /// receiver; if the loop has stopped (or `f` panics) the receiver
    /// reports an error instead.
    pub fn run<T, F>(&self, f: F) -> oneshot::Receiver<T>
    where
        T: Send + 'static,
        F: FnOnce(&LoopCtx) -> T + Send + 'static,
    {
        let (tx, rx) = oneshot::channel();
        let job: Job = Box::new(move |ctx| {
            let _ = tx.send(f(ctx));
        });
        self.shared
            .queue
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push_back(job);
        // SAFETY: posting a message to a window handle is always sound; a dead
        // handle makes the call fail.
        let posted = unsafe {
            PostMessageW(Some(hwnd_from(self.hwnd)), WM_APP, WPARAM(0), LPARAM(0))
        };
        if posted.is_err() {
            tracing::warn!("the desktop message loop is not accepting jobs");
        }
        rx
    }

    /// Stop the loop: it unhooks, puts the work area back (when Rulebox
    /// changed it), destroys its window and the thread ends. Blocks until
    /// the thread has joined.
    pub fn stop(mut self) {
        self.shutdown();
    }

    fn shutdown(&mut self) {
        let Some(thread) = self.thread.take() else {
            return;
        };
        // SAFETY: as in `run`. WM_CLOSE makes DefWindowProc destroy the window,
        // which ends the loop through WM_DESTROY.
        let _ = unsafe {
            PostMessageW(Some(hwnd_from(self.hwnd)), WM_CLOSE, WPARAM(0), LPARAM(0))
        };
        if thread.join().is_err() {
            tracing::error!("the desktop message loop thread panicked");
        }
    }
}

impl Drop for MsgLoop {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn hwnd_from(raw: isize) -> HWND {
    HWND(raw as *mut c_void)
}

fn thread_main(state: &WndState, ready: mpsc::Sender<Result<isize>>) {
    match create_window(state) {
        Ok(hwnd) => {
            let _ = ready.send(Ok(hwnd.0 as isize));
            // Session lock/unlock notifications for this session only.
            // SAFETY: hwnd belongs to this thread and stays valid until the
            // loop ends.
            let registered =
                unsafe { WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION) }.is_ok();
            run_loop();
            if registered {
                // SAFETY: matches the registration above.
                let _ = unsafe { WTSUnRegisterSessionNotification(hwnd) };
            }
            // Leave the Windows work area the way we found it.
            if state.mode == ShellMode::Shell {
                if let Err(error) = workarea::restore_saved_work_area() {
                    tracing::warn!(%error, "could not restore the work area");
                }
            }
        }
        Err(error) => {
            let _ = ready.send(Err(error));
        }
    }
}

fn create_window(state: &WndState) -> Result<HWND> {
    // SAFETY: standard class registration and window creation. `state` is
    // borrowed for the whole life of the thread, which outlives the window,
    // so the pointer handed to the window procedure stays valid.
    unsafe {
        let instance = GetModuleHandleW(None).map_err(|e| DesktopError::win32("GetModuleHandleW", &e))?;
        let class = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            lpfnWndProc: Some(wndproc),
            hInstance: instance.into(),
            lpszClassName: CLASS_NAME,
            ..Default::default()
        };
        if RegisterClassExW(&class) == 0 {
            let error = windows::core::Error::from_thread();
            if error.code() != ERROR_CLASS_ALREADY_EXISTS.to_hresult() {
                return Err(DesktopError::win32("RegisterClassExW", &error));
            }
        }
        // Never shown. WS_EX_TOOLWINDOW keeps it out of Alt+Tab regardless.
        CreateWindowExW(
            WS_EX_TOOLWINDOW,
            CLASS_NAME,
            w!("Rulebox shell message window"),
            WS_POPUP,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            0,
            0,
            None,
            None,
            Some(instance.into()),
            Some(state as *const WndState as *const c_void),
        )
        .map_err(|e| DesktopError::win32("CreateWindowExW", &e))
    }
}

fn run_loop() {
    let mut msg = MSG::default();
    // SAFETY: `msg` outlives the calls; GetMessageW returns 0 on WM_QUIT and
    // -1 on error, both of which end the loop.
    unsafe {
        while GetMessageW(&mut msg, None, 0, 0).0 > 0 {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

unsafe extern "system" fn wndproc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if msg == WM_NCCREATE {
        // SAFETY: for WM_NCCREATE lparam points to a CREATESTRUCTW whose
        // lpCreateParams is the WndState pointer given to CreateWindowExW.
        unsafe {
            let create = lparam.0 as *const CREATESTRUCTW;
            let state = (*create).lpCreateParams as *const WndState;
            if !state.is_null() {
                (*state).hwnd.store(hwnd.0 as isize, Ordering::SeqCst);
            }
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, state as isize);
            return DefWindowProcW(hwnd, msg, wparam, lparam);
        }
    }

    // SAFETY: GWLP_USERDATA holds the pointer set above (or 0 before it).
    let state = unsafe { GetWindowLongPtrW(hwnd, GWLP_USERDATA) } as *const WndState;
    if state.is_null() {
        // SAFETY: forwarding an unhandled message.
        return unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) };
    }
    // SAFETY: the pointer is valid for the life of the window (see
    // `create_window`); the procedure only reads through a shared reference.
    let state = unsafe { &*state };

    // Nothing in here may unwind into Windows.
    let handled = catch_unwind(AssertUnwindSafe(|| {
        if msg == WM_APP {
            state.drain_jobs();
            return Some(LRESULT(0));
        }
        if msg == WM_DESTROY {
            // SAFETY: ends this thread's message loop.
            unsafe { PostQuitMessage(0) };
            return Some(LRESULT(0));
        }
        if let Some(event) = map_message(msg, wparam.0) {
            state.send(event);
            if msg == WM_POWERBROADCAST {
                // TRUE: the request is granted / the notice was handled.
                return Some(LRESULT(1));
            }
            if msg == WM_WTSSESSION_CHANGE {
                return Some(LRESULT(0));
            }
        }
        None
    }));

    match handled {
        Ok(Some(result)) => result,
        // SAFETY: forwarding an unhandled message.
        Ok(None) => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
        Err(_) => {
            tracing::error!("the desktop window procedure panicked");
            // SAFETY: as above.
            unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::mpsc::unbounded_channel;
    use windows::Win32::UI::WindowsAndMessaging::WM_DISPLAYCHANGE;

    fn start_dev() -> (MsgLoop, tokio::sync::mpsc::UnboundedReceiver<DesktopEvent>) {
        let (tx, rx) = unbounded_channel();
        let msgloop = MsgLoop::start(ShellMode::Dev, tx).expect("start");
        (msgloop, rx)
    }

    #[test]
    fn jobs_run_on_the_loop_thread() {
        let (msgloop, _rx) = start_dev();
        let main_thread = std::thread::current().id();
        let answer = msgloop
            .run(move |ctx| (std::thread::current().id() != main_thread, ctx.mode))
            .blocking_recv()
            .expect("job result");
        assert_eq!(answer, (true, ShellMode::Dev));
        msgloop.stop();
    }

    #[test]
    fn a_panicking_job_does_not_kill_the_loop() {
        let (msgloop, _rx) = start_dev();
        let failed = msgloop.run(|_| -> u32 { panic!("boom") }).blocking_recv();
        assert!(failed.is_err());
        let ok = msgloop.run(|_| 7u32).blocking_recv().expect("still running");
        assert_eq!(ok, 7);
        msgloop.stop();
    }

    #[test]
    fn broadcast_style_messages_become_events() {
        let (msgloop, mut rx) = start_dev();
        // SAFETY: posting a message to the loop's own window.
        unsafe {
            PostMessageW(
                Some(hwnd_from(msgloop.hwnd())),
                WM_DISPLAYCHANGE,
                WPARAM(0),
                LPARAM(0),
            )
            .expect("post");
        }
        let event = rx.blocking_recv().expect("event");
        assert!(matches!(event, DesktopEvent::DisplayChanged));
        msgloop.stop();
    }

    #[test]
    fn stop_joins_and_later_jobs_report_an_error() {
        let (msgloop, _rx) = start_dev();
        let hwnd = msgloop.hwnd();
        msgloop.stop();
        // The window is gone: posting to it must fail, not hang or crash.
        // SAFETY: as above.
        let posted = unsafe { PostMessageW(Some(hwnd_from(hwnd)), WM_APP, WPARAM(0), LPARAM(0)) };
        assert!(posted.is_err());
    }

    #[test]
    fn two_loops_can_run_at_once() {
        let (a, _ra) = start_dev();
        let (b, _rb) = start_dev();
        assert_ne!(a.hwnd(), b.hwnd());
        a.stop();
        b.stop();
    }
}
