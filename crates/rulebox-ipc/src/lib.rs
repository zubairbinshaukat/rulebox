//! The agent <-> shell IPC contract (protocol 1.0): message types, framing codec
//! and error codes. See `docs/plans/phase-2-agent-core.md` Section 6.
//!
//! TypeScript types for `types.rs` are generated with ts-rs into
//! `packages/types/src/generated/` (run `pnpm gen:types`).

use std::time::Duration;

pub mod admin;
#[cfg(feature = "client")]
pub mod client;
#[cfg(any(feature = "client", feature = "server"))]
pub mod codec;
pub mod envelope;
pub mod methods;
#[cfg(feature = "server")]
pub mod server;
pub mod types;

pub use envelope::{ErrorCode, Frame, RpcError};
pub use methods::Method;

pub const PROTOCOL_MAJOR: u16 = 1;
pub const PROTOCOL_MINOR: u16 = 0;

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

/// Capabilities the agent lists in the `hello` result.
pub const CAPABILITIES: &[&str] = &["state", "health"];
