import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseReader, MutationCtx } from "../_generated/server";
import { sha256HexSync } from "./crypto";
import { fail } from "./errors";
import {
  KEEP_GROUP_CONFIGS,
  MAX_DEVICE_DRIVERS,
  MAX_DEVICE_PRINTERS,
  MAX_DEVICE_WIFI,
  MAX_GROUP_CONFIG_BYTES,
  MAX_GROUP_EXCEPTIONS,
  MAX_ORG_DRIVERS,
  MAX_ORG_PRINTERS,
  MAX_WIFI_PROFILES,
  PRUNE_GROUP_CONFIGS_PER_RUN,
} from "./limits";
import { DEFAULT_LOCKDOWN_SETTINGS, type LockdownSettings, type RingValue } from "./lockdownValidators";
import { requestPublish } from "./publish";

// Group configuration versions (Phase 5 Step 10, plan 4.14). The unit of rollout is a
// GROUP CONFIGURATION VERSION: the ring-gated Phase 5 inputs of one group (lockdown
// settings, exceptions, Wi-Fi profiles, printers) frozen as one JSON object. Every edit of
// such an input calls `snapshotGroupConfig` before `requestPublish`; the publisher builds
// each device's document from the version its ring points to plus the LIVE inputs (lock,
// broadcasts, USB allow window, the device's own sealed Wi-Fi boxes).
//
// SCOPE CHOICE (reported): the Phase 4 catalogue inputs (app assignments, app records, file
// handlers, allowed sites) stay LIVE in the publisher for now. Moving them into the snapshot
// would require every Phase 4 mutation that touches them to snapshot first and would change
// what the Phase 4 tests build; Step 16 (rings) does that together with the ring gating of
// apps. Nothing here changes a Phase 4 document: a group with no snapshot gets none of the
// new keys.

// ---------------------------------------------------------------- content (what is frozen)

/** One exception as the document carries it (`rulebox_policy::ExceptionRule`, key order = field order). */
export type DocException = {
  id: string;
  appId: string | null;
  kind: "publisher" | "hash" | "path";
  publisher: { subject: string; product: string | null; fileName: string | null } | null;
  sha256: string | null;
  path: string | null;
  layers: ("appLocker" | "procWatch")[];
};

/** The `lockdown` section of the document, key order of plan 4.3. */
export type DocLockdown = {
  staff: LockdownSettings["staff"];
  machine: LockdownSettings["machine"];
  appLocker: LockdownSettings["appLocker"];
  appControl: LockdownSettings["appControl"];
  procWatch: LockdownSettings["procWatch"];
  exceptions: DocException[];
  keyboard: LockdownSettings["keyboard"];
  usb: LockdownSettings["usb"];
  accessibilityTools: boolean;
  boot: LockdownSettings["boot"];
  performance: LockdownSettings["performance"];
};

/** A Wi-Fi profile without its box: `hasPassphrase` says whether a sealed box is expected per device. */
export type ConfigWifi = {
  id: string;
  ssid: string;
  hidden: boolean;
  security: Doc<"wifiProfiles">["security"];
  autoConnect: boolean;
  revision: number;
  hasPassphrase: boolean;
};

export type ConfigPrinter = {
  id: string;
  name: string;
  kind: Doc<"printers">["kind"];
  address: string;
  port: number | null;
  queue: string | null;
  driver: string;
  isDefault: boolean;
  revision: number;
};

/** (Step 14b) A driver package as the document carries it (key order = `rulebox_policy::DriverSpec`). */
export type ConfigDriver = {
  id: string;
  name: string;
  kind: Doc<"drivers">["kind"];
  url: string;
  sha256: string;
  sizeBytes: number;
  inf: string | null;
  silentArgs: string[];
  successExitCodes: number[];
  revision: number;
};

export type GroupConfigContent = {
  lockdown: DocLockdown;
  wifiManagedOnly: boolean;
  wifi: ConfigWifi[];
  printers: ConfigPrinter[];
  /** Absent in versions made before Step 14b, and omitted from the stored text when empty (their content hash stays the same). */
  drivers?: ConfigDriver[];
};

const byId = <T extends { id: string }>(a: T, b: T): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function docException(row: Pick<Doc<"lockdownExceptions">, "_id" | "appId" | "rule">): DocException {
  const r = row.rule;
  return {
    id: row._id,
    appId: row.appId ?? null,
    kind: r.kind,
    publisher:
      r.publisher === undefined
        ? null
        : { subject: r.publisher.subject, product: r.publisher.product ?? null, fileName: r.publisher.fileName ?? null },
    sha256: r.sha256 ?? null,
    path: r.path ?? null,
    layers: [...r.layers],
  };
}

