//! Tests of the allow-list model (plan Step 7): SDDL reading, the writable-folder scan from DACL
//! fixtures, the Windows cut-outs, catalogue folders and exceptions. Pure; no platform.

use rulebox_policy::lockdown::{ExceptionKind, ExceptionLayer, ExceptionRule, PublisherMatch};
use rulebox_policy::paths::PathRoots;

use super::*;
use crate::platform::sim::sim_path_roots;

const STAFF: &str = "S-1-5-21-1-1-1-2001";
const ADMIN_ONLY: &str = "D:PAI(A;OICI;FA;;;BA)(A;OICI;FA;;;SY)(A;OICI;0x1200a9;;;BU)(A;OICIIO;GXGR;;;AC)";

fn roots() -> PathRoots {
    sim_path_roots()
}

fn protected() -> Vec<String> {
    vec![r"C:\Program Files\Rulebox".into(), r"C:\Program Files (x86)\Microsoft\EdgeWebView".into()]
}

fn scan(entries: &[(&str, &str)]) -> Vec<FolderAcl> {
    entries.iter().map(|(path, sddl)| FolderAcl { path: (*path).into(), sddl: (*sddl).into() }).collect()
}

fn inputs<'a>(roots: &'a PathRoots, protected: &'a [String], scan: &'a [FolderAcl], catalogue: &'a [String], exceptions: &'a [ExceptionRule]) -> Inputs<'a> {
    Inputs {
        roots,
        protected,
        catalogue_folders: catalogue,
        exceptions,
        accessibility_tools: false,
        windows_scan: scan,
        staff_sid: STAFF,
    }
}

fn no_acl(_: &str) -> Result<Option<String>, ()> {
    Ok(None)
}

// ---------------------------------------------------------------- SDDL

#[test]
fn rights_are_read_from_tokens_and_hex() {
    assert_eq!(rights_mask("0x1200a9"), 0x1200a9);
    assert_eq!(rights_mask("FA"), 0x1F01FF);
    assert_eq!(rights_mask("FRFX"), 0x120089 | 0x1200a0);
    assert_eq!(rights_mask("GW"), GENERIC_WRITE);
    assert_eq!(rights_mask("CCDC"), 0x3);
    assert_eq!(rights_mask("ZZ"), 0, "an unknown word is no right");
    assert_eq!(rights_mask("0xnope"), 0);
}

#[test]
fn a_folder_is_writable_by_staff_when_staff_or_a_broad_group_may_write_into_it() {
    let writable = [
        "D:(A;OICI;0x1301bf;;;BU)",
        "D:PAI(A;;FW;;;WD)",
        "D:(A;;GW;;;AU)",
        "D:(A;;GA;;;IU)",
        "D:(A;CI;CCDCLC;;;S-1-5-32-545)",
        "D:(A;OICI;FA;;;S-1-5-21-1-1-1-2001)",
        "D:(A;;0x2;;;S-1-1-0)",
        "D:(A;;0x40;;;BU)",
    ];
    for sddl in writable {
        assert!(writable_by_staff(sddl, STAFF), "{sddl}");
    }
    let not_writable = [
        ADMIN_ONLY,
        "D:(A;OICI;FA;;;BA)(A;OICI;FRFX;;;BU)",
        // Inherit-only: it applies to children, not to the folder itself.
        "D:(A;OICIIO;GW;;;BU)",
        // A deny ACE is never counted as a way in.
        "D:(D;;FA;;;BU)(A;;FA;;;BA)",
        // Another account's write access is none of Staff's business.
        "D:(A;OICI;FA;;;S-1-5-21-1-1-1-2002)",
        "D:(A;;FA;;;CO)",
        "",
        "not a dacl",
    ];
    for sddl in not_writable {
        assert!(!writable_by_staff(sddl, STAFF), "{sddl}");
    }
}

