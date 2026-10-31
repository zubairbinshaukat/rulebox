import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { setupAuth } from "../tests/convex/auth";
import { enrollDevice, probe } from "../tests/convex/devices";
import { asMember, codeOf, expectCode, expectNoSecrets, giveStepUp, makeOrg, type T } from "../tests/convex/identity";
import { setSeeds, TEST_KEY, TEST_SEED_B64 } from "../tests/convex/keys";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { hashSecret, verifySecret } from "./lib/argon";
import { auditPolicy } from "./lib/audit";
import { assertEmployeePassword, checkedUsername, normalizeEmployeeName } from "./lib/employeeRules";
import { MAX_EMPLOYEE_GROUPS, MAX_GROUP_EMPLOYEES, MINUTE_MS } from "./lib/limits";
import { rateLimiter } from "./lib/rateLimits";
import { rosterEntryMessage } from "./lib/roster";
import { verifyPayload } from "./lib/signing";
import { DEFAULT_WEB_PERMISSIONS } from "./lib/validators";

// Employees (plan Step 11; 4.12; A6/A7). The password is hashed in an action
// and never leaves the server; who may sign in on a group's PCs is the signed
// roster, not the device documents.

// The real hash, observed: a bad request must never reach it.
vi.mock("./lib/argon", async (importOriginal) => {
  const real = await importOriginal<typeof import("./lib/argon")>();
  return { ...real, hashSecret: vi.fn(real.hashSecret) };
});

beforeEach(() => {
  auditPolicy.strict = true;
});
afterEach(() => {
  auditPolicy.strict = false;
  setSeeds(TEST_SEED_B64);
  vi.useRealTimers();
});

async function admin(t: T, orgId: Id<"organizations">, stepUp: "fresh" | "stale" = "fresh") {
  const m = await asMember(t, { role: "admin", mfa: true, orgId });
  if (stepUp === "fresh") await giveStepUp(t, m);
  else await giveStepUp(t, m, { verifiedAgoMs: 6 * MINUTE_MS, activeAgoMs: 0 });
  return m;
}

type Admin = Awaited<ReturnType<typeof admin>>;

const PASSWORD = "correct horse battery";

async function group(t: T, orgId: Id<"organizations">, name = "Sales") {
  return await t.run((ctx) => ctx.db.insert("groups", { orgId, name, revision: 0, createdAt: Date.now() }));
}

async function webApp(t: T, orgId: Id<"organizations">, name = "Docs", archived = false) {
  return await t.run((ctx) =>
    ctx.db.insert("apps", {
      orgId,
      name,
      kind: "web",
      web: { url: "https://docs.example.com", allowedDomains: ["docs.example.com"], permissions: DEFAULT_WEB_PERMISSIONS },
      archived,
      revision: 0,
      createdAt: Date.now(),
    }),
  );
}

let n = 0;
function newEmployee(a: Admin, over: Partial<{ name: string; username: string; quotaGb: number; groupIds: string[]; appIds: string[]; password: string }> = {}) {
  n++;
  return a.as.action(api.employees.create, { name: `Person ${n}`, username: `person${n}`, groupIds: [], ...over });
}

async function row(t: T, id: Id<"employees">) {
  return (await t.run((ctx) => ctx.db.get(id)))!;
}
async function stats(t: T, orgId: Id<"organizations">) {
  return (await t.run((ctx) => ctx.db.query("orgStats").withIndex("by_org", (q) => q.eq("orgId", orgId)).unique()))!;
}
async function queueOf(t: T, orgId: Id<"organizations">) {
  return await t.run((ctx) => ctx.db.query("publishQueue").withIndex("by_org", (q) => q.eq("orgId", orgId)).unique());
}
async function auditRows(t: T, orgId: Id<"organizations">) {
  return await t.run((ctx) => ctx.db.query("auditLog").withIndex("by_org_at", (q) => q.eq("orgId", orgId)).take(200));
}
async function actions(t: T, orgId: Id<"organizations">) {
  return (await auditRows(t, orgId)).map((r) => r.action);
}
async function secretOf(t: T, employeeId: Id<"employees">) {
  return await t.run((ctx) => ctx.db.query("employeeSecrets").withIndex("by_employee", (q) => q.eq("employeeId", employeeId)).unique());
}
async function memberships(t: T, employeeId: Id<"employees">) {
  return await t.run((ctx) => ctx.db.query("groupMembers").withIndex("by_employee", (q) => q.eq("employeeId", employeeId)).take(500));
}
async function grants(t: T, employeeId: Id<"employees">) {
  return await t.run((ctx) => ctx.db.query("employeeApps").withIndex("by_employee", (q) => q.eq("employeeId", employeeId)).take(500));
}
async function rosterOf(t: T, groupId: Id<"groups">) {
  return await t.run(async (ctx) => ({
    head: await ctx.db.query("groupRoster").withIndex("by_group", (q) => q.eq("groupId", groupId)).unique(),
    entries: await ctx.db.query("rosterEntries").withIndex("by_group_epoch", (q) => q.eq("groupId", groupId)).take(500),
  }));
}
/** Does the entry verify with the organization's (test) key, over the exact message the agent rebuilds? */
function entryVerifies(orgId: Id<"organizations">, e: Doc<"rosterEntries">): boolean {
  const message = rosterEntryMessage({
    keyId: e.keyId,
    orgId,
    groupId: e.groupId,
    epoch: e.epoch,
    employeeId: e.employeeId,
    credentialRevision: e.credentialRevision ?? null,
  });
  return e.keyId === TEST_KEY.keyId && verifyPayload(message, e.signature, TEST_KEY.publicKey);
}
async function bodiesOf(t: T, orgId: Id<"organizations">) {
  return await t.run((ctx) => ctx.db.query("desiredBodies").take(500).then((rows) => rows.filter((r) => r.orgId === orgId)));
}
async function setLockout(t: T, orgId: Id<"organizations">, employeeId: Id<"employees">, lockedUntil: number, failures = 10) {
  await t.run((ctx) => ctx.db.insert("employeeLockouts", { employeeId, orgId, failures, lastFailureAt: Date.now(), lockedUntil }));
}

describe("rules", () => {
  test("usernames are trimmed and lower-cased; names are trimmed; passwords 8-256 and not the username", () => {
    expect(checkedUsername("  Maya.K_1-x ")).toBe("maya.k_1-x");
    for (const bad of ["", "   ", "has space", "x".repeat(65), "ünï", "a/b", "a@b"]) {
      expect(() => checkedUsername(bad), bad).toThrow();
    }
    expect(checkedUsername("x".repeat(64))).toHaveLength(64);
    expect(normalizeEmployeeName("  Maya Lee ")).toBe("Maya Lee");
    for (const bad of ["", "  ", "x".repeat(101), "bad\nname", "bad‮name"]) expect(() => normalizeEmployeeName(bad), JSON.stringify(bad)).toThrow();
    expect(() => assertEmployeePassword("1234567", "maya")).toThrow(); // 7
    expect(() => assertEmployeePassword("12345678", "maya")).not.toThrow(); // 8
    expect(() => assertEmployeePassword("x".repeat(256), "maya")).not.toThrow();
    expect(() => assertEmployeePassword("x".repeat(257), "maya")).toThrow();
    expect(() => assertEmployeePassword("  MAYA.LEE  ", "maya.lee")).toThrow(); // the username, however it is written
  });
});

