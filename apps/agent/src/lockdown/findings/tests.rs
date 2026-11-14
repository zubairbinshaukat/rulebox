//! Tests of the findings collector (plan 4.10 and 4.19, Phase 5 Step 9): event fixtures to
//! fingerprints, the privacy rule, the store bound and the flush rules.

use super::*;
use crate::lockdown::procwatch::Finding;
use crate::platform::sim::SimPlatform;
use crate::platform::EventRecord;
use crate::testutil::TempDir;

const STAFF: &str = "S-1-5-21-1-1-1-2001";
const EXE_CHANNEL: &str = "Microsoft-Windows-AppLocker/EXE and DLL";
const SCRIPT_CHANNEL: &str = "Microsoft-Windows-AppLocker/MSI and Script";
const CI_CHANNEL: &str = "Microsoft-Windows-CodeIntegrity/Operational";
const DAY: &str = "2026-11-08";
const NEXT_DAY_MS: u64 = 2_000_000_000;

fn ctx() -> FolderCtx {
    FolderCtx {
        os_drive: "C:".into(),
        windows: r"C:\Windows".into(),
        protected: vec![r"C:\Program Files\Rulebox".into()],
        system_volume: Some(r"\Device\HarddiskVolume3".into()),
        removable_volumes: vec![r"\Device\HarddiskVolume7".into(), "E:".into()],
    }
}

fn applocker_xml(id: u32, user: &str, path: &str, fqbn: &str, hash: &str) -> String {
    format!(
        "<Event xmlns=\"http://schemas.microsoft.com/win/2004/08/events/event\"><System>\
         <Provider Name=\"Microsoft-Windows-AppLocker\"/><EventID>{id}</EventID><Version>0</Version>\
         <EventRecordID>1</EventRecordID><Channel>Microsoft-Windows-AppLocker/EXE and DLL</Channel>\
         <Computer>PC-01</Computer><Security UserID=\"{user}\"/></System><UserData>\
         <RuleAndFileData xmlns=\"http://schemas.microsoft.com/schemas/event/Microsoft.Windows.AppLocker/2012\">\
         <PolicyName>EXE</PolicyName><RuleId>{{aaaa}}</RuleId><RuleName>Everyone</RuleName>\
         <TargetUser>{user}</TargetUser><TargetProcessId>4242</TargetProcessId>\
         <FilePath>{path}</FilePath><FileHash>{hash}</FileHash><Fqbn>{fqbn}</Fqbn>\
         <CommandLine>--token=hunter2 --open C:\\Users\\maya\\Documents\\salary.xlsx</CommandLine>\
         <WindowTitle>Quarterly salary - Excel</WindowTitle></RuleAndFileData></UserData></Event>"
    )
}

fn ci_xml(id: u32, policy: &str, file: &str) -> String {
    format!(
        "<Event xmlns=\"http://schemas.microsoft.com/win/2004/08/events/event\"><System>\
         <Provider Name=\"Microsoft-Windows-CodeIntegrity\"/><EventID>{id}</EventID>\
         <EventRecordID>1</EventRecordID><Security UserID=\"S-1-5-18\"/></System><EventData>\
         <Data Name=\"File Name\">{file}</Data>\
         <Data Name=\"Process Name\">\\Device\\HarddiskVolume3\\Users\\maya\\Documents\\salary-macro.xlsm</Data>\
         <Data Name=\"SHA256 Hash\">{hash}</Data><Data Name=\"PolicyName\">Rulebox</Data>\
         <Data Name=\"PolicyGUID\">{policy}</Data><Data Name=\"ProductName\">Tool &amp; Co</Data></EventData></Event>",
        hash = "AB".repeat(32)
    )
}

fn hash(c: char) -> String {
    c.to_string().repeat(64)
}

fn observation(name: &str) -> Observation {
    Observation {
        layer: FindingLayer::AppLocker,
        outcome: Outcome::Audit,
        file_name: name.into(),
        folder_class: "userTemp",
        signer: None,
        product: None,
        sha256: None,
    }
}

