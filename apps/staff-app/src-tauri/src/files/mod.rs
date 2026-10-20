//! The files backend (plan Step 12): confinement, quota, trash, search, the
//! `rbfile://` protocol and the previews. React only ever sends paths
//! relative to the employee's folder; nothing here takes an absolute path.

pub mod commands;
pub mod names;
pub mod openwith;
pub mod preview;
pub mod protocol;
pub mod quota;
pub mod saferoot;
pub mod types;

use std::collections::{BTreeMap, VecDeque};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock, Weak};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use ts_rs::TS;

use self::quota::{Quota, Watch};
use self::saferoot::{now_ms, Entry, EntryKind, FileError, RelPath, SafeRoot, TrashItem};

/// Sends an event to the shell and built-in app windows.
pub type Emit = Arc<dyn Fn(&str, Value) + Send + Sync>;

const TRASH_MAX_AGE_MS: u64 = 30 * 24 * 60 * 60 * 1000;
const RECENT_MAX: usize = 12;
const SEARCH_CAP: usize = 500;
const SEARCH_BATCH: usize = 40;

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Usage {
    #[ts(type = "number")]
    pub used: u64,
    /// 0 means no limit.
    #[ts(type = "number")]
    pub limit: u64,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ClipOp {
    Copy,
    Cut,
}

/// The file clipboard: relative paths and copy / cut, kept here and nowhere
/// else. The Windows clipboard is never read or written for files, so
/// nothing from outside the employee's folder can be pasted in.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Clip {
    pub op: ClipOp,
    pub paths: Vec<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PasteFailure {
    pub path: String,
    pub error: FileError,
}

/// What a paste did, item by item: one failure does not stop the rest.
#[derive(Serialize, Clone, Debug, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PasteResult {
    pub pasted: Vec<String>,
    pub failed: Vec<PasteFailure>,
}

/// Events go to `shell-*` and `app-*` windows only, never to a web app's page.
pub fn ui_emitter(app: AppHandle) -> Emit {
    Arc::new(move |event, payload| {
        for window in app.webview_windows().values() {
            let label = window.label();
            if label.starts_with("shell-") || label.starts_with("app-") {
                let _ = window.emit(event, payload.clone());
            }
        }
    })
}

/// One signed-in employee's files.
pub struct FileSession {
    root: SafeRoot,
    quota: Quota,
    emit: Emit,
    recent: Mutex<VecDeque<String>>,
    clipboard: Mutex<Option<Clip>>,
    search_gen: AtomicU64,
    scan_busy: AtomicBool,
    scan_dirty: AtomicBool,
    watch: Mutex<Option<Watch>>,
}

impl FileSession {
    pub fn open(root: &Path, quota_bytes: u64, emit: Emit) -> Result<Arc<FileSession>, FileError> {
        let root = SafeRoot::open(root)?;
        let freed = root.purge_expired(now_ms(), TRASH_MAX_AGE_MS);
        if freed > 0 {
            tracing::info!(freed, "old trash purged");
        }
        let session = Arc::new(FileSession {
            root,
            quota: Quota::new(quota_bytes),
            emit,
            recent: Mutex::new(VecDeque::new()),
            clipboard: Mutex::new(None),
            search_gen: AtomicU64::new(0),
            scan_busy: AtomicBool::new(false),
            scan_dirty: AtomicBool::new(false),
            watch: Mutex::new(None),
        });
        session.request_scan();
        let weak: Weak<FileSession> = Arc::downgrade(&session);
        let started = Watch::start(session.root.root_path().to_path_buf(), move |dirs, rescan| {
            let Some(session) = weak.upgrade() else { return };
            if rescan {
                session.emit_changed("");
            }
            for dir in &dirs {
                session.emit_changed(dir);
            }
            session.request_scan();
        });
        match started {
            Ok(watch) => {
                if let Ok(mut slot) = session.watch.lock() {
                    *slot = Some(watch);
                }
            }
            Err(error) => tracing::warn!(%error, "folder watcher did not start; lists refresh on use"),
        }
        Ok(session)
    }

    pub fn root(&self) -> &SafeRoot {
        &self.root
    }

    pub fn usage(&self) -> Usage {
        Usage {
            used: self.quota.used(),
            limit: self.quota.limit(),
        }
    }

    fn emit_changed(&self, dir: &str) {
        (self.emit)("files://changed", json!({ "dir": dir }));
    }

    fn emit_usage(&self) {
        (self.emit)("files://usage", json!(self.usage()));
    }

