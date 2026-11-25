//! Last-known-good (LKG) and the automatic rollback (plan 4.11).
//!
//! `lkg.json` holds the last **signed** payload whose lockdown section was applied and then
//! followed by a healthy shell, plus the candidate that is still on probation and the
//! configurations this PC refuses to apply again.
//!
//! **Probation.** When a document with a lockdown section is applied it becomes the candidate.
//! The window starts when the Staff session is (or becomes) active:
//!
//! * the Staff App must send `ui_alive` within [`LKG_HEALTH_WINDOW_MS`] (180 s). On the shell pipe
//!   `ui_alive` is the `shell.ready` / `shell.heartbeat` signal: the Staff App sends the
//!   heartbeat only while its page called `ui_alive` in the last seconds, so a window that does
//!   not render sends none;
//! * the launcher watchdog must not record [`CRASH_LIMIT`] Staff App crashes within
//!   [`CRASH_WINDOW_MS`] (5 minutes) of the apply.
//!
//! A candidate that stayed healthy for [`CRASH_WATCH_MS`] after its window started becomes the new LKG. No Staff session
//! means no window: a PC with nobody signed in never rolls back (and never promotes either).
//!
//! **Rollback** ([`roll_back`]): the journal entries of L1 to L5 and L7 written after the LKG
//! version are restored, the LKG document is verified again and applied over what is left, the
//! failed configuration version is refused locally, and the caller reports `rolledBack` and
//! audits `device.lockdownRolledBack`. `kioskEnabled`, keys, employees and the device lock are
//! never touched: they are not lockdown.
//!
//! The monitor takes the clock as an argument everywhere and holds no timer; the owner asks
//! [`LkgMonitor::next_deadline`] for the only moment it has to look again (and only while a
//! candidate exists).

use std::path::PathBuf;
use std::sync::Mutex;

use rulebox_policy::envelope::{verify_envelope, SignedEnvelope, TrustedKey};
use rulebox_policy::lockdown::ConfigRef;
use rulebox_policy::AgentDoc;
use serde::{Deserialize, Serialize};
use tokio::sync::Notify;

use super::apply::{self, ApplyCtx};
use super::LayerStates;
use crate::backend::reports::{ApplyReport, ApplyState, PrinterItemState, WifiItemState};
use crate::journal::{self, JournalOwner};
use crate::state::{lock, read_json, write_atomic};

/// How long after an apply (or the next Staff sign-in) the Staff App has to prove it renders.
pub const LKG_HEALTH_WINDOW_MS: u64 = 180_000;
/// This many Staff App crashes ...
pub const CRASH_LIMIT: usize = 3;
/// ... within this long are a crash loop.
pub const CRASH_WINDOW_MS: u64 = 5 * 60_000;
/// Crash loops are watched, and a healthy candidate is promoted, this long after its window started.
pub const CRASH_WATCH_MS: u64 = 5 * 60_000;
/// Refused configurations kept (plan 4.11 step 3 and Step 16: bounded to 20 entries, the oldest goes first).
pub const MAX_REFUSED: usize = 20;

/// The layers a rollback undoes: L1 to L4 and L7 (L5, the process watch, writes no journal entry),
/// and (Step 18) the performance layer: a tuning value or a disabled service of the failed version
/// may be what broke the Staff App, so it goes back with the rest.
pub const ROLLBACK_OWNERS: [JournalOwner; 7] = [
    JournalOwner::L1,
    JournalOwner::L1Browser,
    JournalOwner::L2,
    JournalOwner::L3,
    JournalOwner::L4,
    JournalOwner::L7,
    JournalOwner::Perf,
];

/// Why a candidate was rolled back.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RollbackReason {
    /// [`CRASH_LIMIT`] Staff App crashes within [`CRASH_WINDOW_MS`].
    CrashLoop,
    /// No `ui_alive` within [`LKG_HEALTH_WINDOW_MS`] while a Staff session was active.
    NoUiAlive,
}

impl RollbackReason {
    /// The audit `detail`.
    pub fn code(self) -> &'static str {
        match self {
            RollbackReason::CrashLoop => "crash_loop",
            RollbackReason::NoUiAlive => "no_ui_alive",
        }
    }
}

