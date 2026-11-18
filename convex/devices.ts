import { v } from "convex/values";
import { writeAudit } from "./lib/audit";
import { checkDevice, type CredentialState } from "./lib/deviceAuth";
import { revokeDevice } from "./lib/fleet";
import { fail } from "./lib/errors";
import { deviceMutation, deviceQuery, internalQuery, phase2DeviceMutation, phase2DeviceQuery } from "./lib/functions";
import { MAX_ROSTER_FETCH } from "./lib/limits";
import { orgPolicyKeys, publishedKey, publishedKeysOf } from "./lib/policyKeys";
import { recordContact } from "./lib/presence";

// The agent's functions (plan 5.1 as amended by A2, A3, A4).
//
// Phase 6 Step 3 removed the Phase 2 aliases `devices:desiredState` and
// `devices:heartbeat` (the agent calls `headState`, `fetchDesired` and `ping`;
// the only enrolled devices are test VMs). `unenroll` keeps its Phase 2 shape
// (`{ kind: "rejected" } | { kind: "ok" }`).
//
// The ping interval is carried in `nextPingInMs`: the effective interval from
// the settings (per-tenant override, else the global default; plan 4.9), stored
// on the device's `deviceLiveness` row, or 60 s while a dashboard watches the
// device. Step 8 adds the same value to the signed head the agent subscribes
// to (`desiredHeads.pingIntervalMs`, with `pingNonce` / `fastUntil` so watch
// and "Check now" reach the agent at once); Step 13 teaches the agent to read
// it there and raises its `MAX_PING_MS` to 6 h.

const planStateOf = (state: CredentialState): "ok" | "overLimit" | "suspended" =>
  state === "active" || state === "revoked" ? "ok" : state;
const planState = v.union(v.literal("ok"), v.literal("overLimit"), v.literal("suspended"));

const headValue = v.object({
  version: v.number(),
  contentHash: v.string(),
  keyId: v.string(),
  bodyId: v.id("desiredBodies"),
  pingIntervalMs: v.number(),
  pingNonce: v.number(),
  fastUntil: v.number(),
  rosterEpoch: v.number(),
  planState,
});

/**
 * The agent's ONE subscription from Step 9 on (PRD 11.1 rule 6; plan 5.1
 * amended, A5). The head is small and unsigned: when `head.version` is above
 * what the agent applied, it calls `fetchDesired` once and applies the body
 * only when its signature verifies (it covers every byte of the payload with
 * its version, key id, org and device) and its version and key id match the
 * head. There is no SHA-256 check of the payload against the head (owner
 * decision 2026-11-01, option A): `contentHash` is the hash of the document
 * with version 0, not of the signed bytes, and nothing is applied from the
 * head alone. `keys` = every `policyKeys` row of the device's organization,
 * oldest first (with endorsements, so an agent that was offline through
 * rotations can walk the chain); `retiredKeyIds` = the retired ones.
 *
 * Reads `deviceCredentials` (wrapper), `desiredHeads`, `groupRoster` and
 * `policyKeys` only (<= 20 documents, <= 2 KB), never a payload, never
 * presence / liveness / summary / report rows, and no `Date.now()`, so pings
 * and status reports do not re-run it. `head` is null until the publisher
 * reached the device (a just-enrolled device: ~1.5 s).
 */
export const headState = phase2DeviceQuery({
  args: {},
  returns: v.union(
    v.object({ kind: v.literal("unknownDevice") }),
    v.object({ kind: v.literal("revoked") }),
    v.object({
      kind: v.literal("ok"),
      head: v.union(headValue, v.null()),
      keys: v.array(publishedKey),
      retiredKeyIds: v.array(v.string()),
    }),
  ),
  handler: async (ctx) => {
    const check = ctx.deviceCheck;
    if (check.kind === "unknown") return { kind: "unknownDevice" as const };
    if (check.kind === "revoked") return { kind: "revoked" as const };
    const head = await ctx.db
      .query("desiredHeads")
      .withIndex("by_device", (q) => q.eq("deviceId", check.cred.deviceId))
      .unique();
    let rosterEpoch = 0;
    const rosterGroupId = head?.rosterGroupId;
    if (rosterGroupId !== undefined) {
      const roster = await ctx.db
        .query("groupRoster")
        .withIndex("by_group", (q) => q.eq("groupId", rosterGroupId))
        .unique();
      rosterEpoch = roster?.epoch ?? 0;
    }
    const rows = await orgPolicyKeys(ctx, check.cred.orgId);
    return {
      kind: "ok" as const,
      head:
        head === null
          ? null
          : {
              version: head.version,
              contentHash: head.contentHash,
              keyId: head.keyId,
              bodyId: head.bodyId,
              pingIntervalMs: head.pingIntervalMs,
              pingNonce: head.pingNonce,
              fastUntil: head.fastUntil,
              rosterEpoch,
              planState: head.planState,
            },
      keys: publishedKeysOf(rows),
      retiredKeyIds: rows.filter((r) => r.status === "retired").map((r) => r.keyId),
    };
  },
});

/**
 * One signed version (one-shot query; plan 5.1 amended): the envelope
 * `{ version, payload, signature, keyId }` the agent verifies (Step 9).
 * `not_found` when that version was pruned: the agent re-reads the head.
 */
