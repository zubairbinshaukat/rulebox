//! The connection engine shared by the shell pipe and the admin pipe (plan
//! Sections 6.2 to 6.8): the `hello` handshake and its 5-second deadline, peer
//! verification before the first answer, the in-flight limit, the outbound queue
//! and the `state.changed` coalescing.
//!
//! What differs between the pipes (who may connect, which methods exist) comes in
//! through the [`PeerVerifier`] and [`Dispatcher`] traits.
//!
//! **Logging rule.** This module logs the method name, the request id, the
//! connection id, the peer pid and whether the answer was a result or an error
//! code. It never logs `params`, a result, a whole frame or the text of a
//! deserialisation error (serde can quote the offending value, and from protocol
//! 1.1 on params carry passwords and PINs).

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures_util::future::BoxFuture;
use rulebox_ipc::codec::{CodecError, TransportError};
use rulebox_ipc::methods::{events, Hello, Method};
use rulebox_ipc::server::{Connection, FrameWriter, PipeListener};
use rulebox_ipc::types::{
    AgentSnapshot, ClientRole, HelloParams, HelloResult, ProtocolVersion, ShutdownReason,
    ShuttingDownData,
};
use rulebox_ipc::{ErrorCode, Frame, RpcError, MAX_IN_FLIGHT, PROTOCOL_MAJOR, PROTOCOL_MINOR};
use tokio::sync::broadcast::error::RecvError;
use tokio::sync::{broadcast, mpsc, watch};
use tokio::task::JoinSet;
use tokio::time::{sleep, timeout};
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

/// Frames queued for one connection (plan Section 6.8). `state.changed` does not
/// use this queue: it is coalesced in the writer. A full queue closes the
/// connection.
pub const OUTBOUND_QUEUE: usize = 64;
/// Longest a connection is given to flush its last frames at shutdown.
const FLUSH_GRACE: Duration = Duration::from_secs(1);
/// Longest an error answer to a rejected client may take to write.
const REJECT_WRITE_LIMIT: Duration = Duration::from_secs(1);
const ACCEPT_RETRY: Duration = Duration::from_millis(100);
/// Wait before trying to create the first pipe instance again.
const BIND_RETRY: Duration = Duration::from_secs(5);
/// Longest method name written to the log.
const LOGGED_METHOD_CHARS: usize = 48;

pub type RpcResult = Result<serde_json::Value, RpcError>;

/// Who is on the other end of one connection, known after `hello`.
#[derive(Debug, Clone)]
pub struct PeerCtx {
    pub connection_id: u64,
    pub pid: u32,
    pub session_id: u32,
    /// Only a label for logs and the watchdog; never used to decide what a
    /// client may do (plan Section 6.11).
    pub role: ClientRole,
}

/// What a successful peer verification yields.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VerifiedPeer {
    pub pid: u32,
    pub session_id: u32,
}

/// Runs once per connection, after the first frame is read and before it is
/// answered (plan Section 6.2). Synchronous on purpose: impersonation must not
/// span an `.await`. `Err` carries a fixed label for the log; the client only
/// ever sees `unauthorized`.
pub trait PeerVerifier: Send + Sync + 'static {
    fn verify(&self, conn: &Connection) -> Result<VerifiedPeer, &'static str>;
}

/// The methods of one pipe.
pub trait Dispatcher: Send + Sync + 'static {
    /// Listed in the `hello` result.
    fn capabilities(&self) -> Vec<String>;
    /// A client finished `hello`.
    fn connected(&self, _peer: &PeerCtx) {}
    /// A client that finished `hello` is gone.
    fn closed(&self, _peer: &PeerCtx) {}
    /// `None` means "not my method" (the client gets `unknown_method`). The future
    /// must not borrow `params`.
    fn dispatch(
        &self,
        peer: &PeerCtx,
        method: &str,
        params: serde_json::Value,
    ) -> Option<BoxFuture<'static, RpcResult>>;
}

pub struct Engine {
    /// "shell" or "admin", for log lines.
    pub label: &'static str,
    pub verifier: Box<dyn PeerVerifier>,
    pub dispatcher: Box<dyn Dispatcher>,
    /// When set, every change becomes a `state.changed` event on every connection.
    pub snapshot_events: Option<watch::Receiver<AgentSnapshot>>,
    /// When set, frames sent here go to every connection.
    pub broadcast: Option<broadcast::Sender<Frame>>,
    pub hello_deadline: Duration,
}