#[test]
fn aces_are_split_with_type_flags_rights_and_trustee() {
    let list = aces("D:PAI(A;OICI;FA;;;BA)(D;;SW;;;S-1-5-21-1-1-1-2001)S:(AU;SA;FA;;;WD)");
    assert_eq!(list.len(), 2, "the SACL part is ignored");
    assert_eq!((list[0].kind.as_str(), list[0].flags.as_str(), list[0].rights.as_str(), list[0].trustee.as_str()), ("A", "OICI", "FA", "BA"));
    assert_eq!((list[1].kind.as_str(), list[1].trustee.as_str()), ("D", STAFF));
    assert!(aces("D:(broken").is_empty() && aces("S:(AU;SA;FA;;;WD)").is_empty());
}

// ---------------------------------------------------------------- locations

#[test]
fn user_writable_locations_are_never_path_rule_roots() {
    let r = roots();
    for path in [
        r"C:\Users",
        r"C:\Users\Staff\AppData\Local\Acme",
        r"c:\users\public",
        r"C:\ProgramData\Acme",
        r"C:\Temp",
        r"C:\Windows\Temp",
        r"C:\Windows\Tasks\x",
        r"C:\Windows\System32\spool\drivers\color",
        r"D:",
        r"D:\",
        r"C:\Apps\AppData\x",
        r"C:\Stuff\Temp\x",
    ] {
        assert!(is_user_writable_location(path, &r), "{path}");
    }
    for path in [
        r"C:\Program Files\Acme",
        r"C:\Program Files (x86)\Acme",
        r"C:\Windows",
        r"C:\Windows\System32",
        r"C:\Program Files\Rulebox\apps\app1",
        r"D:\Tools",
    ] {
        assert!(!is_user_writable_location(path, &r), "{path}");
    }
}

#[test]
fn inside_means_whole_folder_names_and_ignores_case_and_slashes() {
    assert!(inside(r"C:\Program Files\Rulebox\versions\1", r"c:\program files\rulebox"));
    assert!(inside(r"C:/Program Files/Rulebox/", r"C:\Program Files\Rulebox"));
    assert!(inside(r"C:\Windows", r"C:\Windows"));
    assert!(!inside(r"C:\Windows2", r"C:\Windows"));
    assert!(!inside(r"C:\Program Files\RuleboxEvil", r"C:\Program Files\Rulebox"));
    assert!(!inside(r"C:\x", ""));
}

// ---------------------------------------------------------------- the deny list

#[test]
fn the_deny_list_is_sorted_unique_lower_case_exe_files_with_a_reason_each() {
    let names: Vec<&str> = STAFF_DENY_WINDOWS_BINARIES.iter().map(|e| e.file).collect();
    let mut plain: Vec<&str> = names.iter().copied().filter(|n| !STAFF_DENY_WINDOWS_BINARIES.iter().any(|e| e.file == *n && e.accessibility)).collect();
    // The ordinary entries are sorted; the accessibility entries follow, sorted too.
    let mut sorted = plain.clone();
    sorted.sort_unstable();
    assert_eq!(plain, sorted, "sorted by file name");
    let access: Vec<&str> = STAFF_DENY_WINDOWS_BINARIES.iter().filter(|e| e.accessibility).map(|e| e.file).collect();
    let mut access_sorted = access.clone();
    access_sorted.sort_unstable();
    assert_eq!(access, access_sorted);
    plain.extend(access);
    let mut all = plain.clone();
    all.sort_unstable();
    all.dedup();
    assert_eq!(all.len(), plain.len(), "no file twice");
    for entry in STAFF_DENY_WINDOWS_BINARIES {
        assert!(entry.file.ends_with(".exe") && entry.file == entry.file.to_ascii_lowercase(), "{}", entry.file);
        assert!(entry.why.len() >= 8, "{} needs a reason", entry.file);
        assert!(!entry.folders.is_empty());
        for folder in entry.folders {
            assert!(!folder.starts_with('\\') && !folder.ends_with('\\') && !folder.contains(".."), "{folder}");
        }
        // Nothing of Rulebox or WebView2 is ever on the list (invariants I1, I2).
        assert!(!entry.file.contains("rulebox") && !entry.file.contains("webview"), "{}", entry.file);
    }
    for must in [
        "cmd.exe", "powershell.exe", "powershell_ise.exe", "wscript.exe", "cscript.exe", "mshta.exe", "regedit.exe", "reg.exe",
        "mmc.exe", "taskmgr.exe", "msiexec.exe", "rundll32.exe", "regsvr32.exe", "explorer.exe", "msbuild.exe", "wmic.exe", "wsl.exe",
        "bash.exe", "net.exe", "sc.exe", "schtasks.exe", "certutil.exe", "bitsadmin.exe",
    ] {
        assert!(names.contains(&must), "{must}");
    }
    // Every Windows program the Phase 4 catalogue refuses is on this list too, unless it is not
    // shipped in the Windows folder (runtimes, third-party tools).
    for name in ["cmd", "powershell", "taskmgr", "regedit", "mmc", "wscript", "cscript", "mshta", "explorer", "rundll32"] {
        assert!(rulebox_policy::paths::DENY_PROGRAMS.contains(&name), "{name} is in the catalogue deny list");
        assert!(names.contains(&format!("{name}.exe").as_str()), "{name}");
    }
}

