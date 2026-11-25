//! The allow-list model of plan 4.9 (Phase 5 Step 7): what the Staff account may start under
//! AppLocker, built from the document and machine facts at apply time.
//!
//! | Part | Content |
//! |---|---|
//! | Invariant | the Rulebox install folder (agent, launcher, Staff App `versions\`, the managed apps folder) and the WebView2 runtime folder (invariants I1 and I2) |
//! | Windows | the Windows folder **minus** the folders under it that standard users can write to (a scan of their DACLs plus [`KNOWN_WRITABLE_WINDOWS_FOLDERS`]) **and** [`STAFF_DENY_WINDOWS_BINARIES`] |
//! | Catalogue | the folder of every catalogue app, as a path rule when it is admin-only, else refused. (Phase 6 Step 17, plan 4.9.4) The program folder of an assigned browser (`browser::BrowserInputs::allow_folders`: Edge's per-machine folder, Chrome's from its catalogue app) is one of them while a browser web app or a Chrome or Edge program is assigned, and goes with it |
//! | Exceptions | publisher, hash and path rules from `lockdown.exceptions` for the AppLocker layer |
//! | Accessibility | Narrator, Magnifier and the on-screen keyboard, only with `accessibilityTools` |
//!
//! Everything here is pure: the platform reads (the scan, a folder's DACL) are done by the
//! caller and passed in. A path allow rule is never produced for a folder that standard users
//! can write to (plan 4.9, edge case 13); such an exception or catalogue folder is **refused**
//! and named in [`AllowList::notes`], and the admin can use a publisher or hash rule instead.

use rulebox_policy::lockdown::{ExceptionKind, ExceptionLayer, ExceptionRule};
use rulebox_policy::paths::PathRoots;

use crate::platform::FolderAcl;

// ---------------------------------------------------------------- the constants

/// One program of the Windows folder that Staff may never start. A match is by **path** (each
/// of `folders` below the Windows folder, `""` meaning the Windows folder itself) and by the
/// **original file name** from the version resource (so a renamed copy of a signed program is
/// refused wherever it sits). Plan 4.9: the list starts from Microsoft's recommended block
/// rules plus Windows' shells, script hosts, registry editors and management consoles; a
/// change to it is a plan change.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DenyBinary {
    /// The file name, lower case, `.exe`.
    pub file: &'static str,
    /// Where it lives, relative to the Windows folder.
    pub folders: &'static [&'static str],
    /// Why Staff may not start it.
    pub why: &'static str,
    /// Allowed again when `accessibilityTools` is on.
    pub accessibility: bool,
}

const SYS: &[&str] = &["System32", "SysWOW64"];
const ROOT: &[&str] = &[""];
const PS: &[&str] = &[r"System32\WindowsPowerShell\v1.0", r"SysWOW64\WindowsPowerShell\v1.0"];
const DOTNET: &[&str] = &[
    r"Microsoft.NET\Framework\v4.0.30319",
    r"Microsoft.NET\Framework64\v4.0.30319",
    r"Microsoft.NET\Framework\v2.0.50727",
    r"Microsoft.NET\Framework64\v2.0.50727",
];
const WBEM: &[&str] = &[r"System32\wbem", r"SysWOW64\wbem"];
const SSH: &[&str] = &[r"System32\OpenSSH"];

