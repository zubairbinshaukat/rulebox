//! The daily security summary (plan 4.19, `deviceSecurityDaily`): counters of programs
//! stopped, permissions refused, drift and tamper events, bucketed by the **server's UTC day**.
//!
//! * Counting costs nothing but a local file: nothing here talks to the backend.
//! * A day is sent once it is over, as one call, and only when a counter is not zero (about
//!   0.3 writes a day on a device that blocks something now and then, 0 on a quiet one). The
//!   caller sends it with the first apply report or heartbeat after 00:00 UTC, never on a timer.
//! * "Server day" is the device clock plus the server-time offset the agent learned at ping
//!   time, so a PC whose clock is wrong still files its counts under the day the server will
//!   expect.
//! * What is counted is a number per layer, plus (app id, permission kind) pairs: no path, window
//!   title or user name (plan rule 6).

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::backend::reports::{BlockedCounts, PermissionDenial, SecurityDaily, MAX_PERMISSION_DENIALS};
use crate::state::{read_json, write_atomic};

/// Completed days kept while the server cannot be reached; older ones are dropped (the server
/// keeps 14 days anyway).
pub const MAX_PENDING_DAYS: usize = 14;
const DAY_MS: i64 = 86_400_000;

/// The layer that stopped something.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BlockLayer {
    AppLocker,
    AppControl,
    ProcWatch,
    Elevation,
}

/// `YYYY-MM-DD` of a Unix time in milliseconds, in UTC.
pub fn day_string(ms: i64) -> String {
    let (year, month, day) = civil_from_days(ms.div_euclid(DAY_MS));
    format!("{year:04}-{month:02}-{day:02}")
}

/// Howard Hinnant's `civil_from_days`.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

/// The server's UTC day for a device time: the device clock plus the offset the agent learned
/// from the server (`None` = unknown, the device clock is trusted).
pub fn server_day(now_ms: u64, server_offset_ms: Option<i64>) -> String {
    day_string(now_ms as i64 + server_offset_ms.unwrap_or(0))
}

