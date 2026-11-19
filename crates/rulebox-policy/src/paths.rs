//! Path templates of a desktop app (plan Phase 4, 4.8 "Path templates"): the
//! agent's copy of `convex/lib/pathRules.ts` and of `DENY_PROGRAMS` in
//! `convex/lib/denyList.ts`. The server checks a template when it is saved; the
//! agent checks it again before it uses it (the document is signed, so this is
//! defence in depth) and expands it itself. A template is never a real path: it
//! starts with a fixed token, so a document can only name a program inside
//! Program Files, the System32 folder or the agent's own apps folder.
//!
//! Pure: no I/O. The roots come from the caller (`PathRoots`).

/// The roots a template may start with, as expanded on this PC.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PathRoots {
    /// `FOLDERID_ProgramFiles`.
    pub program_files: String,
    /// `FOLDERID_ProgramFilesX86`; `None` when this PC does not tell (only templates
    /// that start with `{ProgramFilesX86}` are then refused).
    pub program_files_x86: Option<String>,
    /// `FOLDERID_Windows`; `None` when this PC does not tell (only `{SystemRoot}`
    /// templates are then refused).
    pub system_root: Option<String>,
    /// `<install root>\apps` (`C:\Program Files\Rulebox\apps`).
    pub rulebox_apps: String,
}

/// Longest path after expansion (`MAX_EXE_PATH`).
pub const MAX_EXE_PATH: usize = 260;
/// `args` and `fileArgTemplate`: at most this many entries...
pub const MAX_APP_ARGS: usize = 16;
/// ...of at most this many characters.
pub const MAX_APP_ARG_LENGTH: usize = 200;

/// Shells, script hosts, runtimes and similar programs a document may never
/// start (PRD 7.3), by file name without `.exe`, lower-case. Same list as
/// `DENY_PROGRAM_NAMES` in `convex/lib/denyList.ts` (a test pins the length).
pub const DENY_PROGRAMS: &[&str] = &[
    "at", "bash", "bcdedit", "bitsadmin", "bun", "cacls", "certreq", "certutil", "cmd", "cmstp",
    "compmgmt", "conhost", "control", "csc", "cscript", "curl", "deno", "dfsvc", "diskpart",
    "dism", "dnscmd", "esentutl", "eventvwr", "expand", "explorer", "extrac32", "forfiles", "ftp",
    "hh", "icacls", "ieexec", "infdefaultinstall", "installutil", "java", "javaw", "javaws",
    "jjs", "jsc", "lua", "makecab", "mavinject", "mmc", "msbuild", "msconfig", "msdt", "mshta",
    "msiexec", "msxsl", "net", "net1", "netsh", "node", "odbcconf", "openconsole", "pcalua",
    "pcwrun", "perl", "php", "pnputil", "powershell", "powershell_ise", "presentationhost",
    "print", "psexec", "pwsh", "py", "python", "python3", "pythonw", "pyw", "reg", "regasm",
    "regedit", "regini", "regsvcs", "regsvr32", "replace", "rpcping", "ruby", "runas", "rundll32",
    "runonce", "sc", "schtasks", "scp", "sdclt", "services", "sftp", "sh", "ssh",
    "syncappvpublishingserver", "takeown", "taskmgr", "telnet", "tftp", "tracker", "ttdinject",
    "vbc", "wevtutil", "winrs", "wmic", "wscript", "wsl", "wt", "wusa", "xwizard",
];

/// Why a template or an argument list was refused. Fixed texts only: never the
/// value, so it is safe to log.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum PathProblem {
    #[error("path must start with {{ProgramFiles}}, {{ProgramFilesX86}} or {{SystemRoot}}\\System32")]
    UnknownRoot,
    #[error("a portable app must be in its own folder under {{RuleboxApps}}")]
    NotOwnFolder,
    #[error("1 to 8 path components")]
    ComponentCount,
    #[error("path component not allowed")]
    BadComponent,
    #[error("the program folder of this path is not known on this PC")]
    RootUnknown,
    #[error("path must end in .exe")]
    NotExe,
    #[error("program not allowed")]
    Denied,
    #[error("path too long")]
    TooLong,
    #[error("too many arguments")]
    TooManyArgs,
    #[error("argument too long")]
    ArgTooLong,
    #[error("argument has a control character")]
    ControlCharacter,
    #[error("{{file}} must appear exactly once")]
    FileArg,
    /// (Phase 4 Step 16) A reset folder that does not start with `{LocalAppData}\`
    /// or `{RoamingAppData}\`.
    #[error("folder must start with {{LocalAppData}} or {{RoamingAppData}}")]
    ResetRoot,
    /// (Step 16) A reset folder with no component, or more than 6, below its root.
    #[error("1 to 6 folder components")]
    ResetComponentCount,
    /// (Step 16 review) A reset folder that is, holds or sits inside one of
    /// [`RESET_DENY`] (Windows secrets and shell data, the Staff App's own data).
    #[error("folder holds Windows or Rulebox data")]
    ResetDenied,
    /// (Phase 6 Step 4, plan 4.4.3) A `*` in the first folder below the root (the
    /// vendor's own folder must be named, so the path rule is not on a whole root).
    #[error("* is not allowed in the first folder")]
    WildcardFirstSegment,
    /// (Step 4) A `*` in the file name.
    #[error("* is not allowed in the file name")]
    WildcardFileName,
    /// (Step 4) More than one `*` in a template.
    #[error("only one * is allowed")]
    WildcardTwice,
    /// (Step 4) A `*` in the path of a portable app (it lives in its own folder).
    #[error("* is not allowed for a portable app")]
    WildcardPortable,
    /// (Step 4) A `{token}` in the silent arguments that is not `{AnswerFile}` or
    /// `{LogFile}`.
    #[error("unknown {{token}} in the arguments")]
    UnknownToken,
}

