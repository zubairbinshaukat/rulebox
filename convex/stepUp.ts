import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx } from "./_generated/server";
import { writeAudit, type AuditAction } from "./lib/audit";
import { getInOrg } from "./lib/authz";
import { DUMMY_PHC, hashSecret, verifySecret } from "./lib/argon";
import { constantTimeEqual, hasControlChar } from "./lib/crypto";
import { fail } from "./lib/errors";
import { memberAction, memberMutation, memberQuery } from "./lib/functions";
import {
  MAX_MEMBERSHIPS,
  MAX_PASSKEY_NAME,
  MAX_PASSKEYS,
  MAX_STEP_UP_SESSIONS,
  PIN_HARD_LIMIT,
  PIN_LOCKOUT_MS,
  STEP_UP_BOOTSTRAP_MS,
  STEP_UP_CHALLENGE_TTL_MS,
  STEP_UP_FRESH_MS,
  STEP_UP_IDLE_MS,
  STEP_UP_KEEPALIVE_MS,
  STEP_UP_MAX_AGE_MS,
} from "./lib/limits";
import { pinLockedMail } from "./lib/mail";
import { checkOrFail, consumeQuietly, consumeOrFail } from "./lib/rateLimits";
import { matchRecoveryHash, newRecoveryCodes, recoveryHash } from "./lib/recoveryCodes";
import {
  actionPinProblem,
  authorizeFactorChange,
  deleteStepUpSessions,
  factorsOf,
  hasFactor,
  hasPin,
  markVerified,
  passkeysOf,
  pinBackoffMs,
  pinHardLocked,
  pinLockedUntil,
  sessionIsFresh,
  stepUpRowOf,
  type Who,
} from "./lib/stepUp";
import { webauthnConfig } from "./lib/webauthnConfig";
import { lockedFor, matchRecoveryCode, recordFailure, secretsOf } from "./mfa";

// Step-up authentication (plan 4.16, Step 5a): the ACTION PIN and passkeys
// of a member. Both belong to the person (users row), like MFA; one
// verification unlocks the session in every organization of that person.
//
// Names: "action PIN" everywhere here. The device "exit PIN" (Staff App
// admin exit, `orgSecrets.exitPinHash`, `settings:setExitPin`) is a different
// secret with a different purpose; neither is ever accepted for the other.
//
// Writers / readers (plan 4.7):
// - `stepUpFactors.actionPinHash`: written only by `storeActionPin`, read
//   only by `beginPinAttempt`; never returned.
// - `passkeys.credentialPublicKey`: written only by `storePasskey`, read only
//   by `consumeChallenge` (for the verifying action); never returned.
// - `stepUpChallenges.challengeHash`: SHA-256 of the challenge; the challenge
//   itself is returned once inside the WebAuthn options.
//
// Failed attempts are counted in internal mutations called from actions, so
// the counter commits even though the public action then throws (the MFA
// lesson of Step 3).

type Ctx = { userId: Id<"users">; sessionId: Id<"authSessions"> };
const actorArg = v.object({ type: v.literal("member"), id: v.string(), label: v.string() });
const whoArgs = { userId: v.id("users"), sessionId: v.id("authSessions") };

function who(ctx: Ctx): Who {
  return { userId: ctx.userId, sessionId: ctx.sessionId };
}

async function audit(
  ctx: Pick<MutationCtx, "db">,
  orgId: Id<"organizations">,
  actor: { type: "member"; id: string; label: string },
  action: AuditAction,
  summary: string,
  target?: { id: string; label: string },
): Promise<void> {
  await writeAudit(ctx, {
    orgId,
    actor,
    action,
    targetType: "member",
    targetId: target?.id ?? actor.id,
    targetLabel: target?.label ?? actor.label,
    summary,
  });
}

const verifiedResult = v.object({ verifiedAt: v.number(), freshUntil: v.number(), serverNow: v.number() });

function verified(now: number) {
  return { verifiedAt: now, freshUntil: now + STEP_UP_FRESH_MS, serverNow: now };
}

// ---------------------------------------------------------------- status

/**
 * The caller's step-up state for the dashboard (one query; reads the factor
 * row, at most MAX_PASSKEYS passkeys, the session and its step-up row).
 * Timestamps are server time; the client computes "locked in" from
 * `serverNow` of its last verify/keepAlive answer. Never a hash, a public key
 * or a credential id beyond the passkey's own `_id`.
 */
