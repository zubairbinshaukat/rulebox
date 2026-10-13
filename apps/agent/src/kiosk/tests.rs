//! Tests of the kiosk reconciler (plan Step 9, unit tests 1 to 19), all against
//! `SimPlatform`. Nothing here touches the machine the tests run on.

use super::*;

use std::collections::HashMap;
use std::sync::Mutex;

use rulebox_ipc::methods::{Method, SessionSignIn};
use rulebox_ipc::types::{ClientRole, ConnectionStatus, EnrollmentStatus};
use rulebox_ipc::Frame;
use serde_json::json;

use crate::audit::{AuditHandle, AuditQueue};
use crate::directory::FixtureDirectory;
use crate::employee_cache::EmployeeCache;
use crate::ipc_conn::PeerCtx;
use crate::ipc_shell::ShellExtension;
use crate::lockout::LockoutStore;
use crate::platform::sim::{SimOp, SimPlatform};
use crate::session::{SessionDeps, SessionTimeouts};
use crate::state::{Enrollment, StateStore};
use crate::testutil::{test_snapshot, TempDir};

const OWNER_PLAIN: &str = "owner-plaintext-pw";
const OWNER_LSA: &str = "owner-lsa-pw";
const ADMIN_SID: &str = "S-1-5-21-9-9-9-500";

type Machine = (
    HashMap<RegValueRef, RegData>,
    HashMap<String, String>,
    HashMap<String, (ShellMechanism, Option<String>)>,
    HashMap<(String, String), u32>,
);

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

struct Rig {
    dir: TempDir,
    platform: Arc<SimPlatform>,
    shared: Arc<SharedState>,
    config: AgentConfig,
    install: InstallPaths,
}

impl Rig {
    fn new() -> Self {
        Self::with_state(enrolled_state())
    }

    fn with_state(state: AgentState) -> Self {
        let dir = TempDir::new();
        let platform = Arc::new(SimPlatform::new(dir.path().to_path_buf()));
        let dyn_platform: Arc<dyn Platform> = platform.clone();
        let store = StateStore::open(&dir.path().join("state")).unwrap();
        let shared = SharedState::new(store, state, dyn_platform);
        let install = InstallPaths::new(dir.path().join("install"));
        Self { dir, platform, shared, config: AgentConfig::default(), install }
    }

    fn kiosk(&self) -> Kiosk<'_> {
        Kiosk {
            platform: self.platform.as_ref(),
            shared: self.shared.as_ref(),
            config: &self.config,
            install: &self.install,
        }
    }

    /// A new `SharedState` over the same files: what a restarted agent sees.
    fn restarted(&self) -> Arc<SharedState> {
        let store = StateStore::open(&self.dir.path().join("state")).unwrap();
        let state = store.load().unwrap();
        let platform: Arc<dyn Platform> = self.platform.clone();
        SharedState::new(store, state, platform)
    }

    fn machine(&self) -> Machine {
        self.platform.with_world(|w| {
            (w.machine_values.clone(), w.lsa_secrets.clone(), w.staff_shell.clone(), w.staff_policies.clone())
        })
    }

    fn key(path: &str, name: &str) -> RegValueRef {
        RegValueRef { path: path.to_string(), name: name.to_string() }
    }

    fn value(&self, path: &str, name: &str) -> Option<RegData> {
        self.platform.with_world(|w| w.machine_values.get(&Self::key(path, name)).cloned())
    }

    fn winlogon(&self, name: &str) -> Option<RegData> {
        self.value(WINLOGON_KEY, name)
    }

    fn set(&self, path: &str, name: &str, data: RegData) {
        self.platform.with_world(|w| {
            w.machine_values.insert(Self::key(path, name), data);
        });
    }

    fn text(value: &str) -> RegData {
        RegData::String(value.to_string())
    }

    fn lsa(&self, name: &str) -> Option<String> {
        self.platform.with_world(|w| w.lsa_secrets.get(name).cloned())
    }

    /// The machine belongs to an owner who already used automatic sign-in, plus a
    /// few of the other values the kiosk sets and the ones it must never touch.
    fn owner_autologon(&self) {
        self.set(WINLOGON_KEY, "AutoAdminLogon", Self::text("1"));
        self.set(WINLOGON_KEY, "DefaultUserName", Self::text("Owner"));
        self.set(WINLOGON_KEY, "DefaultDomainName", Self::text("OWNERPC"));
        self.set(WINLOGON_KEY, "DefaultPassword", Self::text(OWNER_PLAIN));
        self.set(WINLOGON_KEY, "AutoLogonCount", RegData::Dword(3));
        self.set(SYSTEM_POLICIES_KEY, "EnableFirstLogonAnimation", RegData::Dword(1));
        // Never touched by the agent.
        self.set(WINLOGON_KEY, "Shell", Self::text("explorer.exe"));
        self.set(WINLOGON_KEY, "Userinit", Self::text(r"C:\Windows\system32\userinit.exe,"));
        self.set(WINLOGON_KEY, "IgnoreShiftOverride", Self::text("0"));
        self.platform.with_world(|w| {
            w.lsa_secrets.insert(LSA_DEFAULT_PASSWORD.to_string(), OWNER_LSA.to_string());
        });
    }

    fn staff_sid(&self) -> String {
        self.shared.read(|s| s.staff.as_ref().map(|staff| staff.sid.clone())).expect("a Staff account")
    }

    fn staff_password(&self) -> String {
        self.platform.with_world(|w| w.users[STAFF_USER_NAME].password.clone())
    }

    fn set_staff_password(&self, password: &str) {
        self.platform.with_world(|w| w.users.get_mut(STAFF_USER_NAME).unwrap().password = password.into());
    }

    fn all_calls(&self) -> Vec<SimOp> {
        self.platform.calls()
    }

    fn count(&self, op: SimOp) -> usize {
        self.all_calls().iter().filter(|called| **called == op).count()
    }

    fn mutating_since(&self, before: usize) -> Vec<SimOp> {
        self.all_calls()[before..].iter().copied().filter(|op| op.is_mutating()).collect()
    }
}

fn enable(rig: &Rig) -> Result<(), KioskError> {
    rig.kiosk().enable(EnableOptions::default())
}

fn owner(rig: &Rig) {
    rig.owner_autologon();
}

/// The mutating calls a clean enable makes, each with how many calls of the same
/// operation came before it (what `fail_nth` needs).
fn mutating_sequence(setup: fn(&Rig)) -> Vec<(SimOp, usize)> {
    let rig = Rig::new();
    setup(&rig);
    let before = rig.all_calls().len();
    enable(&rig).unwrap();
    let mut seen: HashMap<SimOp, usize> = HashMap::new();
    rig.mutating_since(before)
        .into_iter()
        .map(|op| {
            let counter = seen.entry(op).or_insert(0);
            let skip = *counter;
            *counter += 1;
            (op, skip)
        })
        .collect()
}

fn injected() -> PlatformError {
    PlatformError::Other("injected".into())
}

// -- generate_password (test 14) ----------------------------------------------------

#[test]
fn generated_passwords_are_32_characters_with_all_four_classes() {
    let mut seen = std::collections::HashSet::new();
    for _ in 0..1000 {
        let password = generate_password().unwrap();
        assert_eq!(password.chars().count(), PASSWORD_LEN);
        assert!(password.bytes().any(|b| UPPER.contains(&b)), "{password}");
        assert!(password.bytes().any(|b| LOWER.contains(&b)), "{password}");
        assert!(password.bytes().any(|b| DIGITS.contains(&b)), "{password}");
        assert!(password.bytes().any(|b| SYMBOLS.contains(&b)), "{password}");
        assert!(password.bytes().all(|b| [UPPER, LOWER, DIGITS, SYMBOLS].iter().any(|c| c.contains(&b))));
        seen.insert(password);
    }
    assert_eq!(seen.len(), 1000, "every password is different");
}

// -- enable (tests 1 and 2) -----------------------------------------------------------

