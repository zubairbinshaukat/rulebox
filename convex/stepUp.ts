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
  STEP_UP_BOOTSTRAP_MS,
  STEP_UP_CHALLENGE_TTL_MS,
  STEP_UP_FRESH_MS,
  STEP_UP_IDLE_MS,
  STEP_UP_KEEPALIVE_MS,
  STEP_UP_MAX_AGE_MS,
} from "./lib/limits";
import { checkOrFail, consumeQuietly, consumeOrFail } from "./lib/rateLimits";
import {
  actionPinProblem,
  authorizeFactorChange,
  deleteStepUpSessions,
  factorsOf,
  hasFactor,
  markVerified,
  passkeysOf,
  pinBackoffMs,
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
    /** With no factor yet: setup without a step-up is allowed until then (fresh sign-in). */
    bootstrapUntil: v.union(v.number(), v.null()),
    policy: v.object({ idleMs: v.number(), keepAliveMs: v.number(), freshMs: v.number(), maxAgeMs: v.number() }),
  }),
  handler: async (ctx) => {
    const f = await factorsOf(ctx, ctx.userId);
    const keys = await passkeysOf(ctx, ctx.userId);
    const row = await stepUpRowOf(ctx, who(ctx));
    const pinSet = f?.actionPinHash !== undefined;
    const disabled = pinSet && (f.pinDisabledAt !== undefined || f.pinFailuresTotal >= PIN_HARD_LIMIT);
    let bootstrapUntil: number | null = null;
    if (!pinSet && keys.length === 0) {
      const session = await ctx.db.get(ctx.sessionId);
      if (session !== null) bootstrapUntil = session._creationTime + STEP_UP_BOOTSTRAP_MS;
    }
    return {
      actionPin: {
        set: pinSet,
        lockedUntil: pinSet && f.pinLockedUntil > 0 ? f.pinLockedUntil : null,
        disabled,
        attemptsBeforeDisable: pinSet ? Math.max(0, PIN_HARD_LIMIT - f.pinFailuresTotal) : PIN_HARD_LIMIT,
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
 * Set or change the action PIN. The first factor: right after a password
 * (+ TOTP) sign-in (bootstrap). A change: after a fresh step-up with the
 * current PIN or a passkey (a forgotten PIN is changed after a passkey
 * step-up). A hard-disabled PIN is replaced the same way, or reset by an
 * Owner / a recovery code.
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
    if (attempt.kind === "disabled") fail("step_up_locked", { detail: "disabled" });
    if (attempt.kind === "locked") fail("step_up_locked", { retryAfterMs: attempt.retryAfterMs });
    if (await verifySecret(pin, attempt.hash)) {
      const now = Date.now();
      await ctx.runMutation(internal.stepUp.finishPinSuccess, { ...who(ctx), now });
      return verified(now);
    }
    await consumeQuietly(ctx, "stepUpFailuresGlobal");
    if (attempt.total === PIN_HARD_LIMIT) {
      await ctx.runMutation(internal.stepUp.auditPinDisabled, { orgId: ctx.orgId, actor: ctx.actor });
      fail("step_up_locked", { detail: "disabled" });
    }
    fail("step_up_invalid", { retryAfterMs: attempt.nextDelayMs > 0 ? attempt.nextDelayMs : undefined });
  },
});

