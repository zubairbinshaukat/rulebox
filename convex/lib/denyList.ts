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
  "ade", "adp", "app", "appinstaller", "application", "appref-ms", "appx", "appxbundle",
  "asp", "bas", "bat", "cab", "cer", "chm", "cmd", "cnt", "com", "cpl", "crt", "csh", "der",
  "diagcab", "dll", "dmg", "docm", "dotm", "drv", "exe", "fxp", "gadget", "grp", "hlp", "hpj",
  "hta", "htm", "html", "img", "inf", "ins", "iso", "isp", "its", "jar", "jnlp", "job", "js",
  "jse", "ksh", "library-ms", "lnk", "mad", "maf", "mag", "mam", "maq", "mar", "mas", "mat",
  "mau", "mav", "maw", "mcf", "mda", "mdb", "mde", "mdt", "mdw", "mdz", "mht", "mhtml", "msc",
  "msh", "msh1", "msh1xml", "msh2", "msh2xml", "mshxml", "msi", "msix", "msixbundle", "msp",
  "mst", "ocx", "ops", "osd", "pcd", "pif", "pl", "plg", "potm", "ppam", "pptm", "prf", "prg",
  "printerexport", "ps1", "ps1xml", "ps2", "ps2xml", "psc1", "psc2", "psd1", "psm1", "pst",
  "py", "pyc", "pyw", "pyz", "pyzw", "rb", "rdp", "reg", "scf", "scr", "sct", "search-ms",
  "settingcontent-ms", "sh", "shb", "shs", "sldm", "svg", "sys", "theme", "tmp", "url", "vb",
  "vbe", "vbp", "vbs", "vbscript", "vhd", "vhdx", "vsmacros", "vss", "vst", "vsw", "wll",
  "ws", "wsc", "wsf", "wsh", "xbap", "xlam", "xll", "xlsm", "xltm", "xml", "xnk",
] as const;

export const DENY_EXTENSIONS: ReadonlySet<string> = new Set(DENY);

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
