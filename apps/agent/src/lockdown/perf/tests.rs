//! Tests of Step 18 (per-user tuning and the kiosk performance profile): what is written,
//! that every original comes back exactly (start types, values, start-up entries), the
//! Spooler rule, and that no list names Defender, Windows Update or a recovery service.
//! All against `SimPlatform`; nothing touches the machine.

use std::sync::Arc;

use rulebox_policy::lockdown::{LockdownPolicy, PerformancePolicy};
use rulebox_policy::AgentDoc;
use rulebox_win32::{machinereg, service, staffreg};

use super::*;
use crate::journal::{EntryPhase, JournalCtx, OriginalValue};
use crate::lockdown::invariants::Facts;
use crate::lockdown::LayerStatus;
use crate::platform::sim::{SimOp, SimPlatform, SimService};
use crate::platform::{Platform, PlatformError, StaffUserSpec};
use crate::state::{AgentState, SharedState, StaffAccount, StateStore};
use crate::testutil::TempDir;

struct Rig {
    _dir: TempDir,
    platform: Arc<SimPlatform>,
    shared: Arc<SharedState>,
    sid: String,
    base_calls: usize,
}

impl Rig {
    fn new() -> Self {
        Self::build(true)
    }

    fn build(with_staff: bool) -> Self {
        let dir = TempDir::new();
        let platform = Arc::new(SimPlatform::new(dir.path().to_path_buf()));
        let spec = StaffUserSpec { user_name: "RuleboxStaff".into(), full_name: "Staff".into(), comment: "c".into() };
        let sid = platform.create_staff_user(&spec, "pw").unwrap();
        // The real key rule: a write outside `machinereg::ALLOWED_ROOTS` fails here.
        platform.with_world(|world| world.strict_machine_keys = true);
        let state = AgentState {
            staff: with_staff.then(|| StaffAccount { sid: sid.clone(), user_name: "RuleboxStaff".into(), profile_dir: None }),
            ..AgentState::default()
        };
        let dyn_platform: Arc<dyn Platform> = platform.clone();
        let shared = SharedState::new(StateStore::open(&dir.path().join("state")).unwrap(), state, dyn_platform);
        let base_calls = platform.calls().iter().filter(|op| op.is_mutating()).count();
        Self { _dir: dir, platform, shared, sid, base_calls }
    }

    fn ctx(&self) -> ApplyCtx<'_> {
        ApplyCtx {
            journal: JournalCtx { platform: self.platform.as_ref(), shared: self.shared.as_ref() },
            facts: Facts::default(),
            now_ms: 1_000,
            version: 7,
        }
    }

    fn apply(&self, doc: &AgentDoc) -> LayerState {
        apply(&self.ctx(), doc)
    }

    fn add_service(&self, name: &str, start: u32) {
        self.platform.with_world(|world| {
            world.services.insert(name.to_string(), SimService { start, sddl: "D:".into(), privileges: Vec::new() });
        });
    }

    fn start_of(&self, name: &str) -> Option<u32> {
        self.platform.query_service(name).unwrap().map(|config| config.start)
    }

    fn staff_value(&self, path: &str, name: &str) -> Option<RegData> {
        self.platform.read_staff_value(&self.sid, path, name).unwrap()
    }

    fn set_staff(&self, path: &str, name: &str, data: RegData) {
        self.platform.write_staff_value(&self.sid, path, name, &data).unwrap();
    }

    fn machine(&self, path: &str, name: &str) -> Option<RegData> {
        self.platform.read_machine_value(&RegValueRef { path: path.into(), name: name.into() }).unwrap()
    }

    fn set_machine(&self, path: &str, name: &str, value: u32) {
        let key = RegValueRef { path: path.into(), name: name.into() };
        self.platform.with_world(|world| world.machine_values.insert(key, RegData::Dword(value)));
    }

    fn mutating_calls(&self) -> usize {
        self.platform.calls().iter().filter(|op| op.is_mutating()).count() - self.base_calls
    }

    fn journal_ids(&self) -> Vec<String> {
        self.shared.read(|state| state.journal.iter().map(|entry| entry.id.clone()).collect())
    }

    fn original(&self, id: &str) -> Option<OriginalValue> {
        self.shared.read(|state| state.journal.iter().find(|entry| entry.id == id).map(|entry| entry.original.clone()))
    }
}

