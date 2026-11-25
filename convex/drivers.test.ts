import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { setupAuth } from "../tests/convex/auth";
import { enrollDevice, probe } from "../tests/convex/devices";
import { asMember, giveStepUp, makeOrg, type T } from "../tests/convex/identity";
import { createKeys, MASTER_A, setMaster } from "../tests/convex/phase5";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { auditPolicy } from "./lib/audit";
import { buildGroupConfig, serializeGroupConfig } from "./lib/groupConfig";
import { MAX_DEVICE_DRIVERS, MAX_NETWORK_GROUPS, MAX_ORG_DRIVERS } from "./lib/limits";
import { DEFAULT_LOCKDOWN_SETTINGS } from "./lib/lockdownValidators";

// Drivers on the server (Phase 5 Step 14b, PRD 24.2): save / delete / retry / detail, the rules of every field, the group snapshot
// cap, the signed document, the approved printer driver list, and the result rows the agent reports.

beforeEach(() => {
  vi.useFakeTimers();
  auditPolicy.strict = true;
  setMaster(MASTER_A);
});
afterEach(() => {
  vi.useRealTimers();
  auditPolicy.strict = false;
  setMaster(undefined);
});
const drain = (t: T) => t.finishAllScheduledFunctions(vi.runAllTimers);

async function setup() {
  const t = await setupAuth();
  const orgId = await makeOrg(t, "Acme", { noKey: true });
  await createKeys(t, orgId);
  const groupId = await t.run((ctx) => ctx.db.insert("groups", { orgId, name: "Sales", revision: 0, createdAt: Date.now() }));
  const adm = await asMember(t, { role: "admin", orgId });
  await giveStepUp(t, adm);
  const view = await asMember(t, { role: "viewer", orgId });
  return { t, orgId, groupId, admin: adm.as, viewer: view.as };
}
type Env = Awaited<ReturnType<typeof setup>>;

const SHA = "ab".repeat(32);
type Over = Partial<{
  name: string;
  kind: "inf" | "exe" | "msi";
  deviceClass: "printer" | "scanner" | "other";
  url: string;
  sha256: string;
  sizeBytes: number;
  inf: string;
  silentArgs: string[];
  successExitCodes: number[];
  provides: string[];
}>;
const driver = (groupIds: Id<"groups">[], over: Over = {}) => ({
  name: "Front desk driver",
  kind: "inf" as const,
  deviceClass: "printer" as const,
  url: "https://downloads.example.test/front.zip",
  sha256: SHA,
  sizeBytes: 1_000_000,
  inf: "Drivers/front.inf",
  silentArgs: [] as string[],
  successExitCodes: [] as number[],
  provides: ["Front Desk Series"],
  groupIds,
  ...over,
});

const drivers = (e: Env) => e.t.run((ctx) => ctx.db.query("drivers").collect());
const audits = (e: Env) => e.t.run(async (ctx) => (await ctx.db.query("auditLog").collect()).map((a) => a.action));
const versionsOf = (e: Env, groupId: Id<"groups">) =>
  e.t.run((ctx) => ctx.db.query("groupConfigs").withIndex("by_group_version", (q) => q.eq("groupId", groupId)).collect());