const fn deny(file: &'static str, folders: &'static [&'static str], why: &'static str) -> DenyBinary {
    DenyBinary { file, folders, why, accessibility: false }
}

const fn accessibility(file: &'static str, why: &'static str) -> DenyBinary {
    DenyBinary { file, folders: SYS, why, accessibility: true }
}

/// The reviewed list, sorted by file name (a test checks that). Staff cannot start any of these
/// from the Windows folder; administrators and the SYSTEM service are not affected.
pub const STAFF_DENY_WINDOWS_BINARIES: &[DenyBinary] = &[
    deny("addinprocess.exe", DOTNET, "Microsoft recommended block: loads arbitrary .NET add-ins"),
    deny("addinprocess32.exe", DOTNET, "Microsoft recommended block: 32-bit twin of addinprocess"),
    deny("addinutil.exe", DOTNET, "Microsoft recommended block: add-in utility that runs .NET code"),
    deny("at.exe", SYS, "Task scheduling from a command line"),
    deny("bash.exe", SYS, "Linux shell (WSL launcher)"),
    deny("bcdedit.exe", SYS, "Changes the boot configuration"),
    deny("bitsadmin.exe", SYS, "Downloads and runs files through BITS"),
    deny("cacls.exe", SYS, "Changes file permissions"),
    deny("certreq.exe", SYS, "Certificate requests; downloads files"),
    deny("certutil.exe", SYS, "Downloads and decodes files"),
    deny("cmd.exe", SYS, "Command shell"),
    deny("cmstp.exe", SYS, "Connection manager profile installer; runs commands"),
    deny("control.exe", SYS, "Control Panel: opens settings and system tools"),
    deny("csc.exe", DOTNET, "Microsoft recommended block: C# compiler"),
    deny("cscript.exe", SYS, "Script host (console)"),
    deny("dfsvc.exe", DOTNET, "Microsoft recommended block: ClickOnce deployment service"),
    deny("diskpart.exe", SYS, "Disk management console"),
    deny("dism.exe", SYS, "Servicing: adds and removes Windows features"),
    deny("esentutl.exe", SYS, "Copies locked files"),
    deny("eventvwr.exe", SYS, "Event viewer: opens the management console"),
    deny("expand.exe", SYS, "Extracts files"),
    deny("explorer.exe", ROOT, "File Explorer: the Staff shell is the Rulebox launcher; Explorer would open any folder"),
    deny("extrac32.exe", SYS, "Extracts cabinet files"),
    deny("forfiles.exe", SYS, "Runs a command for each file"),
    deny("ftp.exe", SYS, "Command-line file transfer with a script mode"),
    deny("hh.exe", ROOT, "Help viewer: opens arbitrary links and files"),
    deny("icacls.exe", SYS, "Changes file permissions"),
    deny("ieexec.exe", DOTNET, "Microsoft recommended block: runs .NET code from a URL"),
    deny("infdefaultinstall.exe", SYS, "Microsoft recommended block: installs from INF files"),
    deny("installutil.exe", DOTNET, "Microsoft recommended block: runs .NET installer classes"),
    deny("jsc.exe", DOTNET, "Microsoft recommended block: JScript compiler"),
    deny("makecab.exe", SYS, "Packs and hides files"),
    deny("mavinject.exe", SYS, "Microsoft recommended block: injects DLLs into processes"),
    deny("mmc.exe", SYS, "Management console host (Computer Management, Services, Disk Management)"),
    deny("msbuild.exe", DOTNET, "Microsoft recommended block: build engine that compiles and runs code"),
    deny("msconfig.exe", SYS, "System configuration"),
    deny("msdt.exe", SYS, "Support diagnostic tool; runs diagnostic scripts"),
    deny("mshta.exe", SYS, "Microsoft recommended block: HTML application host"),
    deny("msiexec.exe", SYS, "Windows Installer: Staff does not install software (the agent installs as SYSTEM)"),
    deny("net.exe", SYS, "Account and share management"),
    deny("net1.exe", SYS, "Account and share management (twin of net)"),
    deny("netsh.exe", SYS, "Network configuration"),
    deny("odbcconf.exe", SYS, "Microsoft recommended block: loads DLLs through a response file"),
    deny("pcalua.exe", SYS, "Program Compatibility Assistant: starts any program"),
    deny("pcwrun.exe", SYS, "Compatibility troubleshooter launcher"),
    deny("pnputil.exe", SYS, "Driver management"),
    deny("powershell.exe", PS, "Microsoft recommended block: PowerShell"),
    deny("powershell_ise.exe", PS, "Microsoft recommended block: PowerShell editor"),
    deny("presentationhost.exe", SYS, "XAML browser application host"),
    deny("print.exe", SYS, "Legacy print command"),
    deny("reg.exe", SYS, "Registry command line"),
    deny("regasm.exe", DOTNET, "Microsoft recommended block: registers .NET assemblies and runs code"),
    deny("regedit.exe", ROOT, "Registry editor"),
    deny("regedt32.exe", SYS, "Registry editor (legacy launcher)"),
    deny("regini.exe", SYS, "Registry changes from a script file"),
    deny("regsvcs.exe", DOTNET, "Microsoft recommended block: registers .NET services and runs code"),
    deny("regsvr32.exe", SYS, "Runs scripts and DLLs from a URL"),
    deny("replace.exe", SYS, "Replaces files"),
    deny("rpcping.exe", SYS, "Network probe"),
    deny("runas.exe", SYS, "Starts programs as another user"),
    deny("rundll32.exe", SYS, "Runs any DLL export"),
    deny("runonce.exe", SYS, "Runs one-time registry commands"),
    deny("sc.exe", SYS, "Service control"),
    deny("schtasks.exe", SYS, "Scheduled tasks"),
    deny("scp.exe", SSH, "OpenSSH file copy"),
    deny("sdclt.exe", SYS, "Backup and restore"),
    deny("sftp.exe", SSH, "OpenSSH file transfer"),
    deny("ssh.exe", SSH, "OpenSSH client"),
    deny("syncappvpublishingserver.exe", SYS, "App-V publishing; runs PowerShell"),
    deny("takeown.exe", SYS, "Takes ownership of files"),
    deny("taskmgr.exe", SYS, "Task Manager"),
    deny("telnet.exe", SYS, "Telnet client"),
    deny("tftp.exe", SYS, "TFTP client"),
    deny("ttdinject.exe", SYS, "Microsoft recommended block: injects the time-travel tracer"),
    deny("vbc.exe", DOTNET, "Microsoft recommended block: Visual Basic compiler"),
    deny("wevtutil.exe", SYS, "Event log tool; can clear logs"),
    deny("winrs.exe", SYS, "Remote shell"),
    deny("wmic.exe", WBEM, "Microsoft recommended block: WMI command line"),
    deny("wscript.exe", SYS, "Script host (windowed)"),
    deny("wsl.exe", SYS, "Microsoft recommended block: Linux subsystem"),
    deny("wusa.exe", SYS, "Installs update packages"),
    deny("xwizard.exe", SYS, "Wizard host that loads components"),
    // Accessibility tools (allowed again with `accessibilityTools`).
    accessibility("magnify.exe", "Magnifier: its settings and help open other windows"),
    accessibility("narrator.exe", "Narrator: its guide and settings open other windows"),
    accessibility("osk.exe", "On-screen keyboard"),
    accessibility("sethc.exe", "Sticky Keys launcher"),
    accessibility("utilman.exe", "Ease of Access launcher"),
];

/// Folders under the Windows folder that Windows grants standard users write access to on a
/// default install (relative paths). They are excluded from the Windows allow rule whatever
/// the scan found, so a scan that fails or is cut short cannot widen the allow-list. The scan
/// adds the folders this PC has beyond these.
pub const KNOWN_WRITABLE_WINDOWS_FOLDERS: &[&str] = &[
    "debug\\WIA",
    "PLA\\Reports",
    "PLA\\Rules",
    "PLA\\Templates",
    "Registration\\CRMLog",
    "System32\\com\\dmp",
    "System32\\FxsTmp",
    "System32\\Microsoft\\Crypto\\RSA\\MachineKeys",
    "System32\\spool\\drivers\\color",
    "System32\\spool\\PRINTERS",
    "System32\\spool\\SERVERS",
    "System32\\Tasks",
    "SysWOW64\\com\\dmp",
    "SysWOW64\\FxsTmp",
    "SysWOW64\\Tasks",
    "Tasks",
    "Temp",
    "tracing",
];

/// A package Staff may run (AppLocker's packaged-app collection). Plan 4.9: "measured in audit on
/// the VM, kept in `STAFF_ALLOWED_PACKAGES`"; until the VM run this is the starting set of
/// inbox packages the Windows shell and the sign-in screen need. All are signed by
/// [`MICROSOFT_WINDOWS_PUBLISHER`].
pub const STAFF_ALLOWED_PACKAGES: &[&str] = &[
    "Microsoft.AAD.BrokerPlugin",
    "Microsoft.AccountsControl",
    "Microsoft.CredDialogHost",
    "Microsoft.LockApp",
    "Microsoft.Windows.CloudExperienceHost",
    "Microsoft.Windows.ShellExperienceHost",
    "Microsoft.Windows.StartMenuExperienceHost",
    "MicrosoftWindows.Client.CBS",
];

/// The signer of Windows' inbox packages.
pub const MICROSOFT_WINDOWS_PUBLISHER: &str = "CN=Microsoft Windows, O=Microsoft Corporation, L=Redmond, S=Washington, C=US";

// ---------------------------------------------------------------- SDDL reading

const FILE_WRITE_DATA: u32 = 0x2;
const FILE_APPEND_DATA: u32 = 0x4;
const FILE_DELETE_CHILD: u32 = 0x40;
const GENERIC_ALL: u32 = 0x1000_0000;
const GENERIC_WRITE: u32 = 0x4000_0000;

/// The SID strings (and SDDL aliases) that stand for Everyone, Users, Authenticated Users and
/// the interactive logon group. The Staff account is a member of every one of them.
const BROAD_PRINCIPALS: &[&str] = &["WD", "BU", "AU", "IU", "S-1-1-0", "S-1-5-32-545", "S-1-5-11", "S-1-5-4"];

/// One access right word of SDDL (`FA`, `0x1200a9`, `CCDC`, ...) as an access mask. Unknown
/// words count as no rights (they are key or directory-service rights, never file rights).
fn rights_mask(text: &str) -> u32 {
    if let Some(hex) = text.strip_prefix("0x").or_else(|| text.strip_prefix("0X")) {
        return u32::from_str_radix(hex, 16).unwrap_or(0);
    }
    let bytes = text.as_bytes();
    let mut mask = 0u32;
    for pair in bytes.chunks(2) {
        mask |= match pair {
            b"GA" => GENERIC_ALL,
            b"GW" => GENERIC_WRITE,
            b"GR" => 0x8000_0000,
            b"GX" => 0x2000_0000,
            b"FA" => 0x001F_01FF,
            b"FR" => 0x0012_0089,
            b"FW" => 0x0012_0116,
            b"FX" => 0x0012_00A0,
            b"CC" => 0x1,
            b"DC" => 0x2,
            b"LC" => 0x4,
            b"SW" => 0x8,
            b"RP" => 0x10,
            b"WP" => 0x20,
            b"DT" => 0x40,
            b"LO" => 0x80,
            b"CR" => 0x100,
            b"SD" => 0x1_0000,
            b"RC" => 0x2_0000,
            b"WD" => 0x4_0000,
            b"WO" => 0x8_0000,
            _ => 0,
        };
    }
    mask
}

/// One ACE of an SDDL DACL: type, flags, rights word, trustee.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ace {
    pub kind: String,
    pub flags: String,
    pub rights: String,
    pub trustee: String,
}

