/**
 * Hand-written validators that mirror the server's rules (the server stays
 * authoritative). Each returns `null` when the value is fine, or the sentence
 * to show under the field.
 */
import { strings } from "./strings";

const v = strings.validate;
export type Check = string | null;

/** Keeps the first error per field; `null` fields are dropped. */
export type FieldErrors<K extends string> = Partial<Record<K, string>>;

export function collect<K extends string>(checks: Record<K, Check>): FieldErrors<K> {
  const out: FieldErrors<K> = {};
  for (const key of Object.keys(checks) as K[]) {
    const msg = checks[key];
    if (msg) out[key] = msg;
  }
  return out;
}

export function hasErrors(errors: Record<string, string | undefined>): boolean {
  return Object.values(errors).some(Boolean);
}

// The server's rule (`normalizeOrgName`, groups `normalizeName`): C0 controls and DEL.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** Names (plan edge case 27): trimmed, 1..max UTF-16 units like the server's `length`, no control characters. */
export function name(value: string, max: number): Check {
  const t = value.trim();
  if (!t) return v.required;
  if (CONTROL.test(t)) return v.controlChars;
  if (t.length > max) return v.tooLong(max);
  return null;
}

/** Server maxima (convex/lib/limits.ts where they exist: MAX_ORG_NAME, MAX_GROUP_NAME, MAX_GROUP_DESCRIPTION). */
export const NAME_MAX = { device: 100, employee: 100, app: 60, group: 64, org: 100, label: 60, description: 300 } as const;

export function optionalText(value: string, max: number): Check {
  const t = value.trim();
  if (!t) return null;
  if (CONTROL.test(t)) return v.controlChars;
  if (t.length > max) return v.tooLong(max);
  return null;
}

/** A multi-line description: the server checks only the trimmed length (groups `normalizeDescription`). */
export function description(value: string, max: number): Check {
  return value.trim().length > max ? v.tooLong(max) : null;
}

export function email(value: string): Check {
  const t = value.trim().toLowerCase();
  if (!t) return v.required;
  if (t.length > 254) return v.tooLong(254);
  const at = t.indexOf("@");
  if (at <= 0 || at !== t.lastIndexOf("@") || at === t.length - 1 || /\s/.test(t)) return v.email;
  const domain = t.slice(at + 1);
  if (!domain.includes(".") || domain.startsWith(".") || domain.endsWith(".")) return v.email;
  return null;
}

/** Member passwords (Convex Auth `validatePasswordRequirements`): 12–256, a letter and a digit. */
export function memberPassword(value: string): Check {
  if (!value) return v.required;
  if (value.length < 12 || value.length > 256) return v.passwordMember;
  if (!/\p{L}/u.test(value) || !/\d/.test(value)) return v.passwordMember;
  return null;
}

/** Employee passwords (Section 4.12): 8–256, not equal to the username. */
export function employeePassword(value: string, username: string): Check {
  if (!value) return v.required;
  if (value.length < 8 || value.length > 256) return v.passwordEmployee;
  if (normalizeUsername(value) === normalizeUsername(username) && username.trim()) return v.passwordEqualsUsername;
  return null;
}

export function same(a: string, b: string, message: string): Check {
  if (!b) return v.required;
  return a === b ? null : message;
}

export function normalizeUsername(value: string): string {
  return value.trim().toLowerCase();
}

/** Section 4.12: 1–64 characters after normalization; letters, digits, `.`, `_`, `-`. */
export function username(value: string): Check {
  const t = normalizeUsername(value);
  if (!t) return v.required;
  if (t.length > 64 || !/^[a-z0-9._-]+$/.test(t)) return v.username;
  return null;
}

/** Whole number in a range, from a text input. Empty → `required` unless `optional`. */
export function intRange(value: string, min: number, max: number, optional = false): Check {
  const t = value.trim();
  if (!t) return optional ? null : v.required;
  if (!/^\d+$/.test(t)) return v.integerRange(min, max);
  const num = Number(t);
  if (num < min || num > max) return v.integerRange(min, max);
  return null;
}

export function quota(value: string): Check {
  return intRange(value, 0, 2000, true) ? v.quota : null;
}

// ---------------------------------------------------------------- web apps

const PRIVATE_V4 = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^0\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
];

function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith("[");
}

/** Web app URL (Step 10): https://, not localhost, not a private / loopback / link-local IP. */
export function webUrl(value: string): Check {
  const t = value.trim();
  if (!t) return v.required;
  let url: URL;
  try {
    url = new URL(t);
  } catch {
    return v.httpsUrl;
  }
  if (url.protocol !== "https:") return v.httpsUrl;
  const host = url.hostname.toLowerCase();
  if (!host) return v.httpsUrl;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return v.privateHost;
  if (isIpLiteral(host)) {
    if (host.startsWith("[")) return v.privateHost; // IPv6 literals: refused outright in the client
    if (PRIVATE_V4.some((re) => re.test(host))) return v.privateHost;
  }
  return null;
}

