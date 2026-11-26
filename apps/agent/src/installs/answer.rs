//! (Phase 6 Step 14, plan 4.6 "Answer file" and 4.7) The answer file of a wizard installer (an InstallShield
//! `setup.iss`, recorded on a test PC with `setup.exe /r`) and the two tokens of `silentArgs`.
//!
//! The answer file is a file like the installer: it comes from the signed catalogue (`install.answerFile`: URL, SHA-256,
//! size of at most 256 KiB), is downloaded into the protected downloads folder as `<sha256>.iss`, is opened locked and
//! hashed again through the handle that stays open while the installer runs, and is never used when its hash is wrong
//! (`answer_file_failed`).
//!
//! **Tokens.** `{AnswerFile}` and `{LogFile}` are the only tokens expanded inside `silentArgs`, and only there. They
//! become paths in the agent's own data folder (`<data>\downloads\<sha256>.iss` and `<data>\logs\install-<appId>.log`),
//! which has no spaces, so nothing needs quoting inside `/f1{AnswerFile}`. The arguments are still handed over one by
//! one (`std::process::Command` quotes each one); no admin text ever goes through a shell. Any other `{...}` is
//! refused (`check_silent_args`, the rule of the server and of `rulebox-policy`).

use std::path::Path;

use rulebox_policy::paths::{check_silent_args, PathProblem, INSTALL_DIR_TOKEN, SILENT_ARG_TOKENS};

/// The extension of a downloaded answer file (`<sha256>.iss`).
pub const ANSWER_EXT: &str = "iss";
/// `silentArgs` token for the answer file.
pub const ANSWER_TOKEN: &str = SILENT_ARG_TOKENS[0];
/// `silentArgs` token for the installer's log file.
pub const LOG_TOKEN: &str = SILENT_ARG_TOKENS[1];
/// `silentArgs` token for the folder of the app's program (per-user installs, Tier A). Same text as `INSTALL_DIR_TOKEN`.
pub const INSTALL_DIR: &str = INSTALL_DIR_TOKEN;

/// Why `silentArgs` cannot be used.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExpandError {
    /// More arguments or longer ones than allowed, a control character, or a `{...}` that is not one of the two tokens.
    BadArguments(PathProblem),
    /// `{AnswerFile}` is used and the app has no answer file.
    NoAnswerFile,
    /// `{InstallDir}` is used and the program's folder is not known, or is not a plain absolute folder (see
    /// [`install_dir_text_ok`]).
    BadInstallDir,
}

/// Whether the folder text that replaces `{InstallDir}` is safe to put after `/D=` or `/DIR=`: a drive path
/// (`X:\...`) of 1 to 8 named folders, 260 characters at most, no control character, no quote or other character a
/// Windows path cannot hold, no `.` or `..` component, no empty component and no trailing backslash. The agent builds
/// the text from a template that passed `expand_exe`; this is the last check before it reaches a command line.
pub fn install_dir_text_ok(dir: &str) -> bool {
    let bytes = dir.as_bytes();
    if dir.chars().count() > 260 || bytes.len() < 4 || !bytes[0].is_ascii_alphabetic() || &bytes[1..3] != b":\\" {
        return false;
    }
    if dir.chars().any(|c| (c as u32) < 0x20 || c as u32 == 0x7f || "\"<>|*?/".contains(c)) {
        return false;
    }
    let folders: Vec<&str> = dir[3..].split('\\').collect();
    (1..=8).contains(&folders.len())
        && folders.iter().all(|part| !part.is_empty() && *part != "." && *part != ".." && !part.ends_with(' ') && !part.ends_with('.'))
}

/// Whether any argument holds `{InstallDir}`.
pub fn uses_install_dir(args: &[String]) -> bool {
    args.iter().any(|arg| arg.contains(INSTALL_DIR))
}

/// Whether any argument holds `{AnswerFile}`.
pub fn uses_answer_file(args: &[String]) -> bool {
    args.iter().any(|arg| arg.contains(ANSWER_TOKEN))
}

/// Whether any argument holds `{LogFile}`.
pub fn uses_log_file(args: &[String]) -> bool {
    args.iter().any(|arg| arg.contains(LOG_TOKEN))
}

/// The file name of an answer file in the downloads folder.
pub fn answer_file_name(sha256: &str) -> String {
    format!("{sha256}.{ANSWER_EXT}")
}

