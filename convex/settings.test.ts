import { describe, expect, test } from "vitest";
import { setupAuth } from "../tests/convex/auth";
import { asMember, expectCode, expectNoSecrets, giveStepUp, makeOrg, type T } from "../tests/convex/identity";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { verifySecret } from "./lib/argon";
import { MINUTE_MS } from "./lib/limits";
import { exitPinProblem } from "./lib/orgSettings";
import { FREE_LIMITS } from "./lib/plans";
import { requestPublish } from "./lib/publish";
import { DEFAULT_ORG_SETTINGS, type OrgSettings } from "./lib/validators";

// Settings → Organization and Admin exit (plan Step 5, 4.10).

async function admin(t: T, orgId: Id<"organizations">, stepUp: "fresh" | "stale" = "fresh") {
  const m = await asMember(t, { role: "admin", mfa: true, orgId });
  if (stepUp === "fresh") await giveStepUp(t, m);
  else await giveStepUp(t, m, { verifiedAgoMs: 6 * MINUTE_MS, activeAgoMs: 0 });
  return m;
}

function withSettings(patch: Partial<OrgSettings>): OrgSettings {
  return { ...DEFAULT_ORG_SETTINGS, ...patch };
}

async function auditRows(t: T, orgId: Id<"organizations">) {
  return await t.run((ctx) => ctx.db.query("auditLog").withIndex("by_org_at", (q) => q.eq("orgId", orgId)).take(50));
}

async function queue(t: T, orgId: Id<"organizations">) {
  return await t.run((ctx) => ctx.db.query("publishQueue").withIndex("by_org", (q) => q.eq("orgId", orgId)).unique());
}

describe("settings:update", () => {
  test.each([
    ["offlineDays -1", withSettings({ offlineDays: -1 }), "offlineDays"],
    ["offlineDays 31", withSettings({ offlineDays: 31 }), "offlineDays"],
    ["offlineDays 1.5", withSettings({ offlineDays: 1.5 }), "offlineDays"],
    ["defaultQuotaGb -1", withSettings({ defaultQuotaGb: -1 }), "defaultQuotaGb"],
    ["defaultQuotaGb 2001", withSettings({ defaultQuotaGb: 2001 }), "defaultQuotaGb"],
    ["hotkey Alt+Tab", withSettings({ adminExit: { enabled: true, hotkey: "Alt+Tab" } }), "adminExit.hotkey"],
    ["hotkey Shift+A", withSettings({ adminExit: { enabled: true, hotkey: "Shift+A" } }), "adminExit.hotkey"],
    ["hotkey too long", withSettings({ adminExit: { enabled: true, hotkey: "Ctrl+".repeat(20) + "A" } }), "adminExit.hotkey"],
  ])("refuses %s", async (_label, settings, field) => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const a = await admin(t, orgId);
    let err: unknown = null;
    try {
      await a.as.mutation(api.settings.update, { expectedRevision: 0, name: "Acme", settings });
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ data: { code: "invalid_argument", field } });
  });

  test("refuses an empty or overlong name", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const a = await admin(t, orgId);
    for (const name of ["   ", "x".repeat(101), "bad\nname"]) {
      await expectCode(a.as.mutation(api.settings.update, { expectedRevision: 0, name, settings: DEFAULT_ORG_SETTINGS }), "invalid_argument");
    }
  });

  test("accepts every bound, stores the canonical hotkey, audits field names, requests a publish", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const a = await admin(t, orgId);
    const settings: OrgSettings = {
      offlineDays: 30,
      defaultQuotaGb: 2000,
      power: { sleep: false, restart: true, shutDown: false },
      adminExit: { enabled: true, hotkey: "shift+alt+ctrl+r" },
    };
    const r = await a.as.mutation(api.settings.update, { expectedRevision: 0, name: "  Acme Ltd ", settings });
    expect(r).toEqual({ revision: 1, changed: ["name", "offlineDays", "defaultQuotaGb", "power", "adminExit"] });
    const got = await a.as.query(api.settings.get, {});
    expect(got).toEqual({
      name: "Acme Ltd",
      revision: 1,
      settings: { ...settings, adminExit: { enabled: true, hotkey: "Ctrl+Alt+Shift+R" } },
      exitPin: { set: false },
    });
    const zero = { ...settings, offlineDays: 0, defaultQuotaGb: 0 };
    await a.as.mutation(api.settings.update, { expectedRevision: 1, name: "Acme Ltd", settings: zero });
    const audit = await auditRows(t, orgId);
    expect(audit.map((x) => x.action)).toEqual(["org.settingsChanged", "org.settingsChanged"]);
    expect(audit[0]!.summary).toBe("Changed organization settings: name, offlineDays, defaultQuotaGb, power, adminExit");
    expect(await queue(t, orgId)).toMatchObject({ allDevices: true, groupIds: [], deviceIds: [] });
  });

  test("stale_edit when the revision moved; nothing changed = no write and no audit", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const a = await admin(t, orgId);
    const same = await a.as.mutation(api.settings.update, { expectedRevision: 0, name: "Acme", settings: DEFAULT_ORG_SETTINGS });
    expect(same).toEqual({ revision: 0, changed: [] });
    expect(await auditRows(t, orgId)).toHaveLength(0);
    expect(await queue(t, orgId)).toBeNull();
    await a.as.mutation(api.settings.update, { expectedRevision: 0, name: "Acme", settings: withSettings({ offlineDays: 5 }) });
    await expectCode(
      a.as.mutation(api.settings.update, { expectedRevision: 0, name: "Acme", settings: withSettings({ offlineDays: 6 }) }),
      "stale_edit",
    );
  });

  test("only offlineDays: unlocked is enough; the admin exit needs a fresh step-up", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const stale = await admin(t, orgId, "stale");
    const r = await stale.as.mutation(api.settings.update, { expectedRevision: 0, name: "Acme", settings: withSettings({ offlineDays: 7 }) });
    expect(r.changed).toEqual(["offlineDays"]);
    const exitOff = withSettings({ offlineDays: 7, adminExit: { enabled: false, hotkey: "Ctrl+Shift+F12" } });
    await expectCode(stale.as.mutation(api.settings.update, { expectedRevision: 1, name: "Acme", settings: exitOff }), "step_up_required");
    const hotkey = withSettings({ offlineDays: 7, adminExit: { enabled: true, hotkey: "Ctrl+Alt+F1" } });
    await expectCode(stale.as.mutation(api.settings.update, { expectedRevision: 1, name: "Acme", settings: hotkey }), "step_up_required");
    // Same combination written differently is not a change.
    const sameKey = withSettings({ offlineDays: 7, adminExit: { enabled: true, hotkey: "ctrl + shift + f12" } });
    expect((await stale.as.mutation(api.settings.update, { expectedRevision: 1, name: "Acme", settings: sameKey })).changed).toEqual([]);
    const fresh = await admin(t, orgId);
    expect((await fresh.as.mutation(api.settings.update, { expectedRevision: 1, name: "Acme", settings: exitOff })).changed).toEqual(["adminExit"]);
  });

  test("viewers cannot write", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const v = await asMember(t, { role: "viewer", orgId });
    await giveStepUp(t, v);
    await expectCode(v.as.mutation(api.settings.update, { expectedRevision: 0, name: "X", settings: DEFAULT_ORG_SETTINGS }), "forbidden");
    await expectCode(v.as.action(api.settings.setExitPin, { pin: "246813" }), "forbidden");
    await expectCode(v.as.mutation(api.settings.clearExitPin, {}), "forbidden");
  });
});

