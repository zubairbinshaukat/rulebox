//! Thin `#[tauri::command]` wrappers. Every command checks the caller's
//! window label prefix before doing anything.

#![allow(dead_code)] // helpers land before the first real commands (Step 3)

use tauri::Window;

/// Why a command refused to run.
#[derive(Debug, thiserror::Error)]
pub enum CommandError {
    #[error("forbidden")]
    Forbidden,
}

impl serde::Serialize for CommandError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(self.to_string().as_ref())
    }
}

/// Return `Forbidden` unless the window label starts with `prefix`
/// (`"shell-"` or `"app-"`).
pub fn require_label(window: &Window, prefix: &str) -> Result<(), CommandError> {
    if window.label().starts_with(prefix) {
        Ok(())
    } else {
        Err(CommandError::Forbidden)
    }
}
