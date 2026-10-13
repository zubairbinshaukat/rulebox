//! Read-only facts about this PC: version, edition, S mode, join state, RAM,
//! disk, names.

use std::path::{Path, PathBuf};

use windows::core::{PCWSTR, PWSTR};
use windows::Wdk::System::SystemServices::RtlGetVersion;
use windows::Win32::NetworkManagement::NetManagement::{
    NetFreeAadJoinInformation, NetGetAadJoinInformation, NetGetJoinInformation, NetSetupDomainName,
    DSREG_DEVICE_JOIN, DSREG_JOIN_INFO, NETSETUP_JOIN_STATUS,
};
use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
use windows::Win32::System::SystemInformation::{
    ComputerNameNetBIOS, GetComputerNameExW, GetNativeSystemInfo, GetProductInfo, GetSystemWindowsDirectoryW,
    GlobalMemoryStatusEx, MEMORYSTATUSEX, OSVERSIONINFOW, OS_PRODUCT_TYPE, PROCESSOR_ARCHITECTURE_AMD64,
    PROCESSOR_ARCHITECTURE_ARM64, PROCESSOR_ARCHITECTURE_INTEL, SYSTEM_INFO,
};

use crate::error::{api_err, code_err, Result, Win32Error};
use crate::registry::{get_hklm, RegValue};
use crate::util::{to_wide, NetApiBuffer};

const CURRENT_VERSION_KEY: &str = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion";
const CI_POLICY_KEY: &str = r"SYSTEM\CurrentControlSet\Control\CI\Policy";
const CRYPTOGRAPHY_KEY: &str = r"SOFTWARE\Microsoft\Cryptography";
const MIB: u64 = 1024 * 1024;
const GIB: u64 = 1024 * MIB;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OsVersion {
    pub major: u32,
    pub minor: u32,
    pub build: u32,
    /// Update build revision (the number after the dot in "26100.4652").
    pub ubr: u32,
    /// For example "24H2"; empty if the PC has neither `DisplayVersion` nor `ReleaseId`.
    pub display_version: String,
    /// For example "Professional", "Core" (Home), "Enterprise".
    pub edition_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct JoinState {
    pub domain_joined: bool,
    /// Microsoft Entra joined (not merely "registered", the personal-device case).
    pub entra_joined: bool,
}

fn hklm_string(path: &str, name: &str) -> Result<Option<String>> {
    Ok(match get_hklm(path, name)? {
        Some(RegValue::String(text)) => Some(text),
        Some(RegValue::Dword(_)) | None => None,
    })
}

/// `RtlGetVersion` (not subject to the compatibility shims of `GetVersionEx`)
/// plus `UBR`, `DisplayVersion` and `EditionID` from the registry.
pub fn os_version() -> Result<OsVersion> {
    let mut info = OSVERSIONINFOW {
        dwOSVersionInfoSize: u32::try_from(std::mem::size_of::<OSVERSIONINFOW>()).unwrap_or(0),
        ..Default::default()
    };
    // SAFETY: `info` is a valid OSVERSIONINFOW with its size field set.
    let status = unsafe { RtlGetVersion(&mut info) };
    if status.is_err() {
        return Err(Win32Error::Nt { api: "RtlGetVersion", status: status.0 });
    }
    let ubr = match get_hklm(CURRENT_VERSION_KEY, "UBR")? {
        Some(RegValue::Dword(ubr)) => ubr,
        _ => 0,
    };
    let display_version = match hklm_string(CURRENT_VERSION_KEY, "DisplayVersion")? {
        Some(text) => text,
        None => hklm_string(CURRENT_VERSION_KEY, "ReleaseId")?.unwrap_or_default(),
    };
    let edition_id = hklm_string(CURRENT_VERSION_KEY, "EditionID")?.unwrap_or_default();
    Ok(OsVersion {
        major: info.dwMajorVersion,
        minor: info.dwMinorVersion,
        build: info.dwBuildNumber,
        ubr,
        display_version,
        edition_id,
    })
}

/// The product type from `GetProductInfo` (for example `0x30` Professional,
/// `0x65` Core/Home).
pub fn product_type() -> Result<u32> {
    let version = os_version()?;
    let mut kind = OS_PRODUCT_TYPE::default();
    // SAFETY: `kind` is a valid out pointer.
    let ok = unsafe { GetProductInfo(version.major, version.minor, 0, 0, &mut kind) };
    if !ok.as_bool() {
        return Err(Win32Error::Invalid("GetProductInfo returned no product type".into()));
    }
    Ok(kind.0)
}

/// Windows in S mode: `HKLM\SYSTEM\CurrentControlSet\Control\CI\Policy\SkuPolicyRequired == 1`.
pub fn s_mode() -> Result<bool> {
    Ok(matches!(get_hklm(CI_POLICY_KEY, "SkuPolicyRequired")?, Some(RegValue::Dword(1))))
}

/// Frees a `DSREG_JOIN_INFO` from `NetGetAadJoinInformation`.
struct AadJoinInfo(*mut DSREG_JOIN_INFO);

impl Drop for AadJoinInfo {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: the pointer came from `NetGetAadJoinInformation`, whose documented
            // release function this is; freed once.
            unsafe { NetFreeAadJoinInformation(Some(self.0.cast_const())) };
        }
    }
}

