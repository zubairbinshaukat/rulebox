import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { v, type Infer } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { env, type DatabaseReader } from "./_generated/server";
import { publishApp } from "./lib/appPublish";
import { writeAudit } from "./lib/audit";
import { checkRevision, getInOrg, nextRevision } from "./lib/authz";
import { normalizeAppDescription, normalizeAppName, normalizeDesktop, normalizeHue, normalizeWeb, withAppId, wingetIdProblem, wingetVersionProblem } from "./lib/appRules";
import { base64Decode, sha256HexOfBytes } from "./lib/crypto";
import { deepEqual } from "./lib/deepEqual";
import { programDenied } from "./lib/denyList";
import { fail } from "./lib/errors";
import { internalMutation, internalQuery, memberAction, memberMutation, memberQuery } from "./lib/functions";
import { checkPageSize, cleanSearch, countResult, orgStatsRow, pickSort, sortArg } from "./lib/listing";
import { webUrlProblem } from "./lib/hostRules";
import {
  APP_DENIAL_DAYS,
  APP_EMPLOYEE_COUNT_CAP,
  APP_PURGE_BATCH,
  DAY_MS,
  INSTALL_COUNT_CAP,
  MAX_APP_ASSIGNMENTS,
  MAX_APP_OPTIONS,
  MAX_APP_FILE_TYPES,
  MAX_APP_PAGE,
  MAX_GROUPS_JOINED,
  MAX_INSTALL_PAGE,
  MAX_PERMISSION_SNAPSHOT_GROUPS,
  WINGET_CACHE_MS,
} from "./lib/limits";
import { STORED_INSTALL_STATES } from "./lib/deviceApiRules";
import { assignedGroupsOf, failedFollowArchive } from "./lib/installs";
import { assertWithinLimit, bumpOrgStats, bumpStats } from "./lib/plans";
import { consumeOrFail } from "./lib/rateLimits";
import { audience, appKind, desktopSpec, installState, webPermissions, webSpec, wingetResolved } from "./lib/validators";
import { snapshotGroupConfig } from "./lib/groupConfig";
import { serverDay } from "./lib/lockdownReports";
import { iconDataUrl, fetchWebMeta as scanWebMeta, pngSize } from "./lib/webmeta";
import { resolveWinget as resolveFromGithub } from "./lib/winget";

// Apps (plan Step 10; 4.8). An app is a website or a Windows program an admin
// adds once and assigns to groups. Everything that decides what a device may
// run is validated HERE (`lib/appRules.ts`, `lib/pathRules.ts`); the dashboard
// mirrors the rules for inline messages. A change that alters what a device's
// document says calls `requestPublish` for the groups that carry the app, and
// only when something really changed (write only on change).
//
// `appCount` in `orgStats` counts NON-archived apps: archiving frees a plan
// slot, restoring takes one (and is refused at the limit).

/**
 * `apps:list` reads at most this many assignment rows per app (one more is read
 * to know there are more): a page of `MAX_APP_PAGE` apps reads at most
 * 50 x 11 = 550 rows. The screen shows "10+ groups" when `groupCountMore`.
 */
export const APP_LIST_GROUP_CAP = 10;

/** The eight permissions of PRD 24.1, in the order the dashboard shows them. */
const WEB_PERMISSION_KEYS = ["camera", "microphone", "screenShare", "clipboardRead", "notifications", "downloads", "printing", "geolocation"] as const;

const actorArg = v.object({ type: v.literal("member"), id: v.string(), label: v.string() });

/** The icon's address (stable while the file exists), or undefined. */
async function iconUrlOf(ctx: { storage: { getUrl(id: Id<"_storage">): Promise<string | null> } }, app: Doc<"apps">): Promise<string | undefined> {
  if (app.icon === undefined) return undefined;
  return (await ctx.storage.getUrl(app.icon.storageId)) ?? undefined;
}

// ---------------------------------------------------------------- reads

const appRow = v.object({
  _id: v.id("apps"),
  name: v.string(),
  description: v.optional(v.string()),
  kind: appKind,
  source: v.optional(desktopSpec.fields.source),
  hue: v.optional(v.number()),
  iconUrl: v.optional(v.string()),
  archived: v.boolean(),
  /** Groups that assign the app, at most `APP_LIST_GROUP_CAP`; `groupCountMore` = there are more ("10+"). */
  groupCount: v.number(),
  groupCountMore: v.boolean(),
  /** Install counts come with Step 17 (`apps:list` never reads `installResults`). */
  summary: v.null(),
});

/**
 * The organization's apps, archived or not (viewer; list contract in
 * lib/listing.ts). `sort` keys: "created" (default, newest first;
 * `apps.by_org_archived`) and "name" (`by_org_archived_name`), both
 * directions. `search`: name words (`apps.search_name`, filtered by org and
 * `archived`), relevance order, `sort` ignored. Per row: its group count (one
 * capped index read) and icon address. Never `installResults`.
 */
