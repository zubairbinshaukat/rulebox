//! Security descriptors from SDDL, protected directories, token privileges.

use std::ffi::c_void;
use std::os::windows::fs::MetadataExt;
use std::path::Path;

use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{GetLastError, ERROR_NOT_ALL_ASSIGNED, ERROR_SUCCESS};
use windows::Win32::Security::Authorization::{
    ConvertSecurityDescriptorToStringSecurityDescriptorW,
    ConvertStringSecurityDescriptorToSecurityDescriptorW, GetNamedSecurityInfoW,
    SetNamedSecurityInfoW, SDDL_REVISION_1, SE_FILE_OBJECT,
};
use windows::Win32::Security::{
    AdjustTokenPrivileges, GetSecurityDescriptorDacl, GetTokenInformation, LookupPrivilegeValueW,
    TokenElevation, ACL, DACL_SECURITY_INFORMATION, LUID_AND_ATTRIBUTES, OWNER_SECURITY_INFORMATION,
    PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID, SECURITY_ATTRIBUTES,
    SE_PRIVILEGE_ENABLED, TOKEN_ADJUST_PRIVILEGES, TOKEN_ELEVATION, TOKEN_PRIVILEGES, TOKEN_QUERY,
};
use windows::Win32::Storage::FileSystem::{CreateDirectoryW, FILE_ATTRIBUTE_REPARSE_POINT};
use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

use crate::error::{api_err, code_err, Result, Win32Error};
use crate::guard::require_test_machine;
use crate::sid::{psid_to_string, Sid};
use crate::util::{from_wide_ptr, to_wide, LocalAllocGuard, OwnedHandle};

/// SYSTEM and Administrators full control, nobody else, no inheritance from the parent.
pub const PROTECTED_DIR_SDDL: &str = "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)";

/// A security descriptor built from SDDL, with the `SECURITY_ATTRIBUTES` that
/// points at it. Owns both; pass `as_ptr()` as `lpSecurityAttributes`.
pub struct SecurityAttributes {
    descriptor: LocalAllocGuard,
    // Boxed so the pointer from `as_ptr` stays valid when this value moves.
    attributes: Box<SECURITY_ATTRIBUTES>,
}

// SAFETY: the descriptor is immutable after construction and the attributes
// only point at it, so sharing or moving the value across threads is sound.
unsafe impl Send for SecurityAttributes {}
// SAFETY: see above; no method mutates the owned data.
unsafe impl Sync for SecurityAttributes {}

impl SecurityAttributes {
    pub fn from_sddl(sddl: &str) -> Result<Self> {
        let wide = to_wide(sddl);
        let mut psd = PSECURITY_DESCRIPTOR::default();
        // SAFETY: `wide` is NUL-terminated and outlives the call; `psd` is a valid out pointer.
        unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                PCWSTR(wide.as_ptr()),
                SDDL_REVISION_1,
                &mut psd,
                None,
            )
        }
        .map_err(|e| api_err("ConvertStringSecurityDescriptorToSecurityDescriptorW", &e))?;
        let descriptor = LocalAllocGuard::new(psd.0)?;
        let attributes = Box::new(SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor.as_ptr(),
            bInheritHandle: false.into(),
        });
        Ok(Self { descriptor, attributes })
    }

    /// Pointer to a `SECURITY_ATTRIBUTES`, valid while `self` lives.
    pub fn as_ptr(&self) -> *mut c_void {
        std::ptr::from_ref::<SECURITY_ATTRIBUTES>(&self.attributes).cast_mut().cast()
    }

    fn dacl(&self) -> Result<*mut ACL> {
        let (mut present, mut defaulted) = (false.into(), false.into());
        let mut dacl: *mut ACL = std::ptr::null_mut();
        // SAFETY: the descriptor is valid for the life of `self`; the out pointers are valid.
        unsafe {
            GetSecurityDescriptorDacl(
                PSECURITY_DESCRIPTOR(self.descriptor.as_ptr()),
                &mut present,
                &mut dacl,
                &mut defaulted,
            )
        }
        .map_err(|e| api_err("GetSecurityDescriptorDacl", &e))?;
        if !present.as_bool() || dacl.is_null() {
            return Err(Win32Error::Invalid("the SDDL has no DACL".into()));
        }
        Ok(dacl)
    }
}