fn doc(staff_tuning: bool, kiosk_profile: bool, no_printing: bool) -> AgentDoc {
    AgentDoc {
        lockdown: Some(LockdownPolicy {
            performance: PerformancePolicy { staff_tuning, kiosk_profile, no_printing },
            ..LockdownPolicy::default()
        }),
        ..AgentDoc::default()
    }
}

fn with_printer(mut doc: AgentDoc) -> AgentDoc {
    let printers = serde_json::json!({ "printers": [{
        "id": "p1", "name": "Front desk", "kind": "ipp", "address": "10.0.0.20", "driver": "Microsoft IPP Class Driver",
        "isDefault": false, "revision": 1
    }] });
    doc.printers = AgentDoc::from_doc(&printers).map(|parsed| parsed.printers).unwrap_or_default();
    assert!(!doc.printers.is_empty(), "the test printer must parse");
    doc
}

const DC: &str = machinereg::DATA_COLLECTION;
const DO: &str = machinereg::DELIVERY_OPTIMIZATION;

// ---------------------------------------------------------------- the lists

#[test]
fn nothing_names_defender_windows_update_or_a_recovery_service() {
    let touched: Vec<&str> = KIOSK_SERVICES.iter().copied().chain([SPOOLER]).collect();
    for name in &touched {
        assert!(
            !NEVER_TOUCH_SERVICES.iter().any(|never| never.eq_ignore_ascii_case(name)),
            "{name} must never be touched"
        );
        assert!(profile_service(name), "{name}");
        // The start-type rule of the seam accepts it.
        assert!(service::check_start(name, service::START_DISABLED).is_ok(), "{name}");
    }
    // The service list is exactly the one of PRD 22.3.
    assert_eq!(touched, ["WSearch", "SysMain", "XblAuthManager", "XblGameSave", "XboxNetApiSvc", "XboxGipSvc", "Spooler"]);
    for must in ["WinDefend", "WdNisSvc", "Sense", "wuauserv", "UsoSvc", "WaaSMedicSvc", "BITS", "DoSvc", "RpcSs", "EventLog", "WinRM", "RuleboxAgent"] {
        assert!(NEVER_TOUCH_SERVICES.contains(&must), "{must}");
        assert!(!profile_service(must), "{must}");
        assert!(!profile_service(&must.to_ascii_uppercase()), "{must}");
    }
    assert!(!profile_service("SomethingElse"));
}

#[test]
fn a_service_outside_the_profile_is_refused_before_any_call() {
    let rig = Rig::new();
    rig.add_service("WinDefend", 2);
    let mut tally = Tally::default();
    for name in ["WinDefend", "wuauserv", "EventLog"] {
        disable_service(&rig.ctx(), name, &mut tally);
    }
    assert_eq!(tally.first_error, Some("service_not_in_profile"));
    assert!(!rig.platform.calls().contains(&SimOp::QueryService));
    assert_eq!(rig.mutating_calls(), 0);
    assert_eq!(rig.start_of("WinDefend"), Some(2));
}

#[test]
fn every_staff_row_is_inside_the_staff_roots_and_no_machine_key_is_outside_its_roots() {
    for row in tuning_rows() {
        assert!(staffreg::check_write(row.path, row.name).is_ok(), "{}\\{}", row.path, row.name);
    }
    assert!(staffreg::check_write(RUN, "OneDrive").is_ok());
    let value = rulebox_win32::registry::RegValue::Dword(0);
    assert!(machinereg::check_write(DC, ALLOW_TELEMETRY, Some(&value)).is_ok());
    assert!(machinereg::check_write(DO, DO_DOWNLOAD_MODE, Some(&value)).is_ok());
    // No row twice, and none that L1 writes (two owners of one value would fight on restore).
    let mut ids: Vec<String> = tuning_rows().map(|row| journal::staff_id(row.path, row.name)).collect();
    let l1: Vec<String> = crate::lockdown::staff::STAFF_ITEMS
        .iter()
        .flat_map(|item| item.rows.iter())
        .map(crate::lockdown::staff::row_id)
        .collect();
    assert!(ids.iter().all(|id| !l1.contains(id)));
    let before = ids.len();
    ids.sort();
    ids.dedup();
    assert_eq!(ids.len(), before);
    // Every line of PRD 22.2 that is a registry value has an item.
    let keys: Vec<&str> = STAFF_TUNING.iter().map(|item| item.key).collect();
    assert_eq!(keys, ["backgroundApps", "widgets", "copilot", "tips", "visualEffects"]);
}

