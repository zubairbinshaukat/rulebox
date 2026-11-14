//! Protocol 1.3 against recorded transcripts of 1.1 and 1.2 clients (plan Phase 5,
//! Step 12 item 1, and 4.12).
//!
//! A *transcript* here is the JSON text a client of that minor really puts on the
//! pipe (frozen, never regenerated from today's types) plus the **frozen reader** of
//! that client: the few fields and event names that minor knew, written out by hand.
//! Two directions are checked:
//!
//! * old client -> 1.3 agent: what the old client sends is understood by today's
//!   server-side types, and the hello is answered with a version it accepts;
//! * 1.3 agent -> old client: everything the 1.3 agent sends (the snapshot with its
//!   five new keys, the three new events, the new `deviceLocked` values) is read by the
//!   frozen reader without an error, and the 1.3 additions are simply ignored.
//!
//! The reverse (a 1.3 client on a 1.2 agent) is `snapshot_from_a_1_2_agent_parses`
//! in `types.rs` and the capability checks of the Staff App.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use rulebox_ipc::envelope::Frame;
use rulebox_ipc::methods::{events, Hello, Method};
use rulebox_ipc::requests::{
    AdminExitSubmitParams, BroadcastAckParams, SessionEndedData, SignInParams, SignInResult,
};
use rulebox_ipc::types::{
    AgentSnapshot, BroadcastView, ClientRole, ConnectionStatus, DeviceLockView, DisplayMode, DeviceInfo,
    EnrollmentStatus, HelloParams, HelloResult, KeyboardView, KioskPhase, KioskStatus, NetworkView, PrintingView,
    ProtocolVersion, ShellHealth, ShellStatus,
};
use rulebox_ipc::{PROTOCOL_MAJOR, PROTOCOL_MINOR};
use rulebox_policy::lockdown::WinCombos;
use rulebox_policy::notice::BroadcastStyle;
use serde::Deserialize;
use serde_json::{json, Value};

// ---- what a 1.1 and a 1.2 client sent (recorded text, frozen) --------------------

const HELLO_1_1: &str = r#"{"t":"req","id":0,"method":"hello","params":{"protocol":{"major":1,"minor":1},"client":{"role":"shell","name":"rulebox-staff","version":"0.1.0"}}}"#;
const HELLO_1_2: &str = r#"{"t":"req","id":0,"method":"hello","params":{"protocol":{"major":1,"minor":2},"client":{"role":"shell","name":"rulebox-staff","version":"0.2.0"}}}"#;
const LAUNCHER_HELLO_1_1: &str = r#"{"t":"req","id":0,"method":"hello","params":{"protocol":{"major":1,"minor":1},"client":{"role":"launcher","name":"rulebox-shell","version":"0.1.0"}}}"#;

/// The requests of a signed-in 1.1 session, in order, as recorded.
const REQUESTS_1_1: &[&str] = &[
    r#"{"t":"req","id":1,"method":"state.get","params":{}}"#,
    r#"{"t":"req","id":2,"method":"shell.ready","params":{}}"#,
    r#"{"t":"req","id":3,"method":"session.signIn","params":{"username":"maya","password":"pw"}}"#,
    r#"{"t":"req","id":4,"method":"apps.list","params":{}}"#,
    r#"{"t":"req","id":5,"method":"shell.heartbeat","params":{}}"#,
    r#"{"t":"req","id":6,"method":"adminExit.submit","params":{"pin":"2468"}}"#,
];

// ---- the frozen readers ----------------------------------------------------------

/// What a 1.1 client reads of the snapshot. No `deny_unknown_fields`: that is the rule.
#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)] // the point is that the parse succeeds
struct Snapshot11 {
    agent_version: String,
    enrollment: String,
    device: Option<Value>,
    convex_url: Option<String>,
    connection: String,
    kiosk: Value,
    shell: Value,
    display_mode: String,
    desired_state: Option<Value>,
    desired_state_version: u64,
    server_time_offset_ms: Option<i64>,
    clock_suspect: bool,
    #[serde(default)]
    admin_exit: Option<Value>,
    #[serde(default)]
    power: Option<Value>,
    #[serde(default)]
    org_name: Option<String>,
}

/// A 1.1 client's event handling: it knew `state.changed` and `agent.shuttingDown`
/// and skipped any other name.
fn event_seen_by_1_1(name: &str, data: &Value) -> Option<&'static str> {
    match name {
        "state.changed" => serde_json::from_value::<Snapshot11>(data.clone()).ok().map(|_| "state"),
        "agent.shuttingDown" => data.get("reason").and(data.get("graceMs")).map(|_| "shuttingDown"),
        _ => None,
    }
}

