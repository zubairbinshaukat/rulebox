//! The kiosk reconciler (plan Section 5.6, Step 9): Enable, Disable, repair of drift,
//! the journal and the rollback, driven by the desired state. Everything that
//! changes the machine goes through the `Platform` seam; this file contains no
//! Win32 and no `unsafe`.
//!
//! Two layers:
//!
//! - [`Kiosk`] is synchronous and runs inside `spawn_blocking`. `enable` and
//!   `disable` are idempotent: they read the machine and change only what differs.
//!   State and secrets are saved after **each** numbered step of Section 5.6, and a
//!   journal entry is saved **before** the value it describes is overwritten, so a
//!   crash (power loss) at any point leaves an accurate journal.
//! - [`Reconciler`] is the one task that calls `Kiosk` (Section 5.2). It owns the
//!   triggers, the retry schedule, the exit hold of Section 5.10, the locked-session
//!   rule and the 10-second sign-out of Disable. [`ReconcilerHandle`] is the
//!   [`KioskControl`] the backend task and the enrollment flow talk to.
//!
//! What the machine looks like when the kiosk is on (all of it undone by Disable):
//! the Staff account `RuleboxStaff`, its shell value and `DisableLockWorkstation` in
//! its hive, eight machine values under `HKLM`, and the LSA secret `DefaultPassword`.
//! Never written: the machine-wide `Winlogon\Shell` and `Userinit`,
//! `IgnoreShiftOverride`, `AutoLogonCount` (it is only deleted), and nothing about any
//! administrator account.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use futures_util::future::BoxFuture;
use futures_util::FutureExt;
use rulebox_ipc::types::{KioskPhase, KioskStatus, ShutdownReason};
use rulebox_policy::DesiredState;
use tokio::sync::{mpsc, oneshot, watch};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

use crate::admin_exit::{run_exit, ExitRequest, AUTO_ADMIN_LOGON, WINLOGON_KEY};
use crate::agent::{AgentConfig, FILES_BASE_DIR};
use crate::compat;
use crate::ipc_shell::ShellBroadcast;
use crate::kiosk_control::KioskControl;
use crate::paths::InstallPaths;
use crate::platform::{
    Platform, PlatformError, RegData, RegValueRef, SessionInfo, SessionState, ShellMechanism, StaffUserSpec,
};
use crate::session::SessionManager;
use crate::state::{
    AgentState, JournalEntry, KioskApplied, KioskRecord, OriginalValue, SharedState, SnapshotHandle,
    StaffAccount, StaffHiveRecord,
};

// -- names and values (plan Sections 4.3 and 5.6) -------------------------------------

pub const STAFF_USER_NAME: &str = "RuleboxStaff";
pub const STAFF_FULL_NAME: &str = "Staff";
/// An account named `RuleboxStaff` is adopted only when its comment is exactly this.
pub const STAFF_COMMENT: &str = "Managed by Rulebox. Do not edit or delete.";
/// The LSA secret Windows reads for automatic sign-in.
pub const LSA_DEFAULT_PASSWORD: &str = "DefaultPassword";
/// The password that was set (or is about to be) on the account but is not yet the
/// sign-in secret. A crash between "set the password" and "store it" leaves it here.
pub const LSA_PENDING: &str = "L$RuleboxStaffPending";

const SYSTEM_POLICIES_KEY: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System";
const OOBE_POLICY_KEY: &str = r"SOFTWARE\Policies\Microsoft\Windows\OOBE";
const DEFAULT_PASSWORD_VALUE: &str = "DefaultPassword";
const DISABLE_LOCK_WORKSTATION: &str = "DisableLockWorkstation";

/// Disable: how long the Staff App is told it has before the Staff session is signed
/// out (`agent.shuttingDown { kioskDisabled }`).
pub const DISABLE_GRACE: Duration = Duration::from_secs(10);
/// A locked Staff console is signed out after this long if it is still the active
/// console session (Section 5.6, "Session rule for a locked Staff console").
pub const LOCK_GRACE: Duration = Duration::from_secs(10);
/// Drift is re-asserted this often even when no event arrives (Section 5.2).
pub const REASSERT_INTERVAL: Duration = Duration::from_secs(600);
/// While an exit hold is set it is looked at this often (Section 5.10).
pub const HOLD_TICK: Duration = Duration::from_secs(30);
/// The exit hold ends by itself after this long (Section 5.10).
pub const EXIT_HOLD_MAX: Duration = Duration::from_secs(300);

pub const PASSWORD_LEN: usize = 32;
const UPPER: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const LOWER: &[u8] = b"abcdefghijklmnopqrstuvwxyz";
const DIGITS: &[u8] = b"0123456789";
const SYMBOLS: &[u8] = b"!#%+-_=";

fn winlogon(name: &str) -> RegValueRef {
    RegValueRef { path: WINLOGON_KEY.to_string(), name: name.to_string() }
}

fn dword(path: &str, name: &str, value: u32) -> (RegValueRef, Option<RegData>) {
    (RegValueRef { path: path.to_string(), name: name.to_string() }, Some(RegData::Dword(value)))
}

/// The eight machine values of Section 5.6 step 5, in order, with what they are set
/// to. `exit_hold` turns `AutoAdminLogon` to `"0"` (Section 5.10).
fn wanted_machine_values(computer_name: &str, exit_hold: bool) -> Vec<(RegValueRef, Option<RegData>)> {
    let text = |value: &str| Some(RegData::String(value.to_string()));
    vec![
        (winlogon(AUTO_ADMIN_LOGON), text(if exit_hold { "0" } else { "1" })),
        (winlogon("DefaultUserName"), text(STAFF_USER_NAME)),
        (winlogon("DefaultDomainName"), text(computer_name)),
        // The plaintext password is deleted; the LSA secret replaces it.
        (winlogon(DEFAULT_PASSWORD_VALUE), None),
        // It would switch automatic sign-in off after N boots.
        (winlogon("AutoLogonCount"), None),
        dword(SYSTEM_POLICIES_KEY, "DisableAutomaticRestartSignOn", 1),
        dword(SYSTEM_POLICIES_KEY, "EnableFirstLogonAnimation", 0),
        dword(OOBE_POLICY_KEY, "DisablePrivacyExperience", 1),
    ]
}

fn is_plaintext_default_password(key: &RegValueRef) -> bool {
    key.path == WINLOGON_KEY && key.name == DEFAULT_PASSWORD_VALUE
}

// -- errors ---------------------------------------------------------------------------

