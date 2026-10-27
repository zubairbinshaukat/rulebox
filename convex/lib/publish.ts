import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import type { MutationCtx } from "../_generated/server";
import { MAX_PUBLISH_TARGETS, PUBLISH_DEBOUNCE_MS } from "./limits";

// The publish queue (plan 4.4). Step 5 ships only this entry point and a
// consumer (`publish:run`) that clears the queue; Step 8 makes `run` sign and
// write the documents. One `publishQueue` row per organization collects every
// change made within PUBLISH_DEBOUNCE_MS, so ten quick edits cost one run.

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
  const unchanged =
    row.allDevices === allDevices && sameSet(row.groupIds, groupIds) && sameSet(row.deviceIds, deviceIds);
  if (unchanged && row.scheduled !== undefined) return; // nothing new: no write
  const scheduled =
    row.scheduled ?? (await ctx.scheduler.runAfter(PUBLISH_DEBOUNCE_MS, internal.publish.run, { orgId }));
  await ctx.db.patch(row._id, { allDevices, groupIds, deviceIds, scheduled });
}
