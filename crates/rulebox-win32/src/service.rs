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
use crate::guard::require_armed_machine;
use crate::security::{dacl_sddl_of, SecurityAttributes};
use crate::util::to_wide;

/// The Rulebox agent's service name (plan Phase 2).
pub const AGENT_SERVICE: &str = "RuleboxAgent";

pub const START_AUTO: u32 = 2;
pub const START_MANUAL: u32 = 3;
pub const START_DISABLED: u32 = 4;

/// (Phase 5 Step 17, plan 4.16) The DACL of the agent service: SYSTEM and Administrators
/// have every right; a signed-in user (`IU`) and any authenticated user (`AU`) can only ask
/// for the status (`LC`): no stop, no start, no configuration, no read of the DACL.
/// Administrators keep everything on purpose: they need it for `recover` and for upgrades.
pub const AGENT_SERVICE_SDDL: &str =
    "D:(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)(A;;LC;;;IU)(A;;LC;;;AU)";

/// (Phase 5 Step 17, plan 4.16) The privileges the agent service keeps; Windows removes every
/// other one from its token at the next start. This is the plan's starting list.
/// `SeLoadDriverPrivilege` is in it because the agent publishes printer drivers (Step 14b).
// TODO(Step 21): measure on the VM which of these the agent really uses and shorten the list.
pub const AGENT_REQUIRED_PRIVILEGES: &[&str] = &[
    "SeTcbPrivilege",
    "SeAssignPrimaryTokenPrivilege",
    "SeIncreaseQuotaPrivilege",
    "SeSecurityPrivilege",
    "SeBackupPrivilege",
    "SeRestorePrivilege",
    "SeTakeOwnershipPrivilege",
    "SeDebugPrivilege",
    "SeShutdownPrivilege",
    "SeSystemProfilePrivilege",
    "SeImpersonatePrivilege",
    "SeChangeNotifyPrivilege",
    "SeCreateGlobalPrivilege",
    "SeLoadDriverPrivilege",
];

/// A service cannot start without this one (it is what lets a process walk folders).
pub const CHANGE_NOTIFY_PRIVILEGE: &str = "SeChangeNotifyPrivilege";

/// The rights an administrator must keep on the agent service: change the configuration,
/// start, stop, delete, and replace the DACL.
const ADMIN_MUST_KEEP: u32 = 0x0002 | 0x0010 | 0x0020 | 0x0001_0000 | 0x0004_0000;
const SERVICE_ALL_ACCESS_MASK: u32 = 0x000F_01FF;

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

/// (Phase 6 Step 22 run A3) Services whose configuration the SCM refuses to change, even for SYSTEM: `ChangeServiceConfigW`
/// answers "access denied" for the Application Identity service on Windows 10 and 11 (its DACL gives SYSTEM no
/// `SERVICE_CHANGE_CONFIG`). Their start type is the `Start` value of the service key, which SYSTEM may write (run A3, VM).
/// Without this, Disable kiosk could not put AppIDSvc back and stopped there.
const REGISTRY_START_SERVICES: &[&str] = &["AppIDSvc"];

