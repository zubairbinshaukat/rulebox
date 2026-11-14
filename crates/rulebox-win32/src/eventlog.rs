//! Reading Windows event logs (plan 4.5, 4.10): the AppLocker and App Control audit
//! channels the findings of Section 4.10 come from. Read-only; it never clears or writes
//! a log, and only the channels in [`READABLE_CHANNELS`] can be named.

use windows::core::PCWSTR;
use windows::Win32::Foundation::{ERROR_NO_MORE_ITEMS, WIN32_ERROR};
use windows::Win32::System::EventLog::{
    EvtClose, EvtNext, EvtQuery, EvtQueryChannelPath, EvtQueryForwardDirection, EvtQueryTolerateQueryErrors,
    EvtRender, EvtRenderEventXml, EVT_HANDLE,
};

use crate::error::{api_err, Result, Win32Error};
use crate::util::to_wide;

/// The channels a caller may read.
pub const READABLE_CHANNELS: &[&str] = &[
    "Microsoft-Windows-AppLocker/EXE and DLL",
    "Microsoft-Windows-AppLocker/MSI and Script",
    "Microsoft-Windows-AppLocker/Packaged app-Execution",
    "Microsoft-Windows-AppLocker/Packaged app-Deployment",
    "Microsoft-Windows-CodeIntegrity/Operational",
];
/// The most events one call returns.
pub const MAX_EVENTS: usize = 500;
/// `ERROR_EVT_CHANNEL_NOT_FOUND`: the channel does not exist on this edition.
const CHANNEL_NOT_FOUND: u32 = 15007;
/// `ERROR_INSUFFICIENT_BUFFER`.
const INSUFFICIENT_BUFFER: u32 = 122;

/// One event: its record number and its XML.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EventRecord {
    pub record_id: u64,
    pub xml: String,
}

/// An event handle closed on drop.
struct Evt(EVT_HANDLE);

impl Drop for Evt {
    fn drop(&mut self) {
        // SAFETY: the handle came from the event log API, is owned by this value and closed once.
        unsafe {
            let _ = EvtClose(self.0);
        }
    }
}

/// The channel rule (no API call).
pub fn check_channel(channel: &str) -> Result<()> {
    if READABLE_CHANNELS.iter().any(|c| c.eq_ignore_ascii_case(channel)) {
        Ok(())
    } else {
        Err(Win32Error::Forbidden(format!("the event log {channel:?} is not one Rulebox reads")))
    }
}

/// `<EventRecordID>n</EventRecordID>` of a rendered event.
pub fn record_id_of(xml: &str) -> Option<u64> {
    let (_, rest) = xml.split_once("<EventRecordID>")?;
    rest.split_once("</EventRecordID>")?.0.trim().parse().ok()
}

/// Up to `max` (at most 500) events of `channel` whose record number is greater than
/// `after_record_id`, oldest first. A channel this edition does not have is an empty
/// list. Read-only.
pub fn read(channel: &str, after_record_id: u64, max: usize) -> Result<Vec<EventRecord>> {
    check_channel(channel)?;
    let max = max.min(MAX_EVENTS);
    if max == 0 {
        return Ok(Vec::new());
    }
    let path = to_wide(channel);
    let query = to_wide(&format!("*[System[EventRecordID > {after_record_id}]]"));
    let flags = EvtQueryChannelPath.0 | EvtQueryForwardDirection.0 | EvtQueryTolerateQueryErrors.0;
    // SAFETY: both strings are NUL-terminated and outlive the call; no remote session.
    let results = match unsafe { EvtQuery(None, PCWSTR(path.as_ptr()), PCWSTR(query.as_ptr()), flags) } {
        Ok(handle) => Evt(handle),
        Err(e) => match api_err("EvtQuery", &e) {
            Win32Error::Api { code: CHANNEL_NOT_FOUND, .. } => return Ok(Vec::new()),
            other => return Err(other),
        },
    };

    let mut out = Vec::new();
    while out.len() < max {
        let mut handles = [0isize; 32];
        let want = (max - out.len()).min(handles.len());
        let mut returned = 0u32;
        // SAFETY: the result set is open; `handles` has room for `want` handles.
        let next = unsafe { EvtNext(results.0, &mut handles[..want], 1000, 0, &mut returned) };
        if let Err(e) = next {
            match api_err("EvtNext", &e) {
                Win32Error::Api { code, .. } if WIN32_ERROR(code) == ERROR_NO_MORE_ITEMS => break,
                other => return Err(other),
            }
        }
        for raw in &handles[..returned as usize] {
            let event = Evt(EVT_HANDLE(*raw));
            let xml = render_xml(&event)?;
            if let Some(record_id) = record_id_of(&xml) {
                out.push(EventRecord { record_id, xml });
            }
        }
        if returned == 0 {
            break;
        }
    }
    Ok(out)
}

fn render_xml(event: &Evt) -> Result<String> {
    let (mut used, mut props) = (0u32, 0u32);
    // SAFETY: no buffer, size 0: only the required size is asked for.
    let first = unsafe { EvtRender(None, event.0, EvtRenderEventXml.0, 0, None, &mut used, &mut props) };
    if let Err(e) = first {
        match api_err("EvtRender", &e) {
            Win32Error::Api { code: INSUFFICIENT_BUFFER, .. } => {}
            other => return Err(other),
        }
    }
    let mut buffer = vec![0u16; (used as usize).div_ceil(2) + 1];
    let size = u32::try_from(buffer.len() * 2).unwrap_or(u32::MAX);
    // SAFETY: `buffer` holds `size` bytes.
    unsafe {
        EvtRender(None, event.0, EvtRenderEventXml.0, size, Some(buffer.as_mut_ptr().cast()), &mut used, &mut props)
    }
    .map_err(|e| api_err("EvtRender", &e))?;
    let units = ((used as usize) / 2).min(buffer.len());
    Ok(String::from_utf16_lossy(&buffer[..units]).trim_end_matches('\0').to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_audit_channels_can_be_read() {
        assert!(check_channel("Microsoft-Windows-AppLocker/EXE and DLL").is_ok());
        assert!(check_channel("microsoft-windows-codeintegrity/operational").is_ok());
        for bad in ["Security", "System", "Application", "Microsoft-Windows-PowerShell/Operational", ""] {
            assert!(matches!(check_channel(bad), Err(Win32Error::Forbidden(_))), "{bad}");
            assert!(matches!(read(bad, 0, 10), Err(Win32Error::Forbidden(_))), "{bad}");
        }
    }

    #[test]
    fn record_ids_are_read_from_the_xml() {
        let xml = "<Event><System><EventRecordID>4711</EventRecordID></System></Event>";
        assert_eq!(record_id_of(xml), Some(4711));
        assert_eq!(record_id_of("<Event/>"), None);
        assert_eq!(record_id_of("<EventRecordID>x</EventRecordID>"), None);
    }

    #[test]
    fn zero_events_asked_is_empty_without_a_query() {
        assert!(read("Microsoft-Windows-CodeIntegrity/Operational", 0, 0).unwrap().is_empty());
    }

    /// Reads the real event log; never writes. Run by hand.
    #[test]
    #[ignore = "reads the real Windows event log"]
    fn smoke_read() {
        let events = read("Microsoft-Windows-CodeIntegrity/Operational", 0, 5).unwrap();
        println!("{} events", events.len());
        assert!(events.windows(2).all(|pair| pair[0].record_id < pair[1].record_id));
    }
}
