import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { base64Decode } from "./lib/crypto";
import { fail } from "./lib/errors";
import { MAX_PLATFORM_SECRET } from "./lib/limits";
import {
  isPlatformSecretName,
  openSecret,
  PLATFORM_SECRET_NAMES,
  platformKeyBytes,
  platformSecretProblem,
  sealSecret,
  secretRow,
  type SealedSecret,
} from "./lib/platformSecrets";

// Platform secrets (Phase 4b Part C; lib/platformSecrets.ts). INTERNAL only:
// run by the platform operator with the deployment's admin key. Until the
// operator console exists, `scripts/platform-secret.mjs` (run by the owner,
// never by an agent) is the only caller:
//
//   node scripts/platform-secret.mjs set resendApiKey --key-file <master key file>
//
// The CLI encrypts on the owner's machine and calls `storeSecret` with the
// ciphertext only (a plaintext in `convex run` arguments would show in the
// process list); `setSecret` (encrypts on the server) is for the future
// operator console. Nothing here returns a value: `status` / `checkSecrets`
// answer which names are set, decrypt and are valid.

const name = v.string();

function checkedName(raw: string) {
  if (!isPlatformSecretName(raw)) fail("invalid_argument", { field: "name", detail: `one of ${PLATFORM_SECRET_NAMES.join(", ")}` });
  return raw;
}

/** Encrypt and store a platform secret (replaces the old value). Refused without the master key. */
export const setSecret = internalAction({
  args: { name, value: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const n = checkedName(args.name);
    const problem = platformSecretProblem(n, args.value);
    if (problem !== null) fail("invalid_argument", { field: "value", detail: problem });
    const sealed = await sealSecret(ctx, n, args.value);
    if (sealed === null) fail("not_ready", { detail: "RULEBOX_PLATFORM_KEY is missing or invalid" });
    await ctx.runMutation(internal.platform.storeSecret, { name: n, ...sealed });
    return null;
  },
});

export const storeSecret = internalMutation({
  args: { name, ciphertext: v.string(), iv: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const n = checkedName(args.name);
    const iv = base64Decode(args.iv);
    const data = args.ciphertext.length <= 2 * MAX_PLATFORM_SECRET + 64 ? base64Decode(args.ciphertext) : null;
    // AES-GCM: 12-byte IV; ciphertext = value + 16-byte tag.
    if (iv === null || iv.length !== 12 || data === null || data.length <= 16) fail("invalid_argument", { field: "ciphertext" });
    const now = Date.now();
    const row = await secretRow(ctx, n);
    if (row === null) await ctx.db.insert("platformSecrets", { name: n, ciphertext: args.ciphertext, iv: args.iv, updatedAt: now });
    else await ctx.db.patch(row._id, { ciphertext: args.ciphertext, iv: args.iv, updatedAt: now });
    await ctx.db.insert("platformAudit", { at: now, action: "platform.secretSet", name: n, actor: "cli" });
    return null;
  },
});

/** Remove a platform secret (the feature that needs it turns off). */
export const clearSecret = internalMutation({
  args: { name },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const n = checkedName(args.name);
    const row = await secretRow(ctx, n);
    if (row === null) return false;
    await ctx.db.delete(row._id);
    await ctx.db.insert("platformAudit", { at: Date.now(), action: "platform.secretCleared", name: n, actor: "cli" });
    return true;
  },
});

/** The sealed row for `getSecret` (an action decrypts it). Never called by a public function. */
export const readSecret = internalQuery({
  args: { name },
  returns: v.union(v.null(), v.object({ ciphertext: v.string(), iv: v.string() })),
  handler: async (ctx, args) => {
    const n = checkedName(args.name);
    const row = await secretRow(ctx, n);
    return row === null ? null : { ciphertext: row.ciphertext, iv: row.iv };
  },
});

/**
 * For the operator / CLI after `set`: does every stored secret decrypt with
 * this deployment's master key, and is the value acceptable for its name
 * (the CLI encrypts locally, so this is where its value is validated)? No values.
 */
export const checkSecrets = internalAction({
  args: {},
  returns: v.object({
    masterKey: v.boolean(),
    secrets: v.array(v.object({ name: v.string(), set: v.boolean(), decrypts: v.boolean(), valid: v.boolean() })),
  }),
  // Typed explicitly: inferring through `internal.platform` here would make the module's type circular.
  handler: async (ctx): Promise<{ masterKey: boolean; secrets: { name: string; set: boolean; decrypts: boolean; valid: boolean }[] }> => {
    const secrets = [];
    for (const n of PLATFORM_SECRET_NAMES) {
      const sealed: SealedSecret | null = await ctx.runQuery(internal.platform.readSecret, { name: n });
      const value: string | null = sealed === null ? null : await openSecret(n, sealed);
      secrets.push({ name: n, set: sealed !== null, decrypts: value !== null, valid: value !== null && platformSecretProblem(n, value) === null });
    }
    return { masterKey: platformKeyBytes() !== null, secrets };
  },
});

/** For the operator / CLI: is the master key valid, which names are set and when. No values. */
export const status = internalQuery({
  args: {},
  returns: v.object({
    masterKey: v.boolean(),
    secrets: v.array(v.object({ name: v.string(), set: v.boolean(), updatedAt: v.union(v.number(), v.null()) })),
  }),
  handler: async (ctx) => {
    const secrets = [];
    for (const n of PLATFORM_SECRET_NAMES) {
      const row = await secretRow(ctx, n);
      secrets.push({ name: n, set: row !== null, updatedAt: row?.updatedAt ?? null });
    }
    return { masterKey: platformKeyBytes() !== null, secrets };
  },
});
