import * as ed from "@noble/ed25519";
import { sha256, sha512 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import type { Doc, Id } from "../_generated/dataModel";
import { env, type DatabaseReader } from "../_generated/server";
import { base64Decode, base64Encode } from "./crypto";

// Policy signing (plan 4.5, Step 8 items 1 and 9; A11). Ed25519 (RFC 8032)
// in pure JS (@noble/ed25519 with @noble/hashes SHA-512), so documents are
// signed inside the publisher MUTATION, in the same transaction that writes
// them. Signing needs no randomness (Ed25519 is deterministic).
//
// THE ONLY MODULE THAT READS THE SIGNING SEED (`RULEBOX_POLICY_KEY` /
// `RULEBOX_POLICY_KEY_NEXT`; a lint rule names this file). The seed never
// leaves this module except inside a `SigningKey` handed to a signer in the
// same function call: it is never stored, returned by a function, logged or
// put in an error. Every signer gets its key from `loadOrgSigningKey`, which
// also checks that the organization registered that key (`policyKeys`).
// Phase 5 swaps the body of `loadSigningKey` for per-organization keys
// without touching any caller.

ed.hashes.sha512 = sha512;

/** First line of the message an active key signs to vouch for the next one. */
export const ENDORSEMENT_FORMAT = "rulebox.key-endorsement/1";

export type Which = "active" | "next";

/** A loaded key. `seed` is secret: use it only to call `signPayload` in this call. */
export type SigningKey = {
  readonly seed: Uint8Array;
  readonly publicKey: Uint8Array;
  readonly publicKeyB64: string;
  readonly keyId: string;
};

/** The public half of a key: safe to return, store and log. */
export type PublicKeyInfo = { keyId: string; publicKey: string };

/** Key id: the first 16 lower-case hex characters of SHA-256 of the 32 raw public-key bytes. */
export function keyIdOf(publicKey: Uint8Array): string {
  return bytesToHex(sha256(publicKey)).slice(0, 16);
}

/** Key id in groups of 4 for people to compare ("3f2a 9c0d 11e4 b7a8"). */
export function fingerprintOf(keyId: string): string {
  return keyId.replace(/(.{4})(?=.)/g, "$1 ");
}

/** Standard base64 of exactly 32 bytes, else null. */
export function decodeKey32(b64: string): Uint8Array | null {
  const bytes = base64Decode(b64.trim());
  return bytes !== null && bytes.length === 32 ? bytes : null;
}

/**
 * The key of a 32-byte seed. `seed` is a NON-enumerable property, so a
 * `SigningKey` that ends up in a log line, an error message or
 * `JSON.stringify` (by mistake) shows only its public half.
 */
export function keyFromSeed(seed: Uint8Array): SigningKey {
  const publicKey = ed.getPublicKey(seed);
  const key = { publicKey, publicKeyB64: base64Encode(publicKey), keyId: keyIdOf(publicKey) };
  Object.defineProperty(key, "seed", { value: seed, enumerable: false, writable: false });
  return key as SigningKey;
}

/**
 * The seed in the environment, or null when it is missing or malformed (not
 * standard base64 of 32 bytes): the caller treats both as "missing". PRIVATE
 * to this module (A11).
 */
function loadSigningKey(which: Which): SigningKey | null {
  const raw = which === "active" ? env.RULEBOX_POLICY_KEY : env.RULEBOX_POLICY_KEY_NEXT;
  if (raw === undefined) return null;
  const seed = decodeKey32(raw);
  return seed === null ? null : keyFromSeed(seed);
}

/** The PUBLIC half of the environment's key (for registering it), or null. Never the seed. */
export function envPublicKey(which: Which): PublicKeyInfo | null {
  const key = loadSigningKey(which);
  return key === null ? null : { keyId: key.keyId, publicKey: key.publicKeyB64 };
}

export type OrgKeyResult =
  | { ok: true; key: SigningKey; row: Doc<"policyKeys"> }
  /** missing: no (valid) env seed. mismatch: the org has no `policyKeys` row with that key in this status. */
  | { ok: false; reason: "missing" | "mismatch" };

/**
 * THE signing entry point (A11): the environment's `which` key, only when the
 * organization registered exactly that key with status `which`. 1 read
 * (`policyKeys.by_org_key_id`). Anything else is refused, so a key set on the
 * deployment can never sign for an organization that did not register it.
 */
export async function loadOrgSigningKey(
  ctx: { db: DatabaseReader },
  orgId: Id<"organizations">,
  which: Which,
): Promise<OrgKeyResult> {
  const key = loadSigningKey(which);
  if (key === null) return { ok: false, reason: "missing" };
  const row = await ctx.db
    .query("policyKeys")
    .withIndex("by_org_key_id", (q) => q.eq("orgId", orgId).eq("keyId", key.keyId))
    .first();
  if (row === null || row.status !== which || row.publicKey !== key.publicKeyB64) {
    return { ok: false, reason: "mismatch" };
  }
  return { ok: true, key, row };
}

/** Standard base64 (with padding) of the 64-byte Ed25519 signature of the UTF-8 bytes of `payload`. */
export function signPayload(payload: string, seed: Uint8Array): string {
  return base64Encode(ed.sign(utf8ToBytes(payload), seed));
}

/**
 * RFC 8032 verification of `signatureB64` over the UTF-8 bytes of `payload`
 * (`zip215: false`: the strict rules, like the agent's `verify_strict`).
 * False for any malformed input; never throws.
 */
export function verifyPayload(payload: string, signatureB64: string, publicKey: Uint8Array): boolean {
  const sig = base64Decode(signatureB64);
  if (sig === null || sig.length !== 64 || publicKey.length !== 32) return false;
  try {
    return ed.verify(sig, utf8ToBytes(payload), publicKey, { zip215: false });
  } catch {
    return false;
  }
}

/** What an active key signs to endorse the next key (plan 4.5 rotation step 2). */
export function endorsementMessage(keyId: string, publicKeyB64: string): string {
  return `${ENDORSEMENT_FORMAT}\n${keyId}\n${publicKeyB64}`;
}
