//! Who made a program file (Phase 5 Step 8): the stamp that keys the watchdog's cache, the
//! signer of a signature check and the names in the version resource. Everything here only
//! reads; nothing changes the machine.
//!
//! The signer is the subject of the leaf certificate of a **valid** signature, written in the
//! form AppLocker publisher rules use (`CN=Microsoft Windows, O=Microsoft Corporation, ...`).
//! Most files of Windows are signed through a catalog, not inside the file, so after the embedded
//! signature the catalog that lists the file's hash is tried. No network is used: revocation is
//! not checked and URL retrieval is cache-only (a lookup must finish in milliseconds).

use std::ffi::c_void;
use std::os::windows::fs::MetadataExt;
use std::os::windows::io::AsRawHandle;
use std::path::Path;

use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{HANDLE, HWND, INVALID_HANDLE_VALUE};
use windows::Win32::Security::Cryptography::Catalog::{
    CryptCATAdminAcquireContext2, CryptCATAdminCalcHashFromFileHandle2, CryptCATAdminEnumCatalogFromHash,
    CryptCATAdminReleaseCatalogContext, CryptCATAdminReleaseContext, CryptCATCatalogInfoFromContext, CATALOG_INFO,
};
use windows::Win32::Security::Cryptography::{CertGetCertificateContextProperty, CertGetNameStringW, CERT_CONTEXT};
use windows::Win32::Security::WinTrust::{
    WTHelperGetProvCertFromChain, WTHelperGetProvSignerFromChain, WTHelperProvDataFromStateData, WinVerifyTrust,
    WINTRUST_ACTION_GENERIC_VERIFY_V2, WINTRUST_CATALOG_INFO, WINTRUST_DATA, WINTRUST_FILE_INFO,
    WTD_CACHE_ONLY_URL_RETRIEVAL, WTD_CHOICE_CATALOG, WTD_CHOICE_FILE, WTD_REVOCATION_CHECK_NONE, WTD_REVOKE_NONE,
    WTD_STATEACTION_CLOSE, WTD_STATEACTION_VERIFY, WTD_UI_NONE,
};
use windows::Win32::Storage::FileSystem::{GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW};

use crate::error::{code_err, Result};
use crate::util::to_wide;

/// What changes when a file is replaced: the key of the watchdog's signature cache (plan
/// Section 14: path + file id + size + time). The creation time stands in for the file id.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct FileStamp {
    pub created: u64,
    pub modified: u64,
    pub size: u64,
}

/// The stamp of a file. `Ok(None)`: no such file. Read-only.
pub fn file_stamp(path: &Path) -> Result<Option<FileStamp>> {
    match std::fs::metadata(path) {
        Ok(meta) if meta.is_file() => {
            Ok(Some(FileStamp { created: meta.creation_time(), modified: meta.last_write_time(), size: meta.file_size() }))
        }
        Ok(_) => Ok(None),
        Err(error) if matches!(error.kind(), std::io::ErrorKind::NotFound) => Ok(None),
        Err(error) => Err(code_err("GetFileAttributesExW", error.raw_os_error().unwrap_or(0) as u32)),
    }
}

/// What a program file says about itself.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FileIdentity {
    /// The leaf certificate subject of a valid signature (embedded or catalog); `None`: unsigned
    /// or not trusted.
    pub signer: Option<String>,
    /// `OriginalFilename` of the version resource.
    pub original_name: Option<String>,
    /// `ProductName` of the version resource.
    pub product: Option<String>,
}

/// The signer and the version-resource names of a file. `Ok(None)`: no such file. A file that
/// cannot be read for another reason gives an identity with nothing in it. Read-only.
pub fn file_identity(path: &Path) -> Result<Option<FileIdentity>> {
    if file_stamp(path)?.is_none() {
        return Ok(None);
    }
    let (original_name, product) = version_names(path);
    Ok(Some(FileIdentity { signer: signer_of(path), original_name, product }))
}

// -- the version resource ---------------------------------------------------------------------

