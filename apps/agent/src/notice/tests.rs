//! Tests of the notice hub, the acknowledgement queue and the 1.3 requests (Phase 5 Step 12).

use std::sync::atomic::{AtomicU64, Ordering};

use rulebox_ipc::Frame;
use rulebox_policy::lockdown::WinCombos;
use rulebox_policy::notice::BroadcastStyle;
use serde_json::{json, Value};
use tokio::sync::broadcast::Receiver;

use super::*;
use crate::testutil::{test_snapshot, TempDir};

const DAY_MS: u64 = 86_400_000;
/// "Now" of the tests, in server time.
const T: u64 = 1_800_000_000_000;

fn broadcast(id: &str, issued: u64, expires: Option<u64>, ack_required: bool) -> Broadcast {
    Broadcast {
        id: id.into(),
        style: BroadcastStyle::Banner,
        title: format!("title {id}"),
        body: format!("body {id}"),
        expires_at_ms: expires,
        ack_required,
        issued_at_ms: issued,
    }
}

fn doc_with(broadcasts: &[Broadcast]) -> Value {
    json!({ "broadcasts": serde_json::to_value(broadcasts).unwrap() })
}

fn policy_of(doc: &Value) -> AgentPolicy {
    AgentPolicy::from_doc(Some(doc))
}

/// A catalogue with one web app and the built-in files tool.
fn catalogue_doc() -> Value {
    let web = json!({
        "id": "orders-web", "name": "Orders", "description": null, "kind": "web", "builtin": null,
        "web": { "url": "https://orders.example.test/", "allowedDomains": ["orders.example.test"],
                 "permissions": { "camera": false, "microphone": false, "screenShare": false,
                                  "clipboardRead": false, "notifications": true, "downloads": true,
                                  "printing": false, "geolocation": false } },
        "desktop": null, "pinnedTaskbar": true, "pinnedDesktop": true, "hue": null, "icon": null,
        "audience": "everyone", "employeeIds": [], "revision": 1
    });
    json!({ "catalog": [web] })
}

struct Rig {
    hub: Arc<NoticeHub>,
    snapshot: SnapshotHandle,
    events: Receiver<Frame>,
    /// The device clock; the snapshot's offset turns it into server time.
    clock: Arc<AtomicU64>,
    dir: TempDir,
}

impl Rig {
    /// A device whose clock is `device_minus_server` ms ahead of the server's (negative: behind).
    fn new(device_ahead_ms: i64) -> Self {
        let dir = TempDir::new();
        let mut snapshot = test_snapshot();
        snapshot.server_time_offset_ms = Some(-device_ahead_ms);
        let (handle, _rx) = SnapshotHandle::new(snapshot);
        let shell = ShellBroadcast::new();
        let events = shell.subscribe();
        let clock = Arc::new(AtomicU64::new(T.saturating_add_signed(device_ahead_ms)));
        let now = Arc::clone(&clock);
        let hub = NoticeHub::new(
            AckQueue::open(dir.path().join("broadcast-acks.json")).unwrap(),
            handle.clone(),
            shell,
            Arc::new(move || now.load(Ordering::SeqCst)),
        );
        Self { hub, snapshot: handle, events, clock, dir }
    }

    fn views(&self) -> Vec<BroadcastView> {
        self.snapshot.current().broadcasts
    }

    /// The names of the events waiting.
    fn event_names(&mut self) -> Vec<String> {
        let mut names = Vec::new();
        while let Ok(frame) = self.events.try_recv() {
            if let Frame::Event { event, .. } = frame {
                names.push(event);
            }
        }
        names
    }
}

fn ids(views: &[BroadcastView]) -> Vec<&str> {
    views.iter().map(|view| view.id.as_str()).collect()
}

// ---- the pure list ------------------------------------------------------------------

