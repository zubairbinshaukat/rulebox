//! L3, AppLocker for the Staff account (plan 4.9, Phase 5 Step 7).
//!
//! The agent compiles one deterministic policy XML from the document and the machine and
//! installs it through the journal (`Change::app_locker`, owner `L3`). The rules (plan 4.9):
//!
//! 1. Administrators (`S-1-5-32-544`) allow everything, so `rulebox-agent recover` and the way
//!    back always work (invariant I6).
//! 2. Every other enabled local account except Staff allows everything (re-read at each
//!    apply), and so do the system principals in [`SYSTEM_PRINCIPALS`] (**an addition to the
//!    plan**: without them AppLocker's default deny would also stop Windows' own services and
//!    the desktop window manager, which no user rule covers; each entry says why).
//! 3. Everyone may start programs from the invariant folders (Rulebox, WebView2).
//! 4. The Staff SID may start the [`AllowList`]: the Windows folder minus the writable folders
//!    and [`STAFF_DENY_WINDOWS_BINARIES`], the admin-only catalogue folders and the exceptions.
//!    **Only the Staff SID ever gets a restrictive rule**; there is no deny rule at all.
//! 5. Packaged apps: Staff gets only [`STAFF_ALLOWED_PACKAGES`].
//!
//! Collections: EXE, MSI, Script and Appx. The DLL collection stays off (plan 4.9).
//! `appLocker.mode` is `AuditOnly` or `Enabled`; `off` removes the policy through the journal.
//! Rule ids are name-based UUIDs of the rule content (SHA-256 truncated, version 8: the plan's
//! "UUIDv5" would need SHA-1, a dependency this crate does not have), so the same input gives
//! the same XML.
//!
//! * **Mechanism**: [`mechanism_for`] picks the CSP or the local policy store per edition; both
//!   are implemented in `rulebox-win32`. Which one Windows Pro honours is **unverified**
//!   (plan Section 21), as is whether the rules reach processes the SYSTEM service starts.
//! * **Foreign policy**: rules in the local store that the journal did not put there are never
//!   edited or merged: the layer reports `applocker_foreign_policy` and writes nothing.
//! * **Application Identity service**: `AppIDSvc` is set to automatic through the journal
//!   (`svc-start:AppIDSvc`). The agent does not start it (no seam for that yet), so the layer
//!   reports `restartPending` until the PC has booted.
//! * **Audit first** (invariant I9) is a shared mechanism of the layers with an `enforce` mode
//!   and is not part of this step.

use std::fmt::Write as _;
use std::path::Path;

use rulebox_policy::lockdown::LayerMode;
use rulebox_policy::paths::PathRoots;
use rulebox_policy::AgentDoc;
use sha2::{Digest, Sha256};

use super::allowlist::{
    self, clean, inside, AllowException, AllowList, Inputs, MICROSOFT_WINDOWS_PUBLISHER, STAFF_ALLOWED_PACKAGES,
};
use super::apply::ApplyCtx;
use super::invariants::Generated;
use super::staff::Tally;
use super::{LayerState, LayerStatus, ReportedMode};
use crate::installs::engine::{rebooted_since, BootMark};
use crate::journal::{self, applocker_id, Change, ChangeOutcome, JournalOwner};
use crate::lockdown::appcontrol::CiRestartMark;
use crate::platform::AppLockerMechanism;

/// `BUILTIN\Administrators`.
pub const ADMINISTRATORS: &str = "S-1-5-32-544";
/// Everyone.
pub const EVERYONE: &str = "S-1-1-0";

/// Principals that get an allow-everything rule next to the local accounts (see the module
/// comment). Not user accounts: nobody signs in as one of them.
pub const SYSTEM_PRINCIPALS: &[(&str, &str)] = &[
    ("S-1-5-18", "SYSTEM: the agent runs installers and tools as SYSTEM"),
    ("S-1-5-19", "LOCAL SERVICE: Windows services run from the Windows folder"),
    ("S-1-5-20", "NETWORK SERVICE: Windows services run from the Windows folder"),
    ("S-1-5-6", "SERVICE: every service logon session"),
    ("S-1-5-90-0", "Window Manager Group: the desktop window manager of the Staff session"),
];

