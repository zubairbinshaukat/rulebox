//! The lockdown runtime (Phase 5 Step 20): what the kiosk reconciler calls to bring the seven
//! layers in line with the accepted document, and everything that hangs off one such pass.
//!
//! One [`LockdownRuntime::pass`] does, in order:
//!
//! 1. the device sealing key (created once, registered with the server once, plan 4.18);
//! 2. the verified cached document, with a configuration this PC refuses replaced by the
//!    last-known-good one (`lkg::LkgMonitor::without_refused`);
//! 3. `apply::apply` (L7, L2, L1, Wi-Fi, printers, L4, L3, performance) and the process watch
//!    (L5, `ProcWatchHost`), every write through the journal;
//! 4. drift and tamper counting (`DriftTracker`, `TamperTracker`), the findings collection and
//!    the daily counters;
//! 5. the apply report (`LockdownReporter::offer_apply`), the security posture and
//!    `restartPending` of the status report, and the last-known-good probation;
//! 6. the moment the reconciler has to look again: the end of a `usbTempAllow`, or the
//!    last-known-good monitor's deadline.
//!
//! It runs only while the kiosk is enabled (Disable restores the whole journal). Nothing here
//! sleeps or polls: the reconciler's own triggers (a new document, the 10-minute reassert, a
//! session or power event, a driver that landed) are the only callers. Synchronous: call it from
//! `spawn_blocking`.

use std::collections::BTreeSet;
use std::sync::{Arc, Mutex};

use rulebox_policy::lockdown::ConfigRef;
use rulebox_policy::paths::expand_exe;
use rulebox_policy::AgentDoc;
use serde::{Deserialize, Serialize};

use super::appcontrol::CiRestartMark;
use super::apply::{self, ApplyCtx, ApplyRefusal, ReportExtras};
use super::daily::{server_day, BlockLayer, CounterDelta};
use super::drift::DriftTracker;
use super::findings::FolderCtx;
use super::invariants::Facts;
use super::lkg::{self, AppliedDoc, LkgEvent, LkgMonitor, RollbackInputs, RollbackReason};
use super::procwatch::{BlockedHook, ProcWatchHost};
use super::reporting::LockdownReporter;
use super::tamper::{self, ClockWatch, RuleboxFolders, TamperTracker};
use super::{boot, usb, LayerState, LayerStates, LayerStatus, ReportedMode};
use crate::agent::load_verified_cache;
use crate::audit::{AuditHandle, AuditKind};
use crate::backend::reports::{ApplyReport, ApplyState, PrinterItemState, WifiItemState};
use crate::catalog::catalog_from_doc;
use crate::installs::engine::{rebooted_since, BootMark};
use crate::journal::{JournalCtx, JournalOwner};
use crate::network::{sealkey, wifi};
use crate::paths::{DataPaths, InstallPaths};
use crate::platform::Platform;
use crate::report::ReportQueue;
use crate::state::{lock, write_atomic, AgentState, SharedState, SnapshotHandle};

/// What this agent tells the server it can do (`deviceReports.capabilities`, the apply report).
pub const CAPABILITY_LOCKDOWN: &str = "lockdown/1";
/// The machine layer's `detail` when the "managed networks only" permit list could not be set
/// or put back (Step 13 left this without a report field). The layer is then `partial`.
pub const WIFI_FILTERS_ERROR: &str = "wifi_filters_error";
/// A Wi-Fi profile that is installed but whose last connection attempt failed (edge case 32):
/// `failed / connect_failed`.
pub const CONNECT_FAILED: &str = "connect_failed";
/// The id prefix of a service start-type entry in the journal.
const SERVICE_START_PREFIX: &str = "svc-start:";

/// What the runtime needs from the agent.
pub struct RuntimeDeps {
    pub platform: Arc<dyn Platform>,
    pub shared: Arc<SharedState>,
    pub paths: DataPaths,
    pub install: InstallPaths,
    /// `agent-config.json` `adminSigninVerified` (invariant I7, checklist row E-71).
    pub admin_signin_verified: bool,
    pub reporter: Arc<LockdownReporter>,
    pub lkg: Arc<LkgMonitor>,
    pub audit: Arc<AuditHandle>,
    pub report: Arc<ReportQueue>,
    pub snapshot: SnapshotHandle,
    pub now_ms: Arc<dyn Fn() -> u64 + Send + Sync>,
    /// `program.blocked` for the Staff App (once per program per session).
    pub on_blocked: Option<BlockedHook>,
}

