//! Employee sign-in, lock, and log out. Privileged checks stay on the agent.
//!
//! Log out closes only windows the shell launched (every window of a job it
//! created, and the specific hand-off window it adopted) plus its own built-in
//! and web windows. A window opened some other way is never closed, including
//! an older window of a process that later received a hand-off.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
use std::thread;
use std::time::{Duration, Instant};

use rulebox_desktop::control;
use serde::{Deserialize, Serialize};

use crate::agent::AgentError;
use crate::commands::CommandError;
use crate::model::{
    CatalogState, CatalogStatus, Employee, EmployeeBrief, SessionState, SignInOutcome,
    SignInRequest, VerifyOutcome,
};
use crate::state::AppState;
use crate::tasks::TaskServices;

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

/// Open the employee's folder behind the files backend. Sign-in goes on when
/// it fails: the person still gets a desktop, and a notice says why Files is empty.
fn open_files(state: &AppState, files_root: &str, quota_bytes: u64) {
    let emit: crate::files::Emit = match state.app_handle() {
        Some(app) => crate::files::ui_emitter(app),
        None => std::sync::Arc::new(|_, _| {}),
    };
    if let Err(error) = state
        .files()
        .sign_in(std::path::Path::new(files_root), quota_bytes, emit)
    {
        tracing::error!(%error, "could not open the employee's folder");
        state.notify(
            crate::model::NoticeTone::Warning,
            "Your files could not be opened.",
            Some("Ask your administrator.".into()),
        );
    }
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
            open_files(state, &files_root, employee.quota_bytes);
            state.set_files_root(Some(files_root));
            let theme = crate::system::theme_for_sign_in(
                state.org_theme(),
                crate::system::load_theme(&employee.id),
            );
            state.update(|s| {
                s.session = SessionState::SignedIn {
                    employee: employee.clone(),
                    locked: false,
                    offline,
                };
                s.display.theme = theme;
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

// ---------------------------------------------------------------------------
// Search, lock, log out. Pure pieces are what the tests drive.
// ---------------------------------------------------------------------------

/// Case-fold and strip common Latin diacritics so "Café" matches "cafe".
pub fn fold_search(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        for lower in c.to_lowercase() {
            match lower {
                'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' | 'ā' | 'ă' | 'ą' => out.push('a'),
                'æ' => out.push_str("ae"),
                'ç' | 'ć' | 'č' | 'ĉ' | 'ċ' => out.push('c'),
                'ď' | 'đ' => out.push('d'),
                'è' | 'é' | 'ê' | 'ë' | 'ē' | 'ĕ' | 'ė' | 'ę' | 'ě' => out.push('e'),
                'ì' | 'í' | 'î' | 'ï' | 'ī' | 'ĭ' | 'į' | 'ı' => out.push('i'),
                'ñ' | 'ń' | 'ň' | 'ņ' => out.push('n'),
                'ò' | 'ó' | 'ô' | 'õ' | 'ö' | 'ø' | 'ō' | 'ŏ' | 'ő' => out.push('o'),
                'œ' => out.push_str("oe"),
                'ù' | 'ú' | 'û' | 'ü' | 'ū' | 'ŭ' | 'ů' | 'ű' | 'ų' => out.push('u'),
                'ý' | 'ÿ' | 'ŷ' => out.push('y'),
                'ß' => out.push_str("ss"),
                'ž' | 'ź' | 'ż' => out.push('z'),
                'š' | 'ś' | 'ş' => out.push('s'),
                'ğ' => out.push('g'),
                'ł' => out.push('l'),
                other => out.push(other),
            }
        }
    }
    out
}

/// `name` contains `query`, ignoring case and diacritics. An empty query matches.
pub fn matches_search(name: &str, query: &str) -> bool {
    let query = fold_search(query.trim());
    query.is_empty() || fold_search(name).contains(&query)
}

/// A tracked window log-out might close.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CloseCandidate {
    pub hwnd: isize,
    pub pid: u32,
    /// A built-in or web window the shell created (`app-*` / `web-*`).
    pub shell_app: bool,
}

/// What log out may close besides the shell's own app windows.
///
/// `job_pids` are processes the shell started: every one of their windows
/// closes. `adopted_hwnds` are the specific hand-off windows. Another window
/// of that same process, opened some other way, is left alone.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SignOutScope {
    pub job_pids: HashSet<u32>,
    pub adopted_hwnds: HashSet<isize>,
}

impl SignOutScope {
    fn covers(&self, hwnd: isize, pid: u32) -> bool {
        self.job_pids.contains(&pid) || self.adopted_hwnds.contains(&hwnd)
    }
}

