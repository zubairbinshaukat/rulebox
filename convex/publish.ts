import type { PaginationResult } from "convex/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, type DatabaseReader, type MutationCtx } from "./_generated/server";
import { SYSTEM_ACTOR, writeAudit } from "./lib/audit";
import {
  buildDeviceDoc,
  buildPayload,
  contentHashOf,
  MAX_PAYLOAD_BYTES,
  utf8Length,
  type BuildApp,
  type BuildInput,
} from "./lib/desired";
import {
  KEEP_VERSIONS,
  MAX_EMPLOYEE_APPS,
  MAX_FILE_HANDLERS,
  MAX_GROUP_APPS,
  MAX_GROUP_EMPLOYEES,
  MAX_PRUNE_PER_DEVICE,
  PUBLISH_BATCH,
} from "./lib/limits";
import { orgPingInterval } from "./lib/presence";
import { loadOrgSigningKey, signWith, type SigningKey } from "./lib/signing";
import { DEFAULT_ORG_SETTINGS, type OrgSettings } from "./lib/validators";
import { sanitizeVersion } from "./lib/versions";

// The publisher (plan 4.4 as amended by A5, A6, A13; Step 8 item 3). Internal:
// scheduled by `lib/publish.ts` `requestPublish` (1.5 s after the first of a
// burst of edits) and by itself while work remains.
//
// One run takes the organization's queue row and handles at most
// PUBLISH_BATCH devices: listed devices first, then the first listed group
// (paginated), then "all devices" (paginated). For each device: skip revoked
// ones; build the document (pure, lib/desired.ts); when its content hash and
// signing key equal the head's, write nothing (or only the head's small
// fields when they differ); otherwise sign it HERE, in this mutation, and
// write body + version row + head in the same transaction, then prune to
// KEEP_VERSIONS. No audit entry per device: the admin action that caused the
// publish has one.
//
// No valid signing key (env seed missing, or not the organization's active
// `policyKeys` row): nothing is written but one `policy.publishFailed` audit
// entry and `orgStats.publishFailedAt`; the queue is kept (unscheduled) and
// `keys:registerActive` / `finishRotation` request the publish again.

/** Organization-wide inputs, loaded once per run. */
type OrgInputs = {
  org: Doc<"organizations">;
  settings: OrgSettings;
  fileHandlers: BuildInput["fileHandlers"];
  pinHash: string | null;
  pingIntervalMs: number;
};

/** Group-level inputs, loaded once per group per run and shared by its devices. */
type GroupInputs = Pick<BuildInput, "group" | "assignments" | "apps" | "employees" | "employeeApps">;

async function loadOrgInputs(ctx: { db: DatabaseReader }, org: Doc<"organizations">): Promise<OrgInputs> {
  const secrets = await ctx.db
    .query("orgSecrets")
    .withIndex("by_org", (q) => q.eq("orgId", org._id))
    .unique();
  // The organization's file-type rules, once per run (tiny: at most MAX_FILE_HANDLERS). Each
  // device keeps only those whose app is in its catalogue (`lib/desired.ts`).
  const handlers = await ctx.db
    .query("fileHandlers")
    .withIndex("by_org_ext", (q) => q.eq("orgId", org._id))
    .take(MAX_FILE_HANDLERS);
  return {
    org,
    settings: org.settings ?? DEFAULT_ORG_SETTINGS,
    fileHandlers: handlers.map((h) => ({ extension: h.extension, appId: h.appId })),
    pinHash: secrets?.exitPinHash ?? null,
    pingIntervalMs: await orgPingInterval(ctx, org._id),
  };
}

/**
 * The group's catalogue inputs: the group, its app assignments, the direct
 * grants of its enabled members (Step 11) and the apps they name (with the
 * icon's stable address from file storage). The members' sign-in rights are NOT
 * here: they are the signed roster (A6). Archived apps are loaded and left out
 * by the builder, so archiving removes an app from every document.
 */