#[test]
fn the_known_writable_windows_folders_are_relative_plain_and_unique() {
    let mut seen = std::collections::HashSet::new();
    for folder in KNOWN_WRITABLE_WINDOWS_FOLDERS {
        assert!(!folder.starts_with('\\') && !folder.contains(':') && !folder.contains(".."), "{folder}");
        assert!(seen.insert(folder.to_ascii_lowercase()), "{folder} twice");
    }
}

// ---------------------------------------------------------------- build

#[test]
fn the_windows_part_cuts_out_writable_folders_from_the_scan_and_the_known_list() {
    let r = roots();
    let p = protected();
    let found = scan(&[
        (r"C:\Windows", ADMIN_ONLY),
        (r"C:\Windows\System32", ADMIN_ONLY),
        (r"C:\Windows\Logs", ADMIN_ONLY),
        (r"C:\Windows\Vendor\Cache", "D:(A;OICI;0x1301bf;;;BU)"),
        (r"C:\Windows\Vendor\Cache\deeper", "D:(A;OICI;0x1301bf;;;BU)"),
        (r"C:\Windows\Temp\child", "D:(A;OICI;GW;;;WD)"),
        (r"D:\Elsewhere", "D:(A;OICI;GW;;;WD)"),
    ]);
    let list = build(&inputs(&r, &p, &found, &[], &[]), no_acl).unwrap();
    assert_eq!(list.windows, r"C:\Windows");
    let folders = &list.windows_excluded_folders;
    assert!(folders.iter().any(|f| f == r"C:\Windows\Vendor\Cache"), "{folders:?}");
    assert!(folders.iter().any(|f| f == r"C:\Windows\Temp"), "the known list is always there");
    assert!(folders.iter().any(|f| f == r"C:\Windows\System32\spool\drivers\color"));
    assert!(!folders.iter().any(|f| f.ends_with("deeper") || f.ends_with("child")), "a folder below one that is cut is not repeated: {folders:?}");
    assert!(!folders.iter().any(|f| f.eq_ignore_ascii_case(r"C:\Windows") || f.contains("Logs") || f.starts_with("D:")), "{folders:?}");
    // Sorted, no duplicates.
    let keys: Vec<String> = folders.iter().map(|f| f.to_ascii_lowercase()).collect();
    let mut sorted = keys.clone();
    sorted.sort();
    sorted.dedup();
    assert_eq!(keys, sorted);
    // Nothing with a rule is both allowed and cut: the invariant folders are untouched.
    assert_eq!(list.invariant.len(), 2);
    assert!(list.blocked_paths().iter().all(|blocked| p.iter().all(|prot| !inside(blocked, prot) && !inside(prot, blocked))));
}

