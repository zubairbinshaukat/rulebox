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

use lockdown::{ConfigRef, LimitError, LockdownPolicy, UsbTempAllow};
use network::{PrinterSpec, WifiProfile, MAX_PRINTERS, MAX_WIFI_PROFILES};
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
    pub printers: Vec<PrinterSpec>,
    pub device_lock: Option<DeviceLock>,
    pub usb_temp_allow: Option<UsbTempAllow>,
    pub broadcasts: Vec<Broadcast>,
    pub config: Option<ConfigRef>,
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
        if let Some(lock) = &self.device_lock {
            lock.check_limits()?;
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