#[test]
fn a_fresh_machine_gets_the_account_the_values_and_the_secret() {
    let rig = Rig::new();
    enable(&rig).unwrap();

    let comment = rig.platform.with_world(|w| w.users[STAFF_USER_NAME].comment.clone());
    assert_eq!(comment, STAFF_COMMENT);
    let password = rig.staff_password();
    let state = rig.shared.get();
    let staff = state.staff.clone().unwrap();
    assert_eq!(staff.user_name, STAFF_USER_NAME);
    // The real profile path is saved, never assumed.
    let profile = rig.dir.path().join("sim-profiles").join(STAFF_USER_NAME);
    assert_eq!(staff.profile_dir.as_deref(), Some(profile.to_str().unwrap()));

    // Hive values.
    let command = format!("\"{}\"", rig.install.shell_exe().display());
    rig.platform.with_world(|w| {
        assert_eq!(w.staff_shell[&staff.sid], (ShellMechanism::PolicyShell, Some(command.clone())));
        assert_eq!(w.staff_policies[&(staff.sid.clone(), "DisableLockWorkstation".to_string())], 1);
    });

    // The eight machine values.
    assert_eq!(rig.winlogon("AutoAdminLogon"), Some(Rig::text("1")));
    assert_eq!(rig.winlogon("DefaultUserName"), Some(Rig::text("RuleboxStaff")));
    assert_eq!(rig.winlogon("DefaultDomainName"), Some(Rig::text("SIM-PC")));
    assert_eq!(rig.winlogon("DefaultPassword"), None);
    assert_eq!(rig.winlogon("AutoLogonCount"), None);
    assert_eq!(rig.value(SYSTEM_POLICIES_KEY, "DisableAutomaticRestartSignOn"), Some(RegData::Dword(1)));
    assert_eq!(rig.value(SYSTEM_POLICIES_KEY, "EnableFirstLogonAnimation"), Some(RegData::Dword(0)));
    assert_eq!(rig.value(OOBE_POLICY_KEY, "DisablePrivacyExperience"), Some(RegData::Dword(1)));

    // The LSA secret is the account's password; the pending one is gone.
    assert_eq!(rig.lsa(LSA_DEFAULT_PASSWORD), Some(password.clone()));
    assert_eq!(rig.lsa(LSA_PENDING), None);
    assert_eq!(password.len(), PASSWORD_LEN);

    // One journal entry per value that was changed (the two deletions of values that
    // were not there change nothing), each with its original.
    let names: Vec<&str> = state.journal.iter().map(|entry| entry.key.name.as_str()).collect();
    assert_eq!(
        names,
        [
            "AutoAdminLogon",
            "DefaultUserName",
            "DefaultDomainName",
            "DisableAutomaticRestartSignOn",
            "EnableFirstLogonAnimation",
            "DisablePrivacyExperience"
        ]
    );
    assert!(state.journal.iter().all(|entry| entry.original == OriginalValue::Absent));
    assert_eq!(state.kiosk.applied, KioskApplied::Enabled);
    assert_eq!((state.kiosk.last_error, state.kiosk.failures), (None, 0));
    assert!(state.kiosk.lsa_taken_over);
    // One password check after the secret was written.
    assert_eq!(rig.count(SimOp::TestLogon), 1);
}

#[test]
fn the_second_enable_makes_no_mutating_call() {
    let rig = Rig::new();
    rig.owner_autologon();
    enable(&rig).unwrap();
    let before = rig.all_calls().len();
    let state_before = rig.shared.get();
    enable(&rig).unwrap();
    assert_eq!(rig.mutating_since(before), Vec::<SimOp>::new());
    assert_eq!(rig.shared.get(), state_before);
    // Not even the password check: that is for service start.
    assert_eq!(rig.count(SimOp::TestLogon), 1);
}

#[test]
fn the_machine_wide_shell_values_are_never_written() {
    let rig = Rig::new();
    rig.owner_autologon();
    enable(&rig).unwrap();
    assert_eq!(rig.winlogon("Shell"), Some(Rig::text("explorer.exe")));
    assert_eq!(rig.winlogon("Userinit"), Some(Rig::text(r"C:\Windows\system32\userinit.exe,")));
    assert_eq!(rig.winlogon("IgnoreShiftOverride"), Some(Rig::text("0")));
    // `AutoLogonCount` is only ever deleted.
    assert_eq!(rig.winlogon("AutoLogonCount"), None);
    rig.kiosk().disable().unwrap();
    assert_eq!(rig.winlogon("Shell"), Some(Rig::text("explorer.exe")));
    assert_eq!(rig.winlogon("Userinit"), Some(Rig::text(r"C:\Windows\system32\userinit.exe,")));
}

#[test]
fn the_other_shell_mechanism_is_used_when_configured() {
    let mut rig = Rig::new();
    rig.config.shell_mechanism = ShellMechanism::WinlogonShell;
    enable(&rig).unwrap();
    let sid = rig.staff_sid();
    let shell = rig.platform.with_world(|w| w.staff_shell.get(&sid).cloned());
    assert_eq!(shell.map(|(mechanism, _)| mechanism), Some(ShellMechanism::WinlogonShell));
    let record = rig.shared.get().kiosk.staff_hive.unwrap();
    assert!(record.complete && record.fingerprint.contains("winlogonShell"));
}

// -- enable then disable (tests 3 and 4) ----------------------------------------------

#[test]
fn disable_puts_every_value_back_and_keeps_the_account() {
    let rig = Rig::new();
    // A machine with some of the values present, some absent.
    rig.set(WINLOGON_KEY, "DefaultDomainName", Rig::text("WORKGROUPX"));
    rig.set(WINLOGON_KEY, "AutoLogonCount", RegData::Dword(3));
    rig.set(SYSTEM_POLICIES_KEY, "EnableFirstLogonAnimation", RegData::Dword(1));
    let start = rig.machine();

    enable(&rig).unwrap();
    assert_ne!(rig.machine(), start);
    rig.kiosk().disable().unwrap();

    assert_eq!(rig.machine(), start);
    assert!(rig.platform.find_local_user(STAFF_USER_NAME).unwrap().is_some(), "the account stays");
    let state = rig.shared.get();
    assert!(state.journal.is_empty());
    assert_eq!(state.kiosk.applied, KioskApplied::Disabled);
    assert!(!state.kiosk.lsa_taken_over);
    assert_eq!(state.kiosk.staff_hive, None);
    assert!(state.staff.is_some(), "the account record stays");
    // Enable and disable again: the same.
    enable(&rig).unwrap();
    rig.kiosk().disable().unwrap();
    assert_eq!(rig.machine(), start);
}

#[test]
fn an_owners_own_auto_sign_in_comes_back_exactly_and_the_password_never_reaches_the_state_file() {
    let rig = Rig::new();
    rig.owner_autologon();
    let start = rig.machine();

    enable(&rig).unwrap();
    // While the kiosk is on: the plaintext value is gone, the LSA secret is ours, and
    // the owner's originals are only in the secrets file.
    assert_eq!(rig.winlogon("DefaultPassword"), None);
    assert_ne!(rig.lsa(LSA_DEFAULT_PASSWORD), Some(OWNER_LSA.to_string()));
    let (registry, lsa) = rig
        .shared
        .secrets(|s| (s.original_default_password_registry.clone(), s.original_default_password_lsa.clone()))
        .unwrap();
    assert_eq!((registry.as_deref(), lsa.as_deref()), (Some(OWNER_PLAIN), Some(OWNER_LSA)));
    let state = rig.shared.get();
    assert!(state
        .journal
        .iter()
        .any(|entry| entry.key.name == "DefaultPassword" && entry.original == OriginalValue::InSecrets));
    for text in [
        serde_json::to_string(&state).unwrap(),
        std::fs::read_to_string(rig.dir.path().join("state").join("agent-state.json")).unwrap(),
    ] {
        assert!(!text.contains(OWNER_PLAIN) && !text.contains(OWNER_LSA), "{text}");
        assert!(!text.contains(&rig.staff_password()), "the Staff password is not in the state either");
    }

    rig.kiosk().disable().unwrap();
    assert_eq!(rig.machine(), start);
    assert_eq!(rig.winlogon("AutoAdminLogon"), Some(Rig::text("1")));
    assert_eq!(rig.winlogon("DefaultUserName"), Some(Rig::text("Owner")));
    assert_eq!(rig.winlogon("DefaultPassword"), Some(Rig::text(OWNER_PLAIN)));
    assert_eq!(rig.lsa(LSA_DEFAULT_PASSWORD), Some(OWNER_LSA.to_string()));
    let kept = rig
        .shared
        .secrets(|s| (s.original_default_password_registry.clone(), s.original_default_password_lsa.clone()))
        .unwrap();
    assert_eq!(kept, (None, None), "the kept originals are cleared");
}

#[test]
fn a_rollback_never_deletes_an_lsa_secret_it_did_not_take_over() {
    let rig = Rig::new();
    rig.owner_autologon();
    // Fails before step 6: the owner's LSA secret must not be touched.
    rig.platform.with_world(|w| w.legal_notice = true);
    let start = rig.machine();
    let error = rig.kiosk().enable_or_rollback(EnableOptions::default()).unwrap_err();
    assert!(matches!(error, KioskError::Blocked(ref code) if code == "legal_notice"));
    assert_eq!(rig.machine(), start);
    assert_eq!(rig.lsa(LSA_DEFAULT_PASSWORD), Some(OWNER_LSA.to_string()));
}

// -- failure injection (test 5 and the power-loss cases) -------------------------------

