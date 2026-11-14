//! L5 the process watchdog (plan 4.10, Phase 5 Step 8): every process that starts in the Staff
//! session is checked against the compiled allow-list (the same `AllowList` AppLocker uses,
//! plan D2). `audit` records a finding; `enforce` also ends the process.
//!
//! How it runs (light on a 4 GB laptop, plan Section 14):
//!
//! - The process-start trace (`rulebox_win32::etw`, one real-time session) calls a sink on its
//!   own thread. The sink only drops session-0 events and queues the rest in a **bounded**
//!   channel (256). A full queue drops the event, counts it and asks for one snapshot catch-up
//!   (edge case 45); nothing grows.
//! - One worker thread takes events off the queue and decides. It blocks in `recv_timeout`; the
//!   only timers are a one-minute check of the kernel's loss counters (trace) or the 2-second
//!   snapshot diff (fallback when the trace cannot start, edge case 44). No busy loop.
//! - A decision reads the process (image, owner) from the process itself, never from the
//!   event's image text, never a command line or a window title (plan rule 6). A process that
//!   is not owned by the Staff account is ignored. The never-terminate list is checked first.
//!   The signer, the version-resource names and the hash are read only for images the folder
//!   rules do not settle, and cached (2,000 entries, keyed by path + size + times).
//! - `enforce` ends a process with `terminate_process(pid, image, staff_sid)`, which checks image
//!   and owner again on the handle it kills with. The notice `program.blocked` goes out once per
//!   program until [`ProcWatch::new_session`].
//!
//! Nothing here starts a trace in a test: tests feed events through `SimPlatform`.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender, TrySendError};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use rulebox_policy::lockdown::{ExceptionLayer, LayerMode};
use rulebox_policy::AgentDoc;
use sha2::{Digest, Sha256};

use super::allowlist::{self, clean, inside, AllowException, AllowList, Inputs, MICROSOFT_WINDOWS_PUBLISHER};
use super::applocker::{protected_folders, staff_sid, SCAN_DEPTH};
use super::apply::ApplyCtx;
use super::{LayerState, LayerStatus, ReportedMode};
use crate::platform::{
    FileIdentity, FileStamp, Platform, PlatformError, ProcessInfo, ProcessSink, ProcessStart, SessionState, TraceHandle,
};

// ---------------------------------------------------------------- limits

/// Events waiting for the worker.
pub const QUEUE_CAPACITY: usize = 256;
/// Signature cache entries (plan Section 14).
pub const CACHE_CAPACITY: usize = 2_000;
/// How often the loss counters of the trace are read (edge case 45).
pub const STATS_INTERVAL: Duration = Duration::from_secs(60);
/// The snapshot diff when the trace cannot start (edge case 44).
pub const POLL_INTERVAL: Duration = Duration::from_secs(2);
/// Files bigger than this are not hashed (a hash rule never matches them).
pub const MAX_HASH_BYTES: u64 = 64 * 1024 * 1024;
/// Processes remembered as handled (so a snapshot does not decide twice).
const HANDLED_CAPACITY: usize = 2_048;
/// Programs remembered as announced, and findings kept, until the owner drains them.
const NOTICE_CAPACITY: usize = 256;
pub const FINDINGS_CAPACITY: usize = 500;
/// `program.blocked` carries at most this many characters (plan 4.12).
const DISPLAY_NAME_MAX: usize = 100;

// ---------------------------------------------------------------- the never-terminate list

/// Windows' own programs of `System32` and `SysWOW64` that are never ended (edge case 46). Matched
/// by name **and** folder, so a copy of `dwm.exe` in a user folder gets no protection.
pub const NEVER_TERMINATE_SYSTEM32: &[&str] =
    &["conhost.exe", "csrss.exe", "ctfmon.exe", "dwm.exe", "fontdrvhost.exe", "winlogon.exe"];

/// Programs of `<Windows>\SystemApps\<package>\` that are never ended (the on-screen keyboard
/// host, edge case 46).
pub const NEVER_TERMINATE_SYSTEM_APPS: &[&str] = &["textinputhost.exe"];

// ---------------------------------------------------------------- the verdict

/// What the watchdog does with a denied program.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Audit,
    Enforce,
}

impl Mode {
    pub fn from_layer(mode: LayerMode) -> Option<Mode> {
        match mode {
            LayerMode::Audit => Some(Mode::Audit),
            LayerMode::Enforce => Some(Mode::Enforce),
            LayerMode::Off | LayerMode::Unknown => None,
        }
    }

    fn reported(self) -> ReportedMode {
        match self {
            Mode::Audit => ReportedMode::Audit,
            Mode::Enforce => ReportedMode::Enforce,
        }
    }
}

/// Why a program may run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Allowed {
    /// On the never-terminate list, or in a Rulebox or WebView2 folder.
    NeverTerminate,
    InvariantFolder,
    /// In the Windows folder and not on the Staff deny list (edge case 46).
    WindowsFolder,
    CatalogueFolder,
    PathException,
    PublisherException,
    HashException,
}

