//! Typed registry values under `HKLM`, and access to one user's hive (loaded
//! from `NTUSER.DAT` when that user is signed out).
//!
//! Only two value types exist here: `REG_DWORD` and `REG_SZ`. A `REG_EXPAND_SZ`
//! value is read already expanded (the `RegGetValueW` default). Every other type
//! is an error, so nothing is silently misread.

use std::path::Path;
use std::time::Duration;

use windows::core::PCWSTR;
use windows::Win32::Foundation::{
    ERROR_FILE_NOT_FOUND, ERROR_MORE_DATA, ERROR_SHARING_VIOLATION, ERROR_SUCCESS, WIN32_ERROR,
};
use windows::Win32::System::Registry::{
    RegCloseKey, RegCreateKeyExW, RegDeleteValueW, RegGetValueW, RegLoadKeyW, RegOpenKeyExW,
    RegSetValueExW, RegUnLoadKeyW, HKEY, HKEY_LOCAL_MACHINE, HKEY_USERS, KEY_QUERY_VALUE, KEY_READ,
    KEY_SET_VALUE, KEY_WOW64_64KEY, KEY_WRITE, REG_DWORD, REG_OPTION_NON_VOLATILE, REG_SAM_FLAGS,
    REG_SZ, REG_VALUE_TYPE, RRF_RT_REG_DWORD, RRF_RT_REG_SZ,
};

use crate::error::{code_err, Result, Win32Error};
use crate::guard::require_test_machine;
use crate::security::enable_privileges;
use crate::sid::Sid;
use crate::util::to_wide;

/// The name a signed-out user's hive is mounted under, below `HKEY_USERS`.
pub const TEMP_HIVE_NAME: &str = "RuleboxStaffTmp";
/// `RegUnLoadKeyW` is retried this often, this far apart (a key handle the system
/// still holds for a moment makes it fail with "access denied").
const UNLOAD_ATTEMPTS: u32 = 5;
const UNLOAD_RETRY: Duration = Duration::from_millis(200);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RegValue {
    Dword(u32),
    String(String),
}

/// An open registry key, closed on drop.
pub(crate) struct RegKey(HKEY);

impl Drop for RegKey {
    fn drop(&mut self) {
        // SAFETY: the key was opened by this module, is owned by this value and closed once.
        unsafe {
            let _ = RegCloseKey(self.0);
        }
    }
}

fn status_err(api: &'static str, status: WIN32_ERROR) -> Win32Error {
    code_err(api, status.0)
}

/// Opens `root\path`. `Ok(None)` when the key does not exist.
fn open_key(root: HKEY, path: &str, access: REG_SAM_FLAGS) -> Result<Option<RegKey>> {
    let wide = to_wide(path);
    let mut key = HKEY::default();
    // SAFETY: `wide` is NUL-terminated and outlives the call; `key` is a valid out pointer.
    let status = unsafe { RegOpenKeyExW(root, PCWSTR(wide.as_ptr()), None, access, &mut key) };
    if status == ERROR_FILE_NOT_FOUND {
        return Ok(None);
    }
    if status != ERROR_SUCCESS {
        return Err(status_err("RegOpenKeyExW", status));
    }
    Ok(Some(RegKey(key)))
}

/// Opens `root\path`, creating missing keys.
fn create_key(root: HKEY, path: &str, access: REG_SAM_FLAGS) -> Result<RegKey> {
    let wide = to_wide(path);
    let mut key = HKEY::default();
    // SAFETY: `wide` is NUL-terminated and outlives the call; no class, default
    // security; `key` is a valid out pointer.
    let status = unsafe {
        RegCreateKeyExW(
            root,
            PCWSTR(wide.as_ptr()),
            None,
            PCWSTR::null(),
            REG_OPTION_NON_VOLATILE,
            access,
            None,
            &mut key,
            None,
        )
    };
    if status != ERROR_SUCCESS {
        return Err(status_err("RegCreateKeyExW", status));
    }
    Ok(RegKey(key))
}

