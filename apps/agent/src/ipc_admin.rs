//! The admin pipe server and the CLI side of it (plan Step 6, Sections 5.4 and
//! 6.7). `rulebox-agent status|enroll|unenroll` connect here; the pipe's DACL
//! lets only SYSTEM and Administrators in, and the server checks elevation again.
//!
//! The CLI helpers touch neither the data directory nor the log files
//! (plan Section 5.1).

use std::io::Write;
use std::sync::Arc;
use std::time::Duration;

use futures_util::future::BoxFuture;
use futures_util::FutureExt;
use rulebox_ipc::admin::{
    reasons, AdminEnroll, AdminEnrollParams, AdminEnrollResult, AdminStatus, AdminStatusExtra,
    AdminStatusResult, AdminUnenroll, AdminUnenrollParams, OperationFailure,
};
use rulebox_ipc::client::{call_once, CallError, ClientConfig};
use rulebox_ipc::methods::{Empty, Method};
use rulebox_ipc::server::Connection;
use rulebox_ipc::types::{AgentSnapshot, ClientInfo, ClientRole};
use rulebox_ipc::{ErrorCode, RpcError, HELLO_DEADLINE};
use rulebox_win32::pipe::{admin_pipe_sddl, sim_pipe_sddl};
use rulebox_win32::sid::{current_user_sid, Sid};
use tokio::sync::{watch, Mutex};
use tokio_util::sync::CancellationToken;

use crate::admin_exit::AdminExit;
use crate::audit::AuditHandle;
use crate::ipc_conn::{
    bind_with_retry, rpc_error, serve as serve_connections, Dispatcher, Engine, PeerCtx,
    PeerVerifier, RpcResult, VerifiedPeer,
};
use crate::session::SessionManager;

/// `enroll` waits this long: the reconciler may take up to 120 seconds after the
/// backend call (plan Section 5.4, step 7).
pub const ENROLL_TIMEOUT: Duration = Duration::from_secs(150);
/// Every other admin command.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(10);

/// Exit code of any error not listed below.
pub const EXIT_ERROR: u8 = 1;
/// "The Rulebox Agent service is not running."
pub const EXIT_NOT_RUNNING: u8 = 2;
/// An `operation_failed` answer (plan Section 6.7).
pub const EXIT_OPERATION_FAILED: u8 = 3;

// -- the server ------------------------------------------------------------------

/// What `admin.enroll` and `admin.unenroll` do. Step 8 and Step 11 provide the
/// real one (it sends the work to the reconciler); until then [`NotAvailableYet`].
pub trait AdminHandler: Send + Sync + 'static {
    fn enroll(&self, params: AdminEnrollParams) -> BoxFuture<'static, Result<AdminEnrollResult, RpcError>>;
    fn unenroll(&self, params: AdminUnenrollParams) -> BoxFuture<'static, Result<(), RpcError>>;
    /// Counters and states for `status` beyond the snapshot (Steps 6a and 6b).
    fn status_extra(&self) -> Option<AdminStatusExtra> {
        None
    }
}

/// An `operation_failed` error with `data = { reason, details }` (plan Section 6.7).
pub fn operation_failed(
    reason: &str,
    message: &str,
    retryable: bool,
    details: Option<serde_json::Value>,
) -> RpcError {
    let failure = OperationFailure { reason: reason.to_string(), details };
    RpcError {
        code: ErrorCode::OperationFailed,
        message: message.to_string(),
        retryable,
        data: serde_json::to_value(failure).ok(),
    }
}

/// Answers `operation_failed` / `not_available_yet` for both operations.
pub struct NotAvailableYet;

impl NotAvailableYet {
    fn failure(what: &str) -> RpcError {
        operation_failed(
            reasons::NOT_AVAILABLE_YET,
            &format!("{what} is not available in this build yet."),
            false,
            None,
        )
    }
}