describe("drivers:save", () => {
  test("creates (revision 1), audits, snapshots the group; a repeat of the same values writes nothing", async () => {
    const e = await setup();
    const made = await e.admin.mutation(api.drivers.save, driver([e.groupId]));
    expect(made.revision).toBe(1);
    const versions = await versionsOf(e, e.groupId);
    expect(versions).toHaveLength(1);
    expect(JSON.parse(versions[0]!.config).drivers).toEqual([
      {
        id: made.id,
        name: "Front desk driver",
        kind: "inf",
        url: "https://downloads.example.test/front.zip",
        sha256: SHA,
        sizeBytes: 1_000_000,
        inf: "Drivers/front.inf",
        silentArgs: [],
        successExitCodes: [],
        revision: 1,
      },
    ]);
    expect(await audits(e)).toContain("driver.created");

    await drain(e.t);
    const same = await e.admin.mutation(api.drivers.save, { ...driver([e.groupId]), id: made.id, expectedRevision: 1 });
    expect(same).toEqual({ id: made.id, revision: 1 });
    expect(await e.t.run((ctx) => ctx.db.query("groupConfigs").collect())).toHaveLength(1);
    expect((await audits(e)).filter((a) => a === "driver.updated")).toHaveLength(0);
  });

  test("an update bumps the revision and makes a new configuration; stale, missing revision and a viewer are refused", async () => {
    const e = await setup();
    const { id } = await e.admin.mutation(api.drivers.save, driver([e.groupId]));
    const r = await e.admin.mutation(api.drivers.save, { ...driver([e.groupId], { sizeBytes: 5 }), id, expectedRevision: 1 });
    expect(r.revision).toBe(2);
    expect((await versionsOf(e, e.groupId)).length).toBe(2);
    expect(await audits(e)).toContain("driver.updated");
    await expect(e.admin.mutation(api.drivers.save, { ...driver([e.groupId]), id, expectedRevision: 1 })).rejects.toThrow(/stale_edit/);
    await expect(e.admin.mutation(api.drivers.save, { ...driver([e.groupId]), id })).rejects.toThrow(/invalid_argument/);
    await expect(e.admin.mutation(api.drivers.save, { ...driver([e.groupId]), expectedRevision: 1 })).rejects.toThrow(/invalid_argument/);
    await expect(e.viewer.mutation(api.drivers.save, driver([e.groupId]))).rejects.toThrow(/forbidden/);
    await expect(e.viewer.mutation(api.drivers.remove, { id })).rejects.toThrow(/forbidden/);
    await expect(e.viewer.mutation(api.drivers.retry, { id })).rejects.toThrow(/forbidden/);
  });

  test("validation: every field, by kind", async () => {
    const e = await setup();
    const bad = (over: Over, groups = [e.groupId]) => e.admin.mutation(api.drivers.save, driver(groups, over));
    await expect(bad({ name: " " })).rejects.toThrow(/invalid_argument/);
    await expect(bad({ name: "x".repeat(61) })).rejects.toThrow(/length/);
    await expect(bad({ name: "a\u0007b" })).rejects.toThrow(/characters/);
    await expect(bad({ url: "http://downloads.example.test/a.zip" })).rejects.toThrow(/not_https/);
    await expect(bad({ url: "https://user:pw@downloads.example.test/a.zip" })).rejects.toThrow(/not_https/);
    await expect(bad({ url: "" })).rejects.toThrow(/not_https/);
    await expect(bad({ sha256: "abc" })).rejects.toThrow(/format/);
    await expect(bad({ sha256: "g".repeat(64) })).rejects.toThrow(/format/);
    await expect(bad({ sizeBytes: -1 })).rejects.toThrow(/range/);
    await expect(bad({ sizeBytes: 1.5 })).rejects.toThrow(/range/);
    await expect(bad({ sizeBytes: 4 * 1024 * 1024 * 1024 + 1 })).rejects.toThrow(/range/);
    // inf: required for "inf", refused for the others, and a plain relative path ending in .inf.
    await expect(bad({ inf: "" })).rejects.toThrow(/empty/);
    await expect(bad({ inf: undefined })).rejects.toThrow(/empty/);
    for (const inf of ["/abs/a.inf", "\\abs\\a.inf", "C:\\a.inf", "a/../b.inf", "../a.inf", "a//b.inf", "a/./b.inf", "a.inf:stream", "a.sys"]) {
      await expect(bad({ inf }), inf).rejects.toThrow(/invalid_argument/);
    }
    await expect(bad({ inf: `${"a".repeat(117)}.inf` })).rejects.toThrow(/length/);
    await expect(bad({ kind: "exe", inf: "a.inf", silentArgs: ["/S"] })).rejects.toThrow(/not_allowed/);
    // exe: silent arguments required, bounded.
    await expect(bad({ kind: "exe", inf: undefined, silentArgs: [] })).rejects.toThrow(/empty/);
    await expect(bad({ kind: "exe", inf: undefined, silentArgs: ["  "] })).rejects.toThrow(/empty/);
    await expect(bad({ kind: "exe", inf: undefined, silentArgs: Array.from({ length: 17 }, () => "/S") })).rejects.toThrow(/too_many/);
    await expect(bad({ kind: "exe", inf: undefined, silentArgs: ["x".repeat(201)] })).rejects.toThrow(/length/);
    await expect(bad({ kind: "exe", inf: undefined, silentArgs: ["a\u0001b"], name: "Exe2" })).rejects.toThrow(/characters/);
    await expect(bad({ kind: "exe", inf: undefined, silentArgs: ["/S"], successExitCodes: Array.from({ length: 9 }, (_, i) => i + 1) })).rejects.toThrow(/too_many/);
    await expect(bad({ kind: "exe", inf: undefined, silentArgs: ["/S"], successExitCodes: [2 ** 31] })).rejects.toThrow(/range/);
    await expect(bad({ kind: "exe", inf: undefined, silentArgs: ["/S"], successExitCodes: [1.5] })).rejects.toThrow(/range/);
    // provides
    await expect(bad({ provides: [""] })).rejects.toThrow(/empty/);
    await expect(bad({ provides: ["x".repeat(101)] })).rejects.toThrow(/length/);
    await expect(bad({ provides: ["a\u0000b"] })).rejects.toThrow(/characters/);
    await expect(bad({ provides: Array.from({ length: 11 }, (_, i) => `Name ${i}`) })).rejects.toThrow(/too_many/);
    await expect(bad({ name: "Foreign" }, ["jh7bp5vtxgdvg1vq4dzkrymc8s8gvwzm" as Id<"groups">])).rejects.toThrow(/invalid_argument|not_found/);
  });

  test("normalizes: lower-case hash, trimmed values, an msi / scanner / other driver, exe codes sorted without 0, provides deduped", async () => {
    const e = await setup();
    await e.admin.mutation(api.drivers.save, driver([e.groupId], { name: "  Scanner pack ", deviceClass: "scanner", sha256: SHA.toUpperCase(), url: " https://d.example.test/s.zip ", provides: [" A ", "a", "B"] }));
    await e.admin.mutation(api.drivers.save, driver([e.groupId], { name: "Msi", kind: "msi", inf: undefined, silentArgs: ["/ignored"], successExitCodes: [5], deviceClass: "other", provides: [] }));
    await e.admin.mutation(api.drivers.save, driver([e.groupId], { name: "Exe", kind: "exe", inf: undefined, silentArgs: [" /S ", ""], successExitCodes: [3010, 0, 3, 3010], provides: [] }));
    const rows = await drivers(e);
    expect(rows.find((d) => d.name === "Scanner pack")).toMatchObject({ deviceClass: "scanner", sha256: SHA, url: "https://d.example.test/s.zip", provides: ["A", "B"], inf: "Drivers/front.inf" });
    expect(rows.find((d) => d.name === "Msi")).toMatchObject({ kind: "msi", silentArgs: [], successExitCodes: [], deviceClass: "other" });
    expect(rows.find((d) => d.name === "Msi")!.inf).toBeUndefined();
    expect(rows.find((d) => d.name === "Exe")).toMatchObject({ kind: "exe", silentArgs: ["/S"], successExitCodes: [3, 3010] });
  });

  test("names are unique (case-insensitive); a driver can be renamed to itself with another case", async () => {
    const e = await setup();
    const a = await e.admin.mutation(api.drivers.save, driver([e.groupId]));
    await expect(e.admin.mutation(api.drivers.save, driver([e.groupId], { name: "FRONT DESK DRIVER" }))).rejects.toThrow(/taken/);
    const r = await e.admin.mutation(api.drivers.save, { ...driver([e.groupId], { name: "front desk driver" }), id: a.id, expectedRevision: 1 });
    expect(r.revision).toBe(2);
  });

  test("limits: 50 drivers per organization, at most 10 groups touched by one save", async () => {
    const e = await setup();
    const row = (i: number) => ({ orgId: e.orgId, name: `D${i}`, kind: "inf" as const, deviceClass: "other" as const, url: "https://x.example.test/a.zip", sha256: SHA, sizeBytes: 0, inf: "a.inf", silentArgs: [], successExitCodes: [], provides: [], groupIds: [], revision: 1, createdAt: 1 });
    await e.t.run(async (ctx) => {
      for (let i = 0; i < MAX_ORG_DRIVERS; i++) await ctx.db.insert("drivers", row(i));
    });
    await expect(e.admin.mutation(api.drivers.save, driver([]))).rejects.toThrow(/too_large/);
    const e2 = await setup();
    const groups = await e2.t.run(async (ctx) => {
      const ids: Id<"groups">[] = [];
      for (let i = 0; i < MAX_NETWORK_GROUPS + 1; i++) ids.push(await ctx.db.insert("groups", { orgId: e2.orgId, name: `G${i}`, revision: 0, createdAt: 1 }));
      return ids;
    });
    await expect(e2.admin.mutation(api.drivers.save, driver(groups))).rejects.toThrow(/too_many/);
    // Step 20b: more than 10 groups is fine (the rest is snapshotted by scheduled batches).
    const ok = await e2.admin.mutation(api.drivers.save, driver(groups.slice(0, 11)));
    await e2.admin.mutation(api.drivers.save, { ...driver(groups.slice(1, 13)), id: ok.id, expectedRevision: 1 });
  });

  test("a group of another organization is refused", async () => {
    const e = await setup();
    const other = await makeOrg(e.t, "Other");
    const foreign = await e.t.run((ctx) => ctx.db.insert("groups", { orgId: other, name: "Theirs", revision: 0, createdAt: Date.now() }));
    await expect(e.admin.mutation(api.drivers.save, driver([foreign]))).rejects.toThrow(/not_found/);
  });
});

