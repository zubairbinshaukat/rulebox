//! Values in the Staff account's own registry hive behind Phase 5's L1 layer (plan
//! 4.5, 4.7), and the Staff part of the USB rules (4.7a).
//!
//! Every function takes a path **relative to the user's hive** and checks it against
//! [`ALLOWED_ROOTS`] first (`Win32Error::Forbidden`, before the guard and before the hive
//! is touched). Nothing here can name `HKLM`: the writes go through `HiveKey`, which only
//! `registry::with_user_hive` produces, the same construction as `shellreg.rs`.
//!
//! The Staff shell value is **not** written here (`shellreg::set_user_shell` owns it, with
//! its own two locations), so the name `Shell` is refused under every root.

use std::path::Path;

use crate::error::{Result, Win32Error};
use crate::guard::require_armed_machine;
use crate::registry::{get_loaded_user_value, list_loaded_user_value_names, with_user_hive, RegValue};
use crate::sid::Sid;

/// Keys (relative to the user's hive) whose whole subtree may be written: plan 4.7.
pub const ALLOWED_ROOTS: &[&str] = &[
    r"Software\Microsoft\Windows\CurrentVersion\Policies\System",
    r"Software\Microsoft\Windows\CurrentVersion\Policies\Explorer",
    r"Software\Policies\Microsoft\Windows\System",
    r"Software\Policies\Microsoft\Windows\Explorer",
    r"Software\Policies\Microsoft\Windows\Control Panel\Desktop",
    // 4.7a: `usb.storage` and `usb.phones` (Deny_Read, Deny_Write, Deny_All, WPD GUID subkeys).
    r"Software\Policies\Microsoft\Windows\RemovableStorageDevices",
    r"Software\Policies\Microsoft\Office\16.0",
    r"Control Panel\Accessibility",
    // Default printer.
    r"Software\Microsoft\Windows NT\CurrentVersion\Windows",
    // Step 18 tuning.
    r"Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced",
    r"Software\Microsoft\Windows\CurrentVersion\BackgroundAccessApplications",
    // Read, and journalled removal of Staff entries (Step 18).
    r"Software\Microsoft\Windows\CurrentVersion\Run",
    // Step 18 tuning (PRD 22.2), added when the step was built: Copilot and tips have a user
    // policy only under these two keys; "best performance" is `VisualFXSetting`; the window
    // animation is `MinAnimate`.
    r"Software\Policies\Microsoft\Windows\WindowsCopilot",
    r"Software\Policies\Microsoft\Windows\CloudContent",
    r"Software\Microsoft\Windows\CurrentVersion\Explorer\VisualEffects",
    r"Control Panel\Desktop\WindowMetrics",
    // (Phase 6 Step 17, plan 4.9.3) The browser policies of Chrome and Edge for browser web apps. Lists are
    // subkeys (`URLBlocklist\1`, `\2`, ...), so the whole subtree is writable. PENDING S-1: whether the
    // browsers read user-hive policy on a workgroup PC is a VM spike (row S-1). If they do not, the two
    // roots move to `machinereg` (a plan change that also restricts the administrator's browser).
    r"Software\Policies\Google\Chrome",
    r"Software\Policies\Microsoft\Edge",
];

/// (Phase 6 Step 17) The two browser policy roots, so the agent can name them without an index.
pub const BROWSER_ROOTS: [&str; 2] = [r"Software\Policies\Google\Chrome", r"Software\Policies\Microsoft\Edge"];

fn forbidden(path: &str) -> Win32Error {
    Win32Error::Forbidden(format!("the Staff hive key {path:?} is not one Rulebox writes"))
}

fn under(path: &str, root: &str) -> bool {
    path.len() >= root.len()
        && path.is_char_boundary(root.len())
        && path[..root.len()].eq_ignore_ascii_case(root)
        && (path.len() == root.len() || path.as_bytes()[root.len()] == b'\\')
}

/// The key rule alone (reads use it too): inside a root, no empty, `.` or `..` segment.
pub fn check_path(path: &str) -> Result<()> {
    let path = path.trim_matches('\\');
    let plain = !path.is_empty() && path.split('\\').all(|segment| !matches!(segment, "" | "." | ".."));
    if plain && ALLOWED_ROOTS.iter().any(|root| under(path, root)) {
        Ok(())
    } else {
        Err(forbidden(path))
    }
}

/// The key and name rules of a write, with no API call and no guard.
pub fn check_write(path: &str, name: &str) -> Result<()> {
    check_path(path)?;
    if name.eq_ignore_ascii_case("Shell") {
        return Err(Win32Error::Forbidden("the Staff shell value is written by set_user_shell only".into()));
    }
    Ok(())
}

