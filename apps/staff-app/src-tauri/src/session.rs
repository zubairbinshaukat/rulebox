//! Employee sign-in / switch-user. Privileged checks stay on the agent.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::agent::AgentError;
use crate::commands::CommandError;
use crate::model::{
    CatalogState, CatalogStatus, Employee, EmployeeBrief, SessionState, SignInOutcome,
    SignInRequest,
};
use crate::state::AppState;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct LastUserFile {
    username: String,
    name: String,
}

fn staff_data_dir() -> Option<PathBuf> {
    let local = std::env::var_os("LOCALAPPDATA")?;
    Some(PathBuf::from(local).join("dev.rulebox.staff"))
}

fn last_user_path() -> Option<PathBuf> {
    Some(staff_data_dir()?.join("last-user.json"))
}

/// Load the remembered employee for the sign-in screen (if any).
pub fn load_last_user() -> Option<EmployeeBrief> {
    let path = last_user_path()?;
    let bytes = fs::read(path).ok()?;
    let parsed: LastUserFile = serde_json::from_slice(&bytes).ok()?;
    if parsed.username.is_empty() || parsed.name.is_empty() {
        return None;
    }
    Some(EmployeeBrief {
        username: parsed.username,
        name: parsed.name,
    })
}

fn save_last_user(employee: &Employee) -> Result<(), String> {
    let dir = staff_data_dir().ok_or_else(|| "LOCALAPPDATA is not set".to_string())?;
    fs::create_dir_all(&dir).map_err(|e| format!("create staff data dir: {e}"))?;
    let path = dir.join("last-user.json");
    let body = LastUserFile {
        username: employee.username.clone(),
        name: employee.name.clone(),
    };
    let json = serde_json::to_vec_pretty(&body).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| format!("write last-user.json: {e}"))
}

/// Apply a successful or failed sign-in outcome to `AppState`.
pub fn apply_sign_in_outcome(state: &AppState, outcome: SignInOutcome) -> Result<(), CommandError> {
    match outcome {
        SignInOutcome::Ok {
            employee,
            files_root,
            offline,
        } => {
            if let Err(error) = save_last_user(&employee) {
                tracing::warn!(%error, "could not save last-user.json");
            }
            state.set_files_root(Some(files_root));
            state.update(|s| {
                s.session = SessionState::SignedIn {
                    employee: employee.clone(),
                    locked: false,
                    offline,
                };
                s.apps = CatalogState {
                    status: CatalogStatus::Loading,
                    items: Vec::new(),
                };
            });
            // Catalogue load is async — kicked by the caller after Ok.
            Ok(())
        }
        SignInOutcome::WrongCredentials
        | SignInOutcome::Disabled
        | SignInOutcome::LockedOut { .. }
        | SignInOutcome::OfflineNeverSignedIn
        | SignInOutcome::OfflineExpired
        | SignInOutcome::Unknown => {
            // Return to SignedOut with the previous "last" (if any) so the
            // returning-employee form stays available. Form errors live in React.
            let last = state.snapshot().session_last();
            state.update(|s| {
                s.session = SessionState::SignedOut { last };
            });
            Ok(())
        }
    }
}

trait SessionLast {
    fn session_last(&self) -> Option<EmployeeBrief>;
}

impl SessionLast for crate::model::ShellState {
    fn session_last(&self) -> Option<EmployeeBrief> {
        match &self.session {
            SessionState::SignedOut { last } => last.clone(),
            SessionState::SignedIn { employee, .. } => Some(EmployeeBrief {
                username: employee.username.clone(),
                name: employee.name.clone(),
            }),
            SessionState::SigningIn | SessionState::SigningOut => None,
        }
    }
}

/// Run sign-in against the agent and update state. Returns the outcome so the
/// UI can show inline errors (wrong password, lockout, …).
pub async fn sign_in(
    state: &AppState,
    username: String,
    password: String,
) -> Result<SignInOutcome, CommandError> {
    if !state
        .agent()
        .capabilities()
        .iter()
        .any(|c| c == "session")
    {
        return Err(CommandError::Agent(AgentError::Unsupported));
    }

    state.update(|s| {
        s.session = SessionState::SigningIn;
    });

    let req = SignInRequest {
        username,
        password,
    };
    // `password` lives only inside `req` until this call returns.
    let outcome = match state.agent().sign_in(req).await {
        Ok(outcome) => outcome,
        Err(error) => {
            let last = load_last_user();
            state.update(|s| {
                s.session = SessionState::SignedOut { last };
            });
            return Err(CommandError::Agent(error));
        }
    };

    apply_sign_in_outcome(state, outcome.clone())?;

    if matches!(outcome, SignInOutcome::Ok { .. }) {
        load_catalogue(state).await;
    }

    Ok(outcome)
}

pub async fn load_catalogue(state: &AppState) {
    match state.agent().apps().await {
        Ok(items) => {
            state.update(|s| {
                s.apps = CatalogState {
                    status: CatalogStatus::Ready,
                    items,
                };
            });
        }
        Err(error) => {
            tracing::warn!(?error, "apps.list failed after sign-in");
            state.update(|s| {
                s.apps = CatalogState {
                    status: CatalogStatus::Error,
                    items: Vec::new(),
                };
            });
        }
    }
}

pub async fn sign_in_last(state: &AppState, password: String) -> Result<SignInOutcome, CommandError> {
    let username = match state.snapshot().session {
        SessionState::SignedOut {
            last: Some(ref brief),
        } => brief.username.clone(),
        _ => load_last_user()
            .map(|b| b.username)
            .ok_or_else(|| CommandError::Failed("no remembered employee".into()))?,
    };
    sign_in(state, username, password).await
}

/// Forget the remembered employee on the sign-in screen ("not you?").
/// Only valid while signed out: it never ends an agent session, so calling
/// it for a signed-in employee would leave the agent and the UI disagreeing.
pub fn switch_user(state: &AppState) -> Result<(), CommandError> {
    if !matches!(state.snapshot().session, SessionState::SignedOut { .. }) {
        return Err(CommandError::Forbidden);
    }
    state.update(|s| {
        s.session = SessionState::SignedOut { last: None };
    });
    Ok(())
}

/// Pure mapping used by tests: which shell session follows each outcome.
pub fn session_after_outcome(
    last_before: Option<EmployeeBrief>,
    outcome: &SignInOutcome,
) -> SessionState {
    match outcome {
        SignInOutcome::Ok {
            employee,
            offline,
            ..
        } => SessionState::SignedIn {
            employee: employee.clone(),
            locked: false,
            offline: *offline,
        },
        _ => SessionState::SignedOut {
            last: last_before,
        },
    }
}