/// `silentArgs` with `{AnswerFile}`, `{LogFile}` and `{InstallDir}` replaced by the given paths. The rules of
/// `check_silent_args` are checked first, so nothing but the three tokens is ever expanded; the replacement is one pass
/// over the original text (a path is never scanned for tokens again). `answer` is `None` when the app has no answer
/// file: an argument that uses its token is then refused. `install_dir` is the program's folder (`None` when it is not
/// known); a `{InstallDir}` without one, or with text that fails [`install_dir_text_ok`], is refused.
pub fn expand_silent_args(args: &[String], answer: Option<&Path>, log: &Path, install_dir: Option<&str>) -> Result<Vec<String>, ExpandError> {
    check_silent_args(args).map_err(ExpandError::BadArguments)?;
    if uses_answer_file(args) && answer.is_none() {
        return Err(ExpandError::NoAnswerFile);
    }
    if uses_install_dir(args) && !install_dir.is_some_and(install_dir_text_ok) {
        return Err(ExpandError::BadInstallDir);
    }
    let answer = answer.map(|path| path.to_string_lossy().into_owned());
    let log = log.to_string_lossy().into_owned();
    Ok(args.iter().map(|arg| expand_one(arg, answer.as_deref(), &log, install_dir)).collect())
}

/// One argument, one pass from left to right: a token becomes its path and the path is not looked at again.
fn expand_one(arg: &str, answer: Option<&str>, log: &str, install_dir: Option<&str>) -> String {
    let mut out = String::with_capacity(arg.len() + 64);
    let mut rest = arg;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let tail = &rest[open..];
        if let (Some(path), Some(after)) = (answer, tail.strip_prefix(ANSWER_TOKEN)) {
            out.push_str(path);
            rest = after;
        } else if let Some(after) = tail.strip_prefix(LOG_TOKEN) {
            out.push_str(log);
            rest = after;
        } else if let (Some(dir), Some(after)) = (install_dir, tail.strip_prefix(INSTALL_DIR)) {
            out.push_str(dir);
            rest = after;
        } else {
            // Not reachable after `check_silent_args`; kept as text rather than guessed at.
            out.push('{');
            rest = &tail[1..];
        }
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(list: &[&str]) -> Vec<String> {
        list.iter().map(|item| (*item).to_string()).collect()
    }

    const ANSWER: &str = r"C:\ProgramData\Rulebox\downloads\aaaa.iss";
    const LOG: &str = r"C:\ProgramData\Rulebox\logs\install-app1.log";

    #[test]
    fn both_tokens_are_replaced_one_argument_at_a_time() {
        let out = expand_silent_args(&s(&["/s", "/f1{AnswerFile}", "/f2{LogFile}"]), Some(Path::new(ANSWER)), Path::new(LOG), None).unwrap();
        assert_eq!(out, ["/s".to_string(), format!("/f1{ANSWER}"), format!("/f2{LOG}")]);
        // Both in one argument, the same token twice, and no token at all.
        let out = expand_silent_args(&s(&["{AnswerFile}{LogFile}{AnswerFile}", "/S"]), Some(Path::new(ANSWER)), Path::new(LOG), None).unwrap();
        assert_eq!(out, [format!("{ANSWER}{LOG}{ANSWER}"), "/S".to_string()]);
        let plain = s(&["/SP-", "/VERYSILENT", "/DIR=C:\\X Y"]);
        assert_eq!(expand_silent_args(&plain, None, Path::new(LOG), None).unwrap(), plain);
        assert!(expand_silent_args(&[], None, Path::new(LOG), None).unwrap().is_empty());
        // The data folder has no space, so `/f1<path>` needs no quoting (plan 4.6).
        assert!(!ANSWER.contains(' ') && !LOG.contains(' '));
    }

    #[test]
    fn a_token_in_the_wrong_place_or_of_the_wrong_kind_is_refused() {
        let log = Path::new(LOG);
        let answer = Some(Path::new(ANSWER));
        for bad in ["{answerfile}", "{AnswerFile", "AnswerFile}", "{LogFile }", "{ProgramFiles}", "{file}", "{", "}", "{AnswerFile}}", "%TEMP%{x}"] {
            assert_eq!(
                expand_silent_args(&s(&["/s", bad]), answer, log, None),
                Err(ExpandError::BadArguments(PathProblem::UnknownToken)),
                "{bad}"
            );
        }
        // The rules of `check_args` still apply (a control character, too many arguments, too long).
        assert!(matches!(expand_silent_args(&s(&["{LogFile}\n"]), answer, log, None), Err(ExpandError::BadArguments(PathProblem::ControlCharacter))));
        assert!(matches!(expand_silent_args(&vec!["/a".to_string(); 17], answer, log, None), Err(ExpandError::BadArguments(PathProblem::TooManyArgs))));
        assert!(matches!(expand_silent_args(&[format!("/{}", "x".repeat(200))], answer, log, None), Err(ExpandError::BadArguments(PathProblem::ArgTooLong))));
    }

    #[test]
    fn the_answer_file_token_needs_an_answer_file() {
        assert_eq!(expand_silent_args(&s(&["/s", "/f1{AnswerFile}"]), None, Path::new(LOG), None), Err(ExpandError::NoAnswerFile));
        // `{LogFile}` alone needs none.
        assert!(expand_silent_args(&s(&["/f2{LogFile}"]), None, Path::new(LOG), None).is_ok());
    }

    #[test]
    fn a_path_is_never_expanded_again() {
        // Whatever the path says, it is inserted as text: a token inside it stays text (the agent's paths have none; the
        // point is the single pass).
        let out = expand_silent_args(&s(&["/f1{AnswerFile}"]), Some(Path::new(r"C:\x{LogFile}\a.iss")), Path::new(LOG), None).unwrap();
        assert_eq!(out, [r"/f1C:\x{LogFile}\a.iss".to_string()]);
        let out = expand_silent_args(&s(&["{LogFile}|{AnswerFile}"]), Some(Path::new("ANS")), Path::new(r"C:\y{AnswerFile}.log"), None).unwrap();
        assert_eq!(out, [r"C:\y{AnswerFile}.log|ANS".to_string()]);
    }

    const DIR: &str = r"C:\Program Files\Zahras POS Dev";

    #[test]
    fn the_install_dir_token_becomes_the_program_folder() {
        let log = Path::new(LOG);
        // NSIS shape (spaces stay as they are: the platform passes it unquoted) and Inno shape.
        let out = expand_silent_args(&s(&["/S", "/D={InstallDir}"]), None, log, Some(DIR)).unwrap();
        assert_eq!(out, ["/S".to_string(), format!("/D={DIR}")]);
        let out = expand_silent_args(&s(&["/VERYSILENT", "/DIR={InstallDir}"]), None, log, Some(DIR)).unwrap();
        assert_eq!(out, ["/VERYSILENT".to_string(), format!("/DIR={DIR}")]);
        // A folder that holds a token stays text (one pass).
        let out = expand_silent_args(&s(&["/D={InstallDir}"]), None, log, Some(r"C:\Program Files\A{LogFile}B")).unwrap();
        assert_eq!(out, [r"/D=C:\Program Files\A{LogFile}B".to_string()]);
        // Without a folder the token is refused, and nothing is expanded by guess.
        assert_eq!(expand_silent_args(&s(&["/D={InstallDir}"]), None, log, None), Err(ExpandError::BadInstallDir));
        // No token: the folder is not looked at at all.
        assert_eq!(expand_silent_args(&s(&["/S"]), None, log, Some("garbage")).unwrap(), ["/S".to_string()]);
        assert!(uses_install_dir(&s(&["/D={InstallDir}"])) && !uses_install_dir(&s(&["/D=C:\\x"])));
    }

    #[test]
    fn hostile_folder_text_never_reaches_the_command_line() {
        let log = Path::new(LOG);
        for bad in [
            "",
            "Program Files\\X",
            r"C:\Program Files\X\",
            r"C:\Program Files\X\..\Y",
            r"C:\Program Files\.\X",
            r"C:\Program Files\\X",
            r#"C:\Program Files\X" /S"#,
            "C:\\Program Files\\X\n/S",
            r"C:\Program Files\X|Y",
            r"C:\Program Files\X<Y",
            r"C:\Program Files\X*",
            r"C:\Program Files\X?",
            r"C:/Program Files/X",
            r"\\server\share\X",
            r"C:\Program Files\X.",
            r"C:\a\b\c\d\e\f\g\h\i",
        ] {
            assert!(!install_dir_text_ok(bad), "{bad:?}");
            assert_eq!(expand_silent_args(&s(&["/D={InstallDir}"]), None, log, Some(bad)), Err(ExpandError::BadInstallDir), "{bad:?}");
        }
        assert!(install_dir_text_ok(DIR));
        assert!(install_dir_text_ok(r"C:\Program Files (x86)\AT&T\App-1.2_x"));
        assert!(!install_dir_text_ok(&format!(r"C:\{}", "a".repeat(300))));
    }

    #[test]
    fn which_tokens_an_argument_list_uses_and_how_the_file_is_named() {
        assert!(uses_answer_file(&s(&["/f1{AnswerFile}"])) && !uses_answer_file(&s(&["/f2{LogFile}"])));
        assert!(uses_log_file(&s(&["/f2{LogFile}"])) && !uses_log_file(&s(&["/S"])));
        assert_eq!(answer_file_name(&"a".repeat(64)), format!("{}.iss", "a".repeat(64)));
    }
}
