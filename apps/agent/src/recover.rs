//! `rulebox-agent recover` (plan Section 7, Step 11): the offline way back. It puts
//! normal Windows back even when the service is stopped, broken or missing, and
//! it does not depend on anything the Staff session can touch.
//!
//! The decision is a pure function ([`plan`]) of what was found ([`Facts`]); the
//! executor ([`execute`]) turns the plan into `Platform` calls, one step at a time,
//! so a step that fails never stops the steps after it (the same rule as the
//! kiosk's Disable). Everything goes through the `Platform` seam, so the tests run
//! against `SimPlatform` and never touch the machine they run on.
//!
//! What `recover` deliberately does **not** do:
//!
//! - It never creates or repairs the data directory (that is `service run`'s job,
//!   Section 5.1). If the directory is a link, or not owned by SYSTEM or
//!   Administrators with the protected permissions, nothing is read from it and
//!   nothing is written into it.
//! - It never reads `secrets.bin` (only SYSTEM can decrypt it). The owner's own
//!   original auto sign-in password therefore cannot come back; the value is
//!   deleted and the administrator is told.
//! - It never writes the machine-wide `Winlogon\Shell` or `Userinit`, never touches
//!   `IgnoreShiftOverride`, and never changes an administrator account.

use std::collections::HashSet;
use std::io::{BufRead, Write};
use std::path::Path;

use rulebox_win32::security::DirCheck;

use crate::admin_exit::{AUTO_ADMIN_LOGON, WINLOGON_KEY};
use crate::kiosk::{LSA_DEFAULT_PASSWORD, LSA_PENDING, STAFF_COMMENT, STAFF_USER_NAME};
use crate::paths::{DataPaths, InstallPaths};
use crate::platform::{Platform, RegData, RegValueRef, ShellMechanism};
use crate::service::StopOutcome;
use crate::state::{unix_ms, write_atomic, AgentState, KioskApplied, OriginalValue};

const DEFAULT_USER_NAME: &str = "DefaultUserName";
const DISABLE_LOCK_WORKSTATION: &str = "DisableLockWorkstation";
/// How long `recover` waits for the service to stop (plan Step 11, step 2).
pub const SERVICE_STOP_WAIT: std::time::Duration = std::time::Duration::from_secs(30);

fn winlogon(name: &str) -> RegValueRef {
    RegValueRef { path: WINLOGON_KEY.to_string(), name: name.to_string() }
}

// -- what was found ---------------------------------------------------------------------

/// What `recover` found in the state file.
#[derive(Debug, Clone, PartialEq)]
pub enum StateReading {
    /// The data directory is missing, a link, or not protected as expected: nothing
    /// was read from it.
    DirNotTrusted(String),
    /// The directory is fine and holds no state file.
    Missing,
    /// The file is there but could not be read or parsed.
    Unreadable(String),
    Readable(Box<AgentState>),
}

/// Everything the plan depends on, read before anything is changed.
#[derive(Debug, Clone, PartialEq)]
pub struct Facts {
    pub state: StateReading,
    /// The data directory passed the check, so the flag may be written into it.
    pub data_dir_trusted: bool,
    /// `Winlogon\DefaultUserName` as it was when `recover` started.
    pub default_user_name: Option<String>,
    /// The SID of `RuleboxStaff`, only when the account carries the Rulebox comment.
    pub staff_sid: Option<String>,
    /// Lines for the administrator about things that could not be read.
    pub read_notes: Vec<String>,
}

/// Why a data directory is not used, or `None` when it may be read (Section 5.1,
/// "recover only verifies"). Pure.
pub fn dir_problem(check: &DirCheck) -> Option<String> {
    if !check.exists {
        Some("it does not exist".to_string())
    } else if check.is_reparse_point {
        Some("it is a reparse point (link or junction)".to_string())
    } else if !check.is_ok() {
        Some("it is not owned by SYSTEM or Administrators with the protected permissions".to_string())
    } else {
        None
    }
}

/// Verifies the data directory and reads `agent-state.json` from it. The file is
/// read as it is: a file that does not parse is **not** renamed (recovery changes
/// as little as it can), it is simply "unreadable". Returns the reading and whether
/// the directory may be written to.
pub fn read_state(
    paths: &DataPaths,
    verify: &dyn Fn(&Path) -> rulebox_win32::Result<DirCheck>,
) -> (StateReading, bool) {
    let check = match verify(paths.root()) {
        Ok(check) => check,
        Err(error) => {
            return (StateReading::DirNotTrusted(format!("it could not be checked: {error}")), false);
        }
    };
    if let Some(problem) = dir_problem(&check) {
        return (StateReading::DirNotTrusted(problem), false);
    }
    let bytes = match std::fs::read(paths.agent_state()) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return (StateReading::Missing, true),
        Err(error) => return (StateReading::Unreadable(error.to_string()), true),
    };
    match serde_json::from_slice::<AgentState>(&bytes) {
        Ok(state) => (StateReading::Readable(Box::new(state)), true),
        Err(error) => (StateReading::Unreadable(format!("it does not parse: {error}")), true),
    }
}

/// What `recover` needs from the machine.
pub struct RecoverEnv<'a> {
    pub platform: &'a dyn Platform,
    pub paths: &'a DataPaths,
    /// Checks the data directory (`security::verify_protected_dir` in production).
    pub verify_dir: &'a dyn Fn(&Path) -> rulebox_win32::Result<DirCheck>,
    /// Step 2: stops the service if it runs (errors are the caller's to ignore).
    pub stop_service: &'a dyn Fn() -> StopOutcome,
}

/// Reads the state file, `DefaultUserName` and the Staff account. Read-only.
pub fn gather(env: &RecoverEnv<'_>) -> Facts {
    let (state, data_dir_trusted) = read_state(env.paths, env.verify_dir);
    let mut read_notes = Vec::new();

    let default_user_name = match env.platform.read_machine_value(&winlogon(DEFAULT_USER_NAME)) {
        Ok(Some(RegData::String(name))) => Some(name),
        Ok(_) => None,
        Err(error) => {
            read_notes.push(format!("Could not read Winlogon {DEFAULT_USER_NAME} ({error}); Winlogon is left alone."));
            None
        }
    };

    let staff_sid = match env.platform.find_local_user(STAFF_USER_NAME) {
        Ok(Some(user)) if user.comment == STAFF_COMMENT => Some(user.sid),
        Ok(Some(_)) => {
            read_notes.push(format!(
                "An account named {STAFF_USER_NAME} exists but was not created by Rulebox; it was left alone."
            ));
            None
        }
        Ok(None) => None,
        Err(error) => {
            read_notes.push(format!("Could not look up the {STAFF_USER_NAME} account ({error}); it was left alone."));
            None
        }
    };

    Facts { state, data_dir_trusted, default_user_name, staff_sid, read_notes }
}

