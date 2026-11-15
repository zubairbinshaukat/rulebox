import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { DatabaseReader } from "./_generated/server";
import { writeAudit } from "./lib/audit";
import { getInOrg } from "./lib/authz";
import { deepEqual } from "./lib/deepEqual";
import { fail } from "./lib/errors";
import { memberMutation, memberQuery } from "./lib/functions";
import { newSnapshotCache, snapshotGroupConfig } from "./lib/groupConfig";
import {
  MAX_ALLOW_APPS,
  MAX_ALLOW_GROUPS,
  MAX_EXCEPTION_REASON,
  MAX_EXCEPTIONS_LISTED,
  MAX_FINDINGS_PAGE,
  MAX_GROUP_EXCEPTIONS,
  MAX_GROUPS_JOINED,
  MAX_LOCKOUT_MINUTES,
  MAX_LOCKOUT_THRESHOLD,
  MAX_WIFI_PROFILES,
  MIN_LOCKOUT_THRESHOLD,
  OPEN_FINDINGS_CAP,
} from "./lib/limits";
import { checkPageSize, pickSort, sortArg } from "./lib/listing";
import {
  DEFAULT_LOCKDOWN_SETTINGS,
  findingLayer,
  findingStatus,
  lockdownSettings,
  type ExceptionRuleValue,
  type LockdownSettings,
} from "./lib/lockdownValidators";
import { exePathProblem } from "./lib/pathRules";
import { requireStepUp } from "./lib/stepUp";

// The lockdown screens (Phase 5 Step 19, plan 4.20): a group's lockdown settings, the findings review ("would be blocked") and the
// exceptions an admin makes from a finding. Devices never call these; they report through `deviceApi.ts`.
//
// I/O (rows in `ioBudgets.ts`):
// - `groupView` is one small query: the group, its settings row, the newest MAX_EXCEPTIONS_LISTED exceptions and at most
//   OPEN_FINDINGS_CAP + 1 open findings for the "N new" link. It re-runs when one of those changes, never on a device report
//   other than a NEW finding.
// - `findings` is one page of `lockdownFindings.by_org_status_seen` (index + cursor); `lockdownFindingDevices` is never read here.
// - Every write that changes what PCs get takes a new group configuration version in the same transaction (`snapshotGroupConfig`,
//   which also asks for the publish), so an "Allow" may name at most MAX_ALLOW_GROUPS groups.
//
// Rule 6 holds on this side too: nothing here stores or returns a full path, a command line or a window title. A path exception is a
// TEMPLATE under an admin-only root (`{ProgramFiles}`, `{ProgramFilesX86}`, `{RuleboxApps}`) typed by the admin.

const LAYERS = ["appLocker", "appControl", "procWatch"] as const;

const ruleView = v.object({
  kind: v.union(v.literal("publisher"), v.literal("hash"), v.literal("path")),
  /** Publisher rule: the signer; with the product and file name it was made for. */
  subject: v.union(v.string(), v.null()),
  product: v.union(v.string(), v.null()),
  fileName: v.union(v.string(), v.null()),
  /** Hash rule: the first 12 characters of the SHA-256 (enough to tell two rules apart). */
  hashStart: v.union(v.string(), v.null()),
  /** Path rule: the template. */
  path: v.union(v.string(), v.null()),
});

const exceptionView = v.object({
  _id: v.id("lockdownExceptions"),
  rule: ruleView,
  appName: v.union(v.string(), v.null()),
  reason: v.string(),
  createdAt: v.number(),
});

function ruleViewOf(r: ExceptionRuleValue) {
  return {
    kind: r.kind,
    subject: r.publisher?.subject ?? null,
    product: r.publisher?.product ?? null,
    fileName: r.publisher?.fileName ?? null,
    hashStart: r.sha256 === undefined ? null : r.sha256.slice(0, 12),
    path: r.path ?? null,
  };
}

