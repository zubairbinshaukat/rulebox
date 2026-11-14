//! Guard coverage for the agent's `Platform` seam (Phase 5 Step 3, plan 4.5 rule 1).
//!
//! The test reads `src/platform/mod.rs` and `src/platform/windows.rs` as text and checks:
//!
//! - `MUTATING_METHODS` is exactly the set of trait methods in the trait's `mutating`
//!   sections (a new mutating method that nobody listed fails here);
//! - every one of them exists in `WindowsPlatform` and `SimPlatform`;
//! - in `WindowsPlatform`, each starts with `guard()?;`, after nothing but pure rule
//!   checks. A statement before the guard that names a `rulebox_win32` module (other than
//!   a `check_*` function), `std::fs` or a process call fails.
//!
//! The scanner itself is tested on sources with the guard line removed.
#![allow(clippy::expect_used)] // a test file: a missing marker should stop it with its text

use std::collections::BTreeSet;
use std::path::PathBuf;

const GUARD: &str = "guard()?;";

fn read(relative: &str) -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(relative);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()))
}

/// The quoted names of `pub const MUTATING_METHODS`.
fn mutating_methods(mod_rs: &str) -> Vec<String> {
    let start = mod_rs.find("pub const MUTATING_METHODS").expect("MUTATING_METHODS is in platform/mod.rs");
    let body = &mod_rs[start..];
    let body = &body[body.find("&[").expect("a list") + 2..];
    let body = &body[..body.find("\n];").expect("the list ends")];
    body.lines()
        .filter(|line| !line.trim_start().starts_with("//"))
        .flat_map(|line| line.split('"').skip(1).step_by(2).map(str::to_string).collect::<Vec<_>>())
        .collect()
}

/// `(name, is_in_a_mutating_section)` of each method of `pub trait Platform`.
fn trait_methods(mod_rs: &str) -> Vec<(String, bool)> {
    let start = mod_rs.find("pub trait Platform").expect("the trait");
    let body: Vec<&str> = mod_rs[start..].lines().skip(1).take_while(|line| *line != "}").collect();
    let mut mutating = false;
    let mut out = Vec::new();
    for line in body {
        let trimmed = line.trim_start();
        if line.starts_with("    //") && !line.starts_with("    ///") {
            if trimmed.starts_with("// read-only") {
                mutating = false;
            } else if trimmed.starts_with("// mutating") {
                mutating = true;
            }
        } else if let Some(rest) = line.strip_prefix("    fn ") {
            let name: String = rest.chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect();
            out.push((name, mutating));
        }
    }
    out
}

/// The body statements of every method of an `impl Platform for ...` block.
fn impl_methods(source: &str, header: &str) -> Vec<(String, Vec<String>)> {
    let start = source.find(header).unwrap_or_else(|| panic!("no `{header}`"));
    let lines: Vec<&str> = source[start..].lines().skip(1).take_while(|line| *line != "}").collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        if let Some(rest) = lines[i].strip_prefix("    fn ") {
            let name: String = rest.chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect();
            let mut open = i;
            while open < lines.len() && !lines[open].trim_end().ends_with('{') {
                open += 1;
            }
            let mut end = open + 1;
            let mut statements = Vec::new();
            while end < lines.len() && lines[end] != "    }" {
                let trimmed = lines[end].trim();
                if !trimmed.is_empty() && !trimmed.starts_with("//") {
                    statements.push(trimmed.to_string());
                }
                end += 1;
            }
            out.push((name, statements));
            i = end;
        }
        i += 1;
    }
    out
}

/// Module names whose functions change or inspect the machine, and other effects.
const EFFECT_PATHS: &[&str] = &[
    "rulebox_win32::",
    "accounts::",
    "applocker::",
    "autologon::",
    "bcd::",
    "codeintegrity::",
    "dpapi::",
    "etw::",
    "eventlog::",
    "job::",
    "lsa::",
    "machinereg::",
    "posture::",
    "printing::",
    "process::",
    "registry::",
    "security::",
    "service::",
    "session::",
    "shellreg::",
    "staffreg::",
    "tree::",
    "wlan::",
    "std::fs::",
    "fs::",
    ".spawn(",
    "Command::new",
];

/// True when `statement` names an effect path that is not a `check_*` rule call. A path
/// counts only at the start of a token (`windows::process::CommandExt` is not a call).
fn names_an_effect(statement: &str) -> Option<&'static str> {
    for path in EFFECT_PATHS {
        let mut from = 0;
        while let Some(at) = statement[from..].find(path) {
            let at = from + at;
            let before = statement[..at].chars().next_back();
            let after = &statement[at + path.len()..];
            let token_start = before.is_none_or(|c| !(c.is_alphanumeric() || c == '_' || c == ':'));
            let dotted = path.starts_with('.');
            if (token_start || dotted) && !after.starts_with("check_") {
                return Some(path);
            }
            from = at + path.len();
        }
    }
    None
}

fn violation(name: &str, statements: &[String]) -> Option<String> {
    let Some(at) = statements.iter().position(|s| s.contains(GUARD)) else {
        return Some(format!("{name}: no `{GUARD}`"));
    };
    for statement in &statements[..at] {
        if let Some(path) = names_an_effect(statement) {
            return Some(format!("{name}: `{statement}` names `{path}` before the guard"));
        }
    }
    None
}

