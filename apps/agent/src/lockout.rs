//! Rate limiting and lockout for the exit PIN and for employee passwords (plan
//! Sections 5.9 and 5.10). The counters are persisted in `lockouts.json`, so
//! restarting the agent never gives a free guess; the device-wide guard for
//! passwords is memory only.
//!
//! Times are wall-clock milliseconds (`state::unix_ms`). A clock that moves back
//! never shortens a lock.

use std::collections::{BTreeMap, VecDeque};
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::state::{read_json, write_atomic};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LockPolicy {
    /// Consecutive failures that are answered without a lock.
    pub free_failures: u32,
    /// Lock durations; failure number `n` uses
    /// `lock_ms[min(n - free_failures - 1, len - 1)]`.
    pub lock_ms: &'static [u64],
    /// Failures are forgotten after this long without a new one.
    pub forget_after_ms: Option<u64>,
}

/// Employee passwords: 4 free failures, then 30 s, 1 min, 5 min, 15 min (and
/// 15 min again). Forgotten after 30 minutes.
pub const PASSWORD_POLICY: LockPolicy = LockPolicy {
    free_failures: 4,
    lock_ms: &[30_000, 60_000, 300_000, 900_000],
    forget_after_ms: Some(1_800_000),
};

/// The exit PIN: 4 free failures, then 1, 5, 15, 30 and 60 minutes (60 again).
/// Never forgotten by waiting.
pub const PIN_POLICY: LockPolicy = LockPolicy {
    free_failures: 4,
    lock_ms: &[60_000, 300_000, 900_000, 1_800_000, 3_600_000],
    forget_after_ms: None,
};

/// An employee entry that is not locked is dropped from the file once its last
/// failure is older than this.
const EMPLOYEE_ENTRY_TTL_MS: u64 = 1_800_000;

/// The state of one counter (one per username, one for the exit PIN).
#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct Counter {
    pub failures: u32,
    pub last_failure_ms: u64,
    pub locked_at_ms: u64,
    pub lock_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Gate {
    /// The attempt may be checked. `attempts_left` counts attempts up to and
    /// including the one that would start a lock; 0 only right after a lock ended.
    Open { attempts_left: u32 },
    Locked { retry_after_ms: u64 },
}

impl Counter {
    /// Milliseconds the lock still lasts at `now_ms`, if it does. Read-only (the
    /// clock rule of [`gate`](Self::gate) is not applied), for `status`.
    pub fn locked_for(&self, now_ms: u64) -> Option<u64> {
        if self.lock_ms == 0 {
            return None;
        }
        let ends = self.locked_at_ms.saturating_add(self.lock_ms);
        (now_ms < ends).then(|| ends - now_ms)
    }

    /// Whether an attempt may be checked now. Also applies the clock rule (a
    /// lock that started "in the future" restarts at `now_ms`; the caller saves)
    /// and the forget rule.
    pub fn gate(&mut self, policy: &LockPolicy, now_ms: u64) -> Gate {
        if self.lock_ms > 0 && now_ms < self.locked_at_ms {
            self.locked_at_ms = now_ms;
        }
        if let Some(retry_after_ms) = self.locked_for(now_ms) {
            return Gate::Locked { retry_after_ms };
        }
        if let Some(forget) = policy.forget_after_ms {
            if self.failures > 0 && now_ms.saturating_sub(self.last_failure_ms) >= forget {
                self.clear();
            }
        }
        Gate::Open { attempts_left: (policy.free_failures + 1).saturating_sub(self.failures) }
    }

    /// Counts one failure and returns the state AFTER it.
    pub fn record_failure(&mut self, policy: &LockPolicy, now_ms: u64) -> Gate {
        self.failures = self.failures.saturating_add(1);
        self.last_failure_ms = now_ms;
        if self.failures > policy.free_failures {
            let step = (self.failures - policy.free_failures - 1) as usize;
            if let Some(lock_ms) = policy.lock_ms.get(step.min(policy.lock_ms.len().saturating_sub(1))) {
                self.lock_ms = *lock_ms;
                self.locked_at_ms = now_ms;
                return Gate::Locked { retry_after_ms: *lock_ms };
            }
        }
        Gate::Open { attempts_left: (policy.free_failures + 1).saturating_sub(self.failures) }
    }