    /// Re-walk the folder on a worker. Requests that arrive while a walk is
    /// running are folded into one more walk.
    pub fn request_scan(self: &Arc<Self>) {
        self.scan_dirty.store(true, Ordering::SeqCst);
        if self.scan_busy.swap(true, Ordering::SeqCst) {
            return;
        }
        let session = Arc::clone(self);
        std::thread::spawn(move || loop {
            while session.scan_dirty.swap(false, Ordering::SeqCst) {
                session.quota.set_used(session.root.used_bytes());
                session.emit_usage();
            }
            session.scan_busy.store(false, Ordering::SeqCst);
            if !session.scan_dirty.load(Ordering::SeqCst)
                || session.scan_busy.swap(true, Ordering::SeqCst)
            {
                break;
            }
        });
    }

    /// Whether the folder is at 100% (adding bytes is refused).
    pub fn quota_full(&self) -> bool {
        self.quota.is_full()
    }

    /// Over the limit, not merely full. For a download that already landed.
    pub fn over_quota(&self) -> bool {
        let limit = self.quota.limit();
        limit > 0 && self.quota.used() > limit
    }

    /// Count the folder again now (on this thread). A finished download calls this.
    pub fn refresh_usage(&self) {
        self.quota.set_used(self.root.used_bytes());
        self.emit_usage();
    }

    /// Delete one file for good and say the folder changed.
    pub fn delete_now(&self, path: &RelPath) -> Result<(), FileError> {
        self.root.remove_file_now(path)?;
        self.refresh_usage();
        self.emit_changed(&path.parent().as_string());
        Ok(())
    }

    // ---- Operations that change the folder ---------------------------

    pub fn mkdir(&self, path: &RelPath) -> Result<(), FileError> {
        self.root.mkdir(path)?;
        self.emit_changed(&path.parent().as_string());
        Ok(())
    }

    pub fn rename(&self, from: &RelPath, to: &RelPath) -> Result<(), FileError> {
        self.root.rename(from, to)?;
        self.emit_changed(&from.parent().as_string());
        self.emit_changed(&to.parent().as_string());
        Ok(())
    }

    pub fn copy(&self, from: &RelPath, to_dir: &RelPath) -> Result<RelPath, FileError> {
        let size = self.root.tree_size(from)?;
        self.quota.check_add(size)?;
        let created = self.root.copy(from, to_dir)?;
        self.quota.add(size);
        self.emit_changed(&to_dir.as_string());
        self.emit_usage();
        Ok(created)
    }

    pub fn move_to(&self, from: &RelPath, to_dir: &RelPath) -> Result<RelPath, FileError> {
        let moved = self.root.move_to(from, to_dir)?;
        self.emit_changed(&from.parent().as_string());
        self.emit_changed(&to_dir.as_string());
        Ok(moved)
    }

    /// To the trash, or gone for good when `permanent`.
    pub fn delete(self: &Arc<Self>, path: &RelPath, permanent: bool) -> Result<(), FileError> {
        let item = self.root.trash(path)?;
        if permanent {
            self.root.purge(Some(&item.id))?;
            self.request_scan();
        }
        self.emit_changed(&path.parent().as_string());
        Ok(())
    }

    pub fn restore(&self, id: &str) -> Result<RelPath, FileError> {
        if self.quota.is_full() {
            self.quota.check_add(0)?;
        }
        let restored = self.root.restore(id)?;
        self.emit_changed(&restored.parent().as_string());
        Ok(restored)
    }

    pub fn purge(self: &Arc<Self>, id: Option<&str>) -> Result<(), FileError> {
        self.root.purge(id)?;
        self.request_scan();
        Ok(())
    }

    pub fn trash_list(&self) -> Vec<TrashItem> {
        self.root.trash_list()
    }

    // ---- Clipboard ----------------------------------------------------

    pub fn clip(&self) -> Option<Clip> {
        self.clipboard.lock().ok().and_then(|clip| clip.clone())
    }

    fn store_clip(&self, clip: Option<Clip>) {
        if let Ok(mut slot) = self.clipboard.lock() {
            *slot = clip.clone();
        }
        (self.emit)("files://clipboard", json!(clip));
    }

    /// Every path is checked now, so a bad one never reaches a paste.
    pub fn set_clip(&self, op: ClipOp, paths: Vec<String>) -> Result<(), FileError> {
        if paths.is_empty() {
            self.store_clip(None);
            return Ok(());
        }
        for path in &paths {
            let rel = RelPath::parse(path)?;
            if rel.is_root() {
                return Err(FileError::OutsideRoot);
            }
        }
        self.store_clip(Some(Clip { op, paths }));
        Ok(())
    }

