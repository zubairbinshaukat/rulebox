import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { concatBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { base64Decode, base64Encode, randomBytes, type ActionOnly } from "./crypto";
import type { OpenedOrgKey } from "./keyring";
import type { SealedBoxValue } from "./lockdownValidators";
import { keyIdOf } from "./signing";

// Sealed boxes `rulebox.seal/1` (Phase 5 Step 10, plan 4.18) and encryption at rest.
// The Rust side is `crates/rulebox-policy/src/seal.rs`; `tests/vectors/seal.json`
// (written by `scripts/vectors/seal.mjs` with these same libraries) pins both.
//
// SEALING FOR ONE DEVICE (a Wi-Fi passphrase on its way into the signed document):
//   ephemeral X25519 pair; shared secret with the device's public sealing key;
//   key = HKDF-SHA256(shared, salt = epk || devicePk,
//         info = "rulebox.seal/1|" + orgId + "|" + deviceId + "|wifi|" + profileId);
//   cipher = XChaCha20-Poly1305, a random 24-byte nonce, no additional data.
//   The binding to org, device and profile makes a box copied elsewhere useless.
//   It needs randomness (the ephemeral key and the nonce), so it is ACTION-ONLY
//   (`ActionOnly` is a type error in a query or mutation). `sealWith` is the pure
//   core: the caller supplies the randomness (tests, the vectors).
//
// AT REST (`wifiProfiles.passphrase`): XChaCha20-Poly1305 under the organization's
// sealing key (`lib/keyring.ts`), a random nonce, additional data
// `orgId|profileId|revision`. `sealed` = base64(nonce || ciphertext + tag).
//
// Nothing here logs, returns in an error or stores a plaintext or a key.

export const SEAL_VERSION = 1;
const INFO_PREFIX = "rulebox.seal/1|";
const NONCE_LEN = 24;
/** The longest plaintext a box holds (a Wi-Fi passphrase is at most 63 characters). */
export const MAX_SEAL_PLAINTEXT = 256;

export type SealIds = { orgId: string; deviceId: string; profileId: string };

function sealInfo(ids: SealIds): Uint8Array | null {
  if ([ids.orgId, ids.deviceId, ids.profileId].some((id) => id.length === 0 || id.includes("|"))) return null;
  return utf8ToBytes(`${INFO_PREFIX}${ids.orgId}|${ids.deviceId}|wifi|${ids.profileId}`);
}

/** The id of a device sealing key: the first 16 hex characters of SHA-256 of the 32 public-key bytes (same as a signing key id). */
export function sealKeyIdOf(devicePublic: Uint8Array): string {
  return keyIdOf(devicePublic);
}

/** A 32-byte X25519 public key in standard base64, or null (wrong length, bad base64, all zero). */
export function decodeSealPublicKey(b64: string): Uint8Array | null {
  const bytes = base64Decode(b64.trim());
  if (bytes === null || bytes.length !== 32 || bytes.every((b) => b === 0)) return null;
  return bytes;
}

/**
 * The pure core of `sealForDevice`: seal `plaintext` for `devicePublic` with the given
 * ephemeral secret and nonce. Null when an id is empty or contains `|`, the plaintext is
 * too long, or the key is a low-order point (the shared secret would be all zero).
 */
export function sealWith(p: {
  plaintext: string;
  devicePublic: Uint8Array;
  ephemeralSecret: Uint8Array;
  nonce: Uint8Array;
  ids: SealIds;
}): SealedBoxValue | null {
  const info = sealInfo(p.ids);
  const data = utf8ToBytes(p.plaintext);
  if (info === null || data.length > MAX_SEAL_PLAINTEXT || p.nonce.length !== NONCE_LEN || p.devicePublic.length !== 32) return null;
  try {
    const epk = x25519.getPublicKey(p.ephemeralSecret);
    const shared = x25519.getSharedSecret(p.ephemeralSecret, p.devicePublic);
    const key = hkdf(sha256, shared, concatBytes(epk, p.devicePublic), info, 32);
    const ct = xchacha20poly1305(key, p.nonce).encrypt(data);
    return {
      v: SEAL_VERSION,
      keyId: sealKeyIdOf(p.devicePublic),
      epk: base64Encode(epk),
      nonce: base64Encode(p.nonce),
      ct: base64Encode(ct),
    };
  } catch {
    return null;
  }
}

/** Seal `plaintext` for one device (random ephemeral key and nonce). Actions only. Null: see `sealWith`. */
export function sealForDevice(ctx: ActionOnly, plaintext: string, devicePublicB64: string, ids: SealIds): SealedBoxValue | null {
  const devicePublic = decodeSealPublicKey(devicePublicB64);
  if (devicePublic === null) return null;
  return sealWith({ plaintext, devicePublic, ephemeralSecret: randomBytes(ctx, 32), nonce: randomBytes(ctx, NONCE_LEN), ids });
}

/**
 * Open a box with the device's PRIVATE key. Only tests and the vector check use it (the
 * server never has a device's private key); it is the mirror of `open_sealed` in Rust.
 */
export function openSealed(box: SealedBoxValue, deviceSecret: Uint8Array, ids: SealIds): string | null {
  const info = sealInfo(ids);
  const epk = base64Decode(box.epk);
  const nonce = base64Decode(box.nonce);
  const ct = base64Decode(box.ct);
  if (info === null || box.v !== SEAL_VERSION || epk === null || epk.length !== 32 || nonce === null || nonce.length !== NONCE_LEN || ct === null) return null;
  try {
    const devicePublic = x25519.getPublicKey(deviceSecret);
    if (box.keyId !== sealKeyIdOf(devicePublic)) return null;
    const shared = x25519.getSharedSecret(deviceSecret, epk);
    const key = hkdf(sha256, shared, concatBytes(epk, devicePublic), info, 32);
    return new TextDecoder().decode(xchacha20poly1305(key, nonce).decrypt(ct));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- at rest

export type AtRestBinding = { orgId: string; profileId: string; revision: number };

function atRestAad(b: AtRestBinding): Uint8Array {
  return utf8ToBytes(`${b.orgId}|${b.profileId}|${b.revision}`);
}

/** Encrypt `plaintext` under the organization's sealing key (random nonce: actions only). */
export function encryptAtRest(ctx: ActionOnly, key: OpenedOrgKey, plaintext: string, binding: AtRestBinding): { keyId: string; sealed: string } {
  const nonce = randomBytes(ctx, NONCE_LEN);
  const ct = xchacha20poly1305(key.secret, nonce, atRestAad(binding)).encrypt(utf8ToBytes(plaintext));
  return { keyId: key.keyId, sealed: base64Encode(concatBytes(nonce, ct)) };
}

/** Decrypt a value written by `encryptAtRest`. Null when the key id differs or anything about the box or the binding is off. */
export function decryptAtRest(key: OpenedOrgKey, box: { keyId: string; sealed: string }, binding: AtRestBinding): string | null {
  if (box.keyId !== key.keyId) return null;
  const raw = base64Decode(box.sealed);
  if (raw === null || raw.length < NONCE_LEN + 16) return null;
  try {
    return new TextDecoder().decode(xchacha20poly1305(key.secret, raw.slice(0, NONCE_LEN), atRestAad(binding)).decrypt(raw.slice(NONCE_LEN)));
  } catch {
    return null;
  }
}