#[derive(Debug, thiserror::Error)]
pub enum KioskError {
    /// A compatibility blocker (plan Section 5.5); the text is its code.
    #[error("blocked: {0}")]
    Blocked(String),
    #[error("an account named {STAFF_USER_NAME} exists and was not created by Rulebox")]
    StaffAccountConflict,
    #[error("the Staff account is disabled")]
    StaffAccountDisabled,
    #[error("{0}")]
    Platform(#[from] PlatformError),
    /// The state or secrets file could not be written; the step is treated as failed
    /// because a journal that is not on disk is worth nothing after a crash.
    #[error("cannot save the agent state: {0}")]
    Persist(String),
    #[error("{}", .0.iter().map(ToString::to_string).collect::<Vec<_>>().join("; "))]
    Multiple(Vec<KioskError>),
}

impl KioskError {
    /// The short code shown in `status`, in the snapshot and in the heartbeat.
    pub fn code(&self) -> String {
        match self {
            KioskError::Blocked(code) => code.clone(),
            KioskError::StaffAccountConflict => "staff_account_conflict".to_string(),
            KioskError::StaffAccountDisabled => "staff_account_disabled".to_string(),
            KioskError::Platform(PlatformError::PasswordPolicy) => "password_policy".to_string(),
            KioskError::Platform(PlatformError::AccessDenied) => "access_denied".to_string(),
            KioskError::Platform(PlatformError::Guard(_)) => "guard_blocked".to_string(),
            KioskError::Platform(_) => "platform_error".to_string(),
            KioskError::Persist(_) => "state_not_saved".to_string(),
            KioskError::Multiple(errors) => {
                errors.first().map_or_else(|| "platform_error".to_string(), KioskError::code)
            }
        }
    }

    /// True when a kiosk that is already on must not be left on: the machine can no
    /// longer be locked down safely (the administrator's way back is gone, the
    /// account is not ours). Anything else is a failed repair that leaves the kiosk
    /// as it was and is retried.
    fn must_not_stay_enabled(&self) -> bool {
        match self {
            KioskError::Blocked(_) | KioskError::StaffAccountConflict | KioskError::StaffAccountDisabled => true,
            KioskError::Multiple(errors) => errors.iter().any(KioskError::must_not_stay_enabled),
            KioskError::Platform(_) | KioskError::Persist(_) => false,
        }
    }
}

/// 32 characters from upper case, lower case, digits and `!#%+-_=`, at least one of
/// each class, drawn without modulo bias from the operating system's random source.
pub fn generate_password() -> Result<String, KioskError> {
    fn below(len: usize) -> Result<usize, KioskError> {
        // Rejection sampling: only bytes below the largest multiple of `len`.
        let limit = 256 - (256 % len);
        loop {
            let mut byte = [0u8; 1];
            getrandom::fill(&mut byte)
                .map_err(|_| PlatformError::Other("the operating system gave no random numbers".to_string()))?;
            if usize::from(byte[0]) < limit {
                return Ok(usize::from(byte[0]) % len);
            }
        }
    }
    let all: Vec<u8> = [UPPER, LOWER, DIGITS, SYMBOLS].concat();
    let mut chars: Vec<u8> = Vec::with_capacity(PASSWORD_LEN);
    for class in [UPPER, LOWER, DIGITS, SYMBOLS] {
        chars.push(class[below(class.len())?]);
    }
    while chars.len() < PASSWORD_LEN {
        chars.push(all[below(all.len())?]);
    }
    // Fisher-Yates, so the guaranteed characters are not always first.
    for i in (1..chars.len()).rev() {
        chars.swap(i, below(i + 1)?);
    }
    // All characters are ASCII.
    Ok(chars.into_iter().map(char::from).collect())
}

// -- status ---------------------------------------------------------------------------

/// What the snapshot's `kiosk` says for a state record: the same mapping at start
/// (`agent::initial_snapshot`) and after every reconcile.
pub fn kiosk_status(record: &KioskRecord) -> KioskStatus {
    KioskStatus {
        enabled: record.applied == KioskApplied::Enabled,
        phase: if record.last_error.is_some() {
            KioskPhase::Failed
        } else if record.applied == KioskApplied::NotApplied {
            KioskPhase::NotApplied
        } else {
            KioskPhase::Applied
        },
        error_code: record.last_error.clone(),
    }
}

/// Section 5.6, "Failure handling": the wait after the 1st, 2nd and later failures.
pub fn retry_delay(failures: u32) -> Duration {
    match failures {
        0 | 1 => Duration::from_secs(60),
        2 => Duration::from_secs(5 * 60),
        _ => Duration::from_secs(15 * 60),
    }
}

/// True when the machine or the state holds anything Disable would undo.
pub fn has_kiosk_changes(state: &AgentState) -> bool {
    state.kiosk.applied == KioskApplied::Enabled
        || !state.journal.is_empty()
        || state.kiosk.lsa_taken_over
        || state.kiosk.staff_hive.is_some()
}

// -- the synchronous layer ------------------------------------------------------------

/// Options of one `enable` run.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct EnableOptions {
    /// Section 5.10: `AutoAdminLogon` is wanted at `"0"` instead of `"1"`.
    pub exit_hold: bool,
    /// Section 5.6 step 7 at service start: test the stored password once, even
    /// when this run did not write it.
    pub verify_password: bool,
}

/// Section 5.6, `enable` and `disable`. Synchronous: run it in `spawn_blocking`.
///
/// The plan's struct held `&mut AgentState` and `&mut Secrets`; the code has
/// [`SharedState`], which saves after every change and is shared with the other
/// tasks, so that is what this holds.
pub struct Kiosk<'a> {
    pub platform: &'a dyn Platform,
    pub shared: &'a SharedState,
    pub config: &'a AgentConfig,
    pub install: &'a InstallPaths,
}

