//! Client side of the pipe (feature `client`): `IpcClient` connects, verifies the
//! server, says `hello`, pumps requests and events, and reconnects forever.
//! Must be spawned inside a tokio runtime.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::net::windows::named_pipe::NamedPipeClient;
use tokio::sync::{mpsc, oneshot, watch};
use tokio::time::{sleep, timeout, Instant};
use tokio_util::codec::Framed;

use rulebox_win32::pipe::{client_from_handle, open_client, pipe_owner, server_session_id};
use rulebox_win32::sid::{current_user_sid, Sid};
use rulebox_win32::Win32Error;

use crate::codec::{frame_or_end, FrameCodec};
use crate::envelope::{ErrorCode, Frame, RpcError};
use crate::methods::{events, Hello, Method};
use crate::types::{
    AgentSnapshot, ClientInfo, HelloParams, HelloResult, ProtocolVersion, ShutdownReason,
    ShuttingDownData,
};
use crate::{ADMIN_PIPE, PROTOCOL_MAJOR, PROTOCOL_MINOR, SHELL_PIPE, SIM_SUFFIX};

/// Default time a `call` waits for its response.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const RECONNECT_MIN: Duration = Duration::from_millis(100);
const RECONNECT_MAX: Duration = Duration::from_secs(2);
const BUSY_RETRY: Duration = Duration::from_millis(50);
const BUSY_GIVE_UP: Duration = Duration::from_secs(5);

// Events are rare, and the plan fixes `StateChanged(AgentSnapshot)` as the public shape.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone)]
pub enum ClientEvent {
    Linked(HelloResult),
    Unlinked,
    StateChanged(AgentSnapshot),
    ShuttingDown { reason: ShutdownReason, grace_ms: u64 },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkState {
    Disconnected,
    Connecting,
    Linked,
}

#[derive(Debug, Clone, thiserror::Error)]
pub enum CallError {
    #[error("not connected to the agent")]
    NotLinked,
    #[error("the agent did not answer in time")]
    Timeout,
    #[error("the agent returned an error: {0:?}")]
    Rpc(RpcError),
    #[error("the pipe is not owned by the expected account")]
    ServerNotTrusted,
    #[error("protocol error: {0}")]
    Protocol(String),
}

/// Where to connect and whom to trust. `production()` is what the Staff App uses.
#[derive(Debug, Clone)]
pub struct ClientConfig {
    pub pipe_name: String,
    /// The account that must own the pipe.
    pub trusted_owner: Sid,
    pub request_timeout: Duration,
    /// (1.1) The server must run in session 0, i.e. be a service (plan Section
    /// 6.2, client check 3). Off only for the `.sim` pipe and for tests, whose
    /// server runs in the current user's session.
    pub require_session_zero: bool,
}

impl ClientConfig {
    /// The real pipe, owned by SYSTEM. In debug builds with `RULEBOX_AGENT_SIM=1`
    /// the `.sim` pipe owned by the current user (release builds ignore the variable).
    pub fn production() -> Self {
        let sim = cfg!(debug_assertions) && std::env::var("RULEBOX_AGENT_SIM").as_deref() == Ok("1");
        if sim {
            Self {
                pipe_name: format!("{SHELL_PIPE}{SIM_SUFFIX}"),
                trusted_owner: current_user_sid().unwrap_or_else(|_| Sid::system()),
                request_timeout: REQUEST_TIMEOUT,
                require_session_zero: false,
            }
        } else {
            Self {
                pipe_name: SHELL_PIPE.to_string(),
                trusted_owner: Sid::system(),
                request_timeout: REQUEST_TIMEOUT,
                require_session_zero: true,
            }
        }
    }

    /// The admin pipe, for `rulebox-agent enroll|status|unenroll`. With `simulate`
    /// the `.sim` pipe owned by the current user, with no session check.
    pub fn admin(simulate: bool) -> Self {
        if simulate {
            Self {
                pipe_name: format!("{ADMIN_PIPE}{SIM_SUFFIX}"),
                trusted_owner: current_user_sid().unwrap_or_else(|_| Sid::system()),
                request_timeout: REQUEST_TIMEOUT,
                require_session_zero: false,
            }
        } else {
            Self {
                pipe_name: ADMIN_PIPE.to_string(),
                trusted_owner: Sid::system(),
                request_timeout: REQUEST_TIMEOUT,
                require_session_zero: true,
            }
        }
    }