#[test]
fn the_list_is_newest_first_at_most_five_and_without_expired_or_duplicate_ones() {
    let list = vec![
        broadcast("old", 100, None, false),
        broadcast("expired", 500, Some(T - 1), false),
        broadcast("a", 300, Some(T + 1), false),
        broadcast("b", 400, None, true),
        broadcast("b", 999, None, false), // the same id again: the first one stays
        broadcast("c", 200, None, false),
        broadcast("d", 250, None, false),
        broadcast("e", 150, None, false),
        broadcast("f", 120, None, false),
    ];
    let views = broadcast_views(&list, &HashSet::new(), T);
    assert_eq!(ids(&views), ["b", "a", "d", "c", "e"]);
    assert!(views[0].ack_required && !views[1].ack_required);
    // At exactly the expiry second it is gone (`expires > now` is the rule).
    assert!(ids(&broadcast_views(&list, &HashSet::new(), T + 1)).iter().all(|id| *id != "a"));
}

#[test]
fn the_acknowledged_flag_follows_the_set() {
    let list = vec![broadcast("a", 1, None, true), broadcast("b", 2, None, true)];
    let acked: HashSet<String> = ["a".to_string()].into();
    let views = broadcast_views(&list, &acked, T);
    assert_eq!(views.iter().map(|v| (v.id.as_str(), v.acknowledged)).collect::<Vec<_>>(), [("b", false), ("a", true)]);
}

#[test]
fn the_next_expiry_is_the_earliest_future_one() {
    let list = vec![
        broadcast("a", 1, Some(T - 5), false),
        broadcast("b", 1, Some(T + 50), false),
        broadcast("c", 1, Some(T + 20), false),
        broadcast("d", 1, None, false),
    ];
    assert_eq!(next_expiry_ms(&list, T), Some(T + 20));
    assert_eq!(next_expiry_ms(&[broadcast("d", 1, None, false)], T), None);
}

// ---- the acknowledgement queue --------------------------------------------------------

#[test]
fn an_acknowledgement_is_queued_once_and_survives_a_restart() {
    let dir = TempDir::new();
    let path = dir.path().join("broadcast-acks.json");
    let mut queue = AckQueue::open(path.clone()).unwrap();
    assert!(queue.queue("b1", 10));
    assert!(!queue.queue("b1", 20), "a second OK queues nothing");
    assert!(queue.queue("b2", 30));

    let reopened = AckQueue::open(path.clone()).unwrap();
    assert!(reopened.contains("b1") && reopened.contains("b2"));
    // The exact entry `deviceApi:reportAcks` takes: `{ broadcastId, atMs }` and nothing else.
    let pending = serde_json::to_value(reopened.pending()).unwrap();
    assert_eq!(pending, json!([{ "broadcastId": "b1", "atMs": 10 }, { "broadcastId": "b2", "atMs": 30 }]));
    // No employee, device clock or user name in the file.
    let text = std::fs::read_to_string(&path).unwrap();
    assert!(!text.contains("employee") && !text.contains("user"), "{text}");
}

#[test]
fn sent_acknowledgements_leave_the_pending_list_and_are_pruned_when_the_broadcast_is_gone() {
    let dir = TempDir::new();
    let mut queue = AckQueue::open(dir.path().join("acks.json")).unwrap();
    queue.queue("keep", 1);
    queue.queue("gone", 2);
    queue.queue("unsent-gone", 3);
    queue.mark_sent(&["keep".to_string(), "gone".to_string()]);
    assert_eq!(queue.pending().iter().map(|a| a.broadcast_id.as_str()).collect::<Vec<_>>(), ["unsent-gone"]);

    let listed: HashSet<&str> = ["keep"].into();
    queue.prune(&listed);
    assert!(queue.contains("keep"), "still listed: the flag stays");
    assert!(!queue.contains("gone"), "sent and no longer listed: dropped");
    assert!(queue.contains("unsent-gone"), "not sent yet: kept until it is");
}

#[test]
fn a_call_carries_at_most_twenty_and_the_file_stays_small() {
    let dir = TempDir::new();
    let mut queue = AckQueue::open(dir.path().join("acks.json")).unwrap();
    for n in 0..(MAX_ACK_RECORDS + 30) {
        queue.queue(&format!("b{n}"), n as u64);
    }
    assert_eq!(queue.pending().len(), MAX_ACKS_PER_CALL);
    assert!(queue.acknowledged().len() <= MAX_ACK_RECORDS);
}

