import { v } from "convex/values";
import { components, internal } from "./_generated/api";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { SYSTEM_ACTOR, writeAudit } from "./lib/audit";
import { normalizeEmail } from "./lib/crypto";
import { fail } from "./lib/errors";
import {
  AUDIT_RETENTION_DAYS,
  AUTH_RATE_LIMIT_REFILL_MS,
  DAY_MS,
  INVITE_RETENTION_MS,
  MAINTENANCE_BATCH,
  MAX_MEMBERSHIPS,
  MIGRATION_ORG_BATCH,
  RATE_LIMIT_ROW_MAX_AGE_MS,
  REFRESH_TOKEN_USED_GRACE_MS,
  SESSION_INACTIVE_MS,
  SESSION_TOTAL_MS,
} from "./lib/limits";
import { ensureOrgRows } from "./lib/orgRows";
import { clearMfa } from "./lib/sessions";

// Daily cleanup (crons.ts; plan Step 3.6 and its A10 follow-up).
//
// Every stage reads ONLY rows that are dead, found through an index bound,
// never a whole table (pooled deployment: tables grow with tenants):
//
// - sessions        `authSessions` created more than SESSION_TOTAL_MS ago
//                   (Convex Auth sets expirationTime = creation + that value).
// - mfaSessions     `mfaSessions` created more than SESSION_TOTAL_MS ago (a row
//                   is created after its session, so that session has
//                   expired). Younger orphans (after a sign-out) are harmless:
//                   `requireMember` checks the session row first and session
//                   ids are never reused.
// - refreshExpired  `authRefreshTokens` created more than SESSION_INACTIVE_MS
//                   ago (expirationTime = creation + that value).
// - refreshUsed     younger tokens, paged by creation time: deleted when used
//                   more than REFRESH_TOKEN_USED_GRACE_MS ago and not the
//                   parent of an unused token (Convex Auth lets the parent of
//                   the active token fetch it again after a lost answer).
//                   Kept rows: the active token and its parent, about two per
//                   live session.
// - authRateLimits  Convex Auth's per-account failure rows fully refilled
//                   (last attempt more than an hour ago), paged.
// - invites         `invites.by_expires_at` below now - INVITE_RETENTION_MS.
// - auditLog        `auditLog.by_at` below the retention cutoff.
// - rateLimiter     the component's `clearAll` for rows created more than
//                   RATE_LIMIT_ROW_MAX_AGE_MS ago (100 per component call, it
//                   reschedules itself).
// - stepUpSessions  step-up rows created more than SESSION_TOTAL_MS ago.
// - stepUpChallenges expired WebAuthn challenges (`by_expires_at`).
//
// At most MAINTENANCE_BATCH rows per run; a stage reschedules itself while a
// batch is full, then the next stage starts. `now` is fixed for the whole
// daily run so paginated ranges stay identical between pages.

const STAGES = [
  "sessions",
  "mfaSessions",
  "refreshExpired",
  "refreshUsed",
  "authRateLimits",
  "invites",
  "auditLog",
  "rateLimiter",
  "stepUpSessions",
  "stepUpChallenges",
] as const;
type Stage = (typeof STAGES)[number];
const stage = v.union(...STAGES.map((s) => v.literal(s)));

type StageResult = { done: boolean; cursor: string | null };

/** Delete rows of `table` created before `before`, oldest first, one batch. */
async function deleteCreatedBefore(
  ctx: MutationCtx,
  table: "authSessions" | "mfaSessions" | "authRefreshTokens" | "stepUpSessions",
  before: number,
): Promise<StageResult> {
  const rows = await ctx.db
    .query(table)
    .withIndex("by_creation_time", (q) => q.lt("_creationTime", before))
    .take(MAINTENANCE_BATCH);
  for (const row of rows) await ctx.db.delete(row._id);
  return { done: rows.length < MAINTENANCE_BATCH, cursor: null };
}

async function refreshUsed(ctx: MutationCtx, now: number, cursor: string | null): Promise<StageResult> {
  const r = await ctx.db
    .query("authRefreshTokens")
    .withIndex("by_creation_time", (q) =>
      q.gte("_creationTime", now - SESSION_INACTIVE_MS).lt("_creationTime", now - REFRESH_TOKEN_USED_GRACE_MS),
    )
    .paginate({ numItems: MAINTENANCE_BATCH, cursor });
  for (const token of r.page) {
    if (token.firstUsedTime === undefined || token.firstUsedTime >= now - REFRESH_TOKEN_USED_GRACE_MS) continue;
    // Keep the parent of an unused token (normally exactly one child).
    const children = await ctx.db
      .query("authRefreshTokens")
      .withIndex("sessionIdAndParentRefreshTokenId", (q) =>
        q.eq("sessionId", token.sessionId).eq("parentRefreshTokenId", token._id),
      )
      .take(4);
    if (children.some((c) => c.firstUsedTime === undefined)) continue;
    await ctx.db.delete(token._id);
  }
  return { done: r.isDone, cursor: r.continueCursor };
}

async function authRateLimits(ctx: MutationCtx, now: number, cursor: string | null): Promise<StageResult> {
  const r = await ctx.db
    .query("authRateLimits")
    .withIndex("by_creation_time", (q) => q.lt("_creationTime", now - AUTH_RATE_LIMIT_REFILL_MS))
    .paginate({ numItems: MAINTENANCE_BATCH, cursor });
  for (const row of r.page) {
    if (row.lastAttemptTime < now - AUTH_RATE_LIMIT_REFILL_MS) await ctx.db.delete(row._id);
  }
  return { done: r.isDone, cursor: r.continueCursor };
}

