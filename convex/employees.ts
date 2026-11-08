import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { type DatabaseReader, type MutationCtx } from "./_generated/server";
import { ARGON2_PARAMS, hashSecret } from "./lib/argon";
import { writeAudit, type AuditActor } from "./lib/audit";
import { checkRevision, getInOrg, nextRevision } from "./lib/authz";
import {
  assertEmployeePassword,
  checkedQuota,
  checkedUsername,
  normalizeEmployeeName,
  searchQuery,
  searchTextOf,
} from "./lib/employeeRules";
import {
  appendRoster,
  appendRosterOrQueue,
  assertGroupRoom,
  hasDirectApps,
  membershipsOf,
  planRoster,
  publishForGrants,
  resyncPendingRoster,
  syncGrantFlags,
  type RosterPlan,
} from "./lib/employeeSync";
import { fail } from "./lib/errors";
import { internalMutation, internalQuery, memberAction, memberMutation, memberQuery } from "./lib/functions";
import { checkPageSize, cleanSearch, countResult, orgStatsRow, pickSort, sortArg } from "./lib/listing";
import {
  EMPLOYEE_ROW_GROUPS,
  MAX_APP_OPTIONS,
  MAX_EMPLOYEE_APPS,
  MAX_EMPLOYEE_GROUPS,
  MAX_EMPLOYEE_PAGE,
  MAX_EMPLOYEE_SEARCH,
  MAX_EMPLOYEE_SEARCH_SCAN,
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
 * The organization's employees (viewer; list contract in lib/listing.ts), or
 * the members of one group. Per row: its first groups. Never a password, a
 * hash or the lockout.
 * - No search: `sort` keys "created" (default, newest first; `by_org`), "name"
 *   (`by_org_name`) and "username" (`by_org_username`), both directions. With
 *   `groupId` only "created" is allowed, and it means "added to the group"
 *   (`groupMembers.by_group`; the membership rows carry no name), anything else
 *   is `invalid_argument` field "sort".
 * - `search` (name or username words, `search_text`): relevance order, `sort`
 *   ignored, paginated like any list. With `groupId` each hit of the page is
 *   checked with one `groupMembers.by_group_employee` read and non-members are
 *   dropped, so a page may be short (bounded: one check per hit, never more
 *   hits than `numItems`); `isDone` decides Next.
 */
export const list = memberQuery("viewer")({
  args: {
    paginationOpts: paginationOptsValidator,
    groupId: v.optional(v.string()),
    search: v.optional(v.string()),
    sort: sortArg,
  },
  returns: paginationResultValidator(employeeRow),
  handler: async (ctx, args) => {
    checkPageSize(args.paginationOpts.numItems, MAX_EMPLOYEE_PAGE);
    const sort = pickSort("employees", args.sort);
    const group = args.groupId === undefined ? null : await getInOrg(ctx, "groups", args.groupId, ctx.orgId);
    const raw = cleanSearch(args.search);
    if (raw !== undefined) {
      const text = searchQuery(raw, MAX_SEARCH_TEXT);
      const result = await ctx.db
        .query("employees")
        .withSearchIndex("search_text", (q) => q.search("searchText", text).eq("orgId", ctx.orgId))
        .paginate(args.paginationOpts);
      const kept: Doc<"employees">[] = [];
      for (const e of result.page) {
        if (group !== null) {
          const member = await ctx.db
            .query("groupMembers")
            .withIndex("by_group_employee", (q) => q.eq("groupId", group._id).eq("employeeId", e._id))
            .first();
          if (member === null) continue;
        }
        kept.push(e);
      }
      return { ...result, page: await rowsOf(ctx, ctx.orgId, kept) };
    }
    if (group !== null) {
      if (sort.key !== "created") fail("invalid_argument", { field: "sort" });
      const result = await ctx.db
        .query("groupMembers")
        .withIndex("by_group", (q) => q.eq("groupId", group._id))
        .order(sort.dir)
        .paginate(args.paginationOpts);
      const employees: Doc<"employees">[] = [];
      for (const m of result.page) {
        const e = await ctx.db.get(m.employeeId);
        if (e !== null) employees.push(e);
      }
      return { ...result, page: await rowsOf(ctx, ctx.orgId, employees) };
    }
    const employees = ctx.db.query("employees");
    const result =
      sort.key === "name"
        ? await employees
            .withIndex("by_org_name", (q) => q.eq("orgId", ctx.orgId))
            .order(sort.dir)
            .paginate(args.paginationOpts)
        : sort.key === "username"
          ? await employees
              .withIndex("by_org_username", (q) => q.eq("orgId", ctx.orgId))
              .order(sort.dir)
              .paginate(args.paginationOpts)
          : await employees
              .withIndex("by_org", (q) => q.eq("orgId", ctx.orgId))
              .order(sort.dir)
              .paginate(args.paginationOpts);
    return { ...result, page: await rowsOf(ctx, ctx.orgId, result.page) };
  },
});

/**
 * The total for the employees table (viewer; lib/listing.ts): `employeeCount`
 * from `orgStats` only, for the unfiltered list; `null` with a group filter or
 * a search (no exact counter).
 */
export const count = memberQuery("viewer")({
  args: { groupId: v.optional(v.string()), search: v.optional(v.string()) },
  returns: countResult,
  handler: async (ctx, args) => {
    if (args.groupId !== undefined || cleanSearch(args.search) !== undefined) return { total: null };
    const stats = await orgStatsRow(ctx);
    return { total: stats === null ? null : (stats.employeeCount ?? 0) };
  },
});

/**
 * Employees whose name or username starts with the words of `text` (viewer,
 * `search_text`, at most MAX_EMPLOYEE_SEARCH rows; `capped` = there may be more).
 * `groupId` keeps only members of that group: the search index has no group
 * field, so up to MAX_EMPLOYEE_SEARCH_SCAN hits are examined (one index range
 * each) until MAX_EMPLOYEE_SEARCH members are found; `capped` is also set when
 * that scan ran out, because the answer may then be incomplete.
 * Phase 4b: tables search with `employees:list({ search })` (paginated); this
 * bounded form stays for the employee picker.
 */
export const search = memberQuery("viewer")({
  args: { text: v.string(), groupId: v.optional(v.string()) },
  returns: v.object({ rows: v.array(employeeRow), capped: v.boolean() }),
  handler: async (ctx, args) => {
    const group = args.groupId === undefined ? null : await getInOrg(ctx, "groups", args.groupId, ctx.orgId);
    const text = searchQuery(args.text, MAX_SEARCH_TEXT);
    if (text === "") return { rows: [], capped: false };
    const scan = group === null ? MAX_EMPLOYEE_SEARCH : MAX_EMPLOYEE_SEARCH_SCAN;
    const hits = await ctx.db
      .query("employees")
      .withSearchIndex("search_text", (q) => q.search("searchText", text).eq("orgId", ctx.orgId))
      .take(scan + 1);
    let capped = hits.length > scan;
    const kept: Doc<"employees">[] = [];
    for (const e of hits.slice(0, scan)) {
      if (group !== null) {
        const member = await ctx.db
          .query("groupMembers")
          .withIndex("by_group_employee", (q) => q.eq("groupId", group._id).eq("employeeId", e._id))
          .first();
        if (member === null) continue;
      }
      if (kept.length === MAX_EMPLOYEE_SEARCH) {
        capped = true;
        break;
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
    // Everything cheap first, so a bad request costs no hash: the rules, then one
    // read-only precheck (username free, groups and apps in the organization,
    // plan limit, group room), then the rate limit (every create, with or
    // without a password), then the hash. The mutation checks it all again.
    normalizeEmployeeName(args.name);
    const username = checkedUsername(args.username);
    checkedQuota(args.quotaGb);
    const password = args.password !== undefined && args.password !== "" ? args.password : undefined;
    if (password !== undefined) assertEmployeePassword(password, username);
    await ctx.runQuery(internal.employees.createPrecheck, {
      orgId: ctx.orgId,
      username,
      groupIds: args.groupIds,
      appIds: args.appIds ?? [],
    });
    await consumeOrFail(ctx, "employeeWrites", ctx.orgId);
    const phc = password === undefined ? undefined : await hashSecret(ctx, password);
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

/**
 * What `create` can know before it spends a rate-limit token and a hash:
 * a free username (`conflict`), groups and apps of the organization
 * (`not_found`, `too_large`, `invalid_argument` for an archived app), room in the plan
 * (`plan_limit`) and in the groups (`too_large`). Reads only; `storeNew` checks
 * everything again in the transaction that inserts.
 */
export const createPrecheck = internalQuery({
  args: { orgId: v.id("organizations"), username: v.string(), groupIds: v.array(v.string()), appIds: v.array(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const taken = await ctx.db
      .query("employees")
      .withIndex("by_org_username", (q) => q.eq("orgId", args.orgId).eq("username", args.username))
      .first();
    if (taken !== null) fail("conflict", { field: "username" });
    const groups = await resolveIds(ctx, "groups", args.groupIds, args.orgId, MAX_EMPLOYEE_GROUPS, "employee groups");
    const apps = await resolveIds(ctx, "apps", args.appIds, args.orgId, MAX_EMPLOYEE_APPS, "employee apps");
    if (apps.some((a) => a.archived)) fail("invalid_argument", { field: "appIds" });
    await assertWithinLimit(ctx, args.orgId, "employees");
    await assertGroupRoom(ctx, args.orgId, groups.map((g) => g._id));
    return null;
  },
});

/** An Argon2id PHC string made with the app's parameters (`lib/argon.ts`): what only `hashSecret` produces. */
function isAppPhc(phc: string): boolean {
  const p = ARGON2_PARAMS;
  return phc.startsWith(`$argon2id$v=19$m=${p.memorySize},t=${p.iterations},p=${p.parallelism}$`);
}

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
    if (args.phc !== undefined && !isAppPhc(args.phc)) fail("invalid_argument", { field: "password" });
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
      await ctx.db.insert("groupMembers", { orgId, groupId: g._id, employeeId, grantsActive: apps.length > 0 });
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
    return { revision: await applyChanges(ctx, e, { profile: { name: args.name, username: args.username, quotaGb: args.quotaGb } }) };
  },
});

type ChangeCtx = Pick<MutationCtx, "db" | "scheduler"> & { orgId: Id<"organizations">; actor: AuditActor };

/**
 * The one writer of an employee's profile, groups and direct apps, shared by
 * `update`, `setGroups`, `setDirectApps` and `save`. Each part is optional; the
 * parts given are validated first, then applied together in ONE transaction with
 * ONE revision bump and, per group, at most one signed roster entry. Returns the
 * employee's revision (unchanged when nothing differed: no write at all). The
 * caller has checked the revision.
 */
async function applyChanges(
  ctx: ChangeCtx,
  e: Doc<"employees">,
  parts: { profile?: { name: string; username: string; quotaGb: number | undefined }; groupIds?: string[]; appIds?: string[] },
): Promise<number> {
  const orgId = ctx.orgId;
  // ---- validate and diff
  let profile: { name: string; username: string; quotaGb: number | undefined; changed: string[] } | undefined;
  if (parts.profile !== undefined) {
    const name = normalizeEmployeeName(parts.profile.name);
    const username = checkedUsername(parts.profile.username);
    const quotaGb = checkedQuota(parts.profile.quotaGb);
    const changed: string[] = [];
    if (name !== e.name) changed.push("name");
    if (username !== e.username) changed.push("username");
    if (quotaGb !== e.quotaGb) changed.push("quota");
    if (changed.length > 0) profile = { name, username, quotaGb, changed };
  }
  const renamed = profile !== undefined && profile.username !== e.username;
  const wantedGroups = parts.groupIds === undefined ? undefined : await resolveIds(ctx, "groups", parts.groupIds, orgId, MAX_EMPLOYEE_GROUPS, "employee groups");
  const wantedApps = parts.appIds === undefined ? undefined : await resolveIds(ctx, "apps", parts.appIds, orgId, MAX_EMPLOYEE_APPS, "employee apps");

  const current = wantedGroups !== undefined || (renamed && !e.disabled) ? await membershipsOf(ctx, e._id) : [];
  let addGroups: Doc<"groups">[] = [];
  let removeGroups: Doc<"groupMembers">[] = [];
  if (wantedGroups !== undefined) {
    const wantedIds = new Set<string>(wantedGroups.map((g) => g._id));
    const haveIds = new Set<string>(current.map((m) => m.groupId));
    addGroups = wantedGroups.filter((g) => !haveIds.has(g._id));
    removeGroups = current.filter((m) => !wantedIds.has(m.groupId));
  }
  let currentGrants: Doc<"employeeApps">[] = [];
  let addApps: Doc<"apps">[] = [];
  let removeApps: Doc<"employeeApps">[] = [];
  if (wantedApps !== undefined) {
    currentGrants = await ctx.db
      .query("employeeApps")
      .withIndex("by_employee", (q) => q.eq("employeeId", e._id))
      .take(MAX_EMPLOYEE_APPS + 1);
    const haveIds = new Set<string>(currentGrants.map((g) => g.appId));
    const wantedIds = new Set<string>(wantedApps.map((a) => a._id));
    addApps = wantedApps.filter((a) => !haveIds.has(a._id));
    removeApps = currentGrants.filter((g) => !wantedIds.has(g.appId));
  }
  const groupsChanged = addGroups.length > 0 || removeGroups.length > 0;
  const appsChanged = addApps.length > 0 || removeApps.length > 0;
  if (profile === undefined && !groupsChanged && !appsChanged) return e.revision;
  if (addApps.some((a) => a.archived)) fail("invalid_argument", { field: "appIds" });
  if (profile !== undefined && renamed) {
    const taken = await ctx.db
      .query("employees")
      .withIndex("by_org_username", (q) => q.eq("orgId", orgId).eq("username", profile.username))
      .first();
    if (taken !== null && taken._id !== e._id) fail("conflict", { field: "username" });
  }
  if (addGroups.length > 0) await assertGroupRoom(ctx, orgId, addGroups.map((g) => g._id));

  // ---- roster: one entry per affected group (an enabled employee only)
  const name = profile?.name ?? e.name;
  const credentialRevision = renamed ? e.credentialRevision + 1 : e.credentialRevision;
  if (!e.disabled) {
    const plan: RosterPlan = new Map();
    const removed = new Set<string>(removeGroups.map((m) => m.groupId));
    for (const g of addGroups) planRoster(plan, g._id, { employeeId: e._id, credentialRevision });
    for (const m of removeGroups) planRoster(plan, m.groupId, { employeeId: e._id, credentialRevision: null });
    if (renamed) {
      for (const m of current) if (!removed.has(m.groupId)) planRoster(plan, m.groupId, { employeeId: e._id, credentialRevision });
    }
    await appendRoster(ctx, orgId, plan);
  }

  // ---- writes
  const hadGrants = wantedApps === undefined ? await hasDirectApps(ctx, e._id) : currentGrants.length > 0;
  const hasGrants = wantedApps === undefined ? hadGrants : wantedApps.length > 0;
  const revision = nextRevision(e);
  if (profile !== undefined) {
    await ctx.db.patch(e._id, {
      name: profile.name,
      username: profile.username,
      searchText: searchTextOf(profile.name, profile.username),
      quotaGb: profile.quotaGb,
      credentialRevision,
      revision,
    });
  } else {
    await ctx.db.patch(e._id, { revision });
  }
  const removeNames: string[] = [];
  for (const m of removeGroups) removeNames.push((await ctx.db.get(m.groupId))?.name ?? "a group");
  for (const g of addGroups) {
    await ctx.db.insert("groupMembers", { orgId, groupId: g._id, employeeId: e._id, grantsActive: !e.disabled && hasGrants });
  }
  for (const m of removeGroups) await ctx.db.delete(m._id);
  for (const a of addApps) await ctx.db.insert("employeeApps", { orgId, employeeId: e._id, appId: a._id });
  for (const g of removeApps) await ctx.db.delete(g._id);
  if (appsChanged) await syncGrantFlags(ctx, e);

  // ---- audit, in the order profile, groups, apps
  if (profile !== undefined) {
    await writeAudit(ctx, {
      orgId,
      actor: ctx.actor,
      action: "employee.updated",
      targetType: "employee",
      targetId: e._id,
      targetLabel: name,
      summary: `Changed the ${profile.changed.join(", ")} of ${name}`,
    });
  }
  if (groupsChanged) {
    const bits: string[] = [];
    if (addGroups.length > 0) bits.push(`added to ${addGroups.map((g) => g.name).join(", ")}`);
    if (removeNames.length > 0) bits.push(`removed from ${removeNames.join(", ")}`);
    await writeAudit(ctx, {
      orgId,
      actor: ctx.actor,
      action: "employee.groupsChanged",
      targetType: "employee",
      targetId: e._id,
      targetLabel: name,
      summary: `Changed the groups of ${name} (${bits.join("; ")})`,
    });
  }
  if (appsChanged) {
    await writeAudit(ctx, {
      orgId,
      actor: ctx.actor,
      action: "employee.appsChanged",
      targetType: "employee",
      targetId: e._id,
      targetLabel: name,
      summary: `Changed the apps of ${name} (${addApps.length} added, ${removeApps.length} removed)`,
    });
  }

  // ---- publish: direct grants show in the catalogue of the employee's groups
  // (a disabled employee is in no document). Every grant change republishes the
  // current groups; a group change does when the employee has grants before or after.
  if (!e.disabled) {
    const groupIds = new Set<Id<"groups">>();
    if (groupsChanged && (hadGrants || hasGrants)) {
      for (const g of addGroups) groupIds.add(g._id);
      for (const m of removeGroups) groupIds.add(m.groupId);
    }
    if (appsChanged) for (const m of await membershipsOf(ctx, e._id)) groupIds.add(m.groupId);
    if (groupIds.size > 0) await requestPublish(ctx, orgId, { groupIds: [...groupIds] });
  }
  return revision;
}

/**
 * Save the whole employee form at once (admin; unlocked session): profile,
 * groups and direct apps in ONE transaction with ONE revision check. Either
 * everything is stored and the new revision returned, or nothing is stored (a
 * `stale_edit`, `not_ready`, `too_large`, `conflict`, `not_found`... leaves the
 * employee, and so the form's revision, exactly as it was). Same rules as
 * `update`, `setGroups` and `setDirectApps`; a part that changes nothing writes
 * nothing, and nothing changed at all returns the same revision.
 */
export const save = memberMutation("admin")({
  args: {
    employeeId: v.string(),
    expectedRevision: v.number(),
    name: v.string(),
    username: v.string(),
    quotaGb: v.optional(v.number()),
    groupIds: v.array(v.string()),
    appIds: v.array(v.string()),
  },
  returns: v.object({ revision: v.number() }),
  handler: async (ctx, args) => {
    const e = await getInOrg(ctx, "employees", args.employeeId, ctx.orgId);
    checkRevision(e, args.expectedRevision);
    const revision = await applyChanges(ctx, e, {
      profile: { name: args.name, username: args.username, quotaGb: args.quotaGb },
      groupIds: args.groupIds,
      appIds: args.appIds,
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
    return { revision: await applyChanges(ctx, e, { groupIds: args.groupIds }) };
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
    return { revision: await applyChanges(ctx, e, { appIds: args.appIds }) };
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
    if (!isAppPhc(args.phc)) fail("invalid_argument", { field: "password" });
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
    // A new password ends a lockout: an admin who resets the password of a locked-out employee
    // expects it to work at once (the failures belonged to the old password).
    const lock = await ctx.db
      .query("employeeLockouts")
      .withIndex("by_employee", (q) => q.eq("employeeId", e._id))
      .unique();
    if (lock !== null) await ctx.db.delete(lock._id);
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
 *
 * DISABLING IS NEVER REFUSED, with or without a signing key (owner decision,
 * Step 11 review). Without a valid key the removals cannot be signed: they are
 * queued (`rosterPending`, one row per group) and `employees:resyncRoster`
 * signs them once a key is available (key registered, rotation finished, or
 * the next publish run that can sign). Enabling still needs the key
 * (`not_ready`, detail "signing key") because it must sign an "added" entry.
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
    let pending = false;
    if (args.disabled) {
      pending = (await appendRosterOrQueue(ctx, ctx.orgId, plan)) === "pending";
    } else {
      await appendRoster(ctx, ctx.orgId, plan);
      // The new "added" entries supersede removals that were still waiting for a key.
      const waiting = await ctx.db
        .query("rosterPending")
        .withIndex("by_employee", (q) => q.eq("employeeId", e._id))
        .take(MAX_EMPLOYEE_GROUPS + 1);
      const rejoined = new Set<string>(memberships.map((m) => m.groupId));
      for (const row of waiting) if (rejoined.has(row.groupId)) await ctx.db.delete(row._id);
    }
    await ctx.db.patch(e._id, { disabled: args.disabled });
    await syncGrantFlags(ctx, { _id: e._id, disabled: args.disabled });
    await bumpOrgStats(ctx, ctx.orgId, { activeEmployeeCount: args.disabled ? -1 : 1 });
    await writeAudit(ctx, {
      orgId: ctx.orgId,
      actor: ctx.actor,
      action: args.disabled ? "employee.disabled" : "employee.enabled",
      targetType: "employee",
      targetId: e._id,
      targetLabel: e.name,
      summary: args.disabled
        ? `Disabled the employee ${e.name}${pending ? " (offline sign-in ends when the signing key is available)" : ""}`
        : `Enabled the employee ${e.name}`,
    });
    // The catalogue lists only enabled employees under an app (`employeeIds`).
    await publishForGrants(ctx, ctx.orgId, { _id: e._id, disabled: false }, memberships.map((m) => m.groupId));
    return null;
  },
});

/**
 * Sign the removals that `setDisabled` could not sign for lack of a key
 * (`rosterPending`): a batch of ROSTER_RESYNC_BATCH per run, each row deleted in
 * the transaction that appends its entry (so never signed twice), rescheduling
 * itself while batches are full. A no-op without pending rows, or while there is
 * still no valid key (the rows stay). Scheduled by `keys:registerActive`,
 * `keys:finishRotation` and `publish:run` (after it loaded a valid key).
 */
export const resyncRoster = internalMutation({
  args: { orgId: v.id("organizations") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const state = await resyncPendingRoster(ctx, args.orgId);
    if (state === "more") await ctx.scheduler.runAfter(0, internal.employees.resyncRoster, { orgId: args.orgId });
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