/// Reads one value of an open key. `Ok(None)` when it does not exist.
fn read_value(key: &RegKey, name: &str) -> Result<Option<RegValue>> {
    let wide = to_wide(name);
    let flags = RRF_RT_REG_SZ | RRF_RT_REG_DWORD;
    // Values can grow between the size query and the read: a few attempts.
    for _ in 0..4 {
        let mut kind = REG_VALUE_TYPE::default();
        let mut size = 0u32;
        // SAFETY: the key is open; `wide` is NUL-terminated; a null data pointer
        // with a size out pointer only queries the type and size.
        let status = unsafe {
            RegGetValueW(key.0, PCWSTR::null(), PCWSTR(wide.as_ptr()), flags, Some(&mut kind), None, Some(&mut size))
        };
        if status == ERROR_FILE_NOT_FOUND {
            return Ok(None);
        }
        if status != ERROR_SUCCESS {
            return Err(status_err("RegGetValueW", status));
        }
        // u16 elements: aligned for both a DWORD's bytes and UTF-16 text.
        let mut buf = vec![0u16; (size as usize).div_ceil(2).max(2) + 1];
        let mut size = u32::try_from(buf.len() * 2).unwrap_or(u32::MAX);
        // SAFETY: `buf` holds `size` bytes; the other arguments as above.
        let status = unsafe {
            RegGetValueW(
                key.0,
                PCWSTR::null(),
                PCWSTR(wide.as_ptr()),
                flags,
                Some(&mut kind),
                Some(buf.as_mut_ptr().cast()),
                Some(&mut size),
            )
        };
        if status == ERROR_MORE_DATA {
            continue;
        }
        if status == ERROR_FILE_NOT_FOUND {
            return Ok(None);
        }
        if status != ERROR_SUCCESS {
            return Err(status_err("RegGetValueW", status));
        }
        return decode(kind, &buf, size as usize).map(Some);
    }
    Err(Win32Error::Invalid(format!("the registry value {name:?} keeps changing size")))
}

fn decode(kind: REG_VALUE_TYPE, buf: &[u16], size_bytes: usize) -> Result<RegValue> {
    if kind == REG_DWORD {
        let lo = u32::from(*buf.first().unwrap_or(&0));
        let hi = u32::from(*buf.get(1).unwrap_or(&0));
        return Ok(RegValue::Dword(lo | (hi << 16)));
    }
    if kind == REG_SZ {
        let units = (size_bytes / 2).min(buf.len());
        let text = String::from_utf16_lossy(&buf[..units]);
        return Ok(RegValue::String(text.trim_end_matches('\0').to_string()));
    }
    Err(Win32Error::Invalid(format!("unsupported registry value type {}", kind.0)))
}

/// Writes (`Some`) or deletes (`None`) one value of an open key. Deleting a value
/// that does not exist succeeds.
fn write_value(key: &RegKey, name: &str, value: Option<&RegValue>) -> Result<()> {
    let wide = to_wide(name);
    let status = match value {
        Some(RegValue::Dword(v)) => {
            let bytes = v.to_le_bytes();
            // SAFETY: the key is open with KEY_SET_VALUE; `wide` is NUL-terminated;
            // the data slice is 4 bytes as REG_DWORD requires.
            unsafe { RegSetValueExW(key.0, PCWSTR(wide.as_ptr()), None, REG_DWORD, Some(&bytes)) }
        }
        Some(RegValue::String(text)) => {
            let bytes: Vec<u8> = to_wide(text).iter().flat_map(|unit| unit.to_le_bytes()).collect();
            // SAFETY: as above; the data is UTF-16LE including the terminating NUL.
            unsafe { RegSetValueExW(key.0, PCWSTR(wide.as_ptr()), None, REG_SZ, Some(&bytes)) }
        }
        None => {
            // SAFETY: the key is open with KEY_SET_VALUE; `wide` is NUL-terminated.
            let status = unsafe { RegDeleteValueW(key.0, PCWSTR(wide.as_ptr())) };
            if status == ERROR_FILE_NOT_FOUND {
                return Ok(());
            }
            status
        }
    };
    if status != ERROR_SUCCESS {
        return Err(status_err(if value.is_some() { "RegSetValueExW" } else { "RegDeleteValueW" }, status));
    }
    Ok(())
}

/// Reads `HKLM\<path>\<name>` from the 64-bit view. `Ok(None)` when the key or the
/// value does not exist. Read-only.
pub fn get_hklm(path: &str, name: &str) -> Result<Option<RegValue>> {
    match open_key(HKEY_LOCAL_MACHINE, path, KEY_QUERY_VALUE | KEY_WOW64_64KEY)? {
        Some(key) => read_value(&key, name),
        None => Ok(None),
    }
}

