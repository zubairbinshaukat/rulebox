//! (Phase 5 Step 14b) The pure parts of the driver installs: what a record holds, how a driver of the signed document is
//! checked again on the PC, the command lines, and how an INF names its catalog. No I/O and no `Engine` here, so all
//! of it is tested on its own; the engine's part is `drivers.rs`.
//!
//! A driver is **never an app**: it has no tile, no audience, no program to wait for. It rides the install engine (same
//! downloads, locked verified file, job-object run, 3010 / 1641 restart rule, retries) and its results go to the server
//! through the same install report channel, with the driver's id where an app's would be.

use std::path::{Path, PathBuf};

use rulebox_policy::network::DriverKind;
use rulebox_policy::paths::check_args;
use rulebox_policy::network::DriverSpec;
use serde::{Deserialize, Serialize};

use super::download::check_https;
use super::engine::{backoff_after, LocalState};
use super::unzip::safe_entry_name;
use super::{is_safe_id, is_sha256, msi_install_command, pnputil_path, Detail, MAX_DOWNLOAD_BYTES};
use crate::backend::{InstallReport, InstallState};
use crate::installs::MAX_FAILURES;
use crate::platform::InstallerCommand;

/// Most packages one driver record remembers (each new version of an INF package adds one; the oldest are forgotten, which
/// only means Rulebox no longer removes them).
pub const MAX_PACKAGES: usize = 8;
/// Longest INF Rulebox reads for its `CatalogFile=` lines.
pub const MAX_INF_BYTES: usize = 4 * 1024 * 1024;

/// What the downloaded file is.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DriverRecordKind {
    Inf,
    Exe,
    Msi,
}

impl DriverRecordKind {
    pub fn of_spec(kind: DriverKind) -> Option<Self> {
        match kind {
            DriverKind::Inf => Some(Self::Inf),
            DriverKind::Exe => Some(Self::Exe),
            DriverKind::Msi => Some(Self::Msi),
            DriverKind::Unknown => None,
        }
    }

    /// The extension of the downloaded file.
    pub fn ext(self) -> &'static str {
        match self {
            Self::Inf => "zip",
            Self::Exe => "exe",
            Self::Msi => "msi",
        }
    }
}

/// A package Rulebox put into the driver store: the name Windows gave it and the SHA-256 of that `oem<N>.inf` file, so
/// that a later removal only ever touches the very file Rulebox published (Windows reuses an `oem<N>.inf` name after a
/// package was deleted by someone else).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DriverPackage {
    pub published: String,
    pub sha256: String,
}

/// One driver in `installs.json` (`drivers`). A file written before Step 14b has no such map.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DriverRecord {
    pub driver_id: String,
    pub kind: DriverRecordKind,
    pub sha256: String,
    /// The signed entry's revision this record follows (a new revision on a failed record is the dashboard's Retry).
    pub revision: u64,
    pub state: LocalState,
    #[serde(default)]
    pub attempts: u32,
    #[serde(default)]
    pub next_try_ms: u64,
    #[serde(default)]
    pub last_exit_code: Option<i64>,
    #[serde(default)]
    pub detail: Option<String>,
    /// Packages Rulebox published for this driver (INF drivers only); the only things a removal may delete.
    #[serde(default)]
    pub packages: Vec<DriverPackage>,
    /// True once the driver left the document and this record is its removal.
    #[serde(default)]
    pub removal: bool,
    #[serde(default)]
    pub reported: Option<InstallReport>,
    #[serde(default)]
    pub acked: bool,
    #[serde(default)]
    pub busy_since_ms: Option<u64>,
}

impl DriverRecord {
    pub fn new(driver_id: &str, kind: DriverRecordKind, sha256: &str, revision: u64, state: LocalState) -> Self {
        Self {
            driver_id: driver_id.to_string(),
            kind,
            sha256: sha256.to_string(),
            revision,
            state,
            attempts: 0,
            next_try_ms: 0,
            last_exit_code: None,
            detail: None,
            packages: Vec::new(),
            removal: false,
            reported: None,
            acked: false,
            busy_since_ms: None,
        }
    }

