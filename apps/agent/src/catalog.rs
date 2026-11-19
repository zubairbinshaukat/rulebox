//! The app catalogue of the signed document (plan Phase 4, 4.8, Step 13 item 5):
//! `doc.catalog` parsed with `rulebox_policy::catalog::parse_catalog` (a bad entry
//! is skipped and logged, never the whole catalogue), and [`visible_apps`]: what
//! one employee sees on this PC, as `apps.list` entries.
//!
//! Rules of "which apps an employee sees" (4.8): audience `everyone`, or the
//! employee is listed; a desktop app only when it is installed (PRD 13.5: never a
//! half-installed app). With an `install`, "installed" is the install engine's
//! record (Step 14) plus the exe on disk; without one ("preinstalled"), the exe
//! on disk ([`Platform::file_exists`]). Every desktop path template is
//! expanded and checked again with the server's rules (`rulebox_policy::paths`);
//! an entry that fails is skipped and logged with its id and the fixed reason,
//! never the value.
//!
//! Nothing here calls the backend: `apps.list` answers from memory.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use rulebox_ipc::requests::{AppEntry, AppKind, BuiltinApp, DesktopApp, WebApp, WebPermissions};
use rulebox_policy::catalog::{parse_catalog, CatalogApp, CatalogKind, CatalogTool};
use rulebox_policy::paths::{check_args, check_file_args, expand_exe, PathRoots};
use serde_json::Value;

use crate::installs::engine::{install_of, InstallBook};
use crate::installs::icons;
use crate::platform::Platform;

/// `doc.catalog` is there but is not a list: logged, the catalogue is empty.
pub const PROBLEM_CATALOG_INVALID: &str = "catalog_invalid";

/// Whether a desktop app may be shown (Step 14 adds the install records).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstallView {
    Installed,
    NotInstalled,
}

/// The catalogue of a document: the usable entries in document order, and the
/// problem when the whole value was unusable. No `catalog` key is an empty
/// catalogue without a problem (a document from before Step 10).
pub fn catalog_from_doc(doc: &Value) -> (Vec<CatalogApp>, Option<String>) {
    let Some(value) = doc.get("catalog").filter(|value| !value.is_null()) else {
        return (Vec::new(), None);
    };
    let entries = match parse_catalog(value) {
        Ok(entries) => entries,
        Err(error) => {
            tracing::error!("{PROBLEM_CATALOG_INVALID}: {error}; no apps");
            return (Vec::new(), Some(PROBLEM_CATALOG_INVALID.to_string()));
        }
    };
    let mut apps = Vec::with_capacity(entries.len());
    for (index, entry) in entries.into_iter().enumerate() {
        match entry {
            Ok(app) if app.is_supported() => apps.push(app),
            Ok(app) => tracing::warn!(app_id = %app.id, "catalogue entry of an unknown kind skipped"),
            Err(error) => {
                // The error names fields, not values (an id is not a secret, but the
                // entry may not even have one).
                let id = value.get(index).and_then(|e| e.get("id")).and_then(Value::as_str).unwrap_or("?");
                tracing::warn!(index, app_id = %id, "catalogue entry skipped: {error}");
            }
        }
    }
    (apps, None)
}

fn permissions(app: &CatalogApp) -> WebPermissions {
    let Some(web) = &app.web else {
        return WebPermissions::default();
    };
    let p = web.permissions;
    WebPermissions {
        camera: p.camera,
        microphone: p.microphone,
        screen_share: p.screen_share,
        clipboard_read: p.clipboard_read,
        notifications: p.notifications,
        downloads: p.downloads,
        printing: p.printing,
        geolocation: p.geolocation,
    }
}

