import { afterEach, describe, expect, test, vi } from "vitest";
import { setupAuth } from "../tests/convex/auth";
import { enrollDevice, orgStatsOf } from "../tests/convex/devices";
import { asMember, expectCode, giveStepUp, makeOrg, type T } from "../tests/convex/identity";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { MINUTE_MS } from "./lib/limits";
import { LIST_SORTS, pageInMemory, pickSort } from "./lib/listing";
import { DEFAULT_WEB_PERMISSIONS } from "./lib/validators";

// Phase 4b Part A: the server-driven list contract (lib/listing.ts) on every
// list query a dashboard table uses: sort allow-lists, both directions, search
// with pagination, page sizes, the "last page" read and the totals.

afterEach(() => {
  vi.useRealTimers();
});

const page = (numItems = 50, cursor: string | null = null) => ({ paginationOpts: { numItems, cursor } });
const asc = (key: string) => ({ sort: { key, dir: "asc" as const } });
const desc = (key: string) => ({ sort: { key, dir: "desc" as const } });

async function admin(t: T, orgId: Id<"organizations">) {
  const m = await asMember(t, { role: "admin", orgId });
  await giveStepUp(t, m);
  return m;
}

async function group(t: T, orgId: Id<"organizations">, name: string, createdAt = Date.now()) {
  return await t.run((ctx) => ctx.db.insert("groups", { orgId, name, revision: 0, createdAt }));
}

async function setStats(t: T, orgId: Id<"organizations">, patch: Record<string, number>) {
  await t.run(async (ctx) => {
    const st = (await ctx.db.query("orgStats").withIndex("by_org", (q) => q.eq("orgId", orgId)).unique())!;
    await ctx.db.patch(st._id, patch);
  });
}

/** Devices named in this order (enrolled one after the other, so "created" follows the same order). */
async function devices(t: T, orgId: Id<"organizations">, names: string[], groupId?: Id<"groups">) {
  const ids: Id<"devices">[] = [];
  for (const name of names) ids.push((await enrollDevice(t, orgId, { name, groupId })).deviceId);
  return ids;
}

async function employee(t: T, orgId: Id<"organizations">, name: string, username: string) {
  return await t.run((ctx) =>
    ctx.db.insert("employees", {
      orgId,
      name,
      username,
      searchText: `${name} ${username}`.toLowerCase(),
      disabled: false,
      credentialRevision: 0,
      revision: 0,
      createdAt: Date.now(),
    }),
  );
}

async function webApp(t: T, orgId: Id<"organizations">, name: string, archived = false) {
  return await t.run((ctx) =>
    ctx.db.insert("apps", {
      orgId,
      name,
      kind: "web",
      web: { url: "https://example.com", allowedDomains: ["example.com"], permissions: DEFAULT_WEB_PERMISSIONS },
      archived,
      revision: 0,
      createdAt: Date.now(),
    }),
  );
}

describe("lib/listing", () => {
  test("pickSort: default, allowed keys either way, unknown key -> invalid_argument", () => {
    expect(pickSort("devices", undefined)).toEqual({ key: "created", dir: "desc" });
    expect(pickSort("groups", undefined)).toEqual({ key: "name", dir: "asc" });
    expect(pickSort("devices", { key: "name", dir: "asc" })).toEqual({ key: "name", dir: "asc" });
    expect(() => pickSort("devices", { key: "status", dir: "asc" })).toThrow();
    expect(() => pickSort("audit", { key: "name", dir: "asc" })).toThrow();
    // Every table has at least one key; the first one is the default.
    for (const table of Object.keys(LIST_SORTS) as (keyof typeof LIST_SORTS)[]) {
      expect(pickSort(table, undefined).key).toBe(Object.keys(LIST_SORTS[table])[0]);
    }
  });

  test("pageInMemory: offset cursors, exact total, foreign cursors refused", () => {
    const rows = [1, 2, 3, 4, 5];
    const first = pageInMemory(rows, { numItems: 2, cursor: null });
    expect(first).toEqual({ page: [1, 2], isDone: false, continueCursor: "o:2", total: 5 });
    const last = pageInMemory(rows, { numItems: 2, cursor: "o:4" });
    expect(last).toMatchObject({ page: [5], isDone: true });
    expect(pageInMemory(rows, { numItems: 2, cursor: "o:99" })).toMatchObject({ page: [], isDone: true });
    expect(() => pageInMemory(rows, { numItems: 2, cursor: "abc" })).toThrow();
  });
});