/// Creates `path` (and missing parents) and makes its DACL exactly
/// `PROTECTED_DIR_SDDL`.
///
/// DESTRUCTIVE: guarded.
pub fn create_protected_dir(path: &Path) -> Result<()> {
    require_test_machine()?;
    let attrs = SecurityAttributes::from_sddl(PROTECTED_DIR_SDDL)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| Win32Error::Invalid(format!("cannot create {}: {e}", parent.display())))?;
    }
    let wide = to_wide(&path.to_string_lossy());
    if !path.exists() {
        // SAFETY: `wide` is NUL-terminated; `attrs` is a valid SECURITY_ATTRIBUTES.
        unsafe { CreateDirectoryW(PCWSTR(wide.as_ptr()), Some(attrs.as_ptr().cast())) }
            .map_err(|e| api_err("CreateDirectoryW", &e))?;
    }
    // Also covers a directory that already existed: protect it and replace its DACL.
    let dacl = attrs.dacl()?;
    // SAFETY: `wide` is NUL-terminated; `dacl` points into the descriptor owned by `attrs`.
    let status = unsafe {
        SetNamedSecurityInfoW(
            PCWSTR(wide.as_ptr()),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            None,
            None,
            Some(dacl),
            None,
        )
    };
    if status != ERROR_SUCCESS {
        return Err(code_err("SetNamedSecurityInfoW", status.0));
    }
    Ok(())
}

/// What `verify_protected_dir` found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirCheck {
    pub exists: bool,
    pub is_reparse_point: bool,
    pub owner: Option<Sid>,
    /// The DACL is protected and its entries equal `PROTECTED_DIR_SDDL`.
    pub dacl_matches: bool,
}

impl DirCheck {
    /// Exists, is not a reparse point, is owned by SYSTEM or Administrators, DACL matches.
    pub fn is_ok(&self) -> bool {
        self.exists
            && !self.is_reparse_point
            && self.dacl_matches
            && self
                .owner
                .as_ref()
                .is_some_and(|o| *o == Sid::system() || *o == Sid::builtin_admins())
    }
}

/// Read-only check of a protected directory.
pub fn verify_protected_dir(path: &Path) -> Result<DirCheck> {
    let meta = match std::fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(DirCheck { exists: false, is_reparse_point: false, owner: None, dacl_matches: false });
        }
        Err(e) => return Err(Win32Error::Invalid(format!("cannot read {}: {e}", path.display()))),
    };
    let is_reparse_point = meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0;

    let wide = to_wide(&path.to_string_lossy());
    let mut owner = PSID::default();
    let mut psd = PSECURITY_DESCRIPTOR::default();
    // SAFETY: `wide` is NUL-terminated; the out pointers are valid. The returned
    // descriptor (which the owner pointer points into) is freed by `guard`.
    let status = unsafe {
        GetNamedSecurityInfoW(
            PCWSTR(wide.as_ptr()),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            Some(&mut owner),
            None,
            None,
            None,
            &mut psd,
        )
    };
    if status != ERROR_SUCCESS {
        return Err(code_err("GetNamedSecurityInfoW", status.0));
    }
    let guard = LocalAllocGuard::new(psd.0)?;
    let owner = if owner.0.is_null() { None } else { Some(Sid::parse(&psid_to_string(owner)?)?) };

    let mut text = PWSTR::null();
    // SAFETY: `psd` is a valid descriptor owned by `guard`; `text` is a valid out pointer.
    unsafe {
        ConvertSecurityDescriptorToStringSecurityDescriptorW(
            PSECURITY_DESCRIPTOR(guard.as_ptr()),
            SDDL_REVISION_1,
            DACL_SECURITY_INFORMATION,
            &mut text,
            None,
        )
    }
    .map_err(|e| api_err("ConvertSecurityDescriptorToStringSecurityDescriptorW", &e))?;
    let text_guard = LocalAllocGuard::new(text.0.cast())?;
    // SAFETY: on success the API returns a NUL-terminated string, freed by `text_guard`.
    let sddl = unsafe { from_wide_ptr(text_guard.as_ptr().cast()) };

    Ok(DirCheck { exists: true, is_reparse_point, owner, dacl_matches: dacl_matches(&sddl) })
}

/// Splits `D:<flags>(ace)(ace)` into its flags and its entries.
fn split_dacl(sddl: &str) -> (&str, &str) {
    let body = sddl.strip_prefix("D:").unwrap_or(sddl);
    let at = body.find('(').unwrap_or(body.len());
    body.split_at(at)
}

/// True when the DACL is protected (`P`) and has exactly the expected entries.
/// Flags such as `AI` (auto-inherited) that the system adds are ignored.
fn dacl_matches(actual: &str) -> bool {
    let (flags, aces) = split_dacl(actual);
    let (_, expected_aces) = split_dacl(PROTECTED_DIR_SDDL);
    flags.contains('P') && aces == expected_aces
}