fn uses_registry_start(name: &str) -> bool {
    REGISTRY_START_SERVICES.iter().any(|service| service.eq_ignore_ascii_case(name))
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

/// (Phase 5 Step 17) The rule of a required-privileges list (no API call, no guard). An
/// empty list is fine (it removes the limit). Any other list must hold
/// `SeChangeNotifyPrivilege` (without it the service would not start), must not name a
/// privilege twice, and every name looks like `Se...Privilege`.
pub fn check_required_privileges(privileges: &[&str]) -> Result<()> {
    if privileges.is_empty() {
        return Ok(());
    }
    for (index, name) in privileges.iter().enumerate() {
        let plain = name.len() > "SePrivilege".len()
            && name.starts_with("Se")
            && name.ends_with("Privilege")
            && name.chars().all(|c| c.is_ascii_alphanumeric());
        if !plain {
            return Err(Win32Error::Forbidden(format!("{name:?} is not a privilege name")));
        }
        if privileges[..index].iter().any(|earlier| earlier.eq_ignore_ascii_case(name)) {
            return Err(Win32Error::Forbidden(format!("{name} is listed twice")));
        }
    }
    if !privileges.iter().any(|name| name.eq_ignore_ascii_case(CHANGE_NOTIFY_PRIVILEGE)) {
        return Err(Win32Error::Forbidden(format!(
            "the list has no {CHANGE_NOTIFY_PRIVILEGE}: the service would not start"
        )));
    }
    Ok(())
}

/// The access mask of an SDDL rights field of a service ACE (`CCDCLC...`, `GA`, or `0x...`).
/// A letter pair this does not know adds nothing.
fn service_rights_mask(rights: &str) -> u32 {
    if let Some(hex) = rights.strip_prefix("0x").or_else(|| rights.strip_prefix("0X")) {
        return u32::from_str_radix(hex, 16).unwrap_or(0);
    }
    let bytes = rights.as_bytes();
    let mut mask = 0u32;
    for pair in bytes.chunks(2) {
        mask |= match pair {
            b"CC" => 0x0001,
            b"DC" => 0x0002,
            b"LC" => 0x0004,
            b"SW" => 0x0008,
            b"RP" => 0x0010,
            b"WP" => 0x0020,
            b"DT" => 0x0040,
            b"LO" => 0x0080,
            b"CR" => 0x0100,
            b"SD" => 0x0001_0000,
            b"RC" => 0x0002_0000,
            b"WD" => 0x0004_0000,
            b"WO" => 0x0008_0000,
            b"GA" => SERVICE_ALL_ACCESS_MASK,
            _ => 0,
        };
    }
    mask
}

/// (Phase 5 Step 17) The rule of a DACL for the agent service (no API call, no guard):
/// Administrators keep the rights to configure, start, stop and delete the service and to
/// replace its DACL, and no entry denies Administrators or SYSTEM anything. Rulebox never
/// makes its service unstoppable for an administrator (they need it for `recover` and for
/// upgrades).
pub fn check_service_sddl(sddl: &str) -> Result<()> {
    if !sddl.starts_with("D:") {
        return Err(Win32Error::Forbidden("the service security text has no DACL".into()));
    }
    let mut admin_mask = 0u32;
    for ace in sddl.split('(').skip(1) {
        let ace = ace.split(')').next().unwrap_or("");
        let fields: Vec<&str> = ace.split(';').collect();
        let (Some(kind), Some(rights), Some(sid)) = (fields.first(), fields.get(2), fields.get(5)) else {
            return Err(Win32Error::Forbidden("the service security text has a broken entry".into()));
        };
        let trusted = matches!(*sid, "BA" | "SY" | "S-1-5-32-544" | "S-1-5-18");
        if kind.starts_with('D') && trusted {
            return Err(Win32Error::Forbidden("the service DACL must not deny Administrators or SYSTEM".into()));
        }
        if *kind == "A" && matches!(*sid, "BA" | "S-1-5-32-544") {
            admin_mask |= service_rights_mask(rights);
        }
    }
    if admin_mask & ADMIN_MUST_KEEP == ADMIN_MUST_KEEP {
        Ok(())
    } else {
        Err(Win32Error::Forbidden("the service DACL must leave Administrators able to stop and change the service".into()))
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
    require_armed_machine()?;
    if uses_registry_start(name) {
        // The service must exist; its key is never created here.
        require_service(name, SERVICE_QUERY_CONFIG)?;
        return crate::registry::set_hklm(&format!(r"SYSTEM\CurrentControlSet\Services\{name}"), "Start", Some(&crate::registry::RegValue::Dword(start)));
    }
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
    check_service_sddl(sddl)?;
    require_armed_machine()?;
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
    check_required_privileges(privileges)?;
    require_armed_machine()?;
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
    fn the_application_identity_start_type_goes_through_the_registry() {
        assert!(uses_registry_start("AppIDSvc") && uses_registry_start("appidsvc"));
        assert!(!uses_registry_start("Spooler") && !uses_registry_start(AGENT_SERVICE));
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
        if crate::guard::is_armed_machine() {
            return;
        }
        assert!(matches!(set_start("Spooler", START_DISABLED), Err(Win32Error::Guard(_))));
        assert!(matches!(set_security(AGENT_SERVICE, AGENT_SERVICE_SDDL), Err(Win32Error::Guard(_))));
        assert!(matches!(set_required_privileges(AGENT_SERVICE, AGENT_REQUIRED_PRIVILEGES), Err(Win32Error::Guard(_))));
        assert!(matches!(set_required_privileges(AGENT_SERVICE, &[]), Err(Win32Error::Guard(_))));
    }

    // -- Phase 5 Step 17 ---------------------------------------------------------------------

    #[test]
    fn the_agent_service_dacl_is_the_one_of_plan_4_16() {
        assert_eq!(
            AGENT_SERVICE_SDDL,
            "D:(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)(A;;LC;;;IU)(A;;LC;;;AU)"
        );
        // SYSTEM and Administrators: every service right.
        assert_eq!(service_rights_mask("CCDCLCSWRPWPDTLOCRSDRCWDWO"), SERVICE_ALL_ACCESS_MASK);
        // Everybody else: query the status, nothing more (no stop 0x20, no config 0x2).
        assert_eq!(service_rights_mask("LC"), 0x0004);
        let others: Vec<&str> = AGENT_SERVICE_SDDL.split('(').skip(3).collect();
        assert_eq!(others, ["A;;LC;;;IU)", "A;;LC;;;AU)"]);
        assert!(check_service_sddl(AGENT_SERVICE_SDDL).is_ok());
        // Windows can parse it (a pure conversion: nothing on the machine changes).
        assert!(SecurityAttributes::from_sddl(AGENT_SERVICE_SDDL).is_ok());
    }

    #[test]
    fn a_service_dacl_never_locks_administrators_out() {
        // What Windows gives a new service, and a hex or generic spelling of full control.
        for good in [
            "D:(A;;CCLCSWRPWPDTLOCRRC;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)(A;;CCLCSWLOCRRC;;;IU)(A;;CCLCSWLOCRRC;;;SU)",
            "D:(A;;GA;;;SY)(A;;GA;;;BA)",
            "D:(A;;0xf01ff;;;S-1-5-32-544)",
        ] {
            assert!(check_service_sddl(good).is_ok(), "{good}");
        }
        for bad in [
            // No entry for Administrators at all.
            "D:P(A;;GA;;;SY)",
            // Administrators cannot stop it (no WP).
            "D:(A;;GA;;;SY)(A;;CCDCLCSWRPDTLOCRSDRCWDWO;;;BA)",
            // Administrators cannot replace the DACL (no WD).
            "D:(A;;GA;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWO;;;BA)",
            // A deny entry for Administrators or SYSTEM.
            "D:(D;;WP;;;BA)(A;;GA;;;BA)",
            "D:(D;;WP;;;SY)(A;;GA;;;BA)",
            "D:",
            "garbage",
            "D:(A;;GA)",
        ] {
            assert!(matches!(check_service_sddl(bad), Err(Win32Error::Forbidden(_))), "{bad}");
            assert!(matches!(set_security(AGENT_SERVICE, bad), Err(Win32Error::Forbidden(_))), "{bad}");
        }
    }

    #[test]
    fn the_required_privileges_are_the_starting_list_and_pass_the_rule() {
        assert!(check_required_privileges(AGENT_REQUIRED_PRIVILEGES).is_ok());
        assert_eq!(AGENT_REQUIRED_PRIVILEGES.len(), 14);
        for needed in [
            "SeTcbPrivilege",
            "SeAssignPrimaryTokenPrivilege",
            "SeIncreaseQuotaPrivilege",
            "SeBackupPrivilege",
            "SeRestorePrivilege",
            "SeChangeNotifyPrivilege",
        ] {
            assert!(AGENT_REQUIRED_PRIVILEGES.contains(&needed), "{needed}");
        }
    }

    #[test]
    fn a_privilege_list_without_change_notify_is_refused() {
        // The service would not start with it.
        let without: Vec<&str> =
            AGENT_REQUIRED_PRIVILEGES.iter().copied().filter(|name| *name != CHANGE_NOTIFY_PRIVILEGE).collect();
        assert_eq!(without.len(), AGENT_REQUIRED_PRIVILEGES.len() - 1);
        let error = check_required_privileges(&without).unwrap_err();
        assert!(matches!(&error, Win32Error::Forbidden(text) if text.contains("would not start")), "{error:?}");
        // Refused before the guard and before any API call.
        assert!(matches!(set_required_privileges(AGENT_SERVICE, &without), Err(Win32Error::Forbidden(_))));
        assert!(matches!(set_required_privileges(AGENT_SERVICE, &["SeTcbPrivilege"]), Err(Win32Error::Forbidden(_))));
        // An empty list removes the limit: allowed.
        assert!(check_required_privileges(&[]).is_ok());
        // Not a privilege name, or the same one twice.
        for bad in [
            vec!["SeChangeNotifyPrivilege", "Administrator"],
            vec!["SeChangeNotifyPrivilege", "Se Tcb Privilege"],
            vec!["SeChangeNotifyPrivilege", ""],
            vec!["SeChangeNotifyPrivilege", "SePrivilege"],
            vec!["SeChangeNotifyPrivilege", "sechangenotifyprivilege"],
        ] {
            assert!(matches!(check_required_privileges(&bad), Err(Win32Error::Forbidden(_))), "{bad:?}");
        }
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