impl Kiosk<'_> {
    fn save(&self, change: impl FnOnce(&mut AgentState)) -> Result<(), KioskError> {
        self.shared.update(change).map_err(|error| KioskError::Persist(error.to_string()))
    }

    fn staff(&self) -> Option<StaffAccount> {
        self.shared.read(|state| state.staff.clone())
    }

    // -- Enable ------------------------------------------------------------------

    /// Section 5.6 "Enable": the steps in order, stopping at the first failure. The
    /// caller decides about the rollback (`enable_or_rollback`).
    pub fn enable(&mut self, opts: EnableOptions) -> Result<(), KioskError> {
        // 1. Blockers.
        self.check_blockers()?;
        // 2. The Staff account.
        let new_password = self.ensure_account()?;
        // 3. The profile.
        self.ensure_profile()?;
        // 4. Staff hive values.
        self.apply_staff_hive()?;
        // 5. Machine values, journaled.
        self.apply_machine_values(opts.exit_hold)?;
        // 6 and 7. The sign-in secret and the password check.
        self.install_password(new_password, opts.verify_password)?;
        // 8. Done.
        let already = self
            .shared
            .read(|state| state.kiosk.applied == KioskApplied::Enabled && state.kiosk.last_error.is_none() && state.kiosk.failures == 0);
        if already {
            return Ok(());
        }
        self.save(|state| {
            state.kiosk.applied = KioskApplied::Enabled;
            state.kiosk.last_error = None;
            state.kiosk.failures = 0;
        })
    }

    /// `enable`; when it fails, Disable runs at once so partial changes are rolled
    /// back, then `last_error` is set and `failures` counted (Section 5.6, "Failure
    /// handling").
    ///
    /// One deliberate difference from the plan's wording: a kiosk that is **already
    /// enabled** and fails a repair for a transient reason (a registry write
    /// refused) is left as it was and retried, instead of being rolled back and
    /// signing the employee out. A blocker, a conflicting account or a disabled
    /// account still roll it back.
    pub fn enable_or_rollback(&mut self, opts: EnableOptions) -> Result<(), KioskError> {
        let was_enabled = self.shared.read(|state| state.kiosk.applied == KioskApplied::Enabled);
        match self.enable(opts) {
            Ok(()) => Ok(()),
            Err(error) => {
                if !was_enabled || error.must_not_stay_enabled() {
                    if let Err(rollback) = self.disable() {
                        tracing::error!("the rollback after a failed kiosk enable also failed: {rollback}");
                    }
                }
                self.record_failure(&error);
                Err(error)
            }
        }
    }

    /// Sets `last_error` and counts one failure.
    pub fn record_failure(&self, error: &KioskError) {
        let code = error.code();
        let saved = self.save(|state| {
            state.kiosk.last_error = Some(code);
            state.kiosk.failures = state.kiosk.failures.saturating_add(1);
        });
        if let Err(save_error) = saved {
            tracing::error!("cannot save the kiosk failure: {save_error}");
        }
    }

    /// Step 1: `no_other_admin`, `legal_notice`, `managed_device`,
    /// `shell_binary_missing` (and the two OS blockers, which cannot change after
    /// enrollment but cost nothing to include).
    fn check_blockers(&self) -> Result<(), KioskError> {
        let (staff_sid, allow_joined) = self.shared.read(|state| {
            (
                state.staff.as_ref().map(|staff| staff.sid.clone()),
                state.enrollment.as_ref().is_some_and(|enrollment| enrollment.allow_joined),
            )
        });
        let report = compat::build(self.platform, staff_sid.as_deref(), allow_joined)?;
        match report.blockers.first() {
            Some(blocker) => Err(KioskError::Blocked(blocker.code().to_string())),
            None => Ok(()),
        }
    }

    /// Step 2. Returns the password when this run set one on the account (it is
    /// then held as the pending LSA secret until step 6 promotes it).
    fn ensure_account(&self) -> Result<Option<String>, KioskError> {
        let recorded = self.staff();
        let found = self.platform.find_local_user(STAFF_USER_NAME)?;
        match (recorded, found) {
            (Some(staff), Some(user)) if staff.sid == user.sid => {
                if user.disabled {
                    return Err(KioskError::StaffAccountDisabled);
                }
                Ok(None)
            }
            // The account exists, but it is not the one we recorded (or we recorded
            // none): ours only if it carries our comment, exactly.
            (_, Some(user)) => {
                if user.comment != STAFF_COMMENT {
                    return Err(KioskError::StaffAccountConflict);
                }
                if user.disabled {
                    return Err(KioskError::StaffAccountDisabled);
                }
                let password = generate_password()?;
                self.platform.lsa_secret_set(LSA_PENDING, Some(&password))?;
                self.platform.set_user_password(STAFF_USER_NAME, &password)?;
                self.record_staff(user.sid)?;
                Ok(Some(password))
            }
            (_, None) => {
                let password = generate_password()?;
                // The pending secret first: a crash after the account exists leaves
                // the password it was created with.
                self.platform.lsa_secret_set(LSA_PENDING, Some(&password))?;
                let spec = StaffUserSpec {
                    user_name: STAFF_USER_NAME.to_string(),
                    full_name: STAFF_FULL_NAME.to_string(),
                    comment: STAFF_COMMENT.to_string(),
                };
                let sid = self.platform.create_staff_user(&spec, &password)?;
                self.record_staff(sid)?;
                Ok(Some(password))
            }
        }
    }

    fn record_staff(&self, sid: String) -> Result<(), KioskError> {
        self.save(|state| {
            state.staff =
                Some(StaffAccount { sid, user_name: STAFF_USER_NAME.to_string(), profile_dir: None });
        })
    }

    /// Step 3: `ensure_profile` once; the real path is saved, never assumed.
    fn ensure_profile(&self) -> Result<(), KioskError> {
        let Some(staff) = self.staff() else {
            return Err(KioskError::Platform(PlatformError::Other("no Staff account is recorded".to_string())));
        };
        if staff.profile_dir.is_some() {
            return Ok(());
        }
        let path = self.platform.ensure_profile(&staff.sid, &staff.user_name)?;
        let text = path.to_string_lossy().into_owned();
        self.save(|state| {
            if let Some(staff) = state.staff.as_mut() {
                staff.profile_dir = Some(text);
            }
        })
    }

    /// The shell value written for the Staff account: the launcher, quoted.
    fn shell_command(&self) -> String {
        format!("\"{}\"", self.install.shell_exe().display())
    }

    /// Step 4. The seam has no read-back for the Staff hive, so a record in the
    /// state says what was written; it is marked incomplete before the first write.
    fn apply_staff_hive(&self) -> Result<(), KioskError> {
        let Some(staff) = self.staff() else {
            return Err(KioskError::Platform(PlatformError::Other("no Staff account is recorded".to_string())));
        };
        let mechanism = self.config.shell_mechanism;
        let command = self.shell_command();
        let fingerprint = format!("{}|{}|{}", staff.sid, mechanism.name(), command);
        let current = self.shared.read(|state| state.kiosk.staff_hive.clone());
        if current.as_ref().is_some_and(|record| record.complete && record.fingerprint == fingerprint) {
            return Ok(());
        }
        self.save(|state| {
            state.kiosk.staff_hive = Some(StaffHiveRecord { fingerprint: fingerprint.clone(), complete: false });
        })?;
        // One mechanism at a time: the other one's location is cleared.
        self.platform.set_staff_shell(&staff.sid, mechanism.other(), None)?;
        self.platform.set_staff_shell(&staff.sid, mechanism, Some(&command))?;
        // Nobody knows the Staff password, so a locked Staff session would be a dead end.
        self.platform.set_staff_user_policy(&staff.sid, DISABLE_LOCK_WORKSTATION, Some(1))?;
        self.save(|state| {
            state.kiosk.staff_hive = Some(StaffHiveRecord { fingerprint, complete: true });
        })
    }

    /// Step 5: each value is journaled the first time it is changed (the journal
    /// keeps the original once and never overwrites it), and the journal entry is
    /// saved before the value is written.
    fn apply_machine_values(&self, exit_hold: bool) -> Result<(), KioskError> {
        let computer_name = self.platform.computer_name()?;
        for (key, target) in wanted_machine_values(&computer_name, exit_hold) {
            let current = self.platform.read_machine_value(&key)?;
            // `AutoAdminLogon` is also written by the admin exit (`run_exit`, to "0"),
            // outside this function. Its original is therefore journaled even when it
            // already equals the target (an owner who used automatic sign-in), so a
            // Disable during an exit hold puts that original back.
            let always_journal = key.path == WINLOGON_KEY && key.name == AUTO_ADMIN_LOGON;
            if current == target && !always_journal {
                continue;
            }
            let journaled = self.shared.read(|state| state.journal.iter().any(|entry| entry.key == key));
            if journaled && current == target {
                continue;
            }
            if !journaled {
                let original = match &current {
                    None => OriginalValue::Absent,
                    Some(RegData::Dword(value)) => OriginalValue::Dword(*value),
                    // The owner's plaintext password goes to the secrets file, never
                    // into `agent-state.json`.
                    Some(RegData::String(text)) if is_plaintext_default_password(&key) => {
                        self.shared.update_secrets(|secrets| {
                            secrets.original_default_password_registry = Some(text.clone());
                        })?;
                        OriginalValue::InSecrets
                    }
                    Some(RegData::String(text)) => OriginalValue::String(text.clone()),
                };
                self.save(|state| state.journal.push(JournalEntry { key: key.clone(), original }))?;
            }
            if current != target {
                self.platform.write_machine_value(&key, target.as_ref())?;
            }
        }
        Ok(())
    }

    /// Steps 6 and 7. The sign-in secret is written when this run set a password, or
    /// when the account's password is not known to be in it; the password is then
    /// tested once (Edge case 12: never more than one test logon per repair).
    fn install_password(&mut self, new_password: Option<String>, verify: bool) -> Result<(), KioskError> {
        let mut tested = false;
        let mut wrote = false;
        let pending = self.platform.lsa_secret_get(LSA_PENDING)?;
        match (new_password, pending) {
            (Some(password), _) => {
                self.store_default_password(&password)?;
                self.platform.lsa_secret_set(LSA_PENDING, None)?;
                wrote = true;
            }
            // A password from a run that did not finish: promoted if it works,
            // otherwise one repair.
            (None, Some(pending)) => {
                tested = true;
                if self.platform.test_logon(STAFF_USER_NAME, &pending)? {
                    self.store_default_password(&pending)?;
                    self.platform.lsa_secret_set(LSA_PENDING, None)?;
                } else {
                    self.reset_password()?;
                }
            }
            (None, None) => {
                let have_secret = self.platform.lsa_secret_get(LSA_DEFAULT_PASSWORD)?.is_some();
                let ours = self.shared.read(|state| state.kiosk.lsa_taken_over);
                if !(have_secret && ours) {
                    self.reset_password()?;
                    wrote = true;
                }
            }
        }
        if !tested && (wrote || verify) {
            self.verify_password()?;
        }
        Ok(())
    }

    /// Writes the LSA `DefaultPassword`. The first time, the machine's original is
    /// kept in the secrets file and the take-over is recorded, in that order.
    fn store_default_password(&self, password: &str) -> Result<(), KioskError> {
        let taken = self.shared.read(|state| state.kiosk.lsa_taken_over);
        if !taken {
            if let Some(original) = self.platform.lsa_secret_get(LSA_DEFAULT_PASSWORD)? {
                self.shared
                    .update_secrets(|secrets| secrets.original_default_password_lsa = Some(original))?;
            }
            self.save(|state| state.kiosk.lsa_taken_over = true)?;
        }
        self.platform.lsa_secret_set(LSA_DEFAULT_PASSWORD, Some(password))?;
        Ok(())
    }

    /// A new password: pending secret, account, sign-in secret, in that order.
    fn reset_password(&self) -> Result<(), KioskError> {
        let password = generate_password()?;
        self.platform.lsa_secret_set(LSA_PENDING, Some(&password))?;
        self.platform.set_user_password(STAFF_USER_NAME, &password)?;
        self.store_default_password(&password)?;
        self.platform.lsa_secret_set(LSA_PENDING, None)?;
        Ok(())
    }

    /// Step 7: one `test_logon` with the stored password. A secret that is missing
    /// or does not work is repaired once (no second test).
    pub fn verify_password(&mut self) -> Result<(), KioskError> {
        match self.platform.lsa_secret_get(LSA_DEFAULT_PASSWORD)? {
            None => self.reset_password(),
            Some(password) => {
                if self.platform.test_logon(STAFF_USER_NAME, &password)? {
                    Ok(())
                } else {
                    tracing::warn!("the stored Staff password does not work; setting a new one");
                    self.reset_password()
                }
            }
        }
    }

    // -- Disable -----------------------------------------------------------------

    /// Section 5.6 "Disable" steps 1 to 3: restore the journaled machine values, the
    /// LSA secret and the Staff hive. Every part runs even if an earlier one failed;
    /// the errors are collected. What was restored is cleared from the journal.
    pub fn restore_machine(&mut self) -> Result<(), KioskError> {
        let mut errors: Vec<KioskError> = Vec::new();

        // 1. Machine values.
        let entries = self.shared.read(|state| state.journal.clone());
        for entry in entries {
            match self.restore_entry(&entry) {
                Ok(()) => {
                    let key = entry.key.clone();
                    if let Err(error) = self.save(|state| state.journal.retain(|e| e.key != key)) {
                        errors.push(error);
                    }
                }
                Err(error) => errors.push(error),
            }
        }
        let secret_still_needed = self
            .shared
            .read(|state| state.journal.iter().any(|entry| entry.original == OriginalValue::InSecrets));
        if !secret_still_needed {
            let kept = self.shared.secrets(|secrets| secrets.original_default_password_registry.is_some());
            if matches!(kept, Ok(true)) {
                if let Err(error) =
                    self.shared.update_secrets(|secrets| secrets.original_default_password_registry = None)
                {
                    errors.push(error.into());
                }
            }
        }

        // 2. The LSA secret: the original back, or gone. Untouched when it was
        //    never taken over, so a rollback cannot delete the owner's own.
        if self.shared.read(|state| state.kiosk.lsa_taken_over) {
            let original = self.shared.secrets(|secrets| secrets.original_default_password_lsa.clone());
            match original {
                Ok(original) => match self.platform.lsa_secret_set(LSA_DEFAULT_PASSWORD, original.as_deref()) {
                    Ok(()) => {
                        if let Err(error) = self
                            .shared
                            .update_secrets(|secrets| secrets.original_default_password_lsa = None)
                        {
                            errors.push(error.into());
                        }
                        if let Err(error) = self.save(|state| state.kiosk.lsa_taken_over = false) {
                            errors.push(error);
                        }
                    }
                    Err(error) => errors.push(error.into()),
                },
                Err(error) => errors.push(error.into()),
            }
        }
        match self.platform.lsa_secret_get(LSA_PENDING) {
            Ok(Some(_)) => {
                if let Err(error) = self.platform.lsa_secret_set(LSA_PENDING, None) {
                    errors.push(error.into());
                }
            }
            Ok(None) => {}
            Err(error) => errors.push(error.into()),
        }

        // 3. The Staff hive: both mechanisms' locations and the lock policy, so a
        //    Staff sign-in gets Explorer.
        let recorded = self.shared.read(|state| state.kiosk.staff_hive.is_some());
        if recorded {
            if let Some(staff) = self.staff() {
                match self.clear_staff_hive(&staff.sid) {
                    Ok(()) => {
                        if let Err(error) = self.save(|state| state.kiosk.staff_hive = None) {
                            errors.push(error);
                        }
                    }
                    Err(error) => errors.push(error.into()),
                }
            } else if let Err(error) = self.save(|state| state.kiosk.staff_hive = None) {
                errors.push(error);
            }
        }

        match errors.len() {
            0 => Ok(()),
            1 => Err(errors.remove(0)),
            _ => Err(KioskError::Multiple(errors)),
        }
    }

    fn clear_staff_hive(&self, sid: &str) -> Result<(), PlatformError> {
        let gone = |result: Result<(), PlatformError>| match result {
            // The account (and so its hive) is already gone.
            Err(PlatformError::NotFound) => Ok(()),
            other => other,
        };
        gone(self.platform.set_staff_shell(sid, ShellMechanism::PolicyShell, None))?;
        gone(self.platform.set_staff_shell(sid, ShellMechanism::WinlogonShell, None))?;
        gone(self.platform.set_staff_user_policy(sid, DISABLE_LOCK_WORKSTATION, None))
    }

    fn restore_entry(&self, entry: &JournalEntry) -> Result<(), KioskError> {
        let data = match &entry.original {
            OriginalValue::Absent => None,
            OriginalValue::Dword(value) => Some(RegData::Dword(*value)),
            OriginalValue::String(text) => Some(RegData::String(text.clone())),
            OriginalValue::InSecrets => {
                let kept = self.shared.secrets(|secrets| secrets.original_default_password_registry.clone())?;
                match kept {
                    Some(text) => Some(RegData::String(text)),
                    None => {
                        return Err(KioskError::Platform(PlatformError::Other(
                            "the original auto sign-in password is not in the secrets file".to_string(),
                        )));
                    }
                }
            }
        };
        self.platform.write_machine_value(&entry.key, data.as_ref())?;
        Ok(())
    }

    /// Step 5 of Disable: `applied = Disabled`. The error fields are the caller's.
    pub fn finish_disable(&mut self) -> Result<(), KioskError> {
        self.save(|state| state.kiosk.applied = KioskApplied::Disabled)
    }

    /// Clears `last_error` and `failures` (a deliberate Disable that went through).
    pub fn clear_error(&self) {
        if let Err(error) = self.save(|state| {
            state.kiosk.last_error = None;
            state.kiosk.failures = 0;
        }) {
            tracing::error!("cannot save the kiosk status: {error}");
        }
    }

    /// Restore, then mark Disabled when everything was restored. No session is
    /// touched: the sign-out of Disable step 4 has a 10-second grace and a broadcast,
    /// so the [`Reconciler`] does it, between the two.
    pub fn disable(&mut self) -> Result<(), KioskError> {
        self.restore_machine()?;
        self.finish_disable()
    }
}