fn version_names(path: &Path) -> (Option<String>, Option<String>) {
    let wide = to_wide(&path.to_string_lossy());
    // SAFETY: `wide` is NUL-terminated and outlives the call.
    let size = unsafe { GetFileVersionInfoSizeW(PCWSTR(wide.as_ptr()), None) };
    if size == 0 || size > 4 * 1024 * 1024 {
        return (None, None);
    }
    // A `u32` backing keeps the block 4-byte aligned, as the version functions expect.
    let mut block = vec![0u32; (size as usize).div_ceil(4)];
    // SAFETY: `block` has room for `size` bytes.
    if unsafe { GetFileVersionInfoW(PCWSTR(wide.as_ptr()), Some(0), size, block.as_mut_ptr().cast()) }.is_err() {
        return (None, None);
    }
    let base: *const c_void = block.as_ptr().cast();
    // The first language and code page; English (Unicode) when the block has no table.
    let (language, code_page) = query(base, "\\VarFileInfo\\Translation")
        .filter(|(_, units)| *units >= 2)
        .map(|(ptr, _)| {
            // SAFETY: the system returned a pointer to at least two 16-bit values inside `block`.
            let pair = unsafe { std::slice::from_raw_parts(ptr.cast::<u16>(), 2) };
            (pair[0], pair[1])
        })
        .unwrap_or((0x0409, 0x04B0));
    let read = |name: &str| -> Option<String> {
        let (ptr, chars) = query(base, &format!("\\StringFileInfo\\{language:04x}{code_page:04x}\\{name}"))?;
        // SAFETY: the system returned a pointer to `chars` UTF-16 units inside `block`.
        let units = unsafe { std::slice::from_raw_parts(ptr.cast::<u16>(), chars as usize) };
        let end = units.iter().position(|unit| *unit == 0).unwrap_or(units.len());
        let text = String::from_utf16_lossy(&units[..end]).trim().to_string();
        (!text.is_empty()).then_some(text)
    };
    // Language-neutral programs keep their strings in a `.mui` file, which names itself
    // (`cmd.exe.mui`): the program's name is what matters.
    let original = read("OriginalFilename").map(|name| match name.to_ascii_lowercase().strip_suffix(".mui") {
        Some(stem) => stem.to_string(),
        None => name,
    });
    (original, read("ProductName"))
}

/// A sub-block of a version block: the pointer and its length in `u16` units for strings, in
/// 16-bit values for the translation table (`VerQueryValue` reports a string's length in
/// characters and a binary value's in bytes; the caller of the table divides below).
fn query(block: *const c_void, sub_block: &str) -> Option<(*const c_void, u32)> {
    let wide = to_wide(sub_block);
    let mut pointer: *mut c_void = std::ptr::null_mut();
    let mut length = 0u32;
    // SAFETY: `block` is a version block that outlives the call; the out pointers are valid.
    let found = unsafe { VerQueryValueW(block, PCWSTR(wide.as_ptr()), &mut pointer, &mut length) };
    if !found.as_bool() || pointer.is_null() || length == 0 {
        return None;
    }
    let units = if sub_block.ends_with("Translation") { length / 2 } else { length };
    Some((pointer.cast_const(), units))
}

// -- the signature ----------------------------------------------------------------------------

/// The signer of a valid signature: embedded first, then by catalog.
fn signer_of(path: &Path) -> Option<String> {
    let wide = to_wide(&path.to_string_lossy());
    embedded_signer(&wide).or_else(|| catalog_signer(path, &wide))
}

fn no_ui_window() -> HWND {
    // INVALID_HANDLE_VALUE as the window means "no user interface".
    HWND(INVALID_HANDLE_VALUE.0)
}

/// Runs `WinVerifyTrust` for `data` (a state handle is kept open), reads the leaf certificate
/// subject when the signature is valid, and always closes the state.
fn verify(data: &mut WINTRUST_DATA) -> Option<String> {
    verify_with(data, leaf_subject)
}

/// [`verify`] with the reader of the leaf certificate chosen by the caller. The reader runs only after a valid
/// signature, while the state is open.
fn verify_with<T>(data: &mut WINTRUST_DATA, read: unsafe fn(HANDLE) -> Option<T>) -> Option<T> {
    let mut action = WINTRUST_ACTION_GENERIC_VERIFY_V2;
    data.dwStateAction = WTD_STATEACTION_VERIFY;
    // SAFETY: `data` is fully set up and its file or catalog info outlives the call.
    let result = unsafe { WinVerifyTrust(no_ui_window(), &mut action, std::ptr::from_mut(data).cast()) };
    let found = if result == 0 {
        // SAFETY: the state handle came from the successful verify above and is closed below.
        unsafe { read(data.hWVTStateData) }
    } else {
        None
    };
    data.dwStateAction = WTD_STATEACTION_CLOSE;
    // SAFETY: closes the state opened above, with the same data.
    let _ = unsafe { WinVerifyTrust(no_ui_window(), &mut action, std::ptr::from_mut(data).cast()) };
    found
}

