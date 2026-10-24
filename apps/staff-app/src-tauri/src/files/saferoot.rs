//! The only way to touch an employee's files (plan Step 12).
//!
//! Every call starts from one `cap_std` directory handle opened at sign-in
//! and walks the path one component at a time. A symlink or junction anywhere
//! on the way is refused: a standard Windows user can make junctions without
//! any privilege, so "inside the folder" must be checked per component, on
//! the handle, not on a string.

use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use cap_std::ambient_authority;
use cap_std::fs::{Dir, Metadata, OpenOptions};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::names::{self, NameRule};

/// Folders deeper than this are not walked (and cannot exist on NTFS paths anyway).
const MAX_DEPTH: usize = 64;
const TRASH_DIR: &str = ".rulebox-trash";
const TRASH_INDEX: &str = "index.json";
/// Where a new index is written before it replaces the real one.
const TRASH_INDEX_TMP: &str = "index.json.tmp";

#[derive(Serialize, Clone, Debug, PartialEq, Eq, thiserror::Error, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export)]
pub enum FileError {
    #[error("that name is not allowed")]
    InvalidName { rule: NameRule },
    #[error("not found")]
    NotFound,
    #[error("something with that name already exists")]
    Exists,
    #[error("links are not followed")]
    IsReparsePoint,
    #[error("outside the employee's folder")]
    OutsideRoot,
    #[error("storage is full")]
    #[serde(rename_all = "camelCase")]
    QuotaExceeded {
        #[ts(type = "number")]
        short_by: u64,
    },
    #[error("this type of file can't be opened")]
    BlockedType,
    #[error("too large")]
    TooLarge,
    #[error("the file is damaged")]
    Damaged,
    #[error("a folder can't go inside itself")]
    IntoItself,
    #[error("not signed in")]
    NotSignedIn,
    #[error("{message}")]
    Io { message: String },
}

impl From<io::Error> for FileError {
    fn from(error: io::Error) -> Self {
        match error.kind() {
            io::ErrorKind::NotFound => FileError::NotFound,
            io::ErrorKind::AlreadyExists => FileError::Exists,
            _ if error.to_string().contains("outside of the filesystem") => FileError::OutsideRoot,
            _ => FileError::Io {
                message: error.to_string(),
            },
        }
    }
}

type Result<T> = std::result::Result<T, FileError>;

/// A path inside the employee's folder: validated components, no `..`, no
/// drive, no stream. Only constructible through `parse` / `join`.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Default)]
pub struct RelPath(Vec<String>);

impl RelPath {
    pub fn root() -> RelPath {
        RelPath(Vec::new())
    }

    /// `""` is the root. Components are separated by `/` only.
    pub fn parse(text: &str) -> Result<RelPath> {
        if text.is_empty() {
            return Ok(RelPath::root());
        }
        let mut parts = Vec::new();
        for part in text.split('/') {
            names::check_component(part).map_err(|rule| FileError::InvalidName { rule })?;
            parts.push(part.to_string());
        }
        Ok(RelPath(parts))
    }

    pub fn join(&self, name: &str) -> Result<RelPath> {
        names::check_component(name).map_err(|rule| FileError::InvalidName { rule })?;
        let mut parts = self.0.clone();
        parts.push(name.to_string());
        Ok(RelPath(parts))
    }

    pub fn is_root(&self) -> bool {
        self.0.is_empty()
    }

    pub fn leaf(&self) -> Option<&str> {
        self.0.last().map(String::as_str)
    }

    pub fn parent(&self) -> RelPath {
        let mut parts = self.0.clone();
        parts.pop();
        RelPath(parts)
    }

    pub fn components(&self) -> impl Iterator<Item = &str> {
        self.0.iter().map(String::as_str)
    }

    /// True when `self` is `other` or inside it. Case does not matter: NTFS
    /// treats `Docs` and `docs` as one folder, and "a folder into itself" has
    /// to be caught under either spelling.
    pub fn starts_with(&self, other: &RelPath) -> bool {
        self.0.len() >= other.0.len()
            && self.0.iter().zip(&other.0).all(|(a, b)| a == b || a.to_lowercase() == b.to_lowercase())
    }

