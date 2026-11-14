//! `AppState`: the one Mutex shell snapshot, plus agent bookkeeping React never sees.
//! Emissions of `shell://state` are coalesced to at most one per 50 ms.

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::future::{abortable, AbortHandle};
use tauri::{AppHandle, Emitter, Manager};

use crate::agent::AgentPort;
use crate::model::{NoticeItem, NoticeTone, ShellState};

const EMIT_COALESCE: Duration = Duration::from_millis(50);
const UI_ALIVE_WINDOW: Duration = Duration::from_secs(15);
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(10);

/// Managed Tauri state. Cheap to clone (`Arc`).
#[derive(Clone)]
pub struct AppState {
    inner: Arc<Inner>,
}

struct Inner {
    shell: Mutex<ShellState>,
    agent: Arc<dyn AgentPort>,
    app: Mutex<Option<AppHandle>>,
    last_ui_alive: Mutex<Option<Instant>>,
    /// Cleared when the link drops so the next link sends `shell.ready` again.
    ready_sent: AtomicBool,
    coalesce_last: Mutex<Option<Instant>>,
    coalesce_pending: AtomicBool,
    #[allow(dead_code)] // Written by `notify`; UI is Step 10.
    notice_seq: AtomicU32,
    /// How many emits were actually flushed (tests assert coalescing).
    #[allow(dead_code)]
    emit_count: AtomicU64,
    /// Employee files root from the last successful sign-in.
    files_root: Mutex<Option<String>>,
    /// The signed-in employee's file session and the `fileHandlers` table.
    files: Arc<crate::files::FilesHub>,
    /// How often each web app asked for something it may not have (PRD 24.1): the total per app.
    web_denials: Mutex<std::collections::HashMap<String, u32>>,
    /// (Phase 5 Step 12) The same refusals per `(app id, permission name)`, waiting to be reported to
    /// the agent (`webapp.reportDenials`). Only these two strings and a number: never a page address,
    /// a time or the employee (plan 4.13).
    denial_counts: Mutex<std::collections::BTreeMap<(String, String), u32>>,
    /// A report is on its way: a second one waits for the next turn.
    denial_flush_running: AtomicBool,
    /// Theme of the sign-in screen (organization / dev setting). An employee's
    /// choice replaces `display.theme` only while they are signed in.
    org_theme: Mutex<crate::model::ThemeDto>,
    /// Debug: when set, agent link updates do not overwrite a forced boot link.
    #[cfg(debug_assertions)]
    pub(crate) dev_hold_link: AtomicBool,
}

impl AppState {
    pub fn new(agent: Arc<dyn AgentPort>, initial: ShellState) -> Self {
        let org_theme = initial.display.theme;
        Self {
            inner: Arc::new(Inner {
                shell: Mutex::new(initial),
                agent,
                app: Mutex::new(None),
                last_ui_alive: Mutex::new(None),
                ready_sent: AtomicBool::new(false),
                coalesce_last: Mutex::new(None),
                coalesce_pending: AtomicBool::new(false),
                notice_seq: AtomicU32::new(1),
                emit_count: AtomicU64::new(0),
                files_root: Mutex::new(None),
                files: Arc::new(crate::files::FilesHub::default()),
                web_denials: Mutex::new(std::collections::HashMap::new()),
                denial_counts: Mutex::new(std::collections::BTreeMap::new()),
                denial_flush_running: AtomicBool::new(false),
                org_theme: Mutex::new(org_theme),
                #[cfg(debug_assertions)]
                dev_hold_link: AtomicBool::new(false),
            }),
        }
    }

    pub fn org_theme(&self) -> crate::model::ThemeDto {
        *self
            .inner
            .org_theme
            .lock()
            .unwrap_or_else(|e| e.into_inner())
    }

    pub fn set_org_theme(&self, theme: crate::model::ThemeDto) {
        *self
            .inner
            .org_theme
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = theme;
    }

