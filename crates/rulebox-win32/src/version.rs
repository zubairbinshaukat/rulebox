//! The file version of a program (Phase 6 Step 11, plan 4.4.1): the fixed part of the version
//! resource (`VS_FIXEDFILEINFO`), written as four numbers (`1.2.3.4`). Read-only.
//!
//! The fixed numbers, not the `FileVersion` string: the string is free text (`1.2.3 build 7`),
//! the fixed part is always four 16-bit numbers, so it always has an order.

use std::ffi::c_void;
use std::path::Path;

use windows::core::PCWSTR;
use windows::Win32::Storage::FileSystem::{GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW, VS_FIXEDFILEINFO};

use crate::util::to_wide;

/// The signature the fixed block starts with.
const FIXED_SIGNATURE: u32 = 0xFEEF_04BD;
/// The largest version resource read (the same bound `fileid` uses).
const MAX_RESOURCE_BYTES: u32 = 4 * 1024 * 1024;

/// `a.b.c.d` from the two 32-bit halves of the fixed file version.
pub fn format_fixed(most: u32, least: u32) -> String {
    format!("{}.{}.{}.{}", most >> 16, most & 0xFFFF, least >> 16, least & 0xFFFF)
}

/// The file version of `path`. `None`: no such file, no version resource, or an all-zero
/// version (a program that has the block but never filled it). Never an error: a program
/// the version cannot be read from simply has none.
pub fn file_version(path: &Path) -> Option<String> {
    let wide = to_wide(&path.to_string_lossy());
    // SAFETY: `wide` is NUL-terminated and outlives the call.
    let size = unsafe { GetFileVersionInfoSizeW(PCWSTR(wide.as_ptr()), None) };
    if size == 0 || size > MAX_RESOURCE_BYTES {
        return None;
    }
    // A `u32` backing keeps the block 4-byte aligned, as the version functions expect.
    let mut block = vec![0u32; (size as usize).div_ceil(4)];
    // SAFETY: `block` has room for `size` bytes.
    unsafe { GetFileVersionInfoW(PCWSTR(wide.as_ptr()), Some(0), size, block.as_mut_ptr().cast()) }.ok()?;
    let root = to_wide("\\");
    let mut pointer: *mut c_void = std::ptr::null_mut();
    let mut length = 0u32;
    // SAFETY: `block` is a version block that outlives the call; the out pointers are valid.
    let found = unsafe { VerQueryValueW(block.as_ptr().cast(), PCWSTR(root.as_ptr()), &mut pointer, &mut length) };
    if !found.as_bool() || pointer.is_null() || (length as usize) < std::mem::size_of::<VS_FIXEDFILEINFO>() {
        return None;
    }
    // SAFETY: the system returned a pointer to a `VS_FIXEDFILEINFO` inside `block` (the
    // length was checked); an unaligned read is used so no alignment is assumed.
    let info = unsafe { pointer.cast::<VS_FIXEDFILEINFO>().read_unaligned() };
    if info.dwSignature != FIXED_SIGNATURE || (info.dwFileVersionMS == 0 && info.dwFileVersionLS == 0) {
        return None;
    }
    Some(format_fixed(info.dwFileVersionMS, info.dwFileVersionLS))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_halves_become_four_numbers() {
        assert_eq!(format_fixed(0x0001_0002, 0x0003_0004), "1.2.3.4");
        assert_eq!(format_fixed(10 << 16, 26100 << 16 | 1), "10.0.26100.1");
        assert_eq!(format_fixed(0xFFFF_FFFF, 0xFFFF_FFFF), "65535.65535.65535.65535");
    }

    #[test]
    fn a_missing_file_and_a_program_without_a_resource_have_no_version() {
        assert_eq!(file_version(Path::new(r"C:\no such folder\x.exe")), None);
        // This test program is a Rust binary without a version resource.
        assert_eq!(file_version(&std::env::current_exe().unwrap()), None);
    }

    #[test]
    fn a_program_of_windows_has_four_numbers() {
        // Read-only: asks the version API about a file every Windows has.
        let windows = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
        let kernel = Path::new(&windows).join("System32").join("kernel32.dll");
        if let Some(version) = file_version(&kernel) {
            assert_eq!(version.split('.').count(), 4, "{version}");
            assert!(version.split('.').all(|part| part.parse::<u16>().is_ok()), "{version}");
        }
    }
}
