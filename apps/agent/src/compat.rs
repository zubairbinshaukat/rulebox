//! The compatibility report (plan Section 5.5). Built from the read-only
//! `Platform` methods; sent to the backend at enrollment and with the heartbeat
//! status, and printed by `rulebox-agent compat` (Step 10).
//!
//! The agent does **not** decide "OS out of support" (PRD 13.6 #4): it reports
//! `build`, `ubr` and `editionId`, and the backend applies lifecycle dates.

use std::path::Path;

use rulebox_ipc::types::LITE_MAX_RAM_MB;
use serde::Serialize;

use crate::lockdown::appcontrol::MIN_BUILD_MULTIPLE_POLICY;
use crate::lockdown::applocker::mechanism_for;
use crate::platform::{OsInfo, Platform, PlatformError};

/// Windows 10 22H2. Anything older is blocked.
pub const MIN_BUILD: u32 = 19045;
/// Free space on the system drive below this is a warning.
pub const LOW_DISK_GB: u64 = 2;
/// (Phase 6, plan 4.12) Below this much RAM the PC is under the target hardware: a warning.
pub const LOW_RAM_MB: u64 = 3072;
/// (Phase 6, plan 4.12) The oldest WebView2 Runtime the Staff App runs on.
pub const MIN_WEBVIEW2_MAJOR: u32 = 125;

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
    /// WebView2 is absent or older than [`MIN_WEBVIEW2_MAJOR`] **after** Setup tried to install it.
    Webview2TooOld,
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
            Blocker::Webview2TooOld => "webview2_too_old",
        }
    }

    /// The reason in plain words (`rulebox-agent compat`).
    pub fn plain(self) -> &'static str {
        match self {
            Blocker::OsTooOld => "Windows is older than Windows 10 22H2.",
            Blocker::SMode => "Windows is in S mode, which only runs Store apps.",
            Blocker::ManagedDevice => "The PC is joined to a domain or Entra ID (another system manages it).",
            Blocker::NoOtherAdmin => "There is no other enabled administrator account to keep as the way back.",
            Blocker::LegalNotice => "A sign-in legal notice is set; it would block the kiosk sign-in.",
            Blocker::ShellBinaryMissing => "The Rulebox shell files are missing.",
            Blocker::Webview2TooOld => "The WebView2 Runtime is missing or too old, and Setup could not fix it.",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Warning {
    LowDisk,
    Arm64Untested,
    /// No WebView2 Runtime yet; Setup installs it.
    Webview2Missing,
    /// A WebView2 Runtime older than [`MIN_WEBVIEW2_MAJOR`] before Setup tried to update it.
    Webview2TooOld,
    /// Windows protected print mode is on: printers with third-party drivers would be removed.
    ProtectedPrintOn,
    /// Less RAM than [`LOW_RAM_MB`].
    LowRam,
}

impl Warning {
    /// The code sent to the backend (the same text the JSON form uses).
    pub fn code(self) -> &'static str {
        match self {
            Warning::LowDisk => "low_disk",
            Warning::Arm64Untested => "arm64_untested",
            Warning::Webview2Missing => "webview2_missing",
            Warning::Webview2TooOld => "webview2_too_old",
            Warning::ProtectedPrintOn => "protected_print_on",
            Warning::LowRam => "low_ram",
        }
    }

    /// The reason in plain words (`rulebox-agent compat`).
    pub fn plain(self) -> &'static str {
        match self {
            Warning::LowDisk => "Less than 2 GB is free on the system drive.",
            Warning::Arm64Untested => "ARM64 Windows is not tested yet.",
            Warning::Webview2Missing => "The WebView2 Runtime is not installed; Setup installs it.",
            Warning::Webview2TooOld => "The WebView2 Runtime is older than version 125; Setup updates it.",
            Warning::ProtectedPrintOn => "Windows protected print mode is on; printers with third-party drivers would be removed.",
            Warning::LowRam => "The PC has less than 3 GB of memory, below the target hardware.",
        }
    }
}

