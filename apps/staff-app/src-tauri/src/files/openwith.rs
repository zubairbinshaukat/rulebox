//! "Open with": hand one file to an approved app from the catalogue (plan
//! Step 12). Never `ShellExecute`, never a shell, never Windows' default
//! file associations: the app comes from `fileHandlers`, the program path
//! from the catalogue, and the file path from the checked folder handle.

use std::collections::BTreeMap;
use std::path::Path;

use super::saferoot::{FileError, RelPath};
use super::types::{check_content, extension, DENY};
use super::FileSession;
use crate::model::{AppKind, DesktopApp};
use crate::state::AppState;
use crate::tasks::TaskServices;

/// The app `fileHandlers` names for this file, unless the type is on the
/// deny-list. A built-in viewer does not matter here: "Open with" is a
/// separate action from "Open".
pub fn handler_app_id(name: &str, handlers: &BTreeMap<String, String>) -> Option<String> {
    let ext = extension(name)?;
    if DENY.binary_search(&ext.as_str()).is_ok() {
        return None;
    }
    let key = format!(".{ext}");
    handlers
        .iter()
        .find(|(candidate, _)| candidate.to_lowercase() == key)
        .map(|(_, app_id)| app_id.clone())
}

/// The name of the app "Open with" would start for this file, if there is one
/// in the catalogue. Drives the context-menu item.
pub fn handler_name(state: &AppState, name: &str) -> Option<String> {
    let app_id = handler_app_id(name, &state.files().handlers())?;
    state.read(|shell| {
        shell
            .apps
            .items
            .iter()
            .find(|app| app.id == app_id && matches!(app.kind, AppKind::Desktop(_)))
            .map(|app| app.name.clone())
    })
}

/// The command line: the app's own arguments, then its file template with
/// `{file}` replaced. `{file}` must be a whole token, so a path can never be
/// glued onto another argument (`--out={file}`) or split into two.
pub fn build_args(app: &DesktopApp, file: &str) -> Result<Vec<String>, FileError> {
    if app.file_arg_template.is_empty() {
        return Err(FileError::Io {
            message: "This app can't open files.".into(),
        });
    }
    let mut args = app.args.clone();
    for token in &app.file_arg_template {
        if token == "{file}" {
            args.push(file.to_string());
        } else if token.contains("{file}") || (token.contains('{') && token.contains('}')) {
            return Err(FileError::Io {
                message: "This app's file settings are not valid.".into(),
            });
        } else {
            args.push(token.clone());
        }
    }
    Ok(args)
}

/// Start the handler app with the file. Returns the app's name.
pub fn open_with(
    session: &FileSession,
    state: &AppState,
    services: &TaskServices,
    path: &RelPath,
) -> Result<String, FileError> {
    let leaf = path.leaf().ok_or(FileError::NotFound)?;
    let app_id = handler_app_id(leaf, &state.files().handlers()).ok_or(FileError::BlockedType)?;
    let catalogue = state.read(|shell| shell.apps.items.clone());
    let app = catalogue
        .iter()
        .find(|app| app.id == app_id)
        .ok_or(FileError::NotFound)?;
    let AppKind::Desktop(desktop) = &app.kind else {
        return Err(FileError::Io {
            message: "That app can't open files.".into(),
        });
    };
    check_content(leaf, &session.root().read_head(path, 8192)?)?;
    let absolute = session.root().absolute_for_launch(path)?;
    let args = build_args(desktop, &absolute.to_string_lossy())?;
    services
        .launcher
        .start(&app.id, Path::new(&desktop.exe), &args)
        .map_err(|error| FileError::Io {
            message: error.to_string(),
        })?;
    Ok(app.name.clone())
}