// ---------------------------------------------------------------- reading events

#[test]
fn an_applocker_audit_event_of_the_staff_account_becomes_an_observation() {
    let xml = applocker_xml(8003, STAFF, r"%OSDRIVE%\USERS\MAYA\APPDATA\LOCAL\TEMP\SETUP.EXE", "-", &hash('A'));
    let found = parse_applocker(&xml, STAFF, &ctx()).unwrap();
    assert_eq!((found.layer, found.outcome), (FindingLayer::AppLocker, Outcome::Audit));
    assert_eq!((found.file_name.as_str(), found.folder_class), ("SETUP.EXE", "userTemp"));
    assert_eq!(found.signer, None);
    // An unsigned file is told apart by its hash.
    assert_eq!(found.sha256.as_deref(), Some(hash('a').as_str()));
}

#[test]
fn a_signed_program_is_one_fingerprint_whatever_its_hash() {
    let fqbn = r"O=CONTOSO LTD, L=REDMOND, S=WASHINGTON, C=US\CONTOSO TOOL\TOOL.EXE\1.2.3.4";
    let path = r"%PROGRAMFILES%\CONTOSO\TOOL.EXE";
    let one = parse_applocker(&applocker_xml(8004, STAFF, path, fqbn, &hash('A')), STAFF, &ctx()).unwrap();
    let two = parse_applocker(&applocker_xml(8004, STAFF, path, fqbn, &hash('B')), STAFF, &ctx()).unwrap();
    assert_eq!(one.outcome, Outcome::Blocked);
    assert_eq!(one.signer.as_deref(), Some("O=CONTOSO LTD"));
    assert_eq!(one.product.as_deref(), Some("CONTOSO TOOL"));
    assert_eq!(one.folder_class, "programFiles");
    assert_eq!(one.sha256, None);
    assert_eq!(one.fingerprint(), two.fingerprint());
}

#[test]
fn other_accounts_other_events_and_unknown_staff_are_not_findings() {
    let path = r"%OSDRIVE%\TOOLS\X.EXE";
    let other = applocker_xml(8003, "S-1-5-21-9-9-9-500", path, "-", &hash('A'));
    assert!(parse_applocker(&other, STAFF, &ctx()).is_none(), "an administrator's event");
    let mine = applocker_xml(8003, STAFF, path, "-", &hash('A'));
    assert!(parse_applocker(&mine, "", &ctx()).is_none(), "without a Staff SID nothing can be attributed");
    // Allowed (8002) and error (8001, 8005) events say nothing about a stopped program.
    for id in [8001, 8002, 8005, 8020, 3076] {
        assert!(parse_applocker(&applocker_xml(id, STAFF, path, "-", &hash('A')), STAFF, &ctx()).is_none(), "{id}");
    }
    assert!(parse_applocker("<Event/>", STAFF, &ctx()).is_none());
    assert!(parse_applocker("<EventID>8003</EventID>", STAFF, &ctx()).is_none());
}

#[test]
fn applocker_paths_become_folder_classes_and_nothing_else() {
    let class = |path: &str| {
        parse_applocker(&applocker_xml(8003, STAFF, path, "-", &hash('A')), STAFF, &ctx()).unwrap().folder_class
    };
    assert_eq!(class(r"%WINDIR%\SYSTEM32\CMD.EXE"), "windows");
    assert_eq!(class(r"%SYSTEM32%\CMD.EXE"), "windows");
    assert_eq!(class(r"%PROGRAMFILES%\RULEBOX\RULEBOX-SHELL.EXE"), "rulebox");
    assert_eq!(class(r"%OSDRIVE%\USERS\MAYA\DOWNLOADS\A.EXE"), "userProfile");
    assert_eq!(class(r"%REMOVABLE%\E\A.EXE"), "removable");
    assert_eq!(class(r"%HOT%\A.EXE"), "removable");
    assert_eq!(class(r"\\SERVER\SHARE\A.EXE"), "network");
    assert_eq!(class(r"E:\A.EXE"), "removable");
    assert_eq!(class(r"D:\GAMES\A.EXE"), "other");
}