/// (Phase 4 Step 16 review) Folders below `{LocalAppData}` / `{RoamingAppData}`
/// that a reset may never touch: DPAPI keys, saved credentials, certificates and
/// the Windows shell's own data, the Staff App's data and WebView2 profiles
/// (`dev.rulebox.staff`), and anything named `Rulebox`. A template is refused when
/// its first components and an entry agree, ignoring case, on their common length:
/// the entry itself, anything inside it, and any folder that contains it
/// (`{RoamingAppData}\Microsoft` would delete `Microsoft\Protect`). Same list and
/// rule as `RESET_DENY` in `convex/lib/pathRules.ts`; the shared vectors
/// (`tests/vectors/reset-folders.json`) pin both.
pub const RESET_DENY: &[&[&str]] = &[
    &["Microsoft", "Credentials"],
    &["Microsoft", "Crypto"],
    &["Microsoft", "Protect"],
    &["Microsoft", "SystemCertificates"],
    &["Microsoft", "Vault"],
    &["Microsoft", "Windows"],
    &["dev.rulebox.staff"],
    &["Rulebox"],
];

/// Whether the components below the root meet an entry of [`RESET_DENY`].
fn reset_denied(parts: &[&str]) -> bool {
    RESET_DENY.iter().any(|entry| entry.iter().zip(parts).all(|(denied, part)| denied.eq_ignore_ascii_case(part)))
}

/// (Phase 4 Step 16) Where a reset folder lives inside the Staff profile.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResetBase {
    /// `{LocalAppData}` = `<profile>\AppData\Local`.
    LocalAppData,
    /// `{RoamingAppData}` = `<profile>\AppData\Roaming`.
    RoamingAppData,
}

impl ResetBase {
    /// The folder below the profile's `AppData`.
    pub fn app_data_folder(self) -> &'static str {
        match self {
            ResetBase::LocalAppData => "Local",
            ResetBase::RoamingAppData => "Roaming",
        }
    }
}

/// At most this many reset folders per app (`MAX_RESET_FOLDERS` in
/// `convex/lib/limits.ts`).
pub const MAX_RESET_FOLDERS: usize = 20;
/// A reset folder has 1 to this many components below its root.
pub const MAX_RESET_COMPONENTS: usize = 6;

const LOCAL_APP_DATA: &str = "{LocalAppData}\\";
const ROAMING_APP_DATA: &str = "{RoamingAppData}\\";

/// (Phase 4 Step 16, plan 4.12) The agent's copy of `resetFoldersProblem` for one
/// entry: `{LocalAppData}\<rel>` or `{RoamingAppData}\<rel>`, `<rel>` 1-6
/// components with the path-template character rules (no `..`, no `.`, no
/// separator other than `\`, no drive, stream or device name), and not meeting
/// [`RESET_DENY`]. Returns the root and the components; the caller joins them
/// below the Staff profile.
pub fn reset_folder_parts(template: &str) -> Result<(ResetBase, Vec<&str>), PathProblem> {
    let (base, rest) = if let Some(rest) = template.strip_prefix(LOCAL_APP_DATA) {
        (ResetBase::LocalAppData, rest)
    } else if let Some(rest) = template.strip_prefix(ROAMING_APP_DATA) {
        (ResetBase::RoamingAppData, rest)
    } else {
        return Err(PathProblem::ResetRoot);
    };
    let parts: Vec<&str> = rest.split('\\').collect();
    if parts.is_empty() || parts.len() > MAX_RESET_COMPONENTS {
        return Err(PathProblem::ResetComponentCount);
    }
    if !parts.iter().all(|c| valid_component(c)) {
        return Err(PathProblem::BadComponent);
    }
    if reset_denied(&parts) {
        return Err(PathProblem::ResetDenied);
    }
    Ok((base, parts))
}

