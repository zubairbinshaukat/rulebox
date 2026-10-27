import type { Doc, Id } from "../_generated/dataModel";
import { env, type DatabaseReader, type DatabaseWriter } from "../_generated/server";
import { fail } from "./errors";
import { MINUTE_MS, HOUR_MS } from "./limits";
import type { PlanLimits, PlanName, PlanStatus } from "./validators";

// Plans, limits and the ping interval (plan 4.2.1 / Step 5 item 8, A1, A4;
// post-Phase-5 plan Section 3). Limits are a SECURITY feature: enforced only
// here, on the server, inside the mutation that creates the counted thing.
//
// How the counters stay exact: every create/delete mutation reads the org's
// `orgStats` row, checks the limit and writes the new count in the same
// transaction. Convex mutations are serializable (optimistic concurrency):
// two racing creates both read the row, the second commit conflicts and is
// retried against the new count, so no interleaving can pass the limit.

/** "No limit" for the self-host plan. A finite number keeps JSON and the console simple. */
export const UNLIMITED = 1_000_000_000;
const GIB = 1024 * 1024 * 1024;
const MIB = 1024 * 1024;

/** Owner Q3 (2026-10-27): the free hosted plan. */
export const FREE_LIMITS: PlanLimits = {
  maxDevices: 2,
  maxEmployees: 25,
  maxApps: 20,
  maxGroups: 3,
  maxMembers: 2,
  auditRetentionDays: 30,
  storageQuotaBytes: GIB,
  maxUploadBytes: 500 * MIB,
  watchMode: true,
  maxEnrollmentCodesActive: 5,
};

/**
 * Paid hosted plan. PLACEHOLDER values (no owner decision yet); the operator
 * changes them with `plans:setPlanDefaults` before anyone is on this plan.
 */
export const TEAM_LIMITS: PlanLimits = {
  maxDevices: 50,
  maxEmployees: 500,
  maxApps: 200,
  maxGroups: 50,
  maxMembers: 10,
  auditRetentionDays: 365,
  storageQuotaBytes: 10 * GIB,
  maxUploadBytes: 2 * GIB,
  watchMode: true,
  maxEnrollmentCodesActive: 20,
};

/** Self-host: no limits, 365-day audit. */
export const CUSTOM_LIMITS: PlanLimits = {
  maxDevices: UNLIMITED,
  maxEmployees: UNLIMITED,
  maxApps: UNLIMITED,
  maxGroups: UNLIMITED,
  maxMembers: UNLIMITED,
  auditRetentionDays: 365,
  storageQuotaBytes: Number.MAX_SAFE_INTEGER,
  maxUploadBytes: 4 * GIB,
  watchMode: true,
  maxEnrollmentCodesActive: UNLIMITED,
};

export const DEFAULT_PLAN_LIMITS: Record<PlanName, PlanLimits> = {
  free: FREE_LIMITS,
  team: TEAM_LIMITS,
  custom: CUSTOM_LIMITS,
};

/** Owner Q2: 30 minutes, global; per-tenant override in `orgPlans.pingIntervalMs`. */
export const DEFAULT_PING_INTERVAL_MS = 30 * MINUTE_MS;
/** Bounds of either setting (plan 4.9): 1 minute to 6 hours. */
export const MIN_PING_INTERVAL_MS = MINUTE_MS;
export const MAX_PING_INTERVAL_MS = 6 * HOUR_MS;
/** Operator note / suspension reason length. */
export const MAX_PLAN_TEXT = 200;

/** True on the hosted, pooled deployment (env `RULEBOX_HOSTED=1`). */
export function isHostedDeployment(): boolean {
  return env.RULEBOX_HOSTED === "1";
}

/** The plan a new organization gets: `free` when hosted, else self-host `custom`. */
export function defaultPlanForNewOrg(): PlanName {
  return isHostedDeployment() ? "free" : "custom";
}

// ---------------------------------------------------------------- reads

