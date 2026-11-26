//! Tests of journal v2 (Phase 5 Step 2): the types and their spelling on disk, the
//! v1 to v2 migration of a Phase 2 state file, the three-step write with a crash after
//! each step, reverse-order restore, retry of a failed restore, and the refusal of an
//! unknown target. All against `SimPlatform`; nothing touches the machine.

use super::*;

use std::sync::Arc;

use serde_json::json;

use crate::agent::AgentConfig;
use crate::kiosk::{EnableOptions, Kiosk, KioskError};
use crate::paths::InstallPaths;
use crate::platform::sim::{SimOp, SimPlatform};
use crate::state::{parse_state, StateStore, STATE_SCHEMA, STATE_V1_BACKUP};
use crate::testutil::TempDir;

const FIXTURE: &str = include_str!("fixtures/state-v1-vm.json");
const WINLOGON: &str = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon";
const TEST_KEY: &str = r"SOFTWARE\Rulebox\JournalTest";

fn key(name: &str) -> RegValueRef {
    RegValueRef { path: TEST_KEY.to_string(), name: name.to_string() }
}

fn text(value: &str) -> RegData {
    RegData::String(value.to_string())
}

struct Rig {
    dir: TempDir,
    platform: Arc<SimPlatform>,
    shared: Arc<SharedState>,
}

impl Rig {
    fn new() -> Self {
        Self::with_state(AgentState::default())
    }

    fn with_state(state: AgentState) -> Self {
        let dir = TempDir::new();
        let platform = Arc::new(SimPlatform::new(dir.path().to_path_buf()));
        let dyn_platform: Arc<dyn Platform> = platform.clone();
        let store = StateStore::open(&dir.path().join("state")).unwrap();
        let shared = SharedState::new(store, state, dyn_platform);
        Self { dir, platform, shared }
    }

    fn ctx(&self) -> JournalCtx<'_> {
        JournalCtx { platform: self.platform.as_ref(), shared: self.shared.as_ref() }
    }

    /// A new `SharedState` over the same files: what a restarted agent sees.
    fn restarted(&self) -> Arc<SharedState> {
        let store = StateStore::open(&self.dir.path().join("state")).unwrap();
        let state = store.load().unwrap();
        let platform: Arc<dyn Platform> = self.platform.clone();
        SharedState::new(store, state, platform)
    }

    fn set(&self, key: RegValueRef, data: RegData) {
        self.platform.with_world(|w| {
            w.machine_values.insert(key, data);
        });
    }

    fn value(&self, key: &RegValueRef) -> Option<RegData> {
        self.platform.with_world(|w| w.machine_values.get(key).cloned())
    }

    fn mutating_calls(&self) -> usize {
        self.platform.calls().iter().filter(|op| op.is_mutating()).count()
    }

    fn state_file(&self) -> String {
        std::fs::read_to_string(self.dir.path().join("state").join("agent-state.json")).unwrap()
    }
}

fn set_to(name: &str, value: &str) -> Change {
    Change::machine(JournalOwner::Kiosk, key(name), Some(text(value)))
}

fn entry_of(state: &AgentState, name: &str) -> JournalEntry {
    state.journal.iter().find(|e| e.key_name() == name).cloned().unwrap_or_else(|| panic!("no entry for {name}"))
}

// -- the types and their spelling on disk -------------------------------------------------

#[test]
fn an_entry_round_trips_in_camel_case_with_a_tagged_target() {
    let entry = JournalEntry {
        id: "svc:SysMain|start".into(),
        owner: JournalOwner::L7,
        target: JournalTarget::ServiceStart { name: "SysMain".into() },
        original: OriginalValue::ServiceStart(2),
        phase: EntryPhase::Restoring,
        since_version: 9,
        recorded_at_ms: 5,
        last_error: Some("access_denied".into()),
    };
    let value = serde_json::to_value(&entry).unwrap();
    assert_eq!(
        value,
        json!({
            "id": "svc:SysMain|start", "owner": "l7",
            "target": { "serviceStart": { "name": "SysMain" } },
            "original": { "serviceStart": 2 }, "phase": "restoring",
            "sinceVersion": 9, "recordedAtMs": 5, "lastError": "access_denied"
        })
    );
    assert_eq!(serde_json::from_value::<JournalEntry>(value).unwrap(), entry);
}

#[test]
fn every_target_and_original_survives_a_round_trip() {
    let targets = vec![
        JournalTarget::MachineValue(key("A")),
        JournalTarget::StaffValue { path: "p".into(), name: "n".into() },
        JournalTarget::ServiceStart { name: "s".into() },
        JournalTarget::CiPolicy { policy_id: "{GUID}".into() },
        JournalTarget::AppLockerPolicy,
        JournalTarget::WlanProfile { name: "Acme".into() },
        JournalTarget::WlanFilters,
        JournalTarget::Printer { name: "p".into() },
        JournalTarget::PrinterPort { name: "p".into() },
        JournalTarget::PrinterSecurity { printer_key: "k7".into() },
        JournalTarget::BcdElement { object: "{current}".into(), element: "recoveryenabled".into() },
        JournalTarget::AccountLockoutPolicy,
        JournalTarget::SafeBootEntry { mode: "Minimal".into() },
        JournalTarget::ServiceSecurity { name: "RuleboxAgent".into() },
        JournalTarget::ServicePrivileges { name: "RuleboxAgent".into() },
        JournalTarget::PathAcl { path: r"C:\Program Files\Rulebox".into() },
    ];
    for target in targets {
        let back: JournalTarget = serde_json::from_value(serde_json::to_value(&target).unwrap()).unwrap();
        assert_eq!(back, target);
    }
    let originals = vec![
        OriginalValue::Absent,
        OriginalValue::Dword(1),
        OriginalValue::String("x".into()),
        OriginalValue::InSecrets,
        OriginalValue::Qword(1 << 40),
        OriginalValue::MultiString(vec!["a".into(), "b".into()]),
        OriginalValue::Binary("AAEC".into()),
        OriginalValue::Sddl("D:P(A;;GA;;;SY)".into()),
        OriginalValue::ServiceStart(4),
        OriginalValue::LockoutPolicy { threshold: 0, duration_s: 1800, window_s: 1800 },
        OriginalValue::BcdValue(Some("Yes".into())),
        OriginalValue::BcdValue(None),
        OriginalValue::NotPresent,
    ];
    for original in originals {
        let back: OriginalValue = serde_json::from_value(serde_json::to_value(&original).unwrap()).unwrap();
        assert_eq!(back, original);
    }
    // The lockout fields are camelCase on disk too.
    let lockout = serde_json::to_value(OriginalValue::LockoutPolicy { threshold: 5, duration_s: 1, window_s: 2 }).unwrap();
    assert_eq!(lockout, json!({ "lockoutPolicy": { "threshold": 5, "durationS": 1, "windowS": 2 } }));
}

