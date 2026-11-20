//! The install marker `HKLM\SOFTWARE\Rulebox\Install` (Phase 6 Step 8, plan 4.10 and 4.11).
//!
//! The MSI writes `InstallDir` and `Version`. The agent adds `ComputerName` (what the production
//! guard compares with this computer) and `KioskOn` (what the MSI's uninstall guard reads) at
//! **every** service start, because a major upgrade deletes the whole key.
//!
//! These writes use their own guard, [`require_marker_writable`](crate::guard::require_marker_writable):
//! the production door without its last condition, because `ComputerName` is the value being
//! written. Both functions only ever set one value of a key that **already exists** (the MSI's
//! `InstallDir` is what created it), so a PC without the MSI, a dev PC or a VM gets
//! [`MarkerWrite::NoMarker`] and nothing is created.
//!
//! The pending enrollment code (`Install\Pending`, value `Code`) is read through the agent's
//! read seam and deleted through `machinereg` (that key is on its allow-list, nothing else of
//! `Install` is).

use crate::error::{Result, Win32Error};
use crate::guard::{require_marker_writable, INSTALL_COMPUTER_VALUE, INSTALL_KEY};
use crate::registry::{set_hklm_existing_key, RegValue};

/// `KioskOn`: a DWORD, 1 while the kiosk is on, 0 otherwise (the MSI's `KIOSKON` search reads
/// it raw and compares with `"1"` and `"#1"`).
pub const KIOSK_ON_VALUE: &str = "KioskOn";
/// The pending enrollment code the MSI writes when `ENROLLCODE` is given: key and value.
pub const PENDING_KEY: &str = r"SOFTWARE\Rulebox\Install\Pending";
pub const PENDING_VALUE: &str = "Code";
/// The longest computer name accepted (NetBIOS names are at most 15; DNS labels 63).
pub const MAX_COMPUTER_NAME: usize = 63;

/// What a marker write did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MarkerWrite {
    Written,
    /// The `Install` key does not exist, so nothing was written (and nothing created).
    NoMarker,
}

/// The name rule (no API call): one to 63 characters, no control characters.
pub fn check_computer_name(name: &str) -> Result<()> {
    if name.is_empty() || name.chars().count() > MAX_COMPUTER_NAME || name.chars().any(char::is_control) {
        return Err(Win32Error::Invalid("the computer name is not usable as a marker value".into()));
    }
    Ok(())
}

fn written(wrote: bool) -> MarkerWrite {
    if wrote {
        MarkerWrite::Written
    } else {
        MarkerWrite::NoMarker
    }
}

/// Sets `Install\ComputerName`.
///
/// DESTRUCTIVE: guarded by the marker door (the production door without its last condition,
/// or either door open).
pub fn write_computer_name(name: &str) -> Result<MarkerWrite> {
    check_computer_name(name)?;
    require_marker_writable()?;
    set_hklm_existing_key(INSTALL_KEY, INSTALL_COMPUTER_VALUE, &RegValue::String(name.to_string())).map(written)
}

/// Sets `Install\KioskOn` to 1 or 0.
///
/// DESTRUCTIVE: guarded by the marker door (see [`write_computer_name`]).
pub fn write_kiosk_on(on: bool) -> Result<MarkerWrite> {
    require_marker_writable()?;
    set_hklm_existing_key(INSTALL_KEY, KIOSK_ON_VALUE, &RegValue::Dword(u32::from(on))).map(written)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn computer_names_are_checked_before_anything_else() {
        assert!(check_computer_name("DESK-01").is_ok());
        for bad in ["", "a\nb", "x\u{0}", &"n".repeat(64)] {
            assert!(matches!(write_computer_name(bad), Err(Win32Error::Invalid(_))), "{bad:?}");
        }
    }

    #[test]
    fn the_dev_machine_is_refused_before_the_registry_is_touched() {
        // A debug build has no production door and this PC has no test marker.
        assert!(matches!(write_computer_name("DESK-01"), Err(Win32Error::Guard(_))));
        assert!(matches!(write_kiosk_on(true), Err(Win32Error::Guard(_))));
    }

    #[test]
    fn both_writes_start_with_the_marker_guard() {
        // The text scan of the crate's guard test only knows `require_armed_machine`; these two
        // use the marker door, so their first statements are pinned here.
        let source = include_str!("installmarker.rs");
        let code = source.split("\n#[cfg(test)]").next().unwrap_or(source);
        for name in ["write_computer_name", "write_kiosk_on"] {
            let start = code.find(&format!("pub fn {name}")).unwrap_or(0);
            let body = &code[start..];
            let body = body.split("\n}\n").next().unwrap_or(body);
            let guard = body.find("require_marker_writable()?;");
            let write = body.find("set_hklm_existing_key(");
            assert!(guard.is_some() && write.is_some() && guard < write, "{name}");
        }
    }

    #[test]
    fn the_value_names_are_what_the_msi_and_the_guard_read() {
        assert_eq!(KIOSK_ON_VALUE, "KioskOn");
        assert_eq!(INSTALL_COMPUTER_VALUE, "ComputerName");
        assert_eq!(INSTALL_KEY, r"SOFTWARE\Rulebox\Install");
        assert_eq!(PENDING_KEY, format!(r"{INSTALL_KEY}\Pending"));
        assert_eq!(PENDING_VALUE, "Code");
    }
}
