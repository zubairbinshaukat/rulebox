//! Downloads from web apps (plan Step 15): where they go, what is refused,
//! and what is checked when they finish. The decisions are pure; the Tauri
//! handler at the bottom applies them.

use std::path::PathBuf;

use crate::files::names::{self, INTERNAL_PREFIX};
use crate::files::saferoot::{FileError, RelPath, SafeRoot};
use crate::files::types::{check_content, opener_for, Opener};
use crate::files::FileSession;

/// Longest download name kept, in characters (the extension survives a cut).
const MAX_NAME_CHARS: usize = 120;
const DOWNLOADS: &str = "Downloads";

/// A safe file name from what a site suggested: the last path part only, no
/// characters Windows refuses, no reserved device names, no trailing dots or
/// spaces, at most 120 characters, and `download` when nothing is left.
pub fn clean_download_name(suggested: &str) -> String {
    let leaf = suggested.rsplit(['/', '\\']).next().unwrap_or("");
    let mut name: String = leaf
        .chars()
        .map(|c| {
            if c.is_control()
                || matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
                || matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
            {
                '_'
            } else {
                c
            }
        })
        .collect();
    // A leading dot is a legitimate hidden-file name; trailing dots and spaces Windows would drop.
    name = name.trim_start_matches(' ').trim_end_matches(['.', ' ']).to_string();
    if name.chars().count() > MAX_NAME_CHARS {
        name = shorten(&name);
    }
    name = name.trim_end_matches(['.', ' ']).to_string();
    if name.is_empty() {
        return "download".to_string();
    }
    if name.starts_with(INTERNAL_PREFIX) {
        name = format!("_{name}");
    }
    // Reserved device names (`CON`, `nul.txt`...) get a leading underscore.
    if names::check_component(&name).is_err() {
        let prefixed = format!("_{name}");
        name = if names::check_component(&prefixed).is_ok() {
            prefixed
        } else {
            String::new()
        };
    }
    if name.is_empty() {
        "download".to_string()
    } else {
        name
    }
}

/// Cut to the limit, keeping a short extension at the end.
fn shorten(name: &str) -> String {
    let (stem, ext) = match name.rfind('.') {
        Some(dot) if name.len() - dot <= 12 && dot > 0 => (&name[..dot], &name[dot..]),
        _ => (name, ""),
    };
    let keep = MAX_NAME_CHARS.saturating_sub(ext.chars().count());
    let cut: String = stem.chars().take(keep).collect();
    format!("{cut}{ext}")
}

/// `<root>\Downloads\<name>`, numbered (`name (1).ext`) when taken, because
/// WebView2 would overwrite. Creates the folder when it is missing.
pub fn destination(root: &SafeRoot, name: &str) -> Result<PathBuf, FileError> {
    let folder = RelPath::parse(DOWNLOADS)?;
    match root.mkdir(&folder) {
        Ok(()) | Err(FileError::Exists) => {}
        Err(other) => return Err(other),
    }
    let clean = clean_download_name(name);
    let target = root.free_name_in(&folder, &clean)?;
    Ok(root.root_path().join(DOWNLOADS).join(target))
}

/// What to do when a download is requested.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DownloadDecision {
    Allow,
    /// The app is not allowed to download.
    NotAllowed,
    /// An executable, script or installer type.
    BlockedType,
    /// The employee's folder is full.
    QuotaFull,
}

pub fn decide_download(downloads_allowed: bool, blocked_type: bool, quota_full: bool) -> DownloadDecision {
    if !downloads_allowed {
        DownloadDecision::NotAllowed
    } else if blocked_type {
        DownloadDecision::BlockedType
    } else if quota_full {
        DownloadDecision::QuotaFull
    } else {
        DownloadDecision::Allow
    }
}

/// Is this file name on the deny-list (a type that may never be opened)?
pub fn is_blocked_name(name: &str) -> bool {
    matches!(opener_for(name, &Default::default()), Opener::Blocked)
}

/// What happened to a finished download.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Finished {
    Saved { name: String },
    /// The bytes were an executable in disguise.
    RemovedUnsafe { name: String },
    /// It pushed the folder over its quota.
    RemovedOverQuota { name: String },
    Failed,
    /// It ended up somewhere that is not the employee's folder.
    Misplaced,
}

/// Check a finished download in `path` (inside the employee's folder) and
/// remove it when it must not stay. `session` gives the quota and the folder handle.
pub fn finish(session: &FileSession, path: &std::path::Path, success: bool) -> Finished {
    use crate::files::saferoot::is_under;

    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    if !success {
        let _ = std::fs::remove_file(path);
        return Finished::Failed;
    }
    if !is_under(path, session.root().root_path()) {
        // Never touch a file outside the folder, not even to delete it.
        return Finished::Misplaced;
    }
    let relative = path
        .strip_prefix(session.root().root_path())
        .ok()
        .map(|rest| rest.to_string_lossy().replace('\\', "/"));
    let Some(rel) = relative.and_then(|text| RelPath::parse(&text).ok()) else {
        return Finished::Misplaced;
    };
    let unsafe_bytes = session
        .root()
        .read_head(&rel, 8192)
        .is_ok_and(|head| check_content(&name, &head).is_err());
    if unsafe_bytes {
        let _ = session.delete_now(&rel);
        return Finished::RemovedUnsafe { name };
    }
    session.refresh_usage();
    if session.over_quota() {
        let _ = session.delete_now(&rel);
        return Finished::RemovedOverQuota { name };
    }
    Finished::Saved { name }
}
