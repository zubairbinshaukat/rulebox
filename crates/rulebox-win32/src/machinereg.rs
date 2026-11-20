//! Machine (HKLM) policy values behind Phase 5's L2 layer, L7 (Safe Mode
//! registration) and the USB device-class rules (plan 4.5, 4.7a, 4.8).
//!
//! One function writes, [`set_machine_value`], and it first checks the key against
//! [`ALLOWED_ROOTS`] and the name against the values that are never written. A key
//! outside the list returns `Win32Error::Forbidden` **before the guard** and before
//! any API call, so a bug in a layer cannot reach, say, `Run` or `Services`.
//!
//! `Winlogon` itself is not a subtree root: its values keep the Phase 2 rules of
//! `autologon::check_winlogon_value` (an allow-list of five names, and `Shell`,
//! `Userinit`, `IgnoreShiftOverride`, `ForceAutoLogon` never).

use crate::autologon::{check_winlogon_value, FORBIDDEN_WINLOGON_VALUES, WINLOGON_KEY};
use crate::error::{Result, Win32Error};
use crate::guard::require_armed_machine;
use crate::registry::{delete_hklm_key, get_hklm, list_hklm_value_names, set_hklm, RegValue};

/// The Safe Mode registration key name (plan 4.16). Under the two `SafeBoot` roots only
/// this one subkey is writable.
pub const SAFE_BOOT_SERVICE_KEY: &str = "RuleboxAgent";

/// The two `SafeBoot` roots: only `<root>\RuleboxAgent` is writable below them.
pub const SAFE_BOOT_ROOTS: &[&str] = &[
    r"SYSTEM\CurrentControlSet\Control\SafeBoot\Minimal",
    r"SYSTEM\CurrentControlSet\Control\SafeBoot\Network",
];

/// The device installation restrictions (plan 4.7a / 4.8). Its subtree holds
/// `DenyDeviceClasses`, `DenyDeviceClassesRetroactive` and the list subkey.
pub const DEVICE_INSTALL_RESTRICTIONS: &str = r"SOFTWARE\Policies\Microsoft\Windows\DeviceInstall\Restrictions";

/// (Step 18) `AllowTelemetry` lives here.
pub const DATA_COLLECTION: &str = r"SOFTWARE\Policies\Microsoft\Windows\DataCollection";
/// (Step 18) `DODownloadMode` lives here.
pub const DELIVERY_OPTIMIZATION: &str = r"SOFTWARE\Policies\Microsoft\Windows\DeliveryOptimization";

/// Every key set_machine_value can write (plan 4.5, 4.8, the Phase 2 roots, and the
/// device-class key of 4.7a, which 4.8's list did not name: added in Step 3). The whole
/// subtree of each is writable, except Winlogon (only the Phase 2 value names, and its
/// `SpecialAccounts\UserList` subkey is a root of its own) and the two SafeBoot roots
/// (only their RuleboxAgent subkey).
pub const ALLOWED_ROOTS: &[&str] = &[
    WINLOGON_KEY,
    r"SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System",
    r"SOFTWARE\Policies\Microsoft\Windows\OOBE",
    r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon\SpecialAccounts\UserList",
    r"SOFTWARE\Policies\Microsoft\Power\PowerSettings",
    r"SOFTWARE\Policies\Microsoft\Windows NT\Printers",
    r"SYSTEM\CurrentControlSet\Control\SafeBoot\Minimal",
    r"SYSTEM\CurrentControlSet\Control\SafeBoot\Network",
    DEVICE_INSTALL_RESTRICTIONS,
    // (Step 18, PRD 22.3) The kiosk performance profile: the diagnostic data level and
    // Delivery Optimization's download mode (peer sharing off). Policy keys only.
    DATA_COLLECTION,
    DELIVERY_OPTIMIZATION,
    // (Phase 6 Step 8) The MSI's pending enrollment code: the agent deletes its `Code` value
    // (plan 4.10). Nothing else of `HKLM\SOFTWARE\Rulebox\Install` is writable through here;
    // `ComputerName` and `KioskOn` go through `installmarker`.
    crate::installmarker::PENDING_KEY,
];

fn is_subtree_root(root: &str) -> bool {
    !root.eq_ignore_ascii_case(WINLOGON_KEY) && !SAFE_BOOT_ROOTS.contains(&root)
}

fn forbidden(path: &str) -> Win32Error {
    Win32Error::Forbidden(format!("the machine key {path:?} is not one Rulebox writes"))
}

/// True when `path` is `root` or below it (whole segments, case-insensitive).
fn under(path: &str, root: &str) -> bool {
    path.len() >= root.len()
        && path.is_char_boundary(root.len())
        && path[..root.len()].eq_ignore_ascii_case(root)
        && (path.len() == root.len() || path.as_bytes()[root.len()] == b'\\')
}