impl AdminHandler for NotAvailableYet {
    fn enroll(&self, _params: AdminEnrollParams) -> BoxFuture<'static, Result<AdminEnrollResult, RpcError>> {
        std::future::ready(Err(Self::failure("Enrollment"))).boxed()
    }

    fn unenroll(&self, _params: AdminUnenrollParams) -> BoxFuture<'static, Result<(), RpcError>> {
        std::future::ready(Err(Self::failure("Unenrollment"))).boxed()
    }
}

/// Wraps the enroll/unenroll handler and adds what `status` shows beyond the
/// snapshot: the signed-in employee's name and the audit queue length (Step 6a), and
/// the admin-exit counters and problem (Step 6b). Never the PIN hash.
pub struct WithStatusExtra {
    inner: Arc<dyn AdminHandler>,
    session: Arc<SessionManager>,
    audit: Arc<AuditHandle>,
    admin_exit: Arc<AdminExit>,
}

impl WithStatusExtra {
    pub fn new(
        inner: Arc<dyn AdminHandler>,
        session: Arc<SessionManager>,
        audit: Arc<AuditHandle>,
        admin_exit: Arc<AdminExit>,
    ) -> Self {
        Self { inner, session, audit, admin_exit }
    }
}

impl AdminHandler for WithStatusExtra {
    fn enroll(&self, params: AdminEnrollParams) -> BoxFuture<'static, Result<AdminEnrollResult, RpcError>> {
        self.inner.enroll(params)
    }

    fn unenroll(&self, params: AdminUnenrollParams) -> BoxFuture<'static, Result<(), RpcError>> {
        self.inner.unenroll(params)
    }

    fn status_extra(&self) -> Option<AdminStatusExtra> {
        let exit = self.admin_exit.status();
        Some(AdminStatusExtra {
            employee: self.session.current_display_name(),
            admin_exit_failures: exit.failures,
            admin_exit_locked_for_ms: exit.locked_for_ms,
            admin_exit_problem: exit.problem,
            audit_queued: u32::try_from(self.audit.queued()).unwrap_or(u32::MAX),
        })
    }
}

/// Who may talk on the admin pipe.
#[derive(Clone)]
pub enum AdminPolicy {
    /// The token behind the connection must be an elevated administrator (the
    /// pipe's DACL already excludes everyone else; this is the second check).
    Production,
    /// Development only: the pipe belongs to the current user.
    Simulate { current_user: Sid },
}

pub struct AdminServer {
    pub snapshot_rx: watch::Receiver<AgentSnapshot>,
    pub handler: Arc<dyn AdminHandler>,
    pub policy: AdminPolicy,
}

/// Serves `listener` until `shutdown`.
pub async fn serve(listener: rulebox_ipc::server::PipeListener, server: AdminServer, shutdown: CancellationToken) {
    let engine = Engine {
        label: "admin",
        verifier: Box::new(AdminVerifier { policy: server.policy }),
        dispatcher: Box::new(AdminDispatcher {
            snapshot_rx: server.snapshot_rx,
            handler: server.handler,
            // Enrolling and unenrolling never overlap, across connections.
            operation: Arc::new(Mutex::new(())),
        }),
        snapshot_events: None,
        broadcast: None,
        hello_deadline: HELLO_DEADLINE,
    };
    serve_connections(listener, engine, shutdown).await;
}

struct AdminVerifier {
    policy: AdminPolicy,
}

impl PeerVerifier for AdminVerifier {
    fn verify(&self, conn: &Connection) -> Result<VerifiedPeer, &'static str> {
        let peer = conn.verify_peer().map_err(|error| {
            tracing::warn!("admin pipe client verification failed: {error}");
            "verify_failed"
        })?;
        match &self.policy {
            AdminPolicy::Simulate { current_user } => {
                if &peer.user != current_user {
                    return Err("wrong_user");
                }
            }
            AdminPolicy::Production => match conn.peer_is_elevated_admin() {
                Ok(true) => {}
                Ok(false) => return Err("not_elevated_admin"),
                Err(error) => {
                    tracing::warn!("admin pipe elevation check failed: {error}");
                    return Err("verify_failed");
                }
            },
        }
        Ok(VerifiedPeer { pid: peer.pid, session_id: peer.session_id })
    }
}

