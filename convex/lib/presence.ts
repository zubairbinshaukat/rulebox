import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseReader, DatabaseWriter } from "../_generated/server";
import { FAST_PING_MS, MINUTE_MS, OFFLINE_GRACE_EXTRA_MS, PRESENCE_SHARDS } from "./limits";
import { effectivePingInterval, loadOrgPlan, loadPlatformSettings } from "./plans";

// Presence by transitions (plan 4.9 as amended by A3; post-Phase-5 plan 2.1).
//
// - `deviceLiveness` (1 row per device, never subscribed): written by a device
//   call only when its minute bucket changed, a deadline changed, a "Check
//   now" was answered or the device came back online.
// - `devicePresence` (1 row per device): written ONLY on a transition.
// - `orgPresence` (PRESENCE_SHARDS rows per org): online counts, changed on
//   transitions only.
// Online -> offline is found by `presence:sweep` through
// `deviceLiveness.by_online_deadline` (rows past their own deadline only).

type Ids = { deviceId: Id<"devices">; orgId: Id<"organizations"> };

export function minuteBucket(ms: number): number {
  return Math.floor(ms / MINUTE_MS);
}

/** Last minute bucket in which a device told to ping every `intervalMs` still counts as online. */
export function offlineAfterBucket(seenBucket: number, intervalMs: number): number {
  return seenBucket + Math.ceil((2.5 * intervalMs + OFFLINE_GRACE_EXTRA_MS) / MINUTE_MS);
}

/** Stable shard of a device (FNV-1a over its id). */
export function shardOf(deviceId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < deviceId.length; i++) {
    h ^= deviceId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % PRESENCE_SHARDS;
}

/** Effective ping interval of an organization: 1 read, +1 without a per-tenant override. */
export async function orgPingInterval(ctx: { db: DatabaseReader }, orgId: Id<"organizations">): Promise<number> {
  const plan = await loadOrgPlan(ctx, orgId);
  if (plan.pingIntervalMs !== undefined) return effectivePingInterval(plan, null);
  return effectivePingInterval(plan, await loadPlatformSettings(ctx));
}

/** Add `delta` to the device's shard of its org's online count (1 read, 1 write). */
export async function bumpOnline(ctx: { db: DatabaseWriter }, ids: Ids, delta: number): Promise<void> {
  const shard = shardOf(ids.deviceId);
  const row = await ctx.db
    .query("orgPresence")
    .withIndex("by_org_shard", (q) => q.eq("orgId", ids.orgId).eq("shard", shard))
    .unique();
  if (row === null) {
    if (delta > 0) await ctx.db.insert("orgPresence", { orgId: ids.orgId, shard, online: delta });
    return;
  }
  const online = Math.max(0, row.online + delta);
  if (online !== row.online) await ctx.db.patch(row._id, { online });
}

/** Set the device's presence row (1 read; 1 write only when it differs). */
export async function setPresence(
  ctx: { db: DatabaseWriter },
  ids: Ids,
  next: { online: boolean; since: number; revoked?: boolean },
): Promise<void> {
  const row = await ctx.db
    .query("devicePresence")
    .withIndex("by_device", (q) => q.eq("deviceId", ids.deviceId))
    .unique();
  if (row === null) {
    await ctx.db.insert("devicePresence", { ...ids, ...next });
    return;
  }
  // Not a transition: keep the first `since`.
  if (row.online === next.online && (row.revoked === true) === (next.revoked === true)) return;
  await ctx.db.patch(row._id, { online: next.online, since: next.since, revoked: next.revoked });
}

/** The three presence rows of a newly enrolled (online) device. */
export async function createPresence(ctx: { db: DatabaseWriter }, ids: Ids, now: number, intervalMs: number): Promise<void> {
  const bucket = minuteBucket(now);
  await ctx.db.insert("deviceLiveness", {
    ...ids,
    seenBucket: bucket,
    online: true,
    offlineAfter: offlineAfterBucket(bucket, intervalMs),
    pingIntervalMs: intervalMs,
  });
  await setPresence(ctx, ids, { online: true, since: now });
  await bumpOnline(ctx, ids, 1);
}

export type Contact = {
  /** What the device is told: its interval, or FAST_PING_MS while watched. */
  nextPingInMs: number;
  /** True when the call wrote anything (tests and the I/O budget). */
  wrote: boolean;
};

/**
 * A device call reached the server (ping, heartbeat): refresh liveness.
 *
 * Writes nothing when the minute bucket and the deadline are unchanged and no
 * check is pending (repeated calls within a minute). An offline -> online
 * transition also writes `devicePresence` and one `orgPresence` shard.
 * Reads exactly one row in the common case.
 */
export async function recordContact(ctx: { db: DatabaseWriter }, ids: Ids, now: number): Promise<Contact> {
  const row = await ctx.db
    .query("deviceLiveness")
    .withIndex("by_device", (q) => q.eq("deviceId", ids.deviceId))
    .unique();
  if (row === null) {
    // A device enrolled before Step 7 that the migration has not reached.
    const interval = await orgPingInterval(ctx, ids.orgId);
    await createPresence(ctx, ids, now, interval);
    return { nextPingInMs: interval, wrote: true };
  }
  const fast = row.fastUntil !== undefined && row.fastUntil > now;
  const interval = fast ? Math.min(FAST_PING_MS, row.pingIntervalMs) : row.pingIntervalMs;
  const bucket = minuteBucket(now);
  const deadline = offlineAfterBucket(bucket, interval);

  const patch: Partial<Doc<"deviceLiveness">> = {};
  if (row.seenBucket !== bucket) patch.seenBucket = bucket;
  if (row.offlineAfter !== deadline) patch.offlineAfter = deadline;
  if (row.pendingCheck !== undefined) {
    patch.answeredCheck = row.pendingCheck;
    patch.pendingCheck = undefined;
  }
  if (!row.online) patch.online = true;
  if (Object.keys(patch).length === 0) return { nextPingInMs: interval, wrote: false };
  // An expired watch is dropped with a write that happens anyway.
  if (row.fastUntil !== undefined && !fast) patch.fastUntil = undefined;
  await ctx.db.patch(row._id, patch);
  if (!row.online) {
    await setPresence(ctx, ids, { online: true, since: now });
    await bumpOnline(ctx, ids, 1);
  }
  return { nextPingInMs: interval, wrote: true };
}

/** Online -> offline (sweep): "Offline since" = the last contact. */
export async function markOffline(ctx: { db: DatabaseWriter }, row: Doc<"deviceLiveness">): Promise<void> {
  const ids = { deviceId: row.deviceId, orgId: row.orgId };
  await ctx.db.patch(row._id, { online: false });
  await setPresence(ctx, ids, { online: false, since: row.seenBucket * MINUTE_MS });
  await bumpOnline(ctx, ids, -1);
}

/** A revoked device leaves the online count for good. */
export async function markRevoked(ctx: { db: DatabaseWriter }, ids: Ids, now: number): Promise<void> {
  const row = await ctx.db
    .query("deviceLiveness")
    .withIndex("by_device", (q) => q.eq("deviceId", ids.deviceId))
    .unique();
  if (row !== null && row.online) {
    await ctx.db.patch(row._id, { online: false, pendingCheck: undefined, fastUntil: undefined });
    await bumpOnline(ctx, ids, -1);
  }
  await setPresence(ctx, ids, { online: false, since: now, revoked: true });
}
