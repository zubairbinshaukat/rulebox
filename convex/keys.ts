import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { DatabaseWriter } from "./_generated/server";
import { writeAudit } from "./lib/audit";
import { scheduleRosterResync } from "./lib/employeeSync";
import { fail } from "./lib/errors";
import { memberMutation, memberQuery, type AuditActorCtx } from "./lib/functions";
import { MAX_TRUST_PAGE } from "./lib/limits";
import { orgPolicyKeys } from "./lib/policyKeys";
import { requestPublish } from "./lib/publish";
import { endorsementMessage, envPublicKey, fingerprintOf, loadOrgSigningKey, signWith } from "./lib/signing";
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
  }),
  handler: async (ctx) => {
    const rows = await orgPolicyKeys(ctx, ctx.orgId);
    const signing = await loadOrgSigningKey(ctx, ctx.orgId, "active");
    const stats = await ctx.db
      .query("orgStats")
      .withIndex("by_org", (q) => q.eq("orgId", ctx.orgId))
      .unique();
    return {
      keys: rows.map(rowOf),
      signing: signing.ok ? ("ok" as const) : signing.reason,
      env: { active: envKeyOf("active"), next: envKeyOf("next") },
      publishFailedAt: stats?.publishFailedAt ?? null,
    };
  },
});

/**
 * "N of M devices trust the new key" (viewer), one page of up to
 * MAX_TRUST_PAGE devices (`devices.by_org`) joined with their presence
 * (revoked devices are not counted) and report (`trustedKeyIds`). The Signing
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
      const report = await ctx.db
        .query("deviceReports")
        .withIndex("by_device", (q) => q.eq("deviceId", d._id))
        .unique();
      if (report?.trustedKeyIds?.includes(next.keyId) === true) trustNext++;
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
  action: "policy.keyRegistered" | "policy.rotationPrepared" | "policy.rotationFinished",
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
