//! Every English string of Rulebox Setup and of the installer-code event log entries, in one
//! table (Phase 6 Step 8, plan 4.10.1: "English strings in one table"). Nothing else in
//! `setup/` holds user-facing text, so a translation later touches this file only.
//!
//! No string here ever includes an enrollment code, and the functions below take reasons and
//! counts, never the code.

use crate::compat::{Blocker, CompatReport, Protection, Warning};
use crate::setup::webview2::Outcome as WebView2Outcome;

pub const WINDOW_TITLE: &str = "Rulebox Setup";

// -- screens ---------------------------------------------------------------------------------------

pub const CHECKING_TITLE: &str = "Checking this PC";
pub const CHECKING_LINE: &str = "Looking at Windows, the WebView2 Runtime and the Rulebox service...";

pub const INSTALLING_WEBVIEW2_TITLE: &str = "Installing the WebView2 Runtime";
pub const INSTALLING_WEBVIEW2_LINE: &str =
    "The Rulebox desktop needs Microsoft's WebView2 Runtime. Installing it now. This needs an internet connection and can take a few minutes.";

pub const BLOCKED_TITLE: &str = "This PC cannot be enrolled yet";
pub const BLOCKED_INTRO: &str = "Fix the problems below, then choose Check again.";

pub const CODE_TITLE: &str = "Enroll this PC";
pub const CODE_INTRO: &str =
    "In the Rulebox dashboard, open Devices, choose Add device and copy the enrollment code. Paste it here.";
pub const CODE_LABEL: &str = "Enrollment code";
pub const CODE_EMPTY: &str = "Enter the enrollment code first.";
pub const CODE_INVALID: &str = "That is not a valid enrollment code. Copy the whole code from the dashboard.";
pub const CODE_TOO_LONG: &str = "That text is too long to be an enrollment code.";

pub const ENROLLING_TITLE: &str = "Enrolling this PC";
pub const ENROLLING_LINE: &str = "Registering this PC with your organization. This can take up to two minutes.";

pub const DONE_TITLE: &str = "This PC is enrolled";
pub const ALREADY_TITLE: &str = "This PC is already enrolled";
pub const ALREADY_LINE: &str = "Nothing more to do here. Manage this PC from the Rulebox dashboard.";
pub const FATAL_TITLE: &str = "Rulebox Setup cannot continue";

pub const NEXT_TITLE: &str = "What happens next";
pub const NEXT_KIOSK_ON: &str = "The kiosk is on. The next time someone signs in, this PC shows the Rulebox desktop.";
pub const NEXT_KIOSK_PENDING: &str =
    "The kiosk is not on yet. It turns on when you switch it on for this PC in the dashboard.";
pub const NEXT_KIOSK_FAILED: &str =
    "The kiosk could not finish turning on. Rulebox keeps trying; the dashboard shows the reason.";
pub const NEXT_WAY_BACK: &str = "To get back to Windows: use the administrator exit of the Rulebox desktop (the key combination and PIN set in the dashboard), or restart the PC and hold Shift at the Rulebox screen, then sign in with an administrator account.";

pub const NOT_RUNNING: &str = "The Rulebox Agent service is not running. Restart this PC, or start the service from Services, then open Rulebox Setup again.";

// -- buttons -----------------------------------------------------------------------------------------

pub const BUTTON_ENROLL: &str = "Enroll";
pub const BUTTON_CHECK_AGAIN: &str = "Check again";
pub const BUTTON_CLOSE: &str = "Close";
pub const BUTTON_FINISH: &str = "Finish";

// -- the compatibility report ---------------------------------------------------------------------------

pub const PROTECTION_FULL: &str = "Protection: full. Every lockdown layer is available on this PC.";
pub const PROTECTION_REDUCED: &str = "Protection: reduced. This PC can still be enrolled, with fewer lockdown layers:";
pub const WEBVIEW2_NONE: &str = "WebView2 Runtime: not installed.";

pub fn webview2_line(version: Option<&str>) -> String {
    match version {
        Some(version) => format!("WebView2 Runtime: version {version}."),
        None => WEBVIEW2_NONE.to_string(),
    }
}

pub fn blocker_line(blocker: Blocker) -> String {
    blocker.plain().to_string()
}

pub fn warning_line(warning: Warning) -> String {
    warning.plain().to_string()
}

