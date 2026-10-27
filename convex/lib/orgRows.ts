import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { fail } from "./errors";
import { credOf } from "./fleet";
import { MAX_MEMBERS, MAX_RECOUNT_DEVICES, MAX_RECOUNT_ROWS, PRESENCE_SHARDS } from "./limits";
import { defaultPlanForNewOrg, ensurePlatformSettings, newOrgPlanFields, type CounterField } from "./plans";
import { shardOf } from "./presence";

// The one-per-organization rows (`orgPlans`, `orgStats`, `orgSecrets`,
// `orgPresence`) and the exact recount of the counters. Used when an
// organization is created or adopted (`setup:createOwnerInvite`) and by the
// migrations (`maintenance:migratePlans`, run again at the end of
// `maintenance:migrateDevices`). Writes only what differs.

type Db = Pick<MutationCtx, "db">;

/**
 * Mark the organization's setup-created group as its default group when none
 * is marked yet (organizations created before the flag existed): the oldest
 * group named "Default". Returns true when it wrote.
 */
async function markDefaultGroup(ctx: Db, groups: Doc<"groups">[]): Promise<boolean> {
  if (groups.some((g) => g.isDefault === true)) return false;
  const candidate = groups
    .filter((g) => g.name === "Default")
    .sort((a, b) => a._creationTime - b._creationTime)[0];
  if (candidate === undefined) return false;
  await ctx.db.patch(candidate._id, { isDefault: true });
  candidate.isDefault = true;
  return true;
}

type Recount = { counters: Partial<Record<CounterField, number>>; online: Map<number, number>; wrote: boolean };

/**
 * Exact counts from the rows themselves (index reads; tiny tables, plus up to
 * MAX_RECOUNT_DEVICES devices with their credentials, summary and presence).
 * Counters over devices count NON-revoked devices only.
 */
async function recount(ctx: Db, orgId: Id<"organizations">): Promise<Recount> {
  const groups = await ctx.db
    .query("groups")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .take(MAX_RECOUNT_ROWS);
  const members = await ctx.db
    .query("members")
    .withIndex("by_org_user", (q) => q.eq("orgId", orgId))
    .take(MAX_MEMBERS + 1);
  const devices = await ctx.db
    .query("devices")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .take(MAX_RECOUNT_DEVICES + 1);
  if (groups.length >= MAX_RECOUNT_ROWS || members.length > MAX_MEMBERS || devices.length > MAX_RECOUNT_DEVICES) {
    // Never write a wrong (capped) count into a limit counter.
    fail("conflict", { detail: "too many rows to recount in one transaction" });
  }
  const wrote = await markDefaultGroup(ctx, groups);
  let deviceCount = 0;
  let noGroup = 0;
  let outOfSupport = 0;
  const online = new Map<number, number>();
  for (const d of devices) {
    const cred = await credOf(ctx, d);
    if (cred.state === "revoked") continue;
    deviceCount++;
    if (d.groupId === undefined) noGroup++;
    const summary = await ctx.db
      .query("deviceSummary")
      .withIndex("by_device", (q) => q.eq("deviceId", d._id))
      .unique();
    if (summary?.outOfSupport === true) outOfSupport++;
    const presence = await ctx.db
      .query("devicePresence")
      .withIndex("by_device", (q) => q.eq("deviceId", d._id))
      .unique();
    if (presence?.online === true) online.set(shardOf(d._id), (online.get(shardOf(d._id)) ?? 0) + 1);
  }
  return {
    counters: {
      // The default group is not one of the plan's `maxGroups`.
      groupCount: groups.filter((g) => g.isDefault !== true).length,
      memberCount: members.filter((m) => m.status === "active").length,
      deviceCount,
      noGroupDeviceCount: noGroup,
      outOfSupportCount: outOfSupport,
    },
    online,
    wrote,
  };
}

/** Make the online shards match `online` (writes only shards that differ). */
async function syncShards(ctx: Db, orgId: Id<"organizations">, online: Map<number, number>): Promise<boolean> {
  let wrote = false;
  for (let shard = 0; shard < PRESENCE_SHARDS; shard++) {
    const want = online.get(shard) ?? 0;
    const row = await ctx.db
      .query("orgPresence")
      .withIndex("by_org_shard", (q) => q.eq("orgId", orgId).eq("shard", shard))
      .unique();
    if (row === null) {
      if (want > 0) {
        await ctx.db.insert("orgPresence", { orgId, shard, online: want });
        wrote = true;
      }
    } else if (row.online !== want) {
      await ctx.db.patch(row._id, { online: want });
      wrote = true;
    }
  }
  return wrote;
}

/**
 * Make sure `orgId` has its plan, counter and secret rows, with exact
 * counters, and drop the Phase 2/3 fields the plan tables replace
 * (`organizations.maxDevices`, `orgStats.pingIntervalMs`). A missing plan row
 * is created from the current defaults (`custom` self-host, `free` hosted); a
 * legacy `organizations.maxDevices` is copied into its `limits.maxDevices`.
 * Returns true when anything was written.
 */
export async function ensureOrgRows(
  ctx: Db,
  org: Doc<"organizations">,
  opts: { updatedBy: string; now: number },
): Promise<boolean> {
  const orgId = org._id;
  let changed = false;

  const settings = await ensurePlatformSettings(ctx);

  const plan = await ctx.db
    .query("orgPlans")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .unique();
  if (plan === null) {
    const fields = newOrgPlanFields(settings, defaultPlanForNewOrg(), opts.now, opts.updatedBy);
    if (org.maxDevices !== undefined) fields.limits.maxDevices = org.maxDevices;
    await ctx.db.insert("orgPlans", { orgId, ...fields });
    changed = true;
  }
  if (org.maxDevices !== undefined) {
    await ctx.db.patch(orgId, { maxDevices: undefined });
    changed = true;
  }

  const secrets = await ctx.db
    .query("orgSecrets")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .unique();
  if (secrets === null) {
    await ctx.db.insert("orgSecrets", { orgId });
    changed = true;
  }

  const r = await recount(ctx, orgId);
  const counts = r.counters;
  if (r.wrote) changed = true;
  if (await syncShards(ctx, orgId, r.online)) changed = true;
  const stats = await ctx.db
    .query("orgStats")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .unique();
  if (stats === null) {
    await ctx.db.insert("orgStats", { orgId, deviceCount: 0, ...counts });
    changed = true;
  } else {
    const patch: Partial<Doc<"orgStats">> = {};
    for (const [field, value] of Object.entries(counts) as [CounterField, number][]) {
      if (stats[field] !== value) patch[field] = value;
    }
    if (stats.pingIntervalMs !== undefined) patch.pingIntervalMs = undefined;
    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(stats._id, patch);
      changed = true;
    }
  }
  return changed;
}
