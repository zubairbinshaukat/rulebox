//! Navigation and the bar of web app windows (`webapp/nav.rs`, `webapp/bar.rs`).
//!
//! The pure half: which keys do what, what the bar shows after each WebView2 event, where the bar and
//! the site go in the window, what the display-only address says, the action registry, and what the
//! bar's page may contain. The WebView2 wiring (`webapp/barhost.rs`) is checked on a real window; the
//! page itself (`webapp/bar.js`) is tested in `src/webnav/bar.test.ts`.

use rulebox_staff_lib::model::ThemeDto;
use rulebox_staff_lib::webapp::allow::AllowList;
use rulebox_staff_lib::webapp::bar::{
    self, address_of, bar_height, place, AddressKind, AddressView, BarAction, Rect, ACTIONS, BAR_HEIGHT_LOGICAL,
};
use rulebox_staff_lib::webapp::nav::{
    applies, message, parse_command, shortcut, BarCommand, Look, Modifiers, NavAction, NavState, NavView, VK_F5,
    VK_LEFT, VK_R, VK_RIGHT,
};

const NONE: Modifiers = Modifiers {
    ctrl: false,
    alt: false,
    shift: false,
};
const ALT: Modifiers = Modifiers { alt: true, ..NONE };
const CTRL: Modifiers = Modifiers { ctrl: true, ..NONE };

fn look() -> Look {
    Look::new(ThemeDto::Light, false)
}

const APP: &str = "Orders";

#[test]
fn the_keys_are_alt_arrows_f5_and_ctrl_r() {
    assert_eq!(shortcut(VK_LEFT, ALT), Some(NavAction::Back));
    assert_eq!(shortcut(VK_RIGHT, ALT), Some(NavAction::Forward));
    assert_eq!(shortcut(VK_F5, NONE), Some(NavAction::Reload));
    assert_eq!(shortcut(VK_F5, CTRL), Some(NavAction::Reload), "Ctrl+F5 is a reload too");
    assert_eq!(shortcut(VK_R, CTRL), Some(NavAction::Reload));
    assert_eq!(shortcut(VK_R, Modifiers { shift: true, ..CTRL }), Some(NavAction::Reload));
}

#[test]
fn other_combinations_are_left_to_the_page() {
    // An arrow key alone moves the caret or scrolls; Ctrl+Alt+Left is a desktop or AltGr chord.
    assert_eq!(shortcut(VK_LEFT, NONE), None);
    assert_eq!(shortcut(VK_RIGHT, CTRL), None);
    assert_eq!(shortcut(VK_LEFT, Modifiers { ctrl: true, ..ALT }), None);
    assert_eq!(shortcut(VK_LEFT, Modifiers { shift: true, ..ALT }), None);
    // R alone is a letter; Alt+F5 and Alt+Ctrl+R belong to the system.
    assert_eq!(shortcut(VK_R, NONE), None);
    assert_eq!(shortcut(VK_R, ALT), None);
    assert_eq!(shortcut(VK_R, Modifiers { ctrl: true, ..ALT }), None);
    assert_eq!(shortcut(VK_F5, ALT), None);
    // Alt+Tab, the Windows key and the exit chord are not ours at all.
    assert_eq!(shortcut(0x09, ALT), None);
    assert_eq!(shortcut(0x5B, NONE), None);
}

#[test]
fn a_key_that_does_nothing_is_not_swallowed() {
    assert!(!applies(NavAction::Back, false, true));
    assert!(applies(NavAction::Back, true, false));
    assert!(!applies(NavAction::Forward, true, false));
    assert!(applies(NavAction::Forward, false, true));
    assert!(applies(NavAction::Reload, false, false));
    assert!(applies(NavAction::Stop, false, false));
}

#[test]
fn a_new_window_has_nothing_to_go_back_or_forward_to() {
    let state = NavState::default();
    assert_eq!(state.view(), NavView::default());
}

#[test]
fn the_buttons_follow_what_webview2_says() {
    let mut state = NavState::default();
    state.started();
    assert!(state.view().loading, "a navigation began: Reload turns into Stop");
    state.history(false, false);
    state.completed();
    assert_eq!(state.view(), NavView::default(), "the first page: nothing behind or ahead");

    // The person follows a link.
    state.started();
    state.history(true, false);
    state.completed();
    assert_eq!(
        state.view(),
        NavView {
            back: true,
            forward: false,
            loading: false
        }
    );

    // Back to the first page: now there is a page ahead.
    state.started();
    state.history(false, true);
    state.completed();
    assert_eq!(
        state.view(),
        NavView {
            back: false,
            forward: true,
            loading: false
        }
    );
}