export const status = memberQuery("viewer")({
  args: {},
  returns: v.object({
    actionPin: v.object({
      set: v.boolean(),
      lockedUntil: v.union(v.number(), v.null()),
      disabled: v.boolean(),
      attemptsBeforeDisable: v.number(),
    }),
    passkeys: v.array(
      v.object({
        _id: v.id("passkeys"),
        name: v.string(),
        createdAt: v.number(),
        lastUsedAt: v.union(v.number(), v.null()),
        synced: v.boolean(),
        suspended: v.boolean(),
      }),
    ),
    passkeysAvailable: v.boolean(),
    session: v.object({
      verifiedAt: v.union(v.number(), v.null()),
      lastActiveAt: v.union(v.number(), v.null()),
      method: v.union(v.literal("actionPin"), v.literal("passkey"), v.null()),
    }),
    /** With no action PIN yet: setting one without a step-up is allowed until then (fresh sign-in). */
    bootstrapUntil: v.union(v.number(), v.null()),
    policy: v.object({ idleMs: v.number(), keepAliveMs: v.number(), freshMs: v.number(), maxAgeMs: v.number() }),
    // Phase 4b (additive): unused recovery codes of the action PIN, and
    // whether `lockedUntil` is the 24 h lockout (else a short backoff).
    recoveryCodesLeft: v.number(),
    pinLockout: v.boolean(),
  }),
  handler: async (ctx) => {
    const f = await factorsOf(ctx, ctx.userId);
    const keys = await passkeysOf(ctx, ctx.userId);
    const row = await stepUpRowOf(ctx, who(ctx));
    const pinSet = f?.actionPinHash !== undefined;
    const lockout = pinSet && pinHardLocked(f);
    const until = pinSet ? pinLockedUntil(f) : 0;
    let bootstrapUntil: number | null = null;
    if (!pinSet) {
      const session = await ctx.db.get(ctx.sessionId);
      if (session !== null) bootstrapUntil = session._creationTime + STEP_UP_BOOTSTRAP_MS;
    }
    return {
      actionPin: {
        set: pinSet,
        lockedUntil: until > 0 ? until : null,
        // Since Phase 4b the PIN is never disabled: the hard limit locks it for 24 hours.
        disabled: false,
        // Wrong attempts left before the 24 h lockout (0 while it lasts).
        attemptsBeforeDisable: pinSet && !lockout ? Math.max(0, PIN_HARD_LIMIT - f.pinFailuresTotal) : pinSet ? 0 : PIN_HARD_LIMIT,
      },
      passkeys: keys.map((k) => ({
        _id: k._id,
        name: k.name,
        createdAt: k.createdAt,
        lastUsedAt: k.lastUsedAt ?? null,
        synced: k.backedUp,
        suspended: k.disabledAt !== undefined,
      })),
      passkeysAvailable: webauthnConfig() !== null,
      session: {
        verifiedAt: row?.verifiedAt ?? null,
        lastActiveAt: row?.lastActiveAt ?? null,
        method: row?.method ?? null,
      },
      bootstrapUntil,
      policy: {
        idleMs: STEP_UP_IDLE_MS,
        keepAliveMs: STEP_UP_KEEPALIVE_MS,
        freshMs: STEP_UP_FRESH_MS,
        maxAgeMs: STEP_UP_MAX_AGE_MS,
      },
      recoveryCodesLeft: f?.recoveryHashes?.length ?? 0,
      pinLockout: lockout,
    };
  },
});

// ---------------------------------------------------------------- session

/**
 * The dashboard calls this at most every STEP_UP_KEEPALIVE_MS while the person
 * types or clicks and the session is unlocked. The wrapper checks "unlocked"
 * and rewrites `lastActiveAt` only when it is STEP_UP_ACTIVITY_QUANTUM_MS old
 * (0 or 1 write).
 */
export const keepAlive = memberMutation("viewer")({
  args: {},
  returns: v.object({ serverNow: v.number() }),
  handler: async () => ({ serverNow: Date.now() }),
});

/** Lock now (idle timer or the person's "Lock" button): deletes this session's step-up row. */
export const lock = memberMutation("viewer", { stepUp: "none" })({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const row = await stepUpRowOf(ctx, who(ctx));
    if (row !== null) await ctx.db.delete(row._id);
    return null;
  },
});

// ---------------------------------------------------------------- action PIN

/**
 * Set or change the action PIN (required for every member since Phase 4b).
 * The first one: right after a password sign-in (bootstrap, no TOTP). A
 * change: after a fresh step-up with the current PIN or a passkey (a
 * forgotten or locked PIN is changed after a passkey step-up), or by email
 * (`account:redeemPinReset`), a recovery code or an Owner reset.
 */
