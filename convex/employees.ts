import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, type DatabaseReader } from "./_generated/server";
import { hashSecret } from "./lib/argon";
import { writeAudit } from "./lib/audit";
import { checkRevision, getInOrg, nextRevision } from "./lib/authz";
import {
  assertEmployeePassword,
  checkedQuota,
  checkedUsername,
  normalizeEmployeeName,
  searchQuery,
  searchTextOf,
} from "./lib/employeeRules";
import { appendRoster, assertGroupRoom, changeMemberships, membershipsOf, planRoster, publishForGrants, type RosterPlan } from "./lib/employeeSync";
import { fail } from "./lib/errors";
import { memberAction, memberMutation, memberQuery } from "./lib/functions";
import {
  EMPLOYEE_ROW_GROUPS,
  MAX_APP_OPTIONS,
  MAX_EMPLOYEE_APPS,
  MAX_EMPLOYEE_GROUPS,
  MAX_EMPLOYEE_PAGE,
  MAX_EMPLOYEE_SEARCH,
  MAX_GROUPS_JOINED,
  MAX_SEARCH_TEXT,
} from "./lib/limits";
import { assertWithinLimit, bumpOrgStats, bumpStats } from "./lib/plans";
import { consumeOrFail } from "./lib/rateLimits";
import { requestPublish } from "./lib/publish";
import { appKind, DEFAULT_ORG_SETTINGS } from "./lib/validators";

// Employees (plan Step 11; 4.12). The people who sign in on the PCs. Passwords
// are hashed in an ACTION (Argon2id needs a random salt) and only the hash
// reaches `employeeSecrets`, whose one writer is this file and whose one reader
// is `deviceApi:verifyEmployee` (Step 12): no query here reads that table, no
// audit entry or error carries a password, and `passwordSet` is answered from
// `employees.passwordSetAt`.
//
// Who may sign in on a group's PCs is the group's signed ROSTER (A6, 4.4): any
// change to it appends one signed entry per affected group (`lib/employeeSync`)
// and re-signs no document. Direct app grants, and membership or enabling of an
// employee who has grants, change the catalogue and republish the groups.

const actorArg = v.object({ type: v.literal("member"), id: v.string(), label: v.string() });

// ---------------------------------------------------------------- reads

const groupOption = v.object({ _id: v.id("groups"), name: v.string() });
const appOption = v.object({ _id: v.id("apps"), name: v.string(), kind: appKind, canOpenFiles: v.boolean() });

const employeeRow = v.object({
  _id: v.id("employees"),
  name: v.string(),
  username: v.string(),
  quotaGb: v.optional(v.number()),
  disabled: v.boolean(),
  /** Up to EMPLOYEE_ROW_GROUPS groups, by name. */
  groups: v.array(groupOption),
  moreGroups: v.boolean(),
});

/** The list rows of `employees`: their groups (named from the organization's tiny groups table) joined in. */
async function rowsOf(ctx: { db: DatabaseReader }, orgId: Id<"organizations">, employees: Doc<"employees">[]) {
  if (employees.length === 0) return [];
  const groups = await ctx.db
    .query("groups")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .take(MAX_GROUPS_JOINED);
  const names = new Map<string, string>(groups.map((g) => [g._id, g.name]));
  const rows = [];
  for (const e of employees) {
    const memberships = await ctx.db
      .query("groupMembers")
      .withIndex("by_employee", (q) => q.eq("employeeId", e._id))
      .take(EMPLOYEE_ROW_GROUPS + 1);
    const listed = [];
    for (const m of memberships.slice(0, EMPLOYEE_ROW_GROUPS)) {
      const name = names.get(m.groupId);
      if (name !== undefined) listed.push({ _id: m.groupId, name });
    }
    rows.push({
      _id: e._id,
      name: e.name,
      username: e.username,
      quotaGb: e.quotaGb,
      disabled: e.disabled,
      groups: listed.sort((a, b) => a.name.localeCompare(b.name)),
      moreGroups: memberships.length > EMPLOYEE_ROW_GROUPS,
    });
  }
  return rows;
}

/**
 * The organization's employees, newest first (viewer, paginated by
 * `employees.by_org`), or the members of one group (`groupMembers.by_group`).
 * Per row: its first groups. Never a password, a hash or the lockout.
 */