/// What one pass came to.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PassResult {
    /// The state of the apply report that was offered; `None`: nothing was applied (not
    /// enrolled, no verified document).
    pub state: Option<ApplyState>,
    /// The refusal code when the document was refused.
    pub refusal: Option<String>,
    /// When the reconciler must run the next pass by itself (Unix ms): the end of a temporary USB
    /// allow or the last-known-good deadline. `None`: only its usual triggers.
    pub wake_at_ms: Option<u64>,
}

/// `lockdown-last.json`: the last pass, for `rulebox-agent lockdown-status`. Fixed codes and
/// numbers only, like the apply report it mirrors.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LastPass {
    pub version: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config: Option<ConfigRef>,
    pub state: ApplyState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refusal: Option<String>,
    pub layers: LayerStates,
    #[serde(default)]
    pub wifi: Vec<WifiItemState>,
    #[serde(default)]
    pub printers: Vec<PrinterItemState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lkg_version: Option<u64>,
}

impl LastPass {
    fn of(report: &ApplyReport, version: u64) -> Self {
        Self {
            version,
            config: report.config.clone(),
            state: report.state,
            refusal: report.refusal.clone(),
            layers: report.layers.clone(),
            wifi: report.wifi.clone(),
            printers: report.printers.clone(),
            lkg_version: report.lkg_version,
        }
    }

    /// Reads the file; `None` when there is none or it does not parse (it is never moved aside:
    /// the reader is a read-only command).
    pub fn read(paths: &DataPaths) -> Option<Self> {
        let bytes = std::fs::read(paths.lockdown_last()).ok()?;
        serde_json::from_slice(&bytes).ok()
    }
}

struct Inner {
    drift: DriftTracker,
    tamper: TamperTracker,
    /// The document version the layers were last applied from, in this run of the agent.
    last_version: Option<u64>,
    last_layers: LayerStates,
    /// The refusal that was audited last (one record per version and code).
    last_refusal: Option<(u64, String)>,
    terminated: CounterDelta,
    last_pass: Option<LastPass>,
    /// The agent is stopping ([`LockdownRuntime::stop`]): a pass that was already handed to a
    /// blocking thread does nothing any more, so nothing is written after the reconciler ended.
    stopped: bool,
}

pub struct LockdownRuntime {
    d: RuntimeDeps,
    procwatch: ProcWatchHost,
    inner: Mutex<Inner>,
    /// Its own lock: the backend task looks at the clock while a pass may be running.
    clock: Mutex<ClockWatch>,
}

fn boot_mark(platform: &dyn Platform) -> Option<BootMark> {
    platform.boot_identity().ok().map(|boot| BootMark { boot_id: boot.boot_id, uptime_ms: boot.uptime_ms })
}

/// The journal ids of the service start types the performance layer changed.
fn service_start_ids(state: &AgentState) -> BTreeSet<String> {
    state
        .journal
        .iter()
        .filter(|entry| entry.owner == JournalOwner::Perf && entry.id.starts_with(SERVICE_START_PREFIX))
        .map(|entry| entry.id.clone())
        .collect()
}

fn layers_of(layers: &LayerStates) -> [&LayerState; 7] {
    [
        &layers.staff,
        &layers.machine,
        &layers.app_locker,
        &layers.app_control,
        &layers.proc_watch,
        &layers.boot,
        &layers.performance,
    ]
}

impl LockdownRuntime {
    pub fn new(deps: RuntimeDeps) -> Arc<Self> {
        let procwatch = ProcWatchHost::new(Arc::clone(&deps.platform), deps.on_blocked.clone());
        deps.report.set_capabilities(vec![CAPABILITY_LOCKDOWN.to_string()]);
        let last_pass = LastPass::read(&deps.paths);
        Arc::new(Self {
            d: deps,
            procwatch,
            inner: Mutex::new(Inner {
                drift: DriftTracker::new(),
                tamper: TamperTracker::new(),
                last_version: None,
                last_layers: last_pass.as_ref().map_or_else(LayerStates::all_off, |last| last.layers.clone()),
                last_refusal: None,
                terminated: CounterDelta::default(),
                last_pass,
                stopped: false,
            }),
            clock: Mutex::new(ClockWatch::new()),
        })
    }

