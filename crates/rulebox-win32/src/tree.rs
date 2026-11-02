//! (Phase 4 Step 16 review) Deleting one folder inside a user's profile without
//! ever following a link: the session cleanup (`reset_folder` in the agent).
//!
//! **Threat.** The agent runs as SYSTEM; the folders belong to the Staff account,
//! which controls them fully and may race the agent. A path string resolved again
//! by SYSTEM can be redirected between the check and the use: e.g. empty `vlc`,
//! turn it into a mount point to `\RPC Control`, plant an object-manager symlink
//! `cache` -> `C:\Config.Msi`, and a SYSTEM `remove_dir_all("...\vlc\cache")`
//! deletes a system folder (a known SYSTEM-escalation primitive).
//!
//! **Design** (no path string is resolved after the profile folder):
//! - The profile folder is opened by path, without following a link (its parents,
//!   `C:\` and `C:\Users`, are not writable by the Staff account).
//! - Every other folder is opened **relative to the held handle of its parent**
//!   (`NtCreateFile` with `RootDirectory`), one component at a time, with
//!   `OBJ_DONT_REPARSE` (any reparse met while opening fails the open: no mount
//!   point, junction or object-manager symlink is ever crossed) and
//!   `FILE_OPEN_REPARSE_POINT` (a link is opened itself, never its target).
//! - Each handle is checked (`FileAttributeTagInfo`): a link anywhere from the
//!   profile down to the target refuses the whole entry, and so does a
//!   case-sensitive folder on the way (the names would not mean what the
//!   template says).
//! - The folders stay open until the deletion is over. The profile, `AppData` and
//!   `Local`/`Roaming` are shared with the Staff session, so they are held with
//!   `FILE_SHARE_READ | FILE_SHARE_WRITE`; the app's own folders and every folder
//!   being emptied are held with `FILE_SHARE_READ` only, so nobody else can open
//!   them for writing (no reparse point set through a write handle) or delete /
//!   rename them meanwhile. Because every open is relative to a held handle, even
//!   a reparse point set on a held folder changes nothing for the agent.
//! - Inside the target, entries are listed through the folder's handle and each is
//!   opened relative to it and deleted **through its own handle**
//!   (`FileDispositionInfoEx`: POSIX semantics, read-only ignored). A link inside
//!   is deleted itself, never entered. An entry that changed kind since the listing
//!   is left for the next round.
//! - `SeBackupPrivilege` / `SeRestorePrivilege` are enabled (as `with_user_hive`
//!   already does for the same service) and every open asks for backup intent,
//!   so a DACL the Staff account set to lock SYSTEM out does not stop the deletion.
//!
//! Only `reset_below` changes anything (guarded). It cannot be run on the dev
//! machine; the walk and the listing are read-only and tested on temp folders.

use std::mem::{offset_of, size_of};
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::io::AsRawHandle;
use std::path::Path;

use windows::core::PWSTR;
use windows::Wdk::Foundation::OBJECT_ATTRIBUTES;
use windows::Wdk::Storage::FileSystem::{
    NtCreateFile, FILE_OPEN, FILE_OPEN_FOR_BACKUP_INTENT, FILE_OPEN_REPARSE_POINT, FILE_SYNCHRONOUS_IO_NONALERT,
};
use windows::Win32::Foundation::{ERROR_NO_MORE_FILES, HANDLE, NTSTATUS, OBJ_DONT_REPARSE, UNICODE_STRING};
use windows::Win32::Storage::FileSystem::{
    FileAttributeTagInfo, FileBasicInfo, FileCaseSensitiveInfo, FileDispositionInfo, FileDispositionInfoEx,
    FileIdBothDirectoryInfo, FileIdBothDirectoryRestartInfo, GetFileInformationByHandleEx, SetFileInformationByHandle,
    FILE_ACCESS_RIGHTS, FILE_ATTRIBUTE_TAG_INFO, FILE_BASIC_INFO, FILE_CASE_SENSITIVE_INFO, FILE_DISPOSITION_INFO,
    FILE_DISPOSITION_INFO_EX, FILE_DISPOSITION_INFO_EX_FLAGS, FILE_FLAGS_AND_ATTRIBUTES, FILE_ID_BOTH_DIR_INFO,
    FILE_SHARE_MODE,
};
use windows::Win32::System::IO::IO_STATUS_BLOCK;

use crate::error::{code_err, Result, Win32Error};
use crate::guard::require_test_machine;
use crate::security::enable_privileges;
use crate::util::OwnedHandle;

