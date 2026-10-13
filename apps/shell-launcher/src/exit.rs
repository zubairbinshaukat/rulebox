//! (1.1) The hidden admin exit on the fallback screen (plan Section 5.10, Step 12).
//!
//! The launcher only carries the PIN: the agent checks it, counts wrong tries and
//! signs the session out. Both calls reuse `rulebox_ipc::client::call_once`, which
//! contains the owner check, the session check, `hello` and the framing, and which
//! builds a current-thread runtime for the length of one call. Every function here
//! that talks to the pipe blocks, so the window code runs them on worker threads.
//!
//! The PIN is never logged. `submit` takes it by value and wipes its own copy.

use std::time::Duration;

use rulebox_ipc::client::{call_once, CallError, ClientConfig};
use rulebox_ipc::hotkey::{self, Hotkey, DEFAULT_ADMIN_EXIT_HOTKEY};
use rulebox_ipc::methods::{AdminExitSubmit, Empty, StateGet};
use rulebox_ipc::requests::{AdminExitOutcome, AdminExitSubmitParams, AdminExitSubmitResult};
use rulebox_ipc::types::{AgentSnapshot, ClientInfo, ClientRole};

/// `state.get` must answer within this time or the defaults are used.
pub const SETTINGS_TIMEOUT: Duration = Duration::from_secs(2);
/// `adminExit.submit` includes an Argon2 check and a sign-out preparation.
pub const SUBMIT_TIMEOUT: Duration = Duration::from_secs(10);
/// After `SigningOut` the panel waits this long for the session to end before it
/// gives up and offers another try.
pub const SIGN_OUT_GRACE: Duration = Duration::from_secs(30);

/// Shown when `SigningOut` did not end the session within `SIGN_OUT_GRACE`.
pub const SIGN_OUT_FAILED_TEXT: &str =
    "Signing out did not work. Try again, or restart this PC while holding Shift.";

/// Whether the combination does anything, and which one it is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExitSettings {
    pub enabled: bool,
    pub hotkey: Hotkey,
}

impl ExitSettings {
    /// What applies when the agent cannot be asked: the exit is offered and the
    /// agent decides when the PIN arrives (it answers `disabled` when it is off).
    pub fn fallback() -> Self {
        Self { enabled: true, hotkey: default_hotkey() }
    }
}

/// What the panel shows. `Checking` and `Ready` are local; the rest come from the
/// agent's answer through `view_for`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExitView {
    Ready,
    Checking,
    WrongPin { attempts_left: Option<u32> },
    LockedOut { retry_after_ms: u64 },
    SigningOut,
    /// Not linked, timeout, server not trusted, unknown method, any RPC error.
    Unavailable,
    /// Not enabled for this device: the panel closes.
    Disabled,
}

fn default_hotkey() -> Hotkey {
    // The constant is valid (tested in `rulebox-ipc`); the literal is the same
    // combination should that ever change.
    hotkey::parse(DEFAULT_ADMIN_EXIT_HOTKEY).unwrap_or(Hotkey {
        ctrl: true,
        alt: false,
        shift: true,
        key: hotkey::HotkeyKey::Function(12),
    })
}

fn client_info() -> ClientInfo {
    ClientInfo {
        role: ClientRole::Launcher,
        name: "rulebox-shell".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
    }
}

/// `state.get` with a 2-second timeout. Any failure, a missing `adminExit` field or
/// an unparseable combination gives the defaults.
pub fn load_settings() -> ExitSettings {
    let config = ClientConfig::production().with_timeout(SETTINGS_TIMEOUT);
    settings_from(call_once::<StateGet>(config, client_info(), Empty {}))
}

/// Pure half of `load_settings`.
pub fn settings_from(result: Result<AgentSnapshot, CallError>) -> ExitSettings {
    let Some(info) = result.ok().and_then(|snapshot| snapshot.admin_exit) else {
        return ExitSettings::fallback();
    };
    ExitSettings {
        enabled: info.enabled,
        hotkey: hotkey::parse(&info.hotkey).unwrap_or_else(|_| default_hotkey()),
    }
}