const PROGRAM_FILES: &str = "{ProgramFiles}\\";
const PROGRAM_FILES_X86: &str = "{ProgramFilesX86}\\";
const SYSTEM32: &str = "{SystemRoot}\\System32\\";
const RULEBOX_APPS: &str = "{RuleboxApps}\\";

/// Letters, digits, space and `._-()+&`, 1-100 characters; not only dots and
/// spaces; not ending in a dot or space; not a DOS device name.
fn valid_component(c: &str) -> bool {
    let chars = c.chars().count();
    (1..=100).contains(&chars)
        && c.chars().all(|ch| ch.is_ascii_alphanumeric() || " ._-()+&".contains(ch))
        && c.chars().any(|ch| ch != '.' && ch != ' ')
        && !c.ends_with('.')
        && !c.ends_with(' ')
        && !is_reserved_device(c)
}

/// `con`, `prn`, `aux`, `nul`, `com1`..`com9`, `lpt1`..`lpt9`, with or without
/// an extension, any case.
fn is_reserved_device(c: &str) -> bool {
    let stem = c.split('.').next().unwrap_or(c).to_ascii_lowercase();
    matches!(stem.as_str(), "con" | "prn" | "aux" | "nul")
        || (stem.len() == 4
            && (stem.starts_with("com") || stem.starts_with("lpt"))
            && matches!(stem.as_bytes()[3], b'1'..=b'9'))
}

/// The file name of a template without folders or `.exe`, lower-case.
pub fn program_stem(exe: &str) -> String {
    let name = exe.rsplit('\\').next().unwrap_or(exe).to_lowercase();
    match name.strip_suffix(".exe") {
        Some(stem) => stem.to_string(),
        None => name,
    }
}

pub fn program_denied(exe: &str) -> bool {
    DENY_PROGRAMS.contains(&program_stem(exe).as_str())
}

/// Checks `exe` (a template) for the app `app_id` and expands it with `roots`.
/// `portable` apps must live in `{RuleboxApps}\<app_id>\`, every other app under
/// one of the fixed roots. The result is the real path, at most 260 characters.
///
/// (Phase 6 Step 4, plan 4.4.3) A template for an app that moves into a versioned
/// folder may hold **one** `*`, inside a folder name (`app-*`, or just `*`):
/// `{ProgramFiles}\Vendor\App\app-*\app.exe`. Never in the first folder below the root,
/// never in the file name, never twice, never for a portable app. The result is then a
/// **pattern**, not a path: it still holds the `*`, and [`exe_pattern`] splits it so the
/// caller can list the folder above and pick the highest version. A pattern is never
/// something to start; a path with a `*` names no file.
pub fn expand_exe(exe: &str, app_id: &str, portable: bool, roots: &PathRoots) -> Result<String, PathProblem> {
    let own_folder = format!("{RULEBOX_APPS}{app_id}\\");
    let (prefix, base) = if portable {
        if !exe.starts_with(&own_folder) {
            return Err(PathProblem::NotOwnFolder);
        }
        // The id is a folder name too.
        if !valid_component(app_id) {
            return Err(PathProblem::NotOwnFolder);
        }
        (own_folder.as_str(), format!("{}\\{app_id}", roots.rulebox_apps.trim_end_matches('\\')))
    } else if exe.starts_with(PROGRAM_FILES) {
        (PROGRAM_FILES, roots.program_files.trim_end_matches('\\').to_string())
    } else if exe.starts_with(PROGRAM_FILES_X86) {
        let root = roots.program_files_x86.as_deref().ok_or(PathProblem::RootUnknown)?;
        (PROGRAM_FILES_X86, root.trim_end_matches('\\').to_string())
    } else if exe.starts_with(SYSTEM32) {
        let root = roots.system_root.as_deref().ok_or(PathProblem::RootUnknown)?;
        (SYSTEM32, format!("{}\\System32", root.trim_end_matches('\\')))
    } else {
        // `{RuleboxApps}\` is a root only for portable apps.
        return Err(PathProblem::UnknownRoot);
    };
    let rest: Vec<&str> = exe[prefix.len()..].split('\\').collect();
    if rest.is_empty() || rest.len() > 8 {
        return Err(PathProblem::ComponentCount);
    }
    let stars: usize = rest.iter().map(|c| c.matches('*').count()).sum();
    if stars > 0 {
        if portable {
            return Err(PathProblem::WildcardPortable);
        }
        if stars > 1 {
            return Err(PathProblem::WildcardTwice);
        }
        if rest.last().is_some_and(|last| last.contains('*')) {
            return Err(PathProblem::WildcardFileName);
        }
        if rest.first().is_some_and(|first| first.contains('*')) {
            return Err(PathProblem::WildcardFirstSegment);
        }
    }
    // A folder name that holds the `*` is checked with the `*` replaced by a letter.
    if !rest.iter().all(|c| valid_component(&c.replace('*', "x"))) {
        return Err(PathProblem::BadComponent);
    }
    if !rest.last().is_some_and(|last| last.to_ascii_lowercase().ends_with(".exe")) {
        return Err(PathProblem::NotExe);
    }
    if program_denied(exe) {
        return Err(PathProblem::Denied);
    }
    let path = format!("{base}\\{}", rest.join("\\"));
    if path.chars().count() > MAX_EXE_PATH {
        return Err(PathProblem::TooLong);
    }
    Ok(path)
}