/// The device time at which the server's next UTC day starts.
pub fn next_day_start_ms(now_ms: u64, server_offset_ms: Option<i64>) -> u64 {
    let server_now = now_ms as i64 + server_offset_ms.unwrap_or(0);
    let next = (server_now.div_euclid(DAY_MS) + 1) * DAY_MS;
    (next - server_offset_ms.unwrap_or(0)).max(0) as u64
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
struct Bucket {
    day: String,
    blocked: BlockedCounts,
    /// `(appId, kind)` -> count, kept as a list so the JSON stays plain.
    denials: Vec<PermissionDenial>,
    drift: u64,
    tamper: u64,
}

impl Bucket {
    fn into_summary(self) -> SecurityDaily {
        SecurityDaily {
            day: self.day,
            blocked: self.blocked,
            permission_denials: self.denials,
            drift: self.drift,
            tamper: self.tamper,
        }
    }

    fn is_zero(&self) -> bool {
        self.blocked.total() == 0 && self.denials.is_empty() && self.drift == 0 && self.tamper == 0
    }
}

#[derive(Serialize, Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
struct DailyFile {
    schema: u32,
    today: Option<Bucket>,
    /// Completed, non-zero days the server has not taken yet, oldest first.
    pending: Vec<SecurityDaily>,
}

/// `security-daily.json`.
pub struct DailyCounters {
    path: PathBuf,
    file: DailyFile,
    dirty: bool,
}

impl DailyCounters {
    /// A missing file is empty; a corrupt one is set aside by `read_json`.
    pub fn open(path: PathBuf) -> std::io::Result<Self> {
        let mut file = read_json::<DailyFile>(&path)?.unwrap_or_default();
        file.schema = 1;
        Ok(Self { path, file, dirty: false })
    }

    /// Files today's bucket under `day`, closing the previous one when the day changed.
    fn bucket(&mut self, day: &str) -> &mut Bucket {
        let changed = self.file.today.as_ref().is_some_and(|bucket| bucket.day != day);
        if changed {
            if let Some(old) = self.file.today.take() {
                self.close(old);
            }
        }
        self.dirty = true;
        self.file.today.get_or_insert_with(|| Bucket { day: day.to_string(), ..Bucket::default() })
    }

    fn close(&mut self, bucket: Bucket) {
        if bucket.is_zero() {
            return;
        }
        self.file.pending.push(bucket.into_summary());
        while self.file.pending.len() > MAX_PENDING_DAYS {
            self.file.pending.remove(0);
        }
    }

    /// `n` programs (or prompts) were stopped by `layer`.
    pub fn add_blocked(&mut self, day: &str, layer: BlockLayer, n: u64) {
        if n == 0 {
            return;
        }
        let blocked = &mut self.bucket(day).blocked;
        let slot = match layer {
            BlockLayer::AppLocker => &mut blocked.app_locker,
            BlockLayer::AppControl => &mut blocked.app_control,
            BlockLayer::ProcWatch => &mut blocked.proc_watch,
            BlockLayer::Elevation => &mut blocked.elevation,
        };
        *slot = slot.saturating_add(n);
    }

    /// A web app asked for a permission that was refused.
    pub fn add_permission_denial(&mut self, day: &str, app_id: &str, kind: &str) {
        self.add_permission_denials(day, app_id, kind, 1);
    }

    /// `n` refusals of one (app, kind) pair, as the Staff App reports them (`webapp.reportDenials`).
    pub fn add_permission_denials(&mut self, day: &str, app_id: &str, kind: &str, n: u64) {
        if n == 0 {
            return;
        }
        let denials = &mut self.bucket(day).denials;
        if let Some(row) = denials.iter_mut().find(|row| row.app_id == app_id && row.kind == kind) {
            row.count = row.count.saturating_add(n);
        } else if denials.len() < MAX_PERMISSION_DENIALS {
            denials.push(PermissionDenial { app_id: app_id.to_string(), kind: kind.to_string(), count: n });
        }
    }

    pub fn add_drift(&mut self, day: &str, n: u64) {
        if n > 0 {
            let bucket = self.bucket(day);
            bucket.drift = bucket.drift.saturating_add(n);
        }
    }

    pub fn add_tamper(&mut self, day: &str, n: u64) {
        if n > 0 {
            let bucket = self.bucket(day);
            bucket.tamper = bucket.tamper.saturating_add(n);
        }
    }

    /// Writes the file when a counter changed since the last write. Counting is in memory; the
    /// owner calls this at its own pace (after a collection, at shutdown), so a burst of blocks
    /// is one write.
    pub fn save_if_dirty(&mut self) -> std::io::Result<()> {
        if !self.dirty {
            return Ok(());
        }
        let bytes = serde_json::to_vec_pretty(&self.file).map_err(std::io::Error::other)?;
        write_atomic(&self.path, &bytes)?;
        self.dirty = false;
        Ok(())
    }

    /// The completed days waiting for the server, oldest first, after closing a bucket whose day
    /// is over. Today's counters are never returned (the day is not over).
    pub fn due(&mut self, today: &str) -> Vec<SecurityDaily> {
        let over = self.file.today.as_ref().is_some_and(|bucket| bucket.day != today);
        if over {
            if let Some(old) = self.file.today.take() {
                self.close(old);
                self.dirty = true;
            }
        }
        self.file.pending.clone()
    }

    /// The server took this day.
    pub fn ack(&mut self, day: &str) {
        let before = self.file.pending.len();
        self.file.pending.retain(|summary| summary.day != day);
        if self.file.pending.len() != before {
            self.dirty = true;
        }
    }

    /// Today's open counters (tests, and the owner's idea of "anything to say").
    #[cfg(test)]
    pub fn today(&self) -> Option<SecurityDaily> {
        self.file.today.clone().map(Bucket::into_summary)
    }

    /// Deletes everything, file included (unenroll: the counters belong to the organization).
    pub fn clear(&mut self) -> std::io::Result<()> {
        self.file = DailyFile { schema: 1, ..DailyFile::default() };
        self.dirty = false;
        crate::state::remove_file_if_exists(&self.path)
    }
}

/// Turns the process watch's cumulative `terminated` count into increments: a watch that was
/// restarted starts again from zero, which counts as "everything since the restart".
#[derive(Debug, Default)]
pub struct CounterDelta {
    last: u64,
}

impl CounterDelta {
    pub fn delta(&mut self, current: u64) -> u64 {
        let delta = if current >= self.last { current - self.last } else { current };
        self.last = current;
        delta
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempDir;

    #[test]
    fn days_are_utc_dates_and_follow_the_server_offset() {
        assert_eq!(day_string(0), "1970-01-01");
        assert_eq!(day_string(1_794_096_000_000), "2026-11-08");
        assert_eq!(day_string(1_794_096_000_000 - 1), "2026-11-07");
        // 2024-02-29 exists.
        assert_eq!(day_string(1_709_164_800_000), "2024-02-29");
        // A device clock one hour slow on 2026-11-09 00:30 server time files under the 9th.
        let device_now = 1_794_096_000_000u64 + DAY_MS as u64 + 30 * 60_000 - 3_600_000;
        assert_eq!(server_day(device_now, Some(3_600_000)), "2026-11-09");
        assert_eq!(server_day(device_now, None), "2026-11-08");
        // The next day starts, in device time, at the server's midnight minus the offset.
        assert_eq!(next_day_start_ms(device_now, Some(3_600_000)), 1_794_096_000_000 + 2 * DAY_MS as u64 - 3_600_000);
    }

    #[test]
    fn counters_are_filed_by_day_and_only_completed_non_zero_days_are_due() {
        let dir = TempDir::new();
        let mut daily = DailyCounters::open(dir.path().join("security-daily.json")).unwrap();
        daily.add_blocked("2026-11-08", BlockLayer::ProcWatch, 2);
        daily.add_blocked("2026-11-08", BlockLayer::AppLocker, 1);
        daily.add_permission_denial("2026-11-08", "orders-web", "camera");
        daily.add_permission_denial("2026-11-08", "orders-web", "camera");
        daily.add_drift("2026-11-08", 3);
        // Today is not over: nothing is due.
        assert!(daily.due("2026-11-08").is_empty());
        let due = daily.due("2026-11-09");
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].day, "2026-11-08");
        assert_eq!((due[0].blocked.proc_watch, due[0].blocked.app_locker, due[0].drift), (2, 1, 3));
        assert_eq!(due[0].permission_denials, [PermissionDenial { app_id: "orders-web".into(), kind: "camera".into(), count: 2 }]);
        // The server takes it: gone, and a quiet day later adds nothing.
        daily.ack("2026-11-08");
        assert!(daily.due("2026-11-09").is_empty());
        daily.add_blocked("2026-11-09", BlockLayer::ProcWatch, 0);
        assert!(daily.due("2026-11-10").is_empty(), "a day without a count is never sent");
    }

    #[test]
    fn unsent_days_survive_a_restart_and_are_capped() {
        let dir = TempDir::new();
        let path = dir.path().join("security-daily.json");
        let mut daily = DailyCounters::open(path.clone()).unwrap();
        for n in 1..=16 {
            daily.add_tamper(&format!("2026-10-{n:02}"), 1);
        }
        daily.add_blocked("2026-11-01", BlockLayer::Elevation, 4);
        daily.save_if_dirty().unwrap();
        let mut again = DailyCounters::open(path).unwrap();
        let due = again.due("2026-11-02");
        assert_eq!(due.len(), MAX_PENDING_DAYS);
        assert_eq!(due.last().map(|d| d.day.as_str()), Some("2026-11-01"));
        assert_eq!(due.first().map(|d| d.day.as_str()), Some("2026-10-04"), "the oldest days went first");
    }

    #[test]
    fn counting_writes_nothing_until_asked_and_then_once() {
        let dir = TempDir::new();
        let path = dir.path().join("security-daily.json");
        let mut daily = DailyCounters::open(path.clone()).unwrap();
        for _ in 0..100 {
            daily.add_blocked("2026-11-08", BlockLayer::ProcWatch, 1);
        }
        assert!(!path.exists(), "a burst of blocks does not touch the disk");
        daily.save_if_dirty().unwrap();
        assert!(path.exists());
        let before = std::fs::metadata(&path).unwrap().modified().unwrap();
        daily.save_if_dirty().unwrap();
        assert_eq!(std::fs::metadata(&path).unwrap().modified().unwrap(), before, "nothing changed, nothing written");
        assert_eq!(daily.today().unwrap().blocked.proc_watch, 100);
    }

    #[test]
    fn a_cumulative_counter_becomes_increments_and_survives_a_restart_of_the_watch() {
        let mut delta = CounterDelta::default();
        assert_eq!(delta.delta(3), 3);
        assert_eq!(delta.delta(3), 0);
        assert_eq!(delta.delta(5), 2);
        // The watch was restarted: its counter is small again.
        assert_eq!(delta.delta(1), 1);
    }

    #[test]
    fn permission_rows_are_capped() {
        let dir = TempDir::new();
        let mut daily = DailyCounters::open(dir.path().join("d.json")).unwrap();
        for n in 0..(MAX_PERMISSION_DENIALS + 20) {
            daily.add_permission_denial("2026-11-08", &format!("app{n}"), "camera");
        }
        assert_eq!(daily.today().unwrap().permission_denials.len(), MAX_PERMISSION_DENIALS);
    }
}