/// The service AppLocker needs.
pub const APP_ID_SERVICE: &str = "AppIDSvc";
/// Automatic start.
const START_AUTO: u32 = 2;
/// How deep below the Windows folder the writable-folder scan looks.
pub const SCAN_DEPTH: u32 = 6;

/// `AuditOnly` or `Enabled`, per collection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Enforcement {
    AuditOnly,
    Enabled,
}

impl Enforcement {
    fn word(self) -> &'static str {
        match self {
            Enforcement::AuditOnly => "AuditOnly",
            Enforcement::Enabled => "Enabled",
        }
    }
}

// ---------------------------------------------------------------- the mechanism

/// Which AppLocker path an edition gets (`Edition ID` of `os_info`). **Unverified** until the VM
/// run (plan Section 21): Enterprise, Education and Server enforce the local policy; Pro takes
/// the AppLocker CSP; Home has neither. `None`: the layer reports `unsupported`.
pub fn mechanism_for(edition_id: &str) -> Option<AppLockerMechanism> {
    let edition = edition_id.to_ascii_lowercase();
    if edition.starts_with("core") || edition.starts_with("cloud") {
        return None;
    }
    if edition.starts_with("enterprise") || edition.starts_with("iotenterprise") || edition.starts_with("server") || edition == "education" {
        return Some(AppLockerMechanism::Local);
    }
    if edition.starts_with("professional") {
        return Some(AppLockerMechanism::Csp);
    }
    None
}

// ---------------------------------------------------------------- the XML

/// What a rule matches.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Condition {
    Path { path: String, except_paths: Vec<String>, except_names: Vec<String> },
    Publisher { publisher: String, product: String, binary: String },
    Hash { sha256: String, source: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Rule {
    sid: String,
    name: String,
    description: String,
    condition: Condition,
}

fn esc(text: &str) -> String {
    text.chars().fold(String::with_capacity(text.len()), |mut out, c| {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            other => out.push(other),
        }
        out
    })
}

/// A name-based UUID of `text`: SHA-256 truncated to 128 bits with the version and variant bits
/// set (version 8, custom). The same text always gives the same id.
pub fn rule_id(text: &str) -> String {
    let digest = Sha256::digest(text.as_bytes());
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x80;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &hex[0..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..32])
}

fn render_condition(out: &mut String, condition: &Condition) {
    match condition {
        Condition::Path { path, except_paths, except_names } => {
            let _ = writeln!(out, "      <Conditions>\n        <FilePathCondition Path=\"{}\"/>\n      </Conditions>", esc(path));
            if !except_paths.is_empty() || !except_names.is_empty() {
                out.push_str("      <Exceptions>\n");
                for path in except_paths {
                    let _ = writeln!(out, "        <FilePathCondition Path=\"{}\"/>", esc(path));
                }
                for name in except_names {
                    let _ = writeln!(
                        out,
                        "        <FilePublisherCondition PublisherName=\"*\" ProductName=\"*\" BinaryName=\"{}\">\n          <BinaryVersionRange LowSection=\"*\" HighSection=\"*\"/>\n        </FilePublisherCondition>",
                        esc(name)
                    );
                }
                out.push_str("      </Exceptions>\n");
            }
        }
        Condition::Publisher { publisher, product, binary } => {
            let _ = writeln!(
                out,
                "      <Conditions>\n        <FilePublisherCondition PublisherName=\"{}\" ProductName=\"{}\" BinaryName=\"{}\">\n          <BinaryVersionRange LowSection=\"*\" HighSection=\"*\"/>\n        </FilePublisherCondition>\n      </Conditions>",
                esc(publisher),
                esc(product),
                esc(binary)
            );
        }
        Condition::Hash { sha256, source } => {
            let _ = writeln!(
                out,
                "      <Conditions>\n        <FileHashCondition>\n          <FileHash Type=\"SHA256\" Data=\"0x{}\" SourceFileName=\"{}\" SourceFileLength=\"0\"/>\n        </FileHashCondition>\n      </Conditions>",
                esc(&sha256.to_ascii_uppercase()),
                esc(source)
            );
        }
    }
}

