import { bytesToHex } from "@noble/hashes/utils.js";
import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, type DatabaseReader, type DatabaseWriter } from "./_generated/server";
import { SYSTEM_ACTOR, writeAudit } from "./lib/audit";
import { randomBytes } from "./lib/crypto";
import { scheduleRosterResync } from "./lib/employeeSync";
import { fail } from "./lib/errors";
import { internalMutation, internalQuery, memberAction, memberMutation, memberQuery, type AuditActorCtx } from "./lib/functions";
import { masterKeyAvailable, masterKeyIds, rewrapSecret, wrapSecret, type KeyBinding } from "./lib/keyring";
import { MAX_TRUST_PAGE, REWRAP_BATCH } from "./lib/limits";
import { orgKeyPurpose } from "./lib/lockdownValidators";
import { orgPolicyKeys } from "./lib/policyKeys";
import { requestPublish } from "./lib/publish";
import {
  endorsementMessage,
  envPublicKey,
  fingerprintOf,
  keyFromSeed,
  loadOrgSigningKey,
  signWith,
  withEnvSigningSeed,
} from "./lib/signing";
import { policyKeyStatus } from "./lib/validators";

// Settings -> Signing (plan 4.5, Step 8 item 6). The private seeds live ONLY
// in the deployment's environment (`RULEBOX_POLICY_KEY`, `_NEXT`), set by the
// Owner with the CLI; this module registers their PUBLIC halves per
// organization and never sees a seed: `lib/signing.ts` derives the public key
// and signs the rotation endorsement. Nothing returned here is secret.
//
// The three writes are major actions (fresh step-up, plan 4.16) for the Owner.

const keyRow = v.object({
  keyId: v.string(),
  fingerprint: v.string(),
  publicKey: v.string(),
  status: policyKeyStatus,
  endorsedBy: v.union(v.string(), v.null()),
  createdAt: v.number(),
});

const envKey = v.union(v.object({ keyId: v.string(), fingerprint: v.string() }), v.null());

function rowOf(r: Doc<"policyKeys">) {
  return {
    keyId: r.keyId,
    fingerprint: fingerprintOf(r.keyId),
    publicKey: r.publicKey,
    status: r.status,
    endorsedBy: r.endorsement?.byKeyId ?? null,
    createdAt: r.createdAt,
  };
}

function envKeyOf(which: "active" | "next") {
  const k = envPublicKey(which);
  return k === null ? null : { keyId: k.keyId, fingerprint: fingerprintOf(k.keyId) };
}

/**
 * The organization's keys and whether publishing works (viewer). `signing`:
 * "ok" when the deployment's active seed is this organization's active key,
 * "missing" without a (valid) seed, "mismatch" when the seed is another key.
 * `env` shows which keys the deployment holds (key ids only), so the page can
 * tell the Owner what to do next. Re-runs when a key row or the counters row
 * changes.
 */