describe("fleet:list sort, search, page size", () => {
  test("created and name, both directions, whole org, one group and 'none'; unknown key and bad sizes refused", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t, "Acme", { plan: "custom" });
    const sales = await group(t, orgId, "Sales");
    await devices(t, orgId, ["Charlie", "Alpha"]);
    await devices(t, orgId, ["Bravo", "Delta"], sales);
    const v = await asMember(t, { role: "viewer", orgId });
    const names = async (args: object) => (await v.as.query(api.fleet.list, { ...page(), ...args })).page.map((r) => r.name);

    expect(await names({})).toEqual(["Delta", "Bravo", "Alpha", "Charlie"]);
    expect(await names(asc("created"))).toEqual(["Charlie", "Alpha", "Bravo", "Delta"]);
    expect(await names(asc("name"))).toEqual(["Alpha", "Bravo", "Charlie", "Delta"]);
    expect(await names(desc("name"))).toEqual(["Delta", "Charlie", "Bravo", "Alpha"]);
    expect(await names({ groupId: sales, ...desc("name") })).toEqual(["Delta", "Bravo"]);
    expect(await names({ groupId: sales, ...asc("created") })).toEqual(["Bravo", "Delta"]);
    expect(await names({ groupId: "none", ...asc("name") })).toEqual(["Alpha", "Charlie"]);
    expect(await names({ groupId: "none", ...asc("created") })).toEqual(["Charlie", "Alpha"]);

    await expectCode(v.as.query(api.fleet.list, { ...page(), ...asc("status") }), "invalid_argument");
    await expectCode(v.as.query(api.fleet.list, page(0)), "invalid_argument");
    await expectCode(v.as.query(api.fleet.list, page(51)), "invalid_argument");
    await expectCode(v.as.query(api.fleet.list, page(2.5)), "invalid_argument");
    // A remainder page (total mod pageSize) is any size up to 50.
    expect((await v.as.query(api.fleet.list, page(3))).page).toHaveLength(3);
  });

  test("pages follow the sort; the last page is the reverse order with numItems = total mod pageSize", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t, "Acme", { plan: "custom" });
    await devices(t, orgId, ["E", "B", "D", "A", "C"]);
    const v = await asMember(t, { role: "viewer", orgId });
    const p1 = await v.as.query(api.fleet.list, { ...page(2), ...asc("name") });
    const p2 = await v.as.query(api.fleet.list, { ...page(2, p1.continueCursor), ...asc("name") });
    const p3 = await v.as.query(api.fleet.list, { ...page(2, p2.continueCursor), ...asc("name") });
    expect([p1, p2, p3].map((p) => p.page.map((r) => r.name))).toEqual([["A", "B"], ["C", "D"], ["E"]]);
    expect(p3.isDone).toBe(true);
    const { total } = await v.as.query(api.fleet.count, {});
    expect(total).toBe(5);
    const last = await v.as.query(api.fleet.list, { ...page(total! % 2), ...desc("name") });
    expect(last.page.map((r) => r.name).reverse()).toEqual(p3.page.map((r) => r.name));
  });

  test("a search is relevance-ordered: the sort is ignored, never refused", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t, "Acme", { plan: "custom" });
    const [front] = await devices(t, orgId, ["Front desk", "Back office"]);
    const v = await asMember(t, { role: "viewer", orgId });
    const found = await v.as.query(api.fleet.list, { ...page(), search: "  front ", ...desc("name") });
    expect(found.page.map((r) => r._id)).toEqual([front]);
    await expectCode(v.as.query(api.fleet.list, { ...page(), search: "x".repeat(101) }), "invalid_argument");
  });
});