/// Why a program may not run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Denied {
    /// A program of `STAFF_DENY_WINDOWS_BINARIES` at its place in the Windows folder.
    WindowsBinary,
    /// A Microsoft-signed copy of one of them, renamed, in a Windows folder Staff can write to.
    RenamedWindowsBinary,
    /// Not Microsoft's, in a Windows folder Staff can write to.
    WritableWindowsFolder,
    /// Outside every allowed folder and no exception matches.
    NotInAllowList,
}

impl Denied {
    /// The fixed code of a finding.
    pub fn code(self) -> &'static str {
        match self {
            Denied::WindowsBinary => "windows_binary_denied",
            Denied::RenamedWindowsBinary => "windows_binary_renamed",
            Denied::WritableWindowsFolder => "writable_windows_folder",
            Denied::NotInAllowList => "not_in_allow_list",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    /// The token user is not the Staff account.
    NotStaff,
    Allowed(Allowed),
    Denied(Denied),
}

// ---------------------------------------------------------------- the matcher

/// What the matcher may ask about a file: the identity and the hash, cached by the caller.
pub trait Lookup {
    fn identity(&mut self, image: &Path) -> Option<FileIdentity>;
    fn sha256(&mut self, image: &Path) -> Option<String>;
}

struct PublisherRule {
    subject: String,
    product: Option<String>,
    file_name: Option<String>,
}

fn key(path: &str) -> String {
    clean(path).to_ascii_lowercase()
}

fn file_name_of(path: &str) -> &str {
    path.rsplit(['\\', '/']).next().unwrap_or(path)
}

fn parent_of(path: &str) -> String {
    clean(path).rsplit_once('\\').map_or(String::new(), |(head, _)| head.to_string())
}

/// Whether a signer is Microsoft's (the Windows inbox signer or any Microsoft Corporation one).
fn microsoft_signed(signer: &str) -> bool {
    signer.eq_ignore_ascii_case(MICROSOFT_WINDOWS_PUBLISHER) || signer.to_ascii_lowercase().contains("o=microsoft corporation")
}

/// Whether an exception's publisher name matches the signer. AppLocker publisher names leave out
/// the `CN=` part of the subject, so a name that equals the signer without its first part matches.
fn subject_matches(rule: &str, signer: &str) -> bool {
    let (rule, signer) = (rule.trim().to_ascii_lowercase(), signer.trim().to_ascii_lowercase());
    signer == rule || signer.strip_prefix("cn=").and_then(|rest| rest.split_once(", ")).is_some_and(|(_, tail)| tail == rule)
}

/// The compiled decision over an [`AllowList`] (plan 4.10 step 2). Built once per apply; every
/// string is normalised here so a decision does no allocation for the common allowed paths.
pub struct Matcher {
    staff_sid: String,
    own_pid: u32,
    protected: Vec<String>,
    windows: String,
    system32: [String; 2],
    system_apps: String,
    invariant: Vec<String>,
    excluded_folders: Vec<String>,
    excluded_files: HashSet<String>,
    excluded_names: HashSet<String>,
    catalogue: Vec<String>,
    path_exceptions: HashSet<String>,
    publishers: Vec<PublisherRule>,
    hashes: HashSet<String>,
}

impl Matcher {
    pub fn new(allow: &AllowList, protected: &[String], staff_sid: &str, own_pid: u32) -> Self {
        let mut publishers = Vec::new();
        let mut path_exceptions = HashSet::new();
        let mut hashes = HashSet::new();
        for exception in &allow.exceptions {
            match exception {
                AllowException::Publisher { subject, product, file_name } => publishers.push(PublisherRule {
                    subject: subject.clone(),
                    product: product.as_ref().map(|p| p.to_ascii_lowercase()),
                    file_name: file_name.as_ref().map(|f| f.to_ascii_lowercase()),
                }),
                AllowException::Hash { sha256, .. } => {
                    hashes.insert(sha256.to_ascii_lowercase());
                }
                AllowException::Path(path) => {
                    path_exceptions.insert(key(path));
                }
            }
        }
        let windows = clean(&allow.windows);
        Self {
            staff_sid: staff_sid.to_string(),
            own_pid,
            protected: protected.iter().map(|p| clean(p)).filter(|p| !p.is_empty()).collect(),
            system32: [format!("{windows}\\System32"), format!("{windows}\\SysWOW64")],
            system_apps: format!("{windows}\\SystemApps"),
            windows,
            invariant: allow.invariant.iter().map(|p| clean(p)).collect(),
            excluded_folders: allow.windows_excluded_folders.iter().map(|p| clean(p)).collect(),
            excluded_files: allow.windows_excluded_files.iter().map(|p| key(p)).collect(),
            excluded_names: allow.windows_excluded_names.iter().map(|n| n.to_ascii_lowercase()).collect(),
            catalogue: allow.catalogue.iter().map(|p| clean(p)).collect(),
            path_exceptions,
            publishers,
            hashes,
        }
    }

    pub fn staff_sid(&self) -> &str {
        &self.staff_sid
    }

