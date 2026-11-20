//! (Phase 4 Step 14, review fix) A job object for one installer run: the
//! installer and every process it starts (setup.tmp, Burn children, ...) are in
//! it, so a timeout or a service stop ends the whole tree, and the job is closed
//! with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, so a crash of the agent ends it too.
//!
//! The process is started suspended by the caller (`CREATE_SUSPENDED`), put in the
//! job, then resumed with [`resume_process`]: it cannot start a child before it
//! is in the job. Same pattern as the shell launcher's job (Phase 2 / Step 12),
//! which lives in that binary; this one adds the queries the agent needs.
//!
//! Not guarded: creating a private job and ending the processes the caller itself
//! started changes nothing else on the machine (the caller, `run_installer`, is
//! guarded before it starts anything).

use std::os::windows::io::{AsRawHandle, BorrowedHandle};

use windows::core::{BOOL, PCWSTR};
use windows::Win32::Foundation::{HANDLE, HWND, LPARAM};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
};
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicAccountingInformation, JobObjectBasicProcessIdList,
    JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject, TerminateJobObject,
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOBOBJECT_BASIC_PROCESS_ID_LIST, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows::Win32::System::Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME};
use windows::Win32::UI::WindowsAndMessaging::{EnumWindows, GetWindowThreadProcessId, IsWindowVisible};

/// The most process ids [`KillOnCloseJob::process_ids`] lists (an installer's tree is a handful of processes).
pub const MAX_LISTED_PROCESSES: usize = 256;

use crate::error::{api_err, Result, Win32Error};
use crate::util::OwnedHandle;

/// A private, unnamed job that ends every process in it when its handle closes.
pub struct KillOnCloseJob(OwnedHandle);

impl KillOnCloseJob {
    pub fn new() -> Result<Self> {
        // SAFETY: no security attributes and no name: a private, unnamed job.
        let job = unsafe { CreateJobObjectW(None, PCWSTR::null()) }.map_err(|e| api_err("CreateJobObjectW", &e))?;
        let job = OwnedHandle::new(job)?;
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
        .map_err(|e| api_err("SetInformationJobObject", &e))?;
        Ok(Self(job))
    }

    /// Puts `process` (for example `std::process::Child::as_handle()`) in the job.
    pub fn assign(&self, process: BorrowedHandle<'_>) -> Result<()> {
        // SAFETY: both handles are valid for the call; the job is owned by `self`
        // and `process` is borrowed from a live owner.
        unsafe { AssignProcessToJobObject(self.0.raw(), HANDLE(process.as_raw_handle())) }
            .map_err(|e| api_err("AssignProcessToJobObject", &e))
    }

    /// How many processes in the job are still running.
    pub fn active_processes(&self) -> Result<u32> {
        let mut info = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
        // SAFETY: `info` is a writable structure of the size passed.
        unsafe {
            QueryInformationJobObject(
                Some(self.0.raw()),
                JobObjectBasicAccountingInformation,
                std::ptr::from_mut(&mut info).cast(),
                std::mem::size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                None,
            )
        }
        .map_err(|e| api_err("QueryInformationJobObject", &e))?;
        Ok(info.ActiveProcesses)
    }

    /// (Phase 6 Step 14) The CPU time (user + kernel) every process of the job has used so far, ended ones included
    /// (the job's own accounting). Read-only.
    pub fn cpu_time(&self) -> Result<std::time::Duration> {
        let mut info = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
        // SAFETY: `info` is a writable structure of the size passed.
        unsafe {
            QueryInformationJobObject(
                Some(self.0.raw()),
                JobObjectBasicAccountingInformation,
                std::ptr::from_mut(&mut info).cast(),
                std::mem::size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                None,
            )
        }
        .map_err(|e| api_err("QueryInformationJobObject", &e))?;
        // The times are in 100 ns units.
        let ticks = info.TotalUserTime.saturating_add(info.TotalKernelTime).max(0) as u64;
        Ok(std::time::Duration::from_nanos(ticks.saturating_mul(100)))
    }

