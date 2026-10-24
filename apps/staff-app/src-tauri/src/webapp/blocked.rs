//! The page a web app window shows instead of a site it may not open
//! (plan Step 15, Section 7.10). It is served by the `rbblocked` scheme,
//! contains no script, and grants nothing. It is the only local page a web
//! window can show.

use std::borrow::Cow;

use tauri::Url;

/// How Windows addresses the custom scheme (`http://<scheme>.localhost/`).
const HOST: &str = "rbblocked.localhost";

/// Only the exact address of the page: no port (the custom scheme is matched
/// without one, so `rbblocked.localhost:8080` would be a real loopback server),
/// no user info and the root path.
pub fn is_blocked_page(url: &Url) -> bool {
    url.scheme() == "http"
        && url.host_str() == Some(HOST)
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && url.path() == "/"
}

/// The address of the page for `host`, with a link back to `back`.
pub fn blocked_url(host: &str, back: &str) -> Option<Url> {
    let mut url = Url::parse(&format!("http://{HOST}/")).ok()?;
    url.query_pairs_mut().append_pair("host", host).append_pair("back", back);
    Some(url)
}

fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            c if c.is_control() => {}
            c => out.push(c),
        }
    }
    out
}

/// The document for a request address. The host is shown as text; the link back
/// is offered only when it is an `https` address (nothing else can be a link target here).
pub fn render(url: &Url) -> String {
    let mut host = String::new();
    let mut back = String::new();
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "host" => host = value.chars().take(253).collect(),
            "back" => back = value.into_owned(),
            _ => {}
        }
    }
    page(&host, &back)
}

/// The document itself, from the blocked host and the address to go back to.
fn page(host: &str, back: &str) -> String {
    let back_ok = Url::parse(back).is_ok_and(|u| u.scheme() == "https" && u.host().is_some());
    let shown = if host.is_empty() {
        "that site".to_string()
    } else {
        escape(host)
    };
    let link = if back_ok {
        format!(r#"<p><a href="{}">Go back</a></p>"#, escape(back))
    } else {
        String::new()
    };
    format!(
        concat!(
            "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">",
            "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
            "<title>This site is not allowed</title><style>",
            ":root{{color-scheme:light dark;--bg:#f4f1ec;--ink:#201d19;--muted:#6f685f;--accent:#0f766e}}",
            "@media(prefers-color-scheme:dark){{:root{{--bg:#14120f;--ink:#f1ede6;--muted:#a39b90;--accent:#5eead4}}}}",
            "body{{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);",
            "font:16px/1.5 system-ui,sans-serif}}main{{max-width:30rem;padding:2rem}}",
            "h1{{font-size:1.5rem;margin:0 0 .75rem}}p{{margin:.5rem 0;color:var(--muted)}}",
            "strong{{color:var(--ink);word-break:break-all}}a{{color:var(--accent);font-weight:600}}",
            "</style></head><body><main><h1>This site is not allowed</h1>",
            "<p><strong>{shown}</strong> can't be opened from this app.</p>",
            "<p>If you think it should be, ask your administrator.</p>{link}</main></body></html>"
        ),
        shown = shown,
        link = link
    )
}

/// The `rbblocked` protocol handler: always the same static page shape.
pub fn serve(request: tauri::http::Request<Vec<u8>>) -> tauri::http::Response<Cow<'static, [u8]>> {
    let uri = request.uri().to_string();
    let body = Url::parse(&uri).map_or_else(|_| page("", ""), |url| render(&url));
    tauri::http::Response::builder()
        .status(200)
        .header("Content-Type", "text/html; charset=utf-8")
        .header("Cache-Control", "no-store")
        .header("X-Content-Type-Options", "nosniff")
        // No script, no network, no frames: a static page and its own styles.
        .header(
            "Content-Security-Policy",
            "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        )
        .body(Cow::Owned(body.into_bytes()))
        .unwrap_or_else(|_| tauri::http::Response::new(Cow::Borrowed(&[][..])))
}
