//! Wi-Fi profiles and the managed-networks filter (plan 4.5, 4.15, Step 14).
//!
//! Rules checked before the guard and before any API call:
//!
//! - Rulebox only ever writes or deletes profiles named `Rulebox-<id>`, so it never
//!   touches a profile the owner or another tool made;
//! - an SSID is 1 to 32 bytes; the filter list holds at most [`MAX_FILTER_SSIDS`].
//!
//! A profile is stored **for all users** (flags 0) on every wireless interface, so it
//! works before any sign-in. The XML carries the passphrase (`protected = false`); this
//! module never logs or returns it.

use std::collections::BTreeSet;

use windows::core::{GUID, PCWSTR};
use windows::Win32::Foundation::{ERROR_NOT_FOUND, ERROR_SERVICE_NOT_ACTIVE, ERROR_SUCCESS, HANDLE};
use windows::Win32::NetworkManagement::WiFi::{
    dot11_BSS_type_infrastructure, wlan_filter_list_type_user_permit, WlanCloseHandle, WlanDeleteProfile,
    WlanEnumInterfaces, WlanFreeMemory, WlanGetFilterList, WlanGetProfileList, WlanOpenHandle, WlanSetFilterList,
    WlanSetProfile, DOT11_NETWORK, DOT11_NETWORK_LIST, WLAN_API_VERSION_2_0, WLAN_INTERFACE_INFO_LIST,
    WLAN_PROFILE_INFO_LIST,
};

use crate::error::{code_err, Result, Win32Error};
use crate::guard::require_test_machine;
use crate::util::to_wide;

/// The prefix of every profile Rulebox owns.
pub const PROFILE_PREFIX: &str = "Rulebox-";
/// More allowed networks than this are refused (plan 4.3 limits the document anyway).
pub const MAX_FILTER_SSIDS: usize = 20;

/// What `list` reads.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct WlanState {
    /// Wireless interfaces found.
    pub interfaces: usize,
    /// Every profile name (not only Rulebox's), sorted, without duplicates.
    pub profiles: Vec<String>,
    /// The SSIDs of the user permit list; empty when there is none.
    pub allowed_ssids: Vec<String>,
}

/// A WLAN client handle closed on drop.
struct Client(HANDLE);

impl Drop for Client {
    fn drop(&mut self) {
        // SAFETY: the handle came from WlanOpenHandle, is owned by this value and closed once.
        unsafe {
            let _ = WlanCloseHandle(self.0, None);
        }
    }
}

/// The memory of one WLAN list, freed on drop.
struct WlanMemory(*const std::ffi::c_void);

impl Drop for WlanMemory {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: the pointer came from a Wlan API that documents WlanFreeMemory; freed once.
            unsafe { WlanFreeMemory(self.0) };
        }
    }
}

/// `Ok(None)` when the WLAN service is not running (no wireless adapter, a server).
fn open() -> Result<Option<Client>> {
    let mut negotiated = 0u32;
    let mut handle = HANDLE::default();
    // SAFETY: both out pointers are valid.
    let status = unsafe { WlanOpenHandle(WLAN_API_VERSION_2_0, None, &mut negotiated, &mut handle) };
    if status == ERROR_SERVICE_NOT_ACTIVE.0 {
        return Ok(None);
    }
    if status != ERROR_SUCCESS.0 {
        return Err(code_err("WlanOpenHandle", status));
    }
    Ok(Some(Client(handle)))
}

