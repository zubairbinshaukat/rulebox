//! (Phase 6 Step 15, plan 4.8 "Warnings") The read-only probes of a driver install. They look; they never change anything
//! and never block on their own failure (a probe that cannot read counts as "nothing found" and is logged):
//!
//! - **`protected_print_on`:** Windows protected print mode is on **and** the package is a printer driver. Windows would
//!   remove the printers that use a third-party driver, so the install is refused (a failure that is retried; it clears once
//!   the mode is off). Only an INF package can be told to be a printer driver (its `[Version]` `Class=Printer` /
//!   `PrintQueue` or the matching `ClassGuid=`); a vendor exe or msi is opaque and is never refused for this reason.
//!   The registry value read is `Platform::protected_print_on` (**unverified**, spike Step 2).
//! - **`seagull_driver_present`:** the package is Seagull-based and another Seagull-based printer driver is already on the
//!   PC. Toshiba TEC's manuals say not to mix them and to remove the old TPCL driver before an upgrade. A warning only: it
//!   rides on the `installed` result. "Seagull-based" is a name heuristic (**unverified**, Step 23 and S-10): the word
//!   `seagull` or `tpcl` in the INF text, in the driver's name in the document, or in an installed printer driver's name.

use super::Detail;
use crate::platform::Platform;

/// The printer class GUID and the print queue class GUID (INF `ClassGuid=`), lower case.
const PRINTER_CLASS_GUIDS: [&str; 2] = ["{4d36e979-e325-11ce-bfc1-08002be10318}", "{1ed2bbf9-11f0-4084-b21f-ad83a8e6dcdc}"];

/// What an INF says about the package.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InfFacts {
    /// The `[Version]` section names the printer (or print queue) setup class.
    pub printer_class: bool,
    /// The INF text carries a Seagull marker.
    pub seagull_based: bool,
}

/// Reads the facts of an INF's decoded text ([`super::drivers_rules::decode_inf`]).
pub fn inf_facts(inf: &str) -> InfFacts {
    InfFacts { printer_class: is_printer_class(inf), seagull_based: has_seagull_marker(inf) }
}

/// The words that mark a Seagull-based driver, case-insensitively (`TPCL` is Toshiba TEC's name of the language its
/// Seagull driver speaks).
pub fn has_seagull_marker(text: &str) -> bool {
    let lower = text.to_lowercase();
    lower.contains("seagull") || lower.contains("tpcl")
}

/// Whether the `[Version]` section of an INF says `Class=Printer` / `Class=PrintQueue` or names one of the two class GUIDs.
pub fn is_printer_class(inf: &str) -> bool {
    let mut in_version = false;
    for line in inf.lines() {
        let line = line.trim();
        if let Some(section) = line.strip_prefix('[').and_then(|rest| rest.split(']').next()) {
            in_version = section.trim().eq_ignore_ascii_case("version");
            continue;
        }
        if !in_version || line.starts_with(';') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else { continue };
        let value = value.split(';').next().unwrap_or("").trim().trim_matches('"').trim().to_ascii_lowercase();
        match key.trim().to_ascii_lowercase().as_str() {
            "class" if value == "printer" || value == "printqueue" => return true,
            "classguid" if PRINTER_CLASS_GUIDS.contains(&value.as_str()) => return true,
            _ => {}
        }
    }
    false
}

/// Whether one of these printer driver names (as the print spooler lists them) is a Seagull-based driver.
pub fn seagull_driver_in(names: &[String]) -> bool {
    names.iter().any(|name| has_seagull_marker(name))
}

/// Protected print mode refuses a printer driver. `false` (do not refuse) when the package is not known to be a printer
/// driver, or when the probe cannot read.
pub fn protected_print_refuses(platform: &dyn Platform, printer_class: bool) -> bool {
    if !printer_class {
        return false;
    }
    match platform.protected_print_on() {
        Ok(on) => on,
        Err(error) => {
            tracing::warn!("cannot read the protected print setting ({error}); the driver is installed");
            false
        }
    }
}

