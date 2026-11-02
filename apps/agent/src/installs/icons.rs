//! The icon cache (plan Step 14 item 6): a catalogue entry's `icon` (a Convex
//! storage URL and the file's SHA-256) is downloaded once into
//! `<data>\icons\<sha256>.png`, at most 32 KiB, `https://` only and only from the
//! Convex deployment this PC is enrolled with. `apps.list` reads the file (and
//! checks its hash again) into `iconPngBase64`. Any failure leaves the icon empty:
//! the Staff App draws a letter tile.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use rulebox_policy::catalog::{CatalogApp, IconRef};
use sha2::{Digest, Sha256};

use super::download::{check_https, part_path, Downloader};
use super::{hex_lower, is_sha256};
use crate::state::remove_file_if_exists;

pub const MAX_ICON_BYTES: u64 = 32 * 1024;
/// (Review fix) One icon (at most 32 KiB) gets this long, however slowly it drips.
pub const ICON_DEADLINE: std::time::Duration = std::time::Duration::from_secs(60);

/// `<dir>\<sha256>.png`, or `None` for a hash that is not one (never a path).
pub fn icon_file(dir: &Path, sha256: &str) -> Option<PathBuf> {
    is_sha256(sha256).then(|| dir.join(format!("{sha256}.png")))
}

/// `url` is `https://` on the same host (and port) as the deployment URL.
pub fn icon_url_allowed(url: &str, deployment_url: &str) -> bool {
    let (Ok(icon), Ok(deployment)) = (check_https(url), check_https(deployment_url)) else {
        return false;
    };
    let same_host = icon
        .host_str()
        .zip(deployment.host_str())
        .is_some_and(|(a, b)| a.eq_ignore_ascii_case(b));
    same_host && icon.port_or_known_default() == deployment.port_or_known_default()
}

/// Downloads the icons of `catalog` that are not cached yet. `tried` holds the
/// hashes already attempted in this run (a failing icon is not fetched in a loop).
/// Returns true when at least one new icon arrived.
pub async fn fetch_missing(
    catalog: &[CatalogApp],
    deployment_url: Option<&str>,
    downloader: &dyn Downloader,
    dir: &Path,
    tried: &mut HashSet<String>,
) -> bool {
    let Some(deployment_url) = deployment_url else {
        return false;
    };
    let mut any = false;
    for app in catalog {
        let Some(icon) = &app.icon else { continue };
        let Some(path) = icon_file(dir, &icon.sha256) else { continue };
        if path.is_file() || !tried.insert(icon.sha256.clone()) {
            continue;
        }
        if !icon_url_allowed(&icon.url, deployment_url) {
            tracing::warn!(app_id = %app.id, "icon skipped: not an https:// URL of this PC's deployment");
            continue;
        }
        if let Err(error) = std::fs::create_dir_all(dir) {
            tracing::warn!("cannot create the icon folder: {error}");
            return any;
        }
        match tokio::time::timeout(ICON_DEADLINE, downloader.fetch(&icon.url, &path, &icon.sha256, MAX_ICON_BYTES)).await {
            Ok(Ok(())) => any = true,
            Ok(Err(error)) => tracing::warn!(app_id = %app.id, "icon not downloaded: {error}"),
            Err(_) => {
                tracing::warn!(app_id = %app.id, "icon not downloaded in time");
                let _ = remove_file_if_exists(&part_path(&path));
            }
        }
    }
    any
}

