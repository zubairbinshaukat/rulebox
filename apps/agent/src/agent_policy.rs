//! The agent-only keys of the desired-state document (plan Section 5.10):
//! `adminExit`, `power` and `orgName`.
//!
//! They are **not** fields of `rulebox_policy::DesiredState`, so they never appear
//! in `AgentSnapshot.desiredState`. [`AgentPolicy::from_doc`] reads them from the raw
//! document; it is pure and never fails. The PIN hash stays inside
//! [`AdminExitPolicy`]: its `Debug` prints `<redacted>` and nothing here puts it in
//! the snapshot, a result or a log line.

use std::fmt;

use rulebox_ipc::hotkey::{self, DEFAULT_ADMIN_EXIT_HOTKEY};
use rulebox_ipc::types::{
    AdminExitInfo, AgentSnapshot, DeviceLockView, DisplayMode, DisplayModeSource, KeyboardView, NetworkView, PowerOptions,
    PrintingView,
};
use rulebox_policy::DisplayModeOverride;
use serde_json::Value;

use rulebox_policy::catalog::CatalogApp;
use rulebox_policy::lockdown::{KeyboardPolicy, WinCombos, MAX_ID_CHARS};
use rulebox_policy::network::{DriverSpec, MAX_DRIVERS, MAX_WIFI_PROFILES};
use rulebox_policy::notice::{Broadcast, DeviceLock, MAX_LOCK_CONTACT, MAX_LOCK_MESSAGE};

use crate::catalog::catalog_from_doc;
use crate::kdf;

/// `pinHash` is not a valid Argon2id hash (or is outside the limits of `kdf`).
pub const PROBLEM_PIN_INVALID: &str = "admin_exit_pin_invalid";
/// `hotkey` is not a valid key combination; the default is used.
pub const PROBLEM_HOTKEY_INVALID: &str = "admin_exit_hotkey_invalid";
/// `adminExit` or its `enabled` value has the wrong shape; the exit is off.
pub const PROBLEM_SETTINGS_INVALID: &str = "admin_exit_settings_invalid";

/// Longest `orgName`, in characters.
const MAX_ORG_NAME_CHARS: usize = 100;

#[derive(Clone, PartialEq, Eq)]
pub struct AdminExitPolicy {
    /// True only when a valid `pin_hash` is present and `"enabled"` is not false.
    pub enabled: bool,
    /// Always canonical and valid.
    pub hotkey: String,
    /// A hash that passed `kdf::check_hash`. `Debug` prints `<redacted>`.
    pub pin_hash: Option<String>,
    /// Why the settings were not usable, for the log and `status`.
    pub problem: Option<String>,
}

impl Default for AdminExitPolicy {
    fn default() -> Self {
        Self {
            enabled: false,
            hotkey: DEFAULT_ADMIN_EXIT_HOTKEY.to_string(),
            pin_hash: None,
            problem: None,
        }
    }
}

