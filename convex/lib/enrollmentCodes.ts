import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseReader } from "../_generated/server";
import { hasControlChar } from "./crypto";
import { MAX_CODE_RECOUNT, MAX_CODE_TTL_MINUTES, MAX_DEVICE_NAME, MINUTE_MS } from "./limits";

// Enrollment-code rules shared by `enrollmentCodes.ts`, `enrollment.ts` and
// the dev helpers (plan Step 6).
//
// `orgStats.activeEnrollmentCodes` counts the codes created by
// `enrollmentCodes:create` (rows with `usesTotal`) that are not revoked, have
// uses left and had not expired when they last changed. It goes up on create
// and down on revoke and on the enrollment that uses the last use. Expiry is
// not an event: an expired code stays counted until `create` recounts (only
// when the counter is at the limit) or `stats:reconcile` (Step 17) runs.

export type CodeState = "active" | "usedUp" | "expired" | "revoked";

export function codeState(token: Doc<"enrollmentTokens">, nowMs: number): CodeState {
  if (token.revoked === true) return "revoked";
  if (token.usesLeft <= 0) return "usedUp";
  if (token.expiresAt <= nowMs) return "expired";
  return "active";
}

/** True when the row is one `activeEnrollmentCodes` counts right now. */
export function countsAsActive(token: Doc<"enrollmentTokens">, nowMs: number): boolean {
  return token.usesTotal !== undefined && codeState(token, nowMs) === "active";
}

/**
 * Exact number of counted active codes of an organization, or null when more
 * than MAX_CODE_RECOUNT codes were created in the last 7 days (the caller
 * fails closed). Reads `enrollmentTokens.by_org_created` from `now - 7 days`:
 * no code made by `create` can be unexpired before that.
 */
export async function recountActiveCodes(
  ctx: { db: DatabaseReader },
  orgId: Id<"organizations">,
  nowMs: number,
): Promise<number | null> {
  const recent = await ctx.db
    .query("enrollmentTokens")
    .withIndex("by_org_created", (q) =>
      q.eq("orgId", orgId).gte("createdAt", nowMs - MAX_CODE_TTL_MINUTES * MINUTE_MS),
    )
    .take(MAX_CODE_RECOUNT + 1);
  if (recent.length > MAX_CODE_RECOUNT) return null;
  return recent.filter((t) => countsAsActive(t, nowMs)).length;
}

/**
 * The name the agent sent (PC name or `--name`): control characters become
 * spaces, runs of white space collapse, trimmed, at most MAX_DEVICE_NAME
 * characters (code points); empty = "Unnamed device". Never refuses (an odd
 * name must not leave a PC unenrolled); the caller bounds the raw length.
 */
export function normalizeDeviceName(raw: string): string {
  let clean = "";
  for (const ch of raw) {
    const c = ch.codePointAt(0) ?? 0;
    // C0, DEL, C1 controls, line/paragraph separators, BOM / zero-width marks.
    const invisible = c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029 || c === 0xfeff || (c >= 0x200b && c <= 0x200f);
    clean += invisible ? " " : ch;
  }
  const collapsed = clean.replace(/\s+/g, " ").trim();
  const limited = Array.from(collapsed).slice(0, MAX_DEVICE_NAME).join("").trim();
  return limited === "" ? "Unnamed device" : limited;
}

/** Label of a code: trimmed, 1-64 characters, no control characters; "" = none. Null = invalid. */
export function normalizeLabel(raw: string | undefined, max: number): string | undefined | null {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  if (Array.from(trimmed).length > max || hasControlChar(trimmed)) return null;
  return trimmed;
}
