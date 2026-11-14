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
//! - [`drivers_rules`] and [`unzip`]: the pure parts of the Step 14b driver installs.
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

use crate::platform::{InstallerCommand, InstallerExit};

pub mod download;
pub mod engine;
pub mod drivers_rules;
pub mod icons;
pub mod report;
pub mod unzip;

/// An installer still running after this long is killed (`failed` / `timeout`).
pub const INSTALL_TIMEOUT: Duration = Duration::from_secs(30 * 60);
/// No download may be larger than this, whatever the catalogue says.
pub const MAX_DOWNLOAD_BYTES: u64 = 4 * 1024 * 1024 * 1024;
/// `1618` (another installation is running): try again after this long, without
/// counting an attempt.
pub const BUSY_RETRY: Duration = Duration::from_secs(120);
/// (Review fix) Busy answers (`1618`, or a portable program in use) are retried
/// without counting for at most this long from the first one; the next busy answer
/// after it is a counted failure (`exit_code`, or `remove_failed` for a removal).
pub const BUSY_WINDOW: Duration = Duration::from_secs(2 * 3600);
/// (Review fix) After the installer's own process ended, the processes it started
/// get this long to end too; then the whole job is ended (a program it launched
/// would otherwise keep running as SYSTEM, or overlap the next run).
pub const INSTALLER_TAIL_GRACE: Duration = Duration::from_secs(120);
/// (Review fix) Every download ends within this long, whatever its size (a server
/// that sends one byte a minute can no longer hold the one engine task for days).
pub const DOWNLOAD_DEADLINE_MAX: Duration = Duration::from_secs(2 * 3600);
/// The least a download gets: the connection, a redirect and a small file.
pub const DOWNLOAD_DEADLINE_MIN: Duration = Duration::from_secs(10 * 60);
/// The slowest rate the deadline is scaled for (128 KiB/s), on top of the minimum.
pub const DOWNLOAD_MIN_RATE: u64 = 128 * 1024;
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
    /// (Step 14b) The INF package's catalog is not validly signed (or missing): nothing was installed.
    UnsignedDriver,
    /// (Step 14b) The zip was refused (unsafe path, too big, no such `.inf`).
    BadPackage,
}

