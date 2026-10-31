//! The bar above every web app's site (plan 7.10, Step 15): the pure half.
//!
//! The bar is a second, small WebView2 that shares the site's browser process and profile
//! (`barhost.rs` creates and wires it). This module holds what needs no window to be right and
//! to be tested:
//!
//! - where the bar and the site go inside the window ([`place`]): the bar owns its own strip, so the
//!   site is never covered; full screen hides the bar; a menu may grow the bar over the site;
//! - what the display-only address shows ([`address_of`]);
//! - the registry of actions for the right-hand slot ([`ACTIONS`]);
//! - the page itself ([`page`]), assembled from `bar.html`, `bar.css` and `bar.js`.

use serde::Serialize;
use tauri::Url;

use super::blocked;

/// The height of the bar, in logical pixels (96 dpi).
pub const BAR_HEIGHT_LOGICAL: i32 = 44;

/// The bar's page. `bar.html` is the shell; the style and the script are put in by [`page`].
const TEMPLATE: &str = include_str!("bar.html");
const STYLE: &str = include_str!("bar.css");
pub const SCRIPT: &str = include_str!("bar.js");

/// The finished document, for `NavigateToString`. Self-contained: no address in it is ever fetched.
pub fn page() -> String {
    TEMPLATE.replace("/*@STYLE@*/", STYLE).replace("/*@SCRIPT@*/", SCRIPT)
}

/// `bar.css`, for tests.
pub fn style() -> &'static str {
    STYLE
}

/// A rectangle in pixels, relative to the web view's container (the window's client area).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

/// The bar's height in physical pixels at `dpi` (96 = 100 %), rounded to the nearest pixel.
pub fn bar_height(dpi: u32) -> i32 {
    let dpi = if dpi == 0 { 96 } else { dpi.min(1000) } as i32;
    (BAR_HEIGHT_LOGICAL * dpi + 48) / 96
}

/// Where the two web views go.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Placement {
    /// `None`: the bar is hidden (a page in full screen).
    pub bar: Option<Rect>,
    pub site: Rect,
}

/// Lay the bar and the site out in a client area of `width` x `height` pixels.
///
/// - Normally the bar takes the top strip and the site everything below it. They never overlap, so
///   nothing of the site is hidden.
/// - `fullscreen` (the page asked for HTML full screen): no bar; the site fills the area.
/// - `expanded` (the bar's menu is open): the bar's web view covers the whole area (transparent below
///   its strip) so the menu has room and a click outside closes it; the site keeps its place.
pub fn place(width: i32, height: i32, dpi: u32, fullscreen: bool, expanded: bool) -> Placement {
    let (width, height) = (width.max(0), height.max(0));
    if fullscreen {
        return Placement {
            bar: None,
            site: Rect {
                left: 0,
                top: 0,
                right: width,
                bottom: height,
            },
        };
    }
    let strip = bar_height(dpi).min(height);
    Placement {
        bar: Some(Rect {
            left: 0,
            top: 0,
            right: width,
            bottom: if expanded { height } else { strip },
        }),
        site: Rect {
            left: 0,
            top: strip,
            right: width,
            bottom: height,
        },
    }
}

/// What the address field is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AddressKind {
    /// A page of the site: the host and the rest of the address.
    Site,
    /// No site address worth showing (the window's start page, the browser's own pages): the app's name.
    App,
    /// Rulebox's "This site is not allowed" page: the app's name, flagged.
    Blocked,
}

/// The display-only address, as the bar draws it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct AddressView {
    pub kind: AddressKind,
    /// An `https` address (the lock). `false` for `http` and for everything that is not a site.
    pub secure: bool,
    /// Shown prominently: the host (with a non-default port), or the app's name.
    pub host: String,
    /// Shown dimmer after the host: path, query and fragment. Empty for the site's root.
    pub rest: String,
    /// The tooltip: the full address, or what the page is.
    pub title: String,
}

const REST_MAX: usize = 400;
const TITLE_MAX: usize = 2000;
const NAME_MAX: usize = 80;