#[test]
fn a_failure_at_every_mutating_step_rolls_the_machine_back() {
    let sequence = mutating_sequence(owner);
    assert!(sequence.len() >= 15, "{sequence:?}");
    for (op, skip) in sequence {
        let rig = Rig::new();
        rig.owner_autologon();
        let start = rig.machine();
        rig.platform.fail_nth(op, skip, injected());

        let result = rig.kiosk().enable_or_rollback(EnableOptions::default());
        assert!(result.is_err(), "{op:?} #{skip} did not fail the enable");
        assert_eq!(rig.machine(), start, "after a failure of {op:?} #{skip}");
        let state = rig.shared.get();
        assert_eq!(state.kiosk.last_error.as_deref(), Some("platform_error"), "{op:?} #{skip}");
        assert_eq!(state.kiosk.failures, 1, "{op:?} #{skip}");
        assert_eq!(state.kiosk.applied, KioskApplied::Disabled, "{op:?} #{skip}");
        assert!(state.journal.is_empty(), "{op:?} #{skip}: {:?}", state.journal);
        assert!(!state.kiosk.lsa_taken_over && state.kiosk.staff_hive.is_none(), "{op:?} #{skip}");
        let kept = rig
            .shared
            .secrets(|s| (s.original_default_password_registry.clone(), s.original_default_password_lsa.clone()))
            .unwrap();
        assert_eq!(kept, (None, None), "{op:?} #{skip}");
    }
}

#[test]
fn power_loss_at_every_mutating_step_is_finished_by_the_next_enable() {
    let sequence = mutating_sequence(owner);
    for (op, skip) in sequence {
        let rig = Rig::new();
        rig.owner_autologon();
        let start = rig.machine();
        rig.platform.fail_nth(op, skip, injected());
        // No rollback: the process is gone at that call.
        assert!(rig.kiosk().enable(EnableOptions::default()).is_err(), "{op:?} #{skip}");

        // The agent starts again over the files it left.
        let restarted = rig.restarted();
        let mut kiosk = Kiosk {
            platform: rig.platform.as_ref(),
            shared: restarted.as_ref(),
            config: &rig.config,
            install: &rig.install,
        };
        kiosk.enable(EnableOptions { exit_hold: false, verify_password: true }).unwrap();
        let state = restarted.get();
        assert_eq!(state.kiosk.applied, KioskApplied::Enabled, "{op:?} #{skip}");
        assert_eq!(rig.winlogon("AutoAdminLogon"), Some(Rig::text("1")), "{op:?} #{skip}");
        assert_eq!(rig.winlogon("DefaultUserName"), Some(Rig::text("RuleboxStaff")), "{op:?} #{skip}");
        assert_eq!(rig.winlogon("DefaultPassword"), None, "{op:?} #{skip}");
        assert_eq!(rig.lsa(LSA_DEFAULT_PASSWORD), Some(rig.staff_password()), "the secret works: {op:?} #{skip}");
        assert_eq!(rig.lsa(LSA_PENDING), None, "{op:?} #{skip}");
        // One journal entry per value, never duplicated.
        let mut names: Vec<_> = state.journal.iter().map(|e| e.key.name.clone()).collect();
        names.sort();
        names.dedup();
        assert_eq!(names.len(), state.journal.len(), "{op:?} #{skip}");

        // And Disable puts the owner's machine back.
        kiosk.disable().unwrap();
        assert_eq!(rig.machine(), start, "{op:?} #{skip}");
        assert!(restarted.get().journal.is_empty(), "{op:?} #{skip}");
    }
}

#[test]
fn a_disable_after_power_loss_restores_from_the_journal_alone() {
    let sequence = mutating_sequence(owner);
    for (op, skip) in sequence {
        let rig = Rig::new();
        rig.owner_autologon();
        let start = rig.machine();
        rig.platform.fail_nth(op, skip, injected());
        assert!(rig.kiosk().enable(EnableOptions::default()).is_err());

        // Restart; the desired state now says the kiosk is off.
        let restarted = rig.restarted();
        let mut kiosk = Kiosk {
            platform: rig.platform.as_ref(),
            shared: restarted.as_ref(),
            config: &rig.config,
            install: &rig.install,
        };
        kiosk.disable().unwrap();
        assert_eq!(rig.machine(), start, "{op:?} #{skip}");
        let state = restarted.get();
        assert!(state.journal.is_empty(), "{op:?} #{skip}");
        assert!(!state.kiosk.lsa_taken_over && state.kiosk.staff_hive.is_none(), "{op:?} #{skip}");
    }
}

#[test]
fn disable_runs_every_part_and_reports_what_failed() {
    let rig = Rig::new();
    rig.owner_autologon();
    enable(&rig).unwrap();
    // The first value cannot be written; the LSA secret and the hive still go.
    rig.platform.fail_next(SimOp::WriteMachineValue, PlatformError::AccessDenied);
    let error = rig.kiosk().disable().unwrap_err();
    assert!(matches!(error, KioskError::Platform(PlatformError::AccessDenied)), "{error:?}");
    let state = rig.shared.get();
    assert_eq!(state.journal.len(), 1, "only the value that failed stays journaled");
    assert!(!state.kiosk.lsa_taken_over && state.kiosk.staff_hive.is_none());
    assert_eq!(rig.lsa(LSA_DEFAULT_PASSWORD), Some(OWNER_LSA.to_string()));
    // Not marked Disabled while a value is still not back.
    assert_eq!(state.kiosk.applied, KioskApplied::Enabled);
    // Another try finishes it.
    rig.kiosk().disable().unwrap();
    assert_eq!(rig.shared.get().kiosk.applied, KioskApplied::Disabled);
    assert!(rig.shared.get().journal.is_empty());
}

// -- the account (tests 6 and 7) --------------------------------------------------------

fn foreign_staff(rig: &Rig, comment: &str) -> String {
    rig.platform
        .create_staff_user(
            &StaffUserSpec {
                user_name: STAFF_USER_NAME.into(),
                full_name: "Someone".into(),
                comment: comment.into(),
            },
            "their-own-password",
        )
        .unwrap()
}

#[test]
fn an_account_that_is_not_ours_is_a_conflict_and_nothing_changes() {
    let rig = Rig::new();
    foreign_staff(&rig, "A person's own account");
    let before = rig.all_calls().len();
    let start = rig.machine();
    let error = enable(&rig).unwrap_err();
    assert!(matches!(error, KioskError::StaffAccountConflict), "{error:?}");
    assert_eq!(error.code(), "staff_account_conflict");
    assert_eq!(rig.mutating_since(before), Vec::<SimOp>::new());
    assert_eq!(rig.machine(), start);
    assert_eq!(rig.staff_password(), "their-own-password");
}

#[test]
fn an_account_with_our_comment_and_no_stored_sid_is_adopted_and_its_password_reset() {
    let rig = Rig::new();
    let sid = foreign_staff(&rig, STAFF_COMMENT);
    let created_before = rig.count(SimOp::CreateStaffUser);
    enable(&rig).unwrap();
    assert_eq!(rig.staff_sid(), sid);
    assert_ne!(rig.staff_password(), "their-own-password");
    assert_eq!(rig.lsa(LSA_DEFAULT_PASSWORD), Some(rig.staff_password()));
    assert_eq!(rig.count(SimOp::CreateStaffUser), created_before, "no second account");
}

#[test]
fn a_recorded_account_replaced_by_a_foreign_one_is_a_conflict_and_the_kiosk_goes_off() {
    let rig = Rig::new();
    enable(&rig).unwrap();
    // The account is deleted and someone creates their own with that name.
    let old = rig.staff_sid();
    rig.platform.delete_staff_user(&old, STAFF_USER_NAME).unwrap();
    foreign_staff(&rig, "not ours");
    let error = rig.kiosk().enable_or_rollback(EnableOptions::default()).unwrap_err();
    assert!(matches!(error, KioskError::StaffAccountConflict));
    // A kiosk that was on is switched off rather than pointed at their account.
    assert_eq!(rig.shared.get().kiosk.applied, KioskApplied::Disabled);
    assert_eq!(rig.winlogon("DefaultUserName"), None);
}

#[test]
fn an_account_that_vanished_is_created_again() {
    let rig = Rig::new();
    enable(&rig).unwrap();
    let old = rig.staff_sid();
    rig.platform.delete_staff_user(&old, STAFF_USER_NAME).unwrap();
    enable(&rig).unwrap();
    assert_ne!(rig.staff_sid(), old);
    assert!(rig.shared.get().staff.unwrap().profile_dir.is_some());
    assert_eq!(rig.count(SimOp::CreateStaffUser), 2);
}

// -- blockers (test 8) ------------------------------------------------------------------