impl fmt::Debug for AdminExitPolicy {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AdminExitPolicy")
            .field("enabled", &self.enabled)
            .field("hotkey", &self.hotkey)
            .field("pin_hash", &self.pin_hash.as_ref().map(|_| "<redacted>"))
            .field("problem", &self.problem)
            .finish()
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AgentPolicy {
    pub admin_exit: AdminExitPolicy,
    /// `None` means "all three allowed" (also for a value of the wrong shape).
    pub power: Option<PowerOptions>,
    pub org_name: Option<String>,
    /// (Phase 4 Step 13) True when this policy comes from a verified document.
    pub has_document: bool,
    /// (Step 13) `doc.catalog`, usable entries only (`catalog.rs`). Never part of
    /// the snapshot or of `DesiredState`.
    pub catalog: Vec<CatalogApp>,
    /// (Step 13) `catalog_invalid` when `doc.catalog` was not a list.
    pub catalog_problem: Option<String>,
    /// (Step 13) `doc.rosterGroupId`: whose signed roster decides offline sign-in.
    pub roster_group_id: Option<String>,
    /// (Phase 5 Step 12) `doc.deviceLock`, text cut to the plan's limits. Never part of
    /// `DesiredState`; the snapshot carries only the lock view.
    pub device_lock: Option<DeviceLock>,
    /// (Step 12) `doc.broadcasts` as listed (expired ones included: only the notice hub
    /// knows the server time). Entries that do not parse or break the text limits are dropped.
    pub broadcasts: Vec<Broadcast>,
    /// (Step 12) `doc.lockdown.keyboard.winCombos`. `None` = no lockdown section, which means
    /// every layer off: Windows-key combinations pass.
    pub win_combos: Option<WinCombos>,
    /// (Step 12) `doc.printers` is not empty. (The Spooler check joins it with Step 14.)
    pub printers_assigned: bool,
    /// (Step 12) `doc.wifiManagedOnly`.
    pub wifi_managed_only: bool,
    /// (Step 12) The SSIDs of `doc.wifi`, for the status the Staff App shows.
    pub wifi_ssids: Vec<String>,
    /// (Step 14b) `doc.drivers`: driver packages the install engine puts on the PC. Entries that do not parse or break
    /// the size limits are dropped. Never a tile, never part of the snapshot.
    pub drivers: Vec<DriverSpec>,
    /// (Phase 6 Step 19, plan 4.14) `doc.displayMode`: the administrator's winner (device over group); `Auto` when absent.
    /// `Unknown` (a value a newer server adds) is `Auto`.
    pub display_override: DisplayModeOverride,
    /// (Step 19) Whose choice `display_override` is (`doc.displayModeSource`). `Auto` while there is no override.
    pub display_source: DisplayModeSource,
    /// (Step 19) `doc.webWindowCap`, only when within 1 to 12 (the signed document is refused as a whole otherwise).
    pub web_window_cap: Option<u32>,
    /// (Step 19) `doc.webIdleCloseMin`: 0 = off, else 5 to 240.
    pub web_idle_close_min: Option<u32>,
}

/// Defaults of plan 4.14 for the web window cap.
pub const LITE_WEB_WINDOW_CAP: u32 = 3;
pub const STANDARD_WEB_WINDOW_CAP: u32 = 8;
/// Lite closes an idle web window after this many minutes; Standard never does.
pub const LITE_IDLE_CLOSE_MIN: u32 = 30;

/// (Step 19, PRD 22.5) The display mode a PC uses: the device's choice, else the group's (the document carries the
/// winner and says whose it is), else what its RAM decides. `Auto` and `Unknown` overrides fall through to the RAM.
pub fn effective_display_mode(
    ram_mode: DisplayMode,
    over: DisplayModeOverride,
    source: DisplayModeSource,
) -> (DisplayMode, DisplayModeSource) {
    match over.effective() {
        DisplayModeOverride::Lite => (DisplayMode::Lite, source),
        DisplayModeOverride::Standard => (DisplayMode::Standard, source),
        _ => (ram_mode, DisplayModeSource::Auto),
    }
}

/// Parses the entries of a JSON list one by one, so one bad entry does not cost the others.
fn parse_list<T: serde::de::DeserializeOwned>(doc: &Value, key: &str) -> Vec<T> {
    let Some(entries) = doc.get(key).and_then(Value::as_array) else {
        return Vec::new();
    };
    entries
        .iter()
        .filter_map(|entry| match serde_json::from_value::<T>(entry.clone()) {
            Ok(parsed) => Some(parsed),
            Err(error) => {
                tracing::warn!(key, %error, "an entry of the document does not parse and is skipped");
                None
            }
        })
        .collect()
}

/// At most `max` characters.
fn cut(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

/// `doc.deviceLock`: a lock that does not parse as a whole is still a lock (fail closed), so a
/// missing `lockId` or text only loses what it cannot say; a value of the wrong type is no lock.
fn lock_from_doc(doc: &Value) -> Option<DeviceLock> {
    let value = doc.get("deviceLock").filter(|value| !value.is_null())?;
    let object = value.as_object()?;
    let text = |key: &str| object.get(key).and_then(Value::as_str);
    Some(DeviceLock {
        lock_id: cut(text("lockId").unwrap_or("lock"), MAX_ID_CHARS),
        message: cut(text("message").unwrap_or(""), MAX_LOCK_MESSAGE),
        contact: text("contact").map(str::trim).filter(|c| !c.is_empty()).map(|c| cut(c, MAX_LOCK_CONTACT)),
        locked_at_ms: object.get("lockedAtMs").and_then(Value::as_u64).unwrap_or(0),
    })
}

/// `doc.lockdown.keyboard.winCombos`.
fn win_combos_from_doc(doc: &Value) -> Option<WinCombos> {
    let lockdown = doc.get("lockdown").filter(|value| value.is_object())?;
    // A lockdown section without the key takes the policy default.
    Some(
        lockdown
            .get("keyboard")
            .and_then(|keyboard| keyboard.get("winCombos"))
            .and_then(|value| serde_json::from_value::<WinCombos>(value.clone()).ok())
            .unwrap_or(KeyboardPolicy::default().win_combos),
    )
}

/// `doc.displayMode`; a value of the wrong type is `Auto` (nothing is forced by a document that cannot be read).
fn display_override_of(doc: &Value) -> DisplayModeOverride {
    doc.get("displayMode")
        .and_then(|value| serde_json::from_value::<DisplayModeOverride>(value.clone()).ok())
        .map_or(DisplayModeOverride::Auto, DisplayModeOverride::effective)
}

/// `doc.displayModeSource` (`device` or `group`). An absent or unknown value is `Unknown`, which the Staff App reads as `Auto`.
fn display_source_of(doc: &Value) -> DisplayModeSource {
    match doc.get("displayModeSource").and_then(Value::as_str) {
        None => DisplayModeSource::Auto,
        Some("device") => DisplayModeSource::Device,
        Some("group") => DisplayModeSource::Group,
        Some(_) => DisplayModeSource::Unknown,
    }
}

/// A whole number of a document key inside `range`; anything else is `None` (the agent's default applies).
fn number_in(doc: &Value, key: &str, range: std::ops::RangeInclusive<u32>) -> Option<u32> {
    let number = doc.get(key)?.as_u64().and_then(|n| u32::try_from(n).ok())?;
    range.contains(&number).then_some(number)
}

impl AgentPolicy {
    /// (Phase 6 Step 19) Sets what depends on the PC's RAM: the effective display mode and where it came from, and the web
    /// window cap and idle close the Staff App enforces (the document's value, else the default of the effective mode).
    /// Run after `apply_to_snapshot`, whenever a policy is applied.
    pub fn apply_display(&self, snapshot: &mut AgentSnapshot, ram_mode: DisplayMode) {
        let (mode, source) = effective_display_mode(ram_mode, self.display_override, self.display_source);
        let lite = mode == DisplayMode::Lite;
        snapshot.display_mode = mode;
        snapshot.display_mode_source = source;
        snapshot.web_window_cap =
            Some(self.web_window_cap.unwrap_or(if lite { LITE_WEB_WINDOW_CAP } else { STANDARD_WEB_WINDOW_CAP }));
        snapshot.web_idle_close_min = Some(self.web_idle_close_min.unwrap_or(if lite { LITE_IDLE_CLOSE_MIN } else { 0 }));
    }

    /// No document, no `adminExit` key or no `pinHash` give an exit that is off and
    /// has no problem: there is no default PIN. A hash that fails
    /// `kdf::check_hash` turns the exit off with a problem (fail closed: a broken
    /// document must not keep an old PIN alive after a rotation).
    pub fn from_doc(doc: Option<&Value>) -> Self {
        let Some(doc) = doc else {
            return Self::default();
        };
        let (catalog, catalog_problem) = catalog_from_doc(doc);
        Self {
            has_document: true,
            catalog,
            catalog_problem,
            roster_group_id: doc.get("rosterGroupId").and_then(Value::as_str).map(str::to_string),
            device_lock: lock_from_doc(doc),
            broadcasts: parse_list::<Broadcast>(doc, "broadcasts")
                .into_iter()
                .filter(|broadcast| broadcast.check_limits().is_ok())
                .collect(),
            win_combos: win_combos_from_doc(doc),
            drivers: parse_list::<DriverSpec>(doc, "drivers")
                .into_iter()
                .take(MAX_DRIVERS)
                .filter(|driver| match driver.check_limits() {
                    Ok(()) => true,
                    Err(error) => {
                        tracing::warn!(%error, "a driver of the document breaks a size limit and is skipped");
                        false
                    }
                })
                .collect(),
            printers_assigned: doc.get("printers").and_then(Value::as_array).is_some_and(|list| !list.is_empty()),
            wifi_managed_only: doc.get("wifiManagedOnly").and_then(Value::as_bool).unwrap_or(false),
            wifi_ssids: doc
                .get("wifi")
                .and_then(Value::as_array)
                .map(|list| {
                    list.iter()
                        .filter_map(|profile| profile.get("ssid").and_then(Value::as_str))
                        .map(str::to_string)
                        .take(MAX_WIFI_PROFILES)
                        .collect()
                })
                .unwrap_or_default(),
            display_override: display_override_of(doc),
            display_source: display_source_of(doc),
            web_window_cap: number_in(doc, "webWindowCap", 1..=12),
            web_idle_close_min: number_in(doc, "webIdleCloseMin", 0..=240).filter(|min| *min == 0 || *min >= 5),
            admin_exit: AdminExitPolicy::from_value(doc.get("adminExit")),
            power: doc.get("power").and_then(|value| serde_json::from_value(value.clone()).ok()),
            org_name: doc
                .get("orgName")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|name| !name.is_empty() && name.chars().count() <= MAX_ORG_NAME_CHARS)
                .map(str::to_string),
        }
    }

    /// (Phase 5 Step 15, plan 4.17) At start: `persisted` is the lock of the newest accepted document
    /// (`AgentState.device_lock`). When the cached document is that document (`cache_is_newest`) the two
    /// agree and nothing changes; when the cache is missing, did not verify or is older, the persisted
    /// lock replaces whatever the cache said, so a lost cache never unlocks a PC.
    #[must_use]
    pub fn with_persisted_lock(mut self, persisted: Option<&DeviceLock>, cache_is_newest: bool) -> Self {
        if !cache_is_newest {
            self.device_lock = persisted.cloned();
        }
        self
    }

    /// Sets the protocol 1.1 snapshot fields. The hash, its salt and the failure
    /// counter are never part of the snapshot.
    pub fn apply_to_snapshot(&self, snapshot: &mut AgentSnapshot) {
        snapshot.admin_exit = Some(AdminExitInfo {
            enabled: self.admin_exit.enabled,
            hotkey: self.admin_exit.hotkey.clone(),
        });
        snapshot.power = self.power;
        snapshot.org_name = self.org_name.clone();
        // (1.3) Nothing secret: the lock's text, the keyboard mode and two status flags. The
        // broadcast list is the notice hub's (it knows the server time and the acknowledgements).
        snapshot.device_lock = self.device_lock.as_ref().map(|lock| DeviceLockView {
            lock_id: lock.lock_id.clone(),
            message: lock.message.clone(),
            contact: lock.contact.clone(),
        });
        snapshot.keyboard = Some(KeyboardView { win_combos: self.win_combos.unwrap_or(WinCombos::Pass) });
        snapshot.printing = Some(PrintingView { available: self.printers_assigned });
        snapshot.network = Some(NetworkView { managed_only: self.wifi_managed_only, ssids: self.wifi_ssids.clone() });
    }
}

impl AdminExitPolicy {
    fn from_value(value: Option<&Value>) -> Self {
        let mut policy = Self::default();
        let Some(value) = value.filter(|value| !value.is_null()) else {
            return policy;
        };
        let Some(object) = value.as_object() else {
            tracing::error!("the \"adminExit\" setting is not an object; the admin exit is off");
            policy.problem = Some(PROBLEM_SETTINGS_INVALID.to_string());
            return policy;
        };

        let mut problem: Option<&'static str> = None;

        // `enabled`: optional, default true. A value that is not a boolean fails closed.
        let explicitly_disabled = match object.get("enabled") {
            None | Some(Value::Null) => false,
            Some(Value::Bool(enabled)) => !enabled,
            Some(_) => {
                tracing::error!("\"adminExit.enabled\" is not a boolean; the admin exit is off");
                problem = Some(PROBLEM_SETTINGS_INVALID);
                true
            }
        };

        // `hotkey`: optional; an unusable one gives the default.
        match object.get("hotkey") {
            None | Some(Value::Null) => {}
            Some(Value::String(text)) => match hotkey::parse(text) {
                Ok(parsed) => policy.hotkey = parsed.canonical(),
                Err(error) => {
                    tracing::warn!("\"adminExit.hotkey\" is not usable ({error}); using the default");
                    problem = Some(PROBLEM_HOTKEY_INVALID);
                }
            },
            Some(_) => {
                tracing::warn!("\"adminExit.hotkey\" is not a string; using the default");
                problem = Some(PROBLEM_HOTKEY_INVALID);
            }
        }

        // `pinHash`: optional; there is no default PIN. An organization that turned
        // the exit off on purpose is not told its hash is broken.
        match object.get("pinHash") {
            None | Some(Value::Null) => {}
            Some(Value::String(hash)) => match kdf::check_hash(hash) {
                Ok(()) => policy.pin_hash = Some(hash.clone()),
                Err(error) => {
                    if !explicitly_disabled {
                        tracing::error!("the exit PIN hash is not valid ({error}); the admin exit is off");
                        problem = Some(PROBLEM_PIN_INVALID);
                    }
                }
            },
            Some(_) => {
                if !explicitly_disabled {
                    tracing::error!("the exit PIN hash is not a string; the admin exit is off");
                    problem = Some(PROBLEM_PIN_INVALID);
                }
            }
        }

        policy.enabled = !explicitly_disabled && policy.pin_hash.is_some();
        policy.problem = problem.map(str::to_string);
        policy
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::OnceLock;

    use crate::testutil::test_snapshot;

    /// One real hash for every test in this file (hashing is the slow part).
    pub(crate) fn pin_hash_2468() -> &'static str {
        static HASH: OnceLock<String> = OnceLock::new();
        HASH.get_or_init(|| kdf::hash_secret("2468").unwrap())
    }