export const list = memberQuery("viewer")({
  args: { paginationOpts: paginationOptsValidator, archived: v.boolean(), search: v.optional(v.string()), sort: sortArg },
  returns: paginationResultValidator(appRow),
  handler: async (ctx, args) => {
    checkPageSize(args.paginationOpts.numItems, MAX_APP_PAGE);
    const sort = pickSort("apps", args.sort);
    const search = cleanSearch(args.search);
    const apps = ctx.db.query("apps");
    const result =
      search !== undefined
        ? await apps
            .withSearchIndex("search_name", (q) => q.search("name", search).eq("orgId", ctx.orgId).eq("archived", args.archived))
            .paginate(args.paginationOpts)
        : sort.key === "name"
          ? await apps
              .withIndex("by_org_archived_name", (q) => q.eq("orgId", ctx.orgId).eq("archived", args.archived))
              .order(sort.dir)
              .paginate(args.paginationOpts)
          : await apps
              .withIndex("by_org_archived", (q) => q.eq("orgId", ctx.orgId).eq("archived", args.archived))
              .order(sort.dir)
              .paginate(args.paginationOpts);
    const page = [];
    for (const a of result.page) {
      const groups = await ctx.db
        .query("appAssignments")
        .withIndex("by_app", (q) => q.eq("appId", a._id))
        .take(APP_LIST_GROUP_CAP + 1);
      page.push({
        _id: a._id,
        name: a.name,
        description: a.description,
        kind: a.kind,
        source: a.desktop?.source,
        hue: a.hue,
        iconUrl: await iconUrlOf(ctx, a),
        archived: a.archived,
        groupCount: Math.min(groups.length, APP_LIST_GROUP_CAP),
        groupCountMore: groups.length > APP_LIST_GROUP_CAP,
        summary: null,
      });
    }
    return { ...result, page };
  },
});

/**
 * The total for the apps table (viewer; lib/listing.ts): `appCount` from
 * `orgStats` only (it counts NON-archived apps), so exact for
 * `archived: false` without a search; `null` for the archived tab or a search.
 */
export const count = memberQuery("viewer")({
  args: { archived: v.boolean(), search: v.optional(v.string()) },
  returns: countResult,
  handler: async (ctx, args) => {
    if (args.archived || cleanSearch(args.search) !== undefined) return { total: null };
    const stats = await orgStatsRow(ctx);
    return { total: stats === null ? null : (stats.appCount ?? 0) };
  },
});

const assignmentRow = v.object({
  /** The `appAssignments` id (what `groups:updateAssignment` / `unassignApp` take). */
  _id: v.id("appAssignments"),
  appId: v.id("apps"),
  appName: v.string(),
  appKind: appKind,
  hue: v.optional(v.number()),
  audience,
  pinnedTaskbar: v.boolean(),
  pinnedDesktop: v.boolean(),
  groupId: v.id("groups"),
  groupName: v.string(),
});

/**
 * "Blocked in the last 30 days" for a web app (Phase 5 Step 11, plan 4.13): the organization's daily
 * security rows of the last `APP_DENIAL_DAYS` server days (`orgSecurityDaily.by_org_day`, `.take(30)`,
 * newest first), the app's rows summed per permission kind in memory. Only a count per (app, kind, day) is
 * ever stored: never a page, origin or employee. At most 30 documents; they change once a day (the rollup).
 */
async function denialsOf(ctx: { db: DatabaseReader; orgId: Id<"organizations"> }, app: Doc<"apps">): Promise<{ kind: string; count: number }[]> {
  if (app.kind !== "web") return [];
  const since = serverDay(Date.now() - (APP_DENIAL_DAYS - 1) * DAY_MS);
  const days = await ctx.db
    .query("orgSecurityDaily")
    .withIndex("by_org_day", (q) => q.eq("orgId", ctx.orgId).gte("day", since))
    .order("desc")
    .take(APP_DENIAL_DAYS);
  const sums = new Map<string, number>();
  for (const day of days) {
    for (const d of day.permissionDenials) {
      if (d.appId === app._id && d.count > 0) sums.set(d.kind, (sums.get(d.kind) ?? 0) + d.count);
    }
  }
  return [...sums.entries()].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count || (a.kind < b.kind ? -1 : 1));
}

/**
 * One app for its edit screen (viewer): the spec, its assignments with group
 * names, the file types it opens, the number of employees who have it directly
 * (`.take(1001)`: shown "1000+"), the group picker and, for a website, its
 * 30-day permission denial counts (`denials30d`). The install counts
 * (`apps:installSummary`) come with Step 17.
 */
