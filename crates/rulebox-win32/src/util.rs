//! Small owned wrappers: wide strings, handles, `LocalAlloc` buffers.

use std::ffi::c_void;

use windows::Win32::Foundation::{CloseHandle, LocalFree, HANDLE, HLOCAL, INVALID_HANDLE_VALUE};

use crate::error::{Result, Win32Error};

/// UTF-16 with a trailing NUL, ready to pass as `PCWSTR`.
pub fn to_wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Reads a NUL-terminated UTF-16 string. A null pointer gives an empty string.
///
/// # Safety
/// `p` must be null or point to a valid NUL-terminated UTF-16 string.
pub unsafe fn from_wide_ptr(p: *const u16) -> String {
    if p.is_null() {
        return String::new();
    }
    let mut len = 0usize;
    // SAFETY: the caller guarantees a NUL terminator, so every read up to and
    // including the terminator is inside the string.
    while unsafe { *p.add(len) } != 0 {
        len += 1;
    }
    // SAFETY: `len` elements before the terminator were just read.
    String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(p, len) })
}

/// A handle closed with `CloseHandle` on drop. Never wraps null or invalid.
pub struct OwnedHandle(HANDLE);

impl OwnedHandle {
    /// Takes ownership of `handle`; rejects null and `INVALID_HANDLE_VALUE`.
    pub fn new(handle: HANDLE) -> Result<Self> {
        if handle.is_invalid() || handle == INVALID_HANDLE_VALUE {
            return Err(Win32Error::Invalid("null or invalid handle".into()));
        }
        Ok(Self(handle))
    }

    pub fn raw(&self) -> HANDLE {
        self.0
    }
}

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        // SAFETY: the handle is valid and owned by this value; closed once.
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

/// A buffer allocated by the system with `LocalAlloc`, freed with `LocalFree`.
pub struct LocalAllocGuard(*mut c_void);

impl LocalAllocGuard {
    /// Takes ownership of `ptr`; rejects null.
    pub fn new(ptr: *mut c_void) -> Result<Self> {
        if ptr.is_null() {
            return Err(Win32Error::Invalid("null system buffer".into()));
        }
        Ok(Self(ptr))
    }

    pub fn as_ptr(&self) -> *mut c_void {
        self.0
    }
}

impl Drop for LocalAllocGuard {
    fn drop(&mut self) {
        // SAFETY: the pointer came from a system allocation that the API
        // documents as freeable with `LocalFree`, and it is freed only here.
        unsafe {
            let _ = LocalFree(Some(HLOCAL(self.0)));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wide_round_trip() {
        let w = to_wide("Rulebox ü");
        assert_eq!(w.last(), Some(&0));
        // SAFETY: `w` is NUL-terminated.
        assert_eq!(unsafe { from_wide_ptr(w.as_ptr()) }, "Rulebox ü");
        // SAFETY: null is allowed.
        assert_eq!(unsafe { from_wide_ptr(std::ptr::null()) }, "");
    }

    #[test]
    fn handle_rejects_invalid() {
        assert!(OwnedHandle::new(HANDLE::default()).is_err());
        assert!(OwnedHandle::new(INVALID_HANDLE_VALUE).is_err());
        assert!(LocalAllocGuard::new(std::ptr::null_mut()).is_err());
    }
}
