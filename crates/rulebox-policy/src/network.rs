//! Wi-Fi profiles, printers and drivers of the agent-only desired-state keys (plan Phase 5,
//! Section 4.3 and 4.15): `wifi`, `wifiManagedOnly`, `printers` and `drivers`. Pure data.
//!
//! A Wi-Fi passphrase is never a field of [`WifiProfile`]: it travels only as a
//! [`SealedBox`] (`seal.rs`) addressed to one device, and the agent opens it just
//! before it writes the profile. The profile's own `Debug` shows no sealed bytes.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::lockdown::LimitError;
use crate::seal::SealedBox;

/// `wifi` entries per device.
pub const MAX_WIFI_PROFILES: usize = 20;
/// `printers` entries per device.
pub const MAX_PRINTERS: usize = 20;
/// SSID length in bytes (802.11).
pub const MAX_SSID_BYTES: usize = 32;
/// Printer name, in characters (plan 4.2).
pub const MAX_PRINTER_NAME: usize = 60;
/// Printer address, in characters.
pub const MAX_PRINTER_ADDRESS: usize = 255;
/// Printer queue, in characters.
pub const MAX_PRINTER_QUEUE: usize = 64;
/// Printer driver name, in characters.
pub const MAX_PRINTER_DRIVER: usize = 100;
/// `drivers` entries per device (Step 14b).
pub const MAX_DRIVERS: usize = 20;
/// Driver display name, in characters.
pub const MAX_DRIVER_NAME: usize = 60;
/// Driver download URL, in characters.
pub const MAX_DRIVER_URL: usize = 2048;
/// The `.inf` path inside a driver zip, in characters.
pub const MAX_DRIVER_INF: usize = 120;
/// Silent arguments of an EXE driver.
pub const MAX_DRIVER_ARGS: usize = 16;
/// Success exit codes of a vendor driver installer.
pub const MAX_DRIVER_EXIT_CODES: usize = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum WifiSecurity {
    Open,
    Wpa2Personal,
    Wpa3Personal,
    Wpa2Wpa3Personal,
    Unknown,
}
unknown_on_new_values!(WifiSecurity {
    Open => "open",
    Wpa2Personal => "wpa2Personal",
    Wpa3Personal => "wpa3Personal",
    Wpa2Wpa3Personal => "wpa2Wpa3Personal",
});

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum PrinterKind {
    Ipp,
    Raw,
    Lpr,
    Share,
    Unknown,
}
unknown_on_new_values!(PrinterKind { Ipp => "ipp", Raw => "raw", Lpr => "lpr", Share => "share" });

/// One managed Wi-Fi profile (4.15). `revision` changes whenever the profile or its
/// passphrase changes. `sealed` is `None` for an open network and for the
/// ring-gated copy that carries no secret (4.3 rule 6).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct WifiProfile {
    pub id: String,
    pub ssid: String,
    pub hidden: bool,
    pub security: WifiSecurity,
    pub auto_connect: bool,
    #[ts(type = "number")]
    pub revision: u64,
    #[serde(default)]
    pub sealed: Option<SealedBox>,
}

/// One printer pushed to the device (4.15).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PrinterSpec {
    pub id: String,
    pub name: String,
    pub kind: PrinterKind,
    pub address: String,
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub queue: Option<String>,
    pub driver: String,
    pub is_default: bool,
    #[ts(type = "number")]
    pub revision: u64,
}

/// How a driver is put on the PC (Step 14b).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum DriverKind {
    /// A zip with an `.inf`, its signed catalog and the files, installed with `pnputil /add-driver`.
    Inf,
    /// A vendor installer with silent arguments.
    Exe,
    Msi,
    Unknown,
}
unknown_on_new_values!(DriverKind { Inf => "inf", Exe => "exe", Msi => "msi" });

/// (Phase 6, plan 4.8) Where a driver's files come from. Absent on a Phase 5 driver:
/// the agent then goes by `kind`. `Unknown` is refused as an unknown way to install
/// (the driver is not installed), never guessed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum DriverSource {
    /// A zip with the extracted `.inf`, `.cat` and files (preferred).
    InfZip,
    /// The vendor's EXE or MSI with its silent switches, through the install engine.
    VendorExe,
    /// The vendor's EXE with fixed extract arguments, then the `inf_zip` path.
    VendorExeExtract,
    Unknown,
}
unknown_on_new_values!(DriverSource {
    InfZip => "inf_zip",
    VendorExe => "vendor_exe",
    VendorExeExtract => "vendor_exe_extract",
});