// -- exit hold (plan Section 5.10) -----------------------------------------------------

/// Kept in memory only; `None` after an agent restart.
#[derive(Debug, Clone, Copy)]
pub struct ExitHold {
    pub started: Instant,
}

/// Section 5.10: true when the hold must end now. A session of a user other than
/// Staff is `Active` (the administrator signed in), or 5 minutes have passed.
pub fn hold_ended(hold: &ExitHold, now: Instant, sessions: &[SessionInfo], staff_sid: &str) -> bool {
    if now.saturating_duration_since(hold.started) >= EXIT_HOLD_MAX {
        return true;
    }
    sessions.iter().any(|session| {
        session.state == SessionState::Active
            && session.user_sid.as_deref().is_some_and(|sid| !sid.eq_ignore_ascii_case(staff_sid))
    })
}

// -- the task -------------------------------------------------------------------------

/// What wakes the reconciler (plan Section 5.2) and what is asked of it.
pub enum Trigger {
    /// Agent start: reconcile and test the stored password once.
    Startup,
    /// A new desired state was accepted.
    DesiredChanged,
    /// A session was created, ended or changed.
    Session,
    /// A session was locked; the Staff console is signed out 10 s later if it is
    /// still the active console session.
    SessionLocked { session_id: u32 },
    /// The PC resumed from sleep.
    Power,
    /// Every 10 minutes.
    Reassert,
    /// `Admin`: enrollment finished, reconcile now and answer with the status.
    ReconcileNow(oneshot::Sender<KioskStatus>),
    /// `Admin`: `unenroll` wants Disable (Section 5.6) and holds the kiosk off until
    /// the next document or reconcile request.
    Disable(oneshot::Sender<Result<(), String>>),
}

