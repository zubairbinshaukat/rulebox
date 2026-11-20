//! Phase 6 Step 19 tests: the web window cap, the idle close with its exclusions, the "paused" mark and the one timer
//! (plan 4.14, PRD 22.4). They live in the bin crate because the lib test harness cannot start (see `main.rs`).
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::cell::Cell;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use rulebox_ipc::types::{DisplayMode, DisplayModeSource};
use rulebox_staff_lib::agent::demo::DemoAgent;
use rulebox_staff_lib::agent::AgentPort;
use rulebox_staff_lib::model::{AppEntry, AppKind, BuiltinTool, ShellModeDto, ShellState, WebApp, WebPermissions};
use rulebox_staff_lib::state::{apply_snapshot, AppState};
use rulebox_staff_lib::webapp::idle::{
    at_cap, effective_cap, effective_idle, idle_candidates, spawn_ticker, Activity, SentLimits, WindowFacts, CAP_RANGE,
    IDLE_RANGE,
};
use rulebox_staff_lib::webapp::{pause_then_close, test_window, CapOutcome, WebApps};

const MIN: Duration = Duration::from_secs(60);

fn state() -> AppState {
    AppState::new(Arc::new(DemoAgent::new()), ShellState::initial(ShellModeDto::Dev))
}

fn web_app(id: &str, name: &str) -> AppEntry {
    AppEntry {
        id: id.into(),
        name: name.into(),
        description: None,
        kind: AppKind::Web(WebApp {
            url: "https://example.com/".into(),
            allowed_domains: vec![],
            permissions: WebPermissions::default(),
        }),
        icon_key: None,
        icon_url: None,
        hue: None,
        pinned_taskbar: false,
        pinned_desktop: true,
        badge: None,
    }
}

fn facts(label: &str, quiet_min: Option<u32>) -> WindowFacts {
    WindowFacts {
        label: label.into(),
        app_id: format!("app-{label}"),
        quiet_for: quiet_min.map(|m| MIN * m),
        capturing: false,
        modal_open: false,
    }
}

// ---- the numbers -------------------------------------------------------------------------

#[test]
fn the_cap_defaults_by_mode_and_takes_the_agents_value_inside_one_to_twelve() {
    assert_eq!((effective_cap(true, None), effective_cap(false, None)), (3, 8));
    assert_eq!(effective_cap(true, Some(1)), 1);
    assert_eq!(effective_cap(false, Some(12)), 12);
    assert_eq!(effective_cap(false, Some(5)), 5);
    assert_eq!((*CAP_RANGE.start(), *CAP_RANGE.end()), (1, 12));
    // Out of range: the default of the mode (the agent already refuses such a document; this is the second line).
    for bad in [0, 13, 99] {
        assert_eq!(effective_cap(true, Some(bad)), 3, "{bad}");
        assert_eq!(effective_cap(false, Some(bad)), 8, "{bad}");
    }
}

#[test]
fn idle_close_defaults_to_thirty_minutes_in_lite_and_off_in_standard() {
    assert_eq!(effective_idle(true, None), Some(30 * MIN));
    assert_eq!(effective_idle(false, None), None);
    assert_eq!(effective_idle(true, Some(0)), None, "0 = off, even in Lite");
    assert_eq!(effective_idle(false, Some(0)), None);
    assert_eq!(effective_idle(false, Some(5)), Some(5 * MIN));
    assert_eq!(effective_idle(true, Some(240)), Some(240 * MIN));
    assert_eq!((*IDLE_RANGE.start(), *IDLE_RANGE.end()), (5, 240));
    for bad in [1, 4, 241] {
        assert_eq!(effective_idle(true, Some(bad)), Some(30 * MIN), "{bad}");
        assert_eq!(effective_idle(false, Some(bad)), None, "{bad}");
    }
}

#[test]
fn the_cap_is_reached_at_the_number_of_open_windows() {
    assert!(!at_cap(2, 3));
    assert!(at_cap(3, 3));
    assert!(at_cap(4, 3));
    assert!(at_cap(1, 1));
    assert!(!at_cap(0, 1));
}