async function lockdownRow(ctx: { db: DatabaseReader }, groupId: Id<"groups">): Promise<Doc<"groupLockdown"> | null> {
  return await ctx.db
    .query("groupLockdown")
    .withIndex("by_group", (q) => q.eq("groupId", groupId))
    .unique();
}

/** What the group's PCs get today: its saved settings, else the organization's new-group defaults, else the built-in defaults. */
async function settingsOf(ctx: { db: DatabaseReader }, orgId: Id<"organizations">, row: Doc<"groupLockdown"> | null): Promise<LockdownSettings> {
  if (row !== null) return row.settings;
  const org = await ctx.db.get(orgId);
  return org?.phase5Settings?.newGroupDefaults ?? DEFAULT_LOCKDOWN_SETTINGS;
}

/**
 * The group lockdown screen (viewer): the settings (the defaults while the group never saved any; `revision` 0 then), the newest
 * exceptions of the group, and how many findings are still open in the organization (`openFindingsMore`: more than the cap).
 */
export const groupView = memberQuery("viewer")({
  args: { groupId: v.string() },
  returns: v.object({
    groupName: v.string(),
    settings: lockdownSettings,
    revision: v.number(),
    /** When the program rules first went into audit mode; null when none is in audit or the group never saved. */
    auditSince: v.union(v.number(), v.null()),
    exceptions: v.array(exceptionView),
    exceptionsTruncated: v.boolean(),
    openFindings: v.number(),
    openFindingsMore: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const group = await getInOrg(ctx, "groups", args.groupId, ctx.orgId);
    const row = await lockdownRow(ctx, group._id);
    const rows = await ctx.db
      .query("lockdownExceptions")
      .withIndex("by_org_group", (q) => q.eq("orgId", ctx.orgId).eq("groupId", group._id))
      .order("desc")
      .take(MAX_EXCEPTIONS_LISTED + 1);
    const appNames = new Map<string, string | null>();
    const exceptions = [];
    for (const e of rows.slice(0, MAX_EXCEPTIONS_LISTED)) {
      let appName: string | null = null;
      if (e.appId !== undefined) {
        if (!appNames.has(e.appId)) appNames.set(e.appId, (await ctx.db.get(e.appId))?.name ?? null);
        appName = appNames.get(e.appId) ?? null;
      }
      exceptions.push({ _id: e._id, rule: ruleViewOf(e.rule), appName, reason: e.reason, createdAt: e.createdAt });
    }
    const open = await ctx.db
      .query("lockdownFindings")
      .withIndex("by_org_status_seen", (q) => q.eq("orgId", ctx.orgId).eq("status", "new"))
      .take(OPEN_FINDINGS_CAP + 1);
    return {
      groupName: group.name,
      settings: await settingsOf(ctx, ctx.orgId, row),
      revision: row?.revision ?? 0,
      auditSince: row?.auditSince ?? null,
      exceptions,
      exceptionsTruncated: rows.length > MAX_EXCEPTIONS_LISTED,
      openFindings: Math.min(open.length, OPEN_FINDINGS_CAP),
      openFindingsMore: open.length > OPEN_FINDINGS_CAP,
    };
  },
});

function checkSettings(s: LockdownSettings): void {
  const l = s.machine.accountLockout;
  if (l !== null) {
    const whole = (n: number, min: number, max: number) => Number.isInteger(n) && n >= min && n <= max;
    if (!whole(l.threshold, MIN_LOCKOUT_THRESHOLD, MAX_LOCKOUT_THRESHOLD)) fail("invalid_argument", { field: "accountLockout.threshold" });
    if (!whole(l.durationMin, 1, MAX_LOCKOUT_MINUTES)) fail("invalid_argument", { field: "accountLockout.durationMin" });
    // The agent refuses a counting window longer than the lockout itself (`lockout_window_too_long`).
    if (!whole(l.windowMin, 1, l.durationMin)) fail("invalid_argument", { field: "accountLockout.windowMin" });
  }
}

/** True when a program rule changes mode, or App Control changes level: the changes that need a fresh step-up. */
function modesChanged(a: LockdownSettings, b: LockdownSettings): boolean {
  return LAYERS.some((k) => a[k].mode !== b[k].mode) || a.appControl.level !== b.appControl.level;
}

const anyAudit = (s: LockdownSettings): boolean => LAYERS.some((k) => s[k].mode === "audit");

/**
 * Save a group's lockdown settings (admin; `expectedRevision` of the settings row, 0 while the group has none: `stale_edit`).
 * Changing a program rule's mode (off / audit / enforce) or the App Control level is a MAJOR action (fresh step-up, `MAJOR_ACTIONS`);
 * the other switches need an unlocked session. Refused: an account-lockout threshold under 5 or a counting window longer than the
 * lockout (`invalid_argument`); "managed networks only" while the group has no Wi-Fi network (`conflict`, detail
 * `managed_networks_empty`). Nothing changed = no write. A change takes a new group configuration version (ring-gated) and audits
 * `lockdown.layerModeChanged` and / or `lockdown.settingsChanged`.
 */
export const update = memberMutation("admin")({
  args: { groupId: v.string(), settings: lockdownSettings, expectedRevision: v.number() },
  returns: v.object({ revision: v.number() }),
  handler: async (ctx, args) => {
    const group = await getInOrg(ctx, "groups", args.groupId, ctx.orgId);
    const row = await lockdownRow(ctx, group._id);
    if ((row?.revision ?? 0) !== args.expectedRevision) fail("stale_edit");
    checkSettings(args.settings);
    const current = await settingsOf(ctx, ctx.orgId, row);
    if (deepEqual(current, args.settings)) return { revision: row?.revision ?? 0 };

    const modes = modesChanged(current, args.settings);
    if (modes) await requireStepUp(ctx, "fresh");
    if (args.settings.wifiManagedOnly && !current.wifiManagedOnly) {
      const wifi = await ctx.db
        .query("wifiProfiles")
        .withIndex("by_org", (q) => q.eq("orgId", ctx.orgId))
        .take(MAX_WIFI_PROFILES + 1);
      if (!wifi.some((w) => (w.groupIds as string[]).includes(group._id))) fail("conflict", { detail: "managed_networks_empty" });
    }

    const now = Date.now();
    // The audit clock keeps running while at least one program rule stays in audit; it starts when the first one enters.
    const auditSince = anyAudit(args.settings) ? (row?.auditSince ?? now) : undefined;
    const revision = (row?.revision ?? 0) + 1;
    if (row === null) await ctx.db.insert("groupLockdown", { orgId: ctx.orgId, groupId: group._id, settings: args.settings, revision, auditSince });
    else await ctx.db.patch(row._id, { settings: args.settings, revision, auditSince });
    await snapshotGroupConfig(ctx, group._id, "Lockdown settings changed", ctx.member._id);

    const base = { orgId: ctx.orgId, actor: ctx.actor, targetType: "group", targetId: group._id, targetLabel: group.name };
    if (modes) {
      const s = args.settings;
      await writeAudit(ctx, {
        ...base,
        action: "lockdown.layerModeChanged",
        summary: `Changed the program rules of the group ${group.name} (AppLocker ${s.appLocker.mode}, App Control ${s.appControl.mode}, process watch ${s.procWatch.mode})`,
      });
    }
    const others = (s: LockdownSettings) => ({ ...s, appLocker: null, appControl: null, procWatch: null });
    if (!deepEqual(others(args.settings), others(current))) {
      await writeAudit(ctx, { ...base, action: "lockdown.settingsChanged", summary: `Changed the lockdown settings of the group ${group.name}` });
    }
    return { revision };
  },
});

// ---------------------------------------------------------------- findings

const findingRow = v.object({
  _id: v.id("lockdownFindings"),
  layer: findingLayer,
  fileName: v.string(),
  folderClass: v.string(),
  signer: v.union(v.string(), v.null()),
  product: v.union(v.string(), v.null()),
  /** A hash rule can be made (the PC reported the file's SHA-256). The hash itself is not returned. */
  hasHash: v.boolean(),
  deviceCount: v.number(),
  firstSeenAt: v.number(),
  lastSeenAt: v.number(),
  status: findingStatus,
});

/**
 * The findings of one status (viewer; paginated through `by_org_status_seen`; the only sort key is "seen", either direction). One row
 * per program (fingerprint): file name, signer, folder class, layer, how many PCs saw it, last seen. Never a path or a PC list.
 */
export const findings = memberQuery("viewer")({
  args: { status: findingStatus, paginationOpts: paginationOptsValidator, sort: sortArg },
  returns: paginationResultValidator(findingRow),
  handler: async (ctx, args) => {
    checkPageSize(args.paginationOpts.numItems, MAX_FINDINGS_PAGE);
    const sort = pickSort("findings", args.sort);
    const result = await ctx.db
      .query("lockdownFindings")
      .withIndex("by_org_status_seen", (q) => q.eq("orgId", ctx.orgId).eq("status", args.status))
      .order(sort.dir)
      .paginate(args.paginationOpts);
    return {
      ...result,
      page: result.page.map((f) => ({
        _id: f._id,
        layer: f.layer,
        fileName: f.fileName,
        folderClass: f.folderClass,
        signer: f.signer ?? null,
        product: f.product ?? null,
        hasHash: f.sha256 !== undefined,
        deviceCount: f.deviceCount,
        firstSeenAt: f.firstSeenAt,
        lastSeenAt: f.lastSeenAt,
        status: f.status,
      })),
    };
  },
});

/**
 * The pickers of the "Allow for app" dialog (admin; subscribed only while the dialog is open): the organization's groups and its
 * programs (desktop apps that are not archived), by name.
 */
export const allowOptions = memberQuery("admin")({
  args: {},
  returns: v.object({
    groups: v.array(v.object({ _id: v.id("groups"), name: v.string() })),
    apps: v.array(v.object({ _id: v.id("apps"), name: v.string() })),
  }),
  handler: async (ctx) => {
    const groups = await ctx.db
      .query("groups")
      .withIndex("by_org", (q) => q.eq("orgId", ctx.orgId))
      .take(MAX_GROUPS_JOINED);
    const apps = await ctx.db
      .query("apps")
      .withIndex("by_org_archived", (q) => q.eq("orgId", ctx.orgId).eq("archived", false))
      .take(MAX_ALLOW_APPS);
    const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name);
    return {
      groups: groups.map((g) => ({ _id: g._id, name: g.name })).sort(byName),
      apps: apps.filter((a) => a.kind === "desktop").map((a) => ({ _id: a._id, name: a.name })).sort(byName),
    };
  },
});

