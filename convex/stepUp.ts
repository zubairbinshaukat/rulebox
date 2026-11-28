import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { type MutationCtx } from "./_generated/server";
import { writeAudit, type AuditAction } from "./lib/audit";
import { getInOrg } from "./lib/authz";
import { hashSecret, verifySecret } from "./lib/argon";
import { constantTimeEqual, hasControlChar } from "./lib/crypto";
import { fail } from "./lib/errors";
import { internalMutation, internalQuery, memberAction, memberMutation, memberQuery } from "./lib/functions";
import {
  MAX_MEMBERSHIPS,
  MAX_PASSKEY_NAME,
  MAX_PASSKEYS,
  PIN_WARN_AT,
  STEP_UP_BOOTSTRAP_MS,
  STEP_UP_CHALLENGE_TTL_MS,
  STEP_UP_FRESH_MS,
  STEP_UP_IDLE_MS,
  STEP_UP_KEEPALIVE_MS,
  STEP_UP_MAX_AGE_MS,
} from "./lib/limits";
import { pinChangedMail, pinFailuresMail, pinLockedMail, pinResetDoneMail } from "./lib/mail";
import { mailReadyFlag } from "./lib/platformSecrets";
import { checkOrFail, consumeQuietly, consumeOrFail } from "./lib/rateLimits";
import { matchRecoveryHash, newRecoveryCodes, recoveryHash, recoveryPepper, requirePepper } from "./lib/recoveryCodes";
import { deleteUserSessions } from "./lib/sessions";
import {
  actionPinProblem,
  authorizeFactorChange,
  deleteChallenges,
  deletePinCounters,
  deleteStepUpSessions,
  factorsOf,
  hasFactor,
  hasPin,
  markVerified,
  passkeysOf,
  pinCountersOf,
  pinCountersRowOf,
  pinSuccess,
  pinView,
  reservePinFailure,
  sessionIsFresh,
  stepUpRowOf,
  storePinHash,
  writePinCounters,
  type Who,
} from "./lib/stepUp";
import { webauthnConfig } from "./lib/webauthnConfig";