export const get = memberQuery("viewer")({
  args: { appId: v.string() },
  returns: v.object({
    _id: v.id("apps"),
    name: v.string(),
    description: v.optional(v.string()),
    kind: appKind,
    hue: v.optional(v.number()),
    iconUrl: v.optional(v.string()),
    web: v.optional(webSpec),
    desktop: v.optional(desktopSpec),
    archived: v.boolean(),
    revision: v.number(),
    createdAt: v.number(),
    assignments: v.array(assignmentRow),
    fileTypes: v.array(v.string()),
    directEmployeeCount: v.number(),
    groupOptions: v.array(v.object({ _id: v.id("groups"), name: v.string() })),
    /** Blocked permission requests of the last 30 days, per kind, most first (web apps; empty for a program or no denials). */
    denials30d: v.array(v.object({ kind: v.string(), count: v.number() })),
  }),
  handler: async (ctx, args) => {
    const app = await getInOrg(ctx, "apps", args.appId, ctx.orgId);
    const assignments = await ctx.db
      .query("appAssignments")
      .withIndex("by_app", (q) => q.eq("appId", app._id))
      .take(MAX_APP_ASSIGNMENTS);
    const groups = await ctx.db
      .query("groups")
      .withIndex("by_org", (q) => q.eq("orgId", ctx.orgId))
      .take(MAX_GROUPS_JOINED);
    // Each assignment's group is read by id (bounded by the assignment cap), not looked up in the picker's
    // list: an organization with more groups than the picker holds still names every assignment.
    const rows = [];
    for (const a of assignments) {
      const group = await ctx.db.get(a.groupId);
      if (group === null || group.orgId !== ctx.orgId) continue; // a group of another organization never matches
      const groupName = group.name;
      rows.push({
        _id: a._id,
        appId: app._id,
        appName: app.name,
        appKind: app.kind,
        hue: app.hue,
        audience: a.audience,
        pinnedTaskbar: a.pinnedTaskbar,
        pinnedDesktop: a.pinnedDesktop,
        groupId: a.groupId,
        groupName,
      });
    }
    rows.sort((a, b) => a.groupName.localeCompare(b.groupName));
    const handlers = await ctx.db
      .query("fileHandlers")
      .withIndex("by_app", (q) => q.eq("appId", app._id))
      .take(MAX_APP_FILE_TYPES);
    const direct = await ctx.db
      .query("employeeApps")
      .withIndex("by_app", (q) => q.eq("appId", app._id))
      .take(APP_EMPLOYEE_COUNT_CAP + 1);
    return {
      denials30d: await denialsOf(ctx, app),
      _id: app._id,
      name: app.name,
      description: app.description,
      kind: app.kind,
      hue: app.hue,
      iconUrl: await iconUrlOf(ctx, app),
      web: app.web,
      desktop: app.desktop,
      archived: app.archived,
      revision: app.revision,
      createdAt: app.createdAt,
      assignments: rows,
      fileTypes: handlers.map((h) => h.extension).sort(),
      directEmployeeCount: direct.length,
      groupOptions: groups.map((g) => ({ _id: g._id, name: g.name })).sort((a, b) => a.name.localeCompare(b.name)),
    };
  },
});

// ---------------------------------------------------------------- install status (plan Step 17 items 1-2)

const INSTALL_STATES = installState.members.map((m) => m.value);

/**
 * How many PCs are in each install state for one app (viewer). Only results
 * that COUNT (lib/installs.ts): tagged with a group that still assigns the app;
 * an archived app has none. Per state `installResults.by_app_state_updated`
 * `.take(INSTALL_COUNT_CAP + 1)` (no join: the tag is on the row), so a count
 * is at most 1,001 and the screen shows "1000+" above 1,000. `capped` (added
 * in the Step 17 review): some state had more rows than were read, so its
 * count may be low when many of those rows are stale. A query of its own: the
 * results change with every PC's report, so `apps:get` must not carry them.
 * Decision (Step 17 review, finding 4): kept as a bounded read rather than a
 * per-(app, state) counter, which every move / revoke / assign / archive would
 * have to keep exact.
 */
