import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { auditEntryOf, auditEntryValue } from "./lib/audit";
import { memberQuery } from "./lib/functions";
import { OVERVIEW_AUDIT_ROWS, OVERVIEW_FAILED_INSTALLS, PRESENCE_SHARDS } from "./lib/limits";
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
    };
  },
});

/**
 * The newest failed installs, with the PC and the app (viewer):
 * `installResults.by_org_state` `failed`, `.take(OVERVIEW_FAILED_INSTALLS)`. The
 * overview subscribes only while its `failedInstallCount` is above zero, so an
 * organization with nothing failed never reads `installResults` at all. A PC or
 * app removed since (results are purged in batches) is left out.
 */
export const failedInstalls = memberQuery("viewer")({
  args: {},
  returns: v.array(
    v.object({
      _id: v.id("installResults"),
      deviceId: v.id("devices"),
      deviceName: v.string(),
      appId: v.id("apps"),
      appName: v.string(),
      detail: v.optional(v.string()),
      updatedAt: v.number(),
    }),
  ),
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("installResults")
      .withIndex("by_org_state", (q) => q.eq("orgId", ctx.orgId).eq("state", "failed"))
      .order("desc")
      .take(OVERVIEW_FAILED_INSTALLS);
    const devices = new Map<Id<"devices">, Doc<"devices"> | null>();
    const apps = new Map<Id<"apps">, Doc<"apps"> | null>();
    const out = [];
    for (const r of rows) {
      if (!devices.has(r.deviceId)) devices.set(r.deviceId, await ctx.db.get(r.deviceId));
      if (!apps.has(r.appId)) apps.set(r.appId, await ctx.db.get(r.appId));
      const device = devices.get(r.deviceId);
      const app = apps.get(r.appId);
      if (device == null || app == null) continue;
      out.push({ _id: r._id, deviceId: r.deviceId, deviceName: device.name, appId: r.appId, appName: app.name, detail: r.detail, updatedAt: r.updatedAt });
    }
    return out;
  },
});
