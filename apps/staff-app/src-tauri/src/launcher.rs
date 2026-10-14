//! Launching catalogue apps as the Staff user (plan Step 8).
//!
//! React sends an app id, never a path. The program path comes only from the
//! catalogue the agent supplied. A second launch of an app that is already
//! open focuses its window instead of starting another copy.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use rulebox_desktop::launch::{self, JobHandle, Launched};
use rulebox_desktop::DesktopError;

use crate::model::{AppEntry, AppKind, TaskItem};

/// What `launch_app(id)` should do. Pure, so every rule is tested.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LaunchPlan {
    /// The app is open: bring this window forward.
    Focus { task_id: String },
    /// Start the program.
    Start { exe: PathBuf, args: Vec<String> },
    /// Built-in tools and web apps arrive in later steps.
    NotYet,
    /// The id is not in the catalogue.
    Unknown,
    /// Not now (Rulebox is closing).
    Closing,
}

/// Decide what launching `id` means. `tasks` are the windows now open;
/// `closing` is true while the agent has announced a shutdown.
pub fn plan_launch(
    catalogue: &[AppEntry],
    id: &str,
    tasks: &[TaskItem],
    closing: bool,
) -> LaunchPlan {
    if closing {
        return LaunchPlan::Closing;
    }
    let Some(app) = catalogue.iter().find(|app| app.id == id) else {
        return LaunchPlan::Unknown;
    };
    match &app.kind {
        AppKind::Builtin { .. } | AppKind::Web(_) => LaunchPlan::NotYet,
        AppKind::Desktop(desktop) => {
            let open: Vec<&TaskItem> = tasks
                .iter()
                .filter(|task| task.app_id.as_deref() == Some(id))
                .collect();
            // The window that has the focus, else the first one.
            let target = open.iter().find(|task| task.active).or_else(|| open.first());
            match target {
                Some(task) => LaunchPlan::Focus {
                    task_id: task.id.clone(),
                },
                None => LaunchPlan::Start {
                    exe: PathBuf::from(&desktop.exe),
                    args: desktop.args.clone(),
                },
            }
        }
    }
}

/// The notice a failed launch turns into: `(title, detail)`.
pub fn failure_notice(app_name: &str, error: &DesktopError) -> (String, Option<String>) {
    match error {
        DesktopError::NeedsElevation => (
            format!("{app_name} could not be opened."),
            Some("This app needs administrator rights and can't be opened here.".into()),
        ),
        DesktopError::Refused(reason) if reason.contains("not found") => (
            format!("{app_name} could not be opened."),
            Some("The program was not found on this PC.".into()),
        ),
        DesktopError::Refused(reason) => (
            format!("{app_name} could not be opened."),
            Some(reason.clone()),
        ),
        other => (
            format!("{app_name} could not be opened."),
            Some(format!("Windows reported: {other}")),
        ),
    }
}

/// How long after a launch a new window of the same program counts as the
/// launched app's. Covers programs that hand off to another process (the
/// Windows 11 `notepad.exe` is a stub that starts the packaged Notepad and
/// exits), whose window is then not in the launched job.
pub const ADOPT_WINDOW: Duration = Duration::from_secs(10);

/// The app a new window of `window_exe_name` belongs to, among apps launched
/// recently: `(app id, program file name, time since launch)`. The newest
/// launch wins. Pure, so the rule is tested.
pub fn adoption_target(
    launches: &[(String, Option<String>, Duration)],
    window_exe_name: &str,
) -> Option<String> {
    launches
        .iter()
        .filter(|(_, name, age)| {
            *age < ADOPT_WINDOW
                && name
                    .as_deref()
                    .is_some_and(|name| name.eq_ignore_ascii_case(window_exe_name))
        })
        .min_by_key(|(_, _, age)| *age)
        .map(|(app_id, _, _)| app_id.clone())
}

struct Running {
    app_id: String,
    /// The program's file name, for adopting a hand-off window.
    exe_name: Option<String>,
    started: Instant,
    job: JobHandle,
}

/// The programs this shell started, each in its own job object.
#[derive(Default)]
pub struct Launcher {
    running: Mutex<Vec<Running>>,
    /// Processes adopted as an app's by name: `(pid, app id)`.
    adopted: Mutex<Vec<(u32, String)>>,
}

impl Launcher {
    /// Start `exe` and remember its job.
    pub fn start(&self, app_id: &str, exe: &std::path::Path, args: &[String]) -> Result<u32, DesktopError> {
        let Launched { pid, job } = launch::launch(exe, args)?;
        self.running
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(Running {
                app_id: app_id.to_string(),
                exe_name: exe
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned()),
                started: Instant::now(),
                job,
            });
        Ok(pid)
    }

    /// A new window appeared for process `pid` running `exe`. If it is not
    /// in a launched job but its program has the name of an app launched a
    /// moment ago, count it as that app's.
    pub fn adopt(&self, pid: u32, exe: Option<&Path>) {
        let Some(window_name) = exe.and_then(Path::file_name) else {
            return;
        };
        let window_name = window_name.to_string_lossy();
        let (launches, in_job) = {
            let running = self.running.lock().unwrap_or_else(|e| e.into_inner());
            let in_job = running
                .iter()
                .any(|entry| launch::job_pids(&entry.job).contains(&pid));
            let launches: Vec<(String, Option<String>, Duration)> = running
                .iter()
                .map(|entry| {
                    (
                        entry.app_id.clone(),
                        entry.exe_name.clone(),
                        entry.started.elapsed(),
                    )
                })
                .collect();
            (launches, in_job)
        };
        if in_job {
            return;
        }
        let Some(app_id) = adoption_target(&launches, &window_name) else {
            return;
        };
        let mut adopted = self.adopted.lock().unwrap_or_else(|e| e.into_inner());
        if !adopted.iter().any(|(known, _)| *known == pid) {
            tracing::info!(pid, app = %app_id, "window adopted as the launched app's");
            adopted.push((pid, app_id));
        }
    }

    /// Process id → catalogue app id, for every process still in a job the
    /// shell created and every adopted process that still has a window
    /// (`live_pids`). Emptied jobs and gone processes are dropped.
    pub fn pid_map(&self, live_pids: &HashSet<u32>) -> HashMap<u32, String> {
        let mut map = HashMap::new();
        {
            let mut running = self.running.lock().unwrap_or_else(|e| e.into_inner());
            running.retain(|entry| {
                let pids = launch::job_pids(&entry.job);
                for pid in &pids {
                    map.insert(*pid, entry.app_id.clone());
                }
                // A job that has emptied is kept for a moment: a hand-off
                // program's window may still be about to appear.
                !pids.is_empty() || entry.started.elapsed() < ADOPT_WINDOW
            });
        }
        let mut adopted = self.adopted.lock().unwrap_or_else(|e| e.into_inner());
        adopted.retain(|(pid, _)| live_pids.contains(pid));
        for (pid, app_id) in adopted.iter() {
            map.insert(*pid, app_id.clone());
        }
        map
    }
}