    /// The runtime's clock (Unix ms): the reconciler turns its deadlines into timers with it.
    pub fn now_ms(&self) -> u64 {
        (self.d.now_ms)()
    }

    pub fn lkg(&self) -> &Arc<LkgMonitor> {
        &self.d.lkg
    }

    pub fn reporter(&self) -> &Arc<LockdownReporter> {
        &self.d.reporter
    }

    /// The running process watch, for the tests.
    #[cfg(test)]
    pub fn procwatch(&self) -> &ProcWatchHost {
        &self.procwatch
    }

    fn journal(&self) -> JournalCtx<'_> {
        JournalCtx { platform: self.d.platform.as_ref(), shared: self.d.shared.as_ref() }
    }

    fn facts(&self, doc: &serde_json::Value) -> Facts {
        machine_facts(self.d.platform.as_ref(), &self.d.install, &self.d.paths, self.d.admin_signin_verified, doc)
    }
}

/// The machine facts of plan 4.6 for `doc` (the verified document as JSON). Read-only. The
/// protected folders are left to the layers' own default (the install folder and the WebView2
/// runtime folder from the path roots).
pub fn machine_facts(
    platform: &dyn Platform,
    install: &InstallPaths,
    paths: &DataPaths,
    admin_signin_verified: bool,
    doc: &serde_json::Value,
) -> Facts {
    let mut catalogue_exe_folders: Vec<String> = Vec::new();
    let (catalog, _) = catalog_from_doc(doc);
    if let Ok(roots) = platform.path_roots() {
        for app in &catalog {
            let Some(desktop) = app.desktop.as_ref() else {
                continue;
            };
            // A template that breaks the path rules is never started, so it needs no folder. A program in a versioned
            // folder (`...\App\app-*\app.exe`, plan 4.4.3) is covered by the folder **above** the `*`: the path rule is on
            // it, and `allowlist::build` refuses it unless it is admin-only.
            if let Ok(exe) = expand_exe(&desktop.exe, &app.id, app.is_portable(), &roots) {
                if let Some(folder) = crate::installs::version::program_folder(&exe) {
                    if !catalogue_exe_folders.iter().any(|known| known.eq_ignore_ascii_case(&folder)) {
                        catalogue_exe_folders.push(folder);
                    }
                }
            }
        }
    }
    Facts {
        admin_signin_verified,
        // Unknown (the WLAN service cannot be asked) counts as "wired or unknown": no refusal.
        current_ssid: platform.wlan_current_ssid().unwrap_or(None),
        protected_paths: Vec::new(),
        catalogue_exe_folders,
        // (Phase 6 Step 11) The publisher rules of the vendor-mode apps of the catalogue.
        vendor_exceptions: super::allowlist::vendor_exceptions(&catalog),
        rulebox_folders: Some(RuleboxFolders { install_root: install.root().to_path_buf(), state_dir: paths.state_dir() }),
        ..Facts::default()
    }
}

impl LockdownRuntime {
    /// What the findings parsers need to know about this PC.
    fn folder_ctx(&self, ctx: &ApplyCtx<'_>) -> Option<FolderCtx> {
        let roots = self.d.platform.path_roots().ok()?;
        let windows = roots.system_root.clone().unwrap_or_default();
        Some(FolderCtx {
            os_drive: windows.chars().take(2).collect(),
            protected: super::applocker::protected_folders(ctx, &roots),
            windows,
            system_volume: None,
            removable_volumes: Vec::new(),
        })
    }

    /// Step 1: the sealing key. Created on the first pass, offered to the reporter until the
    /// server has it, and recorded once the reporter says it was taken.
    fn sync_seal_key(&self, revoked: bool) {
        let shared = self.d.shared.as_ref();
        if let Some(key_id) = self.d.reporter.with_outbox(|outbox| outbox.take_seal_registered()) {
            if let Err(error) = shared.update(|state| state.seal_key_registered = Some(key_id)) {
                tracing::error!("cannot save the sealing key registration: {error}");
            }
        }
        if revoked {
            return;
        }
        match sealkey::ensure(shared) {
            Ok(key) => {
                let registered = shared.read(|state| state.seal_key_registered.clone());
                let pending = (registered.as_deref() != Some(key.key_id.as_str())).then_some(key);
                self.d.reporter.with_outbox(|outbox| outbox.offer_seal_key(pending));
            }
            // Never replaced silently (`sealkey::ensure`): Wi-Fi profiles stay `waiting_for_key`.
            Err(error) => tracing::warn!("the device sealing key is not usable: {error}"),
        }
    }