/// What the monitor decided.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LkgEvent {
    /// The candidate stayed healthy and is now the LKG.
    Promoted { version: u64 },
    Rollback(RollbackReason),
}

/// A document the reconciler just applied.
#[derive(Clone, Debug)]
pub struct AppliedDoc {
    pub version: u64,
    pub config: Option<ConfigRef>,
    /// The document has a lockdown section (any layer may be on).
    pub has_lockdown: bool,
    /// The signed envelope exactly as received; the LKG re-verifies it before use.
    pub envelope: SignedEnvelope,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LkgRecord {
    pub version: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config: Option<ConfigRef>,
    pub envelope: SignedEnvelope,
    pub promoted_at_ms: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub version: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config: Option<ConfigRef>,
    pub envelope: SignedEnvelope,
    pub applied_at_ms: u64,
    /// When the 180 s window started; `None` while no Staff session is active.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window_start_ms: Option<u64>,
    /// The first `ui_alive` inside the window.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub healthy_at_ms: Option<u64>,
    /// Staff App crashes since the apply, within the last [`CRASH_WINDOW_MS`].
    #[serde(default)]
    pub crashes: Vec<u64>,
}

/// A configuration this PC will not apply again. A document without a group configuration is
/// refused by its document version (`group_id` absent).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RefusedConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_id: Option<String>,
    pub version: u64,
    pub at_ms: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
struct LkgFile {
    schema: u32,
    lkg: Option<LkgRecord>,
    candidate: Option<Candidate>,
    refused: Vec<RefusedConfig>,
}

struct Inner {
    file: LkgFile,
    staff_active: bool,
    /// The decision waiting for the owner.
    pending: Option<RollbackReason>,
    /// (Step 20) The agent itself is about to end the Staff App (an admin exit, Disable): until
    /// this time, or until the Staff session is gone, a Staff App that goes away is not a crash.
    expected_exit_until_ms: Option<u64>,
}

/// How long after the agent announced that it ends the Staff session a closed Staff App
/// connection is still "expected" (the exit's 2 s grace plus the sign-out retries, with room).
pub const EXPECTED_EXIT_MS: u64 = 60_000;

/// The LKG store and the probation logic. Shared (`Arc`) between the watchdog, which feeds it, and
/// the reconciler, which acts on its decisions.
pub struct LkgMonitor {
    path: PathBuf,
    inner: Mutex<Inner>,
    /// Woken when a rollback is decided; the owner calls [`LkgMonitor::take_pending`].
    pub wake: Notify,
}

impl LkgMonitor {
    pub fn open_in(paths: &crate::paths::DataPaths) -> std::io::Result<Self> {
        Self::open(paths.lkg())
    }

    pub fn open(path: PathBuf) -> std::io::Result<Self> {
        let mut file = read_json::<LkgFile>(&path)?.unwrap_or_default();
        file.schema = 1;
        Ok(Self {
            path,
            inner: Mutex::new(Inner { file, staff_active: false, pending: None, expected_exit_until_ms: None }),
            wake: Notify::new(),
        })
    }

    /// (Step 20) The agent is about to sign the Staff session out on purpose (a correct exit PIN,
    /// Disable). The Staff App closing in the next [`EXPECTED_EXIT_MS`] is not a crash and never
    /// counts toward a rollback.
    pub fn expect_shell_exit(&self, now_ms: u64) {
        lock(&self.inner).expected_exit_until_ms = Some(now_ms.saturating_add(EXPECTED_EXIT_MS));
    }

    /// The announced exit did not happen (the request was withdrawn, the sign-out failed).
    pub fn cancel_expected_exit(&self) {
        lock(&self.inner).expected_exit_until_ms = None;
    }

    /// (Step 20) The kiosk was disabled and every layer restored: nothing is on probation any
    /// more, and no rollback may fire for a document that is no longer applied. The LKG copy and
    /// the refused list stay.
    pub fn drop_candidate(&self) {
        let mut inner = lock(&self.inner);
        inner.pending = None;
        if inner.file.candidate.take().is_some() {
            self.save(&inner);
        }
    }

