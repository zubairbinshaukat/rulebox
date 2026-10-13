//! Logging: daily rolling file `agent.<date>.log` (14 kept), optional stderr.
//! Default level `info`; `RULEBOX_LOG=debug` raises it **for Rulebox's own crates
//! only**. Every other crate stays at `warn`: at debug and trace the Convex client
//! prints the arguments of every call it sends (the device secret, the enrollment
//! token) and the documents it receives (the exit PIN hash), and the log file is
//! the kind of thing an administrator sends for support.

use std::path::Path;
use std::str::FromStr;

use anyhow::Context;
use tracing::level_filters::LevelFilter;
use tracing_appender::non_blocking::WorkerGuard;
use tracing_appender::rolling::{RollingFileAppender, Rotation};
use tracing_subscriber::filter::Targets;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{fmt, Layer};

/// Crates whose log lines the requested level applies to. Anything else is capped
/// at `warn`.
const OWN_TARGETS: [&str; 4] = ["rulebox_agent", "rulebox_ipc", "rulebox_win32", "rulebox_policy"];

/// The level asked for by `RULEBOX_LOG`, or `default` if it is unset or invalid.
fn requested_level(default: LevelFilter) -> LevelFilter {
    std::env::var("RULEBOX_LOG")
        .ok()
        .and_then(|value| LevelFilter::from_str(value.trim()).ok())
        .unwrap_or(default)
}

/// `own` for Rulebox's crates, `warn` for every other crate (never more verbose
/// than `own`, so `RULEBOX_LOG=error` silences them too).
fn filter(own: LevelFilter) -> Targets {
    let others = if own < LevelFilter::WARN { own } else { LevelFilter::WARN };
    // `LevelFilter` orders OFF < ERROR < WARN < INFO < DEBUG < TRACE.
    Targets::new()
        .with_default(others)
        .with_targets(OWN_TARGETS.iter().map(|target| (*target, own)))
}

/// Logging to standard error only: no directory, no file. For the read-only
/// commands (`compat`) that must not create anything on disk. Safe to call twice.
pub fn init_stderr_only() {
    let level = requested_level(LevelFilter::WARN);
    let _ = tracing_subscriber::registry()
        .with(fmt::layer().with_writer(std::io::stderr).with_filter(filter(level)))
        .try_init();
}

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

    let level = requested_level(LevelFilter::INFO);

    let file_layer = fmt::layer().with_ansi(false).with_writer(writer);
    let stderr_layer = also_stderr.then(|| fmt::layer().with_writer(std::io::stderr));
    tracing_subscriber::registry()
        .with(file_layer.with_filter(filter(level)))
        .with(stderr_layer.map(|layer| layer.with_filter(filter(level))))
        .try_init()
        .context("install the log subscriber")?;
    Ok(guard)
}

#[cfg(test)]
mod tests {
    use tracing::Level;

    use super::*;

    #[test]
    fn debug_and_trace_apply_to_rulebox_crates_only() {
        for own in [LevelFilter::DEBUG, LevelFilter::TRACE] {
            let targets = filter(own);
            for ours in OWN_TARGETS {
                assert!(targets.would_enable(ours, &Level::DEBUG), "{ours}");
            }
            // The Convex client and its transports must not reach debug or info.
            for other in ["convex", "convex::sync::web_socket_manager", "tungstenite", "tokio_tungstenite", "hyper"] {
                assert!(!targets.would_enable(other, &Level::DEBUG), "{other} at debug");
                assert!(!targets.would_enable(other, &Level::INFO), "{other} at info");
                assert!(targets.would_enable(other, &Level::WARN), "{other} at warn");
            }
        }
    }

    #[test]
    fn the_default_level_is_info_for_our_crates_and_warn_for_the_rest() {
        let targets = filter(LevelFilter::INFO);
        assert!(targets.would_enable("rulebox_agent::kiosk", &Level::INFO));
        assert!(!targets.would_enable("rulebox_agent::kiosk", &Level::DEBUG));
        assert!(!targets.would_enable("convex", &Level::INFO));
    }

    #[test]
    fn error_level_silences_other_crates_too() {
        let targets = filter(LevelFilter::ERROR);
        assert!(!targets.would_enable("convex", &Level::WARN));
        assert!(targets.would_enable("rulebox_agent", &Level::ERROR));
    }
}
