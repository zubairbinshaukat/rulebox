//! Logging: daily rolling file `agent.<date>.log` (14 kept), optional stderr.
//! Default level `info`; `RULEBOX_LOG=debug` raises it.

use std::path::Path;
use std::str::FromStr;

use anyhow::Context;
use tracing::level_filters::LevelFilter;
use tracing_appender::non_blocking::WorkerGuard;
use tracing_appender::rolling::{RollingFileAppender, Rotation};
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{fmt, Layer};

/// Keep the returned guard alive until just before exit, or buffered lines are lost.
pub fn init(dir: &Path, also_stderr: bool) -> anyhow::Result<WorkerGuard> {
    std::fs::create_dir_all(dir).with_context(|| format!("create log directory {}", dir.display()))?;
    let appender = RollingFileAppender::builder()
        .rotation(Rotation::DAILY)
        .filename_prefix("agent")
        .filename_suffix("log")
        .max_log_files(14)
        .build(dir)
        .context("open the log file")?;
    let (writer, guard) = tracing_appender::non_blocking(appender);

    let level = std::env::var("RULEBOX_LOG")
        .ok()
        .and_then(|value| LevelFilter::from_str(value.trim()).ok())
        .unwrap_or(LevelFilter::INFO);

    let file_layer = fmt::layer().with_ansi(false).with_writer(writer);
    let stderr_layer = also_stderr.then(|| fmt::layer().with_writer(std::io::stderr));
    tracing_subscriber::registry()
        .with(file_layer.with_filter(level))
        .with(stderr_layer.map(|layer| layer.with_filter(level)))
        .try_init()
        .context("install the log subscriber")?;
    Ok(guard)
}