    /// Takes back the failure that [`record_failure`](Self::record_failure) counted
    /// first, because the attempt turned out not to be a guess. It is only ever
    /// called after an `Open` gate, so a lock that is still set was started by the
    /// failure being undone (an older lock has already run out): it goes too.
    pub fn undo_failure(&mut self) {
        self.failures = self.failures.saturating_sub(1);
        self.locked_at_ms = 0;
        self.lock_ms = 0;
    }

    pub fn clear(&mut self) {
        *self = Self::default();
    }

    pub fn is_locked(&self, now_ms: u64) -> bool {
        self.locked_for(now_ms).is_some()
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
struct LockoutFile {
    schema: u32,
    admin_exit: Counter,
    admin_exit_pin_id: Option<String>,
    employees: BTreeMap<String, Counter>,
}

impl Default for LockoutFile {
    fn default() -> Self {
        Self {
            schema: 1,
            admin_exit: Counter::default(),
            admin_exit_pin_id: None,
            employees: BTreeMap::new(),
        }
    }
}

/// `lockouts.json`. Held behind a `std::sync::Mutex`, never across an `.await`.
pub struct LockoutStore {
    path: PathBuf,
    data: LockoutFile,
}

impl LockoutStore {
    /// A missing file is an empty store; a corrupt one is renamed aside
    /// (`state::read_json`) and an empty store is used.
    pub fn open(path: PathBuf) -> std::io::Result<Self> {
        let data = read_json::<LockoutFile>(&path)?.unwrap_or_default();
        Ok(Self { path, data })
    }

    /// The counter of one (already normalized) username; created on first use.
    pub fn employee(&mut self, username: &str) -> &mut Counter {
        self.data.employees.entry(username.to_string()).or_default()
    }

    pub fn admin_exit(&mut self) -> &mut Counter {
        &mut self.data.admin_exit
    }

    /// Which PIN the exit counter belongs to (Step 6b clears the counter when a new
    /// PIN arrives).
    pub fn admin_exit_pin_id(&mut self) -> &mut Option<String> {
        &mut self.data.admin_exit_pin_id
    }

    /// Prunes, then writes the file atomically.
    pub fn save(&mut self, now_ms: u64) -> std::io::Result<()> {
        self.data.employees.retain(|_, counter| {
            counter.failures > 0
                && (counter.is_locked(now_ms)
                    || now_ms.saturating_sub(counter.last_failure_ms) <= EMPLOYEE_ENTRY_TTL_MS)
        });
        let bytes = serde_json::to_vec_pretty(&self.data).map_err(std::io::Error::other)?;
        write_atomic(&self.path, &bytes)
    }
}

/// How many failed password checks, over all usernames, the guard tolerates in
/// one window.
const GUARD_MAX_FAILURES: usize = 20;
const GUARD_WINDOW_MS: u64 = 600_000;

/// The device-wide guard for passwords (plan Section 5.9): more than 20 failed
/// checks in 10 minutes block every sign-in and password check until the oldest of
/// them is 10 minutes old. Memory only. Bounds guessing across many usernames.
#[derive(Debug, Default)]
pub struct DeviceGuard {
    failures: VecDeque<u64>,
}

impl DeviceGuard {
    /// `Some(retry_after_ms)` while blocked.
    pub fn check(&mut self, now_ms: u64) -> Option<u64> {
        while let Some(oldest) = self.failures.front() {
            if now_ms.saturating_sub(*oldest) >= GUARD_WINDOW_MS && now_ms >= *oldest {
                self.failures.pop_front();
            } else {
                break;
            }
        }
        if self.failures.len() > GUARD_MAX_FAILURES {
            let oldest = *self.failures.front()?;
            return Some(oldest.saturating_add(GUARD_WINDOW_MS).saturating_sub(now_ms).max(1));
        }
        None
    }

    pub fn record_failure(&mut self, now_ms: u64) {
        self.failures.push_back(now_ms);
        // Blocked at 21 entries; the cap only keeps a misuse from growing the queue.
        while self.failures.len() > GUARD_MAX_FAILURES + 5 {
            self.failures.pop_front();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempDir;

    const MIN: u64 = 60_000;

    /// Fails once at `now` the way a sign-in does: gate, then count.
    fn attempt(counter: &mut Counter, policy: &LockPolicy, now: u64) -> Gate {
        match counter.gate(policy, now) {
            locked @ Gate::Locked { .. } => locked,
            Gate::Open { .. } => counter.record_failure(policy, now),
        }
    }

    #[test]
    fn password_policy_escalates_as_specified() {
        let p = &PASSWORD_POLICY;
        let mut c = Counter::default();
        let mut now = 1_000_000;
        for _ in 0..4 {
            assert!(matches!(attempt(&mut c, p, now), Gate::Open { .. }));
            now += 1_000;
        }
        // The 5th failure locks for 30 s.
        assert_eq!(attempt(&mut c, p, now), Gate::Locked { retry_after_ms: 30_000 });
        // During the lock the gate stays shut and counts nothing.
        let during = c.gate(p, now + 10_000);
        assert_eq!(during, Gate::Locked { retry_after_ms: 20_000 });
        assert_eq!(c.failures, 5);
        // 30 s later one more failure: 60 s, then 5 min, 15 min, 15 min.
        for expected in [60_000, 300_000, 900_000, 900_000] {
            now += c.lock_ms;
            assert_eq!(attempt(&mut c, p, now), Gate::Locked { retry_after_ms: expected });
        }
        c.clear();
        assert_eq!(c, Counter::default());
        assert!(matches!(c.gate(p, now), Gate::Open { attempts_left: 5 }));
    }

    #[test]
    fn thirty_minutes_without_a_failure_resets_the_password_counter() {
        let p = &PASSWORD_POLICY;
        let mut c = Counter::default();
        for i in 0..3 {
            c.record_failure(p, 1_000 + i);
        }
        assert_eq!(c.failures, 3);
        // Just short of 30 minutes: still counted.
        assert!(matches!(c.gate(p, 1_002 + 1_800_000 - 1), Gate::Open { attempts_left: 2 }));
        // 30 minutes after the last failure: forgotten.
        assert_eq!(c.gate(p, 1_002 + 1_800_000), Gate::Open { attempts_left: 5 });
        assert_eq!(c, Counter::default());
    }

    #[test]
    fn a_clock_moved_back_keeps_the_full_lock() {
        let p = &PASSWORD_POLICY;
        let mut c = Counter::default();
        let t = 10_000_000;
        for i in 0..5 {
            attempt(&mut c, p, t + i);
        }
        assert!(c.is_locked(t + 10));
        // The clock jumps back an hour: the whole lock time remains, not more, not less.
        let back = t - 3_600_000;
        assert_eq!(c.gate(p, back), Gate::Locked { retry_after_ms: 30_000 });
        assert_eq!(c.locked_at_ms, back);
        assert_eq!(c.gate(p, back + 29_000), Gate::Locked { retry_after_ms: 1_000 });
        assert!(matches!(c.gate(p, back + 30_000), Gate::Open { .. }));
    }

    #[test]
    fn pin_policy_counts_attempts_and_locks_longer_and_never_forgets() {
        let p = &PIN_POLICY;
        let mut c = Counter::default();
        let mut now = 5_000_000;
        // attempts_left after failures 1 to 4 is 4, 3, 2, 1.
        for expected in [4, 3, 2, 1] {
            assert_eq!(attempt(&mut c, p, now), Gate::Open { attempts_left: expected });
            now += 1_000;
        }
        // Lock times 1, 5, 15, 30, 60, 60 minutes.
        for minutes in [1, 5, 15, 30, 60, 60] {
            assert_eq!(attempt(&mut c, p, now), Gate::Locked { retry_after_ms: minutes * MIN });
            now += c.lock_ms;
        }
        // 24 hours without a failure change nothing.
        let later = now + 24 * 3_600_000;
        assert!(matches!(c.gate(p, later), Gate::Open { .. }));
        assert_eq!(c.failures, 10);
        assert_eq!(c.record_failure(p, later), Gate::Locked { retry_after_ms: 60 * MIN });
    }

    #[test]
    fn undo_failure_takes_back_the_count_and_a_lock_it_started() {
        let p = &PASSWORD_POLICY;
        let mut c = Counter::default();
        for i in 0..4 {
            c.record_failure(p, 1_000 + i);
        }
        let before = c.clone();
        // Count first (this one locks), then it turns out not to be a guess.
        assert!(matches!(c.record_failure(p, 2_000), Gate::Locked { .. }));
        c.undo_failure();
        assert_eq!(c.failures, 4);
        assert!(!c.is_locked(2_001));
        assert_eq!(c.last_failure_ms, 2_000);
        let mut reference = before;
        reference.last_failure_ms = 2_000;
        assert_eq!(c, reference);
        // Undoing on an empty counter does not underflow.
        let mut empty = Counter::default();
        empty.undo_failure();
        assert_eq!(empty, Counter::default());
    }

    #[test]
    fn the_store_survives_a_reopen_and_prunes_old_unlocked_entries() {
        let dir = TempDir::new();
        let path = dir.path().join("lockouts.json");
        let now = 100_000_000;
        {
            let mut store = LockoutStore::open(path.clone()).unwrap();
            // A fresh failure, an old one, a lock that has not run out, a stale lock
            // and an entry with no failures.
            store.employee("fresh").record_failure(&PASSWORD_POLICY, now - 1_000);
            store.employee("old").record_failure(&PASSWORD_POLICY, now - 1_800_001);
            let locked = store.employee("locked");
            for _ in 0..8 {
                locked.record_failure(&PASSWORD_POLICY, now - 2_000_000);
            }
            *locked = Counter { failures: 8, last_failure_ms: now - 2_000_000, locked_at_ms: now - 1_000, lock_ms: 900_000 };
            store.employee("stale").record_failure(&PASSWORD_POLICY, now - 3_000_000);
            store.employee("empty");
            store.admin_exit().record_failure(&PIN_POLICY, now - 5);
            *store.admin_exit_pin_id() = Some("pin-1".into());
            store.save(now).unwrap();
        }
        let mut store = LockoutStore::open(path.clone()).unwrap();
        assert_eq!(store.employee("fresh").failures, 1);
        assert_eq!(store.employee("locked").failures, 8);
        assert_eq!(store.admin_exit().failures, 1);
        assert_eq!(store.admin_exit_pin_id().as_deref(), Some("pin-1"));
        // Pruned: the old, stale and empty entries come back as fresh counters.
        for gone in ["old", "stale", "empty"] {
            assert_eq!(*store.employee(gone), Counter::default(), "{gone}");
        }
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("\"adminExit\"") && text.contains("\"adminExitPinId\""), "{text}");
        assert!(!text.contains("\"old\"") && !text.contains("\"stale\""), "{text}");
    }

    #[test]
    fn a_corrupt_file_is_set_aside_and_the_store_starts_empty() {
        let dir = TempDir::new();
        let path = dir.path().join("lockouts.json");
        std::fs::write(&path, b"{ nope").unwrap();
        let mut store = LockoutStore::open(path.clone()).unwrap();
        assert_eq!(*store.admin_exit(), Counter::default());
        assert!(!path.exists());
    }

    #[test]
    fn the_device_guard_blocks_after_twenty_and_reopens_when_the_oldest_is_ten_minutes_old() {
        let mut guard = DeviceGuard::default();
        let t0 = 50_000_000;
        for i in 0..20 {
            assert_eq!(guard.check(t0 + i * 1_000), None);
            guard.record_failure(t0 + i * 1_000);
        }
        // 20 failures are tolerated; the 21st is still checked ...
        assert_eq!(guard.check(t0 + 20_000), None);
        guard.record_failure(t0 + 20_000);
        // ... and after it everything is blocked, until the oldest is 10 minutes old.
        assert_eq!(guard.check(t0 + 21_000), Some(600_000 - 21_000));
        assert_eq!(guard.check(t0 + 599_999), Some(1));
        assert_eq!(guard.check(t0 + 600_000), None);
    }
}