#[test]
fn the_phase_2_originals_keep_their_v1_spelling() {
    assert_eq!(serde_json::to_value(OriginalValue::Absent).unwrap(), json!("absent"));
    assert_eq!(serde_json::to_value(OriginalValue::Dword(7)).unwrap(), json!({ "dword": 7 }));
    assert_eq!(serde_json::to_value(OriginalValue::String("a".into())).unwrap(), json!({ "string": "a" }));
    assert_eq!(serde_json::to_value(OriginalValue::InSecrets).unwrap(), json!("inSecrets"));
}

#[test]
fn a_target_this_build_does_not_know_loads_as_unknown_and_is_written_back_unchanged() {
    let raw = json!({ "gpuOverclock": { "card": 0 } });
    let entry_json = json!({
        "id": "gpu:0", "owner": "perf", "target": raw, "original": "absent",
        "phase": "applied", "sinceVersion": 3, "recordedAtMs": 1
    });
    let entry: JournalEntry = serde_json::from_value(entry_json.clone()).unwrap();
    assert_eq!(entry.target, JournalTarget::Unknown(raw.clone()));
    assert_eq!(serde_json::to_value(&entry).unwrap(), entry_json);
    // A unit variant spelled as a bare string, from a newer agent, is unknown too.
    let unit: JournalTarget = serde_json::from_value(json!("somethingNew")).unwrap();
    assert!(matches!(unit, JournalTarget::Unknown(_)));
    // And a known one is never mistaken for unknown.
    let known: JournalTarget = serde_json::from_value(json!("appLockerPolicy")).unwrap();
    assert_eq!(known, JournalTarget::AppLockerPolicy);
}

// -- migration v1 to v2 --------------------------------------------------------------------

#[test]
fn a_phase_2_vm_state_file_migrates_to_schema_2() {
    let (state, migrated) = parse_state(FIXTURE.as_bytes()).unwrap();
    assert!(migrated);
    assert_eq!(state.schema, 2);
    assert_eq!(state.journal.len(), 8);
    let first = &state.journal[0];
    assert_eq!(first.id, format!("hklm:{WINLOGON}|AutoAdminLogon"));
    assert_eq!(first.owner, JournalOwner::Kiosk);
    assert_eq!(first.target, JournalTarget::MachineValue(RegValueRef { path: WINLOGON.into(), name: "AutoAdminLogon".into() }));
    assert_eq!(first.original, OriginalValue::String("1".into()));
    assert_eq!((first.phase, first.since_version), (EntryPhase::Applied, 42));
    assert_eq!(entry_of(&state, "DefaultPassword").original, OriginalValue::InSecrets);
    assert_eq!(entry_of(&state, "AutoLogonCount").original, OriginalValue::Dword(3));
    assert_eq!(entry_of(&state, "DefaultDomainName").original, OriginalValue::Absent);
    // Everything else in the file is untouched.
    assert!(state.kiosk.lsa_taken_over);
    assert_eq!(state.kiosk.staff_hive.as_ref().map(|r| r.complete), Some(true));
    assert_eq!((state.last_applied_version, state.accepted_version), (42, 42));
    assert_eq!(state.trusted_keys.len(), 1);
    assert_eq!(state.enrollment.as_ref().map(|e| e.device_name.as_str()), Some("TEST-VM"));
    // Entry order is kept: it is the order values were first changed.
    let names: Vec<&str> = state.journal.iter().map(JournalEntry::key_name).collect();
    assert_eq!(names[..3], ["AutoAdminLogon", "DefaultUserName", "DefaultDomainName"]);
}

#[test]
fn migrating_twice_changes_nothing() {
    let (state, _) = parse_state(FIXTURE.as_bytes()).unwrap();
    let bytes = serde_json::to_vec_pretty(&state).unwrap();
    let (again, migrated) = parse_state(&bytes).unwrap();
    assert!(!migrated);
    assert_eq!(again, state);
}

#[test]
fn a_file_without_a_schema_key_counts_as_schema_1() {
    let old = json!({ "lastAppliedVersion": 5, "journal": [
        { "key": { "path": "P", "name": "N" }, "original": { "dword": 1 } }
    ]});
    let (state, migrated) = parse_state(old.to_string().as_bytes()).unwrap();
    assert!(migrated);
    assert_eq!(state.journal[0].since_version, 5);
    assert_eq!(state.journal[0].id, "hklm:P|N");
}

#[test]
fn loading_a_v1_file_keeps_it_once_as_state_v1_json_and_writes_v2() {
    let dir = TempDir::new();
    let state_dir = dir.path().join("state");
    std::fs::create_dir_all(&state_dir).unwrap();
    std::fs::write(state_dir.join("agent-state.json"), FIXTURE).unwrap();

    let store = StateStore::open(&state_dir).unwrap();
    let state = store.load().unwrap();
    assert_eq!(state.schema, STATE_SCHEMA);
    assert_eq!(state.journal.len(), 8);
    // The old file is kept byte for byte, and the live file is now schema 2.
    assert_eq!(std::fs::read_to_string(state_dir.join(STATE_V1_BACKUP)).unwrap(), FIXTURE);
    let live: serde_json::Value = serde_json::from_slice(&std::fs::read(state_dir.join("agent-state.json")).unwrap()).unwrap();
    assert_eq!(live["schema"], 2);
    assert!(live["journal"][0].get("target").is_some() && live["journal"][0].get("key").is_none());
    // A second load reads the v2 file and does not touch the backup.
    std::fs::write(state_dir.join(STATE_V1_BACKUP), "KEPT").unwrap();
    assert_eq!(store.load().unwrap(), state);
    assert_eq!(std::fs::read_to_string(state_dir.join(STATE_V1_BACKUP)).unwrap(), "KEPT");
}

