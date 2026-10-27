import { afterEach, describe, expect, test, vi } from "vitest";
import { setupAuth } from "../tests/convex/auth";
import { deviceRows, enrollDevice, onlineCount, orgStatsOf, probe } from "../tests/convex/devices";
import { asMember, expectCode, expectNoSecrets, giveStepUp, makeOrg, type T } from "../tests/convex/identity";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { sha256HexSync } from "./lib/crypto";
import { MINUTE_MS } from "./lib/limits";
import { OrgScopeError, scopedDb } from "./lib/orgDb";

// Fleet screens' backend (plan Step 7 items 4, 6, 10-13).

afterEach(() => {
  vi.useRealTimers();
});

async function admin(t: T, orgId: Id<"organizations">, stepUp: "fresh" | "stale" = "fresh") {
  const m = await asMember(t, { role: "admin", mfa: true, orgId });
  if (stepUp === "fresh") await giveStepUp(t, m);
  else await giveStepUp(t, m, { verifiedAgoMs: 6 * MINUTE_MS, activeAgoMs: 0 });
  return m;
}

async function group(t: T, orgId: Id<"organizations">, name = "Sales") {
  return await t.run((ctx) => ctx.db.insert("groups", { orgId, name, revision: 0, createdAt: Date.now() }));
}

async function auditActions(t: T, orgId: Id<"organizations">) {
  const rows = await t.run((ctx) => ctx.db.query("auditLog").withIndex("by_org_at", (q) => q.eq("orgId", orgId)).take(100));
  return rows.map((r) => r.action);
}

const page = (numItems = 50) => ({ paginationOpts: { numItems, cursor: null } });

describe("orgDb (A15): handlers are born scoped", () => {
  test("an index range over another organization throws; another org's row reads as null", async () => {
    const t = await setupAuth();
    const orgA = await makeOrg(t, "A");
    const orgB = await makeOrg(t, "B");
    const foreign = await enrollDevice(t, orgB);
    const groupB = await group(t, orgB);
    const throws = (f: () => Promise<unknown>) => expect((async () => await f())()).rejects.toThrow(OrgScopeError);
    await t.run(async (ctx) => {
      const db = scopedDb(ctx.db, { orgId: orgA, checked: new Set() });
      await throws(() => db.query("devices").withIndex("by_org", (q) => q.eq("orgId", orgB)).take(1));
      // An id range needs an id this call saw in its own org.
      await throws(() => db.query("devices").withIndex("by_group", (q) => q.eq("groupId", groupB)).take(1));
      await throws(() => db.query("deviceSummary").withIndex("by_device", (q) => q.eq("deviceId", foreign.deviceId)).take(1));
      // No index at all on an org table.
      await throws(() => db.query("devices").take(1));
      // Search must filter by the caller's org.
      await throws(() => db.query("devices").withSearchIndex("search_name", (q) => q.search("name", "PC")).take(1));
      expect(await db.get(foreign.deviceId)).toBeNull();
      expect(await db.get(orgB)).toBeNull();
      expect(await db.get(orgA)).not.toBeNull();
      // Own org: fine.
      expect(await db.query("devices").withIndex("by_org", (q) => q.eq("orgId", orgA)).take(1)).toEqual([]);
      await expect(db.insert("groups", { orgId: orgB, name: "x" })).rejects.toThrow(OrgScopeError);
    });
  });

  test("fleet:get of another organization's device answers not_found", async () => {
    const t = await setupAuth();
    const orgB = await makeOrg(t, "B");
    const foreign = await enrollDevice(t, orgB);
    const a = await admin(t, await makeOrg(t, "A"));
    await expectCode(a.as.query(api.fleet.get, { deviceId: foreign.deviceId }), "not_found");
    await expectCode(a.as.mutation(api.fleet.rename, { deviceId: foreign.deviceId, expectedRevision: 0, name: "x" }), "not_found");
  });
});