const ADMIN_ONLY_FOLDERS: readonly string[] = ["programFiles", "rulebox"];
const RULEBOX_APPS = "{RuleboxApps}\\";

/**
 * The path template of a path exception: `<folder>\<file name>`. The folder must be under `{ProgramFiles}`, `{ProgramFilesX86}` or
 * `{RuleboxApps}\<app folder>` (never `{SystemRoot}` and never a user folder), and the whole path passes the catalogue's own
 * program-path rules (`lib/pathRules.ts`). `invalid_argument` field "folder" otherwise.
 */
export function exceptionPath(folder: string, fileName: string): string {
  const path = `${folder.trim().replace(/\\+$/, "")}\\${fileName}`;
  let problem: string | null;
  if (path.startsWith(RULEBOX_APPS)) {
    const appFolder = path.slice(RULEBOX_APPS.length).split("\\")[0] ?? "";
    problem = /^[A-Za-z0-9_-]{1,64}$/.test(appFolder) ? exePathProblem(path, { portable: true, appId: appFolder }) : "unknown path root";
  } else if (path.startsWith("{SystemRoot}")) {
    problem = "unknown path root";
  } else {
    problem = exePathProblem(path, { portable: false });
  }
  if (problem !== null) fail("invalid_argument", { field: "folder", detail: problem });
  return path;
}