    fn doc(admin_exit: Value) -> Value {
        json!({ "adminExit": admin_exit })
    }

    #[test]
    fn drivers_are_read_one_by_one_and_a_bad_one_is_skipped() {
        let good = |id: &str| {
            json!({ "id": id, "name": "Brother", "kind": "inf", "url": "https://example.com/b.zip", "sha256": "a".repeat(64),
                    "sizeBytes": 10, "inf": "x64/b.inf", "silentArgs": [], "successExitCodes": [], "revision": 2 })
        };
        let long_name = json!({ "id": "long", "name": "x".repeat(61), "kind": "exe", "url": "https://e.com/x", "sha256": "a".repeat(64),
                                 "sizeBytes": 1, "inf": null, "silentArgs": ["/S"], "successExitCodes": [0], "revision": 1 });
        let document = json!({ "drivers": [good("d1"), { "id": 5 }, long_name, good("d2")] });
        let policy = AgentPolicy::from_doc(Some(&document));
        assert_eq!(policy.drivers.iter().map(|d| d.id.as_str()).collect::<Vec<_>>(), ["d1", "d2"]);
        assert_eq!(policy.drivers[0].revision, 2);
        // An unknown kind parses as Unknown (the engine reports it unsupported); an absent key means none.
        let mut odd = good("d3");
        odd["kind"] = json!("usb-fairy");
        let policy = AgentPolicy::from_doc(Some(&json!({ "drivers": [odd] })));
        assert_eq!(policy.drivers[0].kind, rulebox_policy::network::DriverKind::Unknown);
        assert!(AgentPolicy::from_doc(Some(&json!({}))).drivers.is_empty());
        assert!(AgentPolicy::from_doc(Some(&json!({ "drivers": "no" }))).drivers.is_empty());
    }

