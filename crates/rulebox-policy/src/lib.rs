//! Shared policy types. `DesiredState` is the document the agent reconciles a
//! device to (PRD Section 10). TypeScript types are generated with ts-rs into
//! `packages/types/src/generated/` (run `pnpm gen:types`).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Deserializes an enum from a string; any value not listed becomes `Unknown`.
/// Written by hand because ts-rs cannot parse `#[serde(other)]`; the wire format
/// is the same. A copy of the macro in `rulebox-ipc` (plan Phase 4, 4.8). Must
/// stay above the `mod` lines so the modules can see it.
macro_rules! unknown_on_new_values {
    ($ty:ident { $($variant:ident => $text:literal),+ $(,)? }) => {
        impl<'de> serde::Deserialize<'de> for $ty {
            fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
                let text = <String as serde::Deserialize>::deserialize(d)?;
                Ok(match text.as_str() {
                    $($text => Self::$variant,)+
                    _ => Self::Unknown,
                })
            }
        }
    };
}

pub mod catalog;
pub mod envelope;
pub mod lockdown;
pub mod network;
pub mod notice;
pub mod paths;
pub mod roster;
pub mod seal;
pub mod version;

use lockdown::{ConfigRef, LimitError, LockdownPolicy, UsbTempAllow};
use network::{DriverSpec, PrinterSpec, WifiProfile, MAX_DRIVERS, MAX_PRINTERS, MAX_WIFI_PROFILES};
use notice::{Broadcast, DeviceLock, MAX_ACTIVE_BROADCASTS};

/// (Phase 5 Step 1, plan 4.3) The agent-only keys that Phase 5 adds to the signed
/// document, after `offlineDays`. It reads **only** those keys: the Phase 2 and
/// Phase 4 keys stay with [`DesiredState`] and the agent's own parsers, and a key
/// this struct does not know is ignored (no `deny_unknown_fields`), exactly like a
/// Phase 4 agent ignores these. Every field has a default, so a Phase 4 document
/// parses to [`AgentDoc::default`]: `lockdown` absent means every layer off and
/// everything restored (compatibility rule 1).
///
/// **Not exported to TypeScript and never sent to the Staff App**: it holds the
/// sealed Wi-Fi boxes. [`DesiredState`] does not change.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentDoc {
    /// `None` (absent or `null`) = all Phase 5 layers off.
    pub lockdown: Option<LockdownPolicy>,
    pub wifi: Vec<WifiProfile>,
    pub wifi_managed_only: bool,
    /// (Step 20, plan 4.15) The administrator ticked "I understand this PC will go offline until
    /// it sees a managed network": `wifiManagedOnly` is then applied even when the PC is on a
    /// Wi-Fi network that is not in the list (no `would_disconnect` refusal). Absent = false.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub wifi_managed_only_confirmed: bool,
    pub printers: Vec<PrinterSpec>,
    /// (Step 14b) Driver packages pushed to the device, after `printers`.
    pub drivers: Vec<DriverSpec>,
    pub device_lock: Option<DeviceLock>,
    pub usb_temp_allow: Option<UsbTempAllow>,
    pub broadcasts: Vec<Broadcast>,
    pub config: Option<ConfigRef>,
    /// (Phase 6 Step 4, plan 4.3, 4.14) The administrator's display-mode choice for this
    /// PC (the device value wins over the group's; the server sends the winner). Absent
    /// = `auto`. The agent computes the effective mode and tells the Staff App.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_mode: Option<DisplayModeOverride>,
    /// (Phase 6) Open web app windows allowed at once, 1 to 12. Absent = Lite 3,
    /// Standard 8 (the agent's default).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub web_window_cap: Option<u8>,
    /// (Phase 6) Minutes after which a hidden, silent web app window is closed: 0 = off,
    /// 5 to 240. Absent = Lite 30, Standard off.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub web_idle_close_min: Option<u16>,
    /// (Phase 6) Group switch: browser web apps may upload files
    /// (`AllowFileSelectionDialogs`, plan 4.9.3). Absent = false.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub browser_uploads: bool,
    /// (Phase 6 Step 20, plan 4.17) The Rulebox build this organization wants on its PCs.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rulebox_release: Option<RuleboxRelease>,
}

/// (Phase 6, plan 4.14) `displayMode` of a group or device. `Unknown` behaves as `Auto`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum DisplayModeOverride {
    #[default]
    Auto,
    Standard,
    Lite,
    Unknown,
}
unknown_on_new_values!(DisplayModeOverride { Auto => "auto", Standard => "standard", Lite => "lite" });

impl DisplayModeOverride {
    /// `Unknown` is `Auto`.
    pub fn effective(self) -> Self {
        if self == Self::Unknown {
            Self::Auto
        } else {
            self
        }
    }
}

/// (Phase 6 Step 20, plan 4.17) Coordinates of the MSI that upgrades Rulebox itself.
/// Signed like everything else; checked by SHA-256 (and, once signing is live, by signer).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RuleboxRelease {
    /// Ordered (see [`version`]).
    pub version: String,
    /// `https://` only.
    pub url: String,
    /// 64 lower-case hex.
    pub sha256: String,
    #[ts(type = "number")]
    pub size_bytes: u64,
}

/// `webWindowCap` range (plan 4.14).
pub const WEB_WINDOW_CAP_RANGE: std::ops::RangeInclusive<u8> = 1..=12;
/// `webIdleCloseMin` range; 0 = off.
pub const WEB_IDLE_CLOSE_RANGE: std::ops::RangeInclusive<u16> = 5..=240;

