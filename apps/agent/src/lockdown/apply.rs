//! The apply transaction (plan 4.11, "Apply order"), as a skeleton.
//!
//! For a new verified document:
//!
//! 1. Parse and check the limits of 4.3 rule 4: `policy_rejected` on failure.
//! 2. `invariants::validate` (4.6, Step 4): `refused` with a code; nothing is written.
//! 3. Apply the layers in [`APPLY_ORDER`], each through `journal::change`.
//! 4. Each layer returns a [`LayerState`].
//! 5. The caller records the result and sends one apply report (Step 20).
//!
//! Before step 1 the journal is checked: an entry this build cannot restore stops the
//! apply (`journal_unknown_target`, invariant I8) and nothing is written.

use rulebox_policy::lockdown::{ConfigRef, LimitError};
use rulebox_policy::AgentDoc;

use super::invariants::{self, Facts};
use super::{appcontrol, applocker, boot, machine, staff, usb, LayerState, LayerStates, LayerStatus};
use crate::audit::AuditKind;
use crate::backend::reports::{ApplyReport, ApplyState, PrinterItemState, WifiItemState, MAX_ITEM_STATES};
use crate::journal::{self, JournalCtx};

/// The layers in the order they are applied. The way back and tamper protection come
/// first; the program-start layers last, so a failure in an earlier step leaves the
/// PC less locked, never more (plan 4.11).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Layer {
    /// L7: Safe Mode registration, service hardening.
    Boot,
    /// L2: machine policies.
    Machine,
    /// L1: Staff policies.
    Staff,
    Wifi,
    Printers,
    /// L4: App Control.
    AppControl,
    /// L3: AppLocker.
    AppLocker,
    /// L5: the process watchdog's mode.
    ProcWatch,
    Performance,
}

pub const APPLY_ORDER: [Layer; 9] = [
    Layer::Boot,
    Layer::Machine,
    Layer::Staff,
    Layer::Wifi,
    Layer::Printers,
    Layer::AppControl,
    Layer::AppLocker,
    Layer::ProcWatch,
    Layer::Performance,
];

/// Why a document was not applied. Nothing was written in any of these cases.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApplyRefusal {
    /// A limit of 4.3 rule 4 was exceeded.
    PolicyRejected(LimitError),
    /// The invariants of 4.6 refused the document; the code names the invariant.
    Refused(&'static str),
    /// The journal holds a target this build cannot restore.
    JournalUnknownTarget,
}

impl ApplyRefusal {
    /// The fixed code for the apply report and the audit log.
    pub fn code(&self) -> &'static str {
        match self {
            ApplyRefusal::PolicyRejected(_) => "policy_rejected",
            ApplyRefusal::Refused(code) => code,
            ApplyRefusal::JournalUnknownTarget => journal::JOURNAL_UNKNOWN_TARGET,
        }
    }
}

/// What an apply needs.
pub struct ApplyCtx<'a> {
    pub journal: JournalCtx<'a>,
    /// The machine facts the invariants check against (plan 4.6).
    pub facts: Facts,
    pub now_ms: u64,
    /// The document version being applied (stored as `since_version` on new entries).
    pub version: u64,
}

/// What an apply did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApplyOutcome {
    pub layers: LayerStates,
    /// The layers that ran, in the order they ran.
    pub ran: Vec<Layer>,
    /// (Step 13) One state per Wi-Fi profile of the document (`applied | waiting_for_key | failed |
    /// unsupported`), for the apply report.
    pub wifi: Vec<WifiItemState>,
    /// (Step 13) A fixed code when the "managed networks only" permit list could not be set or
    /// restored; the apply report has no field for it yet (open question, Step 20).
    pub wifi_filters_error: Option<&'static str>,
    /// (Step 14) One state per printer of the document (`applied | failed`), for the apply report.
    pub printers: Vec<PrinterItemState>,
}

/// Step 2 of the transaction: the invariants of 4.6. A refusal writes nothing. The layers
/// that already exist add what they will write to the facts first (4.6: the checks look
/// at generated output).
fn validate_invariants(ctx: &ApplyCtx<'_>, doc: &AgentDoc) -> Result<(), ApplyRefusal> {
    let mut facts = ctx.facts.clone();
    machine::fill_generated(doc, &mut facts.generated, ctx.now_ms);
    applocker::fill_generated(ctx, doc, &mut facts.generated);
    invariants::validate(doc, &facts).map_err(|refusal| ApplyRefusal::Refused(refusal.code()))
}

