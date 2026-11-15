import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { setupAuth } from "../tests/convex/auth";
import { enrollDevice, probe } from "../tests/convex/devices";
import { asMember, giveStepUp, makeOrg, type T } from "../tests/convex/identity";
import { createKeys, MASTER_A, setMaster } from "../tests/convex/phase5";
import { DRIVER_ROW } from "../tests/convex/matrixRows";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { auditPolicy } from "./lib/audit";
import { snapshotGroupConfig, snapshotGroupsBatched } from "./lib/groupConfig";
import { MAX_SNAPSHOT_GROUPS_TOTAL, SNAPSHOT_BATCH_GROUPS, SNAPSHOT_SYNC_GROUPS } from "./lib/limits";

// Phase 5 Step 20b: scheduler batches for group configuration versions, the cleanup after a group is deleted, and the driver results
// re-tag beyond one page.

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
  const adm = await asMember(t, { role: "admin", orgId });
  await giveStepUp(t, adm);
  return { t, orgId, admin: adm.as };
}
type Env = Awaited<ReturnType<typeof setup>>;

const makeGroups = (e: Env, n: number) =>
  e.t.run(async (ctx) => {
    const ids: Id<"groups">[] = [];
    for (let i = 0; i < n; i++) ids.push(await ctx.db.insert("groups", { orgId: e.orgId, name: `G${String(i).padStart(3, "0")}`, revision: 0, createdAt: i }));
    return ids;
  });

const profile = (groupIds: Id<"groups">[]) => ({ name: "Staff", ssid: "Acme-Staff", hidden: false, security: "open" as const, autoConnect: true, groupIds });
const configs = (e: Env) => e.t.run((ctx) => ctx.db.query("groupConfigs").collect());
/** The newest configuration of a group, parsed. */
const latest = (e: Env, groupId: Id<"groups">) =>
  e.t.run(async (ctx) => {
    const row = await ctx.db.query("groupConfigs").withIndex("by_group_version", (q) => q.eq("groupId", groupId)).order("desc").first();
    return row === null ? null : (JSON.parse(row.config) as { wifi: unknown[] });
  });

describe("snapshotGroupsBatched", () => {
  test("a Wi-Fi profile in 25 groups: 10 versions in the call, the other 15 by scheduled batches of 10", async () => {
    const e = await setup();
    const groups = await makeGroups(e, 25);
    await e.admin.mutation(api.networks.saveWifi, profile(groups));
    expect(await configs(e)).toHaveLength(SNAPSHOT_SYNC_GROUPS);
    const scheduled = await e.t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled.filter((s) => s.name.includes("snapshotBatch"))).toHaveLength(2); // 10 + 5
    await drain(e.t);
    expect(await configs(e)).toHaveLength(25);
    for (const g of groups) expect((await latest(e, g))?.wifi).toHaveLength(1);
  });

  test("an edit that lands before a batch runs wins: the batch builds from the live rows and writes nothing new", async () => {
    const e = await setup();
    const groups = await makeGroups(e, 25);
    const { id } = await e.admin.mutation(api.networks.saveWifi, profile(groups));
    await e.admin.mutation(api.networks.deleteWifi, { id }); // before any batch ran
    await drain(e.t);
    for (const g of groups) expect((await latest(e, g))?.wifi).toHaveLength(0);
    // The batches of the first save and of the delete agree: no group has more versions than it needs (v1 with the profile, v2 without).
    for (const g of groups.slice(0, SNAPSHOT_SYNC_GROUPS)) expect((await e.t.run((ctx) => ctx.db.query("groupConfigs").withIndex("by_group_version", (q) => q.eq("groupId", g)).collect())).length).toBe(2);
    for (const g of groups.slice(SNAPSHOT_SYNC_GROUPS)) expect((await e.t.run((ctx) => ctx.db.query("groupConfigs").withIndex("by_group_version", (q) => q.eq("groupId", g)).collect())).length).toBe(1);
  });

  test("running a batch again changes nothing (idempotent); a deleted group is skipped", async () => {
    const e = await setup();
    const groups = await makeGroups(e, 3);
    await e.t.run((ctx) => snapshotGroupConfig(ctx, groups[0]!, "first"));
    const run = () => e.t.mutation(internal.groupBatches.snapshotBatch, { groupIds: groups, reason: "again" });
    expect(await run()).toBe(3);
    const before = (await configs(e)).length;
    const second = await probe(run);
    expect(second.result).toBe(3);
    expect(second.io.writes).toBe(0);
    expect((await configs(e)).length).toBe(before);
    await e.t.run((ctx) => ctx.db.delete(groups[2]!));
    expect(await run()).toBe(2);
  });

  test("more than the absolute bound is too_large before anything is written; sizes of the constants", async () => {
    const e = await setup();
    expect(SNAPSHOT_BATCH_GROUPS).toBe(10);
    const ids = await makeGroups(e, 3);
    const many = Array.from({ length: MAX_SNAPSHOT_GROUPS_TOTAL + 1 }, (_, i) => `${i}` as unknown as Id<"groups">);
    await expect(e.t.run((ctx) => snapshotGroupsBatched(ctx, many, "x"))).rejects.toThrow(/too_large/);
    expect(await configs(e)).toHaveLength(0);
    expect(await e.t.run((ctx) => snapshotGroupsBatched(ctx, ids, "x"))).toBe(0); // all synchronous, nothing scheduled
  });
});