/// One catalogue entry as `employee_id` would see it, or `None` (not for them,
/// not installed, or a path that does not pass the rules).
fn entry_for(
    app: &CatalogApp,
    employee_id: &str,
    roots: Option<&PathRoots>,
    installed: &dyn Fn(&CatalogApp, &str) -> InstallView,
    icon: &dyn Fn(&CatalogApp) -> Option<String>,
) -> Option<AppEntry> {
    if !app.is_supported() || !app.visible_to(employee_id) {
        return None;
    }
    let mut entry = AppEntry {
        id: app.id.clone(),
        name: app.name.clone(),
        description: app.description.clone(),
        kind: AppKind::Unknown,
        builtin: None,
        web: None,
        desktop: None,
        pinned_taskbar: app.pinned_taskbar,
        pinned_desktop: app.pinned_desktop,
        // (Step 14) From the icon cache; without one the Staff App draws a letter tile.
        icon_png_base64: icon(app),
        hue: app.hue,
        // (Phase 6 Step 4) Protocol 1.4: no update state until Step 11 sets it.
        update: None,
    };
    match app.kind {
        CatalogKind::Builtin => {
            let tool = match app.builtin.as_ref()?.tool {
                CatalogTool::Files => "files",
                CatalogTool::Unknown => return None,
            };
            entry.kind = AppKind::Builtin;
            entry.builtin = Some(BuiltinApp { tool: tool.to_string() });
        }
        CatalogKind::Web => {
            let web = app.web.as_ref()?;
            entry.kind = AppKind::Web;
            entry.web = Some(WebApp {
                url: web.url.clone(),
                allowed_domains: web.allowed_domains.clone(),
                permissions: permissions(app),
                // (Phase 6 Step 4) Protocol 1.4: every web app opens in the built-in window
                // until Step 17 fills the browser fields.
                browser: rulebox_policy::catalog::BrowserKind::Builtin,
                browser_exe: None,
                browser_ready: false,
            });
        }
        CatalogKind::Desktop => {
            let desktop = app.desktop.as_ref()?;
            let Some(roots) = roots else {
                tracing::warn!(app_id = %app.id, "desktop app skipped: the program folders are not known");
                return None;
            };
            let checked = expand_exe(&desktop.exe, &app.id, app.is_portable(), roots)
                .and_then(|exe| check_args(&desktop.args).map(|()| exe))
                .and_then(|exe| check_file_args(&desktop.file_arg_template).map(|()| exe));
            let exe = match checked {
                Ok(exe) => exe,
                Err(problem) => {
                    tracing::warn!(app_id = %app.id, "desktop app skipped: {problem}");
                    return None;
                }
            };
            if installed(app, &exe) != InstallView::Installed {
                return None;
            }
            entry.kind = AppKind::Desktop;
            entry.desktop = Some(DesktopApp {
                exe,
                args: desktop.args.clone(),
                file_arg_template: desktop.file_arg_template.clone(),
            });
        }
        CatalogKind::Unknown => return None,
    }
    Some(entry)
}

/// The apps `employee_id` sees, in catalogue order (plan 4.8). Pure apart from
/// the log lines; `installed(app, exe)` decides about desktop apps. No icons.
#[cfg(test)]
pub fn visible_apps(
    catalog: &[CatalogApp],
    employee_id: &str,
    roots: Option<&PathRoots>,
    installed: &dyn Fn(&CatalogApp, &str) -> InstallView,
) -> Vec<AppEntry> {
    visible_apps_with_icons(catalog, employee_id, roots, installed, &|_| None)
}

/// [`visible_apps`] with `icon(app)` filling `iconPngBase64`.
pub fn visible_apps_with_icons(
    catalog: &[CatalogApp],
    employee_id: &str,
    roots: Option<&PathRoots>,
    installed: &dyn Fn(&CatalogApp, &str) -> InstallView,
    icon: &dyn Fn(&CatalogApp) -> Option<String>,
) -> Vec<AppEntry> {
    catalog.iter().filter_map(|app| entry_for(app, employee_id, roots, installed, icon)).collect()
}

/// [`visible_apps`] on this PC: the platform's roots; with the install records
/// (Step 14), a desktop app with an `install` is shown only when the engine has
/// it `installed` in the catalogue's version AND its program exists; a
/// preinstalled app (no `install`) when its program exists. Icons from the cache.
#[derive(Clone)]
pub struct AppResolver {
    platform: Arc<dyn Platform>,
    installs: Option<Arc<InstallBook>>,
    icons_dir: Option<PathBuf>,
}

impl AppResolver {
    /// "Installed when the exe exists", no icons (tests).
    #[cfg(test)]
    pub fn new(platform: Arc<dyn Platform>) -> Self {
        Self { platform, installs: None, icons_dir: None }
    }

    /// (Step 14) The real rule: the install records and the icon cache.
    pub fn with_installs(platform: Arc<dyn Platform>, installs: Arc<InstallBook>, icons_dir: PathBuf) -> Self {
        Self { platform, installs: Some(installs), icons_dir: Some(icons_dir) }
    }