fn render_rule(out: &mut String, collection: &str, rule: &Rule) {
    let element = match rule.condition {
        Condition::Path { .. } => "FilePathRule",
        Condition::Publisher { .. } => "FilePublisherRule",
        Condition::Hash { .. } => "FileHashRule",
    };
    let mut body = String::new();
    render_condition(&mut body, &rule.condition);
    let id = rule_id(&format!("{collection}|{}|{}|{body}", rule.sid, rule.name));
    let _ = writeln!(
        out,
        "    <{element} Id=\"{id}\" Name=\"{}\" Description=\"{}\" UserOrGroupSid=\"{}\" Action=\"Allow\">",
        esc(&rule.name),
        esc(&rule.description),
        esc(&rule.sid)
    );
    out.push_str(&body);
    let _ = writeln!(out, "    </{element}>");
}

fn allow_all(sid: &str, name: &str, description: &str, publisher_style: bool) -> Rule {
    let condition = if publisher_style {
        Condition::Publisher { publisher: "*".into(), product: "*".into(), binary: "*".into() }
    } else {
        Condition::Path { path: "*".into(), except_paths: Vec::new(), except_names: Vec::new() }
    };
    Rule { sid: sid.to_string(), name: name.to_string(), description: description.to_string(), condition }
}

fn folder_glob(folder: &str) -> String {
    format!("{}\\*", clean(folder))
}

/// What the policy is built from.
pub struct CompileInput<'a> {
    pub enforcement: Enforcement,
    pub staff_sid: &'a str,
    /// The enabled local accounts other than Staff, any order.
    pub other_sids: &'a [String],
    pub allow: &'a AllowList,
}

/// The program rules of the EXE, MSI and Script collections. `with_denied_programs` adds the
/// Windows binaries Staff may not start (only programs are in the EXE collection).
fn file_rules(input: &CompileInput<'_>, with_denied_programs: bool) -> Vec<Rule> {
    let allow = input.allow;
    let mut rules = vec![allow_all(ADMINISTRATORS, "Rulebox: Administrators", "Administrators can start anything (the way back, invariant I6)", false)];
    for (sid, why) in SYSTEM_PRINCIPALS {
        rules.push(allow_all(sid, &format!("Rulebox: system principal {sid}"), why, false));
    }
    let mut others: Vec<&String> = input.other_sids.iter().filter(|sid| sid.as_str() != input.staff_sid).collect();
    others.sort();
    others.dedup();
    for sid in others {
        rules.push(allow_all(sid, &format!("Rulebox: local account {sid}"), "Every other enabled local account can start anything; only Staff is restricted", false));
    }
    for folder in &allow.invariant {
        rules.push(Rule {
            sid: EVERYONE.to_string(),
            name: "Rulebox: Rulebox and WebView2 folders".to_string(),
            description: "Everyone can start Rulebox and the WebView2 runtime (invariants I1 and I2)".to_string(),
            condition: Condition::Path { path: folder_glob(folder), except_paths: Vec::new(), except_names: Vec::new() },
        });
    }
    let mut except_paths: Vec<String> = allow.windows_excluded_folders.iter().map(|f| folder_glob(f)).collect();
    let mut except_names = Vec::new();
    if with_denied_programs {
        except_paths.extend(allow.windows_excluded_files.iter().cloned());
        except_names = allow.windows_excluded_names.clone();
    }
    rules.push(Rule {
        sid: input.staff_sid.to_string(),
        name: "Rulebox: Staff, Windows folder".to_string(),
        description: "Staff can start Windows' own programs except the folders users can write to and the listed tools".to_string(),
        condition: Condition::Path { path: folder_glob(&allow.windows), except_paths, except_names },
    });
    for folder in &allow.catalogue {
        rules.push(Rule {
            sid: input.staff_sid.to_string(),
            name: "Rulebox: Staff, catalogue app folder".to_string(),
            description: "Staff can start a catalogue app from its admin-only folder".to_string(),
            condition: Condition::Path { path: folder_glob(folder), except_paths: Vec::new(), except_names: Vec::new() },
        });
    }
    for exception in &allow.exceptions {
        let (name, condition) = match exception {
            AllowException::Publisher { subject, product, file_name } => (
                "Rulebox: Staff, publisher exception",
                Condition::Publisher {
                    publisher: subject.clone(),
                    product: product.clone().unwrap_or_else(|| "*".into()),
                    binary: file_name.clone().unwrap_or_else(|| "*".into()),
                },
            ),
            AllowException::Hash { sha256, source } => {
                ("Rulebox: Staff, hash exception", Condition::Hash { sha256: sha256.clone(), source: source.clone() })
            }
            AllowException::Path(path) => (
                "Rulebox: Staff, path exception",
                Condition::Path { path: path.clone(), except_paths: Vec::new(), except_names: Vec::new() },
            ),
        };
        rules.push(Rule {
            sid: input.staff_sid.to_string(),
            name: name.to_string(),
            description: "An exception of the organization's policy".to_string(),
            condition,
        });
    }
    rules
}

