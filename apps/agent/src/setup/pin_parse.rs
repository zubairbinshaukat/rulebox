//! The pin file `apps/installer/webview2-bootstrapper.sha256` (Phase 6 Step 8). This one file is
//! compiled twice: by `build.rs`, which embeds the pinned hash into the agent, and by the agent's
//! own tests, so the build and the tests read the file the same way. `build.ps1` reads it the
//! same way too (comment lines start with `#`; the first other line starts with the 64-digit
//! SHA-256, optionally followed by the file name).

/// The pinned SHA-256 in lowercase, `Ok(None)` while the file holds only comments (nothing is
/// pinned yet), `Err` when the first line that is not a comment does not start with 64 hex digits.
pub fn parse_pin(text: &str) -> Result<Option<String>, String> {
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let first = line.split_whitespace().next().unwrap_or_default();
        if first.len() == 64 && first.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Ok(Some(first.to_ascii_lowercase()));
        }
        return Err(format!("expected a 64-digit SHA-256, found {first:?}"));
    }
    Ok(None)
}