/// How much of the lockdown a PC can have (Phase 5 Q12: a PC with less is still enrolled).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Protection {
    Full,
    Reduced,
}

/// Which program-start layers Windows allows on this PC (plan 4.12 `layers`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompatLayers {
    /// L3: AppLocker rules for the Staff account (an edition with a mechanism for them).
    pub app_locker: bool,
    /// L4: App Control for Business policies (a build with the multiple-policy format).
    pub app_control: bool,
}

/// The WebView2 Runtime the Staff App needs (plan 4.12).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompatWebView2 {
    pub present: bool,
    /// `None` when absent.
    pub version: Option<String>,
    /// `machine` or `none`. Per-user installs are not read: the Staff account is another user.
    pub source: &'static str,
}

/// Browsers found at their per-machine paths (information for the app form).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompatBrowsers {
    pub edge: bool,
    pub chrome: bool,
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
    /// (Phase 6, plan 4.12) The WebView2 Runtime.
    pub webview2: CompatWebView2,
    /// `reduced` when L3 or L4 is not available on this PC.
    pub protection: Protection,
    pub layers: CompatLayers,
    pub browsers: CompatBrowsers,
    /// Windows protected print mode is on (plan 4.8).
    pub protected_print: bool,
    /// Under [`LOW_RAM_MB`] of memory.
    pub low_ram: bool,
}

/// What the caller knows that the PC cannot tell (plan 4.12).
#[derive(Debug, Clone, Copy, Default)]
pub struct Options {
    /// Setup already tried to install or update the WebView2 Runtime (Step 8 sets it). Until
    /// then an absent or old runtime is a warning; after it, a blocker.
    pub webview2_install_attempted: bool,
}

impl CompatReport {
    pub fn blocker_codes(&self) -> Vec<&'static str> {
        self.blockers.iter().map(|blocker| blocker.code()).collect()
    }

    /// Why the protection is reduced, in plain words (empty when it is full).
    pub fn reduced_reasons(&self) -> Vec<&'static str> {
        let mut reasons = Vec::new();
        if !self.layers.app_locker {
            reasons.push("AppLocker rules (L3) are not available on this Windows edition.");
        }
        if !self.layers.app_control {
            reasons.push("App Control policies (L4) are not available on this Windows build.");
        }
        reasons
    }

    /// The report in plain words for `rulebox-agent compat`: the level and the reasons first.
    pub fn write_text(&self, out: &mut dyn std::io::Write) -> std::io::Result<()> {
        let os = &self.os;
        let yes = |value: bool| if value { "yes" } else { "no" };
        writeln!(out, "Windows build : {}.{} ({})", os.build, os.ubr, os.display_version)?;
        writeln!(out, "Edition       : {} (product type {})", os.edition_id, os.product_type)?;
        writeln!(out, "Architecture  : {}", os.arch)?;
        writeln!(out, "Memory        : {} MB{}", os.ram_mb, if self.lite_mode { " (Lite mode)" } else { "" })?;
        writeln!(out, "System disk   : {} GB free", os.system_disk_free_gb)?;
        writeln!(out, "Joined        : domain {}, Entra {}", yes(os.domain_joined), yes(os.entra_joined))?;
        writeln!(out, "S mode        : {}", yes(os.s_mode))?;
        match self.protection {
            Protection::Full => writeln!(out, "Protection    : full")?,
            Protection::Reduced => {
                writeln!(out, "Protection    : reduced")?;
                for reason in self.reduced_reasons() {
                    writeln!(out, "                - {reason}")?;
                }
            }
        }
        match &self.webview2.version {
            Some(version) => writeln!(out, "WebView2      : {version}")?,
            None => writeln!(out, "WebView2      : not installed")?,
        }
        let browsers: Vec<&str> =
            [(self.browsers.edge, "Edge"), (self.browsers.chrome, "Chrome")].into_iter().filter(|(on, _)| *on).map(|(_, n)| n).collect();
        writeln!(out, "Browsers      : {}", if browsers.is_empty() { "none found".to_string() } else { browsers.join(", ") })?;
        writeln!(out, "Protected print: {}", yes(self.protected_print))?;
        if self.blockers.is_empty() {
            writeln!(out, "Blockers      : none")?;
        }
        for blocker in &self.blockers {
            writeln!(out, "Blocker       : {} - {}", blocker.code(), blocker.plain())?;
        }
        if self.warnings.is_empty() {
            writeln!(out, "Warnings      : none")?;
        }
        for warning in &self.warnings {
            writeln!(out, "Warning       : {} - {}", warning.code(), warning.plain())?;
        }
        Ok(())
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
    build_with(platform, staff_sid, allow_joined, Options::default())
}

