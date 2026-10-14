//! Sleep, restart and shut down (plan Step 9).
//!
//! A default standard user may do these when the process token holds
//! `SeShutdownPrivilege`. The Staff App never asks for administrator rights:
//! if the privilege is missing, the three items stay hidden. These functions
//! really do suspend or exit Windows — nothing in the test suite calls
//! [`sleep`], [`restart`] or [`shut_down`].

use std::mem::{size_of, zeroed};

use windows::core::w;
use windows::Win32::Foundation::{CloseHandle, ERROR_NOT_ALL_ASSIGNED, GetLastError, HANDLE, LUID};
use windows::Win32::Security::{
    AdjustTokenPrivileges, GetTokenInformation, LookupPrivilegeValueW, LUID_AND_ATTRIBUTES,
    SE_PRIVILEGE_ENABLED, TOKEN_ACCESS_MASK, TOKEN_ADJUST_PRIVILEGES, TOKEN_PRIVILEGES, TOKEN_QUERY,
    TokenPrivileges,
};
use windows::Win32::System::Power::SetSuspendState;
use windows::Win32::System::Shutdown::{
    ExitWindowsEx, EWX_POWEROFF, EWX_REBOOT, EWX_SHUTDOWN, SHUTDOWN_REASON, SHTDN_REASON_FLAG_PLANNED,
    SHTDN_REASON_MAJOR_OTHER, SHTDN_REASON_MINOR_OTHER,
};
use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

use crate::error::{DesktopError, Result};

/// Enough room for a token's privilege list (a logon token has far fewer).
const PRIV_CAP: usize = 64;

#[repr(C)]
struct PrivBuf {
    count: u32,
    privs: [LUID_AND_ATTRIBUTES; PRIV_CAP],
}

struct OwnedToken(HANDLE);

impl Drop for OwnedToken {
    fn drop(&mut self) {
        // SAFETY: the handle is owned here and closed once.
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

fn open_token(access: TOKEN_ACCESS_MASK) -> Result<OwnedToken> {
    let mut token = HANDLE::default();
    // SAFETY: `token` is an out-handle we take ownership of.
    unsafe {
        OpenProcessToken(GetCurrentProcess(), access, &mut token)
            .map_err(|e| DesktopError::win32("OpenProcessToken", &e))?;
    }
    Ok(OwnedToken(token))
}

fn privilege_luid() -> Result<LUID> {
    let mut luid = LUID::default();
    // SAFETY: `luid` is an out-parameter.
    unsafe {
        LookupPrivilegeValueW(None, w!("SeShutdownPrivilege"), &mut luid)
            .map_err(|e| DesktopError::win32("LookupPrivilegeValueW", &e))?;
    }
    Ok(luid)
}

/// The process token lists `SeShutdownPrivilege` (enabled or not). Enabling
/// it later is not an elevation.
pub fn can_power_off() -> bool {
    match token_has_shutdown_privilege() {
        Ok(present) => present,
        Err(error) => {
            tracing::warn!(%error, "could not read the shutdown privilege");
            false
        }
    }
}

fn token_has_shutdown_privilege() -> Result<bool> {
    let token = open_token(TOKEN_QUERY)?;
    let wanted = privilege_luid()?;
    // SAFETY: `buf` is zeroed and large enough for the header plus PRIV_CAP
    // entries; the byte length is passed.
    let buf = unsafe {
        let mut buf: PrivBuf = zeroed();
        let mut returned = 0u32;
        GetTokenInformation(
            token.0,
            TokenPrivileges,
            Some(&mut buf as *mut PrivBuf as *mut _),
            size_of::<PrivBuf>() as u32,
            &mut returned,
        )
        .map_err(|e| DesktopError::win32("GetTokenInformation", &e))?;
        buf
    };
    let count = (buf.count as usize).min(PRIV_CAP);
    Ok(buf.privs[..count].iter().any(|entry| entry.Luid == wanted))
}

fn enable_shutdown_privilege() -> Result<()> {
    let token = open_token(TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY)?;
    let luid = privilege_luid()?;
    let privileges = TOKEN_PRIVILEGES {
        PrivilegeCount: 1,
        Privileges: [LUID_AND_ATTRIBUTES {
            Luid: luid,
            Attributes: SE_PRIVILEGE_ENABLED,
        }],
    };
    // SAFETY: the privilege list is one entry and the token is ours.
    unsafe {
        AdjustTokenPrivileges(token.0, false, Some(&privileges), 0, None, None)
            .map_err(|e| DesktopError::win32("AdjustTokenPrivileges", &e))?;
    }
    // The call returns success even when the privilege was not held.
    let last = unsafe { GetLastError() };
    if last == ERROR_NOT_ALL_ASSIGNED {
        return Err(DesktopError::Refused(
            "this account cannot shut down the PC".into(),
        ));
    }
    Ok(())
}

/// A planned shutdown reason: other / other, flagged as planned.
fn planned_reason() -> SHUTDOWN_REASON {
    SHUTDOWN_REASON(
        SHTDN_REASON_MAJOR_OTHER.0 | SHTDN_REASON_MINOR_OTHER.0 | SHTDN_REASON_FLAG_PLANNED.0,
    )
}

/// Suspend the PC. Does not sign anyone out.
pub fn sleep() -> Result<()> {
    enable_shutdown_privilege()?;
    tracing::info!("suspending the PC");
    // SAFETY: no pointers. Hibernate is false (sleep, not hibernate).
    // The API returns a BOOL rather than a Result.
    if unsafe { SetSuspendState(false, false, false) } {
        Ok(())
    } else {
        let error = windows::core::Error::from_thread();
        Err(DesktopError::win32("SetSuspendState", &error))
    }
}

/// Restart Windows. The caller signs the employee out first when someone is in.
pub fn restart() -> Result<()> {
    enable_shutdown_privilege()?;
    tracing::info!("restarting the PC");
    // SAFETY: no pointers.
    unsafe { ExitWindowsEx(EWX_REBOOT, planned_reason()) }
        .map_err(|e| DesktopError::win32("ExitWindowsEx", &e))
}

/// Shut the PC down.
pub fn shut_down() -> Result<()> {
    enable_shutdown_privilege()?;
    tracing::info!("shutting the PC down");
    // SAFETY: no pointers.
    unsafe { ExitWindowsEx(EWX_SHUTDOWN | EWX_POWEROFF, planned_reason()) }
        .map_err(|e| DesktopError::win32("ExitWindowsEx", &e))
}