describe("drivers:detail, retry and remove", () => {
  test("detail carries the fields and counts the results of the assigned groups; another organization's driver is not found", async () => {
    const e = await setup();
    const made = await e.admin.mutation(api.drivers.save, driver([e.groupId], { provides: ["A", "B"] }));
    const dev1 = await enrollDevice(e.t, e.orgId, { groupId: e.groupId });
    const dev2 = await enrollDevice(e.t, e.orgId, { groupId: e.groupId });
    const dev3 = await enrollDevice(e.t, e.orgId, { groupId: e.groupId });
    const dev4 = await enrollDevice(e.t, e.orgId, { groupId: e.groupId });
    const elsewhere = await e.t.run((ctx) => ctx.db.insert("groups", { orgId: e.orgId, name: "Other group", revision: 0, createdAt: 1 }));
    const put = (d: { deviceId: Id<"devices"> }, state: "installed" | "failed" | "pending" | "removed", extra: { exitCode?: number; groupId?: Id<"groups"> } = {}) =>
      e.t.run((ctx) => ctx.db.insert("driverResults", { orgId: e.orgId, deviceId: d.deviceId, driverId: made.id, state, driverRevision: 1, attempts: 1, groupId: extra.groupId ?? e.groupId, ...(extra.exitCode === undefined ? {} : { exitCode: extra.exitCode }), updatedAt: Date.now() }));
    await put(dev1, "installed", { exitCode: 3010 });
    await put(dev2, "installed");
    await put(dev3, "failed");
    // A PC of a group that no longer assigns the driver is not counted.
    await put(dev4, "installed", { groupId: elsewhere });
    const d = await e.viewer.query(api.drivers.detail, { id: made.id });
    expect(d).toMatchObject({
      _id: made.id,
      name: "Front desk driver",
      kind: "inf",
      deviceClass: "printer",
      url: "https://downloads.example.test/front.zip",
      sha256: SHA,
      inf: "Drivers/front.inf",
      silentArgs: [],
      successExitCodes: [],
      provides: ["A", "B"],
      revision: 1,
      groupCount: 1,
      groups: [{ _id: e.groupId, name: "Sales" }],
      groupIds: [e.groupId],
      counts: { installed: 2, failed: 1, pending: 0, removed: 0, unsupported: 0, restartNeeded: 1, sampled: 3, capped: false },
    });
    const other = await makeOrg(e.t, "Other");
    const foreign = await e.t.run((ctx) => ctx.db.insert("drivers", { orgId: other, name: "Theirs", kind: "msi", deviceClass: "other", url: "https://x.example.test/a.msi", sha256: SHA, sizeBytes: 0, silentArgs: [], successExitCodes: [], provides: [], groupIds: [], revision: 1, createdAt: 1 }));
    await expect(e.viewer.query(api.drivers.detail, { id: foreign })).rejects.toThrow(/not_found/);
  });

  test("retry bumps the revision without a field change, audits and makes a new configuration", async () => {
    const e = await setup();
    const made = await e.admin.mutation(api.drivers.save, driver([e.groupId]));
    const r = await e.admin.mutation(api.drivers.retry, { id: made.id });
    expect(r).toEqual({ revision: 2 });
    expect((await drivers(e))[0]!.revision).toBe(2);
    expect(await audits(e)).toContain("driver.retried");
    const versions = await versionsOf(e, e.groupId);
    expect(versions).toHaveLength(2);
    expect(JSON.parse(versions[1]!.config).drivers[0].revision).toBe(2);
  });

  test("remove deletes the driver, publishes a new version without it, and purges its results (in batches)", async () => {
    const e = await setup();
    const dev = await enrollDevice(e.t, e.orgId, { groupId: e.groupId });
    const made = await e.admin.mutation(api.drivers.save, driver([e.groupId]));
    await e.t.run(async (ctx) => {
      await ctx.db.insert("driverResults", { orgId: e.orgId, deviceId: dev.deviceId, driverId: made.id, state: "installed", driverRevision: 1, attempts: 0, groupId: e.groupId, updatedAt: 1 });
      for (let i = 0; i < 100; i++) {
        await ctx.db.insert("driverResults", { orgId: e.orgId, deviceId: dev.deviceId, driverId: made.id, state: "installed", driverRevision: 1, attempts: 0, groupId: e.groupId, updatedAt: 2 + i });
      }
    });
    await e.admin.mutation(api.drivers.remove, { id: made.id });
    await drain(e.t);
    expect(await drivers(e)).toEqual([]);
    expect(await e.t.run((ctx) => ctx.db.query("driverResults").collect())).toEqual([]);
    expect(await audits(e)).toContain("driver.deleted");
    const versions = await versionsOf(e, e.groupId);
    expect(JSON.parse(versions[versions.length - 1]!.config).drivers).toBeUndefined();
    await expect(e.admin.mutation(api.drivers.remove, { id: made.id })).rejects.toThrow(/not_found/);
  });

  test("a driver assigned to more than 10 groups can be deleted and retried (the rest is snapshotted by scheduled batches)", async () => {
    const e = await setup();
    const groups = await e.t.run(async (ctx) => {
      const ids: Id<"groups">[] = [];
      for (let i = 0; i < 11; i++) ids.push(await ctx.db.insert("groups", { orgId: e.orgId, name: `G${i}`, revision: 0, createdAt: 1 }));
      return ids;
    });
    const id = await e.t.run((ctx) => ctx.db.insert("drivers", { orgId: e.orgId, name: "Wide", kind: "msi", deviceClass: "other", url: "https://x.example.test/a.msi", sha256: SHA, sizeBytes: 0, silentArgs: [], successExitCodes: [], provides: [], groupIds: groups, revision: 1, createdAt: 1 }));
    await expect(e.admin.mutation(api.drivers.retry, { id })).resolves.toEqual({ revision: 2 });
    await expect(e.admin.mutation(api.drivers.remove, { id })).resolves.toBeNull();
  });
});

