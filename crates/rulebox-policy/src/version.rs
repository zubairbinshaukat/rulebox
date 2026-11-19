//! Version ordering (plan Phase 6, 4.4.1). One comparison function in Rust (this
//! file) and one in TypeScript (`convex/lib/feed/version.ts`); both read the same
//! vector file, `tests/vectors/version.json`, so they cannot drift.
//!
//! A version is **ordered** when it is 1 to 4 dotted numeric parts (compared as
//! numbers, a missing part is 0, so `1.2` equals `1.2.0`), optionally followed by
//! `-` and a semver pre-release (`1.2.3-beta.1`). A pre-release sorts before the
//! same version without one. Anything else (a leading `v`, a `+build` suffix,
//! words, an empty text, more than 40 characters) is **not ordered**: it is fine as
//! display text for a Pinned app and is refused for Vendor `minVersion` and for
//! Managed apps (`version_not_ordered`).
//!
//! Pre-release precedence follows semver 2.0.0 section 11: identifiers are split at
//! `.`, numeric ones compare as numbers and sort before alphanumeric ones, alphanumeric
//! ones compare by ASCII order, and a shorter list sorts before a longer one that
//! starts with it.
//!
//! Numbers are never converted to integers (no overflow): digits are compared by
//! length after the leading zeros are removed, then text by text.
//!
//! Pure: no I/O.

use std::cmp::Ordering;

/// Longest version text (`MAX_VERSION_CHARS`, plan 4.3).
pub const MAX_VERSION_CHARS: usize = 40;
/// Most numeric parts of an ordered version.
pub const MAX_VERSION_PARTS: usize = 4;

/// A parsed, ordered version. Equal versions can have different texts
/// (`1.2` and `1.2.0`; `1.02` and `1.2`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Version {
    /// Four numbers as digit text without leading zeros (`"0"` for zero).
    parts: [String; MAX_VERSION_PARTS],
    /// Pre-release identifiers; empty for a release.
    pre: Vec<String>,
}

impl PartialOrd for Version {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for Version {
    fn cmp(&self, other: &Self) -> Ordering {
        for (a, b) in self.parts.iter().zip(&other.parts) {
            let order = cmp_digits(a, b);
            if order != Ordering::Equal {
                return order;
            }
        }
        match (self.pre.is_empty(), other.pre.is_empty()) {
            (true, true) => Ordering::Equal,
            (true, false) => Ordering::Greater,
            (false, true) => Ordering::Less,
            (false, false) => cmp_pre(&self.pre, &other.pre),
        }
    }
}

fn is_digits(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit())
}

/// `digits` without leading zeros (`"0"` when all are zeros).
fn trim_zeros(digits: &str) -> &str {
    let trimmed = digits.trim_start_matches('0');
    if trimmed.is_empty() {
        "0"
    } else {
        trimmed
    }
}

/// Numbers as text: the longer one is larger, equal lengths compare by text.
fn cmp_digits(a: &str, b: &str) -> Ordering {
    a.len().cmp(&b.len()).then_with(|| a.cmp(b))
}

fn cmp_pre(a: &[String], b: &[String]) -> Ordering {
    for (x, y) in a.iter().zip(b) {
        let order = match (is_digits(x), is_digits(y)) {
            (true, true) => cmp_digits(trim_zeros(x), trim_zeros(y)),
            (true, false) => Ordering::Less,
            (false, true) => Ordering::Greater,
            (false, false) => x.cmp(y),
        };
        if order != Ordering::Equal {
            return order;
        }
    }
    a.len().cmp(&b.len())
}

/// Parses an ordered version, or `None` when the text is not ordered.
pub fn parse(text: &str) -> Option<Version> {
    if text.is_empty() || text.chars().count() > MAX_VERSION_CHARS {
        return None;
    }
    let (numbers, pre) = match text.split_once('-') {
        Some((numbers, pre)) => (numbers, Some(pre)),
        None => (text, None),
    };
    let mut parts: [String; MAX_VERSION_PARTS] = std::array::from_fn(|_| "0".to_string());
    for (at, piece) in numbers.split('.').enumerate() {
        if at == MAX_VERSION_PARTS || !is_digits(piece) {
            return None;
        }
        parts[at] = trim_zeros(piece).to_string();
    }
    let pre = match pre {
        None => Vec::new(),
        Some(pre) => {
            let ids: Vec<&str> = pre.split('.').collect();
            let valid = ids
                .iter()
                .all(|id| !id.is_empty() && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'));
            if !valid {
                return None;
            }
            ids.into_iter().map(str::to_string).collect()
        }
    };
    Some(Version { parts, pre })
}

/// Whether `text` has an order (see the module docs).
pub fn is_ordered(text: &str) -> bool {
    parse(text).is_some()
}

/// Compares two version texts; `None` when either is not ordered.
pub fn cmp(a: &str, b: &str) -> Option<Ordering> {
    Some(parse(a)?.cmp(&parse(b)?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn vectors() -> Value {
        serde_json::from_str(include_str!("../tests/vectors/version.json")).unwrap()
    }

    fn sign(order: Ordering) -> i64 {
        match order {
            Ordering::Less => -1,
            Ordering::Equal => 0,
            Ordering::Greater => 1,
        }
    }

    /// The shared vectors, also run by `convex/lib/feed/version.test.ts`.
    #[test]
    fn shared_vectors() {
        let v = vectors();
        let cases = v["cmp"].as_array().unwrap();
        assert!(cases.len() >= 40);
        for case in cases {
            let (a, b, want) = (case[0].as_str().unwrap(), case[1].as_str().unwrap(), case[2].as_i64().unwrap());
            assert_eq!(cmp(a, b).map(sign), Some(want), "{a} vs {b}");
            // The order is antisymmetric.
            assert_eq!(cmp(b, a).map(sign), Some(-want), "{b} vs {a}");
        }
        let bad = v["notOrdered"].as_array().unwrap();
        assert!(bad.len() >= 20);
        for text in bad {
            let text = text.as_str().unwrap();
            assert!(!is_ordered(text), "{text:?}");
            assert_eq!(cmp(text, "1.0"), None, "{text:?}");
            assert_eq!(cmp("1.0", text), None, "{text:?}");
        }
        for text in v["ordered"].as_array().unwrap() {
            assert!(is_ordered(text.as_str().unwrap()), "{text}");
        }
    }

    #[test]
    fn the_longest_text_is_forty_characters() {
        let long = "1.".repeat(10) + &"2".repeat(20); // 40 characters but five parts
        assert_eq!(long.chars().count(), 40);
        assert!(!is_ordered(&long));
        let forty = format!("1.0.0-{}", "a".repeat(34));
        assert_eq!(forty.chars().count(), 40);
        assert!(is_ordered(&forty));
        assert!(!is_ordered(&format!("{forty}a")));
    }

    #[test]
    fn huge_numbers_do_not_overflow() {
        let big = "99999999999999999999999999999999.0";
        assert_eq!(cmp(big, "1.0"), Some(Ordering::Greater));
        assert_eq!(cmp("00000000000000000000001.0", "1"), Some(Ordering::Equal));
    }

    #[test]
    fn version_ord_is_total_over_the_vectors() {
        let mut all: Vec<Version> =
            vectors()["ordered"].as_array().unwrap().iter().filter_map(|t| parse(t.as_str()?)).collect();
        all.sort();
        for pair in all.windows(2) {
            assert!(pair[0] <= pair[1]);
        }
    }
}