    pub fn set_files_root(&self, path: Option<String>) {
        if let Ok(mut slot) = self.inner.files_root.lock() {
            *slot = path;
        }
    }

    #[cfg(debug_assertions)]
    pub fn set_dev_hold_link(&self, hold: bool) {
        self.inner.dev_hold_link.store(hold, Ordering::SeqCst);
    }

    #[cfg(debug_assertions)]
    pub fn dev_hold_link(&self) -> bool {
        self.inner.dev_hold_link.load(Ordering::SeqCst)
    }

    /// A web app asked for a permission or a download it may not have. `kind` is the permission it
    /// asked for (`None`: a refusal that is no permission, such as a blocked file type; it only
    /// counts in the app's total).
    pub fn note_web_denial(&self, app_id: &str, kind: Option<crate::webapp::permissions::DenialKind>) {
        if let Ok(mut counts) = self.inner.web_denials.lock() {
            let total = counts.entry(app_id.to_string()).or_insert(0);
            *total = total.saturating_add(1);
        }
        if let Some(kind) = kind {
            if let Ok(mut counts) = self.inner.denial_counts.lock() {
                let count = counts.entry((app_id.to_string(), kind.wire().to_string())).or_insert(0);
                *count = count.saturating_add(1);
            }
        }
    }

    /// The next report for the agent: at most 100 entries of at most 10,000 each; what does not fit
    /// stays for the next one. The caller gives them back with [`Self::restore_denial_counts`] when
    /// the agent could not take them.
    pub fn take_denial_counts(&self) -> Vec<rulebox_ipc::requests::DenialCount> {
        use rulebox_ipc::requests::{DenialCount, MAX_DENIAL_COUNT, MAX_DENIAL_ENTRIES};

        let Ok(mut counts) = self.inner.denial_counts.lock() else {
            return Vec::new();
        };
        let keys: Vec<(String, String)> = counts.keys().take(MAX_DENIAL_ENTRIES).cloned().collect();
        let mut report = Vec::with_capacity(keys.len());
        for key in keys {
            let total = counts.get(&key).copied().unwrap_or(0);
            let send = u64::from(total).min(MAX_DENIAL_COUNT);
            if send > 0 {
                report.push(DenialCount { app_id: key.0.clone(), kind: key.1.clone(), count: send });
            }
            match u64::from(total).checked_sub(send).filter(|rest| *rest > 0) {
                Some(rest) => {
                    counts.insert(key, u32::try_from(rest).unwrap_or(u32::MAX));
                }
                None => {
                    counts.remove(&key);
                }
            }
        }
        report
    }

    /// Gives counts back that the agent did not take (it was unreachable); they are added to
    /// whatever was counted meanwhile.
    pub fn restore_denial_counts(&self, report: Vec<rulebox_ipc::requests::DenialCount>) {
        if let Ok(mut counts) = self.inner.denial_counts.lock() {
            for entry in report {
                let count = counts.entry((entry.app_id, entry.kind)).or_insert(0);
                *count = count.saturating_add(u32::try_from(entry.count).unwrap_or(u32::MAX));
            }
        }
    }

    /// How many `(app, permission)` pairs wait for a report.
    pub fn pending_denial_pairs(&self) -> usize {
        self.inner.denial_counts.lock().map_or(0, |counts| counts.len())
    }

    /// Reports the waiting counts in the background (log out calls this: plan 4.12, "at sign-out").
    pub fn flush_denials_soon(&self) {
        if self.pending_denial_pairs() == 0 {
            return;
        }
        let state = self.clone();
        spawn_bg(async move { flush_denials(&state).await });
    }

    pub fn web_denials(&self, app_id: &str) -> u32 {
        self.inner
            .web_denials
            .lock()
            .ok()
            .and_then(|counts| counts.get(app_id).copied())
            .unwrap_or(0)
    }

    pub fn files(&self) -> Arc<crate::files::FilesHub> {
        Arc::clone(&self.inner.files)
    }

