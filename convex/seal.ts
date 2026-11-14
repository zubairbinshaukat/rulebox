import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalAction } from "./_generated/server";
import { base64Encode } from "./lib/crypto";
import { internalMutation, internalQuery } from "./lib/functions";
import { openWrappedRow } from "./lib/keyring";
import { MAX_DEVICE_WIFI, MAX_WIFI_PROFILES, SEAL_DEVICES_PER_RUN } from "./lib/limits";
import { atRestBox } from "./lib/lockdownValidators";
import { requestPublish } from "./lib/publish";
import { decryptAtRest, sealForDevice } from "./lib/sealbox";

// Per-device sealing of Wi-Fi passphrases (Phase 5 Step 10, plan 4.18). A passphrase lives at
// rest under the organization's sealing key (`wifiProfiles.passphrase`); for each device that
// has registered its X25519 public key (`deviceApi:registerSealKey`) it is opened HERE, in an
// action (sealing needs randomness), sealed for that one device and stored as a
// `deviceSealedSecrets` row, which the publisher puts into that device's signed document.
// Nothing in this file returns a passphrase, a key or a box; every function is internal.

const job = v.object({
  deviceId: v.id("devices"),
  publicKey: v.string(),
  sealKeyId: v.string(),
  profileId: v.id("wifiProfiles"),
  revision: v.number(),
  /** The revision the at-rest box was encrypted under (its AAD): `passphraseRev ?? revision` (Step 13). */
  atRestRevision: v.number(),
  atRest: atRestBox,
});

/**
 * What needs sealing among `deviceIds`: for each device with a sealing key, each Wi-Fi profile
 * assigned to its group that has a passphrase and no current box (same revision, same device
 * key). Also the organization's active sealing key (wrapped; only `seal:forDevices` opens it).
 * Internal: the answer holds ciphertexts, never shown to a client.
 */
export const jobs = internalQuery({
  args: { orgId: v.id("organizations"), deviceIds: v.array(v.id("devices")) },
  returns: v.object({
    sealing: v.union(v.object({ keyId: v.string(), wrapped: v.string(), masterKeyId: v.string() }), v.null()),
    jobs: v.array(job),
  }),
  handler: async (ctx, args) => {
    const sealing = await ctx.db
      .query("orgKeys")
      .withIndex("by_org_purpose_status", (q) => q.eq("orgId", args.orgId).eq("purpose", "sealing").eq("status", "active"))
      .first();
    if (sealing === null) return { sealing: null, jobs: [] };
    const profiles = await ctx.db
      .query("wifiProfiles")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .take(MAX_WIFI_PROFILES + 1);
    const withSecret = profiles.filter((p) => p.security !== "open" && p.passphrase !== undefined);
    const out: {
      deviceId: Id<"devices">;
      publicKey: string;
      sealKeyId: string;
      profileId: Id<"wifiProfiles">;
      revision: number;
      atRestRevision: number;
      atRest: { keyId: string; sealed: string };
    }[] = [];
    if (withSecret.length > 0) {
      for (const id of args.deviceIds.slice(0, SEAL_DEVICES_PER_RUN)) {
        const device = await ctx.db.get(id);
        if (device === null || device.orgId !== args.orgId || device.sealPublicKey === undefined || device.sealKeyId === undefined || device.groupId === undefined) continue;
        for (const p of withSecret) {
          if (!(p.groupIds as string[]).includes(device.groupId) || p.passphrase === undefined) continue;
          const have = await ctx.db
            .query("deviceSealedSecrets")
            .withIndex("by_device_target", (q) => q.eq("deviceId", device._id).eq("purpose", "wifi").eq("targetId", p._id))
            .first();
          if (have !== null && have.targetRevision === p.revision && have.sealKeyId === device.sealKeyId) continue;
          out.push({ deviceId: device._id, publicKey: device.sealPublicKey, sealKeyId: device.sealKeyId, profileId: p._id, revision: p.revision, atRestRevision: p.passphraseRev ?? p.revision, atRest: p.passphrase });
        }
      }
    }
    return { sealing: { keyId: sealing.keyId, wrapped: sealing.wrapped, masterKeyId: sealing.masterKeyId }, jobs: out };
  },
});

