import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { type MutationCtx } from "./_generated/server";
import { internalMutation } from "./lib/functions";
import { recountActiveCodes } from "./lib/enrollmentCodes";
import { credOf } from "./lib/fleet";
import { liveChecker, retagDeviceInstalls, retagDriverResultsPage } from "./lib/installs";
import {
  MAX_MEMBERS,
  MAX_RECOUNT_ROWS,
  PRESENCE_SHARDS,
  RECONCILE_DEVICE_BATCH,
  RECONCILE_EMPLOYEE_BATCH,
  RECONCILE_FAILED_BATCH,
} from "./lib/limits";
import type { CounterField } from "./lib/plans";
import { shardOf } from "./lib/presence";

// `stats:reconcile` (plan Step 17 item 9; Step 17 review): recounts every
// `orgStats` counter of ONE organization and the online shards from the rows
// themselves, and writes only what differs. Nightly for every organization
// (`reconcileAll`, crons.ts, one organization at a time) and on demand when a
// change was too big to count in its own transaction (lib/installs.ts).
//
// Bounded: every stage is one transaction over one page (devices, employees,
// failed install results); the next page is a scheduled run that carries the
// running totals. The counters of the small tables (groups, apps, members,
// codes) are counted in the last run, in the same transaction as their write.
//
// Concurrency: a paged counter (devices, employees, failed installs, online
// shards) is written ONLY when its stored value is still the one read when
// the run started; a counter that moved during the run was changed by a
// mutation that keeps it exact, so it is left for the next night (counted as
// `skipped`).
//
// `failedInstallCount` counts LIVE failed results only (lib/installs.ts):
// tagged with a group that still assigns the app, app not archived.

const STAGES = ["devices", "employees", "failed", "finish"] as const;
type Stage = (typeof STAGES)[number];
const stage = v.union(...STAGES.map((s) => v.literal(s)));

const PAGED_FIELDS = [
  "deviceCount",
  "noGroupDeviceCount",
  "outOfSupportCount",
  "revokedDeviceCount",
  "revokedNoGroupDeviceCount",
  "employeeCount",
  "activeEmployeeCount",
  "failedInstallCount",
] as const satisfies readonly CounterField[];
type PagedField = (typeof PAGED_FIELDS)[number];

const acc = v.object({
  deviceCount: v.number(),
  noGroupDeviceCount: v.number(),
  outOfSupportCount: v.number(),
  // Phase 4b. Optional: a run scheduled before they existed carries none (its snapshot neither, so they are skipped).
  revokedDeviceCount: v.optional(v.number()),
  revokedNoGroupDeviceCount: v.optional(v.number()),
  employeeCount: v.number(),
  activeEmployeeCount: v.number(),
  failedInstallCount: v.number(),
  online: v.array(v.number()),
});
type Acc = typeof acc.type;

const snapshot = v.object({
  deviceCount: v.number(),
  noGroupDeviceCount: v.number(),
  outOfSupportCount: v.number(),
  revokedDeviceCount: v.optional(v.number()),
  revokedNoGroupDeviceCount: v.optional(v.number()),
  employeeCount: v.number(),
  activeEmployeeCount: v.number(),
  failedInstallCount: v.number(),
  online: v.array(v.number()),
});
type Snapshot = typeof snapshot.type;

function emptyAcc(): Acc {
  return {
    deviceCount: 0,
    noGroupDeviceCount: 0,
    outOfSupportCount: 0,
    revokedDeviceCount: 0,
    revokedNoGroupDeviceCount: 0,
    employeeCount: 0,
    activeEmployeeCount: 0,
    failedInstallCount: 0,
    online: new Array<number>(PRESENCE_SHARDS).fill(0),
  };
}

async function statsOf(ctx: Pick<MutationCtx, "db">, orgId: Id<"organizations">) {
  return await ctx.db
    .query("orgStats")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .unique();
}

async function shardsOf(ctx: Pick<MutationCtx, "db">, orgId: Id<"organizations">): Promise<{ online: number[]; rows: (Doc<"orgPresence"> | null)[] }> {
  const rows: (Doc<"orgPresence"> | null)[] = [];
  for (let shard = 0; shard < PRESENCE_SHARDS; shard++) {
    rows.push(
      await ctx.db
        .query("orgPresence")
        .withIndex("by_org_shard", (q) => q.eq("orgId", orgId).eq("shard", shard))
        .unique(),
    );
  }
  return { online: rows.map((r) => r?.online ?? 0), rows };
}

async function snapshotOf(ctx: Pick<MutationCtx, "db">, stats: Doc<"orgStats">): Promise<Snapshot> {
  const out = { online: (await shardsOf(ctx, stats.orgId)).online } as Snapshot;
  for (const f of PAGED_FIELDS) out[f] = stats[f] ?? 0;
  return out;
}

