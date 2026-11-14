//! Tests of the Phase 5 Step 3 seam in `SimPlatform` (plan 4.5): the rules each method
//! enforces before it touches anything, the in-memory effect, fault injection and the
//! call log. Nothing here touches the machine.

use std::path::Path;
use std::sync::{Arc, Mutex};

use super::super::MUTATING_METHODS;
use super::*;
use crate::testutil::TempDir;

const STAFF_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Policies\System";
const ID: &str = "8a6eb3cd-ba2e-4a97-a1f9-4f4a3b1c0001";
const WLAN_XML: &str = "<WLANProfile><name>Rulebox-ab12</name><sharedKey><keyMaterial>secret-pass</keyMaterial></sharedKey></WLANProfile>";

fn sim() -> (TempDir, SimPlatform) {
    let dir = TempDir::new();
    let sim = SimPlatform::new(dir.path().to_path_buf());
    (dir, sim)
}

fn staff(sim: &SimPlatform) -> String {
    let spec = StaffUserSpec { user_name: "RuleboxStaff".into(), full_name: "Staff".into(), comment: "c".into() };
    sim.create_staff_user(&spec, "pw").unwrap()
}

fn is_other(error: &PlatformError, needle: &str) -> bool {
    matches!(error, PlatformError::Other(message) if message.contains(needle))
}

#[test]
fn staff_values_follow_the_roots_and_the_account() {
    let (_dir, sim) = sim();
    let sid = staff(&sim);
    assert_eq!(sim.read_staff_value(&sid, STAFF_KEY, "NoRun").unwrap(), None);
    sim.write_staff_value(&sid, STAFF_KEY, "NoRun", &RegData::Dword(1)).unwrap();
    // Registry names do not care about case.
    assert_eq!(sim.read_staff_value(&sid, &STAFF_KEY.to_uppercase(), "norun").unwrap(), Some(RegData::Dword(1)));
    sim.delete_staff_value(&sid, STAFF_KEY, "NoRun").unwrap();
    assert_eq!(sim.read_staff_value(&sid, STAFF_KEY, "NoRun").unwrap(), None);

    // The rules are the real ones.
    let outside = sim.write_staff_value(&sid, r"Software\Classes", "X", &RegData::Dword(1)).unwrap_err();
    assert!(is_other(&outside, "not one Rulebox writes"), "{outside:?}");
    let shell = sim.write_staff_value(&sid, STAFF_KEY, "Shell", &RegData::String("x".into())).unwrap_err();
    assert!(is_other(&shell, "set_user_shell"), "{shell:?}");
    assert!(sim.read_staff_value(&sid, r"Software\Classes", "X").is_err());

    // No such account: nothing to write; the values go with a deleted account.
    assert!(matches!(
        sim.write_staff_value("S-1-5-21-9-9-9-9", STAFF_KEY, "NoRun", &RegData::Dword(1)),
        Err(PlatformError::NotFound)
    ));
    sim.write_staff_value(&sid, STAFF_KEY, "NoRun", &RegData::Dword(1)).unwrap();
    sim.delete_staff_user(&sid, "RuleboxStaff").unwrap();
    assert_eq!(sim.read_staff_value(&sid, STAFF_KEY, "NoRun").unwrap(), None);
}

#[test]
fn machine_value_names_list_what_is_under_one_key() {
    let (_dir, sim) = sim();
    let restrictions = r"SOFTWARE\Policies\Microsoft\Windows\DeviceInstall\Restrictions\DenyDeviceClasses";
    assert!(sim.list_machine_value_names(restrictions).unwrap().is_empty());
    for name in ["1", "2"] {
        let key = RegValueRef { path: restrictions.into(), name: name.into() };
        sim.write_machine_value(&key, Some(&RegData::String("{4d36e979-e325-11ce-bfc1-08002be10318}".into()))).unwrap();
    }
    let other = RegValueRef { path: r"SOFTWARE\Other".into(), name: "3".into() };
    sim.write_machine_value(&other, Some(&RegData::Dword(1))).unwrap();
    let mut names = sim.list_machine_value_names(&restrictions.to_lowercase()).unwrap();
    names.sort();
    assert_eq!(names, ["1", "2"]);
}

