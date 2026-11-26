//! Browser profiles of web apps opened in Chrome or Edge: which ones to delete (Phase 6 Step 18, plan 4.9.6).
//!
//! The Staff App starts a browser with `--user-data-dir=%LOCALAPPDATA%\dev.rulebox.staff\browser\<chrome|edge>\<employee folder>`
//! (inside the Staff profile): one profile per employee and browser, so one person's web apps share cookies and single sign-on and
//! nobody else's. Nothing else cleans them, so the agent does:
//!
//! * an employee who is **no longer in the roster** of the device's group loses the profile;
//! * per browser, the **10 most recently used** profiles stay; older ones go at the first cleanup round after the agent
//!   started (boot), and more of them when the system drive has **less than 3 GiB free** (then only the 3 most recent stay,
//!   at every round);
//! * deletion happens only inside a **cleanup round** (`cleanup.rs`): never while an employee signs in or is signed in, so no
//!   browser of the Staff session is running, and a folder that a process still holds open is "in use" and tried again later.
//!   The deletion itself is the handle-based `Platform::reset_folder`, which refuses a link on the way.
//! * the profile bytes are **not** counted toward the employee's file quota (PRD 8).
//!
//! "Most recently used" is the sign-in time of the employee, kept in `browser-profiles.json` ([`ProfileLedger`]); the file only
//! holds employee folder names and times. This module is pure rules plus that small ledger; `cleanup.rs` does the deleting.

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::state::{lock, read_json, write_atomic};

/// The browser folders below `...\browser\` (the Staff App uses the same two names).
pub const BROWSERS: [&str; 2] = ["chrome", "edge"];
/// Per browser, this many employee profiles stay (plan 4.9.6).
pub const KEEP_PROFILES: usize = 10;
/// With less free disk than [`LOW_DISK_BYTES`] only this many stay per browser.
pub const KEEP_PROFILES_LOW_DISK: usize = 3;
/// The system drive's free space below which the profiles are cut down at every round (3 GiB).
pub const LOW_DISK_BYTES: u64 = 3 * 1024 * 1024 * 1024;
/// The ledger never holds more employees than this (the oldest go first).
const MAX_LEDGER_ENTRIES: usize = 1000;
/// The longest employee folder name accepted.
const MAX_FOLDER_CHARS: usize = 128;
/// Where the Staff App keeps browser profiles, below the Staff profile's `AppData\Local`.
const TEMPLATE_PREFIX: &str = r"{LocalAppData}\dev.rulebox.staff\browser\";

/// The folder name the Staff App gives an employee (`webapp::employee_folder` there): ASCII letters, digits, `-` and `_` stay,
/// every other character becomes `-`, an empty id is `unknown`.
pub fn folder_of(employee_id: &str) -> String {
    let clean: String = employee_id.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' }).collect();
    if clean.is_empty() {
        "unknown".to_string()
    } else {
        clean
    }
}

/// A name this module may delete: what [`folder_of`] can produce, at most 128 characters. Anything else in the folder is left alone.
pub fn is_profile_name(name: &str) -> bool {
    !name.is_empty() && name.chars().count() <= MAX_FOLDER_CHARS && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// The `reset_folder` template of one profile folder, `None` for a browser or a name that is not one of ours.
pub fn profile_template(browser: &str, folder: &str) -> Option<String> {
    (BROWSERS.contains(&browser) && is_profile_name(folder)).then(|| format!("{TEMPLATE_PREFIX}{browser}\\{folder}"))
}

/// The parts below `AppData\Local` of a template made by [`profile_template`] (`dev.rulebox.staff`, `browser`, the browser, the
/// folder); `None` for any other template. `cleanup::resolve_reset` accepts exactly this shape for Rulebox's own folder, which its
/// general deny list refuses for the folders an administrator names.
pub fn profile_parts(template: &str) -> Option<Vec<&str>> {
    let rest = template.strip_prefix(TEMPLATE_PREFIX)?;
    let (browser, folder) = rest.split_once('\\')?;
    (BROWSERS.contains(&browser) && is_profile_name(folder)).then(|| vec!["dev.rulebox.staff", "browser", browser, folder])
}

/// What the plan needs to know.
#[derive(Debug, Clone)]
pub struct PassInput {
    /// `(browser, folder)` of every profile folder found.
    pub present: Vec<(&'static str, String)>,
    /// The folder names of the employees the roster lists; `None` when the roster does not speak for the current document (the
    /// rule is then not applied).
    pub roster: Option<BTreeSet<String>>,
    /// Employee folder → time of the last sign-in in milliseconds (missing = never seen: the oldest).
    pub last_used: BTreeMap<String, u64>,
    /// Free bytes on the system drive; `None` when unknown.
    pub disk_free: Option<u64>,
    /// The first pass since the agent started: the "keep the 10 most recent" rule applies.
    pub boot: bool,
}

/// Why a profile goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Why {
    /// The employee is not in the roster.
    NotInRoster,
    /// More profiles than the most recent 10 (at boot).
    Old,
    /// Less than 3 GiB free: more than the most recent 3.
    LowDisk,
}

/// One profile folder to delete.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Doomed {
    pub browser: &'static str,
    pub folder: String,
    pub why: Why,
}

