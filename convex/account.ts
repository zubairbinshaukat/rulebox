import { invalidateSessions, modifyAccountCredentials, retrieveAccount } from "@convex-dev/auth/server";
import { doc } from "convex-helpers/validators";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalAction, type MutationCtx } from "./_generated/server";
import { validatePasswordRequirements } from "./auth";
import { hashSecret } from "./lib/argon";
import { writeAudit } from "./lib/audit";
import { findUsableInvite } from "./lib/authCallbacks";
import { getSignedIn, membershipsOf, requireMember } from "./lib/authz";
import { base64UrlOfBytes, codeHash, constantTimeEqual, normalizeEmail, randomBytes, sha256HexSync } from "./lib/crypto";
import { fail } from "./lib/errors";
import { internalMutation, internalQuery, memberAction, publicAction, publicQuery } from "./lib/functions";
import { MAX_PIN_RESET_TOKEN, MAX_PIN_RESETS_READ, PIN_RESET_TTL_MS, SERVER_API_VERSION } from "./lib/limits";
import { loadMailConfig, passwordChangedMail, pinResetDoneMail, pinResetMail, sendMail } from "./lib/mail";
import { getSecret, isDashboardOrigin } from "./lib/platformSecrets";
import { consumeOrFail } from "./lib/rateLimits";
import { runOrSchedule } from "./lib/retry";
import { deleteUserSessions } from "./lib/sessions";
import {
  actionPinProblem,
  checkStepUpOrFail,
  deleteStepUpSessions,
  hasPin,
  markVerified,
  pinSetupOf,
  sessionIsFresh,
  storePinHash,
} from "./lib/stepUp";
import { memberStatus, role } from "./lib/validators";
import schema from "./schema";

/**
 * The member check for `memberAction` (actions have no `db`). Same rules as
 * the query and mutation wrappers; the caller's identity travels with
 * `ctx.runQuery`.
 */
export const authorize = internalQuery({
  args: {
    minRole: role,
    orgId: v.optional(v.id("organizations")),
    /** The calling action's clock: refuses a session past its expiry (A10). */
    now: v.number(),
    /** Step-up level the action needs (plan 4.16); checked, never written here. */
    stepUp: v.optional(v.union(v.literal("unlocked"), v.literal("fresh"))),
    /** `stepUp: "pinSet"` of lib/functions.ts: the person must have an action PIN. */
    pinSet: v.optional(v.boolean()),
  },
  returns: v.object({
    member: doc(schema, "members"),
    orgId: v.id("organizations"),
    userId: v.id("users"),
    sessionId: v.id("authSessions"),
  }),
  handler: async (ctx, args) => {
    const m = await requireMember(ctx, args.minRole, {
      orgId: args.orgId,
      now: args.now,
    });
    if (args.stepUp !== undefined) await checkStepUpOrFail(ctx, m, args.stepUp, args.now);
    else if (args.pinSet === true && !(await hasPin(ctx, m.userId))) fail("step_up_setup_required", { detail: "pin" });
    return m;
  },
});

const meResult = v.union(
  v.null(),
  v.object({ noAccess: v.literal(true), serverApiVersion: v.number() }),
  v.object({
    email: v.string(),
    role,
    status: memberStatus,
    orgId: v.id("organizations"),
    orgName: v.string(),
    memberships: v.array(v.object({ orgId: v.id("organizations"), orgName: v.string(), role })),
    serverApiVersion: v.number(),
    /**
     * Phase 4b: the action PIN every member must set to finish sign-in.
     * `set` false: route to PIN setup (every member write answers
     * `step_up_setup_required` until then). Only these STABLE fields live
     * here (security review finding 7). `codesPending`: the PIN is set but its recovery codes were
     * never made (setup was left unfinished): the dashboard resumes setup at step 2. The lock screen's lockout, attempt
     * count and "reset by email" are in `stepUp:status.pin`, so a wrong PIN
     * never re-runs this query for every open tab.
     */
    pin: v.object({ required: v.boolean(), set: v.boolean(), codesPending: v.boolean() }),
  }),
);