/// The leaf certificate of the first signer of an open, successful `WinVerifyTrust` state (null: none).
///
/// # Safety
/// `state` must be the state handle of a successful `WinVerifyTrust` that is still open.
unsafe fn leaf_context(state: HANDLE) -> *const CERT_CONTEXT {
    // SAFETY: per the contract the state is open; the helpers return pointers into it (or null).
    unsafe {
        let provider = WTHelperProvDataFromStateData(state);
        if provider.is_null() {
            return std::ptr::null();
        }
        let signer = WTHelperGetProvSignerFromChain(provider, 0, false, 0);
        if signer.is_null() {
            return std::ptr::null();
        }
        let cert = WTHelperGetProvCertFromChain(signer, 0);
        if cert.is_null() {
            return std::ptr::null();
        }
        (*cert).pCert
    }
}

/// # Safety
/// `state` must be the state handle of a successful `WinVerifyTrust` that is still open.
unsafe fn leaf_subject(state: HANDLE) -> Option<String> {
    // SAFETY: per the contract the state is open; the context is read while it is.
    unsafe { subject_of(leaf_context(state)) }
}

/// The certificate that signed a file, as the machine's trust store needs it: the DER bytes and both thumbprints
/// (lower-case hex of the SHA-1 and the SHA-256 of the DER, what Windows shows as "Thumbprint").
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignerCert {
    /// The subject in the form of [`FileIdentity::signer`]. For display only: never what trust is decided by.
    pub subject: String,
    pub sha1: String,
    pub sha256: String,
    pub der: Vec<u8>,
}

/// Most DER bytes of a signer certificate that are read (a real certificate is 1 to 3 KiB).
const MAX_CERT_DER: usize = 16 * 1024;
/// `CERT_SHA1_HASH_PROP_ID` and `CERT_SHA256_HASH_PROP_ID`.
const SHA1_PROP: u32 = 3;
const SHA256_PROP: u32 = 107;