describe("fleet:count", () => {
  test("equals the listed rows, revoked devices included, for the org and 'No group'; null otherwise; removal follows", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t, "Acme", { plan: "custom" });
    const sales = await group(t, orgId, "Sales");
    const [loose1, loose2] = await devices(t, orgId, ["L1", "L2"]);
    const [grouped] = await devices(t, orgId, ["G1"], sales);
    const a = await admin(t, orgId);
    const rows = async (args: object) => (await a.as.query(api.fleet.list, { ...page(), ...args })).page.length;
    const total = async (args: object) => (await a.as.query(api.fleet.count, args)).total;

    await a.as.mutation(api.fleet.revoke, { deviceId: loose1! });
    await a.as.mutation(api.fleet.revoke, { deviceId: grouped! });
    expect(await orgStatsOf(t, orgId)).toMatchObject({ deviceCount: 1, revokedDeviceCount: 2, revokedNoGroupDeviceCount: 1 });
    expect(await total({})).toBe(3);
    expect(await total({})).toBe(await rows({}));
    expect(await total({ groupId: "none" })).toBe(2);
    expect(await total({ groupId: "none" })).toBe(await rows({ groupId: "none" }));
    expect(await total({ groupId: sales })).toBeNull();
    expect(await total({ search: "L" })).toBeNull();
    expect(await total({ search: "   " })).toBe(3); // blank = no search

    await a.as.mutation(api.fleet.remove, { deviceId: loose1! });
    await a.as.mutation(api.fleet.remove, { deviceId: grouped! });
    expect(await total({})).toBe(1);
    expect(await total({})).toBe(await rows({}));
    expect(await total({ groupId: "none" })).toBe(await rows({ groupId: "none" }));
    expect(loose2).toBeDefined();

    // Another organization's counter is never read.
    const foreign = await asMember(t, { role: "owner", orgId: await makeOrg(t, "Other") });
    expect((await foreign.as.query(api.fleet.count, {})).total).toBe(0);
  });

  test("stats:reconcile recounts the revoked counters", async () => {
    vi.useFakeTimers();
    const t = await setupAuth();
    const orgId = await makeOrg(t, "Acme", { plan: "custom" });
    const sales = await group(t, orgId, "Sales");
    const [loose] = await devices(t, orgId, ["L1"]);
    const [grouped] = await devices(t, orgId, ["G1"], sales);
    const a = await admin(t, orgId);
    await a.as.mutation(api.fleet.revoke, { deviceId: loose! });
    await a.as.mutation(api.fleet.revoke, { deviceId: grouped! });
    await setStats(t, orgId, { revokedDeviceCount: 9, revokedNoGroupDeviceCount: 0 });
    await t.mutation(internal.stats.reconcile, { orgId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await orgStatsOf(t, orgId)).toMatchObject({ revokedDeviceCount: 2, revokedNoGroupDeviceCount: 1 });
  });
});

