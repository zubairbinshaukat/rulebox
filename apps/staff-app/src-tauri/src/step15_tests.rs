//! Step 15 tests (web app windows): the pure rules. The WebView2 hooks and the
//! windows themselves are checked by running the app (see the plan's Verify).
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

use rulebox_staff_lib::files::saferoot::{FileError, SafeRoot};
use rulebox_staff_lib::files::FileSession;
use rulebox_staff_lib::model::WebPermissions;
use rulebox_staff_lib::webapp::allow::{AllowList, WebError};
use rulebox_staff_lib::webapp::blocked;
use rulebox_staff_lib::webapp::download::{
    clean_download_name, decide_download, destination, finish, is_blocked_name, DownloadDecision, Finished,
};
use rulebox_staff_lib::webapp::permissions::{decide, denial_notice, Decision, PermissionKind};

struct TempRoot(PathBuf);

impl TempRoot {
    fn new(tag: &str) -> TempRoot {
        static N: AtomicU32 = AtomicU32::new(0);
        let base = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../target/files-tests");
        let dir = base.join(format!("web-{tag}-{}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        TempRoot(dunce::canonicalize(&dir).unwrap())
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempRoot {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

// ---------------------------------------------------------------------------
// The allow-list.
// ---------------------------------------------------------------------------

fn allow(primary: &str, extra: &[&str]) -> AllowList {
    let extra: Vec<String> = extra.iter().map(|s| (*s).to_string()).collect();
    AllowList::new(primary, &extra).unwrap()
}

#[test]
fn allow_list_matches_the_host_and_its_subdomains_only() {
    let list = allow("https://example.com/start", &[]);
    for yes in [
        "https://example.com/",
        "https://example.com/a/b?c=d#e",
        "https://www.example.com/",
        "https://a.b.example.com/x",
        "https://EXAMPLE.com/",
        "https://Www.Example.COM/",
        "https://example.com./",
        "https://example.com:443/",
    ] {
        assert!(list.allows(yes), "{yes} must be allowed");
    }
    for no in [
        "https://evil-example.com/",
        "https://notexample.com/",
        "https://example.com.evil.net/",
        "https://example.com.evil.net:443/",
        "https://example.org/",
        "https://com/",
        "https://iana.org/",
        "https://xexample.com/",
        "https://example.com@evil.net/",
        "https://evil.net/example.com",
        "https://evil.net/?u=example.com",
        "",
        "not a url",
        "example.com",
    ] {
        assert!(!list.allows(no), "{no} must be refused");
    }
}

#[test]
fn only_https_passes() {
    let list = allow("https://example.com/", &[]);
    for no in [
        "http://example.com/",
        "ftp://example.com/",
        "file:///C:/Windows/win.ini",
        "javascript:alert(1)",
        "data:text/html,hi",
        "about:blank",
        "blob:https://example.com/abc",
        "ws://example.com/",
        "wss://example.com/",
    ] {
        assert!(!list.allows(no), "{no} must be refused");
    }
}

#[test]
fn a_login_in_the_address_is_refused() {
    let list = allow("https://example.com/", &[]);
    assert!(!list.allows("https://user@example.com/"));
    assert!(!list.allows("https://user:pass@example.com/"));
}

#[test]
fn ports_must_be_listed() {
    let list = allow("https://example.com/", &["internal.test:8443"]);
    assert!(!list.allows("https://example.com:8443/"), "a port nobody listed");
    assert!(!list.allows("https://example.com:444/"));
    assert!(list.allows("https://internal.test:8443/"));
    assert!(list.allows("https://app.internal.test:8443/"));
    assert!(!list.allows("https://internal.test/"), "the listed port only");
    assert!(!list.allows("https://internal.test:9443/"));
    let with_port = allow("https://example.com:8443/app", &[]);
    assert!(with_port.allows("https://example.com:8443/x"));
    assert!(!with_port.allows("https://example.com/x"));
}

#[test]
fn extra_domains_widen_the_list_and_bad_ones_are_ignored() {
    let list = allow("https://portal.company.com/", &["cdn.company.com", " Static.Company.com ", "", "http://plain.example", "https://", "not a domain!"]);
    assert!(list.allows("https://cdn.company.com/a.js"));
    assert!(list.allows("https://static.company.com/"));
    assert!(list.allows("https://eu.cdn.company.com/"));
    assert!(!list.allows("https://company.com/"), "a parent of an allowed host is not allowed");
    assert!(!list.allows("https://plain.example/"), "an http entry never allows anything");
    assert!(!list.allows("https://other.com/"));
    assert_eq!(list.hosts().len(), 3);
}

#[test]
fn ip_addresses_match_only_an_identical_entry() {
    let list = allow("https://10.0.0.5/", &["192.168.1.0"]);
    assert!(list.allows("https://10.0.0.5/"));
    assert!(!list.allows("https://10.0.0.6/"));
    // A shorter entry must not make longer addresses its "subdomains".
    let short = allow("https://example.com/", &["0.5"]);
    assert!(!short.allows("https://10.0.0.5/"));
    let ip_list = allow("https://10.0.0.5/", &[]);
    assert!(!ip_list.allows("https://0.5/"));
    assert!(!ip_list.allows("https://[::1]/"));
    let v6 = allow("https://[2001:db8::1]/", &[]);
    assert!(v6.allows("https://[2001:db8::1]/x"));
    assert!(!v6.allows("https://[2001:db8::2]/x"));
}

#[test]
fn look_alike_hosts_do_not_pass() {
    let list = allow("https://example.com/", &[]);
    // A punycode look-alike is a different host name.
    assert!(!list.allows("https://xn--exmple-cua.com/"));
    assert!(!list.allows("https://еxample.com/"), "Cyrillic е");
    assert!(!list.allows("https://example.com%2eevil.net/"));
    // A backslash is a slash in a web address: this really is example.com, with a strange path.
    assert!(list.allows("https://example.com\\@evil.net/"));
}

#[test]
fn the_primary_address_must_be_https_with_a_host() {
    assert_eq!(AllowList::new("http://example.com/", &[]).unwrap_err(), WebError::NotHttps);
    assert_eq!(AllowList::new("not a url", &[]).unwrap_err(), WebError::BadUrl);
    assert!(AllowList::new("https://example.com", &[]).is_ok());
    assert!(AllowList::new("mailto:a@b.c", &[]).is_err());
}

// ---------------------------------------------------------------------------
// The blocked page.
// ---------------------------------------------------------------------------

#[test]
fn the_blocked_page_names_the_host_as_text_and_links_back() {
    let url = blocked::blocked_url("iana.org", "https://example.com/").unwrap();
    assert!(blocked::is_blocked_page(&url));
    let html = blocked::render(&url);
    assert!(html.contains("This site is not allowed"));
    assert!(html.contains("<strong>iana.org</strong>"));
    assert!(html.contains(r#"<a href="https://example.com/">Go back</a>"#));
    assert!(!html.contains("<script"), "no script, ever");
}

#[test]
fn the_blocked_page_escapes_what_it_shows_and_only_links_to_https() {
    let url = blocked::blocked_url(r#"<img src=x onerror="alert(1)">"#, "javascript:alert(1)").unwrap();
    let html = blocked::render(&url);
    assert!(!html.contains("<img"));
    assert!(html.contains("&lt;img"));
    assert!(!html.contains("javascript:"), "no link back to a non-https address");
    assert!(!html.contains("Go back"));
    let tricky = blocked::blocked_url("x", r#"https://example.com/"><script>alert(1)</script>"#).unwrap();
    let html = blocked::render(&tricky);
    assert!(!html.contains("<script"));
    assert!(html.contains("&quot;&gt;&lt;script&gt;"));
}

#[test]
fn only_the_local_blocked_address_counts_as_the_blocked_page() {
    use tauri::Url;
    assert!(blocked::is_blocked_page(&Url::parse("http://rbblocked.localhost/?host=a&back=b").unwrap()));
    assert!(!blocked::is_blocked_page(&Url::parse("https://rbblocked.localhost/").unwrap()));
    assert!(!blocked::is_blocked_page(&Url::parse("http://rbblocked.localhost.evil.net/").unwrap()));
    // A port would reach a real loopback server; user info and other paths are not the page.
    assert!(!blocked::is_blocked_page(&Url::parse("http://rbblocked.localhost:8080/").unwrap()));
    assert!(!blocked::is_blocked_page(&Url::parse("http://user:pw@rbblocked.localhost/").unwrap()));
    assert!(!blocked::is_blocked_page(&Url::parse("http://rbblocked.localhost/other").unwrap()));
    assert!(!blocked::is_blocked_page(&Url::parse("http://rbfile.localhost/a.txt").unwrap()));
    assert!(!blocked::is_blocked_page(&Url::parse("http://tauri.localhost/").unwrap()));
}

// ---------------------------------------------------------------------------
// Permissions.
// ---------------------------------------------------------------------------

#[test]
fn permission_decisions_follow_the_apps_rules() {
    let none = WebPermissions {
        camera: false,
        microphone: false,
        screen_share: false,
        clipboard_read: false,
        notifications: false,
        downloads: false,
        printing: false,
        geolocation: false,
    };
    let all = WebPermissions {
        camera: true,
        microphone: true,
        screen_share: true,
        clipboard_read: true,
        notifications: true,
        downloads: true,
        printing: true,
        geolocation: true,
    };
    let table = [
        (PermissionKind::Camera, WebPermissions { camera: true, ..none }),
        (PermissionKind::Microphone, WebPermissions { microphone: true, ..none }),
        (PermissionKind::Geolocation, WebPermissions { geolocation: true, ..none }),
        (PermissionKind::Notifications, WebPermissions { notifications: true, ..none }),
        (PermissionKind::ClipboardRead, WebPermissions { clipboard_read: true, ..none }),
    ];
    for (kind, only_this) in table {
        assert_eq!(decide(kind, &only_this, true), Decision::Allow, "{kind:?} when allowed");
        assert_eq!(decide(kind, &none, true), Decision::Deny, "{kind:?} when not");
        assert_eq!(decide(kind, &all, false), Decision::Deny, "{kind:?} from an address outside the list");
    }
    // Camera allowed does not let the microphone through.
    assert_eq!(decide(PermissionKind::Microphone, &WebPermissions { camera: true, ..none }, true), Decision::Deny);
    // Unknown kinds are refused even when everything known is allowed.
    assert_eq!(decide(PermissionKind::Other, &all, true), Decision::Deny);
    // Autoplay is not a policy item, but still only for allowed addresses.
    assert_eq!(decide(PermissionKind::Autoplay, &none, true), Decision::Allow);
    assert_eq!(decide(PermissionKind::Autoplay, &none, false), Decision::Deny);
    assert_eq!(denial_notice(PermissionKind::Microphone), "Microphone is not allowed for this app.");
    assert_eq!(denial_notice(PermissionKind::Camera), "Camera is not allowed for this app.");
}

#[test]
fn the_default_permissions_allow_downloads_and_notifications_only() {
    let defaults = WebPermissions::default();
    assert!(defaults.downloads && defaults.notifications);
    assert!(!defaults.camera && !defaults.microphone && !defaults.geolocation);
    assert!(!defaults.screen_share && !defaults.clipboard_read && !defaults.printing);
    assert_eq!(decide(PermissionKind::Camera, &defaults, true), Decision::Deny);
}

// ---------------------------------------------------------------------------
// Downloads.
// ---------------------------------------------------------------------------

#[test]
fn download_names_are_cleaned() {
    assert_eq!(clean_download_name("report.pdf"), "report.pdf");
    assert_eq!(clean_download_name("../../Windows/System32/evil.dll"), "evil.dll");
    assert_eq!(clean_download_name(r"C:\Users\x\Desktop\a.txt"), "a.txt");
    assert_eq!(clean_download_name("a/b\\c.txt"), "c.txt");
    assert_eq!(clean_download_name(".."), "download");
    assert_eq!(clean_download_name("..."), "download");
    assert_eq!(clean_download_name(""), "download");
    assert_eq!(clean_download_name("   "), "download");
    assert_eq!(clean_download_name("name. . ."), "name");
    assert_eq!(clean_download_name("trailing space.txt "), "trailing space.txt");
    assert_eq!(clean_download_name("a:b*c?d.txt"), "a_b_c_d.txt");
    assert_eq!(clean_download_name("bad\u{202e}gnp.exe"), "bad_gnp.exe");
    assert_eq!(clean_download_name("tab\there.txt"), "tab_here.txt");
    assert_eq!(clean_download_name(".rulebox-trash"), "_.rulebox-trash");
    for reserved in ["CON", "nul", "COM1.txt", "lpt9.tar.gz", "AUX"] {
        let cleaned = clean_download_name(reserved);
        assert!(cleaned.starts_with('_'), "{reserved} -> {cleaned}");
    }
}

#[test]
fn long_download_names_are_cut_and_keep_their_extension() {
    let long = format!("{}.pdf", "a".repeat(300));
    let cleaned = clean_download_name(&long);
    assert_eq!(cleaned.chars().count(), 120);
    assert!(cleaned.ends_with(".pdf"));
    let no_ext = clean_download_name(&"b".repeat(300));
    assert_eq!(no_ext.chars().count(), 120);
    let multibyte = clean_download_name(&"é".repeat(200));
    assert_eq!(multibyte.chars().count(), 120);
    for name in [&cleaned, &no_ext, &multibyte] {
        assert!(rulebox_staff_lib::files::names::check_component(name).is_ok());
    }
}

#[test]
fn every_cleaned_name_is_a_valid_file_name() {
    for nasty in ["CON", "con.", "a<b>c", "x\u{0}y", "..\\..\\x", "NUL.txt", "  ", "?", "COM9", "A\u{2066}B", "dir/"] {
        let cleaned = clean_download_name(nasty);
        assert!(
            rulebox_staff_lib::files::names::check_component(&cleaned).is_ok(),
            "{nasty:?} -> {cleaned:?}"
        );
    }
}

#[test]
fn the_download_decision_table() {
    use DownloadDecision::*;
    //                 downloads allowed, blocked type, quota full
    assert_eq!(decide_download(true, false, false), Allow);
    assert_eq!(decide_download(false, false, false), NotAllowed);
    assert_eq!(decide_download(true, true, false), BlockedType);
    assert_eq!(decide_download(true, false, true), QuotaFull);
    // The first reason wins: permission, then type, then space.
    assert_eq!(decide_download(false, true, true), NotAllowed);
    assert_eq!(decide_download(true, true, true), BlockedType);
    assert!(is_blocked_name("setup.exe"));
    assert!(is_blocked_name("macro.docm"));
    assert!(is_blocked_name("page.html"));
    assert!(!is_blocked_name("report.pdf"));
    assert!(!is_blocked_name("notes.txt"));
    assert!(!is_blocked_name("archive.zip"));
}

#[test]
fn downloads_land_in_the_downloads_folder_and_never_overwrite() {
    let temp = TempRoot::new("dest");
    let root = SafeRoot::open(temp.path()).unwrap();
    let first = destination(&root, "report.pdf").unwrap();
    assert_eq!(first, root.root_path().join("Downloads").join("report.pdf"));
    assert!(root.root_path().join("Downloads").is_dir(), "the folder is created");
    std::fs::write(&first, b"x").unwrap();
    let second = destination(&root, "report.pdf").unwrap();
    assert_eq!(second, root.root_path().join("Downloads").join("report (1).pdf"));
    std::fs::write(&second, b"x").unwrap();
    assert_eq!(destination(&root, "report.pdf").unwrap().file_name().unwrap(), "report (2).pdf");
    // A hostile suggestion cannot leave the folder.
    let escaped = destination(&root, "../../evil.txt").unwrap();
    assert_eq!(escaped, root.root_path().join("Downloads").join("evil.txt"));
    // The folder being a file is an error, not an overwrite.
    let temp2 = TempRoot::new("dest-file");
    std::fs::write(temp2.path().join("Downloads"), b"i am a file").unwrap();
    let root2 = SafeRoot::open(temp2.path()).unwrap();
    assert!(destination(&root2, "a.txt").is_err());
    let _ = FileError::NotFound;
}

#[test]
fn simultaneous_downloads_of_one_name_get_different_files() {
    let temp = TempRoot::new("dest-race");
    let root = Arc::new(SafeRoot::open(temp.path()).unwrap());
    // Nobody writes anything: a name is claimed the moment it is handed out.
    let workers: Vec<_> = (0..16)
        .map(|_| {
            let root = Arc::clone(&root);
            std::thread::spawn(move || destination(&root, "report.pdf").unwrap())
        })
        .collect();
    let mut paths: Vec<PathBuf> = workers.into_iter().map(|w| w.join().unwrap()).collect();
    paths.sort();
    paths.dedup();
    assert_eq!(paths.len(), 16, "every download got its own file name");
    assert!(paths.iter().all(|p| p.is_file()), "each name is already claimed on disk");
    assert!(paths.contains(&root.root_path().join("Downloads").join("report.pdf")));
    assert!(paths.contains(&root.root_path().join("Downloads").join("report (15).pdf")));
}

#[test]
fn the_first_navigation_target_is_only_about_blank() {
    let blank = tauri::Url::parse(blocked::BLANK).unwrap();
    assert!(blocked::is_blank_page(&blank));
    for other in ["about:blank#x", "about:blank?x", "about:srcdoc", "https://example.com/", "data:text/html,x"] {
        assert!(!blocked::is_blank_page(&tauri::Url::parse(other).unwrap()), "{other}");
    }
}

fn session(temp: &TempRoot, quota: u64) -> Arc<FileSession> {
    FileSession::open(temp.path(), quota, Arc::new(|_, _| {})).unwrap()
}

#[test]
fn a_finished_download_is_checked_and_a_disguised_program_is_removed() {
    let temp = TempRoot::new("finish");
    let s = session(&temp, 0);
    std::fs::create_dir(temp.path().join("Downloads")).unwrap();
    let good = temp.path().join("Downloads").join("report.pdf");
    std::fs::write(&good, b"%PDF-1.7 fine").unwrap();
    assert_eq!(finish(&s, &good, true), Finished::Saved { name: "report.pdf".into() });
    assert!(good.exists());

    let exe_as_pdf = temp.path().join("Downloads").join("invoice.pdf");
    std::fs::write(&exe_as_pdf, b"MZ\x90\0\x03\0\0\0 program").unwrap();
    assert_eq!(finish(&s, &exe_as_pdf, true), Finished::RemovedUnsafe { name: "invoice.pdf".into() });
    assert!(!exe_as_pdf.exists());

    let exe_as_txt = temp.path().join("Downloads").join("readme.txt");
    std::fs::write(&exe_as_txt, b"MZ\x90\0\x03\0\0\0 program").unwrap();
    assert_eq!(finish(&s, &exe_as_txt, true), Finished::RemovedUnsafe { name: "readme.txt".into() });
    assert!(!exe_as_txt.exists());

    let half = temp.path().join("Downloads").join("half.zip");
    std::fs::write(&half, b"PK").unwrap();
    assert_eq!(finish(&s, &half, false), Finished::Failed);
    assert!(!half.exists(), "a failed download leaves nothing behind");
}

#[test]
fn a_download_that_pushes_the_folder_over_its_quota_is_removed() {
    let temp = TempRoot::new("finish-quota");
    std::fs::create_dir(temp.path().join("Downloads")).unwrap();
    let s = session(&temp, 1000);
    let small = temp.path().join("Downloads").join("small.bin");
    std::fs::write(&small, vec![1u8; 600]).unwrap();
    assert_eq!(finish(&s, &small, true), Finished::Saved { name: "small.bin".into() });
    let big = temp.path().join("Downloads").join("big.bin");
    std::fs::write(&big, vec![1u8; 600]).unwrap();
    assert_eq!(finish(&s, &big, true), Finished::RemovedOverQuota { name: "big.bin".into() });
    assert!(!big.exists());
    assert!(small.exists());
    assert_eq!(s.usage().used, 600);
}

#[test]
fn a_file_outside_the_employees_folder_is_never_touched() {
    let temp = TempRoot::new("finish-outside");
    let other = TempRoot::new("finish-other");
    let s = session(&temp, 0);
    let stray = other.path().join("evil.pdf");
    std::fs::write(&stray, b"MZ program").unwrap();
    assert_eq!(finish(&s, &stray, true), Finished::Misplaced);
    assert!(stray.exists(), "not even a disguised program is deleted from elsewhere");
}
