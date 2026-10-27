import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { internalMutation, internalQuery } from "./_generated/server";
import { writeAudit, type AuditActor } from "./lib/audit";
import { fail } from "./lib/errors";
import {
  counterOf,
  effectivePingInterval,
  ensurePlatformSettings,
  limitsProblem,
  LIMITS,
  loadOrgPlan,
  loadOrgStats,
  loadPlatformSettings,
  MAX_PLAN_TEXT,
  newOrgPlanFields,
  pingIntervalProblem,
  planDefaultsOf,
} from "./lib/plans";
import { planLimits, planLimitsPatch, planName, type PlanLimits } from "./lib/validators";

// Operator functions for plans, limits and the device ping interval (plan
// Step 5 item 8; post-Phase-5 plan 3.4). INTERNAL ONLY: no member can call
// them. Until the operator console and its platform API exist, the operator
// runs them from the command line against the deployment, for example:
//
//   npx convex run plans:show '{"orgId":"<id>"}'
//   npx convex run plans:setGlobalPingInterval '{"pingIntervalMs":1800000}'
//   npx convex run plans:setOrgPingInterval '{"orgId":"<id>","pingIntervalMs":300000}'
//   npx convex run plans:setOrgPingInterval '{"orgId":"<id>","pingIntervalMs":null}'
//   npx convex run plans:setLimits '{"orgId":"<id>","plan":"team"}'
//   npx convex run plans:setLimits '{"orgId":"<id>","limits":{"maxGroups":10},"note":"trial"}'
//   npx convex run plans:setPlanDefaults '{"plan":"free","limits":{"maxApps":30}}'
//
// (`--prod` targets the production deployment.) A per-tenant change writes an
// `org.planChanged` row into THAT tenant's audit log (actor "Rulebox
// support"). Changing defaults never changes existing tenants: their limits
// are a copy made at creation (post-Phase-5 3.1). Nothing is written when the
// value does not change. From Step 8 a ping-interval change also patches the
// affected `desiredHeads` in batches (the heads do not exist yet).

const OPERATOR: AuditActor = { type: "system", label: "Rulebox support" };

function operatorId(by: string | undefined): string {
  const id = (by ?? "cli").trim();
  if (!/^[A-Za-z0-9:._@-]{1,64}$/.test(id)) fail("invalid_argument", { field: "by" });
  return id;
}

function cleanNote(note: string | undefined): string | undefined {
  if (note === undefined) return undefined;
  const t = note.trim();
  if (t.length > MAX_PLAN_TEXT) fail("invalid_argument", { field: "note" });
  return t === "" ? undefined : t;
}

function limitChanges(before: PlanLimits, after: PlanLimits): string[] {
  const out: string[] = [];
  for (const key of Object.keys(after) as (keyof PlanLimits)[]) {
    if (before[key] !== after[key]) out.push(`${key} ${String(before[key])} -> ${String(after[key])}`);
  }
  return out;
}

/** What the operator needs to see for one tenant (or only the global settings). */
export const show = internalQuery({
  args: { orgId: v.optional(v.id("organizations")) },
  returns: v.any(),
  handler: async (ctx, args) => {
    const settings = await loadPlatformSettings(ctx);
    const global = {
      pingIntervalMs: effectivePingInterval(null, settings),
      planDefaults: planDefaultsOf(settings),
      revision: settings?.revision ?? null,
    };
    if (args.orgId === undefined) return { global };
    const org = await ctx.db.get(args.orgId);
    if (org === null) fail("not_found");
    const plan = await loadOrgPlan(ctx, args.orgId);
    const stats = await loadOrgStats(ctx, args.orgId);
    const usage: Record<string, number> = {};
    for (const [kind, spec] of Object.entries(LIMITS)) usage[kind] = counterOf(stats, spec.counter);
    return {
      global,
      org: { name: org.name },
      plan: plan.plan,
      status: plan.status,
      limits: plan.limits,
      migrated: plan.row !== null,
      revision: plan.row?.revision ?? null,
      pingIntervalMs: { override: plan.pingIntervalMs ?? null, effective: effectivePingInterval(plan, settings) },
      usage,
    };
  },
});

/** The global default device ping interval (owner Q2: 30 minutes). */
export const setGlobalPingInterval = internalMutation({
  args: { pingIntervalMs: v.number() },
  returns: v.object({ changed: v.boolean() }),
  handler: async (ctx, args) => {
    if (pingIntervalProblem(args.pingIntervalMs)) fail("invalid_argument", { field: "pingIntervalMs" });
    const settings = await ensurePlatformSettings(ctx);
    if (settings.pingIntervalMs === args.pingIntervalMs) return { changed: false };
    await ctx.db.patch(settings._id, { pingIntervalMs: args.pingIntervalMs, revision: settings.revision + 1 });
    return { changed: true };
  },
});

