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
use rulebox_ipc::types::{AdminExitInfo, AgentSnapshot, PowerOptions};
use serde_json::Value;

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
}

impl AgentPolicy {
    /// No document, no `adminExit` key or no `pinHash` give an exit that is off and
    /// has no problem: there is no default PIN. A hash that fails
    /// `kdf::check_hash` turns the exit off with a problem (fail closed: a broken
    /// document must not keep an old PIN alive after a rotation).
    pub fn from_doc(doc: Option<&Value>) -> Self {
        let Some(doc) = doc else {
            return Self::default();
        };
        Self {
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

    /// Sets the protocol 1.1 snapshot fields. The hash, its salt and the failure
    /// counter are never part of the snapshot.
    pub fn apply_to_snapshot(&self, snapshot: &mut AgentSnapshot) {
        snapshot.admin_exit = Some(AdminExitInfo {
            enabled: self.admin_exit.enabled,
            hotkey: self.admin_exit.hotkey.clone(),
        });
        snapshot.power = self.power;
        snapshot.org_name = self.org_name.clone();
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
