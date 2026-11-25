//! L1-browser (Phase 6 Step 17, plan 4.9.3): the Chrome and Edge policies that lock a browser which opens
//! web apps, compiled from the catalogue of the signed document and applied through the journal.
//!
//! * [`BrowserInputs`] is what the catalogue says (pure data, built by [`BrowserInputs::from_catalog`]):
//!   per browser, the sites that are allowed, the origins whose camera, microphone and notification
//!   permission is on, whether printing is on, and where the program is.
//! * [`compile`] is a **pure function** from one browser's inputs (and the group's upload switch) to the
//!   policy rows to write. [`FIXED_ROWS`] is the catalogue of policies as one table, with a test per row.
//! * [`apply`] writes the rows with owner [`JournalOwner::L1Browser`], restores every row the document no
//!   longer wants (so unassigning the last browser web app removes every value, and the journal restore
//!   removes the emptied keys), and records which browsers are `ready` (all their rows are journalled as
//!   applied) for `apps.list`. Disable kiosk, `unenroll`, `recover` and the last-known-good rollback restore
//!   these entries with the rest of the journal.
//! * Invariant (`invariants::check_browser_rows`): no row names a key outside the two Staff-hive roots of
//!   `staffreg::BROWSER_ROOTS`; a failing set is not written at all.
//!
//! **PENDING S-1.** Where the policies live (the Staff account's own hive, so the administrator's browser
//! stays normal) is the plan's primary design. Whether Chrome and Edge read `HKCU` policy on a workgroup PC
//! is VM spike row S-1. If they do not, the roots move to `machinereg` (a plan change that also restricts
//! the administrator's browser); nothing here adds a machine-hive root until S-1 says so.
//!
//! Policy names, types and values were re-read from the vendors' references for Chrome 159 (stable on
//! 2026-11-24; Chromium `policy_definitions` on `main`, because Google's rendered pages carry no text for
//! automated readers) and Edge 160 (Microsoft Learn, updated 2026-11-24). Lists are **subkeys** with the
//! values `1`, `2`, ... (REG_SZ); everything else is a DWORD or a string.

use std::collections::BTreeSet;

use rulebox_policy::catalog::{is_browser_site, BrowserKind, CatalogApp, CatalogKind, MAX_BROWSER_URL_PATTERNS};
use rulebox_policy::paths::{expand_exe, PathRoots};
use rulebox_policy::AgentDoc;

use super::apply::ApplyCtx;
use super::staff::Tally;
use crate::journal::{self, Change, EntryPhase, JournalOwner};
use crate::platform::RegData;
use crate::state::AgentState;

/// The two browsers (plan 4.9.1: Edge at its fixed per-machine paths, Chrome through its catalogue app).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Browser {
    Chrome,
    Edge,
}

impl Browser {
    pub const ALL: [Browser; 2] = [Browser::Chrome, Browser::Edge];

    /// The word the agent state and `apps.list` use.
    pub const fn word(self) -> &'static str {
        match self {
            Browser::Chrome => "chrome",
            Browser::Edge => "edge",
        }
    }

    /// The policy root in the Staff hive (one of `staffreg::BROWSER_ROOTS`).
    pub const fn root(self) -> &'static str {
        match self {
            Browser::Chrome => rulebox_win32::staffreg::BROWSER_ROOTS[0],
            Browser::Edge => rulebox_win32::staffreg::BROWSER_ROOTS[1],
        }
    }

    /// The program's file name, lower case.
    pub const fn exe_name(self) -> &'static str {
        match self {
            Browser::Chrome => "chrome.exe",
            Browser::Edge => "msedge.exe",
        }
    }

    pub fn of_kind(kind: BrowserKind) -> Option<Browser> {
        match kind.effective() {
            BrowserKind::Chrome => Some(Browser::Chrome),
            BrowserKind::Edge => Some(Browser::Edge),
            _ => None,
        }
    }

    pub fn kind(self) -> BrowserKind {
        match self {
            Browser::Chrome => BrowserKind::Chrome,
            Browser::Edge => BrowserKind::Edge,
        }
    }
}

