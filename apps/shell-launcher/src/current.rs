//! `current.json` parsing and path validation (plan Sections 4.3 and 6.9).
//!
//! The file names the Staff App to start: `{ "version": "...", "exe": "versions\\<v>\\rulebox-staff.exe" }`.
//! `exe` is relative to the install directory. It is rejected when it is absolute,
//! has any `..` component, does not sit inside `<install>\versions\<version dir>\`,
//! or does not exist. The only I/O is the existence and containment check at the end.

use std::path::{Component, Path, PathBuf};

use serde::Deserialize;

/// Longest `version` text accepted (it is only shown in the log).
const MAX_VERSION_LEN: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Current {
    pub version: String,
    /// Absolute path of the Staff App, validated to sit under `<install>\versions\`.
    pub exe: PathBuf,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CurrentError {
    /// Not JSON, a field missing, or an empty or unusable value.
    Parse,
    /// `exe` is absolute (drive, UNC, rooted or drive-relative).
    AbsolutePath,
    /// `exe` contains `..`, or a link inside `versions\` leads out of it.
    Escapes,
    /// `exe` is not `versions\<directory>\<file>`, or has characters Windows paths cannot have.
    NotUnderVersions,
    /// The file does not exist.
    Missing,
}

impl CurrentError {
    /// One short sentence for the fallback screen and the log.
    pub fn describe(self) -> &'static str {
        match self {
            CurrentError::Parse => "The Rulebox version file (current.json) is damaged.",
            CurrentError::AbsolutePath | CurrentError::Escapes | CurrentError::NotUnderVersions => {
                "The Rulebox version file (current.json) points outside the install folder."
            }
            CurrentError::Missing => "The Staff App file named in current.json is missing.",
        }
    }
}

#[derive(Deserialize)]
struct Raw {
    version: String,
    exe: String,
}

/// Validates `json` against `install_dir` and returns the Staff App to start.
pub fn resolve(install_dir: &Path, json: &str) -> Result<Current, CurrentError> {
    let raw: Raw = serde_json::from_str(json).map_err(|_| CurrentError::Parse)?;
    let version = raw.version.trim();
    if version.is_empty()
        || version.chars().count() > MAX_VERSION_LEN
        || version.chars().any(char::is_control)
        || raw.exe.trim().is_empty()
        || raw.exe.contains('\0')
    {
        return Err(CurrentError::Parse);
    }

    let parts = relative_parts(&raw.exe)?;
    // versions \ <directory> \ <file>
    let under_versions = parts.len() >= 3 && parts[0].eq_ignore_ascii_case("versions");
    if !under_versions {
        return Err(CurrentError::NotUnderVersions);
    }

    let mut exe = install_dir.to_path_buf();
    exe.extend(&parts);
    if !exe.is_file() {
        return Err(CurrentError::Missing);
    }

    // A junction or symlink inside `versions\` must not lead out of it. The Staff
    // account cannot write there, but the check costs nothing.
    let canonical_exe = exe.canonicalize().map_err(|_| CurrentError::Missing)?;
    let canonical_versions =
        install_dir.join("versions").canonicalize().map_err(|_| CurrentError::Missing)?;
    if !canonical_exe.starts_with(&canonical_versions) {
        return Err(CurrentError::Escapes);
    }

    Ok(Current { version: version.to_string(), exe })
}

