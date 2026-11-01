//! The install engine (plan Phase 4, Section 4.8 "Install engine", Step 14): the
//! agent downloads, verifies and silently installs the desktop apps the signed
//! catalogue assigns to this PC, removes the ones it should when they are
//! unassigned, and reports one result per app.
//!
//! - [`download`]: the `Downloader` seam (`HttpDownloader` on reqwest, `https://`
//!   only, streaming SHA-256, size cap) and the hash check of a file on disk.
//! - [`engine`]: the state machine and `installs.json`, one operation at a time.
//! - [`report`]: what the server is told (`pending` and the terminal states, A12).
//! - [`icons`]: the icon cache.
//!
//! This file holds the fixed rules shared by the engine and both platforms: the
//! closed list of result details, which programs may be started, the exact
//! installer command lines, how an exit code is read, and the file checks that
//! keep a verified installer from being swapped before it runs.
//!
//! Hard rules (CLAUDE.md): nothing runs that was not named by a verified document
//! and did not match its SHA-256; no `winget`, no PowerShell, no shell; the program
//! is msiexec or a file in the protected downloads folder.

use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use sha2::{Digest, Sha256};

use crate::platform::InstallerCommand;

pub mod download;
pub mod engine;
pub mod icons;
pub mod report;

/// An installer still running after this long is killed (`failed` / `timeout`).
pub const INSTALL_TIMEOUT: Duration = Duration::from_secs(30 * 60);
/// No download may be larger than this, whatever the catalogue says.
pub const MAX_DOWNLOAD_BYTES: u64 = 4 * 1024 * 1024 * 1024;
/// `1618` (another installation is running): try again after this long, without
/// counting an attempt.
pub const BUSY_RETRY: Duration = Duration::from_secs(120);
/// After a successful install the program must exist within this long.
pub const EXE_WAIT: Duration = Duration::from_secs(10);
/// How often the program is looked for meanwhile.
pub const EXE_POLL: Duration = Duration::from_millis(500);
/// The wait after the 1st..5th failure (plan 4.8: 1, 5, 15, 60, 360 minutes).
pub const BACKOFF_MINUTES: [u64; 5] = [1, 5, 15, 60, 360];
/// The 6th failure (the initial try plus the five retries) is final until the
/// app's revision changes (the dashboard's Retry).
pub const MAX_FAILURES: u32 = BACKOFF_MINUTES.len() as u32 + 1;
/// The MSI logs kept in `<data>\logs` (`install-<appId>.log`).
pub const KEEP_MSI_LOGS: usize = 5;

/// MSI exit codes (Windows Installer).
pub const MSI_SUCCESS: i32 = 0;
pub const MSI_REBOOT_REQUIRED: i32 = 3010;
pub const MSI_REBOOT_INITIATED: i32 = 1641;
pub const MSI_BUSY: i32 = 1618;
pub const MSI_UNKNOWN_PRODUCT: i32 = 1605;

/// `FILE_ATTRIBUTE_REPARSE_POINT`.
const REPARSE_POINT: u32 = 0x400;
/// `FILE_SHARE_READ`: other handles may read, nobody may write, rename or delete.
const SHARE_READ_ONLY: u32 = 0x1;
/// `FILE_FLAG_OPEN_REPARSE_POINT`: open a link itself, never what it points to.
const OPEN_REPARSE_POINT: u32 = 0x0020_0000;

/// The `detail` of an install result: exactly the fixed list the server accepts
/// (`INSTALL_DETAILS` in `convex/lib/deviceApiRules.ts`; a detail outside it is
/// dropped there). A closed enum, so the agent can never send anything else.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Detail {
    DownloadFailed,
    HashMismatch,
    TooLarge,
    LowDisk,
    Timeout,
    ExitCode,
    ExeMissingAfterInstall,
    Unsupported,
    Busy,
    RemoveFailed,
}