#[test]
fn a_scan_that_found_nothing_still_cuts_the_known_folders_out() {
    let r = roots();
    let p = protected();
    let list = build(&inputs(&r, &p, &[], &[], &[]), no_acl).unwrap();
    assert_eq!(list.windows_excluded_folders.len(), KNOWN_WRITABLE_WINDOWS_FOLDERS.len());
}

#[test]
fn denied_programs_are_listed_by_path_and_by_original_name() {
    let r = roots();
    let p = protected();
    let list = build(&inputs(&r, &p, &[], &[], &[]), no_acl).unwrap();
    for path in [
        r"C:\Windows\System32\cmd.exe",
        r"C:\Windows\SysWOW64\cmd.exe",
        r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe",
        r"C:\Windows\regedit.exe",
        r"C:\Windows\explorer.exe",
        r"C:\Windows\Microsoft.NET\Framework64\v4.0.30319\msbuild.exe",
        r"C:\Windows\System32\wbem\wmic.exe",
        r"C:\Windows\System32\narrator.exe",
    ] {
        assert!(list.windows_excluded_files.iter().any(|f| f == path), "{path}");
    }
    for name in ["CMD.EXE", "POWERSHELL.EXE", "REGEDIT.EXE", "MSBUILD.EXE", "NARRATOR.EXE"] {
        assert!(list.windows_excluded_names.iter().any(|n| n == name), "{name}");
    }
    assert!(list.windows_excluded_names.windows(2).all(|w| w[0] < w[1]));
}

#[test]
fn accessibility_tools_come_off_the_list_only_when_asked_for() {
    let r = roots();
    let p = protected();
    let off = build(&inputs(&r, &p, &[], &[], &[]), no_acl).unwrap();
    let on = build(&Inputs { accessibility_tools: true, ..inputs(&r, &p, &[], &[], &[]) }, no_acl).unwrap();
    for name in ["NARRATOR.EXE", "MAGNIFY.EXE", "OSK.EXE", "SETHC.EXE", "UTILMAN.EXE"] {
        assert!(off.windows_excluded_names.iter().any(|n| n == name), "{name} denied by default");
        assert!(!on.windows_excluded_names.iter().any(|n| n == name), "{name} allowed with accessibilityTools");
    }
    assert!(on.windows_excluded_names.iter().any(|n| n == "CMD.EXE"), "the shells stay denied");
    assert_eq!(off.windows_excluded_files.len() - on.windows_excluded_files.len(), 5 * 2);
}

#[test]
fn a_catalogue_folder_is_a_path_rule_only_when_it_is_admin_only() {
    let r = roots();
    let p = protected();
    let catalogue: Vec<String> = [
        r"C:\Program Files\Acme",
        r"C:\Program Files (x86)\Old Tool",
        r"C:\Users\Staff\AppData\Local\Portable",
        r"C:\Program Files\Open Folder",
        r"C:\Program Files\Rulebox\apps\app1",
        r"C:\Windows\System32",
        r"D:\Tools\Unreadable",
        r"C:\Program Files\Acme\",
    ]
    .iter()
    .map(|s| (*s).to_string())
    .collect();
    let acl = |folder: &str| -> Result<Option<String>, ()> {
        match folder {
            r"C:\Program Files\Open Folder" => Ok(Some("D:(A;OICI;0x1301bf;;;BU)".into())),
            r"D:\Tools\Unreadable" => Err(()),
            _ => Ok(Some(ADMIN_ONLY.into())),
        }
    };
    let list = build(&inputs(&r, &p, &[], &catalogue, &[]), acl).unwrap();
    assert_eq!(list.catalogue, [r"C:\Program Files (x86)\Old Tool", r"C:\Program Files\Acme"]);
    // Refused: the user folder, the writable one and the one that could not be read.
    assert_eq!(list.notes, ["catalogue_folder_writable"]);
    // Inside an invariant folder or the Windows folder: already covered, no extra rule.
    assert!(!list.catalogue.iter().any(|f| f.contains("Rulebox") || f.contains("Windows")));
}

