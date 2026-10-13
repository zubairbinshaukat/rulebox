//! The shell pipe server (plan Section 6, Step 6): the Staff App and the launcher
//! talk to the agent here. The framing, handshake and queues are in `ipc_conn`;
//! this file adds peer policy, the built-in methods and the extension seam that
//! Steps 6a and 6b fill (`session.*`, `apps.list`, `adminExit.submit`).

use std::path::{Component, Path, Prefix};
use std::sync::Arc;

use futures_util::future::BoxFuture;
use futures_util::FutureExt;
use rulebox_ipc::methods::{Method, ShellHeartbeat, ShellReady, StateGet};
use rulebox_ipc::server::{Connection, PeerInfo, PipeListener};
use rulebox_ipc::types::{AgentSnapshot, ClientRole, ShutdownReason};
use rulebox_ipc::{ErrorCode, Frame, RpcError, CAPABILITIES, HELLO_DEADLINE};
use rulebox_win32::pipe::{shell_pipe_sddl, sim_pipe_sddl};
use rulebox_win32::sid::{current_user_sid, Sid};
use tokio::sync::{broadcast, mpsc, watch};
use tokio_util::sync::CancellationToken;

use crate::ipc_conn::{
    bind_with_retry, rpc_error, shutting_down_frame, Dispatcher, Engine, PeerVerifier, RpcResult,
    VerifiedPeer,
};
pub use crate::ipc_conn::PeerCtx;
use crate::paths::InstallPaths;
use crate::platform::Platform;

/// Events broadcast to every connection (plan Section 6.8: capacity 16).
const BROADCAST_CAPACITY: usize = 16;

/// How later steps add methods without touching the server (Steps 6a and 6b
/// implement it).
pub trait ShellExtension: Send + Sync + 'static {
    /// Capability strings added to the `hello` result.
    fn capabilities(&self) -> Vec<&'static str>;
    /// `None` = not my method. The future must not borrow `params`.
    fn handle(
        &self,
        peer: &PeerCtx,
        method: &str,
        params: serde_json::Value,
    ) -> Option<BoxFuture<'static, Result<serde_json::Value, RpcError>>>;
}

/// Sends an event to every connected client.
#[derive(Clone)]
pub struct ShellBroadcast {
    tx: broadcast::Sender<Frame>,
}

impl ShellBroadcast {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(BROADCAST_CAPACITY);
        Self { tx }
    }

    /// `agent.shuttingDown`: the service is stopping, or the Staff session will be
    /// signed out after `grace_ms`.
    pub fn shutting_down(&self, reason: ShutdownReason, grace_ms: u64) {
        // No receivers just means nobody is connected.
        let _ = self.tx.send(shutting_down_frame(reason, grace_ms));
    }

    fn sender(&self) -> broadcast::Sender<Frame> {
        self.tx.clone()
    }

    /// Tests read the broadcast without a pipe.
    #[cfg(test)]
    pub fn subscribe(&self) -> broadcast::Receiver<Frame> {
        self.tx.subscribe()
    }
}

impl Default for ShellBroadcast {
    fn default() -> Self {
        Self::new()
    }
}

/// What the watchdog (Step 13) and the logs learn about shell connections.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ShellSignal {
    Connected { connection_id: u64, pid: u32, role: ClientRole },
    Ready { connection_id: u64, pid: u32 },
    Heartbeat { connection_id: u64, pid: u32 },
    Closed { connection_id: u64 },
}

/// Who may talk on the shell pipe.
#[derive(Clone)]
pub enum PeerPolicy {
    /// Plan Section 6.2, server checks 1 to 3. `platform` answers "is the Staff
    /// account signed in in that session" (check 2); the plan's variant did not
    /// carry it.
    Production { staff_sid: Sid, install: InstallPaths, platform: Arc<dyn Platform> },
    /// Development only: the SID check against the current user, nothing else.
    Simulate { current_user: Sid },
}

pub struct ShellServer {
    pub snapshot_rx: watch::Receiver<AgentSnapshot>,
    pub signals: mpsc::UnboundedSender<ShellSignal>,
    pub broadcast: ShellBroadcast,
    pub extensions: Vec<Arc<dyn ShellExtension>>,
    pub peers: PeerPolicy,
}

