//! Tests of the L1-browser layer (Phase 6 Step 17): the catalogue table row by row, the allow-list union
//! and its limit, one permission changing one list, applying through the journal, taking everything away
//! again (values and emptied keys), drift, the root invariant and `browserReady`. All against `SimPlatform`:
//! no browser policy is ever written on the machine that runs the tests.

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::Arc;

use serde_json::{json, Value};

use super::*;
use crate::journal::{JournalEntry, JournalCtx, OriginalValue};
use crate::lockdown::apply::ApplyCtx;
use crate::lockdown::invariants::{check_browser_rows, Facts, BROWSER_KEY_OUTSIDE_ROOTS};
use crate::lockdown::runtime::machine_facts;
use crate::paths::{DataPaths, InstallPaths};
use crate::platform::sim::{sim_path_roots, SimOp, SimPlatform};
use crate::platform::{Platform, PlatformError, StaffUserSpec};
use crate::state::{AgentState, SharedState, StaffAccount, StateStore};
use crate::testutil::TempDir;

const EDGE: &str = r"Software\Policies\Microsoft\Edge";
const CHROME: &str = r"Software\Policies\Google\Chrome";
const EDGE_EXE: &str = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe";
const CHROME_EXE: &str = r"C:\Program Files\Google\Chrome\Application\chrome.exe";

// ---------------------------------------------------------------- builders

fn perms(camera: bool, microphone: bool, notifications: bool, printing: bool) -> Value {
    json!({ "camera": camera, "microphone": microphone, "screenShare": false, "clipboardRead": false,
        "notifications": notifications, "downloads": false, "printing": printing, "geolocation": false })
}

fn web_app(id: &str, browser: Value, url: &str, domains: &[&str], permissions: Value) -> CatalogApp {
    let mut web = json!({ "url": url, "allowedDomains": domains, "permissions": permissions });
    if !browser.is_null() {
        web["browser"] = browser;
    }
    serde_json::from_value(json!({
        "id": id, "name": id, "description": null, "kind": "web", "builtin": null, "web": web, "desktop": null,
        "pinnedTaskbar": false, "pinnedDesktop": false, "hue": null, "icon": null,
        "audience": "everyone", "employeeIds": [], "revision": 1
    }))
    .unwrap()
}

fn edge_web(id: &str, domains: &[&str]) -> CatalogApp {
    web_app(id, json!({ "kind": "edge" }), &format!("https://{id}.example.com/"), domains, perms(false, false, false, false))
}

fn desktop_app(id: &str, exe: &str, sites: Option<&[&str]>) -> CatalogApp {
    let mut desktop = json!({ "exe": exe, "args": [], "fileArgTemplate": [], "install": null, "resetFolders": [] });
    if let Some(sites) = sites {
        desktop["browserSites"] = json!(sites);
    }
    serde_json::from_value(json!({
        "id": id, "name": id, "description": null, "kind": "desktop", "builtin": null, "web": null, "desktop": desktop,
        "pinnedTaskbar": false, "pinnedDesktop": false, "hue": null, "icon": null,
        "audience": "everyone", "employeeIds": [], "revision": 1
    }))
    .unwrap()
}

fn chrome_exe_template() -> &'static str {
    r"{ProgramFiles}\Google\Chrome\Application\chrome.exe"
}

fn edge_exe_template() -> &'static str {
    r"{ProgramFilesX86}\Microsoft\Edge\Application\msedge.exe"
}

fn side(sites: &[&str]) -> BrowserSide {
    BrowserSide { sites: sites.iter().map(|site| format!("https://{site}")).collect(), ..BrowserSide::default() }
}

fn edge_inputs(side: BrowserSide) -> BrowserInputs {
    BrowserInputs { chrome: None, edge: Some(side) }
}

fn chrome_inputs(side: BrowserSide) -> BrowserInputs {
    BrowserInputs { chrome: Some(side), edge: None }
}

fn root_of(browser: Browser) -> &'static str {
    browser.root()
}

/// The data at `<root>\<name>`.
fn dword_of(rows: &[PolicyRow], browser: Browser, name: &str) -> Option<u32> {
    rows.iter().find(|row| row.path == root_of(browser) && row.name == name).and_then(|row| match row.data {
        RegData::Dword(value) => Some(value),
        RegData::String(_) => None,
    })
}

fn text_of(rows: &[PolicyRow], browser: Browser, name: &str) -> Option<String> {
    rows.iter().find(|row| row.path == root_of(browser) && row.name == name).and_then(|row| match &row.data {
        RegData::String(text) => Some(text.clone()),
        RegData::Dword(_) => None,
    })
}

/// The items of the list policy `name`, in list order.
fn list_of(rows: &[PolicyRow], browser: Browser, name: &str) -> Vec<String> {
    let path = format!(r"{}\{name}", root_of(browser));
    let mut items: Vec<(usize, String)> = rows
        .iter()
        .filter(|row| row.path == path)
        .map(|row| match &row.data {
            RegData::String(text) => (row.name.parse().unwrap(), text.clone()),
            RegData::Dword(_) => panic!("a list item must be text"),
        })
        .collect();
    items.sort();
    // The numbering is 1, 2, 3 ... without a gap.
    for (index, (number, _)) in items.iter().enumerate() {
        assert_eq!(*number, index + 1, "{name}");
    }
    items.into_iter().map(|(_, text)| text).collect()
}

fn policy_of(browser: Browser, row: &PolicyRow) -> String {
    if row.path == root_of(browser) {
        row.name.clone()
    } else {
        row.path.rsplit('\\').next().unwrap().to_string()
    }
}

/// The policies whose rows differ between two compiled sets.
fn changed(browser: Browser, a: &[PolicyRow], b: &[PolicyRow]) -> BTreeSet<String> {
    let only = |x: &[PolicyRow], y: &[PolicyRow]| -> Vec<String> {
        x.iter().filter(|row| !y.contains(row)).map(|row| policy_of(browser, row)).collect()
    };
    only(a, b).into_iter().chain(only(b, a)).collect()
}

fn full_side() -> BrowserSide {
    BrowserSide {
        sites: ["https://a.example.com", "https://b.example.com:8443"].iter().map(|s| (*s).to_string()).collect(),
        camera: ["https://[*.]a.example.com/".to_string()].into(),
        microphone: ["https://[*.]a.example.com/".to_string()].into(),
        notifications: ["https://[*.]b.example.com:8443/".to_string()].into(),
        printing: true,
        exe: Some(EDGE_EXE.into()),
        folder: Some(r"C:\Program Files (x86)\Microsoft\Edge\Application".into()),
    }
}

