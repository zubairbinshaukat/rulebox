#![cfg(windows)]
//! Safe wrappers around the Win32 APIs Rulebox needs. Every `unsafe` Win32 call
//! in the workspace lives in this crate, behind safe functions.
//!
//! Every function that changes the machine starts with
//! `guard::require_test_machine()?` and carries the doc line
//! `/// DESTRUCTIVE: guarded.` (plan Section 7, Step 3). When the function also checks an
//! allow-list of keys, folders or names (Phase 5, plan 4.5 rule 2), that pure `check_*`
//! call comes first and refuses with `Win32Error::Forbidden` before the guard; the
//! text-scanning test in `tests/guard_coverage.rs` holds both rules in place.

pub mod accounts;
pub mod applocker;
pub mod atomic;
pub mod autologon;
pub mod bcd;
pub mod codeintegrity;
pub mod dpapi;
pub mod error;
pub mod etw;
pub mod eventlog;
pub mod fileid;
pub mod folders;
pub mod guard;
pub mod job;
pub mod lsa;
pub mod machinereg;
pub mod osinfo;
pub mod pipe;
pub mod posture;
pub mod printing;
pub mod process;
pub mod registry;
pub mod security;
pub mod service;
pub mod session;
pub mod shellreg;
pub mod sid;
pub mod staffreg;
pub mod tree;
pub mod util;
pub mod wlan;
pub mod wmi;

pub use error::{Result, Win32Error};
