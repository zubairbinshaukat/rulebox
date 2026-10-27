import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseReader, DatabaseWriter } from "../_generated/server";
import type { CredentialState } from "./deviceAuth";
import { bumpOrgStatsIfPresent } from "./plans";
import { markRevoked } from "./presence";

// Device lifecycle helpers shared by `devices:unenroll`, `fleet:*`, `dev:*`
// and the migrations (plan Step 7 items 4, 7, 13).

export type CredRef = {
  deviceId: Id<"devices">;
  orgId: Id<"organizations">;
  state: CredentialState;
  /** null: a device enrolled before the credentials split, not migrated yet. */
  row: Doc<"deviceCredentials"> | null;
};

/** The credentials of a device the caller already loaded (1 read). Never leaves the server. */
export async function credOf(ctx: { db: DatabaseReader }, device: Doc<"devices">): Promise<CredRef> {
  const row = await ctx.db
    .query("deviceCredentials")
    .withIndex("by_device", (q) => q.eq("deviceId", device._id))
    .unique();
  if (row !== null) return { deviceId: device._id, orgId: device.orgId, state: row.state, row };
  return { deviceId: device._id, orgId: device.orgId, state: device.revoked === true ? "revoked" : "active", row: null };
}

/**
 * Revoke a device: credentials state `revoked` (any later call is refused),
 * counters (`deviceCount`, `noGroupDeviceCount`, `outOfSupportCount` count
 * non-revoked devices only), presence offline + revoked. Returns the device
 * row, or null when it was already revoked or is gone (nothing written).
 */
export async function revokeDevice(
  ctx: { db: DatabaseWriter },
  cred: CredRef,
  now: number,
): Promise<Doc<"devices"> | null> {
  if (cred.state === "revoked") return null;
  const device = await ctx.db.get(cred.deviceId);
  if (device === null) return null;
  if (cred.row !== null) {
    await ctx.db.patch(cred.row._id, { state: "revoked", rotate: undefined });
  } else {
    await ctx.db.patch(device._id, { revoked: true, rotateCredential: undefined });
  }
  const summary = await ctx.db
    .query("deviceSummary")
    .withIndex("by_device", (q) => q.eq("deviceId", device._id))
    .unique();
  await bumpOrgStatsIfPresent(ctx, device.orgId, {
    deviceCount: -1,
    noGroupDeviceCount: device.groupId === undefined ? -1 : 0,
    outOfSupportCount: summary?.outOfSupport === true ? -1 : 0,
  });
  await markRevoked(ctx, { deviceId: device._id, orgId: device.orgId }, now);
  return device;
}
