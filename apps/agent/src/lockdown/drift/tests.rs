//! Tests of drift detection and the fighting guard (plan 4.11, Phase 5 Step 9), against
//! `SimPlatform` and the real journal.

use std::sync::Arc;

use super::*;
use crate::journal::{change, Change, ChangeOutcome, EntryPhase, JournalCtx, OriginalValue};
use crate::lockdown::{LayerStates, ReportedMode};
use crate::platform::sim::SimPlatform;
use crate::platform::{Platform, RegData, RegValueRef};
use crate::state::{AgentState, StateStore};
use crate::testutil::TempDir;

const T0: u64 = 1_800_000_000_000;
const MIN: u64 = 60_000;

struct Rig {
    _dir: TempDir,
    platform: Arc<SimPlatform>,
    shared: Arc<SharedState>,
    tracker: DriftTracker,
    daily: DailyCounters,
    audits: Vec<(AuditKind, String)>,
}

fn key() -> RegValueRef {
    RegValueRef { path: r"SOFTWARE\Rulebox\JournalTest".into(), name: "Policy".into() }
}

fn rig() -> Rig {
    let dir = TempDir::new();
    let platform = Arc::new(SimPlatform::new(dir.path().to_path_buf()));
    let dyn_platform: Arc<dyn Platform> = platform.clone();
    let store = StateStore::open(&dir.path().join("state")).unwrap();
    let shared = SharedState::new(store, AgentState::default(), dyn_platform);
    let daily = DailyCounters::open(dir.path().join("security-daily.json")).unwrap();
    Rig { _dir: dir, platform, shared, tracker: DriftTracker::new(), daily, audits: Vec::new() }
}

impl Rig {
    fn ctx(&self) -> JournalCtx<'_> {
        JournalCtx { platform: self.platform.as_ref(), shared: self.shared.as_ref() }
    }

    fn assert(&self, value: u32) -> ChangeOutcome {
        change(&self.ctx(), &Change::machine(JournalOwner::L2, key(), Some(RegData::Dword(value)))).unwrap()
    }

    /// Something else sets the value.
    fn foreign(&self, value: u32) {
        self.platform.with_world(|world| {
            world.machine_values.insert(key(), RegData::Dword(value));
        });
    }

    fn value(&self) -> Option<RegData> {
        self.platform.with_world(|world| world.machine_values.get(&key()).cloned())
    }

    fn pass(&mut self, now_ms: u64) -> DriftOutcome {
        let Rig { shared, tracker, daily, audits, .. } = self;
        tracker.finish_pass(shared, daily, now_ms, None, &mut |kind, detail| audits.push((kind, detail)))
    }
}

#[test]
fn a_value_changed_behind_our_back_is_written_again_counted_and_audited_once_a_day() {
    let mut rig = rig();
    rig.platform.with_world(|world| {
        world.machine_values.insert(key(), RegData::Dword(0));
    });
    assert_eq!(rig.assert(1), ChangeOutcome::Written, "the first write");
    rig.shared.take_rewrites();
    let original = rig.shared.get().journal[0].original.clone();
    assert_eq!(original, OriginalValue::Dword(0));

    // Three drifts on the same server day: three counted, one audited.
    for n in 0..3u64 {
        rig.foreign(0);
        assert_eq!(rig.assert(1), ChangeOutcome::Written);
        let outcome = rig.pass(T0 + n * 10 * MIN);
        assert_eq!(outcome.rewrites, 1);
    }
    assert_eq!(rig.value(), Some(RegData::Dword(1)));
    assert_eq!(rig.audits.len(), 1);
    let (kind, detail) = &rig.audits[0];
    assert_eq!(*kind, AuditKind::DeviceDriftReasserted);
    assert!(detail.starts_with("L2:") && detail.len() == 11, "{detail}");
    assert!(!detail.contains("Rulebox") && !detail.contains("Policy") && !detail.contains("SOFTWARE"), "{detail}");
    // The original was not touched and the entry stays applied.
    let entry = &rig.shared.get().journal[0];
    assert_eq!((entry.original.clone(), entry.phase), (original, EntryPhase::Applied));
    let today = crate::lockdown::daily::server_day(T0, None);
    assert_eq!(rig.daily.today().map(|d| (d.day, d.drift)), Some((today, 3)));

    // The next server day: audited again, once.
    for _ in 0..2 {
        rig.foreign(0);
        rig.assert(1);
        rig.pass(T0 + 25 * 3_600_000);
    }
    assert_eq!(rig.audits.len(), 2);
}

#[test]
fn a_second_target_is_audited_on_its_own() {
    let mut rig = rig();
    let other = RegValueRef { path: r"SOFTWARE\Rulebox\JournalTest".into(), name: "Other".into() };
    for name in [key(), other.clone()] {
        change(&rig.ctx(), &Change::machine(JournalOwner::L2, name, Some(RegData::Dword(1)))).unwrap();
    }
    rig.shared.take_rewrites();
    rig.foreign(5);
    rig.platform.with_world(|world| {
        world.machine_values.insert(other.clone(), RegData::Dword(5));
    });
    rig.assert(1);
    change(&rig.ctx(), &Change::machine(JournalOwner::L2, other, Some(RegData::Dword(1)))).unwrap();
    assert_eq!(rig.pass(T0).rewrites, 2);
    assert_eq!(rig.audits.len(), 2);
    assert_ne!(rig.audits[0].1, rig.audits[1].1);
}

