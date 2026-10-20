//! Asks Windows where an open file really is (after any links), so the
//! files backend can check it against the employee's folder.

use std::fs::File;
use std::os::windows::io::AsRawHandle;
use std::path::PathBuf;

use windows::Win32::Foundation::HANDLE;
use windows::Win32::Storage::FileSystem::{GetFinalPathNameByHandleW, FILE_NAME_NORMALIZED};

use crate::error::{DesktopError, Result};

/// The final path of an open file or folder, as the OS reports it. It still
/// has the `\\?\` prefix; strip it with `dunce::simplified`.
pub fn final_path(file: &File) -> Result<PathBuf> {
    let handle = HANDLE(file.as_raw_handle());
    let mut buffer = vec![0u16; 512];
    loop {
        // SAFETY: `handle` is open for as long as `file` is borrowed, and
        // `buffer` is a valid writable slice of the length we pass.
        let written = unsafe {
            // Both flags are 0: normalized name, drive-letter volume form.
            GetFinalPathNameByHandleW(handle, &mut buffer, FILE_NAME_NORMALIZED)
        } as usize;
        if written == 0 {
            let error = windows::core::Error::from_thread();
            return Err(DesktopError::win32("GetFinalPathNameByHandleW", &error));
        }
        if written >= buffer.len() {
            // Too small: `written` is the size needed including the NUL.
            buffer.resize(written + 1, 0);
            continue;
        }
        buffer.truncate(written);
        let text = String::from_utf16_lossy(&buffer);
        return Ok(PathBuf::from(text));
    }
}