/**
 * Allow a program that a finding names (admin): one exception per chosen group (1..MAX_ALLOW_GROUPS), for AppLocker and the process
 * watch (never App Control: `conflict`, detail `app_control_finding`). `kind`: "publisher" (the finding's signer, product and file
 * name; `conflict` detail `no_signer` for an unsigned program), "hash" (this exact file; `no_hash` when the PC sent none; breaks when
 * the program updates) or "path" (only for a program found under an admin-only folder, `path_not_admin_only` otherwise; the admin
 * types the folder template). A group that already has the same rule is skipped; a group at MAX_GROUP_EXCEPTIONS is `too_large`
 * (detail "exceptions"). The finding becomes `allowed`; each group gets a new configuration version; audits `lockdown.exceptionAdded`.
 */
export const allow = memberMutation("admin")({
  args: {
    findingId: v.string(),
    kind: v.union(v.literal("publisher"), v.literal("hash"), v.literal("path")),
    /** Path rules only: the folder template, for example `{ProgramFiles}\Acme`. */
    folder: v.optional(v.string()),
    groupIds: v.array(v.string()),
    appId: v.optional(v.string()),
    reason: v.optional(v.string()),
  },
  returns: v.object({ added: v.number() }),
  handler: async (ctx, args) => {
    const finding = await getInOrg(ctx, "lockdownFindings", args.findingId, ctx.orgId);
    if (finding.layer === "appControl") fail("conflict", { detail: "app_control_finding" });
    const ids = [...new Set(args.groupIds)];
    if (ids.length === 0) fail("invalid_argument", { field: "groupIds" });
    if (ids.length > MAX_ALLOW_GROUPS) fail("too_large", { detail: "groups" });
    const reason = (args.reason ?? "").trim();
    // eslint-disable-next-line no-control-regex
    if (reason.length > MAX_EXCEPTION_REASON || /[\u0000-\u001f\u007f]/.test(reason)) fail("invalid_argument", { field: "reason" });

    let rule: ExceptionRuleValue;
    const layers: ExceptionRuleValue["layers"] = ["appLocker", "procWatch"];
    if (args.kind === "publisher") {
      if (finding.signer === undefined) fail("conflict", { detail: "no_signer" });
      rule = { kind: "publisher", publisher: { subject: finding.signer, product: finding.product, fileName: finding.fileName }, layers };
    } else if (args.kind === "hash") {
      if (finding.sha256 === undefined) fail("conflict", { detail: "no_hash" });
      rule = { kind: "hash", sha256: finding.sha256, layers };
    } else {
      if (!ADMIN_ONLY_FOLDERS.includes(finding.folderClass)) fail("conflict", { detail: "path_not_admin_only" });
      if (args.folder === undefined) fail("invalid_argument", { field: "folder" });
      rule = { kind: "path", path: exceptionPath(args.folder, finding.fileName), layers };
    }

    const app = args.appId === undefined ? null : await getInOrg(ctx, "apps", args.appId, ctx.orgId);
    const groups: Doc<"groups">[] = [];
    for (const id of ids) groups.push(await getInOrg(ctx, "groups", id, ctx.orgId));

    const now = Date.now();
    const cache = newSnapshotCache();
    const added: Doc<"groups">[] = [];
    for (const group of groups) {
      const have = await ctx.db
        .query("lockdownExceptions")
        .withIndex("by_org_group", (q) => q.eq("orgId", ctx.orgId).eq("groupId", group._id))
        .take(MAX_GROUP_EXCEPTIONS + 1);
      if (have.some((e) => deepEqual(e.rule, rule))) continue;
      if (have.length >= MAX_GROUP_EXCEPTIONS) fail("too_large", { detail: "exceptions" });
      await ctx.db.insert("lockdownExceptions", {
        orgId: ctx.orgId,
        groupId: group._id,
        appId: app?._id,
        rule,
        reason,
        findingId: finding._id,
        createdBy: ctx.member._id,
        createdAt: now,
      });
      await snapshotGroupConfig(ctx, group._id, "Exception added", ctx.member._id, cache);
      added.push(group);
    }
    if (finding.status !== "allowed") await ctx.db.patch(finding._id, { status: "allowed", decidedBy: ctx.member._id, decidedAt: now });
    if (added.length > 0) {
      const first = added[0]!;
      await writeAudit(ctx, {
        orgId: ctx.orgId,
        actor: ctx.actor,
        action: "lockdown.exceptionAdded",
        targetType: "group",
        targetId: first._id,
        targetLabel: first.name,
        summary:
          added.length === 1
            ? `Allowed the program ${finding.fileName} for the group ${first.name} (${args.kind} rule)`
            : `Allowed the program ${finding.fileName} for ${added.length} groups (${args.kind} rule)`,
      });
    }
    return { added: added.length };
  },
});

