//! What the task commands do (plan Step 8). Everything here blocks on Win32
//! calls: run it from a worker thread (`spawn_blocking`), never from the
//! message loop or a UI thread.

use tauri::{AppHandle, Manager};

use rulebox_desktop::control;

use crate::appwin::{self, AppWindows};
use crate::launcher::{failure_notice, plan_launch, LaunchPlan};
use crate::model::NoticeTone;
use crate::state::AppState;
use crate::tasks::{click_action, plan_show_desktop, ClickAction, ShowDesktopPlan, TaskServices};

/// A click on a window's taskbar button: restore, minimize or focus.
pub fn click(services: &TaskServices, state: &AppState, id: &str) -> Result<(), String> {
    let (hwnd, facts) = services
        .registry
        .lookup(id)
        .ok_or_else(|| "that window is not listed".to_string())?;
    let action = click_action(facts.minimized, facts.active);
    let result = match action {
        ClickAction::Restore => control::restore(hwnd).map(|()| None),
        ClickAction::Minimize => control::minimize(hwnd).map(|()| None),
        ClickAction::Focus => control::activate(hwnd).map(Some),
    };
    match result {
        Ok(Some(rung)) => {
            // Which rung worked is the answer to "is the foreground lock a
            // problem in the real shell?", so it is always logged.
            tracing::info!(?rung, "window activated");
            Ok(())
        }
        Ok(None) => Ok(()),
        Err(error) => {
            tracing::warn!(%error, ?action, "task click failed");
            state.notify(
                NoticeTone::Neutral,
                "That window could not be brought forward.",
                None,
            );
            Err(error.to_string())
        }
    }
}

/// Close a window the way its own close button would.
pub fn close(services: &TaskServices, state: &AppState, id: &str) -> Result<(), String> {
    let (hwnd, _) = services
        .registry
        .lookup(id)
        .ok_or_else(|| "that window is not listed".to_string())?;
    control::close(hwnd).map_err(|error| {
        state.notify(
            NoticeTone::Warning,
            "That window could not be closed.",
            Some(error.to_string()),
        );
        error.to_string()
    })
}

/// End the program of a window that is not responding. Refused for any
/// window that is responding (checked again live) and for our own windows.
pub fn end(services: &TaskServices, state: &AppState, id: &str) -> Result<(), String> {
    let (hwnd, facts) = services
        .registry
        .lookup(id)
        .ok_or_else(|| "that window is not listed".to_string())?;
    if facts.own {
        return Err("Rulebox's own windows are not ended this way".into());
    }
    if !facts.hung || !control::is_hung(hwnd) {
        return Err("the program is responding".into());
    }
    control::end_process(facts.pid).map_err(|error| {
        state.notify(
            NoticeTone::Warning,
            "That app could not be ended.",
            Some(error.to_string()),
        );
        error.to_string()
    })
}

/// Minimize everything; the next call restores what this one minimized.
pub fn show_desktop(services: &TaskServices) {
    let listed = services.registry.listed();
    let remembered = services.registry.desktop_minimized();
    match plan_show_desktop(&remembered, &listed) {
        ShowDesktopPlan::Minimize(windows) => {
            for hwnd in &windows {
                if let Err(error) = control::minimize(*hwnd) {
                    tracing::debug!(%error, hwnd, "show desktop: could not minimize");
                }
            }
            services.registry.set_desktop_minimized(windows);
        }
        ShowDesktopPlan::Restore(windows) => {
            for hwnd in &windows {
                if let Err(error) = control::restore(*hwnd) {
                    tracing::debug!(%error, hwnd, "show desktop: could not restore");
                }
            }
            services.registry.set_desktop_minimized(Vec::new());
        }
    }
}

/// Open an app from the catalogue: focus it when it is open, else start it.
pub fn launch(app: &AppHandle, services: &TaskServices, state: &AppState, id: &str) {
    let (catalogue, tasks, closing) =
        state.read(|s| (s.apps.items.clone(), s.tasks.clone(), s.banner.is_some()));
    let name = catalogue
        .iter()
        .find(|app| app.id == id)
        .map_or_else(|| "That app".to_string(), |app| app.name.clone());

    match plan_launch(&catalogue, id, &tasks, closing) {
        LaunchPlan::Focus { task_id } => {
            if let Some((hwnd, _)) = services.registry.lookup(&task_id) {
                match control::activate(hwnd) {
                    Ok(rung) => tracing::info!(?rung, app = id, "open app focused"),
                    Err(error) => {
                        tracing::warn!(%error, app = id, "could not focus the open app");
                        state.notify(
                            NoticeTone::Neutral,
                            format!("{name} could not be brought forward."),
                            None,
                        );
                    }
                }
            }
        }
        LaunchPlan::Start { exe, args } => match services.launcher.start(id, &exe, &args) {
            Ok(pid) => tracing::info!(app = id, pid, "app started"),
            Err(error) => {
                tracing::warn!(%error, app = id, "app launch failed");
                let (title, detail) = failure_notice(&name, &error);
                state.notify(NoticeTone::Warning, title, detail);
            }
        },
        LaunchPlan::OpenBuiltin { tool } => match tool {
            crate::model::BuiltinTool::Files => {
                let host = app.state::<std::sync::Arc<AppWindows>>();
                if let Err(error) = appwin::open_files(&host, app, state) {
                    if error != "close a tab first" {
                        tracing::warn!(%error, app = id, "built-in window failed");
                        state.notify(
                            NoticeTone::Warning,
                            format!("{name} could not be opened."),
                            Some(error),
                        );
                    }
                }
            }
        },
        LaunchPlan::NotYet => state.notify(
            NoticeTone::Neutral,
            "Not available yet",
            Some("This kind of app arrives in a later step.".into()),
        ),
        LaunchPlan::Unknown => state.notify(
            NoticeTone::Warning,
            "That app is not available.",
            Some("Ask your administrator.".into()),
        ),
        LaunchPlan::Closing => state.notify(
            NoticeTone::Neutral,
            "Rulebox is closing",
            Some("New apps can't be opened right now.".into()),
        ),
    }
}
