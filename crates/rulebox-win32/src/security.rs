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
    UNPROTECTED_DACL_SECURITY_INFORMATION,
};
use windows::Win32::Storage::FileSystem::{CreateDirectoryW, FILE_ATTRIBUTE_REPARSE_POINT};
use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

use crate::error::{api_err, code_err, Result, Win32Error};
use crate::guard::require_armed_machine;
use crate::sid::{psid_to_string, Sid};
use crate::util::{from_wide_ptr, to_wide, LocalAllocGuard, OwnedHandle};

/// SYSTEM and Administrators full control, nobody else, no inheritance from the parent.
pub const PROTECTED_DIR_SDDL: &str = "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)";

/// (Phase 5 Step 17, plan 4.16) The install folder (`%ProgramFiles%\Rulebox`): SYSTEM and
/// Administrators full control, Users read and execute (`0x1200a9`), no inheritance from the
/// parent. A standard user (the Staff account) can run the programs and cannot change them.
pub const INSTALL_DIR_SDDL: &str = "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;BU)";

/// (Phase 5 Step 17) A DACL as it is compared: the flags Windows adds by itself when it
/// stores one (`AI` auto-inherited, `AR` auto-inherit requested) are dropped; `P`
/// (protected) and the entries, in their order, stay. No API call.
pub fn normalize_dacl(sddl: &str) -> String {
    let (flags, aces) = split_dacl(sddl);
    let flags = flags.replace("AI", "").replace("AR", "");
    format!("D:{flags}{aces}")
}

/// (Phase 5 Step 17) Whether two DACLs say the same thing ([`normalize_dacl`]).
pub fn same_dacl(a: &str, b: &str) -> bool {
    normalize_dacl(a) == normalize_dacl(b)
}

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
    require_armed_machine()?;
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

/// The DACL of a security descriptor as SDDL (`D:...`), flags included (`P`, `AI`).
pub(crate) fn dacl_sddl_of(descriptor: PSECURITY_DESCRIPTOR) -> Result<String> {
    let mut text = PWSTR::null();
    // SAFETY: the caller passes a valid descriptor; `text` is a valid out pointer.
    unsafe {
        ConvertSecurityDescriptorToStringSecurityDescriptorW(
            descriptor,
            SDDL_REVISION_1,
            DACL_SECURITY_INFORMATION,
            &mut text,
            None,
        )
    }
    .map_err(|e| api_err("ConvertSecurityDescriptorToStringSecurityDescriptorW", &e))?;
    let guard = LocalAllocGuard::new(text.0.cast())?;
    // SAFETY: on success the API returns a NUL-terminated string, freed by `guard`.
    Ok(unsafe { from_wide_ptr(guard.as_ptr().cast()) })
}

impl SecurityAttributes {
    /// The descriptor, valid while `self` lives.
    pub(crate) fn descriptor(&self) -> PSECURITY_DESCRIPTOR {
        PSECURITY_DESCRIPTOR(self.descriptor.as_ptr())
    }

    /// Whether the SDDL's DACL is marked protected (`D:P...`, no inheritance).
    pub(crate) fn dacl_is_protected(sddl: &str) -> bool {
        split_dacl(sddl).0.contains('P')
    }
}

/// An ACL target must be an absolute local path with no `..`, no stream and no wildcard.
/// No API call.
pub fn check_acl_path(path: &Path) -> Result<()> {
    let text = path.to_string_lossy();
    let rest = text.get(2..).unwrap_or("");
    let drive_ok = text.len() > 2 && text.as_bytes()[0].is_ascii_alphabetic() && text.as_bytes()[1] == b':';
    let bad = !drive_ok
        || rest.contains(':')
        || text.contains(['*', '?', '<', '>', '|', '"'])
        || text.starts_with(r"\\")
        || path.components().any(|c| matches!(c, std::path::Component::ParentDir | std::path::Component::CurDir));
    if bad {
        return Err(Win32Error::Forbidden(format!("{text:?} is not an absolute local path")));
    }
    Ok(())
}

