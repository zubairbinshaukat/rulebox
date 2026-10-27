import { afterEach, describe, expect, test } from "vitest";
import { setupAuth, signIn } from "../tests/convex/auth";
import { asMember, expectCode, giveStepUp, makeOrg, type T } from "../tests/convex/identity";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { CUSTOM_LIMITS, FREE_LIMITS, assertWithinLimit, effectivePingInterval } from "./lib/plans";

// Plans, limits, the ping interval settings and the Step 5 migration
// (plan Step 5 items 8-9, A1/A4/A7).

declare const process: { env: Record<string, string | undefined> };

afterEach(() => {
  delete process.env.RULEBOX_HOSTED;
});

async function planRow(t: T, orgId: Id<"organizations">) {
  return await t.run((ctx) => ctx.db.query("orgPlans").withIndex("by_org", (q) => q.eq("orgId", orgId)).unique());
}
async function stats(t: T, orgId: Id<"organizations">) {
  return await t.run((ctx) => ctx.db.query("orgStats").withIndex("by_org", (q) => q.eq("orgId", orgId)).unique());
}
async function audit(t: T, orgId: Id<"organizations">) {
  return await t.run((ctx) => ctx.db.query("auditLog").withIndex("by_org_at", (q) => q.eq("orgId", orgId)).take(50));
}

describe("setup creates the plan rows", () => {
  test("self-host: custom plan, global 30-minute interval", async () => {
    const t = await setupAuth();
    const { orgId } = await t.action(internal.setup.createOwnerInvite, { orgName: "Acme", email: "o@acme.test" });
    expect(await planRow(t, orgId)).toMatchObject({ plan: "custom", status: "active", limits: CUSTOM_LIMITS, revision: 0 });
    const shown = await t.query(internal.plans.show, { orgId });
    expect(shown).toMatchObject({ plan: "custom", migrated: true, pingIntervalMs: { override: null, effective: 1_800_000 } });
    // The setup-created Default group is not one of the plan's groups (owner decision 2026-10-27).
    expect(shown.usage).toMatchObject({ groups: 0, members: 0, devices: 0 });
  });

  test("hosted (RULEBOX_HOSTED=1): free plan with the owner-decided limits", async () => {
    process.env.RULEBOX_HOSTED = "1";
    const t = await setupAuth();
    const { orgId } = await t.action(internal.setup.createOwnerInvite, { orgName: "Acme", email: "o@acme.test" });
    expect(await planRow(t, orgId)).toMatchObject({ plan: "free", limits: FREE_LIMITS });
    expect(FREE_LIMITS).toMatchObject({ maxDevices: 2, maxEmployees: 25, maxApps: 20, maxGroups: 3, maxMembers: 2, auditRetentionDays: 30 });
  });
});

