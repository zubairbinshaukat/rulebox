//! Downloads (plan Step 14 item 2): the [`Downloader`] seam and the one way a file
//! is written, [`write_stream`]: into `<dest>.part` while hashing, refused when it
//! grows past the limit, renamed to `dest` only when its SHA-256 is the expected
//! one, deleted otherwise. The hash named by the signed catalogue is the only
//! authority: a redirect may go anywhere `https://`, the bytes still have to match.
//!
//! `HttpDownloader` (reqwest, native TLS through SChannel like the Convex client):
//! `https://` only, also for every redirect (at most [`MAX_REDIRECTS`]);
//! connection timeout 30 s; a read that stalls 60 s fails. Errors never carry the
//! URL (a storage URL may hold a token).

use std::path::{Path, PathBuf};
use std::time::Duration;

use bytes::Bytes;
use futures_util::future::BoxFuture;
use futures_util::{FutureExt, Stream, StreamExt};
use reqwest::Url;
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;

use super::{hex_lower, Detail};
use crate::state::remove_file_if_exists;

pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
/// No byte for this long: the download fails (and is retried by the engine).
pub const STALL_TIMEOUT: Duration = Duration::from_secs(60);
pub const MAX_REDIRECTS: usize = 10;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum DownloadError {
    #[error("only https:// URLs are downloaded")]
    NotHttps,
    #[error("download failed: {0}")]
    Network(String),
    #[error("the file is larger than allowed")]
    TooLarge,
    #[error("the file does not match its SHA-256")]
    HashMismatch,
    #[error("file error: {0}")]
    Io(String),
}

impl DownloadError {
    /// The result detail of a failed download.
    pub fn detail(&self) -> Detail {
        match self {
            DownloadError::TooLarge => Detail::TooLarge,
            DownloadError::HashMismatch => Detail::HashMismatch,
            DownloadError::NotHttps | DownloadError::Network(_) | DownloadError::Io(_) => Detail::DownloadFailed,
        }
    }
}

/// Fetches `url` into `dest` (via `<dest>.part`); `Ok` only when the file is
/// complete, at most `max_bytes` long and its SHA-256 is `expected_sha256`.
pub trait Downloader: Send + Sync {
    fn fetch<'a>(
        &'a self,
        url: &'a str,
        dest: &'a Path,
        expected_sha256: &'a str,
        max_bytes: u64,
    ) -> BoxFuture<'a, Result<(), DownloadError>>;
}

/// `<dest>.part`.
pub fn part_path(dest: &Path) -> PathBuf {
    let mut name = dest.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    name.push(".part");
    dest.with_file_name(name)
}

/// The URL when it is `https://` with a host and no user name or password in it.
pub fn check_https(url: &str) -> Result<Url, DownloadError> {
    let parsed = Url::parse(url).map_err(|_| DownloadError::NotHttps)?;
    let plain = parsed.scheme() == "https"
        && parsed.host_str().is_some_and(|host| !host.is_empty())
        && parsed.username().is_empty()
        && parsed.password().is_none();
    if plain {
        Ok(parsed)
    } else {
        Err(DownloadError::NotHttps)
    }
}

/// The redirect rule: the next hop must be `https://` (never a downgrade) and
/// there are at most `MAX_REDIRECTS` hops. Where it goes does not matter: the
/// hash decides.
pub fn redirect_allowed(next: &Url, previous_hops: usize) -> bool {
    previous_hops < MAX_REDIRECTS && next.scheme() == "https" && next.host_str().is_some()
}

