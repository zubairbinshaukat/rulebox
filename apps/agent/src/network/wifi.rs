//! Wi-Fi profiles and "managed networks only" (Phase 5 Step 13, plan 4.15).
//!
//! * Every `doc.wifi` profile becomes the WLAN profile `Rulebox-<id>`, stored for all users
//!   (`rulebox_win32::wlan::set_profile`), through `journal::change` (target `WlanProfile`,
//!   original always "not present"). The agent only ever writes or deletes names with that
//!   prefix, and only deletes those its journal owns.
//! * The passphrase arrives sealed to this device (`rulebox.seal/1`, plan 4.18). One function,
//!   [`install_profile`], opens the box, builds the XML and hands it to the journal; the
//!   buffers on the way are zeroized, nothing is logged, and the journal and the agent state
//!   keep only a mark that does not contain or derive from the passphrase.
//! * A secured profile without a box is `waiting_for_key`: nothing is written and an existing
//!   profile stays. A PC without a wireless adapter says `unsupported` and gets nothing.
//! * `wifiManagedOnly` sets the WLAN permit list to the SSIDs of the document's profiles
//!   (journalled, put back on Disable). The refusals of plan 4.6 (`managed_networks_empty`,
//!   `would_disconnect`) are decided before any layer runs, in `lockdown::invariants`.
//!
//! The states are the fixed codes `applied | waiting_for_key | failed | unsupported`; `detail`
//! is a fixed code too, never Windows text. Not reached by the reconciler until Step 20.

use rulebox_policy::network::{WifiProfile, WifiSecurity};
use rulebox_policy::seal::{open_sealed, SealError};
use rulebox_policy::AgentDoc;
use zeroize::Zeroizing;

use super::{sealkey, SecretText};
use crate::backend::reports::WifiItemState;
use crate::journal::{self, Change, ChangeOutcome, JournalError, JournalOwner, WLAN_FILTERS_ID, WLAN_ID_PREFIX};
use crate::lockdown::apply::ApplyCtx;
use crate::platform::PlatformError;

/// The item states of the apply report.
pub const APPLIED: &str = "applied";
pub const WAITING_FOR_KEY: &str = "waiting_for_key";
pub const FAILED: &str = "failed";
pub const UNSUPPORTED: &str = "unsupported";

/// Longest profile id accepted from a document (Convex ids are 32 characters).
const MAX_PROFILE_ID: usize = 64;
/// `ERROR_BAD_PROFILE`: what `WlanSetProfile` answers for a profile the driver or the profile
/// schema refuses (the reason code is not readable through the seam, see `security_refused`).
const ERROR_BAD_PROFILE: u32 = 1206;
/// The WLAN profile schema namespace (version 1) and the one transition mode lives in.
const NS_V1: &str = "http://www.microsoft.com/networking/WLAN/profile/v1";
const NS_V4: &str = "http://www.microsoft.com/networking/WLAN/profile/v4";
/// Room for the whole XML so the buffer never reallocates (a reallocation would leave an
/// unzeroed copy of the key behind): at most about 1.5 KB with the worst-case escaping.
const XML_CAPACITY: usize = 4096;

/// `Rulebox-<id>`, or `None` when the id is empty, too long or has a character outside
/// `A-Z a-z 0-9 _ -` (such an item is never written: `bad_profile_id`).
pub fn profile_name(id: &str) -> Option<String> {
    let ok = !id.is_empty() && id.len() <= MAX_PROFILE_ID && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    ok.then(|| format!("{}{id}", rulebox_win32::wlan::PROFILE_PREFIX))
}

fn escape(text: &str, out: &mut String) {
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            other => out.push(other),
        }
    }
}

fn is_hex_key(text: &str) -> bool {
    text.len() == 64 && text.bytes().all(|b| b.is_ascii_hexdigit())
}

/// 8 to 63 printable ASCII characters, or exactly 64 hex digits (plan 4.15).
pub fn passphrase_ok(text: &str) -> bool {
    let printable = text.bytes().all(|b| (0x20..=0x7e).contains(&b));
    printable && ((8..=63).contains(&text.len()) || is_hex_key(text))
}

