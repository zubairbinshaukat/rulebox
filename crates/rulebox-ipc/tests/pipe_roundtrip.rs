//! Named-pipe round trips on the dev machine. Every test uses its own pipe name
//! (`\\.\pipe\dev.rulebox.test.<pid>.<n>`), never the production names, and the
//! current user's SID instead of the Staff account's.

// Test helpers outside #[test] functions use unwrap/expect.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

use rulebox_ipc::client::{call_once, CallError, ClientConfig, ClientEvent, IpcClient};
use rulebox_ipc::codec::TransportError;
use rulebox_ipc::envelope::Frame;
use rulebox_ipc::methods::{Empty, Hello, Method, ShellReady, StateGet};
use rulebox_ipc::server::{Connection, PipeListener};
use rulebox_ipc::types::*;
use rulebox_ipc::{CAPABILITIES, PROTOCOL_MAJOR, PROTOCOL_MINOR};
use rulebox_win32::pipe::{open_client_with_access, probe_create_instance, sim_pipe_sddl};
use rulebox_win32::sid::{current_user_sid, Sid};
use rulebox_win32::Win32Error;
use serde_json::json;
use tokio::sync::mpsc::Receiver;
use tokio::time::timeout;

static COUNTER: AtomicU32 = AtomicU32::new(0);

fn unique_name() -> String {
    format!(r"\\.\pipe\dev.rulebox.test.{}.{}", std::process::id(), COUNTER.fetch_add(1, Ordering::Relaxed))
}

fn info() -> ClientInfo {
    ClientInfo { role: ClientRole::Shell, name: "test".into(), version: "0.0.0".into() }
}

fn config(name: &str, owner: &Sid) -> ClientConfig {
    ClientConfig {
        pipe_name: name.into(),
        trusted_owner: owner.clone(),
        request_timeout: Duration::from_secs(5),
        // The test server runs in the current user's session, not session 0.
        require_session_zero: false,
    }
}

fn snapshot() -> AgentSnapshot {
    AgentSnapshot {
        agent_version: "0.0.0".into(),
        enrollment: EnrollmentStatus::NotEnrolled,
        device: None,
        convex_url: None,
        connection: ConnectionStatus::Offline,
        kiosk: KioskStatus { enabled: false, phase: KioskPhase::NotApplied, error_code: None },
        shell: ShellStatus { health: ShellHealth::NotRunning },
        display_mode: DisplayMode::Standard,
        desired_state: None,
        desired_state_version: 0,
        server_time_offset_ms: None,
        clock_suspect: false,
        admin_exit: None,
        power: None,
        org_name: None,
    }
}

fn response(id: u32, result: serde_json::Value) -> Frame {
    Frame::Response { id, ok: true, result: Some(result), error: None }
}

/// Reads the `hello`, verifies the peer and answers it.
async fn serve_hello(conn: &mut Connection) -> rulebox_ipc::server::PeerInfo {
    let Some(Frame::Request { id, method, .. }) = conn.read_frame().await.unwrap() else {
        panic!("expected a request");
    };
    assert_eq!(method, Hello::NAME);
    let peer = conn.verify_peer().unwrap();
    let result = HelloResult {
        protocol: ProtocolVersion { major: PROTOCOL_MAJOR, minor: PROTOCOL_MINOR },
        agent_version: "0.0.0".into(),
        capabilities: CAPABILITIES.iter().map(|c| (*c).to_string()).collect(),
    };
    conn.write_frame(response(id, serde_json::to_value(result).unwrap())).await.unwrap();
    peer
}

async fn next_event(events: &mut Receiver<ClientEvent>) -> ClientEvent {
    timeout(Duration::from_secs(10), events.recv()).await.expect("event in time").expect("channel open")
}

#[tokio::test]
async fn hello_and_verify_peer() {
    let me = current_user_sid().unwrap();
    let name = unique_name();
    let mut listener = PipeListener::bind(&name, &sim_pipe_sddl(&me)).unwrap();
    let (_client, mut events) = IpcClient::spawn_with(info(), config(&name, &me));

    let mut conn = listener.accept().await.unwrap();
    let peer = serve_hello(&mut conn).await;
    assert_eq!(peer.user, me);
    assert_eq!(peer.pid, std::process::id());
    assert!(peer.image_path.is_some());

    match next_event(&mut events).await {
        ClientEvent::Linked(hello) => {
            assert_eq!(hello.protocol.major, PROTOCOL_MAJOR);
            assert_eq!(hello.capabilities, ["state", "health"]);
        }
        other => panic!("unexpected event {other:?}"),
    }
}