    /// Plan 4.10 step 2 and edge case 46: the Rulebox and WebView2 folders, the agent itself, and
    /// Windows' fixed list by name in its own folder.
    fn never_terminate(&self, pid: u32, image: &str) -> bool {
        if pid == self.own_pid || self.protected.iter().any(|root| inside(image, root)) {
            return true;
        }
        let name = file_name_of(image).to_ascii_lowercase();
        let folder = parent_of(image);
        if NEVER_TERMINATE_SYSTEM32.contains(&name.as_str()) && self.system32.iter().any(|dir| key(dir) == key(&folder)) {
            return true;
        }
        NEVER_TERMINATE_SYSTEM_APPS.contains(&name.as_str()) && inside(&folder, &self.system_apps)
    }

    /// The exceptions, asked only for an image the folders did not allow. Publisher rules need the
    /// identity; hash rules need the hash, which is read only when a hash rule exists.
    fn exception(&self, image: &Path, identity: Option<&FileIdentity>, lookup: &mut dyn Lookup) -> Option<Allowed> {
        if let Some(identity) = identity {
            if let Some(signer) = identity.signer.as_deref() {
                let name = file_name_of(&image.to_string_lossy()).to_ascii_lowercase();
                let original = identity.original_name.as_deref().map(str::to_ascii_lowercase);
                let product = identity.product.as_deref().map(str::to_ascii_lowercase);
                let hit = self.publishers.iter().any(|rule| {
                    subject_matches(&rule.subject, signer)
                        && rule.product.as_ref().is_none_or(|p| product.as_ref() == Some(p))
                        && rule.file_name.as_ref().is_none_or(|f| *f == name || original.as_ref() == Some(f))
                });
                if hit {
                    return Some(Allowed::PublisherException);
                }
            }
        }
        if !self.hashes.is_empty() && lookup.sha256(image).is_some_and(|hash| self.hashes.contains(&hash)) {
            return Some(Allowed::HashException);
        }
        None
    }

    /// Decides one process. `info` was read from the process itself.
    pub fn decide(&self, info: &ProcessInfo, lookup: &mut dyn Lookup) -> Verdict {
        if !info.user_sid.eq_ignore_ascii_case(&self.staff_sid) {
            return Verdict::NotStaff;
        }
        let image = clean(&info.image.to_string_lossy());
        if self.never_terminate(info.pid, &image) {
            return Verdict::Allowed(Allowed::NeverTerminate);
        }
        if self.path_exceptions.contains(&key(&image)) {
            return Verdict::Allowed(Allowed::PathException);
        }

        if inside(&image, &self.windows) {
            if self.excluded_files.contains(&key(&image)) {
                return Verdict::Denied(Denied::WindowsBinary);
            }
            if !self.excluded_folders.iter().any(|folder| inside(&image, folder)) {
                // Edge case 46: nothing else under the Windows folder is ended.
                return Verdict::Allowed(Allowed::WindowsFolder);
            }
            // A Windows folder Staff can write to: Microsoft's own files in it are Windows'
            // (judged by the deny list's names), anything else is somebody's program.
            let identity = lookup.identity(&info.image);
            if let Some(signer) = identity.as_ref().and_then(|id| id.signer.as_deref()) {
                if microsoft_signed(signer) {
                    let original = identity.as_ref().and_then(|id| id.original_name.as_deref());
                    let renamed = original.is_some_and(|name| self.excluded_names.contains(&name.to_ascii_lowercase()));
                    return if renamed { Verdict::Denied(Denied::RenamedWindowsBinary) } else { Verdict::Allowed(Allowed::WindowsFolder) };
                }
            }
            return match self.exception(&info.image, identity.as_ref(), lookup) {
                Some(allowed) => Verdict::Allowed(allowed),
                None => Verdict::Denied(Denied::WritableWindowsFolder),
            };
        }

        if self.invariant.iter().any(|root| inside(&image, root)) {
            return Verdict::Allowed(Allowed::InvariantFolder);
        }
        if self.catalogue.iter().any(|root| inside(&image, root)) {
            return Verdict::Allowed(Allowed::CatalogueFolder);
        }
        let identity = if self.publishers.is_empty() { None } else { lookup.identity(&info.image) };
        match self.exception(&info.image, identity.as_ref(), lookup) {
            Some(allowed) => Verdict::Allowed(allowed),
            None => Verdict::Denied(Denied::NotInAllowList),
        }
    }
}

// ---------------------------------------------------------------- the signature cache

struct CacheEntry {
    stamp: FileStamp,
    identity: Option<FileIdentity>,
    /// `None`: not computed yet. `Some(None)`: computed, no hash (too big, unreadable).
    sha256: Option<Option<String>>,
}

/// Identity and hash of program files, keyed by path, valid while the stamp (size and times) is
/// the same. Oldest entries go first.
pub struct IdentityCache {
    entries: HashMap<String, CacheEntry>,
    order: VecDeque<String>,
    capacity: usize,
}

impl IdentityCache {
    pub fn new(capacity: usize) -> Self {
        Self { entries: HashMap::new(), order: VecDeque::new(), capacity: capacity.max(1) }
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// The entry for `path` if its stamp still matches; a stale one is dropped.
    fn fresh(&mut self, path: &str, stamp: FileStamp) -> Option<&mut CacheEntry> {
        if self.entries.get(path).is_some_and(|entry| entry.stamp != stamp) {
            self.entries.remove(path);
            self.order.retain(|k| k != path);
        }
        self.entries.get_mut(path)
    }

    fn insert(&mut self, path: String, entry: CacheEntry) {
        while self.entries.len() >= self.capacity {
            match self.order.pop_front() {
                Some(oldest) => {
                    self.entries.remove(&oldest);
                }
                None => break,
            }
        }
        self.order.push_back(path.clone());
        self.entries.insert(path, entry);
    }
}

/// The matcher's view of the platform, through the cache.
struct Probe<'a> {
    platform: &'a dyn Platform,
    cache: &'a mut IdentityCache,
    counters: &'a Counters,
}

impl Lookup for Probe<'_> {
    fn identity(&mut self, image: &Path) -> Option<FileIdentity> {
        let stamp = self.platform.file_stamp(image).ok().flatten()?;
        let path = key(&image.to_string_lossy());
        if let Some(entry) = self.cache.fresh(&path, stamp) {
            self.counters.cache_hits.fetch_add(1, Ordering::Relaxed);
            return entry.identity.clone();
        }
        self.counters.identity_reads.fetch_add(1, Ordering::Relaxed);
        let identity = self.platform.file_identity(image).ok().flatten();
        self.cache.insert(path, CacheEntry { stamp, identity: identity.clone(), sha256: None });
        identity
    }