    pub fn as_string(&self) -> String {
        self.0.join("/")
    }
}

impl std::fmt::Display for RelPath {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.as_string())
    }
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum EntryKind {
    File,
    Folder,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Entry {
    pub name: String,
    /// Relative to the employee's folder, `/` separators.
    pub path: String,
    pub kind: EntryKind,
    #[ts(type = "number")]
    pub size: u64,
    /// Milliseconds since 1970; 0 when unknown.
    #[ts(type = "number")]
    pub modified_ms: u64,
}

/// One thing in the trash.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TrashItem {
    pub id: String,
    /// Where it was, relative to the employee's folder.
    pub original: String,
    pub name: String,
    pub is_folder: bool,
    #[ts(type = "number")]
    pub size: u64,
    #[ts(type = "number")]
    pub deleted_ms: u64,
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

fn modified_ms(meta: &Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.into_std().duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as u64)
}

/// Only name-surrogate reparse points (symlinks, junctions) count: Rust
/// reports exactly those as symlinks. Cloud placeholders stay ordinary files.
fn is_link(meta: &Metadata) -> bool {
    meta.file_type().is_symlink()
}

fn entry_of(parent: &RelPath, name: &str, meta: &Metadata) -> Entry {
    Entry {
        name: name.to_string(),
        path: if parent.is_root() {
            name.to_string()
        } else {
            format!("{parent}/{name}")
        },
        kind: if meta.is_dir() {
            EntryKind::Folder
        } else {
            EntryKind::File
        },
        size: if meta.is_dir() { 0 } else { meta.len() },
        modified_ms: modified_ms(meta),
    }
}

/// `a (1).txt`, `a (2).txt`... the first name that is free in `dir`.
fn unique_name(dir: &Dir, name: &str, is_dir: bool) -> Result<String> {
    if dir.symlink_metadata(name).is_err() {
        return Ok(name.to_string());
    }
    for n in 1..10_000 {
        let candidate = names::numbered(name, n, is_dir);
        names::check_component(&candidate).map_err(|rule| FileError::InvalidName { rule })?;
        if dir.symlink_metadata(&candidate).is_err() {
            return Ok(candidate);
        }
    }
    Err(FileError::Exists)
}

/// Create an empty file named `name` (or the first free `name (n)`) and return
/// the name it got. Never overwrites and never follows a link.
fn reserve_name(dir: &Dir, name: &str) -> Result<String> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    for n in 0..10_000 {
        let candidate = if n == 0 {
            name.to_string()
        } else {
            names::numbered(name, n, false)
        };
        names::check_component(&candidate).map_err(|rule| FileError::InvalidName { rule })?;
        match dir.open_with(&candidate, &options) {
            Ok(_claimed) => return Ok(candidate),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.into()),
        }
    }
    Err(FileError::Exists)
}

pub struct SafeRoot {
    dir: Dir,
    /// Canonical, without the `\\?\` prefix.
    root: PathBuf,
    /// Serialises the trash operations (see `trash_guard`).
    trash_lock: Mutex<()>,
}

impl SafeRoot {
    /// `root` comes from the agent. The folder is created when it is missing.
    pub fn open(root: &Path) -> Result<SafeRoot> {
        std::fs::create_dir_all(root)?;
        let dir = Dir::open_ambient_dir(root, ambient_authority())?;
        let canonical = dunce::canonicalize(root)?;
        Ok(SafeRoot {
            dir,
            root: canonical,
            trash_lock: Mutex::new(()),
        })
    }

    pub fn root_path(&self) -> &Path {
        &self.root
    }

