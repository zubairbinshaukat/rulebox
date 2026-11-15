import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { writeAudit } from "./lib/audit";
import { checkRevision, getInOrg } from "./lib/authz";
import { fail } from "./lib/errors";
import { internalMutation, memberMutation, memberQuery } from "./lib/functions";
import { parseGroupConfig, snapshotGroupConfig } from "./lib/groupConfig";
import {
  MAX_BAKE_HOURS,
  MAX_FAILURE_PCT,
  MAX_RING_BULK,
  MAX_RING_LIST,
  MIN_BAKE_HOURS,
  MIN_FAILURE_PCT,
  ROLLOUT_TICK_PAGE,
} from "./lib/limits";
import { ring as ringValidator, RINGS, type RingValue } from "./lib/lockdownValidators";
import { requestPublish } from "./lib/publish";
import {
  applyDecision,
  decide,
  loadRollout,
  promotedPointers,
  requirePilotDevice,
  ringHealth,
  stageOf,
  stateAfter,
  type Health,
} from "./lib/rollouts";

// Rollout rings and rollback (Phase 5 Step 16, plan 4.14; PRD 24.3). The unit of rollout is a GROUP CONFIGURATION VERSION
// (`lib/groupConfig.ts`): three pointers (pilot, early, everyone) name the version each ring's PCs get; the publisher builds a PC's
// document from the version its ring points to, so a change reaches the pilot ring first and moves outward by promotion, and a
// rollback is old content under a NEW, higher document version. Locks, broadcasts, employees and keys are never ring-gated.
//
// Every mutation takes `expectedRevision` of the `groupRollouts` row (`stale_edit`) and bumps it, as do the pointer moves of a snapshot
// and of the tick, so an admin acting on a stale screen is refused instead of promoting a version they never saw.
//
// I/O (see `ioBudgets.ts`): `groupView` is small (rollout row + <= 101 PCs) and re-runs only when those change; `health` is the heavy
// one (<= 1001 apply reports + the ring's PCs) and re-runs when a report of the stage's version changes, so it is its own query and
// the screen shows it beside, not inside, the view. The tick reads one empty index range when nothing is rolling; each rolling
// group is evaluated in its own transaction.

const pointersValidator = v.object({ pilot: v.number(), early: v.number(), everyone: v.number() });
const stageValidator = v.object({ ring: v.union(v.literal("pilot"), v.literal("early")), version: v.number() });

const rolloutView = v.object({
  enabled: v.boolean(),
  pointers: pointersValidator,
  autoPromote: v.object({ enabled: v.boolean(), bakeHours: v.number(), maxFailurePct: v.number() }),
  autoRollback: v.boolean(),
  state: v.union(v.literal("idle"), v.literal("rolling"), v.literal("halted")),
  haltReason: v.union(v.string(), v.null()),
  stageStartedAt: v.union(v.number(), v.null()),
  revision: v.number(),
});

const healthView = v.object({
  stage: v.union(stageValidator, v.null()),
  ringSize: v.number(),
  ringCapped: v.boolean(),
  applied: v.number(),
  failed: v.number(),
  partial: v.number(),
  waiting: v.number(),
  pilotRolledBack: v.boolean(),
  reportsCapped: v.boolean(),
});

function viewOf(r: Doc<"groupRollouts">) {
  return {
    enabled: r.enabled,
    pointers: r.pointers,
    autoPromote: r.autoPromote,
    autoRollback: r.autoRollback,
    state: r.state,
    haltReason: r.haltReason ?? null,
    stageStartedAt: r.stageStartedAt ?? null,
    revision: r.revision,
  };
}

/**
 * The rollout screen (viewer): the rollout row (null = the group has no configuration version yet, so no rollout row), the versions
 * that can still be chosen for a rollback (newest first; from `groupRollouts.versions`, never the configuration texts), the group's PCs
 * with their ring (the first MAX_RING_LIST; `devicesTruncated` says there are more) and the stage in flight.
 */