describe("exit PIN", () => {
  test.each([
    ["12345", "6 to 12 digits"],
    ["1234567890123", "6 to 12 digits"],
    ["12a456", "6 to 12 digits"],
    ["", "6 to 12 digits"],
    ["111111", "all digits the same"],
    ["000000000000", "all digits the same"],
    ["123456", "sequence"],
    ["0123456789", "sequence"],
    ["987654", "sequence"],
    ["456789", "sequence"],
  ])("%s refused (%s)", (pin, reason) => {
    expect(exitPinProblem(pin)).toBe(reason);
  });

  test.each(["246813", "890123", "121212", "135792468024"])("%s accepted", (pin) => {
    expect(exitPinProblem(pin)).toBeNull();
  });

  test("set: Argon2id hash in orgSecrets only, never returned or audited; then clear", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const a = await admin(t, orgId);
    await expectCode(a.as.action(api.settings.setExitPin, { pin: "12345" }), "invalid_argument");
    await expectCode(a.as.action(api.settings.setExitPin, { pin: "111111" }), "invalid_argument");
    await expectCode(a.as.action(api.settings.setExitPin, { pin: "123456" }), "invalid_argument");
    const before = await t.run((ctx) => ctx.db.query("orgSecrets").withIndex("by_org", (q) => q.eq("orgId", orgId)).unique());
    expect(before?.exitPinHash).toBeUndefined();

    await a.as.action(api.settings.setExitPin, { pin: "246813" });
    const secrets = await t.run((ctx) => ctx.db.query("orgSecrets").withIndex("by_org", (q) => q.eq("orgId", orgId)).unique());
    const phc = secrets!.exitPinHash!;
    expect(phc).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(await verifySecret("246813", phc)).toBe(true);
    expect(await verifySecret("246814", phc)).toBe(false);

    const got = await a.as.query(api.settings.get, {});
    expect(got.exitPin.set).toBe(true);
    expectNoSecrets(got, [phc, "246813"]);
    const audit = await auditRows(t, orgId);
    expect(audit.map((x) => x.action)).toEqual(["org.exitPinSet"]);
    expect(JSON.stringify(audit)).not.toContain("246813");
    expectNoSecrets(audit, [phc]);
    expect(await queue(t, orgId)).toMatchObject({ allDevices: true });

    await a.as.action(api.settings.setExitPin, { pin: "731942" });
    expect((await auditRows(t, orgId)).map((x) => x.summary)).toContain("Changed the device exit PIN");

    await a.as.mutation(api.settings.clearExitPin, {});
    expect((await a.as.query(api.settings.get, {})).exitPin).toEqual({ set: false });
    const after = await t.run((ctx) => ctx.db.query("orgSecrets").withIndex("by_org", (q) => q.eq("orgId", orgId)).unique());
    expect(after?.exitPinHash).toBeUndefined();
    // Clearing again changes nothing: no second audit row.
    await a.as.mutation(api.settings.clearExitPin, {});
    expect((await auditRows(t, orgId)).filter((x) => x.action === "org.exitPinCleared")).toHaveLength(1);
  });

  test("set and clear answer step_up_required without a fresh step-up and work with one", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const stale = await admin(t, orgId, "stale");
    await expectCode(stale.as.action(api.settings.setExitPin, { pin: "246813" }), "step_up_required");
    await expectCode(stale.as.mutation(api.settings.clearExitPin, {}), "step_up_required");
    const fresh = await admin(t, orgId);
    await fresh.as.action(api.settings.setExitPin, { pin: "246813" });
    await expectCode(stale.as.mutation(api.settings.clearExitPin, {}), "step_up_required");
    await fresh.as.mutation(api.settings.clearExitPin, {});
    expect((await fresh.as.query(api.settings.get, {})).exitPin.set).toBe(false);
  });
});

