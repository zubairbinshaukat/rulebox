//! Tests of the boot part of L7 (plan Step 5): the Safe Mode registration and its exact
//! restore, Safe Mode detection, auto-recovery with the BitLocker rule, and the posture
//! mapping. All against `SimPlatform`; nothing touches the machine.

use std::sync::Arc;

use rulebox_policy::lockdown::{AutoRecovery, BootPolicy, LockdownPolicy};
use rulebox_policy::AgentDoc;
use rulebox_win32::machinereg;
use rulebox_win32::registry::RegValue;

use super::*;
use crate::journal::{EntryPhase, JournalCtx, JournalTarget, OriginalValue};
use crate::lockdown::apply::{apply as apply_all, APPLY_ORDER};
use crate::lockdown::invariants::Facts;
use crate::lockdown::LayerStatus;
use crate::platform::sim::{SimOp, SimPlatform};
use crate::state::{AgentState, SharedState, StateStore};
use crate::testutil::TempDir;

const MINIMAL: &str = r"SYSTEM\CurrentControlSet\Control\SafeBoot\Minimal\RuleboxAgent";
const NETWORK: &str = r"SYSTEM\CurrentControlSet\Control\SafeBoot\Network\RuleboxAgent";

struct Rig {
    _dir: TempDir,
    platform: Arc<SimPlatform>,
    shared: Arc<SharedState>,
}

impl Rig {
    fn new() -> Self {
        let dir = TempDir::new();
        let platform = Arc::new(SimPlatform::new(dir.path().to_path_buf()));
        platform.with_world(|w| w.strict_machine_keys = true);
        let dyn_platform: Arc<dyn Platform> = platform.clone();
        let shared = SharedState::new(StateStore::open(&dir.path().join("state")).unwrap(), AgentState::default(), dyn_platform);
        Self { _dir: dir, platform, shared }
    }

    fn ctx(&self) -> ApplyCtx<'_> {
        ApplyCtx {
            journal: JournalCtx { platform: self.platform.as_ref(), shared: self.shared.as_ref() },
            facts: Facts { admin_signin_verified: true, ..Facts::default() },
            now_ms: 1_000,
            version: 7,
        }
    }

    fn apply(&self, boot: Option<BootPolicy>) -> LayerState {
        let doc = AgentDoc { lockdown: boot.map(|boot| LockdownPolicy { boot, ..LockdownPolicy::default() }), ..AgentDoc::default() };
        apply(&self.ctx(), &doc)
    }

    fn registered(&self, path: &str) -> Option<RegData> {
        self.platform.read_machine_value(&RegValueRef { path: path.into(), name: String::new() }).unwrap()
    }

    fn bcd(&self) -> Option<String> {
        self.platform.with_world(|w| w.bcd.get(&("{current}".to_string(), "recoveryenabled".to_string())).cloned())
    }

    fn set_bit_locker(&self, state: BitLocker) {
        self.platform.with_world(|w| w.posture.bit_locker = state);
    }

    fn mutating(&self) -> usize {
        self.platform.calls().iter().filter(|op| op.is_mutating()).count()
    }

    fn entry(&self, id: &str) -> Option<crate::journal::JournalEntry> {
        self.shared.read(|s| s.journal.iter().find(|e| e.id == id).cloned())
    }
}

fn guard_only() -> BootPolicy {
    BootPolicy { auto_recovery: AutoRecovery::Leave, safe_mode_guard: true }
}

fn recovery_off() -> BootPolicy {
    BootPolicy { auto_recovery: AutoRecovery::Off, safe_mode_guard: false }
}

// ---------------------------------------------------------------- Safe Mode registration