impl RuleboxRelease {
    /// Ordered version, https URL, well-formed hash.
    pub fn check_limits(&self) -> Result<(), LimitError> {
        let ok = version::is_ordered(&self.version)
            && catalog::check_https("ruleboxRelease.url", &self.url).is_ok()
            && catalog::check_sha256("ruleboxRelease.sha256", &self.sha256).is_ok();
        if ok {
            Ok(())
        } else {
            Err(LimitError::BadRelease)
        }
    }
}

impl AgentDoc {
    /// Reads the Phase 5 keys from the verified document (`Payload::doc`). An
    /// unknown enum value becomes `Unknown`; a value of the wrong type is an error.
    pub fn from_doc(doc: &serde_json::Value) -> Result<Self, serde_json::Error> {
        Self::deserialize(doc)
    }

    /// All limits of plan 4.3 rule 4. The agent refuses the whole document
    /// (`policy_rejected`) when one is exceeded. `now_ms` decides which broadcasts
    /// are active (an expired one that is still listed does not count).
    pub fn check_limits(&self, now_ms: u64) -> Result<(), LimitError> {
        if let Some(lockdown) = &self.lockdown {
            lockdown.check_limits()?;
        }
        if self.wifi.len() > MAX_WIFI_PROFILES {
            return Err(LimitError::TooManyWifi);
        }
        self.wifi.iter().try_for_each(WifiProfile::check_limits)?;
        if self.printers.len() > MAX_PRINTERS {
            return Err(LimitError::TooManyPrinters);
        }
        self.printers.iter().try_for_each(PrinterSpec::check_limits)?;
        if self.drivers.len() > MAX_DRIVERS {
            return Err(LimitError::TooManyDrivers);
        }
        self.drivers.iter().try_for_each(DriverSpec::check_limits)?;
        if let Some(lock) = &self.device_lock {
            lock.check_limits()?;
        }
        if self.web_window_cap.is_some_and(|cap| !WEB_WINDOW_CAP_RANGE.contains(&cap)) {
            return Err(LimitError::BadWindowCap);
        }
        if self.web_idle_close_min.is_some_and(|min| min != 0 && !WEB_IDLE_CLOSE_RANGE.contains(&min)) {
            return Err(LimitError::BadIdleClose);
        }
        if let Some(release) = &self.rulebox_release {
            release.check_limits()?;
        }
        if self.broadcasts.iter().filter(|b| b.is_active(now_ms)).count() > MAX_ACTIVE_BROADCASTS {
            return Err(LimitError::TooManyBroadcasts);
        }
        self.broadcasts.iter().try_for_each(Broadcast::check_limits)
    }
}

/// The example desired state from PRD Section 10.
pub const EXAMPLE_DESIRED_STATE_JSON: &str = r#"{
  "kioskEnabled": true,
  "apps": ["orders-web", "zoom", "tally", "libreoffice"],
  "allowedSites": ["portal.company.com"],
  "fileHandlers": { ".docx": "libreoffice", ".txt": "notepad", ".csv": "notepad" },
  "storage": { "defaultQuotaGb": 10 },
  "branding": { "name": "Company OS", "logo": "..." },
  "version": 42
}"#;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct StorageConfig {
    pub default_quota_gb: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Branding {
    pub name: String,
    pub logo: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DesiredState {
    pub kiosk_enabled: bool,
    pub apps: Vec<String>,
    pub allowed_sites: Vec<String>,
    pub file_handlers: BTreeMap<String, String>,
    pub storage: StorageConfig,
    pub branding: Branding,
    /// Monotonic version; JSON number (stays well below 2^53).
    #[ts(type = "number")]
    pub version: u64,
}

impl DesiredState {
    /// Used when a device is enrolled but the backend has no document yet (PRD 9.1
    /// step 5, plan Section 5.6): kiosk on, everything else empty, version 0.
    pub fn enrollment_default() -> Self {
        Self {
            kiosk_enabled: true,
            apps: Vec::new(),
            allowed_sites: Vec::new(),
            file_handlers: BTreeMap::new(),
            storage: StorageConfig { default_quota_gb: 0 },
            branding: Branding { name: "Rulebox".to_string(), logo: None },
            version: 0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enrollment_default_is_kiosk_on_and_empty() {
        let state = DesiredState::enrollment_default();
        assert!(state.kiosk_enabled);
        assert!(state.apps.is_empty() && state.allowed_sites.is_empty() && state.file_handlers.is_empty());
        assert_eq!(state.storage.default_quota_gb, 0);
        assert_eq!(state.branding, Branding { name: "Rulebox".into(), logo: None });
        assert_eq!(state.version, 0);
        // It is a valid document: it survives a round trip through JSON.
        let again: DesiredState = serde_json::from_value(serde_json::to_value(&state).unwrap()).unwrap();
        assert_eq!(again, state);
    }

    #[test]
    fn prd_example_round_trips() {
        let state: DesiredState = serde_json::from_str(EXAMPLE_DESIRED_STATE_JSON).unwrap();
        assert!(state.kiosk_enabled);
        assert_eq!(state.version, 42);
        assert_eq!(state.storage.default_quota_gb, 10);
        assert_eq!(state.file_handlers.get(".docx").map(String::as_str), Some("libreoffice"));
        // The demo catalogue's Notepad opens text and CSV files ("Open with" in the Files window).
        assert_eq!(state.file_handlers.get(".txt").map(String::as_str), Some("notepad"));
        assert_eq!(state.file_handlers.get(".csv").map(String::as_str), Some("notepad"));

        let original: serde_json::Value = serde_json::from_str(EXAMPLE_DESIRED_STATE_JSON).unwrap();
        let again = serde_json::to_value(&state).unwrap();
        assert_eq!(original, again);
    }
}