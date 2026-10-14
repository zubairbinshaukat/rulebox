//! Start a program as the Staff user and keep track of it with a job object
//! (plan Step 8).
//!
//! The job has **no** kill-on-close limit: it is for knowing which processes
//! belong to a launched app and for deliberate clean-up at log out. A job
//! handle going away leaves the processes running.

use std::ffi::c_void;
use std::mem::size_of;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;

use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, ERROR_ELEVATION_REQUIRED, HANDLE};
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicProcessIdList,
    QueryInformationJobObject, TerminateJobObject,
};
use windows::Win32::System::Threading::{
    CreateProcessW, ResumeThread, TerminateProcess, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT,
    PROCESS_INFORMATION, STARTUPINFOW,
};

use crate::error::{DesktopError, Result};

/// Owns a job object handle. Dropping it closes the handle only.
pub struct JobHandle(HANDLE);

// SAFETY: a job handle is a kernel handle usable from any thread; this type
// only calls thread-safe job APIs on it.
unsafe impl Send for JobHandle {}
// SAFETY: as above; no interior state.
unsafe impl Sync for JobHandle {}

impl Drop for JobHandle {
    fn drop(&mut self) {
        // SAFETY: the handle is owned by this value and closed exactly once.
        let _ = unsafe { CloseHandle(self.0) };
    }
}

/// A program the shell started.
pub struct Launched {
    pub pid: u32,
    pub job: JobHandle,
}

/// One command-line argument, quoted the way `CommandLineToArgvW` reads it.
pub fn quote_arg(arg: &str) -> String {
    let needs_quotes = arg.is_empty() || arg.chars().any(|c| matches!(c, ' ' | '\t' | '\n' | '"'));
    if !needs_quotes {
        return arg.to_string();
    }
    let mut out = String::with_capacity(arg.len() + 2);
    out.push('"');
    let mut backslashes = 0usize;
    for c in arg.chars() {
        match c {
            '\\' => backslashes += 1,
            '"' => {
                // Backslashes before a quote are doubled, then the quote escaped.
                out.extend(std::iter::repeat_n('\\', backslashes * 2 + 1));
                out.push('"');
                backslashes = 0;
            }
            _ => {
                out.extend(std::iter::repeat_n('\\', backslashes));
                backslashes = 0;
                out.push(c);
            }
        }
    }
    // Backslashes before the closing quote are doubled so they stay literal.
    out.extend(std::iter::repeat_n('\\', backslashes * 2));
    out.push('"');
    out
}

/// The full command line: the quoted program path, then each argument.
pub fn build_command_line(exe: &Path, args: &[String]) -> String {
    let mut line = quote_arg(&exe.to_string_lossy());
    for arg in args {
        line.push(' ');
        line.push_str(&quote_arg(arg));
    }
    line
}

/// Why a program path is refused before anything is started. Pure, so the
/// rules are tested without files.
pub fn check_launch_path(exe: &Path) -> std::result::Result<(), &'static str> {
    if !exe.is_absolute() {
        return Err("the program path is not absolute");
    }
    let extension = exe
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    if matches!(extension.as_str(), "bat" | "cmd") {
        return Err("scripts are not started from here");
    }
    Ok(())
}

fn wide(text: &std::ffi::OsStr) -> Vec<u16> {
    text.encode_wide().chain(std::iter::once(0)).collect()
}

/// Start `exe` suspended, put it in a new job, then let it run. The current
/// directory is the program's own folder. Error 740 (needs elevation) is
/// returned as [`DesktopError::NeedsElevation`] and is **never** retried
/// elevated.
pub fn launch(exe: &Path, args: &[String]) -> Result<Launched> {
    check_launch_path(exe).map_err(|reason| DesktopError::Refused(reason.into()))?;
    if !exe.is_file() {
        return Err(DesktopError::Refused("the program was not found".into()));
    }

    let application = wide(exe.as_os_str());
    let mut command_line = wide(std::ffi::OsStr::new(&build_command_line(exe, args)));
    let directory = exe.parent().map(|dir| wide(dir.as_os_str()));

    let startup = STARTUPINFOW {
        cb: size_of::<STARTUPINFOW>() as u32,
        ..Default::default()
    };
    let mut info = PROCESS_INFORMATION::default();

    // SAFETY: every buffer is nul-terminated and outlives the call;
    // `command_line` is mutable as CreateProcessW requires; `info` is an out
    // structure whose two handles are closed below.
    let created = unsafe {
        CreateProcessW(
            PCWSTR(application.as_ptr()),
            Some(PWSTR(command_line.as_mut_ptr())),
            None,
            None,
            false,
            CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT,
            None,
            directory
                .as_ref()
                .map_or(PCWSTR::null(), |dir| PCWSTR(dir.as_ptr())),
            &startup,
            &mut info,
        )
    };
    if let Err(error) = created {
        if error.code() == ERROR_ELEVATION_REQUIRED.to_hresult() {
            return Err(DesktopError::NeedsElevation);
        }
        return Err(DesktopError::win32("CreateProcessW", &error));
    }

    // From here the process exists and is suspended: every path must either
    // resume it inside the job or terminate it.
    // SAFETY: handles from CreateProcessW; closed exactly once below.
    unsafe {
        let job = CreateJobObjectW(None, PCWSTR::null());
        let outcome = match job {
            Ok(job) => {
                let job = JobHandle(job);
                match AssignProcessToJobObject(job.0, info.hProcess) {
                    Ok(()) => {
                        ResumeThread(info.hThread);
                        Ok(Launched {
                            pid: info.dwProcessId,
                            job,
                        })
                    }
                    Err(error) => {
                        let _ = TerminateProcess(info.hProcess, 1);
                        Err(DesktopError::win32("AssignProcessToJobObject", &error))
                    }
                }
            }
            Err(error) => {
                let _ = TerminateProcess(info.hProcess, 1);
                Err(DesktopError::win32("CreateJobObjectW", &error))
            }
        };
        let _ = CloseHandle(info.hThread);
        let _ = CloseHandle(info.hProcess);
        outcome
    }
}

