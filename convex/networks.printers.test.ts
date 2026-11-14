import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { setupAuth } from "../tests/convex/auth";
import { enrollDevice } from "../tests/convex/devices";
import { asMember, giveStepUp, makeOrg, type T } from "../tests/convex/identity";
import { createKeys, MASTER_A, setMaster } from "../tests/convex/phase5";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { auditPolicy } from "./lib/audit";
import { MAX_NETWORK_SNAPSHOT_GROUPS, MAX_ORG_PRINTERS } from "./lib/limits";

// Printers on the server (Phase 5 Step 14, plan 4.15, 4.20): save / delete / list / detail, the approved driver
// list, the address rules, the one-default-per-group rule, the group snapshot cap and the signed document.

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

type Over = Partial<{
  name: string;
  kind: "ipp" | "raw" | "lpr" | "share";
  address: string;
  port: number;
  queue: string;
  driver: string;
  defaultForGroupIds: Id<"groups">[];
}>;
const printer = (groupIds: Id<"groups">[], over: Over = {}) => ({
  name: "Front desk",
  kind: "ipp" as const,
  address: "ipp://10.0.0.20:631/ipp/print",
  driver: "Microsoft IPP Class Driver",
  groupIds,
  defaultForGroupIds: [] as Id<"groups">[],
  ...over,
});

const printers = (e: Env) => e.t.run((ctx) => ctx.db.query("printers").collect());
const audits = (e: Env) => e.t.run(async (ctx) => (await ctx.db.query("auditLog").collect()).map((a) => a.action));

async function fetchPrinters(t: T, d: { deviceId: Id<"devices">; secret: string }) {
  const head = await t.query(api.devices.headState, { deviceId: d.deviceId, deviceSecret: d.secret });
  if (head.kind !== "ok" || head.head === null) throw new Error("no head");
  const env = await t.query(api.devices.fetchDesired, { deviceId: d.deviceId, deviceSecret: d.secret, version: head.head.version });
  const payload = JSON.parse(env.payload) as { doc: { printers?: Record<string, unknown>[] } };
  return { version: head.head.version, printers: payload.doc.printers ?? [] };
}