fn interface_guids(client: &Client) -> Result<Vec<GUID>> {
    let mut list: *mut WLAN_INTERFACE_INFO_LIST = std::ptr::null_mut();
    // SAFETY: the client handle is open; `list` is a valid out pointer.
    let status = unsafe { WlanEnumInterfaces(client.0, None, &mut list) };
    if status != ERROR_SUCCESS.0 {
        return Err(code_err("WlanEnumInterfaces", status));
    }
    let _memory = WlanMemory(list.cast_const().cast());
    // SAFETY: on success `list` points at a header followed by `dwNumberOfItems` entries,
    // valid until WlanFreeMemory.
    let (count, first) = unsafe { ((*list).dwNumberOfItems as usize, std::ptr::addr_of!((*list).InterfaceInfo)) };
    let first = first.cast::<windows::Win32::NetworkManagement::WiFi::WLAN_INTERFACE_INFO>();
    // SAFETY: entry `i < count` is inside the list.
    Ok((0..count).map(|i| unsafe { (*first.add(i)).InterfaceGuid }).collect())
}

fn utf16_name(units: &[u16]) -> String {
    let end = units.iter().position(|&u| u == 0).unwrap_or(units.len());
    String::from_utf16_lossy(&units[..end])
}

fn ssid_text(network: &DOT11_NETWORK) -> String {
    let len = (network.dot11Ssid.uSSIDLength as usize).min(32);
    String::from_utf8_lossy(&network.dot11Ssid.ucSSID[..len]).into_owned()
}

/// Reads the interfaces, profile names and the user permit list. Read-only. A PC without
/// the WLAN service answers an empty state.
pub fn list() -> Result<WlanState> {
    let Some(client) = open()? else {
        return Ok(WlanState::default());
    };
    let guids = interface_guids(&client)?;
    let mut names = BTreeSet::new();
    for guid in &guids {
        let mut profiles: *mut WLAN_PROFILE_INFO_LIST = std::ptr::null_mut();
        // SAFETY: the client handle is open; `guid` and `profiles` are valid pointers.
        let status = unsafe { WlanGetProfileList(client.0, guid, None, &mut profiles) };
        if status != ERROR_SUCCESS.0 {
            return Err(code_err("WlanGetProfileList", status));
        }
        let _memory = WlanMemory(profiles.cast_const().cast());
        // SAFETY: as for the interface list: a header and `dwNumberOfItems` entries.
        let (count, first) =
            unsafe { ((*profiles).dwNumberOfItems as usize, std::ptr::addr_of!((*profiles).ProfileInfo)) };
        let first = first.cast::<windows::Win32::NetworkManagement::WiFi::WLAN_PROFILE_INFO>();
        for i in 0..count {
            // SAFETY: entry `i < count` is inside the list.
            names.insert(utf16_name(unsafe { &(*first.add(i)).strProfileName }));
        }
    }

    let mut networks: *mut DOT11_NETWORK_LIST = std::ptr::null_mut();
    // SAFETY: the client handle is open; `networks` is a valid out pointer.
    let status = unsafe { WlanGetFilterList(client.0, wlan_filter_list_type_user_permit, None, &mut networks) };
    let mut allowed = Vec::new();
    if status == ERROR_SUCCESS.0 && !networks.is_null() {
        let _memory = WlanMemory(networks.cast_const().cast());
        // SAFETY: a header followed by `dwNumberOfItems` DOT11_NETWORK entries.
        let (count, first) =
            unsafe { ((*networks).dwNumberOfItems as usize, std::ptr::addr_of!((*networks).Network)) };
        let first = first.cast::<DOT11_NETWORK>();
        for i in 0..count {
            // SAFETY: entry `i < count` is inside the list.
            allowed.push(ssid_text(unsafe { &*first.add(i) }));
        }
    } else if status != ERROR_SUCCESS.0 && status != ERROR_NOT_FOUND.0 {
        return Err(code_err("WlanGetFilterList", status));
    }
    Ok(WlanState { interfaces: guids.len(), profiles: names.into_iter().collect(), allowed_ssids: allowed })
}

/// The name inside `<WLANProfile><name>..</name>`, when it is one of Rulebox's.
pub fn check_profile_xml(xml: &str) -> Result<String> {
    let name = xml
        .split_once("<name>")
        .and_then(|(_, rest)| rest.split_once("</name>"))
        .map(|(name, _)| name.trim().to_string())
        .unwrap_or_default();
    check_profile_name(&name)?;
    Ok(name)
}

