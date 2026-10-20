//! Step 12 tests (files backend). They live in the bin crate because the lib
//! test harness cannot start on this Windows + Tauri link (see `main.rs`).
//! Every test works in a fresh folder under `target\files-tests`.
#![allow(clippy::unwrap_used, clippy::expect_used)] // helpers, not only `#[test]` fns

use std::collections::BTreeMap;
use std::io::{Cursor, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

use rulebox_staff_lib::files::names::{check_component, NameRule};
use rulebox_staff_lib::files::openwith::{build_args, handler_app_id};
use rulebox_staff_lib::files::preview::{self, ImageInfo};
use rulebox_staff_lib::files::protocol::{respond, Reply, Request, MAX_RANGE};
use rulebox_staff_lib::files::quota::{changed_dir, Quota};
use rulebox_staff_lib::files::saferoot::{EntryKind, FileError, RelPath, SafeRoot};
use rulebox_staff_lib::files::types::{
    check_content, content_type, opener_for, Opener, ViewerKind, DENY,
};
use rulebox_staff_lib::files::FileSession;
use rulebox_staff_lib::model::DesktopApp;

/// A fresh folder under `target\`, removed on drop. Junctions go first so
/// `remove_dir_all` can never walk through one.
struct TempRoot(PathBuf);

impl TempRoot {
    fn new(tag: &str) -> TempRoot {
        static N: AtomicU32 = AtomicU32::new(0);
        let base = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../target/files-tests");
        let dir = base.join(format!("{tag}-{}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // `mklink` needs plain backslashes, so no `..` and no `\\?\`.
        TempRoot(dunce::canonicalize(&dir).unwrap())
    }

    fn path(&self) -> &Path {
        &self.0
    }

    fn join(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
}

fn unlink_junctions(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else { continue };
        if kind.is_symlink() {
            let _ = std::fs::remove_dir(entry.path());
        } else if kind.is_dir() {
            unlink_junctions(&entry.path());
        }
    }
}

impl Drop for TempRoot {
    fn drop(&mut self) {
        unlink_junctions(&self.0);
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn rel(text: &str) -> RelPath {
    RelPath::parse(text).unwrap()
}

/// `mklink /J` needs no privilege, which is the whole point of the test.
fn junction(link: &Path, target: &Path) {
    let status = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(link)
        .arg(target)
        .output()
        .unwrap();
    assert!(
        status.status.success(),
        "mklink failed: {}{}",
        String::from_utf8_lossy(&status.stdout),
        String::from_utf8_lossy(&status.stderr)
    );
}

fn open_session(temp: &TempRoot, quota: u64) -> Arc<FileSession> {
    FileSession::open(temp.path(), quota, Arc::new(|_, _| {})).unwrap()
}

fn wait_for_usage(session: &FileSession, expected: u64) {
    for _ in 0..300 {
        if session.usage().used == expected {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!("usage is {}, wanted {expected}", session.usage().used);
}

// ---------------------------------------------------------------------------
// Test 1: names and RelPath::parse.
// ---------------------------------------------------------------------------

#[test]
fn rel_path_parse_rejects_every_escape() {
    let long = "a".repeat(300);
    for bad in [
        "..", "a/../b", r"C:\x", r"\\server\s", "C:foo", r"\\?\C:\x", "a.txt:stream", "CON",
        "nul.txt", "x.", "x ", long.as_str(), "bad\u{202e}name", "/abs", "a//b", "a/", "a\\b",
        ".rulebox-trash", "folder/.rulebox-trash/x",
    ] {
        assert!(RelPath::parse(bad).is_err(), "{bad:?} must be refused");
    }
    assert_eq!(RelPath::parse("").unwrap(), RelPath::root());
    assert_eq!(rel("a/b c/d.txt").as_string(), "a/b c/d.txt");
    assert_eq!(rel("a/b").parent(), rel("a"));
}

#[test]
fn name_rules_say_which_rule_broke() {
    assert_eq!(check_component(""), Err(NameRule::Empty));
    assert_eq!(check_component(".."), Err(NameRule::DotName));
    assert_eq!(check_component("a:b"), Err(NameRule::BadCharacter));
    assert_eq!(check_component("x."), Err(NameRule::TrailingDotOrSpace));
    assert_eq!(check_component("Com1.tar.gz"), Err(NameRule::ReservedName));
    assert_eq!(check_component("LPT\u{b2}"), Err(NameRule::ReservedName));
    assert_eq!(check_component("a\u{202e}b"), Err(NameRule::Direction));
    assert_eq!(check_component(&"a".repeat(256)), Err(NameRule::TooLong));
    for ok in ["report.txt", "résumé.pdf", "file (1).docx", ".hidden", "COM10", "日本語.txt"] {
        assert_eq!(check_component(ok), Ok(()), "{ok}");
    }
    assert_eq!(check_component(&"a".repeat(255)), Ok(()));
}

// ---------------------------------------------------------------------------
// Tests 2 and 3: junctions.
// ---------------------------------------------------------------------------

#[test]
fn a_junction_is_not_listed_opened_or_counted() {
    let outside = TempRoot::new("outside");
    std::fs::write(outside.join("secret.txt"), vec![7u8; 5000]).unwrap();
    let temp = TempRoot::new("junction");
    std::fs::write(temp.join("mine.txt"), b"mine").unwrap();
    junction(&temp.join("link"), outside.path());
    // The OS really follows it, so the test would catch a backend that does too.
    assert!(temp.join("link/secret.txt").exists());

    let root = SafeRoot::open(temp.path()).unwrap();
    let names: Vec<_> = root.list(&RelPath::root()).unwrap().into_iter().map(|e| e.name).collect();
    assert_eq!(names, vec!["mine.txt"], "the junction is not listed");
    assert_eq!(root.used_bytes(), 4, "the size walk ignores it");
    for through in ["link/secret.txt", "link"] {
        let result = root.open_read(&rel(through));
        assert!(
            matches!(result, Err(FileError::IsReparsePoint | FileError::OutsideRoot)),
            "{through}: {result:?}"
        );
    }
    assert!(root.list(&rel("link")).is_err());
    assert!(root.stat(&rel("link")).is_err());
    assert!(root.mkdir(&rel("link/new")).is_err());
    assert!(!outside.join("new").exists());
    assert!(root.copy(&rel("mine.txt"), &rel("link")).is_err());
    assert!(!outside.join("mine.txt").exists());
    assert!(root.tree_size(&rel("link")).is_err());
    assert_eq!(root.search("secret", 10, &|| false, &mut |_| {}), 0);
    assert!(root.absolute_for_launch(&rel("link/secret.txt")).is_err());
}

#[test]
fn a_folder_swapped_for_a_junction_is_refused() {
    let outside = TempRoot::new("swap-outside");
    std::fs::write(outside.join("f.txt"), b"outside").unwrap();
    let temp = TempRoot::new("swap");
    std::fs::create_dir(temp.join("d")).unwrap();
    std::fs::write(temp.join("d/f.txt"), b"inside").unwrap();
    let root = SafeRoot::open(temp.path()).unwrap();
    assert_eq!(root.list(&rel("d")).unwrap().len(), 1);
    assert!(root.open_read(&rel("d/f.txt")).is_ok());

    // Between the list and the open, the folder becomes a junction.
    std::fs::remove_dir_all(temp.join("d")).unwrap();
    junction(&temp.join("d"), outside.path());
    let result = root.open_read(&rel("d/f.txt"));
    assert!(
        matches!(result, Err(FileError::IsReparsePoint | FileError::OutsideRoot)),
        "{result:?}"
    );
    assert!(root.list(&rel("d")).is_err());
}

#[test]
fn the_trash_folder_cannot_be_swapped_for_a_junction() {
    let outside = TempRoot::new("trash-outside");
    std::fs::write(outside.join("keep.txt"), b"keep").unwrap();
    let temp = TempRoot::new("trash-swap");
    std::fs::write(temp.join("a.txt"), b"a").unwrap();
    let root = SafeRoot::open(temp.path()).unwrap();
    root.trash(&rel("a.txt")).unwrap();
    std::fs::remove_dir_all(temp.join(".rulebox-trash")).unwrap();
    junction(&temp.join(".rulebox-trash"), outside.path());
    std::fs::write(temp.join("b.txt"), b"b").unwrap();
    assert!(root.trash(&rel("b.txt")).is_err());
    assert!(root.purge(None).is_err());
    assert!(outside.join("keep.txt").exists());
    assert!(temp.join("b.txt").exists());
}

// ---------------------------------------------------------------------------
// Tests 4 and 5: rename, copy, move, trash.
// ---------------------------------------------------------------------------

#[test]
fn rename_never_overwrites_and_allows_a_case_change() {
    let temp = TempRoot::new("rename");
    std::fs::write(temp.join("a.txt"), b"A").unwrap();
    std::fs::write(temp.join("b.txt"), b"B").unwrap();
    std::fs::create_dir(temp.join("Folder")).unwrap();
    let root = SafeRoot::open(temp.path()).unwrap();
    assert_eq!(root.rename(&rel("a.txt"), &rel("b.txt")), Err(FileError::Exists));
    assert_eq!(std::fs::read(temp.join("b.txt")).unwrap(), b"B");
    assert_eq!(root.rename(&rel("a.txt"), &rel("A.TXT")), Ok(()));
    let names: Vec<_> = root.list(&RelPath::root()).unwrap().into_iter().map(|e| e.name).collect();
    assert!(names.contains(&"A.TXT".to_string()), "{names:?}");
    assert_eq!(root.rename(&rel("Folder"), &rel("Folder/inner")), Err(FileError::IntoItself));
    assert!(matches!(root.rename(&rel("zzz"), &rel("y")), Err(FileError::NotFound)));
    assert!(RelPath::parse("bad:name").is_err());
}

#[test]
fn copy_and_move_number_taken_names() {
    let temp = TempRoot::new("copy");
    std::fs::write(temp.join("report.txt"), b"1").unwrap();
    std::fs::create_dir(temp.join("dir")).unwrap();
    std::fs::create_dir(temp.join("dir/sub")).unwrap();
    std::fs::write(temp.join("dir/sub/deep.txt"), b"deep").unwrap();
    std::fs::create_dir(temp.join("target")).unwrap();
    let root = SafeRoot::open(temp.path()).unwrap();

    assert_eq!(root.copy(&rel("report.txt"), &RelPath::root()).unwrap(), rel("report (1).txt"));
    assert_eq!(root.copy(&rel("report.txt"), &RelPath::root()).unwrap(), rel("report (2).txt"));
    assert_eq!(root.copy(&rel("dir"), &rel("target")).unwrap(), rel("target/dir"));
    assert_eq!(std::fs::read(temp.join("target/dir/sub/deep.txt")).unwrap(), b"deep");
    assert_eq!(root.copy(&rel("dir"), &rel("target")).unwrap(), rel("target/dir (1)"));
    assert_eq!(root.copy(&rel("dir"), &rel("dir/sub")), Err(FileError::IntoItself));

    assert_eq!(root.move_to(&rel("report (1).txt"), &rel("target")).unwrap(), rel("target/report (1).txt"));
    std::fs::write(temp.join("again.txt"), b"x").unwrap();
    std::fs::write(temp.join("target/again.txt"), b"y").unwrap();
    assert_eq!(root.move_to(&rel("again.txt"), &rel("target")).unwrap(), rel("target/again (1).txt"));
    assert_eq!(std::fs::read(temp.join("target/again.txt")).unwrap(), b"y", "never overwritten");
    assert_eq!(root.move_to(&rel("dir"), &rel("dir/sub")), Err(FileError::IntoItself));
    assert_eq!(root.move_to(&rel("target/again.txt"), &rel("target")).unwrap(), rel("target/again.txt"));
}

#[test]
fn trash_restore_purge_and_expiry() {
    let temp = TempRoot::new("trash");
    std::fs::write(temp.join("a.txt"), b"hello").unwrap();
    std::fs::create_dir(temp.join("docs")).unwrap();
    std::fs::write(temp.join("docs/b.txt"), b"bb").unwrap();
    let root = SafeRoot::open(temp.path()).unwrap();

    let item = root.trash(&rel("docs/b.txt")).unwrap();
    assert!(!temp.join("docs/b.txt").exists());
    assert_eq!(root.used_bytes(), 5 + 2, "the trash counts toward the quota");
    assert!(root.list(&RelPath::root()).unwrap().iter().all(|e| !e.name.starts_with(".rulebox-")));
    assert_eq!(root.trash_list().len(), 1);
    assert_eq!(root.restore(&item.id).unwrap(), rel("docs/b.txt"));
    assert_eq!(std::fs::read(temp.join("docs/b.txt")).unwrap(), b"bb");
    assert!(root.trash_list().is_empty());

    // The name is taken when it comes back: it is numbered.
    let item = root.trash(&rel("docs/b.txt")).unwrap();
    std::fs::write(temp.join("docs/b.txt"), b"new").unwrap();
    assert_eq!(root.restore(&item.id).unwrap(), rel("docs/b (1).txt"));

    // The folder is gone: it lands in the root.
    let item = root.trash(&rel("docs/b (1).txt")).unwrap();
    std::fs::remove_dir_all(temp.join("docs")).unwrap();
    assert_eq!(root.restore(&item.id).unwrap(), rel("b (1).txt"));

    // A whole folder, then empty the trash.
    std::fs::create_dir(temp.join("pics")).unwrap();
    std::fs::write(temp.join("pics/p.png"), vec![0u8; 100]).unwrap();
    let pics = root.trash(&rel("pics")).unwrap();
    assert!(pics.is_folder && pics.size == 100);
    assert_eq!(root.purge(Some("nope")), Err(FileError::NotFound));
    assert_eq!(root.purge(None).unwrap(), 100);
    assert!(root.trash_list().is_empty());
    assert_eq!(root.used_bytes(), 5 + 2, "a.txt and b (1).txt remain");

    // Old items go after 30 days.
    root.trash(&rel("a.txt")).unwrap();
    let day = 24 * 60 * 60 * 1000;
    assert_eq!(root.purge_expired(rulebox_staff_lib::files::saferoot::now_ms() + 29 * day, 30 * day), 0);
    assert_eq!(root.purge_expired(rulebox_staff_lib::files::saferoot::now_ms() + 31 * day, 30 * day), 5);
}

#[test]
fn listing_sorts_folders_first_and_hides_internal_and_odd_names() {
    let temp = TempRoot::new("list");
    std::fs::create_dir(temp.join("beta")).unwrap();
    std::fs::create_dir(temp.join("Alpha")).unwrap();
    std::fs::write(temp.join("zeta.txt"), b"12345").unwrap();
    std::fs::write(temp.join("Apple.txt"), b"1").unwrap();
    std::fs::create_dir(temp.join(".rulebox-secret")).unwrap();
    let root = SafeRoot::open(temp.path()).unwrap();
    let listing = root.list(&RelPath::root()).unwrap();
    let names: Vec<_> = listing.iter().map(|e| e.name.as_str()).collect();
    assert_eq!(names, vec!["Alpha", "beta", "Apple.txt", "zeta.txt"]);
    assert_eq!(listing[0].kind, EntryKind::Folder);
    assert_eq!(listing[3].size, 5);
    assert_eq!(listing[3].path, "zeta.txt");
    assert_eq!(root.stat(&rel("zeta.txt")).unwrap().size, 5);
    assert!(RelPath::parse(".rulebox-secret").is_err(), "internal names are not addressable");
}

#[test]
fn absolute_for_launch_is_inside_the_root_and_plain() {
    let temp = TempRoot::new("launch");
    std::fs::create_dir(temp.join("My Docs")).unwrap();
    std::fs::write(temp.join("My Docs/a b.txt"), b"x").unwrap();
    let root = SafeRoot::open(temp.path()).unwrap();
    let path = root.absolute_for_launch(&rel("My Docs/a b.txt")).unwrap();
    let text = path.to_string_lossy().to_string();
    assert!(!text.starts_with(r"\\?\"), "{text}");
    assert!(text.ends_with(r"My Docs\a b.txt"), "{text}");
    assert!(rulebox_staff_lib::files::saferoot::is_under(&path, root.root_path()));
    assert!(!rulebox_staff_lib::files::saferoot::is_under(Path::new(r"C:\Windows\x"), root.root_path()));
    assert!(!rulebox_staff_lib::files::saferoot::is_under(
        &PathBuf::from(format!("{}-evil\\x", root.root_path().display())),
        root.root_path()
    ));
}

// ---------------------------------------------------------------------------
// Tests 6 and 7: what a file may be opened with.
// ---------------------------------------------------------------------------

fn handlers(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
    pairs.iter().map(|(k, v)| ((*k).to_string(), (*v).to_string())).collect()
}

#[test]
fn deny_list_is_sorted_lowercase_and_has_the_required_types() {
    assert!(DENY.windows(2).all(|pair| pair[0] < pair[1]), "sorted, no duplicates");
    assert!(DENY.iter().all(|e| *e == e.to_lowercase() && !e.starts_with('.')));
    for required in "exe msi bat cmd com scr pif cpl ps1 psm1 psd1 ps1xml vbs vbe js jse wsf wsh ws hta lnk url scf reg inf msc msp mst jar jnlp application appref-ms appx appxbundle msix msixbundle appinstaller gadget dll sys ocx drv chm hlp iso img vhd vhdx library-ms search-ms settingcontent-ms diagcab py pyw rb pl sh xll wll html htm mht mhtml svg xml rdp".split(' ') {
        assert!(DENY.binary_search(&required).is_ok(), "{required} is missing");
    }
}

#[test]
fn opener_order_deny_then_viewer_then_handler() {
    let h = handlers(&[(".exe", "evil"), (".mkv", "vlc"), (".docx", "libreoffice")]);
    assert_eq!(opener_for("a.exe", &h), Opener::Blocked);
    assert_eq!(opener_for("a.pdf.exe", &h), Opener::Blocked);
    assert_eq!(opener_for("a.exe. ", &h), Opener::Blocked);
    assert_eq!(opener_for("A.PDF", &h), Opener::Viewer(ViewerKind::Pdf));
    assert_eq!(opener_for("a.docx", &h), Opener::Viewer(ViewerKind::Docx), "the viewer wins");
    assert_eq!(opener_for("a.mkv", &h), Opener::Handler { app_id: "vlc".into() });
    assert_eq!(opener_for("a.xyz", &h), Opener::None);
    assert_eq!(opener_for("noext", &h), Opener::None);
    assert_eq!(opener_for("a.svg", &h), Opener::Blocked, "svg is never rendered");
    assert_eq!(opener_for("a.html", &h), Opener::Blocked);
}

#[test]
fn content_is_checked_not_only_the_name() {
    assert_eq!(check_content("x.pdf", b"MZ\x90\0\x03"), Err(FileError::BlockedType));
    assert_eq!(check_content("x.txt", b"MZ\x90\0\x03"), Err(FileError::BlockedType));
    assert_eq!(check_content("x.mkv", b"\x4c\0\0\0\x01\x14\x02\0shortcut"), Err(FileError::BlockedType));
    assert_eq!(check_content("x.pdf", b"not a pdf"), Err(FileError::BlockedType));
    assert_eq!(check_content("x.pdf", b"%PDF-1.7\n"), Ok(()));
    assert_eq!(check_content("x.docx", &[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Err(FileError::BlockedType));
    assert_eq!(check_content("x.txt", b"hello"), Ok(()));
}

#[test]
fn a_pdf_that_is_really_an_exe_is_refused_everywhere() {
    let temp = TempRoot::new("mz");
    std::fs::write(temp.join("x.pdf"), b"MZ\x90\0\x03\0\0\0 rest of an exe").unwrap();
    let session = open_session(&temp, 0);
    let head = session.root().read_head(&rel("x.pdf"), 8192).unwrap();
    assert_eq!(check_content("x.pdf", &head), Err(FileError::BlockedType));
    let reply = respond(Some(session.as_ref()), &get("/x.pdf", None));
    assert_eq!(reply.status, 403);
}

#[test]
fn the_protocol_table_has_no_html_or_svg() {
    assert_eq!(content_type("a.SVG"), None);
    assert_eq!(content_type("a.html"), None);
    assert_eq!(content_type("a.png"), Some("image/png"));
    assert_eq!(content_type("a.mkv"), None);
}

#[test]
fn open_with_builds_one_whole_file_argument() {
    let app = |args: &[&str], template: &[&str]| DesktopApp {
        exe: r"C:\Program Files\App\app.exe".into(),
        args: args.iter().map(|s| (*s).to_string()).collect(),
        file_arg_template: template.iter().map(|s| (*s).to_string()).collect(),
    };
    let file = r"C:\files\maya\My Docs\a b.mkv";
    assert_eq!(
        build_args(&app(&["--fullscreen"], &["--open", "{file}"]), file).unwrap(),
        vec!["--fullscreen", "--open", file]
    );
    assert!(build_args(&app(&[], &["--out={file}"]), file).is_err());
    assert!(build_args(&app(&[], &["{file}{file}"]), file).is_err());
    assert!(build_args(&app(&[], &["{unknown}"]), file).is_err());
    assert!(build_args(&app(&[], &[]), file).is_err(), "no template, no files");

    let h = handlers(&[(".exe", "x"), (".MKV", "vlc"), (".docx", "lo")]);
    assert_eq!(handler_app_id("a.exe", &h), None);
    assert_eq!(handler_app_id("movie.mkv", &h).as_deref(), Some("vlc"));
    assert_eq!(handler_app_id("a.docx", &h).as_deref(), Some("lo"), "Open with ignores the viewer");
    assert_eq!(handler_app_id("a.xyz", &h), None);
}

// ---------------------------------------------------------------------------
// Test 8: the rbfile protocol.
// ---------------------------------------------------------------------------

fn get<'a>(path: &'a str, range: Option<&'a str>) -> Request<'a> {
    Request { method: "GET", path, range, origin: None, referer: None }
}

fn header<'a>(reply: &'a Reply, name: &str) -> Option<&'a str> {
    reply.header(name)
}

fn protocol_session(temp: &TempRoot) -> Arc<FileSession> {
    let big: Vec<u8> = (0..3 * 1024 * 1024).map(|n| (n % 251) as u8).collect();
    std::fs::write(temp.join("big.mp4"), &big).unwrap();
    std::fs::write(temp.join("note.txt"), "hello").unwrap();
    std::fs::write(temp.join("page.html"), "<b>x</b>").unwrap();
    std::fs::write(temp.join("fake.pdf"), "MZ not a pdf").unwrap();
    std::fs::write(temp.join("empty.png"), "").unwrap();
    std::fs::create_dir(temp.join("sub dir")).unwrap();
    std::fs::write(temp.join("sub dir/é.txt"), "ok").unwrap();
    open_session(temp, 0)
}

#[test]
fn protocol_shapes_200_206_416() {
    let temp = TempRoot::new("proto");
    let session = protocol_session(&temp);
    let s = Some(session.as_ref());

    let whole = respond(s, &get("/note.txt", None));
    assert_eq!(whole.status, 200);
    assert_eq!(whole.body, b"hello");
    assert_eq!(header(&whole, "Accept-Ranges"), Some("bytes"));
    assert_eq!(header(&whole, "Content-Length"), Some("5"));
    assert_eq!(header(&whole, "X-Content-Type-Options"), Some("nosniff"));
    assert_eq!(header(&whole, "Cache-Control"), Some("no-store"));
    assert_eq!(header(&whole, "Content-Type"), Some("text/plain; charset=utf-8"));

    let part = respond(s, &get("/note.txt", Some("bytes=1-3")));
    assert_eq!(part.status, 206);
    assert_eq!(part.body, b"ell");
    assert_eq!(header(&part, "Content-Range"), Some("bytes 1-3/5"));
    assert_eq!(header(&part, "Content-Length"), Some("3"));

    let suffix = respond(s, &get("/note.txt", Some("bytes=-2")));
    assert_eq!((suffix.status, suffix.body.as_slice()), (206, &b"lo"[..]));
    let open_ended = respond(s, &get("/note.txt", Some("bytes=3-")));
    assert_eq!((open_ended.status, open_ended.body.as_slice()), (206, &b"lo"[..]));

    let past = respond(s, &get("/note.txt", Some("bytes=9-")));
    assert_eq!(past.status, 416);
    assert_eq!(header(&past, "Content-Range"), Some("bytes */5"));
    assert_eq!(respond(s, &get("/note.txt", Some("bytes=0-1,3-4"))).status, 416);
    assert_eq!(respond(s, &get("/note.txt", Some("bytes=3-1"))).status, 416);
    assert_eq!(respond(s, &get("/note.txt", Some("lines=0-1"))).status, 416);
    assert_eq!(respond(s, &get("/empty.png", None)).status, 200);
    assert_eq!(respond(s, &get("/empty.png", Some("bytes=0-"))).status, 416);

    let head = respond(s, &Request { method: "HEAD", ..get("/note.txt", None) });
    assert_eq!((head.status, head.body.len()), (200, 0));
    assert_eq!(header(&head, "Content-Length"), Some("5"));
}

#[test]
fn a_three_mib_range_request_is_capped() {
    let temp = TempRoot::new("proto-cap");
    let session = protocol_session(&temp);
    let s = Some(session.as_ref());
    let first = respond(s, &get("/big.mp4", Some("bytes=0-")));
    assert_eq!(first.status, 206);
    assert_eq!(first.body.len() as u64, MAX_RANGE);
    let expected = format!("bytes 0-{}/{}", MAX_RANGE - 1, 3 * 1024 * 1024);
    assert_eq!(header(&first, "Content-Range"), Some(expected.as_str()));
    let explicit = respond(s, &get("/big.mp4", Some("bytes=0-3145727")));
    assert_eq!(explicit.body.len() as u64, MAX_RANGE);
    let rest = respond(s, &get("/big.mp4", Some("bytes=2097152-")));
    assert_eq!(rest.body.len(), 1024 * 1024);
    assert_eq!(rest.body[0], (2_097_152usize % 251) as u8, "the right bytes, not the first ones");
}

#[test]
fn protocol_refuses_signed_out_foreign_and_unsafe_requests() {
    let temp = TempRoot::new("proto-403");
    let session = protocol_session(&temp);
    let s = Some(session.as_ref());

    let signed_out = respond(None, &get("/note.txt", None));
    assert_eq!(signed_out.status, 403);
    assert_eq!(header(&signed_out, "X-Content-Type-Options"), Some("nosniff"));

    assert_eq!(respond(s, &get("/page.html", None)).status, 403, "never html");
    assert_eq!(respond(s, &get("/fake.pdf", None)).status, 403, "content is checked");
    assert_eq!(respond(s, &get("/missing.txt", None)).status, 404);
    assert_eq!(respond(s, &get("/..%2f..%2fx.txt", None)).status, 400);
    assert_eq!(respond(s, &get("/C%3A%5Cwindows%5Cwin.ini", None)).status, 400);
    assert_eq!(respond(s, &get("/%zz", None)).status, 400);
    assert_eq!(respond(s, &get("/sub%20dir/%C3%A9.txt", None)).status, 200);
    assert_eq!(respond(s, &Request { method: "POST", ..get("/note.txt", None) }).status, 405);

    // A web app's page must not be able to read the employee's files.
    let foreign = Request { origin: Some("https://evil.example"), ..get("/note.txt", None) };
    assert_eq!(respond(s, &foreign).status, 403);
    let referer = Request { referer: Some("https://evil.example/page"), ..get("/note.txt", None) };
    assert_eq!(respond(s, &referer).status, 403);
    let lookalike = Request { origin: Some("http://tauri.localhost.evil.example"), ..get("/note.txt", None) };
    assert_eq!(respond(s, &lookalike).status, 403);
    let own = Request { origin: Some("http://tauri.localhost"), ..get("/note.txt", None) };
    let reply = respond(s, &own);
    assert_eq!(reply.status, 200);
    assert_eq!(header(&reply, "Access-Control-Allow-Origin"), Some("http://tauri.localhost"));
    assert_eq!(header(&respond(s, &get("/note.txt", None)), "Access-Control-Allow-Origin"), None);
}

#[test]
fn the_protocol_does_not_follow_a_junction() {
    let outside = TempRoot::new("proto-outside");
    std::fs::write(outside.join("secret.txt"), b"secret").unwrap();
    let temp = TempRoot::new("proto-junction");
    junction(&temp.join("link"), outside.path());
    let session = open_session(&temp, 0);
    let reply = respond(Some(session.as_ref()), &get("/link/secret.txt", None));
    assert_eq!(reply.status, 403);
    assert!(reply.body.is_empty());
}

// ---------------------------------------------------------------------------
// Test 9: quota.
// ---------------------------------------------------------------------------

#[test]
fn quota_arithmetic() {
    let quota = Quota::new(1000);
    quota.set_used(900);
    assert_eq!(quota.check_add(100), Ok(()));
    assert_eq!(quota.check_add(250), Err(FileError::QuotaExceeded { short_by: 150 }));
    quota.set_used(1000);
    assert!(quota.is_full());
    assert_eq!(quota.check_add(0), Err(FileError::QuotaExceeded { short_by: 1 }));
    let unlimited = Quota::new(0);
    unlimited.set_used(u64::MAX / 2);
    assert_eq!(unlimited.check_add(1 << 40), Ok(()));
    assert!(!unlimited.is_full());
}

#[test]
fn watcher_paths_become_folders_and_the_trash_is_ignored() {
    let root = Path::new(r"C:\files\maya");
    assert_eq!(changed_dir(root, Path::new(r"C:\files\maya\a\b.txt")), Some("a".into()));
    assert_eq!(changed_dir(root, Path::new(r"C:\files\maya\b.txt")), Some(String::new()));
    assert_eq!(changed_dir(root, Path::new(r"C:\files\maya\.rulebox-trash\x\y")), None);
    assert_eq!(changed_dir(root, Path::new(r"C:\other\x.txt")), None);
}

#[test]
fn copy_over_the_quota_is_refused_but_delete_is_not() {
    let temp = TempRoot::new("quota");
    std::fs::write(temp.join("big.bin"), vec![1u8; 600]).unwrap();
    std::fs::create_dir(temp.join("dir")).unwrap();
    let s = open_session(&temp, 1000);
    wait_for_usage(&s, 600);

    // 600 + 600 = 1200 against 1000: short by 200, and nothing is left behind.
    assert_eq!(s.copy(&rel("big.bin"), &rel("dir")), Err(FileError::QuotaExceeded { short_by: 200 }));
    assert!(!temp.join("dir/big.bin").exists());

    // Fill it to 100%: copy and restore stop; delete, move and rename do not.
    std::fs::write(temp.join("fill.bin"), vec![1u8; 400]).unwrap();
    s.request_scan();
    wait_for_usage(&s, 1000);
    assert!(s.copy(&rel("fill.bin"), &rel("dir")).is_err());
    assert!(s.rename(&rel("fill.bin"), &rel("fill2.bin")).is_ok());
    assert!(s.move_to(&rel("fill2.bin"), &rel("dir")).is_ok());
    assert!(s.delete(&rel("dir/fill2.bin"), false).is_ok(), "delete is always allowed");
    let trashed = s.trash_list();
    assert!(s.restore(&trashed[0].id).is_err(), "restore is blocked at 100%");
    s.purge(None).unwrap();
    wait_for_usage(&s, 600);
    assert!(s.copy(&rel("big.bin"), &rel("dir")).is_err(), "still over after the purge");
    assert!(s.mkdir(&rel("newdir")).is_ok());
}

#[test]
fn permanent_delete_frees_the_quota() {
    let temp = TempRoot::new("quota-perm");
    std::fs::write(temp.join("a.bin"), vec![1u8; 500]).unwrap();
    let s = open_session(&temp, 1000);
    wait_for_usage(&s, 500);
    s.delete(&rel("a.bin"), false).unwrap();
    s.request_scan();
    std::thread::sleep(Duration::from_millis(200));
    assert_eq!(s.usage().used, 500, "the trash counts");
    s.purge(None).unwrap();
    wait_for_usage(&s, 0);
    std::fs::write(temp.join("b.bin"), vec![1u8; 300]).unwrap();
    s.request_scan();
    wait_for_usage(&s, 300);
    s.delete(&rel("b.bin"), true).unwrap();
    wait_for_usage(&s, 0);
}

// ---------------------------------------------------------------------------
// Search, recent, watcher.
// ---------------------------------------------------------------------------

#[test]
fn search_is_capped_cancellable_and_skips_the_trash() {
    let temp = TempRoot::new("search");
    std::fs::create_dir(temp.join("Reports")).unwrap();
    std::fs::write(temp.join("Reports/Annual-Report.txt"), "x").unwrap();
    std::fs::write(temp.join("report2.txt"), "x").unwrap();
    std::fs::write(temp.join("other.txt"), "x").unwrap();
    let s = open_session(&temp, 0);
    s.delete(&rel("report2.txt"), false).unwrap();
    let mut hits = Vec::new();
    let found = s.root().search("REPORT", 500, &|| false, &mut |e| hits.push(e.name));
    hits.sort();
    assert_eq!(found, 2);
    assert_eq!(hits, vec!["Annual-Report.txt", "Reports"]);
    assert_eq!(s.root().search("report", 1, &|| false, &mut |_| {}), 1);
    assert_eq!(s.root().search("report", 500, &|| true, &mut |_| {}), 0);
    assert_eq!(s.root().search("   ", 500, &|| false, &mut |_| {}), 0);
}

#[test]
fn streaming_search_sends_batches_and_a_final_done() {
    let temp = TempRoot::new("search-stream");
    for n in 0..95 {
        std::fs::write(temp.join(&format!("match-{n:03}.txt")), "x").unwrap();
    }
    let s = open_session(&temp, 0);
    let (tx, rx) = std::sync::mpsc::channel();
    let tx = std::sync::Mutex::new(tx);
    let send: rulebox_staff_lib::files::Emit = Arc::new(move |event, payload| {
        assert_eq!(event, "files://search");
        let _ = tx.lock().unwrap().send(payload);
    });
    s.start_search(7, "match".into(), send);
    let (mut total, mut batches) = (0, 0);
    loop {
        let message = rx.recv_timeout(Duration::from_secs(5)).expect("search finished");
        assert_eq!(message["searchId"], 7);
        total += message["hits"].as_array().unwrap().len();
        batches += 1;
        if message["done"] == true {
            break;
        }
    }
    assert_eq!(total, 95);
    assert!(batches >= 3, "40 + 40 + 15: {batches}");
}

#[test]
fn recent_files_drop_out_when_deleted() {
    let temp = TempRoot::new("recent");
    std::fs::write(temp.join("a.txt"), "x").unwrap();
    std::fs::write(temp.join("b.txt"), "x").unwrap();
    let s = open_session(&temp, 0);
    s.remember(&rel("a.txt"));
    s.remember(&rel("b.txt"));
    s.remember(&rel("a.txt"));
    let names = |s: &FileSession| s.recent().into_iter().map(|e| e.name).collect::<Vec<_>>();
    assert_eq!(names(&s), vec!["a.txt", "b.txt"]);
    s.delete(&rel("a.txt"), true).unwrap();
    assert_eq!(names(&s), vec!["b.txt"]);
}

#[test]
fn the_watcher_reports_changed_folders() {
    let temp = TempRoot::new("watch");
    std::fs::create_dir(temp.join("docs")).unwrap();
    let (tx, rx) = std::sync::mpsc::channel();
    let tx = std::sync::Mutex::new(tx);
    let emit: rulebox_staff_lib::files::Emit = Arc::new(move |event, payload| {
        if event == "files://changed" {
            let _ = tx.lock().unwrap().send(payload["dir"].as_str().unwrap_or("?").to_string());
        }
    });
    let _session = FileSession::open(temp.path(), 0, emit).unwrap();
    std::thread::sleep(Duration::from_millis(300));
    std::fs::write(temp.join("docs/new.txt"), "x").unwrap();
    let mut seen = Vec::new();
    while let Ok(dir) = rx.recv_timeout(Duration::from_secs(3)) {
        seen.push(dir);
        if seen.iter().any(|d| d == "docs") {
            return;
        }
    }
    panic!("no change reported for docs: {seen:?}");
}

// ---------------------------------------------------------------------------
// Previews and test 10: the zip pre-check.
// ---------------------------------------------------------------------------

#[test]
fn text_with_a_bom_and_without() {
    let utf8 = preview::read_text(Cursor::new(b"\xef\xbb\xbfhello \xc3\xa9".to_vec()), 100).unwrap();
    assert_eq!(utf8.text, "hello é");
    assert!(!utf8.truncated);
    let utf16: Vec<u8> = [0xff, 0xfe].into_iter().chain("hi".encode_utf16().flat_map(u16::to_le_bytes)).collect();
    assert_eq!(preview::read_text(Cursor::new(utf16), 100).unwrap().text, "hi");
    let latin = preview::read_text(Cursor::new(b"caf\xe9 au lait, tr\xe8s bon".to_vec()), 100).unwrap();
    assert!(latin.text.contains("café"), "{}", latin.text);
}

#[test]
fn long_text_is_cut_at_a_whole_character() {
    let cut = preview::read_text(Cursor::new("é".repeat(10).into_bytes()), 5).unwrap();
    assert!(cut.truncated);
    assert_eq!(cut.text, "éé");
}

#[test]
fn csv_rows_are_capped_and_ragged_rows_survive() {
    let mut data = String::from("a,b,c\n1,2\n\"x,y\",3,4,5\n");
    for n in 0..preview::CSV_ROWS + 10 {
        data.push_str(&format!("{n},z\n"));
    }
    let csv = preview::read_csv(Cursor::new(data.into_bytes())).unwrap();
    assert_eq!(csv.rows.len(), preview::CSV_ROWS);
    assert!(csv.truncated);
    assert_eq!(csv.rows[1], vec!["1", "2"]);
    assert_eq!(csv.rows[2], vec!["x,y", "3", "4", "5"]);
    let semi = preview::read_csv(Cursor::new(b"a;b\n1;2\n".to_vec())).unwrap();
    assert_eq!(semi.rows[1], vec!["1", "2"]);
}

fn zip_with(files: usize, size_each: usize, path: &Path) -> std::fs::File {
    let mut writer = zip::ZipWriter::new(std::fs::File::create(path).unwrap());
    let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let body = vec![0u8; size_each];
    for n in 0..files {
        writer.start_file(format!("f{n}.xml"), options).unwrap();
        writer.write_all(&body).unwrap();
    }
    writer.finish().unwrap();
    std::fs::File::open(path).unwrap()
}

#[test]
fn a_zip_bomb_is_refused_before_a_viewer_sees_it() {
    let temp = TempRoot::new("zip");
    // 3 x 80 MB of zeros: a few hundred KB on disk, 240 MB unpacked.
    let bomb = zip_with(3, 80 * 1024 * 1024, &temp.join("bomb.docx"));
    assert!(bomb.metadata().unwrap().len() < preview::OFFICE_MAX_BYTES);
    assert_eq!(preview::office_precheck(bomb), Err(FileError::TooLarge));
    let fine = zip_with(3, 1024, &temp.join("fine.docx"));
    assert_eq!(preview::office_precheck(fine), Ok(()));
    let many = zip_with(preview::ZIP_MAX_ENTRIES + 1, 1, &temp.join("many.docx"));
    assert_eq!(preview::office_precheck(many), Err(FileError::TooLarge));
    std::fs::write(temp.join("junk.docx"), b"not a zip").unwrap();
    let junk = std::fs::File::open(temp.join("junk.docx")).unwrap();
    assert_eq!(preview::office_precheck(junk), Err(FileError::Damaged));
}

#[test]
fn a_big_office_file_is_refused_by_size() {
    let temp = TempRoot::new("big-docx");
    let file = std::fs::File::create(temp.join("big.xlsx")).unwrap();
    file.set_len(preview::OFFICE_MAX_BYTES + 1).unwrap();
    drop(file);
    let file = std::fs::File::open(temp.join("big.xlsx")).unwrap();
    assert_eq!(preview::office_precheck(file), Err(FileError::TooLarge));
}

#[test]
fn image_sizes_come_from_the_header() {
    let mut png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
    png.extend_from_slice(&640u32.to_be_bytes());
    png.extend_from_slice(&480u32.to_be_bytes());
    assert_eq!(preview::image_info(&png), Ok(ImageInfo { width: 640, height: 480 }));
    let mut huge = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
    huge.extend_from_slice(&10_000u32.to_be_bytes());
    huge.extend_from_slice(&10_000u32.to_be_bytes());
    assert_eq!(preview::image_info(&huge), Err(FileError::TooLarge));
    let mut gif = b"GIF89a".to_vec();
    gif.extend_from_slice(&[0x20, 0x00, 0x10, 0x00]);
    assert_eq!(preview::image_info(&gif), Ok(ImageInfo { width: 32, height: 16 }));
    let jpeg = [
        0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x01, 0xe0, 0x02,
        0x80, 0x01, 0x01, 0x11, 0x00,
    ];
    assert_eq!(preview::image_info(&jpeg), Ok(ImageInfo { width: 640, height: 480 }));
    assert_eq!(preview::image_info(b"not an image"), Err(FileError::Damaged));
}