// ---------------------------------------------------------------- the rig

struct Rig {
    _dir: TempDir,
    platform: Arc<SimPlatform>,
    shared: Arc<SharedState>,
    sid: String,
}

impl Rig {
    fn new() -> Self {
        Self::build(true)
    }

    fn build(with_staff: bool) -> Self {
        let dir = TempDir::new();
        let platform = Arc::new(SimPlatform::new(dir.path().to_path_buf()));
        let spec = StaffUserSpec { user_name: "RuleboxStaff".into(), full_name: "Staff".into(), comment: "c".into() };
        let sid = platform.create_staff_user(&spec, "pw").unwrap();
        let state = AgentState {
            staff: with_staff.then(|| StaffAccount { sid: sid.clone(), user_name: "RuleboxStaff".into(), profile_dir: None }),
            ..AgentState::default()
        };
        let dyn_platform: Arc<dyn Platform> = platform.clone();
        let shared = SharedState::new(StateStore::open(&dir.path().join("state")).unwrap(), state, dyn_platform);
        Self { _dir: dir, platform, shared, sid }
    }

    fn journal_ctx(&self) -> JournalCtx<'_> {
        JournalCtx { platform: self.platform.as_ref(), shared: self.shared.as_ref() }
    }

    fn run_with(&self, inputs: &BrowserInputs, uploads: bool, version: u64) -> (BrowserOutcome, Tally) {
        let ctx = ApplyCtx {
            journal: self.journal_ctx(),
            facts: Facts { browser: inputs.clone(), ..Facts::default() },
            now_ms: 1_000,
            version,
        };
        let doc = AgentDoc { browser_uploads: uploads, ..AgentDoc::default() };
        let mut tally = Tally::default();
        let outcome = apply(&ctx, &doc, &mut tally);
        (outcome, tally)
    }

    fn run(&self, inputs: &BrowserInputs) -> (BrowserOutcome, Tally) {
        self.run_with(inputs, false, 7)
    }

    fn value(&self, path: &str, name: &str) -> Option<RegData> {
        self.platform.read_staff_value(&self.sid, path, name).unwrap()
    }

    fn set(&self, path: &str, name: &str, data: RegData) {
        self.platform.write_staff_value(&self.sid, path, name, &data).unwrap();
    }

    fn mutating(&self) -> usize {
        self.platform.calls().iter().filter(|op| op.is_mutating()).count()
    }

    fn journal(&self) -> Vec<JournalEntry> {
        self.shared.read(|state| state.journal.clone())
    }

    fn staff_values(&self) -> usize {
        self.platform.with_world(|world| world.staff_values.len())
    }

    fn keys_removed(&self) -> Vec<String> {
        self.platform.with_world(|world| world.staff_keys_removed.clone())
    }
}

// ---------------------------------------------------------------- the table, row by row

