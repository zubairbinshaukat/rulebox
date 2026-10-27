import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

// Small crypto helpers shared by functions. Random values are made ONLY in
// actions (plan Section 6: `crypto.getRandomValues` in queries and mutations
// is a seeded generator, not a secure source). Every random helper takes an
// action context so calling it from a query or mutation is a type error.

/** Structural marker of an action context (queries and mutations have no `runAction`). */
export type ActionOnly = { runAction: unknown };

/** SHA-256 of the UTF-8 bytes of `text`, as 64 lower-case hex characters. Synchronous. */
export function sha256HexSync(text: string): string {
  return bytesToHex(sha256(utf8ToBytes(text)));
}

/**
 * Compare two strings in time that depends only on their lengths. Use it for
 * every comparison of a presented secret (or its hash) with a stored one.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    diff |= (a.charCodeAt(i) | 0) ^ (b.charCodeAt(i) | 0);
  }
  return diff === 0;
}

/** Crockford base32 alphabet (no I, L, O, U). */
export const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * `length` Crockford characters from a secure source (5 bits each; 256 is a
 * multiple of 32, so `byte & 31` has no bias). Actions only.
 */
export function randomCrockford(_ctx: ActionOnly, length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) out += CROCKFORD.charAt(byte & 31);
  return out;
}

/** `n` random bytes from a secure source. Actions only. */
export function randomBytes(_ctx: ActionOnly, n: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return bytes;
}

/**
 * Invite and reset codes: 26 Crockford characters = 130 bits (plan says 20 =
 * 100 bits; raised to meet the 128-bit floor for bearer tokens).
 */
export const INVITE_CODE_LENGTH = 26;

/**
 * Normalize a typed code: upper-case, drop spaces and dashes, map the
 * Crockford look-alikes (I, L -> 1; O -> 0). Never throws.
 */
export function normalizeCrockford(input: string): string {
  return input
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
}

/** SHA-256 hex of a normalized code (what `invites.tokenHash` stores). */
export function codeHash(code: string): string {
  return sha256HexSync(normalizeCrockford(code));
}

/** True when `text` contains a C0 control character or DEL. */
export function hasControlChar(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

/** Lower-case, trimmed email. Returns null when it is not plausibly an address. */
export function normalizeEmail(input: string): string | null {
  const email = input.trim().toLowerCase();
  if (email.length < 3 || email.length > 254) return null;
  const at = email.indexOf("@");
  if (at <= 0 || at !== email.lastIndexOf("@") || at === email.length - 1) return null;
  if (/\s/.test(email) || hasControlChar(email)) return null;
  return email;
}

// ---------------------------------------------------------------- base32 (RFC 4648)

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32 without padding (the form authenticator apps expect). */
export function base32Encode(bytes: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32.charAt((buffer >>> (bits - 5)) & 31);
      bits -= 5;
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) out += B32.charAt((buffer << (5 - bits)) & 31);
  return out;
}

/** Decode RFC 4648 base32 (case-insensitive, padding ignored). Null on a bad character. */
export function base32Decode(text: string): Uint8Array | null {
  const clean = text.toUpperCase().replace(/=+$/, "");
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of clean) {
    const value = B32.indexOf(ch);
    if (value < 0) return null;
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      out.push((buffer >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
    buffer &= (1 << bits) - 1;
  }
  return new Uint8Array(out);
}