describe("fleet:list", () => {
  test("newest first, group filter, name search, presence and summary columns; never a hash", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const sales = await group(t, orgId, "Sales");
    const one = await enrollDevice(t, orgId, { name: "Front desk", groupId: sales });
    const two = await enrollDevice(t, orgId, { name: "Back office" });
    await enrollDevice(t, await makeOrg(t, "Other"), { name: "Front desk" });
    const viewer = await asMember(t, { role: "viewer", orgId });

    const all = await viewer.as.query(api.fleet.list, page());
    expect(all.page.map((r) => r.name)).toEqual(["Back office", "Front desk"]);
    expect(all.page[1]).toMatchObject({
      _id: one.deviceId,
      groupId: sales,
      groupName: "Sales",
      kioskEnabled: true,
      presence: { online: true, revoked: false },
      summary: { agentVersion: "0.4.0", outOfSupport: false },
      latestVersion: null,
    });
    const byGroup = await viewer.as.query(api.fleet.list, { ...page(), groupId: sales });
    expect(byGroup.page.map((r) => r._id)).toEqual([one.deviceId]);
    const found = await viewer.as.query(api.fleet.list, { ...page(), search: "office" });
    expect(found.page.map((r) => r._id)).toEqual([two.deviceId]);
    const foundInGroup = await viewer.as.query(api.fleet.list, { ...page(), search: "front", groupId: sales });
    expect(foundInGroup.page.map((r) => r._id)).toEqual([one.deviceId]);
    expectNoSecrets(all, [sha256HexSync(one.secret), sha256HexSync(two.secret)]);
    await expectCode(viewer.as.query(api.fleet.list, page(51)), "invalid_argument");
    await expectCode(viewer.as.query(api.fleet.list, { ...page(), search: "x".repeat(101) }), "invalid_argument");
  });

  test("a page of 50 reads <= 250 documents and <= 64 KB, and no liveness, report, credentials or payload", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const g = await group(t, orgId);
    // `enrollPerOrg` allows 10 per minute: step the clock 7 s per enrollment.
    const start = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    for (let i = 0; i < 52; i++) {
      vi.setSystemTime(start + i * 7_000);
      await enrollDevice(t, orgId, { name: `PC ${i}`, groupId: i % 2 === 0 ? g : undefined });
    }
    const devs = await t.run((ctx) => ctx.db.query("deviceCredentials").take(60));
    expect(devs).toHaveLength(52);
    const viewer = await asMember(t, { role: "viewer", orgId });
    const { result, io } = await probe(() => viewer.as.query(api.fleet.list, page()));
    expect(result.page).toHaveLength(50);
    expect(io.reads).toBeLessThanOrEqual(250);
    expect(io.readBytes).toBeLessThanOrEqual(64 * 1024);
    for (const table of ["deviceLiveness", "deviceReports", "deviceCredentials", "desiredStates", "deviceStatus"]) {
      expect(io.tables.has(table), table).toBe(false);
    }
  });
});

describe("fleet:get", () => {
  test("detail with report, group, state and flags; no hash", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const d = await enrollDevice(t, orgId);
    await t.mutation(api.devices.heartbeat, {
      deviceId: d.deviceId,
      deviceSecret: d.secret,
      status: { agentVersion: "0.4.0", osBuild: "26100.1", osEdition: "Enterprise", diskFreeGb: 12, compat: { blockers: [] } },
    });
    const viewer = await asMember(t, { role: "viewer", orgId });
    const got = await viewer.as.query(api.fleet.get, { deviceId: d.deviceId });
    expect(got).toMatchObject({
      name: "PC",
      revision: 0,
      state: "active",
      group: null,
      flags: { noGroup: true, revoked: false, rotateCredential: false },
      report: { osEdition: "Enterprise", diskFreeGb: 12 },
      summary: { diskBand: "10to20" },
      versions: [],
    });
    expectNoSecrets(got, [sha256HexSync(d.secret)]);
  });
});

