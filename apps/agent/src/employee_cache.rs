//! The offline sign-in cache (plan Section 5.9, "Offline cache"): per employee who
//! signed in online on this PC, the profile, the app catalogue and an Argon2id hash
//! of the password. The plain password is never stored. The file lives in the
//! protected state directory, so the Staff account cannot read it.

use std::fmt;
use std::path::PathBuf;

use rulebox_ipc::requests::{AppEntry, Employee};
use serde::{Deserialize, Serialize};

use crate::state::{read_json, write_atomic};

/// Most employees kept; the one with the oldest `last_online_ms` goes first.
pub const MAX_ENTRIES: usize = 50;
const DAY_MS: u64 = 86_400_000;

#[derive(Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CacheEntry {
    /// Normalized (trimmed, lower-cased).
    pub username: String,
    pub employee: Employee,
    pub apps: Vec<AppEntry>,
    /// Argon2id PHC string.
    pub password_hash: String,
    /// How long offline sign-in stays allowed after `last_online_ms`; 0 = never.
    pub offline_days: u32,
    pub last_online_ms: u64,
}

impl fmt::Debug for CacheEntry {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CacheEntry")
            .field("username", &self.username)
            .field("employee", &self.employee)
            .field("apps", &self.apps.len())
            .field("password_hash", &"<redacted>")
            .field("offline_days", &self.offline_days)
            .field("last_online_ms", &self.last_online_ms)
            .finish()
    }
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase", default)]
struct CacheFile {
    schema: u32,
    entries: Vec<CacheEntry>,
}

impl Default for CacheFile {
    fn default() -> Self {
        Self { schema: 1, entries: Vec::new() }
    }
}

/// `employee-cache.json`. Held behind a `std::sync::Mutex`, never across an `.await`.
pub struct EmployeeCache {
    path: PathBuf,
    entries: Vec<CacheEntry>,
}

impl EmployeeCache {
    /// A missing file is an empty cache; a corrupt one is renamed aside
    /// (`state::read_json`) and the cache starts empty.
    pub fn open(path: PathBuf) -> std::io::Result<Self> {
        let file = read_json::<CacheFile>(&path)?.unwrap_or_default();
        let mut entries = file.entries;
        if entries.len() > MAX_ENTRIES {
            // A hand-edited file: keep the newest.
            entries.sort_by_key(|entry| std::cmp::Reverse(entry.last_online_ms));
            entries.truncate(MAX_ENTRIES);
        }
        Ok(Self { path, entries })
    }

