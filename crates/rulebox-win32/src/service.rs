//! Service Control Manager access (plan 4.5): start type, security descriptor and
//! required privileges of a service, each with a read-back so the journal can keep the
//! original (`ServiceStart`, `ServiceSecurity`, `ServicePrivileges` targets, plan 4.4).
//!
//! Rules checked before the guard and before any API call:
//!
//! - a service name is plain (letters, digits, `_`, `-`, `.`, `$`);
//! - a start type is one of automatic (2), manual (3), disabled (4), never boot or system;
//! - the Rulebox agent's own service is never set to manual or disabled;
//! - the security descriptor and the required privileges are changed for the Rulebox
//!   agent service only (plan 4.16).

use std::ffi::c_void;

use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::ERROR_INSUFFICIENT_BUFFER;
use windows::Win32::Security::{DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR};
use windows::Win32::System::Services::{
    ChangeServiceConfig2W, ChangeServiceConfigW, CloseServiceHandle, OpenSCManagerW, OpenServiceW,
    QueryServiceConfig2W, QueryServiceConfigW, QueryServiceObjectSecurity, SetServiceObjectSecurity,
    ENUM_SERVICE_TYPE, QUERY_SERVICE_CONFIGW, SC_HANDLE, SC_MANAGER_CONNECT, SERVICE_CHANGE_CONFIG,
    SERVICE_CONFIG_REQUIRED_PRIVILEGES_INFO, SERVICE_ERROR, SERVICE_NO_CHANGE, SERVICE_QUERY_CONFIG,
    SERVICE_REQUIRED_PRIVILEGES_INFOW, SERVICE_START_TYPE,
};

use crate::error::{api_err, Result, Win32Error};
use crate::guard::require_test_machine;
use crate::security::{dacl_sddl_of, SecurityAttributes};
use crate::util::to_wide;

/// The Rulebox agent's service name (plan Phase 2).
pub const AGENT_SERVICE: &str = "RuleboxAgent";

pub const START_AUTO: u32 = 2;
pub const START_MANUAL: u32 = 3;
pub const START_DISABLED: u32 = 4;

/// `READ_CONTROL` and `WRITE_DAC`, the standard rights for reading and replacing a DACL.
const READ_CONTROL: u32 = 0x0002_0000;
const WRITE_DAC: u32 = 0x0004_0000;

/// What a service is configured as (the parts Rulebox journals).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ServiceConfig {
    /// 0 boot, 1 system, 2 automatic, 3 manual, 4 disabled.
    pub start: u32,
}

/// A service handle closed on drop.
struct Scm(SC_HANDLE);

impl Drop for Scm {
    fn drop(&mut self) {
        // SAFETY: the handle was opened by this module, is owned by this value and closed once.
        unsafe {
            let _ = CloseServiceHandle(self.0);
        }
    }
}

fn check_name(name: &str) -> Result<()> {
    let plain = !name.is_empty()
        && name.len() <= 256
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | '$'));
    if plain {
        Ok(())
    } else {
        Err(Win32Error::Forbidden(format!("{name:?} is not a plain service name")))
    }
}

fn is_agent(name: &str) -> bool {
    name.eq_ignore_ascii_case(AGENT_SERVICE)
}

/// The name and start-type rules of [`set_start`] (no API call, no guard).
pub fn check_start(name: &str, start: u32) -> Result<()> {
    check_name(name)?;
    if !matches!(start, START_AUTO | START_MANUAL | START_DISABLED) {
        return Err(Win32Error::Forbidden(format!("start type {start} is not automatic, manual or disabled")));
    }
    if is_agent(name) && start != START_AUTO {
        return Err(Win32Error::Forbidden("the Rulebox agent service always starts automatically".into()));
    }
    Ok(())
}

/// The rule of the two functions that change the agent service's security or privileges.
pub fn check_agent_only(name: &str) -> Result<()> {
    check_name(name)?;
    if is_agent(name) {
        Ok(())
    } else {
        Err(Win32Error::Forbidden("only the Rulebox agent service's security is changed".into()))
    }
}