#[test]
fn a_new_documents_changes_are_not_drift() {
    let mut rig = rig();
    rig.assert(1);
    // The next document wants another value for the same target.
    assert_eq!(rig.assert(2), ChangeOutcome::Written);
    rig.tracker.new_document(&rig.shared);
    let outcome = rig.pass(T0);
    assert_eq!(outcome.rewrites, 0);
    assert!(rig.audits.is_empty() && rig.daily.today().is_none());
}

#[test]
fn a_target_fought_over_is_left_alone_for_the_rest_of_the_hour() {
    let mut rig = rig();
    rig.assert(1);
    rig.shared.take_rewrites();
    // Seven rewrites within half an hour.
    for n in 0..=FIGHTING_REWRITES as u64 {
        rig.tracker.expire(T0 + n * 5 * MIN);
        rig.foreign(0);
        assert_eq!(rig.assert(1), ChangeOutcome::Written, "rewrite {n}");
        let outcome = rig.pass(T0 + n * 5 * MIN);
        assert_eq!(outcome.newly_muted.is_empty(), n < FIGHTING_REWRITES as u64);
    }
    // From now on the foreign value stays: the journal does not write.
    let t = T0 + 35 * MIN;
    rig.foreign(0);
    assert_eq!(rig.assert(1), ChangeOutcome::Unchanged);
    assert_eq!(rig.value(), Some(RegData::Dword(0)));
    assert_eq!(rig.pass(t).rewrites, 0);
    // The layer says so.
    let mut layers = LayerStates::all_off();
    layers.machine.mode = ReportedMode::On;
    rig.tracker.apply_to_layers(&mut layers, t);
    assert_eq!((layers.machine.state, layers.machine.detail.as_deref()), (LayerStatus::Partial, Some("fighting")));
    assert_eq!(layers.staff, super::super::LayerState::off_ok());
    // An hour after the first rewrite the mute is over and the value is written again.
    let later = T0 + 61 * MIN;
    rig.tracker.expire(later);
    rig.shared.set_muted(Default::default());
    assert!(rig.tracker.fighting_owners(later).is_empty());
    assert_eq!(rig.assert(1), ChangeOutcome::Written);
    assert_eq!(rig.value(), Some(RegData::Dword(1)));
}

#[test]
fn a_new_document_ends_the_mute() {
    let mut rig = rig();
    rig.assert(1);
    rig.shared.take_rewrites();
    for n in 0..=FIGHTING_REWRITES as u64 {
        rig.foreign(0);
        rig.assert(1);
        rig.pass(T0 + n * MIN);
    }
    assert!(rig.shared.is_muted(&rig.shared.get().journal[0].id));
    rig.tracker.new_document(&rig.shared);
    assert!(!rig.shared.is_muted(&rig.shared.get().journal[0].id));
    rig.foreign(0);
    assert_eq!(rig.assert(1), ChangeOutcome::Written);
}

#[test]
fn a_mute_only_holds_back_a_target_that_was_already_applied() {
    let rig = rig();
    rig.shared.set_muted(std::iter::once(crate::journal::machine_id(&key())).collect());
    // Never applied before: this is a first write, not a re-assertion.
    assert_eq!(rig.assert(1), ChangeOutcome::Written);
    assert_eq!(rig.value(), Some(RegData::Dword(1)));
}

#[test]
fn the_reconcile_pass_is_due_at_start_every_ten_minutes_and_when_the_build_changes() {
    let mut tracker = DriftTracker::new();
    assert!(tracker.reassert_due(T0, Some("26100.1")), "at start");
    assert!(!tracker.reassert_due(T0 + 9 * MIN, Some("26100.1")));
    assert!(tracker.reassert_due(T0 + 10 * MIN, Some("26100.1")), "every ten minutes");
    assert!(!tracker.reassert_due(T0 + 11 * MIN, Some("26100.1")));
    assert!(tracker.reassert_due(T0 + 12 * MIN, Some("26200.2")), "a new OS build");
    assert!(!tracker.reassert_due(T0 + 13 * MIN, Some("26200.2")));
    // An unknown build is not a change.
    assert!(!tracker.reassert_due(T0 + 14 * MIN, None));
}

#[test]
fn a_failed_layer_keeps_its_worse_state() {
    let mut rig = rig();
    rig.assert(1);
    rig.shared.take_rewrites();
    for n in 0..=FIGHTING_REWRITES as u64 {
        rig.foreign(0);
        rig.assert(1);
        rig.pass(T0 + n * MIN);
    }
    let mut layers = LayerStates::all_off();
    layers.machine.state = LayerStatus::Failed;
    rig.tracker.apply_to_layers(&mut layers, T0 + 7 * MIN);
    assert_eq!(layers.machine.state, LayerStatus::Failed);
}
