//! The enrollment code (plan Section 5.4, PRD 15):
//!
//! ```text
//! RBX1.<base64url, no padding, of the UTF-8 string "<convexUrl>#<token>">
//! ```
//!
//! `parse` is pure: it makes no network call and logs nothing. The token is a
//! credential until it is used, so `Debug` for [`EnrollmentCode`] hides it and no
//! error carries any part of the input.

use std::fmt;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;

const PREFIX: &str = "RBX1.";
/// Crockford base32, upper case only: the server stores `sha256(token)` of the exact
/// text, so no normalization is possible.
const TOKEN_ALPHABET: &str = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TOKEN_LENGTH: usize = 20;

#[derive(Clone, PartialEq, Eq)]
pub struct EnrollmentCode {
    /// `https://host[:port]`, no path, query or user-info.
    pub convex_url: String,
    pub token: String,
}

impl fmt::Debug for EnrollmentCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("EnrollmentCode")
            .field("convex_url", &self.convex_url)
            .field("token", &"<redacted>")
            .finish()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum CodeError {
    #[error("the code does not start with RBX1.")]
    BadPrefix,
    #[error("the code is not valid base64url text")]
    BadEncoding,
    #[error("the code does not contain a URL and a token")]
    Malformed,
    #[error("the deployment URL in the code is not an https:// URL with a host and no path")]
    BadUrl,
    #[error("the token in the code has the wrong length or characters")]
    BadToken,
}

impl CodeError {
    /// The `details.kind` value of the `code_invalid` failure (plan Section 6.7).
    pub fn kind(self) -> &'static str {
        match self {
            CodeError::BadPrefix => "badPrefix",
            CodeError::BadEncoding => "badEncoding",
            CodeError::Malformed => "malformed",
            CodeError::BadUrl => "badUrl",
            CodeError::BadToken => "badToken",
        }
    }
}

/// Parses `RBX1.<base64url(url#token)>`. Surrounding whitespace is ignored; the
/// prefix is case-sensitive.
pub fn parse(code: &str) -> Result<EnrollmentCode, CodeError> {
    let code = code.trim();
    let encoded = code.strip_prefix(PREFIX).ok_or(CodeError::BadPrefix)?;
    let bytes = URL_SAFE_NO_PAD.decode(encoded).map_err(|_| CodeError::BadEncoding)?;
    let text = String::from_utf8(bytes).map_err(|_| CodeError::BadEncoding)?;
    let (url, token) = text.split_once('#').ok_or(CodeError::Malformed)?;
    if !is_agent_url(url) {
        return Err(CodeError::BadUrl);
    }
    if !is_token(token) {
        return Err(CodeError::BadToken);
    }
    Ok(EnrollmentCode { convex_url: url.to_string(), token: token.to_string() })
}

fn is_token(token: &str) -> bool {
    token.len() == TOKEN_LENGTH && token.chars().all(|c| TOKEN_ALPHABET.contains(c))
}

