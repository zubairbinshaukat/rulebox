#![cfg(windows)]
//! Guard coverage for `rulebox-win32` (Phase 5 Step 3, plan 4.5 rule 1).
//!
//! The test reads the source of every module that can change the machine as text and
//! checks, for each `pub fn` that is not on that module's read-only list:
//!
//! - its first real statement is `require_test_machine()?;`, with nothing before it but
//!   pure `check_*` rule calls (the allow-list check that returns `Forbidden` before the
//!   guard, plan 4.5 rule 2);
//! - it carries the doc line `DESTRUCTIVE: guarded` (a note may follow).
//!
//! A new `pub fn` in one of these files is therefore guarded or listed as read-only by
//! hand. The scanner is tested against sources with a guard line removed, so it cannot
//! pass by reading nothing.

use std::path::PathBuf;

use rulebox_win32::{machinereg, staffreg, Win32Error};

const GUARD: &str = "require_test_machine()?";

/// A module and what is allowed to skip the guard. Names starting with `check_` are pure
/// rule checks and never need it.
struct Module {
    file: &'static str,
    read_only: &'static [&'static str],
    /// How many guarded functions the file must have (so an empty scan fails).
    guarded: usize,
}

const MODULES: &[Module] = &[
    Module { file: "machinereg", read_only: &["get_machine_value", "list_value_names"], guarded: 2 },
    Module { file: "staffreg", read_only: &["read_value"], guarded: 2 },
    // (Step 6) `read_policy` and `citool_available` only read; `refresh` (CiTool) is guarded.
    Module { file: "codeintegrity", read_only: &["active_dir", "list_policies", "read_policy", "citool_available"], guarded: 3 },
    Module { file: "applocker", read_only: &["get_policy"], guarded: 2 },
    Module { file: "service", read_only: &["query", "get_security", "get_required_privileges"], guarded: 3 },
    Module { file: "wlan", read_only: &["list"], guarded: 3 },
    // (Step 7) `is_file_output_port` only classifies a port name.
    Module { file: "printing", read_only: &["list", "get_security", "is_file_output_port"], guarded: 3 },
    Module { file: "bcd", read_only: &["get"], guarded: 1 },
    // (Step 8) `trace_stats` only reads the session's loss counters.
    Module { file: "etw", read_only: &["trace_stats"], guarded: 2 },
];

/// Functions elsewhere in the crate that change the machine: scanned by name only.
const ALSO_GUARDED: &[(&str, &[&str])] = &[
    ("security", &["create_protected_dir", "set_path_dacl"]),
    ("accounts", &["create_standard_user", "set_password", "test_logon", "delete_user_and_profile", "ensure_profile", "set_account_lockout"]),
];

fn source(file: &str) -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src").join(format!("{file}.rs"));
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()))
}

/// One `pub fn` found in the non-test part of a source.
struct PubFn {
    name: String,
    /// The doc comment lines right above it.
    docs: String,
    /// The trimmed, non-empty, non-comment lines of the body.
    statements: Vec<String>,
}

fn pub_fns(source: &str) -> Vec<PubFn> {
    let code = source.split("\n#[cfg(test)]").next().unwrap_or(source);
    let lines: Vec<&str> = code.lines().collect();
    let mut found = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        if let Some(rest) = line.strip_prefix("pub fn ") {
            let name: String = rest.chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect();
            let mut docs = Vec::new();
            let mut up = i;
            while up > 0 && (lines[up - 1].starts_with("///") || lines[up - 1].starts_with("#[")) {
                up -= 1;
                docs.push(lines[up]);
            }
            // The signature ends at the first line that ends with `{`.
            let mut start = i;
            while start < lines.len() && !lines[start].trim_end().ends_with('{') {
                start += 1;
            }
            let mut statements = Vec::new();
            let mut end = start + 1;
            while end < lines.len() && lines[end] != "}" {
                let trimmed = lines[end].trim();
                if !trimmed.is_empty() && !trimmed.starts_with("//") {
                    statements.push(trimmed.to_string());
                }
                end += 1;
            }
            found.push(PubFn { name, docs: docs.join("\n"), statements });
            i = end;
        }
        i += 1;
    }
    found
}

