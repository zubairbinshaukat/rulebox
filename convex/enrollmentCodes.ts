import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { env, internalMutation } from "./_generated/server";
import { writeAudit } from "./lib/audit";
import { getInOrg } from "./lib/authz";
import {
  ENROLLMENT_TOKEN_LENGTH,
  formatEnrollmentCode,
  isAgentAcceptableUrl,
  randomCrockford,
  sha256HexSync,
} from "./lib/crypto";
import { codeState, countsAsActive, normalizeLabel, recountActiveCodes } from "./lib/enrollmentCodes";
import { fail } from "./lib/errors";
import { memberAction, memberMutation, memberQuery } from "./lib/functions";
import {
  MAX_CODE_LABEL,
  MAX_CODE_PAGE,
  MAX_CODE_TTL_MINUTES,
  MAX_CODE_USES,
  MIN_CODE_TTL_MINUTES,
  MIN_CODE_USES,
  MINUTE_MS,
} from "./lib/limits";
import { bumpOrgStats, bumpStats, counterOf, LIMITS, loadOrgPlan, loadOrgStats } from "./lib/plans";

// Enrollment codes (plan Step 6; PRD 9.1, 12.3, 15). A code is
// `RBX1.` + base64url(`<CONVEX_CLOUD_URL>#<token>`): the token is 20 Crockford
// characters (100 bits, the agent's parser fixes the length) made in an
// ACTION (secure random), shown exactly once, and stored only as its SHA-256
// (plan 4.7: one writer `create`, one reader `enrollment:enroll`). No query,
// log or audit row ever contains the code or the hash.
//
// Hosted, pooled deployment: one URL for every tenant, so the code carries no
// tenant locator; the token alone finds the organization.

/** Throws `invalid_argument` unless `uses` and `ttlMinutes` are whole numbers in range. */
function checkBounds(uses: number, ttlMinutes: number): void {
  if (!Number.isInteger(uses) || uses < MIN_CODE_USES || uses > MAX_CODE_USES) fail("invalid_argument", { field: "uses" });
  if (!Number.isInteger(ttlMinutes) || ttlMinutes < MIN_CODE_TTL_MINUTES || ttlMinutes > MAX_CODE_TTL_MINUTES) {
    fail("invalid_argument", { field: "ttlMinutes" });
  }
}

/**
 * Create a code (admin; unlocked session, not a major action). Returns the
 * code ONCE. `plan_limit` (detail "enrollmentCodes") at the plan's
 * `maxEnrollmentCodesActive`, detail "suspended" for a suspended
 * organization; `not_found` for a group of another organization; `not_ready`
 * when the deployment URL is not one the agent accepts.
 */
export const create = memberAction("admin")({
  args: { groupId: v.string(), uses: v.number(), ttlMinutes: v.number(), label: v.optional(v.string()) },
  returns: v.object({ code: v.string(), expiresAt: v.number() }),
  handler: async (ctx, args): Promise<{ code: string; expiresAt: number }> => {
    checkBounds(args.uses, args.ttlMinutes);
    const label = normalizeLabel(args.label, MAX_CODE_LABEL);
    if (label === null) fail("invalid_argument", { field: "label" });
    const convexUrl = env.CONVEX_CLOUD_URL;
    if (convexUrl === undefined || !isAgentAcceptableUrl(convexUrl)) {
      fail("not_ready", { detail: "this deployment's URL cannot be used for enrollment" });
    }
    const token = randomCrockford(ctx, ENROLLMENT_TOKEN_LENGTH);
    const expiresAt: number = await ctx.runMutation(internal.enrollmentCodes.storeCode, {
      orgId: ctx.orgId,
      actor: ctx.actor,
      groupId: args.groupId,
      uses: args.uses,
      ttlMinutes: args.ttlMinutes,
      label,
      tokenHash: sha256HexSync(token),
    });
    return { code: formatEnrollmentCode(convexUrl, token), expiresAt };
  },
});

const actorArg = v.object({ type: v.literal("member"), id: v.string(), label: v.string() });

/** The single writer of `enrollmentTokens.tokenHash` (plan 4.7). */
export const storeCode = internalMutation({
  args: {
    orgId: v.id("organizations"),
    actor: actorArg,
    groupId: v.string(),
    uses: v.number(),
    ttlMinutes: v.number(),
    label: v.optional(v.string()),
    tokenHash: v.string(),
  },
  returns: v.number(),
  handler: async (ctx, args) => {
    checkBounds(args.uses, args.ttlMinutes);
    if (!/^[0-9a-f]{64}$/.test(args.tokenHash)) fail("invalid_argument");
    const group = await getInOrg(ctx, "groups", args.groupId, args.orgId);

    // Limit and counter in the same transaction as the insert (serializable).
    const now = Date.now();
    const plan = await loadOrgPlan(ctx, args.orgId);
    if (plan.status !== "active") fail("plan_limit", { detail: "suspended" });
    const stats = await loadOrgStats(ctx, args.orgId);
    const { limit, counter } = LIMITS.enrollmentCodes;
    const max = plan.limits[limit];
    let active = counterOf(stats, counter);
    if (active + 1 > max) {
      // Expired codes are still counted: recount once before refusing
      // (reads only; the corrected count is written with the increment below).
      const exact = await recountActiveCodes(ctx, args.orgId, now);
      if (exact === null || exact + 1 > max) fail("plan_limit", { detail: "enrollmentCodes" });
      active = exact;
    }

    // A 100-bit collision is not expected; refuse rather than shadow a code.
    const clash = await ctx.db
      .query("enrollmentTokens")
      .withIndex("by_token_hash", (q) => q.eq("tokenHash", args.tokenHash))
      .first();
    if (clash !== null) fail("conflict");

    const expiresAt = now + args.ttlMinutes * MINUTE_MS;
    const tokenId = await ctx.db.insert("enrollmentTokens", {
      orgId: args.orgId,
      tokenHash: args.tokenHash,
      expiresAt,
      usesLeft: args.uses,
      usesTotal: args.uses,
      revoked: false,
      groupId: group._id,
      createdAt: now,
      label: args.label,
      createdBy: ctx.db.normalizeId("members", args.actor.id) ?? undefined,
    });
    await bumpStats(ctx, stats, { activeEnrollmentCodes: active + 1 - counterOf(stats, counter) });
    await writeAudit(ctx, {
      orgId: args.orgId,
      actor: args.actor,
      action: "enrollment.codeCreated",
      targetType: "enrollmentCode",
      targetId: tokenId,
      targetLabel: args.label ?? group.name,
      summary: `Created an enrollment code for the group ${group.name}: ${args.uses} ${args.uses === 1 ? "use" : "uses"}, valid ${describeTtl(args.ttlMinutes)}`,
    });
    return expiresAt;
  },
});

