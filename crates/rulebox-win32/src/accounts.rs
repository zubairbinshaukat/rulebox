//! Local user accounts: lookups (read-only) and the Staff account's lifecycle
//! (guarded; they run on a test machine only).
//!
//! Rulebox only ever creates, changes or deletes the one account it made. Every
//! function that changes an account first refuses administrator accounts, and
//! deletion also checks that the name still maps to the SID the caller holds.

use std::path::PathBuf;

use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::HANDLE;
use windows::Win32::NetworkManagement::NetManagement::{
    NetLocalGroupAddMembers, NetUserAdd, NetUserDel, NetUserEnum, NetUserGetInfo, NetUserSetInfo,
    FILTER_NORMAL_ACCOUNT, LOCALGROUP_MEMBERS_INFO_0, UF_ACCOUNTDISABLE, UF_DONT_EXPIRE_PASSWD,
    UF_PASSWD_CANT_CHANGE, UF_SCRIPT, USER_ACCOUNT_FLAGS, USER_INFO_1, USER_INFO_1003, USER_INFO_1011,
    USER_PRIV_ADMIN, USER_PRIV_USER,
};
use windows::Win32::Security::{LogonUserW, LOGON32_LOGON_NETWORK, LOGON32_PROVIDER_DEFAULT, PSID};
use windows::Win32::UI::Shell::{CreateProfile, DeleteProfileW};

use crate::error::{api_err, code_err, Result, Win32Error};
use crate::guard::require_test_machine;
use crate::registry::{get_hklm, RegValue};
use crate::sid::{localized_group_name, lookup_account_name, Sid};
use crate::util::{from_wide_ptr, pwstr_to_string, to_wide, NetApiBuffer, OwnedHandle, SecretWide};

const NERR_USER_EXISTS: u32 = 2224;
const NERR_USER_NOT_FOUND: u32 = 2221;
const NERR_PASSWORD_TOO_SHORT: u32 = 2245;
const ERROR_MEMBER_IN_ALIAS: u32 = 1378;
const ERROR_LOGON_FAILURE: u32 = 1326;
const ERROR_ACCOUNT_RESTRICTION: u32 = 1327;
const ERROR_ACCOUNT_DISABLED: u32 = 1331;
const ERROR_ACCOUNT_LOCKED_OUT: u32 = 1909;
const ERROR_PASSWORD_EXPIRED: u32 = 1330;
const ERROR_PASSWORD_MUST_CHANGE: u32 = 1907;
const HRESULT_ALREADY_EXISTS: u32 = 0x8007_00B7;
const MAX_PREFERRED_LENGTH: u32 = u32::MAX;
const PROFILE_LIST_KEY: &str = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList";
const MAX_USER_NAME: usize = 20;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UserInfo {
    pub name: String,
    pub sid: Sid,
    pub comment: String,
    pub disabled: bool,
    /// The account is a member of the Administrators group.
    pub is_admin: bool,
}

/// Rejects names the account APIs would treat specially (domain parts, wildcards,
/// separators) so a name is always one plain local user name.
fn check_user_name(name: &str) -> Result<()> {
    let bad = |c: char| matches!(c, '\\' | '/' | '"' | '[' | ']' | ':' | ';' | '|' | '=' | ',' | '+' | '*' | '?' | '<' | '>' | '@')
        || c.is_control();
    if name.is_empty() || name.chars().count() > MAX_USER_NAME || name.chars().any(bad) {
        return Err(Win32Error::Invalid(format!("not a plain local user name: {name:?}")));
    }
    Ok(())
}

/// Reads `USER_INFO_1` for `name`. `Ok(None)` when no such local user exists.
fn user_info_1(name: &str) -> Result<Option<(String, bool, bool)>> {
    let wide = to_wide(name);
    let mut buffer: *mut u8 = std::ptr::null_mut();
    // SAFETY: a null server name is the local machine; `wide` is NUL-terminated and
    // outlives the call; `buffer` is a valid out pointer.
    let status = unsafe { NetUserGetInfo(PCWSTR::null(), PCWSTR(wide.as_ptr()), 1, &mut buffer) };
    let guard = NetApiBuffer::new(buffer);
    if status == NERR_USER_NOT_FOUND {
        return Ok(None);
    }
    if status != 0 {
        return Err(code_err("NetUserGetInfo", status));
    }
    // SAFETY: on success `buffer` points at one USER_INFO_1, which `guard` frees.
    let info = unsafe { &*guard.as_ptr().cast::<USER_INFO_1>() };
    let comment = pwstr_to_string(info.usri1_comment);
    let disabled = info.usri1_flags.0 & UF_ACCOUNTDISABLE.0 != 0;
    let is_admin = info.usri1_priv == USER_PRIV_ADMIN;
    Ok(Some((comment, disabled, is_admin)))
}