/// The cached icon as base64, when it is there, small enough and still matches.
pub fn icon_base64(dir: &Path, icon: &IconRef) -> Option<String> {
    let path = icon_file(dir, &icon.sha256)?;
    let bytes = std::fs::read(path).ok()?;
    if bytes.len() as u64 > MAX_ICON_BYTES || hex_lower(&Sha256::digest(&bytes)) != icon.sha256 {
        return None;
    }
    Some(STANDARD.encode(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::installs::download::fake::FakeDownloader;
    use crate::testutil::TempDir;
    use serde_json::json;

    const DEPLOYMENT: &str = "https://happy-otter-123.convex.cloud";

    fn sha(bytes: &[u8]) -> String {
        hex_lower(&Sha256::digest(bytes))
    }

    fn app_with_icon(id: &str, url: &str, bytes: &[u8]) -> CatalogApp {
        serde_json::from_value(json!({
            "id": id, "name": id, "description": null, "kind": "web", "builtin": null,
            "web": { "url": "https://orders.example.test/", "allowedDomains": [], "permissions": {
                "camera": false, "microphone": false, "screenShare": false, "clipboardRead": false,
                "notifications": false, "downloads": false, "printing": false, "geolocation": false } },
            "desktop": null, "pinnedTaskbar": false, "pinnedDesktop": false, "hue": null,
            "icon": { "url": url, "sha256": sha(bytes) },
            "audience": "everyone", "employeeIds": [], "revision": 1
        }))
        .unwrap()
    }

    #[test]
    fn icon_from_other_host_refused() {
        assert!(icon_url_allowed("https://happy-otter-123.convex.cloud/api/storage/abc", DEPLOYMENT));
        assert!(icon_url_allowed("https://HAPPY-otter-123.convex.cloud:443/api/storage/abc", DEPLOYMENT));
        for bad in [
            "https://evil.example.com/api/storage/abc",
            "https://happy-otter-123.convex.cloud.evil.example.com/x",
            "https://other-deployment-9.convex.cloud/api/storage/abc",
            "http://happy-otter-123.convex.cloud/api/storage/abc",
            "https://happy-otter-123.convex.cloud:8443/api/storage/abc",
            "https://user@happy-otter-123.convex.cloud/api/storage/abc",
        ] {
            assert!(!icon_url_allowed(bad, DEPLOYMENT), "{bad}");
        }
        assert!(!icon_url_allowed("https://happy-otter-123.convex.cloud/x", "http://happy-otter-123.convex.cloud"));
    }

    #[tokio::test]
    async fn icons_are_cached_checked_and_read_back() {
        let dir = TempDir::new();
        let icons = dir.path().join("icons");
        let png = b"\x89PNG fake icon";
        let good_url = "https://happy-otter-123.convex.cloud/api/storage/1";
        let evil_url = "https://evil.example.com/api/storage/2";
        let big_url = "https://happy-otter-123.convex.cloud/api/storage/3";
        let big = vec![7u8; MAX_ICON_BYTES as usize + 1];
        let downloader = FakeDownloader::new();
        downloader.serve(good_url, png);
        downloader.serve(evil_url, b"x");
        downloader.serve(big_url, &big);
        let catalog = [app_with_icon("a", good_url, png), app_with_icon("b", evil_url, b"x"), app_with_icon("c", big_url, &big)];
        let mut tried = HashSet::new();
        assert!(fetch_missing(&catalog, Some(DEPLOYMENT), &downloader, &icons, &mut tried).await);
        // The other host is never asked; the large one is refused by size.
        assert_eq!(downloader.calls(), [good_url, big_url]);
        let icon = catalog[0].icon.clone().unwrap();
        assert_eq!(icon_base64(&icons, &icon), Some(STANDARD.encode(png)));
        assert_eq!(icon_base64(&icons, catalog[2].icon.as_ref().unwrap()), None);
        // Cached: not fetched again; a failed one is not retried in this run.
        assert!(!fetch_missing(&catalog, Some(DEPLOYMENT), &downloader, &icons, &mut tried).await);
        assert_eq!(downloader.calls().len(), 2);
        // A file changed on disk no longer matches: no icon.
        std::fs::write(icon_file(&icons, &icon.sha256).unwrap(), b"changed").unwrap();
        assert_eq!(icon_base64(&icons, &icon), None);
        // Not enrolled anywhere: nothing.
        assert!(!fetch_missing(&catalog, None, &downloader, &icons, &mut HashSet::new()).await);
    }

    #[tokio::test(start_paused = true)]
    async fn a_stalled_icon_gives_up_after_its_deadline() {
        let dir = TempDir::new();
        let icons = dir.path().join("icons");
        let url = "https://happy-otter-123.convex.cloud/api/storage/1";
        let downloader = FakeDownloader::new();
        downloader.serve(url, b"png");
        // Held forever: the server never answers.
        let _gate = downloader.hold();
        let catalog = [app_with_icon("a", url, b"png")];
        let mut tried = HashSet::new();
        let started = tokio::time::Instant::now();
        assert!(!fetch_missing(&catalog, Some(DEPLOYMENT), &downloader, &icons, &mut tried).await);
        assert!(started.elapsed() >= ICON_DEADLINE && started.elapsed() < ICON_DEADLINE * 2);
        assert!(std::fs::read_dir(&icons).unwrap().next().is_none(), "nothing left behind");
    }
}