#[test]
fn code_integrity_events_count_for_rulebox_policies_only() {
    let blocks = "{427ecba1-e86b-448b-8dd8-04977e362e28}";
    let found = parse_code_integrity(&ci_xml(3076, blocks, r"\Device\HarddiskVolume3\Users\maya\AppData\Local\Temp\tool.exe"), &ctx()).unwrap();
    assert_eq!((found.layer, found.outcome), (FindingLayer::AppControl, Outcome::Audit));
    assert_eq!((found.file_name.as_str(), found.folder_class), ("tool.exe", "userTemp"));
    assert_eq!(found.product.as_deref(), Some("Tool & Co"), "entities are decoded");
    assert_eq!(found.sha256.as_deref(), Some("ab".repeat(32).as_str()));
    assert_eq!(found.signer, None);
    let blocked = parse_code_integrity(&ci_xml(3077, &blocks.to_uppercase(), r"\Device\HarddiskVolume3\Windows\x.exe"), &ctx()).unwrap();
    assert_eq!((blocked.outcome, blocked.folder_class), (Outcome::Blocked, "windows"));
    // Another product's policy, and other event ids.
    let foreign = "{11111111-2222-3333-4444-555555555555}";
    assert!(parse_code_integrity(&ci_xml(3077, foreign, r"\Device\HarddiskVolume3\x.exe"), &ctx()).is_none());
    assert!(parse_code_integrity(&ci_xml(3033, blocks, r"\Device\HarddiskVolume3\x.exe"), &ctx()).is_none());
}

#[test]
fn a_device_path_is_only_classified_when_its_volume_is_known() {
    let blocks = "{b0cfa9cb-9fa5-40f0-ad43-889657fdbb06}";
    let class = |path: &str, ctx: &FolderCtx| parse_code_integrity(&ci_xml(3076, blocks, path), ctx).unwrap().folder_class;
    assert_eq!(class(r"\Device\HarddiskVolume7\setup.exe", &ctx()), "removable");
    assert_eq!(class(r"\Device\HarddiskVolume9\setup.exe", &ctx()), "other", "an unknown volume is never guessed");
    let unknown = FolderCtx { system_volume: None, ..ctx() };
    assert_eq!(class(r"\Device\HarddiskVolume3\Windows\x.exe", &unknown), "other");
}

#[test]
fn the_fingerprint_follows_plan_4_10() {
    let text = "appLocker|setup.exe|userTemp|O=X|";
    let expected: String = Sha256::digest(text.as_bytes()).iter().map(|b| format!("{b:02x}")).collect();
    assert_eq!(fingerprint(FindingLayer::AppLocker, "SETUP.EXE", "userTemp", "O=X", ""), expected);
    // Layer, name, class, signer and hash all matter; the case of the name does not.
    let base = fingerprint(FindingLayer::AppLocker, "a.exe", "windows", "", "");
    assert_ne!(base, fingerprint(FindingLayer::AppControl, "a.exe", "windows", "", ""));
    assert_ne!(base, fingerprint(FindingLayer::AppLocker, "b.exe", "windows", "", ""));
    assert_ne!(base, fingerprint(FindingLayer::AppLocker, "a.exe", "other", "", ""));
    assert_ne!(base, fingerprint(FindingLayer::AppLocker, "a.exe", "windows", "O=X", ""));
    assert_ne!(base, fingerprint(FindingLayer::AppLocker, "a.exe", "windows", "", &hash('a')));
    assert_eq!(base, fingerprint(FindingLayer::AppLocker, "A.EXE", "windows", "", ""));
}

// ---------------------------------------------------------------- privacy (plan rule 6)

