//! Findings (plan 4.10, Phase 5 Step 9): what AppLocker, App Control and the process watchdog
//! would have stopped (audit) or did stop (enforce), reduced to a fingerprint and the few
//! fields the dashboard shows.
//!
//! * **Sources.** The AppLocker and Code Integrity event logs, read with a bookmark per channel
//!   (`findings-state.json`), and the process watch's own list. Events are read through
//!   `Platform::read_event_log`; nothing here writes to a log.
//! * **Privacy (plan rule 6).** A finding holds the file name, a folder class (`windows`,
//!   `programFiles`, `rulebox`, `userProfile`, `userTemp`, `removable`, `network`, `other`), the
//!   signer's CN and O, the product name and, for an unsigned file, its hash. The full path, the
//!   user's name, command lines, window titles and document names are not read from the event
//!   and cannot reach the store: [`Observation`] has no field for them.
//! * **Store.** `findings.json` keeps at most [`MAX_FINDINGS`] fingerprints, least recently seen
//!   first out (a fingerprint the server already has goes before one it does not).
//! * **Flush rules (plan 4.19).** Only a fingerprint the server has not seen is ever sent: at most
//!   [`MAX_FLUSHES_PER_DAY`] calls per server day, at most 50 fingerprints per call, and not
//!   sooner than [`FLUSH_SETTLE_MS`] after the first new one so a burst becomes one call. While
//!   the server cannot be reached the file grows to the cap; the calls then go out in order.
//!
//! The event shapes below follow the Microsoft documentation of AppLocker events 8003, 8004,
//! 8006 and 8007 and Code Integrity events 3076 and 3077. They are **(unverified)** on a real PC
//! until the VM run of Step 21 renders a few; the parsers read the fields by name and ignore
//! everything else, so a field that differs makes a finding disappear, never a path appear.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::appcontrol::RULEBOX_POLICY_IDS;
use super::procwatch::{self, FindingRecord};
use crate::backend::reports::{FindingReport, MAX_FINDINGS_PER_CALL};
use crate::platform::Platform;
use crate::state::{read_json, write_atomic};

/// Fingerprints kept on the device.
pub const MAX_FINDINGS: usize = 500;
/// New fingerprints are sent in at most this many calls per server day.
pub const MAX_FLUSHES_PER_DAY: u32 = 4;
/// A new fingerprint waits this long for company before a call is made (unless 50 are ready).
pub const FLUSH_SETTLE_MS: u64 = 5 * 60_000;
/// Two calls are at least this far apart.
pub const MIN_FLUSH_GAP_MS: u64 = 2 * 3_600_000;
/// Events read per channel per round, and rounds per collection.
const READ_BATCH: usize = 500;
const MAX_ROUNDS: usize = 4;

/// The event channels findings come from and how each is read.
pub const AUDIT_CHANNELS: [(&str, Source); 4] = [
    ("Microsoft-Windows-AppLocker/EXE and DLL", Source::AppLocker),
    ("Microsoft-Windows-AppLocker/MSI and Script", Source::AppLocker),
    ("Microsoft-Windows-AppLocker/Packaged app-Execution", Source::AppLocker),
    ("Microsoft-Windows-CodeIntegrity/Operational", Source::CodeIntegrity),
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    AppLocker,
    CodeIntegrity,
}

/// The layer a finding belongs to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FindingLayer {
    AppLocker,
    AppControl,
    ProcWatch,
}

impl FindingLayer {
    pub fn word(self) -> &'static str {
        match self {
            FindingLayer::AppLocker => "appLocker",
            FindingLayer::AppControl => "appControl",
            FindingLayer::ProcWatch => "procWatch",
        }
    }
}

/// Whether the layer only noted the program (audit) or stopped it (enforce).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Audit,
    Blocked,
}

/// What the parsers keep of an event: nothing else is ever read from it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Observation {
    pub layer: FindingLayer,
    pub outcome: Outcome,
    pub file_name: String,
    pub folder_class: &'static str,
    pub signer: Option<String>,
    pub product: Option<String>,
    /// Only kept for an unsigned file.
    pub sha256: Option<String>,
}

