//! Navigation of web app windows: Back, Forward, Reload / Stop and the address the bar shows
//! (Phase 3, round 3; the bar replaced the first floating pill in round 4).
//!
//! The bar is a small WebView2 above the site (`bar.rs`, `barhost.rs`). This module is the pure
//! half of how it is fed and driven:
//!
//! - which keys mean Back, Forward and Reload ([`shortcut`]);
//! - what the bar must show ([`NavState`]), built only from what WebView2 reports (`CanGoBack`,
//!   `CanGoForward`, `Source`, the navigation events), never guessed;
//! - the message that carries it to the bar ([`message`]), and the strict reading of what the bar
//!   sends back ([`parse_command`]).
//!
//! `barhost.rs` connects it to the real WebView2s.

use serde::Serialize;

use super::bar::{self, ActionView, AddressView, BarAction};
use crate::model::ThemeDto;

/// What a key or a button asks the web view to do.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NavAction {
    Back,
    Forward,
    Reload,
    /// Reload's other face while a page loads.
    Stop,
}

/// Which modifier keys are down.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Modifiers {
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
}

pub const VK_LEFT: u32 = 0x25;
pub const VK_RIGHT: u32 = 0x27;
pub const VK_F5: u32 = 0x74;
pub const VK_R: u32 = 0x52;

/// Alt+Left and Alt+Right step through the history, F5 and Ctrl+R reload (with or without
/// Shift or Ctrl: a "hard" reload is just a reload here). Anything with an extra modifier
/// (Ctrl+Alt+Left, AltGr combinations) is not ours. The keys do nothing in Rulebox's own windows:
/// the handler that calls this is on the web windows only, and WebView2 raises it only for the
/// window that has the focus (the site or the bar of that window).
pub fn shortcut(vk: u32, keys: Modifiers) -> Option<NavAction> {
    match vk {
        VK_LEFT if keys.alt && !keys.ctrl && !keys.shift => Some(NavAction::Back),
        VK_RIGHT if keys.alt && !keys.ctrl && !keys.shift => Some(NavAction::Forward),
        VK_F5 if !keys.alt => Some(NavAction::Reload),
        VK_R if keys.ctrl && !keys.alt => Some(NavAction::Reload),
        _ => None,
    }
}

/// Whether the key does anything right now. A key that does nothing is left to the page
/// (Alt+Left at the first page of the window is not swallowed).
pub fn applies(action: NavAction, can_go_back: bool, can_go_forward: bool) -> bool {
    match action {
        NavAction::Back => can_go_back,
        NavAction::Forward => can_go_forward,
        NavAction::Reload | NavAction::Stop => true,
    }
}

/// What the buttons show.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub struct NavView {
    pub back: bool,
    pub forward: bool,
    pub loading: bool,
}

/// How the bar looks: the employee's theme and whether motion is off (Lite mode or reduced motion).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Look {
    pub theme: &'static str,
    pub calm: bool,
}

impl Look {
    pub fn new(theme: ThemeDto, calm: bool) -> Self {
        Self {
            theme: match theme {
                ThemeDto::Light => "light",
                ThemeDto::Dark => "dark",
                ThemeDto::Auto => "auto",
            },
            calm,
        }
    }

    /// Whether the dark tokens apply. `auto` is decided by the bar itself (it asks the system), so
    /// for the colour painted before it exists this says light.
    pub fn is_dark(&self) -> bool {
        self.theme == "dark"
    }
}

/// One web window's navigation state, fed by WebView2's events.
#[derive(Debug, Default)]
pub struct NavState {
    can_back: bool,
    can_forward: bool,
    loading: bool,
    /// The only entry behind this one is the window's own `about:blank`, which is never shown.
    blank_below: bool,
    /// WebView2's `Source`: the address of the page being shown.
    source: String,
    sent: Option<(NavView, Look, AddressView)>,
}

impl NavState {
    /// What the buttons show now.
    pub fn view(&self) -> NavView {
        NavView {
            // Back is for pages the person saw: the window's blank start page is not one.
            back: self.can_back && !self.blank_below,
            forward: self.can_forward,
            loading: self.loading,
        }
    }

