//! (Phase 5 Step 14b) Unzips a driver package, and nothing else.
//!
//! The zip was downloaded from the signed document's URL and its SHA-256 matched, so it is the zip the administrator
//! uploaded; it is still treated as hostile (defence in depth: the admin's own PC may have been compromised, and a
//! verified file can still be a zip bomb). A package is refused, and everything written is deleted again, when:
//!
//! - an entry name is not a plain relative path: absolute, `..`, a drive or `:` (alternate data stream), a backslash
//!   (Windows reads it as a separator), a control character, a Windows device name (`CON`, `NUL`, `COM1`, ...), a name that
//!   ends in a dot or a space, or one of absurd length;
//! - an entry is a symbolic link, is encrypted, or repeats another name (case-insensitively; Windows does not tell
//!   them apart);
//! - there are more than [`MAX_ENTRIES`] entries or more than [`MAX_TOTAL_BYTES`] come out of the decompressor (the
//!   sizes a zip declares are only a hint: the real limit is counted on the bytes that actually leave the decompressor);
//! - the destination or its parent is a reparse point (a link or junction), or one appears while extracting.
//!
//! Nothing is executed here. No `windows` calls: plain `std::fs`, so it is tested with real zips in a temp folder.

use std::collections::HashSet;
use std::io::Read;
use std::path::{Path, PathBuf};

use super::is_reparse_point;

/// Most entries (files and folders) of a driver package.
pub const MAX_ENTRIES: usize = 5000;
/// Most bytes that may come out of the decompressor (all files together).
pub const MAX_TOTAL_BYTES: u64 = 1024 * 1024 * 1024;
/// Longest entry name, in characters.
pub const MAX_NAME_CHARS: usize = 240;

/// Why a zip was refused. Fixed texts only; the agent log never carries an entry name.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum ZipError {
    #[error("the zip cannot be read")]
    Unreadable,
    #[error("an entry has an unsafe path")]
    UnsafePath,
    #[error("an entry is a link")]
    Link,
    #[error("an entry is encrypted")]
    Encrypted,
    #[error("two entries have the same name")]
    Duplicate,
    #[error("more than {MAX_ENTRIES} entries")]
    TooManyEntries,
    #[error("the package unpacks to more than 1 GiB")]
    TooLarge,
    #[error("the destination is (or became) a link")]
    DestinationLink,
    #[error("a file error while unpacking")]
    Io,
}

/// What an extraction produced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Extracted {
    pub files: usize,
    pub bytes: u64,
}

const DEVICE_NAMES: [&str; 6] = ["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"];

fn is_device_name(component: &str) -> bool {
    // `CON.txt` is the device too: only the part before the first dot counts.
    let stem = component.split('.').next().unwrap_or(component).trim_end().to_ascii_uppercase();
    if DEVICE_NAMES.contains(&stem.as_str()) {
        return true;
    }
    let bytes = stem.as_bytes();
    bytes.len() == 4 && (stem.starts_with("COM") || stem.starts_with("LPT")) && bytes[3].is_ascii_digit()
}

/// The components of an entry name, or `None` when the name is not a plain relative path.
/// A trailing `/` (a folder entry) is allowed once.
pub fn safe_entry_name(name: &str) -> Option<Vec<&str>> {
    if name.is_empty() || name.chars().count() > MAX_NAME_CHARS {
        return None;
    }
    if name.chars().any(|c| c.is_control() || matches!(c, '\\' | ':' | '<' | '>' | '"' | '|' | '?' | '*')) {
        return None;
    }
    let trimmed = name.strip_suffix('/').unwrap_or(name);
    let parts: Vec<&str> = trimmed.split('/').collect();
    let ok = parts.iter().all(|part| {
        !part.is_empty()
            && *part != "."
            && *part != ".."
            && !part.ends_with('.')
            && !part.ends_with(' ')
            && part.chars().count() <= 255
            && !is_device_name(part)
    });
    ok.then_some(parts)
}

/// Unpacks `zip` into `dest`. `dest` is deleted first and again when anything fails, so a refused package leaves
/// nothing behind. `dest`'s parent must exist and not be a link.
pub fn extract(zip: &Path, dest: &Path) -> Result<Extracted, ZipError> {
    extract_with(zip, dest, MAX_ENTRIES, MAX_TOTAL_BYTES)
}