/// (Phase 5 Step 1, plan 4.3) The shape check of an exception `path`: a Phase 4
/// template that starts with `{ProgramFiles}\`, `{ProgramFilesX86}\` or
/// `{RuleboxApps}\` (never `{SystemRoot}`: Windows' own programs are allowed by the
/// layers themselves), 1-8 components with the template character rules, ending in
/// `.exe`, and not a program of [`DENY_PROGRAMS`]. Does not expand anything (no
/// roots needed: the agent expands the template when it builds a rule).
pub fn exception_path_problem(template: &str) -> Option<PathProblem> {
    let rest = [PROGRAM_FILES, PROGRAM_FILES_X86, RULEBOX_APPS]
        .iter()
        .find_map(|prefix| template.strip_prefix(prefix));
    let Some(rest) = rest else {
        return Some(PathProblem::UnknownRoot);
    };
    let parts: Vec<&str> = rest.split('\\').collect();
    if parts.len() > 8 {
        return Some(PathProblem::ComponentCount);
    }
    if !parts.iter().all(|c| valid_component(c)) {
        return Some(PathProblem::BadComponent);
    }
    if !parts.last().is_some_and(|last| last.to_ascii_lowercase().ends_with(".exe")) {
        return Some(PathProblem::NotExe);
    }
    if program_denied(template) {
        return Some(PathProblem::Denied);
    }
    // 260 characters is the Windows path limit; the longest root a template can expand
    // to is not known here, so the template itself is held to the same bound.
    if template.chars().count() > MAX_EXE_PATH {
        return Some(PathProblem::TooLong);
    }
    None
}

/// `args`: at most 16 entries of at most 200 characters, no control characters.
pub fn check_args(list: &[String]) -> Result<(), PathProblem> {
    if list.len() > MAX_APP_ARGS {
        return Err(PathProblem::TooManyArgs);
    }
    for arg in list {
        if arg.chars().count() > MAX_APP_ARG_LENGTH {
            return Err(PathProblem::ArgTooLong);
        }
        if arg.chars().any(|c| (c as u32) < 0x20 || c as u32 == 0x7f) {
            return Err(PathProblem::ControlCharacter);
        }
    }
    Ok(())
}

/// The tokens an installer's `silentArgs` may hold (plan 4.6 "Answer file"). The agent
/// replaces them with paths in its own data folder, which has no spaces.
pub const SILENT_ARG_TOKENS: [&str; 2] = ["{AnswerFile}", "{LogFile}"];

/// (Phase 6 Step 4) `silentArgs`: the rules of [`check_args`], and every `{...}` in an
/// argument must be exactly `{AnswerFile}` or `{LogFile}` (a lone `{` or `}` is refused
/// too). `check_args` itself is unchanged: `args` and `fileArgTemplate` keep their own
/// rules (`{file}` is a token of `fileArgTemplate` only).
pub fn check_silent_args(list: &[String]) -> Result<(), PathProblem> {
    check_args(list)?;
    for arg in list {
        let mut rest = arg.as_str();
        while let Some(open) = rest.find(['{', '}']) {
            let tail = &rest[open..];
            let Some(token) = SILENT_ARG_TOKENS.iter().find(|token| tail.starts_with(**token)) else {
                return Err(PathProblem::UnknownToken);
            };
            rest = &tail[token.len()..];
        }
    }
    Ok(())
}

/// A path template with a `*` (see [`expand_exe`]) split at the folder that holds it:
/// `C:\Program Files\Vendor\App\app-*\app.exe` is folder `C:\Program Files\Vendor\App`,
/// segment `app-*`, rest `app.exe`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExePattern {
    /// Everything above the `*` folder: the folder to list. Must be admin-only for the
    /// path rule (plan 4.4.3).
    pub folder: String,
    /// The folder name with the `*`.
    pub segment: String,
    /// What follows the `*` folder: the rest of the path below it, ending in the exe.
    pub rest: String,
}

