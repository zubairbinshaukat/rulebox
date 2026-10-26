//! The hidden administrator exit (plan Section 7.11).
//!
//! Key combination -> PIN dialog -> the **agent** checks the PIN and signs the
//! Staff session out. This module only shows the dialog and relays the
//! answer: it never checks a PIN, never holds a hash, never signs out itself.
//!
//! The dialog is its own window (`shell-exit`) with its own tiny page
//! (`exit.html`), opened from Rust, so it works on every shell screen and even
//! when another page has crashed.

use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use ts_rs::TS;

use crate::agent::AgentError;
use crate::model::{AdminExitOutcome, AgentLinkDto, SessionState, ThemeDto};
use crate::shellwin::{popup_close, DesktopHost};
use crate::state::AppState;

pub const EXIT: &str = "shell-exit";

/// The agent gets this long to answer a PIN.
pub const SUBMIT_TIMEOUT: Duration = Duration::from_secs(10);
const WIDTH: f64 = 440.0;
const HEIGHT: f64 = 380.0;

/// What the dialog needs to know, and nothing else.
#[derive(Serialize, Clone, Debug, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AdminExitView {
    pub link: AgentLinkDto,
    /// The agent supports the exit (or its abilities are not known yet).
    pub supported: bool,
    /// The organization has not turned the exit off.
    pub enabled: bool,
    pub lite: bool,
    pub theme: ThemeDto,
}

/// What `admin_exit_submit` tells the page.
#[derive(Serialize, Clone, Debug, PartialEq, Eq, TS)]
#[serde(tag = "status", rename_all = "camelCase", rename_all_fields = "camelCase")]
#[ts(export)]
pub enum ExitAnswer {
    /// The agent is ending the session. The window stays until it does.
    SigningOut,
    WrongPin {
        attempts_left: Option<u32>,
    },
    LockedOut {
        #[ts(type = "number")]
        retry_after_ms: u64,
    },
    /// The organization turned the exit off: the dialog closes.
    Disabled,
    /// No answer: not linked, no reply in time, or an answer we do not know.
    Unavailable,
}

/// Pure: the agent's answer (or its failure) as the page should see it.
pub fn answer(result: Result<AdminExitOutcome, AgentError>) -> ExitAnswer {
    match result {
        Ok(AdminExitOutcome::SigningOut) => ExitAnswer::SigningOut,
        Ok(AdminExitOutcome::WrongPin { attempts_left }) => ExitAnswer::WrongPin { attempts_left },
        Ok(AdminExitOutcome::LockedOut { retry_after_ms }) => ExitAnswer::LockedOut { retry_after_ms },
        Ok(AdminExitOutcome::Disabled) => ExitAnswer::Disabled,
        Ok(AdminExitOutcome::Unknown) => ExitAnswer::Unavailable,
        Err(_) => ExitAnswer::Unavailable,
    }
}

/// A PIN is 4 to 12 digits. Checked before anything is sent.
pub fn pin_is_well_formed(pin: &str) -> bool {
    (4..=12).contains(&pin.len()) && pin.bytes().all(|b| b.is_ascii_digit())
}

/// Pure: the dialog's view for a session state, link and snapshot facts.
/// Works in every `SessionState` and with the link down.
pub fn view_of(
    link: AgentLinkDto,
    capabilities: &[String],
    admin_exit_enabled: Option<bool>,
    lite: bool,
    theme: ThemeDto,
) -> AdminExitView {
    let linked = matches!(link, AgentLinkDto::Linked);
    AdminExitView {
        link,
        // Before the link, nothing is known about the agent: it is not "unsupported".
        supported: !linked || capabilities.iter().any(|c| c == rulebox_ipc::CAP_ADMIN_EXIT),
        // No snapshot yet: the default stands (the hotkey exists before the agent link does).
        enabled: admin_exit_enabled.unwrap_or(true),
        lite,
        theme,
    }
}

pub fn view(state: &AppState) -> AdminExitView {
    let snapshot = state.agent().snapshot();
    let enabled = snapshot
        .borrow()
        .as_ref()
        .and_then(|snap| snap.admin_exit.as_ref().map(|info| info.enabled));
    state.read(|shell| {
        view_of(
            shell.link,
            &shell.capabilities,
            enabled,
            shell.display.lite,
            shell.display.theme,
        )
    })
}

/// The combination the pages listen for, or `None` when the exit is off.
pub fn hotkey_text(state: &AppState) -> Option<String> {
    let snapshot = state.agent().snapshot();
    let info = snapshot.borrow().as_ref().and_then(|snap| snap.admin_exit.clone());
    match crate::shortcuts::exit_hotkey(info.as_ref()) {
        crate::shortcuts::ExitHotkey::Off => None,
        crate::shortcuts::ExitHotkey::On { text } => Some(text),
    }
}

/// Open the dialog (or bring it forward). Does nothing when the organization
/// turned the exit off. Works in any session state and with no agent link.
pub fn open(app: &AppHandle, host: &Arc<DesktopHost>, state: &AppState) -> Result<(), String> {
    if !view(state).enabled {
        return Ok(());
    }
    // The popup must not sit on top of (or fight for) the dialog.
    popup_close(app, host);
    if let Some(window) = app.get_webview_window(EXIT) {
        let _ = window.unminimize();
        let _ = window.show();
        window.set_focus().map_err(|error| format!("focus the exit dialog: {error}"))?;
        return Ok(());
    }
    let builder = WebviewWindowBuilder::new(app, EXIT, WebviewUrl::App("exit.html".into()));
    let builder = match crate::shellwin::local_browser_args() {
        Some(args) => builder.additional_browser_args(&args),
        None => builder,
    };
    let window = builder
        .title("Rulebox administrator exit")
        .decorations(false)
        .resizable(false)
        .always_on_top(true)
        .inner_size(WIDTH, HEIGHT)
        .center()
        .focused(true)
        .shadow(true)
        .devtools(cfg!(debug_assertions))
        .disable_drag_drop_handler()
        .build()
        .map_err(|error| format!("create the exit dialog: {error}"))?;
    let _ = window.set_focus();
    tracing::info!("the administrator exit dialog opened");
    Ok(())
}

/// Tell the dialog when something it shows has changed (link back, theme, Lite).
pub fn push_if_changed(app: &AppHandle, state: &AppState) {
    if app.get_webview_window(EXIT).is_none() {
        return;
    }
    let _ = app.emit_to(EXIT, "exit://state", view(state));
}

/// Relay a PIN to the agent. The PIN is dropped when this returns and is never logged.
pub async fn submit(state: &AppState, pin: String) -> ExitAnswer {
    if !pin_is_well_formed(&pin) {
        // The page filters the input; this is the same check on the Rust side.
        return ExitAnswer::WrongPin { attempts_left: None };
    }
    let agent = state.agent();
    let result = match tokio::time::timeout(SUBMIT_TIMEOUT, agent.admin_exit(pin)).await {
        Ok(result) => result,
        Err(_) => Err(AgentError::Timeout),
    };
    let answered = answer(result);
    tracing::info!(outcome = ?std::mem::discriminant(&answered), "administrator exit answered");
    answered
}

/// Which session states the dialog can be opened in: all of them.
pub fn opens_in(_session: &SessionState) -> bool {
    true
}