/// The packaged-app rules: everyone else runs anything, Staff only the listed packages.
fn appx_rules(input: &CompileInput<'_>) -> Vec<Rule> {
    let mut rules = vec![allow_all(ADMINISTRATORS, "Rulebox: Administrators", "Administrators can start any packaged app", true)];
    for (sid, why) in SYSTEM_PRINCIPALS {
        rules.push(allow_all(sid, &format!("Rulebox: system principal {sid}"), why, true));
    }
    let mut others: Vec<&String> = input.other_sids.iter().filter(|sid| sid.as_str() != input.staff_sid).collect();
    others.sort();
    others.dedup();
    for sid in others {
        rules.push(allow_all(sid, &format!("Rulebox: local account {sid}"), "Every other enabled local account can start any packaged app", true));
    }
    for package in STAFF_ALLOWED_PACKAGES {
        rules.push(Rule {
            sid: input.staff_sid.to_string(),
            name: format!("Rulebox: Staff, package {package}"),
            description: "A package the Windows session needs".to_string(),
            condition: Condition::Publisher {
                publisher: MICROSOFT_WINDOWS_PUBLISHER.to_string(),
                product: (*package).to_string(),
                binary: "*".to_string(),
            },
        });
    }
    rules
}

/// The policy XML. Deterministic: the same input gives the same bytes (LF line ends).
pub fn compile(input: &CompileInput<'_>) -> String {
    let mut xml = String::from("<AppLockerPolicy Version=\"1\">\n");
    let sets: [(&str, Vec<Rule>); 4] = [
        ("Exe", file_rules(input, true)),
        ("Msi", file_rules(input, false)),
        ("Script", file_rules(input, false)),
        ("Appx", appx_rules(input)),
    ];
    for (collection, rules) in sets {
        let _ = writeln!(xml, "  <RuleCollection Type=\"{collection}\" EnforcementMode=\"{}\">", input.enforcement.word());
        for rule in &rules {
            render_rule(&mut xml, collection, rule);
        }
        xml.push_str("  </RuleCollection>\n");
    }
    xml.push_str("</AppLockerPolicy>\n");
    xml
}

// ---------------------------------------------------------------- the check of the output

/// One rule element read back from generated XML.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedRule {
    pub collection: String,
    pub sid: String,
    pub action: String,
    /// The `Path` of every path condition among the rule's conditions (not its exceptions).
    pub paths: Vec<String>,
    /// The `Path` of every path condition among its exceptions.
    pub exception_paths: Vec<String>,
    /// The `BinaryName` of every publisher condition among its exceptions.
    pub exception_names: Vec<String>,
    /// True when the conditions are a publisher condition with `*` for everything.
    pub any_publisher: bool,
}

fn attr<'a>(tag: &'a str, name: &str) -> Option<&'a str> {
    let key = format!(" {name}=\"");
    let start = tag.find(&key)? + key.len();
    let end = tag[start..].find('"')? + start;
    Some(&tag[start..end])
}

