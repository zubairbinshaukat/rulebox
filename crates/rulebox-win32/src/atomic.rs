//! The last step of an atomic file write (Phase 5 Step 2, plan 4.4): the rename that
//! puts a finished temporary file in place **and** does not return before it is on
//! disk. `std::fs::rename` replaces the target but does not ask Windows to write
//! through, so a power cut right after it could still lose the new name.

use std::path::Path;

use windows::core::PCWSTR;
use windows::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH};

use crate::error::{api_err, Result};
use crate::util::to_wide;

/// Renames `from` over `to` with `MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH`.
/// Both must be on the same volume. This changes a file in Rulebox's own data
/// directory, not a machine setting, so it is not behind the test-machine guard.
pub fn replace_file_write_through(from: &Path, to: &Path) -> Result<()> {
    let from_buf = to_wide(&from.to_string_lossy());
    let to_buf = to_wide(&to.to_string_lossy());
    // SAFETY: both buffers are NUL-terminated UTF-16 that outlive the call.
    unsafe {
        MoveFileExW(
            PCWSTR(from_buf.as_ptr()),
            PCWSTR(to_buf.as_ptr()),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    }
    .map_err(|e| api_err("MoveFileExW", &e))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("rulebox-win32-atomic-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn replaces_an_existing_file() {
        let dir = scratch("replace");
        let (from, to) = (dir.join("new.tmp"), dir.join("state.json"));
        std::fs::write(&to, b"old").unwrap();
        std::fs::write(&from, b"new").unwrap();
        replace_file_write_through(&from, &to).unwrap();
        assert_eq!(std::fs::read(&to).unwrap(), b"new");
        assert!(!from.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn creates_the_target_when_there_is_none() {
        let dir = scratch("create");
        let (from, to) = (dir.join("a.tmp"), dir.join("a.json"));
        std::fs::write(&from, b"x").unwrap();
        replace_file_write_through(&from, &to).unwrap();
        assert_eq!(std::fs::read(&to).unwrap(), b"x");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_source_is_an_error_and_leaves_the_target() {
        let dir = scratch("missing");
        let to = dir.join("keep.json");
        std::fs::write(&to, b"keep").unwrap();
        assert!(replace_file_write_through(&dir.join("nope.tmp"), &to).is_err());
        assert_eq!(std::fs::read(&to).unwrap(), b"keep");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