export const list = memberQuery("viewer")({
  args: { paginationOpts: paginationOptsValidator, groupId: v.optional(v.string()) },
  returns: paginationResultValidator(employeeRow),
  handler: async (ctx, args) => {
    const numItems = args.paginationOpts.numItems;
    if (!Number.isInteger(numItems) || numItems < 1 || numItems > MAX_EMPLOYEE_PAGE) fail("invalid_argument", { field: "paginationOpts" });
    if (args.groupId !== undefined) {
      const group = await getInOrg(ctx, "groups", args.groupId, ctx.orgId);
      const result = await ctx.db
        .query("groupMembers")
        .withIndex("by_group", (q) => q.eq("groupId", group._id))
        .order("desc")
        .paginate(args.paginationOpts);
      const employees: Doc<"employees">[] = [];
      for (const m of result.page) {
        const e = await ctx.db.get(m.employeeId);
        if (e !== null) employees.push(e);
      }
      return { ...result, page: await rowsOf(ctx, ctx.orgId, employees) };
    }
    const result = await ctx.db
      .query("employees")
      .withIndex("by_org", (q) => q.eq("orgId", ctx.orgId))
      .order("desc")
      .paginate(args.paginationOpts);
    return { ...result, page: await rowsOf(ctx, ctx.orgId, result.page) };
  },
});

/**
 * Employees whose name or username starts with the words of `text` (viewer,
 * `search_text`, at most MAX_EMPLOYEE_SEARCH rows; `capped` = there were more).
 * `groupId` keeps only members of that group (checked after the search).
 */
export const search = memberQuery("viewer")({
  args: { text: v.string(), groupId: v.optional(v.string()) },
  returns: v.object({ rows: v.array(employeeRow), capped: v.boolean() }),
  handler: async (ctx, args) => {
    const group = args.groupId === undefined ? null : await getInOrg(ctx, "groups", args.groupId, ctx.orgId);
    const text = searchQuery(args.text, MAX_SEARCH_TEXT);
    if (text === "") return { rows: [], capped: false };
    const hits = await ctx.db
      .query("employees")
      .withSearchIndex("search_text", (q) => q.search("searchText", text).eq("orgId", ctx.orgId))
      .take(MAX_EMPLOYEE_SEARCH + 1);
    const capped = hits.length > MAX_EMPLOYEE_SEARCH;
    const kept: Doc<"employees">[] = [];
    for (const e of hits.slice(0, MAX_EMPLOYEE_SEARCH)) {
      if (group !== null) {
        const member = await ctx.db
          .query("groupMembers")
          .withIndex("by_group_employee", (q) => q.eq("groupId", group._id).eq("employeeId", e._id))
          .first();
        if (member === null) continue;
      }
      kept.push(e);
    }
    return { rows: await rowsOf(ctx, ctx.orgId, kept), capped };
  },
});