fn exception(kind: ExceptionKind, layers: Vec<ExceptionLayer>) -> ExceptionRule {
    ExceptionRule { id: "ex1".into(), app_id: None, kind, publisher: None, sha256: None, path: None, layers }
}

#[test]
fn exceptions_for_this_layer_become_publisher_hash_and_admin_only_path_rules() {
    let r = roots();
    let p = protected();
    let exceptions = vec![
        ExceptionRule {
            publisher: Some(PublisherMatch { subject: "O=Acme Ltd".into(), product: Some("Tool".into()), file_name: None }),
            ..exception(ExceptionKind::Publisher, vec![ExceptionLayer::AppLocker, ExceptionLayer::ProcWatch])
        },
        ExceptionRule { id: "ex2".into(), sha256: Some("ab".repeat(32)), ..exception(ExceptionKind::Hash, vec![ExceptionLayer::AppLocker]) },
        ExceptionRule {
            id: "ex3".into(),
            path: Some(r"{ProgramFiles}\Acme\tool.exe".into()),
            ..exception(ExceptionKind::Path, vec![ExceptionLayer::AppLocker])
        },
        // Process watchdog only: not this layer's.
        ExceptionRule { id: "ex4".into(), sha256: Some("cd".repeat(32)), ..exception(ExceptionKind::Hash, vec![ExceptionLayer::ProcWatch]) },
    ];
    let list = build(&inputs(&r, &p, &[], &[], &exceptions), no_acl).unwrap();
    assert_eq!(list.exceptions.len(), 3, "{:?}", list.exceptions);
    assert!(list.exceptions.contains(&AllowException::Publisher { subject: "O=Acme Ltd".into(), product: Some("Tool".into()), file_name: None }));
    assert!(list.exceptions.contains(&AllowException::Hash { sha256: "ab".repeat(32), source: "exception-ex2".into() }));
    assert!(list.exceptions.contains(&AllowException::Path(r"C:\Program Files\Acme\tool.exe".into())));
    assert!(list.notes.is_empty());
}

#[test]
fn a_path_exception_under_a_writable_folder_is_refused_and_named() {
    let r = roots();
    let p = protected();
    let path_rule = |id: &str, path: &str| ExceptionRule {
        id: id.into(),
        path: Some(path.into()),
        ..exception(ExceptionKind::Path, vec![ExceptionLayer::AppLocker])
    };
    let exceptions = vec![
        // The folder's DACL lets Users write.
        path_rule("w1", r"{ProgramFiles}\Open\tool.exe"),
        // A bad template (the plan allows only the three roots).
        path_rule("w2", r"{SystemRoot}\System32\tool.exe"),
        // The DACL cannot be read.
        path_rule("w3", r"{ProgramFilesX86}\Unreadable\tool.exe"),
    ];
    let acl = |folder: &str| -> Result<Option<String>, ()> {
        match folder {
            r"C:\Program Files\Open" => Ok(Some("D:(A;OICI;GW;;;AU)".into())),
            r"C:\Program Files (x86)\Unreadable" => Err(()),
            _ => Ok(None),
        }
    };
    let list = build(&inputs(&r, &p, &[], &[], &exceptions), acl).unwrap();
    assert!(list.exceptions.is_empty(), "{:?}", list.exceptions);
    assert_eq!(list.notes, ["exception_invalid", "exception_path_writable"]);
}

#[test]
fn a_pc_that_does_not_tell_its_windows_folder_builds_nothing() {
    let r = PathRoots { system_root: None, ..roots() };
    let p = protected();
    assert_eq!(build(&inputs(&r, &p, &[], &[], &[]), no_acl).unwrap_err(), "windows_folder_unknown");
}