    #[test]
    fn missing_pieces_mean_off_without_a_problem() {
        let off = AgentPolicy::from_doc(None);
        assert!(!off.admin_exit.enabled && off.admin_exit.problem.is_none());
        assert_eq!(off.admin_exit.hotkey, DEFAULT_ADMIN_EXIT_HOTKEY);
        assert_eq!(off, AgentPolicy::default());

        for document in [json!({}), doc(json!({})), doc(json!({ "enabled": true })), doc(json!({ "hotkey": "Ctrl+Alt+K" }))] {
            let policy = AgentPolicy::from_doc(Some(&document));
            assert!(!policy.admin_exit.enabled, "{document}");
            assert_eq!(policy.admin_exit.problem, None, "{document}");
            assert_eq!(policy.admin_exit.pin_hash, None);
        }
        // A custom hotkey is kept even while no PIN is set.
        let policy = AgentPolicy::from_doc(Some(&doc(json!({ "hotkey": "ctrl+alt+k" }))));
        assert_eq!(policy.admin_exit.hotkey, "Ctrl+Alt+K");
    }

    #[test]
    fn a_valid_hash_turns_the_exit_on_unless_disabled() {
        let hash = pin_hash_2468();
        let on = AgentPolicy::from_doc(Some(&doc(json!({ "pinHash": hash }))));
        assert!(on.admin_exit.enabled);
        assert_eq!(on.admin_exit.pin_hash.as_deref(), Some(hash));
        assert_eq!(on.admin_exit.hotkey, "Ctrl+Shift+F12");
        assert_eq!(on.admin_exit.problem, None);

        let explicit = AgentPolicy::from_doc(Some(&doc(json!({ "enabled": true, "pinHash": hash }))));
        assert!(explicit.admin_exit.enabled);

        let disabled = AgentPolicy::from_doc(Some(&doc(json!({ "enabled": false, "pinHash": hash }))));
        assert!(!disabled.admin_exit.enabled);
        assert_eq!(disabled.admin_exit.problem, None);
    }