// ---- the event gate -------------------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn the_gate_lets_one_event_per_two_seconds_through_and_holds_the_rest() {
    let mut gate = EventGate::default();
    let start = Instant::now();
    assert!(gate.offer(start), "the first change goes out at once");
    assert!(!gate.offer(start + Duration::from_millis(500)), "inside the gap: held");
    assert!(!gate.offer(start + Duration::from_millis(900)), "still one held event, not two");
    assert_eq!(gate.due(), Some(start + EVENT_GAP));
    assert!(!gate.take_due(start + Duration::from_millis(1999)));
    assert!(gate.take_due(start + EVENT_GAP), "the held event goes out when the gap is over");
    assert!(!gate.take_due(start + EVENT_GAP * 2), "and only once");
    assert_eq!(gate.due(), None);
    // After a quiet gap the next change goes out at once again.
    assert!(gate.offer(start + EVENT_GAP * 4));
}

// ---- the hub --------------------------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn the_hub_puts_the_list_in_the_snapshot_and_announces_it_once() {
    let mut rig = Rig::new(0);
    let policy = policy_of(&doc_with(&[broadcast("a", 1, None, false), broadcast("b", 2, None, true)]));
    rig.hub.on_policy(&policy);
    assert_eq!(ids(&rig.views()), ["b", "a"]);
    assert_eq!(rig.event_names(), ["broadcasts.changed"]);
    // The same policy again changes nothing and says nothing.
    rig.hub.on_policy(&policy);
    assert!(rig.event_names().is_empty());
}

#[tokio::test(start_paused = true)]
async fn a_burst_of_changes_is_one_event_now_and_one_when_the_gap_is_over() {
    let mut rig = Rig::new(0);
    rig.hub.on_policy(&policy_of(&doc_with(&[broadcast("a", 1, None, false)])));
    assert_eq!(rig.event_names(), ["broadcasts.changed"]);
    // Two more changes within the gap.
    tokio::time::advance(Duration::from_millis(300)).await;
    rig.hub.on_policy(&policy_of(&doc_with(&[broadcast("a", 1, None, false), broadcast("b", 2, None, false)])));
    tokio::time::advance(Duration::from_millis(300)).await;
    rig.hub.on_policy(&policy_of(&doc_with(&[broadcast("b", 2, None, false)])));
    assert!(rig.event_names().is_empty(), "held, not sent");
    assert_eq!(ids(&rig.views()), ["b"], "the snapshot is current at once");
    // The task's wake-up time is the end of the gap.
    assert!(rig.hub.next_wake() <= Duration::from_millis(1400), "{:?}", rig.hub.next_wake());
    tokio::time::advance(Duration::from_millis(1500)).await;
    rig.hub.flush_held_event();
    assert_eq!(rig.event_names(), ["broadcasts.changed"]);
}

/// Cleared (the document has none) and expired (the clock passed it) both take a broadcast out.
#[tokio::test(start_paused = true)]
async fn an_expired_broadcast_leaves_the_snapshot_and_the_device_clock_two_days_wrong_does_not_matter() {
    // The device clock is two days AHEAD of the server's. Judged by the device clock, a broadcast
    // that expires in a minute (server time) would have ended two days ago.
    let mut rig = Rig::new(2 * DAY_MS as i64);
    rig.hub.on_policy(&policy_of(&doc_with(&[broadcast("soon", 1, Some(T + 60_000), false)])));
    assert_eq!(ids(&rig.views()), ["soon"], "server time is used, not the device's");
    assert_eq!(rig.hub.next_wake(), Duration::from_millis(60_000));
    let _ = rig.event_names();

    // A minute later (device clock moves with it) the hub drops it by itself.
    rig.clock.fetch_add(60_000, Ordering::SeqCst);
    tokio::time::advance(Duration::from_secs(61)).await;
    rig.hub.refresh();
    assert!(rig.views().is_empty());
    assert_eq!(rig.event_names(), ["broadcasts.changed"]);

    // And a device clock two days BEHIND: a broadcast that ended an hour ago (server time) never shows.
    let behind = Rig::new(-(2 * DAY_MS as i64));
    behind.hub.on_policy(&policy_of(&doc_with(&[broadcast("late", 1, Some(T - 3_600_000), false)])));
    assert!(behind.views().is_empty(), "a slow device clock does not bring an old broadcast back");
}