describe("employees:list sort and paginated search", () => {
  test("name / username / created either way; group filter allows 'created' only", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    await employee(t, orgId, "Maya", "zed");
    await employee(t, orgId, "Abe", "yan");
    await employee(t, orgId, "Lea", "xia");
    const g = await group(t, orgId, "Floor");
    const v = await asMember(t, { role: "viewer", orgId });
    const names = async (args: object) => (await v.as.query(api.employees.list, { ...page(), ...args })).page.map((r) => r.name);
    expect(await names({})).toEqual(["Lea", "Abe", "Maya"]);
    expect(await names(asc("created"))).toEqual(["Maya", "Abe", "Lea"]);
    expect(await names(asc("name"))).toEqual(["Abe", "Lea", "Maya"]);
    expect(await names(desc("name"))).toEqual(["Maya", "Lea", "Abe"]);
    expect(await names(asc("username"))).toEqual(["Lea", "Abe", "Maya"]);
    expect(await names({ groupId: g, ...asc("created") })).toEqual([]);
    await expectCode(v.as.query(api.employees.list, { ...page(), groupId: g, ...asc("name") }), "invalid_argument");
    await expectCode(v.as.query(api.employees.list, { ...page(), ...asc("email") }), "invalid_argument");
  });

  test("search pages with Next like any list; with a group, non-members are dropped (short pages)", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const ids: Id<"employees">[] = [];
    for (let i = 0; i < 5; i++) ids.push(await employee(t, orgId, `Sam ${i}`, `sam${i}`));
    await employee(t, orgId, "Other", "other");
    await employee(t, await makeOrg(t, "Foreign"), "Sam X", "samx");
    const g = await group(t, orgId, "Floor");
    await t.run(async (ctx) => {
      for (const e of [ids[0]!, ids[3]!]) await ctx.db.insert("groupMembers", { orgId, groupId: g, employeeId: e });
    });
    const v = await asMember(t, { role: "viewer", orgId });
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 5; i++) {
      const r: { page: { _id: string }[]; isDone: boolean; continueCursor: string } = await v.as.query(api.employees.list, { ...page(2, cursor), search: "sam" });
      seen.push(...r.page.map((x) => x._id));
      if (r.isDone) break;
      cursor = r.continueCursor;
    }
    expect([...seen].sort()).toEqual([...ids].sort());
    const inGroup: string[] = [];
    cursor = null;
    for (let i = 0; i < 5; i++) {
      const r: { page: { _id: string }[]; isDone: boolean; continueCursor: string } = await v.as.query(api.employees.list, { ...page(2, cursor), search: "sam", groupId: g });
      expect(r.page.length).toBeLessThanOrEqual(2);
      inGroup.push(...r.page.map((x) => x._id));
      if (r.isDone) break;
      cursor = r.continueCursor;
    }
    expect(inGroup.sort()).toEqual([ids[0]!, ids[3]!].sort());
  });

  test("employees:count = employeeCount; null with a filter or a search", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    await setStats(t, orgId, { employeeCount: 7 });
    const v = await asMember(t, { role: "viewer", orgId });
    expect(await v.as.query(api.employees.count, {})).toEqual({ total: 7 });
    expect(await v.as.query(api.employees.count, { search: "a" })).toEqual({ total: null });
    expect(await v.as.query(api.employees.count, { groupId: "whatever" })).toEqual({ total: null });
  });
});

describe("apps:list sort and search", () => {
  test("name / created either way inside the archived tab; search by name; count from appCount", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    await webApp(t, orgId, "Wiki");
    await webApp(t, orgId, "Docs");
    await webApp(t, orgId, "Mail");
    await webApp(t, orgId, "Attic", true);
    await webApp(t, await makeOrg(t, "Other"), "Docs");
    const v = await asMember(t, { role: "viewer", orgId });
    const names = async (args: object) =>
      (await v.as.query(api.apps.list, { ...page(), archived: false, ...args })).page.map((r) => r.name);
    expect(await names({})).toEqual(["Mail", "Docs", "Wiki"]);
    expect(await names(asc("created"))).toEqual(["Wiki", "Docs", "Mail"]);
    expect(await names(asc("name"))).toEqual(["Docs", "Mail", "Wiki"]);
    expect(await names(desc("name"))).toEqual(["Wiki", "Mail", "Docs"]);
    expect(await names({ search: "docs", ...desc("name") })).toEqual(["Docs"]);
    expect(await names({ archived: true, ...asc("name") })).toEqual(["Attic"]);
    expect(await names({ archived: true, search: "docs" })).toEqual([]);
    await expectCode(v.as.query(api.apps.list, { ...page(), archived: false, ...asc("kind") }), "invalid_argument");

    await setStats(t, orgId, { appCount: 3 });
    expect(await v.as.query(api.apps.count, { archived: false })).toEqual({ total: 3 });
    expect(await v.as.query(api.apps.count, { archived: true })).toEqual({ total: null });
    expect(await v.as.query(api.apps.count, { archived: false, search: "d" })).toEqual({ total: null });
  });
});