const FILE_ATTRIBUTE_READONLY: u32 = 0x1;
const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x10;
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
/// `FILE_CS_FLAG_CASE_SENSITIVE_DIR`.
const CASE_SENSITIVE_DIR: u32 = 0x1;

const DELETE: u32 = 0x0001_0000;
const SYNCHRONIZE: u32 = 0x0010_0000;
const FILE_LIST_DIRECTORY: u32 = 0x0001;
const FILE_TRAVERSE: u32 = 0x0020;
const FILE_READ_ATTRIBUTES: u32 = 0x0080;
const FILE_WRITE_ATTRIBUTES: u32 = 0x0100;

const SHARE_READ: u32 = 0x1;
const SHARE_WRITE: u32 = 0x2;
const SHARE_DELETE: u32 = 0x4;

/// A folder on the way: list, traverse, attributes. `FILE_LIST_DIRECTORY` is a
/// data access, so the share mode of the handle is enforced against later opens.
const HOLD_ACCESS: u32 = FILE_LIST_DIRECTORY | FILE_TRAVERSE | FILE_READ_ATTRIBUTES | SYNCHRONIZE;
/// The target and every entry below it: the above, plus deleting it and clearing
/// a read-only attribute (the fallback when POSIX delete is not supported).
const ENTRY_ACCESS: u32 = HOLD_ACCESS | DELETE | FILE_WRITE_ATTRIBUTES;

/// `FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT` (the profile folder).
const ROOT_FLAGS: u32 = 0x0200_0000 | 0x0020_0000;

/// NTSTATUS values the walk tells apart.
const STATUS_ACCESS_DENIED: u32 = 0xC000_0022;
const STATUS_OBJECT_NAME_INVALID: u32 = 0xC000_0033;
const STATUS_OBJECT_NAME_NOT_FOUND: u32 = 0xC000_0034;
const STATUS_OBJECT_PATH_NOT_FOUND: u32 = 0xC000_003A;
const STATUS_SHARING_VIOLATION: u32 = 0xC000_0043;
const STATUS_FILE_LOCK_CONFLICT: u32 = 0xC000_0054;
const STATUS_LOCK_NOT_GRANTED: u32 = 0xC000_0055;
const STATUS_DELETE_PENDING: u32 = 0xC000_0056;
const STATUS_REPARSE_POINT_ENCOUNTERED: u32 = 0xC000_050B;

/// Win32 codes of `SetFileInformationByHandle` / `CreateFileW`.
const WIN_NOT_FOUND: [u32; 3] = [2, 3, 303]; // file / path not found, delete pending
const WIN_BUSY: [u32; 4] = [5, 32, 33, 145]; // access denied, sharing, lock, directory not empty
const WIN_UNSUPPORTED: [u32; 3] = [1, 50, 87]; // invalid function, not supported, invalid parameter

/// Why an entry was refused before anything was deleted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    /// A folder on the way (or the target itself) is a reparse point.
    Link,
    /// A folder on the way is case-sensitive.
    CaseSensitive,
}

/// What [`reset_below`] did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TreeOutcome {
    /// The target and everything in it are gone.
    Removed,
    /// The target (or a folder above it) does not exist.
    Absent,
    /// Something was in use (or changed during the deletion): what could be
    /// deleted is deleted, the rest stays for the next round.
    InUse,
    /// `stop` asked to stop; what was deleted stays deleted.
    Stopped,
    /// Refused before anything was deleted.
    Refused(Refusal),
}