/// Opens `name`; `Ok(None)` when no such service exists.
fn open_service(name: &str, access: u32) -> Result<Option<Scm>> {
    // SAFETY: null machine and database names mean the local active database.
    let manager = unsafe { OpenSCManagerW(PCWSTR::null(), PCWSTR::null(), SC_MANAGER_CONNECT) }
        .map_err(|e| api_err("OpenSCManagerW", &e))?;
    let manager = Scm(manager);
    let wide = to_wide(name);
    // SAFETY: the manager handle is open; `wide` is NUL-terminated and outlives the call.
    match unsafe { OpenServiceW(manager.0, PCWSTR(wide.as_ptr()), access) } {
        Ok(handle) => Ok(Some(Scm(handle))),
        Err(e) => match api_err("OpenServiceW", &e) {
            Win32Error::Api { code: 1060, .. } => Ok(None),
            other => Err(other),
        },
    }
}

fn require_service(name: &str, access: u32) -> Result<Scm> {
    open_service(name, access)?.ok_or(Win32Error::NotFound)
}

/// A zeroed buffer that is aligned for the structures the SCM writes into it.
fn aligned_buffer(bytes: usize) -> Vec<u64> {
    vec![0u64; bytes.div_ceil(8).max(1)]
}

/// Reads the configuration of `name`. `Ok(None)` when no such service exists. Read-only.
pub fn query(name: &str) -> Result<Option<ServiceConfig>> {
    check_name(name)?;
    let Some(service) = open_service(name, SERVICE_QUERY_CONFIG)? else {
        return Ok(None);
    };
    let mut needed = 0u32;
    // SAFETY: the service is open; a null buffer with size 0 only asks for the size.
    let first = unsafe { QueryServiceConfigW(service.0, None, 0, &mut needed) };
    match first {
        Ok(()) => {}
        Err(e) => match api_err("QueryServiceConfigW", &e) {
            Win32Error::Api { code, .. } if code == ERROR_INSUFFICIENT_BUFFER.0 => {}
            other => return Err(other),
        },
    }
    let mut buffer = aligned_buffer(needed as usize);
    let mut again = 0u32;
    // SAFETY: `buffer` holds `needed` bytes and is 8-byte aligned, as QUERY_SERVICE_CONFIGW needs.
    unsafe {
        QueryServiceConfigW(service.0, Some(buffer.as_mut_ptr().cast::<QUERY_SERVICE_CONFIGW>()), needed, &mut again)
    }
    .map_err(|e| api_err("QueryServiceConfigW", &e))?;
    // SAFETY: the call succeeded, so the buffer starts with one initialised structure.
    let config = unsafe { &*buffer.as_ptr().cast::<QUERY_SERVICE_CONFIGW>() };
    Ok(Some(ServiceConfig { start: config.dwStartType.0 }))
}

/// Sets the start type of `name` (2 automatic, 3 manual, 4 disabled).
///
/// DESTRUCTIVE: guarded.
pub fn set_start(name: &str, start: u32) -> Result<()> {
    check_start(name, start)?;
    require_test_machine()?;
    let service = require_service(name, SERVICE_CHANGE_CONFIG)?;
    // SAFETY: the service is open with SERVICE_CHANGE_CONFIG; every other argument means
    // "no change" (SERVICE_NO_CHANGE, null strings).
    unsafe {
        ChangeServiceConfigW(
            service.0,
            ENUM_SERVICE_TYPE(SERVICE_NO_CHANGE),
            SERVICE_START_TYPE(start),
            SERVICE_ERROR(SERVICE_NO_CHANGE),
            PCWSTR::null(),
            PCWSTR::null(),
            None,
            PCWSTR::null(),
            PCWSTR::null(),
            PCWSTR::null(),
            PCWSTR::null(),
        )
    }
    .map_err(|e| api_err("ChangeServiceConfigW", &e))
}

/// The DACL of `name` as SDDL. `Ok(None)` when no such service exists. Read-only.
pub fn get_security(name: &str) -> Result<Option<String>> {
    check_name(name)?;
    let Some(service) = open_service(name, READ_CONTROL)? else {
        return Ok(None);
    };
    let mut needed = 0u32;
    // SAFETY: the service is open with READ_CONTROL; no buffer, size 0: only the size is asked for.
    let first = unsafe { QueryServiceObjectSecurity(service.0, DACL_SECURITY_INFORMATION.0, None, 0, &mut needed) };
    match first {
        Ok(()) => {}
        Err(e) => match api_err("QueryServiceObjectSecurity", &e) {
            Win32Error::Api { code, .. } if code == ERROR_INSUFFICIENT_BUFFER.0 => {}
            other => return Err(other),
        },
    }
    let mut buffer = aligned_buffer(needed as usize);
    let mut again = 0u32;
    let descriptor = PSECURITY_DESCRIPTOR(buffer.as_mut_ptr().cast::<c_void>());
    // SAFETY: `buffer` holds `needed` bytes.
    unsafe { QueryServiceObjectSecurity(service.0, DACL_SECURITY_INFORMATION.0, Some(descriptor), needed, &mut again) }
        .map_err(|e| api_err("QueryServiceObjectSecurity", &e))?;
    dacl_sddl_of(descriptor).map(Some)
}

