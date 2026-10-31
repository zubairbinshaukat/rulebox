import { MAX_APP_ARG_LENGTH, MAX_APP_ARGS, MAX_EXE_PATH, MAX_RESET_FOLDERS } from "./limits";

// Path templates, arguments and session-cleanup folders of a desktop app
// (plan 4.8 "Path templates", 4.12). PURE: the dashboard mirrors these rules in
// `lib/validate.ts`, and the agent checks the same rules again before it uses
// a path (Step 13/14). The server is authoritative.
//
// A template is never a real path: it starts with a fixed token the agent
// expands itself, so a document can name a program inside Program Files, the
// System32 folder or the agent's own apps folder, and nothing else.

/** Marker the form uses for a portable app's folder; the server swaps in the real id after the insert. */
export const APP_ID_PLACEHOLDER = "{AppId}";

/** Letters, digits, space and `._-()+&`, 1-100 characters (plan 4.8). */
const COMPONENT = /^[A-Za-z0-9 ._\-()+&]{1,100}$/;

/** A component made only of dots and spaces ("..", "...", " ") means nothing or the parent to Windows. */
function validComponent(c: string): boolean {
  return COMPONENT.test(c) && c.replace(/[. ]/g, "") !== "";
}

const FIXED_PREFIXES = ["{ProgramFiles}\\", "{ProgramFilesX86}\\", "{SystemRoot}\\System32\\"] as const;

/** Typical expansions, used only to bound the length "after expansion" (260 characters). */
const EXPANDED_PREFIX_LENGTH: Record<string, number> = {
  "{ProgramFiles}\\": "C:\\Program Files\\".length,
  "{ProgramFilesX86}\\": "C:\\Program Files (x86)\\".length,
  "{SystemRoot}\\System32\\": "C:\\Windows\\System32\\".length,
  "{RuleboxApps}\\": "C:\\Program Files\\Rulebox\\apps\\".length,
};

export type ExePathContext = {
  /** `portable` apps live in `{RuleboxApps}\<appId>\`; every other source in the fixed roots. */
  portable: boolean;
  /**
   * The app's id when known (update). When it is not (create), only the
   * `{AppId}` placeholder is accepted and the caller replaces it after insert.
   */
  appId?: string;
};

/**
 * Null when `exe` is an acceptable path template, else a short fixed reason
 * (a log/detail text, never the value). Rules, in order:
 * - one of the fixed roots (`{ProgramFiles}\`, `{ProgramFilesX86}\`,
 *   `{SystemRoot}\System32\`), or for a portable app exactly
 *   `{RuleboxApps}\<this app's id>\` (not another app's folder);
 * - 1 to 8 components below the root, each 1-100 allowed characters, never
 *   `.` / `..` (or dots only), the last one ending in `.exe`;
 * - at most 260 characters once expanded.
 */
export function exePathProblem(exe: string, ctx: ExePathContext): string | null {
  const prefix = ctx.portable
    ? `{RuleboxApps}\\${ctx.appId ?? APP_ID_PLACEHOLDER}\\`
    : FIXED_PREFIXES.find((p) => exe.startsWith(p));
  if (prefix === undefined) return "path must start with {ProgramFiles}, {ProgramFilesX86} or {SystemRoot}\\System32";
  if (!exe.startsWith(prefix)) {
    return ctx.portable ? "a portable app must be in its own folder under {RuleboxApps}" : "unknown path root";
  }
  const rest = exe.slice(prefix.length).split("\\");
  if (rest.length < 1 || rest.length > 8) return "1 to 8 path components";
  if (!rest.every(validComponent)) return "path component not allowed";
  if (!/\.exe$/i.test(rest[rest.length - 1]!)) return "path must end in .exe";
  const expanded = EXPANDED_PREFIX_LENGTH[ctx.portable ? "{RuleboxApps}\\" : prefix]! + (ctx.portable ? 32 + 1 : 0) + rest.join("\\").length;
  if (expanded > MAX_EXE_PATH) return "path too long";
  return null;
}

/** True when `text` holds a C0 control character or DEL (command lines never carry them). */
function hasControl(text: string): boolean {
  for (const ch of text) {
    const c = ch.charCodeAt(0);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

/** `args`, `silentArgs`: at most 16 entries of at most 200 characters, no control characters. */
export function argsProblem(list: string[]): string | null {
  if (list.length > MAX_APP_ARGS) return "too many arguments";
  for (const a of list) {
    if (a.length > MAX_APP_ARG_LENGTH) return "argument too long";
    if (hasControl(a)) return "argument has a control character";
  }
  return null;
}

/** `fileArgTemplate`: empty (the app cannot open files) or the arguments with `{file}` exactly once. */
export function fileArgProblem(list: string[]): string | null {
  if (list.length === 0) return null;
  const common = argsProblem(list);
  if (common !== null) return common;
  const count = list.join("\u0000").split("{file}").length - 1;
  return count === 1 ? null : "{file} must appear exactly once";
}

/**
 * Session cleanup folders (4.12): `{LocalAppData}\<rel>` or
 * `{RoamingAppData}\<rel>`, `<rel>` 1-6 components with the path-template
 * character rules; resolved inside the Staff profile by the agent.
 */
export function resetFoldersProblem(list: string[]): string | null {
  if (list.length > MAX_RESET_FOLDERS) return "too many folders";
  for (const item of list) {
    const prefix = ["{LocalAppData}\\", "{RoamingAppData}\\"].find((p) => item.startsWith(p));
    if (prefix === undefined) return "folder must start with {LocalAppData} or {RoamingAppData}";
    const rest = item.slice(prefix.length).split("\\");
    if (rest.length < 1 || rest.length > 6 || !rest.every(validComponent)) return "folder path not allowed";
  }
  return null;
}
