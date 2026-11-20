import type { PaginationResult } from "convex/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { type DatabaseReader, type MutationCtx } from "./_generated/server";
import { internalMutation } from "./lib/functions";
import { SYSTEM_ACTOR, writeAudit } from "./lib/audit";
import { base64Decode } from "./lib/crypto";
import {
  BrowserLimitError,
  buildDeviceDoc,
  buildPayload,
  contentHashOf,
  MAX_PAYLOAD_BYTES,
  utf8Length,
  type BuildApp,
  type BuildInput,
  type DocBroadcast,
  type Phase5Input,
} from "./lib/desired";
import { buildAppOf, configForRing, newGroupConfigCache, type ConfigCatalog, type GroupConfigCache, type GroupConfigContent } from "./lib/groupConfig";
import type { RingValue, SealedBoxValue } from "./lib/lockdownValidators";
import {
  BROADCAST_READ,
  MAX_ACTIVE_BROADCASTS,
  KEEP_VERSIONS,
  GROUP_LOAD_WORST_DOCS,
  GROUP_LOAD_WORST_RANGES,
  MAX_EMPLOYEE_APPS,
  MAX_FILE_HANDLERS,
  MAX_GROUP_APPS,
  MAX_GROUP_GRANT_APPS,
  MAX_GROUP_GRANT_EMPLOYEES,
  MAX_PRUNE_PER_DEVICE,
  PUBLISH_BATCH,
  RUN_DOC_BUDGET,
  RUN_RANGE_BUDGET,
} from "./lib/limits";
import { scheduleRosterResync } from "./lib/employeeSync";
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

/**
 * Group-level inputs, loaded once per group (and per configuration version, Step 16b) per run and shared by its devices.
 * `fileHandlers` is set only when the catalogue comes from a configuration version (else the organization's live rules apply).
 */
type GroupInputs = Pick<BuildInput, "group" | "assignments" | "apps" | "employees" | "employeeApps"> & { fileHandlers?: BuildInput["fileHandlers"] };

/** The live direct grants of a group's enabled members and what reading them cost. One load per group and run, whatever the ring. */
export type GrantLoad = { employees: GroupInputs["employees"]; employeeApps: GroupInputs["employeeApps"]; ranges: number; docs: number };

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

/** A group's inputs and what loading them cost: index ranges (db.get + db.query calls) and documents read. */
export type GroupLoad = { inputs: GroupInputs; ranges: number; docs: number };

/**
 * The group's catalogue inputs: the group, its app assignments, the direct
 * grants of its enabled members (Step 11) and the apps they name (with the
 * icon's stable address from file storage). The members' sign-in rights are NOT
 * here: they are the signed roster (A6). Archived apps are loaded and left out
 * by the builder, so archiving removes an app from every document.
 *
 * BOUNDED WORK (Step 11 review; the Convex limits are in `lib/limits.ts`): the
 * members with direct grants come from ONE range of
 * `groupMembers.by_group_grants` (the flag `grantsActive` = enabled and has a
 * grant, kept by `lib/employeeSync`), so a group with none costs one read
 * however many members it has, and one with some costs at most
 * MAX_GROUP_GRANT_EMPLOYEES members x (1 grant range + MAX_EMPLOYEE_APPS rows)
 * and MAX_GROUP_GRANT_APPS granted apps. Beyond those caps the group degrades:
 * the first ones (oldest first) are kept and ONE `policy.publishFailed` audit
 * entry says some employees' direct apps were left out of this group's
 * documents (nothing loops, nothing throws). The returned cost lets the
 * publisher stop loading groups before its transaction limits.
 *
 * RING-GATED CATALOGUE (Step 16b, plan 4.3 rule 6): with `frozen` (the `catalog` of the
 * configuration version the device's ring points to) the assignments, the records of the
 * assigned apps and the file-type rules come from that version: no `appAssignments` range
 * and no app reads. The direct grants stay live (the directory never waits for a pilot),
 * and so does the record of a web app the frozen assignments do not name. `grants` shares
 * the live grant load between the versions of one group in a run (rings mid-rollout).
 */
