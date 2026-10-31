//! Storage quota: a cached total plus the folder watcher that keeps it (and
//! the file lists on screen) up to date (plan Step 12).
//!
//! At 100% the backend blocks anything that adds bytes (copy, restore,
//! new files, downloads). Delete, empty trash, move, rename and open are
//! always allowed, so a full folder can always be cleaned up.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use notify_debouncer_full::notify::{Config, RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{new_debouncer_opt, DebounceEventResult, NoCache};

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
        // `NoCache` on purpose. The default cache (`FileIdMap`) walks the whole tree
        // with `follow_links(true)` when the watch starts, and again for every new
        // folder: one junction or symlink in the employee's folder (a program made
        // one, or the employee did) sent it through `C:\Windows` and sign-in took
        // 60 to 160 s. Only the changed path is used here, never the file id, so
        // the cache buys nothing. Renames just arrive as two paths.
        let mut debouncer = new_debouncer_opt::<_, RecommendedWatcher, WatchCache>(
            WATCH_DEBOUNCE,
            None,
            move |result: DebounceEventResult| {
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
            },
            WatchCache::new(),
            Config::default(),
        )
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

/// Which file-id cache the folder watcher uses. Keep it `NoCache`: see `Watch::start`.
type WatchCache = NoCache;

#[cfg(test)]
mod watch_tests {
    #![allow(clippy::expect_used, clippy::unwrap_used)]
    use super::*;
    use std::sync::mpsc;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("rulebox-watch-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch folder");
        dir
    }

    #[test]
    fn the_watcher_never_builds_a_file_id_cache() {
        // `FileIdMap` walks the tree following links; a junction in the employee's
        // folder made sign-in take minutes (found on the VM, 2026-10-31).
        assert!(std::any::type_name::<WatchCache>().ends_with("NoCache"));
    }

    #[test]
    fn it_reports_changes_in_folders_and_ignores_a_junction_target() {
        let root = scratch("root");
        let outside = scratch("outside");
        std::fs::create_dir_all(root.join("sub")).unwrap();
        // A junction needs no privilege (`mklink /J`); skip the link part if cmd refuses.
        let linked = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(root.join("link"))
            .arg(&outside)
            .output()
            .map(|out| out.status.success())
            .unwrap_or(false);

        let (tx, rx) = mpsc::channel();
        let started = std::time::Instant::now();
        let _watch = Watch::start(root.clone(), move |dirs, _| {
            let _ = tx.send(dirs);
        })
        .expect("watcher starts");
        assert!(started.elapsed() < Duration::from_secs(5), "start must not walk anything");

        std::fs::write(root.join("sub").join("new.txt"), b"x").unwrap();
        let mut seen = Vec::new();
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while std::time::Instant::now() < deadline && !seen.iter().any(|dir: &String| dir == "sub") {
            if let Ok(dirs) = rx.recv_timeout(Duration::from_millis(200)) {
                seen.extend(dirs);
            }
        }
        assert!(seen.iter().any(|dir| dir == "sub"), "no change reported: {seen:?}");

        if linked {
            // A change outside the watched root (behind the link) is not this folder's.
            std::fs::write(outside.join("elsewhere.txt"), b"x").unwrap();
            std::thread::sleep(Duration::from_millis(1200));
            let mut after = Vec::new();
            while let Ok(dirs) = rx.try_recv() {
                after.extend(dirs);
            }
            assert!(after.is_empty(), "a change behind the junction was reported: {after:?}");
        }
        drop(_watch);
        let _ = std::process::Command::new("cmd").args(["/C", "rmdir"]).arg(root.join("link")).output();
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }
}