/** The global settings row, or null before the first org exists (1 read). */
export async function loadPlatformSettings(ctx: { db: DatabaseReader }): Promise<Doc<"platformSettings"> | null> {
  return await ctx.db
    .query("platformSettings")
    .withIndex("by_key", (q) => q.eq("key", "global"))
    .unique();
}

export function planDefaultsOf(settings: Doc<"platformSettings"> | null): Record<PlanName, PlanLimits> {
  return settings?.planDefaults ?? DEFAULT_PLAN_LIMITS;
}

export type EffectivePlan = {
  plan: PlanName;
  status: PlanStatus;
  limits: PlanLimits;
  pingIntervalMs?: number;
  /** The stored row; null for an organization the migration has not reached. */
  row: Doc<"orgPlans"> | null;
};

/**
 * The organization's plan: 1 read (`orgPlans.by_org`). An organization
 * without a row (made before Step 5 and not migrated yet) gets the default
 * plan of this deployment with the current defaults (1 more read).
 */
export async function loadOrgPlan(ctx: { db: DatabaseReader }, orgId: Id<"organizations">): Promise<EffectivePlan> {
  const row = await ctx.db
    .query("orgPlans")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .unique();
  if (row !== null) {
    return { plan: row.plan, status: row.status, limits: row.limits, pingIntervalMs: row.pingIntervalMs, row };
  }
  const plan = defaultPlanForNewOrg();
  const limits = planDefaultsOf(await loadPlatformSettings(ctx))[plan];
  return { plan, status: "active", limits, row: null };
}

/** Effective device ping interval (plan 4.9): per-tenant override, else global, else 30 minutes. */
export function effectivePingInterval(
  plan: { pingIntervalMs?: number } | null,
  settings: { pingIntervalMs: number } | null,
): number {
  return plan?.pingIntervalMs ?? settings?.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
}

// ---------------------------------------------------------------- counters

/** The counters kept in `orgStats` (plan 4.2.1). */
export type CounterField =
  | "deviceCount"
  | "employeeCount"
  | "activeEmployeeCount"
  | "appCount"
  | "groupCount"
  | "memberCount"
  | "noGroupDeviceCount"
  | "outOfSupportCount"
  | "failedInstallCount"
  | "activeEnrollmentCodes";

/** Limits a create mutation checks (post-Phase-5 3.2). The name is the `plan_limit` detail. */
export type LimitKind = "devices" | "employees" | "apps" | "groups" | "members" | "enrollmentCodes";

type NumericLimit = Exclude<keyof PlanLimits, "watchMode">;

export const LIMITS: Record<LimitKind, { limit: NumericLimit; counter: CounterField }> = {
  devices: { limit: "maxDevices", counter: "deviceCount" },
  employees: { limit: "maxEmployees", counter: "employeeCount" },
  apps: { limit: "maxApps", counter: "appCount" },
  groups: { limit: "maxGroups", counter: "groupCount" },
  members: { limit: "maxMembers", counter: "memberCount" },
  enrollmentCodes: { limit: "maxEnrollmentCodesActive", counter: "activeEnrollmentCodes" },
};

export function counterOf(stats: Doc<"orgStats">, field: CounterField): number {
  return stats[field] ?? 0;
}

/**
 * The organization's counter row (1 read). Every organization has one from
 * creation (`setup`) or from `maintenance:migratePlans`; a missing row is a
 * deployment that was not migrated, and writes fail closed.
 */
export async function loadOrgStats(ctx: { db: DatabaseReader }, orgId: Id<"organizations">): Promise<Doc<"orgStats">> {
  const stats = await ctx.db
    .query("orgStats")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .unique();
  if (stats === null) fail("not_ready", { detail: "organization counters missing; run maintenance:migratePlans" });
  return stats;
}

/**
 * Refuse unless `adding` more of `kind` fit the plan (2 reads: `orgPlans`,
 * `orgStats`). Throws `plan_limit` with `detail` = the limit's name, or
 * `detail: "suspended"` when the organization is not active. Returns the
 * counter row so the caller writes the new count in the same mutation
 * (`bumpStats`). Step 6 calls it with "devices" and "enrollmentCodes",
 * Steps 10/11 with "apps" / "employees".
 */