impl Detail {
    pub const ALL: [Detail; 10] = [
        Detail::DownloadFailed,
        Detail::HashMismatch,
        Detail::TooLarge,
        Detail::LowDisk,
        Detail::Timeout,
        Detail::ExitCode,
        Detail::ExeMissingAfterInstall,
        Detail::Unsupported,
        Detail::Busy,
        Detail::RemoveFailed,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Detail::DownloadFailed => "download_failed",
            Detail::HashMismatch => "hash_mismatch",
            Detail::TooLarge => "too_large",
            Detail::LowDisk => "low_disk",
            Detail::Timeout => "timeout",
            Detail::ExitCode => "exit_code",
            Detail::ExeMissingAfterInstall => "exe_missing_after_install",
            Detail::Unsupported => "unsupported",
            Detail::Busy => "busy",
            Detail::RemoveFailed => "remove_failed",
        }
    }

    /// The detail of a stored text, `None` for anything not in the list (a
    /// corrupt or hand-edited `installs.json` cannot put another text on the wire).
    pub fn parse(text: &str) -> Option<Detail> {
        Detail::ALL.into_iter().find(|detail| detail.as_str() == text)
    }
}

/// SHA-256 as 64 lower-case hex characters.
pub fn hex_lower(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// A catalogue hash: 64 lower-case hex characters (also what names the file).
pub fn is_sha256(text: &str) -> bool {
    text.len() == 64 && text.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// An app id the engine uses in a file or folder name: 1-64 of `[A-Za-z0-9_-]`
/// (Convex ids are lower-case letters and digits).
pub fn is_safe_id(id: &str) -> bool {
    (1..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// An MSI product code `{XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}` (hex, any case),
/// upper-cased; `None` for anything else.
pub fn product_code(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    if bytes.len() != 38 || bytes[0] != b'{' || bytes[37] != b'}' {
        return None;
    }
    for (index, byte) in bytes[1..37].iter().enumerate() {
        let dash = matches!(index, 8 | 13 | 18 | 23);
        if dash != (*byte == b'-') || (!dash && !byte.is_ascii_hexdigit()) {
            return None;
        }
    }
    Some(text.to_ascii_uppercase())
}

fn lower(path: &Path) -> String {
    path.to_string_lossy().trim_end_matches('\\').to_ascii_lowercase()
}

/// Absolute, with only plain components: no `..`, `.`, `\\?\` or stream syntax.
fn plain_absolute(path: &Path) -> bool {
    let text = path.to_string_lossy();
    if !path.is_absolute() || text.starts_with(r"\\") || text.contains('/') {
        return false;
    }
    // A `:` only as the drive's; never an alternate data stream.
    if text.match_indices(':').any(|(at, _)| at != 1) {
        return false;
    }
    path.components().all(|c| matches!(c, Component::Prefix(_) | Component::RootDir | Component::Normal(_)))
}

/// `%SystemRoot%\System32\msiexec.exe`.
pub fn msiexec_path(system_root: &Path) -> PathBuf {
    system_root.join("System32").join("msiexec.exe")
}

/// The one rule of which programs `run_installer` may start (plan Step 14 item 1):
/// `<system_root>\System32\msiexec.exe`, or a downloaded installer directly inside
/// `downloads` named `<sha256>.exe` / `<sha256>.msi` (an `.msi` is never started
/// itself; it is checked here only so the rule is one list). Compared without
/// regard to case, after refusing every path that is not plain and absolute.
pub fn installer_program_allowed(program: &Path, system_root: Option<&Path>, downloads: &Path) -> bool {
    if !plain_absolute(program) {
        return false;
    }
    if let Some(root) = system_root {
        if plain_absolute(root) && lower(program) == lower(&msiexec_path(root)) {
            return true;
        }
    }
    let Some(parent) = program.parent() else {
        return false;
    };
    let name = program.file_name().map(|n| n.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
    let named_by_hash = name
        .strip_suffix(".exe")
        .or_else(|| name.strip_suffix(".msi"))
        .is_some_and(is_sha256);
    plain_absolute(downloads) && lower(parent) == lower(downloads) && named_by_hash
}

/// `to` is `<apps>\<app id>\<file>.exe`: exactly two plain components below the
/// apps root (the shape `expand_exe` gives a portable app).
pub fn portable_target_ok(apps_root: &Path, to: &Path) -> bool {
    below(apps_root, to).is_some_and(|rest| rest.len() == 2 && is_safe_id(&rest[0]) && rest[1].to_ascii_lowercase().ends_with(".exe"))
}

/// `dir` is `<apps>\<app id>`.
pub fn portable_dir_ok(apps_root: &Path, dir: &Path) -> bool {
    below(apps_root, dir).is_some_and(|rest| rest.len() == 1 && is_safe_id(&rest[0]))
}

/// The components of `path` below `root`, when both are plain and `path` is inside.
fn below(root: &Path, path: &Path) -> Option<Vec<String>> {
    if !plain_absolute(root) || !plain_absolute(path) {
        return None;
    }
    let root_lower = lower(root);
    let path_text = path.to_string_lossy();
    let path_lower = path_text.to_ascii_lowercase();
    let rest = path_lower.strip_prefix(&root_lower)?.strip_prefix('\\')?;
    // Same length in ASCII lower case: take the original spelling.
    let original = &path_text[path_text.len() - rest.len()..];
    let parts: Vec<String> = original.split('\\').map(str::to_string).collect();
    parts.iter().all(|p| !p.is_empty() && p != "." && p != "..").then_some(parts)
}

/// Whether `path` itself is a reparse point (a symbolic link or junction).
/// Missing is `Ok(false)`.
pub fn is_reparse_point(path: &Path) -> std::io::Result<bool> {
    use std::os::windows::fs::MetadataExt;
    match std::fs::symlink_metadata(path) {
        Ok(meta) => Ok(meta.file_attributes() & REPARSE_POINT != 0),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e),
    }
}

/// msiexec, installing: `/i "<file>" /qn /norestart /l*v "<log>"` (plan 4.8).
pub fn msi_install_command(system_root: &Path, file: &Path, log: &Path, working_dir: &Path, exe: &Path) -> InstallerCommand {
    InstallerCommand {
        program: msiexec_path(system_root),
        args: vec![
            "/i".into(),
            file.to_string_lossy().into_owned(),
            "/qn".into(),
            "/norestart".into(),
            "/l*v".into(),
            log.to_string_lossy().into_owned(),
        ],
        working_dir: working_dir.to_path_buf(),
        expected_exe: Some(exe.to_path_buf()),
        removal: false,
    }
}

/// msiexec, removing: `/x <ProductCode> /qn /norestart /l*v "<log>"`. The code
/// must be a checked product code (`product_code`).
pub fn msi_removal_command(system_root: &Path, code: &str, log: &Path, working_dir: &Path, exe: Option<&Path>) -> InstallerCommand {
    InstallerCommand {
        program: msiexec_path(system_root),
        args: vec![
            "/x".into(),
            code.to_string(),
            "/qn".into(),
            "/norestart".into(),
            "/l*v".into(),
            log.to_string_lossy().into_owned(),
        ],
        working_dir: working_dir.to_path_buf(),
        expected_exe: exe.map(Path::to_path_buf),
        removal: true,
    }
}

/// A downloaded exe with the catalogue's silent arguments, unchanged and one by
/// one (they passed `check_args`: at most 16, at most 200 characters, no control
/// characters). `Command` quotes each one; nothing is ever joined into a command
/// line by hand, so an argument cannot become a second program or switch.
pub fn exe_install_command(file: &Path, silent_args: &[String], working_dir: &Path, exe: &Path) -> InstallerCommand {
    InstallerCommand {
        program: file.to_path_buf(),
        args: silent_args.to_vec(),
        working_dir: working_dir.to_path_buf(),
        expected_exe: Some(exe.to_path_buf()),
        removal: false,
    }
}

/// How an exit code is read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExitVerdict {
    Success { restart: bool },
    /// `1618`: retry in two minutes, not counted.
    Busy,
    Failure,
}

fn restart_code(code: i32) -> bool {
    code == MSI_REBOOT_REQUIRED || code == MSI_REBOOT_INITIATED
}

/// An install's exit code: success when listed in `successExitCodes` (0 always
/// counts), and for an MSI also 3010 / 1641. 3010 / 1641 as a success ask for a
/// restart (the agent never restarts the PC itself).
pub fn judge_install(msi: bool, success_exit_codes: &[i32], code: i32) -> ExitVerdict {
    let success = code == MSI_SUCCESS || success_exit_codes.contains(&code) || (msi && restart_code(code));
    if success {
        ExitVerdict::Success { restart: restart_code(code) }
    } else if code == MSI_BUSY {
        ExitVerdict::Busy
    } else {
        ExitVerdict::Failure
    }
}

/// `msiexec /x`: 0, 3010, 1641 and 1605 ("unknown product": already gone) remove.
pub fn judge_removal(code: i32) -> ExitVerdict {
    match code {
        MSI_SUCCESS | MSI_UNKNOWN_PRODUCT => ExitVerdict::Success { restart: false },
        MSI_REBOOT_REQUIRED | MSI_REBOOT_INITIATED => ExitVerdict::Success { restart: true },
        MSI_BUSY => ExitVerdict::Busy,
        _ => ExitVerdict::Failure,
    }
}

/// Why a file on disk was not accepted.
#[derive(Debug, thiserror::Error)]
pub enum FileCheckError {
    #[error("the file does not match its SHA-256")]
    Mismatch,
    #[error("not a plain file (a link, a folder or missing)")]
    NotPlain,
    #[error("file error: {0}")]
    Io(#[from] std::io::Error),
}

/// A verified installer, held open so it cannot change before it runs (TOCTOU):
/// opened with read sharing only (no other handle may write, rename or delete it
/// while this one lives), not through a link, and hashed through this same handle.
/// Keep it alive until the installer has finished.
#[derive(Debug)]
pub struct VerifiedFile {
    _file: std::fs::File,
    path: PathBuf,
}

impl VerifiedFile {
    pub fn path(&self) -> &Path {
        &self.path
    }
}

/// Opens `path` locked against writers, refuses a reparse point or anything but a
/// plain file, and checks its SHA-256 through the open handle.
pub fn open_verified(path: &Path, sha256: &str) -> Result<VerifiedFile, FileCheckError> {
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
    let mut file = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(SHARE_READ_ONLY)
        .custom_flags(OPEN_REPARSE_POINT)
        .open(path)?;
    let meta = file.metadata()?;
    if !meta.is_file() || meta.file_attributes() & REPARSE_POINT != 0 {
        return Err(FileCheckError::NotPlain);
    }
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    if hex_lower(&hasher.finalize()) != sha256 {
        return Err(FileCheckError::Mismatch);
    }
    Ok(VerifiedFile { _file: file, path: path.to_path_buf() })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempDir;

    #[test]
    fn details_are_exactly_the_servers_fixed_list() {
        // `INSTALL_DETAILS` in convex/lib/deviceApiRules.ts, in its order.
        let server = [
            "download_failed",
            "hash_mismatch",
            "too_large",
            "low_disk",
            "timeout",
            "exit_code",
            "exe_missing_after_install",
            "unsupported",
            "busy",
            "remove_failed",
        ];
        let ours: Vec<&str> = Detail::ALL.iter().map(|d| d.as_str()).collect();
        assert_eq!(ours, server);
        for detail in Detail::ALL {
            // The server's character rule `^[a-z0-9:_ -]*$` and length (<= 200).
            assert!(detail.as_str().bytes().all(|b| matches!(b, b'a'..=b'z' | b'0'..=b'9' | b':' | b'_' | b' ' | b'-')));
            assert_eq!(Detail::parse(detail.as_str()), Some(detail));
        }
        assert_eq!(Detail::parse("rm -rf"), None);
        assert_eq!(Detail::parse("HASH_MISMATCH"), None);
    }

    #[test]
    fn product_codes_and_ids() {
        assert_eq!(
            product_code("{23170f69-40c1-2702-2408-000001000000}").as_deref(),
            Some("{23170F69-40C1-2702-2408-000001000000}")
        );
        for bad in [
            "",
            "23170F69-40C1-2702-2408-000001000000",
            "{23170F69-40C1-2702-2408-00000100000}",
            "{23170F69-40C1-2702-2408-0000010000000}",
            "{23170F69_40C1-2702-2408-000001000000}",
            "{23170F69-40C1-2702-2408-00000100000G}",
            "{23170F69-40C1-2702-2408-000001000000} /qb",
            "\"{23170F69-40C1-2702-2408-000001000000}\"",
        ] {
            assert_eq!(product_code(bad), None, "{bad:?}");
        }
        assert!(is_safe_id("jd7abc123") && is_safe_id("app_vec-msi"));
        for bad in ["", "..", r"a\b", "a/b", "a b", "a:b", &"x".repeat(65)] {
            assert!(!is_safe_id(bad), "{bad:?}");
        }
    }

    #[test]
    fn program_outside_downloads_refused() {
        let root = Path::new(r"C:\Windows");
        let downloads = Path::new(r"C:\ProgramData\Rulebox\downloads");
        let sha = "a".repeat(64);
        let ok = |p: &str| installer_program_allowed(Path::new(p), Some(root), downloads);
        assert!(ok(r"C:\Windows\System32\msiexec.exe"));
        assert!(ok(r"c:\windows\system32\MSIEXEC.EXE"));
        assert!(ok(&format!(r"C:\ProgramData\Rulebox\downloads\{sha}.exe")));
        assert!(ok(&format!(r"C:\ProgramData\Rulebox\Downloads\{sha}.EXE")));
        for bad in [
            r"C:\Windows\System32\cmd.exe".to_string(),
            r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe".to_string(),
            r"C:\Windows\SysWOW64\msiexec.exe".to_string(),
            r"msiexec.exe".to_string(),
            format!(r"C:\Users\Staff\Downloads\{sha}.exe"),
            format!(r"C:\ProgramData\Rulebox\downloads\sub\{sha}.exe"),
            format!(r"C:\ProgramData\Rulebox\downloads\..\{sha}.exe"),
            format!(r"C:\ProgramData\Rulebox\downloads\{sha}.exe:evil"),
            format!(r"C:\ProgramData\Rulebox\downloads\{sha}.bat"),
            format!(r"C:\ProgramData\Rulebox\downloads\{sha}.exe.part"),
            r"C:\ProgramData\Rulebox\downloads\setup.exe".to_string(),
            format!(r"\\?\C:\ProgramData\Rulebox\downloads\{sha}.exe"),
            format!(r"\\server\share\{sha}.exe"),
            format!(r"C:/ProgramData/Rulebox/downloads/{sha}.exe"),
        ] {
            assert!(!ok(&bad), "{bad}");
        }
        // No known Windows folder: msiexec is refused too.
        assert!(!installer_program_allowed(Path::new(r"C:\Windows\System32\msiexec.exe"), None, downloads));
    }

    #[test]
    fn portable_targets_stay_in_their_own_folder() {
        let apps = Path::new(r"C:\Program Files\Rulebox\apps");
        assert!(portable_target_ok(apps, Path::new(r"C:\Program Files\Rulebox\apps\app1\tool.exe")));
        assert!(portable_target_ok(apps, Path::new(r"c:\program files\rulebox\APPS\app1\Tool.EXE")));
        for bad in [
            r"C:\Program Files\Rulebox\apps\tool.exe",
            r"C:\Program Files\Rulebox\apps\app1\sub\tool.exe",
            r"C:\Program Files\Rulebox\apps\..\agent.exe",
            r"C:\Program Files\Rulebox\apps\app1\..\..\rulebox-agent.exe",
            r"C:\Program Files\Rulebox\appsx\app1\tool.exe",
            r"C:\Program Files\Rulebox\rulebox-agent.exe",
            r"C:\Program Files\Rulebox\apps\app1\tool.dll",
            r"C:\Program Files\Rulebox\apps\app 1\tool.exe",
        ] {
            assert!(!portable_target_ok(apps, Path::new(bad)), "{bad}");
        }
        assert!(portable_dir_ok(apps, Path::new(r"C:\Program Files\Rulebox\apps\app1")));
        for bad in [r"C:\Program Files\Rulebox\apps", r"C:\Program Files\Rulebox\apps\..", r"C:\Program Files\Rulebox", r"C:\Program Files\Rulebox\apps\a\b"] {
            assert!(!portable_dir_ok(apps, Path::new(bad)), "{bad}");
        }
    }

    #[test]
    fn silent_argument_construction_and_quoting() {
        let root = Path::new(r"C:\Windows");
        let dl = Path::new(r"C:\ProgramData\Rulebox\downloads");
        let file = dl.join(format!("{}.msi", "b".repeat(64)));
        let log = Path::new(r"C:\ProgramData\Rulebox\logs\install-app1.log");
        let exe = Path::new(r"C:\Program Files\7-Zip\7zFM.exe");
        let msi = msi_install_command(root, &file, log, dl, exe);
        assert_eq!(msi.program, Path::new(r"C:\Windows\System32\msiexec.exe"));
        assert_eq!(msi.args, ["/i", file.to_str().unwrap(), "/qn", "/norestart", "/l*v", log.to_str().unwrap()]);
        assert!(!msi.removal);
        let remove = msi_removal_command(root, "{23170F69-40C1-2702-2408-000001000000}", log, dl, Some(exe));
        assert_eq!(remove.args[..4], ["/x", "{23170F69-40C1-2702-2408-000001000000}", "/qn", "/norestart"]);
        assert!(remove.removal);

        // Silent arguments go through one by one, never joined: a value with a
        // quote, an ampersand or a space stays ONE argument of the installer.
        let hostile = vec![
            "/VERYSILENT".to_string(),
            r"/DIR=C:\Program Files\X Y".to_string(),
            "\" & calc.exe & \"".to_string(),
            "a\\\"b".to_string(),
        ];
        let setup = dl.join(format!("{}.exe", "c".repeat(64)));
        let cmd = exe_install_command(&setup, &hostile, dl, exe);
        assert_eq!(cmd.program, setup);
        assert_eq!(cmd.args, hostile);
        // How std::process::Command puts them on the command line (MSVC rules):
        // each is quoted and inner quotes are escaped, so the program receives
        // exactly these four values and no `calc.exe` command.
        let mut command = std::process::Command::new(&cmd.program);
        command.args(&cmd.args);
        let shown = format!("{command:?}");
        assert!(shown.contains(r#""\" & calc.exe & \"""#), "{shown}");
        assert!(rulebox_policy::paths::check_args(&hostile).is_ok());
        // Control characters never reach a command (the catalogue rule).
        assert!(rulebox_policy::paths::check_args(&["/S\r\nnet user x /add".to_string()]).is_err());
    }

    #[test]
    fn exit_codes_are_read_like_the_plan_says() {
        use ExitVerdict::*;
        assert_eq!(judge_install(true, &[0], 0), Success { restart: false });
        assert_eq!(judge_install(true, &[0], 3010), Success { restart: true });
        assert_eq!(judge_install(true, &[0], 1641), Success { restart: true });
        assert_eq!(judge_install(true, &[0], 1618), Busy);
        assert_eq!(judge_install(true, &[0], 1603), Failure);
        // An exe: only its own list (and 0).
        assert_eq!(judge_install(false, &[0], 3010), Failure);
        assert_eq!(judge_install(false, &[0, 3010], 3010), Success { restart: true });
        assert_eq!(judge_install(false, &[], 0), Success { restart: false });
        assert_eq!(judge_install(false, &[0, 1], 1), Success { restart: false });
        assert_eq!(judge_install(false, &[0], -1), Failure);
        assert_eq!(judge_removal(1605), Success { restart: false });
        assert_eq!(judge_removal(3010), Success { restart: true });
        assert_eq!(judge_removal(1618), Busy);
        assert_eq!(judge_removal(1603), Failure);
    }

    fn sha_of(bytes: &[u8]) -> String {
        hex_lower(&Sha256::digest(bytes))
    }

    #[test]
    fn a_verified_file_cannot_be_swapped_while_it_is_held() {
        // TOCTOU defence: between the hash check and the end of the install no other
        // handle can write, truncate, rename or delete the file.
        let dir = TempDir::new();
        let path = dir.path().join(format!("{}.exe", "d".repeat(64)));
        std::fs::write(&path, b"the real installer").unwrap();
        let held = open_verified(&path, &sha_of(b"the real installer")).unwrap();
        assert_eq!(held.path(), path);
        assert!(std::fs::OpenOptions::new().write(true).open(&path).is_err(), "no writer");
        assert!(std::fs::write(&path, b"evil").is_err(), "no overwrite");
        assert!(std::fs::rename(&path, dir.path().join("moved.exe")).is_err(), "no rename");
        assert!(std::fs::remove_file(&path).is_err(), "no delete");
        // Readers (the installer itself) still can.
        assert_eq!(std::fs::read(&path).unwrap(), b"the real installer");
        drop(held);
        std::fs::write(&path, b"evil").unwrap();
        assert!(matches!(open_verified(&path, &sha_of(b"the real installer")), Err(FileCheckError::Mismatch)));
        assert!(matches!(open_verified(&dir.path().join("missing.exe"), &sha_of(b"")), Err(FileCheckError::Io(_))));
        assert!(matches!(open_verified(dir.path(), &sha_of(b"")), Err(FileCheckError::Io(_) | FileCheckError::NotPlain)));
    }

    #[test]
    fn reparse_points_are_seen() {
        let dir = TempDir::new();
        assert!(!is_reparse_point(dir.path()).unwrap());
        assert!(!is_reparse_point(&dir.path().join("missing")).unwrap());
        // A junction needs no privilege (a symbolic link would): made with mklink? No
        // shell is started from the agent's tests; the attribute check itself is the
        // same one `rulebox_win32::security` uses for the data directory.
    }
}
