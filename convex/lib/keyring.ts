import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import type { Id } from "../_generated/dataModel";
import { env, type DatabaseReader } from "../_generated/server";
import { base64Decode, base64Encode, randomBytes, type ActionOnly } from "./crypto";

// The keyring (Phase 5 Step 10, plan 4.18). Every organization has its OWN signing
// seed (Ed25519) and sealing key (32 bytes, symmetric), stored in `orgKeys` WRAPPED
// by the deployment master key. THE ONLY MODULE THAT READS `RULEBOX_MASTER_KEY` /
// `RULEBOX_MASTER_KEY_NEXT` (a lint rule names this file) and the only one that
// reads `orgKeys.wrapped`.
//
// - Wrapping: XChaCha20-Poly1305 (@noble/ciphers), a random 24-byte nonce, additional
//   data `orgId|purpose|keyId` (a wrapped row copied to another organization, purpose or
//   key id does not open). `wrapped` = base64(nonce || ciphertext + tag).
//   The plan names this cipher; `lib/platformSecrets.ts` (AES-GCM, RULEBOX_PLATFORM_KEY)
//   stays as it is. The master key is read the same way: standard base64 of exactly
//   32 bytes, anything else = missing, and everything fails closed.
// - Wrapping needs randomness (the nonce), so it happens in ACTIONS only (`ActionOnly`).
//   Unwrapping needs none, so `unwrapOrgKey` runs in a mutation (the publisher signs
//   in the same transaction that writes the document).
// - Master key id = the first 16 hex characters of SHA-256("rulebox.master-key-id/1" ||
//   key): stored next to each wrapped row so a rotation knows which key wrapped it.
//   It reveals nothing useful about the key.

export type OrgKeyPurpose = "signing" | "sealing";
export type OrgKeyStatus = "active" | "next" | "retired";

const NONCE_LEN = 24;
const MASTER_ID_DOMAIN = utf8ToBytes("rulebox.master-key-id/1");

export type MasterKey = { id: string; bytes: Uint8Array };

function parseMaster(raw: string | undefined): MasterKey | null {
  if (raw === undefined) return null;
  const bytes = base64Decode(raw.trim());
  if (bytes === null || bytes.length !== 32) return null;
  return { id: bytesToHex(sha256(concatBytes(MASTER_ID_DOMAIN, bytes))).slice(0, 16), bytes };
}

/** The deployment's master keys: `active` (`RULEBOX_MASTER_KEY`) and `next` (a rotation in progress). Null = missing or not 32 bytes of base64. */
export function masterKeys(): { active: MasterKey | null; next: MasterKey | null } {
  return { active: parseMaster(env.RULEBOX_MASTER_KEY), next: parseMaster(env.RULEBOX_MASTER_KEY_NEXT) };
}

/** True when org keys can be created and opened on this deployment. */
export function masterKeyAvailable(): boolean {
  return masterKeys().active !== null;
}

/** The two ids a master key id is shown with in status screens: ids only, never bytes. */
export function masterKeyIds(): { active: string | null; next: string | null } {
  const m = masterKeys();
  return { active: m.active?.id ?? null, next: m.next?.id ?? null };
}

export type KeyBinding = { orgId: string; purpose: OrgKeyPurpose; keyId: string };

function aad(b: KeyBinding): Uint8Array {
  return utf8ToBytes(`${b.orgId}|${b.purpose}|${b.keyId}`);
}

export type Wrapped = { wrapped: string; masterKeyId: string };

/**
 * Wrap `secret` for `binding` with the active master key (or the `next` one for a
 * rotation). Actions only (random nonce). Null when that master key is missing.
 */
export function wrapSecret(
  ctx: ActionOnly,
  secret: Uint8Array,
  binding: KeyBinding,
  which: "active" | "next" = "active",
): Wrapped | null {
  const master = masterKeys()[which];
  if (master === null) return null;
  const nonce = randomBytes(ctx, NONCE_LEN);
  const ct = xchacha20poly1305(master.bytes, nonce, aad(binding)).encrypt(secret);
  return { wrapped: base64Encode(concatBytes(nonce, ct)), masterKeyId: master.id };
}