    pub fn get(&self, username: &str) -> Option<&CacheEntry> {
        self.entries.iter().find(|entry| entry.username == username)
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Adds or replaces the entry for its username, keeps the newest
    /// [`MAX_ENTRIES`], and saves. The entry stays in memory even when the write
    /// fails, so the running agent keeps working.
    pub fn put(&mut self, entry: CacheEntry) -> std::io::Result<()> {
        self.entries.retain(|existing| existing.username != entry.username);
        self.entries.push(entry);
        while self.entries.len() > MAX_ENTRIES {
            let oldest = self
                .entries
                .iter()
                .enumerate()
                .min_by_key(|(_, entry)| entry.last_online_ms)
                .map(|(index, _)| index);
            match oldest {
                Some(index) => {
                    self.entries.remove(index);
                }
                None => break,
            }
        }
        self.save()
    }

    /// Removes the entry (and saves) when there is one.
    pub fn remove(&mut self, username: &str) -> std::io::Result<()> {
        let before = self.entries.len();
        self.entries.retain(|entry| entry.username != username);
        if self.entries.len() == before {
            return Ok(());
        }
        self.save()
    }

    fn save(&self) -> std::io::Result<()> {
        let file = CacheFile { schema: 1, entries: self.entries.clone() };
        let bytes = serde_json::to_vec_pretty(&file).map_err(std::io::Error::other)?;
        write_atomic(&self.path, &bytes)
    }
}

/// An entry is expired when `offline_days == 0` or more than `offline_days` days
/// passed since the last online sign-in. The larger of the local clock and the
/// last wall clock the agent saw is used, so setting the clock back never extends
/// the period.
pub fn is_expired(entry: &CacheEntry, now_ms: u64, last_wall_clock_ms: u64) -> bool {
    if entry.offline_days == 0 {
        return true;
    }
    let now = now_ms.max(last_wall_clock_ms);
    now.saturating_sub(entry.last_online_ms) > u64::from(entry.offline_days) * DAY_MS
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempDir;

    fn entry(username: &str, offline_days: u32, last_online_ms: u64) -> CacheEntry {
        CacheEntry {
            username: username.into(),
            employee: Employee {
                id: format!("emp_{username}"),
                username: username.into(),
                name: username.to_uppercase(),
                role: None,
                quota_bytes: 1,
            },
            apps: Vec::new(),
            password_hash: "$argon2id$placeholder".into(),
            offline_days,
            last_online_ms,
        }
    }

    #[test]
    fn put_get_remove_and_reopen() {
        let dir = TempDir::new();
        let path = dir.path().join("employee-cache.json");
        let mut cache = EmployeeCache::open(path.clone()).unwrap();
        assert!(cache.get("maya").is_none());
        cache.put(entry("maya", 7, 10)).unwrap();
        cache.put(entry("sam", 0, 20)).unwrap();
        // Same username replaces.
        cache.put(entry("maya", 3, 30)).unwrap();
        assert_eq!(cache.len(), 2);
        assert_eq!(cache.get("maya").map(|e| (e.offline_days, e.last_online_ms)), Some((3, 30)));

        let reopened = EmployeeCache::open(path.clone()).unwrap();
        assert_eq!(reopened.get("maya"), cache.get("maya"));
        assert_eq!(reopened.get("sam").map(|e| e.employee.id.as_str()), Some("emp_sam"));

        let mut cache = reopened;
        cache.remove("maya").unwrap();
        cache.remove("nobody").unwrap();
        assert!(EmployeeCache::open(path).unwrap().get("maya").is_none());
    }

    #[test]
    fn at_most_fifty_and_the_oldest_online_goes_first() {
        let dir = TempDir::new();
        let mut cache = EmployeeCache::open(dir.path().join("c.json")).unwrap();
        for n in 0..MAX_ENTRIES {
            cache.put(entry(&format!("u{n}"), 7, 1_000 + n as u64)).unwrap();
        }
        assert_eq!(cache.len(), MAX_ENTRIES);
        cache.put(entry("newcomer", 7, 5_000)).unwrap();
        assert_eq!(cache.len(), MAX_ENTRIES);
        assert!(cache.get("u0").is_none(), "the oldest last-online entry is dropped");
        assert!(cache.get("u1").is_some() && cache.get("newcomer").is_some());
    }

    #[test]
    fn expiry_uses_the_larger_clock_and_zero_days_means_never() {
        let online = 1_700_000_000_000;
        let maya = entry("maya", 7, online);
        let day = 86_400_000;
        assert!(!is_expired(&maya, online + 7 * day, 0));
        assert!(is_expired(&maya, online + 7 * day + 1, 0));
        // The local clock was set back 30 days: the remembered clock still decides.
        let floor = online + 8 * day;
        assert!(is_expired(&maya, floor - 30 * day, floor));
        // Within the period, a remembered clock that is older changes nothing.
        assert!(!is_expired(&maya, online + day, online));
        // 0 days: never allowed offline.
        assert!(is_expired(&entry("sam", 0, online), online, 0));
    }

    #[test]
    fn debug_hides_the_hash_and_the_file_has_no_plain_password() {
        let secret_hash = "$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHQ$aGFzaGhhc2g";
        let mut e = entry("maya", 7, 1);
        e.password_hash = secret_hash.into();
        assert!(!format!("{e:?}").contains("aGFzaGhhc2g"));
        assert!(format!("{e:?}").contains("<redacted>"));
    }
}