/// The lines the report adds to the screen: protection first, then the WebView2 state. Blockers
/// and warnings are listed by the caller (they differ per screen).
pub fn report_lines(report: &CompatReport) -> Vec<String> {
    let mut lines = Vec::new();
    match report.protection {
        Protection::Full => lines.push(PROTECTION_FULL.to_string()),
        Protection::Reduced => {
            lines.push(PROTECTION_REDUCED.to_string());
            lines.extend(report.reduced_reasons().into_iter().map(|reason| format!("  - {reason}")));
        }
    }
    lines.push(webview2_line(report.webview2.version.as_deref()));
    lines
}

// -- the WebView2 bootstrap ------------------------------------------------------------------------------

/// What Setup says about one bootstrap run (a plain sentence; `None`: nothing worth saying).
pub fn webview2_outcome_line(outcome: &WebView2Outcome) -> Option<String> {
    Some(match outcome {
        WebView2Outcome::NotNeeded { .. } => return None,
        WebView2Outcome::Installed { version } => format!("The WebView2 Runtime was installed (version {version})."),
        WebView2Outcome::NotPinned => "This build of Rulebox cannot install the WebView2 Runtime: its installer is not pinned. Install the runtime from Microsoft yourself, then choose Check again.".to_string(),
        WebView2Outcome::BootstrapperMissing => "The WebView2 installer that comes with Rulebox is missing. Install the runtime from Microsoft yourself, or repair Rulebox, then choose Check again.".to_string(),
        WebView2Outcome::HashMismatch => "The WebView2 installer that comes with Rulebox is not the file it should be, so it was not started. Repair or reinstall Rulebox, then choose Check again.".to_string(),
        WebView2Outcome::RunFailed { detail } => format!("The WebView2 installer did not finish ({detail}). Check the internet connection, then choose Check again."),
        WebView2Outcome::StillTooOld { version } => match version {
            Some(version) => format!("The WebView2 Runtime is still version {version}; Rulebox needs 125 or newer."),
            None => "The WebView2 Runtime is still not installed after the installer ran.".to_string(),
        },
    })
}

// -- the installer's enrollment code: event log entries (ids and texts) ---------------------------------------

pub const EVENT_PENDING_ENROLLED: u32 = 1000;
pub const EVENT_PENDING_ALREADY: u32 = 1001;
pub const EVENT_PENDING_FAILED: u32 = 1002;
pub const EVENT_PENDING_NOT_DELETED: u32 = 1003;
pub const EVENT_PENDING_UNREADABLE: u32 = 1004;

pub const EVENT_ENROLLED: &str =
    "Rulebox enrolled this PC with the enrollment code from the installer. The code was deleted from this PC.";
pub const EVENT_ALREADY: &str =
    "This PC is already enrolled, so the enrollment code from the installer was not used. The code was deleted from this PC.";
pub const EVENT_NOT_DELETED: &str =
    "Rulebox could not delete the enrollment code that the installer left in the registry (HKLM\\SOFTWARE\\Rulebox\\Install\\Pending). Delete the value Code there yourself; the agent tries again at its next start.";
pub const EVENT_UNREADABLE: &str =
    "Rulebox could not read the enrollment code that the installer left in the registry, so this PC was not enrolled. Open Rulebox Setup from the Start menu and enter a code from the dashboard.";

/// The text of the failure entry: why, after how many tries. The code is deleted by then.
pub fn event_failed(reason: &str, tries: u32) -> String {
    let times = if tries == 1 { "1 try".to_string() } else { format!("{tries} tries") };
    format!(
        "Rulebox could not enroll this PC with the enrollment code from the installer ({reason}, after {times}). The code was deleted from this PC. Open Rulebox Setup from the Start menu and enter a new code from the dashboard, or run `rulebox-agent enroll <code>` as an administrator."
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_failure_entry_says_why_and_how_often_and_what_to_do() {
        let text = event_failed("token_expired", 3);
        assert!(text.contains("token_expired") && text.contains("3 tries") && text.contains("Rulebox Setup"), "{text}");
        assert!(event_failed("x", 1).contains("1 try)"));
    }

    #[test]
    fn webview2_outcomes_have_words_except_when_nothing_happened() {
        assert_eq!(webview2_outcome_line(&WebView2Outcome::NotNeeded { version: "130.0".into() }), None);
        for outcome in [
            WebView2Outcome::Installed { version: "131.0".into() },
            WebView2Outcome::NotPinned,
            WebView2Outcome::BootstrapperMissing,
            WebView2Outcome::HashMismatch,
            WebView2Outcome::RunFailed { detail: "exit code 5".into() },
            WebView2Outcome::StillTooOld { version: Some("124.0".into()) },
            WebView2Outcome::StillTooOld { version: None },
        ] {
            assert!(webview2_outcome_line(&outcome).is_some_and(|line| !line.is_empty()), "{outcome:?}");
        }
    }
}