    /// Whether an operation is waiting for this record (time aside).
    pub fn runnable(&self) -> bool {
        match self.state {
            LocalState::Pending => !self.removal,
            LocalState::Removing => self.removal,
            LocalState::Failed => self.attempts < MAX_FAILURES,
            _ => false,
        }
    }

    pub fn file_name(&self) -> String {
        format!("{}.{}", self.sha256, self.kind.ext())
    }

    /// Counts a failure.
    pub fn fail(&mut self, detail: Option<Detail>, exit_code: Option<i64>, now: u64) {
        self.attempts = self.attempts.saturating_add(1);
        self.state = LocalState::Failed;
        self.detail = detail.map(|d| d.as_str().to_string());
        self.last_exit_code = exit_code;
        let wait = backoff_after(self.attempts).map_or(0, |wait| u64::try_from(wait.as_millis()).unwrap_or(u64::MAX));
        self.next_try_ms = if wait == 0 { 0 } else { now.saturating_add(wait) };
    }

    /// Marks the current result as handed to the report queue; `None` for a state that stays local.
    pub fn mark(&mut self) -> Option<InstallReport> {
        let report = report_of(self)?;
        self.reported = Some(report.clone());
        self.acked = false;
        Some(report)
    }

    /// Adds a published package (once), forgetting the oldest beyond [`MAX_PACKAGES`].
    pub fn add_package(&mut self, package: DriverPackage) {
        if self.packages.iter().any(|p| p.published == package.published) {
            return;
        }
        self.packages.push(package);
        while self.packages.len() > MAX_PACKAGES {
            self.packages.remove(0);
        }
    }
}

/// The result a driver record stands for, when its state is one that is reported (same wire as an app's).
pub fn report_of(record: &DriverRecord) -> Option<InstallReport> {
    let state = match record.state {
        LocalState::Pending => InstallState::Pending,
        LocalState::Installed => InstallState::Installed,
        LocalState::Failed => InstallState::Failed,
        LocalState::Removed => InstallState::Removed,
        LocalState::Unsupported => InstallState::Unsupported,
        LocalState::Downloading | LocalState::Installing | LocalState::Removing => return None,
    };
    Some(InstallReport {
        app_id: record.driver_id.clone(),
        state,
        app_revision: record.revision,
        attempts: record.attempts,
        exit_code: record.last_exit_code,
        detail: record.detail.as_deref().and_then(Detail::parse).map(|d| d.as_str().to_string()),
        installed_version: None,
    })
}

/// What the engine installs, checked from a signed entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DriverPlan {
    pub kind: DriverRecordKind,
    pub url: String,
    pub sha256: String,
    pub size_bytes: u64,
    /// The `.inf` below the extraction folder (`Inf` only), forward slashes, checked.
    pub inf: Option<String>,
    pub silent_args: Vec<String>,
    pub success_exit_codes: Vec<i32>,
}

/// The `.inf` path of a zip entry, relative: plain components, at most 120 characters, ends in `.inf`.
pub fn inf_path_ok(inf: &str) -> bool {
    inf.chars().count() <= 120
        && !inf.ends_with('/')
        && inf.to_ascii_lowercase().ends_with(".inf")
        && safe_entry_name(inf).is_some()
}

/// Checks a driver of the signed document again on the PC (defence in depth: the document is signed). The reason names
/// no value.
pub fn check_driver(spec: &DriverSpec, system_root: Option<&str>) -> Result<DriverPlan, &'static str> {
    if !is_safe_id(&spec.id) {
        return Err("the driver id cannot name a file");
    }
    let kind = DriverRecordKind::of_spec(spec.kind).ok_or("unknown driver kind")?;
    check_https(&spec.url).map_err(|_| "the driver URL is not https://")?;
    if !is_sha256(&spec.sha256) {
        return Err("the driver hash is not a SHA-256");
    }
    if spec.size_bytes > MAX_DOWNLOAD_BYTES {
        return Err("the driver is larger than 4 GiB");
    }
    let mut inf = None;
    match kind {
        DriverRecordKind::Inf => {
            let text = spec.inf.as_deref().ok_or("an INF driver needs the path of its .inf")?;
            if !inf_path_ok(text) {
                return Err("the .inf path is not a plain relative path");
            }
            if system_root.is_none() {
                return Err("the Windows folder is not known (pnputil)");
            }
            inf = Some(text.to_string());
        }
        DriverRecordKind::Exe => {
            if spec.silent_args.is_empty() {
                return Err("an exe driver needs silent arguments");
            }
            check_args(&spec.silent_args).map_err(|_| "the silent arguments do not pass the rules")?;
        }
        DriverRecordKind::Msi => {
            if system_root.is_none() {
                return Err("the Windows folder is not known (msiexec)");
            }
        }
    }
    Ok(DriverPlan {
        kind,
        url: spec.url.clone(),
        sha256: spec.sha256.clone(),
        size_bytes: spec.size_bytes,
        inf,
        silent_args: if kind == DriverRecordKind::Exe { spec.silent_args.clone() } else { Vec::new() },
        success_exit_codes: spec.success_exit_codes.clone(),
    })
}

