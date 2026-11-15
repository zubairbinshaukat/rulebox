//! `rulebox-agent lockdown-status` (Phase 5 Step 20, plan Section 8): what an administrator at
//! the PC sees about the lockdown, without the dashboard and without the service's help.
//!
//! **Read-only.** It reads the agent's state files (never renames or repairs one, never creates
//! the state folder) and asks the machine through the read-only half of the `Platform` seam. It
//! does not talk to the service or to the backend, so it also works offline and while the
//! service is stopped. It prints:
//!
//! * the document (version, verified or not, lockdown section, configuration and ring);
//! * **expected against reported** per layer: the mode the document asks for and what the
//!   service's last pass reported (`lockdown-last.json`);
//! * **live checks**: what the journal says Rulebox put on the PC against what is there now
//!   (tamper items, App Control policy files, Wi-Fi profiles, printers, service start types,
//!   the Safe Mode registration);
//! * the **invariant self-check** (plan 4.6) of the cached document, as the service would run it;
//! * a **journal summary** (entries per owner, entries that are not settled, unknown targets);
//! * the **posture** (Secure Boot, BitLocker, TPM, auto-recovery).
//!
//! Nothing here prints a path of a blocked program, a passphrase or a PIN hash: fixed codes,
//! counts and names of Rulebox's own items only.

use std::collections::BTreeMap;
use std::io::Write;
use std::sync::Arc;

use rulebox_policy::envelope::verify_envelope;
use rulebox_policy::lockdown::ConfigRef;
use rulebox_policy::AgentDoc;
use serde::Serialize;

use super::apply::{self, ApplyCtx};
use super::runtime::{expected_modes, machine_facts, read_json_quiet, LastPass};
use super::tamper::{self, Item, RuleboxFolders};
use super::{boot, LayerState, LayerStates, LayerStatus, ReportedMode};
use crate::agent::CachedDesired;
use crate::journal::{self, EntryPhase, JournalCtx, JournalEntry, JournalOwner, JournalTarget};
use crate::paths::{DataPaths, InstallPaths};
use crate::platform::Platform;
use crate::state::{AgentState, KioskApplied, SharedState, StateStore};

/// One layer: what the document asks for and what the service last reported.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LayerLine {
    pub layer: &'static str,
    pub expected: ReportedMode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reported: Option<LayerState>,
    pub ok: bool,
}

/// One thing looked at on the machine now. `ok` is `None` when it could not be read.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LiveCheck {
    pub name: String,
    pub ok: Option<bool>,
}

#[derive(Serialize, Debug, Clone, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct JournalSummary {
    pub entries: usize,
    pub by_owner: BTreeMap<String, usize>,
    pub pending: usize,
    pub restoring: usize,
    pub with_error: usize,
    pub unknown_targets: usize,
}

#[derive(Serialize, Debug, Clone, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DocumentLine {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<u64>,
    pub verified: bool,
    pub has_lockdown: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config: Option<ConfigRef>,
}

#[derive(Serialize, Debug, Clone, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LkgLine {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lkg_version: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub candidate_version: Option<u64>,
    pub refused_configs: usize,
}

/// Everything `lockdown-status` shows.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LockdownStatus {
    pub enrolled: bool,
    pub kiosk_enabled: bool,
    pub document: DocumentLine,
    pub layers: Vec<LayerLine>,
    pub live: Vec<LiveCheck>,
    /// `ok`, the refusal code, or `not_checked` (no verified document).
    pub invariants: String,
    pub journal: JournalSummary,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub posture: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_pass: Option<LastPass>,
    pub lkg: LkgLine,
    /// Plain sentences about what is not as expected. Empty = all green.
    pub problems: Vec<String>,
}

impl LockdownStatus {
    pub fn all_green(&self) -> bool {
        self.problems.is_empty()
    }
}