export const installSummary = memberQuery("viewer")({
  args: { appId: v.string() },
  returns: v.object({
    pending: v.number(),
    downloading: v.number(),
    installing: v.number(),
    installed: v.number(),
    failed: v.number(),
    removing: v.number(),
    removed: v.number(),
    unsupported: v.number(),
    capped: v.optional(v.boolean()),
  }),
  handler: async (ctx, args) => {
    const app = await getInOrg(ctx, "apps", args.appId, ctx.orgId);
    const counts: Record<(typeof INSTALL_STATES)[number], number> = {
      pending: 0,
      downloading: 0,
      installing: 0,
      installed: 0,
      failed: 0,
      removing: 0,
      removed: 0,
      unsupported: 0,
    };
    if (app.archived) return counts;
    const groups = await assignedGroupsOf(ctx, app._id);
    if (groups.size === 0) return counts;
    let capped = false;
    for (const state of INSTALL_STATES) {
      // The passing states are never stored (deviceApi:report ignores them): no read.
      if (!STORED_INSTALL_STATES.has(state)) continue;
      const rows = await ctx.db
        .query("installResults")
        .withIndex("by_app_state_updated", (q) => q.eq("appId", app._id).eq("state", state))
        .take(INSTALL_COUNT_CAP + 1);
      if (rows.length > INSTALL_COUNT_CAP) capped = true;
      counts[state] = rows.filter((r) => r.groupId !== undefined && groups.has(r.groupId)).length;
    }
    return capped ? { ...counts, capped } : counts;
  },
});

/**
 * The PCs that are in one install `state` for an app (viewer, paginated by
 * `installResults.by_app_state_updated`, newest `updatedAt` first; `sort` key
 * "updated" either way, lib/listing.ts), each with
 * its name. Only results that count (lib/installs.ts; none for an archived
 * app): a page may hold fewer rows than asked for. A PC that was removed since
 * (its results are purged in batches) is left out.
 */
