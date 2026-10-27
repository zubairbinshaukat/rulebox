import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { DatabaseReader } from "./_generated/server";
import { writeAudit } from "./lib/audit";
import { checkRevision, getInOrg, nextRevision } from "./lib/authz";
import { fail } from "./lib/errors";
import { memberMutation, memberQuery } from "./lib/functions";
import {
  GROUP_COUNT_CAP,
  MAX_GROUP_APPS,
  MAX_GROUP_CODES_CHECKED,
  MAX_GROUP_DESCRIPTION,
  MAX_GROUP_NAME,
  MAX_GROUPS_LISTED,
} from "./lib/limits";
import { assertWithinLimit, bumpOrgStats, bumpStats } from "./lib/plans";
import { appKind, audience } from "./lib/validators";

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

/** One group with its counts and assigned apps (viewer). Devices/employees lists come with Steps 7/11. */
export const get = memberQuery("viewer")({
  args: { groupId: v.string() },
  returns: v.object({
    group: groupRow,
    apps: v.array(
      v.object({
        appId: v.id("apps"),
        name: v.string(),
        kind: appKind,
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
        appId: app._id,
        name: app.name,
        kind: app.kind,
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