    fn save(&self, inner: &Inner) {
        let saved = serde_json::to_vec_pretty(&inner.file).map_err(std::io::Error::other).and_then(|bytes| write_atomic(&self.path, &bytes));
        if let Err(error) = saved {
            tracing::error!("cannot save lkg.json: {error}");
        }
    }

    // -- facts the reconciler asks --

    /// The version of the LKG copy (the apply report's `lkgVersion`).
    pub fn lkg_version(&self) -> Option<u64> {
        lock(&self.inner).file.lkg.as_ref().map(|lkg| lkg.version)
    }

    /// The version waiting on probation.
    pub fn candidate_version(&self) -> Option<u64> {
        lock(&self.inner).file.candidate.as_ref().map(|candidate| candidate.version)
    }

    /// True when this PC refuses to apply the lockdown part of a document with this version and
    /// configuration.
    pub fn is_refused(&self, version: u64, config: Option<&ConfigRef>) -> bool {
        refused_in(&lock(&self.inner).file.refused, version, config)
    }

    /// The refused entries (the dashboard shows the count; tests read them).
    pub fn refused(&self) -> Vec<RefusedConfig> {
        lock(&self.inner).file.refused.clone()
    }

    // -- the events --

    /// A document was applied. A document with a lockdown section starts probation; one without
    /// has nothing to roll back to (all layers off) and becomes the LKG at once. A candidate that
    /// was already healthy is promoted first, so quick successive versions still move the LKG.
    pub fn on_applied(&self, applied: AppliedDoc, now_ms: u64) {
        let mut inner = lock(&self.inner);
        promote_if_healthy(&mut inner.file, now_ms, true);
        let record = |applied: &AppliedDoc| LkgRecord {
            version: applied.version,
            config: applied.config.clone(),
            envelope: applied.envelope.clone(),
            promoted_at_ms: now_ms,
        };
        if applied.has_lockdown {
            let window_start_ms = inner.staff_active.then_some(now_ms);
            inner.file.candidate = Some(Candidate {
                version: applied.version,
                config: applied.config,
                envelope: applied.envelope,
                applied_at_ms: now_ms,
                window_start_ms,
                healthy_at_ms: None,
                crashes: Vec::new(),
            });
        } else {
            inner.file.lkg = Some(record(&applied));
            inner.file.candidate = None;
        }
        inner.pending = None;
        self.save(&inner);
    }

    /// The Staff session became active or ended. The window of a candidate that is not healthy yet
    /// starts at the sign-in; it is dropped when the session ends, so it restarts at the next one.
    pub fn on_staff_session(&self, active: bool, now_ms: u64) {
        let mut inner = lock(&self.inner);
        if inner.staff_active == active {
            return;
        }
        inner.staff_active = active;
        if !active {
            // The session the agent ended is gone: the next Staff App that disappears is news again.
            inner.expected_exit_until_ms = None;
        }
        let mut changed = false;
        if let Some(candidate) = inner.file.candidate.as_mut() {
            if candidate.healthy_at_ms.is_none() {
                let wanted = active.then_some(now_ms);
                if candidate.window_start_ms != wanted {
                    candidate.window_start_ms = wanted;
                    changed = true;
                }
            }
        }
        if changed {
            self.save(&inner);
            // (Step 20) The owner's timer follows the window (`next_deadline` moved).
            self.wake.notify_one();
        }
    }

    /// `ui_alive` (the Staff App's heartbeat). The first one inside the window makes the candidate
    /// healthy. Writes once per candidate, never per heartbeat.
    pub fn on_ui_alive(&self, now_ms: u64) -> Option<LkgEvent> {
        let mut inner = lock(&self.inner);
        let mut changed = false;
        if let Some(candidate) = inner.file.candidate.as_mut() {
            let in_window = candidate
                .window_start_ms
                .is_some_and(|start| now_ms >= start && now_ms - start <= LKG_HEALTH_WINDOW_MS);
            if candidate.healthy_at_ms.is_none() && in_window {
                candidate.healthy_at_ms = Some(now_ms);
                changed = true;
            }
        }
        if changed {
            self.save(&inner);
            self.wake.notify_one();
        }
        self.settle(&mut inner, now_ms)
    }

