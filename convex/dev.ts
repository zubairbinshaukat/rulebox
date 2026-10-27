// Phase 2 developer helpers. Internal mutations only: they cannot be called
// from a client, only with `npx convex run dev:<name> '<json args>'`.
// Phase 4 replaces this file with dashboard functions.

import { v } from "convex/values";
import {
  env,
  internalMutation,
  type MutationCtx,
} from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { sha256Hex } from "./lib/deviceAuth";
import {
  assertAgentAcceptableUrl,
  CROCKFORD,
  ENROLLMENT_TOKEN_LENGTH,
  formatEnrollmentCode,
} from "./lib/crypto";
import { countsAsActive } from "./lib/enrollmentCodes";
import { bumpOrgStatsIfPresent } from "./lib/plans";

/**
 * 20 Crockford base32 characters. 256 is a multiple of 32, so no bias.
 * DEV ONLY: a mutation's random source is seeded (plan Section 6); the
 * dashboard's `enrollmentCodes:create` makes its token in an action.
 */
function generateToken(): string {
  const bytes = new Uint8Array(ENROLLMENT_TOKEN_LENGTH);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) out += CROCKFORD.charAt(byte & 31);
  return out;
}

/** Seed org (dev only). Returns the new organization id. */
export const seedOrg = internalMutation({
  args: { name: v.string() },
  returns: v.id("organizations"),
  handler: async (ctx, args) => {
    return await ctx.db.insert("organizations", { name: args.name });
  },
});

/**
 * Create an enrollment code (PRD 15): `RBX1.<base64url("<url>#<token>")>`.
 * Only the SHA-256 of the token is stored. `convexUrl` overrides the
 * deployment URL that is otherwise read from `CONVEX_CLOUD_URL`.
 * `tokenId` is returned so the code can be revoked later.
 */
export const createEnrollmentCode = internalMutation({
  args: {
    orgId: v.id("organizations"),
    ttlMinutes: v.optional(v.number()),
    uses: v.optional(v.number()),
    groupId: v.optional(v.id("groups")),
    convexUrl: v.optional(v.string()),
  },
  returns: v.object({
    code: v.string(),
    expiresAt: v.number(),
    tokenId: v.id("enrollmentTokens"),
  }),
  handler: async (ctx, args) => {
    const ttlMinutes = args.ttlMinutes ?? 60;
    const uses = args.uses ?? 1;
    if (!(ttlMinutes > 0)) throw new Error("ttlMinutes must be greater than 0");
    if (!Number.isInteger(uses) || uses < 1) {
      throw new Error("uses must be a whole number of at least 1");
    }
    const org = await ctx.db.get(args.orgId);
    if (org === null) throw new Error(`No such organization: ${args.orgId}`);
    if (args.groupId !== undefined) {
      const group = await ctx.db.get(args.groupId);
      if (group === null || group.orgId !== args.orgId) {
        throw new Error(`Group ${args.groupId} is not in this organization`);
      }
    }

    const convexUrl = args.convexUrl ?? env.CONVEX_CLOUD_URL;
    if (!convexUrl) {
      throw new Error(
        "CONVEX_CLOUD_URL is not set in this deployment; pass convexUrl",
      );
    }
    assertAgentAcceptableUrl(convexUrl);

    const token = generateToken();
    const now = Date.now();
    const expiresAt = now + Math.round(ttlMinutes * 60_000);
    const tokenId = await ctx.db.insert("enrollmentTokens", {
      orgId: args.orgId,
      tokenHash: await sha256Hex(token),
      expiresAt,
      usesLeft: uses,
      groupId: args.groupId,
      createdAt: now,
    });

    // No `usesTotal`: a dev code is not counted in `activeEnrollmentCodes`.
    const code = formatEnrollmentCode(convexUrl, token);
    return { code, expiresAt, tokenId };
  },
});

type Doc = Record<string, unknown>;

/**
 * A full, valid DesiredState with empty lists (PRD Section 10 shape).
 * `kioskEnabled` matches the agent's enrollment default, so a helper that only
 * touches another key (setAdminExit) does not switch kiosk off by accident.
 */
function emptyDesiredDoc(): Doc {
  return {
    kioskEnabled: true,
    apps: [],
    allowedSites: [],
    fileHandlers: {},
    storage: { defaultQuotaGb: 0 },
    branding: { name: "Rulebox" },
    version: 0,
  };
}