#[test]
fn every_fixed_row_is_compiled_for_the_browsers_that_have_it_and_for_no_other() {
    for browser in Browser::ALL {
        let rows = compile(browser, &BrowserSide::default(), false).unwrap();
        for fixed in FIXED_ROWS {
            let name = match browser {
                Browser::Chrome => fixed.chrome,
                Browser::Edge => fixed.edge,
            };
            let Some(name) = name else { continue };
            match fixed.value {
                Fixed::Dword(value) => assert_eq!(dword_of(&rows, browser, name), Some(value), "{browser:?} {name}"),
                Fixed::Text(text) => assert_eq!(text_of(&rows, browser, name).as_deref(), Some(text), "{browser:?} {name}"),
                Fixed::List(items) => assert_eq!(list_of(&rows, browser, name), items, "{browser:?} {name}"),
            }
        }
        // Nothing is written twice, and every row is below this browser's root.
        let ids: BTreeSet<String> = rows.iter().map(PolicyRow::id).collect();
        assert_eq!(ids.len(), rows.len(), "{browser:?}: a row twice");
        assert!(rows.iter().all(|row| row.path == root_of(browser) || row.path.starts_with(&format!(r"{}\", root_of(browser)))));
    }
}

/// One test per vendor value of plan 4.9.3, so a changed value shows up here by name.
#[test]
fn the_values_are_the_ones_the_vendors_document() {
    let chrome = compile(Browser::Chrome, &BrowserSide::default(), false).unwrap();
    let edge = compile(Browser::Edge, &BrowserSide::default(), false).unwrap();
    for (browser, rows) in [(Browser::Chrome, &chrome), (Browser::Edge, &edge)] {
        assert_eq!(dword_of(rows, browser, "DeveloperToolsAvailability"), Some(2), "2 = never");
        assert_eq!(dword_of(rows, browser, "DownloadRestrictions"), Some(3), "3 = block all downloads");
        assert_eq!(dword_of(rows, browser, "BrowserGuestModeEnabled"), Some(0));
        assert_eq!(dword_of(rows, browser, "BrowserSignin"), Some(0), "0 = sign-in disabled");
        assert_eq!(dword_of(rows, browser, "SyncDisabled"), Some(1));
        assert_eq!(dword_of(rows, browser, "PasswordManagerEnabled"), Some(0));
        assert_eq!(list_of(rows, browser, "ExtensionInstallBlocklist"), ["*"]);
        assert_eq!(dword_of(rows, browser, "DefaultGeolocationSetting"), Some(2), "2 = block");
        assert_eq!(dword_of(rows, browser, "DefaultNotificationsSetting"), Some(2));
        assert_eq!(dword_of(rows, browser, "DefaultClipboardSetting"), Some(2));
        assert_eq!(dword_of(rows, browser, "ScreenCaptureAllowed"), Some(0));
        assert_eq!(dword_of(rows, browser, "VideoCaptureAllowed"), Some(0));
        assert_eq!(dword_of(rows, browser, "AudioCaptureAllowed"), Some(0));
        assert_eq!(dword_of(rows, browser, "ExternalProtocolDialogShowAlwaysOpenCheckbox"), Some(0));
        assert_eq!(dword_of(rows, browser, "BackgroundModeEnabled"), Some(0));
        // Deliberately not written: the vendors document no empty value (unset = nothing launches without a prompt).
        assert_eq!(dword_of(rows, browser, "AutoLaunchProtocolsFromOrigins"), None);
        assert_eq!(text_of(rows, browser, "AutoLaunchProtocolsFromOrigins"), None);
    }
    // Where the two vendors name the same thing differently.
    assert_eq!(dword_of(&chrome, Browser::Chrome, "IncognitoModeAvailability"), Some(1), "1 = disabled");
    assert_eq!(dword_of(&edge, Browser::Edge, "InPrivateModeAvailability"), Some(1));
    assert_eq!(dword_of(&chrome, Browser::Chrome, "BrowserAddPersonEnabled"), Some(0));
    assert_eq!(dword_of(&edge, Browser::Edge, "BrowserAddProfileEnabled"), Some(0));
    for name in ["InPrivateModeAvailability", "BrowserAddProfileEnabled", "StartupBoostEnabled", "SleepingTabsEnabled", "EfficiencyModeEnabled"] {
        assert_eq!(dword_of(&chrome, Browser::Chrome, name), None, "Chrome has no {name}");
    }
    for name in ["IncognitoModeAvailability", "BrowserAddPersonEnabled", "HighEfficiencyModeEnabled"] {
        assert_eq!(dword_of(&edge, Browser::Edge, name), None, "Edge has no {name}");
    }
    assert_eq!(dword_of(&edge, Browser::Edge, "StartupBoostEnabled"), Some(0));
    assert_eq!(dword_of(&edge, Browser::Edge, "SleepingTabsEnabled"), Some(1));
    assert_eq!(dword_of(&edge, Browser::Edge, "EfficiencyModeEnabled"), Some(1));
    assert_eq!(dword_of(&chrome, Browser::Chrome, "HighEfficiencyModeEnabled"), Some(1));
    // Edge's shortcut policy is one JSON text, and Chrome has none.
    let shortcuts: Value = serde_json::from_str(&text_of(&edge, Browser::Edge, "ConfigureKeyboardShortcuts").unwrap()).unwrap();
    let disabled: Vec<&str> = shortcuts["disabled"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
    for command in ["new_window", "new_inprivate_window", "downloads", "history"] {
        assert!(disabled.contains(&command), "{command}");
    }
    assert_eq!(text_of(&chrome, Browser::Chrome, "ConfigureKeyboardShortcuts"), None);
}

#[test]
fn the_block_list_blocks_everything_first_and_the_browsers_own_internal_pages() {
    let chrome = list_of(&compile(Browser::Chrome, &BrowserSide::default(), false).unwrap(), Browser::Chrome, "URLBlocklist");
    let edge = list_of(&compile(Browser::Edge, &BrowserSide::default(), false).unwrap(), Browser::Edge, "URLBlocklist");
    for list in [&chrome, &edge] {
        assert_eq!(list[0], "*");
        for pattern in ["file://*", "view-source:*", "javascript:*", "data:*", "ftp://*"] {
            assert!(list.iter().any(|item| item == pattern), "{pattern}");
        }
    }
    // From Chrome 147 a bare `*` no longer covers `chrome://`.
    assert!(chrome.contains(&"chrome://*".to_string()) && !chrome.contains(&"edge://*".to_string()));
    assert!(edge.contains(&"edge://*".to_string()) && !edge.contains(&"chrome://*".to_string()));
}

#[test]
fn without_an_allowed_site_the_allow_list_is_not_written_at_all() {
    let rows = compile(Browser::Chrome, &BrowserSide::default(), false).unwrap();
    assert!(rows.iter().all(|row| !row.path.ends_with("URLAllowlist")));
    // The browser then opens to its blocked page: everything is on the block list.
    assert_eq!(list_of(&rows, Browser::Chrome, "URLBlocklist")[0], "*");
}

// ---------------------------------------------------------------- the allow list

#[test]
fn the_allow_list_is_the_union_of_the_apps_and_the_programs_sites() {
    let catalog = vec![
        web_app("w1", json!({ "kind": "edge" }), "https://orders.example.com/start", &["cdn.example.com", "*.assets.example.com"], perms(false, false, false, false)),
        web_app("w2", json!({ "kind": "edge" }), "https://orders.example.com:8443/x", &["cdn.example.com", "Bad_Domain", "https://nope.example.com/"], perms(false, false, false, false)),
        // Built-in: no browser, no pattern.
        web_app("w3", Value::Null, "https://builtin.example.com/", &[], perms(true, true, true, true)),
        desktop_app("edge", edge_exe_template(), Some(&["portal.example.com", "*.assets.example.com"])),
    ];
    let inputs = BrowserInputs::from_catalog(&catalog, Some(&sim_path_roots()), &|_| false);
    assert!(inputs.chrome.is_none());
    let edge = inputs.edge.as_ref().unwrap();
    let expected = [
        "https://assets.example.com",
        "https://cdn.example.com",
        "https://orders.example.com",
        "https://orders.example.com:8443",
        "https://portal.example.com",
    ];
    assert_eq!(edge.sites.iter().map(String::as_str).collect::<Vec<_>>(), expected);
    let rows = compile(Browser::Edge, edge, false).unwrap();
    assert_eq!(list_of(&rows, Browser::Edge, "URLAllowlist"), expected);
}

#[test]
fn eight_hundred_addresses_fit_and_801_do_not() {
    let many = |count: usize| BrowserSide {
        sites: (0..count).map(|i| format!("https://d{i}.example.com")).collect(),
        ..BrowserSide::default()
    };
    let rows = compile(Browser::Edge, &many(800), false).unwrap();
    assert_eq!(list_of(&rows, Browser::Edge, "URLAllowlist").len(), 800);
    assert_eq!(compile(Browser::Edge, &many(801), false), Err(CompileError::TooManyUrls));
    assert_eq!(CompileError::TooManyUrls.code(), "browser_too_many_urls");

    // Applying 801: nothing is written for that browser, the layer says why, and the browser is not ready.
    let rig = Rig::new();
    let (outcome, tally) = rig.run(&edge_inputs(many(801)));
    assert_eq!(rig.staff_values(), 0);
    assert_eq!(rig.journal().len(), 0);
    assert_eq!(tally.first_error, Some("browser_too_many_urls"));
    assert!(outcome.ready.is_empty() && outcome.active);
}

// ---------------------------------------------------------------- one switch, one list

#[test]
fn a_permission_flip_changes_exactly_one_list() {
    let base = full_side();
    let rows = |side: &BrowserSide, uploads: bool| compile(Browser::Edge, side, uploads).unwrap();
    let with = rows(&base, false);

    let mut no_camera = base.clone();
    no_camera.camera.clear();
    assert_eq!(changed(Browser::Edge, &with, &rows(&no_camera, false)), BTreeSet::from(["VideoCaptureAllowedUrls".to_string()]));

    let mut no_microphone = base.clone();
    no_microphone.microphone.clear();
    assert_eq!(changed(Browser::Edge, &with, &rows(&no_microphone, false)), BTreeSet::from(["AudioCaptureAllowedUrls".to_string()]));

    let mut no_notifications = base.clone();
    no_notifications.notifications.clear();
    assert_eq!(changed(Browser::Edge, &with, &rows(&no_notifications, false)), BTreeSet::from(["NotificationsAllowedForUrls".to_string()]));

    let mut no_printing = base.clone();
    no_printing.printing = false;
    assert_eq!(changed(Browser::Edge, &with, &rows(&no_printing, false)), BTreeSet::from(["PrintingEnabled".to_string()]));

    // The group's upload switch is one value.
    assert_eq!(changed(Browser::Edge, &with, &rows(&base, true)), BTreeSet::from(["AllowFileSelectionDialogs".to_string()]));

    // Taking a site away changes the allow list only.
    let mut fewer = base.clone();
    fewer.sites.remove("https://b.example.com:8443");
    assert_eq!(changed(Browser::Edge, &with, &rows(&fewer, false)), BTreeSet::from(["URLAllowlist".to_string()]));
}

#[test]
fn the_per_origin_lists_follow_the_apps_whose_permission_is_on() {
    let catalog = vec![
        web_app("cam", json!({ "kind": "edge" }), "https://cam.example.com/", &["media.example.com"], perms(true, false, false, false)),
        web_app("mic", json!({ "kind": "edge" }), "https://mic.example.com:8443/", &[], perms(false, true, true, false)),
        web_app("none", json!({ "kind": "edge" }), "https://none.example.com/", &[], perms(false, false, false, false)),
        web_app("print", json!({ "kind": "edge" }), "https://print.example.com/", &[], perms(false, false, false, true)),
    ];
    let inputs = BrowserInputs::from_catalog(&catalog, Some(&sim_path_roots()), &|_| false);
    let rows = compile(Browser::Edge, inputs.edge.as_ref().unwrap(), false).unwrap();
    assert_eq!(list_of(&rows, Browser::Edge, "VideoCaptureAllowedUrls"), ["https://[*.]cam.example.com/", "https://[*.]media.example.com/"]);
    assert_eq!(list_of(&rows, Browser::Edge, "AudioCaptureAllowedUrls"), ["https://[*.]mic.example.com:8443/"]);
    assert_eq!(list_of(&rows, Browser::Edge, "NotificationsAllowedForUrls"), ["https://[*.]mic.example.com:8443/"]);
    // One switch for the whole browser (plan 4.9.8): any app that prints turns printing on.
    assert_eq!(dword_of(&rows, Browser::Edge, "PrintingEnabled"), Some(1));
    // A browser with no printing app and no upload switch: both off.
    let quiet = compile(Browser::Edge, &side(&["a.example.com"]), false).unwrap();
    assert_eq!((dword_of(&quiet, Browser::Edge, "PrintingEnabled"), dword_of(&quiet, Browser::Edge, "AllowFileSelectionDialogs")), (Some(0), Some(0)));
}

// ---------------------------------------------------------------- inputs from the catalogue

#[test]
fn the_catalogue_says_which_browsers_are_wanted_and_where_they_are() {
    let roots = sim_path_roots();
    let none = |_: &str| false;
    // Nothing assigned.
    assert!(BrowserInputs::from_catalog(&[web_app("w", Value::Null, "https://a.example.com/", &[], perms(false, false, false, false))], Some(&roots), &none).is_empty());
    assert!(BrowserInputs::from_catalog(&[], Some(&roots), &none).is_empty());

    // An Edge web app wants Edge only; Edge's program is found at its per-machine folder (x86 first).
    let edge = [edge_web("w", &[])];
    let exists_x86 = |path: &str| path == EDGE_EXE;
    let inputs = BrowserInputs::from_catalog(&edge, Some(&roots), &exists_x86);
    assert!(inputs.chrome.is_none());
    let side = inputs.edge.as_ref().unwrap();
    assert_eq!((side.exe.as_deref(), side.folder.as_deref()), (Some(EDGE_EXE), Some(r"C:\Program Files (x86)\Microsoft\Edge\Application")));
    assert_eq!(inputs.allow_folders(), [r"C:\Program Files (x86)\Microsoft\Edge\Application"]);
    // Not installed: wanted, but no program and no folder rule.
    let missing = BrowserInputs::from_catalog(&edge, Some(&roots), &none);
    assert!(missing.edge.is_some() && missing.edge.as_ref().unwrap().exe.is_none() && missing.allow_folders().is_empty());
    // The 64-bit folder is found too.
    let in_pf = |path: &str| path == r"C:\Program Files\Microsoft\Edge\Application\msedge.exe";
    assert_eq!(BrowserInputs::from_catalog(&edge, Some(&roots), &in_pf).allow_folders(), [r"C:\Program Files\Microsoft\Edge\Application"]);

    // A Chrome web app needs the Chrome program of this catalogue.
    let chrome_web = web_app("w", json!({ "kind": "chrome", "appId": "chrome" }), "https://a.example.com/", &[], perms(false, false, false, false));
    let alone = BrowserInputs::from_catalog(std::slice::from_ref(&chrome_web), Some(&roots), &none);
    assert!(alone.is_empty(), "no Chrome program in the catalogue: the Staff App opens the built-in window");
    let renamed = [chrome_web.clone(), desktop_app("chrome", r"{ProgramFiles}\Writer\writer.exe", None)];
    assert!(BrowserInputs::from_catalog(&renamed, Some(&roots), &none).is_empty());
    let both = [chrome_web.clone(), desktop_app("chrome", chrome_exe_template(), None)];
    let exists_chrome = |path: &str| path == CHROME_EXE;
    let inputs = BrowserInputs::from_catalog(&both, Some(&roots), &exists_chrome);
    assert!(inputs.edge.is_none());
    let side = inputs.chrome.as_ref().unwrap();
    assert_eq!((side.exe.as_deref(), side.folder.as_deref()), (Some(CHROME_EXE), Some(r"C:\Program Files\Google\Chrome\Application")));
    assert_eq!(side.sites, BTreeSet::from(["https://a.example.com".to_string()]));

    // A Chrome program on its own wants Chrome with no allowed site: the browser's blocked page.
    let program = [desktop_app("chrome", chrome_exe_template(), None)];
    let side = BrowserInputs::from_catalog(&program, Some(&roots), &none).chrome.unwrap();
    assert!(side.sites.is_empty());
    // An Edge program by its file name, with its own sites; a program of another name wants nothing.
    let edge_program = [desktop_app("e", r"{ProgramFiles}\Anywhere\MSEdge.EXE", Some(&["x.example.com"])), desktop_app("w", r"{ProgramFiles}\Writer\writer.exe", Some(&["y.example.com"]))];
    let inputs = BrowserInputs::from_catalog(&edge_program, Some(&roots), &none);
    assert_eq!(inputs.edge.unwrap().sites, BTreeSet::from(["https://x.example.com".to_string()]));
    assert!(inputs.chrome.is_none());
    // Unknown program folders (no roots): the policies still follow the catalogue, there is just no folder.
    assert!(BrowserInputs::from_catalog(&edge, None, &none).edge.is_some());
}

#[test]
fn the_browser_folder_is_a_staff_path_rule_only_while_a_browser_is_assigned() {
    let dir = TempDir::new();
    let sim = SimPlatform::new(dir.path().to_path_buf());
    let paths = DataPaths::new(dir.path().to_path_buf());
    let install = InstallPaths::new(PathBuf::from(sim_path_roots().program_files).join("Rulebox"));
    sim.add_file(EDGE_EXE);
    let assigned = json!({ "catalog": [serde_json::to_value(edge_web("w", &[])).unwrap()] });
    let facts = machine_facts(&sim, &install, &paths, false, &assigned);
    let folder = r"C:\Program Files (x86)\Microsoft\Edge\Application".to_string();
    assert_eq!(facts.catalogue_exe_folders, std::slice::from_ref(&folder));
    assert_eq!(facts.browser.edge.as_ref().and_then(|side| side.exe.as_deref()), Some(EDGE_EXE));

    // The allow-list compiler turns that folder into a path rule for the Staff SID (it is admin-only).
    let roots = sim_path_roots();
    let admin_only = "D:PAI(A;OICI;FA;;;BA)(A;OICI;FA;;;SY)(A;OICI;0x1200a9;;;BU)";
    let build = |folders: &[String]| {
        crate::lockdown::allowlist::build(
            &crate::lockdown::allowlist::Inputs {
                roots: &roots,
                protected: &[],
                catalogue_folders: folders,
                exceptions: &[],
                accessibility_tools: false,
                windows_scan: &[],
                staff_sid: "S-1-5-21-1-1-1-2001",
            },
            |_| Ok(Some(admin_only.to_string())),
        )
        .unwrap()
    };
    assert_eq!(build(&facts.catalogue_exe_folders).catalogue, std::slice::from_ref(&folder));

    // Unassigned (or the same document without the web app): no rule, and Edge is blocked for Staff again.
    let unassigned = machine_facts(&sim, &install, &paths, false, &json!({ "catalog": [] }));
    assert!(unassigned.catalogue_exe_folders.is_empty() && unassigned.browser.is_empty());
    assert!(build(&unassigned.catalogue_exe_folders).catalogue.is_empty());

    // A browser folder that standard users can write to is refused like any catalogue folder.
    let writable = crate::lockdown::allowlist::build(
        &crate::lockdown::allowlist::Inputs {
            roots: &roots,
            protected: &[],
            catalogue_folders: std::slice::from_ref(&folder),
            exceptions: &[],
            accessibility_tools: false,
            windows_scan: &[],
            staff_sid: "S-1-5-21-1-1-1-2001",
        },
        |_| Ok(Some("D:PAI(A;OICI;FA;;;BU)".to_string())),
    )
    .unwrap();
    assert!(writable.catalogue.is_empty() && writable.notes.contains(&"catalogue_folder_writable"));
}

// ---------------------------------------------------------------- apply

#[test]
fn applying_writes_every_row_through_the_journal_and_a_second_run_writes_nothing() {
    let rig = Rig::new();
    let inputs = edge_inputs(full_side());
    let rows = compile(Browser::Edge, &full_side(), false).unwrap();
    let (outcome, tally) = rig.run(&inputs);
    assert_eq!((tally.status(), tally.first_error), (crate::lockdown::LayerStatus::Ok, None));
    assert!(outcome.active);
    assert_eq!(outcome.ready, BTreeSet::from(["edge".to_string()]));
    for row in &rows {
        assert_eq!(rig.value(&row.path, &row.name), Some(row.data.clone()), "{} {}", row.path, row.name);
    }
    let journal = rig.journal();
    assert_eq!(journal.len(), rows.len());
    for entry in &journal {
        assert_eq!((entry.owner, entry.phase, entry.since_version, entry.original.clone()), (JournalOwner::L1Browser, EntryPhase::Applied, 7, OriginalValue::Absent), "{}", entry.id);
    }
    assert!(!rig.platform.with_world(|world| world.staff_values.is_empty()));
    // Nothing was written for Chrome.
    assert!(rig.platform.with_world(|world| world.staff_values.keys().all(|(_, path, _)| path.starts_with(&EDGE.to_ascii_lowercase()))));

    let before = rig.mutating();
    let (again, _) = rig.run(&inputs);
    assert_eq!(rig.mutating(), before, "the same document writes nothing");
    assert_eq!(again.ready, outcome.ready);
    assert_eq!(rig.journal().len(), rows.len());
    assert!(rig.shared.read(|state| is_ready(state, Browser::Edge) && !is_ready(state, Browser::Chrome)));
}

#[test]
fn the_state_survives_through_the_agent_state_file() {
    let rig = Rig::new();
    rig.run(&edge_inputs(full_side()));
    let json = serde_json::to_string(&rig.shared.get()).unwrap();
    assert!(json.contains(r#""browserReady":["edge"]"#), "{json}");
    let back: AgentState = serde_json::from_str(&json).unwrap();
    assert_eq!(back.browser_ready, BTreeSet::from(["edge".to_string()]));
    // An older state file has no such key.
    let old: AgentState = serde_json::from_str("{}").unwrap();
    assert!(old.browser_ready.is_empty());
    // The owner is written as `l1-browser`.
    assert_eq!(serde_json::to_value(JournalOwner::L1Browser).unwrap(), json!("l1-browser"));
}

#[test]
fn both_browsers_are_applied_side_by_side() {
    let rig = Rig::new();
    let both = BrowserInputs { chrome: Some(side(&["c.example.com"])), edge: Some(side(&["e.example.com"])) };
    let (outcome, _) = rig.run(&both);
    assert_eq!(outcome.ready, BTreeSet::from(["chrome".to_string(), "edge".to_string()]));
    assert_eq!(rig.value(&format!(r"{CHROME}\URLAllowlist"), "1"), Some(RegData::String("https://c.example.com".into())));
    assert_eq!(rig.value(&format!(r"{EDGE}\URLAllowlist"), "1"), Some(RegData::String("https://e.example.com".into())));
    // Only Chrome goes: Edge keeps every value.
    let edge_values = rig.platform.with_world(|world| world.staff_values.keys().filter(|(_, path, _)| path.starts_with(&EDGE.to_ascii_lowercase())).count());
    rig.run(&edge_inputs(side(&["e.example.com"])));
    assert_eq!(rig.platform.with_world(|world| world.staff_values.keys().filter(|(_, path, _)| path.starts_with(&CHROME.to_ascii_lowercase())).count()), 0);
    assert_eq!(rig.platform.with_world(|world| world.staff_values.keys().filter(|(_, path, _)| path.starts_with(&EDGE.to_ascii_lowercase())).count()), edge_values);
    assert!(rig.shared.read(|state| !is_ready(state, Browser::Chrome) && is_ready(state, Browser::Edge)));
}

#[test]
fn a_site_taken_away_removes_its_list_value_and_a_site_added_extends_the_list() {
    let rig = Rig::new();
    rig.run(&chrome_inputs(side(&["a.example.com", "b.example.com", "c.example.com"])));
    let list = format!(r"{CHROME}\URLAllowlist");
    assert_eq!(rig.value(&list, "3"), Some(RegData::String("https://c.example.com".into())));
    rig.run_with(&chrome_inputs(side(&["a.example.com", "c.example.com"])), false, 8);
    assert_eq!(rig.value(&list, "1"), Some(RegData::String("https://a.example.com".into())));
    assert_eq!(rig.value(&list, "2"), Some(RegData::String("https://c.example.com".into())));
    assert_eq!(rig.value(&list, "3"), None, "the third value is gone, not left behind");
    assert!(rig.journal().iter().all(|entry| entry.id != journal::staff_id(&list, "3")));
    rig.run_with(&chrome_inputs(side(&["a.example.com", "c.example.com", "d.example.com"])), false, 9);
    assert_eq!(rig.value(&list, "3"), Some(RegData::String("https://d.example.com".into())));
}

#[test]
fn the_upload_switch_writes_the_file_dialog_value() {
    let rig = Rig::new();
    let inputs = edge_inputs(side(&["a.example.com"]));
    rig.run_with(&inputs, false, 7);
    assert_eq!(rig.value(EDGE, "AllowFileSelectionDialogs"), Some(RegData::Dword(0)));
    rig.run_with(&inputs, true, 8);
    assert_eq!(rig.value(EDGE, "AllowFileSelectionDialogs"), Some(RegData::Dword(1)));
    rig.run_with(&inputs, false, 9);
    assert_eq!(rig.value(EDGE, "AllowFileSelectionDialogs"), Some(RegData::Dword(0)));
}

#[test]
fn unassigning_the_last_browser_removes_every_value_and_the_emptied_keys() {
    let rig = Rig::new();
    rig.run(&BrowserInputs { chrome: Some(side(&["c.example.com"])), edge: Some(full_side()) });
    assert!(rig.staff_values() > 40);
    let (outcome, tally) = rig.run(&BrowserInputs::default());
    assert_eq!(rig.staff_values(), 0, "no value is left behind");
    assert!(rig.journal().is_empty());
    assert!(!outcome.active && outcome.ready.is_empty());
    assert_eq!(tally.status(), crate::lockdown::LayerStatus::Ok);
    assert!(rig.shared.read(|state| state.browser_ready.is_empty() && !is_ready(state, Browser::Edge)));
    // The roots and the list keys were emptied by Rulebox and are removed, deepest first.
    let removed = rig.keys_removed();
    for root in [CHROME, EDGE] {
        let root = root.to_ascii_lowercase();
        assert!(removed.contains(&root), "{root} in {removed:?}");
        assert!(removed.contains(&format!(r"{root}\urlblocklist")));
        let list_at = removed.iter().position(|key| *key == format!(r"{root}\urlblocklist")).unwrap();
        let root_at = removed.iter().position(|key| *key == root).unwrap();
        assert!(list_at < root_at, "a list key goes before its root");
    }
    // Nothing else was removed.
    assert!(removed.iter().all(|key| key.starts_with(&CHROME.to_ascii_lowercase()) || key.starts_with(&EDGE.to_ascii_lowercase())));
}

#[test]
fn a_key_that_still_holds_something_stays_and_an_original_value_comes_back() {
    let rig = Rig::new();
    // The administrator's own values in the Staff hive: one with a name Rulebox does not use, one it overwrites.
    rig.set(EDGE, "SomethingElse", RegData::Dword(5));
    rig.set(EDGE, "DeveloperToolsAvailability", RegData::Dword(0));
    rig.run(&edge_inputs(full_side()));
    assert_eq!(rig.value(EDGE, "DeveloperToolsAvailability"), Some(RegData::Dword(2)));
    let entry = rig.journal().into_iter().find(|entry| entry.id == journal::staff_id(EDGE, "DeveloperToolsAvailability")).unwrap();
    assert_eq!(entry.original, OriginalValue::Dword(0));
    rig.run(&BrowserInputs::default());
    assert_eq!(rig.value(EDGE, "DeveloperToolsAvailability"), Some(RegData::Dword(0)), "the original is exact");
    assert_eq!(rig.value(EDGE, "SomethingElse"), Some(RegData::Dword(5)));
    let removed = rig.keys_removed();
    assert!(!removed.contains(&EDGE.to_ascii_lowercase()), "a root that holds a value Rulebox did not write stays");
    assert!(removed.contains(&format!(r"{}\urlblocklist", EDGE.to_ascii_lowercase())));
}

#[test]
fn a_value_changed_behind_our_back_is_written_again() {
    let rig = Rig::new();
    let inputs = edge_inputs(full_side());
    rig.run(&inputs);
    rig.set(EDGE, "DeveloperToolsAvailability", RegData::Dword(0));
    rig.set(&format!(r"{EDGE}\URLBlocklist"), "1", RegData::String("example.org".into()));
    let (_, tally) = rig.run(&inputs);
    assert_eq!(tally.first_error, None);
    assert_eq!(rig.value(EDGE, "DeveloperToolsAvailability"), Some(RegData::Dword(2)));
    assert_eq!(rig.value(&format!(r"{EDGE}\URLBlocklist"), "1"), Some(RegData::String("*".into())));
    // The original that was recorded the first time is still the one that comes back.
    assert!(rig.journal().iter().all(|entry| entry.original == OriginalValue::Absent));
}

#[test]
fn disable_kiosk_unenroll_and_recover_restore_everything_the_browser_layer_wrote() {
    for (name, restore) in [
        ("restore_all (Disable kiosk, unenroll)", (|ctx: &JournalCtx<'_>| journal::restore_all(ctx)) as fn(&JournalCtx<'_>) -> journal::RestoreReport),
        ("restore_owner", |ctx: &JournalCtx<'_>| journal::restore_owner(ctx, JournalOwner::L1Browser)),
    ] {
        let rig = Rig::new();
        rig.run(&BrowserInputs { chrome: Some(side(&["c.example.com"])), edge: Some(full_side()) });
        assert!(rig.staff_values() > 0);
        let report = restore(&rig.journal_ctx());
        assert!(report.is_complete(), "{name}: {:?}", report.failed_ids());
        assert_eq!(rig.staff_values(), 0, "{name}");
        assert!(rig.journal().is_empty(), "{name}");
        assert!(rig.keys_removed().contains(&EDGE.to_ascii_lowercase()) && rig.keys_removed().contains(&CHROME.to_ascii_lowercase()), "{name}");
        // The mark outlives the restore, but readiness does not: no rows, no `browserReady`.
        assert!(rig.shared.read(|state| !is_ready(state, Browser::Edge) && !is_ready(state, Browser::Chrome)), "{name}");
    }
    // `recover` restores entry by entry.
    let rig = Rig::new();
    rig.run(&edge_inputs(full_side()));
    for entry in rig.journal().iter().rev() {
        journal::restore_entry(&rig.journal_ctx(), &entry.id).unwrap();
    }
    assert_eq!(rig.staff_values(), 0);
}

#[test]
fn the_last_known_good_rollback_includes_the_browser_rows_of_the_failed_version() {
    assert!(crate::lockdown::lkg::ROLLBACK_OWNERS.contains(&JournalOwner::L1Browser));
    let rig = Rig::new();
    rig.run_with(&edge_inputs(side(&["old.example.com"])), false, 5);
    rig.run_with(&edge_inputs(BrowserSide { camera: ["https://[*.]old.example.com/".to_string()].into(), ..side(&["old.example.com", "new.example.com"]) }), false, 9);
    let report = journal::restore_owned_after(&rig.journal_ctx(), &crate::lockdown::lkg::ROLLBACK_OWNERS, 5);
    assert!(report.is_complete());
    // What version 9 wrote first is gone; what version 5 wrote first stays until the last-known-good
    // document is applied over it (the journal restores by the first writer, plan 4.11).
    assert_eq!(rig.value(&format!(r"{EDGE}\URLAllowlist"), "2"), None);
    assert_eq!(rig.value(&format!(r"{EDGE}\VideoCaptureAllowedUrls"), "1"), None);
    assert_eq!(rig.value(EDGE, "DeveloperToolsAvailability"), Some(RegData::Dword(2)));
    rig.run_with(&edge_inputs(side(&["old.example.com"])), false, 5);
    assert_eq!(rig.value(&format!(r"{EDGE}\URLAllowlist"), "1"), Some(RegData::String("https://old.example.com".into())));
}

#[test]
fn without_a_staff_account_nothing_is_written_and_nothing_is_ready() {
    let rig = Rig::build(false);
    let (outcome, tally) = rig.run(&edge_inputs(full_side()));
    assert_eq!(rig.staff_values(), 0);
    assert!(rig.journal().is_empty() && outcome.ready.is_empty());
    assert_eq!(tally.first_error, Some("no_staff_account"));
    assert_eq!(tally.status(), crate::lockdown::LayerStatus::Failed);
}

#[test]
fn a_failed_write_is_not_ready_until_a_later_run_completes() {
    let rig = Rig::new();
    let inputs = edge_inputs(full_side());
    rig.platform.fail_nth(SimOp::WriteStaffValue, 3, PlatformError::AccessDenied);
    let (outcome, tally) = rig.run(&inputs);
    assert_eq!(tally.first_error, Some("access_denied"));
    assert_eq!(tally.status(), crate::lockdown::LayerStatus::Partial);
    assert!(outcome.ready.is_empty());
    assert!(rig.shared.read(|state| !is_ready(state, Browser::Edge)), "the apps list never says ready");
    let (outcome, tally) = rig.run(&inputs);
    assert_eq!(tally.first_error, None);
    assert_eq!(outcome.ready, BTreeSet::from(["edge".to_string()]));
    assert!(rig.shared.read(|state| is_ready(state, Browser::Edge)));
}

#[test]
fn a_failed_restore_keeps_the_browser_not_ready_and_the_entry_for_the_next_run() {
    let rig = Rig::new();
    rig.run(&edge_inputs(side(&["a.example.com", "b.example.com"])));
    rig.platform.fail_next(SimOp::DeleteStaffValue, PlatformError::AccessDenied);
    let (outcome, tally) = rig.run(&edge_inputs(side(&["a.example.com"])));
    assert_eq!(tally.first_error, Some("access_denied"));
    assert!(outcome.ready.is_empty(), "a site that could not be taken away is not a finished policy");
    assert!(rig.value(&format!(r"{EDGE}\URLAllowlist"), "2").is_some());
    let (outcome, _) = rig.run(&edge_inputs(side(&["a.example.com"])));
    assert_eq!(outcome.ready, BTreeSet::from(["edge".to_string()]));
    assert_eq!(rig.value(&format!(r"{EDGE}\URLAllowlist"), "2"), None);
}

// ---------------------------------------------------------------- the staff layer

#[test]
fn the_staff_layer_carries_the_browser_rows_and_reports_on() {
    use crate::lockdown::{staff, ReportedMode};
    let rig = Rig::new();
    let ctx = ApplyCtx {
        journal: rig.journal_ctx(),
        facts: Facts { browser: edge_inputs(side(&["a.example.com"])), ..Facts::default() },
        now_ms: 1_000,
        version: 7,
    };
    // No `lockdown` section at all: the layer used to say off; with a browser assigned it is on.
    let state = staff::apply(&ctx, &AgentDoc::default());
    assert_eq!((state.mode, state.state), (ReportedMode::On, crate::lockdown::LayerStatus::Ok));
    assert!(rig.value(EDGE, "DeveloperToolsAvailability").is_some());
    let none = ApplyCtx { journal: rig.journal_ctx(), facts: Facts::default(), now_ms: 1_000, version: 8 };
    let state = staff::apply(&none, &AgentDoc::default());
    assert_eq!((state.mode, state.state), (ReportedMode::Off, crate::lockdown::LayerStatus::Ok));
    assert_eq!(rig.staff_values(), 0);
}

#[test]
fn a_document_with_no_browser_touches_nothing() {
    let rig = Rig::new();
    let (outcome, tally) = rig.run(&BrowserInputs::default());
    assert_eq!(rig.mutating(), 1, "only the account the rig created");
    assert!(!outcome.active && outcome.ready.is_empty());
    assert_eq!(tally.status(), crate::lockdown::LayerStatus::Ok);
}

// ---------------------------------------------------------------- the invariant

#[test]
fn a_browser_write_can_never_name_a_key_outside_the_two_roots() {
    // Everything this layer compiles passes, for every shape of input.
    for browser in Browser::ALL {
        for side in [BrowserSide::default(), full_side()] {
            for uploads in [false, true] {
                let rows = compile(browser, &side, uploads).unwrap();
                assert_eq!(check_browser_rows(rows.iter().map(|row| (row.path.as_str(), row.name.as_str()))), Ok(()));
            }
        }
    }
    // Anything else does not, even a key that the Staff hive otherwise allows.
    for path in [
        r"Software\Microsoft\Windows\CurrentVersion\Policies\Explorer",
        r"Software\Policies\Microsoft\Windows\System",
        r"Software\Policies\Microsoft\EdgeUpdate",
        r"Software\Policies\Google\Chromium",
        r"Software\Policies\Google",
        r"Software\Policies\Microsoft\Edge\..\EdgeUpdate",
        r"Software\Classes",
        "",
    ] {
        assert_eq!(check_browser_rows([(path, "X")]), Err(BROWSER_KEY_OUTSIDE_ROOTS), "{path}");
    }
    // The Staff shell value is never written, whatever the key.
    assert_eq!(check_browser_rows([(EDGE, "Shell")]), Err(BROWSER_KEY_OUTSIDE_ROOTS));
    // One bad row refuses the set.
    assert_eq!(check_browser_rows([(EDGE, "A"), (r"Software\Classes", "B")]), Err(BROWSER_KEY_OUTSIDE_ROOTS));
}

#[test]
fn the_platform_refuses_a_browser_key_removal_outside_the_roots_and_a_write_never_leaves_them() {
    let rig = Rig::new();
    for path in [r"Software\Microsoft\Windows\CurrentVersion\Policies\System", r"Software\Policies\Microsoft\Edge2"] {
        assert!(rig.platform.delete_staff_key_if_empty(&rig.sid, path).is_err(), "{path}");
    }
    assert!(rig.platform.delete_staff_key_if_empty(&rig.sid, EDGE).unwrap());
    rig.set(EDGE, "X", RegData::Dword(1));
    assert!(!rig.platform.delete_staff_key_if_empty(&rig.sid, EDGE).unwrap());
    // Every value an apply wrote is below a root.
    rig.run(&BrowserInputs { chrome: Some(side(&["c.example.com"])), edge: Some(full_side()) });
    assert!(rig.platform.with_world(|world| world
        .staff_values
        .keys()
        .all(|(_, path, _)| [CHROME, EDGE].iter().any(|root| *path == root.to_ascii_lowercase() || path.starts_with(&format!(r"{}\", root.to_ascii_lowercase()))))));
}

// ---------------------------------------------------------------- apps.list

#[test]
fn the_apps_list_says_browser_ready_only_after_the_policies_are_applied() {
    use crate::catalog::AppResolver;
    use rulebox_policy::catalog::BrowserKind;
    let rig = Rig::new();
    rig.platform.add_file(EDGE_EXE);
    let catalog = vec![edge_web("w", &[]), web_app("b", Value::Null, "https://builtin.example.com/", &[], perms(false, false, false, false))];
    let resolver = AppResolver::new(rig.platform.clone() as Arc<dyn Platform>).with_browser_state(Arc::clone(&rig.shared));
    let web_of = |apps: Vec<rulebox_ipc::requests::AppEntry>, id: &str| apps.into_iter().find(|app| app.id == id).unwrap().web.unwrap();

    // Not applied yet: the choice and the program are told, the mark is not.
    let before = web_of(resolver.visible(&catalog, "e"), "w");
    assert_eq!((before.browser, before.browser_exe.as_deref(), before.browser_ready), (BrowserKind::Edge, Some(EDGE_EXE), false));
    // A built-in web app is the built-in window, ready or not.
    let builtin = web_of(resolver.visible(&catalog, "e"), "b");
    assert_eq!((builtin.browser, builtin.browser_exe, builtin.browser_ready), (BrowserKind::Builtin, None, false));

    let inputs = BrowserInputs::from_catalog(&catalog, Some(&sim_path_roots()), &|path| path == EDGE_EXE);
    rig.run(&inputs);
    let after = web_of(resolver.visible(&catalog, "e"), "w");
    assert!(after.browser_ready && after.browser == BrowserKind::Edge);
    assert!(!web_of(resolver.visible(&catalog, "e"), "b").browser_ready);

    // The program missing: ready is still true for the policies, but there is no exe for the Staff App to start.
    let gone = AppResolver::new(Arc::new(SimPlatform::new(rig._dir.path().join("other"))) as Arc<dyn Platform>).with_browser_state(Arc::clone(&rig.shared));
    let no_exe = web_of(gone.visible(&catalog, "e"), "w");
    assert_eq!(no_exe.browser_exe, None);

    // Unassigned: not ready any more.
    rig.run(&BrowserInputs::default());
    assert!(!web_of(resolver.visible(&catalog, "e"), "w").browser_ready);
    // A resolver without the state never says ready.
    let plain = AppResolver::new(rig.platform.clone() as Arc<dyn Platform>);
    rig.run(&inputs);
    assert!(!web_of(plain.visible(&catalog, "e"), "w").browser_ready);
}

#[test]
fn the_browser_of_a_file_name_is_found_in_any_folder_and_case() {
    assert_eq!(browser_of_exe(r"C:\Anywhere\Chrome.EXE"), Some(Browser::Chrome));
    assert_eq!(browser_of_exe(r"{ProgramFilesX86}\Microsoft\Edge\Application\msedge.exe"), Some(Browser::Edge));
    assert_eq!(browser_of_exe("chrome.exe"), Some(Browser::Chrome));
    for other in [r"C:\Anywhere\chromedriver.exe", r"C:\x\notchrome.exe", "msedge.exe.bak", ""] {
        assert_eq!(browser_of_exe(other), None, "{other}");
    }
    assert_eq!(Browser::of_kind(BrowserKind::Unknown), None);
    assert_eq!(Browser::of_kind(BrowserKind::Builtin), None);
    assert_eq!(Browser::of_kind(BrowserKind::Edge).map(Browser::kind), Some(BrowserKind::Edge));
}