/// [`extract`] with the limits as parameters (the tests use small ones).
pub fn extract_with(zip: &Path, dest: &Path, max_entries: usize, max_bytes: u64) -> Result<Extracted, ZipError> {
    prepare(dest)?;
    let result = unpack(zip, dest, max_entries, max_bytes);
    if result.is_err() {
        remove_tree(dest);
    }
    result
}

/// Deletes a folder this module made (a link inside it is removed itself, never followed).
pub fn remove_tree(dest: &Path) {
    if let Err(error) = std::fs::remove_dir_all(dest) {
        if error.kind() != std::io::ErrorKind::NotFound {
            tracing::warn!("cannot delete a driver extraction folder: {error}");
        }
    }
}

fn prepare(dest: &Path) -> Result<(), ZipError> {
    let parent = dest.parent().ok_or(ZipError::DestinationLink)?;
    match is_reparse_point(parent) {
        Ok(false) => {}
        _ => return Err(ZipError::DestinationLink),
    }
    match is_reparse_point(dest) {
        Ok(false) => {}
        _ => return Err(ZipError::DestinationLink),
    }
    match std::fs::remove_dir_all(dest) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(ZipError::Io),
    }
    std::fs::create_dir_all(dest).map_err(|_| ZipError::Io)?;
    match is_reparse_point(dest) {
        Ok(false) => Ok(()),
        _ => Err(ZipError::DestinationLink),
    }
}

fn unpack(zip: &Path, dest: &Path, max_entries: usize, max_bytes: u64) -> Result<Extracted, ZipError> {
    let file = std::fs::File::open(zip).map_err(|_| ZipError::Unreadable)?;
    let mut archive = zip::ZipArchive::new(file).map_err(|_| ZipError::Unreadable)?;
    if archive.len() > max_entries {
        return Err(ZipError::TooManyEntries);
    }
    // First pass, headers only: every name, link, encryption and duplicate is judged before anything is written.
    let mut seen: HashSet<String> = HashSet::new();
    let mut declared: u64 = 0;
    let mut plan: Vec<(usize, Vec<String>, bool)> = Vec::new();
    for index in 0..archive.len() {
        let entry = archive.by_index_raw(index).map_err(|_| ZipError::Unreadable)?;
        let name = entry.name().map_err(|_| ZipError::UnsafePath)?.into_owned();
        let parts = safe_entry_name(&name).ok_or(ZipError::UnsafePath)?;
        if entry.is_symlink() {
            return Err(ZipError::Link);
        }
        if entry.encrypted() {
            return Err(ZipError::Encrypted);
        }
        let is_dir = entry.is_dir();
        if !seen.insert(parts.join("/").to_lowercase()) {
            return Err(ZipError::Duplicate);
        }
        declared = declared.saturating_add(entry.size());
        if declared > max_bytes {
            return Err(ZipError::TooLarge);
        }
        plan.push((index, parts.into_iter().map(str::to_string).collect(), is_dir));
    }
    // Second pass: write, counting what really comes out.
    let mut extracted = Extracted { files: 0, bytes: 0 };
    for (index, parts, is_dir) in plan {
        let mut target: PathBuf = dest.to_path_buf();
        for part in &parts {
            target.push(part);
        }
        // Every folder on the way must be a real folder (a junction cannot appear in a protected data folder, but a
        // check is cheaper than the argument).
        if let Some(parent) = target.parent() {
            create_dirs_below(dest, parent)?;
        }
        if is_dir {
            create_dirs_below(dest, &target)?;
            continue;
        }
        let mut entry = archive.by_index(index).map_err(|_| ZipError::Unreadable)?;
        let mut out = std::fs::OpenOptions::new().write(true).create_new(true).open(&target).map_err(|_| ZipError::Io)?;
        let left = max_bytes - extracted.bytes;
        let copied = std::io::copy(&mut (&mut entry).take(left.saturating_add(1)), &mut out).map_err(|_| ZipError::Io)?;
        if copied > left {
            return Err(ZipError::TooLarge);
        }
        extracted.bytes += copied;
        extracted.files += 1;
    }
    Ok(extracted)
}