/// The warning that rides on the `installed` result: this driver is Seagull-based (`seagull_based`: its INF or its name in
/// the document says so) and another Seagull-based printer driver is already installed. Read **before** the install, so the
/// package itself is never the "other" one (a new version of the same driver does count: Toshiba TEC says to remove the old
/// one before an upgrade).
pub fn seagull_warning(platform: &dyn Platform, seagull_based: bool) -> Option<Detail> {
    if !seagull_based {
        return None;
    }
    match platform.printer_drivers() {
        Ok(names) => seagull_driver_in(&names).then_some(Detail::SeagullDriverPresent),
        Err(error) => {
            tracing::warn!("cannot list the printer drivers ({error}); no Seagull warning");
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::sim::SimPlatform;
    use crate::testutil::TempDir;

    #[test]
    fn the_printer_class_is_read_from_the_version_section_only() {
        assert!(is_printer_class("[Version]\r\nSignature=\"$Windows NT$\"\r\nClass=Printer\r\n"));
        assert!(is_printer_class("[Version]\nCLASS = \"PrintQueue\" ; the queue\n"));
        assert!(is_printer_class("[version]\nClassGuid={4D36E979-E325-11CE-BFC1-08002BE10318}\n"));
        assert!(is_printer_class("[Version]\nClassGuid={1ED2BBF9-11F0-4084-B21F-AD83A8E6DCDC}\n"));
        assert!(!is_printer_class("[Version]\nClass=Net\nClassGuid={4d36e972-e325-11ce-bfc1-08002be10318}\n"));
        assert!(!is_printer_class("[Version]\n;Class=Printer\nClassName=Printer\n"));
        assert!(!is_printer_class("[Manufacturer]\nClass=Printer\n[Strings]\nClass=Printer"));
        assert!(!is_printer_class(""));
    }

    #[test]
    fn a_seagull_marker_is_found_in_any_case() {
        assert!(has_seagull_marker("Provider=%Seagull%\n"));
        assert!(has_seagull_marker("TOSHIBA TEC B-EX4T1 (TPCL)"));
        assert!(has_seagull_marker("Seagull Scientific Driver"));
        assert!(!has_seagull_marker("Brother HL-L2350DW series"));
        assert!(!has_seagull_marker(""));
        let facts = inf_facts("[Version]\nClass=Printer\n[Strings]\nMfg=\"Seagull Scientific\"\n");
        assert_eq!(facts, InfFacts { printer_class: true, seagull_based: true });
        assert_eq!(inf_facts("[Version]\nClass=Net\n"), InfFacts { printer_class: false, seagull_based: false });
        assert!(seagull_driver_in(&["Microsoft IPP Class Driver".into(), "Seagull Driver for TOSHIBA TEC B-EX4T2".into()]));
        assert!(!seagull_driver_in(&["Microsoft IPP Class Driver".into(), "Brother Universal".into()]));
        assert!(!seagull_driver_in(&[]));
    }

    #[test]
    fn protected_print_refuses_only_a_printer_driver_and_only_while_it_is_on() {
        let dir = TempDir::new();
        let sim = SimPlatform::new(dir.path().to_path_buf());
        assert!(!protected_print_refuses(&sim, true), "off");
        sim.with_world(|w| w.protected_print = true);
        assert!(protected_print_refuses(&sim, true));
        assert!(!protected_print_refuses(&sim, false), "not a printer driver: never refused for this reason");
    }

    #[test]
    fn the_seagull_warning_needs_both_a_seagull_driver_and_another_one_on_the_pc() {
        let dir = TempDir::new();
        let sim = SimPlatform::new(dir.path().to_path_buf());
        assert_eq!(seagull_warning(&sim, true), None, "nothing Seagull on the PC yet");
        sim.with_world(|w| w.printer_drivers.push("TOSHIBA TEC B-EX4T1 (TPCL)".into()));
        assert_eq!(seagull_warning(&sim, true), Some(Detail::SeagullDriverPresent));
        assert_eq!(seagull_warning(&sim, false), None, "a driver that is not Seagull-based does not warn");
    }
}