describe("employees: create", () => {
  test("username normalization and uniqueness (Maya vs maya), counters, audit; no password = revision 0", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const a = await admin(t, orgId);
    const id = await newEmployee(a, { name: "  Maya Lee ", username: "  Maya.Lee ", quotaGb: 25 });
    expect(await row(t, id)).toMatchObject({
      name: "Maya Lee",
      username: "maya.lee",
      searchText: "maya lee maya.lee",
      quotaGb: 25,
      disabled: false,
      credentialRevision: 0,
      revision: 0,
    });
    expect((await row(t, id)).passwordSetAt).toBeUndefined();
    expect(await secretOf(t, id)).toBeNull();
    expect(await stats(t, orgId)).toMatchObject({ employeeCount: 1, activeEmployeeCount: 1 });

    await expectCode(newEmployee(a, { username: "maya.lee" }), "conflict");
    await expectCode(newEmployee(a, { username: "MAYA.LEE" }), "conflict");
    await expectCode(newEmployee(a, { username: "bad name" }), "invalid_argument");
    await expectCode(newEmployee(a, { name: "" }), "invalid_argument");
    await expectCode(newEmployee(a, { quotaGb: -1 }), "invalid_argument");
    await expectCode(newEmployee(a, { quotaGb: 2001 }), "invalid_argument");
    await expectCode(newEmployee(a, { quotaGb: 1.5 }), "invalid_argument");
    expect((await stats(t, orgId)).employeeCount).toBe(1);
    expect(await actions(t, orgId)).toEqual(["employee.created"]);
  });

  test("the same username is free in another organization", async () => {
    const t = await setupAuth();
    const a = await admin(t, await makeOrg(t, "A"));
    const b = await admin(t, await makeOrg(t, "B"));
    await newEmployee(a, { username: "maya" });
    await newEmployee(b, { username: "maya" });
  });

  test("a password is hashed (Argon2id) and verifies; the hash and password are returned and audited nowhere", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const a = await admin(t, orgId);
    const g = await group(t, orgId);
    const id = await newEmployee(a, { name: "Maya", username: "maya", groupIds: [g], password: PASSWORD });
    const secret = (await secretOf(t, id))!;
    expect(secret.passwordHash.startsWith("$argon2id$v=19$m=19456,t=2,p=1$")).toBe(true);
    expect(await verifySecret(PASSWORD, secret.passwordHash)).toBe(true);
    expect(await verifySecret("wrong password", secret.passwordHash)).toBe(false);
    expect(await row(t, id)).toMatchObject({ credentialRevision: 1 });
    expect((await row(t, id)).passwordSetAt).toBeGreaterThan(0);

    const get = await a.as.query(api.employees.get, { employeeId: id });
    expect(get).toMatchObject({ passwordSet: true, name: "Maya", username: "maya" });
    const list = await a.as.query(api.employees.list, { paginationOpts: { numItems: 10, cursor: null } });
    const search = await a.as.query(api.employees.search, { text: "maya" });
    const secrets = [PASSWORD, secret.passwordHash, secret.passwordHash.split("$").pop()!];
    for (const value of [get, list, search]) expectNoSecrets(value, secrets);
    expect(JSON.stringify(await auditRows(t, orgId))).not.toContain(PASSWORD);
    expect(JSON.stringify(await auditRows(t, orgId))).not.toContain("argon2");
    expect(JSON.stringify(await t.run((ctx) => ctx.db.query("rosterEntries").take(50)))).not.toContain(secret.passwordHash);
  });

  test("password rules on create: 7 characters, the username, and 257 characters are refused; nothing is stored", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const a = await admin(t, orgId);
    for (const password of ["1234567", "x".repeat(257)]) {
      const e = await newEmployee(a, { username: "maya", password }).catch((x: unknown) => x);
      expect(codeOf(e)).toBe("invalid_argument");
      expect((e as { data: { field: string } }).data.field).toBe("password");
    }
    await expectCode(newEmployee(a, { username: "Maya", password: "MAYA" }), "invalid_argument"); // equals the (normalized) username
    expect((await stats(t, orgId)).employeeCount ?? 0).toBe(0);
    expect(await t.run((ctx) => ctx.db.query("employeeSecrets").take(5))).toEqual([]);
    // 8 characters is enough
    const id = await newEmployee(a, { username: "maya", password: "12345678" });
    expect((await secretOf(t, id))?.passwordHash).toBeDefined();
  });

  test("starting groups and apps: memberships, grants, one signed roster entry per group, a publish for the groups", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const a = await admin(t, orgId);
    const g1 = await group(t, orgId, "Sales");
    const g2 = await group(t, orgId, "Ops");
    const app = await webApp(t, orgId);
    const id = await newEmployee(a, { groupIds: [g1, g2, g1], appIds: [app] }); // a repeated id counts once
    expect((await memberships(t, id)).map((m) => m.groupId).sort()).toEqual([g1, g2].sort());
    expect((await grants(t, id)).map((x) => x.appId)).toEqual([app]);
    for (const g of [g1, g2]) {
      const r = await rosterOf(t, g);
      expect(r.head).toMatchObject({ epoch: 1 });
      expect(r.entries).toHaveLength(1);
      expect(r.entries[0]).toMatchObject({ employeeId: id, credentialRevision: 0, epoch: 1 });
      expect(entryVerifies(orgId, r.entries[0]!)).toBe(true);
    }
    expect((await queueOf(t, orgId))?.groupIds.slice().sort()).toEqual([g1, g2].sort());
  });

  test("a foreign group or app is not_found; an archived app is refused; too many apps is too_large", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const other = await makeOrg(t, "Other");
    const a = await admin(t, orgId);
    const foreignGroup = await group(t, other);
    const foreignApp = await webApp(t, other);
    const archived = await webApp(t, orgId, "Old", true);
    await expectCode(newEmployee(a, { groupIds: [foreignGroup] }), "not_found");
    await expectCode(newEmployee(a, { appIds: [foreignApp] }), "not_found");
    await expectCode(newEmployee(a, { groupIds: ["nonsense"] }), "not_found");
    await expectCode(newEmployee(a, { appIds: [archived] }), "invalid_argument");
    expect((await stats(t, orgId)).employeeCount ?? 0).toBe(0);
  });

  test("the plan limit: the 26th employee of a free organization is refused with plan_limit", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t, "Free", { plan: "free" });
    const a = await admin(t, orgId);
    await t.run(async (ctx) => {
      const s = (await ctx.db.query("orgStats").withIndex("by_org", (q) => q.eq("orgId", orgId)).unique())!;
      await ctx.db.patch(s._id, { employeeCount: 24, activeEmployeeCount: 24 });
    });
    await newEmployee(a); // the 25th
    expect((await stats(t, orgId)).employeeCount).toBe(25);
    const e = await newEmployee(a).catch((x: unknown) => x);
    expect(codeOf(e)).toBe("plan_limit");
    expect((e as { data: { detail: string } }).data.detail).toBe("employees");
    expect((await stats(t, orgId)).employeeCount).toBe(25);
    // a suspended organization cannot add anyone
    await t.run(async (ctx) => {
      const p = (await ctx.db.query("orgPlans").withIndex("by_org", (q) => q.eq("orgId", orgId)).unique())!;
      await ctx.db.patch(p._id, { status: "suspended" });
    });
    await expectCode(newEmployee(a), "plan_limit");
  });

  test("without a signing key an employee can be added with no group, but a group's roster cannot be signed (not_ready)", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t, "NoKey", { noKey: true });
    const a = await admin(t, orgId);
    const g = await group(t, orgId);
    const id = await newEmployee(a);
    const e = await newEmployee(a, { groupIds: [g] }).catch((x: unknown) => x);
    expect(codeOf(e)).toBe("not_ready");
    expect((e as { data: { detail: string } }).data.detail).toBe("signing key");
    await expectCode(a.as.mutation(api.employees.setGroups, { employeeId: id, expectedRevision: 0, groupIds: [g] }), "not_ready");
    // the refused call wrote nothing: not the membership, not the counter, not the revision
    expect(await memberships(t, id)).toEqual([]);
    expect((await stats(t, orgId)).employeeCount).toBe(1);
    expect((await row(t, id)).revision).toBe(0);
    // an env seed that is not the organization's registered key is refused the same way
    const okOrg = await makeOrg(t, "Key");
    const b = await admin(t, okOrg);
    const g2 = await group(t, okOrg);
    setSeeds("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");
    await expectCode(newEmployee(b, { groupIds: [g2] }), "not_ready");
  });
});