/// `NetGetJoinInformation` (domain) and `NetGetAadJoinInformation` (Entra; a
/// null result means not joined).
pub fn join_state() -> Result<JoinState> {
    let mut name = PWSTR::null();
    let mut status = NETSETUP_JOIN_STATUS::default();
    // SAFETY: null server = this PC; both out pointers are valid. The name buffer
    // is freed by `_name`.
    let rc = unsafe { NetGetJoinInformation(PCWSTR::null(), &mut name, &mut status) };
    let _name = NetApiBuffer::new(name.0.cast());
    if rc != 0 {
        return Err(code_err("NetGetJoinInformation", rc));
    }
    // SAFETY: null tenant id = the join of this device.
    let info = unsafe { NetGetAadJoinInformation(PCWSTR::null()) }
        .map_err(|e| api_err("NetGetAadJoinInformation", &e))?;
    let info = AadJoinInfo(info);
    let entra_joined = if info.0.is_null() {
        false
    } else {
        // SAFETY: non-null result points to a DSREG_JOIN_INFO owned by `info`.
        unsafe { (*info.0).joinType == DSREG_DEVICE_JOIN }
    };
    Ok(JoinState { domain_joined: status == NetSetupDomainName, entra_joined })
}

/// Installed physical memory in MB.
pub fn memory_mb() -> Result<u64> {
    let mut status = MEMORYSTATUSEX {
        dwLength: u32::try_from(std::mem::size_of::<MEMORYSTATUSEX>()).unwrap_or(0),
        ..Default::default()
    };
    // SAFETY: `status` is valid with its length set.
    unsafe { GlobalMemoryStatusEx(&mut status) }.map_err(|e| api_err("GlobalMemoryStatusEx", &e))?;
    Ok(status.ullTotalPhys / MIB)
}

/// Free space (available to this process) on the volume holding `path`, in whole GB.
pub fn disk_free_gb(path: &Path) -> Result<u64> {
    let wide = to_wide(&path.to_string_lossy());
    let mut available = 0u64;
    // SAFETY: `wide` is NUL-terminated; `available` is a valid out pointer.
    unsafe { GetDiskFreeSpaceExW(PCWSTR(wide.as_ptr()), Some(&mut available), None, None) }
        .map_err(|e| api_err("GetDiskFreeSpaceExW", &e))?;
    Ok(available / GIB)
}

/// The root of the drive Windows is installed on, for example `C:\`.
pub fn system_drive() -> Result<PathBuf> {
    let mut buf = [0u16; 512];
    // SAFETY: `buf` is a valid, writable buffer of the length passed.
    let len = unsafe { GetSystemWindowsDirectoryW(Some(&mut buf)) } as usize;
    if len == 0 || len >= buf.len() {
        return Err(Win32Error::Invalid("cannot read the Windows directory".into()));
    }
    let windows_dir = PathBuf::from(String::from_utf16_lossy(&buf[..len]));
    windows_dir
        .ancestors()
        .last()
        .map(Path::to_path_buf)
        .ok_or_else(|| Win32Error::Invalid("the Windows directory has no root".into()))
}

/// The NetBIOS computer name, the same value as `$env:COMPUTERNAME`.
pub fn computer_name() -> Result<String> {
    let mut buf = [0u16; 64];
    let mut len = u32::try_from(buf.len()).unwrap_or(0);
    // SAFETY: `buf` is valid for `len` UTF-16 units and `len` is a valid out pointer.
    unsafe { GetComputerNameExW(ComputerNameNetBIOS, Some(PWSTR(buf.as_mut_ptr())), &mut len) }
        .map_err(|e| api_err("GetComputerNameExW", &e))?;
    let len = (len as usize).min(buf.len());
    Ok(String::from_utf16_lossy(&buf[..len]))
}

/// `HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid`.
pub fn machine_guid() -> Result<String> {
    hklm_string(CRYPTOGRAPHY_KEY, "MachineGuid")?.ok_or(Win32Error::NotFound)
}

/// The processor architecture of the OS: "x86_64", "arm64", "x86" or "unknown".
pub fn arch() -> String {
    let mut info = SYSTEM_INFO::default();
    // SAFETY: `info` is a valid out pointer.
    unsafe { GetNativeSystemInfo(&mut info) };
    // SAFETY: GetNativeSystemInfo fills the union's structure variant.
    let arch = unsafe { info.Anonymous.Anonymous.wProcessorArchitecture };
    match arch {
        PROCESSOR_ARCHITECTURE_AMD64 => "x86_64",
        PROCESSOR_ARCHITECTURE_ARM64 => "arm64",
        PROCESSOR_ARCHITECTURE_INTEL => "x86",
        _ => "unknown",
    }
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_memory_and_names() {
        let version = os_version().unwrap();
        assert!(version.build >= 19045, "{version:?}");
        assert_eq!(version.major, 10);
        assert!(!version.edition_id.is_empty());
        assert!(memory_mb().unwrap() > 0);
        assert!(!computer_name().unwrap().is_empty());
        assert_eq!(machine_guid().unwrap().len(), 36);
        assert!(product_type().unwrap() > 0);
        assert_ne!(arch(), "unknown");
    }

    #[test]
    fn disk_and_join_state_are_readable() {
        let drive = system_drive().unwrap();
        assert!(drive.is_absolute() && drive.parent().is_none(), "{}", drive.display());
        let _ = disk_free_gb(&drive).unwrap();
        let _ = join_state().unwrap();
        let _ = s_mode().unwrap();
    }
}
