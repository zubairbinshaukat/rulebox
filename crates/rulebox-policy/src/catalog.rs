//! The app catalogue of a signed desired-state document (plan Phase 4, Section
//! 4.8 and Step 10): `doc.catalog`, one [`CatalogApp`] per app a device knows,
//! Files first. These types are exactly what `convex/lib/desired.ts` emits:
//! field order is the serialized order, absent optional values are `null`, and
//! `tests/vectors/catalog-v2.json` (written by `scripts/gen-policy-vectors.mjs`
//! from the real builder) pins the bytes in both languages. No I/O.
//!
//! Unknown enum strings map to `Unknown` ([`unknown_on_new_values!`]) so a newer
//! backend can add a kind without breaking an older agent: an entry whose kind
//! is `Unknown` is skipped, never guessed. Unknown JSON keys are ignored (no
//! `deny_unknown_fields`: the same rule as the rest of the document).
//!
//! The document is signed, so these checks are defence in depth, not trust:
//! [`CatalogApp::validate`] refuses an `http://` URL, a hash that is not 64
//! lower-case hex and a spec that does not fit the kind, and [`parse_catalog`]
//! reports each entry on its own so one bad app does not hide the others.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

/// Id of the built-in Files app (`FILES_APP_ID` in `desired.ts`).
pub const FILES_APP_ID: &str = "files";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum CatalogKind {
    Builtin,
    Web,
    Desktop,
    Unknown,
}
unknown_on_new_values!(CatalogKind { Builtin => "builtin", Web => "web", Desktop => "desktop" });

/// Who sees an app on a device: everyone who signs in, or the listed employees.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum Audience {
    Everyone,
    Selected,
    Unknown,
}
unknown_on_new_values!(Audience { Everyone => "everyone", Selected => "selected" });

/// The tools the Staff App itself provides.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum CatalogTool {
    Files,
    Unknown,
}
unknown_on_new_values!(CatalogTool { Files => "files" });

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BuiltinSpec {
    pub tool: CatalogTool,
}

/// What a web app may ask the browser for (PRD 24.1). Not the Staff App's
/// `WebPermissions` (that one has serde defaults for IPC); here every key is
/// always present because the backend always writes all eight.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CatalogWebPermissions {
    pub camera: bool,
    pub microphone: bool,
    pub screen_share: bool,
    pub clipboard_read: bool,
    pub notifications: bool,
    pub downloads: bool,
    pub printing: bool,
    pub geolocation: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct WebSpec {
    /// `https://` only.
    pub url: String,
    pub allowed_domains: Vec<String>,
    pub permissions: CatalogWebPermissions,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum InstallKind {
    Msi,
    Exe,
    Portable,
    Unknown,
}
unknown_on_new_values!(InstallKind { Msi => "msi", Exe => "exe", Portable => "portable" });

/// How the agent puts a desktop app on the PC. Absent (`null`) for a program
/// that is already installed ("preinstalled").
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct InstallSpec {
    pub kind: InstallKind,
    /// `https://` only.
    pub url: String,
    /// 64 lower-case hex; the download is deleted when it does not match.
    pub sha256: String,
    /// 0 = unknown.
    #[ts(type = "number")]
    pub size_bytes: u64,
    /// `exe` only; an MSI gets its switches from the agent.
    pub silent_args: Vec<String>,
    /// MSI: `{GUID}`, used for removal.
    pub product_code: Option<String>,
    pub success_exit_codes: Vec<i32>,
    pub remove_when_unassigned: bool,
}

/// A program on the PC. `exe` and the folder lists are path templates (plan 4.8
/// "Path templates"); the agent expands and checks them before use.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DesktopSpec {
    pub exe: String,
    pub args: Vec<String>,
    /// e.g. `["{file}"]`; empty = the app cannot open files.
    pub file_arg_template: Vec<String>,
    pub install: Option<InstallSpec>,
    pub reset_folders: Vec<String>,
}