#[tokio::test(start_paused = true)]
async fn acknowledging_flags_the_broadcast_queues_one_ack_at_server_time_and_is_idempotent() {
    let mut rig = Rig::new(DAY_MS as i64);
    rig.hub.on_policy(&policy_of(&doc_with(&[broadcast("b1", 1, None, true)])));
    let _ = rig.event_names();
    // Past the gap of the first event, so the next change is announced at once.
    tokio::time::advance(Duration::from_secs(3)).await;

    assert!(rig.hub.acknowledge("b1"));
    assert!(rig.views()[0].acknowledged);
    assert_eq!(rig.hub.pending_acks(), [Ack { broadcast_id: "b1".into(), at_ms: T }], "server time, not the device's");
    assert_eq!(rig.event_names(), ["broadcasts.changed"]);

    // A second OK (another monitor, a double click): true, nothing new queued.
    tokio::time::advance(Duration::from_secs(5)).await;
    assert!(rig.hub.acknowledge("b1"));
    assert_eq!(rig.hub.pending_acks().len(), 1);

    // The server took it; the flag stays while the broadcast is listed.
    rig.hub.acks_sent(&["b1".to_string()]);
    assert!(rig.hub.pending_acks().is_empty());
    assert!(rig.views()[0].acknowledged);
    // The broadcast leaves the document: the flag and the record go.
    rig.hub.on_policy(&policy_of(&doc_with(&[])));
    assert!(rig.views().is_empty());
}

#[tokio::test(start_paused = true)]
async fn an_unknown_or_expired_id_is_not_acknowledged() {
    let rig = Rig::new(0);
    rig.hub.on_policy(&policy_of(&doc_with(&[broadcast("live", 1, None, true), broadcast("dead", 1, Some(T - 1), true)])));
    assert!(!rig.hub.acknowledge("nobody"));
    assert!(!rig.hub.acknowledge("dead"));
    assert!(rig.hub.pending_acks().is_empty());
    assert!(rig.hub.acknowledge("live"));
}

#[tokio::test(start_paused = true)]
async fn the_acknowledgement_survives_an_agent_restart() {
    let rig = Rig::new(0);
    rig.hub.on_policy(&policy_of(&doc_with(&[broadcast("b1", 1, None, true)])));
    assert!(rig.hub.acknowledge("b1"));

    // A new hub over the same file: the flag is still set, nothing needs the employee again.
    let (handle, _rx) = SnapshotHandle::new(test_snapshot());
    let hub = NoticeHub::new(
        AckQueue::open(rig.dir.path().join("broadcast-acks.json")).unwrap(),
        handle.clone(),
        ShellBroadcast::new(),
        Arc::new(|| T),
    );
    hub.on_policy(&policy_of(&doc_with(&[broadcast("b1", 1, None, true)])));
    assert!(handle.current().broadcasts[0].acknowledged);
    assert_eq!(hub.pending_acks().len(), 1);
}

#[tokio::test(start_paused = true)]
async fn a_lock_set_or_cleared_is_announced_and_only_then() {
    let mut rig = Rig::new(0);
    let locked = json!({ "deviceLock": { "lockId": "l1", "message": "Call IT", "contact": "x", "lockedAtMs": 5 } });
    rig.hub.on_policy(&policy_of(&locked));
    assert_eq!(rig.event_names(), ["device.lockChanged"]);
    rig.hub.on_policy(&policy_of(&locked));
    assert!(rig.event_names().is_empty(), "the same lock again: nothing");
    // A replaced lock (a new lockId) is a change.
    rig.hub.on_policy(&policy_of(&json!({ "deviceLock": { "lockId": "l2", "message": "m", "lockedAtMs": 6 } })));
    assert_eq!(rig.event_names(), ["device.lockChanged"]);
    rig.hub.on_policy(&policy_of(&json!({})));
    assert_eq!(rig.event_names(), ["device.lockChanged"]);
}