/**
 * Insert the next desired-state version for a device. Starts from the
 * previous document of that device scope (so keys such as `adminExit`,
 * `power` and `orgName` survive), or an empty one, applies `change`, and
 * writes `version = previous + 1` (1 for the first row) both on the row and
 * inside the document.
 */
async function writeNextDesiredState(
  ctx: MutationCtx,
  deviceId: Id<"devices">,
  change: (doc: Doc) => void,
): Promise<{ version: number }> {
  const device = await ctx.db.get(deviceId);
  if (device === null) throw new Error(`No such device: ${deviceId}`);
  const previous = await ctx.db
    .query("desiredStates")
    .withIndex("by_scope_version", (q) => q.eq("scope", deviceId))
    .order("desc")
    .first();

  const doc: Doc =
    previous !== null &&
    typeof previous.doc === "object" &&
    previous.doc !== null &&
    !Array.isArray(previous.doc)
      ? { ...(previous.doc as Doc) }
      : emptyDesiredDoc();
  change(doc);
  const version = (previous?.version ?? 0) + 1;
  doc.version = version;

  await ctx.db.insert("desiredStates", {
    orgId: device.orgId,
    scope: deviceId,
    version,
    doc,
  });
  return { version };
}

/** Turn kiosk mode on or off for one device by writing a new version. */
export const setKiosk = internalMutation({
  args: { deviceId: v.id("devices"), enabled: v.boolean() },
  returns: v.object({ version: v.number() }),
  handler: async (ctx, args) => {
    return await writeNextDesiredState(ctx, args.deviceId, (doc) => {
      doc.kioskEnabled = args.enabled;
    });
  },
});

/**
 * Set the agent-only `adminExit` key of a device's desired state (protocol
 * 1.1, Phase 2 plan 5.10). The given fields are merged into the existing
 * `adminExit`; fields left out keep their value. `pinHash` is the line
 * printed by `rulebox-agent hash-pin`; `""` removes the PIN. `hotkey: ""`
 * removes a custom hotkey.
 */
export const setAdminExit = internalMutation({
  args: {
    deviceId: v.id("devices"),
    pinHash: v.optional(v.string()),
    enabled: v.optional(v.boolean()),
    hotkey: v.optional(v.string()),
  },
  returns: v.object({ version: v.number() }),
  handler: async (ctx, args) => {
    if (
      args.pinHash !== undefined &&
      args.pinHash !== "" &&
      !args.pinHash.startsWith("$argon2id$")
    ) {
      throw new Error(
        "pinHash must be the $argon2id$ line printed by `rulebox-agent hash-pin`",
      );
    }
    return await writeNextDesiredState(ctx, args.deviceId, (doc) => {
      const current =
        typeof doc.adminExit === "object" &&
        doc.adminExit !== null &&
        !Array.isArray(doc.adminExit)
          ? { ...(doc.adminExit as Doc) }
          : {};
      if (args.enabled !== undefined) current.enabled = args.enabled;
      if (args.hotkey !== undefined) {
        if (args.hotkey === "") delete current.hotkey;
        else current.hotkey = args.hotkey;
      }
      if (args.pinHash !== undefined) {
        if (args.pinHash === "") delete current.pinHash;
        else current.pinHash = args.pinHash;
      }
      doc.adminExit = current;
    });
  },
});

/** Revoke a device from the backend side. Its subscription answers `revoked`. */
export const revokeDevice = internalMutation({
  args: { deviceId: v.id("devices") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const device = await ctx.db.get(args.deviceId);
    if (device === null) throw new Error(`No such device: ${args.deviceId}`);
    if (device.revoked) return null;
    await ctx.db.patch(args.deviceId, { revoked: true });
    // `deviceCount` counts non-revoked devices (plan 4.2.1, A7).
    await bumpOrgStatsIfPresent(ctx, device.orgId, { deviceCount: -1 });
    return null;
  },
});

/** Revoke an enrollment token so its code can no longer be used. */
export const revokeEnrollmentToken = internalMutation({
  args: { tokenId: v.id("enrollmentTokens") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const token = await ctx.db.get(args.tokenId);
    if (token === null) throw new Error(`No such token: ${args.tokenId}`);
    if (token.revoked === true) return null;
    await ctx.db.patch(args.tokenId, { revoked: true });
    if (countsAsActive(token, Date.now())) {
      await bumpOrgStatsIfPresent(ctx, token.orgId, { activeEnrollmentCodes: -1 });
    }
    return null;
  },
});