type StageResult = { done: boolean; cursor: string | null };

async function devicesStage(ctx: MutationCtx, orgId: Id<"organizations">, cursor: string | null, a: Acc): Promise<StageResult> {
  const page = await ctx.db
    .query("devices")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .paginate({ numItems: RECONCILE_DEVICE_BATCH, cursor });
  for (const d of page.page) {
    if ((await credOf(ctx, d)).state === "revoked") {
      a.revokedDeviceCount = (a.revokedDeviceCount ?? 0) + 1;
      if (d.groupId === undefined) a.revokedNoGroupDeviceCount = (a.revokedNoGroupDeviceCount ?? 0) + 1;
      continue;
    }
    a.deviceCount++;
    if (d.groupId === undefined) a.noGroupDeviceCount++;
    const summary = await ctx.db
      .query("deviceSummary")
      .withIndex("by_device", (q) => q.eq("deviceId", d._id))
      .unique();
    if (summary?.outOfSupport === true) a.outOfSupportCount++;
    const presence = await ctx.db
      .query("devicePresence")
      .withIndex("by_device", (q) => q.eq("deviceId", d._id))
      .unique();
    if (presence?.online === true) a.online[shardOf(d._id)] = (a.online[shardOf(d._id)] ?? 0) + 1;
  }
  return { done: page.isDone, cursor: page.continueCursor };
}

async function employeesStage(ctx: MutationCtx, orgId: Id<"organizations">, cursor: string | null, a: Acc): Promise<StageResult> {
  const page = await ctx.db
    .query("employees")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .paginate({ numItems: RECONCILE_EMPLOYEE_BATCH, cursor });
  for (const e of page.page) {
    a.employeeCount++;
    if (!e.disabled) a.activeEmployeeCount++;
  }
  return { done: page.isDone, cursor: page.continueCursor };
}

async function failedStage(ctx: MutationCtx, orgId: Id<"organizations">, cursor: string | null, a: Acc): Promise<StageResult> {
  const page = await ctx.db
    .query("installResults")
    .withIndex("by_org_state_updated", (q) => q.eq("orgId", orgId).eq("state", "failed"))
    .paginate({ numItems: RECONCILE_FAILED_BATCH, cursor });
  const check = liveChecker(ctx);
  for (const r of page.page) {
    if (await check.live(r.groupId, r.appId)) a.failedInstallCount++;
  }
  return { done: page.isDone, cursor: page.continueCursor };
}

/** The last run: the small tables, then every write (only what differs). */
async function finish(ctx: MutationCtx, stats: Doc<"orgStats">, a: Acc, start: Snapshot, now: number): Promise<{ wrote: string[]; skipped: string[] }> {
  const orgId = stats.orgId;
  const wrote: string[] = [];
  const skipped: string[] = [];
  const patch: Partial<Record<CounterField, number>> = {};

  // Paged counters: only when nothing moved them since the run started.
  for (const f of PAGED_FIELDS as readonly PagedField[]) {
    const current = stats[f] ?? 0;
    if (current !== start[f]) {
      skipped.push(f);
      continue;
    }
    const want = a[f] ?? 0;
    if (current !== want) patch[f] = want;
  }

  // Small tables: exact in this transaction (or left alone above their cap).
  const groups = await ctx.db
    .query("groups")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .take(MAX_RECOUNT_ROWS);
  if (groups.length < MAX_RECOUNT_ROWS) {
    const n = groups.filter((g) => g.isDefault !== true).length;
    if ((stats.groupCount ?? 0) !== n) patch.groupCount = n;
  } else skipped.push("groupCount");
  const apps = await ctx.db
    .query("apps")
    .withIndex("by_org_archived", (q) => q.eq("orgId", orgId).eq("archived", false))
    .take(MAX_RECOUNT_ROWS);
  if (apps.length < MAX_RECOUNT_ROWS) {
    if ((stats.appCount ?? 0) !== apps.length) patch.appCount = apps.length;
  } else skipped.push("appCount");
  const members = await ctx.db
    .query("members")
    .withIndex("by_org_user", (q) => q.eq("orgId", orgId))
    .take(MAX_MEMBERS + 1);
  if (members.length <= MAX_MEMBERS) {
    const n = members.filter((m) => m.status === "active").length;
    if ((stats.memberCount ?? 0) !== n) patch.memberCount = n;
  } else skipped.push("memberCount");
  const codes = await recountActiveCodes(ctx, orgId, now);
  if (codes !== null) {
    if ((stats.activeEnrollmentCodes ?? 0) !== codes) patch.activeEnrollmentCodes = codes;
  } else skipped.push("activeEnrollmentCodes");

  if (Object.keys(patch).length > 0) {
    await ctx.db.patch(stats._id, patch);
    wrote.push(...Object.keys(patch));
  }

  // Online shards, with the same "unchanged since the start" rule.
  const shards = await shardsOf(ctx, orgId);
  for (let shard = 0; shard < PRESENCE_SHARDS; shard++) {
    const current = shards.online[shard] ?? 0;
    const want = a.online[shard] ?? 0;
    if (current !== (start.online[shard] ?? 0)) {
      skipped.push(`online${shard}`);
      continue;
    }
    if (current === want) continue;
    const row = shards.rows[shard];
    if (row === null || row === undefined) await ctx.db.insert("orgPresence", { orgId, shard, online: want });
    else await ctx.db.patch(row._id, { online: want });
    wrote.push(`online${shard}`);
  }
  return { wrote, skipped };
}