#[tokio::test]
async fn out_of_order_replies_resolve_correctly() {
    let me = current_user_sid().unwrap();
    let name = unique_name();
    let mut listener = PipeListener::bind(&name, &sim_pipe_sddl(&me)).unwrap();
    let (client, mut events) = IpcClient::spawn_with(info(), config(&name, &me));

    let server = tokio::spawn(async move {
        let mut conn = listener.accept().await.unwrap();
        serve_hello(&mut conn).await;
        let mut requests = Vec::new();
        for _ in 0..2 {
            let Some(Frame::Request { id, method, .. }) = conn.read_frame().await.unwrap() else {
                panic!("expected a request");
            };
            requests.push((id, method));
        }
        // Answer in the opposite order.
        for (id, method) in requests.into_iter().rev() {
            let result = if method == StateGet::NAME { serde_json::to_value(snapshot()).unwrap() } else { json!({}) };
            conn.write_frame(response(id, result)).await.unwrap();
        }
        conn
    });

    assert!(matches!(next_event(&mut events).await, ClientEvent::Linked(_)));
    let (state, ready) = tokio::join!(client.call::<StateGet>(Empty {}), client.call::<ShellReady>(Empty {}));
    assert_eq!(state.unwrap(), snapshot());
    assert_eq!(ready.unwrap(), Empty {});
    drop(server.await.unwrap());
}

#[tokio::test]
async fn second_bind_on_the_same_name_fails() {
    let me = current_user_sid().unwrap();
    let name = unique_name();
    let _first = PipeListener::bind(&name, &sim_pipe_sddl(&me)).unwrap();
    assert!(matches!(PipeListener::bind(&name, &sim_pipe_sddl(&me)), Err(TransportError::NameInUse)));
}

#[tokio::test]
async fn reduced_access_mask_still_works() {
    let me = current_user_sid().unwrap();
    let name = unique_name();
    // The Staff ACE shape: only 0x12019b for the client, no FILE_CREATE_PIPE_INSTANCE.
    let sddl = format!("O:{me}G:{me}D:P(A;;0x12019b;;;{me})");
    let mut listener = PipeListener::bind(&name, &sddl).unwrap();

    // The descriptor is enforced: a right the ACE does not grant (DELETE) is refused.
    // (GENERIC_WRITE, which includes bit 0x4, was accepted by this elevated process;
    // see the report. Probing it would also consume the pending pipe instance.)
    let refused = open_client_with_access(&name, 0x0001_0000 | 0x1);
    assert!(matches!(refused, Err(Win32Error::Api { code: 5, .. })), "{:?}", refused.err());

    let (_client, mut events) = IpcClient::spawn_with(info(), config(&name, &me));
    let mut conn = listener.accept().await.unwrap();
    serve_hello(&mut conn).await;
    assert!(matches!(next_event(&mut events).await, ClientEvent::Linked(_)));
}

#[tokio::test]
async fn client_refuses_a_pipe_with_the_wrong_owner() {
    let me = current_user_sid().unwrap();
    let name = unique_name();
    let _listener = PipeListener::bind(&name, &sim_pipe_sddl(&me)).unwrap();
    // The pipe is owned by the current user, but the client expects SYSTEM.
    let (client, _events) = IpcClient::spawn_with(info(), config(&name, &Sid::system()));
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(matches!(client.call::<StateGet>(Empty {}).await, Err(CallError::ServerNotTrusted)));
}

#[tokio::test]
async fn dropping_the_server_fails_a_pending_call_with_not_linked() {
    let me = current_user_sid().unwrap();
    let name = unique_name();
    let mut listener = PipeListener::bind(&name, &sim_pipe_sddl(&me)).unwrap();
    let (client, mut events) = IpcClient::spawn_with(info(), config(&name, &me));

    let mut conn = listener.accept().await.unwrap();
    serve_hello(&mut conn).await;
    assert!(matches!(next_event(&mut events).await, ClientEvent::Linked(_)));

    let pending = {
        let client = client.clone();
        tokio::spawn(async move { client.call::<StateGet>(Empty {}).await })
    };
    // Wait for the request to arrive, then drop the server end without answering.
    assert!(matches!(conn.read_frame().await.unwrap(), Some(Frame::Request { .. })));
    drop(conn);

    let outcome = timeout(Duration::from_secs(10), pending).await.unwrap().unwrap();
    assert!(matches!(outcome, Err(CallError::NotLinked)), "{outcome:?}");
    assert!(matches!(next_event(&mut events).await, ClientEvent::Unlinked));
}