fn unesc(text: &str) -> String {
    text.replace("&quot;", "\"").replace("&apos;", "'").replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&")
}

fn all_attrs(text: &str, element: &str, name: &str) -> Vec<String> {
    let mut out = Vec::new();
    let open = format!("<{element} ");
    let mut at = 0;
    while let Some(found) = text[at..].find(&open) {
        let start = at + found;
        let end = text[start..].find('>').map_or(text.len(), |e| start + e);
        if let Some(value) = attr(&text[start..end], name) {
            out.push(unesc(value));
        }
        at = end;
    }
    out
}

/// Reads the rules of a generated policy back (the check below and the golden tests run on this
/// output, not on the intentions behind it).
pub fn parse_rules(xml: &str) -> Vec<ParsedRule> {
    let mut rules = Vec::new();
    let mut at = 0;
    while let Some(found) = xml[at..].find("<RuleCollection Type=\"") {
        let start = at + found;
        let end = xml[start..].find("</RuleCollection>").map_or(xml.len(), |e| start + e);
        let block = &xml[start..end];
        let collection = attr(&block[..block.find('>').unwrap_or(block.len())], "Type").unwrap_or("").to_string();
        let mut cursor = 0;
        while let Some(found) = block[cursor..].find("    <File") {
            let rule_start = cursor + found + 4;
            let tag_end = block[rule_start..].find('>').map_or(block.len(), |e| rule_start + e);
            let tag = &block[rule_start..tag_end];
            let element: String = tag[1..].chars().take_while(|c| c.is_ascii_alphanumeric()).collect();
            let close = block[rule_start..].find(&format!("</{element}>")).map_or(block.len(), |e| rule_start + e);
            let body = &block[tag_end..close];
            let (conditions, exceptions) = match body.find("<Exceptions>") {
                Some(split) => (&body[..split], &body[split..]),
                None => (body, ""),
            };
            rules.push(ParsedRule {
                collection: collection.clone(),
                sid: attr(tag, "UserOrGroupSid").unwrap_or("").to_string(),
                action: attr(tag, "Action").unwrap_or("").to_string(),
                paths: all_attrs(conditions, "FilePathCondition", "Path"),
                exception_paths: all_attrs(exceptions, "FilePathCondition", "Path"),
                exception_names: all_attrs(exceptions, "FilePublisherCondition", "BinaryName"),
                any_publisher: all_attrs(conditions, "FilePublisherCondition", "PublisherName") == ["*"]
                    && all_attrs(conditions, "FilePublisherCondition", "ProductName") == ["*"]
                    && all_attrs(conditions, "FilePublisherCondition", "BinaryName") == ["*"],
            });
            cursor = close;
        }
        at = end;
    }
    rules
}

/// The collections of a written policy.
pub const COLLECTIONS: [&str; 4] = ["Exe", "Msi", "Script", "Appx"];

