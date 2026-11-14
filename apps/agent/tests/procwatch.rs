//! Source-level rules for the process watchdog (Phase 5 Step 8, plan 4.10 and rule 6).
//!
//! The agent is a binary crate, so its behaviour is tested inside the crate
//! (`src/lockdown/procwatch/tests.rs`, against `SimPlatform`). What a test inside the crate
//! cannot prove is what the code does *not* do; this file reads the sources as text and holds
//! those rules in place:
//!
//! - nothing in the watchdog or the trace reads a command line or a window title;
//! - no test of the watchdog can start a real trace session, or touches `WindowsPlatform`;
//! - every termination names the Staff SID, so the platform re-checks the owner;
//! - the never-terminate list holds the names of plan edge case 46.
#![allow(clippy::expect_used)] // a test file: a missing marker should stop it with its text

use std::path::PathBuf;

fn read(relative: &str) -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(relative);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()))
}

/// The non-test part of a source file.
fn code(source: &str) -> &str {
    source.split("\n#[cfg(test)]").next().expect("a source")
}

#[test]
fn the_watchdog_and_the_trace_never_read_command_lines_or_window_titles() {
    let banned = [
        "commandline",
        "command_line",
        "cmdline",
        "getcommandline",
        "ntqueryinformationprocess",
        "processparameters",
        "gettext",
        "getwindowtext",
        "enumwindows",
        "windowtitle",
        "window_title",
    ];
    for file in [
        "src/lockdown/procwatch.rs",
        "../../crates/rulebox-win32/src/etw.rs",
        "../../crates/rulebox-win32/src/fileid.rs",
    ] {
        let source = read(file);
        let lower = code(&source).to_ascii_lowercase();
        for word in banned {
            assert!(!lower.contains(word), "{file} mentions `{word}`");
        }
    }
}

#[test]
fn no_test_of_the_watchdog_starts_a_real_trace() {
    let tests = read("src/lockdown/procwatch/tests.rs");
    for word in ["WindowsPlatform", "etw::", "rulebox_win32::etw", "start_trace"] {
        assert!(!tests.contains(word), "the watchdog's tests mention `{word}`");
    }
    // The watchdog itself reaches the trace only through the platform seam, which has the guard.
    let source = read("src/lockdown/procwatch.rs");
    assert!(!code(&source).contains("etw::"), "procwatch.rs must use platform.start_process_trace, not etw directly");
    assert!(code(&source).contains("start_process_trace(sink)"));
}

#[test]
fn every_termination_names_the_staff_sid() {
    let source = read("src/lockdown/procwatch.rs");
    let calls: Vec<&str> = code(&source).lines().filter(|line| line.contains(".terminate_process(")).collect();
    assert_eq!(calls.len(), 1, "one place ends processes: {calls:?}");
    assert!(calls[0].contains("self.matcher.staff_sid()") && calls[0].contains("&info.image"), "{}", calls[0]);
}

#[test]
fn the_never_terminate_list_has_the_names_of_the_plan() {
    let source = read("src/lockdown/procwatch.rs");
    for name in ["csrss.exe", "winlogon.exe", "dwm.exe", "fontdrvhost.exe", "ctfmon.exe", "conhost.exe", "textinputhost.exe"] {
        assert!(code(&source).contains(&format!("\"{name}\"")), "{name} is not on the never-terminate list");
    }
    // The agent, the launcher and the Staff App are protected by folder (the Rulebox install
    // folder), and the check comes before any other rule.
    let decide = code(&source).find("pub fn decide").expect("decide");
    let never = code(&source)[decide..].find("never_terminate(").expect("the never-terminate check");
    let allow_rules = code(&source)[decide..].find("path_exceptions.contains").expect("the first allow rule");
    assert!(never < allow_rules, "the never-terminate list must be checked first");
}

#[test]
fn the_session_has_one_fixed_name_and_four_64_kb_buffers() {
    let source = read("../../crates/rulebox-win32/src/etw.rs");
    assert!(source.contains("pub const SESSION_NAME: &str = \"RuleboxProcWatch\";"));
    assert!(source.contains("const BUFFER_KB: u32 = 64;") && source.contains("const BUFFER_COUNT: u32 = 4;"));
}
