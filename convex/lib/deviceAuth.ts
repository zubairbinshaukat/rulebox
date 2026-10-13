import type { DatabaseReader } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";

/** SHA-256 of the UTF-8 bytes of `text`, as 64 lowercase hex characters. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  let out = "";
  for (const byte of new Uint8Array(digest)) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

/** Compare two strings without returning early at the first difference. */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export type DeviceCheck =
  | { kind: "ok"; device: Doc<"devices"> }
  | { kind: "revoked"; device: Doc<"devices"> }
  | { kind: "unknown" };

/**
 * Authenticate a device by id and secret (Phase 2, Q1: no JWT yet).
 *
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
  const presented = await sha256Hex(args.deviceSecret);
  if (!constantTimeEqual(presented, device.secretHash)) {
    return { kind: "unknown" };
  }
  return device.revoked ? { kind: "revoked", device } : { kind: "ok", device };
}

/**
 * The device when the id and secret match and it is not revoked, otherwise
 * null (missing, wrong secret or revoked).
 */
export async function requireDevice(
  ctx: { db: DatabaseReader },
  args: { deviceId: string; deviceSecret: string },
): Promise<Doc<"devices"> | null> {
  const check = await checkDevice(ctx, args);
  return check.kind === "ok" ? check.device : null;
}