/// Deletes `<root>\<shared...>\<own...>` (the last of `own` is the target), see
/// the module documentation. `shared` are the folders the Staff session shares
/// (`AppData`, `Local`); `own` the app's folders (1 or more). Every component is a
/// single name (the caller checked the template rules). `stop` is asked between
/// entries; it ends the work early (`Stopped`). Blocking.
///
/// DESTRUCTIVE: guarded.
pub fn reset_below(root: &Path, shared: &[&str], own: &[&str], stop: &dyn Fn() -> bool) -> Result<TreeOutcome> {
    require_test_machine()?;
    if own.is_empty() {
        return Err(Win32Error::Invalid("no folder to reset".into()));
    }
    // Backup intent only bypasses a DACL with these enabled. Not fatal: without
    // them a folder that locks SYSTEM out is "in use" and stays.
    if let Err(error) = enable_privileges(&["SeBackupPrivilege", "SeRestorePrivilege"]) {
        tracing::debug!("cannot enable the backup privileges ({error}); deleting without them");
    }
    let walk = match walk(root, shared, own, ENTRY_ACCESS)? {
        Walked::Found(walk) => walk,
        Walked::Absent => return Ok(TreeOutcome::Absent),
        Walked::InUse => return Ok(TreeOutcome::InUse),
        Walked::Refused(refusal) => return Ok(TreeOutcome::Refused(refusal)),
    };
    let Walk { root: root_file, held, target, target_is_dir } = walk;
    let outcome = if target_is_dir {
        delete_tree(target, stop)
    } else {
        let deleted = delete_handle(target.raw());
        drop(target);
        Ok(match deleted {
            Ok(()) => TreeOutcome::Removed,
            Err(code) if WIN_NOT_FOUND.contains(&code) => TreeOutcome::Absent,
            Err(_) => TreeOutcome::InUse,
        })
    };
    // The folders above are released only now (innermost first).
    for handle in held.into_iter().rev() {
        drop(handle);
    }
    drop(root_file);
    outcome
}

/// The handles of a successful walk.
struct Walk {
    root: std::fs::File,
    /// `shared` then `own` without the target, outermost first.
    held: Vec<OwnedHandle>,
    target: OwnedHandle,
    target_is_dir: bool,
}

enum Walked {
    Found(Walk),
    Absent,
    InUse,
    Refused(Refusal),
}

/// How an open failed.
enum OpenError {
    Gone,
    Busy,
    Link,
    Other(u32),
}

fn classify_status(status: NTSTATUS) -> OpenError {
    match status.0 as u32 {
        STATUS_OBJECT_NAME_NOT_FOUND | STATUS_OBJECT_PATH_NOT_FOUND | STATUS_DELETE_PENDING => OpenError::Gone,
        STATUS_SHARING_VIOLATION | STATUS_ACCESS_DENIED | STATUS_FILE_LOCK_CONFLICT | STATUS_LOCK_NOT_GRANTED => {
            OpenError::Busy
        }
        STATUS_REPARSE_POINT_ENCOUNTERED => OpenError::Link,
        other => OpenError::Other(other),
    }
}

/// Opens the profile folder by path, without following a link.
fn open_root(root: &Path) -> std::io::Result<std::fs::File> {
    std::fs::OpenOptions::new()
        .access_mode(HOLD_ACCESS)
        .share_mode(SHARE_READ | SHARE_WRITE)
        .custom_flags(ROOT_FLAGS)
        .open(root)
}

/// Opens `name` (one component, UTF-16 without NUL) relative to the open folder
/// `parent`, never crossing a reparse point and opening a link itself.
fn open_rel(parent: HANDLE, name: &[u16], access: u32, share: u32) -> std::result::Result<OwnedHandle, NTSTATUS> {
    let bytes = name.len() * 2;
    let Ok(length) = u16::try_from(bytes) else {
        return Err(NTSTATUS(STATUS_OBJECT_NAME_INVALID as i32));
    };
    if name.is_empty() || name.contains(&u16::from(b'\\')) {
        return Err(NTSTATUS(STATUS_OBJECT_NAME_INVALID as i32));
    }
    // NtCreateFile takes a mutable buffer pointer in UNICODE_STRING; it does not write it.
    let mut buffer = name.to_vec();
    let object_name = UNICODE_STRING { Length: length, MaximumLength: length, Buffer: PWSTR(buffer.as_mut_ptr()) };
    let attributes = OBJECT_ATTRIBUTES {
        Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
        RootDirectory: parent,
        ObjectName: &object_name,
        // Not OBJ_CASE_INSENSITIVE: listed names are exact, and template names are
        // only used in folders checked not to be case-sensitive (NTFS then ignores case).
        Attributes: OBJ_DONT_REPARSE,
        SecurityDescriptor: std::ptr::null(),
        SecurityQualityOfService: std::ptr::null(),
    };
    let mut handle = HANDLE::default();
    let mut io = IO_STATUS_BLOCK::default();
    // SAFETY: every pointer is to a live local (`attributes` points at
    // `object_name`, which points at `buffer`); `parent` is an open handle the
    // caller owns; no EA buffer; the out handle is written only on success.
    let status = unsafe {
        NtCreateFile(
            &mut handle,
            FILE_ACCESS_RIGHTS(access),
            &attributes,
            &mut io,
            None,
            FILE_FLAGS_AND_ATTRIBUTES(0),
            FILE_SHARE_MODE(share),
            FILE_OPEN,
            FILE_OPEN_REPARSE_POINT | FILE_OPEN_FOR_BACKUP_INTENT | FILE_SYNCHRONOUS_IO_NONALERT,
            None,
            0,
        )
    };
    if status.0 < 0 {
        return Err(status);
    }
    OwnedHandle::new(handle).map_err(|_| NTSTATUS(STATUS_OBJECT_NAME_INVALID as i32))
}

