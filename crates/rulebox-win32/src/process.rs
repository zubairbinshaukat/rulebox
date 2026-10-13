//! Finding, starting and ending processes in a user session.
//!
//! `launch_in_session` starts a program as the signed-in user of a session, with
//! that user's own non-elevated token (never the linked token). `terminate` only
//! ends a process whose image and owner both match what the caller expects.

use std::ffi::c_void;
use std::path::{Path, PathBuf};
use std::time::Duration;

use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::HANDLE;
use windows::Win32::Security::{
    DuplicateTokenEx, GetTokenInformation, SecurityImpersonation, TokenElevation, TokenElevationType,
    TokenElevationTypeFull, TokenPrimary, TOKEN_ALL_ACCESS, TOKEN_ELEVATION, TOKEN_ELEVATION_TYPE, TOKEN_QUERY,
};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::Environment::{CreateEnvironmentBlock, DestroyEnvironmentBlock};
use windows::Win32::System::RemoteDesktop::{ProcessIdToSessionId, WTSQueryUserToken};
use windows::Win32::System::Threading::{
    CreateProcessAsUserW, OpenProcess, OpenProcessToken, QueryFullProcessImageNameW, TerminateProcess,
    CREATE_UNICODE_ENVIRONMENT, PROCESS_INFORMATION, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
    PROCESS_TERMINATE, STARTUPINFOW,
};

use crate::error::{api_err, Result, Win32Error};
use crate::guard::require_test_machine;
use crate::sid::{user_sid_of_token, Sid};
use crate::util::{to_wide, OwnedHandle};

/// `ERROR_NO_TOKEN`: the session has no user token yet.
const ERROR_NO_TOKEN: u32 = 1008;
const TOKEN_RETRIES: u32 = 5;
const TOKEN_RETRY_DELAY: Duration = Duration::from_millis(500);

/// Lower-cases and normalises separators so two spellings of one path compare equal.
fn normalized(path: &Path) -> String {
    path.to_string_lossy().replace('/', "\\").to_ascii_lowercase()
}

/// The full image path of `pid`, if the process exists and can be queried.
fn image_of_handle(process: &OwnedHandle) -> Option<PathBuf> {
    let mut buffer = vec![0u16; 1024];
    let mut length = buffer.len() as u32;
    // SAFETY: `buffer` is writable for `length` characters; `process` is a valid
    // handle with PROCESS_QUERY_LIMITED_INFORMATION.
    unsafe {
        QueryFullProcessImageNameW(process.raw(), PROCESS_NAME_WIN32, PWSTR(buffer.as_mut_ptr()), &mut length)
    }
    .ok()?;
    Some(PathBuf::from(String::from_utf16_lossy(&buffer[..length as usize])))
}

fn open_process(pid: u32, access: windows::Win32::System::Threading::PROCESS_ACCESS_RIGHTS) -> Result<OwnedHandle> {
    // SAFETY: a plain open by id; the handle is owned by the returned guard.
    let handle = unsafe { OpenProcess(access, false, pid) }.map_err(|e| api_err("OpenProcess", &e))?;
    OwnedHandle::new(handle)
}

/// The ids of processes in `session_id` whose image is `image`.
pub fn find_by_image(session_id: u32, image: &Path) -> Result<Vec<u32>> {
    // SAFETY: a snapshot of all processes; the handle is owned by the guard below.
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }
        .map_err(|e| api_err("CreateToolhelp32Snapshot", &e))?;
    let snapshot = OwnedHandle::new(snapshot)?;

    let wanted = normalized(image);
    let mut found = Vec::new();
    let mut entry = PROCESSENTRY32W {
        dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    // SAFETY: `entry` has its size set; `snapshot` is a valid snapshot handle.
    let mut more = unsafe { Process32FirstW(snapshot.raw(), &mut entry) }.is_ok();
    while more {
        let pid = entry.th32ProcessID;
        let mut process_session = 0u32;
        // SAFETY: `process_session` is a valid out pointer.
        let in_session = unsafe { ProcessIdToSessionId(pid, &mut process_session) }.is_ok()
            && process_session == session_id;
        if in_session {
            if let Ok(process) = open_process(pid, PROCESS_QUERY_LIMITED_INFORMATION) {
                if image_of_handle(&process).is_some_and(|path| normalized(&path) == wanted) {
                    found.push(pid);
                }
            }
        }
        // SAFETY: as above.
        more = unsafe { Process32NextW(snapshot.raw(), &mut entry) }.is_ok();
    }
    Ok(found)
}