/// Which browser a desktop program is, by its file name (`chrome.exe`, `msedge.exe`, any folder, any case):
/// the same rule as `browserAppOf` on the server.
pub fn browser_of_exe(exe: &str) -> Option<Browser> {
    let name = exe.rsplit(['\\', '/']).next()?.to_ascii_lowercase();
    Browser::ALL.into_iter().find(|browser| browser.exe_name() == name)
}

// ---------------------------------------------------------------- inputs from the catalogue

/// What the catalogue asks of one browser. All sets are sorted and without duplicates.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BrowserSide {
    /// The allowed addresses (`URLAllowlist`): `https://host[:port]`, subdomains included.
    pub sites: BTreeSet<String>,
    /// Origins whose camera permission is on (`VideoCaptureAllowedUrls`): `https://[*.]host[:port]/`.
    pub camera: BTreeSet<String>,
    /// Origins whose microphone permission is on (`AudioCaptureAllowedUrls`).
    pub microphone: BTreeSet<String>,
    /// Origins whose notification permission is on (`NotificationsAllowedForUrls`).
    pub notifications: BTreeSet<String>,
    /// Some assigned browser web app allows printing (one switch for the whole browser, plan 4.9.8).
    pub printing: bool,
    /// The program, when it is on this PC (what `apps.list` calls `browserExe`).
    pub exe: Option<String>,
    /// The folder of the program, for the allow-list's path rule (plan 4.9.4); `None` when the program is not there.
    pub folder: Option<String>,
}

/// What the document asks of both browsers; `None` = no assigned browser web app and no Chrome or Edge program.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BrowserInputs {
    pub chrome: Option<BrowserSide>,
    pub edge: Option<BrowserSide>,
}

/// `(host, port)` of an `https://` address; `None` for anything else (an IPv6 literal, no host).
fn host_and_port(url: &str) -> Option<(String, Option<u16>)> {
    let rest = url.get(..8).filter(|scheme| scheme.eq_ignore_ascii_case("https://")).map(|_| &url[8..])?;
    let authority = rest.split(['/', '?', '#']).next()?;
    let authority = authority.rsplit('@').next()?;
    if authority.starts_with('[') {
        return None;
    }
    let (host, port) = match authority.split_once(':') {
        Some((host, port)) => (host, Some(port.parse::<u16>().ok()?)),
        None => (authority, None),
    };
    (!host.is_empty()).then(|| (host.to_ascii_lowercase(), port))
}

/// An allowed-domain entry as a host: `example.com` and `*.example.com` are both `example.com` (a browser URL
/// pattern for a host already covers its subdomains). A malformed entry is ignored: it cannot widen anything.
fn domain_host(entry: &str) -> Option<String> {
    is_browser_site(entry).then(|| entry.strip_prefix("*.").unwrap_or(entry).to_string())
}

fn site_pattern(host: &str, port: Option<u16>) -> String {
    match port {
        Some(port) => format!("https://{host}:{port}"),
        None => format!("https://{host}"),
    }
}

fn origin_pattern(host: &str, port: Option<u16>) -> String {
    match port {
        Some(port) => format!("https://[*.]{host}:{port}/"),
        None => format!("https://[*.]{host}/"),
    }
}

impl BrowserInputs {
    pub fn side(&self, browser: Browser) -> Option<&BrowserSide> {
        match browser {
            Browser::Chrome => self.chrome.as_ref(),
            Browser::Edge => self.edge.as_ref(),
        }
    }