struct AdminDispatcher {
    snapshot_rx: watch::Receiver<AgentSnapshot>,
    handler: Arc<dyn AdminHandler>,
    operation: Arc<Mutex<()>>,
}

fn internal() -> RpcError {
    rpc_error(ErrorCode::Internal, "Internal error.", true)
}

/// Parameters that do not parse are `invalid_params`. The serde error text is not
/// passed on: it can quote the value (an enrollment code, for one).
fn parse_params<T: serde::de::DeserializeOwned>(params: serde_json::Value) -> Result<T, RpcError> {
    serde_json::from_value(params)
        .map_err(|_| rpc_error(ErrorCode::InvalidParams, "The parameters are not valid.", false))
}

impl Dispatcher for AdminDispatcher {
    fn capabilities(&self) -> Vec<String> {
        Vec::new()
    }

    fn dispatch(
        &self,
        _peer: &PeerCtx,
        method: &str,
        params: serde_json::Value,
    ) -> Option<BoxFuture<'static, RpcResult>> {
        match method {
            AdminStatus::NAME => {
                let result = AdminStatusResult {
                    snapshot: self.snapshot_rx.borrow().clone(),
                    extra: self.handler.status_extra(),
                };
                let value = serde_json::to_value(result).map_err(|_| internal());
                Some(std::future::ready(value).boxed())
            }
            AdminEnroll::NAME => {
                let params = match parse_params::<AdminEnrollParams>(params) {
                    Ok(params) => params,
                    Err(error) => return Some(std::future::ready(Err(error)).boxed()),
                };
                let Some(guard) = self.try_begin() else {
                    return Some(std::future::ready(Err(busy())).boxed());
                };
                let work = self.handler.enroll(params);
                Some(
                    async move {
                        let _guard = guard;
                        let result = work.await?;
                        serde_json::to_value(result).map_err(|_| internal())
                    }
                    .boxed(),
                )
            }
            AdminUnenroll::NAME => {
                let params = match parse_params::<AdminUnenrollParams>(params) {
                    Ok(params) => params,
                    Err(error) => return Some(std::future::ready(Err(error)).boxed()),
                };
                let Some(guard) = self.try_begin() else {
                    return Some(std::future::ready(Err(busy())).boxed());
                };
                let work = self.handler.unenroll(params);
                Some(
                    async move {
                        let _guard = guard;
                        work.await?;
                        serde_json::to_value(Empty {}).map_err(|_| internal())
                    }
                    .boxed(),
                )
            }
            _ => None,
        }
    }
}

impl AdminDispatcher {
    /// Takes the one-operation-at-a-time lock, or `None` when it is held.
    fn try_begin(&self) -> Option<tokio::sync::OwnedMutexGuard<()>> {
        Arc::clone(&self.operation).try_lock_owned().ok()
    }
}

fn busy() -> RpcError {
    rpc_error(ErrorCode::Busy, "Another enroll or unenroll is already running.", true)
}

/// What `run_pipe` needs.
pub struct AdminPipe {
    /// The full pipe name (the `.sim` name in simulate mode).
    pub name: String,
    pub simulate: bool,
    pub snapshot_rx: watch::Receiver<AgentSnapshot>,
    pub handler: Arc<dyn AdminHandler>,
}

/// The admin pipe exists for as long as the agent runs.
pub async fn run_pipe(pipe: AdminPipe, shutdown: CancellationToken) {
    let (sddl, policy) = if pipe.simulate {
        match current_user_sid() {
            Ok(me) => (sim_pipe_sddl(&me), AdminPolicy::Simulate { current_user: me }),
            Err(error) => {
                tracing::error!("cannot read the current user's SID, so no admin pipe: {error}");
                shutdown.cancelled().await;
                return;
            }
        }
    } else {
        (admin_pipe_sddl(), AdminPolicy::Production)
    };
    let Some(listener) = bind_with_retry("admin", &pipe.name, &sddl, &shutdown).await else {
        return;
    };
    let server = AdminServer { snapshot_rx: pipe.snapshot_rx, handler: pipe.handler, policy };
    serve(listener, server, shutdown).await;
}

