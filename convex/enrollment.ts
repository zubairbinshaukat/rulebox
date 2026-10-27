import { v } from "convex/values";
import { writeAudit } from "./lib/audit";
import { constantTimeEqual, isEnrollmentTokenShape, sha256HexSync } from "./lib/crypto";
import { writeStatus } from "./lib/deviceReport";
import { createPresence, orgPingInterval } from "./lib/presence";
import { normalizeDeviceName } from "./lib/enrollmentCodes";
import { fail, failWire } from "./lib/errors";
import { publicMutation } from "./lib/functions";
import { MAX_AGENT_VERSION, MAX_COMPAT_JSON_BYTES, MAX_DEVICE_NAME_INPUT } from "./lib/limits";
import { assertWithinLimit, bumpStats } from "./lib/plans";
import { rateLimiter } from "./lib/rateLimits";

const HEX64_RE = /^[0-9a-f]{64}$/;

/**
 * Enroll a device with an enrollment token (PRD 15, Phase 2 plan 5.4; Phase 4
 * Step 6 with amendments A1, A9).
 *
 * The wire contract of Phase 2 is unchanged: same arguments, same answer
 * `{ deviceId, orgId, deviceName, serverTimeMs }`, same error codes. The
 * caller proves it holds a token; `deviceSecretHash` is the SHA-256 of the
 * device secret, which never leaves the machine. Retrying with the same token
 * and the same secret hash returns the first result without using up the
 * token (also once the token is used up, expired or revoked, and at the
 * device limit).
 *
 * Everything happens in this one mutation. Convex mutations are serializable
 * (optimistic concurrency control): parallel calls that read the same token
 * row, the `orgStats` row or the `devices.by_secret_hash` range conflict and
 * are retried against the committed state, so a code can never be used more
 * than `usesTotal` times and the plan's `maxDevices` can never be passed, and
 * each success writes exactly one device row and one counter bump.
 *
 * Errors (`ConvexError` data `{ code }`):
 * - Phase 2 codes the agent maps: `token_invalid`, `token_revoked`,
 *   `token_expired`, `token_used_up`, `invalid_request`.
 * - New in Phase 4: `rate_limited` (+ `retryAfterMs`), `plan_limit` with
 *   `detail` "devices" (plan full) or "suspended", `not_ready` (counter row
 *   missing). A Phase 2 agent shows any code it does not know as "The backend
 *   refused the request." with the code, keeps its pending enrollment and
 *   exits 3 (apps/agent/src/enroll.rs `backend_failure`).
 *
 * Abuse: a refused attempt throws, so the whole transaction (including the
 * rate-limiter consumption) rolls back: 0 writes, at most 3 reads. Malformed
 * input is refused before any read.
 */