/// Serves `listener` until `shutdown`. Connected clients get
/// `agent.shuttingDown` (reason `stop`) and are closed.
pub async fn serve(listener: PipeListener, server: ShellServer, shutdown: CancellationToken) {
    let engine = Engine {
        label: "shell",
        verifier: Box::new(ShellVerifier { policy: server.peers }),
        dispatcher: Box::new(ShellDispatcher {
            snapshot_rx: server.snapshot_rx.clone(),
            signals: server.signals,
            extensions: server.extensions,
        }),
        snapshot_events: Some(server.snapshot_rx),
        broadcast: Some(server.broadcast.sender()),
        hello_deadline: HELLO_DEADLINE,
    };
    crate::ipc_conn::serve(listener, engine, shutdown).await;
}

// -- peer verification -------------------------------------------------------

/// Why a client was refused. Only a label reaches the log; the client sees
/// `unauthorized`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PeerRejection {
    /// Check 1: the client's token is not the Staff account.
    WrongUser,
    /// Check 2: not a session in which the Staff account is signed in.
    NotStaffSession,
    /// Check 3: the image is not a Rulebox binary.
    ImageNotAllowed,
    /// The session list could not be read.
    SessionLookupFailed,
}

impl PeerRejection {
    pub fn label(self) -> &'static str {
        match self {
            Self::WrongUser => "wrong_user",
            Self::NotStaffSession => "not_staff_session",
            Self::ImageNotAllowed => "image_not_allowed",
            Self::SessionLookupFailed => "session_lookup_failed",
        }
    }
}

/// The three server checks of Section 6.2 on an already-read `PeerInfo`.
pub fn check_peer(policy: &PeerPolicy, peer: &PeerInfo) -> Result<(), PeerRejection> {
    match policy {
        PeerPolicy::Simulate { current_user } => {
            if &peer.user == current_user {
                Ok(())
            } else {
                Err(PeerRejection::WrongUser)
            }
        }
        PeerPolicy::Production { staff_sid, install, platform } => {
            // 1. The token's user. Race-free; the one that matters.
            if &peer.user != staff_sid {
                return Err(PeerRejection::WrongUser);
            }
            // 2. A session in which the Staff account is signed in (never session 0).
            if peer.session_id == 0 {
                return Err(PeerRejection::NotStaffSession);
            }
            let sessions = platform.sessions().map_err(|_| PeerRejection::SessionLookupFailed)?;
            let in_staff_session = sessions.iter().any(|s| {
                s.id == peer.session_id
                    && s.user_sid.as_deref().is_some_and(|sid| sid.eq_ignore_ascii_case(staff_sid.as_str()))
            });
            if !in_staff_session {
                return Err(PeerRejection::NotStaffSession);
            }
            // 3. Defence in depth: the image must be one of ours.
            match &peer.image_path {
                Some(image) if image_allowed(install, image) => Ok(()),
                _ => Err(PeerRejection::ImageNotAllowed),
            }
        }
    }
}

struct ShellVerifier {
    policy: PeerPolicy,
}

impl PeerVerifier for ShellVerifier {
    fn verify(&self, conn: &Connection) -> Result<VerifiedPeer, &'static str> {
        let peer = conn.verify_peer().map_err(|error| {
            tracing::warn!("pipe client verification failed: {error}");
            "verify_failed"
        })?;
        if let Err(rejection) = check_peer(&self.policy, &peer) {
            tracing::warn!(
                pid = peer.pid,
                session_id = peer.session_id,
                image = ?peer.image_path,
                "pipe client refused: {}",
                rejection.label()
            );
            return Err(rejection.label());
        }
        Ok(VerifiedPeer { pid: peer.pid, session_id: peer.session_id })
    }
}

/// Section 6.2, server check 3: the image is inside `<install>\versions\`, or is
/// exactly `<install>\rulebox-shell.exe`. Comparison is lexical and
/// case-insensitive; a `..` anywhere rejects the path.
pub fn image_allowed(install: &InstallPaths, image: &Path) -> bool {
    let Some(image) = normalize(image) else { return false };
    let Some(root) = normalize(install.root()) else { return false };
    if image.len() <= root.len() || !image.starts_with(&root) {
        return false;
    }
    let rest = &image[root.len()..];
    if rest.len() == 1 {
        return rest[0] == "rulebox-shell.exe";
    }
    // `versions\<something>`: at least one component below `versions`.
    rest[0] == "versions"
}