/// Attributes of an open handle (`FileAttributeTagInfo`).
fn attributes(handle: HANDLE) -> windows::core::Result<u32> {
    let mut info = FILE_ATTRIBUTE_TAG_INFO::default();
    // SAFETY: the buffer is a FILE_ATTRIBUTE_TAG_INFO and the size passed is its size.
    unsafe {
        GetFileInformationByHandleEx(
            handle,
            FileAttributeTagInfo,
            (&mut info as *mut FILE_ATTRIBUTE_TAG_INFO).cast(),
            size_of::<FILE_ATTRIBUTE_TAG_INFO>() as u32,
        )
    }?;
    Ok(info.FileAttributes)
}

/// Whether the open folder is case-sensitive. A file system that does not know
/// the flag has no case-sensitive folders.
fn is_case_sensitive(handle: HANDLE) -> bool {
    let mut info = FILE_CASE_SENSITIVE_INFO::default();
    // SAFETY: the buffer is a FILE_CASE_SENSITIVE_INFO and the size passed is its size.
    let read = unsafe {
        GetFileInformationByHandleEx(
            handle,
            FileCaseSensitiveInfo,
            (&mut info as *mut FILE_CASE_SENSITIVE_INFO).cast(),
            size_of::<FILE_CASE_SENSITIVE_INFO>() as u32,
        )
    };
    read.is_ok() && info.Flags & CASE_SENSITIVE_DIR != 0
}

/// How a folder on the way looks.
enum Level {
    Dir,
    NotDir,
    Refused(Refusal),
}

fn check_level(handle: HANDLE) -> Result<Level> {
    let attrs = attributes(handle).map_err(|e| crate::error::api_err("GetFileInformationByHandleEx", &e))?;
    if attrs & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Ok(Level::Refused(Refusal::Link));
    }
    if attrs & FILE_ATTRIBUTE_DIRECTORY == 0 {
        return Ok(Level::NotDir);
    }
    if is_case_sensitive(handle) {
        return Ok(Level::Refused(Refusal::CaseSensitive));
    }
    Ok(Level::Dir)
}

fn wide(name: &str) -> Vec<u16> {
    name.encode_utf16().collect()
}

/// Opens and checks every folder from `root` down, then the target with
/// `target_access`. Read-only by itself (nothing is changed; the handles are
/// only held).
fn walk(root: &Path, shared: &[&str], own: &[&str], target_access: u32) -> Result<Walked> {
    let root_file = match open_root(root) {
        Ok(file) => file,
        Err(error) => {
            let code = error.raw_os_error().map_or(0, |code| code as u32);
            if WIN_NOT_FOUND.contains(&code) {
                return Ok(Walked::Absent);
            }
            if WIN_BUSY.contains(&code) {
                return Ok(Walked::InUse);
            }
            return Err(code_err("CreateFileW", code));
        }
    };
    let root_handle = HANDLE(root_file.as_raw_handle());
    match check_level(root_handle)? {
        Level::Dir => {}
        Level::NotDir => return Ok(Walked::Absent),
        Level::Refused(refusal) => return Ok(Walked::Refused(refusal)),
    }
    let Some((target_name, own_above)) = own.split_last() else {
        return Err(Win32Error::Invalid("no folder to reset".into()));
    };
    let levels = shared
        .iter()
        .map(|name| (*name, SHARE_READ | SHARE_WRITE))
        .chain(own_above.iter().map(|name| (*name, SHARE_READ)));
    let mut held: Vec<OwnedHandle> = Vec::with_capacity(shared.len() + own.len());
    for (name, share) in levels {
        let parent = held.last().map_or(root_handle, OwnedHandle::raw);
        let handle = match open_rel(parent, &wide(name), HOLD_ACCESS, share) {
            Ok(handle) => handle,
            Err(status) => return map_walk_error(status),
        };
        match check_level(handle.raw())? {
            Level::Dir => held.push(handle),
            Level::NotDir => return Ok(Walked::Absent),
            Level::Refused(refusal) => return Ok(Walked::Refused(refusal)),
        }
    }
    let parent = held.last().map_or(root_handle, OwnedHandle::raw);
    let target = match open_rel(parent, &wide(target_name), target_access, SHARE_READ) {
        Ok(handle) => handle,
        Err(status) => return map_walk_error(status),
    };
    let attrs = attributes(target.raw()).map_err(|e| crate::error::api_err("GetFileInformationByHandleEx", &e))?;
    if attrs & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Ok(Walked::Refused(Refusal::Link));
    }
    let target_is_dir = attrs & FILE_ATTRIBUTE_DIRECTORY != 0;
    Ok(Walked::Found(Walk { root: root_file, held, target, target_is_dir }))
}

