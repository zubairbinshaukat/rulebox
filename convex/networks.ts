import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { writeAudit } from "./lib/audit";
import { checkRevision, getInOrg } from "./lib/authz";
import { fail } from "./lib/errors";
import { internalMutation, memberMutation, memberQuery } from "./lib/functions";
import { snapshotGroupConfig } from "./lib/groupConfig";
import {
  MAX_NETWORK_GROUPS,
  MAX_ORG_PRINTERS,
  MAX_PRINTER_NAME,
  MAX_NETWORK_SNAPSHOT_GROUPS,
  MAX_WIFI_DETAIL_GROUPS,
  MAX_WIFI_DETAIL_REPORTS,
  MAX_WIFI_PROFILES,
  MAX_WIFI_LIST_GROUPS,
  SEALED_PURGE_BATCH,
} from "./lib/limits";
import { printerKind, wifiSecurity } from "./lib/lockdownValidators";
import { approvedPrinterDrivers, checkPrinterDriver } from "./lib/printerDrivers";
import { checkPrinterTarget } from "./lib/printerAddress";

// Wi-Fi profiles: list, detail, save, delete (Phase 5 Step 13, plan 4.15, 4.20). The passphrase is NOT here:
// only the ACTION `wifi:setPassphrase` (wifi.ts) accepts it. No function in this file returns a passphrase,
// a key id or a sealed box.
//
// CONTRACT (the dashboard types against this block):
//   networks:list        query, viewer, args {}                       -> { wifi: WifiRow[], printers: PrinterRow[],
//                                                                         approvedDrivers: string[] }
//   networks:wifiDetail  query, viewer, args { id: string }           -> WifiDetail
//   networks:saveWifi    mutation, admin, args { id?: string, expectedRevision?: number, name: string,
//                          ssid: string, hidden: boolean, security: "open"|"wpa2Personal"|"wpa3Personal"|
//                          "wpa2Wpa3Personal", autoConnect: boolean, groupIds: string[] }
//                        -> { id: Id<"wifiProfiles">, revision: number }
//                        create = no `id` (revision 1); update = `id` + `expectedRevision` (else invalid_argument,
//                        field "expectedRevision"). Errors: invalid_argument (field name|ssid|groupIds|
//                        expectedRevision, detail), not_found (profile or group of another org), stale_edit,
//                        too_large (detail "wifi" = 50 profiles per org; "groups" = more than 10 groups touched).
//   networks:deleteWifi  mutation, admin, args { id: string }         -> null
//   wifi:setPassphrase   action, admin, args { id: string, passphrase: string, expectedRevision: number }
//                        -> { revision: number }. Errors: invalid_argument (field "passphrase", detail "length"|
//                        "characters"; field "id" detail "open" for an open network), not_found, stale_edit,
//                        not_ready (detail "sealing_key"), rate_limited.
//   WifiRow    = { _id, name, ssid, hidden, security, autoConnect, hasPassphrase: boolean,
//                  passphraseSetAt: number | null, revision, groupCount: number,
//                  groups: { _id, name }[] }   (first MAX_WIFI_LIST_GROUPS = 10 groups; groupCount = all)
//   WifiDetail = WifiRow & { groupIds: Id<"groups">[], counts: { applied, failed, waiting, unsupported,
//                  sampled, capped: boolean } }   (counts: the latest apply report of each device of the
//                  assigned groups, at most 200 reports per group and 10 groups; `capped` = truncated)

