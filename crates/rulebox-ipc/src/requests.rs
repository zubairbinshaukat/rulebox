//! Protocol 1.1 request and result types (plan Section 6.11): employee session,
//! app catalogue and the hidden admin exit.
//!
//! These types are **not** exported to TypeScript: the Staff App keeps IPC on its
//! Rust side and defines its own DTOs (`Employee`, `AppEntry`, ...) for the webview.
//!
//! Rules that hold for every type here:
//! - fields that do not apply are sent as `null` (or `false`); a reader treats a
//!   missing field and `null` alike, so `Option` and `bool` fields of results
//!   carry `#[serde(default)]`;
//! - every enum maps an unknown string to `Unknown` (`unknown_on_new_values!`);
//! - the params types that carry a secret have a hand-written `Debug` that never
//!   prints it, so a stray `{:?}` cannot leak a password or PIN.

use std::fmt;

use serde::{Deserialize, Serialize};

/// Parameters of `session.signIn`.
#[derive(Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SignInParams {
    pub username: String,
    pub password: String,
}

impl fmt::Debug for SignInParams {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SignInParams")
            .field("username", &self.username)
            .field("password", &"<redacted>")
            .finish()
    }
}

/// Result of `session.signIn`. A wrong password, a lockout and the like are
/// outcomes here, never RPC errors.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SignInResult {
    pub outcome: SignInOutcome,
    #[serde(default)]
    pub employee: Option<Employee>,
    #[serde(default)]
    pub files_root: Option<String>,
    #[serde(default)]
    pub offline: bool,
    #[serde(default)]
    pub retry_after_ms: Option<u64>,
}

#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SignInOutcome {
    Ok,
    WrongCredentials,
    Disabled,
    LockedOut,
    OfflineNeverSignedIn,
    OfflineExpired,
    Unknown,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Employee {
    pub id: String,
    pub username: String,
    pub name: String,
    #[serde(default)]
    pub role: Option<String>,
    pub quota_bytes: u64,
}

/// Result of `session.get`.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionGetResult {
    #[serde(default)]
    pub employee: Option<Employee>,
    #[serde(default)]
    pub files_root: Option<String>,
    #[serde(default)]
    pub offline: bool,
}

/// Parameters of `session.verifyPassword`.
#[derive(Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VerifyPasswordParams {
    pub password: String,
}

impl fmt::Debug for VerifyPasswordParams {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("VerifyPasswordParams").field("password", &"<redacted>").finish()
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VerifyPasswordResult {
    pub outcome: VerifyOutcome,
    #[serde(default)]
    pub retry_after_ms: Option<u64>,
}

#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum VerifyOutcome {
    Ok,
    WrongCredentials,
    LockedOut,
    Unknown,
}

/// Result of `apps.list`.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppsListResult {
    pub apps: Vec<AppEntry>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppEntry {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    pub kind: AppKind,
    /// Set when `kind` is `builtin`.
    #[serde(default)]
    pub builtin: Option<BuiltinApp>,
    /// Set when `kind` is `web`.
    #[serde(default)]
    pub web: Option<WebApp>,
    /// Set when `kind` is `desktop`.
    #[serde(default)]
    pub desktop: Option<DesktopApp>,
    #[serde(default)]
    pub pinned_taskbar: bool,
    #[serde(default)]
    pub pinned_desktop: bool,
    #[serde(default)]
    pub icon_png_base64: Option<String>,
    #[serde(default)]
    pub hue: Option<u16>,
}

/// A client that reads `Unknown` skips that app.
#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AppKind {
    Builtin,
    Web,
    Desktop,
    Unknown,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BuiltinApp {
    /// `"files"` is the only tool today.
    pub tool: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WebApp {
    pub url: String,
    pub allowed_domains: Vec<String>,
    pub permissions: WebPermissions,
}

/// PRD 24.1: a web app may show notifications and download files by default;
/// everything else is off until the organization allows it.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct WebPermissions {
    pub camera: bool,
    pub microphone: bool,
    pub screen_share: bool,
    pub clipboard_read: bool,
    pub notifications: bool,
    pub downloads: bool,
    pub printing: bool,
    pub geolocation: bool,
}

