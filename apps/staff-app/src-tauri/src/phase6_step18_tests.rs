//! Phase 6 Step 18 tests: web apps opened in Chrome or Edge (plan 4.9, PRD 7.3): the choice between the browser and the built-in
//! window, the fixed command line, the mapping of browser windows to their apps by AppUserModelID, the window cap that counts
//! them and the launcher that keeps browser jobs apart. They live in the bin crate because the lib test harness cannot start
//! (see `main.rs`).
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use rulebox_desktop::tracker::WindowEvent;
use rulebox_desktop::windows::WindowInfo;
use rulebox_policy::catalog::BrowserKind;
use rulebox_staff_lib::browserapp::{
    app_aumid, browser_task_of_label, browser_window_count, cap_windows, choose, launch_args, match_browser_app, profile_path,
    safe_address, ArgError, Browser, Choice, Facts, Fallback, BROWSER_LABEL_PREFIX, MIN_RAM_MB,
};
use rulebox_staff_lib::launcher::Launcher;
use rulebox_staff_lib::model::{AppEntry, AppKind, BrowserLaunch, DesktopApp, TaskItem, WebApp, WebPermissions};
use rulebox_staff_lib::tasks::{Labels, TaskTable};
use rulebox_staff_lib::webapp::{test_window, WebApps};

const CHROME: &str = r"C:\Program Files\Google\Chrome\Application\chrome.exe";
const EDGE: &str = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe";
/// The profile folder of the employee in the AppUserModelIDs below (a Convex id: letters and digits).
const LEAF: &str = "e1";

fn web(id: &str, url: &str, kind: BrowserKind, exe: Option<&str>, ready: bool) -> AppEntry {
    AppEntry {
        id: id.into(),
        name: format!("App {id}"),
        description: None,
        kind: AppKind::Web(WebApp {
            url: url.into(),
            allowed_domains: vec![],
            permissions: WebPermissions::default(),
            browser: BrowserLaunch { kind, exe: exe.map(str::to_string), ready },
        }),
        icon_key: None,
        icon_url: None,
        hue: None,
        pinned_taskbar: false,
        pinned_desktop: true,
        badge: None,
    }
}

fn web_app(entry: &AppEntry) -> &WebApp {
    match &entry.kind {
        AppKind::Web(web) => web,
        _ => panic!("not a web app"),
    }
}

fn desktop(id: &str, exe: &str) -> AppEntry {
    AppEntry {
        kind: AppKind::Desktop(DesktopApp { exe: exe.into(), args: vec![], file_arg_template: vec![] }),
        ..web(id, "https://x.test/", BrowserKind::Builtin, None, false)
    }
}

fn standard() -> Facts {
    Facts { lite: false, ram_mb: Some(8192), display_forced: false }
}

fn exists(_: &Path) -> bool {
    true
}

fn missing(_: &Path) -> bool {
    false
}

fn chrome_app() -> AppEntry {
    web("w1", "https://orders.example.com/", BrowserKind::Chrome, Some(CHROME), true)
}

// ---- where a web app opens ----------------------------------------------------------------

#[test]
fn a_ready_browser_app_opens_in_its_browser_on_a_standard_pc() {
    let chrome = chrome_app();
    assert_eq!(
        choose(web_app(&chrome), &standard(), &exists),
        Choice::Browser { browser: Browser::Chrome, exe: PathBuf::from(CHROME) }
    );
    let edge = web("w2", "https://x.test/", BrowserKind::Edge, Some(EDGE), true);
    assert_eq!(
        choose(web_app(&edge), &standard(), &exists),
        Choice::Browser { browser: Browser::Edge, exe: PathBuf::from(EDGE) }
    );
    // The file name is compared without regard to case.
    let shouting = web("w3", "https://x.test/", BrowserKind::Edge, Some(r"C:\Edge\MSEdge.EXE"), true);
    assert!(matches!(choose(web_app(&shouting), &standard(), &exists), Choice::Browser { .. }));
}

#[test]
fn lite_mode_always_falls_back_to_the_built_in_window() {
    let app = chrome_app();
    for forced in [false, true] {
        let facts = Facts { lite: true, ram_mb: Some(16_384), display_forced: forced };
        assert_eq!(choose(web_app(&app), &facts, &exists), Choice::Builtin(Fallback::Lite), "forced={forced}");
    }
}

