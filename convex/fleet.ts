import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, type DatabaseReader } from "./_generated/server";
import { writeAudit } from "./lib/audit";
import { checkRevision, getInOrg, nextRevision } from "./lib/authz";
import { normalizeDeviceName } from "./lib/enrollmentCodes";
import { fail } from "./lib/errors";
import { credOf, revokeDevice } from "./lib/fleet";
import { memberMutation, memberQuery } from "./lib/functions";
import {
  MAX_CHECK_DEVICES,
  MAX_FLEET_PAGE,
  MAX_GROUPS_JOINED,
  MAX_SEARCH_TEXT,
  MINUTE_MS,
  PURGE_BATCH,
  WATCH_MIN_EXTEND_MS,
  WATCH_MS,
} from "./lib/limits";
import { bumpOrgStatsIfPresent, loadOrgPlan } from "./lib/plans";
import { requestPublish } from "./lib/publish";
import { consumeOrFail } from "./lib/rateLimits";
import { requireStepUp } from "./lib/stepUp";
import { diskBand, reportedStatusFields } from "./lib/validators";

// Devices in the dashboard (plan Step 7 items 4, 10-13; 4.13 amended).
//
// Reads follow the I/O rules (post-Phase-5 plan 2.5): a list row is
// `devices` + `deviceSummary` + `devicePresence` (+ `desiredHeads` from Step
// 8), never `deviceLiveness`, `deviceReports`, `deviceCredentials` or a
// document payload. Every id is checked against the caller's organization
// (`getInOrg`, and `ctx.db` is scoped by the wrapper). Nothing returned holds a
// secret hash.

const credState = v.union(v.literal("active"), v.literal("revoked"), v.literal("overLimit"), v.literal("suspended"));

const presenceValue = v.object({
  online: v.boolean(),
  /** Start of the current state (ms); null for a device never seen since Step 7. */
  since: v.union(v.number(), v.null()),
  revoked: v.boolean(),
});

const summaryValue = v.object({
  agentVersion: v.optional(v.string()),
  windowsBuild: v.optional(v.string()),
  kioskPhase: v.optional(v.string()),
  outOfSupport: v.boolean(),
  appliedVersion: v.optional(v.number()),
  diskBand: v.optional(diskBand),
  updatedAt: v.number(),
});

const deviceRow = v.object({
  _id: v.id("devices"),
  name: v.string(),
  groupId: v.optional(v.id("groups")),
  groupName: v.optional(v.string()),
  kioskEnabled: v.boolean(),
  enrolledAt: v.number(),
  revision: v.number(),
  presence: presenceValue,
  summary: v.union(summaryValue, v.null()),
  /** Newest published version (from the head, Step 8); null until then. */
  latestVersion: v.union(v.number(), v.null()),
});

async function summaryOf(ctx: { db: DatabaseReader }, deviceId: Id<"devices">) {
  const s = await ctx.db
    .query("deviceSummary")
    .withIndex("by_device", (q) => q.eq("deviceId", deviceId))
    .unique();
  if (s === null) return null;
  return {
    agentVersion: s.agentVersion,
    windowsBuild: s.windowsBuild,
    kioskPhase: s.kioskPhase,
    outOfSupport: s.outOfSupport,
    appliedVersion: s.appliedVersion,
    diskBand: s.diskBand,
    updatedAt: s.updatedAt,
  };
}

async function presenceOf(ctx: { db: DatabaseReader }, device: Doc<"devices">) {
  const p = await ctx.db
    .query("devicePresence")
    .withIndex("by_device", (q) => q.eq("deviceId", device._id))
    .unique();
  if (p === null) return { online: false, since: null, revoked: device.revoked === true };
  return { online: p.online, since: p.since, revoked: p.revoked === true };
}

async function rowOf(ctx: { db: DatabaseReader }, d: Doc<"devices">, groupNames: Map<string, string>) {
  return {
    _id: d._id,
    name: d.name,
    groupId: d.groupId,
    groupName: d.groupId !== undefined ? groupNames.get(d.groupId) : undefined,
    kioskEnabled: d.kioskEnabled !== false,
    enrolledAt: d.enrolledAt,
    revision: d.revision ?? 0,
    presence: await presenceOf(ctx, d),
    summary: await summaryOf(ctx, d._id),
    latestVersion: null,
  };
}

async function groupNamesOf(ctx: { db: DatabaseReader }, orgId: Id<"organizations">): Promise<Map<string, string>> {
  const groups = await ctx.db
    .query("groups")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .take(MAX_GROUPS_JOINED);
  return new Map(groups.map((g) => [g._id as string, g.name]));
}

