//! Tests of the Printers layer (Phase 5 Step 14): the address rules (the same vectors as the server's
//! `convex/printerAddress.test.ts`), the apply through the journal (ports, queues, shares, idempotence, renamed queues,
//! revisions, removal, foreign queues, `name_taken`, `driver_missing`), the default printer in the Staff hive and the
//! restore. All against `SimPlatform`; nothing touches the machine.

use std::sync::Arc;

use rulebox_policy::network::{PrinterKind, PrinterSpec as DocPrinter};
use rulebox_policy::AgentDoc;

use super::*;
use crate::journal::{CrashPoint, EntryPhase, JournalCtx, JournalTarget, OriginalValue};
use crate::lockdown::apply::{apply as apply_all, ReportExtras};
use crate::lockdown::invariants::Facts;
use crate::platform::sim::{SimOp, SimPlatform, SimPrinter, SimUser};
use crate::platform::{Platform, PlatformError};
use crate::state::{AgentState, SharedState, StaffAccount, StateStore};
use crate::testutil::TempDir;

const STAFF: &str = "S-1-5-21-1-1-1-2001";
const IPP_DRIVER: &str = "Microsoft IPP Class Driver";
const PCL_DRIVER: &str = "Microsoft PCL6 Class Driver";

fn printer(id: &str, name: &str, kind: PrinterKind, address: &str) -> DocPrinter {
    DocPrinter {
        id: id.into(),
        name: name.into(),
        kind,
        address: address.into(),
        port: None,
        queue: None,
        driver: if kind == PrinterKind::Ipp { IPP_DRIVER } else { PCL_DRIVER }.into(),
        is_default: false,
        revision: 1,
    }
}

fn ipp(id: &str, name: &str) -> DocPrinter {
    printer(id, name, PrinterKind::Ipp, "ipp://10.0.0.20:631/ipp/print")
}

fn raw(id: &str, name: &str) -> DocPrinter {
    printer(id, name, PrinterKind::Raw, "10.0.0.21")
}

struct Rig {
    _dir: TempDir,
    platform: Arc<SimPlatform>,
    shared: Arc<SharedState>,
    base: usize,
}

impl Rig {
    fn new() -> Self {
        Self::with_staff(true)
    }

    fn with_staff(staff: bool) -> Self {
        let dir = TempDir::new();
        let platform = Arc::new(SimPlatform::new(dir.path().to_path_buf()));
        let dyn_platform: Arc<dyn Platform> = platform.clone();
        let state = AgentState {
            staff: staff.then(|| StaffAccount { sid: STAFF.into(), user_name: "RuleboxStaff".into(), profile_dir: None }),
            ..AgentState::default()
        };
        let shared = SharedState::new(StateStore::open(&dir.path().join("state")).unwrap(), state, dyn_platform);
        if staff {
            platform.with_world(|w| {
                w.users.insert("RuleboxStaff".into(), SimUser { sid: STAFF.into(), comment: String::new(), disabled: false, password: String::new() });
            });
        }
        Self { _dir: dir, platform, shared, base: 0 }
    }

    fn ctx(&self) -> ApplyCtx<'_> {
        ApplyCtx { journal: JournalCtx { platform: self.platform.as_ref(), shared: self.shared.as_ref() }, facts: Facts::default(), now_ms: 1_000, version: 7 }
    }

    fn apply(&mut self, printers: Vec<DocPrinter>) -> PrinterOutcome {
        self.base = self.platform.calls().len();
        super::apply(&self.ctx(), &AgentDoc { printers, ..AgentDoc::default() })
    }

    /// Mutating platform calls since the last `apply`.
    fn mutating(&self) -> usize {
        self.platform.calls()[self.base..].iter().filter(|op| op.is_mutating()).count()
    }

    fn queues(&self) -> Vec<(String, String, String, String)> {
        self.platform.with_world(|w| {
            w.printers.iter().filter(|p| p.info.name != "Microsoft Print to PDF").map(|p| (p.info.name.clone(), p.info.port.clone(), p.info.driver.clone(), p.info.comment.clone())).collect()
        })
    }

    fn ports(&self) -> Vec<String> {
        self.platform.with_world(|w| w.printer_ports.iter().map(|p| p.name.clone()).filter(|n| n.starts_with("Rulebox_")).collect())
    }

    fn entry_ids(&self) -> Vec<String> {
        self.shared.read(|s| s.journal.iter().map(|e| e.id.clone()).collect())
    }

    fn staff_value(&self, name: &str) -> Option<RegData> {
        self.platform.read_staff_value(STAFF, DEFAULT_KEY, name).unwrap()
    }
}