export const setActionPin = memberAction("viewer", { stepUp: "none" })({
  args: { pin: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const problem = actionPinProblem(args.pin);
    if (problem !== null) fail("invalid_argument", { field: "pin", detail: problem });
    const now = Date.now();
    // Check before spending Argon2 work; the store re-checks atomically.
    await ctx.runQuery(internal.stepUp.authorizeChange, { ...who(ctx), now });
    const hash = await hashSecret(ctx, args.pin);
    await ctx.runMutation(internal.stepUp.storeActionPin, {
      ...who(ctx),
      orgId: ctx.orgId,
      actor: ctx.actor,
      hash,
    });
    return null;
  },
});

/** Verify the action PIN: unlocks this session (and makes it fresh for STEP_UP_FRESH_MS). */
export const verifyActionPin = memberAction("viewer", { stepUp: "none" })({
  args: { pin: v.string() },
  returns: verifiedResult,
  handler: async (ctx, args) => {
    await checkOrFail(ctx, "stepUpFailuresGlobal");
    const pin = args.pin.length <= 32 ? args.pin : args.pin.slice(0, 32);
    const attempt = await ctx.runMutation(internal.stepUp.beginPinAttempt, { userId: ctx.userId, now: Date.now() });
    if (attempt.kind === "noPin") {
      await verifySecret(pin, DUMMY_PHC); // equal work
      fail("not_ready", { detail: "no action PIN" });
    }
    // `detail: "lockout"`: the 24 h lockout after PIN_HARD_LIMIT failures (else a short backoff).
    if (attempt.kind === "locked") fail("step_up_locked", { retryAfterMs: attempt.retryAfterMs, detail: attempt.lockout ? "lockout" : undefined });
    if (await verifySecret(pin, attempt.hash)) {
      const now = Date.now();
      await ctx.runMutation(internal.stepUp.finishPinSuccess, { ...who(ctx), now });
      return verified(now);
    }
    await consumeQuietly(ctx, "stepUpFailuresGlobal");
    if (attempt.total === PIN_HARD_LIMIT) {
      await ctx.runMutation(internal.stepUp.auditPinDisabled, { userId: ctx.userId, orgId: ctx.orgId, actor: ctx.actor });
      fail("step_up_locked", { retryAfterMs: PIN_LOCKOUT_MS, detail: "lockout" });
    }
    fail("step_up_invalid", { retryAfterMs: attempt.nextDelayMs > 0 ? attempt.nextDelayMs : undefined });
  },
});

/**
 * Remove the action PIN: always refused since Phase 4b (every member must
 * have one; change it with `setActionPin` or reset it instead). Still major,
 * so a stale session learns nothing either.
 */
export const clearActionPin = memberMutation("viewer", { major: "stepUp:clearActionPin" })({
  args: {},
  returns: v.null(),
  handler: async () => {
    fail("step_up_last_factor", { detail: "the action PIN is required" });
  },
});

// ---------------------------------------------------------------- passkeys (management)

function cleanName(name: string): string {
  const n = name.trim();
  if (n.length === 0 || n.length > MAX_PASSKEY_NAME || hasControlChar(n)) fail("invalid_argument", { field: "name" });
  return n;
}

async function ownPasskey(ctx: { db: MutationCtx["db"]; userId: Id<"users"> }, passkeyId: string): Promise<Doc<"passkeys">> {
  const id = ctx.db.normalizeId("passkeys", passkeyId);
  const key = id === null ? null : await ctx.db.get(id);
  if (key === null || key.userId !== ctx.userId) fail("not_found");
  return key;
}

export const renamePasskey = memberMutation("viewer")({
  args: { passkeyId: v.string(), name: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const key = await ownPasskey(ctx, args.passkeyId);
    const name = cleanName(args.name);
    if (key.name !== name) await ctx.db.patch(key._id, { name });
    return null;
  },
});

/**
 * Remove one of the caller's passkeys (major). Refused when it is the last
 * factor (no action PIN and no other usable passkey: legacy rows only since
 * Phase 4b, where every unlocked member has a PIN). Every session unlocked
 * with this passkey, the current one included, loses its unlock.
 */