/// Pure: the profile folders to delete. Folders whose names are not ours are never listed. The employee used most recently
/// stays whatever the rules say (at least one profile is kept per browser unless the roster removed it).
pub fn plan(input: &PassInput) -> Vec<Doomed> {
    let low_disk = input.disk_free.is_some_and(|free| free < LOW_DISK_BYTES);
    let keep = if low_disk { KEEP_PROFILES_LOW_DISK } else { KEEP_PROFILES };
    let trim = input.boot || low_disk;
    let mut doomed = Vec::new();
    for browser in BROWSERS {
        let mut left: Vec<&String> = Vec::new();
        for (_, folder) in input.present.iter().filter(|(found, folder)| *found == browser && is_profile_name(folder)) {
            if input.roster.as_ref().is_some_and(|members| !members.contains(folder)) {
                doomed.push(Doomed { browser, folder: folder.clone(), why: Why::NotInRoster });
            } else {
                left.push(folder);
            }
        }
        if trim && left.len() > keep {
            // Newest first; ties and unknown employees by name so the plan is the same every time.
            left.sort_by(|a, b| {
                let (used_a, used_b) = (input.last_used.get(*a).copied().unwrap_or(0), input.last_used.get(*b).copied().unwrap_or(0));
                used_b.cmp(&used_a).then_with(|| a.cmp(b))
            });
            let why = if low_disk { Why::LowDisk } else { Why::Old };
            for folder in left.into_iter().skip(keep) {
                doomed.push(Doomed { browser, folder: folder.clone(), why });
            }
        }
    }
    doomed
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct LedgerFile {
    last_used_ms: BTreeMap<String, u64>,
}

/// When each employee last signed in on this PC (employee folder → milliseconds), in `browser-profiles.json`.
pub struct ProfileLedger {
    /// `None` keeps it in memory only (tests).
    path: Option<PathBuf>,
    used: Mutex<BTreeMap<String, u64>>,
}

impl ProfileLedger {
    /// Reads the file; a missing or unreadable one is empty (every profile then counts as old, the safe direction for disk space
    /// only; the roster rule is unaffected).
    pub fn open(path: PathBuf) -> Self {
        let used = match read_json::<LedgerFile>(&path) {
            Ok(Some(file)) => file.last_used_ms,
            Ok(None) => BTreeMap::new(),
            Err(error) => {
                tracing::warn!(%error, "cannot read browser-profiles.json; starting empty");
                BTreeMap::new()
            }
        };
        Self { path: Some(path), used: Mutex::new(used) }
    }

    #[cfg(test)]
    pub fn in_memory() -> Self {
        Self { path: None, used: Mutex::new(BTreeMap::new()) }
    }

    /// An employee signed in at `now_ms`.
    pub fn touch(&self, employee_id: &str, now_ms: u64) {
        let folder = folder_of(employee_id);
        let mut used = lock(&self.used);
        used.insert(folder, now_ms);
        while used.len() > MAX_LEDGER_ENTRIES {
            let oldest = used.iter().min_by_key(|(name, ms)| (**ms, (*name).clone())).map(|(name, _)| name.clone());
            match oldest {
                Some(name) => used.remove(&name),
                None => break,
            };
        }
        self.save(&used);
    }

    /// The employees' last sign-in times.
    pub fn snapshot(&self) -> BTreeMap<String, u64> {
        lock(&self.used).clone()
    }

    /// Forgets employees that have no profile folder any more (`keep` are the ones that still have one).
    pub fn retain_only(&self, keep: &BTreeSet<String>) {
        let mut used = lock(&self.used);
        let before = used.len();
        used.retain(|name, _| keep.contains(name));
        if used.len() != before {
            self.save(&used);
        }
    }

    fn save(&self, used: &BTreeMap<String, u64>) {
        let Some(path) = &self.path else { return };
        let written = serde_json::to_vec(&LedgerFile { last_used_ms: used.clone() })
            .map_err(std::io::Error::other)
            .and_then(|bytes| path.parent().map_or(Ok(()), std::fs::create_dir_all).and_then(|()| write_atomic(path, &bytes)));
        if let Err(error) = written {
            // Harmless: the profiles then look older than they are until the next sign-in.
            tracing::warn!(%error, "cannot save browser-profiles.json");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn found(browser: &'static str, folders: &[&str]) -> Vec<(&'static str, String)> {
        folders.iter().map(|folder| (browser, (*folder).to_string())).collect()
    }

    fn input(present: Vec<(&'static str, String)>) -> PassInput {
        PassInput { present, roster: None, last_used: BTreeMap::new(), disk_free: Some(50 * 1024 * 1024 * 1024), boot: false }
    }

    fn names(list: &[Doomed]) -> Vec<String> {
        list.iter().map(|d| format!("{}/{}", d.browser, d.folder)).collect()
    }

    #[test]
    fn the_folder_name_follows_the_staff_apps_rule() {
        assert_eq!(folder_of("k57abc123"), "k57abc123");
        assert_eq!(folder_of(r"..\..\evil"), "------evil");
        assert_eq!(folder_of("a b/c"), "a-b-c");
        assert_eq!(folder_of(""), "unknown");
        assert_eq!(folder_of("ünï"), "-n-");
    }

    #[test]
    fn only_our_own_names_make_a_template_and_the_template_gives_back_its_parts() {
        let template = profile_template("chrome", "emp-1_x").unwrap();
        assert_eq!(template, r"{LocalAppData}\dev.rulebox.staff\browser\chrome\emp-1_x");
        assert_eq!(profile_parts(&template).unwrap(), ["dev.rulebox.staff", "browser", "chrome", "emp-1_x"]);
        for (browser, folder) in [("firefox", "e1"), ("chrome", ""), ("chrome", ".."), ("chrome", "a\\b"), ("chrome", "a b"), ("", "e1")] {
            assert_eq!(profile_template(browser, folder), None, "{browser}/{folder}");
        }
        assert_eq!(profile_template("edge", &"a".repeat(129)), None);
        assert!(profile_template("edge", &"a".repeat(128)).is_some());
        // Anything but the exact shape is not a profile template: the general rules (and their deny list) apply to it.
        for bad in [
            r"{LocalAppData}\dev.rulebox.staff\browser\chrome",
            r"{LocalAppData}\dev.rulebox.staff\browser\chrome\",
            r"{LocalAppData}\dev.rulebox.staff\browser\chrome\a\b",
            r"{LocalAppData}\dev.rulebox.staff\browser\chrome\..",
            r"{LocalAppData}\dev.rulebox.staff\browser\other\a",
            r"{LocalAppData}\dev.rulebox.staff\EBWebView",
            r"{LocalAppData}\dev.rulebox.staff\web\a",
            r"{RoamingAppData}\dev.rulebox.staff\browser\chrome\a",
            r"{localappdata}\dev.rulebox.staff\browser\chrome\a",
            r"{LocalAppData}\Rulebox",
        ] {
            assert_eq!(profile_parts(bad), None, "{bad}");
        }
    }

    #[test]
    fn a_pass_with_fewer_than_ten_profiles_deletes_nothing() {
        let mut data = input(found("chrome", &["a", "b", "c"]));
        data.boot = true;
        assert!(plan(&data).is_empty());
        data.boot = false;
        assert!(plan(&data).is_empty());
    }

    #[test]
    fn at_boot_the_ten_most_recently_used_profiles_stay_per_browser() {
        let folders: Vec<String> = (0..13).map(|i| format!("e{i:02}")).collect();
        let refs: Vec<&str> = folders.iter().map(String::as_str).collect();
        let mut data = input([found("chrome", &refs), found("edge", &["x", "y"])].concat());
        // e12 was used last, e00 first; e05 and e06 were never seen.
        for (i, folder) in folders.iter().enumerate() {
            if i != 5 && i != 6 {
                data.last_used.insert(folder.clone(), 1_000 + i as u64);
            }
        }
        // Not at boot and not short of disk: nothing is cut.
        assert!(plan(&data).is_empty());
        data.boot = true;
        let gone = plan(&data);
        // The three oldest: e00 (the oldest sign-in), then e05 and e06 (never seen: older than anyone known).
        assert_eq!(names(&gone), ["chrome/e00", "chrome/e05", "chrome/e06"]);
        assert!(gone.iter().all(|d| d.why == Why::Old));
        // Edge has two profiles: untouched. The per-browser count is separate.
        assert!(!gone.iter().any(|d| d.browser == "edge"));
    }

    #[test]
    fn short_of_disk_only_the_three_most_recent_stay_at_every_round() {
        let mut data = input(found("chrome", &["a", "b", "c", "d", "e"]));
        for (i, folder) in ["a", "b", "c", "d", "e"].iter().enumerate() {
            data.last_used.insert((*folder).to_string(), 10 + i as u64);
        }
        data.disk_free = Some(LOW_DISK_BYTES - 1);
        let gone = plan(&data);
        assert_eq!(names(&gone), ["chrome/b", "chrome/a"]);
        assert!(gone.iter().all(|d| d.why == Why::LowDisk));
        // Exactly 3 GiB free is enough; an unknown size changes nothing.
        data.disk_free = Some(LOW_DISK_BYTES);
        assert!(plan(&data).is_empty());
        data.disk_free = None;
        assert!(plan(&data).is_empty());
    }

    #[test]
    fn an_employee_the_roster_dropped_loses_the_profile_in_both_browsers() {
        let mut data = input([found("chrome", &["keep", "gone"]), found("edge", &["gone", "keep"])].concat());
        data.roster = Some(BTreeSet::from(["keep".to_string()]));
        let gone = plan(&data);
        assert_eq!(names(&gone), ["chrome/gone", "edge/gone"]);
        assert!(gone.iter().all(|d| d.why == Why::NotInRoster));
        // No roster that speaks for the document: the rule is not applied.
        data.roster = None;
        assert!(plan(&data).is_empty());
        // An empty roster of the current group removes everyone who is not listed.
        data.roster = Some(BTreeSet::new());
        assert_eq!(plan(&data).len(), 4);
    }

    #[test]
    fn folders_that_are_not_ours_are_never_planned() {
        let mut data = input(found("chrome", &["fine", "has space", "..", "a.b", ""]));
        data.roster = Some(BTreeSet::new());
        assert_eq!(names(&plan(&data)), ["chrome/fine"]);
        // Only the two known browsers are looked at.
        let mut other = input(vec![("firefox", "x".to_string())]);
        other.roster = Some(BTreeSet::new());
        assert!(plan(&other).is_empty());
    }

    #[test]
    fn the_roster_removal_wins_over_keeping_recent_profiles_and_the_newest_always_stays() {
        let mut data = input(found("chrome", &["a", "b", "c", "d"]));
        data.last_used = BTreeMap::from([("a".into(), 4), ("b".into(), 3), ("c".into(), 2), ("d".into(), 1)]);
        data.disk_free = Some(0);
        // Three stay: a, b, c. d goes for disk.
        assert_eq!(names(&plan(&data)), ["chrome/d"]);
        // a left the roster: it goes for that, and the three newest of the rest are b, c, d.
        data.roster = Some(BTreeSet::from(["b".to_string(), "c".to_string(), "d".to_string()]));
        let gone = plan(&data);
        assert_eq!(names(&gone), ["chrome/a"]);
        assert_eq!(gone[0].why, Why::NotInRoster);
    }

    #[test]
    fn the_ledger_remembers_the_last_sign_in_and_survives_a_restart() {
        let dir = crate::testutil::TempDir::new();
        let path = dir.path().join("state").join("browser-profiles.json");
        let ledger = ProfileLedger::open(path.clone());
        assert!(ledger.snapshot().is_empty());
        ledger.touch("emp1", 100);
        ledger.touch("emp2", 200);
        ledger.touch("emp1", 300);
        ledger.touch("a b", 50);
        assert_eq!(ledger.snapshot(), BTreeMap::from([("emp1".into(), 300), ("emp2".into(), 200), ("a-b".into(), 50)]));
        let again = ProfileLedger::open(path.clone());
        assert_eq!(again.snapshot(), ledger.snapshot());
        // Only folder names and times are in the file.
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("emp1") && !text.contains("password"), "{text}");
        again.retain_only(&BTreeSet::from(["emp2".to_string()]));
        assert_eq!(ProfileLedger::open(path).snapshot(), BTreeMap::from([("emp2".into(), 200)]));
    }

    #[test]
    fn a_broken_ledger_file_is_an_empty_ledger() {
        let dir = crate::testutil::TempDir::new();
        let path = dir.path().join("browser-profiles.json");
        std::fs::write(&path, b"{ not json").unwrap();
        assert!(ProfileLedger::open(path).snapshot().is_empty());
    }

    #[test]
    fn the_ledger_never_grows_past_its_limit() {
        let ledger = ProfileLedger::in_memory();
        for i in 0..(MAX_LEDGER_ENTRIES + 25) {
            ledger.touch(&format!("e{i}"), i as u64 + 1);
        }
        let used = ledger.snapshot();
        assert_eq!(used.len(), MAX_LEDGER_ENTRIES);
        assert!(!used.contains_key("e0") && used.contains_key(&format!("e{}", MAX_LEDGER_ENTRIES + 24)));
    }
}