fn states(outcome: &PrinterOutcome) -> Vec<(&str, &str, Option<&str>)> {
    outcome.items.iter().map(|i| (i.printer_id.as_str(), i.state.as_str(), i.detail.as_deref())).collect()
}

// -- the rules ----------------------------------------------------------------------------------

#[test]
fn host_vectors_match_the_servers() {
    for ok in ["10.0.0.20", "printer", "front-desk.acme.example", "a.b.c", "0.0.0.0", "255.255.255.255", "::1", "fe80::1", "2001:db8::8:800:200c:417a", "::ffff:10.0.0.1", "1:2:3:4:5:6:7:8"] {
        assert!(is_host(ok), "{ok}");
    }
    for bad in ["", "999.1.1.1", "10.0.0", "10.0.0.256", "-a.example", "a-.example", "a..b", "a b", "a_b.example", "http://x", "10.0.0.20:631", "1:2:3:4:5:6:7:8:9", "1::2::3", "01.2.3.4"] {
        assert!(!is_host(bad), "{bad}");
    }
    assert!(is_host(&format!("{}a", ("a".repeat(63) + ".").repeat(3) + &"a".repeat(60))));
    assert!(!is_host(&format!("{}{}", ("a".repeat(63) + ".").repeat(3), "a".repeat(62))));
}

fn plan(kind: PrinterKind, address: &str, port: Option<u16>, queue: Option<&str>) -> Result<Plan, &'static str> {
    plan_of(&DocPrinter { port, queue: queue.map(str::to_string), ..printer("k7", "Front", kind, address) })
}