/** Remove the action PIN (major). Refused when it is the person's last factor. */
export const clearActionPin = memberMutation("viewer", { major: "stepUp:clearActionPin" })({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const f = await factorsOf(ctx, ctx.userId);
    if (f?.actionPinHash === undefined) return null;
    const keys = await passkeysOf(ctx, ctx.userId);
    if (!keys.some((k) => k.disabledAt === undefined)) fail("step_up_last_factor");
    await ctx.db.patch(f._id, {
      actionPinHash: undefined,
      actionPinSetAt: undefined,
      pinFailures: 0,
      pinFailuresTotal: 0,
      pinLockedUntil: 0,
      pinDisabledAt: undefined,
    });
    // Sessions unlocked with the PIN lose that unlock (the method is gone).
    const rows = await ctx.db
      .query("stepUpSessions")
      .withIndex("by_user", (q) => q.eq("userId", ctx.userId))
      .take(MAX_STEP_UP_SESSIONS);
    for (const r of rows) if (r.method === "actionPin") await ctx.db.delete(r._id);
    await audit(ctx, ctx.orgId, ctx.actor, "member.actionPinCleared", `${ctx.member.email} removed their action PIN`);
    return null;
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
 * factor (no action PIN and no other usable passkey). Every session unlocked
 * with this passkey, the current one included, loses its unlock.
 */
export const removePasskey = memberMutation("viewer", { major: "stepUp:removePasskey" })({
  args: { passkeyId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const key = await ownPasskey(ctx, args.passkeyId);
    const f = await factorsOf(ctx, ctx.userId);
    const others = (await passkeysOf(ctx, ctx.userId)).filter((k) => k._id !== key._id && k.disabledAt === undefined);
    const pinUsable = f?.actionPinHash !== undefined && f.pinDisabledAt === undefined;
    if (!pinUsable && others.length === 0) fail("step_up_last_factor");
    await ctx.db.delete(key._id);
    await deleteStepUpSessions(ctx, ctx.userId, key._id, MAX_STEP_UP_SESSIONS);
    await audit(ctx, ctx.orgId, ctx.actor, "member.passkeyRemoved", `${ctx.member.email} removed the passkey "${key.name}"`);
    return null;
  },
});

// ---------------------------------------------------------------- resets

async function clearAllFactors(ctx: Pick<MutationCtx, "db">, userId: Id<"users">): Promise<void> {
  const f = await factorsOf(ctx, userId);
  if (f !== null) await ctx.db.delete(f._id);
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
 * member then sets new ones after a fresh password + TOTP sign-in. Refused
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
 * Lost every factor: a fresh password + TOTP sign-in (session younger than
 * STEP_UP_BOOTSTRAP_MS) plus one MFA recovery code removes the action PIN and
 * all passkeys; the session can then set new ones (bootstrap). Never by email
 * alone. Recovery-code failures share the TOTP lockout counter.
 */
export const resetWithRecoveryCode = memberAction("viewer", { stepUp: "none" })({
  args: { code: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const result = await ctx.runMutation(internal.stepUp.recoveryReset, {
      ...who(ctx),
      orgId: ctx.orgId,
      actor: ctx.actor,
      code: args.code.slice(0, 32),
      now: Date.now(),
    });
    if (result.kind === "ok") return null;
    if (result.kind === "locked") fail("mfa_locked", { retryAfterMs: result.retryAfterMs });
    if (result.kind === "reauthenticate") fail("step_up_setup_required", { detail: "reauthenticate" });
    if (result.kind === "noMfa") fail("not_ready", { detail: "no recovery codes" });
    fail("mfa_invalid_code");
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
    // The first factor, set right after a password (+ TOTP) sign-in, unlocks the session.
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
  v.object({ kind: v.literal("disabled") }),
  v.object({ kind: v.literal("locked"), retryAfterMs: v.number() }),
  v.object({ kind: v.literal("go"), hash: v.string(), total: v.number(), nextDelayMs: v.number() }),
);

/**
 * Reserve one attempt BEFORE the Argon2 check: the attempt counts as a
 * failure until `finishPinSuccess` says otherwise. Parallel attempts
 * serialize on this row, so each is counted; a crash between begin and
 * finish leaves it counted (fail closed). The PIN_HARD_LIMIT-th failure
 * disables the PIN until it is reset.
 */
export const beginPinAttempt = internalMutation({
  args: { userId: v.id("users"), now: v.number() },
  returns: pinAttempt,
  handler: async (ctx, args) => {
    const f = await factorsOf(ctx, args.userId);
    if (f === null || f.actionPinHash === undefined) return { kind: "noPin" as const };
    if (f.pinDisabledAt !== undefined || f.pinFailuresTotal >= PIN_HARD_LIMIT) return { kind: "disabled" as const };
    if (f.pinLockedUntil > args.now) return { kind: "locked" as const, retryAfterMs: f.pinLockedUntil - args.now };
    const failures = f.pinFailures + 1;
    const total = f.pinFailuresTotal + 1;
    const nextDelayMs = pinBackoffMs(failures);
    await ctx.db.patch(f._id, {
      pinFailures: failures,
      pinFailuresTotal: total,
      pinLockedUntil: nextDelayMs > 0 ? args.now + nextDelayMs : 0,
      pinDisabledAt: total >= PIN_HARD_LIMIT ? args.now : undefined,
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

export const auditPinDisabled = internalMutation({
  args: { orgId: v.id("organizations"), actor: actorArg },
  returns: v.null(),
  handler: async (ctx, args) => {
    await audit(
      ctx,
      args.orgId,
      args.actor,
      "member.actionPinLocked",
      `The action PIN of ${args.actor.label} was turned off after ${PIN_HARD_LIMIT} wrong attempts`,
    );
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
  ),
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (session === null || args.now - session._creationTime > STEP_UP_BOOTSTRAP_MS) {
      return { kind: "reauthenticate" as const };
    }
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
      return r.kind === "locked" ? { kind: "locked" as const, retryAfterMs: r.retryAfterMs } : { kind: "invalid" as const };
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
      await authorizeFactorChange(ctx, args, args.now);
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
    const firstFactor = !(await hasFactor(ctx, args.userId));
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
    // The registration ceremony itself proved possession with user
    // verification; for a first factor (bootstrap) it unlocks the session.
    if (firstFactor) await markVerified(ctx, args, "passkey", now, passkeyId);
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
