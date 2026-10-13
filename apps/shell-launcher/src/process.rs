//! Starting the Staff App and waiting for it (plan Step 12, loop item 3).
//!
//! `CreateProcessW` with the full path as the application name, a quoted command
//! line, the exe's folder as working directory and the launcher's own environment
//! (the Staff user's). No arguments (plan Section 6.9).

use std::path::Path;

use rulebox_win32::util::{to_wide, OwnedHandle};
use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::WAIT_FAILED;
use windows::Win32::System::Threading::{
    CreateProcessW, GetExitCodeProcess, WaitForSingleObject, INFINITE, PROCESS_CREATION_FLAGS,
    PROCESS_INFORMATION, STARTUPINFOW,
};

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

    // SAFETY: every pointer refers to a live, NUL-terminated buffer or a struct
    // that outlives the call; the environment and security attributes are null.
    let created = unsafe {
        CreateProcessW(
            PCWSTR(app.as_ptr()),
            Some(PWSTR(command_line.as_mut_ptr())),
            None,
            None,
            false,
            PROCESS_CREATION_FLAGS(0),
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
    let _thread = OwnedHandle::new(info.hThread).ok();
    let process = OwnedHandle::new(info.hProcess).map_err(|_| RunError::Wait(0))?;

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