export async function loadGroupInputs(
  ctx: Pick<MutationCtx, "db" | "storage">,
  orgId: Id<"organizations">,
  groupId: Id<"groups"> | undefined,
  frozen?: ConfigCatalog,
  grants?: Map<string, GrantLoad>,
): Promise<GroupLoad> {
  const none: GroupInputs = { group: null, assignments: [], apps: [], employees: [], employeeApps: [] };
  if (groupId === undefined) return { inputs: none, ranges: 0, docs: 0 };
  const group = await ctx.db.get(groupId);
  let ranges = 1;
  let docs = group === null ? 0 : 1;
  if (group === null || group.orgId !== orgId) return { inputs: none, ranges, docs };
  let assignments: GroupInputs["assignments"];
  if (frozen !== undefined) {
    assignments = frozen.assignments;
  } else {
    const rows = await ctx.db
      .query("appAssignments")
      .withIndex("by_group", (q) => q.eq("groupId", group._id))
      .take(MAX_GROUP_APPS);
    ranges++;
    docs += rows.length;
    assignments = rows.map((a) => ({ appId: a.appId, audience: a.audience, pinnedTaskbar: a.pinnedTaskbar, pinnedDesktop: a.pinnedDesktop }));
  }

  let grant = grants?.get(group._id);
  if (grant === undefined) {
    grant = await loadGrants(ctx, orgId, group);
    grants?.set(group._id, grant);
    ranges += grant.ranges;
    docs += grant.docs;
  }
  const { employees, employeeApps } = grant;

  const apps: BuildApp[] = [];
  // Frozen records first: an app the version's assignments name is never read live.
  const frozenIds = new Set<string>(assignments.map((a) => a.appId));
  if (frozen !== undefined) {
    for (const a of frozen.apps) {
      const url = a.icon !== null ? await ctx.storage.getUrl(a.icon.storageId as Id<"_storage">) : null;
      apps.push(buildAppOf(a, a.icon !== null && url !== null ? { url, sha256: a.icon.sha256 } : undefined));
    }
  }
  // Every other app an assignment or a grant names (assigned ones first), once.
  const appIds = new Set<Id<"apps">>();
  if (frozen === undefined) for (const a of assignments) appIds.add(a.appId as Id<"apps">);
  for (const g of employeeApps) if (frozen === undefined || !frozenIds.has(g.appId)) appIds.add(g.appId as Id<"apps">);
  ranges += appIds.size;
  docs += appIds.size;
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
    inputs: {
      group: { _id: group._id },
      assignments,
      apps,
      employees,
      employeeApps,
      ...(frozen === undefined ? {} : { fileHandlers: frozen.fileHandlers }),
    },
    ranges,
    docs,
  };
}

/** The direct grants of the group's enabled members (see `loadGroupInputs`: bounded, degrades with one audit entry). */
async function loadGrants(ctx: Pick<MutationCtx, "db">, orgId: Id<"organizations">, group: Doc<"groups">): Promise<GrantLoad> {
  let ranges = 0;
  let docs = 0;
  // Direct grants: only the enabled members that have any (the flag is never stale-false).
  const members = await ctx.db
    .query("groupMembers")
    .withIndex("by_group_grants", (q) => q.eq("groupId", group._id).eq("grantsActive", true))
    .take(MAX_GROUP_GRANT_EMPLOYEES + 1);
  ranges++;
  docs += members.length;
  let truncated = members.length > MAX_GROUP_GRANT_EMPLOYEES;
  const employees: GroupInputs["employees"] = [];
  const employeeApps: GroupInputs["employeeApps"] = [];
  const grantedApps = new Set<string>();
  for (const m of members.slice(0, MAX_GROUP_GRANT_EMPLOYEES)) {
    if (m.orgId !== orgId) continue;
    const grants = await ctx.db
      .query("employeeApps")
      .withIndex("by_employee", (q) => q.eq("employeeId", m.employeeId))
      .take(MAX_EMPLOYEE_APPS);
    ranges++;
    docs += grants.length;
    const kept = [];
    for (const g of grants) {
      if (g.orgId !== orgId) continue;
      if (!grantedApps.has(g.appId) && grantedApps.size >= MAX_GROUP_GRANT_APPS) {
        truncated = true;
        continue;
      }
      grantedApps.add(g.appId);
      kept.push(g);
    }
    if (kept.length === 0) continue;
    employees.push({ _id: m.employeeId, disabled: false });
    for (const g of kept) employeeApps.push({ employeeId: m.employeeId, appId: g.appId });
  }
  if (truncated) {
    await writeAudit(ctx, {
      orgId,
      actor: SYSTEM_ACTOR,
      action: "policy.publishFailed",
      targetType: "group",
      targetId: group._id,
      targetLabel: group.name,
      summary: `The group ${group.name} has too many employees or apps given directly: some were left out of its documents (limit ${MAX_GROUP_GRANT_EMPLOYEES} employees, ${MAX_GROUP_GRANT_APPS} apps)`,
    });
  }
  return { employees, employeeApps, ranges, docs };
}
type PlanState = Doc<"desiredHeads">["planState"];