/// The WLANProfile XML of `profile` (schema v1). `passphrase` is the key material; it is
/// required for a secured profile and ignored for an open one (`None` builds the same XML
/// without the `sharedKey` element, which is what the mark is computed from).
///
/// Errors are fixed codes: `bad_profile_id`, `ssid_unsupported` (a control character in the
/// SSID), `passphrase_invalid`, `section_unknown_value` (an unknown security).
pub fn profile_xml(profile: &WifiProfile, passphrase: Option<&str>) -> Result<SecretText, &'static str> {
    let name = profile_name(&profile.id).ok_or("bad_profile_id")?;
    if profile.ssid.is_empty() || profile.ssid.chars().any(char::is_control) {
        return Err("ssid_unsupported");
    }
    let (authentication, encryption, transition) = match profile.security {
        WifiSecurity::Open => ("open", "none", false),
        WifiSecurity::Wpa2Personal => ("WPA2PSK", "AES", false),
        WifiSecurity::Wpa3Personal => ("WPA3SAE", "AES", false),
        WifiSecurity::Wpa2Wpa3Personal => ("WPA3SAE", "AES", true),
        WifiSecurity::Unknown => return Err("section_unknown_value"),
    };
    let secured = profile.security != WifiSecurity::Open;
    let key_type = match passphrase {
        Some(key) if secured => {
            if !passphrase_ok(key) {
                return Err("passphrase_invalid");
            }
            // A 64-digit hex string is the raw PSK (WPA2); SAE has no such thing.
            if is_hex_key(key) {
                if profile.security != WifiSecurity::Wpa2Personal {
                    return Err("passphrase_invalid");
                }
                Some("networkKey")
            } else {
                Some("passPhrase")
            }
        }
        _ => None,
    };

    let mut xml = Zeroizing::new(String::with_capacity(XML_CAPACITY));
    xml.push_str("<?xml version=\"1.0\"?>");
    xml.push_str(&format!("<WLANProfile xmlns=\"{NS_V1}\">"));
    xml.push_str("<name>");
    escape(&name, &mut xml);
    xml.push_str("</name><SSIDConfig><SSID><hex>");
    for byte in profile.ssid.as_bytes() {
        xml.push_str(&format!("{byte:02X}"));
    }
    xml.push_str("</hex><name>");
    escape(&profile.ssid, &mut xml);
    xml.push_str("</name></SSID>");
    if profile.hidden {
        xml.push_str("<nonBroadcast>true</nonBroadcast>");
    }
    xml.push_str("</SSIDConfig><connectionType>ESS</connectionType>");
    xml.push_str(if profile.auto_connect { "<connectionMode>auto</connectionMode>" } else { "<connectionMode>manual</connectionMode>" });
    xml.push_str("<MSM><security><authEncryption>");
    xml.push_str(&format!("<authentication>{authentication}</authentication><encryption>{encryption}</encryption><useOneX>false</useOneX>"));
    if transition {
        xml.push_str(&format!("<transitionMode xmlns=\"{NS_V4}\">true</transitionMode>"));
    }
    xml.push_str("</authEncryption>");
    if let (Some(key), Some(key_type)) = (passphrase, key_type) {
        xml.push_str(&format!("<sharedKey><keyType>{key_type}</keyType><protected>false</protected><keyMaterial>"));
        escape(key, &mut xml);
        xml.push_str("</keyMaterial></sharedKey>");
    }
    xml.push_str("</security></MSM></WLANProfile>");
    debug_assert!(xml.len() <= XML_CAPACITY, "the profile XML outgrew its buffer");
    Ok(SecretText::new(std::mem::take(&mut *xml)))
}

/// `rev<revision>:<sha256 of the XML without the key>`: what the agent remembers about an
/// installed profile. Changes with the revision and with everything but the passphrase (the
/// passphrase changes bump the revision, plan 4.15). Never contains a passphrase.
pub fn mark_of(profile: &WifiProfile) -> Result<String, &'static str> {
    let bare = profile_xml(profile, None)?;
    Ok(format!("rev{}:{}", profile.revision, journal::policy_hash(bare.expose().as_bytes())))
}