    /// Replaces the request timeout (the default is `REQUEST_TIMEOUT`).
    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.request_timeout = timeout;
        self
    }
}

struct Cmd {
    method: &'static str,
    params: serde_json::Value,
    reply: oneshot::Sender<Result<serde_json::Value, CallError>>,
}

struct Shared {
    cmd_tx: mpsc::Sender<Cmd>,
    link_rx: watch::Receiver<LinkState>,
    not_trusted: AtomicBool,
    request_timeout: Duration,
}

/// Cheap to clone.
#[derive(Clone)]
pub struct IpcClient {
    shared: Arc<Shared>,
}

impl IpcClient {
    /// Spawns the connection task. Never fails: it keeps reconnecting.
    pub fn spawn(info: ClientInfo) -> (IpcClient, mpsc::Receiver<ClientEvent>) {
        Self::spawn_with(info, ClientConfig::production())
    }

    pub fn spawn_with(info: ClientInfo, config: ClientConfig) -> (IpcClient, mpsc::Receiver<ClientEvent>) {
        let (cmd_tx, cmd_rx) = mpsc::channel(32);
        let (events_tx, events_rx) = mpsc::channel(64);
        let (link_tx, link_rx) = watch::channel(LinkState::Disconnected);
        let shared = Arc::new(Shared {
            cmd_tx,
            link_rx,
            not_trusted: AtomicBool::new(false),
            request_timeout: config.request_timeout,
        });
        tokio::spawn(run(config, info, cmd_rx, link_tx, events_tx, Arc::clone(&shared)));
        (IpcClient { shared }, events_rx)
    }

    pub async fn call<M: Method>(&self, params: M::Params) -> Result<M::Result, CallError> {
        if *self.shared.link_rx.borrow() != LinkState::Linked {
            return Err(if self.shared.not_trusted.load(Ordering::Relaxed) {
                CallError::ServerNotTrusted
            } else {
                CallError::NotLinked
            });
        }
        let params = serde_json::to_value(params).map_err(|e| CallError::Protocol(e.to_string()))?;
        let (reply, answer) = oneshot::channel();
        self.shared
            .cmd_tx
            .send(Cmd { method: M::NAME, params, reply })
            .await
            .map_err(|_| CallError::NotLinked)?;
        let value = match timeout(self.shared.request_timeout, answer).await {
            Err(_) => return Err(CallError::Timeout),
            Ok(Err(_)) => return Err(CallError::NotLinked),
            Ok(Ok(result)) => result?,
        };
        serde_json::from_value(value).map_err(|e| CallError::Protocol(e.to_string()))
    }

    pub fn connection(&self) -> watch::Receiver<LinkState> {
        self.shared.link_rx.clone()
    }
}

type Pipe = Framed<NamedPipeClient, FrameCodec>;

enum ConnectError {
    NotFound,
    NotTrusted,
    Other,
}

/// Opens the pipe (retrying while busy) and checks who owns it.
async fn connect(config: &ClientConfig) -> Result<Pipe, ConnectError> {
    let give_up = Instant::now() + BUSY_GIVE_UP;
    let handle = loop {
        match open_client(&config.pipe_name) {
            Ok(handle) => break handle,
            Err(Win32Error::Busy) if Instant::now() < give_up => sleep(BUSY_RETRY).await,
            Err(Win32Error::NotFound) => return Err(ConnectError::NotFound),
            Err(_) => return Err(ConnectError::Other),
        }
    };
    match pipe_owner(handle.raw().0) {
        Ok(owner) if owner == config.trusted_owner => {}
        Ok(_) => return Err(ConnectError::NotTrusted),
        Err(_) => return Err(ConnectError::Other),
    }
    // From 1.1 the client sends passwords and the exit PIN, so the other end must
    // be a service. A process of the Staff account cannot run in session 0.
    if config.require_session_zero {
        match server_session_id(handle.raw().0) {
            Ok(0) => {}
            Ok(_) => return Err(ConnectError::NotTrusted),
            Err(_) => return Err(ConnectError::Other),
        }
    }
    let pipe = client_from_handle(handle).map_err(|_| ConnectError::Other)?;
    Ok(Framed::new(pipe, FrameCodec::new()))
}

