//! The agent <-> shell IPC contract (protocol 1.1): message types, framing codec
//! and error codes. See `docs/plans/phase-2-agent-core.md` Section 6 (1.1 is the
//! additive addendum in 6.11; nothing of 1.0 changed).
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
pub const PROTOCOL_MINOR: u16 = 1;

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
