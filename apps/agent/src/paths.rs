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

#[cfg(test)]
mod tests {
    use super::*;

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
