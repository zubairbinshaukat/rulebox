import { afterEach, describe, expect, test, vi } from "vitest";
import { setupAuth } from "../tests/convex/auth";
import { deviceRows, enrollDevice, onlineCount, orgStatsOf, probe } from "../tests/convex/devices";
import { asMember, expectCode, expectNoSecrets, giveStepUp, makeOrg, type T } from "../tests/convex/identity";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { sha256HexSync } from "./lib/crypto";
import { MINUTE_MS } from "./lib/limits";
import { OrgScopeError, scopedDb } from "./lib/orgDb";

// Fleet screens' backend (plan Step 7 items 4, 6, 10-13).

afterEach(() => {
  vi.useRealTimers();
});

async function admin(t: T, orgId: Id<"organizations">, stepUp: "fresh" | "stale" = "fresh") {
  const m = await asMember(t, { role: "admin", orgId });
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
    await t.mutation(api.deviceApi.report, {
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
    await t.mutation(api.deviceApi.report, {
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
    await expectCode(t.mutation(api.devices.ping, { deviceId: d.deviceId, deviceSecret: d.secret }), "device_rejected");
    expect(await t.query(api.devices.headState, { deviceId: d.deviceId, deviceSecret: d.secret })).toEqual({ kind: "revoked" });
    const listed = await a.as.query(api.fleet.list, page());
    expect(listed.page[0]?.presence).toMatchObject({ online: false, revoked: true });
    // A revoked device frees its plan slot (free plan: 2 devices).
    await enrollDevice(t, orgId);
    await enrollDevice(t, orgId);
    expect((await orgStatsOf(t, orgId))?.deviceCount).toBe(2);

    await expectCode(stale.as.mutation(api.fleet.remove, { deviceId: d.deviceId }), "step_up_required");
    await t.run((ctx) => ctx.db.insert("desiredStates", { orgId, scope: d.deviceId, version: 1, doc: {} }));
    // Two failed install results and one installed of the revoked PC (untagged, as a revoke leaves them):
    // they no longer count, so the purge leaves `failedInstallCount` alone (Step 17 review).
    await t.run(async (ctx) => {
      const mk = (name: string) =>
        ctx.db.insert("apps", {
          orgId,
          name,
          kind: "desktop",
          desktop: { source: "preinstalled", exe: "{ProgramFiles}\\X\\x.exe", args: [], fileArgTemplate: [], resetFolders: [] },
          archived: false,
          revision: 1,
          createdAt: 0,
        });
      const row = (appId: Awaited<ReturnType<typeof mk>>, state: "failed" | "installed") =>
        ctx.db.insert("installResults", { orgId, deviceId: d.deviceId, appId, state, appRevision: 1, attempts: 1, updatedAt: 0 });
      await row(await mk("A"), "failed");
      await row(await mk("B"), "failed");
      await row(await mk("C"), "installed");
      const st = (await ctx.db.query("orgStats").withIndex("by_org", (q) => q.eq("orgId", orgId)).unique())!;
      await ctx.db.patch(st._id, { failedInstallCount: 1 }); // 1 elsewhere
    });
    await a.as.mutation(api.fleet.remove, { deviceId: d.deviceId });
    await t.finishAllScheduledFunctions(() => {});
    expect((await orgStatsOf(t, orgId))?.failedInstallCount).toBe(1);
    const rows = await deviceRows(t, d.deviceId);
    expect(rows).toEqual({ device: null, cred: null, liveness: null, presence: null, summary: null, report: null });
    expect(await t.run((ctx) => ctx.db.query("desiredStates").withIndex("by_scope_version", (q) => q.eq("scope", d.deviceId)).first())).toBeNull();
    expect((await orgStatsOf(t, orgId))?.deviceCount).toBe(2);
    expect(await t.query(api.devices.headState, { deviceId: d.deviceId, deviceSecret: d.secret })).toEqual({ kind: "unknownDevice" });
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
    await t.mutation(internal.publish.run, { orgId }); // the device's head (Step 8)
    const viewer = await asMember(t, { role: "viewer", orgId });
    await giveStepUp(t, viewer, { none: true }); // watch needs a finished sign-in (a PIN), not an unlock
    const w1 = await viewer.as.mutation(api.fleet.watch, { deviceId: d.deviceId });
    expect(w1.fastUntil).toBe(Math.ceil((start + 5 * MINUTE_MS) / MINUTE_MS) * MINUTE_MS);
    // Step 8: the head carries it to the agent's subscription at once.
    const head = await t.run((ctx) => ctx.db.query("desiredHeads").withIndex("by_device", (q) => q.eq("deviceId", d.deviceId)).unique());
    expect(head).toMatchObject({ fastUntil: w1.fastUntil, version: 1 });
    const again = await probe(() => viewer.as.mutation(api.fleet.watch, { deviceId: d.deviceId }));
    expect(again.result.fastUntil).toBe(w1.fastUntil);
    expect(again.io.writes).toBe(0);
    expect(await t.mutation(api.devices.ping, { deviceId: d.deviceId, deviceSecret: d.secret })).toMatchObject({ nextPingInMs: MINUTE_MS });
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
    await giveStepUp(t, viewer, { none: true });
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
    await t.mutation(internal.publish.run, { orgId }); // the devices' heads (Step 8)
    const { checkId } = await a.as.mutation(api.fleet.checkNow, { deviceIds: [d1.deviceId, d2.deviceId, d1.deviceId] });
    await expectCode(a.as.mutation(api.fleet.checkNow, { deviceIds: [d1.deviceId] }), "rate_limited");
    // Step 8: each head's `pingNonce` moved once (the agent pings within seconds).
    for (const d of [d1, d2]) {
      const head = await t.run((ctx) => ctx.db.query("desiredHeads").withIndex("by_device", (q) => q.eq("deviceId", d.deviceId)).unique());
      expect(head).toMatchObject({ pingNonce: 1, version: 1 });
    }
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

describe("fleet:installs", () => {
  async function seedApp(t: T, orgId: Id<"organizations">, name: string) {
    return await t.run((ctx) =>
      ctx.db.insert("apps", { orgId, name, kind: "web", archived: false, revision: 0, createdAt: Date.now() }),
    );
  }

  test("one PC's results newest first with the app names, paginated; nothing of another PC or organization", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const groupId = await t.run((ctx) => ctx.db.insert("groups", { orgId, name: "Floor", revision: 0, createdAt: 0 }));
    const mine = await enrollDevice(t, orgId, { name: "Front desk", groupId });
    const second = await enrollDevice(t, orgId, { name: "Back office", groupId });
    const apps = [await seedApp(t, orgId, "Docs"), await seedApp(t, orgId, "Reader"), await seedApp(t, orgId, "Notes")];
    const gone = await seedApp(t, orgId, "Deleted");
    await t.run(async (ctx) => {
      for (const appId of [...apps, gone]) {
        await ctx.db.insert("appAssignments", { orgId, groupId, appId, audience: "everyone", pinnedTaskbar: false, pinnedDesktop: false });
      }
      const row = (deviceId: Id<"devices">, appId: Id<"apps">, state: "installed" | "failed" | "pending", updatedAt: number) =>
        ctx.db.insert("installResults", { orgId, deviceId, appId, groupId, state, appRevision: 1, attempts: 1, updatedAt, ...(state === "failed" ? { detail: "The download did not match its checksum.", exitCode: 7 } : {}) });
      await row(mine.deviceId, apps[0]!, "installed", 1);
      await row(mine.deviceId, apps[1]!, "failed", 2);
      await row(mine.deviceId, gone, "installed", 3);
      await row(mine.deviceId, apps[2]!, "pending", 4);
      await row(second.deviceId, apps[0]!, "installed", 5);
      await ctx.db.delete(gone);
    });
    const other = await makeOrg(t, "Other");
    const otherDevice = await enrollDevice(t, other, { name: "Theirs" });
    await t.run(async (ctx) => {
      const foreignApp = await ctx.db.insert("apps", { orgId: other, name: "Foreign", kind: "web", archived: false, revision: 0, createdAt: 1 });
      await ctx.db.insert("installResults", { orgId: other, deviceId: otherDevice.deviceId, appId: foreignApp, state: "installed", appRevision: 0, attempts: 1, updatedAt: 9 });
    });
    const viewer = await asMember(t, { role: "viewer", orgId });

    const all = await viewer.as.query(api.fleet.installs, { deviceId: mine.deviceId, ...page() });
    expect(all.page.map((r) => [r.appName, r.state])).toEqual([["Notes", "pending"], ["Reader", "failed"], ["Docs", "installed"]]);
    expect(all.page[1]).toMatchObject({ detail: "The download did not match its checksum.", exitCode: 7, attempts: 1 });
    expectNoSecrets(all, [sha256HexSync(mine.secret)]);

    const first = await viewer.as.query(api.fleet.installs, { deviceId: mine.deviceId, ...page(2) });
    const next = await viewer.as.query(api.fleet.installs, { deviceId: mine.deviceId, paginationOpts: { numItems: 2, cursor: first.continueCursor } });
    expect([...first.page, ...next.page].map((r) => r.appName)).toEqual(["Notes", "Reader", "Docs"]);

    await expectCode(viewer.as.query(api.fleet.installs, { deviceId: otherDevice.deviceId, ...page() }), "not_found");
    await expectCode(viewer.as.query(api.fleet.installs, { deviceId: mine.deviceId, ...page(51) }), "invalid_argument");
  });

  test("a PC with no results answers an empty page", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const d = await enrollDevice(t, orgId);
    const viewer = await asMember(t, { role: "viewer", orgId });
    expect(await viewer.as.query(api.fleet.installs, { deviceId: d.deviceId, ...page() })).toMatchObject({ page: [], isDone: true });
  });
});

describe("install results follow the PC (Step 17 review)", () => {
  async function setup() {
    vi.useFakeTimers();
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const a = await admin(t, orgId);
    const mkGroup = (name: string) => t.run((ctx) => ctx.db.insert("groups", { orgId, name, revision: 0, createdAt: 0 }));
    const front = await mkGroup("Front");
    const back = await mkGroup("Back");
    const d = await enrollDevice(t, orgId, { name: "Desk", groupId: front });
    const { reader, wiki } = await t.run(async (ctx) => {
      const reader = await ctx.db.insert("apps", {
        orgId,
        name: "Reader",
        kind: "desktop",
        desktop: {
          source: "msi",
          exe: "{ProgramFiles}\\R\\r.exe",
          args: [],
          fileArgTemplate: [],
          resetFolders: [],
          install: { kind: "msi", url: "https://dl.example.com/r.msi", sha256: "ab".repeat(32), sizeBytes: 1, silentArgs: [], successExitCodes: [0], removeWhenUnassigned: true },
        },
        archived: false,
        revision: 1,
        createdAt: 0,
      });
      const wiki = await ctx.db.insert("apps", { orgId, name: "Wiki", kind: "web", archived: false, revision: 1, createdAt: 0 });
      // Front assigns both apps, Back only the reader.
      for (const [groupId, appId] of [[front, reader], [front, wiki], [back, reader]] as const) {
        await ctx.db.insert("appAssignments", { orgId, groupId, appId, audience: "everyone", pinnedTaskbar: false, pinnedDesktop: false });
      }
      return { reader, wiki };
    });
    const report = (appId: Id<"apps">, state: "failed" | "installed") =>
      t.mutation(api.deviceApi.report, { deviceId: d.deviceId, deviceSecret: d.secret, installs: [{ appId, state, appRevision: 1, attempts: 1 }] });
    await report(reader, "failed");
    await report(wiki, "failed");
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const failed = async () => (await orgStatsOf(t, orgId))?.failedInstallCount ?? 0;
    const installs = async () => (await a.as.query(api.fleet.installs, { deviceId: d.deviceId, ...page() })).page;
    return { t, orgId, a, front, back, d, reader, wiki, failed, installs };
  }

  test("a move re-tags the PC's results: the new group's apps count, the old group's stop; retryable says what Retry may do", async () => {
    const { t, a, back, d, reader, wiki, failed, installs } = await setup();
    expect(await failed()).toBe(2);
    const rows = await installs();
    expect(rows.map((r) => [r.appName, r.retryable])).toEqual(expect.arrayContaining([["Reader", true], ["Wiki", false]]));
    expect(rows).toHaveLength(2);

    const revision = (await a.as.query(api.fleet.get, { deviceId: d.deviceId })).revision;
    await a.as.mutation(api.fleet.move, { deviceId: d.deviceId, expectedRevision: revision, groupId: back });
    expect(await failed()).toBe(1);
    expect((await installs()).map((r) => r.appName)).toEqual(["Reader"]);
    const tags = await t.run((ctx) => ctx.db.query("installResults").withIndex("by_device_updated", (q) => q.eq("deviceId", d.deviceId)).take(10));
    expect(tags.every((r) => r.groupId === back)).toBe(true);
    expect((await a.as.query(api.overview.failedInstallsPage, { paginationOpts: { numItems: 50, cursor: null } })).page.map((r) => r.appId)).toEqual([reader]);
    expect(wiki).toBeDefined();
  });

  test("a revoke clears the tags: nothing of the PC counts or is listed any more", async () => {
    const { a, d, failed, installs } = await setup();
    await a.as.mutation(api.fleet.revoke, { deviceId: d.deviceId });
    expect(await failed()).toBe(0);
    expect(await installs()).toEqual([]);
    expect((await a.as.query(api.overview.failedInstallsPage, { paginationOpts: { numItems: 50, cursor: null } })).page).toEqual([]);
  });

  test("an archived app's rows are not retryable and not listed", async () => {
    const { a, reader, installs } = await setup();
    await a.as.mutation(api.apps.setArchived, { appId: reader, archived: true });
    expect((await installs()).map((r) => r.appName)).toEqual(["Wiki"]);
  });
});

describe("fleet:list follow-ups (Step 17)", () => {
  test('groupId "none" lists only the devices without a group; planState comes from the head', async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const g = await t.run((ctx) => ctx.db.insert("groups", { orgId, name: "Floor", revision: 0, createdAt: 0 }));
    const loose = await enrollDevice(t, orgId, { name: "Loose" });
    await enrollDevice(t, orgId, { name: "Placed", groupId: g });
    const other = await makeOrg(t, "Other");
    await enrollDevice(t, other, { name: "Theirs" });
    const viewer = await asMember(t, { role: "viewer", orgId });
    const none = await viewer.as.query(api.fleet.list, { ...page(), groupId: "none" });
    expect(none.page.map((r) => r.name)).toEqual(["Loose"]);
    expect(none.page[0]?.planState).toBeNull();
    const searched = await viewer.as.query(api.fleet.list, { ...page(), groupId: "none", search: "Placed" });
    expect(searched.page).toEqual([]);

    await t.mutation(internal.publish.run, { orgId });
    await t.run(async (ctx) => {
      const head = (await ctx.db.query("desiredHeads").withIndex("by_device", (q) => q.eq("deviceId", loose.deviceId)).unique())!;
      await ctx.db.patch(head._id, { planState: "overLimit" });
    });
    const all = await viewer.as.query(api.fleet.list, page());
    expect(all.page.find((r) => r.name === "Loose")?.planState).toBe("overLimit");
    expect(all.page.find((r) => r.name === "Placed")?.planState).toBe("ok");
  });
});
// UI pass 2026-11: the device page's queries (docs/plans/ui-pass/device-detail.md 6.1, 9).
describe("device page queries", () => {
  const OK = { mode: "audit", state: "ok" };
  const LAYERS = { staff: OK, machine: OK, appLocker: OK, appControl: OK, procWatch: OK, boot: OK, performance: OK };

  async function setup() {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const groupId = await t.run((ctx) => ctx.db.insert("groups", { orgId, name: "Floor", revision: 0, createdAt: 0 }));
    const pc = await enrollDevice(t, orgId, { name: "Front desk", groupId });
    const viewer = await asMember(t, { role: "viewer", orgId });
    return { t, orgId, groupId, pc, viewer };
  }
  type Env = Awaited<ReturnType<typeof setup>>;

  const mkApp = (e: Env, name: string, archived = false) =>
    e.t.run((ctx) => ctx.db.insert("apps", { orgId: e.orgId, name, kind: "web", archived, revision: 0, createdAt: 0 }));
  const assign = (e: Env, groupId: Id<"groups">, appId: Id<"apps">) =>
    e.t.run((ctx) => ctx.db.insert("appAssignments", { orgId: e.orgId, groupId, appId, audience: "everyone", pinnedTaskbar: false, pinnedDesktop: false }));
  const failedResult = (e: Env, appId: Id<"apps">, updatedAt: number, opts: { groupId?: Id<"groups">; deviceId?: Id<"devices">; state?: "failed" | "pending" } = {}) =>
    e.t.run((ctx) =>
      ctx.db.insert("installResults", {
        orgId: e.orgId,
        deviceId: opts.deviceId ?? e.pc.deviceId,
        appId,
        state: opts.state ?? "failed",
        appRevision: 1,
        attempts: 1,
        updatedAt,
        ...("groupId" in opts ? (opts.groupId === undefined ? {} : { groupId: opts.groupId }) : { groupId: e.groupId }),
      }),
    );
  const insertApply = (e: Env, extra: { state?: "applied" | "refused"; wifi?: { profileId: string; revision: number; state: string; detail?: string }[]; printers?: { printerId: string; revision: number; state: string; detail?: string }[] } = {}) =>
    e.t.run((ctx) =>
      ctx.db.insert("deviceApplyReports", {
        orgId: e.orgId,
        deviceId: e.pc.deviceId,
        appliedVersion: 3,
        config: { groupId: e.groupId, version: 2, ring: "everyone" },
        state: extra.state ?? "applied",
        refusal: extra.state === "refused" ? "would_block_exit" : undefined,
        layers: { ...LAYERS, machine: { mode: "on", state: "ok", detail: "admin_tiles_skipped" } },
        wifi: extra.wifi ?? [],
        printers: extra.printers ?? [],
        lkgVersion: 2,
        capabilities: ["lockdown/1"],
        contentHash: "a".repeat(64),
        updatedAt: 1_700_000_000_000,
      }),
    );

  test("fleet:page carries the header, report, head, lock, usb, protection and apply fields, like fleet:get", async () => {
    const e = await setup();
    const { t, pc, viewer } = e;
    // Enrollment writes the first (agent version only) report: no lockdown capability yet, nothing else.
    expect(await viewer.as.query(api.fleet.page, { deviceId: pc.deviceId })).toMatchObject({
      name: "Front desk",
      revoked: false,
      group: { name: "Floor" },
      kioskEnabled: true,
      displayMode: "auto",
      groupDisplayMode: "auto",
      outOfSupport: false,
      report: { agentVersion: "0.4.0" },
      latestVersion: null,
      planState: null,
      flags: { noGroup: false, revoked: false, rotateCredential: false },
      lock: null,
      ring: "everyone",
      usbAllowUntil: null,
      protection: null,
      lockdownCapable: false,
      apply: null,
      failedInstalls: { count: 0, more: false, names: [] },
      network: { wifiFailed: 0, printersFailed: 0 },
    });

    await t.mutation(api.deviceApi.report, {
      deviceId: pc.deviceId,
      deviceSecret: pc.secret,
      status: { agentVersion: "0.4.0", osBuild: "26100.1", osEdition: "Professional", diskFreeGb: 12, restartPending: true, compat: { blockers: [] } },
    });
    await t.mutation(internal.publish.run, { orgId: e.orgId });
    const a = await admin(t, e.orgId);
    await a.as.mutation(api.fleet.lock, { deviceId: pc.deviceId, message: "Back in 5 minutes" });
    await a.as.mutation(api.fleet.allowUsb, { deviceId: pc.deviceId, hours: 1 });
    await insertApply(e);
    await t.run(async (ctx) => {
      const report = (await ctx.db.query("deviceReports").withIndex("by_device", (q) => q.eq("deviceId", pc.deviceId)).unique())!;
      await ctx.db.patch(report._id, { security: { secureBoot: "on", bitLocker: "off" }, capabilities: ["lockdown/1"] });
    });

    const p = await viewer.as.query(api.fleet.page, { deviceId: pc.deviceId });
    const g = await viewer.as.query(api.fleet.get, { deviceId: pc.deviceId });
    expect(p.latestVersion).toBeGreaterThan(0);
    expect(p.planState).toBe("ok");
    expect(p.report).toMatchObject({ osEdition: "Professional", diskFreeGb: 12, restartPending: true });
    expect(p.lock).toMatchObject({ message: "Back in 5 minutes" });
    expect(p.usbAllowUntil).not.toBeNull();
    expect(p.lockdownCapable).toBe(true);
    expect(p.apply).toMatchObject({ state: "applied", appliedVersion: 3, lkgVersion: 2, configVersion: 2 });
    expect(p.apply?.layers.machine).toEqual({ mode: "on", state: "ok", detail: "admin_tiles_skipped" });
    // The shared fields are the same as `fleet:get` answers (the page is its replacement).
    for (const k of ["_id", "name", "revision", "kioskEnabled", "enrolledAt", "group", "presence", "report", "flags", "lock", "ring", "usbAllowUntil", "protection", "lockdownCapable", "apply", "displayMode", "groupDisplayMode"] as const) {
      expect(p[k], k).toEqual(g[k]);
    }
    expect("groups" in p || "versions" in p || "rolloutRevision" in p).toBe(false);
    expectNoSecrets(p, [sha256HexSync(pc.secret)]);

    await t.run(async (ctx) => {
      const head = (await ctx.db.query("desiredHeads").withIndex("by_device", (q) => q.eq("deviceId", pc.deviceId)).unique())!;
      await ctx.db.patch(head._id, { planState: "suspended" });
    });
    expect((await viewer.as.query(api.fleet.page, { deviceId: pc.deviceId })).planState).toBe("suspended");
  });

  test("a PC without a group: noGroup flag, no group, nothing counted", async () => {
    const e = await setup();
    const loose = await enrollDevice(e.t, e.orgId, { name: "Loose" });
    const p = await e.viewer.as.query(api.fleet.page, { deviceId: loose.deviceId });
    expect(p).toMatchObject({ group: null, groupDisplayMode: "auto", flags: { noGroup: true }, failedInstalls: { count: 0, more: false, names: [] } });
  });

  test("a revoked PC: revoked flag, rotation flag, no failed installs", async () => {
    const e = await setup();
    const a = await admin(e.t, e.orgId);
    const app = await mkApp(e, "Docs");
    await assign(e, e.groupId, app);
    await failedResult(e, app, 5);
    expect((await e.viewer.as.query(api.fleet.page, { deviceId: e.pc.deviceId })).failedInstalls.count).toBe(1);
    await a.as.mutation(api.fleet.requestCredentialRotation, { deviceId: e.pc.deviceId });
    expect((await e.viewer.as.query(api.fleet.page, { deviceId: e.pc.deviceId })).flags.rotateCredential).toBe(true);
    await a.as.mutation(api.fleet.revoke, { deviceId: e.pc.deviceId });
    expect(await e.viewer.as.query(api.fleet.page, { deviceId: e.pc.deviceId })).toMatchObject({
      revoked: true,
      flags: { revoked: true, noGroup: false },
      presence: { online: false, revoked: true },
      failedInstalls: { count: 0, more: false, names: [] },
    });
  });

  test("failed installs count only results that still count; names <= 2 newest first", async () => {
    const e = await setup();
    const back = await e.t.run((ctx) => ctx.db.insert("groups", { orgId: e.orgId, name: "Back", revision: 0, createdAt: 0 }));
    const second = await enrollDevice(e.t, e.orgId, { name: "Second", groupId: e.groupId });
    const live = await mkApp(e, "Zoom");
    const alsoLive = await mkApp(e, "Teams");
    const unassigned = await mkApp(e, "Unassigned");
    const archived = await mkApp(e, "Archived", true);
    const otherGroup = await mkApp(e, "Elsewhere");
    const untagged = await mkApp(e, "Untagged");
    const pending = await mkApp(e, "Pending");
    const third = await mkApp(e, "Third live");
    for (const app of [live, alsoLive, archived, untagged, pending, third]) await assign(e, e.groupId, app);
    await assign(e, back, otherGroup);
    await failedResult(e, live, 10);
    await failedResult(e, alsoLive, 20);
    await failedResult(e, third, 30);
    await failedResult(e, unassigned, 40);
    await failedResult(e, archived, 50);
    await failedResult(e, otherGroup, 60, { groupId: back }); // tagged with a group the PC is not in
    await failedResult(e, untagged, 70, { groupId: undefined }); // written before the tag existed
    await failedResult(e, pending, 80, { state: "pending" });
    await failedResult(e, live, 90, { deviceId: second.deviceId }); // another PC's failure

    const p = await e.viewer.as.query(api.fleet.page, { deviceId: e.pc.deviceId });
    expect(p.failedInstalls).toEqual({ count: 3, more: false, names: ["Third live", "Teams"] });
    expect((await e.viewer.as.query(api.fleet.page, { deviceId: second.deviceId })).failedInstalls).toEqual({ count: 1, more: false, names: ["Zoom"] });
  });

  test("failed installs: the range is 10 newest, `more` says it was full; a full page stays within its budget", async () => {
    const e = await setup();
    for (let i = 0; i < 12; i++) {
      const app = await mkApp(e, `App ${i}`);
      await assign(e, e.groupId, app);
      await failedResult(e, app, 100 + i);
    }
    const { result, io } = await probe(() => e.viewer.as.query(api.fleet.page, { deviceId: e.pc.deviceId }));
    expect(result.failedInstalls).toEqual({ count: 10, more: true, names: ["App 11", "App 10"] });
    expect(io.reads).toBeLessThanOrEqual(44);
    expect(io.readBytes).toBeLessThanOrEqual(64_000);
    for (const table of ["deviceLiveness", "desiredBodies", "desiredStates", "groups"]) expect(io.tables.has(table), table).toBe(table === "groups");
  });

  test("network counts come from the apply report's failed Wi-Fi and printer items", async () => {
    const e = await setup();
    await insertApply(e, {
      wifi: [
        { profileId: "w1", revision: 1, state: "failed", detail: "connect_failed" },
        { profileId: "w2", revision: 1, state: "applied" },
        { profileId: "w3", revision: 1, state: "failed" },
        { profileId: "w4", revision: 1, state: "unsupported" },
      ],
      printers: [
        { printerId: "p1", revision: 1, state: "failed" },
        { printerId: "p2", revision: 1, state: "applying" },
      ],
    });
    expect((await e.viewer.as.query(api.fleet.page, { deviceId: e.pc.deviceId })).network).toEqual({ wifiFailed: 2, printersFailed: 1 });
  });

  test("fleet:deviceSettings: the organization's groups by name and the group's rollout revision (0 without a row or a group)", async () => {
    const e = await setup();
    await e.t.run(async (ctx) => {
      await ctx.db.insert("groups", { orgId: e.orgId, name: "Back office", revision: 0, createdAt: 1 });
      await ctx.db.insert("groups", { orgId: e.orgId, name: "Admin", revision: 0, createdAt: 2 });
    });
    const foreign = await group(e.t, await makeOrg(e.t, "Other"), "Foreign group");
    const loose = await enrollDevice(e.t, e.orgId, { name: "Loose" });

    const first = await e.viewer.as.query(api.fleet.deviceSettings, { deviceId: e.pc.deviceId });
    expect(first.groups.map((g) => g.name)).toEqual(["Admin", "Back office", "Floor"]);
    expect(first.groups.map((g) => g._id)).not.toContain(foreign);
    expect(first.rolloutRevision).toBe(0);
    await e.t.run((ctx) =>
      ctx.db.insert("groupRollouts", {
        orgId: e.orgId,
        groupId: e.groupId,
        enabled: false,
        pointers: { pilot: 1, early: 1, everyone: 1 },
        autoPromote: { enabled: false, bakeHours: 24, maxFailurePct: 10 },
        autoRollback: true,
        state: "idle",
        revision: 3,
      }),
    );
    expect((await e.viewer.as.query(api.fleet.deviceSettings, { deviceId: e.pc.deviceId })).rolloutRevision).toBe(3);
    expect((await e.viewer.as.query(api.fleet.deviceSettings, { deviceId: loose.deviceId })).rolloutRevision).toBe(0);
  });

  test("fleet:versions: the newest 5 versions, newest first, only version, time and reason", async () => {
    const e = await setup();
    await e.t.run(async (ctx) => {
      for (let version = 1; version <= 7; version++) {
        const bodyId = await ctx.db.insert("desiredBodies", { orgId: e.orgId, deviceId: e.pc.deviceId, version, payload: "{}", signature: "s", keyId: "k", contentHash: "h", createdAt: version });
        await ctx.db.insert("desiredVersions", { orgId: e.orgId, deviceId: e.pc.deviceId, version, reason: `Change ${version}`, createdAt: 1_000 + version, bodyId });
      }
    });
    const rows = await e.viewer.as.query(api.fleet.versions, { deviceId: e.pc.deviceId });
    expect(rows).toEqual([7, 6, 5, 4, 3].map((version) => ({ version, createdAt: 1_000 + version, reason: `Change ${version}` })));
    const none = await enrollDevice(e.t, e.orgId, { name: "New" });
    expect(await e.viewer.as.query(api.fleet.versions, { deviceId: none.deviceId })).toEqual([]);
  });

  test("fleet:network keeps the group's items, maps their states, and never returns a passphrase, address, URL or hash", async () => {
    const e = await setup();
    const other = await group(e.t, e.orgId, "Other group");
    const SECRET_BOX = "SEALED-PASSPHRASE-BOX";
    const wifi = (name: string, groupIds: Id<"groups">[]) =>
      e.t.run((ctx) =>
        ctx.db.insert("wifiProfiles", {
          orgId: e.orgId,
          name,
          ssid: `${name}-ssid`,
          hidden: false,
          security: "wpa2Personal",
          autoConnect: true,
          passphrase: { keyId: "k1", sealed: SECRET_BOX },
          groupIds,
          revision: 1,
          createdAt: 0,
        }),
      );
    const printer = (name: string, groupIds: Id<"groups">[], defaultForGroupIds: Id<"groups">[] = []) =>
      e.t.run((ctx) =>
        ctx.db.insert("printers", { orgId: e.orgId, name, kind: "raw", address: "10.9.8.7", driver: "Generic / Text Only", groupIds, defaultForGroupIds, revision: 1, createdAt: 0 }),
      );
    const driver = (name: string, groupIds: Id<"groups">[]) =>
      e.t.run((ctx) =>
        ctx.db.insert("drivers", {
          orgId: e.orgId,
          name,
          kind: "inf",
          deviceClass: "printer",
          url: "https://downloads.example.test/driver.zip",
          sha256: "9".repeat(64),
          sizeBytes: 10,
          inf: "x.inf",
          silentArgs: [],
          successExitCodes: [],
          provides: [],
          groupIds,
          revision: 1,
          createdAt: 0,
        }),
      );
    const shop = await wifi("Shop floor", [e.groupId]);
    const guest = await wifi("Guest", [e.groupId, other]);
    const notMine = await wifi("Other group only", [other]);
    const waitingWifi = await wifi("Not reported yet", [e.groupId]);
    const lobby = await printer("Lobby", [e.groupId], [e.groupId]);
    const labels = await printer("Labels", [e.groupId]);
    await printer("Elsewhere", [other]);
    const scanner = await driver("Scanner pack", [e.groupId]);
    const waitingDriver = await driver("Not sent yet", [e.groupId]);
    await driver("Other group driver", [other]);
    await e.t.run((ctx) => ctx.db.insert("driverResults", { orgId: e.orgId, deviceId: e.pc.deviceId, driverId: scanner, state: "failed", driverRevision: 1, attempts: 2, detail: "exit_code_1", groupId: e.groupId, updatedAt: 1 }));
    await insertApply(e, {
      wifi: [
        { profileId: shop, revision: 1, state: "failed", detail: "connect_failed" },
        { profileId: guest, revision: 1, state: "applied" },
        { profileId: notMine, revision: 1, state: "applied" },
      ],
      printers: [
        { printerId: lobby, revision: 1, state: "applied" },
        { printerId: labels, revision: 1, state: "unsupported" },
      ],
    });

    const n = await e.viewer.as.query(api.fleet.network, { deviceId: e.pc.deviceId });
    expect(n.groupId).toBe(e.groupId);
    expect(n.reportedAt).toBe(1_700_000_000_000);
    const byName = <T extends { name: string }>(rows: T[]) => Object.fromEntries(rows.map((r) => [r.name, r]));
    expect(Object.keys(byName(n.wifi)).sort()).toEqual(["Guest", "Not reported yet", "Shop floor"]);
    expect(byName(n.wifi)["Shop floor"]).toMatchObject({ _id: shop, state: "failed", detail: "connect_failed" });
    expect(byName(n.wifi)["Guest"]).toMatchObject({ state: "working", detail: null });
    expect(byName(n.wifi)["Not reported yet"]).toMatchObject({ _id: waitingWifi, state: "waiting", detail: null });
    expect(Object.keys(byName(n.printers)).sort()).toEqual(["Labels", "Lobby"]);
    expect(byName(n.printers)["Lobby"]).toMatchObject({ isDefault: true, state: "working" });
    expect(byName(n.printers)["Labels"]).toMatchObject({ isDefault: false, state: "notSupported" });
    expect(Object.keys(byName(n.drivers)).sort()).toEqual(["Not sent yet", "Scanner pack"]);
    expect(byName(n.drivers)["Scanner pack"]).toMatchObject({ state: "failed", detail: "exit_code_1" });
    expect(byName(n.drivers)["Not sent yet"]).toMatchObject({ _id: waitingDriver, state: "pending", detail: null });
    const text = JSON.stringify(n);
    for (const s of [SECRET_BOX, "-ssid", "10.9.8.7", "downloads.example.test", "9".repeat(64), "Generic / Text Only"]) expect(text.includes(s), s).toBe(false);
    expectNoSecrets(n, [sha256HexSync(e.pc.secret)]);
  });

  test("fleet:network: a PC without a group or a report has nothing yet", async () => {
    const e = await setup();
    await e.t.run((ctx) => ctx.db.insert("wifiProfiles", { orgId: e.orgId, name: "W", ssid: "W", hidden: false, security: "open", autoConnect: true, groupIds: [e.groupId], revision: 1, createdAt: 0 }));
    const loose = await enrollDevice(e.t, e.orgId, { name: "Loose" });
    expect(await e.viewer.as.query(api.fleet.network, { deviceId: loose.deviceId })).toEqual({ groupId: null, reportedAt: null, wifi: [], printers: [], drivers: [] });
    const n = await e.viewer.as.query(api.fleet.network, { deviceId: e.pc.deviceId });
    expect(n.reportedAt).toBeNull();
    expect(n.wifi.map((w) => [w.name, w.state])).toEqual([["W", "waiting"]]);
  });

  test("a foreign or unknown device id answers not_found for every device page query", async () => {
    const e = await setup();
    const theirs = await enrollDevice(e.t, await makeOrg(e.t, "B"));
    for (const q of [api.fleet.page, api.fleet.deviceSettings, api.fleet.versions, api.fleet.network]) {
      await expectCode(e.viewer.as.query(q, { deviceId: theirs.deviceId }), "not_found");
      await expectCode(e.viewer.as.query(q, { deviceId: "not-an-id" }), "not_found");
    }
  });
});