    #[allow(dead_code)]
    pub fn files_root(&self) -> Option<String> {
        self.inner
            .files_root
            .lock()
            .ok()
            .and_then(|slot| slot.clone())
    }

    pub fn bind_app(&self, app: AppHandle) {
        if let Ok(mut slot) = self.inner.app.lock() {
            *slot = Some(app);
        }
    }

    pub fn app_handle(&self) -> Option<AppHandle> {
        self.inner.app.lock().ok().and_then(|slot| slot.clone())
    }

    pub fn agent(&self) -> Arc<dyn AgentPort> {
        Arc::clone(&self.inner.agent)
    }

    pub fn snapshot(&self) -> ShellState {
        self.inner
            .shell
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// The state as the windows get it: app icons are kept in the icon store and
    /// the catalogue carries a short address for each, so a change to anything
    /// does not send every icon to every window again.
    pub fn wire_snapshot(&self) -> ShellState {
        let mut state = self.snapshot();
        let icons = self.app_handle().and_then(|app| {
            app.try_state::<crate::tasks::TaskServices>()
                .map(|services| Arc::clone(&services.icons))
        });
        if let Some(icons) = icons {
            for app in &mut state.apps.items {
                if let Some(short) = app.icon_url.as_deref().and_then(|url| icons.intern_app_icon(url)) {
                    app.icon_url = Some(short);
                }
            }
        }
        state
    }

    /// Look at the shell state without cloning it.
    pub fn read<R>(&self, f: impl FnOnce(&ShellState) -> R) -> R {
        let shell = self.inner.shell.lock().unwrap_or_else(|e| e.into_inner());
        f(&shell)
    }

    /// Mutate shell state and schedule a coalesced `shell://state` emit.
    pub fn update<F>(&self, f: F)
    where
        F: FnOnce(&mut ShellState),
    {
        self.modify(f);
    }

    /// Like `update`, and hands back what `f` decided. The decision and the
    /// change happen under one lock, so nothing can slip in between.
    pub fn modify<F, R>(&self, f: F) -> R
    where
        F: FnOnce(&mut ShellState) -> R,
    {
        let result = {
            let mut shell = self.inner.shell.lock().unwrap_or_else(|e| e.into_inner());
            f(&mut shell)
        };
        self.schedule_emit();
        result
    }

    pub fn mark_ui_alive(&self) {
        if let Ok(mut slot) = self.inner.last_ui_alive.lock() {
            *slot = Some(Instant::now());
        }
    }

    /// How long ago the desktop page last said it was alive; `None` before the first time.
    pub fn ui_alive_age(&self) -> Option<Duration> {
        self.inner.last_ui_alive.lock().ok().and_then(|slot| slot.map(|at| at.elapsed()))
    }

    pub fn ui_alive_recent(&self) -> bool {
        let Ok(slot) = self.inner.last_ui_alive.lock() else {
            return false;
        };
        slot.is_some_and(|at| at.elapsed() <= UI_ALIVE_WINDOW)
    }

    pub fn clear_ready_sent(&self) {
        self.inner.ready_sent.store(false, Ordering::SeqCst);
    }

    pub fn take_ready_slot(&self) -> bool {
        !self
            .inner
            .ready_sent
            .swap(true, Ordering::SeqCst)
    }

    pub fn notify(&self, tone: NoticeTone, title: impl Into<String>, detail: Option<String>) {
        let id = self.inner.notice_seq.fetch_add(1, Ordering::Relaxed);
        let at_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let item = NoticeItem {
            id,
            tone,
            title: title.into(),
            detail,
            at_ms,
            unread: true,
        };
        self.update(|s| {
            s.notices.push(item);
            if s.notices.len() > 20 {
                let drain = s.notices.len() - 20;
                s.notices.drain(0..drain);
            }
        });
    }

    /// The bell's count drops when quick settings is opened.
    pub fn mark_notices_read(&self) {
        let any = self.read(|shell| shell.notices.iter().any(|notice| notice.unread));
        if !any {
            return;
        }
        self.update(|shell| {
            for notice in &mut shell.notices {
                notice.unread = false;
            }
        });
    }

    pub fn dismiss_notice(&self, id: u32) {
        self.update(|s| {
            s.notices.retain(|n| n.id != id);
        });
    }

    pub fn emit_count(&self) -> u64 {
        self.inner.emit_count.load(Ordering::SeqCst)
    }

    fn schedule_emit(&self) {
        let now = Instant::now();
        let mut last = self
            .inner
            .coalesce_last
            .lock()
            .unwrap_or_else(|e| e.into_inner());

        match *last {
            Some(prev) if now.duration_since(prev) < EMIT_COALESCE => {
                let wait = EMIT_COALESCE.saturating_sub(now.duration_since(prev));
                if self
                    .inner
                    .coalesce_pending
                    .swap(true, Ordering::SeqCst)
                {
                    return;
                }
                drop(last);
                let state = self.clone();
                spawn_bg(async move {
                    tokio::time::sleep(wait).await;
                    state.flush_emit();
                });
            }
            _ => {
                *last = Some(now);
                self.inner.coalesce_pending.store(false, Ordering::SeqCst);
                drop(last);
                self.flush_emit();
            }
        }
    }

    fn flush_emit(&self) {
        self.inner.coalesce_pending.store(false, Ordering::SeqCst);
        if let Ok(mut last) = self.inner.coalesce_last.lock() {
            *last = Some(Instant::now());
        }

        self.inner.emit_count.fetch_add(1, Ordering::SeqCst);

        let app = {
            let Ok(slot) = self.inner.app.lock() else {
                return;
            };
            slot.clone()
        };
        let Some(app) = app else {
            return;
        };

        // Serialized once, not once per window.
        let payload = match serde_json::value::to_raw_value(&self.wire_snapshot()) {
            Ok(raw) => raw,
            Err(error) => {
                tracing::warn!(%error, "could not serialize the shell state");
                return;
            }
        };
        for window in app.webview_windows().values() {
            let label = window.label();
            if label.starts_with("shell-") || label.starts_with("app-") {
                if let Err(error) = window.emit("shell://state", &payload) {
                    tracing::warn!(label, %error, "failed to emit shell://state");
                }
            }
        }
        // The administrator-exit dialog has its own small page and its own event.
        crate::exit::push_if_changed(&app, self);
        // The lock and the full-screen notice also cover the other monitors: those windows follow
        // the state here, and do nothing when nothing they depend on changed.
        crate::covers::follow_state(&app, self);
    }
}

/// How often the waiting denial counters are reported to the agent (plan 4.12: at most once per 60 s).
pub const DENIAL_FLUSH_INTERVAL: Duration = Duration::from_secs(60);

/// Reports the waiting denial counters every `every`, forever (the app starts it once).
pub async fn run_denial_flush(state: AppState, every: Duration) {
    let mut ticker = tokio::time::interval(every);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    // The first tick is immediate and has nothing to say.
    ticker.tick().await;
    loop {
        ticker.tick().await;
        flush_denials(&state).await;
    }
}

/// Sends the waiting per-app denial counters to the agent (`webapp.reportDenials`). One report at a
/// time. An agent without the capability (1.2) keeps them waiting; so does one that cannot be reached.
pub async fn flush_denials(state: &AppState) {
    use rulebox_ipc::CAP_PERMISSION_REPORTS;

    if state.inner.denial_flush_running.swap(true, Ordering::SeqCst) {
        return;
    }
    let agent = state.agent();
    let counts = if agent.capabilities().iter().any(|capability| capability == CAP_PERMISSION_REPORTS) {
        state.take_denial_counts()
    } else {
        Vec::new()
    };
    if !counts.is_empty() {
        match agent.report_denials(counts.clone()).await {
            Ok(()) => tracing::debug!(entries = counts.len(), "reported the web app denial counters"),
            Err(error) => {
                tracing::debug!(?error, "could not report the denial counters; they are kept");
                state.restore_denial_counts(counts);
            }
        }
    }
    state.inner.denial_flush_running.store(false, Ordering::SeqCst);
}

/// Spawn a future on the current Tokio handle, or on Tauri's runtime.
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

/// Spawn the link/snapshot mirror and the UI heartbeat timer.
pub fn spawn_agent_tasks(state: AppState) {
    let link_state = state.clone();
    spawn_bg(async move {
        mirror_agent(link_state).await;
    });

    // Subscribe now, not inside the task, so no push is missed while it starts.
    let event_state = state.clone();
    let events = state.agent().events();
    spawn_bg(async move {
        pump_agent_events(event_state, events).await;
    });

    // (Phase 5 Step 12) The web apps' denial counters go to the agent once a minute, and at log out.
    let flush_state = state.clone();
    spawn_bg(async move {
        run_denial_flush(flush_state, DENIAL_FLUSH_INTERVAL).await;
    });

    let beat_state = state;
    spawn_bg(async move {
        let mut ticker = tokio::time::interval(HEARTBEAT_INTERVAL);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            ticker.tick().await;
            if !beat_state.ui_alive_recent() {
                continue;
            }
            let agent = beat_state.agent();
            if let Err(error) = agent.heartbeat().await {
                tracing::debug!(?error, "shell.heartbeat failed");
            }
        }
    });
}

