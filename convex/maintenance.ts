import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import { SYSTEM_ACTOR, writeAudit } from "./lib/audit";
import { normalizeEmail } from "./lib/crypto";
import { fail } from "./lib/errors";
import { AUDIT_RETENTION_DAYS, DAY_MS, INVITE_RETENTION_MS, MAINTENANCE_BATCH, MAX_MEMBERSHIPS } from "./lib/limits";
import { clearMfa } from "./lib/sessions";

const stage = v.union(v.literal("mfaSessions"), v.literal("authSessions"), v.literal("invites"), v.literal("auditLog"));
type Stage = "mfaSessions" | "authSessions" | "invites" | "auditLog";
const NEXT: Record<Stage, Stage | null> = {
  mfaSessions: "authSessions",
  authSessions: "invites",
  invites: "auditLog",
  auditLog: null,
};

/**
 * Daily cleanup (crons.ts, plan Step 3.6). One page of MAINTENANCE_BATCH rows
 * per run, rescheduling itself page by page and table by table, so no run
 * reads more than one batch. Writes only deletions of dead rows:
 * mfaSessions whose session is gone, expired Convex Auth sessions (with
 * their refresh tokens), invites expired more than 30 days ago, and audit
 * rows older than AUDIT_RETENTION_DAYS (auditLog.by_at).
 */
export const daily = internalMutation({
  args: { stage: v.optional(stage), cursor: v.optional(v.union(v.string(), v.null())) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const current: Stage = args.stage ?? "mfaSessions";
    const page = { numItems: MAINTENANCE_BATCH, cursor: args.cursor ?? null };
    let done: boolean;
    let cursor: string | null = null;

    if (current === "mfaSessions") {
      const r = await ctx.db.query("mfaSessions").paginate(page);
      for (const row of r.page) {
        if ((await ctx.db.get(row.sessionId)) === null) await ctx.db.delete(row._id);
      }
      done = r.isDone;
      cursor = r.continueCursor;
    } else if (current === "authSessions") {
      const r = await ctx.db.query("authSessions").paginate(page);
      for (const s of r.page) {
        if (s.expirationTime >= now) continue;
        const tokens = await ctx.db
          .query("authRefreshTokens")
          .withIndex("sessionId", (q) => q.eq("sessionId", s._id))
          .take(MAINTENANCE_BATCH);
        for (const t of tokens) await ctx.db.delete(t._id);
        await ctx.db.delete(s._id);
      }
      done = r.isDone;
      cursor = r.continueCursor;
    } else if (current === "invites") {
      const r = await ctx.db.query("invites").paginate(page);
      for (const inv of r.page) {
        if (inv.expiresAt < now - INVITE_RETENTION_MS) await ctx.db.delete(inv._id);
      }
      done = r.isDone;
      cursor = r.continueCursor;
    } else {
      const old = await ctx.db
        .query("auditLog")
        .withIndex("by_at", (q) => q.lt("at", now - AUDIT_RETENTION_DAYS * DAY_MS))
        .take(MAINTENANCE_BATCH);
      for (const row of old) await ctx.db.delete(row._id);
      done = old.length < MAINTENANCE_BATCH;
    }

    if (!done) {
      await ctx.scheduler.runAfter(0, internal.maintenance.daily, { stage: current, cursor });
    } else if (NEXT[current] !== null) {
      await ctx.scheduler.runAfter(0, internal.maintenance.daily, { stage: NEXT[current] });
    }
    return null;
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