/// One driver package pushed to the device (Step 14b). Never shown as a tile.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DriverSpec {
    pub id: String,
    pub name: String,
    pub kind: DriverKind,
    /// `https://` only.
    pub url: String,
    /// 64 lower-case hex.
    pub sha256: String,
    /// 0 = unknown.
    #[ts(type = "number")]
    pub size_bytes: u64,
    /// `inf` only: the relative path of the `.inf` inside the zip.
    #[serde(default)]
    pub inf: Option<String>,
    /// `exe` only.
    #[serde(default)]
    pub silent_args: Vec<String>,
    #[serde(default)]
    pub success_exit_codes: Vec<i32>,
    #[ts(type = "number")]
    pub revision: u64,
    /// (Phase 6) Omitted when absent, so a Phase 5 driver serializes as before.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub source: Option<DriverSource>,
}

fn within(text: &str, max: usize) -> Result<(), LimitError> {
    if text.chars().count() > max {
        return Err(LimitError::TextTooLong);
    }
    Ok(())
}

impl WifiProfile {
    /// SSID 1 to 32 bytes of UTF-8 (4.2); no sealed bytes are looked at here.
    pub fn check_limits(&self) -> Result<(), LimitError> {
        if self.ssid.is_empty() || self.ssid.len() > MAX_SSID_BYTES {
            return Err(LimitError::BadSsid);
        }
        within(&self.id, crate::lockdown::MAX_ID_CHARS)
    }
}

impl PrinterSpec {
    /// The string sizes of 4.2, and a port in 1..=65535 when there is one.
    pub fn check_limits(&self) -> Result<(), LimitError> {
        if self.name.trim().is_empty() || self.address.trim().is_empty() || self.driver.trim().is_empty() {
            return Err(LimitError::TextEmpty);
        }
        within(&self.id, crate::lockdown::MAX_ID_CHARS)?;
        within(&self.name, MAX_PRINTER_NAME)?;
        within(&self.address, MAX_PRINTER_ADDRESS)?;
        within(&self.driver, MAX_PRINTER_DRIVER)?;
        if let Some(queue) = &self.queue {
            within(queue, MAX_PRINTER_QUEUE)?;
        }
        if self.port == Some(0) {
            return Err(LimitError::BadPort);
        }
        Ok(())
    }
}

impl DriverSpec {
    /// The string sizes and list lengths of Step 14b. (The agent checks the values themselves, URL scheme, hash and
    /// path shape, again when it installs.)
    pub fn check_limits(&self) -> Result<(), LimitError> {
        if self.name.trim().is_empty() || self.url.trim().is_empty() {
            return Err(LimitError::TextEmpty);
        }
        within(&self.id, crate::lockdown::MAX_ID_CHARS)?;
        within(&self.name, MAX_DRIVER_NAME)?;
        within(&self.url, MAX_DRIVER_URL)?;
        if let Some(inf) = &self.inf {
            within(inf, MAX_DRIVER_INF)?;
        }
        if self.silent_args.len() > MAX_DRIVER_ARGS || self.success_exit_codes.len() > MAX_DRIVER_EXIT_CODES {
            return Err(LimitError::TextTooLong);
        }
        if crate::paths::check_args(&self.silent_args).is_err() {
            return Err(LimitError::TextTooLong);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn driver() -> DriverSpec {
        DriverSpec {
            id: "d1".into(),
            name: "Brother HL".into(),
            kind: DriverKind::Inf,
            url: "https://example.com/brother.zip".into(),
            sha256: "a".repeat(64),
            size_bytes: 1000,
            inf: Some("drv/brother.inf".into()),
            silent_args: Vec::new(),
            success_exit_codes: Vec::new(),
            revision: 3,
            source: None,
        }
    }

    #[test]
    fn driver_parses_in_contract_order_and_unknown_kind_is_kept() {
        let text = serde_json::to_string(&driver()).unwrap();
        assert!(text.starts_with(r#"{"id":"d1","name":"Brother HL","kind":"inf","url":"#), "{text}");
        let order = ["id", "name", "kind", "url", "sha256", "sizeBytes", "inf", "silentArgs", "successExitCodes", "revision"];
        let at: Vec<usize> = order.iter().map(|k| text.find(&format!("\"{k}\":")).unwrap()).collect();
        assert!(at.windows(2).all(|w| w[0] < w[1]), "{text}");
        let again: DriverSpec = serde_json::from_str(&text).unwrap();
        assert_eq!(again, driver());
        let mut value = serde_json::to_value(driver()).unwrap();
        value["kind"] = "usb-fairy".into();
        let parsed: DriverSpec = serde_json::from_value(value).unwrap();
        assert_eq!(parsed.kind, DriverKind::Unknown);
    }

    #[test]
    fn driver_limits() {
        assert_eq!(driver().check_limits(), Ok(()));
        assert_eq!(DriverSpec { name: "x".repeat(61), ..driver() }.check_limits(), Err(LimitError::TextTooLong));
        assert_eq!(DriverSpec { name: " ".into(), ..driver() }.check_limits(), Err(LimitError::TextEmpty));
        assert_eq!(DriverSpec { inf: Some("x".repeat(121)), ..driver() }.check_limits(), Err(LimitError::TextTooLong));
        assert_eq!(DriverSpec { silent_args: vec!["/S".into(); 17], ..driver() }.check_limits(), Err(LimitError::TextTooLong));
        assert_eq!(DriverSpec { success_exit_codes: vec![0; 9], ..driver() }.check_limits(), Err(LimitError::TextTooLong));
        assert_eq!(DriverSpec { silent_args: vec!["a\nb".into()], ..driver() }.check_limits(), Err(LimitError::TextTooLong));
    }

    fn printer() -> PrinterSpec {
        PrinterSpec {
            id: "k7".into(),
            name: "Front desk".into(),
            kind: PrinterKind::Ipp,
            address: "https://10.0.0.20:631/ipp/print".into(),
            port: None,
            queue: None,
            driver: "Microsoft IPP Class Driver".into(),
            is_default: true,
            revision: 2,
        }
    }

    #[test]
    fn plan_example_parses_and_round_trips() {
        let text = r#"[{ "id": "k9", "ssid": "Acme-Staff", "hidden": false, "security": "wpa2Personal",
                         "autoConnect": true, "revision": 3,
                         "sealed": { "v": 1, "keyId": "a1b2c3d4e5f60718", "epk": "AA==", "nonce": "AA==", "ct": "AA==" } }]"#;
        let profiles: Vec<WifiProfile> = serde_json::from_str(text).unwrap();
        assert_eq!(profiles[0].security, WifiSecurity::Wpa2Personal);
        assert_eq!(profiles[0].sealed.as_ref().map(|s| s.v), Some(1));
        let again: Vec<WifiProfile> = serde_json::from_value(serde_json::to_value(&profiles).unwrap()).unwrap();
        assert_eq!(again, profiles);

        let printers: Vec<PrinterSpec> = serde_json::from_str(
            r#"[{ "id": "k7", "name": "Front desk", "kind": "ipp", "address": "https://10.0.0.20:631/ipp/print",
                  "port": null, "queue": null, "driver": "Microsoft IPP Class Driver", "isDefault": true, "revision": 2 }]"#,
        )
        .unwrap();
        assert_eq!(printers, vec![printer()]);
    }