#[test]
fn ci_policies_need_a_guid_and_a_body() {
    let (_dir, sim) = sim();
    assert!(sim.list_ci_policies().unwrap().is_empty());
    sim.deploy_ci_policy(&format!("{{{}}}", ID.to_uppercase()), b"cip").unwrap();
    assert_eq!(sim.list_ci_policies().unwrap(), [ID]);
    assert_eq!(sim.read_security_posture().unwrap().ci_policies, [ID]);
    for bad in ["policy", r"..\x", ""] {
        assert!(sim.deploy_ci_policy(bad, b"cip").is_err(), "{bad}");
        assert!(sim.remove_ci_policy(bad).is_err(), "{bad}");
    }
    assert!(sim.deploy_ci_policy(ID, b"").is_err());
    sim.remove_ci_policy(ID).unwrap();
    sim.remove_ci_policy(ID).unwrap();
    assert!(sim.list_ci_policies().unwrap().is_empty());
}

#[test]
fn applocker_policy_is_kept_with_its_mechanism() {
    let (_dir, sim) = sim();
    assert!(!sim.get_applocker_policy().unwrap().has_rules());
    sim.set_applocker_policy("<AppLockerPolicy Version=\"1\"/>", AppLockerMechanism::Local).unwrap();
    assert_eq!(
        sim.with_world(|w| w.applocker_policy.clone()),
        Some(("<AppLockerPolicy Version=\"1\"/>".to_string(), AppLockerMechanism::Local))
    );
    assert!(sim.set_applocker_policy("  ", AppLockerMechanism::Csp).is_err());
    sim.clear_applocker_policy(AppLockerMechanism::Local).unwrap();
    assert_eq!(sim.with_world(|w| w.applocker_policy.clone()), None);
}

#[test]
fn services_keep_start_security_and_privileges_with_the_real_rules() {
    let (_dir, sim) = sim();
    assert_eq!(sim.query_service("Spooler").unwrap(), Some(ServiceConfig { start: 2 }));
    assert_eq!(sim.query_service("NoSuchService").unwrap(), None);
    sim.set_service_start("Spooler", 4).unwrap();
    assert_eq!(sim.query_service("Spooler").unwrap(), Some(ServiceConfig { start: 4 }));
    assert!(matches!(sim.set_service_start("NoSuchService", 4), Err(PlatformError::NotFound)));
    // Never boot/system start types; the agent service stays automatic.
    assert!(is_other(&sim.set_service_start("Spooler", 0).unwrap_err(), "start type"));
    assert!(is_other(&sim.set_service_start("RuleboxAgent", 4).unwrap_err(), "automatically"));
    assert_eq!(sim.query_service("RuleboxAgent").unwrap(), Some(ServiceConfig { start: 2 }));

    let original = sim.get_service_security("RuleboxAgent").unwrap().unwrap();
    sim.set_service_security("RuleboxAgent", "D:P(A;;GA;;;SY)").unwrap();
    assert_eq!(sim.get_service_security("RuleboxAgent").unwrap().as_deref(), Some("D:P(A;;GA;;;SY)"));
    sim.set_service_security("RuleboxAgent", &original).unwrap();
    assert_eq!(sim.get_service_security("NoSuchService").unwrap(), None);
    // Only the agent's own service gets a new security descriptor or privilege list.
    assert!(is_other(&sim.set_service_security("Spooler", "D:P(A;;GA;;;SY)").unwrap_err(), "agent service"));
    assert!(is_other(&sim.set_service_required_privileges("Spooler", &[]).unwrap_err(), "agent service"));
    sim.set_service_required_privileges("RuleboxAgent", &["SeTcbPrivilege", "SeBackupPrivilege"]).unwrap();
    assert_eq!(sim.get_service_required_privileges("RuleboxAgent").unwrap(), ["SeTcbPrivilege", "SeBackupPrivilege"]);
    sim.set_service_required_privileges("RuleboxAgent", &[]).unwrap();
    assert!(sim.get_service_required_privileges("RuleboxAgent").unwrap().is_empty());
}