#[test]
fn a_refused_navigation_keeps_the_history_and_ends_the_spinner() {
    // Page one, then a link to a site that is not allowed: the gate cancels it and shows the blocked
    // page. Back must still lead to page one.
    let mut state = NavState::default();
    state.history(false, false);
    state.completed();
    state.history(true, false); // page two
    state.completed();

    state.refused(); // the cancelled address
    assert_eq!(
        state.view(),
        NavView {
            back: true,
            forward: false,
            loading: false
        },
        "a refusal loads nothing and removes nothing"
    );

    // The blocked page is a navigation of its own (a new entry after page two).
    state.started();
    state.history(true, false);
    state.completed();
    assert!(state.view().back, "Back from the blocked page goes to page two");
    assert!(!state.view().loading);
}

#[test]
fn a_redirect_to_a_blocked_site_is_refused_by_the_allow_list() {
    // The gate judges every address of a navigation, redirects included (WebView2 starts a
    // navigation for each hop), so the history can only ever hold allowed pages and the blocked page.
    // The bar has no way to navigate anywhere else: it can only step through that history.
    let allow = AllowList::new("https://portal.example.com/", &["cdn.example.com".to_string()]).unwrap();
    for allowed in [
        "https://portal.example.com/orders",
        "https://portal.example.com/login?next=/orders",
        "https://cdn.example.com/app.js",
    ] {
        assert!(allow.allows(allowed), "{allowed}");
    }
    for refused in [
        "https://evil.example.net/steal",
        "https://portal.example.com.evil.net/",
        "https://portal.example.com@evil.net/",
        "http://portal.example.com/downgrade",
        "about:blank",
        "javascript:alert(1)",
        "file:///c:/windows/win.ini",
    ] {
        assert!(!allow.allows(refused), "{refused}");
    }
}

#[test]
fn stepping_back_onto_the_windows_own_blank_page_is_refused_and_used_up() {
    let mut state = NavState::default();
    // If the first real page left the start page behind it, WebView2 says Back is possible.
    state.history(true, false);
    state.completed();
    assert!(state.view().back);

    // The person clicks it: the gate turns about:blank away and says so.
    state.started();
    state.blank_below();
    state.refused();
    assert!(!state.view().back, "no page behind this one");
    assert!(!state.view().loading, "and nothing is loading");

    // History events do not bring the button back while the start page is all there is behind.
    state.history(true, false);
    assert!(!state.view().back);

    // A real navigation starts again: the next page really has a page behind it.
    state.started();
    state.history(true, false);
    state.completed();
    assert!(state.view().back);

    // And once WebView2 itself says there is nothing behind, the note is forgotten.
    state.blank_below();
    state.history(false, false);
    state.history(true, false);
    assert!(state.view().back);
}

#[test]
fn the_bar_hears_only_what_changed_except_after_it_reloads_which_always_hears() {
    let mut state = NavState::default();
    let first = state.next_message(false, look(), APP);
    assert!(first.is_some(), "nothing was sent yet");
    assert_eq!(state.next_message(false, look(), APP), None, "same again");
    assert!(state.next_message(true, look(), APP).is_some(), "a freshly loaded bar starts with no state");

    state.history(true, false);
    assert!(state.next_message(false, look(), APP).is_some(), "Back became possible");
    assert_eq!(state.next_message(false, look(), APP), None);

    // A different look (theme change, Lite switched on) is news too.
    assert!(state.next_message(false, Look::new(ThemeDto::Dark, false), APP).is_some());
    assert!(state.next_message(false, Look::new(ThemeDto::Dark, true), APP).is_some());
    assert_eq!(state.next_message(false, Look::new(ThemeDto::Dark, true), APP), None);

    // So is a new address, even when the buttons stay as they are (a link inside one single page).
    state.navigated("https://portal.example.com/orders");
    assert!(state.next_message(false, Look::new(ThemeDto::Dark, true), APP).is_some());
    state.navigated("https://portal.example.com/orders");
    assert_eq!(state.next_message(false, Look::new(ThemeDto::Dark, true), APP), None);
    state.navigated("https://portal.example.com/orders#row-9");
    assert!(state.next_message(false, Look::new(ThemeDto::Dark, true), APP).is_some());
}