/// Splits `exe` into plain components, refusing everything that is not one.
fn relative_parts(exe: &str) -> Result<Vec<String>, CurrentError> {
    let mut parts = Vec::new();
    for component in Path::new(exe).components() {
        match component {
            Component::Prefix(_) | Component::RootDir => return Err(CurrentError::AbsolutePath),
            Component::ParentDir => return Err(CurrentError::Escapes),
            Component::CurDir => {}
            Component::Normal(name) => {
                let name = name.to_str().ok_or(CurrentError::NotUnderVersions)?;
                // Drive letters in the middle, alternate data streams, wildcards and
                // control characters are never part of a real file name here.
                if name.chars().any(|c| c.is_control() || ":*?\"<>|".contains(c)) {
                    return Err(CurrentError::NotUnderVersions);
                }
                parts.push(name.to_string());
            }
        }
    }
    Ok(parts)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    /// A scratch install directory that removes itself.
    struct TempInstall(PathBuf);

    impl TempInstall {
        fn new() -> Self {
            static COUNTER: AtomicU32 = AtomicU32::new(0);
            let n = COUNTER.fetch_add(1, Ordering::Relaxed);
            let dir = std::env::temp_dir().join(format!("rulebox-shell-test-{}-{n}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(dir.join("versions").join("1.2.3")).unwrap();
            std::fs::write(dir.join("versions").join("1.2.3").join("rulebox-staff.exe"), b"").unwrap();
            std::fs::write(dir.join("outside.exe"), b"").unwrap();
            Self(dir)
        }
    }

    impl Drop for TempInstall {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn json(exe: &str) -> String {
        serde_json::json!({ "version": "1.2.3", "exe": exe }).to_string()
    }

    #[test]
    fn a_good_file_resolves_to_an_absolute_path() {
        let dir = TempInstall::new();
        let current = resolve(&dir.0, &json(r"versions\1.2.3\rulebox-staff.exe")).unwrap();
        assert_eq!(current.version, "1.2.3");
        assert!(current.exe.is_absolute());
        assert_eq!(current.exe, dir.0.join("versions").join("1.2.3").join("rulebox-staff.exe"));
    }

    #[test]
    fn forward_slashes_dot_components_and_case_are_accepted() {
        let dir = TempInstall::new();
        let current = resolve(&dir.0, &json("./Versions/1.2.3/rulebox-staff.exe")).unwrap();
        assert!(current.exe.is_file());
    }

    #[test]
    fn extra_fields_are_ignored() {
        let dir = TempInstall::new();
        let text = r#"{"version":"1.2.3","exe":"versions\\1.2.3\\rulebox-staff.exe","note":"x"}"#;
        assert!(resolve(&dir.0, text).is_ok());
    }

    #[test]
    fn absolute_paths_are_rejected() {
        let dir = TempInstall::new();
        let absolute = dir.0.join("outside.exe");
        for exe in [
            absolute.to_str().unwrap(),
            r"C:\Windows\System32\cmd.exe",
            r"\Windows\System32\cmd.exe",
            r"C:cmd.exe",
            r"\\server\share\x.exe",
        ] {
            assert_eq!(resolve(&dir.0, &json(exe)), Err(CurrentError::AbsolutePath), "{exe}");
        }
    }

    #[test]
    fn parent_directory_components_are_rejected() {
        let dir = TempInstall::new();
        for exe in [
            r"..\outside.exe",
            r"versions\..\outside.exe",
            r"versions\1.2.3\..\..\outside.exe",
            r"versions\1.2.3\..\1.2.3\rulebox-staff.exe",
        ] {
            assert_eq!(resolve(&dir.0, &json(exe)), Err(CurrentError::Escapes), "{exe}");
        }
    }

    #[test]
    fn paths_outside_versions_are_rejected() {
        let dir = TempInstall::new();
        for exe in [
            "outside.exe",
            r"other\1.2.3\rulebox-staff.exe",
            r"versions\rulebox-staff.exe",
            r"versions",
            r"versions\1.2.3\rulebox-staff.exe:stream",
            r"versions\1.2.3\*.exe",
        ] {
            assert_eq!(resolve(&dir.0, &json(exe)), Err(CurrentError::NotUnderVersions), "{exe}");
        }
    }

    #[test]
    fn bad_json_and_bad_values_are_parse_errors() {
        let dir = TempInstall::new();
        for text in [
            "",
            "not json",
            "[]",
            r#"{"version":"1.2.3"}"#,
            r#"{"exe":"versions\\1.2.3\\rulebox-staff.exe"}"#,
            r#"{"version":"","exe":"versions\\1.2.3\\rulebox-staff.exe"}"#,
            r#"{"version":"1.2.3","exe":""}"#,
            r#"{"version":1,"exe":"versions\\1.2.3\\rulebox-staff.exe"}"#,
        ] {
            assert_eq!(resolve(&dir.0, text), Err(CurrentError::Parse), "{text}");
        }
    }

    #[test]
    fn a_missing_exe_is_reported() {
        let dir = TempInstall::new();
        assert_eq!(
            resolve(&dir.0, &json(r"versions\9.9.9\rulebox-staff.exe")),
            Err(CurrentError::Missing)
        );
        // A directory is not an exe either.
        assert_eq!(resolve(&dir.0, &json(r"versions\1.2.3\sub")), Err(CurrentError::Missing));
    }

    #[test]
    fn every_error_has_a_sentence() {
        for error in [
            CurrentError::Parse,
            CurrentError::AbsolutePath,
            CurrentError::Escapes,
            CurrentError::NotUnderVersions,
            CurrentError::Missing,
        ] {
            assert!(error.describe().ends_with('.'));
        }
    }
}