/// The ACEs of a DACL string (`D:PAI(A;;FA;;;BA)(...)`); anything after an `S:` part is
/// ignored. Malformed ACEs are skipped.
pub fn aces(sddl: &str) -> Vec<Ace> {
    let dacl = match sddl.find("D:") {
        Some(at) => &sddl[at + 2..],
        None => return Vec::new(),
    };
    let dacl = dacl.split("S:").next().unwrap_or(dacl);
    let mut out = Vec::new();
    let mut rest = dacl;
    while let Some(open) = rest.find('(') {
        let Some(close) = rest[open..].find(')') else {
            break;
        };
        let body = &rest[open + 1..open + close];
        let parts: Vec<&str> = body.split(';').collect();
        if parts.len() >= 6 {
            out.push(Ace {
                kind: parts[0].to_string(),
                flags: parts[1].to_string(),
                rights: parts[2].to_string(),
                trustee: parts[5].to_string(),
            });
        }
        rest = &rest[open + close + 1..];
    }
    out
}

/// Whether the ACE applies to the object itself (it is not inherit-only).
fn applies_to_self(ace: &Ace) -> bool {
    !ace.flags.as_bytes().chunks(2).any(|chunk| chunk == b"IO")
}

/// True when the DACL lets the Staff account (directly, or as a member of Everyone, Users,
/// Authenticated Users or Interactive) create files or folders in, write to or delete from the
/// object. Only allow ACEs that apply to the object itself count; a deny ACE is ignored, which
/// errs on the side of calling a folder writable (more exceptions, never fewer).
pub fn writable_by_staff(sddl: &str, staff_sid: &str) -> bool {
    aces(sddl).iter().any(|ace| {
        matches!(ace.kind.as_str(), "A" | "XA")
            && applies_to_self(ace)
            && (ace.trustee.eq_ignore_ascii_case(staff_sid) || BROAD_PRINCIPALS.iter().any(|p| ace.trustee.eq_ignore_ascii_case(p)))
            && rights_mask(&ace.rights) & (FILE_WRITE_DATA | FILE_APPEND_DATA | FILE_DELETE_CHILD | GENERIC_ALL | GENERIC_WRITE) != 0
    })
}

