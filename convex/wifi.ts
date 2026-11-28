import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { writeAudit } from "./lib/audit";
import { getInOrg } from "./lib/authz";
import { fail } from "./lib/errors";
import { internalMutation, internalQuery, memberAction } from "./lib/functions";
import { snapshotGroupsBatched } from "./lib/groupConfig";
import { openWrappedRow } from "./lib/keyring";
import { MAX_NETWORK_GROUPS, MAX_WIFI_PROFILES } from "./lib/limits";
import { atRestBox, wifiSecurity } from "./lib/lockdownValidators";
import { consumeOrFail } from "./lib/rateLimits";
import { encryptAtRest } from "./lib/sealbox";
import { checkSsid, checkWifiName } from "./networks";

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
    // Step 20b: the first groups now, the rest in scheduled batches (a passphrase change reaches every group of the profile).
    await snapshotGroupsBatched(ctx, p.groupIds, `Wi-Fi ${p.name}`, args.by);
    return { revision };
  },
});

// ---------------------------------------------------------------- create with the password (UI pass, enrollment plan 4.3)
//
// `createWithPassphrase` makes a SECURED network and stores its password in one call, so no PC ever sees a profile without its password
// and the groups are published ONCE (`saveWifi` + `setPassphrase` would snapshot every group twice). The order matters:
//   1. pure checks (no I/O), 2. `prepareCreate` (reads only: sealing key, profile cap, groups), the rate limit, the key is opened,
//   3. `insertDraft`: the profile with NO groups and no password (revision 1; no PC can receive it, nothing to snapshot),
//   4. the password is encrypted for revision 2, 5. `finishCreate`: compare-and-set on revision 1, the box, the groups, revision 2, ONE snapshot.
// A throw in 4 or 5 deletes the draft (`discardDraft`) and rethrows the original error; if even that fails the leftover has no groups and
// no password, so it is on no PC and the dashboard shows it as "Needs password / Not on any PCs yet" (deletable).
// The plaintext is only a local of the action: never logged, audited, stored, returned or put in an error.

/** What `createWithPassphrase` reads before it writes: the active sealing key (ciphertext only), the profile cap, the groups. */
export const prepareCreate = internalQuery({
  args: { orgId: v.id("organizations"), groupIds: v.array(v.string()) },
  returns: v.object({
    refusal: v.union(v.null(), v.literal("sealing_key"), v.literal("profiles"), v.literal("group")),
    groupIds: v.array(v.id("groups")),
    sealing: v.union(v.object({ keyId: v.string(), wrapped: v.string(), masterKeyId: v.string() }), v.null()),
  }),
  handler: async (ctx, args) => {
    const none = { groupIds: [] as Id<"groups">[], sealing: null };
    // The groups first: an id of another organization is `not_found` whatever else is wrong (and nothing else about it is revealed).
    const groupIds: Id<"groups">[] = [];
    for (const raw of args.groupIds) {
      const id = ctx.db.normalizeId("groups", raw);
      const g = id === null ? null : await ctx.db.get(id);
      if (g === null || g.orgId !== args.orgId) return { refusal: "group" as const, ...none };
      if (!groupIds.includes(g._id)) groupIds.push(g._id);
    }
    groupIds.sort();
    const existing = await ctx.db.query("wifiProfiles").withIndex("by_org", (q) => q.eq("orgId", args.orgId)).take(MAX_WIFI_PROFILES);
    if (existing.length >= MAX_WIFI_PROFILES) return { refusal: "profiles" as const, ...none };
    const key = await ctx.db
      .query("orgKeys")
      .withIndex("by_org_purpose_status", (q) => q.eq("orgId", args.orgId).eq("purpose", "sealing").eq("status", "active"))
      .first();
    if (key === null) return { refusal: "sealing_key" as const, ...none };
    return { refusal: null, groupIds, sealing: { keyId: key.keyId, wrapped: key.wrapped, masterKeyId: key.masterKeyId } };
  },
});

/** The draft: a secured profile in no group and without a password, revision 1. The cap is checked again (a parallel create may have won). */
export const insertDraft = internalMutation({
  args: {
    orgId: v.id("organizations"),
    actor: actorArg,
    name: v.string(),
    ssid: v.string(),
    hidden: v.boolean(),
    security: wifiSecurity,
    autoConnect: v.boolean(),
  },
  returns: v.id("wifiProfiles"),
  handler: async (ctx, args) => {
    if (args.security === "open") fail("invalid_argument", { field: "security", detail: "open" });
    const existing = await ctx.db.query("wifiProfiles").withIndex("by_org", (q) => q.eq("orgId", args.orgId)).take(MAX_WIFI_PROFILES);
    if (existing.length >= MAX_WIFI_PROFILES) fail("too_large", { detail: "wifi" });
    const id = await ctx.db.insert("wifiProfiles", {
      orgId: args.orgId,
      name: args.name,
      ssid: args.ssid,
      hidden: args.hidden,
      security: args.security,
      autoConnect: args.autoConnect,
      groupIds: [],
      revision: 1,
      createdAt: Date.now(),
    });
    await writeAudit(ctx, {
      orgId: args.orgId,
      actor: args.actor,
      action: "wifi.created",
      targetType: "wifi",
      targetId: id,
      targetLabel: args.name,
      summary: `Added the Wi-Fi network ${args.name}`,
    });
    return id;
  },
});

/**
 * Completes the draft: compare-and-set on revision 1 (still no groups, no password), stores the box (encrypted for revision 2), puts
 * the profile in its groups and takes ONE snapshot, so the PCs get the network with its password in a single configuration version.
 */
