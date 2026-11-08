import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { DatabaseReader } from "./_generated/server";
import { auditEntryOf, auditEntryValue } from "./lib/audit";
import { memberQuery } from "./lib/functions";
import { liveChecker } from "./lib/installs";
import { MAX_INSTALL_PAGE, OVERVIEW_AUDIT_ROWS, PRESENCE_SHARDS } from "./lib/limits";
import { checkPageSize, pickSort, sortArg } from "./lib/listing";
import { loadOrgPlan } from "./lib/plans";
import { planLimits, planName, planStatus } from "./lib/validators";

// The overview screen (plan Step 17 items 3 and 6, A3, A7). ONE query
// (`overview:get`) of at most ~25 small documents: the counters row, the online
// count (the sum of a few shard rows), the plan, the key state and the newest
// audit rows. It never reads `deviceLiveness`, `devicePresence`, `devices`,
// `installResults` or a document payload, so a ping, a report or a status
// change does not re-run it: it re-runs when a counter changes, a PC goes
// online or offline, or an audit row is written. The failed-installs list is a
// separate query the screen subscribes to only while `failedInstallCount` is
// above zero.

const counts = v.object({
  deviceCount: v.number(),
  employeeCount: v.number(),
  appCount: v.number(),
  groupCount: v.number(),
  noGroupDeviceCount: v.number(),
  outOfSupportCount: v.number(),
  failedInstallCount: v.number(),
});

/**
 * The overview (viewer). `onlineCount` = the sum of the `orgPresence` shards;
 * `signing` is the state of the organization's keys: "none" without an active
 * key, "rotating" while a next key is prepared; `publishFailedAt` is set while
 * the last publish failed for want of a key (`orgStats`).
 */
export const get = memberQuery("viewer")({
  args: {},
  returns: v.object({
    counts,
    onlineCount: v.number(),
    plan: v.object({ name: planName, status: planStatus, limits: planLimits }),
    signing: v.union(v.literal("none"), v.literal("active"), v.literal("rotating")),
    publishFailedAt: v.union(v.number(), v.null()),
    recentAudit: v.array(auditEntryValue),
    /** Disabled employees' removals wait for a signing key (their offline sign-in still works); see `keys:status`. */
    rosterPending: v.boolean(),
  }),
  handler: async (ctx) => {
    const stats = await ctx.db
      .query("orgStats")
      .withIndex("by_org", (q) => q.eq("orgId", ctx.orgId))
      .unique();
    const shards = await ctx.db
      .query("orgPresence")
      .withIndex("by_org_shard", (q) => q.eq("orgId", ctx.orgId))
      .take(PRESENCE_SHARDS * 4);
    const plan = await loadOrgPlan(ctx, ctx.orgId);
    const active = await ctx.db
      .query("policyKeys")
      .withIndex("by_org_status", (q) => q.eq("orgId", ctx.orgId).eq("status", "active"))
      .first();
    const next = await ctx.db
      .query("policyKeys")
      .withIndex("by_org_status", (q) => q.eq("orgId", ctx.orgId).eq("status", "next"))
      .first();
    const audit = await ctx.db
      .query("auditLog")
      .withIndex("by_org_at", (q) => q.eq("orgId", ctx.orgId))
      .order("desc")
      .take(OVERVIEW_AUDIT_ROWS);
    const rosterPending = await ctx.db
      .query("rosterPending")
      .withIndex("by_org", (q) => q.eq("orgId", ctx.orgId))
      .first();
    return {
      counts: {
        deviceCount: stats?.deviceCount ?? 0,
        employeeCount: stats?.employeeCount ?? 0,
        appCount: stats?.appCount ?? 0,
        groupCount: stats?.groupCount ?? 0,
        noGroupDeviceCount: stats?.noGroupDeviceCount ?? 0,
        outOfSupportCount: stats?.outOfSupportCount ?? 0,
        failedInstallCount: stats?.failedInstallCount ?? 0,
      },
      onlineCount: shards.reduce((sum, s) => sum + s.online, 0),
      plan: { name: plan.plan, status: plan.status, limits: plan.limits },
      signing: active === null ? ("none" as const) : next !== null ? ("rotating" as const) : ("active" as const),
      publishFailedAt: stats?.publishFailedAt ?? null,
      recentAudit: audit.map(auditEntryOf),
      rosterPending: rosterPending !== null,
    };
  },
});

const failedRow = v.object({
  _id: v.id("installResults"),
  deviceId: v.id("devices"),
  deviceName: v.string(),
  appId: v.id("apps"),
  appName: v.string(),
  detail: v.optional(v.string()),
  updatedAt: v.number(),
});

/**
 * The failed installs as a table (viewer; list contract in lib/listing.ts):
 * the failed installs that still count, paginated
 * by `installResults.by_org_state_updated`, `sort` key "updated" (newest first
 * by default, either direction). A page holds at most `numItems` raw results,
 * so it may be short when some no longer count; `isDone` decides Next. The
 * total is `overview:get`'s `failedInstallCount` (the same rule).
 */
export const failedInstallsPage = memberQuery("viewer")({
  args: { paginationOpts: paginationOptsValidator, sort: sortArg },
  returns: paginationResultValidator(failedRow),
  handler: async (ctx, args) => {
    checkPageSize(args.paginationOpts.numItems, MAX_INSTALL_PAGE);
    const sort = pickSort("installs", args.sort);
    const result = await ctx.db
      .query("installResults")
      .withIndex("by_org_state_updated", (q) => q.eq("orgId", ctx.orgId).eq("state", "failed"))
      .order(sort.dir)
      .paginate(args.paginationOpts);
    return { ...result, page: await liveFailedRows(ctx, result.page, result.page.length) };
  },
});

/** The rows of `rows` that still count, with PC and app names, at most `max`. */
async function liveFailedRows(ctx: { db: DatabaseReader }, rows: Doc<"installResults">[], max: number) {
  const devices = new Map<Id<"devices">, Doc<"devices"> | null>();
  const check = liveChecker(ctx);
  const out = [];
  for (const r of rows) {
    if (out.length >= max) break;
    if (!(await check.live(r.groupId, r.appId))) continue;
    if (!devices.has(r.deviceId)) devices.set(r.deviceId, await ctx.db.get(r.deviceId));
    const device = devices.get(r.deviceId);
    const app = await check.app(r.appId);
    // The row's tag is the PC's group (re-tagged on move, cleared on revoke).
    if (device == null || app === null || device.groupId !== r.groupId) continue;
    out.push({ _id: r._id, deviceId: r.deviceId, deviceName: device.name, appId: r.appId, appName: app.name, detail: r.detail, updatedAt: r.updatedAt });
  }
  return out;
}

