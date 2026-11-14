//! The process-start trace behind the L5 watchdog (plan 4.5, 4.10, Step 8).
//!
//! One real-time Event Tracing for Windows session, `RuleboxProcWatch`, on the provider
//! `Microsoft-Windows-Kernel-Process` with the process keyword only. A dedicated thread
//! consumes it (`ProcessTrace` blocks in the kernel, no polling); each process-start event
//! (event id 1) becomes a [`ProcessStart`] and goes to the caller's sink, which must be quick
//! (the watchdog only queues the event). The event carries process and parent ids, the session
//! and the image name; never a command line (plan rule 6).
//!
//! Starting a session is a system change, so [`start_trace`] and [`stop_trace`] are guarded and
//! start with the test-machine check. Memory: 4 buffers of 64 KB (plan Section 14) and one
//! thread with a 256 KB stack. If the session cannot start (the 64-session limit, a missing
//! privilege) the caller gets the error and falls back to a snapshot diff (edge case 44);
//! [`trace_stats`] tells how many events the kernel dropped (edge case 45).
//!
//! The field layout of the event is **unverified** on build 26300 and on Windows 10 22H2 (plan
//! Section 21): the parser reads the stable prefix (process id, create time, parent id, session
//! id) and finds the image name by plausibility at either of the known offsets, and the watchdog
//! only trusts the process id: it reads the image and owner itself with `process::process_info`.

use std::ffi::c_void;
use std::path::PathBuf;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::thread::JoinHandle;
use std::time::Duration;

use windows::core::{GUID, PCWSTR, PWSTR};
use windows::Win32::Foundation::WIN32_ERROR;
use windows::Win32::System::Diagnostics::Etw::{
    CloseTrace, ControlTraceW, OpenTraceW, ProcessTrace, StartTraceW, CONTROLTRACE_HANDLE,
    EVENT_CONTROL_CODE_ENABLE_PROVIDER, EVENT_RECORD, EVENT_TRACE_CONTROL_QUERY, EVENT_TRACE_CONTROL_STOP, EVENT_TRACE_LOGFILEW, EVENT_TRACE_PROPERTIES, EVENT_TRACE_REAL_TIME_MODE,
    PROCESSTRACE_HANDLE, PROCESS_TRACE_MODE_EVENT_RECORD, PROCESS_TRACE_MODE_REAL_TIME, TRACE_LEVEL_INFORMATION,
    WNODE_FLAG_TRACED_GUID,
};

use crate::error::{code_err, Result, Win32Error};
use crate::guard::require_test_machine;
use crate::util::to_wide;

/// One process start. No command line, no window title (Phase 5 rule 6).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessStart {
    pub pid: u32,
    pub parent_pid: u32,
    pub session_id: u32,
    /// The image name as the trace reports it: a device path (`\Device\HarddiskVolume3\...`), a
    /// Win32 path or empty. Treat it as a hint only; the watchdog reads the image from the process.
    pub image: PathBuf,
}

/// Where the trace delivers events: called on the trace's own thread.
pub type ProcessSink = Box<dyn Fn(ProcessStart) + Send + Sync + 'static>;

/// A running trace session.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TraceHandle(pub u64);

/// What the kernel reports about the session's losses (edge case 45).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TraceStats {
    pub events_lost: u64,
    pub buffers_lost: u64,
}

/// The session's name. Fixed, so a session left behind by a crashed agent is found and stopped.
pub const SESSION_NAME: &str = "RuleboxProcWatch";
/// `Microsoft-Windows-Kernel-Process`.
const KERNEL_PROCESS: GUID = GUID::from_u128(0x22fb2cd6_0e7b_422b_a0c7_2fad1fd0e716);
/// `WINEVENT_KEYWORD_PROCESS`: process start and stop, nothing else.
const KEYWORD_PROCESS: u64 = 0x10;
/// Event id 1: a process started.
const EVENT_PROCESS_START: u16 = 1;
/// 4 buffers of 64 KB (plan Section 14).
const BUFFER_KB: u32 = 64;
const BUFFER_COUNT: u32 = 4;

const ERROR_ALREADY_EXISTS: u32 = 183;
const ERROR_WMI_INSTANCE_NOT_FOUND: u32 = 4201;
/// How long `start_trace` waits for the consumer thread to open the session.
const OPEN_TIMEOUT: Duration = Duration::from_secs(5);
/// How long `stop_trace` waits for the consumer thread to end, in two steps.
const STOP_TIMEOUT: Duration = Duration::from_secs(5);

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The sink the event callback calls, kept alive until the consumer thread has ended.
struct Context {
    sink: ProcessSink,
}

