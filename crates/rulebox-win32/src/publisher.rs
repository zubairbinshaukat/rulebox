//! The machine's `TrustedPublisher` certificate store (Phase 6 Step 15, VM spike S-11).
//!
//! Windows adds a driver package whose catalog is signed by a publisher that is not WHQL only when that publisher's
//! certificate is in `LocalMachine\TrustedPublisher` (setupapi `0xE0000242` otherwise). Putting a certificate there trusts
//! **every** driver that certificate signs, so the agent does it only for one certificate it was told by thumbprint in the
//! signed document and only after it checked that the package's own catalogs are signed by exactly that certificate
//! (`fileid::signer_cert`). This module is the dumb store access: find, add, remove by SHA-1 thumbprint. It decides
//! nothing about trust.
//!
//! Every writer checks its rules first, then the guard.

use std::ffi::c_void;

use windows::core::w;
use windows::Win32::Security::Cryptography::{
    CertAddEncodedCertificateToStore, CertCloseStore, CertDeleteCertificateFromStore, CertFindCertificateInStore,
    CertFreeCertificateContext, CertOpenStore, CERT_FIND_SHA1_HASH, CERT_OPEN_STORE_FLAGS, CERT_QUERY_ENCODING_TYPE,
    CERT_STORE_ADD_USE_EXISTING, CERT_STORE_PROV_SYSTEM_W, CERT_SYSTEM_STORE_LOCAL_MACHINE, CRYPT_INTEGER_BLOB, HCERTSTORE,
    X509_ASN_ENCODING,
};

use crate::error::{api_err, Result, Win32Error};
use crate::guard::require_armed_machine;

/// `CERT_STORE_OPEN_EXISTING_FLAG` and `CERT_STORE_READONLY_FLAG`.
const OPEN_EXISTING: u32 = 0x4000;
const READ_ONLY: u32 = 0x8000;
/// `ERROR_FILE_NOT_FOUND`: the store does not exist (nobody ever trusted a publisher on this PC).
const FILE_NOT_FOUND: u32 = 2;
/// A real certificate is 1 to 3 KiB.
const MAX_CERT_BYTES: usize = 16 * 1024;

/// A system store closed on drop.
struct Store(HCERTSTORE);

impl Drop for Store {
    fn drop(&mut self) {
        // SAFETY: the handle was opened by this module, is owned by this value and closed once.
        unsafe {
            let _ = CertCloseStore(Some(self.0), 0);
        }
    }
}

fn open(extra_flags: u32) -> Result<Option<Store>> {
    let flags = CERT_OPEN_STORE_FLAGS(CERT_SYSTEM_STORE_LOCAL_MACHINE | extra_flags);
    let name = w!("TrustedPublisher");
    // SAFETY: for the `CERT_STORE_PROV_SYSTEM_W` provider the parameter is a NUL-terminated store name, a static string.
    match unsafe { CertOpenStore(CERT_STORE_PROV_SYSTEM_W, CERT_QUERY_ENCODING_TYPE(0), None, flags, Some(name.as_ptr().cast::<c_void>())) } {
        Ok(handle) => Ok(Some(Store(handle))),
        Err(e) => match api_err("CertOpenStore", &e) {
            Win32Error::Api { code: FILE_NOT_FOUND, .. } if extra_flags & OPEN_EXISTING != 0 => Ok(None),
            other => Err(other),
        },
    }
}

/// The 20 bytes of a SHA-1 thumbprint (40 hex digits, any case).
fn sha1_bytes(text: &str) -> Option<[u8; 20]> {
    if text.len() != 40 || !text.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let mut out = [0u8; 20];
    for (at, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&text[at * 2..at * 2 + 2], 16).ok()?;
    }
    Some(out)
}

/// The rule of [`trusted_publisher_has`] and [`remove`]: a SHA-1 thumbprint of 40 hex digits (no API call, no guard).
pub fn check_sha1(text: &str) -> Result<()> {
    if sha1_bytes(text).is_some() {
        Ok(())
    } else {
        Err(Win32Error::Forbidden("not a SHA-1 thumbprint".into()))
    }
}

/// The rule of [`add`]: something of the size of a certificate that starts like DER (a `SEQUENCE`).
pub fn check_der(der: &[u8]) -> Result<()> {
    if der.len() < 64 || der.len() > MAX_CERT_BYTES || der[0] != 0x30 {
        return Err(Win32Error::Forbidden("not a DER certificate".into()));
    }
    Ok(())
}

