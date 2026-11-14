/**
 * The driver rules the server enforces (`drivers:save`, Phase 5 Step 14b), mirrored here for inline messages and for the demo backend.
 * Pure: no sentences (the screen maps a problem to its text). The sha256 and https rules are the ones of the app installers.
 */
import type { DriverClass, DriverKind } from "../data/types";

export const DRIVER_KINDS: readonly DriverKind[] = ["inf", "exe", "msi"];
export const DRIVER_CLASSES: readonly DriverClass[] = ["printer", "scanner", "other"];
/** Drivers per organization (`MAX_ORG_DRIVERS` on the server). */
export const MAX_DRIVERS = 50;
export const MAX_DRIVER_NAME = 60;
export const MAX_DRIVER_URL = 2000;
export const MAX_DRIVER_INF = 120;
export const MAX_SILENT_ARGS = 16;
export const MAX_SILENT_ARG = 200;
export const MAX_SUCCESS_CODES = 8;
export const MAX_PROVIDES = 10;
export const MAX_PROVIDED_NAME = 100;
/** The largest download the agent accepts (4 GiB). */
export const MAX_DRIVER_BYTES = 4 * 1024 * 1024 * 1024;
/** Approved printer driver names an admin may add (`MAX_APPROVED_PRINTER_DRIVERS` on the server). */
export const MAX_ADDED_NAMES = 20;
export const MAX_ADDED_NAME = 100;

function hasControl(text: string): boolean {
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    if (c < 0x20 || c === 0x7f || (c >= 0x80 && c < 0xa0)) return true;
  }
  return false;
}

export type NameProblem = "empty" | "length" | "characters";

export function driverNameProblem(name: string): NameProblem | null {
  const n = name.trim();
  if (n.length === 0) return "empty";
  if (n.length > MAX_DRIVER_NAME) return "length";
  return hasControl(n) ? "characters" : null;
}

export type UrlProblem = "empty" | "length" | "scheme" | "characters";

/** `https://` only, one line, at most 2000 characters. */
export function driverUrlProblem(raw: string): UrlProblem | null {
  const u = raw.trim();
  if (u === "") return "empty";
  if (u.length > MAX_DRIVER_URL) return "length";
  if (!/^https:\/\/[^/?#\s]+/i.test(u)) return "scheme";
  return /\s/.test(u) || hasControl(u) ? "characters" : null;
}

export type HashProblem = "empty" | "format";

/** 64 hexadecimal digits, any case (the call sends lower case). */
export function sha256Problem(raw: string): HashProblem | null {
  const h = raw.trim();
  if (h === "") return "empty";
  return /^[0-9a-fA-F]{64}$/.test(h) ? null : "format";
}

export type SizeProblem = "number" | "range";

/** Empty = unknown (0). Otherwise a whole number of bytes up to 4 GiB. */
export function sizeProblem(raw: string): SizeProblem | null {
  const t = raw.trim();
  if (t === "") return null;
  if (!/^\d{1,12}$/.test(t)) return "number";
  return Number(t) > MAX_DRIVER_BYTES ? "range" : null;
}

export type InfProblem = "empty" | "length" | "extension" | "path";

/** A relative path inside the zip that ends in `.inf`: no leading slash or backslash, no `..`, no drive or stream colon. */
export function infProblem(raw: string): InfProblem | null {
  const p = raw.trim();
  if (p === "") return "empty";
  if (p.length > MAX_DRIVER_INF) return "length";
  if (!p.toLowerCase().endsWith(".inf")) return "extension";
  if (p.startsWith("/") || p.startsWith("\\") || p.includes(":") || hasControl(p)) return "path";
  if (p.split(/[\\/]/).some((part) => part === ".." || part === "." || part === "")) return "path";
  return null;
}

export type ArgsProblem = "required" | "count" | "length" | "characters";

/** One argument per line; blank lines are dropped. A vendor installer needs at least one. */
export function argsOf(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "");
}

export function silentArgsProblem(args: readonly string[]): ArgsProblem | null {
  if (args.length === 0) return "required";
  if (args.length > MAX_SILENT_ARGS) return "count";
  if (args.some((a) => a.length > MAX_SILENT_ARG)) return "length";
  return args.some(hasControl) ? "characters" : null;
}

export type CodesProblem = "number" | "count";

/** Comma separated whole numbers; empty is fine (only 0 counts then). */
export function codesOf(text: string): number[] | null {
  const parts = text
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p !== "");
  const out: number[] = [];
  for (const p of parts) {
    if (!/^-?\d{1,10}$/.test(p)) return null;
    out.push(Number(p));
  }
  return out;
}

export function codesProblem(text: string): CodesProblem | null {
  const codes = codesOf(text);
  if (codes === null) return "number";
  return codes.length > MAX_SUCCESS_CODES ? "count" : null;
}

export type ProvidesProblem = "count" | "length" | "characters";

/** One printer driver name per line; blank lines are dropped. */
export function namesOf(text: string): string[] {
  return argsOf(text);
}

export function providesProblem(names: readonly string[]): ProvidesProblem | null {
  if (names.length > MAX_PROVIDES) return "count";
  if (names.some((n) => n.length > MAX_PROVIDED_NAME)) return "length";
  return names.some(hasControl) ? "characters" : null;
}

export type AddedProblem = "empty" | "length" | "characters" | "count";

/** One approved printer driver name an admin adds. */
export function addedNameProblem(raw: string): AddedProblem | null {
  const n = raw.trim();
  if (n === "") return "empty";
  if (n.length > MAX_ADDED_NAME) return "length";
  return hasControl(n) ? "characters" : null;
}

/** Case-insensitive dedupe, first spelling wins. */
export function dedupeNames(names: readonly string[]): string[] {
  const out: string[] = [];
  for (const n of names) if (!out.some((x) => x.toLowerCase() === n.toLowerCase())) out.push(n);
  return out;
}
