import type { DatabaseReader, DatabaseWriter } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { constantTimeEqual, sha256HexSync } from "./crypto";

/** SHA-256 of the UTF-8 bytes of `text`, as 64 lowercase hex characters. */
export async function sha256Hex(text: string): Promise<string> {
  return sha256HexSync(text);
}

export type CredentialState = Doc<"deviceCredentials">["state"];

/** What a device call knows about its caller after the check. Never a hash. */
export type DeviceCred = {
  deviceId: Id<"devices">;
  orgId: Id<"organizations">;
  state: CredentialState;
  rotate: boolean;
  /**
   * The `deviceCredentials` row; null for a device enrolled before the Step 7
   * credentials split whose row `maintenance:migrateDevices` has not created
   * yet (its credentials are still on the `devices` row).
   */
  row: Doc<"deviceCredentials"> | null;
  hasPrevious: boolean;
};

export type DeviceCheck =
  | { kind: "ok"; cred: DeviceCred; matched: "current" | "previous" }
  | { kind: "revoked"; cred: DeviceCred }
  | { kind: "unknown" };

/**
 * Authenticate a device by id and secret (plan 4.6, D4; A2).
 *
 * Reads ONLY `deviceCredentials.by_device` (one ~220-byte row). Until the
 * migration created that row, it falls back to the deprecated fields of the
 * `devices` row (widen-then-narrow, plan Section 11), so an enrolled agent
 * keeps working across the deploy.
 *
 * The secret may match `secretHash` or, during a credential rotation,
 * `previousSecretHash`. Both comparisons always run (constant time).
 * `unknown` covers a malformed or missing id and a wrong secret, so a caller
 * without the secret cannot learn whether a device exists or was revoked.
 */
export async function checkDevice(
  ctx: { db: DatabaseReader },
  args: { deviceId: string; deviceSecret: string },
): Promise<DeviceCheck> {
  const id = ctx.db.normalizeId("devices", args.deviceId);
  if (id === null) return { kind: "unknown" };
  const presented = sha256HexSync(args.deviceSecret);

  const row = await ctx.db
    .query("deviceCredentials")
    .withIndex("by_device", (q) => q.eq("deviceId", id))
    .unique();
  let stored: { secretHash: string; previousSecretHash?: string };
  let cred: DeviceCred;
  if (row !== null) {
    stored = row;
    cred = {
      deviceId: id,
      orgId: row.orgId,
      state: row.state,
      rotate: row.rotate === true,
      row,
      hasPrevious: row.previousSecretHash !== undefined,
    };
  } else {
    // Pre-migration device (deprecated fields; removed by the narrow step).
    const device = await ctx.db.get(id);
    if (device === null || device.secretHash === undefined) return { kind: "unknown" };
    stored = { secretHash: device.secretHash, previousSecretHash: device.previousSecretHash };
    cred = {
      deviceId: id,
      orgId: device.orgId,
      state: device.revoked === true ? "revoked" : "active",
      rotate: device.rotateCredential === true,
      row: null,
      hasPrevious: device.previousSecretHash !== undefined,
    };
  }

  const current = constantTimeEqual(presented, stored.secretHash);
  const previous = stored.previousSecretHash !== undefined && constantTimeEqual(presented, stored.previousSecretHash);
  if (!current && !previous) return { kind: "unknown" };
  if (cred.state === "revoked") return { kind: "revoked", cred };
  return { kind: "ok", cred, matched: current ? "current" : "previous" };
}

/**
 * Mutations only: a device that authenticated with its new secret has adopted
 * it, so the old one stops working (plan 4.6).
 */
export async function settleRotation(ctx: { db: DatabaseWriter }, check: DeviceCheck): Promise<void> {
  if (check.kind !== "ok" || check.matched !== "current" || !check.cred.hasPrevious) return;
  if (check.cred.row !== null) {
    await ctx.db.patch(check.cred.row._id, { previousSecretHash: undefined });
  } else {
    await ctx.db.patch(check.cred.deviceId, { previousSecretHash: undefined });
  }
}
