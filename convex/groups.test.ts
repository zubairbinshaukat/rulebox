import { describe, expect, test } from "vitest";
import { setupAuth } from "../tests/convex/auth";
import { asMember, expectCode, giveStepUp, makeOrg, type T } from "../tests/convex/identity";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { MINUTE_MS } from "./lib/limits";

// Groups (plan Step 5.6) and the `maxGroups` limit.

async function admin(t: T, orgId: Id<"organizations">, stepUp: "fresh" | "stale" = "fresh") {
  const m = await asMember(t, { role: "admin", mfa: true, orgId });
  if (stepUp === "fresh") await giveStepUp(t, m);
  else await giveStepUp(t, m, { verifiedAgoMs: 6 * MINUTE_MS, activeAgoMs: 0 });
  return m;
}

async function groupCount(t: T, orgId: Id<"organizations">) {
  return await t.run(async (ctx) => (await ctx.db.query("orgStats").withIndex("by_org", (q) => q.eq("orgId", orgId)).unique())?.groupCount);
}

async function auditActions(t: T, orgId: Id<"organizations">) {
  return await t.run(async (ctx) =>
    (await ctx.db.query("auditLog").withIndex("by_org_at", (q) => q.eq("orgId", orgId)).take(50)).map((r) => r.action),
  );
}

async function employee(t: T, orgId: Id<"organizations">, n: number) {
  return await t.run((ctx) =>
    ctx.db.insert("employees", {
      orgId,
      name: `E${n}`,
      username: `e${n}`,
      searchText: `e${n}`,
      disabled: false,
      credentialRevision: 0,
      revision: 0,
      createdAt: Date.now(),
    }),
  );
}

async function token(t: T, orgId: Id<"organizations">, groupId: Id<"groups">, opts: { expiresIn?: number; usesLeft?: number; revoked?: boolean } = {}) {
  return await t.run((ctx) =>
    ctx.db.insert("enrollmentTokens", {
      orgId,
      groupId,
      tokenHash: Math.random().toString(16).slice(2).padEnd(64, "0"),
      expiresAt: Date.now() + (opts.expiresIn ?? 3_600_000),
      usesLeft: opts.usesLeft ?? 1,
      revoked: opts.revoked,
      createdAt: Date.now(),
    }),
  );
}

async function device(t: T, orgId: Id<"organizations">, groupId: Id<"groups">) {
  return await t.run(async (ctx) => {
    const tokenId = await ctx.db.insert("enrollmentTokens", { orgId, tokenHash: "f".repeat(64), expiresAt: 0, usesLeft: 0, createdAt: 0 });
    return await ctx.db.insert("devices", {
      orgId,
      groupId,
      name: "PC",
      secretHash: Math.random().toString(16).slice(2).padEnd(64, "0"),
      revoked: false,
      enrolledAt: Date.now(),
      enrollmentTokenId: tokenId,
    });
  });
}

