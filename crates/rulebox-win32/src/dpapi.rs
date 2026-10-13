//! DPAPI under the calling user's key (`CryptProtectData` without
//! `CRYPTPROTECT_LOCAL_MACHINE`). In the service that user is SYSTEM, so only
//! SYSTEM can decrypt; with the machine flag any local process could.
//!
//! Not guarded: both functions only transform bytes in memory.

use windows::core::PCWSTR;
use windows::Win32::Security::Cryptography::{
    CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
};

use crate::error::{api_err, Result, Win32Error};
use crate::util::LocalAllocGuard;

fn blob_of(data: &[u8]) -> Result<CRYPT_INTEGER_BLOB> {
    Ok(CRYPT_INTEGER_BLOB {
        cbData: u32::try_from(data.len()).map_err(|_| Win32Error::Invalid("data too large for DPAPI".into()))?,
        // DPAPI only reads the input blob.
        pbData: data.as_ptr().cast_mut(),
    })
}

/// Copies an output blob and frees it with `LocalFree`.
fn take_output(out: CRYPT_INTEGER_BLOB) -> Result<Vec<u8>> {
    if out.cbData == 0 {
        // A zero-length result may still carry an allocation.
        if !out.pbData.is_null() {
            drop(LocalAllocGuard::new(out.pbData.cast())?);
        }
        return Ok(Vec::new());
    }
    let guard = LocalAllocGuard::new(out.pbData.cast())?;
    // SAFETY: on success DPAPI returns `cbData` readable bytes at `pbData`, owned by `guard`.
    let bytes = unsafe { std::slice::from_raw_parts(guard.as_ptr().cast::<u8>(), out.cbData as usize) }.to_vec();
    Ok(bytes)
}

pub fn protect(plaintext: &[u8]) -> Result<Vec<u8>> {
    let input = blob_of(plaintext)?;
    let mut out = CRYPT_INTEGER_BLOB::default();
    // SAFETY: `input` points at `plaintext`, which outlives the call; `out` is a
    // valid out structure whose buffer `take_output` frees.
    unsafe { CryptProtectData(&input, PCWSTR::null(), None, None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut out) }
        .map_err(|e| api_err("CryptProtectData", &e))?;
    take_output(out)
}

pub fn unprotect(blob: &[u8]) -> Result<Vec<u8>> {
    let input = blob_of(blob)?;
    let mut out = CRYPT_INTEGER_BLOB::default();
    // SAFETY: as in `protect`; no description is requested.
    unsafe { CryptUnprotectData(&input, None, None, None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut out) }
        .map_err(|e| api_err("CryptUnprotectData", &e))?;
    take_output(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_under_the_current_user() {
        let secret = b"throwaway test bytes, not a real secret";
        let blob = protect(secret).unwrap();
        assert_ne!(blob.as_slice(), secret.as_slice());
        assert_eq!(unprotect(&blob).unwrap(), secret);
        assert_eq!(unprotect(&protect(b"").unwrap()).unwrap(), b"");
    }

    #[test]
    fn tampered_blob_is_rejected() {
        let mut blob = protect(b"abc").unwrap();
        let last = blob.len() - 1;
        blob[last] ^= 0xFF;
        assert!(unprotect(&blob).is_err());
        assert!(unprotect(b"garbage").is_err());
    }
}