#[test]
fn address_vectors() {
    use PrinterKind::{Ipp, Lpr, Raw, Share};
    assert_eq!(plan(Ipp, "ipp://10.0.0.20:631/ipp/print", None, None), Ok(Plan::Ipp { url: "ipp://10.0.0.20:631/ipp/print".into() }));
    assert!(plan(Ipp, "https://printer.acme.example/ipp/print", None, None).is_ok());
    assert!(plan(Ipp, "ipp://[2001:db8::1]:631/ipp/print", None, None).is_ok());
    for bad in [
        "http://10.0.0.20/ipp/print",
        "10.0.0.20",
        "ipp://user:pw@10.0.0.20/ipp/print",
        "ipp://user@10.0.0.20/ipp/print",
        "ipp://10.0.0.20",
        "ipp://10.0.0.20/",
        "ipp://10.0.0.20:0/ipp/print",
        "ipp://10.0.0.20:65536/ipp/print",
        "ipp://10.0.0.20:abc/ipp/print",
        "ipp://999.0.0.1/ipp/print",
        "ipp://[::1/ipp/print",
        "ipp:///ipp/print",
        "ipp://10.0.0.20/ipp/pri nt",
        "ipp://10.0.0.20/ipp/print?x=1",
    ] {
        assert_eq!(plan(Ipp, bad, None, None), Err("address_invalid"), "{bad}");
    }
    assert_eq!(plan(Ipp, "ipp://10.0.0.20:631/ipp/print", Some(631), None), Err("port_invalid"));
    assert_eq!(plan(Ipp, "ipp://10.0.0.20/ipp/print", None, Some("q")), Err("port_invalid"));

    // raw: default port 9100, no queue, host at most 48 characters
    let Ok(Plan::Tcp { port }) = plan(Raw, "10.0.0.20", None, None) else { panic!("raw") };
    assert_eq!((port.name.as_str(), port.number, port.protocol, port.host.as_str()), ("Rulebox_k7", 9100, PortProtocol::RawTcp, "10.0.0.20"));
    let Ok(Plan::Tcp { port }) = plan(Raw, "printer.acme.example", Some(9101), None) else { panic!("raw") };
    assert_eq!(port.number, 9101);
    assert_eq!(plan(Raw, "10.0.0.20", Some(0), None), Err("port_invalid"));
    assert_eq!(plan(Raw, "10.0.0.20:9100", None, None), Err("address_invalid"));
    assert_eq!(plan(Raw, "10.0.0.20", None, Some("queue")), Err("queue_invalid"));
    assert_eq!(plan(Raw, &format!("{}.{}", "a".repeat(30), "b".repeat(20)), None, None), Err("address_invalid"));

    // lpr: queue required, at most 32 characters, no spaces, no port
    let Ok(Plan::Tcp { port }) = plan(Lpr, "10.0.0.20", None, Some("lp")) else { panic!("lpr") };
    assert_eq!((port.protocol, port.number, port.queue.as_str()), (PortProtocol::Lpr, 515, "lp"));
    assert_eq!(plan(Lpr, "10.0.0.20", None, None), Err("queue_required"));
    assert_eq!(plan(Lpr, "10.0.0.20", None, Some(&"x".repeat(33))), Err("queue_invalid"));
    assert_eq!(plan(Lpr, "10.0.0.20", None, Some("my queue")), Err("queue_invalid"));
    assert_eq!(plan(Lpr, "10.0.0.20", Some(515), Some("lp")), Err("port_invalid"));

    // share
    assert_eq!(plan(Share, "\\\\print01\\Front desk", None, None), Ok(Plan::Share { unc: "\\\\print01\\Front desk".into() }));
    for bad in ["print01\\hp", "\\\\print01", "\\\\print01\\a\\b", "//print01/hp", "\\\\bad host\\hp", "\\\\print01\\a,b"] {
        assert_eq!(plan(Share, bad, None, None), Err("address_invalid"), "{bad}");
    }
    assert_eq!(plan(PrinterKind::Unknown, "x", None, None), Err("section_unknown_value"));
}

#[test]
fn ids_and_names() {
    assert!(printer_id_ok("k7abc_-9") && !printer_id_ok("") && !printer_id_ok("a b") && !printer_id_ok("a\\b") && !printer_id_ok("a:b") && !printer_id_ok(&"x".repeat(41)));
    for bad in ["", " x", "x ", "a\\b", "a,b", "a/b", "a\u{7}b", &"x".repeat(61)] {
        assert!(!name_ok(bad), "{bad:?}");
    }
    assert!(name_ok("Front desk") && name_ok("Büro 2. Stock"));
    assert_eq!(queue_name("Front desk"), "Front desk (Rulebox)");
    assert!(spooler_required(&AgentDoc { printers: vec![ipp("a", "A")], ..AgentDoc::default() }));
    assert!(!spooler_required(&AgentDoc::default()));
}

// -- the apply ----------------------------------------------------------------------------------

#[test]
fn an_ipp_printer_becomes_a_queue_found_by_its_comment_and_a_second_apply_writes_nothing() {
    let mut rig = Rig::new();
    let outcome = rig.apply(vec![ipp("p1", "Front desk")]);
    assert_eq!(states(&outcome), [("p1", "applied", None)]);
    assert_eq!(rig.queues(), [("Front desk (Rulebox)".into(), "ipp://10.0.0.20:631/ipp/print".into(), IPP_DRIVER.into(), "rulebox:p1".into())]);
    assert!(rig.ports().is_empty(), "an IPP queue's port is its URL");
    assert_eq!(rig.entry_ids(), ["printer:p1"]);
    let entry = rig.shared.read(|s| s.journal[0].clone());
    assert_eq!((entry.owner, entry.original, entry.phase), (JournalOwner::Printer, OriginalValue::NotPresent, EntryPhase::Applied));
    assert_eq!(entry.target, JournalTarget::Printer { name: "p1".into() });

    let again = rig.apply(vec![ipp("p1", "Front desk")]);
    assert_eq!(states(&again), [("p1", "applied", None)]);
    assert_eq!(rig.mutating(), 0, "nothing changed: nothing written");
}