describe("employees: update, credential revision", () => {
  test("credentialRevision bumps on password set and on a new username, not on a name or quota change", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const a = await admin(t, orgId);
    const g = await group(t, orgId);
    const id = await newEmployee(a, { name: "Maya", username: "maya", groupIds: [g] });
    expect((await row(t, id)).credentialRevision).toBe(0);

    expect(await a.as.mutation(api.employees.update, { employeeId: id, expectedRevision: 0, name: "Maya L", username: "maya", quotaGb: 5 })).toEqual({ revision: 1 });
    expect(await row(t, id)).toMatchObject({ name: "Maya L", quotaGb: 5, credentialRevision: 0, searchText: "maya l maya" });
    expect((await rosterOf(t, g)).entries).toHaveLength(1); // no new roster entry

    expect(await a.as.mutation(api.employees.update, { employeeId: id, expectedRevision: 1, name: "Maya L", username: " MAYA2 ", quotaGb: 5 })).toEqual({ revision: 2 });
    expect(await row(t, id)).toMatchObject({ username: "maya2", credentialRevision: 1, searchText: "maya l maya2" });
    const afterRename = await rosterOf(t, g);
    expect(afterRename.entries.map((e) => [e.epoch, e.credentialRevision])).toEqual([[1, 0], [2, 1]]);
    expect(afterRename.entries.every((e) => entryVerifies(orgId, e))).toBe(true);

    await a.as.action(api.employees.setPassword, { employeeId: id, password: PASSWORD });
    expect(await row(t, id)).toMatchObject({ credentialRevision: 2 });
    await a.as.action(api.employees.setPassword, { employeeId: id, password: "another password" });
    expect(await row(t, id)).toMatchObject({ credentialRevision: 3 });
    const entries = (await rosterOf(t, g)).entries;
    expect(entries.map((e) => [e.epoch, e.credentialRevision])).toEqual([[1, 0], [2, 1], [3, 2], [4, 3]]);
    expect(entries.every((e) => entryVerifies(orgId, e))).toBe(true);
    // the stored hash is the newest one only
    expect(await verifySecret("another password", (await secretOf(t, id))!.passwordHash)).toBe(true);
    expect(await verifySecret(PASSWORD, (await secretOf(t, id))!.passwordHash)).toBe(false);
    expect(await actions(t, orgId)).toEqual(["employee.created", "employee.updated", "employee.updated", "employee.passwordSet", "employee.passwordSet"]);
  });

  test("a username already taken is a conflict; the same values again write nothing; a stale revision is refused", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const a = await admin(t, orgId);
    const id = await newEmployee(a, { name: "Maya", username: "maya" });
    await newEmployee(a, { name: "Noor", username: "noor" });
    await expectCode(a.as.mutation(api.employees.update, { employeeId: id, expectedRevision: 0, name: "Maya", username: "NOOR" }), "conflict");
    const { result, io } = await probe(() => a.as.mutation(api.employees.update, { employeeId: id, expectedRevision: 0, name: "Maya", username: "Maya" }));
    expect(result).toEqual({ revision: 0 });
    expect(io.writes).toBe(0);
    await a.as.mutation(api.employees.update, { employeeId: id, expectedRevision: 0, name: "Maya", username: "maya", quotaGb: 0 }); // 0 = unlimited
    expect((await row(t, id)).quotaGb).toBe(0);
    await expectCode(a.as.mutation(api.employees.update, { employeeId: id, expectedRevision: 0, name: "Maya 2", username: "maya" }), "stale_edit");
    // quota back to the organization default
    await a.as.mutation(api.employees.update, { employeeId: id, expectedRevision: 1, name: "Maya", username: "maya" });
    expect((await row(t, id)).quotaGb).toBeUndefined();
  });

  test("setPassword: 8-256 characters, not the username; a rename between hashing and storing is stale", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const a = await admin(t, orgId);
    const id = await newEmployee(a, { username: "maya" });
    for (const password of ["1234567", "x".repeat(257), "maya", "MAYA"]) {
      await expectCode(a.as.action(api.employees.setPassword, { employeeId: id, password }), "invalid_argument");
    }
    expect(await secretOf(t, id)).toBeNull();
    expect((await row(t, id)).credentialRevision).toBe(0);
    await a.as.action(api.employees.setPassword, { employeeId: id, password: "12345678" });
    expect((await row(t, id)).passwordSetAt).toBeGreaterThan(0);
    // the password check used the username "maya": storing it for a renamed employee is refused
    await t.run((ctx) => ctx.db.patch(id, { username: "maya.new" }));
    await expectCode(
      t.mutation(internal.employees.storePassword, {
        orgId,
        actor: { type: "member", id: "m", label: "m@acme.test" },
        employeeId: id,
        username: "maya",
        phc: "$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      }),
      "stale_edit",
    );
  });

  test("employeeWrites (300 per hour per organization) limits setPassword and EVERY create, consumed after the cheap checks", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const a = await admin(t, orgId);
    const id = await newEmployee(a, { username: "maya" });
    await t.run((ctx) => rateLimiter.limit(ctx, "employeeWrites", { key: orgId, count: 299 })); // the create above took one
    // refused by the rule before it costs a token or a hash
    await expectCode(a.as.action(api.employees.setPassword, { employeeId: id, password: "short" }), "invalid_argument");
    await expectCode(a.as.action(api.employees.setPassword, { employeeId: id, password: PASSWORD }), "rate_limited");
    await expectCode(newEmployee(a, { password: PASSWORD }), "rate_limited");
    // a create without a password hashes nothing but is limited too
    await expectCode(newEmployee(a), "rate_limited");
    expect(await secretOf(t, id)).toBeNull();
    // another organization has its own bucket
    const b = await admin(t, await makeOrg(t, "B"));
    const other = await newEmployee(b, { username: "maya" });
    await b.as.action(api.employees.setPassword, { employeeId: other, password: PASSWORD });
  });
});

describe("employees: groups and the signed roster", () => {
  test("setGroups: one signed entry per group that is joined or left; no document is republished", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const a = await admin(t, orgId);
    const g1 = await group(t, orgId, "Sales");
    const g2 = await group(t, orgId, "Ops");
    const id = await newEmployee(a, { groupIds: [g1] });
    expect((await rosterOf(t, g1)).head?.epoch).toBe(1);

    expect(await a.as.mutation(api.employees.setGroups, { employeeId: id, expectedRevision: 0, groupIds: [g1, g2] })).toEqual({ revision: 1 });
    expect((await rosterOf(t, g1)).head?.epoch).toBe(1); // unchanged group: no entry
    expect((await rosterOf(t, g2)).entries.map((e) => [e.epoch, e.credentialRevision])).toEqual([[1, 0]]);

    expect(await a.as.mutation(api.employees.setGroups, { employeeId: id, expectedRevision: 1, groupIds: [g2] })).toEqual({ revision: 2 });
    const left = await rosterOf(t, g1);
    expect(left.head?.epoch).toBe(2);
    expect(left.entries[1]).toMatchObject({ employeeId: id, epoch: 2 });
    expect(left.entries[1]!.credentialRevision).toBeUndefined(); // removed
    expect(left.entries.every((e) => entryVerifies(orgId, e))).toBe(true);
    expect((await memberships(t, id)).map((m) => m.groupId)).toEqual([g2]);

    // no grants: nothing about the employee is in any document, so nothing is republished
    expect(await queueOf(t, orgId)).toBeNull();
    expect(await actions(t, orgId)).toEqual(["employee.created", "employee.groupsChanged", "employee.groupsChanged"]);

    await expectCode(a.as.mutation(api.employees.setGroups, { employeeId: id, expectedRevision: 0, groupIds: [] }), "stale_edit");
    await expectCode(a.as.mutation(api.employees.setGroups, { employeeId: id, expectedRevision: 2, groupIds: [await group(t, (await makeOrg(t, "X")))] }), "not_found");
  });

  test("the same groups again write nothing", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const a = await admin(t, orgId);
    const g = await group(t, orgId);
    const id = await newEmployee(a, { groupIds: [g] });
    const { result, io } = await probe(() => a.as.mutation(api.employees.setGroups, { employeeId: id, expectedRevision: 0, groupIds: [g, g] }));
    expect(result).toEqual({ revision: 0 });
    expect(io.writes).toBe(0);
    expect((await rosterOf(t, g)).head?.epoch).toBe(1);
  });

  test("a disabled employee's group changes write no entry (they are not in the roster); enabling writes them", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const a = await admin(t, orgId);
    const g1 = await group(t, orgId, "Sales");
    const g2 = await group(t, orgId, "Ops");
    const id = await newEmployee(a, { groupIds: [g1] });
    await a.as.mutation(api.employees.setDisabled, { employeeId: id, disabled: true });
    expect((await rosterOf(t, g1)).head?.epoch).toBe(2);
    await a.as.mutation(api.employees.setGroups, { employeeId: id, expectedRevision: 0, groupIds: [g2] });
    expect((await rosterOf(t, g1)).head?.epoch).toBe(2); // not a second "removed"
    expect((await rosterOf(t, g2)).head ?? null).toBeNull(); // not added
    await a.as.mutation(api.employees.setDisabled, { employeeId: id, disabled: false });
    expect((await rosterOf(t, g2)).entries.map((e) => e.credentialRevision)).toEqual([0]);
    expect((await rosterOf(t, g1)).head?.epoch).toBe(2);
  });

  test("groups:addEmployee / removeEmployee: idempotent, one entry, revision bump, audit; foreign ids are not_found", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const a = await admin(t, orgId);
    const g = await group(t, orgId, "Sales");
    const id = await newEmployee(a);
    await a.as.mutation(api.groups.addEmployee, { groupId: g, employeeId: id });
    await a.as.mutation(api.groups.addEmployee, { groupId: g, employeeId: id });
    expect((await memberships(t, id))).toHaveLength(1);
    expect((await rosterOf(t, g)).entries).toHaveLength(1);
    expect((await row(t, id)).revision).toBe(1);
    expect((await a.as.query(api.groups.get, { groupId: g })).group.employees).toEqual({ count: 1, more: false });

    await a.as.mutation(api.groups.removeEmployee, { groupId: g, employeeId: id });
    await a.as.mutation(api.groups.removeEmployee, { groupId: g, employeeId: id });
    const r = await rosterOf(t, g);
    expect(r.entries.map((e) => e.credentialRevision)).toEqual([0, undefined]);
    expect(r.entries.every((e) => entryVerifies(orgId, e))).toBe(true);
    expect((await row(t, id)).revision).toBe(2);
    expect(await actions(t, orgId)).toEqual(["employee.created", "employee.groupsChanged", "employee.groupsChanged"]);

    const other = await makeOrg(t, "Other");
    const foreignGroup = await group(t, other);
    await expectCode(a.as.mutation(api.groups.addEmployee, { groupId: foreignGroup, employeeId: id }), "not_found");
    const foreign = await admin(t, other);
    const foreignEmployee = await newEmployee(foreign);
    await expectCode(a.as.mutation(api.groups.addEmployee, { groupId: g, employeeId: foreignEmployee }), "not_found");
    await expectCode(a.as.mutation(api.groups.removeEmployee, { groupId: g, employeeId: foreignEmployee }), "not_found");
  });

  test("limits: an employee in 100 groups cannot join a 101st; a group of 2,000 is full", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const a = await admin(t, orgId);
    const id = await newEmployee(a);
    const g = await group(t, orgId, "Extra");
    await t.run(async (ctx) => {
      for (let i = 0; i < MAX_EMPLOYEE_GROUPS; i++) {
        const gid = await ctx.db.insert("groups", { orgId, name: `G${i}`, revision: 0, createdAt: 0 });
        await ctx.db.insert("groupMembers", { orgId, groupId: gid, employeeId: id });
      }
    });
    const e = await a.as.mutation(api.groups.addEmployee, { groupId: g, employeeId: id }).catch((x: unknown) => x);
    expect(codeOf(e)).toBe("too_large");
    const e1 = await a.as.mutation(api.employees.setGroups, { employeeId: id, expectedRevision: 0, groupIds: [g] }).catch((x: unknown) => x);
    expect(e1).toEqual({ revision: 1 }); // swapping 100 groups for 1 is fine: the limit is on the resulting list

    const full = await group(t, orgId, "Full");
    await t.run(async (ctx) => {
      const s = (await ctx.db.query("orgStats").withIndex("by_org", (q) => q.eq("orgId", orgId)).unique())!;
      await ctx.db.patch(s._id, { employeeCount: MAX_GROUP_EMPLOYEES });
      for (let i = 0; i < MAX_GROUP_EMPLOYEES; i++) {
        const other = await ctx.db.insert("employees", { orgId, name: `P${i}`, username: `p${i}`, searchText: `p${i}`, disabled: false, credentialRevision: 0, revision: 0, createdAt: i });
        await ctx.db.insert("groupMembers", { orgId, groupId: full, employeeId: other });
      }
    });
    const solo = await a.as.action(api.employees.create, { name: "Solo", username: "solo", groupIds: [] });
    const e2 = await a.as.mutation(api.groups.addEmployee, { groupId: full, employeeId: solo }).catch((x: unknown) => x);
    expect(codeOf(e2)).toBe("too_large");
    expect((e2 as { data: { detail: string } }).data.detail).toBe("group employees");
    const e3 = await newEmployee(a, { groupIds: [full] }).catch((x: unknown) => x);
    expect(codeOf(e3)).toBe("too_large");
  });
});