/// Run `fut` in the background and return a handle that cancels it.
fn spawn_abortable<F>(fut: F) -> AbortHandle
where
    F: std::future::Future<Output = ()> + Send + 'static,
{
    let (fut, handle) = abortable(fut);
    spawn_bg(async move {
        let _ = fut.await;
    });
    handle
}

/// Protocol 1.2 pushes, read in order. `session.ended` is handled right here
/// and never waits for a catalogue call: a refresh (`apps.list` can hang for
/// its whole 10 s timeout) runs as its own task, and the end of the session
/// cancels it first.
pub async fn pump_agent_events(
    state: AppState,
    mut events: tokio::sync::broadcast::Receiver<crate::model::AgentEvent>,
) {
    use crate::model::{AgentEvent, SessionEndedReason};
    use tokio::sync::broadcast::error::RecvError;

    let mut refresh: Option<AbortHandle> = None;
    let start_refresh = |refresh: &mut Option<AbortHandle>| {
        // A newer refresh supersedes one that is still running.
        if let Some(running) = refresh.take() {
            running.abort();
        }
        let state = state.clone();
        *refresh = Some(spawn_abortable(async move {
            crate::session::refresh_catalogue_quietly(&state).await;
        }));
    };

    loop {
        match events.recv().await {
            Ok(AgentEvent::AppsChanged) => start_refresh(&mut refresh),
            Ok(AgentEvent::SessionEnded(reason)) => {
                if let Some(running) = refresh.take() {
                    running.abort();
                }
                crate::commands::end_session_from_agent(&state, reason).await;
            }
            // The snapshot that carries the lock or the list arrives on its own channel and is
            // applied there; these two events only say "look again", which is already done.
            Ok(AgentEvent::DeviceLockChanged | AgentEvent::BroadcastsChanged) => {
                tracing::debug!("the agent says its lock or broadcasts changed");
            }
            Ok(AgentEvent::ProgramBlocked(name)) => {
                // Plain text, already cut by the agent; shown as a notice, never as HTML.
                state.notify(
                    crate::model::NoticeTone::Warning,
                    format!("{name} was stopped."),
                    Some("That program is not allowed on this PC.".to_string()),
                );
            }
            Err(RecvError::Lagged(missed)) => {
                // Rare. A lost `apps.changed` is cured by asking again. A lost
                // `session.ended` is found by asking the agent whether it still
                // has this session (its own task: the question can take a while).
                tracing::warn!(missed, "agent events were dropped; checking the session");
                start_refresh(&mut refresh);
                let state = state.clone();
                spawn_bg(async move {
                    crate::session::verify_session(&state, SessionEndedReason::Unknown).await;
                });
            }
            Err(RecvError::Closed) => break,
        }
    }
    if let Some(running) = refresh.take() {
        running.abort();
    }
}

