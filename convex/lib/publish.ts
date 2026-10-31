import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import type { MutationCtx } from "../_generated/server";
import { MAX_PUBLISH_TARGETS, MINUTE_MS, PUBLISH_DEBOUNCE_MS } from "./limits";

// The publish queue (plan 4.4). Every mutation that changes what a device
// should look like calls `requestPublish`; the consumer `publish:run` builds,
// signs and writes the documents (Step 8). One `publishQueue` row per
// organization collects every change made within PUBLISH_DEBOUNCE_MS, so ten
// quick edits cost one run.

/**
 * A scheduled run that neither finished nor rescheduled itself after this long
 * is taken for dead (it threw, which leaves `scheduled` set): the next request
 * schedules a new one. `requestedAt` is the lease clock: it is set when the
 * row is created and whenever a run is (re)scheduled, so every hop of a long
 * walk renews it.
 */
export const PUBLISH_LEASE_MS = 5 * MINUTE_MS;

export type PublishTarget =
  | { allDevices: true }
  | { allDevices?: false; groupIds?: Id<"groups">[]; deviceIds?: Id<"devices">[] };

function union<T extends string>(a: T[], b: T[] | undefined): T[] {
  if (b === undefined || b.length === 0) return a;
  const out = new Set(a);
  for (const x of b) out.add(x);
  return [...out];
}

function sameSet<T>(a: T[], b: T[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((x) => s.has(x));
}

/**
 * Ask for the organization's devices to get a new document. Targets merge:
 * "all devices" wins over lists, and a list longer than MAX_PUBLISH_TARGETS
 * becomes "all devices". Costs 1 read; writes the queue row only when the
 * merged target changed (plus one scheduled run when none is pending).
 */
export async function requestPublish(
  ctx: Pick<MutationCtx, "db" | "scheduler">,
  orgId: Id<"organizations">,
  target: PublishTarget,
): Promise<void> {
  const row = await ctx.db
    .query("publishQueue")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .unique();

  let allDevices = (row?.allDevices ?? false) || target.allDevices === true;
  let groupIds = row?.groupIds ?? [];
  let deviceIds = row?.deviceIds ?? [];
  if (!allDevices && target.allDevices !== true) {
    groupIds = union(groupIds, target.groupIds);
    deviceIds = union(deviceIds, target.deviceIds);
    if (groupIds.length > MAX_PUBLISH_TARGETS || deviceIds.length > MAX_PUBLISH_TARGETS) allDevices = true;
  }
  if (allDevices) {
    groupIds = [];
    deviceIds = [];
  }

  if (row === null) {
    const scheduled = await ctx.scheduler.runAfter(PUBLISH_DEBOUNCE_MS, internal.publish.run, { orgId });
    await ctx.db.insert("publishQueue", { orgId, allDevices, groupIds, deviceIds, scheduled, requestedAt: Date.now() });
    return;
  }
  // The publisher walks "all devices" or the first group with a cursor. A new
  // request for the target being walked restarts it: the change may concern
  // devices the walk already passed.
  let cursor = row.cursor;
  if (cursor !== undefined) {
    const walkingAll = row.allDevices;
    const walkedGroup = row.groupIds[0];
    if (walkingAll !== allDevices) cursor = undefined;
    else if (walkingAll && target.allDevices === true) cursor = undefined;
    else if (!walkingAll && target.allDevices !== true && walkedGroup !== undefined && target.groupIds?.includes(walkedGroup)) {
      cursor = undefined;
    }
  }
  const unchanged =
    row.allDevices === allDevices &&
    sameSet(row.groupIds, groupIds) &&
    sameSet(row.deviceIds, deviceIds) &&
    row.cursor === cursor;
  const now = Date.now();
  // A run that was scheduled long ago and left the row behind died (threw).
  const live = row.scheduled !== undefined && now - row.requestedAt <= PUBLISH_LEASE_MS;
  if (unchanged && live) return; // nothing new: no write
  const scheduled = live
    ? row.scheduled
    : await ctx.scheduler.runAfter(PUBLISH_DEBOUNCE_MS, internal.publish.run, { orgId });
  // `union` keeps the walked group first, so the cursor stays valid for it.
  await ctx.db.patch(row._id, { allDevices, groupIds, deviceIds, scheduled, cursor, requestedAt: live ? row.requestedAt : now });
}