#[test]
fn a_blocker_stops_the_enable_before_any_change() {
    type Arrange = fn(&Rig);
    let cases: [(&str, Arrange); 4] = [
        ("no_other_admin", |rig| rig.platform.with_world(|w| w.admins.clear())),
        ("legal_notice", |rig| rig.platform.with_world(|w| w.legal_notice = true)),
        ("managed_device", |rig| rig.platform.with_world(|w| w.os.domain_joined = true)),
        ("shell_binary_missing", |rig| rig.platform.with_world(|w| w.shell_binaries.launcher_ok = false)),
    ];
    for (code, arrange) in cases {
        let rig = Rig::new();
        arrange(&rig);
        let before = rig.all_calls().len();
        let start = rig.machine();
        let error = enable(&rig).unwrap_err();
        assert!(matches!(&error, KioskError::Blocked(found) if found == code), "{code}: {error:?}");
        assert_eq!(rig.mutating_since(before), Vec::<SimOp>::new(), "{code}");
        assert_eq!(rig.machine(), start, "{code}");
        assert!(rig.shared.get().staff.is_none(), "{code}");
    }
}

#[test]
fn a_joined_pc_enrolled_with_allow_joined_is_not_blocked() {
    let mut state = enrolled_state();
    state.enrollment.as_mut().unwrap().allow_joined = true;
    let rig = Rig::with_state(state);
    rig.platform.with_world(|w| w.os.entra_joined = true);
    enable(&rig).unwrap();
}

// -- repair (tests 9 and 10) --------------------------------------------------------------

#[test]
fn a_value_changed_behind_the_agents_back_is_fixed_alone() {
    let rig = Rig::new();
    enable(&rig).unwrap();
    // Windows overwrites `DefaultUserName` after an administrator signed in.
    rig.set(WINLOGON_KEY, "DefaultUserName", Rig::text("Administrator"));
    let before = rig.all_calls().len();
    enable(&rig).unwrap();
    assert_eq!(rig.mutating_since(before), [SimOp::WriteMachineValue]);
    assert_eq!(rig.winlogon("DefaultUserName"), Some(Rig::text("RuleboxStaff")));
    // The journal still has the original (absent), not the drifted value.
    let state = rig.shared.get();
    let entry = state.journal.iter().find(|e| e.key.name == "DefaultUserName").unwrap();
    assert_eq!(entry.original, OriginalValue::Absent);
}

#[test]
fn a_stored_password_that_does_not_work_is_repaired_with_one_test_and_one_reset() {
    let rig = Rig::new();
    enable(&rig).unwrap();
    // Someone changed the account's password behind our back.
    rig.set_staff_password("changed");
    let tests_before = rig.count(SimOp::TestLogon);
    let resets_before = rig.count(SimOp::SetUserPassword);

    rig.kiosk().verify_password().unwrap();

    assert_eq!(rig.count(SimOp::TestLogon) - tests_before, 1);
    assert_eq!(rig.count(SimOp::SetUserPassword) - resets_before, 1);
    assert_eq!(rig.lsa(LSA_DEFAULT_PASSWORD), Some(rig.staff_password()));
    assert_ne!(rig.staff_password(), "changed");
    assert_eq!(rig.lsa(LSA_PENDING), None);
    // And a password that works costs one test and no change.
    let tests_before = rig.count(SimOp::TestLogon);
    let resets_before = rig.count(SimOp::SetUserPassword);
    rig.kiosk().verify_password().unwrap();
    assert_eq!(rig.count(SimOp::TestLogon) - tests_before, 1);
    assert_eq!(rig.count(SimOp::SetUserPassword), resets_before);
}

#[test]
fn a_missing_sign_in_secret_is_set_again() {
    let rig = Rig::new();
    enable(&rig).unwrap();
    rig.platform.with_world(|w| {
        w.lsa_secrets.remove(LSA_DEFAULT_PASSWORD);
    });
    enable(&rig).unwrap();
    assert_eq!(rig.lsa(LSA_DEFAULT_PASSWORD), Some(rig.staff_password()));
}

#[test]
fn a_pending_password_from_an_unfinished_run_is_promoted_when_it_works() {
    let rig = Rig::new();
    // The second `lsa_secret_set` (the sign-in secret) fails: the pending password is
    // on the account but not yet in `DefaultPassword`.
    rig.platform.fail_nth(SimOp::LsaSecretSet, 1, injected());
    assert!(enable(&rig).is_err());
    let password = rig.staff_password();
    assert_eq!(rig.lsa(LSA_PENDING), Some(password.clone()));
    let tests_before = rig.count(SimOp::TestLogon);
    let resets_before = rig.count(SimOp::SetUserPassword);

    enable(&rig).unwrap();

    // Promoted: the same password, one test, no reset.
    assert_eq!(rig.staff_password(), password);
    assert_eq!(rig.count(SimOp::TestLogon) - tests_before, 1);
    assert_eq!(rig.count(SimOp::SetUserPassword), resets_before);
    assert_eq!(rig.lsa(LSA_DEFAULT_PASSWORD), Some(password));
    assert_eq!(rig.lsa(LSA_PENDING), None);
}

#[test]
fn a_pending_password_that_does_not_work_is_replaced_once() {
    let rig = Rig::new();
    rig.platform.fail_nth(SimOp::LsaSecretSet, 1, injected());
    assert!(enable(&rig).is_err());
    // The account has a different password than the pending one.
    rig.set_staff_password("other");
    let tests_before = rig.count(SimOp::TestLogon);
    let resets_before = rig.count(SimOp::SetUserPassword);

    enable(&rig).unwrap();

    assert_eq!(rig.count(SimOp::TestLogon) - tests_before, 1, "never more than one test per repair");
    assert_eq!(rig.count(SimOp::SetUserPassword) - resets_before, 1);
    assert_eq!(rig.lsa(LSA_DEFAULT_PASSWORD), Some(rig.staff_password()));
}

// -- errors, status, schedule (test 13) ------------------------------------------------------

#[test]
fn error_codes_are_short_machine_words() {
    assert_eq!(KioskError::Blocked("legal_notice".into()).code(), "legal_notice");
    assert_eq!(KioskError::StaffAccountConflict.code(), "staff_account_conflict");
    assert_eq!(KioskError::from(PlatformError::PasswordPolicy).code(), "password_policy");
    assert_eq!(KioskError::from(PlatformError::AccessDenied).code(), "access_denied");
    assert_eq!(KioskError::from(PlatformError::Guard("x".into())).code(), "guard_blocked");
    assert_eq!(KioskError::from(PlatformError::NotFound).code(), "platform_error");
    assert_eq!(KioskError::Persist("disk".into()).code(), "state_not_saved");
    let both = KioskError::Multiple(vec![
        KioskError::from(PlatformError::AccessDenied),
        KioskError::StaffAccountConflict,
    ]);
    assert_eq!(both.code(), "access_denied");
    assert!(both.to_string().contains("access denied; an account named"));
}

#[test]
fn the_retry_schedule_is_1_5_15_15_minutes() {
    let minutes: Vec<u64> = (1..=5).map(|failures| retry_delay(failures).as_secs() / 60).collect();
    assert_eq!(minutes, [1, 5, 15, 15, 15]);
}

#[test]
fn the_status_follows_the_state_record() {
    let mut record = KioskRecord::default();
    assert_eq!(kiosk_status(&record), KioskStatus { enabled: false, phase: KioskPhase::NotApplied, error_code: None });
    record.applied = KioskApplied::Enabled;
    assert_eq!(kiosk_status(&record).phase, KioskPhase::Applied);
    assert!(kiosk_status(&record).enabled);
    record.applied = KioskApplied::Disabled;
    record.last_error = Some("legal_notice".into());
    assert_eq!(
        kiosk_status(&record),
        KioskStatus { enabled: false, phase: KioskPhase::Failed, error_code: Some("legal_notice".into()) }
    );
}

// -- hold_ended (test 16) -------------------------------------------------------------------------

fn session(id: u32, sid: Option<&str>, state: SessionState) -> SessionInfo {
    SessionInfo { id, state, user_sid: sid.map(str::to_string), is_console: true }
}

#[tokio::test(start_paused = true)]
async fn the_hold_ends_after_5_minutes_or_when_an_administrator_is_active() {
    let start = Instant::now();
    let hold = ExitHold::new(start);
    let staff = "S-1-5-21-1-1-1-2001";
    let after = |secs: u64| start + Duration::from_secs(secs);

    assert!(!hold_ended(&hold, after(240), &[], staff));
    assert!(!hold_ended(&hold, after(299), &[], staff));
    assert!(hold_ended(&hold, after(300), &[], staff));
    // Only the Staff session is listed: still held.
    assert!(!hold_ended(&hold, after(10), &[session(2, Some(staff), SessionState::Active)], staff));
    // The sign-in screen has no user; a disconnected administrator is not signed in.
    assert!(!hold_ended(&hold, after(10), &[session(0, None, SessionState::Active)], staff));
    assert!(!hold_ended(&hold, after(10), &[session(3, Some(ADMIN_SID), SessionState::Disconnected)], staff));
    // An administrator becomes active.
    assert!(hold_ended(
        &hold,
        after(10),
        &[session(2, Some(staff), SessionState::Active), session(3, Some(ADMIN_SID), SessionState::Active)],
        staff
    ));
}