fn owner_word(owner: JournalOwner) -> &'static str {
    match owner {
        JournalOwner::Kiosk => "kiosk",
        JournalOwner::L1 => "L1 staff",
        JournalOwner::L2 => "L2 machine",
        JournalOwner::L3 => "L3 appLocker",
        JournalOwner::L4 => "L4 appControl",
        JournalOwner::L7 => "L7 boot",
        JournalOwner::Wifi => "wifi",
        JournalOwner::Printer => "printers",
        JournalOwner::Perf => "performance",
        JournalOwner::Driver => "drivers",
    }
}

pub fn journal_summary(state: &AgentState) -> JournalSummary {
    let mut summary = JournalSummary { entries: state.journal.len(), ..JournalSummary::default() };
    for entry in &state.journal {
        *summary.by_owner.entry(owner_word(entry.owner).to_string()).or_default() += 1;
        match entry.phase {
            EntryPhase::Pending => summary.pending += 1,
            EntryPhase::Restoring => summary.restoring += 1,
            EntryPhase::Applied => {}
        }
        if entry.last_error.is_some() {
            summary.with_error += 1;
        }
        if matches!(entry.target, JournalTarget::Unknown(_)) {
            summary.unknown_targets += 1;
        }
    }
    summary
}

fn layer_of<'a>(layers: &'a LayerStates, name: &str) -> &'a LayerState {
    match name {
        "staff" => &layers.staff,
        "machine" => &layers.machine,
        "appLocker" => &layers.app_locker,
        "appControl" => &layers.app_control,
        "procWatch" => &layers.proc_watch,
        "boot" => &layers.boot,
        _ => &layers.performance,
    }
}

/// A state that needs nobody's attention.
fn state_is_fine(state: LayerStatus) -> bool {
    matches!(state, LayerStatus::Ok | LayerStatus::AuditFirst | LayerStatus::RestartPending | LayerStatus::Unsupported)
}

/// What the journal says is on the PC against what is there now. Read-only.
fn live_checks(platform: &dyn Platform, state: &AgentState, folders: &RuleboxFolders) -> Vec<LiveCheck> {
    let mut checks = Vec::new();
    let has = |id: &str| state.journal.iter().any(|entry: &JournalEntry| entry.id == id);
    for item in Item::ALL {
        if has(&item.id()) {
            checks.push(LiveCheck { name: format!("tamper: {}", item.code()), ok: tamper::holds(platform, Some(folders), item) });
        }
    }
    let ci = platform.list_ci_policies().ok();
    let wlan = platform.wlan_list().ok();
    let printers = platform.printer_list().ok();
    for entry in &state.journal {
        match &entry.target {
            JournalTarget::CiPolicy { policy_id } => checks.push(LiveCheck {
                name: format!("app control policy {policy_id}"),
                ok: ci.as_ref().map(|list| list.iter().any(|id| id.eq_ignore_ascii_case(policy_id))),
            }),
            JournalTarget::WlanProfile { name } => checks.push(LiveCheck {
                name: format!("wifi profile {name}"),
                ok: wlan.as_ref().map(|list| list.profiles.iter().any(|profile| profile == name)),
            }),
            JournalTarget::Printer { name } if !name.starts_with("\\\\") => {
                let comment = journal::printer_comment(name);
                checks.push(LiveCheck {
                    name: format!("printer {name}"),
                    ok: printers.as_ref().map(|list| list.iter().any(|queue| queue.comment == comment)),
                });
            }
            JournalTarget::ServiceStart { name } if entry.owner == JournalOwner::Perf => checks.push(LiveCheck {
                name: format!("service {name} disabled"),
                ok: platform.query_service(name).ok().map(|service| service.is_none_or(|config| config.start == 4)),
            }),
            _ => {}
        }
    }
    checks
}

/// What the status needs from the caller.
pub struct StatusEnv<'a> {
    pub platform: Arc<dyn Platform>,
    pub paths: &'a DataPaths,
    pub install: &'a InstallPaths,
    pub admin_signin_verified: bool,
    pub now_ms: u64,
}

