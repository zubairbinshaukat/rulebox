//! Drift detection and the "fighting" guard (plan 4.11 "Drift", edge case 23).
//!
//! The reconcile loop re-applies the current document (Phase 2 `REASSERT_INTERVAL`, every agent
//! start, and when the OS build number changes: [`DriftTracker::reassert_due`]). A journal
//! target that was `Applied` and no longer holds its value is written again by `journal::change`
//! **without touching `original`**, and the journal notes it (`SharedState::take_rewrites`). The
//! tracker turns those notes into:
//!
//! * `deviceSecurityDaily.drift`, counted for every rewrite (a local number, no call);
//! * one `device.driftReasserted` audit record **per target per server day** (the Phase 4 audit
//!   queue; a fixed code and a short hash of the target, never a registry path or a file path);
//! * the "fighting" guard: a target rewritten more than [`FIGHTING_REWRITES`] times within an hour
//!   is left alone for the rest of that hour (`SharedState::set_muted`) and its layer is reported
//!   as `partial` with the detail `fighting` (typical cause: a domain Group Policy refresh that
//!   writes the old value back).
//!
//! Nothing here talks to the backend or sleeps: it works on what one pass found.

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use sha2::{Digest, Sha256};

use super::daily::{server_day, DailyCounters};
use super::{LayerStates, LayerStatus};
use crate::audit::AuditKind;
use crate::journal::JournalOwner;
use crate::state::{Rewrite, SharedState};

/// How often the reconcile loop looks again (the Phase 2 value, `kiosk::REASSERT_INTERVAL`).
pub const REASSERT_INTERVAL: Duration = Duration::from_secs(600);
/// More than this many rewrites of one target within [`WINDOW_MS`] is "fighting".
pub const FIGHTING_REWRITES: usize = 6;
const WINDOW_MS: u64 = 3_600_000;
/// The `detail` of a layer whose target something else keeps changing back.
pub const FIGHTING: &str = "fighting";

/// What one pass found.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct DriftOutcome {
    /// Rewrites in this pass (all of them, audited or not).
    pub rewrites: u64,
    /// Ids that became muted in this pass.
    pub newly_muted: Vec<String>,
}

#[derive(Default)]
pub struct DriftTracker {
    /// Rewrite times per target within the last hour.
    history: HashMap<String, Vec<u64>>,
    /// Muted targets and the time their mute ends.
    muted: HashMap<String, (JournalOwner, u64)>,
    /// `(target, server day)` pairs already audited.
    audited: HashSet<(String, String)>,
    last_pass_ms: Option<u64>,
    last_os_build: Option<String>,
}

/// The audit `detail`: the layer and a short hash of the target, never its name.
pub fn drift_detail(rewrite: &Rewrite) -> String {
    let digest = Sha256::digest(rewrite.id.as_bytes());
    let short: String = digest.iter().take(4).map(|byte| format!("{byte:02x}")).collect();
    format!("{}:{short}", owner_word(rewrite.owner))
}

fn owner_word(owner: JournalOwner) -> &'static str {
    match owner {
        JournalOwner::Kiosk => "kiosk",
        JournalOwner::L1 => "L1",
        JournalOwner::L2 => "L2",
        JournalOwner::L3 => "L3",
        JournalOwner::L4 => "L4",
        JournalOwner::L7 => "L7",
        JournalOwner::Wifi => "wifi",
        JournalOwner::Printer => "printer",
        JournalOwner::Perf => "perf",
        JournalOwner::Driver => "driver",
        JournalOwner::L1Browser => "L1-browser",
    }
}

impl DriftTracker {
    pub fn new() -> Self {
        Self::default()
    }

    /// Whether the reconcile loop should re-apply now: at start, on every interval, and when the
    /// OS build number changed (an update may have reset policy values). Remembers the answer.
    pub fn reassert_due(&mut self, now_ms: u64, os_build: Option<&str>) -> bool {
        let interval_passed = self
            .last_pass_ms
            .is_none_or(|last| now_ms.saturating_sub(last) >= REASSERT_INTERVAL.as_millis() as u64);
        let build_changed = os_build.is_some() && self.last_os_build.is_some() && self.last_os_build.as_deref() != os_build;
        if interval_passed || build_changed {
            self.last_pass_ms = Some(now_ms);
            if os_build.is_some() {
                self.last_os_build = os_build.map(str::to_string);
            }
            return true;
        }
        if self.last_os_build.is_none() {
            self.last_os_build = os_build.map(str::to_string);
        }
        false
    }