impl Observation {
    /// SHA-256 of `layer | lower(fileName) | folderClass | signer | sha256?` (plan 4.10). A
    /// signed program is one fingerprint whatever its version; an unsigned one is told apart by
    /// its hash.
    pub fn fingerprint(&self) -> String {
        fingerprint(self.layer, &self.file_name, self.folder_class, self.signer.as_deref().unwrap_or(""), self.sha256.as_deref().unwrap_or(""))
    }
}

/// The fingerprint text of plan 4.10 (the process watch builds the same one for `procWatch`).
pub fn fingerprint(layer: FindingLayer, file_name: &str, folder_class: &str, signer: &str, sha256: &str) -> String {
    let text = format!("{}|{}|{folder_class}|{signer}|{sha256}", layer.word(), file_name.to_ascii_lowercase());
    Sha256::digest(text.as_bytes()).iter().map(|byte| format!("{byte:02x}")).collect()
}

// ---------------------------------------------------------------- reading an event

/// What the classifier needs to know about this PC.
#[derive(Clone, Debug, Default)]
pub struct FolderCtx {
    /// The system drive, `C:`.
    pub os_drive: String,
    /// The Windows folder, `C:\Windows`.
    pub windows: String,
    /// The Rulebox install folder and the WebView2 runtime folder.
    pub protected: Vec<String>,
    /// The `\Device\HarddiskVolumeN` of the system drive. Without it a Code Integrity path (which
    /// names a device, not a drive letter) is `other`: a wrong class is worse than a vague one.
    pub system_volume: Option<String>,
    /// Volumes (`\Device\HarddiskVolumeN` or `E:`) known to be removable.
    pub removable_volumes: Vec<String>,
}

fn decode(text: &str) -> String {
    text.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&amp;", "&")
}

fn event_id(xml: &str) -> Option<u32> {
    let rest = &xml[xml.find("<EventID")?..];
    let rest = &rest[rest.find('>')? + 1..];
    rest[..rest.find("</EventID>")?].trim().parse().ok()
}

/// The text of `<name>...</name>`.
fn element_text(xml: &str, name: &str) -> Option<String> {
    let open = format!("<{name}>");
    let start = xml.find(&open)? + open.len();
    let end = xml[start..].find(&format!("</{name}>"))? + start;
    Some(decode(xml[start..end].trim())).filter(|text| !text.is_empty())
}

/// An attribute of the first `<element ...>`.
fn attribute(xml: &str, element: &str, attribute: &str) -> Option<String> {
    let start = xml.find(&format!("<{element} "))?;
    let tag = &xml[start..start + xml[start..].find('>')?];
    let key = format!("{attribute}=\"");
    let from = tag.find(&key)? + key.len();
    Some(decode(&tag[from..from + tag[from..].find('"')?])).filter(|text| !text.is_empty())
}

/// The text of `<Data Name="name">...</Data>`.
fn event_data(xml: &str, name: &str) -> Option<String> {
    let open = format!("<Data Name=\"{name}\">");
    let start = xml.find(&open)? + open.len();
    let end = xml[start..].find("</Data>")? + start;
    Some(decode(xml[start..end].trim())).filter(|text| !text.is_empty())
}

fn is_sha256(text: &str) -> bool {
    text.len() == 64 && text.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn file_name_of(path: &str) -> &str {
    path.rsplit(['\\', '/']).next().unwrap_or(path)
}

fn starts_with_ci(text: &str, prefix: &str) -> bool {
    text.len() >= prefix.len() && text.is_char_boundary(prefix.len()) && text[..prefix.len()].eq_ignore_ascii_case(prefix)
}

/// The folder class of a path as AppLocker writes it (`%OSDRIVE%\USERS\...`, `%WINDIR%\...`,
/// `%PROGRAMFILES%\...`, `%REMOVABLE%\...`, `%HOT%\...`).
fn applocker_class(path: &str, ctx: &FolderCtx) -> &'static str {
    if starts_with_ci(path, "%REMOVABLE%") || starts_with_ci(path, "%HOT%") {
        return "removable";
    }
    let tail = |prefix: &str| path[prefix.len()..].trim_start_matches('\\').to_string();
    let expanded = if starts_with_ci(path, "%OSDRIVE%") {
        format!("{}\\{}", ctx.os_drive, tail("%OSDRIVE%"))
    } else if starts_with_ci(path, "%SYSTEM32%") {
        format!("{}\\System32\\{}", ctx.windows, tail("%SYSTEM32%"))
    } else if starts_with_ci(path, "%WINDIR%") {
        format!("{}\\{}", ctx.windows, tail("%WINDIR%"))
    } else if starts_with_ci(path, "%PROGRAMFILES%") {
        format!("{}\\Program Files\\{}", ctx.os_drive, tail("%PROGRAMFILES%"))
    } else {
        path.to_string()
    };
    let drive: String = expanded.chars().take(2).collect();
    if ctx.removable_volumes.iter().any(|volume| volume.eq_ignore_ascii_case(&drive)) {
        return "removable";
    }
    procwatch::folder_class(&expanded, &ctx.windows, &ctx.protected)
}