describe("groups", () => {
  test("create, list with counts, rename, describe, unique names, audit", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const a = await admin(t, orgId);
    const { groupId: sales } = await a.as.mutation(api.groups.create, { name: "  Sales ", description: "Front desk" });
    const { groupId: ops } = await a.as.mutation(api.groups.create, { name: "Ops" });
    await expectCode(a.as.mutation(api.groups.create, { name: "Sales" }), "conflict");
    await expectCode(a.as.mutation(api.groups.create, { name: "" }), "invalid_argument");
    await expectCode(a.as.mutation(api.groups.create, { name: "x".repeat(65) }), "invalid_argument");
    expect(await groupCount(t, orgId)).toBe(2);

    await device(t, orgId, sales);
    const employeeId = await employee(t, orgId, 1);
    await t.run((ctx) => ctx.db.insert("groupMembers", { orgId, groupId: sales, employeeId }));
    const list = await a.as.query(api.groups.list, {});
    expect(list.map((g) => g.name)).toEqual(["Ops", "Sales"]);
    expect(list[1]).toMatchObject({
      name: "Sales",
      description: "Front desk",
      revision: 0,
      devices: { count: 1, more: false },
      employees: { count: 1, more: false },
    });

    // rename: conflict, stale, no-op, real change, description cleared
    await expectCode(a.as.mutation(api.groups.rename, { groupId: ops, expectedRevision: 0, name: "Sales" }), "conflict");
    expect(await a.as.mutation(api.groups.rename, { groupId: ops, expectedRevision: 0, name: "Ops" })).toEqual({ revision: 0 });
    expect(await a.as.mutation(api.groups.rename, { groupId: ops, expectedRevision: 0, name: "Operations" })).toEqual({ revision: 1 });
    await expectCode(a.as.mutation(api.groups.rename, { groupId: ops, expectedRevision: 0, name: "Ops 2" }), "stale_edit");
    await a.as.mutation(api.groups.rename, { groupId: sales, expectedRevision: 0, name: "Sales", description: "" });
    const g = await a.as.query(api.groups.get, { groupId: sales });
    expect(g.group.description).toBeUndefined();
    expect(g.apps).toEqual([]);
    expect(await auditActions(t, orgId)).toEqual(["group.created", "group.created", "group.renamed", "group.updated"]);
  });

  test("counts above 500 are capped and flagged", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const a = await admin(t, orgId);
    const { groupId } = await a.as.mutation(api.groups.create, { name: "Big" });
    await t.run(async (ctx) => {
      for (let i = 0; i < 501; i++) {
        const employeeId = await ctx.db.insert("employees", {
          orgId,
          name: `E${i}`,
          username: `e${i}`,
          searchText: `e${i}`,
          disabled: false,
          credentialRevision: 0,
          revision: 0,
          createdAt: 0,
        });
        await ctx.db.insert("groupMembers", { orgId, groupId, employeeId });
      }
    });
    const [big] = await a.as.query(api.groups.list, {});
    expect(big!.employees).toEqual({ count: 500, more: true });
  });

  test("get lists the group's assigned apps", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const a = await admin(t, orgId);
    const { groupId } = await a.as.mutation(api.groups.create, { name: "Sales" });
    await t.run(async (ctx) => {
      const appId = await ctx.db.insert("apps", { orgId, name: "Mail", kind: "web", archived: false, revision: 0, createdAt: 0 });
      await ctx.db.insert("appAssignments", { orgId, groupId, appId, audience: "everyone", pinnedTaskbar: true, pinnedDesktop: false });
    });
    const g = await a.as.query(api.groups.get, { groupId });
    expect(g.apps).toMatchObject([{ name: "Mail", kind: "web", audience: "everyone", pinnedTaskbar: true, pinnedDesktop: false }]);
  });

  test("delete is refused while devices, employees, apps or usable codes reference the group", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const a = await admin(t, orgId);
    const { groupId } = await a.as.mutation(api.groups.create, { name: "Sales" });
    // Codes that can no longer enroll do not block.
    await token(t, orgId, groupId, { expiresIn: -1000 });
    await token(t, orgId, groupId, { usesLeft: 0 });
    await token(t, orgId, groupId, { revoked: true });
    const d = await device(t, orgId, groupId);
    const empId = await employee(t, orgId, 1);
    const gm = await t.run((ctx) => ctx.db.insert("groupMembers", { orgId, groupId, employeeId: empId }));
    const asg = await t.run(async (ctx) => {
      const appId = await ctx.db.insert("apps", { orgId, name: "Mail", kind: "web", archived: false, revision: 0, createdAt: 0 });
      return await ctx.db.insert("appAssignments", { orgId, groupId, appId, audience: "everyone", pinnedTaskbar: false, pinnedDesktop: false });
    });
    const code = await token(t, orgId, groupId);
    let err: unknown = null;
    try {
      await a.as.mutation(api.groups.remove, { groupId });
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ data: { code: "has_dependents", detail: "devices, employees, apps, enrollment codes" } });

    await t.run(async (ctx) => {
      await ctx.db.delete(d);
      await ctx.db.delete(gm);
      await ctx.db.delete(asg);
      await ctx.db.patch(code, { revoked: true });
    });
    expect(await groupCount(t, orgId)).toBe(1);
    await a.as.mutation(api.groups.remove, { groupId });
    expect(await groupCount(t, orgId)).toBe(0);
    expect(await a.as.query(api.groups.list, {})).toEqual([]);
    expect(await auditActions(t, orgId)).toEqual(["group.created", "group.deleted"]);
  });

  test("delete needs a fresh step-up; viewers cannot write; another org's group is not_found", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const fresh = await admin(t, orgId);
    const { groupId } = await fresh.as.mutation(api.groups.create, { name: "Sales" });
    const stale = await admin(t, orgId, "stale");
    await expectCode(stale.as.mutation(api.groups.remove, { groupId }), "step_up_required");
    const viewer = await asMember(t, { role: "viewer", orgId });
    await giveStepUp(t, viewer);
    await expectCode(viewer.as.mutation(api.groups.create, { name: "X" }), "forbidden");
    await expectCode(viewer.as.mutation(api.groups.rename, { groupId, expectedRevision: 0, name: "X" }), "forbidden");
    await expectCode(viewer.as.mutation(api.groups.remove, { groupId }), "forbidden");

    const other = await makeOrg(t, "Other");
    const foreign = await admin(t, other);
    await expectCode(foreign.as.query(api.groups.get, { groupId }), "not_found");
    await expectCode(foreign.as.mutation(api.groups.rename, { groupId, expectedRevision: 0, name: "Mine" }), "not_found");
    await expectCode(foreign.as.mutation(api.groups.remove, { groupId }), "not_found");
    await expectCode(foreign.as.query(api.groups.get, { groupId: "not-an-id" }), "not_found");
    expect(await foreign.as.query(api.groups.list, {})).toEqual([]);
    // Same name in another organization is fine.
    await foreign.as.mutation(api.groups.create, { name: "Sales" });
  });

  test("free plan: the 4th group is refused with plan_limit; deleting one frees a slot", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t, "Acme", { plan: "free" });
    const a = await admin(t, orgId);
    const ids: Id<"groups">[] = [];
    for (const name of ["One", "Two", "Three"]) ids.push((await a.as.mutation(api.groups.create, { name })).groupId);
    let err: unknown = null;
    try {
      await a.as.mutation(api.groups.create, { name: "Four" });
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ data: { code: "plan_limit", detail: "groups" } });
    // Nothing was written for the refused create.
    expect(await groupCount(t, orgId)).toBe(3);
    expect((await a.as.query(api.groups.list, {})).length).toBe(3);
    await a.as.mutation(api.groups.remove, { groupId: ids[0]! });
    await a.as.mutation(api.groups.create, { name: "Four" });
    expect(await groupCount(t, orgId)).toBe(3);
  });

  test("free plan: the setup-created Default group is not one of the 3 (owner decision 2026-10-27)", async () => {
    process.env.RULEBOX_HOSTED = "1";
    try {
      const t = await setupAuth();
      const { orgId } = await t.action(internal.setup.createOwnerInvite, { orgName: "Acme", email: "o@acme.test" });
      expect(await groupCount(t, orgId)).toBe(0);
      const a = await admin(t, orgId);
      for (const name of ["One", "Two", "Three"]) await a.as.mutation(api.groups.create, { name });
      await expectCode(a.as.mutation(api.groups.create, { name: "Four" }), "plan_limit");
      const listed = await a.as.query(api.groups.list, {});
      expect(listed.map((g) => [g.name, g.isDefault])).toEqual([
        ["Default", true],
        ["One", false],
        ["Three", false],
        ["Two", false],
      ]);
      expect((await a.as.query(api.settings.plan, {})).usage).toMatchObject({ groups: 3 });
      // Deleting the Default group frees no slot (it never used one).
      await a.as.mutation(api.groups.remove, { groupId: listed[0]!._id });
      expect(await groupCount(t, orgId)).toBe(3);
      await expectCode(a.as.mutation(api.groups.create, { name: "Four" }), "plan_limit");
    } finally {
      delete process.env.RULEBOX_HOSTED;
    }
  });
});

declare const process: { env: Record<string, string | undefined> };
