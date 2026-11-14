import * as ed from "@noble/ed25519";
import { sha256, sha512 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import type { Doc, Id } from "../_generated/dataModel";
import { env, type DatabaseReader } from "../_generated/server";
import { base64Decode, base64Encode } from "./crypto";
import { openOrgKey } from "./keyring";

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
// Phase 5 Step 10: `loadOrgSigningKey` prefers the organization's OWN key from the
// keyring (`orgKeys`, wrapped by the deployment master key); the env seed stays only
// for organizations that have none yet (and is read by `withEnvSigningSeed` for the
// one-time `keys:migrateFromEnv`). No caller changed.

ed.hashes.sha512 = sha512;

/** First line of the message an active key signs to vouch for the next one. */
export const ENDORSEMENT_FORMAT = "rulebox.key-endorsement/1";

export type Which = "active" | "next";

/** A loaded key. `seed` is secret: sign with `signWith(key, ...)`, never read the seed outside this module. */
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

/**
 * The ONE route for the deployment's env seed to leave this module (Phase 5 Step 10,
 * plan 4.18): `keys:migrateFromEnv` hands it to the keyring to wrap it as the
 * organization's signing key (same key id, so no device is re-enrolled). `use` runs
 * in the caller's action (`handle`) and must not store, log or return the seed itself. Null when
 * the env holds no valid seed.
 */
export function withEnvSigningSeed<R>(which: Which, handle: (seedBytes: Uint8Array, info: PublicKeyInfo) => R): R | null {
  const key = loadSigningKey(which);
  return key === null ? null : handle(key.seed, { keyId: key.keyId, publicKey: key.publicKeyB64 });
}

export type OrgKeyResult =
  | { ok: true; key: SigningKey; row: Doc<"policyKeys"> }
  /** missing: no usable seed (no env seed, or the organization's wrapped key cannot be opened). mismatch: the org has no `policyKeys` row with that key in this status. */
  | { ok: false; reason: "missing" | "mismatch" };

/**
 * THE signing entry point (A11). The organization's key of status `which`, only when
 * the organization registered exactly that key (`policyKeys`, 1 read through
 * `by_org_key_id`). Anything else is refused, so a key can never sign for an
 * organization that did not register it.
 *
 * Where the key comes from (Phase 5 Step 10, plan 4.18):
 * 1. The organization has `orgKeys` rows: its OWN signing seed, opened with the
 *    deployment master key (`lib/keyring.ts`). When it cannot be opened (master key
 *    missing or wrong) the answer is `missing`; the deployment key is NOT tried, so a
 *    stale env seed can never sign for an organization that has its own key.
 * 2. No `orgKeys` row (an organization not migrated yet): the deployment's env seed
 *    `RULEBOX_POLICY_KEY[_NEXT]`, exactly as in Phase 4. `keys:migrateFromEnv` moves an
 *    organization from 2 to 1; the env variable goes away once every one has moved.
 */
export async function loadOrgSigningKey(
  ctx: { db: DatabaseReader },
  orgId: Id<"organizations">,
  which: Which,
): Promise<OrgKeyResult> {
  const own = await openOrgKey(ctx, orgId, "signing", which);
  let key: SigningKey | null;
  if (own.kind === "locked") return { ok: false, reason: "missing" };
  if (own.kind === "open") key = keyFromSeed(own.key.secret);
  else key = loadSigningKey(which);
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

/**
 * Sign with a loaded key: standard base64 (with padding) of the 64-byte
 * Ed25519 signature of the UTF-8 bytes of `message`. THE function the
 * publisher, the roster log and the rotation endorsement use, so no caller
 * touches `key.seed`.
 */
export function signWith(key: SigningKey, message: string): string {
  return signPayload(message, key.seed);
}

/**
 * Same as `signWith` for a bare seed. For tests and the vector generator
 * (which hold the published RFC 8032 test seeds); production code uses
 * `signWith` (a lint rule keeps `.seed` out of the other modules).
 */
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

/**
 * What an active key signs to endorse the next key (plan 4.5 rotation step 2):
 * "rulebox.key-endorsement/1\n<orgId>\n<nextKeyId>\n<nextPublicKeyBase64>".
 * The organization id binds the endorsement to one organization, so it cannot
 * be replayed to the devices of another one (2026-11-01, Step 9 part A).
 */
export function endorsementMessage(orgId: string, keyId: string, publicKeyB64: string): string {
  return `${ENDORSEMENT_FORMAT}\n${orgId}\n${keyId}\n${publicKeyB64}`;
}