/// The processes currently in the job.
pub fn job_pids(job: &JobHandle) -> Vec<u32> {
    // JOBOBJECT_BASIC_PROCESS_ID_LIST is two counters and a variable-length
    // array of ids; a plain buffer of usize holds it.
    const CAPACITY: usize = 256;
    let mut buffer = vec![0usize; 2 + CAPACITY];
    // SAFETY: the buffer is large enough for the header plus CAPACITY ids and
    // its byte size is passed.
    let queried = unsafe {
        QueryInformationJobObject(
            Some(job.0),
            JobObjectBasicProcessIdList,
            buffer.as_mut_ptr() as *mut c_void,
            (buffer.len() * size_of::<usize>()) as u32,
            None,
        )
    };
    if queried.is_err() {
        return Vec::new();
    }
    // Header: NumberOfAssignedProcesses (u32), NumberOfProcessIdsInList (u32),
    // then ProcessIdList. Two u32 take one usize on 64-bit Windows.
    let in_list = (buffer[0] >> 32) as usize;
    buffer[1..]
        .iter()
        .take(in_list.min(CAPACITY))
        .map(|&pid| pid as u32)
        .collect()
}

/// End every process of the job.
pub fn terminate_job(job: &JobHandle) -> Result<()> {
    // SAFETY: the handle is owned by `job`.
    unsafe { TerminateJobObject(job.0, 1) }.map_err(|e| DesktopError::win32("TerminateJobObject", &e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn plain_arguments_are_left_alone() {
        assert_eq!(quote_arg("file.txt"), "file.txt");
        assert_eq!(quote_arg(r"C:\dir\file.txt"), r"C:\dir\file.txt");
    }

    #[test]
    fn spaces_get_quotes_and_empty_is_kept() {
        assert_eq!(quote_arg("my file.txt"), "\"my file.txt\"");
        assert_eq!(quote_arg(""), "\"\"");
    }

    #[test]
    fn quotes_inside_are_escaped() {
        assert_eq!(quote_arg("say \"hi\""), r#""say \"hi\"""#);
    }

    #[test]
    fn a_trailing_backslash_stays_literal() {
        assert_eq!(quote_arg(r"C:\my dir\"), "\"C:\\my dir\\\\\"");
    }

    #[test]
    fn backslashes_before_a_quote_are_doubled() {
        assert_eq!(quote_arg("a\\\"b"), "\"a\\\\\\\"b\"");
    }

    #[test]
    fn the_command_line_quotes_the_program_and_every_argument() {
        let exe = PathBuf::from(r"C:\Program Files\App\app.exe");
        let line = build_command_line(&exe, &["--flag".into(), "two words".into()]);
        assert_eq!(line, "\"C:\\Program Files\\App\\app.exe\" --flag \"two words\"");
    }

    #[test]
    fn relative_and_script_paths_are_refused() {
        assert!(check_launch_path(Path::new("notepad.exe")).is_err());
        assert!(check_launch_path(Path::new(r"C:\x\run.bat")).is_err());
        assert!(check_launch_path(Path::new(r"C:\x\RUN.CMD")).is_err());
        assert!(check_launch_path(Path::new(r"C:\Windows\notepad.exe")).is_ok());
    }

    #[test]
    fn a_missing_program_is_refused_before_anything_starts() {
        let result = launch(Path::new(r"C:\definitely\not\here.exe"), &[]);
        assert!(matches!(result, Err(DesktopError::Refused(_))));
    }

    #[test]
    fn a_launched_program_is_in_its_job_and_can_be_ended() {
        let exe = Path::new(r"C:\Windows\System32\ping.exe");
        if !exe.exists() {
            return;
        }
        // A long-running, windowless program.
        let launched = launch(exe, &["-n".into(), "30".into(), "127.0.0.1".into()]).expect("launch");
        std::thread::sleep(std::time::Duration::from_millis(300));
        assert!(job_pids(&launched.job).contains(&launched.pid));
        terminate_job(&launched.job).expect("terminate");
        std::thread::sleep(std::time::Duration::from_millis(300));
        assert!(job_pids(&launched.job).is_empty());
    }
}