describe("settings:plan", () => {
  test("free plan limits and usage from the counters", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t, "Acme", { plan: "free" });
    const v = await asMember(t, { role: "viewer", orgId });
    const p = await v.as.query(api.settings.plan, {});
    expect(p).toMatchObject({ plan: "free", status: "active", limits: FREE_LIMITS, pingIntervalMs: 1_800_000 });
    expect(p.usage).toEqual({ devices: 0, employees: 0, apps: 0, groups: 0, members: 0, enrollmentCodes: 0 });
  });
});

describe("requestPublish", () => {
  test("merges targets; all devices wins; lists above 500 become all devices; no write when nothing new", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const [g1, g2] = await t.run(async (ctx) => [
      await ctx.db.insert("groups", { orgId, name: "A" }),
      await ctx.db.insert("groups", { orgId, name: "B" }),
    ]);
    await t.run((ctx) => requestPublish(ctx, orgId, { groupIds: [g1] }));
    await t.run((ctx) => requestPublish(ctx, orgId, { groupIds: [g1, g2] }));
    const first = await queue(t, orgId);
    expect(first).toMatchObject({ allDevices: false, deviceIds: [] });
    expect([...first!.groupIds].sort()).toEqual([g1, g2].sort());
    expect(first!.scheduled).toBeDefined();

    // Nothing new: the row is not rewritten.
    await t.run((ctx) => requestPublish(ctx, orgId, { groupIds: [g2] }));
    expect(await queue(t, orgId)).toEqual(first);

    await t.run((ctx) => requestPublish(ctx, orgId, { allDevices: true }));
    expect(await queue(t, orgId)).toMatchObject({ allDevices: true, groupIds: [], deviceIds: [], scheduled: first!.scheduled });
    await t.run((ctx) => requestPublish(ctx, orgId, { groupIds: [g1] }));
    expect(await queue(t, orgId)).toMatchObject({ allDevices: true, groupIds: [] });

    // Cap: a list longer than 500 turns into "all devices".
    const other = await makeOrg(t, "Other");
    const many = await t.run(async (ctx) => {
      const ids: Id<"groups">[] = [];
      for (let i = 0; i < 501; i++) ids.push(await ctx.db.insert("groups", { orgId: other, name: `g${i}` }));
      return ids;
    });
    await t.run((ctx) => requestPublish(ctx, other, { groupIds: many.slice(0, 300) }));
    expect((await queue(t, other))!.groupIds).toHaveLength(300);
    await t.run((ctx) => requestPublish(ctx, other, { groupIds: many.slice(300) }));
    expect(await queue(t, other)).toMatchObject({ allDevices: true, groupIds: [] });
  });

  test("publish:run (Step 5 stub) clears the queue", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    await t.run((ctx) => requestPublish(ctx, orgId, { allDevices: true }));
    const row = await queue(t, orgId);
    expect(row?.scheduled).toBeDefined();
    await t.mutation(internal.publish.run, { orgId });
    expect(await queue(t, orgId)).toBeNull();
  });
});
