import { constantTimeEqual, CROCKFORD, normalizeCrockford, randomCrockford, sha256HexSync, type ActionOnly } from "./crypto";
import { RECOVERY_CODE_COUNT } from "./limits";

// One-time recovery codes: `XXXX-XXXX`, 8 Crockford characters (40 bits),
// stored as SHA-256 only. Used by the TOTP enrolment (until WP5b removes it)
// and, since Phase 4b, as the fallback of the action PIN
// (`stepUpFactors.recoveryHashes`). Guessing is bounded by a per-user rate
// limit (`recoveryCodePerUser`) and the global step-up failure bucket.

/** SHA-256 of the normalized code (`XXXX-XXXX`, Crockford). */
export function recoveryHash(code: string): string {
  const n = normalizeCrockford(code);
  return sha256HexSync(n.length === 8 ? `${n.slice(0, 4)}-${n.slice(4)}` : n);
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
