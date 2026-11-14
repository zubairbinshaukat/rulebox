//! Tests of the file-output printers (plan Step 7): the deny-Print ACE for the Staff SID on queues
//! whose port is a file port, the original DACL journalled and restored, administrators and other
//! accounts untouched. All against `SimPlatform`.

use std::sync::Arc;

use rulebox_policy::lockdown::{LockdownPolicy, MachineRestrictions};
use rulebox_policy::AgentDoc;

use super::*;
use crate::journal::{JournalCtx, JournalEntry, JournalTarget, OriginalValue};
use crate::lockdown::apply::ApplyCtx;
use crate::lockdown::invariants::Facts;
use crate::lockdown::machine;
use crate::lockdown::{LayerStatus, LayerState};
use crate::platform::sim::{SimOp, SimPlatform, SimPrinter};
use crate::platform::{Platform, PlatformError, PrinterInfo, PrinterSpec};
use crate::state::{AgentState, SharedState, StaffAccount, StateStore};
use crate::testutil::TempDir;

const STAFF: &str = "S-1-5-21-1-1-1-2001";
const PDF: &str = "Microsoft Print to PDF";
const DEFAULT_DACL: &str = "D:(A;;LCSWSDRCWDWO;;;WD)(A;OIIO;RPWPSDRCWDWO;;;WD)";

struct Rig {
    _dir: TempDir,
    platform: Arc<SimPlatform>,
    shared: Arc<SharedState>,
}

impl Rig {
    fn new() -> Self {
        let dir = TempDir::new();
        let platform = Arc::new(SimPlatform::new(dir.path().to_path_buf()));
        let dyn_platform: Arc<dyn Platform> = platform.clone();
        let state = AgentState {
            staff: Some(StaffAccount { sid: STAFF.into(), user_name: "RuleboxStaff".into(), profile_dir: None }),
            ..AgentState::default()
        };
        let shared = SharedState::new(StateStore::open(&dir.path().join("state")).unwrap(), state, dyn_platform);
        Self { _dir: dir, platform, shared }
    }

    fn ctx(&self) -> ApplyCtx<'_> {
        ApplyCtx { journal: JournalCtx { platform: self.platform.as_ref(), shared: self.shared.as_ref() }, facts: Facts::default(), now_ms: 1_000, version: 7 }
    }

    fn doc(file_output: bool) -> AgentDoc {
        // Every other machine switch is off, so the layer only does the printers.
        let machine = MachineRestrictions {
            hide_switch_user: false,
            hide_sign_in_power: false,
            deny_elevation_requests: false,
            hide_admin_tiles: false,
            no_wake_password: false,
            restrict_printer_drivers: false,
            file_output_printers: file_output,
            account_lockout: None,
        };
        AgentDoc { lockdown: Some(LockdownPolicy { machine, ..LockdownPolicy::default() }), ..AgentDoc::default() }
    }

    /// The whole L2 layer, because the printers run as part of it.
    fn apply(&self, doc: &AgentDoc) -> LayerState {
        machine::apply(&self.ctx(), doc)
    }

    fn add_printer(&self, name: &str, port: &str) {
        self.platform.with_world(|w| {
            w.printers.push(SimPrinter {
                info: PrinterInfo { name: name.into(), port: port.into(), driver: "Driver".into(), attributes: 64 },
                sddl: Some(DEFAULT_DACL.into()),
            });
        });
    }

    fn sddl(&self, name: &str) -> Option<String> {
        self.platform.printer_get_security(name).unwrap()
    }

    fn mutating(&self) -> usize {
        self.platform.calls().iter().filter(|op| op.is_mutating()).count()
    }

    fn entry(&self, name: &str) -> Option<JournalEntry> {
        let id = journal::printer_security_id(name);
        self.shared.read(|s| s.journal.iter().find(|e| e.id == id).cloned())
    }

    fn printer_entries(&self) -> usize {
        self.shared.read(|s| s.journal.iter().filter(|e| e.id.starts_with(ID_PREFIX)).count())
    }
}

