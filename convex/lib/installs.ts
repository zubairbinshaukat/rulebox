import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseReader, MutationCtx } from "../_generated/server";
import { FAILED_DELTA_CAP, INSTALL_RETAG_BATCH, MAX_APP_ASSIGNMENTS, MAX_ORG_DRIVERS } from "./limits";
import { bumpOrgStatsIfPresent } from "./plans";

// Which install results COUNT (Step 17 review, owner decision: install status
// is filtered by assignment). The agent hides an exe app that is no longer
// assigned to its PC and reports nothing for it, so its last row goes stale.
//
// A result counts ("is live") when:
//   - its `groupId` is set: the group the PC is in, written by every report
//     and kept in step by `fleet:move` (retag) and every revoke (cleared);
//   - that group still assigns the app (`appAssignments.by_group_app`);
//   - the app is not archived.
//
// `orgStats.failedInstallCount` counts the LIVE failed rows and moves in the
// same mutation as each of these changes: a report, a move, a revoke, an
// assign / unassign and an archive / restore. When one change would touch more
// than FAILED_DELTA_CAP failed rows (or a PC more than INSTALL_RETAG_BATCH
// rows) the rest is finished by a scheduled job and `stats:reconcile` is
// scheduled for the organization to make the counter exact again. The nightly
// `stats:reconcile` heals any other drift.

type Reader = { db: DatabaseReader };

/** Memoized liveness checks for one query/mutation (assignments and apps are read once each). */
export function liveChecker(ctx: Reader) {
  const assigned = new Map<string, boolean>();
  const apps = new Map<Id<"apps">, Doc<"apps"> | null>();
  async function app(appId: Id<"apps">): Promise<Doc<"apps"> | null> {
    if (!apps.has(appId)) apps.set(appId, await ctx.db.get(appId));
    return apps.get(appId) ?? null;
  }
  async function isAssigned(groupId: Id<"groups">, appId: Id<"apps">): Promise<boolean> {
    const key = `${groupId}:${appId}`;
    let hit = assigned.get(key);
    if (hit === undefined) {
      const row = await ctx.db
        .query("appAssignments")
        .withIndex("by_group_app", (q) => q.eq("groupId", groupId).eq("appId", appId))
        .first();
      hit = row !== null;
      assigned.set(key, hit);
    }
    return hit;
  }
  /** True when a result of `appId` tagged with `groupId` counts. */
  async function live(groupId: Id<"groups"> | undefined, appId: Id<"apps">): Promise<boolean> {
    if (groupId === undefined) return false;
    const a = await app(appId);
    if (a === null || a.archived) return false;
    return await isAssigned(groupId, appId);
  }
  return { live, app };
}

/** The groups that assign an app (at most MAX_APP_ASSIGNMENTS, `appAssignments.by_app`). */
export async function assignedGroupsOf(ctx: Reader, appId: Id<"apps">): Promise<Set<Id<"groups">>> {
  const rows = await ctx.db
    .query("appAssignments")
    .withIndex("by_app", (q) => q.eq("appId", appId))
    .take(MAX_APP_ASSIGNMENTS);
  return new Set(rows.map((r) => r.groupId));
}

/** The apps a group assigns (at most `cap`, `appAssignments.by_group`). */
export async function assignedAppsOf(ctx: Reader, groupId: Id<"groups">, cap: number): Promise<Set<Id<"apps">>> {
  const rows = await ctx.db
    .query("appAssignments")
    .withIndex("by_group", (q) => q.eq("groupId", groupId))
    .take(cap);
  return new Set(rows.map((r) => r.appId));
}

type Writer = Pick<MutationCtx, "db" | "scheduler">;

/** Schedule an exact recount of the organization's counters (`stats:reconcile`). */
export async function scheduleReconcile(ctx: Pick<MutationCtx, "scheduler">, orgId: Id<"organizations">): Promise<void> {
  await ctx.scheduler.runAfter(0, internal.stats.reconcile, { orgId });
}

/**
 * Failed rows of `appId` tagged with one of `groups` (`by_app_state_updated`
 * failed, at most FAILED_DELTA_CAP + 1 read). `overflow`: there were more, the
 * count is not exact.
 */
async function failedRowsIn(ctx: Reader, appId: Id<"apps">, groups: Set<Id<"groups">>): Promise<{ count: number; overflow: boolean }> {
  const rows = await ctx.db
    .query("installResults")
    .withIndex("by_app_state_updated", (q) => q.eq("appId", appId).eq("state", "failed"))
    .take(FAILED_DELTA_CAP + 1);
  const overflow = rows.length > FAILED_DELTA_CAP;
  const count = rows.slice(0, FAILED_DELTA_CAP).filter((r) => r.groupId !== undefined && groups.has(r.groupId)).length;
  return { count, overflow };
}