export type ConfigInputs = {
  /** `groupLockdown.settings`, else the organization's new-group defaults, else the built-in defaults. */
  settings: LockdownSettings;
  /** The group's exceptions and the organization-wide ones. */
  exceptions: Pick<Doc<"lockdownExceptions">, "_id" | "appId" | "rule">[];
  /** The organization's Wi-Fi profiles and printers; this function keeps those assigned to `groupId`. */
  wifi: Pick<Doc<"wifiProfiles">, "_id" | "ssid" | "hidden" | "security" | "autoConnect" | "revision" | "passphrase" | "groupIds">[];
  printers: Pick<
    Doc<"printers">,
    "_id" | "name" | "kind" | "address" | "port" | "queue" | "driver" | "revision" | "groupIds" | "defaultForGroupIds"
  >[];
  /** (Step 14b) The organization's driver packages; this function keeps those assigned to `groupId`. */
  drivers: Pick<Doc<"drivers">, "_id" | "name" | "kind" | "url" | "sha256" | "sizeBytes" | "inf" | "silentArgs" | "successExitCodes" | "revision" | "groupIds">[];
};

/**
 * PURE. The frozen content of one group (plan 4.14 step 1): arrays sorted by id, integers
 * only, absent optionals `null`. Refuses (`invalid_argument`) above the limits of plan 4.3
 * rule 4, so an oversized configuration is never stored.
 */
export function buildGroupConfig(groupId: string, input: ConfigInputs): GroupConfigContent {
  const s = input.settings;
  const exceptions = input.exceptions.map(docException).sort(byId);
  if (exceptions.length > MAX_GROUP_EXCEPTIONS) fail("invalid_argument", { field: "exceptions", detail: "too_many" });
  const wifi: ConfigWifi[] = input.wifi
    .filter((w) => (w.groupIds as string[]).includes(groupId))
    .map((w) => ({
      id: w._id,
      ssid: w.ssid,
      hidden: w.hidden,
      security: w.security,
      autoConnect: w.autoConnect,
      revision: w.revision,
      hasPassphrase: w.security !== "open" && w.passphrase !== undefined,
    }))
    .sort(byId);
  if (wifi.length > MAX_DEVICE_WIFI) fail("invalid_argument", { field: "wifi", detail: "too_many" });
  const printers: ConfigPrinter[] = input.printers
    .filter((p) => (p.groupIds as string[]).includes(groupId))
    .map((p) => ({
      id: p._id,
      name: p.name,
      kind: p.kind,
      address: p.address,
      port: p.port ?? null,
      queue: p.queue ?? null,
      driver: p.driver,
      isDefault: (p.defaultForGroupIds as string[]).includes(groupId),
      revision: p.revision,
    }))
    .sort(byId);
  if (printers.length > MAX_DEVICE_PRINTERS) fail("invalid_argument", { field: "printers", detail: "too_many" });
  const drivers: ConfigDriver[] = input.drivers
    .filter((d) => (d.groupIds as string[]).includes(groupId))
    .map((d) => ({
      id: d._id,
      name: d.name,
      kind: d.kind,
      url: d.url,
      sha256: d.sha256,
      sizeBytes: d.sizeBytes,
      inf: d.inf ?? null,
      silentArgs: [...d.silentArgs],
      successExitCodes: [...d.successExitCodes],
      revision: d.revision,
    }))
    .sort(byId);
  if (drivers.length > MAX_DEVICE_DRIVERS) fail("invalid_argument", { field: "drivers", detail: "too_many" });
  return {
    lockdown: {
      staff: { ...s.staff },
      machine: { ...s.machine, accountLockout: s.machine.accountLockout === null ? null : { ...s.machine.accountLockout } },
      appLocker: { mode: s.appLocker.mode },
      appControl: { mode: s.appControl.mode, level: s.appControl.level },
      procWatch: { mode: s.procWatch.mode },
      exceptions,
      keyboard: { winCombos: s.keyboard.winCombos },
      usb: { ...s.usb },
      accessibilityTools: s.accessibilityTools,
      boot: { ...s.boot },
      performance: { ...s.performance },
    },
    wifiManagedOnly: s.wifiManagedOnly,
    wifi,
    printers,
    drivers,
  };
}

/** The text that is stored and hashed. */
export function serializeGroupConfig(content: GroupConfigContent): string {
  // An empty `drivers` is left out, so a group without drivers keeps the content hash it had before Step 14b.
  const { drivers, ...rest } = content;
  const text = JSON.stringify(drivers === undefined || drivers.length === 0 ? rest : content);
  if (new TextEncoder().encode(text).length > MAX_GROUP_CONFIG_BYTES) fail("invalid_argument", { field: "groupConfig", detail: "too_large" });
  return text;
}