/**
 * Who is signed in (public: `null` when signed out). With more than one
 * active membership the first one is "current"; the dashboard shows a switcher
 * only when `memberships` has more than one entry (v2).
 *
 * Reads (security review finding 7): the session, the memberships (<=
 * MAX_MEMBERSHIPS), their organizations and the person's `stepUpFactors` row
 * (changes only when the PIN, its recovery codes or a passkey id change). No
 * secret, flag or counter row.
 */
export const me = publicQuery({
  args: {},
  returns: meResult,
  handler: async (ctx) => {
    const signedIn = await getSignedIn(ctx);
    if (signedIn === null) return null;
    const rows = await membershipsOf(ctx, signedIn.userId);
    const active = rows.filter((m) => m.status === "active");
    const current = active[0];
    if (current === undefined) return { noAccess: true as const, serverApiVersion: SERVER_API_VERSION };

    const memberships: { orgId: Id<"organizations">; orgName: string; role: (typeof active)[number]["role"] }[] = [];
    for (const m of active) {
      const org = await ctx.db.get(m.orgId);
      if (org !== null) memberships.push({ orgId: m.orgId, orgName: org.name, role: m.role });
    }
    return {
      email: current.email,
      role: current.role,
      status: current.status,
      orgId: current.orgId,
      orgName: memberships.find((m) => m.orgId === current.orgId)?.orgName ?? "",
      memberships,
      serverApiVersion: SERVER_API_VERSION,
      pin: await pinSetupOf(ctx, signedIn.userId),
    };
  },
});

/** Sign-up pre-check (no writes): a usable `join` invite for this hash and email. */
export const checkJoinInvite = internalQuery({
  args: { tokenHash: v.string(), email: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    return (await findUsableInvite(ctx, args.tokenHash, args.email, "join", Date.now())) !== null;
  },
});

/**
 * Consume a `passwordReset` code: marks it used and answers the member's
 * user. Every failure is `invite_invalid` (no hint which part was wrong).
 */
export const consumeResetCode = internalMutation({
  args: { tokenHash: v.string(), email: v.string() },
  returns: v.object({ userId: v.id("users"), orgId: v.id("organizations"), memberId: v.id("members") }),
  handler: async (ctx, args) => {
    const invite = await findUsableInvite(ctx, args.tokenHash, args.email, "passwordReset", Date.now());
    if (invite === null) fail("invite_invalid");
    const member = await ctx.db
      .query("members")
      .withIndex("by_org_email", (q) => q.eq("orgId", invite.orgId).eq("email", args.email))
      .first();
    if (member === null || member.status !== "active") fail("invite_invalid");
    await ctx.db.patch(invite._id, { usedAt: Date.now() });
    return { userId: member.userId, orgId: member.orgId, memberId: member._id };
  },
});

export const auditPasswordReset = internalMutation({
  args: { orgId: v.id("organizations"), memberId: v.id("members"), email: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await writeAudit(ctx, {
      orgId: args.orgId,
      actor: { type: "member", id: args.memberId, label: args.email },
      action: "member.passwordReset",
      targetType: "member",
      targetId: args.memberId,
      targetLabel: args.email,
      summary: `${args.email} set a new password with a reset code`,
    });
    return null;
  },
});

/**
 * Set a new password with a one-time reset code from an Owner (public).
 * Every session of the user is signed out afterwards.
 */
export const redeemReset = publicAction({
  args: { email: v.string(), code: v.string(), newPassword: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const email = normalizeEmail(args.email);
    if (email === null) fail("invite_invalid");
    await consumeOrFail(ctx, "redeemCode", sha256HexSync(email));
    validatePasswordRequirements(args.newPassword);
    const target: { userId: Id<"users">; orgId: Id<"organizations">; memberId: Id<"members"> } =
      await ctx.runMutation(internal.account.consumeResetCode, { tokenHash: codeHash(args.code), email });
    await modifyAccountCredentials(ctx, {
      provider: "password",
      account: { id: email, secret: args.newPassword },
    });
    await invalidateSessions(ctx, { userId: target.userId });
    await ctx.runMutation(internal.account.signOutStepUp, { userId: target.userId });
    await ctx.runMutation(internal.account.auditPasswordReset, {
      orgId: target.orgId,
      memberId: target.memberId,
      email,
    });
    return null;
  },
});

