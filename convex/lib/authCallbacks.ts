import type { Id } from "../_generated/dataModel";
import type { DatabaseReader, MutationCtx } from "../_generated/server";
import { writeAudit } from "./audit";
import { constantTimeEqual, normalizeEmail } from "./crypto";
import { fail } from "./errors";
import { MAX_MEMBERSHIPS } from "./limits";
import { insertMembership } from "./members";

// Convex Auth callbacks (plan Step 3.1), kept here so tests can call them
// directly. They run inside Convex Auth's `auth:store` mutation.

/** Valid unused, unexpired invite of `kind` for this hash and email, or null. */
export async function findUsableInvite(
  ctx: { db: DatabaseReader },
  tokenHash: string,
  email: string,
  kind: "join" | "passwordReset",
  nowMs: number,
) {
  const invite = await ctx.db
    .query("invites")
    .withIndex("by_token_hash", (q) => q.eq("tokenHash", tokenHash))
    .first();
  if (invite === null) return null;
  // Equal-time comparison of the email so a wrong one does not answer faster.
  const emailOk = constantTimeEqual(invite.email, email);
  if (!emailOk || invite.kind !== kind || invite.usedAt !== undefined || invite.expiresAt <= nowMs) {
    return null;
  }
  return invite;
}

/**
 * `createOrUpdateUser`: an existing account keeps its user. A new account is
 * created only with a valid `join` invite for the same email, whose hash the
 * provider passes in the profile (`inviteTokenHash`). The invite is consumed
 * in this same mutation, so it is single-use even under concurrency. No
 * invite -> `invite_invalid`: open sign-up is impossible.
 */
export async function createOrUpdateUser(
  ctx: Pick<MutationCtx, "db">,
  args: { existingUserId: Id<"users"> | null; profile: Record<string, unknown> },
): Promise<Id<"users">> {
  if (args.existingUserId !== null) return args.existingUserId;
  const email = typeof args.profile.email === "string" ? normalizeEmail(args.profile.email) : null;
  const tokenHash = args.profile.inviteTokenHash;
  if (email === null || typeof tokenHash !== "string") fail("invite_invalid");
  const now = Date.now();
  const invite = await findUsableInvite(ctx, tokenHash, email, "join", now);
  if (invite === null) fail("invite_invalid");

  // Phase 4: one organization per user from the UI (plan 4.6). An email that
  // already belongs to a user is refused; attaching a second membership to an
  // existing user is a v2 feature.
  const existingUser = await ctx.db
    .query("users")
    .withIndex("email", (q) => q.eq("email", email))
    .first();
  if (existingUser !== null) fail("already_member");

  const userId = await ctx.db.insert("users", { email });
  const memberId = await insertMembership(ctx, { orgId: invite.orgId, userId, email, role: invite.role });
  await ctx.db.patch(invite._id, { usedAt: now });
  await writeAudit(ctx, {
    orgId: invite.orgId,
    actor: { type: "member", id: memberId, label: email },
    action: "member.joined",
    targetType: "member",
    targetId: memberId,
    targetLabel: email,
    summary: `${email} joined as ${invite.role}`,
  });
  return userId;
}

/** `beforeSessionCreation`: no active membership -> `account_disabled`. */
export async function beforeSessionCreation(
  ctx: Pick<MutationCtx, "db">,
  args: { userId: Id<"users"> },
): Promise<void> {
  const rows = await ctx.db
    .query("members")
    .withIndex("by_user", (q) => q.eq("userId", args.userId))
    .take(MAX_MEMBERSHIPS);
  if (!rows.some((m) => m.status === "active")) fail("account_disabled");
}
