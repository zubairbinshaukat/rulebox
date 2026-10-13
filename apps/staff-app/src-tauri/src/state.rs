//! `AppState`: the one Mutex shell snapshot, plus agent bookkeeping React never sees.
//! Emissions of `shell://state` are coalesced to at most one per 50 ms.

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

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
}

impl AppState {
    pub fn new(agent: Arc<dyn AgentPort>, initial: ShellState) -> Self {
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
            }),
        }
    }

    pub fn bind_app(&self, app: AppHandle) {
        if let Ok(mut slot) = self.inner.app.lock() {
            *slot = Some(app);
        }
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

    /// Mutate shell state and schedule a coalesced `shell://state` emit.
    pub fn update<F>(&self, f: F)
    where
        F: FnOnce(&mut ShellState),
    {
        {
            let mut shell = self.inner.shell.lock().unwrap_or_else(|e| e.into_inner());
            f(&mut shell);
        }
        self.schedule_emit();
    }

    pub fn mark_ui_alive(&self) {
        if let Ok(mut slot) = self.inner.last_ui_alive.lock() {
            *slot = Some(Instant::now());
        }
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

    #[allow(dead_code)] // Notices UI is Step 10; API is ready now.
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
        };
        self.update(|s| {
            s.notices.push(item);
            if s.notices.len() > 20 {
                let drain = s.notices.len() - 20;
                s.notices.drain(0..drain);
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

        let payload = self.snapshot();
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

        for window in app.webview_windows().values() {
            let label = window.label();
            if label.starts_with("shell-") || label.starts_with("app-") {
                if let Err(error) = window.emit("shell://state", &payload) {
                    tracing::warn!(label, %error, "failed to emit shell://state");
                }
            }
        }
    }
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
}

fn apply_snapshot(state: &AppState, snap: Option<rulebox_ipc::types::AgentSnapshot>) {
    use crate::model::{agent_summary_from_snapshot, AgentLinkDto};
    use rulebox_ipc::types::DisplayMode;

    state.update(|s| {
        match snap {
            Some(ref snap) => {
                s.agent = Some(agent_summary_from_snapshot(snap));
                s.display.lite = matches!(snap.display_mode, DisplayMode::Lite);
                if s.link == AgentLinkDto::Linked && s.capabilities.is_empty() {
                    // keep capabilities from hello; snapshot does not carry them
                }
            }
            None => {
                if s.link != AgentLinkDto::Linked {
                    s.agent = None;
                }
            }
        }
    });
}