// -- the CLI side ------------------------------------------------------------------

fn cli_info() -> ClientInfo {
    ClientInfo {
        role: ClientRole::Admin,
        name: "rulebox-agent-cli".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
    }
}

/// One admin call. `Err` holds the process exit code; the reason has been
/// written to `err`. Blocks the calling thread: never call it inside a runtime.
pub fn call<M: Method>(
    config: ClientConfig,
    params: M::Params,
    err: &mut dyn Write,
) -> Result<M::Result, u8> {
    call_once::<M>(config, cli_info(), params).map_err(|error| report_error(&error, err))
}

/// Writes the user-facing text for a failed call and returns the exit code.
pub fn report_error(error: &CallError, err: &mut dyn Write) -> u8 {
    // A failed write to stderr is not worth a second error.
    match error {
        CallError::NotLinked => {
            let _ = writeln!(err, "The Rulebox Agent service is not running.");
            EXIT_NOT_RUNNING
        }
        CallError::ServerNotTrusted => {
            let _ = writeln!(
                err,
                "error: the agent pipe is not served by the Rulebox Agent service; refusing to talk to it."
            );
            EXIT_ERROR
        }
        CallError::Timeout => {
            let _ = writeln!(err, "error: the agent did not answer in time.");
            EXIT_ERROR
        }
        CallError::Protocol(message) => {
            let _ = writeln!(err, "error: protocol error: {message}");
            EXIT_ERROR
        }
        CallError::Rpc(rpc) if rpc.code == ErrorCode::OperationFailed => {
            let failure: Option<OperationFailure> =
                rpc.data.clone().and_then(|data| serde_json::from_value(data).ok());
            let reason = failure.as_ref().map_or("unknown", |f| f.reason.as_str());
            let _ = writeln!(err, "error: {reason}: {}", rpc.message);
            if reason == reasons::COMPAT_BLOCKED {
                let blockers = failure
                    .as_ref()
                    .and_then(|f| f.details.as_ref())
                    .and_then(|details| details.get("blockers"))
                    .and_then(serde_json::Value::as_array);
                for blocker in blockers.into_iter().flatten().filter_map(serde_json::Value::as_str) {
                    let _ = writeln!(err, "  - {blocker}");
                }
            }
            if rpc.retryable {
                let _ = writeln!(err, "Try again.");
            }
            EXIT_OPERATION_FAILED
        }
        CallError::Rpc(rpc) => {
            let _ = writeln!(err, "error: {}: {}", wire(&rpc.code), rpc.message);
            EXIT_ERROR
        }
    }
}

/// The wire (camelCase or snake_case) text of a serializable enum value.
fn wire<T: serde::Serialize>(value: &T) -> String {
    match serde_json::to_value(value) {
        Ok(serde_json::Value::String(text)) => text,
        _ => "unknown".to_string(),
    }
}