export const removePasskey = memberMutation("viewer", { major: "stepUp:removePasskey" })({
  args: { passkeyId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const key = await ownPasskey(ctx, args.passkeyId);
    const f = await factorsOf(ctx, ctx.userId);
    const others = (await passkeysOf(ctx, ctx.userId)).filter((k) => k._id !== key._id && k.disabledAt === undefined);
    // The action PIN (required, even while locked) is always left; this guards legacy rows only.
    if (f?.actionPinHash === undefined && others.length === 0) fail("step_up_last_factor");
    await ctx.db.delete(key._id);
    await deleteStepUpSessions(ctx, ctx.userId, key._id, MAX_STEP_UP_SESSIONS);
    await audit(ctx, ctx.orgId, ctx.actor, "member.passkeyRemoved", `${ctx.member.email} removed the passkey "${key.name}"`);
    return null;
  },
});

// ---------------------------------------------------------------- resets

/**
 * Remove the action PIN, every passkey and every step-up row of a person. The
 * unused recovery codes are kept (`keepRecovery` replaces them, e.g. without
 * the one just used): they belong to the person and stay a fallback.
 */
async function clearAllFactors(ctx: Pick<MutationCtx, "db">, userId: Id<"users">, keepRecovery?: string[]): Promise<void> {
  const f = await factorsOf(ctx, userId);
  const keep = keepRecovery ?? f?.recoveryHashes ?? [];
  if (f !== null && keep.length === 0) await ctx.db.delete(f._id);
  else if (f !== null) {
    await ctx.db.patch(f._id, {
      actionPinHash: undefined,
      actionPinSetAt: undefined,
      pinFailures: 0,
      pinFailuresTotal: 0,
      pinLockedUntil: 0,
      pinDisabledAt: undefined,
      webauthnUserId: undefined,
      recoveryHashes: keep,
    });
  }
  for (const k of await passkeysOf(ctx, userId)) await ctx.db.delete(k._id);
  await deleteStepUpSessions(ctx, userId, undefined, MAX_STEP_UP_SESSIONS);
  // A registration begun before the reset must not finish after it.
  const challenges = await ctx.db
    .query("stepUpChallenges")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .take(MAX_STEP_UP_SESSIONS);
  for (const c of challenges) await ctx.db.delete(c._id);
}

/**
 * An Owner removes another member's action PIN and passkeys (major). The
 * member then sets a new PIN after a fresh password sign-in. Refused
 * for yourself (use a recovery code) and for a person who is also an active
 * member of another organization (step-up belongs to the person; an Owner of
 * one organization must not change it for another: they use a recovery code
 * or the operator).
 */
export const resetMember = memberMutation("owner", { major: "stepUp:resetMember" })({
  args: { memberId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const target = await getInOrg(ctx, "members", args.memberId, ctx.orgId);
    if (target.userId === ctx.userId) fail("forbidden", { detail: "use a recovery code" });
    const memberships = await ctx.db
      .query("members")
      .withIndex("by_user", (q) => q.eq("userId", target.userId))
      .take(MAX_MEMBERSHIPS);
    if (memberships.some((m) => m.orgId !== ctx.orgId && m.status === "active")) {
      fail("forbidden", { detail: "member of another organization" });
    }
    if (!(await hasFactor(ctx, target.userId))) return null;
    await clearAllFactors(ctx, target.userId);
    await audit(ctx, ctx.orgId, ctx.actor, "member.stepUpReset", `Reset the action PIN and passkeys of ${target.email}`, {
      id: target._id,
      label: target.email,
    });
    return null;
  },
});

/**
 * Lost or locked PIN: a fresh password sign-in (session younger than
 * STEP_UP_BOOTSTRAP_MS) plus one recovery code removes the action PIN and all
 * passkeys; the session then sets a new PIN (bootstrap). Never by email alone.
 *
 * - Codes of the action PIN (`stepUp:generateRecoveryCodes`, Phase 4b): no
 *   TOTP needed; a wrong code answers `step_up_invalid` and is bounded by the
 *   per-user `recoveryCodePerUser` bucket (checked first, consumed on a
 *   failure) and the global step-up failure bucket.
 * - Legacy codes of a TOTP enrolment (only when the person has no PIN codes):
 *   unchanged, the session must have passed TOTP and failures share the TOTP
 *   lockout (`mfa_invalid_code` / `mfa_locked`). Removed in WP5b.
 */
