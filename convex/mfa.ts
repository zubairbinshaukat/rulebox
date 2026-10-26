import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, type DatabaseReader, type MutationCtx } from "./_generated/server";
import { writeAudit } from "./lib/audit";
import { mfaRequiredFor, sessionHasMfa } from "./lib/authz";
import { base32Encode, constantTimeEqual, randomBytes, randomCrockford } from "./lib/crypto";
import { fail } from "./lib/errors";
import { memberAction, memberQuery } from "./lib/functions";
import { RECOVERY_CODE_COUNT, TOTP_LOCK_MS, TOTP_MAX_FAILURES } from "./lib/limits";
import { isRecoveryShape, otpauthUri, recoveryHash, verifyTotp } from "./lib/totp";

// TOTP second factor (plan Step 3.4, PRD 12.3). The five entry points skip
// the MFA gate (they are how a session passes it) and accept any role.
//
// Writer/reader of `memberSecrets.totpSecret` (plan 4.7): written only by
// `finishSetup` (confirmSetup), read only by `attemptTotp` (verify) and
// `finishSetup`. `totpPending` is written by `storePending` (beginSetup).
//
// Deviation: `verify` and `useRecoveryCode` are actions over internal
// mutations, not mutations. A mutation that throws `mfa_invalid_code` rolls
// back its own failure counter, so the lockout would never trigger; here the
// internal mutation commits the counter and the action throws.

const opts = { skipMfa: true } as const;

type Attempt =
  | { kind: "ok" }
  | { kind: "invalid" }
  | { kind: "locked"; retryAfterMs: number }
  | { kind: "notEnrolled" };

const attemptResult = v.union(
  v.object({ kind: v.literal("ok") }),
  v.object({ kind: v.literal("invalid") }),
  v.object({ kind: v.literal("locked"), retryAfterMs: v.number() }),
  v.object({ kind: v.literal("notEnrolled") }),
);

function throwFor(result: Attempt): void {
  if (result.kind === "ok") return;
  if (result.kind === "locked") fail("mfa_locked", { retryAfterMs: result.retryAfterMs });
  fail("mfa_invalid_code");
}

async function secretsOf(ctx: { db: DatabaseReader }, userId: Id<"users">) {
  return await ctx.db
    .query("memberSecrets")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .first();
}

/** Locked -> the remaining time, else null. */
function lockedFor(s: Doc<"memberSecrets">, now: number): number | null {
  return s.totpLockedUntil > now ? s.totpLockedUntil - now : null;
}

/** Count a failure; the 5th consecutive one locks for 15 minutes. */
async function recordFailure(ctx: Pick<MutationCtx, "db">, s: Doc<"memberSecrets">, now: number): Promise<Attempt> {
  const failures = s.totpFailures + 1;
  if (failures >= TOTP_MAX_FAILURES) {
    await ctx.db.patch(s._id, { totpFailures: 0, totpLockedUntil: now + TOTP_LOCK_MS });
    return { kind: "locked", retryAfterMs: TOTP_LOCK_MS };
  }
  await ctx.db.patch(s._id, { totpFailures: failures });
  return { kind: "invalid" };
}

/** Mark this session as having passed TOTP (no write when it already has). */
async function markSession(ctx: Pick<MutationCtx, "db">, userId: Id<"users">, sessionId: Id<"authSessions">) {
  const existing = await ctx.db
    .query("mfaSessions")
    .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
    .first();
  if (existing === null) await ctx.db.insert("mfaSessions", { sessionId, userId, verifiedAt: Date.now() });
}

// ---------------------------------------------------------------- public

/** MFA state of the signed-in user and session. Never a secret. */
export const status = memberQuery("viewer", opts)({
  args: {},
  returns: v.object({
    enrolled: v.boolean(),
    required: v.boolean(),
    verified: v.boolean(),
    lockedUntil: v.union(v.number(), v.null()),
    recoveryCodesLeft: v.number(),
  }),
  handler: async (ctx) => {
    const s = await secretsOf(ctx, ctx.userId);
    return {
      enrolled: s?.totpSecret !== undefined,
      required: mfaRequiredFor(ctx.member.role),
      verified: await sessionHasMfa(ctx, { userId: ctx.userId, sessionId: ctx.sessionId }),
      // Raw timestamp; the dashboard compares it with its clock (no Date.now() in queries).
      lockedUntil: s !== null && s.totpLockedUntil > 0 ? s.totpLockedUntil : null,
      recoveryCodesLeft: s?.totpSecret !== undefined ? s.recoveryHashes.length : 0,
    };
  },
});

/** Start enrolment: a new 160-bit secret, returned once with its otpauth:// URI. */
export const beginSetup = memberAction("viewer", opts)({
  args: {},
  returns: v.object({ secret: v.string(), uri: v.string() }),
  handler: async (ctx) => {
    const secret = base32Encode(randomBytes(ctx, 20));
    await ctx.runMutation(internal.mfa.storePending, { userId: ctx.userId, secret });
    return { secret, uri: otpauthUri(ctx.member.email, secret) };
  },
});

/** Finish enrolment with a first code; returns the 10 recovery codes once. */
export const confirmSetup = memberAction("viewer", opts)({
  args: { code: v.string() },
  returns: v.array(v.string()),
  handler: async (ctx, args) => {
    const codes: string[] = [];
    for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
      const raw = randomCrockford(ctx, 8);
      codes.push(`${raw.slice(0, 4)}-${raw.slice(4)}`);
    }
    const result: Attempt = await ctx.runMutation(internal.mfa.finishSetup, {
      userId: ctx.userId,
      sessionId: ctx.sessionId,
      orgId: ctx.orgId,
      memberId: ctx.member._id,
      email: ctx.member.email,
      code: args.code,
      recoveryHashes: codes.map(recoveryHash),
    });
    if (result.kind === "notEnrolled") fail("not_ready", { detail: "call beginSetup first" });
    throwFor(result);
    return codes;
  },
});