/// The folder class of a Code Integrity path (`\Device\HarddiskVolume3\Windows\...`).
fn device_class(path: &str, ctx: &FolderCtx) -> &'static str {
    let Some(rest) = path.strip_prefix("\\Device\\") else {
        return procwatch::folder_class(path, &ctx.windows, &ctx.protected);
    };
    let (volume, tail) = rest.split_once('\\').unwrap_or((rest, ""));
    let volume = format!("\\Device\\{volume}");
    if ctx.removable_volumes.iter().any(|known| known.eq_ignore_ascii_case(&volume)) {
        return "removable";
    }
    match &ctx.system_volume {
        Some(system) if system.eq_ignore_ascii_case(&volume) => {
            procwatch::folder_class(&format!("{}\\{tail}", ctx.os_drive), &ctx.windows, &ctx.protected)
        }
        _ => "other",
    }
}

/// `O=PUBLISHER, L=..., C=US\PRODUCT\FILE.EXE\VERSION` (or `-` for unsigned): the signer's CN and O,
/// and the product.
fn parse_fqbn(fqbn: &str) -> (Option<String>, Option<String>) {
    if fqbn.trim() == "-" {
        return (None, None);
    }
    let mut parts = fqbn.split('\\');
    let signer = parts.next().map(rulebox_win32::fileid::short_signer).filter(|signer| !signer.is_empty());
    let product = parts.next().map(str::trim).filter(|product| !product.is_empty() && *product != "*").map(str::to_string);
    (signer, product)
}

fn bounded(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

/// AppLocker events 8003 and 8006 (audit: would have been blocked) and 8004 and 8007 (blocked),
/// of the Staff account only. `None` for anything else.
pub fn parse_applocker(xml: &str, staff_sid: &str, ctx: &FolderCtx) -> Option<Observation> {
    let outcome = match event_id(xml)? {
        8003 | 8006 => Outcome::Audit,
        8004 | 8007 => Outcome::Blocked,
        _ => return None,
    };
    let user = attribute(xml, "Security", "UserID").or_else(|| element_text(xml, "TargetUser"))?;
    if staff_sid.is_empty() || !user.eq_ignore_ascii_case(staff_sid) {
        return None;
    }
    let path = element_text(xml, "FilePath")?;
    let file_name = bounded(file_name_of(&path), 100);
    if file_name.is_empty() {
        return None;
    }
    let (signer, product) = element_text(xml, "Fqbn").map_or((None, None), |fqbn| parse_fqbn(&fqbn));
    // The hash is part of the finding only for a file nobody signed.
    let sha256 = element_text(xml, "FileHash")
        .filter(|hash| signer.is_none() && is_sha256(hash))
        .map(|hash| hash.to_ascii_lowercase());
    Some(Observation {
        layer: FindingLayer::AppLocker,
        outcome,
        file_name,
        folder_class: applocker_class(&path, ctx),
        signer: signer.map(|signer| bounded(&signer, 200)),
        product: product.map(|product| bounded(&product, 100)),
        sha256,
    })
}

fn is_rulebox_policy(guid: &str) -> bool {
    let guid = guid.trim().trim_start_matches('{').trim_end_matches('}');
    RULEBOX_POLICY_IDS.iter().any(|id| id.eq_ignore_ascii_case(guid))
}

/// Code Integrity events 3076 (audit) and 3077 (blocked), for Rulebox's own policies only. The
/// event names the file, the process that started it (never read) and the policy.
pub fn parse_code_integrity(xml: &str, ctx: &FolderCtx) -> Option<Observation> {
    let outcome = match event_id(xml)? {
        3076 => Outcome::Audit,
        3077 => Outcome::Blocked,
        _ => return None,
    };
    let policy = event_data(xml, "PolicyGUID").or_else(|| event_data(xml, "PolicyId"))?;
    if !is_rulebox_policy(&policy) {
        return None;
    }
    let path = event_data(xml, "File Name")?;
    let file_name = bounded(file_name_of(&path), 100);
    if file_name.is_empty() {
        return None;
    }
    let sha256 = event_data(xml, "SHA256 Hash")
        .or_else(|| event_data(xml, "SHA256 Flat Hash"))
        .filter(|hash| is_sha256(hash))
        .map(|hash| hash.to_ascii_lowercase());
    Some(Observation {
        layer: FindingLayer::AppControl,
        outcome,
        file_name,
        folder_class: device_class(&path, ctx),
        // The event carries no certificate subject, so the hash tells files apart.
        signer: None,
        product: event_data(xml, "ProductName").map(|product| bounded(&product, 100)),
        sha256,
    })
}

// ---------------------------------------------------------------- the store

/// One fingerprint on the device.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StoredFinding {
    pub fingerprint: String,
    pub layer: String,
    pub file_name: String,
    pub folder_class: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signer: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub product: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    pub first_seen_ms: u64,
    pub last_seen_ms: u64,
    pub count: u64,
    /// The server has this fingerprint: it is never sent again.
    pub reported: bool,
}

