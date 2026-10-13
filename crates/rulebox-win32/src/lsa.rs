//! LSA private data ("secrets"): the Staff account password for automatic
//! sign-in lives here as the `DefaultPassword` secret, never in the registry
//! as plain text (PRD 13.5).
//!
//! Only two operations exist: read one secret by name, and set or delete one
//! secret by name. A secret value never appears in an error, a log line or a
//! `Debug` output, and the buffer Windows hands back is wiped before it is freed.

use std::ffi::c_void;

use windows::core::PWSTR;
use windows::Win32::Foundation::{HANDLE, NTSTATUS};
use windows::Win32::Security::Authentication::Identity::{
    LsaClose, LsaFreeMemory, LsaNtStatusToWinError, LsaOpenPolicy, LsaRetrievePrivateData,
    LsaStorePrivateData, LSA_HANDLE, LSA_OBJECT_ATTRIBUTES, LSA_UNICODE_STRING,
};

use crate::error::{code_err, Result, Win32Error};
use crate::guard::require_test_machine;

/// `POLICY_GET_PRIVATE_INFORMATION`.
const POLICY_GET_PRIVATE_INFORMATION: u32 = 0x0000_0004;
/// `POLICY_CREATE_SECRET`.
const POLICY_CREATE_SECRET: u32 = 0x0000_0020;
/// `STATUS_OBJECT_NAME_NOT_FOUND`: no secret with that name.
const STATUS_OBJECT_NAME_NOT_FOUND: i32 = 0xC000_0034_u32 as i32;
/// A secret name is at most 128 UTF-16 units (documented limit).
const MAX_NAME_UNITS: usize = 128;
/// `LSA_UNICODE_STRING` lengths are `u16` byte counts.
const MAX_BYTES: usize = u16::MAX as usize - 2;

/// An open LSA policy handle, closed on drop.
struct Policy(LSA_HANDLE);

impl Policy {
    fn open(access: u32) -> Result<Self> {
        let attributes = LSA_OBJECT_ATTRIBUTES {
            Length: std::mem::size_of::<LSA_OBJECT_ATTRIBUTES>() as u32,
            RootDirectory: HANDLE::default(),
            ObjectName: std::ptr::null_mut(),
            Attributes: 0,
            SecurityDescriptor: std::ptr::null_mut(),
            SecurityQualityOfService: std::ptr::null_mut(),
        };
        let mut handle = LSA_HANDLE::default();
        // SAFETY: a null system name means the local machine; `attributes` is a
        // fully initialised structure that outlives the call; `handle` is a valid
        // out pointer.
        let status = unsafe { LsaOpenPolicy(None, &attributes, access, &mut handle) };
        check("LsaOpenPolicy", status)?;
        Ok(Self(handle))
    }
}

impl Drop for Policy {
    fn drop(&mut self) {
        // SAFETY: the handle came from a successful `LsaOpenPolicy` and is closed once.
        unsafe {
            let _ = LsaClose(self.0);
        }
    }
}

/// Maps an NTSTATUS to `Ok(())` or a typed error.
fn check(api: &'static str, status: NTSTATUS) -> Result<()> {
    if status.0 >= 0 {
        return Ok(());
    }
    // SAFETY: a pure conversion of a status code; no pointers involved.
    let code = unsafe { LsaNtStatusToWinError(status) };
    Err(code_err(api, code))
}

/// Builds a counted string over `units`. The slice must outlive the result.
fn counted(units: &mut [u16]) -> Result<LSA_UNICODE_STRING> {
    let bytes = units.len() * 2;
    if bytes > MAX_BYTES {
        return Err(Win32Error::Invalid("LSA string is too long".into()));
    }
    Ok(LSA_UNICODE_STRING {
        Length: bytes as u16,
        MaximumLength: bytes as u16,
        Buffer: PWSTR(units.as_mut_ptr()),
    })
}

fn name_units(name: &str) -> Result<Vec<u16>> {
    let units: Vec<u16> = name.encode_utf16().collect();
    if units.is_empty() || units.len() > MAX_NAME_UNITS {
        return Err(Win32Error::Invalid("LSA secret name must be 1 to 128 characters".into()));
    }
    Ok(units)
}

/// Overwrites `units` with zeros in a way the compiler cannot remove.
fn wipe(units: &mut [u16]) {
    for unit in units {
        // SAFETY: `unit` is a valid, aligned, exclusive reference.
        unsafe { std::ptr::write_volatile(unit, 0) };
    }
}