    /// A Staff App crash seen by the launcher watchdog while the Staff session was active.
    pub fn on_shell_crash(&self, now_ms: u64) -> Option<LkgEvent> {
        let mut inner = lock(&self.inner);
        // (Step 20) A deliberate admin exit or Disable ends the Staff App too: not a crash.
        if inner.expected_exit_until_ms.is_some_and(|until| now_ms <= until) {
            return None;
        }
        let mut decided = None;
        if let Some(candidate) = inner.file.candidate.as_mut() {
            candidate.crashes.push(now_ms);
            candidate.crashes.retain(|time| now_ms.saturating_sub(*time) <= CRASH_WINDOW_MS);
            // The watch runs from the start of the window: the apply, or the next sign-in when nobody
            // was signed in to Windows.
            let watching = candidate.window_start_ms.is_some_and(|start| now_ms.saturating_sub(start) <= CRASH_WATCH_MS);
            if watching && candidate.crashes.len() >= CRASH_LIMIT {
                decided = Some(RollbackReason::CrashLoop);
            }
        }
        if inner.file.candidate.is_some() {
            self.save(&inner);
        }
        if let Some(reason) = decided {
            return Some(self.decide(&mut inner, reason));
        }
        None
    }

    /// Looks at the clock: a candidate without `ui_alive` after the window, or a healthy one past
    /// its watch. Call it at [`LkgMonitor::next_deadline`] and after any event.
    pub fn tick(&self, now_ms: u64) -> Option<LkgEvent> {
        let mut inner = lock(&self.inner);
        self.settle(&mut inner, now_ms)
    }

    fn settle(&self, inner: &mut Inner, now_ms: u64) -> Option<LkgEvent> {
        let staff_active = inner.staff_active;
        let silent = inner.file.candidate.as_ref().is_some_and(|candidate| {
            candidate.healthy_at_ms.is_none()
                && staff_active
                && candidate.window_start_ms.is_some_and(|start| now_ms.saturating_sub(start) > LKG_HEALTH_WINDOW_MS)
        });
        if silent {
            return Some(self.decide(inner, RollbackReason::NoUiAlive));
        }
        let version = inner.file.candidate.as_ref().map(|candidate| candidate.version);
        if promote_if_healthy(&mut inner.file, now_ms, false) {
            self.save(inner);
            return version.map(|version| LkgEvent::Promoted { version });
        }
        None
    }

    fn decide(&self, inner: &mut Inner, reason: RollbackReason) -> LkgEvent {
        inner.pending = Some(reason);
        self.wake.notify_one();
        LkgEvent::Rollback(reason)
    }

    /// The rollback decided and not yet carried out.
    pub fn take_pending(&self) -> Option<RollbackReason> {
        lock(&self.inner).pending.take()
    }

    /// When [`LkgMonitor::tick`] has to run next, or `None` when no candidate is on probation (no
    /// timer at all). A window that has not started waits for the Staff session, not for the clock.
    pub fn next_deadline(&self) -> Option<u64> {
        let inner = lock(&self.inner);
        let candidate = inner.file.candidate.as_ref()?;
        match candidate.healthy_at_ms {
            Some(_) => candidate.window_start_ms.map(|start| start.saturating_add(CRASH_WATCH_MS)),
            None => candidate.window_start_ms.map(|start| start.saturating_add(LKG_HEALTH_WINDOW_MS + 1)),
        }
    }

    /// Takes the failed candidate off probation and refuses its configuration. Returns what
    /// [`roll_back`] needs. `None` when there is no candidate (a second call).
    fn fail_candidate(&self, now_ms: u64) -> Option<(Candidate, Option<LkgRecord>)> {
        let mut inner = lock(&self.inner);
        let candidate = inner.file.candidate.take()?;
        let refused = RefusedConfig {
            group_id: candidate.config.as_ref().map(|config| config.group_id.clone()),
            version: candidate.config.as_ref().map_or(candidate.version, |config| config.version),
            at_ms: now_ms,
        };
        if !inner.file.refused.iter().any(|r| r.group_id == refused.group_id && r.version == refused.version) {
            inner.file.refused.push(refused);
            while inner.file.refused.len() > MAX_REFUSED {
                inner.file.refused.remove(0);
            }
        }
        inner.pending = None;
        let lkg = inner.file.lkg.clone();
        self.save(&inner);
        Some((candidate, lkg))
    }