/// Checks generated XML against the invariants and the rules of plan 4.9; a fixed code names the
/// first failure. Nothing is written when this fails.
///
/// * `would_block_admin` (I6): a collection has no allow-everything rule for Administrators.
/// * `would_block_rulebox` (I1, I2): a protected folder has no Everyone allow rule in the program
///   collections, or an exception of the Staff rule cuts into it.
/// * `writable_path_rule` (edge case 13): an allow path rule for Staff or Everyone starts from a
///   folder standard users can write to.
/// * `restrictive_rule_not_staff`: a deny rule, or a rule other than the Staff one that is not an
///   allow rule.
pub fn check_compiled(xml: &str, protected: &[String], staff_sid: &str, roots: &PathRoots) -> Result<(), &'static str> {
    let rules = parse_rules(xml);
    for collection in COLLECTIONS {
        let admin = rules.iter().any(|r| {
            r.collection == collection
                && r.sid == ADMINISTRATORS
                && r.action == "Allow"
                && (r.paths.iter().any(|p| p == "*") || r.any_publisher)
        });
        if !admin {
            return Err("would_block_admin");
        }
    }
    for rule in &rules {
        if rule.action != "Allow" && rule.sid != staff_sid {
            return Err("restrictive_rule_not_staff");
        }
    }
    for collection in ["Exe", "Msi", "Script"] {
        for folder in protected {
            let glob = folder_glob(folder).to_ascii_lowercase();
            let allowed = rules.iter().any(|r| {
                r.collection == collection && r.sid == EVERYONE && r.action == "Allow" && r.paths.iter().any(|p| p.to_ascii_lowercase() == glob)
            });
            let cut = rules.iter().filter(|r| r.collection == collection && r.sid == staff_sid).any(|r| {
                r.exception_paths.iter().any(|p| {
                    let p = p.trim_end_matches('*');
                    inside(p, folder) || inside(folder, p)
                })
            });
            if !allowed || cut {
                return Err("would_block_rulebox");
            }
        }
    }
    for rule in rules.iter().filter(|r| (r.sid == staff_sid || r.sid == EVERYONE) && r.action == "Allow") {
        for path in &rule.paths {
            let trimmed = path.strip_suffix("\\*").unwrap_or(path);
            // A rule for one program is judged by the folder it sits in.
            let folder = if trimmed.to_ascii_lowercase().ends_with(".exe") {
                trimmed.rsplit_once('\\').map_or(trimmed, |(head, _)| head)
            } else {
                trimmed
            };
            if allowlist::is_user_writable_location(folder, roots) {
                return Err("writable_path_rule");
            }
        }
    }
    Ok(())
}

// ---------------------------------------------------------------- the invariants' view

pub(super) fn staff_sid(ctx: &ApplyCtx<'_>) -> Option<String> {
    ctx.journal.shared.read(|state| state.staff.as_ref().map(|staff| staff.sid.clone()))
}

/// The folders the invariants protect: what the facts say, else the Rulebox install folder
/// (the parent of the managed apps folder) and the default WebView2 runtime folder.
pub(super) fn protected_folders(ctx: &ApplyCtx<'_>, roots: &PathRoots) -> Vec<String> {
    if !ctx.facts.protected_paths.is_empty() {
        return ctx.facts.protected_paths.clone();
    }
    let apps = clean(&roots.rulebox_apps);
    let install = apps.rsplit_once('\\').map_or(apps.clone(), |(head, _)| head.to_string());
    let webview_root = roots.program_files_x86.clone().unwrap_or_else(|| roots.program_files.clone());
    vec![install, format!(r"{}\Microsoft\EdgeWebView", clean(&webview_root))]
}

fn enforcement_of(mode: LayerMode) -> Option<Enforcement> {
    match mode {
        LayerMode::Audit => Some(Enforcement::AuditOnly),
        LayerMode::Enforce => Some(Enforcement::Enabled),
        LayerMode::Off | LayerMode::Unknown => None,
    }
}

/// Puts what this layer will write into the facts the invariants check (plan 4.6: they look at
/// generated output): the folders and files its Windows rule cuts out, and whether Administrators
/// lost their allow-everything rule. The writable-folder scan is left to the apply itself (it
/// reads thousands of folders); the cut-outs it finds are under the Windows folder and are
/// checked again there against the same protected folders.
pub fn fill_generated(ctx: &ApplyCtx<'_>, doc: &AgentDoc, generated: &mut Generated) {
    let Some(lockdown) = &doc.lockdown else {
        return;
    };
    let Some(enforcement) = enforcement_of(lockdown.app_locker.mode) else {
        return;
    };
    let (Some(staff), Ok(roots)) = (staff_sid(ctx), ctx.journal.platform.path_roots()) else {
        return;
    };
    let protected = protected_folders(ctx, &roots);
    let inputs = Inputs {
        roots: &roots,
        protected: &protected,
        catalogue_folders: &[],
        exceptions: &lockdown.exceptions,
        accessibility_tools: lockdown.accessibility_tools,
        windows_scan: &[],
        staff_sid: &staff,
    };
    let Ok(allow) = allowlist::build(&inputs, |_| Ok(None)) else {
        return;
    };
    let xml = compile(&CompileInput { enforcement, staff_sid: &staff, other_sids: &[], allow: &allow });
    generated.blocked_paths.extend(allow.blocked_paths());
    if check_compiled(&xml, &protected, &staff, &roots) == Err("would_block_admin") {
        generated.blocks_administrators = true;
    }
}

