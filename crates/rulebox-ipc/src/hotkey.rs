//! Key-combination text for the hidden admin exit (plan Section 6.11).
//!
//! Pure parsing: no Windows types. The agent uses it to validate the document's
//! combination, the launcher to register it, and Phase 3 to match key events.
//!
//! Grammar: tokens separated by `+`; spaces around a token are ignored; case does
//! not matter. Modifiers are `Ctrl`, `Alt` and `Shift`, each at most once. There
//! must be exactly one key: a letter `A` to `Z`, a digit `0` to `9`, or `F1` to
//! `F12`. At least one of `Ctrl` or `Alt` must be present. Everything else is an
//! error, so `Alt+Tab`, `Ctrl+Esc` and `Ctrl+Alt+Del` cannot be expressed.

use std::fmt;

/// The combination used when the organization has not chosen one.
pub const DEFAULT_ADMIN_EXIT_HOTKEY: &str = "Ctrl+Shift+F12";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Hotkey {
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
    pub key: HotkeyKey,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HotkeyKey {
    /// `'A'..='Z'`, upper case.
    Letter(char),
    /// `0..=9`.
    Digit(u8),
    /// `1..=12`.
    Function(u8),
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum HotkeyError {
    #[error("the key combination is empty")]
    Empty,
    #[error("unknown key or modifier {0:?}")]
    UnknownToken(String),
    #[error("the key combination has no key")]
    NoKey,
    #[error("the key combination has more than one key")]
    TwoKeys,
    #[error("a modifier appears more than once")]
    DuplicateModifier,
    #[error("the key combination needs Ctrl or Alt")]
    NeedsCtrlOrAlt,
}

/// Parses a key combination such as `Ctrl+Shift+F12`.
pub fn parse(text: &str) -> Result<Hotkey, HotkeyError> {
    if text.trim().is_empty() {
        return Err(HotkeyError::Empty);
    }
    let (mut ctrl, mut alt, mut shift) = (false, false, false);
    let mut key: Option<HotkeyKey> = None;

    for raw in text.split('+') {
        let token = raw.trim();
        let modifier = match token.to_ascii_lowercase().as_str() {
            "ctrl" => Some(&mut ctrl),
            "alt" => Some(&mut alt),
            "shift" => Some(&mut shift),
            _ => None,
        };
        if let Some(flag) = modifier {
            if *flag {
                return Err(HotkeyError::DuplicateModifier);
            }
            *flag = true;
            continue;
        }
        let parsed = parse_key(token).ok_or_else(|| HotkeyError::UnknownToken(token.to_string()))?;
        if key.replace(parsed).is_some() {
            return Err(HotkeyError::TwoKeys);
        }
    }

    let key = key.ok_or(HotkeyError::NoKey)?;
    if !ctrl && !alt {
        return Err(HotkeyError::NeedsCtrlOrAlt);
    }
    Ok(Hotkey { ctrl, alt, shift, key })
}

/// One key token: a letter, a digit or `F1` to `F12`. `None` for anything else.
fn parse_key(token: &str) -> Option<HotkeyKey> {
    let upper = token.to_ascii_uppercase();
    let mut chars = upper.chars();
    let first = chars.next()?;
    if chars.next().is_none() {
        if first.is_ascii_uppercase() {
            return Some(HotkeyKey::Letter(first));
        }
        if let Some(digit) = first.to_digit(10) {
            return u8::try_from(digit).ok().map(HotkeyKey::Digit);
        }
        return None;
    }
    // `F1` to `F12`, no sign and no leading zero.
    let number = upper.strip_prefix('F')?;
    let n: u8 = number.parse().ok()?;
    let plain = n.to_string() == number;
    (plain && (1..=12).contains(&n)).then_some(HotkeyKey::Function(n))
}

impl Hotkey {
    /// `Ctrl+Alt+Shift+<KEY>`: modifiers in that order, key upper-case.
    pub fn canonical(&self) -> String {
        let mut parts: Vec<String> = Vec::with_capacity(4);
        if self.ctrl {
            parts.push("Ctrl".into());
        }
        if self.alt {
            parts.push("Alt".into());
        }
        if self.shift {
            parts.push("Shift".into());
        }
        parts.push(match self.key {
            HotkeyKey::Letter(c) => c.to_ascii_uppercase().to_string(),
            HotkeyKey::Digit(d) => d.to_string(),
            HotkeyKey::Function(n) => format!("F{n}"),
        });
        parts.join("+")
    }

    /// Windows virtual-key code: `A`..`Z` = 0x41.., `0`..`9` = 0x30.., `F1`..`F12` = 0x70..0x7B.
    pub fn virtual_key(&self) -> u32 {
        match self.key {
            HotkeyKey::Letter(c) => u32::from(c.to_ascii_uppercase()),
            HotkeyKey::Digit(d) => 0x30 + u32::from(d),
            HotkeyKey::Function(n) => 0x70 + u32::from(n).saturating_sub(1),
        }
    }
}

impl fmt::Display for Hotkey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.canonical())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spelling_and_case_do_not_matter() {
        let a = parse("Ctrl+Shift+F12").unwrap();
        assert_eq!(parse(" ctrl + shift + f12 ").unwrap(), a);
        assert_eq!(parse("shift+CTRL+F12").unwrap(), a);
        assert_eq!(a, Hotkey { ctrl: true, alt: false, shift: true, key: HotkeyKey::Function(12) });
        assert_eq!(a.canonical(), "Ctrl+Shift+F12");
        assert_eq!(parse("shift+CTRL+F12").unwrap().canonical(), "Ctrl+Shift+F12");
    }

    #[test]
    fn canonical_form_round_trips() {
        for text in ["Ctrl+Alt+Shift+R", "Ctrl+0", "Alt+9", "Alt+F1", "Ctrl+Alt+Z", DEFAULT_ADMIN_EXIT_HOTKEY] {
            let parsed = parse(text).unwrap();
            assert_eq!(parsed.canonical(), text);
            assert_eq!(parse(&parsed.canonical()).unwrap(), parsed);
        }
        // Lower case input becomes the upper-case key and the fixed modifier order.
        assert_eq!(parse("shift+alt+ctrl+r").unwrap().canonical(), "Ctrl+Alt+Shift+R");
    }

    #[test]
    fn the_default_combination_parses() {
        assert!(parse(DEFAULT_ADMIN_EXIT_HOTKEY).is_ok());
        assert_eq!(parse(DEFAULT_ADMIN_EXIT_HOTKEY).unwrap().canonical(), DEFAULT_ADMIN_EXIT_HOTKEY);
    }

    #[test]
    fn errors() {
        assert_eq!(parse(""), Err(HotkeyError::Empty));
        assert_eq!(parse("   "), Err(HotkeyError::Empty));
        assert_eq!(parse("Shift+A"), Err(HotkeyError::NeedsCtrlOrAlt));
        assert_eq!(parse("Ctrl"), Err(HotkeyError::NoKey));
        assert_eq!(parse("Ctrl+Shift"), Err(HotkeyError::NoKey));
        assert_eq!(parse("Ctrl+A+B"), Err(HotkeyError::TwoKeys));
        assert_eq!(parse("Ctrl+Ctrl+A"), Err(HotkeyError::DuplicateModifier));
        assert_eq!(parse("Ctrl+Del"), Err(HotkeyError::UnknownToken("Del".into())));
        assert_eq!(parse("Alt+Tab"), Err(HotkeyError::UnknownToken("Tab".into())));
        assert_eq!(parse("Ctrl+F13"), Err(HotkeyError::UnknownToken("F13".into())));
        assert_eq!(parse("Ctrl+F0"), Err(HotkeyError::UnknownToken("F0".into())));
        assert_eq!(parse("Ctrl+F01"), Err(HotkeyError::UnknownToken("F01".into())));
        assert_eq!(parse("Ctrl+Esc"), Err(HotkeyError::UnknownToken("Esc".into())));
        assert_eq!(parse("Ctrl+"), Err(HotkeyError::UnknownToken(String::new())));
        assert_eq!(parse("Ctrl+Alt+Del"), Err(HotkeyError::UnknownToken("Del".into())));
        assert_eq!(parse("Ctrl+10"), Err(HotkeyError::UnknownToken("10".into())));
        assert_eq!(parse("Ctrl+\u{00e9}"), Err(HotkeyError::UnknownToken("\u{00e9}".into())));
    }

    #[test]
    fn virtual_keys() {
        let vk = |text: &str| parse(text).unwrap().virtual_key();
        assert_eq!(vk("Ctrl+A"), 0x41);
        assert_eq!(vk("Ctrl+Z"), 0x5A);
        assert_eq!(vk("Ctrl+0"), 0x30);
        assert_eq!(vk("Ctrl+9"), 0x39);
        assert_eq!(vk("Ctrl+F1"), 0x70);
        assert_eq!(vk("Ctrl+F12"), 0x7B);
    }
}
