//! Tauri commands of the files backend. Every path is relative to the
//! employee's folder; the window label decides who may call what.

use std::sync::Arc;

use serde::Serialize;
use tauri::{Emitter, State, Window};
use ts_rs::TS;

use super::preview::{self, CsvPreview, ImageInfo, TextPreview};
use super::saferoot::{Entry, EntryKind, FileError, RelPath, TrashItem};
use super::types::{check_content, extension, opener_for, Opener, ViewerKind};
use super::{openwith, Clip, ClipOp, Emit, FileSession, PasteResult, Usage};
use crate::state::AppState;
use crate::tasks::TaskServices;

/// What the caller should do after `fs_open`.
#[derive(Serialize, Clone, Debug, PartialEq, Eq, TS)]
#[serde(tag = "action", rename_all = "camelCase", rename_all_fields = "camelCase")]
#[ts(export)]
pub enum OpenAction {
    /// Open this file in a viewer window (`open_doc`).
    Viewer { kind: ViewerKind, path: String },
    /// A handler app was started with the file.
    Launched { app_name: String },
    /// "This type of file can't be opened on this PC."
    Blocked,
    /// "No app on this PC can open .xyz files."
    NoHandler { extension: String },
}

/// `shell_too`: the desktop panel and Start menu may call it as well.
fn allow(window: &Window, shell_too: bool) -> Result<(), FileError> {
    let label = window.label();
    if label.starts_with("app-") || (shell_too && label.starts_with("shell-")) {
        Ok(())
    } else {
        Err(FileError::NotSignedIn)
    }
}

fn session_of(state: &AppState) -> Result<Arc<FileSession>, FileError> {
    state.files().session().ok_or(FileError::NotSignedIn)
}

async fn run<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, FileError> + Send + 'static,
) -> Result<T, FileError> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| FileError::Io {
            message: error.to_string(),
        })?
}

/// The file for a viewer command: its type must be one of `kinds` and its
/// bytes must match.
fn viewer_file(
    state: &AppState,
    session: &FileSession,
    path: &str,
    kinds: &[ViewerKind],
) -> Result<std::fs::File, FileError> {
    let rel = RelPath::parse(path)?;
    let leaf = rel.leaf().ok_or(FileError::NotFound)?;
    match opener_for(leaf, &state.files().handlers()) {
        Opener::Viewer(kind) if kinds.contains(&kind) => {}
        _ => return Err(FileError::BlockedType),
    }
    check_content(leaf, &session.root().read_head(&rel, 8192)?)?;
    session.root().open_read(&rel)
}

#[tauri::command]
pub async fn fs_list(
    window: Window,
    state: State<'_, AppState>,
    path: String,
) -> Result<Vec<Entry>, FileError> {
    allow(&window, true)?;
    let session = session_of(&state)?;
    run(move || session.root().list(&RelPath::parse(&path)?)).await
}

#[tauri::command]
pub async fn fs_stat(
    window: Window,
    state: State<'_, AppState>,
    path: String,
) -> Result<Entry, FileError> {
    allow(&window, false)?;
    let session = session_of(&state)?;
    run(move || session.root().stat(&RelPath::parse(&path)?)).await
}

#[tauri::command]
pub async fn fs_mkdir(
    window: Window,
    state: State<'_, AppState>,
    path: String,
) -> Result<(), FileError> {
    allow(&window, false)?;
    let session = session_of(&state)?;
    run(move || session.mkdir(&RelPath::parse(&path)?)).await
}

#[tauri::command]
pub async fn fs_rename(
    window: Window,
    state: State<'_, AppState>,
    from: String,
    to: String,
) -> Result<(), FileError> {
    allow(&window, false)?;
    let session = session_of(&state)?;
    run(move || session.rename(&RelPath::parse(&from)?, &RelPath::parse(&to)?)).await
}

/// Returns the path of the new copy.
#[tauri::command]
pub async fn fs_copy(
    window: Window,
    state: State<'_, AppState>,
    from: String,
    to_dir: String,
) -> Result<String, FileError> {
    allow(&window, false)?;
    let session = session_of(&state)?;
    run(move || {
        let created = session.copy(&RelPath::parse(&from)?, &RelPath::parse(&to_dir)?)?;
        Ok(created.as_string())
    })
    .await
}

/// Returns the new path.
#[tauri::command]
pub async fn fs_move(
    window: Window,
    state: State<'_, AppState>,
    from: String,
    to_dir: String,
) -> Result<String, FileError> {
    allow(&window, false)?;
    let session = session_of(&state)?;
    run(move || {
        let moved = session.move_to(&RelPath::parse(&from)?, &RelPath::parse(&to_dir)?)?;
        Ok(moved.as_string())
    })
    .await
}