// ---- the policy side --------------------------------------------------------------------

#[test]
fn the_lock_reaches_the_snapshot_as_a_view_and_long_text_is_cut_not_dropped() {
    let long = "m".repeat(400);
    let policy = policy_of(&json!({ "deviceLock": { "lockId": "l1", "message": long, "contact": "  ", "lockedAtMs": 5 } }));
    let mut snapshot = test_snapshot();
    policy.apply_to_snapshot(&mut snapshot);
    let view = snapshot.device_lock.expect("a lock");
    assert_eq!(view.lock_id, "l1");
    assert_eq!(view.message.chars().count(), 300, "cut to the plan's limit, still a lock (fail closed)");
    assert_eq!(view.contact, None, "a blank contact is no contact");

    // No lock, or one of the wrong type: none. (A broken value must not lock a PC by accident.)
    for doc in [json!({}), json!({ "deviceLock": null }), json!({ "deviceLock": "yes" })] {
        let mut snapshot = test_snapshot();
        policy_of(&doc).apply_to_snapshot(&mut snapshot);
        assert_eq!(snapshot.device_lock, None, "{doc}");
    }
}

#[test]
fn the_keyboard_printing_and_network_fields_follow_the_document() {
    let mut snapshot = test_snapshot();
    // No document, or a Phase 4 document: no lockdown section = combinations pass.
    AgentPolicy::default().apply_to_snapshot(&mut snapshot);
    assert_eq!(snapshot.keyboard.unwrap().win_combos, WinCombos::Pass);
    assert_eq!(snapshot.printing, Some(rulebox_ipc::types::PrintingView { available: false }));
    assert_eq!(snapshot.network, Some(rulebox_ipc::types::NetworkView { managed_only: false, ssids: vec![] }));

    // A lockdown section without a `keyboard` key takes the policy default: swallow.
    let combos = |doc: Value| {
        let mut snapshot = test_snapshot();
        policy_of(&doc).apply_to_snapshot(&mut snapshot);
        snapshot.keyboard.unwrap().win_combos
    };
    assert_eq!(combos(json!({ "lockdown": {} })), WinCombos::Swallow);
    assert_eq!(combos(json!({ "lockdown": { "keyboard": { "winCombos": "pass" } } })), WinCombos::Pass);
    assert_eq!(combos(json!({ "lockdown": { "keyboard": { "winCombos": "swallow" } } })), WinCombos::Swallow);
    // A value a newer server adds is Unknown: the Staff App reads it as swallow.
    assert_eq!(combos(json!({ "lockdown": { "keyboard": { "winCombos": "explode" } } })), WinCombos::Unknown);
    assert_eq!(combos(json!({ "lockdown": null })), WinCombos::Pass);

    let policy = policy_of(&json!({
        "printers": [{ "id": "p1" }],
        "wifiManagedOnly": true,
        "wifi": [{ "id": "w1", "ssid": "Shop" }, { "id": "w2", "ssid": "Back" }, { "id": "w3" }],
    }));
    let mut snapshot = test_snapshot();
    policy.apply_to_snapshot(&mut snapshot);
    assert!(snapshot.printing.unwrap().available);
    let network = snapshot.network.unwrap();
    assert!(network.managed_only);
    assert_eq!(network.ssids, ["Shop", "Back"], "an entry with no SSID is skipped, no sealed box is read");
}

