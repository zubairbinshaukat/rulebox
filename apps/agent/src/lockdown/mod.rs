//! Phase 5 lockdown (plan Section 4): the seven layers and the transaction that
//! applies a verified document to them. Step 2 is the skeleton only: the order of
//! plan 4.11 step 3 with every layer a no-op that reports `off` / `ok`. Each later
//! step fills one layer in; none of them may write to the system except through
//! `journal::change`.
//!
//! Step 4 added L1 (`staff`), the invariants of plan 4.6 (`invariants`) and the USB
//! class tables (`usb`). Step 5 added L2 (`machine`: machine policies, admin tiles,
//! account lockout, the device-class rules) and the boot part of L7 (`boot`: Safe Mode
//! registration and behaviour, auto-recovery, the protection report).
//!
//! Step 6 added L4 (`appcontrol`). Step 7 added L3 (`applocker`, with the allow-list model of
//! `allowlist`) and the file-output printers of L2 (`printers`). Step 8 added L5 (`procwatch`,
//! on the process-start trace of `rulebox_win32::etw`); its `ProcWatchHost` holds a running
//! trace, so it belongs to the runtime, not to `apply::run_layer` (which says "off" for L5 and
//! is overwritten with the watch's own state by `runtime`).
//!
//! Step 9 added what the lockdown says about itself: `findings` (what the layers would stop or
//! stopped, privacy-reduced), `daily` (the security counters per server day), `drift` (values
//! changed behind our back, and the "fighting" guard), `lkg` (last-known-good, probation and the
//! rollback) and `reporting` (the change-driven, batched calls to the backend; the payloads are in
//! `backend::reports`). Step 10 writes the Convex functions they call.
//!
//! Step 17 added the tamper part of L7 (`tamper`: the agent service's DACL and required
//! privileges, the ACL self-check of the Rulebox folders, and the clock-jump watch).
//!
//! Step 20 wired all of it into the live agent: `runtime` is what the kiosk reconciler calls
//! (one pass per trigger: apply, process watch, drift, tamper, findings, reports, probation), and
//! `status` is the read-only `rulebox-agent lockdown-status`.
//!
//! Some helpers are only read by the tests and by `lockdown-status`.
#![allow(dead_code)]

use serde::{Deserialize, Serialize};

pub mod allowlist;
pub mod apply;
pub mod appcontrol;
pub mod applocker;
pub mod boot;
pub mod daily;
pub mod drift;
pub mod findings;
pub mod invariants;
pub mod lkg;
pub mod machine;
// (Step 18) Per-user tuning and the kiosk performance profile (PRD 22.2, 22.3).
pub mod perf;
pub mod printers;
pub mod procwatch;
pub mod reporting;
// (Step 20) The live wiring and the read-only status command.
pub mod runtime;
pub mod staff;
pub mod status;
pub mod tamper;
pub mod usb;

/// What a layer reports as its mode (`layerState.mode`, plan 4.11).
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ReportedMode {
    Off,
    Audit,
    Enforce,
    On,
}

/// What a layer reports as its state (`layerState.state`, plan 4.11).
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum LayerStatus {
    Ok,
    Partial,
    Failed,
    Unsupported,
    RestartPending,
    AuditFirst,
}

/// `LayerState { mode, state, detail? }` (plan 4.11). `detail` is a fixed code,
/// never free text from Windows.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LayerState {
    pub mode: ReportedMode,
    pub state: LayerStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl LayerState {
    /// The skeleton's answer for every layer: nothing applied, nothing wrong.
    pub fn off_ok() -> Self {
        Self { mode: ReportedMode::Off, state: LayerStatus::Ok, detail: None }
    }
}

/// The apply report's `layerStates` (plan 4.11).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LayerStates {
    /// L1.
    pub staff: LayerState,
    /// L2.
    pub machine: LayerState,
    /// L3.
    pub app_locker: LayerState,
    /// L4.
    pub app_control: LayerState,
    /// L5.
    pub proc_watch: LayerState,
    /// L7.
    pub boot: LayerState,
    pub performance: LayerState,
}

impl LayerStates {
    pub fn all_off() -> Self {
        Self {
            staff: LayerState::off_ok(),
            machine: LayerState::off_ok(),
            app_locker: LayerState::off_ok(),
            app_control: LayerState::off_ok(),
            proc_watch: LayerState::off_ok(),
            boot: LayerState::off_ok(),
            performance: LayerState::off_ok(),
        }
    }
}