/// The icon file in Convex storage; the agent checks `sha256` after download.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct IconRef {
    pub url: String,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CatalogApp {
    /// `"files"` or a Convex `apps` id.
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub kind: CatalogKind,
    pub builtin: Option<BuiltinSpec>,
    pub web: Option<WebSpec>,
    pub desktop: Option<DesktopSpec>,
    pub pinned_taskbar: bool,
    pub pinned_desktop: bool,
    pub hue: Option<u16>,
    pub icon: Option<IconRef>,
    pub audience: Audience,
    /// Sorted; meaningful when `audience` is `selected`.
    pub employee_ids: Vec<String>,
    /// Bumped on every change (and by Retry); a new revision resets install attempts.
    #[ts(type = "number")]
    pub revision: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum CatalogError {
    #[error("the catalogue is not a JSON array")]
    NotAnArray,
    /// A missing required key (e.g. `sha256`) or a value of the wrong type.
    #[error("the catalogue entry does not parse: {0}")]
    Malformed(String),
    /// A value this agent does not know (a newer backend); the entry is skipped.
    #[error("unknown value for {0}")]
    UnknownValue(&'static str),
    /// The kind says one thing, the specs say another.
    #[error("{0} does not fit the app kind")]
    SpecMismatch(&'static str),
    #[error("{0} must be an https:// URL")]
    NotHttps(&'static str),
    #[error("{0} must be 64 lower-case hex characters")]
    BadSha256(&'static str),
}

fn check_https(field: &'static str, url: &str) -> Result<(), CatalogError> {
    match url.get(..8) {
        Some(scheme) if scheme.eq_ignore_ascii_case("https://") && url.len() > 8 => Ok(()),
        _ => Err(CatalogError::NotHttps(field)),
    }
}

fn check_sha256(field: &'static str, hash: &str) -> Result<(), CatalogError> {
    let ok = hash.len() == 64 && hash.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
    if ok {
        Ok(())
    } else {
        Err(CatalogError::BadSha256(field))
    }
}

impl CatalogApp {
    /// False when the kind is one this agent does not know: skip the entry.
    pub fn is_supported(&self) -> bool {
        self.kind != CatalogKind::Unknown
    }

    /// (Phase 4 Step 13, plan 4.8 "Which apps an employee sees") The audience part
    /// of the rule: everyone, or the employee is listed. Whether a desktop app is
    /// installed is the caller's part. An unknown audience is never visible.
    pub fn visible_to(&self, employee_id: &str) -> bool {
        match self.audience {
            Audience::Everyone => true,
            Audience::Selected => self.employee_ids.iter().any(|id| id == employee_id),
            Audience::Unknown => false,
        }
    }

    /// True for a desktop app the agent copies into `{RuleboxApps}\<id>\`.
    pub fn is_portable(&self) -> bool {
        self.desktop
            .as_ref()
            .and_then(|desktop| desktop.install.as_ref())
            .is_some_and(|install| install.kind == InstallKind::Portable)
    }

    /// The entry is usable: known values, the spec of its kind (and only that
    /// one), `https://` URLs, well-formed hashes. Path templates are checked
    /// where they are expanded, not here.
    pub fn validate(&self) -> Result<(), CatalogError> {
        if self.audience == Audience::Unknown {
            return Err(CatalogError::UnknownValue("audience"));
        }
        if let Some(icon) = &self.icon {
            check_sha256("icon.sha256", &icon.sha256)?;
        }
        let (has_builtin, has_web, has_desktop) = (self.builtin.is_some(), self.web.is_some(), self.desktop.is_some());
        match self.kind {
            CatalogKind::Unknown => return Err(CatalogError::UnknownValue("kind")),
            CatalogKind::Builtin => {
                if !has_builtin || has_web || has_desktop {
                    return Err(CatalogError::SpecMismatch("builtin"));
                }
            }
            CatalogKind::Web => {
                if !has_web || has_builtin || has_desktop {
                    return Err(CatalogError::SpecMismatch("web"));
                }
            }
            CatalogKind::Desktop => {
                if !has_desktop || has_builtin || has_web {
                    return Err(CatalogError::SpecMismatch("desktop"));
                }
            }
        }
        if let Some(builtin) = &self.builtin {
            if builtin.tool == CatalogTool::Unknown {
                return Err(CatalogError::UnknownValue("builtin.tool"));
            }
        }
        if let Some(web) = &self.web {
            check_https("web.url", &web.url)?;
        }
        if let Some(install) = self.desktop.as_ref().and_then(|d| d.install.as_ref()) {
            if install.kind == InstallKind::Unknown {
                return Err(CatalogError::UnknownValue("install.kind"));
            }
            check_https("install.url", &install.url)?;
            check_sha256("install.sha256", &install.sha256)?;
        }
        Ok(())
    }
}

/// `doc.catalog` entry by entry: each element parsed and validated on its own,
/// in document order, so the caller can skip a bad app and keep the rest. A
/// value that is not an array is an error for the whole catalogue.
pub fn parse_catalog(catalog: &Value) -> Result<Vec<Result<CatalogApp, CatalogError>>, CatalogError> {
    let entries = catalog.as_array().ok_or(CatalogError::NotAnArray)?;
    Ok(entries
        .iter()
        .map(|entry| {
            let app: CatalogApp = serde_json::from_value(entry.clone()).map_err(|e| CatalogError::Malformed(e.to_string()))?;
            app.validate()?;
            Ok(app)
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn vector() -> Value {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/vectors/catalog-v2.json");
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    fn apps(v: &Value) -> Vec<CatalogApp> {
        serde_json::from_value(v["doc"]["catalog"].clone()).unwrap()
    }

    fn find<'a>(apps: &'a [CatalogApp], id: &str) -> &'a CatalogApp {
        apps.iter().find(|a| a.id == id).unwrap_or_else(|| panic!("no app {id} in the vector"))
    }

    /// A valid desktop entry (MSI) as JSON, for the negative tests to damage.
    fn desktop_entry() -> Value {
        let v = vector();
        v["doc"]["catalog"]
            .as_array()
            .unwrap()
            .iter()
            .find(|a| a["id"] == "app_vec_msi")
            .cloned()
            .unwrap()
    }

    #[test]
    fn catalog_vector_parses_validates_and_round_trips() {
        let v = vector();
        let list = apps(&v);
        for app in &list {
            assert_eq!(app.validate(), Ok(()), "{}", app.id);
        }
        // Back to the same JSON value, and to the same bytes the TypeScript builder wrote
        // (key order, null for absent values, escapes).
        assert_eq!(serde_json::to_value(&list).unwrap(), v["doc"]["catalog"]);
        assert_eq!(serde_json::to_string(&list).unwrap(), v["catalogJson"].as_str().unwrap());
        // parse_catalog agrees.
        let parsed = parse_catalog(&v["doc"]["catalog"]).unwrap();
        assert_eq!(parsed.into_iter().collect::<Result<Vec<_>, _>>().unwrap(), list);
    }

    #[test]
    fn catalog_vector_covers_every_kind_and_optional() {
        let list = apps(&vector());
        // Files first, then the rest sorted by id (plan 4.4 rule 1).
        assert_eq!(list[0].id, FILES_APP_ID);
        assert!(list[1..].windows(2).all(|w| w[0].id < w[1].id));
        let files = &list[0];
        assert_eq!((files.kind, files.builtin.as_ref().map(|b| b.tool)), (CatalogKind::Builtin, Some(CatalogTool::Files)));
        assert!(files.web.is_none() && files.desktop.is_none() && files.pinned_taskbar);

        let kinds: Vec<CatalogKind> = list.iter().map(|a| a.kind).collect();
        assert!(kinds.contains(&CatalogKind::Web) && kinds.contains(&CatalogKind::Desktop));
        let install_kinds: Vec<InstallKind> =
            list.iter().filter_map(|a| a.desktop.as_ref()?.install.as_ref()).map(|i| i.kind).collect();
        for kind in [InstallKind::Msi, InstallKind::Exe, InstallKind::Portable] {
            assert!(install_kinds.contains(&kind), "{kind:?}");
        }
        // Optional values: absent and present.
        assert!(list.iter().any(|a| a.description.is_none()) && list.iter().any(|a| a.description.is_some()));
        assert!(list.iter().any(|a| a.hue.is_none()) && list.iter().any(|a| a.hue.is_some()));
        assert!(list.iter().any(|a| a.icon.is_none()) && list.iter().any(|a| a.icon.is_some()));
        assert!(list.iter().any(|a| a.desktop.as_ref().is_some_and(|d| d.install.is_none())), "a preinstalled app");
        assert!(list.iter().any(|a| a.audience == Audience::Selected && !a.employee_ids.is_empty()));
        assert!(list.iter().any(|a| a.audience == Audience::Everyone));

        let msi = find(&list, "app_vec_msi");
        let install = msi.desktop.as_ref().unwrap().install.as_ref().unwrap();
        assert_eq!(install.kind, InstallKind::Msi);
        assert_eq!(install.product_code.as_deref(), Some("{00000000-0000-0000-0000-000000000001}"));
        assert!(install.remove_when_unassigned);
        let exe = find(&list, "app_vec_exe");
        let install = exe.desktop.as_ref().unwrap().install.as_ref().unwrap();
        assert_eq!((install.kind, install.product_code.as_deref()), (InstallKind::Exe, None));
        assert_eq!(install.success_exit_codes, [0, 3010]);
        assert!(!install.silent_args.is_empty() && !install.remove_when_unassigned);
        let web = find(&list, "app_vec_web_full");
        assert_eq!(web.name, "Ørders \"Küche\" \\ 注文 🦀");
        assert_eq!(web.web.as_ref().unwrap().allowed_domains.len(), 2);
        assert!(web.web.as_ref().unwrap().permissions.printing);
    }

    #[test]
    fn file_handler_rules_point_into_the_catalogue() {
        let v = vector();
        let list = apps(&v);
        // The same document is also a Phase 2 `DesiredState` (extra keys ignored).
        let state: crate::DesiredState = serde_json::from_value(v["doc"].clone()).unwrap();
        assert_eq!(state.apps, list.iter().map(|a| a.id.clone()).collect::<Vec<_>>());
        assert!(state.file_handlers.len() >= 3);
        for (extension, app_id) in &state.file_handlers {
            assert!(extension.starts_with('.') && *extension == extension.to_lowercase(), "{extension}");
            let app = find(&list, app_id);
            // A handler is a desktop app that can open files, or the built-in Files app.
            assert!(
                app.kind == CatalogKind::Builtin || app.desktop.as_ref().is_some_and(|d| !d.file_arg_template.is_empty()),
                "{extension} -> {app_id}"
            );
        }
        // A rule whose app is not in this device's catalogue was dropped by the builder.
        assert!(!state.file_handlers.contains_key(".dropped"));
    }

    #[test]
    fn unknown_values_become_unknown_and_the_entry_is_skipped() {
        let mut entry = desktop_entry();
        entry["kind"] = json!("hologram");
        let app: CatalogApp = serde_json::from_value(entry.clone()).unwrap();
        assert_eq!(app.kind, CatalogKind::Unknown);
        assert!(!app.is_supported());
        assert_eq!(app.validate(), Err(CatalogError::UnknownValue("kind")));

        let mut entry = desktop_entry();
        entry["desktop"]["install"]["kind"] = json!("snap");
        let app: CatalogApp = serde_json::from_value(entry).unwrap();
        assert_eq!(app.desktop.unwrap().install.unwrap().kind, InstallKind::Unknown);

        let mut entry = desktop_entry();
        entry["audience"] = json!("nobody");
        assert_eq!(serde_json::from_value::<CatalogApp>(entry).unwrap().validate(), Err(CatalogError::UnknownValue("audience")));

        // One unknown entry does not hide the others.
        let mut list = vector()["doc"]["catalog"].clone();
        let total = list.as_array().unwrap().len();
        list[1]["kind"] = json!("hologram");
        let parsed = parse_catalog(&list).unwrap();
        assert_eq!(parsed.len(), total);
        assert_eq!(parsed[1], Err(CatalogError::UnknownValue("kind")));
        assert_eq!(parsed.iter().filter(|r| r.is_ok()).count(), total - 1);
        assert_eq!(parse_catalog(&json!({ "not": "an array" })), Err(CatalogError::NotAnArray));
    }

    #[test]
    fn visibility_follows_the_audience() {
        let list = apps(&vector());
        let selected = list.iter().find(|a| a.audience == Audience::Selected && !a.employee_ids.is_empty()).unwrap();
        let listed = selected.employee_ids[0].clone();
        assert!(selected.visible_to(&listed));
        assert!(!selected.visible_to("emp_somebody_else"));
        let everyone = list.iter().find(|a| a.audience == Audience::Everyone).unwrap();
        assert!(everyone.visible_to("emp_somebody_else"));
        let mut unknown = everyone.clone();
        unknown.audience = Audience::Unknown;
        assert!(!unknown.visible_to(&listed));
        assert!(list.iter().any(CatalogApp::is_portable));
        assert!(!find(&list, "app_vec_msi").is_portable());
    }

    #[test]
    fn unknown_json_keys_are_ignored() {
        let mut entry = desktop_entry();
        entry["somethingNew"] = json!({ "a": 1 });
        entry["desktop"]["install"]["mirrors"] = json!(["https://mirror.example.test/x.msi"]);
        let app: CatalogApp = serde_json::from_value(entry).unwrap();
        assert_eq!(app.validate(), Ok(()));
    }

    #[test]
    fn missing_sha256_is_malformed() {
        let mut entry = desktop_entry();
        entry["desktop"]["install"].as_object_mut().unwrap().remove("sha256");
        let err = serde_json::from_value::<CatalogApp>(entry.clone()).unwrap_err().to_string();
        assert!(err.contains("sha256"), "{err}");
        let parsed = parse_catalog(&json!([entry])).unwrap();
        assert!(matches!(&parsed[0], Err(CatalogError::Malformed(m)) if m.contains("sha256")), "{parsed:?}");
        // An icon without a hash too.
        let mut v = vector()["doc"]["catalog"].clone();
        let icon = v.as_array_mut().unwrap().iter_mut().find(|a| !a["icon"].is_null()).unwrap();
        icon["icon"].as_object_mut().unwrap().remove("sha256");
        let parsed = parse_catalog(&json!([icon.clone()])).unwrap();
        assert!(matches!(&parsed[0], Err(CatalogError::Malformed(_))));
    }

    #[test]
    fn non_https_urls_are_refused() {
        for url in ["http://downloads.example.test/a.msi", "ftp://x.example.test/a.msi", "https:/x", "https://", "", "//x.example.test/a.msi", "\u{1F980}https://x"] {
            let mut entry = desktop_entry();
            entry["desktop"]["install"]["url"] = json!(url);
            let app: CatalogApp = serde_json::from_value(entry).unwrap();
            assert_eq!(app.validate(), Err(CatalogError::NotHttps("install.url")), "{url:?}");
        }
        let mut web = vector()["doc"]["catalog"].as_array().unwrap().iter().find(|a| a["kind"] == "web").cloned().unwrap();
        web["web"]["url"] = json!("http://orders.example.test/");
        assert_eq!(serde_json::from_value::<CatalogApp>(web.clone()).unwrap().validate(), Err(CatalogError::NotHttps("web.url")));
        // The scheme is case-insensitive in a URL; the host is what it is.
        web["web"]["url"] = json!("HTTPS://orders.example.test/");
        assert_eq!(serde_json::from_value::<CatalogApp>(web).unwrap().validate(), Ok(()));
    }

    #[test]
    fn bad_sha256_is_refused() {
        let good = "0000000000000000000000000000000000000000000000000000000000000001";
        let bad = [
            good[..63].to_string(),
            format!("{good}0"),
            String::new(),
            good.replace('1', "A"),      // upper case
            good.replace('1', "g"),      // not hex
            format!(" {}", &good[1..]),  // 64 long, with a space
            format!("{}é", &good[..62]), // 64 bytes, not 64 hex characters
        ];
        for hash in bad {
            let mut entry = desktop_entry();
            entry["desktop"]["install"]["sha256"] = json!(hash);
            let app: CatalogApp = serde_json::from_value(entry).unwrap();
            assert_eq!(app.validate(), Err(CatalogError::BadSha256("install.sha256")), "{hash:?}");
        }
        let mut with_icon = vector()["doc"]["catalog"].as_array().unwrap().iter().find(|a| !a["icon"].is_null()).cloned().unwrap();
        with_icon["icon"]["sha256"] = json!("abc");
        assert_eq!(serde_json::from_value::<CatalogApp>(with_icon).unwrap().validate(), Err(CatalogError::BadSha256("icon.sha256")));
    }

    #[test]
    fn spec_must_fit_the_kind() {
        let mut entry = desktop_entry();
        entry["kind"] = json!("web");
        assert_eq!(serde_json::from_value::<CatalogApp>(entry).unwrap().validate(), Err(CatalogError::SpecMismatch("web")));
        let mut entry = desktop_entry();
        entry["desktop"] = Value::Null;
        assert_eq!(serde_json::from_value::<CatalogApp>(entry).unwrap().validate(), Err(CatalogError::SpecMismatch("desktop")));
        let mut entry = desktop_entry();
        entry["builtin"] = json!({ "tool": "files" });
        assert_eq!(serde_json::from_value::<CatalogApp>(entry).unwrap().validate(), Err(CatalogError::SpecMismatch("desktop")));
        let mut files = vector()["doc"]["catalog"][0].clone();
        files["builtin"] = json!({ "tool": "terminal" });
        assert_eq!(serde_json::from_value::<CatalogApp>(files).unwrap().validate(), Err(CatalogError::UnknownValue("builtin.tool")));
    }
}