// Step-up authentication (plan 4.16, Step 5a): the ACTION PIN and passkeys
// of a member. Both belong to the person (users row); one
// verification unlocks the session in every organization of that person.
//
// Names: "action PIN" everywhere here. The device "exit PIN" (Staff App
// admin exit, `orgSecrets.exitPinHash`, `settings:setExitPin`) is a different
// secret with a different purpose; neither is ever accepted for the other.
//
// Writers / readers (plan 4.7):
// - `stepUpFactors.actionPinHash`: written only through `storePinHash`
//   (`storeActionPin`, `recoveryReset`, `account:finishPinReset`), read only
//   by `beginPinAttempt`; never returned.
// - `pinCounters`: the attempt counters (lib/stepUp.ts), written only by
//   `beginPinAttempt` / `finishPinSuccess`, deleted with every new PIN.
// - `passkeys.credentialPublicKey`: written only by `storePasskey`, read only
//   by `consumeChallenge` (for the verifying action); never returned.
// - `stepUpChallenges.challengeHash`: SHA-256 of the challenge; the challenge
//   itself is returned once inside the WebAuthn options.
//
// Failed attempts are counted in internal mutations called from actions, so
// the counter commits even though the public action then throws (the lesson
// of Step 3).

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
 * The caller's step-up and lock-screen state for the dashboard (one query;
 * reads the factor row, the PIN counters row, at most MAX_PASSKEYS passkeys,
 * the step-up row, the session (no PIN yet) and the "mail" platform flag).
 * Timestamps are server time; the client compares them with its own clock
 * (corrected by `serverNow` of its last verify/keepAlive answer): no
 * Date.now() here, so nothing stays "locked" after `lockedUntil`. Never a
 * hash, a public key or a credential id beyond the passkey's own `_id`.
 *
 * `pin` (Phase 4b security review) is the lock screen's source:
 * - `lockedUntil` / `lockKind`: locked while `lockedUntil > now`; "lockout"
 *   is the long lockout (24 h, 72 h, 7 days), "backoff" a short wait.
 * - `failedSinceUnlock`: wrong PINs since the last successful unlock (tell
 *   the person: "N wrong attempts since you last unlocked").
 * - `attemptsBeforeLockout`, `recoveryCodesLeft`, `resetByEmail` (the
 *   forgot-PIN email is configured; `account:requestPinReset` answers ok
 *   either way).
 * `actionPin` is the Phase 4 shape the current dashboard reads (WP5b moves it
 * to `pin` and drops it).
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
    pin: v.object({
      set: v.boolean(),
      lockedUntil: v.union(v.number(), v.null()),
      lockKind: v.union(v.literal("backoff"), v.literal("lockout"), v.null()),
      failedSinceUnlock: v.number(),
      attemptsBeforeLockout: v.number(),
      recoveryCodesLeft: v.number(),
      /** The deployment can make recovery codes (the server pepper is set). False: setup can't finish; an operator must fix it. */
      recoveryAvailable: v.boolean(),
      resetByEmail: v.boolean(),
    }),
  }),
  handler: async (ctx) => {
    const f = await factorsOf(ctx, ctx.userId);
    const keys = await passkeysOf(ctx, ctx.userId);
    const row = await stepUpRowOf(ctx, who(ctx));
    const pinSet = f?.actionPinHash !== undefined;
    const view = pinView(pinSet ? pinCountersOf(await pinCountersRowOf(ctx, ctx.userId), f) : pinCountersOf(null, null));
    let bootstrapUntil: number | null = null;
    if (!pinSet) {
      const session = await ctx.db.get(ctx.sessionId);
      if (session !== null) bootstrapUntil = session._creationTime + STEP_UP_BOOTSTRAP_MS;
    }
    return {
      actionPin: {
        set: pinSet,
        lockedUntil: view.lockedUntil,
        // Since Phase 4b the PIN is never disabled: the hard limit locks it (24 h, 72 h, 7 days).
        disabled: false,
        attemptsBeforeDisable: view.attemptsBeforeLockout,
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
      pin: {
        set: pinSet,
        ...view,
        recoveryCodesLeft: f?.recoveryHashes?.length ?? 0,
        // An env read, no database cost: lets setup say so BEFORE the first PIN is saved.
        recoveryAvailable: recoveryPepper() !== null,
        resetByEmail: await mailReadyFlag(ctx),
      },
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
 * The first one: right after a password sign-in (bootstrap). A
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
    const mode = await ctx.runQuery(internal.stepUp.authorizeChange, { ...who(ctx), now });
    // The first PIN is followed by recovery codes in setup: with no pepper they can't be made, so
    // don't leave a person half set up (the dashboard says so up front; this is the server's guard).
    if (mode === "bootstrap") requirePepper();
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
    // Read-only here; the per-user charge is the reservation in `beginPinAttempt`
    // (backoff + lockout), so one person adds at most a few failures to the
    // global bucket before their own counter refuses them.
    await checkOrFail(ctx, "stepUpFailuresGlobal");
    const pin = args.pin.length <= 32 ? args.pin : args.pin.slice(0, 32);
    const reservedAt = Date.now();
    const attempt = await ctx.runMutation(internal.stepUp.beginPinAttempt, { userId: ctx.userId, now: reservedAt });
    // No hashing here: a member without a PIN must not be able to spend Argon2 work in a loop.
    if (attempt.kind === "noPin") fail("not_ready", { detail: "no action PIN" });
    // `detail: "lockout"`: the long lockout (24 h, 72 h, 7 days; else a short backoff).
    if (attempt.kind === "locked") fail("step_up_locked", { retryAfterMs: attempt.retryAfterMs, detail: attempt.lockout ? "lockout" : undefined });
    if (await verifySecret(pin, attempt.hash)) {
      const now = Date.now();
      await ctx.runMutation(internal.stepUp.finishPinSuccess, { ...who(ctx), now, reservedAt, hashChecked: attempt.hash });
      return verified(now);
    }
    await consumeQuietly(ctx, "stepUpFailuresGlobal");
    if (attempt.locksOut || attempt.sinceUnlock === PIN_WARN_AT) {
      await ctx.runMutation(internal.stepUp.noticePinFailures, {
        userId: ctx.userId,
        orgId: ctx.orgId,
        actor: ctx.actor,
        lockoutMs: attempt.locksOut ? attempt.nextDelayMs : 0,
        failures: attempt.sinceUnlock,
      });
    }
    if (attempt.locksOut) fail("step_up_locked", { retryAfterMs: attempt.nextDelayMs, detail: "lockout" });
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
    await deleteStepUpSessions(ctx, ctx.userId, key._id);
    await audit(ctx, ctx.orgId, ctx.actor, "member.passkeyRemoved", `${ctx.member.email} removed the passkey "${key.name}"`);
    return null;
  },
});