// Printers (Phase 5 Step 14, plan 4.15, 4.20) share this file and the Networks list with Wi-Fi:
//   networks:printerDetail  query, viewer, args { id: string }        -> PrinterDetail
//   networks:savePrinter    mutation, admin, args { id?: string, expectedRevision?: number, name: string,
//                             kind: "ipp"|"raw"|"lpr"|"share", address: string, port?: number, queue?: string,
//                             driver: string, groupIds: string[], defaultForGroupIds: string[] }
//                           -> { id: Id<"printers">, revision: number }
//                           Errors: invalid_argument (field name|address|port|queue|driver|groupIds|defaultForGroupIds|
//                           expectedRevision; detail, e.g. name "taken", driver "not_approved", defaultForGroupIds "taken"),
//                           not_found, stale_edit, too_large (detail "printers" = 100 per organization; "groups" = more
//                           than 10 groups touched). The driver must be on the approved list (the inbox class drivers plus
//                           `phase5Settings.approvedPrinterDrivers`); the agent never installs one.
//   networks:deletePrinter  mutation, admin, args { id: string }      -> null
//   PrinterRow    = { _id, name, kind, address, port: number | null, queue: string | null, driver, revision,
//                     groupCount, defaultGroupCount, groups: { _id, name }[] }   (first MAX_WIFI_LIST_GROUPS groups)
//   PrinterDetail = PrinterRow & { groupIds, defaultForGroupIds, counts: same shape as WifiDetail.counts }

const MAX_NAME = 60;
const MAX_SSID_BYTES = 32;

const groupRef = v.object({ _id: v.id("groups"), name: v.string() });

const wifiRow = v.object({
  _id: v.id("wifiProfiles"),
  name: v.string(),
  ssid: v.string(),
  hidden: v.boolean(),
  security: wifiSecurity,
  autoConnect: v.boolean(),
  hasPassphrase: v.boolean(),
  passphraseSetAt: v.union(v.number(), v.null()),
  revision: v.number(),
  groupCount: v.number(),
  groups: v.array(groupRef),
});

const wifiDetailValue = v.object({
  _id: v.id("wifiProfiles"),
  name: v.string(),
  ssid: v.string(),
  hidden: v.boolean(),
  security: wifiSecurity,
  autoConnect: v.boolean(),
  hasPassphrase: v.boolean(),
  passphraseSetAt: v.union(v.number(), v.null()),
  revision: v.number(),
  groupCount: v.number(),
  groups: v.array(groupRef),
  groupIds: v.array(v.id("groups")),
  counts: v.object({
    applied: v.number(),
    failed: v.number(),
    waiting: v.number(),
    unsupported: v.number(),
    sampled: v.number(),
    capped: v.boolean(),
  }),
});

const printerRow = v.object({
  _id: v.id("printers"),
  name: v.string(),
  kind: printerKind,
  address: v.string(),
  port: v.union(v.number(), v.null()),
  queue: v.union(v.string(), v.null()),
  driver: v.string(),
  revision: v.number(),
  groupCount: v.number(),
  defaultGroupCount: v.number(),
  groups: v.array(groupRef),
});

const applyCounts = v.object({
  applied: v.number(),
  failed: v.number(),
  waiting: v.number(),
  unsupported: v.number(),
  sampled: v.number(),
  capped: v.boolean(),
});

const printerDetailValue = v.object({
  _id: v.id("printers"),
  name: v.string(),
  kind: printerKind,
  address: v.string(),
  port: v.union(v.number(), v.null()),
  queue: v.union(v.string(), v.null()),
  driver: v.string(),
  revision: v.number(),
  groupCount: v.number(),
  defaultGroupCount: v.number(),
  groups: v.array(groupRef),
  groupIds: v.array(v.id("groups")),
  defaultForGroupIds: v.array(v.id("groups")),
  counts: applyCounts,
});

type GroupReader = { db: { get(id: Id<"groups">): Promise<Doc<"groups"> | null> } };

function printerRowOf(p: Doc<"printers">, groups: { _id: Id<"groups">; name: string }[]) {
  return {
    _id: p._id,
    name: p.name,
    kind: p.kind,
    address: p.address,
    port: p.port ?? null,
    queue: p.queue ?? null,
    driver: p.driver,
    revision: p.revision,
    groupCount: p.groupIds.length,
    defaultGroupCount: p.defaultForGroupIds.length,
    groups,
  };
}

