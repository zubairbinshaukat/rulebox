//! The real and the simulated [`Backend`] of Rulebox Setup (Phase 6 Step 8).
//!
//! [`PlatformBackend`] does the checks and the WebView2 bootstrap on any `Platform` (the real
//! one, the simulated one, a test one) and leaves the one thing that needs the service to an
//! [`Agent`]: [`PipeAgent`] talks to the running service over the admin pipe, exactly like
//! `rulebox-agent status` and `rulebox-agent enroll`; [`SimAgent`] answers from memory and touches
//! nothing. Everything here blocks: only the window's worker threads call it.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use rulebox_ipc::admin::{AdminEnroll, AdminEnrollParams, AdminStatus};
use rulebox_ipc::client::ClientConfig;
use rulebox_ipc::methods::Empty;
use rulebox_ipc::types::{EnrollmentStatus, KioskPhase};
use tokio_util::sync::CancellationToken;

use crate::compat::{self, Options};
use crate::ipc_admin::{self, DEFAULT_TIMEOUT, ENROLL_TIMEOUT, EXIT_NOT_RUNNING};
use crate::platform::Platform;
use crate::setup::flow::{Backend, CheckResult, EnrolledInfo, KioskState};
use crate::setup::{strings, webview2};

/// What Setup needs from the service.
pub trait Agent: Send + Sync + 'static {
    /// The device name when this PC is enrolled, `None` when it is not; `Err` is a plain sentence.
    fn enrollment(&self) -> Result<Option<String>, String>;
    /// Enrolls with `code`; `Err` is a plain sentence.
    fn enroll(&self, code: &str) -> Result<EnrolledInfo, String>;
}

pub struct PlatformBackend {
    pub platform: Arc<dyn Platform>,
    pub install_root: PathBuf,
    /// The pinned bootstrapper hash (`webview2::PINNED_SHA256` in the real program).
    pub pinned: Option<String>,
    pub agent: Box<dyn Agent>,
}

impl Backend for PlatformBackend {
    fn check(&self, webview2_attempted: bool) -> Result<CheckResult, String> {
        let enrolled = self.agent.enrollment()?;
        let report = compat::build_with(self.platform.as_ref(), None, false, Options { webview2_install_attempted: webview2_attempted })
            .map_err(|error| format!("Rulebox Setup cannot read this PC ({error})."))?;
        Ok(CheckResult { enrolled, report })
    }

    fn install_webview2(&self) -> webview2::Outcome {
        webview2::ensure(self.platform.as_ref(), &self.install_root, self.pinned.as_deref(), webview2::RUN_TIMEOUT, &CancellationToken::new())
    }

    fn enroll(&self, code: &str) -> Result<EnrolledInfo, String> {
        self.agent.enroll(code)
    }
}

// -- the real service ------------------------------------------------------------------------------------

/// The running service, over the admin pipe (the same calls as the console commands).
pub struct PipeAgent;

/// The sentence of an admin-command error: the text `ipc_admin::report_error` wrote, without the
/// `error: ` and the machine-readable reason in front of the message.
fn plain_error(written: &[u8]) -> String {
    let text = String::from_utf8_lossy(written);
    let mut lines = text.lines().map(str::trim).filter(|line| !line.is_empty());
    let Some(first) = lines.next() else {
        return "Something went wrong. Try again.".to_string();
    };
    let first = first.strip_prefix("error:").unwrap_or(first).trim();
    // `token_expired: The enrollment code has expired.` -> the sentence.
    let first = match first.split_once(": ") {
        Some((reason, rest)) if !reason.contains(' ') && reason.chars().all(|c| c.is_ascii_lowercase() || c == '_') => rest,
        _ => first,
    };
    std::iter::once(first).chain(lines).collect::<Vec<_>>().join(" ")
}

impl Agent for PipeAgent {
    fn enrollment(&self) -> Result<Option<String>, String> {
        let mut err = Vec::new();
        match ipc_admin::call::<AdminStatus>(ClientConfig::admin(false).with_timeout(DEFAULT_TIMEOUT), Empty {}, &mut err) {
            Ok(result) => {
                let snapshot = result.snapshot;
                Ok((snapshot.enrollment == EnrollmentStatus::Enrolled)
                    .then(|| snapshot.device.map_or_else(|| "this PC".to_string(), |device| device.name)))
            }
            Err(code) if code == EXIT_NOT_RUNNING => Err(strings::NOT_RUNNING.to_string()),
            Err(_) => Err(plain_error(&err)),
        }
    }

    fn enroll(&self, code: &str) -> Result<EnrolledInfo, String> {
        let mut err = Vec::new();
        let params = AdminEnrollParams { code: code.to_string(), device_name: None, allow_joined: false };
        match ipc_admin::call::<AdminEnroll>(ClientConfig::admin(false).with_timeout(ENROLL_TIMEOUT), params, &mut err) {
            Ok(result) => Ok(EnrolledInfo {
                device_name: result.device_name,
                kiosk: if result.kiosk.error_code.is_some() || result.kiosk.phase == KioskPhase::Failed {
                    KioskState::Failed
                } else if result.kiosk.enabled {
                    KioskState::On
                } else {
                    KioskState::NotOnYet
                },
            }),
            Err(code) if code == EXIT_NOT_RUNNING => Err(strings::NOT_RUNNING.to_string()),
            Err(_) => Err(plain_error(&err)),
        }
    }
}

// -- the simulation ------------------------------------------------------------------------------------------

/// `rulebox-agent setup --simulate`: answers from memory. No pipe, no registry, no service.
pub struct SimAgent;

impl Agent for SimAgent {
    fn enrollment(&self) -> Result<Option<String>, String> {
        Ok(None)
    }

    fn enroll(&self, code: &str) -> Result<EnrolledInfo, String> {
        if !cfg!(test) {
            std::thread::sleep(Duration::from_millis(1500));
        }
        if code.len() % 2 == 1 {
            Err("The enrollment code has expired. Create a new one.".to_string())
        } else {
            Ok(EnrolledInfo { device_name: "SIM-PC".to_string(), kiosk: KioskState::On })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn admin_errors_become_one_plain_sentence_without_codes() {
        assert_eq!(
            plain_error(b"error: token_expired: The enrollment code has expired. Create a new one.\n"),
            "The enrollment code has expired. Create a new one."
        );
        assert_eq!(
            plain_error(b"error: backend_unreachable: The backend did not answer. Check the network connection and try again.\nTry again.\n"),
            "The backend did not answer. Check the network connection and try again. Try again."
        );
        assert_eq!(plain_error(b"error: access denied. Run from an elevated prompt.\n"), "access denied. Run from an elevated prompt.");
        assert_eq!(plain_error(b""), "Something went wrong. Try again.");
        // The blocker list stays readable.
        let text = plain_error(b"error: compat_blocked: This PC cannot be enrolled.\n  - s_mode\n");
        assert_eq!(text, "This PC cannot be enrolled. - s_mode");
    }

    #[test]
    fn the_simulated_service_touches_nothing_and_answers_both_ways() {
        let agent = SimAgent;
        assert_eq!(agent.enrollment(), Ok(None));
        assert!(agent.enroll("ab").is_ok());
        assert!(agent.enroll("abc").is_err());
    }
}
