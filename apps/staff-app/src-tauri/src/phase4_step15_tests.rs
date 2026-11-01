//! Phase 4 Step 15 tests: protocol 1.2 in the Staff App (`apps.changed`,
//! `session.ended`, `notAllowedHere`) and the `fileHandlers` table. They live in
//! the bin crate because the lib test harness cannot start (see `main.rs`).
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use rulebox_ipc::client::ClientEvent;
use rulebox_ipc::requests::{SessionEndReason, SignInResult};
use rulebox_staff_lib::agent::demo::DemoAgent;
use rulebox_staff_lib::agent::AgentPort;
use rulebox_staff_lib::commands::{end_session_from_agent, CommandError};
use rulebox_staff_lib::model::{
    map_client_event, map_sign_in_result, AgentEvent, AgentLinkDto, CatalogState, CatalogStatus,
    Employee, EmployeeBrief, SessionEndedReason, SessionState, ShellModeDto, ShellState,
    SignInOutcome, SignInRequest,
};
use rulebox_staff_lib::session::{self, apply_session_ended, finish_signed_out, EndedPlan};
use rulebox_staff_lib::state::{pump_agent_events, spawn_agent_tasks, AppState};
use serde_json::json;

fn wire_result(outcome: &str) -> SignInResult {
    serde_json::from_value(json!({ "outcome": outcome })).unwrap()
}

fn maya() -> Employee {
    Employee {
        id: "emp_maya".into(),
        username: "maya".into(),
        name: "Maya Chen".into(),
        role: None,
        quota_bytes: 1,
    }
}

fn signed_in() -> SessionState {
    SessionState::SignedIn {
        employee: maya(),
        locked: false,
        offline: false,
    }
}

fn signed_out_as_maya() -> SessionState {
    SessionState::SignedOut {
        last: Some(EmployeeBrief {
            username: "maya".into(),
            name: "Maya Chen".into(),
        }),
    }
}

#[test]
fn not_allowed_here_maps_and_reaches_the_page_as_a_plain_string() {
    let outcome = map_sign_in_result(wire_result("notAllowedHere"));
    assert_eq!(outcome, SignInOutcome::NotAllowedHere);
    assert_eq!(serde_json::to_value(outcome).unwrap(), json!("notAllowedHere"));
    // A word from a later protocol stays "unknown", never an error.
    assert_eq!(map_sign_in_result(wire_result("somethingNew")), SignInOutcome::Unknown);
}

#[test]
fn wire_events_map_and_link_events_do_not() {
    assert_eq!(map_client_event(&ClientEvent::AppsChanged), Some(AgentEvent::AppsChanged));
    for (wire, staff) in [
        (SessionEndReason::EmployeeRemoved, SessionEndedReason::EmployeeRemoved),
        (SessionEndReason::CredentialChanged, SessionEndedReason::CredentialChanged),
        (SessionEndReason::Revoked, SessionEndedReason::Revoked),
        (SessionEndReason::Unknown, SessionEndedReason::Unknown),
    ] {
        assert_eq!(
            map_client_event(&ClientEvent::SessionEnded(wire)),
            Some(AgentEvent::SessionEnded(staff))
        );
    }
    assert_eq!(map_client_event(&ClientEvent::Unlinked), None);
}

#[test]
fn the_reason_reaches_the_page_only_when_there_is_one() {
    let mut state = ShellState::initial(ShellModeDto::Dev);
    let quiet = serde_json::to_value(&state).unwrap();
    assert!(quiet.get("sessionEnded").is_none());
    state.session_ended = Some(SessionEndedReason::CredentialChanged);
    let loud = serde_json::to_value(&state).unwrap();
    assert_eq!(loud["sessionEnded"], json!("credentialChanged"));
}

fn shell_in(session: SessionState) -> ShellState {
    let mut shell = ShellState::initial(ShellModeDto::Dev);
    shell.session = session;
    shell
}

