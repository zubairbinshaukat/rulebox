import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { setupAuth } from "../tests/convex/auth";
import { makeOrg, type T } from "../tests/convex/identity";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { DAY_MS, SECURITY_ROLLUP_BATCH } from "./lib/limits";
import { serverDay } from "./lib/lockdownReports";

// `security:rollup` (Phase 5 Step 10 item 7, plan 4.19): yesterday's per-device counters fold into one row per organization,
// repeated runs never add twice, and expired rows go (device days 14 d, organization days 90 d).

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const drain = (t: T) => t.finishAllScheduledFunctions(vi.runAllTimers);
const dayAgo = (n: number) => serverDay(Date.now() - n * DAY_MS);
const blocked = (a: number, b = 0, c = 0, e = 0) => ({ appLocker: a, appControl: b, procWatch: c, elevation: e });

async function deviceDay(
  t: T,
  orgId: Id<"organizations">,
  day: string,
  o: { blocked?: ReturnType<typeof blocked>; denials?: { appId: string; kind: string; count: number }[]; n?: number } = {},
) {
  await t.run(async (ctx) => {
    for (let i = 0; i < (o.n ?? 1); i++) {
      const deviceId = await ctx.db.insert("devices", { orgId, name: `PC ${i}`, enrolledAt: 1, enrollmentTokenId: await tokenOf(ctx, orgId), revision: 0 });
      await ctx.db.insert("deviceSecurityDaily", {
        orgId,
        deviceId,
        day,
        blocked: o.blocked ?? blocked(1),
        permissionDenials: o.denials ?? [],
        drift: 0,
        tamper: 0,
      });
    }
  });
}

async function tokenOf(ctx: { db: { insert: (t: "enrollmentTokens", v: never) => Promise<Id<"enrollmentTokens">> } }, orgId: Id<"organizations">) {
  return await ctx.db.insert("enrollmentTokens", { orgId, tokenHash: `t-${Math.random()}`, expiresAt: 0, usesLeft: 0, createdAt: 0 } as never);
}

const orgDays = (t: T, orgId: Id<"organizations">) =>
  t.run((ctx) => ctx.db.query("orgSecurityDaily").withIndex("by_org_day", (q) => q.eq("orgId", orgId)).collect());
const deviceDays = (t: T, orgId: Id<"organizations">) =>
  t.run((ctx) => ctx.db.query("deviceSecurityDaily").withIndex("by_org_day", (q) => q.eq("orgId", orgId)).collect());