describe("the signed document and the group configuration", () => {
  async function fetchDrivers(t: T, d: { deviceId: Id<"devices">; secret: string }) {
    const head = await t.query(api.devices.headState, { deviceId: d.deviceId, deviceSecret: d.secret });
    if (head.kind !== "ok" || head.head === null) throw new Error("no head");
    const env = await t.query(api.devices.fetchDesired, { deviceId: d.deviceId, deviceSecret: d.secret, version: head.head.version });
    const payload = JSON.parse(env.payload) as { doc: { drivers?: Record<string, unknown>[] } };
    return { version: head.head.version, drivers: payload.doc.drivers };
  }

  test("the driver reaches the device's document in the contract's shape, and deleting it publishes a new version without it", async () => {
    const e = await setup();
    const dev = await enrollDevice(e.t, e.orgId, { groupId: e.groupId });
    const keep = await e.admin.mutation(api.drivers.save, driver([e.groupId]));
    const gone = await e.admin.mutation(api.drivers.save, driver([e.groupId], { name: "Exe pack", kind: "exe", inf: undefined, silentArgs: ["/S"], successExitCodes: [3010] }));
    await drain(e.t);
    const before = await fetchDrivers(e.t, dev);
    expect(before.drivers!.map((d) => d.id)).toEqual([keep.id, gone.id].sort());
    expect(before.drivers!.find((d) => d.id === keep.id)).toEqual({
      id: keep.id,
      name: "Front desk driver",
      kind: "inf",
      url: "https://downloads.example.test/front.zip",
      sha256: SHA,
      sizeBytes: 1_000_000,
      inf: "Drivers/front.inf",
      silentArgs: [],
      successExitCodes: [],
      revision: 1,
    });
    expect(before.drivers!.find((d) => d.id === gone.id)).toMatchObject({ kind: "exe", inf: null, silentArgs: ["/S"], successExitCodes: [3010] });
    await e.admin.mutation(api.drivers.remove, { id: gone.id });
    await drain(e.t);
    const after = await fetchDrivers(e.t, dev);
    expect(after.version).toBeGreaterThan(before.version);
    expect(after.drivers!.map((d) => d.id)).toEqual([keep.id]);
  });

  test("a group without drivers keeps the configuration text (and content hash) it had before drivers existed; an empty list is in the document", async () => {
    const e = await setup();
    const dev = await enrollDevice(e.t, e.orgId, { groupId: e.groupId });
    const content = buildGroupConfig(e.groupId, {
      settings: DEFAULT_LOCKDOWN_SETTINGS,
      exceptions: [],
      wifi: [],
      printers: [],
      drivers: [],
    });
    expect(serializeGroupConfig(content)).not.toContain("drivers");
    const withOne = buildGroupConfig(e.groupId, {
      settings: DEFAULT_LOCKDOWN_SETTINGS,
      exceptions: [],
      wifi: [],
      printers: [],
      drivers: [{ _id: "d1" as Id<"drivers">, name: "D", kind: "msi", url: "https://x.example.test/a.msi", sha256: SHA, sizeBytes: 1, inf: undefined, silentArgs: [], successExitCodes: [], revision: 1, groupIds: [e.groupId] }],
    });
    expect(serializeGroupConfig(withOne)).toContain('"drivers":[{"id":"d1"');
    // A printer save snapshots the group: its configuration has no `drivers` key, its document has an empty list.
    await e.admin.mutation(api.networks.savePrinter, {
      name: "Front desk",
      kind: "ipp",
      address: "ipp://10.0.0.20:631/ipp/print",
      driver: "Microsoft IPP Class Driver",
      groupIds: [e.groupId],
      defaultForGroupIds: [],
    });
    await drain(e.t);
    expect(await e.t.run((ctx) => ctx.db.query("groupConfigs").collect()).then((rows) => rows.every((r) => !r.config.includes("drivers")))).toBe(true);
    expect((await fetchDrivers(e.t, dev)).drivers).toEqual([]);
  });

  test("a group configuration with more than 20 drivers is refused (invalid_argument)", () => {
    const row = (i: number) => ({ _id: `d${i}` as Id<"drivers">, name: `D${i}`, kind: "msi" as const, url: "https://x.example.test/a.msi", sha256: SHA, sizeBytes: 1, inf: undefined, silentArgs: [], successExitCodes: [], revision: 1, groupIds: ["g1" as Id<"groups">] });
    const input = (n: number) => ({ settings: DEFAULT_LOCKDOWN_SETTINGS, exceptions: [], wifi: [], printers: [], drivers: Array.from({ length: n }, (_, i) => row(i)) });
    expect(() => buildGroupConfig("g1", input(MAX_DEVICE_DRIVERS))).not.toThrow();
    expect(() => buildGroupConfig("g1", input(MAX_DEVICE_DRIVERS + 1))).toThrow(/too_many|invalid_argument/);
  });
});

