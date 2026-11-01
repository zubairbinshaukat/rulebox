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
use rulebox_staff_lib::model::{
    map_client_event, map_sign_in_result, AgentEvent, CatalogState, CatalogStatus, Employee,
    EmployeeBrief, SessionEndedReason, SessionState, ShellModeDto, ShellState, SignInOutcome,
    SignInRequest,
};
use rulebox_staff_lib::session::{note_session_ended, plan_session_ended, EndedPlan};
use rulebox_staff_lib::state::{spawn_agent_tasks, AppState};
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

#[test]
fn only_a_signed_in_session_is_closed_and_a_revocation_is_always_shown() {
    use SessionEndedReason::{CredentialChanged, EmployeeRemoved, Revoked, Unknown};

    for reason in [EmployeeRemoved, CredentialChanged, Revoked, Unknown] {
        assert_eq!(plan_session_ended(&signed_in(), reason), EndedPlan::SignOutThenNote);
        assert_eq!(plan_session_ended(&SessionState::SigningIn, reason), EndedPlan::Ignore);
        assert_eq!(plan_session_ended(&SessionState::SigningOut, reason), EndedPlan::Ignore);
    }
    assert_eq!(plan_session_ended(&signed_out_as_maya(), Revoked), EndedPlan::NoteOnly);
    for reason in [EmployeeRemoved, CredentialChanged, Unknown] {
        assert_eq!(plan_session_ended(&signed_out_as_maya(), reason), EndedPlan::Ignore);
    }
}

#[tokio::test(flavor = "current_thread")]
async fn the_note_is_kept_and_a_removed_employee_is_not_offered_again() {
    let state = AppState::new(Arc::new(DemoAgent::new()), ShellState::initial(ShellModeDto::Dev));

    state.update(|s| s.session = signed_out_as_maya());
    note_session_ended(&state, SessionEndedReason::CredentialChanged);
    let after = state.snapshot();
    assert_eq!(after.session_ended, Some(SessionEndedReason::CredentialChanged));
    assert_eq!(after.session, signed_out_as_maya(), "a changed password: Maya can sign in again");

    for reason in [SessionEndedReason::EmployeeRemoved, SessionEndedReason::Revoked] {
        state.update(|s| s.session = signed_out_as_maya());
        note_session_ended(&state, reason);
        let after = state.snapshot();
        assert_eq!(after.session_ended, Some(reason));
        assert_eq!(after.session, SessionState::SignedOut { last: None });
    }
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
    state.update(|s| s.session = signed_in());

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
