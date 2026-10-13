//! SIDs as validated strings, plus read-only account lookups.

use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{ERROR_INSUFFICIENT_BUFFER, ERROR_NONE_MAPPED};
use windows::Win32::Security::Authorization::{ConvertSidToStringSidW, ConvertStringSidToSidW};
use windows::Win32::Security::{
    GetTokenInformation, LookupAccountNameW, LookupAccountSidW, PSID, SID_NAME_USE, TokenUser,
    TOKEN_QUERY, TOKEN_USER,
};
use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

use crate::error::{api_err, Result, Win32Error};
use crate::util::{from_wide_ptr, to_wide, LocalAllocGuard, OwnedHandle};

/// A SID in canonical `S-1-...` string form, validated by the system.
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub struct Sid(String);

impl Sid {
    pub fn parse(s: &str) -> Result<Sid> {
        // The API also accepts aliases such as "SY"; only the numeric form is allowed here.
        if !s.starts_with("S-1-") {
            return Err(Win32Error::Invalid(format!("not a SID string: {s:?}")));
        }
        let guard = string_to_psid(s)?;
        Ok(Sid(psid_to_string(PSID(guard.as_ptr()))?))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn system() -> Sid {
        Sid("S-1-5-18".into())
    }

    pub fn builtin_admins() -> Sid {
        Sid("S-1-5-32-544".into())
    }

    pub fn builtin_users() -> Sid {
        Sid("S-1-5-32-545".into())
    }
}

impl std::fmt::Display for Sid {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// Converts a SID string to a system-allocated `PSID`.
pub(crate) fn string_to_psid(s: &str) -> Result<LocalAllocGuard> {
    let wide = to_wide(s);
    let mut psid = PSID::default();
    // SAFETY: `wide` is NUL-terminated and outlives the call; `psid` is a valid out pointer.
    unsafe { ConvertStringSidToSidW(PCWSTR(wide.as_ptr()), &mut psid) }
        .map_err(|e| api_err("ConvertStringSidToSidW", &e))?;
    LocalAllocGuard::new(psid.0)
}

/// Converts a valid `PSID` to its string form.
pub(crate) fn psid_to_string(psid: PSID) -> Result<String> {
    let mut out = PWSTR::null();
    // SAFETY: the caller passes a valid SID; `out` is a valid out pointer.
    unsafe { ConvertSidToStringSidW(psid, &mut out) }
        .map_err(|e| api_err("ConvertSidToStringSidW", &e))?;
    let guard = LocalAllocGuard::new(out.0.cast())?;
    // SAFETY: on success the API returns a NUL-terminated string, which `guard` frees.
    Ok(unsafe { from_wide_ptr(guard.as_ptr().cast()) })
}

/// The SID of the user this process runs as.
pub fn current_user_sid() -> Result<Sid> {
    let mut token = Default::default();
    // SAFETY: the pseudo handle from `GetCurrentProcess` is always valid; `token` is a valid out pointer.
    unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) }
        .map_err(|e| api_err("OpenProcessToken", &e))?;
    let token = OwnedHandle::new(token)?;

    user_sid_of_token(&token)
}

/// The user SID of a token opened with `TOKEN_QUERY`.
pub(crate) fn user_sid_of_token(token: &OwnedHandle) -> Result<Sid> {
    let mut needed = 0u32;
    // SAFETY: a null buffer with size 0 only queries the required size.
    let first = unsafe { GetTokenInformation(token.raw(), TokenUser, None, 0, &mut needed) };
    match first {
        Err(e) if e.code() == ERROR_INSUFFICIENT_BUFFER.to_hresult() => {}
        Err(e) => return Err(api_err("GetTokenInformation", &e)),
        Ok(()) => return Err(Win32Error::Invalid("empty token user".into())),
    }
    // u64 elements keep the buffer aligned for TOKEN_USER.
    let mut buf = vec![0u64; (needed as usize).div_ceil(8)];
    // SAFETY: `buf` is at least `needed` bytes.
    unsafe { GetTokenInformation(token.raw(), TokenUser, Some(buf.as_mut_ptr().cast()), needed, &mut needed) }
        .map_err(|e| api_err("GetTokenInformation", &e))?;
    // SAFETY: the buffer now holds an aligned TOKEN_USER whose SID points inside the buffer.
    let sid = unsafe { (*buf.as_ptr().cast::<TOKEN_USER>()).User.Sid };
    Ok(Sid(psid_to_string(sid)?))
}