/// Splits a pattern that [`expand_exe`] returned. `None` when the path has no `*`.
pub fn exe_pattern(expanded: &str) -> Option<ExePattern> {
    let parts: Vec<&str> = expanded.split('\\').collect();
    let at = parts.iter().position(|part| part.contains('*'))?;
    Some(ExePattern {
        folder: parts[..at].join("\\"),
        segment: parts[at].to_string(),
        rest: parts[at + 1..].join("\\"),
    })
}

impl ExePattern {
    /// What the `*` stands for in `name` (a folder name), ignoring case like Windows,
    /// or `None` when `name` does not fit the segment.
    pub fn captured<'a>(&self, name: &'a str) -> Option<&'a str> {
        let (prefix, suffix) = self.segment.split_once('*')?;
        let (name_lower, prefix, suffix) = (name.to_ascii_lowercase(), prefix.to_ascii_lowercase(), suffix.to_ascii_lowercase());
        if name_lower.len() < prefix.len() + suffix.len() || !name_lower.starts_with(&prefix) || !name_lower.ends_with(&suffix) {
            return None;
        }
        // Lower-casing ASCII keeps byte offsets, so the slice is the same in `name`.
        name.get(prefix.len()..name.len() - suffix.len())
    }

    /// The folder name that stands for the highest version: among `names`, those that fit
    /// the segment and whose `*` text is an ordered version (`crate::version`), the one
    /// that compares highest. The first of equal ones wins. `None` when nothing fits.
    pub fn highest<'a>(&self, names: impl IntoIterator<Item = &'a str>) -> Option<&'a str> {
        let mut best: Option<(crate::version::Version, &'a str)> = None;
        for name in names {
            let Some(version) = self.captured(name).and_then(crate::version::parse) else {
                continue;
            };
            if best.as_ref().is_none_or(|(top, _)| version > *top) {
                best = Some((version, name));
            }
        }
        best.map(|(_, name)| name)
    }
}

