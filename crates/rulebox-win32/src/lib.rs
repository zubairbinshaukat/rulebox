#![cfg(windows)]
//! Safe wrappers around the Win32 APIs Rulebox needs. Every `unsafe` Win32 call
//! in the workspace lives in this crate, behind safe functions.
//!
//! Every function that changes the machine starts with
//! `guard::require_test_machine()?` and carries the doc line
//! `/// DESTRUCTIVE: guarded.` (plan Section 7, Step 3).

pub mod accounts;
pub mod autologon;
pub mod dpapi;
pub mod error;
pub mod folders;
pub mod guard;
pub mod lsa;
pub mod osinfo;
pub mod pipe;
pub mod process;
pub mod registry;
pub mod security;
pub mod session;
pub mod shellreg;
pub mod sid;
pub mod util;

pub use error::{Result, Win32Error};