describe("fleet writes", () => {
  test("rename and move: revision, audit only on change, viewer refused, counters", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const sales = await group(t, orgId);
    const d = await enrollDevice(t, orgId);
    const a = await admin(t, orgId);
    const viewer = await asMember(t, { role: "viewer", orgId });
    await giveStepUp(t, viewer);
    await expectCode(viewer.as.mutation(api.fleet.rename, { deviceId: d.deviceId, expectedRevision: 0, name: "X" }), "forbidden");

    expect(await a.as.mutation(api.fleet.rename, { deviceId: d.deviceId, expectedRevision: 0, name: "  Lobby  " })).toEqual({ revision: 1 });
    expect(await a.as.mutation(api.fleet.rename, { deviceId: d.deviceId, expectedRevision: 1, name: "Lobby" })).toEqual({ revision: 1 });
    await expectCode(a.as.mutation(api.fleet.rename, { deviceId: d.deviceId, expectedRevision: 0, name: "Other" }), "stale_edit");
    expect((await orgStatsOf(t, orgId))?.noGroupDeviceCount).toBe(1);
    expect(await a.as.mutation(api.fleet.move, { deviceId: d.deviceId, expectedRevision: 1, groupId: sales })).toEqual({ revision: 2 });
    expect((await orgStatsOf(t, orgId))?.noGroupDeviceCount).toBe(0);
    expect(await a.as.mutation(api.fleet.move, { deviceId: d.deviceId, expectedRevision: 2, groupId: sales })).toEqual({ revision: 2 });
    const foreignGroup = await group(t, await makeOrg(t, "B"));
    await expectCode(a.as.mutation(api.fleet.move, { deviceId: d.deviceId, expectedRevision: 2, groupId: foreignGroup }), "not_found");
    // Moving publishes the device (queue row); renaming does not.
    const queue = await t.run((ctx) => ctx.db.query("publishQueue").withIndex("by_org", (q) => q.eq("orgId", orgId)).unique());
    expect(queue?.deviceIds).toEqual([d.deviceId]);
    expect(await auditActions(t, orgId)).toEqual(["device.enrolled", "device.renamed", "device.moved"]);
  });

  test("kiosk: turning it off needs a fresh step-up, on does not; unchanged = no write", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const d = await enrollDevice(t, orgId);
    const stale = await admin(t, orgId, "stale");
    const fresh = await admin(t, orgId);
    expect(await stale.as.mutation(api.fleet.setKiosk, { deviceId: d.deviceId, expectedRevision: 0, enabled: true })).toEqual({ revision: 0 });
    await expectCode(stale.as.mutation(api.fleet.setKiosk, { deviceId: d.deviceId, expectedRevision: 0, enabled: false }), "step_up_required");
    expect(await fresh.as.mutation(api.fleet.setKiosk, { deviceId: d.deviceId, expectedRevision: 0, enabled: false })).toEqual({ revision: 1 });
    expect(await stale.as.mutation(api.fleet.setKiosk, { deviceId: d.deviceId, expectedRevision: 1, enabled: true })).toEqual({ revision: 2 });
    expect(await auditActions(t, orgId)).toEqual(["device.enrolled", "device.kioskDisabled", "device.kioskEnabled"]);
  });

  test("revoke (major) lowers every counter once; remove only after revoke, keeps the counters, deletes the rows", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t, "Free", { plan: "free" });
    const d = await enrollDevice(t, orgId);
    await t.mutation(api.devices.heartbeat, {
      deviceId: d.deviceId,
      deviceSecret: d.secret,
      status: { agentVersion: "0.4.0", osBuild: "19045.1", osEdition: "Professional", compat: null },
    });
    expect(await orgStatsOf(t, orgId)).toMatchObject({ deviceCount: 1, noGroupDeviceCount: 1, outOfSupportCount: 1 });
    expect(await onlineCount(t, orgId)).toBe(1);
    const stale = await admin(t, orgId, "stale");
    const a = await admin(t, orgId);
    await expectCode(stale.as.mutation(api.fleet.revoke, { deviceId: d.deviceId }), "step_up_required");
    await expectCode(a.as.mutation(api.fleet.remove, { deviceId: d.deviceId }), "conflict");

    await a.as.mutation(api.fleet.revoke, { deviceId: d.deviceId });
    await a.as.mutation(api.fleet.revoke, { deviceId: d.deviceId }); // idempotent
    expect(await orgStatsOf(t, orgId)).toMatchObject({ deviceCount: 0, noGroupDeviceCount: 0, outOfSupportCount: 0 });
    expect(await onlineCount(t, orgId)).toBe(0);
    expect(await t.mutation(api.devices.heartbeat, { deviceId: d.deviceId, deviceSecret: d.secret })).toEqual({ kind: "rejected" });
    expect(await t.query(api.devices.desiredState, { deviceId: d.deviceId, deviceSecret: d.secret })).toEqual({ kind: "revoked" });
    const listed = await a.as.query(api.fleet.list, page());
    expect(listed.page[0]?.presence).toMatchObject({ online: false, revoked: true });
    // A revoked device frees its plan slot (free plan: 2 devices).
    await enrollDevice(t, orgId);
    await enrollDevice(t, orgId);
    expect((await orgStatsOf(t, orgId))?.deviceCount).toBe(2);

    await expectCode(stale.as.mutation(api.fleet.remove, { deviceId: d.deviceId }), "step_up_required");
    await t.run((ctx) => ctx.db.insert("desiredStates", { orgId, scope: d.deviceId, version: 1, doc: {} }));
    await a.as.mutation(api.fleet.remove, { deviceId: d.deviceId });
    await t.finishAllScheduledFunctions(() => {});
    const rows = await deviceRows(t, d.deviceId);
    expect(rows).toEqual({ device: null, cred: null, liveness: null, presence: null, summary: null, report: null });
    expect(await t.run((ctx) => ctx.db.query("desiredStates").withIndex("by_scope_version", (q) => q.eq("scope", d.deviceId)).first())).toBeNull();
    expect((await orgStatsOf(t, orgId))?.deviceCount).toBe(2);
    expect(await t.query(api.devices.desiredState, { deviceId: d.deviceId, deviceSecret: d.secret })).toEqual({ kind: "unknownDevice" });
    await expectCode(a.as.mutation(api.fleet.remove, { deviceId: d.deviceId }), "not_found");
    expect((await auditActions(t, orgId)).filter((x) => x.startsWith("device.r"))).toEqual(["device.revoked", "device.removed"]);
  });

  test("credential rotation request reaches the agent in its answers", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const d = await enrollDevice(t, orgId);
    const a = await admin(t, orgId);
    await a.as.mutation(api.fleet.requestCredentialRotation, { deviceId: d.deviceId });
    await a.as.mutation(api.fleet.requestCredentialRotation, { deviceId: d.deviceId });
    expect(await t.mutation(api.devices.heartbeat, { deviceId: d.deviceId, deviceSecret: d.secret })).toMatchObject({ rotateCredential: true });
    expect(await t.mutation(api.devices.ping, { deviceId: d.deviceId, deviceSecret: d.secret })).toMatchObject({ rotateCredential: true });
    expect((await a.as.query(api.fleet.get, { deviceId: d.deviceId })).flags.rotateCredential).toBe(true);
    expect((await auditActions(t, orgId)).filter((x) => x === "device.credentialRotationRequested")).toHaveLength(1);
  });
});