impl StoredFinding {
    fn report(&self) -> FindingReport {
        FindingReport {
            fingerprint: self.fingerprint.clone(),
            layer: self.layer.clone(),
            file_name: self.file_name.clone(),
            folder_class: self.folder_class.clone(),
            signer: self.signer.clone(),
            product: self.product.clone(),
            sha256: self.sha256.clone(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
struct FlushLog {
    /// The server day of `flushes`.
    day: String,
    flushes: u32,
    last_flush_ms: u64,
}

#[derive(Serialize, Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
struct FindingsFile {
    schema: u32,
    /// Fingerprints that fell out of the store (full, or oldest first).
    dropped: u64,
    flush: FlushLog,
    /// Least recently seen first.
    findings: Vec<StoredFinding>,
}

/// `findings.json`.
pub struct FindingsStore {
    path: PathBuf,
    file: FindingsFile,
    dirty: bool,
}

impl FindingsStore {
    pub fn open(path: PathBuf) -> std::io::Result<Self> {
        let mut file = read_json::<FindingsFile>(&path)?.unwrap_or_default();
        file.schema = 1;
        let mut store = Self { path, file, dirty: false };
        while store.file.findings.len() > MAX_FINDINGS {
            store.evict_one();
        }
        Ok(store)
    }

    pub fn len(&self) -> usize {
        self.file.findings.len()
    }

    pub fn dropped(&self) -> u64 {
        self.file.dropped
    }

    pub fn unreported(&self) -> usize {
        self.file.findings.iter().filter(|finding| !finding.reported).count()
    }

    /// The findings, least recently seen first (tests, and the Staff-side count).
    pub fn all(&self) -> &[StoredFinding] {
        &self.file.findings
    }

    fn evict_one(&mut self) {
        let victim = self.file.findings.iter().position(|finding| finding.reported).unwrap_or(0);
        self.file.findings.remove(victim);
        self.file.dropped = self.file.dropped.saturating_add(1);
    }

    /// Notes a sighting. Returns true when the fingerprint is new on this device.
    pub fn ingest(&mut self, observation: &Observation, now_ms: u64) -> bool {
        self.upsert(
            StoredFinding {
                fingerprint: observation.fingerprint(),
                layer: observation.layer.word().to_string(),
                file_name: observation.file_name.clone(),
                folder_class: observation.folder_class.to_string(),
                signer: observation.signer.clone(),
                product: observation.product.clone(),
                sha256: observation.sha256.clone(),
                first_seen_ms: now_ms,
                last_seen_ms: now_ms,
                count: 1,
                reported: false,
            },
            now_ms,
        )
    }

    /// Takes over what the process watch collected (it hands its list over once).
    pub fn ingest_procwatch(&mut self, records: Vec<FindingRecord>, now_ms: u64) -> usize {
        let mut new = 0;
        for record in records {
            let finding = record.finding;
            let stored = StoredFinding {
                fingerprint: finding.fingerprint,
                layer: FindingLayer::ProcWatch.word().to_string(),
                file_name: bounded(&finding.file_name, 100),
                folder_class: finding.folder_class.to_string(),
                signer: finding.signer.map(|signer| bounded(&signer, 200)),
                product: finding.product.map(|product| bounded(&product, 100)),
                sha256: None,
                first_seen_ms: now_ms,
                last_seen_ms: now_ms,
                count: record.count.max(1),
                reported: false,
            };
            if self.upsert(stored, now_ms) {
                new += 1;
            }
        }
        new
    }

    fn upsert(&mut self, incoming: StoredFinding, now_ms: u64) -> bool {
        self.dirty = true;
        if let Some(index) = self.file.findings.iter().position(|finding| finding.fingerprint == incoming.fingerprint) {
            let mut finding = self.file.findings.remove(index);
            finding.count = finding.count.saturating_add(incoming.count);
            finding.last_seen_ms = now_ms;
            self.file.findings.push(finding);
            return false;
        }
        if self.file.findings.len() >= MAX_FINDINGS {
            self.evict_one();
        }
        self.file.findings.push(incoming);
        true
    }

    // -- flush rules (plan 4.19) --

    fn flushes_on(&self, day: &str) -> u32 {
        if self.file.flush.day == day {
            self.file.flush.flushes
        } else {
            0
        }
    }

    /// When the next call may be made, or `None` when there is nothing new to say. A call at
    /// `due` or later is allowed; a timer for `due` is the only timer findings ever need.
    pub fn flush_due(&self, now_ms: u64, day: &str, next_day_ms: u64) -> Option<u64> {
        let unreported: Vec<&StoredFinding> = self.file.findings.iter().filter(|finding| !finding.reported).collect();
        if unreported.is_empty() {
            return None;
        }
        let first_new = unreported.iter().map(|finding| finding.first_seen_ms).min().unwrap_or(now_ms);
        let settled = if unreported.len() >= MAX_FINDINGS_PER_CALL { 0 } else { first_new.saturating_add(FLUSH_SETTLE_MS) };
        let gap = if self.file.flush.last_flush_ms == 0 { 0 } else { self.file.flush.last_flush_ms.saturating_add(MIN_FLUSH_GAP_MS) };
        let mut due = settled.max(gap);
        if self.flushes_on(day) >= MAX_FLUSHES_PER_DAY {
            due = due.max(next_day_ms);
        }
        Some(due)
    }

    /// The next call's fingerprints: the oldest new ones, at most 50.
    pub fn next_flush(&self) -> Vec<FindingReport> {
        self.file
            .findings
            .iter()
            .filter(|finding| !finding.reported)
            .take(MAX_FINDINGS_PER_CALL)
            .map(StoredFinding::report)
            .collect()
    }

    /// The server took these fingerprints: they are never sent again.
    pub fn mark_reported(&mut self, fingerprints: &[String], now_ms: u64, day: &str) {
        for finding in &mut self.file.findings {
            if fingerprints.contains(&finding.fingerprint) {
                finding.reported = true;
            }
        }
        let flushes = self.flushes_on(day) + 1;
        self.file.flush = FlushLog { day: day.to_string(), flushes, last_flush_ms: now_ms };
        self.dirty = true;
    }

    pub fn save_if_dirty(&mut self) -> std::io::Result<()> {
        if !self.dirty {
            return Ok(());
        }
        let bytes = serde_json::to_vec_pretty(&self.file).map_err(std::io::Error::other)?;
        write_atomic(&self.path, &bytes)?;
        self.dirty = false;
        Ok(())
    }

    /// Deletes everything (unenroll).
    pub fn clear(&mut self) -> std::io::Result<()> {
        self.file = FindingsFile { schema: 1, ..FindingsFile::default() };
        self.dirty = false;
        crate::state::remove_file_if_exists(&self.path)
    }
}

// ---------------------------------------------------------------- the collector

#[derive(Serialize, Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
struct BookmarkFile {
    schema: u32,
    /// Event channel -> highest record id read.
    channels: BTreeMap<String, u64>,
}

/// What one collection round found.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct CollectStats {
    pub events: usize,
    pub new_fingerprints: usize,
    /// Events of programs the layers stopped (enforce), for the daily summary.
    pub blocked_app_locker: u64,
    pub blocked_app_control: u64,
    /// Channels that could not be read this time (logged once each by the caller).
    pub unreadable: usize,
}

/// Reads the event logs and the process watch into the store.
pub struct Collector {
    pub store: FindingsStore,
    bookmarks: BookmarkFile,
    bookmarks_path: PathBuf,
    bookmarks_dirty: bool,
}

impl Collector {
    pub fn open(findings: PathBuf, bookmarks: PathBuf) -> std::io::Result<Self> {
        let mut file = read_json::<BookmarkFile>(&bookmarks)?.unwrap_or_default();
        file.schema = 1;
        Ok(Self { store: FindingsStore::open(findings)?, bookmarks: file, bookmarks_path: bookmarks, bookmarks_dirty: false })
    }

    /// The highest record id read from `channel`.
    pub fn bookmark(&self, channel: &str) -> u64 {
        self.bookmarks.channels.get(channel).copied().unwrap_or(0)
    }

    /// Reads what the event logs gained since the last time. Local reads only; call it at a
    /// moment that already exists (a Staff sign-out, the agent start, before a flush), never on
    /// a timer of its own. Both files are written once at the end.
    pub fn collect(&mut self, platform: &dyn Platform, staff_sid: Option<&str>, ctx: &FolderCtx, now_ms: u64) -> CollectStats {
        let mut stats = CollectStats::default();
        for (channel, source) in AUDIT_CHANNELS {
            for _ in 0..MAX_ROUNDS {
                let after = self.bookmark(channel);
                let events = match platform.read_event_log(channel, after, READ_BATCH) {
                    Ok(events) => events,
                    Err(error) => {
                        tracing::debug!("cannot read {channel}: {error}");
                        stats.unreadable += 1;
                        break;
                    }
                };
                let Some(last) = events.last().map(|event| event.record_id) else { break };
                let full = events.len() >= READ_BATCH;
                for event in &events {
                    stats.events += 1;
                    let observation = match source {
                        Source::AppLocker => staff_sid.and_then(|sid| parse_applocker(&event.xml, sid, ctx)),
                        Source::CodeIntegrity => parse_code_integrity(&event.xml, ctx),
                    };
                    let Some(observation) = observation else { continue };
                    if observation.outcome == Outcome::Blocked {
                        match observation.layer {
                            FindingLayer::AppLocker => stats.blocked_app_locker += 1,
                            _ => stats.blocked_app_control += 1,
                        }
                    }
                    if self.store.ingest(&observation, now_ms) {
                        stats.new_fingerprints += 1;
                    }
                }
                self.bookmarks.channels.insert(channel.to_string(), last.max(after));
                self.bookmarks_dirty = true;
                if !full {
                    break;
                }
            }
        }
        self.save();
        stats
    }

    /// Takes the process watch's list into the store.
    pub fn take_procwatch(&mut self, records: Vec<FindingRecord>, now_ms: u64) -> usize {
        let new = self.store.ingest_procwatch(records, now_ms);
        self.save();
        new
    }

    /// Writes what changed. A write that fails is logged; the data stays in memory.
    pub fn save(&mut self) {
        if let Err(error) = self.store.save_if_dirty() {
            tracing::error!("cannot save findings.json: {error}");
        }
        if self.bookmarks_dirty {
            let saved = serde_json::to_vec_pretty(&self.bookmarks)
                .map_err(std::io::Error::other)
                .and_then(|bytes| write_atomic(&self.bookmarks_path, &bytes));
            match saved {
                Ok(()) => self.bookmarks_dirty = false,
                Err(error) => tracing::error!("cannot save findings-state.json: {error}"),
            }
        }
    }

    /// Deletes both files (unenroll).
    pub fn clear(&mut self) -> std::io::Result<()> {
        self.bookmarks = BookmarkFile { schema: 1, ..BookmarkFile::default() };
        self.bookmarks_dirty = false;
        crate::state::remove_file_if_exists(&self.bookmarks_path)?;
        self.store.clear()
    }
}

#[cfg(test)]
mod tests;