fn map_walk_error(status: NTSTATUS) -> Result<Walked> {
    match classify_status(status) {
        OpenError::Gone => Ok(Walked::Absent),
        OpenError::Busy => Ok(Walked::InUse),
        OpenError::Link => Ok(Walked::Refused(Refusal::Link)),
        OpenError::Other(_) => Err(Win32Error::Nt { api: "NtCreateFile", status: status.0 }),
    }
}

/// One entry of a folder listing: the exact name and the attributes it had then.
struct Entry {
    name: Vec<u16>,
    attributes: u32,
}

/// Lists the open folder through its handle (`.` and `..` left out). `None` when
/// `stop` asked to stop.
fn list_entries(dir: HANDLE, stop: &dyn Fn() -> bool) -> windows::core::Result<Option<Vec<Entry>>> {
    const BUFFER_BYTES: usize = 64 * 1024;
    // u64 elements: 8-byte aligned, as the entries need.
    let mut buffer = vec![0u64; BUFFER_BYTES / 8];
    let mut entries = Vec::new();
    let mut class = FileIdBothDirectoryRestartInfo;
    loop {
        if stop() {
            return Ok(None);
        }
        // SAFETY: the buffer is writable for BUFFER_BYTES bytes and 8-byte aligned.
        let read = unsafe {
            GetFileInformationByHandleEx(dir, class, buffer.as_mut_ptr().cast(), BUFFER_BYTES as u32)
        };
        class = FileIdBothDirectoryInfo;
        match read {
            Ok(()) => {}
            Err(error) if error.code() == ERROR_NO_MORE_FILES.to_hresult() => return Ok(Some(entries)),
            Err(error) => return Err(error),
        }
        let base = buffer.as_ptr().cast::<u8>();
        let mut offset = 0usize;
        loop {
            let name_at = offset + offset_of!(FILE_ID_BOTH_DIR_INFO, FileName);
            if name_at > BUFFER_BYTES {
                break;
            }
            // SAFETY: every read is inside the buffer (checked against
            // BUFFER_BYTES) and unaligned reads are used for the fields.
            let (next, attributes, name_bytes) = unsafe {
                (
                    base.add(offset + offset_of!(FILE_ID_BOTH_DIR_INFO, NextEntryOffset)).cast::<u32>().read_unaligned(),
                    base.add(offset + offset_of!(FILE_ID_BOTH_DIR_INFO, FileAttributes)).cast::<u32>().read_unaligned(),
                    base.add(offset + offset_of!(FILE_ID_BOTH_DIR_INFO, FileNameLength)).cast::<u32>().read_unaligned(),
                )
            };
            let name_bytes = name_bytes as usize;
            if name_at + name_bytes > BUFFER_BYTES {
                break;
            }
            // SAFETY: `name_bytes` bytes from `name_at` are inside the buffer (checked above).
            let name: Vec<u16> = (0..name_bytes / 2)
                .map(|i| unsafe { base.add(name_at + i * 2).cast::<u16>().read_unaligned() })
                .collect();
            let dot = [u16::from(b'.')];
            let dots = [u16::from(b'.'), u16::from(b'.')];
            if !name.is_empty() && name[..] != dot && name[..] != dots {
                entries.push(Entry { name, attributes });
            }
            if next == 0 {
                break;
            }
            offset += next as usize;
        }
    }
}