#[test]
fn session_ended_is_handled_in_every_state() {
    use SessionEndedReason::{CredentialChanged, EmployeeRemoved, Revoked, Unknown};

    // Signed in: the log out starts, in the same step, with the reason kept for the screen.
    for reason in [EmployeeRemoved, CredentialChanged, Revoked, Unknown] {
        let mut shell = shell_in(signed_in());
        assert_eq!(apply_session_ended(&mut shell, reason, None), EndedPlan::SignOut(maya()));
        assert_eq!(shell.session, SessionState::SigningOut);
        assert_eq!(shell.pending_end, Some(reason));
    }
    // Locked is signed in too.
    let mut locked = shell_in(SessionState::SignedIn { employee: maya(), locked: true, offline: false });
    assert_eq!(apply_session_ended(&mut locked, Revoked, None), EndedPlan::SignOut(maya()));

    // Signing in or out: remembered, never dropped.
    for transition in [SessionState::SigningIn, SessionState::SigningOut] {
        for reason in [EmployeeRemoved, CredentialChanged, Revoked, Unknown] {
            let mut shell = shell_in(transition.clone());
            assert_eq!(apply_session_ended(&mut shell, reason, None), EndedPlan::Recorded);
            assert_eq!(shell.session, transition);
            assert_eq!(shell.pending_end, Some(reason));
        }
    }

    // Signed out: the note shows now and the person it is about is not offered.
    for reason in [EmployeeRemoved, CredentialChanged, Revoked] {
        let mut shell = shell_in(signed_out_as_maya());
        assert_eq!(apply_session_ended(&mut shell, reason, None), EndedPlan::Recorded);
        assert_eq!(shell.session_ended, Some(reason));
        assert_eq!(shell.session, SessionState::SignedOut { last: None });
        assert_eq!(shell.pending_end, None);
    }
    // ...but there is nobody to tell about an `unknown` one.
    let mut shell = shell_in(signed_out_as_maya());
    assert_eq!(apply_session_ended(&mut shell, Unknown, None), EndedPlan::Ignore);
    assert_eq!(shell.session, signed_out_as_maya());
    assert_eq!(shell.session_ended, None);
}

#[test]
fn a_check_for_one_employee_never_ends_another_ones_session() {
    let mut shell = shell_in(signed_in());
    assert_eq!(
        apply_session_ended(&mut shell, SessionEndedReason::Unknown, Some("emp_sam")),
        EndedPlan::Ignore
    );
    assert_eq!(shell.session, signed_in());
    for other in [SessionState::SigningIn, SessionState::SigningOut, signed_out_as_maya()] {
        let mut shell = shell_in(other.clone());
        assert_eq!(
            apply_session_ended(&mut shell, SessionEndedReason::Revoked, Some("emp_maya")),
            EndedPlan::Ignore
        );
        assert_eq!(shell.session, other);
        assert_eq!(shell.pending_end, None);
    }
    assert_eq!(
        apply_session_ended(&mut shell, SessionEndedReason::Unknown, Some("emp_maya")),
        EndedPlan::SignOut(maya())
    );
}

#[test]
fn a_vague_reason_never_replaces_a_telling_one() {
    let mut shell = shell_in(SessionState::SigningOut);
    apply_session_ended(&mut shell, SessionEndedReason::Unknown, None);
    assert_eq!(shell.pending_end, Some(SessionEndedReason::Unknown));
    apply_session_ended(&mut shell, SessionEndedReason::Revoked, None);
    assert_eq!(shell.pending_end, Some(SessionEndedReason::Revoked));
    apply_session_ended(&mut shell, SessionEndedReason::Unknown, None);
    assert_eq!(shell.pending_end, Some(SessionEndedReason::Revoked));
}

#[test]
fn the_remembered_end_never_reaches_the_page() {
    let mut shell = ShellState::initial(ShellModeDto::Dev);
    shell.pending_end = Some(SessionEndedReason::Revoked);
    assert!(serde_json::to_value(&shell).unwrap().get("pendingEnd").is_none());
}

/// Sign-in writes `last-user.json` and the employee's folder; keep that out of the
/// developer's own profile.
fn private_profile() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let dir = std::env::temp_dir().join("rulebox-staff-step15-tests");
        std::fs::create_dir_all(&dir).unwrap();
        std::env::set_var("LOCALAPPDATA", dir);
    });
}

fn demo_state() -> (Arc<DemoAgent>, AppState) {
    let agent = Arc::new(DemoAgent::new());
    let state = AppState::new(agent.clone(), ShellState::initial(ShellModeDto::Dev));
    (agent, state)
}

