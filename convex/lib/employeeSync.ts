import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseReader, MutationCtx } from "../_generated/server";
import { writeAudit, type AuditActor } from "./audit";
import { nextRevision } from "./authz";
import { fail } from "./errors";
import { MAX_EMPLOYEE_GROUPS, MAX_GROUP_EMPLOYEES, ROSTER_RESYNC_BATCH } from "./limits";
import { counterOf, loadOrgStats } from "./plans";
import { requestPublish } from "./publish";
import { appendRosterEntries, type RosterChange } from "./roster";
import { loadOrgSigningKey } from "./signing";

// What every employee change shares (plan Step 11): the signed roster, group
// membership and the publish rule. Used by `employees.ts` and `groups.ts`.
//
// The roster of a group (A6) is the set of its members that are not disabled,
// each with their `credentialRevision`. A change to who is in it, or to a
// member's revision, appends ONE signed entry per affected group, in the same
// mutation, and bumps `groupRoster.epoch`: no document is re-signed. A change
// to a direct app grant, or to who is in a group while the employee has
// grants, alters the catalogue of that group's devices and so still
// republishes the group's documents.

type Ctx = Pick<MutationCtx, "db" | "scheduler">;

/** Roster changes collected per group; `appendRoster` signs and writes them all. */
export type RosterPlan = Map<Id<"groups">, RosterChange[]>;

export function planRoster(plan: RosterPlan, groupId: Id<"groups">, change: RosterChange): void {
  const list = plan.get(groupId);
  if (list === undefined) plan.set(groupId, [change]);
  else list.push(change);
}

/**
 * Sign and append the collected entries (one `appendRosterEntries` per group).
 * Needs the organization's active signing key; without one nothing can be
 * signed, and the whole mutation is refused with `not_ready` (detail "signing
 * key"), the same answer `enrollment:enroll` gives. No groups affected = no
 * key needed.
 */
export async function appendRoster(ctx: Pick<MutationCtx, "db">, orgId: Id<"organizations">, plan: RosterPlan): Promise<void> {
  if (plan.size === 0) return;
  const signing = await loadOrgSigningKey(ctx, orgId, "active");
  if (!signing.ok) fail("not_ready", { detail: "signing key" });
  const now = Date.now();
  for (const [groupId, changes] of plan) {
    if (changes.length > 0) await appendRosterEntries(ctx, signing.key, orgId, groupId, changes, now);
  }
}

/**
 * `appendRoster` for REVOCATION (an employee leaving rosters because they were
 * disabled): never refused. With a valid key the entries are signed and written
 * as usual ("signed"). Without one, a `rosterPending` row per (group, employee)
 * is written instead ("pending"; no duplicates) and `resyncPendingRoster`
 * appends the removals once a key is available. The employee is disabled either
 * way, so the server (`verifyEmployee`) refuses them online at once; only the
 * offline sign-in on devices waits for the signature.
 */
export async function appendRosterOrQueue(
  ctx: Pick<MutationCtx, "db">,
  orgId: Id<"organizations">,
  plan: RosterPlan,
): Promise<"signed" | "pending"> {
  if (plan.size === 0) return "signed";
  const signing = await loadOrgSigningKey(ctx, orgId, "active");
  if (signing.ok) {
    await appendRoster(ctx, orgId, plan);
    return "signed";
  }
  for (const [groupId, changes] of plan) {
    for (const c of changes) {
      const have = await ctx.db
        .query("rosterPending")
        .withIndex("by_group_employee", (q) => q.eq("groupId", groupId).eq("employeeId", c.employeeId))
        .first();
      if (have === null) await ctx.db.insert("rosterPending", { orgId, groupId, employeeId: c.employeeId });
    }
  }
  return "pending";
}

/**
 * Sign the pending removals (at most ROSTER_RESYNC_BATCH rows per call, oldest
 * first). "idle" = nothing pending, "blocked" = pending but still no valid key,
 * "more" = this batch was full (call again), "done" = everything handled. Each
 * row is deleted in the same transaction as its entry, so a repeated call never
 * signs a removal twice. A row is skipped (deleted, nothing signed) when its
 * group is gone or the employee is enabled and in the group again (their add
 * entry is newer than the removal).
 */