#[test]
fn below_eight_gb_the_built_in_window_opens_unless_the_administrator_forced_the_display_mode() {
    let app = chrome_app();
    // A 4 GB laptop reports about 3.8 GB; 6 GB about 5.9; an unreadable size counts as too little.
    for ram in [Some(3_900), Some(MIN_RAM_MB - 1), None] {
        let facts = Facts { lite: false, ram_mb: ram, display_forced: false };
        assert_eq!(choose(web_app(&app), &facts, &exists), Choice::Builtin(Fallback::LowRam), "{ram:?}");
    }
    // An 8 GB PC reports 7.3 to 7.9 GB.
    for ram in [Some(MIN_RAM_MB), Some(7_400), Some(16_000)] {
        let facts = Facts { lite: false, ram_mb: ram, display_forced: false };
        assert!(matches!(choose(web_app(&app), &facts, &exists), Choice::Browser { .. }), "{ram:?}");
    }
    // On purpose (group or device display mode): the line does not apply.
    let forced = Facts { lite: false, ram_mb: Some(3_900), display_forced: true };
    assert!(matches!(choose(web_app(&app), &forced, &exists), Choice::Browser { .. }));
    let unknown = Facts { lite: false, ram_mb: None, display_forced: true };
    assert!(matches!(choose(web_app(&app), &unknown, &exists), Choice::Browser { .. }));
}

#[test]
fn the_built_in_window_opens_until_the_agent_says_the_policies_are_in_place() {
    let not_ready = web("w", "https://x.test/", BrowserKind::Chrome, Some(CHROME), false);
    assert_eq!(choose(web_app(&not_ready), &standard(), &exists), Choice::Builtin(Fallback::NotReady));
    // An older agent (1.3) says nothing: the default is the built-in window.
    let old_agent = web("w", "https://x.test/", BrowserKind::default(), None, false);
    assert_eq!(choose(web_app(&old_agent), &standard(), &exists), Choice::Builtin(Fallback::NotChosen));
    let unknown = web("w", "https://x.test/", BrowserKind::Unknown, Some(CHROME), true);
    assert_eq!(choose(web_app(&unknown), &standard(), &exists), Choice::Builtin(Fallback::NotChosen));
}

#[test]
fn a_missing_or_unexpected_program_falls_back_and_is_never_started() {
    let app = chrome_app();
    assert_eq!(choose(web_app(&app), &standard(), &missing), Choice::Builtin(Fallback::NoProgram));
    let none = web("w", "https://x.test/", BrowserKind::Chrome, None, true);
    assert_eq!(choose(web_app(&none), &standard(), &exists), Choice::Builtin(Fallback::NoProgram));
    let blank = web("w", "https://x.test/", BrowserKind::Chrome, Some("  "), true);
    assert_eq!(choose(web_app(&blank), &standard(), &exists), Choice::Builtin(Fallback::NoProgram));
    for bad in [
        r"chrome.exe",                                          // not absolute
        r"..\chrome.exe",                                       // not absolute
        r"C:\Windows\System32\cmd.exe",                         // not a browser
        r"C:\Windows\System32\cmd.exe /c chrome.exe",           // arguments in the path
        r"C:\Program Files\Google\Chrome\Application\x.bat",    // a script
        EDGE,                                                   // the wrong browser for this choice
    ] {
        let app = web("w", "https://x.test/", BrowserKind::Chrome, Some(bad), true);
        assert_eq!(choose(web_app(&app), &standard(), &exists), Choice::Builtin(Fallback::BadProgram), "{bad}");
    }
}

// ---- the command line ---------------------------------------------------------------------

fn profile() -> PathBuf {
    PathBuf::from(r"C:\Users\RuleboxStaff\AppData\Local\dev.rulebox.staff\browser\chrome\e1")
}

#[test]
fn the_command_line_is_exactly_the_fixed_shape() {
    let args = launch_args("https://orders.example.com/start?x=1#top", &profile()).unwrap();
    assert_eq!(
        args,
        [
            "--app=https://orders.example.com/start?x=1#top".to_string(),
            format!("--user-data-dir={}", profile().display()),
            "--no-first-run".to_string(),
            "--no-default-browser-check".to_string(),
            "--disk-cache-size=52428800".to_string(),
        ]
    );
    // Never a kiosk switch, never a flag of the WebView2 kind.
    assert!(!args.iter().any(|arg| arg.contains("kiosk") || arg.contains("disable-features")));
}

