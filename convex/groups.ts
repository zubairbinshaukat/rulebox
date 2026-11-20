import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { DatabaseReader } from "./_generated/server";
import { writeAudit } from "./lib/audit";
import { checkRevision, getInOrg, nextRevision } from "./lib/authz";
import { changeMemberships, membershipsOf } from "./lib/employeeSync";
import { fail } from "./lib/errors";
import { snapshotGroupConfig } from "./lib/groupConfig";
import { failedFollowAssignment } from "./lib/installs";
import { memberMutation, memberQuery } from "./lib/functions";
import { boundedPageValidator, byField, checkPageSize, cleanSearch, matches, pageInMemory, pickSort, sortArg } from "./lib/listing";
import {
  GROUP_COUNT_CAP,
  MAX_EMPLOYEE_GROUPS,
  MAX_GROUP_APPS,
  MAX_GROUP_CODES_CHECKED,
  MAX_GROUP_DESCRIPTION,
  MAX_GROUP_NAME,
  MAX_GROUPS_LISTED,
} from "./lib/limits";
import { cleanIdleClose, cleanWindowCap, modeText, nullableNumber } from "./lib/displayRules";
import { DEFAULT_LOCKDOWN_SETTINGS } from "./lib/lockdownValidators";
import { assertWithinLimit, bumpOrgStats, bumpStats } from "./lib/plans";
import { requestPublish } from "./lib/publish";
import { appKind, audience, displayModeOverride } from "./lib/validators";

// Groups (plan Step 5.6; PRD 3.1). Tiny table: every read goes through
// `groups.by_org` / `groups.by_org_name`. Counts per group come from
// `.take(GROUP_COUNT_CAP + 1)` reads and are shown as "500+" above the cap
// (Step 17 may replace them with counters if the I/O probe asks for it).

/** A count read with `.take(cap + 1)`: `count` is at most the cap, `more` = above it. */
const cappedCount = v.object({ count: v.number(), more: v.boolean() });

function capped(rows: unknown[]): { count: number; more: boolean } {
  return { count: Math.min(rows.length, GROUP_COUNT_CAP), more: rows.length > GROUP_COUNT_CAP };
}

async function countsOf(ctx: { db: DatabaseReader }, groupId: Id<"groups">) {
  const devices = await ctx.db
    .query("devices")
    .withIndex("by_group", (q) => q.eq("groupId", groupId))
    .take(GROUP_COUNT_CAP + 1);
  const employees = await ctx.db
    .query("groupMembers")
    .withIndex("by_group", (q) => q.eq("groupId", groupId))
    .take(GROUP_COUNT_CAP + 1);
  return { devices: capped(devices), employees: capped(employees) };
}

const groupRow = v.object({
  _id: v.id("groups"),
  name: v.string(),
  description: v.optional(v.string()),
  revision: v.number(),
  createdAt: v.number(),
  /** The group made with the organization; not counted toward the plan's `maxGroups`. */
  isDefault: v.boolean(),
  devices: cappedCount,
  employees: cappedCount,
  /** Phase 6 Step 19: the group's display settings; absent = no choice (auto, the mode's defaults). */
  displayMode: v.optional(displayModeOverride),
  webWindowCap: v.optional(v.number()),
  webIdleCloseMin: v.optional(v.number()),
});

function rowOf(g: Doc<"groups">, counts: Awaited<ReturnType<typeof countsOf>>) {
  return {
    _id: g._id,
    name: g.name,
    description: g.description,
    revision: g.revision ?? 0,
    createdAt: g.createdAt ?? g._creationTime,
    isDefault: g.isDefault === true,
    ...counts,
    ...(g.displayMode !== undefined ? { displayMode: g.displayMode } : {}),
    ...(g.webWindowCap !== undefined ? { webWindowCap: g.webWindowCap } : {}),
    ...(g.webIdleCloseMin !== undefined ? { webIdleCloseMin: g.webIdleCloseMin } : {}),
  };
}

