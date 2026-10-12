//! Named-pipe round trips on the dev machine. Every test uses its own pipe name
//! (`\\.\pipe\dev.rulebox.test.<pid>.<n>`), never the production names, and the
//! current user's SID instead of the Staff account's.

// Test helpers outside #[test] functions use unwrap/expect.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

use rulebox_ipc::client::{CallError, ClientConfig, ClientEvent, IpcClient};
use rulebox_ipc::codec::TransportError;
use rulebox_ipc::envelope::Frame;
use rulebox_ipc::methods::{Empty, Hello, Method, ShellReady, StateGet};
use rulebox_ipc::server::{Connection, PipeListener};
use rulebox_ipc::types::*;
use rulebox_ipc::{CAPABILITIES, PROTOCOL_MAJOR, PROTOCOL_MINOR};
use rulebox_win32::pipe::{open_client_with_access, sim_pipe_sddl};
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
    ClientConfig { pipe_name: name.into(), trusted_owner: owner.clone(), request_timeout: Duration::from_secs(5) }
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