async fn sign_in_as(state: &AppState, username: &str) -> SignInOutcome {
    private_profile();
    session::sign_in(state, username.into(), "demo".into()).await.unwrap()
}

#[tokio::test(flavor = "current_thread")]
async fn without_the_shell_windows_the_employee_is_still_signed_out_with_the_note() {
    // No app handle at all: "before the shell was ready".
    for (reason, last_kept) in [
        (SessionEndedReason::EmployeeRemoved, false),
        (SessionEndedReason::Revoked, false),
        (SessionEndedReason::CredentialChanged, true),
        (SessionEndedReason::Unknown, true),
    ] {
        let (_agent, state) = demo_state();
        state.update(|s| {
            s.session = signed_in();
            s.apps = CatalogState { status: CatalogStatus::Ready, items: vec![] };
            s.notices.push(rulebox_staff_lib::model::NoticeItem {
                id: 1,
                tone: rulebox_staff_lib::model::NoticeTone::Neutral,
                title: "x".into(),
                detail: None,
                at_ms: 0,
                unread: true,
            });
        });
        state.set_files_root(Some("C:/x".into()));

        end_session_from_agent(&state, reason).await;

        let after = state.snapshot();
        let last = if last_kept { signed_out_as_maya() } else { SessionState::SignedOut { last: None } };
        assert_eq!(after.session, last, "{reason:?}");
        assert_eq!(after.session_ended, Some(reason), "{reason:?}");
        assert_eq!(after.pending_end, None);
        assert_eq!(after.apps.status, CatalogStatus::Idle);
        assert!(after.notices.is_empty(), "nothing of the employee is left");
        assert_eq!(state.files_root(), None);
    }
}

#[tokio::test(flavor = "current_thread")]
async fn the_note_is_part_of_the_log_out_step_and_ends_with_the_next_sign_in() {
    let (_agent, state) = demo_state();

    // A second `session.ended` while the log out runs: the note survives it.
    state.update(|s| s.session = SessionState::SigningOut);
    end_session_from_agent(&state, SessionEndedReason::CredentialChanged).await;
    assert_eq!(state.snapshot().session, SessionState::SigningOut);
    assert_eq!(state.snapshot().session_ended, None, "set by the step that finishes the log out");
    finish_signed_out(&state, Some(EmployeeBrief { username: "maya".into(), name: "Maya Chen".into() }));
    let after = state.snapshot();
    assert_eq!(after.session, signed_out_as_maya());
    assert_eq!(after.session_ended, Some(SessionEndedReason::CredentialChanged));
    assert_eq!(after.pending_end, None);

    // A plain log out sets no note.
    state.update(|s| s.session_ended = None);
    finish_signed_out(&state, None);
    assert_eq!(state.snapshot().session_ended, None);

    // The next sign-in starts clean, also when an end was left behind.
    state.update(|s| {
        s.session_ended = Some(SessionEndedReason::Revoked);
        s.pending_end = Some(SessionEndedReason::Revoked);
    });
    assert!(matches!(sign_in_as(&state, "sam").await, SignInOutcome::Ok { .. }));
    let after = state.snapshot();
    assert_eq!(after.session_ended, None);
    assert_eq!(after.pending_end, None);
    assert!(matches!(after.session, SessionState::SignedIn { .. }));
}

#[tokio::test(flavor = "current_thread")]
async fn two_ends_at_once_sign_out_once_and_keep_the_telling_reason() {
    let (_agent, state) = demo_state();
    state.update(|s| s.session = signed_in());
    tokio::join!(
        end_session_from_agent(&state, SessionEndedReason::EmployeeRemoved),
        end_session_from_agent(&state, SessionEndedReason::Unknown),
    );
    let after = state.snapshot();
    assert_eq!(after.session, SessionState::SignedOut { last: None });
    assert_eq!(after.session_ended, Some(SessionEndedReason::EmployeeRemoved));
}

#[tokio::test(flavor = "current_thread")]
async fn a_signed_out_screen_stops_offering_the_person_the_agent_ended() {
    let (_agent, state) = demo_state();
    for reason in [SessionEndedReason::EmployeeRemoved, SessionEndedReason::CredentialChanged] {
        state.update(|s| {
            s.session = signed_out_as_maya();
            s.session_ended = None;
        });
        end_session_from_agent(&state, reason).await;
        let after = state.snapshot();
        assert_eq!(after.session, SessionState::SignedOut { last: None }, "{reason:?}");
        assert_eq!(after.session_ended, Some(reason));
    }
}