/** Open a wrapped row with the master key it names (active or next). Null on any problem: no such master key, a changed byte, another binding. */
export function unwrapSecret(row: Wrapped, binding: KeyBinding): Uint8Array | null {
  const keys = masterKeys();
  const master = [keys.active, keys.next].find((k) => k !== null && k.id === row.masterKeyId) ?? null;
  if (master === null) return null;
  const raw = base64Decode(row.wrapped);
  if (raw === null || raw.length < NONCE_LEN + 16) return null;
  try {
    return xchacha20poly1305(master.bytes, raw.slice(0, NONCE_LEN), aad(binding)).decrypt(raw.slice(NONCE_LEN));
  } catch {
    return null;
  }
}

/** Re-wrap an opened row with the other master key (`next`, else `active`). Null when it cannot be opened or the target key is missing. */
export function rewrapSecret(ctx: ActionOnly, row: Wrapped, binding: KeyBinding): Wrapped | null {
  const secret = unwrapSecret(row, binding);
  if (secret === null) return null;
  const target = masterKeys().next !== null ? "next" : "active";
  return wrapSecret(ctx, secret, binding, target);
}

/**
 * A key opened from `orgKeys`. `secret` is NON-enumerable, so a log line, an error
 * message or `JSON.stringify` shows only the public fields.
 */
export type OpenedOrgKey = { readonly keyId: string; readonly status: OrgKeyStatus; readonly secret: Uint8Array };

function opened(keyId: string, status: OrgKeyStatus, secret: Uint8Array): OpenedOrgKey {
  const key = { keyId, status };
  Object.defineProperty(key, "secret", { value: secret, enumerable: false, writable: false });
  return key as OpenedOrgKey;
}

export type OrgKeyState =
  /** The organization has no such key row (an organization that is not migrated yet). */
  | { kind: "none" }
  /** A row exists but cannot be opened: no master key, the wrong one, or a damaged row. Fail closed. */
  | { kind: "locked" }
  | { kind: "open"; key: OpenedOrgKey };

/**
 * The organization's key of `purpose` in `status`, opened with the master key. 1 read
 * (`orgKeys.by_org_purpose_status`). Needs no randomness, so mutations may call it.
 */
export async function openOrgKey(
  ctx: { db: DatabaseReader },
  orgId: Id<"organizations">,
  purpose: OrgKeyPurpose,
  status: OrgKeyStatus = "active",
): Promise<OrgKeyState> {
  const row = await ctx.db
    .query("orgKeys")
    .withIndex("by_org_purpose_status", (q) => q.eq("orgId", orgId).eq("purpose", purpose).eq("status", status))
    .first();
  if (row === null) return { kind: "none" };
  const secret = unwrapSecret(row, { orgId, purpose, keyId: row.keyId });
  return secret === null ? { kind: "locked" } : { kind: "open", key: opened(row.keyId, row.status, secret) };
}

/**
 * Open a wrapped row an ACTION got from an internal query (actions have no `db`). Null on any
 * problem. The row must be an `orgKeys` row of `orgId`; the binding makes any other fail.
 */
export function openWrappedRow(
  row: Wrapped & { keyId: string; status?: OrgKeyStatus },
  orgId: string,
  purpose: OrgKeyPurpose,
): OpenedOrgKey | null {
  const secret = unwrapSecret(row, { orgId, purpose, keyId: row.keyId });
  return secret === null ? null : opened(row.keyId, row.status ?? "active", secret);
}

/** `openOrgKey` as the plan's `unwrapOrgKey(ctx, orgId, purpose)`: the key, or null for "none" and "locked" alike. */
export async function unwrapOrgKey(
  ctx: { db: DatabaseReader },
  orgId: Id<"organizations">,
  purpose: OrgKeyPurpose,
  status: OrgKeyStatus = "active",
): Promise<OpenedOrgKey | null> {
  const state = await openOrgKey(ctx, orgId, purpose, status);
  return state.kind === "open" ? state.key : null;
}
