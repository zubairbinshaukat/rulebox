import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { writeAudit } from "./lib/audit";
import { checkRevision, getInOrg, nextRevision } from "./lib/authz";
import { codeHash, INVITE_CODE_LENGTH, normalizeEmail, randomCrockford } from "./lib/crypto";
import { fail } from "./lib/errors";
import { memberAction, memberMutation, memberQuery } from "./lib/functions";
import { INVITE_TTL_MS, MAX_INVITES_LISTED, MAX_MEMBERS, MAX_MEMBERSHIPS, RESET_CODE_TTL_MS } from "./lib/limits";
import { assertNotLastOwner } from "./lib/members";
import { clearMfa, deleteUserSessions } from "./lib/sessions";
import { inviteKind, memberStatus, role } from "./lib/validators";

// Members screen (plan Step 3.5). Everything except `list` is Owner-only
// (matrix 4.6). Invite and reset codes are made in actions (random values),
// stored as SHA-256 only, and returned exactly once.

/** Members and invites of the caller's organization. Never a hash or secret. */
export const list = memberQuery("viewer")({
  args: {},
  returns: v.object({
    members: v.array(
      v.object({
        _id: v.id("members"),
        email: v.string(),
        role,
        status: memberStatus,
        createdAt: v.number(),
        mfaEnrolled: v.boolean(),
        isYou: v.boolean(),
        revision: v.number(),
      }),
    ),
    invites: v.array(
      v.object({
        _id: v.id("invites"),
        email: v.string(),
        role,
        kind: inviteKind,
        expiresAt: v.number(),
        usedAt: v.optional(v.number()),
      }),
    ),
  }),
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("members")
      .withIndex("by_org_user", (q) => q.eq("orgId", ctx.orgId))
      .take(MAX_MEMBERS);
    const members = [];
    for (const m of rows) {
      const s = await ctx.db
        .query("memberSecrets")
        .withIndex("by_user", (q) => q.eq("userId", m.userId))
        .first();
      members.push({
        _id: m._id,
        email: m.email,
        role: m.role,
        status: m.status,
        createdAt: m.createdAt,
        mfaEnrolled: s?.totpSecret !== undefined,
        isYou: m._id === ctx.member._id,
        revision: m.revision,
      });
    }
    const invites = await ctx.db
      .query("invites")
      .withIndex("by_org", (q) => q.eq("orgId", ctx.orgId))
      .order("desc")
      .take(MAX_INVITES_LISTED);
    return {
      members,
      invites: invites.map((i) => ({
        _id: i._id,
        email: i.email,
        role: i.role,
        kind: i.kind,
        expiresAt: i.expiresAt,
        usedAt: i.usedAt,
      })),
    };
  },
});

const codeResult = v.object({ code: v.string(), expiresAt: v.number() });

/** Invite a new member (Owner). Returns the join code once. */
export const invite = memberAction("owner")({
  args: { email: v.string(), role },
  returns: codeResult,
  handler: async (ctx, args): Promise<{ code: string; expiresAt: number }> => {
    const email = normalizeEmail(args.email);
    if (email === null) fail("invalid_argument", { field: "email" });
    const code = randomCrockford(ctx, INVITE_CODE_LENGTH);
    const expiresAt: number = await ctx.runMutation(internal.members.storeInvite, {
      orgId: ctx.orgId,
      actor: ctx.actor,
      callerRole: ctx.member.role,
      email,
      role: args.role,
      tokenHash: codeHash(code),
    });
    return { code, expiresAt };
  },
});

const actorArg = v.object({ type: v.literal("member"), id: v.string(), label: v.string() });

export const storeInvite = internalMutation({
  args: {
    orgId: v.id("organizations"),
    actor: actorArg,
    callerRole: role,
    email: v.string(),
    role,
    tokenHash: v.string(),
  },
  returns: v.number(),
  handler: async (ctx, args) => {
    // Admins cannot create Owners (plan 4.6); kept for when admins may invite.
    if (args.role === "owner" && args.callerRole !== "owner") fail("forbidden");
    const existing = await ctx.db
      .query("members")
      .withIndex("by_org_email", (q) => q.eq("orgId", args.orgId).eq("email", args.email))
      .first();
    if (existing !== null) fail("already_member");
    const expiresAt = Date.now() + INVITE_TTL_MS;
    const memberId = ctx.db.normalizeId("members", args.actor.id) ?? undefined;
    const inviteId = await ctx.db.insert("invites", {
      orgId: args.orgId,
      email: args.email,
      role: args.role,
      kind: "join",
      tokenHash: args.tokenHash,
      expiresAt,
      createdBy: memberId,
    });
    await writeAudit(ctx, {
      orgId: args.orgId,
      actor: args.actor,
      action: "member.invited",
      targetType: "invite",
      targetId: inviteId,
      targetLabel: args.email,
      summary: `Invited ${args.email} as ${args.role}`,
    });
    return expiresAt;
  },
});