function rowOf(p: Doc<"wifiProfiles">, groups: { _id: Id<"groups">; name: string }[]) {
  return {
    _id: p._id,
    name: p.name,
    ssid: p.ssid,
    hidden: p.hidden,
    security: p.security,
    autoConnect: p.autoConnect,
    hasPassphrase: p.security !== "open" && p.passphrase !== undefined,
    passphraseSetAt: p.passphraseSetAt ?? null,
    revision: p.revision,
    groupCount: p.groupIds.length,
    groups,
  };
}

/** The first `cap` groups of a profile that still exist (a deleted group is skipped), names from a per-query cache. */
async function groupsOf(
  ctx: GroupReader,
  ids: Id<"groups">[],
  cap: number,
  cache: Map<string, { _id: Id<"groups">; name: string } | null>,
): Promise<{ _id: Id<"groups">; name: string }[]> {
  const out: { _id: Id<"groups">; name: string }[] = [];
  for (const id of ids.slice(0, cap)) {
    let hit = cache.get(id);
    if (hit === undefined) {
      const g = await ctx.db.get(id);
      hit = g === null ? null : { _id: g._id, name: g.name };
      cache.set(id, hit);
    }
    if (hit !== null) out.push(hit);
  }
  return out;
}

// ---------------------------------------------------------------- reads

/**
 * The organization's Wi-Fi profiles and printers (viewer; one query per screen): one index read of at most
 * MAX_WIFI_PROFILES / MAX_ORG_PRINTERS rows plus the names of the first MAX_WIFI_LIST_GROUPS groups of each (one
 * cache for both lists) and the organization row (the approved printer drivers, for the form's picker). Never a
 * passphrase, key or box.
 */
export const list = memberQuery("viewer")({
  args: {},
  returns: v.object({ wifi: v.array(wifiRow), printers: v.array(printerRow), approvedDrivers: v.array(v.string()) }),
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("wifiProfiles")
      .withIndex("by_org", (q) => q.eq("orgId", ctx.orgId))
      .take(MAX_WIFI_PROFILES + 1);
    const cache = new Map<string, { _id: Id<"groups">; name: string } | null>();
    const wifi = [];
    for (const p of rows.slice(0, MAX_WIFI_PROFILES)) {
      wifi.push(rowOf(p, await groupsOf(ctx, p.groupIds, MAX_WIFI_LIST_GROUPS, cache)));
    }
    wifi.sort((a, b) => a.name.localeCompare(b.name) || (a._id < b._id ? -1 : 1));
    const printerDocs = await ctx.db
      .query("printers")
      .withIndex("by_org", (q) => q.eq("orgId", ctx.orgId))
      .take(MAX_ORG_PRINTERS + 1);
    const printers = [];
    for (const p of printerDocs.slice(0, MAX_ORG_PRINTERS)) {
      printers.push(printerRowOf(p, await groupsOf(ctx, p.groupIds, MAX_WIFI_LIST_GROUPS, cache)));
    }
    printers.sort((a, b) => a.name.localeCompare(b.name) || (a._id < b._id ? -1 : 1));
    const org = await ctx.db.get(ctx.orgId);
    return { wifi, printers, approvedDrivers: approvedPrinterDrivers(org?.phase5Settings?.approvedPrinterDrivers) };
  },
});

/** The apply state of a profile on one device, as the counts name it. */
function bucketOf(state: string): "applied" | "failed" | "unsupported" | "waiting" {
  if (state === "applied") return "applied";
  if (state === "failed") return "failed";
  if (state === "unsupported") return "unsupported";
  return "waiting";
}

/**
 * One profile with the apply counts (viewer). Counts are computed on demand from the latest apply report of
 * each device of the assigned groups (`deviceApplyReports.by_org_config`): at most MAX_WIFI_DETAIL_REPORTS
 * reports per group over at most MAX_WIFI_DETAIL_GROUPS groups; `capped` says the sample was cut. A device that
 * has not reported this profile yet is not counted. `not_found` for another organization's id.
 */
