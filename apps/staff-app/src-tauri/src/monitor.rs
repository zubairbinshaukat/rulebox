//! The developer resource monitor (debug builds only): every two seconds,
//! system CPU and memory and what each part of Rulebox and each app uses,
//! sent as `monitor://sample` to the taskbar (its chip) and the popup (the
//! detail). Never part of `ShellState`: fast-changing figures stay out of the
//! store every window subscribes to.
//!
//! Memory is the private working set, the figure Task Manager's "Memory"
//! column shows, so the numbers can be checked against it.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rulebox_desktop::procstats::{self, ProcInfo, SystemTimes};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use ts_rs::TS;

use crate::state::AppState;
use crate::tasks::TaskServices;
use crate::webapp::WebApps;

/// How often a sample is taken.
const PERIOD: Duration = Duration::from_secs(2);
/// How often the WebView2 browser process ids are asked for again.
const BROWSER_REFRESH: Duration = Duration::from_secs(6);
/// Other programs listed one by one; the rest are summed.
const TOP_OTHERS: usize = 5;
/// How far up the parent chain a process is followed to find its group.
const MAX_DEPTH: usize = 16;

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq, Hash, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum GroupKind {
    /// The Staff App, its helper and the WebView2 processes of the shell and built-in windows.
    Shell,
    WebApp,
    /// A desktop program started from the catalogue.
    App,
    Agent,
    /// The Phase 2 shell launcher.
    Launcher,
    Other,
}

#[derive(Serialize, Clone, Debug, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct UsageGroup {
    pub name: String,
    pub kind: GroupKind,
    pub processes: u32,
    /// Private working set, bytes. Processes that could not be read count as 0.
    #[ts(type = "number")]
    pub bytes: u64,
    pub cpu_percent: f32,
    /// Processes whose figures Windows would not give us (another user's, a
    /// service's): their memory is missing from `bytes`.
    pub unreadable: u32,
}

#[derive(Serialize, Clone, Debug, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MonitorSample {
    pub cpu_percent: f32,
    #[ts(type = "number")]
    pub mem_used: u64,
    #[ts(type = "number")]
    pub mem_total: u64,
    /// Everything Rulebox itself uses: shell, web apps, agent and launcher (not launched programs).
    #[ts(type = "number")]
    pub rulebox_bytes: u64,
    pub rulebox_cpu: f32,
    /// Largest first, Rulebox's own parts before other programs.
    pub groups: Vec<UsageGroup>,
}

/// What a process belongs to, when known directly (its subtree follows it).
pub type Roots = HashMap<u32, (GroupKind, String)>;

