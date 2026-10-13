//! Shared policy types. `DesiredState` is the document the agent reconciles a
//! device to (PRD Section 10). TypeScript types are generated with ts-rs into
//! `packages/types/src/generated/` (run `pnpm gen:types`).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// The example desired state from PRD Section 10.
pub const EXAMPLE_DESIRED_STATE_JSON: &str = r#"{
  "kioskEnabled": true,
  "apps": ["orders-web", "zoom", "tally", "libreoffice"],
  "allowedSites": ["portal.company.com"],
  "fileHandlers": { ".docx": "libreoffice" },
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

        let original: serde_json::Value = serde_json::from_str(EXAMPLE_DESIRED_STATE_JSON).unwrap();
        let again = serde_json::to_value(&state).unwrap();
        assert_eq!(original, again);
    }
}