#[test]
fn one_bad_broadcast_does_not_cost_the_others() {
    let policy = policy_of(&json!({ "broadcasts": [
        { "id": "ok", "style": "banner", "title": "t", "body": "b", "ackRequired": false, "issuedAtMs": 1 },
        { "id": "broken" },
        { "id": "long", "style": "banner", "title": "t", "body": "x".repeat(501), "ackRequired": false, "issuedAtMs": 1 },
        { "id": "later", "style": "hologram", "title": "t", "body": "b", "ackRequired": true, "issuedAtMs": 2 },
    ] }));
    let kept: Vec<&str> = policy.broadcasts.iter().map(|b| b.id.as_str()).collect();
    assert_eq!(kept, ["ok", "later"], "unparseable and over-long ones are dropped");
    assert_eq!(policy.broadcasts[1].style, BroadcastStyle::Unknown);
}

#[tokio::test(start_paused = true)]
async fn broadcast_text_travels_unchanged_html_characters_included() {
    // The agent never escapes or strips: the Staff App renders text as text. (Rendered literally
    // there; see the React tests.)
    let rig = Rig::new(0);
    let mut item = broadcast("h", 1, None, false);
    item.title = "<b>Back</b> & \"soon\"".into();
    item.body = "<script>alert(1)</script>".into();
    rig.hub.on_policy(&policy_of(&doc_with(&[item])));
    let view = &rig.views()[0];
    assert_eq!(view.title, "<b>Back</b> & \"soon\"");
    assert_eq!(view.body, "<script>alert(1)</script>");
}

// ---- the requests ---------------------------------------------------------------------

#[derive(Default)]
struct RecordingSink(Mutex<Vec<(String, String, String, u64)>>);

impl DenialSink for RecordingSink {
    fn add(&self, day: &str, app_id: &str, kind: &str, count: u64) {
        lock(&self.0).push((day.into(), app_id.into(), kind.into(), count));
    }
}

struct Ext {
    ext: NoticeExtension,
    sink: Arc<RecordingSink>,
    rig: Rig,
    _senders: (watch::Sender<AgentPolicy>, watch::Sender<AgentSnapshot>),
}

fn ext() -> Ext {
    let rig = Rig::new(0);
    let (policy_tx, policy_rx) = watch::channel(policy_of(&catalogue_doc()));
    let sink = Arc::new(RecordingSink::default());
    let (snapshot_tx, snapshot_rx) = watch::channel(test_snapshot());
    let ext = NoticeExtension::new(
        Arc::clone(&rig.hub),
        policy_rx,
        snapshot_rx,
        Some(Arc::clone(&sink) as Arc<dyn DenialSink>),
        Arc::new(|| T),
    );
    Ext { ext, sink, rig, _senders: (policy_tx, snapshot_tx) }
}

fn peer() -> PeerCtx {
    PeerCtx { connection_id: 1, pid: 1, session_id: 1, role: rulebox_ipc::types::ClientRole::Shell }
}

async fn call(ext: &NoticeExtension, method: &str, params: Value) -> Result<Value, RpcError> {
    ext.handle(&peer(), method, params).expect("the extension answers this method").await
}

#[test]
fn the_extension_lists_the_four_capabilities_and_only_its_two_methods() {
    let Ext { ext, .. } = ext();
    assert_eq!(ext.capabilities(), ["deviceLock", "broadcasts", "keyboardPolicy", "permissionReports"]);
    assert!(ext.handle(&peer(), "session.signIn", json!({})).is_none());
    assert!(ext.handle(&peer(), "broadcast.other", json!({})).is_none());
}

#[tokio::test(start_paused = true)]
async fn broadcast_acknowledge_answers_ok_true_for_a_live_broadcast_and_false_for_any_other() {
    let e = ext();
    e.rig.hub.on_policy(&policy_of(&doc_with(&[broadcast("b1", 1, None, true)])));
    assert_eq!(call(&e.ext, "broadcast.acknowledge", json!({ "id": "b1" })).await.unwrap(), json!({ "ok": true }));
    assert_eq!(call(&e.ext, "broadcast.acknowledge", json!({ "id": "zzz" })).await.unwrap(), json!({ "ok": false }));
    for bad in [json!({}), json!({ "id": 5 }), json!({ "id": "" }), json!({ "id": "x".repeat(65) })] {
        let error = call(&e.ext, "broadcast.acknowledge", bad.clone()).await.unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidParams, "{bad}");
    }
    assert_eq!(e.rig.hub.pending_acks().len(), 1, "only the live one was queued");
}