/// Rulebox only touches its own profiles.
pub fn check_profile_name(name: &str) -> Result<()> {
    let own = name.len() > PROFILE_PREFIX.len()
        && name.len() <= 255
        && name.starts_with(PROFILE_PREFIX)
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    if own {
        Ok(())
    } else {
        Err(Win32Error::Forbidden(format!("{name:?} is not a Rulebox Wi-Fi profile name")))
    }
}

/// The rules of [`set_filters`] (no API call, no guard).
pub fn check_filters(ssids: &[&str]) -> Result<()> {
    if ssids.len() > MAX_FILTER_SSIDS {
        return Err(Win32Error::Forbidden(format!("more than {MAX_FILTER_SSIDS} allowed networks")));
    }
    if ssids.iter().any(|ssid| ssid.is_empty() || ssid.len() > 32) {
        return Err(Win32Error::Forbidden("an SSID is 1 to 32 bytes".into()));
    }
    Ok(())
}

/// Stores a profile for all users on every wireless interface (replacing one of the
/// same name). The profile name must start with `Rulebox-`.
///
/// DESTRUCTIVE: guarded.
pub fn set_profile(xml_with_key: &str) -> Result<()> {
    check_profile_xml(xml_with_key)?;
    require_test_machine()?;
    let client = open()?.ok_or(Win32Error::NotFound)?;
    let guids = interface_guids(&client)?;
    if guids.is_empty() {
        return Err(Win32Error::NotFound);
    }
    let xml = to_wide(xml_with_key);
    for guid in &guids {
        let mut reason = 0u32;
        // SAFETY: the client handle is open; `xml` is NUL-terminated and outlives the call;
        // flags 0 = an all-user profile; a null security string means the default.
        let status = unsafe {
            WlanSetProfile(client.0, guid, 0, PCWSTR(xml.as_ptr()), PCWSTR::null(), true, None, &mut reason)
        };
        if status != ERROR_SUCCESS.0 {
            return Err(code_err("WlanSetProfile", status));
        }
    }
    Ok(())
}

/// Deletes the profile `name` (must start with `Rulebox-`) from every interface. A profile
/// that is not there is fine.
///
/// DESTRUCTIVE: guarded.
pub fn delete_profile(name: &str) -> Result<()> {
    check_profile_name(name)?;
    require_test_machine()?;
    let Some(client) = open()? else {
        return Ok(());
    };
    let wide = to_wide(name);
    for guid in &interface_guids(&client)? {
        // SAFETY: the client handle is open; `wide` is NUL-terminated and outlives the call.
        let status = unsafe { WlanDeleteProfile(client.0, guid, PCWSTR(wide.as_ptr()), None) };
        if status != ERROR_SUCCESS.0 && status != ERROR_NOT_FOUND.0 {
            return Err(code_err("WlanDeleteProfile", status));
        }
    }
    Ok(())
}