    fn side_mut(&mut self, browser: Browser) -> &mut BrowserSide {
        match browser {
            Browser::Chrome => self.chrome.get_or_insert_with(BrowserSide::default),
            Browser::Edge => self.edge.get_or_insert_with(BrowserSide::default),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.chrome.is_none() && self.edge.is_none()
    }

    /// The program folders the allow-list gets a Staff path rule for while the browser is assigned (plan 4.9.4).
    /// The allow-list compiler still refuses a folder that standard users can write to.
    pub fn allow_folders(&self) -> Vec<String> {
        Browser::ALL.into_iter().filter_map(|browser| self.side(browser)?.folder.clone()).collect()
    }

    /// Reads the catalogue (plan 4.9.3). A web app counts for its browser (`Edge`, or `Chrome` with the id of a
    /// Chrome program that is in this catalogue); a Chrome or Edge program counts for its browser with its own
    /// allowed sites (`browserSites`, none = the browser's blocked page). `exists` is a file check.
    pub fn from_catalog(catalog: &[CatalogApp], roots: Option<&PathRoots>, exists: &dyn Fn(&str) -> bool) -> Self {
        let mut inputs = BrowserInputs::default();
        let expand = |app: &CatalogApp| -> Option<String> {
            let desktop = app.desktop.as_ref()?;
            expand_exe(&desktop.exe, &app.id, app.is_portable(), roots?).ok()
        };
        // The Chrome and Edge programs of the catalogue.
        for app in catalog.iter().filter(|app| app.kind == CatalogKind::Desktop) {
            let Some(desktop) = app.desktop.as_ref() else { continue };
            let Some(browser) = browser_of_exe(&desktop.exe) else { continue };
            let side = inputs.side_mut(browser);
            side.sites.extend(desktop.browser_sites().iter().filter_map(|site| domain_host(site)).map(|host| site_pattern(&host, None)));
            if browser == Browser::Chrome {
                if let Some(exe) = expand(app) {
                    if side.folder.is_none() {
                        side.folder = crate::installs::version::program_folder(&exe);
                    }
                    if side.exe.is_none() && exists(&exe) {
                        side.exe = Some(exe);
                    }
                }
            }
        }
        // The web apps that open in a browser.
        for app in catalog.iter().filter(|app| app.kind == CatalogKind::Web) {
            let Some(web) = app.web.as_ref() else { continue };
            let Some(browser) = Browser::of_kind(web.browser_kind()) else { continue };
            if browser == Browser::Chrome {
                let chrome_app = web
                    .browser
                    .as_ref()
                    .and_then(|choice| choice.app_id.as_deref())
                    .and_then(|id| catalog.iter().find(|candidate| candidate.id == id))
                    .and_then(|candidate| candidate.desktop.as_ref());
                // The Chrome program must be in this catalogue and still be Chrome: else the Staff App opens the built-in window.
                if !chrome_app.is_some_and(|desktop| browser_of_exe(&desktop.exe) == Some(Browser::Chrome)) {
                    continue;
                }
            }
            let mut origins: Vec<(String, Option<u16>)> = Vec::new();
            if let Some(start) = host_and_port(&web.url) {
                origins.push(start);
            }
            origins.extend(web.allowed_domains.iter().filter_map(|domain| domain_host(domain)).map(|host| (host, None)));
            let side = inputs.side_mut(browser);
            for (host, port) in &origins {
                side.sites.insert(site_pattern(host, *port));
                if web.permissions.camera {
                    side.camera.insert(origin_pattern(host, *port));
                }
                if web.permissions.microphone {
                    side.microphone.insert(origin_pattern(host, *port));
                }
                if web.permissions.notifications {
                    side.notifications.insert(origin_pattern(host, *port));
                }
            }
            side.printing |= web.permissions.printing;
        }
        // Edge is at its fixed per-machine paths (x86 folder first, as the compatibility check reads them).
        if let (Some(side), Some(roots)) = (inputs.edge.as_mut(), roots) {
            let homes: Vec<&str> = roots.program_files_x86.as_deref().into_iter().chain(std::iter::once(roots.program_files.as_str())).collect();
            for home in homes {
                let exe = format!(r"{}\Microsoft\Edge\Application\msedge.exe", home.trim_end_matches('\\'));
                if exists(&exe) {
                    side.folder = crate::installs::version::program_folder(&exe);
                    side.exe = Some(exe);
                    break;
                }
            }
        }
        inputs
    }
}

// ---------------------------------------------------------------- the policy table

/// One policy value of the table.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fixed {
    Dword(u32),
    Text(&'static str),
    /// A list policy: a subkey with the values `1`, `2`, ...
    List(&'static [&'static str]),
}

