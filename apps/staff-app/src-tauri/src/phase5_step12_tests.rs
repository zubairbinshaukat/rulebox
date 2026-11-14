//! Phase 5 Step 12 tests: protocol 1.3 in the Staff App (the lock view, broadcasts, the Windows-key
//! mode, the denial counters) and the cover windows' decisions. They live in the bin crate because the
//! lib test harness cannot start (see `main.rs`).
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::future::BoxFuture;
use rulebox_desktop::winkey::WinCombos as Mode;
use rulebox_desktop::Rect;
use rulebox_ipc::client::ClientEvent;
use rulebox_ipc::requests::{DenialCount, SessionEndReason, SignInResult};
use rulebox_ipc::types::{AgentSnapshot, BroadcastView, DeviceLockView, KeyboardView};
use rulebox_policy::lockdown::WinCombos;
use rulebox_policy::notice::BroadcastStyle;
use rulebox_staff_lib::agent::demo::DemoAgent;
use rulebox_staff_lib::agent::{AgentError, AgentPort};
use rulebox_staff_lib::covers::{self, CoverKind};
use rulebox_staff_lib::model::{
    map_client_event, map_sign_in_result, notices_from_snapshot, win_combos_mode, AdminExitOutcome, AgentEvent,
    AgentLink, AppEntry, BroadcastDto, Employee, SessionEndedReason, SessionState, ShellModeDto, ShellState,
    SignInOutcome, SignInRequest, VerifyOutcome,
};
use rulebox_staff_lib::session::{self, apply_session_ended, finish_signed_out, EndedPlan};
use rulebox_staff_lib::state::{apply_snapshot, flush_denials, run_denial_flush, spawn_agent_tasks, AppState};
use rulebox_staff_lib::webapp::permissions::{DenialKind, PermissionKind};
use serde_json::json;
use tokio::sync::{broadcast, watch};

// ---- helpers -------------------------------------------------------------------------

fn private_profile() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let dir = std::env::temp_dir().join("rulebox-staff-step12-tests");
        std::fs::create_dir_all(&dir).unwrap();
        std::env::set_var("LOCALAPPDATA", dir);
    });
}

fn demo_state() -> (Arc<DemoAgent>, AppState) {
    let agent = Arc::new(DemoAgent::new());
    let state = AppState::new(agent.clone(), ShellState::initial(ShellModeDto::Dev));
    (agent, state)
}