#[test]
fn raw_and_lpr_printers_get_a_port_of_their_own_first() {
    let mut rig = Rig::new();
    let mut lpr = printer("p3", "Back office", PrinterKind::Lpr, "10.0.0.22");
    lpr.queue = Some("lp".into());
    let mut raw_with_port = raw("p2", "Warehouse");
    raw_with_port.port = Some(9101);
    let outcome = rig.apply(vec![raw_with_port, lpr]);
    assert_eq!(states(&outcome), [("p2", "applied", None), ("p3", "applied", None)]);
    assert_eq!(rig.ports(), ["Rulebox_p2", "Rulebox_p3"]);
    let (raw_port, lpr_port) = rig.platform.with_world(|w| {
        let get = |n: &str| w.printer_ports.iter().find(|p| p.name == n).and_then(|p| p.spec.clone()).unwrap();
        (get("Rulebox_p2"), get("Rulebox_p3"))
    });
    assert_eq!((raw_port.protocol, raw_port.number, raw_port.host.as_str()), (PortProtocol::RawTcp, 9101, "10.0.0.21"));
    assert_eq!((lpr_port.protocol, lpr_port.number, lpr_port.queue.as_str()), (PortProtocol::Lpr, 515, "lp"));
    assert_eq!(rig.queues().iter().map(|q| (q.0.as_str(), q.1.as_str())).collect::<Vec<_>>(), [("Warehouse (Rulebox)", "Rulebox_p2"), ("Back office (Rulebox)", "Rulebox_p3")]);
    // Journal order: port, queue (so a restore, which goes last-first, deletes the queue before its port).
    assert_eq!(rig.entry_ids(), ["printer-port:Rulebox_p2", "printer:p2", "printer-port:Rulebox_p3", "printer:p3"]);
    assert_eq!(rig.apply(vec![]).items.len(), 0);
}

#[test]
fn a_share_is_a_per_machine_connection_and_goes_away_with_the_document() {
    let mut rig = Rig::new();
    let outcome = rig.apply(vec![printer("s1", "Shared", PrinterKind::Share, "\\\\print01\\hp")]);
    assert_eq!(states(&outcome), [("s1", "applied", None)]);
    assert_eq!(rig.platform.with_world(|w| w.printer_shares.clone()), ["\\\\print01\\hp"]);
    assert!(rig.queues().is_empty(), "no local queue for a share");
    assert_eq!(rig.entry_ids(), ["printer-share:\\\\print01\\hp"]);
    assert_eq!(rig.apply(vec![printer("s1", "Shared", PrinterKind::Share, "\\\\print01\\hp")]).items.len(), 1);
    assert_eq!(rig.mutating(), 0);

    rig.apply(vec![]);
    assert!(rig.platform.with_world(|w| w.printer_shares.is_empty()) && rig.entry_ids().is_empty());
    assert!(rig.shared.read(|s| s.printer_marks.is_empty()));
}

#[test]
fn an_unknown_driver_is_refused_and_nothing_is_created() {
    let mut rig = Rig::new();
    let mut spec = raw("p2", "Warehouse");
    spec.driver = "HP Evil Driver".into();
    let outcome = rig.apply(vec![spec, ipp("p1", "Front desk")]);
    assert_eq!(states(&outcome), [("p2", "failed", Some("driver_missing")), ("p1", "applied", None)]);
    assert!(rig.ports().is_empty(), "no port without a driver");
    assert_eq!(rig.queues().len(), 1);
    // A driver that is in the store works, whatever the case.
    let mut ok = raw("p2", "Warehouse");
    ok.driver = "microsoft pcl6 class driver".into();
    assert_eq!(states(&rig.apply(vec![ok])), [("p2", "applied", None)]);
}