export const resetWithRecoveryCode = memberAction("viewer", { stepUp: "none" })({
  args: { code: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await checkOrFail(ctx, "stepUpFailuresGlobal");
    await checkOrFail(ctx, "recoveryCodePerUser", ctx.userId);
    const result = await ctx.runMutation(internal.stepUp.recoveryReset, {
      ...who(ctx),
      orgId: ctx.orgId,
      actor: ctx.actor,
      code: args.code.slice(0, 32),
      now: Date.now(),
    });
    if (result.kind === "ok") return null;
    if (result.kind === "reauthenticate") fail("step_up_setup_required", { detail: "reauthenticate" });
    if (result.kind === "noMfa") fail("not_ready", { detail: "no recovery codes" });
    await consumeQuietly(ctx, "recoveryCodePerUser", ctx.userId);
    await consumeQuietly(ctx, "stepUpFailuresGlobal");
    if (result.kind === "invalid") fail("step_up_invalid");
    if (result.kind === "locked") fail("mfa_locked", { retryAfterMs: result.retryAfterMs });
    fail("mfa_invalid_code");
  },
});

/**
 * New recovery codes for the action PIN (major: fresh step-up; the PIN's
 * bootstrap counts, so the setup screen calls it right after `setActionPin`).
 * RECOVERY_CODE_COUNT codes, returned ONCE, stored as SHA-256 only; they
 * replace any previous set. Each one works once with `resetWithRecoveryCode`.
 */
export const generateRecoveryCodes = memberAction("viewer", { major: "stepUp:generateRecoveryCodes" })({
  args: {},
  returns: v.array(v.string()),
  handler: async (ctx) => {
    const codes = newRecoveryCodes(ctx);
    await ctx.runMutation(internal.stepUp.storeRecoveryCodes, {
      userId: ctx.userId,
      orgId: ctx.orgId,
      actor: ctx.actor,
      hashes: codes.map(recoveryHash),
    });
    return codes;
  },
});