#[test]
fn the_agent_is_registered_for_minimal_and_network_and_the_keys_go_again() {
    let rig = Rig::new();
    let state = rig.apply(Some(guard_only()));
    assert_eq!((state.mode, state.state), (ReportedMode::On, LayerStatus::Ok));
    for path in [MINIMAL, NETWORK] {
        assert_eq!(rig.registered(path), Some(RegData::String("Service".into())));
        // The write is inside the allow-list: the real rule, not a copy.
        assert!(machinereg::check_write(path, "", Some(&RegValue::String("Service".into()))).is_ok());
    }
    for mode in SAFE_MODES {
        let entry = rig.entry(&safe_boot_id(mode)).unwrap();
        assert_eq!((entry.owner, entry.original, entry.phase), (JournalOwner::L7, OriginalValue::NotPresent, EntryPhase::Applied));
        assert_eq!(entry.target, JournalTarget::SafeBootEntry { mode: mode.to_string() });
    }
    // Idempotent.
    let calls = rig.mutating();
    assert_eq!(rig.apply(Some(guard_only())).state, LayerStatus::Ok);
    assert_eq!(rig.mutating(), calls);
    // Switched off: the keys themselves are deleted (a key without a value still registers).
    let state = rig.apply(Some(BootPolicy { safe_mode_guard: false, ..guard_only() }));
    assert_eq!(state.state, LayerStatus::Ok);
    assert!(rig.platform.calls().contains(&SimOp::RemoveSafeBootEntry));
    assert_eq!(rig.platform.with_world(|w| w.machine_values.len()), 0);
    assert!(rig.shared.read(|s| s.journal.is_empty()));
}

#[test]
fn a_registration_that_was_already_there_with_another_value_comes_back_exactly() {
    let rig = Rig::new();
    rig.platform.with_world(|w| {
        w.machine_values.insert(RegValueRef { path: MINIMAL.into(), name: String::new() }, RegData::String("Driver".into()));
    });
    rig.apply(Some(guard_only()));
    assert_eq!(rig.registered(MINIMAL), Some(RegData::String("Service".into())));
    assert_eq!(rig.entry(&safe_boot_id("Minimal")).unwrap().original, OriginalValue::String("Driver".into()));
    rig.apply(None);
    assert_eq!(rig.registered(MINIMAL), Some(RegData::String("Driver".into())));
    assert_eq!(rig.registered(NETWORK), None);
}

#[test]
fn disable_restores_the_registration_with_the_whole_journal() {
    let rig = Rig::new();
    rig.apply(Some(guard_only()));
    let report = journal::restore_all(&rig.ctx().journal);
    assert!(report.is_complete(), "{:?}", report.failed_ids());
    assert_eq!(rig.platform.with_world(|w| w.machine_values.len()), 0);
}

#[test]
fn only_the_agents_own_safe_mode_key_can_be_deleted() {
    let rig = Rig::new();
    for mode in ["Option", "Minimal\\Other", ""] {
        assert!(rig.platform.remove_safe_boot_entry(mode).is_err(), "{mode}");
    }
    assert!(rig.platform.remove_safe_boot_entry("Minimal").is_ok());
}

// ---------------------------------------------------------------- Safe Mode behaviour

#[test]
fn safe_mode_is_read_from_the_option_value() {
    let rig = Rig::new();
    assert!(!in_safe_mode(rig.platform.as_ref()), "a normal boot has no OptionValue");
    let key = |value: Option<RegData>| {
        rig.platform.with_world(|w| {
            let k = RegValueRef { path: OPTION_KEY.into(), name: OPTION_VALUE.into() };
            match value {
                Some(v) => w.machine_values.insert(k, v),
                None => w.machine_values.remove(&k),
            }
        });
    };
    key(Some(RegData::Dword(1)));
    assert!(in_safe_mode(rig.platform.as_ref()));
    key(Some(RegData::Dword(2)));
    assert!(in_safe_mode(rig.platform.as_ref()));
    key(Some(RegData::Dword(0)));
    assert!(!in_safe_mode(rig.platform.as_ref()));
    key(Some(RegData::String("1".into())));
    assert!(!in_safe_mode(rig.platform.as_ref()));
    // A failing read is a normal boot, never a guess that holds sign-in off.
    key(Some(RegData::Dword(1)));
    rig.platform.fail_next(SimOp::ReadMachineValue, PlatformError::AccessDenied);
    assert!(!in_safe_mode(rig.platform.as_ref()));
    assert!(in_safe_mode(rig.platform.as_ref()));
    // Reading is not a change.
    assert_eq!(rig.mutating(), 0);
}