struct Session {
    id: u64,
    /// The ETW session handle (`StartTrace`).
    control: u64,
    /// The consumer handle (`OpenTrace`), for the last-resort `CloseTrace`.
    consumer: u64,
    thread: Option<JoinHandle<()>>,
    /// Sent by the consumer thread when `ProcessTrace` has returned.
    done: mpsc::Receiver<()>,
    /// The `Box<Context>` as a raw address; freed only after the thread ended.
    context: usize,
}

static SESSIONS: Mutex<Vec<Session>> = Mutex::new(Vec::new());
static NEXT_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

// -- the properties buffer -------------------------------------------------------------------

/// An `EVENT_TRACE_PROPERTIES` followed by room for the session name, 8-byte aligned.
struct Properties {
    buffer: Vec<u64>,
}

impl Properties {
    fn new() -> Self {
        let name_bytes = (SESSION_NAME.len() + 1) * 2;
        let total = std::mem::size_of::<EVENT_TRACE_PROPERTIES>() + name_bytes;
        let mut properties = Self { buffer: vec![0u64; total.div_ceil(8)] };
        let total_bytes = (properties.buffer.len() * 8) as u32;
        let header = properties.header();
        header.Wnode.BufferSize = total_bytes;
        header.Wnode.Flags = WNODE_FLAG_TRACED_GUID;
        // 1: timestamps from the performance counter.
        header.Wnode.ClientContext = 1;
        header.BufferSize = BUFFER_KB;
        header.MinimumBuffers = BUFFER_COUNT;
        header.MaximumBuffers = BUFFER_COUNT;
        header.LogFileMode = EVENT_TRACE_REAL_TIME_MODE;
        // Flush a partly filled buffer every second so an event is not held back for long.
        header.FlushTimer = 1;
        header.LoggerNameOffset = std::mem::size_of::<EVENT_TRACE_PROPERTIES>() as u32;
        properties
    }

    fn header(&mut self) -> &mut EVENT_TRACE_PROPERTIES {
        // SAFETY: the buffer is at least `size_of::<EVENT_TRACE_PROPERTIES>()` bytes, 8-byte
        // aligned (a `Vec<u64>`), zero-initialised, and owned by `self` for the borrow's life.
        unsafe { &mut *self.buffer.as_mut_ptr().cast::<EVENT_TRACE_PROPERTIES>() }
    }

    fn as_ptr(&mut self) -> *mut EVENT_TRACE_PROPERTIES {
        self.buffer.as_mut_ptr().cast()
    }
}

fn status(api: &'static str, error: WIN32_ERROR) -> Result<()> {
    if error.0 == 0 {
        Ok(())
    } else {
        Err(code_err(api, error.0))
    }
}

/// Stops a session by handle or by name. A session that is not there is fine.
fn control_stop(control: u64, by_name: bool) -> Result<()> {
    let mut properties = Properties::new();
    let name = to_wide(SESSION_NAME);
    let instance = if by_name { PCWSTR(name.as_ptr()) } else { PCWSTR::null() };
    // SAFETY: `properties` is a valid buffer with room for the name; `name` is NUL-terminated and
    // outlives the call; with a handle of 0 the name is used, otherwise the handle is.
    let error = unsafe {
        ControlTraceW(CONTROLTRACE_HANDLE { Value: control }, instance, properties.as_ptr(), EVENT_TRACE_CONTROL_STOP)
    };
    match error.0 {
        0 | ERROR_WMI_INSTANCE_NOT_FOUND => Ok(()),
        code => Err(code_err("ControlTraceW", code)),
    }
}

// -- the event ------------------------------------------------------------------------------

fn u32_at(data: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(data.get(at..at + 4)?.try_into().ok()?))
}

/// A NUL-terminated UTF-16 string at `at`, if it is one that looks like an image path: it starts
/// with `\` (a device or UNC path) or a drive letter and a colon, and has no control characters.
/// Starting the check at the right place matters: read two characters off, a path still looks
/// like text.
fn image_at(data: &[u8], at: usize) -> Option<String> {
    let bytes = data.get(at..)?;
    let units: Vec<u16> = bytes.as_chunks::<2>().0.iter().map(|pair| u16::from_le_bytes(*pair)).collect();
    let end = units.iter().position(|unit| *unit == 0)?;
    let text = String::from_utf16(&units[..end]).ok()?;
    let mut chars = text.chars();
    let starts_like_a_path = match (chars.next(), chars.next()) {
        (Some('\\'), _) => true,
        (Some(letter), Some(':')) => letter.is_ascii_alphabetic(),
        _ => false,
    };
    (starts_like_a_path && text.chars().all(|c| !c.is_control())).then_some(text)
}

