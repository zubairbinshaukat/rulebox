//! Session cleanup (plan Phase 4 Step 16, Section 4.12; PRD 5.3 and 13.3): after an
//! employee's session ends, the agent deletes the "data folders to reset on
//! logout" of **every** desktop app in the current catalogue, so the next
//! employee on the shared Staff account does not find the last one's saved login.
//!
//! - A `resetFolders` entry is a template, `{LocalAppData}\<rel>` or
//!   `{RoamingAppData}\<rel>` (`rulebox_policy::paths::reset_folder_parts`, which
//!   also refuses Windows' and Rulebox's own folders), and is only ever resolved
//!   below `<Staff profile>\AppData\Local` or `\Roaming` ([`resolve_reset`]). The
//!   platform refuses the whole entry when a folder on the way is a link.
//! - (Review) **The cleanup is owed** from the moment an employee signs in until a
//!   complete clean round: [`CleanupGate`] keeps that in memory and in the agent's
//!   protected state (`cleanup-owed.json`), so a reboot, power loss, crash or
//!   restart before the round does not let the next employee in on a dirty
//!   profile. A service that starts with the marker runs the rounds at once.
//! - (Review) After a session ends: a full round [`CleanupTimings::delay`] later,
//!   and **always a second full round** [`CleanupTimings::second_after`] after the
//!   first (the protocol has no "apps are closed" confirmation from the Staff App,
//!   and for sessions the agent ends itself the Staff App closes the apps only when
//!   it gets `session.ended`, then waits up to 5 s and kills their jobs). The
//!   marker is cleared only by a clean second (or later) round; a folder still in
//!   use, a folder whose deletion took too long, or a profile that could not be
//!   read keep it, and a full round runs again every
//!   [`CleanupTimings::retry_every`] (or at once when a sign-in is waiting).
//! - (Review) **Sign-in and cleanup exclude each other** ([`CleanupGate`]): a
//!   sign-in waits (bounded) and then fails with a retryable `busy` while the
//!   cleanup is owed or a deletion is running; a round never starts a folder while
//!   a sign-in is in progress or an employee is signed in.
//! - (Review) **Watchdog**: one folder may take [`CleanupTimings::folder_timeout`];
//!   then it is cancelled (between entries), left to finish in the background and
//!   counted as in use. The loop keeps handling requests while a round runs.
//! - (Review) The Staff profile folder is read again from Windows at every round.
//! - One folder failing never stops the others. A refusal (a link, a
//!   case-sensitive folder) or another error is logged and not retried: it would
//!   fail the same way, so it does not keep the marker (owner decision pending).
//!   Logged with the template only: never a file name.
//!
//! The deletion itself is `Platform::reset_folder` (mutating, guarded): on the dev
//! machine `WindowsPlatform` refuses it, the tests use `SimPlatform`.

use std::collections::HashSet;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rulebox_policy::catalog::{CatalogApp, CatalogKind};
use rulebox_policy::paths::{reset_folder_parts, MAX_RESET_FOLDERS};
use tokio::sync::{mpsc, watch, Notify};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use crate::agent_policy::AgentPolicy;
use crate::installs::plain_absolute;
use crate::platform::{Platform, PlatformError, ResetOutcome};
use crate::state::{lock, write_atomic};

/// At most this many folders per round (bounded work whatever the catalogue holds;
/// the server allows 20 per app).
pub const MAX_RESETS_PER_ROUND: usize = 500;
/// (Review) How long a sign-in waits for the cleanup before it answers `busy`
/// (retryable). Short: the sign-in has its own 8 s budget and the Staff App's
/// request times out after 10 s.
pub const SIGN_IN_CLEANUP_WAIT: Duration = Duration::from_millis(1_500);

/// The cleanup's timings; tests may change them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CleanupTimings {
    /// The first round, after the latest end of a session (plan item 2: 3 s).
    pub delay: Duration,
    /// The second full round, after the first one ended (review: apps the Staff
    /// App closes only on `session.ended` are killed by then).
    pub second_after: Duration,
    /// While the cleanup stays owed (something in use), a full round this often.
    pub retry_every: Duration,
    /// One folder's watchdog.
    pub folder_timeout: Duration,
}

impl Default for CleanupTimings {
    fn default() -> Self {
        Self {
            delay: Duration::from_secs(3),
            second_after: Duration::from_secs(10),
            retry_every: Duration::from_secs(30),
            folder_timeout: Duration::from_secs(60),
        }
    }
}

/// Where one reset folder resolves to: every folder from the Staff profile down to
/// the target, in order (`<profile>`, `<profile>\AppData`, `...\Local`, then one
/// per component). The last one is the folder to delete.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResetTarget {
    pub chain: Vec<PathBuf>,
    /// (Review) The components below the profile: `AppData`, `Local`/`Roaming`,
    /// then the template's (each a single checked name).
    pub components: Vec<String>,
}

impl ResetTarget {
    /// The folder to delete (always below `AppData\Local` or `AppData\Roaming`).
    pub fn target(&self) -> &Path {
        self.chain.last().map_or(Path::new(""), PathBuf::as_path)
    }
}

/// Checks `template` again (the signed document was checked by the server; this is
/// defence in depth) and resolves it below `profile_dir`. Refused: a template that
/// breaks the rules (`..`, an absolute path, an unknown token, a denied folder...)
/// or a profile path that is not plain and absolute. Pure: no I/O.
pub fn resolve_reset(profile_dir: &Path, template: &str) -> Result<ResetTarget, PlatformError> {
    let (base, parts) =
        reset_folder_parts(template).map_err(|_| PlatformError::Refused("the folder template breaks the rules"))?;
    if !plain_absolute(profile_dir) {
        return Err(PlatformError::Refused("the Staff profile path is not a plain absolute path"));
    }
    let mut chain = Vec::with_capacity(parts.len() + 3);
    let mut components = Vec::with_capacity(parts.len() + 2);
    let mut path = profile_dir.to_path_buf();
    chain.push(path.clone());
    for part in ["AppData", base.app_data_folder()].into_iter().chain(parts) {
        path.push(part);
        chain.push(path.clone());
        components.push(part.to_string());
    }
    Ok(ResetTarget { chain, components })
}