// ---------------------------------------------------------------- paths

/// A path without a trailing backslash, forward slashes turned around.
pub fn clean(path: &str) -> String {
    path.replace('/', "\\").trim_end_matches('\\').to_string()
}

fn key(path: &str) -> String {
    clean(path).to_ascii_lowercase()
}

/// True when `path` is `root` or inside it (whole folder names, case-insensitive).
pub fn inside(path: &str, root: &str) -> bool {
    let (path, root) = (key(path), key(root));
    !root.is_empty() && (path == root || (path.starts_with(&root) && path.as_bytes().get(root.len()) == Some(&b'\\')))
}

/// Whether `path` is a place standard users can write to by the nature of the location (the
/// system drive's root, user profiles, ProgramData, the known writable Windows folders), without
/// asking for a DACL. A path rule that allows programs to start from there is never produced
/// (edge case 13). `roots` gives the system drive.
pub fn is_user_writable_location(path: &str, roots: &PathRoots) -> bool {
    let drive: String = roots.program_files.chars().take(2).collect::<String>().to_ascii_lowercase();
    let lower = key(path);
    // A drive root, on any drive (`D:`), is writable by standard users on a default format.
    if lower.len() <= 2 && lower.ends_with(':') {
        return true;
    }
    let sys = |rest: &str| format!("{drive}\\{rest}");
    let mut risky = vec![sys("users"), sys("programdata"), sys("temp"), sys("$recycle.bin"), sys("perflogs")];
    if let Some(windows) = &roots.system_root {
        risky.extend(KNOWN_WRITABLE_WINDOWS_FOLDERS.iter().map(|folder| format!("{}\\{folder}", clean(windows))));
    }
    risky.iter().any(|root| inside(&lower, root)) || lower.contains("\\appdata\\") || lower.contains("\\temp\\")
}

