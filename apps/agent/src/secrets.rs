//! Secrets (plan Section 5.1). Serialized to JSON and handed to
//! `Platform::secrets_save`, which protects them (DPAPI on Windows). Never
//! logged; `Debug` prints `<redacted>`.

use serde::{Deserialize, Serialize};

use crate::platform::{Platform, PlatformError};

#[derive(Serialize, Deserialize, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Secrets {
    /// 64 hex characters.
    pub device_secret: Option<String>,
    pub pending_device_secret: Option<String>,
    pub original_default_password_registry: Option<String>,
    pub original_default_password_lsa: Option<String>,
}

impl std::fmt::Debug for Secrets {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Secrets(<redacted>)")
    }
}

impl Secrets {
    /// Missing means empty. A blob that does not parse is an error, not a reset:
    /// silently dropping the device secret would lock the PC out of its account.
    pub fn load(platform: &dyn Platform) -> Result<Secrets, PlatformError> {
        match platform.secrets_load()? {
            None => Ok(Secrets::default()),
            Some(bytes) => serde_json::from_slice(&bytes)
                .map_err(|_| PlatformError::Other("the secrets file does not parse".into())),
        }
    }

    pub fn save(&self, platform: &dyn Platform) -> Result<(), PlatformError> {
        let bytes = serde_json::to_vec(self).map_err(|e| PlatformError::Other(e.to_string()))?;
        platform.secrets_save(&bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::sim::SimPlatform;
    use crate::testutil::TempDir;

    fn filled() -> Secrets {
        Secrets {
            device_secret: Some("ab".repeat(32)),
            pending_device_secret: Some("cd".repeat(32)),
            original_default_password_registry: Some("hunter2-reg".into()),
            original_default_password_lsa: Some("hunter2-lsa".into()),
        }
    }

    #[test]
    fn debug_output_has_no_secret() {
        let text = format!("{:?} {:#?}", filled(), filled());
        assert!(text.contains("<redacted>"));
        for secret in ["abab", "cdcd", "hunter2"] {
            assert!(!text.contains(secret), "{text}");
        }
    }

    #[test]
    fn round_trip_through_the_platform() {
        let dir = TempDir::new();
        let platform = SimPlatform::new(dir.path().to_path_buf());
        assert_eq!(Secrets::load(&platform).unwrap(), Secrets::default());
        filled().save(&platform).unwrap();
        assert_eq!(Secrets::load(&platform).unwrap(), filled());
    }

    #[test]
    fn unparsable_secrets_are_an_error() {
        let dir = TempDir::new();
        let platform = SimPlatform::new(dir.path().to_path_buf());
        platform.secrets_save(b"garbage").unwrap();
        assert!(Secrets::load(&platform).is_err());
    }
}