#[test]
fn a_queue_with_the_same_name_that_is_not_ours_is_left_alone() {
    let mut rig = Rig::new();
    rig.platform.with_world(|w| {
        w.printers.push(SimPrinter {
            info: rulebox_win32::printing::PrinterInfo {
                name: "Front desk (Rulebox)".into(),
                port: "USB001".into(),
                driver: "Somebody's driver".into(),
                attributes: 64,
                comment: "the admin's own".into(),
            },
            sddl: Some("D:".into()),
        });
        w.printer_ports.push(crate::platform::sim::SimPort { name: "USB001".into(), spec: None });
    });
    let outcome = rig.apply(vec![raw("p1", "Front desk")]);
    assert_eq!(states(&outcome), [("p1", "failed", Some("name_taken"))]);
    assert_eq!(rig.mutating(), 0, "not even the port is created");
    assert!(rig.entry_ids().is_empty());
    let queues = rig.queues();
    assert_eq!(queues.len(), 1);
    assert_eq!(queues[0].2, "Somebody's driver");
    // And it is never deleted when the document stops listing the printer.
    rig.apply(vec![]);
    assert_eq!(rig.queues().len(), 1);
}

#[test]
fn a_renamed_queue_still_matches_by_its_comment() {
    let mut rig = Rig::new();
    rig.apply(vec![ipp("p1", "Front desk")]);
    rig.platform.with_world(|w| w.printers.iter_mut().find(|p| p.info.comment == "rulebox:p1").unwrap().info.name = "Reception printer (Rulebox)".into());
    let outcome = rig.apply(vec![ipp("p1", "Front desk")]);
    assert_eq!(states(&outcome), [("p1", "applied", None)]);
    assert_eq!(rig.mutating(), 0, "no second queue, no rename back");
    assert_eq!(rig.queues().len(), 1);
    // The restore finds it under its new name.
    assert!(journal::restore_all(&rig.ctx().journal).is_complete());
    assert!(rig.queues().is_empty());
}

#[test]
fn a_new_revision_rebuilds_the_queue_and_its_port() {
    let mut rig = Rig::new();
    rig.apply(vec![raw("p2", "Warehouse")]);
    let mut changed = raw("p2", "Warehouse annex");
    changed.address = "10.0.0.99".into();
    changed.revision = 2;
    let outcome = rig.apply(vec![changed]);
    assert_eq!(states(&outcome), [("p2", "applied", None)]);
    let queues = rig.queues();
    assert_eq!(queues.iter().map(|q| q.0.as_str()).collect::<Vec<_>>(), ["Warehouse annex (Rulebox)"]);
    let host = rig.platform.with_world(|w| w.printer_ports.iter().find(|p| p.name == "Rulebox_p2").and_then(|p| p.spec.clone()).unwrap().host);
    assert_eq!(host, "10.0.0.99");
    assert_eq!(rig.entry_ids(), ["printer-port:Rulebox_p2", "printer:p2"]);
    // The same revision again: nothing.
    let mut same = raw("p2", "Warehouse annex");
    same.address = "10.0.0.99".into();
    same.revision = 2;
    rig.apply(vec![same]);
    assert_eq!(rig.mutating(), 0);
}

#[test]
fn a_printer_the_document_drops_is_removed_with_its_port_and_a_foreign_queue_stays() {
    let mut rig = Rig::new();
    rig.platform.with_world(|w| {
        w.printers.push(SimPrinter {
            info: rulebox_win32::printing::PrinterInfo { name: "Shared (Rulebox)".into(), port: "FILE:".into(), driver: "x".into(), attributes: 64, comment: String::new() },
            sddl: None,
        });
    });
    rig.apply(vec![raw("p2", "Warehouse"), ipp("p1", "Front desk")]);
    assert_eq!(rig.queues().len(), 3);
    let outcome = rig.apply(vec![ipp("p1", "Front desk")]);
    assert_eq!(states(&outcome), [("p1", "applied", None)]);
    assert!(rig.ports().is_empty());
    assert_eq!(rig.queues().iter().map(|q| q.0.clone()).collect::<Vec<_>>(), ["Shared (Rulebox)", "Front desk (Rulebox)"]);
    assert_eq!(rig.entry_ids(), ["printer:p1"]);
    assert!(rig.shared.read(|s| s.printer_marks.keys().cloned().collect::<Vec<_>>()) == ["printer:p1"]);
}