    /// WebView2's own answer (`CanGoBack`, `CanGoForward`), read after a history change.
    pub fn history(&mut self, can_back: bool, can_forward: bool) {
        self.can_back = can_back;
        self.can_forward = can_forward;
        if !can_back {
            self.blank_below = false;
        }
    }

    /// WebView2's `Source` changed (a new page, a redirect, a `pushState`, a step in the history).
    pub fn navigated(&mut self, source: &str) {
        if self.source != source {
            self.source = source.to_string();
        }
    }

    /// A navigation began and was not refused: a new page, a reload, a step in the history.
    pub fn started(&mut self) {
        self.loading = true;
        self.blank_below = false;
    }

    /// The navigation ended, whether it worked or not.
    pub fn completed(&mut self) {
        self.loading = false;
    }

    /// A navigation was refused (a site that is not allowed, the blank page): nothing is loading.
    pub fn refused(&mut self) {
        self.loading = false;
    }

    /// History stepped back onto the window's own `about:blank` and the gate turned it away: that
    /// entry is not a page, so Back has nowhere to go until the next real navigation.
    pub fn blank_below(&mut self) {
        self.blank_below = true;
        self.loading = false;
    }

    /// The address as the bar shows it.
    pub fn address(&self, app_name: &str) -> AddressView {
        bar::address_of(&self.source, app_name)
    }

    /// The message for the bar, or `None` when it would only repeat the last one. `force` sends it
    /// regardless: the bar's page was just (re)loaded and has seen nothing yet.
    pub fn next_message(&mut self, force: bool, look: Look, app_name: &str) -> Option<String> {
        let now = (self.view(), look, self.address(app_name));
        if !force && self.sent.as_ref() == Some(&now) {
            return None;
        }
        let text = message(now.0, look, &now.2, bar::ACTIONS);
        self.sent = Some(now);
        Some(text)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Message<'a> {
    rb_bar: u8,
    back: bool,
    forward: bool,
    loading: bool,
    theme: &'static str,
    calm: bool,
    address: &'a AddressView,
    actions: Vec<ActionView>,
}

/// The JSON the host posts to the bar (`bar.js` ignores anything without `rbBar: 1`).
pub fn message(view: NavView, look: Look, address: &AddressView, actions: &[BarAction]) -> String {
    serde_json::to_string(&Message {
        rb_bar: 1,
        back: view.back,
        forward: view.forward,
        loading: view.loading,
        theme: look.theme,
        calm: look.calm,
        address,
        actions: bar::action_views(actions),
    })
    .unwrap_or_default()
}

/// What the bar can ask for. Anything else it sends is ignored.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BarCommand {
    /// The bar's page is listening: send it everything.
    Ready,
    /// A navigation button. `mouse`: the page should get the focus back (Chrome does the same).
    Nav { action: NavAction, mouse: bool },
    /// An action of the registry.
    Action(String),
    /// The overflow menu opened (`true`: the bar's web view grows over the site) or closed.
    Menu(bool),
    /// Escape in the bar: back to the page.
    FocusPage,
}

/// Read a message from the bar's page. Strict: exactly `rbBar: 1`, a known `t`, known values.
pub fn parse_command(json: &str) -> Option<BarCommand> {
    if json.len() > 2048 {
        return None;
    }
    let value: serde_json::Value = serde_json::from_str(json).ok()?;
    let object = value.as_object()?;
    if object.get("rbBar")?.as_u64()? != 1 {
        return None;
    }
    match object.get("t")?.as_str()? {
        "ready" => Some(BarCommand::Ready),
        "focus-page" => Some(BarCommand::FocusPage),
        "menu" => Some(BarCommand::Menu(object.get("open")?.as_bool()?)),
        "nav" => {
            let action = match object.get("a")?.as_str()? {
                "back" => NavAction::Back,
                "forward" => NavAction::Forward,
                "reload" => NavAction::Reload,
                "stop" => NavAction::Stop,
                _ => return None,
            };
            let mouse = object.get("by").and_then(serde_json::Value::as_str) == Some("mouse");
            Some(BarCommand::Nav { action, mouse })
        }
        "action" => {
            let id = object.get("id")?.as_str()?;
            bar::valid_action_id(id).then(|| BarCommand::Action(id.to_string()))
        }
        _ => None,
    }
}
