//! Versions, update decisions and apply windows of the install engine (plan Phase 6, 4.4 and 4.6), as
//! pure functions: no platform call, no clock, no file. The engine (`engine.rs`) reads the machine
//! and asks these what to do, so every rule here is a unit test.
//!
//! | Rule | Where |
//! |---|---|
//! | Installed version, minimum version, "never downgrade" (4.4.1, 4.4.3) | [`vendor_needs_bootstrap`], [`detection`] |
//! | Vendor "installed but the exe is not there": two looks, 15 minutes apart (4.4.3) | [`verify_step`] |
//! | Apply windows: boot, signed out, closed (4.4.5) | [`window`], [`boot_window_open`] |
//! | Keep the previous installer (4.6) | [`may_keep`] |
//! | The publisher of an installer file (4.4.3) | [`publisher_matches`] |
//! | A program in a versioned folder (4.4.3) | [`resolve_pattern`] |
//! | What wakes the engine | [`WAKE_SOURCES`] |

use std::cmp::Ordering;
use std::time::Duration;

use rulebox_policy::paths::ExePattern;

/// The boot window (plan 4.4.5 item 1): the agent started less than this long ago and no employee has
/// signed in yet.
pub const BOOT_WINDOW: Duration = Duration::from_secs(10 * 60);
/// A Vendor app whose program is missing is looked at again no sooner than this after the last look.
pub const VERIFY_GAP: Duration = Duration::from_secs(15 * 60);
/// Looks after the first miss. The second one that still finds nothing installs the bootstrap again.
pub const VERIFY_LOOKS: u32 = 2;
/// An update that failed is tried again at the next apply window, but not sooner than this (plan 4.6).
pub const UPDATE_RETRY_GAP: Duration = Duration::from_secs(3600);
/// ... and at most this many times; then it is final until a new revision (Retry).
pub const MAX_UPDATE_FAILURES: u32 = 3;
/// The previous installers kept for roll-back, all apps together (plan 4.6).
pub const KEEP_MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// Nothing is kept while the system drive has less than this free (plan 4.6).
pub const KEEP_MIN_FREE_BYTES: u64 = 3 * 1024 * 1024 * 1024;

/// What can start the install engine's loop again. **Nothing else may:** no interval, no polling
/// timer (plan 4.6 "No new timer"). `retry_timer` is the one timer the engine always had: it sleeps
/// until the earliest retry that is due (a failure's back-off, a busy installer's two minutes), and
/// never for an update that waits for an apply window (that one waits for the other four).
/// A test (`wake_sources_are_listed_and_nothing_else_wakes_the_engine`) reads the engine's source and
/// holds it to this list.
pub const WAKE_SOURCES: [&str; 5] = [
    // The signed document changed (a new version, a new revision, Retry).
    "policy",
    // Enrollment, the connection (offline -> online), the deployment.
    "snapshot",
    // An employee signed in or out (the session layer).
    "presence",
    // A process the engine waits for ended (the process handle, not a poll).
    "app_exit",
    // The earliest retry that is due.
    "retry_timer",
];

/// Whether `installed` is older than `wanted`. `None` when either has no order (plan 4.4.1): the
/// caller then does not act on it.
pub fn is_lower(installed: &str, wanted: &str) -> Option<bool> {
    rulebox_policy::version::cmp(installed, wanted).map(|order| order == Ordering::Less)
}

/// The version a program is taken to have: what its version resource says, else what the engine last
/// installed (plan 4.4.1). `None`: nothing is known.
pub fn detection(file_version: Option<String>, last_installed: Option<&str>) -> Option<String> {
    file_version.or_else(|| last_installed.map(str::to_string))
}