// ---------------------------------------------------------------- the layer

fn state(mode: ReportedMode, state: LayerStatus, detail: Option<&str>) -> LayerState {
    LayerState { mode, state, detail: detail.map(str::to_string) }
}

fn reported_mode(mode: LayerMode) -> ReportedMode {
    match mode {
        LayerMode::Audit => ReportedMode::Audit,
        LayerMode::Enforce => ReportedMode::Enforce,
        LayerMode::Off | LayerMode::Unknown => ReportedMode::Off,
    }
}

/// True while an earlier change of the service waits for a restart; clears the mark once the PC
/// booted.
fn restart_still_pending(ctx: &ApplyCtx<'_>) -> bool {
    let Some(mark) = ctx.journal.shared.read(|state| state.applocker_restart) else {
        return false;
    };
    match ctx.journal.platform.boot_identity() {
        Ok(now) if rebooted_since(mark.boot.as_ref(), mark.since_ms, &now) => {
            let _ = ctx.journal.shared.update(|state| state.applocker_restart = None);
            false
        }
        _ => true,
    }
}

fn has_entry(ctx: &ApplyCtx<'_>, id: &str) -> bool {
    ctx.journal.shared.read(|state| state.journal.iter().any(|entry| entry.id == id))
}

/// Removes everything this layer installed (owner `L3`): the policy, the service setting.
fn remove(ctx: &ApplyCtx<'_>) -> LayerState {
    let report = journal::restore_owner(&ctx.journal, JournalOwner::L3);
    let _ = ctx.journal.shared.update(|state| state.applocker_restart = None);
    match report.failed.first() {
        None => state(ReportedMode::Off, LayerStatus::Ok, None),
        Some((_, error)) => state(ReportedMode::Off, LayerStatus::Failed, Some(journal::error_code(error))),
    }
}

