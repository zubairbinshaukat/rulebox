//! Storage quota: a cached total plus the folder watcher that keeps it (and
//! the file lists on screen) up to date (plan Step 12).
//!
//! At 100% the backend blocks anything that adds bytes (copy, restore,
//! new files, downloads). Delete, empty trash, move, rename and open are
//! always allowed, so a full folder can always be cleaned up.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use notify_debouncer_full::notify::RecursiveMode;
use notify_debouncer_full::{new_debouncer, DebounceEventResult};

use super::names;
use super::saferoot::FileError;

/// How long the watcher waits for a burst of changes to settle.
pub const WATCH_DEBOUNCE: Duration = Duration::from_millis(400);

#[derive(Debug)]
pub struct Quota {
    /// 0 means "no limit": a missing quota must not lock an employee out.
    limit: AtomicU64,
    used: AtomicU64,
}

impl Quota {
    pub fn new(limit: u64) -> Quota {
        Quota {
            limit: AtomicU64::new(limit),
            used: AtomicU64::new(0),
        }
    }

    pub fn limit(&self) -> u64 {
        self.limit.load(Ordering::Relaxed)
    }

    pub fn used(&self) -> u64 {
        self.used.load(Ordering::Relaxed)
    }

    pub fn set_used(&self, bytes: u64) {
        self.used.store(bytes, Ordering::Relaxed);
    }

    pub fn add(&self, bytes: u64) {
        self.used.fetch_add(bytes, Ordering::Relaxed);
    }

    pub fn is_full(&self) -> bool {
        let limit = self.limit();
        limit > 0 && self.used() >= limit
    }

    /// Whether `bytes` more may be stored. The error says how far over it would be.
    pub fn check_add(&self, bytes: u64) -> Result<(), FileError> {
        let limit = self.limit();
        if limit == 0 {
            return Ok(());
        }
        let needed = self.used().saturating_add(bytes);
        if needed > limit || self.used() >= limit {
            return Err(FileError::QuotaExceeded {
                short_by: needed.saturating_sub(limit).max(1),
            });
        }
        Ok(())
    }
}

/// The folder (relative, `/` separators, `""` = root) a changed path is in.
/// `None` for the trash and anything outside the root.
pub fn changed_dir(root: &Path, changed: &Path) -> Option<String> {
    let relative = changed.strip_prefix(root).ok()?;
    let mut parts: Vec<String> = relative
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect();
    if parts.first().is_some_and(|first| names::is_internal(first)) {
        return None;
    }
    // The folder that holds the changed item.
    parts.pop();
    Some(parts.join("/"))
}

/// Keeps watching until dropped. `on_change(dirs, rescan)` is called with the
/// folders that changed (deduplicated) and whether the OS lost events.
pub struct Watch {
    _debouncer: Box<dyn std::any::Any + Send>,
}

impl Watch {
    pub fn start(
        root: PathBuf,
        on_change: impl Fn(Vec<String>, bool) + Send + 'static,
    ) -> Result<Watch, FileError> {
        let watch_root = root.clone();
        let mut debouncer = new_debouncer(WATCH_DEBOUNCE, None, move |result: DebounceEventResult| {
            let Ok(events) = result else {
                on_change(Vec::new(), true);
                return;
            };
            let mut dirs: Vec<String> = Vec::new();
            let mut rescan = false;
            for event in &events {
                rescan |= event.event.need_rescan();
                for path in &event.event.paths {
                    if let Some(dir) = changed_dir(&watch_root, path) {
                        if !dirs.contains(&dir) {
                            dirs.push(dir);
                        }
                    }
                }
            }
            if rescan || !dirs.is_empty() {
                on_change(dirs, rescan);
            }
        })
        .map_err(|error| FileError::Io {
            message: error.to_string(),
        })?;
        debouncer
            .watch(&root, RecursiveMode::Recursive)
            .map_err(|error| FileError::Io {
                message: error.to_string(),
            })?;
        Ok(Watch {
            _debouncer: Box::new(debouncer),
        })
    }
}