async fn mirror_agent(state: AppState) {
    let agent = state.agent();
    let mut link_rx = agent.link();
    let mut snap_rx = agent.snapshot();

    // Apply current values once.
    apply_link(&state, *link_rx.borrow());
    apply_snapshot(&state, snap_rx.borrow().clone());

    loop {
        tokio::select! {
            result = link_rx.changed() => {
                if result.is_err() {
                    break;
                }
                apply_link(&state, *link_rx.borrow());
            }
            result = snap_rx.changed() => {
                if result.is_err() {
                    break;
                }
                apply_snapshot(&state, snap_rx.borrow().clone());
            }
        }
    }
}

fn apply_link(state: &AppState, link: crate::model::AgentLink) {
    use crate::model::AgentLinkDto;

    #[cfg(debug_assertions)]
    if state.dev_hold_link() {
        return;
    }

    match link {
        AgentLinkDto::Disconnected | AgentLinkDto::Connecting | AgentLinkDto::VersionMismatch => {
            state.clear_ready_sent();
        }
        AgentLinkDto::Linked => {}
    }

    let caps = state.agent().capabilities();
    state.update(|s| {
        s.link = link;
        s.capabilities = caps;
        if !matches!(link, AgentLinkDto::Linked) {
            s.agent = None;
        }
    });

    // Pushes sent while the pipe was down are gone for good. An employee who is
    // shown as signed in when the link comes back is checked against the agent.
    if matches!(link, AgentLinkDto::Linked)
        && state.read(|s| matches!(s.session, crate::model::SessionState::SignedIn { .. }))
    {
        let state = state.clone();
        spawn_bg(async move {
            crate::session::verify_session(&state, crate::model::SessionEndedReason::Unknown).await;
        });
    }
}