// -- the plan -----------------------------------------------------------------------------

/// One thing `recover` does. Steps 3 to 7 of the plan text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Step {
    /// Step 3: a journaled machine value goes back (`None` = it was absent, so it is deleted).
    RestoreValue { key: RegValueRef, data: Option<RegData> },
    /// Step 3: the original is the owner's plaintext password, which only SYSTEM can
    /// read; the value is deleted.
    DropPasswordValue { key: RegValueRef },
    /// Step 4: `AutoAdminLogon` = `"0"` because the state is unknown and Windows is
    /// set to sign in as `RuleboxStaff`.
    SwitchOffAutoLogon,
    /// Step 5.
    DeleteLsaSecret { name: &'static str },
    /// Step 6: the shell value (both mechanisms) and `DisableLockWorkstation`.
    ClearStaffHive { sid: String },
    /// Step 7: `kiosk.applied = Disabled` in the state file.
    MarkStateDisabled,
}

impl Step {
    /// One line for the administrator (never a value, so never a secret).
    pub fn describe(&self) -> String {
        match self {
            Step::RestoreValue { key, data: Some(_) } => format!("restore {}", key.name),
            Step::RestoreValue { key, data: None } => format!("remove {} (it did not exist before Rulebox)", key.name),
            Step::DropPasswordValue { key } => format!("remove {} (the original is not readable here)", key.name),
            Step::SwitchOffAutoLogon => "turn automatic sign-in off".to_string(),
            Step::DeleteLsaSecret { name } if *name == LSA_PENDING => {
                "delete the pending Staff password secret".to_string()
            }
            Step::DeleteLsaSecret { .. } => "delete the automatic sign-in password secret".to_string(),
            Step::ClearStaffHive { .. } => {
                format!("remove the Rulebox shell and lock policy from the {STAFF_USER_NAME} account")
            }
            Step::MarkStateDisabled => "mark the kiosk as disabled in the agent state".to_string(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    pub steps: Vec<Step>,
    /// What the administrator should know or check; printed at the end.
    pub notes: Vec<String>,
}

fn data_of(original: &OriginalValue) -> Option<RegData> {
    match original {
        OriginalValue::Absent | OriginalValue::InSecrets => None,
        OriginalValue::Dword(value) => Some(RegData::Dword(*value)),
        OriginalValue::String(text) => Some(RegData::String(text.clone())),
    }
}

/// Plan Step 11, "recover", steps 3 to 7, as a pure function of what was found.
pub fn plan(facts: &Facts) -> Plan {
    let mut steps: Vec<Step> = Vec::new();
    let mut notes: Vec<String> = facts.read_notes.clone();
    let staff_is_default_user = facts
        .default_user_name
        .as_deref()
        .is_some_and(|name| name.eq_ignore_ascii_case(STAFF_USER_NAME));
    let mut lsa_is_ours = staff_is_default_user;

    match &facts.state {
        StateReading::Readable(state) => {
            // Step 3. The journal is in the order the values were first changed.
            let password_lost = state.journal.iter().any(|entry| entry.original == OriginalValue::InSecrets);
            for entry in &state.journal {
                if entry.original == OriginalValue::InSecrets {
                    steps.push(Step::DropPasswordValue { key: entry.key.clone() });
                    continue;
                }
                let mut data = data_of(&entry.original);
                // The owner's password cannot come back, so putting automatic sign-in
                // back to "1" would make Windows try the owner's account with no
                // password at every start (and count each try as a failed sign-in).
                // That holds when the password was a registry value kept in the
                // service's secrets, and also when it was the LSA secret the agent
                // replaced (`lsa_taken_over`): `recover` deletes the Staff password
                // from the LSA and cannot read the original (only SYSTEM can).
                if (password_lost || state.kiosk.lsa_taken_over)
                    && entry.key == winlogon(AUTO_ADMIN_LOGON)
                    && data == Some(RegData::String("1".to_string()))
                {
                    data = Some(RegData::String("0".to_string()));
                    notes.push(
                        "AutoAdminLogon was left at 0 because the original automatic sign-in password could \
                         not be restored. Set automatic sign-in up again if you want it."
                            .to_string(),
                    );
                }
                steps.push(Step::RestoreValue { key: entry.key.clone(), data });
            }
            if password_lost {
                notes.push(
                    "Your own previous automatic sign-in password could not be restored (only the Rulebox \
                     service can read it). Set automatic sign-in up again if you want it."
                        .to_string(),
                );
            }
            lsa_is_ours |= state.kiosk.lsa_taken_over;
        }
        other => {
            // Step 4.
            let why = match other {
                StateReading::DirNotTrusted(reason) => format!(
                    "The data directory was not used ({reason}); the Windows settings are decided from \
                     Winlogon alone."
                ),
                StateReading::Unreadable(reason) => {
                    format!("The agent state file could not be read ({reason}); only the basics are undone.")
                }
                _ => "There is no agent state file; only the basics are undone.".to_string(),
            };
            notes.push(why);
            if staff_is_default_user {
                steps.push(Step::SwitchOffAutoLogon);
            } else {
                notes.push(format!("Winlogon does not name {STAFF_USER_NAME}; it was left alone."));
            }
        }
    }

    // Step 5. `DefaultPassword` only when it is the Staff password; the pending one
    // is always ours.
    if lsa_is_ours {
        steps.push(Step::DeleteLsaSecret { name: LSA_DEFAULT_PASSWORD });
    }
    steps.push(Step::DeleteLsaSecret { name: LSA_PENDING });

    // Step 6.
    if let Some(sid) = &facts.staff_sid {
        steps.push(Step::ClearStaffHive { sid: sid.clone() });
    }

    // Step 7 (the state file part; the flag is written by `execute`).
    if matches!(facts.state, StateReading::Readable(_)) {
        steps.push(Step::MarkStateDisabled);
    }
    Plan { steps, notes }
}

// -- executing -----------------------------------------------------------------------------

/// What happened to the recovered flag.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FlagOutcome {
    Written,
    Skipped(String),
    Failed(String),
}

#[derive(Debug)]
pub struct RecoverReport {
    pub service: StopOutcome,
    pub flag: FlagOutcome,
    /// Steps that went through, as `Step::describe` lines.
    pub done: Vec<String>,
    /// Steps that failed: what and why.
    pub failed: Vec<String>,
    pub notes: Vec<String>,
}

impl RecoverReport {
    /// Every step ran, the flag was written (or could not be, because the data
    /// directory was not trusted) and the state file was saved.
    pub fn is_complete(&self) -> bool {
        self.failed.is_empty() && !matches!(self.flag, FlagOutcome::Failed(_))
    }

    /// Step 8: what was changed and what the administrator should check.
    pub fn print(&self, out: &mut dyn Write) {
        let _ = writeln!(
            out,
            "{}",
            if self.is_complete() { "Recovery finished." } else { "Recovery finished with problems." }
        );
        match &self.service {
            StopOutcome::NotInstalled => {
                let _ = writeln!(out, "Service: not installed.");
            }
            StopOutcome::NotRunning => {
                let _ = writeln!(out, "Service: was not running.");
            }
            StopOutcome::Stopped => {
                let _ = writeln!(out, "Service: stopped.");
            }
            StopOutcome::TimedOut => {
                let _ = writeln!(
                    out,
                    "Service: did not stop in time. It may re-apply the kiosk; the flag below holds it off."
                );
            }
            StopOutcome::Failed(reason) => {
                let _ = writeln!(out, "Service: could not be stopped ({reason}).");
            }
        }
        if !self.done.is_empty() {
            let _ = writeln!(out, "Changed:");
            for line in &self.done {
                let _ = writeln!(out, "  - {line}");
            }
        }
        match &self.flag {
            FlagOutcome::Written => {
                let _ = writeln!(
                    out,
                    "Flag: recovered.flag written. The service keeps the kiosk off until the next enroll \
                     or until you delete that file."
                );
            }
            FlagOutcome::Skipped(reason) => {
                let _ = writeln!(out, "Flag: not written ({reason}).");
            }
            FlagOutcome::Failed(reason) => {
                let _ = writeln!(out, "Flag: could not be written ({reason}).");
            }
        }
        if !self.failed.is_empty() {
            let _ = writeln!(out, "Failed:");
            for line in &self.failed {
                let _ = writeln!(out, "  - {line}");
            }
        }
        let _ = writeln!(out, "Check:");
        for line in &self.notes {
            let _ = writeln!(out, "  - {line}");
        }
        let _ = writeln!(
            out,
            "  - Restart the PC (or sign out of the Staff account) to get the normal Windows sign-in screen."
        );
        let _ = writeln!(
            out,
            "  - The {STAFF_USER_NAME} account and its files were not removed; `unenroll --remove-staff-account` does that."
        );
    }
}

/// Which parts of the plan went through; what the state file update needs.
#[derive(Debug, Default)]
struct Outcome {
    restored: HashSet<RegValueRef>,
    lsa_default_password_ok: bool,
    staff_hive_ok: bool,
}

/// Applies the result of the plan to the state file contents (pure). The journal
/// entries that were put back (or deliberately dropped) are removed, so a later
/// Enable starts from what is on the machine now; the hive record and the LSA
/// take-over are forgotten once undone, or the next Enable would believe they are
/// still in place.
fn apply_to_state(state: &mut AgentState, outcome: &Outcome) {
    state.journal.retain(|entry| !outcome.restored.contains(&entry.key));
    if outcome.lsa_default_password_ok {
        state.kiosk.lsa_taken_over = false;
    }
    if outcome.staff_hive_ok {
        state.kiosk.staff_hive = None;
    }
    state.kiosk.applied = KioskApplied::Disabled;
    state.kiosk.last_error = None;
    state.kiosk.failures = 0;
}

fn flag_text() -> String {
    format!(
        "Written by `rulebox-agent recover` at unix time {} ms.\r\n\
         While this file exists the Rulebox Agent service does not enable the kiosk.\r\n\
         It is removed by the next `rulebox-agent enroll`, or delete it by hand.\r\n",
        unix_ms()
    )
}

fn write_flag(paths: &DataPaths) -> std::io::Result<()> {
    // The directory itself was verified; `state` inside it inherits its protection.
    std::fs::create_dir_all(paths.state_dir())?;
    write_atomic(&paths.recovered_flag(), flag_text().as_bytes())
}

/// Runs the steps of `plan`, then the state file update. Every step runs even if an
/// earlier one failed. `service` is what step 2 found.
pub fn execute(env: &RecoverEnv<'_>, facts: &Facts, plan: &Plan, service: StopOutcome) -> RecoverReport {
    let mut done: Vec<String> = Vec::new();
    let mut failed: Vec<String> = Vec::new();
    let mut outcome = Outcome { lsa_default_password_ok: true, staff_hive_ok: true, ..Outcome::default() };

    // The flag first (plan step 7 writes it last): if a step below fails, or the
    // service could not be stopped, nothing may re-enable the kiosk behind the
    // administrator's back.
    let flag = if !facts.data_dir_trusted {
        FlagOutcome::Skipped("the data directory is not used, and `recover` never creates or repairs it".to_string())
    } else {
        match write_flag(env.paths) {
            Ok(()) => FlagOutcome::Written,
            Err(error) => FlagOutcome::Failed(error.to_string()),
        }
    };

    for step in &plan.steps {
        let description = step.describe();
        let result: Result<(), String> = match step {
            Step::RestoreValue { key, data } => {
                let result = env.platform.write_machine_value(key, data.as_ref()).map_err(|e| e.to_string());
                if result.is_ok() {
                    outcome.restored.insert(key.clone());
                }
                result
            }
            Step::DropPasswordValue { key } => {
                let result = env.platform.write_machine_value(key, None).map_err(|e| e.to_string());
                if result.is_ok() {
                    outcome.restored.insert(key.clone());
                }
                result
            }
            Step::SwitchOffAutoLogon => env
                .platform
                .write_machine_value(&winlogon(AUTO_ADMIN_LOGON), Some(&RegData::String("0".to_string())))
                .map_err(|e| e.to_string()),
            Step::DeleteLsaSecret { name } => {
                let result = env.platform.lsa_secret_set(name, None).map_err(|e| e.to_string());
                if result.is_err() && *name == LSA_DEFAULT_PASSWORD {
                    outcome.lsa_default_password_ok = false;
                }
                result
            }
            Step::ClearStaffHive { sid } => {
                let result = clear_staff_hive(env.platform, sid);
                if result.is_err() {
                    outcome.staff_hive_ok = false;
                }
                result
            }
            Step::MarkStateDisabled => mark_state_disabled(env.paths, facts, &outcome),
        };
        match result {
            Ok(()) => done.push(description),
            Err(reason) => failed.push(format!("{description}: {reason}")),
        }
    }

    RecoverReport { service, flag, done, failed, notes: plan.notes.clone() }
}

fn clear_staff_hive(platform: &dyn Platform, sid: &str) -> Result<(), String> {
    use crate::platform::PlatformError;
    // An account (or hive) that is already gone is "cleared".
    let gone = |result: Result<(), PlatformError>| match result {
        Err(PlatformError::NotFound) => Ok(()),
        other => other,
    };
    gone(platform.set_staff_shell(sid, ShellMechanism::PolicyShell, None))
        .and_then(|()| gone(platform.set_staff_shell(sid, ShellMechanism::WinlogonShell, None)))
        .and_then(|()| gone(platform.set_staff_user_policy(sid, DISABLE_LOCK_WORKSTATION, None)))
        .map_err(|e| e.to_string())
}

fn mark_state_disabled(paths: &DataPaths, facts: &Facts, outcome: &Outcome) -> Result<(), String> {
    let StateReading::Readable(state) = &facts.state else {
        return Ok(());
    };
    let mut state = state.as_ref().clone();
    apply_to_state(&mut state, outcome);
    let bytes = serde_json::to_vec_pretty(&state).map_err(|e| e.to_string())?;
    write_atomic(&paths.agent_state(), &bytes).map_err(|e| e.to_string())
}

/// Steps 2 to 8 without any question: stops the service, reads the facts again
/// (the service may have changed the state while it ran), and runs the plan.
/// `service uninstall --force` calls this directly.
pub fn recover_machine(env: &RecoverEnv<'_>) -> RecoverReport {
    let service = (env.stop_service)();
    let facts = gather(env);
    let plan = plan(&facts);
    execute(env, &facts, &plan, service)
}

// -- the command ---------------------------------------------------------------------------

/// `recover [--yes]`. Refuses on a machine that is not a test machine, before it
/// reads or changes anything; then needs an elevated prompt and a confirmation.
pub fn run_recover(yes: bool, input: &mut dyn BufRead, out: &mut dyn Write, err: &mut dyn Write) -> u8 {
    let (install, paths) = match (InstallPaths::from_known_folders(), DataPaths::from_known_folders()) {
        (Ok(install), Ok(paths)) => (install, paths),
        (Err(error), _) | (_, Err(error)) => {
            let _ = writeln!(err, "error: {error:#}");
            return crate::ipc_admin::EXIT_ERROR;
        }
    };
    run_recover_at(&install, &paths, yes, input, out, err)
}

/// [`run_recover`] on explicit folders (the tests use temporary ones).
pub fn run_recover_at(
    install: &InstallPaths,
    paths: &DataPaths,
    yes: bool,
    input: &mut dyn BufRead,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> u8 {
    // The guard first: on a machine that is not a test machine nothing at all is
    // read, asked or changed.
    if let Err(error) = crate::service::guard_destructive("recover") {
        let _ = writeln!(err, "error: {error:#}");
        return crate::ipc_admin::EXIT_ERROR;
    }
    match rulebox_win32::security::process_is_elevated() {
        Ok(true) => {}
        Ok(false) => {
            let _ = writeln!(err, "error: run `recover` from an elevated (Run as administrator) prompt.");
            return crate::ipc_admin::EXIT_ERROR;
        }
        Err(error) => {
            let _ = writeln!(err, "error: cannot tell whether this prompt is elevated: {error}");
            return crate::ipc_admin::EXIT_ERROR;
        }
    }
    let platform = crate::platform::windows::WindowsPlatform::new(install.clone(), paths.clone());
    let stop = || crate::service::stop_service(SERVICE_STOP_WAIT);
    let env = RecoverEnv {
        platform: &platform,
        paths,
        verify_dir: &rulebox_win32::security::verify_protected_dir,
        stop_service: &stop,
    };
    recover_interactive(&env, yes, input, out, err)
}

/// The prompt, then the recovery. Returns the exit code (0 only when it is complete).
pub fn recover_interactive(
    env: &RecoverEnv<'_>,
    yes: bool,
    input: &mut dyn BufRead,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> u8 {
    // A preview from a read-only look; the real run reads again after the service
    // has stopped.
    let preview = plan(&gather(env));
    let _ = writeln!(out, "`recover` puts normal Windows back on this PC. It will:");
    let _ = writeln!(out, "  - stop the Rulebox Agent service (if it runs)");
    for step in &preview.steps {
        let _ = writeln!(out, "  - {}", step.describe());
    }
    let _ = writeln!(out, "  - keep the kiosk off until the next enroll (recovered.flag)");
    if !yes {
        let _ = write!(out, "Continue? [y/N] ");
        let _ = out.flush();
        let mut answer = String::new();
        let confirmed = input.read_line(&mut answer).is_ok()
            && matches!(answer.trim().to_ascii_lowercase().as_str(), "y" | "yes");
        if !confirmed {
            let _ = writeln!(err, "Nothing was changed.");
            return crate::ipc_admin::EXIT_ERROR;
        }
    }
    let report = recover_machine(env);
    report.print(out);
    if report.is_complete() {
        0
    } else {
        crate::ipc_admin::EXIT_ERROR
    }
}

/// The line `status` adds when `recover` held the kiosk off (plan Section 10.2).
pub fn status_line(paths: &DataPaths) -> Option<String> {
    paths
        .recovered_flag()
        .exists()
        .then(|| format!("{:<14}: kiosk held off (delete {} or enroll again to lift it)", "recovered", paths.recovered_flag().display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::sync::Arc;

    use rulebox_win32::sid::Sid;

    use crate::agent::AgentConfig;
    use crate::kiosk::{EnableOptions, Kiosk};
    use crate::platform::sim::{SimOp, SimPlatform};
    use crate::platform::PlatformError;
    use crate::state::{Enrollment, JournalEntry, SharedState, StateStore};
    use crate::testutil::TempDir;

    const OWNER_PLAIN: &str = "owner-plaintext-pw";
    const OWNER_LSA: &str = "owner-lsa-pw";

    /// Registry values, LSA secrets, Staff shell and Staff policies of the simulated PC.
    type Machine = (
        std::collections::HashMap<RegValueRef, RegData>,
        std::collections::HashMap<String, String>,
        std::collections::HashMap<String, (ShellMechanism, Option<String>)>,
        std::collections::HashMap<(String, String), u32>,
    );

    fn ok_dir() -> DirCheck {
        DirCheck { exists: true, is_reparse_point: false, owner: Some(Sid::system()), dacl_matches: true }
    }

    fn text(value: &str) -> RegData {
        RegData::String(value.to_string())
    }

    fn facts(state: StateReading, default_user: Option<&str>, staff: Option<&str>) -> Facts {
        Facts {
            data_dir_trusted: matches!(state, StateReading::Readable(_) | StateReading::Missing),
            state,
            default_user_name: default_user.map(str::to_string),
            staff_sid: staff.map(str::to_string),
            read_notes: Vec::new(),
        }
    }

    fn readable(journal: Vec<JournalEntry>, lsa_taken_over: bool) -> StateReading {
        let mut state = AgentState { journal, ..AgentState::default() };
        state.kiosk.applied = KioskApplied::Enabled;
        state.kiosk.lsa_taken_over = lsa_taken_over;
        StateReading::Readable(Box::new(state))
    }

    fn entry(name: &str, original: OriginalValue) -> JournalEntry {
        JournalEntry { key: winlogon(name), original }
    }

    // -- the pure decisions (plan unit test 2) ---------------------------------------------

    #[test]
    fn a_missing_state_file_switches_auto_logon_off_only_when_winlogon_names_staff() {
        let steps = plan(&facts(StateReading::Missing, Some("RuleboxStaff"), None)).steps;
        assert_eq!(
            steps,
            [
                Step::SwitchOffAutoLogon,
                Step::DeleteLsaSecret { name: LSA_DEFAULT_PASSWORD },
                Step::DeleteLsaSecret { name: LSA_PENDING },
            ]
        );
        // The name check ignores case.
        let steps = plan(&facts(StateReading::Missing, Some("rulEboxstaff"), None)).steps;
        assert!(steps.contains(&Step::SwitchOffAutoLogon));

        // Someone else's auto sign-in: Winlogon is left alone and so is the LSA secret.
        let steps = plan(&facts(StateReading::Missing, Some("Owner"), None)).steps;
        assert_eq!(steps, [Step::DeleteLsaSecret { name: LSA_PENDING }]);
        let steps = plan(&facts(StateReading::Missing, None, None)).steps;
        assert_eq!(steps, [Step::DeleteLsaSecret { name: LSA_PENDING }]);
    }

    #[test]
    fn an_untrusted_directory_or_an_unreadable_file_takes_the_same_path_as_a_missing_file() {
        for state in [
            StateReading::DirNotTrusted("it is a reparse point (link or junction)".into()),
            StateReading::Unreadable("it does not parse".into()),
            StateReading::Missing,
        ] {
            let result = plan(&facts(state, Some("RuleboxStaff"), Some("S-1-5-21-1-2-3-1001")));
            assert!(result.steps.contains(&Step::SwitchOffAutoLogon));
            assert!(!result.steps.contains(&Step::MarkStateDisabled), "no state to mark");
            assert!(result.steps.contains(&Step::ClearStaffHive { sid: "S-1-5-21-1-2-3-1001".into() }));
            assert!(result.notes.iter().any(|note| note.contains("only the basics")
                || note.contains("not used")
                || note.contains("no agent state")));
        }
    }

    #[test]
    fn the_journal_is_restored_in_order_and_the_state_is_marked() {
        let journal = vec![
            entry("AutoAdminLogon", OriginalValue::Absent),
            entry("DefaultUserName", OriginalValue::String("Owner".into())),
            JournalEntry {
                key: RegValueRef {
                    path: r"SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System".into(),
                    name: "EnableFirstLogonAnimation".into(),
                },
                original: OriginalValue::Dword(1),
            },
        ];
        let result = plan(&facts(readable(journal, true), Some("RuleboxStaff"), Some("S-1-5-21-1-2-3-1001")));
        assert_eq!(
            result.steps,
            [
                Step::RestoreValue { key: winlogon("AutoAdminLogon"), data: None },
                Step::RestoreValue { key: winlogon("DefaultUserName"), data: Some(text("Owner")) },
                Step::RestoreValue {
                    key: RegValueRef {
                        path: r"SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System".into(),
                        name: "EnableFirstLogonAnimation".into(),
                    },
                    data: Some(RegData::Dword(1)),
                },
                Step::DeleteLsaSecret { name: LSA_DEFAULT_PASSWORD },
                Step::DeleteLsaSecret { name: LSA_PENDING },
                Step::ClearStaffHive { sid: "S-1-5-21-1-2-3-1001".into() },
                Step::MarkStateDisabled,
            ]
        );
    }

    #[test]
    fn an_original_password_in_secrets_is_deleted_and_auto_logon_is_not_turned_back_on() {
        let journal = vec![
            entry("AutoAdminLogon", OriginalValue::String("1".into())),
            entry("DefaultUserName", OriginalValue::String("Owner".into())),
            entry("DefaultPassword", OriginalValue::InSecrets),
        ];
        let result = plan(&facts(readable(journal, true), Some("RuleboxStaff"), None));
        assert!(result.steps.contains(&Step::DropPasswordValue { key: winlogon("DefaultPassword") }));
        // "1" would make Windows sign the owner in with an empty password at every start.
        assert!(result
            .steps
            .contains(&Step::RestoreValue { key: winlogon("AutoAdminLogon"), data: Some(text("0")) }));
        assert!(result.notes.iter().any(|note| note.contains("automatic sign-in password")));
        // Nothing the plan prints carries the password itself.
        for step in &result.steps {
            assert!(!step.describe().contains(OWNER_PLAIN));
        }
    }

    #[test]
    fn an_owner_whose_password_was_the_lsa_secret_is_not_left_trying_an_empty_password() {
        // Found as a gap on the VM: the owner used LSA-based automatic sign-in
        // (AutoAdminLogon "1", the password only in the LSA). The agent replaced the
        // secret and recover deletes it, so "1" would fail at every start.
        let journal = vec![
            entry("AutoAdminLogon", OriginalValue::String("1".into())),
            entry("DefaultUserName", OriginalValue::String("Owner".into())),
        ];
        let result = plan(&facts(readable(journal.clone(), true), Some("RuleboxStaff"), None));
        assert!(result
            .steps
            .contains(&Step::RestoreValue { key: winlogon("AutoAdminLogon"), data: Some(text("0")) }));
        assert!(result.notes.iter().any(|note| note.contains("Set automatic sign-in up again")));
        // The owner name is still restored.
        assert!(result
            .steps
            .contains(&Step::RestoreValue { key: winlogon("DefaultUserName"), data: Some(text("Owner")) }));

        // When the agent never took the secret over (a rollback before that step), "1"
        // can safely go back: the owner's own secret was left alone.
        let result = plan(&facts(readable(journal, false), Some("RuleboxStaff"), None));
        assert!(result
            .steps
            .contains(&Step::RestoreValue { key: winlogon("AutoAdminLogon"), data: Some(text("1")) }));
    }

    #[test]
    fn the_staff_password_secret_goes_when_the_state_says_it_was_taken_over_even_if_winlogon_changed() {
        // An administrator signed in and Windows rewrote DefaultUserName.
        let result = plan(&facts(readable(Vec::new(), true), Some("Administrator"), None));
        assert!(result.steps.contains(&Step::DeleteLsaSecret { name: LSA_DEFAULT_PASSWORD }));
        // Never taken over and Winlogon names someone else: the owner's secret stays.
        let result = plan(&facts(readable(Vec::new(), false), Some("Administrator"), None));
        assert!(!result.steps.contains(&Step::DeleteLsaSecret { name: LSA_DEFAULT_PASSWORD }));
    }

    #[test]
    fn dir_problem_follows_the_section_5_1_rules() {
        assert_eq!(dir_problem(&ok_dir()), None);
        let reparse = DirCheck { is_reparse_point: true, ..ok_dir() };
        assert!(dir_problem(&reparse).unwrap().contains("reparse"));
        let missing = DirCheck { exists: false, ..ok_dir() };
        assert!(dir_problem(&missing).unwrap().contains("does not exist"));
        let wrong_owner = DirCheck {
            owner: Some(Sid::parse("S-1-5-21-1-2-3-1001").unwrap()),
            ..ok_dir()
        };
        assert!(dir_problem(&wrong_owner).is_some());
        let wrong_dacl = DirCheck { dacl_matches: false, ..ok_dir() };
        assert!(dir_problem(&wrong_dacl).is_some());
    }

    #[test]
    fn apply_to_state_keeps_what_was_not_undone() {
        let mut state = AgentState {
            journal: vec![
                entry("AutoAdminLogon", OriginalValue::Absent),
                entry("DefaultUserName", OriginalValue::String("Owner".into())),
            ],
            ..AgentState::default()
        };
        state.kiosk.applied = KioskApplied::Enabled;
        state.kiosk.lsa_taken_over = true;
        state.kiosk.last_error = Some("platform_error".into());
        state.kiosk.failures = 3;
        state.kiosk.staff_hive = Some(crate::state::StaffHiveRecord { fingerprint: "x".into(), complete: true });

        // One value could not be put back, the LSA secret and the hive were cleared.
        let outcome = Outcome {
            restored: [winlogon("AutoAdminLogon")].into_iter().collect(),
            lsa_default_password_ok: true,
            staff_hive_ok: true,
        };
        apply_to_state(&mut state, &outcome);
        assert_eq!(state.journal.len(), 1);
        assert_eq!(state.journal[0].key.name, "DefaultUserName");
        assert!(!state.kiosk.lsa_taken_over);
        assert!(state.kiosk.staff_hive.is_none());
        assert_eq!(state.kiosk.applied, KioskApplied::Disabled);
        assert_eq!((state.kiosk.last_error.clone(), state.kiosk.failures), (None, 0));

        // A failed LSA delete and a failed hive clean-up are remembered.
        let mut state = AgentState::default();
        state.kiosk.lsa_taken_over = true;
        state.kiosk.staff_hive = Some(crate::state::StaffHiveRecord { fingerprint: "x".into(), complete: true });
        apply_to_state(
            &mut state,
            &Outcome { restored: HashSet::new(), lsa_default_password_ok: false, staff_hive_ok: false },
        );
        assert!(state.kiosk.lsa_taken_over);
        assert!(state.kiosk.staff_hive.is_some());
    }

    // -- the executor against SimPlatform ---------------------------------------------------

    struct World {
        // Held only so the directory is removed on drop.
        #[allow(dead_code)]
        dir: TempDir,
        platform: Arc<SimPlatform>,
        paths: DataPaths,
        install: InstallPaths,
    }

    impl World {
        fn new() -> Self {
            let dir = TempDir::new();
            let platform = Arc::new(SimPlatform::new(dir.path().to_path_buf()));
            let paths = DataPaths::new(dir.path().to_path_buf());
            let install = InstallPaths::new(dir.path().join("install"));
            Self { dir, platform, paths, install }
        }

        fn set(&self, path: &str, name: &str, data: RegData) {
            self.platform.with_world(|w| {
                w.machine_values.insert(RegValueRef { path: path.into(), name: name.into() }, data);
            });
        }

        fn owner_autologon(&self) {
            self.set(WINLOGON_KEY, "AutoAdminLogon", text("1"));
            self.set(WINLOGON_KEY, "DefaultUserName", text("Owner"));
            self.set(WINLOGON_KEY, "DefaultDomainName", text("OWNERPC"));
            self.set(WINLOGON_KEY, "DefaultPassword", text(OWNER_PLAIN));
            self.set(WINLOGON_KEY, "AutoLogonCount", RegData::Dword(3));
            self.platform.with_world(|w| {
                w.lsa_secrets.insert(LSA_DEFAULT_PASSWORD.to_string(), OWNER_LSA.to_string());
            });
        }

        fn enrolled_state() -> AgentState {
            AgentState {
                enrollment: Some(Enrollment {
                    convex_url: "https://test.convex.cloud".into(),
                    device_id: "dev-1".into(),
                    org_id: "org-1".into(),
                    device_name: "Desk".into(),
                    enrolled_at_ms: 1,
                    revoked: false,
                    allow_joined: false,
                }),
                ..AgentState::default()
            }
        }

        /// A shared state over this world's `state` directory (what a service would hold).
        fn shared(&self, state: AgentState) -> Arc<SharedState> {
            let store = StateStore::open(&self.paths.state_dir()).unwrap();
            let platform: Arc<dyn Platform> = self.platform.clone();
            SharedState::new(store, state, platform)
        }

        fn enable_kiosk(&self, shared: &Arc<SharedState>) {
            let config = AgentConfig::default();
            let mut kiosk =
                Kiosk { platform: self.platform.as_ref(), shared: shared.as_ref(), config: &config, install: &self.install };
            kiosk.enable(EnableOptions::default()).unwrap();
        }

        fn machine(&self) -> Machine {
            self.platform.with_world(|w| {
                (w.machine_values.clone(), w.lsa_secrets.clone(), w.staff_shell.clone(), w.staff_policies.clone())
            })
        }

        fn value(&self, name: &str) -> Option<RegData> {
            self.platform.with_world(|w| w.machine_values.get(&winlogon(name)).cloned())
        }

        fn state_file(&self) -> AgentState {
            serde_json::from_slice(&std::fs::read(self.paths.agent_state()).unwrap()).unwrap()
        }
    }

    fn run_with(world: &World, dir: DirCheck, stop: StopOutcome) -> RecoverReport {
        let verify = move |_: &Path| Ok(dir.clone());
        let stop_fn = move || stop.clone();
        let env = RecoverEnv {
            platform: world.platform.as_ref(),
            paths: &world.paths,
            verify_dir: &verify,
            stop_service: &stop_fn,
        };
        recover_machine(&env)
    }

    #[test]
    fn recover_undoes_a_real_enable_and_the_kiosk_can_be_enabled_again_afterwards() {
        let world = World::new();
        world.owner_autologon();
        let before = world.machine();
        let shared = world.shared(World::enrolled_state());
        world.enable_kiosk(&shared);
        assert_eq!(shared.get().kiosk.applied, KioskApplied::Enabled);
        let staff_sid = shared.get().staff.unwrap().sid;
        assert!(shared.get().kiosk.staff_hive.is_some() && shared.get().kiosk.lsa_taken_over);
        drop(shared); // the service is stopped: nothing holds the state any more

        let report = run_with(&world, ok_dir(), StopOutcome::Stopped);
        assert!(report.is_complete(), "{report:#?}");
        assert_eq!(report.flag, FlagOutcome::Written);

        // Winlogon values are the owner's again, except the password that only SYSTEM
        // can read: it is gone, and automatic sign-in is left off for that reason.
        assert_eq!(world.value("DefaultUserName"), Some(text("Owner")));
        assert_eq!(world.value("DefaultDomainName"), Some(text("OWNERPC")));
        assert_eq!(world.value("DefaultPassword"), None);
        assert_eq!(world.value("AutoLogonCount"), Some(RegData::Dword(3)));
        assert_eq!(world.value("AutoAdminLogon"), Some(text("0")));
        let (values, lsa, staff_shell, staff_policies) = world.machine();
        // The three kiosk-only policy values are gone again, as before the enable.
        let (before_values, ..) = before;
        for (key, data) in &values {
            if key.name == "AutoAdminLogon" || key.name == "DefaultPassword" {
                continue;
            }
            assert_eq!(before_values.get(key), Some(data), "{key:?}");
        }
        assert!(values.keys().all(|key| key.name == "AutoAdminLogon" || before_values.contains_key(key)));
        // No Staff secret is left; the Staff hive has no shell and no lock policy.
        assert_eq!(lsa.get(LSA_DEFAULT_PASSWORD), None);
        assert_eq!(lsa.get(LSA_PENDING), None);
        assert!(staff_shell.is_empty() && staff_policies.is_empty());

        // The state file says Disabled, holds nothing to undo, and the flag exists.
        let saved = world.state_file();
        assert_eq!(saved.kiosk.applied, KioskApplied::Disabled);
        assert!(saved.journal.is_empty());
        assert!(!saved.kiosk.lsa_taken_over);
        assert!(saved.kiosk.staff_hive.is_none());
        assert!(saved.enrollment.is_some(), "recover does not unenroll");
        assert!(saved.staff.is_some(), "the account and its record stay");
        assert!(world.paths.recovered_flag().is_file());
        assert!(status_line(&world.paths).unwrap().contains("kiosk held off"));

        // A later Enable (the flag lifted) writes everything again: the stale
        // hive record and LSA take-over were forgotten, or it would skip them.
        let again = world.shared(world.state_file());
        world.enable_kiosk(&again);
        world.platform.with_world(|w| {
            assert!(w.staff_shell.contains_key(&staff_sid), "the shell value is written again");
            assert!(w.staff_policies.contains_key(&(staff_sid.clone(), "DisableLockWorkstation".to_string())));
        });
        assert!(world.platform.with_world(|w| w.lsa_secrets.contains_key(LSA_DEFAULT_PASSWORD)));
    }

    #[test]
    fn recover_without_a_state_file_changes_only_the_basics() {
        let world = World::new();
        // Windows is set to sign in as the Staff account; the account carries our comment.
        world.set(WINLOGON_KEY, "AutoAdminLogon", text("1"));
        world.set(WINLOGON_KEY, "DefaultUserName", text("RuleboxStaff"));
        world.set(WINLOGON_KEY, "DefaultDomainName", text("SIM-PC"));
        let sid = world
            .platform
            .create_staff_user(
                &crate::platform::StaffUserSpec {
                    user_name: STAFF_USER_NAME.into(),
                    full_name: "Staff".into(),
                    comment: STAFF_COMMENT.into(),
                },
                "pw",
            )
            .unwrap();
        world.platform.set_staff_shell(&sid, ShellMechanism::PolicyShell, Some("\"x\"")).unwrap();
        world.platform.set_staff_user_policy(&sid, DISABLE_LOCK_WORKSTATION, Some(1)).unwrap();
        world.platform.lsa_secret_set(LSA_DEFAULT_PASSWORD, Some("staff-pw")).unwrap();
        world.platform.lsa_secret_set(LSA_PENDING, Some("pending-pw")).unwrap();

        let report = run_with(&world, ok_dir(), StopOutcome::NotInstalled);
        assert!(report.is_complete(), "{report:#?}");
        assert_eq!(world.value("AutoAdminLogon"), Some(text("0")));
        // Only AutoAdminLogon is written: the other values are left as they were.
        assert_eq!(world.value("DefaultUserName"), Some(text("RuleboxStaff")));
        assert_eq!(world.value("DefaultDomainName"), Some(text("SIM-PC")));
        world.platform.with_world(|w| {
            assert!(w.lsa_secrets.is_empty());
            assert!(w.staff_shell.is_empty() && w.staff_policies.is_empty());
            assert!(w.users.contains_key(STAFF_USER_NAME), "the account is not deleted");
        });
        // There was no state to mark, but the flag is written (the directory is fine).
        assert!(!world.paths.agent_state().exists());
        assert!(world.paths.recovered_flag().is_file());
    }

    #[test]
    fn recover_from_a_directory_that_is_not_trusted_reads_and_writes_nothing_there() {
        let world = World::new();
        // A state file that would make a difference if it were read.
        std::fs::create_dir_all(world.paths.state_dir()).unwrap();
        let mut state = World::enrolled_state();
        state.journal.push(entry("DefaultUserName", OriginalValue::String("FromAFileNobodyTrusts".into())));
        std::fs::write(world.paths.agent_state(), serde_json::to_vec(&state).unwrap()).unwrap();
        let before = std::fs::read(world.paths.agent_state()).unwrap();
        world.set(WINLOGON_KEY, "DefaultUserName", text("RuleboxStaff"));
        world.set(WINLOGON_KEY, "AutoAdminLogon", text("1"));

        for check in [
            DirCheck { is_reparse_point: true, ..ok_dir() },
            DirCheck { owner: Some(Sid::parse("S-1-5-21-1-2-3-1001").unwrap()), ..ok_dir() },
        ] {
            let report = run_with(&world, check, StopOutcome::NotRunning);
            assert!(report.is_complete(), "{report:#?}");
            assert!(matches!(report.flag, FlagOutcome::Skipped(_)), "{:?}", report.flag);
            assert_eq!(world.value("AutoAdminLogon"), Some(text("0")));
            assert_eq!(world.value("DefaultUserName"), Some(text("RuleboxStaff")), "the journal was not used");
            assert_eq!(std::fs::read(world.paths.agent_state()).unwrap(), before);
            assert!(!world.paths.recovered_flag().exists());
            world.set(WINLOGON_KEY, "AutoAdminLogon", text("1"));
        }
    }

    #[test]
    fn a_failing_step_does_not_stop_the_steps_after_it_and_is_reported() {
        let world = World::new();
        world.owner_autologon();
        let shared = world.shared(World::enrolled_state());
        world.enable_kiosk(&shared);
        drop(shared);

        world.platform.fail_next(SimOp::WriteMachineValue, PlatformError::AccessDenied);
        let report = run_with(&world, ok_dir(), StopOutcome::Stopped);
        assert!(!report.is_complete());
        assert_eq!(report.failed.len(), 1, "{:?}", report.failed);
        // The first journal entry (AutoAdminLogon) is the one that failed; the rest ran.
        assert_eq!(world.value("DefaultUserName"), Some(text("Owner")));
        assert!(!world.platform.with_world(|w| w.lsa_secrets.contains_key(LSA_DEFAULT_PASSWORD)));
        // The entry that was not restored is still in the journal for next time.
        let saved = world.state_file();
        assert_eq!(saved.journal.len(), 1);
        assert_eq!(saved.journal[0].key.name, "AutoAdminLogon");
        assert_eq!(saved.kiosk.applied, KioskApplied::Disabled);
        assert!(world.paths.recovered_flag().is_file(), "the flag holds the kiosk off even so");
    }

    #[test]
    fn a_foreign_account_with_the_staff_name_is_left_alone() {
        let world = World::new();
        world.platform.with_world(|w| {
            w.users.insert(
                STAFF_USER_NAME.to_string(),
                crate::platform::sim::SimUser {
                    sid: "S-1-5-21-1-2-3-1500".into(),
                    comment: "somebody else's account".into(),
                    disabled: false,
                    password: "pw".into(),
                },
            );
            w.staff_shell.insert("S-1-5-21-1-2-3-1500".into(), (ShellMechanism::PolicyShell, Some("theirs".into())));
        });
        let report = run_with(&world, ok_dir(), StopOutcome::NotInstalled);
        assert!(report.notes.iter().any(|note| note.contains("was not created by Rulebox")));
        world.platform.with_world(|w| assert!(w.staff_shell.contains_key("S-1-5-21-1-2-3-1500")));
    }

    #[test]
    fn the_prompt_needs_a_yes_and_declining_changes_nothing() {
        let world = World::new();
        world.set(WINLOGON_KEY, "DefaultUserName", text("RuleboxStaff"));
        world.set(WINLOGON_KEY, "AutoAdminLogon", text("1"));
        let verify = |_: &Path| Ok(ok_dir());
        let stopped = std::cell::Cell::new(0u32);
        let stop = || {
            stopped.set(stopped.get() + 1);
            StopOutcome::Stopped
        };
        let env = RecoverEnv {
            platform: world.platform.as_ref(),
            paths: &world.paths,
            verify_dir: &verify,
            stop_service: &stop,
        };

        for answer in ["n\n", "\n", "maybe\n", ""] {
            let (mut out, mut err) = (Vec::new(), Vec::new());
            let code = recover_interactive(&env, false, &mut answer.as_bytes(), &mut out, &mut err);
            assert_eq!(code, 1, "{answer:?}");
            assert_eq!(world.value("AutoAdminLogon"), Some(text("1")));
            assert!(!world.paths.recovered_flag().exists());
        }
        assert_eq!(stopped.get(), 0, "the service is not stopped before the answer");

        let (mut out, mut err) = (Vec::new(), Vec::new());
        let code = recover_interactive(&env, false, &mut "Yes\n".as_bytes(), &mut out, &mut err);
        assert_eq!(code, 0, "{}", String::from_utf8_lossy(&err));
        let printed = String::from_utf8(out).unwrap();
        assert!(printed.contains("Recovery finished."), "{printed}");
        assert!(printed.contains("recovered.flag"), "{printed}");
        assert_eq!(world.value("AutoAdminLogon"), Some(text("0")));
        assert_eq!(stopped.get(), 1);

        // `--yes` skips the question.
        world.set(WINLOGON_KEY, "AutoAdminLogon", text("1"));
        let (mut out, mut err) = (Vec::new(), Vec::new());
        assert_eq!(recover_interactive(&env, true, &mut "".as_bytes(), &mut out, &mut err), 0);
    }

    // -- the guard (plan: refused before any change) --------------------------------------------

    #[test]
    fn recover_is_refused_by_the_guard_before_anything_is_read_or_changed() {
        if rulebox_win32::guard::is_test_machine() {
            return;
        }
        let world = World::new();
        std::fs::create_dir_all(world.paths.state_dir()).unwrap();
        let mut state = World::enrolled_state();
        state.kiosk.applied = KioskApplied::Enabled;
        let bytes = serde_json::to_vec_pretty(&state).unwrap();
        std::fs::write(world.paths.agent_state(), &bytes).unwrap();
        let listing = |world: &World| {
            let mut names: Vec<String> = std::fs::read_dir(world.paths.state_dir())
                .unwrap()
                .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
                .collect();
            names.sort();
            names
        };
        let before = listing(&world);

        let (mut out, mut err) = (Vec::new(), Vec::new());
        // `yes` would answer the prompt; the refusal must come first.
        let code = run_recover_at(&world.install, &world.paths, true, &mut "".as_bytes(), &mut out, &mut err);
        assert_eq!(code, 1);
        let error = String::from_utf8(err).unwrap();
        assert!(error.contains("test-machine guard") && error.contains("recover"), "{error}");
        assert!(out.is_empty(), "no preview, no prompt");
        assert_eq!(std::fs::read(world.paths.agent_state()).unwrap(), bytes);
        assert_eq!(listing(&world), before);
        assert!(!world.paths.recovered_flag().exists());
    }
}
