//! Display, DPI, power and session notifications: the mapping from window
//! messages to [`DesktopEvent`](crate::msgloop::DesktopEvent). Pure, so it is
//! tested without a window.

use windows::Win32::UI::WindowsAndMessaging::{
    PBT_APMPOWERSTATUSCHANGE, PBT_APMRESUMEAUTOMATIC, PBT_APMRESUMESUSPEND, WM_DISPLAYCHANGE,
    WM_DPICHANGED, WM_HOTKEY, WM_POWERBROADCAST,
};

use crate::hotkeys::HotkeyId;
use crate::msgloop::DesktopEvent;

/// `WM_WTSSESSION_CHANGE` (wtsapi32.h). Not exported by the `windows` crate
/// as a message id.
pub const WM_WTSSESSION_CHANGE: u32 = 0x02B1;

/// wParam values of WM_WTSSESSION_CHANGE (wtsapi32.h).
const WTS_SESSION_LOCK: u32 = 0x7;
const WTS_SESSION_UNLOCK: u32 = 0x8;

/// Map one window message to the event it means, if any.
pub fn map_message(msg: u32, wparam: usize) -> Option<DesktopEvent> {
    match msg {
        WM_DISPLAYCHANGE => Some(DesktopEvent::DisplayChanged),
        WM_DPICHANGED => Some(DesktopEvent::DpiChanged),
        WM_POWERBROADCAST => match wparam as u32 {
            PBT_APMRESUMEAUTOMATIC | PBT_APMRESUMESUSPEND => Some(DesktopEvent::Resumed),
            PBT_APMPOWERSTATUSCHANGE => Some(DesktopEvent::PowerChanged),
            _ => None,
        },
        WM_WTSSESSION_CHANGE => match wparam as u32 {
            WTS_SESSION_LOCK => Some(DesktopEvent::SessionLocked),
            WTS_SESSION_UNLOCK => Some(DesktopEvent::SessionUnlocked),
            _ => None,
        },
        WM_HOTKEY => Some(DesktopEvent::Hotkey(HotkeyId(wparam as i32))),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_and_dpi_changes() {
        assert!(matches!(
            map_message(WM_DISPLAYCHANGE, 0),
            Some(DesktopEvent::DisplayChanged)
        ));
        assert!(matches!(
            map_message(WM_DPICHANGED, 0),
            Some(DesktopEvent::DpiChanged)
        ));
    }

    #[test]
    fn both_resume_notifications_mean_resumed() {
        for code in [PBT_APMRESUMEAUTOMATIC, PBT_APMRESUMESUSPEND] {
            assert!(matches!(
                map_message(WM_POWERBROADCAST, code as usize),
                Some(DesktopEvent::Resumed)
            ));
        }
    }

    #[test]
    fn power_status_change() {
        assert!(matches!(
            map_message(WM_POWERBROADCAST, PBT_APMPOWERSTATUSCHANGE as usize),
            Some(DesktopEvent::PowerChanged)
        ));
    }

    #[test]
    fn unrelated_power_codes_are_ignored() {
        assert!(map_message(WM_POWERBROADCAST, 0x4).is_none());
    }

    #[test]
    fn session_lock_and_unlock() {
        assert!(matches!(
            map_message(WM_WTSSESSION_CHANGE, WTS_SESSION_LOCK as usize),
            Some(DesktopEvent::SessionLocked)
        ));
        assert!(matches!(
            map_message(WM_WTSSESSION_CHANGE, WTS_SESSION_UNLOCK as usize),
            Some(DesktopEvent::SessionUnlocked)
        ));
        assert!(map_message(WM_WTSSESSION_CHANGE, 1).is_none());
    }

    #[test]
    fn hotkey_carries_its_id() {
        match map_message(WM_HOTKEY, 7) {
            Some(DesktopEvent::Hotkey(id)) => assert_eq!(id, HotkeyId(7)),
            other => panic!("expected a hotkey event, got {other:?}"),
        }
    }

    #[test]
    fn ordinary_messages_map_to_nothing() {
        assert!(map_message(0x0001, 0).is_none());
    }
}