/// Delete. Into the trash, or for good when `permanent` (Shift+Delete, after a confirmation).
#[tauri::command]
pub async fn fs_trash(
    window: Window,
    state: State<'_, AppState>,
    path: String,
    permanent: bool,
) -> Result<(), FileError> {
    allow(&window, false)?;
    let session = session_of(&state)?;
    run(move || session.delete(&RelPath::parse(&path)?, permanent)).await
}

/// What is in the trash, newest first.
#[tauri::command]
pub async fn fs_trash_list(
    window: Window,
    state: State<'_, AppState>,
) -> Result<Vec<TrashItem>, FileError> {
    allow(&window, false)?;
    let session = session_of(&state)?;
    run(move || Ok(session.trash_list())).await
}

/// Returns where the item went back to.
#[tauri::command]
pub async fn fs_restore(
    window: Window,
    state: State<'_, AppState>,
    id: String,
) -> Result<String, FileError> {
    allow(&window, false)?;
    let session = session_of(&state)?;
    run(move || Ok(session.restore(&id)?.as_string())).await
}

/// One item for good, or `None` to empty the trash.
#[tauri::command]
pub async fn fs_purge(
    window: Window,
    state: State<'_, AppState>,
    id: Option<String>,
) -> Result<(), FileError> {
    allow(&window, false)?;
    let session = session_of(&state)?;
    run(move || session.purge(id.as_deref())).await
}

#[tauri::command]
pub async fn fs_usage(window: Window, state: State<'_, AppState>) -> Result<Usage, FileError> {
    allow(&window, false)?;
    Ok(session_of(&state)?.usage())
}

/// Starts a search. Batches arrive as `files://search { searchId, hits, done }`
/// on the calling window. A newer search, or an empty query, cancels this one.
#[tauri::command]
pub async fn fs_search(
    window: Window,
    state: State<'_, AppState>,
    query: String,
    search_id: u64,
) -> Result<(), FileError> {
    allow(&window, true)?;
    let session = session_of(&state)?;
    let target = window.clone();
    let send: Emit = Arc::new(move |event, payload| {
        // Only to the window that asked: `emit` on a window reaches all of them.
        let _ = target.emit_to(target.label(), event, payload);
    });
    session.start_search(search_id, query, send);
    Ok(())
}

/// Put paths on the file clipboard (`copy` or `cut`). An empty list clears it.
#[tauri::command]
pub async fn fs_clip_set(
    window: Window,
    state: State<'_, AppState>,
    op: ClipOp,
    paths: Vec<String>,
) -> Result<(), FileError> {
    allow(&window, false)?;
    let session = session_of(&state)?;
    run(move || session.set_clip(op, paths)).await
}

#[tauri::command]
pub async fn fs_clip_get(
    window: Window,
    state: State<'_, AppState>,
) -> Result<Option<Clip>, FileError> {
    allow(&window, false)?;
    Ok(session_of(&state)?.clip())
}

/// Paste the clipboard into a folder. Reports each item; one failure does not stop the rest.
#[tauri::command]
pub async fn fs_paste(
    window: Window,
    state: State<'_, AppState>,
    to_dir: String,
) -> Result<PasteResult, FileError> {
    allow(&window, false)?;
    let session = session_of(&state)?;
    run(move || session.paste(&RelPath::parse(&to_dir)?)).await
}

/// The app "Open with" would use for this file, or nothing.
#[tauri::command]
pub async fn fs_handler(
    window: Window,
    state: State<'_, AppState>,
    path: String,
) -> Result<Option<String>, FileError> {
    allow(&window, false)?;
    let state = state.inner().clone();
    run(move || {
        let rel = RelPath::parse(&path)?;
        Ok(rel.leaf().and_then(|leaf| openwith::handler_name(&state, leaf)))
    })
    .await
}

/// Files opened since sign-in, newest first.
#[tauri::command]
pub async fn fs_recent(window: Window, state: State<'_, AppState>) -> Result<Vec<Entry>, FileError> {
    allow(&window, true)?;
    let session = session_of(&state)?;
    run(move || Ok(session.recent())).await
}