/** `example.com` or `*.example.com`; lower-case; no scheme or path. */
export function domain(value: string): Check {
  const t = value.trim();
  const host = t.startsWith("*.") ? t.slice(2) : t;
  const label = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
  const parts = host.split(".");
  if (t !== t.toLowerCase() || parts.length < 2 || !parts.every((p) => label.test(p)) || host.length > 253) {
    return v.domain(t);
  }
  return null;
}

export function domains(lines: string[]): Check {
  if (lines.length > 20) return v.tooManyDomains;
  for (const line of lines) {
    const err = domain(line);
    if (err) return err;
  }
  return null;
}

/** Splits a textarea into trimmed, non-empty lines. */
export function lines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------- desktop apps

export function sha256(value: string): Check {
  const t = value.trim();
  if (!t) return v.required;
  return /^[0-9a-fA-F]{64}$/.test(t) ? null : v.sha256;
}

export function installerUrl(value: string): Check {
  const t = value.trim();
  if (!t) return v.required;
  try {
    const url = new URL(t);
    return url.protocol === "https:" && url.hostname ? null : v.httpsUrl;
  } catch {
    return v.httpsUrl;
  }
}

const COMPONENT = /^[A-Za-z0-9 ._\-()+&]{1,100}$/;
const EXE_PREFIXES = ["{ProgramFiles}\\", "{ProgramFilesX86}\\", "{SystemRoot}\\System32\\", "{RuleboxApps}\\{AppId}\\"];

/** Path templates (Section 4.8). `portable` must start with `{RuleboxApps}\{AppId}\`. */
export function exePath(value: string, portable: boolean): Check {
  const t = value.trim();
  if (!t) return v.required;
  const prefix = EXE_PREFIXES.find((p) => t.startsWith(p));
  if (!prefix) return v.exePath;
  if (portable && prefix !== "{RuleboxApps}\\{AppId}\\") return v.portableExe;
  if (!portable && prefix === "{RuleboxApps}\\{AppId}\\") return v.exePath;
  const rest = t.slice(prefix.length).split("\\");
  if (rest.length < 1 || rest.length > 8) return v.exePath;
  if (rest.some((c) => !COMPONENT.test(c) || c === "." || c === "..")) return v.exePath;
  if (!/\.exe$/i.test(rest[rest.length - 1] ?? "")) return v.exePath;
  if (t.length > 260) return v.exePath;
  return null;
}

/** Splits an argument line on spaces, keeping "quoted parts" together. */
export function splitArgs(value: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value))) out.push(m[1] ?? m[2] ?? "");
  return out;
}

export function joinArgs(args: string[]): string {
  return args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ");
}

export function args(list: string[]): Check {
  if (list.length > 16 || list.some((a) => a.length > 200)) return v.args;
  return null;
}

export function fileArgTemplate(list: string[]): Check {
  if (list.length === 0) return null;
  const err = args(list);
  if (err) return err;
  const count = list.join("\u0000").split("{file}").length - 1;
  return count === 1 ? null : v.fileArg;
}

export function silentArgs(list: string[]): Check {
  if (list.length === 0) return v.silentArgs;
  return args(list);
}

export function productCode(value: string): Check {
  const t = value.trim();
  if (!t) return null;
  return /^\{[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}$/.test(t)
    ? null
    : v.productCode;
}

export function wingetId(value: string): Check {
  const t = value.trim();
  if (!t) return v.required;
  return /^[A-Za-z0-9][A-Za-z0-9-]*(\.[A-Za-z0-9][A-Za-z0-9._-]*)+$/.test(t) && t.length <= 128 ? null : v.wingetId;
}

/** Reset folders (Section 4.12): `{LocalAppData}\<rel>` / `{RoamingAppData}\<rel>`, 1–6 components. */
export function resetFolders(list: string[]): Check {
  for (const item of list) {
    const prefix = ["{LocalAppData}\\", "{RoamingAppData}\\"].find((p) => item.startsWith(p));
    if (!prefix) return v.resetFolder(item);
    const rest = item.slice(prefix.length).split("\\");
    if (rest.length < 1 || rest.length > 6 || rest.some((c) => !COMPONENT.test(c) || c === "." || c === "..")) {
      return v.resetFolder(item);
    }
  }
  return null;
}

// ---------------------------------------------------------------- file types

/** Copied from apps/staff-app/src-tauri/src/files/types.rs `DENY` (PRD 7.3). */
export const DENY_EXTENSIONS: ReadonlySet<string> = new Set([
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
]);

/** Normalizes "PDF" / "pdf" / ".pdf" to ".pdf". */
export function normalizeExtension(value: string): string {
  const t = value.trim().toLowerCase();
  return t.startsWith(".") ? t : `.${t}`;
}

export function extension(value: string): Check {
  if (!value.trim()) return v.required;
  const ext = normalizeExtension(value);
  if (!/^\.[a-z0-9]{1,10}$/.test(ext)) return v.extension;
  if (DENY_EXTENSIONS.has(ext.slice(1))) return v.extensionDenied;
  return null;
}

// ---------------------------------------------------------------- admin exit

export const DEFAULT_HOTKEY = "Ctrl+Shift+F12";
/** `MAX_HOTKEY_TEXT` of convex/lib/limits.ts. */
export const HOTKEY_MAX = 64;

/** The Rust `HotkeyError` variant names (also the server's `detail`). */
export type HotkeyProblem = "Empty" | "UnknownToken" | "NoKey" | "TwoKeys" | "DuplicateModifier" | "NeedsCtrlOrAlt";

/** `token`: the text that was not a key (UnknownToken only, for the message). */
export type HotkeyResult = { ok: true; canonical: string } | { ok: false; reason: HotkeyProblem; token?: string };

/** Rust `char::is_whitespace` (differs from JS `trim` on U+0085 and U+FEFF). */
const RUST_WS = /^[\t-\r \x85\xa0\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}]$/u;