function cleanSearch(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const t = text.trim();
  if (t.length > MAX_SEARCH_TEXT) fail("invalid_argument", { field: "search" });
  return t === "" ? undefined : t;
}

/**
 * One page of the organization's devices (viewer): newest first, or the
 * search index's best matches when `search` is given; `groupId` narrows
 * either. At most MAX_FLEET_PAGE rows; ~3 reads per row.
 */
export const list = memberQuery("viewer")({
  args: {
    paginationOpts: paginationOptsValidator,
    groupId: v.optional(v.string()),
    search: v.optional(v.string()),
  },
  returns: paginationResultValidator(deviceRow),
  handler: async (ctx, args) => {
    const numItems = args.paginationOpts.numItems;
    if (!Number.isInteger(numItems) || numItems < 1 || numItems > MAX_FLEET_PAGE) {
      fail("invalid_argument", { field: "paginationOpts" });
    }
    const groupId =
      args.groupId === undefined ? undefined : (await getInOrg(ctx, "groups", args.groupId, ctx.orgId))._id;
    const search = cleanSearch(args.search);

    const result =
      search !== undefined
        ? await ctx.db
            .query("devices")
            .withSearchIndex("search_name", (q) => {
              const s = q.search("name", search).eq("orgId", ctx.orgId);
              return groupId !== undefined ? s.eq("groupId", groupId) : s;
            })
            .paginate(args.paginationOpts)
        : groupId !== undefined
          ? await ctx.db
              .query("devices")
              .withIndex("by_group", (q) => q.eq("groupId", groupId))
              .order("desc")
              .paginate(args.paginationOpts)
          : await ctx.db
              .query("devices")
              .withIndex("by_org", (q) => q.eq("orgId", ctx.orgId))
              .order("desc")
              .paginate(args.paginationOpts);

    const groupNames = result.page.some((d) => d.groupId !== undefined)
      ? await groupNamesOf(ctx, ctx.orgId)
      : new Map<string, string>();
    const page = [];
    for (const d of result.page) page.push(await rowOf(ctx, d, groupNames));
    return { ...result, page };
  },
});

const reportValue = v.object({
  ...reportedStatusFields,
  trustedKeyIds: v.optional(v.array(v.string())),
  restartPending: v.optional(v.boolean()),
  updatedAt: v.number(),
});

/**
 * One device for its detail page (viewer). `versions` (the last 5 documents)
 * comes from `desiredVersions` with Step 8; empty until then. Never a hash.
 */
export const get = memberQuery("viewer")({
  args: { deviceId: v.string() },
  returns: v.object({
    _id: v.id("devices"),
    name: v.string(),
    revision: v.number(),
    kioskEnabled: v.boolean(),
    enrolledAt: v.number(),
    group: v.union(v.object({ _id: v.id("groups"), name: v.string() }), v.null()),
    state: credState,
    presence: presenceValue,
    summary: v.union(summaryValue, v.null()),
    report: v.union(reportValue, v.null()),
    versions: v.array(v.object({ version: v.number(), createdAt: v.number(), reason: v.string() })),
    flags: v.object({ noGroup: v.boolean(), revoked: v.boolean(), rotateCredential: v.boolean() }),
    /** Group picker options (`groups.by_org`, tiny). */
    groups: v.array(v.object({ _id: v.id("groups"), name: v.string() })),
  }),
  handler: async (ctx, args) => {
    const d = await getInOrg(ctx, "devices", args.deviceId, ctx.orgId);
    const cred = await credOf(ctx, d);
    const report = await ctx.db
      .query("deviceReports")
      .withIndex("by_device", (q) => q.eq("deviceId", d._id))
      .unique();
    const groups = await ctx.db
      .query("groups")
      .withIndex("by_org", (q) => q.eq("orgId", ctx.orgId))
      .take(MAX_GROUPS_JOINED);
    const group = groups.find((g) => g._id === d.groupId);
    const rotateCredential = cred.row?.rotate === true || (cred.row === null && d.rotateCredential === true);
    return {
      _id: d._id,
      name: d.name,
      revision: d.revision ?? 0,
      kioskEnabled: d.kioskEnabled !== false,
      enrolledAt: d.enrolledAt,
      group: group !== undefined ? { _id: group._id, name: group.name } : null,
      state: cred.state,
      presence: await presenceOf(ctx, d),
      summary: await summaryOf(ctx, d._id),
      report:
        report === null
          ? null
          : {
              agentVersion: report.agentVersion,
              os: report.os,
              osBuild: report.osBuild,
              osEdition: report.osEdition,
              ramMb: report.ramMb,
              diskFreeGb: report.diskFreeGb,
              lockdownLevel: report.lockdownLevel,
              kioskPhase: report.kioskPhase,
              kioskError: report.kioskError,
              appliedVersion: report.appliedVersion,
              shellHealth: report.shellHealth,
              compat: report.compat,
              trustedKeyIds: report.trustedKeyIds,
              restartPending: report.restartPending,
              updatedAt: report.updatedAt,
            },
      versions: [],
      flags: { noGroup: d.groupId === undefined, revoked: cred.state === "revoked", rotateCredential },
      groups: groups.map((g) => ({ _id: g._id, name: g.name })).sort((a, b) => a.name.localeCompare(b.name)),
    };
  },
});