#[test]
fn an_existing_state_v1_json_is_never_overwritten() {
    let dir = TempDir::new();
    let state_dir = dir.path().join("state");
    std::fs::create_dir_all(&state_dir).unwrap();
    std::fs::write(state_dir.join("agent-state.json"), FIXTURE).unwrap();
    std::fs::write(state_dir.join(STATE_V1_BACKUP), "FIRST BACKUP").unwrap();
    StateStore::open(&state_dir).unwrap().load().unwrap();
    assert_eq!(std::fs::read_to_string(state_dir.join(STATE_V1_BACKUP)).unwrap(), "FIRST BACKUP");
}

#[test]
fn when_the_backup_cannot_be_made_the_v1_file_is_left_alone() {
    let dir = TempDir::new();
    let state_dir = dir.path().join("state");
    std::fs::create_dir_all(&state_dir).unwrap();
    std::fs::write(state_dir.join("agent-state.json"), FIXTURE).unwrap();
    // A directory where the temporary file must go makes the backup write fail.
    std::fs::create_dir_all(state_dir.join("state.v1.json.tmp")).unwrap();
    assert!(StateStore::open(&state_dir).unwrap().load().is_err());
    assert_eq!(std::fs::read_to_string(state_dir.join("agent-state.json")).unwrap(), FIXTURE);
}

#[test]
fn a_migrated_phase_2_journal_is_restored_by_disable() {
    let (state, _) = parse_state(FIXTURE.as_bytes()).unwrap();
    let rig = Rig::with_state(state);
    // The machine as the Phase 2 kiosk left it.
    let winlogon = |name: &str| RegValueRef { path: WINLOGON.into(), name: name.into() };
    rig.set(winlogon("AutoAdminLogon"), text("1"));
    rig.set(winlogon("DefaultUserName"), text("RuleboxStaff"));
    rig.set(winlogon("DefaultDomainName"), text("TEST-VM"));
    rig.shared.update_secrets(|s| s.original_default_password_registry = Some("owner-pw".into())).unwrap();

    let config = AgentConfig::default();
    let install = InstallPaths::new(rig.dir.path().join("install"));
    let mut kiosk = Kiosk { platform: rig.platform.as_ref(), shared: rig.shared.as_ref(), config: &config, install: &install };
    kiosk.disable().unwrap();

    assert_eq!(rig.value(&winlogon("DefaultUserName")), Some(text("Owner")));
    assert_eq!(rig.value(&winlogon("DefaultDomainName")), None);
    assert_eq!(rig.value(&winlogon("DefaultPassword")), Some(text("owner-pw")));
    assert_eq!(rig.value(&winlogon("AutoLogonCount")), Some(RegData::Dword(3)));
    assert!(rig.shared.get().journal.is_empty());
    let kept = rig.shared.secrets(|s| s.original_default_password_registry.clone()).unwrap();
    assert_eq!(kept, None, "the kept password is gone once nothing needs it");
}

#[test]
fn recover_reads_a_v1_file_without_writing_anything() {
    use crate::recover::{plan, Facts, StateReading, Step};
    let (state, _) = parse_state(FIXTURE.as_bytes()).unwrap();
    let facts = Facts {
        state: StateReading::Readable(Box::new(state)),
        data_dir_trusted: true,
        default_user_name: Some("RuleboxStaff".into()),
        staff_sid: None,
        read_notes: Vec::new(),
    };
    let result = plan(&facts);
    let restores = result.steps.iter().filter(|s| matches!(s, Step::RestoreValue { .. })).count();
    assert_eq!(restores, 7, "seven values go back; the plaintext password is dropped, not restored");
    assert!(result.steps.iter().any(|s| matches!(s, Step::DropPasswordValue { key } if key.name == "DefaultPassword")));
}

// -- change: the write order ---------------------------------------------------------------

#[test]
fn a_change_saves_the_original_then_writes_then_marks_applied() {
    let rig = Rig::new();
    rig.set(key("V"), text("orig"));
    let outcome = change(&rig.ctx(), &set_to("V", "new").since(7)).unwrap();
    assert_eq!(outcome, ChangeOutcome::Written);
    assert_eq!(rig.value(&key("V")), Some(text("new")));
    let entry = entry_of(&rig.shared.get(), "V");
    assert_eq!(entry.original, OriginalValue::String("orig".into()));
    assert_eq!((entry.phase, entry.owner, entry.since_version), (EntryPhase::Applied, JournalOwner::Kiosk, 7));
    assert!(entry.recorded_at_ms > 0);
    assert_eq!(entry.id, machine_id(&key("V")));
    // It is on disk, not only in memory.
    assert!(rig.state_file().contains("\"phase\": \"applied\""));
}

#[test]
fn the_original_is_the_first_value_never_one_rulebox_wrote() {
    let rig = Rig::new();
    rig.set(key("V"), text("orig"));
    change(&rig.ctx(), &set_to("V", "first")).unwrap();
    change(&rig.ctx(), &set_to("V", "second")).unwrap();
    // Something else changes it behind our back, and we put it back.
    rig.set(key("V"), text("drifted"));
    change(&rig.ctx(), &set_to("V", "second")).unwrap();
    let state = rig.shared.get();
    assert_eq!(state.journal.len(), 1);
    assert_eq!(state.journal[0].original, OriginalValue::String("orig".into()));
    assert_eq!(restore_all(&rig.ctx()).restored.len(), 1);
    assert_eq!(rig.value(&key("V")), Some(text("orig")));
}