/// Sets the user permit list to `ssids` (only these networks can be seen and joined); an
/// empty list removes the filter.
///
/// DESTRUCTIVE: guarded.
pub fn set_filters(ssids: &[&str]) -> Result<()> {
    check_filters(ssids)?;
    require_test_machine()?;
    let client = open()?.ok_or(Win32Error::NotFound)?;
    if ssids.is_empty() {
        // SAFETY: the client handle is open; no list removes the filter.
        let status = unsafe { WlanSetFilterList(client.0, wlan_filter_list_type_user_permit, None, None) };
        return if status == ERROR_SUCCESS.0 { Ok(()) } else { Err(code_err("WlanSetFilterList", status)) };
    }
    // A DOT11_NETWORK_LIST is a header followed by the entries: build it in one block.
    let entry = std::mem::size_of::<DOT11_NETWORK>();
    let header = std::mem::size_of::<DOT11_NETWORK_LIST>() - entry;
    let mut block = vec![0u64; (header + entry * ssids.len()).div_ceil(8)];
    let list = block.as_mut_ptr().cast::<DOT11_NETWORK_LIST>();
    // SAFETY: `block` is zeroed, 8-byte aligned and large enough for the header and
    // `ssids.len()` entries; every write is inside it.
    unsafe {
        (*list).dwNumberOfItems = ssids.len() as u32;
        (*list).dwIndex = 0;
        let first = std::ptr::addr_of_mut!((*list).Network).cast::<DOT11_NETWORK>();
        for (i, ssid) in ssids.iter().enumerate() {
            let network = &mut *first.add(i);
            network.dot11Ssid.uSSIDLength = ssid.len() as u32;
            network.dot11Ssid.ucSSID[..ssid.len()].copy_from_slice(ssid.as_bytes());
            network.dot11BssType = dot11_BSS_type_infrastructure;
        }
    }
    // SAFETY: the client handle is open; `list` points at a complete list inside `block`.
    let status = unsafe {
        WlanSetFilterList(client.0, wlan_filter_list_type_user_permit, Some(list.cast_const()), None)
    };
    if status == ERROR_SUCCESS.0 {
        Ok(())
    } else {
        Err(code_err("WlanSetFilterList", status))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const XML: &str = "<?xml version=\"1.0\"?><WLANProfile xmlns=\"http://www.microsoft.com/networking/WLAN/profile/v1\"><name>Rulebox-ab12</name><SSIDConfig/></WLANProfile>";

    #[test]
    fn only_rulebox_profiles_pass() {
        assert_eq!(check_profile_xml(XML).unwrap(), "Rulebox-ab12");
        for bad in [
            "<WLANProfile><name>HomeWifi</name></WLANProfile>",
            "<WLANProfile><name>Rulebox-</name></WLANProfile>",
            "<WLANProfile><name>rulebox-ab</name></WLANProfile>",
            "<WLANProfile><name>Rulebox-a b</name></WLANProfile>",
            "<WLANProfile></WLANProfile>",
            "",
        ] {
            assert!(matches!(check_profile_xml(bad), Err(Win32Error::Forbidden(_))), "{bad}");
        }
        assert!(matches!(delete_profile("HomeWifi"), Err(Win32Error::Forbidden(_))));
        assert!(matches!(set_profile("<WLANProfile><name>HomeWifi</name></WLANProfile>"), Err(Win32Error::Forbidden(_))));
    }

    #[test]
    fn filter_limits() {
        assert!(check_filters(&[]).is_ok());
        assert!(check_filters(&["Acme"]).is_ok());
        assert!(check_filters(&[""]).is_err());
        assert!(check_filters(&[&"x".repeat(33)]).is_err());
        let many: Vec<&str> = vec!["a"; MAX_FILTER_SSIDS + 1];
        assert!(matches!(set_filters(&many), Err(Win32Error::Forbidden(_))));
    }

    #[test]
    fn writers_meet_the_guard_on_the_dev_machine() {
        if crate::guard::is_test_machine() {
            return;
        }
        assert!(matches!(set_profile(XML), Err(Win32Error::Guard(_))));
        assert!(matches!(delete_profile("Rulebox-ab12"), Err(Win32Error::Guard(_))));
        assert!(matches!(set_filters(&["Acme"]), Err(Win32Error::Guard(_))));
        assert!(matches!(set_filters(&[]), Err(Win32Error::Guard(_))));
    }

    #[test]
    fn utf16_names_stop_at_the_nul() {
        assert_eq!(utf16_name(&[b'A' as u16, b'b' as u16, 0, b'x' as u16]), "Ab");
        assert_eq!(utf16_name(&[b'A' as u16]), "A");
    }

    /// Reads the real WLAN state; never writes. Run by hand.
    #[test]
    #[ignore = "reads the real WLAN service"]
    fn smoke_list() {
        let state = list().unwrap();
        println!("{state:?}");
    }
}
