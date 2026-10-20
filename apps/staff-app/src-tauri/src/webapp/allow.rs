//! Which addresses a web app window may show (plan Step 15, PRD 6.2). Pure.
//!
//! The rule is deliberately plain: `https` only, and the host must equal an
//! allowed domain or be a subdomain of one, compared label by label. Nothing
//! cleverer is attempted: `evil-example.com` is not `example.com`,
//! `example.com.evil.net` is not `example.com`, and an IP address matches only
//! an identical entry (never as a "subdomain" of a shorter one).

use tauri::Url;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum WebError {
    #[error("the address is not valid")]
    BadUrl,
    #[error("only https addresses are allowed")]
    NotHttps,
    #[error("the address has no host")]
    NoHost,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Entry {
    /// Lower-case, punycode, no trailing dot. An IP literal for an IP entry.
    host: String,
    /// `None` means the default port (443) only.
    port: Option<u16>,
    is_ip: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AllowList {
    entries: Vec<Entry>,
}

/// `host` or `host:port`, as an admin would type it; also a full `https://` address.
fn parse_entry(text: &str) -> Option<Entry> {
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    let url = if text.contains("://") {
        Url::parse(text).ok()?
    } else {
        Url::parse(&format!("https://{text}")).ok()?
    };
    if url.scheme() != "https" {
        return None;
    }
    let host = url.host()?;
    let is_ip = matches!(host, url::Host::Ipv4(_) | url::Host::Ipv6(_));
    let name = normalize_host(&host.to_string());
    if name.is_empty() {
        return None;
    }
    // `url` drops the default port, so an explicit one means "this port only".
    Some(Entry {
        host: name,
        port: url.port(),
        is_ip,
    })
}

fn normalize_host(host: &str) -> String {
    host.trim_end_matches('.').to_ascii_lowercase()
}

impl AllowList {
    /// The app's own address plus the administrator's extra domains. The
    /// primary address must be an `https` URL with a host.
    pub fn new(primary_url: &str, extra_domains: &[String]) -> Result<AllowList, WebError> {
        let primary = Url::parse(primary_url.trim()).map_err(|_| WebError::BadUrl)?;
        if primary.scheme() != "https" {
            return Err(WebError::NotHttps);
        }
        let primary_host = primary.host().ok_or(WebError::NoHost)?;
        let mut entries = vec![Entry {
            host: normalize_host(&primary_host.to_string()),
            port: primary.port(),
            is_ip: matches!(primary_host, url::Host::Ipv4(_) | url::Host::Ipv6(_)),
        }];
        for extra in extra_domains {
            // A malformed extra entry is ignored: it cannot widen anything.
            if let Some(entry) = parse_entry(extra) {
                if !entries.contains(&entry) {
                    entries.push(entry);
                }
            }
        }
        Ok(AllowList { entries })
    }

    /// May a window or frame show this address?
    pub fn allows(&self, url: &str) -> bool {
        let Ok(parsed) = Url::parse(url) else {
            return false;
        };
        self.allows_url(&parsed)
    }

    pub fn allows_url(&self, url: &Url) -> bool {
        if url.scheme() != "https" {
            return false;
        }
        // `https://example.com@evil.net/` has the host `evil.net`, but a
        // login in the address is never something an app needs: refuse it.
        if !url.username().is_empty() || url.password().is_some() {
            return false;
        }
        let Some(host) = url.host() else {
            return false;
        };
        let is_ip = matches!(host, url::Host::Ipv4(_) | url::Host::Ipv6(_));
        let host = normalize_host(&host.to_string());
        let port = url.port();
        self.entries.iter().any(|entry| {
            entry.port == port
                && if is_ip || entry.is_ip {
                    is_ip && entry.is_ip && entry.host == host
                } else {
                    host == entry.host
                        || host
                            .strip_suffix(entry.host.as_str())
                            .is_some_and(|rest| rest.ends_with('.'))
                }
        })
    }

    /// The host names (and ports) allowed, for the blocked page and logs.
    pub fn hosts(&self) -> Vec<String> {
        self.entries
            .iter()
            .map(|entry| match entry.port {
                Some(port) => format!("{}:{port}", entry.host),
                None => entry.host.clone(),
            })
            .collect()
    }
}
