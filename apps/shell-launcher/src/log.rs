//! The launcher log: `%LOCALAPPDATA%\Rulebox\logs\shell-launcher.log` in the Staff
//! profile, truncated at 1 MB (plan Section 4.3). A line is written for every
//! start, exit code, fallback and hidden-exit step. Never the PIN.
//!
//! Failures to write are ignored: logging must never stop the launcher.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use windows::Win32::System::SystemInformation::GetLocalTime;

/// The file is started again when it grows past this.
pub const MAX_LOG_BYTES: u64 = 1_048_576;

fn log_path() -> Option<PathBuf> {
    let base = std::env::var_os("LOCALAPPDATA")?;
    Some(PathBuf::from(base).join("Rulebox").join("logs").join("shell-launcher.log"))
}

/// Appends one timestamped line. Safe to call from any thread.
pub fn line(message: &str) {
    // Unit tests drive the supervise loop; they must not write into the real profile.
    if cfg!(test) {
        return;
    }
    if let Some(path) = log_path() {
        append(&path, &format!("{} {message}\r\n", timestamp()), MAX_LOG_BYTES);
    }
}

/// Appends `text`, starting the file again when it is already larger than `max_bytes`.
pub fn append(path: &Path, text: &str, max_bytes: u64) {
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let too_big = fs::metadata(path).map(|m| m.len() > max_bytes).unwrap_or(false);
    let mut options = OpenOptions::new();
    options.create(true);
    if too_big {
        options.write(true).truncate(true);
    } else {
        options.append(true);
    }
    if let Ok(mut file) = options.open(path) {
        let _ = file.write_all(text.as_bytes());
    }
}

fn timestamp() -> String {
    // SAFETY: `GetLocalTime` has no preconditions and returns the value directly.
    let t = unsafe { GetLocalTime() };
    format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02}",
        t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn appends_and_truncates_past_the_limit() {
        let dir = std::env::temp_dir().join(format!("rulebox-shell-log-test-{}", std::process::id()));
        let path = dir.join("logs").join("shell-launcher.log");
        let _ = fs::remove_dir_all(&dir);

        append(&path, "one\r\n", 16);
        append(&path, "two\r\n", 16);
        assert_eq!(fs::read_to_string(&path).unwrap(), "one\r\ntwo\r\n");

        // 10 bytes written; make it larger than the limit, then the next line starts a new file.
        append(&path, "0123456789\r\n", 16);
        append(&path, "fresh\r\n", 16);
        assert_eq!(fs::read_to_string(&path).unwrap(), "fresh\r\n");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn timestamp_has_the_expected_shape() {
        let text = timestamp();
        assert_eq!(text.len(), 19);
        assert_eq!(&text[4..5], "-");
        assert_eq!(&text[13..14], ":");
    }
}