#[test]
fn nothing_but_the_allowed_fields_survives_an_event() {
    let dir = TempDir::new();
    let xml = applocker_xml(8003, STAFF, r"%OSDRIVE%\USERS\MAYA\DOCUMENTS\SALARY MACRO\RUN.EXE", "-", &hash('A'));
    let found = parse_applocker(&xml, STAFF, &ctx()).unwrap();
    let mut store = FindingsStore::open(dir.path().join("findings.json")).unwrap();
    store.ingest(&found, 1_000);
    store.save_if_dirty().unwrap();
    let on_disk = std::fs::read_to_string(dir.path().join("findings.json")).unwrap();
    let on_wire = serde_json::to_string(&store.next_flush()).unwrap();
    for text in [on_disk.as_str(), on_wire.as_str()] {
        for secret in ["hunter2", "salary", "SALARY", "maya", "MAYA", "Quarterly", "Excel", "Documents", "DOCUMENTS", "PC-01", "TargetProcess"] {
            assert!(!text.contains(secret), "{secret} leaked into {text}");
        }
    }
    assert!(on_wire.contains("RUN.EXE") && on_wire.contains("userProfile"));
    // Code Integrity: the process that started the file is in the event; it is not read.
    let ci = ci_xml(3076, "{427ecba1-e86b-448b-8dd8-04977e362e28}", r"\Device\HarddiskVolume3\Users\maya\x.exe");
    let found = parse_code_integrity(&ci, &ctx()).unwrap();
    let text = format!("{found:?}");
    assert!(!text.contains("salary") && !text.contains("maya"), "{text}");
}

// ---------------------------------------------------------------- the store

#[test]
fn a_sighting_counts_and_only_a_new_fingerprint_is_new() {
    let dir = TempDir::new();
    let mut store = FindingsStore::open(dir.path().join("findings.json")).unwrap();
    assert!(store.ingest(&observation("a.exe"), 10));
    assert!(store.ingest(&observation("b.exe"), 30));
    assert!(!store.ingest(&observation("A.EXE"), 40));
    assert_eq!(store.len(), 2);
    let a = store.all().iter().find(|f| f.file_name == "a.exe").unwrap();
    assert_eq!((a.first_seen_ms, a.last_seen_ms, a.count, a.reported), (10, 40, 2, false));
    // Seen again: moves to the recent end.
    assert_eq!(store.all().last().unwrap().file_name, "a.exe");
}

#[test]
fn the_store_is_bounded_and_forgets_what_the_server_knows_first() {
    let dir = TempDir::new();
    let mut store = FindingsStore::open(dir.path().join("findings.json")).unwrap();
    for n in 0..MAX_FINDINGS {
        store.ingest(&observation(&format!("f{n}.exe")), n as u64);
    }
    let known = vec![store.all()[10].fingerprint.clone()];
    store.mark_reported(&known, 1, DAY);
    store.ingest(&observation("one-more.exe"), 9_999);
    assert_eq!((store.len(), store.dropped()), (MAX_FINDINGS, 1));
    assert!(!store.all().iter().any(|f| f.fingerprint == known[0]), "the reported fingerprint went, not the oldest new one");
    assert!(store.all().iter().any(|f| f.file_name == "f0.exe"));
    // Nothing reported left: the least recently seen new one goes.
    let all: Vec<String> = store.all().iter().map(|f| f.fingerprint.clone()).collect();
    store.mark_reported(&all, 2, DAY);
    store.ingest(&observation("another.exe"), 10_000);
    assert_eq!(store.len(), MAX_FINDINGS);
    // The bound holds after a reload.
    store.save_if_dirty().unwrap();
    let reopened = FindingsStore::open(dir.path().join("findings.json")).unwrap();
    assert_eq!(reopened.len(), MAX_FINDINGS);
}