/// A Vendor app (plan 4.4.3) that is installed: does the bootstrap have to run again because the
/// installed version is below `minVersion`?
///
/// - nothing is ever run without a `minVersion`, an installed version and an ordered pair of them;
/// - **never a downgrade:** an installed version that is not lower than `minVersion` is left alone,
///   and so is one at or above the bootstrap's own version;
/// - a bootstrap that is itself older than `minVersion` would never fix it: refused here too (the
///   server refuses that save as `min_above_bootstrap`; this is the second check).
pub fn vendor_needs_bootstrap(installed: Option<&str>, min_version: Option<&str>, bootstrap_version: Option<&str>) -> bool {
    let (Some(installed), Some(min)) = (installed, min_version) else {
        return false;
    };
    if is_lower(installed, min) != Some(true) {
        return false;
    }
    if let Some(bootstrap) = bootstrap_version {
        // An unordered bootstrap version cannot be compared: `minVersion` itself needs an ordered one, so the
        // server never lets that pair through; here it simply counts as not fixable.
        match rulebox_policy::version::cmp(bootstrap, min) {
            Some(Ordering::Less) | None => return false,
            _ => {}
        }
        if is_lower(installed, bootstrap) == Some(false) {
            return false;
        }
    }
    true
}

/// How a version check after an install ended (plan 4.6 "Detection").
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VersionCheck {
    /// The file version is at least the catalogue's, or nothing can be compared.
    Fine,
    /// The file version is lower: `version_too_low`.
    TooLow,
}

/// `file_version` (the program's own) against the `version` the catalogue says this install delivers.
/// Only an ordered pair is compared; an unordered or missing one is `Fine`.
pub fn check_installed(file_version: Option<&str>, catalogue_version: Option<&str>) -> VersionCheck {
    match (file_version, catalogue_version) {
        (Some(file), Some(wanted)) if is_lower(file, wanted) == Some(true) => VersionCheck::TooLow,
        _ => VersionCheck::Fine,
    }
}

/// Which apply window is open (plan 4.4.5), for logs and for the "Updating apps..." hold.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowReason {
    /// The agent started less than 10 minutes ago and nobody signed in yet.
    Boot,
    /// No employee is signed in.
    SignedOut,
    /// An employee is signed in but the app is closed (`applyWhen: when_closed` only).
    Closed,
}

/// What decides whether an update may run now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WindowInputs {
    /// An employee is signed in.
    pub signed_in: bool,
    /// [`boot_window_open`].
    pub boot_open: bool,
    /// `applyWhen: when_closed`.
    pub when_closed: bool,
    /// A process of the app is running.
    pub app_running: bool,
}

/// The open window, or `None` (the update waits). **A running app always makes it wait:** the agent
/// never closes a running app (plan 4.4.5), whichever window it is. Signed out is the same as the boot
/// window for the engine; the boot window only matters to the sign-in screen's "Updating apps..." hold.
pub fn window(i: WindowInputs) -> Option<WindowReason> {
    if i.app_running {
        return None;
    }
    if !i.signed_in {
        return Some(if i.boot_open { WindowReason::Boot } else { WindowReason::SignedOut });
    }
    i.when_closed.then_some(WindowReason::Closed)
}

/// The boot window: `now_ms - started_ms` is under [`BOOT_WINDOW`] and nobody has signed in since the
/// agent started. A clock that went backwards counts as "just started" (the window can only be too
/// long by that, and it closes at the first sign-in).
pub fn boot_window_open(started_ms: u64, now_ms: u64, ever_signed_in: bool) -> bool {
    !ever_signed_in && now_ms.saturating_sub(started_ms) < u64::try_from(BOOT_WINDOW.as_millis()).unwrap_or(u64::MAX)
}

/// What to do about a Vendor app whose program is not at its path (plan 4.4.3 table, "Installed, exe not
/// found at reconcile").
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VerifyStep {
    /// First miss: start looking (nothing is installed).
    Start,
    /// Not yet: less than 15 minutes since the last look, or a program signed by the publisher runs as SYSTEM.
    Wait,
    /// Looked again, still missing: the next look decides.
    Look,
    /// The second look still found nothing: install the bootstrap again.
    Reinstall,
}