/**
 * Recount one organization (internal; one stage page per run, it reschedules
 * itself). Start with `{ orgId }`. `nextOrg` (set by `reconcileAll`): the
 * organizations walk continues from there when this one is done. An
 * organization without a counters row is left to `maintenance:migratePlans`.
 */
export const reconcile = internalMutation({
  args: {
    orgId: v.id("organizations"),
    stage: v.optional(stage),
    cursor: v.optional(v.union(v.string(), v.null())),
    acc: v.optional(acc),
    start: v.optional(snapshot),
    now: v.optional(v.number()),
    nextOrg: v.optional(v.union(v.string(), v.null())),
  },
  returns: v.object({ done: v.boolean(), wrote: v.array(v.string()), skipped: v.array(v.string()) }),
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    const stats = await statsOf(ctx, args.orgId);
    const next = async () => {
      if (typeof args.nextOrg === "string") await ctx.scheduler.runAfter(0, internal.stats.reconcileAll, { cursor: args.nextOrg });
    };
    if (stats === null) {
      await next();
      return { done: true, wrote: [], skipped: [] };
    }
    const start = args.start ?? (await snapshotOf(ctx, stats));
    const a = args.acc ?? emptyAcc();
    const current: Stage = args.stage ?? "devices";
    if (current === "finish") {
      const r = await finish(ctx, stats, a, start, now);
      await next();
      return { done: true, ...r };
    }
    const cursor = args.cursor ?? null;
    const r =
      current === "devices"
        ? await devicesStage(ctx, args.orgId, cursor, a)
        : current === "employees"
          ? await employeesStage(ctx, args.orgId, cursor, a)
          : await failedStage(ctx, args.orgId, cursor, a);
    const following: Stage = r.done ? STAGES[STAGES.indexOf(current) + 1]! : current;
    await ctx.scheduler.runAfter(0, internal.stats.reconcile, {
      orgId: args.orgId,
      stage: following,
      cursor: r.done ? null : r.cursor,
      acc: a,
      start,
      now,
      nextOrg: args.nextOrg,
    });
    return { done: false, wrote: [], skipped: [] };
  },
});

/** Nightly (crons.ts): reconcile every organization, one at a time. */
export const reconcileAll = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const page = await ctx.db.query("organizations").paginate({ numItems: 1, cursor: args.cursor ?? null });
    const org = page.page[0];
    if (org === undefined) return null;
    await ctx.scheduler.runAfter(0, internal.stats.reconcile, { orgId: org._id, nextOrg: page.isDone ? null : page.continueCursor });
    return null;
  },
});

/**
 * The rest of a PC's install results after a move or revoke touched more than
 * one batch (lib/installs.ts). Tags them with the PC's group as it is NOW
 * (none when revoked), so a second move in between wins.
 */
export const retagDevice = internalMutation({
  args: { deviceId: v.id("devices"), cursor: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const device = await ctx.db.get(args.deviceId);
    if (device === null) return null;
    const revoked = (await credOf(ctx, device)).state === "revoked";
    await retagDeviceInstalls(ctx, device, revoked ? undefined : device.groupId, args.cursor);
    return null;
  },
});

/**
 * (Step 20b) The rest of a PC's driver results after a move or revoke found more than one page (`retagDriverResultsPage`): a page of
 * MAX_ORG_DRIVERS rows per run, tagged with the PC's group as it is NOW (none when revoked), rescheduling itself while rows are left.
 */
export const retagDriverResults = internalMutation({
  args: { deviceId: v.id("devices"), cursor: v.union(v.string(), v.null()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const device = await ctx.db.get(args.deviceId);
    if (device === null) return null;
    const revoked = (await credOf(ctx, device)).state === "revoked";
    await retagDriverResultsPage(ctx, device, revoked ? undefined : device.groupId, args.cursor);
    return null;
  },
});