/// Writes (`Some`) or deletes (`None`) `HKLM\<path>\<name>` in the 64-bit view.
/// Callers restrict which keys and names reach this (`autologon.rs`, the agent's
/// `write_machine_value`).
///
/// DESTRUCTIVE: guarded.
pub fn set_hklm(path: &str, name: &str, value: Option<&RegValue>) -> Result<()> {
    require_test_machine()?;
    match value {
        Some(_) => {
            let key = create_key(HKEY_LOCAL_MACHINE, path, KEY_SET_VALUE | KEY_WOW64_64KEY)?;
            write_value(&key, name, value)
        }
        None => match open_key(HKEY_LOCAL_MACHINE, path, KEY_SET_VALUE | KEY_WOW64_64KEY)? {
            Some(key) => write_value(&key, name, None),
            None => Ok(()),
        },
    }
}

/// The root of one user's hive (`HKEY_USERS\<SID>` or the temporary mount). It
/// exists only inside `with_user_hive`, so a function that takes a `HiveKey` can
/// reach that user's hive and nothing else (in particular never `HKLM`).
pub struct HiveKey {
    root: RegKey,
}

impl HiveKey {
    /// Reads `<hive>\<subkey>\<name>`. `Ok(None)` when absent.
    pub fn get(&self, subkey: &str, name: &str) -> Result<Option<RegValue>> {
        match open_key(self.root.0, subkey, KEY_QUERY_VALUE)? {
            Some(key) => read_value(&key, name),
            None => Ok(None),
        }
    }

    /// Writes (`Some`) or deletes (`None`) `<hive>\<subkey>\<name>`. Only code in
    /// this crate writes through a `HiveKey` (`shellreg.rs`).
    pub(crate) fn set(&self, subkey: &str, name: &str, value: Option<&RegValue>) -> Result<()> {
        match value {
            Some(_) => write_value(&create_key(self.root.0, subkey, KEY_SET_VALUE)?, name, value),
            None => match open_key(self.root.0, subkey, KEY_SET_VALUE)? {
                Some(key) => write_value(&key, name, None),
                None => Ok(()),
            },
        }
    }
}

/// Runs `f` on the hive of the user `sid` whose profile folder is `profile`.
///
/// If `HKEY_USERS\<SID>` is loaded (the user is signed in), it is used. Otherwise
/// `SeBackupPrivilege` and `SeRestorePrivilege` are enabled, `<profile>\NTUSER.DAT`
/// is loaded as `HKEY_USERS\RuleboxStaffTmp`, `f` runs, every key is closed and the
/// hive is unloaded (5 attempts, 200 ms apart). A mount left behind by a crash is
/// unloaded first. If `f` succeeded but the unload failed, the unload error is
/// returned: a hive left mounted would break that user's next sign-in.
///
/// DESTRUCTIVE: guarded.
pub fn with_user_hive<T>(sid: &Sid, profile: &Path, f: impl FnOnce(&HiveKey) -> Result<T>) -> Result<T> {
    require_test_machine()?;
    let access = KEY_READ | KEY_WRITE;
    if let Some(root) = open_key(HKEY_USERS, sid.as_str(), access)? {
        return f(&HiveKey { root });
    }
    let file = profile.join("NTUSER.DAT");
    if !file.is_file() {
        return Err(Win32Error::NotFound);
    }
    enable_privileges(&["SeBackupPrivilege", "SeRestorePrivilege"])?;
    // A mount left by an earlier run that crashed (the name is ours alone).
    if open_key(HKEY_USERS, TEMP_HIVE_NAME, KEY_QUERY_VALUE)?.is_some() {
        unload_temp_hive()?;
    }

    let name = to_wide(TEMP_HIVE_NAME);
    let path = to_wide(&file.to_string_lossy());
    // SAFETY: both strings are NUL-terminated and outlive the call; the privileges
    // the call needs were enabled above.
    let status = unsafe { RegLoadKeyW(HKEY_USERS, PCWSTR(name.as_ptr()), PCWSTR(path.as_ptr())) };
    if status == ERROR_SHARING_VIOLATION {
        // The user signed in between the two checks: the system has the hive now.
        return match open_key(HKEY_USERS, sid.as_str(), access)? {
            Some(root) => f(&HiveKey { root }),
            None => Err(status_err("RegLoadKeyW", status)),
        };
    }
    if status != ERROR_SUCCESS {
        return Err(status_err("RegLoadKeyW", status));
    }

    let result = match open_key(HKEY_USERS, TEMP_HIVE_NAME, access) {
        Ok(Some(root)) => {
            let hive = HiveKey { root };
            let result = f(&hive);
            drop(hive);
            result
        }
        Ok(None) => Err(Win32Error::Invalid("the loaded hive cannot be opened".into())),
        Err(e) => Err(e),
    };
    let unloaded = unload_temp_hive();
    match (result, unloaded) {
        (Ok(value), Ok(())) => Ok(value),
        (Ok(_), Err(e)) | (Err(e), _) => Err(e),
    }
}

