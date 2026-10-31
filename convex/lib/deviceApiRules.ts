import type { AuditAction } from "./audit";
import { DAY_MS, MINUTE_MS } from "./limits";
import { normalizeUsername } from "./employeeRules";

// Rules of what an agent may send to `deviceApi` (plan Step 12, 4.11, 4.12).
// PURE. The bounds live here, next to the rules that use them, rather than in
// `limits.ts`: none of them is a `.take(n)`.

/** Server lockout of an employee (4.12): this many consecutive wrong passwords lock for EMPLOYEE_LOCK_MS. */
export const EMPLOYEE_MAX_FAILURES = 10;
export const EMPLOYEE_LOCK_MS = 15 * MINUTE_MS;

/**
 * Sign-in guard (review of Step 12): once the device's `verifyPerDevice` bucket
 * holds fewer tokens than this, the sign-in takes its token BEFORE the Argon2id
 * verify (one extra write, only in this state), so a burst cannot run unbounded
 * verifies against a nearly empty bucket.
 */
export const VERIFY_RESERVE_BELOW = 10;

/** `quotaBytes` = GB x this (4.12). */
export const BYTES_PER_GB = 1_073_741_824;

/** One report: at most this many audit records and install results (5.1). */
export const MAX_REPORT_AUDIT = 50;
export const MAX_REPORT_INSTALLS = 50;
/** A device record's `detail` (4.11) and an install result's `detail` (Step 12 item 3). */
export const MAX_AUDIT_DETAIL = 100;
export const MAX_INSTALL_DETAIL = 200;
/** A device clock more than this far ahead is wrong (4.11). */
export const AUDIT_FUTURE_SLACK_MS = 7 * DAY_MS;

/** The five Phase 2 record kinds (`apps/agent/src/audit.rs` `AuditKind`) and the audit action each becomes. */
const KIND_ACTIONS: Record<string, AuditAction> = {
  adminExitSuccess: "device.adminExitSuccess",
  adminExitWrongPin: "device.adminExitWrongPin",
  adminExitLockedOut: "device.adminExitLockedOut",
  adminExitFailed: "device.adminExitFailed",
  employeeLockedOut: "device.employeeLockedOut",
};

/** The audit action of a record kind, or null for an unknown kind (the record is skipped). */
export function actionOfKind(kind: string): AuditAction | null {
  return Object.hasOwn(KIND_ACTIONS, kind) ? (KIND_ACTIONS[kind] ?? null) : null;
}

/** A record id the agent made (32 hex today); anything else is skipped. */
export function validRecordId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

/** The record's `detail` when it is short and made of the fixed-text characters, else null (dropped). */
export function cleanDetail(detail: string | null | undefined): string | null {
  if (detail === null || detail === undefined || detail.length === 0) return null;
  return detail.length <= MAX_AUDIT_DETAIL && /^[a-z0-9:_ -]*$/.test(detail) ? detail : null;
}

/** The record's `username` (employee lockouts) normalized, or null when it is not a username. */
export function cleanUsername(username: string | null | undefined): string | null {
  if (username === null || username === undefined) return null;
  const u = normalizeUsername(username);
  return u.length >= 1 && u.length <= 64 && /^[a-z0-9._-]+$/.test(u) ? u : null;
}

/**
 * When a device record happened (4.11): device time corrected by the offset it
 * knew, unless that is more than 7 days ahead of the server or before the
 * device enrolled (then server receive time and `clockWrong`).
 */
export function recordTime(
  r: { atMs: number; serverTimeOffsetMs?: number | null },
  enrolledAt: number,
  now: number,
): { at: number; clockWrong: boolean } {
  const offset = r.serverTimeOffsetMs;
  const at = typeof offset === "number" && Number.isFinite(offset) ? r.atMs + offset : r.atMs;
  if (!Number.isFinite(at) || at > now + AUDIT_FUTURE_SLACK_MS || at < enrolledAt) return { at: now, clockWrong: true };
  return { at, clockWrong: false };
}

/** The fixed summary of a device record. Names only: never a PIN, password or hash. */
export function recordSummary(
  action: AuditAction,
  device: string,
  r: { username: string | null; detail: string | null; clockWrong: boolean },
): string {
  const who = r.username ?? "An employee";
  let text: string;
  switch (action) {
    case "device.adminExitSuccess":
      text = `The admin exit was used on the PC ${device}`;
      break;
    case "device.adminExitWrongPin":
      text = `A wrong exit PIN was entered on the PC ${device}`;
      break;
    case "device.adminExitLockedOut":
      text = `The admin exit locked after too many wrong PINs on the PC ${device}`;
      break;
    case "device.adminExitFailed":
      text = `The admin exit failed on the PC ${device}`;
      break;
    default:
      text = `${who} was locked out after too many wrong passwords on the PC ${device}`;
  }
  if (r.detail !== null) text += ` (${r.detail})`;
  if (r.clockWrong) text += " (device clock wrong)";
  return text;
}

/** Install `detail` values the agent may send (Step 12 item 3). */
export const INSTALL_DETAILS: ReadonlySet<string> = new Set([
  "download_failed",
  "hash_mismatch",
  "too_large",
  "low_disk",
  "timeout",
  "exit_code",
  "exe_missing_after_install",
  "unsupported",
  "busy",
  "remove_failed",
]);

/** The install states a report stores (A12, 4.8 amended): `pending` (accepted) and the terminal ones. */
export const STORED_INSTALL_STATES: ReadonlySet<string> = new Set(["pending", "installed", "failed", "removed", "unsupported"]);

/** A non-negative whole number that JSON carries exactly. */
export function isCount(n: number): boolean {
  return Number.isSafeInteger(n) && n >= 0;
}