    /// A new document is about to be applied: its writes are changes, not drift. Whatever the
    /// journal noted is thrown away and no target stays muted.
    pub fn new_document(&mut self, shared: &SharedState) {
        shared.take_rewrites();
        self.muted.clear();
        self.history.clear();
        shared.set_muted(HashSet::new());
    }

    /// Reads the rewrites the journal noted during the pass that just ran, counts them, audits the
    /// first of each target per server day, mutes a target that is being fought over and updates
    /// the journal's muted set. `audit` gets the kind and the fixed-code detail.
    pub fn finish_pass(
        &mut self,
        shared: &SharedState,
        daily: &mut DailyCounters,
        now_ms: u64,
        server_offset_ms: Option<i64>,
        audit: &mut dyn FnMut(AuditKind, String),
    ) -> DriftOutcome {
        let rewrites = shared.take_rewrites();
        let day = server_day(now_ms, server_offset_ms);
        self.audited.retain(|(_, audited_day)| *audited_day == day);
        let mut outcome = DriftOutcome { rewrites: rewrites.len() as u64, newly_muted: Vec::new() };
        for rewrite in &rewrites {
            let times = self.history.entry(rewrite.id.clone()).or_default();
            times.retain(|time| now_ms.saturating_sub(*time) < WINDOW_MS);
            times.push(now_ms);
            if times.len() > FIGHTING_REWRITES && !self.muted.contains_key(&rewrite.id) {
                // Left alone until an hour after the first rewrite of this stretch.
                let until = times.first().copied().unwrap_or(now_ms).saturating_add(WINDOW_MS);
                self.muted.insert(rewrite.id.clone(), (rewrite.owner, until));
                outcome.newly_muted.push(rewrite.id.clone());
            }
            if self.audited.insert((rewrite.id.clone(), day.clone())) {
                audit(AuditKind::DeviceDriftReasserted, drift_detail(rewrite));
            }
        }
        daily.add_drift(&day, outcome.rewrites);
        self.expire(now_ms);
        shared.set_muted(self.muted.keys().cloned().collect());
        outcome
    }

    /// Ends the mute of a target whose hour is over.
    pub fn expire(&mut self, now_ms: u64) {
        self.muted.retain(|_, (_, until)| *until > now_ms);
    }

    /// The layers with a target that is being left alone right now.
    pub fn fighting_owners(&self, now_ms: u64) -> Vec<JournalOwner> {
        let mut owners: Vec<JournalOwner> =
            self.muted.values().filter(|(_, until)| *until > now_ms).map(|(owner, _)| *owner).collect();
        owners.dedup();
        owners
    }

    /// Marks the layers of `fighting_owners` as `partial` / `fighting` (a layer that already
    /// failed keeps its worse state).
    pub fn apply_to_layers(&self, layers: &mut LayerStates, now_ms: u64) {
        for owner in self.fighting_owners(now_ms) {
            let layer = match owner {
                JournalOwner::L1 | JournalOwner::L1Browser => &mut layers.staff,
                JournalOwner::L2 | JournalOwner::Kiosk | JournalOwner::Wifi | JournalOwner::Printer | JournalOwner::Driver => &mut layers.machine,
                JournalOwner::L3 => &mut layers.app_locker,
                JournalOwner::L4 => &mut layers.app_control,
                JournalOwner::L7 => &mut layers.boot,
                JournalOwner::Perf => &mut layers.performance,
            };
            if matches!(layer.state, LayerStatus::Ok | LayerStatus::AuditFirst) {
                layer.state = LayerStatus::Partial;
                layer.detail = Some(FIGHTING.to_string());
            }
        }
    }
}

#[cfg(test)]
mod tests;
