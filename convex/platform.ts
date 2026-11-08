import { v } from "convex/values";
import { internal } from "./_generated/api";
import {
  internalAction,
  type ActionCtx,
  type DatabaseReader,
  type DatabaseWriter,
} from "./_generated/server";
import { internalQuery, internalMutation } from "./lib/functions";
import { base64Decode } from "./lib/crypto";
import { fail } from "./lib/errors";
import { MAX_PLATFORM_SECRET } from "./lib/limits";
import {
  isPlatformSecretName,
  mailFlagRow,
  mailSettingsUsable,
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
//
// The "mail" flag (`platformFlags`, Phase 4b security review): the lock
// screen's "reset by email is on" without reading or decrypting a secret per
// query. Recomputed by decrypting all three settings whenever one changes
// (`storeSecret` schedules it, `setSecret` and `checkSecrets` run it,
// `clearSecret` turns it off). After replacing RULEBOX_PLATFORM_KEY, run
// `check` so the flag follows.

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
    await ctx.runMutation(internal.platform.storeSecret, { name: n, ...sealed, refresh: false });
    await refreshMail(ctx);
    return null;
  },
});

/**
 * Store an encrypted value (the CLI's path: it encrypts locally). Schedules
 * the "mail" flag recompute (`refresh: false` only from `setSecret`, which
 * recomputes it itself).
 */
export const storeSecret = internalMutation({
  args: { name, ciphertext: v.string(), iv: v.string(), refresh: v.optional(v.boolean()) },
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
    if (args.refresh !== false) await ctx.scheduler.runAfter(0, internal.platform.refreshMailFlag, {});
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
    // Every secret is needed for mail: it is off now (no decrypt needed to know).
    await writeMailFlag(ctx, false, await currentStamps(ctx));
    return true;
  },
});

// ---------------------------------------------------------------- the "mail" flag (platformFlags)

async function currentStamps(ctx: { db: DatabaseReader }): Promise<(number | null)[]> {
  const stamps: (number | null)[] = [];
  for (const n of PLATFORM_SECRET_NAMES) stamps.push((await secretRow(ctx, n))?.updatedAt ?? null);
  return stamps;
}

/** Write the flag only when it changed (rule 5: write only on change). */
async function writeMailFlag(ctx: { db: DatabaseWriter }, ready: boolean, stamps: (number | null)[]): Promise<void> {
  const row = await mailFlagRow(ctx);
  if (row === null) {
    await ctx.db.insert("platformFlags", { name: "mail", ready, checkedAt: Date.now(), stamps });
  } else if (row.ready !== ready || row.stamps.join() !== stamps.join()) {
    await ctx.db.patch(row._id, { ready, checkedAt: Date.now(), stamps });
  }
}

const sealedRow = v.union(v.null(), v.object({ ciphertext: v.string(), iv: v.string(), updatedAt: v.number() }));

/** The three mail settings, sealed, in PLATFORM_SECRET_NAMES order (for the flag recompute only). */
export const mailInputs = internalQuery({
  args: {},
  returns: v.array(sealedRow),
  handler: async (ctx) => {
    const out = [];
    for (const n of PLATFORM_SECRET_NAMES) {
      const row = await secretRow(ctx, n);
      out.push(row === null ? null : { ciphertext: row.ciphertext, iv: row.iv, updatedAt: row.updatedAt });
    }
    return out;
  },
});

/** Store a recomputed flag unless a secret changed since it was computed (a newer recompute is on its way). */
export const setMailFlag = internalMutation({
  args: { ready: v.boolean(), stamps: v.array(v.union(v.number(), v.null())) },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const now = await currentStamps(ctx);
    if (now.join() !== args.stamps.join()) return false;
    await writeMailFlag(ctx, args.ready, now);
    return true;
  },
});

type Sealed = { ciphertext: string; iv: string; updatedAt: number } | null;

/** Decrypt + validate the three settings with this deployment's master key, then store the flag. Actions only. */
async function refreshMail(ctx: Pick<ActionCtx, "runQuery" | "runMutation">): Promise<boolean> {
  const inputs: Sealed[] = await ctx.runQuery(internal.platform.mailInputs, {});
  const ready = await mailSettingsUsable(inputs);
  await ctx.runMutation(internal.platform.setMailFlag, { ready, stamps: inputs.map((s) => s?.updatedAt ?? null) });
  return ready;
}

/** Recompute the "mail" flag (scheduled by `storeSecret`). */
export const refreshMailFlag = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx): Promise<null> => {
    await refreshMail(ctx);
    return null;
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
    // Also re-derives the "mail" flag (e.g. after RULEBOX_PLATFORM_KEY was replaced).
    await refreshMail(ctx);
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