/**
 * Ignore a finding (admin): it leaves the open list and nothing is allowed. Already ignored = no write; an allowed finding is
 * refused (`conflict`, detail `already_allowed`: remove its exceptions first). Audits `lockdown.findingIgnored`.
 */
export const ignore = memberMutation("admin")({
  args: { findingId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const finding = await getInOrg(ctx, "lockdownFindings", args.findingId, ctx.orgId);
    if (finding.status === "ignored") return null;
    if (finding.status === "allowed") fail("conflict", { detail: "already_allowed" });
    await ctx.db.patch(finding._id, { status: "ignored", decidedBy: ctx.member._id, decidedAt: Date.now() });
    await writeAudit(ctx, {
      orgId: ctx.orgId,
      actor: ctx.actor,
      action: "lockdown.findingIgnored",
      targetType: "finding",
      targetId: finding._id,
      targetLabel: finding.fileName,
      summary: `Ignored the blocked program ${finding.fileName}`,
    });
    return null;
  },
});

/**
 * Remove an exception (admin): the group gets a new configuration version without it. When it was the last exception made from its
 * finding, the finding is open again. An organization-wide exception (none is made by this step) is refused (`not_ready`). Audits
 * `lockdown.exceptionRemoved`.
 */
export const removeException = memberMutation("admin")({
  args: { exceptionId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await getInOrg(ctx, "lockdownExceptions", args.exceptionId, ctx.orgId);
    if (row.groupId === undefined) fail("not_ready", { detail: "organization-wide exception" });
    const group = await ctx.db.get(row.groupId);
    await ctx.db.delete(row._id);
    if (row.findingId !== undefined) {
      const findingId = row.findingId;
      const other = await ctx.db
        .query("lockdownExceptions")
        .withIndex("by_finding", (q) => q.eq("findingId", findingId))
        .first();
      const finding = other === null ? await ctx.db.get(findingId) : null;
      if (finding !== null && finding.status === "allowed") await ctx.db.patch(finding._id, { status: "new", decidedBy: undefined, decidedAt: undefined });
    }
    if (group !== null) await snapshotGroupConfig(ctx, group._id, "Exception removed", ctx.member._id);
    const what = row.rule.publisher?.fileName ?? row.rule.path?.split("\\").pop() ?? "a program";
    await writeAudit(ctx, {
      orgId: ctx.orgId,
      actor: ctx.actor,
      action: "lockdown.exceptionRemoved",
      targetType: "group",
      targetId: row.groupId,
      targetLabel: group?.name,
      summary: `Removed the exception for ${what} (${row.rule.kind} rule)${group === null ? "" : ` from the group ${group.name}`}`,
    });
    return null;
  },
});
