//! Real agent over the named pipe (`rulebox_ipc::IpcClient`).

use std::sync::{Arc, Mutex};

use futures_util::future::BoxFuture;
use rulebox_ipc::client::{CallError, ClientConfig, ClientEvent, IpcClient, LinkState};
use rulebox_ipc::methods::{
    AdminExitSubmit, AppsList, Empty, SessionSignIn, SessionSignOut, SessionVerifyPassword,
    ShellHeartbeat, ShellReady,
};
use rulebox_ipc::requests::{AdminExitSubmitParams, SignInParams, VerifyPasswordParams};
use rulebox_ipc::envelope::ErrorCode;
use rulebox_ipc::types::{AgentSnapshot, ClientInfo, ClientRole, HelloResult};
use rulebox_ipc::{CAP_ADMIN_EXIT, CAP_APPS, CAP_SESSION};
use tokio::sync::{mpsc, watch};

use super::{AgentError, AgentPort};
use crate::model::{
    map_admin_exit_result, map_sign_in_result, map_verify_result, map_wire_app, AdminExitOutcome,
    AgentLink, AppEntry, SignInOutcome, SignInRequest, VerifyOutcome,
};

struct Shared {
    client: IpcClient,
    link_tx: watch::Sender<AgentLink>,
    link_rx: watch::Receiver<AgentLink>,
    snap_tx: watch::Sender<Option<AgentSnapshot>>,
    snap_rx: watch::Receiver<Option<AgentSnapshot>>,
    capabilities: Mutex<Vec<String>>,
}

/// Wraps `IpcClient`. Never opens the pipe itself — the client reconnects.
pub struct IpcAgent {
    shared: Arc<Shared>,
}

impl IpcAgent {
    /// Connect using `ClientConfig::production()` (honours `RULEBOX_AGENT_SIM` in debug).
    pub fn connect() -> Self {
        let info = ClientInfo {
            role: ClientRole::Shell,
            name: "rulebox-staff".into(),
            version: env!("CARGO_PKG_VERSION").into(),
        };
        let config = ClientConfig::production();
        tracing::info!(pipe = %config.pipe_name, "IpcAgent connecting");
        let (client, events) = IpcClient::spawn_with(info, config);
        Self::from_client(client, events)
    }

    fn from_client(client: IpcClient, mut events: mpsc::Receiver<ClientEvent>) -> Self {
        let (link_tx, link_rx) = watch::channel(AgentLink::Disconnected);
        let (snap_tx, snap_rx) = watch::channel(None);
        let shared = Arc::new(Shared {
            client,
            link_tx,
            link_rx,
            snap_tx,
            snap_rx,
            capabilities: Mutex::new(Vec::new()),
        });

        let pump = Arc::clone(&shared);
        spawn_bg(async move {
            while let Some(event) = events.recv().await {
                match event {
                    ClientEvent::Linked(hello) => {
                        on_linked(&pump, hello);
                    }
                    ClientEvent::Unlinked => {
                        let _ = pump.link_tx.send(AgentLink::Disconnected);
                        let _ = pump.snap_tx.send(None);
                        if let Ok(mut caps) = pump.capabilities.lock() {
                            caps.clear();
                        }
                    }
                    ClientEvent::StateChanged(snap) => {
                        let _ = pump.snap_tx.send(Some(snap));
                    }
                    ClientEvent::ShuttingDown { .. } => {
                        // Banner wiring lands with session / boot steps.
                    }
                }
            }
        });

        // Mirror LinkState::Connecting from the underlying client.
        let mirror = Arc::clone(&shared);
        spawn_bg(async move {
            let mut rx = mirror.client.connection();
            loop {
                let state = *rx.borrow();
                match state {
                    LinkState::Connecting => {
                        if *mirror.link_rx.borrow() != AgentLink::VersionMismatch {
                            let _ = mirror.link_tx.send(AgentLink::Connecting);
                        }
                    }
                    LinkState::Disconnected => {
                        if *mirror.link_rx.borrow() == AgentLink::Connecting {
                            let _ = mirror.link_tx.send(AgentLink::Disconnected);
                        }
                    }
                    LinkState::Linked => {}
                }
                if rx.changed().await.is_err() {
                    break;
                }
            }
        });

        Self { shared }
    }

    fn require_cap(&self, name: &str) -> Result<(), AgentError> {
        let caps = self
            .shared
            .capabilities
            .lock()
            .map_err(|e| AgentError::Internal(e.to_string()))?;
        if caps.iter().any(|c| c == name) {
            Ok(())
        } else {
            Err(AgentError::Unsupported)
        }
    }
}

