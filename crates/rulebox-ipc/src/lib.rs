//! The agent <-> shell IPC contract (protocol 1.4): message types, framing codec
//! and error codes. See `docs/plans/phase-2-agent-core.md` Section 6 (1.1 is the
//! additive addendum in 6.11; nothing of 1.0 changed), Phase 4 Section 5.2 (1.2),
//! `docs/plans/phase-5-lockdown.md` Section 4.12 (1.3) and
//! `docs/plans/phase-6-installer-pilot.md` Section 4.15 (1.4).
//!
//! TypeScript types for `types.rs` are generated with ts-rs into
//! `packages/types/src/generated/` (run `pnpm gen:types`). The 1.1 request and
//! result types in `requests.rs` are not exported: the Staff App keeps IPC on its
//! Rust side.

use std::time::Duration;

/// Deserializes an enum from a string; any value not listed becomes `Unknown`.
/// Written by hand because ts-rs cannot parse `#[serde(other)]` (it warns on
/// every build); the wire format is the same. Must stay above the `mod` lines so
/// the modules can see it.
macro_rules! unknown_on_new_values {
    ($ty:ident { $($variant:ident => $text:literal),+ $(,)? }) => {
        impl<'de> serde::Deserialize<'de> for $ty {
            fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
                let text = <String as serde::Deserialize>::deserialize(d)?;
                Ok(match text.as_str() {
                    $($text => Self::$variant,)+
                    _ => Self::Unknown,
                })
            }
        }
    };
}

pub mod admin;
#[cfg(feature = "client")]
pub mod client;
#[cfg(any(feature = "client", feature = "server"))]
pub mod codec;
pub mod envelope;
pub mod hotkey;
pub mod methods;
pub mod requests;
#[cfg(feature = "server")]
pub mod server;
pub mod types;

pub use envelope::{ErrorCode, Frame, RpcError};
pub use methods::Method;

pub const PROTOCOL_MAJOR: u16 = 1;
/// (Phase 4 Step 13) 1.2 adds the `apps.changed` and `session.ended` events and
/// the sign-in outcome `notAllowedHere` (plan Phase 4, Section 5.2). Additive: a
/// 1.1 client ignores the events and reads the outcome as `Unknown`.
///
/// (Phase 5 Step 12) 1.3 adds the device lock, broadcasts, keyboard, printing and
/// network fields of the snapshot, the events `device.lockChanged`,
/// `broadcasts.changed` and `program.blocked`, the requests `broadcast.acknowledge`
/// and `webapp.reportDenials`, and the value `deviceLocked` of the sign-in outcome
/// and of the `session.ended` reason (plan Phase 5, 4.12 and 4.17). Additive: a 1.1
/// or 1.2 client ignores the events and the new snapshot keys and reads the new
/// values as `Unknown`; a 1.3 client on an older agent finds the capabilities
/// missing and shows nothing of it.
///
/// (Phase 6 Step 4) 1.4 adds `WebApp.browser`, `browserExe` and `browserReady`, the
/// `AppEntry.update` state, the snapshot's `webWindowCap`, `webIdleCloseMin` and
/// `displayModeSource`, and the event `apps.updating`; `DesktopApp.exe` is now the
/// **resolved** path of a template with a `*` folder (plan Phase 6, 4.15). Additive, same
/// major: a 1.3 Staff App ignores the new keys and the event and opens every web app in
/// the built-in window; a 1.4 Staff App on a 1.3 agent finds them missing and reads the
/// defaults (built-in window, no update state, its own window cap and idle close).
pub const PROTOCOL_MINOR: u16 = 4;

/// Pipe the Staff App connects to.
pub const SHELL_PIPE: &str = r"\\.\pipe\dev.rulebox.agent.shell";
/// Pipe the agent CLI (`enroll`, `status`, `unenroll`) connects to.
pub const ADMIN_PIPE: &str = r"\\.\pipe\dev.rulebox.agent.admin";
/// Appended to both pipe names in simulate mode.
pub const SIM_SUFFIX: &str = ".sim";

/// Largest frame (the JSON payload, not the length prefix) in either direction.
pub const MAX_FRAME_LEN: usize = 1_048_576;
/// Most requests a client may have in flight on one connection.
pub const MAX_IN_FLIGHT: usize = 16;
/// Time a new connection has to send `hello`.
pub const HELLO_DEADLINE: Duration = Duration::from_secs(5);
/// How often the Staff App sends `shell.heartbeat` after `shell.ready`.
pub const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(10);
/// Silence after which the agent treats the Staff App as hung.
pub const HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(30);

/// Capabilities the agent always lists in the `hello` result. The 1.1
/// capabilities below are listed on top of these when they apply.
pub const CAPABILITIES: &[&str] = &["state", "health"];
/// (1.1) `session.*` methods; listed when the employee directory is available.
pub const CAP_SESSION: &str = "session";
/// (1.1) `apps.list`; same condition as `session`.
pub const CAP_APPS: &str = "apps";
/// (1.1) `adminExit.submit` and the snapshot field `adminExit`.
pub const CAP_ADMIN_EXIT: &str = "adminExit";
/// (1.2) The agent sends `apps.changed`; listed with `apps`.
pub const CAP_APPS_CHANGED: &str = "appsChanged";
/// (1.2) The agent sends `session.ended`; listed with `session`.
pub const CAP_SESSION_ENDED: &str = "sessionEnded";
/// (1.3) The snapshot's `deviceLock` and the event `device.lockChanged`; always on a 1.3 agent.
pub const CAP_DEVICE_LOCK: &str = "deviceLock";
/// (1.3) The snapshot's `broadcasts`, the event `broadcasts.changed` and the request
/// `broadcast.acknowledge`.
pub const CAP_BROADCASTS: &str = "broadcasts";
/// (1.3) The snapshot's `keyboard` (Windows-key combinations).
pub const CAP_KEYBOARD_POLICY: &str = "keyboardPolicy";
/// (1.3) The request `webapp.reportDenials`.
pub const CAP_PERMISSION_REPORTS: &str = "permissionReports";
/// (1.4) `WebApp.browser`, `browserExe` and `browserReady` are filled in (browser web
/// apps, plan 4.9). Without it the Staff App opens every web app in the built-in window.
pub const CAP_BROWSER_APPS: &str = "browserApps";
/// (1.4) `AppEntry.update` and the event `apps.updating` (plan 4.4.5). Without it the
/// Staff App shows no "Updating..." state.
pub const CAP_APP_UPDATES: &str = "appUpdates";