pub fn rpc_error(code: ErrorCode, message: &str, retryable: bool) -> RpcError {
    RpcError { code, message: message.to_string(), retryable, data: None }
}

fn error_frame(id: u32, error: RpcError) -> Frame {
    Frame::Response { id, ok: false, result: None, error: Some(error) }
}

fn response_frame(id: u32, result: RpcResult) -> Frame {
    match result {
        Ok(value) => Frame::Response { id, ok: true, result: Some(value), error: None },
        Err(error) => error_frame(id, error),
    }
}

/// A `Frame::Event` for `agent.shuttingDown`.
pub fn shutting_down_frame(reason: ShutdownReason, grace_ms: u64) -> Frame {
    let data = serde_json::to_value(ShuttingDownData { reason, grace_ms })
        .unwrap_or_else(|_| serde_json::json!({}));
    Frame::Event { event: events::AGENT_SHUTTING_DOWN.to_string(), data }
}

fn short(method: &str) -> String {
    method.chars().take(LOGGED_METHOD_CHARS).collect()
}

fn transport_error_kind(error: &TransportError) -> &'static str {
    match error {
        TransportError::Io(_) | TransportError::Codec(CodecError::Io(_)) => "io",
        TransportError::Codec(CodecError::TooLarge) => "frame_too_large",
        TransportError::Codec(CodecError::InvalidJson(_)) => "invalid_json",
        TransportError::Win32(_) => "win32",
        TransportError::NameInUse => "name_in_use",
    }
}

/// Accepts connections until `shutdown`, then waits for them to finish.
pub async fn serve(mut listener: PipeListener, engine: Engine, shutdown: CancellationToken) {
    let engine = Arc::new(engine);
    let tracker = TaskTracker::new();
    let mut next_id: u64 = 0;
    let mut failing = false;
    loop {
        let accepted = tokio::select! {
            () = shutdown.cancelled() => break,
            accepted = listener.accept() => accepted,
        };
        match accepted {
            Ok(conn) => {
                failing = false;
                next_id += 1;
                tracker.spawn(connection(Arc::clone(&engine), conn, next_id, shutdown.clone()));
            }
            Err(error) => {
                // Also happens while every instance is in use; say so once per streak.
                if failing {
                    tracing::debug!(pipe = engine.label, "accept failed: {error}");
                } else {
                    tracing::warn!(pipe = engine.label, "accept failed: {error}");
                }
                failing = true;
                tokio::select! {
                    () = shutdown.cancelled() => break,
                    () = sleep(ACCEPT_RETRY) => {}
                }
            }
        }
    }
    // Stop accepting first; connected clients are told and closed by their tasks.
    drop(listener);
    tracker.close();
    tracker.wait().await;
}

/// Creates the first instance of a pipe. While another process owns the name (or
/// anything else fails) it logs a security error and retries every 5 seconds; it
/// never falls back to another name (plan Section 6.1). `None` when `token` is
/// cancelled first.
pub async fn bind_with_retry(
    label: &'static str,
    name: &str,
    sddl: &str,
    token: &CancellationToken,
) -> Option<PipeListener> {
    loop {
        match PipeListener::bind(name, sddl) {
            Ok(listener) => {
                tracing::info!("{label} pipe listening on {name}");
                return Some(listener);
            }
            Err(error) => {
                tracing::error!(
                    "cannot create the {label} pipe {name} (another process may own the name): {error}; \
                     retrying in {} s",
                    BIND_RETRY.as_secs()
                );
                tokio::select! {
                    () = token.cancelled() => return None,
                    () = sleep(BIND_RETRY) => {}
                }
            }
        }
    }
}

/// Writes one frame to a client that is being turned away, without waiting long.
async fn send_best_effort(conn: &mut Connection, frame: Frame) {
    let _ = timeout(REJECT_WRITE_LIMIT, conn.write_frame(frame)).await;
}