describe("maintenance:migratePlans", () => {
  test("moves maxDevices, drops pingIntervalMs, recounts exactly, and is idempotent", async () => {
    const t = await setupAuth();
    const orgId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("organizations", { name: "Legacy", maxDevices: 5 });
      await ctx.db.insert("orgStats", { orgId: id, deviceCount: 0, pingIntervalMs: 300_000 });
      const g = await ctx.db.insert("groups", { orgId: id, name: "Default" });
      await ctx.db.insert("groups", { orgId: id, name: "Other" });
      const tok = await ctx.db.insert("enrollmentTokens", { orgId: id, tokenHash: "a".repeat(64), expiresAt: 0, usesLeft: 0, createdAt: 0 });
      for (const revoked of [false, false, true]) {
        await ctx.db.insert("devices", {
          orgId: id,
          groupId: g,
          name: "PC",
          secretHash: Math.random().toString(16).slice(2),
          revoked,
          enrolledAt: 0,
          enrollmentTokenId: tok,
        });
      }
      return id;
    });
    await asMember(t, { role: "owner", orgId });
    await asMember(t, { role: "viewer", orgId, status: "disabled" });
    const bare = await t.run((ctx) => ctx.db.insert("organizations", { name: "Phase 2 seed" }));

    expect(await t.mutation(internal.maintenance.migratePlans, {})).toEqual({ organizations: 2, changed: 2, done: true });
    const org = await t.run((ctx) => ctx.db.get(orgId));
    expect(org?.maxDevices).toBeUndefined();
    expect((await planRow(t, orgId))?.limits.maxDevices).toBe(5);
    const s = await stats(t, orgId);
    // "Default" (the setup group of an older org) gets `isDefault` and leaves the group count.
    expect(s).toMatchObject({ deviceCount: 2, groupCount: 1, memberCount: 1, noGroupDeviceCount: 0, outOfSupportCount: 0 });
    expect(s?.pingIntervalMs).toBeUndefined();
    const groups = await t.run((ctx) => ctx.db.query("groups").withIndex("by_org", (q) => q.eq("orgId", orgId)).take(5));
    expect(groups.map((g) => [g.name, g.isDefault === true])).toEqual([["Default", true], ["Other", false]]);
    expect(await stats(t, bare)).toMatchObject({ deviceCount: 0, groupCount: 0, memberCount: 0 });
    expect(await t.run((ctx) => ctx.db.query("orgSecrets").withIndex("by_org", (q) => q.eq("orgId", bare)).unique())).not.toBeNull();
    const global = await t.run((ctx) => ctx.db.query("platformSettings").withIndex("by_key", (q) => q.eq("key", "global")).unique());
    expect(global).toMatchObject({ pingIntervalMs: 1_800_000, revision: 0 });

    // Second run: nothing to write.
    expect(await t.mutation(internal.maintenance.migratePlans, {})).toEqual({ organizations: 2, changed: 0, done: true });
  });
});

describe("operator functions (internal)", () => {
  test("ping interval: global and per tenant, bounds, write only on change, tenant audit", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t, "Acme", { plan: "free" });
    await expectCode(t.mutation(internal.plans.setGlobalPingInterval, { pingIntervalMs: 59_999 }), "invalid_argument");
    await expectCode(t.mutation(internal.plans.setGlobalPingInterval, { pingIntervalMs: 21_600_001 }), "invalid_argument");
    expect(await t.mutation(internal.plans.setGlobalPingInterval, { pingIntervalMs: 1_800_000 })).toEqual({ changed: false });
    expect(await t.mutation(internal.plans.setGlobalPingInterval, { pingIntervalMs: 3_600_000 })).toEqual({ changed: true });

    expect(await t.mutation(internal.plans.setOrgPingInterval, { orgId, pingIntervalMs: 300_000 })).toEqual({ changed: true });
    expect(await t.mutation(internal.plans.setOrgPingInterval, { orgId, pingIntervalMs: 300_000 })).toEqual({ changed: false });
    expect((await t.query(internal.plans.show, { orgId })).pingIntervalMs).toEqual({ override: 300_000, effective: 300_000 });
    await t.mutation(internal.plans.setOrgPingInterval, { orgId, pingIntervalMs: null });
    expect((await t.query(internal.plans.show, { orgId })).pingIntervalMs).toEqual({ override: null, effective: 3_600_000 });
    expect((await audit(t, orgId)).map((r) => [r.action, r.actorLabel])).toEqual([
      ["org.planChanged", "Rulebox support"],
      ["org.planChanged", "Rulebox support"],
    ]);
    expect(effectivePingInterval(null, null)).toBe(1_800_000);
  });

  test("setLimits: plan switch copies defaults, single fields override, stale edit, validation", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t, "Acme", { plan: "free" });
    expect(await t.mutation(internal.plans.setLimits, { orgId, limits: { maxGroups: 3 } })).toEqual({ changed: false, revision: 0 });
    expect(await t.mutation(internal.plans.setLimits, { orgId, limits: { maxGroups: 10 }, note: "trial", expectedRevision: 0 })).toEqual({
      changed: true,
      revision: 1,
    });
    await expectCode(t.mutation(internal.plans.setLimits, { orgId, limits: { maxGroups: 11 }, expectedRevision: 0 }), "stale_edit");
    await expectCode(t.mutation(internal.plans.setLimits, { orgId, limits: { maxGroups: -1 } }), "invalid_argument");
    await expectCode(t.mutation(internal.plans.setLimits, { orgId, limits: { auditRetentionDays: 0 } }), "invalid_argument");
    await expectCode(t.mutation(internal.plans.setLimits, { orgId, limits: { maxApps: 1.5 } }), "invalid_argument");
    await t.mutation(internal.plans.setLimits, { orgId, plan: "custom" });
    expect(await planRow(t, orgId)).toMatchObject({ plan: "custom", limits: CUSTOM_LIMITS, revision: 2 });
    const rows = await audit(t, orgId);
    expect(rows.map((r) => r.summary)).toEqual([
      "Plan changed: maxGroups 3 -> 10 (trial)",
      expect.stringMatching(/^Plan changed: plan free -> custom; maxDevices 2 -> 1000000000/),
    ]);

    // Defaults change only NEW organizations.
    await t.mutation(internal.plans.setPlanDefaults, { plan: "free", limits: { maxApps: 30 } });
    const shown = await t.query(internal.plans.show, {});
    expect(shown.global.planDefaults.free.maxApps).toBe(30);
    expect((await planRow(t, orgId))?.limits.maxApps).toBe(CUSTOM_LIMITS.maxApps);
  });

  test("a suspended organization cannot create counted things", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t, "Acme", { plan: "free" });
    await t.run(async (ctx) => {
      const row = await ctx.db.query("orgPlans").withIndex("by_org", (q) => q.eq("orgId", orgId)).unique();
      await ctx.db.patch(row!._id, { status: "suspended" });
    });
    await expectCode(t.run((ctx) => assertWithinLimit(ctx, orgId, "groups")), "plan_limit");
  });
});

