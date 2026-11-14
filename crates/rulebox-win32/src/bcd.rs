//! Boot configuration data (plan 4.5, 4.16, Step 5).
//!
//! Rulebox changes exactly one BCD element: `recoveryenabled` of the `{current}` boot
//! entry (automatic failover to the recovery environment, plan 4.16), and only when
//! BitLocker does not protect the OS volume (the agent checks that).
//!
//! **Mechanism (a choice, reported to the plan):** the plan names the WMI BCD provider;
//! this module runs `%SystemRoot%\System32\bcdedit.exe` with fixed arguments instead. The
//! provider needs a long chain of COM method calls with out parameters that cannot be
//! tried on the dev machine, while `bcdedit` is one fixed program that the service (SYSTEM)
//! can run. Nothing but the two fixed forms below is ever passed to it, no argument comes
//! from outside, and the element and value rules (`check_element`, `check_set`) run first.
//! Reading is locale-proof: a value that is not one of the known words is an error, and
//! the agent then leaves the element alone. Settled in the VM run (Step 21).

use std::path::PathBuf;
use std::process::Command;

use crate::error::{Result, Win32Error};
use crate::guard::require_test_machine;

/// The only object Rulebox touches.
pub const CURRENT_OBJECT: &str = "{current}";
/// The only element Rulebox touches, and the two values it writes.
pub const RECOVERY_ENABLED: &str = "recoveryenabled";

/// `CREATE_NO_WINDOW`.
const NO_WINDOW: u32 = 0x0800_0000;

fn forbidden(what: &str) -> Win32Error {
    Win32Error::Forbidden(format!("the boot configuration element {what} is not one Rulebox changes"))
}

/// The object and element rule shared by the read and the write (no API call, no guard).
pub fn check_element(object: &str, element: &str) -> Result<()> {
    if object.eq_ignore_ascii_case(CURRENT_OBJECT) && element.eq_ignore_ascii_case(RECOVERY_ENABLED) {
        Ok(())
    } else {
        Err(forbidden(&format!("{object}/{element}")))
    }
}

/// The rules of [`set`]: the element, and a value of `Yes` or `No`.
pub fn check_set(object: &str, element: &str, value: &str) -> Result<()> {
    check_element(object, element)?;
    if value.eq_ignore_ascii_case("Yes") || value.eq_ignore_ascii_case("No") {
        Ok(())
    } else {
        Err(Win32Error::Forbidden("recoveryenabled is Yes or No".into()))
    }
}

/// The value word of `element` in `bcdedit /enum` output as `Yes` / `No`. `Ok(None)`: the
/// element is not set in this entry (Windows then uses its default). A value that is not a
/// known boolean word is an error, never a guess.
fn parse_boolean_element(output: &str, element: &str) -> Result<Option<String>> {
    for line in output.lines() {
        let mut words = line.split_whitespace();
        let Some(name) = words.next() else {
            continue;
        };
        if !name.eq_ignore_ascii_case(element) {
            continue;
        }
        let value = words.collect::<Vec<_>>().join(" ").to_ascii_lowercase();
        return match value.as_str() {
            "yes" | "on" | "true" | "1" => Ok(Some("Yes".to_string())),
            "no" | "off" | "false" | "0" => Ok(Some("No".to_string())),
            _ => Err(Win32Error::Invalid("the boot configuration value is not a word this agent knows".into())),
        };
    }
    Ok(None)
}

fn bcdedit_exe() -> Result<PathBuf> {
    let root = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .ok_or_else(|| Win32Error::Invalid("the Windows folder is not known".into()))?;
    Ok(root.join("System32").join("bcdedit.exe"))
}

/// Runs bcdedit with fixed arguments and returns its text output.
fn run_bcdedit(args: &[&str]) -> Result<String> {
    use std::os::windows::process::CommandExt;
    let output = Command::new(bcdedit_exe()?)
        .args(args)
        .creation_flags(NO_WINDOW)
        .output()
        .map_err(|e| Win32Error::Api { api: "bcdedit", code: e.raw_os_error().map_or(0, |c| c as u32) })?;
    if !output.status.success() {
        return Err(Win32Error::Invalid(format!("bcdedit stopped with code {}", output.status.code().unwrap_or(-1))));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Reads one element. `Ok(None)` when it is not set. Read-only.
pub fn get(object: &str, element: &str) -> Result<Option<String>> {
    check_element(object, element)?;
    let output = run_bcdedit(&["/enum", CURRENT_OBJECT])?;
    parse_boolean_element(&output, RECOVERY_ENABLED)
}

/// Writes one element.
///
/// DESTRUCTIVE: guarded.
pub fn set(object: &str, element: &str, value: &str) -> Result<()> {
    check_set(object, element, value)?;
    require_test_machine()?;
    let word = if value.eq_ignore_ascii_case("Yes") { "Yes" } else { "No" };
    run_bcdedit(&["/set", CURRENT_OBJECT, RECOVERY_ENABLED, word]).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_recoveryenabled_of_current() {
        assert!(check_set("{current}", "recoveryenabled", "No").is_ok());
        assert!(check_set("{CURRENT}", "RecoveryEnabled", "yes").is_ok());
        for (object, element, value) in [
            ("{bootmgr}", "recoveryenabled", "No"),
            ("{current}", "bootstatuspolicy", "IgnoreAllFailures"),
            ("{current}", "recoveryenabled", "Maybe"),
            ("{default}", "path", "x"),
            ("", "", ""),
        ] {
            assert!(matches!(check_set(object, element, value), Err(Win32Error::Forbidden(_))), "{object}/{element}");
            assert!(matches!(set(object, element, value), Err(Win32Error::Forbidden(_))), "{object}/{element}");
        }
        assert!(matches!(get("{bootmgr}", "displayorder"), Err(Win32Error::Forbidden(_))));
    }

    #[test]
    fn the_writer_meets_the_guard_before_anything_else() {
        if crate::guard::is_test_machine() {
            return;
        }
        assert!(matches!(set("{current}", "recoveryenabled", "No"), Err(Win32Error::Guard(_))));
    }

    const SAMPLE: &str = "Windows Boot Loader\r\n-------------------\r\nidentifier              {current}\r\n\
device                  partition=C:\r\nbootstatuspolicy        IgnoreAllFailures\r\nrecoveryenabled         No\r\n\
allowedinmemorysettings 0x15000075\r\n";

    #[test]
    fn the_element_is_found_in_the_listing() {
        assert_eq!(parse_boolean_element(SAMPLE, "recoveryenabled").unwrap(), Some("No".to_string()));
        assert_eq!(parse_boolean_element(&SAMPLE.replace("No", "Yes"), "recoveryenabled").unwrap(), Some("Yes".to_string()));
        assert_eq!(parse_boolean_element(&SAMPLE.replace("recoveryenabled         No", ""), "recoveryenabled").unwrap(), None);
        assert_eq!(parse_boolean_element("RecoveryEnabled  On", "recoveryenabled").unwrap(), Some("Yes".to_string()));
        // A word from another language is an error (the agent then leaves the element alone).
        assert!(parse_boolean_element("recoveryenabled         Nein", "recoveryenabled").is_err());
        // Another element that merely starts with the same letters is not it.
        assert_eq!(parse_boolean_element("recoveryenabledx No", "recoveryenabled").unwrap(), None);
    }
}