/** A device that may still be changed: not revoked (`conflict` otherwise). */
async function activeDevice(ctx: { db: DatabaseReader; orgId: Id<"organizations"> }, deviceId: string) {
  const device = await getInOrg(ctx, "devices", deviceId, ctx.orgId);
  const cred = await credOf(ctx, device);
  if (cred.state === "revoked") fail("conflict", { detail: "device revoked" });
  return { device, cred };
}

/** Rename (admin). No publish: the name is not in the document. Unchanged = no write. */
export const rename = memberMutation("admin")({
  args: { deviceId: v.string(), expectedRevision: v.number(), name: v.string() },
  returns: v.object({ revision: v.number() }),
  handler: async (ctx, args) => {
    const device = await getInOrg(ctx, "devices", args.deviceId, ctx.orgId);
    checkRevision(device, args.expectedRevision);
    if (args.name.length > 1_000) fail("invalid_argument", { field: "name" });
    const name = normalizeDeviceName(args.name);
    if (name === device.name) return { revision: device.revision ?? 0 };
    const revision = nextRevision(device);
    await ctx.db.patch(device._id, { name, revision });
    await writeAudit(ctx, {
      orgId: ctx.orgId,
      actor: ctx.actor,
      action: "device.renamed",
      targetType: "device",
      targetId: device._id,
      targetLabel: name,
      summary: `Renamed the PC ${device.name} to ${name}`,
    });
    return { revision };
  },
});

/** Move to a group (admin). Republishes the device. `noGroupDeviceCount` follows. */
export const move = memberMutation("admin")({
  args: { deviceId: v.string(), expectedRevision: v.number(), groupId: v.string() },
  returns: v.object({ revision: v.number() }),
  handler: async (ctx, args) => {
    const { device } = await activeDevice(ctx, args.deviceId);
    checkRevision(device, args.expectedRevision);
    const group = await getInOrg(ctx, "groups", args.groupId, ctx.orgId);
    if (device.groupId === group._id) return { revision: device.revision ?? 0 };
    const revision = nextRevision(device);
    await ctx.db.patch(device._id, { groupId: group._id, revision });
    if (device.groupId === undefined) await bumpOrgStatsIfPresent(ctx, ctx.orgId, { noGroupDeviceCount: -1 });
    await requestPublish(ctx, ctx.orgId, { deviceIds: [device._id] });
    await writeAudit(ctx, {
      orgId: ctx.orgId,
      actor: ctx.actor,
      action: "device.moved",
      targetType: "device",
      targetId: device._id,
      targetLabel: device.name,
      summary: `Moved the PC ${device.name} to the group ${group.name}`,
    });
    return { revision };
  },
});

/**
 * Kiosk mode on or off (admin). Turning it OFF is a major action (fresh
 * step-up, plan 4.16); on needs an unlocked session. Republishes the device.
 */
export const setKiosk = memberMutation("admin")({
  args: { deviceId: v.string(), expectedRevision: v.number(), enabled: v.boolean() },
  returns: v.object({ revision: v.number() }),
  handler: async (ctx, args) => {
    const { device } = await activeDevice(ctx, args.deviceId);
    checkRevision(device, args.expectedRevision);
    const current = device.kioskEnabled !== false;
    if (current === args.enabled) return { revision: device.revision ?? 0 };
    if (!args.enabled) await requireStepUp(ctx, "fresh");
    const revision = nextRevision(device);
    await ctx.db.patch(device._id, { kioskEnabled: args.enabled, revision });
    await requestPublish(ctx, ctx.orgId, { deviceIds: [device._id] });
    await writeAudit(ctx, {
      orgId: ctx.orgId,
      actor: ctx.actor,
      action: args.enabled ? "device.kioskEnabled" : "device.kioskDisabled",
      targetType: "device",
      targetId: device._id,
      targetLabel: device.name,
      summary: `${args.enabled ? "Turned on" : "Turned off"} kiosk mode on the PC ${device.name}`,
    });
    return { revision };
  },
});