/// Deletes the open file, link or (empty) folder through its handle: POSIX
/// semantics (the name goes at once) ignoring the read-only attribute; on a file
/// system without them, clears read-only and marks it delete-on-close. `Err` is
/// the Win32 code.
fn delete_handle(handle: HANDLE) -> std::result::Result<(), u32> {
    let flags = FILE_DISPOSITION_INFO_EX_FLAGS(0x1 | 0x2 | 0x10); // DELETE | POSIX_SEMANTICS | IGNORE_READONLY_ATTRIBUTE
    let info = FILE_DISPOSITION_INFO_EX { Flags: flags };
    // SAFETY: the buffer is a FILE_DISPOSITION_INFO_EX and the size passed is its size.
    let done = unsafe {
        SetFileInformationByHandle(
            handle,
            FileDispositionInfoEx,
            (&info as *const FILE_DISPOSITION_INFO_EX).cast(),
            size_of::<FILE_DISPOSITION_INFO_EX>() as u32,
        )
    };
    let code = match done {
        Ok(()) => return Ok(()),
        Err(error) => win32_code(&error),
    };
    if !WIN_UNSUPPORTED.contains(&code) {
        return Err(code);
    }
    let mut basic = FILE_BASIC_INFO::default();
    // SAFETY: the buffer is a FILE_BASIC_INFO and the size passed is its size.
    let read = unsafe {
        GetFileInformationByHandleEx(
            handle,
            FileBasicInfo,
            (&mut basic as *mut FILE_BASIC_INFO).cast(),
            size_of::<FILE_BASIC_INFO>() as u32,
        )
    };
    if read.is_ok() && basic.FileAttributes & FILE_ATTRIBUTE_READONLY != 0 {
        // Zero times mean "leave unchanged".
        let cleared = FILE_BASIC_INFO { FileAttributes: basic.FileAttributes & !FILE_ATTRIBUTE_READONLY, ..Default::default() };
        // SAFETY: as above, for the set.
        let _ = unsafe {
            SetFileInformationByHandle(
                handle,
                FileBasicInfo,
                (&cleared as *const FILE_BASIC_INFO).cast(),
                size_of::<FILE_BASIC_INFO>() as u32,
            )
        };
    }
    let info = FILE_DISPOSITION_INFO { DeleteFile: true };
    // SAFETY: the buffer is a FILE_DISPOSITION_INFO and the size passed is its size.
    unsafe {
        SetFileInformationByHandle(
            handle,
            FileDispositionInfo,
            (&info as *const FILE_DISPOSITION_INFO).cast(),
            size_of::<FILE_DISPOSITION_INFO>() as u32,
        )
    }
    .map_err(|error| win32_code(&error))
}

fn win32_code(error: &windows::core::Error) -> u32 {
    let hr = error.code().0 as u32;
    if hr >> 16 == 0x8007 {
        hr & 0xFFFF
    } else {
        hr
    }
}

/// A folder being emptied: its handle (held with `FILE_SHARE_READ` only) and the
/// entries still to do.
struct Frame {
    dir: OwnedHandle,
    entries: Vec<Entry>,
}

/// Empties and deletes the open folder `target` (see the module documentation).
fn delete_tree(target: OwnedHandle, stop: &dyn Fn() -> bool) -> Result<TreeOutcome> {
    let mut busy = false;
    let entries = match list_entries(target.raw(), stop) {
        Ok(Some(entries)) => entries,
        Ok(None) => return Ok(TreeOutcome::Stopped),
        Err(error) => return Err(crate::error::api_err("GetFileInformationByHandleEx", &error)),
    };
    let mut stack = vec![Frame { dir: target, entries }];
    while let Some(top) = stack.last_mut() {
        if stop() {
            return Ok(TreeOutcome::Stopped);
        }
        let Some(entry) = top.entries.pop() else {
            // Every entry done: the folder itself (fails "not empty" when
            // something inside stayed; that is already counted as busy).
            if let Some(frame) = stack.pop() {
                if let Err(code) = delete_handle(frame.dir.raw()) {
                    if !WIN_NOT_FOUND.contains(&code) {
                        busy = true;
                    }
                }
            }
            continue;
        };
        let listed_dir =
            entry.attributes & FILE_ATTRIBUTE_DIRECTORY != 0 && entry.attributes & FILE_ATTRIBUTE_REPARSE_POINT == 0;
        // A folder to empty is held without write / delete sharing; a file or a
        // link is opened as permissively as possible (only its deletion is asked).
        let share = if listed_dir { SHARE_READ } else { SHARE_READ | SHARE_WRITE | SHARE_DELETE };
        let handle = match open_rel(top.dir.raw(), &entry.name, ENTRY_ACCESS, share) {
            Ok(handle) => handle,
            Err(status) => {
                match classify_status(status) {
                    OpenError::Gone => {}
                    OpenError::Busy | OpenError::Link => busy = true,
                    OpenError::Other(code) => {
                        tracing::debug!("session cleanup: an entry could not be opened (NTSTATUS {code:#x})");
                        busy = true;
                    }
                }
                continue;
            }
        };
        let Ok(attrs) = attributes(handle.raw()) else {
            busy = true;
            continue;
        };
        let is_link = attrs & FILE_ATTRIBUTE_REPARSE_POINT != 0;
        let is_dir = attrs & FILE_ATTRIBUTE_DIRECTORY != 0;
        if is_dir && !is_link {
            if !listed_dir {
                // It changed since the listing: left for the next round.
                busy = true;
                continue;
            }
            match list_entries(handle.raw(), stop) {
                Ok(Some(entries)) => stack.push(Frame { dir: handle, entries }),
                Ok(None) => return Ok(TreeOutcome::Stopped),
                Err(_) => busy = true,
            }
            continue;
        }
        // A file, or a link (deleted itself, never entered).
        if let Err(code) = delete_handle(handle.raw()) {
            if !WIN_NOT_FOUND.contains(&code) {
                busy = true;
            }
        }
    }
    Ok(if busy { TreeOutcome::InUse } else { TreeOutcome::Removed })
}