/// Reads the first frame, verifies the peer, and answers `hello`. `None` means
/// the connection is not to be served (the client was already told why, when
/// that is possible).
async fn handshake(
    engine: &Engine,
    conn: &mut Connection,
    connection_id: u64,
    shutdown: &CancellationToken,
) -> Option<PeerCtx> {
    let label = engine.label;
    let first = tokio::select! {
        () = shutdown.cancelled() => return None,
        read = timeout(engine.hello_deadline, conn.read_frame()) => match read {
            Err(_) => {
                tracing::debug!(pipe = label, connection_id, "no hello within the deadline; dropping");
                return None;
            }
            Ok(read) => read,
        },
    };
    let (request_id, method, params) = match first {
        Ok(Some(Frame::Request { id, method, params })) => (id, method, params),
        Ok(Some(_)) => {
            tracing::debug!(pipe = label, connection_id, "first frame was not a request");
            let error = rpc_error(ErrorCode::HelloRequired, "The first request must be hello.", false);
            send_best_effort(conn, error_frame(0, error)).await;
            return None;
        }
        Ok(None) => return None,
        Err(error) => {
            let kind = transport_error_kind(&error);
            tracing::debug!(pipe = label, connection_id, kind, "bad first frame");
            if matches!(error, TransportError::Codec(CodecError::TooLarge)) {
                let error = rpc_error(ErrorCode::FrameTooLarge, "The frame is too large.", false);
                send_best_effort(conn, error_frame(0, error)).await;
            }
            return None;
        }
    };

    let peer = match engine.verifier.verify(conn) {
        Ok(peer) => peer,
        Err(reason) => {
            tracing::warn!(pipe = label, connection_id, reason, "rejected a pipe client");
            let error = rpc_error(ErrorCode::Unauthorized, "This client is not allowed.", false);
            send_best_effort(conn, error_frame(request_id, error)).await;
            return None;
        }
    };

    if method != Hello::NAME {
        tracing::debug!(pipe = label, connection_id, pid = peer.pid, "first request was not hello");
        let error = rpc_error(ErrorCode::HelloRequired, "The first request must be hello.", false);
        send_best_effort(conn, error_frame(request_id, error)).await;
        return None;
    }
    let Ok(hello) = serde_json::from_value::<HelloParams>(params) else {
        let error = rpc_error(ErrorCode::InvalidParams, "The hello parameters are not valid.", false);
        send_best_effort(conn, error_frame(request_id, error)).await;
        return None;
    };
    if hello.protocol.major != PROTOCOL_MAJOR {
        tracing::debug!(
            pipe = label,
            connection_id,
            client_major = hello.protocol.major,
            "unsupported protocol"
        );
        let mut error =
            rpc_error(ErrorCode::UnsupportedProtocol, "This protocol version is not supported.", false);
        error.data = Some(serde_json::json!({
            "supported": { "major": PROTOCOL_MAJOR, "minor": PROTOCOL_MINOR }
        }));
        send_best_effort(conn, error_frame(request_id, error)).await;
        return None;
    }

    let answer = response_frame(request_id, hello_value(engine));
    if timeout(REJECT_WRITE_LIMIT, conn.write_frame(answer)).await.is_err() {
        return None;
    }
    Some(PeerCtx {
        connection_id,
        pid: peer.pid,
        session_id: peer.session_id,
        role: hello.client.role,
    })
}

fn hello_value(engine: &Engine) -> RpcResult {
    let result = HelloResult {
        protocol: ProtocolVersion { major: PROTOCOL_MAJOR, minor: PROTOCOL_MINOR },
        agent_version: env!("CARGO_PKG_VERSION").to_string(),
        capabilities: engine.dispatcher.capabilities(),
    };
    serde_json::to_value(result)
        .map_err(|_| rpc_error(ErrorCode::Internal, "Internal error.", true))
}

/// Queue of frames for one connection's writer. A full or closed queue ends the
/// connection.
#[derive(Clone)]
struct Outbox {
    tx: mpsc::Sender<Frame>,
    kill: CancellationToken,
}

impl Outbox {
    fn push(&self, frame: Frame) {
        if self.tx.try_send(frame).is_err() {
            self.kill.cancel();
        }
    }
}

/// Decrements the in-flight counter when a request finishes or is aborted.
struct InFlight(Arc<AtomicUsize>);

impl Drop for InFlight {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::Relaxed);
    }
}