describe("watch mode and check now (plan 4.9)", () => {
  test("watch: 60-second answers until fastUntil, writes only when it extends by 2 minutes, plan switch", async () => {
    const t = await setupAuth();
    const start = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(start);
    const orgId = await makeOrg(t, "Free", { plan: "free" });
    const d = await enrollDevice(t, orgId);
    const viewer = await asMember(t, { role: "viewer", orgId });
    const w1 = await viewer.as.mutation(api.fleet.watch, { deviceId: d.deviceId });
    expect(w1.fastUntil).toBe(Math.ceil((start + 5 * MINUTE_MS) / MINUTE_MS) * MINUTE_MS);
    const again = await probe(() => viewer.as.mutation(api.fleet.watch, { deviceId: d.deviceId }));
    expect(again.result.fastUntil).toBe(w1.fastUntil);
    expect(again.io.writes).toBe(0);
    expect(await t.mutation(api.devices.heartbeat, { deviceId: d.deviceId, deviceSecret: d.secret })).toMatchObject({ nextPingInMs: MINUTE_MS });
    expect(await viewer.as.query(api.fleet.liveness, { deviceId: d.deviceId })).toMatchObject({ online: true, fastUntil: w1.fastUntil });
    vi.setSystemTime(w1.fastUntil! + 1);
    expect(await t.mutation(api.devices.ping, { deviceId: d.deviceId, deviceSecret: d.secret })).toMatchObject({ nextPingInMs: 30 * MINUTE_MS });
    expect((await deviceRows(t, d.deviceId)).liveness?.fastUntil).toBeUndefined();
    // watchMode off in the plan: nothing happens.
    await t.run(async (ctx) => {
      const p = (await ctx.db.query("orgPlans").withIndex("by_org", (q) => q.eq("orgId", orgId)).unique())!;
      await ctx.db.patch(p._id, { limits: { ...p.limits, watchMode: false } });
    });
    expect(await viewer.as.mutation(api.fleet.watch, { deviceId: d.deviceId })).toEqual({ fastUntil: null });
  });

  test("watch is rate limited per member (6/min) when it writes", async () => {
    const t = await setupAuth();
    const start = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(start);
    const orgId = await makeOrg(t);
    const d = await enrollDevice(t, orgId);
    const viewer = await asMember(t, { role: "viewer", orgId });
    // Clearing `fastUntil` between calls makes every call a write.
    const clear = () =>
      t.run(async (ctx) => {
        const l = (await ctx.db.query("deviceLiveness").withIndex("by_device", (q) => q.eq("deviceId", d.deviceId)).unique())!;
        await ctx.db.patch(l._id, { fastUntil: undefined });
      });
    for (let i = 0; i < 6; i++) {
      await clear();
      expect((await viewer.as.mutation(api.fleet.watch, { deviceId: d.deviceId })).fastUntil).not.toBeNull();
    }
    await clear();
    await expectCode(viewer.as.mutation(api.fleet.watch, { deviceId: d.deviceId }), "rate_limited");
    // A call that does not need to write never consumes (and never fails).
    const until = start + 5 * MINUTE_MS;
    await t.run(async (ctx) => {
      const l = (await ctx.db.query("deviceLiveness").withIndex("by_device", (q) => q.eq("deviceId", d.deviceId)).unique())!;
      await ctx.db.patch(l._id, { fastUntil: until });
    });
    expect(await viewer.as.mutation(api.fleet.watch, { deviceId: d.deviceId })).toEqual({ fastUntil: until });
  });

  test("check now: <= 50 devices, 1 per minute per org, answered by the next call of each device", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const d1 = await enrollDevice(t, orgId);
    const d2 = await enrollDevice(t, orgId);
    const a = await admin(t, orgId);
    const viewer = await asMember(t, { role: "viewer", orgId });
    await giveStepUp(t, viewer);
    await expectCode(viewer.as.mutation(api.fleet.checkNow, { deviceIds: [d1.deviceId] }), "forbidden");
    await expectCode(a.as.mutation(api.fleet.checkNow, { deviceIds: [] }), "invalid_argument");
    await expectCode(a.as.mutation(api.fleet.checkNow, { deviceIds: Array.from({ length: 51 }, (_, i) => `x${i}`) }), "invalid_argument");
    const { checkId } = await a.as.mutation(api.fleet.checkNow, { deviceIds: [d1.deviceId, d2.deviceId, d1.deviceId] });
    await expectCode(a.as.mutation(api.fleet.checkNow, { deviceIds: [d1.deviceId] }), "rate_limited");
    const before = await a.as.query(api.fleet.checkResult, { checkId });
    expect(before.items).toEqual([
      { deviceId: d1.deviceId, answered: false },
      { deviceId: d2.deviceId, answered: false },
    ]);
    await t.mutation(api.devices.ping, { deviceId: d1.deviceId, deviceSecret: d1.secret });
    const after = await a.as.query(api.fleet.checkResult, { checkId });
    expect(after.items.map((i) => i.answered)).toEqual([true, false]);
    await expectCode(viewer.as.query(api.fleet.checkResult, { checkId }), "forbidden");
    const foreign = await admin(t, await makeOrg(t, "B"));
    await expectCode(foreign.as.query(api.fleet.checkResult, { checkId }), "not_found");
  });
});
