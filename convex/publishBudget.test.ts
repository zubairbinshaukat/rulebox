import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { setupAuth } from "../tests/convex/auth";
import { enrollDevice } from "../tests/convex/devices";
import { makeOrg, type T } from "../tests/convex/identity";
import { setSeeds, TEST_SEED_B64 } from "../tests/convex/keys";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { auditPolicy } from "./lib/audit";
import { DEFAULT_WEB_PERMISSIONS } from "./lib/validators";

// Step 11 review, SHOULD-FIX 1: one publisher run stops loading groups when its
// read budget is spent; the devices it did not reach go back to the queue and
// the next hop. The run budget is lowered here so a few small groups are enough;
// the worst case of one group (GROUP_LOAD_WORST_*) is the real, unlowered number.

vi.mock("./lib/limits", async (importOriginal) => {
  const real = await importOriginal<typeof import("./lib/limits")>();
  return { ...real, RUN_RANGE_BUDGET: 150 };
});

beforeEach(() => {
  vi.useFakeTimers();
  auditPolicy.strict = true;
});
afterEach(() => {
  vi.useRealTimers();
  auditPolicy.strict = false;
  setSeeds(TEST_SEED_B64);
});

async function heads(t: T, orgId: Id<"organizations">) {
  return await t.run((ctx) => ctx.db.query("desiredHeads").withIndex("by_device", (q) => q.gte("deviceId", "" as Id<"devices">)).take(100).then((r) => r.filter((h) => h.orgId === orgId)));
}
async function queue(t: T, orgId: Id<"organizations">) {
  return await t.run((ctx) => ctx.db.query("publishQueue").withIndex("by_org", (q) => q.eq("orgId", orgId)).unique());
}

describe("publish:run read budget", () => {
  test("groups beyond the run budget are deferred to the next hop, nothing is lost, and the first group always goes", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const app = await t.run((ctx) =>
      ctx.db.insert("apps", {
        orgId,
        name: "Docs",
        kind: "web",
        web: { url: "https://docs.example.com", allowedDomains: ["docs.example.com"], permissions: DEFAULT_WEB_PERMISSIONS },
        archived: false,
        revision: 0,
        createdAt: 0,
      }),
    );
    const devices: Id<"devices">[] = [];
    for (let i = 0; i < 4; i++) {
      const groupId = await t.run(async (ctx) => {
        const g = await ctx.db.insert("groups", { orgId, name: `Group ${i}`, revision: 0, createdAt: i });
        const e = await ctx.db.insert("employees", { orgId, name: `P${i}`, username: `p${i}`, searchText: `p${i}`, disabled: false, credentialRevision: 0, revision: 0, createdAt: i });
        await ctx.db.insert("groupMembers", { orgId, groupId: g, employeeId: e, grantsActive: true });
        await ctx.db.insert("employeeApps", { orgId, employeeId: e, appId: app });
        return g;
      });
      devices.push((await enrollDevice(t, orgId, { groupId, name: `PC ${i}` })).deviceId);
    }
    expect((await queue(t, orgId))?.deviceIds).toHaveLength(4);

    // One run: the first group is loaded; the worst case of another no longer fits 150 ranges.
    await t.mutation(internal.publish.run, { orgId });
    expect(await heads(t, orgId)).toHaveLength(1);
    const left = await queue(t, orgId);
    expect(left?.deviceIds).toHaveLength(3);
    expect(left?.scheduled).toBeDefined();

    // The following hops finish the job: every device has its document, the queue is gone.
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const done = await heads(t, orgId);
    expect(done.map((h) => h.deviceId).sort()).toEqual([...devices].sort());
    expect(await queue(t, orgId)).toBeNull();
  });
});
