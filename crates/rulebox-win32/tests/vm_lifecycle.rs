//! VM-only tests (plan Step 10, run in Step 14 by the user). They change the
//! machine, so each one is `#[ignore]`d and starts by requiring the test-machine
//! marker. Run on the VM, as an elevated administrator, with:
//!
//! ```text
//! cargo test -p rulebox-win32 --test vm_lifecycle -- --ignored --test-threads=1
//! ```
//!
//! The marker `HKLM\SOFTWARE\Rulebox\TestMachine\ComputerName` is created by the
//! user by hand inside the VM; no test and no tool creates it.

#![cfg(windows)]

use rulebox_win32::accounts::{
    create_standard_user, delete_user_and_profile, ensure_profile, find_user, set_password, test_logon,
};
use rulebox_win32::guard::require_test_machine;
use rulebox_win32::lsa::{secret_get, secret_set};
use rulebox_win32::shellreg::{get_user_shell, set_user_policy_dword, set_user_shell, Mechanism};
use rulebox_win32::{dpapi, Win32Error};

const TEST_USER: &str = "RbxVmTest";
const TEST_PASSWORD_1: &str = "Vm!Test-Passw0rd-1=A";
const TEST_PASSWORD_2: &str = "Vm!Test-Passw0rd-2=B";
const TEST_SECRET: &str = "L$RuleboxVmTest";

#[allow(clippy::expect_used)] // a test helper: stopping the test with a clear message is the point
fn require_vm() {
    require_test_machine().expect("this test changes the machine: run it only on the test VM, with the marker present");
}

/// Removes the test account if an earlier run left it behind.
fn cleanup() {
    if let Ok(Some(user)) = find_user(TEST_USER) {
        let _ = delete_user_and_profile(&user.sid, TEST_USER);
    }
}

/// Create -> find -> test logon -> set password -> ensure profile -> set and read
/// the shell value with the user signed out -> delete the user and its profile.
#[test]
#[ignore = "changes accounts and the registry: run on the test VM only"]
fn account_lifecycle() {
    require_vm();
    cleanup();

    let sid = create_standard_user(TEST_USER, "Rulebox VM test", "Rulebox VM test account", TEST_PASSWORD_1)
        .expect("create_standard_user");

    let found = find_user(TEST_USER).unwrap().expect("find_user after create");
    assert_eq!(found.sid, sid);
    assert!(!found.disabled);
    assert!(!found.is_admin, "a standard user must not be an administrator");
    assert_eq!(found.comment, "Rulebox VM test account");

    assert!(matches!(
        create_standard_user(TEST_USER, "x", "x", TEST_PASSWORD_1),
        Err(Win32Error::AlreadyExists)
    ));

    assert!(test_logon(TEST_USER, TEST_PASSWORD_1).unwrap(), "the right password must log on");
    assert!(!test_logon(TEST_USER, "definitely-wrong-Passw0rd!").unwrap(), "a wrong password must not");

    set_password(TEST_USER, TEST_PASSWORD_2).expect("set_password");
    assert!(test_logon(TEST_USER, TEST_PASSWORD_2).unwrap(), "the new password must log on");

    let profile = ensure_profile(&sid, TEST_USER).expect("ensure_profile");
    assert!(profile.join("NTUSER.DAT").exists(), "the profile has a registry hive: {}", profile.display());
    // A second call finds the existing profile.
    assert_eq!(ensure_profile(&sid, TEST_USER).unwrap(), profile);

    // Shell value and a per-user policy, with the user signed out (hive loaded and unloaded).
    for mechanism in [Mechanism::PolicyShell, Mechanism::WinlogonShell] {
        let command = r#""C:\Program Files\Rulebox\rulebox-shell.exe""#;
        set_user_shell(&sid, &profile, mechanism, Some(command)).expect("set_user_shell");
        assert_eq!(get_user_shell(&sid, &profile, mechanism).unwrap().as_deref(), Some(command));
        set_user_shell(&sid, &profile, mechanism, None).expect("delete shell value");
        assert_eq!(get_user_shell(&sid, &profile, mechanism).unwrap(), None);
    }
    set_user_policy_dword(&sid, &profile, "DisableLockWorkstation", Some(1)).expect("set policy");
    set_user_policy_dword(&sid, &profile, "DisableLockWorkstation", None).expect("delete policy");

    // The temporary hive must not stay mounted (it would break the next sign-in).
    let loaded = std::process::Command::new("reg")
        .args(["query", r"HKU\RuleboxStaffTmp"])
        .output()
        .expect("run reg.exe");
    assert!(!loaded.status.success(), "HKU\\RuleboxStaffTmp is still loaded");

    delete_user_and_profile(&sid, TEST_USER).expect("delete_user_and_profile");
    assert!(find_user(TEST_USER).unwrap().is_none());
    assert!(!profile.exists(), "the profile folder must be gone: {}", profile.display());
}

/// Refuses to touch an administrator account.
#[test]
#[ignore = "needs the test VM"]
fn administrator_accounts_are_refused() {
    require_vm();
    let admins = rulebox_win32::accounts::enabled_local_admins().expect("list admins");
    let admin = admins.first().expect("the VM has a local administrator");
    assert!(matches!(set_password(&admin.name, "Whatever!1-Passw0rd"), Err(Win32Error::Invalid(_))));
    assert!(matches!(
        delete_user_and_profile(&admin.sid, &admin.name),
        Err(Win32Error::Invalid(_))
    ));
}

/// Set -> get -> delete -> get on a throwaway secret name.
#[test]
#[ignore = "writes an LSA secret: run on the test VM only"]
fn lsa_secret_round_trip() {
    require_vm();
    secret_set(TEST_SECRET, None).expect("start clean");
    assert_eq!(secret_get(TEST_SECRET).unwrap(), None);

    secret_set(TEST_SECRET, Some("first value")).expect("set");
    assert_eq!(secret_get(TEST_SECRET).unwrap().as_deref(), Some("first value"));
    secret_set(TEST_SECRET, Some("second value")).expect("overwrite");
    assert_eq!(secret_get(TEST_SECRET).unwrap().as_deref(), Some("second value"));

    secret_set(TEST_SECRET, None).expect("delete");
    assert_eq!(secret_get(TEST_SECRET).unwrap(), None);
    // Deleting twice is fine.
    secret_set(TEST_SECRET, None).expect("delete again");
}

/// DPAPI with the machine's SYSTEM key: run this one as SYSTEM
/// (`psexec -s` or a scheduled task), because that is who the agent is.
#[test]
#[ignore = "run as SYSTEM on the test VM"]
fn dpapi_round_trip_as_system() {
    require_vm();
    let secret = b"rulebox dpapi round trip";
    let blob = dpapi::protect(secret).expect("protect");
    assert_ne!(blob.as_slice(), secret.as_slice());
    assert_eq!(dpapi::unprotect(&blob).expect("unprotect"), secret);

    let mut tampered = blob.clone();
    let last = tampered.len() - 1;
    tampered[last] ^= 0xFF;
    assert!(dpapi::unprotect(&tampered).is_err());
}