// ---------------------------------------------------------------- the catalogue's own rules (Phase 6 Step 11)

/// (Phase 6 Step 11, plan 4.4.3) The publisher rule of every desktop app in `catalog` that updates itself (mode `vendor`): the
/// vendor's updater and programs, signed by `update.publisher` (narrowed by `update.publisherProduct`), may start for the Staff
/// SID like any exception (Phase 5 D2). Only **AppLocker and the process watch**; App Control never gets one (Phase 5 D3: an
/// exception never loosens it). The id is `vendor-<app id>`, so a rule disappears with its app: the catalogue holds only the
/// apps assigned to this PC. An app without a publisher gets none (the server refuses that save, `vendor_mode_needs_publisher`;
/// defence in depth: a publisher-less rule would allow nothing it can name).
pub fn vendor_exceptions(catalog: &[rulebox_policy::catalog::CatalogApp]) -> Vec<ExceptionRule> {
    catalog
        .iter()
        .filter_map(|app| {
            let desktop = app.desktop.as_ref()?;
            if desktop.update_mode() != rulebox_policy::catalog::UpdateMode::Vendor {
                return None;
            }
            let update = desktop.update.as_ref()?;
            let subject = update.publisher.as_deref().filter(|subject| !subject.trim().is_empty())?;
            Some(ExceptionRule {
                id: format!("vendor-{}", app.id),
                app_id: Some(app.id.clone()),
                kind: ExceptionKind::Publisher,
                publisher: Some(rulebox_policy::lockdown::PublisherMatch {
                    subject: subject.to_string(),
                    product: update.publisher_product.clone().filter(|product| !product.trim().is_empty()),
                    file_name: None,
                }),
                sha256: None,
                path: None,
                layers: vec![ExceptionLayer::AppLocker, ExceptionLayer::ProcWatch],
            })
        })
        .collect()
}

/// The document's exceptions and the catalogue's own ([`vendor_exceptions`]) as one list for [`Inputs::exceptions`].
pub fn with_vendor_exceptions(document: &[ExceptionRule], vendor: &[ExceptionRule]) -> Vec<ExceptionRule> {
    let mut all = document.to_vec();
    all.extend(vendor.iter().cloned());
    all
}

// ---------------------------------------------------------------- the allow-list