impl Trigger {
    fn name(&self) -> &'static str {
        match self {
            Trigger::Startup => "startup",
            Trigger::DesiredChanged => "desired state changed",
            Trigger::Session => "session",
            Trigger::SessionLocked { .. } => "session locked",
            Trigger::Power => "power",
            Trigger::Reassert => "reassert",
            Trigger::ReconcileNow(_) => "reconcile now",
            Trigger::Disable(_) => "disable",
        }
    }
}

/// What `agent::run` gives the reconciler.
pub struct ReconcilerDeps {
    pub platform: Arc<dyn Platform>,
    pub shared: Arc<SharedState>,
    pub snapshot: SnapshotHandle,
    pub session: Arc<SessionManager>,
    pub broadcast: ShellBroadcast,
    pub config: AgentConfig,
    pub install: InstallPaths,
    /// Simulate mode: the session list of `SimPlatform` is empty by construction, so
    /// the reconciler never clears the employee session by it, and the exit hold and
    /// the sign-out are only logged (as `run_exit` does).
    pub simulate: bool,
    /// The Staff SID, for the shell pipe's DACL (plan Section 5.2).
    pub staff_sid_tx: watch::Sender<Option<String>>,
    /// (Step 11) `<data>\state\recovered.flag`, written by `recover`. While the file
    /// exists nothing is enabled, repaired or disabled: the kiosk is held off until
    /// the next `enroll` (which deletes it) or until an administrator does.
    pub recovered_flag: PathBuf,
}

enum Action {
    Enable,
    Disable,
    Nothing,
}

pub struct Reconciler {
    d: ReconcilerDeps,
    hold: Option<ExitHold>,
    /// After `unenroll`'s Disable: no Session, Power or Reassert trigger re-enables
    /// the kiosk until a new document arrives or enrollment asks for a reconcile.
    held_off: bool,
    /// The service just started: the first enable tests the stored password.
    verify_pending: bool,
    retry_at: Option<Instant>,
    hold_check_at: Option<Instant>,
    lock_checks: Vec<(u32, Instant)>,
    /// The flag was seen present at the last reconcile (so it is logged once).
    recovered_logged: bool,
}

impl Reconciler {
    pub fn new(deps: ReconcilerDeps) -> Self {
        Self {
            d: deps,
            hold: None,
            held_off: false,
            verify_pending: true,
            retry_at: None,
            hold_check_at: None,
            lock_checks: Vec::new(),
            recovered_logged: false,
        }
    }

    /// True while `recovered.flag` exists. Looked at on every reconcile, so deleting
    /// the file by hand takes effect at the next trigger without a restart.
    fn recovered(&mut self) -> bool {
        let present = self.d.recovered_flag.exists();
        if present && !self.recovered_logged {
            tracing::info!(
                flag = %self.d.recovered_flag.display(),
                "recovered: the kiosk is held off until the next enroll or until this file is deleted"
            );
        }
        self.recovered_logged = present;
        present
    }

    /// `enroll` finished: the administrator wants the kiosk, so the flag goes.
    fn lift_recovered_flag(&mut self) {
        match crate::state::remove_file_if_exists(&self.d.recovered_flag) {
            Ok(()) => {
                if self.recovered_logged {
                    tracing::info!("enrollment: the recovered flag was removed");
                }
                self.recovered_logged = false;
            }
            Err(error) => tracing::error!("cannot remove the recovered flag: {error}"),
        }
    }

    /// The exit hold, for tests.
    #[cfg(test)]
    pub fn hold(&self) -> Option<ExitHold> {
        self.hold
    }

    #[cfg(test)]
    pub fn retry_at(&self) -> Option<Instant> {
        self.retry_at
    }

    /// The effective desired state (Section 5.6): the accepted document, or the
    /// enrollment default when none was received or cached.
    fn desired(&self) -> (bool, Option<u64>) {
        let snapshot = self.d.snapshot.current();
        match snapshot.desired_state {
            Some(desired) => (desired.kiosk_enabled, Some(snapshot.desired_state_version)),
            None => (DesiredState::enrollment_default().kiosk_enabled, None),
        }
    }

