import type { DatabaseReader, DatabaseWriter } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import { constantTimeEqual, sha256HexSync } from "./crypto";

/** SHA-256 of the UTF-8 bytes of `text`, as 64 lowercase hex characters. */
export async function sha256Hex(text: string): Promise<string> {
  return sha256HexSync(text);
}

export type DeviceCheck =
  | { kind: "ok"; device: Doc<"devices">; matched: "current" | "previous" }
  | { kind: "revoked"; device: Doc<"devices"> }
  | { kind: "unknown" };

/**
 * Authenticate a device by id and secret (plan 4.6, D4).
 *
 * The secret may match `secretHash` or, during a credential rotation,
 * `previousSecretHash`. Both comparisons always run (constant time).
 * `unknown` covers a malformed or missing id and a wrong secret, so a caller
 * without the secret cannot learn whether a device exists or was revoked.
 * `deviceId` is a plain string on the wire; it is normalized here so a garbage
 * id answers `unknown` instead of failing argument validation.
 */
export async function checkDevice(
  ctx: { db: DatabaseReader },
  args: { deviceId: string; deviceSecret: string },
): Promise<DeviceCheck> {
  const id = ctx.db.normalizeId("devices", args.deviceId);
  if (id === null) return { kind: "unknown" };
  const device = await ctx.db.get(id);
  if (device === null) return { kind: "unknown" };
  const presented = sha256HexSync(args.deviceSecret);
  const current = constantTimeEqual(presented, device.secretHash);
  const previous =
    device.previousSecretHash !== undefined &&
    constantTimeEqual(presented, device.previousSecretHash);
  if (!current && !previous) return { kind: "unknown" };
  if (device.revoked) return { kind: "revoked", device };
  return { kind: "ok", device, matched: current ? "current" : "previous" };
}

/**
 * Mutations only: a device that authenticated with its new secret has adopted
 * it, so the old one stops working (plan 4.6).
 */
export async function settleRotation(
  ctx: { db: DatabaseWriter },
  check: DeviceCheck,
): Promise<void> {
  if (
    check.kind === "ok" &&
    check.matched === "current" &&
    check.device.previousSecretHash !== undefined
  ) {
    await ctx.db.patch(check.device._id, { previousSecretHash: undefined });
  }
}