/**
 * Store boxes made by `forDevices`. A row is written only when it is still current: the device
 * still has the key it was sealed for and the profile is still at the sealed revision (else it
 * is dropped: a newer run will redo it). Replaces an older box of the same (device, profile).
 * Asks for a publish of the devices that got a box. Answers the number of boxes written.
 */
export const storeSealed = internalMutation({
  args: {
    orgId: v.id("organizations"),
    rows: v.array(v.object({ deviceId: v.id("devices"), profileId: v.id("wifiProfiles"), revision: v.number(), sealKeyId: v.string(), sealed: v.string() })),
  },
  returns: v.number(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const touched = new Set<Id<"devices">>();
    let written = 0;
    for (const r of args.rows.slice(0, SEAL_DEVICES_PER_RUN * MAX_DEVICE_WIFI)) {
      const device = await ctx.db.get(r.deviceId);
      const profile = await ctx.db.get(r.profileId);
      if (device === null || profile === null || device.orgId !== args.orgId || profile.orgId !== args.orgId) continue;
      if (device.sealKeyId !== r.sealKeyId || profile.revision !== r.revision) continue;
      const have = await ctx.db
        .query("deviceSealedSecrets")
        .withIndex("by_device_target", (q) => q.eq("deviceId", r.deviceId).eq("purpose", "wifi").eq("targetId", r.profileId))
        .first();
      const fields = { targetRevision: r.revision, sealKeyId: r.sealKeyId, sealed: r.sealed, createdAt: now };
      if (have === null) {
        await ctx.db.insert("deviceSealedSecrets", { orgId: args.orgId, deviceId: r.deviceId, purpose: "wifi", targetId: r.profileId, ...fields });
      } else {
        await ctx.db.patch(have._id, fields);
      }
      touched.add(r.deviceId);
      written++;
    }
    if (touched.size > 0) await requestPublish(ctx, args.orgId, { deviceIds: [...touched] });
    return written;
  },
});

/**
 * Seal the assigned Wi-Fi passphrases for up to SEAL_DEVICES_PER_RUN devices of an organization
 * and reschedule for the rest. Called when a device registers or replaces its sealing key
 * (`deviceApi:registerSealKey`) and, in later steps, when a passphrase or an assignment
 * changes. A missing master key or sealing key, or a passphrase that no longer opens, seals
 * nothing (the agent keeps reporting `waiting_for_key`); no secret ever reaches an error.
 */
export const forDevices = internalAction({
  args: { orgId: v.id("organizations"), deviceIds: v.array(v.id("devices")) },
  returns: v.object({ sealed: v.number(), skipped: v.number() }),
  handler: async (ctx, args): Promise<{ sealed: number; skipped: number }> => {
    const batch = args.deviceIds.slice(0, SEAL_DEVICES_PER_RUN);
    const rest = args.deviceIds.slice(SEAL_DEVICES_PER_RUN);
    if (rest.length > 0) await ctx.scheduler.runAfter(0, internal.seal.forDevices, { orgId: args.orgId, deviceIds: rest });
    const plan = await ctx.runQuery(internal.seal.jobs, { orgId: args.orgId, deviceIds: batch });
    if (plan.sealing === null || plan.jobs.length === 0) return { sealed: 0, skipped: 0 };
    const key = openWrappedRow(plan.sealing, args.orgId, "sealing");
    if (key === null) return { sealed: 0, skipped: plan.jobs.length };
    const rows = [];
    let skipped = 0;
    const plain = new Map<string, string | null>();
    for (const j of plan.jobs) {
      const k = `${j.profileId}:${j.atRestRevision}`;
      if (!plain.has(k)) plain.set(k, decryptAtRest(key, j.atRest, { orgId: args.orgId, profileId: j.profileId, revision: j.atRestRevision }));
      const passphrase = plain.get(k) ?? null;
      const box =
        passphrase === null ? null : sealForDevice(ctx, passphrase, j.publicKey, { orgId: args.orgId, deviceId: j.deviceId, profileId: j.profileId });
      if (box === null) {
        skipped++;
        continue;
      }
      rows.push({ deviceId: j.deviceId, profileId: j.profileId, revision: j.revision, sealKeyId: j.sealKeyId, sealed: base64Encode(new TextEncoder().encode(JSON.stringify(box))) });
    }
    const sealed = rows.length === 0 ? 0 : await ctx.runMutation(internal.seal.storeSealed, { orgId: args.orgId, rows });
    return { sealed, skipped };
  },
});