export const status = memberQuery("viewer")({
  args: {},
  returns: v.object({
    keys: v.array(keyRow),
    signing: v.union(v.literal("ok"), v.literal("missing"), v.literal("mismatch")),
    env: v.object({ active: envKey, next: envKey }),
    publishFailedAt: v.union(v.number(), v.null()),
    /**
     * Some disabled employees' removals could not be signed yet (no usable key):
     * their offline sign-in on the group's PCs lasts until the key is back
     * (Step 11 review item 14; Step 17 follow-up). One `rosterPending.by_org` read.
     */
    rosterPending: v.boolean(),
    /**
     * Phase 5 Step 10 (plan 4.18, 4.20): this organization's OWN keys. `master`: the
     * deployment has a usable master key. `signing` / `sealing`: ids and where the signing
     * key came from ("env" = moved from the deployment key by `migrateFromEnv`), never any
     * key material. `locked`: the organization has keys but this deployment cannot open them.
     */
    orgKeys: v.object({
      master: v.boolean(),
      signing: v.union(v.object({ keyId: v.string(), fingerprint: v.string(), origin: v.union(v.literal("env"), v.literal("generated")) }), v.null()),
      sealing: v.union(v.object({ keyId: v.string() }), v.null()),
      locked: v.boolean(),
    }),
  }),
  handler: async (ctx) => {
    const rows = await orgPolicyKeys(ctx, ctx.orgId);
    const signing = await loadOrgSigningKey(ctx, ctx.orgId, "active");
    const stats = await ctx.db
      .query("orgStats")
      .withIndex("by_org", (q) => q.eq("orgId", ctx.orgId))
      .unique();
    const pending = await ctx.db
      .query("rosterPending")
      .withIndex("by_org", (q) => q.eq("orgId", ctx.orgId))
      .first();
    const ownSigning = await activeOrgKeyRow(ctx, ctx.orgId, "signing");
    const ownSealing = await activeOrgKeyRow(ctx, ctx.orgId, "sealing");
    return {
      keys: rows.map(rowOf),
      signing: signing.ok ? ("ok" as const) : signing.reason,
      env: { active: envKeyOf("active"), next: envKeyOf("next") },
      publishFailedAt: stats?.publishFailedAt ?? null,
      rosterPending: pending !== null,
      orgKeys: {
        master: masterKeyAvailable(),
        signing:
          ownSigning === null
            ? null
            : { keyId: ownSigning.keyId, fingerprint: fingerprintOf(ownSigning.keyId), origin: ownSigning.origin ?? ("generated" as const) },
        sealing: ownSealing === null ? null : { keyId: ownSealing.keyId },
        locked: (ownSigning !== null || ownSealing !== null) && !masterKeyAvailable(),
      },
    };
  },
});

/** The organization's active `orgKeys` row of `purpose` (1 read). The row holds the wrapped key: callers return only ids. */
async function activeOrgKeyRow(ctx: { db: DatabaseReader }, orgId: Id<"organizations">, purpose: "signing" | "sealing") {
  return await ctx.db
    .query("orgKeys")
    .withIndex("by_org_purpose_status", (q) => q.eq("orgId", orgId).eq("purpose", purpose).eq("status", "active"))
    .first();
}

/** Refuse the Phase 4 env-key functions for an organization whose keys live in the keyring. */
async function refuseWhenKeyringOwns(ctx: { db: DatabaseWriter }, orgId: Id<"organizations">): Promise<void> {
  if ((await activeOrgKeyRow(ctx, orgId, "signing")) !== null) fail("conflict", { detail: "org_keys" });
}

/**
 * "N of M devices trust the new key" (viewer), one page of up to
 * MAX_TRUST_PAGE devices (`devices.by_org`) joined with their presence
 * (revoked devices are not counted) and summary (`trustedKeyIds`; the report
 * only for a summary written before that field existed). The Signing
 * tab loads the pages one after another and sums them, only while a `next`
 * key exists.
 */