/** Load the tenant's plan row; created from the defaults when the migration has not reached it. */
async function planRowFor(
  ctx: Parameters<typeof ensurePlatformSettings>[0],
  orgId: Doc<"organizations">["_id"],
  by: string,
): Promise<Doc<"orgPlans">> {
  if ((await ctx.db.get(orgId)) === null) fail("not_found");
  const plan = await loadOrgPlan(ctx, orgId);
  if (plan.row !== null) return plan.row;
  const settings = await ensurePlatformSettings(ctx);
  const id = await ctx.db.insert("orgPlans", { orgId, ...newOrgPlanFields(settings, plan.plan, Date.now(), by) });
  return (await ctx.db.get(id))!;
}

/** A tenant's ping interval override; `null` removes it (the global value applies). */
export const setOrgPingInterval = internalMutation({
  args: { orgId: v.id("organizations"), pingIntervalMs: v.union(v.number(), v.null()), by: v.optional(v.string()) },
  returns: v.object({ changed: v.boolean() }),
  handler: async (ctx, args) => {
    const by = operatorId(args.by);
    const next = args.pingIntervalMs ?? undefined;
    if (next !== undefined && pingIntervalProblem(next)) fail("invalid_argument", { field: "pingIntervalMs" });
    const row = await planRowFor(ctx, args.orgId, by);
    if (row.pingIntervalMs === next) return { changed: false };
    const now = Date.now();
    await ctx.db.patch(row._id, { pingIntervalMs: next, revision: row.revision + 1, updatedBy: by, updatedAt: now });
    await writeAudit(ctx, {
      orgId: args.orgId,
      actor: OPERATOR,
      action: "org.planChanged",
      targetType: "organization",
      targetId: args.orgId,
      summary:
        next === undefined
          ? "Device check-in interval: back to the default"
          : `Device check-in interval set to ${Math.round(next / 60_000)} minutes`,
    });
    return { changed: true };
  },
});

/**
 * Change a tenant's plan and/or limits. A new `plan` copies that plan's
 * current defaults; `limits` then overrides single fields.
 * `expectedRevision` (optional on the CLI) refuses a stale edit.
 */
export const setLimits = internalMutation({
  args: {
    orgId: v.id("organizations"),
    plan: v.optional(planName),
    limits: v.optional(planLimitsPatch),
    expectedRevision: v.optional(v.number()),
    note: v.optional(v.string()),
    by: v.optional(v.string()),
  },
  returns: v.object({ changed: v.boolean(), revision: v.number() }),
  handler: async (ctx, args) => {
    const by = operatorId(args.by);
    const note = cleanNote(args.note);
    const row = await planRowFor(ctx, args.orgId, by);
    if (args.expectedRevision !== undefined && args.expectedRevision !== row.revision) fail("stale_edit");
    const settings = await loadPlatformSettings(ctx);
    const plan = args.plan ?? row.plan;
    const base = plan !== row.plan ? planDefaultsOf(settings)[plan] : row.limits;
    const limits: PlanLimits = { ...base };
    for (const [k, value] of Object.entries(args.limits ?? {})) {
      if (value !== undefined) (limits as Record<string, number | boolean>)[k] = value;
    }
    const bad = limitsProblem(limits);
    if (bad !== null) fail("invalid_argument", { field: bad });
    const changes = limitChanges(row.limits, limits);
    if (plan === row.plan && changes.length === 0) return { changed: false, revision: row.revision };
    const revision = row.revision + 1;
    await ctx.db.patch(row._id, { plan, limits, revision, updatedBy: by, updatedAt: Date.now() });
    const parts = [plan !== row.plan ? `plan ${row.plan} -> ${plan}` : null, ...changes].filter((x) => x !== null);
    await writeAudit(ctx, {
      orgId: args.orgId,
      actor: OPERATOR,
      action: "org.planChanged",
      targetType: "organization",
      targetId: args.orgId,
      summary: `Plan changed: ${parts.join("; ")}${note !== undefined ? ` (${note})` : ""}`,
    });
    // Lowering a limit below the current usage is allowed (post-Phase-5 3.2):
    // nothing is deleted; creates are refused until usage is below the limit.
    // `plans:applyLimits` (over-limit devices) comes with Step 7's credentials.
    return { changed: true, revision };
  },
});

/** The limits copied into NEW organizations of `plan`. Existing tenants keep theirs. */
export const setPlanDefaults = internalMutation({
  args: { plan: planName, limits: planLimitsPatch },
  returns: v.object({ changed: v.boolean(), limits: planLimits }),
  handler: async (ctx, args) => {
    const settings = await ensurePlatformSettings(ctx);
    const before = settings.planDefaults[args.plan];
    const limits: PlanLimits = { ...before };
    for (const [k, value] of Object.entries(args.limits)) {
      if (value !== undefined) (limits as Record<string, number | boolean>)[k] = value;
    }
    const bad = limitsProblem(limits);
    if (bad !== null) fail("invalid_argument", { field: bad });
    if (limitChanges(before, limits).length === 0) return { changed: false, limits };
    await ctx.db.patch(settings._id, {
      planDefaults: { ...settings.planDefaults, [args.plan]: limits },
      revision: settings.revision + 1,
    });
    return { changed: true, limits };
  },
});