/// Why a profile could not be installed (a fixed code for `detail`).
fn failure_code(error: &JournalError, profile: &WifiProfile) -> (&'static str, bool) {
    match error {
        // `unsupported`: the adapter went away between the check and the write.
        JournalError::Platform(PlatformError::NotFound) => (UNSUPPORTED, false),
        JournalError::Platform(PlatformError::Win32 { api: "WlanSetProfile", code: ERROR_BAD_PROFILE }) => {
            // UNVERIFIED (VM/real adapter, Step 21): the seam cannot read the WLAN reason code, so a
            // refusal of a WPA3 profile is taken to mean "this adapter cannot do WPA3".
            if matches!(profile.security, WifiSecurity::Wpa3Personal | WifiSecurity::Wpa2Wpa3Personal) {
                (FAILED, true)
            } else {
                (FAILED, false)
            }
        }
        _ => (FAILED, false),
    }
}

fn item(profile: &WifiProfile, state: &str, detail: Option<&str>) -> WifiItemState {
    WifiItemState {
        profile_id: profile.id.clone(),
        revision: profile.revision,
        state: state.to_string(),
        detail: detail.map(str::to_string),
    }
}

/// What installing one profile came to.
enum Installed {
    Done(ChangeOutcome),
    Waiting,
    Failed(&'static str),
    Unsupported,
}

/// Opens the profile's sealed box, builds the XML and writes the profile through the journal:
/// the one place a passphrase is in memory. Every buffer is `Zeroizing` or a [`SecretText`];
/// nothing is logged and no error carries a secret.
fn install_profile(ctx: &ApplyCtx<'_>, profile: &WifiProfile, name: &str) -> Installed {
    let mark = match mark_of(profile) {
        Ok(mark) => mark,
        Err(code) => return Installed::Failed(code),
    };
    let xml = if profile.security == WifiSecurity::Open {
        match profile_xml(profile, None) {
            Ok(xml) => xml,
            Err(code) => return Installed::Failed(code),
        }
    } else {
        let Some(sealed) = &profile.sealed else {
            return Installed::Waiting;
        };
        let secret = match sealkey::secret(ctx.journal.shared) {
            Ok(Some(secret)) => secret,
            // No key yet: the server has nothing to seal to, so this cannot be a box for us.
            Ok(None) => return Installed::Waiting,
            Err(_) => return Installed::Failed("seal_key_unreadable"),
        };
        let Some((org_id, device_id)) = ctx
            .journal
            .shared
            .read(|state| state.enrollment.as_ref().map(|enrollment| (enrollment.org_id.clone(), enrollment.device_id.clone())))
        else {
            return Installed::Failed("not_enrolled");
        };
        let opened = match open_sealed(sealed, &secret, &org_id, &device_id, &profile.id) {
            Ok(opened) => opened,
            Err(SealError::WrongKey | SealError::Open | SealError::BadVersion | SealError::BadEncoding | SealError::BadId) => {
                return Installed::Failed("seal_unopenable");
            }
        };
        let Ok(passphrase) = std::str::from_utf8(&opened) else {
            return Installed::Failed("passphrase_invalid");
        };
        match profile_xml(profile, Some(passphrase)) {
            Ok(xml) => xml,
            Err(code) => return Installed::Failed(code),
        }
    };
    let change = Change::wlan_profile(name, xml, &mark).since(ctx.version);
    match journal::change(&ctx.journal, &change) {
        Ok(outcome) => Installed::Done(outcome),
        Err(error) => {
            let (state, security_refused) = failure_code(&error, profile);
            if state == UNSUPPORTED {
                Installed::Unsupported
            } else if security_refused {
                Installed::Failed("security_unsupported")
            } else if matches!(error, JournalError::Platform(PlatformError::Win32 { code: ERROR_BAD_PROFILE, .. })) {
                Installed::Failed("profile_rejected")
            } else {
                Installed::Failed(journal::error_code(&error))
            }
        }
    }
}

/// What the Wi-Fi layer did: one state per profile in the document, and the outcome of the
/// permit list (a fixed code when it could not be set; there is no report field for it yet).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WifiOutcome {
    pub items: Vec<WifiItemState>,
    pub filters_error: Option<&'static str>,
}