    /// Walk to a folder, refusing links on the way.
    fn open_dir_at(&self, rel: &RelPath) -> Result<Dir> {
        let mut current = self.dir.try_clone()?;
        for part in rel.components() {
            let meta = current.symlink_metadata(part)?;
            if is_link(&meta) {
                return Err(FileError::IsReparsePoint);
            }
            if !meta.is_dir() {
                return Err(FileError::NotFound);
            }
            let next = current.open_dir(part)?;
            // The handle itself, in case the name was swapped after the check.
            if is_link(&next.dir_metadata()?) {
                return Err(FileError::IsReparsePoint);
            }
            current = next;
        }
        Ok(current)
    }

    fn parent_and_leaf<'a>(&self, rel: &'a RelPath) -> Result<(Dir, &'a str)> {
        let leaf = rel.leaf().ok_or(FileError::NotFound)?;
        Ok((self.open_dir_at(&rel.parent())?, leaf))
    }

    pub fn list(&self, dir: &RelPath) -> Result<Vec<Entry>> {
        let handle = self.open_dir_at(dir)?;
        let mut out = Vec::new();
        for item in handle.entries()? {
            let Ok(item) = item else { continue };
            let Ok(name) = item.file_name().into_string() else {
                continue;
            };
            if names::is_internal(&name) || names::check_component(&name).is_err() {
                continue;
            }
            let Ok(meta) = item.metadata() else { continue };
            if is_link(&meta) || !(meta.is_dir() || meta.is_file()) {
                continue;
            }
            out.push(entry_of(dir, &name, &meta));
        }
        out.sort_by(|a, b| {
            (a.kind == EntryKind::File, a.name.to_lowercase())
                .cmp(&(b.kind == EntryKind::File, b.name.to_lowercase()))
        });
        Ok(out)
    }

    pub fn stat(&self, path: &RelPath) -> Result<Entry> {
        if path.is_root() {
            return Ok(Entry {
                name: String::new(),
                path: String::new(),
                kind: EntryKind::Folder,
                size: 0,
                modified_ms: 0,
            });
        }
        let (parent, leaf) = self.parent_and_leaf(path)?;
        let meta = parent.symlink_metadata(leaf)?;
        if is_link(&meta) {
            return Err(FileError::IsReparsePoint);
        }
        Ok(entry_of(&path.parent(), leaf, &meta))
    }

    /// Open a file for reading. Never follows a link.
    pub fn open_read(&self, path: &RelPath) -> Result<std::fs::File> {
        let (parent, leaf) = self.parent_and_leaf(path)?;
        let meta = parent.symlink_metadata(leaf)?;
        if is_link(&meta) {
            return Err(FileError::IsReparsePoint);
        }
        if !meta.is_file() {
            return Err(FileError::Io {
                message: "that is a folder".into(),
            });
        }
        let file = parent.open(leaf)?;
        if is_link(&file.metadata()?) {
            return Err(FileError::IsReparsePoint);
        }
        Ok(file.into_std())
    }

    pub fn mkdir(&self, path: &RelPath) -> Result<()> {
        let (parent, leaf) = self.parent_and_leaf(path)?;
        parent.create_dir(leaf)?;
        Ok(())
    }

    /// Never overwrites. A change of letter case alone is allowed.
    pub fn rename(&self, from: &RelPath, to: &RelPath) -> Result<()> {
        if from.is_root() || to.is_root() {
            return Err(FileError::OutsideRoot);
        }
        // Strictly inside: `a.txt` -> `A.TXT` (same entry, other case) is a plain rename.
        if to.0.len() > from.0.len() && to.starts_with(from) {
            return Err(FileError::IntoItself);
        }
        let (from_parent, from_leaf) = self.parent_and_leaf(from)?;
        let meta = from_parent.symlink_metadata(from_leaf)?;
        if is_link(&meta) {
            return Err(FileError::IsReparsePoint);
        }
        let (to_parent, to_leaf) = self.parent_and_leaf(to)?;
        let case_only = from.parent() == to.parent()
            && from_leaf != to_leaf
            && from_leaf.to_lowercase() == to_leaf.to_lowercase();
        if !case_only && to_parent.symlink_metadata(to_leaf).is_ok() {
            return Err(FileError::Exists);
        }
        from_parent.rename(from_leaf, &to_parent, to_leaf)?;
        Ok(())
    }

    /// Copy a file or folder into `to_dir`. A taken name becomes `name (1)`.
    pub fn copy(&self, from: &RelPath, to_dir: &RelPath) -> Result<RelPath> {
        let source = self.stat(from)?;
        if from.is_root() || (source.kind == EntryKind::Folder && to_dir.starts_with(from)) {
            return Err(FileError::IntoItself);
        }
        let (from_parent, from_leaf) = self.parent_and_leaf(from)?;
        let target = self.open_dir_at(to_dir)?;
        let is_dir = source.kind == EntryKind::Folder;
        let name = unique_name(&target, from_leaf, is_dir)?;
        let result = if is_dir {
            let source_dir = self.open_dir_at(from)?;
            target
                .create_dir(&name)
                .map_err(FileError::from)
                .and_then(|()| copy_tree(&source_dir, &target, &name, 0))
        } else {
            copy_file(&from_parent, from_leaf, &target, &name)
        };
        if let Err(error) = result {
            // Nothing half-done is left behind.
            let _ = if is_dir {
                target.remove_dir_all(&name)
            } else {
                target.remove_file(&name)
            };
            return Err(error);
        }
        to_dir.join(&name)
    }

    /// Move into `to_dir` with the same de-duplication as `copy`.
    pub fn move_to(&self, from: &RelPath, to_dir: &RelPath) -> Result<RelPath> {
        let source = self.stat(from)?;
        if from.is_root() || (source.kind == EntryKind::Folder && to_dir.starts_with(from)) {
            return Err(FileError::IntoItself);
        }
        if from.parent() == *to_dir {
            return Ok(from.clone());
        }
        let (from_parent, from_leaf) = self.parent_and_leaf(from)?;
        let target = self.open_dir_at(to_dir)?;
        let name = unique_name(&target, from_leaf, source.kind == EntryKind::Folder)?;
        from_parent.rename(from_leaf, &target, &name)?;
        to_dir.join(&name)
    }

    /// Claim a name in `dir` by creating an empty file under it: `name`, else
    /// `name (1)`, `name (2)`... Checking for a free name and creating the file
    /// are one step (`create_new`), so two downloads with the same name can
    /// never be handed the same one; the browser then fills the claimed file.
    pub fn reserve_name_in(&self, dir: &RelPath, name: &str) -> Result<String> {
        let handle = self.open_dir_at(dir)?;
        reserve_name(&handle, name)
    }

    /// Remove one file for good, without the trash. For files the shell itself
    /// must not keep (a disguised executable, a download over the quota).
    pub fn remove_file_now(&self, path: &RelPath) -> Result<()> {
        let (parent, leaf) = self.parent_and_leaf(path)?;
        let meta = parent.symlink_metadata(leaf)?;
        if is_link(&meta) || !meta.is_file() {
            return Err(FileError::IsReparsePoint);
        }
        parent.remove_file(leaf)?;
        Ok(())
    }

    /// Bytes used by a file or by everything inside a folder (links skipped).
    pub fn tree_size(&self, path: &RelPath) -> Result<u64> {
        let entry = self.stat(path)?;
        match entry.kind {
            EntryKind::File => Ok(entry.size),
            EntryKind::Folder => Ok(dir_size(&self.open_dir_at(path)?, 0)),
        }
    }

    /// Everything in the employee's folder, trash included. The trash's own
    /// index is bookkeeping, not the employee's data, so it is not counted
    /// (an emptied trash must read as zero).
    pub fn used_bytes(&self) -> u64 {
        let index = self
            .trash_dir(false)
            .ok()
            .flatten()
            .and_then(|trash| trash.metadata(TRASH_INDEX).ok())
            .map_or(0, |meta| meta.len());
        dir_size(&self.dir, 0).saturating_sub(index)
    }

    // ---- Trash --------------------------------------------------------

    fn trash_dir(&self, create: bool) -> Result<Option<Dir>> {
        match self.dir.symlink_metadata(TRASH_DIR) {
            Ok(meta) => {
                if is_link(&meta) || !meta.is_dir() {
                    return Err(FileError::IsReparsePoint);
                }
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                if !create {
                    return Ok(None);
                }
                self.dir.create_dir(TRASH_DIR)?;
            }
            Err(error) => return Err(error.into()),
        }
        Ok(Some(self.dir.open_dir(TRASH_DIR)?))
    }

    /// One trash operation at a time: a half-finished `trash` (slot folder made,
    /// index not yet written) must never be mistaken for an orphan.
    fn trash_guard(&self) -> std::sync::MutexGuard<'_, ()> {
        self.trash_lock.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn read_index(trash: &Dir) -> Vec<TrashItem> {
        trash
            .read(TRASH_INDEX)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    /// The index as it really is: entries whose payload is gone are dropped,
    /// payload folders the index does not know (a crash between the move and
    /// the index write, or a damaged index) are adopted so the employee can
    /// still restore or delete them, empty ones are removed. Writes the index
    /// back when anything changed. Call with the trash guard held.
    fn load_index(trash: &Dir) -> Vec<TrashItem> {
        let stored = Self::read_index(trash);
        let stored_len = stored.len();
        let mut items: Vec<TrashItem> = Vec::with_capacity(stored_len);
        for item in stored {
            let known = items.iter().any(|kept| kept.id == item.id);
            if !known && is_slot_id(&item.id) && payload_present(trash, &item) {
                items.push(item);
            }
        }
        let mut changed = items.len() != stored_len;
        if let Ok(entries) = trash.entries() {
            for entry in entries.flatten() {
                let Ok(id) = entry.file_name().into_string() else {
                    continue;
                };
                if !is_slot_id(&id) || items.iter().any(|kept| kept.id == id) {
                    continue;
                }
                let Ok(meta) = entry.metadata() else { continue };
                if is_link(&meta) || !meta.is_dir() {
                    continue;
                }
                if let Some(adopted) = adopt_orphan(trash, &id, &meta) {
                    items.push(adopted);
                    changed = true;
                }
            }
        }
        // A leftover from an interrupted index write.
        if trash.symlink_metadata(TRASH_INDEX_TMP).is_ok() {
            let _ = trash.remove_file(TRASH_INDEX_TMP);
        }
        if changed {
            let _ = Self::write_index(trash, &items);
        }
        items
    }

    /// Write the index to a temporary file in the same folder, then replace the
    /// real one: a crash leaves the old index or the new one, never half of one.
    fn write_index(trash: &Dir, items: &[TrashItem]) -> Result<()> {
        let bytes = serde_json::to_vec(items).map_err(|e| FileError::Io {
            message: e.to_string(),
        })?;
        trash.write(TRASH_INDEX_TMP, bytes)?;
        if let Err(error) = trash.rename(TRASH_INDEX_TMP, trash, TRASH_INDEX) {
            let _ = trash.remove_file(TRASH_INDEX_TMP);
            return Err(error.into());
        }
        Ok(())
    }

    pub fn trash_list(&self) -> Vec<TrashItem> {
        let _guard = self.trash_guard();
        match self.trash_dir(false) {
            Ok(Some(trash)) => {
                let mut items = Self::load_index(&trash);
                items.sort_by_key(|item| std::cmp::Reverse(item.deleted_ms));
                items
            }
            _ => Vec::new(),
        }
    }

    /// Move to the trash (hidden folder inside the root; it counts toward the quota).
    pub fn trash(&self, path: &RelPath) -> Result<TrashItem> {
        let entry = self.stat(path)?;
        if path.is_root() {
            return Err(FileError::OutsideRoot);
        }
        let size = self.tree_size(path)?;
        let (parent, leaf) = self.parent_and_leaf(path)?;
        let _guard = self.trash_guard();
        let trash = self.trash_dir(true)?.ok_or(FileError::NotFound)?;
        // Before the new slot exists, so it cannot be taken for an orphan.
        let mut items = Self::load_index(&trash);
        static SEQ: AtomicU32 = AtomicU32::new(0);
        let id = format!("{:x}{:03x}", now_ms(), SEQ.fetch_add(1, Ordering::Relaxed) & 0xfff);
        trash.create_dir(&id)?;
        let slot = trash.open_dir(&id)?;
        if let Err(error) = parent.rename(leaf, &slot, leaf) {
            drop(slot);
            let _ = trash.remove_dir(&id);
            return Err(error.into());
        }
        let item = TrashItem {
            id,
            original: path.as_string(),
            name: leaf.to_string(),
            is_folder: entry.kind == EntryKind::Folder,
            size,
            deleted_ms: now_ms(),
        };
        items.push(item.clone());
        if let Err(error) = Self::write_index(&trash, &items) {
            let _ = slot.rename(leaf, &parent, leaf);
            drop(slot);
            let _ = trash.remove_dir(&item.id);
            return Err(error);
        }
        Ok(item)
    }

    /// Back to where it was. When the folder is gone it lands in the root;
    /// when the name is taken it is numbered.
    pub fn restore(&self, id: &str) -> Result<RelPath> {
        let _guard = self.trash_guard();
        let trash = self.trash_dir(false)?.ok_or(FileError::NotFound)?;
        let mut items = Self::load_index(&trash);
        let position = items.iter().position(|i| i.id == id).ok_or(FileError::NotFound)?;
        let item = items[position].clone();
        let original = RelPath::parse(&item.original).unwrap_or_default();
        let (dest_path, dest_dir) = match self.open_dir_at(&original.parent()) {
            Ok(dir) => (original.parent(), dir),
            Err(_) => (RelPath::root(), self.dir.try_clone()?),
        };
        let name = unique_name(&dest_dir, &item.name, item.is_folder)?;
        let slot = trash.open_dir(&item.id)?;
        slot.rename(&item.name, &dest_dir, &name)?;
        // Windows will not remove a folder this code still holds open.
        drop(slot);
        let _ = trash.remove_dir(&item.id);
        items.remove(position);
        Self::write_index(&trash, &items)?;
        dest_path.join(&name)
    }

    /// Delete for good: one item, or everything (`None`). Returns the bytes freed.
    ///
    /// An item that cannot be removed (a file open in another program, say)
    /// stays in the trash and in the index, so it is still listed, still counted
    /// and can be tried again; the call then returns an error after having
    /// removed everything else it could.
    pub fn purge(&self, id: Option<&str>) -> Result<u64> {
        let _guard = self.trash_guard();
        let Some(trash) = self.trash_dir(false)? else {
            return Ok(0);
        };
        let items = Self::load_index(&trash);
        let (gone, mut kept): (Vec<_>, Vec<_>) = items
            .into_iter()
            .partition(|item| id.is_none_or(|wanted| wanted == item.id));
        if id.is_some() && gone.is_empty() {
            return Err(FileError::NotFound);
        }
        let mut freed = 0;
        let mut failed = 0usize;
        for item in gone {
            match trash.remove_dir_all(&item.id) {
                Ok(()) => freed += item.size,
                Err(error) if error.kind() == io::ErrorKind::NotFound => freed += item.size,
                Err(_) => {
                    failed += 1;
                    kept.push(item);
                }
            }
        }
        Self::write_index(&trash, &kept)?;
        if failed > 0 {
            return Err(FileError::Io {
                message: if failed == 1 {
                    "One item could not be deleted. It may be open in another program.".into()
                } else {
                    format!("{failed} items could not be deleted. They may be open in another program.")
                },
            });
        }
        Ok(freed)
    }

    /// Items older than `max_age_ms` go for good.
    pub fn purge_expired(&self, now_ms: u64, max_age_ms: u64) -> u64 {
        let old: Vec<String> = self
            .trash_list()
            .into_iter()
            .filter(|item| now_ms.saturating_sub(item.deleted_ms) > max_age_ms)
            .map(|item| item.id)
            .collect();
        old.iter()
            .filter_map(|id| self.purge(Some(id)).ok())
            .sum()
    }
    // ---- Search -------------------------------------------------------

    /// Case-insensitive substring on names, breadth first. Stops at `cap`
    /// hits or when `cancelled()` is true. Returns the hit count.
    pub fn search(
        &self,
        query: &str,
        cap: usize,
        cancelled: &dyn Fn() -> bool,
        hit: &mut dyn FnMut(Entry),
    ) -> usize {
        let needle = query.trim().to_lowercase();
        if needle.is_empty() {
            return 0;
        }
        let mut found = 0;
        let mut queue = std::collections::VecDeque::from([RelPath::root()]);
        while let Some(folder) = queue.pop_front() {
            if cancelled() {
                break;
            }
            let Ok(entries) = self.list(&folder) else {
                continue;
            };
            for entry in entries {
                if entry.name.to_lowercase().contains(&needle) {
                    found += 1;
                    let is_folder = entry.kind == EntryKind::Folder;
                    let path = entry.path.clone();
                    hit(entry);
                    if found >= cap {
                        return found;
                    }
                    if is_folder {
                        if let Ok(child) = RelPath::parse(&path) {
                            queue.push_back(child);
                        }
                    }
                } else if entry.kind == EntryKind::Folder {
                    if let Ok(child) = RelPath::parse(&entry.path) {
                        queue.push_back(child);
                    }
                }
            }
        }
        found
    }

    /// Files anywhere under the root that `wanted` accepts by name, newest
    /// first, at most `limit` of them. Looks at no more than `max_scan`
    /// entries, so a huge folder cannot stall the caller; folders themselves
    /// are never returned.
    pub fn newest_files(&self, wanted: &dyn Fn(&str) -> bool, limit: usize, max_scan: usize) -> Vec<Entry> {
        let mut found: Vec<Entry> = Vec::new();
        let mut scanned = 0usize;
        let mut queue = std::collections::VecDeque::from([RelPath::root()]);
        'walk: while let Some(folder) = queue.pop_front() {
            let Ok(entries) = self.list(&folder) else {
                continue;
            };
            for entry in entries {
                scanned += 1;
                if scanned > max_scan {
                    break 'walk;
                }
                match entry.kind {
                    EntryKind::Folder => {
                        if let Ok(child) = RelPath::parse(&entry.path) {
                            queue.push_back(child);
                        }
                    }
                    EntryKind::File if wanted(&entry.name) => found.push(entry),
                    EntryKind::File => {}
                }
            }
        }
        found.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms).then_with(|| a.path.cmp(&b.path)));
        found.truncate(limit);
        found
    }

    /// The first bytes of a file, for the content check.
    pub fn read_head(&self, path: &RelPath, max: usize) -> Result<Vec<u8>> {
        let file = self.open_read(path)?;
        let mut head = Vec::with_capacity(max);
        file.take(max as u64).read_to_end(&mut head)?;
        Ok(head)
    }

    /// For handing a file to another program: where it really is, checked on
    /// the open handle and required to be under the root.
    pub fn absolute_for_launch(&self, path: &RelPath) -> Result<PathBuf> {
        let file = self.open_read(path)?;
        let real = rulebox_desktop::files::final_path(&file).map_err(|e| FileError::Io {
            message: e.to_string(),
        })?;
        let simple = dunce::simplified(&real).to_path_buf();
        if !is_under(&simple, &self.root) {
            return Err(FileError::OutsideRoot);
        }
        Ok(simple)
    }
}

