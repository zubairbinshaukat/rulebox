import { afterEach, describe, expect, test, vi } from "vitest";
import { setupAuth } from "../tests/convex/auth";
import { enrollDevice, onlineCount, orgStatsOf } from "../tests/convex/devices";
import { makeOrg, type T } from "../tests/convex/identity";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import source from "./stats.ts?raw";
import { RECONCILE_FAILED_BATCH } from "./lib/limits";

// `stats:reconcile` (plan Step 17 item 9; Step 17 review): an exact, paged,
// write-on-difference recount of one organization's counters.

afterEach(() => {
  vi.useRealTimers();
});

async function drain(t: T) {
  await t.finishAllScheduledFunctions(vi.runAllTimers);
}

async function setStats(t: T, orgId: Id<"organizations">, patch: Record<string, number>) {
  await t.run(async (ctx) => {
    const st = (await ctx.db.query("orgStats").withIndex("by_org", (q) => q.eq("orgId", orgId)).unique())!;
    await ctx.db.patch(st._id, patch);
  });
}

/** `n` live failed results (assigned app, tagged group) plus `stale` failed results of an unassigned app. */
async function seedFailed(t: T, orgId: Id<"organizations">, deviceId: Id<"devices">, groupId: Id<"groups">, n: number, stale = 0) {
  await t.run(async (ctx) => {
    const live = await ctx.db.insert("apps", { orgId, name: "Live", kind: "web", archived: false, revision: 0, createdAt: 0 });
    const loose = await ctx.db.insert("apps", { orgId, name: "Loose", kind: "web", archived: false, revision: 0, createdAt: 0 });
    await ctx.db.insert("appAssignments", { orgId, groupId, appId: live, audience: "everyone", pinnedTaskbar: false, pinnedDesktop: false });
    for (let i = 0; i < n; i++) await ctx.db.insert("installResults", { orgId, deviceId, appId: live, groupId, state: "failed", appRevision: 0, attempts: 1, updatedAt: i });
    for (let i = 0; i < stale; i++) await ctx.db.insert("installResults", { orgId, deviceId, appId: loose, groupId, state: "failed", appRevision: 0, attempts: 1, updatedAt: i });
  });
}

describe("stats:reconcile", () => {
  test("drifted counters (including failedInstallCount and the online shards) are recounted; another organization is untouched", async () => {
    vi.useFakeTimers();
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const other = await makeOrg(t, "Other");
    const groupId = await t.run((ctx) => ctx.db.insert("groups", { orgId, name: "Floor", revision: 0, createdAt: 0 }));
    const d = await enrollDevice(t, orgId, { groupId });
    await enrollDevice(t, orgId);
    await seedFailed(t, orgId, d.deviceId, groupId, RECONCILE_FAILED_BATCH + 3, 4); // two pages of failed results
    await t.run(async (ctx) => {
      await ctx.db.insert("employees", { orgId, name: "A", username: "a", searchText: "a", disabled: false, credentialRevision: 0, revision: 0, createdAt: 0 });
      await ctx.db.insert("employees", { orgId, name: "B", username: "b", searchText: "b", disabled: true, credentialRevision: 0, revision: 0, createdAt: 0 });
    });
    const exact = await orgStatsOf(t, orgId);
    const online = await onlineCount(t, orgId);
    await setStats(t, orgId, { deviceCount: 9, noGroupDeviceCount: 0, employeeCount: 0, activeEmployeeCount: 5, failedInstallCount: 0, appCount: 7, groupCount: 4 });
    await t.run(async (ctx) => {
      const shards = await ctx.db.query("orgPresence").withIndex("by_org_shard", (q) => q.eq("orgId", orgId)).take(10);
      for (const s of shards) await ctx.db.patch(s._id, { online: 0 });
    });
    await setStats(t, other, { failedInstallCount: 42 });

    await t.mutation(internal.stats.reconcile, { orgId });
    await drain(t);
    expect(await orgStatsOf(t, orgId)).toMatchObject({
      deviceCount: exact?.deviceCount,
      noGroupDeviceCount: 1,
      employeeCount: 2,
      activeEmployeeCount: 1,
      failedInstallCount: RECONCILE_FAILED_BATCH + 3,
      appCount: 2,
      groupCount: 1,
    });
    expect(await onlineCount(t, orgId)).toBe(online);
    expect((await orgStatsOf(t, other))?.failedInstallCount).toBe(42);
  });

  test("an exact organization: nothing is written", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    await enrollDevice(t, orgId);
    vi.useFakeTimers();
    const before = JSON.stringify(await orgStatsOf(t, orgId));
    await t.mutation(internal.stats.reconcile, { orgId });
    await drain(t);
    expect(JSON.stringify(await orgStatsOf(t, orgId))).toBe(before);
  });

  test("a paged counter that moved during the run is left alone (skipped), the others are written", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    await setStats(t, orgId, { failedInstallCount: 3, employeeCount: 8 });
    const first = await t.mutation(internal.stats.reconcile, { orgId });
    expect(first.done).toBe(false);
    // Run the stages by hand: the counter moves between the start and the last run.
    const start = { deviceCount: 0, noGroupDeviceCount: 0, outOfSupportCount: 0, employeeCount: 8, activeEmployeeCount: 0, failedInstallCount: 3, online: [0, 0, 0, 0] };
    await setStats(t, orgId, { failedInstallCount: 4 });
    const acc = { deviceCount: 0, noGroupDeviceCount: 0, outOfSupportCount: 0, employeeCount: 0, activeEmployeeCount: 0, failedInstallCount: 0, online: [0, 0, 0, 0] };
    const r = await t.mutation(internal.stats.reconcile, { orgId, stage: "finish", acc, start });
    expect(r.skipped).toContain("failedInstallCount");
    expect(r.wrote).toContain("employeeCount");
    expect(await orgStatsOf(t, orgId)).toMatchObject({ failedInstallCount: 4, employeeCount: 0 });
  });

  test("reconcileAll walks every organization, one at a time", async () => {
    vi.useFakeTimers();
    const t = await setupAuth();
    const orgs = [await makeOrg(t, "A"), await makeOrg(t, "B"), await makeOrg(t, "C")];
    for (const o of orgs) await setStats(t, o, { failedInstallCount: 5 });
    await t.mutation(internal.stats.reconcileAll, {});
    await drain(t);
    for (const o of orgs) expect((await orgStatsOf(t, o))?.failedInstallCount).toBe(0);
  });

  test("source: no .collect(), no database .filter()", () => {
    expect(source).not.toMatch(/\.collect\(/);
    expect(source).not.toMatch(/\.filter\(\(?q\b/);
  });
});