#[test]
fn the_telemetry_floor_follows_the_edition() {
    for edition in ["Enterprise", "EnterpriseS", "Education", "IoTEnterprise", "IoTEnterpriseS", "ServerStandard"] {
        assert_eq!(telemetry_floor(edition), 0, "{edition}");
    }
    for edition in ["Professional", "ProfessionalEducation", "ProfessionalWorkstation", "Core", "CoreSingleLanguage", ""] {
        assert_eq!(telemetry_floor(edition), 1, "{edition}");
    }
}

// ---------------------------------------------------------------- the kiosk profile

#[test]
fn each_service_gets_disabled_and_its_original_start_type_comes_back_exactly() {
    let rig = Rig::new();
    // SimPlatform has WSearch and SysMain as automatic; the Xbox ones differ per PC.
    rig.add_service("XblAuthManager", 3);
    rig.add_service("XblGameSave", 3);
    rig.add_service("XboxNetApiSvc", 4); // already disabled by the owner
    // XboxGipSvc does not exist on this PC.
    let state = rig.apply(&doc(false, true, false));
    assert_eq!((state.mode, state.state, state.detail), (ReportedMode::On, LayerStatus::Ok, None));

    for name in ["WSearch", "SysMain", "XblAuthManager", "XblGameSave", "XboxNetApiSvc"] {
        assert_eq!(rig.start_of(name), Some(4), "{name}");
    }
    assert_eq!(rig.start_of("XboxGipSvc"), None);
    assert_eq!(rig.start_of(SPOOLER), Some(2), "no `noPrinting`: the Spooler is not touched");
    assert_eq!(rig.original("svc-start:WSearch"), Some(OriginalValue::ServiceStart(2)));
    assert_eq!(rig.original("svc-start:XblAuthManager"), Some(OriginalValue::ServiceStart(3)));
    // A service that was already disabled is not Rulebox's to restore.
    assert_eq!(rig.original("svc-start:XboxNetApiSvc"), None);
    assert_eq!(rig.original("svc-start:XboxGipSvc"), None);
    rig.shared.read(|state| {
        for entry in &state.journal {
            assert_eq!((entry.owner, entry.phase, entry.since_version), (JournalOwner::Perf, EntryPhase::Applied, 7), "{}", entry.id);
        }
    });

    // A second run writes nothing.
    let calls = rig.mutating_calls();
    let journal = rig.journal_ids();
    assert_eq!(rig.apply(&doc(false, true, false)).state, LayerStatus::Ok);
    assert_eq!((rig.mutating_calls(), rig.journal_ids()), (calls, journal));

    // "Disable kiosk" restores the whole journal.
    let report = journal::restore_all(&rig.ctx().journal);
    assert!(report.is_complete(), "{:?}", report.failed);
    assert_eq!(rig.start_of("WSearch"), Some(2));
    assert_eq!(rig.start_of("SysMain"), Some(2));
    assert_eq!(rig.start_of("XblAuthManager"), Some(3));
    assert_eq!(rig.start_of("XblGameSave"), Some(3));
    assert_eq!(rig.start_of("XboxNetApiSvc"), Some(4), "what the owner disabled stays disabled");
    assert!(rig.journal_ids().is_empty());
}