describe("audit and enrollment codes", () => {
  test("audit: time either way; any other key refused", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    await t.run(async (ctx) => {
      for (let i = 1; i <= 3; i++) {
        await ctx.db.insert("auditLog", { orgId, at: i * 1000, actorType: "system", actorLabel: "system", action: "x", summary: `s${i}`, targetId: "tgt" });
      }
    });
    const v = await asMember(t, { role: "viewer", orgId });
    const sums = async (args: object) => (await v.as.query(api.audit.list, { ...page(), ...args })).page.map((r) => r.summary);
    expect(await sums({})).toEqual(["s3", "s2", "s1"]);
    expect(await sums(asc("at"))).toEqual(["s1", "s2", "s3"]);
    const target = await v.as.query(api.audit.forTarget, { targetId: "tgt", ...page(), ...asc("at") });
    expect(target.page.map((r) => r.summary)).toEqual(["s1", "s2", "s3"]);
    await expectCode(v.as.query(api.audit.list, { ...page(), ...asc("actor") }), "invalid_argument");
  });

  test("enrollment codes: created (default) and expires, either way", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const now = Date.now();
    await t.run(async (ctx) => {
      const code = (label: string, createdAt: number, expiresAt: number) =>
        ctx.db.insert("enrollmentTokens", { orgId, tokenHash: label.repeat(64).slice(0, 64), label, usesLeft: 1, usesTotal: 1, createdAt, expiresAt });
      await code("a", now - 3000, now + 3 * 3_600_000);
      await code("b", now - 2000, now + 1 * 3_600_000);
      await code("c", now - 1000, now + 2 * 3_600_000);
    });
    const v = await asMember(t, { role: "viewer", orgId });
    const labels = async (args: object) =>
      (await v.as.query(api.enrollmentCodes.list, { ...page(), nowMs: now, ...args })).page.map((r) => r.label);
    expect(await labels({})).toEqual(["c", "b", "a"]);
    expect(await labels(asc("expires"))).toEqual(["b", "c", "a"]);
    expect(await labels(desc("expires"))).toEqual(["a", "c", "b"]);
    await expectCode(v.as.query(api.enrollmentCodes.list, { ...page(), nowMs: now, ...asc("label") }), "invalid_argument");
  });
});