    /// True while a service start type the performance layer changed waits for a restart; the
    /// mark goes once Windows has started again.
    fn perf_restart_pending(&self) -> bool {
        let Some(mark) = self.d.shared.read(|state| state.perf_restart) else {
            return false;
        };
        match self.d.platform.boot_identity() {
            Ok(now) if rebooted_since(mark.boot.as_ref(), mark.since_ms, &now) => {
                let _ = self.d.shared.update(|state| state.perf_restart = None);
                false
            }
            _ => true,
        }
    }

    fn offer(&self, inner: &mut Inner, report: ApplyReport, version: u64) {
        let last = LastPass::of(&report, version);
        if inner.last_pass.as_ref() != Some(&last) {
            let saved = serde_json::to_vec_pretty(&last)
                .map_err(std::io::Error::other)
                .and_then(|bytes| write_atomic(&self.d.paths.lockdown_last(), &bytes));
            if let Err(error) = saved {
                tracing::warn!("cannot save lockdown-last.json: {error}");
            }
            inner.last_pass = Some(last);
        }
        let waiting = layers_of(&report.layers).iter().any(|layer| layer.state == LayerStatus::RestartPending);
        self.d.report.set_lockdown_restart_pending(waiting);
        inner.last_layers = report.layers.clone();
        self.d.reporter.offer_apply(report);
        // The status carries the applied version and the posture: build it again.
        self.d.report.status_changed();
    }