describe("networks:savePrinter", () => {
  test("creates (revision 1), audits, snapshots the group; a repeat of the same values writes nothing", async () => {
    const e = await setup();
    const made = await e.admin.mutation(api.networks.savePrinter, printer([e.groupId], { defaultForGroupIds: [e.groupId] }));
    expect(made.revision).toBe(1);
    const versions = await e.t.run((ctx) => ctx.db.query("groupConfigs").withIndex("by_group_version", (q) => q.eq("groupId", e.groupId)).collect());
    expect(versions).toHaveLength(1);
    expect(JSON.parse(versions[0]!.config).printers).toEqual([
      expect.objectContaining({ id: made.id, name: "Front desk", kind: "ipp", port: null, queue: null, isDefault: true, revision: 1 }),
    ]);
    expect(await audits(e)).toContain("printer.created");

    await drain(e.t);
    const same = await e.admin.mutation(api.networks.savePrinter, { ...printer([e.groupId], { defaultForGroupIds: [e.groupId] }), id: made.id, expectedRevision: 1 });
    expect(same).toEqual({ id: made.id, revision: 1 });
    expect(await e.t.run((ctx) => ctx.db.query("groupConfigs").collect())).toHaveLength(1);
    expect((await audits(e)).filter((a) => a === "printer.updated")).toHaveLength(0);
  });

  test("an update bumps the revision and makes a new configuration; stale, missing revision and a viewer are refused", async () => {
    const e = await setup();
    const { id } = await e.admin.mutation(api.networks.savePrinter, printer([e.groupId]));
    const r = await e.admin.mutation(api.networks.savePrinter, { ...printer([e.groupId], { name: "Back office" }), id, expectedRevision: 1 });
    expect(r.revision).toBe(2);
    expect((await e.t.run((ctx) => ctx.db.query("groupConfigs").collect())).length).toBe(2);
    expect(await audits(e)).toContain("printer.updated");
    await expect(e.admin.mutation(api.networks.savePrinter, { ...printer([e.groupId]), id, expectedRevision: 1 })).rejects.toThrow(/stale_edit/);
    await expect(e.admin.mutation(api.networks.savePrinter, { ...printer([e.groupId]), id })).rejects.toThrow(/invalid_argument/);
    await expect(e.admin.mutation(api.networks.savePrinter, { ...printer([e.groupId]), expectedRevision: 1 })).rejects.toThrow(/invalid_argument/);
    await expect(e.viewer.mutation(api.networks.savePrinter, printer([e.groupId]))).rejects.toThrow(/forbidden/);
    await expect(e.viewer.mutation(api.networks.deletePrinter, { id })).rejects.toThrow(/forbidden/);
  });

  test("an unknown driver is refused; the inbox list and names the organization approved are accepted", async () => {
    const e = await setup();
    await expect(e.admin.mutation(api.networks.savePrinter, printer([e.groupId], { driver: "HP Universal Printing PCL 6" }))).rejects.toThrow(/not_approved/);
    await expect(e.admin.mutation(api.networks.savePrinter, printer([e.groupId], { driver: "" }))).rejects.toThrow(/invalid_argument/);
    for (const [i, driver] of ["Microsoft IPP Class Driver", "Microsoft PCL6 Class Driver", "Microsoft PS Class Driver", "Generic / Text Only"].entries()) {
      await e.admin.mutation(api.networks.savePrinter, printer([e.groupId], { name: `P${i}`, address: `ipp://10.0.0.${i + 1}/ipp/print`, driver }));
    }
    await e.t.run(async (ctx) => {
      const org = (await ctx.db.get(e.orgId))!;
      await ctx.db.patch(e.orgId, { phase5Settings: { ...org.phase5Settings, approvedPrinterDrivers: ["HP Universal Printing PCL 6"] } });
    });
    const ok = await e.admin.mutation(api.networks.savePrinter, printer([e.groupId], { name: "HP", address: "ipp://10.0.0.9/ipp/print", driver: "hp universal printing pcl 6" }));
    expect((await printers(e)).find((p) => p._id === ok.id)!.driver).toBe("HP Universal Printing PCL 6");
    expect((await e.viewer.query(api.networks.list, {})).approvedDrivers).toEqual([
      "Microsoft IPP Class Driver",
      "Microsoft PCL6 Class Driver",
      "Microsoft PS Class Driver",
      "Generic / Text Only",
      "HP Universal Printing PCL 6",
    ]);
  });

  test("validation: name, address by kind, port, queue, groups of another organization", async () => {
    const e = await setup();
    const bad = (over: Over, groups = [e.groupId]) => e.admin.mutation(api.networks.savePrinter, printer(groups, over));
    await expect(bad({ name: " " })).rejects.toThrow(/invalid_argument/);
    await expect(bad({ name: "x".repeat(61) })).rejects.toThrow(/invalid_argument/);
    await expect(bad({ name: "Front\\desk" })).rejects.toThrow(/invalid_argument/);
    await expect(bad({ name: "A,B" })).rejects.toThrow(/invalid_argument/);
    await expect(bad({ address: "ipp://u:p@10.0.0.1/ipp/print" })).rejects.toThrow(/invalid_argument/);
    await expect(bad({ kind: "raw", address: "10.0.0.1:9100" })).rejects.toThrow(/invalid_argument/);
    await expect(bad({ kind: "raw", address: "10.0.0.1", port: 70000 })).rejects.toThrow(/invalid_argument/);
    await expect(bad({ kind: "lpr", address: "10.0.0.1" })).rejects.toThrow(/invalid_argument/);
    await expect(bad({ kind: "share", address: "print01\\hp" })).rejects.toThrow(/invalid_argument/);
    await bad({ name: "Raw", kind: "raw", address: "10.0.0.1", port: 9101 });
    await bad({ name: "Lpr", kind: "lpr", address: "10.0.0.2", queue: "lp" });
    await bad({ name: "Share", kind: "share", address: "\\\\print01\\hp" });
    const rows = await printers(e);
    expect(rows.find((p) => p.name === "Raw")).toMatchObject({ port: 9101 });
    expect(rows.find((p) => p.name === "Lpr")).toMatchObject({ queue: "lp" });
    const other = await makeOrg(e.t, "Other");
    const foreign = await e.t.run((ctx) => ctx.db.insert("groups", { orgId: other, name: "Theirs", revision: 0, createdAt: Date.now() }));
    await expect(bad({ name: "Foreign" }, [foreign])).rejects.toThrow(/not_found/);
  });

  test("names are unique (case-insensitive); a group has one default printer and a default must be an assigned group", async () => {
    const e = await setup();
    const a = await e.admin.mutation(api.networks.savePrinter, printer([e.groupId], { defaultForGroupIds: [e.groupId] }));
    await expect(e.admin.mutation(api.networks.savePrinter, printer([e.groupId], { name: "FRONT DESK", address: "ipp://10.0.0.2/ipp/print" }))).rejects.toThrow(/taken/);
    await expect(e.admin.mutation(api.networks.savePrinter, printer([e.groupId], { name: "Second", address: "ipp://10.0.0.2/ipp/print", defaultForGroupIds: [e.groupId] }))).rejects.toThrow(/taken/);
    await expect(e.admin.mutation(api.networks.savePrinter, printer([], { name: "Second", address: "ipp://10.0.0.2/ipp/print", defaultForGroupIds: [e.groupId] }))).rejects.toThrow(/not_assigned/);
    // The first printer can be renamed to itself (case change) and keep its default.
    await e.admin.mutation(api.networks.savePrinter, { ...printer([e.groupId], { name: "front desk", defaultForGroupIds: [e.groupId] }), id: a.id, expectedRevision: 1 });
    // Turning its default off lets the second one take it.
    await e.admin.mutation(api.networks.savePrinter, { ...printer([e.groupId], { name: "front desk" }), id: a.id, expectedRevision: 2 });
    await e.admin.mutation(api.networks.savePrinter, printer([e.groupId], { name: "Second", address: "ipp://10.0.0.2/ipp/print", defaultForGroupIds: [e.groupId] }));
  });

  test("limits: 100 printers per organization, at most 10 groups touched by one save", async () => {
    const e = await setup();
    await e.t.run(async (ctx) => {
      for (let i = 0; i < MAX_ORG_PRINTERS; i++) {
        await ctx.db.insert("printers", { orgId: e.orgId, name: `P${i}`, kind: "raw", address: "10.0.0.1", driver: "Generic / Text Only", groupIds: [], defaultForGroupIds: [], revision: 1, createdAt: 1 });
      }
    });
    await expect(e.admin.mutation(api.networks.savePrinter, printer([]))).rejects.toThrow(/too_large/);
    const e2 = await setup();
    const groups = await e2.t.run(async (ctx) => {
      const ids: Id<"groups">[] = [];
      for (let i = 0; i < MAX_NETWORK_SNAPSHOT_GROUPS + 1; i++) ids.push(await ctx.db.insert("groups", { orgId: e2.orgId, name: `G${i}`, revision: 0, createdAt: 1 }));
      return ids;
    });
    await expect(e2.admin.mutation(api.networks.savePrinter, printer(groups))).rejects.toThrow(/too_large/);
    const ok = await e2.admin.mutation(api.networks.savePrinter, printer(groups.slice(0, MAX_NETWORK_SNAPSHOT_GROUPS)));
    // An update that would touch 11 groups (10 before + 1 new) is refused too.
    await expect(
      e2.admin.mutation(api.networks.savePrinter, { ...printer([...groups.slice(1, MAX_NETWORK_SNAPSHOT_GROUPS + 1)]), id: ok.id, expectedRevision: 1 }),
    ).rejects.toThrow(/too_large/);
  });
});