describe("groups:remove cleanup", () => {
  test("drops the group from Wi-Fi, printers and drivers, cancels its live broadcasts, deletes its rollout, configurations and exceptions", async () => {
    const e = await setup();
    const [gone, keep] = await makeGroups(e, 2) as [Id<"groups">, Id<"groups">];
    const now = Date.now();
    const rows = await e.t.run(async (ctx) => {
      const wifi = await ctx.db.insert("wifiProfiles", { orgId: e.orgId, name: "A", ssid: "A", hidden: false, security: "open", autoConnect: true, groupIds: [gone, keep], revision: 3, createdAt: 1 });
      const printer = await ctx.db.insert("printers", { orgId: e.orgId, name: "P", kind: "raw", address: "10.0.0.1", driver: "Generic / Text Only", groupIds: [gone, keep], defaultForGroupIds: [gone], revision: 2, createdAt: 1 });
      const driver = await ctx.db.insert("drivers", DRIVER_ROW(e.orgId, "Drv", [gone]));
      // A rollout row and 25 versions (3 batches), 150 exceptions (2 batches).
      await snapshotGroupConfig(ctx, gone, "first");
      for (let v = 2; v <= 25; v++) await ctx.db.insert("groupConfigs", { orgId: e.orgId, groupId: gone, version: v, config: "{}", contentHash: `h${v}`, createdAt: 1, reason: "x" });
      for (let i = 0; i < 150; i++) {
        await ctx.db.insert("lockdownExceptions", { orgId: e.orgId, groupId: gone, rule: { kind: "hash", sha256: String(i).padStart(64, "0"), layers: ["appLocker"] }, reason: "", createdAt: 1 });
      }
      await ctx.db.insert("lockdownExceptions", { orgId: e.orgId, groupId: keep, rule: { kind: "hash", sha256: "f".repeat(64), layers: ["appLocker"] }, reason: "", createdAt: 1 });
      await snapshotGroupConfig(ctx, keep, "first");
      // 60 broadcasts at the group (50 live, 10 cancelled; two batches of 50) and 1 at the other group.
      const base = { orgId: e.orgId, style: "banner" as const, title: "T", body: "B", ackRequired: false };
      for (let i = 0; i < 60; i++) {
        await ctx.db.insert("broadcasts", { ...base, target: { kind: "group", id: gone }, createdAt: now + i, ...(i < 10 ? { cancelledAt: now } : {}) });
      }
      const other = await ctx.db.insert("broadcasts", { ...base, target: { kind: "group", id: keep }, createdAt: now });
      return { wifi, printer, driver, other };
    });
    await e.admin.mutation(api.groups.remove, { groupId: gone });
    await drain(e.t);

    const after = await e.t.run(async (ctx) => ({
      wifi: await ctx.db.get(rows.wifi),
      printer: await ctx.db.get(rows.printer),
      driver: await ctx.db.get(rows.driver),
      rollout: await ctx.db.query("groupRollouts").withIndex("by_group", (q) => q.eq("groupId", gone)).collect(),
      configs: await ctx.db.query("groupConfigs").withIndex("by_group_version", (q) => q.eq("groupId", gone)).collect(),
      exceptions: await ctx.db.query("lockdownExceptions").withIndex("by_org_group", (q) => q.eq("orgId", e.orgId).eq("groupId", gone)).collect(),
      live: await ctx.db.query("broadcasts").withIndex("by_org_open", (q) => q.eq("orgId", e.orgId).eq("cancelledAt", undefined)).collect(),
      all: await ctx.db.query("broadcasts").withIndex("by_target_created", (q) => q.eq("target.kind", "group").eq("target.id", gone)).collect(),
      keepRollout: await ctx.db.query("groupRollouts").withIndex("by_group", (q) => q.eq("groupId", keep)).collect(),
      keepConfigs: await ctx.db.query("groupConfigs").withIndex("by_group_version", (q) => q.eq("groupId", keep)).collect(),
      keepExceptions: await ctx.db.query("lockdownExceptions").withIndex("by_org_group", (q) => q.eq("orgId", e.orgId).eq("groupId", keep)).collect(),
    }));
    // The id is gone from the profiles; their revisions are NOT bumped (no other group re-applies because of it).
    expect(after.wifi).toMatchObject({ groupIds: [keep], revision: 3 });
    expect(after.printer).toMatchObject({ groupIds: [keep], defaultForGroupIds: [], revision: 2 });
    expect(after.driver).toMatchObject({ groupIds: [] });
    expect(after.rollout).toEqual([]);
    expect(after.configs).toEqual([]);
    expect(after.exceptions).toEqual([]);
    // Every broadcast at the deleted group is cancelled (kept as history); only the other group's one is still live.
    expect(after.all).toHaveLength(60);
    expect(after.all.every((b) => b.cancelledAt !== undefined)).toBe(true);
    expect(after.live.map((b) => b._id)).toEqual([rows.other]);
    // The other group is untouched.
    expect(after.keepRollout).toHaveLength(1);
    expect(after.keepConfigs).toHaveLength(1);
    expect(after.keepExceptions).toHaveLength(1);
  });

  test("cancelling at a deleted group frees the 20-live-broadcast cap of the organization", async () => {
    const e = await setup();
    const [gone, keep] = await makeGroups(e, 2) as [Id<"groups">, Id<"groups">];
    const send = (groupId: Id<"groups">) => e.admin.mutation(api.broadcasts.send, { target: { kind: "group", id: groupId }, style: "banner", title: "Hi", body: "There", ackRequired: false });
    for (let i = 0; i < 20; i++) await send(gone);
    await expect(send(keep)).rejects.toThrow(/too_large/);
    await e.admin.mutation(api.groups.remove, { groupId: gone });
    await drain(e.t);
    await expect(send(keep)).resolves.toMatchObject({ targetCount: 0 });
  });

  test("a group that still exists is left alone (the cleanup refuses to run)", async () => {
    const e = await setup();
    const [g] = await makeGroups(e, 1) as [Id<"groups">];
    await e.t.run((ctx) => snapshotGroupConfig(ctx, g, "first"));
    await e.t.mutation(internal.groupBatches.cleanupDeletedGroup, { orgId: e.orgId, groupId: g });
    await drain(e.t);
    expect(await configs(e)).toHaveLength(1);
  });
});

