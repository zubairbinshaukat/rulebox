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
//! - (Phase 6 Step 18, plan 4.9.6) Every round also deletes the **browser profiles** that are not needed any more
//!   (`browser_profiles.rs`: employees the roster dropped, the 10 most recently used per browser at boot, fewer when the
//!   disk is nearly full). They go through the same gate, one folder at a time, so a browser of the Staff session never
//!   runs while one is deleted.
//! - (Q-A5, owner 2026-11-28) The browser profiles also get a **profile-only round** ([`Stage::Profiles`]) 3 s after the agent
//!   starts and after every change of the employees the roster lists, whenever nobody is signed in: a removed employee's profile
//!   does not wait for the next sign-out. While somebody is signed in or signing in the round stops and tries again every 30 s
//!   (the full rounds after the session end take it too, whichever comes first). It writes no marker: the roster and the profile
//!   folders are read again at every start, so a restart loses nothing.
//!
//! The deletion itself is `Platform::reset_folder` (mutating, guarded): on the dev
//! machine `WindowsPlatform` refuses it, the tests use `SimPlatform`.

use std::collections::HashSet;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rulebox_policy::catalog::{CatalogApp, CatalogKind};
use rulebox_policy::paths::{reset_folder_parts, MAX_RESET_FOLDERS};
use tokio::sync::{mpsc, watch, Notify};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use crate::agent_policy::AgentPolicy;
use crate::browser_profiles::{self, ProfileLedger};
use crate::installs::plain_absolute;
use crate::platform::{Platform, PlatformError, ResetOutcome};
use crate::roster::RosterState;
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
    // (Phase 6 Step 18) The one Rulebox folder that may be deleted: a browser profile of a web app, in exactly the shape
    // `browser_profiles::profile_template` makes. The general deny list keeps refusing every other `dev.rulebox.staff` folder.
    let (app_data_folder, parts) = match browser_profiles::profile_parts(template) {
        Some(parts) => ("Local", parts),
        None => {
            let (base, parts) =
                reset_folder_parts(template).map_err(|_| PlatformError::Refused("the folder template breaks the rules"))?;
            (base.app_data_folder(), parts)
        }
    };
    if !plain_absolute(profile_dir) {
        return Err(PlatformError::Refused("the Staff profile path is not a plain absolute path"));
    }
    let mut chain = Vec::with_capacity(parts.len() + 3);
    let mut components = Vec::with_capacity(parts.len() + 2);
    let mut path = profile_dir.to_path_buf();
    chain.push(path.clone());
    for part in ["AppData", app_data_folder].into_iter().chain(parts) {
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
    /// (Phase 6 Step 18) When each employee last signed in: which browser profiles are the most recently used.
    ledger: Mutex<Option<Arc<ProfileLedger>>>,
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
            ledger: Mutex::new(None),
        })
    }

    /// (Phase 6 Step 18) Where sign-ins are noted for the browser profile cleanup.
    pub fn set_profile_ledger(&self, ledger: Arc<ProfileLedger>) {
        *lock(&self.ledger) = Some(ledger);
    }

    /// (Phase 6 Step 18) An employee signed in: their browser profile is the most recently used now.
    pub fn employee_signed_in(&self, employee_id: &str) {
        let ledger = lock(&self.ledger).clone();
        if let Some(ledger) = ledger {
            ledger.touch(employee_id, crate::state::unix_ms());
        }
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
    /// (Phase 6 Step 18) The browser profile cleanup; `None` leaves browser profiles alone (tests, the demo world).
    pub browser_profiles: Option<BrowserProfiles>,
}

/// (Phase 6 Step 18) What a round needs to delete old browser profiles.
pub struct BrowserProfiles {
    /// Last sign-in of each employee.
    pub ledger: Arc<ProfileLedger>,
    /// The verified roster of the device's group.
    pub roster_rx: watch::Receiver<RosterState>,
    /// Set after the first pass of this agent run that ended without being stopped: "boot", when the 10 most recent rule applies.
    pub boot_done: AtomicBool,
}

impl BrowserProfiles {
    pub fn new(ledger: Arc<ProfileLedger>, roster_rx: watch::Receiver<RosterState>) -> Self {
        Self { ledger, roster_rx, boot_done: AtomicBool::new(false) }
    }

