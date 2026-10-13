//! Install and data paths (plan Section 4.3). Real paths come from the known
//! folders; nothing here contains a literal drive letter.

use std::path::{Path, PathBuf};

use anyhow::Context;

/// Folder name under Program Files and ProgramData.
const VENDOR_DIR: &str = "Rulebox";

/// `%ProgramFiles%\Rulebox\`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstallPaths {
    root: PathBuf,
}

impl InstallPaths {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    pub fn from_known_folders() -> anyhow::Result<Self> {
        let program_files = rulebox_win32::folders::program_files().context("Program Files folder")?;
        Ok(Self::new(program_files.join(VENDOR_DIR)))
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn agent_exe(&self) -> PathBuf {
        self.root.join("rulebox-agent.exe")
    }

    pub fn shell_exe(&self) -> PathBuf {
        self.root.join("rulebox-shell.exe")
    }

    pub fn current_json(&self) -> PathBuf {
        self.root.join("current.json")
    }

    pub fn versions_dir(&self) -> PathBuf {
        self.root.join("versions")
    }
}

/// `%ProgramData%\Rulebox\`, or the simulate-mode data directory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DataPaths {
    root: PathBuf,
}

impl DataPaths {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    pub fn from_known_folders() -> anyhow::Result<Self> {
        let program_data = rulebox_win32::folders::program_data().context("ProgramData folder")?;
        Ok(Self::new(program_data.join(VENDOR_DIR)))
    }

    /// `<repo or cwd>\target\sim-data\`. Inside `target\`, so git ignores it and
    /// `cargo clean` removes it.
    pub fn simulate_default() -> anyhow::Result<Self> {
        let cwd = std::env::current_dir().context("current directory")?;
        let base = cwd
            .ancestors()
            .find(|dir| dir.join("Cargo.toml").is_file() && dir.join("target").is_dir())
            .unwrap_or(&cwd);
        Ok(Self::new(base.join("target").join("sim-data")))
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn state_dir(&self) -> PathBuf {
        self.root.join("state")
    }

    pub fn agent_state(&self) -> PathBuf {
        self.state_dir().join("agent-state.json")
    }

    pub fn secrets(&self) -> PathBuf {
        self.state_dir().join("secrets.bin")
    }

    pub fn desired_state(&self) -> PathBuf {
        self.state_dir().join("desired-state.json")
    }

    pub fn agent_config(&self) -> PathBuf {
        self.state_dir().join("agent-config.json")
    }

    /// (1.1) Failure counters and lock times for the exit PIN and employee passwords.
    pub fn lockouts(&self) -> PathBuf {
        self.state_dir().join("lockouts.json")
    }

    /// (1.1) The offline sign-in cache.
    pub fn employee_cache(&self) -> PathBuf {
        self.state_dir().join("employee-cache.json")
    }

    /// (1.1) Audit records the backend has not accepted yet.
    pub fn audit_queue(&self) -> PathBuf {
        self.state_dir().join("audit-queue.json")
    }

    /// (1.1) Simulate mode only: the files base the demo employees get (the real
    /// base is `<Staff profile>\RuleboxFiles`). The agent only names it.
    pub fn sim_files(&self) -> PathBuf {
        self.root.join("sim-files")
    }

    pub fn logs_dir(&self) -> PathBuf {
        self.root.join("logs")
    }
}

/// What to do with the data directory at startup (plan Section 5.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DataDirAction {
    /// Already safe.
    Use,
    /// Does not exist: create it with the protected DACL.
    Create,
    /// Owned by SYSTEM or Administrators, empty, DACL differs: replace the DACL.
    FixDacl,
    /// Owned by someone else but empty: remove it and create it again.
    Recreate,
    /// Not safe and not empty (or a reparse point): start nothing.
    Refuse(&'static str),
}

/// The table of plan Section 5.1, as a pure function of what `verify_protected_dir`
/// found and whether the directory is empty.
pub fn data_dir_action(check: &rulebox_win32::security::DirCheck, is_empty: bool) -> DataDirAction {
    use rulebox_win32::sid::Sid;

    if !check.exists {
        return DataDirAction::Create;
    }
    if check.is_reparse_point {
        return DataDirAction::Refuse("it is a reparse point (link or junction)");
    }
    if check.is_ok() {
        return DataDirAction::Use;
    }
    let owned_by_admins = check
        .owner
        .as_ref()
        .is_some_and(|owner| *owner == Sid::system() || *owner == Sid::builtin_admins());
    match (owned_by_admins, is_empty) {
        (true, true) => DataDirAction::FixDacl,
        (false, true) => DataDirAction::Recreate,
        (true, false) => DataDirAction::Refuse("its permissions are wrong and it is not empty"),
        (false, false) => DataDirAction::Refuse("it is owned by another account and it is not empty"),
    }
}

#[cfg(test)]
mod tests {
    use rulebox_win32::security::DirCheck;
    use rulebox_win32::sid::Sid;