/// The WebView2 version as `compat` understands it: digits and dots, at most 32 characters, and
/// not all zeros (`0.0.0.0` is how an uninstalled runtime looks). Anything else is "absent".
fn clean_webview2_version(raw: Option<String>) -> Option<String> {
    let text = raw?.trim().to_string();
    let well_formed = !text.is_empty()
        && text.len() <= 32
        && text.starts_with(|c: char| c.is_ascii_digit())
        && text.chars().all(|c| c.is_ascii_digit() || c == '.');
    let all_zero = text.split('.').all(|part| part.chars().all(|c| c == '0'));
    (well_formed && !all_zero).then_some(text)
}

fn webview2_major(version: &str) -> Option<u32> {
    version.split('.').next()?.parse().ok()
}

/// Edge and Chrome at the per-machine paths (read-only: `path_roots` and `file_exists`).
fn browsers(platform: &dyn Platform) -> Result<CompatBrowsers, PlatformError> {
    let roots = platform.path_roots()?;
    let homes: Vec<&str> = std::iter::once(roots.program_files.as_str()).chain(roots.program_files_x86.as_deref()).collect();
    let found = |relative: &str| {
        homes.iter().any(|home| platform.file_exists(Path::new(&format!("{}\\{relative}", home.trim_end_matches('\\')))))
    };
    Ok(CompatBrowsers {
        edge: found(r"Microsoft\Edge\Application\msedge.exe"),
        chrome: found(r"Google\Chrome\Application\chrome.exe"),
    })
}