/// Found on the VM: a restart within the 5 minutes left the PC at the sign-in
/// screen, because the value was still "0" when Windows decided at boot. The hold
/// therefore also ends shortly after the Staff session is gone.
#[tokio::test(start_paused = true)]
async fn the_hold_ends_shortly_after_the_staff_session_is_gone() {
    let start = Instant::now();
    let staff = "S-1-5-21-1-1-1-2001";
    let after = |secs: u64| start + Duration::from_secs(secs);

    // The session was seen gone at 20 s: not yet 15 s later... and then it is.
    let mut hold = ExitHold::new(start);
    hold.gone_since = Some(after(20));
    assert!(!hold_ended(&hold, after(20), &[], staff));
    assert!(!hold_ended(&hold, after(34), &[], staff));
    assert!(hold_ended(&hold, after(35), &[], staff));

    // A Staff session that is back resets the clock (the caller clears `gone_since`).
    hold.gone_since = None;
    assert!(!hold_ended(&hold, after(120), &[], staff));
}

// -- the reconciler (tests 11 to 19) --------------------------------------------------------------

struct RecRig {
    rig: Rig,
    rec: Reconciler,
    snapshot: SnapshotHandle,
    session: Arc<SessionManager>,
    audit: Arc<AuditHandle>,
    events: tokio::sync::broadcast::Receiver<Frame>,
    sid_rx: watch::Receiver<Option<String>>,
}

impl RecRig {
    fn new() -> Self {
        Self::with_rig(Rig::new())
    }

    fn with_rig(rig: Rig) -> Self {
        Self::build(rig, false)
    }

    fn build(rig: Rig, simulate: bool) -> Self {
        let mut first = test_snapshot();
        first.enrollment = EnrollmentStatus::Enrolled;
        first.connection = ConnectionStatus::Online;
        let (snapshot, snapshot_rx) = SnapshotHandle::new(first);
        let state_dir = rig.dir.path().join("state");
        let now: Arc<dyn Fn() -> u64 + Send + Sync> = Arc::new(|| 1_760_000_000_000);
        let lockouts = Arc::new(Mutex::new(LockoutStore::open(state_dir.join("lockouts.json")).unwrap()));
        let audit = AuditHandle::new(
            AuditQueue::open(state_dir.join("audit-queue.json")).unwrap(),
            snapshot_rx.clone(),
            Arc::clone(&now),
        );
        let session = SessionManager::new(SessionDeps {
            directory: Arc::new(FixtureDirectory::new(false)),
            cache: EmployeeCache::open(state_dir.join("employee-cache.json")).unwrap(),
            lockouts,
            audit: Arc::clone(&audit),
            snapshot_rx,
            files_base: None,
            now_ms: now,
            clock_floor_ms: Arc::new(|| 0),
            timeouts: SessionTimeouts::default(),
        });
        let broadcast = ShellBroadcast::new();
        let events = broadcast.subscribe();
        let (sid_tx, sid_rx) = watch::channel(None);
        let platform: Arc<dyn Platform> = rig.platform.clone();
        let rec = Reconciler::new(ReconcilerDeps {
            platform,
            shared: Arc::clone(&rig.shared),
            snapshot: snapshot.clone(),
            session: Arc::clone(&session),
            broadcast,
            config: rig.config.clone(),
            install: rig.install.clone(),
            simulate,
            staff_sid_tx: sid_tx,
            recovered_flag: state_dir.join("recovered.flag"),
        });
        Self { rig, rec, snapshot, session, audit, events, sid_rx }
    }

    /// What the backend task does when it accepts a document.
    fn want(&self, kiosk_enabled: bool, version: u64) {
        self.snapshot.update(|snapshot| {
            snapshot.desired_state =
                Some(DesiredState { kiosk_enabled, version, ..DesiredState::enrollment_default() });
            snapshot.desired_state_version = version;
        });
    }

    async fn trigger(&mut self, trigger: Trigger) {
        self.rec.on_trigger(trigger).await;
    }

    fn status(&self) -> KioskStatus {
        self.snapshot.current().kiosk
    }

    fn state(&self) -> AgentState {
        self.rig.shared.get()
    }

    fn staff_session(&self, id: u32, active: bool) {
        let sid = self.rig.staff_sid();
        self.rig.platform.add_session(id, Some(&sid), active);
    }

    fn request(&self, session_id: u32) -> (ExitRequest, oneshot::Receiver<Result<(), String>>) {
        let (tx, rx) = oneshot::channel();
        (ExitRequest { session_id, prepared: tx, audit: Arc::clone(&self.audit) }, rx)
    }

    /// The fixture employee Maya signs in. The tests that use this run on the real
    /// clock: the Argon2 check runs on a blocking thread, which a paused clock does
    /// not wait for.
    async fn sign_in(&self) -> Result<serde_json::Value, rulebox_ipc::RpcError> {
        let peer = PeerCtx { connection_id: 1, pid: 1, session_id: 2, role: ClientRole::Shell };
        self.session
            .handle(&peer, SessionSignIn::NAME, json!({ "username": "maya", "password": "demo" }))
            .expect("session.signIn is handled")
            .await
    }
}

#[tokio::test(start_paused = true)]
async fn an_enrolled_pc_with_no_document_gets_the_kiosk_and_publishes_it() {
    let mut r = RecRig::new();
    r.trigger(Trigger::Startup).await;

    let state = r.state();
    assert_eq!(state.kiosk.applied, KioskApplied::Enabled);
    assert_eq!(state.last_applied_version, 0, "no document was applied");
    assert_eq!(r.status(), KioskStatus { enabled: true, phase: KioskPhase::Applied, error_code: None });
    // The shell pipe is told the Staff SID.
    assert_eq!(r.sid_rx.borrow().clone(), Some(r.rig.staff_sid()));
    // The stored password was tested once (service start).
    assert_eq!(r.rig.count(SimOp::TestLogon), 1);
    // A reassert changes and tests nothing.
    let before = r.rig.all_calls().len();
    r.trigger(Trigger::Reassert).await;
    assert_eq!(r.rig.mutating_since(before), Vec::<SimOp>::new());
}

#[tokio::test(start_paused = true)]
async fn the_applied_version_is_written_after_a_successful_reconcile_only() {
    let mut r = RecRig::new();
    r.want(true, 4);
    r.rig.platform.with_world(|w| w.legal_notice = true);
    r.trigger(Trigger::DesiredChanged).await;
    // Failed: no version, status shows why.
    assert_eq!(r.state().last_applied_version, 0);
    assert_eq!(
        r.status(),
        KioskStatus { enabled: false, phase: KioskPhase::Failed, error_code: Some("legal_notice".into()) }
    );
    assert_eq!(r.state().kiosk.failures, 1);

    // The notice is gone; the next trigger succeeds and records version 4.
    r.rig.platform.with_world(|w| w.legal_notice = false);
    r.trigger(Trigger::Session).await;
    assert_eq!(r.state().last_applied_version, 4);
    assert_eq!(r.status().phase, KioskPhase::Applied);
    assert_eq!(r.state().kiosk.last_error, None);
    assert_eq!(r.state().kiosk.failures, 0);
    assert_eq!(r.rec.retry_at(), None);
}

#[tokio::test(start_paused = true)]
async fn a_document_that_turns_the_kiosk_off_disables_it_and_records_its_version() {
    let mut r = RecRig::new();
    r.rig.owner_autologon();
    let start = r.rig.machine();
    r.want(true, 1);
    r.trigger(Trigger::DesiredChanged).await;
    assert_eq!(r.state().last_applied_version, 1);

    r.want(false, 2);
    r.trigger(Trigger::DesiredChanged).await;
    let state = r.state();
    assert_eq!((state.kiosk.applied, state.last_applied_version), (KioskApplied::Disabled, 2));
    assert!(state.journal.is_empty());
    assert_eq!(r.rig.machine(), start);
    assert_eq!(r.status(), KioskStatus { enabled: false, phase: KioskPhase::Applied, error_code: None });

    // Off and clean: nothing is called any more.
    let before = r.rig.all_calls().len();
    r.trigger(Trigger::Reassert).await;
    r.trigger(Trigger::DesiredChanged).await;
    assert_eq!(r.rig.mutating_since(before), Vec::<SimOp>::new());

    // And on again.
    r.want(true, 3);
    r.trigger(Trigger::DesiredChanged).await;
    assert_eq!(r.state().kiosk.applied, KioskApplied::Enabled);
    assert_eq!(r.state().last_applied_version, 3);
}

