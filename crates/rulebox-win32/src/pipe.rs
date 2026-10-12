//! Named-pipe security, peer verification and the client open (plan Section 6.2).
//!
//! None of these changes persistent machine state, so none is guarded.

use std::ffi::c_void;
use std::os::windows::io::RawHandle;
use std::path::PathBuf;

use tokio::net::windows::named_pipe::{
    NamedPipeClient, NamedPipeServer, PipeMode, ServerOptions,
};
use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{
    ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND, ERROR_PIPE_BUSY, HANDLE,
};
use windows::Win32::Security::Authorization::{GetSecurityInfo, SE_KERNEL_OBJECT};
use windows::Win32::Security::{
    GetTokenInformation, RevertToSelf, TokenElevation, OWNER_SECURITY_INFORMATION,
    PSECURITY_DESCRIPTOR, PSID, TOKEN_ELEVATION,
    TOKEN_QUERY,
};
use windows::Win32::Storage::FileSystem::{
    CreateFileW, FILE_FLAGS_AND_ATTRIBUTES, FILE_FLAG_OVERLAPPED, FILE_GENERIC_READ,
    FILE_SHARE_MODE, FILE_WRITE_ATTRIBUTES, FILE_WRITE_DATA, FILE_WRITE_EA, OPEN_EXISTING,
    SECURITY_IDENTIFICATION, SECURITY_SQOS_PRESENT,
};
use windows::Win32::System::Pipes::{
    GetNamedPipeClientProcessId, GetNamedPipeClientSessionId, ImpersonateNamedPipeClient,
};
use windows::Win32::System::Threading::{
    GetCurrentThread, OpenProcess, OpenThreadToken, QueryFullProcessImageNameW,
    PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};

use crate::error::{api_err, code_err, Result, Win32Error};
use crate::security::SecurityAttributes;
use crate::sid::{psid_to_string, user_sid_of_token, Sid};
use crate::util::{to_wide, LocalAllocGuard, OwnedHandle};

/// Buffer size hint for both directions (plan Section 6.1).
pub const PIPE_BUFFER_SIZE: u32 = 65_536;
/// Most instances of one pipe name.
pub const PIPE_MAX_INSTANCES: usize = 4;

/// Access the client asks for: read, plus write without `FILE_CREATE_PIPE_INSTANCE`
/// (bit 0x4), which `GENERIC_WRITE` would include.
pub const CLIENT_ACCESS: u32 =
    FILE_GENERIC_READ.0 | FILE_WRITE_DATA.0 | FILE_WRITE_EA.0 | FILE_WRITE_ATTRIBUTES.0;

/// Section 6.2 descriptor with the Staff account's SID substituted. The Staff
/// entry is `0x12019b`, which has no `FILE_CREATE_PIPE_INSTANCE` bit.
pub fn shell_pipe_sddl(client: &Sid) -> String {
    format!(
        "O:SYG:SYD:P(D;;GA;;;NU)(A;;GA;;;SY)(A;;GA;;;BA)(A;;0x12019b;;;{client})S:(ML;;NW;;;ME)"
    )
}

/// Admin pipe: SYSTEM and Administrators only; network logons denied.
pub fn admin_pipe_sddl() -> String {
    "O:SYG:SYD:P(D;;GA;;;NU)(A;;GA;;;SY)(A;;GA;;;BA)".to_string()
}

/// Simulate mode: owner and full control for the current user only.
pub fn sim_pipe_sddl(current_user: &Sid) -> String {
    format!("O:{current_user}G:{current_user}D:P(A;;GA;;;{current_user})")
}

/// Who is on the other end of a server-side pipe handle.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerInfo {
    pub pid: u32,
    pub session_id: u32,
    pub user: Sid,
    pub image_path: Option<PathBuf>,
}