/// Sends `hello` and waits for the answer. `None` on any failure.
async fn say_hello(pipe: &mut Pipe, info: &ClientInfo, wait: Duration) -> Option<HelloResult> {
    let params = HelloParams {
        protocol: ProtocolVersion { major: PROTOCOL_MAJOR, minor: PROTOCOL_MINOR },
        client: info.clone(),
    };
    let request = Frame::Request {
        id: 0,
        method: Hello::NAME.to_string(),
        params: serde_json::to_value(params).ok()?,
    };
    pipe.send(request).await.ok()?;
    let answer = timeout(wait, async {
        while let Ok(Some(frame)) = frame_or_end(pipe.next().await) {
            if let Frame::Response { id: 0, ok, result, .. } = frame {
                return if ok { result } else { None };
            }
        }
        None
    })
    .await
    .ok()??;
    let hello: HelloResult = serde_json::from_value(answer).ok()?;
    (hello.protocol.major == PROTOCOL_MAJOR).then_some(hello)
}

/// Sleeps for `delay`, answering requests that arrive meanwhile with `NotLinked`.
/// Returns false when every `IpcClient` is gone and the task should end.
async fn back_off(cmd_rx: &mut mpsc::Receiver<Cmd>, delay: Duration) -> bool {
    let deadline = sleep(delay);
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            () = &mut deadline => return true,
            cmd = cmd_rx.recv() => match cmd {
                Some(cmd) => { let _ = cmd.reply.send(Err(CallError::NotLinked)); }
                None => return false,
            },
        }
    }
}

async fn run(
    config: ClientConfig,
    info: ClientInfo,
    mut cmd_rx: mpsc::Receiver<Cmd>,
    link_tx: watch::Sender<LinkState>,
    events_tx: mpsc::Sender<ClientEvent>,
    shared: Arc<Shared>,
) {
    let mut delay = RECONNECT_MIN;
    loop {
        link_tx.send_replace(LinkState::Connecting);
        let linked = match connect(&config).await {
            Ok(mut pipe) => {
                shared.not_trusted.store(false, Ordering::Relaxed);
                say_hello(&mut pipe, &info, config.request_timeout).await.map(|hello| (pipe, hello))
            }
            Err(ConnectError::NotTrusted) => {
                shared.not_trusted.store(true, Ordering::Relaxed);
                None
            }
            Err(ConnectError::NotFound | ConnectError::Other) => None,
        };

        if let Some((mut pipe, hello)) = linked {
            delay = RECONNECT_MIN;
            link_tx.send_replace(LinkState::Linked);
            let _ = events_tx.send(ClientEvent::Linked(hello)).await;
            let keep_running = pump(&mut pipe, &mut cmd_rx, &events_tx).await;
            link_tx.send_replace(LinkState::Disconnected);
            let _ = events_tx.send(ClientEvent::Unlinked).await;
            if !keep_running {
                return;
            }
        } else {
            link_tx.send_replace(LinkState::Disconnected);
        }

        if !back_off(&mut cmd_rx, delay).await {
            return;
        }
        delay = (delay * 2).min(RECONNECT_MAX);
    }
}

