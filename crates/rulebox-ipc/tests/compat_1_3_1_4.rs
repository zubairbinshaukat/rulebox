//! Protocol 1.4 against recorded transcripts of a 1.3 peer (plan Phase 6, Step 4 item 5,
//! and 4.15). Two directions, like `compat_1_1_1_2.rs`:
//!
//! * 1.3 Staff App on a 1.4 agent: everything the 1.4 agent sends (the snapshot with its
//!   three new keys, the web app's browser keys, the app's update state, the new event)
//!   is read by the **frozen 1.3 reader** without an error, the additions are ignored,
//!   and a browser web app is read as an ordinary web app (the built-in window);
//! * 1.4 Staff App on a 1.3 agent: the **recorded** 1.3 snapshot and app list (frozen
//!   text, never regenerated from today's types) parse with the new fields at their
//!   defaults (built-in window, no update state, no window cap, auto).

#![allow(clippy::unwrap_used, clippy::expect_used)]

use rulebox_ipc::methods::events;
use rulebox_ipc::requests::{AppEntry, AppUpdateState, AppsListResult, AppsUpdatingData};
use rulebox_ipc::types::{AgentSnapshot, DisplayMode, DisplayModeSource, HelloResult, ProtocolVersion};
use rulebox_ipc::{CAP_APP_UPDATES, CAP_BROWSER_APPS, PROTOCOL_MAJOR, PROTOCOL_MINOR};
use rulebox_policy::catalog::BrowserKind;
use serde::Deserialize;
use serde_json::{json, Value};

// ---- what a 1.3 agent sent (recorded text, frozen) --------------------------------

/// `state.get` of a 1.3 agent: the 1.3 keys, none of the 1.4 ones.
const SNAPSHOT_1_3: &str = r#"{"agentVersion":"0.4.0","enrollment":"enrolled","device":{"id":"dev_1","name":"Front desk"},"convexUrl":"https://happy-animal-123.convex.cloud","connection":"online","kiosk":{"enabled":true,"phase":"applied","errorCode":null},"shell":{"health":"healthy"},"displayMode":"lite","desiredState":null,"desiredStateVersion":9,"serverTimeOffsetMs":12,"clockSuspect":false,"adminExit":{"enabled":true,"hotkey":"Ctrl+Shift+F12"},"power":null,"orgName":"Corner Shop","deviceLock":null,"broadcasts":[],"keyboard":{"winCombos":"swallow"},"printing":{"available":true},"network":{"managedOnly":false,"ssids":[]}}"#;

/// `apps.list` of a 1.3 agent: a web app and an installed desktop app.
const APPS_1_3: &str = r#"{"apps":[{"id":"orders","name":"Orders","description":null,"kind":"web","builtin":null,"web":{"url":"https://portal.company.com/orders","allowedDomains":["portal.company.com"],"permissions":{"camera":false,"microphone":false,"screenShare":false,"clipboardRead":false,"notifications":true,"downloads":true,"printing":false,"geolocation":false}},"desktop":null,"pinnedTaskbar":true,"pinnedDesktop":true,"iconPngBase64":null,"hue":175},{"id":"tally","name":"Tally","description":null,"kind":"desktop","builtin":null,"web":null,"desktop":{"exe":"C:\\Program Files\\Tally\\tally.exe","args":[],"fileArgTemplate":[]},"pinnedTaskbar":false,"pinnedDesktop":true,"iconPngBase64":null,"hue":null}]}"#;

// ---- the frozen 1.3 readers -------------------------------------------------------

/// What a 1.3 client reads of the snapshot. No `deny_unknown_fields`: that is the rule.
#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)] // the point is that the parse succeeds
struct Snapshot13 {
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
    #[serde(default)]
    device_lock: Option<Value>,
    #[serde(default)]
    broadcasts: Vec<Value>,
    #[serde(default)]
    keyboard: Option<Value>,
    #[serde(default)]
    printing: Option<Value>,
    #[serde(default)]
    network: Option<Value>,
}