/// Windows log out may close: shell apps first, then launched ones.
/// Anything outside `scope` is left alone.
pub fn sign_out_targets(windows: &[CloseCandidate], scope: &SignOutScope) -> Vec<isize> {
    let mut shell_apps = Vec::new();
    let mut launched = Vec::new();
    for window in windows {
        if window.shell_app {
            shell_apps.push(window.hwnd);
        } else if scope.covers(window.hwnd, window.pid) {
            launched.push(window.hwnd);
        }
    }
    shell_apps.extend(launched);
    shell_apps
}

/// A tracked window, with the title the confirm dialog would show.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NamedWindow {
    pub hwnd: isize,
    pub pid: u32,
    pub shell_app: bool,
    pub title: String,
}

/// Display names of the apps log out will close, in window order, de-duplicated.
/// `owned` is pid → catalogue app id. A foreign window is omitted.
pub fn closing_names(
    windows: &[NamedWindow],
    scope: &SignOutScope,
    owned: &HashMap<u32, String>,
    app_names: &HashMap<String, String>,
) -> Vec<String> {
    let mut names = Vec::new();
    for window in windows {
        if !window.shell_app && !scope.covers(window.hwnd, window.pid) {
            continue;
        }
        let name = if let Some(app_id) = owned.get(&window.pid) {
            app_names
                .get(app_id)
                .cloned()
                .filter(|name| !name.is_empty())
                .unwrap_or_else(|| window.title.clone())
        } else {
            window.title.clone()
        };
        let name = name.trim().to_string();
        if name.is_empty() || names.iter().any(|existing| existing == &name) {
            continue;
        }
        names.push(name);
    }
    names
}

/// What lock does to a signed-in session. `None` when nobody is signed in,
/// or when an unlock is asked for a session that is not locked.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LockEvent {
    Lock,
    UnlockOk,
    UnlockDenied,
}

pub fn lock_transition(session: &SessionState, event: LockEvent) -> Option<SessionState> {
    let SessionState::SignedIn {
        employee,
        locked,
        offline,
    } = session
    else {
        return None;
    };
    let locked = match event {
        LockEvent::Lock => true,
        LockEvent::UnlockOk => {
            if !locked {
                return None;
            }
            false
        }
        LockEvent::UnlockDenied => {
            if !locked {
                return None;
            }
            true
        }
    };
    Some(SessionState::SignedIn {
        employee: employee.clone(),
        locked,
        offline: *offline,
    })
}

/// One tracked window lock might minimize.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MinimizeCandidate {
    pub hwnd: isize,
    pub pid: u32,
    pub shell_app: bool,
}

/// Shell mode minimizes every tracked window. Dev mode minimizes only what
/// the shell launched and its own app windows, so the developer's other
/// programs stay put (the dev taskbar lists them).
pub fn windows_to_minimize(
    dev_mode: bool,
    windows: &[MinimizeCandidate],
    scope: &SignOutScope,
) -> Vec<isize> {
    windows
        .iter()
        .filter(|window| !dev_mode || window.shell_app || scope.covers(window.hwnd, window.pid))
        .map(|window| window.hwnd)
        .collect()
}

/// The steps after the confirm dialog. Implemented by the real shell and by
/// the log-out test's fake.
pub trait SignOutOps {
    fn close(&mut self, hwnd: isize);
    fn wait_for_close(&mut self);
    fn terminate_jobs(&mut self);
    fn clear_memory(&mut self);
    fn agent_sign_out(&mut self) -> Result<(), String>;
    fn signed_out(&mut self);
}

/// Close `targets`, wait, end the shell's jobs, clear in-memory session
/// data, ask the agent, then mark signed out. An agent error is logged and
/// does not stop the sequence. `targets` must already exclude foreign windows.
pub fn drive_sign_out(ops: &mut dyn SignOutOps, targets: &[isize]) {
    for hwnd in targets {
        ops.close(*hwnd);
    }
    ops.wait_for_close();
    ops.terminate_jobs();
    ops.clear_memory();
    if let Err(error) = ops.agent_sign_out() {
        tracing::warn!(error, "agent sign-out failed; log out continues");
    }
    ops.signed_out();
}

const SIGN_OUT_WAIT: Duration = Duration::from_secs(5);

struct LiveSignOut<'a> {
    state: &'a AppState,
    services: &'a TaskServices,
    hwnds: Vec<isize>,
    last: Option<EmployeeBrief>,
}