export const trustProgress = memberQuery("viewer")({
  args: { paginationOpts: paginationOptsValidator },
  returns: v.object({
    page: v.object({ total: v.number(), trustNext: v.number() }),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, args) => {
    const n = args.paginationOpts.numItems;
    if (!Number.isInteger(n) || n < 1 || n > MAX_TRUST_PAGE) fail("invalid_argument", { field: "paginationOpts" });
    const next = await ctx.db
      .query("policyKeys")
      .withIndex("by_org_status", (q) => q.eq("orgId", ctx.orgId).eq("status", "next"))
      .first();
    const result = await ctx.db
      .query("devices")
      .withIndex("by_org", (q) => q.eq("orgId", ctx.orgId))
      .paginate(args.paginationOpts);
    let total = 0;
    let trustNext = 0;
    for (const d of result.page) {
      const presence = await ctx.db
        .query("devicePresence")
        .withIndex("by_device", (q) => q.eq("deviceId", d._id))
        .unique();
      if (presence?.revoked === true || (presence === null && d.revoked === true)) continue;
      total++;
      if (next === null) continue;
      // The small summary row carries `trustedKeyIds` (Step 17 follow-up); a summary
      // written before that field existed falls back to the report once.
      const summary = await ctx.db
        .query("deviceSummary")
        .withIndex("by_device", (q) => q.eq("deviceId", d._id))
        .unique();
      let trusted = summary?.trustedKeyIds;
      if (trusted === undefined) {
        const report = await ctx.db
          .query("deviceReports")
          .withIndex("by_device", (q) => q.eq("deviceId", d._id))
          .unique();
        trusted = report?.trustedKeyIds;
      }
      if (trusted?.includes(next.keyId) === true) trustNext++;
    }
    return { page: { total, trustNext }, isDone: result.isDone, continueCursor: result.continueCursor };
  },
});

async function keyRowById(ctx: { db: DatabaseWriter }, orgId: Id<"organizations">, keyId: string) {
  return await ctx.db
    .query("policyKeys")
    .withIndex("by_org_key_id", (q) => q.eq("orgId", orgId).eq("keyId", keyId))
    .first();
}

async function audit(
  ctx: { db: DatabaseWriter },
  orgId: Id<"organizations">,
  actor: AuditActorCtx,
  action: "policy.keyRegistered" | "policy.rotationPrepared" | "policy.rotationFinished" | "org.keysCreated",
  summary: string,
) {
  await writeAudit(ctx, { orgId, actor, action, targetType: "organization", targetId: orgId, summary });
}

/**
 * Register the deployment's active seed (`RULEBOX_POLICY_KEY`) as this
 * organization's active key (Owner, major) and republish every device.
 *
 * - No (valid) seed: `not_ready`.
 * - The organization already has that key id: `conflict` (detail "key_exists"),
 *   except when it is the active key and no `force`: then this is the retry
 *   after a failed publish (restored seed) and just publishes every device
 *   again, registering nothing.
 * - An active key exists: `conflict` unless `force` ("key lost", plan 4.5):
 *   the old active key is retired and the new one becomes active. Devices do
 *   NOT trust it (nothing endorses it): they need re-enrollment or
 *   `rulebox-agent trust-key`. `force` is refused when the active row is
 *   already the env key.
 *
 * A mutation, not the plan's action: it signs nothing and reads no network,
 * and one transaction cannot register a key that changed in between.
 */
export const registerActive = memberMutation("owner", { major: "keys:registerActive" })({
  args: { force: v.optional(v.boolean()) },
  returns: v.object({ keyId: v.string(), fingerprint: v.string() }),
  handler: async (ctx, args) => {
    await refuseWhenKeyringOwns(ctx, ctx.orgId);
    const env = envPublicKey("active");
    if (env === null) fail("not_ready", { detail: "RULEBOX_POLICY_KEY is not set or not 32 bytes of base64" });
    const known = await keyRowById(ctx, ctx.orgId, env.keyId);
    if (known !== null) {
      // Retry path: the env key IS the active key (the Owner restored the seed
      // after a failed publish, which kept no schedule). Nothing to register;
      // publish every device again. `force` and any other status stay a conflict.
      if (args.force !== true && known.status === "active" && known.publicKey === env.publicKey) {
        await requestPublish(ctx, ctx.orgId, { allDevices: true });
        await scheduleRosterResync(ctx, ctx.orgId); // removals queued while the key was missing
        return { keyId: env.keyId, fingerprint: fingerprintOf(env.keyId) };
      }
      fail("conflict", { detail: "key_exists" });
    }
    const rows = await orgPolicyKeys(ctx, ctx.orgId);
    const active = rows.filter((r) => r.status === "active");
    if (active.length > 0 && args.force !== true) fail("conflict", { detail: "an active key exists" });
    const now = Date.now();
    for (const r of active) await ctx.db.patch(r._id, { status: "retired" });
    // A prepared rotation endorsed by a lost key is void too.
    for (const r of rows.filter((r) => r.status === "next")) await ctx.db.patch(r._id, { status: "retired" });
    await ctx.db.insert("policyKeys", {
      orgId: ctx.orgId,
      keyId: env.keyId,
      publicKey: env.publicKey,
      status: "active",
      createdAt: now,
    });
    await audit(
      ctx,
      ctx.orgId,
      ctx.actor,
      "policy.keyRegistered",
      active.length > 0
        ? `Replaced the lost signing key with the key ${fingerprintOf(env.keyId)}`
        : `Registered the signing key ${fingerprintOf(env.keyId)}`,
    );
    await requestPublish(ctx, ctx.orgId, { allDevices: true });
    await scheduleRosterResync(ctx, ctx.orgId);
    return { keyId: env.keyId, fingerprint: fingerprintOf(env.keyId) };
  },
});

/**
 * Rotation step 2 (Owner, major): register `RULEBOX_POLICY_KEY_NEXT` as the
 * `next` key, endorsed by the active key (it signs
 * "rulebox.key-endorsement/1\n<orgId>\n<nextKeyId>\n<nextPublicKey>"). Devices that
 * trust the active key learn the next one from their subscription. No
 * republish: documents stay signed by the active key until `finishRotation`.
 */
export const prepareRotation = memberMutation("owner", { major: "keys:prepareRotation" })({
  args: {},
  returns: v.object({ keyId: v.string(), fingerprint: v.string() }),
  handler: async (ctx) => {
    await refuseWhenKeyringOwns(ctx, ctx.orgId);
    const signer = await loadOrgSigningKey(ctx, ctx.orgId, "active");
    if (!signer.ok) fail("not_ready", { detail: `active signing key ${signer.reason}` });
    const next = envPublicKey("next");
    if (next === null) fail("not_ready", { detail: "RULEBOX_POLICY_KEY_NEXT is not set or not 32 bytes of base64" });
    if (next.keyId === signer.key.keyId) fail("invalid_argument", { detail: "the next key equals the active key" });
    if ((await keyRowById(ctx, ctx.orgId, next.keyId)) !== null) fail("conflict", { detail: "key_exists" });
    const pending = await ctx.db
      .query("policyKeys")
      .withIndex("by_org_status", (q) => q.eq("orgId", ctx.orgId).eq("status", "next"))
      .first();
    if (pending !== null) fail("conflict", { detail: "a rotation is already prepared" });
    await ctx.db.insert("policyKeys", {
      orgId: ctx.orgId,
      keyId: next.keyId,
      publicKey: next.publicKey,
      status: "next",
      endorsement: {
        byKeyId: signer.key.keyId,
        signature: signWith(signer.key, endorsementMessage(ctx.orgId, next.keyId, next.publicKey)),
      },
      createdAt: Date.now(),
    });
    await audit(ctx, ctx.orgId, ctx.actor, "policy.rotationPrepared", `Prepared a rotation to the signing key ${fingerprintOf(next.keyId)}`);
    return { keyId: next.keyId, fingerprint: fingerprintOf(next.keyId) };
  },
});

/**
 * Rotation step 4 (Owner, major), after the Owner moved the next seed into
 * `RULEBOX_POLICY_KEY`: checks that the env key now IS the `next` row, retires
 * the old active key, makes the next key active and republishes every device
 * (re-signed with the new key; agents then drop the retired key, Step 9).
 */
export const finishRotation = memberMutation("owner", { major: "keys:finishRotation" })({
  args: {},
  returns: v.object({ keyId: v.string(), fingerprint: v.string() }),
  handler: async (ctx) => {
    await refuseWhenKeyringOwns(ctx, ctx.orgId);
    const rows = await orgPolicyKeys(ctx, ctx.orgId);
    const next = rows.find((r) => r.status === "next");
    if (next === undefined) fail("conflict", { detail: "no rotation prepared" });
    const env = envPublicKey("active");
    if (env === null || env.keyId !== next.keyId || env.publicKey !== next.publicKey) {
      fail("not_ready", { detail: "RULEBOX_POLICY_KEY is not the prepared next key yet" });
    }
    for (const r of rows.filter((r) => r.status === "active")) await ctx.db.patch(r._id, { status: "retired" });
    await ctx.db.patch(next._id, { status: "active" });
    await audit(ctx, ctx.orgId, ctx.actor, "policy.rotationFinished", `Finished the rotation to the signing key ${fingerprintOf(next.keyId)}`);
    await requestPublish(ctx, ctx.orgId, { allDevices: true });
    await scheduleRosterResync(ctx, ctx.orgId);
    return { keyId: next.keyId, fingerprint: fingerprintOf(next.keyId) };
  },
});

// ---------------------------------------------------------------- per-organization keys (Phase 5 Step 10, plan 4.18)

const actorValue = v.object({ type: v.literal("member"), id: v.string(), label: v.string() });
const wrappedKey = v.object({ keyId: v.string(), wrapped: v.string(), masterKeyId: v.string() });

/** A random 16-hex key id for a symmetric key (signing keys use the id of their public key). */
function randomKeyId(ctx: { runAction: unknown }): string {
  return bytesToHex(randomBytes(ctx, 8));
}

function bindingOf(orgId: Id<"organizations">, purpose: "signing" | "sealing", keyId: string): KeyBinding {
  return { orgId, purpose, keyId };
}

/**
 * Create the organization's own keys (Ed25519 signing seed + 32-byte sealing key), wrapped
 * by the master key (action: the seed and the nonces need real randomness). Internal: the
 * owner bootstrap (`setup:createOwnerInvite`) and the operator call it. An organization that
 * already has an active signing key in `policyKeys` (a Phase 4 organization) keeps it and
 * gets only the sealing key: `migrateFromEnv` moves the signing key. Idempotent.
 */
export const createOrgKeys = internalAction({
  args: { orgId: v.id("organizations") },
  returns: v.object({ signing: v.string(), sealing: v.string() }),
  handler: async (ctx, args): Promise<{ signing: string; sealing: string }> => {
    if (!masterKeyAvailable()) return { signing: "no_master_key", sealing: "no_master_key" };
    const seed = randomBytes(ctx, 32);
    const signingKey = keyFromSeed(seed);
    const signing = wrapSecret(ctx, seed, bindingOf(args.orgId, "signing", signingKey.keyId));
    const sealKeyId = randomKeyId(ctx);
    const sealing = wrapSecret(ctx, randomBytes(ctx, 32), bindingOf(args.orgId, "sealing", sealKeyId));
    if (signing === null || sealing === null) return { signing: "no_master_key", sealing: "no_master_key" };
    return await ctx.runMutation(internal.keys.storeOrgKeys, {
      orgId: args.orgId,
      signing: { keyId: signingKey.keyId, publicKey: signingKey.publicKeyB64, ...signing },
      sealing: { keyId: sealKeyId, ...sealing },
    });
  },
});

export const storeOrgKeys = internalMutation({
  args: {
    orgId: v.id("organizations"),
    signing: v.object({ keyId: v.string(), publicKey: v.string(), wrapped: v.string(), masterKeyId: v.string() }),
    sealing: wrappedKey,
  },
  returns: v.object({ signing: v.string(), sealing: v.string() }),
  handler: async (ctx, args) => {
    const org = await ctx.db.get(args.orgId);
    if (org === null) fail("not_found");
    const now = Date.now();
    let signing = "exists";
    let sealing = "exists";
    if ((await activeOrgKeyRow(ctx, args.orgId, "signing")) === null) {
      const registered = await ctx.db
        .query("policyKeys")
        .withIndex("by_org_status", (q) => q.eq("orgId", args.orgId).eq("status", "active"))
        .first();
      if (registered !== null) {
        signing = "legacy";
      } else {
        const { publicKey, ...row } = args.signing;
        await ctx.db.insert("orgKeys", { orgId: args.orgId, purpose: "signing", status: "active", createdAt: now, ...row });
        await ctx.db.insert("policyKeys", { orgId: args.orgId, keyId: row.keyId, publicKey, status: "active", createdAt: now });
        signing = "created";
      }
    }
    if ((await activeOrgKeyRow(ctx, args.orgId, "sealing")) === null) {
      await ctx.db.insert("orgKeys", { orgId: args.orgId, purpose: "sealing", status: "active", createdAt: now, ...args.sealing });
      sealing = "created";
    }
    if (signing === "created" || sealing === "created") {
      await writeAudit(ctx, {
        orgId: args.orgId,
        actor: SYSTEM_ACTOR,
        action: "org.keysCreated",
        targetType: "organization",
        targetId: args.orgId,
        summary:
          signing === "created"
            ? `Created the organization's own signing key ${fingerprintOf(args.signing.keyId)} and sealing key`
            : "Created the organization's own sealing key",
      });
      if (signing === "created") await requestPublish(ctx, args.orgId, { allDevices: true });
    }
    return { signing, sealing };
  },
});

/**
 * Wrap the deployment's current signing seed (`RULEBOX_POLICY_KEY`) as THIS organization's
 * own signing key (Owner, major; once). The key id does not change, so no device is
 * re-enrolled and nothing is republished. Also creates the organization's sealing key.
 * `not_ready` without a usable master key or env seed; `conflict` when the env key is not
 * this organization's registered active key (`key_not_registered`) or the organization
 * already has its own keys (`already_migrated`).
 */
export const migrateFromEnv = memberAction("owner", { major: "keys:migrateFromEnv" })({
  args: {},
  returns: v.object({ keyId: v.string(), fingerprint: v.string() }),
  handler: async (ctx): Promise<{ keyId: string; fingerprint: string }> => {
    if (!masterKeyAvailable()) fail("not_ready", { detail: "RULEBOX_MASTER_KEY is not set or not 32 bytes of base64" });
    const signing = withEnvSigningSeed("active", (seedBytes, info) => {
      const w = wrapSecret(ctx, seedBytes, bindingOf(ctx.orgId, "signing", info.keyId));
      return w === null ? null : { keyId: info.keyId, publicKey: info.publicKey, ...w };
    });
    if (signing === null || signing === undefined) fail("not_ready", { detail: "RULEBOX_POLICY_KEY is not set or not 32 bytes of base64" });
    const sealKeyId = randomKeyId(ctx);
    const sealing = wrapSecret(ctx, randomBytes(ctx, 32), bindingOf(ctx.orgId, "sealing", sealKeyId));
    if (sealing === null) fail("not_ready", { detail: "RULEBOX_MASTER_KEY is not set or not 32 bytes of base64" });
    await ctx.runMutation(internal.keys.storeMigratedKey, {
      orgId: ctx.orgId,
      actor: ctx.actor,
      signing,
      sealing: { keyId: sealKeyId, ...sealing },
    });
    return { keyId: signing.keyId, fingerprint: fingerprintOf(signing.keyId) };
  },
});

export const storeMigratedKey = internalMutation({
  args: {
    orgId: v.id("organizations"),
    actor: actorValue,
    signing: v.object({ keyId: v.string(), publicKey: v.string(), wrapped: v.string(), masterKeyId: v.string() }),
    sealing: wrappedKey,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    if ((await activeOrgKeyRow(ctx, args.orgId, "signing")) !== null) fail("conflict", { detail: "already_migrated" });
    const registered = await ctx.db
      .query("policyKeys")
      .withIndex("by_org_key_id", (q) => q.eq("orgId", args.orgId).eq("keyId", args.signing.keyId))
      .first();
    if (registered === null || registered.status !== "active" || registered.publicKey !== args.signing.publicKey) {
      fail("conflict", { detail: "key_not_registered" });
    }
    const now = Date.now();
    const { publicKey: _publicKey, ...row } = args.signing;
    void _publicKey;
    await ctx.db.insert("orgKeys", { orgId: args.orgId, purpose: "signing", status: "active", origin: "env", createdAt: now, ...row });
    if ((await activeOrgKeyRow(ctx, args.orgId, "sealing")) === null) {
      await ctx.db.insert("orgKeys", { orgId: args.orgId, purpose: "sealing", status: "active", createdAt: now, ...args.sealing });
    }
    await audit(
      ctx,
      args.orgId,
      args.actor,
      "org.keysCreated",
      `Moved the signing key ${fingerprintOf(args.signing.keyId)} into the organization's own keys`,
    );
    return null;
  },
});

/** One batch of `orgKeys` rows still wrapped by `masterKeyId` (internal: the rows hold wrapped keys, never returned to a client). */
export const rewrapBatch = internalQuery({
  args: { masterKeyId: v.string() },
  returns: v.array(
    v.object({
      id: v.id("orgKeys"),
      orgId: v.id("organizations"),
      purpose: orgKeyPurpose,
      keyId: v.string(),
      wrapped: v.string(),
      masterKeyId: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("orgKeys")
      .withIndex("by_master_key", (q) => q.eq("masterKeyId", args.masterKeyId))
      .take(REWRAP_BATCH);
    return rows.map((r) => ({ id: r._id, orgId: r.orgId, purpose: r.purpose, keyId: r.keyId, wrapped: r.wrapped, masterKeyId: r.masterKeyId }));
  },
});

export const storeRewrapped = internalMutation({
  args: {
    updates: v.array(v.object({ id: v.id("orgKeys"), from: v.string(), wrapped: v.string(), masterKeyId: v.string() })),
  },
  returns: v.number(),
  handler: async (ctx, args) => {
    const orgs = new Set<Id<"organizations">>();
    let done = 0;
    for (const u of args.updates.slice(0, REWRAP_BATCH)) {
      const row = await ctx.db.get(u.id);
      // Compare-and-set: a row that changed meanwhile (or was already moved) is left alone.
      if (row === null || row.masterKeyId !== u.from) continue;
      await ctx.db.patch(row._id, { wrapped: u.wrapped, masterKeyId: u.masterKeyId });
      orgs.add(row.orgId);
      done++;
    }
    for (const orgId of orgs) {
      await writeAudit(ctx, {
        orgId,
        actor: SYSTEM_ACTOR,
        action: "org.keysRewrapped",
        targetType: "organization",
        targetId: orgId,
        summary: "Wrapped the organization's keys with the new deployment master key",
      });
    }
    return done;
  },
});

/**
 * Master key rotation (operator, rare; plan 4.18): with `RULEBOX_MASTER_KEY_NEXT` set,
 * re-wrap every `orgKeys` row that the active master key wraps, `REWRAP_BATCH` per run, and
 * reschedule while a run made progress. Then the operator swaps the two env values.
 * Rows that cannot be opened are counted in `failed` and left alone (a run with no
 * progress does not reschedule).
 */
export const rewrapAll = internalAction({
  args: {},
  returns: v.object({ rewrapped: v.number(), failed: v.number(), state: v.string() }),
  handler: async (ctx): Promise<{ rewrapped: number; failed: number; state: string }> => {
    const ids = masterKeyIds();
    if (ids.active === null || ids.next === null) return { rewrapped: 0, failed: 0, state: "no_next_key" };
    const rows = await ctx.runQuery(internal.keys.rewrapBatch, { masterKeyId: ids.active });
    const updates = [];
    let failed = 0;
    for (const r of rows) {
      const w = rewrapSecret(ctx, r, bindingOf(r.orgId, r.purpose, r.keyId));
      if (w === null) failed++;
      else updates.push({ id: r.id, from: r.masterKeyId, ...w });
    }
    const rewrapped = updates.length === 0 ? 0 : await ctx.runMutation(internal.keys.storeRewrapped, { updates });
    if (rows.length === REWRAP_BATCH && rewrapped > 0) await ctx.scheduler.runAfter(0, internal.keys.rewrapAll, {});
    return { rewrapped, failed, state: rows.length === 0 ? "done" : "ok" };
  },
});