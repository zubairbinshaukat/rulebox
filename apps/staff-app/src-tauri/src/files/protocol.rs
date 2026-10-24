//! The `rbfile` protocol: `http://rbfile.localhost/<url-encoded relative path>`.
//! Serves the viewer formats to the shell's own windows, with ranges, and
//! nothing else (plan Step 12).
//!
//! Every Tauri webview can request a custom scheme, so a web app window
//! could ask for `rbfile.localhost` too. Requests that name a foreign
//! `Origin` or `Referer` are refused; the response carries no CORS headers
//! for anyone but the app's own origins.

use std::io::{Read, Seek, SeekFrom};

use tauri::{AppHandle, Manager};

use super::saferoot::{FileError, RelPath};
use super::types::{check_content, content_type};
use super::FileSession;
use crate::state::AppState;

/// Most bytes in one `206` response: media and PDF readers ask again for the
/// next piece, so a response body is never bigger than this.
pub const MAX_RANGE: u64 = 4 * 1024 * 1024;
/// Without a `Range` the whole file is sent when it is at most this big. It
/// equals the size limit of the Office previews (`preview::OFFICE_MAX_BYTES`),
/// the largest reader that fetches a file in one piece, and also covers the
/// pictures an `<img>` loads without ranges. A bigger file asked for without
/// `Range` gets only its first `MAX_RANGE` bytes, as a `206` that names the
/// full size, so one request never holds more than this in memory.
pub const MAX_WHOLE: u64 = super::preview::OFFICE_MAX_BYTES;

const OWN_ORIGINS: &[&str] = &[
    "http://tauri.localhost",
    "https://tauri.localhost",
    "tauri://localhost",
    #[cfg(debug_assertions)]
    "http://localhost:1420",
];

pub struct Request<'a> {
    pub method: &'a str,
    /// The URI path, still percent-encoded.
    pub path: &'a str,
    pub range: Option<&'a str>,
    pub origin: Option<&'a str>,
    pub referer: Option<&'a str>,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Reply {
    pub status: u16,
    pub headers: Vec<(&'static str, String)>,
    pub body: Vec<u8>,
}

impl Reply {
    fn status(status: u16) -> Reply {
        Reply {
            status,
            headers: vec![
                ("Cache-Control", "no-store".into()),
                ("X-Content-Type-Options", "nosniff".into()),
            ],
            body: Vec::new(),
        }
    }

    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }
}

fn from_own_origin(value: &str) -> bool {
    OWN_ORIGINS
        .iter()
        .any(|own| value == *own || value.starts_with(&format!("{own}/")))
}