/// One row of the catalogue of plan 4.9.3. `chrome` and `edge` are the policy names; `None` = the browser has none.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FixedRow {
    pub chrome: Option<&'static str>,
    pub edge: Option<&'static str>,
    pub value: Fixed,
    /// Why; whether a browser restart is needed is in the plan's table.
    pub why: &'static str,
}

const fn both(name: &'static str, value: Fixed, why: &'static str) -> FixedRow {
    FixedRow { chrome: Some(name), edge: Some(name), value, why }
}

/// Everything that goes in the block list: `*` first (every address that is not allowed), then the schemes by
/// name so the list stays correct if `*` is ever narrowed. `chrome://*` because from Chrome 147 a bare `*` no
/// longer covers it; Edge's `edge://*` follows the plan, although Microsoft calls blocking it "not recommended"
/// (it may lead to unexpected errors): **the Step 24 VM run checks the window still works** and the row goes if not.
const CHROME_BLOCKLIST: &[&str] = &["*", "chrome://*", "file://*", "view-source:*", "javascript:*", "data:*", "ftp://*"];
const EDGE_BLOCKLIST: &[&str] = &["*", "edge://*", "file://*", "view-source:*", "javascript:*", "data:*", "ftp://*"];

/// Edge `ConfigureKeyboardShortcuts` (REG_SZ JSON): the commands that open a second window, the downloads,
/// history and favourites pages, the page source, the file dialog and page saving, the task manager, clearing
/// data and the profile menu. Edge has no command id for "settings" (the plan listed it): the URL block list and
/// `BrowserAddProfileEnabled` cover what the shortcut cannot.
const EDGE_SHORTCUTS: &str = r#"{"disabled":["new_window","new_inprivate_window","downloads","history","favorites","view_source","open_file","save_page","task_manager","clear_browsing_data","profile"]}"#;