/// Only `https://host[:port]` with nothing after the authority: no path (not even a
/// trailing `/`), query, fragment or user-info.
fn is_agent_url(url: &str) -> bool {
    let Some(authority) = url.strip_prefix("https://") else {
        return false;
    };
    let (host, port) = match authority.split_once(':') {
        Some((host, port)) => (host, Some(port)),
        None => (authority, None),
    };
    if let Some(port) = port {
        let digits = !port.is_empty() && port.len() <= 5 && port.bytes().all(|b| b.is_ascii_digit());
        if !digits || port.parse::<u32>().map_or(true, |p| p == 0 || p > 65_535) {
            return false;
        }
    }
    !host.is_empty()
        && !host.starts_with('.')
        && !host.ends_with('.')
        && !host.contains("..")
        && host.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'.')
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "0123456789ABCDEFGHJK";

    fn code_for(text: &str) -> String {
        format!("{PREFIX}{}", URL_SAFE_NO_PAD.encode(text.as_bytes()))
    }

    #[test]
    fn a_code_built_in_the_test_parses() {
        let code = code_for(&format!("https://happy-animal-123.convex.cloud#{TOKEN}"));
        let parsed = parse(&code).unwrap();
        assert_eq!(parsed.convex_url, "https://happy-animal-123.convex.cloud");
        assert_eq!(parsed.token, TOKEN);
        // Whitespace around the code is ignored (it is pasted from a terminal).
        assert_eq!(parse(&format!("  {code}\r\n")).unwrap(), parsed);
        // A port is allowed.
        let with_port = code_for(&format!("https://convex.example.org:3210#{TOKEN}"));
        assert_eq!(parse(&with_port).unwrap().convex_url, "https://convex.example.org:3210");
    }

    #[test]
    fn the_code_the_server_helper_produces_parses() {
        // The exact string `convex/dev.ts` -> createEnrollmentCode builds, with the
        // same base64url alphabet and no padding (a length that needs padding).
        let url = "https://abc.convex.cloud";
        let encoded = URL_SAFE_NO_PAD.encode(format!("{url}#{TOKEN}"));
        assert!(!encoded.contains('=') && !encoded.contains('+') && !encoded.contains('/'));
        assert_eq!(parse(&format!("RBX1.{encoded}")).unwrap().convex_url, url);
    }

    #[test]
    fn each_error_case() {
        let good = code_for(&format!("https://a.convex.cloud#{TOKEN}"));
        // Wrong prefix, including the right letters in the wrong case.
        assert_eq!(parse("RBX2.abc"), Err(CodeError::BadPrefix));
        assert_eq!(parse(&good.replace("RBX1.", "rbx1.")), Err(CodeError::BadPrefix));
        assert_eq!(parse(""), Err(CodeError::BadPrefix));
        // Not base64url, and valid base64url that is not UTF-8.
        assert_eq!(parse("RBX1.***"), Err(CodeError::BadEncoding));
        assert_eq!(parse("RBX1.a"), Err(CodeError::BadEncoding));
        assert_eq!(parse(&format!("RBX1.{}", URL_SAFE_NO_PAD.encode([0xff, 0xfe, 0xfd]))), Err(CodeError::BadEncoding));
        // Standard-alphabet padding is not accepted.
        assert_eq!(parse(&format!("{good}==")), Err(CodeError::BadEncoding));
        // No `#`.
        assert_eq!(parse(&code_for("https://a.convex.cloud")), Err(CodeError::Malformed));
        assert_eq!(parse(&code_for("")), Err(CodeError::Malformed));
        // URLs.
        for bad in [
            "http://a.convex.cloud",
            "ftp://a.convex.cloud",
            "a.convex.cloud",
            "https://",
            "https://a.convex.cloud/",
            "https://a.convex.cloud/path",
            "https://a.convex.cloud?x=1",
            "https://user@a.convex.cloud",
            "https://user:pw@a.convex.cloud",
            "https://a.convex.cloud:0",
            "https://a.convex.cloud:99999",
            "https://a.convex.cloud:",
            "https://.convex.cloud",
            "https://a..cloud",
            "https://[::1]",
            "https://a b.cloud",
        ] {
            assert_eq!(parse(&code_for(&format!("{bad}#{TOKEN}"))), Err(CodeError::BadUrl), "{bad}");
        }
        // Tokens: wrong length, lower case, letters Crockford leaves out (I, L, O, U).
        for bad in ["", "0123456789ABCDEFGHJ", "0123456789ABCDEFGHJKM", "0123456789abcdefghjk", "0123456789ABCDEFGHIL", "OOOOOOOOOOOOOOOOOOOO"] {
            assert_eq!(parse(&code_for(&format!("https://a.convex.cloud#{bad}"))), Err(CodeError::BadToken), "{bad}");
        }
        // A second `#` ends up in the token.
        assert_eq!(parse(&code_for(&format!("https://a.convex.cloud#{TOKEN}#x"))), Err(CodeError::BadToken));
    }

    #[test]
    fn an_http_url_is_bad_url() {
        let code = code_for(&format!("http://localhost:3210#{TOKEN}"));
        assert_eq!(parse(&code), Err(CodeError::BadUrl));
    }

    #[test]
    fn debug_hides_the_token_and_errors_carry_no_input() {
        let parsed = parse(&code_for(&format!("https://a.convex.cloud#{TOKEN}"))).unwrap();
        let text = format!("{parsed:?}");
        assert!(text.contains("a.convex.cloud") && text.contains("<redacted>"));
        assert!(!text.contains(TOKEN));
        assert_eq!(CodeError::BadUrl.kind(), "badUrl");
        assert!(!CodeError::BadToken.to_string().contains(TOKEN));
    }
}
