//! The compatibility report (plan Section 5.5). Built from the read-only
//! `Platform` methods; sent to the backend at enrollment and with the heartbeat
//! status, and printed by `rulebox-agent compat` (Step 10).
//!
//! The agent does **not** decide "OS out of support" (PRD 13.6 #4): it reports
//! `build`, `ubr` and `editionId`, and the backend applies lifecycle dates.

use serde::Serialize;

use crate::platform::{OsInfo, Platform, PlatformError};

/// Windows 10 22H2. Anything older is blocked.
pub const MIN_BUILD: u32 = 19045;
/// Free space on the system drive below this is a warning.
pub const LOW_DISK_GB: u64 = 2;
/// RAM at or below this selects Lite mode (PRD 22.5); information only.
pub const LITE_MAX_RAM_MB: u64 = 4352;

/// Things that stop enrollment (and the kiosk being enabled).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Blocker {
    OsTooOld,
    SMode,
    ManagedDevice,
    NoOtherAdmin,
    LegalNotice,
    ShellBinaryMissing,
}

impl Blocker {
    /// The code shown to the administrator and sent to the backend.
    pub fn code(self) -> &'static str {
        match self {
            Blocker::OsTooOld => "os_too_old",
            Blocker::SMode => "s_mode",
            Blocker::ManagedDevice => "managed_device",
            Blocker::NoOtherAdmin => "no_other_admin",
            Blocker::LegalNotice => "legal_notice",
            Blocker::ShellBinaryMissing => "shell_binary_missing",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Warning {
    LowDisk,
    Arm64Untested,
}

/// `OsInfo` as it appears in the report (the platform type is not serializable).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompatOs {
    pub build: u32,
    pub ubr: u32,
    pub display_version: String,
    pub edition_id: String,
    pub product_type: u32,
    pub arch: String,
    pub s_mode: bool,
    pub domain_joined: bool,
    pub entra_joined: bool,
    pub ram_mb: u64,
    pub system_disk_free_gb: u64,
}

impl From<&OsInfo> for CompatOs {
    fn from(os: &OsInfo) -> Self {
        Self {
            build: os.build,
            ubr: os.ubr,
            display_version: os.display_version.clone(),
            edition_id: os.edition_id.clone(),
            product_type: os.product_type,
            arch: os.arch.clone(),
            s_mode: os.s_mode,
            domain_joined: os.domain_joined,
            entra_joined: os.entra_joined,
            ram_mb: os.ram_mb,
            system_disk_free_gb: os.system_disk_free_gb,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompatReport {
    pub os: CompatOs,
    pub blockers: Vec<Blocker>,
    pub warnings: Vec<Warning>,
    /// Information only: the PC is at or below 4,352 MB of RAM, so the Staff App
    /// uses its Lite display mode.
    pub lite_mode: bool,
}

impl CompatReport {
    pub fn blocker_codes(&self) -> Vec<&'static str> {
        self.blockers.iter().map(|blocker| blocker.code()).collect()
    }

    /// The report as the backend stores it (`compat: v.any()`).
    pub fn to_json(&self) -> serde_json::Value {
        // A plain struct of strings, numbers and bools always serializes.
        serde_json::to_value(self).unwrap_or(serde_json::Value::Null)
    }
}

/// Builds the report. `staff_sid` is excluded when looking for "another" local
/// administrator. `allow_joined` is `--allow-joined`. Any read that fails fails the
/// report: a blocker that could not be checked must not pass silently.
pub fn build(
    platform: &dyn Platform,
    staff_sid: Option<&str>,
    allow_joined: bool,
) -> Result<CompatReport, PlatformError> {
    let os = platform.os_info()?;
    let mut blockers = Vec::new();
    let mut warnings = Vec::new();

    if os.build < MIN_BUILD {
        blockers.push(Blocker::OsTooOld);
    }
    if os.s_mode {
        blockers.push(Blocker::SMode);
    }
    if (os.domain_joined || os.entra_joined) && !allow_joined {
        blockers.push(Blocker::ManagedDevice);
    }
    if platform.other_enabled_local_admins(staff_sid)?.is_empty() {
        blockers.push(Blocker::NoOtherAdmin);
    }
    if platform.legal_notice_present()? {
        blockers.push(Blocker::LegalNotice);
    }
    let binaries = platform.shell_binaries_ok()?;
    if !(binaries.launcher_ok && binaries.staff_app_ok) {
        blockers.push(Blocker::ShellBinaryMissing);
    }

    if os.system_disk_free_gb < LOW_DISK_GB {
        warnings.push(Warning::LowDisk);
    }
    if matches!(os.arch.to_ascii_lowercase().as_str(), "arm64" | "aarch64") {
        warnings.push(Warning::Arm64Untested);
    }

    Ok(CompatReport {
        lite_mode: os.ram_mb <= LITE_MAX_RAM_MB,
        os: CompatOs::from(&os),
        blockers,
        warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::sim::{SimOp, SimPlatform};
    use crate::platform::ShellBinaries;
    use crate::testutil::TempDir;

    fn sim() -> (TempDir, SimPlatform) {
        let dir = TempDir::new();
        let sim = SimPlatform::new(dir.path().to_path_buf());
        (dir, sim)
    }

    #[test]
    fn the_default_machine_has_no_blockers_and_no_warnings() {
        let (_dir, sim) = sim();
        let report = build(&sim, None, false).unwrap();
        assert!(report.blockers.is_empty() && report.warnings.is_empty(), "{report:?}");
        assert!(!report.lite_mode);
        assert_eq!(report.os.build, 26100);
        assert_eq!(report.os.edition_id, "Professional");
    }

    #[test]
    fn each_blocker() {
        type Change = Box<dyn Fn(&SimPlatform)>;
        let cases: Vec<(&str, Change, Blocker)> = vec![
            ("os_too_old", Box::new(|s| s.with_world(|w| w.os.build = 19044)), Blocker::OsTooOld),
            ("s_mode", Box::new(|s| s.with_world(|w| w.os.s_mode = true)), Blocker::SMode),
            ("domain", Box::new(|s| s.with_world(|w| w.os.domain_joined = true)), Blocker::ManagedDevice),
            ("entra", Box::new(|s| s.with_world(|w| w.os.entra_joined = true)), Blocker::ManagedDevice),
            ("no admin", Box::new(|s| s.with_world(|w| w.admins.clear())), Blocker::NoOtherAdmin),
            ("legal notice", Box::new(|s| s.with_world(|w| w.legal_notice = true)), Blocker::LegalNotice),
            (
                "launcher",
                Box::new(|s| {
                    s.with_world(|w| w.shell_binaries = ShellBinaries { launcher_ok: false, staff_app_ok: true });
                }),
                Blocker::ShellBinaryMissing,
            ),
            (
                "staff app",
                Box::new(|s| {
                    s.with_world(|w| w.shell_binaries = ShellBinaries { launcher_ok: true, staff_app_ok: false });
                }),
                Blocker::ShellBinaryMissing,
            ),
        ];
        for (name, change, expected) in cases {
            let (_dir, sim) = sim();
            change(&sim);
            let report = build(&sim, None, false).unwrap();
            assert_eq!(report.blockers, [expected], "{name}");
        }
    }

    #[test]
    fn build_19045_is_the_lowest_supported() {
        let (_dir, sim) = sim();
        sim.with_world(|w| w.os.build = 19045);
        assert!(build(&sim, None, false).unwrap().blockers.is_empty());
    }

    #[test]
    fn allow_joined_lifts_only_the_managed_device_blocker() {
        let (_dir, sim) = sim();
        sim.with_world(|w| {
            w.os.domain_joined = true;
            w.os.s_mode = true;
        });
        let report = build(&sim, None, true).unwrap();
        assert_eq!(report.blockers, [Blocker::SMode]);
    }

    #[test]
    fn the_staff_account_does_not_count_as_another_admin() {
        let (_dir, sim) = sim();
        sim.with_world(|w| w.admins = vec!["S-1-5-21-1-1-1-2000".to_string()]);
        // The only enabled administrator is the Staff account itself.
        let report = build(&sim, Some("S-1-5-21-1-1-1-2000"), false).unwrap();
        assert_eq!(report.blockers, [Blocker::NoOtherAdmin]);
        assert!(build(&sim, None, false).unwrap().blockers.is_empty());
    }

    #[test]
    fn warnings_and_lite_mode() {
        let (_dir, sim) = sim();
        sim.with_world(|w| {
            w.os.system_disk_free_gb = 1;
            w.os.arch = "arm64".into();
            w.os.ram_mb = 4352;
        });
        let report = build(&sim, None, false).unwrap();
        assert!(report.blockers.is_empty());
        assert_eq!(report.warnings, [Warning::LowDisk, Warning::Arm64Untested]);
        assert!(report.lite_mode);
        sim.with_world(|w| w.os.ram_mb = 4353);
        assert!(!build(&sim, None, false).unwrap().lite_mode);
    }

    #[test]
    fn a_failed_read_fails_the_report() {
        let (_dir, sim) = sim();
        sim.fail_next(SimOp::LegalNoticePresent, PlatformError::AccessDenied);
        assert!(build(&sim, None, false).is_err());
    }

    #[test]
    fn the_json_form_has_codes_and_camel_case_keys() {
        let (_dir, sim) = sim();
        sim.with_world(|w| w.os.s_mode = true);
        let json = build(&sim, None, false).unwrap().to_json();
        assert_eq!(json["blockers"], serde_json::json!(["s_mode"]));
        assert_eq!(json["os"]["editionId"], "Professional");
        assert_eq!(json["os"]["systemDiskFreeGb"], 100);
        assert_eq!(json["liteMode"], false);
    }
}