#[test]
fn the_state_applies_the_agents_limits_and_the_mode_decides_the_defaults() {
    let state = state();
    // Standard, nothing sent (an older agent): 8 windows, no idle close.
    assert_eq!((state.web_window_cap(), state.web_idle_close()), (8, None));

    let mut snapshot = DemoAgent::new().snapshot().borrow().clone().unwrap();
    snapshot.display_mode = DisplayMode::Lite;
    snapshot.display_mode_source = DisplayModeSource::Group;
    snapshot.web_window_cap = Some(2);
    snapshot.web_idle_close_min = Some(15);
    apply_snapshot(&state, Some(snapshot.clone()));
    assert_eq!((state.web_window_cap(), state.web_idle_close()), (2, Some(15 * MIN)));

    // Lite with no values sent: the Lite defaults.
    snapshot.web_window_cap = None;
    snapshot.web_idle_close_min = None;
    apply_snapshot(&state, Some(snapshot.clone()));
    assert_eq!((state.web_window_cap(), state.web_idle_close()), (3, Some(30 * MIN)));

    // "Off" from the agent stays off in Lite.
    snapshot.web_idle_close_min = Some(0);
    apply_snapshot(&state, Some(snapshot));
    assert_eq!(state.web_idle_close(), None);
}

// ---- which windows the idle close takes ------------------------------------------------------

#[test]
fn only_hidden_silent_windows_past_the_time_are_candidates() {
    let all = vec![facts("shown", None), facts("fresh", Some(29)), facts("exact", Some(30)), facts("old", Some(90))];
    let labels: Vec<&str> = idle_candidates(&all, 30 * MIN).iter().map(|f| f.label.as_str()).collect();
    assert_eq!(labels, ["exact", "old"]);
}

#[test]
fn a_window_that_may_be_capturing_or_has_a_file_picker_open_is_skipped_however_long_it_has_been_quiet() {
    let mut capture = facts("cam", Some(500));
    capture.capturing = true;
    let mut picker = facts("picker", Some(500));
    picker.modal_open = true;
    let all = [capture, picker, facts("plain", Some(500))];
    let labels: Vec<&str> = idle_candidates(&all, 30 * MIN).iter().map(|f| f.label.as_str()).collect();
    assert_eq!(labels, ["plain"]);
}

#[test]
fn a_window_playing_audio_is_never_quiet_and_one_that_just_stopped_starts_its_time_from_then() {
    let base = Instant::now();
    let a = Activity::default();
    assert_eq!(a.quiet_for(base), None, "on screen");
    a.set_hidden(true, base);
    assert_eq!(a.quiet_for(base + 10 * MIN), Some(10 * MIN));
    // Audio starts at minute 10 and is still playing at minute 100: not quiet.
    a.set_audible(true, base + 10 * MIN);
    assert!(a.audible());
    assert_eq!(a.quiet_for(base + 100 * MIN), None);
    // It stops at minute 100: quiet since then, not since it was hidden.
    a.set_audible(false, base + 100 * MIN);
    assert_eq!(a.quiet_for(base + 105 * MIN), Some(5 * MIN));
    let fact = WindowFacts {
        label: "w".into(),
        app_id: "x".into(),
        quiet_for: a.quiet_for(base + 105 * MIN),
        capturing: false,
        modal_open: false,
    };
    assert!(idle_candidates(&[fact], 30 * MIN).is_empty());
    // Shown again: input is possible, the clock restarts at the next minimize.
    a.set_hidden(false, base + 106 * MIN);
    assert_eq!(a.quiet_for(base + 200 * MIN), None);
    a.set_hidden(true, base + 200 * MIN);
    assert_eq!(a.quiet_for(base + 201 * MIN), Some(MIN));
    // Repeating the same state changes nothing.
    a.set_hidden(true, base + 250 * MIN);
    assert_eq!(a.quiet_for(base + 251 * MIN), Some(51 * MIN));
}

#[test]
fn capture_is_remembered_for_the_life_of_the_window() {
    let a = Activity::default();
    assert!(!a.capturing());
    a.mark_capture();
    assert!(a.capturing());
    a.set_hidden(true, Instant::now());
    assert!(a.capturing());
}

