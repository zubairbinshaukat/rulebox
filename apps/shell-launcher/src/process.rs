//! Starting the Staff App and waiting for it (plan Step 12, loop item 3).
//!
//! `CreateProcessW` with the full path as the application name, a quoted command
//! line, the exe's folder as working directory and the launcher's own environment
//! (the Staff user's). No arguments (plan Section 6.9).

use std::path::Path;
use std::sync::OnceLock;

use rulebox_win32::util::{to_wide, OwnedHandle};
use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{HANDLE, WAIT_FAILED};
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows::Win32::System::Threading::{
    CreateProcessW, GetExitCodeProcess, ResumeThread, WaitForSingleObject, CREATE_SUSPENDED, INFINITE,
    PROCESS_INFORMATION, STARTUPINFOW,
};

/// A job object that ends every process in it when its last handle closes.
///
/// The launcher keeps one for its whole life. If the launcher is killed, Windows
/// closes the handle and ends the Staff App (and the web view processes it started)
/// with it, so the launcher the agent starts next never finds a second Staff App
/// running. Found on the VM: without this the old Staff App outlived its launcher.
pub struct KillOnCloseJob(OwnedHandle);

impl KillOnCloseJob {
    pub fn new() -> Option<Self> {
        // SAFETY: no security attributes and no name: a private, unnamed job.
        let job = unsafe { CreateJobObjectW(None, PCWSTR::null()) }.ok()?;
        let job = OwnedHandle::new(job).ok()?;
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // SAFETY: `limits` is a fully initialised structure of the size passed.
        unsafe {
            SetInformationJobObject(
                job.raw(),
                JobObjectExtendedLimitInformation,
                std::ptr::from_ref(&limits).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        }
        .ok()?;
        Some(Self(job))
    }

    /// Puts `process` in the job. `false` if Windows refused (the process then runs
    /// outside the job, as before).
    pub fn assign(&self, process: HANDLE) -> bool {
        // SAFETY: both handles are valid; the job is owned by `self`.
        unsafe { AssignProcessToJobObject(self.0.raw(), process) }.is_ok()
    }
}

/// The launcher's own job, created on first use. `None` when it cannot be made.
fn launcher_job() -> Option<&'static KillOnCloseJob> {
    static JOB: OnceLock<Option<KillOnCloseJob>> = OnceLock::new();
    JOB.get_or_init(KillOnCloseJob::new).as_ref()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunError {
    /// `CreateProcessW` failed with this Win32 error.
    Create(u32),
    /// Waiting for the process, or reading its exit code, failed.
    Wait(u32),
}

/// Maps a `windows` crate error back to the plain Win32 code.
fn win32_code(e: &windows::core::Error) -> u32 {
    let hr = e.code().0 as u32;
    if hr >> 16 == 0x8007 {
        hr & 0xFFFF
    } else {
        hr
    }
}

/// Starts `exe` and blocks until it ends. Returns its exit code.
pub fn run_to_exit(exe: &Path) -> Result<u32, RunError> {
    let app = to_wide(&exe.to_string_lossy());
    // The command line is writable memory (CreateProcessW may modify it).
    let mut command_line = to_wide(&format!("\"{}\"", exe.to_string_lossy()));
    let dir = exe.parent().map(|d| to_wide(&d.to_string_lossy()));

    let startup = STARTUPINFOW { cb: std::mem::size_of::<STARTUPINFOW>() as u32, ..Default::default() };
    let mut info = PROCESS_INFORMATION::default();

    // Created suspended so it is in the job before it can start a child of its own.
    // SAFETY: every pointer refers to a live, NUL-terminated buffer or a struct
    // that outlives the call; the environment and security attributes are null.
    let created = unsafe {
        CreateProcessW(
            PCWSTR(app.as_ptr()),
            Some(PWSTR(command_line.as_mut_ptr())),
            None,
            None,
            false,
            CREATE_SUSPENDED,
            None,
            dir.as_ref().map_or(PCWSTR::null(), |d| PCWSTR(d.as_ptr())),
            &startup,
            &mut info,
        )
    };
    if let Err(e) = created {
        return Err(RunError::Create(win32_code(&e)));
    }

    // Both handles are closed on every path.
    let thread = OwnedHandle::new(info.hThread).ok();
    let process = OwnedHandle::new(info.hProcess).map_err(|_| RunError::Wait(0))?;

    // Best effort: a process Windows will not put in the job still runs.
    if let Some(job) = launcher_job() {
        let _ = job.assign(process.raw());
    }
    if let Some(thread) = &thread {
        // SAFETY: the thread handle belongs to the suspended process created above.
        unsafe { ResumeThread(thread.raw()) };
    }

    // SAFETY: `process` is a valid process handle owned by this function.
    let waited = unsafe { WaitForSingleObject(process.raw(), INFINITE) };
    if waited == WAIT_FAILED {
        return Err(RunError::Wait(last_error()));
    }
    let mut code = 0u32;
    // SAFETY: valid handle; `code` outlives the call.
    unsafe { GetExitCodeProcess(process.raw(), &mut code) }
        .map_err(|e| RunError::Wait(win32_code(&e)))?;
    Ok(code)
}

fn last_error() -> u32 {
    // SAFETY: no preconditions.
    unsafe { windows::Win32::Foundation::GetLastError().0 }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A real start, wait and exit code, with a harmless read-only system program.
    #[test]
    fn a_program_that_ends_gives_its_exit_code() {
        let root = std::env::var_os("SystemRoot").expect("SystemRoot is always set on Windows");
        let exe = std::path::PathBuf::from(root).join("System32").join("whoami.exe");
        assert_eq!(run_to_exit(&exe), Ok(0));
    }

    /// The orphan found on the VM: when the launcher is killed, its Staff App must
    /// end with it. A job whose last handle closes ends every process in it.
    #[test]
    fn a_child_ends_when_the_job_handle_closes() {
        use std::os::windows::io::AsRawHandle;
        use std::process::Stdio;
        use std::time::{Duration, Instant};

        let root = std::env::var_os("SystemRoot").expect("SystemRoot is always set on Windows");
        let ping = std::path::PathBuf::from(root).join("System32").join("ping.exe");
        let mut child = std::process::Command::new(ping)
            .args(["-n", "60", "127.0.0.1"])
            .stdout(Stdio::null())
            .spawn()
            .expect("start ping");

        let job = KillOnCloseJob::new().expect("a job object");
        assert!(job.assign(HANDLE(child.as_raw_handle())), "the job takes the process");
        assert!(child.try_wait().expect("poll").is_none(), "still running while the job is open");

        drop(job);
        let deadline = Instant::now() + Duration::from_secs(5);
        while child.try_wait().expect("poll").is_none() {
            assert!(Instant::now() < deadline, "the child must end when the job handle closes");
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    /// Runs a program that cannot exist: the failure is a clean `Create` error.
    #[test]
    fn a_missing_exe_is_a_create_error() {
        let path = std::env::temp_dir().join("rulebox-shell-test-no-such-program.exe");
        match run_to_exit(&path) {
            Err(RunError::Create(code)) => assert!(code == 2 || code == 3, "unexpected code {code}"),
            other => panic!("expected a Create error, got {other:?}"),
        }
    }
}
