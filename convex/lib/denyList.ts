// File types that can never be opened from Rulebox (PRD 7.3): executables,
// scripts, installers, shortcuts and the like. A `fileHandlers` rule for one of
// these is refused here, and the Staff App refuses to open them even if a rule
// slipped through (its deny-list comes first and nothing overrides it).
//
// COPIED from apps/staff-app/src-tauri/src/files/types.rs `DENY` (the source of
// truth; extensions without the dot, lower-case). A change there must be made
// here and in apps/dashboard/src/lib/validate.ts `DENY_EXTENSIONS`;
// `fileHandlers.test.ts` compares this list with the Rust file.
const DENY = [
  "ade", "adp", "app", "appinstaller", "application", "appref-ms", "appx", "appxbundle", "asp",
  "bas", "bat", "cab", "cer", "chm", "cmd", "cnt", "com", "cpl", "crt", "csh", "der", "diagcab",
  "dll", "dmg", "docm", "dotm", "drv", "exe", "fxp", "gadget", "grp", "hlp", "hpj", "hta",
  "htm", "html", "img", "inf", "ins", "iso", "isp", "its", "jar", "jnlp", "job", "js", "jse",
  "ksh", "library-ms", "lnk", "mad", "maf", "mag", "mam", "maq", "mar", "mas", "mat", "mau",
  "mav", "maw", "mcf", "mda", "mdb", "mde", "mdt", "mdw", "mdz", "mht", "mhtml", "msc", "msh",
  "msh1", "msh1xml", "msh2", "msh2xml", "mshxml", "msi", "msix", "msixbundle", "msp", "mst",
  "msu", "ocx", "ops", "osd", "pcd", "pif", "pl", "plg", "potm", "ppam", "ppkg", "pptm", "prf",
  "prg", "printerexport", "ps1", "ps1xml", "ps2", "ps2xml", "psc1", "psc2", "psd1", "psm1",
  "pst", "py", "pyc", "pyw", "pyz", "pyzw", "rb", "rdp", "reg", "scf", "scr", "sct",
  "search-ms", "searchconnector-ms", "settingcontent-ms", "sh", "shb", "shs", "sldm", "svg",
  "sys", "theme", "tmp", "url", "vb", "vbe", "vbp", "vbs", "vbscript", "vhd", "vhdx",
  "vsmacros", "vss", "vst", "vsw", "website", "wll", "ws", "wsb", "wsc", "wsf", "wsh", "xbap",
  "xlam", "xll", "xlsm", "xltm", "xml", "xnk",
] as const;

export const DENY_EXTENSIONS: ReadonlySet<string> = new Set(DENY);

// Programs that may NOT be used as a Rulebox app or as the target of a file-type
// rule, wherever they live (names without `.exe`, lower-case): command
// shells, script hosts and language runtimes (they would run a data file as a
// script: `.txt` -> `wscript.exe`), living-off-the-land binaries that fetch,
// install, register or execute code (`mshta`, `rundll32`, `regsvr32`,
// `msiexec`, `certutil`, `bitsadmin`...), and shell / management consoles that
// leave the kiosk (`explorer`, `taskmgr`, `mmc`, `regedit`...). PRD 7.3:
// Rulebox never opens an executable or a script. This is a list of KNOWN risky
// programs, not an allow-list: the safety of everything else rests on the path
// roots (`lib/pathRules.ts`) and on the admin's choice of programs. The dashboard
// mirrors it in `apps/dashboard/src/lib/validate.ts` `DENY_PROGRAMS`;
// `fileHandlers.test.ts` compares the two.
const DENY_PROGRAM_NAMES = [
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
] as const;

export const DENY_PROGRAMS: ReadonlySet<string> = new Set(DENY_PROGRAM_NAMES);

/** The file name of a path template without folders or a trailing `.exe`, lower-case. */
export function programStem(exe: string): string {
  const name = exe.slice(exe.lastIndexOf("\\") + 1).toLowerCase();
  return name.endsWith(".exe") ? name.slice(0, -4) : name;
}

/** True when the program at xe (a path template) is on `DENY_PROGRAMS`. */
export function programDenied(exe: string): boolean {
  return DENY_PROGRAMS.has(programStem(exe));
}
/** "PDF" / "pdf" / ".pdf" -> ".pdf" (trimmed, lower-case, one leading dot). */
export function normalizeExtension(value: string): string {
  const t = value.trim().toLowerCase();
  return t.startsWith(".") ? t : `.${t}`;
}

/** The shape a file-type rule needs: a dot and 1-10 lower-case letters or digits. */
export const EXTENSION_PATTERN = /^\.[a-z0-9]{1,10}$/;

/**
 * Null when `extension` (already normalized) may get a rule, else a short fixed
 * reason: "format" for a malformed extension, "denied" for the deny-list.
 */
export function extensionProblem(extension: string): "format" | "denied" | null {
  if (!EXTENSION_PATTERN.test(extension)) return "format";
  if (DENY_EXTENSIONS.has(extension.slice(1))) return "denied";
  return null;
}