export const installs = memberQuery("viewer")({
  args: { appId: v.string(), state: installState, paginationOpts: paginationOptsValidator, sort: sortArg },
  returns: paginationResultValidator(
    v.object({
      _id: v.id("installResults"),
      deviceId: v.id("devices"),
      deviceName: v.string(),
      state: installState,
      attempts: v.number(),
      exitCode: v.optional(v.number()),
      detail: v.optional(v.string()),
      updatedAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    checkPageSize(args.paginationOpts.numItems, MAX_INSTALL_PAGE);
    const sort = pickSort("installs", args.sort);
    const app = await getInOrg(ctx, "apps", args.appId, ctx.orgId);
    const result = await ctx.db
      .query("installResults")
      .withIndex("by_app_state_updated", (q) => q.eq("appId", app._id).eq("state", args.state))
      .order(sort.dir)
      .paginate(args.paginationOpts);
    const groups = app.archived ? new Set<Id<"groups">>() : await assignedGroupsOf(ctx, app._id);
    const page = [];
    for (const r of result.page) {
      if (r.groupId === undefined || !groups.has(r.groupId)) continue;
      const device = await ctx.db.get(r.deviceId);
      if (device === null) continue;
      page.push({
        _id: r._id,
        deviceId: r.deviceId,
        deviceName: device.name,
        state: r.state,
        attempts: r.attempts,
        exitCode: r.exitCode,
        detail: r.detail,
        updatedAt: r.updatedAt,
      });
    }
    return { ...result, page };
  },
});

/**
 * The apps a group may be given (viewer): non-archived, by name, up to 500
 * (the picker of the group page; subscribed only while its dialog is open).
 */
export const options = memberQuery("viewer")({
  args: {},
  returns: v.array(v.object({ _id: v.id("apps"), name: v.string(), kind: appKind, canOpenFiles: v.boolean() })),
  handler: async (ctx) => {
    const apps = await ctx.db
      .query("apps")
      .withIndex("by_org_archived", (q) => q.eq("orgId", ctx.orgId).eq("archived", false))
      .take(MAX_APP_OPTIONS);
    return apps
      .map((a) => ({ _id: a._id, name: a.name, kind: a.kind, canOpenFiles: a.kind === "desktop" && (a.desktop?.fileArgTemplate.length ?? 0) > 0 && !programDenied(a.desktop?.exe ?? "") }))
      .sort((a, b) => a.name.localeCompare(b.name));
  },
});

// ---------------------------------------------------------------- create / update

const webInput = {
  name: v.string(),
  description: v.optional(v.string()),
  hue: v.optional(v.number()),
  url: v.string(),
  allowedDomains: v.array(v.string()),
};

/**
 * Add a website (admin). `invalid_argument` names the field (`url`,
 * `allowedDomains`, `name`...); `plan_limit` (detail "apps") at the plan's
 * `maxApps`. Permissions start at the PRD 24.1 defaults with printing allowed
 * (`NEW_WEB_APP_PERMISSIONS`); `apps:setPermissions` changes them.
 */
export const createWeb = memberMutation("admin")({
  args: webInput,
  returns: v.id("apps"),
  handler: async (ctx, args) => {
    const name = normalizeAppName(args.name);
    const description = normalizeAppDescription(args.description);
    const hue = normalizeHue(args.hue);
    const web = normalizeWeb(args.url, args.allowedDomains);
    const stats = await assertWithinLimit(ctx, ctx.orgId, "apps");
    const appId = await ctx.db.insert("apps", {
      orgId: ctx.orgId,
      name,
      description,
      kind: "web",
      hue,
      web,
      archived: false,
      revision: 0,
      createdAt: Date.now(),
    });
    await bumpStats(ctx, stats, { appCount: 1 });
    await writeAudit(ctx, {
      orgId: ctx.orgId,
      actor: ctx.actor,
      action: "app.created",
      targetType: "app",
      targetId: appId,
      targetLabel: name,
      summary: `Added the website ${name}`,
    });
    return appId;
  },
});

/**
 * Add a Windows program (admin). The program's path, arguments, install
 * source (SHA-256 and https URL), file argument and cleanup folders are
 * checked by `lib/appRules.ts`. A portable app's `{AppId}` in its path is
 * replaced by the new id inside this transaction.
 */
export const createDesktop = memberMutation("admin")({
  args: { name: v.string(), description: v.optional(v.string()), hue: v.optional(v.number()), desktop: desktopSpec },
  returns: v.id("apps"),
  handler: async (ctx, args) => {
    const name = normalizeAppName(args.name);
    const description = normalizeAppDescription(args.description);
    const hue = normalizeHue(args.hue);
    const desktop = normalizeDesktop(args.desktop);
    const stats = await assertWithinLimit(ctx, ctx.orgId, "apps");
    const appId = await ctx.db.insert("apps", {
      orgId: ctx.orgId,
      name,
      description,
      kind: "desktop",
      hue,
      desktop,
      archived: false,
      revision: 0,
      createdAt: Date.now(),
    });
    // The id is known now: a portable app's folder is `{RuleboxApps}\<id>\` (re-checked with the real id).
    if (desktop.exe.includes("{AppId}")) {
      await ctx.db.patch(appId, { desktop: normalizeDesktop(withAppId(desktop, appId), appId) });
    }
    await bumpStats(ctx, stats, { appCount: 1 });
    await writeAudit(ctx, {
      orgId: ctx.orgId,
      actor: ctx.actor,
      action: "app.created",
      targetType: "app",
      targetId: appId,
      targetLabel: name,
      summary: `Added the Windows program ${name}`,
    });
    return appId;
  },
});

/**
 * Change an app (admin): pass `web` for a website, `desktop` for a program
 * (the kind never changes). `stale_edit` when someone saved in between.
 * Nothing changed = no write, no new revision, no publish. A change bumps the
 * revision (the agent retries a failed install on a new revision) and
 * republishes the groups that carry the app.
 */
export const update = memberMutation("admin")({
  args: {
    appId: v.string(),
    expectedRevision: v.number(),
    web: v.optional(v.object(webInput)),
    desktop: v.optional(v.object({ name: v.string(), description: v.optional(v.string()), hue: v.optional(v.number()), desktop: desktopSpec })),
  },
  returns: v.object({ revision: v.number() }),
  handler: async (ctx, args) => {
    const app = await getInOrg(ctx, "apps", args.appId, ctx.orgId);
    checkRevision(app, args.expectedRevision);
    if ((args.web === undefined) === (args.desktop === undefined)) fail("invalid_argument", { field: "kind" });
    if (args.web !== undefined && app.kind !== "web") fail("invalid_argument", { field: "kind" });
    if (args.desktop !== undefined && app.kind !== "desktop") fail("invalid_argument", { field: "kind" });

    const input = args.web ?? args.desktop!;
    const fields: Pick<Doc<"apps">, "name" | "description" | "hue" | "web" | "desktop"> = {
      name: normalizeAppName(input.name),
      description: normalizeAppDescription(input.description),
      hue: normalizeHue(input.hue),
      web: args.web !== undefined ? normalizeWeb(args.web.url, args.web.allowedDomains, app.web?.permissions) : undefined,
      desktop: args.desktop !== undefined ? normalizeDesktop(args.desktop.desktop, app._id) : undefined,
    };
    if (deepEqual(fields, { name: app.name, description: app.description, hue: app.hue, web: app.web, desktop: app.desktop })) {
      return { revision: app.revision };
    }
    // A program that can no longer open files cannot be the target of a file-type rule.
    if (app.kind === "desktop" && fields.desktop!.fileArgTemplate.length === 0 && (app.desktop?.fileArgTemplate.length ?? 0) > 0) {
      const rule = await ctx.db
        .query("fileHandlers")
        .withIndex("by_app", (q) => q.eq("appId", app._id))
        .first();
      if (rule !== null) fail("has_dependents", { detail: "file types" });
    }
    const revision = nextRevision(app);
    await ctx.db.patch(app._id, { ...fields, revision });
    await writeAudit(ctx, {
      orgId: ctx.orgId,
      actor: ctx.actor,
      action: "app.updated",
      targetType: "app",
      targetId: app._id,
      targetLabel: fields.name,
      summary: `Changed the app ${fields.name}`,
    });
    await publishApp(ctx, ctx.orgId, app._id);
    return { revision };
  },
});

/**
 * Change a website's eight permissions (admin; plan 4.13, PRD 24.1). `stale_edit` when someone saved in
 * between (`expectedRevision`); `invalid_argument` (field "appId") for a program. The same permissions
 * again = no write, no new revision, no publish. A change bumps the revision, audits
 * `app.permissionsChanged` (the summary names the permissions that changed, nothing else), snapshots the
 * configuration of the groups that assign the app (`snapshotGroupConfig`, at most
 * `MAX_PERMISSION_SNAPSHOT_GROUPS`) and republishes every group that carries the app (`publishApp`): the app
 * record is still read live by the publisher, so the publish is what puts the change in the documents.
 */
export const setPermissions = memberMutation("admin")({
  args: { appId: v.string(), permissions: webPermissions, expectedRevision: v.number() },
  returns: v.object({ revision: v.number() }),
  handler: async (ctx, args) => {
    const app = await getInOrg(ctx, "apps", args.appId, ctx.orgId);
    checkRevision(app, args.expectedRevision);
    if (app.kind !== "web" || app.web === undefined) fail("invalid_argument", { field: "appId" });
    const before = app.web.permissions;
    const changed = WEB_PERMISSION_KEYS.filter((k) => before[k] !== args.permissions[k]);
    if (changed.length === 0) return { revision: app.revision };

    const revision = nextRevision(app);
    await ctx.db.patch(app._id, { web: { ...app.web, permissions: { ...args.permissions } }, revision });
    await writeAudit(ctx, {
      orgId: ctx.orgId,
      actor: ctx.actor,
      action: "app.permissionsChanged",
      targetType: "app",
      targetId: app._id,
      targetLabel: app.name,
      summary: `Changed permissions of ${app.name}: ${changed.map((k) => `${k} ${args.permissions[k] ? "allowed" : "blocked"}`).join(", ")}`,
    });
    const assigned = await ctx.db
      .query("appAssignments")
      .withIndex("by_app", (q) => q.eq("appId", app._id))
      .take(MAX_PERMISSION_SNAPSHOT_GROUPS + 1);
    for (const a of assigned.slice(0, MAX_PERMISSION_SNAPSHOT_GROUPS)) {
      await snapshotGroupConfig(ctx, a.groupId, `Permissions of ${app.name}`, ctx.member._id);
    }
    await publishApp(ctx, ctx.orgId, app._id);
    return { revision };
  },
});

/**
 * Archive or restore an app (admin). An archived app disappears from every
 * device's document at once (and frees a plan slot); restoring needs a free
 * slot (`plan_limit`). Already in that state = no write.
 */
export const setArchived = memberMutation("admin")({
  args: { appId: v.string(), archived: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const app = await getInOrg(ctx, "apps", args.appId, ctx.orgId);
    if (app.archived === args.archived) return null;
    const stats = args.archived ? null : await assertWithinLimit(ctx, ctx.orgId, "apps");
    await ctx.db.patch(app._id, { archived: args.archived, revision: nextRevision(app) });
    if (stats !== null) await bumpStats(ctx, stats, { appCount: 1 });
    else await bumpOrgStats(ctx, ctx.orgId, { appCount: -1 });
    // An archived app's failed results stop counting; restoring brings them back (Step 17 review).
    await failedFollowArchive(ctx, ctx.orgId, app._id, args.archived ? -1 : 1);
    await writeAudit(ctx, {
      orgId: ctx.orgId,
      actor: ctx.actor,
      action: args.archived ? "app.archived" : "app.updated",
      targetType: "app",
      targetId: app._id,
      targetLabel: app.name,
      summary: args.archived ? `Archived the app ${app.name}` : `Restored the app ${app.name} from the archive`,
    });
    await publishApp(ctx, ctx.orgId, app._id);
    return null;
  },
});

/**
 * Delete an archived app (admin, major: fresh step-up). `has_dependents`
 * while a group still assigns it or a file type points at it; `invalid_argument`
 * (field "archived") when it is not archived. The install results and direct
 * employee grants are deleted in batches by `purgeApp`; the icon file goes now.
 */
export const remove = memberMutation("admin", { major: "apps:remove" })({
  args: { appId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const app = await getInOrg(ctx, "apps", args.appId, ctx.orgId);
    if (!app.archived) fail("invalid_argument", { field: "archived" });
    const dependents: string[] = [];
    const assigned = await ctx.db
      .query("appAssignments")
      .withIndex("by_app", (q) => q.eq("appId", app._id))
      .first();
    if (assigned !== null) dependents.push("groups");
    const rule = await ctx.db
      .query("fileHandlers")
      .withIndex("by_app", (q) => q.eq("appId", app._id))
      .first();
    if (rule !== null) dependents.push("file types");
    if (dependents.length > 0) fail("has_dependents", { detail: dependents.join(", ") });

    if (app.icon !== undefined) await ctx.storage.delete(app.icon.storageId);
    await ctx.db.delete(app._id);
    // Archived apps are not counted (archiving freed the slot): no counter change here.
    await ctx.scheduler.runAfter(0, internal.apps.purgeApp, { appId: app._id });
    await writeAudit(ctx, {
      orgId: ctx.orgId,
      actor: ctx.actor,
      action: "app.deleted",
      targetType: "app",
      targetId: app._id,
      targetLabel: app.name,
      summary: `Deleted the app ${app.name}`,
    });
    return null;
  },
});

/** Batches of a deleted app's install results and direct employee grants (reschedules while full). */
export const purgeApp = internalMutation({
  args: { appId: v.id("apps") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const installs = await ctx.db
      .query("installResults")
      .withIndex("by_app_state_updated", (q) => q.eq("appId", args.appId))
      .take(APP_PURGE_BATCH);
    const grants = await ctx.db
      .query("employeeApps")
      .withIndex("by_app", (q) => q.eq("appId", args.appId))
      .take(APP_PURGE_BATCH);
    // `failedInstallCount` does not move: only an archived app can be deleted, and archiving
    // already took its failed results out of the count (lib/installs.ts).
    for (const row of installs) await ctx.db.delete(row._id);
    for (const row of grants) await ctx.db.delete(row._id);
    if (installs.length === APP_PURGE_BATCH || grants.length === APP_PURGE_BATCH) {
      await ctx.scheduler.runAfter(0, internal.apps.purgeApp, { appId: args.appId });
    }
    return null;
  },
});

/**
 * Ask the agents to try a failed install again (admin): bumps the app's
 * revision (the agent's attempt counter resets on a new revision) and
 * republishes. Desktop apps with an install source only.
 */
export const retry = memberMutation("admin")({
  args: { appId: v.string() },
  returns: v.object({ revision: v.number() }),
  handler: async (ctx, args) => {
    const app = await getInOrg(ctx, "apps", args.appId, ctx.orgId);
    if (app.kind !== "desktop" || app.desktop?.install === undefined || app.archived) fail("invalid_argument", { field: "appId" });
    const revision = nextRevision(app);
    await ctx.db.patch(app._id, { revision });
    await writeAudit(ctx, {
      orgId: ctx.orgId,
      actor: ctx.actor,
      action: "app.retryRequested",
      targetType: "app",
      targetId: app._id,
      targetLabel: app.name,
      summary: `Asked the PCs to retry installing ${app.name}`,
    });
    await publishApp(ctx, ctx.orgId, app._id);
    return { revision };
  },
});

// ---------------------------------------------------------------- icon

/**
 * Store the icon `fetchWebMeta` previewed (admin). `png` is the base64 of a
 * PNG of at most 32 KiB and 512 x 512 pixels: anything else is
 * `invalid_argument`. The bytes are re-checked here (the client is not
 * trusted), hashed, put in file storage and recorded on the app with their
 * SHA-256, which the document carries so the Staff App can verify the file.
 * Replaces and deletes an earlier icon. `not_found` for another organization's app
 * (checked before the file is stored); shares the `webMeta` rate limit.
 */
export const saveIcon = memberAction("admin")({
  args: { appId: v.string(), png: v.string() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    // Cheapest checks first: the app must be this organization's (before any file is stored), and the
    // call shares the metadata rate limit (it is the second half of "Fetch details").
    await ctx.runQuery(internal.apps.iconTarget, { orgId: ctx.orgId, appId: args.appId });
    await consumeOrFail(ctx, "webMeta", ctx.orgId);
    // The preview is a `data:` URL; accept it whole or just its base64 part.
    const bytes = base64Decode(args.png.replace(/^data:image\/png;base64,/, ""));
    if (bytes === null || pngSize(bytes) === null) fail("invalid_argument", { field: "png" });
    const storageId = await ctx.storage.store(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "image/png" }));
    try {
      await ctx.runMutation(internal.apps.attachIcon, {
        orgId: ctx.orgId,
        actor: ctx.actor,
        appId: args.appId,
        storageId,
        sha256: sha256HexOfBytes(bytes),
        sizeBytes: bytes.length,
      });
    } catch (e) {
      await ctx.storage.delete(storageId); // no orphan file when the app is not this organization's
      throw e;
    }
    return null;
  },
});