/// Lower-cased components; `None` when the path contains `..`.
fn normalize(path: &Path) -> Option<Vec<String>> {
    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => {
                // `\\?\C:\` and `C:\` name the same place.
                let text = match prefix.kind() {
                    Prefix::Disk(letter) | Prefix::VerbatimDisk(letter) => {
                        format!("{}:", char::from(letter).to_ascii_lowercase())
                    }
                    _ => prefix.as_os_str().to_string_lossy().to_lowercase(),
                };
                parts.push(text);
            }
            Component::RootDir => parts.push("\\".to_string()),
            Component::CurDir => {}
            Component::ParentDir => return None,
            Component::Normal(name) => parts.push(name.to_string_lossy().to_lowercase()),
        }
    }
    Some(parts)
}

// -- methods -------------------------------------------------------------------

struct ShellDispatcher {
    snapshot_rx: watch::Receiver<AgentSnapshot>,
    signals: mpsc::UnboundedSender<ShellSignal>,
    extensions: Vec<Arc<dyn ShellExtension>>,
}

impl ShellDispatcher {
    fn signal(&self, signal: ShellSignal) {
        // The receiver is gone only while the agent shuts down.
        let _ = self.signals.send(signal);
    }
}

fn empty_result() -> RpcResult {
    Ok(serde_json::json!({}))
}

impl Dispatcher for ShellDispatcher {
    fn capabilities(&self) -> Vec<String> {
        let mut all: Vec<String> = CAPABILITIES.iter().map(|c| (*c).to_string()).collect();
        for extension in &self.extensions {
            all.extend(extension.capabilities().into_iter().map(str::to_string));
        }
        all
    }

    fn connected(&self, peer: &PeerCtx) {
        self.signal(ShellSignal::Connected {
            connection_id: peer.connection_id,
            pid: peer.pid,
            role: peer.role,
        });
    }

    fn closed(&self, peer: &PeerCtx) {
        self.signal(ShellSignal::Closed { connection_id: peer.connection_id });
    }

    fn dispatch(
        &self,
        peer: &PeerCtx,
        method: &str,
        mut params: serde_json::Value,
    ) -> Option<BoxFuture<'static, RpcResult>> {
        match method {
            StateGet::NAME => {
                let snapshot = self.snapshot_rx.borrow().clone();
                let result = serde_json::to_value(&snapshot)
                    .map_err(|_| rpc_error(ErrorCode::Internal, "Internal error.", true));
                Some(std::future::ready(result).boxed())
            }
            ShellReady::NAME => {
                self.signal(ShellSignal::Ready { connection_id: peer.connection_id, pid: peer.pid });
                Some(std::future::ready(empty_result()).boxed())
            }
            ShellHeartbeat::NAME => {
                self.signal(ShellSignal::Heartbeat { connection_id: peer.connection_id, pid: peer.pid });
                Some(std::future::ready(empty_result()).boxed())
            }
            _ => {
                // Offer it to each extension in order; the first `Some` answers.
                // Every extension but the last gets a copy; the last gets the original.
                let count = self.extensions.len();
                for (index, extension) in self.extensions.iter().enumerate() {
                    let offered =
                        if index + 1 == count { std::mem::take(&mut params) } else { params.clone() };
                    if let Some(future) = extension.handle(peer, method, offered) {
                        return Some(future);
                    }
                }
                None
            }
        }
    }
}

// -- the pipe's life in the agent ----------------------------------------------

/// Everything `run_pipe` needs. The listener is (re)created whenever the Staff
/// SID becomes known or changes, and dropped when it becomes unknown (plan
/// Section 5.2); in simulate mode it is created once for the current user.
pub struct ShellPipe {
    /// The full pipe name (the `.sim` name in simulate mode).
    pub name: String,
    pub simulate: bool,
    pub install: InstallPaths,
    pub platform: Arc<dyn Platform>,
    pub snapshot_rx: watch::Receiver<AgentSnapshot>,
    pub signals: mpsc::UnboundedSender<ShellSignal>,
    pub broadcast: ShellBroadcast,
    pub extensions: Vec<Arc<dyn ShellExtension>>,
    /// The Staff account's SID string, `None` before enrollment.
    pub staff_sid_rx: watch::Receiver<Option<String>>,
}