#[tokio::test]
async fn call_once_returns_the_result() {
    use rulebox_ipc::methods::AdminExitSubmit;
    use rulebox_ipc::requests::{AdminExitOutcome, AdminExitSubmitParams};

    let me = current_user_sid().unwrap();
    let name = unique_name();
    let mut listener = PipeListener::bind(&name, &sim_pipe_sddl(&me)).unwrap();
    let cfg = config(&name, &me);
    let call = tokio::task::spawn_blocking(move || {
        call_once::<AdminExitSubmit>(cfg, info(), AdminExitSubmitParams { pin: "2468".into() })
    });

    let mut conn = listener.accept().await.unwrap();
    serve_hello(&mut conn).await;
    let Some(Frame::Request { id, method, params }) = conn.read_frame().await.unwrap() else {
        panic!("expected a request");
    };
    assert_eq!(method, AdminExitSubmit::NAME);
    assert_eq!(params, json!({ "pin": "2468" }));
    conn.write_frame(response(id, json!({ "outcome": "wrongPin", "attemptsLeft": 3, "retryAfterMs": null })))
        .await
        .unwrap();

    let result = call.await.unwrap().unwrap();
    assert_eq!(result.outcome, AdminExitOutcome::WrongPin);
    assert_eq!(result.attempts_left, Some(3));
}

#[tokio::test]
async fn call_once_turns_an_error_response_into_rpc() {
    let me = current_user_sid().unwrap();
    let name = unique_name();
    let mut listener = PipeListener::bind(&name, &sim_pipe_sddl(&me)).unwrap();
    let cfg = config(&name, &me);
    let call = tokio::task::spawn_blocking(move || call_once::<StateGet>(cfg, info(), Empty {}));

    let mut conn = listener.accept().await.unwrap();
    serve_hello(&mut conn).await;
    let Some(Frame::Request { id, .. }) = conn.read_frame().await.unwrap() else {
        panic!("expected a request");
    };
    let error = rulebox_ipc::RpcError {
        code: rulebox_ipc::ErrorCode::NotEnrolled,
        message: "not enrolled".into(),
        retryable: false,
        data: None,
    };
    conn.write_frame(Frame::Response { id, ok: false, result: None, error: Some(error) }).await.unwrap();

    match call.await.unwrap() {
        Err(CallError::Rpc(e)) => assert_eq!(e.code, rulebox_ipc::ErrorCode::NotEnrolled),
        other => panic!("unexpected {other:?}"),
    }
}

#[tokio::test]
async fn call_once_on_a_missing_pipe_is_not_linked_quickly() {
    let me = current_user_sid().unwrap();
    let cfg = config(&unique_name(), &me);
    let started = std::time::Instant::now();
    let outcome = tokio::task::spawn_blocking(move || call_once::<StateGet>(cfg, info(), Empty {}))
        .await
        .unwrap();
    assert!(matches!(outcome, Err(CallError::NotLinked)), "{outcome:?}");
    assert!(started.elapsed() < Duration::from_secs(6), "took {:?}", started.elapsed());
}

#[tokio::test]
async fn call_once_requiring_session_zero_refuses_a_server_in_another_session() {
    let me = current_user_sid().unwrap();
    let name = unique_name();
    let _listener = PipeListener::bind(&name, &sim_pipe_sddl(&me)).unwrap();
    // The server is this test process: owned by the current user, in the
    // interactive session, so only the session check can refuse it.
    let mut cfg = config(&name, &me);
    cfg.require_session_zero = true;
    let outcome = tokio::task::spawn_blocking(move || call_once::<StateGet>(cfg, info(), Empty {}))
        .await
        .unwrap();
    assert!(matches!(outcome, Err(CallError::ServerNotTrusted)), "{outcome:?}");
}

#[tokio::test]
async fn client_links_to_an_agent_that_says_minor_zero() {
    let me = current_user_sid().unwrap();
    let name = unique_name();
    let mut listener = PipeListener::bind(&name, &sim_pipe_sddl(&me)).unwrap();
    let (_client, mut events) = IpcClient::spawn_with(info(), config(&name, &me));

    let mut conn = listener.accept().await.unwrap();
    let Some(Frame::Request { id, .. }) = conn.read_frame().await.unwrap() else {
        panic!("expected a request");
    };
    conn.verify_peer().unwrap();
    let result = HelloResult {
        protocol: ProtocolVersion { major: PROTOCOL_MAJOR, minor: 0 },
        agent_version: "0.0.0".into(),
        capabilities: vec!["state".into(), "health".into()],
    };
    conn.write_frame(response(id, serde_json::to_value(result).unwrap())).await.unwrap();
    match next_event(&mut events).await {
        ClientEvent::Linked(hello) => assert_eq!(hello.protocol.minor, 0),
        other => panic!("unexpected event {other:?}"),
    }
}

#[tokio::test]
async fn probe_create_instance_runs_against_an_existing_pipe() {
    let me = current_user_sid().unwrap();
    let name = unique_name();
    let _listener = PipeListener::bind(&name, &sim_pipe_sddl(&me)).unwrap();
    // The test server grants the current user everything, so this only proves
    // that the function runs; the real check is the VM's "IPC security" probe.
    let outcome = probe_create_instance(&name).unwrap();
    eprintln!("probe_create_instance on the test pipe: {outcome:?}");
    assert!(matches!(outcome, None | Some(_)));
}