#[test]
fn bad_items_fail_with_a_code_and_touch_nothing() {
    let mut rig = Rig::new();
    let mut no_queue = printer("p4", "Lpr", PrinterKind::Lpr, "10.0.0.22");
    no_queue.queue = None;
    let outcome = rig.apply(vec![
        ipp("bad id", "A"),
        printer("p5", "B", PrinterKind::Unknown, "x"),
        printer("p6", "C", PrinterKind::Ipp, "http://10.0.0.1/ipp/print"),
        no_queue,
        ipp("p7", "Back\\slash"),
        ipp("p8", " padded "),
    ]);
    assert_eq!(
        states(&outcome),
        [
            ("bad id", "failed", Some("bad_printer_id")),
            ("p5", "failed", Some("section_unknown_value")),
            ("p6", "failed", Some("address_invalid")),
            ("p4", "failed", Some("queue_required")),
            ("p7", "failed", Some("name_invalid")),
            ("p8", "failed", Some("name_invalid")),
        ]
    );
    assert_eq!(rig.mutating(), 0);
}

#[test]
fn an_unreadable_spooler_fails_every_item_and_keeps_what_is_there() {
    let mut rig = Rig::new();
    rig.apply(vec![ipp("p1", "Front desk")]);
    rig.platform.fail_next(SimOp::PrinterList, PlatformError::Other("boom".into()));
    let outcome = rig.apply(vec![ipp("p1", "Front desk")]);
    assert_eq!(states(&outcome), [("p1", "failed", Some("printers_unreadable"))]);
    assert_eq!(rig.mutating(), 0);
    assert_eq!(rig.queues().len(), 1);
    assert_eq!(rig.entry_ids(), ["printer:p1"]);
}

#[test]
fn a_failed_queue_keeps_its_port_and_the_next_apply_finishes_the_job() {
    let mut rig = Rig::new();
    rig.platform.fail_next(SimOp::PrinterAdd, PlatformError::Other("spooler stopped".into()));
    let outcome = rig.apply(vec![raw("p2", "Warehouse")]);
    assert_eq!(states(&outcome), [("p2", "failed", Some("printer_failed"))]);
    assert_eq!(rig.ports(), ["Rulebox_p2"]);
    assert!(rig.queues().is_empty());
    let outcome = rig.apply(vec![raw("p2", "Warehouse")]);
    assert_eq!(states(&outcome), [("p2", "applied", None)]);
    assert_eq!((rig.ports().len(), rig.queues().len()), (1, 1));
    // The driver vanishing between the check and the call is the same code as a missing driver.
    rig.platform.with_world(|w| w.printer_drivers.retain(|d| d != IPP_DRIVER));
    assert_eq!(states(&rig.apply(vec![ipp("p1", "Front desk")])), [("p1", "failed", Some("driver_missing"))]);
}

#[test]
fn a_queue_deleted_behind_our_back_is_created_again() {
    let mut rig = Rig::new();
    rig.apply(vec![ipp("p1", "Front desk")]);
    rig.platform.with_world(|w| w.printers.retain(|p| p.info.comment != "rulebox:p1"));
    let outcome = rig.apply(vec![ipp("p1", "Front desk")]);
    assert_eq!(states(&outcome), [("p1", "applied", None)]);
    assert_eq!(rig.queues().len(), 1);
}

// -- the default printer ------------------------------------------------------------------------