async fn wait_for(mut condition: impl FnMut() -> bool) -> bool {
    for _ in 0..200 {
        if condition() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    false
}

fn lock_view(message: &str) -> DeviceLockView {
    DeviceLockView { lock_id: "lock_1".into(), message: message.into(), contact: Some("it@example.test".into()) }
}

fn broadcast_view(id: &str, style: BroadcastStyle, ack_required: bool, acknowledged: bool) -> BroadcastView {
    BroadcastView {
        id: id.into(),
        style,
        title: format!("Title {id}"),
        body: format!("Body {id}"),
        ack_required,
        acknowledged,
    }
}

/// A snapshot as the agent would send it, from the demo agent's.
fn base_snapshot() -> AgentSnapshot {
    DemoAgent::new().snapshot().borrow().clone().unwrap()
}

fn maya() -> Employee {
    Employee { id: "emp_maya".into(), username: "maya".into(), name: "Maya Chen".into(), role: None, quota_bytes: 1 }
}

// ---- the 1.3 parts of a snapshot -------------------------------------------------------

#[test]
fn a_1_3_snapshot_becomes_the_lock_the_list_and_the_printing_fact() {
    let mut snapshot = base_snapshot();
    snapshot.device_lock = Some(lock_view("Back at noon"));
    snapshot.broadcasts = vec![broadcast_view("a", BroadcastStyle::Banner, false, false)];
    snapshot.printing = Some(rulebox_ipc::types::PrintingView { available: true });
    let (lock, list, printing) = notices_from_snapshot(&snapshot);
    let lock = lock.unwrap();
    assert_eq!((lock.lock_id.as_str(), lock.message.as_str()), ("lock_1", "Back at noon"));
    assert_eq!(lock.contact.as_deref(), Some("it@example.test"));
    assert_eq!(list.len(), 1);
    assert_eq!((list[0].id.as_str(), list[0].ack_required, list[0].acknowledged), ("a", false, false));
    assert_eq!(printing, Some(true));
}

#[test]
fn the_shell_state_carries_the_lock_and_the_list_to_the_page_in_camel_case() {
    let mut snapshot = base_snapshot();
    snapshot.device_lock = Some(lock_view("Back at noon"));
    snapshot.broadcasts = vec![broadcast_view("a", BroadcastStyle::Fullscreen, true, false)];
    snapshot.printing = Some(rulebox_ipc::types::PrintingView { available: false });
    let (lock, list, printing) = notices_from_snapshot(&snapshot);
    let mut shell = ShellState::initial(ShellModeDto::Dev);
    shell.device_lock = lock;
    shell.broadcasts = list;
    shell.printing_available = printing;
    let wire = serde_json::to_value(&shell).unwrap();
    assert_eq!(
        wire["deviceLock"],
        json!({ "lockId": "lock_1", "message": "Back at noon", "contact": "it@example.test" })
    );
    assert_eq!(
        wire["broadcasts"],
        json!([{ "id": "a", "style": "fullscreen", "title": "Title a", "body": "Body a",
                 "ackRequired": true, "acknowledged": false }])
    );
    assert_eq!(wire["printingAvailable"], json!(false));
}

#[test]
fn a_1_2_agents_snapshot_has_no_lock_no_list_and_no_printing_fact() {
    // The text a 1.2 agent sends: none of the five 1.3 keys.
    let mut wire = serde_json::to_value(base_snapshot()).unwrap();
    for key in ["deviceLock", "broadcasts", "keyboard", "printing", "network"] {
        wire.as_object_mut().unwrap().remove(key).unwrap();
    }
    let snapshot: AgentSnapshot = serde_json::from_value(wire).unwrap();
    let (lock, list, printing) = notices_from_snapshot(&snapshot);
    assert!(lock.is_none() && list.is_empty() && printing.is_none());
    assert_eq!(win_combos_mode(Some(&snapshot)), Mode::Pass, "an older agent leaves the Phase 3 keyboard");
}

#[test]
fn broadcast_text_with_html_characters_is_kept_as_it_is() {
    // The Staff App never touches the text: the page renders it as text (see the React tests).
    let mut snapshot = base_snapshot();
    let mut view = broadcast_view("h", BroadcastStyle::Fullscreen, true, false);
    view.title = "<b>Closed</b> & \"early\"".into();
    view.body = "<img src=x onerror=alert(1)>".into();
    snapshot.broadcasts = vec![view];
    let (_, list, _) = notices_from_snapshot(&snapshot);
    assert_eq!(list[0].title, "<b>Closed</b> & \"early\"");
    assert_eq!(list[0].body, "<img src=x onerror=alert(1)>");
    // On the way to the page it is JSON: the characters are escaped there as plain strings.
    let json = serde_json::to_value(&list[0]).unwrap();
    assert_eq!(json["body"], "<img src=x onerror=alert(1)>");
}

#[test]
fn the_windows_key_mode_follows_the_snapshot_and_unknown_means_the_stricter_one() {
    let with = |combos: Option<WinCombos>| {
        let mut snapshot = base_snapshot();
        snapshot.keyboard = combos.map(|win_combos| KeyboardView { win_combos });
        win_combos_mode(Some(&snapshot))
    };
    assert_eq!(with(Some(WinCombos::Pass)), Mode::Pass);
    assert_eq!(with(Some(WinCombos::Swallow)), Mode::Swallow);
    assert_eq!(with(Some(WinCombos::Unknown)), Mode::Swallow);
    assert_eq!(with(None), Mode::Pass);
    assert_eq!(win_combos_mode(None), Mode::Pass, "no snapshot yet: the Phase 3 behaviour");
}

// ---- events ------------------------------------------------------------------------------

#[test]
fn the_1_3_events_reach_the_shell_and_the_new_reason_maps() {
    assert_eq!(map_client_event(&ClientEvent::DeviceLockChanged), Some(AgentEvent::DeviceLockChanged));
    assert_eq!(map_client_event(&ClientEvent::BroadcastsChanged), Some(AgentEvent::BroadcastsChanged));
    assert_eq!(
        map_client_event(&ClientEvent::ProgramBlocked { display_name: "Tor".into() }),
        Some(AgentEvent::ProgramBlocked("Tor".into()))
    );
    assert_eq!(
        map_client_event(&ClientEvent::SessionEnded(SessionEndReason::DeviceLocked)),
        Some(AgentEvent::SessionEnded(SessionEndedReason::DeviceLocked))
    );
    let wire: SignInResult = serde_json::from_value(json!({ "outcome": "deviceLocked" })).unwrap();
    assert_eq!(map_sign_in_result(wire), SignInOutcome::DeviceLocked);
    assert_eq!(serde_json::to_value(SignInOutcome::DeviceLocked).unwrap(), json!("deviceLocked"));
    assert_eq!(serde_json::to_value(SessionEndedReason::DeviceLocked).unwrap(), json!("deviceLocked"));
}

#[tokio::test(flavor = "current_thread")]
async fn a_blocked_program_becomes_a_short_plain_text_notice() {
    let (agent, state) = demo_state();
    spawn_agent_tasks(state.clone());
    tokio::task::yield_now().await;
    agent.dev_emit(AgentEvent::ProgramBlocked("<b>Tor</b> Browser".into()));
    assert!(wait_for(|| !state.snapshot().notices.is_empty()).await);
    let notice = state.snapshot().notices.remove(0);
    assert_eq!(notice.title, "<b>Tor</b> Browser was stopped.", "text, exactly as sent");
}

// ---- the lock while signed in ---------------------------------------------------------------

#[tokio::test(flavor = "current_thread")]
async fn a_lock_that_appears_while_signed_in_ends_the_session_and_shows_the_view_and_unlock_clears_it() {
    private_profile();
    let (_agent, state) = demo_state();
    state.update(|s| {
        s.session = SessionState::SignedIn { employee: maya(), locked: false, offline: false };
    });
    assert_eq!(covers::want(&state.snapshot()), None);

    let mut locked = base_snapshot();
    locked.device_lock = Some(lock_view("Call IT"));
    apply_snapshot(&state, Some(locked));

    // The view appears at once; the session ends a moment later, with no note on the sign-in screen.
    let shell = state.snapshot();
    assert_eq!(shell.device_lock.as_ref().map(|lock| lock.message.as_str()), Some("Call IT"));
    assert_eq!(covers::want(&shell), Some(CoverKind::Lock));
    assert!(wait_for(|| matches!(state.snapshot().session, SessionState::SignedOut { .. })).await, "the session ended");
    assert_eq!(state.snapshot().session_ended, None, "a lock leaves no note behind");
    assert_eq!(state.snapshot().pending_end, None);

    // The same lock again (the next snapshot) changes nothing and ends nothing.
    let mut again = base_snapshot();
    again.device_lock = Some(lock_view("Call IT"));
    apply_snapshot(&state, Some(again));
    assert!(state.snapshot().device_lock.is_some());

    // A dropped pipe is not an unlock.
    apply_snapshot(&state, None);
    assert!(state.snapshot().device_lock.is_some(), "the lock stays while the link is down");

    // Unlock: a snapshot without it. The view goes.
    apply_snapshot(&state, Some(base_snapshot()));
    assert!(state.snapshot().device_lock.is_none());
    assert_eq!(covers::want(&state.snapshot()), None);
}

#[tokio::test(flavor = "current_thread")]
async fn a_changed_lock_while_signed_out_does_not_leave_a_note_and_sign_in_is_refused_by_the_agent() {
    private_profile();
    let (agent, state) = demo_state();
    spawn_agent_tasks(state.clone());
    agent.set_lock(Some(lock_view("Closed for the day")));
    assert!(wait_for(|| state.snapshot().device_lock.is_some()).await);
    assert_eq!(state.snapshot().session_ended, None);

    let outcome = session::sign_in(&state, "maya".into(), "demo".into()).await.unwrap();
    assert_eq!(outcome, SignInOutcome::DeviceLocked, "the agent refuses every sign-in while locked");
    assert!(matches!(state.snapshot().session, SessionState::SignedOut { .. }));

    agent.set_lock(None);
    assert!(wait_for(|| state.snapshot().device_lock.is_none()).await);
    let outcome = session::sign_in(&state, "maya".into(), "demo".into()).await.unwrap();
    assert!(matches!(outcome, SignInOutcome::Ok { .. }), "{outcome:?}");
}

#[test]
fn a_device_locked_end_is_recorded_during_a_log_out_but_leaves_no_note() {
    // While signed in: the session becomes SigningOut and the reason waits for the finish.
    let mut shell = ShellState::initial(ShellModeDto::Dev);
    shell.session = SessionState::SignedIn { employee: maya(), locked: false, offline: false };
    assert!(matches!(
        apply_session_ended(&mut shell, SessionEndedReason::DeviceLocked, None),
        EndedPlan::SignOut(_)
    ));
    assert_eq!(shell.pending_end, Some(SessionEndedReason::DeviceLocked));
    // The finish applies it without a note ("you were signed out" would be wrong: the lock view shows).
    let state = AppState::new(Arc::new(DemoAgent::new()), shell.clone());
    finish_signed_out(&state, None);
    let after = state.snapshot();
    assert!(matches!(after.session, SessionState::SignedOut { .. }));
    assert_eq!(after.session_ended, None);
    assert_eq!(after.pending_end, None);
    // Signed out already: nothing to tell.
    let mut signed_out = ShellState::initial(ShellModeDto::Dev);
    assert!(matches!(apply_session_ended(&mut signed_out, SessionEndedReason::DeviceLocked, None), EndedPlan::Ignore));
    assert_eq!(signed_out.session_ended, None);
}

// ---- broadcasts and "OK" ----------------------------------------------------------------------

#[tokio::test(flavor = "current_thread")]
async fn a_full_screen_notice_covers_until_ok_and_ok_reaches_the_agent() {
    let (agent, state) = demo_state();
    spawn_agent_tasks(state.clone());
    agent.set_broadcasts(vec![
        broadcast_view("strip", BroadcastStyle::Banner, false, false),
        broadcast_view("big", BroadcastStyle::Fullscreen, true, false),
    ]);
    assert!(wait_for(|| state.snapshot().broadcasts.len() == 2).await);
    assert_eq!(covers::want(&state.snapshot()), Some(CoverKind::Notice));

    // "OK": the agent flags it and sends the new snapshot; the cover goes, the banner stays a banner.
    assert_eq!(agent.ack_broadcast("big".into()).await, Ok(true));
    assert!(wait_for(|| state.snapshot().broadcasts.iter().any(|b| b.id == "big" && b.acknowledged)).await);
    assert_eq!(covers::want(&state.snapshot()), None);
    assert_eq!(agent.ack_broadcast("nope".into()).await, Ok(false));
}

#[test]
fn only_an_unacknowledged_full_screen_style_needs_the_whole_screen() {
    let dto = |style, acknowledged| BroadcastDto {
        id: "b".into(),
        style,
        title: "t".into(),
        body: "b".into(),
        ack_required: true,
        acknowledged,
    };
    assert!(dto(BroadcastStyle::Fullscreen, false).needs_full_screen());
    assert!(!dto(BroadcastStyle::Fullscreen, true).needs_full_screen());
    assert!(!dto(BroadcastStyle::Banner, false).needs_full_screen());
    assert!(!dto(BroadcastStyle::Unknown, false).needs_full_screen());
}

// ---- the cover windows' decisions --------------------------------------------------------------

#[test]
fn a_lock_wins_over_a_notice_and_a_banner_never_covers() {
    let mut shell = ShellState::initial(ShellModeDto::Shell);
    assert_eq!(covers::want(&shell), None);
    let dto = |style| BroadcastDto {
        id: "b".into(),
        style,
        title: "t".into(),
        body: "b".into(),
        ack_required: true,
        acknowledged: false,
    };
    shell.broadcasts = vec![dto(BroadcastStyle::Banner), dto(BroadcastStyle::Unknown)];
    assert_eq!(covers::want(&shell), None);
    shell.broadcasts.push(dto(BroadcastStyle::Fullscreen));
    assert_eq!(covers::want(&shell), Some(CoverKind::Notice));
    shell.device_lock = notices_from_snapshot(&{
        let mut s = base_snapshot();
        s.device_lock = Some(lock_view("m"));
        s
    })
    .0;
    assert_eq!(covers::want(&shell), Some(CoverKind::Lock));
}

#[test]
fn every_monitor_gets_a_cover_including_the_blank_ones_of_p13() {
    // Primary at 0,0; the second monitor to its left (negative x); the third above it.
    let monitors = [(0, 0, 1920, 1080), (-1280, 100, 1280, 1024), (0, -1080, 1920, 1080), (5000, 0, 0, 0)];
    let rects = covers::rects_from(&monitors);
    assert_eq!(
        rects,
        [Rect::new(-1280, 100, 0, 1124), Rect::new(0, -1080, 1920, 0), Rect::new(0, 0, 1920, 1080)],
        "three covers, a monitor with no area is skipped, the order is stable"
    );
    let nothing: Vec<String> = Vec::new();
    let fresh = covers::plan(&nothing, &rects);
    assert_eq!(fresh.create.len(), 3, "one cover per monitor, the primary one too");
    assert!(fresh.keep.is_empty() && fresh.destroy.is_empty());
    assert!(covers::rects_from(&[]).is_empty());
}

#[test]
fn the_plan_creates_keeps_and_destroys_by_label() {
    let rects = [Rect::new(0, 0, 100, 100), Rect::new(100, 0, 200, 100)];
    let existing = vec!["shell-cover-0".to_string(), "shell-cover-1".to_string()];
    // One monitor was unplugged: its cover goes, the other is placed again.
    let fewer = covers::plan(&existing, &rects[..1]);
    assert_eq!(fewer.keep, [("shell-cover-0".to_string(), rects[0])]);
    assert_eq!(fewer.destroy, ["shell-cover-1"]);
    assert!(fewer.create.is_empty());
    // Nothing wanted: every cover goes.
    let gone = covers::plan(&existing, &[]);
    assert_eq!(gone.destroy, existing);
    // A second monitor plugged in while covered: one new cover, the first stays.
    let more = covers::plan(&existing[..1], &rects);
    assert_eq!(more.create, [("shell-cover-1".to_string(), rects[1])]);
    assert_eq!(more.keep.len(), 1);
}

#[test]
fn the_cover_labels_match_the_capability_and_the_state_broadcast() {
    for index in 0..4 {
        let label = covers::label_of(index);
        assert!(label.starts_with(covers::COVER_PREFIX));
        // `shell://state` goes to every `shell-` window, covers included.
        assert!(label.starts_with("shell-"));
    }
    let capability = include_str!("../capabilities/cover.json");
    assert!(capability.contains(r#""shell-cover-*""#));
    // A cover can say OK and reach the hidden exit, and nothing that signs in or launches.
    assert!(capability.contains("allow-broadcast-ack") && capability.contains("allow-admin-exit-open"));
    for forbidden in ["allow-sign-in", "allow-launch-app", "allow-unlock", "allow-power", "allow-fs-"] {
        assert!(!capability.contains(forbidden), "{forbidden}");
    }
}

// ---- the denial counters -----------------------------------------------------------------------

#[test]
fn a_refusal_is_counted_per_app_and_permission_and_only_real_permissions_are_reported() {
    let (_agent, state) = demo_state();
    for kind in [Some(DenialKind::Camera), Some(DenialKind::Camera), Some(DenialKind::ScreenShare), None] {
        state.note_web_denial("orders-web", kind);
    }
    state.note_web_denial("mail", Some(DenialKind::Downloads));
    // Autoplay and the unknown kinds have no counter.
    assert_eq!(PermissionKind::Autoplay.denial_kind(), None);
    assert_eq!(PermissionKind::Other.denial_kind(), None);
    assert_eq!(PermissionKind::Camera.denial_kind(), Some(DenialKind::Camera));

    assert_eq!(state.web_denials("orders-web"), 4, "the app's total still counts every refusal");
    let report = state.take_denial_counts();
    let entries: Vec<(&str, &str, u64)> =
        report.iter().map(|c| (c.app_id.as_str(), c.kind.as_str(), c.count)).collect();
    assert_eq!(entries, [("mail", "downloads", 1), ("orders-web", "camera", 2), ("orders-web", "screenShare", 1)]);
    assert!(state.take_denial_counts().is_empty(), "taken counts are gone");
    // The names are exactly the keys of the web permissions (PRD 24.1).
    for kind in [
        DenialKind::Camera,
        DenialKind::Microphone,
        DenialKind::ScreenShare,
        DenialKind::ClipboardRead,
        DenialKind::Notifications,
        DenialKind::Downloads,
        DenialKind::Printing,
        DenialKind::Geolocation,
    ] {
        assert!(rulebox_ipc::requests::PERMISSION_KINDS.contains(&kind.wire()), "{}", kind.wire());
    }
}

#[test]
fn a_report_has_at_most_a_hundred_entries_and_ten_thousand_per_entry_and_the_rest_waits() {
    let (_agent, state) = demo_state();
    for n in 0..130 {
        state.note_web_denial(&format!("app{n:03}"), Some(DenialKind::Camera));
    }
    let first = state.take_denial_counts();
    assert_eq!(first.len(), 100);
    assert_eq!(state.pending_denial_pairs(), 30, "the rest stays for the next report");
    assert_eq!(state.take_denial_counts().len(), 30);

    for _ in 0..10_005 {
        state.note_web_denial("busy", Some(DenialKind::Notifications));
    }
    let big = state.take_denial_counts();
    assert_eq!(big[0].count, 10_000);
    let rest = state.take_denial_counts();
    assert_eq!(rest[0].count, 5);
}

/// An agent that wraps the demo one and answers the denial report as told.
struct TestAgent {
    inner: DemoAgent,
    capabilities: Vec<String>,
    report: Mutex<Result<(), AgentError>>,
    received: Mutex<Vec<Vec<DenialCount>>>,
}

impl TestAgent {
    fn new(with_1_3: bool, report: Result<(), AgentError>) -> Arc<Self> {
        let inner = DemoAgent::new();
        let mut capabilities = inner.capabilities();
        if !with_1_3 {
            capabilities.retain(|c| !["deviceLock", "broadcasts", "keyboardPolicy", "permissionReports"].contains(&c.as_str()));
        }
        Arc::new(Self { inner, capabilities, report: Mutex::new(report), received: Mutex::new(Vec::new()) })
    }

    fn set_report(&self, report: Result<(), AgentError>) {
        *self.report.lock().unwrap() = report;
    }
}

impl AgentPort for TestAgent {
    fn link(&self) -> watch::Receiver<AgentLink> {
        self.inner.link()
    }
    fn snapshot(&self) -> watch::Receiver<Option<AgentSnapshot>> {
        self.inner.snapshot()
    }
    fn capabilities(&self) -> Vec<String> {
        self.capabilities.clone()
    }
    fn events(&self) -> broadcast::Receiver<AgentEvent> {
        self.inner.events()
    }
    fn session_get(&self) -> BoxFuture<'_, Result<Option<Employee>, AgentError>> {
        self.inner.session_get()
    }
    fn ready(&self) -> BoxFuture<'_, Result<(), AgentError>> {
        self.inner.ready()
    }
    fn heartbeat(&self) -> BoxFuture<'_, Result<(), AgentError>> {
        self.inner.heartbeat()
    }
    fn sign_in(&self, req: SignInRequest) -> BoxFuture<'_, Result<SignInOutcome, AgentError>> {
        self.inner.sign_in(req)
    }
    fn sign_out(&self) -> BoxFuture<'_, Result<(), AgentError>> {
        self.inner.sign_out()
    }
    fn verify_password(&self, password: String) -> BoxFuture<'_, Result<VerifyOutcome, AgentError>> {
        self.inner.verify_password(password)
    }
    fn apps(&self) -> BoxFuture<'_, Result<Vec<AppEntry>, AgentError>> {
        self.inner.apps()
    }
    fn admin_exit(&self, pin: String) -> BoxFuture<'_, Result<AdminExitOutcome, AgentError>> {
        self.inner.admin_exit(pin)
    }
    fn ack_broadcast(&self, id: String) -> BoxFuture<'_, Result<bool, AgentError>> {
        if self.capabilities.iter().any(|c| c == "broadcasts") {
            self.inner.ack_broadcast(id)
        } else {
            Box::pin(std::future::ready(Err(AgentError::Unsupported)))
        }
    }
    fn report_denials(&self, counts: Vec<DenialCount>) -> BoxFuture<'_, Result<(), AgentError>> {
        let answer = self.report.lock().unwrap().clone();
        if answer.is_ok() {
            self.received.lock().unwrap().push(counts);
        }
        Box::pin(std::future::ready(answer))
    }
}