    pub fn visible(&self, catalog: &[CatalogApp], employee_id: &str) -> Vec<AppEntry> {
        let roots = match self.platform.path_roots() {
            Ok(roots) => Some(roots),
            Err(error) => {
                tracing::warn!("cannot read the program folders ({error}); desktop apps are hidden");
                None
            }
        };
        let platform = Arc::clone(&self.platform);
        let installs = self.installs.clone();
        let installed = move |app: &CatalogApp, exe: &str| {
            let recorded = match (&installs, install_of(app)) {
                // Never a half-installed app (PRD 13.5): the engine's word first.
                (Some(book), Some(install)) => book.is_installed(&app.id, &install.sha256),
                _ => true,
            };
            if recorded && platform.file_exists(Path::new(exe)) {
                InstallView::Installed
            } else {
                InstallView::NotInstalled
            }
        };
        let icon = |app: &CatalogApp| {
            let dir = self.icons_dir.as_deref()?;
            icons::icon_base64(dir, app.icon.as_ref()?)
        };
        visible_apps_with_icons(catalog, employee_id, roots.as_ref(), &installed, &icon)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::sim::{sim_path_roots, SimPlatform};
    use serde_json::json;

    fn vector_catalog() -> Value {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../crates/rulebox-policy/tests/vectors/catalog-v2.json");
        let v: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        v["doc"]["catalog"].clone()
    }

    fn all_installed(_: &CatalogApp, _: &str) -> InstallView {
        InstallView::Installed
    }

    #[test]
    fn the_vector_catalogue_parses_through_parse_catalog() {
        let catalog = vector_catalog();
        let total = catalog.as_array().unwrap().len();
        let (apps, problem) = catalog_from_doc(&json!({ "catalog": catalog }));
        assert_eq!((apps.len(), problem), (total, None));
        assert_eq!(apps[0].id, "files");
    }

    #[test]
    fn bad_entries_are_skipped_and_a_bad_shape_is_a_problem() {
        let mut catalog = vector_catalog();
        let total = catalog.as_array().unwrap().len();
        catalog[1]["kind"] = json!("hologram");
        catalog[2]["desktop"] = json!("not an object");
        catalog[3].as_object_mut().unwrap().remove("id");
        let (apps, problem) = catalog_from_doc(&json!({ "catalog": catalog }));
        assert_eq!(problem, None);
        assert_eq!(apps.len(), total - 3);
        assert_eq!(catalog_from_doc(&json!({ "catalog": { "x": 1 } })), (Vec::new(), Some(PROBLEM_CATALOG_INVALID.into())));
        assert_eq!(catalog_from_doc(&json!({})), (Vec::new(), None));
    }

    fn desktop(id: &str, exe: &str) -> CatalogApp {
        serde_json::from_value(json!({
            "id": id, "name": id, "description": null, "kind": "desktop", "builtin": null, "web": null,
            "desktop": { "exe": exe, "args": [], "fileArgTemplate": ["{file}"], "install": null, "resetFolders": [] },
            "pinnedTaskbar": false, "pinnedDesktop": false, "hue": null, "icon": null,
            "audience": "everyone", "employeeIds": [], "revision": 1
        }))
        .unwrap()
    }

    #[test]
    fn visible_apps_follows_audience_install_and_path_rules() {
        let (apps, _) = catalog_from_doc(&json!({ "catalog": vector_catalog() }));
        let roots = sim_path_roots();
        let selected = apps.iter().find(|a| a.audience == rulebox_policy::catalog::Audience::Selected).unwrap();
        let listed = selected.employee_ids[0].clone();
        let for_listed = visible_apps(&apps, &listed, Some(&roots), &all_installed);
        let for_other = visible_apps(&apps, "emp_nobody", Some(&roots), &all_installed);
        assert!(for_listed.iter().any(|a| a.id == selected.id));
        assert!(!for_other.iter().any(|a| a.id == selected.id));
        // Files is always there; the order is the catalogue's.
        assert_eq!(for_other[0].id, "files");
        assert_eq!(for_other[0].builtin.as_ref().map(|b| b.tool.as_str()), Some("files"));
        // Nothing installed: no desktop app.
        let none = visible_apps(&apps, &listed, Some(&roots), &|_, _| InstallView::NotInstalled);
        assert!(none.iter().all(|a| a.kind != AppKind::Desktop));
        assert!(for_listed.iter().any(|a| a.kind == AppKind::Desktop));
        // Desktop paths are expanded.
        for app in for_listed.iter().filter(|a| a.kind == AppKind::Desktop) {
            assert!(app.desktop.as_ref().unwrap().exe.starts_with(r"C:\"), "{:?}", app.desktop);
        }
        // Unknown roots: desktop apps are hidden, the rest stays.
        let no_roots = visible_apps(&apps, &listed, None, &all_installed);
        assert!(no_roots.iter().all(|a| a.kind != AppKind::Desktop) && !no_roots.is_empty());

        // A template that fails the rules is skipped; the others stay.
        let bad = [desktop("a1", r"C:\evil.exe"), desktop("a2", r"{SystemRoot}\System32\cmd.exe"), desktop("a3", r"{ProgramFiles}\Good\good.exe")];
        let shown = visible_apps(&bad, "e", Some(&roots), &all_installed);
        assert_eq!(shown.iter().map(|a| a.id.as_str()).collect::<Vec<_>>(), ["a3"]);
        assert_eq!(shown[0].desktop.as_ref().unwrap().exe, r"C:\Program Files\Good\good.exe");
    }

    #[test]
    fn a_root_that_is_not_known_hides_only_the_apps_that_need_it() {
        let apps = [
            desktop("pf", r"{ProgramFiles}\Good\good.exe"),
            desktop("x86", r"{ProgramFilesX86}\Old\old.exe"),
            desktop("sys", r"{SystemRoot}\System32\notepad.exe"),
        ];
        let ids = |roots: &PathRoots| -> Vec<String> {
            visible_apps(&apps, "e", Some(roots), &all_installed).into_iter().map(|a| a.id).collect()
        };
        assert_eq!(ids(&sim_path_roots()), ["pf", "x86", "sys"]);
        // No `ProgramFiles(x86)` variable: the x86 app goes, System32 and Program Files stay.
        assert_eq!(ids(&PathRoots { program_files_x86: None, ..sim_path_roots() }), ["pf", "sys"]);
        assert_eq!(ids(&PathRoots { system_root: None, ..sim_path_roots() }), ["pf", "x86"]);
    }

    #[test]
    fn the_resolver_shows_a_desktop_app_only_when_its_exe_exists() {
        let dir = crate::testutil::TempDir::new();
        let platform = Arc::new(SimPlatform::new(dir.path().to_path_buf()));
        let resolver = AppResolver::new(Arc::clone(&platform) as Arc<dyn Platform>);
        let catalog = [desktop("a3", r"{ProgramFiles}\Good\good.exe")];
        assert!(resolver.visible(&catalog, "e").is_empty());
        platform.add_file(r"C:\Program Files\Good\good.exe");
        assert_eq!(resolver.visible(&catalog, "e").len(), 1);
    }

    #[test]
    fn with_install_records_a_desktop_app_with_an_install_needs_both() {
        let dir = crate::testutil::TempDir::new();
        let platform = Arc::new(SimPlatform::new(dir.path().to_path_buf()));
        let book = InstallBook::open(dir.path().join("installs.json"));
        let resolver = AppResolver::with_installs(Arc::clone(&platform) as Arc<dyn Platform>, Arc::clone(&book), dir.path().join("icons"));
        let mut app = desktop("a3", r"{ProgramFiles}\Good\good.exe");
        let preinstalled = app.clone();
        app.desktop.as_mut().unwrap().install = Some(rulebox_policy::catalog::InstallSpec {
            kind: rulebox_policy::catalog::InstallKind::Msi,
            url: "https://example.com/a.msi".into(),
            sha256: "a".repeat(64),
            size_bytes: 0,
            silent_args: Vec::new(),
            product_code: None,
            success_exit_codes: vec![0],
            remove_when_unassigned: false,
            tech: None,
            answer_file: None,
            timeout_min: None,
            publisher: None,
        });
        // The program is there (an older copy, a half-finished install): not enough.
        platform.add_file(r"C:\Program Files\Good\good.exe");
        assert!(resolver.visible(std::slice::from_ref(&app), "e").is_empty());
        // A preinstalled app (no install) is shown when its program exists.
        assert_eq!(resolver.visible(&[preinstalled], "e").len(), 1);
    }
}
