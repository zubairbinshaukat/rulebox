//! Window tracking (shell hook + WinEvent hooks). The event type exists now
//! so the message loop's `DesktopEvent` is complete; the hooks land in Step 7.

use crate::windows::WindowInfo;

#[derive(Clone, Debug)]
pub enum WindowEvent {
    Added(WindowInfo),
    Removed(isize),
    Changed(WindowInfo),
    Activated(Option<isize>),
    Flash(isize, bool),
}