/// A 1.3 client's `apps.list` reader: the 1.1 fields and nothing of 1.4.
#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
struct AppsList13 {
    apps: Vec<App13>,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
struct App13 {
    id: String,
    name: String,
    #[serde(default)]
    description: Option<String>,
    kind: String,
    #[serde(default)]
    web: Option<Web13>,
    #[serde(default)]
    desktop: Option<Desktop13>,
    #[serde(default)]
    pinned_taskbar: bool,
    #[serde(default)]
    pinned_desktop: bool,
    #[serde(default)]
    icon_png_base64: Option<String>,
    #[serde(default)]
    hue: Option<u16>,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
struct Web13 {
    url: String,
    allowed_domains: Vec<String>,
    permissions: Value,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
struct Desktop13 {
    exe: String,
    args: Vec<String>,
    file_arg_template: Vec<String>,
}

/// A 1.3 client's event handling: it knew the six events up to 1.3 and skipped any other name.
fn event_seen_by_1_3(name: &str) -> Option<&'static str> {
    match name {
        "state.changed" => Some("state"),
        "agent.shuttingDown" => Some("shuttingDown"),
        "apps.changed" => Some("appsChanged"),
        "session.ended" => Some("sessionEnded"),
        "device.lockChanged" => Some("lockChanged"),
        "broadcasts.changed" => Some("broadcastsChanged"),
        "program.blocked" => Some("programBlocked"),
        _ => None,
    }
}

// ---- the 1.4 agent's side -----------------------------------------------------------

fn agent_snapshot_1_4() -> AgentSnapshot {
    let mut value: Value = serde_json::from_str(SNAPSHOT_1_3).unwrap();
    value["webWindowCap"] = json!(3);
    value["webIdleCloseMin"] = json!(30);
    value["displayModeSource"] = json!("device");
    serde_json::from_value(value).unwrap()
}

fn apps_1_4() -> Value {
    json!({ "apps": [
        { "id": "orders", "name": "Orders", "description": null, "kind": "web", "builtin": null,
          "web": { "url": "https://portal.company.com/orders", "allowedDomains": ["portal.company.com"],
                   "permissions": { "camera": false, "microphone": false, "screenShare": false,
                                    "clipboardRead": false, "notifications": true, "downloads": true,
                                    "printing": false, "geolocation": false },
                   "browser": "chrome",
                   "browserExe": "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
                   "browserReady": true },
          "desktop": null, "pinnedTaskbar": true, "pinnedDesktop": true, "iconPngBase64": null, "hue": 175,
          "update": null },
        { "id": "tally", "name": "Tally", "description": null, "kind": "desktop", "builtin": null, "web": null,
          "desktop": { "exe": "C:\\Program Files\\Tally\\app-2.4.1\\tally.exe", "args": [], "fileArgTemplate": [] },
          "pinnedTaskbar": false, "pinnedDesktop": true, "iconPngBase64": null, "hue": null,
          "update": "waitingForClose" }
    ] })
}

#[test]
fn the_1_4_snapshot_is_read_by_a_1_3_client_and_its_additions_are_ignored() {
    let wire = serde_json::to_value(agent_snapshot_1_4()).unwrap();
    let read: Snapshot13 = serde_json::from_value(wire.clone()).unwrap();
    assert_eq!(read.desired_state_version, 9);
    assert_eq!(read.display_mode, "lite");
    assert_eq!(read.org_name.as_deref(), Some("Corner Shop"));
    // The additions are on the wire; the frozen reader does not look at them.
    for key in ["webWindowCap", "webIdleCloseMin", "displayModeSource"] {
        assert!(wire.get(key).is_some(), "{key}");
    }
}

#[test]
fn the_1_4_app_list_is_read_by_a_1_3_client_and_a_browser_app_is_an_ordinary_web_app() {
    let wire = apps_1_4();
    let read: AppsList13 = serde_json::from_value(wire.clone()).unwrap();
    assert_eq!(read.apps.len(), 2);
    let orders = &read.apps[0];
    assert_eq!(orders.kind, "web");
    // All the 1.3 client sees is the URL, the domains and the permissions: it opens the
    // built-in window, which is the documented fallback.
    let web = orders.web.as_ref().unwrap();
    assert_eq!(web.url, "https://portal.company.com/orders");
    assert_eq!(read.apps[1].desktop.as_ref().unwrap().exe, r"C:\Program Files\Tally\app-2.4.1\tally.exe");
    // Today's reader agrees with what the 1.4 agent wrote.
    let ours: AppsListResult = serde_json::from_value(wire).unwrap();
    assert_eq!(ours.apps[0].web.as_ref().unwrap().browser, BrowserKind::Chrome);
    assert_eq!(ours.apps[1].update, Some(AppUpdateState::WaitingForClose));
}

#[test]
fn a_1_3_client_skips_the_event_added_in_1_4() {
    let data = serde_json::to_value(AppsUpdatingData { count: 1, until: 1_760_990_300_000 }).unwrap();
    assert_eq!(data, json!({ "count": 1, "until": 1_760_990_300_000_u64 }));
    assert_eq!(event_seen_by_1_3(events::APPS_UPDATING), None);
    // The events it does know are still skipped by name only when unknown.
    for name in [
        events::STATE_CHANGED,
        events::AGENT_SHUTTING_DOWN,
        events::APPS_CHANGED,
        events::SESSION_ENDED,
        events::DEVICE_LOCK_CHANGED,
        events::BROADCASTS_CHANGED,
        events::PROGRAM_BLOCKED,
    ] {
        assert!(event_seen_by_1_3(name).is_some(), "{name}");
    }
}

#[test]
fn a_1_3_client_accepts_the_1_4_hello() {
    let answer = HelloResult {
        protocol: ProtocolVersion { major: PROTOCOL_MAJOR, minor: PROTOCOL_MINOR },
        agent_version: "0.5.0".into(),
        capabilities: vec!["state".into(), "health".into(), CAP_BROWSER_APPS.into(), CAP_APP_UPDATES.into()],
    };
    let wire = serde_json::to_value(&answer).unwrap();
    // The major did not change; a 1.3 client compares majors only and ignores unknown capabilities.
    assert_eq!(wire["protocol"]["major"], json!(1));
    assert_eq!(PROTOCOL_MINOR, 4);
    let caps: Vec<String> = serde_json::from_value(wire["capabilities"].clone()).unwrap();
    assert!(caps.iter().any(|c| c == "state") && caps.iter().any(|c| c == "health"));
}

#[test]
fn the_recorded_1_3_snapshot_parses_on_a_1_4_client_with_the_defaults() {
    let parsed: AgentSnapshot = serde_json::from_str(SNAPSHOT_1_3).unwrap();
    assert_eq!(parsed.web_window_cap, None);
    assert_eq!(parsed.web_idle_close_min, None);
    assert_eq!(parsed.display_mode_source, DisplayModeSource::Auto);
    assert_eq!(parsed.display_mode, DisplayMode::Lite);
    assert_eq!(parsed.desired_state_version, 9);
    assert_eq!(parsed.org_name.as_deref(), Some("Corner Shop"));
}

#[test]
fn the_recorded_1_3_app_list_parses_on_a_1_4_client_with_the_defaults() {
    let parsed: AppsListResult = serde_json::from_str(APPS_1_3).unwrap();
    assert_eq!(parsed.apps.len(), 2);
    let web = parsed.apps[0].web.as_ref().unwrap();
    // No browser keys: the built-in window, never ready for a browser.
    assert_eq!((web.browser, web.browser_exe.clone(), web.browser_ready), (BrowserKind::Builtin, None, false));
    assert_eq!(parsed.apps[0].update, None);
    assert_eq!(parsed.apps[1].update, None);
    assert_eq!(parsed.apps[1].desktop.as_ref().unwrap().exe, r"C:\Program Files\Tally\tally.exe");
    let entries: Vec<&AppEntry> = parsed.apps.iter().collect();
    assert!(entries.iter().all(|entry| entry.update.is_none()));
}

#[test]
fn a_later_agent_adds_values_a_1_4_client_reads_as_unknown() {
    let mut wire = apps_1_4();
    wire["apps"][0]["web"]["browser"] = json!("firefox");
    wire["apps"][1]["update"] = json!("rebooting");
    let parsed: AppsListResult = serde_json::from_value(wire).unwrap();
    assert_eq!(parsed.apps[0].web.as_ref().unwrap().browser, BrowserKind::Unknown);
    assert_eq!(parsed.apps[1].update, Some(AppUpdateState::Unknown));
    let mut snapshot: Value = serde_json::to_value(agent_snapshot_1_4()).unwrap();
    snapshot["displayModeSource"] = json!("fleet");
    let parsed: AgentSnapshot = serde_json::from_value(snapshot).unwrap();
    assert_eq!(parsed.display_mode_source, DisplayModeSource::Unknown);
}