describe("employees: disable, enable, remove", () => {
  test("disabling writes one roster entry per group and no document; enabling puts them back; counters follow", async () => {
    vi.useFakeTimers();
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const a = await admin(t, orgId);
    const g1 = await group(t, orgId, "Sales");
    const g2 = await group(t, orgId, "Ops");
    await enrollDevice(t, orgId, { groupId: g1 });
    await t.finishAllScheduledFunctions(vi.runAllTimers); // the device's first signed document
    const bodies = (await bodiesOf(t, orgId)).length;
    expect(bodies).toBe(1);
    const id = await newEmployee(a, { groupIds: [g1, g2] });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await stats(t, orgId)).activeEmployeeCount).toBe(1);

    expect(await a.as.mutation(api.employees.setDisabled, { employeeId: id, disabled: true })).toBeNull();
    expect(await row(t, id)).toMatchObject({ disabled: true, revision: 0 });
    expect(await stats(t, orgId)).toMatchObject({ employeeCount: 1, activeEmployeeCount: 0 });
    for (const g of [g1, g2]) {
      const r = await rosterOf(t, g);
      expect(r.head?.epoch).toBe(2);
      expect(r.entries[1]).toMatchObject({ employeeId: id, epoch: 2 });
      expect(r.entries[1]!.credentialRevision).toBeUndefined();
      expect(entryVerifies(orgId, r.entries[1]!)).toBe(true);
    }
    // no desiredBodies row was written, nothing is queued
    expect(await queueOf(t, orgId)).toBeNull();
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await bodiesOf(t, orgId)).length).toBe(bodies);

    // the same state again: no write at all
    const { io } = await probe(() => a.as.mutation(api.employees.setDisabled, { employeeId: id, disabled: true }));
    expect(io.writes).toBe(0);

    await a.as.mutation(api.employees.setDisabled, { employeeId: id, disabled: false });
    expect(await stats(t, orgId)).toMatchObject({ employeeCount: 1, activeEmployeeCount: 1 });
    expect((await rosterOf(t, g1)).entries.map((e) => e.credentialRevision)).toEqual([0, undefined, 0]);
    expect(await actions(t, orgId)).toEqual(["device.enrolled", "employee.created", "employee.disabled", "employee.enabled"]);
  });

  test("remove: only a disabled employee; password, lockout, memberships and grants go; the audit keeps the name", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const a = await admin(t, orgId);
    const g = await group(t, orgId);
    const app = await webApp(t, orgId);
    const id = await newEmployee(a, { name: "Maya Lee", username: "maya", groupIds: [g], appIds: [app], password: PASSWORD });
    await setLockout(t, orgId, id, Date.now() + 60_000);
    expect(await stats(t, orgId)).toMatchObject({ employeeCount: 1, activeEmployeeCount: 1 });

    const e = await a.as.mutation(api.employees.remove, { employeeId: id }).catch((x: unknown) => x);
    expect(codeOf(e)).toBe("invalid_argument");
    expect((e as { data: { field: string } }).data.field).toBe("disabled");
    expect(await row(t, id)).toBeDefined();

    await a.as.mutation(api.employees.setDisabled, { employeeId: id, disabled: true });
    const epoch = (await rosterOf(t, g)).head!.epoch;
    expect(await a.as.mutation(api.employees.remove, { employeeId: id })).toBeNull();
    expect(await t.run((ctx) => ctx.db.get(id))).toBeNull();
    expect(await secretOf(t, id)).toBeNull();
    expect(await t.run((ctx) => ctx.db.query("employeeLockouts").withIndex("by_employee", (q) => q.eq("employeeId", id)).unique())).toBeNull();
    expect(await memberships(t, id)).toEqual([]);
    expect(await grants(t, id)).toEqual([]);
    expect(await stats(t, orgId)).toMatchObject({ employeeCount: 0, activeEmployeeCount: 0 });
    // already taken out of the roster when it was disabled: no second "removed"
    expect((await rosterOf(t, g)).head!.epoch).toBe(epoch);
    const deleted = (await auditRows(t, orgId)).find((r) => r.action === "employee.deleted")!;
    expect(deleted).toMatchObject({ targetId: id, targetLabel: "Maya Lee" });
    expect(deleted.summary).toContain("Maya Lee");
    await expectCode(a.as.query(api.employees.get, { employeeId: id }), "not_found");
    // the username is free again
    await newEmployee(a, { username: "maya" });
  });
});

