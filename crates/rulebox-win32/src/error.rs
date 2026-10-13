//! Error type for the whole crate.

#[derive(thiserror::Error, Debug)]
pub enum Win32Error {
    #[error("blocked by the test-machine guard: {0}")]
    Guard(String),
    #[error("{api} failed with Win32 error {code}")]
    Api { api: &'static str, code: u32 },
    #[error("{api} failed with NTSTATUS {status:#x}")]
    Nt { api: &'static str, status: i32 },
    #[error("{0}")]
    Invalid(String),
    /// Win32 error 2 or 3 (for example a pipe that does not exist yet).
    #[error("not found")]
    NotFound,
    /// `ERROR_PIPE_BUSY` (231): every pipe instance is in use; retry shortly.
    #[error("pipe busy")]
    Busy,
    /// The account (or object) to create exists already (`NERR_UserExists`, 2224).
    #[error("already exists")]
    AlreadyExists,
    /// The local password policy refused the password (`NERR_PasswordTooShort`,
    /// 2245, which Windows also returns for any other policy failure).
    #[error("password rejected by local policy")]
    PasswordPolicy,
}

impl Win32Error {
    /// The Win32 error code, when the error carries one.
    pub fn code(&self) -> Option<u32> {
        match self {
            Win32Error::Api { code, .. } => Some(*code),
            _ => None,
        }
    }
}

pub type Result<T> = std::result::Result<T, Win32Error>;

/// Builds an `Api` error from a `windows` crate error. The crate wraps Win32
/// codes as `HRESULT_FROM_WIN32`, so the low 16 bits are the original code.
pub(crate) fn api_err(api: &'static str, e: &windows::core::Error) -> Win32Error {
    let hr = e.code().0 as u32;
    let code = if hr >> 16 == 0x8007 { hr & 0xFFFF } else { hr };
    Win32Error::Api { api, code }
}

/// Builds an `Api` error from a plain Win32 error code (for APIs that return it).
pub(crate) fn code_err(api: &'static str, code: u32) -> Win32Error {
    Win32Error::Api { api, code }
}
