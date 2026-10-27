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
  // Step-up (plan 4.16). Convex functions see no client IP, so the buckets
  // are per user and one global ("IP-less") bucket.
  // WebAuthn challenges per user (each one is a row write anyway).
  stepUpChallenge: { kind: "token bucket", rate: 20, period: 10 * MINUTE_MS, capacity: 20 },
  // Failed PIN or passkey verifications across the deployment, consumed only
  // on a failure (checked first): many stolen sessions guessing at once.
  // The per-user bound is the persisted PIN lockout in `stepUpFactors`.
  stepUpFailuresGlobal: { kind: "token bucket", rate: 300, period: MINUTE_MS, capacity: 300, shards: 4 },
  // enrollment:enroll (plan Step 6 item 6, A9; post-Phase-5 4.4). Convex sees
  // no client IP: one deployment-wide bucket, consumed before the token
  // lookup, and one per organization (key = org id), consumed once the token
  // resolved. `enroll` is a MUTATION (Phase 2 wire contract), so a refused
  // attempt rolls its consumption back: these buckets bound successful
  // enrollments (and idempotent retries, global only); failed attempts write
  // nothing at all and are bounded by the 100-bit token.
  enrollGlobal: { kind: "token bucket", rate: 120, period: MINUTE_MS, capacity: 120 },
  enrollPerOrg: { kind: "token bucket", rate: 10, period: MINUTE_MS, capacity: 10 },
});

export type LimitName =
  | "signInPerEmail"
  | "redeemCode"
  | "stepUpChallenge"
  | "stepUpFailuresGlobal"
  | "enrollGlobal"
  | "enrollPerOrg";

/** Read-only: throw `rate_limited` when the bucket is empty, without consuming. */
export async function checkOrFail(
  ctx: Parameters<typeof rateLimiter.check>[0],
  name: LimitName,
  key?: string,
): Promise<void> {
  const status = await rateLimiter.check(ctx, name, key === undefined ? {} : { key });
  if (!status.ok) fail("rate_limited", { retryAfterMs: status.retryAfter });
}

/** Consume one token without throwing (a failure was already decided). */
export async function consumeQuietly(
  ctx: Parameters<typeof rateLimiter.limit>[0],
  name: LimitName,
  key?: string,
): Promise<void> {
  await rateLimiter.limit(ctx, name, key === undefined ? {} : { key });
}

/** Consume one token or throw `rate_limited` with `retryAfterMs`. Actions and mutations. */
export async function consumeOrFail(
  ctx: Parameters<typeof rateLimiter.limit>[0],
  name: LimitName,
  key: string,
): Promise<void> {
  const status = await rateLimiter.limit(ctx, name, { key });
  if (!status.ok) fail("rate_limited", { retryAfterMs: status.retryAfter });
}