// ---------------------------------------------------------------- forgot PIN by email (Phase 4b Part C)
//
// 1. `requestPinReset({})` (public action, but SESSION-BOUND since the
//    security review, finding 3; owner-approved deviation from plan Part C):
//    needs a signed-in session (the lock screen always has the password
//    session) of a person with an active membership, takes NO email and mails
//    only that person's own address. Rate limited per user (3 / hour) and
//    only then globally; then ALWAYS `{ ok: true }` (mail on or off: the lock
//    screen learns "reset by email is on" from `stepUp:status.pin`). It
//    schedules `deliverPinReset` with the user id only (no token exists yet,
//    so none is stored in the scheduler).
// 2. `deliverPinReset` (internal action): mail off -> nothing. Else a 256-bit
//    token; `createPinReset` stores its SHA-256 for that user if still an
//    active member (retiring older links) and audits, attributed to them; the
//    link `<dashboardOrigin>/pin-reset#token=...` is emailed. The token sits
//    in the URL FRAGMENT, which browsers never send to a server or in a
//    Referer; the page must still strip it at once
//    (`history.replaceState`) and be served with `Referrer-Policy:
//    no-referrer`. The token exists only in this action and in the email.
// 3. `redeemPinReset({ token, newPin })` (public): needs a signed-in session
//    from a password sign-in less than STEP_UP_BOOTSTRAP_MS ago (the email
//    alone is never enough, plan 4.16) whose user is the token's. Single use,
//    PIN_RESET_TTL_MS. Sets the PIN (clears the lockout), ends every OTHER
//    session of the person, unlocks this one, audits `member.pinReset` and
//    sends a "your PIN was reset" notice. Every token problem answers the
//    same `step_up_invalid`; a weak PIN is refused BEFORE the token is
//    looked at (the link is not spent).

/** Always `{ ok: true }` for a signed-in member (unless rate limited); mails only the caller's own address. */
export const requestPinReset = publicAction({
  args: {},
  returns: v.object({ ok: v.literal(true) }),
  handler: async (ctx) => {
    const caller: { userId: Id<"users">; sessionId: Id<"authSessions">; fresh: boolean } | null = await ctx.runQuery(
      internal.account.pinResetCaller,
      { now: Date.now() },
    );
    if (caller === null) fail("unauthenticated");
    await consumeOrFail(ctx, "pinResetPerUser", caller.userId);
    await consumeOrFail(ctx, "pinResetGlobal", "all");
    await ctx.scheduler.runAfter(0, internal.account.deliverPinReset, { userId: caller.userId });
    return { ok: true as const };
  },
});

export const deliverPinReset = internalAction({
  args: { userId: v.id("users") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const config = await loadMailConfig(ctx);
    const origin = await getSecret(ctx, "dashboardOrigin");
    if (config === null || origin === null || !isDashboardOrigin(origin)) return null;
    const token = base64UrlOfBytes(randomBytes(ctx, 32));
    const target: { to: string } | null = await ctx.runMutation(internal.account.createPinReset, {
      userId: args.userId,
      tokenHash: sha256HexSync(token),
      now: Date.now(),
    });
    if (target === null) return null;
    const link = `${origin}/pin-reset#token=${token}`;
    // Best effort: a failure is logged by sendMail (never the link) and the member asks again.
    await sendMail(ctx, { to: target.to, ...pinResetMail(link) }, config);
    return null;
  },
});

/** Store a reset link's hash for this user if they are still an active member; null otherwise. */
export const createPinReset = internalMutation({
  args: { userId: v.id("users"), tokenHash: v.string(), now: v.number() },
  returns: v.union(v.null(), v.object({ to: v.string() })),
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (user === null || user.email === undefined) return null;
    const active = (await membershipsOf(ctx, user._id)).filter((m) => m.status === "active");
    if (active.length === 0) return null;
    // One live link per person: a new request retires the older unused ones.
    await retireLinks(ctx, user._id);
    await ctx.db.insert("pinResets", {
      userId: user._id,
      tokenHash: args.tokenHash,
      createdAt: args.now,
      expiresAt: args.now + PIN_RESET_TTL_MS,
    });
    for (const m of active) {
      await writeAudit(ctx, {
        orgId: m.orgId,
        actor: { type: "member", id: m._id, label: m.email },
        action: "member.pinResetRequested",
        targetType: "member",
        targetId: m._id,
        targetLabel: m.email,
        summary: `${m.email} asked for a PIN reset email`,
      });
    }
    return { to: user.email };
  },
});

