import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { MAX_USER_SESSIONS } from "./limits";
import { deleteStepUpSessions } from "./stepUp";

const BATCH = 100;

/** Delete one session with its refresh tokens and step-up row. */
async function deleteSessionRows(ctx: Pick<MutationCtx, "db">, session: Doc<"authSessions">): Promise<void> {
  for (;;) {
    const tokens = await ctx.db
      .query("authRefreshTokens")
      .withIndex("sessionId", (q) => q.eq("sessionId", session._id))
      .take(BATCH);
    for (const token of tokens) await ctx.db.delete(token._id);
    if (tokens.length < BATCH) break;
  }
  for (const row of await ctx.db.query("stepUpSessions").withIndex("by_session", (q) => q.eq("sessionId", session._id)).take(BATCH)) {
    await ctx.db.delete(row._id);
  }
  await ctx.db.delete(session._id);
}

/**
 * Before a new session is created for `userId` (`beforeSessionCreation`): keep
 * at most MAX_USER_SESSIONS - 1 existing ones, deleting the OLDEST (at most
 * BATCH + 1 per sign-in; a backlog shrinks with each sign-in). This bounds
 * `deleteUserSessions` (reset, disable, password change), which must end every
 * session in ONE transaction to stay atomic.
 */
export async function pruneOldSessions(ctx: Pick<MutationCtx, "db">, userId: Id<"users">): Promise<number> {
  const oldest = await ctx.db
    .query("authSessions")
    .withIndex("userId", (q) => q.eq("userId", userId))
    .order("asc")
    .take(MAX_USER_SESSIONS + BATCH);
  const excess = oldest.length - (MAX_USER_SESSIONS - 1);
  if (excess <= 0) return 0;
  for (const session of oldest.slice(0, excess)) await deleteSessionRows(ctx, session);
  return excess;
}

/**
 * Delete every Convex Auth session of a user and its refresh tokens. The same
 * work as `invalidateSessions` from `@convex-dev/auth/server`, which only
 * runs in actions (it calls the `auth:store` mutation); members:setDisabled is
 * a mutation, so it does it in its own transaction. `requireMember` checks the session row on every call,
 * so the user is signed out at once, not when the JWT expires.
 *
 * Bounded by `pruneOldSessions` (at most MAX_USER_SESSIONS sessions per user,
 * kept at every sign-in), so one transaction always ends them all and a reset
 * stays atomic: nothing is left to a later continuation.
 */
export async function deleteUserSessions(
  ctx: Pick<MutationCtx, "db">,
  userId: Id<"users">,
  except?: Id<"authSessions">,
): Promise<number> {
  let deleted = 0;
  for (;;) {
    const sessions = await ctx.db
      .query("authSessions")
      .withIndex("userId", (q) => q.eq("userId", userId))
      .take(BATCH + 1);
    const victims = sessions.filter((s) => s._id !== except);
    for (const session of victims) {
      for (;;) {
        const tokens = await ctx.db
          .query("authRefreshTokens")
          .withIndex("sessionId", (q) => q.eq("sessionId", session._id))
          .take(BATCH);
        for (const token of tokens) await ctx.db.delete(token._id);
        if (tokens.length < BATCH) break;
      }
      await ctx.db.delete(session._id);
      deleted++;
    }
    if (sessions.length <= BATCH) break;
  }
  // Step-up rows of the deleted sessions (plan 4.16): harmless once the
  // session is gone, removed here so they do not wait for maintenance. Every
  // row, not a fixed batch (the invariant at lib/stepUp.ts `hasPin`).
  await deleteStepUpSessions(ctx, userId, undefined, except);
  return deleted;
}