export const finishCreate = internalMutation({
  args: {
    orgId: v.id("organizations"),
    actor: actorArg,
    by: v.id("members"),
    id: v.id("wifiProfiles"),
    groupIds: v.array(v.id("groups")),
    atRest: atRestBox,
  },
  returns: v.object({ revision: v.number() }),
  handler: async (ctx, args) => {
    const p = await getInOrg(ctx, "wifiProfiles", args.id, args.orgId);
    if (p.revision !== 1 || p.groupIds.length > 0 || p.passphrase !== undefined) fail("stale_edit");
    for (const groupId of args.groupIds) await getInOrg(ctx, "groups", groupId, args.orgId);
    const groupIds = [...new Set(args.groupIds)].sort();
    await ctx.db.patch(p._id, { passphrase: args.atRest, passphraseRev: 2, passphraseSetAt: Date.now(), groupIds, revision: 2 });
    await writeAudit(ctx, {
      orgId: args.orgId,
      actor: args.actor,
      action: "wifi.passphraseSet",
      targetType: "wifi",
      targetId: p._id,
      targetLabel: p.name,
      summary: `Set a new passphrase for the Wi-Fi network ${p.name}`,
    });
    await snapshotGroupsBatched(ctx, groupIds, `Wi-Fi ${p.name}`, args.by);
    return { revision: 2 };
  },
});

/**
 * Deletes a draft whose password could not be stored. Only a profile that is still exactly the draft (revision 1, no groups, no
 * password) is deleted; anything else is left alone. Returns whether it deleted. Nothing was published for a draft, so no snapshot.
 */
export const discardDraft = internalMutation({
  args: { orgId: v.id("organizations"), actor: actorArg, id: v.id("wifiProfiles") },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const p = await ctx.db.get(args.id);
    if (p === null || p.orgId !== args.orgId) return false;
    if (p.revision !== 1 || p.groupIds.length > 0 || p.passphrase !== undefined) return false;
    await ctx.db.delete(p._id);
    await writeAudit(ctx, {
      orgId: args.orgId,
      actor: args.actor,
      action: "wifi.deleted",
      targetType: "wifi",
      targetId: p._id,
      targetLabel: p.name,
      summary: `Removed the Wi-Fi network ${p.name} because its password could not be saved`,
    });
    return true;
  },
});

/**
 * Create a secured Wi-Fi network together with its password (admin; unlocked session; an action). Same checks as `networks:saveWifi`
 * (name, SSID, at most MAX_NETWORK_GROUPS groups) and `wifi:setPassphrase` (the password); `security` "open" is `invalid_argument`
 * (field "security", detail "open": an open network has no password, so the form calls `saveWifi`). Errors: `invalid_argument` (field
 * name | ssid | groupIds | passphrase | security), `not_found` (a group of another organization), `too_large` (detail "wifi" = 50 profiles),
 * `not_ready` (detail "sealing_key"), `rate_limited` (shares `setPassphrase`'s bucket, 30 per hour per organization). Nothing is written
 * before every check passed; a failure after the draft was made deletes the draft. Returns the new profile's id and revision (2).
 */
export const createWithPassphrase = memberAction("admin")({
  args: {
    name: v.string(),
    ssid: v.string(),
    hidden: v.boolean(),
    security: wifiSecurity,
    autoConnect: v.boolean(),
    groupIds: v.array(v.string()),
    passphrase: v.string(),
  },
  returns: v.object({ id: v.id("wifiProfiles"), revision: v.number() }),
  handler: async (ctx, args): Promise<{ id: Id<"wifiProfiles">; revision: number }> => {
    const name = checkWifiName(args.name);
    const ssid = checkSsid(args.ssid);
    if (args.security === "open") fail("invalid_argument", { field: "security", detail: "open" });
    if (args.groupIds.length > MAX_NETWORK_GROUPS) fail("invalid_argument", { field: "groupIds", detail: "too_many" });
    checkPassphrase(args.passphrase);

    const prep = await ctx.runQuery(internal.wifi.prepareCreate, { orgId: ctx.orgId, groupIds: args.groupIds });
    if (prep.refusal === "group") fail("not_found");
    if (prep.refusal === "profiles") fail("too_large", { detail: "wifi" });
    if (prep.refusal === "sealing_key" || prep.sealing === null) fail("not_ready", { detail: "sealing_key" });
    await consumeOrFail(ctx, "wifiPassphrase", ctx.orgId);
    const key = openWrappedRow(prep.sealing, ctx.orgId, "sealing");
    if (key === null) fail("not_ready", { detail: "sealing_key" });

    const id = await ctx.runMutation(internal.wifi.insertDraft, {
      orgId: ctx.orgId,
      actor: ctx.actor,
      name,
      ssid,
      hidden: args.hidden,
      security: args.security,
      autoConnect: args.autoConnect,
    });
    try {
      const atRest = encryptAtRest(ctx, key, args.passphrase, { orgId: ctx.orgId, profileId: id, revision: 2 });
      return {
        id,
        ...(await ctx.runMutation(internal.wifi.finishCreate, { orgId: ctx.orgId, actor: ctx.actor, by: ctx.member._id, id, groupIds: prep.groupIds, atRest })),
      };
    } catch (error) {
      try {
        await ctx.runMutation(internal.wifi.discardDraft, { orgId: ctx.orgId, actor: ctx.actor, id });
      } catch {
        // The leftover draft has no groups and no password: on no PC, shown as "Needs password", deletable.
      }
      throw error;
    }
  },
});