/// What is wrong with one function, if anything.
fn violation(function: &PubFn) -> Option<String> {
    if !function.docs.contains("DESTRUCTIVE: guarded") {
        return Some(format!("{}: no `DESTRUCTIVE: guarded` doc line", function.name));
    }
    let Some(at) = function.statements.iter().position(|s| s.contains(GUARD)) else {
        return Some(format!("{}: no `{GUARD}`", function.name));
    };
    for statement in &function.statements[..at] {
        let pure_check = statement.ends_with(';')
            && (statement.starts_with("check_") || (statement.starts_with("let ") && statement.contains(" = check_")));
        if !pure_check {
            return Some(format!("{}: `{statement}` comes before the guard", function.name));
        }
    }
    None
}

fn guarded_candidates(source: &str, read_only: &[&str]) -> Vec<PubFn> {
    pub_fns(source)
        .into_iter()
        .filter(|function| !function.name.starts_with("check_") && !read_only.contains(&function.name.as_str()))
        .collect()
}

fn scan(source: &str, read_only: &[&str]) -> Vec<String> {
    guarded_candidates(source, read_only).iter().filter_map(violation).collect()
}

#[test]
fn every_mutating_function_starts_with_the_guard() {
    for module in MODULES {
        let source = source(module.file);
        let problems = scan(&source, module.read_only);
        assert!(problems.is_empty(), "{}.rs: {problems:#?}", module.file);
        let guarded = guarded_candidates(&source, module.read_only).len();
        assert_eq!(guarded, module.guarded, "{}.rs: the number of guarded functions changed; list it here", module.file);
    }
}

#[test]
fn the_mutating_functions_elsewhere_in_the_crate_are_guarded_too() {
    for (file, names) in ALSO_GUARDED {
        let source = source(file);
        let functions = pub_fns(&source);
        for name in *names {
            let function = functions.iter().find(|f| f.name == *name).unwrap_or_else(|| panic!("{file}.rs: no pub fn {name}"));
            assert_eq!(violation(function), None, "{file}.rs::{name}");
        }
    }
}

#[test]
fn a_read_only_list_cannot_name_a_function_that_does_not_exist() {
    for module in MODULES {
        let names: Vec<String> = pub_fns(&source(module.file)).into_iter().map(|f| f.name).collect();
        for read_only in module.read_only {
            assert!(names.iter().any(|n| n == read_only), "{}.rs has no pub fn {read_only}", module.file);
        }
    }
}

#[test]
fn removing_a_guard_line_makes_the_scan_fail() {
    for module in MODULES {
        let original = source(module.file);
        // Take the guard line out of each guarded function in turn.
        let guards: Vec<usize> = original.match_indices(GUARD).map(|(at, _)| at).collect();
        let in_code = original.split("\n#[cfg(test)]").next().unwrap_or("").len();
        let mut failures = 0;
        for at in guards.into_iter().filter(|at| *at < in_code) {
            let line_start = original[..at].rfind('\n').map_or(0, |n| n + 1);
            let line_end = original[at..].find('\n').map_or(original.len(), |n| at + n + 1);
            let mutated = format!("{}{}", &original[..line_start], &original[line_end..]);
            if !scan(&mutated, module.read_only).is_empty() {
                failures += 1;
            }
        }
        assert_eq!(failures, module.guarded, "{}.rs: every removed guard must be noticed", module.file);
    }
}

#[test]
fn the_scanner_notices_each_way_to_get_it_wrong() {
    let good = "/// DESTRUCTIVE: guarded.\npub fn write(path: &str) -> Result<()> {\n    check_path(path)?;\n    require_test_machine()?;\n    set(path)\n}\n";
    assert!(scan(good, &[]).is_empty());
    // No guard at all.
    assert_eq!(scan(&good.replace("    require_test_machine()?;\n", ""), &[]).len(), 1);
    // The effect before the guard.
    let late = "/// DESTRUCTIVE: guarded.\npub fn write(path: &str) -> Result<()> {\n    set(path)?;\n    require_test_machine()?;\n    Ok(())\n}\n";
    assert_eq!(scan(late, &[]).len(), 1);
    // A guard that is only mentioned in a comment.
    let comment = "/// DESTRUCTIVE: guarded.\npub fn write() -> Result<()> {\n    // require_test_machine()?;\n    set()\n}\n";
    assert_eq!(scan(comment, &[]).len(), 1);
    // No doc line.
    assert_eq!(scan(&good.replace("/// DESTRUCTIVE: guarded.\n", ""), &[]).len(), 1);
    // A new function that nobody listed.
    let added = format!("{good}\n/// New.\npub fn also_writes() -> Result<()> {{\n    set()\n}}\n");
    assert_eq!(scan(&added, &[]).len(), 1);
    assert!(scan(&added, &["also_writes"]).is_empty());
    // Pure rule checks are exempt, and may come first.
    let rule = format!("{good}\npub fn check_thing() -> Result<()> {{\n    Ok(())\n}}\n");
    assert!(scan(&rule, &[]).is_empty());
}