#[test]
fn the_default_printer_is_written_into_the_staff_hive_journalled_and_restored() {
    let mut rig = Rig::new();
    rig.platform.write_staff_value(STAFF, DEFAULT_KEY, DEFAULT_VALUE, &RegData::String("Old printer,winspool,Ne01:".into())).unwrap();
    let mut front = ipp("p1", "Front desk");
    front.is_default = true;
    let outcome = rig.apply(vec![front.clone(), raw("p2", "Warehouse")]);
    assert_eq!(states(&outcome), [("p1", "applied", None), ("p2", "applied", None)]);
    assert_eq!(rig.staff_value("Device"), Some(RegData::String("Front desk (Rulebox),winspool,Ne00:".into())));
    assert_eq!(rig.staff_value("LegacyDefaultPrinterMode"), Some(RegData::Dword(1)));
    let originals = rig.shared.read(|s| s.journal.iter().filter(|e| e.id.starts_with("staff:")).map(|e| (e.id.clone(), e.original.clone(), e.owner)).collect::<Vec<_>>());
    assert_eq!(
        originals,
        [
            ("staff:Software\\Microsoft\\Windows NT\\CurrentVersion\\Windows|Device".to_string(), OriginalValue::String("Old printer,winspool,Ne01:".into()), JournalOwner::Printer),
            ("staff:Software\\Microsoft\\Windows NT\\CurrentVersion\\Windows|LegacyDefaultPrinterMode".to_string(), OriginalValue::Absent, JournalOwner::Printer),
        ]
    );
    rig.apply(vec![front.clone(), raw("p2", "Warehouse")]);
    assert_eq!(rig.mutating(), 0);

    // A different default moves it; the original is still the first one.
    let mut other = raw("p2", "Warehouse");
    other.is_default = true;
    front.is_default = false;
    rig.apply(vec![front.clone(), other.clone()]);
    assert_eq!(rig.staff_value("Device"), Some(RegData::String("Warehouse (Rulebox),winspool,Ne00:".into())));
    // No default any more: the Staff values go back to what they were.
    other.is_default = false;
    rig.apply(vec![front, other]);
    assert_eq!(rig.staff_value("Device"), Some(RegData::String("Old printer,winspool,Ne01:".into())));
    assert_eq!(rig.staff_value("LegacyDefaultPrinterMode"), None);
    assert!(rig.entry_ids().iter().all(|id| !id.starts_with("staff:")));
}

#[test]
fn of_two_defaults_the_lowest_id_wins_and_a_failed_printer_is_never_the_default() {
    let mut rig = Rig::new();
    let mut a = ipp("p9", "Nine");
    let mut b = raw("p1", "One");
    a.is_default = true;
    b.is_default = true;
    rig.apply(vec![a.clone(), b.clone()]);
    assert_eq!(rig.staff_value("Device"), Some(RegData::String("One (Rulebox),winspool,Ne00:".into())));
    b.driver = "Missing driver".into();
    b.revision = 2;
    let outcome = rig.apply(vec![a, b]);
    assert_eq!(states(&outcome), [("p9", "applied", None), ("p1", "failed", Some("driver_missing"))]);
    assert_eq!(rig.staff_value("Device"), Some(RegData::String("Nine (Rulebox),winspool,Ne00:".into())));
}

#[test]
fn without_a_staff_account_there_is_nobody_to_set_a_default_for() {
    let mut rig = Rig::with_staff(false);
    let mut front = ipp("p1", "Front desk");
    front.is_default = true;
    let outcome = rig.apply(vec![front]);
    assert_eq!(states(&outcome), [("p1", "applied", None)]);
    assert_eq!(rig.entry_ids(), ["printer:p1"]);
}

// -- restore, crash points, the whole apply -----------------------------------------------------

#[test]
fn restoring_the_printer_owner_removes_everything_it_made() {
    let mut rig = Rig::new();
    let mut front = ipp("p1", "Front desk");
    front.is_default = true;
    rig.apply(vec![front, raw("p2", "Warehouse"), printer("s1", "Shared", PrinterKind::Share, "\\\\print01\\hp")]);
    assert!(!rig.entry_ids().is_empty());
    let report = journal::restore_owner(&rig.ctx().journal, JournalOwner::Printer);
    assert!(report.is_complete(), "{:?}", report.failed_ids());
    assert!(rig.queues().is_empty() && rig.ports().is_empty() && rig.entry_ids().is_empty());
    assert!(rig.platform.with_world(|w| w.printer_shares.is_empty()));
    assert!(rig.shared.read(|s| s.printer_marks.is_empty()));
    assert_eq!(rig.staff_value("Device"), None);
}