#[tokio::test(start_paused = true)]
async fn failures_are_retried_after_1_5_15_and_15_minutes() {
    let mut r = RecRig::new();
    r.rig.platform.with_world(|w| w.legal_notice = true);
    let mut minutes = Vec::new();
    for _ in 0..4 {
        r.trigger(Trigger::Reassert).await;
        let at = r.rec.retry_at().expect("a retry is scheduled");
        minutes.push((at - Instant::now()).as_secs() / 60);
    }
    assert_eq!(minutes, [1, 5, 15, 15]);
    assert_eq!(r.state().kiosk.failures, 4);

    // The timer fires the retry; it fails again and is rescheduled.
    tokio::time::advance(Duration::from_secs(15 * 60)).await;
    r.rec.on_timer().await;
    assert_eq!(r.state().kiosk.failures, 5);
    assert_eq!(r.rec.next_deadline(), r.rec.retry_at());
    // Fixed: the retry succeeds and the schedule is dropped.
    r.rig.platform.with_world(|w| w.legal_notice = false);
    tokio::time::advance(Duration::from_secs(15 * 60)).await;
    r.rec.on_timer().await;
    assert_eq!(r.state().kiosk.applied, KioskApplied::Enabled);
    assert_eq!(r.rec.retry_at(), None);
}

// -- the locked Staff console (test 11) -----------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn a_locked_active_console_is_signed_out_after_10_seconds() {
    let mut r = RecRig::new();
    r.trigger(Trigger::Startup).await;
    r.staff_session(5, true);

    r.trigger(Trigger::SessionLocked { session_id: 5 }).await;
    tokio::time::advance(Duration::from_secs(9)).await;
    r.rec.on_timer().await;
    assert_eq!(r.rig.count(SimOp::LogoffSession), 0, "not before 10 seconds");
    tokio::time::advance(Duration::from_secs(1)).await;
    r.rec.on_timer().await;
    assert_eq!(r.rig.count(SimOp::LogoffSession), 1);
    // Done once.
    tokio::time::advance(Duration::from_secs(60)).await;
    r.rec.on_timer().await;
    assert_eq!(r.rig.count(SimOp::LogoffSession), 1);
}

#[tokio::test(start_paused = true)]
async fn a_locked_session_that_became_disconnected_is_left_alone() {
    let mut r = RecRig::new();
    r.trigger(Trigger::Startup).await;
    r.staff_session(5, true);
    r.trigger(Trigger::SessionLocked { session_id: 5 }).await;
    // Switch user: the session is disconnected before the 10 seconds pass.
    r.rig.platform.with_world(|w| w.sessions[0].state = SessionState::Disconnected);
    tokio::time::advance(Duration::from_secs(10)).await;
    r.rec.on_timer().await;
    assert_eq!(r.rig.count(SimOp::LogoffSession), 0);
}

#[tokio::test(start_paused = true)]
async fn the_lock_of_someone_elses_session_or_with_the_kiosk_off_is_ignored() {
    let mut r = RecRig::new();
    r.trigger(Trigger::Startup).await;
    r.rig.platform.add_session(3, Some(ADMIN_SID), true);
    r.trigger(Trigger::SessionLocked { session_id: 3 }).await;
    assert_eq!(r.rec.next_deadline(), None);

    r.want(false, 2);
    r.trigger(Trigger::DesiredChanged).await;
    r.staff_session(5, true);
    r.trigger(Trigger::SessionLocked { session_id: 5 }).await;
    assert_eq!(r.rec.next_deadline(), None);
}

// -- disable with a Staff session (test 12) ---------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn disable_undoes_everything_then_tells_the_staff_app_and_signs_out_after_10_seconds() {
    let mut r = RecRig::new();
    r.rig.owner_autologon();
    let start = r.rig.machine();
    r.want(true, 1);
    r.trigger(Trigger::DesiredChanged).await;
    r.staff_session(6, true);
    r.rig.platform.add_session(1, Some(ADMIN_SID), false);
    while r.events.try_recv().is_ok() {}
    let calls_before = r.rig.all_calls().len();

    r.want(false, 2);
    let started = Instant::now();
    r.trigger(Trigger::DesiredChanged).await;
    assert!(Instant::now() - started >= Duration::from_secs(10));

    match r.events.try_recv().unwrap() {
        Frame::Event { event, data } => {
            assert_eq!(event, rulebox_ipc::methods::events::AGENT_SHUTTING_DOWN);
            assert_eq!(data, json!({ "reason": "kioskDisabled", "graceMs": 10000 }));
        }
        other => panic!("unexpected {other:?}"),
    }
    // Values and the shell first, then the sign-out of exactly the Staff session.
    let ops = r.rig.mutating_since(calls_before);
    assert_eq!(ops.iter().filter(|op| **op == SimOp::LogoffSession).count(), 1);
    assert_eq!(ops.last(), Some(&SimOp::LogoffSession));
    assert_eq!(r.rig.machine(), start);
    let remaining: Vec<u32> = r.rig.platform.sessions().unwrap().iter().map(|s| s.id).collect();
    assert_eq!(remaining, [1], "the administrator's session stays");
    assert_eq!(r.state().kiosk.applied, KioskApplied::Disabled);
}

// -- the admin exit (tests 15 to 18) ------------------------------------------------------------------

fn auto_logon(r: &RecRig) -> Option<RegData> {
    r.rig.winlogon("AutoAdminLogon")
}

#[tokio::test(start_paused = true)]
async fn an_exit_turns_auto_sign_in_off_signs_out_and_holds_it_off_through_reasserts() {
    let mut r = RecRig::new();
    r.want(true, 1);
    r.trigger(Trigger::DesiredChanged).await;
    r.staff_session(7, true);
    let (request, mut prepared) = r.request(7);

    r.rec.on_exit(request).await;

    assert_eq!(prepared.try_recv().unwrap(), Ok(()));
    assert_eq!(auto_logon(&r), Some(Rig::text("0")));
    assert!(r.rig.platform.sessions().unwrap().iter().all(|s| s.id != 7), "signed out");
    assert!(r.rec.hold().is_some());

    // One minute later a reassert: `AutoAdminLogon` stays "0" while a changed
    // `DefaultUserName` is fixed.
    r.rig.set(WINLOGON_KEY, "DefaultUserName", Rig::text("Administrator"));
    tokio::time::advance(Duration::from_secs(60)).await;
    let before = r.rig.all_calls().len();
    r.trigger(Trigger::Reassert).await;
    assert_eq!(auto_logon(&r), Some(Rig::text("0")));
    assert_eq!(r.rig.winlogon("DefaultUserName"), Some(Rig::text("RuleboxStaff")));
    assert_eq!(r.rig.mutating_since(before), [SimOp::WriteMachineValue]);
    assert!(r.rec.hold().is_some());

    // The journal was not touched by the hold: the original is still "absent".
    let state = r.state();
    let entry = state.journal.iter().find(|e| e.key.name == "AutoAdminLogon").unwrap();
    assert_eq!(entry.original, OriginalValue::Absent);
}

#[tokio::test(start_paused = true)]
async fn a_disable_during_the_hold_puts_the_owners_auto_sign_in_back() {
    let mut r = RecRig::new();
    // The owner used automatic sign-in: `AutoAdminLogon` already was "1".
    r.rig.owner_autologon();
    let start = r.rig.machine();
    r.want(true, 1);
    r.trigger(Trigger::DesiredChanged).await;
    r.staff_session(7, true);
    let (request, _prepared) = r.request(7);
    r.rec.on_exit(request).await;
    assert_eq!(auto_logon(&r), Some(Rig::text("0")));
    assert!(r.rec.hold().is_some());

    // The backend turns the kiosk off before the hold ended.
    r.want(false, 2);
    r.trigger(Trigger::DesiredChanged).await;

    assert_eq!(r.rig.machine(), start, "everything the owner had is back, `AutoAdminLogon` included");
    assert!(r.rec.hold().is_none(), "nothing is held once the kiosk is off");
}

#[tokio::test(start_paused = true)]
async fn the_hold_ends_after_5_minutes_and_the_next_reconcile_writes_1() {
    let mut r = RecRig::new();
    r.want(true, 1);
    r.trigger(Trigger::DesiredChanged).await;
    r.staff_session(7, true);
    let (request, _prepared) = r.request(7);
    r.rec.on_exit(request).await;
    assert_eq!(auto_logon(&r), Some(Rig::text("0")));

    // The 30-second tick looks at it; at 4 minutes it is still held.
    tokio::time::advance(Duration::from_secs(240)).await;
    r.rec.on_timer().await;
    assert!(r.rec.hold().is_some());
    assert_eq!(auto_logon(&r), Some(Rig::text("0")));

    tokio::time::advance(Duration::from_secs(60)).await;
    r.rec.on_timer().await;
    assert!(r.rec.hold().is_none());
    assert_eq!(auto_logon(&r), Some(Rig::text("1")));
}

