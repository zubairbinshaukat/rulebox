//! The test-machine guard. Everything in this crate that changes the machine
//! calls `require_test_machine()` first. There is no bypass: no environment
//! variable, cargo feature or flag. The marker is created only by the user, by
//! hand, on a VM (plan Section 7, Step 3). This module only ever reads it.

use windows::core::PCWSTR;
use windows::Win32::Foundation::ERROR_SUCCESS;
use windows::Win32::System::Registry::{
    RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ, RRF_SUBKEY_WOW6464KEY,
};

use crate::error::{Result, Win32Error};
use crate::util::to_wide;

pub const MARKER_KEY: &str = r"SOFTWARE\Rulebox\TestMachine";
pub const MARKER_VALUE: &str = "ComputerName";

/// Ok only if `HKLM\SOFTWARE\Rulebox\TestMachine\ComputerName` (REG_SZ) equals
/// this computer's name (case-insensitive). Read-only. Never creates the marker.
pub fn require_test_machine() -> Result<()> {
    let marker = read_marker()?;
    let computer = computer_name()?;
    if marker_matches(&marker, &computer) {
        Ok(())
    } else {
        Err(Win32Error::Guard(format!(
            "the marker names a different computer ({marker:?}, this one is {computer:?})"
        )))
    }
}

pub fn is_test_machine() -> bool {
    require_test_machine().is_ok()
}

/// Case-insensitive comparison; an empty marker never matches.
fn marker_matches(marker: &str, computer: &str) -> bool {
    !marker.is_empty() && marker.to_uppercase() == computer.to_uppercase()
}

fn guard_err(what: &str, code: u32) -> Win32Error {
    Win32Error::Guard(format!("{what} (Win32 error {code})"))
}

/// The NetBIOS name, the same value as `$env:COMPUTERNAME`. Any failure is a guard error.
fn computer_name() -> Result<String> {
    crate::osinfo::computer_name()
        .map_err(|e| guard_err("could not read the computer name", e.code().unwrap_or(0)))
}

/// Reads the marker value. Any failure, including "not there", is a guard error
/// so the guard fails closed.
fn read_marker() -> Result<String> {
    let key = to_wide(MARKER_KEY);
    let value = to_wide(MARKER_VALUE);
    let flags = RRF_RT_REG_SZ | RRF_SUBKEY_WOW6464KEY;

    let mut size = 0u32;
    // SAFETY: both strings are NUL-terminated and outlive the call; a null data
    // pointer with a size out pointer only queries the required size.
    let status = unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            PCWSTR(key.as_ptr()),
            PCWSTR(value.as_ptr()),
            flags,
            None,
            None,
            Some(&mut size),
        )
    };
    if status != ERROR_SUCCESS {
        return Err(guard_err("the test-machine marker is not present", status.0));
    }

    let mut buf = vec![0u16; (size as usize).div_ceil(2) + 1];
    let mut size = (buf.len() * 2) as u32;
    // SAFETY: `buf` holds `size` bytes; the strings are NUL-terminated.
    let status = unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            PCWSTR(key.as_ptr()),
            PCWSTR(value.as_ptr()),
            flags,
            None,
            Some(buf.as_mut_ptr().cast()),
            Some(&mut size),
        )
    };
    if status != ERROR_SUCCESS {
        return Err(guard_err("could not read the test-machine marker", status.0));
    }
    let chars = (size as usize / 2).min(buf.len());
    let text = String::from_utf16_lossy(&buf[..chars]);
    Ok(text.trim_end_matches('\0').to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marker_comparison_is_case_insensitive() {
        assert!(marker_matches("test-vm-01", "TEST-VM-01"));
        assert!(!marker_matches("TEST-VM-01", "OTHER-PC"));
        assert!(!marker_matches("", ""));
    }

    #[test]
    fn computer_name_is_readable() {
        assert!(!computer_name().unwrap().is_empty());
    }

    /// If this fails the dev machine carries the test-machine marker: stop and
    /// tell the user. The test only reads the registry.
    #[test]
    fn dev_machine_is_not_a_test_machine() {
        assert!(matches!(require_test_machine(), Err(Win32Error::Guard(_))));
        assert!(!is_test_machine());
    }
}