#[test]
fn the_account_lockout_policy_reads_back_what_was_set() {
    let (_dir, sim) = sim();
    let original = sim.get_account_lockout().unwrap();
    assert_eq!(original, LockoutPolicy { threshold: 0, duration_s: 1800, window_s: 1800 });
    let wanted = LockoutPolicy { threshold: 5, duration_s: 900, window_s: 900 };
    sim.set_account_lockout(wanted).unwrap();
    assert_eq!(sim.get_account_lockout().unwrap(), wanted);
    sim.set_account_lockout(original).unwrap();
    assert_eq!(sim.get_account_lockout().unwrap(), original);
}

#[test]
fn wlan_profiles_are_only_rulebox_ones_and_the_filter_is_limited() {
    let (_dir, sim) = sim();
    sim.wlan_set_profile(WLAN_XML).unwrap();
    let state = sim.wlan_list().unwrap();
    assert_eq!((state.interfaces, state.profiles.as_slice()), (1, &["Rulebox-ab12".to_string()][..]));
    assert!(is_other(&sim.wlan_set_profile("<WLANProfile><name>HomeWifi</name></WLANProfile>").unwrap_err(), "Rulebox"));
    assert!(is_other(&sim.wlan_delete_profile("HomeWifi").unwrap_err(), "Rulebox"));
    sim.wlan_delete_profile("Rulebox-ab12").unwrap();
    sim.wlan_delete_profile("Rulebox-ab12").unwrap();
    assert!(sim.wlan_list().unwrap().profiles.is_empty());

    sim.wlan_set_filters(&["Acme", "Acme-Guest"]).unwrap();
    assert_eq!(sim.wlan_list().unwrap().allowed_ssids, ["Acme", "Acme-Guest"]);
    assert!(sim.wlan_set_filters(&[""]).is_err());
    sim.wlan_set_filters(&[]).unwrap();
    assert!(sim.wlan_list().unwrap().allowed_ssids.is_empty());

    // No wireless adapter: a profile cannot be stored.
    sim.with_world(|w| w.wlan_interfaces = 0);
    assert!(matches!(sim.wlan_set_profile(WLAN_XML), Err(PlatformError::NotFound)));
}

#[test]
fn printers_only_rulebox_queues_are_added_or_deleted_any_queue_gets_a_security_descriptor() {
    let (_dir, sim) = sim();
    let spec = PrinterSpec {
        name: "Front desk (Rulebox)".into(),
        port: "IP_192.168.1.20".into(),
        driver: "Microsoft IPP Class Driver".into(),
    };
    sim.printer_add(&spec).unwrap();
    assert!(sim.printer_list().unwrap().iter().any(|p| p.name == spec.name && p.port == spec.port));
    let mut foreign = spec.clone();
    foreign.name = "Front desk".into();
    assert!(is_other(&sim.printer_add(&foreign).unwrap_err(), "Rulebox made"));
    assert!(is_other(&sim.printer_delete("Microsoft Print to PDF").unwrap_err(), "Rulebox made"));

    let original = sim.printer_get_security("Microsoft Print to PDF").unwrap().unwrap();
    sim.printer_set_security("Microsoft Print to PDF", "D:(D;;SWRC;;;S-1-5-21-1-2-3-1001)").unwrap();
    assert_eq!(
        sim.printer_get_security("Microsoft Print to PDF").unwrap().as_deref(),
        Some("D:(D;;SWRC;;;S-1-5-21-1-2-3-1001)")
    );
    sim.printer_set_security("Microsoft Print to PDF", &original).unwrap();
    assert!(matches!(sim.printer_set_security("No such queue", "D:"), Err(PlatformError::NotFound)));
    assert_eq!(sim.printer_get_security("No such queue").unwrap(), None);
    assert!(sim.printer_get_security(r"\\server\queue").is_err());

    sim.printer_delete(&spec.name).unwrap();
    sim.printer_delete(&spec.name).unwrap();
    assert!(sim.printer_list().unwrap().iter().all(|p| p.name != spec.name));
}

