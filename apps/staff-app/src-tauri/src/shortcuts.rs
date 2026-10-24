//! Global shortcuts and the Windows-key hook (plan Step 16).
//!
//! **Shell mode only.** In dev mode nothing global is registered and no
//! keyboard hook is installed: the dev overlay and the per-page listener reach
//! the same actions, and the developer's own Alt+Tab and Windows key keep working.
//!
//! Registration happens on the message-loop thread. A combination another
//! program already owns fails to register; that is logged and retried every
//! 30 seconds, and the feature stays reachable by other means (the exit also
//! by the key listener in every Rulebox page).

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use rulebox_desktop::hotkeys::{self, Combo, HotkeyId, Modifiers};
use rulebox_desktop::winkey;
use rulebox_ipc::hotkey::{self as hotkey_text, Hotkey, HotkeyKey};
use rulebox_ipc::types::AdminExitInfo;
use tauri::AppHandle;

use crate::model::SessionState;
use crate::shellwin::{DesktopHost, PopupKind};
use crate::state::AppState;

/// How often a combination that could not be registered is tried again.
pub const RETRY: Duration = Duration::from_secs(30);
/// How often the Windows-key hook's health is looked at.
const HOOK_CHECK: Duration = Duration::from_secs(5);

/// A parsed combination in Win32 terms.
pub fn combo_from(hotkey: &Hotkey) -> Combo {
    let vk = match hotkey.key {
        HotkeyKey::Letter(c) => hotkeys::ascii_key(c),
        HotkeyKey::Digit(d) => hotkeys::ascii_key(char::from(b'0' + d.min(9))),
        HotkeyKey::Function(n) => Some(hotkeys::function_key(n)),
    }
    .unwrap_or_default();
    Combo {
        modifiers: Modifiers {
            ctrl: hotkey.ctrl,
            alt: hotkey.alt,
            shift: hotkey.shift,
        },
        vk,
    }
}

/// What the admin-exit hotkey should be, from the agent's snapshot.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ExitHotkey {
    /// The organization turned the exit off: the combination does nothing at all.
    Off,
    /// Register this combination (`text` is the canonical form, for logs and the page listener).
    On { text: String },
}

/// Pure. No snapshot yet means the default (the hotkey is registered before the
/// agent link exists). An unparseable combination falls back to the default.
pub fn exit_hotkey(info: Option<&AdminExitInfo>) -> ExitHotkey {
    let default = || ExitHotkey::On {
        text: hotkey_text::DEFAULT_ADMIN_EXIT_HOTKEY.to_string(),
    };
    match info {
        None => default(),
        Some(info) if !info.enabled => ExitHotkey::Off,
        Some(info) => match hotkey_text::parse(&info.hotkey) {
            Ok(_) => ExitHotkey::On {
                text: info.hotkey.clone(),
            },
            Err(error) => {
                tracing::warn!(%error, text = %info.hotkey, "unusable admin exit combination; using the default");
                default()
            }
        },
    }
}

/// The three registrations wanted right now.
fn wanted(state: &AppState) -> Vec<(HotkeyId, Option<Combo>)> {
    let snapshot = state.agent().snapshot();
    let info = snapshot.borrow().as_ref().and_then(|snap| snap.admin_exit.clone());
    let exit = match exit_hotkey(info.as_ref()) {
        ExitHotkey::Off => None,
        ExitHotkey::On { text } => hotkey_text::parse(&text).ok().map(|parsed| combo_from(&parsed)),
    };
    vec![
        (HotkeyId::SWITCHER, Some(Combo::ALT_TAB)),
        // Ctrl+Esc is not ours to take: Windows keeps it (RegisterHotKey fails
        // with 1409 on the VM). Start opens from the lone Windows key and the button.
        (HotkeyId::START, None),
        (HotkeyId::ADMIN_EXIT, exit),
    ]
}

