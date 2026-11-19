import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseReader, MutationCtx } from "../_generated/server";
import { sha256HexSync } from "./crypto";
import { docUpdate, type BuildApp } from "./desired";
import { fail } from "./errors";
import {
  KEEP_GROUP_CONFIGS,
  MAX_DEVICE_DRIVERS,
  MAX_DEVICE_PRINTERS,
  MAX_DEVICE_WIFI,
  MAX_FILE_HANDLERS,
  MAX_GROUP_APPS,
  MAX_GROUP_CONFIG_BYTES,
  MAX_GROUP_EXCEPTIONS,
  MAX_ORG_DRIVERS,
  MAX_ORG_PRINTERS,
  MAX_SNAPSHOT_GROUPS_TOTAL,
  MAX_WIFI_PROFILES,
  PRUNE_GROUP_CONFIGS_PER_RUN,
  SNAPSHOT_BATCH_GROUPS,
  SNAPSHOT_SYNC_GROUPS,
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
// Step 16b (owner decision 2026-11-15): the Phase 4 catalogue inputs are frozen too, as the
// optional `catalog` section: the group's app assignments, the records of the apps they name
// and the file-type rules that point at those apps. Every mutation that changes one of them
// snapshots the groups that assign the app (`lib/appPublish.ts` `snapshotAppGroups`; the first
// SNAPSHOT_SYNC_GROUPS at once, the rest in scheduled batches, Step 20b). STILL LIVE (the directory never waits for a
// pilot, plan 4.3 rule 6): direct employee grants and the records of web apps a group carries
// only through a grant. `allowedSites` is always empty, so there is nothing to freeze.
// A group with no snapshot, or a version made before Step 16b (no `catalog`), is read live.

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

/** (Step 16b) One app assignment of the group as the builder needs it. */
export type ConfigAssignment = { appId: string; audience: "everyone" | "selected"; pinnedTaskbar: boolean; pinnedDesktop: boolean };

/**
 * (Step 16b) A frozen app record: what `lib/desired.ts` `BuildApp` needs, absent optionals `null`. The icon is kept as its
 * file-storage id (the publisher resolves the address; an icon replaced since then is simply left out).
 */
export type ConfigApp = {
  id: string;
  name: string;
  description: string | null;
  kind: "web" | "desktop";
  hue: number | null;
  revision: number;
  web: NonNullable<BuildApp["web"]> | null;
  desktop: (Omit<NonNullable<BuildApp["desktop"]>, "install"> & { install: (Omit<NonNullable<NonNullable<BuildApp["desktop"]>["install"]>, "productCode"> & { productCode: string | null }) | null }) | null;
  icon: { storageId: string; sha256: string } | null;
};

/** (Step 16b) The ring-gated Phase 4 inputs of a group: assignments (by app id), their non-archived apps (by id), their file-type rules (by extension). */
export type ConfigCatalog = {
  assignments: ConfigAssignment[];
  apps: ConfigApp[];
  fileHandlers: { extension: string; appId: string }[];
};

export type GroupConfigContent = {
  lockdown: DocLockdown;
  wifiManagedOnly: boolean;
  /** (Step 20b) The admin ticked "I understand this PC may go offline". Only present when true (and `wifiManagedOnly` is on), so a version without it keeps its content hash. */
  wifiManagedOnlyConfirmed?: boolean;
  wifi: ConfigWifi[];
  printers: ConfigPrinter[];
  /** Absent in versions made before Step 14b, and omitted from the stored text when empty (their content hash stays the same). */
  drivers?: ConfigDriver[];
  /** (Step 16b) Absent in versions made before Step 16b: the publisher then reads the catalogue inputs live. */
  catalog?: ConfigCatalog;
};

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** PURE. A live app row as the frozen record, every object in a fixed key order (the text is hashed). */
export function configApp(app: Doc<"apps">): ConfigApp {
  const w = app.web;
  const d = app.desktop;
  const i = d?.install;
  const p = w?.permissions;
  return {
    id: app._id,
    name: app.name,
    description: app.description ?? null,
    kind: app.kind,
    hue: app.hue ?? null,
    revision: app.revision,
    web:
      app.kind !== "web" || w === undefined || p === undefined
        ? null
        : {
            url: w.url,
            allowedDomains: [...w.allowedDomains],
            permissions: {
              camera: p.camera,
              microphone: p.microphone,
              screenShare: p.screenShare,
              clipboardRead: p.clipboardRead,
              notifications: p.notifications,
              downloads: p.downloads,
              printing: p.printing,
              geolocation: p.geolocation,
            },
          },
    desktop:
      app.kind !== "desktop" || d === undefined
        ? null
        : {
            exe: d.exe,
            args: [...d.args],
            fileArgTemplate: [...d.fileArgTemplate],
            install:
              i === undefined
                ? null
                : {
                    kind: i.kind,
                    url: i.url,
                    sha256: i.sha256,
                    sizeBytes: i.sizeBytes,
                    silentArgs: [...i.silentArgs],
                    productCode: i.productCode ?? null,
                    successExitCodes: [...i.successExitCodes],
                    removeWhenUnassigned: i.removeWhenUnassigned,
                  },
            resetFolders: [...d.resetFolders],
            // Phase 6: only what a device may know (`docUpdate` drops the feed), left out when absent so an older version keeps its hash.
            ...(d.version !== undefined ? { version: d.version } : {}),
            ...(d.update !== undefined ? { update: docUpdate(d.update) } : {}),
          },
    icon: app.icon === undefined ? null : { storageId: app.icon.storageId, sha256: app.icon.sha256 },
  };
}

/** PURE. A frozen record as the document builder's input (`icon` is the publisher's: it needs file storage). */
export function buildAppOf(a: ConfigApp, icon: BuildApp["icon"]): BuildApp {
  return {
    _id: a.id,
    name: a.name,
    description: a.description ?? undefined,
    kind: a.kind,
    hue: a.hue ?? undefined,
    archived: false,
    revision: a.revision,
    web: a.web ?? undefined,
    desktop:
      a.desktop === null
        ? undefined
        : { ...a.desktop, install: a.desktop.install === null ? undefined : { ...a.desktop.install, productCode: a.desktop.install.productCode ?? undefined } },
    icon,
  };
}

/** What `buildGroupConfig` freezes as the catalogue (Step 16b). */
export type CatalogInputs = {
  /** The group's assignments (`appAssignments.by_group`). */
  assignments: Pick<Doc<"appAssignments">, "appId" | "audience" | "pinnedTaskbar" | "pinnedDesktop">[];
  /** The apps the assignments name (archived ones are left out here, as the builder leaves them out). */
  apps: Doc<"apps">[];
  /** The organization's file-type rules; only those whose app the group assigns are kept. */
  fileHandlers: Pick<Doc<"fileHandlers">, "extension" | "appId">[];
};

/** PURE. The frozen catalogue of one group: sorted, one assignment per app, archived apps and other groups' rules left out. */
export function buildConfigCatalog(input: CatalogInputs): ConfigCatalog {
  const seen = new Set<string>();
  const assignments: ConfigAssignment[] = [];
  for (const a of input.assignments) {
    if (seen.has(a.appId)) continue;
    seen.add(a.appId);
    assignments.push({ appId: a.appId, audience: a.audience, pinnedTaskbar: a.pinnedTaskbar, pinnedDesktop: a.pinnedDesktop });
  }
  assignments.sort((x, y) => byText(x.appId, y.appId));
  const apps = input.apps
    .filter((a) => !a.archived && seen.has(a._id))
    .map(configApp)
    .sort(byId);
  const fileHandlers = input.fileHandlers
    .filter((h) => seen.has(h.appId))
    .map((h) => ({ extension: h.extension, appId: h.appId as string }))
    .sort((x, y) => byText(x.extension, y.extension));
  return { assignments, apps, fileHandlers };
}

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
  /** (Step 16b) The catalogue inputs; absent = the version has no `catalog` (only hand-built inputs in tests leave it out). */
  catalog?: CatalogInputs;
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
    ...(s.wifiManagedOnly && s.wifiManagedOnlyConfirmed === true ? { wifiManagedOnlyConfirmed: true } : {}),
    wifi,
    printers,
    drivers,
    ...(input.catalog === undefined ? {} : { catalog: buildConfigCatalog(input.catalog) }),
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

/**
 * What several snapshots of ONE mutation share (Step 16b): an app edit snapshots up to SNAPSHOT_SYNC_GROUPS groups at once, and each
 * would read the organization's file-type rules and the same app rows again. Never kept across transactions.
 */
export type SnapshotCache = { apps: Map<string, Doc<"apps"> | null>; fileHandlers: Map<string, Pick<Doc<"fileHandlers">, "extension" | "appId">[]> };
export function newSnapshotCache(): SnapshotCache {
  return { apps: new Map(), fileHandlers: new Map() };
}

/** The live catalogue inputs of one group (Step 16b): its assignments (<= MAX_GROUP_APPS), their apps (one get each) and the organization's file-type rules. */
async function loadCatalogInputs(
  ctx: { db: DatabaseReader },
  orgId: Id<"organizations">,
  groupId: Id<"groups">,
  cache: SnapshotCache,
): Promise<CatalogInputs> {
  const assignments = await ctx.db
    .query("appAssignments")
    .withIndex("by_group", (q) => q.eq("groupId", groupId))
    .take(MAX_GROUP_APPS);
  const apps: Doc<"apps">[] = [];
  for (const a of assignments) {
    let app = cache.apps.get(a.appId);
    if (app === undefined) {
      app = await ctx.db.get(a.appId);
      cache.apps.set(a.appId, app);
    }
    if (app !== null && app.orgId === orgId) apps.push(app);
  }
  let fileHandlers = cache.fileHandlers.get(orgId);
  if (fileHandlers === undefined) {
    // No rule can matter to a group without assignments (a rule names a program, and a program reaches a PC only when its group assigns it).
    fileHandlers =
      assignments.length === 0
        ? []
        : await ctx.db
            .query("fileHandlers")
            .withIndex("by_org_ext", (q) => q.eq("orgId", orgId))
            .take(MAX_FILE_HANDLERS);
    if (assignments.length > 0) cache.fileHandlers.set(orgId, fileHandlers);
  }
  return { assignments, apps, fileHandlers };
}

/** Reads the live inputs of one group: bounded `.take`s through indexes, no scans. */
export async function loadConfigInputs(
  ctx: { db: DatabaseReader },
  orgId: Id<"organizations">,
  groupId: Id<"groups">,
  cache: SnapshotCache = newSnapshotCache(),
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
  const catalog = await loadCatalogInputs(ctx, orgId, groupId, cache);
  return { settings, exceptions: [...own, ...orgWide], wifi, printers, drivers, catalog };
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
  cache?: SnapshotCache,
): Promise<SnapshotResult> {
  const group = await ctx.db.get(groupId);
  if (group === null) fail("not_found");
  const orgId = group.orgId;
  const content = buildGroupConfig(groupId, await loadConfigInputs(ctx, orgId, groupId, cache));
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

/**
 * (Step 20b) Snapshot many groups: the first SNAPSHOT_SYNC_GROUPS (that still exist) in this transaction, the rest in scheduled
 * `groupBatches:snapshotBatch` runs of SNAPSHOT_BATCH_GROUPS groups, each of which ends in the publish `snapshotGroupConfig` asks for.
 * A batch builds the configuration from the live inputs when it runs, so it is idempotent and a later edit that lands first is
 * kept (the batch sees it and writes nothing new when the content is the same). Duplicates are dropped; more than
 * MAX_SNAPSHOT_GROUPS_TOTAL groups = `too_large` (detail "groups"), before anything is written. Returns how many were scheduled.
 */
export async function snapshotGroupsBatched(
  ctx: Pick<MutationCtx, "db" | "scheduler">,
  ids: Iterable<Id<"groups">>,
  reason: string,
  by?: Id<"members">,
  cache: SnapshotCache = newSnapshotCache(),
): Promise<number> {
  const unique = [...new Set(ids)];
  if (unique.length > MAX_SNAPSHOT_GROUPS_TOTAL) fail("too_large", { detail: "groups" });
  for (const id of unique.slice(0, SNAPSHOT_SYNC_GROUPS)) {
    if ((await ctx.db.get(id)) === null) continue; // a group that was deleted (an assignment or profile left behind)
    await snapshotGroupConfig(ctx, id, reason, by, cache);
  }
  const rest = unique.slice(SNAPSHOT_SYNC_GROUPS);
  for (let i = 0; i < rest.length; i += SNAPSHOT_BATCH_GROUPS) {
    await ctx.scheduler.runAfter(0, internal.groupBatches.snapshotBatch, {
      groupIds: rest.slice(i, i + SNAPSHOT_BATCH_GROUPS),
      reason: reason.slice(0, 120),
      ...(by === undefined ? {} : { by }),
    });
  }
  return rest.length;
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
