import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { checkDevice } from "./lib/deviceAuth";
import { deepEqual } from "./lib/deepEqual";

/** Fixed in Phase 2 (about 5 minutes); Phase 4 scales it with fleet size. */
const NEXT_PING_IN_MS = 300_000;

/**
 * The agent's one subscription (PRD 11.1 rule 6).
 *
 * Reads only `devices` and `desiredStates`. It must not call `Date.now()` and
 * must not read `deviceStatus`: either would re-run the subscription on every
 * heartbeat.
 *
 * The device-scope document wins over the group-scope one. `signature` is
 * always null in Phase 2 (signing arrives in Phase 4).
 */
export const desiredState = query({
  args: { deviceId: v.string(), deviceSecret: v.string() },
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
  handler: async (ctx, args) => {
    const check = await checkDevice(ctx, args);
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
          : { version: row.version, doc: row.doc, signature: null },
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
export const heartbeat = mutation({
  args: {
    deviceId: v.string(),
    deviceSecret: v.string(),
    status: v.optional(statusValidator),
  },
  returns: v.union(
    v.object({ kind: v.literal("rejected") }),
    v.object({
      kind: v.literal("ok"),
      nextPingInMs: v.number(),
      serverTimeMs: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const check = await checkDevice(ctx, args);
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
        lastSeenAt: now,
      });
    } else {
      await ctx.db.patch(statusRow._id, { lastSeenAt: now });
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
export const unenroll = mutation({
  args: { deviceId: v.string(), deviceSecret: v.string() },
  returns: v.union(
    v.object({ kind: v.literal("rejected") }),
    v.object({ kind: v.literal("ok") }),
  ),
  handler: async (ctx, args) => {
    const check = await checkDevice(ctx, args);
    if (check.kind !== "ok") return { kind: "rejected" as const };
    await ctx.db.patch(check.device._id, { revoked: true });
    return { kind: "ok" as const };
  },
});
