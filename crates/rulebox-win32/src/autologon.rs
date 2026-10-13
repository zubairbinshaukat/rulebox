//! The machine values behind automatic sign-in, and the rules for writing them.
//!
//! The agent treats automatic sign-in as plain registry values plus LSA secrets
//! (plan Step 10); this module holds the names and the one function every write
//! to `Winlogon` goes through. It refuses, by name and before any API call or
//! guard check, the values that would take away the administrator's way back
//! (plan top rule 2): `Shell`, `Userinit`, `IgnoreShiftOverride`,
//! `ForceAutoLogon`, and a value for `AutoLogonCount` (it may only be deleted).

use crate::error::{Result, Win32Error};
use crate::registry::{set_hklm, RegValue};

pub const WINLOGON_KEY: &str = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon";
/// The secret that holds the Staff password for automatic sign-in.
pub const LSA_DEFAULT_PASSWORD: &str = "DefaultPassword";
/// The Staff password between "generated" and "stored as `DefaultPassword`".
pub const LSA_PENDING_PASSWORD: &str = "L$RuleboxStaffPending";

/// Values under `Winlogon` that are never written, set or deleted by Rulebox.
pub const FORBIDDEN_WINLOGON_VALUES: &[&str] = &["Shell", "Userinit", "IgnoreShiftOverride", "ForceAutoLogon"];

/// The only values Rulebox may write under `Winlogon`.
const ALLOWED_WINLOGON_VALUES: &[&str] =
    &["AutoAdminLogon", "DefaultUserName", "DefaultDomainName", "DefaultPassword", "AutoLogonCount"];

/// The other machine keys Rulebox writes (plan Section 5.6, step 5), each with the
/// value names it may touch.
const POLICIES_SYSTEM_KEY: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System";
const OOBE_POLICY_KEY: &str = r"SOFTWARE\Policies\Microsoft\Windows\OOBE";

const POLICIES_SYSTEM_VALUES: &[&str] = &["DisableAutomaticRestartSignOn", "EnableFirstLogonAnimation"];
const OOBE_VALUES: &[&str] = &["DisablePrivacyExperience"];

fn contains_ignore_case(list: &[&str], name: &str) -> bool {
    list.iter().any(|item| item.eq_ignore_ascii_case(name))
}

/// Writes (`Some`) or deletes (`None`) one value under `Winlogon`.
///
/// Fails on the name check first: a forbidden or unknown name never reaches the
/// registry, and never reaches the test-machine guard either.
///
/// DESTRUCTIVE: guarded.
pub fn set_winlogon_value(name: &str, value: Option<&RegValue>) -> Result<()> {
    if contains_ignore_case(FORBIDDEN_WINLOGON_VALUES, name) {
        return Err(Win32Error::Invalid(format!("the Winlogon value {name:?} is never written")));
    }
    if !contains_ignore_case(ALLOWED_WINLOGON_VALUES, name) {
        return Err(Win32Error::Invalid(format!("the Winlogon value {name:?} is not one Rulebox manages")));
    }
    if name.eq_ignore_ascii_case("AutoLogonCount") && value.is_some() {
        return Err(Win32Error::Invalid("AutoLogonCount is only ever deleted".into()));
    }
    set_hklm(WINLOGON_KEY, name, value)
}

/// Writes (`Some`) or deletes (`None`) one machine value from the short list
/// Rulebox owns. Any other key or value name is refused before the guard and
/// before any API call. Writes under `Winlogon` go through [`set_winlogon_value`].
///
/// DESTRUCTIVE: guarded.
pub fn set_machine_value(path: &str, name: &str, value: Option<&RegValue>) -> Result<()> {
    let path = path.trim_matches('\\');
    if path.eq_ignore_ascii_case(WINLOGON_KEY) {
        return set_winlogon_value(name, value);
    }
    let allowed = if path.eq_ignore_ascii_case(POLICIES_SYSTEM_KEY) {
        POLICIES_SYSTEM_VALUES
    } else if path.eq_ignore_ascii_case(OOBE_POLICY_KEY) {
        OOBE_VALUES
    } else {
        return Err(Win32Error::Invalid(format!("the machine key {path:?} is not one Rulebox writes")));
    };
    if !contains_ignore_case(allowed, name) {
        return Err(Win32Error::Invalid(format!("the value {name:?} under {path:?} is not one Rulebox writes")));
    }
    set_hklm(path, name, value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn forbidden_names_fail_before_the_guard_and_the_registry() {
        let value = RegValue::String("x".into());
        for name in ["Shell", "Userinit", "IgnoreShiftOverride", "ForceAutoLogon", "shell", "USERINIT"] {
            for payload in [Some(&value), None] {
                match set_winlogon_value(name, payload) {
                    Err(Win32Error::Invalid(_)) => {}
                    other => panic!("{name}: expected Invalid, got {other:?}"),
                }
            }
        }
    }

    #[test]
    fn unknown_names_are_refused_too() {
        assert!(matches!(
            set_winlogon_value("LegalNoticeText", None),
            Err(Win32Error::Invalid(_))
        ));
    }

    #[test]
    fn auto_logon_count_can_only_be_deleted() {
        assert!(matches!(
            set_winlogon_value("AutoLogonCount", Some(&RegValue::Dword(3))),
            Err(Win32Error::Invalid(_))
        ));
        // Deleting passes the name checks and then meets the guard (dev machine).
        if !crate::guard::is_test_machine() {
            assert!(matches!(set_winlogon_value("AutoLogonCount", None), Err(Win32Error::Guard(_))));
        }
    }

    #[test]
    fn machine_writes_outside_the_list_are_refused() {
        let value = RegValue::Dword(1);
        for (path, name) in [
            (r"SOFTWARE\Microsoft\Windows\CurrentVersion\Run", "Anything"),
            (r"SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System", "Shell"),
            (r"SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System", "LegalNoticeText"),
            (r"SOFTWARE\Policies\Microsoft\Windows\OOBE", "Other"),
            (r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon", "Userinit"),
            (r"SYSTEM\CurrentControlSet\Control\Lsa", "RestrictAnonymous"),
        ] {
            assert!(
                matches!(set_machine_value(path, name, Some(&value)), Err(Win32Error::Invalid(_))),
                "{path}\\{name}"
            );
        }
    }

    #[test]
    fn listed_machine_writes_reach_the_guard_on_the_dev_machine() {
        if crate::guard::is_test_machine() {
            return;
        }
        let value = RegValue::Dword(1);
        for (path, name) in [
            (POLICIES_SYSTEM_KEY, "DisableAutomaticRestartSignOn"),
            (POLICIES_SYSTEM_KEY, "EnableFirstLogonAnimation"),
            (OOBE_POLICY_KEY, "DisablePrivacyExperience"),
            (WINLOGON_KEY, "AutoAdminLogon"),
            (WINLOGON_KEY, "DefaultUserName"),
            (WINLOGON_KEY, "DefaultDomainName"),
            (WINLOGON_KEY, "DefaultPassword"),
        ] {
            assert!(
                matches!(set_machine_value(path, name, Some(&value)), Err(Win32Error::Guard(_))),
                "{path}\\{name}"
            );
        }
    }
}