describe("small bounded tables: groups, members, invites, file types", () => {
  test("groups:page sorts, searches and pages in the query with an exact total; counts for the page only", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    await group(t, orgId, "sales", 3);
    await group(t, orgId, "Ops", 1);
    await group(t, orgId, "Front", 2);
    await group(t, await makeOrg(t, "Other"), "Sales");
    const v = await asMember(t, { role: "viewer", orgId });
    const p1 = await v.as.query(api.groups.page, page(2));
    expect(p1.page.map((g) => g.name)).toEqual(["Front", "Ops"]);
    expect(p1).toMatchObject({ total: 3, isDone: false });
    const p2 = await v.as.query(api.groups.page, page(2, p1.continueCursor));
    expect(p2.page.map((g) => g.name)).toEqual(["sales"]);
    expect(p2.isDone).toBe(true);
    expect((await v.as.query(api.groups.page, { ...page(), ...desc("created") })).page.map((g) => g.name)).toEqual(["sales", "Front", "Ops"]);
    const found = await v.as.query(api.groups.page, { ...page(), search: "SAL" });
    expect(found.page.map((g) => g.name)).toEqual(["sales"]);
    expect(found.total).toBe(1);
    expect(found.page[0]).toMatchObject({ devices: { count: 0, more: false } });
    await expectCode(v.as.query(api.groups.page, { ...page(), ...asc("devices") }), "invalid_argument");
    await expectCode(v.as.query(api.groups.page, page(10, "not-a-cursor")), "invalid_argument");
    await expectCode(v.as.query(api.groups.page, page(51)), "invalid_argument");
  });

  test("members:page and members:invitesPage", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const owner = await asMember(t, { role: "owner", orgId, email: "zoe@acme.test" });
    await asMember(t, { role: "viewer", orgId, email: "amy@acme.test" });
    await asMember(t, { role: "admin", orgId, email: "bob@acme.test", status: "disabled" });
    await asMember(t, { role: "owner", orgId: await makeOrg(t, "Other"), email: "eve@other.test" });
    const now = Date.now();
    await t.run(async (ctx) => {
      const invite = (email: string, expiresAt: number, usedAt?: number) =>
        ctx.db.insert("invites", { orgId, email, role: "viewer", kind: "join", tokenHash: email.padEnd(64, "0"), expiresAt, usedAt });
      await invite("kim@acme.test", now + 3_600_000);
      await invite("al@acme.test", now + 7_200_000);
      await invite("old@acme.test", now - MINUTE_MS * 5);
      await invite("used@acme.test", now + 3_600_000, now);
    });
    const emails = async (args: object) => (await owner.as.query(api.members.page, { ...page(), ...args })).page.map((m) => m.email);
    expect(await emails({})).toEqual(["amy@acme.test", "bob@acme.test", "zoe@acme.test"]);
    expect(await emails(asc("role"))).toEqual(["zoe@acme.test", "bob@acme.test", "amy@acme.test"]);
    expect((await emails(desc("status")))[0]).toBe("bob@acme.test"); // "disabled" > "active"
    expect(await emails({ search: "ZO" })).toEqual(["zoe@acme.test"]);
    expect((await owner.as.query(api.members.page, page(1))).total).toBe(3);
    const inv = await owner.as.query(api.members.invitesPage, { ...page(), nowMs: now });
    expect(inv.page.map((i) => i.email)).toEqual(["al@acme.test", "kim@acme.test"]);
    expect(inv.total).toBe(2);
    const byEmail = await owner.as.query(api.members.invitesPage, { ...page(), nowMs: now, ...asc("email") });
    expect(byEmail.page.map((i) => i.email)).toEqual(["al@acme.test", "kim@acme.test"]);
    const byExpiry = await owner.as.query(api.members.invitesPage, { ...page(), nowMs: now, ...asc("expires") });
    expect(byExpiry.page.map((i) => i.email)).toEqual(["kim@acme.test", "al@acme.test"]);
    await expectCode(owner.as.query(api.members.page, { ...page(), ...asc("name") }), "invalid_argument");
    await expectCode(owner.as.query(api.members.invitesPage, { ...page(), nowMs: -1 }), "invalid_argument");
  });

  test("fileHandlers:page: extension or program, search on both", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const program = (name: string) =>
      t.run((ctx) =>
        ctx.db.insert("apps", {
          orgId,
          name,
          kind: "desktop",
          desktop: { source: "preinstalled", exe: "{ProgramFiles}\\X\\x.exe", args: [], fileArgTemplate: ["{file}"], resetFolders: [] },
          archived: false,
          revision: 0,
          createdAt: 0,
        }),
      );
    const reader = await program("Reader");
    const editor = await program("Editor");
    await t.run(async (ctx) => {
      await ctx.db.insert("fileHandlers", { orgId, extension: ".pdf", appId: reader });
      await ctx.db.insert("fileHandlers", { orgId, extension: ".txt", appId: editor });
      await ctx.db.insert("fileHandlers", { orgId, extension: ".doc", appId: editor });
    });
    const v = await asMember(t, { role: "viewer", orgId });
    const exts = async (args: object) => (await v.as.query(api.fileHandlers.page, { ...page(), ...args })).page.map((r) => r.extension);
    expect(await exts({})).toEqual([".doc", ".pdf", ".txt"]);
    expect(await exts(desc("extension"))).toEqual([".txt", ".pdf", ".doc"]);
    expect(await exts(desc("app"))).toEqual([".pdf", ".txt", ".doc"]);
    expect(await exts({ search: "read" })).toEqual([".pdf"]);
    expect(await exts({ search: "TX" })).toEqual([".txt"]);
    expect((await v.as.query(api.fileHandlers.page, page(1))).total).toBe(3);
  });
});

