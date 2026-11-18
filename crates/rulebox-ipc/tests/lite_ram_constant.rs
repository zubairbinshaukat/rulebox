//! Phase 6 Step 3: the Lite-mode RAM limit (PRD 22.5) has exactly one definition,
//! `rulebox_ipc::types::LITE_MAX_RAM_MB`; the agent imports it instead of keeping
//! its own copy. A grep-style test over the Rust sources.

use std::fs;
use std::path::{Path, PathBuf};

/// The workspace root (this crate lives in `crates/rulebox-ipc`).
fn workspace_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..")
}

/// Every `.rs` file under `dir`, recursively (missing folders give nothing).
fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            rust_files(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
}

/// All production source folders: `crates/*/src`, `apps/*/src` and `apps/*/src-tauri/src`.
fn source_files() -> Vec<PathBuf> {
    let root = workspace_root();
    let mut files = Vec::new();
    for group in ["crates", "apps"] {
        let Ok(members) = fs::read_dir(root.join(group)) else { continue };
        for member in members.flatten() {
            rust_files(&member.path().join("src"), &mut files);
            rust_files(&member.path().join("src-tauri").join("src"), &mut files);
        }
    }
    files
}

#[test]
fn the_lite_ram_limit_has_one_definition() {
    let files = source_files();
    assert!(!files.is_empty(), "no Rust sources found; the test walked the wrong folder");
    let mut definitions = Vec::new();
    let mut literals = Vec::new();
    for file in &files {
        let Ok(text) = fs::read_to_string(file) else { continue };
        for (n, line) in text.lines().enumerate() {
            let code = line.trim_start();
            if code.starts_with("//") {
                continue;
            }
            // Any constant that looks like a copy of the Lite RAM limit.
            if code.contains("const ") && code.contains("MAX_RAM_MB") {
                definitions.push(format!("{}:{}", file.display(), n + 1));
            }
            if code.contains("4352") || code.contains("4_352") {
                literals.push(format!("{}:{}", file.display(), n + 1));
            }
        }
    }
    assert_eq!(definitions.len(), 1, "expected one LITE_MAX_RAM_MB definition, found {definitions:?}");
    assert!(definitions[0].replace('\\', "/").contains("rulebox-ipc/src/types.rs"), "the definition must live in rulebox-ipc: {definitions:?}");
    // The number itself appears once: in the definition.
    assert_eq!(literals, definitions, "the 4352 literal is used outside the one definition: {literals:?}");
}

#[test]
fn the_agent_imports_the_constant() {
    let root = workspace_root().join("apps").join("agent").join("src");
    for name in ["agent.rs", "compat.rs"] {
        let text = fs::read_to_string(root.join(name)).unwrap_or_default();
        assert!(text.contains("LITE_MAX_RAM_MB"), "{name} must use LITE_MAX_RAM_MB");
        assert!(text.contains("rulebox_ipc::types"), "{name} must import it from rulebox_ipc::types");
    }
}
