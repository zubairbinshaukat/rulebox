import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation } from "./lib/functions";
import { DAY_MS, DEVICE_SECURITY_RETENTION_DAYS, ORG_SECURITY_RETENTION_DAYS, SECURITY_RETENTION_BATCH, SECURITY_ROLLUP_BATCH } from "./lib/limits";
import { addBlocked, mergeDenials, ORG_DENIAL_CAP, serverDay } from "./lib/lockdownReports";
import { blockedCounts, permissionDenial, type PermissionDenialValue } from "./lib/lockdownValidators";

// Security counters, rolled up (Phase 5 Step 10, plan 4.2, 4.19). Devices write at most one
// `deviceSecurityDaily` row per day (`deviceApi:reportSecurityDaily`); a daily job folds
// yesterday's rows of each organization into ONE `orgSecurityDaily` row, which is what the
// dashboard reads ("30-day denial counts", overview warnings). The same walk deletes expired
// rows: device days after 14 days, organization days after 90. No dashboard screen subscribes
// to the device rows.
//
// The walk is one organization per step, and a step has AT MOST ONE `.paginate()` (Convex allows
// one per function): the organizations are walked by creation time (`by_creation_time`, `.first()`
// after the previous one), then that organization's rows for the day (`deviceSecurityDaily.by_org_day`)
// are paged in SECURITY_ROLLUP_BATCH rows with the sums carried in the arguments of the next scheduled
// step; then the prune step; then the next organization. An organization without rows costs the
// organization read and three empty index ranges.

const acc = v.object({ devices: v.number(), blocked: blockedCounts, permissionDenials: v.array(permissionDenial) });

export const rollup = internalMutation({
  args: {
    /** The server (UTC) day to fold; missing = yesterday. */
    day: v.optional(v.string()),
    /** Between organizations: the creation time of the organization walked last (missing = start of the walk). */
    after: v.optional(v.number()),
    /** The organization being walked, and its creation time (to find the next one). */
    orgId: v.optional(v.id("organizations")),
    orgCreated: v.optional(v.number()),
    cursor: v.optional(v.string()),
    acc: v.optional(acc),
    prune: v.optional(v.boolean()),
  },
  returns: v.object({ state: v.string() }),
  handler: async (ctx, args) => {
    const now = Date.now();
    const day = args.day ?? serverDay(now - DAY_MS);
    let orgId = args.orgId;
    let orgCreated = args.orgCreated ?? 0;

    // Pick the next organization.
    if (orgId === undefined) {
      const after = args.after;
      const org = await ctx.db
        .query("organizations")
        .withIndex("by_creation_time", (q) => (after === undefined ? q : q.gt("_creationTime", after)))
        .first();
      if (org === null) return { state: "done" };
      orgId = org._id;
      orgCreated = org._creationTime;
    }
    const here = { day, orgId, orgCreated };

    if (args.prune !== true) {
      const page = await ctx.db
        .query("deviceSecurityDaily")
        .withIndex("by_org_day", (q) => q.eq("orgId", orgId).eq("day", day))
        .paginate({ numItems: SECURITY_ROLLUP_BATCH, cursor: args.cursor ?? null });
      const sum = args.acc ?? { devices: 0, blocked: { appLocker: 0, appControl: 0, procWatch: 0, elevation: 0 }, permissionDenials: [] };
      let denials: PermissionDenialValue[] = sum.permissionDenials;
      let blocked = sum.blocked;
      for (const r of page.page) {
        blocked = addBlocked(blocked, r.blocked);
        denials = mergeDenials([...denials, ...r.permissionDenials], ORG_DENIAL_CAP);
      }
      const total = { devices: sum.devices + page.page.length, blocked, permissionDenials: denials };
      if (!page.isDone) {
        await ctx.scheduler.runAfter(0, internal.security.rollup, { ...here, cursor: page.continueCursor, acc: total });
        return { state: "paging" };
      }
      if (total.devices > 0) {
        const row = {
          orgId,
          day,
          blocked: total.blocked,
          permissionDenials: total.permissionDenials,
          devicesReporting: total.devices,
        };
        const have = await ctx.db
          .query("orgSecurityDaily")
          .withIndex("by_org_day", (q) => q.eq("orgId", orgId).eq("day", day))
          .unique();
        // Idempotent: a repeated run for the same day replaces the row (never adds twice).
        if (have === null) await ctx.db.insert("orgSecurityDaily", row);
        else await ctx.db.replace(have._id, row);
      }
    }

    // Retention: the next step is the prune of this organization.
    const cutDevice = serverDay(now - DEVICE_SECURITY_RETENTION_DAYS * DAY_MS);
    const cutOrg = serverDay(now - ORG_SECURITY_RETENTION_DAYS * DAY_MS);
    const oldDevices = await ctx.db
      .query("deviceSecurityDaily")
      .withIndex("by_org_day", (q) => q.eq("orgId", orgId).lt("day", cutDevice))
      .take(SECURITY_RETENTION_BATCH);
    for (const r of oldDevices) await ctx.db.delete(r._id);
    const oldOrg = await ctx.db
      .query("orgSecurityDaily")
      .withIndex("by_org_day", (q) => q.eq("orgId", orgId).lt("day", cutOrg))
      .take(SECURITY_RETENTION_BATCH);
    for (const r of oldOrg) await ctx.db.delete(r._id);
    if (oldDevices.length === SECURITY_RETENTION_BATCH || oldOrg.length === SECURITY_RETENTION_BATCH) {
      await ctx.scheduler.runAfter(0, internal.security.rollup, { ...here, prune: true });
      return { state: "pruning" };
    }
    await ctx.scheduler.runAfter(0, internal.security.rollup, { day, after: orgCreated });
    return { state: "next" };
  },
});