/** Live broadcasts of one target, newest first, without cancelled and expired ones (`broadcasts.by_target_created`, <= BROADCAST_READ rows). */
async function liveBroadcasts(
  ctx: { db: DatabaseReader },
  orgId: Id<"organizations">,
  kind: "group" | "device",
  id: string,
  now: number,
): Promise<DocBroadcast[]> {
  const rows = await ctx.db
    .query("broadcasts")
    .withIndex("by_target_created", (q) => q.eq("target.kind", kind).eq("target.id", id))
    .order("desc")
    .take(BROADCAST_READ);
  return rows
    .filter((b) => b.orgId === orgId && b.cancelledAt === undefined && (b.expiresAt === undefined || b.expiresAt > now))
    .map((b) => ({
      id: b._id as string,
      style: b.style,
      title: b.title,
      body: b.body,
      expiresAtMs: b.expiresAt ?? null,
      ackRequired: b.ackRequired,
      issuedAtMs: b.createdAt,
    }));
}

/** The device's sealed Wi-Fi boxes that are current: sealed for this profile revision or a newer one, and for this device's sealing key. */
async function sealedBoxesOf(
  ctx: { db: DatabaseReader },
  device: Doc<"devices">,
  wifi: GroupConfigContent["wifi"],
): Promise<Record<string, SealedBoxValue>> {
  const out: Record<string, SealedBoxValue> = {};
  if (device.sealKeyId === undefined) return out;
  for (const w of wifi) {
    if (!w.hasPassphrase) continue;
    const row = await ctx.db
      .query("deviceSealedSecrets")
      .withIndex("by_device_target", (q) => q.eq("deviceId", device._id).eq("purpose", "wifi").eq("targetId", w.id))
      .first();
    // A box for this profile revision OR A NEWER ONE: a PC on an older ring pointer (Step 16) names an older profile revision than the
    // live one the box was sealed for. The box is bound to the device, not to a revision, and holds the live passphrase (the only one kept).
    if (row === null || row.targetRevision < w.revision || row.sealKeyId !== device.sealKeyId) continue;
    const raw = base64Decode(row.sealed);
    if (raw === null) continue;
    try {
      const box = JSON.parse(new TextDecoder().decode(raw)) as SealedBoxValue;
      if (box.v === 1 && typeof box.ct === "string") out[w.id] = box;
    } catch {
      // A damaged box is treated as missing (the agent reports `waiting_for_key`).
    }
  }
  return out;
}

/**
 * The Phase 5 inputs of one device (plan 4.3, 4.14, 4.17): the group configuration its ring
 * points to, its sealed Wi-Fi boxes and the live lock, broadcasts and USB window. `undefined`
 * (no Phase 5 data at all) keeps the document exactly the Phase 4 one.
 */