fn clip(text: &str, max: usize) -> String {
    text.chars().filter(|c| !c.is_control()).take(max).collect()
}

/// What the address field shows for the page WebView2 reports as its `Source`.
///
/// Only `http(s)` pages with a host are shown as addresses (the allow-list lets only `https`
/// through; `http` appears if WebView2 reports a failed load). Everything else - `about:blank`, the
/// blocked page, `edge:` error pages, anything unparsable - shows the allowed app's name instead.
/// The host is the one the URL parser produced, so a look-alike (IDN) host appears in its `xn--`
/// form.
pub fn address_of(source: &str, app_name: &str) -> AddressView {
    let name = clip(app_name, NAME_MAX);
    let plain = |kind, title: String| AddressView {
        kind,
        secure: false,
        host: name.clone(),
        rest: String::new(),
        title,
    };
    let Ok(url) = Url::parse(source) else {
        return plain(AddressKind::App, name.clone());
    };
    if blocked::is_blocked_page(&url) {
        return plain(AddressKind::Blocked, format!("{name}: that site is not allowed"));
    }
    let secure = match url.scheme() {
        "https" => true,
        "http" => false,
        _ => return plain(AddressKind::App, name.clone()),
    };
    let Some(host) = url.host_str() else {
        return plain(AddressKind::App, name.clone());
    };
    let host = match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_string(),
    };
    let mut rest = url.path().to_string();
    if let Some(query) = url.query() {
        rest.push('?');
        rest.push_str(query);
    }
    if let Some(fragment) = url.fragment() {
        rest.push('#');
        rest.push_str(fragment);
    }
    if rest == "/" {
        rest.clear();
    }
    AddressView {
        kind: AddressKind::Site,
        secure,
        host: clip(&host, 253 + 6),
        rest: clip(&rest, REST_MAX),
        title: clip(url.as_str(), TITLE_MAX),
    }
}

/// What an action's handler is told.
pub struct ActionContext<'a> {
    pub app_id: &'a str,
    pub app_name: &'a str,
}

/// One button in the bar's right-hand slot.
pub struct BarAction {
    /// Stable, `[a-z0-9-_]`, at most 64 characters.
    pub id: &'static str,
    /// The tooltip and the accessible name.
    pub label: &'static str,
    /// A key of `ICONS` in `bar.js` (a Solar `-linear` icon). See [`ICON_KEYS`].
    pub icon: &'static str,
    pub run: fn(&ActionContext<'_>),
}

/// The actions the bar offers, left to right. **Empty on purpose**: the slot is ready (icon buttons with
/// tooltips, "More" menu when they do not fit), and a feature adds one entry here:
///
/// ```ignore
/// BarAction { id: "about", label: "About this app", icon: "info", run: about_this_app },
/// ```
pub const ACTIONS: &[BarAction] = &[];

/// The icon keys `bar.js` can draw for an action.
pub const ICON_KEYS: &[&str] = &["info", "star", "more"];

/// Whether `id` can be an action id (what the bar may send back).
pub fn valid_action_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
}

/// The action with this id.
pub fn find<'a>(actions: &'a [BarAction], id: &str) -> Option<&'a BarAction> {
    actions.iter().find(|action| action.id == id)
}

#[derive(Serialize)]
pub struct ActionView {
    pub id: &'static str,
    pub label: &'static str,
    pub icon: &'static str,
}

/// The registry as the bar is told about it.
pub fn action_views(actions: &[BarAction]) -> Vec<ActionView> {
    actions
        .iter()
        .map(|action| ActionView {
            id: action.id,
            label: action.label,
            icon: action.icon,
        })
        .collect()
}

/// The bar's background as `(r, g, b)` for the window behind it and the web view before its page has
/// painted: `--rb-surface` of the light and dark tokens. (`bar.css` carries the exact `oklch` values.)
pub fn surface_rgb(dark: bool) -> (u8, u8, u8) {
    if dark {
        (19, 26, 37)
    } else {
        (254, 253, 252)
    }
}