    /// The LKG document, verified again with the keys the device trusts now.
    pub fn lkg_doc(&self, trusted: &[TrustedKey], org_id: &str, device_id: &str) -> Option<AgentDoc> {
        let lkg = lock(&self.inner).file.lkg.clone()?;
        agent_doc_of(&lkg.envelope, trusted, org_id, device_id).ok()
    }

    /// `doc` with its ring-gated part (the lockdown section, Wi-Fi, printers) replaced by the LKG's
    /// when this PC refuses its configuration; everything else (locks, broadcasts, USB temporary
    /// allow, employees) is applied as the document says. Without an LKG the ring-gated part is
    /// empty: every layer off.
    pub fn without_refused(
        &self,
        doc: AgentDoc,
        doc_version: u64,
        trusted: &[TrustedKey],
        org_id: &str,
        device_id: &str,
    ) -> AgentDoc {
        if !self.is_refused(doc_version, doc.config.as_ref()) {
            return doc;
        }
        let safe = self.lkg_doc(trusted, org_id, device_id).unwrap_or_default();
        AgentDoc {
            lockdown: safe.lockdown,
            wifi: safe.wifi,
            wifi_managed_only: safe.wifi_managed_only,
            wifi_managed_only_confirmed: safe.wifi_managed_only_confirmed,
            printers: safe.printers,
            ..doc
        }
    }

    /// Deletes the file and forgets everything (unenroll).
    pub fn clear(&self) -> std::io::Result<()> {
        let mut inner = lock(&self.inner);
        inner.file = LkgFile { schema: 1, ..LkgFile::default() };
        inner.pending = None;
        inner.expected_exit_until_ms = None;
        crate::state::remove_file_if_exists(&self.path)
    }
}

fn refused_in(refused: &[RefusedConfig], version: u64, config: Option<&ConfigRef>) -> bool {
    match config {
        Some(config) => refused.iter().any(|r| r.group_id.as_deref() == Some(config.group_id.as_str()) && r.version == config.version),
        None => refused.iter().any(|r| r.group_id.is_none() && r.version == version),
    }
}

/// Promotes a healthy candidate whose watch is over (`force`: whatever the clock says).
fn promote_if_healthy(file: &mut LkgFile, now_ms: u64, force: bool) -> bool {
    let ready = file.candidate.as_ref().is_some_and(|candidate| {
        candidate.healthy_at_ms.is_some()
            && (force || candidate.window_start_ms.is_some_and(|start| now_ms.saturating_sub(start) >= CRASH_WATCH_MS))
    });
    if !ready {
        return false;
    }
    if let Some(candidate) = file.candidate.take() {
        file.lkg = Some(LkgRecord {
            version: candidate.version,
            config: candidate.config,
            envelope: candidate.envelope,
            promoted_at_ms: now_ms,
        });
    }
    true
}

fn agent_doc_of(envelope: &SignedEnvelope, trusted: &[TrustedKey], org_id: &str, device_id: &str) -> Result<AgentDoc, &'static str> {
    let payload = verify_envelope(envelope, trusted, org_id, device_id).map_err(|_| "lkg_unverifiable")?;
    AgentDoc::from_doc(&payload.doc).map_err(|_| "lkg_unreadable")
}

// ---------------------------------------------------------------- feeding the monitor

/// What the launcher watchdog tells the monitor. Implemented by [`LkgMonitor`]; the watchdog
/// holds it as a trait object so its tests need no monitor.
pub trait ShellHealthSink: Send + Sync {
    /// The Staff App's heartbeat arrived (`shell.ready`, `shell.heartbeat`).
    fn ui_alive(&self, now_ms: u64);
    /// A Staff App that had said `shell.ready` is gone while the Staff session is active, or was
    /// ended by the watchdog because its heartbeat stopped.
    fn shell_crashed(&self, now_ms: u64);
    /// The Staff account's session became active (`true`) or ended.
    fn staff_session(&self, active: bool, now_ms: u64);
}