/// `fileArgTemplate`: empty (the app cannot open files), or arguments with
/// `{file}` exactly once.
pub fn check_file_args(list: &[String]) -> Result<(), PathProblem> {
    if list.is_empty() {
        return Ok(());
    }
    check_args(list)?;
    let count: usize = list.iter().map(|arg| arg.matches("{file}").count()).sum();
    if count == 1 {
        Ok(())
    } else {
        Err(PathProblem::FileArg)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roots() -> PathRoots {
        PathRoots {
            program_files: r"C:\Program Files".into(),
            program_files_x86: Some(r"C:\Program Files (x86)".into()),
            system_root: Some(r"C:\Windows".into()),
            rulebox_apps: r"C:\Program Files\Rulebox\apps\".into(),
        }
    }

    #[test]
    fn path_template_expansion_and_rejection() {
        let r = roots();
        // Accepted (the server's examples), expanded with this PC's roots.
        assert_eq!(
            expand_exe(r"{ProgramFiles}\VideoLAN\VLC\vlc.exe", "app1", false, &r).as_deref(),
            Ok(r"C:\Program Files\VideoLAN\VLC\vlc.exe")
        );
        assert_eq!(
            expand_exe(r"{ProgramFilesX86}\Tally (9)\tally+&.EXE", "app1", false, &r).as_deref(),
            Ok(r"C:\Program Files (x86)\Tally (9)\tally+&.EXE")
        );
        assert_eq!(
            expand_exe(r"{SystemRoot}\System32\notepad.exe", "app1", false, &r).as_deref(),
            Ok(r"C:\Windows\System32\notepad.exe")
        );
        assert_eq!(
            expand_exe(r"{RuleboxApps}\app1\tool.exe", "app1", true, &r).as_deref(),
            Ok(r"C:\Program Files\Rulebox\apps\app1\tool.exe")
        );
        // Refused, with the server's reasons.
        let refused = [
            (r"C:\x.exe", false, PathProblem::UnknownRoot),
            (r"{ProgramFiles}\..\x.exe", false, PathProblem::BadComponent),
            (r"{ProgramFiles}\a\...\x.exe", false, PathProblem::BadComponent),
            (r"{ProgramFiles}\a\b.bat", false, PathProblem::NotExe),
            (r"{ProgramFiles}\1\2\3\4\5\6\7\8\9.exe", false, PathProblem::ComponentCount),
            (r"{RuleboxApps}\other\x.exe", true, PathProblem::NotOwnFolder),
            (r"{RuleboxApps}\app1\x.exe", false, PathProblem::UnknownRoot),
            (r"{ProgramFiles}\x.exe", true, PathProblem::NotOwnFolder),
            (r"{SystemRoot}\cmd.exe", false, PathProblem::UnknownRoot),
            (r"{SystemRoot}\System32\cmd.exe", false, PathProblem::Denied),
            (r"{ProgramFiles}\PowerShell\7\PWSH.exe", false, PathProblem::Denied),
            (r"{ProgramFiles}\a\CON.exe", false, PathProblem::BadComponent),
            (r"{ProgramFiles}\a\x.exe.", false, PathProblem::BadComponent),
            (r"{ProgramFiles}\a b \x.exe", false, PathProblem::BadComponent),
            (r"{ProgramFiles}\a\x:y.exe", false, PathProblem::BadComponent),
            (r"{ProgramFiles}\a/b\x.exe", false, PathProblem::BadComponent),
            (r"{ProgramFiles}\\x.exe", false, PathProblem::BadComponent),
            (r"{ProgramFiles}\", false, PathProblem::BadComponent),
        ];
        for (template, portable, problem) in refused {
            assert_eq!(expand_exe(template, "app1", portable, &r), Err(problem), "{template}");
        }
        // 260 characters after expansion.
        let long = format!(r"{{ProgramFiles}}\{}\{}\{}.exe", "a".repeat(100), "b".repeat(100), "c".repeat(60));
        assert_eq!(expand_exe(&long, "app1", false, &r), Err(PathProblem::TooLong));
        // The messages never quote the value.
        assert!(!PathProblem::Denied.to_string().contains("cmd"));
    }

    #[test]
    fn a_missing_root_refuses_only_the_templates_that_need_it() {
        let r = PathRoots { program_files_x86: None, system_root: None, ..roots() };
        assert_eq!(expand_exe(r"{ProgramFilesX86}\a\x.exe", "app1", false, &r), Err(PathProblem::RootUnknown));
        assert_eq!(expand_exe(r"{SystemRoot}\System32\notepad.exe", "app1", false, &r), Err(PathProblem::RootUnknown));
        assert_eq!(
            expand_exe(r"{ProgramFiles}\VideoLAN\VLC\vlc.exe", "app1", false, &r).as_deref(),
            Ok(r"C:\Program Files\VideoLAN\VLC\vlc.exe")
        );
        assert_eq!(
            expand_exe(r"{RuleboxApps}\app1\tool.exe", "app1", true, &r).as_deref(),
            Ok(r"C:\Program Files\Rulebox\apps\app1\tool.exe")
        );
        // The other roots still work when only one is missing.
        let only_x86 = PathRoots { program_files_x86: None, ..roots() };
        assert_eq!(
            expand_exe(r"{SystemRoot}\System32\notepad.exe", "app1", false, &only_x86).as_deref(),
            Ok(r"C:\Windows\System32\notepad.exe")
        );
        // The message names no value.
        assert!(!PathProblem::RootUnknown.to_string().contains('\\'));
    }

    #[test]
    fn arguments_and_file_arguments() {
        let s = |v: &[&str]| v.iter().map(|a| a.to_string()).collect::<Vec<_>>();
        assert_eq!(check_args(&s(&["--kiosk", "-x"])), Ok(()));
        assert_eq!(check_args(&vec!["a".to_string(); 17]), Err(PathProblem::TooManyArgs));
        assert_eq!(check_args(&["a".repeat(201)]), Err(PathProblem::ArgTooLong));
        assert_eq!(check_args(&s(&["a\nb"])), Err(PathProblem::ControlCharacter));
        assert_eq!(check_file_args(&[]), Ok(()));
        assert_eq!(check_file_args(&s(&["--open", "{file}"])), Ok(()));
        assert_eq!(check_file_args(&s(&["{file}", "{file}"])), Err(PathProblem::FileArg));
        assert_eq!(check_file_args(&s(&["--open"])), Err(PathProblem::FileArg));
    }

    #[test]
    fn a_template_may_hold_one_star_in_a_middle_folder() {
        let r = roots();
        // Accepted: the pattern keeps its `*` (the caller resolves it to a folder).
        for (template, expanded) in [
            (r"{ProgramFiles}\Vendor\App\app-*\app.exe", r"C:\Program Files\Vendor\App\app-*\app.exe"),
            (r"{ProgramFiles}\Vendor\*\app.exe", r"C:\Program Files\Vendor\*\app.exe"),
            (r"{ProgramFilesX86}\Vendor\App\*-x64\bin\app.exe", r"C:\Program Files (x86)\Vendor\App\*-x64\bin\app.exe"),
        ] {
            assert_eq!(expand_exe(template, "app1", false, &r).as_deref(), Ok(expanded), "{template}");
        }
        // Refused, each with its own reason.
        let refused = [
            (r"{ProgramFiles}\*\app.exe", PathProblem::WildcardFirstSegment),
            (r"{ProgramFiles}\app-*\bin\app.exe", PathProblem::WildcardFirstSegment),
            (r"{ProgramFiles}\Vendor\app*.exe", PathProblem::WildcardFileName),
            (r"{ProgramFiles}\Vendor\*.exe", PathProblem::WildcardFileName),
            (r"{ProgramFiles}\*.exe", PathProblem::WildcardFileName),
            (r"{ProgramFiles}\Vendor\*\*\app.exe", PathProblem::WildcardTwice),
            (r"{ProgramFiles}\Vendor\a*b*\app.exe", PathProblem::WildcardTwice),
            (r"{ProgramFiles}\Vendor\*\app*.exe", PathProblem::WildcardTwice),
            (r"{ProgramFiles}\*\*\app.exe", PathProblem::WildcardTwice),
            // The other rules still apply to the rest of the template.
            (r"{ProgramFiles}\Vendor\*\app.bat", PathProblem::NotExe),
            (r"{ProgramFiles}\Vendor\a?*\app.exe", PathProblem::BadComponent),
            (r"{ProgramFiles}\Vendor\*\PWSH.exe", PathProblem::Denied),
            (r"{SystemRoot}\System32\*\notepad.exe", PathProblem::WildcardFirstSegment),
        ];
        for (template, problem) in refused {
            assert_eq!(expand_exe(template, "app1", false, &r), Err(problem), "{template}");
        }
        // A portable app lives in its own folder: no star at all.
        assert_eq!(expand_exe(r"{RuleboxApps}\app1\*\tool.exe", "app1", true, &r), Err(PathProblem::WildcardPortable));
        // Eight components still count with a star.
        assert!(expand_exe(r"{ProgramFiles}\1\2\3\4\5\6\*\8.exe", "app1", false, &r).is_ok());
        assert_eq!(expand_exe(r"{ProgramFiles}\1\2\3\4\5\6\7\*\9.exe", "app1", false, &r), Err(PathProblem::ComponentCount));
        // The messages name no value.
        assert!(!PathProblem::WildcardTwice.to_string().contains("Program"));
    }

    #[test]
    fn a_pattern_is_split_and_resolved_to_the_highest_version() {
        assert_eq!(exe_pattern(r"C:\Program Files\Vendor\app.exe"), None);
        let pattern = exe_pattern(r"C:\Program Files\Vendor\App\app-*\bin\app.exe").unwrap();
        assert_eq!(pattern.folder, r"C:\Program Files\Vendor\App");
        assert_eq!(pattern.segment, "app-*");
        assert_eq!(pattern.rest, r"bin\app.exe");
        assert_eq!(pattern.captured("app-1.2.3"), Some("1.2.3"));
        assert_eq!(pattern.captured("APP-1.2.3"), Some("1.2.3"));
        assert_eq!(pattern.captured("app-"), Some(""));
        assert_eq!(pattern.captured("ap-1"), None);
        assert_eq!(pattern.captured("xapp-1"), None);
        // 1.10 beats 1.9 (numbers, not text); a pre-release is lower; names that do not
        // fit or have no order are ignored.
        let names = ["app-1.9.0", "app-1.10.0", "app-1.10.0-beta", "app-latest", "other-2.0", "app-1.10.0.0"];
        assert_eq!(pattern.highest(names), Some("app-1.10.0"));
        assert_eq!(pattern.highest(["app-x", "app-"]), None);
        assert_eq!(pattern.highest([]), None);
        // `*` alone as the folder name, and a suffix.
        let any = exe_pattern(r"C:\P\V\*\a.exe").unwrap();
        assert_eq!(any.highest(["3.0", "12.1", "9.9.9"]), Some("12.1"));
        let suffix = exe_pattern(r"C:\P\V\*-x64\a.exe").unwrap();
        assert_eq!(suffix.captured("2.1-x64"), Some("2.1"));
        assert_eq!(suffix.highest(["2.1-x64", "3.0-x86", "2.0-x64"]), Some("2.1-x64"));
    }

    #[test]
    fn silent_arguments_accept_two_tokens_only() {
        let s = |v: &[&str]| v.iter().map(|a| a.to_string()).collect::<Vec<_>>();
        assert_eq!(check_silent_args(&s(&["/s", "/f1{AnswerFile}", "/f2{LogFile}"])), Ok(()));
        assert_eq!(check_silent_args(&s(&["{AnswerFile}{LogFile}"])), Ok(()));
        assert_eq!(check_silent_args(&s(&["/S", "/VERYSILENT", "/NORESTART"])), Ok(()));
        for bad in ["{file}", "{answerfile}", "{AnswerFile", "AnswerFile}", "{", "}", "/x{Foo}", "{{AnswerFile}}", "{AnswerFile}}", "%TEMP%{LogFile}{x}"] {
            assert_eq!(check_silent_args(&s(&[bad])), Err(PathProblem::UnknownToken), "{bad}");
        }
        // The rules of check_args apply first.
        assert_eq!(check_silent_args(&vec!["a".to_string(); 17]), Err(PathProblem::TooManyArgs));
        assert_eq!(check_silent_args(&s(&["{LogFile}\n"])), Err(PathProblem::ControlCharacter));
        // `check_args` and `check_file_args` are unchanged.
        assert_eq!(check_args(&s(&["{x}"])), Ok(()));
        assert_eq!(check_file_args(&s(&["{file}"])), Ok(()));
    }

    #[test]
    fn reset_folders_follow_the_server_rules() {
        // Accepted (convex/pathRules.test.ts "reset folders").
        assert_eq!(reset_folder_parts(r"{LocalAppData}\VideoLAN"), Ok((ResetBase::LocalAppData, vec!["VideoLAN"])));
        assert_eq!(
            reset_folder_parts(r"{RoamingAppData}\vlc\cache"),
            Ok((ResetBase::RoamingAppData, vec!["vlc", "cache"]))
        );
        assert!(reset_folder_parts(r"{LocalAppData}\a\b\c\d\e\f").is_ok());
        // Refused.
        let refused = [
            (r"{LocalAppData}\a\b\c\d\e\f\g", PathProblem::ResetComponentCount),
            (r"{LocalAppData}\..\x", PathProblem::BadComponent),
            (r"{LocalAppData}\a\..", PathProblem::BadComponent),
            (r"{LocalAppData}\.", PathProblem::BadComponent),
            (r"{LocalAppData}\", PathProblem::BadComponent),
            (r"{LocalAppData}\\x", PathProblem::BadComponent),
            (r"{LocalAppData}\a/..\x", PathProblem::BadComponent),
            (r"{LocalAppData}\C:\x", PathProblem::BadComponent),
            (r"{LocalAppData}\a:stream", PathProblem::BadComponent),
            (r"{LocalAppData}\CON", PathProblem::BadComponent),
            (r"{LocalAppData}\Acme.", PathProblem::BadComponent),
            (r"{LocalAppData}\Acme\nul.dat", PathProblem::BadComponent),
            (r"{LocalAppData}\*", PathProblem::BadComponent),
            (r"{LocalAppData}", PathProblem::ResetRoot),
            (r"C:\Users\x", PathProblem::ResetRoot),
            (r"\\server\share\x", PathProblem::ResetRoot),
            (r"{ProgramFiles}\x", PathProblem::ResetRoot),
            (r"{localappdata}\x", PathProblem::ResetRoot),
            (r"{AppData}\x", PathProblem::ResetRoot),
            (r"x{LocalAppData}\x", PathProblem::ResetRoot),
        ];
        for (template, problem) in refused {
            assert_eq!(reset_folder_parts(template), Err(problem), "{template}");
        }
        assert_eq!(ResetBase::LocalAppData.app_data_folder(), "Local");
        assert_eq!(ResetBase::RoamingAppData.app_data_folder(), "Roaming");
    }

    /// (Step 16 review) The shared vectors, also run by `convex/pathRules.test.ts`.
    #[test]
    fn reset_folders_match_the_shared_vectors() {
        #[derive(serde::Deserialize)]
        struct Vectors {
            deny: Vec<Vec<String>>,
            accept: Vec<String>,
            reject: Vec<(String, String)>,
        }
        let vectors: Vectors = serde_json::from_str(include_str!("../tests/vectors/reset-folders.json")).unwrap();
        let ours: Vec<Vec<String>> =
            RESET_DENY.iter().map(|entry| entry.iter().map(|c| c.to_string()).collect()).collect();
        assert_eq!(ours, vectors.deny, "RESET_DENY = the shared list");
        assert!(vectors.accept.len() >= 10 && vectors.reject.len() >= 20);
        for template in &vectors.accept {
            assert!(reset_folder_parts(template).is_ok(), "{template}");
        }
        for (template, kind) in &vectors.reject {
            let got = match reset_folder_parts(template) {
                Ok(_) => "accepted",
                Err(PathProblem::ResetRoot) => "root",
                Err(PathProblem::ResetComponentCount | PathProblem::BadComponent) => "path",
                Err(PathProblem::ResetDenied) => "denied",
                Err(other) => panic!("{template}: unexpected {other:?}"),
            };
            assert_eq!(got, kind, "{template}");
        }
        // The message names no value.
        assert!(!PathProblem::ResetDenied.to_string().contains("Microsoft"));
    }

    #[test]
    fn the_deny_list_matches_the_server_list() {
        // `DENY_PROGRAM_NAMES` in convex/lib/denyList.ts has 106 names.
        assert_eq!(DENY_PROGRAMS.len(), 106);
        assert!(DENY_PROGRAMS.windows(2).all(|w| w[0] < w[1]), "sorted, no duplicates");
        assert!(program_denied(r"{ProgramFiles}\x\MsHtA.EXE"));
        assert!(!program_denied(r"{SystemRoot}\System32\notepad.exe"));
        assert_eq!(program_stem(r"{ProgramFiles}\a\Tool.Exe"), "tool");
    }
}
