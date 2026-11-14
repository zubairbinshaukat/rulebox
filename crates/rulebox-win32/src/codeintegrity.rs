//! App Control (Windows Defender Application Control) policy files (plan 4.5, 4.9, Step 6).
//!
//! A multiple-policy-format policy is a binary `{PolicyId}.cip` in
//! `%SystemRoot%\System32\CodeIntegrity\CiPolicies\Active\`. Deploying one copies the file
//! there and removing one deletes it; the policy takes effect as the system refreshes
//! (`CiTool --update-policy` or a restart, Step 6 decides, **unverified**).
//!
//! Only files whose name is a GUID are ever created or deleted here, and only in that one
//! folder, so a policy id can never name another path. Rulebox ids are told from other
//! policies by the agent (it keeps the ids it deployed in the journal), not here.

use std::path::PathBuf;

use crate::error::{Result, Win32Error};
use crate::guard::require_test_machine;

/// `CiPolicies\Active` below the Windows folder.
const ACTIVE_RELATIVE: &str = r"System32\CodeIntegrity\CiPolicies\Active";

fn system_root() -> Result<PathBuf> {
    std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .ok_or_else(|| Win32Error::Invalid("the Windows folder is not known".into()))
}

/// The folder the active policies live in.
pub fn active_dir() -> Result<PathBuf> {
    Ok(system_root()?.join(ACTIVE_RELATIVE))
}

/// A policy id as a canonical lowercase GUID without braces (`8-4-4-4-12` hex digits), or
/// `Forbidden`. Anything else (a path, a wildcard, a stream name) never reaches the disk.
pub fn check_policy_id(policy_id: &str) -> Result<String> {
    let text = policy_id.trim().trim_start_matches('{').trim_end_matches('}');
    let parts: Vec<&str> = text.split('-').collect();
    let shape = [8usize, 4, 4, 4, 12];
    let ok = parts.len() == shape.len()
        && parts.iter().zip(shape).all(|(part, len)| part.len() == len && part.bytes().all(|b| b.is_ascii_hexdigit()));
    if ok {
        Ok(text.to_ascii_lowercase())
    } else {
        Err(Win32Error::Forbidden("a policy id must be a GUID".into()))
    }
}

fn file_name(id: &str) -> String {
    format!("{{{id}}}.cip")
}

/// Writes `{policy_id}.cip` into the active folder (a temporary file first, then a rename
/// that does not return before it is on disk). An existing policy with that id is replaced.
///
/// DESTRUCTIVE: guarded.
pub fn deploy_policy(policy_id: &str, binary: &[u8]) -> Result<()> {
    let id = check_policy_id(policy_id)?;
    require_test_machine()?;
    if binary.is_empty() {
        return Err(Win32Error::Invalid("an empty policy file".into()));
    }
    let dir = active_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| Win32Error::Invalid(format!("cannot create the policy folder: {e}")))?;
    let target = dir.join(file_name(&id));
    let temp = dir.join(format!("{{{id}}}.cip.rulebox-tmp"));
    std::fs::write(&temp, binary).map_err(|e| Win32Error::Invalid(format!("cannot write the policy file: {e}")))?;
    crate::atomic::replace_file_write_through(&temp, &target).inspect_err(|_| {
        let _ = std::fs::remove_file(&temp);
    })
}

/// `CREATE_NO_WINDOW`.
const NO_WINDOW: u32 = 0x0800_0000;

/// `CiTool.exe` in `System32` (in the Windows image since Windows 11 22H2, plan 4.9), if
/// this Windows has it.
fn citool_exe() -> Option<PathBuf> {
    let path = system_root().ok()?.join("System32").join("CiTool.exe");
    path.is_file().then_some(path)
}

/// Whether this Windows has `CiTool.exe` (read-only).
pub fn citool_available() -> bool {
    citool_exe().is_some()
}

/// Runs `CiTool.exe` with a fixed argument list (never text from outside: a policy id has
/// passed [`check_policy_id`] and is the only variable part).
fn run_citool(args: &[&str]) -> Result<()> {
    use std::os::windows::process::CommandExt;
    let exe = citool_exe().ok_or_else(|| Win32Error::Invalid("CiTool is not available on this Windows".into()))?;
    let output = std::process::Command::new(exe)
        .args(args)
        .creation_flags(NO_WINDOW)
        .output()
        .map_err(|e| Win32Error::Api { api: "CiTool", code: e.raw_os_error().map_or(0, |c| c as u32) })?;
    if output.status.success() {
        Ok(())
    } else {
        Err(Win32Error::Invalid(format!("CiTool stopped with code {}", output.status.code().unwrap_or(-1))))
    }
}

