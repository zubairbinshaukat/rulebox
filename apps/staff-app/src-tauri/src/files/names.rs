//! Rules for one path component (pure). A name that breaks any rule is
//! refused before it gets near the disk (plan Step 12).

use serde::Serialize;
use ts_rs::TS;

/// Longest allowed name, in UTF-16 units (what NTFS counts).
const MAX_UNITS: usize = 255;

/// Hidden names the backend keeps for itself (the trash). Never addressable.
pub const INTERNAL_PREFIX: &str = ".rulebox-";

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum NameRule {
    Empty,
    DotName,
    BadCharacter,
    TrailingDotOrSpace,
    ReservedName,
    TooLong,
    Direction,
    Internal,
    ShortAlias,
}

impl NameRule {
    /// What to show under the rename field.
    pub fn message(self) -> &'static str {
        match self {
            NameRule::Empty => "A name can't be empty.",
            NameRule::DotName => "A name can't be just dots.",
            NameRule::BadCharacter => "A name can't contain any of  < > : \" / \\ | ? *",
            NameRule::TrailingDotOrSpace => "A name can't end with a dot or a space.",
            NameRule::ReservedName => "That name is reserved by Windows.",
            NameRule::TooLong => "That name is too long.",
            NameRule::Direction => "A name can't contain text-direction characters.",
            NameRule::Internal => "That name is reserved by Rulebox.",
            NameRule::ShortAlias => "A name can't look like a Windows short name such as REPORT~1.",
        }
    }
}

const RESERVED: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$", "COM1", "COM2", "COM3", "COM4", "COM5",
    "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7",
    "LPT8", "LPT9",
];

/// `COM¹` `COM²` `COM³` and `LPT¹`...: Windows treats the superscripts as digits.
fn is_superscript_device(stem: &str) -> bool {
    let upper = stem.to_uppercase();
    ["COM", "LPT"].iter().any(|prefix| {
        upper
            .strip_prefix(prefix)
            .is_some_and(|rest| matches!(rest, "\u{b9}" | "\u{b2}" | "\u{b3}"))
    })
}

/// Check one component. `Ok` means the name is safe to use on disk.
pub fn check_component(name: &str) -> Result<(), NameRule> {
    if name.is_empty() {
        return Err(NameRule::Empty);
    }
    if name == "." || name == ".." {
        return Err(NameRule::DotName);
    }
    for ch in name.chars() {
        if matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || ch.is_control() {
            return Err(NameRule::BadCharacter);
        }
        if matches!(ch, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}') {
            return Err(NameRule::Direction);
        }
    }
    if name.ends_with('.') || name.ends_with(' ') {
        return Err(NameRule::TrailingDotOrSpace);
    }
    if name.encode_utf16().count() > MAX_UNITS {
        return Err(NameRule::TooLong);
    }
    // Device names are reserved with or without an extension ("nul.txt").
    let stem = name.split('.').next().unwrap_or(name).trim_end_matches(' ');
    let upper = stem.to_uppercase();
    if RESERVED.contains(&upper.as_str()) || is_superscript_device(stem) {
        return Err(NameRule::ReservedName);
    }
    if name.starts_with(INTERNAL_PREFIX) {
        return Err(NameRule::Internal);
    }
    if is_short_alias(name) {
        return Err(NameRule::ShortAlias);
    }
    Ok(())
}

/// An 8.3 alias such as `BUDGET~1.XLS` or `RULEBO~1`. NTFS resolves it to the
/// real entry, so it would get past the checks that look at the long name
/// (the extension deny-list, the hidden trash folder).
fn is_short_alias(name: &str) -> bool {
    let (stem, ext) = name.split_once('.').unwrap_or((name, ""));
    if ext.contains('.') || ext.chars().count() > 3 || stem.chars().count() > 8 {
        return false;
    }
    match stem.rfind('~') {
        Some(at) if at > 0 => {
            let digits = &stem[at + 1..];
            !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit())
        }
        _ => false,
    }
}

/// Entries named like this are never listed.
pub fn is_internal(name: &str) -> bool {
    name.starts_with(INTERNAL_PREFIX)
}

/// `report.txt` and 2 become `report (2).txt`; a folder `Photos` becomes `Photos (2)`.
pub fn numbered(name: &str, n: u32, is_dir: bool) -> String {
    if is_dir {
        return format!("{name} ({n})");
    }
    match name.rfind('.') {
        Some(dot) if dot > 0 => format!("{} ({n}){}", &name[..dot], &name[dot..]),
        _ => format!("{name} ({n})"),
    }
}

#[cfg(test)]
mod short_alias_tests {
    use super::*;

    #[test]
    fn short_aliases_are_refused_and_long_names_with_a_tilde_are_not() {
        for alias in ["BUDGET~1.XLS", "RULEBO~1", "report~12.doc", "ab~3"] {
            assert_eq!(check_component(alias), Err(NameRule::ShortAlias), "{alias}");
        }
        for fine in ["Budget2024.xlsm", "my~notes.txt", "~1", "tilde~1 and more.txt", "a~b", "back~up.tar.gz"] {
            assert_eq!(check_component(fine), Ok(()), "{fine}");
        }
    }
}