#[tokio::test]
async fn denial_counts_are_validated_summed_clamped_and_filed_under_the_server_day() {
    let e = ext();
    let answer = call(
        &e.ext,
        "webapp.reportDenials",
        json!({ "counts": [
            { "appId": "orders-web", "kind": "camera", "count": 3 },
            { "appId": "orders-web", "kind": "camera", "count": 4 },
            { "appId": "orders-web", "kind": "screenShare", "count": 50_000 },
            { "appId": "not-in-catalogue", "kind": "camera", "count": 9 },
            { "appId": "orders-web", "kind": "teleport", "count": 9 },
            { "appId": "orders-web", "kind": "geolocation", "count": 0 },
        ] }),
    )
    .await
    .unwrap();
    assert_eq!(answer, json!({ "ok": true }));
    let mut recorded = lock(&e.sink.0).clone();
    recorded.sort();
    assert_eq!(
        recorded,
        [
            ("2027-01-15".to_string(), "orders-web".to_string(), "camera".to_string(), 7),
            ("2027-01-15".to_string(), "orders-web".to_string(), "screenShare".to_string(), 10_000),
        ],
        "unknown app and kind and zero counts are dropped; the same pair is summed; 10,000 is the cap"
    );
}

#[tokio::test]
async fn a_denial_report_of_more_than_a_hundred_entries_is_refused_whole() {
    let e = ext();
    let counts: Vec<Value> =
        (0..101).map(|n| json!({ "appId": "orders-web", "kind": "camera", "count": n + 1 })).collect();
    let error = call(&e.ext, "webapp.reportDenials", json!({ "counts": counts })).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidParams);
    assert!(lock(&e.sink.0).is_empty(), "nothing is counted from a refused call");
    // Exactly one hundred is fine.
    let counts: Vec<Value> =
        (0..100).map(|n| json!({ "appId": "orders-web", "kind": "camera", "count": n + 1 })).collect();
    assert!(call(&e.ext, "webapp.reportDenials", json!({ "counts": counts })).await.is_ok());
    for bad in [json!({}), json!({ "counts": "x" }), json!({ "counts": [{ "appId": "orders-web" }] })] {
        let error = call(&e.ext, "webapp.reportDenials", bad.clone()).await.unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidParams, "{bad}");
    }
}

#[tokio::test]
async fn the_daily_sink_adds_to_the_security_counters_and_keeps_only_numbers() {
    let dir = TempDir::new();
    let path = dir.path().join("security-daily.json");
    let sink = DailyDenials::new(DailyCounters::open(path.clone()).unwrap());
    sink.add("2027-01-15", "orders-web", "camera", 7);
    sink.add("2027-01-15", "orders-web", "camera", 2);
    sink.add("2027-01-15", "orders-web", "geolocation", 1);
    let text = std::fs::read_to_string(&path).unwrap();
    let file: Value = serde_json::from_str(&text).unwrap();
    let denials = &file["today"]["denials"];
    assert_eq!(denials[0], json!({ "appId": "orders-web", "kind": "camera", "count": 9 }));
    assert_eq!(denials[1], json!({ "appId": "orders-web", "kind": "geolocation", "count": 1 }));
    // Nothing but app id, kind and a number (plan rule 6): no URL, time or employee in the file.
    for word in ["http", "employee", "origin", "url"] {
        assert!(!text.to_lowercase().contains(word), "{word} in {text}");
    }
}

#[test]
fn the_ack_entry_has_the_shape_of_the_server_call() {
    // `deviceApi:reportAcks({ acks: [{ broadcastId, atMs }] })` (convex/deviceApi.ts).
    assert_eq!(FN_REPORT_ACKS, "deviceApi:reportAcks");
    assert_eq!(serde_json::to_value(Ack { broadcast_id: "b".into(), at_ms: 7 }).unwrap(), json!({ "broadcastId": "b", "atMs": 7 }));
    assert_eq!(MAX_ACKS_PER_CALL, 20);
}