    fn set_hold(&mut self, hold: Option<ExitHold>) {
        self.hold_check_at = hold.map(|hold| hold.started + HOLD_TICK);
        self.hold = hold;
    }

    // -- triggers ----------------------------------------------------------------

    pub async fn on_trigger(&mut self, trigger: Trigger) {
        tracing::debug!(trigger = trigger.name(), "kiosk reconcile trigger");
        match trigger {
            Trigger::Disable(reply) => {
                let result = self.disable_command().await;
                let _ = reply.send(result);
            }
            Trigger::ReconcileNow(reply) => {
                self.held_off = false;
                self.lift_recovered_flag();
                self.housekeeping();
                let status = self.reconcile().await;
                let _ = reply.send(status);
            }
            Trigger::DesiredChanged => {
                self.held_off = false;
                self.housekeeping();
                self.reconcile().await;
            }
            Trigger::SessionLocked { session_id } => {
                self.housekeeping();
                self.note_lock(session_id);
            }
            Trigger::Startup | Trigger::Session | Trigger::Power | Trigger::Reassert => {
                self.housekeeping();
                if !self.held_off {
                    self.reconcile().await;
                }
            }
        }
    }

    /// Timers that fell due: the locked-session rule, the exit-hold tick and the
    /// retry after a failure.
    pub async fn on_timer(&mut self) {
        let now = Instant::now();
        let due: Vec<u32> = self.lock_checks.iter().filter(|(_, at)| *at <= now).map(|(id, _)| *id).collect();
        self.lock_checks.retain(|(_, at)| *at > now);
        for session_id in due {
            self.lock_check(session_id).await;
        }
        if self.hold_check_at.is_some_and(|at| at <= now) {
            self.hold_check_at = self.hold.map(|_| now + HOLD_TICK);
            let had_hold = self.hold.is_some();
            self.housekeeping();
            if had_hold && self.hold.is_none() && !self.held_off {
                self.reconcile().await;
            }
        }
        if self.retry_at.is_some_and(|at| at <= now) {
            self.retry_at = None;
            if !self.held_off {
                self.reconcile().await;
            }
        }
    }

    pub fn next_deadline(&self) -> Option<Instant> {
        self.lock_checks
            .iter()
            .map(|(_, at)| *at)
            .chain(self.retry_at)
            .chain(self.hold_check_at)
            .min()
    }

    // -- housekeeping: sessions and the hold --------------------------------------

    fn read_sessions(&self) -> Option<Vec<SessionInfo>> {
        match self.d.platform.sessions() {
            Ok(sessions) => Some(sessions),
            Err(error) => {
                tracing::warn!("cannot read the session list: {error}");
                None
            }
        }
    }

    /// Re-reads the session list. No `Active` or `Connected` session of the Staff
    /// account means the employee session is over; a set exit hold ends when
    /// `hold_ended` says so.
    fn housekeeping(&mut self) {
        let staff = self.d.shared.read(|state| state.staff.clone());
        if staff.is_none() && self.hold.is_none() {
            return;
        }
        let sessions = self.read_sessions();
        // A simulated agent cannot tell: `SimPlatform` has no sessions at all.
        if let (Some(staff), Some(sessions), false) = (&staff, &sessions, self.d.simulate) {
            let alive = sessions.iter().any(|session| {
                session.user_sid.as_deref().is_some_and(|sid| sid.eq_ignore_ascii_case(&staff.sid))
                    && matches!(session.state, SessionState::Active | SessionState::Connected)
            });
            if !alive {
                self.d.session.clear("staff session ended");
            }
        }
        if let Some(hold) = self.hold {
            let staff_sid = staff.map(|staff| staff.sid).unwrap_or_default();
            // Without a session list only the clock can end it.
            let ended = match &sessions {
                Some(sessions) => hold_ended(&hold, Instant::now(), sessions, &staff_sid),
                None => Instant::now().saturating_duration_since(hold.started) >= EXIT_HOLD_MAX,
            };
            if ended {
                tracing::info!("the exit hold ended; automatic sign-in is armed again");
                self.set_hold(None);
            }
        }
    }

    // -- the locked-session rule (Section 5.6) -------------------------------------

    fn note_lock(&mut self, session_id: u32) {
        let state = self.d.shared.get();
        if state.kiosk.applied != KioskApplied::Enabled {
            return;
        }
        let Some(staff) = state.staff else {
            return;
        };
        let is_staff = self.read_sessions().is_some_and(|sessions| {
            sessions.iter().any(|session| {
                session.id == session_id
                    && session.user_sid.as_deref().is_some_and(|sid| sid.eq_ignore_ascii_case(&staff.sid))
            })
        });
        if is_staff && !self.lock_checks.iter().any(|(id, _)| *id == session_id) {
            self.lock_checks.push((session_id, Instant::now() + LOCK_GRACE));
        }
    }

    /// 10 seconds after the lock: signed out when it is still the `Active` console
    /// session; a `Disconnected` one is left alone.
    async fn lock_check(&mut self, session_id: u32) {
        let state = self.d.shared.get();
        if state.kiosk.applied != KioskApplied::Enabled {
            return;
        }
        let Some(staff) = state.staff else {
            return;
        };
        let Some(sessions) = self.read_sessions() else {
            return;
        };
        let still_locked_console = sessions.iter().any(|session| {
            session.id == session_id
                && session.user_sid.as_deref().is_some_and(|sid| sid.eq_ignore_ascii_case(&staff.sid))
                && session.state == SessionState::Active
                && session.is_console
        });
        if !still_locked_console {
            return;
        }
        tracing::warn!(session_id, "the Staff console is still locked; signing it out so the shell returns");
        let platform = Arc::clone(&self.d.platform);
        match tokio::task::spawn_blocking(move || platform.logoff_session(session_id)).await {
            Ok(Ok(())) => {}
            Ok(Err(error)) => tracing::error!(session_id, "cannot sign the locked session out: {error}"),
            Err(_) => tracing::error!(session_id, "the sign-out task failed"),
        }
    }

    // -- the admin exit (Section 5.10) ----------------------------------------------

    /// A correct PIN: signs the caller's session out through `run_exit` and keeps
    /// automatic sign-in off (the hold) until `hold_ended`. No kiosk change runs at
    /// the same time because this is the reconciler's own loop.
    pub async fn on_exit(&mut self, request: ExitRequest) {
        let kiosk_enabled = self.d.shared.read(|state| state.kiosk.applied == KioskApplied::Enabled);
        let result = run_exit(
            Arc::clone(&self.d.platform),
            kiosk_enabled,
            self.d.simulate,
            request,
            self.d.broadcast.clone(),
        )
        .await;
        match result {
            Ok(()) => {
                // `run_exit` also returns Ok when it wrote nothing (the request was
                // withdrawn). The hold exists only if `AutoAdminLogon` really is "0".
                let is_off = kiosk_enabled && !self.d.simulate && {
                    let key = winlogon(AUTO_ADMIN_LOGON);
                    matches!(
                        self.d.platform.read_machine_value(&key),
                        Ok(Some(RegData::String(ref text))) if text == "0"
                    )
                };
                if is_off {
                    self.set_hold(Some(ExitHold { started: Instant::now() }));
                    tracing::info!("exit hold set: automatic sign-in stays off for at most 5 minutes");
                }
            }
            Err(error) => {
                tracing::error!("the admin exit did not complete ({error}); automatic sign-in is armed again");
                self.set_hold(None);
                if !self.held_off {
                    self.reconcile().await;
                }
            }
        }
    }