describe("maxMembers", () => {
  test("invite refused at the limit; the join itself enforces it; enable checks it; disable frees a slot", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t, "Acme", { plan: "free" }); // maxMembers 2
    const owner = await asMember(t, { role: "owner", mfa: true, orgId });
    await giveStepUp(t, owner);
    const viewer = await asMember(t, { role: "viewer", orgId });
    // asMember inserts directly; set the counter the join path would have kept.
    const statsId = (await stats(t, orgId))!._id;
    await t.run((ctx) => ctx.db.patch(statsId, { memberCount: 1 }));

    // One slot left: an invite works, then the join fills it.
    const inv = await owner.as.action(api.members.invite, { email: "new@acme.test", role: "viewer" });
    const second = await owner.as.action(api.members.invite, { email: "late@acme.test", role: "viewer" });
    await signIn(t, { email: "new@acme.test", password: "correct horse 42 battery", flow: "signUp", inviteCode: inv.code });
    expect((await stats(t, orgId))?.memberCount).toBe(2);
    // Full: a new invite is refused, and an invite made earlier cannot join.
    await expectCode(owner.as.action(api.members.invite, { email: "x@acme.test", role: "viewer" }), "plan_limit");
    let joinErr: unknown = null;
    try {
      await signIn(t, { email: "late@acme.test", password: "correct horse 42 battery", flow: "signUp", inviteCode: second.code });
    } catch (e) {
      joinErr = e;
    }
    expect(JSON.stringify(joinErr)).toContain("plan_limit");
    expect((await stats(t, orgId))?.memberCount).toBe(2);

    await owner.as.mutation(api.members.setDisabled, { memberId: viewer.memberId, disabled: true, expectedRevision: 0 });
    expect((await stats(t, orgId))?.memberCount).toBe(1);
    await owner.as.action(api.members.invite, { email: "y@acme.test", role: "viewer" });
    // Fill the slot again, then re-enabling the viewer is over the limit.
    await t.run((ctx) => ctx.db.patch(statsId, { memberCount: 2 }));
    await expectCode(
      owner.as.mutation(api.members.setDisabled, { memberId: viewer.memberId, disabled: false, expectedRevision: 1 }),
      "plan_limit",
    );
  });
});