#[tokio::test(start_paused = true)]
async fn an_administrator_signing_in_ends_the_hold() {
    let mut r = RecRig::new();
    r.want(true, 1);
    r.trigger(Trigger::DesiredChanged).await;
    r.staff_session(7, true);
    let (request, _prepared) = r.request(7);
    r.rec.on_exit(request).await;
    assert!(r.rec.hold().is_some());

    r.rig.platform.add_session(1, Some(ADMIN_SID), true);
    r.trigger(Trigger::Session).await;
    assert!(r.rec.hold().is_none());
    assert_eq!(auto_logon(&r), Some(Rig::text("1")));
}

#[tokio::test(start_paused = true)]
async fn a_sign_out_that_never_works_drops_the_hold_and_arms_auto_sign_in_again() {
    let mut r = RecRig::new();
    r.want(true, 1);
    r.trigger(Trigger::DesiredChanged).await;
    r.staff_session(7, true);
    for _ in 0..4 {
        r.rig.platform.fail_next(SimOp::LogoffSession, PlatformError::Other("busy".into()));
    }
    let (request, mut prepared) = r.request(7);

    r.rec.on_exit(request).await;

    assert_eq!(prepared.try_recv().unwrap(), Ok(()), "it was prepared; the sign-out failed");
    assert_eq!(r.rig.count(SimOp::LogoffSession), 4);
    assert!(r.rec.hold().is_none());
    assert_eq!(auto_logon(&r), Some(Rig::text("1")));
    // The failure was recorded for the audit log by `run_exit`.
    assert_eq!(r.audit.records().len(), 1);
}

#[tokio::test(start_paused = true)]
async fn an_exit_with_the_kiosk_off_sets_no_hold_and_writes_nothing() {
    let mut r = RecRig::new();
    r.want(false, 1);
    r.trigger(Trigger::DesiredChanged).await;
    assert_eq!(r.state().kiosk.applied, KioskApplied::NotApplied);
    r.rig.platform.add_session(7, Some("S-1-5-21-1-1-1-2001"), true);
    let before = r.rig.all_calls().len();
    let (request, _prepared) = r.request(7);

    r.rec.on_exit(request).await;

    assert!(r.rec.hold().is_none());
    assert_eq!(r.rig.mutating_since(before), [SimOp::LogoffSession]);
    assert_eq!(auto_logon(&r), None);
}

#[tokio::test(start_paused = true)]
async fn the_agent_restarting_ends_the_hold() {
    // The hold is memory only: a new reconciler over the same machine, whose
    // `AutoAdminLogon` is still "0", writes "1" at start.
    let mut r = RecRig::new();
    r.want(true, 1);
    r.trigger(Trigger::DesiredChanged).await;
    r.staff_session(7, true);
    let (request, _prepared) = r.request(7);
    r.rec.on_exit(request).await;
    assert_eq!(auto_logon(&r), Some(Rig::text("0")));

    let RecRig { rig, .. } = r;
    let mut again = RecRig::with_rig(rig);
    again.want(true, 1);
    again.trigger(Trigger::Startup).await;
    assert_eq!(auto_logon(&again), Some(Rig::text("1")));
}

#[tokio::test(start_paused = true)]
async fn simulate_mode_logs_the_exit_and_sets_no_hold() {
    let mut r = RecRig::build(Rig::new(), true);
    r.want(true, 1);
    r.trigger(Trigger::DesiredChanged).await;
    r.staff_session(7, true);
    let before = r.rig.all_calls().len();
    let (request, mut prepared) = r.request(7);

    r.rec.on_exit(request).await;

    assert_eq!(prepared.try_recv().unwrap(), Ok(()));
    assert!(r.rec.hold().is_none());
    assert_eq!(r.rig.all_calls().len(), before, "run_exit calls nothing on the platform in simulate mode");
    assert_eq!(auto_logon(&r), Some(Rig::text("1")));
}

// -- the employee session and the Windows session (test 19) --------------------------------------------

#[tokio::test]
async fn enable_saves_the_profile_and_the_staff_session_ending_clears_the_employee() {
    let mut r = RecRig::new();
    // No profile known yet: the employee cannot sign in.
    assert!(r.sign_in().await.is_err());
    r.trigger(Trigger::Startup).await;
    let profile = r.rig.dir.path().join("sim-profiles").join(STAFF_USER_NAME);
    assert_eq!(r.state().staff.unwrap().profile_dir.as_deref(), Some(profile.to_str().unwrap()));

    // The employee signs in; their files folder is under <profile>\RuleboxFiles.
    r.staff_session(2, true);
    let signed_in = r.sign_in().await.unwrap();
    assert_eq!(signed_in["outcome"], "ok");
    let base = profile.join("RuleboxFiles");
    let root = signed_in["filesRoot"].as_str().unwrap().to_string();
    assert!(root.starts_with(base.to_str().unwrap()), "{root} is not under {}", base.display());
    assert_eq!(r.session.current_username().as_deref(), Some("maya"));

    // A session event with the Staff session still there changes nothing.
    r.trigger(Trigger::Session).await;
    assert_eq!(r.session.current_username().as_deref(), Some("maya"));
    // The Staff session ends: the employee session goes with it.
    r.rig.platform.with_world(|w| w.sessions.clear());
    r.trigger(Trigger::Session).await;
    assert_eq!(r.session.current_username(), None);
}

#[tokio::test]
async fn a_disconnected_staff_session_is_not_a_live_one() {
    let mut r = RecRig::new();
    r.trigger(Trigger::Startup).await;
    r.staff_session(2, true);
    assert_eq!(r.sign_in().await.unwrap()["outcome"], "ok");
    // Connected still counts as alive.
    r.rig.platform.with_world(|w| w.sessions[0].state = SessionState::Connected);
    r.trigger(Trigger::Session).await;
    assert_eq!(r.session.current_username().as_deref(), Some("maya"));
    // Disconnected: neither Active nor Connected, so the employee session is over.
    r.rig.platform.with_world(|w| w.sessions[0].state = SessionState::Disconnected);
    r.trigger(Trigger::Session).await;
    assert_eq!(r.session.current_username(), None);
}

#[tokio::test]
async fn simulate_mode_never_clears_the_session_by_the_session_list() {
    let mut r = RecRig::build(Rig::new(), true);
    r.trigger(Trigger::Startup).await;
    assert_eq!(r.sign_in().await.unwrap()["outcome"], "ok");
    // `SimPlatform` has no sessions, and a simulated agent must not read that as
    // "the Staff session ended".
    r.trigger(Trigger::Session).await;
    r.trigger(Trigger::Reassert).await;
    assert_eq!(r.session.current_username().as_deref(), Some("maya"));
}

// -- revoked, not enrolled, unenroll --------------------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn a_revoked_pc_stays_locked_and_is_still_repaired() {
    let mut r = RecRig::new();
    r.want(true, 1);
    r.trigger(Trigger::DesiredChanged).await;
    r.rig.shared.update(|s| s.enrollment.as_mut().unwrap().revoked = true).unwrap();
    // A document that says "off" (cached, or the last one received) is ignored.
    r.want(false, 2);
    r.rig.set(WINLOGON_KEY, "DefaultUserName", Rig::text("Administrator"));
    r.trigger(Trigger::Reassert).await;
    r.trigger(Trigger::DesiredChanged).await;

    let state = r.state();
    assert_eq!(state.kiosk.applied, KioskApplied::Enabled);
    assert_eq!(state.last_applied_version, 1);
    assert_eq!(r.rig.winlogon("DefaultUserName"), Some(Rig::text("RuleboxStaff")));
    assert_eq!(r.rig.winlogon("AutoAdminLogon"), Some(Rig::text("1")));
}

#[tokio::test(start_paused = true)]
async fn a_revoked_pc_that_was_never_enabled_stays_as_it_is() {
    let mut state = enrolled_state();
    state.enrollment.as_mut().unwrap().revoked = true;
    let mut r = RecRig::with_rig(Rig::with_state(state));
    r.trigger(Trigger::Startup).await;
    r.trigger(Trigger::DesiredChanged).await;
    assert_eq!(r.rig.mutating_since(0), Vec::<SimOp>::new());
    assert_eq!(r.state().kiosk.applied, KioskApplied::NotApplied);
}