    fn sha256(&mut self, image: &Path) -> Option<String> {
        let stamp = self.platform.file_stamp(image).ok().flatten()?;
        let path = key(&image.to_string_lossy());
        if let Some(entry) = self.cache.fresh(&path, stamp) {
            if let Some(known) = &entry.sha256 {
                return known.clone();
            }
        }
        self.counters.hash_reads.fetch_add(1, Ordering::Relaxed);
        let hash = self.platform.file_sha256(image, MAX_HASH_BYTES).ok().flatten();
        match self.cache.fresh(&path, stamp) {
            Some(entry) => entry.sha256 = Some(hash.clone()),
            None => self.cache.insert(path, CacheEntry { stamp, identity: None, sha256: Some(hash.clone()) }),
        }
        hash
    }
}

// ---------------------------------------------------------------- findings

/// One finding of the watchdog (plan 4.10). The full path never leaves the device: only the file
/// name and a folder class (rule 6). Step 9 collects these.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Finding {
    /// SHA-256 of `layer | lower(fileName) | folderClass | signer | sha256?`.
    pub fingerprint: String,
    pub layer: &'static str,
    pub file_name: String,
    pub folder_class: &'static str,
    /// The leaf certificate's `CN=` and `O=`.
    pub signer: Option<String>,
    pub product: Option<String>,
    pub reason: &'static str,
}

/// A finding and how often it was seen.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FindingRecord {
    pub finding: Finding,
    pub count: u64,
}

/// `windows`, `programFiles`, `rulebox`, `userProfile`, `userTemp`, `network` or `other` (plan
/// 4.10; `removable` needs the drive type and is left to Step 9).
pub fn folder_class(image: &str, windows: &str, protected: &[String]) -> &'static str {
    let image = clean(image);
    let lower = image.to_ascii_lowercase();
    let drive: String = lower.chars().take(2).collect();
    if lower.starts_with("\\\\") {
        "network"
    } else if protected.iter().any(|root| inside(&image, root) && key(root).contains("rulebox")) {
        "rulebox"
    } else if lower.contains("\\temp\\") || lower.contains("\\appdata\\local\\temp") {
        "userTemp"
    } else if inside(&image, windows) {
        "windows"
    } else if inside(&image, &format!("{drive}\\program files")) || inside(&image, &format!("{drive}\\program files (x86)")) {
        "programFiles"
    } else if inside(&image, &format!("{drive}\\users")) {
        "userProfile"
    } else {
        "other"
    }
}

fn fingerprint(file_name: &str, class: &str, signer: &str, sha256: &str) -> String {
    let text = format!("procWatch|{}|{class}|{signer}|{sha256}", file_name.to_ascii_lowercase());
    Sha256::digest(text.as_bytes()).iter().map(|byte| format!("{byte:02x}")).collect()
}

// ---------------------------------------------------------------- the engine

/// Counters of one watch: numbers only (plan rule 6). All relaxed atomics.
#[derive(Default)]
pub struct Counters {
    pub events: AtomicU64,
    /// Events dropped because the queue was full.
    pub dropped: AtomicU64,
    /// Events of session 0 (never Staff), dropped by the sink.
    pub session_zero: AtomicU64,
    /// Processes that had ended before they could be read.
    pub gone: AtomicU64,
    pub not_staff: AtomicU64,
    pub allowed: AtomicU64,
    pub denied: AtomicU64,
    /// Processes ended in `enforce`.
    pub terminated: AtomicU64,
    pub terminate_failed: AtomicU64,
    /// Termination refused by the test-machine guard.
    pub guarded: AtomicU64,
    pub snapshots: AtomicU64,
    /// Events the kernel reported lost (edge case 45).
    pub lost: AtomicU64,
    pub cache_hits: AtomicU64,
    pub identity_reads: AtomicU64,
    pub hash_reads: AtomicU64,
}