    /// One reconcile pass of the lockdown layers. See the module text.
    pub fn pass(&self) -> PassResult {
        let d = &self.d;
        // One pass at a time, and none after `stop` (the lock is held for the whole pass).
        let mut inner = lock(&self.inner);
        if inner.stopped {
            return PassResult::default();
        }
        let now = (d.now_ms)();
        let state = d.shared.get();
        let Some(enrollment) = state.enrollment.clone() else {
            return PassResult::default();
        };
        self.sync_seal_key(enrollment.revoked);
        let lkg_wake = |runtime: &Self| runtime.d.lkg.next_deadline();
        let Some((envelope, payload)) = load_verified_cache(&d.paths, &state) else {
            // No verified document: the enrollment default has no lockdown section.
            return PassResult { wake_at_ms: lkg_wake(self), ..PassResult::default() };
        };
        let version = payload.version;
        let offset = d.snapshot.current().server_time_offset_ms;
        let extras = |runtime: &Self| ReportExtras {
            lkg_version: runtime.d.lkg.lkg_version(),
            capabilities: vec![CAPABILITY_LOCKDOWN.to_string()],
            ..ReportExtras::default()
        };

        let parsed = AgentDoc::from_doc(&payload.doc);
        let config = parsed.as_ref().ok().and_then(|doc| doc.config.clone());
        let facts = self.facts(&payload.doc);
        let ctx = ApplyCtx { journal: self.journal(), facts, now_ms: now, version };
        let refused_config = d.lkg.is_refused(version, config.as_ref());
        let applied = match parsed {
            // A Phase 5 key of the wrong type: the whole document's lockdown part is refused.
            Err(_) => Err(ApplyRefusal::Refused("policy_rejected")),
            Ok(doc) => {
                let has_lockdown = doc.lockdown.is_some();
                let doc = d.lkg.without_refused(doc, version, &state.trusted_keys, &enrollment.org_id, &enrollment.device_id);
                let known = inner.last_version == Some(version)
                    || d.lkg.candidate_version() == Some(version)
                    || d.lkg.lkg_version() == Some(version);
                if !known {
                    // A new document's writes are changes, not drift.
                    inner.drift.new_document(&d.shared);
                }
                let services_before = service_start_ids(&state);
                apply::apply(&ctx, &doc).map(|mut outcome| {
                    outcome.layers.proc_watch = self.procwatch.apply(&ctx, &doc);
                    if service_start_ids(&d.shared.get()) != services_before {
                        let mark = CiRestartMark { since_ms: now, boot: boot_mark(d.platform.as_ref()) };
                        if let Err(error) = d.shared.update(|state| state.perf_restart = Some(mark)) {
                            tracing::error!("cannot save the restart mark: {error}");
                        }
                    }
                    (outcome, doc, has_lockdown, !known)
                })
            }
        };

        match applied {
            Ok((mut outcome, doc, has_lockdown, is_new)) => {
                // 4. Drift, tampering, findings and the daily counters.
                let mut audits: Vec<(AuditKind, String)> = Vec::new();
                let folder_ctx = has_lockdown.then(|| self.folder_ctx(&ctx)).flatten();
                let records = self.procwatch.with_watch(|watch| watch.engine().take_findings()).unwrap_or_default();
                let terminated = self.procwatch.with_watch(|watch| watch.engine().counters.view().terminated);
                let staff_sid = state.staff.as_ref().map(|staff| staff.sid.clone());
                {
                    let Inner { drift, tamper, terminated: counter, .. } = &mut *inner;
                    d.reporter.with_outbox(|outbox| {
                        let mut audit = |kind: AuditKind, detail: String| audits.push((kind, detail));
                        drift.finish_pass(&d.shared, &mut outbox.daily, now, offset, &mut audit);
                        tamper.finish_pass(&d.shared, &mut outbox.daily, now, offset, &mut audit);
                        let day = server_day(now, offset);
                        if let Some(folders) = &folder_ctx {
                            let stats = outbox.collector.collect(d.platform.as_ref(), staff_sid.as_deref(), folders, now);
                            outbox.daily.add_blocked(&day, BlockLayer::AppLocker, stats.blocked_app_locker);
                            outbox.daily.add_blocked(&day, BlockLayer::AppControl, stats.blocked_app_control);
                        }
                        if !records.is_empty() {
                            outbox.collector.take_procwatch(records, now);
                        }
                        if let Some(total) = terminated {
                            outbox.daily.add_blocked(&day, BlockLayer::ProcWatch, counter.delta(total));
                        }
                        if let Err(error) = outbox.daily.save_if_dirty() {
                            tracing::error!("cannot save security-daily.json: {error}");
                        }
                    });
                    drift.apply_to_layers(&mut outcome.layers, now);
                }
                for (kind, detail) in audits {
                    d.audit.record(kind, None, Some(detail));
                }

                // Wi-Fi: the permit list's failure as a layer code, and failed connections.
                if let Some(code) = outcome.wifi_filters_error {
                    tracing::warn!(code, "the managed-networks permit list is not as the document wants");
                    let machine = &mut outcome.layers.machine;
                    if matches!(machine.state, LayerStatus::Ok | LayerStatus::AuditFirst) {
                        machine.state = LayerStatus::Partial;
                        machine.detail = Some(WIFI_FILTERS_ERROR.to_string());
                    }
                }
                if outcome.wifi.iter().any(|item| item.state == wifi::APPLIED) {
                    if let Ok(failed) = d.platform.wlan_last_connect_failures() {
                        for item in outcome.wifi.iter_mut().filter(|item| item.state == wifi::APPLIED) {
                            let name = wifi::profile_name(&item.profile_id);
                            if name.is_some_and(|name| failed.iter().any(|f| f.eq_ignore_ascii_case(&name))) {
                                item.state = wifi::FAILED.to_string();
                                item.detail = Some(CONNECT_FAILED.to_string());
                            }
                        }
                    }
                }
                // A service start type takes effect at the next Windows start (Step 18).
                if self.perf_restart_pending() && outcome.layers.performance.state == LayerStatus::Ok {
                    outcome.layers.performance.state = LayerStatus::RestartPending;
                }

                // 5. Probation, the report, the posture.
                if is_new && !refused_config {
                    d.lkg.on_applied(AppliedDoc { version, config: config.clone(), has_lockdown, envelope }, now);
                }
                let mut report = outcome.report(version, config, extras(self));
                if refused_config {
                    // The PC stays on its last-known-good lockdown: the ring logic keeps counting
                    // the refused configuration as a failure.
                    report.state = ApplyState::RolledBack;
                    report.applied_version = d.lkg.lkg_version().unwrap_or(0);
                }
                let result_state = report.state;
                if let Ok(mut security) = boot::read_report(d.platform.as_ref()) {
                    inner.tamper.fill_report(&ctx.journal, &mut security);
                    let mut posture = serde_json::to_value(&security).ok();
                    // (Step 6) The Rulebox App Control policy ids that are on the PC; other
                    // products' policies are never listed.
                    if let (Some(posture), Ok(app_control)) = (posture.as_mut(), super::appcontrol::report(d.platform.as_ref())) {
                        if !app_control.ci_policies.is_empty() {
                            posture["ciPolicies"] = serde_json::json!(app_control.ci_policies);
                        }
                    }
                    d.report.set_security(posture);
                }
                inner.last_version = Some(version);
                inner.last_refusal = None;
                self.offer(&mut inner, report, version);
                let wake_at_ms = [usb::temp_allow_deadline(&doc, now), d.lkg.next_deadline()].into_iter().flatten().min();
                PassResult { state: Some(result_state), refusal: None, wake_at_ms }
            }
            Err(refusal) => {
                // Nothing was written; the layers, the watch and the probation stay as they were.
                let (kind, code) = refusal.audit();
                if inner.last_refusal.as_ref() != Some(&(version, code.to_string())) {
                    tracing::error!(version, code, "the lockdown part of the document was refused; nothing was applied");
                    d.audit.record(kind, None, Some(code.to_string()));
                    inner.last_refusal = Some((version, code.to_string()));
                }
                let in_force = inner.last_version.or(d.lkg.candidate_version()).or(d.lkg.lkg_version()).unwrap_or(0);
                let layers = inner.last_layers.clone();
                let report = refusal.report(in_force, config, layers, extras(self));
                self.offer(&mut inner, report, version);
                PassResult { state: Some(ApplyState::Refused), refusal: Some(code.to_string()), wake_at_ms: lkg_wake(self) }
            }
        }
    }

