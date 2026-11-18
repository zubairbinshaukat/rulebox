import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { seedLargeOrg } from "../tests/convex/largeOrg";
import { DEVICE_CALLS, fixture, outcome, publicFunctions, ROWS, type Caller, type Fixture, type Row } from "../tests/convex/matrixRows";
import { api } from "./_generated/api";
import { ORG_TABLES } from "./lib/orgDb";
import schema from "./schema";

declare const process: { env: Record<string, string | undefined> };

// Cross-organization tests (plan Step 18 items 3 and 8): the other organization's owner never reaches
// this organization's rows, and nothing in an answer belongs to another organization even when both
// organizations have identical names.

beforeEach(() => {
  process.env.RULEBOX_RECOVERY_PEPPER = "cross-org-test-recovery-pepper-0123456789";
});
afterEach(() => {
  delete process.env.RULEBOX_RECOVERY_PEPPER;
});

/** The fixture ids a row can take: a row that reads one of them takes an id argument. */
const ID_KEYS = [
  "targetMemberId", "inviteId", "groupId", "tokenId", "deviceId", "checkId", "appId", "desktopAppId", "assignmentId", "handlerId", "employeeId",
] as const;

/** Which fixture ids `row.call` uses, found by running it against a recording stub instead of the deployment. */
async function idsUsedBy(row: Row, f: Fixture): Promise<string[]> {
  const used = new Set<string>();
  const recording = new Proxy(f, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && (ID_KEYS as readonly string[]).includes(prop)) used.add(prop);
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
  const stub = { query: async () => null, mutation: async () => null, action: async () => null } as unknown as Fixture["accessor"][Caller];
  await row.call(stub, recording);
  return [...used];
}

/** Every document of the organization (tables with an `orgId`), as JSON, to see that nothing changed. */
async function snapshot(f: Fixture): Promise<Record<string, string[]>> {
  return await f.t.run(async (ctx) => {
    const out: Record<string, string[]> = {};
    for (const table of ORG_TABLES) {
      const docs = await ctx.db.query(table as never).collect();
      const mine = (docs as unknown as { orgId?: string }[]).filter((d) => d.orgId === f.orgId);
      if (mine.length > 0) out[table] = mine.map((d) => JSON.stringify(d)).sort();
    }
    return out;
  });
}