impl Detail {
    pub const ALL: [Detail; 12] = [
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
        Detail::UnsignedDriver,
        Detail::BadPackage,
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
            Detail::UnsignedDriver => "unsigned_driver",
            Detail::BadPackage => "bad_package",
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
/// (Step 16) Also the check of the Staff profile path before a session cleanup.
pub(crate) fn plain_absolute(path: &Path) -> bool {
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

/// `%SystemRoot%\System32\pnputil.exe` (Step 14b, drivers only: see [`installer_command_allowed`]).
pub fn pnputil_path(system_root: &Path) -> PathBuf {
    system_root.join("System32").join("pnputil.exe")
}

/// `oem<digits>.inf`: the name Windows gives a package it published into the driver store (any case).
pub fn is_published_inf(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower
        .strip_prefix("oem")
        .and_then(|rest| rest.strip_suffix(".inf"))
        .is_some_and(|digits| !digits.is_empty() && digits.len() <= 9 && digits.bytes().all(|b| b.is_ascii_digit()))
}

/// (Step 14b) The program rule of [`installer_program_allowed`] **plus** exactly two `pnputil` command lines, and nothing
/// else of System32:
/// - `pnputil /add-driver <inf> /install`, `<inf>` a plain absolute path ending `.inf` inside `drivers_root` (the folder a
///   verified zip was extracted into; no wildcard, no relative path);
/// - `pnputil /delete-driver oem<N>.inf /uninstall`, nothing but the published name (no path, no `*`).
///
/// `pnputil` itself stays on the Staff deny list: only this SYSTEM service starts it.
pub fn installer_command_allowed(
    program: &Path,
    args: &[String],
    system_root: Option<&Path>,
    downloads: &Path,
    drivers_root: &Path,
) -> bool {
    if let Some(root) = system_root {
        if plain_absolute(program) && plain_absolute(root) && lower(program) == lower(&pnputil_path(root)) {
            return match args {
                [verb, inf, flag] if verb == "/add-driver" && flag == "/install" => {
                    let path = Path::new(inf);
                    !inf.contains(['*', '?', '<', '>', '|', '"'])
                        && path.extension().is_some_and(|e| e.eq_ignore_ascii_case("inf"))
                        && below(drivers_root, path).is_some_and(|rest| rest.len() >= 2)
                }
                [verb, name, flag] if verb == "/delete-driver" && flag == "/uninstall" => is_published_inf(name),
                _ => false,
            };
        }
    }
    installer_program_allowed(program, system_root, downloads)
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

/// (Review fix) The time one installer download may take: the minimum plus the
/// declared size at the slowest rate, never more than two hours. An unknown size
/// (0) gets the two hours.
pub fn download_deadline(size_bytes: u64) -> Duration {
    if size_bytes == 0 {
        return DOWNLOAD_DEADLINE_MAX;
    }
    let scaled = DOWNLOAD_DEADLINE_MIN.saturating_add(Duration::from_secs(size_bytes / DOWNLOAD_MIN_RATE));
    scaled.min(DOWNLOAD_DEADLINE_MAX)
}

/// `ERROR_ACCESS_DENIED`, `ERROR_SHARING_VIOLATION`, `ERROR_LOCK_VIOLATION`.
const IN_USE_CODES: [i32; 3] = [5, 32, 33];

/// (Review fix) A file error that means "the file is in use" (a running program
/// cannot be replaced or deleted). Only asked after a step that already proved the
/// folder is writable (the copy beside it succeeded), so access denied there is
/// the running program, not a permission problem.
pub fn is_in_use(error: &std::io::Error) -> bool {
    error.raw_os_error().is_some_and(|code| IN_USE_CODES.contains(&code))
}

/// (Review fix) A started installer and the job that holds it and everything it
/// starts. `WindowsPlatform` implements it on a kill-on-close job object; the
/// tests on a scripted fake.
pub trait RunningInstaller {
    /// The started process's exit code, once it ended.
    fn try_exit(&mut self) -> std::io::Result<Option<i32>>;
    /// How many processes of the job still run (the started one included).
    fn active(&mut self) -> std::io::Result<u32>;
    /// Ends every process of the job and waits (bounded) until they are gone.
    fn kill_all(&mut self);
}

/// How long [`wait_for_installer`] waits.
#[derive(Debug, Clone, Copy)]
pub struct InstallerWait {
    pub timeout: Duration,
    pub tail_grace: Duration,
    pub poll: Duration,
}

/// Waits for an installer **and everything it started**:
/// - the job became empty after the process ended: `Code` (its exit code);
/// - the process ended but others still run after `tail_grace`: they are ended,
///   `Code`;
/// - the agent is stopping (`cancelled`): everything is ended, `Cancelled`;
/// - `timeout` passed: everything is ended, `TimedOut` (or `Code` when the
///   process itself had ended).
///
/// Returns only once the job was found empty or was ended, so the caller can keep
/// the verified file and the run's TEMP folder until nothing of the run is left.
/// `elapsed` and `sleep` are the clock (real in `WindowsPlatform`, scripted in the
/// tests). A failing query ends everything and returns the error.
pub fn wait_for_installer(
    run: &mut dyn RunningInstaller,
    wait: InstallerWait,
    cancelled: &dyn Fn() -> bool,
    elapsed: &dyn Fn() -> Duration,
    sleep: &dyn Fn(Duration),
) -> std::io::Result<InstallerExit> {
    let mut exited: Option<(i32, Duration)> = None;
    loop {
        if cancelled() {
            run.kill_all();
            return Ok(InstallerExit::Cancelled);
        }
        if exited.is_none() {
            match run.try_exit() {
                Ok(Some(code)) => exited = Some((code, elapsed())),
                Ok(None) => {}
                Err(error) => {
                    run.kill_all();
                    return Err(error);
                }
            }
        }
        if let Some((code, at)) = exited {
            match run.active() {
                Ok(0) => return Ok(InstallerExit::Code(code)),
                Ok(_) if elapsed().saturating_sub(at) >= wait.tail_grace => {
                    tracing::warn!("the installer ended but processes it started still run; they are stopped");
                    run.kill_all();
                    return Ok(InstallerExit::Code(code));
                }
                Ok(_) => {}
                Err(error) => {
                    run.kill_all();
                    return Err(error);
                }
            }
        }
        if elapsed() >= wait.timeout {
            run.kill_all();
            return Ok(exited.map_or(InstallerExit::TimedOut, |(code, _)| InstallerExit::Code(code)));
        }
        sleep(wait.poll);
    }
}

/// (Review fix) The TEMP / TMP folder of one installer run:
/// `<data>\installer-temp\run-<random>`, created fresh (never reused) inside the
/// protected data directory, so it has the data directory's inherited DACL (SYSTEM
/// and Administrators; the same as `downloads`) and a standard user cannot plant
/// a DLL in it. Deleted when dropped (after the whole job ended); folders left by
/// a crash are deleted at the next start ([`sweep_run_temps`]).
#[derive(Debug)]
pub struct RunTemp {
    path: PathBuf,
}

impl RunTemp {
    pub fn create(root: &Path) -> std::io::Result<Self> {
        std::fs::create_dir_all(root)?;
        if is_reparse_point(root)? {
            return Err(std::io::Error::other("the installer temp folder is a link"));
        }
        for _ in 0..8 {
            let path = root.join(format!("run-{}", random_hex()));
            match std::fs::create_dir(&path) {
                Ok(()) => {
                    if is_reparse_point(&path)? {
                        let _ = std::fs::remove_dir(&path);
                        return Err(std::io::Error::other("the run's temp folder is a link"));
                    }
                    return Ok(Self { path });
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error),
            }
        }
        Err(std::io::Error::other("no fresh temp folder name"))
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for RunTemp {
    fn drop(&mut self) {
        // `remove_dir_all` deletes a link inside it, never what the link points to.
        if let Err(error) = std::fs::remove_dir_all(&self.path) {
            tracing::warn!("cannot delete the installer's temp folder: {error}");
        }
    }
}

/// 16 hex characters from the OS random source (the time when it gives none: the
/// name only has to be new, `create_dir` refuses an existing one).
fn random_hex() -> String {
    let mut bytes = [0u8; 8];
    if getrandom::fill(&mut bytes).is_err() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos());
        bytes = (nanos as u64).to_le_bytes();
    }
    hex_lower(&bytes)
}

/// Deletes every run folder left in `root` (by a crash). Nothing when `root` is
/// missing; refuses (only logs) when `root` itself is a link.
pub fn sweep_run_temps(root: &Path) {
    match is_reparse_point(root) {
        Ok(false) => {}
        Ok(true) => {
            tracing::error!("the installer temp folder is a link; left alone");
            return;
        }
        Err(error) => {
            tracing::warn!("cannot check the installer temp folder: {error}");
            return;
        }
    }
    let Ok(entries) = std::fs::read_dir(root) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let removed = match entry.file_type() {
            Ok(kind) if kind.is_dir() && !kind.is_symlink() => std::fs::remove_dir_all(&path),
            // A file, or a link (removed itself, never followed).
            Ok(kind) if kind.is_symlink() => std::fs::remove_dir(&path).or_else(|_| std::fs::remove_file(&path)),
            _ => std::fs::remove_file(&path),
        };
        if let Err(error) = removed {
            tracing::warn!("cannot delete an old installer temp folder: {error}");
        }
    }
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
            "unsigned_driver",
            "bad_package",
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
    fn pnputil_is_allowed_only_with_the_two_driver_command_lines() {
        let root = Path::new(r"C:\Windows");
        let downloads = Path::new(r"C:\ProgramData\Rulebox\downloads");
        let drivers = Path::new(r"C:\ProgramData\Rulebox\drivers");
        let sha = "a".repeat(64);
        let pnputil = r"C:\Windows\System32\pnputil.exe";
        let run = |program: &str, args: &[&str]| {
            let args: Vec<String> = args.iter().map(|a| (*a).to_string()).collect();
            installer_command_allowed(Path::new(program), &args, Some(root), downloads, drivers)
        };
        let inf = format!(r"C:\ProgramData\Rulebox\drivers\{sha}\sub\brother.inf");
        assert!(run(pnputil, &["/add-driver", &inf, "/install"]));
        assert!(run(r"c:\windows\system32\PNPUTIL.EXE", &["/add-driver", &inf.to_uppercase(), "/install"]));
        assert!(run(pnputil, &["/delete-driver", "oem12.inf", "/uninstall"]));
        assert!(run(pnputil, &["/delete-driver", "OEM7.INF", "/uninstall"]));
        // Everything refused before still is, and the old cases are unchanged.
        assert!(run(r"C:\Windows\System32\msiexec.exe", &["/i", "x.msi"]));
        assert!(run(&format!(r"C:\ProgramData\Rulebox\downloads\{sha}.exe"), &["/S"]));
        for program in [
            r"C:\Windows\System32\cmd.exe",
            r"C:\Windows\System32\powershell.exe",
            r"C:\Windows\System32\reg.exe",
            r"C:\Windows\System32\sc.exe",
            r"C:\Windows\SysWOW64\pnputil.exe",
            r"C:\Temp\pnputil.exe",
            r"C:\Windows\System32\drivers\pnputil.exe",
            r"pnputil.exe",
        ] {
            assert!(!run(program, &["/add-driver", &inf, "/install"]), "{program}");
            assert!(!run(program, &["/delete-driver", "oem12.inf", "/uninstall"]), "{program}");
        }
        let other_inf = r"C:\ProgramData\Rulebox\downloads\x.inf".to_string();
        let traversal = format!(r"C:\ProgramData\Rulebox\drivers\{sha}\..\..\evil.inf");
        let ads = format!(r"C:\ProgramData\Rulebox\drivers\{sha}\a.inf:evil");
        let wildcard = format!(r"C:\ProgramData\Rulebox\drivers\{sha}\*.inf");
        let direct = r"C:\ProgramData\Rulebox\drivers\a.inf".to_string();
        let not_inf = format!(r"C:\ProgramData\Rulebox\drivers\{sha}\a.exe");
        let unc = format!(r"\\server\share\{sha}\a.inf");
        for args in [
            vec!["/add-driver", "*.inf", "/install"],
            vec!["/add-driver", "brother.inf", "/install"],
            vec!["/add-driver", &other_inf, "/install"],
            vec!["/add-driver", &traversal, "/install"],
            vec!["/add-driver", &ads, "/install"],
            vec!["/add-driver", &wildcard, "/install"],
            vec!["/add-driver", &direct, "/install"],
            vec!["/add-driver", &not_inf, "/install"],
            vec!["/add-driver", &unc, "/install"],
            vec!["/add-driver", &inf],
            vec!["/add-driver", &inf, "/install", "/subdirs"],
            vec!["/add-driver", &inf, "/install", "/reboot"],
            vec!["/add-driver", &inf, "/subdirs"],
            vec!["/delete-driver", "oem12.inf"],
            vec!["/delete-driver", "oem12.inf", "/uninstall", "/force"],
            vec!["/delete-driver", "oem12.inf", "/force"],
            vec!["/delete-driver", "*", "/uninstall"],
            vec!["/delete-driver", "*.inf", "/uninstall"],
            vec!["/delete-driver", r"C:\Windows\INF\oem12.inf", "/uninstall"],
            vec!["/delete-driver", "oem.inf", "/uninstall"],
            vec!["/delete-driver", "oem12.inf.exe", "/uninstall"],
            vec!["/delete-driver", "netcfg.inf", "/uninstall"],
            vec!["/enum-drivers"],
            vec!["/delete-driver", "oem12.inf", "/uninstall", "&", "calc"],
            vec![],
        ] {
            assert!(!run(pnputil, &args), "{args:?}");
        }
        // No known Windows folder: pnputil is refused too.
        let args = vec!["/delete-driver".to_string(), "oem1.inf".to_string(), "/uninstall".to_string()];
        assert!(!installer_command_allowed(Path::new(pnputil), &args, None, downloads, drivers));
        // The bare program rule never names pnputil.
        assert!(!installer_program_allowed(Path::new(pnputil), Some(root), downloads));
    }

    #[test]
    fn published_names() {
        for good in ["oem1.inf", "OEM123.INF", "oem000012.inf"] {
            assert!(is_published_inf(good), "{good}");
        }
        for bad in ["oem.inf", "oemx.inf", "oem1.inf ", "xoem1.inf", "oem1.infx", r"..\oem1.inf", "oem1234567890.inf", "oem1.inf:s"] {
            assert!(!is_published_inf(bad), "{bad}");
        }
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
    fn download_deadline_scales_with_the_size_and_is_capped() {
        assert_eq!(download_deadline(0), DOWNLOAD_DEADLINE_MAX, "unknown size: the ceiling");
        assert_eq!(download_deadline(1), DOWNLOAD_DEADLINE_MIN);
        let hundred_mb = download_deadline(100 * 1024 * 1024);
        assert_eq!(hundred_mb, DOWNLOAD_DEADLINE_MIN + Duration::from_secs(800));
        assert_eq!(download_deadline(MAX_DOWNLOAD_BYTES), DOWNLOAD_DEADLINE_MAX);
        assert_eq!(download_deadline(u64::MAX), DOWNLOAD_DEADLINE_MAX);
    }

    #[test]
    fn in_use_errors_are_recognised() {
        for code in [5, 32, 33] {
            assert!(is_in_use(&std::io::Error::from_raw_os_error(code)), "{code}");
        }
        for code in [2, 3, 112] {
            assert!(!is_in_use(&std::io::Error::from_raw_os_error(code)), "{code}");
        }
        assert!(!is_in_use(&std::io::Error::other("x")));
    }

    /// A scripted installer on a scripted clock: the process ends at `exit_at`, its
    /// children at `children_until` (`None`: never by themselves).
    struct FakeRun<'a> {
        clock: &'a std::cell::Cell<Duration>,
        exit_at: Option<Duration>,
        children_until: Option<Duration>,
        killed: bool,
        fail_query: bool,
    }

    impl RunningInstaller for FakeRun<'_> {
        fn try_exit(&mut self) -> std::io::Result<Option<i32>> {
            if self.fail_query {
                return Err(std::io::Error::other("query failed"));
            }
            Ok(self.exit_at.filter(|at| self.killed || self.clock.get() >= *at).map(|_| 7))
        }
        fn active(&mut self) -> std::io::Result<u32> {
            let now = self.clock.get();
            let main = u32::from(!self.killed && self.exit_at.is_none_or(|at| now < at));
            let children = u32::from(!self.killed && self.children_until.is_none_or(|until| now < until));
            Ok(main + children)
        }
        fn kill_all(&mut self) {
            self.killed = true;
        }
    }

    fn run_fake(run: &mut FakeRun<'_>, cancel_at: Option<Duration>) -> std::io::Result<InstallerExit> {
        let clock = run.clock;
        let wait = InstallerWait {
            timeout: Duration::from_secs(1800),
            tail_grace: Duration::from_secs(120),
            poll: Duration::from_millis(500),
        };
        wait_for_installer(
            run,
            wait,
            &|| cancel_at.is_some_and(|at| clock.get() >= at),
            &|| clock.get(),
            &|d| clock.set(clock.get() + d),
        )
    }

    fn fake(clock: &std::cell::Cell<Duration>, exit_at: Option<u64>, children_until: Option<u64>) -> FakeRun<'_> {
        FakeRun {
            clock,
            exit_at: exit_at.map(Duration::from_secs),
            children_until: children_until.map(Duration::from_secs),
            killed: false,
            fail_query: false,
        }
    }

    #[test]
    fn the_wait_covers_the_children_not_only_the_process() {
        let clock = std::cell::Cell::new(Duration::ZERO);
        // setup.exe ends at 10 s, its setup.tmp at 40 s: the wait lasts until 40 s.
        let mut run = fake(&clock, Some(10), Some(40));
        assert_eq!(run_fake(&mut run, None).unwrap(), InstallerExit::Code(7));
        assert!(!run.killed && clock.get() >= Duration::from_secs(40), "{:?}", clock.get());
    }

    #[test]
    fn a_child_left_running_is_ended_after_the_grace() {
        let clock = std::cell::Cell::new(Duration::ZERO);
        let mut run = fake(&clock, Some(10), None);
        assert_eq!(run_fake(&mut run, None).unwrap(), InstallerExit::Code(7));
        assert!(run.killed);
        let at = clock.get();
        assert!(at >= Duration::from_secs(130) && at < Duration::from_secs(132), "{at:?}");
    }

    #[test]
    fn a_timeout_ends_the_whole_tree() {
        let clock = std::cell::Cell::new(Duration::ZERO);
        let mut run = fake(&clock, None, None);
        assert_eq!(run_fake(&mut run, None).unwrap(), InstallerExit::TimedOut);
        assert!(run.killed, "the job (every process) is ended");
        assert_eq!(clock.get(), Duration::from_secs(1800));
    }

    #[test]
    fn a_stopping_agent_ends_the_tree_at_the_next_poll() {
        let clock = std::cell::Cell::new(Duration::ZERO);
        let mut run = fake(&clock, None, None);
        assert_eq!(run_fake(&mut run, Some(Duration::from_secs(5))).unwrap(), InstallerExit::Cancelled);
        assert!(run.killed);
        assert!(clock.get() <= Duration::from_millis(5500), "{:?}", clock.get());
    }

    #[test]
    fn a_failing_query_ends_the_tree() {
        let clock = std::cell::Cell::new(Duration::ZERO);
        let mut run = fake(&clock, None, None);
        run.fail_query = true;
        assert!(run_fake(&mut run, None).is_err());
        assert!(run.killed);
    }

    #[test]
    fn a_run_temp_folder_is_fresh_and_deleted() {
        let dir = TempDir::new();
        let root = dir.path().join("installer-temp");
        let first = RunTemp::create(&root).unwrap();
        let second = RunTemp::create(&root).unwrap();
        assert_ne!(first.path(), second.path(), "never reused");
        assert!(first.path().starts_with(&root) && first.path().is_dir());
        std::fs::write(first.path().join("setup.tmp"), b"x").unwrap();
        std::fs::create_dir(first.path().join("sub")).unwrap();
        let path = first.path().to_path_buf();
        drop(first);
        assert!(!path.exists(), "deleted with everything in it");
        // A crash leaves one behind: swept at the next start (files too).
        let left = second.path().to_path_buf();
        std::mem::forget(second);
        std::fs::write(root.join("stray.txt"), b"x").unwrap();
        sweep_run_temps(&root);
        assert!(!left.exists() && std::fs::read_dir(&root).unwrap().next().is_none());
        sweep_run_temps(&dir.path().join("missing"));
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
