import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import { PING_PROPAGATION_BATCH, PING_PROPAGATION_ORG_BATCH, SWEEP_BATCH } from "./lib/limits";
import { markOffline, minuteBucket, orgPingInterval } from "./lib/presence";

// Presence jobs (plan 4.9 amended, A3/A4). Internal only.

/**
 * Online -> offline (cron every 5 minutes). Reads only devices whose own
 * deadline passed (`deviceLiveness.by_online_deadline`), marks each offline
 * once (liveness, presence, one shard) and reschedules while a batch is full.
 */
export const sweep = internalMutation({
  args: { now: v.optional(v.number()) },
  returns: v.object({ marked: v.number() }),
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    const rows = await ctx.db
      .query("deviceLiveness")
      .withIndex("by_online_deadline", (q) => q.eq("online", true).lt("offlineAfter", minuteBucket(now)))
      .take(SWEEP_BATCH);
    for (const row of rows) await markOffline(ctx, row);
    if (rows.length === SWEEP_BATCH) await ctx.scheduler.runAfter(0, internal.presence.sweep, { now });
    return { marked: rows.length };
  },
});

/**
 * Hand a changed ping interval to the devices (plans:setOrgPingInterval /
 * setGlobalPingInterval). With `orgId`: that organization's liveness rows,
 * PING_PROPAGATION_BATCH per run, writing only rows whose value differs; each
 * device gets the new interval in its next ping answer. Without: every
 * organization that has no per-tenant override, one scheduled run each.
 */
export const applyPingInterval = internalMutation({
  args: { orgId: v.optional(v.id("organizations")), cursor: v.optional(v.union(v.string(), v.null())) },
  returns: v.object({ changed: v.number(), done: v.boolean() }),
  handler: async (ctx, args) => {
    if (args.orgId === undefined) {
      const page = await ctx.db.query("orgPlans").paginate({ numItems: PING_PROPAGATION_ORG_BATCH, cursor: args.cursor ?? null });
      let scheduled = 0;
      for (const plan of page.page) {
        if (plan.pingIntervalMs !== undefined) continue;
        await ctx.scheduler.runAfter(0, internal.presence.applyPingInterval, { orgId: plan.orgId });
        scheduled++;
      }
      if (!page.isDone) await ctx.scheduler.runAfter(0, internal.presence.applyPingInterval, { cursor: page.continueCursor });
      return { changed: scheduled, done: page.isDone };
    }
    const orgId = args.orgId;
    const interval = await orgPingInterval(ctx, orgId);
    const page = await ctx.db
      .query("deviceLiveness")
      .withIndex("by_org", (q) => q.eq("orgId", orgId))
      .paginate({ numItems: PING_PROPAGATION_BATCH, cursor: args.cursor ?? null });
    let changed = 0;
    for (const row of page.page) {
      if (row.pingIntervalMs === interval) continue;
      await ctx.db.patch(row._id, { pingIntervalMs: interval });
      changed++;
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.presence.applyPingInterval, { orgId, cursor: page.continueCursor });
    }
    return { changed, done: page.isDone };
  },
});