/// Reads the user data of a `Microsoft-Windows-Kernel-Process` process-start event.
///
/// Stable prefix (all versions): process id (4), create time (8), parent id (4), session id (4).
/// The image name follows directly (older versions) or after a 4-byte flags field (newer ones);
/// the version picks the first offset to try and the other is the fallback. Returns `None` for
/// data too short to hold the prefix.
pub(crate) fn parse_process_start(version: u8, data: &[u8]) -> Option<ProcessStart> {
    let pid = u32_at(data, 0)?;
    let parent_pid = u32_at(data, 12)?;
    let session_id = u32_at(data, 16)?;
    let offsets: [usize; 2] = if version >= 1 { [24, 20] } else { [20, 24] };
    let image = offsets.iter().find_map(|at| image_at(data, *at)).unwrap_or_default();
    Some(ProcessStart { pid, parent_pid, session_id, image: PathBuf::from(image) })
}

/// The `EventRecordCallback`. It runs on the consumer thread, must not unwind into the system
/// and must be quick.
unsafe extern "system" fn on_event(record: *mut EVENT_RECORD) {
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        // SAFETY: the system passes a valid record for the duration of the call, or null.
        let Some(record) = (unsafe { record.as_ref() }) else {
            return;
        };
        let descriptor = &record.EventHeader.EventDescriptor;
        if record.EventHeader.ProviderId != KERNEL_PROCESS || descriptor.Id != EVENT_PROCESS_START {
            return;
        }
        if record.UserData.is_null() || record.UserContext.is_null() {
            return;
        }
        // SAFETY: `UserData` points to `UserDataLength` readable bytes for this call.
        let data = unsafe { std::slice::from_raw_parts(record.UserData.cast::<u8>(), usize::from(record.UserDataLength)) };
        let Some(event) = parse_process_start(descriptor.Version, data) else {
            return;
        };
        // SAFETY: `UserContext` is the `Context` passed to `OpenTrace`; it is freed only after the
        // consumer thread (this one) has ended.
        let context = unsafe { &*record.UserContext.cast::<Context>() };
        (context.sink)(event);
    }));
}

// -- start and stop -------------------------------------------------------------------------

/// Starts the session (stopping a left-over one with the same name first), enables the provider
/// and starts the consumer thread. The consumer reports back over `ready` and then blocks in
/// `ProcessTrace` until the session is stopped.
fn open_session(context: usize, ready: &mpsc::Sender<Result<u64>>, done: &mpsc::Sender<()>) {
    let mut name = to_wide(SESSION_NAME);
    // SAFETY: an all-zero `EVENT_TRACE_LOGFILEW` is a valid empty value (null pointers, no callbacks).
    let mut logfile: EVENT_TRACE_LOGFILEW = unsafe { std::mem::zeroed() };
    logfile.LoggerName = PWSTR(name.as_mut_ptr());
    logfile.Anonymous1.ProcessTraceMode = PROCESS_TRACE_MODE_REAL_TIME | PROCESS_TRACE_MODE_EVENT_RECORD;
    logfile.Anonymous2.EventRecordCallback = Some(on_event);
    logfile.Context = context as *mut c_void;
    // SAFETY: `logfile` is fully set up and stays alive (on this stack) while the trace is processed.
    let consumer = unsafe { OpenTraceW(&mut logfile) };
    if consumer.Value == u64::MAX {
        // SAFETY: reads the calling thread's last error; no arguments.
        let code = unsafe { windows::Win32::Foundation::GetLastError() }.0;
        let _ = ready.send(Err(code_err("OpenTraceW", code)));
        let _ = done.send(());
        return;
    }
    let _ = ready.send(Ok(consumer.Value));
    // SAFETY: `consumer` was just opened; this call blocks until the session stops or the
    // consumer handle is closed, delivering events to `on_event`.
    let _ = unsafe { ProcessTrace(&[PROCESSTRACE_HANDLE { Value: consumer.Value }], None, None) };
    // SAFETY: closing the consumer handle opened above; a second close after `stop_trace`'s
    // last-resort close only returns an error.
    let _ = unsafe { CloseTrace(consumer) };
    let _ = done.send(());
}