/// Unloads `HKEY_USERS\RuleboxStaffTmp`, retrying while something still holds it.
fn unload_temp_hive() -> Result<()> {
    let name = to_wide(TEMP_HIVE_NAME);
    let mut last = ERROR_SUCCESS;
    for attempt in 0..UNLOAD_ATTEMPTS {
        if attempt > 0 {
            std::thread::sleep(UNLOAD_RETRY);
        }
        // SAFETY: `name` is NUL-terminated; the restore privilege was enabled by the caller.
        last = unsafe { RegUnLoadKeyW(HKEY_USERS, PCWSTR(name.as_ptr())) };
        if last == ERROR_SUCCESS {
            return Ok(());
        }
    }
    tracing::error!(code = last.0, "the temporary user hive could not be unloaded");
    Err(status_err("RegUnLoadKeyW", last))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_public_hklm_values() {
        let key = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion";
        match get_hklm(key, "CurrentBuildNumber").unwrap() {
            Some(RegValue::String(build)) => assert!(build.parse::<u32>().unwrap() >= 19045),
            other => panic!("unexpected {other:?}"),
        }
        assert!(matches!(get_hklm(key, "CurrentMajorVersionNumber").unwrap(), Some(RegValue::Dword(10))));
        assert_eq!(get_hklm(key, "NoSuchValueRulebox").unwrap(), None);
        assert_eq!(get_hklm(r"SOFTWARE\NoSuchKeyRulebox\X", "Y").unwrap(), None);
    }

    #[test]
    fn expand_strings_are_read_expanded() {
        // `SystemRoot`-style REG_EXPAND_SZ under the public CurrentVersion key.
        let key = r"SOFTWARE\Microsoft\Windows\CurrentVersion";
        if let Some(RegValue::String(dir)) = get_hklm(key, "ProgramFilesPath").unwrap() {
            assert!(!dir.contains('%'), "{dir}");
        }
    }

    #[test]
    fn unsupported_types_are_errors() {
        // REG_BINARY in the public hive: `DigitalProductId` is binary on every edition.
        let result = get_hklm(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion", "DigitalProductId");
        assert!(matches!(result, Err(Win32Error::Api { .. }) | Err(Win32Error::Invalid(_)) | Ok(None)), "{result:?}");
    }

    #[test]
    fn decode_dword_and_string() {
        assert_eq!(decode(REG_DWORD, &[0x0001, 0x0002, 0], 4).unwrap(), RegValue::Dword(0x0002_0001));
        let text: Vec<u16> = "ab\0".encode_utf16().collect();
        assert_eq!(decode(REG_SZ, &text, 6).unwrap(), RegValue::String("ab".into()));
    }

    #[test]
    fn set_hklm_is_blocked_by_the_guard() {
        let err = set_hklm(r"SOFTWARE\Rulebox\GuardTestMustNotExist", "X", Some(&RegValue::Dword(1))).unwrap_err();
        assert!(matches!(err, Win32Error::Guard(_)));
        assert_eq!(get_hklm(r"SOFTWARE\Rulebox\GuardTestMustNotExist", "X").unwrap(), None);
        assert!(matches!(set_hklm(r"SOFTWARE\Rulebox\GuardTestMustNotExist", "X", None), Err(Win32Error::Guard(_))));
    }

    #[test]
    fn with_user_hive_is_blocked_by_the_guard() {
        let sid = crate::sid::current_user_sid().unwrap();
        let mut ran = false;
        let result = with_user_hive(&sid, Path::new(r"C:\rulebox-no-such-profile"), |_| {
            ran = true;
            Ok(())
        });
        assert!(matches!(result, Err(Win32Error::Guard(_))));
        assert!(!ran);
    }
}