fn spawn_bg<F>(fut: F)
where
    F: std::future::Future<Output = ()> + Send + 'static,
{
    if let Ok(handle) = tokio::runtime::Handle::try_current() {
        handle.spawn(fut);
    } else {
        tauri::async_runtime::spawn(fut);
    }
}

fn on_linked(shared: &Shared, hello: HelloResult) {
    if let Ok(mut caps) = shared.capabilities.lock() {
        *caps = hello.capabilities;
    }
    let _ = shared.link_tx.send(AgentLink::Linked);
}

fn map_call_error(error: CallError) -> AgentError {
    match error {
        CallError::ServerNotTrusted => {
            // The pipe's server failed the peer check. It is shown as "not
            // linked", but it is not an ordinary disconnect: say so in the log.
            tracing::warn!("the agent pipe's server was not trusted");
            AgentError::NotLinked
        }
        CallError::NotLinked | CallError::AccessDenied => AgentError::NotLinked,
        CallError::Timeout => AgentError::Timeout,
        CallError::Rpc(rpc) => {
            if matches!(rpc.code, ErrorCode::UnsupportedProtocol) {
                return AgentError::VersionMismatch;
            }
            let code = serde_json::to_value(rpc.code)
                .ok()
                .and_then(|v| v.as_str().map(str::to_string))
                .unwrap_or_else(|| "internal".into());
            AgentError::Rejected {
                code,
                message: rpc.message,
            }
        }
        CallError::Protocol(msg) => AgentError::Internal(msg),
    }
}

impl AgentPort for IpcAgent {
    fn link(&self) -> watch::Receiver<AgentLink> {
        self.shared.link_rx.clone()
    }

    fn snapshot(&self) -> watch::Receiver<Option<AgentSnapshot>> {
        self.shared.snap_rx.clone()
    }

    fn capabilities(&self) -> Vec<String> {
        self.shared
            .capabilities
            .lock()
            .map(|c| c.clone())
            .unwrap_or_default()
    }

    fn ready(&self) -> BoxFuture<'_, Result<(), AgentError>> {
        Box::pin(async move {
            self.shared
                .client
                .call::<ShellReady>(Empty {})
                .await
                .map(|_| ())
                .map_err(map_call_error)
        })
    }

    fn heartbeat(&self) -> BoxFuture<'_, Result<(), AgentError>> {
        Box::pin(async move {
            self.shared
                .client
                .call::<ShellHeartbeat>(Empty {})
                .await
                .map(|_| ())
                .map_err(map_call_error)
        })
    }

    fn sign_in(&self, req: SignInRequest) -> BoxFuture<'_, Result<SignInOutcome, AgentError>> {
        Box::pin(async move {
            self.require_cap(CAP_SESSION)?;
            let result = self
                .shared
                .client
                .call::<SessionSignIn>(SignInParams {
                    username: req.username,
                    password: req.password,
                })
                .await
                .map_err(map_call_error)?;
            Ok(map_sign_in_result(result))
        })
    }

    fn sign_out(&self) -> BoxFuture<'_, Result<(), AgentError>> {
        Box::pin(async move {
            self.require_cap(CAP_SESSION)?;
            self.shared
                .client
                .call::<SessionSignOut>(Empty {})
                .await
                .map(|_| ())
                .map_err(map_call_error)
        })
    }

    fn verify_password(
        &self,
        password: String,
    ) -> BoxFuture<'_, Result<VerifyOutcome, AgentError>> {
        Box::pin(async move {
            self.require_cap(CAP_SESSION)?;
            let result = self
                .shared
                .client
                .call::<SessionVerifyPassword>(VerifyPasswordParams { password })
                .await
                .map_err(map_call_error)?;
            Ok(map_verify_result(result))
        })
    }

    fn apps(&self) -> BoxFuture<'_, Result<Vec<AppEntry>, AgentError>> {
        Box::pin(async move {
            self.require_cap(CAP_APPS)?;
            let result = self
                .shared
                .client
                .call::<AppsList>(Empty {})
                .await
                .map_err(map_call_error)?;
            Ok(result.apps.into_iter().filter_map(map_wire_app).collect())
        })
    }

    fn admin_exit(&self, pin: String) -> BoxFuture<'_, Result<AdminExitOutcome, AgentError>> {
        Box::pin(async move {
            self.require_cap(CAP_ADMIN_EXIT)?;
            let result = self
                .shared
                .client
                .call::<AdminExitSubmit>(AdminExitSubmitParams { pin })
                .await
                .map_err(map_call_error)?;
            Ok(map_admin_exit_result(result))
        })
    }
}