    #[test]
    fn a_bad_hash_fails_closed_with_a_problem() {
        for bad in [json!("garbage"), json!(""), json!(5), json!(["x"])] {
            let policy = AgentPolicy::from_doc(Some(&doc(json!({ "pinHash": bad.clone() }))));
            assert!(!policy.admin_exit.enabled, "{bad}");
            assert_eq!(policy.admin_exit.problem.as_deref(), Some("admin_exit_pin_invalid"), "{bad}");
            assert_eq!(policy.admin_exit.pin_hash, None);
        }
        // Parameters outside the limits of `kdf` are refused too.
        let huge = "$argon2id$v=19$m=1048576,t=2,p=1$c29tZXNhbHRzb21l$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g";
        let policy = AgentPolicy::from_doc(Some(&doc(json!({ "pinHash": huge }))));
        assert!(!policy.admin_exit.enabled);
        assert_eq!(policy.admin_exit.problem.as_deref(), Some(PROBLEM_PIN_INVALID));
    }

    #[test]
    fn a_bad_hotkey_gives_the_default_and_a_problem() {
        let hash = pin_hash_2468();
        for bad in [json!("Alt+Tab"), json!("Ctrl+Alt+Del"), json!("F12"), json!(""), json!(7)] {
            let policy = AgentPolicy::from_doc(Some(&doc(json!({ "pinHash": hash, "hotkey": bad.clone() }))));
            assert!(policy.admin_exit.enabled, "{bad}: only the hotkey is wrong");
            assert_eq!(policy.admin_exit.hotkey, DEFAULT_ADMIN_EXIT_HOTKEY, "{bad}");
            assert_eq!(policy.admin_exit.problem.as_deref(), Some("admin_exit_hotkey_invalid"), "{bad}");
        }
        let canonical = AgentPolicy::from_doc(Some(&doc(json!({ "pinHash": hash, "hotkey": "ctrl+alt+shift+r" }))));
        assert_eq!(canonical.admin_exit.hotkey, "Ctrl+Alt+Shift+R");
        assert_eq!(canonical.admin_exit.problem, None);
        // A bad hash outranks a bad hotkey in the reported problem.
        let both = AgentPolicy::from_doc(Some(&doc(json!({ "pinHash": "x", "hotkey": "Alt+Tab" }))));
        assert_eq!(both.admin_exit.problem.as_deref(), Some(PROBLEM_PIN_INVALID));
    }

