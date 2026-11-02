//! Session cleanup (plan Phase 4 Step 16, Section 4.12; PRD 5.3 and 13.3): after an
//! employee's session ends, the agent deletes the "data folders to reset on
//! logout" of **every** desktop app in the current catalogue, so the next
//! employee on the shared Staff account does not find the last one's saved login.
//!
//! - A `resetFolders` entry is a template, `{LocalAppData}\<rel>` or
//!   `{RoamingAppData}\<rel>` (`rulebox_policy::paths::reset_folder_parts`), and is
//!   only ever resolved below `<Staff profile>\AppData\Local` or `\Roaming`
//!   ([`resolve_reset`]). The platform walks every folder from the profile down and
//!   refuses the whole entry when one of them is a reparse point.
//! - [`run_cleanup`] runs a round [`CLEANUP_DELAY`] after the session ended (the
//!   Staff App closes the apps before it calls `session.signOut`). A folder still
//!   in use gets one retry [`IN_USE_RETRY`] later, then it is logged and left for
//!   the next sign-out. Nothing runs while an employee is signed in.
//! - One folder failing never stops the others. Logged at `info` with the template
//!   only: never a file name.
//!
//! The deletion itself is `Platform::reset_folder` (mutating, guarded): on the dev
//! machine `WindowsPlatform` refuses it, the tests use `SimPlatform`.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use rulebox_policy::catalog::{CatalogApp, CatalogKind};
use rulebox_policy::paths::{reset_folder_parts, MAX_RESET_FOLDERS};
use tokio::sync::{mpsc, watch};
use tokio_util::sync::CancellationToken;

use crate::agent_policy::AgentPolicy;
use crate::installs::plain_absolute;
use crate::platform::{Platform, PlatformError, ResetOutcome};

/// A round starts this long after the session ended (plan Step 16 item 2).
pub const CLEANUP_DELAY: Duration = Duration::from_secs(3);
/// Folders that were in use are tried once more after this long.
pub const IN_USE_RETRY: Duration = Duration::from_secs(10);
/// At most this many folders per round (bounded work whatever the catalogue holds;
/// the server allows 20 per app).
pub const MAX_RESETS_PER_ROUND: usize = 500;

/// Where one reset folder resolves to: every folder from the Staff profile down to
/// the target, in order (`<profile>`, `<profile>\AppData`, `...\Local`, then one
/// per component). The last one is the folder to delete.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResetTarget {
    pub chain: Vec<PathBuf>,
}

impl ResetTarget {
    /// The folder to delete (always below `AppData\Local` or `AppData\Roaming`).
    pub fn target(&self) -> &Path {
        self.chain.last().map_or(Path::new(""), PathBuf::as_path)
    }
}