/// Streams `chunks` into `<dest>.part` while hashing (see the module docs).
/// `content_length` (when the server sent one) is checked first, so an oversized
/// file is refused before a byte is written. A chunk that takes longer than
/// `stall` fails the download.
pub async fn write_stream<S>(
    mut chunks: S,
    content_length: Option<u64>,
    dest: &Path,
    expected_sha256: &str,
    max_bytes: u64,
    stall: Duration,
) -> Result<(), DownloadError>
where
    S: Stream<Item = Result<Bytes, String>> + Unpin,
{
    if content_length.is_some_and(|length| length > max_bytes) {
        return Err(DownloadError::TooLarge);
    }
    let part = part_path(dest);
    let io = |e: std::io::Error| DownloadError::Io(e.to_string());
    let result = async {
        let mut file = tokio::fs::File::create(&part).await.map_err(io)?;
        let mut hasher = Sha256::new();
        let mut total: u64 = 0;
        loop {
            let next = tokio::time::timeout(stall, chunks.next())
                .await
                .map_err(|_| DownloadError::Network("no data for 60 s".into()))?;
            let Some(chunk) = next else { break };
            let chunk = chunk.map_err(DownloadError::Network)?;
            total = total.saturating_add(chunk.len() as u64);
            if total > max_bytes {
                return Err(DownloadError::TooLarge);
            }
            hasher.update(&chunk);
            file.write_all(&chunk).await.map_err(io)?;
        }
        file.flush().await.map_err(io)?;
        file.sync_all().await.map_err(io)?;
        drop(file);
        if hex_lower(&hasher.finalize()) != expected_sha256 {
            return Err(DownloadError::HashMismatch);
        }
        tokio::fs::rename(&part, dest).await.map_err(io)
    }
    .await;
    if result.is_err() {
        // Nothing half-written stays behind (and nothing unverified under `dest`).
        let _ = remove_file_if_exists(&part);
        if result == Err(DownloadError::HashMismatch) {
            let _ = remove_file_if_exists(dest);
        }
    }
    result
}

/// The real downloader.
pub struct HttpDownloader {
    client: reqwest::Client,
}

impl HttpDownloader {
    pub fn new() -> Result<Self, DownloadError> {
        let policy = reqwest::redirect::Policy::custom(|attempt| {
            if redirect_allowed(attempt.url(), attempt.previous().len()) {
                attempt.follow()
            } else {
                attempt.error("redirect refused (not https:// or too many)")
            }
        });
        let client = reqwest::Client::builder()
            .https_only(true)
            .redirect(policy)
            .connect_timeout(CONNECT_TIMEOUT)
            .read_timeout(STALL_TIMEOUT)
            .user_agent(concat!("rulebox-agent/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|e| DownloadError::Network(e.without_url().to_string()))?;
        Ok(Self { client })
    }
}

impl Downloader for HttpDownloader {
    fn fetch<'a>(
        &'a self,
        url: &'a str,
        dest: &'a Path,
        expected_sha256: &'a str,
        max_bytes: u64,
    ) -> BoxFuture<'a, Result<(), DownloadError>> {
        async move {
            let url = check_https(url)?;
            let response = self
                .client
                .get(url)
                .send()
                .await
                .map_err(|e| DownloadError::Network(e.without_url().to_string()))?;
            if !response.status().is_success() {
                return Err(DownloadError::Network(format!("HTTP {}", response.status().as_u16())));
            }
            // The final URL after redirects must still be https (reqwest's
            // `https_only` and the policy above already enforce it).
            if response.url().scheme() != "https" {
                return Err(DownloadError::NotHttps);
            }
            let length = response.content_length();
            let chunks = response.bytes_stream().map(|chunk| chunk.map_err(|e| e.without_url().to_string()));
            write_stream(Box::pin(chunks), length, dest, expected_sha256, max_bytes, STALL_TIMEOUT).await
        }
        .boxed()
    }
}

/// (Tests) A downloader that serves scripted bytes through [`write_stream`] (so the
/// real hashing, size and rename rules run), fails on request, can be held at the
/// start of a download, and never touches the network.
#[cfg(test)]
pub mod fake {
    use super::*;
    use std::collections::{HashMap, VecDeque};
    use std::sync::{Arc, Mutex};

    use tokio::sync::Semaphore;

    use crate::state::lock;

    #[derive(Default)]
    struct Inner {
        files: HashMap<String, Vec<u8>>,
        failures: HashMap<String, VecDeque<DownloadError>>,
        calls: Vec<String>,
    }

    #[derive(Clone, Default)]
    pub struct FakeDownloader {
        inner: Arc<Mutex<Inner>>,
        /// When set, every fetch waits for a permit (tests release them one by one).
        gate: Arc<Mutex<Option<Arc<Semaphore>>>>,
    }