// ---------------------------------------------------------------- resets

/**
 * Remove the action PIN (and its counters), every passkey, every step-up row
 * (all of them, any number: the invariant at lib/stepUp.ts `hasPin`) and
 * every WebAuthn challenge of a person. The unused recovery codes are kept
 * (`keepRecovery` replaces them, e.g. without the one just used): they belong
 * to the person and stay a fallback.
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
  await deletePinCounters(ctx, userId);
  for (const k of await passkeysOf(ctx, userId)) await ctx.db.delete(k._id);
  await deleteStepUpSessions(ctx, userId);
  // A registration begun before the reset must not finish after it.
  await deleteChallenges(ctx, userId);
}

/**
 * An Owner removes another member's action PIN and passkeys (major), and
 * EVERY session of that member ends in the same transaction (Phase 4b
 * security review): the PIN stays unset, so only a session created after the
 * reset (a new password sign-in, less than STEP_UP_BOOTSTRAP_MS old) can set
 * the first PIN. A session that was open before the reset (a racing password
 * thief) is gone. The member is told to sign in again. Refused for yourself
 * (use a recovery code) and for a person who is also an active member of
 * another organization (step-up belongs to the person; an Owner of one
 * organization must not change it for another: they use a recovery code or
 * the operator).
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
    // Every session of the member ends (with refresh tokens and step-up rows).
    await deleteUserSessions(ctx, target.userId);
    await audit(
      ctx,
      ctx.orgId,
      ctx.actor,
      "member.stepUpReset",
      `Reset the action PIN and passkeys of ${target.email} and signed them out everywhere`,
      { id: target._id, label: target.email },
    );
    return null;
  },
});

/**
 * Lost or locked PIN: a fresh password sign-in (session younger than
 * STEP_UP_BOOTSTRAP_MS) plus one recovery code of the action PIN
 * (`stepUp:generateRecoveryCodes`) sets `newPin` in ONE transaction (Phase 4b
 * security review: the PIN is never left empty for a racing session to fill),
 * removes every passkey, ends every OTHER session of the person (with their
 * step-up rows) and unlocks this one. Never by email alone.
 *
 * - Only codes of the action PIN count (review finding 1).
 * - `recoveryCodePerUser` is CHARGED before any work (5 per 15 minutes per
 *   person, parallel calls included); the global step-up failure bucket is
 *   only read before and charged after a wrong code, so one person adds at
 *   most 5 per 15 minutes to it.
 * - `newPin` is required (WP5b): the dashboard always sends it.
 */
