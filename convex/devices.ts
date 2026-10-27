import { v } from "convex/values";
import { internalQuery } from "./_generated/server";
import { writeAudit } from "./lib/audit";
import { checkDevice, type CredentialState } from "./lib/deviceAuth";
import { statusValidator, writeStatus } from "./lib/deviceReport";
import { revokeDevice } from "./lib/fleet";
import { deviceMutation, phase2DeviceMutation, phase2DeviceQuery } from "./lib/functions";
import { recordContact } from "./lib/presence";

// The agent's functions (plan 5.1 as amended by A2, A3, A4).
//
// Wire contract of the installed Phase 2 agent (apps/agent/src/backend/convex.rs,
// read-only): `devices:desiredState` (its one subscription), `devices:heartbeat`
// (`{ kind: "rejected" } | { kind: "ok", nextPingInMs, serverTimeMs }`, extra
// keys ignored; the agent clamps `nextPingInMs` to 5 s .. 1 h) and
// `devices:unenroll`. Names, arguments and answers stay; answers only gain keys.
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

/**
 * The agent's one subscription (PRD 11.1 rule 6), Phase 2 shape until Step 8.
 *
 * Reads `deviceCredentials` (the wrapper), the newest device-scope
 * `desiredStates` row and, only when there is none, the `devices` row for the
 * group scope. It must not call `Date.now()` and never reads presence,
 * liveness, summary or report rows, so status changes and pings do not re-run
 * it.
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
    const deviceId = check.cred.deviceId;

    let row = await ctx.db
      .query("desiredStates")
      .withIndex("by_scope_version", (q) => q.eq("scope", deviceId))
      .order("desc")
      .first();
    if (row === null) {
      const device = await ctx.db.get(deviceId);
      if (device?.groupId !== undefined) {
        const groupScope: string = device.groupId;
        row = await ctx.db
          .query("desiredStates")
          .withIndex("by_scope_version", (q) => q.eq("scope", groupScope))
          .order("desc")
          .first();
      }
    }

    return {
      kind: "ok" as const,
      desired: row === null ? null : { version: row.version, doc: row.doc ?? null, signature: null },
    };
  },
});

/**
 * Heartbeat (Phase 2 name; alias of `ping` until Phase 6, plan 4.6 amended).
 *
 * Liveness: writes `deviceLiveness` only when the minute bucket changed (plus
 * `devicePresence` and one `orgPresence` shard on an offline -> online
 * transition); a second heartbeat within the same minute writes nothing.
 * Status: until `deviceApi:report` exists (Step 12) the alias accepts the
 * snapshot and writes `deviceSummary` / `deviceReports` only when they change.
 * Never writes `devices`.
 */
export const heartbeat = phase2DeviceMutation({
  args: { status: v.optional(statusValidator) },
  returns: v.union(
    v.object({ kind: v.literal("rejected") }),
    v.object({
      kind: v.literal("ok"),
      nextPingInMs: v.number(),
      serverTimeMs: v.number(),
      // Additive (Phase 2 agents ignore unknown keys).
      rotateCredential: v.boolean(),
      planState,
    }),
  ),
  handler: async (ctx, args) => {
    const check = ctx.deviceCheck;
    if (check.kind !== "ok") return { kind: "rejected" as const };
    const ids = { deviceId: check.cred.deviceId, orgId: check.cred.orgId };
    const now = Date.now();
    const contact = await recordContact(ctx, ids, now);
    if (args.status !== undefined) await writeStatus(ctx, ids, args.status, now);
    return {
      kind: "ok" as const,
      nextPingInMs: contact.nextPingInMs,
      serverTimeMs: now,
      rotateCredential: check.cred.rotate,
      planState: planStateOf(check.cred.state),
    };
  },
});

/**
 * The liveness ping of Phase 4 agents (plan 4.9, 5.1 amended, A4). Reads the
 * credentials (wrapper) and the liveness row; writes as `heartbeat` does.
 * Unknown, wrong secret and revoked answer `device_rejected`.
 */
export const ping = deviceMutation({
  args: {},
  returns: v.object({ nextPingInMs: v.number(), planState, rotateCredential: v.boolean() }),
  handler: async (ctx) => {
    const contact = await recordContact(ctx, { deviceId: ctx.device._id, orgId: ctx.device.orgId }, Date.now());
    return {
      nextPingInMs: contact.nextPingInMs,
      planState: planStateOf(ctx.device.state),
      rotateCredential: ctx.device.rotate,
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