/// A trash slot folder is named by its id: lower-case hex, as `trash` makes it.
fn is_slot_id(name: &str) -> bool {
    !name.is_empty() && name.len() <= 32 && name.chars().all(|c| c.is_ascii_hexdigit())
}

/// Is the indexed item's file or folder still in its slot?
fn payload_present(trash: &Dir, item: &TrashItem) -> bool {
    let Ok(slot) = trash.open_dir(&item.id) else {
        return false;
    };
    slot.symlink_metadata(&item.name).is_ok_and(|meta| !is_link(&meta))
}

/// A slot the index does not list. One with exactly one valid entry becomes a
/// trash item again (its old location is lost, so it restores to the root);
/// an empty one is removed; anything else is left alone.
fn adopt_orphan(trash: &Dir, id: &str, slot_meta: &Metadata) -> Option<TrashItem> {
    let slot = trash.open_dir(id).ok()?;
    let mut found = slot.entries().ok()?.flatten();
    let Some(first) = found.next() else {
        // Windows will not remove a folder this code still holds open.
        drop(found);
        drop(slot);
        let _ = trash.remove_dir(id);
        return None;
    };
    if found.next().is_some() {
        return None;
    }
    let name = first.file_name().into_string().ok()?;
    names::check_component(&name).ok()?;
    let meta = first.metadata().ok()?;
    if is_link(&meta) || !(meta.is_dir() || meta.is_file()) {
        return None;
    }
    let is_folder = meta.is_dir();
    let size = if is_folder {
        dir_size(&slot.open_dir(&name).ok()?, 0)
    } else {
        meta.len()
    };
    Some(TrashItem {
        id: id.to_string(),
        original: name.clone(),
        name,
        is_folder,
        size,
        // The move into the trash is the last thing that changed the slot.
        deleted_ms: match modified_ms(slot_meta) {
            0 => now_ms(),
            known => known,
        },
    })
}