async fn snapshot_changed(rx: &mut Option<watch::Receiver<AgentSnapshot>>) -> bool {
    match rx {
        Some(rx) => rx.changed().await.is_ok(),
        None => std::future::pending().await,
    }
}

async fn next_broadcast(rx: &mut Option<broadcast::Receiver<Frame>>, label: &'static str) -> Frame {
    loop {
        let Some(receiver) = rx.as_mut() else {
            return std::future::pending().await;
        };
        let received = receiver.recv().await;
        match received {
            Ok(frame) => return frame,
            Err(RecvError::Lagged(missed)) => {
                tracing::warn!(pipe = label, missed, "a connection missed broadcast events");
            }
            Err(RecvError::Closed) => *rx = None,
        }
    }
}

/// Writes queued frames and, in between, the newest snapshot as `state.changed`.
/// Returns when the queue is closed or a write fails.
async fn write_loop(
    mut writer: FrameWriter,
    mut queue: mpsc::Receiver<Frame>,
    mut snapshot_rx: Option<watch::Receiver<AgentSnapshot>>,
) {
    loop {
        let frame = tokio::select! {
            biased;
            queued = queue.recv() => match queued {
                Some(frame) => frame,
                None => return,
            },
            alive = snapshot_changed(&mut snapshot_rx) => {
                if !alive {
                    // The sender is gone; no more snapshot events.
                    snapshot_rx = None;
                    continue;
                }
                let data = match snapshot_rx.as_mut() {
                    Some(rx) => serde_json::to_value(&*rx.borrow_and_update()),
                    None => continue,
                };
                let Ok(data) = data else { continue };
                Frame::Event { event: events::STATE_CHANGED.to_string(), data }
            }
        };
        if write_one(&mut writer, frame).await.is_err() {
            return;
        }
    }
}

/// An answer that is too large for a frame becomes an `internal` error, so the
/// client is not left waiting; an oversized event is dropped.
async fn write_one(writer: &mut FrameWriter, frame: Frame) -> Result<(), ()> {
    let response_id = match &frame {
        Frame::Response { id, .. } => Some(*id),
        _ => None,
    };
    match writer.write_frame(frame).await {
        Ok(()) => Ok(()),
        Err(TransportError::Codec(CodecError::TooLarge)) => match response_id {
            Some(id) => {
                let error = rpc_error(ErrorCode::Internal, "The answer was too large.", false);
                writer.write_frame(error_frame(id, error)).await.map_err(|_| ())
            }
            None => Ok(()),
        },
        Err(_) => Err(()),
    }
}