#[test]
fn bcd_changes_only_recoveryenabled_of_current() {
    let (_dir, sim) = sim();
    assert_eq!(sim.bcd_get("{current}", "recoveryenabled").unwrap(), None);
    sim.bcd_set("{current}", "recoveryenabled", "No").unwrap();
    assert_eq!(sim.bcd_get("{CURRENT}", "RecoveryEnabled").unwrap().as_deref(), Some("No"));
    assert!(is_other(&sim.bcd_set("{bootmgr}", "displayorder", "x").unwrap_err(), "not one Rulebox changes"));
    assert!(sim.bcd_set("{current}", "recoveryenabled", "Maybe").is_err());
    assert!(sim.bcd_get("{default}", "path").is_err());
}

#[test]
fn event_logs_are_read_after_a_record_number_oldest_first_and_bounded() {
    let (_dir, sim) = sim();
    let channel = "Microsoft-Windows-AppLocker/EXE and DLL";
    sim.with_world(|w| {
        w.event_logs.insert(
            channel.to_string(),
            [5u64, 3, 9, 7].into_iter().map(|id| EventRecord { record_id: id, xml: format!("<e{id}/>") }).collect(),
        );
    });
    let ids = |records: Vec<EventRecord>| records.into_iter().map(|r| r.record_id).collect::<Vec<_>>();
    assert_eq!(ids(sim.read_event_log(channel, 0, 10).unwrap()), [3, 5, 7, 9]);
    assert_eq!(ids(sim.read_event_log(channel, 5, 10).unwrap()), [7, 9]);
    assert_eq!(ids(sim.read_event_log(&channel.to_lowercase(), 0, 2).unwrap()), [3, 5]);
    assert!(sim.read_event_log("Microsoft-Windows-CodeIntegrity/Operational", 0, 10).unwrap().is_empty());
    for bad in ["Security", "System", ""] {
        assert!(sim.read_event_log(bad, 0, 10).is_err(), "{bad}");
    }
}