/// Ends `pid` if its image is `expected_image` and its owner is `expected_user`.
///
/// DESTRUCTIVE: guarded.
pub fn terminate(pid: u32, expected_image: &Path, expected_user: &Sid) -> Result<()> {
    require_test_machine()?;
    let process = open_process(pid, PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE)?;

    // The checks and the termination use the same handle, so a reused process id
    // cannot be ended by mistake.
    let image = image_of_handle(&process).ok_or(Win32Error::NotFound)?;
    if normalized(&image) != normalized(expected_image) {
        return Err(Win32Error::Invalid(format!("process {pid} is not {}", expected_image.display())));
    }
    let mut token = HANDLE::default();
    // SAFETY: `token` is a valid out pointer; `process` is a valid process handle.
    unsafe { OpenProcessToken(process.raw(), TOKEN_QUERY, &mut token) }
        .map_err(|e| api_err("OpenProcessToken", &e))?;
    let token = OwnedHandle::new(token)?;
    if user_sid_of_token(&token)? != *expected_user {
        return Err(Win32Error::Invalid(format!("process {pid} belongs to another user")));
    }
    // SAFETY: `process` has PROCESS_TERMINATE access.
    unsafe { TerminateProcess(process.raw(), 1) }.map_err(|e| api_err("TerminateProcess", &e))
}

/// An environment block, destroyed on drop.
struct EnvBlock(*mut c_void);

impl Drop for EnvBlock {
    fn drop(&mut self) {
        // SAFETY: the block came from `CreateEnvironmentBlock` and is destroyed once.
        unsafe {
            let _ = DestroyEnvironmentBlock(self.0);
        }
    }
}

fn token_u32(token: &OwnedHandle, class: windows::Win32::Security::TOKEN_INFORMATION_CLASS) -> Result<u32> {
    let mut value = 0u32;
    let mut returned = 0u32;
    // SAFETY: `value` is a valid 4-byte buffer for the DWORD-sized classes asked for.
    unsafe {
        GetTokenInformation(token.raw(), class, Some(std::ptr::from_mut(&mut value).cast()), 4, &mut returned)
    }
    .map_err(|e| api_err("GetTokenInformation", &e))?;
    Ok(value)
}