#[tokio::test(flavor = "current_thread")]
async fn session_ended_during_a_sign_in_is_not_lost() {
    let (agent, state) = demo_state();
    agent.set_sign_in_delay(Duration::from_millis(300));

    let signing_in = {
        let state = state.clone();
        tokio::spawn(async move { sign_in_as(&state, "maya").await })
    };
    assert!(wait_for(|| state.snapshot().session == SessionState::SigningIn).await);
    // The agent has the session by now (the answer is still on its way), and ends it.
    tokio::time::sleep(Duration::from_millis(60)).await;
    spawn_agent_tasks(state.clone());
    agent.dev_emit(AgentEvent::SessionEnded(SessionEndedReason::EmployeeRemoved));
    assert!(
        wait_for(|| state.snapshot().pending_end == Some(SessionEndedReason::EmployeeRemoved)).await,
        "the end was dropped while signing in"
    );
    assert_eq!(state.snapshot().session, SessionState::SigningIn);

    let outcome = signing_in.await.unwrap();
    assert_eq!(outcome, SignInOutcome::Unknown, "the page must not open a desktop");
    let after = state.snapshot();
    assert_eq!(after.session, SessionState::SignedOut { last: None });
    assert_eq!(after.session_ended, Some(SessionEndedReason::EmployeeRemoved));
    assert_eq!(after.pending_end, None);
    assert_eq!(after.apps.status, CatalogStatus::Idle);
    assert_eq!(state.files_root(), None);
    assert!(state.files().session().is_none(), "the files root must be closed");
}

#[tokio::test(flavor = "current_thread")]
async fn session_ended_during_a_failed_sign_in_still_shows() {
    let (agent, state) = demo_state();
    agent.set_sign_in_delay(Duration::from_millis(200));
    let signing_in = {
        let state = state.clone();
        tokio::spawn(async move {
            private_profile();
            session::sign_in(&state, "maya".into(), "wrong".into()).await.unwrap()
        })
    };
    assert!(wait_for(|| state.snapshot().session == SessionState::SigningIn).await);
    spawn_agent_tasks(state.clone());
    agent.dev_emit(AgentEvent::SessionEnded(SessionEndedReason::Revoked));

    assert_eq!(signing_in.await.unwrap(), SignInOutcome::WrongCredentials);
    let after = state.snapshot();
    assert_eq!(after.session, SessionState::SignedOut { last: None });
    assert_eq!(after.session_ended, Some(SessionEndedReason::Revoked));
}

#[tokio::test(flavor = "current_thread")]
async fn session_ended_right_after_a_sign_in_signs_the_employee_out() {
    let (agent, state) = demo_state();
    spawn_agent_tasks(state.clone());
    assert!(matches!(sign_in_as(&state, "maya").await, SignInOutcome::Ok { .. }));
    assert!(matches!(state.snapshot().session, SessionState::SignedIn { .. }));

    agent.dev_emit(AgentEvent::SessionEnded(SessionEndedReason::CredentialChanged));
    assert!(wait_for(|| state.snapshot().session == signed_out_as_maya()).await);
    assert_eq!(state.snapshot().session_ended, Some(SessionEndedReason::CredentialChanged));
    assert_eq!(state.files_root(), None);
}

#[tokio::test(flavor = "current_thread")]
async fn a_new_sign_in_waits_for_the_log_out_that_is_running() {
    let (_agent, state) = demo_state();
    state.update(|s| s.session = SessionState::SigningOut);
    private_profile();
    let refused = session::sign_in(&state, "maya".into(), "demo".into()).await;
    assert!(matches!(refused, Err(CommandError::Forbidden)));
    assert_eq!(state.snapshot().session, SessionState::SigningOut);
}

#[tokio::test(flavor = "current_thread")]
async fn a_lagged_event_channel_finds_the_session_the_agent_no_longer_has() {
    let (agent, state) = demo_state();
    assert!(matches!(sign_in_as(&state, "maya").await, SignInOutcome::Ok { .. }));

    // The agent ended the session; its push was lost in the flood below.
    let events = agent.events();
    agent.end_session_silently();
    agent.flood_events(40);
    tokio::spawn(pump_agent_events(state.clone(), events));

    assert!(wait_for(|| state.snapshot().session == signed_out_as_maya()).await, "still signed in");
    assert_eq!(state.snapshot().session_ended, Some(SessionEndedReason::Unknown));
    assert_eq!(state.files_root(), None);
}