async function runStage(ctx: MutationCtx, current: Stage, now: number, cursor: string | null): Promise<StageResult> {
  switch (current) {
    case "sessions":
      return await deleteCreatedBefore(ctx, "authSessions", now - SESSION_TOTAL_MS);
    case "mfaSessions":
      return await deleteCreatedBefore(ctx, "mfaSessions", now - SESSION_TOTAL_MS);
    case "refreshExpired":
      return await deleteCreatedBefore(ctx, "authRefreshTokens", now - SESSION_INACTIVE_MS);
    case "refreshUsed":
      return await refreshUsed(ctx, now, cursor);
    case "authRateLimits":
      return await authRateLimits(ctx, now, cursor);
    case "invites": {
      const rows = await ctx.db
        .query("invites")
        .withIndex("by_expires_at", (q) => q.lt("expiresAt", now - INVITE_RETENTION_MS))
        .take(MAINTENANCE_BATCH);
      for (const row of rows) await ctx.db.delete(row._id);
      return { done: rows.length < MAINTENANCE_BATCH, cursor: null };
    }
    case "auditLog": {
      const rows = await ctx.db
        .query("auditLog")
        .withIndex("by_at", (q) => q.lt("at", now - AUDIT_RETENTION_DAYS * DAY_MS))
        .take(MAINTENANCE_BATCH);
      for (const row of rows) await ctx.db.delete(row._id);
      return { done: rows.length < MAINTENANCE_BATCH, cursor: null };
    }
    case "rateLimiter":
      // Resets buckets created more than 7 days ago (they refill anyway; at
      // most one extra bucket per key per week). The component pages itself.
      await ctx.runMutation(components.rateLimiter.lib.clearAll, { before: now - RATE_LIMIT_ROW_MAX_AGE_MS });
      return { done: true, cursor: null };
    case "stepUpSessions":
      // Same rule as mfaSessions: created after its session, so older than
      // SESSION_TOTAL_MS means the session has expired.
      return await deleteCreatedBefore(ctx, "stepUpSessions", now - SESSION_TOTAL_MS);
    case "stepUpChallenges": {
      const rows = await ctx.db
        .query("stepUpChallenges")
        .withIndex("by_expires_at", (q) => q.lt("expiresAt", now))
        .take(MAINTENANCE_BATCH);
      for (const row of rows) await ctx.db.delete(row._id);
      return { done: rows.length < MAINTENANCE_BATCH, cursor: null };
    }
  }
}

export const daily = internalMutation({
  args: {
    stage: v.optional(stage),
    cursor: v.optional(v.union(v.string(), v.null())),
    now: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    const current: Stage = args.stage ?? STAGES[0];
    const result = await runStage(ctx, current, now, args.cursor ?? null);
    if (!result.done) {
      await ctx.scheduler.runAfter(0, internal.maintenance.daily, { stage: current, cursor: result.cursor, now });
    } else {
      const next = STAGES[STAGES.indexOf(current) + 1];
      if (next !== undefined) await ctx.scheduler.runAfter(0, internal.maintenance.daily, { stage: next, now });
    }
    return null;
  },
});

/**
 * Step 5 migration (plan Step 5 item 8, A1/A4/A7). For every organization:
 * creates the `orgPlans` row (copying a Step 3 `organizations.maxDevices` into
 * `limits.maxDevices`), the global `platformSettings` row, a missing
 * `orgStats` / `orgSecrets` row; recounts `groupCount`, `memberCount`
 * (active) and `deviceCount` (non-revoked) exactly; removes
 * `organizations.maxDevices` and `orgStats.pingIntervalMs`. Idempotent; writes
 * only what differs; MIGRATION_ORG_BATCH organizations per run, then it
 * schedules itself. Run once per deployment:
 *   npx convex run maintenance:migratePlans '{}'
 * After it ran everywhere, the two deprecated schema fields can be removed.
 */
export const migratePlans = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  returns: v.object({ organizations: v.number(), changed: v.number(), done: v.boolean() }),
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("organizations")
      .paginate({ numItems: MIGRATION_ORG_BATCH, cursor: args.cursor ?? null });
    const now = Date.now();
    let changed = 0;
    for (const org of page.page) {
      if (await ensureOrgRows(ctx, org, { updatedBy: "system", now })) changed++;
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.maintenance.migratePlans, { cursor: page.continueCursor });
    }
    return { organizations: page.page.length, changed, done: page.isDone };
  },
});

/**
 * CLI fallback when the only Owner lost their authenticator and recovery
 * codes (plan edge case 24):
 *   npx convex run maintenance:resetMfaByEmail '{"email":"owner@acme.test"}'
 */
export const resetMfaByEmail = internalMutation({
  args: { email: v.string() },
  returns: v.object({ reset: v.boolean() }),
  handler: async (ctx, args) => {
    const email = normalizeEmail(args.email);
    if (email === null) fail("invalid_argument", { field: "email" });
    const user = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", email))
      .first();
    if (user === null) fail("not_found");
    const reset = await clearMfa(ctx, user._id);
    if (reset) {
      const memberships = await ctx.db
        .query("members")
        .withIndex("by_user", (q) => q.eq("userId", user._id))
        .take(MAX_MEMBERSHIPS);
      for (const m of memberships) {
        await writeAudit(ctx, {
          orgId: m.orgId,
          actor: SYSTEM_ACTOR,
          action: "member.mfaReset",
          targetType: "member",
          targetId: m._id,
          targetLabel: m.email,
          summary: `Two-step sign-in reset from the command line for ${m.email}`,
        });
      }
    }
    return { reset };
  },
});