/// The ids of the journal entries of Wi-Fi profiles (not the permit list).
fn profile_entry_ids(ctx: &ApplyCtx<'_>) -> Vec<String> {
    ctx.journal.shared.read(|state| {
        state
            .journal
            .iter()
            .filter(|entry| entry.owner == JournalOwner::Wifi && entry.id.starts_with(WLAN_ID_PREFIX) && entry.id != WLAN_FILTERS_ID)
            .map(|entry| entry.id.clone())
            .collect()
    })
}

fn has_filters_entry(ctx: &ApplyCtx<'_>) -> bool {
    ctx.journal.shared.read(|state| state.journal.iter().any(|entry| entry.id == WLAN_FILTERS_ID))
}

/// Applies the document's `wifi` and `wifiManagedOnly` keys. Runs in `Layer::Wifi`, after the
/// invariants of plan 4.6 passed.
pub fn apply(ctx: &ApplyCtx<'_>, doc: &AgentDoc) -> WifiOutcome {
    let mut outcome = WifiOutcome::default();
    let platform = ctx.journal.platform;
    let adapters = match platform.wlan_list() {
        Ok(state) => state.interfaces,
        Err(_) => {
            // Cannot read the WLAN state: touch nothing, say so for every profile.
            outcome.items = doc.wifi.iter().map(|profile| item(profile, FAILED, Some("wlan_unreadable"))).collect();
            return outcome;
        }
    };
    if adapters == 0 {
        // Edge case 33: no wireless adapter (a desktop, a VM). Not an error; managed-only is
        // not applied and nothing is written.
        outcome.items = doc.wifi.iter().map(|profile| item(profile, UNSUPPORTED, None)).collect();
        return outcome;
    }

    let mut keep: Vec<String> = Vec::new();
    for profile in &doc.wifi {
        let Some(name) = profile_name(&profile.id) else {
            outcome.items.push(item(profile, FAILED, Some("bad_profile_id")));
            continue;
        };
        // Whatever happens below, a profile the document still lists is not removed.
        keep.push(journal::wlan_profile_id(&name));
        let state = match install_profile(ctx, profile, &name) {
            Installed::Done(_) => item(profile, APPLIED, None),
            Installed::Waiting => item(profile, WAITING_FOR_KEY, None),
            Installed::Unsupported => item(profile, UNSUPPORTED, None),
            Installed::Failed(code) => item(profile, FAILED, Some(code)),
        };
        outcome.items.push(state);
    }

    // Profiles the journal owns that the document no longer lists are deleted.
    let gone: Vec<String> = profile_entry_ids(ctx).into_iter().filter(|id| !keep.contains(id)).collect();
    if !gone.is_empty() {
        let report = journal::restore_ids(&ctx.journal, &gone);
        if !report.failed.is_empty() {
            tracing::warn!("{} Wi-Fi profile(s) could not be deleted", report.failed.len());
        }
    }

    // Managed networks only.
    if doc.wifi_managed_only {
        let mut ssids: Vec<String> = doc.wifi.iter().map(|profile| profile.ssid.clone()).collect();
        ssids.sort();
        ssids.dedup();
        let change = Change::wlan_filters(ssids).since(ctx.version);
        if let Err(error) = journal::change(&ctx.journal, &change) {
            outcome.filters_error = Some(journal::error_code(&error));
            tracing::warn!("the Wi-Fi permit list could not be set ({})", journal::error_code(&error));
        }
    } else if has_filters_entry(ctx) {
        let report = journal::restore_ids(&ctx.journal, &[WLAN_FILTERS_ID.to_string()]);
        if !report.failed.is_empty() {
            outcome.filters_error = Some("filters_not_restored");
        }
    }
    outcome
}

#[cfg(test)]
mod tests;