/// The `resetFolders` of every desktop app of `catalog`, in catalogue order, each
/// once (Windows paths ignore case), at most [`MAX_RESET_FOLDERS`] per app and
/// [`MAX_RESETS_PER_ROUND`] in all.
pub fn reset_templates(catalog: &[CatalogApp]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut templates = Vec::new();
    for app in catalog {
        if app.kind != CatalogKind::Desktop {
            continue;
        }
        let Some(desktop) = &app.desktop else {
            continue;
        };
        if desktop.reset_folders.len() > MAX_RESET_FOLDERS {
            tracing::warn!(app = %app.id, "more reset folders than allowed; only the first {MAX_RESET_FOLDERS} are used");
        }
        for template in desktop.reset_folders.iter().take(MAX_RESET_FOLDERS) {
            if templates.len() >= MAX_RESETS_PER_ROUND {
                tracing::warn!("more reset folders than one cleanup round takes; the rest are skipped");
                return templates;
            }
            if seen.insert(template.to_lowercase()) {
                templates.push(template.clone());
            }
        }
    }
    templates
}

/// (Review, finding 6) Whether a `User Shell Folders` value (already expanded) is
/// the default `<profile>\AppData\<sub>`. `RegGetValueW` expands `%USERPROFILE%`
/// with the reading process's profile, so the service's own profile counts as the
/// default too. Case and a trailing `\` are ignored.
pub fn shell_folder_is_default(value: &str, staff_profile: &Path, service_profile: Option<&Path>, sub: &str) -> bool {
    let norm = |text: &str| text.trim().trim_end_matches('\\').to_ascii_lowercase();
    let value = norm(value);
    let default_below = |base: &str| norm(&format!(r"{base}\AppData\{sub}"));
    value == default_below(&staff_profile.to_string_lossy())
        || service_profile.is_some_and(|profile| value == default_below(&profile.to_string_lossy()))
        || value == default_below("%USERPROFILE%")
}

// -- the gate between sign-in and cleanup (review findings 2 and 3) ------------------

/// What the session layer tells the cleanup task.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CleanupRequest {
    /// An employee session ended.
    SessionEnded,
    /// A sign-in is waiting for the cleanup: run a round now if one could clear it.
    Nudge,
}

#[derive(Debug, Default)]
struct GateState {
    owed: bool,
    /// Folder deletions running (including ones the watchdog gave up waiting for).
    deleting: usize,
    signing_in: bool,
}

/// (Review) The cleanup's shared state: whether a cleanup is owed (persisted),
/// whether a deletion is running, whether a sign-in is in progress.
pub struct CleanupGate {
    state: Mutex<GateState>,
    changed: Notify,
    /// `cleanup-owed.json`; `None` in tests that keep it in memory.
    marker: Option<PathBuf>,
    requests: Mutex<Option<mpsc::UnboundedSender<CleanupRequest>>>,
}

impl CleanupGate {
    /// Reads the marker. Anything but "the file does not exist" counts as owed
    /// (fail closed).
    pub fn open(marker: PathBuf) -> Arc<Self> {
        let owed = match std::fs::symlink_metadata(&marker) {
            Ok(_) => true,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
            Err(error) => {
                tracing::error!("cannot read the session cleanup marker ({error}); a cleanup is assumed owed");
                true
            }
        };
        Self::new(Some(marker), owed)
    }

    /// Memory only (tests).
    #[cfg(test)]
    pub fn in_memory(owed: bool) -> Arc<Self> {
        Self::new(None, owed)
    }

    fn new(marker: Option<PathBuf>, owed: bool) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(GateState { owed, ..GateState::default() }),
            changed: Notify::new(),
            marker,
            requests: Mutex::new(None),
        })
    }

    /// Where requests go (the cleanup task).
    pub fn set_requests(&self, tx: mpsc::UnboundedSender<CleanupRequest>) {
        *lock(&self.requests) = Some(tx);
    }

    fn send(&self, request: CleanupRequest) {
        if let Some(tx) = lock(&self.requests).as_ref() {
            let _ = tx.send(request);
        }
    }

    /// An employee session ended.
    pub fn session_ended(&self) {
        self.send(CleanupRequest::SessionEnded);
    }

    pub fn is_owed(&self) -> bool {
        lock(&self.state).owed
    }

    /// An employee session is starting: the cleanup is owed from now on, also
    /// across a restart (atomic write). A write failure is logged; the memory
    /// state still protects this run.
    pub fn mark_owed(&self) {
        lock(&self.state).owed = true;
        if let Some(marker) = &self.marker {
            let written = marker
                .parent()
                .map_or(Ok(()), std::fs::create_dir_all)
                .and_then(|()| write_atomic(marker, b"{\"owed\":true}\n"));
            if let Err(error) = written {
                tracing::error!("cannot save the session cleanup marker ({error}); a restart before the cleanup would skip it");
            }
        }
    }

    /// A complete clean round: the next employee may sign in.
    fn clear_owed(&self) {
        lock(&self.state).owed = false;
        if let Some(marker) = &self.marker {
            match std::fs::remove_file(marker) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                // Harmless: the next start runs one more round.
                Err(error) => tracing::warn!("cannot delete the session cleanup marker ({error})"),
            }
        }
        self.changed.notify_waiters();
    }

    /// Tests outside this module play the cleanup task's clean round.
    #[cfg(test)]
    pub fn clear_owed_for_test(&self) {
        self.clear_owed();
    }

    /// A sign-in asks to start. Allowed when no deletion runs, no other sign-in is
    /// in progress, and no cleanup is owed (an employee already signed in, who may
    /// sign in again, is fine: nothing is deleted while they are). Waits at most
    /// `wait`, asking the cleanup task for a round; `None` = still not allowed.
    pub async fn enter_sign_in(self: &Arc<Self>, session_active: bool, wait: Duration) -> Option<SignInPermit> {
        let deadline = Instant::now() + wait;
        let mut nudged = false;
        loop {
            let notified = self.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let blocked_by_owed = {
                let mut state = lock(&self.state);
                let blocked_by_owed = state.owed && !session_active;
                if !blocked_by_owed && state.deleting == 0 && !state.signing_in {
                    state.signing_in = true;
                    return Some(SignInPermit(Arc::clone(self)));
                }
                blocked_by_owed
            };
            if blocked_by_owed && !nudged {
                nudged = true;
                self.send(CleanupRequest::Nudge);
            }
            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                return None;
            }
        }
    }

    /// A round asks to delete one folder: refused while a sign-in is in progress
    /// or `session_active()` (asked under the gate's lock, so a sign-in cannot slip
    /// in between).
    pub fn begin_delete(self: &Arc<Self>, session_active: &dyn Fn() -> bool) -> Option<DeletePermit> {
        let mut state = lock(&self.state);
        if state.signing_in || session_active() {
            return None;
        }
        state.deleting += 1;
        Some(DeletePermit(Arc::clone(self)))
    }
}

/// A sign-in in progress; dropped when the sign-in is over (the session, if any,
/// is set by then).
pub struct SignInPermit(Arc<CleanupGate>);

impl Drop for SignInPermit {
    fn drop(&mut self) {
        lock(&self.0.state).signing_in = false;
        self.0.changed.notify_waiters();
    }
}

