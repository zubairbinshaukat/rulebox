//! Limits on open web app windows (Phase 6 Step 19, plan 4.14, PRD 22.4).
//!
//! * **Window cap**: Lite 3, Standard 8, an administrator's group setting 1 to 12. At the cap the employee is asked which window
//!   to close; nothing is ever closed silently.
//! * **Idle close**: a web app window that is hidden (minimized), silent and without input for the configured time is closed. Its
//!   tile keeps a "paused" mark; opening it starts again at the app's address. One coarse timer (once a minute); it never closes a
//!   window that plays audio, may be capturing the camera, the microphone or the screen, or has a dialog (a file picker) open.
//!
//! Everything that decides is pure and tested; `webapp/mod.rs` and `hooks.rs` feed the facts, [`spawn_ticker`] is the timer.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Default most windows open at once in Lite mode.
pub const LITE_CAP: usize = 3;
/// Default most windows open at once in Standard mode.
pub const STANDARD_CAP: usize = 8;
/// An administrator's cap lies in this range; anything else is ignored.
pub const CAP_RANGE: std::ops::RangeInclusive<u32> = 1..=12;
/// Lite closes a hidden, silent window after this many minutes by default; Standard never does.
pub const LITE_IDLE_MIN: u32 = 30;
/// An administrator's idle time lies in this range (0 = off).
pub const IDLE_RANGE: std::ops::RangeInclusive<u32> = 5..=240;
/// How often the idle close looks: once a minute.
pub const TICK: Duration = Duration::from_secs(60);

/// What the agent put in the snapshot (`webWindowCap`, `webIdleCloseMin`). `None`: an older agent.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SentLimits {
    pub cap: Option<u32>,
    pub idle_close_min: Option<u32>,
}

/// The cap that applies: the agent's value when it is in 1 to 12, else the default of the mode.
pub fn effective_cap(lite: bool, sent: Option<u32>) -> usize {
    match sent.filter(|cap| CAP_RANGE.contains(cap)) {
        Some(cap) => cap as usize,
        None if lite => LITE_CAP,
        None => STANDARD_CAP,
    }
}

/// How long a window may stay hidden and silent; `None` = never closed for idleness (0 minutes, or Standard without a setting).
pub fn effective_idle(lite: bool, sent: Option<u32>) -> Option<Duration> {
    let minutes = match sent {
        Some(0) => return None,
        Some(min) if IDLE_RANGE.contains(&min) => min,
        _ if lite => LITE_IDLE_MIN,
        _ => return None,
    };
    Some(Duration::from_secs(u64::from(minutes) * 60))
}

/// Opening one more window would pass the cap.
pub fn at_cap(open: usize, cap: usize) -> bool {
    open >= cap
}

/// What the Staff App learns about one web window, as shared flags (the window's own handlers write them).
#[derive(Debug, Default)]
pub struct Activity {
    /// Since when the window has been minimized (`None`: it is on screen).
    hidden_since: Mutex<Option<Instant>>,
    /// The last time the page started or stopped playing audio.
    audio_changed: Mutex<Option<Instant>>,
    audible: AtomicBool,
    /// The page was given the camera, the microphone or the screen: it may still be using it, and WebView2 does not say.
    /// Conservative: the flag stays for the life of the window.
    capturing: AtomicBool,
}

impl Activity {
    /// The window was minimized (`true`) or shown again (`false`).
    pub fn set_hidden(&self, hidden: bool, now: Instant) {
        let mut since = self.hidden_since.lock().unwrap_or_else(|e| e.into_inner());
        match (hidden, since.is_some()) {
            (true, false) => *since = Some(now),
            (false, true) => *since = None,
            _ => {}
        }
    }

    /// The page started or stopped playing audio.
    pub fn set_audible(&self, audible: bool, now: Instant) {
        if self.audible.swap(audible, Ordering::SeqCst) != audible {
            *self.audio_changed.lock().unwrap_or_else(|e| e.into_inner()) = Some(now);
        }
    }

    /// The page was allowed to capture (camera, microphone or screen).
    pub fn mark_capture(&self) {
        self.capturing.store(true, Ordering::SeqCst);
    }

    pub fn audible(&self) -> bool {
        self.audible.load(Ordering::SeqCst)
    }

    pub fn capturing(&self) -> bool {
        self.capturing.load(Ordering::SeqCst)
    }

    /// How long the window has been hidden and silent: `None` while it is on screen or playing audio. A window that stopped
    /// playing audio only a moment ago has been quiet for that moment (a hidden page that was suspended goes silent too).
    pub fn quiet_for(&self, now: Instant) -> Option<Duration> {
        let hidden = (*self.hidden_since.lock().unwrap_or_else(|e| e.into_inner()))?;
        if self.audible() {
            return None;
        }
        let since = match *self.audio_changed.lock().unwrap_or_else(|e| e.into_inner()) {
            Some(changed) if changed > hidden => changed,
            _ => hidden,
        };
        Some(now.saturating_duration_since(since))
    }
}

/// One open web window as the idle close sees it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WindowFacts {
    pub label: String,
    pub app_id: String,
    /// Hidden and silent for this long; `None` = on screen or playing audio.
    pub quiet_for: Option<Duration>,
    pub capturing: bool,
    /// A dialog (a file picker, a print dialog) is open over the window.
    pub modal_open: bool,
}

/// The windows to close: hidden and silent for at least `idle`, with no capture and no dialog open.
pub fn idle_candidates(facts: &[WindowFacts], idle: Duration) -> Vec<&WindowFacts> {
    facts
        .iter()
        .filter(|f| f.quiet_for.is_some_and(|quiet| quiet >= idle) && !f.capturing && !f.modal_open)
        .collect()
}

/// A cleaned-up timer: dropping the guard stops it (the app's managed state drops it at exit).
pub struct Ticker {
    handle: tauri::async_runtime::JoinHandle<()>,
}

impl Drop for Ticker {
    fn drop(&mut self) {
        self.handle.abort();
    }
}

/// Runs `on_tick` every `every` (the first run after one period) until the guard is dropped. The one timer of the idle close.
pub fn spawn_ticker<F>(every: Duration, mut on_tick: F) -> Ticker
where
    F: FnMut() + Send + 'static,
{
    let handle = tauri::async_runtime::spawn(async move {
        let mut ticker = tokio::time::interval(every);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        // The first tick is immediate and has nothing to say.
        ticker.tick().await;
        loop {
            ticker.tick().await;
            on_tick();
        }
    });
    Ticker { handle }
}