/** `not_found` unless `appId` is an app of `orgId` (so `saveIcon` stores nothing for a foreign id). */
export const iconTarget = internalQuery({
  args: { orgId: v.id("organizations"), appId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await getInOrg(ctx, "apps", args.appId, args.orgId);
    return null;
  },
});

/** The single writer of `apps.icon`. */
export const attachIcon = internalMutation({
  args: {
    orgId: v.id("organizations"),
    actor: actorArg,
    appId: v.string(),
    storageId: v.id("_storage"),
    sha256: v.string(),
    sizeBytes: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const app = await getInOrg(ctx, "apps", args.appId, args.orgId);
    if (!/^[0-9a-f]{64}$/.test(args.sha256)) fail("invalid_argument", { field: "png" });
    if (app.icon?.sha256 === args.sha256) {
      await ctx.storage.delete(args.storageId); // the same icon again: keep the stored one, write nothing
      return null;
    }
    if (app.icon !== undefined) await ctx.storage.delete(app.icon.storageId);
    await ctx.db.patch(app._id, { icon: { storageId: args.storageId, sha256: args.sha256, sizeBytes: args.sizeBytes } });
    await writeAudit(ctx, {
      orgId: args.orgId,
      actor: args.actor,
      action: "app.updated",
      targetType: "app",
      targetId: app._id,
      targetLabel: app.name,
      summary: `Changed the icon of ${app.name}`,
    });
    await publishApp(ctx, args.orgId, app._id);
    return null;
  },
});