/// `since_ms` is the first miss or the last look; `looks` how many looks happened after the first miss.
/// `publisher_busy`: a process signed by the app's publisher runs as SYSTEM (the vendor's updater may be
/// replacing the program right now).
pub fn verify_step(since_ms: Option<u64>, looks: u32, now_ms: u64, publisher_busy: bool) -> VerifyStep {
    let Some(since) = since_ms else {
        return VerifyStep::Start;
    };
    let gap = u64::try_from(VERIFY_GAP.as_millis()).unwrap_or(u64::MAX);
    if now_ms.saturating_sub(since) < gap || publisher_busy {
        return VerifyStep::Wait;
    }
    if looks + 1 >= VERIFY_LOOKS {
        VerifyStep::Reinstall
    } else {
        VerifyStep::Look
    }
}

/// Whether the installer that was just used may be kept for a roll-back (plan 4.6 "Previous installer"):
/// the system drive has at least [`KEEP_MIN_FREE_BYTES`] free and the installers kept for all apps stay
/// within [`KEEP_MAX_BYTES`].
pub fn may_keep(free_bytes: u64, kept_total_bytes: u64, size_bytes: u64) -> bool {
    free_bytes >= KEEP_MIN_FREE_BYTES && kept_total_bytes.saturating_add(size_bytes) <= KEEP_MAX_BYTES
}

/// The parts of an X.500 subject: `CN=Acme, O="Acme, Inc.", C=US` is three parts. A comma inside quotes does
/// not split; a part that does not start with `KEY=` is glued to the one before (an unquoted comma in a value).
fn subject_parts(subject: &str) -> Vec<String> {
    let mut parts: Vec<String> = Vec::new();
    let mut quoted = false;
    let mut current = String::new();
    let mut pieces: Vec<String> = Vec::new();
    for c in subject.chars() {
        match c {
            '"' => {
                quoted = !quoted;
                current.push(c);
            }
            ',' if !quoted => {
                pieces.push(std::mem::take(&mut current));
            }
            _ => current.push(c),
        }
    }
    pieces.push(current);
    let is_key = |piece: &str| {
        piece.trim_start().split_once('=').is_some_and(|(key, _)| {
            !key.is_empty() && key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.')
        })
    };
    for piece in pieces {
        if parts.is_empty() || is_key(&piece) {
            parts.push(piece.trim().to_string());
        } else if let Some(last) = parts.last_mut() {
            last.push_str(", ");
            last.push_str(piece.trim());
        }
    }
    parts
}

/// One `KEY=value` of a subject as a comparable pair: the key and the value without quotes, lower case.
fn normal_part(part: &str) -> (String, String) {
    match part.split_once('=') {
        Some((key, value)) => (key.trim().to_ascii_lowercase(), value.trim().trim_matches('"').to_ascii_lowercase()),
        None => (String::new(), part.trim().to_ascii_lowercase()),
    }
}

/// Whether the signer of a file (`signer`, the leaf certificate subject of a valid signature) is the
/// `wanted` publisher of the catalogue (plan 4.4.3 `publisher_mismatch`). Every `KEY=value` of `wanted`
/// must appear in the signer, ignoring case and quotes: `O=Acme Ltd` matches `CN=Acme Ltd, O=Acme Ltd,
/// L=Oslo, C=NO`, and the full subject matches itself. An empty `wanted` matches nothing.
pub fn publisher_matches(signer: &str, wanted: &str) -> bool {
    let wanted_parts = subject_parts(wanted);
    if wanted_parts.iter().all(|part| part.is_empty()) {
        return false;
    }
    let signer_parts: Vec<(String, String)> = subject_parts(signer).iter().map(|part| normal_part(part)).collect();
    wanted_parts.iter().filter(|part| !part.is_empty()).all(|part| signer_parts.contains(&normal_part(part)))
}