/// An exception rule as AppLocker will carry it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AllowException {
    Publisher { subject: String, product: Option<String>, file_name: Option<String> },
    /// 64 lower-case hex characters.
    Hash { sha256: String, source: String },
    /// An expanded path of a file (admin-only folder).
    Path(String),
}

/// What Staff may start (plan 4.9).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct AllowList {
    /// Folders every user may start programs from (the Rulebox install folder, WebView2).
    pub invariant: Vec<String>,
    /// The Windows folder, with everything cut out of it.
    pub windows: String,
    /// Folders under the Windows folder that standard users can write to.
    pub windows_excluded_folders: Vec<String>,
    /// Programs of the Windows folder Staff may not start: full paths.
    pub windows_excluded_files: Vec<String>,
    /// Original file names of those programs, upper case (publisher-condition exceptions).
    pub windows_excluded_names: Vec<String>,
    /// Catalogue app folders that are admin-only.
    pub catalogue: Vec<String>,
    pub exceptions: Vec<AllowException>,
    /// Fixed codes for what was refused (`catalogue_folder_writable`, `exception_path_writable`).
    pub notes: Vec<&'static str>,
}

impl AllowList {
    /// Every folder or file the compiled Windows rule cuts out: what invariants I1 and I2 are
    /// checked against (`Generated::blocked_paths`).
    pub fn blocked_paths(&self) -> Vec<String> {
        let mut out = self.windows_excluded_folders.clone();
        out.extend(self.windows_excluded_files.iter().cloned());
        out
    }
}

/// What [`build`] needs.
pub struct Inputs<'a> {
    pub roots: &'a PathRoots,
    /// The Rulebox install folder and the WebView2 runtime folder (`Facts::protected_paths`).
    pub protected: &'a [String],
    /// The folder of every catalogue app (`Facts::catalogue_exe_folders`).
    pub catalogue_folders: &'a [String],
    pub exceptions: &'a [ExceptionRule],
    pub accessibility_tools: bool,
    /// The folders under the Windows folder with their DACLs (the scan).
    pub windows_scan: &'a [FolderAcl],
    pub staff_sid: &'a str,
}

/// Expands the root token of an exception path template. `{SystemRoot}` is never accepted
/// (Windows' own programs are allowed by the layer itself).
fn expand_template(template: &str, roots: &PathRoots) -> Option<String> {
    let (token, root) = if let Some(rest) = template.strip_prefix("{ProgramFiles}\\") {
        (rest, roots.program_files.clone())
    } else if let Some(rest) = template.strip_prefix("{ProgramFilesX86}\\") {
        (rest, roots.program_files_x86.clone()?)
    } else {
        (template.strip_prefix("{RuleboxApps}\\")?, roots.rulebox_apps.clone())
    };
    Some(format!("{}\\{token}", clean(&root)))
}

fn parent(path: &str) -> String {
    let path = clean(path);
    path.rsplit_once('\\').map_or(path.clone(), |(head, _)| head.to_string())
}