#[test]
fn procwatch_findings_join_the_store() {
    let dir = TempDir::new();
    let mut store = FindingsStore::open(dir.path().join("findings.json")).unwrap();
    let record = |name: &str, count: u64| FindingRecord {
        finding: Finding {
            fingerprint: fingerprint(FindingLayer::ProcWatch, name, "userTemp", "O=X", ""),
            layer: "procWatch",
            file_name: name.into(),
            folder_class: "userTemp",
            signer: Some("O=X".into()),
            product: Some("Tool".into()),
            reason: "not_allowed",
        },
        count,
    };
    assert_eq!(store.ingest_procwatch(vec![record("a.exe", 3), record("b.exe", 1)], 5), 2);
    assert_eq!(store.ingest_procwatch(vec![record("a.exe", 2)], 9), 0);
    let a = store.all().iter().find(|f| f.file_name == "a.exe").unwrap();
    assert_eq!((a.count, a.layer.as_str()), (5, "procWatch"));
    let report = store.next_flush();
    assert_eq!(report.len(), 2);
    assert!(report.iter().all(|f| f.layer == "procWatch" && f.sha256.is_none()));
}

// ---------------------------------------------------------------- flush rules (plan 4.19)

#[test]
fn nothing_new_means_no_call_and_no_timer() {
    let dir = TempDir::new();
    let mut store = FindingsStore::open(dir.path().join("findings.json")).unwrap();
    assert_eq!(store.flush_due(1_000, DAY, NEXT_DAY_MS), None);
    store.ingest(&observation("a.exe"), 1_000);
    let known = vec![store.all()[0].fingerprint.clone()];
    store.mark_reported(&known, 2_000, DAY);
    assert_eq!(store.flush_due(3_000, DAY, NEXT_DAY_MS), None, "a reported fingerprint is never sent again");
    // Seen again: still nothing to say.
    assert!(!store.ingest(&observation("a.exe"), 4_000));
    assert_eq!(store.flush_due(5_000, DAY, NEXT_DAY_MS), None);
    assert!(store.next_flush().is_empty());
}

#[test]
fn a_new_fingerprint_waits_for_company_a_full_batch_does_not() {
    let dir = TempDir::new();
    let mut store = FindingsStore::open(dir.path().join("findings.json")).unwrap();
    store.ingest(&observation("a.exe"), 10_000);
    assert_eq!(store.flush_due(10_000, DAY, NEXT_DAY_MS), Some(10_000 + FLUSH_SETTLE_MS));
    store.ingest(&observation("b.exe"), 20_000);
    assert_eq!(store.flush_due(20_000, DAY, NEXT_DAY_MS), Some(10_000 + FLUSH_SETTLE_MS), "the wait starts at the first");
    for n in 0..MAX_FINDINGS_PER_CALL {
        store.ingest(&observation(&format!("burst{n}.exe")), 30_000);
    }
    assert!(store.flush_due(30_000, DAY, NEXT_DAY_MS).unwrap() <= 30_000, "50 are ready");
    assert_eq!(store.next_flush().len(), MAX_FINDINGS_PER_CALL, "at most 50 per call");
}

#[test]
fn calls_are_spaced_and_at_most_four_per_server_day() {
    let dir = TempDir::new();
    let mut store = FindingsStore::open(dir.path().join("findings.json")).unwrap();
    let mut now = 1_000_000u64;
    let mut last_flush = 0;
    for round in 0..MAX_FLUSHES_PER_DAY {
        store.ingest(&observation(&format!("round{round}.exe")), now);
        let due = store.flush_due(now, DAY, NEXT_DAY_MS).unwrap();
        assert!(due >= now + FLUSH_SETTLE_MS);
        now = due;
        let sent: Vec<String> = store.next_flush().into_iter().map(|f| f.fingerprint).collect();
        assert_eq!(sent.len(), 1);
        store.mark_reported(&sent, now, DAY);
        last_flush = now;
        now += 1;
    }
    // The fifth new fingerprint of the day waits for the next server day ...
    store.ingest(&observation("late.exe"), now);
    assert_eq!(store.flush_due(now, DAY, NEXT_DAY_MS), Some(NEXT_DAY_MS));
    // ... where the counter starts again, but the two-hour gap still holds.
    let due = store.flush_due(now, "2026-11-09", NEXT_DAY_MS).unwrap();
    assert!(due >= now + FLUSH_SETTLE_MS && due >= last_flush + MIN_FLUSH_GAP_MS);
}