/**
 * Revoke (admin, major). The device's next call is refused and its
 * subscription answers `revoked`; it frees a plan slot. Already revoked = no
 * write.
 */
export const revoke = memberMutation("admin", { major: "fleet:revoke" })({
  args: { deviceId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const device = await getInOrg(ctx, "devices", args.deviceId, ctx.orgId);
    const revoked = await revokeDevice(ctx, await credOf(ctx, device), Date.now());
    if (revoked === null) return null;
    await writeAudit(ctx, {
      orgId: ctx.orgId,
      actor: ctx.actor,
      action: "device.revoked",
      targetType: "device",
      targetId: device._id,
      targetLabel: device.name,
      summary: `Revoked the PC ${device.name}`,
    });
    return null;
  },
});

/**
 * Remove a REVOKED device (admin, major; `conflict` while it is not revoked).
 * Deletes its rows now and its install results and documents in batches
 * (`fleet:purgeDevice`). Counters do not move: revoke already lowered them.
 */
export const remove = memberMutation("admin", { major: "fleet:remove" })({
  args: { deviceId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const device = await getInOrg(ctx, "devices", args.deviceId, ctx.orgId);
    const cred = await credOf(ctx, device);
    if (cred.state !== "revoked") fail("conflict", { detail: "revoke the device first" });
    for (const table of ["deviceCredentials", "deviceLiveness", "devicePresence", "deviceSummary", "deviceReports", "deviceStatus"] as const) {
      const row = await ctx.db
        .query(table)
        .withIndex("by_device", (q) => q.eq("deviceId", device._id))
        .first();
      if (row !== null) await ctx.db.delete(row._id);
    }
    await ctx.db.delete(device._id);
    await ctx.scheduler.runAfter(0, internal.fleet.purgeDevice, { deviceId: device._id });
    await writeAudit(ctx, {
      orgId: ctx.orgId,
      actor: ctx.actor,
      action: "device.removed",
      targetType: "device",
      targetId: device._id,
      targetLabel: device.name,
      summary: `Removed the PC ${device.name}`,
    });
    return null;
  },
});

/** Batches of a removed device's install results and documents (reschedules while full). */
export const purgeDevice = internalMutation({
  args: { deviceId: v.id("devices") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const installs = await ctx.db
      .query("installResults")
      .withIndex("by_device", (q) => q.eq("deviceId", args.deviceId))
      .take(PURGE_BATCH);
    const docs = await ctx.db
      .query("desiredStates")
      .withIndex("by_device_version", (q) => q.eq("deviceId", args.deviceId))
      .take(PURGE_BATCH);
    const scoped = await ctx.db
      .query("desiredStates")
      .withIndex("by_scope_version", (q) => q.eq("scope", args.deviceId))
      .take(PURGE_BATCH);
    for (const row of [...installs, ...docs, ...scoped]) await ctx.db.delete(row._id);
    if (installs.length === PURGE_BATCH || docs.length === PURGE_BATCH || scoped.length === PURGE_BATCH) {
      await ctx.scheduler.runAfter(0, internal.fleet.purgeDevice, args);
    }
    return null;
  },
});

/**
 * Ask the device to replace its secret (admin). The flag reaches the agent in
 * every ping / heartbeat answer (`rotateCredential: true`); the rotation itself
 * is `deviceApi:rotateCredential` (Steps 12-13). Already requested = no write.
 */
export const requestCredentialRotation = memberMutation("admin")({
  args: { deviceId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { device, cred } = await activeDevice(ctx, args.deviceId);
    if (cred.row === null) fail("not_ready", { detail: "device not migrated; run maintenance:migrateDevices" });
    if (cred.row.rotate === true) return null;
    await ctx.db.patch(cred.row._id, { rotate: true });
    await writeAudit(ctx, {
      orgId: ctx.orgId,
      actor: ctx.actor,
      action: "device.credentialRotationRequested",
      targetType: "device",
      targetId: device._id,
      targetLabel: device.name,
      summary: `Asked the PC ${device.name} to replace its credential`,
    });
    return null;
  },
});

// ---------------------------------------------------------------- real time on demand (plan 4.9)

async function livenessOf(ctx: { db: DatabaseReader }, deviceId: Id<"devices">) {
  return await ctx.db
    .query("deviceLiveness")
    .withIndex("by_device", (q) => q.eq("deviceId", deviceId))
    .unique();
}

