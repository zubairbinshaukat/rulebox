#![cfg(windows)]
//! Safe wrappers around the Win32 APIs Rulebox needs. Every `unsafe` Win32 call
//! in the workspace lives in this crate, behind safe functions.
//!
//! Every function that changes the machine starts with
//! `guard::require_test_machine()?` and carries the doc line
//! `/// DESTRUCTIVE: guarded.` (plan Section 7, Step 3).

pub mod error;
pub mod guard;
pub mod pipe;
pub mod security;
pub mod sid;
pub mod util;

pub use error::{Result, Win32Error};