describe("networks:list and the printer picker", () => {
  test("list carries the drivers and the names they provide; savePrinter accepts a delivered name and refuses an unknown one", async () => {
    const e = await setup();
    const made = await e.admin.mutation(api.drivers.save, driver([e.groupId], { provides: ["Front Desk Series", "Front Desk Series XL"] }));
    const list = await e.viewer.query(api.networks.list, {});
    expect(list.drivers).toEqual([
      expect.objectContaining({ _id: made.id, name: "Front desk driver", kind: "inf", deviceClass: "printer", revision: 1, groupCount: 1, groups: [{ _id: e.groupId, name: "Sales" }], provides: ["Front Desk Series", "Front Desk Series XL"] }),
    ]);
    expect(list.approvedDrivers).toEqual([
      "Microsoft IPP Class Driver",
      "Microsoft PCL6 Class Driver",
      "Microsoft PS Class Driver",
      "Generic / Text Only",
      "Front Desk Series",
      "Front Desk Series XL",
    ]);
    expect(list.addedDrivers).toEqual([]);
    const printer = (driverName: string) => ({ name: "Front desk", kind: "ipp" as const, address: "ipp://10.0.0.20:631/ipp/print", driver: driverName, groupIds: [e.groupId], defaultForGroupIds: [] });
    const ok = await e.admin.mutation(api.networks.savePrinter, printer("front desk series xl"));
    expect((await e.t.run((ctx) => ctx.db.get(ok.id)))!.driver).toBe("Front Desk Series XL");
    await expect(e.admin.mutation(api.networks.savePrinter, { ...printer("Unknown Series"), name: "Other" })).rejects.toThrow(/not_approved/);
    // Once the package is deleted its names are not offered any more.
    await e.admin.mutation(api.drivers.remove, { id: made.id });
    await drain(e.t);
    expect((await e.viewer.query(api.networks.list, {})).approvedDrivers).toHaveLength(4);
    await expect(e.admin.mutation(api.networks.savePrinter, { ...printer("Front Desk Series"), name: "Third" })).rejects.toThrow(/not_approved/);
  });
});