impl ShellHealthSink for LkgMonitor {
    fn ui_alive(&self, now_ms: u64) {
        let _ = self.on_ui_alive(now_ms);
    }

    fn shell_crashed(&self, now_ms: u64) {
        let _ = self.on_shell_crash(now_ms);
    }

    fn staff_session(&self, active: bool, now_ms: u64) {
        self.on_staff_session(active, now_ms);
    }
}

// ---------------------------------------------------------------- the rollback

/// What a rollback needs from the reconciler.
pub struct RollbackInputs<'a> {
    pub apply: &'a ApplyCtx<'a>,
    pub trusted: &'a [TrustedKey],
    pub org_id: &'a str,
    pub device_id: &'a str,
}

/// What a rollback did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RollbackOutcome {
    pub reason: RollbackReason,
    pub failed_version: u64,
    pub failed_config: Option<ConfigRef>,
    /// Journal entries put back.
    pub restored: usize,
    /// Journal entries that could not be put back (kept, retried by the next restore).
    pub restore_failed: usize,
    pub lkg_version: Option<u64>,
    /// The layers after the LKG was applied, or the code of why it could not be.
    pub reapplied: Result<LayerStates, &'static str>,
}

impl RollbackOutcome {
    /// The audit `detail` of `device.lockdownRolledBack`.
    pub fn audit_detail(&self) -> &'static str {
        self.reason.code()
    }

    /// The apply report of a rollback: `rolledBack`, the failed configuration (so the ring logic
    /// counts it as a failure) and the version the PC is on now.
    pub fn report(&self, wifi: Vec<WifiItemState>, printers: Vec<PrinterItemState>, capabilities: Vec<String>) -> ApplyReport {
        let (layers, refusal) = match &self.reapplied {
            Ok(layers) => (layers.clone(), None),
            Err(code) => (LayerStates::all_off(), Some((*code).to_string())),
        };
        ApplyReport {
            applied_version: self.lkg_version.unwrap_or(0),
            config: self.failed_config.clone(),
            state: ApplyState::RolledBack,
            refusal,
            layers,
            wifi,
            printers,
            lkg_version: self.lkg_version,
            capabilities,
        }
    }
}

/// Carries out a decided rollback: restore, re-apply the LKG, refuse the failed configuration.
/// `None` when there is no candidate any more (the decision was already carried out).
pub fn roll_back(monitor: &LkgMonitor, inputs: &RollbackInputs<'_>, reason: RollbackReason) -> Option<RollbackOutcome> {
    let now_ms = inputs.apply.now_ms;
    let (failed, lkg) = monitor.fail_candidate(now_ms)?;
    let base = lkg.as_ref().map_or(0, |lkg| lkg.version);

    // 1. What the failed version wrote first goes back, last written first.
    let restore = journal::restore_owned_after(&inputs.apply.journal, &ROLLBACK_OWNERS, base);
    let restore_failed = restore.failed.len() + restore.other.len();
    let restored = restore.restored.len();

    // 2. The LKG document, verified again, over whatever is left.
    let reapplied = match &lkg {
        None => Ok(LayerStates::all_off()),
        Some(lkg) => agent_doc_of(&lkg.envelope, inputs.trusted, inputs.org_id, inputs.device_id).and_then(|doc| {
            let ctx = ApplyCtx {
                journal: inputs.apply.journal,
                facts: inputs.apply.facts.clone(),
                now_ms,
                version: lkg.version,
            };
            apply::apply(&ctx, &doc).map(|outcome| outcome.layers).map_err(|refusal| refusal.code())
        }),
    };
    tracing::warn!(
        failed_version = failed.version,
        lkg_version = ?lkg.as_ref().map(|lkg| lkg.version),
        reason = reason.code(),
        restored,
        restore_failed,
        "the lockdown of the last document was rolled back"
    );
    Some(RollbackOutcome {
        reason,
        failed_version: failed.version,
        failed_config: failed.config,
        restored,
        restore_failed,
        lkg_version: lkg.map(|lkg| lkg.version),
        reapplied,
    })
}

#[cfg(test)]
mod tests;