    // -- reconcile ---------------------------------------------------------------------

    async fn reconcile(&mut self) -> KioskStatus {
        let state = self.d.shared.get();
        let Some(enrollment) = state.enrollment.clone() else {
            // Not enrolled: nothing to do.
            return self.d.snapshot.current().kiosk;
        };
        if self.recovered() {
            // `recover` put the machine back and asked for it to stay that way.
            self.after_reconcile();
            return kiosk_status(&self.d.shared.read(|state| state.kiosk.clone()));
        }
        let applied = state.kiosk.applied;
        let (desired_on, version) = self.desired();
        let action = if enrollment.revoked {
            // Q11: a revoked PC stays as it is. Drift is still repaired; never undone.
            if applied == KioskApplied::Enabled { Action::Enable } else { Action::Nothing }
        } else if self.held_off {
            Action::Nothing
        } else if desired_on {
            Action::Enable
        } else if self.needs_disable(&state) {
            Action::Disable
        } else {
            Action::Nothing
        };
        let version = if enrollment.revoked { None } else { version };
        match action {
            Action::Enable => self.run_enable(applied, version).await,
            Action::Disable => self.run_disable(applied == KioskApplied::Enabled, version).await,
            Action::Nothing => {}
        }
        self.after_reconcile();
        kiosk_status(&self.d.shared.read(|state| state.kiosk.clone()))
    }

    fn needs_disable(&self, state: &AgentState) -> bool {
        has_kiosk_changes(state) || matches!(self.d.platform.lsa_secret_get(LSA_PENDING), Ok(Some(_)))
    }

    fn publish_status(&self) {
        let record = self.d.shared.read(|state| state.kiosk.clone());
        let status = kiosk_status(&record);
        self.d.snapshot.update(|snapshot| snapshot.kiosk = status);
    }

    fn publish_applying(&self) {
        self.d.snapshot.update(|snapshot| snapshot.kiosk.phase = KioskPhase::Applying);
    }

    /// Writes `last_applied_version` (the highest desired-state version applied) and
    /// forgets the retry.
    fn note_success(&mut self, version: Option<u64>) {
        self.retry_at = None;
        if let Some(version) = version {
            if self.d.shared.read(|state| state.last_applied_version) < version {
                if let Err(error) =
                    self.d.shared.update(|state| state.last_applied_version = version)
                {
                    tracing::error!("cannot save the applied version: {error}");
                }
            }
        }
    }

    fn note_failure(&mut self) {
        let failures = self.d.shared.read(|state| state.kiosk.failures);
        let delay = retry_delay(failures);
        tracing::warn!(failures, "the kiosk change failed; trying again in {} s", delay.as_secs());
        self.retry_at = Some(Instant::now() + delay);
    }

    /// The Staff SID for the shell pipe, and the employee files base from the saved
    /// profile (Disable does not clear it).
    fn after_reconcile(&self) {
        let staff = self.d.shared.read(|state| state.staff.clone());
        let sid = staff.as_ref().map(|staff| staff.sid.clone());
        self.d.staff_sid_tx.send_if_modified(|current| {
            if *current == sid {
                false
            } else {
                *current = sid;
                true
            }
        });
        if let Some(profile) = staff.and_then(|staff| staff.profile_dir) {
            self.d.session.set_files_base(Some(PathBuf::from(profile).join(FILES_BASE_DIR)));
        }
    }

    fn join_failure(&self, error: tokio::task::JoinError) -> KioskError {
        tracing::error!("the kiosk task failed: {error}");
        KioskError::Platform(PlatformError::Other("the kiosk task failed".to_string()))
    }

    async fn run_enable(&mut self, was_applied: KioskApplied, version: Option<u64>) {
        if was_applied != KioskApplied::Enabled {
            self.publish_applying();
        }
        let opts = EnableOptions {
            exit_hold: self.hold.is_some(),
            verify_password: std::mem::take(&mut self.verify_pending),
        };
        let platform = Arc::clone(&self.d.platform);
        let shared = Arc::clone(&self.d.shared);
        let config = self.d.config.clone();
        let install = self.d.install.clone();
        let result = tokio::task::spawn_blocking(move || {
            let mut kiosk =
                Kiosk { platform: platform.as_ref(), shared: shared.as_ref(), config: &config, install: &install };
            kiosk.enable_or_rollback(opts)
        })
        .await;
        match result {
            Ok(Ok(())) => {
                if was_applied != KioskApplied::Enabled {
                    tracing::info!("the kiosk is on: it takes effect at the next sign-out or restart");
                }
                self.note_success(version);
            }
            Ok(Err(error)) => {
                // `enable_or_rollback` already recorded it.
                tracing::error!(code = %error.code(), "the kiosk could not be enabled: {error}");
                self.note_failure();
            }
            Err(error) => {
                let error = self.join_failure(error);
                self.record_failure(&error);
                self.note_failure();
            }
        }
        self.publish_status();
    }

    async fn run_disable(&mut self, sign_out: bool, version: Option<u64>) {
        self.publish_applying();
        match self.disable_flow(sign_out).await {
            Ok(()) => {
                tracing::info!("the kiosk is off: the PC is back to normal Windows");
                self.set_hold(None);
                self.note_success(version);
            }
            Err(error) => {
                tracing::error!(code = %error.code(), "the kiosk could not be disabled: {error}");
                self.record_failure(&error);
                self.note_failure();
            }
        }
        self.publish_status();
    }

    fn record_failure(&self, error: &KioskError) {
        let code = error.code();
        let saved = self.d.shared.update(|state| {
            state.kiosk.last_error = Some(code);
            state.kiosk.failures = state.kiosk.failures.saturating_add(1);
        });
        if let Err(save_error) = saved {
            tracing::error!("cannot save the kiosk failure: {save_error}");
        }
    }

    /// Section 5.6 "Disable". The order matters: automatic sign-in and the shell are
    /// undone **before** the Staff session is signed out, or Windows would sign the
    /// account straight back in to the kiosk.
    async fn disable_flow(&mut self, sign_out: bool) -> Result<(), KioskError> {
        let platform = Arc::clone(&self.d.platform);
        let shared = Arc::clone(&self.d.shared);
        let config = self.d.config.clone();
        let install = self.d.install.clone();
        let restored = tokio::task::spawn_blocking(move || {
            let mut kiosk =
                Kiosk { platform: platform.as_ref(), shared: shared.as_ref(), config: &config, install: &install };
            kiosk.restore_machine()
        })
        .await
        .map_err(|error| self.join_failure(error))?;

        let mut errors: Vec<KioskError> = Vec::new();
        let machine_restored = restored.is_ok();
        if let Err(error) = restored {
            errors.push(error);
        }
        // 4. The Staff session ends (after its grace), whatever happened above.
        if sign_out {
            if let Err(error) = self.sign_out_staff().await {
                errors.push(error);
            }
        }
        // 5. Marked Disabled once the machine is back; the account and its files stay.
        if machine_restored {
            let mut kiosk = Kiosk {
                platform: self.d.platform.as_ref(),
                shared: self.d.shared.as_ref(),
                config: &self.d.config,
                install: &self.d.install,
            };
            match kiosk.finish_disable() {
                Ok(()) => {
                    if errors.is_empty() {
                        kiosk.clear_error();
                    }
                }
                Err(error) => errors.push(error),
            }
        }
        match errors.len() {
            0 => Ok(()),
            1 => Err(errors.remove(0)),
            _ => Err(KioskError::Multiple(errors)),
        }
    }