function describeTtl(minutes: number): string {
  if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)} day(s)`;
  if (minutes % 60 === 0) return `${minutes / 60} hour(s)`;
  return `${minutes} minutes`;
}

const codeRow = v.object({
  _id: v.id("enrollmentTokens"),
  label: v.optional(v.string()),
  groupId: v.optional(v.id("groups")),
  groupName: v.optional(v.string()),
  usesLeft: v.number(),
  usesTotal: v.number(),
  expiresAt: v.number(),
  createdAt: v.number(),
  state: v.union(v.literal("active"), v.literal("usedUp"), v.literal("expired"), v.literal("revoked")),
  createdByEmail: v.optional(v.string()),
});

/**
 * The organization's codes, newest first (viewer, paginated by
 * `enrollmentTokens.by_org_created`). `nowMs` is the client's clock; it is
 * rounded down to the minute so the subscription re-runs at most once a
 * minute and the query never calls `Date.now()`. Never the code or the hash.
 */
export const list = memberQuery("viewer")({
  args: { paginationOpts: paginationOptsValidator, nowMs: v.number() },
  returns: paginationResultValidator(codeRow),
  handler: async (ctx, args) => {
    if (!Number.isFinite(args.nowMs) || args.nowMs < 0) fail("invalid_argument", { field: "nowMs" });
    const numItems = args.paginationOpts.numItems;
    if (!Number.isInteger(numItems) || numItems < 1 || numItems > MAX_CODE_PAGE) {
      fail("invalid_argument", { field: "paginationOpts" });
    }
    const now = Math.floor(args.nowMs / MINUTE_MS) * MINUTE_MS;
    const result = await ctx.db
      .query("enrollmentTokens")
      .withIndex("by_org_created", (q) => q.eq("orgId", ctx.orgId))
      .order("desc")
      .paginate(args.paginationOpts);

    // Per-call caches: a page of 50 codes usually names a handful of groups and members.
    const groupNames = new Map<Id<"groups">, string | undefined>();
    const emails = new Map<Id<"members">, string | undefined>();
    const page = [];
    for (const t of result.page) {
      let groupName: string | undefined;
      if (t.groupId !== undefined) {
        if (!groupNames.has(t.groupId)) {
          const g = await ctx.db.get(t.groupId);
          groupNames.set(t.groupId, g !== null && g.orgId === ctx.orgId ? g.name : undefined);
        }
        groupName = groupNames.get(t.groupId);
      }
      let createdByEmail: string | undefined;
      if (t.createdBy !== undefined) {
        if (!emails.has(t.createdBy)) {
          const m = await ctx.db.get(t.createdBy);
          emails.set(t.createdBy, m !== null && m.orgId === ctx.orgId ? m.email : undefined);
        }
        createdByEmail = emails.get(t.createdBy);
      }
      page.push({
        _id: t._id,
        label: t.label,
        groupId: t.groupId,
        groupName,
        usesLeft: Math.max(0, t.usesLeft),
        usesTotal: t.usesTotal ?? Math.max(0, t.usesLeft),
        expiresAt: t.expiresAt,
        createdAt: t.createdAt,
        state: codeState(t, now),
        createdByEmail,
      });
    }
    return { ...result, page };
  },
});

/**
 * Revoke a code (admin, major: fresh step-up; plan 4.16). Allowed for a
 * suspended organization (a security action). Already revoked = no write.
 */
export const revoke = memberMutation("admin", { major: "enrollmentCodes:revoke" })({
  args: { tokenId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const token = await getInOrg(ctx, "enrollmentTokens", args.tokenId, ctx.orgId);
    if (token.revoked === true) return null;
    const now = Date.now();
    await ctx.db.patch(token._id, { revoked: true });
    if (countsAsActive(token, now)) await bumpOrgStats(ctx, ctx.orgId, { activeEnrollmentCodes: -1 });
    await writeAudit(ctx, {
      orgId: ctx.orgId,
      actor: ctx.actor,
      action: "enrollment.codeRevoked",
      targetType: "enrollmentCode",
      targetId: token._id,
      targetLabel: token.label,
      summary: token.label !== undefined ? `Revoked the enrollment code ${token.label}` : "Revoked an enrollment code",
    });
    return null;
  },
});