/// The local user `name`, or `None` if there is none.
pub fn find_user(name: &str) -> Result<Option<UserInfo>> {
    check_user_name(name)?;
    let Some((comment, disabled, is_admin)) = user_info_1(name)? else {
        return Ok(None);
    };
    let Some(sid) = lookup_account_name(name)? else {
        return Ok(None);
    };
    Ok(Some(UserInfo { name: name.to_string(), sid, comment, disabled, is_admin }))
}

/// Enabled local accounts that have administrator rights. This walks the local
/// account database (`NetUserEnum`) instead of the Administrators group members,
/// because an account linked to a Microsoft account appears in the group as
/// `MicrosoftAccount\name`, not as `COMPUTER\name`, yet it is a local account the
/// owner signs in with. Domain and work accounts are not counted: the check is
/// about a local way back.
pub fn enabled_local_admins() -> Result<Vec<UserInfo>> {
    let mut buffer: *mut u8 = std::ptr::null_mut();
    let (mut read, mut total) = (0u32, 0u32);
    // SAFETY: a null server name is the local machine; the out pointers are valid.
    // Level 1 returns name, privilege level, flags and comment for each account.
    let status = unsafe {
        NetUserEnum(
            PCWSTR::null(),
            1,
            FILTER_NORMAL_ACCOUNT,
            &mut buffer,
            MAX_PREFERRED_LENGTH,
            &mut read,
            &mut total,
            None,
        )
    };
    let guard = NetApiBuffer::new(buffer);
    if status != 0 {
        return Err(code_err("NetUserEnum", status));
    }

    let mut admins = Vec::new();
    for index in 0..read as usize {
        // SAFETY: the API returned `read` consecutive USER_INFO_1 entries starting
        // at `buffer`, which `guard` keeps alive.
        let entry = unsafe { &*guard.as_ptr().cast::<USER_INFO_1>().add(index) };
        let disabled = entry.usri1_flags.0 & UF_ACCOUNTDISABLE.0 != 0;
        if disabled || entry.usri1_priv != USER_PRIV_ADMIN {
            continue;
        }
        let name = pwstr_to_string(entry.usri1_name);
        let Some(sid) = lookup_account_name(&name)? else {
            continue;
        };
        admins.push(UserInfo {
            name,
            sid,
            comment: pwstr_to_string(entry.usri1_comment),
            disabled,
            is_admin: true,
        });
    }
    Ok(admins)
}

/// Creates a standard (non-administrator) local user that is a member of the
/// built-in Users group and returns its SID.
///
/// DESTRUCTIVE: guarded.
pub fn create_standard_user(name: &str, full_name: &str, comment: &str, password: &str) -> Result<Sid> {
    require_test_machine()?;
    check_user_name(name)?;

    let mut name_w = to_wide(name);
    let mut comment_w = to_wide(comment);
    let mut password_w = SecretWide::new(password);
    let info = USER_INFO_1 {
        usri1_name: PWSTR(name_w.as_mut_ptr()),
        usri1_password: password_w.as_pwstr(),
        usri1_password_age: 0,
        usri1_priv: USER_PRIV_USER,
        usri1_home_dir: PWSTR::null(),
        usri1_comment: PWSTR(comment_w.as_mut_ptr()),
        usri1_flags: USER_ACCOUNT_FLAGS(UF_SCRIPT.0 | UF_DONT_EXPIRE_PASSWD.0 | UF_PASSWD_CANT_CHANGE.0),
        usri1_script_path: PWSTR::null(),
    };
    let mut parm_err = 0u32;
    // SAFETY: `info` is a valid USER_INFO_1 whose string pointers live until the
    // call returns; a null server name is the local machine.
    let status = unsafe {
        NetUserAdd(PCWSTR::null(), 1, std::ptr::from_ref(&info).cast::<u8>(), Some(&mut parm_err))
    };
    match status {
        0 => {}
        NERR_USER_EXISTS => return Err(Win32Error::AlreadyExists),
        NERR_PASSWORD_TOO_SHORT => return Err(Win32Error::PasswordPolicy),
        other => return Err(code_err("NetUserAdd", other)),
    }

    // From here on, undo the user if a later step fails.
    let finish = (|| -> Result<Sid> {
        let mut full_w = to_wide(full_name);
        let full = USER_INFO_1011 { usri1011_full_name: PWSTR(full_w.as_mut_ptr()) };
        // SAFETY: `full` is a valid USER_INFO_1011 that outlives the call.
        let status = unsafe {
            NetUserSetInfo(
                PCWSTR::null(),
                PCWSTR(name_w.as_ptr()),
                1011,
                std::ptr::from_ref(&full).cast::<u8>(),
                None,
            )
        };
        if status != 0 {
            return Err(code_err("NetUserSetInfo", status));
        }
        let sid = lookup_account_name(name)?
            .ok_or_else(|| Win32Error::Invalid("the new account has no SID".into()))?;
        add_to_users_group(&sid)?;
        Ok(sid)
    })();

    match finish {
        Ok(sid) => Ok(sid),
        Err(error) => {
            // SAFETY: `name_w` is NUL-terminated; deleting the account this call made.
            let _ = unsafe { NetUserDel(PCWSTR::null(), PCWSTR(name_w.as_ptr())) };
            Err(error)
        }
    }
}