fn start_session() -> Result<u64> {
    let mut properties = Properties::new();
    let name = to_wide(SESSION_NAME);
    let mut handle = CONTROLTRACE_HANDLE::default();
    for attempt in 0..2 {
        // SAFETY: `handle` and `properties` are valid; `name` is NUL-terminated.
        let error = unsafe { StartTraceW(&mut handle, PCWSTR(name.as_ptr()), properties.as_ptr()) };
        match error.0 {
            0 => return Ok(handle.Value),
            // A session of this name is left from a crashed agent: stop it and try once more.
            ERROR_ALREADY_EXISTS if attempt == 0 => {
                control_stop(0, true)?;
                properties = Properties::new();
            }
            code => return Err(code_err("StartTraceW", code)),
        }
    }
    Err(code_err("StartTraceW", ERROR_ALREADY_EXISTS))
}

/// Starts the process trace and delivers each start to `sink`. One trace at a time.
///
/// DESTRUCTIVE: guarded.
pub fn start_trace(sink: ProcessSink) -> Result<TraceHandle> {
    require_test_machine()?;
    let mut sessions = lock(&SESSIONS);
    if !sessions.is_empty() {
        return Err(Win32Error::AlreadyExists);
    }
    let control = start_session()?;
    if let Err(error) = enable_provider(control) {
        let _ = control_stop(control, false);
        return Err(error);
    }

    let context = Box::into_raw(Box::new(Context { sink })) as usize;
    let (ready_tx, ready_rx) = mpsc::channel();
    let (done_tx, done_rx) = mpsc::channel();
    let spawned = std::thread::Builder::new()
        .name("rulebox-etw".into())
        .stack_size(256 * 1024)
        .spawn(move || open_session(context, &ready_tx, &done_tx));
    let thread = match spawned {
        Ok(thread) => thread,
        Err(_) => {
            let _ = control_stop(control, false);
            // SAFETY: the thread never started, so nothing else holds the context.
            drop(unsafe { Box::from_raw(context as *mut Context) });
            return Err(Win32Error::Invalid("the trace thread could not start".into()));
        }
    };
    let consumer = match ready_rx.recv_timeout(OPEN_TIMEOUT) {
        Ok(Ok(consumer)) => consumer,
        failed => {
            let _ = control_stop(control, false);
            let ended = done_rx.recv_timeout(STOP_TIMEOUT).is_ok();
            if ended {
                let _ = thread.join();
                // SAFETY: the consumer thread has ended, so nothing uses the context any more.
                drop(unsafe { Box::from_raw(context as *mut Context) });
            }
            return Err(match failed {
                Ok(Err(error)) => error,
                _ => Win32Error::Invalid("the trace did not open".into()),
            });
        }
    };
    let id = NEXT_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    sessions.push(Session { id, control, consumer, thread: Some(thread), done: done_rx, context });
    Ok(TraceHandle(id))
}

/// Enables the process keyword of the kernel process provider on the session.
fn enable_provider(control: u64) -> Result<()> {
    // SAFETY: `control` is the handle `StartTraceW` returned; the provider id is a constant.
    let error = unsafe {
        windows::Win32::System::Diagnostics::Etw::EnableTraceEx2(
            CONTROLTRACE_HANDLE { Value: control },
            &KERNEL_PROCESS,
            EVENT_CONTROL_CODE_ENABLE_PROVIDER.0,
            TRACE_LEVEL_INFORMATION as u8,
            KEYWORD_PROCESS,
            0,
            0,
            None,
        )
    };
    status("EnableTraceEx2", error)
}

/// Stops a trace (one that has already ended is fine) and waits for its thread.
///
/// DESTRUCTIVE: guarded.
pub fn stop_trace(handle: TraceHandle) -> Result<()> {
    require_test_machine()?;
    let session = {
        let mut sessions = lock(&SESSIONS);
        match sessions.iter().position(|s| s.id == handle.0) {
            Some(index) => sessions.remove(index),
            None => return Ok(()),
        }
    };
    let stopped = control_stop(session.control, false);
    let mut ended = session.done.recv_timeout(STOP_TIMEOUT).is_ok();
    if !ended {
        // Last resort: closing the consumer handle ends `ProcessTrace`.
        // SAFETY: the handle is the one `OpenTraceW` returned; an error here is ignored.
        let _ = unsafe { CloseTrace(PROCESSTRACE_HANDLE { Value: session.consumer }) };
        ended = match session.done.recv_timeout(STOP_TIMEOUT) {
            Ok(()) => true,
            Err(RecvTimeoutError::Disconnected) => true,
            Err(RecvTimeoutError::Timeout) => false,
        };
    }
    if ended {
        if let Some(thread) = session.thread {
            let _ = thread.join();
        }
        // SAFETY: the consumer thread has ended, so nothing uses the context any more.
        drop(unsafe { Box::from_raw(session.context as *mut Context) });
        stopped
    } else {
        // The thread is stuck inside the system: leave the context allocated (a small leak) rather
        // than free memory it may still read.
        Err(Win32Error::Invalid("the trace thread did not stop".into()))
    }
}

