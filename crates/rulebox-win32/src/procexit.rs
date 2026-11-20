//! Waiting for a process to end (Phase 6 Step 11, plan 4.4.5): the install engine learns that
//! the app it waits for has closed from the process handle itself, not from a timer. One
//! blocking wait on the process **and** a cancel event; no polling. Read-only: the process is
//! opened for `SYNCHRONIZE` only, so nothing can end or change it through this handle.

use windows::core::PCWSTR;
use windows::Win32::Foundation::{HANDLE, WAIT_OBJECT_0};
use windows::Win32::System::Threading::{
    CreateEventW, OpenProcess, SetEvent, WaitForMultipleObjects, INFINITE, PROCESS_SYNCHRONIZE,
};

use crate::error::{api_err, Result};
use crate::util::OwnedHandle;

/// A process to wait for and the event that stops the waiting.
pub struct ExitWatch {
    process: OwnedHandle,
    cancel: OwnedHandle,
}

impl ExitWatch {
    /// Opens `pid` for waiting. `Ok(None)`: the process is gone or cannot be opened (the
    /// caller then has nothing to wait for).
    pub fn open(pid: u32) -> Result<Option<Self>> {
        // SAFETY: a plain open by id with the synchronize right only; the handle is owned
        // by the guard below.
        let Ok(process) = (unsafe { OpenProcess(PROCESS_SYNCHRONIZE, false, pid) }) else {
            return Ok(None);
        };
        let process = OwnedHandle::new(process)?;
        // SAFETY: a manual-reset event, unnamed and not inherited; owned by the guard below.
        let cancel = unsafe { CreateEventW(None, true, false, PCWSTR::null()) }.map_err(|e| api_err("CreateEventW", &e))?;
        Ok(Some(Self { process, cancel: OwnedHandle::new(cancel)? }))
    }

    /// Blocks until the process ended (`true`) or [`cancel`](Self::cancel) was called
    /// (`false`). Call it from a blocking thread.
    pub fn wait(&self) -> bool {
        let handles: [HANDLE; 2] = [self.process.raw(), self.cancel.raw()];
        // SAFETY: both handles are valid for the whole call (owned by `self`).
        let result = unsafe { WaitForMultipleObjects(&handles, false, INFINITE) };
        result == WAIT_OBJECT_0
    }

    /// Stops a running [`wait`](Self::wait) (it returns `false`), or makes the next one
    /// return at once.
    pub fn cancel(&self) {
        // SAFETY: the event handle is valid (owned by `self`).
        let _ = unsafe { SetEvent(self.cancel.raw()) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn a_process_that_does_not_exist_cannot_be_watched() {
        // A process id far above any real one.
        assert!(ExitWatch::open(0x7FFF_FFF0).unwrap().is_none());
    }

    #[test]
    fn a_wait_ends_when_cancelled_and_not_before() {
        // This very test process never ends while the test runs, so only the cancel event
        // can end the wait: it must return `false`, from another thread, at once.
        let watch = Arc::new(ExitWatch::open(std::process::id()).unwrap().expect("this process"));
        let waiting = Arc::clone(&watch);
        let thread = std::thread::spawn(move || waiting.wait());
        std::thread::sleep(std::time::Duration::from_millis(100));
        assert!(!thread.is_finished(), "waits while the process runs");
        watch.cancel();
        assert!(!thread.join().unwrap(), "cancelled, not ended");
        // After a cancel, a wait returns at once.
        assert!(!watch.wait());
    }

    #[test]
    fn a_wait_ends_when_the_process_ends() {
        // A child that sleeps briefly: `ping` is not needed, the test binary itself is
        // started with a test filter that matches nothing and exits at once.
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "no_such_test_name_for_the_exit_watch", "--test-threads=1"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let watch = ExitWatch::open(child.id()).unwrap();
        // The child may already be gone; either way the wait must not hang.
        if let Some(watch) = watch {
            assert!(watch.wait(), "the process ended");
        }
        let _ = child.wait();
    }
}