export const groupView = memberQuery("viewer")({
  args: { groupId: v.string() },
  returns: v.object({
    groupName: v.string(),
    rollout: v.union(rolloutView, v.null()),
    versions: v.array(v.object({ version: v.number(), reason: v.string(), createdAt: v.number() })),
    stage: v.union(stageValidator, v.null()),
    devices: v.array(v.object({ _id: v.id("devices"), name: v.string(), ring: ringValidator })),
    devicesTruncated: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const group = await getInOrg(ctx, "groups", args.groupId, ctx.orgId);
    const rollout = await loadRollout(ctx, group._id);
    const devices = await ctx.db
      .query("devices")
      .withIndex("by_group", (q) => q.eq("groupId", group._id))
      .take(MAX_RING_LIST + 1);
    return {
      groupName: group.name,
      rollout: rollout === null ? null : viewOf(rollout),
      versions: [...(rollout?.versions ?? [])].sort((a, b) => b.version - a.version),
      stage: rollout === null || !rollout.enabled ? null : stageOf(rollout.pointers),
      devices: devices
        .slice(0, MAX_RING_LIST)
        .map((d) => ({ _id: d._id, name: d.name, ring: (d.ring ?? "everyone") as RingValue })),
      devicesTruncated: devices.length > MAX_RING_LIST,
    };
  },
});

/**
 * Ring health of the stage in flight (viewer; plan 4.14): applied / failed / partial / waiting for the stage's ring and version. All
 * zeros and `stage: null` when nothing is rolling out (no device or report is read then).
 */
export const health = memberQuery("viewer")({
  args: { groupId: v.string() },
  returns: healthView,
  handler: async (ctx, args): Promise<Health> => {
    const group = await getInOrg(ctx, "groups", args.groupId, ctx.orgId);
    const rollout = await loadRollout(ctx, group._id);
    if (rollout === null || !rollout.enabled) return await ringHealth(ctx, ctx.orgId, group._id, { pilot: 0, early: 0, everyone: 0 });
    return await ringHealth(ctx, ctx.orgId, group._id, rollout.pointers);
  },
});

/** The group's rollout row for a change: created (with the group's first configuration version) when the group has none yet; `stale_edit` on a wrong revision. */
async function rolloutForChange(
  ctx: Pick<MutationCtx, "db" | "scheduler"> & { member: Doc<"members"> },
  group: Doc<"groups">,
  expectedRevision: number,
): Promise<Doc<"groupRollouts">> {
  let rollout = await loadRollout(ctx, group._id);
  if (rollout === null) {
    await snapshotGroupConfig(ctx, group._id, "Rollout rings", ctx.member._id);
    rollout = await loadRollout(ctx, group._id);
    if (rollout === null) fail("not_found");
  }
  checkRevision(rollout, expectedRevision);
  return rollout;
}

const auditBase = (ctx: { orgId: Id<"organizations">; actor: { type: "member"; id: string; label: string } }, group: Doc<"groups">) => ({
  orgId: ctx.orgId,
  actor: ctx.actor,
  targetType: "group" as const,
  targetId: group._id,
  targetLabel: group.name,
});

/**
 * Turn rollout rings on or off for a group (admin). On: needs at least one PC in the pilot ring (`conflict`, detail `no_pilot_devices`);
 * the pointers stay where they are, so from the next edit on a change reaches the pilot ring first. Off: all three pointers move to the
 * newest version at once and the PCs on older ones are republished. Audits `rollout.enabled` / `rollout.disabled`.
 */
export const setEnabled = memberMutation("admin")({
  args: { groupId: v.string(), enabled: v.boolean(), expectedRevision: v.number() },
  returns: v.object({ revision: v.number() }),
  handler: async (ctx, args) => {
    const group = await getInOrg(ctx, "groups", args.groupId, ctx.orgId);
    const rollout = await rolloutForChange(ctx, group, args.expectedRevision);
    if (rollout.enabled === args.enabled) return { revision: rollout.revision };
    const revision = rollout.revision + 1;
    if (args.enabled) {
      await requirePilotDevice(ctx, group._id);
      await ctx.db.patch(rollout._id, { enabled: true, revision });
      await writeAudit(ctx, { ...auditBase(ctx, group), action: "rollout.enabled", summary: `Turned on rollout rings for the group ${group.name}` });
      return { revision };
    }
    const newest = await ctx.db
      .query("groupConfigs")
      .withIndex("by_group_version", (q) => q.eq("groupId", group._id))
      .order("desc")
      .first();
    const version = newest?.version ?? rollout.pointers.pilot;
    await ctx.db.patch(rollout._id, {
      enabled: false,
      pointers: { pilot: version, early: version, everyone: version },
      state: "idle",
      haltReason: undefined,
      stageStartedAt: undefined,
      revision,
    });
    await requestPublish(ctx, ctx.orgId, { groupIds: [group._id] });
    await writeAudit(ctx, { ...auditBase(ctx, group), action: "rollout.disabled", summary: `Turned off rollout rings for the group ${group.name}` });
    return { revision };
  },
});

const isWhole = (n: number, min: number, max: number): boolean => Number.isInteger(n) && n >= min && n <= max;

/**
 * Automatic promotion settings (admin): on or off (default off), bake time 1-168 hours (default 24), the failure share that halts a
 * rollout 1-100 % (default 10), and whether a halt returns the pilot ring to the early version (default on). Unchanged = no write.
 */
export const setAutoPromote = memberMutation("admin")({
  args: {
    groupId: v.string(),
    enabled: v.boolean(),
    bakeHours: v.number(),
    maxFailurePct: v.number(),
    autoRollback: v.boolean(),
    expectedRevision: v.number(),
  },
  returns: v.object({ revision: v.number() }),
  handler: async (ctx, args) => {
    if (!isWhole(args.bakeHours, MIN_BAKE_HOURS, MAX_BAKE_HOURS)) fail("invalid_argument", { field: "bakeHours" });
    if (!isWhole(args.maxFailurePct, MIN_FAILURE_PCT, MAX_FAILURE_PCT)) fail("invalid_argument", { field: "maxFailurePct" });
    const group = await getInOrg(ctx, "groups", args.groupId, ctx.orgId);
    const rollout = await rolloutForChange(ctx, group, args.expectedRevision);
    const a = rollout.autoPromote;
    if (a.enabled === args.enabled && a.bakeHours === args.bakeHours && a.maxFailurePct === args.maxFailurePct && rollout.autoRollback === args.autoRollback) {
      return { revision: rollout.revision };
    }
    const revision = rollout.revision + 1;
    await ctx.db.patch(rollout._id, {
      autoPromote: { enabled: args.enabled, bakeHours: args.bakeHours, maxFailurePct: args.maxFailurePct },
      autoRollback: args.autoRollback,
      revision,
    });
    await writeAudit(ctx, {
      ...auditBase(ctx, group),
      action: "rollout.settingsChanged",
      summary: `Changed the rollout settings of the group ${group.name} (automatic promotion ${args.enabled ? "on" : "off"}, ${args.bakeHours} h, ${args.maxFailurePct} %)`,
    });
    return { revision };
  },
});

/**
 * Put PCs of the group into a ring (admin; at most MAX_RING_BULK per call; `ring` of the PCs, not the pointers). Takes effect through a
 * republish of exactly those PCs. With rings on, the pilot ring may not end up empty (`conflict`, detail `no_pilot_devices`). A revoked
 * PC or a PC of another group is refused. PCs already in the ring are left alone; nothing changed = no write. Audits `device.ringChanged`.
 */
export const setRings = memberMutation("admin")({
  args: { groupId: v.string(), deviceIds: v.array(v.string()), ring: ringValidator, expectedRevision: v.number() },
  returns: v.object({ revision: v.number(), changed: v.number() }),
  handler: async (ctx, args) => {
    if (args.deviceIds.length === 0 || args.deviceIds.length > MAX_RING_BULK) fail("invalid_argument", { field: "deviceIds" });
    const group = await getInOrg(ctx, "groups", args.groupId, ctx.orgId);
    const rollout = await rolloutForChange(ctx, group, args.expectedRevision);
    const changed: Doc<"devices">[] = [];
    for (const id of new Set(args.deviceIds)) {
      const device = await getInOrg(ctx, "devices", id, ctx.orgId);
      if (device.groupId !== group._id) fail("invalid_argument", { field: "deviceIds" });
      const cred = await ctx.db
        .query("deviceCredentials")
        .withIndex("by_device", (q) => q.eq("deviceId", device._id))
        .unique();
      if (cred?.state === "revoked" || (cred === null && device.revoked === true)) fail("conflict", { detail: "device revoked" });
      if ((device.ring ?? "everyone") !== args.ring) changed.push(device);
    }
    if (changed.length === 0) return { revision: rollout.revision, changed: 0 };
    if (rollout.enabled && args.ring !== "pilot") {
      const leaving = changed.filter((d) => d.ring === "pilot").map((d) => d._id);
      if (leaving.length > 0) await requirePilotDevice(ctx, group._id, leaving);
    }
    for (const d of changed) {
      await ctx.db.patch(d._id, { ring: args.ring === "everyone" ? undefined : args.ring, revision: (d.revision ?? 0) + 1 });
    }
    const revision = rollout.revision + 1;
    await ctx.db.patch(rollout._id, { revision });
    await requestPublish(ctx, ctx.orgId, { deviceIds: changed.map((d) => d._id) });
    const first = changed[0];
    await writeAudit(ctx, {
      orgId: ctx.orgId,
      actor: ctx.actor,
      action: "device.ringChanged",
      targetType: changed.length === 1 && first !== undefined ? "device" : "group",
      targetId: changed.length === 1 && first !== undefined ? first._id : group._id,
      targetLabel: changed.length === 1 && first !== undefined ? first.name : group.name,
      summary:
        changed.length === 1 && first !== undefined
          ? `Put the PC ${first.name} in the ${args.ring} ring`
          : `Put ${changed.length} PCs of the group ${group.name} in the ${args.ring} ring`,
    });
    return { revision, changed: changed.length };
  },
});

/** Promotion needs rings on and no halt. */
function requireRolling(rollout: Doc<"groupRollouts">): void {
  if (!rollout.enabled) fail("conflict", { detail: "rings_disabled" });
  if (rollout.state === "halted") fail("conflict", { detail: "halted" });
}

/**
 * Promote the stage in flight (admin): `to: "early"` makes the early ring follow the pilot version, `to: "everyone"` makes everyone follow
 * the early version; the stage clock restarts. Refused when rings are off, the rollout is halted (resume first), or there is nothing to
 * promote. The PCs of the group get their new document through one republish. Audits `rollout.promoted`.
 */
export const promote = memberMutation("admin")({
  args: { groupId: v.string(), to: v.union(v.literal("early"), v.literal("everyone")), expectedRevision: v.number() },
  returns: v.object({ revision: v.number() }),
  handler: async (ctx, args) => {
    const group = await getInOrg(ctx, "groups", args.groupId, ctx.orgId);
    const rollout = await rolloutForChange(ctx, group, args.expectedRevision);
    requireRolling(rollout);
    const next = promotedPointers(rollout.pointers, args.to);
    if (next === null) fail("conflict", { detail: "nothing_to_promote" });
    const state = stateAfter(next);
    const revision = rollout.revision + 1;
    await ctx.db.patch(rollout._id, { pointers: next, state, stageStartedAt: state === "rolling" ? Date.now() : undefined, haltReason: undefined, revision });
    await requestPublish(ctx, ctx.orgId, { groupIds: [group._id] });
    await writeAudit(ctx, {
      ...auditBase(ctx, group),
      action: "rollout.promoted",
      summary: `Promoted the configuration of the group ${group.name} to the ${args.to} ring`,
    });
    return { revision };
  },
});

/** Promote all (admin): the early and the everyone ring both follow the pilot version at once. The dashboard asks for confirmation first. Audits `rollout.promoted`. */
export const promoteAll = memberMutation("admin")({
  args: { groupId: v.string(), expectedRevision: v.number() },
  returns: v.object({ revision: v.number() }),
  handler: async (ctx, args) => {
    const group = await getInOrg(ctx, "groups", args.groupId, ctx.orgId);
    const rollout = await rolloutForChange(ctx, group, args.expectedRevision);
    requireRolling(rollout);
    const p = rollout.pointers;
    if (stageOf(p) === null) fail("conflict", { detail: "nothing_to_promote" });
    const revision = rollout.revision + 1;
    await ctx.db.patch(rollout._id, {
      pointers: { pilot: p.pilot, early: p.pilot, everyone: p.pilot },
      state: "idle",
      stageStartedAt: undefined,
      haltReason: undefined,
      revision,
    });
    await requestPublish(ctx, ctx.orgId, { groupIds: [group._id] });
    await writeAudit(ctx, {
      ...auditBase(ctx, group),
      action: "rollout.promoted",
      summary: `Promoted the configuration of the group ${group.name} to every ring`,
    });
    return { revision };
  },
});

/**
 * Roll back (admin, a major action: fresh step-up): the chosen rings' pointers go to an older configuration version that still exists
 * (the last 20, plus any a pointer names); the group's PCs are republished with that OLD content under a NEW, higher document version.
 * With rings off, all three pointers move. Afterwards the rollout is `idle` when every pointer names one version, else `halted`
 * (reason `rolled_back`) so an automatic promotion cannot push the newer version out again; Resume clears it. The live settings are
 * not changed: the next edit takes a new version from them. Same pointers = no write. Audits `rollout.rolledBack`.
 */
export const rollback = memberMutation("admin", { major: "rollouts:rollback" })({
  args: { groupId: v.string(), toVersion: v.number(), rings: v.array(ringValidator), expectedRevision: v.number() },
  returns: v.object({ revision: v.number() }),
  handler: async (ctx, args) => {
    if (!Number.isInteger(args.toVersion) || args.toVersion < 1) fail("invalid_argument", { field: "toVersion" });
    if (args.rings.length === 0 || args.rings.length > RINGS.length) fail("invalid_argument", { field: "rings" });
    const group = await getInOrg(ctx, "groups", args.groupId, ctx.orgId);
    const rollout = await rolloutForChange(ctx, group, args.expectedRevision);
    const row = await ctx.db
      .query("groupConfigs")
      .withIndex("by_group_version", (q) => q.eq("groupId", group._id).eq("version", args.toVersion))
      .unique();
    if (row === null || parseGroupConfig(row.config) === null) fail("conflict", { detail: "version_missing" });
    const rings = new Set<RingValue>(rollout.enabled ? args.rings : RINGS);
    const p = rollout.pointers;
    const next = {
      pilot: rings.has("pilot") ? args.toVersion : p.pilot,
      early: rings.has("early") ? args.toVersion : p.early,
      everyone: rings.has("everyone") ? args.toVersion : p.everyone,
    };
    if (next.pilot === p.pilot && next.early === p.early && next.everyone === p.everyone) return { revision: rollout.revision };
    const idle = stateAfter(next) === "idle";
    const revision = rollout.revision + 1;
    await ctx.db.patch(rollout._id, {
      pointers: next,
      state: idle ? "idle" : "halted",
      haltReason: idle ? undefined : "rolled_back",
      stageStartedAt: undefined,
      revision,
    });
    await requestPublish(ctx, ctx.orgId, { groupIds: [group._id] });
    await writeAudit(ctx, {
      ...auditBase(ctx, group),
      action: "rollout.rolledBack",
      summary: `Rolled the group ${group.name} back to configuration version ${args.toVersion} (${[...rings].join(", ")})`,
    });
    return { revision };
  },
});

/**
 * Resume a halted rollout (admin): the halt and its reason are cleared; the stage clock restarts when a stage is still in flight, else
 * the rollout is idle. Not halted = `conflict` (detail `not_halted`). Audits `rollout.resumed`.
 */
export const resume = memberMutation("admin")({
  args: { groupId: v.string(), expectedRevision: v.number() },
  returns: v.object({ revision: v.number() }),
  handler: async (ctx, args) => {
    const group = await getInOrg(ctx, "groups", args.groupId, ctx.orgId);
    const rollout = await rolloutForChange(ctx, group, args.expectedRevision);
    if (rollout.state !== "halted") fail("conflict", { detail: "not_halted" });
    const state = stateAfter(rollout.pointers);
    const revision = rollout.revision + 1;
    await ctx.db.patch(rollout._id, { state, haltReason: undefined, stageStartedAt: state === "rolling" ? Date.now() : undefined, revision });
    await writeAudit(ctx, { ...auditBase(ctx, group), action: "rollout.resumed", summary: `Resumed the rollout of the group ${group.name}` });
    return { revision };
  },
});

// ---------------------------------------------------------------- the 15-minute tick

/**
 * Cron (every 15 minutes): the rollouts in state `rolling`, a page at a time through `by_state_stage` (one empty range when nothing
 * rolls), each handed to `evaluate` in its own transaction; a full page schedules the next one.
 */
export const tick = internalMutation({
  args: { cursor: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("groupRollouts")
      .withIndex("by_state_stage", (q) => q.eq("state", "rolling"))
      .paginate({ numItems: ROLLOUT_TICK_PAGE, cursor: args.cursor ?? null });
    for (const r of page.page) await ctx.scheduler.runAfter(0, internal.rollouts.evaluate, { rolloutId: r._id });
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.rollouts.tick, { cursor: page.continueCursor });
    return null;
  },
});

/**
 * One rolling group: ring health, then halt (failure share or a pilot PC rolled back; the pilot pointer goes back when `autoRollback`
 * is on) or, when automatic promotion is on and the bake time has passed, promote. Not rolling any more, or rings off = nothing. A group
 * that was deleted leaves the rollout idle. Writes only when it decides something.
 */
export const evaluate = internalMutation({
  args: { rolloutId: v.id("groupRollouts") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const rollout = await ctx.db.get(args.rolloutId);
    if (rollout === null || rollout.state !== "rolling" || !rollout.enabled) return null;
    const group = await ctx.db.get(rollout.groupId);
    if (group === null) {
      await ctx.db.patch(rollout._id, { state: "idle", stageStartedAt: undefined, revision: rollout.revision + 1 });
      return null;
    }
    const h = await ringHealth(ctx, rollout.orgId, group._id, rollout.pointers);
    await applyDecision(ctx, rollout, group, decide(rollout, h, Date.now()), h, Date.now());
    return null;
  },
});
