import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseReader, MutationCtx } from "../_generated/server";
import { writeAudit, type AuditActor } from "./audit";
import { nextRevision } from "./authz";
import { fail } from "./errors";
import { MAX_EMPLOYEE_GROUPS, MAX_GROUP_EMPLOYEES } from "./limits";
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
  for (const g of add) {
    await ctx.db.insert("groupMembers", { orgId, groupId: g._id, employeeId: employee._id });
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