#[test]
fn the_facts_of_the_open_windows_come_from_their_activity_and_only_hidden_ones_are_asked_about_dialogs() {
    let web = WebApps::default();
    let (shown, hidden, audible, camera) = (
        test_window("web-a-0", "a", "Shown"),
        test_window("web-b-1", "b", "Hidden"),
        test_window("web-c-2", "c", "Music"),
        test_window("web-d-3", "d", "Meet"),
    );
    let base = Instant::now();
    hidden.activity.set_hidden(true, base);
    audible.activity.set_hidden(true, base);
    audible.activity.set_audible(true, base);
    camera.activity.set_hidden(true, base);
    camera.activity.mark_capture();
    for window in [&shown, &hidden, &audible, &camera] {
        web.insert_for_test(Arc::clone(window));
    }
    let asked = Cell::new(0);
    let mut all = web.idle_facts(base + 40 * MIN, |_| {
        asked.set(asked.get() + 1);
        false
    });
    all.sort_by(|a, b| a.label.cmp(&b.label));
    assert_eq!(all.iter().map(|f| f.quiet_for).collect::<Vec<_>>(), [None, Some(40 * MIN), None, Some(40 * MIN)]);
    assert!(all[3].capturing);
    // The window on screen and the one playing audio are not hidden-and-silent: no dialog lookup for them.
    assert_eq!(asked.get(), 2);
    let labels: Vec<&str> = idle_candidates(&all, 30 * MIN).iter().map(|f| f.label.as_str()).collect();
    assert_eq!(labels, ["web-b-1"], "shown, audible and camera windows stay");

    // A file picker over the hidden window keeps it.
    let with_picker = web.idle_facts(base + 40 * MIN, |label| label == "web-b-1");
    assert!(idle_candidates(&with_picker, 30 * MIN).is_empty());
}

// ---- the "paused" mark ---------------------------------------------------------------------

#[test]
fn the_mark_is_set_before_the_window_is_closed_and_taken_back_when_closing_fails() {
    let state = state();
    let seen_in_close = Cell::new(false);
    let result: Result<(), String> = pause_then_close(&state, "orders", || {
        seen_in_close.set(state.read(|shell| shell.paused_apps.contains(&"orders".to_string())));
        Ok(())
    });
    assert!(result.is_ok());
    assert!(seen_in_close.get(), "never a window closed without the mark");
    assert_eq!(state.read(|shell| shell.paused_apps.clone()), ["orders"]);

    // The same app twice: one mark.
    let _ = pause_then_close::<String>(&state, "orders", || Ok(()));
    assert_eq!(state.read(|shell| shell.paused_apps.len()), 1);

    let failed = pause_then_close(&state, "mail", || Err("not closed".to_string()));
    assert_eq!(failed, Err("not closed".to_string()));
    assert_eq!(state.read(|shell| shell.paused_apps.clone()), ["orders"], "no mark for a window that stayed");
}

#[test]
fn the_page_gets_the_paused_apps_in_camel_case() {
    let mut shell = ShellState::initial(ShellModeDto::Dev);
    assert_eq!(serde_json::to_value(&shell).unwrap()["pausedApps"], serde_json::json!([]));
    shell.paused_apps.push("orders".into());
    assert_eq!(serde_json::to_value(&shell).unwrap()["pausedApps"], serde_json::json!(["orders"]));
    // A state without the key (an older build) has nothing paused.
    let mut wire = serde_json::to_value(&shell).unwrap();
    wire.as_object_mut().unwrap().remove("pausedApps");
    let back: ShellState = serde_json::from_value(wire).unwrap();
    assert!(back.paused_apps.is_empty());
}

// ---- the window cap dialog ------------------------------------------------------------------

fn web_with(windows: &[(&str, &str, &str)]) -> WebApps {
    let web = WebApps::default();
    for (label, app_id, name) in windows {
        web.insert_for_test(test_window(label, app_id, name));
    }
    web
}