#[test]
fn a_value_that_is_already_right_is_not_journaled_unless_asked() {
    let rig = Rig::new();
    rig.set(key("V"), text("same"));
    assert_eq!(change(&rig.ctx(), &set_to("V", "same")).unwrap(), ChangeOutcome::Unchanged);
    assert!(rig.shared.get().journal.is_empty());
    assert_eq!(rig.mutating_calls(), 0);

    assert_eq!(change(&rig.ctx(), &set_to("V", "same").always_record()).unwrap(), ChangeOutcome::Recorded);
    let entry = entry_of(&rig.shared.get(), "V");
    assert_eq!((entry.original.clone(), entry.phase), (OriginalValue::String("same".into()), EntryPhase::Applied));
    assert_eq!(rig.mutating_calls(), 0, "recording needs no write");
    // And again: nothing to do.
    assert_eq!(change(&rig.ctx(), &set_to("V", "same").always_record()).unwrap(), ChangeOutcome::Unchanged);
}

#[test]
fn deleting_an_absent_value_changes_nothing_and_deleting_a_present_one_journals_it() {
    let rig = Rig::new();
    let delete = |name: &str| Change::machine(JournalOwner::Kiosk, key(name), None);
    assert_eq!(change(&rig.ctx(), &delete("Gone")).unwrap(), ChangeOutcome::Unchanged);
    rig.set(key("Here"), RegData::Dword(4));
    assert_eq!(change(&rig.ctx(), &delete("Here")).unwrap(), ChangeOutcome::Written);
    assert_eq!(rig.value(&key("Here")), None);
    assert_eq!(entry_of(&rig.shared.get(), "Here").original, OriginalValue::Dword(4));
    restore_all(&rig.ctx());
    assert_eq!(rig.value(&key("Here")), Some(RegData::Dword(4)));
}

#[test]
fn a_secret_original_goes_to_the_secrets_file_never_into_the_state_file() {
    let rig = Rig::new();
    rig.set(key("Pw"), text("owner-secret-password"));
    change(&rig.ctx(), &Change::machine(JournalOwner::Kiosk, key("Pw"), None).secret_original()).unwrap();
    assert_eq!(entry_of(&rig.shared.get(), "Pw").original, OriginalValue::InSecrets);
    assert!(!rig.state_file().contains("owner-secret-password"));
    assert_eq!(rig.shared.secrets(|s| s.original_default_password_registry.clone()).unwrap().as_deref(), Some("owner-secret-password"));
    restore_all(&rig.ctx());
    assert_eq!(rig.value(&key("Pw")), Some(text("owner-secret-password")));
    assert_eq!(rig.shared.secrets(|s| s.original_default_password_registry.clone()).unwrap(), None);
}

#[test]
fn a_target_without_a_platform_call_yet_is_refused_before_anything_changes() {
    let rig = Rig::new();
    let mut unsupported = set_to("V", "x");
    unsupported.target = JournalTarget::ServiceStart { name: "SysMain".into() };
    let error = change(&rig.ctx(), &unsupported).unwrap_err();
    assert!(matches!(error, JournalError::Platform(PlatformError::Refused(_))), "{error:?}");
    assert!(rig.shared.get().journal.is_empty());
    assert_eq!(rig.mutating_calls(), 0);
}

#[test]
fn a_failed_platform_write_leaves_a_pending_entry_that_the_next_start_drops() {
    let rig = Rig::new();
    rig.set(key("V"), text("orig"));
    rig.platform.fail_next(SimOp::WriteMachineValue, PlatformError::AccessDenied);
    assert!(matches!(
        change(&rig.ctx(), &set_to("V", "new")),
        Err(JournalError::Platform(PlatformError::AccessDenied))
    ));
    assert_eq!(entry_of(&rig.shared.get(), "V").phase, EntryPhase::Pending);

    let restarted = rig.restarted();
    let ctx = JournalCtx { platform: rig.platform.as_ref(), shared: restarted.as_ref() };
    let report = startup_recover(&ctx);
    assert_eq!(report.dropped, [machine_id(&key("V"))]);
    assert!(restarted.get().journal.is_empty());
    assert_eq!(rig.value(&key("V")), Some(text("orig")));
}

#[test]
fn a_state_that_cannot_be_saved_stops_the_change_before_the_write() {
    let rig = Rig::new();
    rig.set(key("V"), text("orig"));
    // A directory where the state file's temporary file goes makes every save fail.
    std::fs::create_dir_all(rig.dir.path().join("state").join("agent-state.json.tmp")).unwrap();
    let error = change(&rig.ctx(), &set_to("V", "new")).unwrap_err();
    assert!(matches!(error, JournalError::Persist(_)), "{error:?}");
    assert_eq!(rig.value(&key("V")), Some(text("orig")), "the original was not on disk, so nothing was written");
}

// -- crash injection: after each of the three steps ------------------------------------------

#[test]
fn a_crash_after_each_write_step_is_settled_and_restored_to_the_original() {
    for point in [CrashPoint::AfterPending, CrashPoint::AfterWrite, CrashPoint::AfterApplied] {
        for original in [Some(text("orig")), None] {
            let rig = Rig::new();
            if let Some(data) = &original {
                rig.set(key("V"), data.clone());
            }
            set_crash_point(Some(point));
            let crashed = change(&rig.ctx(), &set_to("V", "new"));
            set_crash_point(None);
            assert!(matches!(crashed, Err(JournalError::Crashed)), "{point:?}");

            // The process is gone; a new one starts over the files.
            let restarted = rig.restarted();
            let ctx = JournalCtx { platform: rig.platform.as_ref(), shared: restarted.as_ref() };
            let report = startup_recover(&ctx);
            match point {
                CrashPoint::AfterPending => {
                    assert_eq!(report.dropped.len(), 1, "{point:?}: the change never happened");
                    assert!(restarted.get().journal.is_empty(), "{point:?}");
                    assert_eq!(rig.value(&key("V")), original, "{point:?}");
                }
                CrashPoint::AfterWrite => {
                    assert_eq!(report.kept.len(), 1, "{point:?}: the change happened");
                    assert_eq!(entry_of(&restarted.get(), "V").phase, EntryPhase::Applied, "{point:?}");
                    assert_eq!(rig.value(&key("V")), Some(text("new")), "{point:?}");
                }
                CrashPoint::AfterApplied => {
                    assert!(report.dropped.is_empty() && report.kept.is_empty(), "{point:?}");
                    assert_eq!(entry_of(&restarted.get(), "V").phase, EntryPhase::Applied, "{point:?}");
                }
            }
            // Whatever happened, the original comes back.
            let restored = restore_all(&ctx);
            assert!(restored.is_complete(), "{point:?}");
            assert_eq!(rig.value(&key("V")), original, "{point:?}");
            assert!(restarted.get().journal.is_empty(), "{point:?}");
        }
    }
}