describe("networks:setApprovedPrinterDrivers (owner decision 2a)", () => {
  test("replaces the admin-added names: trimmed, deduped (case-insensitive, first spelling wins), inbox names dropped; audits once", async () => {
    const e = await setup();
    const out = await e.admin.mutation(api.networks.setApprovedPrinterDrivers, {
      names: [" HP Universal Printing PCL 6 ", "hp universal printing pcl 6", "microsoft ipp class driver", "Brother HL"],
    });
    expect(out).toEqual({ addedDrivers: ["HP Universal Printing PCL 6", "Brother HL"] });
    const list = await e.viewer.query(api.networks.list, {});
    expect(list.addedDrivers).toEqual(["HP Universal Printing PCL 6", "Brother HL"]);
    expect(list.approvedDrivers.slice(4)).toEqual(["HP Universal Printing PCL 6", "Brother HL"]);
    expect((await audits(e)).filter((a) => a === "printers.driversChanged")).toHaveLength(1);
    // The new name now gates savePrinter.
    await e.admin.mutation(api.networks.savePrinter, { name: "HP", kind: "ipp", address: "ipp://10.0.0.9/ipp/print", driver: "brother hl", groupIds: [e.groupId], defaultForGroupIds: [] });
    // Removing every name is a change too.
    expect(await e.admin.mutation(api.networks.setApprovedPrinterDrivers, { names: [] })).toEqual({ addedDrivers: [] });
    expect((await audits(e)).filter((a) => a === "printers.driversChanged")).toHaveLength(2);
  });

  test("no change = no write and no audit row; the group configurations are not touched", async () => {
    const e = await setup();
    await e.admin.mutation(api.networks.setApprovedPrinterDrivers, { names: ["A Driver"] });
    const before = (await audits(e)).length;
    const again = await probe(() => e.admin.mutation(api.networks.setApprovedPrinterDrivers, { names: ["  A Driver "] }));
    expect(again.result).toEqual({ addedDrivers: ["A Driver"] });
    expect(again.io.writes).toBe(0);
    expect((await audits(e)).length).toBe(before);
    expect(await e.t.run((ctx) => ctx.db.query("groupConfigs").collect())).toEqual([]);
  });

  test("limits: empty, too long, control characters, more than 20", async () => {
    const e = await setup();
    const set = (names: string[]) => e.admin.mutation(api.networks.setApprovedPrinterDrivers, { names });
    await expect(set([" "])).rejects.toThrow(/empty/);
    await expect(set(["x".repeat(101)])).rejects.toThrow(/length/);
    await expect(set(["a\u0007b"])).rejects.toThrow(/characters/);
    await expect(set(Array.from({ length: 21 }, (_, i) => `Driver ${i}`))).rejects.toThrow(/too_large/);
    expect((await set(Array.from({ length: 20 }, (_, i) => `Driver ${i}`))).addedDrivers).toHaveLength(20);
    // 21 names where one is an inbox name and one a duplicate leave 19.
    const mixed = [...Array.from({ length: 19 }, (_, i) => `Driver ${i}`), "Generic / Text Only", "driver 0"];
    expect((await set(mixed)).addedDrivers).toHaveLength(19);
  });

  test("a viewer is refused; a printer that uses a name taken off the list keeps working", async () => {
    const e = await setup();
    await expect(e.viewer.mutation(api.networks.setApprovedPrinterDrivers, { names: ["X"] })).rejects.toThrow(/forbidden/);
    await e.admin.mutation(api.networks.setApprovedPrinterDrivers, { names: ["Brother HL"] });
    const made = await e.admin.mutation(api.networks.savePrinter, { name: "B", kind: "ipp", address: "ipp://10.0.0.9/ipp/print", driver: "Brother HL", groupIds: [e.groupId], defaultForGroupIds: [] });
    await e.admin.mutation(api.networks.setApprovedPrinterDrivers, { names: [] });
    expect((await e.t.run((ctx) => ctx.db.get(made.id)))!.driver).toBe("Brother HL");
    // Saving it unchanged is still refused only when something changes: the same values need a listed driver.
    await expect(e.admin.mutation(api.networks.savePrinter, { name: "B", kind: "ipp", address: "ipp://10.0.0.9/ipp/print", driver: "Brother HL", groupIds: [e.groupId], defaultForGroupIds: [], id: made.id, expectedRevision: 1 })).rejects.toThrow(/not_approved/);
  });
});