pub async fn run_pipe(pipe: ShellPipe, shutdown: CancellationToken) {
    // A clone, so waiting for a change does not borrow `pipe` mutably while the
    // serving future borrows it.
    let mut staff_sid_rx = pipe.staff_sid_rx.clone();
    if pipe.simulate {
        let me = match current_user_sid() {
            Ok(sid) => sid,
            Err(error) => {
                tracing::error!("cannot read the current user's SID, so no shell pipe: {error}");
                shutdown.cancelled().await;
                return;
            }
        };
        let sddl = sim_pipe_sddl(&me);
        let policy = PeerPolicy::Simulate { current_user: me };
        serve_with_retry(&pipe, &sddl, &policy, &shutdown).await;
        return;
    }

    loop {
        let known = staff_sid_rx.borrow_and_update().clone();
        let staff_sid = match known.as_deref().map(Sid::parse) {
            Some(Ok(sid)) => Some(sid),
            Some(Err(error)) => {
                tracing::error!("the saved Staff SID is not valid, so no shell pipe: {error}");
                None
            }
            None => None,
        };
        let Some(staff_sid) = staff_sid else {
            // Unknown: no pipe. Wait for the SID to appear or change.
            tokio::select! {
                () = shutdown.cancelled() => return,
                changed = staff_sid_rx.changed() => {
                    if changed.is_err() {
                        shutdown.cancelled().await;
                        return;
                    }
                }
            }
            continue;
        };

        let sddl = shell_pipe_sddl(&staff_sid);
        let policy = PeerPolicy::Production {
            staff_sid,
            install: pipe.install.clone(),
            platform: Arc::clone(&pipe.platform),
        };
        let token = shutdown.child_token();
        let serving = serve_with_retry(&pipe, &sddl, &policy, &token);
        tokio::pin!(serving);
        tokio::select! {
            () = &mut serving => {
                // Only returns when the token was cancelled, i.e. on shutdown.
                return;
            }
            changed = staff_sid_rx.changed() => {
                // The SID changed or went away: close this listener and its clients.
                token.cancel();
                serving.await;
                if changed.is_err() {
                    shutdown.cancelled().await;
                    return;
                }
            }
        }
    }
}