/** The pickers of the employee form: groups and apps (non-archived), by name, and the default quota. */
async function pickers(ctx: { db: DatabaseReader }, orgId: Id<"organizations">) {
  const groups = await ctx.db
    .query("groups")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .take(MAX_GROUPS_JOINED);
  const apps = await ctx.db
    .query("apps")
    .withIndex("by_org_archived", (q) => q.eq("orgId", orgId).eq("archived", false))
    .take(MAX_APP_OPTIONS);
  const org = await ctx.db.get(orgId);
  return {
    groupOptions: groups.map((g) => ({ _id: g._id, name: g.name })).sort((a, b) => a.name.localeCompare(b.name)),
    appOptions: apps
      .map((a) => ({ _id: a._id, name: a.name, kind: a.kind, canOpenFiles: a.kind === "desktop" && (a.desktop?.fileArgTemplate.length ?? 0) > 0 }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    defaultQuotaGb: (org?.settings ?? DEFAULT_ORG_SETTINGS).defaultQuotaGb,
  };
}

const pickersValidator = {
  groupOptions: v.array(groupOption),
  appOptions: v.array(appOption),
  defaultQuotaGb: v.number(),
};

/** The pickers for the "new employee" form (viewer). */
export const options = memberQuery("viewer")({
  args: {},
  returns: v.object(pickersValidator),
  handler: async (ctx) => await pickers(ctx, ctx.orgId),
});

/**
 * One employee for the form (viewer): the profile, `groupIds` (`.take(100)`),
 * direct `appIds` (`.take(50)`), the lockout row (the client compares
 * `lockedUntil` with its clock), `passwordSet` (from `passwordSetAt`: the hash
 * is never read) and the pickers.
 */
export const get = memberQuery("viewer")({
  args: { employeeId: v.string() },
  returns: v.object({
    _id: v.id("employees"),
    name: v.string(),
    username: v.string(),
    quotaGb: v.optional(v.number()),
    disabled: v.boolean(),
    revision: v.number(),
    passwordSet: v.boolean(),
    passwordSetAt: v.optional(v.number()),
    createdAt: v.number(),
    groupIds: v.array(v.id("groups")),
    appIds: v.array(v.id("apps")),
    lockout: v.union(v.null(), v.object({ failures: v.number(), lockedUntil: v.number() })),
    ...pickersValidator,
  }),
  handler: async (ctx, args) => {
    const e = await getInOrg(ctx, "employees", args.employeeId, ctx.orgId);
    const memberships = await membershipsOf(ctx, e._id);
    const grants = await ctx.db
      .query("employeeApps")
      .withIndex("by_employee", (q) => q.eq("employeeId", e._id))
      .take(MAX_EMPLOYEE_APPS);
    const lock = await ctx.db
      .query("employeeLockouts")
      .withIndex("by_employee", (q) => q.eq("employeeId", e._id))
      .unique();
    return {
      _id: e._id,
      name: e.name,
      username: e.username,
      quotaGb: e.quotaGb,
      disabled: e.disabled,
      revision: e.revision,
      passwordSet: e.passwordSetAt !== undefined,
      passwordSetAt: e.passwordSetAt,
      createdAt: e.createdAt,
      groupIds: memberships.slice(0, MAX_EMPLOYEE_GROUPS).map((m) => m.groupId),
      appIds: grants.map((g) => g.appId),
      lockout: lock !== null && lock.lockedUntil > 0 ? { failures: lock.failures, lockedUntil: lock.lockedUntil } : null,
      ...(await pickers(ctx, ctx.orgId)),
    };
  },
});

// ---------------------------------------------------------------- create

/** `ids` as unique rows of `table` in the organization (`not_found` for a foreign or unknown id), at most `max` (else `too_large`). */
async function resolveIds<T extends "groups" | "apps">(
  ctx: { db: DatabaseReader },
  table: T,
  ids: string[],
  orgId: Id<"organizations">,
  max: number,
  tooLarge: string,
): Promise<Doc<T>[]> {
  const unique = [...new Set(ids)];
  if (unique.length > max) fail("too_large", { detail: tooLarge });
  const out: Doc<T>[] = [];
  for (const id of unique) out.push(await getInOrg(ctx, table, id, orgId));
  return out;
}

/**
 * Add an employee (admin; unlocked session). An action only because a password
 * is hashed with a random salt: `password` is optional (the employee cannot
 * sign in until one is set). `quotaGb` undefined = the organization's default.
 * `groupIds` and `appIds` (direct app grants) are the starting memberships.
 * Refused: `conflict` (field "username"), `invalid_argument` (name, username,
 * quotaGb, password), `plan_limit` (detail "employees"), `not_ready` (detail
 * "signing key": a group's roster cannot be signed), `rate_limited`.
 */
export const create = memberAction("admin")({
  args: {
    name: v.string(),
    username: v.string(),
    quotaGb: v.optional(v.number()),
    groupIds: v.array(v.string()),
    appIds: v.optional(v.array(v.string())),
    password: v.optional(v.string()),
  },
  returns: v.id("employees"),
  handler: async (ctx, args): Promise<Id<"employees">> => {
    // A bad password never costs a hash; the mutation checks everything again.
    const username = checkedUsername(args.username);
    let phc: string | undefined;
    if (args.password !== undefined && args.password !== "") {
      assertEmployeePassword(args.password, username);
      await consumeOrFail(ctx, "employeeWrites", ctx.orgId);
      phc = await hashSecret(ctx, args.password);
    }
    return await ctx.runMutation(internal.employees.storeNew, {
      orgId: ctx.orgId,
      actor: ctx.actor,
      name: args.name,
      username: args.username,
      quotaGb: args.quotaGb,
      groupIds: args.groupIds,
      appIds: args.appIds ?? [],
      phc,
    });
  },
});

/** The writer of a new employee row (and of its first `employeeSecrets` row). */
export const storeNew = internalMutation({
  args: {
    orgId: v.id("organizations"),
    actor: actorArg,
    name: v.string(),
    username: v.string(),
    quotaGb: v.optional(v.number()),
    groupIds: v.array(v.string()),
    appIds: v.array(v.string()),
    phc: v.optional(v.string()),
  },
  returns: v.id("employees"),
  handler: async (ctx, args) => {
    const { orgId } = args;
    const name = normalizeEmployeeName(args.name);
    const username = checkedUsername(args.username);
    const quotaGb = checkedQuota(args.quotaGb);
    if (args.phc !== undefined && !args.phc.startsWith("$argon2id$")) fail("invalid_argument", { field: "password" });
    const taken = await ctx.db
      .query("employees")
      .withIndex("by_org_username", (q) => q.eq("orgId", orgId).eq("username", username))
      .first();
    if (taken !== null) fail("conflict", { field: "username" });
    const groups = await resolveIds(ctx, "groups", args.groupIds, orgId, MAX_EMPLOYEE_GROUPS, "employee groups");
    const apps = await resolveIds(ctx, "apps", args.appIds, orgId, MAX_EMPLOYEE_APPS, "employee apps");
    if (apps.some((a) => a.archived)) fail("invalid_argument", { field: "appIds" });
    // The limit and the counters in the same transaction as the insert.
    const stats = await assertWithinLimit(ctx, orgId, "employees");
    await assertGroupRoom(ctx, orgId, groups.map((g) => g._id));

    const now = Date.now();
    const credentialRevision = args.phc === undefined ? 0 : 1;
    const employeeId = await ctx.db.insert("employees", {
      orgId,
      name,
      username,
      searchText: searchTextOf(name, username),
      quotaGb,
      disabled: false,
      credentialRevision,
      passwordSetAt: args.phc === undefined ? undefined : now,
      revision: 0,
      createdAt: now,
    });
    if (args.phc !== undefined) await ctx.db.insert("employeeSecrets", { employeeId, passwordHash: args.phc });
    const plan: RosterPlan = new Map();
    for (const g of groups) {
      await ctx.db.insert("groupMembers", { orgId, groupId: g._id, employeeId });
      planRoster(plan, g._id, { employeeId, credentialRevision });
    }
    for (const a of apps) await ctx.db.insert("employeeApps", { orgId, employeeId, appId: a._id });
    await appendRoster(ctx, orgId, plan);
    await bumpStats(ctx, stats, { employeeCount: 1, activeEmployeeCount: 1 });
    await writeAudit(ctx, {
      orgId,
      actor: args.actor,
      action: "employee.created",
      targetType: "employee",
      targetId: employeeId,
      targetLabel: name,
      summary: `Added the employee ${name}`,
    });
    // Direct grants show in the catalogue of the employee's groups.
    if (apps.length > 0 && groups.length > 0) await requestPublish(ctx, orgId, { groupIds: groups.map((g) => g._id) });
    return employeeId;
  },
});

// ---------------------------------------------------------------- update

/**
 * Change the profile (admin; unlocked session): name, username, quota
 * (`quotaGb` undefined = the organization's default). `stale_edit` when the
 * employee changed; `conflict` (field "username") when another employee has it.
 * Nothing changed = no write. A new username bumps `credentialRevision` and
 * appends a roster entry per group (the devices drop the old offline sign-in).
 * Does not touch groups or grants (`setGroups`, `setDirectApps`).
 */
export const update = memberMutation("admin")({
  args: {
    employeeId: v.string(),
    expectedRevision: v.number(),
    name: v.string(),
    username: v.string(),
    quotaGb: v.optional(v.number()),
  },
  returns: v.object({ revision: v.number() }),
  handler: async (ctx, args) => {
    const e = await getInOrg(ctx, "employees", args.employeeId, ctx.orgId);
    checkRevision(e, args.expectedRevision);
    const name = normalizeEmployeeName(args.name);
    const username = checkedUsername(args.username);
    const quotaGb = checkedQuota(args.quotaGb);
    const changed: string[] = [];
    if (name !== e.name) changed.push("name");
    if (username !== e.username) changed.push("username");
    if (quotaGb !== e.quotaGb) changed.push("quota");
    if (changed.length === 0) return { revision: e.revision };

    const renamed = username !== e.username;
    if (renamed) {
      const taken = await ctx.db
        .query("employees")
        .withIndex("by_org_username", (q) => q.eq("orgId", ctx.orgId).eq("username", username))
        .first();
      if (taken !== null && taken._id !== e._id) fail("conflict", { field: "username" });
    }
    const revision = nextRevision(e);
    const credentialRevision = renamed ? e.credentialRevision + 1 : e.credentialRevision;
    await ctx.db.patch(e._id, { name, username, searchText: searchTextOf(name, username), quotaGb, credentialRevision, revision });
    if (renamed && !e.disabled) {
      const plan: RosterPlan = new Map();
      for (const m of await membershipsOf(ctx, e._id)) planRoster(plan, m.groupId, { employeeId: e._id, credentialRevision });
      await appendRoster(ctx, ctx.orgId, plan);
    }
    await writeAudit(ctx, {
      orgId: ctx.orgId,
      actor: ctx.actor,
      action: "employee.updated",
      targetType: "employee",
      targetId: e._id,
      targetLabel: name,
      summary: `Changed the ${changed.join(", ")} of ${name}`,
    });
    return { revision };
  },
});

/**
 * Set the groups an employee is in (admin; unlocked session): the diff against
 * the current groups is inserted / deleted. `stale_edit`; `too_large` (detail
 * "employee groups" / "group employees"); `not_found` for a foreign group. Nothing
 * changed = no write. Each group an ENABLED employee joins or leaves gets one
 * signed roster entry; the groups' documents are republished only when the
 * employee has direct app grants.
 */
export const setGroups = memberMutation("admin")({
  args: { employeeId: v.string(), expectedRevision: v.number(), groupIds: v.array(v.string()) },
  returns: v.object({ revision: v.number() }),
  handler: async (ctx, args) => {
    const e = await getInOrg(ctx, "employees", args.employeeId, ctx.orgId);
    checkRevision(e, args.expectedRevision);
    const wanted = await resolveIds(ctx, "groups", args.groupIds, ctx.orgId, MAX_EMPLOYEE_GROUPS, "employee groups");
    const current = await membershipsOf(ctx, e._id);
    const wantedIds = new Set<string>(wanted.map((g) => g._id));
    const haveIds = new Set<string>(current.map((m) => m.groupId));
    const add = wanted.filter((g) => !haveIds.has(g._id));
    const remove = current.filter((m) => !wantedIds.has(m.groupId));
    if (add.length === 0 && remove.length === 0) return { revision: e.revision };
    const removeNames: string[] = [];
    for (const m of remove) removeNames.push((await ctx.db.get(m.groupId))?.name ?? "a group");
    const revision = await changeMemberships(ctx, { orgId: ctx.orgId, actor: ctx.actor, employee: e, add, remove, removeNames });
    return { revision };
  },
});

/**
 * Set the apps given to this employee directly (admin; unlocked session; at
 * most MAX_EMPLOYEE_APPS). `stale_edit`; a NEW grant must be a non-archived app
 * (`invalid_argument`, field "appIds"); existing grants of archived apps may
 * stay. Nothing changed = no write. A change republishes the employee's groups
 * (their catalogue lists who has an app) unless the employee is disabled.
 */
export const setDirectApps = memberMutation("admin")({
  args: { employeeId: v.string(), expectedRevision: v.number(), appIds: v.array(v.string()) },
  returns: v.object({ revision: v.number() }),
  handler: async (ctx, args) => {
    const e = await getInOrg(ctx, "employees", args.employeeId, ctx.orgId);
    checkRevision(e, args.expectedRevision);
    const wanted = await resolveIds(ctx, "apps", args.appIds, ctx.orgId, MAX_EMPLOYEE_APPS, "employee apps");
    const current = await ctx.db
      .query("employeeApps")
      .withIndex("by_employee", (q) => q.eq("employeeId", e._id))
      .take(MAX_EMPLOYEE_APPS + 1);
    const haveIds = new Set<string>(current.map((g) => g.appId));
    const wantedIds = new Set<string>(wanted.map((a) => a._id));
    const add = wanted.filter((a) => !haveIds.has(a._id));
    const remove = current.filter((g) => !wantedIds.has(g.appId));
    if (add.length === 0 && remove.length === 0) return { revision: e.revision };
    if (add.some((a) => a.archived)) fail("invalid_argument", { field: "appIds" });
    for (const a of add) await ctx.db.insert("employeeApps", { orgId: ctx.orgId, employeeId: e._id, appId: a._id });
    for (const g of remove) await ctx.db.delete(g._id);
    const revision = nextRevision(e);
    await ctx.db.patch(e._id, { revision });
    await writeAudit(ctx, {
      orgId: ctx.orgId,
      actor: ctx.actor,
      action: "employee.appsChanged",
      targetType: "employee",
      targetId: e._id,
      targetLabel: e.name,
      summary: `Changed the apps of ${e.name} (${add.length} added, ${remove.length} removed)`,
    });
    if (!e.disabled) {
      const groupIds = (await membershipsOf(ctx, e._id)).map((m) => m.groupId);
      if (groupIds.length > 0) await requestPublish(ctx, ctx.orgId, { groupIds });
    }
    return { revision };
  },
});

// ---------------------------------------------------------------- password

/** The employee's username for `setPassword` (the rule "not the username"), or null for a foreign or unknown id. */
export const passwordTarget = internalQuery({
  args: { orgId: v.id("organizations"), employeeId: v.string() },
  returns: v.union(v.null(), v.object({ username: v.string() })),
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("employees", args.employeeId);
    const e = id === null ? null : await ctx.db.get(id);
    return e === null || e.orgId !== args.orgId ? null : { username: e.username };
  },
});

/**
 * Set the employee's password (admin; unlocked session; an action: Argon2id
 * with a random salt). 8-256 characters, not the username (`invalid_argument`,
 * field "password", detail "length" / "username"); 300 per hour per
 * organization (`rate_limited`). Bumps `credentialRevision` (devices drop the
 * old offline sign-in) and appends a roster entry per group when the employee
 * is enabled. The password is never stored, logged or audited, and nothing
 * returns it.
 */
export const setPassword = memberAction("admin")({
  args: { employeeId: v.string(), password: v.string() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const target: { username: string } | null = await ctx.runQuery(internal.employees.passwordTarget, {
      orgId: ctx.orgId,
      employeeId: args.employeeId,
    });
    if (target === null) fail("not_found");
    assertEmployeePassword(args.password, target.username);
    await consumeOrFail(ctx, "employeeWrites", ctx.orgId);
    const phc = await hashSecret(ctx, args.password);
    await ctx.runMutation(internal.employees.storePassword, {
      orgId: ctx.orgId,
      actor: ctx.actor,
      employeeId: args.employeeId,
      username: target.username,
      phc,
    });
    return null;
  },
});

/** The single writer of `employeeSecrets` after creation. `username` is the one the password was checked against. */
export const storePassword = internalMutation({
  args: { orgId: v.id("organizations"), actor: actorArg, employeeId: v.string(), username: v.string(), phc: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (!args.phc.startsWith("$argon2id$")) fail("invalid_argument", { field: "password" });
    const e = await getInOrg(ctx, "employees", args.employeeId, args.orgId);
    // Renamed while the password was being hashed: it was not checked against the new name.
    if (e.username !== args.username) fail("stale_edit");
    const secret = await ctx.db
      .query("employeeSecrets")
      .withIndex("by_employee", (q) => q.eq("employeeId", e._id))
      .unique();
    if (secret === null) await ctx.db.insert("employeeSecrets", { employeeId: e._id, passwordHash: args.phc });
    else await ctx.db.patch(secret._id, { passwordHash: args.phc });
    const credentialRevision = e.credentialRevision + 1;
    await ctx.db.patch(e._id, { credentialRevision, passwordSetAt: Date.now() });
    if (!e.disabled) {
      const plan: RosterPlan = new Map();
      for (const m of await membershipsOf(ctx, e._id)) planRoster(plan, m.groupId, { employeeId: e._id, credentialRevision });
      await appendRoster(ctx, args.orgId, plan);
    }
    await writeAudit(ctx, {
      orgId: args.orgId,
      actor: args.actor,
      action: "employee.passwordSet",
      targetType: "employee",
      targetId: e._id,
      targetLabel: e.name,
      summary: `Set a new password for ${e.name}`,
    });
    return null;
  },
});

// ---------------------------------------------------------------- disable, unlock, remove

/**
 * Disable or enable an employee (admin; unlocked session). Disabling takes
 * them out of the roster of each of their groups (devices drop their offline
 * sign-in; `deviceApi:verifyEmployee` refuses them at once); enabling puts
 * them back. Keeps `activeEmployeeCount`. Same state again = no write. The
 * `revision` is not bumped: it guards the profile form, which this does not touch.
 */
export const setDisabled = memberMutation("admin")({
  args: { employeeId: v.string(), disabled: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const e = await getInOrg(ctx, "employees", args.employeeId, ctx.orgId);
    if (e.disabled === args.disabled) return null;
    const memberships = await membershipsOf(ctx, e._id);
    const plan: RosterPlan = new Map();
    for (const m of memberships) {
      planRoster(plan, m.groupId, { employeeId: e._id, credentialRevision: args.disabled ? null : e.credentialRevision });
    }
    await appendRoster(ctx, ctx.orgId, plan);
    await ctx.db.patch(e._id, { disabled: args.disabled });
    await bumpOrgStats(ctx, ctx.orgId, { activeEmployeeCount: args.disabled ? -1 : 1 });
    await writeAudit(ctx, {
      orgId: ctx.orgId,
      actor: ctx.actor,
      action: args.disabled ? "employee.disabled" : "employee.enabled",
      targetType: "employee",
      targetId: e._id,
      targetLabel: e.name,
      summary: args.disabled ? `Disabled the employee ${e.name}` : `Enabled the employee ${e.name}`,
    });
    // The catalogue lists only enabled employees under an app (`employeeIds`).
    await publishForGrants(ctx, ctx.orgId, { _id: e._id, disabled: false }, memberships.map((m) => m.groupId));
    return null;
  },
});

/** Clear the server-side lockout after too many wrong passwords (admin; unlocked session). No lockout row = no write. */
export const unlock = memberMutation("admin")({
  args: { employeeId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const e = await getInOrg(ctx, "employees", args.employeeId, ctx.orgId);
    const lock = await ctx.db
      .query("employeeLockouts")
      .withIndex("by_employee", (q) => q.eq("employeeId", e._id))
      .unique();
    if (lock === null) return null;
    await ctx.db.delete(lock._id);
    await writeAudit(ctx, {
      orgId: ctx.orgId,
      actor: ctx.actor,
      action: "employee.updated",
      targetType: "employee",
      targetId: e._id,
      targetLabel: e.name,
      summary: `Unlocked the employee ${e.name}`,
    });
    return null;
  },
});

/**
 * Delete a DISABLED employee (admin, major: fresh step-up): the password,
 * lockout, memberships and direct grants go with it; the audit log keeps the
 * name. `invalid_argument` (field "disabled") while the employee is active.
 * A disabled employee was already taken out of every roster, and their grants
 * are not in any document, so nothing is signed or republished here. Files on
 * the PCs stay (PRD 8).
 */
export const remove = memberMutation("admin", { major: "employees:remove" })({
  args: { employeeId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const e = await getInOrg(ctx, "employees", args.employeeId, ctx.orgId);
    if (!e.disabled) fail("invalid_argument", { field: "disabled" });
    const secret = await ctx.db
      .query("employeeSecrets")
      .withIndex("by_employee", (q) => q.eq("employeeId", e._id))
      .unique();
    if (secret !== null) await ctx.db.delete(secret._id);
    const lock = await ctx.db
      .query("employeeLockouts")
      .withIndex("by_employee", (q) => q.eq("employeeId", e._id))
      .unique();
    if (lock !== null) await ctx.db.delete(lock._id);
    for (const m of await membershipsOf(ctx, e._id)) await ctx.db.delete(m._id);
    const grants = await ctx.db
      .query("employeeApps")
      .withIndex("by_employee", (q) => q.eq("employeeId", e._id))
      .take(MAX_EMPLOYEE_APPS + 1);
    for (const g of grants) await ctx.db.delete(g._id);
    await ctx.db.delete(e._id);
    // Disabled employees are not counted as active: only the total changes.
    await bumpOrgStats(ctx, ctx.orgId, { employeeCount: -1 });
    await writeAudit(ctx, {
      orgId: ctx.orgId,
      actor: ctx.actor,
      action: "employee.deleted",
      targetType: "employee",
      targetId: e._id,
      targetLabel: e.name,
      summary: `Deleted the employee ${e.name}`,
    });
    return null;
  },
});