/// Register the shortcuts and the Windows-key hook (shell mode), and keep
/// them registered. Dev mode only logs that nothing is registered.
pub fn start(app: &AppHandle, host: &Arc<DesktopHost>, state: AppState) {
    let _ = app;
    if !host.token_available() {
        tracing::info!("dev mode: no global hotkeys and no keyboard hook are registered");
        return;
    }
    let host = Arc::clone(host);
    tauri::async_runtime::spawn(async move {
        let mut registered: HashMap<i32, Combo> = HashMap::new();
        let mut snapshot = state.agent().snapshot();
        let mut hook_installed = false;
        let mut check = tokio::time::interval(HOOK_CHECK);
        check.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut next_registration = tokio::time::Instant::now();

        loop {
            if tokio::time::Instant::now() >= next_registration {
                registered = apply(&host, wanted(&state), registered).await;
                if !hook_installed {
                    hook_installed = install_hook(&host).await;
                }
                next_registration = tokio::time::Instant::now() + RETRY;
            }
            tokio::select! {
                // A new combination from the dashboard is applied at once.
                changed = snapshot.changed() => {
                    if changed.is_err() {
                        break;
                    }
                    next_registration = tokio::time::Instant::now();
                }
                _ = check.tick() => {
                    if hook_installed {
                        drop(host.run_on_loop(|ctx, token| winkey::tick(token, ctx.hwnd)));
                    }
                }
                _ = tokio::time::sleep_until(next_registration) => {}
            }
        }
    });
}

/// Make the registrations match `wanted`. Returns what is registered now.
async fn apply(
    host: &Arc<DesktopHost>,
    wanted: Vec<(HotkeyId, Option<Combo>)>,
    current: HashMap<i32, Combo>,
) -> HashMap<i32, Combo> {
    let Some(done) = host.run_on_loop(move |ctx, token| {
        let mut now = current;
        for (id, want) in wanted {
            let have = now.get(&id.0).copied();
            if have == want {
                continue;
            }
            if have.is_some() {
                hotkeys::unregister(ctx.hwnd, id);
                now.remove(&id.0);
            }
            let Some(combo) = want else { continue };
            match hotkeys::register(token, ctx.hwnd, id, combo) {
                Ok(()) => {
                    now.insert(id.0, combo);
                }
                Err(error) => {
                    // Another program may own it. Tried again in 30 seconds.
                    tracing::warn!(%error, id = id.0, "could not register a global hotkey");
                }
            }
        }
        now
    }) else {
        return HashMap::new();
    };
    done.await.unwrap_or_default()
}

async fn install_hook(host: &Arc<DesktopHost>) -> bool {
    let Some(done) = host.run_on_loop(|ctx, token| winkey::install_on_loop(token, ctx.hwnd)) else {
        return false;
    };
    match done.await {
        Ok(Ok(())) => {
            tracing::info!("the Windows-key hook is installed");
            true
        }
        Ok(Err(error)) => {
            tracing::warn!(%error, "the Windows-key hook could not be installed; Start opens by click");
            false
        }
        Err(_) => false,
    }
}

/// Pure: may the Windows key open Start in this session state?
pub fn start_allowed(session: &SessionState) -> bool {
    matches!(session, SessionState::SignedIn { locked: false, .. })
}

/// A hotkey came back from Windows (or the lone Windows key was tapped).
pub fn on_hotkey(app: &AppHandle, host: &Arc<DesktopHost>, id: HotkeyId) {
    match id {
        HotkeyId::SWITCHER => {
            if host.popup_kind() == Some(PopupKind::Switcher) {
                // A second Alt+Tab while the switcher is open moves on.
                let _ = tauri::Emitter::emit_to(app, crate::shellwin::POPUP, "popup://cycle", 1);
            } else if let Err(error) = crate::shellwin::popup_open(app, host, PopupKind::Switcher, None) {
                tracing::warn!(%error, "could not open the app switcher");
            }
        }
        HotkeyId::START => {
            // Start belongs to a signed-in, unlocked desktop: the sign-in and
            // lock screens have no Start menu.
            let unlocked = tauri::Manager::try_state::<AppState>(app).is_some_and(|state| {
                state.read(|shell| start_allowed(&shell.session))
            });
            if !unlocked {
                return;
            }
            if host.popup_kind() == Some(PopupKind::Start) {
                crate::shellwin::popup_close(app, host);
            } else if crate::shellwin::just_lost_focus(PopupKind::Start) {
                // This press is what took the focus from the open menu: it closes it.
            } else if let Err(error) = crate::shellwin::popup_open(app, host, PopupKind::Start, None) {
                tracing::warn!(%error, "could not open the Start menu");
            }
        }
        HotkeyId::ADMIN_EXIT => {
            if let Some(state) = tauri::Manager::try_state::<AppState>(app) {
                if let Err(error) = crate::exit::open(app, host, &state) {
                    tracing::warn!(%error, "could not open the administrator exit");
                }
            }
        }
        _ => {}
    }
}