/// A plain copy of [`Counters`].
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CounterView {
    pub events: u64,
    pub dropped: u64,
    pub session_zero: u64,
    pub gone: u64,
    pub not_staff: u64,
    pub allowed: u64,
    pub denied: u64,
    pub terminated: u64,
    pub terminate_failed: u64,
    pub guarded: u64,
    pub snapshots: u64,
    pub lost: u64,
    pub cache_hits: u64,
    pub identity_reads: u64,
    pub hash_reads: u64,
}

impl Counters {
    pub fn view(&self) -> CounterView {
        let get = |counter: &AtomicU64| counter.load(Ordering::Relaxed);
        CounterView {
            events: get(&self.events),
            dropped: get(&self.dropped),
            session_zero: get(&self.session_zero),
            gone: get(&self.gone),
            not_staff: get(&self.not_staff),
            allowed: get(&self.allowed),
            denied: get(&self.denied),
            terminated: get(&self.terminated),
            terminate_failed: get(&self.terminate_failed),
            guarded: get(&self.guarded),
            snapshots: get(&self.snapshots),
            lost: get(&self.lost),
            cache_hits: get(&self.cache_hits),
            identity_reads: get(&self.identity_reads),
            hash_reads: get(&self.hash_reads),
        }
    }
}

/// `program.blocked` (plan 4.12): the name to show, product name or file name, at most 100
/// characters.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlockedProgram {
    pub display_name: String,
}

pub type BlockedHook = Arc<dyn Fn(BlockedProgram) + Send + Sync>;

/// Everything a watch needs, and what the layer compares to see whether anything changed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Config {
    pub mode: Mode,
    pub staff_sid: String,
    pub allow: AllowList,
    /// The Rulebox install folder and the WebView2 runtime folder.
    pub protected: Vec<String>,
    /// The agent's own process id (never ended).
    pub own_pid: u32,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

struct Core {
    cache: IdentityCache,
    handled: HashSet<(u32, String)>,
    findings: HashMap<String, FindingRecord>,
    finding_order: VecDeque<String>,
    announced: HashSet<String>,
}

/// The decision logic with its state; the thread and the trace around it are [`ProcWatch`]. Tests
/// drive it directly.
pub struct Engine {
    platform: Arc<dyn Platform>,
    matcher: Matcher,
    mode: Mode,
    windows: String,
    protected: Vec<String>,
    pub counters: Counters,
    core: Mutex<Core>,
    trace: Mutex<Option<TraceHandle>>,
    last_losses: AtomicU64,
    overflow: AtomicBool,
    on_blocked: Option<BlockedHook>,
}

impl Engine {
    pub fn new(platform: Arc<dyn Platform>, config: &Config, on_blocked: Option<BlockedHook>) -> Self {
        let core = Core {
            cache: IdentityCache::new(CACHE_CAPACITY),
            handled: HashSet::new(),
            findings: HashMap::new(),
            finding_order: VecDeque::new(),
            announced: HashSet::new(),
        };
        Self {
            platform,
            matcher: Matcher::new(&config.allow, &config.protected, &config.staff_sid, config.own_pid),
            mode: config.mode,
            windows: clean(&config.allow.windows),
            protected: config.protected.clone(),
            counters: Counters::default(),
            core: Mutex::new(core),
            trace: Mutex::new(None),
            last_losses: AtomicU64::new(0),
            overflow: AtomicBool::new(false),
            on_blocked,
        }
    }

    /// One process-start event (the worker calls this). Only the process id is used: the image
    /// and the owner are read from the process, so a layout difference of the event cannot change
    /// a decision.
    pub fn on_event(&self, event: &ProcessStart) {
        self.counters.events.fetch_add(1, Ordering::Relaxed);
        match self.platform.process_info(event.pid) {
            Ok(Some(info)) => self.handle(info),
            Ok(None) => {
                self.counters.gone.fetch_add(1, Ordering::Relaxed);
            }
            Err(error) => tracing::debug!(%error, "procwatch: process not readable"),
        }
    }

    /// Decides every process of the Staff session now (start-up catch-up, the snapshot fallback,
    /// and the catch-up after lost events).
    pub fn snapshot(&self) {
        self.counters.snapshots.fetch_add(1, Ordering::Relaxed);
        let Ok(sessions) = self.platform.sessions() else {
            return;
        };
        let mut live: HashSet<u32> = HashSet::new();
        let mut read_all = true;
        for session in sessions.iter().filter(|s| {
            matches!(s.state, SessionState::Active | SessionState::Connected)
                && s.user_sid.as_deref().is_some_and(|sid| sid.eq_ignore_ascii_case(self.matcher.staff_sid()))
        }) {
            match self.platform.session_processes(session.id) {
                Ok(processes) => {
                    for info in processes {
                        live.insert(info.pid);
                        self.handle(info);
                    }
                }
                Err(_) => read_all = false,
            }
        }
        if read_all {
            lock(&self.core).handled.retain(|(pid, _)| live.contains(pid));
        }
    }

    /// Reads the kernel's loss counters; when more events were lost since the last look, runs one
    /// snapshot to catch the Staff processes that were missed (edge case 45).
    pub fn check_losses(&self) {
        let Some(handle) = *lock(&self.trace) else {
            return;
        };
        let Ok(stats) = self.platform.process_trace_stats(handle) else {
            return;
        };
        let total = stats.events_lost + stats.buffers_lost;
        let before = self.last_losses.swap(total, Ordering::Relaxed);
        if total > before {
            self.counters.lost.fetch_add(total - before, Ordering::Relaxed);
            self.snapshot();
        }
    }