/// The bytes of `{policy_id}.cip` in the active folder. `Ok(None)`: no such file.
/// Read-only. Policy files are a few hundred KB at most; a larger file is refused.
pub fn read_policy(policy_id: &str) -> Result<Option<Vec<u8>>> {
    const MAX_POLICY_BYTES: u64 = 8 * 1024 * 1024;
    let id = check_policy_id(policy_id)?;
    let path = active_dir()?.join(file_name(&id));
    match std::fs::metadata(&path) {
        Ok(meta) if meta.len() > MAX_POLICY_BYTES => Err(Win32Error::Invalid("the policy file is too large".into())),
        Ok(_) => match std::fs::read(&path) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(Win32Error::Invalid(format!("cannot read the policy file: {e}"))),
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(Win32Error::Invalid(format!("cannot read the policy file: {e}"))),
    }
}

/// Asks Windows to load the policies of the active folder now (`CiTool --refresh`,
/// Windows 11 22H2 and later). `Err` when CiTool is missing or fails; the policy then takes
/// effect at the next restart. Whether `--refresh` also drops a policy whose file was
/// removed is **unverified** (settled in the VM run, Step 21).
///
/// DESTRUCTIVE: guarded.
pub fn refresh() -> Result<()> {
    require_test_machine()?;
    run_citool(&["--refresh"])
}

/// Removes `{policy_id}`: through `CiTool --remove-policy` when this Windows has it (its
/// failure is ignored: the policy may be unknown to it, for example one that was only
/// written to the folder), then deletes the file (a file that is not there is fine).
///
/// DESTRUCTIVE: guarded.
pub fn remove_policy(policy_id: &str) -> Result<()> {
    let id = check_policy_id(policy_id)?;
    require_test_machine()?;
    if citool_available() {
        let braced = format!("{{{id}}}");
        let _ = run_citool(&["--remove-policy", &braced]);
    }
    let target = active_dir()?.join(file_name(&id));
    match std::fs::remove_file(&target) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(Win32Error::Invalid(format!("cannot delete the policy file: {e}"))),
    }
}

/// The ids (lowercase GUIDs, no braces) of the `.cip` files in the active folder, sorted.
/// Read-only. A missing folder is an empty list.
pub fn list_policies() -> Result<Vec<String>> {
    let dir = active_dir()?;
    let entries = match std::fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(Win32Error::Invalid(format!("cannot read the policy folder: {e}"))),
    };
    let mut ids: Vec<String> = entries
        .filter_map(std::result::Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let stem = name.strip_suffix(".cip").or_else(|| name.strip_suffix(".CIP"))?;
            check_policy_id(stem).ok()
        })
        .collect();
    ids.sort();
    Ok(ids)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn policy_ids_are_guids_only() {
        assert_eq!(
            check_policy_id("{8A6EB3CD-BA2E-4A97-A1F9-4F4A3B1C0001}").unwrap(),
            "8a6eb3cd-ba2e-4a97-a1f9-4f4a3b1c0001"
        );
        assert_eq!(
            check_policy_id("8a6eb3cd-ba2e-4a97-a1f9-4f4a3b1c0001").unwrap(),
            "8a6eb3cd-ba2e-4a97-a1f9-4f4a3b1c0001"
        );
        for bad in [
            "",
            "policy",
            r"..\..\Windows\System32\x",
            "8a6eb3cd-ba2e-4a97-a1f9-4f4a3b1c000",
            "8a6eb3cd-ba2e-4a97-a1f9-4f4a3b1c00010",
            "8a6eb3cd-ba2e-4a97-a1f9-4f4a3b1c000g",
            "8a6eb3cd-ba2e-4a97-a1f9-4f4a3b1c0001.cip",
            "*",
            "8a6eb3cd-ba2e-4a97-a1f9-4f4a3b1c0001:stream",
        ] {
            assert!(matches!(check_policy_id(bad), Err(Win32Error::Forbidden(_))), "{bad:?}");
        }
    }

    #[test]
    fn a_bad_id_is_refused_before_the_guard() {
        assert!(matches!(deploy_policy("../x", b"x"), Err(Win32Error::Forbidden(_))));
        assert!(matches!(remove_policy("../x"), Err(Win32Error::Forbidden(_))));
    }

    #[test]
    fn deploy_remove_and_refresh_meet_the_guard_on_the_dev_machine() {
        if crate::guard::is_test_machine() {
            return;
        }
        let id = "8a6eb3cd-ba2e-4a97-a1f9-4f4a3b1c0001";
        assert!(matches!(deploy_policy(id, b"x"), Err(Win32Error::Guard(_))));
        assert!(matches!(remove_policy(id), Err(Win32Error::Guard(_))));
        assert!(matches!(refresh(), Err(Win32Error::Guard(_))));
    }

    #[test]
    fn reading_a_policy_needs_a_guid() {
        assert!(matches!(read_policy("..\\x"), Err(Win32Error::Forbidden(_))));
        assert!(matches!(read_policy(""), Err(Win32Error::Forbidden(_))));
    }

    /// Reads the real folder; never writes. Run by hand.
    #[test]
    #[ignore = "reads the real CodeIntegrity folder"]
    fn smoke_list_policies() {
        let ids = list_policies().unwrap();
        println!("{ids:?}");
    }
}