/// `rulebox-agent status [--json]`. Returns the exit code.
pub fn run_status(
    config: ClientConfig,
    json: bool,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> u8 {
    let result = match call::<AdminStatus>(config, Empty {}, err) {
        Ok(result) => result,
        Err(code) => return code,
    };
    let text = if json {
        match serde_json::to_string_pretty(&result) {
            Ok(text) => text,
            Err(error) => {
                let _ = writeln!(err, "error: cannot print the status: {error}");
                return EXIT_ERROR;
            }
        }
    } else {
        format_status(&result)
    };
    let _ = writeln!(out, "{text}");
    0
}

/// `rulebox-agent enroll <code> ...`. Returns the exit code.
pub fn run_enroll(
    config: ClientConfig,
    params: AdminEnrollParams,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> u8 {
    match call::<AdminEnroll>(config, params, err) {
        Ok(result) => {
            let _ = writeln!(out, "Enrolled as \"{}\" ({}).", result.device_name, result.device_id);
            if let Some(code) = &result.kiosk.error_code {
                let _ = writeln!(
                    out,
                    "Kiosk setup did not finish ({code}). The agent keeps the enrollment and retries."
                );
            }
            0
        }
        Err(code) => code,
    }
}

/// `rulebox-agent unenroll ...`. Returns the exit code.
pub fn run_unenroll(
    config: ClientConfig,
    params: AdminUnenrollParams,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> u8 {
    match call::<AdminUnenroll>(config, params, err) {
        Ok(Empty {}) => {
            let _ = writeln!(out, "This PC is no longer enrolled.");
            0
        }
        Err(code) => code,
    }
}

/// The text form of `status`: one line per fact, values in their wire spelling.
pub fn format_status(result: &AdminStatusResult) -> String {
    let s = &result.snapshot;
    let device = s
        .device
        .as_ref()
        .map_or_else(|| "-".to_string(), |d| format!("{} ({})", d.name, d.id));
    let policy = match &s.desired_state {
        Some(_) => format!("version {}", s.desired_state_version),
        None => format!("none received (applied version {})", s.desired_state_version),
    };
    let clock = match s.server_time_offset_ms {
        Some(offset) => format!(
            "{}, server offset {offset} ms",
            if s.clock_suspect { "suspect" } else { "ok" }
        ),
        None => (if s.clock_suspect { "suspect" } else { "ok" }).to_string(),
    };
    let mut lines = vec![
        ("agent version", s.agent_version.clone()),
        ("enrollment", wire(&s.enrollment)),
        ("device", device),
        ("backend", s.convex_url.clone().unwrap_or_else(|| "-".to_string())),
        ("connection", wire(&s.connection)),
        (
            "kiosk",
            format!(
                "enabled={} phase={} error={}",
                s.kiosk.enabled,
                wire(&s.kiosk.phase),
                s.kiosk.error_code.as_deref().unwrap_or("-")
            ),
        ),
        ("shell", wire(&s.shell.health)),
        ("display mode", wire(&s.display_mode)),
        ("policy", policy),
        ("clock", clock),
    ];
    // (1.1) The hidden exit: on or off, with its key combination, or off with the
    // reason the settings were not usable. Never the PIN or its hash.
    if let Some(exit) = &s.admin_exit {
        let problem = result.extra.as_ref().and_then(|extra| extra.admin_exit_problem.as_deref());
        let text = match (exit.enabled, problem) {
            (true, None) => format!("on ({})", exit.hotkey),
            (true, Some(problem)) => format!("on ({}; {problem})", exit.hotkey),
            (false, None) => "off".to_string(),
            (false, Some(problem)) => format!("off ({problem})"),
        };
        lines.push(("admin exit", text));
    }
    // (1.1) Only an agent that sends `extra` shows these lines.
    if let Some(extra) = &result.extra {
        if extra.admin_exit_failures > 0 {
            lines.push(("exit failures", extra.admin_exit_failures.to_string()));
        }
        if let Some(left_ms) = extra.admin_exit_locked_for_ms {
            lines.push(("exit locked", format!("{} s left", left_ms.div_ceil(1000))));
        }
        lines.push(("employee", extra.employee.clone().unwrap_or_else(|| "-".to_string())));
        lines.push(("audit queued", extra.audit_queued.to_string()));
    }
    lines
        .iter()
        .map(|(name, value)| format!("{name:<14}: {value}"))
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    use rulebox_ipc::server::PipeListener;
    use rulebox_ipc::types::{HelloParams, ProtocolVersion};
    use rulebox_ipc::Frame;
    use serde_json::json;
    use tokio::sync::Notify;

    use crate::testutil::{test_snapshot, unique_pipe_name, RawClient};

    struct Rig {
        name: String,
        shutdown: CancellationToken,
        task: tokio::task::JoinHandle<()>,
    }

    impl Rig {
        fn start(handler: Arc<dyn AdminHandler>) -> Self {
            let me = current_user_sid().unwrap();
            let name = unique_pipe_name();
            let listener = PipeListener::bind(&name, &sim_pipe_sddl(&me)).unwrap();
            let (_tx, snapshot_rx) = watch::channel(test_snapshot());
            let server = AdminServer {
                snapshot_rx,
                handler,
                policy: AdminPolicy::Simulate { current_user: me },
            };
            let shutdown = CancellationToken::new();
            let task = tokio::spawn(serve(listener, server, shutdown.clone()));
            Self { name, shutdown, task }
        }

        fn client_config(&self) -> ClientConfig {
            ClientConfig {
                pipe_name: self.name.clone(),
                trusted_owner: current_user_sid().unwrap(),
                request_timeout: Duration::from_secs(5),
                // The test server is not a service in session 0.
                require_session_zero: false,
            }
        }

        async fn stop(self) {
            self.shutdown.cancel();
            self.task.await.unwrap();
        }
    }

    fn enroll_params() -> AdminEnrollParams {
        AdminEnrollParams { code: "RBX1.x".into(), device_name: None, allow_joined: false }
    }

    async fn hello(client: &mut RawClient) {
        let params = serde_json::to_value(HelloParams {
            protocol: ProtocolVersion { major: 1, minor: 1 },
            client: cli_info(),
        })
        .unwrap();
        let answer = client.request(0, "hello", params).await;
        assert!(matches!(answer, Frame::Response { ok: true, .. }), "{answer:?}");
    }

    #[tokio::test]
    async fn enroll_and_unenroll_are_not_available_yet_and_exit_with_code_3() {
        let rig = Rig::start(Arc::new(NotAvailableYet));

        let config = rig.client_config();
        let (code, text) = tokio::task::spawn_blocking(move || {
            let mut err = Vec::new();
            let result = call::<AdminEnroll>(config, enroll_params(), &mut err);
            (result.map(|_| ()).unwrap_err(), String::from_utf8(err).unwrap())
        })
        .await
        .unwrap();
        assert_eq!(code, EXIT_OPERATION_FAILED);
        assert!(text.starts_with("error: not_available_yet: "), "{text}");

        let config = rig.client_config();
        let code = tokio::task::spawn_blocking(move || {
            let (mut out, mut err) = (Vec::new(), Vec::new());
            run_unenroll(config, AdminUnenrollParams { remove_staff_account: false }, &mut out, &mut err)
        })
        .await
        .unwrap();
        assert_eq!(code, EXIT_OPERATION_FAILED);
        rig.stop().await;
    }

    #[tokio::test]
    async fn the_reason_travels_in_the_error_data() {
        let rig = Rig::start(Arc::new(NotAvailableYet));
        let mut client = RawClient::connect(&rig.name).await;
        hello(&mut client).await;
        let answer = client
            .request(1, "admin.enroll", json!({ "code": "RBX1.x", "deviceName": null, "allowJoined": false }))
            .await;
        match answer {
            Frame::Response { ok: false, error: Some(error), .. } => {
                assert_eq!(error.code, ErrorCode::OperationFailed);
                assert!(!error.retryable);
                assert_eq!(error.data.unwrap()["reason"], "not_available_yet");
            }
            other => panic!("unexpected {other:?}"),
        }
        let bad = client.request(2, "admin.enroll", json!({ "code": 5 })).await;
        assert!(matches!(
            bad,
            Frame::Response { ok: false, error: Some(RpcError { code: ErrorCode::InvalidParams, .. }), .. }
        ));
        let unknown = client.request(3, "admin.nope", json!({})).await;
        assert!(matches!(
            unknown,
            Frame::Response { ok: false, error: Some(RpcError { code: ErrorCode::UnknownMethod, .. }), .. }
        ));
        rig.stop().await;
    }

    #[tokio::test]
    async fn a_missing_pipe_is_exit_code_2() {
        let me = current_user_sid().unwrap();
        let config = ClientConfig {
            pipe_name: unique_pipe_name(),
            trusted_owner: me,
            request_timeout: Duration::from_secs(5),
            require_session_zero: false,
        };
        let (code, text) = tokio::task::spawn_blocking(move || {
            let (mut out, mut err) = (Vec::new(), Vec::new());
            let code = run_status(config, false, &mut out, &mut err);
            (code, String::from_utf8(err).unwrap())
        })
        .await
        .unwrap();
        assert_eq!(code, EXIT_NOT_RUNNING);
        assert_eq!(text.trim(), "The Rulebox Agent service is not running.");
    }

    #[tokio::test]
    async fn status_prints_the_snapshot_as_text_and_as_json() {
        let rig = Rig::start(Arc::new(NotAvailableYet));
        let config = rig.client_config();
        let (text_code, text, json_code, json_text) = tokio::task::spawn_blocking(move || {
            let (mut out, mut err) = (Vec::new(), Vec::new());
            let text_code = run_status(config.clone(), false, &mut out, &mut err);
            let text = String::from_utf8(out).unwrap();
            let (mut out, mut err) = (Vec::new(), Vec::new());
            let json_code = run_status(config, true, &mut out, &mut err);
            (text_code, text, json_code, String::from_utf8(out).unwrap())
        })
        .await
        .unwrap();
        assert_eq!((text_code, json_code), (0, 0));
        assert!(text.contains("enrollment    : notEnrolled"), "{text}");
        assert!(text.contains("display mode  : standard"), "{text}");
        let parsed: AdminStatusResult = serde_json::from_str(&json_text).unwrap();
        assert_eq!(parsed.snapshot, test_snapshot());
        assert_eq!(parsed.extra, None);
        rig.stop().await;
    }

    /// A handler that holds the operation until released.
    struct Blocking {
        started: Arc<Notify>,
        release: Arc<Notify>,
    }

    impl AdminHandler for Blocking {
        fn enroll(&self, _p: AdminEnrollParams) -> BoxFuture<'static, Result<AdminEnrollResult, RpcError>> {
            let (started, release) = (Arc::clone(&self.started), Arc::clone(&self.release));
            async move {
                started.notify_one();
                release.notified().await;
                Err(NotAvailableYet::failure("Enrollment"))
            }
            .boxed()
        }

        fn unenroll(&self, _p: AdminUnenrollParams) -> BoxFuture<'static, Result<(), RpcError>> {
            async { Ok(()) }.boxed()
        }
    }

    #[tokio::test]
    async fn only_one_enroll_or_unenroll_runs_at_a_time() {
        let started = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let rig = Rig::start(Arc::new(Blocking {
            started: Arc::clone(&started),
            release: Arc::clone(&release),
        }));
        let mut first = RawClient::connect(&rig.name).await;
        let mut second = RawClient::connect(&rig.name).await;
        hello(&mut first).await;
        hello(&mut second).await;

        first
            .send(Frame::Request {
                id: 1,
                method: "admin.enroll".into(),
                params: json!({ "code": "RBX1.x", "deviceName": null, "allowJoined": false }),
            })
            .await;
        tokio::time::timeout(Duration::from_secs(5), started.notified()).await.unwrap();

        let answer = second
            .request(1, "admin.unenroll", json!({ "removeStaffAccount": false }))
            .await;
        match answer {
            Frame::Response { ok: false, error: Some(error), .. } => {
                assert_eq!(error.code, ErrorCode::Busy);
                assert!(error.retryable);
            }
            other => panic!("unexpected {other:?}"),
        }
        // status is not an operation and is never refused.
        let status = second.request(2, "admin.status", json!({})).await;
        assert!(matches!(status, Frame::Response { ok: true, .. }));

        release.notify_one();
        let finished = first.recv().await.unwrap();
        assert!(matches!(finished, Frame::Response { id: 1, ok: false, .. }));
        // The slot is free again.
        let again = second.request(3, "admin.unenroll", json!({ "removeStaffAccount": true })).await;
        assert!(matches!(again, Frame::Response { ok: true, .. }));
        rig.stop().await;
    }

    #[test]
    fn status_text_shows_the_admin_exit_its_key_its_problem_and_its_lock() {
        use rulebox_ipc::types::AdminExitInfo;
        let result = |enabled: bool, extra: Option<AdminStatusExtra>| {
            let mut snapshot = test_snapshot();
            snapshot.admin_exit = Some(AdminExitInfo { enabled, hotkey: "Ctrl+Shift+F12".into() });
            format_status(&AdminStatusResult { snapshot, extra })
        };
        let line = |text: &str, name: &str| {
            text.lines().find(|l| l.starts_with(name)).map(str::to_string)
        };

        let on = result(true, Some(AdminStatusExtra::default()));
        assert_eq!(line(&on, "admin exit").as_deref(), Some("admin exit    : on (Ctrl+Shift+F12)"));
        assert!(line(&on, "exit locked").is_none() && line(&on, "exit failures").is_none());

        let off = result(false, Some(AdminStatusExtra::default()));
        assert_eq!(line(&off, "admin exit").as_deref(), Some("admin exit    : off"));

        let broken = result(
            false,
            Some(AdminStatusExtra {
                admin_exit_problem: Some("admin_exit_pin_invalid".into()),
                ..AdminStatusExtra::default()
            }),
        );
        assert_eq!(
            line(&broken, "admin exit").as_deref(),
            Some("admin exit    : off (admin_exit_pin_invalid)")
        );

        let locked = result(
            true,
            Some(AdminStatusExtra {
                admin_exit_failures: 5,
                admin_exit_locked_for_ms: Some(59_001),
                ..AdminStatusExtra::default()
            }),
        );
        assert_eq!(line(&locked, "exit failures").as_deref(), Some("exit failures : 5"));
        assert_eq!(line(&locked, "exit locked").as_deref(), Some("exit locked   : 60 s left"));

        // A 1.0 agent sends neither the field nor `extra`: no exit lines at all.
        let mut old = test_snapshot();
        old.admin_exit = None;
        let text = format_status(&AdminStatusResult { snapshot: old, extra: None });
        assert!(!text.contains("admin exit") && !text.contains("exit locked"));
    }

    #[test]
    fn operation_failures_print_blockers_and_retry_hints() {
        let blocked = operation_failed(
            reasons::COMPAT_BLOCKED,
            "This PC cannot be enrolled.",
            false,
            Some(json!({ "blockers": ["no_other_admin", "legal_notice"] })),
        );
        let mut err = Vec::new();
        assert_eq!(report_error(&CallError::Rpc(blocked), &mut err), EXIT_OPERATION_FAILED);
        assert_eq!(
            String::from_utf8(err).unwrap(),
            "error: compat_blocked: This PC cannot be enrolled.\n  - no_other_admin\n  - legal_notice\n"
        );

        let unreachable =
            operation_failed(reasons::BACKEND_UNREACHABLE, "The backend did not answer.", true, None);
        let mut err = Vec::new();
        assert_eq!(report_error(&CallError::Rpc(unreachable), &mut err), EXIT_OPERATION_FAILED);
        assert!(String::from_utf8(err).unwrap().ends_with("Try again.\n"));

        let busy = rpc_error(ErrorCode::Busy, "Another enroll or unenroll is already running.", true);
        let mut err = Vec::new();
        assert_eq!(report_error(&CallError::Rpc(busy), &mut err), EXIT_ERROR);
        assert!(String::from_utf8(err).unwrap().starts_with("error: busy: "));

        let mut err = Vec::new();
        assert_eq!(report_error(&CallError::ServerNotTrusted, &mut err), EXIT_ERROR);
        assert_eq!(report_error(&CallError::Timeout, &mut err), EXIT_ERROR);
    }
}