#[test]
fn after_a_crash_the_retry_keeps_the_original_and_never_records_the_written_value() {
    let rig = Rig::new();
    rig.set(key("V"), text("orig"));
    set_crash_point(Some(CrashPoint::AfterWrite));
    let _ = change(&rig.ctx(), &set_to("V", "new"));
    set_crash_point(None);
    // The value is already "new" and the entry is Pending: the retry must not read
    // "new" as the original.
    let restarted = rig.restarted();
    let ctx = JournalCtx { platform: rig.platform.as_ref(), shared: restarted.as_ref() };
    assert_eq!(change(&ctx, &set_to("V", "new")).unwrap(), ChangeOutcome::Unchanged);
    let entry = entry_of(&restarted.get(), "V");
    assert_eq!((entry.original, entry.phase), (OriginalValue::String("orig".into()), EntryPhase::Applied));
}

// -- restore: order, failure, retry --------------------------------------------------------------

fn three_changes(rig: &Rig) {
    for name in ["A", "B", "C"] {
        change(&rig.ctx(), &set_to(name, "rulebox")).unwrap();
    }
    assert_eq!(rig.shared.get().journal.len(), 3);
}

#[test]
fn restore_walks_the_journal_in_reverse_order() {
    let rig = Rig::new();
    three_changes(&rig);
    // The first restore write fails: in reverse order that is the last entry, C.
    rig.platform.fail_next(SimOp::WriteMachineValue, PlatformError::Other("injected".into()));
    let report = restore_all(&rig.ctx());
    assert_eq!(report.restored, [machine_id(&key("B")), machine_id(&key("A"))]);
    assert_eq!(report.failed_ids(), [machine_id(&key("C")).as_str()]);
    assert_eq!(rig.value(&key("A")), None);
    assert_eq!(rig.value(&key("C")), Some(text("rulebox")));
}

#[test]
fn a_failed_restore_stays_restoring_with_a_code_and_is_retried() {
    let rig = Rig::new();
    three_changes(&rig);
    rig.platform.fail_next(SimOp::WriteMachineValue, PlatformError::AccessDenied);
    let first = restore_all(&rig.ctx());
    assert!(!first.is_complete());
    let state = rig.shared.get();
    assert_eq!(state.journal.len(), 1);
    assert_eq!((state.journal[0].phase, state.journal[0].last_error.as_deref()), (EntryPhase::Restoring, Some("access_denied")));
    assert_eq!(state.journal[0].key_name(), "C");
    // The next call finishes it and clears the entry.
    let second = restore_all(&rig.ctx());
    assert!(second.is_complete());
    assert!(rig.shared.get().journal.is_empty());
    assert_eq!(rig.value(&key("C")), None);
}

#[test]
fn an_entry_left_restoring_is_restored_again_at_the_next_start() {
    let rig = Rig::new();
    three_changes(&rig);
    rig.platform.fail_next(SimOp::WriteMachineValue, PlatformError::Other("power cut".into()));
    restore_all(&rig.ctx());
    let restarted = rig.restarted();
    let ctx = JournalCtx { platform: rig.platform.as_ref(), shared: restarted.as_ref() };
    let report = startup_recover(&ctx);
    assert_eq!(report.restore.restored, [machine_id(&key("C"))]);
    assert!(restarted.get().journal.is_empty());
    assert_eq!(rig.value(&key("C")), None);
}

#[test]
fn restore_owner_restores_only_that_owners_entries() {
    let rig = Rig::new();
    change(&rig.ctx(), &Change::machine(JournalOwner::L2, key("Machine"), Some(text("x")))).unwrap();
    change(&rig.ctx(), &Change::machine(JournalOwner::Kiosk, key("Kiosk"), Some(text("y")))).unwrap();
    let report = restore_owner(&rig.ctx(), JournalOwner::L2);
    assert_eq!(report.restored, [machine_id(&key("Machine"))]);
    assert_eq!(rig.value(&key("Machine")), None);
    assert_eq!(rig.value(&key("Kiosk")), Some(text("y")));
    assert_eq!(rig.shared.get().journal.len(), 1);
}

#[test]
fn restoring_an_empty_journal_does_nothing() {
    let rig = Rig::new();
    let report = restore_all(&rig.ctx());
    assert!(report.is_complete() && report.restored.is_empty());
    assert_eq!(rig.mutating_calls(), 0);
}

// -- unknown targets -------------------------------------------------------------------------------

fn state_with_unknown_target() -> AgentState {
    let mut state = AgentState::default();
    let mut entry = JournalEntry::machine(key("Old"), OriginalValue::Absent, 1);
    entry.id = "gpu:0".into();
    entry.target = JournalTarget::Unknown(json!({ "gpuOverclock": { "card": 0 } }));
    state.journal.push(entry);
    state
}

#[test]
fn an_unknown_target_is_never_touched_and_is_reported() {
    let rig = Rig::with_state(state_with_unknown_target());
    assert!(unknown_target(&rig.shared.get()).is_some());
    let startup = startup_recover(&rig.ctx());
    assert_eq!(startup.unknown, ["gpu:0"]);
    let report = restore_all(&rig.ctx());
    assert!(matches!(report.failed.as_slice(), [(id, JournalError::UnknownTarget)] if id == "gpu:0"));
    assert_eq!(rig.shared.get().journal.len(), 1, "the entry stays, byte for byte");
    assert_eq!(rig.mutating_calls(), 0);
}