    /// (Phase 6 Step 14) The ids of the processes of the job that still run (at most [`MAX_LISTED_PROCESSES`]).
    pub fn process_ids(&self) -> Result<Vec<u32>> {
        // The list is a header of two `u32` and then one `usize` per process; a `usize` buffer has the alignment of it.
        let mut buffer = vec![0usize; 1 + MAX_LISTED_PROCESSES];
        // SAFETY: `buffer` is writable for the size passed and aligned for the structure.
        unsafe {
            QueryInformationJobObject(
                Some(self.0.raw()),
                JobObjectBasicProcessIdList,
                buffer.as_mut_ptr().cast(),
                (buffer.len() * std::mem::size_of::<usize>()) as u32,
                None,
            )
        }
        .map_err(|e| api_err("QueryInformationJobObject", &e))?;
        // SAFETY: the call filled the header; the buffer is at least as large as the structure.
        let listed = unsafe { (*buffer.as_ptr().cast::<JOBOBJECT_BASIC_PROCESS_ID_LIST>()).NumberOfProcessIdsInList } as usize;
        Ok(buffer[1..].iter().take(listed.min(MAX_LISTED_PROCESSES)).map(|id| *id as u32).collect())
    }

    /// (Phase 6 Step 14, plan 4.6 "Timeout") Whether a process of the job owns a **visible** top-level window on the
    /// desktop of the calling thread. The agent is a service, so that is the service desktop: a window there is an
    /// installer waiting for somebody to click, and nobody can (the Staff session never sees it). Read-only.
    pub fn has_visible_window(&self) -> Result<bool> {
        let pids = self.process_ids()?;
        if pids.is_empty() {
            return Ok(false);
        }
        struct Search {
            pids: Vec<u32>,
            found: bool,
        }
        unsafe extern "system" fn each(window: HWND, lparam: LPARAM) -> BOOL {
            // SAFETY: `lparam` is the `Search` below, alive and not shared while `EnumWindows` runs.
            let search = unsafe { &mut *(lparam.0 as *mut Search) };
            // SAFETY: plain queries on a window handle the system just gave this callback.
            if unsafe { IsWindowVisible(window) }.as_bool() {
                let mut pid = 0u32;
                // SAFETY: `pid` is writable.
                unsafe { GetWindowThreadProcessId(window, Some(&mut pid)) };
                if search.pids.contains(&pid) {
                    search.found = true;
                    return BOOL(0);
                }
            }
            BOOL(1)
        }
        let mut search = Search { pids, found: false };
        // SAFETY: the callback only touches `search`, which outlives the call. `EnumWindows` reports an error when the
        // callback stops the walk early; that is the "found" case, so the result is not looked at.
        let _ = unsafe { EnumWindows(Some(each), LPARAM(std::ptr::from_mut(&mut search) as isize)) };
        Ok(search.found)
    }

    /// Ends every process in the job (asynchronously: poll `active_processes`).
    pub fn terminate(&self, exit_code: u32) -> Result<()> {
        // SAFETY: the job handle is valid and owned by `self`.
        unsafe { TerminateJobObject(self.0.raw(), exit_code) }.map_err(|e| api_err("TerminateJobObject", &e))
    }
}

