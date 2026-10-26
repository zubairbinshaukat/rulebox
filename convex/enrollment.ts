import { v } from "convex/values";
import { sha256Hex } from "./lib/deviceAuth";
import { failWire } from "./lib/errors";
import { publicMutation } from "./lib/functions";

const SECRET_HASH_RE = /^[0-9a-f]{64}$/;
const MAX_NAME_LENGTH = 100;

/**
 * Enroll a device with an enrollment token (PRD 15, Phase 2 plan 5.4).
 *
 * Everything happens in this one mutation, so it is atomic. The caller
 * proves it holds a token; `deviceSecretHash` is the SHA-256 of the device
 * secret, which never leaves the machine. Retrying with the same token and
 * the same secret hash returns the first result without using up the token.
 *
 * Errors are `ConvexError({ code })` with one of: `token_invalid`,
 * `token_revoked`, `token_expired`, `token_used_up`, `invalid_request`.
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
    const secretHash = args.deviceSecretHash.toLowerCase();
    if (!SECRET_HASH_RE.test(secretHash)) {
      failWire("invalid_request", "deviceSecretHash must be 64 hex characters");
    }

    const tokenHash = await sha256Hex(args.token);
    const token = await ctx.db
      .query("enrollmentTokens")
      .withIndex("by_token_hash", (q) => q.eq("tokenHash", tokenHash))
      .first();
    if (token === null) {
      failWire("token_invalid");
    }

    const existing = await ctx.db
      .query("devices")
      .withIndex("by_secret_hash", (q) => q.eq("secretHash", secretHash))
      .first();
    if (existing !== null) {
      if (existing.enrollmentTokenId === token._id) {
        // Retry after a lost response: same result, no use consumed.
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

    const now = Date.now();
    if (token.revoked === true) {
      failWire("token_revoked");
    }
    if (token.expiresAt <= now) {
      failWire("token_expired");
    }
    if (token.usesLeft <= 0) {
      failWire("token_used_up");
    }

    const deviceName =
      args.deviceName.trim().slice(0, MAX_NAME_LENGTH) || "Unnamed device";

    await ctx.db.patch(token._id, { usesLeft: token.usesLeft - 1 });
    const deviceId = await ctx.db.insert("devices", {
      orgId: token.orgId,
      groupId: token.groupId,
      name: deviceName,
      secretHash,
      revoked: false,
      enrolledAt: now,
      enrollmentTokenId: token._id,
      hardwareIdHash: args.hardwareIdHash,
      agentVersion: args.agentVersion,
      compat: args.compat,
    });
    await ctx.db.insert("deviceStatus", { deviceId, orgId: token.orgId, lastSeenAt: now });

    return {
      deviceId,
      orgId: token.orgId,
      deviceName,
      serverTimeMs: now,
    };
  },
});