export const enroll = publicMutation({
  args: {
    token: v.string(),
    deviceSecretHash: v.string(),
    deviceName: v.string(),
    hardwareIdHash: v.optional(v.string()),
    agentVersion: v.string(),
    compat: v.any(),
  },
  returns: v.object({
    deviceId: v.id("devices"),
    orgId: v.id("organizations"),
    deviceName: v.string(),
    serverTimeMs: v.number(),
  }),
  handler: async (ctx, args) => {
    // 1. Shape checks: no reads, no writes.
    const secretHash = args.deviceSecretHash.toLowerCase();
    if (!HEX64_RE.test(secretHash)) {
      failWire("invalid_request", "deviceSecretHash must be 64 hex characters");
    }
    // Not a token any code can hold: the same answer as an unknown token.
    if (!isEnrollmentTokenShape(args.token)) failWire("token_invalid");
    let hardwareIdHash: string | undefined;
    if (args.hardwareIdHash !== undefined) {
      hardwareIdHash = args.hardwareIdHash.toLowerCase();
      if (!HEX64_RE.test(hardwareIdHash)) failWire("invalid_request", "hardwareIdHash must be 64 hex characters");
    }
    if (args.deviceName.length > MAX_DEVICE_NAME_INPUT) failWire("invalid_request", "deviceName is too long");
    if (args.agentVersion.length > MAX_AGENT_VERSION) failWire("invalid_request", "agentVersion is too long");
    if (JSON.stringify(args.compat ?? null).length > MAX_COMPAT_JSON_BYTES) {
      failWire("invalid_request", "compat is too large");
    }

    // 2. Deployment-wide bucket, before the lookup (an unknown token has no org).
    const global = await rateLimiter.limit(ctx, "enrollGlobal");
    if (!global.ok) fail("rate_limited", { retryAfterMs: global.retryAfter });

    // 3. The token, by the SHA-256 of what was presented (index lookup on a
    //    hash: its timing says nothing about the token), then compared again
    //    in constant time.
    const tokenHash = sha256HexSync(args.token);
    const token = await ctx.db
      .query("enrollmentTokens")
      .withIndex("by_token_hash", (q) => q.eq("tokenHash", tokenHash))
      .first();
    if (token === null || !constantTimeEqual(token.tokenHash, tokenHash)) {
      failWire("token_invalid");
    }

    // 4. Idempotent retry after a lost answer: the first result, nothing written
    //    but the global bucket. Credentials live in `deviceCredentials` (A2);
    //    devices enrolled before the split still carry theirs on `devices`
    //    until the narrow step.
    const cred = await ctx.db
      .query("deviceCredentials")
      .withIndex("by_secret_hash", (q) => q.eq("secretHash", secretHash))
      .first();
    const existing =
      cred !== null
        ? await ctx.db.get(cred.deviceId)
        : await ctx.db
            .query("devices")
            .withIndex("by_secret_hash", (q) => q.eq("secretHash", secretHash))
            .first();
    if (existing !== null) {
      if (existing.enrollmentTokenId === token._id) {
        return {
          deviceId: existing._id,
          orgId: existing.orgId,
          deviceName: existing.name,
          serverTimeMs: Date.now(),
        };
      }
      // A device secret must never be shared between two devices.
      failWire("invalid_request", "device secret already in use");
    }

    // 5. The code's own state (server time; the agent's clock is not trusted).
    const now = Date.now();
    if (token.revoked === true) failWire("token_revoked");
    if (token.expiresAt <= now) failWire("token_expired");
    if (token.usesLeft <= 0) failWire("token_used_up");

    // 6. Per-organization bucket, then the plan (A1): suspended organization or
    //    `deviceCount >= maxDevices` -> plan_limit. Same transaction as the insert.
    const perOrg = await rateLimiter.limit(ctx, "enrollPerOrg", { key: token.orgId });
    if (!perOrg.ok) fail("rate_limited", { retryAfterMs: perOrg.retryAfter });
    const stats = await assertWithinLimit(ctx, token.orgId, "devices");

    // 7. Writes: token, device (identity only), credentials, presence rows
    //    (online now), summary + report, counters, audit.
    const usesLeft = token.usesLeft - 1;
    const deviceName = normalizeDeviceName(args.deviceName);
    await ctx.db.patch(token._id, { usesLeft });
    const deviceId = await ctx.db.insert("devices", {
      orgId: token.orgId,
      groupId: token.groupId,
      name: deviceName,
      enrolledAt: now,
      enrollmentTokenId: token._id,
      hardwareIdHash,
    });
    const ids = { deviceId, orgId: token.orgId };
    await ctx.db.insert("deviceCredentials", { ...ids, secretHash, state: "active" });
    await createPresence(ctx, ids, now, await orgPingInterval(ctx, token.orgId));
    await writeStatus(ctx, ids, { agentVersion: args.agentVersion, compat: args.compat }, now);
    await bumpStats(ctx, stats, {
      deviceCount: 1,
      noGroupDeviceCount: token.groupId === undefined ? 1 : 0,
      // The last use leaves the active-code count (only codes it counts).
      activeEnrollmentCodes: usesLeft === 0 && token.usesTotal !== undefined ? -1 : 0,
    });
    await writeAudit(ctx, {
      orgId: token.orgId,
      actor: { type: "device", id: deviceId, label: deviceName },
      action: "device.enrolled",
      targetType: "device",
      targetId: deviceId,
      targetLabel: deviceName,
      summary:
        token.label !== undefined
          ? `Enrolled the PC ${deviceName} with the enrollment code ${token.label}`
          : `Enrolled the PC ${deviceName} with an enrollment code`,
    });

    return {
      deviceId,
      orgId: token.orgId,
      deviceName,
      serverTimeMs: now,
    };
  },
});
