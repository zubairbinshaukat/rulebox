import { getAuthSessionId, getAuthUserId } from "@convex-dev/auth/server";
import type { Auth } from "convex/server";
import type { Doc, Id, TableNames } from "../_generated/dataModel";
import type { DatabaseReader } from "../_generated/server";
import { fail } from "./errors";
import { MAX_MEMBERSHIPS } from "./limits";
import type { Role } from "./validators";

export type { Role };

const RANK: Record<Role, number> = { viewer: 0, admin: 1, owner: 2 };

export function roleRank(role: Role): number {
  return RANK[role];
}

/** Owners and Admins must pass the TOTP gate (PRD 12.3); Viewers may. */
export function mfaRequiredFor(role: Role): boolean {
  return role === "owner" || role === "admin";
}

export type AuthedCtx = { db: DatabaseReader; auth: Auth };

export type SignedIn = {
  userId: Id<"users">;
  sessionId: Id<"authSessions">;
};

/**
 * The signed-in user and session, or null. The session row must still exist:
 * a session deleted by `invalidateSessions` (member disabled, password reset)
 * stops working at once, not when its JWT expires.
 */
export async function getSignedIn(ctx: AuthedCtx): Promise<SignedIn | null> {
  const userIdRaw = await getAuthUserId(ctx);
  const sessionIdRaw = await getAuthSessionId(ctx);
  if (userIdRaw === null || sessionIdRaw === null) return null;
  const userId = ctx.db.normalizeId("users", userIdRaw);
  const sessionId = ctx.db.normalizeId("authSessions", sessionIdRaw);
  if (userId === null || sessionId === null) return null;
  const session = await ctx.db.get(sessionId);
  if (session === null || session.userId !== userId) return null;
  // No expiry check here (no Date.now() in queries): an expired session cannot
  // refresh its 10-minute JWT, and the maintenance job deletes the rows.
  return { userId, sessionId };
}

/** The user's memberships (at most MAX_MEMBERSHIPS, plan 4.6). */
export async function membershipsOf(
  ctx: { db: DatabaseReader },
  userId: Id<"users">,
): Promise<Doc<"members">[]> {
  return await ctx.db
    .query("members")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .take(MAX_MEMBERSHIPS);
}

/** True when this session passed TOTP (one verification covers every organization). */
export async function sessionHasMfa(
  ctx: { db: DatabaseReader },
  signedIn: SignedIn,
): Promise<boolean> {
  const row = await ctx.db
    .query("mfaSessions")
    .withIndex("by_session", (q) => q.eq("sessionId", signedIn.sessionId))
    .first();
  return row !== null && row.userId === signedIn.userId;
}

export type MemberOpts = { skipMfa?: true; orgId?: Id<"organizations"> };

export type MemberContext = {
  member: Doc<"members">;
  orgId: Id<"organizations">;
  userId: Id<"users">;
  sessionId: Id<"authSessions">;
};

/**
 * Plan 4.6 `requireMember`, steps 1-5. The organization is chosen among the
 * memberships the server just loaded; a client `orgId` only selects.
 */
export async function requireMember(
  ctx: AuthedCtx,
  minRole: Role,
  opts: MemberOpts = {},
): Promise<MemberContext> {
  const signedIn = await getSignedIn(ctx);
  if (signedIn === null) fail("unauthenticated");

  const rows = await membershipsOf(ctx, signedIn.userId);
  let member: Doc<"members">;
  if (opts.orgId !== undefined) {
    const row = rows.find((m) => m.orgId === opts.orgId);
    if (row === undefined) fail("not_found");
    if (row.status !== "active") fail("forbidden");
    member = row;
  } else {
    const active = rows.filter((m) => m.status === "active");
    if (active.length === 0) fail("forbidden");
    if (active.length > 1) fail("org_required");
    member = active[0]!;
  }

  if (roleRank(member.role) < roleRank(minRole)) fail("forbidden");

  if (opts.skipMfa !== true && mfaRequiredFor(member.role)) {
    if (!(await sessionHasMfa(ctx, signedIn))) fail("mfa_required");
  }

  return {
    member,
    orgId: member.orgId,
    userId: signedIn.userId,
    sessionId: signedIn.sessionId,
  };
}

/**
 * Every id a handler receives is checked with this (plan 4.6 step 5).
 * Another organization's document answers `not_found`, never `forbidden`, so
 * its existence is not confirmed.
 */
export function assertInOrg<T extends { orgId: Id<"organizations"> }>(
  doc: T | null,
  orgId: Id<"organizations">,
): T {
  if (doc === null || doc.orgId !== orgId) fail("not_found");
  return doc;
}

/** Load a document by a client-supplied id string and check its organization. */
export async function getInOrg<T extends TableNames>(
  ctx: { db: DatabaseReader },
  table: T,
  id: string,
  orgId: Id<"organizations">,
): Promise<Doc<T>> {
  const normalized = ctx.db.normalizeId(table, id);
  if (normalized === null) fail("not_found");
  const doc = (await ctx.db.get(normalized)) as (Doc<T> & { orgId?: Id<"organizations"> }) | null;
  if (doc === null || doc.orgId !== orgId) fail("not_found");
  return doc;
}

/** Optimistic concurrency (plan D17): `stale_edit` when the row changed. */
export function checkRevision(doc: { revision?: number }, expected: number): void {
  if ((doc.revision ?? 0) !== expected) fail("stale_edit");
}

export function nextRevision(doc: { revision?: number }): number {
  return (doc.revision ?? 0) + 1;
}