/// Pure: sort the processes into groups. `roots` names the processes whose
/// whole subtree belongs somewhere (the Staff App, each WebView2 browser,
/// each launched program); `cpu` holds each process's CPU percent.
pub fn build_groups(processes: &[ProcInfo], cpu: &HashMap<u32, f32>, roots: &Roots) -> Vec<UsageGroup> {
    let parent: HashMap<u32, u32> = processes.iter().map(|p| (p.pid, p.parent)).collect();
    let by_name = |exe: &str| -> Option<(GroupKind, String)> {
        match exe.to_ascii_lowercase().as_str() {
            "rulebox-agent.exe" => Some((GroupKind::Agent, "Rulebox agent".into())),
            "rulebox-shell.exe" => Some((GroupKind::Launcher, "Rulebox shell launcher".into())),
            _ => None,
        }
    };
    let owner = |pid: u32| -> Option<(GroupKind, String)> {
        let mut at = pid;
        for _ in 0..MAX_DEPTH {
            if let Some(found) = roots.get(&at) {
                return Some(found.clone());
            }
            match parent.get(&at) {
                Some(&up) if up != 0 && up != at => at = up,
                _ => break,
            }
        }
        None
    };

    let mut groups: HashMap<(GroupKind, String), UsageGroup> = HashMap::new();
    let mut others: Vec<UsageGroup> = Vec::new();
    for process in processes.iter().filter(|p| p.pid != 0) {
        let bytes = process.private_ws.unwrap_or(0);
        let unreadable = u32::from(process.private_ws.is_none());
        let percent = cpu.get(&process.pid).copied().unwrap_or(0.0);
        match owner(process.pid).or_else(|| by_name(&process.exe)) {
            Some((kind, name)) => {
                let group = groups.entry((kind, name.clone())).or_insert(UsageGroup {
                    name,
                    kind,
                    processes: 0,
                    bytes: 0,
                    cpu_percent: 0.0,
                    unreadable: 0,
                });
                group.processes += 1;
                group.bytes += bytes;
                group.cpu_percent += percent;
                group.unreadable += unreadable;
            }
            None => others.push(UsageGroup {
                name: process.exe.clone(),
                kind: GroupKind::Other,
                processes: 1,
                bytes,
                cpu_percent: percent,
                unreadable,
            }),
        }
    }

    // Other programs: one row per program name, the largest few, the rest summed.
    let mut by_program: HashMap<String, UsageGroup> = HashMap::new();
    for other in others {
        let entry = by_program.entry(other.name.to_ascii_lowercase()).or_insert(UsageGroup {
            processes: 0,
            bytes: 0,
            cpu_percent: 0.0,
            unreadable: 0,
            ..other.clone()
        });
        entry.processes += 1;
        entry.bytes += other.bytes;
        entry.cpu_percent += other.cpu_percent;
        entry.unreadable += other.unreadable;
    }
    let mut programs: Vec<UsageGroup> = by_program.into_values().collect();
    programs.sort_by(|a, b| b.bytes.cmp(&a.bytes).then_with(|| a.name.cmp(&b.name)));
    let rest: Vec<UsageGroup> = programs.split_off(programs.len().min(TOP_OTHERS));

    let mut out: Vec<UsageGroup> = groups.into_values().collect();
    let rank = |kind: GroupKind| match kind {
        GroupKind::Shell => 0,
        GroupKind::WebApp | GroupKind::App => 1,
        GroupKind::Agent | GroupKind::Launcher => 2,
        GroupKind::Other => 3,
    };
    out.sort_by(|a, b| rank(a.kind).cmp(&rank(b.kind)).then(b.bytes.cmp(&a.bytes)).then_with(|| a.name.cmp(&b.name)));
    out.extend(programs);
    if !rest.is_empty() {
        out.push(UsageGroup {
            name: "Everything else".into(),
            kind: GroupKind::Other,
            processes: rest.iter().map(|g| g.processes).sum(),
            bytes: rest.iter().map(|g| g.bytes).sum(),
            cpu_percent: rest.iter().map(|g| g.cpu_percent).sum(),
            unreadable: rest.iter().map(|g| g.unreadable).sum(),
        });
    }
    out
}

/// Pure: a process's CPU percent of the whole machine between two readings.
pub fn process_cpu(before_100ns: u64, after_100ns: u64, elapsed: Duration, cpus: usize) -> f32 {
    let wall = elapsed.as_secs_f64() * 1e7 * cpus.max(1) as f64;
    if wall <= 0.0 {
        return 0.0;
    }
    (after_100ns.saturating_sub(before_100ns) as f64 * 100.0 / wall).min(100.0) as f32
}

/// Start the sampler. Debug builds only: a release build has no monitor.
pub fn start(app: &AppHandle) {
    if !cfg!(debug_assertions) {
        return;
    }
    let browsers: Arc<Mutex<HashMap<u32, (GroupKind, String)>>> = Arc::default();
    let app = app.clone();
    std::thread::Builder::new()
        .name("dev-monitor".into())
        .spawn(move || run(&app, &browsers))
        .map(|_| tracing::info!("developer resource monitor running (debug build)"))
        .unwrap_or_else(|error| tracing::warn!(%error, "could not start the resource monitor"));
}

/// One line per sample in `metrics.jsonl` next to the log, so a run can be
/// measured without looking at the screen (a fresh file every start).
fn open_metrics() -> Option<std::fs::File> {
    let dir = crate::logging::log_dir()?;
    std::fs::create_dir_all(&dir).ok()?;
    std::fs::File::create(dir.join("metrics.jsonl")).ok()
}

fn write_metrics(file: &mut std::fs::File, started: Instant, sample: &MonitorSample) {
    use std::io::Write;
    let line = serde_json::json!({
        "t": started.elapsed().as_secs(),
        "cpu": sample.cpu_percent,
        "memUsed": sample.mem_used,
        "rulebox": sample.rulebox_bytes,
        "ruleboxCpu": sample.rulebox_cpu,
        "groups": sample.groups.iter().map(|g| serde_json::json!({
            "name": g.name, "kind": g.kind, "n": g.processes, "bytes": g.bytes, "cpu": g.cpu_percent,
        })).collect::<Vec<_>>(),
    });
    let _ = writeln!(file, "{line}");
}