/// Finds the certificate with this SHA-1 thumbprint in the store; a null context when there is none.
///
/// # Safety
/// `store` must be an open store handle.
unsafe fn find(store: &Store, sha1: &[u8; 20]) -> *mut windows::Win32::Security::Cryptography::CERT_CONTEXT {
    let mut bytes = *sha1;
    let blob = CRYPT_INTEGER_BLOB { cbData: 20, pbData: bytes.as_mut_ptr() };
    // SAFETY: the store is open; `blob` and the bytes it points to outlive the call.
    unsafe { CertFindCertificateInStore(store.0, X509_ASN_ENCODING, 0, CERT_FIND_SHA1_HASH, Some(std::ptr::from_ref(&blob).cast()), None) }
}

/// Whether `LocalMachine\TrustedPublisher` holds the certificate with this SHA-1 thumbprint (a missing store: no).
/// Read-only.
pub fn trusted_publisher_has(sha1: &str) -> Result<bool> {
    check_sha1(sha1)?;
    let bytes = sha1_bytes(sha1).ok_or_else(|| Win32Error::Forbidden("not a SHA-1 thumbprint".into()))?;
    let Some(store) = open(OPEN_EXISTING | READ_ONLY)? else {
        return Ok(false);
    };
    // SAFETY: the store is open; a found context is freed once.
    let context = unsafe { find(&store, &bytes) };
    if context.is_null() {
        return Ok(false);
    }
    // SAFETY: the context was returned by the find above and is freed once.
    unsafe {
        let _ = CertFreeCertificateContext(Some(context));
    }
    Ok(true)
}

/// Puts a certificate (DER) into `LocalMachine\TrustedPublisher`; one that is there already stays as it is.
///
/// DESTRUCTIVE: guarded.
pub fn add(der: &[u8]) -> Result<()> {
    check_der(der)?;
    require_armed_machine()?;
    let store = open(0)?.ok_or(Win32Error::NotFound)?;
    // SAFETY: the store is open; `der` is a valid slice for the call; no context is asked back.
    unsafe { CertAddEncodedCertificateToStore(Some(store.0), X509_ASN_ENCODING, der, CERT_STORE_ADD_USE_EXISTING, None) }
        .map_err(|e| api_err("CertAddEncodedCertificateToStore", &e))
}

/// Removes the certificate with this SHA-1 thumbprint from `LocalMachine\TrustedPublisher` (one that is not there is
/// fine).
///
/// DESTRUCTIVE: guarded.
pub fn remove(sha1: &str) -> Result<()> {
    check_sha1(sha1)?;
    require_armed_machine()?;
    let bytes = sha1_bytes(sha1).ok_or_else(|| Win32Error::Forbidden("not a SHA-1 thumbprint".into()))?;
    let Some(store) = open(OPEN_EXISTING)? else {
        return Ok(());
    };
    // SAFETY: the store is open.
    let context = unsafe { find(&store, &bytes) };
    if context.is_null() {
        return Ok(());
    }
    // SAFETY: the context came from the find above; the call frees it whether or not it deletes.
    unsafe { CertDeleteCertificateFromStore(context) }.map_err(|e| api_err("CertDeleteCertificateFromStore", &e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thumbprints_and_certificates_are_checked_before_any_call() {
        assert!(check_sha1(&"59A339DC".repeat(5)).is_ok() && check_sha1(&"ab".repeat(20)).is_ok());
        for bad in [String::new(), "ab".to_string(), "g".repeat(40), "a".repeat(64), "a".repeat(41)] {
            assert!(matches!(check_sha1(&bad), Err(Win32Error::Forbidden(_))), "{bad:?}");
            assert!(matches!(trusted_publisher_has(&bad), Err(Win32Error::Forbidden(_))), "{bad:?}");
            assert!(matches!(remove(&bad), Err(Win32Error::Forbidden(_))), "{bad:?}");
        }
        let mut der = vec![0x30u8; 100];
        assert!(check_der(&der).is_ok());
        der[0] = 0x31;
        for bad in [der, vec![0x30; 10], vec![0x30; MAX_CERT_BYTES + 1], Vec::new()] {
            assert!(matches!(check_der(&bad), Err(Win32Error::Forbidden(_))));
            assert!(matches!(add(&bad), Err(Win32Error::Forbidden(_))));
        }
        assert_eq!(sha1_bytes(&"0f".repeat(20)).unwrap()[0], 0x0f);
    }

    #[test]
    fn reading_the_store_answers_for_a_certificate_that_cannot_be_there() {
        // Read-only: asks the machine's TrustedPublisher store about an all-zero thumbprint.
        assert!(!trusted_publisher_has(&"00".repeat(20)).unwrap());
    }
}