#[test]
fn an_unreachable_server_lets_the_file_grow_to_the_cap_and_then_everything_goes_out_in_batches() {
    let dir = TempDir::new();
    let path = dir.path().join("findings.json");
    let mut store = FindingsStore::open(path.clone()).unwrap();
    // 600 distinct programs while no call can be made.
    for n in 0..600 {
        store.ingest(&observation(&format!("p{n}.exe")), n as u64);
        if n % 100 == 0 {
            store.save_if_dirty().unwrap();
        }
    }
    store.save_if_dirty().unwrap();
    assert_eq!((store.len(), store.dropped()), (MAX_FINDINGS, 100));
    let mut store = FindingsStore::open(path).unwrap();
    // The server is back: calls of 50, oldest first, until nothing is left.
    let mut sent = 0;
    let mut calls = 0;
    while store.unreported() > 0 {
        let batch = store.next_flush();
        assert!(batch.len() <= MAX_FINDINGS_PER_CALL);
        sent += batch.len();
        calls += 1;
        let ids: Vec<String> = batch.into_iter().map(|f| f.fingerprint).collect();
        store.mark_reported(&ids, calls, DAY);
    }
    assert_eq!((sent, calls), (MAX_FINDINGS, 10));
}

// ---------------------------------------------------------------- the collector

fn log(sim: &SimPlatform, channel: &str, events: Vec<(u64, String)>) {
    sim.with_world(|world| {
        world.event_logs.insert(
            channel.to_string(),
            events.into_iter().map(|(record_id, xml)| EventRecord { record_id, xml }).collect(),
        );
    });
}

#[test]
fn the_collector_reads_each_channel_once_and_keeps_its_bookmark() {
    let dir = TempDir::new();
    let sim = SimPlatform::new(dir.path().to_path_buf());
    let temp = r"%OSDRIVE%\USERS\MAYA\APPDATA\LOCAL\TEMP\A.EXE";
    log(&sim, EXE_CHANNEL, vec![(5, applocker_xml(8003, STAFF, temp, "-", &hash('A'))), (6, applocker_xml(8004, STAFF, temp, "-", &hash('B')))]);
    log(&sim, SCRIPT_CHANNEL, vec![(2, applocker_xml(8006, STAFF, r"%OSDRIVE%\TOOLS\RUN.PS1", "-", &hash('C')))]);
    log(&sim, CI_CHANNEL, vec![(9, ci_xml(3077, "{427ecba1-e86b-448b-8dd8-04977e362e28}", r"\Device\HarddiskVolume3\Users\maya\x.exe"))]);
    let mut collector = Collector::open(dir.path().join("findings.json"), dir.path().join("findings-state.json")).unwrap();
    let stats = collector.collect(&sim, Some(STAFF), &ctx(), 100);
    assert_eq!(stats.events, 4);
    assert_eq!(stats.new_fingerprints, 4, "two unsigned hashes of one name are two fingerprints");
    assert_eq!((stats.blocked_app_locker, stats.blocked_app_control), (1, 1));
    assert_eq!(collector.bookmark(EXE_CHANNEL), 6);
    assert_eq!(collector.bookmark(CI_CHANNEL), 9);
    // Nothing new in the logs: nothing read again, nothing counted.
    let again = collector.collect(&sim, Some(STAFF), &ctx(), 200);
    assert_eq!((again.events, again.new_fingerprints, again.blocked_app_locker), (0, 0, 0));
    // The bookmarks survive a restart: a new event only.
    log(
        &sim,
        EXE_CHANNEL,
        vec![
            (5, applocker_xml(8003, STAFF, temp, "-", &hash('A'))),
            (6, applocker_xml(8004, STAFF, temp, "-", &hash('B'))),
            (7, applocker_xml(8004, STAFF, temp, "-", &hash('B'))),
        ],
    );
    let mut reopened = Collector::open(dir.path().join("findings.json"), dir.path().join("findings-state.json")).unwrap();
    assert_eq!(reopened.store.len(), 4);
    let after = reopened.collect(&sim, Some(STAFF), &ctx(), 300);
    assert_eq!((after.events, after.new_fingerprints, after.blocked_app_locker), (1, 0, 1));
}