    /// Forgets which programs were announced (a new Staff session starts).
    pub fn new_session(&self) {
        lock(&self.core).announced.clear();
    }

    /// The findings so far, drained (Step 9 collects them).
    pub fn take_findings(&self) -> Vec<FindingRecord> {
        let mut core = lock(&self.core);
        let order = std::mem::take(&mut core.finding_order);
        let mut findings = std::mem::take(&mut core.findings);
        order.iter().filter_map(|fingerprint| findings.remove(fingerprint)).collect()
    }

    fn handle(&self, info: ProcessInfo) {
        let handled_key = (info.pid, key(&info.image.to_string_lossy()));
        let (verdict, finding) = {
            let mut guard = lock(&self.core);
            let core = &mut *guard;
            if core.handled.contains(&handled_key) {
                return;
            }
            if core.handled.len() >= HANDLED_CAPACITY {
                core.handled.clear();
            }
            core.handled.insert(handled_key);
            let mut probe = Probe { platform: self.platform.as_ref(), cache: &mut core.cache, counters: &self.counters };
            let verdict = self.matcher.decide(&info, &mut probe);
            let finding = match verdict {
                Verdict::Denied(reason) => Some(self.finding_for(&info, reason, &mut probe)),
                _ => None,
            };
            (verdict, finding)
        };
        match verdict {
            Verdict::NotStaff => {
                self.counters.not_staff.fetch_add(1, Ordering::Relaxed);
            }
            Verdict::Allowed(_) => {
                self.counters.allowed.fetch_add(1, Ordering::Relaxed);
            }
            Verdict::Denied(_) => {
                self.counters.denied.fetch_add(1, Ordering::Relaxed);
                if let Some(finding) = finding {
                    let product = finding.product.clone();
                    self.record(finding);
                    if self.mode == Mode::Enforce {
                        self.end(&info, product);
                    }
                }
            }
        }
    }

    fn finding_for(&self, info: &ProcessInfo, reason: Denied, lookup: &mut dyn Lookup) -> Finding {
        let image = info.image.to_string_lossy();
        let identity = lookup.identity(&info.image);
        let file_name = file_name_of(&image).to_string();
        let signer = identity.as_ref().and_then(|id| id.signer.as_deref()).map(short_signer);
        let class = folder_class(&image, &self.windows, &self.protected);
        // The hash is only known (and only part of the fingerprint) when a hash rule made the
        // matcher read it; it is in the cache then.
        Finding {
            fingerprint: fingerprint(&file_name, class, signer.as_deref().unwrap_or(""), ""),
            layer: "procWatch",
            file_name,
            folder_class: class,
            signer,
            product: identity.and_then(|id| id.product),
            reason: reason.code(),
        }
    }

    fn record(&self, finding: Finding) {
        let mut core = lock(&self.core);
        if let Some(record) = core.findings.get_mut(&finding.fingerprint) {
            record.count += 1;
            return;
        }
        if core.finding_order.len() >= FINDINGS_CAPACITY {
            if let Some(oldest) = core.finding_order.pop_front() {
                core.findings.remove(&oldest);
            }
        }
        core.finding_order.push_back(finding.fingerprint.clone());
        core.findings.insert(finding.fingerprint.clone(), FindingRecord { finding, count: 1 });
    }

    /// Ends a denied process (`enforce`). The platform checks image and owner again.
    fn end(&self, info: &ProcessInfo, product: Option<String>) {
        match self.platform.terminate_process(info.pid, &info.image, self.matcher.staff_sid()) {
            Ok(()) => {
                self.counters.terminated.fetch_add(1, Ordering::Relaxed);
                self.announce(info, product);
            }
            // Ended already, or no longer this image and owner: nothing to do.
            Err(PlatformError::NotFound) => {
                self.counters.gone.fetch_add(1, Ordering::Relaxed);
            }
            Err(PlatformError::Guard(_)) => {
                self.counters.guarded.fetch_add(1, Ordering::Relaxed);
            }
            Err(error) => {
                self.counters.terminate_failed.fetch_add(1, Ordering::Relaxed);
                tracing::warn!(%error, "procwatch: could not end a program");
            }
        }
    }

    /// `program.blocked`, once per program name until the next session.
    fn announce(&self, info: &ProcessInfo, product: Option<String>) {
        let Some(hook) = &self.on_blocked else {
            return;
        };
        let image = info.image.to_string_lossy();
        let file_name = file_name_of(&image).to_string();
        let first = {
            let mut core = lock(&self.core);
            core.announced.len() < NOTICE_CAPACITY && core.announced.insert(file_name.to_ascii_lowercase())
        };
        if first {
            let name = product.unwrap_or(file_name);
            hook(BlockedProgram { display_name: name.chars().take(DISPLAY_NAME_MAX).collect() });
        }
    }
}

fn short_signer(subject: &str) -> String {
    rulebox_win32::fileid::short_signer(subject)
}