/** Parse a stored configuration; null when it is not an object with the four sections (a damaged row). */
export function parseGroupConfig(text: string): GroupConfigContent | null {
  try {
    const c = JSON.parse(text) as Partial<GroupConfigContent> | null;
    if (c === null || typeof c !== "object" || c.lockdown === undefined || !Array.isArray(c.wifi) || !Array.isArray(c.printers)) return null;
    return c as GroupConfigContent;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- loading and snapshotting

/** Reads the live inputs of one group: bounded `.take`s through indexes, no scans. */
export async function loadConfigInputs(
  ctx: { db: DatabaseReader },
  orgId: Id<"organizations">,
  groupId: Id<"groups">,
): Promise<ConfigInputs> {
  const lockdown = await ctx.db
    .query("groupLockdown")
    .withIndex("by_group", (q) => q.eq("groupId", groupId))
    .unique();
  let settings = lockdown?.settings;
  if (settings === undefined) {
    const org = await ctx.db.get(orgId);
    settings = org?.phase5Settings?.newGroupDefaults ?? DEFAULT_LOCKDOWN_SETTINGS;
  }
  const own = await ctx.db
    .query("lockdownExceptions")
    .withIndex("by_org_group", (q) => q.eq("orgId", orgId).eq("groupId", groupId))
    .take(MAX_GROUP_EXCEPTIONS + 1);
  // Organization-wide exceptions have no group.
  const orgWide = await ctx.db
    .query("lockdownExceptions")
    .withIndex("by_org_group", (q) => q.eq("orgId", orgId).eq("groupId", undefined))
    .take(MAX_GROUP_EXCEPTIONS + 1);
  const wifi = await ctx.db
    .query("wifiProfiles")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .take(MAX_WIFI_PROFILES + 1);
  const printers = await ctx.db
    .query("printers")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .take(MAX_ORG_PRINTERS + 1);
  const drivers = await ctx.db
    .query("drivers")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .take(MAX_ORG_DRIVERS + 1);
  return { settings, exceptions: [...own, ...orgWide], wifi, printers, drivers };
}

/** One entry of `groupRollouts.versions`: what the rollout screen lists (never the configuration text). */
export type ConfigVersionEntry = { version: number; reason: string; createdAt: number };

/**
 * The version list after `entry` is added: the newest KEEP_GROUP_CONFIGS versions plus any older one a pointer still names
 * (those are never pruned). Null when the list would not change (no write). Sorted by version, newest last.
 */
export function withVersion(
  current: ConfigVersionEntry[] | undefined,
  entry: ConfigVersionEntry,
  keepFrom: number,
  pointers: { pilot: number; early: number; everyone: number },
): ConfigVersionEntry[] | null {
  const have = current ?? [];
  const merged = have.some((e) => e.version === entry.version) ? have : [...have, entry];
  const kept = merged
    .filter((e) => e.version >= keepFrom || e.version === pointers.pilot || e.version === pointers.early || e.version === pointers.everyone)
    .sort((a, b) => a.version - b.version);
  const same = kept.length === have.length && kept.every((e, i) => e.version === have[i]?.version);
  return same ? null : kept;
}
export type SnapshotResult = { changed: boolean; version: number };

/**
 * Plan 4.14 steps 1-5. Builds the group's configuration from the live tables; when its
 * content hash equals the newest version's, writes nothing. Else inserts version
 * `newest + 1`, prunes versions below `newest - 19` that no pointer references (10 per
 * run), moves the pointers (rings disabled or no rollout row: all three; rings enabled:
 * `pilot` only, state `rolling`) and asks for a publish of the group's devices.
 * Call it inside the mutation that changed an input, BEFORE `requestPublish`.
 */
export async function snapshotGroupConfig(
  ctx: Pick<MutationCtx, "db" | "scheduler">,
  groupId: Id<"groups">,
  reason: string,
  createdBy?: Id<"members">,
): Promise<SnapshotResult> {
  const group = await ctx.db.get(groupId);
  if (group === null) fail("not_found");
  const orgId = group.orgId;
  const content = buildGroupConfig(groupId, await loadConfigInputs(ctx, orgId, groupId));
  const text = serializeGroupConfig(content);
  const contentHash = sha256HexSync(text);

  const newest = await ctx.db
    .query("groupConfigs")
    .withIndex("by_group_version", (q) => q.eq("groupId", groupId))
    .order("desc")
    .first();
  const rollout = await ctx.db
    .query("groupRollouts")
    .withIndex("by_group", (q) => q.eq("groupId", groupId))
    .unique();
  if (newest !== null && newest.contentHash === contentHash && rollout !== null) {
    return { changed: false, version: newest.version };
  }

  const now = Date.now();
  let version = newest?.version ?? 0;
  if (newest === null || newest.contentHash !== contentHash) {
    version = (newest?.version ?? 0) + 1;
    await ctx.db.insert("groupConfigs", {
      orgId,
      groupId,
      version,
      config: text,
      contentHash,
      createdBy,
      createdAt: now,
      reason: reason.slice(0, 120),
    });
  }

  // Pointers and the version list the rollout screen shows (so it never has to read the configurations themselves).
  const entry: ConfigVersionEntry =
    newest !== null && newest.contentHash === contentHash && newest.version === version
      ? { version, reason: newest.reason, createdAt: newest.createdAt }
      : { version, reason: reason.slice(0, 120), createdAt: now };
  const keepFrom = version - (KEEP_GROUP_CONFIGS - 1);
  let pointers: Doc<"groupRollouts">["pointers"];
  if (rollout === null) {
    pointers = { pilot: version, early: version, everyone: version };
    await ctx.db.insert("groupRollouts", {
      orgId,
      groupId,
      enabled: false,
      pointers,
      autoPromote: { enabled: false, bakeHours: 24, maxFailurePct: 10 },
      autoRollback: true,
      state: "idle",
      versions: [entry],
      revision: 0,
    });
  } else {
    const patch: Partial<Doc<"groupRollouts">> = {};
    pointers = rollout.pointers;
    if (!rollout.enabled) {
      if (pointers.pilot !== version || pointers.early !== version || pointers.everyone !== version) {
        pointers = { pilot: version, early: version, everyone: version };
        patch.pointers = pointers;
      }
    } else if (pointers.pilot !== version) {
      pointers = { ...pointers, pilot: version };
      patch.pointers = pointers;
      patch.state = rollout.state === "halted" ? "halted" : "rolling";
      patch.stageStartedAt = now;
    }
    // A pointer move bumps `revision`, so an admin acting on a screen from before it gets `stale_edit` (Step 16).
    if (patch.pointers !== undefined) patch.revision = rollout.revision + 1;
    const versions = withVersion(rollout.versions, entry, keepFrom, pointers);
    if (versions !== null) patch.versions = versions;
    if (Object.keys(patch).length > 0) await ctx.db.patch(rollout._id, patch);
  }

  // Prune old versions no pointer references.
  if (keepFrom > 1) {
    const old = await ctx.db
      .query("groupConfigs")
      .withIndex("by_group_version", (q) => q.eq("groupId", groupId).lt("version", keepFrom))
      .take(PRUNE_GROUP_CONFIGS_PER_RUN);
    for (const row of old) {
      if (row.version === pointers.pilot || row.version === pointers.early || row.version === pointers.everyone) continue;
      await ctx.db.delete(row._id);
    }
  }
  await requestPublish(ctx, orgId, { groupIds: [groupId] });
  return { changed: true, version };
}

/** What the publisher keeps per group and run: the pointers (1 read) and the configurations it opened (1 read each). */
export type GroupConfigCache = {
  rollout: Map<string, Doc<"groupRollouts"> | null>;
  content: Map<string, GroupConfigContent | null>;
};
export function newGroupConfigCache(): GroupConfigCache {
  return { rollout: new Map(), content: new Map() };
}

/**
 * The configuration a device of `ring` gets: the group's pointer for that ring, then that
 * version's row. Null when the group has no snapshot (a Phase 4 group), or the row is
 * missing or damaged. Cached per run: a group costs 1 + (number of distinct versions) reads.
 */
export async function configForRing(
  ctx: { db: DatabaseReader },
  groupId: Id<"groups">,
  ring: RingValue,
  cache: GroupConfigCache,
): Promise<{ version: number; content: GroupConfigContent } | null> {
  let rollout = cache.rollout.get(groupId);
  if (rollout === undefined) {
    rollout = await ctx.db
      .query("groupRollouts")
      .withIndex("by_group", (q) => q.eq("groupId", groupId))
      .unique();
    cache.rollout.set(groupId, rollout);
  }
  if (rollout === null) return null;
  const version = rollout.pointers[ring];
  const key = `${groupId}:${version}`;
  let content = cache.content.get(key);
  if (content === undefined) {
    const row = await ctx.db
      .query("groupConfigs")
      .withIndex("by_group_version", (q) => q.eq("groupId", groupId).eq("version", version))
      .unique();
    content = row === null ? null : parseGroupConfig(row.config);
    cache.content.set(key, content);
  }
  return content === null ? null : { version, content };
}