#[test]
fn without_a_staff_account_applocker_events_are_skipped_but_the_bookmark_moves() {
    let dir = TempDir::new();
    let sim = SimPlatform::new(dir.path().to_path_buf());
    log(&sim, EXE_CHANNEL, vec![(3, applocker_xml(8003, STAFF, r"%OSDRIVE%\A.EXE", "-", &hash('A')))]);
    let mut collector = Collector::open(dir.path().join("findings.json"), dir.path().join("findings-state.json")).unwrap();
    let stats = collector.collect(&sim, None, &ctx(), 1);
    assert_eq!((stats.events, stats.new_fingerprints), (1, 0));
    assert_eq!(collector.bookmark(EXE_CHANNEL), 3);
}

#[test]
fn more_than_one_read_of_events_is_followed_up() {
    let dir = TempDir::new();
    let sim = SimPlatform::new(dir.path().to_path_buf());
    let events: Vec<(u64, String)> = (1..=700u64)
        .map(|id| (id, applocker_xml(8003, STAFF, &format!(r"%OSDRIVE%\TOOLS\T{id}.EXE"), "-", &hash('A'))))
        .collect();
    log(&sim, EXE_CHANNEL, events);
    let mut collector = Collector::open(dir.path().join("findings.json"), dir.path().join("findings-state.json")).unwrap();
    let stats = collector.collect(&sim, Some(STAFF), &ctx(), 1);
    assert_eq!(stats.events, 700);
    assert_eq!(collector.bookmark(EXE_CHANNEL), 700);
    assert_eq!(collector.store.len(), MAX_FINDINGS, "the store keeps its bound");
}

#[test]
fn an_unreadable_channel_is_counted_and_does_not_stop_the_others() {
    let dir = TempDir::new();
    let sim = SimPlatform::new(dir.path().to_path_buf());
    log(&sim, CI_CHANNEL, vec![(1, ci_xml(3076, "{427ecba1-e86b-448b-8dd8-04977e362e28}", r"\Device\HarddiskVolume3\x.exe"))]);
    sim.fail_next(crate::platform::sim::SimOp::ReadEventLog, crate::platform::PlatformError::Other("denied".into()));
    let mut collector = Collector::open(dir.path().join("findings.json"), dir.path().join("findings-state.json")).unwrap();
    let stats = collector.collect(&sim, Some(STAFF), &ctx(), 1);
    assert_eq!(stats.unreadable, 1);
    assert_eq!(stats.new_fingerprints, 1);
}

#[test]
fn clear_removes_both_files() {
    let dir = TempDir::new();
    let sim = SimPlatform::new(dir.path().to_path_buf());
    log(&sim, CI_CHANNEL, vec![(1, ci_xml(3076, "{427ecba1-e86b-448b-8dd8-04977e362e28}", r"\Device\HarddiskVolume3\x.exe"))]);
    let (findings, state) = (dir.path().join("findings.json"), dir.path().join("findings-state.json"));
    let mut collector = Collector::open(findings.clone(), state.clone()).unwrap();
    collector.collect(&sim, Some(STAFF), &ctx(), 1);
    assert!(findings.exists() && state.exists());
    collector.clear().unwrap();
    assert!(!findings.exists() && !state.exists());
    assert_eq!(collector.store.len(), 0);
}