/// `pnputil /add-driver <inf> /install`, the one command line the program rule allows for an add
/// (`installer_command_allowed`).
pub fn pnputil_add_command(system_root: &Path, inf: &Path, working_dir: &Path) -> InstallerCommand {
    InstallerCommand {
        program: pnputil_path(system_root),
        args: vec!["/add-driver".into(), inf.to_string_lossy().into_owned(), "/install".into()],
        working_dir: working_dir.to_path_buf(),
        expected_exe: None,
        removal: false,
    }
}

/// A vendor exe with its silent arguments, one by one; there is no program to wait for.
pub fn exe_driver_command(file: &Path, silent_args: &[String], working_dir: &Path) -> InstallerCommand {
    InstallerCommand {
        program: file.to_path_buf(),
        args: silent_args.to_vec(),
        working_dir: working_dir.to_path_buf(),
        expected_exe: None,
        removal: false,
    }
}

/// `msiexec /i <file> /qn /norestart /l*v <log>`; there is no program to wait for.
pub fn msi_driver_command(system_root: &Path, file: &Path, log: &Path, working_dir: &Path) -> InstallerCommand {
    let mut command = msi_install_command(system_root, file, log, working_dir, Path::new(""));
    command.expected_exe = None;
    command
}

/// The text of an INF: UTF-16 with a byte order mark (most vendor INFs), UTF-8 with or without one, else the bytes as
/// Latin-1 (an ANSI INF; only ASCII matters for what is read here).
pub fn decode_inf(bytes: &[u8]) -> String {
    if let Some(rest) = bytes.strip_prefix(&[0xFF, 0xFE]) {
        return String::from_utf16_lossy(&rest.as_chunks::<2>().0.iter().map(|c| u16::from_le_bytes(*c)).collect::<Vec<_>>());
    }
    if let Some(rest) = bytes.strip_prefix(&[0xFE, 0xFF]) {
        return String::from_utf16_lossy(&rest.as_chunks::<2>().0.iter().map(|c| u16::from_be_bytes(*c)).collect::<Vec<_>>());
    }
    let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    match std::str::from_utf8(bytes) {
        Ok(text) => text.to_string(),
        Err(_) => bytes.iter().map(|b| char::from(*b)).collect(),
    }
}

/// The catalog files a `[Version]` section names: `CatalogFile=`, `CatalogFile.NT=`, `CatalogFile.NTamd64=` ... (a value
/// may be quoted and followed by a `;` comment). Empty when there is none. Names are returned as written.
pub fn catalog_files(inf: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut in_version = false;
    for line in inf.lines() {
        let line = line.trim();
        if let Some(section) = line.strip_prefix('[').and_then(|rest| rest.split(']').next()) {
            in_version = section.trim().eq_ignore_ascii_case("version");
            continue;
        }
        if !in_version || line.starts_with(';') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else { continue };
        let key = key.trim();
        let is_catalog = key.eq_ignore_ascii_case("catalogfile")
            || key.get(..12).is_some_and(|head| head.eq_ignore_ascii_case("catalogfile.") && key.len() > 12);
        if !is_catalog {
            continue;
        }
        let value = value.split(';').next().unwrap_or("").trim().trim_matches('"').trim();
        if !value.is_empty() && !out.iter().any(|name| name.eq_ignore_ascii_case(value)) {
            out.push(value.to_string());
        }
    }
    out
}