/**
 * An assignment (group, app) appeared (+1) or went away (-1): its failed rows
 * start or stop counting. Call AFTER the assignment row changed, for a
 * non-archived app only (an archived app's rows never count).
 */
export async function failedFollowAssignment(
  ctx: Writer,
  orgId: Id<"organizations">,
  app: Doc<"apps">,
  groupId: Id<"groups">,
  sign: 1 | -1,
): Promise<void> {
  if (app.archived) return;
  const { count, overflow } = await failedRowsIn(ctx, app._id, new Set([groupId]));
  if (count > 0) await bumpOrgStatsIfPresent(ctx, orgId, { failedInstallCount: sign * count });
  if (overflow) await scheduleReconcile(ctx, orgId);
}

/** The app was archived (-1) or restored (+1): the failed rows of its assigned groups stop or start counting. */
export async function failedFollowArchive(ctx: Writer, orgId: Id<"organizations">, appId: Id<"apps">, sign: 1 | -1): Promise<void> {
  const groups = await assignedGroupsOf(ctx, appId);
  if (groups.size === 0) return;
  const { count, overflow } = await failedRowsIn(ctx, appId, groups);
  if (count > 0) await bumpOrgStatsIfPresent(ctx, orgId, { failedInstallCount: sign * count });
  if (overflow) await scheduleReconcile(ctx, orgId);
}

/**
 * (Step 20b) A PC's driver results tagged with `groupId` (undefined after a revoke). With `cursor` undefined (called from
 * `retagDeviceInstalls`, which already paginates, and Convex allows one `.paginate()` per transaction) it reads the first MAX_ORG_DRIVERS
 * rows with `.take`; when there are more it schedules `stats:retagDriverResults`. With a `cursor` (that scheduled run) it reads one page
 * from it and schedules the next while rows are left. Returns the rows written.
 */
export async function retagDriverResultsPage(
  ctx: Writer,
  device: { _id: Id<"devices"> },
  groupId: Id<"groups"> | undefined,
  cursor?: string | null,
): Promise<number> {
  const q = ctx.db.query("driverResults").withIndex("by_device_driver", (x) => x.eq("deviceId", device._id));
  let rows: Doc<"driverResults">[];
  let next: string | null | undefined;
  if (cursor === undefined) {
    const all = await q.take(MAX_ORG_DRIVERS + 1);
    rows = all.slice(0, MAX_ORG_DRIVERS);
    next = all.length > MAX_ORG_DRIVERS ? null : undefined;
  } else {
    const page = await q.paginate({ numItems: MAX_ORG_DRIVERS, cursor });
    rows = page.page;
    next = page.isDone ? undefined : page.continueCursor;
  }
  let written = 0;
  for (const r of rows) {
    if (r.groupId === groupId) continue;
    await ctx.db.patch(r._id, { groupId });
    written++;
  }
  if (next !== undefined) await ctx.scheduler.runAfter(0, internal.stats.retagDriverResults, { deviceId: device._id, cursor: next });
  return written;
}
/**
 * Tag a PC's install results with `groupId` (its new group; undefined after a
 * revoke) and move `failedInstallCount` by the failed rows that start or stop
 * counting. INSTALL_RETAG_BATCH rows per call (one page from `cursor`); when
 * there are more it schedules `stats:retagDevice` for the rest. Returns the
 * rows written.
 */
export async function retagDeviceInstalls(
  ctx: Writer,
  device: { _id: Id<"devices">; orgId: Id<"organizations"> },
  groupId: Id<"groups"> | undefined,
  cursor: string | null = null,
): Promise<number> {
  const page = await ctx.db
    .query("installResults")
    .withIndex("by_device_updated", (q) => q.eq("deviceId", device._id))
    .paginate({ numItems: INSTALL_RETAG_BATCH, cursor });
  const check = liveChecker(ctx);
  let delta = 0;
  let written = 0;
  // Step 14b: the PC's driver results carry the same tag (nothing counts them; the driver page counts the assigned groups only).
  // One row per driver (<= MAX_ORG_DRIVERS), on the first page only; Step 20b: more than that is finished by `stats:retagDriverResults`.
  if (cursor === null) written += await retagDriverResultsPage(ctx, device, groupId);
  for (const r of page.page) {
    if (r.groupId === groupId) continue;
    if (r.state === "failed") {
      delta += ((await check.live(groupId, r.appId)) ? 1 : 0) - ((await check.live(r.groupId, r.appId)) ? 1 : 0);
    }
    await ctx.db.patch(r._id, { groupId });
    written++;
  }
  if (delta !== 0) await bumpOrgStatsIfPresent(ctx, device.orgId, { failedInstallCount: delta });
  if (!page.isDone) {
    // The rest follows the PC's group at THAT time (a second move in between wins).
    await ctx.scheduler.runAfter(0, internal.stats.retagDevice, { deviceId: device._id, cursor: page.continueCursor });
  }
  return written;
}
