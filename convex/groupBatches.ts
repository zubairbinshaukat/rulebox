import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation } from "./lib/functions";
import { newSnapshotCache, snapshotGroupConfig } from "./lib/groupConfig";
import {
  GROUP_CLEANUP_BROADCASTS,
  GROUP_CLEANUP_CONFIGS,
  GROUP_CLEANUP_EXCEPTIONS,
  MAX_ORG_DRIVERS,
  MAX_ORG_PRINTERS,
  MAX_WIFI_PROFILES,
  SNAPSHOT_BATCH_GROUPS,
} from "./lib/limits";
import { exceptionRule } from "./lib/lockdownValidators";
import { addException } from "./lockdown";

// Scheduled batches of Phase 5 Step 20b: the groups an edit could not snapshot in its own transaction, and the cleanup after a group is
// deleted. Internal only. Every function reads the live rows when it runs, so it is idempotent and a later edit that landed first is
// never overwritten.

/**
 * (`snapshotGroupsBatched`) A configuration version for up to SNAPSHOT_BATCH_GROUPS groups, each ending in the publish
 * `snapshotGroupConfig` asks for (nothing is written for a group whose content did not change). A group deleted since is skipped.
 * Cost: per group 1 existence read + one snapshot (<= ~1,121 reads, 13 writes).
 */
export const snapshotBatch = internalMutation({
  args: { groupIds: v.array(v.id("groups")), reason: v.string(), by: v.optional(v.id("members")) },
  returns: v.number(),
  handler: async (ctx, args) => {
    const cache = newSnapshotCache();
    let done = 0;
    for (const id of args.groupIds.slice(0, SNAPSHOT_BATCH_GROUPS)) {
      if ((await ctx.db.get(id)) === null) continue;
      await snapshotGroupConfig(ctx, id, args.reason, args.by, cache);
      done++;
    }
    return done;
  },
});

/**
 * (`lockdown:allow`) The exception of one "Allow" for up to SNAPSHOT_BATCH_GROUPS more groups. A group that has the rule already, is
 * gone, or is at MAX_GROUP_EXCEPTIONS is skipped (there is no caller to refuse). Returns the groups that got the exception.
 */
export const allowBatch = internalMutation({
  args: {
    orgId: v.id("organizations"),
    groupIds: v.array(v.id("groups")),
    rule: exceptionRule,
    appId: v.optional(v.id("apps")),
    reason: v.string(),
    findingId: v.id("lockdownFindings"),
    by: v.id("members"),
    now: v.number(),
  },
  returns: v.number(),
  handler: async (ctx, args) => {
    const cache = newSnapshotCache();
    let added = 0;
    for (const id of args.groupIds.slice(0, SNAPSHOT_BATCH_GROUPS)) {
      const group = await ctx.db.get(id);
      if (group === null || group.orgId !== args.orgId) continue;
      const ok = await addException(ctx, {
        orgId: args.orgId,
        group,
        rule: args.rule,
        appId: args.appId,
        reason: args.reason,
        findingId: args.findingId,
        by: args.by,
        now: args.now,
        cache,
        strict: false,
      });
      if (ok) added++;
    }
    return added;
  },
});

const cleanupStep = v.union(v.literal("broadcasts"), v.literal("exceptions"), v.literal("configs"));

/**
 * (`groups:remove`) What a deleted group leaves behind, in bounded steps that reschedule themselves while a step is full:
 * 1. (first run) its id is dropped from `wifiProfiles.groupIds`, `printers.groupIds` / `defaultForGroupIds` and `drivers.groupIds`
 *    (the three tables are tiny, read by `by_org`; the revision is NOT bumped: a profile of another group must not re-apply because
 *    of it) and its `groupRollouts` row is deleted;
 * 2. `broadcasts` aimed at it are cancelled (`by_target_created`, 50 per run, so they stop counting toward the live cap; the rows stay
 *    as history);
 * 3. `exceptions`: its `lockdownExceptions` rows (100 per run);
 * 4. `configs`: its `groupConfigs` rows (10 per run, each up to 256 KB).
 * A group that exists again (it cannot: ids are never reused) or an organization that is gone makes it do nothing.
 * Cost, first run: 51 + 101 + 51 profile rows + 1, one patch per row that named the group (<= 202) + 1 delete.
 */