/** Every group of the organization with device and employee counts (viewer). */
export const list = memberQuery("viewer")({
  args: {},
  returns: v.array(groupRow),
  handler: async (ctx) => {
    const groups = await ctx.db
      .query("groups")
      .withIndex("by_org", (q) => q.eq("orgId", ctx.orgId))
      .take(MAX_GROUPS_LISTED);
    const out = [];
    for (const g of groups) out.push(rowOf(g, await countsOf(ctx, g._id)));
    return out.sort((a, b) => a.name.localeCompare(b.name));
  },
});

/**
 * One page of the organization's groups for the groups table (viewer; list
 * contract in lib/listing.ts). Groups are a SMALL bounded table: the query
 * reads at most MAX_GROUPS_LISTED rows (`groups.by_org`), keeps those whose
 * name or description contains `search` (case-insensitive), sorts them by
 * `sort` ("name" A-Z by default, or "created") and returns one page with the
 * exact `total` (no counter needed: `groupCount` leaves out the default
 * group). Device and employee counts are read for the page's rows only.
 */
export const page = memberQuery("viewer")({
  args: { paginationOpts: paginationOptsValidator, search: v.optional(v.string()), sort: sortArg },
  returns: boundedPageValidator(groupRow),
  handler: async (ctx, args) => {
    checkPageSize(args.paginationOpts.numItems);
    const sort = pickSort("groups", args.sort);
    const search = cleanSearch(args.search);
    const groups = await ctx.db
      .query("groups")
      .withIndex("by_org", (q) => q.eq("orgId", ctx.orgId))
      .take(MAX_GROUPS_LISTED);
    const kept = groups
      .filter((g) => matches(search, g.name, g.description))
      .sort(sort.key === "name" ? byField((g) => g.name, sort.dir) : byField((g) => g.createdAt ?? g._creationTime, sort.dir));
    const result = pageInMemory(kept, args.paginationOpts);
    const rows = [];
    for (const g of result.page) rows.push(rowOf(g, await countsOf(ctx, g._id)));
    return { ...result, page: rows };
  },
});