#[test]
fn at_the_cap_the_prompt_lists_the_open_windows_by_name_and_names_the_waiting_app() {
    let web = web_with(&[("web-b-1", "b", "Zebra CRM"), ("web-a-0", "a", "accounts"), ("web-c-2", "c", "Mail")]);
    let files = AppEntry { kind: AppKind::Builtin { tool: BuiltinTool::Files }, ..web_app("files", "Files") };
    let catalogue = [web_app("orders", "Orders"), files];
    assert!(web.cap_prompt(3, &catalogue).is_none(), "nothing waits yet");
    assert!(web.at_cap(3) && !web.at_cap(4));
    web.set_pending("orders");
    let prompt = web.cap_prompt(3, &catalogue).unwrap();
    assert_eq!((prompt.cap, prompt.app_name.as_str()), (3, "Orders"));
    assert_eq!(
        prompt.windows.iter().map(|w| (w.label.as_str(), w.app_name.as_str())).collect::<Vec<_>>(),
        [("web-a-0", "accounts"), ("web-c-2", "Mail"), ("web-b-1", "Zebra CRM")],
        "sorted by name, case-insensitively"
    );
    let wire = serde_json::to_value(&prompt).unwrap();
    assert_eq!(wire["windows"][0], serde_json::json!({ "label": "web-a-0", "appName": "accounts" }));
    assert_eq!(wire["appName"], "Orders");
}

#[test]
fn picking_a_window_closes_only_that_one_and_hands_back_the_waiting_app() {
    let web = web_with(&[("web-a-0", "a", "Accounts"), ("web-b-1", "b", "Mail"), ("web-c-2", "c", "Docs")]);
    // Nothing waits: nothing is closed, whatever label comes in.
    assert!(web.take_for_close("web-a-0").is_none());
    assert_eq!(web.count_open(), 3);

    web.set_pending("orders");
    // A label that is not an open web window (a page cannot name a taskbar window or a built-in one) closes nothing.
    for label in ["shell-main", "app-files", "", "web-zzz-9"] {
        assert!(web.take_for_close(label).is_none(), "{label:?}");
    }
    assert_eq!(web.count_open(), 3);
    assert!(web.cap_prompt(3, &[]).is_some(), "the wait is kept after a bad pick");

    let (window, waiting) = web.take_for_close("web-b-1").unwrap();
    assert_eq!((window.label.as_str(), waiting.as_str()), ("web-b-1", "orders"));
    // The room is there at once, without waiting for the window's own destroy event.
    assert_eq!(web.count_open(), 2);
    assert!(!web.at_cap(3));
    assert!(web.cap_prompt(3, &[]).is_none(), "taking a window ends the wait");
}

#[test]
fn cancelling_forgets_the_wait_and_closes_nothing() {
    let web = web_with(&[("web-a-0", "a", "Accounts")]);
    web.set_pending("orders");
    web.cancel_pending();
    assert!(web.cap_prompt(1, &[]).is_none());
    assert!(web.take_for_close("web-a-0").is_none());
    assert_eq!(web.count_open(), 1);
    // A newer click replaces an older wait.
    web.set_pending("one");
    web.set_pending("two");
    assert_eq!(web.take_for_close("web-a-0").unwrap().1, "two");
}

#[test]
fn the_outcomes_reach_the_page_in_camel_case() {
    let names: Vec<String> = [CapOutcome::Opened, CapOutcome::StillFull, CapOutcome::Nothing]
        .iter()
        .map(|o| serde_json::to_value(o).unwrap().as_str().unwrap().to_string())
        .collect();
    assert_eq!(names, ["opened", "stillFull", "nothing"]);
}

// ---- the one timer ------------------------------------------------------------------------------

#[tokio::test]
async fn the_one_timer_ticks_and_stops_for_good_when_its_guard_is_dropped() {
    let ticks = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&ticks);
    let guard = spawn_ticker(Duration::from_millis(20), move || {
        counter.fetch_add(1, Ordering::SeqCst);
    });
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(ticks.load(Ordering::SeqCst) >= 3, "the timer runs while it is held");
    drop(guard);
    // A tick that was already running may finish; after that nothing counts.
    tokio::time::sleep(Duration::from_millis(80)).await;
    let stopped_at = ticks.load(Ordering::SeqCst);
    tokio::time::sleep(Duration::from_millis(250)).await;
    assert_eq!(ticks.load(Ordering::SeqCst), stopped_at, "no tick after the guard is gone");
}

#[test]
fn the_sent_limits_default_to_none_for_an_older_agent() {
    assert_eq!(SentLimits::default(), SentLimits { cap: None, idle_close_min: None });
}