describe("employees: direct apps and the documents", () => {
  test("setDirectApps: diff, audit, publish only on change; an archived app cannot be newly given; 50 at most", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const a = await admin(t, orgId);
    const g = await group(t, orgId);
    const docs = await webApp(t, orgId, "Docs");
    const wiki = await webApp(t, orgId, "Wiki");
    const old = await webApp(t, orgId, "Old", true);
    const id = await newEmployee(a, { groupIds: [g] });
    expect(await queueOf(t, orgId)).toBeNull();

    expect(await a.as.mutation(api.employees.setDirectApps, { employeeId: id, expectedRevision: 0, appIds: [docs, wiki] })).toEqual({ revision: 1 });
    expect((await grants(t, id)).map((x) => x.appId).sort()).toEqual([docs, wiki].sort());
    expect((await queueOf(t, orgId))?.groupIds).toEqual([g]);

    // the same set again: no write, no publish
    await t.run(async (ctx) => ctx.db.delete((await ctx.db.query("publishQueue").withIndex("by_org", (q) => q.eq("orgId", orgId)).unique())!._id));
    const { result, io } = await probe(() => a.as.mutation(api.employees.setDirectApps, { employeeId: id, expectedRevision: 1, appIds: [wiki, docs] }));
    expect(result).toEqual({ revision: 1 });
    expect(io.writes).toBe(0);
    expect(await queueOf(t, orgId)).toBeNull();

    await expectCode(a.as.mutation(api.employees.setDirectApps, { employeeId: id, expectedRevision: 1, appIds: [docs, wiki, old] }), "invalid_argument");
    // taking away the LAST grant still changes the catalogue
    await a.as.mutation(api.employees.setDirectApps, { employeeId: id, expectedRevision: 1, appIds: [] });
    expect(await grants(t, id)).toEqual([]);
    expect((await queueOf(t, orgId))?.groupIds).toEqual([g]);
    expect(await actions(t, orgId)).toEqual(["employee.created", "employee.appsChanged", "employee.appsChanged"]);

    const many = await t.run(async (ctx) => {
      const ids: Id<"apps">[] = [];
      for (let i = 0; i < 51; i++) ids.push(await ctx.db.insert("apps", { orgId, name: `A${i}`, kind: "web", archived: false, revision: 0, createdAt: i }));
      return ids;
    });
    await expectCode(a.as.mutation(api.employees.setDirectApps, { employeeId: id, expectedRevision: 2, appIds: many }), "too_large");
    await expectCode(a.as.mutation(api.employees.setDirectApps, { employeeId: id, expectedRevision: 2, appIds: [await webApp(t, await makeOrg(t, "Z"))] }), "not_found");
  });

  test("a disabled employee's grant change is not published; an enabled employee with grants is republished on a group or disable change", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const a = await admin(t, orgId);
    const g1 = await group(t, orgId, "Sales");
    const g2 = await group(t, orgId, "Ops");
    const app = await webApp(t, orgId);
    const id = await newEmployee(a, { groupIds: [g1], appIds: [app] });
    const clear = async () => t.run(async (ctx) => ctx.db.delete((await ctx.db.query("publishQueue").withIndex("by_org", (q) => q.eq("orgId", orgId)).unique())!._id));
    await clear();

    await a.as.mutation(api.groups.addEmployee, { groupId: g2, employeeId: id });
    expect((await queueOf(t, orgId))?.groupIds).toEqual([g2]);
    await clear();
    await a.as.mutation(api.employees.setDisabled, { employeeId: id, disabled: true });
    expect((await queueOf(t, orgId))?.groupIds.slice().sort()).toEqual([g1, g2].sort());
    await clear();
    await a.as.mutation(api.employees.setDirectApps, { employeeId: id, expectedRevision: 1, appIds: [] });
    expect(await queueOf(t, orgId)).toBeNull(); // disabled: in no document
  });

  test("the group's document lists the enabled employee under the app they were given; disabling takes them out; roster only for sign-in", async () => {
    vi.useFakeTimers();
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const a = await admin(t, orgId);
    const g = await group(t, orgId);
    const docs = await webApp(t, orgId, "Docs");
    const wiki = await webApp(t, orgId, "Wiki");
    await t.run((ctx) => ctx.db.insert("appAssignments", { orgId, groupId: g, appId: wiki, audience: "selected", pinnedTaskbar: false, pinnedDesktop: false }));
    const { deviceId } = await enrollDevice(t, orgId, { groupId: g });
    const drain = () => t.finishAllScheduledFunctions(vi.runAllTimers);
    await drain();
    const id = await newEmployee(a, { groupIds: [g], appIds: [docs, wiki] });
    const other = await newEmployee(a, { groupIds: [g], appIds: [wiki] });
    await drain();

    const catalog = async () => {
      const head = (await t.run((ctx) => ctx.db.query("desiredHeads").withIndex("by_device", (q) => q.eq("deviceId", deviceId)).unique()))!;
      const body = (await t.run((ctx) => ctx.db.get(head.bodyId)))!;
      const doc = (JSON.parse(body.payload) as { doc: { catalog: { id: string; audience: string; employeeIds: string[] }[]; rosterGroupId: string | null } }).doc;
      return { head, doc, text: body.payload };
    };
    let c = await catalog();
    const byId = (x: typeof c) => Object.fromEntries(x.doc.catalog.map((e) => [e.id, e]));
    expect(byId(c)[wiki]).toMatchObject({ audience: "selected", employeeIds: [id, other].sort() });
    expect(byId(c)[docs]).toMatchObject({ audience: "selected", employeeIds: [id] }); // a web app granted directly
    expect(c.doc.rosterGroupId).toBe(g);
    // the sign-in rights are not in the document
    expect(c.text).not.toContain('"employees"');
    expect(c.head.rosterGroupId).toBe(g);

    await a.as.mutation(api.employees.setDisabled, { employeeId: id, disabled: true });
    await drain();
    c = await catalog();
    expect(byId(c)[wiki]).toMatchObject({ employeeIds: [other] });
    expect(byId(c)[docs]).toBeUndefined(); // given only to the disabled employee
    expect(c.head.version).toBeGreaterThan(1);

    await a.as.mutation(api.employees.setDisabled, { employeeId: id, disabled: false });
    await drain();
    c = await catalog();
    expect(byId(c)[docs]).toMatchObject({ employeeIds: [id] });
  });
});

describe("employees: reads", () => {
  test("list: newest first in pages of at most 50 with the first five groups; a group filter; the page size is bounded", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const a = await admin(t, orgId);
    const groups: Id<"groups">[] = [];
    for (let i = 0; i < 7; i++) groups.push(await group(t, orgId, `Group ${i}`));
    await t.run(async (ctx) => {
      for (let i = 0; i < 60; i++) {
        const employeeId = await ctx.db.insert("employees", {
          orgId,
          name: `Worker ${i}`,
          username: `worker${i}`,
          searchText: `worker ${i} worker${i}`,
          disabled: i === 3,
          credentialRevision: 0,
          revision: 0,
          createdAt: i,
        });
        if (i < 3) await ctx.db.insert("groupMembers", { orgId, groupId: groups[0]!, employeeId });
        if (i === 0) for (const g of groups.slice(1)) await ctx.db.insert("groupMembers", { orgId, groupId: g, employeeId });
      }
    });
    const { result: first, io } = await probe(() => a.as.query(api.employees.list, { paginationOpts: { numItems: 50, cursor: null } }));
    expect(first.page).toHaveLength(50);
    expect(first.isDone).toBe(false);
    expect(first.page[0]!.name).toBe("Worker 59");
    expect(io.reads).toBeLessThanOrEqual(3 + 50 + 7 + 50);
    const second = await a.as.query(api.employees.list, { paginationOpts: { numItems: 50, cursor: first.continueCursor } });
    expect(second.page).toHaveLength(10);
    expect(second.isDone).toBe(true);
    const w0 = second.page.find((r) => r.name === "Worker 0")!;
    expect(w0.groups).toHaveLength(5);
    expect(w0.groups.map((g) => g.name)).toEqual(["Group 0", "Group 1", "Group 2", "Group 3", "Group 4"]);
    expect(w0.moreGroups).toBe(true);
    expect(second.page.find((r) => r.name === "Worker 3")).toMatchObject({ disabled: true, groups: [], moreGroups: false });

    const inGroup = await a.as.query(api.employees.list, { paginationOpts: { numItems: 50, cursor: null }, groupId: groups[0] });
    expect(inGroup.page.map((r) => r.name)).toEqual(["Worker 2", "Worker 1", "Worker 0"]);
    expect(inGroup.isDone).toBe(true);
    const paged = await a.as.query(api.employees.list, { paginationOpts: { numItems: 2, cursor: null }, groupId: groups[0] });
    expect(paged.page).toHaveLength(2);
    expect(paged.isDone).toBe(false);

    for (const numItems of [0, 51, 1.5]) {
      await expectCode(a.as.query(api.employees.list, { paginationOpts: { numItems, cursor: null } }), "invalid_argument");
    }
    await expectCode(a.as.query(api.employees.list, { paginationOpts: { numItems: 5, cursor: null }, groupId: "nonsense" }), "not_found");
  });

  test("search: by name or username, at most 50 rows (flagged), optionally in one group; blank text finds nothing", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const a = await admin(t, orgId);
    const g = await group(t, orgId);
    const maya = await newEmployee(a, { name: "Maya Lee", username: "maya.lee", groupIds: [g] });
    await newEmployee(a, { name: "Noor Ali", username: "noor" });
    const found = await a.as.query(api.employees.search, { text: "  MAYA " });
    expect(found.rows.map((r) => r._id)).toEqual([maya]);
    expect(found.rows[0]!.groups).toEqual([{ _id: g, name: "Sales" }]);
    expect(found.capped).toBe(false);
    expect((await a.as.query(api.employees.search, { text: "noor" })).rows).toHaveLength(1);
    expect((await a.as.query(api.employees.search, { text: "noor", groupId: g })).rows).toEqual([]); // not in the group
    expect((await a.as.query(api.employees.search, { text: "maya", groupId: g })).rows).toHaveLength(1);
    expect(await a.as.query(api.employees.search, { text: "   " })).toEqual({ rows: [], capped: false });

    await t.run(async (ctx) => {
      for (let i = 0; i < 55; i++) {
        await ctx.db.insert("employees", { orgId, name: `Seasonal ${i}`, username: `seasonal${i}`, searchText: `seasonal ${i} seasonal${i}`, disabled: false, credentialRevision: 0, revision: 0, createdAt: i });
      }
    });
    const many = await a.as.query(api.employees.search, { text: "seasonal" });
    expect(many.rows).toHaveLength(50);
    expect(many.capped).toBe(true);
  });

  test("get: the profile, groups, apps, passwordSet from passwordSetAt, the pickers; never a hash; the lockout while it holds", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const a = await admin(t, orgId);
    const g = await group(t, orgId, "Sales");
    const app = await webApp(t, orgId, "Docs");
    await webApp(t, orgId, "Hidden", true);
    const id = await newEmployee(a, { name: "Maya", username: "maya", groupIds: [g], appIds: [app] });
    const plain = await a.as.query(api.employees.get, { employeeId: id });
    expect(plain).toMatchObject({
      name: "Maya",
      username: "maya",
      disabled: false,
      revision: 0,
      passwordSet: false,
      groupIds: [g],
      appIds: [app],
      lockout: null,
      defaultQuotaGb: 10,
    });
    expect(plain.groupOptions).toEqual([{ _id: g, name: "Sales" }]);
    expect(plain.appOptions).toEqual([{ _id: app, name: "Docs", kind: "web", canOpenFiles: false }]); // archived apps are not offered
    expect(plain.passwordSetAt).toBeUndefined();

    const until = Date.now() + 15 * MINUTE_MS;
    await setLockout(t, orgId, id, until);
    expect((await a.as.query(api.employees.get, { employeeId: id })).lockout).toEqual({ failures: 10, lockedUntil: until });
    // the picker form for a new employee
    expect(await a.as.query(api.employees.options, {})).toEqual({ groupOptions: plain.groupOptions, appOptions: plain.appOptions, defaultQuotaGb: 10 });
    expectNoSecrets(await a.as.query(api.employees.get, { employeeId: id }));
  });

  test("get reads neither employeeSecrets nor orgSecrets", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const a = await admin(t, orgId);
    const id = await newEmployee(a, { password: PASSWORD });
    const { io } = await probe(() => a.as.query(api.employees.get, { employeeId: id }));
    expect(io.tables.has("employeeSecrets")).toBe(false);
    const list = await probe(() => a.as.query(api.employees.list, { paginationOpts: { numItems: 10, cursor: null } }));
    expect(list.io.tables.has("employeeSecrets")).toBe(false);
    const search = await probe(() => a.as.query(api.employees.search, { text: "person" }));
    expect(search.io.tables.has("employeeSecrets")).toBe(false);
  });
});