/// Runs `f` with the pipe client's identity token (query access). Impersonation
/// is reverted before returning. A failing `RevertToSelf` aborts the process:
/// continuing as the client would be unsafe.
fn with_client_token<T>(pipe: RawHandle, f: impl FnOnce(&OwnedHandle) -> Result<T>) -> Result<T> {
    // SAFETY: the caller passes a valid server-side pipe handle that has been read from.
    unsafe { ImpersonateNamedPipeClient(HANDLE(pipe)) }
        .map_err(|e| api_err("ImpersonateNamedPipeClient", &e))?;

    let result = (|| {
        let mut token = HANDLE::default();
        // SAFETY: the current-thread pseudo handle is valid; `token` is a valid out pointer.
        unsafe { OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, true, &mut token) }
            .map_err(|e| api_err("OpenThreadToken", &e))?;
        f(&OwnedHandle::new(token)?)
    })();

    // SAFETY: reverts the impersonation that this function started on this thread.
    if let Err(e) = unsafe { RevertToSelf() } {
        tracing::error!("RevertToSelf failed after impersonating a pipe client: {e}; aborting");
        std::process::abort();
    }
    result
}

/// Must be called after at least one read on the pipe. Impersonates the client,
/// reads its user SID and reverts, all synchronously (no `.await` can sit between).
pub fn verify_peer(pipe: RawHandle) -> Result<PeerInfo> {
    let user = with_client_token(pipe, user_sid_of_token)?;

    let mut pid = 0u32;
    // SAFETY: valid pipe handle and out pointer.
    unsafe { GetNamedPipeClientProcessId(HANDLE(pipe), &mut pid) }
        .map_err(|e| api_err("GetNamedPipeClientProcessId", &e))?;
    let mut session_id = 0u32;
    // SAFETY: valid pipe handle and out pointer.
    unsafe { GetNamedPipeClientSessionId(HANDLE(pipe), &mut session_id) }
        .map_err(|e| api_err("GetNamedPipeClientSessionId", &e))?;

    Ok(PeerInfo { pid, session_id, user, image_path: process_image_path(pid) })
}

/// `QueryFullProcessImageNameW` for a pid; `None` if the process cannot be opened.
fn process_image_path(pid: u32) -> Option<PathBuf> {
    // SAFETY: plain call; the returned handle is owned by `OwnedHandle` below.
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.ok()?;
    let handle = OwnedHandle::new(handle).ok()?;
    let mut buf = vec![0u16; 1024];
    let mut len = buf.len() as u32;
    // SAFETY: `buf` holds `len` UTF-16 units; `len` is a valid in/out pointer.
    unsafe {
        QueryFullProcessImageNameW(handle.raw(), PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len)
    }
    .ok()?;
    Some(PathBuf::from(String::from_utf16_lossy(&buf[..len as usize])))
}

/// True if the client's token is elevated (for the admin pipe; the pipe's DACL
/// already limits who can connect).
pub fn token_is_elevated_admin(pipe: RawHandle) -> Result<bool> {
    with_client_token(pipe, |token| {
        let mut elevation = TOKEN_ELEVATION::default();
        let mut returned = 0u32;
        // SAFETY: the buffer is a TOKEN_ELEVATION and the size passed is its size.
        unsafe {
            GetTokenInformation(
                token.raw(),
                TokenElevation,
                Some(std::ptr::from_mut(&mut elevation).cast::<c_void>()),
                std::mem::size_of::<TOKEN_ELEVATION>() as u32,
                &mut returned,
            )
        }
        .map_err(|e| api_err("GetTokenInformation", &e))?;
        Ok(elevation.TokenIsElevated != 0)
    })
}

/// `CreateFileW` with the access mask and flags from Section 6.2. Returns an
/// overlapped handle. Maps "not found" to `NotFound` and "busy" to `Busy`.
pub fn open_client(name: &str) -> Result<OwnedHandle> {
    open_client_with_access(name, CLIENT_ACCESS)
}

/// Like `open_client` with an explicit access mask (tests use this to show a
/// wider mask is refused).
pub fn open_client_with_access(name: &str, access: u32) -> Result<OwnedHandle> {
    let wide = to_wide(name);
    let flags = FILE_FLAG_OVERLAPPED
        | FILE_FLAGS_AND_ATTRIBUTES(SECURITY_SQOS_PRESENT.0 | SECURITY_IDENTIFICATION.0);
    // SAFETY: `wide` is NUL-terminated and outlives the call; no security attributes are passed.
    let result = unsafe {
        CreateFileW(PCWSTR(wide.as_ptr()), access, FILE_SHARE_MODE(0), None, OPEN_EXISTING, flags, None)
    };
    match result {
        Ok(handle) => OwnedHandle::new(handle),
        Err(e) => {
            let code = api_err("CreateFileW", &e);
            match code {
                Win32Error::Api { code, .. }
                    if code == ERROR_FILE_NOT_FOUND.0 || code == ERROR_PATH_NOT_FOUND.0 =>
                {
                    Err(Win32Error::NotFound)
                }
                Win32Error::Api { code, .. } if code == ERROR_PIPE_BUSY.0 => Err(Win32Error::Busy),
                other => Err(other),
            }
        }
    }
}