export const storeRecoveryCodes = internalMutation({
  args: { userId: v.id("users"), orgId: v.id("organizations"), actor: actorArg, hashes: v.array(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const f = await factorsOf(ctx, args.userId);
    // The wrapper's fresh step-up implies a PIN (see `hasPin`); re-checked here.
    if (f === null || f.actionPinHash === undefined) fail("step_up_setup_required", { detail: "pin" });
    await ctx.db.patch(f._id, { recoveryHashes: args.hashes, recoveryCreatedAt: Date.now() });
    await audit(
      ctx,
      args.orgId,
      args.actor,
      "member.recoveryCodesGenerated",
      `${args.actor.label} created ${args.hashes.length} new recovery codes for their action PIN`,
    );
    return null;
  },
});

// ---------------------------------------------------------------- internal: action PIN

export const authorizeChange = internalQuery({
  args: { ...whoArgs, now: v.number() },
  returns: v.union(v.literal("bootstrap"), v.literal("fresh")),
  handler: async (ctx, args) => await authorizeFactorChange(ctx, args, args.now),
});

export const storeActionPin = internalMutation({
  args: { ...whoArgs, orgId: v.id("organizations"), actor: actorArg, hash: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const mode = await authorizeFactorChange(ctx, args, now);
    const f = await factorsOf(ctx, args.userId);
    const changed = f?.actionPinHash !== undefined;
    const fields = {
      actionPinHash: args.hash,
      actionPinSetAt: now,
      pinFailures: 0,
      pinFailuresTotal: 0,
      pinLockedUntil: 0,
      pinDisabledAt: undefined,
    };
    if (f === null) await ctx.db.insert("stepUpFactors", { userId: args.userId, ...fields });
    else await ctx.db.patch(f._id, fields);
    // The first PIN, set right after a password sign-in, unlocks the session (and makes it fresh).
    if (mode === "bootstrap") await markVerified(ctx, args, "actionPin", now);
    await audit(
      ctx,
      args.orgId,
      args.actor,
      changed ? "member.actionPinChanged" : "member.actionPinSet",
      `${args.actor.label} ${changed ? "changed" : "set"} their action PIN`,
    );
    return null;
  },
});

const pinAttempt = v.union(
  v.object({ kind: v.literal("noPin") }),
  v.object({ kind: v.literal("locked"), retryAfterMs: v.number(), lockout: v.boolean() }),
  v.object({ kind: v.literal("go"), hash: v.string(), total: v.number(), nextDelayMs: v.number() }),
);

/**
 * Reserve one attempt BEFORE the Argon2 check: the attempt counts as a
 * failure until `finishPinSuccess` says otherwise. Parallel attempts
 * serialize on this row, so each is counted; a crash between begin and
 * finish leaves it counted (fail closed).
 *
 * The PIN_HARD_LIMIT-th failure since the last success LOCKS the PIN for
 * PIN_LOCKOUT_MS (Phase 4b; it used to disable it until reset, which let a
 * password thief lock the owner out for good). `pinFailuresTotal` stays at
 * the limit as the lockout marker and `pinFailures` restarts, so after the
 * lockout the next attempt starts a fresh count with the normal backoff.
 * `pinDisabledAt` is never written (a legacy value is cleared here once its
 * lockout ended).
 */
export const beginPinAttempt = internalMutation({
  args: { userId: v.id("users"), now: v.number() },
  returns: pinAttempt,
  handler: async (ctx, args) => {
    const f = await factorsOf(ctx, args.userId);
    if (f === null || f.actionPinHash === undefined) return { kind: "noPin" as const };
    const lockout = pinHardLocked(f);
    const until = pinLockedUntil(f);
    if (until > args.now) return { kind: "locked" as const, retryAfterMs: until - args.now, lockout };
    // A lockout that ended starts the count over.
    const failures = (lockout ? 0 : f.pinFailures) + 1;
    const total = (lockout ? 0 : f.pinFailuresTotal) + 1;
    const locksOut = total >= PIN_HARD_LIMIT;
    const nextDelayMs = locksOut ? PIN_LOCKOUT_MS : pinBackoffMs(failures);
    await ctx.db.patch(f._id, {
      pinFailures: locksOut ? 0 : failures,
      pinFailuresTotal: total,
      pinLockedUntil: nextDelayMs > 0 ? args.now + nextDelayMs : 0,
      pinDisabledAt: undefined,
    });
    return { kind: "go" as const, hash: f.actionPinHash, total, nextDelayMs };
  },
});

export const finishPinSuccess = internalMutation({
  args: { ...whoArgs, now: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const f = await factorsOf(ctx, args.userId);
    if (f === null || f.actionPinHash === undefined) fail("step_up_invalid");
    await ctx.db.patch(f._id, { pinFailures: 0, pinFailuresTotal: 0, pinLockedUntil: 0, pinDisabledAt: undefined });
    await markVerified(ctx, args, "actionPin", args.now);
    return null;
  },
});

/**
 * The PIN_HARD_LIMIT-th failure: audit `member.actionPinLocked` and send the
 * person a "your PIN is locked" notice (best effort: the scheduled mail runs
 * after this commits and its failure changes nothing here).
 */
export const auditPinDisabled = internalMutation({
  args: { userId: v.id("users"), orgId: v.id("organizations"), actor: actorArg },
  returns: v.null(),
  handler: async (ctx, args) => {
    await audit(
      ctx,
      args.orgId,
      args.actor,
      "member.actionPinLocked",
      `The action PIN of ${args.actor.label} was locked for 24 hours after ${PIN_HARD_LIMIT} wrong attempts`,
    );
    const user = await ctx.db.get(args.userId);
    const to = user?.email ?? args.actor.label;
    await ctx.scheduler.runAfter(0, internal.mail.send, { to, ...pinLockedMail() });
    return null;
  },
});

export const recoveryReset = internalMutation({
  args: { ...whoArgs, orgId: v.id("organizations"), actor: actorArg, code: v.string(), now: v.number() },
  returns: v.union(
    v.object({ kind: v.literal("ok") }),
    v.object({ kind: v.literal("invalid") }),
    v.object({ kind: v.literal("locked"), retryAfterMs: v.number() }),
    v.object({ kind: v.literal("reauthenticate") }),
    v.object({ kind: v.literal("noMfa") }),
    // Legacy TOTP code, wrong: shares the TOTP lockout (answered mfa_invalid_code).
    v.object({ kind: v.literal("invalidLegacy") }),
  ),
  handler: async (ctx, args) => {
    if (!(await sessionIsFresh(ctx, args.sessionId, args.now))) return { kind: "reauthenticate" as const };
    // Codes of the action PIN (Phase 4b): no TOTP involved.
    const f = await factorsOf(ctx, args.userId);
    const hashes = f?.recoveryHashes ?? [];
    if (hashes.length > 0) {
      const index = matchRecoveryHash(hashes, args.code);
      if (index === null) return { kind: "invalid" as const };
      const left = hashes.filter((_, i) => i !== index);
      await clearAllFactors(ctx, args.userId, left);
      await audit(
        ctx,
        args.orgId,
        args.actor,
        "member.stepUpReset",
        `${args.actor.label} reset their action PIN and passkeys with a recovery code (${left.length} left)`,
      );
      return { kind: "ok" as const };
    }
    // Legacy: recovery codes of a TOTP enrolment (removed in WP5b).
    const s = await secretsOf(ctx, args.userId);
    if (s === null || s.totpSecret === undefined) return { kind: "noMfa" as const };
    const passed = await ctx.db
      .query("mfaSessions")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .first();
    if (passed === null) return { kind: "reauthenticate" as const };
    const locked = lockedFor(s, args.now);
    if (locked !== null) return { kind: "locked" as const, retryAfterMs: locked };
    const index = matchRecoveryCode(s, args.code);
    if (index === null) {
      const r = await recordFailure(ctx, s, args.now);
      return r.kind === "locked" ? { kind: "locked" as const, retryAfterMs: r.retryAfterMs } : { kind: "invalidLegacy" as const };
    }
    await ctx.db.patch(s._id, { recoveryHashes: s.recoveryHashes.filter((_, i) => i !== index), totpFailures: 0 });
    await clearAllFactors(ctx, args.userId);
    await audit(
      ctx,
      args.orgId,
      args.actor,
      "member.stepUpReset",
      `${args.actor.label} reset their action PIN and passkeys with a recovery code (${s.recoveryHashes.length - 1} left)`,
    );
    return { kind: "ok" as const };
  },
});

// ---------------------------------------------------------------- internal: WebAuthn (called by passkeys.ts)

const purpose = v.union(v.literal("register"), v.literal("verify"));

/**
 * Store a new challenge (SHA-256 only) for this session and purpose,
 * replacing the previous one (a cancelled prompt, a second tab). For
 * "register": the session must be allowed to add a factor and the person has
 * fewer than MAX_PASSKEYS. Returns what the options need.
 */
export const createChallenge = internalMutation({
  args: { ...whoArgs, purpose, challengeHash: v.string(), webauthnUserIdCandidate: v.string(), now: v.number() },
  returns: v.object({
    webauthnUserId: v.string(),
    credentials: v.array(v.object({ id: v.string(), transports: v.array(v.string()) })),
  }),
  handler: async (ctx, args) => {
    const keys = await passkeysOf(ctx, args.userId);
    let webauthnUserId = args.webauthnUserIdCandidate;
    if (args.purpose === "register") {
      // Phase 4b: the action PIN first (bootstrap is for the PIN only), then optional passkeys.
      await authorizeFactorChange(ctx, args, args.now, "passkey");
      if (keys.length >= MAX_PASSKEYS) fail("conflict", { detail: "passkey limit" });
      const f = await factorsOf(ctx, args.userId);
      if (f?.webauthnUserId !== undefined) webauthnUserId = f.webauthnUserId;
      else if (f !== null) await ctx.db.patch(f._id, { webauthnUserId });
      else {
        await ctx.db.insert("stepUpFactors", {
          userId: args.userId,
          pinFailures: 0,
          pinFailuresTotal: 0,
          pinLockedUntil: 0,
          webauthnUserId,
        });
      }
    } else if (!keys.some((k) => k.disabledAt === undefined)) {
      fail("not_ready", { detail: "no passkey" });
    } else if (!(await hasPin(ctx, args.userId))) {
      // A passkey registered before Phase 4b without a PIN: set the PIN first (see `hasPin`).
      fail("step_up_setup_required", { detail: "pin" });
    }
    await consumeOrFail(ctx, "stepUpChallenge", args.userId);
    const previous = await ctx.db
      .query("stepUpChallenges")
      .withIndex("by_session_purpose", (q) => q.eq("sessionId", args.sessionId).eq("purpose", args.purpose))
      .take(4);
    for (const p of previous) await ctx.db.delete(p._id);
    await ctx.db.insert("stepUpChallenges", {
      userId: args.userId,
      sessionId: args.sessionId,
      purpose: args.purpose,
      challengeHash: args.challengeHash,
      expiresAt: args.now + STEP_UP_CHALLENGE_TTL_MS,
    });
    const usable = args.purpose === "register" ? keys : keys.filter((k) => k.disabledAt === undefined);
    return { webauthnUserId, credentials: usable.map((k) => ({ id: k.credentialId, transports: k.transports })) };
  },
});

/**
 * Consume (delete) the challenge whatever happens next: single use. For
 * "verify" also returns the caller's own, usable passkey with that credential
 * id (another person's credential id is answered like an unknown one).
 */
export const consumeChallenge = internalMutation({
  args: { ...whoArgs, purpose, challengeHash: v.string(), credentialId: v.optional(v.string()), now: v.number() },
  returns: v.union(
    v.object({ ok: v.literal(false) }),
    v.object({
      ok: v.literal(true),
      passkey: v.union(
        v.null(),
        v.object({
          _id: v.id("passkeys"),
          credentialId: v.string(),
          credentialPublicKey: v.string(),
          counter: v.number(),
          transports: v.array(v.string()),
        }),
      ),
    }),
  ),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("stepUpChallenges")
      .withIndex("by_challenge_hash", (q) => q.eq("challengeHash", args.challengeHash))
      .first();
    if (row === null || row.userId !== args.userId || row.sessionId !== args.sessionId) return { ok: false as const };
    await ctx.db.delete(row._id);
    if (row.purpose !== args.purpose || row.expiresAt <= args.now || !constantTimeEqual(row.challengeHash, args.challengeHash)) {
      return { ok: false as const };
    }
    if (args.credentialId === undefined) return { ok: true as const, passkey: null };
    const key = await ctx.db
      .query("passkeys")
      .withIndex("by_credential_id", (q) => q.eq("credentialId", args.credentialId!))
      .first();
    if (key === null || key.userId !== args.userId || key.disabledAt !== undefined) return { ok: true as const, passkey: null };
    return {
      ok: true as const,
      passkey: {
        _id: key._id,
        credentialId: key.credentialId,
        credentialPublicKey: key.credentialPublicKey,
        counter: key.counter,
        transports: key.transports,
      },
    };
  },
});