export const wifiDetail = memberQuery("viewer")({
  args: { id: v.string() },
  returns: wifiDetailValue,
  handler: async (ctx, args) => {
    const p = await getInOrg(ctx, "wifiProfiles", args.id, ctx.orgId);
    const cache = new Map<string, { _id: Id<"groups">; name: string } | null>();
    const groups = await groupsOf(ctx, p.groupIds, MAX_WIFI_LIST_GROUPS, cache);
    const counts = { applied: 0, failed: 0, waiting: 0, unsupported: 0, sampled: 0, capped: p.groupIds.length > MAX_WIFI_DETAIL_GROUPS };
    for (const groupId of p.groupIds.slice(0, MAX_WIFI_DETAIL_GROUPS)) {
      const reports = await ctx.db
        .query("deviceApplyReports")
        .withIndex("by_org_config", (q) => q.eq("orgId", ctx.orgId).eq("config.groupId", groupId))
        .take(MAX_WIFI_DETAIL_REPORTS + 1);
      if (reports.length > MAX_WIFI_DETAIL_REPORTS) counts.capped = true;
      for (const r of reports.slice(0, MAX_WIFI_DETAIL_REPORTS)) {
        const item = r.wifi.find((w) => w.profileId === p._id);
        if (item === undefined) continue;
        counts[bucketOf(item.state)]++;
        counts.sampled++;
      }
    }
    return { ...rowOf(p, groups), groupIds: [...p.groupIds], counts };
  },
});

// ---------------------------------------------------------------- writes

function hasControlChars(text: string): boolean {
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    if (c < 0x20 || c === 0x7f || (c >= 0x80 && c < 0xa0)) return true;
  }
  return false;
}

/** The trimmed profile name (1-60), or `invalid_argument`. */
export function checkWifiName(name: string): string {
  const n = name.trim();
  if (n.length === 0) fail("invalid_argument", { field: "name", detail: "empty" });
  if (n.length > MAX_NAME) fail("invalid_argument", { field: "name", detail: "length" });
  if (hasControlChars(n)) fail("invalid_argument", { field: "name", detail: "characters" });
  return n;
}

