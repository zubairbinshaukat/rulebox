//! The physical-protection report of plan 4.16 (`deviceReports.security`). Read-only.
//!
//! Secure Boot is read from the registry. BitLocker (`Win32_EncryptableVolume`) and the
//! TPM (`Win32_Tpm`) are read through WMI (`wmi.rs`, Step 5). A value that cannot be read
//! reports `Unknown`, which the dashboard shows as "not checked" and the BCD rule treats
//! as "BitLocker may be on" (the safe side: nothing is changed).

use crate::codeintegrity::list_policies;
use crate::error::{Result, Win32Error};
use crate::registry::{get_hklm, RegValue};
use crate::wmi::{query_numbers, WBEM_E_INVALID_NAMESPACE};

const SECURE_BOOT_STATE: &str = r"SYSTEM\CurrentControlSet\Control\SecureBoot\State";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SecureBoot {
    On,
    Off,
    /// The PC is not UEFI, or does not support Secure Boot.
    Unsupported,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BitLocker {
    On,
    Off,
    Suspended,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tpm {
    Ready,
    Present,
    Absent,
    Unknown,
}

/// What the device reports about its protection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SecurityPosture {
    pub secure_boot: SecureBoot,
    pub bit_locker: BitLocker,
    pub tpm: Tpm,
    /// Ids of the App Control policies in the active folder (the agent keeps only its own).
    pub ci_policies: Vec<String>,
}

/// `UEFISecureBootEnabled`: 1 on, 0 off, missing = not supported.
pub fn secure_boot_from(value: Option<RegValue>) -> SecureBoot {
    match value {
        Some(RegValue::Dword(1)) => SecureBoot::On,
        Some(RegValue::Dword(_)) => SecureBoot::Off,
        _ => SecureBoot::Unsupported,
    }
}

/// `Win32_EncryptableVolume.ProtectionStatus` (0 off, 1 on, 2 unknown) and
/// `EncryptionMethod` (0 = the volume is not encrypted) of the OS volume. Protection off
/// on an encrypted volume is "suspended". No instance (BitLocker feature missing) is off;
/// anything unreadable is `Unknown`, which the BCD rule treats as "BitLocker may be on".
pub fn bit_locker_from(volume: Option<(Option<u32>, Option<u32>)>) -> BitLocker {
    match volume {
        None => BitLocker::Off,
        Some((Some(1), _)) => BitLocker::On,
        Some((Some(0), Some(0))) => BitLocker::Off,
        Some((Some(0), Some(_))) => BitLocker::Suspended,
        Some(_) => BitLocker::Unknown,
    }
}

/// `Win32_Tpm` has no instance when there is no TPM; an instance is `Ready` when it is
/// enabled, activated and owned (`*_InitialValue` properties, 1 = true).
pub fn tpm_from(instance: Option<(Option<u32>, Option<u32>, Option<u32>)>) -> Tpm {
    match instance {
        None => Tpm::Absent,
        Some((Some(1), Some(1), Some(1))) => Tpm::Ready,
        Some((Some(_), Some(_), Some(_))) => Tpm::Present,
        Some(_) => Tpm::Unknown,
    }
}

fn read_bit_locker() -> BitLocker {
    let result = query_numbers(
        r"ROOT\CIMV2\Security\MicrosoftVolumeEncryption",
        "SELECT ProtectionStatus, EncryptionMethod FROM Win32_EncryptableVolume WHERE DriveLetter = 'C:'",
        &["ProtectionStatus", "EncryptionMethod"],
    );
    match result {
        Ok(rows) => bit_locker_from(rows.map(|values| (values.first().copied().flatten(), values.get(1).copied().flatten()))),
        // No BitLocker namespace: the feature is not there, so nothing is encrypted.
        Err(Win32Error::Api { code, .. }) if code == WBEM_E_INVALID_NAMESPACE => BitLocker::Off,
        Err(_) => BitLocker::Unknown,
    }
}

fn read_tpm() -> Tpm {
    let result = query_numbers(
        r"ROOT\CIMV2\Security\MicrosoftTpm",
        "SELECT IsEnabled_InitialValue, IsActivated_InitialValue, IsOwned_InitialValue FROM Win32_Tpm",
        &["IsEnabled_InitialValue", "IsActivated_InitialValue", "IsOwned_InitialValue"],
    );
    match result {
        Ok(rows) => tpm_from(rows.map(|values| {
            let at = |i: usize| values.get(i).copied().flatten();
            (at(0), at(1), at(2))
        })),
        Err(Win32Error::Api { code, .. }) if code == WBEM_E_INVALID_NAMESPACE => Tpm::Absent,
        Err(_) => Tpm::Unknown,
    }
}

/// Reads the posture. Never changes anything.
pub fn read_security_posture() -> Result<SecurityPosture> {
    Ok(SecurityPosture {
        secure_boot: secure_boot_from(get_hklm(SECURE_BOOT_STATE, "UEFISecureBootEnabled")?),
        bit_locker: read_bit_locker(),
        tpm: read_tpm(),
        ci_policies: list_policies()?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secure_boot_values_map() {
        assert_eq!(secure_boot_from(Some(RegValue::Dword(1))), SecureBoot::On);
        assert_eq!(secure_boot_from(Some(RegValue::Dword(0))), SecureBoot::Off);
        assert_eq!(secure_boot_from(None), SecureBoot::Unsupported);
        assert_eq!(secure_boot_from(Some(RegValue::String("1".into()))), SecureBoot::Unsupported);
    }

    #[test]
    fn bit_locker_values_map() {
        assert_eq!(bit_locker_from(Some((Some(1), Some(7)))), BitLocker::On);
        assert_eq!(bit_locker_from(Some((Some(0), Some(0)))), BitLocker::Off);
        assert_eq!(bit_locker_from(Some((Some(0), Some(6)))), BitLocker::Suspended);
        assert_eq!(bit_locker_from(None), BitLocker::Off);
        assert_eq!(bit_locker_from(Some((Some(2), Some(0)))), BitLocker::Unknown);
        assert_eq!(bit_locker_from(Some((None, None))), BitLocker::Unknown);
        assert_eq!(bit_locker_from(Some((Some(0), None))), BitLocker::Unknown);
    }

    #[test]
    fn tpm_values_map() {
        assert_eq!(tpm_from(None), Tpm::Absent);
        assert_eq!(tpm_from(Some((Some(1), Some(1), Some(1)))), Tpm::Ready);
        assert_eq!(tpm_from(Some((Some(1), Some(0), Some(1)))), Tpm::Present);
        assert_eq!(tpm_from(Some((Some(0), Some(0), Some(0)))), Tpm::Present);
        assert_eq!(tpm_from(Some((Some(1), None, Some(1)))), Tpm::Unknown);
    }

    /// Reads the real machine; never writes. Run by hand.
    #[test]
    #[ignore = "reads the real machine's protection state"]
    fn smoke_read_security_posture() {
        let posture = read_security_posture().unwrap();
        println!("{posture:?}");
    }
}