/// The DACL of a file or folder as SDDL, flags included. `Ok(None)` when it does not
/// exist. Read-only.
pub fn get_path_dacl(path: &Path) -> Result<Option<String>> {
    check_acl_path(path)?;
    if std::fs::symlink_metadata(path).is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound) {
        return Ok(None);
    }
    let wide = to_wide(&path.to_string_lossy());
    let mut psd = PSECURITY_DESCRIPTOR::default();
    // SAFETY: `wide` is NUL-terminated; the out pointer is valid. The returned
    // descriptor is freed by `guard`.
    let status = unsafe {
        GetNamedSecurityInfoW(
            PCWSTR(wide.as_ptr()),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            None,
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
    dacl_sddl_of(PSECURITY_DESCRIPTOR(guard.as_ptr())).map(Some)
}

/// (Phase 5 Step 7) The DACL of `root` and of every folder below it, down to `max_depth`
/// levels, as (path, SDDL) pairs, at most `max_entries` of them. Folders named in
/// `skip_names` (case-insensitive, any level) are neither listed nor entered; links and
/// junctions are never followed or listed; a folder that cannot be read is left out. The
/// AppLocker layer uses it to find the folders under the Windows folder that standard users
/// can write to. Read-only.
pub fn list_folder_dacls(root: &Path, max_depth: u32, skip_names: &[&str], max_entries: usize) -> Result<Vec<(String, String)>> {
    check_acl_path(root)?;
    let mut out: Vec<(String, String)> = Vec::new();
    let mut pending: Vec<(std::path::PathBuf, u32)> = vec![(root.to_path_buf(), 0)];
    while let Some((folder, depth)) = pending.pop() {
        if out.len() >= max_entries {
            break;
        }
        if let Ok(Some(sddl)) = get_path_dacl(&folder) {
            out.push((folder.to_string_lossy().into_owned(), sddl));
        }
        if depth >= max_depth {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(&folder) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(meta) = std::fs::symlink_metadata(entry.path()) else {
                continue;
            };
            let linked = meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0;
            let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
            if meta.is_dir() && !linked && !skip_names.iter().any(|skip| skip.eq_ignore_ascii_case(&name)) {
                pending.push((entry.path(), depth + 1));
            }
        }
    }
    out.sort();
    Ok(out)
}

/// Replaces the DACL of a file or folder with `sddl` (`D:...`). A `P` flag in the SDDL
/// makes it protected from inheritance, no `P` makes it inheriting: so the SDDL that
/// [`get_path_dacl`] returned restores the original exactly. The caller restricts which
/// folders reach this (the agent: its own install and data folders).
///
/// DESTRUCTIVE: guarded.
pub fn set_path_dacl(path: &Path, sddl: &str) -> Result<()> {
    check_acl_path(path)?;
    require_armed_machine()?;
    let attrs = SecurityAttributes::from_sddl(sddl)?;
    let dacl = attrs.dacl()?;
    let flag = if SecurityAttributes::dacl_is_protected(sddl) {
        PROTECTED_DACL_SECURITY_INFORMATION
    } else {
        UNPROTECTED_DACL_SECURITY_INFORMATION
    };
    let wide = to_wide(&path.to_string_lossy());
    // SAFETY: `wide` is NUL-terminated; `dacl` points into the descriptor owned by `attrs`.
    let status = unsafe {
        SetNamedSecurityInfoW(
            PCWSTR(wide.as_ptr()),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | flag,
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

/// The only arguments [`relaunch_setup_elevated`] passes: no caller text ever reaches the new
/// process's command line.
pub const SETUP_ARGUMENTS: &str = "setup --relaunched";

/// (Phase 6 Step 8) Starts this program again with the `runas` verb and the fixed arguments
/// [`SETUP_ARGUMENTS`], so Windows asks for administrator rights (a consent prompt, or a password
/// for a standard user) and Rulebox Setup runs elevated. The caller then ends. Returns an error
/// when the prompt is declined or the program cannot start. It changes nothing on the machine by
/// itself (a prompt, then our own exe), so it is not guarded; the guarded work happens in the
/// elevated copy.
pub fn relaunch_setup_elevated() -> Result<()> {
    use windows::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_NOASYNC, SHELLEXECUTEINFOW};
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let exe = std::env::current_exe().map_err(|e| Win32Error::Invalid(format!("cannot find this program: {e}")))?;
    let verb = to_wide("runas");
    let file = to_wide(&exe.to_string_lossy());
    let arguments = to_wide(SETUP_ARGUMENTS);
    let mut info = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOASYNC,
        lpVerb: PCWSTR(verb.as_ptr()),
        lpFile: PCWSTR(file.as_ptr()),
        lpParameters: PCWSTR(arguments.as_ptr()),
        nShow: SW_SHOWNORMAL.0,
        ..Default::default()
    };
    // SAFETY: `info` is fully initialised; the three strings are NUL-terminated and outlive the call.
    unsafe { ShellExecuteExW(&mut info) }.map_err(|e| api_err("ShellExecuteExW", &e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_setup_relaunch_passes_only_fixed_arguments() {
        // `--relaunched` tells the new copy not to ask for rights a second time.
        assert_eq!(SETUP_ARGUMENTS, "setup --relaunched");
    }

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
    fn dacls_compare_without_the_flags_windows_adds() {
        assert_eq!(normalize_dacl("D:PAI(A;OICI;FA;;;SY)"), "D:P(A;OICI;FA;;;SY)");
        assert_eq!(normalize_dacl("D:AI(A;OICIID;FA;;;SY)"), "D:(A;OICIID;FA;;;SY)");
        assert!(same_dacl("D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)", PROTECTED_DIR_SDDL));
        assert!(same_dacl("D:(A;;LC;;;IU)", "D:AR(A;;LC;;;IU)"));
        // Protection, an extra entry, another right and another order all count.
        assert!(!same_dacl("D:AI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)", PROTECTED_DIR_SDDL));
        assert!(!same_dacl("D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;WD)", PROTECTED_DIR_SDDL));
        assert!(!same_dacl("D:P(A;OICI;FA;;;BA)(A;OICI;FA;;;SY)", PROTECTED_DIR_SDDL));
        assert!(!same_dacl(INSTALL_DIR_SDDL, "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;BU)"));
    }

    #[test]
    fn the_install_folder_dacl_lets_users_run_and_not_write() {
        assert_eq!(INSTALL_DIR_SDDL, "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;BU)");
        // The state folder's entries, plus read and execute for Users.
        assert!(INSTALL_DIR_SDDL.starts_with(PROTECTED_DIR_SDDL));
        // 0x1200a9 = FILE_GENERIC_READ | FILE_GENERIC_EXECUTE: no write (0x2), append (0x4),
        // delete (0x10000) or change of the DACL (0x40000).
        assert_eq!(0x0012_00a9u32 & (0x2 | 0x4 | 0x40 | 0x100 | 0x1_0000 | 0x4_0000 | 0x8_0000), 0);
        assert!(SecurityAttributes::from_sddl(INSTALL_DIR_SDDL).unwrap().dacl().is_ok());
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
    fn acl_targets_must_be_plain_absolute_local_paths() {
        assert!(check_acl_path(Path::new(r"C:\Program Files\Rulebox")).is_ok());
        for bad in [
            r"Rulebox",
            r"\Program Files",
            r"\\server\share\x",
            r"C:\Program Files\..\Windows",
            r"C:\Program Files\Rulebox:stream",
            r"C:\Program Files\*",
            r"C:",
        ] {
            assert!(matches!(check_acl_path(Path::new(bad)), Err(Win32Error::Forbidden(_))), "{bad}");
        }
    }

    #[test]
    fn set_path_dacl_checks_the_path_then_the_guard_and_changes_nothing() {
        let sddl = "D:P(A;OICI;FA;;;SY)";
        assert!(matches!(set_path_dacl(Path::new(r"..\x"), sddl), Err(Win32Error::Forbidden(_))));
        if !crate::guard::is_armed_machine() {
            let err = set_path_dacl(Path::new(r"C:\rulebox-guard-test-must-not-exist"), sddl).unwrap_err();
            assert!(matches!(err, Win32Error::Guard(_)));
        }
    }

    #[test]
    fn a_path_dacl_reads_back_and_a_missing_path_is_none() {
        assert_eq!(get_path_dacl(Path::new(r"C:\rulebox-no-such-dir-xyz")).unwrap(), None);
        let windows = std::env::var_os("SystemRoot").unwrap_or_else(|| r"C:\Windows".into());
        let sddl = get_path_dacl(Path::new(&windows)).unwrap().unwrap();
        assert!(sddl.starts_with("D:"), "{sddl}");
        // What was read can be parsed again (the restore path).
        assert!(SecurityAttributes::from_sddl(&sddl).is_ok());
    }

    #[test]
    fn enable_privileges_on_own_token() {
        // Held by every token and enabled by default: only changes this process.
        enable_privileges(&["SeChangeNotifyPrivilege"]).unwrap();
        assert!(enable_privileges(&["NoSuchPrivilegeRulebox"]).is_err());
    }
}