/** One group with its counts and assigned apps (viewer). The devices list is `fleet:list({ groupId })`. */
export const get = memberQuery("viewer")({
  args: { groupId: v.string() },
  returns: v.object({
    group: groupRow,
    apps: v.array(
      v.object({
        /** The `appAssignments` id: what `updateAssignment` / `unassignApp` take. */
        assignmentId: v.id("appAssignments"),
        appId: v.id("apps"),
        name: v.string(),
        kind: appKind,
        hue: v.optional(v.number()),
        archived: v.boolean(),
        audience,
        pinnedTaskbar: v.boolean(),
        pinnedDesktop: v.boolean(),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    const group = await getInOrg(ctx, "groups", args.groupId, ctx.orgId);
    const assignments = await ctx.db
      .query("appAssignments")
      .withIndex("by_group", (q) => q.eq("groupId", group._id))
      .take(MAX_GROUP_APPS);
    const apps = [];
    for (const a of assignments) {
      const app = await ctx.db.get(a.appId);
      if (app === null || app.orgId !== ctx.orgId) continue;
      apps.push({
        assignmentId: a._id,
        appId: app._id,
        name: app.name,
        kind: app.kind,
        hue: app.hue,
        archived: app.archived,
        audience: a.audience,
        pinnedTaskbar: a.pinnedTaskbar,
        pinnedDesktop: a.pinnedDesktop,
      });
    }
    return { group: rowOf(group, await countsOf(ctx, group._id)), apps };
  },
});

function normalizeName(name: string): string {
  const trimmed = name.trim();
  // eslint-disable-next-line no-control-regex
  if (trimmed.length < 1 || trimmed.length > MAX_GROUP_NAME || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    fail("invalid_argument", { field: "name" });
  }
  return trimmed;
}

/** undefined = no description; "" after trimming clears it. */
function normalizeDescription(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const trimmed = text.trim();
  if (trimmed.length > MAX_GROUP_DESCRIPTION) fail("invalid_argument", { field: "description" });
  return trimmed === "" ? undefined : trimmed;
}

/** `conflict` (field "name") when another group of the organization has this exact name. */
async function assertNameFree(
  ctx: { db: DatabaseReader },
  orgId: Id<"organizations">,
  name: string,
  except?: Id<"groups">,
): Promise<void> {
  const same = await ctx.db
    .query("groups")
    .withIndex("by_org_name", (q) => q.eq("orgId", orgId).eq("name", name))
    .first();
  if (same !== null && same._id !== except) fail("conflict", { field: "name" });
}

/** Create a group (admin). Refused with `plan_limit` (detail "groups") at the plan's `maxGroups`. */
export const create = memberMutation("admin")({
  args: { name: v.string(), description: v.optional(v.string()) },
  returns: v.object({ groupId: v.id("groups") }),
  handler: async (ctx, args) => {
    const name = normalizeName(args.name);
    const description = normalizeDescription(args.description);
    await assertNameFree(ctx, ctx.orgId, name);
    // Limit check and counter in the same transaction as the insert.
    const stats = await assertWithinLimit(ctx, ctx.orgId, "groups");
    const groupId = await ctx.db.insert("groups", {
      orgId: ctx.orgId,
      name,
      description,
      revision: 0,
      createdAt: Date.now(),
    });
    await bumpStats(ctx, stats, { groupCount: 1 });
    // Phase 5 Step 19: the group starts with the lockdown defaults (program rules in audit mode), stored as its own row so the
    // overview can warn when they are still in audit after 14 days (`groupLockdown.by_org_audit`). Same content as the fallback
    // the builder used before, so the first configuration version does not change.
    const org = await ctx.db.get(ctx.orgId);
    const settings = org?.phase5Settings?.newGroupDefaults ?? DEFAULT_LOCKDOWN_SETTINGS;
    const inAudit = settings.appLocker.mode === "audit" || settings.appControl.mode === "audit" || settings.procWatch.mode === "audit";
    await ctx.db.insert("groupLockdown", { orgId: ctx.orgId, groupId, settings, revision: 0, auditSince: inAudit ? Date.now() : undefined });
    await writeAudit(ctx, {
      orgId: ctx.orgId,
      actor: ctx.actor,
      action: "group.created",
      targetType: "group",
      targetId: groupId,
      targetLabel: name,
      summary: `Created the group ${name}`,
    });
    return { groupId };
  },
});

/**
 * Rename a group and/or change its description (admin). `description`
 * undefined = unchanged, "" = cleared. `stale_edit` when someone saved in
 * between. Nothing changed = no write. Audit `group.renamed` when the name
 * changed, else `group.updated`.
 */
export const rename = memberMutation("admin")({
  args: {
    groupId: v.string(),
    expectedRevision: v.number(),
    name: v.string(),
    description: v.optional(v.string()),
  },
  returns: v.object({ revision: v.number() }),
  handler: async (ctx, args) => {
    const group = await getInOrg(ctx, "groups", args.groupId, ctx.orgId);
    checkRevision(group, args.expectedRevision);
    const name = normalizeName(args.name);
    const description = args.description === undefined ? group.description : normalizeDescription(args.description);
    const nameChanged = name !== group.name;
    if (!nameChanged && description === group.description) return { revision: group.revision ?? 0 };
    if (nameChanged) await assertNameFree(ctx, ctx.orgId, name, group._id);
    const revision = nextRevision(group);
    await ctx.db.patch(group._id, { name, description, revision });
    await writeAudit(ctx, {
      orgId: ctx.orgId,
      actor: ctx.actor,
      action: nameChanged ? "group.renamed" : "group.updated",
      targetType: "group",
      targetId: group._id,
      targetLabel: name,
      summary: nameChanged ? `Renamed the group ${group.name} to ${name}` : `Changed the description of the group ${name}`,
    });
    return { revision };
  },
});

/**
 * (Phase 6 Step 19, plan 4.14, 4.16) The group's display settings (admin): its display-mode choice (`auto` = none), the most web app
 * windows open at once (1..12, `null` = Lite 3 / Standard 8) and the minutes after which a hidden, silent one is closed (0 = off, 5..240,
 * `null` = Lite 30 / Standard off). A PC's own choice (`fleet:setDisplayMode`) wins over the group's. `stale_edit` when someone saved in
 * between; nothing changed = no write, no publish. Republishes the group's PCs and audits `group.displayModeChanged`. 5 reads, 3 writes.
 */
export const setDisplay = memberMutation("admin")({
  args: {
    groupId: v.string(),
    expectedRevision: v.number(),
    displayMode: displayModeOverride,
    webWindowCap: nullableNumber,
    webIdleCloseMin: nullableNumber,
  },
  returns: v.object({ revision: v.number() }),
  handler: async (ctx, args) => {
    const group = await getInOrg(ctx, "groups", args.groupId, ctx.orgId);
    checkRevision(group, args.expectedRevision);
    const displayMode = args.displayMode === "auto" ? undefined : args.displayMode;
    const webWindowCap = cleanWindowCap(args.webWindowCap);
    const webIdleCloseMin = cleanIdleClose(args.webIdleCloseMin);
    if (displayMode === group.displayMode && webWindowCap === group.webWindowCap && webIdleCloseMin === group.webIdleCloseMin) {
      return { revision: group.revision ?? 0 };
    }
    const revision = nextRevision(group);
    await ctx.db.patch(group._id, { displayMode, webWindowCap, webIdleCloseMin, revision });
    await requestPublish(ctx, ctx.orgId, { groupIds: [group._id] });
    const parts = [`display mode ${modeText(displayMode)}`];
    parts.push(webWindowCap === undefined ? "window limit by mode" : `at most ${webWindowCap} web windows`);
    parts.push(webIdleCloseMin === undefined ? "idle close by mode" : webIdleCloseMin === 0 ? "idle close off" : `idle close after ${webIdleCloseMin} min`);
    await writeAudit(ctx, {
      orgId: ctx.orgId,
      actor: ctx.actor,
      action: "group.displayModeChanged",
      targetType: "group",
      targetId: group._id,
      targetLabel: group.name,
      summary: `Changed the display settings of the group ${group.name}: ${parts.join(", ")}`,
    });
    return { revision };
  },
});

/**
 * Delete a group (admin, major: fresh step-up). Refused with `has_dependents`
 * while devices, employees, app assignments or usable enrollment codes still
 * reference it; `detail` lists what to move first, e.g. "devices, employees".
 */
export const remove = memberMutation("admin", { major: "groups:remove" })({
  args: { groupId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const group = await getInOrg(ctx, "groups", args.groupId, ctx.orgId);
    const dependents: string[] = [];
    const device = await ctx.db
      .query("devices")
      .withIndex("by_group", (q) => q.eq("groupId", group._id))
      .first();
    if (device !== null) dependents.push("devices");
    const member = await ctx.db
      .query("groupMembers")
      .withIndex("by_group", (q) => q.eq("groupId", group._id))
      .first();
    if (member !== null) dependents.push("employees");
    const assignment = await ctx.db
      .query("appAssignments")
      .withIndex("by_group", (q) => q.eq("groupId", group._id))
      .first();
    if (assignment !== null) dependents.push("apps");
    const now = Date.now();
    const codes = await ctx.db
      .query("enrollmentTokens")
      .withIndex("by_group_expires", (q) => q.eq("groupId", group._id).gt("expiresAt", now))
      .take(MAX_GROUP_CODES_CHECKED);
    if (codes.some((c) => c.revoked !== true && c.usesLeft > 0)) dependents.push("enrollment codes");
    if (dependents.length > 0) fail("has_dependents", { detail: dependents.join(", ") });

    await ctx.db.delete(group._id);
    // Step 19: its lockdown settings row goes with it (else the overview would keep warning about a group that is gone).
    const lockdown = await ctx.db
      .query("groupLockdown")
      .withIndex("by_group", (q) => q.eq("groupId", group._id))
      .unique();
    if (lockdown !== null) await ctx.db.delete(lockdown._id);
    // Step 20b: the rest (its id in Wi-Fi profiles, printers and drivers, its rollout row, its configurations and exceptions, its live
    // broadcasts) is cleaned up by bounded scheduled steps.
    await ctx.scheduler.runAfter(0, internal.groupBatches.cleanupDeletedGroup, { orgId: ctx.orgId, groupId: group._id });
    // The default group was never counted (it is not one of the plan's groups).
    if (group.isDefault !== true) await bumpOrgStats(ctx, ctx.orgId, { groupCount: -1 });
    await writeAudit(ctx, {
      orgId: ctx.orgId,
      actor: ctx.actor,
      action: "group.deleted",
      targetType: "group",
      targetId: group._id,
      targetLabel: group.name,
      summary: `Deleted the group ${group.name}`,
    });
    return null;
  },
});

// ---------------------------------------------------------------- members (plan Step 11)

/**
 * Put an employee into a group (admin; unlocked session): they may then sign
 * in on the group's PCs. Already a member = no write. One signed roster entry
 * for the group (when the employee is enabled); the group's documents are
 * republished only when the employee has direct app grants. `too_large`
 * (detail "employee groups" / "group employees") at the limits one document
 * and one employee form can carry. The group's employee LIST is
 * `employees:list({ groupId })`.
 */
export const addEmployee = memberMutation("admin")({
  args: { groupId: v.string(), employeeId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const group = await getInOrg(ctx, "groups", args.groupId, ctx.orgId);
    const employee = await getInOrg(ctx, "employees", args.employeeId, ctx.orgId);
    const member = await ctx.db
      .query("groupMembers")
      .withIndex("by_group_employee", (q) => q.eq("groupId", group._id).eq("employeeId", employee._id))
      .first();
    if (member !== null) return null;
    if ((await membershipsOf(ctx, employee._id)).length >= MAX_EMPLOYEE_GROUPS) fail("too_large", { detail: "employee groups" });
    await changeMemberships(ctx, { orgId: ctx.orgId, actor: ctx.actor, employee, add: [group], remove: [], removeNames: [] });
    return null;
  },
});

/** Take an employee out of a group (admin; unlocked session). Not a member = no write. Their sign-in on the group's PCs ends (a signed "removed" roster entry). */
export const removeEmployee = memberMutation("admin")({
  args: { groupId: v.string(), employeeId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const group = await getInOrg(ctx, "groups", args.groupId, ctx.orgId);
    const employee = await getInOrg(ctx, "employees", args.employeeId, ctx.orgId);
    const member = await ctx.db
      .query("groupMembers")
      .withIndex("by_group_employee", (q) => q.eq("groupId", group._id).eq("employeeId", employee._id))
      .first();
    if (member === null) return null;
    await changeMemberships(ctx, { orgId: ctx.orgId, actor: ctx.actor, employee, add: [], remove: [member], removeNames: [group.name] });
    return null;
  },
});

// ---------------------------------------------------------------- app assignments (plan Step 10 item 6)

/** The pins and audience of one assignment (the same arguments `assignApp` and `updateAssignment` take). */
const assignmentFields = {
  audience,
  pinnedTaskbar: v.boolean(),
  pinnedDesktop: v.boolean(),
};

/**
 * Give a group an app (admin; unlocked session): its devices then install and
 * show it. One assignment per group and app (`conflict`, field "app");
 * `invalid_argument` (field "app") for an archived app; `too_large` (detail
 * "group apps") at MAX_GROUP_APPS, the most one document carries. Republishes
 * the group.
 */
export const assignApp = memberMutation("admin")({
  args: { groupId: v.string(), appId: v.string(), ...assignmentFields },
  returns: v.object({ assignmentId: v.id("appAssignments") }),
  handler: async (ctx, args) => {
    const group = await getInOrg(ctx, "groups", args.groupId, ctx.orgId);
    const app = await getInOrg(ctx, "apps", args.appId, ctx.orgId);
    if (app.archived) fail("invalid_argument", { field: "app" });
    const same = await ctx.db
      .query("appAssignments")
      .withIndex("by_group_app", (q) => q.eq("groupId", group._id).eq("appId", app._id))
      .first();
    if (same !== null) fail("conflict", { field: "app" });
    const all = await ctx.db
      .query("appAssignments")
      .withIndex("by_group", (q) => q.eq("groupId", group._id))
      .take(MAX_GROUP_APPS);
    if (all.length >= MAX_GROUP_APPS) fail("too_large", { detail: "group apps" });
    const assignmentId = await ctx.db.insert("appAssignments", {
      orgId: ctx.orgId,
      groupId: group._id,
      appId: app._id,
      audience: args.audience,
      pinnedTaskbar: args.pinnedTaskbar,
      pinnedDesktop: args.pinnedDesktop,
    });
    // Results the group's PCs reported earlier for this app count again (Step 17 review).
    await failedFollowAssignment(ctx, ctx.orgId, app, group._id, 1);
    await writeAudit(ctx, {
      orgId: ctx.orgId,
      actor: ctx.actor,
      action: "app.assigned",
      targetType: "app",
      targetId: app._id,
      targetLabel: app.name,
      summary: `Assigned the app ${app.name} to the group ${group.name}`,
    });
    // Step 16b: assignments are ring-gated (plan 4.3 rule 6): a new configuration version, then the publish.
    await snapshotGroupConfig(ctx, group._id, `Assigned ${app.name}`, ctx.member._id);
    await requestPublish(ctx, ctx.orgId, { groupIds: [group._id] });
    return { assignmentId };
  },
});

/** Change an assignment's audience and pins (admin). Nothing changed = no write, no publish. */
export const updateAssignment = memberMutation("admin")({
  args: { assignmentId: v.string(), ...assignmentFields },
  returns: v.null(),
  handler: async (ctx, args) => {
    const a = await getInOrg(ctx, "appAssignments", args.assignmentId, ctx.orgId);
    if (a.audience === args.audience && a.pinnedTaskbar === args.pinnedTaskbar && a.pinnedDesktop === args.pinnedDesktop) {
      return null;
    }
    const group = await ctx.db.get(a.groupId);
    const app = await ctx.db.get(a.appId);
    await ctx.db.patch(a._id, { audience: args.audience, pinnedTaskbar: args.pinnedTaskbar, pinnedDesktop: args.pinnedDesktop });
    await writeAudit(ctx, {
      orgId: ctx.orgId,
      actor: ctx.actor,
      action: "app.updated",
      targetType: "app",
      targetId: a.appId,
      targetLabel: app?.name,
      summary: `Changed how ${app?.name ?? "an app"} is offered to the group ${group?.name ?? ""}`.trim(),
    });
    if (group !== null) await snapshotGroupConfig(ctx, group._id, `Assignment of ${app?.name ?? "an app"}`, ctx.member._id);
    await requestPublish(ctx, ctx.orgId, { groupIds: [a.groupId] });
    return null;
  },
});

/** Take an app away from a group (admin; unlocked session). Its devices stop offering it; an installed msi may be removed (the app's `removeWhenUnassigned`). */
export const unassignApp = memberMutation("admin")({
  args: { assignmentId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const a = await getInOrg(ctx, "appAssignments", args.assignmentId, ctx.orgId);
    const group = await ctx.db.get(a.groupId);
    const app = await ctx.db.get(a.appId);
    await ctx.db.delete(a._id);
    // The group's results for this app stop counting (the agent reports nothing for an unassigned app).
    if (app !== null) await failedFollowAssignment(ctx, ctx.orgId, app, a.groupId, -1);
    await writeAudit(ctx, {
      orgId: ctx.orgId,
      actor: ctx.actor,
      action: "app.unassigned",
      targetType: "app",
      targetId: a.appId,
      targetLabel: app?.name,
      summary: `Took the app ${app?.name ?? ""} away from the group ${group?.name ?? ""}`.replace(/\s+/g, " "),
    });
    if (group !== null) await snapshotGroupConfig(ctx, group._id, `Assignment of ${app?.name ?? "an app"}`, ctx.member._id);
    await requestPublish(ctx, ctx.orgId, { groupIds: [a.groupId] });
    return null;
  },
});