// ---------------------------------------------------------------- web metadata

/**
 * "Fetch details" (admin): reads the web app manifest of `url` and answers its
 * name, a hue from `theme_color` and an icon preview (`data:` URL of a PNG up
 * to 32 KiB). Stores nothing. `webmeta_failed` when the page cannot be read;
 * `invalid_argument` (field "url") for an address no web app may have.
 */
export const fetchWebMeta = memberAction("admin")({
  args: { url: v.string() },
  returns: v.object({ name: v.optional(v.string()), hue: v.optional(v.number()), iconPreviewUrl: v.optional(v.string()) }),
  handler: async (ctx, args): Promise<{ name?: string; hue?: number; iconPreviewUrl?: string }> => {
    if (webUrlProblem(args.url) !== null) fail("invalid_argument", { field: "url" });
    await consumeOrFail(ctx, "webMeta", ctx.orgId);
    const meta = await scanWebMeta(args.url.trim());
    return {
      ...(meta.name !== undefined ? { name: meta.name } : {}),
      ...(meta.hue !== undefined ? { hue: meta.hue } : {}),
      ...(meta.iconPng !== undefined ? { iconPreviewUrl: iconDataUrl(meta.iconPng) } : {}),
    };
  },
});

// ---------------------------------------------------------------- winget