/// The owner SID of a pipe handle (the client checks it is SYSTEM).
pub fn pipe_owner(pipe: RawHandle) -> Result<Sid> {
    let mut owner = PSID::default();
    let mut psd = PSECURITY_DESCRIPTOR::default();
    // SAFETY: valid handle; the out pointers are valid. `owner` points into `psd`, which `guard` frees.
    let status = unsafe {
        GetSecurityInfo(
            HANDLE(pipe),
            SE_KERNEL_OBJECT,
            OWNER_SECURITY_INFORMATION,
            Some(&mut owner),
            None,
            None,
            None,
            Some(&mut psd),
        )
    };
    if status.0 != 0 {
        return Err(code_err("GetSecurityInfo", status.0));
    }
    let _guard = LocalAllocGuard::new(psd.0)?;
    if owner.0.is_null() {
        return Err(Win32Error::Invalid("pipe has no owner".into()));
    }
    Sid::parse(&psid_to_string(owner)?)
}

/// Creates one server instance of a pipe: byte mode, duplex, overlapped, remote
/// clients rejected, 64 KiB buffers, at most `PIPE_MAX_INSTANCES`. `first` adds
/// `FILE_FLAG_FIRST_PIPE_INSTANCE` so a name owned by another process is refused.
/// Must run inside a tokio runtime.
pub fn create_server_instance(
    name: &str,
    attrs: &SecurityAttributes,
    first: bool,
) -> std::io::Result<NamedPipeServer> {
    let mut options = ServerOptions::new();
    options
        .first_pipe_instance(first)
        .reject_remote_clients(true)
        .pipe_mode(PipeMode::Byte)
        .max_instances(PIPE_MAX_INSTANCES)
        .in_buffer_size(PIPE_BUFFER_SIZE)
        .out_buffer_size(PIPE_BUFFER_SIZE);
    // SAFETY: `attrs.as_ptr()` points to a valid SECURITY_ATTRIBUTES (with a valid
    // descriptor) that outlives this call; the kernel copies the descriptor.
    unsafe { options.create_with_security_attributes_raw(name, attrs.as_ptr()) }
}

/// Wraps a handle from `open_client` for async use. Must run inside a tokio runtime.
pub fn client_from_handle(handle: OwnedHandle) -> std::io::Result<NamedPipeClient> {
    // SAFETY: the handle is a valid overlapped pipe client handle; ownership moves to tokio.
    unsafe { NamedPipeClient::from_raw_handle(handle.into_raw().0) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sddl_strings_parse() {
        let me = crate::sid::current_user_sid().unwrap();
        for sddl in [shell_pipe_sddl(&me), admin_pipe_sddl(), sim_pipe_sddl(&me)] {
            SecurityAttributes::from_sddl(&sddl).unwrap_or_else(|e| panic!("{sddl}: {e}"));
        }
    }

    #[test]
    fn shell_sddl_matches_the_plan() {
        let sid = Sid::parse("S-1-5-21-1-2-3-1001").unwrap();
        assert_eq!(
            shell_pipe_sddl(&sid),
            "O:SYG:SYD:P(D;;GA;;;NU)(A;;GA;;;SY)(A;;GA;;;BA)(A;;0x12019b;;;S-1-5-21-1-2-3-1001)S:(ML;;NW;;;ME)"
        );
    }

    #[test]
    fn client_access_has_no_create_instance_bit() {
        assert_eq!(CLIENT_ACCESS & 0x4, 0);
    }

    #[test]
    fn opening_a_missing_pipe_is_not_found() {
        let name = format!(r"\\.\pipe\dev.rulebox.test.missing.{}", std::process::id());
        assert!(matches!(open_client(&name), Err(Win32Error::NotFound)));
    }
}
