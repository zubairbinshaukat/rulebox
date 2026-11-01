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
    /// `FOLDERID_ProgramFilesX86`.
    pub program_files_x86: String,
    /// `FOLDERID_Windows`.
    pub system_root: String,
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
        (PROGRAM_FILES_X86, roots.program_files_x86.trim_end_matches('\\').to_string())
    } else if exe.starts_with(SYSTEM32) {
        (SYSTEM32, format!("{}\\System32", roots.system_root.trim_end_matches('\\')))
    } else {
        // `{RuleboxApps}\` is a root only for portable apps.
        return Err(PathProblem::UnknownRoot);
    };
    let rest: Vec<&str> = exe[prefix.len()..].split('\\').collect();
    if rest.is_empty() || rest.len() > 8 {
        return Err(PathProblem::ComponentCount);
    }
    if !rest.iter().all(|c| valid_component(c)) {
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
            program_files_x86: r"C:\Program Files (x86)".into(),
            system_root: r"C:\Windows".into(),
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
    fn the_deny_list_matches_the_server_list() {
        // `DENY_PROGRAM_NAMES` in convex/lib/denyList.ts has 106 names.
        assert_eq!(DENY_PROGRAMS.len(), 106);
        assert!(DENY_PROGRAMS.windows(2).all(|w| w[0] < w[1]), "sorted, no duplicates");
        assert!(program_denied(r"{ProgramFiles}\x\MsHtA.EXE"));
        assert!(!program_denied(r"{SystemRoot}\System32\notepad.exe"));
        assert_eq!(program_stem(r"{ProgramFiles}\a\Tool.Exe"), "tool");
    }
}