// ---------------------------------------------------------------- the running watch

enum Msg {
    Start(ProcessStart),
    Catchup,
    Stop,
}

/// Where the events come from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    /// The ETW session.
    Trace,
    /// The 2-second snapshot diff (edge case 44).
    Snapshot,
}

/// Why a watch did not start.
#[derive(Debug, PartialEq, Eq)]
pub enum StartError {
    /// The test-machine guard refused the trace. No fallback: the guard says this PC is not for it.
    Guard,
    /// The worker thread could not start.
    Thread,
}

/// A running watchdog: the trace (or the snapshot poll) and the worker. Stopped on drop.
pub struct ProcWatch {
    engine: Arc<Engine>,
    platform: Arc<dyn Platform>,
    source: Source,
    mode: Mode,
    tx: SyncSender<Msg>,
    stopping: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

impl ProcWatch {
    /// Starts the trace (or the snapshot fallback) and the worker, and queues one catch-up so
    /// programs already running are checked too.
    pub fn start(platform: Arc<dyn Platform>, config: &Config, on_blocked: Option<BlockedHook>) -> Result<Self, StartError> {
        let engine = Arc::new(Engine::new(Arc::clone(&platform), config, on_blocked));
        let (tx, rx) = mpsc::sync_channel::<Msg>(QUEUE_CAPACITY);
        let sink = Self::sink(&engine, tx.clone());
        let source = match platform.start_process_trace(sink) {
            Ok(handle) => {
                *lock(&engine.trace) = Some(handle);
                Source::Trace
            }
            Err(PlatformError::Guard(_)) => return Err(StartError::Guard),
            Err(error) => {
                tracing::warn!(%error, "procwatch: the process trace did not start; using snapshots");
                Source::Snapshot
            }
        };
        let stopping = Arc::new(AtomicBool::new(false));
        let worker = {
            let (engine, stopping) = (Arc::clone(&engine), Arc::clone(&stopping));
            std::thread::Builder::new()
                .name("rulebox-procwatch".into())
                .stack_size(512 * 1024)
                .spawn(move || run(&engine, &rx, source, &stopping))
        };
        let Ok(worker) = worker else {
            Self::stop_trace(&platform, &engine);
            return Err(StartError::Thread);
        };
        let _ = tx.try_send(Msg::Catchup);
        Ok(Self { engine, platform, source, mode: config.mode, tx, stopping, worker: Some(worker) })
    }

    fn sink(engine: &Arc<Engine>, tx: SyncSender<Msg>) -> ProcessSink {
        let engine = Arc::clone(engine);
        Box::new(move |event| {
            // Session 0 holds services, never the Staff account: no queue slot for it.
            if event.session_id == 0 {
                engine.counters.session_zero.fetch_add(1, Ordering::Relaxed);
                return;
            }
            match tx.try_send(Msg::Start(event)) {
                Ok(()) | Err(TrySendError::Disconnected(_)) => {}
                Err(TrySendError::Full(_)) => {
                    engine.counters.dropped.fetch_add(1, Ordering::Relaxed);
                    engine.overflow.store(true, Ordering::Relaxed);
                }
            }
        })
    }

    fn stop_trace(platform: &Arc<dyn Platform>, engine: &Engine) {
        if let Some(handle) = lock(&engine.trace).take() {
            let _ = platform.stop_process_trace(handle);
        }
    }

    pub fn engine(&self) -> &Engine {
        &self.engine
    }

    pub fn source(&self) -> Source {
        self.source
    }

    pub fn mode(&self) -> Mode {
        self.mode
    }

    pub fn new_session(&self) {
        self.engine.new_session();
    }

    /// The layer's state: `ok` with the trace, `partial` / `snapshot_fallback` without it.
    pub fn layer_state(&self) -> LayerState {
        match self.source {
            Source::Trace => LayerState { mode: self.mode.reported(), state: LayerStatus::Ok, detail: None },
            Source::Snapshot => LayerState {
                mode: self.mode.reported(),
                state: LayerStatus::Partial,
                detail: Some("snapshot_fallback".into()),
            },
        }
    }