#[test]
fn the_kiosk_will_not_enable_while_the_journal_holds_an_unknown_target() {
    let mut state = state_with_unknown_target();
    state.enrollment = Some(crate::state::Enrollment {
        convex_url: "https://test.convex.cloud".into(),
        device_id: "d".into(),
        org_id: "o".into(),
        device_name: "n".into(),
        enrolled_at_ms: 1,
        revoked: false,
        allow_joined: false,
    });
    let rig = Rig::with_state(state);
    let config = AgentConfig::default();
    let install = InstallPaths::new(rig.dir.path().join("install"));
    let mut kiosk = Kiosk { platform: rig.platform.as_ref(), shared: rig.shared.as_ref(), config: &config, install: &install };

    let error = kiosk.enable(EnableOptions::default()).unwrap_err();
    assert!(matches!(error, KioskError::JournalUnknownTarget));
    assert_eq!(error.code(), "journal_unknown_target");
    // The kiosk-as-it-is rule: not even a rollback runs.
    let error = kiosk.enable_or_rollback(EnableOptions::default()).unwrap_err();
    assert!(matches!(error, KioskError::JournalUnknownTarget));
    assert_eq!(rig.mutating_calls(), 0);
    assert_eq!(rig.shared.get().journal.len(), 1);
    assert_eq!(rig.shared.get().kiosk.last_error.as_deref(), Some("journal_unknown_target"));
}

// -- Phase 5 Step 3: the Staff hive target ------------------------------------------------------

const STAFF_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Policies\System";

impl Rig {
    /// Creates the Staff account in the simulated machine and records it in the state.
    fn with_staff(&self) -> String {
        let spec = crate::platform::StaffUserSpec {
            user_name: "RuleboxStaff".into(),
            full_name: "Staff".into(),
            comment: "c".into(),
        };
        let sid = self.platform.create_staff_user(&spec, "pw").unwrap();
        let recorded = sid.clone();
        self.shared
            .update(move |state| {
                state.staff = Some(crate::state::StaffAccount {
                    sid: recorded,
                    user_name: "RuleboxStaff".into(),
                    profile_dir: None,
                });
            })
            .unwrap();
        sid
    }

    fn staff_value(&self, sid: &str, name: &str) -> Option<RegData> {
        self.platform.read_staff_value(sid, STAFF_KEY, name).unwrap()
    }
}

fn staff_set(name: &str, data: RegData) -> Change {
    Change::staff(JournalOwner::L1, STAFF_KEY, name, Some(data))
}

#[test]
fn a_staff_value_is_journalled_with_its_original_and_restored_exactly() {
    let rig = Rig::new();
    let sid = rig.with_staff();
    rig.platform.write_staff_value(&sid, STAFF_KEY, "DisableTaskMgr", &RegData::Dword(0)).unwrap();

    // Present (0), absent, and a string: each comes back as it was.
    assert_eq!(change(&rig.ctx(), &staff_set("DisableTaskMgr", RegData::Dword(1))).unwrap(), ChangeOutcome::Written);
    assert_eq!(change(&rig.ctx(), &staff_set("NoRun", RegData::Dword(1))).unwrap(), ChangeOutcome::Written);
    rig.platform.write_staff_value(&sid, STAFF_KEY, "Text", &text("before")).unwrap();
    change(&rig.ctx(), &staff_set("Text", text("after"))).unwrap();
    assert_eq!(rig.staff_value(&sid, "DisableTaskMgr"), Some(RegData::Dword(1)));

    let state = rig.shared.get();
    let originals: Vec<_> = state.journal.iter().map(|e| (e.id.clone(), e.original.clone(), e.phase)).collect();
    assert_eq!(
        originals,
        [
            (staff_id(STAFF_KEY, "DisableTaskMgr"), OriginalValue::Dword(0), EntryPhase::Applied),
            (staff_id(STAFF_KEY, "NoRun"), OriginalValue::Absent, EntryPhase::Applied),
            (staff_id(STAFF_KEY, "Text"), OriginalValue::String("before".into()), EntryPhase::Applied),
        ]
    );
    assert!(matches!(state.journal[0].target, JournalTarget::StaffValue { .. }));

    assert!(restore_all(&rig.ctx()).is_complete());
    assert_eq!(rig.staff_value(&sid, "DisableTaskMgr"), Some(RegData::Dword(0)));
    assert_eq!(rig.staff_value(&sid, "NoRun"), None);
    assert_eq!(rig.staff_value(&sid, "Text"), Some(text("before")));
    assert!(rig.shared.get().journal.is_empty());
}

#[test]
fn a_staff_change_that_is_already_in_place_writes_nothing_and_records_nothing() {
    let rig = Rig::new();
    let sid = rig.with_staff();
    rig.platform.write_staff_value(&sid, STAFF_KEY, "NoRun", &RegData::Dword(1)).unwrap();
    let before = rig.mutating_calls();
    assert_eq!(change(&rig.ctx(), &staff_set("NoRun", RegData::Dword(1))).unwrap(), ChangeOutcome::Unchanged);
    assert_eq!(rig.mutating_calls(), before);
    assert!(rig.shared.get().journal.is_empty());
}

#[test]
fn a_crash_after_each_step_of_a_staff_change_is_settled_and_restored() {
    for point in [CrashPoint::AfterPending, CrashPoint::AfterWrite, CrashPoint::AfterApplied] {
        let rig = Rig::new();
        let sid = rig.with_staff();
        rig.platform.write_staff_value(&sid, STAFF_KEY, "NoRun", &RegData::Dword(0)).unwrap();
        set_crash_point(Some(point));
        let crashed = change(&rig.ctx(), &staff_set("NoRun", RegData::Dword(1)));
        set_crash_point(None);
        assert!(matches!(crashed, Err(JournalError::Crashed)), "{point:?}");

        let restarted = rig.restarted();
        let ctx = JournalCtx { platform: rig.platform.as_ref(), shared: restarted.as_ref() };
        let report = startup_recover(&ctx);
        match point {
            CrashPoint::AfterPending => assert_eq!(report.dropped.len(), 1, "{point:?}: the change never happened"),
            CrashPoint::AfterWrite => assert_eq!(report.kept.len(), 1, "{point:?}: the change happened"),
            CrashPoint::AfterApplied => assert!(report.dropped.is_empty() && report.kept.is_empty(), "{point:?}"),
        }
        assert!(restore_all(&ctx).is_complete(), "{point:?}");
        assert_eq!(rig.staff_value(&sid, "NoRun"), Some(RegData::Dword(0)), "{point:?}");
        assert!(restarted.get().journal.is_empty(), "{point:?}");
    }
}