describe("employees: lockout", () => {
  test("unlock clears the lockout row and audits; no lockout = no write", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const a = await admin(t, orgId);
    const id = await newEmployee(a, { name: "Maya", username: "maya" });
    const { io } = await probe(() => a.as.mutation(api.employees.unlock, { employeeId: id }));
    expect(io.writes).toBe(0);
    await setLockout(t, orgId, id, Date.now() + 15 * MINUTE_MS);
    expect((await a.as.query(api.employees.get, { employeeId: id })).lockout).not.toBeNull();
    await a.as.mutation(api.employees.unlock, { employeeId: id });
    expect((await a.as.query(api.employees.get, { employeeId: id })).lockout).toBeNull();
    expect(await t.run((ctx) => ctx.db.query("employeeLockouts").withIndex("by_employee", (q) => q.eq("employeeId", id)).unique())).toBeNull();
    expect((await actions(t, orgId)).filter((x) => x === "employee.updated")).toHaveLength(1);
    // an old row (lockedUntil 0) is not a lockout
    await setLockout(t, orgId, id, 0, 3);
    expect((await a.as.query(api.employees.get, { employeeId: id })).lockout).toBeNull();
  });
});

describe("employees: authorization", () => {
  test("viewers read but cannot write; a foreign employee, group or app id is not_found", async () => {
    const t = await setupAuth();
    const orgA = await makeOrg(t, "A");
    const orgB = await makeOrg(t, "B");
    const a = await admin(t, orgA);
    const b = await admin(t, orgB);
    const viewer = await asMember(t, { role: "viewer", orgId: orgA });
    const mine = await newEmployee(a, { username: "mine" });
    const theirs = await newEmployee(b, { username: "theirs" });
    const g = await group(t, orgA);
    const theirGroup = await group(t, orgB);

    await viewer.as.query(api.employees.get, { employeeId: mine });
    expect((await viewer.as.query(api.employees.list, { paginationOpts: { numItems: 10, cursor: null } })).page.map((r) => r._id)).toEqual([mine]);
    expect((await viewer.as.query(api.employees.search, { text: "theirs" })).rows).toEqual([]);
    await expectCode(viewer.as.mutation(api.employees.setDisabled, { employeeId: mine, disabled: true }), "forbidden");
    await expectCode(viewer.as.action(api.employees.create, { name: "X", username: "x", groupIds: [] }), "forbidden");
    await expectCode(viewer.as.action(api.employees.setPassword, { employeeId: mine, password: PASSWORD }), "forbidden");
    await expectCode(viewer.as.mutation(api.groups.addEmployee, { groupId: g, employeeId: mine }), "forbidden");

    const args = { employeeId: theirs, expectedRevision: 0 };
    await expectCode(a.as.query(api.employees.get, { employeeId: theirs }), "not_found");
    await expectCode(a.as.mutation(api.employees.update, { ...args, name: "X", username: "x" }), "not_found");
    await expectCode(a.as.mutation(api.employees.setGroups, { ...args, groupIds: [] }), "not_found");
    await expectCode(a.as.mutation(api.employees.setDirectApps, { ...args, appIds: [] }), "not_found");
    await expectCode(a.as.action(api.employees.setPassword, { employeeId: theirs, password: PASSWORD }), "not_found");
    await expectCode(a.as.mutation(api.employees.setDisabled, { employeeId: theirs, disabled: true }), "not_found");
    await expectCode(a.as.mutation(api.employees.unlock, { employeeId: theirs }), "not_found");
    await expectCode(a.as.mutation(api.employees.remove, { employeeId: theirs }), "not_found");
    await expectCode(a.as.query(api.employees.list, { paginationOpts: { numItems: 5, cursor: null }, groupId: theirGroup }), "not_found");
    await expectCode(a.as.mutation(api.employees.setGroups, { employeeId: mine, expectedRevision: 0, groupIds: [theirGroup] }), "not_found");
    // the other organization's employee is untouched
    expect(await row(t, theirs)).toMatchObject({ disabled: false, revision: 0, credentialRevision: 0 });
    expect(await secretOf(t, theirs)).toBeNull();
  });

  test("step-up: writes need an unlocked session, remove a fresh one; a stale one still disables", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const fresh = await admin(t, orgId);
    const stale = await admin(t, orgId, "stale");
    const idle = await asMember(t, { role: "admin", mfa: true, orgId });
    await giveStepUp(t, idle, { verifiedAgoMs: 20 * MINUTE_MS });
    const id = await newEmployee(fresh, { username: "maya" });
    await expectCode(idle.as.mutation(api.employees.setDisabled, { employeeId: id, disabled: true }), "step_up_required");
    await expectCode(idle.as.action(api.employees.setPassword, { employeeId: id, password: PASSWORD }), "step_up_required");
    await expectCode(idle.as.action(api.employees.create, { name: "X", username: "x", groupIds: [] }), "step_up_required");
    await stale.as.mutation(api.employees.setDisabled, { employeeId: id, disabled: true });
    await expectCode(stale.as.mutation(api.employees.remove, { employeeId: id }), "step_up_required");
    await fresh.as.mutation(api.employees.remove, { employeeId: id });
  });
});

describe("employees: save (atomic form save)", () => {
  test("profile, groups and apps in one call: ONE revision bump, one roster entry per group, one audit entry per part", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const a = await admin(t, orgId);
    const g1 = await group(t, orgId, "Sales");
    const g2 = await group(t, orgId, "Ops");
    const g3 = await group(t, orgId, "Team");
    const docs = await webApp(t, orgId, "Docs");
    const id = await newEmployee(a, { name: "Maya", username: "maya", groupIds: [g1, g2], password: PASSWORD }); // credentialRevision 1
    const saved = await a.as.mutation(api.employees.save, {
      employeeId: id,
      expectedRevision: 0,
      name: "Maya Lee",
      username: "maya.lee",
      quotaGb: 5,
      groupIds: [g1, g3],
      appIds: [docs],
    });
    expect(saved).toEqual({ revision: 1 });
    expect(await row(t, id)).toMatchObject({ name: "Maya Lee", username: "maya.lee", quotaGb: 5, credentialRevision: 2, revision: 1 });
    expect((await memberships(t, id)).map((m) => m.groupId).sort()).toEqual([g1, g3].sort());
    expect((await grants(t, id)).map((x) => x.appId)).toEqual([docs]);
    // g1 stays (renamed: ONE entry), g3 joins (ONE entry), g2 is left (ONE removal)
    expect((await rosterOf(t, g1)).entries.map((e) => [e.epoch, e.credentialRevision])).toEqual([[1, 1], [2, 2]]);
    expect((await rosterOf(t, g3)).entries.map((e) => [e.epoch, e.credentialRevision])).toEqual([[1, 2]]);
    expect((await rosterOf(t, g2)).entries.map((e) => [e.epoch, e.credentialRevision])).toEqual([[1, 1], [2, undefined]]);
    for (const g of [g1, g2, g3]) expect((await rosterOf(t, g)).entries.every((e) => entryVerifies(orgId, e))).toBe(true);
    expect((await actions(t, orgId)).slice(1)).toEqual(["employee.updated", "employee.groupsChanged", "employee.appsChanged"]);
    expect((await queueOf(t, orgId))?.groupIds.slice().sort()).toEqual([g1, g2, g3].sort());
    // the same form again: nothing changes, nothing is written
    const again = await probe(() =>
      a.as.mutation(api.employees.save, { employeeId: id, expectedRevision: 1, name: "Maya Lee", username: "maya.lee", quotaGb: 5, groupIds: [g3, g1], appIds: [docs] }),
    );
    expect(again.result).toEqual({ revision: 1 });
    expect(again.io.writes).toBe(0);
  });

  test("all or nothing: a failing part leaves the profile and the revision as they were, so the retry with the same revision works", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const a = await admin(t, orgId);
    const other = await makeOrg(t, "Other");
    const g = await group(t, orgId);
    const foreignGroup = await group(t, other);
    const archived = await webApp(t, orgId, "Old", true);
    const id = await newEmployee(a, { name: "Maya", username: "maya" });
    await newEmployee(a, { name: "Noor", username: "noor" });
    const form = { employeeId: id, expectedRevision: 0, name: "Maya Lee", username: "maya.lee", quotaGb: 7, groupIds: [g], appIds: [] as string[] };
    const unchanged = async () => {
      expect(await row(t, id)).toMatchObject({ name: "Maya", username: "maya", revision: 0, credentialRevision: 0 });
      expect(await row(t, id)).not.toHaveProperty("quotaGb", 7);
      expect(await memberships(t, id)).toEqual([]);
      expect((await rosterOf(t, g)).head ?? null).toBeNull();
    };

    setSeeds(undefined); // no key: the group's roster cannot be signed
    await expectCode(a.as.mutation(api.employees.save, form), "not_ready");
    await unchanged();
    setSeeds(TEST_SEED_B64);
    await expectCode(a.as.mutation(api.employees.save, { ...form, groupIds: [foreignGroup] }), "not_found");
    await unchanged();
    await expectCode(a.as.mutation(api.employees.save, { ...form, appIds: [archived] }), "invalid_argument");
    await unchanged();
    await expectCode(a.as.mutation(api.employees.save, { ...form, username: "NOOR" }), "conflict");
    await unchanged();
    await expectCode(a.as.mutation(api.employees.save, { ...form, expectedRevision: 3 }), "stale_edit");
    await unchanged();
    // the same form, same revision, now works
    expect(await a.as.mutation(api.employees.save, form)).toEqual({ revision: 1 });
    expect(await row(t, id)).toMatchObject({ name: "Maya Lee", username: "maya.lee", quotaGb: 7, revision: 1 });
  });
});