impl Default for WebPermissions {
    fn default() -> Self {
        Self {
            camera: false,
            microphone: false,
            screen_share: false,
            clipboard_read: false,
            notifications: true,
            downloads: true,
            printing: false,
            geolocation: false,
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopApp {
    pub exe: String,
    pub args: Vec<String>,
    pub file_arg_template: Vec<String>,
}

/// Parameters of `adminExit.submit`.
#[derive(Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AdminExitSubmitParams {
    pub pin: String,
}

impl fmt::Debug for AdminExitSubmitParams {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AdminExitSubmitParams").field("pin", &"<redacted>").finish()
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AdminExitSubmitResult {
    pub outcome: AdminExitOutcome,
    #[serde(default)]
    pub attempts_left: Option<u32>,
    #[serde(default)]
    pub retry_after_ms: Option<u64>,
}

#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AdminExitOutcome {
    SigningOut,
    WrongPin,
    LockedOut,
    Disabled,
    Unknown,
}

unknown_on_new_values!(SignInOutcome {
    Ok => "ok",
    WrongCredentials => "wrongCredentials",
    Disabled => "disabled",
    LockedOut => "lockedOut",
    OfflineNeverSignedIn => "offlineNeverSignedIn",
    OfflineExpired => "offlineExpired",
});
unknown_on_new_values!(VerifyOutcome {
    Ok => "ok",
    WrongCredentials => "wrongCredentials",
    LockedOut => "lockedOut",
});
unknown_on_new_values!(AppKind {
    Builtin => "builtin",
    Web => "web",
    Desktop => "desktop",
});
unknown_on_new_values!(AdminExitOutcome {
    SigningOut => "signingOut",
    WrongPin => "wrongPin",
    LockedOut => "lockedOut",
    Disabled => "disabled",
});

#[cfg(test)]
mod tests {
    use super::*;
    use serde::de::DeserializeOwned;
    use serde_json::{json, Value};

    /// Parses `value` as `T`, serializes it back and expects the same JSON.
    fn golden<T: Serialize + DeserializeOwned + fmt::Debug>(value: Value) -> T {
        let parsed: T = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(&parsed).unwrap(), value, "{parsed:?}");
        parsed
    }

    fn maya() -> Value {
        json!({ "id": "emp_maya", "username": "maya", "name": "Maya Chen", "role": "Cashier",
                "quotaBytes": 10_737_418_240_u64 })
    }

    #[test]
    fn sign_in_params_example() {
        let params: SignInParams = golden(json!({ "username": "maya", "password": "pw" }));
        assert_eq!(params, SignInParams { username: "maya".into(), password: "pw".into() });
    }

    #[test]
    fn sign_in_result_examples() {
        let ok: SignInResult = golden(json!({
            "outcome": "ok", "employee": maya(),
            "filesRoot": "C:\\Users\\RuleboxStaff\\RuleboxFiles\\emp_maya",
            "offline": false, "retryAfterMs": null
        }));
        assert_eq!(ok.outcome, SignInOutcome::Ok);
        assert_eq!(ok.employee.as_ref().map(|e| e.quota_bytes), Some(10_737_418_240));
        assert_eq!(ok.employee.and_then(|e| e.role).as_deref(), Some("Cashier"));

        let locked: SignInResult = golden(json!({
            "outcome": "lockedOut", "employee": null, "filesRoot": null,
            "offline": false, "retryAfterMs": 30000
        }));
        assert_eq!(locked.outcome, SignInOutcome::LockedOut);
        assert_eq!(locked.retry_after_ms, Some(30_000));

        for name in ["wrongCredentials", "disabled", "offlineNeverSignedIn", "offlineExpired"] {
            let other: SignInResult = golden(json!({
                "outcome": name, "employee": null, "filesRoot": null,
                "offline": false, "retryAfterMs": null
            }));
            assert!(other.employee.is_none() && !other.offline);
        }
    }

    #[test]
    fn sign_in_result_with_only_an_outcome_parses() {
        let parsed: SignInResult = serde_json::from_value(json!({ "outcome": "wrongCredentials" })).unwrap();
        assert_eq!(
            parsed,
            SignInResult {
                outcome: SignInOutcome::WrongCredentials,
                employee: None,
                files_root: None,
                offline: false,
                retry_after_ms: None,
            }
        );
    }

    #[test]
    fn session_get_example() {
        let signed_in: SessionGetResult =
            golden(json!({ "employee": maya(), "filesRoot": "C:\\files\\emp_maya", "offline": true }));
        assert!(signed_in.offline);
        let nobody: SessionGetResult = golden(json!({ "employee": null, "filesRoot": null, "offline": false }));
        assert_eq!(nobody.employee, None);
    }

    #[test]
    fn verify_password_examples() {
        golden::<VerifyPasswordParams>(json!({ "password": "pw" }));
        for (name, retry) in [("ok", Value::Null), ("wrongCredentials", Value::Null), ("lockedOut", json!(30000))] {
            golden::<VerifyPasswordResult>(json!({ "outcome": name, "retryAfterMs": retry }));
        }
    }

    #[test]
    fn apps_list_example() {
        let list: AppsListResult = golden(json!({ "apps": [ {
            "id": "orders-web", "name": "Orders", "description": null, "kind": "web",
            "builtin": null,
            "web": { "url": "https://portal.company.com/orders", "allowedDomains": ["portal.company.com"],
                     "permissions": { "camera": false, "microphone": false, "screenShare": false,
                                      "clipboardRead": false, "notifications": true, "downloads": true,
                                      "printing": false, "geolocation": false } },
            "desktop": null,
            "pinnedTaskbar": true, "pinnedDesktop": true, "iconPngBase64": null, "hue": 175
        } ] }));
        let app = &list.apps[0];
        assert_eq!(app.kind, AppKind::Web);
        assert_eq!(app.hue, Some(175));
        assert_eq!(app.web.as_ref().map(|w| w.permissions), Some(WebPermissions::default()));
    }

    #[test]
    fn builtin_and_desktop_apps_round_trip() {
        golden::<AppEntry>(json!({
            "id": "files", "name": "My files", "description": "Your files", "kind": "builtin",
            "builtin": { "tool": "files" }, "web": null, "desktop": null,
            "pinnedTaskbar": true, "pinnedDesktop": false, "iconPngBase64": null, "hue": null
        }));
        golden::<AppEntry>(json!({
            "id": "notepad", "name": "Notepad", "description": null, "kind": "desktop",
            "builtin": null, "web": null,
            "desktop": { "exe": "C:\\Windows\\System32\\notepad.exe", "args": [], "fileArgTemplate": ["{file}"] },
            "pinnedTaskbar": false, "pinnedDesktop": true, "iconPngBase64": "iVBORw0KGgo=", "hue": 30
        }));
    }

    #[test]
    fn admin_exit_examples() {
        golden::<AdminExitSubmitParams>(json!({ "pin": "2468" }));
        for (outcome, left, retry) in [
            ("signingOut", Value::Null, Value::Null),
            ("wrongPin", json!(3), Value::Null),
            ("lockedOut", Value::Null, json!(60000)),
            ("disabled", Value::Null, Value::Null),
        ] {
            golden::<AdminExitSubmitResult>(json!({
                "outcome": outcome, "attemptsLeft": left, "retryAfterMs": retry
            }));
        }
    }

    #[test]
    fn unknown_enum_strings_map_to_unknown() {
        let from = |s: &str| format!("\"{s}\"");
        assert_eq!(serde_json::from_str::<SignInOutcome>(&from("tooTired")).unwrap(), SignInOutcome::Unknown);
        assert_eq!(serde_json::from_str::<VerifyOutcome>(&from("tooTired")).unwrap(), VerifyOutcome::Unknown);
        assert_eq!(serde_json::from_str::<AppKind>(&from("hologram")).unwrap(), AppKind::Unknown);
        assert_eq!(serde_json::from_str::<AdminExitOutcome>(&from("tooTired")).unwrap(), AdminExitOutcome::Unknown);
        // The empty string and the wrong case are also "new values", not errors.
        assert_eq!(serde_json::from_str::<SignInOutcome>(&from("")).unwrap(), SignInOutcome::Unknown);
        assert_eq!(serde_json::from_str::<SignInOutcome>(&from("OK")).unwrap(), SignInOutcome::Unknown);
    }

    #[test]
    fn every_enum_value_round_trips() {
        fn check<T: Serialize + DeserializeOwned + PartialEq + fmt::Debug>(all: &[T]) {
            for v in all {
                let text = serde_json::to_string(v).unwrap();
                assert_eq!(&serde_json::from_str::<T>(&text).unwrap(), v, "{text}");
            }
        }
        use SignInOutcome as S;
        check(&[S::Ok, S::WrongCredentials, S::Disabled, S::LockedOut, S::OfflineNeverSignedIn, S::OfflineExpired, S::Unknown]);
        check(&[VerifyOutcome::Ok, VerifyOutcome::WrongCredentials, VerifyOutcome::LockedOut, VerifyOutcome::Unknown]);
        check(&[AppKind::Builtin, AppKind::Web, AppKind::Desktop, AppKind::Unknown]);
        check(&[
            AdminExitOutcome::SigningOut,
            AdminExitOutcome::WrongPin,
            AdminExitOutcome::LockedOut,
            AdminExitOutcome::Disabled,
            AdminExitOutcome::Unknown,
        ]);
    }

    #[test]
    fn unknown_fields_are_ignored() {
        let parsed: AdminExitSubmitResult = serde_json::from_value(
            json!({ "outcome": "wrongPin", "attemptsLeft": 2, "retryAfterMs": null, "addedInMinor2": true }),
        )
        .unwrap();
        assert_eq!(parsed.attempts_left, Some(2));
    }

    #[test]
    fn debug_never_prints_a_secret() {
        let secret = "s3cr3t-value";
        let sign_in = format!("{:?}", SignInParams { username: "maya".into(), password: secret.into() });
        assert!(!sign_in.contains(secret), "{sign_in}");
        assert!(sign_in.contains("maya") && sign_in.contains("<redacted>"));

        let verify = format!("{:?}", VerifyPasswordParams { password: secret.into() });
        assert!(!verify.contains(secret), "{verify}");

        let pin = format!("{:?}", AdminExitSubmitParams { pin: secret.into() });
        assert!(!pin.contains(secret), "{pin}");
        // The alternate form must not leak either.
        let pretty = format!("{:#?}", AdminExitSubmitParams { pin: secret.into() });
        assert!(!pretty.contains(secret), "{pretty}");
    }

    #[test]
    fn web_permissions_default_allows_only_notifications_and_downloads() {
        let p = WebPermissions::default();
        assert!(p.notifications && p.downloads);
        assert!(!(p.camera || p.microphone || p.screen_share || p.clipboard_read || p.printing || p.geolocation));
        // A document that omits the permissions entirely gets the same defaults.
        let parsed: WebPermissions = serde_json::from_value(json!({})).unwrap();
        assert_eq!(parsed, p);
        // A partial object keeps the defaults for what it leaves out.
        let partial: WebPermissions = serde_json::from_value(json!({ "camera": true })).unwrap();
        assert!(partial.camera && partial.notifications && partial.downloads);
    }
}
