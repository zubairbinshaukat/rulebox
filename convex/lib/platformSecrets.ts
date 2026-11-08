import { internal } from "../_generated/api";
import { env, type ActionCtx, type DatabaseReader } from "../_generated/server";
import { base64Decode, base64Encode, hasControlChar, normalizeEmail, randomBytes, type ActionOnly } from "./crypto";
import { MAX_PLATFORM_SECRET } from "./limits";

// Platform secrets (Phase 4b Part C). Settings of the PLATFORM operator, never
// of a tenant: the Resend API key, its from address and the dashboard origin
// the forgot-PIN link points at. Until the operator console exists they are
// set with `scripts/platform-secret.mjs` (run by the owner personally), which
// calls the internal `platform:setSecret`.
//
// - Encrypted at rest: AES-256-GCM, a random 96-bit IV per write, the secret's
//   name as additional data (a ciphertext copied to another name does not
//   decrypt). The key is the deployment env RULEBOX_PLATFORM_KEY (standard
//   base64 of 32 bytes), read only here.
// - Missing or invalid master key: nothing can be set or read, and every
//   feature that needs a secret is off (fail closed).
// - Readers: `getSecret` (actions only; decrypts) and `platform:mailInputs`
//   (internal, for the "mail" flag recompute). Hot queries read only the
//   derived `platformFlags` "mail" row (`mailReadyFlag`), never a secret row.
//   No public function returns a field of `platformSecrets`
//   (`platform.test.ts` scans the sources).

export const PLATFORM_SECRET_NAMES = ["resendApiKey", "resendFrom", "dashboardOrigin"] as const;
export type PlatformSecretName = (typeof PLATFORM_SECRET_NAMES)[number];

export function isPlatformSecretName(name: string): name is PlatformSecretName {
  return (PLATFORM_SECRET_NAMES as readonly string[]).includes(name);
}

/** The master key bytes, or null when the env value is missing or not base64 of exactly 32 bytes. */
export function platformKeyBytes(): Uint8Array<ArrayBuffer> | null {
  const raw = (env.RULEBOX_PLATFORM_KEY ?? "").trim();
  if (raw === "") return null;
  const bytes = base64Decode(raw);
  if (bytes === null || bytes.length !== 32) return null;
  return new Uint8Array(bytes);
}

/** True when an exact origin: `https://host[:port]`, or `http://localhost[:port]` for development. */
export function isDashboardOrigin(text: string): boolean {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return false;
  }
  if (url.origin !== text || url.username !== "" || url.password !== "") return false;
  return url.protocol === "https:" || (url.protocol === "http:" && url.hostname === "localhost");
}

/** A from address Resend accepts: `a@b.c` or `Name <a@b.c>`, one line. */
function isFromAddress(text: string): boolean {
  if (text.length > 200 || hasControlChar(text)) return false;
  const m = /^([^<>"]{1,100}) <([^<>\s]+)>$/.exec(text);
  if (m !== null) return normalizeEmail(m[2]!) !== null;
  return !/[\s<>"]/.test(text) && normalizeEmail(text) !== null;
}

/** Null when `value` is acceptable for `name`, else a fixed reason (never the value). */
export function platformSecretProblem(name: PlatformSecretName, value: string): string | null {
  if (value.length === 0 || value.length > MAX_PLATFORM_SECRET) return "length";
  if (value !== value.trim() || hasControlChar(value)) return "whitespace or control characters";
  switch (name) {
    case "resendApiKey":
      return /^[A-Za-z0-9_.-]{10,200}$/.test(value) ? null : "not an API key";
    case "resendFrom":
      return isFromAddress(value) ? null : "not a from address";
    case "dashboardOrigin":
      return isDashboardOrigin(value) ? null : "not an exact https origin";
  }
}

async function aesKey(raw: Uint8Array<ArrayBuffer>, usage: "encrypt" | "decrypt"): Promise<CryptoKey> {
  return await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [usage]);
}

function aad(name: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`rulebox.platformSecret.v1:${name}`);
}

export type SealedSecret = { ciphertext: string; iv: string };

/** Encrypt `value` for `name` (random IV: actions only). Null when the master key is missing. */
export async function sealSecret(ctx: ActionOnly, name: PlatformSecretName, value: string): Promise<SealedSecret | null> {
  const raw = platformKeyBytes();
  if (raw === null) return null;
  const iv = randomBytes(ctx, 12);
  const key = await aesKey(raw, "encrypt");
  const out = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(name) }, key, new TextEncoder().encode(value));
  return { ciphertext: base64Encode(new Uint8Array(out)), iv: base64Encode(iv) };
}

/** Decrypt a stored row; null when the master key is missing or wrong, or the row was tampered with. */
export async function openSecret(name: PlatformSecretName, sealed: SealedSecret): Promise<string | null> {
  const raw = platformKeyBytes();
  if (raw === null) return null;
  const iv = base64Decode(sealed.iv);
  const data = base64Decode(sealed.ciphertext);
  if (iv === null || iv.length !== 12 || data === null) return null;
  try {
    const key = await aesKey(raw, "decrypt");
    const out = await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(iv), additionalData: aad(name) }, key, new Uint8Array(data));
    return new TextDecoder().decode(out);
  } catch {
    return null;
  }
}

/** The plaintext of a platform secret, or null (not set, or no / wrong master key). Actions only. */
export async function getSecret(ctx: Pick<ActionCtx, "runQuery">, name: PlatformSecretName): Promise<string | null> {
  if (platformKeyBytes() === null) return null;
  const sealed = await ctx.runQuery(internal.platform.readSecret, { name });
  return sealed === null ? null : await openSecret(name, sealed);
}

/** The row of `name`, for `platform:readSecret` / `platform:status` only. */
export async function secretRow(ctx: { db: DatabaseReader }, name: PlatformSecretName) {
  return await ctx.db
    .query("platformSecrets")
    .withIndex("by_name", (q) => q.eq("name", name))
    .first();
}

/** The "mail" row of `platformFlags` (see schema), or null. */
export async function mailFlagRow(ctx: { db: DatabaseReader }) {
  return await ctx.db
    .query("platformFlags")
    .withIndex("by_name", (q) => q.eq("name", "mail"))
    .first();
}

/**
 * Is the forgot-PIN email on? ONE small read: the "mail" flag, computed when
 * a secret changes by decrypting and validating all three settings with this
 * deployment's master key (`platform:refreshMailFlag`), plus the env check (a
 * key removed later turns it off at once). A master key REPLACED by another
 * valid one is only noticed by the next `checkSecrets` (the CLI's `check`);
 * until then `getSecret` fails closed and no mail goes out.
 */
export async function mailReadyFlag(ctx: { db: DatabaseReader }): Promise<boolean> {
  if (platformKeyBytes() === null) return false;
  return (await mailFlagRow(ctx))?.ready === true;
}

/** Decrypt and validate the three mail settings (actions only); true when all are usable. */
export async function mailSettingsUsable(sealed: (SealedSecret | null)[]): Promise<boolean> {
  if (platformKeyBytes() === null || sealed.length !== PLATFORM_SECRET_NAMES.length) return false;
  for (let i = 0; i < PLATFORM_SECRET_NAMES.length; i++) {
    const name = PLATFORM_SECRET_NAMES[i]!;
    const s = sealed[i];
    const value = s === null || s === undefined ? null : await openSecret(name, s);
    if (value === null || platformSecretProblem(name, value) !== null) return false;
  }
  return true;
}