#[test]
fn the_spooler_is_disabled_only_with_no_printing_and_no_printers() {
    // noPrinting and no printers: disabled, original kept.
    let rig = Rig::new();
    assert!(spooler_disabled(&doc(false, true, true)));
    assert_eq!(rig.apply(&doc(false, true, true)).detail, None);
    assert_eq!(rig.start_of(SPOOLER), Some(4));
    assert_eq!(rig.original("svc-start:Spooler"), Some(OriginalValue::ServiceStart(2)));

    // A printer is assigned later: the Spooler comes back and the layer says why (edge case 39).
    let with = with_printer(doc(false, true, true));
    assert!(!spooler_disabled(&with));
    let state = rig.apply(&with);
    assert_eq!((state.state, state.detail.as_deref()), (LayerStatus::Ok, Some("no_printing_ignored")));
    assert_eq!(rig.start_of(SPOOLER), Some(2));
    assert_eq!(rig.original("svc-start:Spooler"), None);
    assert_eq!(rig.start_of("WSearch"), Some(4), "the rest of the profile stays");

    // noPrinting off: never touched. The kiosk profile off: never touched either.
    for document in [doc(false, true, false), doc(false, false, true), with_printer(doc(true, true, false))] {
        let rig = Rig::new();
        assert!(!spooler_disabled(&document));
        rig.apply(&document);
        assert_eq!(rig.start_of(SPOOLER), Some(2));
        assert_eq!(rig.original("svc-start:Spooler"), None);
    }

    // A manual Spooler goes back to manual, not to automatic.
    let rig = Rig::new();
    rig.add_service(SPOOLER, 3);
    rig.apply(&doc(false, true, true));
    assert_eq!(rig.start_of(SPOOLER), Some(4));
    rig.apply(&doc(false, true, false));
    assert_eq!(rig.start_of(SPOOLER), Some(3));
}

#[test]
fn diagnostic_data_and_delivery_optimization_are_set_and_restored() {
    // Nothing set before: both written, restore deletes them.
    let rig = Rig::new();
    rig.apply(&doc(false, true, false));
    assert_eq!(rig.machine(DC, ALLOW_TELEMETRY), Some(RegData::Dword(1)), "Pro: required data only");
    assert_eq!(rig.machine(DO, DO_DOWNLOAD_MODE), Some(RegData::Dword(0)));
    assert!(journal::restore_all(&rig.ctx().journal).is_complete());
    assert_eq!(rig.machine(DC, ALLOW_TELEMETRY), None);
    assert_eq!(rig.machine(DO, DO_DOWNLOAD_MODE), None);

    // Enterprise: off is allowed. The owner's own values come back exactly.
    let rig = Rig::new();
    rig.platform.with_world(|world| world.os.edition_id = "Enterprise".into());
    rig.set_machine(DC, ALLOW_TELEMETRY, 3);
    rig.set_machine(DO, DO_DOWNLOAD_MODE, 1);
    rig.apply(&doc(false, true, false));
    assert_eq!(rig.machine(DC, ALLOW_TELEMETRY), Some(RegData::Dword(0)));
    assert_eq!(rig.machine(DO, DO_DOWNLOAD_MODE), Some(RegData::Dword(0)));
    // The profile switched off by the document: back to 3 and 1.
    let state = rig.apply(&doc(false, false, false));
    assert_eq!((state.mode, state.state), (ReportedMode::Off, LayerStatus::Ok));
    assert_eq!(rig.machine(DC, ALLOW_TELEMETRY), Some(RegData::Dword(3)));
    assert_eq!(rig.machine(DO, DO_DOWNLOAD_MODE), Some(RegData::Dword(1)));
    assert!(rig.journal_ids().is_empty());

    // Values that are already as strict are left alone and not journalled.
    let rig = Rig::new();
    rig.set_machine(DC, ALLOW_TELEMETRY, 0);
    rig.set_machine(DO, DO_DOWNLOAD_MODE, 99);
    rig.apply(&doc(false, true, false));
    assert_eq!(rig.machine(DC, ALLOW_TELEMETRY), Some(RegData::Dword(0)));
    assert_eq!(rig.machine(DO, DO_DOWNLOAD_MODE), Some(RegData::Dword(99)));
    assert!(rig.journal_ids().iter().all(|id| id.starts_with("svc-start:")), "{:?}", rig.journal_ids());
}

#[test]
fn a_failing_service_makes_the_layer_partial_and_the_rest_still_applies() {
    let rig = Rig::new();
    rig.platform.fail_next(SimOp::SetServiceStart, PlatformError::AccessDenied);
    let state = rig.apply(&doc(false, true, false));
    assert_eq!((state.state, state.detail.as_deref()), (LayerStatus::Partial, Some("access_denied")));
    assert_eq!(rig.start_of("WSearch"), Some(2));
    assert_eq!(rig.start_of("SysMain"), Some(4));
    // The next run finishes the job.
    assert_eq!(rig.apply(&doc(false, true, false)).state, LayerStatus::Ok);
    assert_eq!(rig.start_of("WSearch"), Some(4));
    assert_eq!(rig.original("svc-start:WSearch"), Some(OriginalValue::ServiceStart(2)));
}