/// Runs one linked connection. Returns false when the client was dropped.
async fn pump(
    pipe: &mut Pipe,
    cmd_rx: &mut mpsc::Receiver<Cmd>,
    events_tx: &mpsc::Sender<ClientEvent>,
) -> bool {
    let mut pending: HashMap<u32, oneshot::Sender<Result<serde_json::Value, CallError>>> = HashMap::new();
    let mut next_id: u32 = 1; // 0 is the hello
    let keep_running = loop {
        tokio::select! {
            cmd = cmd_rx.recv() => {
                let Some(cmd) = cmd else { break false };
                pending.retain(|_, reply| !reply.is_closed());
                while next_id == 0 || pending.contains_key(&next_id) {
                    next_id = next_id.wrapping_add(1);
                }
                let id = next_id;
                next_id = next_id.wrapping_add(1);
                pending.insert(id, cmd.reply);
                let request = Frame::Request { id, method: cmd.method.to_string(), params: cmd.params };
                if pipe.send(request).await.is_err() {
                    break true;
                }
            }
            item = pipe.next() => match frame_or_end(item) {
                Ok(Some(Frame::Response { id, ok, result, error })) => {
                    if let Some(reply) = pending.remove(&id) {
                        let _ = reply.send(response_outcome(ok, result, error));
                    }
                }
                Ok(Some(Frame::Event { event, data })) => {
                    if let Some(event) = parse_event(&event, data) {
                        let _ = events_tx.send(event).await;
                    }
                }
                // The agent never sends requests; a protocol violation ends the link.
                Ok(Some(Frame::Request { .. })) | Ok(None) | Err(_) => break true,
            },
        }
    };
    for (_, reply) in pending {
        let _ = reply.send(Err(CallError::NotLinked));
    }
    keep_running
}

/// Turns the fields of a response frame into the outcome of one call.
fn response_outcome(
    ok: bool,
    result: Option<serde_json::Value>,
    error: Option<RpcError>,
) -> Result<serde_json::Value, CallError> {
    if ok {
        Ok(result.unwrap_or_else(|| serde_json::json!({})))
    } else {
        Err(CallError::Rpc(error.unwrap_or_else(|| RpcError {
            code: ErrorCode::Internal,
            message: "error response without an error".into(),
            retryable: false,
            data: None,
        })))
    }
}

/// One connection, `hello`, one request, close. Blocks the calling thread: it
/// builds a current-thread tokio runtime, so never call it from inside a runtime.
///
/// Pipe missing or connection lost -> `NotLinked`. Owner or session check failed
/// -> `ServerNotTrusted`. It does not reconnect; it waits for a busy pipe at most
/// `BUSY_GIVE_UP`. Used by the CLI (`enroll`, `status`, `unenroll`) and by the
/// launcher's fallback screen.
pub fn call_once<M: Method>(
    config: ClientConfig,
    info: ClientInfo,
    params: M::Params,
) -> Result<M::Result, CallError> {
    let params = serde_json::to_value(params).map_err(|e| CallError::Protocol(e.to_string()))?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| CallError::Protocol(format!("cannot start the runtime: {e}")))?;
    let value = runtime.block_on(async {
        let mut pipe = match connect(&config).await {
            Ok(pipe) => pipe,
            Err(ConnectError::NotTrusted) => return Err(CallError::ServerNotTrusted),
            Err(ConnectError::NotFound | ConnectError::Other) => return Err(CallError::NotLinked),
        };
        say_hello(&mut pipe, &info, config.request_timeout).await.ok_or(CallError::NotLinked)?;

        // 0 was the hello.
        let id = 1;
        let request = Frame::Request { id, method: M::NAME.to_string(), params };
        pipe.send(request).await.map_err(|_| CallError::NotLinked)?;
        let answer = timeout(config.request_timeout, async {
            loop {
                match frame_or_end(pipe.next().await) {
                    Ok(Some(Frame::Response { id: got, ok, result, error })) if got == id => {
                        return response_outcome(ok, result, error);
                    }
                    // Events and answers to other ids are not ours.
                    Ok(Some(Frame::Event { .. } | Frame::Response { .. })) => {}
                    Ok(Some(Frame::Request { .. })) | Ok(None) | Err(_) => {
                        return Err(CallError::NotLinked);
                    }
                }
            }
        })
        .await;
        answer.unwrap_or(Err(CallError::Timeout))
    })?;
    serde_json::from_value(value).map_err(|e| CallError::Protocol(e.to_string()))
}

/// Unknown events and unparsable data are ignored (plan Section 6.5).
fn parse_event(event: &str, data: serde_json::Value) -> Option<ClientEvent> {
    match event {
        events::STATE_CHANGED => serde_json::from_value(data).ok().map(ClientEvent::StateChanged),
        events::AGENT_SHUTTING_DOWN => {
            let data: ShuttingDownData = serde_json::from_value(data).ok()?;
            Some(ClientEvent::ShuttingDown { reason: data.reason, grace_ms: data.grace_ms })
        }
        _ => None,
    }
}