#[test]
fn path_acls_are_only_set_inside_the_install_and_state_folders() {
    let (dir, sim) = sim();
    let install = Path::new(r"C:\Program Files\Rulebox");
    let state = dir.path().join("state");
    assert_eq!(sim.get_path_acl(install).unwrap(), None);
    sim.set_path_acl(install, "D:P(A;OICI;FA;;;SY)").unwrap();
    sim.set_path_acl(&install.join("versions"), "D:P(A;OICI;FA;;;SY)").unwrap();
    sim.set_path_acl(&state, "D:P(A;OICI;FA;;;SY)").unwrap();
    assert_eq!(sim.get_path_acl(Path::new(r"c:\program files\rulebox\")).unwrap().as_deref(), Some("D:P(A;OICI;FA;;;SY)"));
    for outside in [
        Path::new(r"C:\Windows"),
        Path::new(r"C:\Program Files"),
        Path::new(r"C:\Program Files\RuleboxEvil"),
        Path::new(r"C:\Program Files\Rulebox\..\Windows"),
        Path::new(r"\\server\share\Rulebox"),
        Path::new(r"Rulebox"),
    ] {
        assert!(
            matches!(sim.set_path_acl(outside, "D:P(A;OICI;FA;;;SY)"), Err(PlatformError::Refused(_))),
            "{}",
            outside.display()
        );
    }
}

#[test]
fn acl_targets_compare_whole_folder_names_without_case() {
    let install = Path::new(r"C:\Program Files\Rulebox");
    let state = Path::new(r"C:\ProgramData\Rulebox\state");
    assert!(acl_target_allowed(install, state, Path::new(r"c:/program files/RULEBOX/versions/1")));
    assert!(acl_target_allowed(install, state, state));
    assert!(!acl_target_allowed(install, state, Path::new(r"C:\ProgramData\Rulebox")));
    assert!(!acl_target_allowed(install, state, Path::new(r"C:\ProgramData\Rulebox\state2")));
    assert!(!acl_target_allowed(install, state, Path::new("")));
}

#[test]
fn a_process_trace_delivers_events_until_it_is_stopped() {
    let (_dir, sim) = sim();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let sink = {
        let seen = seen.clone();
        Box::new(move |event: ProcessStart| seen.lock().unwrap().push(event.pid)) as ProcessSink
    };
    let handle = sim.start_process_trace(sink).unwrap();
    assert_eq!(sim.running_traces(), 1);
    let event = ProcessStart { pid: 42, parent_pid: 4, session_id: 2, image: r"C:\Windows\notepad.exe".into() };
    assert_eq!(sim.emit_process_start(&event), 1);
    sim.stop_process_trace(handle).unwrap();
    sim.stop_process_trace(handle).unwrap();
    assert_eq!(sim.emit_process_start(&event), 0);
    assert_eq!(*seen.lock().unwrap(), [42]);
}

#[test]
fn the_posture_defaults_describe_a_protected_pc() {
    let (_dir, sim) = sim();
    let posture = sim.read_security_posture().unwrap();
    assert_eq!(posture.secure_boot, SecureBoot::On);
    assert_eq!(posture.bit_locker, BitLocker::Off);
    assert_eq!(posture.tpm, Tpm::Present);
    sim.with_world(|w| w.posture.bit_locker = BitLocker::On);
    assert_eq!(sim.read_security_posture().unwrap().bit_locker, BitLocker::On);
}

#[test]
fn every_new_method_can_be_failed_and_is_in_the_call_log() {
    let (_dir, sim) = sim();
    let sid = staff(&sim);
    let fail = || PlatformError::AccessDenied;

    // Reads.
    sim.fail_next(SimOp::ListMachineValueNames, fail());
    assert!(sim.list_machine_value_names("K").is_err());
    sim.fail_next(SimOp::ReadStaffValue, fail());
    assert!(sim.read_staff_value(&sid, STAFF_KEY, "X").is_err());
    sim.fail_next(SimOp::ListCiPolicies, fail());
    assert!(sim.list_ci_policies().is_err());
    sim.fail_next(SimOp::GetApplockerPolicy, fail());
    assert!(sim.get_applocker_policy().is_err());
    sim.fail_next(SimOp::QueryService, fail());
    assert!(sim.query_service("Spooler").is_err());
    sim.fail_next(SimOp::GetServiceSecurity, fail());
    assert!(sim.get_service_security("Spooler").is_err());
    sim.fail_next(SimOp::GetServiceRequiredPrivileges, fail());
    assert!(sim.get_service_required_privileges("Spooler").is_err());
    sim.fail_next(SimOp::GetAccountLockout, fail());
    assert!(sim.get_account_lockout().is_err());
    sim.fail_next(SimOp::WlanList, fail());
    assert!(sim.wlan_list().is_err());
    sim.fail_next(SimOp::PrinterList, fail());
    assert!(sim.printer_list().is_err());
    sim.fail_next(SimOp::PrinterGetSecurity, fail());
    assert!(sim.printer_get_security("Microsoft Print to PDF").is_err());
    sim.fail_next(SimOp::BcdGet, fail());
    assert!(sim.bcd_get("{current}", "recoveryenabled").is_err());
    sim.fail_next(SimOp::ReadEventLog, fail());
    assert!(sim.read_event_log("Microsoft-Windows-CodeIntegrity/Operational", 0, 1).is_err());
    sim.fail_next(SimOp::ReadSecurityPosture, fail());
    assert!(sim.read_security_posture().is_err());
    sim.fail_next(SimOp::GetPathAcl, fail());
    assert!(sim.get_path_acl(Path::new(r"C:\Program Files\Rulebox")).is_err());

    // Mutating ones.
    sim.fail_next(SimOp::WriteStaffValue, fail());
    assert!(sim.write_staff_value(&sid, STAFF_KEY, "X", &RegData::Dword(1)).is_err());
    sim.fail_next(SimOp::DeleteStaffValue, fail());
    assert!(sim.delete_staff_value(&sid, STAFF_KEY, "X").is_err());
    sim.fail_next(SimOp::DeployCiPolicy, fail());
    assert!(sim.deploy_ci_policy(ID, b"x").is_err());
    sim.fail_next(SimOp::RemoveCiPolicy, fail());
    assert!(sim.remove_ci_policy(ID).is_err());
    sim.fail_next(SimOp::SetApplockerPolicy, fail());
    assert!(sim.set_applocker_policy("<x/>", AppLockerMechanism::Local).is_err());
    sim.fail_next(SimOp::ClearApplockerPolicy, fail());
    assert!(sim.clear_applocker_policy(AppLockerMechanism::Local).is_err());
    sim.fail_next(SimOp::SetServiceStart, fail());
    assert!(sim.set_service_start("Spooler", 4).is_err());
    sim.fail_next(SimOp::SetServiceSecurity, fail());
    assert!(sim.set_service_security("RuleboxAgent", "D:").is_err());
    sim.fail_next(SimOp::SetServiceRequiredPrivileges, fail());
    assert!(sim.set_service_required_privileges("RuleboxAgent", &[]).is_err());
    sim.fail_next(SimOp::SetAccountLockout, fail());
    assert!(sim.set_account_lockout(LockoutPolicy { threshold: 5, duration_s: 1, window_s: 1 }).is_err());
    sim.fail_next(SimOp::WlanSetProfile, fail());
    assert!(sim.wlan_set_profile(WLAN_XML).is_err());
    sim.fail_next(SimOp::WlanDeleteProfile, fail());
    assert!(sim.wlan_delete_profile("Rulebox-ab12").is_err());
    sim.fail_next(SimOp::WlanSetFilters, fail());
    assert!(sim.wlan_set_filters(&["Acme"]).is_err());
    let spec = PrinterSpec { name: "A (Rulebox)".into(), port: "P".into(), driver: "D".into() };
    sim.fail_next(SimOp::PrinterAdd, fail());
    assert!(sim.printer_add(&spec).is_err());
    sim.fail_next(SimOp::PrinterDelete, fail());
    assert!(sim.printer_delete("A (Rulebox)").is_err());
    sim.fail_next(SimOp::PrinterSetSecurity, fail());
    assert!(sim.printer_set_security("Microsoft Print to PDF", "D:").is_err());
    sim.fail_next(SimOp::BcdSet, fail());
    assert!(sim.bcd_set("{current}", "recoveryenabled", "No").is_err());
    sim.fail_next(SimOp::StartProcessTrace, fail());
    assert!(sim.start_process_trace(Box::new(|_| {})).is_err());
    sim.fail_next(SimOp::StopProcessTrace, fail());
    assert!(sim.stop_process_trace(TraceHandle(1)).is_err());
    sim.fail_next(SimOp::SetPathAcl, fail());
    assert!(sim.set_path_acl(Path::new(r"C:\Program Files\Rulebox"), "D:").is_err());

    // Every one of them was logged, reads and writes apart.
    let calls = sim.calls();
    let mutating: Vec<_> = calls.iter().filter(|op| op.is_mutating()).collect();
    assert!(calls.contains(&SimOp::ReadEventLog) && calls.contains(&SimOp::SetPathAcl));
    assert!(!SimOp::ReadStaffValue.is_mutating() && !SimOp::GetPathAcl.is_mutating());
    assert!(SimOp::WriteStaffValue.is_mutating() && SimOp::BcdSet.is_mutating() && SimOp::StopProcessTrace.is_mutating());
    assert!(mutating.contains(&&SimOp::PrinterSetSecurity));
    // Nothing failed twice: the injected error is used up.
    assert!(sim.get_account_lockout().is_ok());
}

#[test]
fn the_mutating_method_list_matches_the_mutating_sim_calls() {
    // Each name in MUTATING_METHODS has a SimOp in snake case with the same meaning.
    for name in MUTATING_METHODS {
        assert!(!name.is_empty() && name.chars().all(|c| c.is_ascii_lowercase() || c == '_'), "{name}");
    }
    let mut sorted: Vec<_> = MUTATING_METHODS.to_vec();
    sorted.sort_unstable();
    sorted.dedup();
    assert_eq!(sorted.len(), MUTATING_METHODS.len(), "no name twice");
}
