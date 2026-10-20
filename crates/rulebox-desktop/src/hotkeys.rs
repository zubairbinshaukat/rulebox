//! Global hotkeys (`RegisterHotKey`, shell mode only; plan Step 16).
//!
//! Registration is done on the message-loop thread, against its hidden
//! window, so a press comes back as `WM_HOTKEY` and becomes
//! `DesktopEvent::Hotkey(id)`. Nothing is registered in dev mode: the
//! functions that register take a `&ShellToken`, which only exists in shell mode.

use windows::Win32::Foundation::HWND;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    RegisterHotKey, UnregisterHotKey, HOT_KEY_MODIFIERS, MOD_ALT, MOD_CONTROL, MOD_NOREPEAT, MOD_SHIFT,
    VK_ESCAPE, VK_F1, VK_TAB,
};

use crate::error::{DesktopError, Result};
use crate::mode::ShellToken;

/// The id passed to `RegisterHotKey`, as it comes back in `WM_HOTKEY`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct HotkeyId(pub i32);

impl HotkeyId {
    /// Alt+Tab: the app switcher.
    pub const SWITCHER: HotkeyId = HotkeyId(1);
    /// Ctrl+Esc, and the lone Windows key (see `winkey`): the Start menu.
    pub const START: HotkeyId = HotkeyId(2);
    /// The administrator's hidden exit (the combination comes from policy).
    pub const ADMIN_EXIT: HotkeyId = HotkeyId(3);
}

/// What a combination needs besides its key.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Modifiers {
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
}

/// A key combination in Win32 terms.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Combo {
    pub modifiers: Modifiers,
    /// A virtual-key code (`VK_*`).
    pub vk: u32,
}

impl Combo {
    pub const ALT_TAB: Combo = Combo {
        modifiers: Modifiers {
            ctrl: false,
            alt: true,
            shift: false,
        },
        vk: VK_TAB.0 as u32,
    };

    pub const CTRL_ESC: Combo = Combo {
        modifiers: Modifiers {
            ctrl: true,
            alt: false,
            shift: false,
        },
        vk: VK_ESCAPE.0 as u32,
    };

    /// `RegisterHotKey`'s modifier bits. Auto-repeat is switched off so
    /// holding the keys does not open the same window over and over.
    pub fn bits(self) -> HOT_KEY_MODIFIERS {
        let mut bits = MOD_NOREPEAT;
        if self.modifiers.ctrl {
            bits |= MOD_CONTROL;
        }
        if self.modifiers.alt {
            bits |= MOD_ALT;
        }
        if self.modifiers.shift {
            bits |= MOD_SHIFT;
        }
        bits
    }
}

/// The virtual-key code of `F<n>`, `n` in 1..=12.
pub fn function_key(n: u8) -> u32 {
    VK_F1.0 as u32 + u32::from(n.clamp(1, 12)) - 1
}

/// The virtual-key code of a letter `A`..`Z` or a digit `0`..`9` (they are their ASCII codes).
pub fn ascii_key(c: char) -> Option<u32> {
    let upper = c.to_ascii_uppercase();
    (upper.is_ascii_uppercase() || upper.is_ascii_digit()).then_some(upper as u32)
}

/// Register one hotkey against the loop's window. Call on the loop thread.
/// A failure (another program has the combination) is an error the caller logs.
pub fn register(_token: &ShellToken, hwnd: isize, id: HotkeyId, combo: Combo) -> Result<()> {
    // SAFETY: `hwnd` is the message window of the calling thread; the call has no other preconditions.
    unsafe {
        RegisterHotKey(Some(hwnd_from(hwnd)), id.0, combo.bits(), combo.vk)
            .map_err(|error| DesktopError::win32("RegisterHotKey", &error))
    }
}

/// Release a hotkey. Call on the loop thread. Not registered is not an error.
pub fn unregister(hwnd: isize, id: HotkeyId) {
    // SAFETY: as in `register`.
    let _ = unsafe { UnregisterHotKey(Some(hwnd_from(hwnd)), id.0) };
}

fn hwnd_from(raw: isize) -> HWND {
    HWND(raw as *mut std::ffi::c_void)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_three_actions_have_different_ids() {
        let ids = [HotkeyId::SWITCHER, HotkeyId::START, HotkeyId::ADMIN_EXIT];
        for (i, a) in ids.iter().enumerate() {
            for b in &ids[i + 1..] {
                assert_ne!(a, b);
            }
        }
    }

    #[test]
    fn modifiers_become_win32_bits_and_never_repeat() {
        let combo = Combo {
            modifiers: Modifiers {
                ctrl: true,
                alt: false,
                shift: true,
            },
            vk: function_key(12),
        };
        let bits = combo.bits();
        assert_eq!(bits.0 & MOD_CONTROL.0, MOD_CONTROL.0);
        assert_eq!(bits.0 & MOD_SHIFT.0, MOD_SHIFT.0);
        assert_eq!(bits.0 & MOD_ALT.0, 0);
        assert_eq!(bits.0 & MOD_NOREPEAT.0, MOD_NOREPEAT.0);
        assert_eq!(Combo::ALT_TAB.bits().0 & MOD_ALT.0, MOD_ALT.0);
        assert_eq!(Combo::CTRL_ESC.bits().0 & MOD_CONTROL.0, MOD_CONTROL.0);
    }

    #[test]
    fn keys_map_to_virtual_key_codes() {
        assert_eq!(function_key(1), 0x70);
        assert_eq!(function_key(12), 0x7B);
        assert_eq!(function_key(0), 0x70, "clamped");
        assert_eq!(function_key(99), 0x7B, "clamped");
        assert_eq!(ascii_key('a'), Some(0x41));
        assert_eq!(ascii_key('Z'), Some(0x5A));
        assert_eq!(ascii_key('7'), Some(0x37));
        assert_eq!(ascii_key('-'), None);
        assert_eq!(ascii_key('é'), None);
        assert_eq!(Combo::ALT_TAB.vk, 0x09);
        assert_eq!(Combo::CTRL_ESC.vk, 0x1B);
    }
}