async function retireLinks(ctx: Pick<MutationCtx, "db">, userId: Id<"users">): Promise<void> {
  const rows = await ctx.db
    .query("pinResets")
    .withIndex("by_user_created", (q) => q.eq("userId", userId))
    .order("desc")
    .take(MAX_PIN_RESETS_READ);
  for (const r of rows) if (r.usedAt === undefined) await ctx.db.delete(r._id);
}

/** Set a new action PIN with an emailed link (see above). */
export const redeemPinReset = publicAction({
  args: { token: v.string(), newPin: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const caller: { userId: Id<"users">; sessionId: Id<"authSessions">; fresh: boolean } | null = await ctx.runQuery(
      internal.account.pinResetCaller,
      { now },
    );
    if (caller === null) fail("unauthenticated");
    if (!caller.fresh) fail("step_up_setup_required", { detail: "reauthenticate" });
    await consumeOrFail(ctx, "pinResetRedeem", caller.userId);
    const problem = actionPinProblem(args.newPin);
    if (problem !== null) fail("invalid_argument", { field: "newPin", detail: problem });
    // Equal work for every token: always hashed (a too long one hashes the empty string, which matches nothing).
    const tokenHash = sha256HexSync(args.token.length <= MAX_PIN_RESET_TOKEN ? args.token : "");
    const hash = await hashSecret(ctx, args.newPin);
    const result: { ok: boolean } = await ctx.runMutation(internal.account.finishPinReset, {
      userId: caller.userId,
      sessionId: caller.sessionId,
      tokenHash,
      hash,
      now: Date.now(),
    });
    if (!result.ok) fail("step_up_invalid");
    return null;
  },
});

export const pinResetCaller = internalQuery({
  args: { now: v.number() },
  returns: v.union(v.null(), v.object({ userId: v.id("users"), sessionId: v.id("authSessions"), fresh: v.boolean() })),
  handler: async (ctx, args) => {
    const signedIn = await getSignedIn(ctx, args.now);
    if (signedIn === null) return null;
    return { ...signedIn, fresh: await sessionIsFresh(ctx, signedIn.sessionId, args.now) };
  },
});

export const finishPinReset = internalMutation({
  args: {
    userId: v.id("users"),
    sessionId: v.id("authSessions"),
    tokenHash: v.string(),
    hash: v.string(),
    now: v.number(),
  },
  returns: v.object({ ok: v.boolean() }),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("pinResets")
      .withIndex("by_token_hash", (q) => q.eq("tokenHash", args.tokenHash))
      .first();
    if (row === null || !constantTimeEqual(row.tokenHash, args.tokenHash)) return { ok: false };
    if (row.usedAt !== undefined) return { ok: false };
    // Single use: a link presented by another person's session, or too late, is spent too.
    await ctx.db.patch(row._id, { usedAt: args.now });
    if (row.userId !== args.userId || row.expiresAt <= args.now) return { ok: false };
    // The session must still be the caller's (the action checked it a moment ago).
    const session = await ctx.db.get(args.sessionId);
    if (session === null || session.userId !== args.userId) return { ok: false };

    // The new PIN and fresh counters (the old PIN's lockout and window go with it).
    await storePinHash(ctx, args.userId, args.hash, args.now);
    await retireLinks(ctx, args.userId);
    // Every OTHER session ends (with its refresh tokens and step-up rows); this one is unlocked.
    await deleteUserSessions(ctx, args.userId, args.sessionId);
    await markVerified(ctx, { userId: args.userId, sessionId: args.sessionId }, "actionPin", args.now);

    const user = await ctx.db.get(args.userId);
    const active = (await membershipsOf(ctx, args.userId)).filter((m) => m.status === "active");
    for (const m of active) {
      await writeAudit(ctx, {
        orgId: m.orgId,
        actor: { type: "member", id: m._id, label: m.email },
        action: "member.pinReset",
        targetType: "member",
        targetId: m._id,
        targetLabel: m.email,
        summary: `${m.email} set a new action PIN with an emailed link; their other sessions were signed out`,
      });
    }
    const to = user?.email ?? active[0]?.email;
    if (to !== undefined) await ctx.scheduler.runAfter(0, internal.mail.send, { to, ...pinResetDoneMail("email") });
    return { ok: true };
  },
});