/// One layer. L1 (Step 4), L2 and the boot part of L7 (Step 5), L4 (Step 6) and L3 (Step 7) are
/// real; the others are still no-ops.
fn run_layer(ctx: &ApplyCtx<'_>, doc: &AgentDoc, layer: Layer) -> LayerState {
    match layer {
        Layer::Staff => staff::apply(ctx, doc),
        Layer::Machine => machine::apply(ctx, doc),
        Layer::Boot => boot::apply(ctx, doc),
        Layer::AppControl => appcontrol::apply(ctx, doc),
        Layer::AppLocker => applocker::apply(ctx, doc),
        _ => LayerState::off_ok(),
    }
}

/// (Step 13) The Wi-Fi layer reports through the apply report's `wifi` items, not a layer state.
fn run_wifi(ctx: &ApplyCtx<'_>, doc: &AgentDoc) -> crate::network::wifi::WifiOutcome {
    crate::network::wifi::apply(ctx, doc)
}

/// (Step 14) The printer layer reports through the apply report's `printers` items, not a layer state.
fn run_printers(ctx: &ApplyCtx<'_>, doc: &AgentDoc) -> crate::network::printers::PrinterOutcome {
    crate::network::printers::apply(ctx, doc)
}

/// The state of an apply report for these layers (plan 4.2 `deviceApplyReports.state`): `failed`
/// when any layer failed, `partial` when any is partial, else `applied`. A layer that is
/// `unsupported`, `restartPending` or `auditFirst` did what it could: that is not a failure.
pub fn state_of(layers: &LayerStates) -> ApplyState {
    let all = [
        &layers.staff,
        &layers.machine,
        &layers.app_locker,
        &layers.app_control,
        &layers.proc_watch,
        &layers.boot,
        &layers.performance,
    ];
    if all.iter().any(|layer| layer.state == LayerStatus::Failed) {
        ApplyState::Failed
    } else if all.iter().any(|layer| layer.state == LayerStatus::Partial) {
        ApplyState::Partial
    } else {
        ApplyState::Applied
    }
}

/// What the rest of the apply report needs besides the layers.
#[derive(Debug, Clone, Default)]
pub struct ReportExtras {
    pub wifi: Vec<WifiItemState>,
    pub printers: Vec<PrinterItemState>,
    pub lkg_version: Option<u64>,
    pub capabilities: Vec<String>,
}

impl ApplyOutcome {
    /// The apply report of a document that was applied (plan 4.11 step 5).
    pub fn report(&self, version: u64, config: Option<ConfigRef>, extras: ReportExtras) -> ApplyReport {
        ApplyReport {
            applied_version: version,
            config,
            state: state_of(&self.layers),
            refusal: None,
            layers: self.layers.clone(),
            // The extras win when the caller has its own (the last-known-good path); else what this apply did.
            wifi: if extras.wifi.is_empty() { self.wifi.clone() } else { extras.wifi }
                .into_iter()
                .take(MAX_ITEM_STATES)
                .collect(),
            printers: if extras.printers.is_empty() { self.printers.clone() } else { extras.printers }
                .into_iter()
                .take(MAX_ITEM_STATES)
                .collect(),
            lkg_version: extras.lkg_version,
            capabilities: extras.capabilities,
        }
    }
}

impl ApplyRefusal {
    /// The apply report of a document that was refused: `refused`, the code, the configuration
    /// that was refused (the ring logic counts it as a failure) and the state that stays in force
    /// (`applied_version` and `layers` are the previous ones: nothing was written).
    pub fn report(
        &self,
        applied_version: u64,
        refused_config: Option<ConfigRef>,
        layers: LayerStates,
        extras: ReportExtras,
    ) -> ApplyReport {
        ApplyReport {
            applied_version,
            config: refused_config,
            state: ApplyState::Refused,
            refusal: Some(self.code().to_string()),
            layers,
            wifi: extras.wifi.into_iter().take(MAX_ITEM_STATES).collect(),
            printers: extras.printers.into_iter().take(MAX_ITEM_STATES).collect(),
            lkg_version: extras.lkg_version,
            capabilities: extras.capabilities,
        }
    }