/// The fixed part of the catalogue (plan 4.9.3, re-read for Chrome 159 and Edge 160). The rows that depend on
/// the document (the allow list, uploads, printing and the per-origin lists) are made by [`compile`].
pub const FIXED_ROWS: &[FixedRow] = &[
    FixedRow { chrome: Some("URLBlocklist"), edge: None, value: Fixed::List(CHROME_BLOCKLIST), why: "everything not allowed, and the internal pages" },
    FixedRow { chrome: None, edge: Some("URLBlocklist"), value: Fixed::List(EDGE_BLOCKLIST), why: "everything not allowed, and the internal pages" },
    both("DeveloperToolsAvailability", Fixed::Dword(2), "no developer tools (also the page source, Chrome 99 and later)"),
    both("DownloadRestrictions", Fixed::Dword(3), "all downloads blocked (deviation from PRD 24.1, Q6)"),
    FixedRow { chrome: Some("IncognitoModeAvailability"), edge: Some("InPrivateModeAvailability"), value: Fixed::Dword(1), why: "no private window (needs a browser restart)" },
    both("BrowserGuestModeEnabled", Fixed::Dword(0), "no guest profile"),
    FixedRow { chrome: Some("BrowserAddPersonEnabled"), edge: Some("BrowserAddProfileEnabled"), value: Fixed::Dword(0), why: "no new profile" },
    both("BrowserSignin", Fixed::Dword(0), "no browser sign-in (needs a browser restart)"),
    both("SyncDisabled", Fixed::Dword(1), "no sync"),
    both("PasswordManagerEnabled", Fixed::Dword(0), "no password manager"),
    both("ExtensionInstallBlocklist", Fixed::List(&["*"]), "no extension may be installed"),
    both("DefaultGeolocationSetting", Fixed::Dword(2), "location blocked (PRD 24.1)"),
    both("DefaultNotificationsSetting", Fixed::Dword(2), "notifications blocked unless an app's origin is listed"),
    both("DefaultClipboardSetting", Fixed::Dword(2), "clipboard read blocked in v1"),
    both("ScreenCaptureAllowed", Fixed::Dword(0), "screen sharing blocked in v1"),
    both("VideoCaptureAllowed", Fixed::Dword(0), "camera blocked except the listed origins"),
    both("AudioCaptureAllowed", Fixed::Dword(0), "microphone blocked except the listed origins"),
    both("ExternalProtocolDialogShowAlwaysOpenCheckbox", Fixed::Dword(0), "no 'always open' for external programs (needs a restart)"),
    both("BackgroundModeEnabled", Fixed::Dword(0), "no process after the last window closes"),
    FixedRow { chrome: None, edge: Some("StartupBoostEnabled"), value: Fixed::Dword(0), why: "memory; no process after sign-in" },
    FixedRow { chrome: None, edge: Some("SleepingTabsEnabled"), value: Fixed::Dword(1), why: "memory; effect on --app windows not stated (VM)" },
    FixedRow { chrome: None, edge: Some("EfficiencyModeEnabled"), value: Fixed::Dword(1), why: "memory; effect on --app windows not stated (VM)" },
    FixedRow { chrome: Some("HighEfficiencyModeEnabled"), edge: None, value: Fixed::Dword(1), why: "memory saver, Chrome's counterpart of the two Edge rows (VM)" },
    FixedRow { chrome: None, edge: Some("ConfigureKeyboardShortcuts"), value: Fixed::Text(EDGE_SHORTCUTS), why: "no new window, downloads, history, ... shortcuts (needs a restart)" },
];

// Policies that depend on the document.
pub const URL_ALLOWLIST: &str = "URLAllowlist";
pub const ALLOW_FILE_DIALOGS: &str = "AllowFileSelectionDialogs";
pub const PRINTING: &str = "PrintingEnabled";
pub const CAMERA_URLS: &str = "VideoCaptureAllowedUrls";
pub const MICROPHONE_URLS: &str = "AudioCaptureAllowedUrls";
pub const NOTIFICATION_URLS: &str = "NotificationsAllowedForUrls";

/// One value to write in the Staff hive.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PolicyRow {
    /// Relative to the hive; below a browser root.
    pub path: String,
    pub name: String,
    pub data: RegData,
}

impl PolicyRow {
    pub fn id(&self) -> String {
        journal::staff_id(&self.path, &self.name)
    }
}

/// Why a browser's rows could not be made.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompileError {
    /// More than [`MAX_BROWSER_URL_PATTERNS`] allowed addresses (the document check refuses this first).
    TooManyUrls,
}

impl CompileError {
    pub const fn code(self) -> &'static str {
        match self {
            CompileError::TooManyUrls => "browser_too_many_urls",
        }
    }
}

fn dword(browser: Browser, name: &str, value: u32) -> PolicyRow {
    PolicyRow { path: browser.root().to_string(), name: name.to_string(), data: RegData::Dword(value) }
}

fn list<'a>(browser: Browser, name: &str, items: impl IntoIterator<Item = &'a str>, out: &mut Vec<PolicyRow>) {
    for (index, item) in items.into_iter().enumerate() {
        out.push(PolicyRow {
            path: format!(r"{}\{name}", browser.root()),
            name: (index + 1).to_string(),
            data: RegData::String(item.to_string()),
        });
    }
}

