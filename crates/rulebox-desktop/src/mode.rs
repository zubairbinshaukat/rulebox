//! Shell mode versus dev mode.

/// Decided once at startup: shell only when no other process owns the shell
/// window and `RULEBOX_STAFF_FORCE_DEV` is not set.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ShellMode {
    Shell,
    Dev,
}

/// Proof that we are in shell mode. Session-changing functions take `&ShellToken`.
pub struct ShellToken(());

impl ShellToken {
    pub fn acquire(mode: ShellMode) -> Option<ShellToken> {
        match mode {
            ShellMode::Shell => Some(ShellToken(())),
            ShellMode::Dev => None,
        }
    }
}

/// Shell only when `GetShellWindow()` is null and `RULEBOX_STAFF_FORCE_DEV` is unset.
pub fn detect() -> ShellMode {
    if std::env::var_os("RULEBOX_STAFF_FORCE_DEV").is_some() {
        return ShellMode::Dev;
    }
    // Step 1 stub: real detection lands with window work. Dev until then.
    ShellMode::Dev
}