    #[test]
    fn a_setting_of_the_wrong_shape_fails_closed() {
        let hash = pin_hash_2468();
        let not_object = AgentPolicy::from_doc(Some(&doc(json!("on"))));
        assert!(!not_object.admin_exit.enabled);
        assert_eq!(not_object.admin_exit.problem.as_deref(), Some(PROBLEM_SETTINGS_INVALID));

        let not_bool = AgentPolicy::from_doc(Some(&doc(json!({ "enabled": "yes", "pinHash": hash }))));
        assert!(!not_bool.admin_exit.enabled);
        assert_eq!(not_bool.admin_exit.problem.as_deref(), Some(PROBLEM_SETTINGS_INVALID));
    }

    #[test]
    fn power_and_org_name_pass_through_and_bad_values_are_none() {
        let document = json!({
            "power": { "sleep": true, "restart": false, "shutDown": true },
            "orgName": "Demo Company"
        });
        let policy = AgentPolicy::from_doc(Some(&document));
        assert_eq!(policy.power, Some(PowerOptions { sleep: true, restart: false, shut_down: true }));
        assert_eq!(policy.org_name.as_deref(), Some("Demo Company"));

        let long = "x".repeat(101);
        let exact = "y".repeat(100);
        assert_eq!(AgentPolicy::from_doc(Some(&json!({ "orgName": long }))).org_name, None);
        assert_eq!(AgentPolicy::from_doc(Some(&json!({ "orgName": exact.clone() }))).org_name, Some(exact));
        for bad in [json!({ "orgName": 5 }), json!({ "orgName": "   " }), json!({ "orgName": null })] {
            assert_eq!(AgentPolicy::from_doc(Some(&bad)).org_name, None, "{bad}");
        }
        for bad in [json!("all"), json!({ "sleep": true }), json!({ "sleep": 1, "restart": 1, "shutDown": 1 }), json!(null)] {
            let policy = AgentPolicy::from_doc(Some(&json!({ "power": bad.clone() })));
            assert_eq!(policy.power, None, "{bad}");
        }
    }

