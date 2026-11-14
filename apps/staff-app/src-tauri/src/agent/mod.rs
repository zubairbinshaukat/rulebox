//! Agent port: React never sees IPC. Commands talk to `AgentPort` only.
//!
//! Session / apps / admin-exit methods are part of the port now; commands that
//! call them arrive in later steps — allow dead_code until then.

#![allow(dead_code)]

use futures_util::future::BoxFuture;
use thiserror::Error;
use tokio::sync::{broadcast, watch};

use rulebox_ipc::requests::DenialCount;

use crate::model::{
    AdminExitOutcome, AgentEvent, AgentLink, AppEntry, Employee, SignInOutcome, SignInRequest,
    VerifyOutcome,
};

#[cfg(debug_assertions)]
pub mod demo;
pub mod ipc;

pub trait AgentPort: Send + Sync + 'static {
    fn link(&self) -> watch::Receiver<AgentLink>;
    fn snapshot(&self) -> watch::Receiver<Option<rulebox_ipc::types::AgentSnapshot>>;
    fn capabilities(&self) -> Vec<String>;
    /// Protocol 1.2 pushes (`apps.changed`, `session.ended`). One consumer is
    /// enough; a receiver that lags behind loses the oldest events.
    fn events(&self) -> broadcast::Receiver<AgentEvent>;
    /// Debug only (the dev command file): send `event` as if the agent had.
    #[cfg(debug_assertions)]
    fn dev_emit(&self, _event: AgentEvent) {}
    /// Debug only (the dev command file): the demo agent locks (`Some`) or unlocks the device.
    #[cfg(debug_assertions)]
    fn dev_set_lock(&self, _lock: Option<rulebox_ipc::types::DeviceLockView>) {}
    /// Debug only: the demo agent replaces its broadcast list.
    #[cfg(debug_assertions)]
    fn dev_set_broadcasts(&self, _list: Vec<rulebox_ipc::types::BroadcastView>) {}
    /// `session.get`: the employee the agent holds a session for, `None` when it
    /// has none. The shell asks after a lost push or a re-link, to be sure that
    /// it is not showing a session the agent no longer has.
    fn session_get(&self) -> BoxFuture<'_, Result<Option<Employee>, AgentError>>;
    fn ready(&self) -> BoxFuture<'_, Result<(), AgentError>>;
    fn heartbeat(&self) -> BoxFuture<'_, Result<(), AgentError>>;
    fn sign_in(&self, req: SignInRequest) -> BoxFuture<'_, Result<SignInOutcome, AgentError>>;
    fn sign_out(&self) -> BoxFuture<'_, Result<(), AgentError>>;
    fn verify_password(
        &self,
        password: String,
    ) -> BoxFuture<'_, Result<VerifyOutcome, AgentError>>;
    fn apps(&self) -> BoxFuture<'_, Result<Vec<AppEntry>, AgentError>>;
    fn admin_exit(&self, pin: String) -> BoxFuture<'_, Result<AdminExitOutcome, AgentError>>;
    /// (1.3, capability `broadcasts`) The employee pressed "OK". `true` when the agent
    /// queued (or already had) the acknowledgement.
    fn ack_broadcast(&self, id: String) -> BoxFuture<'_, Result<bool, AgentError>>;
    /// (1.3, capability `permissionReports`) The per-app denial counters since the last report.
    fn report_denials(&self, counts: Vec<DenialCount>) -> BoxFuture<'_, Result<(), AgentError>>;
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum AgentError {
    #[error("not linked to the agent")]
    NotLinked,
    #[error("the agent did not answer in time")]
    Timeout,
    #[error("this agent does not support the method")]
    Unsupported,
    #[error("protocol version mismatch")]
    VersionMismatch,
    #[error("rejected: {code}: {message}")]
    Rejected { code: String, message: String },
    #[error("internal: {0}")]
    Internal(String),
}

impl AgentError {
    /// This agent lacks the capability: an older agent, nothing to show and no error.
    pub fn is_unsupported(&self) -> bool {
        matches!(self, AgentError::Unsupported)
    }

    /// The agent answered "no employee is signed in" (`not_signed_in`).
    pub fn is_not_signed_in(&self) -> bool {
        matches!(self, AgentError::Rejected { code, .. } if code == "not_signed_in")
    }
}

/// Pick demo (debug + `RULEBOX_STAFF_DEMO=1`) or IPC.
pub fn select_agent() -> std::sync::Arc<dyn AgentPort> {
    #[cfg(debug_assertions)]
    {
        if std::env::var("RULEBOX_STAFF_DEMO").as_deref() == Ok("1") {
            tracing::info!("agent port: DemoAgent (RULEBOX_STAFF_DEMO=1)");
            return std::sync::Arc::new(demo::DemoAgent::new());
        }
    }
    tracing::info!("agent port: IpcAgent");
    std::sync::Arc::new(ipc::IpcAgent::connect())
}