export const fetchDesired = deviceQuery({
  args: { version: v.number() },
  returns: v.object({ version: v.number(), payload: v.string(), signature: v.string(), keyId: v.string() }),
  handler: async (ctx, args) => {
    const body = await ctx.db
      .query("desiredBodies")
      .withIndex("by_device_version", (q) => q.eq("deviceId", ctx.device._id).eq("version", args.version))
      .unique();
    if (body === null) fail("not_found");
    return { version: body.version, payload: body.payload, signature: body.signature, keyId: body.keyId };
  },
});

const rosterEntryValue = v.object({
  epoch: v.number(),
  employeeId: v.string(),
  credentialRevision: v.union(v.number(), v.null()),
  signature: v.string(),
  keyId: v.string(),
});

/**
 * The roster of the device's group since `sinceEpoch` (one-shot; plan 5.1
 * amended, A6): up to MAX_ROSTER_FETCH signed entries, or the signed snapshot
 * when the device is behind the snapshot or more entries are missing. A
 * device without a group has an empty roster (epoch 0).
 */
export const fetchRoster = deviceQuery({
  args: { sinceEpoch: v.number() },
  returns: v.union(
    v.object({ epoch: v.number(), entries: v.array(rosterEntryValue) }),
    v.object({ snapshot: v.object({ epoch: v.number(), payload: v.string(), signature: v.string(), keyId: v.string() }) }),
  ),
  handler: async (ctx, args) => {
    if (!Number.isSafeInteger(args.sinceEpoch) || args.sinceEpoch < 0) fail("invalid_argument", { field: "sinceEpoch" });
    const device = await ctx.db.get(ctx.device._id);
    const groupId = device?.groupId;
    if (groupId === undefined) return { epoch: 0, entries: [] };
    const roster = await ctx.db
      .query("groupRoster")
      .withIndex("by_group", (q) => q.eq("groupId", groupId))
      .unique();
    if (roster === null) return { epoch: 0, entries: [] };
    const snapshot = async () => {
      const s = roster.snapshotId !== undefined ? await ctx.db.get(roster.snapshotId) : null;
      if (s === null) fail("not_found");
      return { snapshot: { epoch: s.epoch, payload: s.payload, signature: s.signature, keyId: s.keyId } };
    };
    if (args.sinceEpoch < roster.snapshotEpoch) return await snapshot();
    const rows = await ctx.db
      .query("rosterEntries")
      .withIndex("by_group_epoch", (q) => q.eq("groupId", groupId).gt("epoch", args.sinceEpoch))
      .take(MAX_ROSTER_FETCH + 1);
    if (rows.length > MAX_ROSTER_FETCH) return await snapshot();
    return {
      epoch: roster.epoch,
      entries: rows.map((e) => ({
        epoch: e.epoch,
        employeeId: e.employeeId,
        credentialRevision: e.credentialRevision ?? null,
        signature: e.signature,
        keyId: e.keyId,
      })),
    };
  },
});

/**
 * The liveness ping of Phase 4 agents (plan 4.9, 5.1 amended, A4). Reads the
 * credentials (wrapper) and the liveness row; writes `deviceLiveness` only when the
 * minute bucket changed (plus `devicePresence` and one `orgPresence` shard on an
 * offline -> online transition). Never writes `devices`.
 * Unknown, wrong secret and revoked answer `device_rejected`.
 */
export const ping = deviceMutation({
  args: {},
  returns: v.object({
    nextPingInMs: v.number(),
    planState,
    rotateCredential: v.boolean(),
    // The server's clock: the agent corrects its
    // offset for audit timestamps and the server flags a wrong PC clock.
    serverTimeMs: v.number(),
  }),
  handler: async (ctx) => {
    const now = Date.now();
    const contact = await recordContact(ctx, { deviceId: ctx.device._id, orgId: ctx.device.orgId }, now);
    return {
      nextPingInMs: contact.nextPingInMs,
      planState: planStateOf(ctx.device.state),
      rotateCredential: ctx.device.rotate,
      serverTimeMs: now,
    };
  },
});

/**
 * The device's own request to leave the fleet (`rulebox-agent unenroll`).
 * Revokes it (credentials, counters, presence) and audits `device.revoked`
 * with the device as actor. `rejected` means unknown id, wrong secret or
 * already revoked.
 */
export const unenroll = phase2DeviceMutation({
  args: {},
  returns: v.union(v.object({ kind: v.literal("rejected") }), v.object({ kind: v.literal("ok") })),
  handler: async (ctx) => {
    const check = ctx.deviceCheck;
    if (check.kind !== "ok") return { kind: "rejected" as const };
    const device = await revokeDevice(ctx, check.cred, Date.now());
    if (device !== null) {
      await writeAudit(ctx, {
        orgId: device.orgId,
        actor: { type: "device", id: device._id, label: device.name },
        action: "device.revoked",
        targetType: "device",
        targetId: device._id,
        targetLabel: device.name,
        summary: `The PC ${device.name} unenrolled itself`,
      });
    }
    return { kind: "ok" as const };
  },
});

/**
 * The device check for `deviceAction` (actions have no `db`). Null for an
 * unknown device, a wrong secret or a revoked device. Never returns a hash.
 */
export const authorizeDevice = internalQuery({
  args: { deviceId: v.string(), deviceSecret: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      _id: v.id("devices"),
      orgId: v.id("organizations"),
      groupId: v.optional(v.id("groups")),
      name: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    const check = await checkDevice(ctx, args);
    if (check.kind !== "ok") return null;
    const d = await ctx.db.get(check.cred.deviceId);
    if (d === null) return null;
    return { _id: d._id, orgId: d.orgId, groupId: d.groupId, name: d.name };
  },
});
