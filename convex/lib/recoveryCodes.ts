import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { env } from "../_generated/server";
import { constantTimeEqual, CROCKFORD, normalizeCrockford, randomCrockford, type ActionOnly } from "./crypto";
import { fail } from "./errors";
import { RECOVERY_CODE_COUNT } from "./limits";

// One-time recovery codes: `XXXX-XXXX`, 8 Crockford characters (40 bits), the
// fallback of the action PIN (`stepUpFactors.recoveryHashes`). Stored as
// HMAC-SHA-256 keyed with a server pepper (Convex env RULEBOX_RECOVERY_PEPPER),
// not a bare hash: 40 bits are cracked offline in minutes from a leaked
// database, but not without the pepper. Guessing online is bounded by a
// per-user rate limit (`recoveryCodePerUser`) and the global step-up failure
// bucket. Without the pepper nothing is hashed or matched (`not_ready`, fail
// closed). Rotating the pepper invalidates every stored code (people generate
// new ones); hashes written before the pepper existed (plain SHA-256, dev data
// only) simply never match.

/** At least this many characters, so a typo-short value is not accepted as a key. */
const MIN_PEPPER_LENGTH = 32;

/** The pepper's bytes, or null when the env value is missing or too short. */
export function recoveryPepper(): Uint8Array | null {
  const raw = (env.RULEBOX_RECOVERY_PEPPER ?? "").trim();
  return raw.length < MIN_PEPPER_LENGTH ? null : utf8ToBytes(raw);
}

export function requirePepper(): Uint8Array {
  const pepper = recoveryPepper();
  if (pepper === null) fail("not_ready", { detail: "RULEBOX_RECOVERY_PEPPER is missing or too short" });
  return pepper;
}

/** HMAC-SHA-256 (hex) of the normalized code (`XXXX-XXXX`, Crockford) under the server pepper. Throws `not_ready` without one. */
export function recoveryHash(code: string): string {
  const pepper = requirePepper();
  const n = normalizeCrockford(code);
  const canonical = n.length === 8 ? `${n.slice(0, 4)}-${n.slice(4)}` : n;
  return bytesToHex(hmac(sha256, pepper, utf8ToBytes(`rulebox.recoveryCode.v1:${canonical}`)));
}

/** Plausible recovery code: 8 Crockford characters after normalization. */
export function isRecoveryShape(code: string): boolean {
  const n = normalizeCrockford(code);
  return n.length === 8 && [...n].every((c) => CROCKFORD.includes(c));
}

/**
 * Index of the stored hash `code` matches, or null. Every stored hash is
 * compared (no early exit); a code of the wrong shape matches nothing.
 */
export function matchRecoveryHash(hashes: readonly string[], code: string): number | null {
  requirePepper(); // fail closed even for a malformed code
  const presented = isRecoveryShape(code) ? recoveryHash(code) : "";
  let index = -1;
  hashes.forEach((h, i) => {
    if (constantTimeEqual(h, presented) && presented !== "" && index === -1) index = i;
  });
  return index === -1 ? null : index;
}

/** RECOVERY_CODE_COUNT new codes from a secure source. Actions only. */
export function newRecoveryCodes(ctx: ActionOnly): string[] {
  const codes: string[] = [];
  for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
    const raw = randomCrockford(ctx, 8);
    codes.push(`${raw.slice(0, 4)}-${raw.slice(4)}`);
  }
  return codes;
}