describe("cross-organization (plan Step 18 item 3)", () => {
  const rows = ROWS.map((r) => [r.name, r] as const);

  test.each(rows)(
    "%s: the other organization's owners get not_found for this organization's ids and change nothing",
    async (name, row) => {
      const f = await fixture();
      const ids = await idsUsedBy(row, f);
      if (ids.length === 0) return; // takes no id of this organization (they act on THEIR organization)
      const before = await snapshot(f);
      for (const caller of ["foreign", "ownerSuspended"] as const) {
        const r = await outcome(row.call(f.accessor[caller], f));
        if (name === "audit:forTarget") {
          // A read by target id: another organization's id gives an EMPTY page, never this organization's history.
          expect(r.result, `${name} as ${caller}`).toBe("ok");
          expect((r.value as { page: unknown[] }).page, `${name} as ${caller}`).toEqual([]);
        } else {
          expect(r.result, `${name} as ${caller} (ids: ${ids.join(", ")})`).toBe("not_found");
        }
      }
      expect(await snapshot(f)).toEqual(before);
    },
  );

  test("the walk covers every function that takes an id (a guard against a row that stops using its fixture)", async () => {
    const f = await fixture();
    const withIds: string[] = [];
    for (const row of ROWS) if ((await idsUsedBy(row, f)).length > 0) withIds.push(row.name);
    expect(withIds.length).toBeGreaterThan(40);
    for (const must of ["groups:get", "fleet:get", "apps:get", "employees:get", "fleet:revoke", "apps:remove", "employees:remove", "enrollmentCodes:revoke", "members:changeRole", "stepUp:resetMember"]) {
      expect(withIds, must).toContain(must);
    }
  });

  test("a device of another organization cannot act on this organization's device", async () => {
    const a = await fixture();
    const b = await fixture(a.t); // same deployment, a second organization with a device of its own
    const wrong = { deviceId: a.deviceId, deviceSecret: b.deviceSecret }; // A's id with B's secret
    const mixed = { deviceId: b.deviceId, deviceSecret: a.deviceSecret }; // B's id with A's secret
    const before = await snapshot(a);
    const beforeB = await snapshot(b);
    for (const [name, make] of Object.entries(DEVICE_CALLS)) {
      if (name === "enrollment:enroll") continue; // takes a code, not a device
      for (const creds of [wrong, mixed]) {
        const r = await outcome((await make(a, creds))());
        expect(["device_rejected", "kind:unknownDevice", "kind:rejected"], `${name} with ${creds === wrong ? "A id + B secret" : "B id + A secret"} answered ${r.result}`).toContain(r.result);
      }
    }
    expect(await snapshot(a)).toEqual(before);
    expect(await snapshot(b)).toEqual(beforeB);
  });

  test("a device reporting an app of another organization writes nothing for it", async () => {
    const a = await fixture();
    const b = await fixture(a.t);
    const before = await snapshot(a);
    const result = { appId: a.appId, state: "failed" as const, appRevision: 1, attempts: 3, exitCode: 1603, detail: "exit_code" };
    const r = await outcome(a.t.mutation(api.deviceApi.report, { deviceId: b.deviceId, deviceSecret: b.deviceSecret, installs: [result] }));
    expect(r.result).toBe("ok"); // accepted (the agent must not stall) but ignored
    expect(await snapshot(a)).toEqual(before);
    const rows = await a.t.run((ctx) => ctx.db.query("installResults").collect());
    expect(rows.filter((x) => x.appId === a.appId)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Cross-tenant property test (A15, item 8)

type Located = { table: string; orgs: string[] | null };

/** id -> table and the organization(s) the row belongs to, for every document of the deployment. */
async function locateAll(f: Fixture): Promise<Record<string, Located>> {
  return await f.t.run(async (ctx) => {
    type Doc = Record<string, unknown> & { _id: string };
    const all = new Map<string, { table: string; doc: Doc }>();
    for (const table of Object.keys(schema.tables)) {
      for (const doc of (await ctx.db.query(table as never).collect()) as unknown as Doc[]) all.set(doc._id, { table, doc });
    }
    const orgsOf = new Map<string, Set<string>>(); // userId -> organizations they are a member of
    for (const { table, doc } of all.values()) {
      if (table === "members") {
        const set = orgsOf.get(doc.userId as string) ?? new Set<string>();
        set.add(doc.orgId as string);
        orgsOf.set(doc.userId as string, set);
      }
    }
    const resolve = (id: string, depth = 0): Set<string> | null => {
      const hit = all.get(id);
      if (hit === undefined || depth > 4) return null;
      const { table, doc } = hit;
      if (table === "organizations") return new Set([doc._id]);
      if (typeof doc.orgId === "string") return new Set([doc.orgId]);
      for (const link of ["deviceId", "employeeId", "groupId", "appId"] as const) {
        const target = doc[link];
        if (typeof target === "string") return resolve(target, depth + 1);
      }
      if (typeof doc.userId === "string") return orgsOf.get(doc.userId) ?? null;
      return null;
    };
    // Plain objects only: `t.run` cannot return a Map or a Set.
    const out: Record<string, Located> = {};
    for (const [id, { table }] of all) out[id] = { table, orgs: [...(resolve(id) ?? [])].length === 0 ? null : [...resolve(id)!] };
    return out;
  });
}

/** Every string in `value` (keys excluded); the caller keeps the ones that are document ids. */
function idsIn(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (typeof value === "string") {
    out.add(value);
  } else if (Array.isArray(value)) {
    for (const x of value) idsIn(x, out);
  } else if (value !== null && typeof value === "object") {
    for (const x of Object.values(value)) idsIn(x, out);
  }
  return out;
}

describe("cross-tenant property (plan Step 18 item 8)", () => {
  test("two organizations with identical names: every _id in every query result belongs to the caller's organization", async () => {
    const a = await fixture();
    const b = await fixture(a.t);
    // The same names in both: "Group 0", "PC 0", "Employee 0", "App 0"... on top of the fixture's own identical rows
    // ("Acme", "Sales", "Docs", "Wiki", "Reader", "maya", "target@acme.test", device "PC").
    const small = { devices: 12, employees: 15, apps: 4, groups: 3, audit: 25 };
    await seedLargeOrg(a.t, a.orgId, small);
    await seedLargeOrg(a.t, b.orgId, small);
    const located = await locateAll(a);
    const fns = await publicFunctions();
    const queries = ROWS.filter((r) => fns.get(r.name)?.isQuery === true);
    expect(queries.length).toBeGreaterThan(30);

    let seen = 0;
    const perOrg = new Map<string, number>();
    const leaks: string[] = [];
    for (const [who, f] of [["A", a], ["B", b]] as const) {
      for (const row of queries) {
        if (row.name === "health:ping") continue;
        // Device queries are called with the fixture device's real credentials (the rows present a wrong secret).
        const device = DEVICE_CALLS[row.name];
        const r = await outcome(device !== undefined ? (await device(f))() : row.call(f.accessor.owner, f));
        expect(r.result, `${row.name} as ${who}'s ${device !== undefined ? "device" : "owner"}`).toMatch(row.name === "devices:fetchDesired" ? /^(ok|not_found)$/ : /^ok$/); // version 1 exists only once the scheduled publish ran
        for (const id of idsIn(r.value)) {
          const where = located[id];
          if (where === undefined) continue; // a cursor or other string, not a document id
          seen++;
          if (where.orgs === null) continue; // a table that belongs to no organization (users, sessions...)
          perOrg.set(f.orgId, (perOrg.get(f.orgId) ?? 0) + 1);
          if (where.orgs.length !== 1 || !where.orgs.includes(f.orgId)) leaks.push(`${row.name} as ${who}: ${where.table} ${id} belongs to ${where.orgs.join(",")}`);
        }
      }
    }
    expect(leaks).toEqual([]);
    // Not vacuous: plenty of ids were checked, in both organizations.
    expect(seen).toBeGreaterThan(200);
    expect(perOrg.get(a.orgId) ?? 0).toBeGreaterThan(50);
    expect(perOrg.get(b.orgId) ?? 0).toBeGreaterThan(50);
  });
});