fn windows_violations(windows_rs: &str, names: &[String]) -> Vec<String> {
    let methods = impl_methods(windows_rs, "impl Platform for WindowsPlatform {");
    let mut problems = Vec::new();
    for name in names {
        match methods.iter().find(|(method, _)| method == name) {
            Some((_, statements)) => problems.extend(violation(name, statements)),
            None => problems.push(format!("{name}: not implemented in WindowsPlatform")),
        }
    }
    problems
}

#[test]
fn the_list_is_exactly_the_mutating_methods_of_the_trait() {
    let mod_rs = read("src/platform/mod.rs");
    let listed: BTreeSet<String> = mutating_methods(&mod_rs).into_iter().collect();
    assert_eq!(listed.len(), mutating_methods(&mod_rs).len(), "a name is listed twice");
    let declared: BTreeSet<String> =
        trait_methods(&mod_rs).into_iter().filter(|(_, mutating)| *mutating).map(|(name, _)| name).collect();
    assert_eq!(listed, declared, "MUTATING_METHODS and the trait's mutating sections differ");
    // A read-only section never lists one of them.
    for (name, mutating) in trait_methods(&mod_rs) {
        assert!(mutating || !listed.contains(&name), "{name} is listed but declared read-only");
    }
}

#[test]
fn every_mutating_method_exists_in_both_platforms() {
    let names = mutating_methods(&read("src/platform/mod.rs"));
    assert!(names.len() >= 38, "{}", names.len());
    for (file, header) in [
        ("src/platform/windows.rs", "impl Platform for WindowsPlatform {"),
        ("src/platform/sim.rs", "impl Platform for SimPlatform {"),
    ] {
        let methods: Vec<String> = impl_methods(&read(file), header).into_iter().map(|(name, _)| name).collect();
        for name in &names {
            assert!(methods.contains(name), "{file}: no `fn {name}`");
        }
    }
}

#[test]
fn every_mutating_method_of_windows_platform_checks_the_guard_first() {
    let names = mutating_methods(&read("src/platform/mod.rs"));
    let problems = windows_violations(&read("src/platform/windows.rs"), &names);
    assert!(problems.is_empty(), "{problems:#?}");
}

#[test]
fn removing_a_guard_line_from_windows_platform_makes_the_scan_fail() {
    let names = mutating_methods(&read("src/platform/mod.rs"));
    let original = read("src/platform/windows.rs");
    let header = original.find("impl Platform for WindowsPlatform {").expect("the impl");
    let in_impl_end = header + original[header..].find("\n}\n").expect("the impl ends");
    let mut noticed = 0;
    let mut tried = 0;
    for (at, _) in original.match_indices(GUARD).filter(|(at, _)| *at > header && *at < in_impl_end) {
        let line_start = original[..at].rfind('\n').map_or(0, |n| n + 1);
        let line_end = at + original[at..].find('\n').map_or(original.len() - at, |n| n + 1);
        // Only a line that is the whole statement (the guard of a method).
        if original[line_start..line_end].trim() != GUARD {
            continue;
        }
        tried += 1;
        let mutated = format!("{}{}", &original[..line_start], &original[line_end..]);
        if !windows_violations(&mutated, &names).is_empty() {
            noticed += 1;
        }
    }
    // Methods whose guard is not on a line of its own are not counted here; there must
    // still be one for (nearly) every method.
    assert!(tried >= names.len() - 3, "{tried} guard lines for {} methods", names.len());
    assert_eq!(noticed, tried, "every removed guard must be noticed");
}

#[test]
fn the_scanner_notices_each_way_to_get_it_wrong() {
    let ok = |lines: &[&str]| lines.iter().map(|l| (*l).to_string()).collect::<Vec<_>>();
    // Guard first; a pure rule check first; a local conversion first.
    assert_eq!(violation("m", &ok(&["guard()?;", "do_it()"])), None);
    assert_eq!(violation("m", &ok(&["machinereg::check_write(&p, &n, v)?;", "guard()?;", "machinereg::set(&p)"])), None);
    assert_eq!(violation("m", &ok(&["let value = data.map(|d| d.clone());", "guard()?;"])), None);
    assert_eq!(violation("m", &ok(&["use std::os::windows::process::CommandExt;", "guard()?;"])), None);
    // No guard.
    assert!(violation("m", &ok(&["machinereg::set(&p)"])).is_some());
    // The effect before the guard.
    assert!(violation("m", &ok(&["machinereg::set(&p)?;", "guard()?;"])).is_some());
    assert!(violation("m", &ok(&["std::fs::write(a, b)?;", "guard()?;"])).is_some());
    assert!(violation("m", &ok(&["let c = rulebox_win32::accounts::find_user(n)?;", "guard()?;"])).is_some());
    assert!(violation("m", &ok(&["std::process::Command::new(x).spawn()?;", "guard()?;"])).is_some());
    // A guard that is only in a string does not count as a statement before; one after the
    // effect does not help.
    assert!(violation("m", &ok(&["process::terminate(1)?;", "guard()?;"])).is_some());
}

#[test]
fn the_two_trait_sections_are_found() {
    let mod_rs = read("src/platform/mod.rs");
    let methods = trait_methods(&mod_rs);
    let find = |name: &str| methods.iter().find(|(n, _)| n == name).map(|(_, m)| *m);
    assert_eq!(find("os_info"), Some(false));
    assert_eq!(find("read_staff_value"), Some(false));
    assert_eq!(find("get_path_acl"), Some(false));
    assert_eq!(find("create_staff_user"), Some(true));
    assert_eq!(find("reset_folder"), Some(true));
    assert_eq!(find("set_path_acl"), Some(true));
    assert_eq!(find("lsa_secret_get"), Some(true), "a read that is only allowed on a test machine is listed");
}