/// [`build`] with what the caller knows (plan 4.12).
pub fn build_with(
    platform: &dyn Platform,
    staff_sid: Option<&str>,
    allow_joined: bool,
    options: Options,
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

    // WebView2: absent is a warning (Setup installs it); a version under 125 is a warning too,
    // and both become the blocker once Setup has tried and the runtime is still not good enough.
    let version = clean_webview2_version(platform.webview2_version()?);
    let too_old = version.as_deref().and_then(webview2_major).is_some_and(|major| major < MIN_WEBVIEW2_MAJOR);
    if version.is_none() || too_old {
        if options.webview2_install_attempted {
            blockers.push(Blocker::Webview2TooOld);
        } else {
            warnings.push(if version.is_none() { Warning::Webview2Missing } else { Warning::Webview2TooOld });
        }
    }
    let protected_print = platform.protected_print_on()?;
    if protected_print {
        warnings.push(Warning::ProtectedPrintOn);
    }
    let low_ram = os.ram_mb < LOW_RAM_MB;
    if low_ram {
        warnings.push(Warning::LowRam);
    }

    // Layers L3 and L4 follow the edition and the build (the same rules the layers use). The
    // physical-protection probe (`read_security_posture`, WMI) is not run here: the status is
    // built often, and `deviceReports.security` already carries it.
    let layers = CompatLayers {
        app_locker: mechanism_for(&os.edition_id).is_some(),
        app_control: os.build >= MIN_BUILD_MULTIPLE_POLICY,
    };

    Ok(CompatReport {
        lite_mode: os.ram_mb <= LITE_MAX_RAM_MB,
        os: CompatOs::from(&os),
        blockers,
        warnings,
        webview2: CompatWebView2 { present: version.is_some(), source: if version.is_some() { "machine" } else { "none" }, version },
        protection: if layers.app_locker && layers.app_control { Protection::Full } else { Protection::Reduced },
        layers,
        browsers: browsers(platform)?,
        protected_print,
        low_ram,
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
            w.os.ram_mb = LITE_MAX_RAM_MB;
        });
        let report = build(&sim, None, false).unwrap();
        assert!(report.blockers.is_empty());
        assert_eq!(report.warnings, [Warning::LowDisk, Warning::Arm64Untested]);
        assert!(report.lite_mode);
        sim.with_world(|w| w.os.ram_mb = LITE_MAX_RAM_MB + 1);
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

    fn webview2(pv: Option<&str>) -> (TempDir, SimPlatform) {
        let (dir, sim) = sim();
        sim.with_world(|w| w.webview2_pv = pv.map(str::to_string));
        (dir, sim)
    }

    #[test]
    fn the_default_machine_has_webview2_full_protection_and_no_browsers() {
        let (_dir, sim) = sim();
        let report = build(&sim, None, false).unwrap();
        assert_eq!(report.webview2, CompatWebView2 { present: true, version: Some("130.0.2849.80".into()), source: "machine" });
        assert_eq!(report.protection, Protection::Full);
        assert_eq!(report.layers, CompatLayers { app_locker: true, app_control: true });
        assert!(report.reduced_reasons().is_empty());
        assert_eq!(report.browsers, CompatBrowsers { edge: false, chrome: false });
        assert!(!report.protected_print && !report.low_ram);
        let json = report.to_json();
        assert_eq!(json["webview2"], serde_json::json!({ "present": true, "version": "130.0.2849.80", "source": "machine" }));
        assert_eq!(json["protection"], "full");
        assert_eq!(json["layers"], serde_json::json!({ "appLocker": true, "appControl": true }));
        assert_eq!(json["browsers"], serde_json::json!({ "edge": false, "chrome": false }));
        assert_eq!(json["protectedPrint"], false);
        assert_eq!(json["lowRam"], false);
    }

    #[test]
    fn a_missing_webview2_is_a_warning_and_not_a_blocker() {
        // Absent, empty, all zeros and text that is not a version all mean "not installed".
        for pv in [None, Some(""), Some("  "), Some("0.0.0.0"), Some("0"), Some("not a version"), Some("1.2.3\u{0}")] {
            let (_dir, sim) = webview2(pv);
            let report = build(&sim, None, false).unwrap();
            assert!(report.blockers.is_empty(), "{pv:?}");
            assert_eq!(report.warnings, [Warning::Webview2Missing], "{pv:?}");
            assert_eq!(report.webview2, CompatWebView2 { present: false, version: None, source: "none" }, "{pv:?}");
            assert_eq!(report.to_json()["webview2"]["version"], serde_json::Value::Null);
        }
    }

    #[test]
    fn an_old_webview2_is_a_warning_until_setup_has_tried() {
        let (_dir, sim) = webview2(Some("124.0.2478.51"));
        let report = build(&sim, None, false).unwrap();
        assert!(report.blockers.is_empty());
        assert_eq!(report.warnings, [Warning::Webview2TooOld]);
        assert!(report.webview2.present);
        let (_dir, sim) = webview2(Some("125.0.0.0"));
        let report = build(&sim, None, false).unwrap();
        assert!(report.blockers.is_empty() && report.warnings.is_empty());
    }

    #[test]
    fn after_the_install_attempt_a_missing_or_old_webview2_is_the_blocker() {
        let after = Options { webview2_install_attempted: true };
        for (pv, blocked) in [(None, true), (Some("0.0.0.0"), true), (Some("124.9.9"), true), (Some("125.0.1"), false), (Some("131.0.2903.51"), false)] {
            let (_dir, sim) = webview2(pv);
            let report = build_with(&sim, None, false, after).unwrap();
            assert_eq!(report.blockers.contains(&Blocker::Webview2TooOld), blocked, "{pv:?}");
            // The blocker replaces the warning; the two never appear together.
            assert!(report.warnings.is_empty(), "{pv:?}: {:?}", report.warnings);
            assert_eq!(report.blocker_codes().contains(&"webview2_too_old"), blocked);
        }
    }

    #[test]
    fn home_edition_and_an_old_build_give_reduced_protection_with_the_missing_layers() {
        let (_dir, sim) = sim();
        sim.with_world(|w| w.os.edition_id = "CoreSingleLanguage".into());
        let report = build(&sim, None, false).unwrap();
        // Enrollment is still allowed (Phase 5 Q12): no blocker, only the badge.
        assert!(report.blockers.is_empty() && report.warnings.is_empty());
        assert_eq!(report.protection, Protection::Reduced);
        assert_eq!(report.layers, CompatLayers { app_locker: false, app_control: true });
        assert_eq!(report.reduced_reasons().len(), 1);
        assert_eq!(report.to_json()["protection"], "reduced");

        let (_dir, sim) = self::sim();
        sim.with_world(|w| w.os.build = MIN_BUILD_MULTIPLE_POLICY - 1);
        let report = build(&sim, None, false).unwrap();
        assert_eq!(report.layers, CompatLayers { app_locker: true, app_control: false });
        assert_eq!(report.protection, Protection::Reduced);

        for (edition, expected) in [("Professional", true), ("Enterprise", true), ("Education", true), ("Core", false), ("CoreN", false), ("Cloud", false)] {
            let (_dir, sim) = self::sim();
            sim.with_world(|w| w.os.edition_id = edition.into());
            assert_eq!(build(&sim, None, false).unwrap().layers.app_locker, expected, "{edition}");
        }
    }

    #[test]
    fn browsers_are_found_at_the_per_machine_paths() {
        let (_dir, sim) = sim();
        sim.add_file(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe");
        let report = build(&sim, None, false).unwrap();
        assert_eq!(report.browsers, CompatBrowsers { edge: true, chrome: false });
        sim.add_file(r"C:\Program Files\Google\Chrome\Application\chrome.exe");
        assert_eq!(build(&sim, None, false).unwrap().browsers, CompatBrowsers { edge: true, chrome: true });
        // A browser in some other folder is not found.
        let (_dir, other) = self::sim();
        other.add_file(r"D:\Portable\Google\Chrome\Application\chrome.exe");
        assert_eq!(build(&other, None, false).unwrap().browsers, CompatBrowsers { edge: false, chrome: false });
    }

    #[test]
    fn protected_print_and_low_ram_are_warnings() {
        let (_dir, sim) = sim();
        sim.with_world(|w| {
            w.protected_print = true;
            w.os.ram_mb = LOW_RAM_MB - 1;
        });
        let report = build(&sim, None, false).unwrap();
        assert!(report.blockers.is_empty());
        assert_eq!(report.warnings, [Warning::ProtectedPrintOn, Warning::LowRam]);
        assert!(report.protected_print && report.low_ram && report.lite_mode);
        sim.with_world(|w| w.os.ram_mb = LOW_RAM_MB);
        let report = build(&sim, None, false).unwrap();
        assert_eq!(report.warnings, [Warning::ProtectedPrintOn]);
        assert!(!report.low_ram);
    }

    #[test]
    fn a_failed_new_read_fails_the_report() {
        for op in [SimOp::Webview2Version, SimOp::ProtectedPrintOn, SimOp::OsInfo] {
            let (_dir, sim) = sim();
            sim.fail_next(op, PlatformError::AccessDenied);
            assert!(build(&sim, None, false).is_err(), "{op:?}");
        }
    }

    #[test]
    fn the_new_reads_change_nothing_on_the_machine() {
        let (_dir, sim) = sim();
        build(&sim, None, false).unwrap();
        assert!(sim.calls().iter().all(|call| !call.is_mutating()), "{:?}", sim.calls());
    }

    #[test]
    fn every_warning_and_blocker_has_a_code_and_plain_words() {
        for warning in [
            Warning::LowDisk,
            Warning::Arm64Untested,
            Warning::Webview2Missing,
            Warning::Webview2TooOld,
            Warning::ProtectedPrintOn,
            Warning::LowRam,
        ] {
            // The wire form of the enum and `code()` are the same text.
            assert_eq!(serde_json::to_value(warning).unwrap(), serde_json::json!(warning.code()));
            assert!(!warning.plain().is_empty());
        }
        for blocker in [
            Blocker::OsTooOld,
            Blocker::SMode,
            Blocker::ManagedDevice,
            Blocker::NoOtherAdmin,
            Blocker::LegalNotice,
            Blocker::ShellBinaryMissing,
            Blocker::Webview2TooOld,
        ] {
            assert_eq!(serde_json::to_value(blocker).unwrap(), serde_json::json!(blocker.code()));
            assert!(!blocker.plain().is_empty());
        }
    }

    #[test]
    fn the_report_stays_far_below_32_kb_even_with_the_longest_values() {
        let (_dir, sim) = sim();
        sim.with_world(|w| {
            w.os.display_version = "9".repeat(64);
            w.os.edition_id = "E".repeat(64);
            w.os.arch = "a".repeat(64);
            w.os.system_disk_free_gb = 1;
            w.os.s_mode = true;
            w.os.domain_joined = true;
            w.protected_print = true;
            w.os.ram_mb = 1;
            w.webview2_pv = Some(format!("1{}", ".1".repeat(15)));
        });
        let json = build_with(&sim, None, false, Options { webview2_install_attempted: true }).unwrap().to_json();
        let size = serde_json::to_string(&json).unwrap().len();
        assert!(size < 4 * 1024, "{size}");
        assert!(size <= 32 * 1024);
    }

    #[test]
    fn the_report_has_no_path_or_secret_only_codes_numbers_and_versions() {
        let (_dir, sim) = sim();
        sim.add_file(r"C:\Program Files\Google\Chrome\Application\chrome.exe");
        let text = serde_json::to_string(&build(&sim, None, false).unwrap().to_json()).unwrap();
        assert!(!text.contains(r"C:\") && !text.contains("Program Files") && !text.contains("SIM-PC"), "{text}");
    }

    #[test]
    fn the_plain_text_says_the_level_and_the_reasons() {
        let (_dir, sim) = sim();
        sim.with_world(|w| {
            w.os.edition_id = "Core".into();
            w.webview2_pv = None;
            w.protected_print = true;
        });
        let mut out = Vec::new();
        build(&sim, None, false).unwrap().write_text(&mut out).unwrap();
        let text = String::from_utf8(out).unwrap();
        assert!(text.contains("Protection    : reduced"), "{text}");
        assert!(text.contains("AppLocker rules (L3) are not available"), "{text}");
        assert!(text.contains("WebView2      : not installed"), "{text}");
        assert!(text.contains("webview2_missing - The WebView2 Runtime is not installed; Setup installs it."), "{text}");
        assert!(text.contains("protected_print_on"), "{text}");
        assert!(text.contains("Blockers      : none"), "{text}");

        let (_dir, healthy) = self::sim();
        let mut out = Vec::new();
        build(&healthy, None, false).unwrap().write_text(&mut out).unwrap();
        let text = String::from_utf8(out).unwrap();
        assert!(text.contains("Protection    : full") && text.contains("Warnings      : none"), "{text}");
    }
}