/// A catalog name that is a plain file name inside the INF's own folder: no separator, no `%string%` key, ends `.cat`.
pub fn catalog_name_ok(name: &str) -> bool {
    name.to_ascii_lowercase().ends_with(".cat") && !name.contains('%') && !name.contains('/') && safe_entry_name(name).is_some()
}

/// `<folder>\<inf>` for the pnputil command: the `.inf` path joined to the extraction folder one component at a time.
pub fn inf_file(work: &Path, inf: &str) -> PathBuf {
    let mut path = work.to_path_buf();
    for part in inf.split('/') {
        path.push(part);
    }
    path
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(kind: DriverKind) -> DriverSpec {
        DriverSpec {
            id: "drv1".into(),
            name: "Brother".into(),
            kind,
            url: "https://example.com/b.zip".into(),
            sha256: "a".repeat(64),
            size_bytes: 10,
            inf: (kind == DriverKind::Inf).then(|| "x64/brother.inf".into()),
            silent_args: if kind == DriverKind::Exe { vec!["/S".into()] } else { Vec::new() },
            success_exit_codes: vec![0],
            revision: 1,
            source: None,
        }
    }

    const ROOT: Option<&str> = Some(r"C:\Windows");

    #[test]
    fn a_good_driver_of_each_kind_passes() {
        for kind in [DriverKind::Inf, DriverKind::Exe, DriverKind::Msi] {
            assert!(check_driver(&spec(kind), ROOT).is_ok(), "{kind:?}");
        }
        let plan = check_driver(&spec(DriverKind::Inf), ROOT).unwrap();
        assert_eq!((plan.kind, plan.inf.as_deref()), (DriverRecordKind::Inf, Some("x64/brother.inf")));
        assert_eq!(DriverRecordKind::Inf.ext(), "zip");
    }

    #[test]
    fn a_bad_driver_is_refused_with_a_reason_that_names_no_value() {
        let bad = |change: &dyn Fn(&mut DriverSpec), kind| {
            let mut s = spec(kind);
            change(&mut s);
            check_driver(&s, ROOT)
        };
        assert!(bad(&|s| s.id = "a/b".into(), DriverKind::Inf).is_err());
        assert!(bad(&|s| s.url = "http://example.com/b.zip".into(), DriverKind::Inf).is_err());
        assert!(bad(&|s| s.sha256 = "ABC".into(), DriverKind::Inf).is_err());
        assert!(bad(&|s| s.size_bytes = MAX_DOWNLOAD_BYTES + 1, DriverKind::Inf).is_err());
        assert!(bad(&|_| {}, DriverKind::Unknown).is_err());
        for inf in ["", "a.exe", "../a.inf", "/a.inf", r"C:\a.inf", r"a\b.inf", "a/", "a:b/a.inf", "con.inf", "a/../b.inf"] {
            assert!(bad(&|s| s.inf = Some(inf.into()), DriverKind::Inf).is_err(), "{inf:?}");
        }
        assert!(bad(&|s| s.inf = None, DriverKind::Inf).is_err());
        assert!(bad(&|s| s.inf = Some(format!("{}.inf", "x".repeat(120))), DriverKind::Inf).is_err());
        assert!(bad(&|s| s.silent_args.clear(), DriverKind::Exe).is_err());
        assert!(bad(&|s| s.silent_args = vec!["a\nb".into()], DriverKind::Exe).is_err());
        assert!(check_driver(&spec(DriverKind::Inf), None).is_err());
        assert!(check_driver(&spec(DriverKind::Msi), None).is_err());
        let reason = check_driver(&DriverSpec { url: "http://secret.example/x".into(), ..spec(DriverKind::Inf) }, ROOT).unwrap_err();
        assert!(!reason.contains("secret"));
    }

    #[test]
    fn catalog_names_are_read_from_the_version_section_only() {
        let inf = "; comment\r\n[Version]\r\nSignature=\"$Windows NT$\"\r\nCatalogFile = brother.cat ; the catalog\r\nCatalogFile.NTamd64=\"brother64.cat\"\r\n\
                   [Other]\r\nCatalogFile=nope.cat\r\n[Strings]\r\nCatalogFile=nope2.cat";
        assert_eq!(catalog_files(inf), ["brother.cat", "brother64.cat"]);
        assert!(catalog_files("[Version]\nSignature=x\n").is_empty());
        assert!(catalog_files("[Manufacturer]\nCatalogFile=a.cat").is_empty());
        assert_eq!(catalog_files("[VERSION]\ncatalogfile=A.CAT\nCATALOGFILE=a.cat"), ["A.CAT"]);
        assert!(catalog_files("[Version]\nCatalogFileX=a.cat").is_empty());
        for bad in ["%CAT%", r"..\a.cat", "a/b.cat", "a.exe", "", "con.cat", "a.cat "] {
            assert!(!catalog_name_ok(bad), "{bad:?}");
        }
        assert!(catalog_name_ok("brother.cat") && catalog_name_ok("Brother HL.CAT"));
    }

    #[test]
    fn inf_text_is_decoded_from_utf16_utf8_and_ansi() {
        let text = "[Version]\nCatalogFile=a.cat\n";
        let mut utf16 = vec![0xFF, 0xFE];
        utf16.extend(text.encode_utf16().flat_map(u16::to_le_bytes));
        let mut be = vec![0xFE, 0xFF];
        be.extend(text.encode_utf16().flat_map(u16::to_be_bytes));
        let mut utf8 = vec![0xEF, 0xBB, 0xBF];
        utf8.extend(text.bytes());
        for bytes in [utf16, be, utf8, text.as_bytes().to_vec()] {
            assert_eq!(catalog_files(&decode_inf(&bytes)), ["a.cat"]);
        }
        assert_eq!(catalog_files(&decode_inf(b"[Version]\nCatalogFile=a.cat\n; caf\xe9\n")), ["a.cat"]);
    }

    #[test]
    fn the_record_reports_like_an_app_with_the_driver_id() {
        let mut record = DriverRecord::new("drv1", DriverRecordKind::Inf, &"b".repeat(64), 4, LocalState::Failed);
        record.fail(Some(Detail::UnsignedDriver), None, 1_000);
        let report = record.mark().unwrap();
        assert_eq!((report.app_id.as_str(), report.app_revision, report.attempts), ("drv1", 4, 1));
        assert_eq!(report.detail.as_deref(), Some("unsigned_driver"));
        assert!(!record.acked && record.reported.as_ref() == Some(&report));
        record.state = LocalState::Installing;
        assert_eq!(record.mark(), None, "a passing state stays local");
        record.detail = Some("C:\\secret".into());
        record.state = LocalState::Failed;
        assert_eq!(report_of(&record).unwrap().detail, None);
    }

    #[test]
    fn packages_are_kept_once_and_bounded() {
        let mut record = DriverRecord::new("d", DriverRecordKind::Inf, &"b".repeat(64), 1, LocalState::Installed);
        for n in 0..12 {
            record.add_package(DriverPackage { published: format!("oem{n}.inf"), sha256: "c".repeat(64) });
        }
        record.add_package(DriverPackage { published: "oem11.inf".into(), sha256: "d".repeat(64) });
        assert_eq!(record.packages.len(), MAX_PACKAGES);
        assert_eq!(record.packages.last().map(|p| p.sha256.clone()), Some("c".repeat(64)), "a repeat does not replace");
        assert_eq!(record.packages[0].published, "oem4.inf");
    }

    #[test]
    fn commands_have_the_exact_shape_the_program_rule_allows() {
        use crate::installs::installer_command_allowed;
        let root = Path::new(r"C:\Windows");
        let downloads = Path::new(r"C:\ProgramData\Rulebox\downloads");
        let drivers = Path::new(r"C:\ProgramData\Rulebox\drivers");
        let work = drivers.join("work").join("a".repeat(64));
        let inf = inf_file(&work, "x64/brother.inf");
        assert_eq!(inf, work.join("x64").join("brother.inf"));
        let add = pnputil_add_command(root, &inf, &work);
        assert!(installer_command_allowed(&add.program, &add.args, Some(root), downloads, drivers));
        assert_eq!(add.expected_exe, None);
        let msi = msi_driver_command(root, Path::new(r"C:\x\a.msi"), Path::new(r"C:\x\a.log"), downloads);
        assert!(msi.expected_exe.is_none() && !msi.removal);
        assert_eq!(&msi.args[2..4], ["/qn", "/norestart"]);
    }
}