#[tokio::test(flavor = "current_thread")]
async fn a_lagged_event_channel_keeps_a_session_the_agent_still_has() {
    let (agent, state) = demo_state();
    assert!(matches!(sign_in_as(&state, "maya").await, SignInOutcome::Ok { .. }));

    let events = agent.events();
    agent.flood_events(40);
    tokio::spawn(pump_agent_events(state.clone(), events));
    assert!(wait_for(|| state.snapshot().apps.status == CatalogStatus::Ready).await);
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert!(matches!(state.snapshot().session, SessionState::SignedIn { .. }));
}

#[tokio::test(flavor = "current_thread")]
async fn a_re_link_checks_the_session_and_signs_out_what_the_agent_lost() {
    let (agent, state) = demo_state();
    spawn_agent_tasks(state.clone());
    assert!(wait_for(|| state.snapshot().link == AgentLinkDto::Linked).await);
    assert!(matches!(sign_in_as(&state, "maya").await, SignInOutcome::Ok { .. }));

    // The pipe drops; the agent ends the session meanwhile (no push can arrive).
    agent.set_link(AgentLinkDto::Disconnected);
    assert!(wait_for(|| state.snapshot().link == AgentLinkDto::Disconnected).await);
    agent.end_session_silently();
    assert!(matches!(state.snapshot().session, SessionState::SignedIn { .. }), "nothing told the shell yet");
    agent.set_link(AgentLinkDto::Linked);

    assert!(wait_for(|| state.snapshot().session == signed_out_as_maya()).await, "still signed in");
    assert_eq!(state.snapshot().session_ended, Some(SessionEndedReason::Unknown));
}

#[tokio::test(flavor = "current_thread")]
async fn a_re_link_keeps_a_session_the_agent_still_has() {
    let (agent, state) = demo_state();
    spawn_agent_tasks(state.clone());
    assert!(wait_for(|| state.snapshot().link == AgentLinkDto::Linked).await);
    assert!(matches!(sign_in_as(&state, "maya").await, SignInOutcome::Ok { .. }));

    agent.set_link(AgentLinkDto::Disconnected);
    assert!(wait_for(|| state.snapshot().link == AgentLinkDto::Disconnected).await);
    agent.set_link(AgentLinkDto::Linked);
    assert!(wait_for(|| state.snapshot().link == AgentLinkDto::Linked).await);
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert!(matches!(state.snapshot().session, SessionState::SignedIn { .. }));
}

#[tokio::test(flavor = "current_thread")]
async fn a_late_catalogue_never_lands_in_another_employees_session() {
    let (agent, state) = demo_state();
    agent.set_apps_delay(Duration::from_millis(200));
    state.update(|s| s.session = signed_in()); // Maya

    let refreshing = {
        let state = state.clone();
        tokio::spawn(async move { session::refresh_catalogue_quietly(&state).await })
    };
    tokio::time::sleep(Duration::from_millis(40)).await;
    // Maya is gone and Sam is in, still loading his own catalogue.
    let sam = Employee { id: "emp_sam".into(), username: "sam".into(), name: "Sam".into(), ..maya() };
    state.update(|s| {
        s.session = SessionState::SignedIn { employee: sam, locked: false, offline: false };
        s.apps = CatalogState { status: CatalogStatus::Loading, items: vec![] };
    });
    refreshing.await.unwrap();
    assert_eq!(state.snapshot().apps.status, CatalogStatus::Loading, "Maya's catalogue landed in Sam's session");
    assert!(state.snapshot().apps.items.is_empty());

    // Same for the first load after sign-in.
    let loading = {
        let state = state.clone();
        tokio::spawn(async move { session::load_catalogue(&state).await })
    };
    tokio::time::sleep(Duration::from_millis(40)).await;
    state.update(|s| s.session = signed_out_as_maya());
    loading.await.unwrap();
    assert_eq!(state.snapshot().apps.status, CatalogStatus::Loading);
}