/// Replaces the DACL of the agent service with `sddl`.
///
/// DESTRUCTIVE: guarded.
pub fn set_security(name: &str, sddl: &str) -> Result<()> {
    check_agent_only(name)?;
    require_test_machine()?;
    let attrs = SecurityAttributes::from_sddl(sddl)?;
    let service = require_service(name, WRITE_DAC)?;
    // SAFETY: the service is open with WRITE_DAC; the descriptor is valid while `attrs` lives.
    unsafe { SetServiceObjectSecurity(service.0, DACL_SECURITY_INFORMATION, attrs.descriptor()) }
        .map_err(|e| api_err("SetServiceObjectSecurity", &e))
}

/// The required privileges of `name` (an empty list means "all it is granted"). Read-only.
pub fn get_required_privileges(name: &str) -> Result<Vec<String>> {
    check_name(name)?;
    let Some(service) = open_service(name, SERVICE_QUERY_CONFIG)? else {
        return Ok(Vec::new());
    };
    let mut needed = 0u32;
    // SAFETY: the service is open; no buffer: only the size is asked for.
    let first = unsafe {
        QueryServiceConfig2W(service.0, SERVICE_CONFIG_REQUIRED_PRIVILEGES_INFO, None, &mut needed)
    };
    match first {
        Ok(()) => {}
        Err(e) => match api_err("QueryServiceConfig2W", &e) {
            Win32Error::Api { code, .. } if code == ERROR_INSUFFICIENT_BUFFER.0 => {}
            other => return Err(other),
        },
    }
    let mut buffer = aligned_buffer(needed as usize);
    let mut again = 0u32;
    let len = buffer.len() * 8;
    // SAFETY: the slice covers exactly the allocation of `buffer` (u64 units viewed as bytes).
    let bytes = unsafe { std::slice::from_raw_parts_mut(buffer.as_mut_ptr().cast::<u8>(), len) };
    // SAFETY: the service is open; `bytes` is a writable buffer of `len` bytes.
    unsafe { QueryServiceConfig2W(service.0, SERVICE_CONFIG_REQUIRED_PRIVILEGES_INFO, Some(bytes), &mut again) }
        .map_err(|e| api_err("QueryServiceConfig2W", &e))?;
    // SAFETY: the call succeeded: the buffer starts with a SERVICE_REQUIRED_PRIVILEGES_INFOW
    // whose string lives in the same buffer, as a multi-string ended by an empty string.
    let info = unsafe { &*buffer.as_ptr().cast::<SERVICE_REQUIRED_PRIVILEGES_INFOW>() };
    Ok(parse_multi_string(info.pmszRequiredPrivileges))
}

/// Reads a `MULTI_SZ` (strings ended by an empty string).
fn parse_multi_string(multi: PWSTR) -> Vec<String> {
    let mut out = Vec::new();
    if multi.is_null() {
        return out;
    }
    let mut cursor = multi.0.cast_const();
    loop {
        // SAFETY: the system's multi-string ends with an empty string, so every read
        // stays inside it: each string is NUL-terminated and `cursor` is moved past it.
        let text = unsafe { crate::util::from_wide_ptr(cursor) };
        if text.is_empty() {
            return out;
        }
        // SAFETY: as above: the string just read is `text.encode_utf16().count()` units
        // long (lossy conversion keeps the unit count for valid text) plus its NUL.
        let units = text.encode_utf16().count();
        cursor = unsafe { cursor.add(units + 1) };
        out.push(text);
    }
}

