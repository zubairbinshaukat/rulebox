import { afterEach, describe, expect, test, vi } from "vitest";
import { setupAuth } from "../tests/convex/auth";
import { enrollDevice, onlineCount, probe } from "../tests/convex/devices";
import { asMember, expectNoSecrets, makeOrg, type T } from "../tests/convex/identity";
import { TEST_KEY_2 } from "../tests/convex/keys";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { writeAudit } from "./lib/audit";
import { MINUTE_MS, OVERVIEW_AUDIT_ROWS } from "./lib/limits";

// The overview (plan Step 17 items 3, 6, 7; A3, A7): one small query that
// re-runs on counter, presence and audit changes only.

afterEach(() => {
  vi.useRealTimers();
});

async function viewerOf(t: T, orgId: Id<"organizations">) {
  return await asMember(t, { role: "viewer", orgId });
}

async function seedAudit(t: T, orgId: Id<"organizations">, n: number, base = 1_000_000) {
  await t.run(async (ctx) => {
    for (let i = 0; i < n; i++) {
      await writeAudit(ctx, {
        orgId,
        actor: { type: "member", id: "m1", label: "owner@acme.test" },
        action: "group.renamed",
        summary: `Row ${i}`,
        eventKey: `dev:x:${i}`,
        at: base + i,
      });
    }
  });
}

