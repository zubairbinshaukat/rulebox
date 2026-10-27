import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { fail } from "./errors";
import { MAX_MEMBERS, MAX_RECOUNT_ROWS } from "./limits";
import { defaultPlanForNewOrg, ensurePlatformSettings, newOrgPlanFields, type CounterField } from "./plans";

// The one-per-organization rows (`orgPlans`, `orgStats`, `orgSecrets`) and the
// exact recount of the counters a plan limits. Used when an organization is
// created or adopted (`setup:createOwnerInvite`) and by the Step 5 migration
// (`maintenance:migratePlans`). Writes only what differs.

type Db = Pick<MutationCtx, "db">;

/** Exact counts from the rows themselves (index reads; tiny tables, plus devices once). */
async function recount(ctx: Db, orgId: Id<"organizations">): Promise<Partial<Record<CounterField, number>>> {
  const groups = await ctx.db
    .query("groups")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .take(MAX_RECOUNT_ROWS);
  const members = await ctx.db
    .query("members")
    .withIndex("by_org_user", (q) => q.eq("orgId", orgId))
    .take(MAX_MEMBERS + 1);
  const devices = await ctx.db
    .query("devices")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .take(MAX_RECOUNT_ROWS);
  if (groups.length >= MAX_RECOUNT_ROWS || members.length > MAX_MEMBERS || devices.length >= MAX_RECOUNT_ROWS) {
    // Never write a wrong (capped) count into a limit counter.
    fail("conflict", { detail: "too many rows to recount in one transaction" });
  }
  return {
    groupCount: groups.length,
    memberCount: members.filter((m) => m.status === "active").length,
    deviceCount: devices.filter((d) => !d.revoked).length,
  };
}

/**
 * Make sure `orgId` has its plan, counter and secret rows, with exact
 * counters, and drop the Phase 2/3 fields the plan tables replace
 * (`organizations.maxDevices`, `orgStats.pingIntervalMs`). A missing plan row
 * is created from the current defaults (`custom` self-host, `free` hosted); a
 * legacy `organizations.maxDevices` is copied into its `limits.maxDevices`.
 * Returns true when anything was written.
 */
export async function ensureOrgRows(
  ctx: Db,
  org: Doc<"organizations">,
  opts: { updatedBy: string; now: number },
): Promise<boolean> {
  const orgId = org._id;
  let changed = false;

  const settings = await ensurePlatformSettings(ctx);

  const plan = await ctx.db
    .query("orgPlans")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .unique();
  if (plan === null) {
    const fields = newOrgPlanFields(settings, defaultPlanForNewOrg(), opts.now, opts.updatedBy);
    if (org.maxDevices !== undefined) fields.limits.maxDevices = org.maxDevices;
    await ctx.db.insert("orgPlans", { orgId, ...fields });
    changed = true;
  }
  if (org.maxDevices !== undefined) {
    await ctx.db.patch(orgId, { maxDevices: undefined });
    changed = true;
  }

  const secrets = await ctx.db
    .query("orgSecrets")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .unique();
  if (secrets === null) {
    await ctx.db.insert("orgSecrets", { orgId });
    changed = true;
  }

  const counts = await recount(ctx, orgId);
  const stats = await ctx.db
    .query("orgStats")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .unique();
  if (stats === null) {
    await ctx.db.insert("orgStats", { orgId, deviceCount: 0, ...counts });
    changed = true;
  } else {
    const patch: Partial<Doc<"orgStats">> = {};
    for (const [field, value] of Object.entries(counts) as [CounterField, number][]) {
      if (stats[field] !== value) patch[field] = value;
    }
    if (stats.pingIntervalMs !== undefined) patch.pingIntervalMs = undefined;
    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(stats._id, patch);
      changed = true;
    }
  }
  return changed;
}