/// # Safety
/// `cert` must be a certificate context that stays valid for the call.
unsafe fn hash_property(cert: *const CERT_CONTEXT, property: u32, size: usize) -> Option<String> {
    let mut bytes = vec![0u8; size];
    let mut length = size as u32;
    // SAFETY: `bytes` has room for `length` bytes; `cert` is valid per the contract.
    unsafe { CertGetCertificateContextProperty(cert, property, Some(bytes.as_mut_ptr().cast()), &mut length) }.ok()?;
    (length as usize == size).then(|| bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// # Safety
/// `state` must be the state handle of a successful `WinVerifyTrust` that is still open.
unsafe fn leaf_cert(state: HANDLE) -> Option<SignerCert> {
    // SAFETY: per the contract the state is open; the context and its encoded bytes live as long as it does.
    unsafe {
        let cert = leaf_context(state);
        if cert.is_null() {
            return None;
        }
        let (bytes, length) = ((*cert).pbCertEncoded, (*cert).cbCertEncoded as usize);
        if bytes.is_null() || length == 0 || length > MAX_CERT_DER {
            return None;
        }
        Some(SignerCert {
            subject: subject_of(cert)?,
            sha1: hash_property(cert, SHA1_PROP, 20)?,
            sha256: hash_property(cert, SHA256_PROP, 32)?,
            der: std::slice::from_raw_parts(bytes, length).to_vec(),
        })
    }
}

/// The certificate of the **embedded** signature of a file when that signature is valid (a `.cat` catalog is such a
/// file: its own signature is embedded). `Ok(None)`: no such file, unsigned, or not trusted. No catalog lookup, no
/// network (same rules as [`file_identity`]). Read-only.
pub fn signer_cert(path: &Path) -> Result<Option<SignerCert>> {
    if file_stamp(path)?.is_none() {
        return Ok(None);
    }
    let wide = to_wide(&path.to_string_lossy());
    let mut file = WINTRUST_FILE_INFO {
        cbStruct: std::mem::size_of::<WINTRUST_FILE_INFO>() as u32,
        pcwszFilePath: PCWSTR(wide.as_ptr()),
        ..Default::default()
    };
    let mut data = base_data(WTD_CHOICE_FILE.0);
    data.Anonymous.pFile = &mut file;
    Ok(verify_with(&mut data, leaf_cert))
}

/// The subject in X.500 text, most specific part first (`CN=..., O=..., L=..., S=..., C=...`).
///
/// # Safety
/// `cert` must be null or a certificate context that stays valid for the call.
unsafe fn subject_of(cert: *const CERT_CONTEXT) -> Option<String> {
    if cert.is_null() {
        return None;
    }
    // CERT_NAME_RDN_TYPE (2) with the string type CERT_X500_NAME_STR (3) and
    // CERT_NAME_STR_REVERSE_FLAG (0x0200_0000): the order of the plan's publisher strings.
    let string_type: u32 = 3 | 0x0200_0000;
    let parameter = std::ptr::from_ref(&string_type).cast::<c_void>();
    // SAFETY: the first call asks for the length, the second fills a buffer of that size.
    unsafe {
        let needed = CertGetNameStringW(cert, 2, 0, Some(parameter), None);
        if needed <= 1 || needed > 2048 {
            return None;
        }
        let mut buffer = vec![0u16; needed as usize];
        let written = CertGetNameStringW(cert, 2, 0, Some(parameter), Some(&mut buffer));
        let text = String::from_utf16_lossy(&buffer[..(written as usize).saturating_sub(1)]);
        (!text.is_empty()).then_some(text)
    }
}

fn embedded_signer(wide_path: &[u16]) -> Option<String> {
    let mut file = WINTRUST_FILE_INFO {
        cbStruct: std::mem::size_of::<WINTRUST_FILE_INFO>() as u32,
        pcwszFilePath: PCWSTR(wide_path.as_ptr()),
        ..Default::default()
    };
    let mut data = base_data(WTD_CHOICE_FILE.0);
    data.Anonymous.pFile = &mut file;
    verify(&mut data)
}

fn base_data(choice: u32) -> WINTRUST_DATA {
    let mut data = WINTRUST_DATA {
        cbStruct: std::mem::size_of::<WINTRUST_DATA>() as u32,
        dwUIChoice: WTD_UI_NONE,
        fdwRevocationChecks: WTD_REVOKE_NONE,
        dwProvFlags: WTD_CACHE_ONLY_URL_RETRIEVAL | WTD_REVOCATION_CHECK_NONE,
        ..Default::default()
    };
    data.dwUnionChoice = windows::Win32::Security::WinTrust::WINTRUST_DATA_UNION_CHOICE(choice);
    data
}

/// The signer of a catalog that lists the file's hash (how most Windows programs are signed).
fn catalog_signer(path: &Path, wide_path: &[u16]) -> Option<String> {
    let file = std::fs::File::open(path).ok()?;
    let handle = HANDLE(file.as_raw_handle());
    for algorithm in [w!("SHA256"), w!("SHA1")] {
        if let Some(subject) = catalog_signer_with(algorithm, handle, wide_path) {
            return Some(subject);
        }
    }
    None
}

fn catalog_signer_with(algorithm: PCWSTR, file: HANDLE, wide_path: &[u16]) -> Option<String> {
    let mut admin = 0isize;
    // SAFETY: `admin` is a valid out value; the algorithm name is a static string.
    unsafe { CryptCATAdminAcquireContext2(&mut admin, None, algorithm, None, None) }.ok()?;
    let subject = catalog_signer_in(admin, file, wide_path);
    // SAFETY: releases the context acquired above, once.
    let _ = unsafe { CryptCATAdminReleaseContext(admin, 0) };
    subject
}

fn catalog_signer_in(admin: isize, file: HANDLE, wide_path: &[u16]) -> Option<String> {
    let mut hash = [0u8; 64];
    let mut hash_length = hash.len() as u32;
    // SAFETY: `hash` has room for `hash_length` bytes; `file` is an open file handle.
    unsafe { CryptCATAdminCalcHashFromFileHandle2(admin, file, &mut hash_length, Some(hash.as_mut_ptr()), None) }.ok()?;
    let hash = &mut hash[..hash_length as usize];
    // SAFETY: `hash` is a valid slice; no previous catalog.
    let catalog = unsafe { CryptCATAdminEnumCatalogFromHash(admin, hash, None, None) };
    if catalog == 0 {
        return None;
    }
    let subject = catalog_subject(admin, catalog, file, wide_path, hash);
    // SAFETY: releases the catalog context found above, once.
    let _ = unsafe { CryptCATAdminReleaseCatalogContext(admin, catalog, 0) };
    subject
}

fn catalog_subject(admin: isize, catalog: isize, file: HANDLE, wide_path: &[u16], hash: &mut [u8]) -> Option<String> {
    let mut info = CATALOG_INFO { cbStruct: std::mem::size_of::<CATALOG_INFO>() as u32, ..Default::default() };
    // SAFETY: `info` is a valid CATALOG_INFO with its size set.
    unsafe { CryptCATCatalogInfoFromContext(catalog, &mut info, 0) }.ok()?;
    // The member tag is the file hash in upper-case hex.
    let tag: String = hash.iter().map(|byte| format!("{byte:02X}")).collect();
    let tag = to_wide(&tag);
    let mut member = WINTRUST_CATALOG_INFO {
        cbStruct: std::mem::size_of::<WINTRUST_CATALOG_INFO>() as u32,
        pcwszCatalogFilePath: PCWSTR(info.wszCatalogFile.as_ptr()),
        pcwszMemberTag: PCWSTR(tag.as_ptr()),
        pcwszMemberFilePath: PCWSTR(wide_path.as_ptr()),
        hMemberFile: file,
        pbCalculatedFileHash: hash.as_mut_ptr(),
        cbCalculatedFileHash: hash.len() as u32,
        hCatAdmin: admin,
        ..Default::default()
    };
    let mut data = base_data(WTD_CHOICE_CATALOG.0);
    data.Anonymous.pCatalog = &mut member;
    verify(&mut data)
}

/// The first two parts of a subject (`CN=` and `O=`), the form findings carry (plan 4.10): the
/// place, state and country are left out.
pub fn short_signer(subject: &str) -> String {
    let parts: Vec<&str> = subject.split(", ").collect();
    let pick = |prefix: &str| parts.iter().find(|part| part.starts_with(prefix)).copied();
    [pick("CN="), pick("O=")].into_iter().flatten().collect::<Vec<_>>().join(", ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_stamp_of_a_missing_file_is_none_and_of_this_program_has_a_size() {
        assert_eq!(file_stamp(Path::new(r"C:\no such folder\x.exe")).unwrap(), None);
        let exe = std::env::current_exe().unwrap();
        let stamp = file_stamp(&exe).unwrap().unwrap();
        assert!(stamp.size > 0);
        assert_eq!(file_stamp(&exe).unwrap(), Some(stamp));
    }

    #[test]
    fn a_missing_file_has_no_identity() {
        assert_eq!(file_identity(Path::new(r"C:\no such folder\x.exe")).unwrap(), None);
    }

    #[test]
    fn a_file_of_windows_names_itself_and_this_unsigned_test_program_has_no_signer() {
        // Read-only: asks the signature APIs about two existing files. The Windows file is
        // found on every Windows (the folder comes from the environment).
        let windows = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
        let notepad = Path::new(&windows).join("System32").join("notepad.exe");
        if let Some(identity) = file_identity(&notepad).unwrap() {
            assert_eq!(identity.original_name.as_deref().map(str::to_ascii_lowercase).as_deref(), Some("notepad.exe"));
        }
        let cmd = file_identity(&Path::new(&windows).join("System32").join("cmd.exe")).unwrap().unwrap();
        assert_eq!(cmd.original_name.as_deref().map(str::to_ascii_lowercase).as_deref(), Some("cmd.exe"));
        // Windows' own programs are catalog-signed by Microsoft; a machine where the catalog
        // database cannot be read would give `None`, so only a present signer is checked.
        if let Some(signer) = &cmd.signer {
            assert!(signer.starts_with("CN=Microsoft Windows, O=Microsoft Corporation"), "{signer}");
        }
        let me = file_identity(&std::env::current_exe().unwrap()).unwrap().unwrap();
        assert_eq!(me.signer, None);
    }

    #[test]
    fn a_missing_or_unsigned_file_has_no_signer_certificate() {
        assert_eq!(signer_cert(Path::new(r"C:\no such folder\x.cat")).unwrap(), None);
        assert_eq!(signer_cert(&std::env::current_exe().unwrap()).unwrap(), None, "this unsigned test program");
        // A file of Windows that carries its own signature (when this one does), reads as a complete certificate.
        let windows = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
        for name in ["notepad.exe", "cmd.exe"] {
            if let Some(cert) = signer_cert(&Path::new(&windows).join("System32").join(name)).unwrap() {
                assert!(cert.subject.contains("Microsoft"), "{}", cert.subject);
                assert_eq!((cert.sha1.len(), cert.sha256.len()), (40, 64));
                assert!(cert.sha1.bytes().chain(cert.sha256.bytes()).all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')));
                assert_eq!(cert.der.first(), Some(&0x30), "DER starts with a SEQUENCE");
            }
        }
    }

    #[test]
    fn the_short_signer_keeps_the_name_and_the_organization() {
        assert_eq!(
            short_signer("CN=Microsoft Windows, O=Microsoft Corporation, L=Redmond, S=Washington, C=US"),
            "CN=Microsoft Windows, O=Microsoft Corporation"
        );
        assert_eq!(short_signer("O=Only"), "O=Only");
        assert_eq!(short_signer(""), "");
    }
}
