//! Errors from desktop Win32 helpers.

use thiserror::Error;

pub type Result<T> = std::result::Result<T, DesktopError>;

#[derive(Debug, Error)]
pub enum DesktopError {
    #[error("{0}")]
    Message(String),
}
