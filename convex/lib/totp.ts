import { hmac } from "@noble/hashes/hmac.js";
import { sha1 } from "@noble/hashes/legacy.js";
import { base32Decode, constantTimeEqual, CROCKFORD, normalizeCrockford, sha256HexSync } from "./crypto";

// TOTP, RFC 6238: HMAC-SHA-1, 6 digits, 30-second steps, window +-1 step.

export const TOTP_PERIOD_S = 30;
export const TOTP_DIGITS = 6;
export const TOTP_WINDOW = 1;

/** RFC 4226 HOTP value for `counter`, as a zero-padded string of `digits`. */
export function hotp(key: Uint8Array, counter: number, digits = TOTP_DIGITS): string {
  const msg = new Uint8Array(8);
  // Counter as a 64-bit big-endian integer (exact up to 2^53).
  let c = counter;
  for (let i = 7; i >= 0; i--) {
    msg[i] = c & 0xff;
    c = Math.floor(c / 256);
  }
  const mac = hmac(sha1, key, msg);
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin =
    ((mac[offset]! & 0x7f) << 24) |
    (mac[offset + 1]! << 16) |
    (mac[offset + 2]! << 8) |
    mac[offset + 3]!;
  return (bin % 10 ** digits).toString().padStart(digits, "0");
}

export function stepAt(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_PERIOD_S);
}

/** Digits only, spaces removed; null when it is not exactly 6 digits. */
export function normalizeTotpCode(code: string): string | null {
  const clean = code.replace(/\s/g, "");
  return /^[0-9]{6}$/.test(clean) ? clean : null;
}

/**
 * The step a code matches within +-TOTP_WINDOW of `nowMs`, or null. Steps at
 * or below `lastStep` are refused (replay protection). Every candidate is
 * compared, in constant time.
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  nowMs: number,
  lastStep: number,
): number | null {
  const key = base32Decode(secretBase32);
  const clean = normalizeTotpCode(code);
  if (key === null || key.length === 0 || clean === null) return null;
  const now = stepAt(nowMs);
  let matched: number | null = null;
  for (let delta = -TOTP_WINDOW; delta <= TOTP_WINDOW; delta++) {
    const step = now + delta;
    const ok = constantTimeEqual(hotp(key, step), clean);
    if (ok && step > lastStep && matched === null) matched = step;
  }
  return matched;
}

export function otpauthUri(email: string, secretBase32: string): string {
  const label = encodeURIComponent(`Rulebox:${email}`);
  return `otpauth://totp/${label}?secret=${secretBase32}&issuer=Rulebox&algorithm=SHA1&digits=6&period=30`;
}

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
