//! Errors from desktop Win32 helpers.

use thiserror::Error;

pub type Result<T> = std::result::Result<T, DesktopError>;

#[derive(Debug, Error)]
pub enum DesktopError {
    #[error("{0}")]
    Message(String),
    /// A Win32 call failed. `call` names the API, `code` is the error code.
    #[error("{call} failed (error {code})")]
    Win32 { call: &'static str, code: u32 },
    /// The message loop thread has stopped, so nothing can run on it.
    #[error("the desktop message loop is not running")]
    LoopStopped,
}

impl DesktopError {
    /// Build a `Win32` error from a `windows` crate error.
    pub(crate) fn win32(call: &'static str, error: &windows::core::Error) -> DesktopError {
        // HRESULT_FROM_WIN32 keeps the Win32 code in the low 16 bits.
        DesktopError::Win32 {
            call,
            code: (error.code().0 as u32) & 0xFFFF,
        }
    }
}
