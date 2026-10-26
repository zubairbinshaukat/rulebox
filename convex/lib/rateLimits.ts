import { RateLimiter } from "@convex-dev/rate-limiter";
import { components } from "../_generated/api";
import { fail } from "./errors";
import { HOUR_MS, MINUTE_MS } from "./limits";

// Rate limits (plan Step 3; @convex-dev/rate-limiter 0.4.2). Each `limit`
// call is one component mutation that reads and writes ONE row (patch, or
// insert for a new key). Keys are SHA-256 hashes, never raw emails.
//
// They are consumed from ACTIONS (ctx.runMutation commits on its own), so a
// later error in the caller does not roll the consumption back.
//
// TOTP verify and recovery-code use are limited by the persisted lockout
// counter in `memberSecrets` (5 failures -> 15 minutes) instead of a second
// row per attempt.
export const rateLimiter = new RateLimiter(components.rateLimiter, {
  // Every sign-in and sign-up attempt, per email. At least as strict as Convex
  // Auth's own per-account limit (10 failures / hour), so that one never
  // answers first and an attacker cannot tell existing accounts apart.
  signInPerEmail: { kind: "token bucket", rate: 10, period: HOUR_MS, capacity: 10 },
  // account:redeemReset, per email (a global bucket would let anyone block
  // every reset; the code itself has 130 bits).
  redeemCode: { kind: "token bucket", rate: 10, period: 15 * MINUTE_MS, capacity: 10 },
});

export type LimitName = "signInPerEmail" | "redeemCode";

/** Consume one token or throw `rate_limited` with `retryAfterMs`. Actions and mutations. */
export async function consumeOrFail(
  ctx: Parameters<typeof rateLimiter.limit>[0],
  name: LimitName,
  key: string,
): Promise<void> {
  const status = await rateLimiter.limit(ctx, name, { key });
  if (!status.ok) fail("rate_limited", { retryAfterMs: status.retryAfter });
}