/// Starts `exe` in `session_id` as the user of that session, which must be
/// `expected_user`, and returns the new process id.
///
/// DESTRUCTIVE: guarded.
pub fn launch_in_session(session_id: u32, expected_user: &Sid, exe: &Path) -> Result<u32> {
    require_test_machine()?;
    if !exe.is_absolute() || !exe.is_file() {
        return Err(Win32Error::Invalid(format!("not an existing absolute path: {}", exe.display())));
    }

    // 1. The user's token (the session may not be ready yet).
    let mut attempt = 0;
    let token = loop {
        let mut raw = HANDLE::default();
        // SAFETY: `raw` is a valid out pointer. Error 1314 means "not SYSTEM".
        match unsafe { WTSQueryUserToken(session_id, &mut raw) } {
            Ok(()) => break OwnedHandle::new(raw)?,
            Err(error) => {
                let err = api_err("WTSQueryUserToken", &error);
                attempt += 1;
                if err.code() == Some(ERROR_NO_TOKEN) && attempt < TOKEN_RETRIES {
                    std::thread::sleep(TOKEN_RETRY_DELAY);
                    continue;
                }
                return Err(err);
            }
        }
    };

    // 2. The token must belong to the expected user.
    if user_sid_of_token(&token)? != *expected_user {
        return Err(Win32Error::Invalid(format!("session {session_id} is not signed in as the expected user")));
    }
    // 3. Never launch with an elevated token, and never use the linked token.
    let elevation_type = TOKEN_ELEVATION_TYPE(token_u32(&token, TokenElevationType)? as i32);
    let mut elevation = TOKEN_ELEVATION::default();
    let mut returned = 0u32;
    // SAFETY: `elevation` is a valid TOKEN_ELEVATION of the size passed.
    unsafe {
        GetTokenInformation(
            token.raw(),
            TokenElevation,
            Some(std::ptr::from_mut(&mut elevation).cast()),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut returned,
        )
    }
    .map_err(|e| api_err("GetTokenInformation", &e))?;
    if elevation.TokenIsElevated != 0 || elevation_type == TokenElevationTypeFull {
        return Err(Win32Error::Invalid("the session's token is elevated; refusing to launch".into()));
    }

    // 4. A primary token.
    let mut primary = HANDLE::default();
    // SAFETY: `token` is a valid token handle; `primary` is a valid out pointer.
    unsafe { DuplicateTokenEx(token.raw(), TOKEN_ALL_ACCESS, None, SecurityImpersonation, TokenPrimary, &mut primary) }
        .map_err(|e| api_err("DuplicateTokenEx", &e))?;
    let primary = OwnedHandle::new(primary)?;

    // 5. The user's environment (not inherited from the service).
    let mut block: *mut c_void = std::ptr::null_mut();
    // SAFETY: `block` is a valid out pointer; the token is a valid primary token.
    unsafe { CreateEnvironmentBlock(&mut block, Some(primary.raw()), false) }
        .map_err(|e| api_err("CreateEnvironmentBlock", &e))?;
    let block = EnvBlock(block);

    // 6. Start the process.
    let exe_text = exe.to_string_lossy().into_owned();
    let application = to_wide(&exe_text);
    let mut command_line = to_wide(&format!("\"{exe_text}\""));
    let directory = exe.parent().map(|dir| to_wide(&dir.to_string_lossy())).unwrap_or_else(|| to_wide("."));
    let mut desktop = to_wide(r"winsta0\default");
    let startup = STARTUPINFOW {
        cb: std::mem::size_of::<STARTUPINFOW>() as u32,
        lpDesktop: PWSTR(desktop.as_mut_ptr()),
        ..Default::default()
    };
    let mut info = PROCESS_INFORMATION::default();
    // SAFETY: every string is NUL-terminated and outlives the call; the command
    // line is a mutable buffer as the API requires; the environment block is
    // Unicode (CREATE_UNICODE_ENVIRONMENT); handles are not inherited.
    unsafe {
        CreateProcessAsUserW(
            Some(primary.raw()),
            PCWSTR(application.as_ptr()),
            Some(PWSTR(command_line.as_mut_ptr())),
            None,
            None,
            false,
            CREATE_UNICODE_ENVIRONMENT,
            Some(block.0.cast_const()),
            PCWSTR(directory.as_ptr()),
            &startup,
            &mut info,
        )
    }
    .map_err(|e| api_err("CreateProcessAsUserW", &e))?;

    // 7. Close the handles we do not need; the guards close the tokens and the
    // environment block.
    let pid = info.dwProcessId;
    // SAFETY: both handles were returned by CreateProcessAsUserW and are closed once.
    unsafe {
        let _ = windows::Win32::Foundation::CloseHandle(info.hThread);
        let _ = windows::Win32::Foundation::CloseHandle(info.hProcess);
    }
    Ok(pid)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_compare_without_case_or_slash_style() {
        assert_eq!(normalized(Path::new("C:/Program Files/Rulebox/A.EXE")), normalized(Path::new(r"c:\program files\rulebox\a.exe")));
    }

    #[test]
    fn this_process_is_found_by_its_own_image() {
        let exe = std::env::current_exe().unwrap();
        let mut session = 0u32;
        // SAFETY: a valid out pointer.
        unsafe { ProcessIdToSessionId(std::process::id(), &mut session) }.unwrap();
        let found = find_by_image(session, &exe).unwrap();
        assert!(found.contains(&std::process::id()), "{found:?}");
    }

    #[test]
    fn another_session_finds_nothing() {
        let exe = std::env::current_exe().unwrap();
        assert!(find_by_image(0xFFFF_0000, &exe).unwrap().is_empty());
    }

    #[test]
    fn mutating_functions_are_blocked_by_the_guard() {
        if crate::guard::is_test_machine() {
            return;
        }
        let user = crate::sid::current_user_sid().unwrap();
        let exe = std::env::current_exe().unwrap();
        assert!(matches!(terminate(std::process::id(), &exe, &user), Err(Win32Error::Guard(_))));
        assert!(matches!(launch_in_session(1, &user, &exe), Err(Win32Error::Guard(_))));
    }
}