    fn staff_sessions(&self, staff_sid: &str) -> Result<Vec<SessionInfo>, KioskError> {
        let sessions = self.d.platform.sessions()?;
        Ok(sessions
            .into_iter()
            .filter(|session| session.user_sid.as_deref().is_some_and(|sid| sid.eq_ignore_ascii_case(staff_sid)))
            .collect())
    }

    /// Disable step 4: tells the Staff App, waits 10 seconds, signs the Staff
    /// session(s) out.
    async fn sign_out_staff(&mut self) -> Result<(), KioskError> {
        let Some(staff) = self.d.shared.read(|state| state.staff.clone()) else {
            return Ok(());
        };
        if self.staff_sessions(&staff.sid)?.is_empty() {
            return Ok(());
        }
        let grace_ms = u64::try_from(DISABLE_GRACE.as_millis()).unwrap_or(u64::MAX);
        self.d.broadcast.shutting_down(ShutdownReason::KioskDisabled, grace_ms);
        tokio::time::sleep(DISABLE_GRACE).await;
        // The session may have ended by itself during the wait.
        let mut errors: Vec<KioskError> = Vec::new();
        for session in self.staff_sessions(&staff.sid)? {
            let platform = Arc::clone(&self.d.platform);
            let id = session.id;
            match tokio::task::spawn_blocking(move || platform.logoff_session(id)).await {
                Ok(Ok(())) | Ok(Err(PlatformError::NotFound)) => {}
                Ok(Err(error)) => errors.push(error.into()),
                Err(error) => errors.push(self.join_failure(error)),
            }
        }
        match errors.len() {
            0 => Ok(()),
            1 => Err(errors.remove(0)),
            _ => Err(KioskError::Multiple(errors)),
        }
    }

    /// `KioskControl::disable` (for `unenroll`): Disable now, then hold the kiosk off.
    async fn disable_command(&mut self) -> Result<(), String> {
        let state = self.d.shared.get();
        if !self.needs_disable(&state) {
            self.held_off = true;
            return Ok(());
        }
        let sign_out = state.kiosk.applied == KioskApplied::Enabled;
        self.publish_applying();
        let result = self.disable_flow(sign_out).await;
        let outcome = match result {
            Ok(()) => {
                tracing::info!("the kiosk is off (unenroll); it stays off until a new document or enrollment");
                self.held_off = true;
                self.retry_at = None;
                self.set_hold(None);
                Ok(())
            }
            Err(error) => {
                tracing::error!(code = %error.code(), "the kiosk could not be disabled: {error}");
                self.record_failure(&error);
                Err(error.to_string())
            }
        };
        self.publish_status();
        self.after_reconcile();
        outcome
    }

    // -- the loop ----------------------------------------------------------------------

    /// Runs until `shutdown`. Triggers, exit requests, the 10-minute reassert and the
    /// timers are all handled here, one at a time.
    pub async fn run(
        mut self,
        mut triggers: mpsc::UnboundedReceiver<Trigger>,
        mut exits: mpsc::Receiver<ExitRequest>,
        shutdown: CancellationToken,
    ) {
        let mut reassert = tokio::time::interval_at(Instant::now() + REASSERT_INTERVAL, REASSERT_INTERVAL);
        reassert.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut exits_open = true;
        loop {
            let deadline = self.next_deadline();
            let timer = async {
                match deadline {
                    Some(at) => tokio::time::sleep_until(at).await,
                    None => std::future::pending::<()>().await,
                }
            };
            tokio::select! {
                () = shutdown.cancelled() => break,
                trigger = triggers.recv() => match trigger {
                    Some(trigger) => {
                        tokio::select! {
                            () = shutdown.cancelled() => break,
                            () = self.on_trigger(trigger) => {}
                        }
                    }
                    None => break,
                },
                request = exits.recv(), if exits_open => match request {
                    Some(request) => {
                        tokio::select! {
                            () = shutdown.cancelled() => break,
                            () = self.on_exit(request) => {}
                        }
                    }
                    None => exits_open = false,
                },
                _ = reassert.tick() => {
                    tokio::select! {
                        () = shutdown.cancelled() => break,
                        () = self.on_trigger(Trigger::Reassert) => {}
                    }
                }
                () = timer => {
                    tokio::select! {
                        () = shutdown.cancelled() => break,
                        () = self.on_timer() => {}
                    }
                }
            }
        }
    }
}

// -- the handle the rest of the agent uses -----------------------------------------------

/// The real [`KioskControl`], and the way the service host feeds session and power
/// events to the reconciler.
#[derive(Clone)]
pub struct ReconcilerHandle {
    tx: mpsc::UnboundedSender<Trigger>,
    snapshot: SnapshotHandle,
}

impl ReconcilerHandle {
    fn send(&self, trigger: Trigger) -> bool {
        self.tx.send(trigger).is_ok()
    }

    pub fn session_changed(&self) {
        self.send(Trigger::Session);
    }

    pub fn session_locked(&self, session_id: u32) {
        self.send(Trigger::SessionLocked { session_id });
    }

    pub fn power_resumed(&self) {
        self.send(Trigger::Power);
    }
}

impl KioskControl for ReconcilerHandle {
    fn desired_changed(&self) {
        self.send(Trigger::DesiredChanged);
    }

    fn reconcile_now(&self) -> BoxFuture<'static, KioskStatus> {
        let (reply, answer) = oneshot::channel();
        let snapshot = self.snapshot.clone();
        if !self.send(Trigger::ReconcileNow(reply)) {
            return std::future::ready(snapshot.current().kiosk).boxed();
        }
        async move {
            match answer.await {
                Ok(status) => status,
                Err(_) => snapshot.current().kiosk,
            }
        }
        .boxed()
    }

    fn disable(&self) -> BoxFuture<'static, Result<(), String>> {
        let (reply, answer) = oneshot::channel();
        if !self.send(Trigger::Disable(reply)) {
            return std::future::ready(Err("the kiosk reconciler is not running".to_string())).boxed();
        }
        async move {
            match answer.await {
                Ok(result) => result,
                Err(_) => Err("the kiosk reconciler stopped before it answered".to_string()),
            }
        }
        .boxed()
    }
}

/// Starts the reconciler task. The first trigger is `Startup`.
pub fn spawn_reconciler(
    deps: ReconcilerDeps,
    exits: mpsc::Receiver<ExitRequest>,
    shutdown: CancellationToken,
    tasks: &TaskTracker,
) -> ReconcilerHandle {
    let (tx, rx) = mpsc::unbounded_channel();
    let handle = ReconcilerHandle { tx, snapshot: deps.snapshot.clone() };
    handle.send(Trigger::Startup);
    let reconciler = Reconciler::new(deps);
    tasks.spawn(reconciler.run(rx, exits, shutdown));
    handle
}

#[cfg(test)]
mod tests;