// ---------------------------------------------------------------- auto-recovery

#[test]
fn auto_recovery_off_sets_the_element_when_bitlocker_is_off_and_restores_it() {
    let rig = Rig::new();
    rig.platform.with_world(|w| {
        w.bcd.insert(("{current}".into(), "recoveryenabled".into()), "Yes".into());
    });
    let state = rig.apply(Some(recovery_off()));
    assert_eq!(state.state, LayerStatus::Ok);
    assert_eq!(rig.bcd().as_deref(), Some("No"));
    assert_eq!(rig.entry(&bcd_id()).unwrap().original, OriginalValue::BcdValue(Some("Yes".into())));
    // Idempotent.
    let calls = rig.mutating();
    rig.apply(Some(recovery_off()));
    assert_eq!(rig.mutating(), calls);
    // `leave`: put it back.
    rig.apply(Some(guard_only()));
    assert_eq!(rig.bcd().as_deref(), Some("Yes"));
    assert!(rig.entry(&bcd_id()).is_none());
}

#[test]
fn an_element_that_was_not_set_is_restored_to_the_default_yes() {
    let rig = Rig::new();
    assert_eq!(rig.bcd(), None);
    rig.apply(Some(recovery_off()));
    assert_eq!(rig.entry(&bcd_id()).unwrap().original, OriginalValue::BcdValue(None));
    assert_eq!(rig.bcd().as_deref(), Some("No"));
    rig.apply(None);
    assert_eq!(rig.bcd().as_deref(), Some("Yes"));
    assert!(rig.shared.read(|s| s.journal.is_empty()));
}

#[test]
fn bitlocker_on_suspended_or_unknown_leaves_auto_recovery_alone() {
    for state in [BitLocker::On, BitLocker::Suspended, BitLocker::Unknown] {
        let rig = Rig::new();
        rig.set_bit_locker(state);
        let layer = rig.apply(Some(recovery_off()));
        assert_eq!(layer.state, LayerStatus::Ok, "{state:?}");
        assert_eq!(layer.detail.as_deref(), Some("bitlocker_protects_os_volume"), "{state:?}");
        assert!(rig.platform.calls().iter().all(|op| *op != SimOp::BcdSet), "{state:?}");
        assert_eq!(rig.bcd(), None);
        assert!(rig.entry(&bcd_id()).is_none());
    }
}

#[test]
fn bitlocker_turned_on_later_does_not_make_the_agent_touch_the_element_again() {
    let rig = Rig::new();
    rig.apply(Some(recovery_off()));
    rig.set_bit_locker(BitLocker::On);
    let before = rig.mutating();
    let layer = rig.apply(Some(BootPolicy { auto_recovery: AutoRecovery::Leave, safe_mode_guard: false }));
    assert_eq!(layer.detail.as_deref(), Some("bitlocker_protects_os_volume"));
    assert_eq!(rig.mutating(), before, "no BCD write while BitLocker protects the volume");
    assert_eq!(rig.bcd().as_deref(), Some("No"));
    assert!(rig.entry(&bcd_id()).is_some(), "kept for the Disable path");
}

#[test]
fn an_unreadable_posture_changes_nothing_and_says_so() {
    let rig = Rig::new();
    rig.platform.fail_next(SimOp::ReadSecurityPosture, PlatformError::AccessDenied);
    let layer = rig.apply(Some(recovery_off()));
    assert_eq!((layer.state, layer.detail.as_deref()), (LayerStatus::Failed, Some("posture_unreadable")));
    assert!(rig.platform.calls().iter().all(|op| *op != SimOp::BcdSet));
}

#[test]
fn a_bcd_element_other_than_the_one_rule_cannot_be_written_through_the_seam() {
    let rig = Rig::new();
    assert!(rig.platform.bcd_set("{bootmgr}", "displayorder", "x").is_err());
    assert!(rig.platform.bcd_set("{current}", "recoveryenabled", "Maybe").is_err());
    assert!(rig.platform.bcd_get("{default}", "path").is_err());
}