#[tokio::test(flavor = "current_thread")]
async fn a_hung_catalogue_call_does_not_delay_the_end_of_the_session() {
    let (agent, state) = demo_state();
    agent.set_apps_delay(Duration::from_secs(30)); // hung
    state.update(|s| s.session = signed_in());
    spawn_agent_tasks(state.clone());

    agent.dev_emit(AgentEvent::AppsChanged);
    tokio::time::sleep(Duration::from_millis(50)).await;
    let started = std::time::Instant::now();
    agent.dev_emit(AgentEvent::SessionEnded(SessionEndedReason::EmployeeRemoved));

    assert!(wait_for(|| state.snapshot().session == SessionState::SignedOut { last: None }).await);
    assert!(started.elapsed() < Duration::from_secs(2), "waited for apps.list");
    assert_eq!(state.snapshot().session_ended, Some(SessionEndedReason::EmployeeRemoved));
}

#[tokio::test(flavor = "current_thread")]
async fn the_demo_agent_emits_the_protocol_1_2_events() {
    let agent = DemoAgent::new();
    for cap in ["appsChanged", "sessionEnded"] {
        assert!(agent.capabilities().iter().any(|c| c == cap), "{cap}");
    }
    let mut events = agent.events();
    agent.dev_emit(AgentEvent::AppsChanged);
    agent.dev_emit(AgentEvent::SessionEnded(SessionEndedReason::EmployeeRemoved));
    assert_eq!(events.recv().await.unwrap(), AgentEvent::AppsChanged);
    assert_eq!(
        events.recv().await.unwrap(),
        AgentEvent::SessionEnded(SessionEndedReason::EmployeeRemoved)
    );
}

#[tokio::test(flavor = "current_thread")]
async fn the_demo_agent_answers_not_allowed_here_for_the_visitor() {
    let agent = DemoAgent::new();
    let outcome = agent
        .sign_in(SignInRequest {
            username: "visitor".into(),
            password: "demo".into(),
        })
        .await
        .unwrap();
    assert_eq!(outcome, SignInOutcome::NotAllowedHere);
}

/// Poll until `done` is true (the pump runs on the test's own runtime).
async fn wait_for(mut done: impl FnMut() -> bool) -> bool {
    for _ in 0..100 {
        if done() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    done()
}

#[tokio::test(flavor = "current_thread")]
async fn apps_changed_refreshes_the_catalogue_once_for_a_signed_in_employee() {
    let agent = Arc::new(DemoAgent::new());
    let state = AppState::new(agent.clone(), ShellState::initial(ShellModeDto::Dev));
    spawn_agent_tasks(state.clone());
    // A real session: the agent holds it too (a re-link would check).
    assert!(matches!(sign_in_as(&state, "maya").await, SignInOutcome::Ok { .. }));
    state.update(|s| {
        s.apps = CatalogState { status: CatalogStatus::Idle, items: Vec::new() };
    });

    agent.dev_emit(AgentEvent::AppsChanged);
    assert!(
        wait_for(|| state.snapshot().apps.status == CatalogStatus::Ready).await,
        "the catalogue was not fetched"
    );
    assert!(!state.snapshot().apps.items.is_empty());
}

#[tokio::test(flavor = "current_thread")]
async fn apps_changed_while_signed_out_fetches_nothing() {
    let agent = Arc::new(DemoAgent::new());
    let state = AppState::new(agent.clone(), ShellState::initial(ShellModeDto::Dev));
    spawn_agent_tasks(state.clone());

    agent.dev_emit(AgentEvent::AppsChanged);
    // A second event behind it proves the first one was handled.
    agent.dev_emit(AgentEvent::AppsChanged);
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!(
        state.snapshot().apps,
        CatalogState {
            status: CatalogStatus::Idle,
            items: Vec::new()
        }
    );
}

#[tokio::test(flavor = "current_thread")]
async fn the_file_handler_table_follows_the_agent_snapshot() {
    let state = AppState::new(Arc::new(DemoAgent::new()), ShellState::initial(ShellModeDto::Dev));
    assert!(state.files().handlers().is_empty());
    spawn_agent_tasks(state.clone());

    let expected = BTreeMap::from([
        (".csv".to_string(), "notepad".to_string()),
        (".txt".to_string(), "notepad".to_string()),
    ]);
    assert!(wait_for(|| state.files().handlers() == expected).await);
}
