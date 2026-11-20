import { ed25519 } from "@noble/curves/ed25519.js";
import { blake2b } from "@noble/hashes/blake2.js";
import { concatBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { base64Decode } from "../crypto";

// Minisign verification for Tauri updater feeds (plan Phase 6, 4.5). PURE: bytes in, boolean out.
//
// Encoding, pinned by the vectors in `convex/testdata/feed/` (made with `tauri signer`, tauri-cli 2.12.2):
//  - A feed's `pubkey` (and `latest.json`'s `signature`) is the BASE64 of the text of the `.pub` (the `.sig`) FILE.
//  - `.pub` file: line 1 `untrusted comment: ...`, line 2 base64 of 42 bytes = "Ed" + key id (8) + Ed25519 public key (32).
//  - `.sig` file (4 lines): `untrusted comment: ...`; base64 of 74 bytes = "ED" + key id (8) + signature (64); `trusted comment: ...`;
//    base64 of the 64 byte GLOBAL signature, over (the 64 signature bytes || the trusted comment's text).
//  - Algorithm "ED" means PREHASHED: the first signature is over BLAKE2b-512 of the file, so a streaming download needs no
//    copy of the file. "Ed" (a signature over the whole file) is a legacy form that Tauri's signer never writes: refused here.

export type MinisignKey = { keyId: Uint8Array; key: Uint8Array };
export type MinisignSignature = {
  keyId: Uint8Array;
  /** The signature over BLAKE2b-512 of the file. */
  signature: Uint8Array;
  trustedComment: string;
  /** The signature over (`signature` || the trusted comment's UTF-8 bytes). */
  globalSignature: Uint8Array;
};

const ALG_KEY = [0x45, 0x64]; // "Ed"
const ALG_PREHASHED = [0x45, 0x44]; // "ED"
const TRUSTED = "trusted comment: ";

/** The decoded text of a base64 minisign file, split into lines (CRLF tolerated), or null. */
function linesOf(b64: string): string[] | null {
  const bytes = base64Decode(b64.replace(/\s+/g, ""));
  if (bytes === null || bytes.length === 0 || bytes.length > 4096) return null;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  const lines = text.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function bytesOfLine(line: string | undefined, length: number, alg: readonly number[]): Uint8Array | null {
  if (line === undefined) return null;
  const bytes = base64Decode(line.trim());
  if (bytes === null || bytes.length !== length) return null;
  if (bytes[0] !== alg[0] || bytes[1] !== alg[1]) return null;
  return bytes;
}

export function parsePublicKey(b64: string): MinisignKey | null {
  const lines = linesOf(b64);
  if (lines === null || lines.length < 2 || !lines[0]!.startsWith("untrusted comment:")) return null;
  const bytes = bytesOfLine(lines[1], 42, ALG_KEY);
  if (bytes === null) return null;
  return { keyId: bytes.slice(2, 10), key: bytes.slice(10, 42) };
}

/** `null` for anything that is not a prehashed minisign signature file (including a legacy "Ed" one). */
export function parseSignature(b64: string): MinisignSignature | null {
  const lines = linesOf(b64);
  if (lines === null || lines.length !== 4 || !lines[0]!.startsWith("untrusted comment:") || !lines[2]!.startsWith(TRUSTED)) return null;
  const first = bytesOfLine(lines[1], 74, ALG_PREHASHED);
  const global = base64Decode(lines[3]!.trim());
  if (first === null || global === null || global.length !== 64) return null;
  return { keyId: first.slice(2, 10), signature: first.slice(10, 74), trustedComment: lines[2]!.slice(TRUSTED.length), globalSignature: global };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

function verifyEd(signature: Uint8Array, message: Uint8Array, key: Uint8Array): boolean {
  try {
    // Strict RFC 8032 verification (no ZIP-215 leniency): the vendor's key is fixed, so there is no reason to accept odd encodings.
    return ed25519.verify(signature, message, key, { zip215: false });
  } catch {
    return false;
  }
}

/**
 * True when `signatureB64` is a valid minisign signature, made with the key `pubkeyB64`, over the file whose BLAKE2b-512
 * digest is `digest` (both the file signature and the global signature over its trusted comment are checked, as `minisign -V` does).
 */
export function verifyPrehashed(pubkeyB64: string, signatureB64: string, digest: Uint8Array): boolean {
  const key = parsePublicKey(pubkeyB64);
  const sig = parseSignature(signatureB64);
  if (key === null || sig === null || digest.length !== 64) return false;
  if (!sameBytes(key.keyId, sig.keyId)) return false;
  if (!verifyEd(sig.signature, digest, key.key)) return false;
  return verifyEd(sig.globalSignature, concatBytes(sig.signature, utf8ToBytes(sig.trustedComment)), key.key);
}

/** BLAKE2b-512 of `bytes` (tests, and the one-shot form of what the downloader computes while streaming). */
export function blake2b512(bytes: Uint8Array): Uint8Array {
  return blake2b(bytes, { dkLen: 64 });
}