export const cleanupDeletedGroup = internalMutation({
  args: {
    orgId: v.id("organizations"),
    groupId: v.id("groups"),
    step: v.optional(cleanupStep),
    cursor: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    if ((await ctx.db.get(args.groupId)) !== null) return null;
    const next = async (step: "broadcasts" | "exceptions" | "configs" | null, cursor?: string): Promise<null> => {
      if (step !== null) await ctx.scheduler.runAfter(0, internal.groupBatches.cleanupDeletedGroup, { orgId: args.orgId, groupId: args.groupId, step, ...(cursor === undefined ? {} : { cursor }) });
      return null;
    };

    if (args.step === undefined) {
      const gid = args.groupId;
      const wifi = await ctx.db.query("wifiProfiles").withIndex("by_org", (q) => q.eq("orgId", args.orgId)).take(MAX_WIFI_PROFILES + 1);
      for (const w of wifi) if (w.groupIds.includes(gid)) await ctx.db.patch(w._id, { groupIds: w.groupIds.filter((x) => x !== gid) });
      const printers = await ctx.db.query("printers").withIndex("by_org", (q) => q.eq("orgId", args.orgId)).take(MAX_ORG_PRINTERS + 1);
      for (const p of printers) {
        if (p.groupIds.includes(gid) || p.defaultForGroupIds.includes(gid)) {
          await ctx.db.patch(p._id, {
            groupIds: p.groupIds.filter((x) => x !== gid),
            defaultForGroupIds: p.defaultForGroupIds.filter((x) => x !== gid),
          });
        }
      }
      const drivers = await ctx.db.query("drivers").withIndex("by_org", (q) => q.eq("orgId", args.orgId)).take(MAX_ORG_DRIVERS + 1);
      for (const d of drivers) if (d.groupIds.includes(gid)) await ctx.db.patch(d._id, { groupIds: d.groupIds.filter((x) => x !== gid) });
      const rollout = await ctx.db.query("groupRollouts").withIndex("by_group", (q) => q.eq("groupId", gid)).unique();
      if (rollout !== null) await ctx.db.delete(rollout._id);
      return await next("broadcasts");
    }

    if (args.step === "broadcasts") {
      const now = Date.now();
      const page = await ctx.db
        .query("broadcasts")
        .withIndex("by_target_created", (q) => q.eq("target.kind", "group").eq("target.id", args.groupId))
        .order("desc")
        .paginate({ numItems: GROUP_CLEANUP_BROADCASTS, cursor: args.cursor ?? null });
      for (const b of page.page) {
        if (b.cancelledAt !== undefined || (b.expiresAt !== undefined && b.expiresAt <= now)) continue;
        await ctx.db.patch(b._id, { cancelledAt: now });
      }
      return page.isDone ? await next("exceptions") : await next("broadcasts", page.continueCursor);
    }

    if (args.step === "exceptions") {
      const rows = await ctx.db
        .query("lockdownExceptions")
        .withIndex("by_org_group", (q) => q.eq("orgId", args.orgId).eq("groupId", args.groupId))
        .take(GROUP_CLEANUP_EXCEPTIONS);
      for (const r of rows) await ctx.db.delete(r._id);
      return await next(rows.length === GROUP_CLEANUP_EXCEPTIONS ? "exceptions" : "configs");
    }

    const rows = await ctx.db
      .query("groupConfigs")
      .withIndex("by_group_version", (q) => q.eq("groupId", args.groupId))
      .take(GROUP_CLEANUP_CONFIGS);
    for (const r of rows) await ctx.db.delete(r._id);
    return await next(rows.length === GROUP_CLEANUP_CONFIGS ? "configs" : null);
  },
});