/// Builds the status from an agent state that was already read. Read-only: the only store it
/// makes is never saved.
pub fn gather(env: &StatusEnv<'_>, state: &AgentState) -> LockdownStatus {
    let platform = env.platform.as_ref();
    let mut problems: Vec<String> = Vec::new();
    let kiosk_enabled = state.kiosk.applied == KioskApplied::Enabled;

    // The document: the cached envelope, verified with the keys the PC trusts now.
    let cached: Option<CachedDesired> = read_json_quiet(&env.paths.desired_state());
    let verified = match (&state.enrollment, cached.as_ref().and_then(CachedDesired::envelope)) {
        (Some(enrollment), Some(envelope)) => {
            verify_envelope(&envelope, &state.trusted_keys, &enrollment.org_id, &enrollment.device_id).ok()
        }
        _ => None,
    };
    let doc = verified.as_ref().and_then(|payload| AgentDoc::from_doc(&payload.doc).ok());
    let document = DocumentLine {
        version: cached.as_ref().map(|cached| cached.version),
        verified: verified.is_some(),
        has_lockdown: doc.as_ref().is_some_and(|doc| doc.lockdown.is_some()),
        config: doc.as_ref().and_then(|doc| doc.config.clone()),
    };
    if cached.is_some() && verified.is_none() {
        problems.push("The cached document does not verify with the keys this PC trusts.".to_string());
    }

    // Expected against reported, per layer. With the kiosk off every layer is expected off.
    let last_pass = LastPass::read(env.paths);
    let empty = AgentDoc::default();
    let expected_doc = if kiosk_enabled { doc.as_ref().unwrap_or(&empty) } else { &empty };
    let mut layers = Vec::new();
    for (name, expected) in expected_modes(expected_doc) {
        let reported = last_pass.as_ref().map(|last| layer_of(&last.layers, name).clone());
        let ok = match &reported {
            // The performance layer is `on` only when one of its two switches is.
            Some(layer) => (name == "performance" || layer.mode == expected) && state_is_fine(layer.state),
            None => expected == ReportedMode::Off,
        };
        if !ok {
            problems.push(match &reported {
                Some(layer) => format!(
                    "Layer {name}: expected {expected:?}, the service reported {:?} / {:?}{}.",
                    layer.mode,
                    layer.state,
                    layer.detail.as_deref().map(|detail| format!(" ({detail})")).unwrap_or_default()
                ),
                None => format!("Layer {name}: expected {expected:?}, but the service has not reported a pass yet."),
            });
        }
        layers.push(LayerLine { layer: name, expected, reported, ok });
    }
    if let (Some(last), Some(version)) = (&last_pass, document.version) {
        if kiosk_enabled && last.version != version {
            problems.push(format!("The last pass was for document version {}, the cached document is {version}.", last.version));
        }
        if let Some(code) = &last.refusal {
            problems.push(format!("The document was refused: {code}."));
        }
    }

    // What is on the PC now.
    let folders = RuleboxFolders { install_root: env.install.root().to_path_buf(), state_dir: env.paths.state_dir() };
    let live = live_checks(platform, state, &folders);
    for check in live.iter().filter(|check| check.ok == Some(false)) {
        problems.push(format!("Not as the journal says: {}.", check.name));
    }

    // The invariant self-check of the cached document, as the service runs it before an apply.
    let invariants = match (&verified, &doc) {
        (Some(payload), Some(doc)) => {
            let shared = SharedState::new(StateStore::at(&env.paths.state_dir()), state.clone(), Arc::clone(&env.platform));
            let facts = machine_facts(platform, env.install, env.paths, env.admin_signin_verified, &payload.doc);
            let ctx = ApplyCtx {
                journal: JournalCtx { platform, shared: shared.as_ref() },
                facts,
                now_ms: env.now_ms,
                version: payload.version,
            };
            match apply::check(&ctx, doc) {
                Ok(()) => "ok".to_string(),
                Err(refusal) => {
                    problems.push(format!("The invariant self-check refuses the cached document: {}.", refusal.code()));
                    refusal.code().to_string()
                }
            }
        }
        _ => "not_checked".to_string(),
    };

    let journal = journal_summary(state);
    if journal.unknown_targets > 0 {
        problems.push(format!(
            "{} journal entr{} this build cannot restore (written by a newer agent): nothing new is applied.",
            journal.unknown_targets,
            if journal.unknown_targets == 1 { "y is of a kind" } else { "ies are of a kind" }
        ));
    }
    if journal.restoring > 0 || journal.with_error > 0 {
        problems.push(format!(
            "{} journal entr{} not restored yet; the service tries again.",
            journal.restoring.max(journal.with_error),
            if journal.restoring.max(journal.with_error) == 1 { "y was" } else { "ies were" }
        ));
    }

    let posture = boot::read_report(platform).ok().and_then(|report| serde_json::to_value(report).ok());
    let lkg_file: Option<serde_json::Value> = read_json_quiet(&env.paths.lkg());
    let lkg = LkgLine {
        lkg_version: lkg_file.as_ref().and_then(|file| file["lkg"]["version"].as_u64()),
        candidate_version: lkg_file.as_ref().and_then(|file| file["candidate"]["version"].as_u64()),
        refused_configs: lkg_file.as_ref().and_then(|file| file["refused"].as_array().map(Vec::len)).unwrap_or(0),
    };

    LockdownStatus {
        enrolled: state.enrollment.is_some(),
        kiosk_enabled,
        document,
        layers,
        live,
        invariants,
        journal,
        posture,
        last_pass,
        lkg,
        problems,
    }
}