    /// The folder names of the employees the roster lists, or `None` when the roster does not speak for the current
    /// document (no document, no group, another group, nothing synced yet): nobody is then treated as removed.
    fn members(&self, policy: &AgentPolicy) -> Option<std::collections::BTreeSet<String>> {
        let roster = self.roster_rx.borrow();
        let group = policy.roster_group_id.as_deref()?;
        (policy.has_document && roster.group_id.as_deref() == Some(group) && roster.epoch > 0)
            .then(|| roster.members.keys().map(|id| browser_profiles::folder_of(id)).collect())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Stage {
    /// [`CleanupTimings::delay`] after a session ended (or at start).
    First,
    /// [`CleanupTimings::second_after`] after the first.
    Second,
    /// While still owed.
    Retry,
    /// (Q-A5, owner 2026-11-28) Only the browser profiles the roster dropped (and the other `browser_profiles` rules), after
    /// the roster changed or the agent started, when nobody is signed in. It never clears the owed marker and never touches
    /// an app's folders: that is what the full rounds above are for.
    Profiles,
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
    // (Q-A5) A profile-only round is owed from the start of the agent (a removal that happened while it was stopped or while
    // somebody was signed in) and after every change of the employees the roster lists. Nothing is written for it: the agent
    // reads the roster and the profile folders again, so it holds across a restart.
    let mut profiles_pending = deps.browser_profiles.is_some();
    let mut last_members = deps.browser_profiles.as_ref().and_then(|profiles| profiles.members(&deps.policy_rx.borrow()));
    let mut watching = deps.browser_profiles.as_ref().map(|profiles| (profiles.roster_rx.clone(), deps.policy_rx.clone()));
    loop {
        if profiles_pending && round.is_none() && next.is_none() {
            profiles_pending = false;
            next = Some((Instant::now() + deps.timings.delay, Stage::Profiles));
        }
        let due = if round.is_none() { next.map(|(at, _)| at) } else { None };
        let watched = async {
            match watching.as_mut() {
                // A closed channel (the agent is stopping) ends the watch; it must not spin.
                Some((roster, policy)) => tokio::select! {
                    changed = roster.changed() => changed.is_ok(),
                    changed = policy.changed() => changed.is_ok(),
                },
                None => std::future::pending::<bool>().await,
            }
        };
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
            alive = watched => {
                if !alive {
                    watching = None;
                    continue;
                }
                // The roster or the document changed: only a change of the employees the roster lists is of interest.
                let members = deps.browser_profiles.as_ref().and_then(|profiles| profiles.members(&deps.policy_rx.borrow()));
                if members != last_members {
                    last_members = members;
                    profiles_pending = true;
                }
            },
            end = running => {
                let Some((stage, _)) = round.take() else {
                    continue;
                };
                // A request that arrived meanwhile already set `next`: it wins.
                if next.is_some() {
                    continue;
                }
                if stage == Stage::Profiles {
                    // Anything but a clean pass (somebody is signed in or signing in, a folder is in use) is tried again
                    // later; the full rounds after a session end do it too, whichever comes first.
                    if end != RoundEnd::Clean {
                        next = Some((Instant::now() + deps.timings.retry_every, Stage::Profiles));
                    }
                    continue;
                }
                if end == RoundEnd::Stopped {
                    continue;
                }
                match (stage, end) {
                    (Stage::Profiles, _) => {}
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
                    let future: RoundFuture = if stage == Stage::Profiles {
                        Box::pin(run_profiles_round(Arc::clone(&deps), Arc::clone(&in_flight), shutdown.child_token()))
                    } else {
                        // A full round deletes the browser profiles as well; a change that comes later sets the flag again.
                        profiles_pending = false;
                        Box::pin(run_round(Arc::clone(&deps), Arc::clone(&in_flight), shutdown.child_token()))
                    };
                    round = Some((stage, future));
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

/// How one folder of a round ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Step {
    /// Reset, absent or refused for good.
    Done,
    /// In use, too slow or still being deleted by an earlier try.
    Dirty,
    /// Stopped: an employee is signing in or signed in, or the agent is stopping.
    Stopped,
}

/// Deletes one folder below the Staff profile through the gate: never during a sign-in or a session, one at a time, with the
/// watchdog of [`CleanupTimings::folder_timeout`]. `label` is what the log says (the template of an app's folder; for a browser
/// profile only that it is one).
async fn reset_one(
    deps: &Arc<CleanupDeps>,
    in_flight: &Arc<Mutex<HashSet<String>>>,
    cancel: &CancellationToken,
    profile: &Path,
    template: &str,
    label: &str,
) -> Step {
    if cancel.is_cancelled() {
        return Step::Stopped;
    }
    if lock(in_flight).contains(template) {
        // An earlier deletion of it is still running (the watchdog gave up).
        return Step::Dirty;
    }
    // Never during a sign-in or a session (asked before every folder).
    let Some(permit) = deps.gate.begin_delete(&*deps.session_active) else {
        tracing::info!("session cleanup stopped: an employee is signing in or signed in");
        return Step::Stopped;
    };
    lock(in_flight).insert(template.to_string());
    let job = InFlight { set: Arc::clone(in_flight), template: template.to_string() };
    let job_cancel = cancel.child_token();
    let (platform, dir, name, token) = (Arc::clone(&deps.platform), profile.to_path_buf(), template.to_string(), job_cancel.clone());
    let handle = tokio::task::spawn_blocking(move || {
        let _held = (permit, job);
        platform.reset_folder(&dir, &name, &token)
    });
    match tokio::time::timeout(deps.timings.folder_timeout, handle).await {
        Ok(Ok(Ok(ResetOutcome::Removed))) => {
            tracing::info!(template = %label, "session cleanup: folder reset");
            Step::Done
        }
        Ok(Ok(Ok(ResetOutcome::Absent))) => {
            tracing::debug!(template = %label, "session cleanup: nothing to reset");
            Step::Done
        }
        Ok(Ok(Ok(ResetOutcome::InUse) | Err(PlatformError::InUse))) => {
            tracing::info!(template = %label, "session cleanup: folder in use");
            Step::Dirty
        }
        // A refusal or another error: logged, not retried (it would fail again).
        Ok(Ok(Err(error))) => {
            tracing::warn!(template = %label, %error, "session cleanup: folder not reset");
            Step::Done
        }
        Ok(Err(_)) => {
            tracing::warn!(template = %label, "session cleanup: the reset task failed");
            Step::Dirty
        }
        Err(_) => {
            // The watchdog: stop it between entries; whatever it is stuck in
            // finishes in the background (it keeps its handles and its
            // deletion permit until then).
            job_cancel.cancel();
            tracing::warn!(
                template = %label,
                "session cleanup: folder took longer than {} s; stopped and counted as in use",
                deps.timings.folder_timeout.as_secs()
            );
            Step::Dirty
        }
    }
}

/// One full round: every catalogue app's folders, one at a time, then the browser profiles that are not needed any more.
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
    if templates.is_empty() && deps.browser_profiles.is_none() {
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
        match reset_one(&deps, &in_flight, &cancel, &profile, &template, &template).await {
            Step::Done => {}
            Step::Dirty => clean = false,
            Step::Stopped => return RoundEnd::Stopped,
        }
    }
    if let Some(profiles) = &deps.browser_profiles {
        match browser_pass(&deps, &in_flight, &cancel, &profile, profiles).await {
            Step::Done => {}
            Step::Dirty => clean = false,
            Step::Stopped => return RoundEnd::Stopped,
        }
    }
    if clean {
        RoundEnd::Clean
    } else {
        RoundEnd::Dirty
    }
}

/// (Q-A5) A round of the browser profiles alone: what [`run_round`] does after the app folders, without them, so it can run
/// whenever nobody is signed in (after a roster change, at the start of the agent) and never touches the owed marker.
/// `Stopped` while an employee is signed in or signing in (nothing is read or deleted then).
async fn run_profiles_round(deps: Arc<CleanupDeps>, in_flight: Arc<Mutex<HashSet<String>>>, cancel: CancellationToken) -> RoundEnd {
    let Some(profiles) = &deps.browser_profiles else {
        return RoundEnd::Clean;
    };
    if (deps.session_active)() {
        return RoundEnd::Stopped;
    }
    let Some(staff) = (deps.staff)() else {
        return RoundEnd::Clean;
    };
    let profile = match deps.platform.staff_profile_dir(&staff.sid) {
        Ok(Some(dir)) => dir,
        Ok(None) => return RoundEnd::Clean,
        Err(error) => {
            tracing::warn!(%error, "browser profile cleanup: cannot read the Staff profile folder; tried again later");
            return RoundEnd::Dirty;
        }
    };
    match browser_pass(&deps, &in_flight, &cancel, &profile, profiles).await {
        Step::Done => RoundEnd::Clean,
        Step::Dirty => RoundEnd::Dirty,
        Step::Stopped => RoundEnd::Stopped,
    }
}

/// (Phase 6 Step 18, plan 4.9.6) Deletes the browser profiles `browser_profiles::plan` names.
async fn browser_pass(
    deps: &Arc<CleanupDeps>,
    in_flight: &Arc<Mutex<HashSet<String>>>,
    cancel: &CancellationToken,
    profile: &Path,
    profiles: &BrowserProfiles,
) -> Step {
    let root = profile.join("AppData").join("Local").join("dev.rulebox.staff").join("browser");
    let mut present: Vec<(&'static str, String)> = Vec::new();
    for browser in browser_profiles::BROWSERS {
        match deps.platform.list_folder_names(&root.join(browser)) {
            Ok(names) => present.extend(names.into_iter().map(|name| (browser, name))),
            Err(error) => tracing::debug!(%error, browser, "session cleanup: cannot list the browser profiles"),
        }
    }
    let roster = profiles.members(&deps.policy_rx.borrow());
    let boot = !profiles.boot_done.load(Ordering::SeqCst);
    let input = browser_profiles::PassInput {
        present,
        roster,
        last_used: profiles.ledger.snapshot(),
        disk_free: deps.platform.disk_free_bytes().ok(),
        boot,
    };
    let mut step = Step::Done;
    let mut remaining = input.present.clone();
    for doomed in browser_profiles::plan(&input) {
        let Some(template) = browser_profiles::profile_template(doomed.browser, &doomed.folder) else {
            continue;
        };
        tracing::info!(browser = doomed.browser, why = ?doomed.why, "session cleanup: a browser profile goes");
        match reset_one(deps, in_flight, cancel, profile, &template, "a browser profile").await {
            Step::Done => remaining.retain(|(browser, folder)| !(*browser == doomed.browser && *folder == doomed.folder)),
            Step::Dirty => step = Step::Dirty,
            Step::Stopped => return Step::Stopped,
        }
    }
    // The ledger keeps only employees that still have a profile folder in some browser.
    let still_there: std::collections::BTreeSet<String> = remaining.into_iter().map(|(_, folder)| folder).collect();
    profiles.ledger.retain_only(&still_there);
    if step == Step::Done {
        profiles.boot_done.store(true, Ordering::SeqCst);
    }
    step
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
            browser_profiles: None,
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

/// (Phase 6 Step 18, plan 4.9.6) The browser profiles of web apps that open in Chrome or Edge.
#[cfg(test)]
mod browser_profile_tests {
    use super::*;

    use crate::platform::sim::{SimOp, SimPlatform};
    use crate::testutil::TempDir;

    const PROFILE: &str = r"C:\Users\RuleboxStaff";
    const SID: &str = "S-1-5-21-1000-2000-3000-2001";
    const ROOT: &str = r"C:\Users\RuleboxStaff\AppData\Local\dev.rulebox.staff\browser";

    fn p(text: &str) -> PathBuf {
        PathBuf::from(text)
    }

    struct Rig {
        _dir: TempDir,
        sim: Arc<SimPlatform>,
        deps: Arc<CleanupDeps>,
        active: Arc<AtomicBool>,
        ledger: Arc<ProfileLedger>,
        roster_tx: watch::Sender<RosterState>,
        _policy_tx: watch::Sender<AgentPolicy>,
    }

    /// A Staff profile with the given profile folders `(browser, employee folder)`, each holding a cookie file; the roster of
    /// group `g1` at epoch 5 lists `members`.
    fn rig(folders: &[(&str, &str)], members: &[&str]) -> Rig {
        let dir = TempDir::new();
        let sim = Arc::new(SimPlatform::new(dir.path().to_path_buf()));
        sim.with_world(|w| {
            for d in [
                PROFILE,
                r"C:\Users\RuleboxStaff\AppData",
                r"C:\Users\RuleboxStaff\AppData\Local",
                r"C:\Users\RuleboxStaff\AppData\Local\dev.rulebox.staff",
                ROOT,
            ] {
                w.dirs.insert(p(d));
            }
            for (browser, folder) in folders {
                w.files.insert(p(&format!(r"{ROOT}\{browser}\{folder}\Default\Cookies")));
            }
            // The built-in window's own profile and the Staff App's other folders are never part of this.
            w.files.insert(p(r"C:\Users\RuleboxStaff\AppData\Local\dev.rulebox.staff\web\emp1\Cookies"));
            w.files.insert(p(r"C:\Users\RuleboxStaff\AppData\Local\dev.rulebox.staff\EBWebView\Default\Cookies"));
            w.profile_dirs.insert(SID.into(), p(PROFILE));
        });
        let policy = AgentPolicy { has_document: true, roster_group_id: Some("g1".into()), ..AgentPolicy::default() };
        let (policy_tx, policy_rx) = watch::channel(policy);
        let roster = RosterState {
            group_id: Some("g1".into()),
            epoch: 5,
            members: members.iter().map(|id| ((*id).to_string(), 1)).collect(),
            ..RosterState::default()
        };
        let (roster_tx, roster_rx) = watch::channel(roster);
        let ledger = Arc::new(ProfileLedger::in_memory());
        let active = Arc::new(AtomicBool::new(false));
        let deps = Arc::new(CleanupDeps {
            platform: Arc::clone(&sim) as Arc<dyn Platform>,
            policy_rx,
            staff: Arc::new(|| Some(StaffRef { sid: SID.into(), saved_profile: Some(p(PROFILE)) })),
            session_active: {
                let active = Arc::clone(&active);
                Arc::new(move || active.load(Ordering::SeqCst))
            },
            gate: CleanupGate::in_memory(false),
            timings: CleanupTimings::default(),
            browser_profiles: Some(BrowserProfiles::new(Arc::clone(&ledger), roster_rx)),
        });
        Rig { _dir: dir, sim, deps, active, ledger, roster_tx, _policy_tx: policy_tx }
    }

    /// A running cleanup task of a Rig (one run of the agent).
    struct Run {
        gate: Arc<CleanupGate>,
        shutdown: CancellationToken,
    }

    impl Run {
        fn stop(&self) {
            self.shutdown.cancel();
        }
    }

    /// Lets the task and its blocking calls run (the clock is paused: this only advances it by `ms`).
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

    /// The roster lists exactly `members` from now on (the epoch moves on, as a real sync does).
    fn roster_is(r: &Rig, epoch: u64, members: &[&str]) {
        r.roster_tx
            .send(RosterState {
                group_id: Some("g1".into()),
                epoch,
                members: members.iter().map(|id| ((*id).to_string(), 1)).collect(),
                ..RosterState::default()
            })
            .unwrap();
    }

    impl Rig {
        /// Starts one run of the agent's cleanup task: a fresh gate (nothing owed) and a fresh `BrowserProfiles` (the boot pass
        /// is still to come), on the same disk, ledger, roster and sign-in flag.
        fn start(&self) -> Run {
            let gate = CleanupGate::in_memory(false);
            let (tx, rx) = mpsc::unbounded_channel();
            gate.set_requests(tx);
            let shutdown = CancellationToken::new();
            let deps = CleanupDeps {
                platform: Arc::clone(&self.deps.platform),
                policy_rx: self.deps.policy_rx.clone(),
                staff: Arc::clone(&self.deps.staff),
                session_active: Arc::clone(&self.deps.session_active),
                gate: Arc::clone(&gate),
                timings: CleanupTimings::default(),
                browser_profiles: Some(BrowserProfiles::new(Arc::clone(&self.ledger), self.roster_tx.subscribe())),
            };
            tokio::spawn(run_cleanup(deps, rx, shutdown.clone()));
            Run { gate, shutdown }
        }

        async fn round(&self) -> RoundEnd {
            run_round(Arc::clone(&self.deps), Arc::default(), CancellationToken::new()).await
        }

        fn has(&self, browser: &str, folder: &str) -> bool {
            let file = p(&format!(r"{ROOT}\{browser}\{folder}\Default\Cookies"));
            self.sim.with_world(|w| w.files.contains(&file))
        }

        fn resets(&self) -> usize {
            self.sim.calls().iter().filter(|op| **op == SimOp::ResetFolder).count()
        }

        fn boot_done(&self) -> bool {
            self.deps.browser_profiles.as_ref().is_some_and(|profiles| profiles.boot_done.load(Ordering::SeqCst))
        }
    }

    #[test]
    fn a_browser_profile_resolves_below_the_staff_app_data_and_other_rulebox_folders_stay_refused() {
        let template = browser_profiles::profile_template("chrome", "emp1").unwrap();
        let target = resolve_reset(&p(PROFILE), &template).unwrap();
        assert_eq!(target.components, ["AppData", "Local", "dev.rulebox.staff", "browser", "chrome", "emp1"]);
        assert_eq!(target.target(), p(&format!(r"{ROOT}\chrome\emp1")));
        assert_eq!(target.chain.len(), 7);
        for refused in [
            r"{LocalAppData}\dev.rulebox.staff\EBWebView",
            r"{LocalAppData}\dev.rulebox.staff\web\emp1",
            r"{LocalAppData}\dev.rulebox.staff\browser",
            r"{LocalAppData}\dev.rulebox.staff\browser\chrome",
            r"{LocalAppData}\dev.rulebox.staff\browser\chrome\..\..\web",
            r"{LocalAppData}\dev.rulebox.staff\browser\firefox\emp1",
            r"{RoamingAppData}\dev.rulebox.staff\browser\chrome\emp1",
        ] {
            assert!(matches!(resolve_reset(&p(PROFILE), refused), Err(PlatformError::Refused(_))), "{refused}");
        }
        // An administrator's `resetFolders` entry is still checked by the general rule: the same text made by hand is the same
        // template, which only the signed document could deliver and the server never accepts.
        assert!(rulebox_policy::paths::reset_folder_parts(&template).is_err());
    }

    #[tokio::test]
    async fn an_employee_the_roster_dropped_loses_the_profile_in_both_browsers_and_nobody_else_does() {
        let r = rig(&[("chrome", "emp1"), ("chrome", "gone"), ("edge", "gone"), ("edge", "emp1")], &["emp1"]);
        assert_eq!(r.round().await, RoundEnd::Clean);
        assert!(r.has("chrome", "emp1") && r.has("edge", "emp1"));
        assert!(!r.has("chrome", "gone") && !r.has("edge", "gone"));
        assert_eq!(r.resets(), 2);
        // The built-in window's profile and the WebView2 folder are not browser profiles: untouched.
        assert!(r.sim.with_world(|w| w.files.contains(&p(r"C:\Users\RuleboxStaff\AppData\Local\dev.rulebox.staff\web\emp1\Cookies"))));
        assert!(r.sim.with_world(|w| w.files.contains(&p(r"C:\Users\RuleboxStaff\AppData\Local\dev.rulebox.staff\EBWebView\Default\Cookies"))));
        // Nothing left to do: a second round deletes nothing.
        assert_eq!(r.round().await, RoundEnd::Clean);
        assert_eq!(r.resets(), 2);
    }

    #[tokio::test]
    async fn a_roster_that_does_not_speak_for_the_document_removes_nobody() {
        let r = rig(&[("chrome", "stranger")], &[]);
        // Another group, no sync yet (epoch 0), no group in the document: each means "unknown", not "everybody left".
        let wrong_group = RosterState { group_id: Some("other".into()), epoch: 9, ..RosterState::default() };
        let (tx, rx) = watch::channel(wrong_group);
        let profiles = BrowserProfiles::new(Arc::clone(&r.ledger), rx);
        let policy = r.deps.policy_rx.borrow().clone();
        assert_eq!(profiles.members(&policy), None);
        tx.send(RosterState { group_id: Some("g1".into()), epoch: 0, ..RosterState::default() }).unwrap();
        assert_eq!(profiles.members(&policy), None);
        tx.send(RosterState { group_id: Some("g1".into()), epoch: 3, ..RosterState::default() }).unwrap();
        assert_eq!(profiles.members(&policy), Some(std::collections::BTreeSet::new()));
        assert_eq!(profiles.members(&AgentPolicy { roster_group_id: None, ..policy.clone() }), None);
        assert_eq!(profiles.members(&AgentPolicy { has_document: false, ..policy }), None);
        // The rig's own roster lists nobody at epoch 5 for g1: that one does remove the stranger.
        assert_eq!(r.round().await, RoundEnd::Clean);
        assert!(!r.has("chrome", "stranger"));
    }

    #[tokio::test]
    async fn at_boot_only_the_ten_most_recently_used_stay_and_later_rounds_leave_the_rest_alone() {
        let ids: Vec<String> = (0..12).map(|i| format!("e{i:02}")).collect();
        let folders: Vec<(&str, &str)> = ids.iter().map(|id| ("chrome", id.as_str())).collect();
        let members: Vec<&str> = ids.iter().map(String::as_str).collect();
        let r = rig(&folders, &members);
        for (i, id) in ids.iter().enumerate() {
            r.ledger.touch(id, 1_000 + i as u64);
        }
        assert!(!r.boot_done());
        assert_eq!(r.round().await, RoundEnd::Clean);
        assert!(r.boot_done());
        // e00 and e01 signed in longest ago.
        assert!(!r.has("chrome", "e00") && !r.has("chrome", "e01"));
        assert!((2..12).all(|i| r.has("chrome", &format!("e{i:02}"))));
        assert_eq!(r.resets(), 2);
        // Their ledger entries went with them.
        assert!(!r.ledger.snapshot().contains_key("e00") && r.ledger.snapshot().contains_key("e11"));
        // After boot a bigger crowd is not cut (plenty of disk).
        r.sim.with_world(|w| {
            for i in 20..26 {
                w.files.insert(p(&format!(r"{ROOT}\chrome\e{i}\Default\Cookies")));
            }
        });
        let list = r.sim.list_folder_names(&p(&format!(r"{ROOT}\chrome"))).unwrap();
        assert_eq!(list.len(), 16);
        // (They are not in the roster, so the roster rule takes them; the 10-rule itself did nothing more.)
        assert_eq!(r.round().await, RoundEnd::Clean);
        assert!((2..12).all(|i| r.has("chrome", &format!("e{i:02}"))));
    }

    #[tokio::test]
    async fn short_of_disk_only_three_profiles_stay_at_every_round() {
        let ids = ["a", "b", "c", "d", "e"];
        let folders: Vec<(&str, &str)> = ids.iter().map(|id| ("edge", *id)).collect();
        let r = rig(&folders, &ids);
        for (i, id) in ids.iter().enumerate() {
            r.ledger.touch(id, 10 + i as u64);
        }
        r.sim.with_world(|w| w.disk_free_bytes = browser_profiles::LOW_DISK_BYTES - 1);
        assert_eq!(r.round().await, RoundEnd::Clean);
        assert!(!r.has("edge", "a") && !r.has("edge", "b"));
        assert!(r.has("edge", "c") && r.has("edge", "d") && r.has("edge", "e"));
        // The employee who signed in last is never the one that goes.
        assert!(r.ledger.snapshot().contains_key("e"));
    }

    #[tokio::test]
    async fn nothing_is_deleted_while_an_employee_is_signed_in_so_no_browser_runs() {
        let r = rig(&[("chrome", "gone")], &["emp1"]);
        r.active.store(true, Ordering::SeqCst);
        assert_eq!(r.round().await, RoundEnd::Stopped);
        assert!(r.has("chrome", "gone"));
        assert_eq!(r.resets(), 0);
        assert!(!r.boot_done(), "a stopped pass is not the boot pass");
        // A sign-in in progress stops it too.
        r.active.store(false, Ordering::SeqCst);
        let permit = r.deps.gate.enter_sign_in(false, Duration::ZERO).await.unwrap();
        assert_eq!(r.round().await, RoundEnd::Stopped);
        assert!(r.has("chrome", "gone"));
        drop(permit);
        assert_eq!(r.round().await, RoundEnd::Clean);
        assert!(!r.has("chrome", "gone"));
    }

    #[tokio::test]
    async fn a_profile_a_process_still_holds_open_stays_and_the_round_is_tried_again() {
        let r = rig(&[("chrome", "gone"), ("edge", "gone")], &["emp1"]);
        let held = p(&format!(r"{ROOT}\chrome\gone\Default\Cookies"));
        r.sim.with_world(|w| w.open_files.insert(held.clone()));
        assert_eq!(r.round().await, RoundEnd::Dirty);
        assert!(r.has("chrome", "gone"), "in use: kept");
        assert!(!r.has("edge", "gone"), "the other browser's profile did go");
        assert!(!r.boot_done());
        // The browser ended: the retry removes it.
        r.sim.with_world(|w| w.open_files.clear());
        assert_eq!(r.round().await, RoundEnd::Clean);
        assert!(!r.has("chrome", "gone"));
        assert!(r.boot_done());
    }

    #[tokio::test]
    async fn a_link_planted_in_the_profile_tree_is_refused_and_nothing_is_deleted() {
        let r = rig(&[("chrome", "gone")], &["emp1"]);
        r.sim.with_world(|w| w.reparse_points.insert(p(&format!(r"{ROOT}\chrome"))));
        let before = r.sim.with_world(|w| w.files.clone());
        // The refusal is logged and not retried (it would fail the same way).
        assert_eq!(r.round().await, RoundEnd::Clean);
        assert_eq!(r.sim.with_world(|w| w.files.clone()), before);
    }

    #[tokio::test]
    async fn without_the_browser_profile_cleanup_a_round_does_not_look_at_the_profiles() {
        let r = rig(&[("chrome", "gone")], &["emp1"]);
        let deps = Arc::new(CleanupDeps {
            platform: Arc::clone(&r.deps.platform),
            policy_rx: r.deps.policy_rx.clone(),
            staff: Arc::clone(&r.deps.staff),
            session_active: Arc::clone(&r.deps.session_active),
            gate: Arc::clone(&r.deps.gate),
            timings: r.deps.timings,
            browser_profiles: None,
        });
        assert_eq!(run_round(deps, Arc::default(), CancellationToken::new()).await, RoundEnd::Clean);
        assert!(r.has("chrome", "gone"));
        assert!(!r.sim.calls().contains(&SimOp::ListFolderNames));
    }

    // -- Q-A5 (owner 2026-11-28): a removed employee's profile goes the next time nobody is signed in ----------------------

    #[tokio::test(start_paused = true)]
    async fn a_removal_while_nobody_is_signed_in_deletes_the_profile_at_once_without_a_session_end() {
        let r = rig(&[("chrome", "emp1"), ("chrome", "gone"), ("edge", "gone")], &["emp1", "gone"]);
        let run = r.start();
        pass(4_000).await;
        assert!(r.has("chrome", "gone"), "still in the roster");
        assert_eq!(r.resets(), 0);
        // The boss removes the employee; nobody is signed in and no session ends.
        roster_is(&r, 6, &["emp1"]);
        pass(3_500).await;
        assert!(!r.has("chrome", "gone") && !r.has("edge", "gone"), "both browsers' profiles of the removed employee went");
        assert!(r.has("chrome", "emp1"));
        assert_eq!(r.resets(), 2);
        // Only the profiles: nothing is owed, the Staff App's other folders are not touched.
        assert!(!run.gate.is_owed());
        assert!(r.sim.with_world(|w| w.files.contains(&p(r"C:\Users\RuleboxStaff\AppData\Local\dev.rulebox.staff\web\emp1\Cookies"))));
        // A roster change that removes nobody does nothing more.
        roster_is(&r, 7, &["emp1", "new"]);
        pass(35_000).await;
        assert_eq!(r.resets(), 2);
        run.stop();
    }

    #[tokio::test(start_paused = true)]
    async fn a_removal_while_another_employee_is_signed_in_waits_and_goes_at_the_session_end() {
        let r = rig(&[("chrome", "emp1"), ("chrome", "gone")], &["emp1", "gone"]);
        r.active.store(true, Ordering::SeqCst);
        let run = r.start();
        pass(4_000).await;
        roster_is(&r, 6, &["emp1"]);
        pass(3_500).await;
        assert!(r.has("chrome", "gone"), "an employee is signed in: no browser profile is touched");
        assert_eq!(r.resets(), 0);
        pass(65_000).await;
        assert!(r.has("chrome", "gone"));
        assert_eq!(r.resets(), 0);
        // The employee signs out: the cleanup rounds of the session end take it (and the signed-in employee's own stays).
        r.active.store(false, Ordering::SeqCst);
        run.gate.mark_owed();
        run.gate.session_ended();
        pass(3_500).await;
        assert!(!r.has("chrome", "gone") && r.has("chrome", "emp1"));
        pass(10_500).await;
        assert!(!run.gate.is_owed());
        run.stop();
    }

    #[tokio::test(start_paused = true)]
    async fn a_removal_while_somebody_is_signed_in_goes_when_nobody_is_even_without_a_session_end_event() {
        // A sign-in that failed ends no session, so no session-end round follows: the retry finds it.
        let r = rig(&[("chrome", "emp1"), ("chrome", "gone")], &["emp1", "gone"]);
        let run = r.start();
        pass(4_000).await;
        r.active.store(true, Ordering::SeqCst);
        roster_is(&r, 6, &["emp1"]);
        pass(3_500).await;
        assert!(r.has("chrome", "gone"));
        r.active.store(false, Ordering::SeqCst);
        pass(31_000).await;
        assert!(!r.has("chrome", "gone"));
        run.stop();
    }

    #[tokio::test(start_paused = true)]
    async fn a_removal_survives_a_restart_of_the_agent() {
        let r = rig(&[("chrome", "emp1"), ("chrome", "gone")], &["emp1", "gone"]);
        // One run of the agent: an employee is signed in when the roster drops the other one, then the service stops.
        r.active.store(true, Ordering::SeqCst);
        let first = r.start();
        pass(4_000).await;
        roster_is(&r, 6, &["emp1"]);
        pass(3_500).await;
        assert!(r.has("chrome", "gone"));
        first.stop();
        pass(1_000).await;
        // The PC was restarted: a new run, nobody signed in, the roster is the saved one (it no longer lists `gone`).
        r.active.store(false, Ordering::SeqCst);
        let second = r.start();
        assert!(r.has("chrome", "gone"), "nothing before the new run's own first pass");
        pass(3_500).await;
        assert!(!r.has("chrome", "gone"), "the first pass of the new run removes it");
        assert!(r.has("chrome", "emp1"));
        assert!(!second.gate.is_owed());
        second.stop();
    }

    #[tokio::test(start_paused = true)]
    async fn a_roster_that_arrives_after_the_start_is_applied_when_it_does() {
        // The agent starts before the backend has said which group this PC is in: nobody counts as removed yet.
        let r = rig(&[("chrome", "gone")], &[]);
        r.roster_tx.send(RosterState::default()).unwrap();
        let run = r.start();
        pass(4_000).await;
        assert!(r.has("chrome", "gone"), "no roster yet: nobody is treated as removed");
        roster_is(&r, 3, &["emp1"]);
        pass(3_500).await;
        assert!(!r.has("chrome", "gone"));
        run.stop();
    }

    #[test]
    fn a_sign_in_is_noted_for_the_most_recently_used_rule() {
        let gate = CleanupGate::in_memory(false);
        // No ledger set: nothing happens.
        gate.employee_signed_in("emp1");
        let ledger = Arc::new(ProfileLedger::in_memory());
        gate.set_profile_ledger(Arc::clone(&ledger));
        gate.employee_signed_in("emp1");
        gate.employee_signed_in("emp 2");
        let used = ledger.snapshot();
        assert_eq!(used.keys().map(String::as_str).collect::<Vec<_>>(), ["emp-2", "emp1"]);
        assert!(used.values().all(|ms| *ms > 1_600_000_000_000));
    }
}
