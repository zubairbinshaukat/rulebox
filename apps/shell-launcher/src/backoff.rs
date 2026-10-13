//! Crash-loop logic for the Staff App (plan Section 6.9). Pure: no clock of its
//! own, no Windows types.
//!
//! * Exit code 0 means "start me again now" and is never counted.
//! * Any other exit code is a crash. Delays between restarts: 500 ms, 1 s, 2 s,
//!   then 5 s. The fifth crash within 60 seconds is `Fallback`.
//! * A run that lasted 60 seconds (or a quiet minute) forgets the earlier crashes.
//! * After a `Fallback` the next crash inside the window shows the fallback again
//!   at once. That makes "Try again" and the 30-second retry exactly one launch
//!   attempt each instead of five flashing restarts behind the fallback screen.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

/// Crashes older than this are forgotten; a run this long resets the delays.
pub const WINDOW: Duration = Duration::from_secs(60);
/// The crash that reaches this count inside `WINDOW` triggers the fallback.
pub const CRASHES_BEFORE_FALLBACK: usize = 5;

const DELAYS: [Duration; 4] = [
    Duration::from_millis(500),
    Duration::from_secs(1),
    Duration::from_secs(2),
    Duration::from_secs(5),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Next {
    RestartNow,
    RestartAfter(Duration),
    Fallback,
}

#[derive(Debug, Default)]
pub struct CrashTracker {
    /// Times of the non-zero exits that are still inside `WINDOW`.
    crashes: VecDeque<Instant>,
    /// When the current run started (`record_start`); lets a long run reset the delays.
    last_start: Option<Instant>,
    /// True after a `Fallback` until a good run or a quiet minute clears it.
    tripped: bool,
}

impl CrashTracker {
    pub fn new() -> Self {
        Self::default()
    }

    /// Call right before each launch. Optional: without it only the quiet-minute
    /// rule resets the delays.
    pub fn record_start(&mut self, now: Instant) {
        self.last_start = Some(now);
    }

    /// Crashes currently inside the window (for the fallback text).
    pub fn recent_crashes(&self) -> usize {
        self.crashes.len()
    }

    /// Records the end of a run and says what to do next.
    pub fn record_exit(&mut self, exit_code: u32, now: Instant) -> Next {
        if exit_code == 0 {
            return Next::RestartNow;
        }
        while let Some(&oldest) = self.crashes.front() {
            if now.saturating_duration_since(oldest) >= WINDOW {
                self.crashes.pop_front();
            } else {
                break;
            }
        }
        let long_run = self.last_start.is_some_and(|s| now.saturating_duration_since(s) >= WINDOW);
        if long_run {
            self.crashes.clear();
        }
        if self.crashes.is_empty() {
            self.tripped = false;
        }
        self.crashes.push_back(now);

        let count = self.crashes.len();
        if self.tripped || count >= CRASHES_BEFORE_FALLBACK {
            self.tripped = true;
            return Next::Fallback;
        }
        Next::RestartAfter(DELAYS[(count - 1).min(DELAYS.len() - 1)])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn secs(base: Instant, s: u64) -> Instant {
        base + Duration::from_secs(s)
    }

    #[test]
    fn exit_zero_always_restarts_now_and_is_not_counted() {
        let t0 = Instant::now();
        let mut tracker = CrashTracker::new();
        for i in 0..3 {
            assert_eq!(tracker.record_exit(0, secs(t0, i)), Next::RestartNow);
        }
        assert_eq!(tracker.recent_crashes(), 0);
        // Zeros in between do not hide crashes either.
        for i in 0..4 {
            assert!(matches!(tracker.record_exit(1, secs(t0, 10 + i)), Next::RestartAfter(_)));
            assert_eq!(tracker.record_exit(0, secs(t0, 10 + i)), Next::RestartNow);
        }
        assert_eq!(tracker.record_exit(1, secs(t0, 20)), Next::Fallback);
    }

    #[test]
    fn delays_are_500ms_1s_2s_5s_and_the_fifth_crash_falls_back() {
        let t0 = Instant::now();
        let mut tracker = CrashTracker::new();
        let got: Vec<Next> = (0..5).map(|i| tracker.record_exit(1, secs(t0, i * 2))).collect();
        assert_eq!(
            got,
            vec![
                Next::RestartAfter(Duration::from_millis(500)),
                Next::RestartAfter(Duration::from_secs(1)),
                Next::RestartAfter(Duration::from_secs(2)),
                Next::RestartAfter(Duration::from_secs(5)),
                Next::Fallback,
            ]
        );
    }

    #[test]
    fn five_crashes_in_ten_seconds_fall_back_on_the_fifth() {
        let t0 = Instant::now();
        let mut tracker = CrashTracker::new();
        for i in 0..4 {
            assert!(matches!(tracker.record_exit(1, secs(t0, i * 2)), Next::RestartAfter(_)));
        }
        assert_eq!(tracker.record_exit(1, secs(t0, 8)), Next::Fallback);
    }

    #[test]
    fn four_crashes_then_a_quiet_minute_then_one_crash_is_not_a_fallback() {
        let t0 = Instant::now();
        let mut tracker = CrashTracker::new();
        for i in 0..4 {
            tracker.record_exit(1, secs(t0, i));
        }
        assert_eq!(
            tracker.record_exit(1, secs(t0, 3 + 61)),
            Next::RestartAfter(Duration::from_millis(500))
        );
    }

    #[test]
    fn a_run_of_sixty_seconds_resets_the_delays() {
        let t0 = Instant::now();
        let mut tracker = CrashTracker::new();
        tracker.record_start(t0);
        tracker.record_exit(1, secs(t0, 1));
        tracker.record_exit(1, secs(t0, 3));
        assert_eq!(tracker.recent_crashes(), 2);
        // The next run lasts 60 s: crashes before it no longer count.
        tracker.record_start(secs(t0, 4));
        assert_eq!(
            tracker.record_exit(1, secs(t0, 4 + 60)),
            Next::RestartAfter(Duration::from_millis(500))
        );
        assert_eq!(tracker.recent_crashes(), 1);
    }

    #[test]
    fn after_a_fallback_one_more_crash_shows_it_again_until_a_quiet_minute() {
        let t0 = Instant::now();
        let mut tracker = CrashTracker::new();
        for i in 0..5 {
            tracker.record_exit(1, secs(t0, i));
        }
        // "Try again" 30 s later: one launch, one crash, fallback again.
        assert_eq!(tracker.record_exit(1, secs(t0, 34)), Next::Fallback);
        assert_eq!(tracker.record_exit(1, secs(t0, 64)), Next::Fallback);
        // Nothing crashed for a minute: normal delays again.
        assert_eq!(
            tracker.record_exit(1, secs(t0, 64 + 61)),
            Next::RestartAfter(Duration::from_millis(500))
        );
    }

    #[test]
    fn a_long_run_clears_the_tripped_state() {
        let t0 = Instant::now();
        let mut tracker = CrashTracker::new();
        for i in 0..5 {
            tracker.record_exit(1, secs(t0, i));
        }
        tracker.record_start(secs(t0, 30));
        assert_eq!(
            tracker.record_exit(1, secs(t0, 30 + 60)),
            Next::RestartAfter(Duration::from_millis(500))
        );
    }
}