/**
 * Watch mode (viewer; the detail page calls it every 4 minutes while
 * visible): the device is answered "ping again in 60 s" until `fastUntil`
 * (now + 5 min, rounded up to the minute). Writes only when that extends the
 * stored value by at least 2 minutes; rate limit `watch` (6/min per member) is
 * consumed only then. Off when the plan has `watchMode: false` (answer null).
 * Today's (Phase 2) agent sees it at its next regular ping; the head signal of
 * Step 8 makes it immediate.
 */
export const watch = memberMutation("viewer", { stepUp: "none" })({
  args: { deviceId: v.string() },
  returns: v.object({ fastUntil: v.union(v.number(), v.null()) }),
  handler: async (ctx, args) => {
    const device = await getInOrg(ctx, "devices", args.deviceId, ctx.orgId);
    const plan = await loadOrgPlan(ctx, ctx.orgId);
    if (!plan.limits.watchMode) return { fastUntil: null };
    const row = await livenessOf(ctx, device._id);
    if (row === null || (await credOf(ctx, device)).state === "revoked") return { fastUntil: null };
    const now = Date.now();
    const fastUntil = Math.ceil((now + WATCH_MS) / MINUTE_MS) * MINUTE_MS;
    if (row.fastUntil !== undefined && fastUntil < row.fastUntil + WATCH_MIN_EXTEND_MS) {
      return { fastUntil: row.fastUntil };
    }
    await consumeOrFail(ctx, "watch", ctx.member._id);
    await ctx.db.patch(row._id, { fastUntil });
    return { fastUntil };
  },
});

/**
 * The one liveness row of a watched device (viewer). The ONLY dashboard read
 * of `deviceLiveness`; it re-runs at most once a minute per device ping.
 */
export const liveness = memberQuery("viewer")({
  args: { deviceId: v.string() },
  returns: v.object({
    lastContactAt: v.union(v.number(), v.null()),
    online: v.boolean(),
    fastUntil: v.union(v.number(), v.null()),
  }),
  handler: async (ctx, args) => {
    const device = await getInOrg(ctx, "devices", args.deviceId, ctx.orgId);
    const row = await livenessOf(ctx, device._id);
    if (row === null) return { lastContactAt: null, online: false, fastUntil: null };
    return { lastContactAt: row.seenBucket * MINUTE_MS, online: row.online, fastUntil: row.fastUntil ?? null };
  },
});

/**
 * "Check now" (admin): asks up to MAX_CHECK_DEVICES devices to call in.
 * Rate limit `checkNow` (1/min per organization). The answer of each device
 * is recorded by its next ping; `checkResult` shows answered / no answer.
 * Today's (Phase 2) agent answers at its next regular ping; Step 8's head
 * `pingNonce` makes it ping within seconds.
 */
export const checkNow = memberMutation("admin")({
  args: { deviceIds: v.array(v.string()) },
  returns: v.object({ checkId: v.id("fleetChecks") }),
  handler: async (ctx, args) => {
    const unique = [...new Set(args.deviceIds)];
    if (unique.length < 1 || unique.length > MAX_CHECK_DEVICES) fail("invalid_argument", { field: "deviceIds" });
    const rows: { deviceId: Id<"devices">; liveness: Doc<"deviceLiveness"> | null }[] = [];
    for (const id of unique) {
      const device = await getInOrg(ctx, "devices", id, ctx.orgId);
      rows.push({ deviceId: device._id, liveness: await livenessOf(ctx, device._id) });
    }
    await consumeOrFail(ctx, "checkNow", ctx.orgId);
    const checkId = await ctx.db.insert("fleetChecks", {
      orgId: ctx.orgId,
      deviceIds: rows.map((r) => r.deviceId),
      requestedAt: Date.now(),
      requestedBy: ctx.member._id,
    });
    for (const r of rows) {
      if (r.liveness !== null) await ctx.db.patch(r.liveness._id, { pendingCheck: checkId });
    }
    return { checkId };
  },
});

/**
 * Result of one "Check now" (admin; the page subscribes for at most 60 s
 * after `requestedAt`): per device, whether it called in since.
 */
export const checkResult = memberQuery("admin")({
  args: { checkId: v.string() },
  returns: v.object({
    requestedAt: v.number(),
    items: v.array(v.object({ deviceId: v.id("devices"), answered: v.boolean() })),
  }),
  handler: async (ctx, args) => {
    const check = await getInOrg(ctx, "fleetChecks", args.checkId, ctx.orgId);
    const items = [];
    for (const deviceId of check.deviceIds) {
      const row = await livenessOf(ctx, deviceId);
      items.push({ deviceId, answered: row !== null && row.answeredCheck === check._id });
    }
    return { requestedAt: check.requestedAt, items };
  },
});