/// `adminExit.submit` with a 10-second timeout. Blocks: never call it on the
/// window thread. `pin` is wiped before this returns.
pub fn submit(pin: String) -> ExitView {
    let config = ClientConfig::production().with_timeout(SUBMIT_TIMEOUT);
    // The request needs its own copy (the IPC layer consumes and frees it); ours is
    // wiped below so the launcher itself holds the PIN only for the call.
    let params = AdminExitSubmitParams { pin: pin.clone() };
    let result = call_once::<AdminExitSubmit>(config, client_info(), params);
    wipe(pin);
    view_for(result)
}

/// Zeroes the text in place. `black_box` keeps the writes from being optimised away.
pub fn wipe(text: String) {
    let mut bytes = text.into_bytes();
    bytes.fill(0);
    std::hint::black_box(&bytes);
}

/// Maps the agent's answer to what the panel shows (pure).
pub fn view_for(result: Result<AdminExitSubmitResult, CallError>) -> ExitView {
    let Ok(answer) = result else {
        // NotLinked, Timeout, ServerNotTrusted, Protocol and every RPC error.
        return ExitView::Unavailable;
    };
    match answer.outcome {
        AdminExitOutcome::SigningOut => ExitView::SigningOut,
        AdminExitOutcome::WrongPin => ExitView::WrongPin { attempts_left: answer.attempts_left },
        // The agent always sends the wait; one minute is its shortest lock.
        AdminExitOutcome::LockedOut => ExitView::LockedOut { retry_after_ms: answer.retry_after_ms.unwrap_or(60_000) },
        AdminExitOutcome::Disabled => ExitView::Disabled,
        AdminExitOutcome::Unknown => ExitView::Unavailable,
    }
}