#[test]
fn odd_addresses_are_encoded_into_one_argument_or_refused() {
    // Spaces and quotes of the path, query and fragment are percent-encoded by the address parser: one argument remains.
    let spaced = launch_args("https://x.test/a b/\"c\"?q=\"1 2\"#f g", &profile()).unwrap();
    assert_eq!(spaced.len(), 5);
    assert_eq!(spaced[0], "--app=https://x.test/a%20b/%22c%22?q=%221%202%22#f%20g");
    for arg in &spaced {
        assert!(!arg.chars().any(|c| c == '"' || c == '\t' || c == '\n' || c == '\r'), "{arg}");
    }
    // `--` inside the address stays inside the value of `--app=`: it never becomes a switch of its own.
    let dashes = launch_args("https://x.test/--no-sandbox?--kiosk=1 --disable-web-security#--x", &profile()).unwrap();
    assert_eq!(dashes.len(), 5);
    assert_eq!(dashes[0], "--app=https://x.test/--no-sandbox?--kiosk=1%20--disable-web-security#--x");
    assert!(dashes[0].starts_with("--app="));
    assert!(dashes[1..].iter().all(|arg| !arg.contains("sandbox") && !arg.contains("kiosk") && !arg.contains("web-security")));
    // A tab or a line break inside the address is dropped by the parser, never carried to the command line.
    let broken = launch_args("https://x.test/a\tb\nc", &profile()).unwrap();
    assert_eq!(broken[0], "--app=https://x.test/abc");
    // The windows command line joins the arguments with spaces and quotes: every address is still one token.
    for args in [&spaced, &dashes, &broken] {
        let line = rulebox_desktop::launch::build_command_line(Path::new(CHROME), args);
        // Exactly the five switches, however many `--` the address holds (they are not preceded by a space).
        assert_eq!(line.matches(" --").count(), 5, "{line}");
    }
}

#[test]
fn only_plain_https_addresses_with_a_host_are_used() {
    for bad in [
        "http://x.test/",
        "ftp://x.test/",
        "javascript:alert(1)",
        "file:///C:/Windows/win.ini",
        "data:text/html,hi",
        "chrome://settings",
        "https://",
        "not a url",
        "",
        "https://user:pass@x.test/",
        "https://user@x.test/",
    ] {
        assert_eq!(launch_args(bad, &profile()), Err(ArgError::BadAddress), "{bad}");
    }
    let long = format!("https://x.test/{}", "a".repeat(2100));
    assert_eq!(safe_address(&long), Err(ArgError::TooLong));
    assert_eq!(safe_address(&format!("https://x.test/{}", "a".repeat(2000))).map(|s| s.len() > 2000), Ok(true));
    // An address with a port, an IP and a punycode host is fine.
    assert!(safe_address("https://192.168.1.5:8443/app").is_ok());
    assert_eq!(safe_address("https://Bücher.example/").unwrap(), "https://xn--bcher-kva.example/");
}