    /// The last-known-good monitor's clock: promotes a healthy candidate or decides a rollback.
    /// Returns what the reconciler has to do about it.
    pub fn tick(&self) -> Option<LkgEvent> {
        self.d.lkg.tick((self.d.now_ms)())
    }

    /// Carries out a rollback the monitor decided (plan 4.11): what the failed version wrote goes
    /// back, the last-known-good document is applied over the rest, the configuration is refused
    /// on this PC and `device.lockdownRolledBack` is audited. The caller runs [`pass`](Self::pass)
    /// next: it applies the last-known-good lockdown again (a no-op now), brings the process watch
    /// in line and sends the `rolledBack` report. `false`: there was nothing to roll back.
    pub fn roll_back(&self, reason: RollbackReason) -> bool {
        let d = &self.d;
        let mut inner = lock(&self.inner);
        if inner.stopped {
            return false;
        }
        let state = d.shared.get();
        let Some(enrollment) = state.enrollment.clone() else {
            return false;
        };
        let (payload_doc, version) = match load_verified_cache(&d.paths, &state) {
            Some((_, payload)) => (payload.doc, payload.version),
            None => (serde_json::Value::Null, state.last_applied_version),
        };
        let ctx = ApplyCtx { journal: self.journal(), facts: self.facts(&payload_doc), now_ms: (d.now_ms)(), version };
        let inputs = RollbackInputs {
            apply: &ctx,
            trusted: &state.trusted_keys,
            org_id: &enrollment.org_id,
            device_id: &enrollment.device_id,
        };
        let Some(outcome) = lkg::roll_back(&d.lkg, &inputs, reason) else {
            return false;
        };
        d.audit.record(AuditKind::DeviceLockdownRolledBack, None, Some(outcome.audit_detail().to_string()));
        // The rollback's writes are not drift, and the next pass treats the document as new.
        inner.drift.new_document(&d.shared);
        inner.last_version = None;
        true
    }