#[test]
fn a_staff_restore_with_no_account_left_has_nothing_to_put_back() {
    let rig = Rig::new();
    let sid = rig.with_staff();
    change(&rig.ctx(), &staff_set("NoRun", RegData::Dword(1))).unwrap();
    // The account is deleted (the hive goes with it) while the entry is still there.
    rig.platform.delete_staff_user(&sid, "RuleboxStaff").unwrap();
    assert!(restore_all(&rig.ctx()).is_complete());
    assert!(rig.shared.get().journal.is_empty());

    // And with the state forgetting the account first.
    let rig = Rig::new();
    rig.with_staff();
    change(&rig.ctx(), &staff_set("NoRun", RegData::Dword(1))).unwrap();
    rig.shared.update(|state| state.staff = None).unwrap();
    assert!(restore_all(&rig.ctx()).is_complete());
    assert!(rig.shared.get().journal.is_empty());
}

#[test]
fn a_staff_change_needs_the_account_and_stays_inside_the_roots() {
    let rig = Rig::new();
    // No account recorded: refused before anything is written.
    let error = change(&rig.ctx(), &staff_set("NoRun", RegData::Dword(1))).unwrap_err();
    assert!(matches!(error, JournalError::Platform(PlatformError::Other(_))), "{error:?}");
    assert!(rig.shared.get().journal.is_empty());

    // A key outside staffreg::ALLOWED_ROOTS is refused by the seam; the Pending entry is
    // left for the next start to drop (the value never changed).
    rig.with_staff();
    let outside = Change::staff(JournalOwner::L1, r"Software\Classes", "X", Some(RegData::Dword(1)));
    assert!(change(&rig.ctx(), &outside).is_err());
}
// ---------------------------------------------------------------- Phase 5 Step 14b: driver packages

#[test]
fn a_driver_package_entry_is_recorded_once_restored_by_name_and_spelled_on_disk() {
    let rig = Rig::new();
    rig.platform.with_world(|w| {
        w.driver_store.insert("oem4.inf".to_string());
    });
    rig.platform.add_program(r"C:\Windows\INF\oem4.inf", Default::default(), Some("aa"));
    let ctx = rig.ctx();
    record_driver_package(&ctx, "drv1", "OEM4.INF", "aa", 7).unwrap();
    record_driver_package(&ctx, "drv1", "oem4.inf", "aa", 8).unwrap();
    let entries = rig.shared.read(|s| s.journal.clone());
    assert_eq!(entries.len(), 1, "written once per id");
    assert_eq!(entries[0].id, "driver:drv1:oem4.inf");
    assert_eq!((entries[0].owner, entries[0].phase, &entries[0].original), (JournalOwner::Driver, EntryPhase::Applied, &OriginalValue::NotPresent));
    let text = serde_json::to_value(&entries[0]).unwrap();
    assert_eq!(text["owner"], "driver");
    assert_eq!(text["target"], json!({ "driverPackage": { "published": "oem4.inf", "sha256": "aa" } }));
    // Anything but a published name is refused.
    for bad in ["netcfg.inf", r"..\oem4.inf", "*", "oem4.inf /force"] {
        assert!(record_driver_package(&ctx, "drv1", bad, "aa", 1).is_err(), "{bad}");
    }
    // Start-up leaves an applied entry alone; a restore deletes the package.
    let startup = startup_recover(&ctx);
    assert!(startup.dropped.is_empty() && startup.restore.restored.is_empty());
    assert_eq!(rig.platform.with_world(|w| w.driver_deletes.len()), 0);
    let report = restore_all(&ctx);
    assert_eq!(report.restored, ["driver:drv1:oem4.inf"]);
    assert_eq!(rig.platform.with_world(|w| w.driver_deletes.clone()), ["oem4.inf"]);
    assert!(rig.shared.read(|s| s.journal.is_empty()));
}

#[test]
fn a_package_that_changed_or_vanished_is_not_deleted_by_a_restore() {
    for (store_has_it, sha) in [(false, Some("aa")), (true, Some("bb")), (true, None)] {
        let rig = Rig::new();
        rig.platform.with_world(|w| {
            if store_has_it {
                w.driver_store.insert("oem4.inf".to_string());
            }
        });
        if let Some(sha) = sha {
            rig.platform.add_program(r"C:\Windows\INF\oem4.inf", Default::default(), Some(sha));
        }
        record_driver_package(&rig.ctx(), "drv1", "oem4.inf", "aa", 1).unwrap();
        let report = restore_all(&rig.ctx());
        assert_eq!(report.restored.len(), 1, "forgotten, not failed");
        assert!(rig.platform.with_world(|w| w.driver_deletes.is_empty()), "store {store_has_it} sha {sha:?}");
    }
}

// ---------------------------------------------------------------- Phase 6 Step 15: the removal order (spike X-1)

const MODEL_A: &str = "BIXOLON SRP-350III";
const MODEL_B: &str = "BIXOLON SRP-330II";

/// A rig with the package `oem4.inf` in the fake store (it lists two models), journalled for `drv1`, and the spooler holding
/// the first model as a printer driver.
fn rig_with_a_registered_driver() -> Rig {
    let rig = Rig::new();
    rig.platform.with_world(|w| {
        w.driver_store.insert("oem4.inf".to_string());
        w.driver_models.insert("oem4.inf".to_string(), vec![MODEL_A.to_string(), MODEL_B.to_string()]);
        w.printer_drivers.push(MODEL_A.to_string());
    });
    rig.platform.add_program(r"C:\Windows\INF\oem4.inf", Default::default(), Some("aa"));
    record_driver_package(&rig.ctx(), "drv1", "oem4.inf", "aa", 1).unwrap();
    rig
}

fn add_queue(rig: &Rig, name: &str, driver: &str) {
    rig.platform.with_world(|w| {
        w.printers.push(crate::platform::sim::SimPrinter {
            info: crate::platform::PrinterInfo {
                name: name.into(),
                port: "FILE:".into(),
                driver: driver.into(),
                attributes: 64,
                comment: String::new(),
            },
            sddl: None,
        });
    });
}

fn events(rig: &Rig) -> Vec<String> {
    rig.platform.with_world(|w| w.driver_events.clone())
}