#[test]
fn the_message_is_the_json_the_bar_reads() {
    let address = address_of("https://portal.example.com/orders?id=7", APP);
    let json = message(
        NavView {
            back: true,
            forward: false,
            loading: true,
        },
        Look::new(ThemeDto::Dark, true),
        &address,
        ACTIONS,
    );
    let value: serde_json::Value = serde_json::from_str(&json).expect("valid JSON");
    assert_eq!(
        value,
        serde_json::json!({
            "rbBar": 1, "back": true, "forward": false, "loading": true, "theme": "dark", "calm": true,
            "address": {
                "kind": "site", "secure": true, "host": "portal.example.com",
                "rest": "/orders?id=7", "title": "https://portal.example.com/orders?id=7"
            },
            "actions": []
        })
    );
    assert!(bar::SCRIPT.contains("rbBar"), "the script and the host agree on the key");
    for (theme, name) in [(ThemeDto::Light, "light"), (ThemeDto::Dark, "dark"), (ThemeDto::Auto, "auto")] {
        assert_eq!(Look::new(theme, false).theme, name);
        assert!(bar::SCRIPT.contains(&format!("\"{name}\"")), "{name}");
    }
    assert!(Look::new(ThemeDto::Dark, false).is_dark());
    assert!(!Look::new(ThemeDto::Auto, false).is_dark());
}

// ---- layout ------------------------------------------------------------------------------------

fn rect(left: i32, top: i32, right: i32, bottom: i32) -> Rect {
    Rect {
        left,
        top,
        right,
        bottom,
    }
}

#[test]
fn the_bar_is_44_logical_pixels_at_every_scale() {
    assert_eq!(BAR_HEIGHT_LOGICAL, 44);
    assert_eq!(bar_height(96), 44, "100 %");
    assert_eq!(bar_height(120), 55, "125 %");
    assert_eq!(bar_height(144), 66, "150 %");
    assert_eq!(bar_height(168), 77, "175 %");
    assert_eq!(bar_height(192), 88, "200 %");
    assert_eq!(bar_height(0), 44, "a window that cannot say is taken as 100 %");
}

#[test]
fn the_bar_takes_the_top_strip_and_the_site_everything_below_it_so_nothing_is_covered() {
    let at_100 = place(1100, 720, 96, false, false);
    assert_eq!(at_100.bar, Some(rect(0, 0, 1100, 44)));
    assert_eq!(at_100.site, rect(0, 44, 1100, 720));

    for dpi in [96, 120, 144, 168, 192] {
        let p = place(1500, 900, dpi, false, false);
        let bar = p.bar.expect("bar shown");
        assert_eq!(bar.bottom, p.site.top, "the site starts exactly where the bar ends ({dpi} dpi)");
        assert_eq!(p.site.bottom, 900, "and ends at the bottom of the window");
        assert_eq!((bar.left, bar.right, p.site.left, p.site.right), (0, 1500, 0, 1500));
    }
}

#[test]
fn a_page_in_full_screen_hides_the_bar_and_gets_the_whole_window() {
    let full = place(1920, 1080, 96, true, false);
    assert_eq!(full.bar, None);
    assert_eq!(full.site, rect(0, 0, 1920, 1080));
    // Leaving full screen brings the same layout back as before.
    assert_eq!(place(1920, 1080, 96, false, false).bar, Some(rect(0, 0, 1920, 44)));
    // A menu cannot be open in full screen.
    assert_eq!(place(1920, 1080, 96, true, true), full);
}

#[test]
fn an_open_menu_grows_the_bar_over_the_window_but_the_site_stays_put() {
    let open = place(1000, 600, 96, false, true);
    assert_eq!(open.bar, Some(rect(0, 0, 1000, 600)));
    assert_eq!(open.site, rect(0, 44, 1000, 600));
    assert_eq!(open.site, place(1000, 600, 96, false, false).site);
}

#[test]
fn a_tiny_or_odd_window_never_gives_a_negative_or_inverted_rectangle() {
    let squat = place(300, 30, 96, false, false);
    assert_eq!(squat.bar, Some(rect(0, 0, 300, 30)));
    assert_eq!(squat.site, rect(0, 30, 300, 30), "no room: the site is empty, not negative");
    let empty = place(-5, -5, 96, false, false);
    assert_eq!(empty.site, rect(0, 0, 0, 0));
}

// ---- the address -------------------------------------------------------------------------------

fn site(host: &str, rest: &str, secure: bool, title: &str) -> AddressView {
    AddressView {
        kind: AddressKind::Site,
        secure,
        host: host.into(),
        rest: rest.into(),
        title: title.into(),
    }
}

