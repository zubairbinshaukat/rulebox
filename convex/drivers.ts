import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { writeAudit } from "./lib/audit";
import { checkRevision, getInOrg } from "./lib/authz";
import {
  checkDriverArgs,
  checkDriverExitCodes,
  checkDriverInf,
  checkDriverName,
  checkDriverProvides,
  checkDriverSha256,
  checkDriverSize,
  checkDriverUrl,
} from "./lib/driverRules";
import { fail } from "./lib/errors";
import { internalMutation, memberMutation, memberQuery } from "./lib/functions";
import {
  DRIVER_RESULT_PURGE_BATCH,
  MAX_DRIVER_DETAIL_RESULTS,
  MAX_NETWORK_GROUPS,
  MAX_ORG_DRIVERS,
  MAX_WIFI_LIST_GROUPS,
} from "./lib/limits";
import { driverClass, driverKind } from "./lib/lockdownValidators";
import { groupsOf, sameSet, snapshotGroups, type GroupRef } from "./lib/networkShared";

// Drivers (Phase 5 Step 14b, PRD 24.2): INF packages (a zip with an .inf and a signed catalog) and vendor silent installers pushed to
// groups. A driver has no tile and no audience: it is a row of its own, shown on the Networks screen (`networks:list` carries
// the rows) and assigned to groups like a printer. The agent downloads and installs it as SYSTEM (https, SHA-256, signed document).
//
// CONTRACT (the dashboard types against this block):
//   drivers:detail  query, viewer, args { id: string }                  -> DriverDetail
//   drivers:save    mutation, admin, args { id?, expectedRevision?, name, kind: "inf"|"exe"|"msi",
//                     deviceClass: "printer"|"scanner"|"other", url, sha256, sizeBytes, inf?, silentArgs: string[],
//                     successExitCodes: number[], provides: string[], groupIds: string[] }
//                   -> { id: Id<"drivers">, revision: number }
//                   create = no `id` (revision 1); update = `id` + `expectedRevision` (else invalid_argument, field "expectedRevision").
//                   Errors: invalid_argument (field name|kind|deviceClass|url|sha256|sizeBytes|inf|silentArgs|successExitCodes|provides|
//                   groupIds|expectedRevision; detail), not_found (driver or group of another org), stale_edit, too_large (detail "drivers" =
//                   50 per organization; "groups" = more than 500 groups touched). `inf` is required for kind "inf" and refused for another
//                   kind; `silentArgs` is required (1-16) for kind "exe" and dropped for another kind, like `successExitCodes`.
//   drivers:delete  mutation, admin, args { id: string }                -> null
//   drivers:retry   mutation, admin, args { id: string }                -> { revision: number } (bumps the revision: every PC that gave up tries again)
//   DriverRow    = { _id, name, kind, deviceClass, sizeBytes, revision, provides: string[], groupCount, groups: { _id, name }[] }
//                  (first MAX_WIFI_LIST_GROUPS groups; groupCount = all)
//   DriverDetail = DriverRow & { url, sha256, inf: string | null, silentArgs, successExitCodes, groupIds,
//                  counts: { installed, failed, pending, removed, unsupported, restartNeeded, sampled, capped: boolean } }
//                  (counts: the latest result of each PC of the assigned groups, at most 200 rows; `capped` = truncated;
//                  restartNeeded = installed with exit code 3010 or 1641)

const groupRef = v.object({ _id: v.id("groups"), name: v.string() });

const driverRow = v.object({
  _id: v.id("drivers"),
  name: v.string(),
  kind: driverKind,
  deviceClass: driverClass,
  sizeBytes: v.number(),
  revision: v.number(),
  provides: v.array(v.string()),
  groupCount: v.number(),
  groups: v.array(groupRef),
});

const driverCounts = v.object({
  installed: v.number(),
  failed: v.number(),
  pending: v.number(),
  removed: v.number(),
  unsupported: v.number(),
  restartNeeded: v.number(),
  sampled: v.number(),
  capped: v.boolean(),
});

const driverDetailValue = v.object({
  _id: v.id("drivers"),
  name: v.string(),
  kind: driverKind,
  deviceClass: driverClass,
  sizeBytes: v.number(),
  revision: v.number(),
  provides: v.array(v.string()),
  groupCount: v.number(),
  groups: v.array(groupRef),
  url: v.string(),
  sha256: v.string(),
  inf: v.union(v.string(), v.null()),
  silentArgs: v.array(v.string()),
  successExitCodes: v.array(v.number()),
  groupIds: v.array(v.id("groups")),
  counts: driverCounts,
});

export const driverRowValue = driverRow;

/** The list row of a driver (also used by `networks:list`). */
export function driverRowOf(d: Doc<"drivers">, groups: GroupRef[]) {
  return {
    _id: d._id,
    name: d.name,
    kind: d.kind,
    deviceClass: d.deviceClass,
    sizeBytes: d.sizeBytes,
    revision: d.revision,
    provides: [...d.provides],
    groupCount: d.groupIds.length,
    groups,
  };
}