fn word<T: Serialize>(value: &T) -> String {
    match serde_json::to_value(value) {
        Ok(serde_json::Value::String(text)) => text,
        _ => "?".to_string(),
    }
}

/// The text form. One fact per line, plain words.
pub fn print(status: &LockdownStatus, out: &mut dyn Write) -> std::io::Result<()> {
    writeln!(out, "Rulebox lockdown status")?;
    writeln!(out, "enrolled      : {}", if status.enrolled { "yes" } else { "no" })?;
    writeln!(out, "kiosk         : {}", if status.kiosk_enabled { "on" } else { "off" })?;
    let document = &status.document;
    match document.version {
        Some(version) => writeln!(
            out,
            "document      : version {version}, {}, {}",
            if document.verified { "verified" } else { "NOT verified" },
            if document.has_lockdown { "has a lockdown section" } else { "no lockdown section" }
        )?,
        None => writeln!(out, "document      : none cached")?,
    }
    if let Some(config) = &document.config {
        writeln!(out, "configuration : group {} version {} ring {}", config.group_id, config.version, word(&config.ring))?;
    }
    writeln!(out, "Layers (expected / reported):")?;
    for line in &status.layers {
        let reported = match &line.reported {
            Some(layer) => format!(
                "{} {}{}",
                word(&layer.mode),
                word(&layer.state),
                layer.detail.as_deref().map(|detail| format!(" ({detail})")).unwrap_or_default()
            ),
            None => "not reported yet".to_string(),
        };
        writeln!(out, "  [{}] {:<12} {:<8} / {reported}", if line.ok { "ok" } else { "!!" }, line.layer, word(&line.expected))?;
    }
    if !status.live.is_empty() {
        writeln!(out, "On this PC now:")?;
        for check in &status.live {
            let mark = match check.ok {
                Some(true) => "ok",
                Some(false) => "!!",
                None => "??",
            };
            writeln!(out, "  [{mark}] {}", check.name)?;
        }
    }
    writeln!(out, "invariants    : {}", status.invariants)?;
    let journal = &status.journal;
    writeln!(
        out,
        "journal       : {} entries ({} pending, {} restoring, {} with an error, {} unknown)",
        journal.entries, journal.pending, journal.restoring, journal.with_error, journal.unknown_targets
    )?;
    for (owner, count) in &journal.by_owner {
        writeln!(out, "  {owner:<16} {count}")?;
    }
    if let Some(posture) = status.posture.as_ref().and_then(serde_json::Value::as_object) {
        let field = |key: &str| posture.get(key).map(|value| value.to_string().trim_matches('"').to_string()).unwrap_or_else(|| "?".into());
        writeln!(
            out,
            "posture       : secure boot {}, BitLocker {}, TPM {}, auto-recovery {}, Safe Mode agent {}",
            field("secureBoot"),
            field("bitLocker"),
            field("tpm"),
            field("autoRecovery"),
            field("safeModeAgent")
        )?;
    }
    let lkg = &status.lkg;
    writeln!(
        out,
        "last known good: version {}, on probation {}, refused configurations {}",
        lkg.lkg_version.map_or_else(|| "none".to_string(), |v| v.to_string()),
        lkg.candidate_version.map_or_else(|| "none".to_string(), |v| v.to_string()),
        lkg.refused_configs
    )?;
    if status.all_green() {
        writeln!(out, "Result: all green.")?;
    } else {
        writeln!(out, "Result: {} thing(s) to look at:", status.problems.len())?;
        for problem in &status.problems {
            writeln!(out, "  - {problem}")?;
        }
    }
    Ok(())
}