/// Looks up an account (`name` or `DOMAIN\name`). `Ok(None)` if it does not exist.
pub fn lookup_account_name(name: &str) -> Result<Option<Sid>> {
    let wide = to_wide(name);
    let (mut sid_len, mut dom_len) = (0u32, 0u32);
    let mut kind = SID_NAME_USE::default();
    // SAFETY: null buffers with zero sizes only query the required sizes.
    let first = unsafe {
        LookupAccountNameW(
            PCWSTR::null(),
            PCWSTR(wide.as_ptr()),
            None,
            &mut sid_len,
            None,
            &mut dom_len,
            &mut kind,
        )
    };
    match first {
        Err(e) if e.code() == ERROR_NONE_MAPPED.to_hresult() => return Ok(None),
        Err(e) if e.code() == ERROR_INSUFFICIENT_BUFFER.to_hresult() => {}
        Err(e) => return Err(api_err("LookupAccountNameW", &e)),
        Ok(()) => {}
    }
    let mut sid_buf = vec![0u64; (sid_len as usize).div_ceil(8).max(1)];
    let mut dom_buf = vec![0u16; dom_len as usize + 1];
    // SAFETY: the buffers are at least as large as the sizes passed.
    let second = unsafe {
        LookupAccountNameW(
            PCWSTR::null(),
            PCWSTR(wide.as_ptr()),
            Some(PSID(sid_buf.as_mut_ptr().cast())),
            &mut sid_len,
            Some(PWSTR(dom_buf.as_mut_ptr())),
            &mut dom_len,
            &mut kind,
        )
    };
    match second {
        Err(e) if e.code() == ERROR_NONE_MAPPED.to_hresult() => Ok(None),
        Err(e) => Err(api_err("LookupAccountNameW", &e)),
        Ok(()) => Ok(Some(Sid(psid_to_string(PSID(sid_buf.as_mut_ptr().cast()))?))),
    }
}

/// The account name the system shows for a SID, for example
/// `S-1-5-32-545` -> "Users" / "Benutzer".
pub fn localized_group_name(sid: &Sid) -> Result<String> {
    lookup_account_sid(sid)?
        .map(|(_, name)| name)
        .ok_or_else(|| Win32Error::Invalid(format!("no account has the SID {sid}")))
}

/// `(domain, name)` of a SID, for example `("DESK-1", "Owner")`. `Ok(None)` if the
/// SID maps to no account.
pub fn lookup_account_sid(sid: &Sid) -> Result<Option<(String, String)>> {
    let psid = string_to_psid(sid.as_str())?;
    let psid = PSID(psid.as_ptr());
    let (mut name_len, mut dom_len) = (0u32, 0u32);
    let mut kind = SID_NAME_USE::default();
    // SAFETY: `psid` is a valid SID; null buffers with zero sizes only query the sizes.
    let first = unsafe {
        LookupAccountSidW(PCWSTR::null(), psid, None, &mut name_len, None, &mut dom_len, &mut kind)
    };
    match first {
        Err(e) if e.code() == ERROR_NONE_MAPPED.to_hresult() => return Ok(None),
        Err(e) if e.code() == ERROR_INSUFFICIENT_BUFFER.to_hresult() => {}
        Err(e) => return Err(api_err("LookupAccountSidW", &e)),
        Ok(()) => {}
    }
    let mut name = vec![0u16; name_len as usize + 1];
    let mut dom = vec![0u16; dom_len as usize + 1];
    // SAFETY: the buffers are at least as large as the sizes passed.
    unsafe {
        LookupAccountSidW(
            PCWSTR::null(),
            psid,
            Some(PWSTR(name.as_mut_ptr())),
            &mut name_len,
            Some(PWSTR(dom.as_mut_ptr())),
            &mut dom_len,
            &mut kind,
        )
    }
    .map_err(|e| api_err("LookupAccountSidW", &e))?;
    // SAFETY: the API wrote NUL-terminated strings into both buffers (they were
    // zero-filled and one unit longer than the sizes passed).
    let (dom, name) = unsafe { (from_wide_ptr(dom.as_ptr()), from_wide_ptr(name.as_ptr())) };
    Ok(Some((dom, name)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_accepts_system_and_rejects_names() {
        assert_eq!(Sid::parse("S-1-5-18").unwrap(), Sid::system());
        assert_eq!(Sid::parse("S-1-5-32-544").unwrap(), Sid::builtin_admins());
        assert!(Sid::parse("Staff").is_err());
        assert!(Sid::parse("").is_err());
        assert!(Sid::parse("SY").is_err());
        assert!(Sid::parse("S-1-").is_err());
    }

    #[test]
    fn current_user_is_a_domain_or_local_sid() {
        let sid = current_user_sid().unwrap();
        assert!(sid.as_str().starts_with("S-1-5-21-"), "{sid}");
    }

    #[test]
    fn builtin_users_has_a_name() {
        assert!(!localized_group_name(&Sid::builtin_users()).unwrap().is_empty());
        let (domain, name) = lookup_account_sid(&Sid::system()).unwrap().unwrap();
        assert!(!domain.is_empty() && !name.is_empty());
        // A well-formed SID that belongs to nobody.
        let nobody = Sid::parse("S-1-5-21-1-2-3-999999").unwrap();
        assert_eq!(lookup_account_sid(&nobody).unwrap(), None);
    }

    #[test]
    fn account_lookup() {
        assert_eq!(lookup_account_name("SYSTEM").unwrap(), Some(Sid::system()));
        assert_eq!(lookup_account_name("no-such-account-rulebox-xyz").unwrap(), None);
    }
}