describe("driverResults re-tag beyond one page", () => {
  test("a PC with 120 driver result rows: a move re-tags all of them, a revoke clears them all", async () => {
    const e = await setup();
    const [a, b] = await makeGroups(e, 2) as [Id<"groups">, Id<"groups">];
    const dev = await enrollDevice(e.t, e.orgId, { groupId: a });
    await e.t.run(async (ctx) => {
      for (let i = 0; i < 120; i++) {
        const driverId = await ctx.db.insert("drivers", DRIVER_ROW(e.orgId, `Drv ${i}`, []));
        await ctx.db.insert("driverResults", { orgId: e.orgId, deviceId: dev.deviceId, driverId, state: "installed", driverRevision: 1, attempts: 0, groupId: a, updatedAt: 1 });
      }
    });
    const tags = () => e.t.run(async (ctx) => (await ctx.db.query("driverResults").withIndex("by_device_driver", (q) => q.eq("deviceId", dev.deviceId)).collect()).map((r) => r.groupId ?? "none"));
    await e.admin.mutation(api.fleet.move, { deviceId: dev.deviceId, expectedRevision: 0, groupId: b });
    // The call tags the first 50 and schedules the rest.
    expect((await tags()).filter((g) => g === b)).toHaveLength(50);
    await drain(e.t);
    expect((await tags()).every((g) => g === b)).toBe(true);
    await e.admin.mutation(api.fleet.revoke, { deviceId: dev.deviceId });
    await drain(e.t);
    expect((await tags()).every((g) => g === "none")).toBe(true);
  });
});