    impl FakeDownloader {
        pub fn new() -> Self {
            Self::default()
        }

        pub fn serve(&self, url: &str, bytes: &[u8]) {
            lock(&self.inner).files.insert(url.to_string(), bytes.to_vec());
        }

        pub fn fail_next(&self, url: &str, error: DownloadError) {
            lock(&self.inner).failures.entry(url.to_string()).or_default().push_back(error);
        }

        /// Every fetch from now on waits for `release`.
        pub fn hold(&self) -> Arc<Semaphore> {
            let semaphore = Arc::new(Semaphore::new(0));
            *lock(&self.gate) = Some(Arc::clone(&semaphore));
            semaphore
        }

        /// The URLs fetched so far (started), in order.
        pub fn calls(&self) -> Vec<String> {
            lock(&self.inner).calls.clone()
        }
    }

    impl Downloader for FakeDownloader {
        fn fetch<'a>(
            &'a self,
            url: &'a str,
            dest: &'a Path,
            expected_sha256: &'a str,
            max_bytes: u64,
        ) -> BoxFuture<'a, Result<(), DownloadError>> {
            async move {
                check_https(url)?;
                lock(&self.inner).calls.push(url.to_string());
                let gate = lock(&self.gate).clone();
                if let Some(gate) = gate {
                    gate.acquire().await.map_err(|_| DownloadError::Network("closed".into()))?.forget();
                }
                let failure = lock(&self.inner).failures.get_mut(url).and_then(VecDeque::pop_front);
                if let Some(error) = failure {
                    let _ = remove_file_if_exists(&part_path(dest));
                    return Err(error);
                }
                let bytes = lock(&self.inner).files.get(url).cloned();
                let Some(bytes) = bytes else {
                    return Err(DownloadError::Network("HTTP 404".into()));
                };
                let length = bytes.len() as u64;
                let chunks: Vec<Result<Bytes, String>> =
                    bytes.chunks(7).map(|c| Ok(Bytes::copy_from_slice(c))).collect();
                write_stream(futures_util::stream::iter(chunks), Some(length), dest, expected_sha256, max_bytes, STALL_TIMEOUT)
                    .await
            }
            .boxed()
        }
    }

    /// A downloader for agent tests that must never download anything.
    pub struct NoDownloads;

    impl Downloader for NoDownloads {
        fn fetch<'a>(&'a self, _: &'a str, _: &'a Path, _: &'a str, _: u64) -> BoxFuture<'a, Result<(), DownloadError>> {
            std::future::ready(Err(DownloadError::Network("downloads are off in this test".into()))).boxed()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempDir;

    fn sha(bytes: &[u8]) -> String {
        hex_lower(&Sha256::digest(bytes))
    }

    fn stream(parts: Vec<Result<&'static [u8], &'static str>>) -> impl Stream<Item = Result<Bytes, String>> + Unpin {
        futures_util::stream::iter(
            parts.into_iter().map(|p| p.map(Bytes::from_static).map_err(str::to_string)).collect::<Vec<_>>(),
        )
    }

    #[tokio::test]
    async fn a_matching_stream_is_renamed_into_place() {
        let dir = TempDir::new();
        let dest = dir.path().join("x.msi");
        let ok = write_stream(stream(vec![Ok(b"hello "), Ok(b"world")]), Some(11), &dest, &sha(b"hello world"), 100, STALL_TIMEOUT).await;
        assert_eq!(ok, Ok(()));
        assert_eq!(std::fs::read(&dest).unwrap(), b"hello world");
        assert!(!part_path(&dest).exists());
    }

    #[tokio::test]
    async fn hash_mismatch_deletes_the_file() {
        let dir = TempDir::new();
        let dest = dir.path().join("x.msi");
        let result = write_stream(stream(vec![Ok(b"evil")]), None, &dest, &sha(b"good"), 100, STALL_TIMEOUT).await;
        assert_eq!(result, Err(DownloadError::HashMismatch));
        assert_eq!(result.unwrap_err().detail(), Detail::HashMismatch);
        assert!(!dest.exists() && !part_path(&dest).exists(), "nothing stays on disk");
    }

    #[tokio::test]
    async fn size_over_limit_refused() {
        let dir = TempDir::new();
        let dest = dir.path().join("x.exe");
        // Announced too large: refused before anything is written.
        let early = write_stream(stream(vec![Ok(b"12345")]), Some(5), &dest, &sha(b"12345"), 4, STALL_TIMEOUT).await;
        assert_eq!(early, Err(DownloadError::TooLarge));
        assert!(!part_path(&dest).exists());
        // Not announced (or lying): refused once the bytes pass the limit.
        let late = write_stream(stream(vec![Ok(b"123"), Ok(b"45")]), Some(3), &dest, &sha(b"12345"), 4, STALL_TIMEOUT).await;
        assert_eq!(late, Err(DownloadError::TooLarge));
        assert_eq!(late.unwrap_err().detail(), Detail::TooLarge);
        assert!(!dest.exists() && !part_path(&dest).exists());
    }

    #[tokio::test]
    async fn a_network_cut_leaves_nothing_behind() {
        let dir = TempDir::new();
        let dest = dir.path().join("x.exe");
        let cut = write_stream(stream(vec![Ok(b"half"), Err("connection reset")]), Some(8), &dest, &sha(b"halfhalf"), 100, STALL_TIMEOUT).await;
        assert_eq!(cut, Err(DownloadError::Network("connection reset".into())));
        assert_eq!(cut.unwrap_err().detail(), Detail::DownloadFailed);
        assert!(!dest.exists() && !part_path(&dest).exists());
    }

    #[tokio::test(start_paused = true)]
    async fn a_stalled_download_fails() {
        let dir = TempDir::new();
        let dest = dir.path().join("x.exe");
        let never = futures_util::stream::pending::<Result<Bytes, String>>();
        let result = write_stream(Box::pin(never), None, &dest, &sha(b""), 100, STALL_TIMEOUT).await;
        assert!(matches!(result, Err(DownloadError::Network(_))), "{result:?}");
        assert!(!part_path(&dest).exists());
    }

    #[test]
    fn http_url_refused() {
        assert!(check_https("https://github.com/ip7z/7zip/releases/download/26.00/7z2600-x64.msi").is_ok());
        assert!(check_https("HTTPS://example.com/a.msi").is_ok());
        for bad in [
            "http://example.com/a.msi",
            "ftp://example.com/a.msi",
            "file:///C:/Windows/System32/cmd.exe",
            "\\\\server\\share\\a.msi",
            "C:\\a.msi",
            "https://user:pw@example.com/a.msi",
            "https://",
            "",
            "not a url",
        ] {
            assert_eq!(check_https(bad), Err(DownloadError::NotHttps), "{bad:?}");
        }
    }

    #[test]
    fn redirects_must_stay_https_and_are_bounded() {
        let https = Url::parse("https://objects.githubusercontent.com/x").unwrap();
        let http = Url::parse("http://objects.githubusercontent.com/x").unwrap();
        // Any https host is fine: the hash is the authority, not the host.
        assert!(redirect_allowed(&https, 0));
        assert!(redirect_allowed(&https, MAX_REDIRECTS - 1));
        assert!(!redirect_allowed(&https, MAX_REDIRECTS));
        assert!(!redirect_allowed(&http, 0), "never a downgrade");
        assert!(!redirect_allowed(&Url::parse("file:///C:/x.msi").unwrap(), 0));
    }

    #[test]
    fn the_http_downloader_builds_without_network() {
        // Building the client opens no connection (the tests never download).
        assert!(HttpDownloader::new().is_ok());
    }

    #[tokio::test]
    async fn the_http_downloader_refuses_http_before_any_request() {
        let dir = TempDir::new();
        let downloader = HttpDownloader::new().unwrap();
        let dest = dir.path().join("x.msi");
        let result = downloader.fetch("http://127.0.0.1:9/x.msi", &dest, &sha(b""), 10).await;
        assert_eq!(result, Err(DownloadError::NotHttps));
        assert!(!dest.exists() && !part_path(&dest).exists());
    }
}