#[test]
fn a_crash_before_the_write_drops_the_entry_and_one_after_it_is_restorable() {
    let mut rig = Rig::new();
    journal::set_crash_point(Some(CrashPoint::AfterPending));
    let outcome = rig.apply(vec![ipp("p1", "Front desk")]);
    journal::set_crash_point(None);
    assert_eq!(states(&outcome), [("p1", "failed", Some("crashed"))]);
    assert!(rig.queues().is_empty());
    assert_eq!(journal::startup_recover(&rig.ctx().journal).dropped, ["printer:p1"]);

    journal::set_crash_point(Some(CrashPoint::AfterWrite));
    rig.apply(vec![ipp("p1", "Front desk")]);
    journal::set_crash_point(None);
    assert_eq!(rig.queues().len(), 1);
    assert_eq!(journal::startup_recover(&rig.ctx().journal).kept, ["printer:p1"]);
    assert!(journal::restore_all(&rig.ctx().journal).is_complete());
    assert!(rig.queues().is_empty());
}

#[test]
fn a_restore_that_fails_stays_restoring_and_is_retried() {
    let mut rig = Rig::new();
    rig.apply(vec![ipp("p1", "Front desk")]);
    rig.platform.fail_next(SimOp::PrinterDelete, PlatformError::Other("busy".into()));
    let report = journal::restore_all(&rig.ctx().journal);
    assert_eq!(report.failed_ids(), ["printer:p1"]);
    assert_eq!(rig.shared.read(|s| s.journal[0].phase), EntryPhase::Restoring);
    assert!(journal::startup_recover(&rig.ctx().journal).restore.is_complete());
    assert!(rig.queues().is_empty() && rig.entry_ids().is_empty());
}

#[test]
fn the_whole_apply_reports_the_printer_items_and_only_the_printer_layer_writes_them() {
    let rig = Rig::new();
    let doc = AgentDoc { printers: vec![ipp("p1", "Front desk"), raw("p2", "Warehouse")], ..AgentDoc::default() };
    let outcome = apply_all(&rig.ctx(), &doc).unwrap();
    assert_eq!(outcome.printers.iter().map(|p| p.state.as_str()).collect::<Vec<_>>(), ["applied", "applied"]);
    let report = outcome.report(7, None, ReportExtras::default());
    assert_eq!(report.printers, outcome.printers);
    assert!(rig.platform.calls().iter().any(|op| matches!(op, SimOp::PrinterAdd)));
    // A Phase 4 document (no printers, nothing of ours in the journal) makes no printer call at all.
    let quiet = Rig::new();
    apply_all(&quiet.ctx(), &AgentDoc::default()).unwrap();
    assert!(quiet.platform.calls().iter().all(|op| !matches!(op, SimOp::PrinterList | SimOp::PrinterDrivers | SimOp::PrinterAdd)));
}

#[test]
fn the_apply_never_installs_a_driver_and_only_ever_calls_the_printer_seam_it_needs() {
    let mut rig = Rig::new();
    rig.apply(vec![raw("p2", "Warehouse"), printer("s1", "Shared", PrinterKind::Share, "\\\\print01\\hp")]);
    let mutating: Vec<SimOp> = rig.platform.calls().into_iter().filter(|op| op.is_mutating()).collect();
    for op in &mutating {
        assert!(
            matches!(op, SimOp::PrinterPortAdd | SimOp::PrinterAdd | SimOp::PrinterShareConnect | SimOp::RunInstaller | SimOp::WriteStaffValue) && !matches!(op, SimOp::RunInstaller),
            "{op:?}"
        );
    }
    // The drivers of the store are what they were.
    assert_eq!(rig.platform.with_world(|w| w.printer_drivers.len()), 5);
}
