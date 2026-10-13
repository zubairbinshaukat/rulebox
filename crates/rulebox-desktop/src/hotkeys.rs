//! Global hotkeys (`RegisterHotKey`, shell mode only). Registration lands in
//! Step 16; the id type exists now so the message loop can report presses.

/// The id passed to `RegisterHotKey`, as it comes back in `WM_HOTKEY`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct HotkeyId(pub i32);
