//! Writing one entry to the Windows Application event log (Phase 6 Step 8: the plan asks for "a
//! clear message in the event log" when the installer's enrollment code could not be used).
//!
//! Only the source name [`SOURCE`] is accepted, so a bug cannot write under another program's
//! name. The MSI registers the source (`apps/installer/Package.wxs`, component `EventSource`) with
//! the .NET Framework 4 message file, whose "%1" message covers every id, so Event Viewer shows the
//! text given here. Without the MSI (a dev build on the VM) the source is unregistered and Event
//! Viewer shows "the description cannot be found" before the text.

use windows::core::PCWSTR;
use windows::Win32::System::EventLog::{
    DeregisterEventSource, RegisterEventSourceW, ReportEventW, EVENTLOG_ERROR_TYPE, EVENTLOG_INFORMATION_TYPE,
    EVENTLOG_WARNING_TYPE, REPORT_EVENT_TYPE,
};

use crate::error::{api_err, Result, Win32Error};
use crate::guard::require_armed_machine;
use crate::util::to_wide;

/// The event source of everything the agent writes.
pub const SOURCE: &str = "Rulebox Agent";
/// Longer messages are cut (the API takes 31,839 characters; nobody reads that many).
pub const MAX_MESSAGE_CHARS: usize = 2000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Information,
    Warning,
    Error,
}

impl Kind {
    fn api(self) -> REPORT_EVENT_TYPE {
        match self {
            Kind::Information => EVENTLOG_INFORMATION_TYPE,
            Kind::Warning => EVENTLOG_WARNING_TYPE,
            Kind::Error => EVENTLOG_ERROR_TYPE,
        }
    }
}

/// The source rule (no API call).
pub fn check_source(source: &str) -> Result<()> {
    if source == SOURCE {
        Ok(())
    } else {
        Err(Win32Error::Forbidden(format!("the event source {source:?} is not one Rulebox writes")))
    }
}

/// The message as written: cut to [`MAX_MESSAGE_CHARS`] characters (no API call).
pub fn clip_message(message: &str) -> String {
    message.chars().take(MAX_MESSAGE_CHARS).collect()
}

/// Writes one entry to the Application log under [`SOURCE`].
///
/// DESTRUCTIVE: guarded.
pub fn report(source: &str, kind: Kind, event_id: u32, message: &str) -> Result<()> {
    check_source(source)?;
    require_armed_machine()?;
    let name = to_wide(source);
    let text = to_wide(&clip_message(message));
    // SAFETY: the source name is NUL-terminated and outlives the call; a null server name means
    // this computer.
    let handle = unsafe { RegisterEventSourceW(PCWSTR::null(), PCWSTR(name.as_ptr())) }
        .map_err(|e| api_err("RegisterEventSourceW", &e))?;
    let strings = [PCWSTR(text.as_ptr())];
    // SAFETY: the handle is the one registered above; the string array holds one NUL-terminated
    // string that outlives the call; no SID and no raw data.
    let reported = unsafe { ReportEventW(handle, kind.api(), 0, event_id, None, 0, Some(&strings), None) };
    // SAFETY: closes the handle registered above, once.
    let _ = unsafe { DeregisterEventSource(handle) };
    reported.map_err(|e| api_err("ReportEventW", &e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_agents_own_source_is_accepted() {
        assert!(check_source(SOURCE).is_ok());
        for other in ["", "Application Error", "rulebox agent", "Rulebox Agent "] {
            assert!(matches!(check_source(other), Err(Win32Error::Forbidden(_))), "{other:?}");
            assert!(matches!(report(other, Kind::Error, 1, "x"), Err(Win32Error::Forbidden(_))), "{other:?}");
        }
    }

    #[test]
    fn long_messages_are_cut_and_short_ones_kept() {
        assert_eq!(clip_message("short"), "short");
        assert_eq!(clip_message(&"x".repeat(MAX_MESSAGE_CHARS + 50)).chars().count(), MAX_MESSAGE_CHARS);
    }

    #[test]
    fn the_dev_machine_is_refused_before_anything_is_written() {
        assert!(matches!(report(SOURCE, Kind::Error, 1001, "test"), Err(Win32Error::Guard(_))));
    }
}