/** A restart is pending after these installer exit codes (3010 required, 1641 initiated). */
const RESTART_CODES = new Set([3010, 1641]);

/**
 * One driver with the install counts (viewer). Counts come from the latest result of each PC (`driverResults.by_driver_state_updated`,
 * at most MAX_DRIVER_DETAIL_RESULTS rows; `capped` says the sample was cut); a row tagged with a group that no longer assigns the driver
 * is not counted. `not_found` for another organization's id.
 */
export const detail = memberQuery("viewer")({
  args: { id: v.string() },
  returns: driverDetailValue,
  handler: async (ctx, args) => {
    const d = await getInOrg(ctx, "drivers", args.id, ctx.orgId);
    const cache = new Map<string, GroupRef | null>();
    const groups = await groupsOf(ctx, d.groupIds, MAX_WIFI_LIST_GROUPS, cache);
    const rows = await ctx.db
      .query("driverResults")
      .withIndex("by_driver_state_updated", (q) => q.eq("driverId", d._id))
      .take(MAX_DRIVER_DETAIL_RESULTS + 1);
    const counts = { installed: 0, failed: 0, pending: 0, removed: 0, unsupported: 0, restartNeeded: 0, sampled: 0, capped: rows.length > MAX_DRIVER_DETAIL_RESULTS };
    for (const r of rows.slice(0, MAX_DRIVER_DETAIL_RESULTS)) {
      if (r.groupId === undefined || !d.groupIds.includes(r.groupId)) continue;
      if (r.state === "installed" || r.state === "failed" || r.state === "pending" || r.state === "removed" || r.state === "unsupported") counts[r.state]++;
      if (r.state === "installed" && r.exitCode !== undefined && RESTART_CODES.has(r.exitCode)) counts.restartNeeded++;
      counts.sampled++;
    }
    return {
      ...driverRowOf(d, groups),
      url: d.url,
      sha256: d.sha256,
      inf: d.inf ?? null,
      silentArgs: [...d.silentArgs],
      successExitCodes: [...d.successExitCodes],
      groupIds: [...d.groupIds],
      counts,
    };
  },
});

/**
 * Create or change a driver (admin). Create: no `id`. Update: `id` and `expectedRevision` (`stale_edit`). The values follow
 * `lib/driverRules.ts`; the name is unique in the organization (case-insensitive, `name` "taken"). No change = no write, no new revision.
 * A change bumps the revision, audits `driver.created` / `driver.updated` and makes the configuration of every group the driver was in
 * or is now in a new version (the first 10 groups in the call, the rest in scheduled batches), so the agent
 * installs, reinstalls or removes it. At most MAX_ORG_DRIVERS drivers per organization (`too_large` detail "drivers").
 */
export const save = memberMutation("admin")({
  args: {
    id: v.optional(v.string()),
    expectedRevision: v.optional(v.number()),
    name: v.string(),
    kind: driverKind,
    deviceClass: driverClass,
    url: v.string(),
    sha256: v.string(),
    sizeBytes: v.number(),
    inf: v.optional(v.string()),
    silentArgs: v.array(v.string()),
    successExitCodes: v.array(v.number()),
    provides: v.array(v.string()),
    groupIds: v.array(v.string()),
  },
  returns: v.object({ id: v.id("drivers"), revision: v.number() }),
  handler: async (ctx, args) => {
    const name = checkDriverName(args.name);
    const url = checkDriverUrl(args.url);
    const sha256 = checkDriverSha256(args.sha256);
    const sizeBytes = checkDriverSize(args.sizeBytes);
    const inf = checkDriverInf(args.kind, args.inf);
    const silentArgs = checkDriverArgs(args.kind, args.silentArgs);
    const successExitCodes = checkDriverExitCodes(args.kind, args.successExitCodes);
    const provides = checkDriverProvides(args.provides);
    if (args.groupIds.length > MAX_NETWORK_GROUPS) fail("invalid_argument", { field: "groupIds", detail: "too_many" });
    const groupIds: Id<"groups">[] = [];
    for (const raw of args.groupIds) {
      const g = await getInOrg(ctx, "groups", raw, ctx.orgId);
      if (!groupIds.includes(g._id)) groupIds.push(g._id);
    }
    groupIds.sort();

    if (args.id === undefined) {
      if (args.expectedRevision !== undefined) fail("invalid_argument", { field: "expectedRevision" });
    } else if (args.expectedRevision === undefined) {
      fail("invalid_argument", { field: "expectedRevision" });
    }
    const own = args.id === undefined ? null : await getInOrg(ctx, "drivers", args.id, ctx.orgId);
    if (own !== null) checkRevision(own, args.expectedRevision as number);

    const all = await ctx.db
      .query("drivers")
      .withIndex("by_org", (q) => q.eq("orgId", ctx.orgId))
      .take(MAX_ORG_DRIVERS + 1);
    if (own === null && all.length >= MAX_ORG_DRIVERS) fail("too_large", { detail: "drivers" });
    if (all.some((d) => (own === null || d._id !== own._id) && d.name.toLowerCase() === name.toLowerCase())) {
      fail("invalid_argument", { field: "name", detail: "taken" });
    }

    if (own === null) {
      const id = await ctx.db.insert("drivers", {
        orgId: ctx.orgId,
        name,
        kind: args.kind,
        deviceClass: args.deviceClass,
        url,
        sha256,
        sizeBytes,
        ...(inf === undefined ? {} : { inf }),
        silentArgs,
        successExitCodes,
        provides,
        groupIds,
        revision: 1,
        createdAt: Date.now(),
      });
      await writeAudit(ctx, {
        orgId: ctx.orgId,
        actor: ctx.actor,
        action: "driver.created",
        targetType: "driver",
        targetId: id,
        targetLabel: name,
        summary: `Added the driver ${name}`,
      });
      await snapshotGroups(ctx, groupIds, `Driver ${name}`, ctx.member._id);
      return { id, revision: 1 };
    }

    const before = [...own.groupIds].sort();
    const unchanged =
      own.name === name &&
      own.kind === args.kind &&
      own.deviceClass === args.deviceClass &&
      own.url === url &&
      own.sha256 === sha256 &&
      own.sizeBytes === sizeBytes &&
      (own.inf ?? null) === (inf ?? null) &&
      sameSet(own.silentArgs, silentArgs) &&
      own.successExitCodes.length === successExitCodes.length &&
      own.successExitCodes.every((c, i) => c === successExitCodes[i]) &&
      own.provides.length === provides.length &&
      own.provides.every((p, i) => p === provides[i]) &&
      sameSet(before, groupIds);
    if (unchanged) return { id: own._id, revision: own.revision };

    const touched = new Set<Id<"groups">>([...before, ...groupIds]);
    const revision = own.revision + 1;
    await ctx.db.patch(own._id, {
      name,
      kind: args.kind,
      deviceClass: args.deviceClass,
      url,
      sha256,
      sizeBytes,
      inf,
      silentArgs,
      successExitCodes,
      provides,
      groupIds,
      revision,
    });
    await writeAudit(ctx, {
      orgId: ctx.orgId,
      actor: ctx.actor,
      action: "driver.updated",
      targetType: "driver",
      targetId: own._id,
      targetLabel: name,
      summary: `Changed the driver ${name}`,
    });
    await snapshotGroups(ctx, touched, `Driver ${name}`, ctx.member._id);
    return { id: own._id, revision };
  },
});