function rustTrim(text: string): string {
  const cps = [...text];
  let a = 0;
  let b = cps.length;
  while (a < b && RUST_WS.test(cps[a]!)) a++;
  while (b > a && RUST_WS.test(cps[b - 1]!)) b--;
  return cps.slice(a, b).join("");
}

/**
 * Port of `convex/lib/hotkey.ts` = `rulebox_ipc::hotkey::parse` (the source
 * of truth; the shared vectors in crates/rulebox-ipc/tests/vectors/hotkeys.json
 * run against all three). `+`-separated tokens, ASCII case-insensitive;
 * Ctrl/Alt/Shift at most once each; exactly one key A–Z, 0–9 or F1–F12;
 * Ctrl or Alt required. Canonical form: `Ctrl+Alt+Shift+<KEY>`.
 */
export function parseHotkey(text: string): HotkeyResult {
  if (rustTrim(text) === "") return { ok: false, reason: "Empty" };
  const mods = { ctrl: false, alt: false, shift: false };
  let key: string | null = null;
  for (const raw of text.split("+")) {
    const token = rustTrim(raw);
    const lower = token.replace(/[A-Z]/g, (c) => c.toLowerCase());
    if (lower === "ctrl" || lower === "alt" || lower === "shift") {
      if (mods[lower]) return { ok: false, reason: "DuplicateModifier" };
      mods[lower] = true;
      continue;
    }
    const upper = token.replace(/[a-z]/g, (c) => c.toUpperCase());
    // One ASCII letter or digit, or F1-F12 written plainly (no sign, no leading zero).
    const parsed = /^[A-Z0-9]$/.test(upper) ? upper : /^F(?:[1-9]|1[0-2])$/.test(upper) ? upper : null;
    if (parsed === null) return { ok: false, reason: "UnknownToken", token };
    if (key !== null) return { ok: false, reason: "TwoKeys" };
    key = parsed;
  }
  if (key === null) return { ok: false, reason: "NoKey" };
  if (!mods.ctrl && !mods.alt) return { ok: false, reason: "NeedsCtrlOrAlt" };
  return { ok: true, canonical: [mods.ctrl && "Ctrl", mods.alt && "Alt", mods.shift && "Shift", key].filter(Boolean).join("+") };
}

/** `exitPinProblem` of convex/lib/orgSettings.ts: the server's `detail`, or null when acceptable. */
export type ExitPinProblem = "6 to 12 digits" | "all digits the same" | "sequence";

/** Exit PIN (Section 4.10): 6–12 ASCII digits; not all the same; not a run up or down by one (no wrap). */
export function exitPinProblem(pin: string): ExitPinProblem | null {
  if (!/^[0-9]{6,12}$/.test(pin)) return "6 to 12 digits";
  if (/^(\d)\1+$/.test(pin)) return "all digits the same";
  if ("0123456789".includes(pin) || "9876543210".includes(pin)) return "sequence";
  return null;
}

export function exitPin(value: string): Check {
  if (!value) return v.required;
  const p = exitPinProblem(value);
  return p === null ? null : p === "6 to 12 digits" ? v.pin : v.pinWeak;
}

// ---------------------------------------------------------------- MFA

export function totpCode(value: string): Check {
  const t = value.replace(/\s/g, "");
  return /^\d{6}$/.test(t) ? null : v.totp;
}

export function normalizeRecoveryCode(value: string): string {
  const t = value.toUpperCase().replace(/[\s-]/g, "");
  return t.length === 8 ? `${t.slice(0, 4)}-${t.slice(4)}` : t;
}

export function recoveryCode(value: string): Check {
  return /^[0-9A-Z]{4}-[0-9A-Z]{4}$/.test(normalizeRecoveryCode(value)) ? null : v.recovery;
}
