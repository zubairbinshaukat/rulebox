//! The Staff user's own shell value and per-user policy values, written into that
//! user's hive.
//!
//! This module contains no code path that can open the machine hive (HKLM): every
//! write goes through a [`HiveKey`], which only `registry::with_user_hive` can
//! produce. The machine-wide `Winlogon\Shell` is therefore out of reach by
//! construction (plan Section 9, "Admin way back is protected in code").

use std::path::Path;

use crate::error::Result;
use crate::guard::require_test_machine;
use crate::registry::{with_user_hive, HiveKey, RegValue};
use crate::sid::Sid;

/// Per-user policy key (relative to the user's hive); value `Shell`.
pub const POLICY_SHELL_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Policies\System";
/// Per-user Winlogon key (relative to the user's hive); value `Shell`.
pub const WINLOGON_SHELL_KEY: &str = r"Software\Microsoft\Windows NT\CurrentVersion\Winlogon";
pub const SHELL_VALUE: &str = "Shell";

/// Where the shell value goes (agent config `shellMechanism`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mechanism {
    PolicyShell,
    WinlogonShell,
}

impl Mechanism {
    /// The key, relative to the user's hive, that holds this mechanism's `Shell`.
    pub fn key(self) -> &'static str {
        match self {
            Mechanism::PolicyShell => POLICY_SHELL_KEY,
            Mechanism::WinlogonShell => WINLOGON_SHELL_KEY,
        }
    }
}

/// Writes (`Some`) or deletes (`None`) the shell value of `mechanism` in the hive
/// of `sid`.
///
/// DESTRUCTIVE: guarded.
pub fn set_user_shell(sid: &Sid, profile: &Path, mechanism: Mechanism, command: Option<&str>) -> Result<()> {
    require_test_machine()?;
    with_user_hive(sid, profile, |hive| write_shell(hive, mechanism, command))
}

/// Reads the shell value of `mechanism` in the hive of `sid` (it loads the hive,
/// so it is guarded like a write; used by the VM tests).
///
/// DESTRUCTIVE: guarded.
pub fn get_user_shell(sid: &Sid, profile: &Path, mechanism: Mechanism) -> Result<Option<String>> {
    require_test_machine()?;
    with_user_hive(sid, profile, |hive| match hive.get(mechanism.key(), SHELL_VALUE)? {
        Some(RegValue::String(text)) => Ok(Some(text)),
        Some(RegValue::Dword(_)) | None => Ok(None),
    })
}

/// Writes (`Some`) or deletes (`None`) a DWORD under the user's
/// `Policies\System` key (for example `DisableLockWorkstation`).
///
/// DESTRUCTIVE: guarded.
pub fn set_user_policy_dword(sid: &Sid, profile: &Path, name: &str, value: Option<u32>) -> Result<()> {
    require_test_machine()?;
    if name.eq_ignore_ascii_case(SHELL_VALUE) {
        return Err(crate::Win32Error::Invalid("the shell value is written with set_user_shell".into()));
    }
    let value = value.map(RegValue::Dword);
    with_user_hive(sid, profile, |hive| hive.set(POLICY_SHELL_KEY, name, value.as_ref()))
}

fn write_shell(hive: &HiveKey, mechanism: Mechanism, command: Option<&str>) -> Result<()> {
    let value = command.map(|c| RegValue::String(c.to_string()));
    hive.set(mechanism.key(), SHELL_VALUE, value.as_ref())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Win32Error;

    #[test]
    fn keys_are_relative_to_a_user_hive() {
        for key in [POLICY_SHELL_KEY, WINLOGON_SHELL_KEY] {
            // Relative paths (they start with "Software\", not a root key), opened only
            // below a HiveKey.
            assert!(key.starts_with(r"Software\"), "{key}");
            assert!(!key.to_ascii_uppercase().starts_with("HKEY_"), "{key}");
        }
    }

    #[test]
    fn this_module_never_names_the_machine_hive() {
        let source = include_str!("shellreg.rs");
        let forbidden = concat!("HKEY_LOCAL", "_MACHINE");
        assert!(!source.contains(forbidden));
        assert!(!source.contains(concat!("get_", "hklm")) && !source.contains(concat!("set_", "hklm")));
    }

    #[test]
    fn every_write_is_blocked_by_the_guard() {
        let sid = crate::sid::current_user_sid().unwrap();
        let profile = Path::new(r"C:\rulebox-no-such-profile");
        for mechanism in [Mechanism::PolicyShell, Mechanism::WinlogonShell] {
            assert!(matches!(set_user_shell(&sid, profile, mechanism, Some("x")), Err(Win32Error::Guard(_))));
            assert!(matches!(set_user_shell(&sid, profile, mechanism, None), Err(Win32Error::Guard(_))));
            assert!(matches!(get_user_shell(&sid, profile, mechanism), Err(Win32Error::Guard(_))));
        }
        assert!(matches!(
            set_user_policy_dword(&sid, profile, "DisableLockWorkstation", Some(1)),
            Err(Win32Error::Guard(_))
        ));
    }
}