/// Decides what opening a file means, and starts a handler app when that is it.
#[tauri::command]
pub async fn fs_open(
    window: Window,
    state: State<'_, AppState>,
    services: State<'_, TaskServices>,
    path: String,
) -> Result<OpenAction, FileError> {
    allow(&window, true)?;
    let session = session_of(&state)?;
    let from_shell = window.label().starts_with("shell-");
    let (state, services) = (state.inner().clone(), services.inner().clone());
    let notify_state = state.clone();
    let action = run(move || {
        let rel = RelPath::parse(&path)?;
        let entry = session.root().stat(&rel)?;
        if entry.kind != EntryKind::File {
            return Err(FileError::Io {
                message: "That is a folder.".into(),
            });
        }
        match opener_for(&entry.name, &state.files().handlers()) {
            Opener::Blocked => Ok(OpenAction::Blocked),
            Opener::None => Ok(OpenAction::NoHandler {
                extension: extension(&entry.name).unwrap_or_default(),
            }),
            Opener::Viewer(kind) => {
                match check_content(&entry.name, &session.root().read_head(&rel, 8192)?) {
                    Err(FileError::BlockedType) => Ok(OpenAction::Blocked),
                    Err(other) => Err(other),
                    Ok(()) => {
                        session.remember(&rel);
                        Ok(OpenAction::Viewer {
                            kind,
                            path: rel.as_string(),
                        })
                    }
                }
            }
            Opener::Handler { .. } => match openwith::open_with(&session, &state, &services, &rel) {
                Ok(app_name) => {
                    session.remember(&rel);
                    Ok(OpenAction::Launched { app_name })
                }
                Err(FileError::BlockedType) => Ok(OpenAction::Blocked),
                Err(other) => Err(other),
            },
        }
    })
    .await?;
    // The desktop and Start menu have no dialogs: tell the person with a notice.
    if from_shell {
        match &action {
            OpenAction::Blocked => notify_state.notify(
                crate::model::NoticeTone::Warning,
                "This type of file can't be opened on this PC.",
                None,
            ),
            OpenAction::NoHandler { extension } => notify_state.notify(
                crate::model::NoticeTone::Neutral,
                if extension.is_empty() {
                    "No app on this PC can open that file.".to_string()
                } else {
                    format!("No app on this PC can open .{extension} files.")
                },
                None,
            ),
            _ => {}
        }
    }
    Ok(action)
}

/// The "Open with <app>" action: the handler app, even when a viewer exists.
#[tauri::command]
pub async fn fs_open_with(
    window: Window,
    state: State<'_, AppState>,
    services: State<'_, TaskServices>,
    path: String,
) -> Result<OpenAction, FileError> {
    allow(&window, false)?;
    let session = session_of(&state)?;
    let (state, services) = (state.inner().clone(), services.inner().clone());
    run(move || {
        let rel = RelPath::parse(&path)?;
        match openwith::open_with(&session, &state, &services, &rel) {
            Ok(app_name) => {
                session.remember(&rel);
                Ok(OpenAction::Launched { app_name })
            }
            Err(FileError::BlockedType) => Ok(OpenAction::Blocked),
            Err(other) => Err(other),
        }
    })
    .await
}

#[tauri::command]
pub async fn fs_read_text(
    window: Window,
    state: State<'_, AppState>,
    path: String,
) -> Result<TextPreview, FileError> {
    allow(&window, false)?;
    let session = session_of(&state)?;
    let state = state.inner().clone();
    run(move || {
        preview::read_text(
            viewer_file(&state, &session, &path, &[ViewerKind::Text])?,
            preview::TEXT_LIMIT,
        )
    })
    .await
}

#[tauri::command]
pub async fn fs_read_csv(
    window: Window,
    state: State<'_, AppState>,
    path: String,
) -> Result<CsvPreview, FileError> {
    allow(&window, false)?;
    let session = session_of(&state)?;
    let state = state.inner().clone();
    run(move || preview::read_csv(viewer_file(&state, &session, &path, &[ViewerKind::Csv])?)).await
}

/// Size and zip checks for DOCX and XLSX before the viewer loads them.
#[tauri::command]
pub async fn fs_office_check(
    window: Window,
    state: State<'_, AppState>,
    path: String,
) -> Result<(), FileError> {
    allow(&window, false)?;
    let session = session_of(&state)?;
    let state = state.inner().clone();
    run(move || {
        preview::office_precheck(viewer_file(
            &state,
            &session,
            &path,
            &[ViewerKind::Docx, ViewerKind::Xlsx],
        )?)
    })
    .await
}

/// Pixel size of an image; over 40 megapixels is refused as too large.
#[tauri::command]
pub async fn fs_image_info(
    window: Window,
    state: State<'_, AppState>,
    path: String,
) -> Result<ImageInfo, FileError> {
    allow(&window, false)?;
    let session = session_of(&state)?;
    let state = state.inner().clone();
    run(move || {
        let rel = RelPath::parse(&path)?;
        viewer_file(&state, &session, &path, &[ViewerKind::Image])?;
        preview::image_info(&session.root().read_head(&rel, 64 * 1024)?)
    })
    .await
}
