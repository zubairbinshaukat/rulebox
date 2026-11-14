// Test-only helpers for the Phase 5 server tests (Step 10): throwaway master keys, per-organization
// keys made through the real action, Wi-Fi rows with a real at-rest passphrase, device sealing keys.
// Outside convex/ so the Convex bundler never pushes it.
import { x25519 } from "@noble/curves/ed25519.js";
import { internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { base64Encode } from "../../convex/lib/crypto";
import { openWrappedRow } from "../../convex/lib/keyring";
import { decodeSealPublicKey, encryptAtRest, sealKeyIdOf } from "../../convex/lib/sealbox";
import type { T } from "./identity";

declare const process: { env: Record<string, string | undefined> };

/** Throwaway master keys (never real). */
export const MASTER_A = base64Encode(Uint8Array.from({ length: 32 }, (_, i) => 200 - i));
export const MASTER_B = base64Encode(Uint8Array.from({ length: 32 }, (_, i) => 30 + i));

/** Put master keys into the env the keyring reads. Undefined clears it. */
export function setMaster(active: string | undefined, next?: string): void {
  if (active === undefined) delete process.env.RULEBOX_MASTER_KEY;
  else process.env.RULEBOX_MASTER_KEY = active;
  if (next === undefined) delete process.env.RULEBOX_MASTER_KEY_NEXT;
  else process.env.RULEBOX_MASTER_KEY_NEXT = next;
}

/** A device's X25519 sealing key pair from a one-byte seed (tests only). */
export function sealKeyPair(seed = 5): { secret: Uint8Array; publicB64: string; keyId: string } {
  const secret = new Uint8Array(32).fill(seed);
  const pub = x25519.getPublicKey(secret);
  return { secret, publicB64: base64Encode(pub), keyId: sealKeyIdOf(decodeSealPublicKey(base64Encode(pub))!) };
}

/** Give a device a sealing key directly (what `registerSealKey` stores). */
export async function giveSealKey(t: T, deviceId: Id<"devices">, seed = 5): Promise<ReturnType<typeof sealKeyPair>> {
  const kp = sealKeyPair(seed);
  await t.run((ctx) => ctx.db.patch(deviceId, { sealPublicKey: kp.publicB64, sealKeyId: kp.keyId }));
  return kp;
}

/** Run the real `keys:createOrgKeys` action (needs a master key in the env). */
export async function createKeys(t: T, orgId: Id<"organizations">) {
  return await t.action(internal.keys.createOrgKeys, { orgId });
}

/**
 * A Wi-Fi profile whose passphrase is really encrypted under the organization's sealing key
 * (what the later `wifi:setPassphrase` action will store). The organization needs its keys.
 */
export async function addWifi(
  t: T,
  orgId: Id<"organizations">,
  o: { groupIds: Id<"groups">[]; ssid?: string; passphrase?: string | null; revision?: number; security?: "open" | "wpa2Personal" },
): Promise<Id<"wifiProfiles">> {
  const revision = o.revision ?? 1;
  const id = await t.run((ctx) =>
    ctx.db.insert("wifiProfiles", {
      orgId,
      name: o.ssid ?? "Office",
      ssid: o.ssid ?? "Office",
      hidden: false,
      security: o.security ?? "wpa2Personal",
      autoConnect: true,
      groupIds: o.groupIds,
      revision,
      createdAt: Date.now(),
    }),
  );
  if (o.passphrase !== null) await setWifiPassphrase(t, orgId, id, o.passphrase ?? "correct horse battery", revision);
  return id;
}

export async function setWifiPassphrase(t: T, orgId: Id<"organizations">, profileId: Id<"wifiProfiles">, passphrase: string, revision: number): Promise<void> {
  await t.run(async (ctx) => {
    const row = await ctx.db
      .query("orgKeys")
      .withIndex("by_org_purpose_status", (q) => q.eq("orgId", orgId).eq("purpose", "sealing").eq("status", "active"))
      .first();
    if (row === null) throw new Error("the organization has no sealing key");
    const key = openWrappedRow(row, orgId, "sealing");
    if (key === null) throw new Error("the sealing key does not open (master key?)");
    await ctx.db.patch(profileId, { passphrase: encryptAtRest({ runAction: null }, key, passphrase, { orgId, profileId, revision }), revision });
  });
}