export async function resyncPendingRoster(
  ctx: Pick<MutationCtx, "db">,
  orgId: Id<"organizations">,
): Promise<"idle" | "blocked" | "more" | "done"> {
  const rows = await ctx.db
    .query("rosterPending")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .take(ROSTER_RESYNC_BATCH);
  if (rows.length === 0) return "idle";
  const signing = await loadOrgSigningKey(ctx, orgId, "active");
  if (!signing.ok) return "blocked";
  const now = Date.now();
  const byGroup = new Map<Id<"groups">, { changes: RosterChange[]; rows: Doc<"rosterPending">[] }>();
  for (const row of rows) {
    const group = await ctx.db.get(row.groupId);
    let stale = group === null || group.orgId !== orgId;
    if (!stale) {
      const id = ctx.db.normalizeId("employees", row.employeeId);
      const employee = id === null ? null : await ctx.db.get(id);
      if (employee !== null && !employee.disabled) {
        const member = await ctx.db
          .query("groupMembers")
          .withIndex("by_group_employee", (q) => q.eq("groupId", row.groupId).eq("employeeId", employee._id))
          .first();
        stale = member !== null;
      }
    }
    if (stale) {
      await ctx.db.delete(row._id);
      continue;
    }
    const entry = byGroup.get(row.groupId) ?? { changes: [], rows: [] };
    entry.changes.push({ employeeId: row.employeeId, credentialRevision: null });
    entry.rows.push(row);
    byGroup.set(row.groupId, entry);
  }
  for (const [groupId, entry] of byGroup) {
    await appendRosterEntries(ctx, signing.key, orgId, groupId, entry.changes, now);
    for (const row of entry.rows) await ctx.db.delete(row._id);
  }
  return rows.length >= ROSTER_RESYNC_BATCH ? "more" : "done";
}

/** True when this organization has a removal waiting for a signing key (one read). */
export async function hasPendingRoster(ctx: { db: DatabaseReader }, orgId: Id<"organizations">): Promise<boolean> {
  const row = await ctx.db
    .query("rosterPending")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .first();
  return row !== null;
}

/**
 * Schedule `employees:resyncRoster` when removals are waiting for a key (1 read,
 * and nothing else when none are). Called where a key may just have become
 * usable: `keys:registerActive`, `keys:finishRotation`, `publish:run`.
 */
export async function scheduleRosterResync(ctx: Pick<MutationCtx, "db" | "scheduler">, orgId: Id<"organizations">): Promise<void> {
  if (await hasPendingRoster(ctx, orgId)) await ctx.scheduler.runAfter(0, internal.employees.resyncRoster, { orgId });
}

/**
 * Keep `groupMembers.grantsActive` true exactly while the employee is enabled
 * and has at least one direct grant (the publisher reads only those rows). Reads
 * the employee's memberships and one grant; patches only the rows that differ.
 * Call after anything that changes grants, `disabled`, or memberships.
 */
export async function syncGrantFlags(
  ctx: { db: MutationCtx["db"] },
  employee: Pick<Doc<"employees">, "_id" | "disabled">,
): Promise<void> {
  const active = !employee.disabled && (await hasDirectApps(ctx, employee._id));
  for (const m of await membershipsOf(ctx, employee._id)) {
    if ((m.grantsActive === true) !== active) await ctx.db.patch(m._id, { grantsActive: active });
  }
}

/** The employee's group memberships, at most MAX_EMPLOYEE_GROUPS + 1 (one more than allowed = "too many"). */
export async function membershipsOf(ctx: { db: DatabaseReader }, employeeId: Id<"employees">): Promise<Doc<"groupMembers">[]> {
  return await ctx.db
    .query("groupMembers")
    .withIndex("by_employee", (q) => q.eq("employeeId", employeeId))
    .take(MAX_EMPLOYEE_GROUPS + 1);
}

export async function hasDirectApps(ctx: { db: DatabaseReader }, employeeId: Id<"employees">): Promise<boolean> {
  const first = await ctx.db
    .query("employeeApps")
    .withIndex("by_employee", (q) => q.eq("employeeId", employeeId))
    .first();
  return first !== null;
}