/// Applies or removes the layer. Idempotent: a second run with the same document, accounts and
/// folders writes nothing.
pub fn apply(ctx: &ApplyCtx<'_>, doc: &AgentDoc) -> LayerState {
    let platform = ctx.journal.platform;
    let mode = doc.lockdown.as_ref().map_or(LayerMode::Off, |p| p.app_locker.mode);
    let shown = reported_mode(mode);
    let Some(lockdown) = doc.lockdown.as_ref() else {
        return remove(ctx);
    };
    let enforcement = match mode {
        LayerMode::Off => return remove(ctx),
        LayerMode::Unknown => return state(ReportedMode::Off, LayerStatus::Ok, Some("section_unknown_value")),
        _ => enforcement_of(mode).unwrap_or(Enforcement::AuditOnly),
    };

    let edition = match platform.os_info() {
        Ok(os) => os.edition_id,
        Err(_) => return state(shown, LayerStatus::Failed, Some("os_info_unreadable")),
    };
    let Some(mechanism) = mechanism_for(&edition) else {
        return state(shown, LayerStatus::Unsupported, Some("applocker_not_on_this_edition"));
    };
    let Some(staff) = staff_sid(ctx) else {
        return state(shown, LayerStatus::Failed, Some("no_staff_account"));
    };

    // A policy the agent did not install is never edited or merged.
    let ours = has_entry(ctx, &applocker_id(AppLockerMechanism::Local)) || has_entry(ctx, &applocker_id(AppLockerMechanism::Csp));
    match platform.get_applocker_policy() {
        Ok(store) if store.has_rules() && !ours => return state(shown, LayerStatus::Failed, Some("applocker_foreign_policy")),
        Ok(_) => {}
        Err(_) => return state(shown, LayerStatus::Failed, Some("applocker_unreadable")),
    }

    let Ok(roots) = platform.path_roots() else {
        return state(shown, LayerStatus::Failed, Some("path_roots_unreadable"));
    };
    let Ok(accounts) = platform.enabled_local_account_sids() else {
        return state(shown, LayerStatus::Failed, Some("accounts_unreadable"));
    };
    let other_sids: Vec<String> = accounts.into_iter().filter(|sid| sid != &staff).collect();

    let mut tally = Tally::default();
    let windows = clean(roots.system_root.as_deref().unwrap_or(""));
    let scan = if windows.is_empty() { Ok(Vec::new()) } else { platform.folder_acls(Path::new(&windows), SCAN_DEPTH) };
    let scan = match scan {
        Ok(scan) => scan,
        Err(_) => {
            tally.record(Err("windows_scan_failed"));
            Vec::new()
        }
    };
    let protected = protected_folders(ctx, &roots);
    let inputs = Inputs {
        roots: &roots,
        protected: &protected,
        catalogue_folders: &ctx.facts.catalogue_exe_folders,
        exceptions: &lockdown.exceptions,
        accessibility_tools: lockdown.accessibility_tools,
        windows_scan: &scan,
        staff_sid: &staff,
    };
    let acl_of = |folder: &str| platform.get_path_acl(Path::new(folder)).map_err(|_| ());
    let allow = match allowlist::build(&inputs, acl_of) {
        Ok(allow) => allow,
        Err(code) => return state(shown, LayerStatus::Failed, Some(code)),
    };
    let xml = compile(&CompileInput { enforcement, staff_sid: &staff, other_sids: &other_sids, allow: &allow });
    if let Err(code) = check_compiled(&xml, &protected, &staff, &roots) {
        return state(shown, LayerStatus::Failed, Some(code));
    }
    for note in &allow.notes {
        tally.record(Err(*note));
    }

    // The other mechanism's policy (the edition's choice changed) goes first.
    let other = match mechanism {
        AppLockerMechanism::Local => AppLockerMechanism::Csp,
        AppLockerMechanism::Csp => AppLockerMechanism::Local,
    };
    let stale = applocker_id(other);
    if has_entry(ctx, &stale) {
        let report = journal::restore_ids(&ctx.journal, std::slice::from_ref(&stale));
        for (_, error) in &report.failed {
            tally.record(Err(journal::error_code(error)));
        }
    }

    let policy = Change::app_locker(JournalOwner::L3, &xml, mechanism).since(ctx.version);
    tally.record(journal::change(&ctx.journal, &policy).map(|_| ()).map_err(|error| journal::error_code(&error)));

    // AppLocker needs the Application Identity service; it is set to automatic, and the PC has
    // to restart before it runs (the agent has no way to start it yet).
    let mut service_changed = false;
    match platform.query_service(APP_ID_SERVICE) {
        Ok(Some(_)) => {
            let change = Change::service_start(JournalOwner::L3, APP_ID_SERVICE, START_AUTO).since(ctx.version);
            match journal::change(&ctx.journal, &change) {
                Ok(outcome) => {
                    service_changed = outcome == ChangeOutcome::Written;
                    tally.record(Ok(()));
                }
                Err(error) => tally.record(Err(journal::error_code(&error))),
            }
        }
        Ok(None) => tally.record(Err("app_id_service_missing")),
        Err(_) => tally.record(Err("app_id_service_unreadable")),
    }
    if service_changed {
        let mark = CiRestartMark {
            since_ms: ctx.now_ms,
            boot: platform.boot_identity().ok().map(|boot| BootMark { boot_id: boot.boot_id, uptime_ms: boot.uptime_ms }),
        };
        if ctx.journal.shared.update(|state| state.applocker_restart = Some(mark)).is_err() {
            tally.record(Err("state_not_saved"));
        }
    }
    let waiting = service_changed || restart_still_pending(ctx);
    let status = match tally.status() {
        LayerStatus::Ok if waiting => LayerStatus::RestartPending,
        other => other,
    };
    let detail = tally.detail().or_else(|| waiting.then(|| "restart_needed".to_string()));
    LayerState { mode: shown, state: status, detail }
}

#[cfg(test)]
mod tests;