async function loadGroupInputs(
  ctx: Pick<MutationCtx, "db" | "storage">,
  orgId: Id<"organizations">,
  groupId: Id<"groups"> | undefined,
): Promise<GroupInputs> {
  const group = groupId === undefined ? null : await ctx.db.get(groupId);
  if (group === null || group.orgId !== orgId) {
    return { group: null, assignments: [], apps: [], employees: [], employeeApps: [] };
  }
  const rows = await ctx.db
    .query("appAssignments")
    .withIndex("by_group", (q) => q.eq("groupId", group._id))
    .take(MAX_GROUP_APPS);

  // Direct grants (Step 11): the group's members that have any, and are enabled.
  // Most members have none, so each costs one empty index read; only those with a
  // grant are read as documents. A disabled employee's grants are in no document
  // (the builder ignores them), so they are not loaded.
  const members = await ctx.db
    .query("groupMembers")
    .withIndex("by_group", (q) => q.eq("groupId", group._id))
    .take(MAX_GROUP_EMPLOYEES);
  const employees: GroupInputs["employees"] = [];
  const employeeApps: GroupInputs["employeeApps"] = [];
  for (const m of members) {
    const grants = await ctx.db
      .query("employeeApps")
      .withIndex("by_employee", (q) => q.eq("employeeId", m.employeeId))
      .take(MAX_EMPLOYEE_APPS);
    if (grants.length === 0) continue;
    const employee = await ctx.db.get(m.employeeId);
    if (employee === null || employee.orgId !== orgId || employee.disabled) continue;
    employees.push({ _id: employee._id, disabled: false });
    for (const g of grants) employeeApps.push({ employeeId: employee._id, appId: g.appId });
  }

  // Every app an assignment or a grant names (assigned ones first), once.
  const appIds = new Set<Id<"apps">>(rows.map((a) => a.appId));
  for (const g of employeeApps) appIds.add(g.appId as Id<"apps">);
  const apps: BuildApp[] = [];
  for (const appId of appIds) {
    const app = await ctx.db.get(appId);
    if (app === null || app.orgId !== orgId) continue;
    const icon = app.icon !== undefined ? await ctx.storage.getUrl(app.icon.storageId) : null;
    apps.push({
      _id: app._id,
      name: app.name,
      description: app.description,
      kind: app.kind,
      hue: app.hue,
      archived: app.archived,
      revision: app.revision,
      web: app.web,
      desktop: app.desktop,
      icon: app.icon !== undefined && icon !== null ? { url: icon, sha256: app.icon.sha256 } : undefined,
    });
  }
  return {
    group: { _id: group._id },
    assignments: rows.map((a) => ({ appId: a.appId, audience: a.audience, pinnedTaskbar: a.pinnedTaskbar, pinnedDesktop: a.pinnedDesktop })),
    apps,
    employees,
    employeeApps,
  };
}
type PlanState = Doc<"desiredHeads">["planState"];

/**
 * The newest version a device may already have applied before its first head:
 * Phase 2 documents (device or group scope, unsigned) and its last report.
 * Read only on a device's first publish, so its first signed version is
 * above anything it applied and is not taken for a rollback.
 */
async function legacyVersionFloor(ctx: { db: DatabaseReader }, device: Doc<"devices">): Promise<number> {
  let floor = 0;
  const summary = await ctx.db
    .query("deviceSummary")
    .withIndex("by_device", (q) => q.eq("deviceId", device._id))
    .unique();
  // The device reported this: untrusted. A value that is not a sane integer
  // (rows written before the report path sanitized it) counts as 0.
  floor = Math.max(floor, sanitizeVersion(summary?.appliedVersion) ?? 0);
  const scopes: string[] = [device._id];
  if (device.groupId !== undefined) scopes.push(device.groupId);
  for (const scope of scopes) {
    const row = await ctx.db
      .query("desiredStates")
      .withIndex("by_scope_version", (q) => q.eq("scope", scope))
      .order("desc")
      .first();
    floor = Math.max(floor, sanitizeVersion(row?.version) ?? 0);
  }
  return floor;
}

type RunState = {
  org: OrgInputs;
  key: SigningKey;
  groups: Map<string, GroupInputs>;
  seen: Set<string>;
  now: number;
  bytes: number;
};