/// Sets the required privileges of the agent service. An empty list removes the limit.
///
/// DESTRUCTIVE: guarded.
pub fn set_required_privileges(name: &str, privileges: &[&str]) -> Result<()> {
    check_agent_only(name)?;
    require_test_machine()?;
    if privileges.iter().any(|p| p.is_empty() || !p.chars().all(|c| c.is_ascii_alphanumeric())) {
        return Err(Win32Error::Invalid("a privilege name is letters and digits".into()));
    }
    let service = require_service(name, SERVICE_CHANGE_CONFIG)?;
    let mut multi: Vec<u16> = Vec::new();
    for privilege in privileges {
        multi.extend(privilege.encode_utf16());
        multi.push(0);
    }
    // The list ends with an empty string; an empty list is just the terminator.
    multi.push(0);
    if privileges.is_empty() {
        multi.push(0);
    }
    let info = SERVICE_REQUIRED_PRIVILEGES_INFOW { pmszRequiredPrivileges: PWSTR(multi.as_mut_ptr()) };
    // SAFETY: the service is open with SERVICE_CHANGE_CONFIG; `info` points at a valid
    // multi-string that outlives the call.
    unsafe {
        ChangeServiceConfig2W(
            service.0,
            SERVICE_CONFIG_REQUIRED_PRIVILEGES_INFO,
            Some(std::ptr::from_ref(&info).cast::<c_void>()),
        )
    }
    .map_err(|e| api_err("ChangeServiceConfig2W", &e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn start_rules() {
        assert!(check_start("Spooler", START_DISABLED).is_ok());
        assert!(check_start("AppIDSvc", START_MANUAL).is_ok());
        assert!(check_start(AGENT_SERVICE, START_AUTO).is_ok());
        for (name, start) in [
            (AGENT_SERVICE, START_DISABLED),
            ("ruleboxagent", START_MANUAL),
            ("Spooler", 0),
            ("Spooler", 1),
            ("Spooler", 5),
            ("", START_AUTO),
            (r"..\x", START_AUTO),
            ("a b", START_AUTO),
        ] {
            assert!(matches!(check_start(name, start), Err(Win32Error::Forbidden(_))), "{name} {start}");
        }
    }

    #[test]
    fn only_the_agent_service_security_changes() {
        assert!(check_agent_only("RuleboxAgent").is_ok());
        assert!(matches!(check_agent_only("Spooler"), Err(Win32Error::Forbidden(_))));
        assert!(matches!(set_security("Spooler", "D:P(A;;GA;;;SY)"), Err(Win32Error::Forbidden(_))));
        assert!(matches!(set_required_privileges("Spooler", &[]), Err(Win32Error::Forbidden(_))));
    }

    #[test]
    fn writers_meet_the_guard_on_the_dev_machine() {
        if crate::guard::is_test_machine() {
            return;
        }
        assert!(matches!(set_start("Spooler", START_DISABLED), Err(Win32Error::Guard(_))));
        assert!(matches!(set_security(AGENT_SERVICE, "D:P(A;;GA;;;SY)"), Err(Win32Error::Guard(_))));
        assert!(matches!(set_required_privileges(AGENT_SERVICE, &["SeTcbPrivilege"]), Err(Win32Error::Guard(_))));
    }

    #[test]
    fn multi_strings_parse() {
        let mut units: Vec<u16> = "SeA\0SeB\0\0".encode_utf16().collect();
        assert_eq!(parse_multi_string(PWSTR(units.as_mut_ptr())), ["SeA", "SeB"]);
        let mut empty: Vec<u16> = vec![0, 0];
        assert!(parse_multi_string(PWSTR(empty.as_mut_ptr())).is_empty());
        assert!(parse_multi_string(PWSTR::null()).is_empty());
    }

    #[test]
    fn a_missing_service_reads_as_none() {
        assert_eq!(query("RuleboxNoSuchService").unwrap(), None);
        assert_eq!(get_security("RuleboxNoSuchService").unwrap(), None);
        assert!(get_required_privileges("RuleboxNoSuchService").unwrap().is_empty());
    }

    /// Reads a real, always-present service; never writes. Run by hand.
    #[test]
    #[ignore = "reads the real service control manager"]
    fn smoke_query_a_real_service() {
        let config = query("EventLog").unwrap().unwrap();
        assert_eq!(config.start, START_AUTO);
        let sddl = get_security("EventLog").unwrap().unwrap();
        assert!(sddl.starts_with("D:"), "{sddl}");
        println!("{:?}", get_required_privileges("EventLog").unwrap());
    }
}