/// Enables privileges (by name, e.g. `"SeBackupPrivilege"`) on this process's
/// token. Fails if the token does not hold one of them.
pub fn enable_privileges(names: &[&str]) -> Result<()> {
    let mut token = Default::default();
    // SAFETY: the pseudo handle from `GetCurrentProcess` is always valid; `token` is a valid out pointer.
    unsafe {
        OpenProcessToken(GetCurrentProcess(), TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY, &mut token)
    }
    .map_err(|e| api_err("OpenProcessToken", &e))?;
    let token = OwnedHandle::new(token)?;

    for name in names {
        let wide = to_wide(name);
        let mut luid = Default::default();
        // SAFETY: `wide` is NUL-terminated; `luid` is a valid out pointer.
        unsafe { LookupPrivilegeValueW(PCWSTR::null(), PCWSTR(wide.as_ptr()), &mut luid) }
            .map_err(|e| api_err("LookupPrivilegeValueW", &e))?;
        let privileges = TOKEN_PRIVILEGES {
            PrivilegeCount: 1,
            Privileges: [LUID_AND_ATTRIBUTES { Luid: luid, Attributes: SE_PRIVILEGE_ENABLED }],
        };
        // SAFETY: the token handle is valid with ADJUST_PRIVILEGES; `privileges` is fully initialised.
        unsafe { AdjustTokenPrivileges(token.raw(), false, Some(&privileges), 0, None, None) }
            .map_err(|e| api_err("AdjustTokenPrivileges", &e))?;
        // Success is also returned when the privilege is not held; the last error tells.
        // SAFETY: plain read of the thread's last error.
        if unsafe { GetLastError() } == ERROR_NOT_ALL_ASSIGNED {
            return Err(Win32Error::Invalid(format!("the process token does not hold {name}")));
        }
    }
    Ok(())
}

/// True when this process runs with an elevated token (an administrator who
/// accepted the UAC prompt, or SYSTEM). The same `TokenElevation` test the admin
/// pipe applies to its clients. Read-only: it changes nothing, so it is not guarded.
pub fn process_is_elevated() -> Result<bool> {
    let mut token = Default::default();
    // SAFETY: the pseudo handle from `GetCurrentProcess` is always valid; `token` is a valid out pointer.
    unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) }
        .map_err(|e| api_err("OpenProcessToken", &e))?;
    let token = OwnedHandle::new(token)?;
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
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_process_token_can_be_read() {
        // Either answer is fine (it depends on how the tests were started); the
        // call must not fail.
        process_is_elevated().unwrap();
    }

    #[test]
    fn sddl_builds_and_garbage_fails() {
        let attrs = SecurityAttributes::from_sddl(PROTECTED_DIR_SDDL).unwrap();
        assert!(!attrs.as_ptr().is_null());
        assert!(attrs.dacl().is_ok());
        assert!(SecurityAttributes::from_sddl("garbage").is_err());
    }

    #[test]
    fn dacl_comparison() {
        assert!(dacl_matches("D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)"));
        assert!(dacl_matches(PROTECTED_DIR_SDDL));
        // Not protected.
        assert!(!dacl_matches("D:AI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)"));
        // Extra entry.
        assert!(!dacl_matches("D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;WD)"));
    }

    #[test]
    fn verify_reports_missing_and_unprotected_dirs() {
        let missing = verify_protected_dir(Path::new(r"C:\rulebox-no-such-dir-xyz")).unwrap();
        assert!(!missing.exists && !missing.is_ok());

        let windows = std::env::var_os("SystemRoot").unwrap_or_else(|| r"C:\Windows".into());
        let check = verify_protected_dir(Path::new(&windows)).unwrap();
        assert!(check.exists && !check.is_reparse_point);
        assert!(check.owner.is_some());
        assert!(!check.dacl_matches && !check.is_ok());
    }

    #[test]
    fn create_protected_dir_is_blocked_by_the_guard() {
        // The guard fails first, so nothing is created. The path is deliberately unusable.
        let err = create_protected_dir(Path::new(r"C:\rulebox-guard-test-must-not-exist\x")).unwrap_err();
        assert!(matches!(err, Win32Error::Guard(_)));
        assert!(!Path::new(r"C:\rulebox-guard-test-must-not-exist").exists());
    }

    #[test]
    fn enable_privileges_on_own_token() {
        // Held by every token and enabled by default: only changes this process.
        enable_privileges(&["SeChangeNotifyPrivilege"]).unwrap();
        assert!(enable_privileges(&["NoSuchPrivilegeRulebox"]).is_err());
    }
}
