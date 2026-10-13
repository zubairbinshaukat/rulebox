//! Agent state on disk (plan Section 5.1): one JSON file, written atomically.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::platform::RegValueRef;

pub const STATE_SCHEMA: u32 = 1;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentState {
    pub schema: u32,
    pub enrollment: Option<Enrollment>,
    pub pending_enrollment: Option<PendingEnrollment>,
    pub staff: Option<StaffAccount>,
    pub kiosk: KioskRecord,
    /// Original machine values we replaced.
    pub journal: Vec<JournalEntry>,
    /// Highest desired-state version applied.
    pub last_applied_version: u64,
    /// For clock-went-backwards detection.
    pub last_wall_clock_ms: u64,
}

impl Default for AgentState {
    fn default() -> Self {
        Self {
            schema: STATE_SCHEMA,
            enrollment: None,
            pending_enrollment: None,
            staff: None,
            kiosk: KioskRecord::default(),
            journal: Vec::new(),
            last_applied_version: 0,
            last_wall_clock_ms: 0,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Enrollment {
    pub convex_url: String,
    pub device_id: String,
    pub org_id: String,
    pub device_name: String,
    pub enrolled_at_ms: u64,
    pub revoked: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PendingEnrollment {
    pub convex_url: String,
    pub token_sha256: String,
    pub started_at_ms: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StaffAccount {
    pub sid: String,
    pub user_name: String,
    /// (1.1) The Staff profile folder returned by `ensure_profile`, saved when the
    /// kiosk is enabled (plan Section 5.6, step 3). The employee files base is
    /// `<profile_dir>\RuleboxFiles`.
    #[serde(default)]
    pub profile_dir: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct KioskRecord {
    pub applied: KioskApplied,
    pub last_error: Option<String>,
    pub failures: u32,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum KioskApplied {
    #[default]
    NotApplied,
    Enabled,
    Disabled,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JournalEntry {
    pub key: RegValueRef,
    pub original: OriginalValue,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum OriginalValue {
    Absent,
    Dword(u32),
    String(String),
    /// The value is sensitive and lives in `Secrets`.
    InSecrets,
}

pub fn unix_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

/// Locks a `std::sync::Mutex`, ignoring poisoning: the data these guard (counters,
/// queues) is saved to disk after every change and is always in a usable state.
/// Never hold the guard across an `.await`.
pub fn lock<T>(mutex: &std::sync::Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Writes `<name>.tmp`, syncs it, then renames it over the target.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut tmp_name = path.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    tmp_name.push(".tmp");
    let tmp = path.with_file_name(tmp_name);
    let result = (|| {
        let mut file = std::fs::File::create(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

/// Reads a JSON file. Missing gives `None`. A file that does not parse is renamed
/// to `<name>.corrupt-<unix ms>`, logged as an error, and treated as missing.
pub fn read_json<T: DeserializeOwned>(path: &Path) -> std::io::Result<Option<T>> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    match serde_json::from_slice(&bytes) {
        Ok(value) => Ok(Some(value)),
        Err(e) => {
            let mut name = path.file_name().map(|n| n.to_os_string()).unwrap_or_default();
            name.push(format!(".corrupt-{}", unix_ms()));
            let aside: PathBuf = path.with_file_name(name);
            tracing::error!("{} does not parse ({e}); moving it to {}", path.display(), aside.display());
            std::fs::rename(path, &aside)?;
            Ok(None)
        }
    }
}

/// `agent-state.json` in the state directory.
pub struct StateStore {
    path: PathBuf,
}

impl StateStore {
    /// Creates the state directory if needed.
    pub fn open(dir: &Path) -> std::io::Result<Self> {
        std::fs::create_dir_all(dir)?;
        Ok(Self { path: dir.join("agent-state.json") })
    }

    pub fn load(&self) -> std::io::Result<AgentState> {
        Ok(read_json(&self.path)?.unwrap_or_default())
    }

    pub fn save(&self, state: &AgentState) -> std::io::Result<()> {
        let bytes = serde_json::to_vec_pretty(state).map_err(std::io::Error::other)?;
        write_atomic(&self.path, &bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempDir;

    fn sample() -> AgentState {
        AgentState {
            enrollment: Some(Enrollment {
                convex_url: "https://x.convex.cloud".into(),
                device_id: "dev1".into(),
                org_id: "org1".into(),
                device_name: "Desk".into(),
                enrolled_at_ms: 5,
                revoked: false,
            }),
            staff: Some(StaffAccount {
                sid: "S-1-5-21-1".into(),
                user_name: "RuleboxStaff".into(),
                profile_dir: Some(r"C:\Users\RuleboxStaff".into()),
            }),
            kiosk: KioskRecord { applied: KioskApplied::Enabled, last_error: Some("e".into()), failures: 2 },
            journal: vec![
                JournalEntry {
                    key: RegValueRef { path: "SOFTWARE\\X".into(), name: "Y".into() },
                    original: OriginalValue::Dword(7),
                },
                JournalEntry {
                    key: RegValueRef { path: "SOFTWARE\\X".into(), name: "Z".into() },
                    original: OriginalValue::InSecrets,
                },
            ],
            last_applied_version: 42,
            last_wall_clock_ms: 99,
            ..AgentState::default()
        }
    }

    #[test]
    fn missing_file_is_the_default() {
        let dir = TempDir::new();
        let store = StateStore::open(dir.path()).unwrap();
        assert_eq!(store.load().unwrap(), AgentState::default());
        assert_eq!(AgentState::default().schema, 1);
    }

    #[test]
    fn save_and_load_round_trip() {
        let dir = TempDir::new();
        let store = StateStore::open(dir.path()).unwrap();
        store.save(&sample()).unwrap();
        assert_eq!(store.load().unwrap(), sample());
        // camelCase on disk
        let text = std::fs::read_to_string(dir.path().join("agent-state.json")).unwrap();
        assert!(text.contains("\"lastAppliedVersion\""), "{text}");
    }

    #[test]
    fn corrupt_file_is_renamed_and_default_returned() {
        let dir = TempDir::new();
        let store = StateStore::open(dir.path()).unwrap();
        std::fs::write(dir.path().join("agent-state.json"), b"{ not json").unwrap();
        assert_eq!(store.load().unwrap(), AgentState::default());
        assert!(!dir.path().join("agent-state.json").exists());
        let names: Vec<String> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert!(names.iter().any(|n| n.starts_with("agent-state.json.corrupt-")), "{names:?}");
    }

    #[test]
    fn atomic_write_leaves_no_tmp_file() {
        let dir = TempDir::new();
        let store = StateStore::open(dir.path()).unwrap();
        store.save(&sample()).unwrap();
        store.save(&AgentState::default()).unwrap();
        let names: Vec<String> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, ["agent-state.json"]);
    }

    #[test]
    fn a_staff_account_without_a_profile_dir_still_loads() {
        // A state file written before protocol 1.1.
        let state: AgentState =
            serde_json::from_str(r#"{ "staff": { "sid": "S-1-5-21-1", "userName": "RuleboxStaff" } }"#).unwrap();
        assert_eq!(state.staff.unwrap().profile_dir, None);
    }

    #[test]
    fn missing_fields_take_defaults() {
        let state: AgentState = serde_json::from_str(r#"{ "lastAppliedVersion": 3 }"#).unwrap();
        assert_eq!(state.last_applied_version, 3);
        assert_eq!(state.schema, 1);
    }
}