describe("overview:get", () => {
  test("an empty organization: zero counters, nobody online, the key it was made with, no audit rows", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const v = await viewerOf(t, orgId);
    expect(await v.as.query(api.overview.get, {})).toMatchObject({
      counts: { deviceCount: 0, employeeCount: 0, appCount: 0, groupCount: 0, noGroupDeviceCount: 0, outOfSupportCount: 0, failedInstallCount: 0 },
      onlineCount: 0,
      plan: { name: "custom", status: "active" },
      signing: "active",
      publishFailedAt: null,
      recentAudit: [],
    });
  });

  test("the counters, the online sum, the plan, the key state and the newest 10 audit rows", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t, "Acme", { plan: "free" });
    await enrollDevice(t, orgId, { name: "A" });
    await enrollDevice(t, orgId, { name: "B" });
    await t.run(async (ctx) => {
      const stats = (await ctx.db.query("orgStats").withIndex("by_org", (q) => q.eq("orgId", orgId)).unique())!;
      await ctx.db.patch(stats._id, { employeeCount: 7, appCount: 3, groupCount: 2, outOfSupportCount: 1, failedInstallCount: 4, publishFailedAt: 123_456 });
    });
    await seedAudit(t, orgId, 12);
    const v = await viewerOf(t, orgId);

    const o = await v.as.query(api.overview.get, {});
    expect(o.counts).toEqual({ deviceCount: 2, employeeCount: 7, appCount: 3, groupCount: 2, noGroupDeviceCount: 2, outOfSupportCount: 1, failedInstallCount: 4 });
    expect(o.onlineCount).toBe(await onlineCount(t, orgId));
    expect(o.onlineCount).toBe(2);
    expect(o.plan).toMatchObject({ name: "free", status: "active", limits: { maxDevices: 2, maxEmployees: 25 } });
    expect(o.publishFailedAt).toBe(123_456);
    // The two enrollments wrote audit rows too (`device.enrolled`, newest); the 12 seeded rows follow.
    expect(o.recentAudit).toHaveLength(OVERVIEW_AUDIT_ROWS);
    expect(o.recentAudit[0]?.at).toBeGreaterThanOrEqual(o.recentAudit[1]!.at);
    expect(Object.keys(o.recentAudit[0]!)).not.toContain("eventKey");
    expect(Object.keys(o.recentAudit[0]!)).not.toContain("orgId");
  });

  test("signing: none without an active key, rotating while a next key is prepared", async () => {
    const t = await setupAuth();
    const noKey = await makeOrg(t, "NoKey", { noKey: true });
    expect((await (await viewerOf(t, noKey)).as.query(api.overview.get, {})).signing).toBe("none");

    const orgId = await makeOrg(t);
    const v = await viewerOf(t, orgId);
    await t.run((ctx) =>
      ctx.db.insert("policyKeys", { orgId, keyId: TEST_KEY_2.keyId, publicKey: "AAAA", status: "next", createdAt: Date.now() }),
    );
    expect((await v.as.query(api.overview.get, {})).signing).toBe("rotating");
  });

  test("rosterPending: true while a disabled employee's removal waits for a key; another organization's rows never show", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const other = await makeOrg(t, "Other");
    const v = await viewerOf(t, orgId);
    expect((await v.as.query(api.overview.get, {})).rosterPending).toBe(false);
    const g = await t.run((ctx) => ctx.db.insert("groups", { orgId: other, name: "G", revision: 0, createdAt: 0 }));
    await t.run((ctx) => ctx.db.insert("rosterPending", { orgId: other, groupId: g, employeeId: "e1" }));
    expect((await v.as.query(api.overview.get, {})).rosterPending).toBe(false);
    expect((await (await viewerOf(t, other)).as.query(api.overview.get, {})).rosterPending).toBe(true);
    expect((await (await viewerOf(t, other)).as.query(api.keys.status, {})).rosterPending).toBe(true);
    expect((await v.as.query(api.keys.status, {})).rosterPending).toBe(false);
  });

  test("another organization's counters, devices and audit rows never show", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const other = await makeOrg(t, "Other");
    await enrollDevice(t, other, { name: "Theirs" });
    await seedAudit(t, other, 3);
    const v = await viewerOf(t, orgId);
    const o = await v.as.query(api.overview.get, {});
    expect(o.counts.deviceCount).toBe(0);
    expect(o.onlineCount).toBe(0);
    expect(o.recentAudit).toEqual([]);
    expectNoSecrets(o);
  });

  test("it reads at most 60 documents and 32 KB and touches no device, liveness, payload or install table", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t, "Acme", { plan: "team" });
    await seedAudit(t, orgId, 40);
    // A fleet that is on the books: the overview must not look at it.
    await t.run(async (ctx) => {
      for (let i = 0; i < 30; i++) {
        const tok = await ctx.db.insert("enrollmentTokens", { orgId, tokenHash: `t${i}`.padEnd(64, "0"), expiresAt: 0, usesLeft: 0, createdAt: 0 });
        const deviceId = await ctx.db.insert("devices", { orgId, name: `PC ${i}`, enrolledAt: 0, enrollmentTokenId: tok });
        await ctx.db.insert("deviceLiveness", { deviceId, orgId, seenBucket: 1, online: true, offlineAfter: 99, pingIntervalMs: 1 });
        await ctx.db.insert("installResults", { orgId, deviceId, appId: (await ctx.db.insert("apps", { orgId, name: `A${i}`, kind: "web", archived: false, revision: 0, createdAt: 0 })), state: "failed", appRevision: 0, attempts: 1, updatedAt: 0 });
      }
    });
    const v = await viewerOf(t, orgId);
    const { result, io } = await probe(() => v.as.query(api.overview.get, {}));
    expect(result.recentAudit).toHaveLength(OVERVIEW_AUDIT_ROWS);
    expect(io.reads).toBeLessThanOrEqual(60);
    expect(io.readBytes).toBeLessThanOrEqual(32 * 1024);
    for (const table of ["devices", "deviceLiveness", "devicePresence", "deviceReports", "deviceSummary", "deviceCredentials", "desiredBodies", "desiredHeads", "installResults", "apps", "employees"]) {
      expect(io.tables.has(table), table).toBe(false);
    }
  });

  test("a ping storm of 50 devices changes no row the overview reads", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const start = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    const devices: { deviceId: Id<"devices">; secret: string }[] = [];
    for (let i = 0; i < 50; i++) {
      // `enrollPerOrg` allows 10 per minute: step the clock 7 s per enrollment.
      vi.setSystemTime(start + i * 7_000);
      devices.push(await enrollDevice(t, orgId, { name: `PC ${i}` }));
    }
    const read = async () =>
      await t.run(async (ctx) => ({
        stats: await ctx.db.query("orgStats").withIndex("by_org", (q) => q.eq("orgId", orgId)).unique(),
        presence: await ctx.db.query("orgPresence").withIndex("by_org_shard", (q) => q.eq("orgId", orgId)).take(16),
        plan: await ctx.db.query("orgPlans").withIndex("by_org", (q) => q.eq("orgId", orgId)).unique(),
        keys: await ctx.db.query("policyKeys").withIndex("by_org_status", (q) => q.eq("orgId", orgId)).take(20),
        audit: await ctx.db.query("auditLog").withIndex("by_org_at", (q) => q.eq("orgId", orgId)).order("desc").take(OVERVIEW_AUDIT_ROWS),
      }));
    const before = JSON.stringify(await read());
    const livenessBefore = JSON.stringify(await t.run((ctx) => ctx.db.query("deviceLiveness").withIndex("by_org", (q) => q.eq("orgId", orgId)).take(60)));
    // Three minutes later every PC pings (a new minute bucket: each liveness row is written).
    vi.setSystemTime(start + 50 * 7_000 + 3 * MINUTE_MS);
    for (const d of devices) await t.mutation(api.devices.ping, { deviceId: d.deviceId, deviceSecret: d.secret });
    const livenessAfter = JSON.stringify(await t.run((ctx) => ctx.db.query("deviceLiveness").withIndex("by_org", (q) => q.eq("orgId", orgId)).take(60)));
    expect(livenessAfter).not.toBe(livenessBefore); // the storm really wrote
    expect(JSON.stringify(await read())).toBe(before);
  });
});

