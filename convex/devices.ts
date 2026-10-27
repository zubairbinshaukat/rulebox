import { v } from "convex/values";
import { internalQuery } from "./_generated/server";
import { checkDevice } from "./lib/deviceAuth";
import { deepEqual } from "./lib/deepEqual";
import { phase2DeviceMutation, phase2DeviceQuery } from "./lib/functions";
import { bumpOrgStatsIfPresent } from "./lib/plans";

/** Fixed in Phase 2 (about 5 minutes); Step 7 scales it with fleet size. */
const NEXT_PING_IN_MS = 300_000;

/**
 * The agent's one subscription (PRD 11.1 rule 6).
 *
 * Reads only `devices` and `desiredStates`. It must not call `Date.now()` and
 * must not read `deviceStatus`: either would re-run the subscription on every
 * heartbeat.
 *
 * Phase 2 wire shape until Step 8: the device-scope document wins over the
 * group-scope one, and `signature` is always null.
 */
export const desiredState = phase2DeviceQuery({
  args: {},
  returns: v.union(
    v.object({ kind: v.literal("unknownDevice") }),
    v.object({ kind: v.literal("revoked") }),
    v.object({
      kind: v.literal("ok"),
      desired: v.union(
        v.null(),
        v.object({
          version: v.number(),
          doc: v.any(),
          signature: v.null(),
        }),
      ),
    }),
  ),
  handler: async (ctx) => {
    const check = ctx.deviceCheck;
    if (check.kind === "unknown") return { kind: "unknownDevice" as const };
    if (check.kind === "revoked") return { kind: "revoked" as const };
    const device = check.device;

    let row = await ctx.db
      .query("desiredStates")
      .withIndex("by_scope_version", (q) => q.eq("scope", device._id))
      .order("desc")
      .first();
    if (row === null && device.groupId !== undefined) {
      const groupScope: string = device.groupId;
      row = await ctx.db
        .query("desiredStates")
        .withIndex("by_scope_version", (q) => q.eq("scope", groupScope))
        .order("desc")
        .first();
    }

    return {
      kind: "ok" as const,
      desired:
        row === null
          ? null
          : { version: row.version, doc: row.doc ?? null, signature: null },
    };
  },
});

/** Nullable on the wire so a Rust `None` serializes to a clear. */
const optionalString = v.optional(v.union(v.string(), v.null()));
const optionalNumber = v.optional(v.union(v.number(), v.null()));

/**
 * The agent's complete status snapshot. Absent (or null) means "not set":
 * when this differs from what is stored, the stored fields are replaced.
 */
const statusValidator = v.object({
  agentVersion: optionalString,
  os: optionalString,
  osBuild: optionalString,
  osEdition: optionalString,
  ramMb: optionalNumber,
  diskFreeGb: optionalNumber,
  lockdownLevel: optionalString,
  kioskPhase: optionalString,
  kioskError: optionalString,
  appliedVersion: optionalNumber,
  shellHealth: optionalString,
  compat: v.optional(v.any()),
});

/**
 * Heartbeat: refresh `deviceStatus.lastSeenAt`, and write `devices` only when
 * the reported status differs from the stored one (PRD 11.1 rule 5).
 */
export const heartbeat = phase2DeviceMutation({
  args: { status: v.optional(statusValidator) },
  returns: v.union(
    v.object({ kind: v.literal("rejected") }),
    v.object({
      kind: v.literal("ok"),
      nextPingInMs: v.number(),
      serverTimeMs: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const check = ctx.deviceCheck;
    if (check.kind !== "ok") return { kind: "rejected" as const };
    const device = check.device;
    const now = Date.now();

    const statusRow = await ctx.db
      .query("deviceStatus")
      .withIndex("by_device", (q) => q.eq("deviceId", device._id))
      .first();
    if (statusRow === null) {
      await ctx.db.insert("deviceStatus", {
        deviceId: device._id,
        orgId: device.orgId,
        lastSeenAt: now,
      });
    } else {
      // Backfills `orgId` on Phase 2 rows (plan 4.2).
      await ctx.db.patch(statusRow._id, { lastSeenAt: now, orgId: device.orgId });
    }

    const s = args.status;
    if (s !== undefined) {
      const next = {
        agentVersion: s.agentVersion ?? undefined,
        os: s.os ?? undefined,
        osBuild: s.osBuild ?? undefined,
        osEdition: s.osEdition ?? undefined,
        ramMb: s.ramMb ?? undefined,
        diskFreeGb: s.diskFreeGb ?? undefined,
        lockdownLevel: s.lockdownLevel ?? undefined,
        kioskPhase: s.kioskPhase ?? undefined,
        kioskError: s.kioskError ?? undefined,
        appliedVersion: s.appliedVersion ?? undefined,
        shellHealth: s.shellHealth ?? undefined,
        compat: s.compat === null ? undefined : s.compat,
      };
      const changed = (Object.keys(next) as (keyof typeof next)[]).some(
        (key) => !deepEqual(next[key], device[key]),
      );
      if (changed) {
        // `undefined` removes the field, so a cleared error is really cleared.
        await ctx.db.patch(device._id, next);
      }
    }

    return {
      kind: "ok" as const,
      nextPingInMs: NEXT_PING_IN_MS,
      serverTimeMs: now,
    };
  },
});

/**
 * The device's own request to leave the fleet (`rulebox-agent unenroll`).
 * Marks the device revoked; its subscription then answers `revoked`.
 * `rejected` means unknown id, wrong secret or already revoked.
 */
export const unenroll = phase2DeviceMutation({
  args: {},
  returns: v.union(
    v.object({ kind: v.literal("rejected") }),
    v.object({ kind: v.literal("ok") }),
  ),
  handler: async (ctx) => {
    const check = ctx.deviceCheck;
    if (check.kind !== "ok") return { kind: "rejected" as const };
    await ctx.db.patch(check.device._id, { revoked: true });
    // `deviceCount` counts non-revoked devices (plan 4.2.1, A7): a revoked
    // device frees a slot of the plan's `maxDevices` (Step 6).
    await bumpOrgStatsIfPresent(ctx, check.device.orgId, { deviceCount: -1 });
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
    const d = check.device;
    return { _id: d._id, orgId: d.orgId, groupId: d.groupId, name: d.name };
  },
});