/// The program path of a template that holds a `*` (plan 4.4.3): the highest-version folder among
/// `folder_names` (the folders inside `pattern.folder`), then `rest` below it. `None`: no folder fits.
pub fn resolve_pattern(pattern: &ExePattern, folder_names: &[String]) -> Option<String> {
    let name = pattern.highest(folder_names.iter().map(String::as_str))?;
    Some(format!("{}\\{}\\{}", pattern.folder, name, pattern.rest))
}

/// The folder an allow-list path rule is on for a program (plan 4.4.3): the folder above the `*` for a
/// versioned program, else the program's own folder. `exe` is what `expand_exe` returned.
pub fn program_folder(exe: &str) -> Option<String> {
    if let Some(pattern) = rulebox_policy::paths::exe_pattern(exe) {
        return Some(pattern.folder);
    }
    exe.rsplit_once('\\').map(|(folder, _)| folder.to_string())
}

/// Whether `path` names a program that has a `*` (a pattern, never something to start).
pub fn is_pattern(path: &str) -> bool {
    path.contains('*')
}

/// A kept installer's file name in the downloads folder must be a SHA-256 and an `msi` or `exe`
/// extension, whatever a hand-edited `installs.json` says.
pub fn kept_file_name(sha256: &str, ext: &str) -> Option<String> {
    (super::is_sha256(sha256) && matches!(ext, "msi" | "exe")).then(|| format!("{sha256}.{ext}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use rulebox_policy::paths::exe_pattern;

    fn at(minutes: u64) -> u64 {
        minutes * 60_000
    }

    #[test]
    fn wake_sources_are_five_named_things() {
        assert_eq!(WAKE_SOURCES, ["policy", "snapshot", "presence", "app_exit", "retry_timer"]);
    }

    #[test]
    fn lower_needs_an_order_on_both_sides() {
        assert_eq!(is_lower("1.2", "1.10"), Some(true));
        assert_eq!(is_lower("1.10", "1.2"), Some(false));
        assert_eq!(is_lower("1.2.0.0", "1.2"), Some(false));
        assert_eq!(is_lower("1.0-beta", "1.0"), Some(true), "a pre-release sorts before its release");
        assert_eq!(is_lower("v2", "1.0"), None);
        assert_eq!(is_lower("1.0", "latest"), None);
    }

    #[test]
    fn the_version_is_the_programs_own_else_what_was_installed() {
        assert_eq!(detection(Some("2.0.0.0".into()), Some("1.0.0")).as_deref(), Some("2.0.0.0"));
        assert_eq!(detection(None, Some("1.0.0")).as_deref(), Some("1.0.0"));
        assert_eq!(detection(None, None), None);
    }

    #[test]
    fn a_vendor_app_runs_its_bootstrap_only_below_the_minimum_and_never_downgrades() {
        // Below the minimum, the bootstrap is new enough: run it.
        assert!(vendor_needs_bootstrap(Some("1.0.0.0"), Some("2.0"), Some("3.0")));
        assert!(vendor_needs_bootstrap(Some("1.9"), Some("2.0"), Some("2.0")));
        // At or above the minimum: nothing.
        assert!(!vendor_needs_bootstrap(Some("2.0.0.0"), Some("2.0"), Some("3.0")));
        assert!(!vendor_needs_bootstrap(Some("5.1"), Some("2.0"), Some("3.0")), "newer than the bootstrap: never a downgrade");
        // No minimum, no installed version, no order: nothing.
        assert!(!vendor_needs_bootstrap(Some("1.0"), None, Some("3.0")));
        assert!(!vendor_needs_bootstrap(None, Some("2.0"), Some("3.0")));
        assert!(!vendor_needs_bootstrap(Some("beta"), Some("2.0"), Some("3.0")));
        assert!(!vendor_needs_bootstrap(Some("1.0"), Some("two"), Some("3.0")));
        // A bootstrap older than the minimum would never fix it (`min_above_bootstrap`).
        assert!(!vendor_needs_bootstrap(Some("1.0"), Some("2.0"), Some("1.5")));
        assert!(!vendor_needs_bootstrap(Some("1.0"), Some("2.0"), Some("nightly")));
        // The bootstrap's version is not known to be ordered: the minimum alone decides.
        assert!(vendor_needs_bootstrap(Some("1.0"), Some("2.0"), None));
        // An installed version at the bootstrap's own is not touched (it would be the same version).
        assert!(!vendor_needs_bootstrap(Some("3.0"), Some("3.0"), Some("3.0")));
    }

    #[test]
    fn a_version_check_compares_only_ordered_pairs() {
        assert_eq!(check_installed(Some("1.0.0.0"), Some("2.0")), VersionCheck::TooLow);
        assert_eq!(check_installed(Some("2.0.0.0"), Some("2.0")), VersionCheck::Fine);
        assert_eq!(check_installed(Some("3.1"), Some("2.0")), VersionCheck::Fine);
        assert_eq!(check_installed(None, Some("2.0")), VersionCheck::Fine);
        assert_eq!(check_installed(Some("1.0"), None), VersionCheck::Fine);
        assert_eq!(check_installed(Some("1.0"), Some("build 7")), VersionCheck::Fine);
    }

    #[test]
    fn the_windows_follow_the_plan() {
        let base = WindowInputs { signed_in: false, boot_open: false, when_closed: false, app_running: false };
        // 1 Boot, 2 signed out.
        assert_eq!(window(WindowInputs { boot_open: true, ..base }), Some(WindowReason::Boot));
        assert_eq!(window(base), Some(WindowReason::SignedOut));
        // Signed in: only `when_closed` lets an update run, and only with the app closed.
        let signed = WindowInputs { signed_in: true, ..base };
        assert_eq!(window(signed), None);
        assert_eq!(window(WindowInputs { when_closed: true, ..signed }), Some(WindowReason::Closed));
        // The boot window never outlives a sign-in (the caller says so), and signed-in is not boot.
        assert_eq!(window(WindowInputs { boot_open: true, ..signed }), None);
        // A running app waits in every window.
        for inputs in [
            WindowInputs { boot_open: true, app_running: true, ..base },
            WindowInputs { app_running: true, ..base },
            WindowInputs { when_closed: true, app_running: true, ..signed },
        ] {
            assert_eq!(window(inputs), None, "{inputs:?}");
        }
    }

    #[test]
    fn the_boot_window_closes_after_ten_minutes_or_the_first_sign_in() {
        assert!(boot_window_open(at(0), at(0), false));
        assert!(boot_window_open(at(0), at(9) + 59_000, false));
        assert!(!boot_window_open(at(0), at(10), false));
        assert!(!boot_window_open(at(0), at(60), false));
        assert!(!boot_window_open(at(0), at(1), true), "somebody signed in");
        assert!(boot_window_open(at(5), at(1), false), "a clock that went backwards");
    }

    #[test]
    fn a_missing_vendor_program_is_looked_at_twice_fifteen_minutes_apart() {
        use VerifyStep::*;
        // First miss.
        assert_eq!(verify_step(None, 0, at(100), false), Start);
        // Too soon, however often reconcile runs.
        assert_eq!(verify_step(Some(at(100)), 0, at(100), false), Wait);
        assert_eq!(verify_step(Some(at(100)), 0, at(114) + 59_000, false), Wait);
        // First look, 15 minutes after the miss.
        assert_eq!(verify_step(Some(at(100)), 0, at(115), false), Look);
        // Second look: 15 minutes after the first one.
        assert_eq!(verify_step(Some(at(115)), 1, at(120), false), Wait);
        assert_eq!(verify_step(Some(at(115)), 1, at(130), false), Reinstall);
        // A program signed by the publisher running as SYSTEM stops both looks.
        assert_eq!(verify_step(Some(at(100)), 0, at(500), true), Wait);
        assert_eq!(verify_step(Some(at(115)), 1, at(500), true), Wait);
    }

    #[test]
    fn keeping_an_installer_needs_free_disk_and_stays_within_two_gib() {
        const GIB: u64 = 1024 * 1024 * 1024;
        assert!(may_keep(3 * GIB, 0, 100 * 1024 * 1024));
        assert!(!may_keep(3 * GIB - 1, 0, 1), "under 3 GiB free: nothing is kept");
        assert!(may_keep(50 * GIB, GIB, GIB), "exactly 2 GiB in all");
        assert!(!may_keep(50 * GIB, GIB, GIB + 1));
        assert!(!may_keep(50 * GIB, u64::MAX, 1));
    }

    #[test]
    fn a_publisher_is_matched_by_its_parts() {
        let signer = "CN=Acme Ltd, O=Acme Ltd, L=Oslo, S=Oslo, C=NO";
        assert!(publisher_matches(signer, signer));
        assert!(publisher_matches(signer, "O=Acme Ltd"));
        assert!(publisher_matches(signer, "o=acme ltd, c=no"));
        assert!(publisher_matches(signer, "CN=Acme Ltd, O=Acme Ltd"));
        assert!(!publisher_matches(signer, "O=Acme Ltd, C=SE"));
        assert!(!publisher_matches(signer, "O=Acme"), "a prefix is not the name");
        assert!(!publisher_matches(signer, "O=Acme Ltd Evil"));
        assert!(!publisher_matches(signer, ""));
        assert!(!publisher_matches(signer, " , "));
        // A comma inside quotes, and a quoted value on either side.
        assert!(publisher_matches("CN=\"Acme, Inc.\", O=\"Acme, Inc.\", C=US", "O=Acme, Inc."));
        assert!(publisher_matches("CN=Acme Inc., O=\"Acme, Inc.\", C=US", "O=\"Acme, Inc.\""));
        assert!(!publisher_matches("CN=Acme Inc., O=Acme, C=US", "O=\"Acme, Inc.\""));
        // An unsigned file has no signer text: nothing matches (the engine never calls this for `None`).
        assert!(!publisher_matches("", "O=Acme Ltd"));
        // The key is part of the match: the same text under another key is another thing.
        assert!(!publisher_matches("CN=Acme Ltd, O=Other", "O=Acme Ltd"));
    }

    #[test]
    fn a_versioned_program_folder_resolves_to_the_highest_version() {
        let pattern = exe_pattern(r"C:\Program Files\Vendor\App\app-*\bin\app.exe").unwrap();
        let names: Vec<String> = ["app-1.2.0", "app-1.10.0", "app-1.9.9", "other", "app-beta", "readme"].map(String::from).to_vec();
        assert_eq!(resolve_pattern(&pattern, &names).as_deref(), Some(r"C:\Program Files\Vendor\App\app-1.10.0\bin\app.exe"));
        assert_eq!(resolve_pattern(&pattern, &["other".to_string()]), None);
        assert_eq!(resolve_pattern(&pattern, &[]), None);
        assert_eq!(program_folder(r"C:\Program Files\Vendor\App\app-*\bin\app.exe").as_deref(), Some(r"C:\Program Files\Vendor\App"));
        assert_eq!(program_folder(r"C:\Program Files\Vendor\app.exe").as_deref(), Some(r"C:\Program Files\Vendor"));
        assert!(is_pattern(r"C:\P\app-*\a.exe") && !is_pattern(r"C:\P\a.exe"));
    }

    #[test]
    fn a_kept_file_name_is_a_hash_and_a_known_extension() {
        let sha = "a".repeat(64);
        assert_eq!(kept_file_name(&sha, "msi").as_deref(), Some(format!("{sha}.msi").as_str()));
        assert_eq!(kept_file_name(&sha, "exe").as_deref(), Some(format!("{sha}.exe").as_str()));
        for (sha, ext) in [("..\\x".to_string(), "exe"), (sha.clone(), "bat"), (sha.clone(), "exe.part"), ("A".repeat(64), "exe"), (String::new(), "msi")] {
            assert_eq!(kept_file_name(&sha, ext), None, "{sha} {ext}");
        }
    }
}