    /// The device event for the Phase 4 audit queue: `device.lockdownRefused` with the code.
    pub fn audit(&self) -> (AuditKind, &'static str) {
        (AuditKind::DeviceLockdownRefused, self.code())
    }
}

/// Applies a verified document's Phase 5 keys.
pub fn apply(ctx: &ApplyCtx<'_>, doc: &AgentDoc) -> Result<ApplyOutcome, ApplyRefusal> {
    if ctx.journal.shared.read(|state| journal::unknown_target(state).is_some()) {
        return Err(ApplyRefusal::JournalUnknownTarget);
    }
    doc.check_limits(ctx.now_ms).map_err(ApplyRefusal::PolicyRejected)?;
    // While a `usbTempAllow` runs, the USB class blocks are lifted for every layer; when
    // it has ended the next apply (the agent's own timer) writes them again.
    let effective = usb::with_temp_allow(doc, ctx.now_ms);
    let doc = &*effective;
    validate_invariants(ctx, doc)?;

    let mut layers = LayerStates::all_off();
    let mut ran = Vec::with_capacity(APPLY_ORDER.len());
    let mut wifi = crate::network::wifi::WifiOutcome::default();
    let mut printers = crate::network::printers::PrinterOutcome::default();
    for layer in APPLY_ORDER {
        if layer == Layer::Wifi {
            wifi = run_wifi(ctx, doc);
        }
        if layer == Layer::Printers {
            printers = run_printers(ctx, doc);
        }
        let state = run_layer(ctx, doc, layer);
        ran.push(layer);
        match layer {
            Layer::Boot => layers.boot = state,
            Layer::Machine => layers.machine = state,
            Layer::Staff => layers.staff = state,
            Layer::AppControl => layers.app_control = state,
            Layer::AppLocker => layers.app_locker = state,
            Layer::ProcWatch => layers.proc_watch = state,
            Layer::Performance => layers.performance = state,
            // Wi-Fi and printers report through their own fields of the apply report.
            Layer::Wifi | Layer::Printers => {}
        }
    }
    Ok(ApplyOutcome { layers, ran, wifi: wifi.items, wifi_filters_error: wifi.filters_error, printers: printers.items })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::journal::{JournalEntry, JournalTarget, OriginalValue};
    use crate::platform::sim::SimPlatform;
    use crate::platform::{Platform, RegValueRef};
    use crate::state::{AgentState, SharedState, StateStore};
    use crate::testutil::TempDir;
    use std::sync::Arc;

    fn rig(state: AgentState) -> (TempDir, Arc<SimPlatform>, Arc<SharedState>) {
        let dir = TempDir::new();
        let platform = Arc::new(SimPlatform::new(dir.path().to_path_buf()));
        let dyn_platform: Arc<dyn Platform> = platform.clone();
        let shared = SharedState::new(StateStore::open(&dir.path().join("state")).unwrap(), state, dyn_platform);
        (dir, platform, shared)
    }

    fn ctx<'a>(platform: &'a SimPlatform, shared: &'a SharedState) -> ApplyCtx<'a> {
        ApplyCtx { journal: JournalCtx { platform, shared }, facts: Facts::default(), now_ms: 1_000, version: 7 }
    }

    #[test]
    fn the_order_is_the_one_of_plan_4_11() {
        use Layer::*;
        assert_eq!(
            APPLY_ORDER,
            [Boot, Machine, Staff, Wifi, Printers, AppControl, AppLocker, ProcWatch, Performance]
        );
    }

    #[test]
    fn a_phase_4_document_applies_as_every_layer_off_and_ok() {
        let (_dir, platform, shared) = rig(AgentState::default());
        let outcome = apply(&ctx(&platform, &shared), &AgentDoc::default()).unwrap();
        assert_eq!(outcome.ran, APPLY_ORDER);
        assert_eq!(outcome.layers, LayerStates::all_off());
        for state in [&outcome.layers.staff, &outcome.layers.boot, &outcome.layers.performance] {
            assert_eq!((state.mode, state.state), (super::super::ReportedMode::Off, super::super::LayerStatus::Ok));
        }
        // Nothing was written anywhere.
        assert!(platform.calls().iter().all(|op| !op.is_mutating()));
        assert!(shared.get().journal.is_empty());
    }

    #[test]
    fn the_layer_states_serialize_as_the_report_expects() {
        let json = serde_json::to_value(LayerStates::all_off()).unwrap();
        assert_eq!(json["appLocker"], serde_json::json!({ "mode": "off", "state": "ok" }));
        assert!(json.get("procWatch").is_some() && json.get("app_locker").is_none());
    }

    #[test]
    fn a_document_over_a_limit_is_policy_rejected_and_nothing_is_written() {
        let (_dir, platform, shared) = rig(AgentState::default());
        let wifi: Vec<_> = (0..21)
            .map(|i| {
                serde_json::json!({
                    "id": format!("w{i}"), "ssid": "Net", "hidden": false, "security": "open",
                    "autoConnect": true, "revision": 1
                })
            })
            .collect();
        let doc = AgentDoc::from_doc(&serde_json::json!({ "wifi": wifi })).unwrap();
        let refusal = apply(&ctx(&platform, &shared), &doc).unwrap_err();
        assert_eq!(refusal.code(), "policy_rejected");
        assert!(platform.calls().iter().all(|op| !op.is_mutating()));
    }

    #[test]
    fn the_apply_report_state_follows_the_layers() {
        use super::super::{LayerState, LayerStatus, ReportedMode};
        let mut layers = LayerStates::all_off();
        assert_eq!(state_of(&layers), ApplyState::Applied);
        layers.app_control = LayerState { mode: ReportedMode::Audit, state: LayerStatus::RestartPending, detail: None };
        layers.boot.state = LayerStatus::Unsupported;
        layers.proc_watch.state = LayerStatus::AuditFirst;
        assert_eq!(state_of(&layers), ApplyState::Applied, "waiting for a restart is not a failure");
        layers.machine.state = LayerStatus::Partial;
        assert_eq!(state_of(&layers), ApplyState::Partial);
        layers.staff.state = LayerStatus::Failed;
        assert_eq!(state_of(&layers), ApplyState::Failed);
    }

    #[test]
    fn an_applied_document_gives_one_report_and_a_refused_one_names_its_code() {
        let (_dir, platform, shared) = rig(AgentState::default());
        let outcome = apply(&ctx(&platform, &shared), &AgentDoc::default()).unwrap();
        let config = ConfigRef { group_id: "g1".into(), version: 4, ring: rulebox_policy::lockdown::Ring::Early };
        let report = outcome.report(7, Some(config.clone()), ReportExtras { lkg_version: Some(5), ..ReportExtras::default() });
        assert_eq!((report.state, report.applied_version, report.lkg_version, report.refusal.clone()), (ApplyState::Applied, 7, Some(5), None));
        assert_eq!(report.config, Some(config.clone()));

        let refusal = ApplyRefusal::Refused("would_block_exit");
        let refused = refusal.report(6, Some(config.clone()), LayerStates::all_off(), ReportExtras::default());
        assert_eq!((refused.state, refused.refusal.as_deref(), refused.applied_version), (ApplyState::Refused, Some("would_block_exit"), 6));
        assert_eq!(refused.config, Some(config), "the refused configuration counts as a failure for its ring");
        assert_eq!(refusal.audit(), (AuditKind::DeviceLockdownRefused, "would_block_exit"));
        assert_ne!(refused.content_hash(), report.content_hash());
        // The Wi-Fi and printer lists are bounded like the server's.
        let many: Vec<WifiItemState> = (0..80)
            .map(|n| WifiItemState { profile_id: format!("w{n}"), revision: 1, state: "applied".into(), detail: None })
            .collect();
        let bounded = outcome.report(7, None, ReportExtras { wifi: many, ..ReportExtras::default() });
        assert_eq!(bounded.wifi.len(), MAX_ITEM_STATES);
    }

    #[test]
    fn an_unknown_journal_target_refuses_the_apply() {
        let mut state = AgentState::default();
        let mut entry = JournalEntry::machine(
            RegValueRef { path: "SOFTWARE\\X".into(), name: "Y".into() },
            OriginalValue::Absent,
            1,
        );
        entry.target = JournalTarget::Unknown(serde_json::json!({ "gpuOverclock": { "card": 0 } }));
        state.journal.push(entry);
        let (_dir, platform, shared) = rig(state);
        let refusal = apply(&ctx(&platform, &shared), &AgentDoc::default()).unwrap_err();
        assert_eq!(refusal, ApplyRefusal::JournalUnknownTarget);
        assert_eq!(refusal.code(), "journal_unknown_target");
        assert!(platform.calls().iter().all(|op| !op.is_mutating()));
    }
}