describe("employees: review fixes", () => {
  test("groupMembers.grantsActive is true exactly while the employee is enabled and has a direct app", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const a = await admin(t, orgId);
    const g1 = await group(t, orgId, "Sales");
    const g2 = await group(t, orgId, "Ops");
    const app = await webApp(t, orgId);
    const flags = async (id: Id<"employees">) => (await memberships(t, id)).map((m) => m.grantsActive === true).sort();
    const id = await newEmployee(a, { groupIds: [g1], appIds: [app] });
    expect(await flags(id)).toEqual([true]);
    await a.as.mutation(api.groups.addEmployee, { groupId: g2, employeeId: id }); // joins with the flag
    expect(await flags(id)).toEqual([true, true]);
    await a.as.mutation(api.employees.setDisabled, { employeeId: id, disabled: true });
    expect(await flags(id)).toEqual([false, false]);
    await a.as.mutation(api.employees.setDisabled, { employeeId: id, disabled: false });
    expect(await flags(id)).toEqual([true, true]);
    await a.as.mutation(api.employees.setDirectApps, { employeeId: id, expectedRevision: 1, appIds: [] });
    expect(await flags(id)).toEqual([false, false]);
    await a.as.mutation(api.employees.setDirectApps, { employeeId: id, expectedRevision: 2, appIds: [app] });
    expect(await flags(id)).toEqual([true, true]);
    // saved through the form: a new group gets the flag too, and a disabled employee never has it
    await a.as.mutation(api.employees.save, { employeeId: id, expectedRevision: 3, name: "P", username: "p", groupIds: [g1], appIds: [app] });
    expect(await flags(id)).toEqual([true]);
    await a.as.mutation(api.employees.setDisabled, { employeeId: id, disabled: true });
    await a.as.mutation(api.employees.save, { employeeId: id, expectedRevision: 4, name: "P", username: "p", groupIds: [g1, g2], appIds: [app] });
    expect(await flags(id)).toEqual([false, false]);
    // a new employee without apps is never flagged
    expect(await flags(await newEmployee(a, { groupIds: [g1] }))).toEqual([false]);
  });

  test("a new password clears the lockout of that employee, and only theirs", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const a = await admin(t, orgId);
    const id = await newEmployee(a, { username: "maya", password: PASSWORD });
    const other = await newEmployee(a, { username: "noor", password: PASSWORD });
    await setLockout(t, orgId, id, Date.now() + 15 * MINUTE_MS);
    await setLockout(t, orgId, other, Date.now() + 15 * MINUTE_MS);
    expect((await a.as.query(api.employees.get, { employeeId: id })).lockout).not.toBeNull();
    await a.as.action(api.employees.setPassword, { employeeId: id, password: "a brand new password" });
    expect((await a.as.query(api.employees.get, { employeeId: id })).lockout).toBeNull();
    expect((await a.as.query(api.employees.get, { employeeId: other })).lockout).not.toBeNull();
    // no lockout row: setting a password still works
    await a.as.action(api.employees.setPassword, { employeeId: id, password: "yet another password" });
  });

  test("create: bad requests cost neither a rate-limit token nor a hash; every create is limited", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const other = await makeOrg(t, "Other");
    const a = await admin(t, orgId);
    const foreignGroup = await group(t, other);
    const archived = await webApp(t, orgId, "Old", true);
    await newEmployee(a, { username: "maya" }); // token 1 of 300
    await t.run((ctx) => rateLimiter.limit(ctx, "employeeWrites", { key: orgId, count: 298 })); // one token left
    vi.mocked(hashSecret).mockClear();

    const bad: [() => Promise<unknown>, string][] = [
      [() => newEmployee(a, { name: "  ", password: PASSWORD }), "invalid_argument"],
      [() => newEmployee(a, { username: "bad name", password: PASSWORD }), "invalid_argument"],
      [() => newEmployee(a, { quotaGb: 5000, password: PASSWORD }), "invalid_argument"],
      [() => newEmployee(a, { password: "short" }), "invalid_argument"],
      [() => newEmployee(a, { username: "MAYA", password: PASSWORD }), "conflict"],
      [() => newEmployee(a, { groupIds: [foreignGroup], password: PASSWORD }), "not_found"],
      [() => newEmployee(a, { appIds: [archived], password: PASSWORD }), "invalid_argument"],
    ];
    for (const [call, code] of bad) await expectCode(call(), code);
    expect(vi.mocked(hashSecret)).not.toHaveBeenCalled();

    // the one token was still there: a good request takes it and hashes once; the next is limited before any hash
    await newEmployee(a, { username: "noor", password: PASSWORD });
    expect(vi.mocked(hashSecret)).toHaveBeenCalledTimes(1);
    await expectCode(newEmployee(a, { username: "third", password: PASSWORD }), "rate_limited");
    await expectCode(newEmployee(a, { username: "fourth" }), "rate_limited"); // no password: limited too
    expect(vi.mocked(hashSecret)).toHaveBeenCalledTimes(1);
  });

  test("create: the plan limit is checked before the hash", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t, "Free", { plan: "free" });
    const a = await admin(t, orgId);
    await t.run(async (ctx) => {
      const s = (await ctx.db.query("orgStats").withIndex("by_org", (q) => q.eq("orgId", orgId)).unique())!;
      await ctx.db.patch(s._id, { employeeCount: 25, activeEmployeeCount: 25 });
    });
    vi.mocked(hashSecret).mockClear();
    await expectCode(newEmployee(a, { password: PASSWORD }), "plan_limit");
    expect(vi.mocked(hashSecret)).not.toHaveBeenCalled();
  });

  test("a stored hash must come from the app's Argon2id parameters", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const a = await admin(t, orgId);
    const id = await newEmployee(a, { username: "maya" });
    const actor = { type: "member" as const, id: "m", label: "m@acme.test" };
    const weak = "$argon2id$v=19$m=8,t=1,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    await expectCode(t.mutation(internal.employees.storePassword, { orgId, actor, employeeId: id, username: "maya", phc: weak }), "invalid_argument");
    await expectCode(t.mutation(internal.employees.storeNew, { orgId, actor, name: "X", username: "x", groupIds: [], appIds: [], phc: weak }), "invalid_argument");
  });

  test("search with a group filter looks beyond the first 51 hits; capped only when the scan or the 50 rows ran out", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const a = await admin(t, orgId);
    const g = await group(t, orgId);
    await t.run(async (ctx) => {
      for (let i = 0; i < 70; i++) {
        const employeeId = await ctx.db.insert("employees", {
          orgId,
          name: `Seasonal ${i}`,
          username: `seasonal${i}`,
          searchText: `seasonal ${i} seasonal${i}`,
          disabled: false,
          credentialRevision: 0,
          revision: 0,
          createdAt: i,
        });
        if (i % 14 === 0) await ctx.db.insert("groupMembers", { orgId, groupId: g, employeeId }); // 5 members among 70 hits
      }
    });
    const inGroup = await a.as.query(api.employees.search, { text: "seasonal", groupId: g });
    expect(inGroup.rows).toHaveLength(5);
    expect(inGroup.capped).toBe(false);
    const all = await a.as.query(api.employees.search, { text: "seasonal" });
    expect(all.rows).toHaveLength(50);
    expect(all.capped).toBe(true);
  });
});