// ---------------------------------------------------------------- Staff tuning

#[test]
fn staff_tuning_writes_only_the_staff_hive_and_restores_every_original() {
    let rig = Rig::new();
    // Two values the owner had set, one text, one number.
    rig.set_staff(WINDOW_METRICS, "MinAnimate", RegData::String("1".into()));
    rig.set_staff(ADVANCED, "TaskbarAnimations", RegData::Dword(1));
    let before = rig.mutating_calls();

    let state = rig.apply(&doc(true, false, false));
    assert_eq!((state.mode, state.state, state.detail), (ReportedMode::On, LayerStatus::Ok, None));
    for row in tuning_rows() {
        let expected = match row.value {
            TuningValue::Dword(value) => RegData::Dword(value),
            TuningValue::Text(text) => RegData::String(text.into()),
        };
        assert_eq!(rig.staff_value(row.path, row.name), Some(expected), "{}", row.name);
    }
    // Only Staff hive writes: no machine value, no service.
    let ops: Vec<SimOp> = rig.platform.calls().into_iter().filter(|op| op.is_mutating()).skip(rig.base_calls + before).collect();
    assert!(!ops.is_empty() && ops.iter().all(|op| *op == SimOp::WriteStaffValue), "{ops:?}");
    assert_eq!(rig.start_of("WSearch"), Some(2));
    assert_eq!(rig.machine(DC, ALLOW_TELEMETRY), None);
    assert_eq!(
        rig.original(&journal::staff_id(WINDOW_METRICS, "MinAnimate")),
        Some(OriginalValue::String("1".into()))
    );
    assert_eq!(rig.original(&journal::staff_id(ADVANCED, "TaskbarAnimations")), Some(OriginalValue::Dword(1)));
    assert_eq!(rig.original(&journal::staff_id(BACKGROUND_APPS, "GlobalUserDisabled")), Some(OriginalValue::Absent));

    // A second run writes nothing.
    let calls = rig.mutating_calls();
    rig.apply(&doc(true, false, false));
    assert_eq!(rig.mutating_calls(), calls);

    // Switched off by the document: everything is as it was.
    let state = rig.apply(&doc(false, false, false));
    assert_eq!((state.mode, state.state), (ReportedMode::Off, LayerStatus::Ok));
    assert_eq!(rig.staff_value(WINDOW_METRICS, "MinAnimate"), Some(RegData::String("1".into())));
    assert_eq!(rig.staff_value(ADVANCED, "TaskbarAnimations"), Some(RegData::Dword(1)));
    assert_eq!(rig.staff_value(BACKGROUND_APPS, "GlobalUserDisabled"), None);
    assert_eq!(rig.staff_value(COPILOT, "TurnOffWindowsCopilot"), None);
    assert!(rig.journal_ids().is_empty());
    assert_eq!(rig.platform.with_world(|world| world.staff_values.len()), 2);
}