#[test]
fn a_site_address_shows_the_lock_the_host_and_the_rest_apart() {
    assert_eq!(
        address_of("https://portal.example.com/orders/17?tab=lines#top", APP),
        site(
            "portal.example.com",
            "/orders/17?tab=lines#top",
            true,
            "https://portal.example.com/orders/17?tab=lines#top"
        )
    );
    assert_eq!(
        address_of("https://portal.example.com/", APP),
        site("portal.example.com", "", true, "https://portal.example.com/"),
        "the site's root has no rest"
    );
    assert_eq!(
        address_of("https://portal.example.com:8443/x", APP).host,
        "portal.example.com:8443",
        "a non-default port is part of what you are talking to"
    );
    assert_eq!(address_of("https://portal.example.com:443/x", APP).host, "portal.example.com");
}

#[test]
fn only_https_has_the_lock_and_look_alike_hosts_show_as_punycode() {
    let plain = address_of("http://portal.example.com/", APP);
    assert_eq!((plain.kind, plain.secure), (AddressKind::Site, false));
    let idn = address_of("https://p\u{43e}rtal.example.com/", APP);
    assert!(idn.host.starts_with("xn--"), "a Cyrillic o is not hidden: {}", idn.host);
}

#[test]
fn the_start_page_the_blocked_page_and_browser_pages_show_the_app_name_instead() {
    for source in ["about:blank", "", "not a url", "edge://network-error/", "chrome-error://chromewebdata/", "data:text/html,hi"] {
        let shown = address_of(source, APP);
        assert_eq!(shown.kind, AddressKind::App, "{source}");
        assert_eq!((shown.host.as_str(), shown.rest.as_str(), shown.secure), (APP, "", false), "{source}");
        assert_eq!(shown.title, APP);
    }
    let blocked = rulebox_staff_lib::webapp::blocked::blocked_url("evil.example.net", "https://portal.example.com/")
        .expect("blocked page address");
    let shown = address_of(blocked.as_str(), APP);
    assert_eq!(shown.kind, AddressKind::Blocked);
    assert_eq!(shown.host, APP, "the app's name, not the blocked host or the local address");
    assert!(!shown.title.contains("rbblocked") && !shown.title.contains("evil.example.net"));
}

#[test]
fn a_very_long_address_is_cut_for_the_bar_and_has_no_control_characters() {
    let long = format!("https://portal.example.com/{}", "a".repeat(5000));
    let shown = address_of(&long, APP);
    assert!(shown.rest.chars().count() <= 400);
    assert!(shown.title.chars().count() <= 2000);
    let name = address_of("about:blank", &format!("Orders\u{7}{}", "x".repeat(300)));
    assert!(name.host.chars().count() <= 80);
    assert!(!name.host.contains('\u{7}'));
}

// ---- what the bar sends back -------------------------------------------------------------------