/** Revoke an unused invite or reset code (Owner): it expires now. */
export const revokeInvite = memberMutation("owner")({
  args: { inviteId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const inv = await getInOrg(ctx, "invites", args.inviteId, ctx.orgId);
    const now = Date.now();
    if (inv.usedAt !== undefined || inv.expiresAt <= now) return null; // nothing to change
    await ctx.db.patch(inv._id, { expiresAt: now });
    await writeAudit(ctx, {
      orgId: ctx.orgId,
      actor: ctx.actor,
      action: "member.inviteRevoked",
      targetType: "invite",
      targetId: inv._id,
      targetLabel: inv.email,
      summary: `Revoked the ${inv.kind === "join" ? "invite" : "reset code"} for ${inv.email}`,
    });
    return null;
  },
});

async function targetMember(
  ctx: { db: MutationCtx["db"]; orgId: Id<"organizations">; member: Doc<"members"> },
  memberId: string,
): Promise<Doc<"members">> {
  const target = await getInOrg(ctx, "members", memberId, ctx.orgId);
  if (target._id === ctx.member._id) fail("forbidden", { detail: "cannot change yourself" });
  return target;
}

/** Change a member's role (Owner). Not your own; never the last Owner's. */
export const changeRole = memberMutation("owner")({
  args: { memberId: v.string(), role, expectedRevision: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const target = await targetMember(ctx, args.memberId);
    checkRevision(target, args.expectedRevision);
    if (target.role === args.role) return null;
    if (target.role === "owner") await assertNotLastOwner(ctx, target);
    await ctx.db.patch(target._id, { role: args.role, revision: nextRevision(target) });
    await writeAudit(ctx, {
      orgId: ctx.orgId,
      actor: ctx.actor,
      action: "member.roleChanged",
      targetType: "member",
      targetId: target._id,
      targetLabel: target.email,
      summary: `Changed ${target.email} from ${target.role} to ${args.role}`,
    });
    return null;
  },
});

/**
 * Disable or enable a member (Owner). Disabling signs the person out of every
 * session only when they have no other active membership; otherwise the
 * disabled row alone blocks them here (plan 4.6).
 */
export const setDisabled = memberMutation("owner")({
  args: { memberId: v.string(), disabled: v.boolean(), expectedRevision: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const target = await targetMember(ctx, args.memberId);
    checkRevision(target, args.expectedRevision);
    const status = args.disabled ? "disabled" : "active";
    if (target.status === status) return null;
    if (args.disabled) await assertNotLastOwner(ctx, target);
    await ctx.db.patch(target._id, { status, revision: nextRevision(target) });
    if (args.disabled) {
      const others = await ctx.db
        .query("members")
        .withIndex("by_user", (q) => q.eq("userId", target.userId))
        .take(MAX_MEMBERSHIPS);
      const stillActive = others.some((m) => m._id !== target._id && m.status === "active");
      if (!stillActive) await deleteUserSessions(ctx, target.userId);
    }
    await writeAudit(ctx, {
      orgId: ctx.orgId,
      actor: ctx.actor,
      action: args.disabled ? "member.disabled" : "member.enabled",
      targetType: "member",
      targetId: target._id,
      targetLabel: target.email,
      summary: `${args.disabled ? "Disabled" : "Enabled"} ${target.email}`,
    });
    return null;
  },
});

/** A one-time password-reset code for a member (Owner), 24 hours, shown once. */
export const createResetCode = memberAction("owner")({
  args: { memberId: v.string() },
  returns: codeResult,
  handler: async (ctx, args): Promise<{ code: string; expiresAt: number }> => {
    const code = randomCrockford(ctx, INVITE_CODE_LENGTH);
    const expiresAt: number = await ctx.runMutation(internal.members.storeResetCode, {
      orgId: ctx.orgId,
      actor: ctx.actor,
      memberId: args.memberId,
      tokenHash: codeHash(code),
    });
    return { code, expiresAt };
  },
});

export const storeResetCode = internalMutation({
  args: { orgId: v.id("organizations"), actor: actorArg, memberId: v.string(), tokenHash: v.string() },
  returns: v.number(),
  handler: async (ctx, args) => {
    const target = await getInOrg(ctx, "members", args.memberId, args.orgId);
    if (target.status !== "active") fail("account_disabled");
    const expiresAt = Date.now() + RESET_CODE_TTL_MS;
    const inviteId = await ctx.db.insert("invites", {
      orgId: args.orgId,
      email: target.email,
      role: target.role,
      kind: "passwordReset",
      tokenHash: args.tokenHash,
      expiresAt,
      createdBy: ctx.db.normalizeId("members", args.actor.id) ?? undefined,
    });
    await writeAudit(ctx, {
      orgId: args.orgId,
      actor: args.actor,
      action: "member.resetCodeCreated",
      targetType: "invite",
      targetId: inviteId,
      targetLabel: target.email,
      summary: `Created a password reset code for ${target.email}`,
    });
    return expiresAt;
  },
});

/** Clear a member's authenticator and recovery codes (Owner). They enrol again. */
export const resetMfa = memberMutation("owner")({
  args: { memberId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const target = await getInOrg(ctx, "members", args.memberId, ctx.orgId);
    const changed = await clearMfa(ctx, target.userId);
    if (!changed) return null;
    await writeAudit(ctx, {
      orgId: ctx.orgId,
      actor: ctx.actor,
      action: "member.mfaReset",
      targetType: "member",
      targetId: target._id,
      targetLabel: target.email,
      summary: `Reset two-step sign-in for ${target.email}`,
    });
    return null;
  },
});