describe("driver results reported by the agent (deviceApi:report installs)", () => {
  async function seed() {
    const e = await setup();
    const dev = await enrollDevice(e.t, e.orgId, { groupId: e.groupId });
    const made = await e.admin.mutation(api.drivers.save, driver([e.groupId]));
    const creds = { deviceId: dev.deviceId, deviceSecret: dev.secret };
    const result = (driverId: string, state: string, extra: Record<string, unknown> = {}) => ({ appId: driverId, state, appRevision: 1, attempts: 1, exitCode: null, detail: null, ...extra });
    const rows = () => e.t.run((ctx) => ctx.db.query("driverResults").collect());
    return { e, dev, made, creds, result, rows };
  }

  test("stored once per (PC, driver), tagged with the PC's group; a repeat writes nothing; a new state updates the row", async () => {
    const { e, dev, made, creds, result, rows } = await seed();
    const out = await e.t.mutation(api.deviceApi.report, { ...creds, installs: [result(made.id, "failed", { exitCode: 1, detail: "exit_code", attempts: 2 }), result(made.id, "downloading")] });
    expect(out).toEqual({ accepted: { installs: 2, audit: 0 } });
    expect(await rows()).toEqual([
      expect.objectContaining({ deviceId: dev.deviceId, driverId: made.id, state: "failed", driverRevision: 1, attempts: 2, exitCode: 1, detail: "exit_code", groupId: e.groupId }),
    ]);
    // It is not an app: no install result, no failed-install count.
    expect(await e.t.run((ctx) => ctx.db.query("installResults").collect())).toEqual([]);
    expect((await e.t.run((ctx) => ctx.db.query("orgStats").withIndex("by_org", (q) => q.eq("orgId", e.orgId)).unique()))?.failedInstallCount ?? 0).toBe(0);
    const again = await probe(() => e.t.mutation(api.deviceApi.report, { ...creds, installs: [result(made.id, "failed", { exitCode: 1, detail: "exit_code", attempts: 2 })] }));
    expect(again.io.writes).toBe(0);
    await e.t.mutation(api.deviceApi.report, { ...creds, installs: [result(made.id, "installed", { exitCode: 3010, appRevision: 2, attempts: 0 })] });
    const [row] = await rows();
    expect(row).toMatchObject({ state: "installed", driverRevision: 2, exitCode: 3010, attempts: 0 });
    expect(row!.detail).toBeUndefined();
    const detail = await e.viewer.query(api.drivers.detail, { id: made.id });
    expect(detail.counts).toMatchObject({ installed: 1, restartNeeded: 1, sampled: 1 });
  });

  test("the new details are kept, an unknown one is dropped; a driver of another organization or an unknown id is ignored but accepted", async () => {
    const { e, creds, made, result, rows } = await seed();
    const other = await makeOrg(e.t, "Other");
    const foreign = await e.t.run((ctx) => ctx.db.insert("drivers", { orgId: other, name: "Theirs", kind: "msi", deviceClass: "other", url: "https://x.example.test/a.msi", sha256: SHA, sizeBytes: 0, silentArgs: [], successExitCodes: [], provides: [], groupIds: [], revision: 1, createdAt: 1 }));
    const out = await e.t.mutation(api.deviceApi.report, { ...creds, installs: [result(made.id, "failed", { detail: "unsigned_driver" }), result(foreign, "installed"), result("nothing", "installed")] });
    expect(out.accepted.installs).toBe(3);
    expect(await rows()).toHaveLength(1);
    expect((await rows())[0]!.detail).toBe("unsigned_driver");
    await e.t.mutation(api.deviceApi.report, { ...creds, installs: [result(made.id, "failed", { detail: "bad_package" })] });
    expect((await rows())[0]!.detail).toBe("bad_package");
    await e.t.mutation(api.deviceApi.report, { ...creds, installs: [result(made.id, "failed", { detail: "C:\\secret.txt" })] });
    expect((await rows())[0]!.detail).toBeUndefined();
  });

  test("the Phase 6 Step 15 warnings are kept: protected_print_on on a failure, seagull_driver_present on an installed result (a warning, not a failure)", async () => {
    const { e, creds, made, result, rows } = await seed();
    await e.t.mutation(api.deviceApi.report, { ...creds, installs: [result(made.id, "failed", { detail: "protected_print_on" })] });
    expect((await rows())[0]).toMatchObject({ state: "failed", detail: "protected_print_on" });
    await e.t.mutation(api.deviceApi.report, { ...creds, installs: [result(made.id, "installed", { detail: "seagull_driver_present", appRevision: 2, attempts: 0 })] });
    expect((await rows())[0]).toMatchObject({ state: "installed", detail: "seagull_driver_present" });
    // The warning does not count as a failure.
    const detail = await e.viewer.query(api.drivers.detail, { id: made.id });
    expect(detail.counts).toMatchObject({ installed: 1, failed: 0 });
  });

  test("removing the PC (purge) deletes its driver results; moving it re-tags them", async () => {
    const { e, dev, made, creds, result, rows } = await seed();
    await e.t.mutation(api.deviceApi.report, { ...creds, installs: [result(made.id, "installed")] });
    const other = await e.t.run((ctx) => ctx.db.insert("groups", { orgId: e.orgId, name: "Support", revision: 0, createdAt: 1 }));
    await e.admin.mutation(api.fleet.move, { deviceId: dev.deviceId, expectedRevision: 0, groupId: other });
    await drain(e.t);
    expect((await rows())[0]!.groupId).toBe(other);
    await e.admin.mutation(api.fleet.revoke, { deviceId: dev.deviceId });
    await drain(e.t);
    expect((await rows())[0]!.groupId).toBeUndefined();
    await e.admin.mutation(api.fleet.remove, { deviceId: dev.deviceId });
    await drain(e.t);
    expect(await rows()).toEqual([]);
  });
});