fn add_to_users_group(sid: &Sid) -> Result<()> {
    let group = localized_group_name(&Sid::builtin_users())?;
    let group_w = to_wide(&group);
    let psid = crate::sid::string_to_psid(sid.as_str())?;
    let member = LOCALGROUP_MEMBERS_INFO_0 { lgrmi0_sid: PSID(psid.as_ptr()) };
    // SAFETY: `member` is a valid LOCALGROUP_MEMBERS_INFO_0 pointing at a SID that
    // `psid` keeps alive; level 0 takes one SID per entry.
    let status = unsafe {
        NetLocalGroupAddMembers(
            PCWSTR::null(),
            PCWSTR(group_w.as_ptr()),
            0,
            std::ptr::from_ref(&member).cast::<u8>(),
            1,
        )
    };
    match status {
        0 | ERROR_MEMBER_IN_ALIAS => Ok(()),
        other => Err(code_err("NetLocalGroupAddMembers", other)),
    }
}

/// Refuses an account that does not exist or that is an administrator.
fn require_plain_user(name: &str) -> Result<()> {
    check_user_name(name)?;
    match user_info_1(name)? {
        None => Err(Win32Error::NotFound),
        Some((_, _, true)) => Err(Win32Error::Invalid(format!("{name:?} is an administrator account"))),
        Some(_) => Ok(()),
    }
}

/// Sets the password of the standard user `name`.
///
/// DESTRUCTIVE: guarded.
pub fn set_password(name: &str, password: &str) -> Result<()> {
    require_test_machine()?;
    require_plain_user(name)?;
    let name_w = to_wide(name);
    let mut password_w = SecretWide::new(password);
    let info = USER_INFO_1003 { usri1003_password: password_w.as_pwstr() };
    // SAFETY: `info` is a valid USER_INFO_1003 that outlives the call.
    let status = unsafe {
        NetUserSetInfo(
            PCWSTR::null(),
            PCWSTR(name_w.as_ptr()),
            1003,
            std::ptr::from_ref(&info).cast::<u8>(),
            None,
        )
    };
    match status {
        0 => Ok(()),
        NERR_PASSWORD_TOO_SHORT => Err(Win32Error::PasswordPolicy),
        NERR_USER_NOT_FOUND => Err(Win32Error::NotFound),
        other => Err(code_err("NetUserSetInfo", other)),
    }
}

/// Checks `name`/`password` with a network logon. `Ok(false)` for a wrong
/// password or a refused account; any other failure is an error.
///
/// DESTRUCTIVE: guarded (a wrong password counts toward the account lockout).
pub fn test_logon(name: &str, password: &str) -> Result<bool> {
    require_test_machine()?;
    check_user_name(name)?;
    let name_w = to_wide(name);
    let domain_w = to_wide(".");
    let password_w = SecretWide::new(password);
    let mut token = HANDLE::default();
    // SAFETY: the strings are NUL-terminated and outlive the call; `token` is a
    // valid out pointer. "." means the local account database.
    let result = unsafe {
        LogonUserW(
            PCWSTR(name_w.as_ptr()),
            PCWSTR(domain_w.as_ptr()),
            password_w.as_pcwstr(),
            LOGON32_LOGON_NETWORK,
            LOGON32_PROVIDER_DEFAULT,
            &mut token,
        )
    };
    match result {
        Ok(()) => {
            // Closed at once by the guard's `Drop`.
            let _token = OwnedHandle::new(token)?;
            Ok(true)
        }
        Err(error) => {
            let code = match api_err("LogonUserW", &error) {
                Win32Error::Api { code, .. } => code,
                other => return Err(other),
            };
            match code {
                ERROR_LOGON_FAILURE
                | ERROR_ACCOUNT_RESTRICTION
                | ERROR_ACCOUNT_DISABLED
                | ERROR_ACCOUNT_LOCKED_OUT
                | ERROR_PASSWORD_EXPIRED
                | ERROR_PASSWORD_MUST_CHANGE => Ok(false),
                other => Err(code_err("LogonUserW", other)),
            }
        }
    }
}