#[cfg(test)]
mod tests {
    //! Read-only on the dev machine: temp folders are created and inspected, the
    //! walk and the listing only open handles. The deletion itself is VM-only.

    use super::*;
    use std::path::PathBuf;

    struct Temp(PathBuf);

    impl Temp {
        fn new(tag: &str) -> Self {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| d.as_nanos());
            let path = std::env::temp_dir().join(format!("rulebox-tree-{tag}-{}-{nanos}", std::process::id()));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// `<root>\AppData\Local\Acme\cache\a.txt` and `<root>\outside\keep.txt`.
    fn profile() -> Temp {
        let t = Temp::new("p");
        std::fs::create_dir_all(t.0.join(r"AppData\Local\Acme\cache")).unwrap();
        std::fs::write(t.0.join(r"AppData\Local\Acme\cache\a.txt"), b"x").unwrap();
        std::fs::write(t.0.join(r"AppData\Local\Acme\login.json"), b"x").unwrap();
        std::fs::create_dir_all(t.0.join("outside")).unwrap();
        std::fs::write(t.0.join(r"outside\keep.txt"), b"x").unwrap();
        t
    }

    fn junction(link: &Path, target: &Path) -> bool {
        std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    }

    fn outcome(walked: &Walked) -> &'static str {
        match walked {
            Walked::Found(walk) if walk.target_is_dir => "dir",
            Walked::Found(_) => "file",
            Walked::Absent => "absent",
            Walked::InUse => "in use",
            Walked::Refused(Refusal::Link) => "link",
            Walked::Refused(Refusal::CaseSensitive) => "case-sensitive",
        }
    }

    const SHARED: &[&str] = &["AppData", "Local"];

    #[test]
    fn the_walk_opens_every_folder_relative_to_its_parent() {
        let t = profile();
        let walked = walk(&t.0, SHARED, &["Acme", "cache"], HOLD_ACCESS).unwrap();
        assert_eq!(outcome(&walked), "dir");
        let Walked::Found(found) = walked else { panic!() };
        assert_eq!(found.held.len(), 3, "AppData, Local, Acme");
        let names: Vec<String> = list_entries(found.target.raw(), &|| false)
            .unwrap()
            .unwrap()
            .iter()
            .map(|e| String::from_utf16_lossy(&e.name))
            .collect();
        assert_eq!(names, ["a.txt"]);
        // A file target, a missing one, a file where a folder should be.
        assert_eq!(outcome(&walk(&t.0, SHARED, &["Acme", "login.json"], HOLD_ACCESS).unwrap()), "file");
        assert_eq!(outcome(&walk(&t.0, SHARED, &["Nope", "x"], HOLD_ACCESS).unwrap()), "absent");
        assert_eq!(outcome(&walk(&t.0, SHARED, &["Acme", "login.json", "x"], HOLD_ACCESS).unwrap()), "absent");
        assert_eq!(outcome(&walk(&t.0.join("missing"), SHARED, &["Acme"], HOLD_ACCESS).unwrap()), "absent");
        // A stop request ends the listing.
        let Walked::Found(found) = walk(&t.0, SHARED, &["Acme"], HOLD_ACCESS).unwrap() else { panic!() };
        assert!(list_entries(found.target.raw(), &|| true).unwrap().is_none());
    }

