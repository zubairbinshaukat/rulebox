import { fail } from "./errors";
import {
  MAX_DEFAULT_QUOTA_GB,
  MAX_EMPLOYEE_NAME,
  MAX_EMPLOYEE_PASSWORD,
  MAX_USERNAME,
  MIN_EMPLOYEE_PASSWORD,
} from "./limits";

// Validation and normalization of what an admin submits for an employee (plan
// 4.12, Step 11). PURE apart from `fail`. The dashboard mirrors these rules in
// `lib/validate.ts` for inline messages; the server is authoritative.

// C0 controls, DEL and the bidi direction marks / overrides / isolates (they reorder or hide text).
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f‎‏‪-‮⁦-⁩]/;

/** Names are shown to other people: 1-100 characters, trimmed, no control characters. */
export function normalizeEmployeeName(name: string): string {
  const t = name.trim();
  if (t.length < 1 || t.length > MAX_EMPLOYEE_NAME || CONTROL.test(t)) fail("invalid_argument", { field: "name" });
  return t;
}

/** The agent's normalization (4.12): trim and lower-case. */
export function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

/** The normalized username: 1-64 of letters, digits, `.`, `_`, `-`; else `invalid_argument` (field "username"). */
export function checkedUsername(username: string): string {
  const u = normalizeUsername(username);
  if (u.length < 1 || u.length > MAX_USERNAME || !/^[a-z0-9._-]+$/.test(u)) fail("invalid_argument", { field: "username" });
  return u;
}

/** undefined = the organization's default quota; 0 = unlimited. A whole number of GB, 0..2000. */
export function checkedQuota(quotaGb: number | undefined): number | undefined {
  if (quotaGb === undefined) return undefined;
  if (!Number.isInteger(quotaGb) || quotaGb < 0 || quotaGb > MAX_DEFAULT_QUOTA_GB) fail("invalid_argument", { field: "quotaGb" });
  return quotaGb;
}

/**
 * Plan 4.12: 8-256 characters, not equal to the username. Returns the reason
 * ("length" | "username") or null; the reason is a fixed word, never the value.
 */
export function employeePasswordProblem(password: string, username: string): "length" | "username" | null {
  if (password.length < MIN_EMPLOYEE_PASSWORD || password.length > MAX_EMPLOYEE_PASSWORD) return "length";
  if (normalizeUsername(password) === normalizeUsername(username)) return "username";
  return null;
}

export function assertEmployeePassword(password: string, username: string): void {
  const problem = employeePasswordProblem(password, username);
  if (problem !== null) fail("invalid_argument", { field: "password", detail: problem });
}

/** What the search index covers: `name + " " + username`, lower-case (plan 4.2). */
export function searchTextOf(name: string, username: string): string {
  return `${name} ${username}`.toLowerCase();
}

/** The text of a search box, ready for the search index: trimmed, lower-case, at most `max` characters. */
export function searchQuery(text: string, max: number): string {
  return text.trim().toLowerCase().slice(0, max);
}