#[tokio::test(start_paused = true)]
async fn a_pc_that_is_not_enrolled_is_left_alone_and_the_snapshot_untouched() {
    let mut r = RecRig::with_rig(Rig::with_state(AgentState::default()));
    let before = r.snapshot.current();
    r.trigger(Trigger::Startup).await;
    r.trigger(Trigger::DesiredChanged).await;
    r.trigger(Trigger::Reassert).await;
    assert_eq!(r.rig.mutating_since(0), Vec::<SimOp>::new());
    assert_eq!(r.snapshot.current(), before);
    assert_eq!(r.rig.shared.get(), AgentState::default());
}

#[tokio::test(start_paused = true)]
async fn the_stored_password_is_tested_once_at_start_and_repaired_if_it_fails() {
    let rig = Rig::new();
    rig.kiosk().enable(EnableOptions::default()).unwrap();
    rig.set_staff_password("changed");
    let mut r = RecRig::with_rig(rig);
    let tests_before = r.rig.count(SimOp::TestLogon);

    r.trigger(Trigger::Startup).await;
    assert_eq!(r.rig.count(SimOp::TestLogon) - tests_before, 1);
    assert_eq!(r.rig.lsa(LSA_DEFAULT_PASSWORD), Some(r.rig.staff_password()));

    // Not again on later triggers.
    r.trigger(Trigger::Reassert).await;
    r.trigger(Trigger::Session).await;
    assert_eq!(r.rig.count(SimOp::TestLogon) - tests_before, 1);
}

#[tokio::test(start_paused = true)]
async fn a_repair_that_fails_leaves_a_working_kiosk_on_but_a_blocker_switches_it_off() {
    let mut r = RecRig::new();
    r.trigger(Trigger::Startup).await;
    r.rig.set(WINLOGON_KEY, "DefaultUserName", Rig::text("Administrator"));
    r.rig.platform.fail_next(SimOp::WriteMachineValue, PlatformError::AccessDenied);
    r.trigger(Trigger::Reassert).await;
    // Still on, with the error shown, and a retry scheduled.
    assert_eq!(r.state().kiosk.applied, KioskApplied::Enabled);
    assert_eq!(
        r.status(),
        KioskStatus { enabled: true, phase: KioskPhase::Failed, error_code: Some("access_denied".into()) }
    );
    assert!(r.rec.retry_at().is_some());
    assert_eq!(r.rig.count(SimOp::LogoffSession), 0);

    // The only other administrator goes away: the way back would be lost.
    r.rig.platform.with_world(|w| w.admins.clear());
    r.trigger(Trigger::Reassert).await;
    assert_eq!(r.state().kiosk.applied, KioskApplied::Disabled);
    assert_eq!(r.status().error_code.as_deref(), Some("no_other_admin"));
    assert_eq!(r.rig.winlogon("AutoAdminLogon"), None);
}

// -- the recovered flag (Step 11) -------------------------------------------------------------------------

fn flag_path(r: &RecRig) -> std::path::PathBuf {
    r.rig.dir.path().join("state").join("recovered.flag")
}

#[tokio::test(start_paused = true)]
async fn a_recovered_pc_is_held_off_by_every_trigger_until_the_flag_goes() {
    let mut r = RecRig::new();
    std::fs::write(flag_path(&r), b"recovered").unwrap();
    r.want(true, 1);

    for trigger in [Trigger::Startup, Trigger::DesiredChanged, Trigger::Session, Trigger::Power, Trigger::Reassert]
    {
        r.trigger(trigger).await;
    }
    // Nothing was changed, not even read-modify-write of the account.
    assert_eq!(r.rig.mutating_since(0), Vec::<SimOp>::new());
    assert_eq!(r.state().kiosk.applied, KioskApplied::NotApplied);
    assert_eq!(r.status(), KioskStatus { enabled: false, phase: KioskPhase::NotApplied, error_code: None });

    // An administrator deletes the file: the next trigger enables the kiosk.
    std::fs::remove_file(flag_path(&r)).unwrap();
    r.trigger(Trigger::Reassert).await;
    assert_eq!(r.state().kiosk.applied, KioskApplied::Enabled);
}

#[tokio::test(start_paused = true)]
async fn enrollment_deletes_the_recovered_flag_and_enables_the_kiosk() {
    let mut r = RecRig::new();
    std::fs::write(flag_path(&r), b"recovered").unwrap();
    r.trigger(Trigger::Startup).await;
    assert_eq!(r.state().kiosk.applied, KioskApplied::NotApplied);

    let (reply, answer) = oneshot::channel();
    r.trigger(Trigger::ReconcileNow(reply)).await;
    let status = answer.await.unwrap();
    assert!(status.enabled, "{status:?}");
    assert!(!flag_path(&r).exists(), "enroll lifts the hold");
    assert_eq!(r.state().kiosk.applied, KioskApplied::Enabled);
}

#[tokio::test(start_paused = true)]
async fn a_new_document_does_not_lift_the_recovered_flag() {
    let mut r = RecRig::new();
    std::fs::write(flag_path(&r), b"recovered").unwrap();
    r.want(true, 5);
    r.trigger(Trigger::DesiredChanged).await;
    assert!(flag_path(&r).exists());
    assert_eq!(r.state().kiosk.applied, KioskApplied::NotApplied);
    assert_eq!(r.state().last_applied_version, 0);
}

// -- the handle (KioskControl) and the task loop ----------------------------------------------------------

#[tokio::test]
async fn the_handle_reconciles_on_request_and_holds_the_kiosk_off_after_a_disable() {
    let rig = Rig::new();
    let mut first = test_snapshot();
    first.enrollment = EnrollmentStatus::Enrolled;
    let (snapshot, _snapshot_rx) = SnapshotHandle::new(first);
    let parts = crate::testutil::test_session_parts(rig.dir.path(), snapshot.subscribe());
    let (sid_tx, _sid_rx) = watch::channel(None);
    let (_exit_tx, exit_rx) = mpsc::channel(1);
    let shutdown = CancellationToken::new();
    let tasks = TaskTracker::new();
    let platform: Arc<dyn Platform> = rig.platform.clone();
    let handle = spawn_reconciler(
        ReconcilerDeps {
            platform,
            shared: Arc::clone(&rig.shared),
            snapshot: snapshot.clone(),
            session: parts.session,
            broadcast: ShellBroadcast::new(),
            config: rig.config.clone(),
            install: rig.install.clone(),
            simulate: false,
            staff_sid_tx: sid_tx,
            recovered_flag: rig.dir.path().join("state").join("recovered.flag"),
        },
        exit_rx,
        shutdown.clone(),
        &tasks,
    );

    // Enrollment finished: the first reconcile enables the kiosk (Q12).
    let status = handle.reconcile_now().await;
    assert_eq!(status, KioskStatus { enabled: true, phase: KioskPhase::Applied, error_code: None });
    assert_eq!(rig.shared.get().kiosk.applied, KioskApplied::Enabled);

    // `unenroll`: Disable, and nothing brings the kiosk back by itself.
    handle.disable().await.unwrap();
    assert_eq!(rig.shared.get().kiosk.applied, KioskApplied::Disabled);
    handle.session_changed();
    handle.power_resumed();
    // A reconcile request is an explicit one and lifts the hold.
    let status = handle.reconcile_now().await;
    assert!(status.enabled);

    // A document that turns the kiosk off reaches the reconciler as a trigger.
    snapshot.update(|s| {
        s.desired_state = Some(DesiredState { kiosk_enabled: false, ..DesiredState::enrollment_default() });
    });
    handle.desired_changed();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while rig.shared.get().kiosk.applied != KioskApplied::Disabled {
        assert!(tokio::time::Instant::now() < deadline, "the document was never applied");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }

    shutdown.cancel();
    tasks.close();
    tasks.wait().await;
    // After the task is gone the handle still answers.
    assert!(handle.disable().await.is_err());
    assert_eq!(handle.reconcile_now().await, snapshot.current().kiosk);
}

#[tokio::test]
async fn a_session_event_does_not_undo_a_disable_until_a_new_document_arrives() {
    let mut r = RecRig::with_rig(Rig::new());
    r.trigger(Trigger::Startup).await;
    assert_eq!(r.state().kiosk.applied, KioskApplied::Enabled);

    let (reply, answer) = oneshot::channel();
    r.trigger(Trigger::Disable(reply)).await;
    assert_eq!(answer.await.unwrap(), Ok(()));
    assert_eq!(r.state().kiosk.applied, KioskApplied::Disabled);

    r.trigger(Trigger::Session).await;
    r.trigger(Trigger::Reassert).await;
    assert_eq!(r.state().kiosk.applied, KioskApplied::Disabled);

    r.trigger(Trigger::DesiredChanged).await;
    assert_eq!(r.state().kiosk.applied, KioskApplied::Enabled);
}