async function loadPhase5(
  ctx: { db: DatabaseReader },
  run: RunState,
  device: Doc<"devices">,
  ring: RingValue,
  cfg: Awaited<ReturnType<typeof configForRing>>,
): Promise<Phase5Input | undefined> {
  const lock = await ctx.db
    .query("deviceLocks")
    .withIndex("by_device", (q) => q.eq("deviceId", device._id))
    .first();

  let groupLive: DocBroadcast[] = [];
  if (device.groupId !== undefined) {
    const cached = run.groupBroadcasts.get(device.groupId);
    groupLive = cached ?? (await liveBroadcasts(ctx, device.orgId, "group", device.groupId, run.now));
    if (cached === undefined) run.groupBroadcasts.set(device.groupId, groupLive);
  }
  const deviceLive = await liveBroadcasts(ctx, device.orgId, "device", device._id, run.now);
  const broadcasts = [...groupLive, ...deviceLive]
    .sort((a, b) => b.issuedAtMs - a.issuedAtMs || (a.id < b.id ? -1 : 1))
    .slice(0, MAX_ACTIVE_BROADCASTS);
  const usbUntil = device.usbTempAllowUntil !== undefined && device.usbTempAllowUntil > run.now ? device.usbTempAllowUntil : null;

  const sealed = cfg === null ? {} : await sealedBoxesOf(ctx, device, cfg.content.wifi);
  // A secured profile without a current box for a device that CAN be sealed for: the document goes out without it
  // (the agent says `waiting_for_key`) and the sealing action runs; its boxes make the next publish carry them.
  if (cfg !== null && device.sealKeyId !== undefined && device.sealPublicKey !== undefined && cfg.content.wifi.some((w) => w.hasPassphrase && sealed[w.id] === undefined)) {
    run.needSeal.add(device._id);
  }

  if (cfg === null && lock === null && broadcasts.length === 0 && usbUntil === null) return undefined;
  return {
    config:
      cfg === null || device.groupId === undefined
        ? null
        : { groupId: device.groupId, version: cfg.version, ring, content: cfg.content },
    sealed,
    deviceLock:
      lock === null ? null : { lockId: lock.lockId, message: lock.message, contact: lock.contact ?? null, lockedAtMs: lock.lockedAt },
    usbTempAllowUntilMs: usbUntil,
    broadcasts,
    nowMs: run.now,
  };
}

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
  /** Phase 5: group configuration pointers / versions and group-target broadcasts, loaded once per group per run. */
  configs: GroupConfigCache;
  groupBroadcasts: Map<string, DocBroadcast[]>;
  /** Keyed by group and, when the catalogue is ring-gated, by configuration version (Step 16b). */
  groups: Map<string, GroupInputs>;
  /** The live direct grants per group (shared by the versions of one group). */
  grants: Map<string, GrantLoad>;
  seen: Set<string>;
  /** Devices that have a sealing key and need a Wi-Fi box they do not have yet (Step 13): `seal:forDevices` once per run. */
  needSeal: Set<Id<"devices">>;
  now: number;
  bytes: number;
  /** Groups loaded so far in this run, and the ranges / documents their loads read (the run budget). */
  groupLoads: number;
  ranges: number;
  docs: number;
};

/**
 * Build, compare, sign and write one device (skips revoked devices and repeats
 * within the run). "deferred" = this device would need a group whose worst-case
 * load no longer fits the run's read budget: nothing was done for it and the
 * caller puts it (and the rest of its batch) back in the queue for the next hop.
 * The first group of a run is always loaded, so every hop makes progress.
 */