export const storePasskey = internalMutation({
  args: {
    ...whoArgs,
    orgId: v.id("organizations"),
    actor: actorArg,
    credentialId: v.string(),
    credentialPublicKey: v.string(),
    counter: v.number(),
    transports: v.array(v.string()),
    name: v.string(),
    aaguid: v.string(),
    deviceType: v.union(v.literal("singleDevice"), v.literal("multiDevice")),
    backedUp: v.boolean(),
  },
  returns: v.object({ passkeyId: v.id("passkeys") }),
  handler: async (ctx, args) => {
    const now = Date.now();
    const name = cleanName(args.name);
    const clash = await ctx.db
      .query("passkeys")
      .withIndex("by_credential_id", (q) => q.eq("credentialId", args.credentialId))
      .first();
    if (clash !== null) fail("conflict", { detail: "passkey exists" });
    const keys = await passkeysOf(ctx, args.userId);
    if (keys.length >= MAX_PASSKEYS) fail("conflict", { detail: "passkey limit" });
    const passkeyId = await ctx.db.insert("passkeys", {
      userId: args.userId,
      credentialId: args.credentialId,
      credentialPublicKey: args.credentialPublicKey,
      counter: args.counter,
      transports: args.transports,
      name,
      aaguid: args.aaguid,
      deviceType: args.deviceType,
      backedUp: args.backedUp,
      createdAt: now,
    });
    // Since Phase 4b a passkey is never the first factor (the PIN comes first and
    // its bootstrap already unlocked the session), so registering unlocks nothing.
    await audit(ctx, args.orgId, args.actor, "member.passkeyAdded", `${args.actor.label} added the passkey "${name}"`);
    return { passkeyId };
  },
});