/**
 * Republish the given groups when this employee's state shows in their
 * documents: only an ENABLED employee with direct app grants does (the
 * catalogue lists them in `employeeIds` of "selected" apps and adds web apps
 * granted to them). Costs one read when the employee has no grants.
 */
export async function publishForGrants(
  ctx: Ctx,
  orgId: Id<"organizations">,
  employee: Pick<Doc<"employees">, "_id" | "disabled">,
  groupIds: Id<"groups">[],
): Promise<void> {
  if (employee.disabled || groupIds.length === 0) return;
  if (!(await hasDirectApps(ctx, employee._id))) return;
  await requestPublish(ctx, orgId, { groupIds });
}

/**
 * Refuse with `too_large` (detail "group employees") when one of `groupIds`
 * already has MAX_GROUP_EMPLOYEES members (what a document may carry, 4.4 rule
 * 6). A group cannot be full while the organization has fewer employees than
 * that, so the common case reads only the counters.
 */
export async function assertGroupRoom(ctx: { db: DatabaseReader }, orgId: Id<"organizations">, groupIds: Id<"groups">[]): Promise<void> {
  if (groupIds.length === 0) return;
  const stats = await loadOrgStats(ctx, orgId);
  if (counterOf(stats, "employeeCount") < MAX_GROUP_EMPLOYEES) return;
  for (const groupId of groupIds) {
    const rows = await ctx.db
      .query("groupMembers")
      .withIndex("by_group", (q) => q.eq("groupId", groupId))
      .take(MAX_GROUP_EMPLOYEES);
    if (rows.length >= MAX_GROUP_EMPLOYEES) fail("too_large", { detail: "group employees" });
  }
}

/**
 * Add the employee to the groups `add` and take them out of the memberships
 * `remove`. Shared by `employees:setGroups`, `groups:addEmployee` and
 * `groups:removeEmployee`. Bumps the employee's `revision` (an open form is
 * then stale), appends the roster entries of an enabled employee (added =
 * "may sign in", removed = "removed"), audits `employee.groupsChanged` and
 * republishes when the employee has direct grants. Returns the new revision.
 * The caller has checked that `add` and `remove` are real changes.
 */
export async function changeMemberships(
  ctx: Ctx,
  args: {
    orgId: Id<"organizations">;
    actor: AuditActor;
    employee: Doc<"employees">;
    add: Doc<"groups">[];
    remove: Doc<"groupMembers">[];
    /** Names of the groups taken out (the membership rows only hold ids). */
    removeNames: string[];
  },
): Promise<number> {
  const { orgId, employee, add, remove } = args;
  await assertGroupRoom(ctx, orgId, add.map((g) => g._id));
  const plan: RosterPlan = new Map();
  const grantsActive = add.length > 0 && !employee.disabled && (await hasDirectApps(ctx, employee._id));
  for (const g of add) {
    await ctx.db.insert("groupMembers", { orgId, groupId: g._id, employeeId: employee._id, grantsActive });
    if (!employee.disabled) planRoster(plan, g._id, { employeeId: employee._id, credentialRevision: employee.credentialRevision });
  }
  for (const m of remove) {
    await ctx.db.delete(m._id);
    if (!employee.disabled) planRoster(plan, m.groupId, { employeeId: employee._id, credentialRevision: null });
  }
  await appendRoster(ctx, orgId, plan);
  const revision = nextRevision(employee);
  await ctx.db.patch(employee._id, { revision });
  const parts: string[] = [];
  if (add.length > 0) parts.push(`added to ${add.map((g) => g.name).join(", ")}`);
  if (args.removeNames.length > 0) parts.push(`removed from ${args.removeNames.join(", ")}`);
  await writeAudit(ctx, {
    orgId,
    actor: args.actor,
    action: "employee.groupsChanged",
    targetType: "employee",
    targetId: employee._id,
    targetLabel: employee.name,
    summary: `Changed the groups of ${employee.name} (${parts.join("; ")})`,
  });
  await publishForGrants(ctx, orgId, employee, [...add.map((g) => g._id), ...remove.map((m) => m.groupId)]);
  return revision;
}