/// Why the request loop of a connection ended.
#[derive(Debug, Clone, Copy)]
enum End {
    Shutdown,
    PeerClosed,
    QueueFull,
    // The text is for the `Debug` output in the connection log.
    #[allow(dead_code)]
    BadFrame(&'static str),
    Protocol,
}

async fn connection(
    engine: Arc<Engine>,
    mut conn: Connection,
    connection_id: u64,
    shutdown: CancellationToken,
) {
    let label = engine.label;
    // Subscribe and mark the snapshot as seen before the handshake, so no
    // broadcast is missed and old changes do not become events.
    let mut broadcast_rx = engine.broadcast.as_ref().map(broadcast::Sender::subscribe);
    let snapshot_rx = engine.snapshot_events.clone().map(|mut rx| {
        rx.mark_unchanged();
        rx
    });

    let Some(ctx) = handshake(&engine, &mut conn, connection_id, &shutdown).await else {
        return;
    };
    tracing::info!(
        pipe = label,
        connection_id,
        pid = ctx.pid,
        session_id = ctx.session_id,
        role = ?ctx.role,
        "client connected"
    );
    engine.dispatcher.connected(&ctx);

    let (mut reader, writer) = conn.split();
    let (queue_tx, queue_rx) = mpsc::channel::<Frame>(OUTBOUND_QUEUE);
    let kill = CancellationToken::new();
    let outbox = Outbox { tx: queue_tx, kill: kill.clone() };
    let mut writer_task = tokio::spawn(write_loop(writer, queue_rx, snapshot_rx));

    let in_flight = Arc::new(AtomicUsize::new(0));
    let mut tasks: JoinSet<()> = JoinSet::new();

    let end = loop {
        tokio::select! {
            () = shutdown.cancelled() => break End::Shutdown,
            () = kill.cancelled() => break End::QueueFull,
            frame = next_broadcast(&mut broadcast_rx, label) => outbox.push(frame),
            read = reader.read_frame() => match read {
                Ok(Some(Frame::Request { id, method, params })) => {
                    tracing::trace!(
                        pipe = label,
                        connection_id,
                        request_id = id,
                        method = ?short(&method),
                        "request"
                    );
                    handle_request(&engine, &ctx, &in_flight, &outbox, &mut tasks, id, method, params);
                }
                // Only the client sends requests; it never sends responses or events.
                Ok(Some(Frame::Response { .. } | Frame::Event { .. })) => break End::Protocol,
                Ok(None) => break End::PeerClosed,
                Err(error) => {
                    let kind = transport_error_kind(&error);
                    if matches!(error, TransportError::Codec(CodecError::TooLarge)) {
                        let error = rpc_error(ErrorCode::FrameTooLarge, "The frame is too large.", false);
                        outbox.push(error_frame(0, error));
                    }
                    break End::BadFrame(kind);
                }
            },
            Some(joined) = tasks.join_next() => {
                if let Err(error) = joined {
                    if error.is_panic() {
                        tracing::error!(pipe = label, connection_id, "a request handler panicked");
                    }
                }
            }
        }
    };

    if matches!(end, End::Shutdown) {
        outbox.push(shutting_down_frame(ShutdownReason::Stop, 0));
    }
    drop(reader);
    // Dropping the set aborts requests still running.
    drop(tasks);
    drop(outbox);
    if timeout(FLUSH_GRACE, &mut writer_task).await.is_err() {
        writer_task.abort();
    }

    tracing::info!(pipe = label, connection_id, pid = ctx.pid, end = ?end, "client disconnected");
    engine.dispatcher.closed(&ctx);
}

#[allow(clippy::too_many_arguments)]
fn handle_request(
    engine: &Engine,
    ctx: &PeerCtx,
    in_flight: &Arc<AtomicUsize>,
    outbox: &Outbox,
    tasks: &mut JoinSet<()>,
    id: u32,
    method: String,
    params: serde_json::Value,
) {
    let label = engine.label;
    let logged_method = short(&method);

    if in_flight.load(Ordering::Relaxed) >= MAX_IN_FLIGHT {
        tracing::debug!(
            pipe = label,
            connection_id = ctx.connection_id,
            pid = ctx.pid,
            request_id = id,
            method = ?logged_method,
            error = ?ErrorCode::Busy,
            "answered"
        );
        let error = rpc_error(ErrorCode::Busy, "Too many requests are in flight.", true);
        outbox.push(error_frame(id, error));
        return;
    }

    // A second hello is answered again with the same result.
    let future: Option<BoxFuture<'static, RpcResult>> = if method == Hello::NAME {
        let value = hello_value(engine);
        Some(Box::pin(std::future::ready(value)))
    } else {
        engine.dispatcher.dispatch(ctx, &method, params)
    };
    let Some(future) = future else {
        tracing::debug!(
            pipe = label,
            connection_id = ctx.connection_id,
            pid = ctx.pid,
            request_id = id,
            method = ?logged_method,
            error = ?ErrorCode::UnknownMethod,
            "answered"
        );
        let error = rpc_error(ErrorCode::UnknownMethod, "Unknown method.", false);
        outbox.push(error_frame(id, error));
        return;
    };

    in_flight.fetch_add(1, Ordering::Relaxed);
    let guard = InFlight(Arc::clone(in_flight));
    let outbox = outbox.clone();
    let connection_id = ctx.connection_id;
    let pid = ctx.pid;
    tasks.spawn(async move {
        let result = future.await;
        // Free the slot before the answer is visible, so a client that sends its
        // next request at once is not told "busy".
        drop(guard);
        match &result {
            Ok(_) => tracing::debug!(
                pipe = label,
                connection_id,
                pid,
                request_id = id,
                method = ?logged_method,
                outcome = "result",
                "answered"
            ),
            Err(error) => tracing::debug!(
                pipe = label,
                connection_id,
                pid,
                request_id = id,
                method = ?logged_method,
                outcome = "error",
                error = ?error.code,
                "answered"
            ),
        }
        outbox.push(response_frame(id, result));
    });
}
