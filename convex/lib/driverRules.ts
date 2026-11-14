import { fail } from "./errors";
import {
  MAX_DRIVER_ARGS,
  MAX_DRIVER_EXIT_CODES,
  MAX_DRIVER_INF,
  MAX_DRIVER_NAME,
  MAX_DRIVER_PROVIDES,
  MAX_INSTALLER_BYTES,
  MAX_PRINTER_DRIVER,
  MAX_APP_ARG_LENGTH,
} from "./limits";
import { hasControlChars } from "./networkShared";
import { httpsUrlProblem } from "./appRules";

// What an admin may submit for a driver package (Phase 5 Step 14b, PRD 24.2). PURE apart from `fail`, which throws a
// `ConvexError` (`invalid_argument` with `field` and `detail`). Every function returns the value to store, so what the signed
// document later carries is exactly what was checked. The same limits live in `rulebox-policy` (`DriverSpec`).

export type DriverKind = "inf" | "exe" | "msi";

const SHA256 = /^[0-9a-fA-F]{64}$/;

/** The trimmed driver name (1-60), or `invalid_argument` field "name". */
export function checkDriverName(name: string): string {
  const n = name.trim();
  if (n.length === 0) fail("invalid_argument", { field: "name", detail: "empty" });
  if (n.length > MAX_DRIVER_NAME) fail("invalid_argument", { field: "name", detail: "length" });
  if (hasControlChars(n)) fail("invalid_argument", { field: "name", detail: "characters" });
  return n;
}

/** `https://` with a host and no credentials, as an app installer's address. */
export function checkDriverUrl(url: string): string {
  const u = url.trim();
  if (httpsUrlProblem(u)) fail("invalid_argument", { field: "url", detail: "not_https" });
  return u;
}

/** 64 hex characters, returned in lower case. */
export function checkDriverSha256(sha256: string): string {
  if (!SHA256.test(sha256)) fail("invalid_argument", { field: "sha256", detail: "format" });
  return sha256.toLowerCase();
}

export function checkDriverSize(size: number): number {
  if (!Number.isInteger(size) || size < 0 || size > MAX_INSTALLER_BYTES) fail("invalid_argument", { field: "sizeBytes", detail: "range" });
  return size;
}

/**
 * The `.inf` of a package: kind "inf" needs one (the path inside the zip), no other kind accepts one. 1-120 characters, a relative
 * path (no leading `/` or `\`, no drive or stream colon, no empty, `.` or `..` segment), no control characters, ending in `.inf`.
 */
export function checkDriverInf(kind: DriverKind, inf: string | undefined): string | undefined {
  const text = inf?.trim() ?? "";
  if (kind !== "inf") {
    if (text !== "") fail("invalid_argument", { field: "inf", detail: "not_allowed" });
    return undefined;
  }
  if (text === "") fail("invalid_argument", { field: "inf", detail: "empty" });
  if (text.length > MAX_DRIVER_INF) fail("invalid_argument", { field: "inf", detail: "length" });
  if (hasControlChars(text)) fail("invalid_argument", { field: "inf", detail: "characters" });
  if (text.startsWith("/") || text.startsWith("\\") || text.includes(":")) fail("invalid_argument", { field: "inf", detail: "path" });
  if (text.split(/[\\/]/).some((segment) => segment === "" || segment === "." || segment === "..")) fail("invalid_argument", { field: "inf", detail: "path" });
  if (!text.toLowerCase().endsWith(".inf")) fail("invalid_argument", { field: "inf", detail: "extension" });
  return text;
}

/**
 * Silent arguments: kind "exe" needs 1-16 (each trimmed, 1-200 characters, no control characters); any other kind stores none (what
 * was sent is dropped, like an MSI's switches in `normalizeInstall`).
 */
export function checkDriverArgs(kind: DriverKind, args: readonly string[]): string[] {
  if (kind !== "exe") return [];
  const list = args.map((a) => a.trim()).filter((a) => a !== "");
  if (list.length === 0) fail("invalid_argument", { field: "silentArgs", detail: "empty" });
  if (list.length > MAX_DRIVER_ARGS) fail("invalid_argument", { field: "silentArgs", detail: "too_many" });
  for (const a of list) {
    if (a.length > MAX_APP_ARG_LENGTH) fail("invalid_argument", { field: "silentArgs", detail: "length" });
    if (hasControlChars(a)) fail("invalid_argument", { field: "silentArgs", detail: "characters" });
  }
  return list;
}

/** Success exit codes (kind "exe" only; 0 always counts and is not stored): at most 8 whole numbers of 32 bits, sorted, no duplicates. */
export function checkDriverExitCodes(kind: DriverKind, codes: readonly number[]): number[] {
  if (kind !== "exe") return [];
  if (codes.length > MAX_DRIVER_EXIT_CODES) fail("invalid_argument", { field: "successExitCodes", detail: "too_many" });
  if (codes.some((c) => !Number.isInteger(c) || c < -2_147_483_648 || c > 2_147_483_647)) fail("invalid_argument", { field: "successExitCodes", detail: "range" });
  return [...new Set(codes)].filter((c) => c !== 0).sort((a, b) => a - b);
}

/** Printer driver names a package provides: at most 10, each 1-100 trimmed characters without control characters, no duplicates (case-insensitive). */
export function checkDriverProvides(names: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of names) {
    const n = raw.trim();
    if (n.length === 0) fail("invalid_argument", { field: "provides", detail: "empty" });
    if (n.length > MAX_PRINTER_DRIVER) fail("invalid_argument", { field: "provides", detail: "length" });
    if (hasControlChars(n)) fail("invalid_argument", { field: "provides", detail: "characters" });
    if (!out.some((x) => x.toLowerCase() === n.toLowerCase())) out.push(n);
  }
  if (out.length > MAX_DRIVER_PROVIDES) fail("invalid_argument", { field: "provides", detail: "too_many" });
  return out;
}