impl SignOutOps for LiveSignOut<'_> {
    fn close(&mut self, hwnd: isize) {
        if let Err(error) = control::close(hwnd) {
            tracing::warn!(%error, hwnd, "log out: window did not close");
        }
    }

    fn wait_for_close(&mut self) {
        let deadline = Instant::now() + SIGN_OUT_WAIT;
        while Instant::now() < deadline {
            if self.hwnds.iter().all(|hwnd| !control::is_open(*hwnd)) {
                return;
            }
            thread::sleep(Duration::from_millis(100));
        }
        tracing::info!("log out: some apps are still open after 5s; ending their jobs");
    }

    fn terminate_jobs(&mut self) {
        self.services.launcher.terminate_all();
    }

    fn clear_memory(&mut self) {
        // Closing the file session also drops the recent list, the folder
        // watcher and any running search. (The file clipboard lives in the
        // Files window, which log out closes.)
        self.state.files().sign_out();
        self.state.set_files_root(None);
        self.state.update(|shell| {
            shell.notices.clear();
        });
    }

    fn agent_sign_out(&mut self) -> Result<(), String> {
        let agent = self.state.agent();
        tauri::async_runtime::block_on(agent.sign_out()).map_err(|error| error.to_string())
    }

    fn signed_out(&mut self) {
        let last = self.last.clone();
        let theme = crate::system::theme_after_sign_out(self.state.org_theme());
        self.state.update(|shell| {
            shell.session = SessionState::SignedOut { last };
            shell.display.theme = theme;
            shell.apps = CatalogState {
                status: CatalogStatus::Idle,
                items: Vec::new(),
            };
            shell.tasks.clear();
        });
    }
}

fn launch_view(
    services: &TaskServices,
) -> (
    Vec<(isize, crate::tasks::TaskFacts)>,
    HashMap<u32, String>,
    SignOutScope,
) {
    let listed = services.registry.snapshot();
    let live: HashSet<u32> = listed.iter().map(|(_, facts)| facts.pid).collect();
    let owned = services.launcher.pid_map(&live);
    let (job_pids, adopted_hwnds) = services.launcher.sign_out_scope(&live);
    (
        listed,
        owned,
        SignOutScope {
            job_pids,
            adopted_hwnds,
        },
    )
}

/// Run log-out steps 3–7. The caller has already set `SigningOut`.
pub fn perform_sign_out(state: &AppState, services: &TaskServices, employee: &Employee) {
    let (listed, _owned, scope) = launch_view(services);
    let candidates: Vec<CloseCandidate> = listed
        .iter()
        .map(|(hwnd, facts)| CloseCandidate {
            hwnd: *hwnd,
            pid: facts.pid,
            shell_app: facts.own,
        })
        .collect();
    let targets = sign_out_targets(&candidates, &scope);
    let last = Some(EmployeeBrief {
        username: employee.username.clone(),
        name: employee.name.clone(),
    });
    let mut live = LiveSignOut {
        state,
        services,
        hwnds: targets.clone(),
        last,
    };
    drive_sign_out(&mut live, &targets);
}

/// Names for the confirm dialog: only apps this log out will close.
pub fn apps_closing(state: &AppState, services: &TaskServices) -> Vec<String> {
    let (listed, owned, scope) = launch_view(services);
    let titles: HashMap<isize, String> = state
        .snapshot()
        .tasks
        .into_iter()
        .filter_map(|task| {
            let hwnd = task.id.parse::<isize>().ok()?;
            Some((hwnd, task.title))
        })
        .collect();
    let windows: Vec<NamedWindow> = listed
        .iter()
        .map(|(hwnd, facts)| NamedWindow {
            hwnd: *hwnd,
            pid: facts.pid,
            shell_app: facts.own,
            title: titles.get(hwnd).cloned().unwrap_or_default(),
        })
        .collect();
    let app_names: HashMap<String, String> = state
        .snapshot()
        .apps
        .items
        .into_iter()
        .map(|app| (app.id, app.name))
        .collect();
    closing_names(&windows, &scope, &owned, &app_names)
}

/// Mark the session locked. Returns the windows to minimize (already filtered
/// for dev mode). `None` when nobody is signed in.
pub fn begin_lock(state: &AppState, services: &TaskServices, dev_mode: bool) -> Option<Vec<isize>> {
    let next = lock_transition(&state.snapshot().session, LockEvent::Lock)?;
    state.update(|shell| {
        shell.session = next;
    });
    let (listed, _owned, scope) = launch_view(services);
    let candidates: Vec<MinimizeCandidate> = listed
        .iter()
        .map(|(hwnd, facts)| MinimizeCandidate {
            hwnd: *hwnd,
            pid: facts.pid,
            shell_app: facts.own,
        })
        .collect();
    Some(windows_to_minimize(dev_mode, &candidates, &scope))
}

/// Check the password with the agent. A wrong password leaves the session locked.
pub async fn unlock(state: &AppState, password: String) -> Result<VerifyOutcome, CommandError> {
    if !matches!(
        state.snapshot().session,
        SessionState::SignedIn { locked: true, .. }
    ) {
        return Err(CommandError::Failed("the session is not locked".into()));
    }
    let outcome = state.agent().verify_password(password).await?;
    let event = match outcome {
        VerifyOutcome::Ok => LockEvent::UnlockOk,
        _ => LockEvent::UnlockDenied,
    };
    if let Some(next) = lock_transition(&state.snapshot().session, event) {
        state.update(|shell| {
            shell.session = next;
        });
    }
    Ok(outcome)
}