/// Reads the secret `name`. `Ok(None)` means no such secret exists.
///
/// Read-only, but the result is a credential: callers keep it only as long as
/// they need it and never log it.
pub fn secret_get(name: &str) -> Result<Option<String>> {
    let mut name_buf = name_units(name)?;
    let key = counted(&mut name_buf)?;
    let policy = Policy::open(POLICY_GET_PRIVATE_INFORMATION)?;

    let mut data: *mut LSA_UNICODE_STRING = std::ptr::null_mut();
    // SAFETY: `policy` is open; `key` points at `name_buf`, which is alive;
    // `data` is a valid out pointer that receives a system-allocated structure.
    let status = unsafe { LsaRetrievePrivateData(policy.0, &key, &mut data) };
    if status.0 == STATUS_OBJECT_NAME_NOT_FOUND {
        return Ok(None);
    }
    check("LsaRetrievePrivateData", status)?;
    if data.is_null() {
        return Ok(None);
    }

    // SAFETY: on success `data` points at a valid `LSA_UNICODE_STRING` whose
    // `Buffer` holds `Length` bytes. The buffer is read, copied, wiped and then
    // released exactly once with `LsaFreeMemory`.
    let value = unsafe {
        let text = &*data;
        let units = (text.Length / 2) as usize;
        let value = if text.Buffer.is_null() || units == 0 {
            String::new()
        } else {
            let slice = std::slice::from_raw_parts_mut(text.Buffer.0, units);
            let value = String::from_utf16_lossy(slice);
            wipe(slice);
            value
        };
        let _ = LsaFreeMemory(Some(data.cast::<c_void>().cast_const()));
        value
    };
    Ok(Some(value))
}

/// Sets the secret `name` to `value`, or deletes it when `value` is `None`.
/// Deleting a secret that does not exist is not an error.
///
/// DESTRUCTIVE: guarded.
pub fn secret_set(name: &str, value: Option<&str>) -> Result<()> {
    require_test_machine()?;
    let mut name_buf = name_units(name)?;
    let key = counted(&mut name_buf)?;
    let policy = Policy::open(POLICY_CREATE_SECRET)?;

    match value {
        Some(text) => {
            let mut value_buf: Vec<u16> = text.encode_utf16().collect();
            let result = (|| {
                let data = counted(&mut value_buf)?;
                // SAFETY: `policy` is open; `key` and `data` point at buffers
                // that stay alive for the whole call.
                let status = unsafe { LsaStorePrivateData(policy.0, &key, Some(&data)) };
                check("LsaStorePrivateData", status)
            })();
            wipe(&mut value_buf);
            result
        }
        None => {
            // SAFETY: `policy` is open; `key` points at a live buffer; a null
            // data pointer is the documented way to delete the secret.
            let status = unsafe { LsaStorePrivateData(policy.0, &key, None) };
            if status.0 == STATUS_OBJECT_NAME_NOT_FOUND {
                return Ok(());
            }
            check("LsaStorePrivateData", status)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_validated() {
        assert!(name_units("").is_err());
        assert!(name_units(&"x".repeat(129)).is_err());
        assert_eq!(name_units("L$Name").unwrap().len(), 6);
    }

    #[test]
    fn counted_strings_use_byte_lengths() {
        let mut units: Vec<u16> = "abc".encode_utf16().collect();
        let text = counted(&mut units).unwrap();
        assert_eq!(text.Length, 6);
        assert_eq!(text.MaximumLength, 6);
    }

    #[test]
    fn oversized_values_are_rejected() {
        let mut units = vec![0u16; 40_000];
        assert!(counted(&mut units).is_err());
    }

    #[test]
    fn wipe_zeroes_every_unit() {
        let mut units: Vec<u16> = "secret".encode_utf16().collect();
        wipe(&mut units);
        assert!(units.iter().all(|u| *u == 0));
    }

    /// Writes are refused on a machine without the test marker, before any
    /// LSA call is made (the guard is the first statement).
    #[test]
    fn writes_are_guarded_on_this_machine() {
        if crate::guard::is_test_machine() {
            return; // inside the VM the guard passes; the VM tests cover this
        }
        assert!(matches!(secret_set("L$RuleboxNeverWritten", Some("x")), Err(Win32Error::Guard(_))));
        assert!(matches!(secret_set("L$RuleboxNeverWritten", None), Err(Win32Error::Guard(_))));
    }
}