/// A path with an empty, `.` or `..` segment is never accepted.
fn plain_path(path: &str) -> bool {
    !path.is_empty() && path.split('\\').all(|segment| !matches!(segment, "" | "." | ".."))
}

/// The key and value rules, with no API call and no guard. `Ok` means the write
/// may go on to the guard.
pub fn check_write(path: &str, name: &str, value: Option<&RegValue>) -> Result<()> {
    let path = path.trim_matches('\\');
    if !plain_path(path) {
        return Err(forbidden(path));
    }
    if path.eq_ignore_ascii_case(WINLOGON_KEY) {
        return check_winlogon_value(name, value);
    }
    if FORBIDDEN_WINLOGON_VALUES.iter().any(|item| item.eq_ignore_ascii_case(name)) {
        return Err(Win32Error::Forbidden(format!("the value {name:?} is never written")));
    }
    if SAFE_BOOT_ROOTS.iter().any(|root| under(path, root)) {
        let allowed = SAFE_BOOT_ROOTS
            .iter()
            .any(|root| under(path, root) && path.len() > root.len() && path[root.len() + 1..].eq_ignore_ascii_case(SAFE_BOOT_SERVICE_KEY));
        return if allowed { Ok(()) } else { Err(forbidden(path)) };
    }
    if ALLOWED_ROOTS.iter().filter(|root| is_subtree_root(root)).any(|root| under(path, root)) {
        return Ok(());
    }
    Err(forbidden(path))
}

/// Reads `HKLM\<path>\<name>` (64-bit view). `Ok(None)` when absent. Read-only, any key.
pub fn get_machine_value(path: &str, name: &str) -> Result<Option<RegValue>> {
    get_hklm(path, name)
}

/// The names of the values directly under `HKLM\<path>`; empty when the key is absent.
/// Read-only, any key.
pub fn list_value_names(path: &str) -> Result<Vec<String>> {
    list_hklm_value_names(path)
}

/// Writes (`Some`) or deletes (`None`) one machine value below [`ALLOWED_ROOTS`].
///
/// DESTRUCTIVE: guarded.
pub fn set_machine_value(path: &str, name: &str, value: Option<&RegValue>) -> Result<()> {
    check_write(path, name, value)?;
    require_armed_machine()?;
    set_hklm(path.trim_matches('\\'), name, value)
}

/// The key of the agent's Safe Mode registration for `mode` (`Minimal` or `Network`):
/// `SYSTEM\CurrentControlSet\Control\SafeBoot\<mode>\RuleboxAgent`. No API call, no guard.
pub fn check_safe_boot_mode(mode: &str) -> Result<String> {
    SAFE_BOOT_ROOTS
        .iter()
        .find(|root| root.rsplit('\\').next().is_some_and(|last| last.eq_ignore_ascii_case(mode)))
        .map(|root| format!("{root}\\{SAFE_BOOT_SERVICE_KEY}"))
        .ok_or_else(|| forbidden(&format!("SafeBoot\\{mode}")))
}