/** A cached resolution younger than 24 hours (4.8), or null. `version` "" = "latest". */
export const cachedWinget = internalQuery({
  args: { packageId: v.string(), version: v.string(), now: v.number() },
  returns: v.union(wingetResolved, v.null()),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("wingetCache")
      .withIndex("by_package_version", (q) => q.eq("packageId", args.packageId).eq("version", args.version))
      .first();
    return row !== null && args.now - row.fetchedAt < WINGET_CACHE_MS ? row.resolved : null;
  },
});

export const storeWinget = internalMutation({
  args: { packageId: v.string(), version: v.string(), resolved: wingetResolved, now: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("wingetCache")
      .withIndex("by_package_version", (q) => q.eq("packageId", args.packageId).eq("version", args.version))
      .first();
    const fields = { packageId: args.packageId, version: args.version, resolved: args.resolved, fetchedAt: args.now };
    if (existing === null) await ctx.db.insert("wingetCache", fields);
    else await ctx.db.patch(existing._id, fields);
    return null;
  },
});

/**
 * "Resolve" a winget package (admin): reads the public manifest from the
 * winget-pkgs repository (never runs winget) and answers the install spec the
 * form fills in. `version` empty = the newest. Cached 24 hours.
 * `winget_unreachable` (GitHub unreachable or rate limited; set `GITHUB_TOKEN`
 * to raise the limit), `winget_unsupported` with the reason.
 */
export const resolveWinget = memberAction("admin")({
  args: { packageId: v.string(), version: v.optional(v.string()) },
  returns: wingetResolved,
  handler: async (ctx, args): Promise<Infer<typeof wingetResolved>> => {
    const packageId = args.packageId.trim();
    const version = args.version?.trim() === "" ? undefined : args.version?.trim();
    if (wingetIdProblem(packageId)) fail("invalid_argument", { field: "packageId" });
    if (version !== undefined && wingetVersionProblem(version)) fail("invalid_argument", { field: "version" });
    const cached = await ctx.runQuery(internal.apps.cachedWinget, { packageId, version: version ?? "", now: Date.now() });
    if (cached !== null) return cached;
    await consumeOrFail(ctx, "wingetResolve", ctx.orgId);
    const resolved = await resolveFromGithub(packageId, version, { githubToken: env.GITHUB_TOKEN });
    await ctx.runMutation(internal.apps.storeWinget, { packageId, version: version ?? "", resolved, now: Date.now() });
    return resolved;
  },
});