fn run(app: &AppHandle, browsers: &Arc<Mutex<HashMap<u32, (GroupKind, String)>>>) {
    let cpus = std::thread::available_parallelism().map_or(1, usize::from);
    let started = Instant::now();
    let mut metrics = open_metrics();
    let mut last_times: Option<(Instant, SystemTimes, HashMap<u32, u64>)> = None;
    let mut last_browser_refresh: Option<Instant> = None;
    loop {
        if last_browser_refresh.is_none_or(|at| at.elapsed() >= BROWSER_REFRESH) {
            refresh_browsers(app, browsers);
            last_browser_refresh = Some(Instant::now());
        }
        let now = Instant::now();
        let processes = procstats::processes();
        let system = procstats::system_times().unwrap_or_default();
        let times: HashMap<u32, u64> = processes.iter().filter_map(|p| Some((p.pid, p.cpu_100ns?))).collect();

        if let Some((then, system_then, times_then)) = &last_times {
            let elapsed = now.duration_since(*then);
            let cpu: HashMap<u32, f32> = times
                .iter()
                .filter_map(|(pid, after)| {
                    let before = times_then.get(pid)?;
                    Some((*pid, process_cpu(*before, *after, elapsed, cpus)))
                })
                .collect();
            let roots = roots(app, browsers);
            let groups = build_groups(&processes, &cpu, &roots);
            let ours = |g: &&UsageGroup| !matches!(g.kind, GroupKind::App | GroupKind::Other);
            let (total, available) = procstats::memory().unwrap_or((0, 0));
            let sample = MonitorSample {
                cpu_percent: procstats::cpu_percent(*system_then, system),
                mem_used: total.saturating_sub(available),
                mem_total: total,
                rulebox_bytes: groups.iter().filter(ours).map(|g| g.bytes).sum(),
                rulebox_cpu: groups.iter().filter(ours).map(|g| g.cpu_percent).sum(),
                groups,
            };
            if let Some(file) = metrics.as_mut() {
                write_metrics(file, started, &sample);
            }
            for label in [crate::shellwin::TASKBAR, crate::shellwin::POPUP] {
                let _ = app.emit_to(label, "monitor://sample", &sample);
            }
        }
        last_times = Some((now, system, times));
        std::thread::sleep(PERIOD);
    }
}

/// The processes whose subtree is known: the Staff App, each web app's
/// WebView2 browser, each program the shell started.
fn roots(app: &AppHandle, browsers: &Arc<Mutex<HashMap<u32, (GroupKind, String)>>>) -> Roots {
    let mut roots: Roots = browsers.lock().map(|map| map.clone()).unwrap_or_default();
    // The Staff App's own tree: the shell and built-in windows share its WebView2
    // browser, which is a child of this process.
    roots.insert(std::process::id(), (GroupKind::Shell, "Rulebox shell + built-in windows".into()));
    if let (Some(services), Some(state)) = (app.try_state::<TaskServices>(), app.try_state::<AppState>()) {
        let names: HashMap<String, String> = state.read(|shell| {
            shell.apps.items.iter().map(|app| (app.id.clone(), app.name.clone())).collect()
        });
        for (pid, app_id) in services.launcher.app_pids() {
            let name = names.get(&app_id).cloned().unwrap_or(app_id);
            roots.insert(pid, (GroupKind::App, name));
        }
    }
    roots
}

/// Ask each web app window for its WebView2 browser process (answers arrive on the UI thread).
fn refresh_browsers(app: &AppHandle, browsers: &Arc<Mutex<HashMap<u32, (GroupKind, String)>>>) {
    let Some(webapps) = app.try_state::<Arc<WebApps>>() else {
        return;
    };
    let open = webapps.open_windows();
    if let Ok(mut map) = browsers.lock() {
        // Closed windows' browsers are forgotten; the answers below refill the rest.
        map.retain(|_, (_, name)| open.iter().any(|(_, open_name)| open_name == name));
    }
    for (label, name) in open {
        let Some(window) = app.get_webview_window(&label) else {
            continue;
        };
        let sink = Arc::clone(browsers);
        crate::webapp::browser_pid(&window, move |pid| {
            if let Ok(mut map) = sink.lock() {
                map.insert(pid, (GroupKind::WebApp, name));
            }
        });
    }
}