    #[test]
    fn a_junction_at_any_level_is_refused_and_a_link_is_opened_itself() {
        let t = profile();
        let elsewhere = Temp::new("e");
        std::fs::create_dir_all(elsewhere.0.join("cache")).unwrap();
        // The target is a junction; a junction above the target.
        let link = t.0.join(r"AppData\Local\Acme\linked");
        assert!(junction(&link, &elsewhere.0), "mklink /J failed");
        assert_eq!(outcome(&walk(&t.0, SHARED, &["Acme", "linked"], HOLD_ACCESS).unwrap()), "link");
        assert_eq!(outcome(&walk(&t.0, SHARED, &["Acme", "linked", "cache"], HOLD_ACCESS).unwrap()), "link");
        // OBJ_DONT_REPARSE + FILE_OPEN_REPARSE_POINT open the link itself (this
        // is how a link inside a reset folder is deleted without being followed).
        let Walked::Found(acme) = walk(&t.0, SHARED, &["Acme"], HOLD_ACCESS).unwrap() else { panic!() };
        let opened = open_rel(acme.target.raw(), &wide("linked"), HOLD_ACCESS, SHARE_READ | SHARE_WRITE | SHARE_DELETE);
        let opened = opened.unwrap_or_else(|status| panic!("NTSTATUS {:#x}", status.0));
        assert_ne!(attributes(opened.raw()).unwrap() & FILE_ATTRIBUTE_REPARSE_POINT, 0);
        // And the listing reports it as a link.
        let listed = list_entries(acme.target.raw(), &|| false).unwrap().unwrap();
        let entry = listed.iter().find(|e| String::from_utf16_lossy(&e.name) == "linked").unwrap();
        assert_ne!(entry.attributes & FILE_ATTRIBUTE_REPARSE_POINT, 0);
        drop(opened);
        drop(acme);
        // `AppData` itself a junction: refused at that level.
        let t2 = Temp::new("q");
        assert!(junction(&t2.0.join("AppData"), &t.0.join("AppData")));
        assert_eq!(outcome(&walk(&t2.0, SHARED, &["Acme", "cache"], HOLD_ACCESS).unwrap()), "link");
        // Only the links go away with the temp folders (remove_dir on a junction).
        std::fs::remove_dir(&link).unwrap();
        std::fs::remove_dir(t2.0.join("AppData")).unwrap();
        assert!(elsewhere.0.join("cache").is_dir());
    }

    #[test]
    fn held_folders_cannot_be_renamed_or_opened_for_writing() {
        let t = profile();
        let walked = walk(&t.0, SHARED, &["Acme", "cache"], HOLD_ACCESS).unwrap();
        let acme = t.0.join(r"AppData\Local\Acme");
        // Held without FILE_SHARE_DELETE: no rename (so no swap) while the walk holds it.
        assert!(std::fs::rename(&acme, t.0.join(r"AppData\Local\Acme2")).is_err());
        // Held without FILE_SHARE_WRITE: nobody gets a write handle (no reparse
        // point can be set through one).
        let write = std::fs::OpenOptions::new()
            .access_mode(0x2) // FILE_WRITE_DATA (FILE_ADD_FILE)
            .share_mode(SHARE_READ | SHARE_WRITE | SHARE_DELETE)
            .custom_flags(0x0200_0000)
            .open(&acme);
        assert!(write.is_err());
        drop(walked);
        // Released: both work again.
        std::fs::rename(&acme, t.0.join(r"AppData\Local\Acme2")).unwrap();
    }

    #[test]
    fn names_with_a_separator_are_never_opened() {
        let t = profile();
        let Walked::Found(found) = walk(&t.0, SHARED, &["Acme"], HOLD_ACCESS).unwrap() else { panic!() };
        assert!(open_rel(found.target.raw(), &wide(r"cache\a.txt"), HOLD_ACCESS, SHARE_READ).is_err());
        assert!(open_rel(found.target.raw(), &[], HOLD_ACCESS, SHARE_READ).is_err());
    }

    #[test]
    fn reset_is_blocked_by_the_guard_on_the_dev_machine() {
        if crate::guard::is_test_machine() {
            return;
        }
        let t = profile();
        let result = reset_below(&t.0, SHARED, &["Acme"], &|| false);
        assert!(matches!(result, Err(Win32Error::Guard(_))), "{result:?}");
        assert!(t.0.join(r"AppData\Local\Acme\login.json").is_file(), "nothing deleted");
    }
}
