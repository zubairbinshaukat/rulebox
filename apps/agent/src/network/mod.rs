//! Wi-Fi (Phase 5 Step 13, plan 4.15 and 4.18): the device sealing key, the profile XML
//! writer and the apply of the document's `wifi` / `wifiManagedOnly` keys.
//!
//! Not wired into the reconciler yet (Step 20 does that); the apply is reached through
//! `lockdown::apply`, which runs it in `Layer::Wifi`, and the sealing key registration is a
//! pure "is a call due" decision the reconciler will use. Printers (Step 14) will live beside
//! `wifi` in this module.
#![allow(dead_code)]

use zeroize::{Zeroize, Zeroizing};

pub mod sealkey;
pub mod wifi;

/// Text that holds a Wi-Fi passphrase (the profile XML with its key material). Zeroized on
/// drop; `Debug` never shows the content, so a log line, a journal dump or a panic message
/// cannot leak it. Deliberately not `Display` and not serializable.
#[derive(Clone)]
pub struct SecretText(Zeroizing<String>);

impl SecretText {
    pub fn new(text: String) -> Self {
        Self(Zeroizing::new(text))
    }

    /// The text, for the one call that hands it to the platform.
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for SecretText {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SecretText(<redacted>)")
    }
}

impl PartialEq for SecretText {
    fn eq(&self, other: &Self) -> bool {
        self.0.as_str() == other.0.as_str()
    }
}

impl Eq for SecretText {}

impl Drop for SecretText {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_shows_nothing_and_equality_works() {
        let text = SecretText::new("pass&word<1>".into());
        assert_eq!(format!("{text:?} {text:#?}"), "SecretText(<redacted>) SecretText(<redacted>)");
        assert_eq!(text, SecretText::new("pass&word<1>".into()));
        assert_ne!(text, SecretText::new("other".into()));
        assert_eq!(text.expose(), "pass&word<1>");
    }
}