#[test]
fn startup_entries_are_removed_and_come_back_with_their_command_lines() {
    let rig = Rig::new();
    rig.set_staff(RUN, "onedrive", RegData::String(r#""C:\Program Files\Microsoft OneDrive\OneDrive.exe" /background"#.into()));
    rig.set_staff(RUN, "teams", RegData::String("teams.exe --autostart".into()));
    // An entry that is not text cannot be put back exactly: it stays.
    rig.set_staff(RUN, "odd", RegData::Dword(5));

    let state = rig.apply(&doc(true, false, false));
    assert_eq!((state.state, state.detail.as_deref()), (LayerStatus::Ok, Some("startup_entry_kept")));
    assert_eq!(rig.staff_value(RUN, "onedrive"), None);
    assert_eq!(rig.staff_value(RUN, "teams"), None);
    assert_eq!(rig.staff_value(RUN, "odd"), Some(RegData::Dword(5)));
    assert_eq!(
        rig.original(&journal::staff_id(RUN, "teams")),
        Some(OriginalValue::String("teams.exe --autostart".into()))
    );

    // An app adds itself again later: removed again, and the first original is kept.
    rig.set_staff(RUN, "teams", RegData::String("teams.exe --other".into()));
    rig.set_staff(RUN, "edgeautolaunch_ab12", RegData::String("msedge.exe --no-startup-window".into()));
    rig.apply(&doc(true, false, false));
    assert_eq!(rig.staff_value(RUN, "teams"), None);
    assert_eq!(rig.staff_value(RUN, "edgeautolaunch_ab12"), None);
    assert_eq!(
        rig.original(&journal::staff_id(RUN, "teams")),
        Some(OriginalValue::String("teams.exe --autostart".into()))
    );

    // "Disable kiosk": every entry is back.
    assert!(journal::restore_all(&rig.ctx().journal).is_complete());
    assert_eq!(
        rig.staff_value(RUN, "onedrive"),
        Some(RegData::String(r#""C:\Program Files\Microsoft OneDrive\OneDrive.exe" /background"#.into()))
    );
    assert_eq!(rig.staff_value(RUN, "teams"), Some(RegData::String("teams.exe --autostart".into())));
    assert_eq!(rig.staff_value(RUN, "edgeautolaunch_ab12"), Some(RegData::String("msedge.exe --no-startup-window".into())));
    assert_eq!(rig.staff_value(RUN, "odd"), Some(RegData::Dword(5)));
    assert!(rig.journal_ids().is_empty());
}

#[test]
fn the_number_of_startup_entries_removed_in_one_apply_is_bounded() {
    let rig = Rig::new();
    for n in 0..MAX_STARTUP_ENTRIES + 6 {
        rig.set_staff(RUN, &format!("app{n:03}"), RegData::String("x.exe".into()));
    }
    let state = rig.apply(&doc(true, false, false));
    assert_eq!((state.state, state.detail.as_deref()), (LayerStatus::Ok, Some("startup_entries_capped")));
    assert_eq!(rig.platform.list_staff_value_names(&rig.sid, RUN).unwrap().len(), 6);
    // The next apply takes the rest.
    assert_eq!(rig.apply(&doc(true, false, false)).detail, None);
    assert!(rig.platform.list_staff_value_names(&rig.sid, RUN).unwrap().is_empty());
}

#[test]
fn a_protected_taskbar_value_is_a_note_and_any_other_refusal_is_a_failure() {
    // `TaskbarDa` is the second row written (after `GlobalUserDisabled`).
    let rig = Rig::new();
    rig.platform.fail_nth(SimOp::WriteStaffValue, 1, PlatformError::AccessDenied);
    let state = rig.apply(&doc(true, false, false));
    assert_eq!((state.state, state.detail.as_deref()), (LayerStatus::Ok, Some("tuning_value_protected")));
    assert_eq!(rig.staff_value(ADVANCED, "TaskbarDa"), None);
    assert_eq!(rig.original(&journal::staff_id(ADVANCED, "TaskbarDa")), None, "nothing was written: nothing to restore");

    let rig = Rig::new();
    rig.platform.fail_next(SimOp::WriteStaffValue, PlatformError::AccessDenied);
    let state = rig.apply(&doc(true, false, false));
    assert_eq!((state.state, state.detail.as_deref()), (LayerStatus::Partial, Some("access_denied")));
}

#[test]
fn without_a_staff_account_the_tuning_fails_and_the_profile_still_applies() {
    let rig = Rig::build(false);
    let state = rig.apply(&doc(true, true, false));
    assert_eq!((state.state, state.detail.as_deref()), (LayerStatus::Partial, Some("no_staff_account")));
    assert_eq!(rig.start_of("WSearch"), Some(4));
    assert!(!rig.platform.calls().contains(&SimOp::WriteStaffValue));

    let rig = Rig::build(false);
    let state = rig.apply(&doc(true, false, false));
    assert_eq!((state.state, state.detail.as_deref()), (LayerStatus::Failed, Some("no_staff_account")));
    assert_eq!(rig.mutating_calls(), 0);
}

#[test]
fn an_unreadable_run_key_is_reported_and_nothing_is_deleted() {
    let rig = Rig::new();
    rig.set_staff(RUN, "onedrive", RegData::String("onedrive.exe".into()));
    rig.platform.fail_next(SimOp::ListStaffValueNames, PlatformError::Guard("not a test machine".into()));
    let state = rig.apply(&doc(true, false, false));
    assert_eq!((state.state, state.detail.as_deref()), (LayerStatus::Partial, Some("startup_entries_unreadable")));
    assert_eq!(rig.staff_value(RUN, "onedrive"), Some(RegData::String("onedrive.exe".into())));
    assert!(!SimOp::ListStaffValueNames.is_mutating());
}

// ---------------------------------------------------------------- the whole layer

#[test]
fn no_lockdown_section_means_off_and_everything_restored() {
    let rig = Rig::new();
    rig.set_staff(RUN, "onedrive", RegData::String("onedrive.exe".into()));
    // Nothing applied yet: nothing is written.
    let state = rig.apply(&AgentDoc::default());
    assert_eq!(state, LayerState::off_ok());
    assert_eq!(rig.mutating_calls(), 1, "only the test's own write");

    // The defaults of a `lockdown` section: tuning and profile on, the Spooler kept.
    let on = AgentDoc { lockdown: Some(LockdownPolicy::default()), ..AgentDoc::default() };
    let state = rig.apply(&on);
    assert_eq!((state.mode, state.state, state.detail), (ReportedMode::On, LayerStatus::Ok, None));
    assert_eq!(rig.start_of("SysMain"), Some(4));
    assert_eq!(rig.start_of(SPOOLER), Some(2));
    assert_eq!(rig.staff_value(RUN, "onedrive"), None);
    assert!(!rig.journal_ids().is_empty());

    // The section removed again: all of it is back.
    let state = rig.apply(&AgentDoc::default());
    assert_eq!(state, LayerState::off_ok());
    assert_eq!(rig.start_of("SysMain"), Some(2));
    assert_eq!(rig.start_of("WSearch"), Some(2));
    assert_eq!(rig.machine(DC, ALLOW_TELEMETRY), None);
    assert_eq!(rig.machine(DO, DO_DOWNLOAD_MODE), None);
    assert_eq!(rig.staff_value(RUN, "onedrive"), Some(RegData::String("onedrive.exe".into())));
    assert_eq!(rig.platform.with_world(|world| world.staff_values.len()), 1);
    assert!(rig.journal_ids().is_empty());
}

#[test]
fn the_layer_restores_only_its_own_entries() {
    let rig = Rig::new();
    // L3 owns `AppIDSvc`; an L1 value sits in the Staff hive.
    let l3 = Change::service_start(JournalOwner::L3, "AppIDSvc", 2).since(7);
    journal::change(&rig.ctx().journal, &l3).unwrap();
    let l1 = Change::staff(JournalOwner::L1, r"Software\Microsoft\Windows\CurrentVersion\Policies\Explorer", "NoRun", Some(RegData::Dword(1))).since(7);
    journal::change(&rig.ctx().journal, &l1).unwrap();
    rig.apply(&doc(true, true, true));
    rig.apply(&AgentDoc::default());
    assert_eq!(rig.start_of("AppIDSvc"), Some(2), "another layer's service stays as that layer set it");
    assert_eq!(rig.journal_ids(), [l3.id.clone(), l1.id.clone()]);
}

#[test]
fn the_apply_transaction_runs_the_layer_last_and_reports_it() {
    use crate::lockdown::apply::{apply as apply_all, state_of, Layer, APPLY_ORDER};
    assert_eq!(APPLY_ORDER.last(), Some(&Layer::Performance));
    let rig = Rig::new();
    // `hideAdminTiles` needs a fact this rig does not have (invariant I7); the rest is the default.
    let mut policy = LockdownPolicy::default();
    policy.machine.hide_admin_tiles = false;
    let on = AgentDoc { lockdown: Some(policy), ..AgentDoc::default() };
    let outcome = apply_all(&rig.ctx(), &on).unwrap();
    assert_eq!((outcome.layers.performance.mode, outcome.layers.performance.state), (ReportedMode::On, LayerStatus::Ok));
    assert_eq!(rig.start_of("WSearch"), Some(4));
    let json = serde_json::to_value(&outcome.layers).unwrap();
    assert_eq!(json["performance"], serde_json::json!({ "mode": "on", "state": "ok" }));
    // A failed performance layer makes the report `failed` like any other layer.
    let mut layers = outcome.layers.clone();
    layers.performance.state = LayerStatus::Failed;
    assert_eq!(state_of(&layers), crate::backend::reports::ApplyState::Failed);
}