#[test]
fn the_bars_messages_are_read_strictly() {
    assert_eq!(parse_command(r#"{"rbBar":1,"t":"ready"}"#), Some(BarCommand::Ready));
    assert_eq!(parse_command(r#"{"rbBar":1,"t":"focus-page"}"#), Some(BarCommand::FocusPage));
    assert_eq!(parse_command(r#"{"rbBar":1,"t":"menu","open":true}"#), Some(BarCommand::Menu(true)));
    assert_eq!(
        parse_command(r#"{"rbBar":1,"t":"nav","a":"back","by":"mouse"}"#),
        Some(BarCommand::Nav {
            action: NavAction::Back,
            mouse: true
        })
    );
    assert_eq!(
        parse_command(r#"{"rbBar":1,"t":"nav","a":"stop","by":"key"}"#),
        Some(BarCommand::Nav {
            action: NavAction::Stop,
            mouse: false
        })
    );
    assert_eq!(
        parse_command(r#"{"rbBar":1,"t":"action","id":"about-app"}"#),
        Some(BarCommand::Action("about-app".into()))
    );
    for bad in [
        "",
        "null",
        "[]",
        "\"ready\"",
        r#"{"t":"ready"}"#,
        r#"{"rbBar":2,"t":"ready"}"#,
        r#"{"rbBar":"1","t":"ready"}"#,
        r#"{"rbBar":1,"t":"navigate","url":"https://evil.example.net/"}"#,
        r#"{"rbBar":1,"t":"nav","a":"https://evil.example.net/"}"#,
        r#"{"rbBar":1,"t":"nav","a":"home"}"#,
        r#"{"rbBar":1,"t":"nav"}"#,
        r#"{"rbBar":1,"t":"menu"}"#,
        r#"{"rbBar":1,"t":"menu","open":"yes"}"#,
        r#"{"rbBar":1,"t":"action","id":"Bad Id"}"#,
        r#"{"rbBar":1,"t":"action","id":""}"#,
        r#"{"rbBar":1,"t":"action","id":"../x"}"#,
        r#"{"rbBar":1,"t":"action"}"#,
    ] {
        assert_eq!(parse_command(bad), None, "{bad}");
    }
    let huge = format!(r#"{{"rbBar":1,"t":"ready","pad":"{}"}}"#, "x".repeat(5000));
    assert_eq!(parse_command(&huge), None, "too big to be ours");
}

// ---- the action slot ---------------------------------------------------------------------------

fn nothing(_: &bar::ActionContext<'_>) {}

#[test]
fn the_action_slot_ships_empty_and_is_ready_for_entries() {
    assert!(ACTIONS.is_empty(), "no action ships yet: the owner adds them later");
    let registry = [
        BarAction {
            id: "about-app",
            label: "About this app",
            icon: "info",
            run: nothing,
        },
        BarAction {
            id: "favourite",
            label: "Favourite",
            icon: "star",
            run: nothing,
        },
    ];
    assert_eq!(bar::find(&registry, "favourite").map(|a| a.label), Some("Favourite"));
    assert!(bar::find(&registry, "nope").is_none());
    assert!(bar::find(ACTIONS, "about-app").is_none(), "the bar can only run what is registered");
    let json = message(NavView::default(), look(), &address_of("about:blank", APP), &registry);
    let value: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert_eq!(
        value["actions"],
        serde_json::json!([
            {"id": "about-app", "label": "About this app", "icon": "info"},
            {"id": "favourite", "label": "Favourite", "icon": "star"}
        ])
    );
    for action in &registry {
        assert!(bar::valid_action_id(action.id));
        assert!(bar::ICON_KEYS.contains(&action.icon), "{} must be an icon bar.js can draw", action.icon);
    }
    for key in bar::ICON_KEYS {
        assert!(bar::SCRIPT.contains(&format!("    {key}: '")), "bar.js draws {key}");
    }
}

#[test]
fn action_ids_are_plain() {
    for good in ["about", "a-b_c9", &"x".repeat(64)] {
        assert!(bar::valid_action_id(good), "{good}");
    }
    for bad in ["", "A", "a b", "a/b", "a.b", &"x".repeat(65)] {
        assert!(!bar::valid_action_id(bad), "{bad}");
    }
}

// ---- the bar's page ----------------------------------------------------------------------------

#[test]
fn the_page_is_self_contained_and_loads_nothing() {
    let page = bar::page();
    assert!(!page.contains("@STYLE@") && !page.contains("@SCRIPT@"), "both parts are put in");
    assert_eq!(page.matches("<script>").count(), 1);
    assert_eq!(page.matches("</script>").count(), 1, "the script has no closing tag of its own");
    assert_eq!(page.matches("</style>").count(), 1);
    assert!(page.contains("Content-Security-Policy"));
    assert!(page.contains("default-src 'none'"), "no network of any kind");
    assert!(!page.contains("connect-src") && !page.contains("img-src") && !page.contains("font-src"));
    assert!(page.len() < 64 * 1024, "a small page: {} bytes", page.len());
    // The only address in it is the SVG namespace, which names nothing to load.
    for (at, _) in page.match_indices("http://") {
        assert!(page[at..].starts_with("http://www.w3.org/2000/svg"));
    }
    assert!(!page.contains("https://") && !page.contains("@import") && !page.contains("url("));
}

#[test]
fn the_bar_script_has_no_address_box_no_network_and_no_way_to_navigate() {
    let script = bar::SCRIPT;
    assert!(!script.is_empty());
    for forbidden in [
        "ipc",
        "__TAURI",
        "invoke",
        "fetch(",
        "XMLHttpRequest",
        "WebSocket",
        "sendBeacon",
        "import(",
        "importScripts",
        "eval(",
        "new Function",
        "insertAdjacentHTML",
        "document.write",
        "localStorage",
        "sessionStorage",
        "cookie",
        "<input",
        "\"input\"",
        "contenteditable",
        "location.href",
        "location.assign",
        "location.replace",
        "window.open",
        "https://",
    ] {
        assert!(!script.contains(forbidden), "bar.js must not contain {forbidden}");
    }
    // `innerHTML` is only ever given the constant Solar bodies of ICONS.
    assert_eq!(script.matches("innerHTML").count(), 1);
    assert!(script.contains("svg.innerHTML = Object.prototype.hasOwnProperty.call(ICONS, name)"));
    // The one thing it sends out is a message to the host.
    assert_eq!(script.matches("bridge.postMessage(").count(), 1);
    let style = bar::style();
    assert!(!style.contains("@import") && !style.contains("url(") && !style.contains("animation") && !style.contains("backdrop-filter"));
}