/// Reads `<hive of sid>\<path>\<name>`. `Ok(None)` when the key or value does not exist.
/// A signed-in user's hive is read as it is; a signed-out user's `NTUSER.DAT` has to be
/// mounted for a moment, which is a system change the guard covers, so on a machine
/// that is not a test machine that case returns `Guard`. Never changes a value.
pub fn read_value(sid: &Sid, profile: &Path, path: &str, name: &str) -> Result<Option<RegValue>> {
    check_path(path)?;
    let path = path.trim_matches('\\');
    if let Some(found) = get_loaded_user_value(sid, path, name)? {
        return Ok(found);
    }
    with_user_hive(sid, profile, |hive| hive.get(path, name))
}

/// (Phase 5 Step 18) The value names directly under `<hive of sid>\<path>` (the Staff
/// start-up entries); empty when the key does not exist. Same rules as [`read_value`]: a
/// signed-in user's hive is read as it is, a signed-out one has to be mounted, which the
/// guard covers. Never changes a value.
pub fn list_value_names(sid: &Sid, profile: &Path, path: &str) -> Result<Vec<String>> {
    check_path(path)?;
    let path = path.trim_matches('\\');
    if let Some(found) = list_loaded_user_value_names(sid, path)? {
        return Ok(found);
    }
    with_user_hive(sid, profile, |hive| hive.value_names(path))
}

/// (Phase 6 Step 17) The key rule of [`delete_key_if_empty`]: a browser policy root or a key
/// below one, never another root (the Windows policy keys may exist without Rulebox).
pub fn check_browser_key(path: &str) -> Result<()> {
    check_path(path)?;
    let path = path.trim_matches('\\');
    if BROWSER_ROOTS.iter().any(|root| under(path, root)) {
        Ok(())
    } else {
        Err(forbidden(path))
    }
}

/// (Phase 6 Step 17) Deletes the key `<hive of sid>\<path>` when it has no values and no
/// subkeys (the browser policy roots and their list subkeys, once Rulebox has taken its values
/// out). `Ok(false)`: the key still holds something (an administrator's own value, another
/// list), nothing was changed. A key that is not there is `Ok(true)`.
///
/// DESTRUCTIVE: guarded.
pub fn delete_key_if_empty(sid: &Sid, profile: &Path, path: &str) -> Result<bool> {
    check_browser_key(path)?;
    require_armed_machine()?;
    let path = path.trim_matches('\\');
    with_user_hive(sid, profile, |hive| hive.delete_key_if_empty(path))
}

/// Writes one value in the hive of `sid`.
///
/// DESTRUCTIVE: guarded.
pub fn write_value(sid: &Sid, profile: &Path, path: &str, name: &str, value: &RegValue) -> Result<()> {
    check_write(path, name)?;
    require_armed_machine()?;
    let path = path.trim_matches('\\');
    with_user_hive(sid, profile, |hive| hive.set(path, name, Some(value)))
}