#[test]
fn an_unknown_auto_recovery_value_keeps_what_was_applied() {
    let rig = Rig::new();
    rig.apply(Some(recovery_off()));
    let layer = rig.apply(Some(BootPolicy { auto_recovery: AutoRecovery::Unknown, safe_mode_guard: false }));
    assert_eq!(layer.detail.as_deref(), Some("section_unknown_value"));
    assert_eq!(rig.bcd().as_deref(), Some("No"));
}

// ---------------------------------------------------------------- the report

fn posture(secure_boot: SecureBoot, bit_locker: BitLocker, tpm: Tpm) -> SecurityPosture {
    SecurityPosture { secure_boot, bit_locker, tpm, ci_policies: vec!["ignored".into()] }
}

#[test]
fn posture_values_map_to_the_report_enums() {
    let report = report_from(&posture(SecureBoot::On, BitLocker::On, Tpm::Ready), Some("No"), true);
    assert_eq!(
        (report.secure_boot, report.bit_locker, report.tpm, report.auto_recovery, report.safe_mode_agent),
        ("on", "on", "ready", "off", true)
    );
    let report = report_from(&posture(SecureBoot::Off, BitLocker::Suspended, Tpm::Present), Some("Yes"), false);
    assert_eq!((report.secure_boot, report.bit_locker, report.tpm, report.auto_recovery), ("off", "suspended", "present", "on"));
    let report = report_from(&posture(SecureBoot::Unsupported, BitLocker::Off, Tpm::Absent), None, false);
    assert_eq!((report.secure_boot, report.bit_locker, report.tpm, report.auto_recovery), ("unsupported", "off", "absent", "on"));
    assert_eq!(report_from(&posture(SecureBoot::On, BitLocker::Unknown, Tpm::Unknown), None, false).bit_locker, "unknown");
    // The JSON names are the report's.
    let json = serde_json::to_value(report).unwrap();
    assert_eq!(json["secureBoot"], "unsupported");
    assert_eq!(json["safeModeAgent"], false);
    assert!(json.get("ciPolicies").is_none(), "other products' policy ids are never reported here");
}

#[test]
fn the_report_is_read_from_the_machine() {
    let rig = Rig::new();
    let report = read_report(rig.platform.as_ref()).unwrap();
    assert_eq!((report.auto_recovery, report.safe_mode_agent, report.bit_locker), ("on", false, "off"));
    rig.apply(Some(BootPolicy { auto_recovery: AutoRecovery::Off, safe_mode_guard: true }));
    let report = read_report(rig.platform.as_ref()).unwrap();
    assert_eq!((report.auto_recovery, report.safe_mode_agent), ("off", true));
    // One flavour is not enough.
    rig.platform.remove_safe_boot_entry("Network").unwrap();
    assert!(!read_report(rig.platform.as_ref()).unwrap().safe_mode_agent);
}

// ---------------------------------------------------------------- the transaction

#[test]
fn the_apply_transaction_runs_the_boot_layer_first() {
    assert_eq!(APPLY_ORDER[0], crate::lockdown::apply::Layer::Boot);
    let rig = Rig::new();
    let doc = AgentDoc { lockdown: Some(LockdownPolicy::default()), ..AgentDoc::default() };
    let outcome = apply_all(&rig.ctx(), &doc).unwrap();
    assert_eq!((outcome.layers.boot.mode, outcome.layers.boot.state), (ReportedMode::On, LayerStatus::Ok));
    assert_eq!(rig.registered(MINIMAL), Some(RegData::String("Service".into())));
    assert_eq!(rig.bcd().as_deref(), Some("No"), "the default is auto-recovery off, BitLocker off in the sim");
    let outcome = apply_all(&rig.ctx(), &AgentDoc::default()).unwrap();
    assert_eq!(outcome.layers.boot, LayerState::off_ok());
    assert_eq!(rig.registered(MINIMAL), None);
}