/// Case-insensitive "is `path` inside `root`", by whole components.
pub fn is_under(path: &Path, root: &Path) -> bool {
    let lower = |p: &Path| PathBuf::from(p.to_string_lossy().to_lowercase());
    lower(path).starts_with(lower(root))
}

fn copy_file(from_dir: &Dir, from_name: &str, to_dir: &Dir, to_name: &str) -> Result<()> {
    let meta = from_dir.symlink_metadata(from_name)?;
    if is_link(&meta) {
        return Err(FileError::IsReparsePoint);
    }
    let mut source = from_dir.open(from_name)?;
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    let mut dest = to_dir.open_with(to_name, &options)?;
    io::copy(&mut source, &mut dest)?;
    Ok(())
}

fn copy_tree(source: &Dir, to_parent: &Dir, to_name: &str, depth: usize) -> Result<()> {
    if depth > MAX_DEPTH {
        return Err(FileError::TooLarge);
    }
    let dest = to_parent.open_dir(to_name)?;
    for item in source.entries()? {
        let Ok(item) = item else { continue };
        let Ok(name) = item.file_name().into_string() else {
            continue;
        };
        let Ok(meta) = item.metadata() else { continue };
        if is_link(&meta) || names::is_internal(&name) {
            continue;
        }
        if meta.is_dir() {
            dest.create_dir(&name)?;
            copy_tree(&source.open_dir(&name)?, &dest, &name, depth + 1)?;
        } else if meta.is_file() {
            copy_file(source, &name, &dest, &name)?;
        }
    }
    Ok(())
}

fn dir_size(dir: &Dir, depth: usize) -> u64 {
    if depth > MAX_DEPTH {
        return 0;
    }
    let Ok(entries) = dir.entries() else { return 0 };
    let mut total = 0;
    for item in entries.flatten() {
        let Ok(meta) = item.metadata() else { continue };
        if is_link(&meta) {
            continue;
        }
        if meta.is_file() {
            total += meta.len();
        } else if meta.is_dir() {
            if let Ok(name) = item.file_name().into_string() {
                if let Ok(child) = dir.open_dir(&name) {
                    total += dir_size(&child, depth + 1);
                }
            }
        }
    }
    total
}