/// Builds the allow-list. `acl_of` reads a folder's DACL (`Ok(None)`: no such folder; an error
/// is treated as "cannot tell", which refuses the folder). Errors are fixed codes; nothing is
/// written.
pub fn build(inputs: &Inputs<'_>, acl_of: impl Fn(&str) -> Result<Option<String>, ()>) -> Result<AllowList, &'static str> {
    build_for(inputs, ExceptionLayer::AppLocker, acl_of)
}

/// [`build`] for the exceptions of one layer. The process watchdog (L5) compiles the same model
/// with the exceptions that name `procWatch` (plan 4.10: one allow-list, three consumers).
pub fn build_for(
    inputs: &Inputs<'_>,
    layer: ExceptionLayer,
    acl_of: impl Fn(&str) -> Result<Option<String>, ()>,
) -> Result<AllowList, &'static str> {
    let roots = inputs.roots;
    let windows = clean(roots.system_root.as_deref().ok_or("windows_folder_unknown")?);
    let mut list = AllowList { windows: windows.clone(), ..AllowList::default() };

    // Invariant folders (I1, I2): no duplicates, none inside another.
    let mut invariant: Vec<String> = inputs.protected.iter().map(|p| clean(p)).filter(|p| !p.is_empty()).collect();
    invariant.sort_by_key(|p| key(p));
    invariant.dedup_by_key(|p| key(p));
    list.invariant = invariant;
    let covered = |path: &str, list: &AllowList| {
        list.invariant.iter().any(|root| inside(path, root)) || inside(path, &list.windows)
    };

    // Windows: writable subfolders from the scan, then the known ones.
    let mut folders: Vec<String> = inputs
        .windows_scan
        .iter()
        .filter(|folder| key(&folder.path) != key(&windows) && inside(&folder.path, &windows))
        .filter(|folder| writable_by_staff(&folder.sddl, inputs.staff_sid))
        .map(|folder| clean(&folder.path))
        .collect();
    folders.extend(KNOWN_WRITABLE_WINDOWS_FOLDERS.iter().map(|rel| format!("{windows}\\{rel}")));
    folders.sort_by_key(|p| key(p));
    folders.dedup_by_key(|p| key(p));
    // A rule `<folder>\*` already covers everything below it.
    let mut kept: Vec<String> = Vec::new();
    for folder in folders {
        if !kept.iter().any(|root| inside(&folder, root)) {
            kept.push(folder);
        }
    }
    list.windows_excluded_folders = kept;

    // Denied programs.
    let mut files: Vec<String> = Vec::new();
    let mut names: Vec<String> = Vec::new();
    for entry in STAFF_DENY_WINDOWS_BINARIES.iter().filter(|e| !(e.accessibility && inputs.accessibility_tools)) {
        for folder in entry.folders {
            let base = if folder.is_empty() { windows.clone() } else { format!("{windows}\\{folder}") };
            files.push(format!("{base}\\{}", entry.file));
        }
        names.push(entry.file.to_ascii_uppercase());
    }
    files.sort_by_key(|p| key(p));
    files.dedup_by_key(|p| key(p));
    names.sort();
    names.dedup();
    list.windows_excluded_files = files;
    list.windows_excluded_names = names;

    // Catalogue apps: a path rule only for a folder that is admin-only.
    let mut catalogue: Vec<String> = Vec::new();
    for folder in inputs.catalogue_folders.iter().map(|f| clean(f)).filter(|f| !f.is_empty()) {
        if covered(&folder, &list) {
            continue;
        }
        let writable = is_user_writable_location(&folder, roots)
            || match acl_of(&folder) {
                Ok(Some(sddl)) => writable_by_staff(&sddl, inputs.staff_sid),
                Ok(None) => false,
                Err(()) => true,
            };
        if writable {
            list.notes.push("catalogue_folder_writable");
        } else {
            catalogue.push(folder);
        }
    }
    catalogue.sort_by_key(|p| key(p));
    catalogue.dedup_by_key(|p| key(p));
    list.catalogue = catalogue;

    // Exceptions for this layer.
    for exception in inputs.exceptions.iter().filter(|e| e.layers.contains(&layer)) {
        if exception.validate().is_err() {
            list.notes.push("exception_invalid");
            continue;
        }
        match exception.kind {
            ExceptionKind::Publisher => {
                if let Some(publisher) = &exception.publisher {
                    list.exceptions.push(AllowException::Publisher {
                        subject: publisher.subject.clone(),
                        product: publisher.product.clone(),
                        file_name: publisher.file_name.clone(),
                    });
                }
            }
            ExceptionKind::Hash => {
                if let Some(sha256) = &exception.sha256 {
                    list.exceptions.push(AllowException::Hash {
                        sha256: sha256.clone(),
                        source: format!("exception-{}", exception.id),
                    });
                }
            }
            ExceptionKind::Path => {
                let Some(path) = exception.path.as_deref().and_then(|t| expand_template(t, roots)) else {
                    list.notes.push("exception_invalid");
                    continue;
                };
                let folder = parent(&path);
                let writable = is_user_writable_location(&folder, roots)
                    || match acl_of(&folder) {
                        Ok(Some(sddl)) => writable_by_staff(&sddl, inputs.staff_sid),
                        Ok(None) => false,
                        Err(()) => true,
                    };
                if writable {
                    list.notes.push("exception_path_writable");
                } else {
                    list.exceptions.push(AllowException::Path(path));
                }
            }
            ExceptionKind::Unknown => list.notes.push("exception_invalid"),
        }
    }
    list.exceptions.sort_by(|a, b| format!("{a:?}").cmp(&format!("{b:?}")));
    list.exceptions.dedup();
    list.notes.sort_unstable();
    list.notes.dedup();
    Ok(list)
}

#[cfg(test)]
mod tests;