/// Reads `agent-state.json` as it is (a schema 1 file is migrated in memory only). Never
/// renames or rewrites it.
pub fn read_state(paths: &DataPaths) -> Result<AgentState, String> {
    match std::fs::read(paths.agent_state()) {
        Ok(bytes) => crate::state::parse_state(&bytes).map(|(state, _)| state).map_err(|error| format!("the agent state does not parse: {error}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(AgentState::default()),
        Err(error) => Err(format!("cannot read the agent state ({error}); run this from an elevated prompt")),
    }
}

/// `rulebox-agent lockdown-status [--json]`. Exit code 0 when everything is as expected, 1 when
/// something needs a look or the state could not be read. Changes nothing.
pub fn run(json: bool, out: &mut dyn Write, err: &mut dyn Write) -> u8 {
    let (install, paths) = match (InstallPaths::from_known_folders(), DataPaths::from_known_folders()) {
        (Ok(install), Ok(paths)) => (install, paths),
        (Err(error), _) | (_, Err(error)) => {
            let _ = writeln!(err, "error: {error:#}");
            return crate::ipc_admin::EXIT_ERROR;
        }
    };
    match rulebox_win32::security::process_is_elevated() {
        Ok(true) => {}
        Ok(false) => {
            let _ = writeln!(err, "error: run `lockdown-status` from an elevated (Run as administrator) prompt.");
            return crate::ipc_admin::EXIT_ERROR;
        }
        Err(error) => {
            let _ = writeln!(err, "error: cannot tell whether this prompt is elevated: {error}");
            return crate::ipc_admin::EXIT_ERROR;
        }
    }
    let state = match read_state(&paths) {
        Ok(state) => state,
        Err(reason) => {
            let _ = writeln!(err, "error: {reason}");
            return crate::ipc_admin::EXIT_ERROR;
        }
    };
    // `agent-config.json` holds the E-71 flag; a file that does not parse counts as "not set".
    let admin_signin_verified = read_json_quiet::<serde_json::Value>(&paths.agent_config())
        .and_then(|config| config["adminSigninVerified"].as_bool())
        .unwrap_or(false);
    let platform: Arc<dyn Platform> = Arc::new(crate::platform::windows::WindowsPlatform::new(install.clone(), paths.clone()));
    let env = StatusEnv { platform, paths: &paths, install: &install, admin_signin_verified, now_ms: crate::state::unix_ms() };
    let status = gather(&env, &state);
    let written = if json {
        serde_json::to_string_pretty(&status).map_err(std::io::Error::other).and_then(|text| writeln!(out, "{text}"))
    } else {
        print(&status, out)
    };
    if written.is_err() {
        return crate::ipc_admin::EXIT_ERROR;
    }
    if status.all_green() {
        0
    } else {
        crate::ipc_admin::EXIT_ERROR
    }
}

#[cfg(test)]
mod tests;
