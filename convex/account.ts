import { invalidateSessions, modifyAccountCredentials } from "@convex-dev/auth/server";
import { doc } from "convex-helpers/validators";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalMutation, internalQuery } from "./_generated/server";
import { validatePasswordRequirements } from "./auth";
import { writeAudit } from "./lib/audit";
import { findUsableInvite } from "./lib/authCallbacks";
import { getSignedIn, membershipsOf, mfaRequiredFor, requireMember, sessionHasMfa } from "./lib/authz";
import { codeHash, normalizeEmail, sha256HexSync } from "./lib/crypto";
import { fail } from "./lib/errors";
import { publicAction, publicQuery } from "./lib/functions";
import { SERVER_API_VERSION } from "./lib/limits";
import { consumeOrFail } from "./lib/rateLimits";
import { deleteMfaSessions } from "./lib/sessions";
import { checkStepUpOrFail, deleteStepUpSessions } from "./lib/stepUp";
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
    skipMfa: v.boolean(),
    orgId: v.optional(v.id("organizations")),
    /** The calling action's clock: refuses a session past its expiry (A10). */
    now: v.number(),
    /** Step-up level the action needs (plan 4.16); checked, never written here. */
    stepUp: v.optional(v.union(v.literal("unlocked"), v.literal("fresh"))),
  },
  returns: v.object({
    member: doc(schema, "members"),
    orgId: v.id("organizations"),
    userId: v.id("users"),
    sessionId: v.id("authSessions"),
  }),
  handler: async (ctx, args) => {
    const m = await requireMember(ctx, args.minRole, {
      skipMfa: args.skipMfa ? true : undefined,
      orgId: args.orgId,
      now: args.now,
    });
    if (args.stepUp !== undefined) await checkStepUpOrFail(ctx, m, args.stepUp, args.now);
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
    mfa: v.object({ enrolled: v.boolean(), required: v.boolean(), verified: v.boolean() }),
    serverApiVersion: v.number(),
  }),
);

/**
 * Who is signed in (public: `null` when signed out). With more than one
 * active membership the first one is "current"; the dashboard shows a switcher
 * only when `memberships` has more than one entry (v2).
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
    const secrets = await ctx.db
      .query("memberSecrets")
      .withIndex("by_user", (q) => q.eq("userId", signedIn.userId))
      .first();
    return {
      email: current.email,
      role: current.role,
      status: current.status,
      orgId: current.orgId,
      orgName: memberships.find((m) => m.orgId === current.orgId)?.orgName ?? "",
      memberships,
      mfa: {
        enrolled: secrets?.totpSecret !== undefined,
        required: mfaRequiredFor(current.role),
        verified: await sessionHasMfa(ctx, signedIn),
      },
      serverApiVersion: SERVER_API_VERSION,
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
    await ctx.runMutation(internal.account.signOutMfa, { userId: target.userId });
    await ctx.runMutation(internal.account.auditPasswordReset, {
      orgId: target.orgId,
      memberId: target.memberId,
      email,
    });
    return null;
  },
});

/** After a password reset: the old sessions are gone, so are their MFA rows. */
export const signOutMfa = internalMutation({
  args: { userId: v.id("users") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await deleteMfaSessions(ctx, args.userId);
    await deleteStepUpSessions(ctx, args.userId);
    return null;
  },
});