describe("employees: revocation is never blocked by a missing signing key", () => {
  async function ownerOf(t: T, orgId: Id<"organizations">) {
    const m = await asMember(t, { role: "owner", mfa: true, orgId });
    await giveStepUp(t, m);
    return m;
  }
  async function pendingOf(t: T, orgId: Id<"organizations">) {
    return await t.run((ctx) => ctx.db.query("rosterPending").withIndex("by_org", (q) => q.eq("orgId", orgId)).take(500));
  }
  async function world() {
    vi.useFakeTimers();
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const a = await admin(t, orgId);
    const g1 = await group(t, orgId, "Sales");
    const g2 = await group(t, orgId, "Ops");
    const id = await newEmployee(a, { name: "Fired Person", username: "fired", groupIds: [g1, g2], password: PASSWORD }); // credentialRevision 1
    return { t, orgId, a, g1, g2, id, drain: () => t.finishAllScheduledFunctions(vi.runAllTimers) };
  }
  const shape = async (t: T, g: Id<"groups">) => (await rosterOf(t, g)).entries.map((e) => [e.epoch, e.credentialRevision]);

  test("disabling without a key succeeds, queues one removal per group and signs nothing; enabling still needs the key", async () => {
    const { t, orgId, a, g1, g2, id } = await world();
    setSeeds(undefined);
    expect(await a.as.mutation(api.employees.setDisabled, { employeeId: id, disabled: true })).toBeNull();
    expect(await row(t, id)).toMatchObject({ disabled: true });
    expect(await stats(t, orgId)).toMatchObject({ employeeCount: 1, activeEmployeeCount: 0 });
    expect((await pendingOf(t, orgId)).map((p) => [p.groupId, p.employeeId]).sort()).toEqual([[g1, id], [g2, id]].sort());
    for (const g of [g1, g2]) expect(await shape(t, g)).toEqual([[1, 1]]); // nothing new was signed
    const disabledAudit = (await auditRows(t, orgId)).find((r) => r.action === "employee.disabled")!;
    expect(disabledAudit.summary).toContain("signing key");
    // the same state again: no write; enabling is refused and changes nothing
    const { io } = await probe(() => a.as.mutation(api.employees.setDisabled, { employeeId: id, disabled: true }));
    expect(io.writes).toBe(0);
    await expectCode(a.as.mutation(api.employees.setDisabled, { employeeId: id, disabled: false }), "not_ready");
    expect(await row(t, id)).toMatchObject({ disabled: true });
    expect(await pendingOf(t, orgId)).toHaveLength(2);
    expect(await stats(t, orgId)).toMatchObject({ activeEmployeeCount: 0 });
  });

  test("a mismatched key (not the organization's registered one) is the same as none: disabling still works", async () => {
    const { t, orgId, a, id } = await world();
    setSeeds("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");
    await a.as.mutation(api.employees.setDisabled, { employeeId: id, disabled: true });
    expect(await pendingOf(t, orgId)).toHaveLength(2);
  });

  test("when the key is back (keys:registerActive), the pending removals are signed exactly once", async () => {
    const { t, orgId, a, g1, g2, id, drain } = await world();
    setSeeds(undefined);
    await a.as.mutation(api.employees.setDisabled, { employeeId: id, disabled: true });
    setSeeds(TEST_SEED_B64);
    await (await ownerOf(t, orgId)).as.mutation(api.keys.registerActive, {}); // the retry path: the env key is the active key
    await drain();
    for (const g of [g1, g2]) {
      expect(await shape(t, g)).toEqual([[1, 1], [2, undefined]]);
      const r = await rosterOf(t, g);
      expect(r.entries.every((e) => entryVerifies(orgId, e))).toBe(true);
      expect(r.head?.epoch).toBe(2);
    }
    expect(await pendingOf(t, orgId)).toEqual([]);
    // running it again, or from another trigger, signs nothing more
    await t.mutation(internal.employees.resyncRoster, { orgId });
    await drain();
    for (const g of [g1, g2]) expect((await rosterOf(t, g)).head?.epoch).toBe(2);
  });

  test("a publish run that can sign also resyncs; while there is still no key the rows stay", async () => {
    const { t, orgId, a, g1, id, drain } = await world();
    setSeeds(undefined);
    await a.as.mutation(api.employees.setDisabled, { employeeId: id, disabled: true });
    await t.mutation(internal.employees.resyncRoster, { orgId }); // still no key
    expect(await pendingOf(t, orgId)).toHaveLength(2);
    expect((await rosterOf(t, g1)).head?.epoch).toBe(1);
    setSeeds(TEST_SEED_B64);
    await t.run((ctx) => ctx.db.insert("publishQueue", { orgId, allDevices: true, groupIds: [], deviceIds: [], requestedAt: Date.now() }));
    await t.mutation(internal.publish.run, { orgId });
    await drain();
    expect(await pendingOf(t, orgId)).toEqual([]);
    expect(await shape(t, g1)).toEqual([[1, 1], [2, undefined]]);
  });

  test("toggling: enabling with a key supersedes a waiting removal; the roster stays gap-free and ends consistent", async () => {
    const { t, orgId, a, g1, id, drain } = await world();
    setSeeds(undefined);
    await a.as.mutation(api.employees.setDisabled, { employeeId: id, disabled: true }); // pending
    setSeeds(TEST_SEED_B64);
    await a.as.mutation(api.employees.setDisabled, { employeeId: id, disabled: false }); // signed "added", pending dropped
    expect(await pendingOf(t, orgId)).toEqual([]);
    expect(await shape(t, g1)).toEqual([[1, 1], [2, 1]]);
    await t.mutation(internal.employees.resyncRoster, { orgId }); // nothing left to sign
    expect(await shape(t, g1)).toEqual([[1, 1], [2, 1]]);
    await a.as.mutation(api.employees.setDisabled, { employeeId: id, disabled: true }); // key present: signed at once
    expect(await pendingOf(t, orgId)).toEqual([]);
    expect(await shape(t, g1)).toEqual([[1, 1], [2, 1], [3, undefined]]);
    await a.as.mutation(api.employees.setDisabled, { employeeId: id, disabled: false });
    setSeeds(undefined);
    await a.as.mutation(api.employees.setDisabled, { employeeId: id, disabled: true }); // pending again
    expect(await pendingOf(t, orgId)).toHaveLength(2);
    setSeeds(TEST_SEED_B64);
    await t.mutation(internal.employees.resyncRoster, { orgId });
    await drain();
    const r = await rosterOf(t, g1);
    expect(r.entries.map((e) => e.epoch)).toEqual([1, 2, 3, 4, 5]); // gap-free
    expect(r.entries.at(-1)!.credentialRevision).toBeUndefined(); // last word: removed
    expect(r.entries.every((e) => entryVerifies(orgId, e))).toBe(true);
    expect(r.head?.epoch).toBe(5);
    expect(await pendingOf(t, orgId)).toEqual([]);
    expect(await stats(t, orgId)).toMatchObject({ employeeCount: 1, activeEmployeeCount: 0 });
  });

  test("a group left while disabled and waiting still gets its removal; remove keeps the waiting rows", async () => {
    const { t, orgId, a, g1, g2, id, drain } = await world();
    setSeeds(undefined);
    await a.as.mutation(api.employees.setDisabled, { employeeId: id, disabled: true });
    await a.as.mutation(api.groups.removeEmployee, { groupId: g1, employeeId: id }); // a disabled employee: no roster change, no key needed
    await a.as.mutation(api.employees.remove, { employeeId: id });
    expect(await pendingOf(t, orgId)).toHaveLength(2);
    setSeeds(TEST_SEED_B64);
    await t.mutation(internal.employees.resyncRoster, { orgId });
    await drain();
    for (const g of [g1, g2]) expect(await shape(t, g)).toEqual([[1, 1], [2, undefined]]);
    expect(await pendingOf(t, orgId)).toEqual([]);
  });

  test("a large backlog is signed in batches of 50, rescheduling itself, each removal once", async () => {
    vi.useFakeTimers();
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const g = await group(t, orgId);
    await t.run(async (ctx) => {
      for (let i = 0; i < 120; i++) await ctx.db.insert("rosterPending", { orgId, groupId: g, employeeId: `gone${i}` });
    });
    await t.mutation(internal.employees.resyncRoster, { orgId });
    expect((await rosterOf(t, g)).head?.epoch).toBe(50);
    expect(await pendingOf(t, orgId)).toHaveLength(70);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const r = await rosterOf(t, g);
    expect(r.head?.epoch).toBe(120);
    expect(await pendingOf(t, orgId)).toEqual([]);
    expect(new Set(r.entries.map((e) => e.employeeId)).size).toBe(r.entries.length); // each exactly once
    expect(r.entries.every((e) => e.credentialRevision === undefined && entryVerifies(orgId, e))).toBe(true);
  });
});

describe("no unbounded reads", () => {
  test("the Step 11 modules never call .collect() or filter a table", async () => {
    const files = ["./employees.ts", "./groups.ts", "./publish.ts", "./lib/employeeSync.ts", "./lib/employeeRules.ts"];
    const sources = import.meta.glob(["./employees.ts", "./groups.ts", "./publish.ts", "./lib/employeeSync.ts", "./lib/employeeRules.ts"], { query: "?raw", import: "default", eager: true }) as Record<string, string>;
    expect(Object.keys(sources).sort()).toEqual([...files].sort());
    for (const [path, text] of Object.entries(sources)) {
      expect(text, path).not.toMatch(/\.collect\(/);
      expect(text, path).not.toMatch(/\.filter\(\(?q\b/); // a database filter, not Array#filter
    }
  });
});