export const resetWithRecoveryCode = memberAction("viewer", { stepUp: "none" })({
  args: { code: v.string(), newPin: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const problem = actionPinProblem(args.newPin);
    if (problem !== null) fail("invalid_argument", { field: "newPin", detail: problem });
    requirePepper(); // fail closed (`not_ready`) before any charge or Argon2 work
    await consumeOrFail(ctx, "recoveryCodePerUser", ctx.userId);
    await checkOrFail(ctx, "stepUpFailuresGlobal");
    const hash = await hashSecret(ctx, args.newPin);
    const result = await ctx.runMutation(internal.stepUp.recoveryReset, {
      ...who(ctx),
      orgId: ctx.orgId,
      actor: ctx.actor,
      code: args.code.slice(0, 32),
      hash,
      now: Date.now(),
    });
    if (result.kind === "ok") return null;
    if (result.kind === "reauthenticate") fail("step_up_setup_required", { detail: "reauthenticate" });
    if (result.kind === "noCodes") fail("not_ready", { detail: "no recovery codes" });
    await consumeQuietly(ctx, "stepUpFailuresGlobal");
    fail("step_up_invalid");
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
    requirePepper(); // no pepper: no codes are shown (they could never be redeemed)
    const codes = newRecoveryCodes(ctx);
    await ctx.runMutation(internal.stepUp.storeRecoveryCodes, {
      userId: ctx.userId,
      orgId: ctx.orgId,
      actor: ctx.actor,
      hashes: codes.map((c) => recoveryHash(c)),
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
    const changed = await storePinHash(ctx, args.userId, args.hash, now);
    // The first PIN, set right after a password sign-in, unlocks the session (and makes it fresh).
    if (mode === "bootstrap") await markVerified(ctx, args, "actionPin", now);
    // A changed PIN: every OTHER session loses its unlock in this same transaction, so the old PIN
    // (possibly known to a thief) opens nothing that was unlocked with it.
    if (changed) await deleteStepUpSessions(ctx, args.userId, undefined, args.sessionId);
    await audit(
      ctx,
      args.orgId,
      args.actor,
      changed ? "member.actionPinChanged" : "member.actionPinSet",
      `${args.actor.label} ${changed ? "changed" : "set"} their action PIN`,
    );
    // The person is told (the first PIN needs only the password, so this notice is its safeguard).
    // Best effort: the scheduled mail runs after this commits and its failure changes nothing.
    const user = await ctx.db.get(args.userId);
    await ctx.scheduler.runAfter(0, internal.mail.send, { to: user?.email ?? args.actor.label, ...pinChangedMail(changed) });
    return null;
  },
});

const pinAttempt = v.union(
  v.object({ kind: v.literal("noPin") }),
  v.object({ kind: v.literal("locked"), retryAfterMs: v.number(), lockout: v.boolean() }),
  v.object({
    kind: v.literal("go"),
    hash: v.string(),
    /** Failures since the last unlock, this one included (it counts until `finishPinSuccess`). */
    sinceUnlock: v.number(),
    nextDelayMs: v.number(),
    locksOut: v.boolean(),
  }),
);

/**
 * Reserve one attempt BEFORE the Argon2 check: the attempt counts as a
 * failure until `finishPinSuccess` says otherwise. Parallel attempts
 * serialize on the counters row, so each is counted; a crash between begin
 * and finish leaves it counted (fail closed).
 *
 * Lockouts (lib/stepUp.ts `reservePinFailure`): PIN_HARD_LIMIT failures since
 * the last success or lockout, OR PIN_HARD_LIMIT failures in the rolling
 * 30-day window since the last lockout (a success does not reset the window),
 * lock the PIN for 24 h, then 72 h, then 7 days (never disabled: a password
 * thief cannot lock the owner out for good).
 */
export const beginPinAttempt = internalMutation({
  args: { userId: v.id("users"), now: v.number() },
  returns: pinAttempt,
  handler: async (ctx, args) => {
    const f = await factorsOf(ctx, args.userId);
    if (f === null || f.actionPinHash === undefined) return { kind: "noPin" as const };
    const row = await pinCountersRowOf(ctx, args.userId);
    const c = pinCountersOf(row, f);
    if (c.lockedUntil > args.now) return { kind: "locked" as const, retryAfterMs: c.lockedUntil - args.now, lockout: c.lockout };
    const r = reservePinFailure(c, args.now);
    await writePinCounters(ctx, args.userId, row, r.next);
    return { kind: "go" as const, hash: f.actionPinHash, sinceUnlock: r.next.sinceUnlock, nextDelayMs: r.nextDelayMs, locksOut: r.locksOut };
  },
});

/** The attempt reserved at `reservedAt` was right: undo it as a failure and unlock this session. */
export const finishPinSuccess = internalMutation({
  args: { ...whoArgs, now: v.number(), reservedAt: v.number(), hashChecked: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const f = await factorsOf(ctx, args.userId);
    if (f === null || f.actionPinHash === undefined) fail("step_up_invalid");
    // The PIN was changed or reset while Argon2 ran: the PIN that matched is the OLD one. Fail
    // (nothing unlocked, nothing written; the new PIN has its own fresh counters).
    if (!constantTimeEqual(f.actionPinHash, args.hashChecked)) fail("step_up_invalid");
    const row = await pinCountersRowOf(ctx, args.userId);
    await writePinCounters(ctx, args.userId, row, pinSuccess(pinCountersOf(row, f), args.reservedAt));
    await markVerified(ctx, args, "actionPin", args.now);
    return null;
  },
});

/**
 * After a wrong PIN: a lockout (`lockoutMs` > 0) audits
 * `member.actionPinLocked` and mails "your PIN is locked"; the PIN_WARN_AT-th
 * failure since the last unlock audits `member.actionPinWrongAttempts` and
 * mails "N wrong PIN attempts". Best effort:
 * the scheduled mail runs after this commits and its failure changes nothing.
 */
export const noticePinFailures = internalMutation({
  args: { userId: v.id("users"), orgId: v.id("organizations"), actor: actorArg, lockoutMs: v.number(), failures: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    const to = user?.email ?? args.actor.label;
    if (args.lockoutMs > 0) {
      const hours = Math.round(args.lockoutMs / 3_600_000);
      await audit(
        ctx,
        args.orgId,
        args.actor,
        "member.actionPinLocked",
        `The action PIN of ${args.actor.label} was locked for ${hours} hours after repeated wrong attempts`,
      );
      await ctx.scheduler.runAfter(0, internal.mail.send, { to, ...pinLockedMail(args.lockoutMs) });
    } else {
      // Visible to the Owners in the audit log too (a thief's quiet guesses are no longer silent).
      await audit(
        ctx,
        args.orgId,
        args.actor,
        "member.actionPinWrongAttempts",
        `${args.failures} wrong action PIN attempts on the account of ${args.actor.label} since they last unlocked`,
      );
      await ctx.scheduler.runAfter(0, internal.mail.send, { to, ...pinFailuresMail(args.failures) });
    }
    return null;
  },
});

/**
 * One recovery code of the action PIN + a fresh session: the new PIN is
 * stored in this same transaction, the passkeys and every OTHER session of
 * the person end, this session is unlocked.
 */
export const recoveryReset = internalMutation({
  args: { ...whoArgs, orgId: v.id("organizations"), actor: actorArg, code: v.string(), hash: v.string(), now: v.number() },
  returns: v.union(
    v.object({ kind: v.literal("ok") }),
    v.object({ kind: v.literal("invalid") }),
    v.object({ kind: v.literal("reauthenticate") }),
    v.object({ kind: v.literal("noCodes") }),
  ),
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (session === null || session.userId !== args.userId || !(await sessionIsFresh(ctx, args.sessionId, args.now))) {
      return { kind: "reauthenticate" as const };
    }
    const f = await factorsOf(ctx, args.userId);
    const hashes = f?.recoveryHashes ?? [];
    if (hashes.length === 0) return { kind: "noCodes" as const };
    const index = matchRecoveryHash(hashes, args.code);
    if (index === null) return { kind: "invalid" as const };
    const left = hashes.filter((_, i) => i !== index);
    await clearAllFactors(ctx, args.userId, left);
    await storePinHash(ctx, args.userId, args.hash, args.now);
    await deleteUserSessions(ctx, args.userId, args.sessionId);
    await markVerified(ctx, { userId: args.userId, sessionId: args.sessionId }, "actionPin", args.now);
    await audit(
      ctx,
      args.orgId,
      args.actor,
      "member.stepUpReset",
      `${args.actor.label} set a new action PIN with a recovery code (${left.length} left); passkeys removed, other sessions signed out`,
    );
    const user = await ctx.db.get(args.userId);
    const to = user?.email ?? args.actor.label;
    await ctx.scheduler.runAfter(0, internal.mail.send, { to, ...pinResetDoneMail("recoveryCode") });
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
    await deleteStepUpSessions(ctx, args.userId, key._id);
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