/// One folder deletion running. Moved into the blocking task: a deletion the
/// watchdog stopped waiting for still holds it until it really ends.
pub struct DeletePermit(Arc<CleanupGate>);

impl Drop for DeletePermit {
    fn drop(&mut self) {
        {
            let mut state = lock(&self.0.state);
            state.deleting = state.deleting.saturating_sub(1);
        }
        self.0.changed.notify_waiters();
    }
}

// -- the cleanup task ------------------------------------------------------------------

/// The Staff account as the agent's state has it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StaffRef {
    pub sid: String,
    /// The profile folder saved at setup (compared with what Windows says now).
    pub saved_profile: Option<PathBuf>,
}

/// What the cleanup task needs.
pub struct CleanupDeps {
    pub platform: Arc<dyn Platform>,
    /// The current catalogue (`AgentPolicy::catalog`), read when a round starts.
    pub policy_rx: watch::Receiver<AgentPolicy>,
    /// The Staff account; `None` while it is not set up.
    pub staff: Arc<dyn Fn() -> Option<StaffRef> + Send + Sync>,
    /// Whether an employee is signed in (then nothing is deleted).
    pub session_active: Arc<dyn Fn() -> bool + Send + Sync>,
    pub gate: Arc<CleanupGate>,
    pub timings: CleanupTimings,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Stage {
    /// [`CleanupTimings::delay`] after a session ended (or at start).
    First,
    /// [`CleanupTimings::second_after`] after the first.
    Second,
    /// While still owed.
    Retry,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RoundEnd {
    /// Every folder reset, absent or refused for good.
    Clean,
    /// Something stays (in use, too slow, the profile not readable).
    Dirty,
    /// Stopped: an employee is signing in or signed in, or the agent is stopping.
    Stopped,
}

type RoundFuture = Pin<Box<dyn Future<Output = RoundEnd> + Send>>;

/// The cleanup task. See the module documentation for the schedule.
pub async fn run_cleanup(
    deps: CleanupDeps,
    mut requests: mpsc::UnboundedReceiver<CleanupRequest>,
    shutdown: CancellationToken,
) {
    let deps = Arc::new(deps);
    let in_flight: Arc<Mutex<HashSet<String>>> = Arc::default();
    let mut next: Option<(Instant, Stage)> = None;
    if deps.gate.is_owed() {
        tracing::info!("session cleanup owed from before the agent started; the rounds run before the next sign-in");
        next = Some((Instant::now() + deps.timings.delay, Stage::First));
    }
    let mut round: Option<(Stage, RoundFuture)> = None;
    let mut open = true;
    loop {
        let due = if round.is_none() { next.map(|(at, _)| at) } else { None };
        let timer = async move {
            match due {
                Some(at) => tokio::time::sleep_until(at).await,
                None => std::future::pending::<()>().await,
            }
        };
        let running = async {
            match round.as_mut() {
                Some((_, future)) => future.await,
                None => std::future::pending::<RoundEnd>().await,
            }
        };
        tokio::select! {
            () = shutdown.cancelled() => return,
            request = requests.recv(), if open => match request {
                // A newer end of session: both rounds again (after any running one).
                Some(CleanupRequest::SessionEnded) => {
                    next = Some((Instant::now() + deps.timings.delay, Stage::First));
                }
                // A sign-in waits: a round that could clear the marker runs now,
                // unless one is running or the two rounds after a session end are
                // still to come.
                Some(CleanupRequest::Nudge) => {
                    let early = matches!(next, Some((_, Stage::First | Stage::Second)));
                    if deps.gate.is_owed() && round.is_none() && !early {
                        next = Some((Instant::now(), Stage::Retry));
                    }
                }
                None => open = false,
            },
            end = running => {
                let Some((stage, _)) = round.take() else {
                    continue;
                };
                // A request that arrived meanwhile already set `next`: it wins.
                if next.is_some() || end == RoundEnd::Stopped {
                    continue;
                }
                match (stage, end) {
                    (Stage::First, _) => next = Some((Instant::now() + deps.timings.second_after, Stage::Second)),
                    (_, RoundEnd::Clean) => {
                        deps.gate.clear_owed();
                        tracing::info!("session cleanup complete");
                    }
                    (_, _) => {
                        tracing::warn!(
                            "session cleanup not complete (a folder is in use or took too long); tried again in {} s, sign-in waits",
                            deps.timings.retry_every.as_secs()
                        );
                        next = Some((Instant::now() + deps.timings.retry_every, Stage::Retry));
                    }
                }
            },
            () = timer => {
                if let Some((_, stage)) = next.take() {
                    let future = run_round(Arc::clone(&deps), Arc::clone(&in_flight), shutdown.child_token());
                    round = Some((stage, Box::pin(future)));
                }
            },
        }
    }
}

/// Removes its template from the in-flight set when the blocking work really ends.
struct InFlight {
    set: Arc<Mutex<HashSet<String>>>,
    template: String,
}

impl Drop for InFlight {
    fn drop(&mut self) {
        lock(&self.set).remove(&self.template);
    }
}

/// One full round: every catalogue app's folders, one at a time.
async fn run_round(deps: Arc<CleanupDeps>, in_flight: Arc<Mutex<HashSet<String>>>, cancel: CancellationToken) -> RoundEnd {
    let templates = reset_templates(&deps.policy_rx.borrow().catalog);
    let Some(staff) = (deps.staff)() else {
        tracing::info!("session cleanup: no Staff account; nothing to reset");
        return RoundEnd::Clean;
    };
    // (Review, finding 8) Where Windows says the profile is now.
    let profile = match deps.platform.staff_profile_dir(&staff.sid) {
        Ok(Some(dir)) => dir,
        Ok(None) => {
            tracing::info!("session cleanup: the Staff account has no profile; nothing to reset");
            return RoundEnd::Clean;
        }
        Err(error) => {
            tracing::warn!(%error, "session cleanup: cannot read the Staff profile folder; tried again later");
            return RoundEnd::Dirty;
        }
    };
    let moved = staff
        .saved_profile
        .as_ref()
        .is_some_and(|saved| !saved.to_string_lossy().eq_ignore_ascii_case(&profile.to_string_lossy()));
    if moved {
        tracing::warn!("session cleanup: the Staff profile folder is not the one saved at setup; using the one Windows reports");
    }
    if templates.is_empty() {
        return RoundEnd::Clean;
    }
    // (Review, finding 6) Apps follow the shell folders; the cleanup does not.
    match deps.platform.staff_app_data_redirected(&staff.sid, &profile) {
        Ok(Some(true)) => tracing::warn!(
            "session cleanup: the Staff account's AppData folders are redirected; only the default location is reset"
        ),
        Ok(_) => {}
        Err(error) => tracing::debug!(%error, "session cleanup: cannot read the Staff shell folders"),
    }
    let mut clean = true;
    for template in templates {
        if cancel.is_cancelled() {
            return RoundEnd::Stopped;
        }
        if lock(&in_flight).contains(&template) {
            // An earlier deletion of it is still running (the watchdog gave up).
            clean = false;
            continue;
        }
        // Never during a sign-in or a session (asked before every folder).
        let Some(permit) = deps.gate.begin_delete(&*deps.session_active) else {
            tracing::info!("session cleanup stopped: an employee is signing in or signed in");
            return RoundEnd::Stopped;
        };
        lock(&in_flight).insert(template.clone());
        let job = InFlight { set: Arc::clone(&in_flight), template: template.clone() };
        let job_cancel = cancel.child_token();
        let (platform, dir, name, token) = (Arc::clone(&deps.platform), profile.clone(), template.clone(), job_cancel.clone());
        let handle = tokio::task::spawn_blocking(move || {
            let _held = (permit, job);
            platform.reset_folder(&dir, &name, &token)
        });
        match tokio::time::timeout(deps.timings.folder_timeout, handle).await {
            Ok(Ok(Ok(ResetOutcome::Removed))) => tracing::info!(template = %template, "session cleanup: folder reset"),
            Ok(Ok(Ok(ResetOutcome::Absent))) => {
                tracing::debug!(template = %template, "session cleanup: nothing to reset");
            }
            Ok(Ok(Ok(ResetOutcome::InUse) | Err(PlatformError::InUse))) => {
                tracing::info!(template = %template, "session cleanup: folder in use");
                clean = false;
            }
            // A refusal or another error: logged, not retried (it would fail again).
            Ok(Ok(Err(error))) => tracing::warn!(template = %template, %error, "session cleanup: folder not reset"),
            Ok(Err(_)) => {
                tracing::warn!(template = %template, "session cleanup: the reset task failed");
                clean = false;
            }
            Err(_) => {
                // The watchdog: stop it between entries; whatever it is stuck in
                // finishes in the background (it keeps its handles and its
                // deletion permit until then).
                job_cancel.cancel();
                tracing::warn!(
                    template = %template,
                    "session cleanup: folder took longer than {} s; stopped and counted as in use",
                    deps.timings.folder_timeout.as_secs()
                );
                clean = false;
            }
        }
    }
    if clean {
        RoundEnd::Clean
    } else {
        RoundEnd::Dirty
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::sync::atomic::{AtomicBool, Ordering};

    use serde_json::json;

    use crate::platform::sim::{SimHang, SimOp, SimPlatform};
    use crate::testutil::TempDir;

    const PROFILE: &str = r"C:\Users\RuleboxStaff";
    const SID: &str = "S-1-5-21-1000-2000-3000-2001";

    fn p(text: &str) -> PathBuf {
        PathBuf::from(text)
    }

    fn never() -> CancellationToken {
        CancellationToken::new()
    }

    fn app(id: &str, kind: &str, reset: &[&str]) -> CatalogApp {
        let desktop = if kind == "desktop" {
            json!({ "exe": r"{ProgramFiles}\X\x.exe", "args": [], "fileArgTemplate": [], "install": null, "resetFolders": reset })
        } else {
            serde_json::Value::Null
        };
        // A web app's `web` part plays no role here.
        serde_json::from_value(json!({
            "id": id, "name": id, "description": null, "kind": kind, "builtin": null, "web": null,
            "desktop": desktop, "pinnedTaskbar": false, "pinnedDesktop": false, "hue": null, "icon": null,
            "audience": "everyone", "employeeIds": [], "revision": 1
        }))
        .unwrap()
    }

    // -- template resolution --------------------------------------------------------

    #[test]
    fn templates_resolve_inside_the_staff_profile_app_data() {
        let local = resolve_reset(&p(PROFILE), r"{LocalAppData}\VideoLAN").unwrap();
        assert_eq!(
            local.chain,
            vec![
                p(PROFILE),
                p(r"C:\Users\RuleboxStaff\AppData"),
                p(r"C:\Users\RuleboxStaff\AppData\Local"),
                p(r"C:\Users\RuleboxStaff\AppData\Local\VideoLAN"),
            ]
        );
        assert_eq!(local.components, ["AppData", "Local", "VideoLAN"]);
        let roaming = resolve_reset(&p(PROFILE), r"{RoamingAppData}\vlc\cache").unwrap();
        assert_eq!(roaming.target(), p(r"C:\Users\RuleboxStaff\AppData\Roaming\vlc\cache"));
        assert_eq!(roaming.chain.len(), 5);
        assert_eq!(roaming.components, ["AppData", "Roaming", "vlc", "cache"]);
        for target in [local.target(), roaming.target()] {
            assert!(target.starts_with(r"C:\Users\RuleboxStaff\AppData"));
        }
    }

    #[test]
    fn bad_templates_and_profiles_are_refused() {
        for template in [
            r"{LocalAppData}\..\x",
            r"{LocalAppData}\a\..\..\..\Windows",
            r"{LocalAppData}\",
            r"C:\Windows\System32",
            r"\\server\share",
            r"{ProgramFiles}\x",
            r"{UserProfile}\x",
            r"{LocalAppData}\a\b\c\d\e\f\g",
            r"{LocalAppData}\a:b",
            // (Review) The deny list.
            r"{RoamingAppData}\Microsoft",
            r"{RoamingAppData}\Microsoft\Protect",
            r"{LocalAppData}\Microsoft\Credentials",
            r"{LocalAppData}\microsoft\windows\Explorer",
            r"{LocalAppData}\dev.rulebox.staff\EBWebView",
            r"{LocalAppData}\Rulebox",
        ] {
            let refused = resolve_reset(&p(PROFILE), template);
            assert!(matches!(refused, Err(PlatformError::Refused(_))), "{template}: {refused:?}");
        }
        for profile in [r"Users\RuleboxStaff", r"C:\Users\..\Windows", r"\\server\share\x", r"\\?\C:\Users\x", "C:/Users/x"] {
            let refused = resolve_reset(&p(profile), r"{LocalAppData}\x");
            assert!(matches!(refused, Err(PlatformError::Refused(_))), "{profile}: {refused:?}");
        }
        // The refusal text never quotes the value.
        let Err(error) = resolve_reset(&p(PROFILE), r"{LocalAppData}\..\secret-name") else { panic!() };
        assert!(!error.to_string().contains("secret-name"));
    }

    #[test]
    fn every_desktop_app_counts_once_per_folder() {
        let many: Vec<String> = (0..25).map(|i| format!(r"{{LocalAppData}}\f{i}")).collect();
        let many_refs: Vec<&str> = many.iter().map(String::as_str).collect();
        let catalog = vec![
            app("a", "desktop", &[r"{LocalAppData}\Acme", r"{RoamingAppData}\Acme"]),
            app("w", "web", &[]),
            app("b", "desktop", &[r"{localappdata}\x", r"{LocalAppData}\ACME"]),
            app("c", "desktop", &many_refs),
        ];
        let templates = reset_templates(&catalog);
        assert_eq!(&templates[..3], &[r"{LocalAppData}\Acme", r"{RoamingAppData}\Acme", r"{localappdata}\x"]);
        // The 25-folder app is cut at 20.
        assert_eq!(templates.len(), 3 + MAX_RESET_FOLDERS);
        assert!(!templates.iter().any(|t| t == r"{LocalAppData}\f20"));
    }

    #[test]
    fn shell_folders_at_the_default_place_are_not_redirected() {
        let staff = p(PROFILE);
        let service = p(r"C:\WINDOWS\system32\config\systemprofile");
        for value in [
            r"C:\Users\RuleboxStaff\AppData\Local",
            r"c:\users\ruleboxstaff\appdata\local\",
            r"C:\WINDOWS\system32\config\systemprofile\AppData\Local",
            r"%USERPROFILE%\AppData\Local",
        ] {
            assert!(shell_folder_is_default(value, &staff, Some(&service), "Local"), "{value}");
        }
        for value in [r"D:\Elsewhere\Local", r"C:\Users\RuleboxStaff\AppData\Roaming", r"\\server\share\AppData\Local"] {
            assert!(!shell_folder_is_default(value, &staff, Some(&service), "Local"), "{value}");
        }
    }

    // -- SimPlatform::reset_folder ----------------------------------------------------

    /// A Staff profile with two apps' folders and one file outside AppData.
    fn sim_with_profile() -> (TempDir, Arc<SimPlatform>) {
        let dir = TempDir::new();
        let sim = Arc::new(SimPlatform::new(dir.path().to_path_buf()));
        sim.with_world(|w| {
            for d in [
                PROFILE,
                r"C:\Users\RuleboxStaff\AppData",
                r"C:\Users\RuleboxStaff\AppData\Local",
                r"C:\Users\RuleboxStaff\AppData\Roaming",
            ] {
                w.dirs.insert(p(d));
            }
            for f in [
                r"C:\Users\RuleboxStaff\AppData\Local\Acme\login.json",
                r"C:\Users\RuleboxStaff\AppData\Local\Acme\cache\a.bin",
                r"C:\Users\RuleboxStaff\AppData\Roaming\Writer\profile.db",
                r"C:\Users\RuleboxStaff\AppData\Local\Other\keep.txt",
                r"C:\Users\RuleboxStaff\RuleboxFiles\emp_1\doc.txt",
                r"C:\Windows\System32\important.dll",
            ] {
                w.files.insert(p(f));
            }
            w.profile_dirs.insert(SID.into(), p(PROFILE));
        });
        (dir, sim)
    }

    fn has(sim: &SimPlatform, file: &str) -> bool {
        sim.with_world(|w| w.files.contains(&p(file)))
    }

    #[test]
    fn sim_reset_removes_the_folder_and_nothing_else() {
        let (_dir, sim) = sim_with_profile();
        assert_eq!(sim.reset_folder(&p(PROFILE), r"{LocalAppData}\Acme", &never()).unwrap(), ResetOutcome::Removed);
        assert!(!has(&sim, r"C:\Users\RuleboxStaff\AppData\Local\Acme\login.json"));
        assert!(!has(&sim, r"C:\Users\RuleboxStaff\AppData\Local\Acme\cache\a.bin"));
        assert!(has(&sim, r"C:\Users\RuleboxStaff\AppData\Local\Other\keep.txt"));
        assert!(has(&sim, r"C:\Users\RuleboxStaff\AppData\Roaming\Writer\profile.db"));
        assert!(has(&sim, r"C:\Users\RuleboxStaff\RuleboxFiles\emp_1\doc.txt"));
        // Gone: a second reset finds nothing.
        assert_eq!(sim.reset_folder(&p(PROFILE), r"{LocalAppData}\Acme", &never()).unwrap(), ResetOutcome::Absent);
        assert_eq!(
            sim.reset_folder(&p(PROFILE), r"{RoamingAppData}\Nope\deeper", &never()).unwrap(),
            ResetOutcome::Absent
        );
        assert_eq!(
            sim.reset_folder(&p(r"C:\Users\Missing"), r"{LocalAppData}\Acme", &never()).unwrap(),
            ResetOutcome::Absent
        );
        assert!(sim.calls().iter().all(|op| *op == SimOp::ResetFolder));
        assert!(SimOp::ResetFolder.is_mutating());
        assert!(!SimOp::StaffProfileDir.is_mutating() && !SimOp::AppDataRedirected.is_mutating());
    }

    #[test]
    fn sim_reset_refuses_bad_templates_without_deleting() {
        let (_dir, sim) = sim_with_profile();
        let before = sim.with_world(|w| w.files.clone());
        for template in [
            r"{LocalAppData}\..\..\..\Windows",
            r"C:\Windows\System32",
            r"{SystemRoot}\System32",
            r"{LocalAppData}",
            r"{RoamingAppData}\Microsoft\Protect",
        ] {
            assert!(
                matches!(sim.reset_folder(&p(PROFILE), template, &never()), Err(PlatformError::Refused(_))),
                "{template}"
            );
        }
        assert_eq!(sim.with_world(|w| w.files.clone()), before);
    }

    #[test]
    fn a_reparse_point_at_any_level_is_refused() {
        let levels = [
            PROFILE,
            r"C:\Users\RuleboxStaff\AppData",
            r"C:\Users\RuleboxStaff\AppData\Local",
            r"C:\Users\RuleboxStaff\AppData\Local\Acme",
            r"C:\Users\RuleboxStaff\AppData\Local\Acme\cache",
        ];
        for level in levels {
            let (_dir, sim) = sim_with_profile();
            sim.with_world(|w| w.reparse_points.insert(p(level)));
            let before = sim.with_world(|w| w.files.clone());
            let refused = sim.reset_folder(&p(PROFILE), r"{LocalAppData}\Acme\cache", &never());
            assert!(matches!(refused, Err(PlatformError::Refused(_))), "{level}: {refused:?}");
            assert_eq!(sim.with_world(|w| w.files.clone()), before, "{level}: nothing deleted");
        }
    }

    #[test]
    fn a_link_inside_the_folder_is_removed_not_followed() {
        let (_dir, sim) = sim_with_profile();
        // `Acme\escape` is a junction (planted by the Staff account) to System32: the
        // link goes, what it points to stays.
        sim.with_world(|w| w.reparse_points.insert(p(r"C:\Users\RuleboxStaff\AppData\Local\Acme\escape")));
        assert_eq!(sim.reset_folder(&p(PROFILE), r"{LocalAppData}\Acme", &never()).unwrap(), ResetOutcome::Removed);
        assert!(sim.with_world(|w| w.reparse_points.is_empty()));
        assert!(has(&sim, r"C:\Windows\System32\important.dll"));
    }

    #[test]
    fn an_open_file_gives_in_use_and_the_rest_stays_deleted() {
        let (_dir, sim) = sim_with_profile();
        let open = r"C:\Users\RuleboxStaff\AppData\Local\Acme\login.json";
        sim.with_world(|w| w.open_files.insert(p(open)));
        assert_eq!(sim.reset_folder(&p(PROFILE), r"{LocalAppData}\Acme", &never()).unwrap(), ResetOutcome::InUse);
        assert!(has(&sim, open));
        assert!(!has(&sim, r"C:\Users\RuleboxStaff\AppData\Local\Acme\cache\a.bin"));
        // Closed: the next try removes the rest.
        sim.with_world(|w| w.open_files.clear());
        assert_eq!(sim.reset_folder(&p(PROFILE), r"{LocalAppData}\Acme", &never()).unwrap(), ResetOutcome::Removed);
        assert!(!has(&sim, open));
    }

    // -- the gate -------------------------------------------------------------------

    #[test]
    fn the_owed_marker_survives_a_restart_and_fails_closed() {
        let dir = TempDir::new();
        let marker = dir.path().join("state").join("cleanup-owed.json");
        let gate = CleanupGate::open(marker.clone());
        assert!(!gate.is_owed());
        gate.mark_owed();
        assert!(marker.is_file());
        drop(gate);
        // "Restart": owed again from the file.
        let gate = CleanupGate::open(marker.clone());
        assert!(gate.is_owed());
        gate.clear_owed();
        assert!(!marker.exists());
        assert!(!CleanupGate::open(marker.clone()).is_owed());
        // Anything there (even not a valid file) counts as owed.
        std::fs::write(&marker, b"garbage").unwrap();
        assert!(CleanupGate::open(marker).is_owed());
    }

    #[tokio::test(start_paused = true)]
    async fn an_owed_cleanup_blocks_a_sign_in_until_it_is_cleared() {
        let gate = CleanupGate::in_memory(true);
        let (tx, mut rx) = mpsc::unbounded_channel();
        gate.set_requests(tx);
        assert!(gate.enter_sign_in(false, SIGN_IN_CLEANUP_WAIT).await.is_none());
        // The cleanup task was asked for a round (once per attempt).
        assert_eq!(rx.try_recv().ok(), Some(CleanupRequest::Nudge));
        assert!(rx.try_recv().is_err());
        // The signed-in employee may sign in again (nothing is deleted meanwhile).
        assert!(gate.enter_sign_in(true, SIGN_IN_CLEANUP_WAIT).await.is_some());
        // Cleared while a sign-in waits: it goes ahead.
        let waiting = {
            let gate = Arc::clone(&gate);
            tokio::spawn(async move { gate.enter_sign_in(false, SIGN_IN_CLEANUP_WAIT).await.is_some() })
        };
        tokio::time::sleep(Duration::from_millis(500)).await;
        gate.clear_owed();
        assert!(waiting.await.unwrap());
    }

    #[tokio::test(start_paused = true)]
    async fn sign_in_and_deletion_exclude_each_other() {
        let gate = CleanupGate::in_memory(false);
        let inactive = || false;
        // A deletion runs: a sign-in waits, then gives up...
        let deleting = gate.begin_delete(&inactive).unwrap();
        assert!(gate.enter_sign_in(false, SIGN_IN_CLEANUP_WAIT).await.is_none());
        // ...or goes ahead as soon as it ends.
        let waiting = {
            let gate = Arc::clone(&gate);
            tokio::spawn(async move { gate.enter_sign_in(false, SIGN_IN_CLEANUP_WAIT).await })
        };
        tokio::time::sleep(Duration::from_millis(300)).await;
        drop(deleting);
        let permit = waiting.await.unwrap().expect("signed in after the deletion");
        // A sign-in in progress: no deletion starts; nor while a session is active.
        assert!(gate.begin_delete(&inactive).is_none());
        drop(permit);
        assert!(gate.begin_delete(&|| true).is_none());
        assert!(gate.begin_delete(&inactive).is_some());
        // Two sign-ins never overlap either.
        let first = gate.enter_sign_in(false, Duration::ZERO).await.unwrap();
        assert!(gate.enter_sign_in(false, Duration::ZERO).await.is_none());
        drop(first);
    }

    // -- the cleanup task -------------------------------------------------------------

    struct Rig {
        _dir: TempDir,
        sim: Arc<SimPlatform>,
        gate: Arc<CleanupGate>,
        marker: PathBuf,
        active: Arc<AtomicBool>,
        policy_tx: watch::Sender<AgentPolicy>,
        shutdown: CancellationToken,
    }

    fn timings() -> CleanupTimings {
        CleanupTimings::default()
    }

    fn rig_with(staff: Option<StaffRef>, owed_before_start: bool) -> Rig {
        let (dir, sim) = sim_with_profile();
        let policy = AgentPolicy {
            has_document: true,
            catalog: vec![
                app("a", "desktop", &[r"{LocalAppData}\Acme"]),
                app("w", "web", &[]),
                app("b", "desktop", &[r"{RoamingAppData}\Writer", r"{LocalAppData}\NotThere"]),
            ],
            ..AgentPolicy::default()
        };
        let (policy_tx, policy_rx) = watch::channel(policy);
        let active = Arc::new(AtomicBool::new(false));
        let marker = dir.path().join("state").join("cleanup-owed.json");
        if owed_before_start {
            CleanupGate::open(marker.clone()).mark_owed();
        }
        let gate = CleanupGate::open(marker.clone());
        let (tx, rx) = mpsc::unbounded_channel();
        gate.set_requests(tx);
        let shutdown = CancellationToken::new();
        let deps = CleanupDeps {
            platform: Arc::clone(&sim) as Arc<dyn Platform>,
            policy_rx,
            staff: Arc::new(move || staff.clone()),
            session_active: {
                let active = Arc::clone(&active);
                Arc::new(move || active.load(Ordering::SeqCst))
            },
            gate: Arc::clone(&gate),
            timings: timings(),
        };
        tokio::spawn(run_cleanup(deps, rx, shutdown.clone()));
        Rig { _dir: dir, sim, gate, marker, active, policy_tx, shutdown }
    }

    fn staff() -> Option<StaffRef> {
        Some(StaffRef { sid: SID.into(), saved_profile: Some(p(PROFILE)) })
    }

    fn rig() -> Rig {
        rig_with(staff(), false)
    }

    impl Rig {
        fn resets(&self) -> usize {
            self.sim.calls().iter().filter(|op| **op == SimOp::ResetFolder).count()
        }

        /// An employee signs in (the marker is written) and out again.
        fn session(&self) {
            self.gate.mark_owed();
            self.gate.session_ended();
        }

        fn owed(&self) -> bool {
            self.gate.is_owed()
        }
    }

    /// Lets the task and its blocking calls run (the clock is paused, so this only
    /// advances by `ms`).
    async fn pass(ms: u64) {
        for _ in 0..5 {
            tokio::task::yield_now().await;
        }
        tokio::time::sleep(Duration::from_millis(ms)).await;
        for _ in 0..20 {
            tokio::task::yield_now().await;
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    }

    /// Moves the paused clock by force, 50 ms at a time, letting blocking calls run
    /// in real time between steps (a blocking call in flight stops auto-advance,
    /// so a hanging reset needs this).
    async fn advance(ms: u64) {
        for _ in 0..ms / 50 {
            tokio::time::advance(Duration::from_millis(50)).await;
            for _ in 0..3 {
                tokio::task::yield_now().await;
                std::thread::sleep(Duration::from_micros(300));
            }
        }
    }

    /// Waits (real time, bounded) until `done`.
    async fn until(done: impl Fn() -> bool) {
        for _ in 0..2_000 {
            if done() {
                return;
            }
            tokio::task::yield_now().await;
            std::thread::sleep(Duration::from_millis(1));
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_session_end_runs_two_full_rounds_and_clears_the_marker_after_the_second() {
        let r = rig();
        r.session();
        assert!(r.marker.is_file());
        pass(2_500).await;
        assert_eq!(r.resets(), 0, "not before 3 seconds");
        assert!(has(&r.sim, r"C:\Users\RuleboxStaff\AppData\Local\Acme\login.json"));
        pass(1_000).await;
        assert_eq!(r.resets(), 3);
        assert!(!has(&r.sim, r"C:\Users\RuleboxStaff\AppData\Local\Acme\login.json"));
        assert!(!has(&r.sim, r"C:\Users\RuleboxStaff\AppData\Roaming\Writer\profile.db"));
        assert!(has(&r.sim, r"C:\Users\RuleboxStaff\AppData\Local\Other\keep.txt"));
        // An app the Staff App killed only now writes its state back...
        r.sim.add_file(r"C:\Users\RuleboxStaff\AppData\Local\Acme\login.json");
        assert!(r.owed() && r.marker.is_file(), "owed until the second round");
        // ...and the second full round, 10 s after the first, removes it.
        pass(9_000).await;
        assert_eq!(r.resets(), 3);
        pass(1_500).await;
        assert_eq!(r.resets(), 6);
        assert!(!has(&r.sim, r"C:\Users\RuleboxStaff\AppData\Local\Acme\login.json"));
        assert!(!r.owed() && !r.marker.exists());
        // Nothing more without another session.
        pass(120_000).await;
        assert_eq!(r.resets(), 6);
        r.shutdown.cancel();
    }

    #[tokio::test(start_paused = true)]
    async fn the_marker_survives_a_restart_and_the_rounds_run_at_start() {
        // The agent stopped (power loss) after a session; it starts with the marker.
        let r = rig_with(staff(), true);
        assert!(r.owed());
        // A sign-in now is refused (retryable) and nudges nothing early.
        assert!(r.gate.enter_sign_in(false, SIGN_IN_CLEANUP_WAIT).await.is_none());
        pass(2_000).await;
        assert_eq!(r.resets(), 3, "the first round 3 s after the start");
        assert!(r.owed());
        pass(11_000).await;
        assert_eq!(r.resets(), 6);
        assert!(!r.owed() && !r.marker.exists());
        // Now the next employee gets in.
        assert!(r.gate.enter_sign_in(false, SIGN_IN_CLEANUP_WAIT).await.is_some());
    }

    #[tokio::test(start_paused = true)]
    async fn a_folder_still_in_use_keeps_the_marker_and_is_retried_until_free() {
        let r = rig();
        let open = r"C:\Users\RuleboxStaff\AppData\Local\Acme\login.json";
        r.sim.with_world(|w| w.open_files.insert(p(open)));
        r.session();
        pass(3_500).await;
        pass(10_500).await;
        assert_eq!(r.resets(), 6, "both rounds ran");
        assert!(r.owed() && r.marker.is_file(), "in use after the second round: still owed");
        assert!(r.gate.enter_sign_in(false, SIGN_IN_CLEANUP_WAIT).await.is_none());
        // Retried every 30 s (the sign-in above asked for one at once).
        pass(500).await;
        assert_eq!(r.resets(), 9, "the waiting sign-in got a round at once");
        pass(30_500).await;
        assert_eq!(r.resets(), 12);
        assert!(r.owed());
        // The file is closed: the next retry clears it.
        r.sim.with_world(|w| w.open_files.clear());
        pass(30_500).await;
        assert_eq!(r.resets(), 15);
        assert!(!has(&r.sim, open));
        assert!(!r.owed() && !r.marker.exists());
        pass(120_000).await;
        assert_eq!(r.resets(), 15);
    }

    #[tokio::test(start_paused = true)]
    async fn the_catalogue_at_the_time_of_the_round_is_used() {
        let r = rig();
        r.session();
        r.policy_tx.send_modify(|p| p.catalog = vec![app("z", "desktop", &[r"{RoamingAppData}\Writer"])]);
        pass(3_500).await;
        assert_eq!(r.resets(), 1);
        assert!(has(&r.sim, r"C:\Users\RuleboxStaff\AppData\Local\Acme\login.json"));
        assert!(!has(&r.sim, r"C:\Users\RuleboxStaff\AppData\Roaming\Writer\profile.db"));
    }

    #[tokio::test(start_paused = true)]
    async fn nothing_is_deleted_during_a_session_or_a_sign_in() {
        let r = rig();
        r.session();
        // Someone is signed in within the 3 seconds (the same employee again).
        r.active.store(true, Ordering::SeqCst);
        pass(15_000).await;
        assert_eq!(r.resets(), 0);
        assert!(has(&r.sim, r"C:\Users\RuleboxStaff\AppData\Local\Acme\login.json"));
        assert!(r.owed(), "still owed");
        // A sign-in in progress also stops a round.
        r.active.store(false, Ordering::SeqCst);
        let signing_in = r.gate.enter_sign_in(true, Duration::ZERO).await.unwrap();
        r.gate.session_ended();
        pass(15_000).await;
        assert_eq!(r.resets(), 0);
        drop(signing_in);
        // The next end of session does it.
        r.gate.session_ended();
        pass(3_500).await;
        assert_eq!(r.resets(), 3);
        pass(10_500).await;
        assert!(!r.owed());
    }

    #[tokio::test(start_paused = true)]
    async fn the_watchdog_moves_on_from_a_folder_that_hangs_and_keeps_the_marker() {
        let r = rig();
        let release = Arc::new(AtomicBool::new(false));
        r.sim.with_world(|w| {
            w.reset_hang = Some(SimHang {
                template: r"{LocalAppData}\Acme".into(),
                honours_cancel: false,
                release: Arc::clone(&release),
            });
        });
        r.session();
        advance(3_500).await;
        until(|| r.resets() == 1).await;
        assert_eq!(r.resets(), 1, "stuck in the first folder");
        // After 60 s the round moves on (the stuck call keeps running).
        advance(60_000).await;
        until(|| r.resets() == 3).await;
        assert_eq!(r.resets(), 3);
        assert!(!has(&r.sim, r"C:\Users\RuleboxStaff\AppData\Roaming\Writer\profile.db"));
        // The second round skips the folder still being deleted: still owed, and a
        // sign-in cannot start while that deletion runs.
        advance(10_500).await;
        until(|| r.resets() == 5).await;
        assert_eq!(r.resets(), 5);
        assert!(r.owed());
        assert!(r.gate.enter_sign_in(true, Duration::ZERO).await.is_none(), "a deletion is still running");
        // It ends: the next retry resets everything and clears the marker.
        release.store(true, Ordering::SeqCst);
        r.sim.with_world(|w| w.reset_hang = None);
        let gate = Arc::clone(&r.gate);
        until(|| gate.begin_delete(&|| false).is_some()).await;
        pass(31_000).await;
        assert!(!has(&r.sim, r"C:\Users\RuleboxStaff\AppData\Local\Acme\login.json"));
        assert!(!r.owed());
    }

    #[tokio::test(start_paused = true)]
    async fn a_folder_that_honours_cancel_is_stopped_by_the_watchdog() {
        let r = rig();
        r.sim.with_world(|w| {
            w.reset_hang = Some(SimHang {
                template: r"{LocalAppData}\Acme".into(),
                honours_cancel: true,
                release: Arc::new(AtomicBool::new(false)),
            });
        });
        r.session();
        advance(3_500).await;
        until(|| r.resets() == 1).await;
        advance(60_000).await;
        until(|| r.resets() == 3).await;
        assert_eq!(r.resets(), 3);
        // Stopped (not running in the background): the deletion permit is back.
        let gate = Arc::clone(&r.gate);
        until(|| gate.begin_delete(&|| false).is_some()).await;
        assert!(r.gate.begin_delete(&|| false).is_some());
        assert!(r.owed());
    }

    #[tokio::test(start_paused = true)]
    async fn the_profile_folder_is_read_again_at_every_round() {
        let r = rig();
        // Windows now has the profile somewhere else than the saved path.
        let moved = r"C:\Users\RuleboxStaff.PC\AppData\Local\Acme\login.json";
        r.sim.with_world(|w| {
            w.profile_dirs.insert(SID.into(), p(r"C:\Users\RuleboxStaff.PC"));
            w.dirs.extend([
                p(r"C:\Users\RuleboxStaff.PC"),
                p(r"C:\Users\RuleboxStaff.PC\AppData"),
                p(r"C:\Users\RuleboxStaff.PC\AppData\Local"),
            ]);
            w.files.insert(p(moved));
        });
        r.session();
        pass(3_500).await;
        assert!(!has(&r.sim, moved), "the folder Windows reports was reset");
        assert!(has(&r.sim, r"C:\Users\RuleboxStaff\AppData\Local\Acme\login.json"), "the stale path was not used");
        assert!(r.sim.calls().contains(&SimOp::StaffProfileDir));
        assert!(r.sim.calls().contains(&SimOp::AppDataRedirected));
    }

    #[tokio::test(start_paused = true)]
    async fn a_profile_that_cannot_be_read_keeps_the_marker() {
        let r = rig();
        r.sim.fail_next(SimOp::StaffProfileDir, PlatformError::AccessDenied);
        r.sim.fail_next(SimOp::StaffProfileDir, PlatformError::AccessDenied);
        r.session();
        pass(14_500).await;
        assert_eq!(r.resets(), 0);
        assert!(r.owed());
        // Readable again: the retry does it.
        pass(30_500).await;
        assert_eq!(r.resets(), 3);
        assert!(!r.owed());
    }

    #[tokio::test(start_paused = true)]
    async fn one_refused_folder_does_not_stop_the_others_nor_keep_the_marker() {
        let r = rig();
        r.sim.fail_next(SimOp::ResetFolder, PlatformError::Refused("a folder on the way is a link"));
        r.session();
        pass(3_500).await;
        assert_eq!(r.resets(), 3);
        // The first (Acme) failed; Writer was still reset.
        assert!(has(&r.sim, r"C:\Users\RuleboxStaff\AppData\Local\Acme\login.json"));
        assert!(!has(&r.sim, r"C:\Users\RuleboxStaff\AppData\Roaming\Writer\profile.db"));
        // The second round resets Acme; refusals are not retried as such.
        pass(10_500).await;
        assert_eq!(r.resets(), 6);
        assert!(!r.owed());
    }

    #[tokio::test(start_paused = true)]
    async fn without_a_staff_account_there_is_nothing_to_reset() {
        let r = rig_with(None, true);
        pass(15_000).await;
        assert_eq!(r.resets(), 0);
        assert!(!r.owed(), "nothing to clean: cleared");
    }

    #[tokio::test(start_paused = true)]
    async fn session_ends_close_together_give_one_pair_of_rounds() {
        let r = rig();
        r.session();
        pass(1_000).await;
        r.session();
        pass(2_500).await;
        assert_eq!(r.resets(), 0, "3 seconds after the latest one");
        pass(1_000).await;
        assert_eq!(r.resets(), 3);
        pass(10_500).await;
        assert_eq!(r.resets(), 6);
        assert!(!r.owed());
    }

    #[tokio::test(start_paused = true)]
    async fn a_stop_leaves_the_marker_for_the_next_start() {
        let r = rig();
        r.session();
        pass(3_500).await;
        assert_eq!(r.resets(), 3);
        // The service stops before the second round (the 3 s round would be cancelled too).
        r.shutdown.cancel();
        pass(20_000).await;
        assert_eq!(r.resets(), 3);
        assert!(r.marker.is_file(), "the next start runs the rounds");
        assert!(CleanupGate::open(r.marker.clone()).is_owed());
    }
}
