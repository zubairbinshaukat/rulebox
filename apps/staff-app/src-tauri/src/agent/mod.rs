//! Agent port: React never sees IPC. Commands talk to `AgentPort` only.
//!
//! Session / apps / admin-exit methods are part of the port now; commands that
//! call them arrive in later steps — allow dead_code until then.

#![allow(dead_code)]

use futures_util::future::BoxFuture;
use thiserror::Error;
use tokio::sync::watch;

use crate::model::{
    AdminExitOutcome, AgentLink, AppEntry, SignInOutcome, SignInRequest, VerifyOutcome,
};

#[cfg(debug_assertions)]
pub mod demo;
pub mod ipc;

pub trait AgentPort: Send + Sync + 'static {
    fn link(&self) -> watch::Receiver<AgentLink>;
    fn snapshot(&self) -> watch::Receiver<Option<rulebox_ipc::types::AgentSnapshot>>;
    fn capabilities(&self) -> Vec<String>;
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
