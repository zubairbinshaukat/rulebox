//! Terminal-services sessions: list them, find the console, sign one out.

use windows::Win32::Foundation::HANDLE;
use windows::Win32::System::RemoteDesktop::{
    WTSActive, WTSConnected, WTSDisconnected, WTSEnumerateSessionsW, WTSFreeMemory, WTSGetActiveConsoleSessionId,
    WTSListen, WTSLogoffSession, WTSQueryUserToken, WTS_CURRENT_SERVER_HANDLE, WTS_SESSION_INFOW,
};

use crate::error::{api_err, Result};
use crate::guard::require_test_machine;
use crate::sid::{user_sid_of_token, Sid};
use crate::util::OwnedHandle;

/// `WTSGetActiveConsoleSessionId` returns this when no session is attached.
const NO_CONSOLE_SESSION: u32 = 0xFFFF_FFFF;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionState {
    Active,
    Connected,
    Disconnected,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Session {
    pub id: u32,
    pub state: SessionState,
    /// The signed-in user. Only SYSTEM can read it (`WTSQueryUserToken`); `None`
    /// for any other caller and for sessions without a user.
    pub user_sid: Option<Sid>,
    pub is_console: bool,
}

/// The session attached to the physical console, if any.
pub fn active_console_session() -> Option<u32> {
    // SAFETY: a plain query with no arguments.
    let id = unsafe { WTSGetActiveConsoleSessionId() };
    (id != NO_CONSOLE_SESSION).then_some(id)
}

/// Every user session except session 0 (services) and the listener.
pub fn list_sessions() -> Result<Vec<Session>> {
    let console = active_console_session();
    let mut info: *mut WTS_SESSION_INFOW = std::ptr::null_mut();
    let mut count = 0u32;
    // SAFETY: the current server handle is the local machine; the out pointers are valid.
    unsafe { WTSEnumerateSessionsW(Some(WTS_CURRENT_SERVER_HANDLE), 0, 1, &mut info, &mut count) }
        .map_err(|e| api_err("WTSEnumerateSessionsW", &e))?;
    let mut sessions = Vec::new();
    for index in 0..count as usize {
        // SAFETY: the API returned `count` consecutive WTS_SESSION_INFOW entries.
        let entry = unsafe { &*info.add(index) };
        if entry.SessionId == 0 || entry.State == WTSListen {
            continue;
        }
        let state = if entry.State == WTSActive {
            SessionState::Active
        } else if entry.State == WTSConnected {
            SessionState::Connected
        } else if entry.State == WTSDisconnected {
            SessionState::Disconnected
        } else {
            SessionState::Other
        };
        sessions.push(Session {
            id: entry.SessionId,
            state,
            user_sid: session_user_sid(entry.SessionId),
            is_console: console == Some(entry.SessionId),
        });
    }
    // SAFETY: `info` came from WTSEnumerateSessionsW and is freed once.
    unsafe { WTSFreeMemory(info.cast()) };
    Ok(sessions)
}

/// The user SID of a session, or `None` when it cannot be read (not SYSTEM, or
/// nobody is signed in).
fn session_user_sid(session_id: u32) -> Option<Sid> {
    let mut token = HANDLE::default();
    // SAFETY: `token` is a valid out pointer; the call fails harmlessly unless
    // the caller is SYSTEM.
    unsafe { WTSQueryUserToken(session_id, &mut token) }.ok()?;
    let token = OwnedHandle::new(token).ok()?;
    user_sid_of_token(&token).ok()
}

/// Signs `session_id` out without waiting.
///
/// DESTRUCTIVE: guarded.
pub fn logoff(session_id: u32) -> Result<()> {
    require_test_machine()?;
    // SAFETY: the current server handle is the local machine; `bwait` is false.
    unsafe { WTSLogoffSession(Some(WTS_CURRENT_SERVER_HANDLE), session_id, false) }
        .map_err(|e| api_err("WTSLogoffSession", &e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::Win32Error;

    #[test]
    fn sessions_can_be_listed_and_never_include_session_zero() {
        let sessions = list_sessions().unwrap();
        assert!(sessions.iter().all(|s| s.id != 0));
        // At most one session is the console.
        assert!(sessions.iter().filter(|s| s.is_console).count() <= 1);
    }

    #[test]
    fn logoff_is_blocked_by_the_guard() {
        if crate::guard::is_test_machine() {
            return;
        }
        assert!(matches!(logoff(0xFFFF), Err(Win32Error::Guard(_))));
    }
}