pub fn apply_snapshot(state: &AppState, snap: Option<rulebox_ipc::types::AgentSnapshot>) {
    use crate::model::{agent_summary_from_snapshot, notices_from_snapshot, AgentLinkDto};
    use rulebox_ipc::types::DisplayMode;

    #[cfg(debug_assertions)]
    if state.dev_hold_link() {
        return;
    }

    // "Open with" and handler launches read this table; it follows every snapshot.
    if let Some(ref snap) = snap {
        let handlers = snap
            .desired_state
            .as_ref()
            .map(crate::files::openwith::handlers_from_desired)
            .unwrap_or_default();
        if handlers != state.files().handlers() {
            state.files().set_handlers(handlers);
        }
    }

    let lock_changed = state.modify(|s| {
        match snap {
            Some(ref snap) => {
                s.agent = Some(agent_summary_from_snapshot(snap));
                s.display.lite = matches!(snap.display_mode, DisplayMode::Lite);
                if s.link == AgentLinkDto::Linked && s.capabilities.is_empty() {
                    // keep capabilities from hello; snapshot does not carry them
                }
                // (1.3) The lock, the broadcasts and the printing fact follow the snapshot. A 1.2 agent
                // has none of them: no lock, no list.
                let (lock, broadcasts, printing) = notices_from_snapshot(snap);
                let changed = lock.is_some() && lock != s.device_lock;
                s.device_lock = lock;
                s.broadcasts = broadcasts;
                s.printing_available = printing;
                changed
            }
            None => {
                if s.link != AgentLinkDto::Linked {
                    s.agent = None;
                }
                // The pipe dropped: nothing is known to have changed. A lock never lifts because the
                // link did, and the notices stay as they were until a snapshot says otherwise.
                false
            }
        }
    });
    if lock_changed {
        // A lock ends the employee session here at once; the agent ends its own (Step 15) and may
        // say so too, which finds nobody signed in and does nothing.
        let state = state.clone();
        spawn_bg(async move {
            crate::commands::end_session_from_agent(&state, crate::model::SessionEndedReason::DeviceLocked).await;
        });
    }
}