fn state_with(agent: &Arc<TestAgent>) -> AppState {
    AppState::new(agent.clone(), ShellState::initial(ShellModeDto::Dev))
}

#[tokio::test(flavor = "current_thread")]
async fn a_flush_sends_the_counts_and_a_failed_one_keeps_them_for_the_next_turn() {
    let agent = TestAgent::new(true, Err(AgentError::NotLinked));
    let state = state_with(&agent);
    state.note_web_denial("orders-web", Some(DenialKind::Camera));
    state.note_web_denial("orders-web", Some(DenialKind::Camera));

    flush_denials(&state).await;
    assert_eq!(state.pending_denial_pairs(), 1, "the agent was unreachable: the counts are kept");
    // Counted while it was down: added to what waits.
    state.note_web_denial("orders-web", Some(DenialKind::Camera));

    agent.set_report(Ok(()));
    flush_denials(&state).await;
    assert_eq!(state.pending_denial_pairs(), 0);
    let received = agent.received.lock().unwrap().clone();
    assert_eq!(received.len(), 1);
    assert_eq!(received[0], [DenialCount { app_id: "orders-web".into(), kind: "camera".into(), count: 3 }]);
    // Nothing waiting: no call at all.
    flush_denials(&state).await;
    assert_eq!(agent.received.lock().unwrap().len(), 1);
}