    /// The kiosk was disabled and the whole journal restored (the document says so, or
    /// `unenroll`): the process watch stops and nothing stays on probation. `unenroll` also
    /// forgets everything that belongs to the organization the PC leaves: the waiting reports,
    /// the findings, the daily counters (the permission denials among them) and the
    /// last-known-good copy. Otherwise one report says "every layer off".
    pub fn on_disabled(&self, unenroll: bool) {
        let d = &self.d;
        let mut inner = lock(&self.inner);
        if inner.stopped {
            return;
        }
        self.procwatch.stop();
        d.lkg.drop_candidate();
        inner.drift = DriftTracker::new();
        inner.drift.new_document(&d.shared);
        d.shared.take_tampered();
        inner.last_version = None;
        inner.last_refusal = None;
        if unenroll {
            if let Err(error) = d.reporter.with_outbox(|outbox| outbox.clear()) {
                tracing::error!("cannot delete the lockdown reports: {error}");
            }
            if let Err(error) = d.lkg.clear() {
                tracing::error!("cannot delete lkg.json: {error}");
            }
            if let Err(error) = crate::state::remove_file_if_exists(&d.paths.lockdown_last()) {
                tracing::error!("cannot delete lockdown-last.json: {error}");
            }
            inner.last_pass = None;
            inner.last_layers = LayerStates::all_off();
            inner.tamper = TamperTracker::new();
            d.report.set_security(None);
            d.report.set_lockdown_restart_pending(false);
            return;
        }
        let state = d.shared.get();
        let Some((_, payload)) = load_verified_cache(&d.paths, &state) else {
            return;
        };
        let config = AgentDoc::from_doc(&payload.doc).ok().and_then(|doc| doc.config);
        let report = ApplyReport {
            applied_version: payload.version,
            config,
            state: ApplyState::Applied,
            refusal: None,
            layers: LayerStates::all_off(),
            wifi: Vec::new(),
            printers: Vec::new(),
            lkg_version: d.lkg.lkg_version(),
            capabilities: vec![CAPABILITY_LOCKDOWN.to_string()],
        };
        self.offer(&mut inner, report, payload.version);
    }

    /// The agent is about to end the Staff session on purpose (admin exit, Disable): the Staff
    /// App going away is not a crash for the last-known-good probation.
    pub fn expect_shell_exit(&self) {
        self.d.lkg.expect_shell_exit((self.d.now_ms)());
    }

    pub fn cancel_expected_exit(&self) {
        self.d.lkg.cancel_expected_exit();
    }

    /// (plan 4.16) A Staff session that appeared in a Safe Mode boot was signed out.
    pub fn audit_safe_mode_blocked(&self) {
        self.d.audit.record(AuditKind::DeviceSafeModeBlocked, None, None);
    }

    /// A Staff session started or ended: `program.blocked` may be announced again.
    pub fn session_changed(&self) {
        self.procwatch.with_watch(|watch| watch.new_session());
    }

    /// The service stops: a pass that is still running is waited for (it holds the lock), no
    /// later one does anything, and the process trace ends. Nothing is restored.
    pub fn stop(&self) {
        lock(&self.inner).stopped = true;
        self.procwatch.stop();
    }

    /// (Step 17) One clock check, beside `backend::task::note_clock`: a jump of more than ten
    /// minutes against the time since boot is audited once (`device.clockJump`).
    pub fn note_clock(&self) {
        let Ok(boot) = self.d.platform.boot_identity() else {
            return;
        };
        let mut watch = lock(&self.clock);
        let audit = &self.d.audit;
        let mut record = |kind: AuditKind, detail: String| audit.record(kind, None, Some(detail));
        tamper::note_clock(&mut watch, &self.d.shared, (self.d.now_ms)(), &boot, &mut record);
    }

    /// A ping went out: a finished server day of counters may ride along.
    pub fn heartbeat(&self) {
        self.d.reporter.heartbeat();
    }
}

/// The mode a layer is expected to report for `doc` (what `lockdown-status` compares with).
pub fn expected_modes(doc: &AgentDoc) -> [(&'static str, ReportedMode); 7] {
    use rulebox_policy::lockdown::LayerMode;
    let on = |present: bool| if present { ReportedMode::On } else { ReportedMode::Off };
    let of = |mode: LayerMode| match mode {
        LayerMode::Audit => ReportedMode::Audit,
        LayerMode::Enforce => ReportedMode::Enforce,
        LayerMode::Off | LayerMode::Unknown => ReportedMode::Off,
    };
    let lockdown = doc.lockdown.as_ref();
    [
        ("staff", on(lockdown.is_some())),
        ("machine", on(lockdown.is_some())),
        ("appLocker", lockdown.map_or(ReportedMode::Off, |l| of(l.app_locker.mode))),
        ("appControl", lockdown.map_or(ReportedMode::Off, |l| of(l.app_control.mode))),
        ("procWatch", lockdown.map_or(ReportedMode::Off, |l| of(l.proc_watch.mode))),
        ("boot", on(lockdown.is_some())),
        ("performance", on(lockdown.is_some())),
    ]
}

/// Reads a small JSON file without moving a broken one aside (`lockdown-status`).
pub fn read_json_quiet<T: serde::de::DeserializeOwned>(path: &std::path::Path) -> Option<T> {
    let bytes = std::fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

#[cfg(test)]
pub(in crate::lockdown) mod tests;