/// Creates `dir` (which is `root` or below it) one level at a time, refusing a reparse point on the way.
fn create_dirs_below(root: &Path, dir: &Path) -> Result<(), ZipError> {
    let rest = dir.strip_prefix(root).map_err(|_| ZipError::UnsafePath)?;
    let mut current = root.to_path_buf();
    for part in rest.components() {
        current.push(part);
        match std::fs::symlink_metadata(&current) {
            Ok(meta) if meta.is_dir() => {
                if is_reparse_point(&current).map_err(|_| ZipError::Io)? {
                    return Err(ZipError::DestinationLink);
                }
            }
            Ok(_) => return Err(ZipError::Duplicate),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                std::fs::create_dir(&current).map_err(|_| ZipError::Io)?;
                if is_reparse_point(&current).map_err(|_| ZipError::Io)? {
                    return Err(ZipError::DestinationLink);
                }
            }
            Err(_) => return Err(ZipError::Io),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use super::*;
    use crate::testutil::TempDir;

    /// A zip with `(name, bytes)` entries; a name ending in `/` is a folder.
    fn zip_of(path: &Path, entries: &[(&str, &[u8])]) {
        let mut writer = zip::ZipWriter::new(std::fs::File::create(path).unwrap());
        let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for (name, bytes) in entries {
            if name.ends_with('/') {
                writer.add_directory(*name, options).unwrap();
            } else {
                writer.start_file(*name, options).unwrap();
                writer.write_all(bytes).unwrap();
            }
        }
        writer.finish().unwrap();
    }

    fn work() -> (TempDir, PathBuf, PathBuf) {
        let dir = TempDir::new();
        let zip = dir.path().join("p.zip");
        let dest = dir.path().join("out");
        (dir, zip, dest)
    }

    #[test]
    fn a_plain_package_unpacks() {
        let (_dir, zip, dest) = work();
        zip_of(&zip, &[("drv/", b""), ("drv/a.inf", b"[Version]"), ("drv/sub/a.cat", b"cat"), ("readme.txt", b"hi")]);
        let got = extract(&zip, &dest).unwrap();
        assert_eq!(got, Extracted { files: 3, bytes: 9 + 3 + 2 });
        assert_eq!(std::fs::read(dest.join("drv").join("a.inf")).unwrap(), b"[Version]");
        assert!(dest.join("drv").join("sub").join("a.cat").is_file());
    }

    #[test]
    fn unsafe_names_are_refused_and_nothing_stays() {
        for name in [
            "../evil.inf",
            "a/../../evil.inf",
            "/abs/evil.inf",
            r"\abs\evil.inf",
            r"a\b.inf",
            "C:/evil.inf",
            "C:evil.inf",
            "a.inf:stream",
            "con",
            "CON.inf",
            "dir/nul.txt",
            "dir/COM1",
            "lpt9.cat",
            "trailing./x.inf",
            "x.inf.",
            "x.inf ",
            "a//b.inf",
            "./a.inf",
            "a/./b.inf",
            "wild*.inf",
            "bad\u{1}name.inf",
        ] {
            let (_dir, zip, dest) = work();
            zip_of(&zip, &[("ok.inf", b"fine"), (name, b"x")]);
            assert_eq!(extract(&zip, &dest), Err(ZipError::UnsafePath), "{name:?}");
            assert!(!dest.exists(), "left files behind for {name:?}");
        }
        let (_dir, zip, dest) = work();
        zip_of(&zip, &[(&"x".repeat(241), b"x")]);
        assert_eq!(extract(&zip, &dest), Err(ZipError::UnsafePath));
    }

    #[test]
    fn duplicates_are_refused_case_insensitively() {
        let (_dir, zip, dest) = work();
        zip_of(&zip, &[("A.inf", b"1"), ("a.INF", b"2")]);
        assert_eq!(extract(&zip, &dest), Err(ZipError::Duplicate));
        assert!(!dest.exists());
    }

    #[test]
    fn a_symlink_entry_is_refused() {
        let (_dir, zip, dest) = work();
        let mut writer = zip::ZipWriter::new(std::fs::File::create(&zip).unwrap());
        writer.add_symlink("link.inf", "C:\\Windows", zip::write::SimpleFileOptions::default()).unwrap();
        writer.finish().unwrap();
        assert_eq!(extract(&zip, &dest), Err(ZipError::Link));
        assert!(!dest.exists());
    }

    #[test]
    fn too_many_entries_and_too_many_bytes_are_refused() {
        let (_dir, zip, dest) = work();
        zip_of(&zip, &[("a", b"1"), ("b", b"2"), ("c", b"3")]);
        assert_eq!(extract_with(&zip, &dest, 2, 100), Err(ZipError::TooManyEntries));
        assert!(!dest.exists());
        assert!(extract_with(&zip, &dest, 3, 100).is_ok());

        // Declared sizes count (cheap first filter) ...
        let big = vec![7u8; 5000];
        zip_of(&zip, &[("big.bin", &big)]);
        assert_eq!(extract_with(&zip, &dest, 10, 4999), Err(ZipError::TooLarge));
        assert!(!dest.exists());
        assert_eq!(extract_with(&zip, &dest, 10, 5000).map(|e| e.bytes), Ok(5000));
    }

    #[test]
    fn the_real_byte_count_decides_not_the_declared_size() {
        // A header that declares 10 bytes for an entry that unpacks to 5000: the stream is cut one byte past the budget.
        let (_dir, zip, dest) = work();
        let big = vec![1u8; 5000];
        zip_of(&zip, &[("liar.bin", &big)]);
        let mut bytes = std::fs::read(&zip).unwrap();
        // Local header at 0: uncompressed size is at offset 22; the central directory repeats it at +24 of its record.
        let declared = 10u32.to_le_bytes();
        let central = bytes.windows(4).position(|w| w == [0x50, 0x4b, 0x01, 0x02]).unwrap();
        bytes[central + 24..central + 28].copy_from_slice(&declared);
        bytes[22..26].copy_from_slice(&declared);
        std::fs::write(&zip, &bytes).unwrap();
        let result = extract_with(&zip, &dest, 10, 100);
        assert!(matches!(result, Err(ZipError::TooLarge | ZipError::Io | ZipError::Unreadable)), "{result:?}");
        assert!(!dest.exists());
    }

    #[test]
    fn not_a_zip_is_unreadable() {
        let (_dir, zip, dest) = work();
        std::fs::write(&zip, b"MZ not a zip").unwrap();
        assert_eq!(extract(&zip, &dest), Err(ZipError::Unreadable));
        assert!(!dest.exists());
        assert_eq!(extract(&zip.with_extension("missing"), &dest), Err(ZipError::Unreadable));
    }

    #[test]
    fn an_old_extraction_is_wiped_first() {
        let (_dir, zip, dest) = work();
        std::fs::create_dir_all(&dest).unwrap();
        std::fs::write(dest.join("stale.inf"), b"old").unwrap();
        zip_of(&zip, &[("new.inf", b"new")]);
        extract(&zip, &dest).unwrap();
        assert!(!dest.join("stale.inf").exists() && dest.join("new.inf").is_file());
    }

    #[test]
    fn a_link_as_destination_or_parent_is_refused() {
        let (dir, zip, _) = work();
        zip_of(&zip, &[("a.inf", b"x")]);
        let real = dir.path().join("real");
        std::fs::create_dir_all(&real).unwrap();
        let link = dir.path().join("link");
        // A junction needs no privilege; a symlink might. `mklink /J` through cmd keeps the test unprivileged.
        let made = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(&real)
            .stdout(std::process::Stdio::null())
            .status()
            .is_ok_and(|s| s.success());
        if !made {
            return; // cannot make a junction here; the rule is exercised on the VM
        }
        assert_eq!(extract(&zip, &link), Err(ZipError::DestinationLink));
        assert_eq!(extract(&zip, &link.join("out")), Err(ZipError::DestinationLink));
        assert!(real.read_dir().unwrap().next().is_none(), "nothing was written through the link");
    }

    #[test]
    fn safe_names_are_split_into_components() {
        assert_eq!(safe_entry_name("a/b/c.inf"), Some(vec!["a", "b", "c.inf"]));
        assert_eq!(safe_entry_name("a/b/"), Some(vec!["a", "b"]));
        assert_eq!(safe_entry_name("Brother HL-L2350 (x64)/a.inf"), Some(vec!["Brother HL-L2350 (x64)", "a.inf"]));
        assert_eq!(safe_entry_name(""), None);
        assert_eq!(safe_entry_name("a//"), None);
    }
}