export const finishPasskeySuccess = internalMutation({
  args: { ...whoArgs, passkeyId: v.id("passkeys"), newCounter: v.number(), now: v.number() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const key = await ctx.db.get(args.passkeyId);
    if (key === null || key.userId !== args.userId || key.disabledAt !== undefined) return false;
    // Re-check under serialization: two assertions racing with the same counter.
    if ((key.counter > 0 || args.newCounter > 0) && args.newCounter <= key.counter) return false;
    // Invariant of `hasPin`: no step-up row for a person without an action PIN.
    if (!(await hasPin(ctx, args.userId))) return false;
    await ctx.db.patch(key._id, { counter: args.newCounter, lastUsedAt: args.now });
    await markVerified(ctx, args, "passkey", args.now, key._id);
    return true;
  },
});

/** The authenticator's counter went backwards: suspend the passkey (cloned authenticator suspected). */
export const flagClone = internalMutation({
  args: { userId: v.id("users"), passkeyId: v.id("passkeys"), orgId: v.id("organizations"), actor: actorArg },
  returns: v.null(),
  handler: async (ctx, args) => {
    const key = await ctx.db.get(args.passkeyId);
    if (key === null || key.userId !== args.userId || key.disabledAt !== undefined) return null;
    await ctx.db.patch(key._id, { disabledAt: Date.now() });
    await deleteStepUpSessions(ctx, args.userId, key._id, MAX_STEP_UP_SESSIONS);
    await audit(
      ctx,
      args.orgId,
      args.actor,
      "member.passkeyCloneDetected",
      `The passkey "${key.name}" of ${args.actor.label} was suspended: its signature counter went backwards (possible copy)`,
    );
    return null;
  },
});