    #[test]
    fn unknown_security_and_kind_become_unknown() {
        let wifi: WifiProfile = serde_json::from_str(
            r#"{ "id": "a", "ssid": "x", "hidden": false, "security": "wpa4", "autoConnect": true, "revision": 1 }"#,
        )
        .unwrap();
        assert_eq!(wifi.security, WifiSecurity::Unknown);
        assert!(wifi.sealed.is_none());
        let mut value = serde_json::to_value(printer()).unwrap();
        value["kind"] = "laser-pigeon".into();
        let parsed: PrinterSpec = serde_json::from_value(value).unwrap();
        assert_eq!(parsed.kind, PrinterKind::Unknown);
    }

    #[test]
    fn ssid_and_printer_limits() {
        let wifi = |ssid: &str| WifiProfile {
            id: "a".into(),
            ssid: ssid.into(),
            hidden: false,
            security: WifiSecurity::Open,
            auto_connect: true,
            revision: 1,
            sealed: None,
        };
        assert_eq!(wifi("a").check_limits(), Ok(()));
        assert_eq!(wifi(&"a".repeat(32)).check_limits(), Ok(()));
        assert_eq!(wifi("").check_limits(), Err(LimitError::BadSsid));
        assert_eq!(wifi(&"a".repeat(33)).check_limits(), Err(LimitError::BadSsid));
        // 32 characters of two bytes each is 64 bytes: too long.
        assert_eq!(wifi(&"é".repeat(32)).check_limits(), Err(LimitError::BadSsid));

        assert_eq!(printer().check_limits(), Ok(()));
        assert_eq!(PrinterSpec { name: "x".repeat(61), ..printer() }.check_limits(), Err(LimitError::TextTooLong));
        assert_eq!(PrinterSpec { address: "x".repeat(256), ..printer() }.check_limits(), Err(LimitError::TextTooLong));
        assert_eq!(PrinterSpec { queue: Some("x".repeat(65)), ..printer() }.check_limits(), Err(LimitError::TextTooLong));
        assert_eq!(PrinterSpec { port: Some(0), ..printer() }.check_limits(), Err(LimitError::BadPort));
        assert_eq!(PrinterSpec { name: " ".into(), ..printer() }.check_limits(), Err(LimitError::TextEmpty));
    }
}