describe("security:rollup", () => {
  test("folds yesterday's rows of each organization into one row, adds the counts and merges the denials; today's and older days stay out", async () => {
    const t = await setupAuth();
    const a = await makeOrg(t, "Org A");
    const b = await makeOrg(t, "Org B");
    const c = await makeOrg(t, "Org C (no rows)");
    const y = dayAgo(1);
    await deviceDay(t, a, y, { blocked: blocked(2, 1, 0, 1), denials: [{ appId: "app1", kind: "camera", count: 2 }], n: 3 });
    await deviceDay(t, a, y, { blocked: blocked(0, 0, 5, 0), denials: [{ appId: "app1", kind: "camera", count: 1 }, { appId: "app2", kind: "printing", count: 4 }] });
    await deviceDay(t, a, serverDay(Date.now()), { blocked: blocked(100) }); // today: not rolled up yet
    await deviceDay(t, a, dayAgo(2), { blocked: blocked(100) }); // an older day: not this run's
    await deviceDay(t, b, y, { blocked: blocked(7), n: 2 });

    await t.mutation(internal.security.rollup, {});
    await drain(t);

    const [ra] = await orgDays(t, a);
    expect(await orgDays(t, a)).toHaveLength(1);
    expect(ra).toMatchObject({ day: y, devicesReporting: 4, blocked: blocked(6, 3, 5, 3) });
    expect(ra!.permissionDenials).toEqual([{ appId: "app1", kind: "camera", count: 7 }, { appId: "app2", kind: "printing", count: 4 }].sort((x, z) => z.count - x.count));
    expect((await orgDays(t, b))[0]).toMatchObject({ day: y, devicesReporting: 2, blocked: blocked(14) });
    expect(await orgDays(t, c)).toEqual([]);
    // Nothing leaks across organizations: A's row holds A's counts only.
    expect((await orgDays(t, a))[0]!.orgId).toBe(a);
  });

  test("idempotent: the same day again replaces the row (never adds twice) and writes no second row", async () => {
    const t = await setupAuth();
    const a = await makeOrg(t, "Org A");
    await deviceDay(t, a, dayAgo(1), { blocked: blocked(3), n: 2 });
    await t.mutation(internal.security.rollup, {});
    await drain(t);
    await t.mutation(internal.security.rollup, {});
    await drain(t);
    const rows = await orgDays(t, a);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ devicesReporting: 2, blocked: blocked(6) });
  });

  test("more rows than one page: the sums carry across the scheduled steps", async () => {
    const t = await setupAuth();
    const a = await makeOrg(t, "Org A");
    const n = SECURITY_ROLLUP_BATCH * 2 + 50;
    await deviceDay(t, a, dayAgo(1), { blocked: blocked(1, 0, 0, 2), denials: [{ appId: "app1", kind: "downloads", count: 3 }], n });
    await t.mutation(internal.security.rollup, {});
    await drain(t);
    const [row] = await orgDays(t, a);
    expect(row).toMatchObject({ devicesReporting: n, blocked: blocked(n, 0, 0, 2 * n) });
    expect(row!.permissionDenials).toEqual([{ appId: "app1", kind: "downloads", count: 3 * n }]);
  });

  test("retention: device days older than 14 days and organization days older than 90 days are deleted; newer ones stay", async () => {
    const t = await setupAuth();
    const a = await makeOrg(t, "Org A");
    const b = await makeOrg(t, "Org B");
    for (const org of [a, b]) {
      await deviceDay(t, org, dayAgo(20));
      await deviceDay(t, org, dayAgo(15));
      await deviceDay(t, org, dayAgo(13));
      await t.run(async (ctx) => {
        for (const age of [120, 91, 89, 10]) {
          await ctx.db.insert("orgSecurityDaily", { orgId: org, day: dayAgo(age), blocked: blocked(1), permissionDenials: [], devicesReporting: 1 });
        }
      });
    }
    await t.mutation(internal.security.rollup, {});
    await drain(t);
    for (const org of [a, b]) {
      expect((await deviceDays(t, org)).map((r) => r.day)).toEqual([dayAgo(13)]);
      expect((await orgDays(t, org)).map((r) => r.day).sort()).toEqual([dayAgo(89), dayAgo(10)].sort());
    }
  });

  test("a backlog bigger than one retention batch keeps pruning in further steps", async () => {
    const t = await setupAuth();
    const a = await makeOrg(t, "Org A");
    await deviceDay(t, a, dayAgo(30), { n: 450 });
    await t.mutation(internal.security.rollup, {});
    await drain(t);
    expect(await deviceDays(t, a)).toEqual([]);
  });

  test("an explicit day folds that day (re-run of a missed night)", async () => {
    const t = await setupAuth();
    const a = await makeOrg(t, "Org A");
    await deviceDay(t, a, dayAgo(3), { blocked: blocked(9) });
    await t.mutation(internal.security.rollup, { day: dayAgo(3) });
    await drain(t);
    expect((await orgDays(t, a))[0]).toMatchObject({ day: dayAgo(3), devicesReporting: 1, blocked: blocked(9) });
  });

  test("the walk visits every organization once and ends (no organizations: done)", async () => {
    const t = await setupAuth();
    expect(await t.mutation(internal.security.rollup, {})).toEqual({ state: "done" });
    const orgs: Id<"organizations">[] = [];
    for (let i = 0; i < 4; i++) {
      const o = await makeOrg(t, `Org ${i}`);
      orgs.push(o);
      await deviceDay(t, o, dayAgo(1), { blocked: blocked(i + 1) });
    }
    await t.mutation(internal.security.rollup, {});
    await drain(t);
    for (const [i, o] of orgs.entries()) expect((await orgDays(t, o))[0], `org ${i}`).toMatchObject({ blocked: blocked(i + 1), devicesReporting: 1 });
  });
});