/// **The pure function** of plan 4.9.3 / Step 17 item 2: one browser's inputs (and the group's upload switch) to
/// the rows to write, in a fixed order: the fixed table, then the document's own.
pub fn compile(browser: Browser, side: &BrowserSide, uploads: bool) -> Result<Vec<PolicyRow>, CompileError> {
    if side.sites.len() > MAX_BROWSER_URL_PATTERNS {
        return Err(CompileError::TooManyUrls);
    }
    let mut rows = Vec::new();
    for row in FIXED_ROWS {
        let name = match browser {
            Browser::Chrome => row.chrome,
            Browser::Edge => row.edge,
        };
        let Some(name) = name else { continue };
        match row.value {
            Fixed::Dword(value) => rows.push(dword(browser, name, value)),
            Fixed::Text(text) => rows.push(PolicyRow { path: browser.root().to_string(), name: name.to_string(), data: RegData::String(text.to_string()) }),
            Fixed::List(items) => list(browser, name, items.iter().copied(), &mut rows),
        }
    }
    // The allow list wins over the block list; none allowed = the browser's blocked page.
    list(browser, URL_ALLOWLIST, side.sites.iter().map(String::as_str), &mut rows);
    // Off breaks uploads; on only when the group's switch is on.
    rows.push(dword(browser, ALLOW_FILE_DIALOGS, u32::from(uploads)));
    rows.push(dword(browser, PRINTING, u32::from(side.printing)));
    list(browser, CAMERA_URLS, side.camera.iter().map(String::as_str), &mut rows);
    list(browser, MICROPHONE_URLS, side.microphone.iter().map(String::as_str), &mut rows);
    list(browser, NOTIFICATION_URLS, side.notifications.iter().map(String::as_str), &mut rows);
    Ok(rows)
}

/// What [`planned_rows`] made: the rows of each browser, and the browsers whose rows could not be made.
pub type Planned = (Vec<(Browser, Vec<PolicyRow>)>, Vec<(Browser, CompileError)>);

/// The rows of both browsers for these inputs, and the browsers whose rows could not be made.
pub fn planned_rows(inputs: &BrowserInputs, uploads: bool) -> Planned {
    let (mut rows, mut errors) = (Vec::new(), Vec::new());
    for browser in Browser::ALL {
        let Some(side) = inputs.side(browser) else { continue };
        match compile(browser, side, uploads) {
            Ok(made) => rows.push((browser, made)),
            Err(error) => errors.push((browser, error)),
        }
    }
    (rows, errors)
}

// ---------------------------------------------------------------- apply

/// What [`apply`] did, beyond the tally.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BrowserOutcome {
    /// A browser is assigned (the Staff layer then reports itself `on`).
    pub active: bool,
    /// The browsers whose rows are all journalled as applied.
    pub ready: BTreeSet<String>,
}

/// Whether `apps.list` may say `browserReady` for `browser`: the apply marked it, and its journal entries are
/// really there and applied (a restored journal, Disable kiosk or `unenroll`, leaves no rows and so no readiness).
pub fn is_ready(state: &AgentState, browser: Browser) -> bool {
    if !state.browser_ready.contains(browser.word()) {
        return false;
    }
    let prefix = format!("staff:{}", browser.root());
    state.journal.iter().any(|entry| entry.owner == JournalOwner::L1Browser && entry.phase == EntryPhase::Applied && entry.id.starts_with(&prefix))
}

fn browser_of_path(path: &str) -> Option<Browser> {
    let lower = path.to_ascii_lowercase();
    Browser::ALL.into_iter().find(|browser| {
        let root = browser.root().to_ascii_lowercase();
        lower == root || lower.starts_with(&format!("{root}\\"))
    })
}

