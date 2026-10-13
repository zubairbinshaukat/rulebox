//! Daily rolling file under `%LOCALAPPDATA%\dev.rulebox.staff\logs\`.

use std::path::PathBuf;

use tracing::level_filters::LevelFilter;
use tracing_appender::non_blocking::WorkerGuard;
use tracing_appender::rolling::{RollingFileAppender, Rotation};
use tracing_subscriber::filter::Targets;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{fmt, Layer};

const OWN_TARGETS: [&str; 4] = [
    "rulebox_staff_lib",
    "rulebox_desktop",
    "rulebox_ipc",
    "rulebox_policy",
];

fn requested_level(default: LevelFilter) -> LevelFilter {
    std::env::var("RULEBOX_LOG")
        .ok()
        .and_then(|value| value.trim().parse().ok())
        .unwrap_or(default)
}

fn filter(own: LevelFilter) -> Targets {
    let others = if own < LevelFilter::WARN {
        own
    } else {
        LevelFilter::WARN
    };
    Targets::new()
        .with_default(others)
        .with_targets(OWN_TARGETS.iter().map(|target| (*target, own)))
}

/// Log directory: `%LOCALAPPDATA%\dev.rulebox.staff\logs`.
pub fn log_dir() -> Option<PathBuf> {
    let local = std::env::var_os("LOCALAPPDATA")?;
    Some(PathBuf::from(local).join("dev.rulebox.staff").join("logs"))
}

/// Keep the returned guard alive for the process lifetime.
pub fn init() -> Result<WorkerGuard, String> {
    let dir = log_dir().ok_or_else(|| "LOCALAPPDATA is not set".to_string())?;
    std::fs::create_dir_all(&dir).map_err(|error| format!("create log dir: {error}"))?;
    let appender = RollingFileAppender::builder()
        .rotation(Rotation::DAILY)
        .filename_prefix("staff")
        .filename_suffix("log")
        .max_log_files(7)
        .build(&dir)
        .map_err(|error| format!("open log file: {error}"))?;
    let (writer, guard) = tracing_appender::non_blocking(appender);

    let level = requested_level(LevelFilter::INFO);
    let file_layer = fmt::layer().with_ansi(false).with_writer(writer);
    let stderr_layer = fmt::layer().with_writer(std::io::stderr);
    tracing_subscriber::registry()
        .with(file_layer.with_filter(filter(level)))
        .with(stderr_layer.with_filter(filter(level)))
        .try_init()
        .map_err(|error| format!("install log subscriber: {error}"))?;
    Ok(guard)
}
