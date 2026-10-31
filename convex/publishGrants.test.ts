import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { setupAuth } from "../tests/convex/auth";
import { makeOrg, type T } from "../tests/convex/identity";
import { setSeeds, TEST_SEED_B64 } from "../tests/convex/keys";
import type { Id } from "./_generated/dataModel";
import { auditPolicy } from "./lib/audit";
import { MAX_EMPLOYEE_APPS, MAX_GROUP_GRANT_APPS, MAX_GROUP_GRANT_EMPLOYEES } from "./lib/limits";
import { DEFAULT_WEB_PERMISSIONS } from "./lib/validators";
import { loadGroupInputs } from "./publish";

// Step 11 review, SHOULD-FIX 1: the work of loading a group for the publisher is
// bounded whatever the group's size (the Convex limits are in lib/limits.ts).

beforeEach(() => {
  auditPolicy.strict = true;
});
afterEach(() => {
  auditPolicy.strict = false;
  setSeeds(TEST_SEED_B64);
});

type Db = Parameters<Parameters<T["run"]>[0]>[0]["db"];

/** A database whose reads are counted: `ranges` = db.get + db.query calls, `docs` = documents they returned. */
function counting(db: Db) {
  const stats = { ranges: 0, docs: 0 };
  const wrap = (q: object): object =>
    new Proxy(q, {
      get(target, prop) {
        const value = (target as Record<string | symbol, unknown>)[prop];
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          const result = (value as (...a: unknown[]) => unknown).apply(target, args);
          if (result !== null && typeof result === "object" && "then" in result) {
            return (result as Promise<unknown>).then((rows) => {
              stats.docs += Array.isArray(rows) ? rows.length : rows === null ? 0 : 1;
              return rows;
            });
          }
          return result !== null && typeof result === "object" ? wrap(result) : result;
        };
      },
    });
  const proxy = new Proxy(db, {
    get(target, prop) {
      const value = (target as unknown as Record<string | symbol, unknown>)[prop];
      if (prop === "query") {
        return (table: string) => {
          stats.ranges++;
          return wrap((target.query as (t: string) => object)(table));
        };
      }
      if (prop === "get") {
        return async (id: never) => {
          stats.ranges++;
          const doc = await target.get(id);
          if (doc !== null) stats.docs++;
          return doc;
        };
      }
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { db: proxy as Db, stats };
}

async function webApps(t: T, orgId: Id<"organizations">, count: number): Promise<Id<"apps">[]> {
  return await t.run(async (ctx) => {
    const ids: Id<"apps">[] = [];
    for (let i = 0; i < count; i++) {
      ids.push(
        await ctx.db.insert("apps", {
          orgId,
          name: `App ${i}`,
          kind: "web",
          web: { url: "https://docs.example.com", allowedDomains: ["docs.example.com"], permissions: DEFAULT_WEB_PERMISSIONS },
          archived: false,
          revision: 0,
          createdAt: i,
        }),
      );
    }
    return ids;
  });
}

/** A group with `members` employees; the first `granted` of them are enabled and hold `appsEach` of `apps` directly (flagged like the app does). */
async function groupWith(
  t: T,
  orgId: Id<"organizations">,
  members: number,
  granted: number,
  apps: Id<"apps">[] = [],
  appsEach = 1,
): Promise<Id<"groups">> {
  return await t.run(async (ctx) => {
    const groupId = await ctx.db.insert("groups", { orgId, name: `G${members}-${granted}-${Math.random().toString(36).slice(2, 6)}`, revision: 0, createdAt: 0 });
    for (let i = 0; i < members; i++) {
      const employeeId = await ctx.db.insert("employees", {
        orgId,
        name: `P${i}`,
        username: `p${groupId}-${i}`,
        searchText: `p${i}`,
        disabled: false,
        credentialRevision: 0,
        revision: 0,
        createdAt: i,
      });
      const has = i < granted;
      await ctx.db.insert("groupMembers", { orgId, groupId, employeeId, grantsActive: has ? true : undefined });
      if (has) for (let k = 0; k < appsEach; k++) await ctx.db.insert("employeeApps", { orgId, employeeId, appId: apps[(i * appsEach + k) % apps.length]! });
    }
    return groupId;
  });
}

async function load(t: T, groupId: Id<"groups">, orgId: Id<"organizations">) {
  return await t.run(async (ctx) => {
    const { db, stats } = counting(ctx.db);
    const result = await loadGroupInputs({ db, storage: ctx.storage }, orgId, groupId);
    return { result, stats: { ...stats } };
  });
}

async function auditOf(t: T, orgId: Id<"organizations">) {
  return await t.run((ctx) => ctx.db.query("auditLog").withIndex("by_org_at", (q) => q.eq("orgId", orgId)).take(50));
}

describe("loadGroupInputs: bounded work", () => {
  test("members without direct apps cost nothing: 400 members read exactly like 5", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const small = await load(t, await groupWith(t, orgId, 5, 0), orgId);
    const big = await load(t, await groupWith(t, orgId, 400, 0), orgId);
    expect(big.stats).toEqual(small.stats);
    expect(big.stats.ranges).toBeLessThanOrEqual(3); // group, assignments, flagged members
    expect(big.stats.docs).toBe(1); // only the group document
    expect(big.result.inputs.employees).toEqual([]);
    expect(big.result.ranges).toBe(big.stats.ranges); // the cost the publisher adds up is the real one
    expect(big.result.docs).toBe(big.stats.docs);
  });

  test("300 members, 40 with grants: reads grow with the 40, not the 300", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const apps = await webApps(t, orgId, 6);
    const g = await groupWith(t, orgId, 300, 40, apps, 2);
    const { result, stats } = await load(t, g, orgId);
    expect(result.inputs.employees).toHaveLength(40);
    expect(result.inputs.employeeApps).toHaveLength(80);
    expect(result.inputs.apps).toHaveLength(6);
    // group + assignments + flagged members + 40 grant reads + 6 apps
    expect(stats.ranges).toBe(1 + 1 + 1 + 40 + 6);
    expect(stats.docs).toBeLessThanOrEqual(1 + 40 + 80 + 6);
    expect(result.ranges).toBe(stats.ranges);
    expect(result.docs).toBe(stats.docs);
    expect(await auditOf(t, orgId)).toEqual([]); // within the caps: no entry
  });

  test("a disabled employee, or one whose flag is off, is not read at all", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const apps = await webApps(t, orgId, 1);
    const g = await groupWith(t, orgId, 10, 3, apps);
    await t.run(async (ctx) => {
      const rows = await ctx.db.query("groupMembers").withIndex("by_group_grants", (q) => q.eq("groupId", g).eq("grantsActive", true)).take(10);
      await ctx.db.patch(rows[0]!._id, { grantsActive: false }); // disabled later: the app clears the flag
    });
    const { result, stats } = await load(t, g, orgId);
    expect(result.inputs.employees).toHaveLength(2);
    expect(stats.ranges).toBe(1 + 1 + 1 + 2 + 1);
  });

  test("more than MAX_GROUP_GRANT_EMPLOYEES members with grants: the first are kept, reads stay capped, ONE audit entry says so", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const apps = await webApps(t, orgId, 3);
    const g = await groupWith(t, orgId, MAX_GROUP_GRANT_EMPLOYEES + 30, MAX_GROUP_GRANT_EMPLOYEES + 30, apps);
    const { result, stats } = await load(t, g, orgId);
    expect(result.inputs.employees).toHaveLength(MAX_GROUP_GRANT_EMPLOYEES);
    expect(stats.ranges).toBeLessThanOrEqual(1 + 1 + 1 + MAX_GROUP_GRANT_EMPLOYEES + 3);
    const audit = await auditOf(t, orgId);
    expect(audit.filter((r) => r.action === "policy.publishFailed")).toHaveLength(1);
    expect(audit[0]).toMatchObject({ targetType: "group", targetId: g });
    expect(audit[0]!.summary).toContain("too many");
  });

  test("more than MAX_GROUP_GRANT_APPS distinct granted apps: the surplus is left out with an audit entry", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const apps = await webApps(t, orgId, MAX_GROUP_GRANT_APPS + 10);
    // 10 employees with 50 apps each, all different: 500 grants over 160 apps
    const g = await groupWith(t, orgId, 10, 10, apps, MAX_EMPLOYEE_APPS);
    const { result } = await load(t, g, orgId);
    expect(new Set(result.inputs.employeeApps.map((x) => x.appId)).size).toBeLessThanOrEqual(MAX_GROUP_GRANT_APPS);
    expect(result.inputs.apps.length).toBeLessThanOrEqual(MAX_GROUP_GRANT_APPS);
    expect((await auditOf(t, orgId)).filter((r) => r.action === "policy.publishFailed")).toHaveLength(1);
  });
});