/** After a password reset: the old sessions are gone, so are their step-up rows. */
export const signOutStepUp = internalMutation({
  args: { userId: v.id("users") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await deleteStepUpSessions(ctx, args.userId);
    return null;
  },
});

// ---------------------------------------------------------------- change password (security review finding 5)

/**
 * Change the caller's own sign-in password. Needs a FRESH step-up (major
 * action: PIN or passkey within STEP_UP_FRESH_MS) AND the current password,
 * checked by Convex Auth's own `retrieveAccount` (the same Scrypt credential
 * the sign-in uses; its failed-attempt limit applies). The new password
 * follows the sign-up policy (`validatePasswordRequirements`) and is stored
 * by `modifyAccountCredentials` with the provider's hashing. Every OTHER
 * session of the person ends (refresh tokens and step-up rows); this one
 * stays signed in and unlocked. Audited `member.passwordChanged` in every
 * active membership; a notice is mailed (best effort). Per-user bucket
 * `passwordChange`, consumed before the current password is checked. Any
 * problem with the current password answers the same `invalid_argument`
 * (field "currentPassword").
 */
/** The one answer for any problem with the current password. */
function wrongPassword(): never {
  fail("invalid_argument", { field: "currentPassword" });
}

export const changePassword = memberAction("viewer", { major: "account:changePassword" })({
  args: { currentPassword: v.string(), newPassword: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    validatePasswordRequirements(args.newPassword);
    await consumeOrFail(ctx, "passwordChange", ctx.userId);
    const accountId: string | null = await ctx.runQuery(internal.account.passwordAccountOf, { userId: ctx.userId });
    if (accountId === null || args.currentPassword.length === 0 || args.currentPassword.length > 256) wrongPassword();
    try {
      const { user } = await retrieveAccount(ctx, { provider: "password", account: { id: accountId, secret: args.currentPassword } });
      if (user._id !== ctx.userId) wrongPassword();
    } catch {
      wrongPassword();
    }
    if (args.newPassword === args.currentPassword) fail("invalid_argument", { field: "newPassword", detail: "same as current" });
    await modifyAccountCredentials(ctx, { provider: "password", account: { id: accountId, secret: args.newPassword } });
    // The password is already changed (no transaction spans the action and this mutation), so the
    // revocation of the other sessions must not be lost: retried here, else scheduled.
    const finish = { userId: ctx.userId, sessionId: ctx.sessionId };
    await runOrSchedule(
      () => ctx.runMutation(internal.account.finishPasswordChange, finish),
      () => ctx.scheduler.runAfter(0, internal.account.finishPasswordChange, finish),
    );
    return null;
  },
});

/** The caller's password account id (Convex Auth `authAccounts.providerAccountId`), or null. */
export const passwordAccountOf = internalQuery({
  args: { userId: v.id("users") },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    const account = await ctx.db
      .query("authAccounts")
      .withIndex("userIdAndProvider", (q) => q.eq("userId", args.userId).eq("provider", "password"))
      .first();
    return account?.providerAccountId ?? null;
  },
});

export const finishPasswordChange = internalMutation({
  args: { userId: v.id("users"), sessionId: v.id("authSessions") },
  returns: v.null(),
  handler: async (ctx, args) => {
    // Every OTHER session ends (refresh tokens and step-up rows); this one stays as it is.
    await deleteUserSessions(ctx, args.userId, args.sessionId);
    const user = await ctx.db.get(args.userId);
    const active = (await membershipsOf(ctx, args.userId)).filter((m) => m.status === "active");
    for (const m of active) {
      await writeAudit(ctx, {
        orgId: m.orgId,
        actor: { type: "member", id: m._id, label: m.email },
        action: "member.passwordChanged",
        targetType: "member",
        targetId: m._id,
        targetLabel: m.email,
        summary: `${m.email} changed their sign-in password; their other sessions were signed out`,
      });
    }
    const to = user?.email ?? active[0]?.email;
    if (to !== undefined) await ctx.scheduler.runAfter(0, internal.mail.send, { to, ...passwordChangedMail() });
    return null;
  },
});