#[test]
fn the_deny_ace_goes_first_and_names_the_staff_sid_only() {
    let denied = deny_print(DEFAULT_DACL, STAFF).unwrap();
    assert_eq!(denied, format!("D:(D;;SW;;;{STAFF})(A;;LCSWSDRCWDWO;;;WD)(A;OIIO;RPWPSDRCWDWO;;;WD)"));
    // The ACL flags stay where they were.
    assert_eq!(deny_print("D:PAI(A;;FA;;;BA)", STAFF).unwrap(), format!("D:PAI(D;;SW;;;{STAFF})(A;;FA;;;BA)"));
    assert_eq!(deny_print("D:", STAFF).unwrap(), format!("D:(D;;SW;;;{STAFF})"));
    assert_eq!(deny_print("not a dacl", STAFF), None);
    assert!(denies_print(&denied, STAFF));
    assert!(!denies_print(DEFAULT_DACL, STAFF));
    assert!(!denies_print(&denied, "S-1-5-21-1-1-1-2002"), "another account is not denied");
    assert!(!denies_print("D:(A;;SW;;;S-1-5-21-1-1-1-2001)", STAFF), "an allow ACE is not a deny");
    assert!(!denies_print(&format!("D:(D;;LC;;;{STAFF})"), STAFF), "a deny of another right is not a deny of Print");
    assert!(denies_print(&format!("D:(D;;0x8;;;{STAFF})"), STAFF));
    // Nobody but the Staff SID is named by the new ACE.
    let aces = crate::lockdown::allowlist::aces(&denied);
    assert_eq!(aces.iter().filter(|a| a.kind == "D").map(|a| a.trustee.as_str()).collect::<Vec<_>>(), [STAFF]);
}

#[test]
fn file_ports_are_denied_and_device_ports_are_not() {
    let rig = Rig::new();
    rig.add_printer("Front desk", "IP_192.168.1.20");
    rig.add_printer("Archive", "FILE:");
    rig.add_printer("Report", r"C:\Spool\report.prn");
    let state = rig.apply(&Rig::doc(true));
    assert_eq!(state.state, LayerStatus::Ok, "{state:?}");
    // The sim's Microsoft Print to PDF has a PORTPROMPT: port, whatever it is called.
    for name in [PDF, "Archive", "Report"] {
        assert!(denies_print(&rig.sddl(name).unwrap(), STAFF), "{name}");
        let entry = rig.entry(name).unwrap();
        assert_eq!((entry.owner, entry.original.clone()), (JournalOwner::L2, OriginalValue::Sddl(DEFAULT_DACL.into())), "{name}");
        assert_eq!(entry.target, JournalTarget::PrinterSecurity { printer_key: name.into() });
    }
    assert_eq!(rig.sddl("Front desk").as_deref(), Some(DEFAULT_DACL), "a device printer is untouched");
    assert!(rig.entry("Front desk").is_none());
}

#[test]
fn the_name_of_a_queue_decides_nothing() {
    let rig = Rig::new();
    // A localized name for the PDF printer, and a device printer called like a PDF writer.
    rig.platform.with_world(|w| w.printers[0].info.name = "Microsoft Drucken in PDF".into());
    rig.add_printer("Microsoft Print to PDF", "IP_10.0.0.9");
    rig.apply(&Rig::doc(true));
    assert!(denies_print(&rig.sddl("Microsoft Drucken in PDF").unwrap(), STAFF));
    assert!(!denies_print(&rig.sddl("Microsoft Print to PDF").unwrap(), STAFF));
}

#[test]
fn a_second_apply_writes_nothing_even_if_windows_spells_the_dacl_differently() {
    let rig = Rig::new();
    rig.apply(&Rig::doc(true));
    let before = rig.mutating();
    // Windows may return the DACL it stored in another order or with other flags.
    rig.platform.with_world(|w| w.printers[0].sddl = Some(format!("D:AI(A;;LCSWSDRCWDWO;;;WD)(D;;SW;;;{STAFF})")));
    rig.apply(&Rig::doc(true));
    assert_eq!(rig.mutating(), before);
    assert_eq!(rig.printer_entries(), 1);
}

#[test]
fn turning_it_off_or_removing_the_section_puts_the_original_dacl_back() {
    for restore_with in [Rig::doc(false), AgentDoc::default()] {
        let rig = Rig::new();
        rig.apply(&Rig::doc(true));
        assert!(denies_print(&rig.sddl(PDF).unwrap(), STAFF));
        rig.apply(&restore_with);
        assert_eq!(rig.sddl(PDF).as_deref(), Some(DEFAULT_DACL), "exactly the original");
        assert_eq!(rig.printer_entries(), 0);
    }
}