#[test]
fn the_profile_folder_must_be_a_plain_absolute_path() {
    let url = "https://x.test/";
    for bad in [r"relative\profile", "", r"C:\Users\x\profile\", r#"C:\Users\x\"profile"#, "C:\\Users\\x\nprofile"] {
        assert_eq!(launch_args(url, Path::new(bad)), Err(ArgError::BadProfile), "{bad:?}");
    }
    // A folder with a space is fine: the command line quotes the whole argument.
    let spaced = launch_args(url, Path::new(r"C:\Users\Rulebox Staff\AppData\Local\dev.rulebox.staff\browser\edge\e1")).unwrap();
    let line = rulebox_desktop::launch::build_command_line(Path::new(EDGE), &spaced);
    assert!(line.contains(r#""--user-data-dir=C:\Users\Rulebox Staff\AppData\Local\dev.rulebox.staff\browser\edge\e1""#), "{line}");
}

#[test]
fn the_browser_profile_is_its_own_folder_per_browser_and_employee() {
    let local = Path::new(r"C:\Users\RuleboxStaff\AppData\Local");
    assert_eq!(
        profile_path(local, Browser::Chrome, "emp1"),
        PathBuf::from(r"C:\Users\RuleboxStaff\AppData\Local\dev.rulebox.staff\browser\chrome\emp1")
    );
    assert_eq!(
        profile_path(local, Browser::Edge, "emp1"),
        PathBuf::from(r"C:\Users\RuleboxStaff\AppData\Local\dev.rulebox.staff\browser\edge\emp1")
    );
    // Not the built-in WebView2 folder (`...\web\<employee>`), and no id escapes the folder.
    assert!(!profile_path(local, Browser::Chrome, "emp1").to_string_lossy().contains(r"\web\"));
    assert_eq!(profile_path(local, Browser::Chrome, r"..\..\evil"), local.join(r"dev.rulebox.staff\browser\chrome\------evil"));
    assert_eq!(profile_path(local, Browser::Chrome, ""), local.join(r"dev.rulebox.staff\browser\chrome\unknown"));
}

// ---- which window belongs to which app ----------------------------------------------------

fn window(hwnd: isize, pid: u32, exe: &str, aumid: Option<&str>) -> WindowInfo {
    WindowInfo {
        hwnd,
        pid,
        title: "Example Domain".into(),
        exe: Some(PathBuf::from(exe)),
        aumid: aumid.map(str::to_string),
        minimized: false,
        cloaked: false,
        class: "Chrome_WidgetWin_1".into(),
    }
}

#[test]
fn the_aumid_of_an_app_window_has_the_shape_seen_on_the_vm() {
    // S-3: `Chrome.example.org_/.e1.Default`, `MSEdge.example.com_/.e1.Default`.
    assert_eq!(app_aumid(Browser::Chrome, "https://example.org", LEAF).as_deref(), Some("Chrome.example.org_/.e1.Default"));
    assert_eq!(app_aumid(Browser::Edge, "https://example.com/", LEAF).as_deref(), Some("MSEdge.example.com_/.e1.Default"));
    // The port is not part of it, the path is.
    assert_eq!(
        app_aumid(Browser::Chrome, "https://Orders.Example.com:8443/app/main?x=1#y", LEAF).as_deref(),
        Some("Chrome.orders.example.com_/app/main.e1.Default")
    );
    assert_eq!(app_aumid(Browser::Chrome, "not a url", LEAF), None);
}

#[test]
fn two_apps_in_one_browser_map_to_two_tasks() {
    let catalogue = vec![
        web("orders", "https://example.org/", BrowserKind::Chrome, Some(CHROME), true),
        web("mail", "https://example.com/", BrowserKind::Chrome, Some(CHROME), true),
    ];
    let mut table = TaskTable::default();
    table.set_browser_leaf(Some(LEAF.into()));
    let labels: Labels = Labels::new();
    // S-3: both windows belong to one process.
    table.apply(&WindowEvent::Added(window(1, 7744, CHROME, Some("Chrome.example.com_/.e1.Default"))), &labels);
    table.apply(&WindowEvent::Added(window(2, 7744, CHROME, Some("Chrome.example.org_/.e1.Default"))), &labels);
    let items = table.items(&labels, &catalogue, &HashMap::new());
    assert_eq!(items.len(), 2);
    assert_eq!(items[0].app_id.as_deref(), Some("mail"));
    assert_eq!(items[1].app_id.as_deref(), Some("orders"));
    assert!(!items[0].own && !items[1].own, "a browser window is not one of the shell's own");
    // Even when the shell's launcher had mapped that process to one app (the first job), the AppUserModelID wins.
    let launched = HashMap::from([(7744u32, "orders".to_string())]);
    let items = table.items(&labels, &catalogue, &launched);
    assert_eq!(items[0].app_id.as_deref(), Some("mail"));
    assert_eq!(items[1].app_id.as_deref(), Some("orders"));
}

#[test]
fn a_window_without_an_id_or_with_an_unknown_one_is_never_mapped_to_a_web_app() {
    let catalogue = vec![web("orders", "https://example.org/", BrowserKind::Chrome, Some(CHROME), true)];
    let mut table = TaskTable::default();
    table.set_browser_leaf(Some(LEAF.into()));
    let labels = Labels::new();
    // Edge's "Translate page" bubble: no id. A normal window of the browser: another id. Someone else's profile: another leaf.
    table.apply(&WindowEvent::Added(window(1, 5, CHROME, None)), &labels);
    table.apply(&WindowEvent::Added(window(2, 5, CHROME, Some("Chrome"))), &labels);
    table.apply(&WindowEvent::Added(window(3, 5, CHROME, Some("Chrome.example.org_/.other.Default"))), &labels);
    // The same address in the other browser's naming, and a program that is no browser with a copied id.
    table.apply(&WindowEvent::Added(window(4, 5, CHROME, Some("MSEdge.example.org_/.e1.Default"))), &labels);
    table.apply(&WindowEvent::Added(window(5, 6, r"C:\Tools\notes.exe", Some("Chrome.example.org_/.e1.Default"))), &labels);
    let items = table.items(&labels, &catalogue, &HashMap::new());
    assert_eq!(items.len(), 5);
    assert!(items.iter().all(|item| item.app_id.is_none()), "{items:?}");
    // Nobody signed in: nothing is mapped either.
    table.set_browser_leaf(None);
    table.apply(&WindowEvent::Changed(window(6, 5, CHROME, Some("Chrome.example.org_/.e1.Default"))), &labels);
    assert!(table.items(&labels, &catalogue, &HashMap::new()).iter().all(|item| item.app_id.is_none()));
}

#[test]
fn an_edge_window_is_matched_only_to_an_edge_app_and_a_chrome_window_only_to_a_chrome_app() {
    let catalogue = vec![
        web("c", "https://example.org/", BrowserKind::Chrome, Some(CHROME), true),
        web("e", "https://example.org/", BrowserKind::Edge, Some(EDGE), true),
        web("b", "https://example.org/", BrowserKind::Builtin, None, false),
    ];
    let chrome = Path::new(CHROME);
    let edge = Path::new(EDGE);
    assert_eq!(match_browser_app(Some("Chrome.example.org_/.e1.Default"), Some(chrome), &catalogue, LEAF).as_deref(), Some("c"));
    assert_eq!(match_browser_app(Some("MSEdge.example.org_/.e1.Default"), Some(edge), &catalogue, LEAF).as_deref(), Some("e"));
    // Case does not matter; a different folder or profile name does.
    assert_eq!(match_browser_app(Some("chrome.EXAMPLE.org_/.E1.default"), Some(chrome), &catalogue, LEAF).as_deref(), Some("c"));
    assert_eq!(match_browser_app(Some("Chrome.example.org_/.e1.Profile 1"), Some(chrome), &catalogue, LEAF), None);
    assert_eq!(match_browser_app(Some("Chrome.example.org_/.e1.Default"), Some(edge), &catalogue, LEAF), None);
    assert_eq!(match_browser_app(Some("Chrome.example.org_/.e1.Default"), None, &catalogue, LEAF), None);
    assert_eq!(match_browser_app(Some(""), Some(chrome), &catalogue, LEAF), None);
    // A desktop app of the same program is not a web app.
    let only_desktop = vec![desktop("chrome-app", CHROME)];
    assert_eq!(match_browser_app(Some("Chrome.example.org_/.e1.Default"), Some(chrome), &only_desktop, LEAF), None);
}

#[test]
fn a_chrome_window_with_no_matching_app_still_belongs_to_the_chrome_desktop_app_by_program() {
    // Plan 4.9.7: Chrome as a normal app. Its own windows map by program file as before.
    let catalogue = vec![desktop("chrome-app", CHROME), web("orders", "https://example.org/", BrowserKind::Chrome, Some(CHROME), true)];
    let mut table = TaskTable::default();
    table.set_browser_leaf(Some(LEAF.into()));
    let labels = Labels::new();
    table.apply(&WindowEvent::Added(window(1, 9, CHROME, Some("Chrome"))), &labels);
    table.apply(&WindowEvent::Added(window(2, 9, CHROME, Some("Chrome.example.org_/.e1.Default"))), &labels);
    let items = table.items(&labels, &catalogue, &HashMap::new());
    assert_eq!(items[0].app_id.as_deref(), Some("chrome-app"));
    assert_eq!(items[1].app_id.as_deref(), Some("orders"));
}

// ---- the window cap -----------------------------------------------------------------------

fn task(id: &str, app_id: Option<&str>, own: bool) -> TaskItem {
    TaskItem {
        id: id.into(),
        app_id: app_id.map(str::to_string),
        title: "t".into(),
        icon_key: format!("hwnd:{id}:0"),
        active: false,
        minimized: false,
        flashing: false,
        hung: false,
        own,
        recency: 0,
    }
}

#[test]
fn browser_windows_count_toward_the_cap_next_to_the_built_in_ones() {
    let catalogue = vec![
        web("orders", "https://example.org/", BrowserKind::Chrome, Some(CHROME), true),
        web("mail", "https://example.com/", BrowserKind::Edge, Some(EDGE), true),
        desktop("notes", r"C:\Tools\notes.exe"),
    ];
    let tasks = vec![
        task("100", Some("orders"), false), // a web app in Chrome
        task("101", Some("mail"), false),   // a web app in Edge
        task("102", Some("notes"), false),  // a desktop app: not counted
        task("103", None, false),           // a window no app owns
        task("104", Some("orders"), true),  // one of the shell's own web windows (counted by `WebApps`)
    ];
    assert_eq!(browser_window_count(&catalogue, &tasks), 2);
    let web_apps = WebApps::default();
    web_apps.insert_for_test(test_window("web-a-0", "a", "A"));
    // One built-in window and two browser windows: a cap of 3 is reached, a cap of 4 is not.
    assert!(web_apps.at_cap_with(3, 2));
    assert!(!web_apps.at_cap_with(4, 2));
    assert!(web_apps.at_cap(1) && !web_apps.at_cap(2), "the old call counts built-in windows only");
}

#[test]
fn the_close_one_first_dialog_lists_browser_windows_and_names_them_safely() {
    let catalogue = vec![
        web("orders", "https://example.org/", BrowserKind::Chrome, Some(CHROME), true),
        desktop("notes", r"C:\Tools\notes.exe"),
    ];
    let tasks = vec![task("100", Some("orders"), false), task("102", Some("notes"), false)];
    assert_eq!(cap_windows(&catalogue, &tasks), vec![(format!("{BROWSER_LABEL_PREFIX}100"), "App orders".to_string())]);
    // Only a label of an open browser window names a window: a made-up id, a desktop app's window or a built-in label do not.
    assert_eq!(browser_task_of_label("browser-100", &catalogue, &tasks), Some("100"));
    for bad in ["browser-102", "browser-999", "browser-", "browser-100 ", "web-a-0", "100", ""] {
        assert_eq!(browser_task_of_label(bad, &catalogue, &tasks), None, "{bad:?}");
    }

    let web_apps = WebApps::default();
    web_apps.insert_for_test(test_window("web-a-0", "a", "Alpha"));
    web_apps.set_pending("orders");
    let prompt = web_apps.cap_prompt_with(2, &catalogue, &cap_windows(&catalogue, &tasks)).unwrap();
    let labels: Vec<&str> = prompt.windows.iter().map(|w| w.label.as_str()).collect();
    // Sorted by app name: "Alpha" (a built-in window) before "App orders" (a browser window).
    assert_eq!(labels, ["web-a-0", "browser-100"]);
    // The wait is not ended by looking, and `take_waiting` ends it once.
    assert_eq!(web_apps.waiting_app().as_deref(), Some("orders"));
    assert_eq!(web_apps.take_waiting().as_deref(), Some("orders"));
    assert_eq!(web_apps.waiting_app(), None);
    assert_eq!(web_apps.take_waiting(), None);
}

// ---- the launcher -------------------------------------------------------------------------

#[test]
fn a_browser_job_is_tracked_for_log_out_but_never_mapped_to_an_app() {
    let exe = PathBuf::from(r"C:\Windows\System32\ping.exe");
    if !exe.exists() {
        return;
    }
    let launcher = Launcher::default();
    let pid = launcher.start_browser("web1", &exe, &["-n".into(), "3".into(), "127.0.0.1".into()]).expect("start");
    let none = std::collections::HashSet::new();
    // Not mapped: the taskbar must not group every window of the shared browser process under the first app.
    assert!(launcher.pid_map(&none).is_empty());
    assert!(launcher.app_pids().is_empty());
    // But log out still closes and ends it with every other launched job.
    let (job_pids, adopted) = launcher.sign_out_scope(&none);
    assert!(job_pids.contains(&pid));
    assert!(adopted.is_empty());
    // A window of the same program name is not adopted as that app's (adoption is for hand-off programs).
    launcher.adopt(77, pid + 100_000, Some(&exe));
    assert!(launcher.pid_map(&none).is_empty());
    launcher.terminate_all();
}