    #[test]
    fn the_snapshot_gets_the_fields_and_never_the_hash() {
        let hash = pin_hash_2468();
        let document = json!({
            "adminExit": { "pinHash": hash, "hotkey": "Ctrl+Alt+K" },
            "power": { "sleep": true, "restart": true, "shutDown": false },
            "orgName": "Org"
        });
        let policy = AgentPolicy::from_doc(Some(&document));
        let mut snapshot = test_snapshot();
        policy.apply_to_snapshot(&mut snapshot);
        assert_eq!(snapshot.admin_exit, Some(AdminExitInfo { enabled: true, hotkey: "Ctrl+Alt+K".into() }));
        assert_eq!(snapshot.power, Some(PowerOptions { sleep: true, restart: true, shut_down: false }));
        assert_eq!(snapshot.org_name.as_deref(), Some("Org"));

        // No leak: not in the snapshot JSON, not in `Debug` of the policy.
        let wire = serde_json::to_string(&snapshot).unwrap();
        let salt_and_hash = hash.rsplit('$').next().unwrap();
        for text in [wire, format!("{policy:?}"), format!("{:#?}", policy.admin_exit)] {
            for needle in ["pinHash", "$argon2", hash, salt_and_hash] {
                assert!(!text.contains(needle), "{needle:?} leaked into {text}");
            }
        }
        assert!(format!("{policy:?}").contains("<redacted>"));
    }
}