/**
 * Delete a driver (admin). The configuration of every group it was assigned to becomes a new version without it (the agent removes
 * the package it installed, when it can), its results are deleted by a scheduled `drivers:purgeResults`. The first 10 groups
 * are snapshotted in the call, the rest in scheduled batches.
 */
export const remove = memberMutation("admin")({
  args: { id: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const d = await getInOrg(ctx, "drivers", args.id, ctx.orgId);
    await ctx.db.delete(d._id);
    await ctx.scheduler.runAfter(0, internal.drivers.purgeResults, { driverId: d._id });
    await writeAudit(ctx, {
      orgId: ctx.orgId,
      actor: ctx.actor,
      action: "driver.deleted",
      targetType: "driver",
      targetId: d._id,
      targetLabel: d.name,
      summary: `Removed the driver ${d.name}`,
    });
    await snapshotGroups(ctx, d.groupIds, `Removed driver ${d.name}`, ctx.member._id);
    return null;
  },
});

/**
 * Try again (admin): bumps the revision without changing a field, so every PC that gave up on this driver (six failures wait for a new
 * revision) starts again. Audits `driver.retried`; the configuration of its groups becomes a new version (the first 10 groups
 * in the call, the rest in scheduled batches).
 */
export const retry = memberMutation("admin")({
  args: { id: v.string() },
  returns: v.object({ revision: v.number() }),
  handler: async (ctx, args) => {
    const d = await getInOrg(ctx, "drivers", args.id, ctx.orgId);
    const revision = d.revision + 1;
    await ctx.db.patch(d._id, { revision });
    await writeAudit(ctx, {
      orgId: ctx.orgId,
      actor: ctx.actor,
      action: "driver.retried",
      targetType: "driver",
      targetId: d._id,
      targetLabel: d.name,
      summary: `Asked the PCs to try the driver ${d.name} again`,
    });
    await snapshotGroups(ctx, d.groupIds, `Retry driver ${d.name}`, ctx.member._id);
    return { revision };
  },
});

/**
 * One batch of a deleted driver's results (internal; scheduled by `remove`). The index is `[driverId, state, updatedAt]`, which the
 * organization-scoped database of a member function cannot range over. A full batch schedules the next one.
 */
export const purgeResults = internalMutation({
  args: { driverId: v.id("drivers") },
  returns: v.number(),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("driverResults")
      .withIndex("by_driver_state_updated", (q) => q.eq("driverId", args.driverId))
      .take(DRIVER_RESULT_PURGE_BATCH);
    for (const r of rows) await ctx.db.delete(r._id);
    if (rows.length === DRIVER_RESULT_PURGE_BATCH) await ctx.scheduler.runAfter(0, internal.drivers.purgeResults, { driverId: args.driverId });
    return rows.length;
  },
});
