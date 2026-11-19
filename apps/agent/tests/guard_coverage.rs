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

// -- (Phase 6 Step 5, plan 4.11) the test-only door -------------------------------------------------
//
// `require_armed_machine` is the guard of everything that runs on an installed PC. The test-marker
// door alone (`require_test_machine`, `is_test_machine`) is for dev and VM helpers. This scan lists
// every non-test use of it in the agent, the shell launcher, the Staff App and the shared crates, so
// a new one is a decision made here, in the open, and not an accident.

/// (file relative to the repo root, how many uses, why the test door alone is right).
const TEST_DOOR_USES: &[(&str, usize, &str)] = &[
    (
        "apps/agent/src/service.rs",
        1,
        "guard_destructive: `service install` and `service uninstall` are dev and VM commands; the MSI installs the service in production",
    ),
    (
        "apps/shell-launcher/src/crashflag.rs",
        1,
        "the debug-only crash-loop flag: a release build has no code for it, and a test marker is required",
    ),
];

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("..")
}

/// Every `.rs` file under `dir`, with `/` separators in the paths relative to the repo root.
fn rust_files(dir: &std::path::Path, found: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            rust_files(&path, found);
        } else if path.extension().is_some_and(|e| e == "rs") {
            found.push(path);
        }
    }
}

/// The production part of a source file: nothing for test files, and nothing from the first
/// `#[cfg(test)]` (or `#[cfg(all(test, ...))]`) on.
fn production_code(relative: &str, text: &str) -> String {
    let file_name = relative.rsplit('/').next().unwrap_or(relative);
    if file_name == "tests.rs" || relative.contains("/tests/") {
        return String::new();
    }
    let cut = text.lines().position(|l| l.trim_start().starts_with("#[cfg(test)]") || l.trim_start().starts_with("#[cfg(all(test"));
    match cut {
        Some(at) => text.lines().take(at).collect::<Vec<_>>().join("\n"),
        None => text.to_string(),
    }
}

fn count_test_door(code: &str) -> usize {
    code.matches("require_test_machine").count() + code.matches("is_test_machine").count()
}

/// What is wrong with the test-door uses found: a use that is not listed, or a count that differs.
fn test_door_problems(found: &[(String, usize)]) -> Vec<String> {
    let mut problems = Vec::new();
    for (file, count) in found {
        match TEST_DOOR_USES.iter().find(|(name, _, _)| name == file) {
            None => problems.push(format!("{file}: {count} use(s) of the test door alone; use the armed guard, or list it with a reason")),
            Some((_, allowed, _)) if allowed != count => problems.push(format!("{file}: {count} use(s), the list says {allowed}")),
            Some(_) => {}
        }
    }
    for (name, _, _) in TEST_DOOR_USES {
        if !found.iter().any(|(file, _)| file == name) {
            problems.push(format!("{name} is listed but has no test-door use any more; remove it from the list"));
        }
    }
    problems
}

fn scan_test_door_uses() -> (usize, Vec<(String, usize)>) {
    let root = repo_root();
    let mut roots = vec![
        root.join("apps").join("agent").join("src"),
        root.join("apps").join("shell-launcher").join("src"),
        root.join("apps").join("staff-app").join("src-tauri").join("src"),
    ];
    if let Ok(entries) = std::fs::read_dir(root.join("crates")) {
        roots.extend(entries.flatten().map(|e| e.path().join("src")));
    }
    let mut files = Vec::new();
    for dir in &roots {
        rust_files(dir, &mut files);
    }
    let mut found = Vec::new();
    for path in &files {
        let relative = path
            .strip_prefix(&root)
            .unwrap_or(path)
            .to_string_lossy()
            .replace('\\', "/")
            .trim_start_matches("./")
            .to_string();
        if relative == "crates/rulebox-win32/src/guard.rs" {
            continue; // the definitions
        }
        let text = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()));
        let count = count_test_door(&production_code(&relative, &text));
        if count > 0 {
            found.push((relative, count));
        }
    }
    (files.len(), found)
}

#[test]
fn the_test_marker_alone_opens_only_the_listed_dev_helpers() {
    let (scanned, found) = scan_test_door_uses();
    assert!(scanned > 40, "the scan read too few files ({scanned})");
    let problems = test_door_problems(&found);
    assert!(problems.is_empty(), "{problems:#?}");
    for (_, _, why) in TEST_DOOR_USES {
        assert!(!why.is_empty());
    }
}

#[test]
fn the_test_door_scanner_notices_each_way_to_get_it_wrong() {
    // An unlisted use, a changed count, a listed file with no use left.
    assert_eq!(test_door_problems(&[("apps/agent/src/kiosk.rs".to_string(), 1)]).len(), 3);
    let listed: Vec<(String, usize)> = TEST_DOOR_USES.iter().map(|(name, count, _)| (name.to_string(), *count)).collect();
    assert!(test_door_problems(&listed).is_empty());
    let mut more = listed.clone();
    more[0].1 += 1;
    assert_eq!(test_door_problems(&more).len(), 1);
    // Test code is not counted; production code is.
    let source = "fn a() { rulebox_win32::guard::require_test_machine(); }\n#[cfg(test)]\nmod tests { fn b() { is_test_machine(); } }\n";
    assert_eq!(count_test_door(&production_code("apps/agent/src/x.rs", source)), 1);
    assert_eq!(count_test_door(&production_code("apps/agent/src/x/tests.rs", source)), 0);
    // The armed guard is not the test door.
    assert_eq!(count_test_door("require_armed_machine(); is_armed_machine();"), 0);
}

#[test]
fn recover_and_the_data_directory_use_the_armed_guard() {
    // `recover` is the way back on an installed PC; creating the data directory happens at the
    // service's first start. Neither may be limited to the test marker.
    let recover = read("src/recover.rs");
    assert!(production_code("apps/agent/src/recover.rs", &recover).contains("guard_armed(\"recover\")"));
    let service = read("src/service.rs");
    let service = production_code("apps/agent/src/service.rs", &service);
    assert!(service.contains("guard_destructive(\"service install\")"));
    assert!(service.contains("guard_destructive(\"service uninstall\")"));
    let windows = read("src/platform/windows.rs");
    let windows = production_code("apps/agent/src/platform/windows.rs", &windows);
    assert!(windows.contains("require_armed_machine().map_err(map_err)"));
    assert!(windows.matches("require_armed_machine().context(").count() == 2);
}
