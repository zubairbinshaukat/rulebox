import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { writeAudit } from "./lib/audit";
import { getInOrg } from "./lib/authz";
import { fail } from "./lib/errors";
import { internalMutation, internalQuery, memberAction } from "./lib/functions";
import { snapshotGroupConfig } from "./lib/groupConfig";
import { openWrappedRow } from "./lib/keyring";
import { MAX_NETWORK_SNAPSHOT_GROUPS } from "./lib/limits";
import { atRestBox } from "./lib/lockdownValidators";
import { consumeOrFail } from "./lib/rateLimits";
import { encryptAtRest } from "./lib/sealbox";

// `wifi:setPassphrase` (Phase 5 Step 13, plan 4.15, 4.18): the ONLY way a Wi-Fi passphrase enters the system.
// An action, because the encryption needs randomness. The passphrase is encrypted under the organization's
// sealing key (AAD = orgId|profileId|revision, see `passphraseRev` in the schema) and stored as `{ keyId, sealed }`.
// Nothing here logs, audits, stores or returns the plaintext, and no error message carries it. The per-device
// boxes are made later by `seal:forDevices`, which the publisher schedules (publish.ts).

const actorArg = v.object({ type: v.literal("member"), id: v.string(), label: v.string() });

/** 8-63 printable ASCII characters, or exactly 64 hexadecimal digits (WPA2 pre-shared key). */
export function checkPassphrase(passphrase: string): void {
  if (passphrase.length === 64) {
    if (!/^[0-9a-fA-F]{64}$/.test(passphrase)) fail("invalid_argument", { field: "passphrase", detail: "characters" });
    return;
  }
  if (passphrase.length < 8 || passphrase.length > 63) fail("invalid_argument", { field: "passphrase", detail: "length" });
  if (!/^[\x20-\x7e]+$/.test(passphrase)) fail("invalid_argument", { field: "passphrase", detail: "characters" });
}

/** What `setPassphrase` needs about the profile: its revision and security, and the wrapped sealing key (ciphertext only). */
export const target = internalQuery({
  args: { orgId: v.id("organizations"), id: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      id: v.id("wifiProfiles"),
      revision: v.number(),
      open: v.boolean(),
      sealing: v.union(v.object({ keyId: v.string(), wrapped: v.string(), masterKeyId: v.string() }), v.null()),
    }),
  ),
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("wifiProfiles", args.id);
    const p = id === null ? null : await ctx.db.get(id);
    if (p === null || p.orgId !== args.orgId) return null;
    const key = await ctx.db
      .query("orgKeys")
      .withIndex("by_org_purpose_status", (q) => q.eq("orgId", args.orgId).eq("purpose", "sealing").eq("status", "active"))
      .first();
    return {
      id: p._id,
      revision: p.revision,
      open: p.security === "open",
      sealing: key === null ? null : { keyId: key.keyId, wrapped: key.wrapped, masterKeyId: key.masterKeyId },
    };
  },
});

/**
 * Set or replace a profile's passphrase (admin; unlocked session; an action). `expectedRevision` is the revision
 * the form loaded (`stale_edit`). `invalid_argument` field "passphrase" (detail "length" / "characters"), or field
 * "id" detail "open" for an open network; `not_ready` (detail "sealing_key") when the organization has no usable
 * sealing key; 30 per hour per organization (`rate_limited`). Bumps the revision, so every device re-seals and
 * re-applies the profile. The passphrase is never returned, logged or audited.
 */
export const setPassphrase = memberAction("admin")({
  args: { id: v.string(), passphrase: v.string(), expectedRevision: v.number() },
  returns: v.object({ revision: v.number() }),
  handler: async (ctx, args): Promise<{ revision: number }> => {
    const t = await ctx.runQuery(internal.wifi.target, { orgId: ctx.orgId, id: args.id });
    if (t === null) fail("not_found");
    checkPassphrase(args.passphrase);
    if (t.revision !== args.expectedRevision) fail("stale_edit");
    if (t.open) fail("invalid_argument", { field: "id", detail: "open" });
    if (t.sealing === null) fail("not_ready", { detail: "sealing_key" });
    await consumeOrFail(ctx, "wifiPassphrase", ctx.orgId);
    const key = openWrappedRow(t.sealing, ctx.orgId, "sealing");
    if (key === null) fail("not_ready", { detail: "sealing_key" });
    const revision = t.revision + 1;
    const atRest = encryptAtRest(ctx, key, args.passphrase, { orgId: ctx.orgId, profileId: t.id, revision });
    return await ctx.runMutation(internal.wifi.storePassphrase, {
      orgId: ctx.orgId,
      actor: ctx.actor,
      by: ctx.member._id,
      id: t.id,
      expectedRevision: t.revision,
      atRest,
    });
  },
});

/** The single writer of `wifiProfiles.passphrase`. Compare-and-set on the revision the box was encrypted for. */
export const storePassphrase = internalMutation({
  args: { orgId: v.id("organizations"), actor: actorArg, by: v.id("members"), id: v.id("wifiProfiles"), expectedRevision: v.number(), atRest: atRestBox },
  returns: v.object({ revision: v.number() }),
  handler: async (ctx, args) => {
    const p = await getInOrg(ctx, "wifiProfiles", args.id, args.orgId);
    if (p.revision !== args.expectedRevision) fail("stale_edit");
    if (p.security === "open") fail("invalid_argument", { field: "id", detail: "open" });
    if (p.groupIds.length > MAX_NETWORK_SNAPSHOT_GROUPS) fail("too_large", { detail: "groups" });
    const revision = p.revision + 1;
    await ctx.db.patch(p._id, { passphrase: args.atRest, passphraseRev: revision, passphraseSetAt: Date.now(), revision });
    await writeAudit(ctx, {
      orgId: args.orgId,
      actor: args.actor,
      action: "wifi.passphraseSet",
      targetType: "wifi",
      targetId: p._id,
      targetLabel: p.name,
      summary: `Set a new passphrase for the Wi-Fi network ${p.name}`,
    });
    for (const gid of p.groupIds as Id<"groups">[]) {
      if ((await ctx.db.get(gid)) === null) continue;
      await snapshotGroupConfig(ctx, gid, `Wi-Fi ${p.name}`, args.by);
    }
    return { revision };
  },
});