/// Resumes the threads of `pid`, a process the caller created with
/// `CREATE_SUSPENDED` (it has exactly one thread then). Fails when no thread of
/// `pid` was resumed.
pub fn resume_process(pid: u32) -> Result<()> {
    // SAFETY: a snapshot of all threads; the handle is owned by the guard below.
    let snapshot =
        unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) }.map_err(|e| api_err("CreateToolhelp32Snapshot", &e))?;
    let snapshot = OwnedHandle::new(snapshot)?;
    let mut entry = THREADENTRY32 { dwSize: std::mem::size_of::<THREADENTRY32>() as u32, ..Default::default() };
    let mut resumed = 0u32;
    // SAFETY: `entry` has its size set; `snapshot` is a valid snapshot handle.
    let mut more = unsafe { Thread32First(snapshot.raw(), &mut entry) }.is_ok();
    while more {
        if entry.th32OwnerProcessID == pid {
            // SAFETY: a plain open by id; the handle is owned by the guard.
            let thread = unsafe { OpenThread(THREAD_SUSPEND_RESUME, false, entry.th32ThreadID) }
                .map_err(|e| api_err("OpenThread", &e))?;
            let thread = OwnedHandle::new(thread)?;
            // SAFETY: a valid thread handle with THREAD_SUSPEND_RESUME access.
            if unsafe { ResumeThread(thread.raw()) } != u32::MAX {
                resumed += 1;
            }
        }
        // SAFETY: as above.
        more = unsafe { Thread32Next(snapshot.raw(), &mut entry) }.is_ok();
    }
    if resumed == 0 {
        return Err(Win32Error::Invalid(format!("no thread of process {pid} was resumed")));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::windows::io::AsHandle;
    use std::os::windows::process::CommandExt;
    use std::process::{Child, Command, Stdio};
    use std::time::{Duration, Instant};

    const CREATE_SUSPENDED: u32 = 0x0000_0004;

    fn ping(suspended: bool) -> Child {
        let root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
        let ping = std::path::PathBuf::from(root).join("System32").join("ping.exe");
        let mut command = Command::new(ping);
        command.args(["-n", "60", "127.0.0.1"]).stdout(Stdio::null()).stderr(Stdio::null());
        if suspended {
            command.creation_flags(CREATE_SUSPENDED);
        }
        command.spawn().unwrap()
    }

    fn wait_gone(child: &mut Child) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while child.try_wait().unwrap().is_none() {
            assert!(Instant::now() < deadline, "the process must end");
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    #[test]
    fn terminate_ends_every_process_in_the_job() {
        let job = KillOnCloseJob::new().unwrap();
        // Started suspended, put in the job, then resumed (the installer's order).
        let mut first = ping(true);
        job.assign(first.as_handle()).unwrap();
        resume_process(first.id()).unwrap();
        let mut second = ping(false);
        job.assign(second.as_handle()).unwrap();
        assert_eq!(job.active_processes().unwrap(), 2);
        job.terminate(1).unwrap();
        wait_gone(&mut first);
        wait_gone(&mut second);
        let deadline = Instant::now() + Duration::from_secs(10);
        while job.active_processes().unwrap() != 0 {
            assert!(Instant::now() < deadline, "the job must become empty");
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    #[test]
    fn the_job_lists_its_processes_and_its_cpu_time_and_a_console_process_has_no_window() {
        let job = KillOnCloseJob::new().unwrap();
        assert!(job.process_ids().unwrap().is_empty());
        assert!(!job.has_visible_window().unwrap());
        let mut child = ping(true);
        job.assign(child.as_handle()).unwrap();
        assert_eq!(job.process_ids().unwrap(), [child.id()]);
        assert!(job.cpu_time().unwrap() < Duration::from_secs(60));
        assert!(!job.has_visible_window().unwrap(), "a suspended console program shows no window");
        job.terminate(1).unwrap();
        wait_gone(&mut child);
    }

    #[test]
    fn closing_the_job_ends_its_processes() {
        let job = KillOnCloseJob::new().unwrap();
        let mut child = ping(false);
        job.assign(child.as_handle()).unwrap();
        assert!(child.try_wait().unwrap().is_none());
        drop(job);
        wait_gone(&mut child);
    }

    #[test]
    fn resuming_a_process_that_is_not_there_fails() {
        // Process ids are multiples of 4; 3 is never one.
        assert!(resume_process(3).is_err());
    }
}