#[test]
fn disable_kiosk_restores_it_through_the_journal() {
    let rig = Rig::new();
    rig.add_printer("Archive", "FILE:");
    rig.apply(&Rig::doc(true));
    let report = journal::restore_all(&JournalCtx { platform: rig.platform.as_ref(), shared: rig.shared.as_ref() });
    assert!(report.is_complete(), "{:?}", report.failed_ids());
    assert_eq!(rig.sddl(PDF).as_deref(), Some(DEFAULT_DACL));
    assert_eq!(rig.sddl("Archive").as_deref(), Some(DEFAULT_DACL));
}

#[test]
fn a_queue_that_is_gone_or_has_a_new_port_is_restored_without_error() {
    let rig = Rig::new();
    rig.add_printer("Archive", "FILE:");
    rig.apply(&Rig::doc(true));
    assert_eq!(rig.printer_entries(), 2);
    // The queue is deleted; the other one moves to a device port.
    rig.platform.with_world(|w| {
        w.printers.retain(|p| p.info.name != "Archive");
        w.printers[0].info.port = "IP_192.168.1.30".into();
    });
    let state = rig.apply(&Rig::doc(true));
    assert_eq!(state.state, LayerStatus::Ok, "{state:?}");
    assert_eq!(rig.printer_entries(), 0);
    assert_eq!(rig.sddl(PDF).as_deref(), Some(DEFAULT_DACL), "the original is back on the queue that moved");
}

#[test]
fn without_a_staff_account_there_is_nobody_to_deny_and_nothing_is_written() {
    let rig = Rig::new();
    rig.shared.update(|s| s.staff = None).unwrap();
    let before = rig.mutating();
    let state = rig.apply(&Rig::doc(true));
    assert_eq!(state.state, LayerStatus::Ok);
    assert_eq!(rig.mutating(), before);
    assert_eq!(rig.printer_entries(), 0);
}

#[test]
fn a_dacl_that_already_denies_staff_is_left_alone_and_not_journalled() {
    let rig = Rig::new();
    rig.platform.with_world(|w| w.printers[0].sddl = Some(format!("D:(D;;SW;;;{STAFF})(A;;LC;;;WD)")));
    let before = rig.mutating();
    rig.apply(&Rig::doc(true));
    assert_eq!(rig.mutating(), before);
    assert_eq!(rig.printer_entries(), 0);
}

#[test]
fn failures_are_reported_with_a_code_and_the_next_apply_finishes() {
    let rig = Rig::new();
    rig.platform.fail_next(SimOp::PrinterSetSecurity, PlatformError::AccessDenied);
    let state = rig.apply(&Rig::doc(true));
    assert_ne!(state.state, LayerStatus::Ok);
    assert_eq!(state.detail.as_deref(), Some("access_denied"));
    assert!(!denies_print(&rig.sddl(PDF).unwrap(), STAFF));
    let state = rig.apply(&Rig::doc(true));
    assert_eq!(state.state, LayerStatus::Ok, "{state:?}");
    assert!(denies_print(&rig.sddl(PDF).unwrap(), STAFF));
    assert_eq!(rig.entry(PDF).unwrap().phase, crate::journal::EntryPhase::Applied);

    // The queue list cannot be read: that is said, and nothing already done is undone.
    rig.platform.fail_next(SimOp::PrinterList, PlatformError::AccessDenied);
    let state = rig.apply(&Rig::doc(true));
    assert_eq!(state.detail.as_deref(), Some("printer_list_unreadable"));
    assert!(denies_print(&rig.sddl(PDF).unwrap(), STAFF));
    assert_eq!(rig.printer_entries(), 1);
}

#[test]
fn only_the_documents_with_the_switch_on_change_anything() {
    let rig = Rig::new();
    let before = rig.mutating();
    rig.apply(&Rig::doc(false));
    assert_eq!(rig.mutating(), before);
    assert_eq!(rig.sddl(PDF).as_deref(), Some(DEFAULT_DACL));
    // Adding a queue through the seam keeps working with its own rules.
    let spec = PrinterSpec { name: "Front desk (Rulebox)".into(), port: "IP_192.168.1.20".into(), driver: "Microsoft IPP Class Driver".into() };
    rig.platform.printer_add(&spec).unwrap();
    rig.apply(&Rig::doc(true));
    assert!(!denies_print(&rig.sddl("Front desk (Rulebox)").unwrap(), STAFF));
}