/// Applies (or, with no assigned browser, removes) the browser policies for the verified document: journal first
/// through `journal::change`, owner `L1-browser`. Idempotent; drift is re-asserted because a changed value is
/// simply written again. Fixed codes only.
pub(super) fn apply(ctx: &ApplyCtx<'_>, doc: &AgentDoc, tally: &mut Tally) -> BrowserOutcome {
    let inputs = &ctx.facts.browser;
    let shared = ctx.journal.shared;
    let has_staff = shared.read(|state| state.staff.is_some());
    let (planned, errors) = planned_rows(inputs, doc.browser_uploads);
    let mut failed: BTreeSet<Browser> = BTreeSet::new();
    for (browser, error) in &errors {
        tally.record(Err(error.code()));
        failed.insert(*browser);
    }

    // Invariant: nothing outside the two roots; a set that fails is not written at all.
    let all_rows: Vec<&PolicyRow> = planned.iter().flat_map(|(_, rows)| rows.iter()).collect();
    if let Err(code) = super::invariants::check_browser_rows(all_rows.iter().map(|row| (row.path.as_str(), row.name.as_str()))) {
        tally.record(Err(code));
        update_ready(ctx, &BTreeSet::new(), tally);
        return BrowserOutcome { active: !inputs.is_empty(), ready: BTreeSet::new() };
    }

    let mut wanted: BTreeSet<String> = BTreeSet::new();
    for (browser, rows) in &planned {
        wanted.extend(rows.iter().map(PolicyRow::id));
        if !has_staff {
            tally.record(Err("no_staff_account"));
            failed.insert(*browser);
            continue;
        }
        for row in rows {
            let change = Change::staff(JournalOwner::L1Browser, &row.path, &row.name, Some(row.data.clone())).since(ctx.version);
            match journal::change(&ctx.journal, &change) {
                Ok(_) => tally.record(Ok(())),
                Err(error) => {
                    tally.record(Err(journal::error_code(&error)));
                    failed.insert(*browser);
                }
            }
        }
    }

    // Rows the document no longer wants (a site taken away, a permission switched off, the last browser app
    // unassigned): put the original back. A browser whose rows could not be made keeps what it has.
    let kept: BTreeSet<String> = errors.iter().map(|(browser, _)| format!("staff:{}", browser.root())).collect();
    let stale: Vec<String> = shared.read(|state| {
        state
            .journal
            .iter()
            .filter(|entry| entry.owner == JournalOwner::L1Browser && !wanted.contains(&entry.id))
            .filter(|entry| !kept.iter().any(|prefix| entry.id.starts_with(prefix.as_str())))
            .map(|entry| entry.id.clone())
            .collect()
    });
    if !stale.is_empty() {
        let report = journal::restore_ids(&ctx.journal, &stale);
        for _ in &report.restored {
            tally.record(Ok(()));
        }
        for (id, error) in &report.failed {
            tally.record(Err(journal::error_code(error)));
            if let Some(browser) = id.strip_prefix("staff:").and_then(|rest| rest.split('|').next()).and_then(browser_of_path) {
                failed.insert(browser);
            }
        }
    }

    let ready: BTreeSet<String> = planned
        .iter()
        .map(|(browser, _)| *browser)
        .filter(|browser| has_staff && !failed.contains(browser))
        .map(|browser| browser.word().to_string())
        .collect();
    update_ready(ctx, &ready, tally);
    BrowserOutcome { active: !inputs.is_empty(), ready }
}

/// Records the ready browsers in the agent state (only when they changed).
fn update_ready(ctx: &ApplyCtx<'_>, ready: &BTreeSet<String>, tally: &mut Tally) {
    if ctx.journal.shared.read(|state| &state.browser_ready == ready) {
        return;
    }
    let ready = ready.clone();
    if let Err(error) = ctx.journal.shared.update(move |state| state.browser_ready = ready) {
        tracing::error!("cannot save the browser readiness: {error}");
        tally.record(Err("state_not_saved"));
    }
}

#[cfg(test)]
mod tests;