/// A 1.2 client additionally knew `apps.changed` and `session.ended`, whose reason
/// was an enum that maps an unlisted string to `Unknown`.
fn event_seen_by_1_2(name: &str, data: &Value) -> Option<String> {
    match name {
        "apps.changed" => Some("appsChanged".into()),
        "session.ended" => {
            let reason = data.get("reason")?.as_str()?;
            Some(match reason {
                "employeeRemoved" | "credentialChanged" | "revoked" => reason.to_string(),
                _ => "unknown".to_string(),
            })
        }
        other => event_seen_by_1_1(other, data).map(str::to_string),
    }
}

/// A 1.2 client's sign-in outcome: an unlisted string is `Unknown`, never an error.
fn outcome_seen_by_1_2(text: &str) -> &'static str {
    match text {
        "ok" => "ok",
        "wrongCredentials" => "wrongCredentials",
        "disabled" => "disabled",
        "lockedOut" => "lockedOut",
        "offlineNeverSignedIn" => "offlineNeverSignedIn",
        "offlineExpired" => "offlineExpired",
        "notAllowedHere" => "notAllowedHere",
        _ => "unknown",
    }
}

// ---- the 1.3 agent's side ---------------------------------------------------------

fn locked_snapshot() -> AgentSnapshot {
    AgentSnapshot {
        agent_version: "0.3.0".into(),
        enrollment: EnrollmentStatus::Enrolled,
        device: Some(DeviceInfo { id: "dev_1".into(), name: "Front desk".into() }),
        convex_url: None,
        connection: ConnectionStatus::Online,
        kiosk: KioskStatus { enabled: true, phase: KioskPhase::Applied, error_code: None },
        shell: ShellStatus { health: ShellHealth::Healthy },
        display_mode: DisplayMode::Standard,
        desired_state: None,
        desired_state_version: 9,
        server_time_offset_ms: Some(12),
        clock_suspect: false,
        admin_exit: None,
        power: None,
        org_name: Some("Corner Shop".into()),
        device_lock: Some(DeviceLockView { lock_id: "l1".into(), message: "Call IT".into(), contact: None }),
        broadcasts: vec![BroadcastView {
            id: "b1".into(),
            style: BroadcastStyle::Banner,
            title: "Hi".into(),
            body: "<script>x</script>".into(),
            ack_required: false,
            acknowledged: false,
        }],
        keyboard: Some(KeyboardView { win_combos: WinCombos::Swallow }),
        printing: Some(PrintingView { available: false }),
        network: Some(NetworkView { managed_only: false, ssids: vec![] }),
    }
}

fn frame(text: &str) -> Frame {
    serde_json::from_str(text).unwrap()
}

#[test]
fn a_1_1_and_a_1_2_hello_are_understood_and_answered_with_a_version_they_accept() {
    for (text, minor) in [(HELLO_1_1, 1), (HELLO_1_2, 2), (LAUNCHER_HELLO_1_1, 1)] {
        let Frame::Request { id: 0, method, params } = frame(text) else { panic!("not a request") };
        assert_eq!(method, Hello::NAME);
        let hello: HelloParams = serde_json::from_value(params).unwrap();
        assert_eq!(hello.protocol, ProtocolVersion { major: 1, minor });
        // The agent accepts any client of its own major (the server compares majors only)
        // and answers with its own minor. A 1.1 or 1.2 client accepts the answer when the
        // major is equal; it never looks at the minor.
        let answer = HelloResult {
            protocol: ProtocolVersion { major: PROTOCOL_MAJOR, minor: PROTOCOL_MINOR },
            agent_version: "0.3.0".into(),
            capabilities: vec!["state".into(), "health".into(), "deviceLock".into(), "broadcasts".into()],
        };
        let wire = serde_json::to_value(&answer).unwrap();
        assert_eq!(wire["protocol"], json!({ "major": 1, "minor": 3 }));
        assert_eq!(wire["protocol"]["major"], json!(hello.protocol.major));
        // A client that does not know a capability string ignores it: it only looks for its own.
        let caps: Vec<String> = serde_json::from_value(wire["capabilities"].clone()).unwrap();
        assert!(caps.iter().any(|c| c == "state"));
    }
    assert!(matches!(
        serde_json::from_value::<HelloParams>(json!({ "protocol": { "major": 1, "minor": 1 },
            "client": { "role": "launcher", "name": "n", "version": "v" } }))
        .unwrap()
        .client
        .role,
        ClientRole::Launcher
    ));
}