    /// Paste into `to_dir`. Copy keeps the clipboard; cut empties it of what moved.
    pub fn paste(&self, to_dir: &RelPath) -> Result<PasteResult, FileError> {
        let clip = self.clip().ok_or(FileError::NotFound)?;
        let mut result = PasteResult {
            pasted: Vec::new(),
            failed: Vec::new(),
        };
        let mut left = Vec::new();
        for path in &clip.paths {
            let step = RelPath::parse(path).and_then(|from| match clip.op {
                ClipOp::Copy => self.copy(&from, to_dir),
                ClipOp::Cut => self.move_to(&from, to_dir),
            });
            match step {
                Ok(created) => result.pasted.push(created.as_string()),
                Err(error) => {
                    left.push(path.clone());
                    result.failed.push(PasteFailure {
                        path: path.clone(),
                        error,
                    });
                }
            }
        }
        if clip.op == ClipOp::Cut {
            let rest = (!left.is_empty()).then_some(Clip {
                op: ClipOp::Cut,
                paths: left,
            });
            self.store_clip(rest);
        }
        Ok(result)
    }

    // ---- Recent and search -------------------------------------------

    pub fn remember(&self, path: &RelPath) {
        let text = path.as_string();
        if let Ok(mut recent) = self.recent.lock() {
            recent.retain(|p| *p != text);
            recent.push_front(text);
            recent.truncate(RECENT_MAX);
        }
    }

    /// Files opened in this sign-in, newest first; gone files are left out.
    pub fn recent(&self) -> Vec<Entry> {
        let paths: Vec<String> = self
            .recent
            .lock()
            .map(|recent| recent.iter().cloned().collect())
            .unwrap_or_default();
        paths
            .iter()
            .filter_map(|p| RelPath::parse(p).ok())
            .filter_map(|p| self.root.stat(&p).ok())
            .filter(|entry| entry.kind == EntryKind::File)
            .collect()
    }

    /// Starts a search on a worker and streams `files://search` batches to
    /// `send`. A newer search, or an empty query, cancels this one.
    pub fn start_search(self: &Arc<Self>, search_id: u64, query: String, send: Emit) {
        let generation = self.search_gen.fetch_add(1, Ordering::SeqCst) + 1;
        if query.trim().is_empty() {
            return;
        }
        let session = Arc::clone(self);
        std::thread::spawn(move || {
            let cancelled = || session.search_gen.load(Ordering::SeqCst) != generation;
            let mut batch: Vec<Entry> = Vec::new();
            let flush = |batch: &mut Vec<Entry>, done: bool| {
                send(
                    "files://search",
                    json!({ "searchId": search_id, "hits": batch, "done": done }),
                );
                batch.clear();
            };
            session
                .root
                .search(&query, SEARCH_CAP, &cancelled, &mut |entry| {
                    batch.push(entry);
                    if batch.len() >= SEARCH_BATCH {
                        flush(&mut batch, false);
                    }
                });
            if !cancelled() {
                flush(&mut batch, true);
            }
        });
    }
}

/// Holds the signed-in employee's file session (or none) and the app
/// handlers from policy. Shared with the `rbfile://` protocol.
#[derive(Default)]
pub struct FilesHub {
    session: RwLock<Option<Arc<FileSession>>>,
    handlers: RwLock<BTreeMap<String, String>>,
}

impl FilesHub {
    pub fn sign_in(&self, root: &Path, quota_bytes: u64, emit: Emit) -> Result<(), FileError> {
        let session = FileSession::open(root, quota_bytes, emit)?;
        if let Ok(mut slot) = self.session.write() {
            *slot = Some(session);
        }
        Ok(())
    }

    /// Drops the folder handle, the watcher and the recent list.
    pub fn sign_out(&self) {
        if let Ok(mut slot) = self.session.write() {
            slot.take();
        }
    }

    pub fn session(&self) -> Option<Arc<FileSession>> {
        self.session.read().ok().and_then(|slot| slot.clone())
    }

    /// `fileHandlers` from the desired state: `".ext"` to an app id.
    pub fn set_handlers(&self, handlers: BTreeMap<String, String>) {
        if let Ok(mut slot) = self.handlers.write() {
            *slot = handlers;
        }
    }

    pub fn handlers(&self) -> BTreeMap<String, String> {
        self.handlers.read().map(|h| h.clone()).unwrap_or_default()
    }
}