/** Pass the TOTP gate for this session with a 6-digit code. */
export const verify = memberAction("viewer", opts)({
  args: { code: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const result: Attempt = await ctx.runMutation(internal.mfa.attemptTotp, {
      userId: ctx.userId,
      sessionId: ctx.sessionId,
      code: args.code,
    });
    throwFor(result);
    return null;
  },
});

/** Pass the TOTP gate with a one-time recovery code (consumed). */
export const useRecoveryCode = memberAction("viewer", opts)({
  args: { code: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const result: Attempt = await ctx.runMutation(internal.mfa.attemptRecovery, {
      userId: ctx.userId,
      sessionId: ctx.sessionId,
      orgId: ctx.orgId,
      memberId: ctx.member._id,
      email: ctx.member.email,
      code: args.code,
    });
    throwFor(result);
    return null;
  },
});

// ---------------------------------------------------------------- internal


export const storePending = internalMutation({
  args: { userId: v.id("users"), secret: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const s = await secretsOf(ctx, args.userId);
    if (s?.totpSecret !== undefined) fail("mfa_already_enabled");
    if (s === null) {
      await ctx.db.insert("memberSecrets", {
        userId: args.userId,
        totpPending: args.secret,
        recoveryHashes: [],
        lastTotpStep: 0,
        totpFailures: 0,
        totpLockedUntil: 0,
      });
    } else {
      await ctx.db.patch(s._id, { totpPending: args.secret });
    }
    return null;
  },
});

export const finishSetup = internalMutation({
  args: {
    userId: v.id("users"),
    sessionId: v.id("authSessions"),
    orgId: v.id("organizations"),
    memberId: v.id("members"),
    email: v.string(),
    code: v.string(),
    recoveryHashes: v.array(v.string()),
  },
  returns: attemptResult,
  handler: async (ctx, args): Promise<Attempt> => {
    const now = Date.now();
    const s = await secretsOf(ctx, args.userId);
    if (s?.totpSecret !== undefined) fail("mfa_already_enabled");
    if (s === null || s.totpPending === undefined) return { kind: "notEnrolled" };
    const locked = lockedFor(s, now);
    if (locked !== null) return { kind: "locked", retryAfterMs: locked };
    const step = verifyTotp(s.totpPending, args.code, now, s.lastTotpStep);
    if (step === null) return await recordFailure(ctx, s, now);
    await ctx.db.patch(s._id, {
      totpSecret: s.totpPending,
      totpPending: undefined,
      totpEnabledAt: now,
      recoveryHashes: args.recoveryHashes,
      lastTotpStep: step,
      totpFailures: 0,
      totpLockedUntil: 0,
    });
    await markSession(ctx, args.userId, args.sessionId);
    await writeAudit(ctx, {
      orgId: args.orgId,
      actor: { type: "member", id: args.memberId, label: args.email },
      action: "member.mfaEnabled",
      targetType: "member",
      targetId: args.memberId,
      targetLabel: args.email,
      summary: `${args.email} turned on two-step sign-in`,
    });
    return { kind: "ok" };
  },
});

export const attemptTotp = internalMutation({
  args: { userId: v.id("users"), sessionId: v.id("authSessions"), code: v.string() },
  returns: attemptResult,
  handler: async (ctx, args): Promise<Attempt> => {
    const now = Date.now();
    const s = await secretsOf(ctx, args.userId);
    if (s === null || s.totpSecret === undefined) return { kind: "notEnrolled" };
    const locked = lockedFor(s, now);
    if (locked !== null) return { kind: "locked", retryAfterMs: locked };
    const step = verifyTotp(s.totpSecret, args.code, now, s.lastTotpStep);
    if (step === null) return await recordFailure(ctx, s, now);
    await ctx.db.patch(s._id, { lastTotpStep: step, totpFailures: 0 });
    await markSession(ctx, args.userId, args.sessionId);
    return { kind: "ok" };
  },
});

export const attemptRecovery = internalMutation({
  args: {
    userId: v.id("users"),
    sessionId: v.id("authSessions"),
    orgId: v.id("organizations"),
    memberId: v.id("members"),
    email: v.string(),
    code: v.string(),
  },
  returns: attemptResult,
  handler: async (ctx, args): Promise<Attempt> => {
    const now = Date.now();
    const s = await secretsOf(ctx, args.userId);
    if (s === null || s.totpSecret === undefined) return { kind: "notEnrolled" };
    const locked = lockedFor(s, now);
    if (locked !== null) return { kind: "locked", retryAfterMs: locked };
    const presented = isRecoveryShape(args.code) ? recoveryHash(args.code) : "";
    // Compare against every stored hash (no early exit).
    let index = -1;
    s.recoveryHashes.forEach((h, i) => {
      if (constantTimeEqual(h, presented) && presented !== "" && index === -1) index = i;
    });
    if (index === -1) return await recordFailure(ctx, s, now);
    await ctx.db.patch(s._id, {
      recoveryHashes: s.recoveryHashes.filter((_, i) => i !== index),
      totpFailures: 0,
    });
    await markSession(ctx, args.userId, args.sessionId);
    await writeAudit(ctx, {
      orgId: args.orgId,
      actor: { type: "member", id: args.memberId, label: args.email },
      action: "member.recoveryCodeUsed",
      targetType: "member",
      targetId: args.memberId,
      targetLabel: args.email,
      summary: `${args.email} signed in with a recovery code (${s.recoveryHashes.length - 1} left)`,
    });
    return { kind: "ok" };
  },
});
