//! Shell mode versus dev mode (plan Section 5.2).

use windows::Win32::UI::WindowsAndMessaging::GetShellWindow;

/// Decided once at startup: shell only when no other process owns the shell
/// window and `RULEBOX_STAFF_FORCE_DEV` is not set.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ShellMode {
    Shell,
    Dev,
}

/// Proof that we are in shell mode. Functions that change session-wide
/// state take `&ShellToken`, so they cannot run in dev mode by mistake.
pub struct ShellToken(());

impl ShellToken {
    pub fn acquire(mode: ShellMode) -> Option<ShellToken> {
        match mode {
            ShellMode::Shell => Some(ShellToken(())),
            ShellMode::Dev => None,
        }
    }
}

/// The decision itself, separated from the Win32 call so it can be tested.
pub fn decide(force_dev: bool, shell_window_exists: bool) -> ShellMode {
    if force_dev || shell_window_exists {
        ShellMode::Dev
    } else {
        ShellMode::Shell
    }
}

/// Shell only when `GetShellWindow()` is null (nothing else is the shell)
/// and `RULEBOX_STAFF_FORCE_DEV` is not set. Call once, at startup.
pub fn detect() -> ShellMode {
    let force_dev = std::env::var_os("RULEBOX_STAFF_FORCE_DEV").is_some();
    // SAFETY: GetShellWindow takes no arguments and has no preconditions.
    let shell_window = unsafe { GetShellWindow() };
    decide(force_dev, !shell_window.0.is_null())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dev_token_is_none() {
        assert!(ShellToken::acquire(ShellMode::Dev).is_none());
        assert!(ShellToken::acquire(ShellMode::Shell).is_some());
    }

    #[test]
    fn explorer_running_means_dev() {
        assert_eq!(decide(false, true), ShellMode::Dev);
    }

    #[test]
    fn force_dev_wins_even_without_a_shell_window() {
        assert_eq!(decide(true, false), ShellMode::Dev);
        assert_eq!(decide(true, true), ShellMode::Dev);
    }

    #[test]
    fn no_shell_window_and_no_override_means_shell() {
        assert_eq!(decide(false, false), ShellMode::Shell);
    }
}