/// Creates the profile of `sid` (so its registry hive exists) and returns the
/// profile folder; an existing profile's folder is read from `ProfileList`.
///
/// DESTRUCTIVE: guarded.
pub fn ensure_profile(sid: &Sid, name: &str) -> Result<PathBuf> {
    require_test_machine()?;
    check_user_name(name)?;
    let sid_w = to_wide(sid.as_str());
    let name_w = to_wide(name);
    let mut path = vec![0u16; 520];
    // SAFETY: both strings are NUL-terminated; `path` is a writable buffer whose
    // length in characters is passed.
    let created = unsafe {
        CreateProfile(PCWSTR(sid_w.as_ptr()), PCWSTR(name_w.as_ptr()), &mut path)
    };
    match created {
        // SAFETY: on success the API wrote a NUL-terminated string into `path`.
        Ok(()) => Ok(PathBuf::from(unsafe { from_wide_ptr(path.as_ptr()) })),
        Err(error) if error.code().0 as u32 == HRESULT_ALREADY_EXISTS => profile_path(sid),
        Err(error) => Err(api_err("CreateProfile", &error)),
    }
}

/// The profile folder of `sid` from `ProfileList\<SID>\ProfileImagePath`
/// (read-only). `NotFound` when the account has no profile yet.
pub fn profile_path(sid: &Sid) -> Result<PathBuf> {
    let key = format!(r"{PROFILE_LIST_KEY}\{}", sid.as_str());
    match get_hklm(&key, "ProfileImagePath")? {
        Some(RegValue::String(path)) if !path.is_empty() => Ok(PathBuf::from(path)),
        _ => Err(Win32Error::NotFound),
    }
}

/// Deletes the profile and then the account. The caller signs the session out
/// first. Refuses an administrator account and a name that no longer maps to `sid`.
///
/// DESTRUCTIVE: guarded.
pub fn delete_user_and_profile(sid: &Sid, name: &str) -> Result<()> {
    require_test_machine()?;
    require_plain_user(name)?;
    match lookup_account_name(name)? {
        Some(found) if found == *sid => {}
        Some(_) => return Err(Win32Error::Invalid(format!("{name:?} is not the account with SID {sid}"))),
        None => return Err(Win32Error::NotFound),
    }

    let sid_w = to_wide(sid.as_str());
    // SAFETY: `sid_w` is NUL-terminated; null profile and computer name mean the
    // default profile location on this machine.
    let deleted = unsafe { DeleteProfileW(PCWSTR(sid_w.as_ptr()), PCWSTR::null(), PCWSTR::null()) };
    if let Err(error) = deleted {
        let code = match api_err("DeleteProfileW", &error) {
            Win32Error::Api { code, .. } => code,
            other => return Err(other),
        };
        // 2 and 3: there is no profile (the account never signed in); fine.
        if code != 2 && code != 3 {
            return Err(code_err("DeleteProfileW", code));
        }
    }

    let name_w = to_wide(name);
    // SAFETY: `name_w` is NUL-terminated.
    let status = unsafe { NetUserDel(PCWSTR::null(), PCWSTR(name_w.as_ptr())) };
    match status {
        0 | NERR_USER_NOT_FOUND => Ok(()),
        other => Err(code_err("NetUserDel", other)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_names_are_plain() {
        assert!(check_user_name("RuleboxStaff").is_ok());
        for bad in ["", "DOMAIN\\user", "a/b", "name@host", "x*", &"n".repeat(21)] {
            assert!(check_user_name(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn find_user_for_the_staff_account_is_none_on_this_machine() {
        // Plan test 2: if this returns Some, stop and tell the user.
        assert!(find_user("RuleboxStaff").unwrap().is_none(), "RuleboxStaff exists on the dev machine");
    }

    #[test]
    fn a_missing_user_is_none_and_an_existing_one_has_a_sid() {
        assert!(find_user("rbx-no-such-user").unwrap().is_none());
        let current = std::env::var("USERNAME").unwrap();
        if let Some(user) = find_user(&current).unwrap() {
            assert!(user.sid.as_str().starts_with("S-1-5-21-"));
        }
    }

    #[test]
    fn the_local_admin_list_can_be_read() {
        let admins = enabled_local_admins().unwrap();
        assert!(admins.iter().all(|a| !a.disabled));
    }

    #[test]
    fn every_mutating_function_is_blocked_by_the_guard() {
        if crate::guard::is_test_machine() {
            return;
        }
        let sid = crate::sid::current_user_sid().unwrap();
        assert!(matches!(create_standard_user("rbx", "n", "c", "pw"), Err(Win32Error::Guard(_))));
        assert!(matches!(set_password("rbx", "pw"), Err(Win32Error::Guard(_))));
        assert!(matches!(test_logon("rbx", "pw"), Err(Win32Error::Guard(_))));
        assert!(matches!(ensure_profile(&sid, "rbx"), Err(Win32Error::Guard(_))));
        assert!(matches!(delete_user_and_profile(&sid, "rbx"), Err(Win32Error::Guard(_))));
    }
}