#[tokio::test(flavor = "current_thread")]
async fn an_agent_without_the_capability_gets_no_report_and_loses_no_count() {
    let agent = TestAgent::new(false, Ok(()));
    let state = state_with(&agent);
    state.note_web_denial("orders-web", Some(DenialKind::Camera));
    flush_denials(&state).await;
    assert!(agent.received.lock().unwrap().is_empty(), "a 1.2 agent is never sent a 1.3 request");
    assert_eq!(state.pending_denial_pairs(), 1);
    // And "OK" on a broadcast is quietly a no-op for it, not an error.
    assert_eq!(agent.ack_broadcast("x".into()).await, Err(AgentError::Unsupported));
}

#[tokio::test(flavor = "current_thread")]
async fn the_counters_are_flushed_on_a_timer() {
    let agent = TestAgent::new(true, Ok(()));
    let state = state_with(&agent);
    let runner = tokio::spawn(run_denial_flush(state.clone(), Duration::from_millis(40)));
    state.note_web_denial("mail", Some(DenialKind::Microphone));
    assert!(wait_for(|| !agent.received.lock().unwrap().is_empty()).await, "the timer reported them");
    assert_eq!(agent.received.lock().unwrap()[0][0].kind, "microphone");
    runner.abort();
}

#[tokio::test(flavor = "current_thread")]
async fn the_counters_are_flushed_at_sign_out() {
    let agent = TestAgent::new(true, Ok(()));
    let state = state_with(&agent);
    state.note_web_denial("orders-web", Some(DenialKind::Geolocation));
    // Every log out ends in `finish_signed_out`; no timer is running here.
    finish_signed_out(&state, None);
    assert!(wait_for(|| !agent.received.lock().unwrap().is_empty()).await, "reported when the employee left");
    assert_eq!(state.pending_denial_pairs(), 0);
}

#[tokio::test(flavor = "current_thread")]
async fn the_demo_agent_keeps_what_it_is_told() {
    let (agent, state) = demo_state();
    state.note_web_denial("orders-web", Some(DenialKind::Printing));
    flush_denials(&state).await;
    assert_eq!(agent.reported_denials(), [DenialCount { app_id: "orders-web".into(), kind: "printing".into(), count: 1 }]);
}