/// Checks `template` again (the signed document was checked by the server; this is
/// defence in depth) and resolves it below `profile_dir`. Refused: a template that
/// breaks the rules (`..`, an absolute path, an unknown token...) or a profile path
/// that is not plain and absolute. Pure: no I/O.
pub fn resolve_reset(profile_dir: &Path, template: &str) -> Result<ResetTarget, PlatformError> {
    let (base, parts) =
        reset_folder_parts(template).map_err(|_| PlatformError::Refused("the folder template breaks the rules"))?;
    if !plain_absolute(profile_dir) {
        return Err(PlatformError::Refused("the Staff profile path is not a plain absolute path"));
    }
    let mut chain = Vec::with_capacity(parts.len() + 3);
    let mut path = profile_dir.to_path_buf();
    chain.push(path.clone());
    path.push("AppData");
    chain.push(path.clone());
    path.push(base.app_data_folder());
    chain.push(path.clone());
    for part in parts {
        path.push(part);
        chain.push(path.clone());
    }
    Ok(ResetTarget { chain })
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

/// What the cleanup task needs.
pub struct CleanupDeps {
    pub platform: Arc<dyn Platform>,
    /// The current catalogue (`AgentPolicy::catalog`), read when a round starts.
    pub policy_rx: watch::Receiver<AgentPolicy>,
    /// `state.staff.profile_dir`; `None` while the Staff account is not set up.
    pub profile_dir: Arc<dyn Fn() -> Option<PathBuf> + Send + Sync>,
    /// Whether an employee is signed in (then nothing is deleted).
    pub session_active: Arc<dyn Fn() -> bool + Send + Sync>,
    /// [`CLEANUP_DELAY`] and [`IN_USE_RETRY`]; tests may change them.
    pub delay: Duration,
    pub retry_after: Duration,
}

enum Round {
    /// Every catalogue app's folders.
    Full,
    /// The folders that were in use in the full round (the one retry).
    Retry(Vec<String>),
}

/// The cleanup task. Each message on `requests` means "an employee session ended";
/// a round starts [`CleanupDeps::delay`] after the latest one.
pub async fn run_cleanup(
    deps: CleanupDeps,
    mut requests: mpsc::UnboundedReceiver<()>,
    shutdown: CancellationToken,
) {
    let mut next: Option<(tokio::time::Instant, Round)> = None;
    let mut open = true;
    loop {
        let due = next.as_ref().map(|(at, _)| *at);
        let timer = async move {
            match due {
                Some(at) => tokio::time::sleep_until(at).await,
                None => std::future::pending::<()>().await,
            }
        };
        tokio::select! {
            () = shutdown.cancelled() => return,
            request = requests.recv(), if open => match request {
                // A newer end of session: a full round, which covers any retry.
                Some(()) => next = Some((tokio::time::Instant::now() + deps.delay, Round::Full)),
                None => open = false,
            },
            () = timer => {
                let Some((_, round)) = next.take() else {
                    continue;
                };
                let (templates, is_retry) = match round {
                    Round::Full => (reset_templates(&deps.policy_rx.borrow().catalog), false),
                    Round::Retry(templates) => (templates, true),
                };
                let busy = run_round(&deps, templates, &shutdown).await;
                if busy.is_empty() {
                    continue;
                }
                if is_retry {
                    tracing::warn!(
                        count = busy.len(),
                        "session cleanup: folders still in use after the retry; the next sign-out tries again"
                    );
                } else {
                    next = Some((tokio::time::Instant::now() + deps.retry_after, Round::Retry(busy)));
                }
            }
        }
    }
}

/// Resets `templates` one at a time. Returns the ones that were in use. Stops (and
/// returns nothing to retry) as soon as an employee is signed in.
async fn run_round(deps: &CleanupDeps, templates: Vec<String>, shutdown: &CancellationToken) -> Vec<String> {
    let mut busy = Vec::new();
    if templates.is_empty() {
        return busy;
    }
    let Some(profile) = (deps.profile_dir)() else {
        tracing::info!("session cleanup skipped: the Staff profile is not known");
        return busy;
    };
    for template in templates {
        if shutdown.is_cancelled() {
            break;
        }
        // Never during an active session (checked before every folder).
        if (deps.session_active)() {
            tracing::info!("session cleanup stopped: an employee is signed in; the next sign-out tries again");
            return Vec::new();
        }
        let platform = Arc::clone(&deps.platform);
        let (dir, name) = (profile.clone(), template.clone());
        let done = tokio::task::spawn_blocking(move || platform.reset_folder(&dir, &name)).await;
        match done {
            Ok(Ok(ResetOutcome::Removed)) => tracing::info!(template = %template, "session cleanup: folder reset"),
            Ok(Ok(ResetOutcome::Absent)) => tracing::info!(template = %template, "session cleanup: nothing to reset"),
            Ok(Ok(ResetOutcome::InUse) | Err(PlatformError::InUse)) => {
                tracing::info!(template = %template, "session cleanup: folder in use");
                busy.push(template);
            }
            Ok(Err(error)) => tracing::warn!(template = %template, %error, "session cleanup: folder not reset"),
            Err(_) => tracing::warn!(template = %template, "session cleanup: the reset task failed"),
        }
    }
    busy
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::sync::atomic::{AtomicBool, Ordering};

    use serde_json::json;

    use crate::platform::sim::{SimOp, SimPlatform};
    use crate::testutil::TempDir;

    const PROFILE: &str = r"C:\Users\RuleboxStaff";

    fn p(text: &str) -> PathBuf {
        PathBuf::from(text)
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
        let roaming = resolve_reset(&p(PROFILE), r"{RoamingAppData}\vlc\cache").unwrap();
        assert_eq!(roaming.target(), p(r"C:\Users\RuleboxStaff\AppData\Roaming\vlc\cache"));
        assert_eq!(roaming.chain.len(), 5);
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
        });
        (dir, sim)
    }

    fn has(sim: &SimPlatform, file: &str) -> bool {
        sim.with_world(|w| w.files.contains(&p(file)))
    }

    #[test]
    fn sim_reset_removes_the_folder_and_nothing_else() {
        let (_dir, sim) = sim_with_profile();
        assert_eq!(sim.reset_folder(&p(PROFILE), r"{LocalAppData}\Acme").unwrap(), ResetOutcome::Removed);
        assert!(!has(&sim, r"C:\Users\RuleboxStaff\AppData\Local\Acme\login.json"));
        assert!(!has(&sim, r"C:\Users\RuleboxStaff\AppData\Local\Acme\cache\a.bin"));
        assert!(has(&sim, r"C:\Users\RuleboxStaff\AppData\Local\Other\keep.txt"));
        assert!(has(&sim, r"C:\Users\RuleboxStaff\AppData\Roaming\Writer\profile.db"));
        assert!(has(&sim, r"C:\Users\RuleboxStaff\RuleboxFiles\emp_1\doc.txt"));
        // Gone: a second reset finds nothing.
        assert_eq!(sim.reset_folder(&p(PROFILE), r"{LocalAppData}\Acme").unwrap(), ResetOutcome::Absent);
        assert_eq!(sim.reset_folder(&p(PROFILE), r"{RoamingAppData}\Nope\deeper").unwrap(), ResetOutcome::Absent);
        assert_eq!(sim.reset_folder(&p(r"C:\Users\Missing"), r"{LocalAppData}\Acme").unwrap(), ResetOutcome::Absent);
        assert!(sim.calls().iter().all(|op| *op == SimOp::ResetFolder));
        assert!(SimOp::ResetFolder.is_mutating());
    }

    #[test]
    fn sim_reset_refuses_bad_templates_without_deleting() {
        let (_dir, sim) = sim_with_profile();
        let before = sim.with_world(|w| w.files.clone());
        for template in [r"{LocalAppData}\..\..\..\Windows", r"C:\Windows\System32", r"{SystemRoot}\System32", r"{LocalAppData}"] {
            assert!(matches!(sim.reset_folder(&p(PROFILE), template), Err(PlatformError::Refused(_))), "{template}");
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
            let refused = sim.reset_folder(&p(PROFILE), r"{LocalAppData}\Acme\cache");
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
        assert_eq!(sim.reset_folder(&p(PROFILE), r"{LocalAppData}\Acme").unwrap(), ResetOutcome::Removed);
        assert!(sim.with_world(|w| w.reparse_points.is_empty()));
        assert!(has(&sim, r"C:\Windows\System32\important.dll"));
    }

    #[test]
    fn an_open_file_gives_in_use_and_the_rest_stays_deleted() {
        let (_dir, sim) = sim_with_profile();
        let open = r"C:\Users\RuleboxStaff\AppData\Local\Acme\login.json";
        sim.with_world(|w| w.open_files.insert(p(open)));
        assert_eq!(sim.reset_folder(&p(PROFILE), r"{LocalAppData}\Acme").unwrap(), ResetOutcome::InUse);
        assert!(has(&sim, open));
        assert!(!has(&sim, r"C:\Users\RuleboxStaff\AppData\Local\Acme\cache\a.bin"));
        // Closed: the next try removes the rest.
        sim.with_world(|w| w.open_files.clear());
        assert_eq!(sim.reset_folder(&p(PROFILE), r"{LocalAppData}\Acme").unwrap(), ResetOutcome::Removed);
        assert!(!has(&sim, open));
    }

    // -- the cleanup task -------------------------------------------------------------

    struct Rig {
        _dir: TempDir,
        sim: Arc<SimPlatform>,
        tx: mpsc::UnboundedSender<()>,
        active: Arc<AtomicBool>,
        policy_tx: watch::Sender<AgentPolicy>,
        shutdown: CancellationToken,
    }

    fn rig_with(profile: Option<&str>) -> Rig {
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
        let (tx, rx) = mpsc::unbounded_channel();
        let shutdown = CancellationToken::new();
        let profile = profile.map(PathBuf::from);
        let deps = CleanupDeps {
            platform: Arc::clone(&sim) as Arc<dyn Platform>,
            policy_rx,
            profile_dir: Arc::new(move || profile.clone()),
            session_active: {
                let active = Arc::clone(&active);
                Arc::new(move || active.load(Ordering::SeqCst))
            },
            delay: CLEANUP_DELAY,
            retry_after: IN_USE_RETRY,
        };
        tokio::spawn(run_cleanup(deps, rx, shutdown.clone()));
        Rig { _dir: dir, sim, tx, active, policy_tx, shutdown }
    }

    fn rig() -> Rig {
        rig_with(Some(PROFILE))
    }

    impl Rig {
        fn resets(&self) -> usize {
            self.sim.calls().iter().filter(|op| **op == SimOp::ResetFolder).count()
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

    #[tokio::test(start_paused = true)]
    async fn a_sign_out_resets_every_catalogue_apps_folders_three_seconds_later() {
        let r = rig();
        r.tx.send(()).unwrap();
        pass(2_500).await;
        assert_eq!(r.resets(), 0, "not before 3 seconds");
        assert!(has(&r.sim, r"C:\Users\RuleboxStaff\AppData\Local\Acme\login.json"));
        pass(1_000).await;
        assert_eq!(r.resets(), 3);
        assert!(!has(&r.sim, r"C:\Users\RuleboxStaff\AppData\Local\Acme\login.json"));
        assert!(!has(&r.sim, r"C:\Users\RuleboxStaff\AppData\Roaming\Writer\profile.db"));
        assert!(has(&r.sim, r"C:\Users\RuleboxStaff\AppData\Local\Other\keep.txt"));
        // Nothing more without another sign-out.
        pass(60_000).await;
        assert_eq!(r.resets(), 3);
        r.shutdown.cancel();
    }

    #[tokio::test(start_paused = true)]
    async fn the_catalogue_at_the_time_of_the_round_is_used() {
        let r = rig();
        r.tx.send(()).unwrap();
        r.policy_tx.send_modify(|p| p.catalog = vec![app("z", "desktop", &[r"{RoamingAppData}\Writer"])]);
        pass(3_500).await;
        assert_eq!(r.resets(), 1);
        assert!(has(&r.sim, r"C:\Users\RuleboxStaff\AppData\Local\Acme\login.json"));
        assert!(!has(&r.sim, r"C:\Users\RuleboxStaff\AppData\Roaming\Writer\profile.db"));
    }

    #[tokio::test(start_paused = true)]
    async fn an_in_use_folder_is_retried_once_after_ten_seconds() {
        let r = rig();
        let open = r"C:\Users\RuleboxStaff\AppData\Local\Acme\login.json";
        r.sim.with_world(|w| w.open_files.insert(p(open)));
        r.tx.send(()).unwrap();
        pass(3_500).await;
        assert_eq!(r.resets(), 3);
        pass(9_000).await;
        assert_eq!(r.resets(), 3, "the retry waits 10 seconds");
        pass(1_500).await;
        assert_eq!(r.resets(), 4, "one retry, of the busy folder only");
        assert!(has(&r.sim, open));
        // Still in use: logged, no third try until the next sign-out.
        pass(120_000).await;
        assert_eq!(r.resets(), 4);
        r.sim.with_world(|w| w.open_files.clear());
        r.tx.send(()).unwrap();
        pass(3_500).await;
        assert_eq!(r.resets(), 7);
        assert!(!has(&r.sim, open));
    }

    #[tokio::test(start_paused = true)]
    async fn the_retry_succeeds_once_the_file_is_closed() {
        let r = rig();
        let open = r"C:\Users\RuleboxStaff\AppData\Local\Acme\login.json";
        r.sim.with_world(|w| w.open_files.insert(p(open)));
        r.tx.send(()).unwrap();
        pass(3_500).await;
        r.sim.with_world(|w| w.open_files.clear());
        pass(10_500).await;
        assert_eq!(r.resets(), 4);
        assert!(!has(&r.sim, open));
    }

    #[tokio::test(start_paused = true)]
    async fn nothing_runs_while_an_employee_is_signed_in() {
        let r = rig();
        r.tx.send(()).unwrap();
        // Someone signs in within the 3 seconds.
        r.active.store(true, Ordering::SeqCst);
        pass(3_500).await;
        assert_eq!(r.resets(), 0);
        assert!(has(&r.sim, r"C:\Users\RuleboxStaff\AppData\Local\Acme\login.json"));
        // No retry is owed either.
        pass(60_000).await;
        assert_eq!(r.resets(), 0);
        // The next sign-out does it.
        r.active.store(false, Ordering::SeqCst);
        r.tx.send(()).unwrap();
        pass(3_500).await;
        assert_eq!(r.resets(), 3);
    }

    #[tokio::test(start_paused = true)]
    async fn the_retry_does_not_run_during_a_new_session() {
        let r = rig();
        r.sim.with_world(|w| w.open_files.insert(p(r"C:\Users\RuleboxStaff\AppData\Local\Acme\login.json")));
        r.tx.send(()).unwrap();
        pass(3_500).await;
        assert_eq!(r.resets(), 3);
        r.active.store(true, Ordering::SeqCst);
        pass(11_000).await;
        assert_eq!(r.resets(), 3);
    }

    #[tokio::test(start_paused = true)]
    async fn one_failing_folder_does_not_stop_the_others() {
        let r = rig();
        r.sim.fail_next(SimOp::ResetFolder, PlatformError::Refused("a folder on the way is a link"));
        r.tx.send(()).unwrap();
        pass(3_500).await;
        assert_eq!(r.resets(), 3);
        // The first (Acme) failed; Writer was still reset.
        assert!(has(&r.sim, r"C:\Users\RuleboxStaff\AppData\Local\Acme\login.json"));
        assert!(!has(&r.sim, r"C:\Users\RuleboxStaff\AppData\Roaming\Writer\profile.db"));
        // A refusal is not retried.
        pass(15_000).await;
        assert_eq!(r.resets(), 3);
    }

    #[tokio::test(start_paused = true)]
    async fn nothing_runs_without_a_staff_profile() {
        let r = rig_with(None);
        r.tx.send(()).unwrap();
        pass(15_000).await;
        assert_eq!(r.resets(), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn sign_outs_close_together_give_one_round() {
        let r = rig();
        r.tx.send(()).unwrap();
        pass(1_000).await;
        r.tx.send(()).unwrap();
        pass(2_500).await;
        assert_eq!(r.resets(), 0, "3 seconds after the latest one");
        pass(1_000).await;
        assert_eq!(r.resets(), 3);
    }
}
