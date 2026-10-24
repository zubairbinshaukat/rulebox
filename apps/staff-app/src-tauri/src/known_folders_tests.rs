//! Tests for the Documents / Desktop / Downloads redirect (planning and the
//! folders made for it). They live in the bin crate because the lib test
//! harness cannot start on this Windows + Tauri link (see `main.rs`).
//!
//! Nothing here changes the Windows known folders: the real redirect needs a
//! `ShellToken`, which only exists in shell mode, and these tests have none.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

use rulebox_desktop::known_folders::{plan, KnownFolder};
use rulebox_staff_lib::files::saferoot::{FileError, SafeRoot};
use rulebox_staff_lib::known_folders::{prepare, redirect_for_employee, restore};

/// A fresh folder under `target\`, junctions removed first on drop.
struct Temp(PathBuf);

impl Temp {
    fn new(tag: &str) -> Temp {
        static N: AtomicU32 = AtomicU32::new(0);
        let base = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../target/files-tests");
        let dir = base.join(format!("kf-{tag}-{}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Temp(dunce::canonicalize(&dir).unwrap())
    }

    fn join(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
}

impl Drop for Temp {
    fn drop(&mut self) {
        if let Ok(entries) = std::fs::read_dir(&self.0) {
            for entry in entries.flatten() {
                if entry.file_type().map(|kind| kind.is_symlink()).unwrap_or(false) {
                    let _ = std::fs::remove_dir(entry.path());
                }
            }
        }
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn junction(link: &Path, target: &Path) -> bool {
    std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(link)
        .arg(target)
        .output()
        .map(|out| out.status.success())
        .unwrap_or(false)
}

#[test]
fn prepare_makes_the_three_folders_and_plans_them_inside_the_root() {
    let temp = Temp::new("make");
    let root = SafeRoot::open(&temp.join("emp-1")).unwrap();
    let (ready, refused) = prepare(&root);
    assert!(refused.is_empty());
    assert_eq!(ready, plan(root.root_path()));
    for name in ["Documents", "Desktop", "Downloads"] {
        assert!(root.root_path().join(name).is_dir(), "{name} exists");
    }
    for item in &ready {
        assert!(item.target.starts_with(root.root_path()));
    }
}

#[test]
fn prepare_reuses_the_downloads_folder_web_apps_already_use() {
    let temp = Temp::new("reuse");
    let emp = temp.join("emp-1");
    std::fs::create_dir_all(emp.join("Downloads")).unwrap();
    std::fs::write(emp.join("Downloads").join("report.pdf"), b"x").unwrap();
    let root = SafeRoot::open(&emp).unwrap();
    let (ready, refused) = prepare(&root);
    assert!(refused.is_empty());
    assert_eq!(ready.len(), 3);
    assert!(emp.join("Downloads").join("report.pdf").is_file(), "existing files stay");
    // Calling it again is harmless.
    let (again, refused) = prepare(&root);
    assert!(refused.is_empty());
    assert_eq!(again, ready);
}

#[test]
fn prepare_leaves_out_a_folder_that_is_really_a_file() {
    let temp = Temp::new("file");
    let emp = temp.join("emp-1");
    std::fs::create_dir_all(&emp).unwrap();
    std::fs::write(emp.join("Desktop"), b"i am a file").unwrap();
    let root = SafeRoot::open(&emp).unwrap();
    let (ready, refused) = prepare(&root);
    assert_eq!(ready.len(), 2);
    assert!(ready.iter().all(|item| item.folder != KnownFolder::Desktop));
    assert_eq!(refused.len(), 1);
    assert_eq!(refused[0].0, KnownFolder::Desktop);
}

#[test]
fn prepare_refuses_a_junction_in_place_of_a_folder() {
    let temp = Temp::new("junction");
    let emp = temp.join("emp-1");
    std::fs::create_dir_all(&emp).unwrap();
    let outside = temp.join("outside");
    std::fs::create_dir_all(&outside).unwrap();
    if !junction(&emp.join("Documents"), &outside) {
        return; // mklink not available here
    }
    let root = SafeRoot::open(&emp).unwrap();
    let (ready, refused) = prepare(&root);
    assert!(ready.iter().all(|item| item.folder != KnownFolder::Documents));
    assert!(matches!(refused.as_slice(), [(KnownFolder::Documents, FileError::IsReparsePoint)]));
    let _ = std::fs::remove_dir(emp.join("Documents"));
}

#[test]
fn without_a_shell_token_nothing_is_redirected_or_restored() {
    // No app handle means no desktop host and so no token (dev mode and tests):
    // both calls return without touching Windows.
    let temp = Temp::new("dev");
    let root = SafeRoot::open(&temp.join("emp-1")).unwrap();
    redirect_for_employee(None, &root);
    restore(None);
    assert!(!root.root_path().join("Documents").exists(), "dev mode makes no folders either");
}