// -- allowed roots: a write outside them is `Forbidden` before the guard, and touches nothing ----

#[test]
fn a_machine_write_outside_the_roots_is_forbidden_and_creates_nothing() {
    let outside = r"SOFTWARE\Rulebox\AllowedRootsTestMustNotExist";
    let value = rulebox_win32::registry::RegValue::Dword(1);
    assert!(matches!(machinereg::set_machine_value(outside, "X", Some(&value)), Err(Win32Error::Forbidden(_))));
    assert!(matches!(machinereg::set_machine_value(outside, "X", None), Err(Win32Error::Forbidden(_))));
    assert_eq!(machinereg::get_machine_value(outside, "X").unwrap(), None);
    // The Winlogon values that would remove the way back, written through the wider list.
    let winlogon = rulebox_win32::autologon::WINLOGON_KEY;
    for name in rulebox_win32::autologon::FORBIDDEN_WINLOGON_VALUES {
        assert!(machinereg::set_machine_value(winlogon, name, Some(&value)).is_err(), "{name}");
        assert!(matches!(
            machinereg::set_machine_value(machinereg::DEVICE_INSTALL_RESTRICTIONS, name, Some(&value)),
            Err(Win32Error::Forbidden(_))
        ));
    }
}

#[test]
fn a_staff_write_outside_the_roots_is_forbidden_before_any_hive_is_opened() {
    let sid = rulebox_win32::sid::current_user_sid().unwrap();
    // The profile does not exist: if the hive were opened first, the error would be
    // `NotFound` or `Guard`, not `Forbidden`.
    let profile = std::path::Path::new(r"C:\rulebox-no-such-profile");
    let value = rulebox_win32::registry::RegValue::Dword(1);
    for path in [r"Software\Classes", r"Software\Microsoft\Windows\CurrentVersion\RunOnce", ""] {
        assert!(matches!(staffreg::write_value(&sid, profile, path, "X", &value), Err(Win32Error::Forbidden(_))), "{path}");
        assert!(matches!(staffreg::delete_value(&sid, profile, path, "X"), Err(Win32Error::Forbidden(_))), "{path}");
    }
    assert!(matches!(
        staffreg::write_value(&sid, profile, staffreg::ALLOWED_ROOTS[0], "Shell", &value),
        Err(Win32Error::Forbidden(_))
    ));
}

#[test]
fn both_root_lists_are_what_the_plan_says() {
    // 4.7 (Staff) and 4.8 (machine) plus the Phase 2 roots and the 4.7a device-class key.
    assert_eq!(staffreg::ALLOWED_ROOTS.len(), 12);
    assert!(staffreg::ALLOWED_ROOTS.contains(&r"Software\Policies\Microsoft\Windows\RemovableStorageDevices"));
    assert_eq!(machinereg::ALLOWED_ROOTS.len(), 9);
    assert!(machinereg::ALLOWED_ROOTS.contains(&machinereg::DEVICE_INSTALL_RESTRICTIONS));
    // Nothing that opens the way to a shell, a service or start-up code.
    for root in machinereg::ALLOWED_ROOTS.iter().chain(staffreg::ALLOWED_ROOTS) {
        let lower = root.to_ascii_lowercase();
        for banned in ["\\services\\", "\\run\\", "\\runonce", "image file execution", "\\appinit"] {
            assert!(!lower.contains(banned), "{root}");
        }
    }
}