fn percent_decode(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'%' {
            let hex = text.get(at + 1..at + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            at += 3;
        } else {
            out.push(bytes[at]);
            at += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// `bytes=a-b`, `bytes=a-`, `bytes=-n`. Several ranges are not supported.
fn parse_range(header: &str, size: u64) -> Option<(u64, u64)> {
    let spec = header.trim().strip_prefix("bytes=")?;
    if spec.contains(',') {
        return None;
    }
    let (start, end) = spec.split_once('-')?;
    let (start, end) = match (start.trim(), end.trim()) {
        ("", suffix) => {
            let n: u64 = suffix.parse().ok()?;
            (size.saturating_sub(n), size.checked_sub(1)?)
        }
        (start, "") => (start.parse().ok()?, size.checked_sub(1)?),
        (start, end) => (start.parse().ok()?, end.parse::<u64>().ok()?.min(size.checked_sub(1)?)),
    };
    (start <= end && start < size).then_some((start, end))
}

/// The last byte to send for a request without `Range`, and whether the file
/// was too big to send whole (so the answer is a `206`). Pure.
pub fn whole_file_span(size: u64) -> (u64, bool) {
    if size > MAX_WHOLE {
        (MAX_RANGE - 1, true)
    } else {
        (size.saturating_sub(1), false)
    }
}

fn with_cors(mut reply: Reply, origin: Option<&str>) -> Reply {
    if let Some(origin) = origin.filter(|o| from_own_origin(o)) {
        reply.headers.push(("Access-Control-Allow-Origin", origin.to_string()));
        reply.headers.push(("Vary", "Origin".into()));
        reply.headers.push((
            "Access-Control-Expose-Headers",
            "Content-Range, Accept-Ranges, Content-Length".into(),
        ));
    }
    reply
}

pub fn respond(session: Option<&FileSession>, request: &Request<'_>) -> Reply {
    let foreign = [request.origin, request.referer]
        .into_iter()
        .flatten()
        .any(|value| !from_own_origin(value));
    if foreign {
        return Reply::status(403);
    }
    let reply = serve(session, request);
    with_cors(reply, request.origin)
}

fn serve(session: Option<&FileSession>, request: &Request<'_>) -> Reply {
    if request.method == "OPTIONS" {
        let mut reply = Reply::status(204);
        reply.headers.push(("Access-Control-Allow-Headers", "Range".into()));
        reply.headers.push(("Access-Control-Allow-Methods", "GET, HEAD".into()));
        return reply;
    }
    let head_only = request.method == "HEAD";
    if request.method != "GET" && !head_only {
        return Reply::status(405);
    }
    let Some(session) = session else {
        return Reply::status(403);
    };
    let Some(decoded) = percent_decode(request.path.trim_start_matches('/')) else {
        return Reply::status(400);
    };
    let Ok(path) = RelPath::parse(&decoded) else {
        return Reply::status(400);
    };
    let Some(leaf) = path.leaf() else {
        return Reply::status(404);
    };
    let Some(mime) = content_type(leaf) else {
        return Reply::status(403);
    };
    let mut file = match session.root().open_read(&path) {
        Ok(file) => file,
        Err(FileError::NotFound) => return Reply::status(404),
        Err(_) => return Reply::status(403),
    };
    let mut head = Vec::with_capacity(8192);
    if (&mut file).take(8192).read_to_end(&mut head).is_err() {
        return Reply::status(500);
    }
    if check_content(leaf, &head).is_err() {
        return Reply::status(403);
    }
    let Ok(size) = file.metadata().map(|m| m.len()) else {
        return Reply::status(500);
    };

    let mut reply = Reply::status(200);
    reply.headers.push(("Content-Type", mime.to_string()));
    reply.headers.push(("Accept-Ranges", "bytes".into()));

    let (start, end) = match request.range {
        Some(header) => match parse_range(header, size) {
            Some((start, end)) => {
                let end = end.min(start + MAX_RANGE - 1);
                reply.status = 206;
                reply
                    .headers
                    .push(("Content-Range", format!("bytes {start}-{end}/{size}")));
                (start, end)
            }
            None => {
                let mut reply = Reply::status(416);
                reply.headers.push(("Content-Range", format!("bytes */{size}")));
                return reply;
            }
        },
        None => match whole_file_span(size) {
            (end, true) => {
                reply.status = 206;
                reply
                    .headers
                    .push(("Content-Range", format!("bytes 0-{end}/{size}")));
                (0, end)
            }
            (end, false) => (0, end),
        },
    };
    let length = if size == 0 { 0 } else { end - start + 1 };
    reply.headers.push(("Content-Length", length.to_string()));
    if head_only || length == 0 {
        return reply;
    }
    let mut body = Vec::with_capacity(length as usize);
    if file.seek(SeekFrom::Start(start)).is_err() || file.take(length).read_to_end(&mut body).is_err() {
        return Reply::status(500);
    }
    reply.body = body;
    reply
}

/// Which webviews may ask the shell's custom schemes for anything: the shell
/// windows and the built-in app windows, never a web app's page. Every webview
/// can request any scheme, and an image or media request carries no usable
/// Origin, so the asking webview's own label is what decides.
pub fn label_may_read(label: &str) -> bool {
    label.starts_with("shell-") || label.starts_with("app-")
}

/// Answer 403 to a webview that may not ask (see label_may_read).
pub fn refuse(responder: tauri::UriSchemeResponder) {
    let response = tauri::http::Response::builder()
        .status(403)
        .header("Cache-Control", "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .body(std::borrow::Cow::Borrowed(&[][..]));
    if let Ok(response) = response {
        responder.respond(response);
    }
}

/// The glue to Tauri. Reads on a worker thread so the webview is never blocked.
pub fn serve_request(
    app: &AppHandle,
    request: tauri::http::Request<Vec<u8>>,
    responder: tauri::UriSchemeResponder,
) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let header = |name: &str| {
            request
                .headers()
                .get(name)
                .and_then(|value| value.to_str().ok())
        };
        let session = app
            .try_state::<AppState>()
            .and_then(|state| state.files().session());
        let reply = respond(
            session.as_deref(),
            &Request {
                method: request.method().as_str(),
                path: request.uri().path(),
                range: header("range"),
                origin: header("origin"),
                referer: header("referer"),
            },
        );
        let mut builder = tauri::http::Response::builder().status(reply.status);
        for (name, value) in &reply.headers {
            builder = builder.header(*name, value);
        }
        match builder.body(std::borrow::Cow::Owned(reply.body)) {
            Ok(response) => responder.respond(response),
            Err(error) => tracing::warn!(%error, "could not build the file response"),
        }
    });
}