    use super::*;

    fn check(exists: bool, reparse: bool, owner: Option<Sid>, dacl_matches: bool) -> DirCheck {
        DirCheck { exists, is_reparse_point: reparse, owner, dacl_matches }
    }

    fn user() -> Option<Sid> {
        Some(Sid::parse("S-1-5-21-1111-2222-3333-1001").unwrap())
    }

    #[test]
    fn data_dir_action_follows_the_section_5_1_table() {
        let system = Some(Sid::system());
        let admins = Some(Sid::builtin_admins());

        // Missing -> Create (empty or not is moot).
        assert_eq!(data_dir_action(&check(false, false, None, false), true), DataDirAction::Create);
        // Reparse point, empty or not -> Refuse.
        for empty in [true, false] {
            assert!(matches!(
                data_dir_action(&check(true, true, system.clone(), true), empty),
                DataDirAction::Refuse(_)
            ));
        }
        // OK -> Use, empty or not, for either trusted owner.
        for owner in [system.clone(), admins.clone()] {
            for empty in [true, false] {
                assert_eq!(data_dir_action(&check(true, false, owner.clone(), true), empty), DataDirAction::Use);
            }
        }
        // Trusted owner, DACL differs: empty -> FixDacl, otherwise Refuse.
        assert_eq!(data_dir_action(&check(true, false, system.clone(), false), true), DataDirAction::FixDacl);
        assert!(matches!(
            data_dir_action(&check(true, false, admins, false), false),
            DataDirAction::Refuse(_)
        ));
        // A normal user owns it: empty -> Recreate, otherwise Refuse (even with a matching DACL).
        assert_eq!(data_dir_action(&check(true, false, user(), false), true), DataDirAction::Recreate);
        assert_eq!(data_dir_action(&check(true, false, user(), true), true), DataDirAction::Recreate);
        assert!(matches!(
            data_dir_action(&check(true, false, user(), false), false),
            DataDirAction::Refuse(_)
        ));
        // An owner that cannot be read is untrusted.
        assert_eq!(data_dir_action(&check(true, false, None, false), true), DataDirAction::Recreate);
    }

    #[test]
    fn layout_under_a_root() {
        let install = InstallPaths::new(PathBuf::from("root").join("Rulebox"));
        assert!(install.agent_exe().ends_with("Rulebox/rulebox-agent.exe"));
        assert!(install.shell_exe().ends_with("rulebox-shell.exe"));
        assert!(install.current_json().ends_with("current.json"));
        assert!(install.versions_dir().ends_with("versions"));

        let data = DataPaths::new(PathBuf::from("data"));
        assert!(data.agent_state().ends_with("state/agent-state.json"));
        assert!(data.secrets().ends_with("state/secrets.bin"));
        assert!(data.desired_state().ends_with("state/desired-state.json"));
        assert!(data.agent_config().ends_with("state/agent-config.json"));
        assert!(data.logs_dir().ends_with("logs"));
        assert!(data.lockouts().ends_with("state/lockouts.json"));
        assert!(data.employee_cache().ends_with("state/employee-cache.json"));
        assert!(data.audit_queue().ends_with("state/audit-queue.json"));
        assert!(data.sim_files().ends_with("sim-files"));
    }

    #[test]
    fn real_paths_come_from_the_known_folders() {
        let install = InstallPaths::from_known_folders().unwrap();
        let data = DataPaths::from_known_folders().unwrap();
        let program_files = std::env::var_os("ProgramFiles").unwrap();
        let program_data = std::env::var_os("ProgramData").unwrap();
        assert!(same(install.root(), Path::new(&program_files).join("Rulebox")));
        assert!(same(data.root(), Path::new(&program_data).join("Rulebox")));
    }

    #[test]
    fn simulate_default_is_inside_target() {
        let data = DataPaths::simulate_default().unwrap();
        assert!(data.root().ends_with("target/sim-data"));
    }

    fn same(a: &Path, b: PathBuf) -> bool {
        a.to_string_lossy().eq_ignore_ascii_case(&b.to_string_lossy())
    }
}