/** The SSID itself (spaces count), 1-32 UTF-8 bytes, no control characters, or `invalid_argument`. */
export function checkSsid(ssid: string): string {
  if (new TextEncoder().encode(ssid).length === 0) fail("invalid_argument", { field: "ssid", detail: "empty" });
  if (new TextEncoder().encode(ssid).length > MAX_SSID_BYTES) fail("invalid_argument", { field: "ssid", detail: "length" });
  if (hasControlChars(ssid)) fail("invalid_argument", { field: "ssid", detail: "characters" });
  return ssid;
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** Snapshot the configuration of every still existing group in `ids` (cap MAX_NETWORK_SNAPSHOT_GROUPS). */
async function snapshotGroups(
  ctx: Parameters<typeof snapshotGroupConfig>[0] & GroupReader,
  ids: Iterable<Id<"groups">>,
  reason: string,
  by: Id<"members">,
): Promise<void> {
  for (const id of ids) {
    if ((await ctx.db.get(id)) === null) continue;
    await snapshotGroupConfig(ctx, id, reason, by);
  }
}

/**
 * The sealed boxes of a profile that went away or became open. Scheduled by `saveWifi` / `deleteWifi` (the index is
 * `[purpose, targetId]`, which the organization-scoped database of a member function cannot range over), SEALED_PURGE_BATCH
 * rows per run; a full batch schedules the next one. Nothing reads a box of an unassigned or deleted profile meanwhile.
 */
async function purgeSealedBoxes(ctx: Pick<MutationCtx, "db" | "scheduler">, profileId: string): Promise<number> {
  const rows = await ctx.db
    .query("deviceSealedSecrets")
    .withIndex("by_target", (q) => q.eq("purpose", "wifi").eq("targetId", profileId))
    .take(SEALED_PURGE_BATCH);
  for (const r of rows) await ctx.db.delete(r._id);
  if (rows.length === SEALED_PURGE_BATCH) await ctx.scheduler.runAfter(0, internal.networks.purgeSealed, { profileId });
  return rows.length;
}

/** One batch of a profile's boxes (internal; see `purgeSealedBoxes`). */
export const purgeSealed = internalMutation({
  args: { profileId: v.string() },
  returns: v.number(),
  handler: async (ctx, args) => purgeSealedBoxes(ctx, args.profileId),
});

/**
 * Create or change a Wi-Fi profile (admin; no passphrase here). Create: no `id`. Update: `id` and
 * `expectedRevision` (`stale_edit` when someone saved in between). No change = no write, no new revision, no
 * publish. A change bumps the revision (every device re-seals and re-applies the profile), audits
 * `wifi.created` / `wifi.updated`, makes the configuration of every group the profile was in or is now in a new
 * version (`snapshotGroupConfig`; at most MAX_NETWORK_SNAPSHOT_GROUPS groups per save, else `too_large`
 * detail "groups"). Switching to an open network drops the stored passphrase (its boxes are deleted by a scheduled `purgeSealed`).
 */
export const saveWifi = memberMutation("admin")({
  args: {
    id: v.optional(v.string()),
    expectedRevision: v.optional(v.number()),
    name: v.string(),
    ssid: v.string(),
    hidden: v.boolean(),
    security: wifiSecurity,
    autoConnect: v.boolean(),
    groupIds: v.array(v.string()),
  },
  returns: v.object({ id: v.id("wifiProfiles"), revision: v.number() }),
  handler: async (ctx, args) => {
    const name = checkWifiName(args.name);
    const ssid = checkSsid(args.ssid);
    if (args.groupIds.length > MAX_NETWORK_GROUPS) fail("invalid_argument", { field: "groupIds", detail: "too_many" });
    const groupIds: Id<"groups">[] = [];
    for (const raw of args.groupIds) {
      const g = await getInOrg(ctx, "groups", raw, ctx.orgId);
      if (!groupIds.includes(g._id)) groupIds.push(g._id);
    }
    groupIds.sort();

    if (args.id === undefined) {
      if (args.expectedRevision !== undefined) fail("invalid_argument", { field: "expectedRevision" });
      if (groupIds.length > MAX_NETWORK_SNAPSHOT_GROUPS) fail("too_large", { detail: "groups" });
      const existing = await ctx.db
        .query("wifiProfiles")
        .withIndex("by_org", (q) => q.eq("orgId", ctx.orgId))
        .take(MAX_WIFI_PROFILES);
      if (existing.length >= MAX_WIFI_PROFILES) fail("too_large", { detail: "wifi" });
      const id = await ctx.db.insert("wifiProfiles", {
        orgId: ctx.orgId,
        name,
        ssid,
        hidden: args.hidden,
        security: args.security,
        autoConnect: args.autoConnect,
        groupIds,
        revision: 1,
        createdAt: Date.now(),
      });
      await writeAudit(ctx, {
        orgId: ctx.orgId,
        actor: ctx.actor,
        action: "wifi.created",
        targetType: "wifi",
        targetId: id,
        targetLabel: name,
        summary: `Added the Wi-Fi network ${name}`,
      });
      await snapshotGroups(ctx, groupIds, `Wi-Fi ${name}`, ctx.member._id);
      return { id, revision: 1 };
    }

    if (args.expectedRevision === undefined) fail("invalid_argument", { field: "expectedRevision" });
    const p = await getInOrg(ctx, "wifiProfiles", args.id, ctx.orgId);
    checkRevision(p, args.expectedRevision);
    const before = [...p.groupIds].sort();
    const unchanged =
      p.name === name &&
      p.ssid === ssid &&
      p.hidden === args.hidden &&
      p.security === args.security &&
      p.autoConnect === args.autoConnect &&
      sameSet(before, groupIds);
    if (unchanged) return { id: p._id, revision: p.revision };

    const touched = new Set<Id<"groups">>([...before, ...groupIds]);
    if (touched.size > MAX_NETWORK_SNAPSHOT_GROUPS) fail("too_large", { detail: "groups" });
    const revision = p.revision + 1;
    const dropSecret = args.security === "open" && p.passphrase !== undefined;
    await ctx.db.patch(p._id, {
      name,
      ssid,
      hidden: args.hidden,
      security: args.security,
      autoConnect: args.autoConnect,
      groupIds,
      revision,
      ...(dropSecret ? { passphrase: undefined, passphraseRev: undefined, passphraseSetAt: undefined } : {}),
    });
    if (dropSecret) await ctx.scheduler.runAfter(0, internal.networks.purgeSealed, { profileId: p._id });
    await writeAudit(ctx, {
      orgId: ctx.orgId,
      actor: ctx.actor,
      action: "wifi.updated",
      targetType: "wifi",
      targetId: p._id,
      targetLabel: name,
      summary: `Changed the Wi-Fi network ${name}`,
    });
    await snapshotGroups(ctx, touched, `Wi-Fi ${name}`, ctx.member._id);
    return { id: p._id, revision };
  },
});

/**
 * Delete a Wi-Fi profile (admin). Its sealed boxes are deleted by a scheduled `purgeSealed`, the configuration of every group
 * it was assigned to becomes a new version without it, so the documents drop it and the agent removes the
 * `Rulebox-<id>` profile. Not blocked when a group has "managed networks only" (the agent then refuses the
 * document with `managed_networks_empty`).
 */
export const deleteWifi = memberMutation("admin")({
  args: { id: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const p = await getInOrg(ctx, "wifiProfiles", args.id, ctx.orgId);
    if (p.groupIds.length > MAX_NETWORK_SNAPSHOT_GROUPS) fail("too_large", { detail: "groups" });
    await ctx.db.delete(p._id);
    await ctx.scheduler.runAfter(0, internal.networks.purgeSealed, { profileId: p._id });
    await writeAudit(ctx, {
      orgId: ctx.orgId,
      actor: ctx.actor,
      action: "wifi.deleted",
      targetType: "wifi",
      targetId: p._id,
      targetLabel: p.name,
      summary: `Removed the Wi-Fi network ${p.name}`,
    });
    await snapshotGroups(ctx, p.groupIds, `Removed Wi-Fi ${p.name}`, ctx.member._id);
    return null;
  },
});

// ---------------------------------------------------------------- printers (Phase 5 Step 14)

/** The trimmed display name (1-60): the queue is `<name> (Rulebox)`, so no `\`, `,` or `/` (Windows queue-name rules). */
export function checkPrinterName(name: string): string {
  const n = name.trim();
  if (n.length === 0) fail("invalid_argument", { field: "name", detail: "empty" });
  if (n.length > MAX_PRINTER_NAME) fail("invalid_argument", { field: "name", detail: "length" });
  if (hasControlChars(n) || /[\\,/]/.test(n)) fail("invalid_argument", { field: "name", detail: "characters" });
  return n;
}

/**
 * One printer with the apply counts (viewer). Counts come from the latest apply report of each device of the assigned
 * groups, bounded exactly like `wifiDetail` (MAX_WIFI_DETAIL_REPORTS per group over MAX_WIFI_DETAIL_GROUPS groups;
 * `capped` says the sample was cut). `not_found` for another organization's id.
 */
export const printerDetail = memberQuery("viewer")({
  args: { id: v.string() },
  returns: printerDetailValue,
  handler: async (ctx, args) => {
    const p = await getInOrg(ctx, "printers", args.id, ctx.orgId);
    const cache = new Map<string, { _id: Id<"groups">; name: string } | null>();
    const groups = await groupsOf(ctx, p.groupIds, MAX_WIFI_LIST_GROUPS, cache);
    const counts = { applied: 0, failed: 0, waiting: 0, unsupported: 0, sampled: 0, capped: p.groupIds.length > MAX_WIFI_DETAIL_GROUPS };
    for (const groupId of p.groupIds.slice(0, MAX_WIFI_DETAIL_GROUPS)) {
      const reports = await ctx.db
        .query("deviceApplyReports")
        .withIndex("by_org_config", (q) => q.eq("orgId", ctx.orgId).eq("config.groupId", groupId))
        .take(MAX_WIFI_DETAIL_REPORTS + 1);
      if (reports.length > MAX_WIFI_DETAIL_REPORTS) counts.capped = true;
      for (const r of reports.slice(0, MAX_WIFI_DETAIL_REPORTS)) {
        const item = r.printers.find((x) => x.printerId === p._id);
        if (item === undefined) continue;
        counts[bucketOf(item.state)]++;
        counts.sampled++;
      }
    }
    return { ...printerRowOf(p, groups), groupIds: [...p.groupIds], defaultForGroupIds: [...p.defaultForGroupIds], counts };
  },
});

/**
 * Create or change a printer (admin). Create: no `id`. Update: `id` and `expectedRevision` (`stale_edit`). The driver must be
 * on the approved list; the address, port and queue follow `lib/printerAddress.ts`; the display name is unique in the
 * organization (case-insensitive, `name` "taken"); a group has at most one default printer (`defaultForGroupIds` "taken": turn
 * the other one off first) and a default must be a group the printer is assigned to ("not_assigned"). No change = no write.
 * A change bumps the revision, audits `printer.created` / `printer.updated` and makes the configuration of every group the
 * printer was in or is now in a new version (at most MAX_NETWORK_SNAPSHOT_GROUPS groups per save, else `too_large`
 * detail "groups"), so the agent applies it.
 */
export const savePrinter = memberMutation("admin")({
  args: {
    id: v.optional(v.string()),
    expectedRevision: v.optional(v.number()),
    name: v.string(),
    kind: printerKind,
    address: v.string(),
    port: v.optional(v.number()),
    queue: v.optional(v.string()),
    driver: v.string(),
    groupIds: v.array(v.string()),
    defaultForGroupIds: v.array(v.string()),
  },
  returns: v.object({ id: v.id("printers"), revision: v.number() }),
  handler: async (ctx, args) => {
    const name = checkPrinterName(args.name);
    const target = checkPrinterTarget(args.kind, args.address, args.port, args.queue);
    if (args.groupIds.length > MAX_NETWORK_GROUPS || args.defaultForGroupIds.length > MAX_NETWORK_GROUPS) {
      fail("invalid_argument", { field: "groupIds", detail: "too_many" });
    }
    const org = await ctx.db.get(ctx.orgId);
    const driver = checkPrinterDriver(args.driver, approvedPrinterDrivers(org?.phase5Settings?.approvedPrinterDrivers));
    const groupIds: Id<"groups">[] = [];
    for (const raw of args.groupIds) {
      const g = await getInOrg(ctx, "groups", raw, ctx.orgId);
      if (!groupIds.includes(g._id)) groupIds.push(g._id);
    }
    groupIds.sort();
    const defaults: Id<"groups">[] = [];
    for (const raw of args.defaultForGroupIds) {
      const g = await getInOrg(ctx, "groups", raw, ctx.orgId);
      if (!groupIds.includes(g._id)) fail("invalid_argument", { field: "defaultForGroupIds", detail: "not_assigned" });
      if (!defaults.includes(g._id)) defaults.push(g._id);
    }
    defaults.sort();

    if (args.id === undefined) {
      if (args.expectedRevision !== undefined) fail("invalid_argument", { field: "expectedRevision" });
    } else if (args.expectedRevision === undefined) {
      fail("invalid_argument", { field: "expectedRevision" });
    }
    const own = args.id === undefined ? null : await getInOrg(ctx, "printers", args.id, ctx.orgId);
    if (own !== null) checkRevision(own, args.expectedRevision as number);

    const all = await ctx.db
      .query("printers")
      .withIndex("by_org", (q) => q.eq("orgId", ctx.orgId))
      .take(MAX_ORG_PRINTERS + 1);
    const others = all.filter((p) => own === null || p._id !== own._id);
    if (own === null && all.length >= MAX_ORG_PRINTERS) fail("too_large", { detail: "printers" });
    if (others.some((p) => p.name.toLowerCase() === name.toLowerCase())) fail("invalid_argument", { field: "name", detail: "taken" });
    if (defaults.some((g) => others.some((p) => p.defaultForGroupIds.includes(g)))) {
      fail("invalid_argument", { field: "defaultForGroupIds", detail: "taken" });
    }

    if (own === null) {
      if (groupIds.length > MAX_NETWORK_SNAPSHOT_GROUPS) fail("too_large", { detail: "groups" });
      const id = await ctx.db.insert("printers", {
        orgId: ctx.orgId,
        name,
        kind: args.kind,
        address: target.address,
        ...(target.port === null ? {} : { port: target.port }),
        ...(target.queue === null ? {} : { queue: target.queue }),
        driver,
        groupIds,
        defaultForGroupIds: defaults,
        revision: 1,
        createdAt: Date.now(),
      });
      await writeAudit(ctx, {
        orgId: ctx.orgId,
        actor: ctx.actor,
        action: "printer.created",
        targetType: "printer",
        targetId: id,
        targetLabel: name,
        summary: `Added the printer ${name}`,
      });
      await snapshotGroups(ctx, groupIds, `Printer ${name}`, ctx.member._id);
      return { id, revision: 1 };
    }

    const before = [...own.groupIds].sort();
    const unchanged =
      own.name === name &&
      own.kind === args.kind &&
      own.address === target.address &&
      (own.port ?? null) === target.port &&
      (own.queue ?? null) === target.queue &&
      own.driver === driver &&
      sameSet(before, groupIds) &&
      sameSet([...own.defaultForGroupIds].sort(), defaults);
    if (unchanged) return { id: own._id, revision: own.revision };

    const touched = new Set<Id<"groups">>([...before, ...groupIds]);
    if (touched.size > MAX_NETWORK_SNAPSHOT_GROUPS) fail("too_large", { detail: "groups" });
    const revision = own.revision + 1;
    await ctx.db.patch(own._id, {
      name,
      kind: args.kind,
      address: target.address,
      port: target.port ?? undefined,
      queue: target.queue ?? undefined,
      driver,
      groupIds,
      defaultForGroupIds: defaults,
      revision,
    });
    await writeAudit(ctx, {
      orgId: ctx.orgId,
      actor: ctx.actor,
      action: "printer.updated",
      targetType: "printer",
      targetId: own._id,
      targetLabel: name,
      summary: `Changed the printer ${name}`,
    });
    await snapshotGroups(ctx, touched, `Printer ${name}`, ctx.member._id);
    return { id: own._id, revision };
  },
});

/**
 * Delete a printer (admin). The configuration of every group it was assigned to becomes a new version without it, so the
 * documents drop it and the agent removes the `<name> (Rulebox)` queue it created (and its port). At most
 * MAX_NETWORK_SNAPSHOT_GROUPS groups (else `too_large`, detail "groups").
 */
export const deletePrinter = memberMutation("admin")({
  args: { id: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const p = await getInOrg(ctx, "printers", args.id, ctx.orgId);
    if (p.groupIds.length > MAX_NETWORK_SNAPSHOT_GROUPS) fail("too_large", { detail: "groups" });
    await ctx.db.delete(p._id);
    await writeAudit(ctx, {
      orgId: ctx.orgId,
      actor: ctx.actor,
      action: "printer.deleted",
      targetType: "printer",
      targetId: p._id,
      targetLabel: p.name,
      summary: `Removed the printer ${p.name}`,
    });
    await snapshotGroups(ctx, p.groupIds, `Removed printer ${p.name}`, ctx.member._id);
    return null;
  },
});