/// Deletes the agent's own Safe Mode key (`SafeBoot\<mode>\RuleboxAgent`) and nothing else.
/// A Safe Mode key without a value would still register the service, so the restore of
/// the registration removes the key, not just its value.
///
/// DESTRUCTIVE: guarded.
pub fn delete_safe_boot_entry(mode: &str) -> Result<()> {
    let path = check_safe_boot_mode(mode)?;
    require_armed_machine()?;
    delete_hklm_key(&path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_root_accepts_a_value_below_it() {
        let value = RegValue::Dword(1);
        for root in ALLOWED_ROOTS.iter().filter(|root| is_subtree_root(root)) {
            assert!(check_write(root, "X", Some(&value)).is_ok(), "{root}");
            assert!(check_write(&format!("{root}\\Sub"), "X", Some(&value)).is_ok(), "{root}");
            assert!(check_write(&root.to_ascii_uppercase(), "X", None).is_ok(), "{root}");
        }
        for root in SAFE_BOOT_ROOTS {
            assert!(check_write(&format!("{root}\\RuleboxAgent"), "", Some(&RegValue::String("Service".into()))).is_ok());
        }
        assert!(check_write(WINLOGON_KEY, "AutoAdminLogon", Some(&RegValue::String("1".into()))).is_ok());
    }

    #[test]
    fn keys_outside_the_roots_are_forbidden() {
        let value = RegValue::Dword(1);
        for path in [
            r"SOFTWARE\Microsoft\Windows\CurrentVersion\Run",
            r"SOFTWARE\Microsoft\Windows\CurrentVersion\Policies",
            r"SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\SystemX",
            r"SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\Explorer",
            r"SYSTEM\CurrentControlSet\Services\RuleboxAgent",
            r"SYSTEM\CurrentControlSet\Control\SafeBoot",
            r"SYSTEM\CurrentControlSet\Control\SafeBoot\Minimal\OtherService",
            r"SYSTEM\CurrentControlSet\Control\SafeBoot\Minimal\RuleboxAgent\Sub",
            r"SYSTEM\CurrentControlSet\Control\SafeBoot\Minimal",
            r"SOFTWARE\Policies\Microsoft\Windows\DeviceInstall",
            r"SOFTWARE\Policies\Microsoft\Windows\DeviceInstall\Settings",
            r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon\Notify",
            r"SOFTWARE\Rulebox\TestMachine",
            r"SOFTWARE\Policies\Microsoft\Windows\OOBE\..\..\..\Run",
            "",
            r"\\",
        ] {
            assert!(matches!(check_write(path, "X", Some(&value)), Err(Win32Error::Forbidden(_))), "{path}");
            assert!(matches!(set_machine_value(path, "X", Some(&value)), Err(Win32Error::Forbidden(_))), "{path}");
        }
    }

    #[test]
    fn only_the_pending_enrollment_key_of_the_install_marker_is_writable() {
        // (Phase 6 Step 8) The agent deletes `Install\Pending\Code`; the marker itself is not here.
        let code = crate::installmarker::PENDING_KEY;
        assert!(check_write(code, "Code", None).is_ok());
        for path in [
            r"SOFTWARE\Rulebox\Install",
            r"SOFTWARE\Rulebox",
            r"SOFTWARE\Rulebox\InstallX",
            r"SOFTWARE\Rulebox\Install\PendingX",
            r"SOFTWARE\Rulebox\Install\Pending\..\..",
        ] {
            assert!(matches!(check_write(path, "InstallDir", None), Err(Win32Error::Forbidden(_))), "{path}");
        }
    }

    #[test]
    fn winlogon_values_that_open_the_way_back_stay_refused_everywhere() {
        for name in FORBIDDEN_WINLOGON_VALUES {
            for path in [WINLOGON_KEY, ALLOWED_ROOTS[1], DEVICE_INSTALL_RESTRICTIONS] {
                assert!(check_write(path, name, Some(&RegValue::String("x".into()))).is_err(), "{path}\\{name}");
                assert!(check_write(path, &name.to_ascii_lowercase(), None).is_err(), "{path}\\{name}");
            }
        }
        // The Phase 2 name rules still apply under Winlogon.
        assert!(check_write(WINLOGON_KEY, "LegalNoticeText", None).is_err());
        assert!(check_write(WINLOGON_KEY, "AutoLogonCount", Some(&RegValue::Dword(1))).is_err());
    }

    #[test]
    fn a_write_inside_the_roots_reaches_the_guard_on_the_dev_machine() {
        if crate::guard::is_armed_machine() {
            return;
        }
        let result = set_machine_value(ALLOWED_ROOTS[1], "HideFastUserSwitching", Some(&RegValue::Dword(1)));
        assert!(matches!(result, Err(Win32Error::Guard(_))), "{result:?}");
        let result = set_machine_value(DEVICE_INSTALL_RESTRICTIONS, "DenyDeviceClasses", None);
        assert!(matches!(result, Err(Win32Error::Guard(_))), "{result:?}");
    }

    #[test]
    fn the_safe_mode_key_is_only_ever_the_agents_own() {
        assert_eq!(
            check_safe_boot_mode("Minimal").unwrap(),
            r"SYSTEM\CurrentControlSet\Control\SafeBoot\Minimal\RuleboxAgent"
        );
        assert_eq!(
            check_safe_boot_mode("network").unwrap(),
            r"SYSTEM\CurrentControlSet\Control\SafeBoot\Network\RuleboxAgent"
        );
        for mode in ["", "Option", "Minimal\\Other", "..", "Minimal\\..\\Network", "AlternateShell"] {
            assert!(matches!(check_safe_boot_mode(mode), Err(Win32Error::Forbidden(_))), "{mode}");
            assert!(matches!(delete_safe_boot_entry(mode), Err(Win32Error::Forbidden(_))), "{mode}");
        }
        // The key the delete names is one `set_machine_value` may write.
        for mode in ["Minimal", "Network"] {
            let path = check_safe_boot_mode(mode).unwrap();
            assert!(check_write(&path, "", Some(&RegValue::String("Service".into()))).is_ok());
        }
    }

    #[test]
    fn deleting_the_safe_mode_key_meets_the_guard_on_the_dev_machine() {
        if crate::guard::is_armed_machine() {
            return;
        }
        assert!(matches!(delete_safe_boot_entry("Minimal"), Err(Win32Error::Guard(_))));
    }

    #[test]
    fn reads_are_not_limited_to_the_roots() {
        let key = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion";
        assert!(get_machine_value(key, "CurrentBuildNumber").unwrap().is_some());
        assert!(list_value_names(key).unwrap().iter().any(|name| name == "CurrentBuildNumber"));
        assert!(list_value_names(r"SOFTWARE\NoSuchKeyRulebox\X").unwrap().is_empty());
    }
}