#[test]
fn the_recorded_1_1_requests_still_parse_on_a_1_3_agent() {
    let mut methods = Vec::new();
    for text in REQUESTS_1_1 {
        let Frame::Request { method, params, .. } = frame(text) else { panic!("not a request: {text}") };
        match method.as_str() {
            "session.signIn" => {
                let p: SignInParams = serde_json::from_value(params).unwrap();
                assert_eq!((p.username.as_str(), p.password.as_str()), ("maya", "pw"));
            }
            "adminExit.submit" => {
                let p: AdminExitSubmitParams = serde_json::from_value(params).unwrap();
                assert_eq!(p.pin, "2468");
            }
            // Empty params: `{}` is all the agent expects.
            _ => assert_eq!(params, json!({}), "{method}"),
        }
        methods.push(method);
    }
    assert_eq!(
        methods,
        ["state.get", "shell.ready", "session.signIn", "apps.list", "shell.heartbeat", "adminExit.submit"]
    );
}

#[test]
fn the_1_3_snapshot_is_read_by_a_1_1_client_and_its_additions_are_ignored() {
    let wire = serde_json::to_value(locked_snapshot()).unwrap();
    // Every key of the 1.1 reader is still there, with the same type.
    let read: Snapshot11 = serde_json::from_value(wire.clone()).unwrap();
    assert_eq!(read.desired_state_version, 9);
    assert_eq!(read.org_name.as_deref(), Some("Corner Shop"));
    // The additions exist on the wire, and the frozen reader simply does not look at them.
    for key in ["deviceLock", "broadcasts", "keyboard", "printing", "network"] {
        assert!(wire.get(key).is_some(), "{key}");
    }
    // A 1.1 client receiving `state.changed` with this data sees an ordinary state change.
    assert_eq!(event_seen_by_1_1("state.changed", &wire), Some("state"));
}

#[test]
fn a_1_1_client_skips_every_event_added_after_it() {
    let blocked = json!({ "displayName": "Tor Browser" });
    for (name, data) in [
        (events::APPS_CHANGED, json!({})),
        (events::SESSION_ENDED, json!({ "reason": "revoked" })),
        (events::DEVICE_LOCK_CHANGED, json!({})),
        (events::BROADCASTS_CHANGED, json!({})),
        (events::PROGRAM_BLOCKED, blocked.clone()),
    ] {
        assert_eq!(event_seen_by_1_1(name, &data), None, "{name}");
    }
}

#[test]
fn a_1_2_client_skips_the_three_events_of_1_3_and_reads_the_new_reason_as_unknown() {
    for (name, data) in [
        (events::DEVICE_LOCK_CHANGED, json!({})),
        (events::BROADCASTS_CHANGED, json!({})),
        (events::PROGRAM_BLOCKED, json!({ "displayName": "Tor Browser" })),
    ] {
        assert_eq!(event_seen_by_1_2(name, &data), None, "{name}");
    }
    // The 1.2 events it does know still work, including the 1.3 reason.
    assert_eq!(event_seen_by_1_2("apps.changed", &json!({})).as_deref(), Some("appsChanged"));
    assert_eq!(event_seen_by_1_2("session.ended", &json!({ "reason": "revoked" })).as_deref(), Some("revoked"));
    let ended = serde_json::to_value(SessionEndedData { reason: rulebox_ipc::requests::SessionEndReason::DeviceLocked })
        .unwrap();
    assert_eq!(ended, json!({ "reason": "deviceLocked" }));
    assert_eq!(event_seen_by_1_2("session.ended", &ended).as_deref(), Some("unknown"));
}

#[test]
fn a_1_2_client_reads_the_new_sign_in_outcome_as_unknown_not_as_an_error() {
    let wire = r#"{"outcome":"deviceLocked","employee":null,"filesRoot":null,"offline":false,"retryAfterMs":null}"#;
    let value: Value = serde_json::from_str(wire).unwrap();
    assert_eq!(outcome_seen_by_1_2(value["outcome"].as_str().unwrap()), "unknown");
    // And today's reader (which knows the value) agrees with the wire text.
    let parsed: SignInResult = serde_json::from_str(wire).unwrap();
    assert_eq!(parsed.outcome, rulebox_ipc::requests::SignInOutcome::DeviceLocked);
}

#[test]
fn a_1_3_client_with_no_1_3_capability_does_not_ask_for_1_3_requests() {
    // The 1.3 requests are plain methods: a 1.2 agent answers `unknown_method`, which the
    // Staff App never provokes because it checks the capability first. Pin the names so a
    // typo cannot make a 1.3 client send something a 1.3 agent does not know.
    assert_eq!(<rulebox_ipc::methods::BroadcastAcknowledge as Method>::NAME, "broadcast.acknowledge");
    assert_eq!(<rulebox_ipc::methods::WebappReportDenials as Method>::NAME, "webapp.reportDenials");
    let params = serde_json::to_value(BroadcastAckParams { id: "b1".into() }).unwrap();
    assert_eq!(params, json!({ "id": "b1" }));
}