/// Deletes one value in the hive of `sid` (a value that is not there is fine).
///
/// DESTRUCTIVE: guarded.
pub fn delete_value(sid: &Sid, profile: &Path, path: &str, name: &str) -> Result<()> {
    check_write(path, name)?;
    require_armed_machine()?;
    let path = path.trim_matches('\\');
    with_user_hive(sid, profile, |hive| hive.set(path, name, None))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_root_accepts_itself_and_a_subkey() {
        for root in ALLOWED_ROOTS {
            assert!(check_write(root, "X").is_ok(), "{root}");
            assert!(check_write(&format!("{root}\\Sub"), "X").is_ok(), "{root}");
            assert!(check_path(&root.to_ascii_uppercase()).is_ok(), "{root}");
        }
    }

    #[test]
    fn keys_outside_the_roots_are_forbidden() {
        for path in [
            r"Software\Microsoft\Windows\CurrentVersion",
            r"Software\Microsoft\Windows\CurrentVersion\RunOnce",
            r"Software\Microsoft\Windows\CurrentVersion\Policies",
            r"Software\Microsoft\Windows\CurrentVersion\Policies\SystemX",
            r"Software\Microsoft\Windows NT\CurrentVersion\Winlogon",
            r"Software\Microsoft\Windows NT\CurrentVersion",
            r"Software\Classes",
            r"Software\Policies\Microsoft\Windows\System\..\..\..\Classes",
            r"Control Panel\Desktop",
            r"HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System",
            "",
        ] {
            assert!(matches!(check_write(path, "X"), Err(Win32Error::Forbidden(_))), "{path}");
            assert!(matches!(check_path(path), Err(Win32Error::Forbidden(_))), "{path}");
        }
    }

    /// (Phase 6 Step 17) The two browser roots take policy values and list subkeys, and a
    /// look-alike sibling (`Chrome Beta`, `EdgeUpdate`) is outside them.
    #[test]
    fn the_browser_roots_cover_their_subtree_and_nothing_next_to_it() {
        for root in BROWSER_ROOTS {
            assert!(ALLOWED_ROOTS.contains(&root));
            assert!(check_write(root, "DeveloperToolsAvailability").is_ok());
            assert!(check_write(&format!(r"{root}\URLBlocklist"), "1").is_ok());
        }
        for path in [
            r"Software\Policies\Google",
            r"Software\Policies\Google\Chrome Beta",
            r"Software\Policies\Google\Chromium",
            r"Software\Policies\Microsoft\EdgeUpdate",
            r"Software\Policies\Microsoft\Edge\..\EdgeUpdate",
            r"Software\Policies\Microsoft",
            r"Software\Google\Chrome",
        ] {
            assert!(matches!(check_write(path, "X"), Err(Win32Error::Forbidden(_))), "{path}");
        }
    }

    #[test]
    fn the_shell_value_is_never_written_here() {
        for name in ["Shell", "shell", "SHELL"] {
            assert!(matches!(check_write(ALLOWED_ROOTS[0], name), Err(Win32Error::Forbidden(_))));
        }
    }

    /// An out-of-root write is refused before the guard and before any hive is opened,
    /// so the profile folder does not even have to exist.
    #[test]
    fn writes_outside_the_roots_touch_nothing() {
        let sid = crate::sid::current_user_sid().unwrap();
        let profile = Path::new(r"C:\rulebox-no-such-profile");
        let value = RegValue::Dword(1);
        assert!(matches!(
            write_value(&sid, profile, r"Software\Microsoft\Windows\CurrentVersion\Run2", "X", &value),
            Err(Win32Error::Forbidden(_))
        ));
        assert!(matches!(
            delete_value(&sid, profile, r"Software\Classes", "X"),
            Err(Win32Error::Forbidden(_))
        ));
        assert!(matches!(read_value(&sid, profile, r"Software\Classes", "X"), Err(Win32Error::Forbidden(_))));
        assert!(matches!(
            list_value_names(&sid, profile, r"Software\Microsoft\Windows\CurrentVersion\RunOnce"),
            Err(Win32Error::Forbidden(_))
        ));
    }

    #[test]
    fn writes_inside_the_roots_reach_the_guard_on_the_dev_machine() {
        if crate::guard::is_armed_machine() {
            return;
        }
        let sid = crate::sid::current_user_sid().unwrap();
        let profile = Path::new(r"C:\rulebox-no-such-profile");
        assert!(matches!(
            write_value(&sid, profile, ALLOWED_ROOTS[0], "DisableTaskMgr", &RegValue::Dword(1)),
            Err(Win32Error::Guard(_))
        ));
        assert!(matches!(delete_value(&sid, profile, ALLOWED_ROOTS[0], "DisableTaskMgr"), Err(Win32Error::Guard(_))));
        // (Phase 6 Step 17) A browser key reaches the guard too; no hive is opened on this machine.
        assert!(matches!(
            write_value(&sid, profile, r"Software\Policies\Microsoft\Edge\URLBlocklist", "1", &RegValue::String("*".into())),
            Err(Win32Error::Guard(_))
        ));
        assert!(matches!(delete_key_if_empty(&sid, profile, BROWSER_ROOTS[0]), Err(Win32Error::Guard(_))));
    }

    /// (Phase 6 Step 17) Only the browser roots' keys can be removed: not the other Staff roots,
    /// not a sibling of a browser root, and not before the guard.
    #[test]
    fn only_browser_keys_can_be_removed() {
        let sid = crate::sid::current_user_sid().unwrap();
        let profile = Path::new(r"C:\rulebox-no-such-profile");
        for path in [
            ALLOWED_ROOTS[0],
            r"Software\Policies\Microsoft\Windows\System",
            r"Software\Policies\Microsoft\EdgeUpdate",
            r"Software\Policies\Google",
            "",
        ] {
            assert!(matches!(check_browser_key(path), Err(Win32Error::Forbidden(_))), "{path}");
            assert!(matches!(delete_key_if_empty(&sid, profile, path), Err(Win32Error::Forbidden(_))), "{path}");
        }
        for root in BROWSER_ROOTS {
            assert!(check_browser_key(root).is_ok());
            assert!(check_browser_key(&format!(r"{root}\URLAllowlist")).is_ok());
        }
    }

    #[test]
    fn this_module_never_names_the_machine_hive() {
        let source = include_str!("staffreg.rs");
        let forbidden = concat!("HKEY_LOCAL", "_MACHINE");
        // The test data above names the string once; the code must not.
        let code = source.split("#[cfg(test)]").next().unwrap_or("");
        assert!(!code.contains(forbidden));
        assert!(!code.contains(concat!("get_", "hklm")) && !code.contains(concat!("set_", "hklm")));
    }
}