/// How many events and buffers the kernel dropped on the running session. Read-only.
pub fn trace_stats(handle: TraceHandle) -> Result<TraceStats> {
    let control = {
        let sessions = lock(&SESSIONS);
        sessions.iter().find(|s| s.id == handle.0).map(|s| s.control).ok_or(Win32Error::NotFound)?
    };
    let mut properties = Properties::new();
    // SAFETY: `properties` is a valid buffer; the handle is a live session's.
    let error = unsafe {
        ControlTraceW(
            CONTROLTRACE_HANDLE { Value: control },
            PCWSTR::null(),
            properties.as_ptr(),
            EVENT_TRACE_CONTROL_QUERY,
        )
    };
    status("ControlTraceW", error)?;
    let header = properties.header();
    Ok(TraceStats {
        events_lost: u64::from(header.EventsLost),
        buffers_lost: u64::from(header.RealTimeBuffersLost) + u64::from(header.LogBuffersLost),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wide(text: &str) -> Vec<u8> {
        text.encode_utf16().chain(std::iter::once(0)).flat_map(u16::to_le_bytes).collect()
    }

    fn event(flags: bool, image: &str) -> Vec<u8> {
        let mut data = Vec::new();
        data.extend_from_slice(&4321u32.to_le_bytes());
        data.extend_from_slice(&0x01d8_0000_0000_0000u64.to_le_bytes());
        data.extend_from_slice(&1000u32.to_le_bytes());
        data.extend_from_slice(&2u32.to_le_bytes());
        if flags {
            data.extend_from_slice(&0u32.to_le_bytes());
        }
        data.extend_from_slice(&wide(image));
        // Fields after the image name (checksum, time stamp) must not matter.
        data.extend_from_slice(&[0xAA; 12]);
        data
    }

    #[test]
    fn both_known_layouts_give_the_same_event() {
        let image = r"\Device\HarddiskVolume3\Windows\System32\notepad.exe";
        for (version, flags) in [(0u8, false), (1, false), (2, true), (3, true), (4, true)] {
            let parsed = parse_process_start(version, &event(flags, image)).unwrap();
            assert_eq!((parsed.pid, parsed.parent_pid, parsed.session_id), (4321, 1000, 2), "v{version}");
            assert_eq!(parsed.image, PathBuf::from(image), "v{version} flags={flags}");
        }
    }

    #[test]
    fn a_layout_that_is_not_known_still_gives_the_ids_and_an_empty_image() {
        let mut data = event(true, "x");
        // Replace the image by garbage: control characters, no terminator.
        data.truncate(20);
        data.extend_from_slice(&[1, 0, 2, 0, 3, 0, 4, 0]);
        let parsed = parse_process_start(3, &data).unwrap();
        assert_eq!(parsed.pid, 4321);
        assert_eq!(parsed.image, PathBuf::new());
    }

    #[test]
    fn data_shorter_than_the_prefix_is_ignored() {
        assert_eq!(parse_process_start(3, &[0u8; 19]), None);
        assert_eq!(parse_process_start(3, &[]), None);
    }

    #[test]
    fn the_properties_buffer_holds_the_header_and_the_name_and_asks_for_four_64_kb_buffers() {
        let mut properties = Properties::new();
        let total = properties.buffer.len() * 8;
        let header = properties.header();
        assert_eq!((header.BufferSize, header.MinimumBuffers, header.MaximumBuffers), (64, 4, 4));
        assert_eq!(header.LogFileMode, EVENT_TRACE_REAL_TIME_MODE);
        assert_eq!(header.Wnode.BufferSize as usize, total);
        assert!(total >= header.LoggerNameOffset as usize + (SESSION_NAME.len() + 1) * 2);
    }

    #[test]
    fn both_calls_meet_the_guard_first_on_the_dev_machine() {
        if crate::guard::is_test_machine() {
            return;
        }
        assert!(matches!(start_trace(Box::new(|_| {})), Err(Win32Error::Guard(_))));
        assert!(matches!(stop_trace(TraceHandle(1)), Err(Win32Error::Guard(_))));
    }

    #[test]
    fn stats_of_a_trace_that_is_not_running_are_not_found() {
        assert!(matches!(trace_stats(TraceHandle(99)), Err(Win32Error::NotFound)));
    }
}
