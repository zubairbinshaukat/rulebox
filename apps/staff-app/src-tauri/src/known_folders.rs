//! Sends Documents, Desktop and Downloads of the Windows account into the
//! signed-in employee's folder, and puts them back afterwards.
//!
//! Desktop apps such as Notepad save to the account's known folders, so
//! without this the employee would never find those files in Rulebox and the
//! next employee could see them. The Win32 work is in
//! `rulebox_desktop::known_folders`; this module decides when it runs and
//! makes the subfolders through the safe file layer (links are refused).
//!
//! Nothing here changes anything in dev mode: there is no `ShellToken`.
//! Every function blocks briefly, so callers run them on a worker thread.

use std::sync::{Arc, Mutex, Once};

use rulebox_desktop::known_folders::{self as kf, KnownFolder, Redirect, Report};
use rulebox_desktop::ShellToken;
use tauri::{AppHandle, Manager};

use crate::files::saferoot::{EntryKind, FileError, RelPath, SafeRoot};
use crate::shellwin::DesktopHost;

/// Whether the start-up restore has run. The lock is held for the whole of
/// every change, so a sign-in can never be undone by a late start-up restore
/// and two changes never overlap.
static CHANGES: Mutex<bool> = Mutex::new(false);
static DEV_NOTE: Once = Once::new();

/// Make sure `name` exists in the employee's folder as a real folder (not a
/// link, not a file).
fn ensure_folder(root: &SafeRoot, name: &str) -> Result<(), FileError> {
    let path = RelPath::parse(name)?;
    match root.mkdir(&path) {
        Ok(()) => Ok(()),
        Err(FileError::Exists) => match root.stat(&path)?.kind {
            EntryKind::Folder => Ok(()),
            EntryKind::File => Err(FileError::Exists),
        },
        Err(other) => Err(other),
    }
}

/// Create the three subfolders in the employee's folder and return the
/// redirects that are safe to apply. A folder that cannot be made (a file
/// with that name, a link) is left out and reported, so it stays at the
/// account's default instead of pointing somewhere unsafe.
pub fn prepare(root: &SafeRoot) -> (Vec<Redirect>, Vec<(KnownFolder, FileError)>) {
    let mut ready = Vec::new();
    let mut refused = Vec::new();
    for item in kf::plan(root.root_path()) {
        match ensure_folder(root, item.folder.dir_name()) {
            Ok(()) => ready.push(item),
            Err(error) => refused.push((item.folder, error)),
        }
    }
    (ready, refused)
}

fn log_report(what: &str, report: &Report) {
    if !report.changed.is_empty() {
        tracing::info!(what, folders = ?report.changed, "known folders changed");
    }
    for (folder, reason) in &report.failed {
        tracing::warn!(what, ?folder, reason, "a known folder could not be changed");
    }
}

/// Run `work` with the shell token, or note once (and do nothing) when there
/// is none: dev mode, or no desktop host yet.
fn with_token<R>(app: Option<&AppHandle>, work: impl FnOnce(&ShellToken) -> R) -> Option<R> {
    let host = app.and_then(|app| app.try_state::<Arc<DesktopHost>>());
    let result = host.as_ref().and_then(|host| host.with_shell_token(work));
    if result.is_none() {
        DEV_NOTE.call_once(|| tracing::info!("dev mode: known folders are not redirected"));
    }
    result
}

fn restore_now(token: &ShellToken) {
    match kf::restore_defaults(token) {
        Ok(report) => log_report("restore", &report),
        Err(error) => tracing::warn!(%error, "could not restore the known folders"),
    }
}

/// Point the account's Documents, Desktop and Downloads at the employee's
/// folder. Call after the files session has opened. Never fails sign-in.
pub fn redirect_for_employee(app: Option<&AppHandle>, root: &SafeRoot) {
    let mut restored = CHANGES.lock().unwrap_or_else(|e| e.into_inner());
    with_token(app, |token| {
        if !*restored {
            // The app may have crashed under the last employee: start clean.
            restore_now(token);
            *restored = true;
        }
        let (ready, refused) = prepare(root);
        for (folder, error) in &refused {
            tracing::warn!(?folder, %error, "no folder for this employee; Windows default kept");
        }
        log_report("redirect", &kf::redirect(token, &ready));
    });
}

/// Give the account its own folders back. Used at sign-out and once at
/// start-up. Safe to repeat; failures are logged and never stop the caller.
pub fn restore(app: Option<&AppHandle>) {
    let mut restored = CHANGES.lock().unwrap_or_else(|e| e.into_inner());
    with_token(app, |token| {
        restore_now(token);
        *restored = true;
    });
}