async function publishDevice(ctx: MutationCtx, run: RunState, device: Doc<"devices">): Promise<"done" | "deferred"> {
  if (run.seen.has(device._id) || device.orgId !== run.org.org._id) return "done";
  // The configuration version this PC's ring points to (cached per group and version in the run): since Step 16b it also
  // decides which catalogue the PC gets, so it is resolved before the group load.
  const ring: RingValue = device.ring ?? "everyone";
  const cfg = device.groupId === undefined ? null : await configForRing(ctx, device.groupId, ring, run.configs);
  const frozen = cfg?.content.catalog;
  const groupKey = device.groupId === undefined ? "" : frozen === undefined || cfg === null ? device.groupId : `${device.groupId}:${cfg.version}`;
  let group = run.groups.get(groupKey);
  if (
    group === undefined &&
    device.groupId !== undefined &&
    run.groupLoads > 0 &&
    (run.ranges + GROUP_LOAD_WORST_RANGES > RUN_RANGE_BUDGET || run.docs + GROUP_LOAD_WORST_DOCS > RUN_DOC_BUDGET)
  ) {
    return "deferred";
  }
  run.seen.add(device._id);

  const cred = await ctx.db
    .query("deviceCredentials")
    .withIndex("by_device", (q) => q.eq("deviceId", device._id))
    .unique();
  const state = cred?.state ?? (device.revoked === true ? "revoked" : "active");
  if (state === "revoked") return "done";
  const planState: PlanState = state === "overLimit" || state === "suspended" ? state : "ok";

  if (group === undefined) {
    const load = await loadGroupInputs(ctx, device.orgId, device.groupId, frozen, run.grants);
    group = load.inputs;
    run.groups.set(groupKey, group);
    if (device.groupId !== undefined) run.groupLoads++;
    run.ranges += load.ranges;
    run.docs += load.docs;
  }

  const phase5 = await loadPhase5(ctx, run, device, ring, cfg);
  const input: BuildInput = {
    ...(phase5 === undefined ? {} : { phase5 }),
    org: { _id: run.org.org._id, name: run.org.org.name },
    settings: run.org.settings,
    pinHash: run.org.pinHash,
    group: group.group,
    assignments: group.assignments,
    apps: group.apps,
    employees: group.employees,
    employeeApps: group.employeeApps,
    fileHandlers: group.fileHandlers ?? run.org.fileHandlers,
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
    return "done";
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
    return "done";
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
  return "done";
}

/**
 * One device of a batch. A device whose document cannot be built or written
 * (bad data of its own) is skipped with an audit entry and does not abort the
 * run for the other 24. Everything that can throw for data reasons (the
 * version floor, the document, the payload, the signature) happens BEFORE the
 * first write of `publishDevice`, so a skipped device leaves no partial rows.
 * No value or error text goes into the entry.
 */
async function publishOne(ctx: MutationCtx, run: RunState, device: Doc<"devices">): Promise<"done" | "deferred"> {
  try {
    return await publishDevice(ctx, run, device);
  } catch (e) {
    // Phase 6 Step 16 (plan 4.3): the group's browser web apps are more than a device document may carry. Said with the
    // group's name, so the admin knows which group to trim; the other PCs and groups are not touched.
    if (e instanceof BrowserLimitError) {
      const group = device.groupId !== undefined ? await ctx.db.get(device.groupId) : null;
      const what = e.limit === "too_many_browser_apps" ? "browser web apps (limit 60)" : "browser web addresses (limit 800)";
      await writeAudit(ctx, {
        orgId: device.orgId,
        actor: SYSTEM_ACTOR,
        action: "policy.publishFailed",
        targetType: "device",
        targetId: device._id,
        targetLabel: device.name,
        summary: `Could not publish to the PC ${device.name}: the group ${group?.name ?? "of this PC"} has too many ${what}`,
      });
      return "done";
    }
    await writeAudit(ctx, {
      orgId: device.orgId,
      actor: SYSTEM_ACTOR,
      action: "policy.publishFailed",
      targetType: "device",
      targetId: device._id,
      targetLabel: device.name,
      summary: `Could not publish to the PC ${device.name}: unexpected error`,
    });
    return "done";
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
      configs: newGroupConfigCache(),
      groupBroadcasts: new Map(),
      groups: new Map(),
      grants: new Map(),
      seen: new Set(),
      needSeal: new Set(),
      now,
      bytes: 0,
      groupLoads: 0,
      ranges: 0,
      docs: 0,
    };
    // A valid key: sign the employee removals that waited for one (1 read when none).
    await scheduleRosterResync(ctx, args.orgId);

    // What is left after this run (one paginated query per run at most).
    let deviceIds = queue.deviceIds;
    let groupIds = queue.groupIds;
    let allDevices = queue.allDevices;
    let cursor = queue.cursor;

    if (deviceIds.length > 0) {
      const batch = deviceIds.slice(0, PUBLISH_BATCH);
      deviceIds = deviceIds.slice(PUBLISH_BATCH);
      for (const [i, id] of batch.entries()) {
        const device = await ctx.db.get(id);
        if (device !== null && (await publishOne(ctx, runState, device)) === "deferred") {
          // The run's read budget is spent: this device and the rest wait for the next hop.
          deviceIds = [...batch.slice(i), ...deviceIds];
          break;
        }
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
      for (const [i, device] of page.page.entries()) {
        if ((await publishOne(ctx, runState, device)) === "deferred") {
          // Read budget spent: the rest of this page becomes an explicit device list, handled first next hop.
          deviceIds = page.page.slice(i).map((d) => d._id);
          break;
        }
      }
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

    if (runState.needSeal.size > 0) {
      await ctx.scheduler.runAfter(0, internal.seal.forDevices, { orgId: args.orgId, deviceIds: [...runState.needSeal] });
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