/** Build, compare, sign and write one device (skips revoked devices and repeats within the run). */
async function publishDevice(ctx: MutationCtx, run: RunState, device: Doc<"devices">): Promise<void> {
  if (run.seen.has(device._id) || device.orgId !== run.org.org._id) return;
  run.seen.add(device._id);

  const cred = await ctx.db
    .query("deviceCredentials")
    .withIndex("by_device", (q) => q.eq("deviceId", device._id))
    .unique();
  const state = cred?.state ?? (device.revoked === true ? "revoked" : "active");
  if (state === "revoked") return;
  const planState: PlanState = state === "overLimit" || state === "suspended" ? state : "ok";

  const groupKey = device.groupId ?? "";
  let group = run.groups.get(groupKey);
  if (group === undefined) {
    group = await loadGroupInputs(ctx, device.orgId, device.groupId);
    run.groups.set(groupKey, group);
  }

  const input: BuildInput = {
    org: { _id: run.org.org._id, name: run.org.org.name },
    settings: run.org.settings,
    pinHash: run.org.pinHash,
    ...group,
    fileHandlers: run.org.fileHandlers,
    device: { _id: device._id, kioskEnabled: device.kioskEnabled !== false },
  };
  const rosterGroupId = group.group !== null ? (group.group._id as Id<"groups">) : undefined;
  const contentHash = contentHashOf(buildDeviceDoc(input));

  const head = await ctx.db
    .query("desiredHeads")
    .withIndex("by_device", (q) => q.eq("deviceId", device._id))
    .unique();
  if (head !== null && head.contentHash === contentHash && head.keyId === run.key.keyId) {
    // Same content signed by the same key: no new version (write only on change).
    if (
      head.pingIntervalMs !== run.org.pingIntervalMs ||
      head.planState !== planState ||
      head.rosterGroupId !== rosterGroupId
    ) {
      await ctx.db.patch(head._id, { pingIntervalMs: run.org.pingIntervalMs, planState, rosterGroupId });
    }
    return;
  }

  const version = (head !== null ? head.version : await legacyVersionFloor(ctx, device)) + 1;
  const doc = buildDeviceDoc(input, version);
  const payload = buildPayload({
    keyId: run.key.keyId,
    orgId: device.orgId,
    deviceId: device._id,
    version,
    issuedAtMs: run.now,
    doc,
  });
  const size = utf8Length(payload);
  if (size > MAX_PAYLOAD_BYTES) {
    await writeAudit(ctx, {
      orgId: device.orgId,
      actor: SYSTEM_ACTOR,
      action: "policy.publishFailed",
      targetType: "device",
      targetId: device._id,
      targetLabel: device.name,
      summary: `Could not publish to the PC ${device.name}: document too large`,
    });
    return;
  }

  const signature = signWith(run.key, payload);
  const bodyId = await ctx.db.insert("desiredBodies", {
    orgId: device.orgId,
    deviceId: device._id,
    version,
    payload,
    signature,
    keyId: run.key.keyId,
    contentHash,
    createdAt: run.now,
  });
  await ctx.db.insert("desiredVersions", {
    orgId: device.orgId,
    deviceId: device._id,
    version,
    reason: head === null ? "First signed document" : head.keyId !== run.key.keyId ? "Signed with a new key" : "Policy changed",
    createdAt: run.now,
    bodyId,
  });
  const headFields = {
    version,
    contentHash,
    keyId: run.key.keyId,
    bodyId,
    pingIntervalMs: run.org.pingIntervalMs,
    rosterGroupId,
    planState,
  };
  if (head === null) {
    await ctx.db.insert("desiredHeads", {
      deviceId: device._id,
      orgId: device.orgId,
      ...headFields,
      pingNonce: 0,
      fastUntil: 0,
    });
  } else {
    await ctx.db.patch(head._id, headFields);
  }
  run.bytes += size;

  // Keep the newest KEEP_VERSIONS: versions <= N - KEEP_VERSIONS go (by id).
  const old = await ctx.db
    .query("desiredVersions")
    .withIndex("by_device_version", (q) => q.eq("deviceId", device._id).lte("version", version - KEEP_VERSIONS))
    .take(MAX_PRUNE_PER_DEVICE);
  for (const row of old) {
    if ((await ctx.db.get(row.bodyId)) !== null) await ctx.db.delete(row.bodyId);
    await ctx.db.delete(row._id);
  }
}

/**
 * One device of a batch. A device whose document cannot be built or written
 * (bad data of its own) is skipped with an audit entry and does not abort the
 * run for the other 24. Everything that can throw for data reasons (the
 * version floor, the document, the payload, the signature) happens BEFORE the
 * first write of `publishDevice`, so a skipped device leaves no partial rows.
 * No value or error text goes into the entry.
 */
async function publishOne(ctx: MutationCtx, run: RunState, device: Doc<"devices">): Promise<void> {
  try {
    await publishDevice(ctx, run, device);
  } catch {
    await writeAudit(ctx, {
      orgId: device.orgId,
      actor: SYSTEM_ACTOR,
      action: "policy.publishFailed",
      targetType: "device",
      targetId: device._id,
      targetLabel: device.name,
      summary: `Could not publish to the PC ${device.name}: unexpected error`,
    });
  }
}

function dayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Missing or mismatched key: one audit entry per run, the failure time, the queue kept unscheduled. */
async function failRun(ctx: MutationCtx, queue: Doc<"publishQueue">, reason: "missing" | "mismatch", now: number) {
  await ctx.db.patch(queue._id, { scheduled: undefined });
  await writeAudit(ctx, {
    orgId: queue.orgId,
    actor: SYSTEM_ACTOR,
    action: "policy.publishFailed",
    targetType: "organization",
    targetId: queue.orgId,
    summary:
      reason === "missing"
        ? "Could not publish: signing key not configured"
        : "Could not publish: the deployment's signing key is not this organization's registered key",
  });
  const stats = await ctx.db
    .query("orgStats")
    .withIndex("by_org", (q) => q.eq("orgId", queue.orgId))
    .unique();
  if (stats !== null && stats.publishFailedAt === undefined) await ctx.db.patch(stats._id, { publishFailedAt: now });
}

export const run = internalMutation({
  args: { orgId: v.id("organizations") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const queue = await ctx.db
      .query("publishQueue")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .unique();
    if (queue === null) return null;
    const org = await ctx.db.get(args.orgId);
    if (org === null) {
      await ctx.db.delete(queue._id);
      return null;
    }
    const now = Date.now();
    const signing = await loadOrgSigningKey(ctx, args.orgId, "active");
    if (!signing.ok) {
      await failRun(ctx, queue, signing.reason, now);
      return null;
    }

    const runState: RunState = {
      org: await loadOrgInputs(ctx, org),
      key: signing.key,
      groups: new Map(),
      seen: new Set(),
      now,
      bytes: 0,
    };

    // What is left after this run (one paginated query per run at most).
    let deviceIds = queue.deviceIds;
    let groupIds = queue.groupIds;
    let allDevices = queue.allDevices;
    let cursor = queue.cursor;

    if (deviceIds.length > 0) {
      const batch = deviceIds.slice(0, PUBLISH_BATCH);
      deviceIds = deviceIds.slice(PUBLISH_BATCH);
      for (const id of batch) {
        const device = await ctx.db.get(id);
        if (device !== null) await publishOne(ctx, runState, device);
      }
    } else if (groupIds.length > 0 || allDevices) {
      const opts = { numItems: PUBLISH_BATCH, cursor: cursor ?? null };
      const firstGroup = groupIds[0];
      const page: PaginationResult<Doc<"devices">> =
        !allDevices && firstGroup !== undefined
          ? await ctx.db
              .query("devices")
              .withIndex("by_group", (q) => q.eq("groupId", firstGroup))
              .paginate(opts)
          : await ctx.db
              .query("devices")
              .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
              .paginate(opts);
      for (const device of page.page) await publishOne(ctx, runState, device);
      if (page.isDone) {
        cursor = undefined;
        if (allDevices) allDevices = false;
        else groupIds = groupIds.slice(1);
      } else {
        cursor = page.continueCursor;
      }
    }

    // Day counter of payload bytes (Step 8 item 14) and the recovery from a failed run.
    const stats = await ctx.db
      .query("orgStats")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .unique();
    if (stats !== null && (runState.bytes > 0 || stats.publishFailedAt !== undefined)) {
      const day = dayOf(now);
      const patch: Partial<Doc<"orgStats">> = { publishFailedAt: undefined };
      if (runState.bytes > 0) {
        patch.publishBytesDay = day;
        patch.publishBytesToday = (stats.publishBytesDay === day ? (stats.publishBytesToday ?? 0) : 0) + runState.bytes;
      }
      await ctx.db.patch(stats._id, patch);
    }

    if (deviceIds.length === 0 && groupIds.length === 0 && !allDevices) {
      await ctx.db.delete(queue._id);
      return null;
    }
    const scheduled = await ctx.scheduler.runAfter(0, internal.publish.run, { orgId: args.orgId });
    // `requestedAt` renews the lease (a run that throws never gets here, so
    // `requestPublish` reschedules once the lease ran out).
    await ctx.db.patch(queue._id, { deviceIds, groupIds, allDevices, cursor, scheduled, requestedAt: now });
    return null;
  },
});