describe("install lists: 'updated' either way", () => {
  test("apps:installs, fleet:installs and overview:failedInstallsPage", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t, "Acme", { plan: "custom" });
    const g = await group(t, orgId, "Floor");
    const [d1, d2] = await devices(t, orgId, ["PC1", "PC2"], g);
    const appId = await webApp(t, orgId, "Docs");
    await t.run(async (ctx) => {
      await ctx.db.insert("appAssignments", { orgId, groupId: g, appId, audience: "everyone", pinnedTaskbar: false, pinnedDesktop: false });
      await ctx.db.insert("installResults", { orgId, deviceId: d1!, appId, groupId: g, state: "failed", appRevision: 0, attempts: 1, updatedAt: 1000 });
      await ctx.db.insert("installResults", { orgId, deviceId: d2!, appId, groupId: g, state: "failed", appRevision: 0, attempts: 1, updatedAt: 2000 });
    });
    const v = await asMember(t, { role: "viewer", orgId });
    const byApp = async (args: object) =>
      (await v.as.query(api.apps.installs, { appId, state: "failed", ...page(), ...args })).page.map((r) => r.deviceName);
    expect(await byApp({})).toEqual(["PC2", "PC1"]);
    expect(await byApp(asc("updated"))).toEqual(["PC1", "PC2"]);
    const byDevice = await v.as.query(api.fleet.installs, { deviceId: d1!, ...page(), ...asc("updated") });
    expect(byDevice.page.map((r) => r.appName)).toEqual(["Docs"]);
    const failed = async (args: object) => (await v.as.query(api.overview.failedInstallsPage, { ...page(), ...args })).page.map((r) => r.deviceName);
    expect(await failed({})).toEqual(["PC2", "PC1"]);
    expect(await failed(asc("updated"))).toEqual(["PC1", "PC2"]);
    await expectCode(v.as.query(api.apps.installs, { appId, state: "failed", ...page(), ...asc("device") }), "invalid_argument");
    await expectCode(v.as.query(api.overview.failedInstallsPage, page(51)), "invalid_argument");

    // Another organization sees none of it.
    const foreign = await asMember(t, { role: "owner", orgId: await makeOrg(t, "Other") });
    expect((await foreign.as.query(api.overview.failedInstallsPage, page())).page).toEqual([]);
    expect((await foreign.as.query(api.groups.page, page())).total).toBe(0);
    expect((await foreign.as.query(api.fileHandlers.page, page())).total).toBe(0);
    expect((await foreign.as.query(api.members.page, page())).page.map((m) => m.email)).toEqual([foreign.email]);
    expect((await foreign.as.query(api.fleet.list, { ...page(), ...asc("name") })).page).toEqual([]);
    expect((await foreign.as.query(api.apps.list, { ...page(), archived: false, ...asc("name") })).page).toEqual([]);
    expect((await foreign.as.query(api.employees.list, { ...page(), ...asc("name") })).page).toEqual([]);
    expect(await foreign.as.query(api.apps.count, { archived: false })).toEqual({ total: 0 });
    expect(await foreign.as.query(api.employees.count, {})).toEqual({ total: 0 });
  });
});