export async function assertWithinLimit(
  ctx: { db: DatabaseReader },
  orgId: Id<"organizations">,
  kind: LimitKind,
  adding = 1,
): Promise<Doc<"orgStats">> {
  const plan = await loadOrgPlan(ctx, orgId);
  if (plan.status !== "active") fail("plan_limit", { detail: "suspended" });
  const stats = await loadOrgStats(ctx, orgId);
  const { limit, counter } = LIMITS[kind];
  if (counterOf(stats, counter) + adding > plan.limits[limit]) fail("plan_limit", { detail: kind });
  return stats;
}

/**
 * Apply counter deltas to an `orgStats` row (never below 0). One patch, and
 * none when nothing changes.
 */
export async function bumpStats(
  ctx: { db: DatabaseWriter },
  stats: Doc<"orgStats">,
  deltas: Partial<Record<CounterField, number>>,
): Promise<void> {
  const patch: Partial<Record<CounterField, number>> = {};
  let changed = false;
  for (const [field, delta] of Object.entries(deltas) as [CounterField, number][]) {
    if (delta === 0) continue;
    const next = Math.max(0, counterOf(stats, field) + delta);
    if (next !== stats[field]) {
      patch[field] = next;
      changed = true;
    }
  }
  if (changed) await ctx.db.patch(stats._id, patch);
}

/** `bumpStats` for callers that have not read the row yet (1 read + at most 1 patch). */
export async function bumpOrgStats(
  ctx: { db: DatabaseWriter },
  orgId: Id<"organizations">,
  deltas: Partial<Record<CounterField, number>>,
): Promise<void> {
  await bumpStats(ctx, await loadOrgStats(ctx, orgId), deltas);
}

/**
 * `bumpOrgStats` for the Phase 2 device paths (`devices:unenroll`, dev
 * helpers) whose wire answers must not change: an organization without a
 * counter row (not migrated) is skipped instead of failing.
 */
export async function bumpOrgStatsIfPresent(
  ctx: { db: DatabaseWriter },
  orgId: Id<"organizations">,
  deltas: Partial<Record<CounterField, number>>,
): Promise<void> {
  const stats = await ctx.db
    .query("orgStats")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .unique();
  if (stats !== null) await bumpStats(ctx, stats, deltas);
}

// ---------------------------------------------------------------- validation (operator input)

/** Null when acceptable, else the offending field name. */
export function limitsProblem(limits: PlanLimits): string | null {
  for (const [field, value] of Object.entries(limits) as [keyof PlanLimits, number | boolean][]) {
    if (field === "watchMode") continue;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return field;
  }
  if (limits.auditRetentionDays < 1 || limits.auditRetentionDays > 3650) return "auditRetentionDays";
  return null;
}

export function pingIntervalProblem(ms: number): boolean {
  return !Number.isSafeInteger(ms) || ms < MIN_PING_INTERVAL_MS || ms > MAX_PING_INTERVAL_MS;
}

/** Fields of a new organization's `orgPlans` row: a COPY of the current defaults (post-Phase-5 3.1). */
export function newOrgPlanFields(
  settings: Doc<"platformSettings"> | null,
  plan: PlanName,
  now: number,
  updatedBy: string,
): Omit<Doc<"orgPlans">, "_id" | "_creationTime" | "orgId"> {
  return {
    plan,
    status: "active",
    limits: { ...planDefaultsOf(settings)[plan] },
    degradeLevel: 0,
    revision: 0,
    updatedBy,
    updatedAt: now,
  };
}

/** Insert the global settings row when it does not exist yet (owner Q2: 30 minutes). */
export async function ensurePlatformSettings(ctx: { db: DatabaseWriter }): Promise<Doc<"platformSettings">> {
  const existing = await loadPlatformSettings(ctx);
  if (existing !== null) return existing;
  const id = await ctx.db.insert("platformSettings", {
    key: "global",
    pingIntervalMs: DEFAULT_PING_INTERVAL_MS,
    planDefaults: DEFAULT_PLAN_LIMITS,
    revision: 0,
  });
  return (await ctx.db.get(id))!;
}