#[test]
fn a_driver_package_is_removed_after_its_queues_and_its_printer_drivers() {
    let rig = rig_with_a_registered_driver();
    add_queue(&rig, "Counter (Rulebox)", MODEL_A);
    add_queue(&rig, "Other printer", "Microsoft IPP Class Driver");
    let report = restore_all(&rig.ctx());
    assert!(report.is_complete(), "{:?}", report.failed);
    // The queue first, then the printer driver of the package, then the package (never the other way round: pnputil
    // refuses a package the spooler still holds a driver of).
    assert_eq!(events(&rig), ["queue:Counter (Rulebox)", format!("spooler-delete:{MODEL_A}").as_str(), "package:oem4.inf"]);
    rig.platform.with_world(|w| {
        assert!(w.driver_store.is_empty());
        assert!(!w.printer_drivers.iter().any(|d| d == MODEL_A));
        assert!(w.printers.iter().any(|p| p.info.name == "Other printer"), "a queue of another driver is left alone");
        assert!(w.printer_drivers.iter().any(|d| d == "Microsoft IPP Class Driver"), "inbox drivers stay");
    });
}

#[test]
fn a_package_the_spooler_does_not_hold_a_driver_of_is_removed_with_nothing_else_touched() {
    let rig = rig_with_a_registered_driver();
    rig.platform.with_world(|w| w.printer_drivers.retain(|d| d != MODEL_A));
    let report = restore_all(&rig.ctx());
    assert!(report.is_complete());
    assert_eq!(events(&rig), ["package:oem4.inf"]);
}

#[test]
fn a_queue_of_somebody_else_that_uses_the_driver_keeps_the_driver_and_the_package() {
    let rig = rig_with_a_registered_driver();
    // Not a ` (Rulebox)` queue: the agent never deletes it, so Windows keeps the driver (in use) and so must the package.
    add_queue(&rig, "Back office", MODEL_A);
    let report = restore_all(&rig.ctx());
    assert_eq!(report.failed.len(), 1, "a failed removal is reported, never forgotten");
    assert_eq!(events(&rig), Vec::<String>::new(), "pnputil is not even asked");
    rig.platform.with_world(|w| {
        assert!(w.driver_store.contains("oem4.inf") && w.printer_drivers.iter().any(|d| d == MODEL_A));
        assert!(w.printers.iter().any(|p| p.info.name == "Back office"));
    });
    assert_eq!(rig.shared.read(|s| s.journal.len()), 1, "the entry stays for the next try");
    // Once that queue is gone the next try goes through.
    rig.platform.with_world(|w| w.printers.clear());
    assert!(restore_all(&rig.ctx()).is_complete());
    assert_eq!(events(&rig), [format!("spooler-delete:{MODEL_A}").as_str(), "package:oem4.inf"]);
}

#[test]
fn the_sim_refuses_a_package_while_the_spooler_holds_a_driver_of_it_like_windows_does() {
    // The behaviour the removal order exists for (spike X-1): without the release, pnputil fails.
    let rig = rig_with_a_registered_driver();
    assert!(rig.platform.driver_package_delete("oem4.inf").is_err());
    assert!(rig.platform.with_world(|w| w.driver_store.contains("oem4.inf")));
    rig.platform.printer_driver_delete(MODEL_A).unwrap();
    rig.platform.driver_package_delete("oem4.inf").unwrap();
}

#[test]
fn a_publisher_certificate_rulebox_trusted_is_removed_again_by_a_restore() {
    let rig = Rig::new();
    let cert = crate::platform::sim::test_cert("CN=Seagull Software, LLC", 0xab);
    let ctx = rig.ctx();
    record_driver_trust(&ctx, &cert.sha1, 3).unwrap();
    record_driver_trust(&ctx, &cert.sha1.to_ascii_uppercase(), 4).unwrap();
    rig.platform.trusted_publisher_add(&cert.der).unwrap();
    let entries = rig.shared.read(|s| s.journal.clone());
    assert_eq!(entries.len(), 1, "one entry per certificate");
    assert_eq!(entries[0].id, driver_trust_id(&cert.sha1));
    assert!(has_entry(&ctx, &driver_trust_id(&cert.sha1)) && !has_entry(&ctx, &driver_trust_id(&"cd".repeat(20))));
    assert_eq!(serde_json::to_value(&entries[0]).unwrap()["target"], json!({ "trustedPublisher": { "thumbprint": cert.sha1 } }));
    // An applied entry is left alone at start-up; a restore takes the certificate out.
    let startup = startup_recover(&ctx);
    assert!(startup.dropped.is_empty() && startup.restore.restored.is_empty());
    assert!(rig.platform.trusted_publisher_has(&cert.sha1).unwrap());
    assert!(restore_all(&ctx).is_complete());
    assert!(!rig.platform.trusted_publisher_has(&cert.sha1).unwrap());
    assert!(rig.shared.read(|s| s.journal.is_empty()));
    // Anything but a SHA-1 thumbprint is refused before anything is written.
    for bad in [String::new(), "ab".to_string(), "g".repeat(40), "ab".repeat(32)] {
        assert!(record_driver_trust(&ctx, &bad, 1).is_err(), "{bad}");
    }
    assert!(rig.shared.read(|s| s.journal.is_empty()));
}

#[test]
fn a_pending_driver_entry_is_never_settled_by_a_guess() {
    let rig = Rig::new();
    rig.shared
        .update(|state| {
            state.journal.push(JournalEntry {
                id: "driver:d:oem4.inf".into(),
                owner: JournalOwner::Driver,
                target: JournalTarget::DriverPackage { published: "oem4.inf".into(), sha256: "aa".into() },
                original: OriginalValue::NotPresent,
                phase: EntryPhase::Pending,
                since_version: 0,
                recorded_at_ms: 0,
                last_error: None,
            });
        })
        .unwrap();
    let report = startup_recover(&rig.ctx());
    assert!(report.dropped.is_empty() && report.kept.is_empty());
    assert_eq!(rig.shared.read(|s| s.journal[0].phase), EntryPhase::Pending, "left exactly as it is");
    assert!(rig.platform.with_world(|w| w.driver_deletes.is_empty()));
}
