//! Known folders (read-only). Paths are never built from a literal drive letter.

use std::ffi::{c_void, OsString};
use std::os::windows::ffi::OsStringExt;
use std::path::PathBuf;

use windows::core::GUID;
use windows::Win32::System::Com::CoTaskMemFree;
use windows::Win32::UI::Shell::{
    FOLDERID_ProgramData, FOLDERID_ProgramFiles, SHGetKnownFolderPath, KF_FLAG_DEFAULT,
};

use crate::error::{api_err, Result, Win32Error};

/// `%ProgramFiles%` (`FOLDERID_ProgramFiles`).
pub fn program_files() -> Result<PathBuf> {
    known_folder(&FOLDERID_ProgramFiles)
}

/// `%ProgramData%` (`FOLDERID_ProgramData`).
pub fn program_data() -> Result<PathBuf> {
    known_folder(&FOLDERID_ProgramData)
}

fn known_folder(id: &GUID) -> Result<PathBuf> {
    // SAFETY: `id` is a valid GUID reference; no token means the current user/default.
    let raw = unsafe { SHGetKnownFolderPath(id, KF_FLAG_DEFAULT, None) }
        .map_err(|e| api_err("SHGetKnownFolderPath", &e))?;
    if raw.is_null() {
        return Err(Win32Error::Invalid("known folder path is null".into()));
    }
    // SAFETY: on success the shell returns a NUL-terminated string that is
    // freed below with `CoTaskMemFree`, after the copy.
    let wide = unsafe { raw.as_wide() }.to_vec();
    // SAFETY: `raw` was allocated by the shell for the caller to free, and is not used afterwards.
    unsafe { CoTaskMemFree(Some(raw.0.cast::<c_void>().cast_const())) };
    Ok(PathBuf::from(OsString::from_wide(&wide)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folders_exist_and_are_absolute() {
        for dir in [program_files().unwrap(), program_data().unwrap()] {
            assert!(dir.is_absolute() && dir.is_dir(), "{}", dir.display());
        }
    }
}
