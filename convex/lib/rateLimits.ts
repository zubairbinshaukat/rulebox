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
export const rateLimiter = new RateLimiter(components.rateLimiter, {
  // FAILED sign-in and sign-up attempts, per email (sign-up under its own key),
  // read before the attempt and charged after a failure only: a success costs
  // nothing. As strict as Convex Auth's own per-account limit (10 failures /
  // hour), so that one never answers first and an attacker cannot tell
  // existing accounts apart.
  signInPerEmail: { kind: "token bucket", rate: 10, period: HOUR_MS, capacity: 10 },
  // account:redeemReset, per email (a global bucket would let anyone block
  // every reset; the code itself has 130 bits).
  redeemCode: { kind: "token bucket", rate: 10, period: 15 * MINUTE_MS, capacity: 10 },
  // Step-up (plan 4.16). Convex functions see no client IP, so the buckets
  // are per user and one global ("IP-less") bucket.
  // WebAuthn challenges per user (each one is a row write anyway).
  stepUpChallenge: { kind: "token bucket", rate: 20, period: 10 * MINUTE_MS, capacity: 20 },
  // Failed PIN, passkey or recovery-code verifications across the deployment,
  // consumed only on a failure (checked first): many stolen sessions guessing
  // at once. It is only ever charged AFTER a per-user charge (the PIN's
  // reserved attempt in `pinCounters`, a consumed WebAuthn challenge from the
  // per-user `stepUpChallenge` bucket, a `recoveryCodePerUser` token), so one
  // account cannot drain it for everyone (security review finding 2).
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
  // Fleet (plan 4.6 amended, Step 7). Consumed only when the call writes:
  // `fleet:watch` per member (the page renews every 4 minutes), `fleet:checkNow`
  // per organization (each click wakes up to 50 PCs).
  watch: { kind: "token bucket", rate: 6, period: MINUTE_MS, capacity: 6 },
  checkNow: { kind: "token bucket", rate: 1, period: MINUTE_MS, capacity: 1 },
  // Apps (plan Step 10). Both actions make the server fetch from the internet
  // for an admin (web metadata, a GitHub manifest): per organization, so one
  // tenant cannot use the deployment as a proxy or burn the GitHub quota.
  webMeta: { kind: "token bucket", rate: 20, period: MINUTE_MS, capacity: 20 },
  wingetResolve: { kind: "token bucket", rate: 20, period: MINUTE_MS, capacity: 20 },
  // Employees (plan Step 11 item 6). Each password set or create-with-password
  // costs one Argon2id hash (~100-300 ms of CPU) in an action: 300 per hour per
  // organization, consumed before hashing.
  employeeWrites: { kind: "token bucket", rate: 300, period: HOUR_MS, capacity: 300 },
  // Device API (plan Step 12 item 5, A9; 4.12). `deviceApi:verifyEmployee`, per
  // device (key = device id): CHECKED (read-only) before the Argon2id verify and
  // consumed only on a wrong password, so a successful sign-in writes no row.
  // Over the limit the device is answered `lockedOut` with `retryAfterMs`.
  verifyPerDevice: { kind: "token bucket", rate: 30, period: MINUTE_MS, capacity: 30 },
  // Device writes (review of Step 12), per device (key = device id): one token per
  // ROW that `deviceApi:report` / `reportAudit` / `reportInstalls` /
  // `rotateCredential` really wrote (status summary and report, install results,
  // audit rows), consumed at the END of the mutation, so a replay or an unchanged
  // report writes nothing and costs nothing (A10), and a refused call rolls its
  // writes back. The capacity holds a full agent audit queue (500 records) plus a
  // first install report and status (600); the refill (60 rows/min) is far above
  // a healthy agent (a report per minute, a few audit records). A compromised
  // device can add at most 3,600 rows per hour.
  deviceWrites: { kind: "token bucket", rate: 60, period: MINUTE_MS, capacity: 600 },
  // Phase 5 Step 10 (plan 4.19): the lockdown reports (`deviceApi:reportApply`, `reportFindings`,
  // `reportSecurityDaily`, `reportAcks`, `registerSealKey`), per device (key = device id), ONE token
  // per call that really wrote something (an unchanged report is free), consumed at the end so a
  // refused call rolls its writes back. A healthy agent sends well under 10 a day; 60 an hour
  // bounds a compromised one. (`deviceWrites` is charged per row as well.)
  deviceReports: { kind: "token bucket", rate: 60, period: HOUR_MS, capacity: 60 },
  // `members:invite`, per organization; consumed in the mutation that stores
  // the invite (a refused invite rolls it back: only real invites count).
  inviteCreate: { kind: "token bucket", rate: 30, period: HOUR_MS, capacity: 30 },
  // Forgot PIN (Phase 4b Part C, session-bound since the security review).
  // `account:requestPinReset` needs a signed-in session and mails only that
  // person: per user (key = user id) FIRST, then the deployment-wide bucket
  // (Convex sees no client IP), so one account adds at most 3 per hour to the
  // global bucket and nobody can drain another person's bucket.
  pinResetPerUser: { kind: "token bucket", rate: 3, period: HOUR_MS, capacity: 3 },
  pinResetGlobal: { kind: "token bucket", rate: 30, period: MINUTE_MS, capacity: 30 },
  // `account:redeemPinReset`, per user (key = user id), consumed before the
  // token is looked up (the token has 256 bits; this bounds Argon2 work).
  pinResetRedeem: { kind: "token bucket", rate: 10, period: 15 * MINUTE_MS, capacity: 10 },
  // `stepUp:resetWithRecoveryCode`: per user, CONSUMED before any work
  // (parallel bursts included); the global step-up bucket is touched only
  // after this charge succeeded.
  recoveryCodePerUser: { kind: "token bucket", rate: 5, period: 15 * MINUTE_MS, capacity: 5 },
  // `account:changePassword`, per user, consumed before the current password
  // is checked (Convex Auth's own 10-failures-per-hour limit applies too).
  passwordChange: { kind: "token bucket", rate: 5, period: HOUR_MS, capacity: 5 },
});

export type LimitName =
  | "signInPerEmail"
  | "redeemCode"
  | "stepUpChallenge"
  | "stepUpFailuresGlobal"
  | "enrollGlobal"
  | "enrollPerOrg"
  | "watch"
  | "checkNow"
  | "webMeta"
  | "wingetResolve"
  | "employeeWrites"
  | "verifyPerDevice"
  | "deviceWrites"
  | "deviceReports"
  | "inviteCreate"
  | "pinResetPerUser"
  | "pinResetGlobal"
  | "pinResetRedeem"
  | "recoveryCodePerUser"
  | "passwordChange";

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

/** Consume `count` tokens (default one) or throw `rate_limited` with `retryAfterMs`. Actions and mutations. */
export async function consumeOrFail(
  ctx: Parameters<typeof rateLimiter.limit>[0],
  name: LimitName,
  key: string,
  count = 1,
): Promise<void> {
  const status = await rateLimiter.limit(ctx, name, count === 1 ? { key } : { key, count });
  if (!status.ok) fail("rate_limited", { retryAfterMs: status.retryAfter });
}