/** The overview widget shows this many failed installs. */
const FAILED_ROWS = 20;

describe("overview:failedInstallsPage (the overview widget's rows)", () => {
  async function seed(t: T, orgId: Id<"organizations">, n: number) {
    return await t.run(async (ctx) => {
      const ids: Id<"installResults">[] = [];
      // The PCs are in a group that assigns the apps: only such results count (Step 17 review).
      const groupId = await ctx.db.insert("groups", { orgId, name: "Floor", revision: 0, createdAt: 0 });
      const assign = (appId: Id<"apps">) => ctx.db.insert("appAssignments", { orgId, groupId, appId, audience: "everyone", pinnedTaskbar: false, pinnedDesktop: false });
      for (let i = 0; i < n; i++) {
        const tok = await ctx.db.insert("enrollmentTokens", { orgId, tokenHash: `f${i}`.padEnd(64, "0"), expiresAt: 0, usesLeft: 0, createdAt: 0 });
        const deviceId = await ctx.db.insert("devices", { orgId, name: `PC ${i}`, enrolledAt: 0, enrollmentTokenId: tok, groupId });
        const appId = await ctx.db.insert("apps", { orgId, name: `App ${i}`, kind: "web", archived: false, revision: 0, createdAt: 0 });
        await assign(appId);
        // Inserted in reverse `updatedAt` order: the list is by `updatedAt`, not creation.
        ids.push(await ctx.db.insert("installResults", { orgId, deviceId, appId, groupId, state: "failed", appRevision: 0, attempts: 3, detail: "The download did not match its checksum.", updatedAt: 1_000 - i }));
        // Not failed: never listed.
        const ok = await ctx.db.insert("apps", { orgId, name: `Ok ${i}`, kind: "web", archived: false, revision: 0, createdAt: 0 });
        await assign(ok);
        await ctx.db.insert("installResults", { orgId, deviceId, appId: ok, groupId, state: "installed", appRevision: 0, attempts: 1, updatedAt: i });
      }
      return ids;
    });
  }

  test("the newest 20 failed results with PC and app names; nothing from another organization", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const other = await makeOrg(t, "Other");
    await seed(t, orgId, FAILED_ROWS + 5);
    await seed(t, other, 2);
    const v = await viewerOf(t, orgId);
    const rows = (await v.as.query(api.overview.failedInstallsPage, { paginationOpts: { numItems: FAILED_ROWS, cursor: null } })).page;
    expect(rows).toHaveLength(FAILED_ROWS);
    expect(rows[0]).toMatchObject({ deviceName: "PC 0", appName: "App 0", detail: "The download did not match its checksum." });
    expect(rows.every((r) => !r.deviceName.startsWith("Other"))).toBe(true);
    expectNoSecrets(rows);
    const foreign = await viewerOf(t, other);
    expect((await foreign.as.query(api.overview.failedInstallsPage, { paginationOpts: { numItems: 50, cursor: null } })).page).toHaveLength(2);
  });

  test("a removed PC or app is left out; an organization with nothing failed gets an empty list", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const [first] = await seed(t, orgId, 2);
    await t.run(async (ctx) => {
      const row = (await ctx.db.get(first!))!;
      await ctx.db.delete(row.deviceId);
    });
    const v = await viewerOf(t, orgId);
    expect((await v.as.query(api.overview.failedInstallsPage, { paginationOpts: { numItems: 50, cursor: null } })).page.map((r) => r.deviceName)).toEqual(["PC 1"]);
    expect((await (await viewerOf(t, await makeOrg(t, "Empty"))).as.query(api.overview.failedInstallsPage, { paginationOpts: { numItems: 50, cursor: null } })).page).toEqual([]);
  });
});