    /// Stops the trace and the worker (no events are decided afterwards).
    pub fn stop(&mut self) {
        self.stopping.store(true, Ordering::Relaxed);
        Self::stop_trace(&self.platform, &self.engine);
        let _ = self.tx.try_send(Msg::Stop);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

impl Drop for ProcWatch {
    fn drop(&mut self) {
        self.stop();
    }
}

/// The worker: blocks on the queue, wakes only for its timer.
fn run(engine: &Engine, rx: &Receiver<Msg>, source: Source, stopping: &AtomicBool) {
    let interval = match source {
        Source::Trace => STATS_INTERVAL,
        Source::Snapshot => POLL_INTERVAL,
    };
    let mut due = Instant::now() + interval;
    loop {
        match rx.recv_timeout(due.saturating_duration_since(Instant::now())) {
            Ok(Msg::Start(event)) => engine.on_event(&event),
            Ok(Msg::Catchup) => engine.snapshot(),
            Ok(Msg::Stop) | Err(RecvTimeoutError::Disconnected) => return,
            Err(RecvTimeoutError::Timeout) => {}
        }
        if stopping.load(Ordering::Relaxed) {
            return;
        }
        if engine.overflow.swap(false, Ordering::Relaxed) {
            engine.snapshot();
        }
        if Instant::now() >= due {
            match source {
                Source::Trace => engine.check_losses(),
                Source::Snapshot => engine.snapshot(),
            }
            due = Instant::now() + interval;
        }
    }
}

// ---------------------------------------------------------------- the layer

/// Holds the running watch between applies (the reconciler of Step 20 owns one). `apply` starts,
/// restarts or stops the watch to match the document and returns the layer's state.
pub struct ProcWatchHost {
    platform: Arc<dyn Platform>,
    current: Mutex<Option<(Config, ProcWatch)>>,
    on_blocked: Option<BlockedHook>,
}

impl ProcWatchHost {
    pub fn new(platform: Arc<dyn Platform>, on_blocked: Option<BlockedHook>) -> Self {
        Self { platform, current: Mutex::new(None), on_blocked }
    }

    /// The running watch's state, if any.
    pub fn running(&self) -> Option<(Mode, Source)> {
        lock(&self.current).as_ref().map(|(_, watch)| (watch.mode(), watch.source()))
    }

    /// Runs `f` on the running watch.
    pub fn with_watch<R>(&self, f: impl FnOnce(&ProcWatch) -> R) -> Option<R> {
        lock(&self.current).as_ref().map(|(_, watch)| f(watch))
    }

    /// Stops the watch (service stop, mode `off`). Nothing to undo: the layer keeps no machine state.
    pub fn stop(&self) {
        if let Some((_, mut watch)) = lock(&self.current).take() {
            watch.stop();
        }
    }

    /// Compiles the allow-list for the watchdog (the AppLocker allow-list with the exceptions that
    /// name `procWatch`) and the config the watch runs on.
    pub fn config_for(&self, ctx: &ApplyCtx<'_>, doc: &AgentDoc) -> Result<Option<Config>, &'static str> {
        let Some(lockdown) = &doc.lockdown else {
            return Ok(None);
        };
        let Some(mode) = Mode::from_layer(lockdown.proc_watch.mode) else {
            return Ok(None);
        };
        let platform = ctx.journal.platform;
        let staff = staff_sid(ctx).ok_or("no_staff_account")?;
        let roots = platform.path_roots().map_err(|_| "path_roots_unreadable")?;
        let windows = clean(roots.system_root.as_deref().unwrap_or(""));
        // A scan that fails leaves only the known writable folders cut out: never a wider list.
        let scan = if windows.is_empty() { Vec::new() } else { platform.folder_acls(Path::new(&windows), SCAN_DEPTH).unwrap_or_default() };
        let protected = protected_folders(ctx, &roots);
        let inputs = Inputs {
            roots: &roots,
            protected: &protected,
            catalogue_folders: &ctx.facts.catalogue_exe_folders,
            exceptions: &lockdown.exceptions,
            accessibility_tools: lockdown.accessibility_tools,
            windows_scan: &scan,
            staff_sid: &staff,
        };
        let acl_of = |folder: &str| platform.get_path_acl(Path::new(folder)).map_err(|_| ());
        let allow = allowlist::build_for(&inputs, ExceptionLayer::ProcWatch, acl_of)?;
        Ok(Some(Config { mode, staff_sid: staff, allow, protected, own_pid: std::process::id() }))
    }

    /// Brings the watch in line with the document. Idempotent: the same document keeps the same
    /// watch (no restart, no new trace).
    pub fn apply(&self, ctx: &ApplyCtx<'_>, doc: &AgentDoc) -> LayerState {
        let mode = doc.lockdown.as_ref().map_or(LayerMode::Off, |l| l.proc_watch.mode);
        if mode == LayerMode::Unknown {
            self.stop();
            return LayerState { mode: ReportedMode::Off, state: LayerStatus::Ok, detail: Some("section_unknown_value".into()) };
        }
        let config = match self.config_for(ctx, doc) {
            Ok(Some(config)) => config,
            Ok(None) => {
                self.stop();
                return LayerState::off_ok();
            }
            Err(code) => {
                self.stop();
                let shown = Mode::from_layer(mode).map_or(ReportedMode::Off, Mode::reported);
                return LayerState { mode: shown, state: LayerStatus::Failed, detail: Some(code.into()) };
            }
        };
        let mut current = lock(&self.current);
        if let Some((running, watch)) = current.as_ref() {
            if *running == config {
                return watch.layer_state();
            }
        }
        if let Some((_, mut old)) = current.take() {
            old.stop();
        }
        match ProcWatch::start(Arc::clone(&self.platform), &config, self.on_blocked.clone()) {
            Ok(watch) => {
                let state = watch.layer_state();
                *current = Some((config, watch));
                state
            }
            Err(StartError::Guard) => {
                LayerState { mode: config.mode.reported(), state: LayerStatus::Failed, detail: Some("blocked_by_guard".into()) }
            }
            Err(StartError::Thread) => {
                LayerState { mode: config.mode.reported(), state: LayerStatus::Failed, detail: Some("watch_thread_failed".into()) }
            }
        }
    }
}

#[cfg(test)]
mod tests;
