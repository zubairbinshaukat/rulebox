import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

const BATCH = 100;

/**
 * Delete every Convex Auth session of a user, its refresh tokens, and the
 * user's `mfaSessions`. The same work as `invalidateSessions` from
 * `@convex-dev/auth/server`, which only runs in actions (it calls the
 * `auth:store` mutation); members:setDisabled is a mutation, so it does it in
 * its own transaction. `requireMember` checks the session row on every call,
 * so the user is signed out at once, not when the JWT expires.
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
  await deleteMfaSessions(ctx, userId, except);
  return deleted;
}

/** Remove the TOTP gate of every session of a user (except one). */
export async function deleteMfaSessions(
  ctx: Pick<MutationCtx, "db">,
  userId: Id<"users">,
  except?: Id<"authSessions">,
): Promise<void> {
  for (;;) {
    const rows = await ctx.db
      .query("mfaSessions")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(BATCH + 1);
    const victims = rows.filter((r) => r.sessionId !== except);
    for (const row of victims) await ctx.db.delete(row._id);
    if (rows.length <= BATCH) break;
  }
}

/** Clears TOTP fields and every MFA session of a user. False when nothing was set. */
export async function clearMfa(ctx: Pick<MutationCtx, "db">, userId: Id<"users">): Promise<boolean> {
  const s = await ctx.db
    .query("memberSecrets")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .first();
  if (s === null) return false;
  await ctx.db.delete(s._id);
  await deleteMfaSessions(ctx, userId);
  return true;
}