/// The line under the PIN field (pure). `now_remaining_ms` is the time left of a
/// lock; only `LockedOut` uses it.
pub fn message(view: &ExitView, now_remaining_ms: u64) -> String {
    match view {
        ExitView::Ready | ExitView::Disabled => String::new(),
        ExitView::Checking => "Checking\u{2026}".to_string(),
        ExitView::WrongPin { attempts_left } => match attempts_left {
            None => "That PIN is not right.".to_string(),
            Some(1) => "That PIN is not right. 1 try left.".to_string(),
            Some(n) => format!("That PIN is not right. {n} tries left."),
        },
        ExitView::LockedOut { .. } => {
            let seconds = now_remaining_ms.div_ceil(1000);
            format!("Too many tries. Try again in {}:{:02}.", seconds / 60, seconds % 60)
        }
        ExitView::SigningOut => "Signing out to Windows\u{2026}".to_string(),
        ExitView::Unavailable => "Rulebox can't check the PIN right now. Restart this PC while \
                                  holding Shift, or turn kiosk off from the dashboard."
            .to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rulebox_ipc::envelope::{ErrorCode, RpcError};
    use rulebox_ipc::hotkey::HotkeyKey;
    use rulebox_ipc::types::AdminExitInfo;

    fn answer(outcome: AdminExitOutcome, attempts_left: Option<u32>, retry_after_ms: Option<u64>) -> AdminExitSubmitResult {
        AdminExitSubmitResult { outcome, attempts_left, retry_after_ms }
    }

    #[test]
    fn each_outcome_has_its_view() {
        assert_eq!(view_for(Ok(answer(AdminExitOutcome::SigningOut, None, None))), ExitView::SigningOut);
        assert_eq!(
            view_for(Ok(answer(AdminExitOutcome::WrongPin, Some(3), None))),
            ExitView::WrongPin { attempts_left: Some(3) }
        );
        assert_eq!(
            view_for(Ok(answer(AdminExitOutcome::WrongPin, None, None))),
            ExitView::WrongPin { attempts_left: None }
        );
        assert_eq!(
            view_for(Ok(answer(AdminExitOutcome::LockedOut, None, Some(61_000)))),
            ExitView::LockedOut { retry_after_ms: 61_000 }
        );
        assert_eq!(view_for(Ok(answer(AdminExitOutcome::Disabled, None, None))), ExitView::Disabled);
    }

    #[test]
    fn unknown_outcomes_and_every_failure_are_unavailable() {
        assert_eq!(view_for(Ok(answer(AdminExitOutcome::Unknown, None, None))), ExitView::Unavailable);
        let rpc = RpcError { code: ErrorCode::Internal, message: "x".into(), retryable: true, data: None };
        for error in [
            CallError::NotLinked,
            CallError::AccessDenied,
            CallError::Timeout,
            CallError::ServerNotTrusted,
            CallError::Protocol("bad".into()),
            CallError::Rpc(rpc),
        ] {
            assert_eq!(view_for(Err(error)), ExitView::Unavailable);
        }
    }

    #[test]
    fn a_lock_without_a_wait_assumes_the_shortest_lock() {
        assert_eq!(
            view_for(Ok(answer(AdminExitOutcome::LockedOut, None, None))),
            ExitView::LockedOut { retry_after_ms: 60_000 }
        );
    }

    #[test]
    fn texts() {
        assert_eq!(message(&ExitView::LockedOut { retry_after_ms: 61_000 }, 61_000), "Too many tries. Try again in 1:01.");
        assert_eq!(message(&ExitView::LockedOut { retry_after_ms: 61_000 }, 59_001), "Too many tries. Try again in 1:00.");
        assert_eq!(message(&ExitView::LockedOut { retry_after_ms: 5_000 }, 5_000), "Too many tries. Try again in 0:05.");
        assert_eq!(message(&ExitView::WrongPin { attempts_left: None }, 0), "That PIN is not right.");
        assert_eq!(
            message(&ExitView::WrongPin { attempts_left: Some(4) }, 0),
            "That PIN is not right. 4 tries left."
        );
        assert_eq!(
            message(&ExitView::WrongPin { attempts_left: Some(1) }, 0),
            "That PIN is not right. 1 try left."
        );
        assert_eq!(message(&ExitView::SigningOut, 0), "Signing out to Windows\u{2026}");
        assert_eq!(message(&ExitView::Checking, 0), "Checking\u{2026}");
        assert!(message(&ExitView::Unavailable, 0).starts_with("Rulebox can't check the PIN right now."));
        assert!(message(&ExitView::Unavailable, 0).contains("holding Shift"));
        assert_eq!(message(&ExitView::Ready, 0), "");
        assert_eq!(message(&ExitView::Disabled, 0), "");
    }

    fn snapshot_with(admin_exit: Option<AdminExitInfo>) -> AgentSnapshot {
        let mut value = serde_json::json!({
            "agentVersion": "0.0.0",
            "enrollment": "enrolled",
            "device": null,
            "convexUrl": null,
            "connection": "online",
            "kiosk": { "enabled": true, "phase": "failed", "errorCode": null },
            "shell": { "health": "healthy" },
            "displayMode": "lite",
            "desiredState": null,
            "desiredStateVersion": 1,
            "serverTimeOffsetMs": null,
            "clockSuspect": false,
            "adminExit": null,
            "power": null,
            "orgName": null
        });
        if let Some(info) = admin_exit {
            value["adminExit"] = serde_json::to_value(info).unwrap();
        }
        serde_json::from_value(value).unwrap()
    }
    #[test]
    fn settings_come_from_the_snapshot_or_fall_back_to_the_default() {
        let default = default_hotkey();
        assert_eq!(default.canonical(), DEFAULT_ADMIN_EXIT_HOTKEY);
        assert_eq!(ExitSettings::fallback(), ExitSettings { enabled: true, hotkey: default });
        assert_eq!(settings_from(Err(CallError::NotLinked)), ExitSettings::fallback());
        assert_eq!(settings_from(Err(CallError::Timeout)), ExitSettings::fallback());
        assert_eq!(settings_from(Ok(snapshot_with(None))), ExitSettings::fallback());

        let chosen = settings_from(Ok(snapshot_with(Some(AdminExitInfo {
            enabled: true,
            hotkey: "Ctrl+Alt+K".into(),
        }))));
        assert!(chosen.enabled);
        assert_eq!(chosen.hotkey.key, HotkeyKey::Letter('K'));

        let off = settings_from(Ok(snapshot_with(Some(AdminExitInfo {
            enabled: false,
            hotkey: "Ctrl+Shift+F12".into(),
        }))));
        assert!(!off.enabled);

        let broken = settings_from(Ok(snapshot_with(Some(AdminExitInfo {
            enabled: true,
            hotkey: "Alt+Tab".into(),
        }))));
        assert_eq!(broken, ExitSettings::fallback());
    }

    #[test]
    fn wipe_accepts_any_text() {
        wipe(String::new());
        wipe("2468".to_string());
    }
}
