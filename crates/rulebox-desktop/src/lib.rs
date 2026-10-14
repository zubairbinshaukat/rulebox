#![cfg(windows)]
//! Win32 helpers for the Staff App shell. Session-changing APIs take
//! `&ShellToken` so they cannot run in dev mode by mistake.

pub mod audio;
pub mod control;
pub mod error;
pub mod hotkeys;
pub mod icons;
pub mod launch;
pub mod mode;
pub mod msgloop;
pub mod net;
pub mod notify;
pub mod placement;
pub mod power;
pub mod system;
pub mod thumbs;
pub mod tracker;
pub mod winkey;
pub mod windows;
pub mod workarea;

pub use error::{DesktopError, Result};
pub use mode::{ShellMode, ShellToken};
pub use msgloop::{DesktopEvent, LoopCtx, MsgLoop};
pub use placement::Rect;
pub use workarea::MonitorRect;