/// Creates the listener (retrying every 5 seconds while another process owns the
/// name; it never falls back to another name) and serves it until `token` is
/// cancelled.
async fn serve_with_retry(
    pipe: &ShellPipe,
    sddl: &str,
    policy: &PeerPolicy,
    token: &CancellationToken,
) {
    let Some(listener) = bind_with_retry("shell", &pipe.name, sddl, token).await else {
        return;
    };
    let server = ShellServer {
        snapshot_rx: pipe.snapshot_rx.clone(),
        signals: pipe.signals.clone(),
        broadcast: pipe.broadcast.clone(),
        extensions: pipe.extensions.clone(),
        peers: policy.clone(),
    };
    serve(listener, server, token.clone()).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    use rulebox_ipc::types::{ClientInfo, HelloParams, HelloResult, ProtocolVersion};
    use rulebox_ipc::{Frame, PROTOCOL_MAJOR, PROTOCOL_MINOR};
    use serde_json::json;
    use tokio::sync::Notify;
    use tokio::task::JoinHandle;

    use crate::platform::sim::SimPlatform;
    use crate::testutil::{capture_logs, test_snapshot, unique_pipe_name, RawClient};

    struct TestExtension {
        release: Arc<Notify>,
    }

    impl ShellExtension for TestExtension {
        fn capabilities(&self) -> Vec<&'static str> {
            vec!["x"]
        }

        fn handle(
            &self,
            _peer: &PeerCtx,
            method: &str,
            params: serde_json::Value,
        ) -> Option<BoxFuture<'static, Result<serde_json::Value, RpcError>>> {
            match method {
                "x.echo" => Some(async move { Ok(params) }.boxed()),
                "x.slow" => {
                    let release = Arc::clone(&self.release);
                    Some(
                        async move {
                            release.notified().await;
                            Ok(json!({}))
                        }
                        .boxed(),
                    )
                }
                _ => None,
            }
        }
    }

    struct Rig {
        name: String,
        snapshot_tx: watch::Sender<AgentSnapshot>,
        signals_rx: mpsc::UnboundedReceiver<ShellSignal>,
        broadcast: ShellBroadcast,
        shutdown: CancellationToken,
        task: JoinHandle<()>,
    }

    impl Rig {
        fn start(extensions: Vec<Arc<dyn ShellExtension>>) -> Self {
            Self::start_with(extensions, |me| PeerPolicy::Simulate { current_user: me })
        }

        fn start_with(
            extensions: Vec<Arc<dyn ShellExtension>>,
            policy: impl FnOnce(Sid) -> PeerPolicy,
        ) -> Self {
            let me = current_user_sid().unwrap();
            let name = unique_pipe_name();
            let listener = PipeListener::bind(&name, &sim_pipe_sddl(&me)).unwrap();
            let (snapshot_tx, snapshot_rx) = watch::channel(test_snapshot());
            let (signals, signals_rx) = mpsc::unbounded_channel();
            let broadcast = ShellBroadcast::new();
            let shutdown = CancellationToken::new();
            let server = ShellServer {
                snapshot_rx,
                signals,
                broadcast: broadcast.clone(),
                extensions,
                peers: policy(me),
            };
            let task = tokio::spawn(serve(listener, server, shutdown.clone()));
            Self { name, snapshot_tx, signals_rx, broadcast, shutdown, task }
        }

        async fn stop(self) {
            self.shutdown.cancel();
            self.task.await.unwrap();
        }
    }

    fn hello_params(major: u16) -> serde_json::Value {
        serde_json::to_value(HelloParams {
            protocol: ProtocolVersion { major, minor: 0 },
            client: ClientInfo { role: ClientRole::Shell, name: "test".into(), version: "0.0.0".into() },
        })
        .unwrap()
    }

    async fn hello(client: &mut RawClient) -> HelloResult {
        match client.request(0, "hello", hello_params(1)).await {
            Frame::Response { ok: true, result: Some(result), .. } => serde_json::from_value(result).unwrap(),
            other => panic!("hello failed: {other:?}"),
        }
    }

    fn error_of(frame: &Frame) -> &RpcError {
        match frame {
            Frame::Response { ok: false, error: Some(error), .. } => error,
            other => panic!("expected an error response, got {other:?}"),
        }
    }

    /// Reads events until the stream is quiet for 300 ms; returns the
    /// `desiredStateVersion` of every `state.changed` seen.
    async fn drain_versions(client: &mut RawClient) -> Vec<u64> {
        let mut versions = Vec::new();
        while let Some(frame) = client.recv_within(std::time::Duration::from_millis(300)).await {
            if let Frame::Event { event, data } = frame {
                if event == "state.changed" {
                    versions.push(data["desiredStateVersion"].as_u64().unwrap());
                }
            }
        }
        versions
    }

    #[tokio::test]
    async fn state_get_before_hello_is_hello_required_and_closes() {
        let rig = Rig::start(Vec::new());
        let mut client = RawClient::connect(&rig.name).await;
        client.send(Frame::Request { id: 1, method: "state.get".into(), params: json!({}) }).await;
        let answer = client.recv().await.expect("an answer");
        assert_eq!(error_of(&answer).code, ErrorCode::HelloRequired);
        assert!(client.recv().await.is_none(), "the connection must be closed");
        rig.stop().await;
    }

    #[tokio::test]
    async fn hello_with_major_2_is_unsupported_and_lists_the_supported_version() {
        let rig = Rig::start(Vec::new());
        let mut client = RawClient::connect(&rig.name).await;
        let answer = client.request(0, "hello", hello_params(2)).await;
        let error = error_of(&answer);
        assert_eq!(error.code, ErrorCode::UnsupportedProtocol);
        assert_eq!(
            error.data.as_ref().unwrap()["supported"],
            json!({ "major": PROTOCOL_MAJOR, "minor": PROTOCOL_MINOR })
        );
        assert!(client.recv().await.is_none());
        rig.stop().await;
    }

    #[tokio::test]
    async fn hello_answers_protocol_1_1_with_the_always_present_capabilities() {
        let rig = Rig::start(Vec::new());
        let mut client = RawClient::connect(&rig.name).await;
        let hello = hello(&mut client).await;
        assert_eq!(hello.protocol, ProtocolVersion { major: 1, minor: 1 });
        assert_eq!(hello.capabilities, ["state", "health"]);
        assert_eq!(hello.agent_version, env!("CARGO_PKG_VERSION"));
        rig.stop().await;
    }

    /// The clock is paused after the client has connected: the pipe I/O itself is
    /// real, so pausing from the start would let the runtime skip ahead of it.
    #[tokio::test]
    async fn a_client_that_sends_nothing_is_dropped_after_five_seconds() {
        let rig = Rig::start(Vec::new());
        let mut client = RawClient::connect(&rig.name).await;
        // Let the server accept and start waiting for the hello.
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        tokio::time::pause();
        tokio::time::advance(HELLO_DEADLINE - std::time::Duration::from_millis(100)).await;
        tokio::task::yield_now().await;
        // Not yet: the connection is still open, so a read is still pending.
        assert!(client.recv_raw().now_or_never().is_none(), "closed before the deadline");
        tokio::time::advance(std::time::Duration::from_millis(200)).await;
        assert!(client.recv_raw().await.is_none(), "the server must close the connection");
        rig.shutdown.cancel();
        rig.task.await.unwrap();
    }

    #[tokio::test]
    async fn one_state_changed_per_client_per_change() {
        let rig = Rig::start(Vec::new());
        let mut first = RawClient::connect(&rig.name).await;
        let mut second = RawClient::connect(&rig.name).await;
        hello(&mut first).await;
        hello(&mut second).await;

        rig.snapshot_tx.send_modify(|s| s.desired_state_version = 5);
        assert_eq!(drain_versions(&mut first).await, [5]);
        assert_eq!(drain_versions(&mut second).await, [5]);
        rig.stop().await;
    }

    #[tokio::test]
    async fn a_client_that_does_not_read_ends_with_the_newest_snapshot() {
        let rig = Rig::start(Vec::new());
        let mut client = RawClient::connect(&rig.name).await;
        hello(&mut client).await;

        for version in 1..=50u64 {
            rig.snapshot_tx.send_modify(|s| s.desired_state_version = version);
            tokio::task::yield_now().await;
        }
        let versions = drain_versions(&mut client).await;
        assert!(!versions.is_empty());
        assert!(versions.len() <= crate::ipc_conn::OUTBOUND_QUEUE, "{} events", versions.len());
        assert_eq!(versions.last(), Some(&50));
        assert!(versions.windows(2).all(|w| w[0] < w[1]), "versions must increase: {versions:?}");
        rig.stop().await;
    }

    #[tokio::test]
    async fn the_seventeenth_in_flight_request_is_busy() {
        let release = Arc::new(Notify::new());
        let rig = Rig::start(vec![Arc::new(TestExtension { release: Arc::clone(&release) })]);
        let mut client = RawClient::connect(&rig.name).await;
        hello(&mut client).await;

        for id in 1..=17u32 {
            client.send(Frame::Request { id, method: "x.slow".into(), params: json!({}) }).await;
        }
        // The only answer that can arrive now is the 17th request's.
        let answer = client.recv().await.expect("an answer");
        match &answer {
            Frame::Response { id: 17, .. } => {}
            other => panic!("expected the answer to request 17, got {other:?}"),
        }
        let error = error_of(&answer);
        assert_eq!(error.code, ErrorCode::Busy);
        assert!(error.retryable);

        // Releasing the 16 slow requests answers them all.
        release.notify_waiters();
        let mut answered = 0;
        while answered < 16 {
            match client.recv().await.expect("an answer") {
                Frame::Response { ok: true, .. } => answered += 1,
                other => panic!("unexpected {other:?}"),
            }
        }
        rig.stop().await;
    }

    #[tokio::test]
    async fn shutting_down_is_sent_when_the_shutdown_token_is_cancelled() {
        let rig = Rig::start(Vec::new());
        let mut client = RawClient::connect(&rig.name).await;
        hello(&mut client).await;

        rig.shutdown.cancel();
        match client.recv().await.expect("an event") {
            Frame::Event { event, data } => {
                assert_eq!(event, "agent.shuttingDown");
                assert_eq!(data, json!({ "reason": "stop", "graceMs": 0 }));
            }
            other => panic!("unexpected {other:?}"),
        }
        assert!(client.recv().await.is_none());
        rig.task.await.unwrap();
    }

    #[tokio::test]
    async fn a_broadcast_reaches_every_client() {
        let rig = Rig::start(Vec::new());
        let mut first = RawClient::connect(&rig.name).await;
        let mut second = RawClient::connect(&rig.name).await;
        hello(&mut first).await;
        hello(&mut second).await;

        rig.broadcast.shutting_down(ShutdownReason::KioskDisabled, 5000);
        for client in [&mut first, &mut second] {
            match client.recv().await.expect("an event") {
                Frame::Event { event, data } => {
                    assert_eq!(event, "agent.shuttingDown");
                    assert_eq!(data, json!({ "reason": "kioskDisabled", "graceMs": 5000 }));
                }
                other => panic!("unexpected {other:?}"),
            }
        }
        rig.stop().await;
    }

    #[tokio::test]
    async fn an_extension_adds_a_capability_and_methods() {
        let rig = Rig::start(vec![Arc::new(TestExtension { release: Arc::new(Notify::new()) })]);
        let mut client = RawClient::connect(&rig.name).await;
        assert_eq!(hello(&mut client).await.capabilities, ["state", "health", "x"]);

        let echoed = client.request(1, "x.echo", json!({ "a": 1, "b": [true] })).await;
        assert_eq!(
            echoed,
            Frame::Response { id: 1, ok: true, result: Some(json!({ "a": 1, "b": [true] })), error: None }
        );
        let unknown = client.request(2, "x.other", json!({})).await;
        assert_eq!(error_of(&unknown).code, ErrorCode::UnknownMethod);
        let unknown = client.request(3, "session.signIn", json!({})).await;
        assert_eq!(error_of(&unknown).code, ErrorCode::UnknownMethod);
        rig.stop().await;
    }

    #[tokio::test]
    async fn state_get_ready_and_heartbeat_work_and_send_signals() {
        let mut rig = Rig::start(Vec::new());
        let mut client = RawClient::connect(&rig.name).await;
        hello(&mut client).await;

        let state = client.request(1, "state.get", json!({})).await;
        match state {
            Frame::Response { ok: true, result: Some(result), .. } => {
                assert_eq!(result["enrollment"], "notEnrolled");
                assert!(result.get("displayMode").is_some());
            }
            other => panic!("unexpected {other:?}"),
        }
        client.request(2, "shell.ready", json!({})).await;
        client.request(3, "shell.heartbeat", json!({})).await;

        let mut seen = Vec::new();
        for _ in 0..3 {
            let signal = tokio::time::timeout(std::time::Duration::from_secs(5), rig.signals_rx.recv())
                .await
                .unwrap()
                .unwrap();
            seen.push(signal);
        }
        match (&seen[0], &seen[1], &seen[2]) {
            (
                ShellSignal::Connected { connection_id: a, pid, role: ClientRole::Shell },
                ShellSignal::Ready { connection_id: b, pid: pid_b },
                ShellSignal::Heartbeat { connection_id: c, pid: pid_c },
            ) => {
                assert!(a == b && b == c);
                assert_eq!(*pid, std::process::id());
                assert_eq!((*pid_b, *pid_c), (std::process::id(), std::process::id()));
            }
            other => panic!("unexpected signals {other:?}"),
        }

        drop(client);
        let closed = tokio::time::timeout(std::time::Duration::from_secs(5), rig.signals_rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(closed, ShellSignal::Closed { .. }));
        rig.stop().await;
    }

    #[tokio::test]
    async fn a_peer_that_is_not_the_expected_user_is_unauthorized() {
        let rig = Rig::start_with(Vec::new(), |_| PeerPolicy::Simulate { current_user: Sid::system() });
        let mut client = RawClient::connect(&rig.name).await;
        let answer = client.request(0, "hello", hello_params(1)).await;
        assert_eq!(error_of(&answer).code, ErrorCode::Unauthorized);
        assert!(client.recv().await.is_none());
        rig.stop().await;
    }

    #[tokio::test]
    async fn params_and_secrets_never_reach_the_log() {
        // A global capture at trace level: it sees every test's log lines, so the
        // secret below is a string no other test writes.
        let capture = capture_logs();
        let rig = Rig::start(vec![Arc::new(TestExtension { release: Arc::new(Notify::new()) })]);
        let mut client = RawClient::connect(&rig.name).await;
        hello(&mut client).await;

        let secret = json!({ "password": "hunter2-do-not-log", "pin": "hunter2-do-not-log" });
        client.request(1, "x.echo", secret.clone()).await;
        client.request(2, "x.unknown", secret.clone()).await;
        client.request(3, "state.get", secret).await;
        // A frame that is not valid: serde's error text quotes the offending value.
        client
            .send_raw_payload(br#"{"t":"req","id":"hunter2-do-not-log","method":"x.echo"}"#)
            .await;
        assert!(client.recv().await.is_none(), "an invalid frame closes the connection");
        rig.stop().await;

        let logged = capture.text();
        assert!(logged.contains("x.echo"), "the log must have been captured: {logged}");
        assert!(!logged.contains("hunter2-do-not-log"), "a secret reached the log:\n{logged}");
    }

    // -- image_allowed and check_peer ----------------------------------------------

    fn install() -> InstallPaths {
        InstallPaths::new(PathBuf::from(r"C:\Program Files\Rulebox"))
    }

    #[test]
    fn image_allowed_accepts_versions_and_the_launcher_only() {
        let install = install();
        let yes = [
            r"C:\Program Files\Rulebox\versions\1.0\rulebox-staff.exe",
            r"C:\Program Files\Rulebox\rulebox-shell.exe",
            r"c:\program files\rulebox\RULEBOX-SHELL.EXE",
            r"C:\PROGRAM FILES\RULEBOX\VERSIONS\0.0.0-dev\rulebox-staff.exe",
            r"\\?\C:\Program Files\Rulebox\rulebox-shell.exe",
        ];
        for path in yes {
            assert!(image_allowed(&install, Path::new(path)), "{path} should be allowed");
        }
        let no = [
            r"C:\Program Files\Rulebox\other.exe",
            r"C:\Program Files\Rulebox\rulebox-agent.exe",
            r"C:\Program Files\Rulebox\versions\..\x.exe",
            r"C:\Program Files\Rulebox\versions",
            r"C:\Program Files\Rulebox\versions\",
            r"C:\Temp\rulebox-shell.exe",
            r"C:\Program Files\Rulebox\sub\rulebox-shell.exe",
            r"C:\Program Files\RuleboxEvil\rulebox-shell.exe",
            r"C:\Program Files\Rulebox",
            r"D:\Program Files\Rulebox\rulebox-shell.exe",
        ];
        for path in no {
            assert!(!image_allowed(&install, Path::new(path)), "{path} should be refused");
        }
    }

    fn peer(user: &Sid, session_id: u32, image: Option<&str>) -> PeerInfo {
        PeerInfo { pid: 4242, session_id, user: user.clone(), image_path: image.map(PathBuf::from) }
    }

    #[test]
    fn production_policy_applies_all_three_checks() {
        let dir = crate::testutil::TempDir::new();
        let sim = Arc::new(SimPlatform::new(dir.path().to_path_buf()));
        let staff = Sid::parse("S-1-5-21-1-2-3-1001").unwrap();
        let other = Sid::parse("S-1-5-21-1-2-3-1002").unwrap();
        sim.add_session(3, Some(staff.as_str()), true);
        sim.add_session(4, Some(other.as_str()), true);
        let policy = PeerPolicy::Production {
            staff_sid: staff.clone(),
            install: install(),
            platform: sim,
        };
        let staff_app = r"C:\Program Files\Rulebox\versions\1.0\rulebox-staff.exe";

        assert_eq!(check_peer(&policy, &peer(&staff, 3, Some(staff_app))), Ok(()));
        // Check 1: another user.
        assert_eq!(
            check_peer(&policy, &peer(&other, 3, Some(staff_app))),
            Err(PeerRejection::WrongUser)
        );
        // Check 2: session 0, an unknown session, a session of another user.
        for session in [0, 9, 4] {
            assert_eq!(
                check_peer(&policy, &peer(&staff, session, Some(staff_app))),
                Err(PeerRejection::NotStaffSession),
                "session {session}"
            );
        }
        // Check 3: not one of our images, or unknown.
        assert_eq!(
            check_peer(&policy, &peer(&staff, 3, Some(r"C:\Windows\notepad.exe"))),
            Err(PeerRejection::ImageNotAllowed)
        );
        assert_eq!(check_peer(&policy, &peer(&staff, 3, None)), Err(PeerRejection::ImageNotAllowed));
    }

    #[test]
    fn simulate_policy_checks_only_the_user() {
        let me = Sid::parse("S-1-5-21-1-2-3-1001").unwrap();
        let other = Sid::parse("S-1-5-21-1-2-3-1002").unwrap();
        let policy = PeerPolicy::Simulate { current_user: me.clone() };
        assert_eq!(check_peer(&policy, &peer(&me, 0, None)), Ok(()));
        assert_eq!(check_peer(&policy, &peer(&other, 3, None)), Err(PeerRejection::WrongUser));
    }
}