describe("networks:list, printerDetail and deletePrinter", () => {
  test("list and detail carry what the form needs, count the apply states and never leak another organization's printer", async () => {
    const e = await setup();
    const dev = await enrollDevice(e.t, e.orgId, { groupId: e.groupId });
    const made = await e.admin.mutation(api.networks.savePrinter, printer([e.groupId], { kind: "lpr", address: "10.0.0.7", queue: "lp", defaultForGroupIds: [e.groupId] }));
    const list = await e.viewer.query(api.networks.list, {});
    expect(list.printers).toEqual([
      expect.objectContaining({ _id: made.id, name: "Front desk", kind: "lpr", address: "10.0.0.7", port: null, queue: "lp", revision: 1, groupCount: 1, defaultGroupCount: 1, groups: [{ _id: e.groupId, name: "Sales" }] }),
    ]);
    expect(list.wifi).toEqual([]);

    await e.t.run(async (ctx) => {
      await ctx.db.insert("deviceApplyReports", {
        orgId: e.orgId,
        deviceId: dev.deviceId,
        appliedVersion: 1,
        contentHash: "0".repeat(64),
        config: { groupId: e.groupId, version: 1, ring: "everyone" },
        state: "applied",
        layers: {
          staff: { mode: "off", state: "ok" },
          machine: { mode: "off", state: "ok" },
          appLocker: { mode: "off", state: "ok" },
          appControl: { mode: "off", state: "ok" },
          procWatch: { mode: "off", state: "ok" },
          boot: { mode: "off", state: "ok" },
          performance: { mode: "off", state: "ok" },
        },
        wifi: [],
        printers: [{ printerId: made.id, revision: 1, state: "failed", detail: "driver_missing" }],
        capabilities: [],
        updatedAt: Date.now(),
      });
    });
    const detail = await e.viewer.query(api.networks.printerDetail, { id: made.id });
    expect(detail).toMatchObject({ groupIds: [e.groupId], defaultForGroupIds: [e.groupId], counts: { applied: 0, failed: 1, waiting: 0, unsupported: 0, sampled: 1, capped: false } });

    const other = await makeOrg(e.t, "Other");
    const foreign = await e.t.run((ctx) => ctx.db.insert("printers", { orgId: other, name: "Theirs", kind: "raw", address: "10.9.9.9", driver: "Generic / Text Only", groupIds: [], defaultForGroupIds: [], revision: 1, createdAt: 1 }));
    await expect(e.viewer.query(api.networks.printerDetail, { id: foreign })).rejects.toThrow(/not_found/);
  });

  test("the printer reaches the device's signed document, and deleting it removes it and publishes a new version", async () => {
    const e = await setup();
    const dev = await enrollDevice(e.t, e.orgId, { groupId: e.groupId });
    const keep = await e.admin.mutation(api.networks.savePrinter, printer([e.groupId], { name: "Keep", address: "ipp://10.0.0.1/ipp/print", defaultForGroupIds: [e.groupId] }));
    const gone = await e.admin.mutation(api.networks.savePrinter, printer([e.groupId], { name: "Gone", kind: "raw", address: "10.0.0.2", port: 9101 }));
    await drain(e.t);
    const before = await fetchPrinters(e.t, dev);
    expect(before.printers.map((p) => p.id)).toEqual([keep.id, gone.id].sort());
    expect(before.printers.find((p) => p.id === keep.id)).toEqual({
      id: keep.id,
      name: "Keep",
      kind: "ipp",
      address: "ipp://10.0.0.1/ipp/print",
      port: null,
      queue: null,
      driver: "Microsoft IPP Class Driver",
      isDefault: true,
      revision: 1,
    });
    expect(before.printers.find((p) => p.id === gone.id)).toMatchObject({ name: "Gone", kind: "raw", port: 9101, isDefault: false });

    await e.admin.mutation(api.networks.deletePrinter, { id: gone.id });
    await drain(e.t);
    const after = await fetchPrinters(e.t, dev);
    expect(after.version).toBeGreaterThan(before.version);
    expect(after.printers.map((p) => p.id)).toEqual([keep.id]);
    expect(await audits(e)).toContain("printer.deleted");
    expect((await e.viewer.query(api.networks.list, {})).printers.map((p) => p._id)).toEqual([keep.id]);
  });

  test("deleting a printer assigned to more than 10 groups is refused (the snapshot cap)", async () => {
    const e = await setup();
    const groups = await e.t.run(async (ctx) => {
      const ids: Id<"groups">[] = [];
      for (let i = 0; i < MAX_NETWORK_SNAPSHOT_GROUPS + 1; i++) ids.push(await ctx.db.insert("groups", { orgId: e.orgId, name: `G${i}`, revision: 0, createdAt: 1 }));
      return ids;
    });
    const id = await e.t.run((ctx) => ctx.db.insert("printers", { orgId: e.orgId, name: "Wide", kind: "raw", address: "10.0.0.3", driver: "Generic / Text Only", groupIds: groups, defaultForGroupIds: [], revision: 1, createdAt: 1 }));
    await expect(e.admin.mutation(api.networks.deletePrinter, { id })).rejects.toThrow(/too_large/);
  });
});
