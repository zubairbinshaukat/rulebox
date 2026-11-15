import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { fail } from "./errors";
import { snapshotGroupsBatched } from "./groupConfig";
import { MAX_GRANT_GROUPS, MAX_GRANT_LOOKUPS, MAX_PUBLISH_TARGETS, MAX_SNAPSHOT_GROUPS_TOTAL } from "./limits";
import { requestPublish } from "./publish";

// Which devices need a new document when an app changes (plan 4.4 `requestPublish`
// target "app"). Used by `apps.ts` and `fileHandlers.ts`.

/**
 * Ask for a new document for every group whose devices carry `appId`: the
 * groups that assign it, and the groups of employees who have it directly
 * (a web app granted to an employee shows on their group's devices, 4.8).
 * More than MAX_PUBLISH_TARGETS assignments, or more than MAX_GRANT_LOOKUPS
 * grants (or an employee in more than MAX_GRANT_GROUPS groups) = every device. Nothing assigned
 * and nothing granted = no request (the app is in no document).
 */
export async function publishApp(ctx: Pick<MutationCtx, "db" | "scheduler">, orgId: Id<"organizations">, appId: Id<"apps">): Promise<void> {
  const assignments = await ctx.db
    .query("appAssignments")
    .withIndex("by_app", (q) => q.eq("appId", appId))
    .take(MAX_PUBLISH_TARGETS + 1);
  if (assignments.length > MAX_PUBLISH_TARGETS) {
    await requestPublish(ctx, orgId, { allDevices: true });
    return;
  }
  const groupIds = new Set<Id<"groups">>(assignments.map((a) => a.groupId));
  // A web app granted directly to an employee shows on the devices of the employee's groups (4.8).
  const grants = await ctx.db
    .query("employeeApps")
    .withIndex("by_app", (q) => q.eq("appId", appId))
    .take(MAX_GRANT_LOOKUPS + 1);
  if (grants.length > MAX_GRANT_LOOKUPS) {
    await requestPublish(ctx, orgId, { allDevices: true });
    return;
  }
  for (const g of grants) {
    const memberships = await ctx.db
      .query("groupMembers")
      .withIndex("by_employee", (q) => q.eq("employeeId", g.employeeId))
      .take(MAX_GRANT_GROUPS + 1);
    if (memberships.length > MAX_GRANT_GROUPS) {
      await requestPublish(ctx, orgId, { allDevices: true });
      return;
    }
    for (const m of memberships) groupIds.add(m.groupId);
  }
  if (groupIds.size > 0) await requestPublish(ctx, orgId, { groupIds: [...groupIds] });
}

/**
 * (Phase 5 Step 16b, plan 4.14) Freeze a catalogue change: a new configuration version for every group that assigns one of
 * `appIds` (`snapshotGroupConfig`: rings off = every PC of the group at once; rings on = the pilot ring first). Call it AFTER
 * the write and before `publishApp`. The first SNAPSHOT_SYNC_GROUPS groups are snapshotted in the call, the rest by scheduled
 * `groupBatches:snapshotBatch` runs (Step 20b, `snapshotGroupsBatched`); more than MAX_SNAPSHOT_GROUPS_TOTAL groups = `too_large`
 * (detail "groups"), which rolls the whole mutation back. Groups that carry the app only through a direct employee grant are not
 * snapshotted: those read the app live (`publishApp` republishes them).
 * Cost: assignments of each app (normally a handful, at most MAX_SNAPSHOT_GROUPS_TOTAL + 1), then per synchronous group 1 existence
 * read + one snapshot.
 */
export async function snapshotAppGroups(
  ctx: Pick<MutationCtx, "db" | "scheduler">,
  appIds: Id<"apps">[],
  reason: string,
  by?: Id<"members">,
): Promise<void> {
  const groupIds = new Set<Id<"groups">>();
  for (const appId of new Set(appIds)) {
    const rows = await ctx.db
      .query("appAssignments")
      .withIndex("by_app", (q) => q.eq("appId", appId))
      .take(MAX_SNAPSHOT_GROUPS_TOTAL + 1);
    for (const r of rows) groupIds.add(r.groupId);
    if (groupIds.size > MAX_SNAPSHOT_GROUPS_TOTAL) fail("too_large", { detail: "groups" });
  }
  await snapshotGroupsBatched(ctx, groupIds, reason, by);
}