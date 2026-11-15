import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { setupAuth } from "../tests/convex/auth";
import { enrollDevice, probe } from "../tests/convex/devices";
import { asMember, giveStepUp, makeOrg, type T } from "../tests/convex/identity";
import { addWifi, createKeys, giveSealKey, MASTER_A, setMaster, setWifiPassphrase } from "../tests/convex/phase5";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { auditPolicy } from "./lib/audit";
import { snapshotGroupConfig, withVersion } from "./lib/groupConfig";
import { KEEP_GROUP_CONFIGS } from "./lib/limits";
import { DEFAULT_LOCKDOWN_SETTINGS } from "./lib/lockdownValidators";
import { decide, EMPTY_HEALTH, promotedPointers, stageOf, type Health } from "./lib/rollouts";

// Rollout rings and rollback (Phase 5 Step 16, plan 4.14): pointers per ring, the publisher building each PC's document from its
// ring's version, promotion, ring health, the automatic halt / promotion / rollback of the tick, rollback as old content under a new
// document version, offline PCs, two admins, and the keys that are never ring-gated.

beforeEach(() => {
  vi.useFakeTimers();
  auditPolicy.strict = true;
  setMaster(MASTER_A);
});
afterEach(() => {
  vi.useRealTimers();
  auditPolicy.strict = false;
  setMaster(undefined);
});
const drain = (t: T) => t.finishAllScheduledFunctions(vi.runAllTimers);
const HOUR = 3_600_000;

type Dev = { deviceId: Id<"devices">; secret: string };

/** An organization with one group of three PCs (one per ring), two admins (the second one is "the other admin") and a viewer. */
async function setup(o: { rings?: boolean } = {}) {
  const t = await setupAuth();
  const orgId = await makeOrg(t, "Acme");
  const groupId = await t.run((ctx) => ctx.db.insert("groups", { orgId, name: "Sales", revision: 0, createdAt: Date.now() }));
  const pilot = await enrollDevice(t, orgId, { groupId, name: "Pilot PC" });
  const early = await enrollDevice(t, orgId, { groupId, name: "Early PC" });
  const everyone = await enrollDevice(t, orgId, { groupId, name: "Everyone PC" });
  const adm = await asMember(t, { role: "admin", orgId });
  await giveStepUp(t, adm);
  const adm2 = await asMember(t, { role: "admin", orgId });
  await giveStepUp(t, adm2);
  const view = await asMember(t, { role: "viewer", orgId });
  const e = { t, orgId, groupId, pilot, early, everyone, admin: adm.as, admin2: adm2.as, viewer: view.as };
  // Version 1 (nothing assigned): every PC gets a configuration.
  await t.run((ctx) => snapshotGroupConfig(ctx, groupId, "first"));
  await drain(t);
  if (o.rings === true) await ringsOn(e);
  return e;
}
type Env = Awaited<ReturnType<typeof setup>>;

const view = (e: Env) => e.admin.query(api.rollouts.groupView, { groupId: e.groupId });
const rev = async (e: Env) => (await view(e)).rollout?.revision ?? 0;
const rolloutRow = (e: Env) => e.t.run((ctx) => ctx.db.query("groupRollouts").withIndex("by_group", (q) => q.eq("groupId", e.groupId)).unique());
const audits = (e: Env) => e.t.run(async (ctx) => (await ctx.db.query("auditLog").collect()).map((a) => a.action));

/** Pilot PC in the pilot ring, Early PC in the early ring (the third stays in everyone), then rings on. */
async function ringsOn(e: Env) {
  await e.admin.mutation(api.rollouts.setRings, { groupId: e.groupId, deviceIds: [e.pilot.deviceId], ring: "pilot", expectedRevision: await rev(e) });
  await e.admin.mutation(api.rollouts.setRings, { groupId: e.groupId, deviceIds: [e.early.deviceId], ring: "early", expectedRevision: await rev(e) });
  await e.admin.mutation(api.rollouts.setEnabled, { groupId: e.groupId, enabled: true, expectedRevision: await rev(e) });
  await drain(e.t);
}

/** Assign a new open Wi-Fi profile to the group and take a configuration version from it (what a Wi-Fi save does). */
async function addNetwork(e: Env, ssid: string): Promise<Id<"wifiProfiles">> {
  const id = await addWifi(e.t, e.orgId, { groupIds: [e.groupId], ssid, security: "open", passphrase: null });
  await e.t.run((ctx) => snapshotGroupConfig(ctx, e.groupId, `Wi-Fi ${ssid}`));
  await drain(e.t);
  return id;
}

/** A new configuration version without a Wi-Fi profile (the per-device Wi-Fi cap is 20): toggle a lockdown setting of the group. */
async function newVersion(e: Env, i: number): Promise<void> {
  await e.t.run(async (ctx) => {
    const settings = { ...DEFAULT_LOCKDOWN_SETTINGS, accessibilityTools: i % 2 === 0 ? !DEFAULT_LOCKDOWN_SETTINGS.accessibilityTools : DEFAULT_LOCKDOWN_SETTINGS.accessibilityTools };
    const row = await ctx.db.query("groupLockdown").withIndex("by_group", (q) => q.eq("groupId", e.groupId)).unique();
    if (row === null) await ctx.db.insert("groupLockdown", { orgId: e.orgId, groupId: e.groupId, settings, revision: 0 });
    else await ctx.db.patch(row._id, { settings });
    await snapshotGroupConfig(ctx, e.groupId, `Version ${i}`);
  });
  await drain(e.t);
}

type Parsed = { version: number; doc: Record<string, unknown> & { config?: { groupId: string; version: number; ring: string }; wifi?: { ssid: string }[] } };
/** The PC's newest signed document (what the agent verifies and applies). */
async function docOf(e: Env, d: Dev): Promise<Parsed> {
  const head = await e.t.query(api.devices.headState, { deviceId: d.deviceId, deviceSecret: d.secret });
  if (head.kind !== "ok" || head.head === null) throw new Error("no head");
  const env = await e.t.query(api.devices.fetchDesired, { deviceId: d.deviceId, deviceSecret: d.secret, version: head.head.version });
  return { version: head.head.version, doc: (JSON.parse(env.payload) as { doc: Parsed["doc"] }).doc };
}
const ssids = (p: Parsed) => (p.doc.wifi ?? []).map((w) => w.ssid);
const configVersion = (p: Parsed) => p.doc.config?.version;
const versionCount = (e: Env, d: Dev) =>
  e.t.run(async (ctx) => (await ctx.db.query("desiredVersions").withIndex("by_device_version", (q) => q.eq("deviceId", d.deviceId)).collect()).length);

type ReportState = Doc<"deviceApplyReports">["state"];
async function report(e: Env, d: Dev, version: number, ring: "pilot" | "early" | "everyone", state: ReportState = "applied") {
  await e.t.run(async (ctx) => {
    const old = await ctx.db.query("deviceApplyReports").withIndex("by_device", (q) => q.eq("deviceId", d.deviceId)).unique();
    if (old !== null) await ctx.db.delete(old._id);
    const off = { mode: "off", state: "ok" };
    await ctx.db.insert("deviceApplyReports", {
      orgId: e.orgId,
      deviceId: d.deviceId,
      appliedVersion: 1,
      config: { groupId: e.groupId, version, ring },
      state,
      layers: { staff: off, machine: off, appLocker: off, appControl: off, procWatch: off, boot: off, performance: off },
      wifi: [],
      printers: [],
      capabilities: [],
      contentHash: "f".repeat(63) + String(version % 10),
      updatedAt: Date.now(),
    });
  });
}
const health = (e: Env) => e.admin.query(api.rollouts.health, { groupId: e.groupId });
/** Move the stage clock back, as if the bake time had passed (a test clock that moves also expires the admin sessions). */
const ageStage = (e: Env, hours: number) =>
  e.t.run(async (ctx) => {
    const r = (await ctx.db.query("groupRollouts").withIndex("by_group", (q) => q.eq("groupId", e.groupId)).unique())!;
    await ctx.db.patch(r._id, { stageStartedAt: Date.now() - hours * HOUR });
  });
const evaluate = async (e: Env) => {
  const r = (await rolloutRow(e))!;
  await e.t.mutation(internal.rollouts.evaluate, { rolloutId: r._id });
  await drain(e.t);
};

describe("rings, pointers and the publisher", () => {
  test("rings on needs a pilot PC; a change reaches the pilot ring first, promotion moves it outward, and nobody sees an in-between version", async () => {
    const e = await setup();
    // No PC in the pilot ring yet.
    await expect(e.admin.mutation(api.rollouts.setEnabled, { groupId: e.groupId, enabled: true, expectedRevision: await rev(e) })).rejects.toThrow(/no_pilot_devices/);
    await ringsOn(e);
    expect(await audits(e)).toEqual(expect.arrayContaining(["rollout.enabled", "device.ringChanged"]));
    const before = { pilot: await versionCount(e, e.pilot), early: await versionCount(e, e.early), everyone: await versionCount(e, e.everyone) };

    await addNetwork(e, "Guest");
    expect((await rolloutRow(e))!).toMatchObject({ pointers: { pilot: 2, early: 1, everyone: 1 }, state: "rolling" });
    const p = await docOf(e, e.pilot);
    expect(p.doc.config).toMatchObject({ version: 2, ring: "pilot" });
    expect(ssids(p)).toEqual(["Guest"]);
    for (const d of [e.early, e.everyone]) {
      const doc = await docOf(e, d);
      expect(configVersion(doc)).toBe(1);
      expect(ssids(doc)).toEqual([]);
    }
    expect(await versionCount(e, e.early)).toBe(before.early); // the early PC was not even re-signed

    // Promote to early: the early PC gets version 2 (exactly one new document); everyone still waits.
    await e.admin.mutation(api.rollouts.promote, { groupId: e.groupId, to: "early", expectedRevision: await rev(e) });
    await drain(e.t);
    expect(ssids(await docOf(e, e.early))).toEqual(["Guest"]);
    expect((await docOf(e, e.early)).doc.config).toMatchObject({ version: 2, ring: "early" });
    expect(await versionCount(e, e.early)).toBe(before.early + 1);
    expect(configVersion(await docOf(e, e.everyone))).toBe(1);
    expect(await versionCount(e, e.pilot)).toBe(before.pilot + 1); // the pilot PC got its one change and nothing more
    expect((await rolloutRow(e))!).toMatchObject({ pointers: { pilot: 2, early: 2, everyone: 1 }, state: "rolling" });

    // Promote to everyone: idle.
    await e.admin.mutation(api.rollouts.promote, { groupId: e.groupId, to: "everyone", expectedRevision: await rev(e) });
    await drain(e.t);
    expect(configVersion(await docOf(e, e.everyone))).toBe(2);
    expect(await versionCount(e, e.everyone)).toBe(before.everyone + 1);
    expect((await rolloutRow(e))!).toMatchObject({ pointers: { pilot: 2, early: 2, everyone: 2 }, state: "idle" });
    expect(await audits(e)).toEqual(expect.arrayContaining(["rollout.promoted"]));
  });

  test("a PC that was offline for several promotions gets its ring's current version in one document", async () => {
    const e = await setup({ rings: true });
    await addNetwork(e, "One");
    await addNetwork(e, "Two"); // version 3 on the pilot pointer; early is at 1
    const early = await versionCount(e, e.early);
    await e.admin.mutation(api.rollouts.promote, { groupId: e.groupId, to: "early", expectedRevision: await rev(e) });
    await drain(e.t);
    const doc = await docOf(e, e.early);
    expect(configVersion(doc)).toBe(3);
    expect(ssids(doc)).toEqual(["One", "Two"].sort());
    expect(await versionCount(e, e.early)).toBe(early + 1);
  });

  test("promote all moves both pointers at once; promote refuses when rings are off, halted, or nothing is ahead", async () => {
    const e = await setup();
    await expect(e.admin.mutation(api.rollouts.promote, { groupId: e.groupId, to: "early", expectedRevision: await rev(e) })).rejects.toThrow(/rings_disabled/);
    await ringsOn(e);
    await expect(e.admin.mutation(api.rollouts.promote, { groupId: e.groupId, to: "early", expectedRevision: await rev(e) })).rejects.toThrow(/nothing_to_promote/);
    await expect(e.admin.mutation(api.rollouts.promoteAll, { groupId: e.groupId, expectedRevision: await rev(e) })).rejects.toThrow(/nothing_to_promote/);
    await addNetwork(e, "Guest");
    await e.admin.mutation(api.rollouts.promoteAll, { groupId: e.groupId, expectedRevision: await rev(e) });
    await drain(e.t);
    expect((await rolloutRow(e))!).toMatchObject({ pointers: { pilot: 2, early: 2, everyone: 2 }, state: "idle" });
    for (const d of [e.pilot, e.early, e.everyone]) expect(configVersion(await docOf(e, d))).toBe(2);

    await addNetwork(e, "Other");
    const r = (await rolloutRow(e))!;
    await e.t.run((ctx) => ctx.db.patch(r._id, { state: "halted", haltReason: "failure_rate" }));
    await expect(e.admin.mutation(api.rollouts.promote, { groupId: e.groupId, to: "early", expectedRevision: await rev(e) })).rejects.toThrow(/halted/);
  });

  test("turning rings off moves every pointer to the newest version at once and republishes", async () => {
    const e = await setup({ rings: true });
    await addNetwork(e, "Guest");
    expect(configVersion(await docOf(e, e.early))).toBe(1);
    await e.admin.mutation(api.rollouts.setEnabled, { groupId: e.groupId, enabled: false, expectedRevision: await rev(e) });
    await drain(e.t);
    expect((await rolloutRow(e))!).toMatchObject({ enabled: false, pointers: { pilot: 2, early: 2, everyone: 2 }, state: "idle" });
    for (const d of [e.early, e.everyone]) expect(configVersion(await docOf(e, d))).toBe(2);
    expect(await audits(e)).toContain("rollout.disabled");
    // Turning off again writes nothing.
    const current = await rev(e);
    const again = await probe(() => e.admin.mutation(api.rollouts.setEnabled, { groupId: e.groupId, enabled: false, expectedRevision: current }));
    expect(again.io.writes).toBe(0);
  });

  test("the pilot ring may not end up empty while rings are on; other groups' and revoked PCs are refused", async () => {
    const e = await setup({ rings: true });
    await expect(
      e.admin.mutation(api.rollouts.setRings, { groupId: e.groupId, deviceIds: [e.pilot.deviceId], ring: "everyone", expectedRevision: await rev(e) }),
    ).rejects.toThrow(/no_pilot_devices/);
    // With a second pilot PC the first may leave.
    await e.admin.mutation(api.rollouts.setRings, { groupId: e.groupId, deviceIds: [e.everyone.deviceId, e.pilot.deviceId], ring: "pilot", expectedRevision: await rev(e) });
    await e.admin.mutation(api.rollouts.setRings, { groupId: e.groupId, deviceIds: [e.pilot.deviceId], ring: "early", expectedRevision: await rev(e) });
    const other = await e.t.run((ctx) => ctx.db.insert("groups", { orgId: e.orgId, name: "Other", revision: 0, createdAt: Date.now() }));
    const stray = await enrollDevice(e.t, e.orgId, { groupId: other, name: "Stray" });
    await expect(
      e.admin.mutation(api.rollouts.setRings, { groupId: e.groupId, deviceIds: [stray.deviceId], ring: "pilot", expectedRevision: await rev(e) }),
    ).rejects.toThrow(/invalid_argument/);
    // Revoking a PC takes it out of its ring (so it never counts as a PC that has not applied a version).
    await e.t.run((ctx) => ctx.db.patch(e.pilot.deviceId, { ring: "pilot" }));
    const owner = await asMember(e.t, { role: "owner", orgId: e.orgId });
    await giveStepUp(e.t, owner);
    await owner.as.mutation(api.fleet.revoke, { deviceId: e.pilot.deviceId });
    expect((await e.t.run((ctx) => ctx.db.get(e.pilot.deviceId)))!.ring).toBeUndefined();
    await expect(
      e.admin.mutation(api.rollouts.setRings, { groupId: e.groupId, deviceIds: [e.pilot.deviceId], ring: "pilot", expectedRevision: await rev(e) }),
    ).rejects.toThrow(/conflict|revoked/);
  });

  test("two admins at once: the second one with the old revision gets stale_edit; a viewer cannot change anything", async () => {
    const e = await setup({ rings: true });
    const seen = await rev(e);
    await e.admin.mutation(api.rollouts.setAutoPromote, { groupId: e.groupId, enabled: true, bakeHours: 6, maxFailurePct: 20, autoRollback: true, expectedRevision: seen });
    await expect(e.admin2.mutation(api.rollouts.promoteAll, { groupId: e.groupId, expectedRevision: seen })).rejects.toThrow(/stale_edit/);
    await expect(e.viewer.mutation(api.rollouts.setEnabled, { groupId: e.groupId, enabled: false, expectedRevision: await rev(e) })).rejects.toThrow(/forbidden/);
    expect(await audits(e)).toContain("rollout.settingsChanged");
    // The same settings again: no write.
    const same = await probe(() =>
      e.admin.mutation(api.rollouts.setAutoPromote, { groupId: e.groupId, enabled: true, bakeHours: 6, maxFailurePct: 20, autoRollback: true, expectedRevision: seen + 1 }),
    );
    expect(same.io.writes).toBe(0);
    for (const bad of [{ bakeHours: 0 }, { bakeHours: 169 }, { bakeHours: 1.5 }, { maxFailurePct: 0 }, { maxFailurePct: 101 }]) {
      await expect(
        e.admin.mutation(api.rollouts.setAutoPromote, { groupId: e.groupId, enabled: true, bakeHours: 6, maxFailurePct: 20, autoRollback: true, expectedRevision: seen + 1, ...bad }),
      ).rejects.toThrow(/invalid_argument/);
    }
  });

  test("a snapshot that moves a pointer bumps the rollout revision, so a screen from before it is stale", async () => {
    const e = await setup({ rings: true });
    const seen = await rev(e);
    await addNetwork(e, "Guest");
    expect(await rev(e)).toBeGreaterThan(seen);
    await expect(e.admin.mutation(api.rollouts.promote, { groupId: e.groupId, to: "early", expectedRevision: seen })).rejects.toThrow(/stale_edit/);
  });
});

describe("rollback", () => {
  test("rollback gives the chosen rings the old content under a NEW, higher document version", async () => {
    const e = await setup(); // rings off: all three pointers
    await addNetwork(e, "Guest"); // v2
    await addNetwork(e, "Staff"); // v3
    const before = await docOf(e, e.everyone);
    expect(ssids(before)).toEqual(["Guest", "Staff"]);
    await e.admin.mutation(api.rollouts.rollback, { groupId: e.groupId, toVersion: 2, rings: ["pilot"], expectedRevision: await rev(e) });
    await drain(e.t);
    const after = await docOf(e, e.everyone);
    expect(after.version).toBeGreaterThan(before.version);
    expect(configVersion(after)).toBe(2);
    expect(ssids(after)).toEqual(["Guest"]);
    expect((await rolloutRow(e))!).toMatchObject({ pointers: { pilot: 2, early: 2, everyone: 2 }, state: "idle" });
    expect(await audits(e)).toContain("rollout.rolledBack");
    // The same target again is not a change.
    const again = await probe(() => e.admin.mutation(api.rollouts.rollback, { groupId: e.groupId, toVersion: 2, rings: ["pilot"], expectedRevision: 3 }));
    expect(again.io.writes).toBe(0);
    // A version that does not exist.
    await expect(e.admin.mutation(api.rollouts.rollback, { groupId: e.groupId, toVersion: 99, rings: ["pilot"], expectedRevision: await rev(e) })).rejects.toThrow(/version_missing/);
  });

  test("with rings on, only the chosen rings move; the rollout is halted until resumed so nothing pushes the newer version back out", async () => {
    const e = await setup({ rings: true });
    await addNetwork(e, "Guest"); // v2
    await e.admin.mutation(api.rollouts.promoteAll, { groupId: e.groupId, expectedRevision: await rev(e) });
    await addNetwork(e, "Staff"); // v3 on pilot
    await drain(e.t);
    // The pilot ring goes back to 1; early and everyone stay on 2.
    await e.admin.mutation(api.rollouts.rollback, { groupId: e.groupId, toVersion: 1, rings: ["pilot"], expectedRevision: await rev(e) });
    await drain(e.t);
    expect((await rolloutRow(e))!).toMatchObject({ pointers: { pilot: 1, early: 2, everyone: 2 }, state: "halted", haltReason: "rolled_back" });
    expect(ssids(await docOf(e, e.pilot))).toEqual([]);
    expect(ssids(await docOf(e, e.early))).toEqual(["Guest"]);
    // Resume: the stage clock restarts and the rollout is rolling again (pilot behind early is a stage of its own).
    await e.admin.mutation(api.rollouts.resume, { groupId: e.groupId, expectedRevision: await rev(e) });
    expect((await rolloutRow(e))!.state).toBe("rolling");
    expect(await audits(e)).toContain("rollout.resumed");
    await expect(e.admin.mutation(api.rollouts.resume, { groupId: e.groupId, expectedRevision: await rev(e) })).rejects.toThrow(/not_halted/);
  });

  test("the last KEEP versions are kept, plus any version a pointer still names; the version list the screen shows follows", async () => {
    const e = await setup({ rings: true });
    for (let i = 0; i < KEEP_GROUP_CONFIGS + 3; i++) await newVersion(e, i);
    const rows = await e.t.run((ctx) => ctx.db.query("groupConfigs").withIndex("by_group_version", (q) => q.eq("groupId", e.groupId)).collect());
    const versions = rows.map((r) => r.version);
    // Version 1 is still named by the early and everyone pointers: never pruned.
    expect(versions).toContain(1);
    expect(versions).toContain(KEEP_GROUP_CONFIGS + 4);
    const v = (await view(e)).versions.map((x) => x.version);
    expect(v[0]).toBe(KEEP_GROUP_CONFIGS + 4);
    expect(v).toContain(1);
    expect(v.every((n) => versions.includes(n))).toBe(true);
    expect(v.length).toBeLessThanOrEqual(KEEP_GROUP_CONFIGS + 3);
  });
});

describe("ring health and the tick", () => {
  test("health counts the stage ring's PCs: applied / failed / partial / waiting; PCs of other rings and old versions do not count", async () => {
    const e = await setup({ rings: true });
    expect(await health(e)).toMatchObject({ stage: null, applied: 0, failed: 0, waiting: 0 });
    await e.admin.mutation(api.rollouts.setRings, { groupId: e.groupId, deviceIds: [e.everyone.deviceId], ring: "pilot", expectedRevision: await rev(e) });
    await addNetwork(e, "Guest"); // v2 -> pilot ring (two PCs)
    expect(await health(e)).toMatchObject({ stage: { ring: "pilot", version: 2 }, ringSize: 2, applied: 0, waiting: 2 });
    await report(e, e.pilot, 2, "pilot", "applied");
    await report(e, e.early, 2, "early", "applied"); // not a pilot PC: ignored
    expect(await health(e)).toMatchObject({ applied: 1, failed: 0, partial: 0, waiting: 1 });
    await report(e, e.everyone, 2, "pilot", "partial");
    expect(await health(e)).toMatchObject({ applied: 1, partial: 1, waiting: 0 });
    await report(e, e.everyone, 2, "pilot", "refused");
    expect(await health(e)).toMatchObject({ applied: 1, failed: 1, partial: 0, waiting: 0 });
    // A report for the old version is not for this stage.
    await report(e, e.everyone, 1, "pilot", "applied");
    expect(await health(e)).toMatchObject({ applied: 1, failed: 0, waiting: 1 });
  });

  test("automatic promotion waits for the bake time, needs half the ring applied and no failures, and is off by default", async () => {
    const e = await setup({ rings: true });
    await e.admin.mutation(api.rollouts.setRings, { groupId: e.groupId, deviceIds: [e.everyone.deviceId], ring: "pilot", expectedRevision: await rev(e) });
    await addNetwork(e, "Guest"); // v2; pilot ring = Pilot PC + Everyone PC
    await report(e, e.pilot, 2, "pilot");
    await report(e, e.everyone, 2, "pilot");
    await ageStage(e, 100);
    // Off by default: nothing happens however long it waits.
    await evaluate(e);
    expect((await rolloutRow(e))!.pointers).toEqual({ pilot: 2, early: 1, everyone: 1 });

    await e.admin.mutation(api.rollouts.setAutoPromote, { groupId: e.groupId, enabled: true, bakeHours: 24, maxFailurePct: 50, autoRollback: true, expectedRevision: await rev(e) });
    // Inside the bake time: nothing.
    await ageStage(e, 23);
    await evaluate(e);
    expect((await rolloutRow(e))!.pointers).toEqual({ pilot: 2, early: 1, everyone: 1 });
    // After it: promoted to early, the stage clock restarts, and the audit says it was automatic.
    await ageStage(e, 25);
    await evaluate(e);
    expect((await rolloutRow(e))!).toMatchObject({ pointers: { pilot: 2, early: 2, everyone: 1 }, state: "rolling" });
    expect(await audits(e)).toContain("rollout.autoPromoted");
    expect(configVersion(await docOf(e, e.early))).toBe(2);
    // The next stage (early, one PC) has not applied: waiting PCs do not count as success.
    await ageStage(e, 100);
    await evaluate(e);
    expect((await rolloutRow(e))!.pointers).toEqual({ pilot: 2, early: 2, everyone: 1 });
    await report(e, e.early, 2, "early");
    await evaluate(e);
    expect((await rolloutRow(e))!).toMatchObject({ pointers: { pilot: 2, early: 2, everyone: 2 }, state: "idle" });
  });

  test("a pilot ring where only some PCs applied is promoted at half, not before", async () => {
    const e = await setup({ rings: true });
    await e.admin.mutation(api.rollouts.setRings, { groupId: e.groupId, deviceIds: [e.everyone.deviceId], ring: "pilot", expectedRevision: await rev(e) });
    await e.admin.mutation(api.rollouts.setAutoPromote, { groupId: e.groupId, enabled: true, bakeHours: 1, maxFailurePct: 50, autoRollback: true, expectedRevision: await rev(e) });
    await addNetwork(e, "Guest");
    await ageStage(e, 2);
    await evaluate(e); // nobody applied: edge case 25, the rollout stays rolling
    expect((await rolloutRow(e))!.state).toBe("rolling");
    expect((await rolloutRow(e))!.pointers.early).toBe(1);
    await report(e, e.pilot, 2, "pilot"); // 1 of 2 = 50 %
    await evaluate(e);
    expect((await rolloutRow(e))!.pointers.early).toBe(2);
  });

  test("a failure share at the threshold halts the rollout, returns the pilot ring to the early version and audits both", async () => {
    const e = await setup({ rings: true });
    await e.admin.mutation(api.rollouts.setRings, { groupId: e.groupId, deviceIds: [e.everyone.deviceId], ring: "pilot", expectedRevision: await rev(e) });
    await addNetwork(e, "Guest"); // v2 on the pilot ring (2 PCs)
    await report(e, e.pilot, 2, "pilot", "applied");
    await report(e, e.everyone, 2, "pilot", "failed"); // 1 of 2 = 50 % >= the default 10 %
    const before = await docOf(e, e.pilot);
    expect(configVersion(before)).toBe(2);
    await evaluate(e);
    expect((await rolloutRow(e))!).toMatchObject({ state: "halted", haltReason: "failure_rate", pointers: { pilot: 1, early: 1, everyone: 1 } });
    expect(await audits(e)).toEqual(expect.arrayContaining(["rollout.halted", "rollout.rolledBack"]));
    const after = await docOf(e, e.pilot);
    expect(configVersion(after)).toBe(1);
    expect(after.version).toBeGreaterThan(before.version); // old content, new document version
    // A halted rollout is not evaluated again.
    const r = (await rolloutRow(e))!;
    const again = await probe(() => e.t.mutation(internal.rollouts.evaluate, { rolloutId: r._id }));
    expect(again.io.writes).toBe(0);
  });

  test("one failure among many stays below the threshold; with auto-rollback off a halt leaves the pilot pointer alone", async () => {
    const e = await setup({ rings: true });
    await e.admin.mutation(api.rollouts.setRings, { groupId: e.groupId, deviceIds: [e.everyone.deviceId], ring: "pilot", expectedRevision: await rev(e) });
    await e.admin.mutation(api.rollouts.setAutoPromote, { groupId: e.groupId, enabled: false, bakeHours: 24, maxFailurePct: 60, autoRollback: false, expectedRevision: await rev(e) });
    await addNetwork(e, "Guest");
    await report(e, e.pilot, 2, "pilot", "applied");
    await report(e, e.everyone, 2, "pilot", "refused"); // 50 % < 60 %
    await evaluate(e);
    expect((await rolloutRow(e))!.state).toBe("rolling");
    await e.admin.mutation(api.rollouts.setAutoPromote, { groupId: e.groupId, enabled: false, bakeHours: 24, maxFailurePct: 50, autoRollback: false, expectedRevision: await rev(e) });
    await evaluate(e);
    expect((await rolloutRow(e))!).toMatchObject({ state: "halted", haltReason: "failure_rate", pointers: { pilot: 2, early: 1, everyone: 1 } });
    expect(await audits(e)).not.toContain("rollout.rolledBack");
  });

  test("a pilot PC that rolled the configuration back halts the rollout at once, even in the early stage", async () => {
    const e = await setup({ rings: true });
    await addNetwork(e, "Guest");
    await e.admin.mutation(api.rollouts.promote, { groupId: e.groupId, to: "early", expectedRevision: await rev(e) });
    await drain(e.t);
    // The early stage is the one in flight; the pilot PC reports a local rollback of version 2.
    await report(e, e.pilot, 2, "pilot", "rolledBack");
    await evaluate(e);
    expect((await rolloutRow(e))!).toMatchObject({ state: "halted", haltReason: "pilot_rolled_back", pointers: { pilot: 2, early: 2, everyone: 1 } });
    // Resume clears the halt and the rollout is rolling again (the early stage).
    await e.admin.mutation(api.rollouts.resume, { groupId: e.groupId, expectedRevision: await rev(e) });
    const resumed = (await rolloutRow(e))!;
    expect(resumed.state).toBe("rolling");
    expect(resumed.haltReason).toBeUndefined();
  });

  test("the tick hands each rolling group to its own evaluation; idle, halted and ring-less groups cost nothing and are untouched", async () => {
    const e = await setup({ rings: true });
    await e.admin.mutation(api.rollouts.setAutoPromote, { groupId: e.groupId, enabled: true, bakeHours: 1, maxFailurePct: 50, autoRollback: true, expectedRevision: await rev(e) });
    // Idle: the tick finds nothing.
    const idle = await probe(() => e.t.mutation(internal.rollouts.tick, {}));
    expect(idle.io.writes).toBe(0);
    await addNetwork(e, "Guest");
    await report(e, e.pilot, 2, "pilot");
    await ageStage(e, 2);
    await e.t.mutation(internal.rollouts.tick, {});
    await drain(e.t);
    expect((await rolloutRow(e))!.pointers).toEqual({ pilot: 2, early: 2, everyone: 1 });
  });

  test("a rollout whose group was deleted goes idle instead of looping", async () => {
    const e = await setup({ rings: true });
    await addNetwork(e, "Guest");
    await e.t.run((ctx) => ctx.db.delete(e.groupId));
    await evaluate(e);
    expect((await e.t.run((ctx) => ctx.db.query("groupRollouts").collect()))[0]).toMatchObject({ state: "idle" });
  });
});

describe("what rings never gate", () => {
  test("a device lock and a broadcast reach every ring at once, while the configuration waits in the pilot ring", async () => {
    const e = await setup({ rings: true });
    await addNetwork(e, "Guest"); // pilot only
    await e.admin.mutation(api.broadcasts.send, { target: { kind: "group", id: e.groupId }, style: "banner", title: "Hello", body: "Maintenance tonight.", ackRequired: false });
    const owner = await asMember(e.t, { role: "owner", orgId: e.orgId });
    await giveStepUp(e.t, owner);
    await owner.as.mutation(api.fleet.lock, { deviceId: e.everyone.deviceId, message: "Locked for repair." });
    await drain(e.t);
    for (const d of [e.pilot, e.early, e.everyone]) {
      const doc = (await docOf(e, d)).doc as { broadcasts?: { title: string }[] };
      expect(doc.broadcasts?.map((b) => b.title)).toEqual(["Hello"]);
    }
    expect(((await docOf(e, e.everyone)).doc as { deviceLock?: { message: string } }).deviceLock?.message).toBe("Locked for repair.");
    expect(configVersion(await docOf(e, e.everyone))).toBe(1); // the configuration did not move
    expect(configVersion(await docOf(e, e.pilot))).toBe(2);
  });

  test("a PC moved to another group follows that group's pointer for its ring at once", async () => {
    const e = await setup({ rings: true });
    await addNetwork(e, "Guest"); // v2: pilot only
    const other = await e.t.run((ctx) => ctx.db.insert("groups", { orgId: e.orgId, name: "Other", revision: 0, createdAt: Date.now() }));
    await e.t.run((ctx) => snapshotGroupConfig(ctx, other, "first"));
    await drain(e.t);
    const rev0 = (await e.t.run((ctx) => ctx.db.get(e.pilot.deviceId)))!.revision ?? 0;
    await e.admin.mutation(api.fleet.move, { deviceId: e.pilot.deviceId, expectedRevision: rev0, groupId: other });
    await drain(e.t);
    // The pilot PC is now in a group that has no rings: version 1 of that group, and its Wi-Fi list is the other group's (empty).
    const doc = await docOf(e, e.pilot);
    expect(doc.doc.config).toMatchObject({ groupId: other, version: 1 });
    expect(ssids(doc)).toEqual([]);
  });
});

describe("Wi-Fi boxes for a PC on an older pointer (decision, Step 16)", () => {
  test("an early-ring PC that still names the older profile revision gets the box sealed for the live revision", async () => {
    const e = await setup({ rings: false });
    // Keys + a secured profile with a passphrase, both PCs with a sealing key.
    await createKeys(e.t, e.orgId);
    await giveSealKey(e.t, e.pilot.deviceId, 5);
    await giveSealKey(e.t, e.early.deviceId, 6);
    const wifi = await addWifi(e.t, e.orgId, { groupIds: [e.groupId], ssid: "Office" });
    await e.t.run((ctx) => snapshotGroupConfig(ctx, e.groupId, "wifi")); // v2: profile revision 1
    await drain(e.t);
    await e.t.action(internal.seal.forDevices, { orgId: e.orgId, deviceIds: [e.pilot.deviceId, e.early.deviceId] });
    await drain(e.t);
    await ringsOn(e);
    const sealedOf = async (d: Dev) => ((await docOf(e, d)).doc.wifi as unknown as { sealed: unknown }[])[0]?.sealed ?? null;
    expect(await sealedOf(e.early)).not.toBeNull();

    // The profile is edited (revision 2, same SSID changed) and the pilot ring gets version 3; the early PC stays on version 2 = revision 1.
    await e.t.run(async (ctx) => {
      await ctx.db.patch(wifi, { ssid: "Office-5G", revision: 2 });
    });
    await setWifiPassphrase(e.t, e.orgId, wifi, "a new passphrase 1", 2);
    await e.t.run((ctx) => snapshotGroupConfig(ctx, e.groupId, "edit"));
    await drain(e.t);
    await e.t.action(internal.seal.forDevices, { orgId: e.orgId, deviceIds: [e.pilot.deviceId, e.early.deviceId] });
    await drain(e.t);
    const early = await docOf(e, e.early);
    expect(configVersion(early)).toBe(2);
    expect(early.doc.wifi).toHaveLength(1);
    // The box is there (the live one, sealed for this PC), although the document still names revision 1.
    expect(await sealedOf(e.early)).not.toBeNull();
    const row = await e.t.run((ctx) => ctx.db.query("deviceSealedSecrets").withIndex("by_device_target", (q) => q.eq("deviceId", e.early.deviceId).eq("purpose", "wifi").eq("targetId", wifi)).first());
    expect(row!.targetRevision).toBe(2);
    expect(await sealedOf(e.pilot)).not.toBeNull();
  });
});

describe("pure decisions", () => {
  const rollout = (over: Partial<Doc<"groupRollouts">["autoPromote"]> = {}, stageStartedAt: number | null = 0) => ({
    autoPromote: { enabled: true, bakeHours: 24, maxFailurePct: 10, ...over },
    stageStartedAt: stageStartedAt ?? undefined,
  });
  const h = (over: Partial<Health> = {}): Health => ({
    ...EMPTY_HEALTH,
    stage: { ring: "pilot", version: 2 },
    ringSize: 10,
    applied: 6,
    ...over,
  });
  const DAY = 24 * HOUR;

  test("stage and pointer helpers", () => {
    expect(stageOf({ pilot: 3, early: 2, everyone: 1 })).toEqual({ ring: "pilot", version: 3 });
    expect(stageOf({ pilot: 3, early: 3, everyone: 1 })).toEqual({ ring: "early", version: 3 });
    expect(stageOf({ pilot: 3, early: 3, everyone: 3 })).toBeNull();
    expect(promotedPointers({ pilot: 3, early: 2, everyone: 1 }, "early")).toEqual({ pilot: 3, early: 3, everyone: 1 });
    expect(promotedPointers({ pilot: 3, early: 2, everyone: 1 }, "everyone")).toEqual({ pilot: 3, early: 2, everyone: 2 });
    expect(promotedPointers({ pilot: 3, early: 3, everyone: 1 }, "early")).toBeNull();
    expect(promotedPointers({ pilot: 3, early: 3, everyone: 3 }, "everyone")).toBeNull();
  });

  test("promote only after the bake time, with no failure and at least half the ring (and one PC) applied", () => {
    expect(decide(rollout(), h(), DAY)).toEqual({ action: "promote", to: "early" });
    expect(decide(rollout(), h(), DAY - 1)).toEqual({ action: "none" });
    expect(decide(rollout(), h({ applied: 4 }), DAY)).toEqual({ action: "none" });
    expect(decide(rollout(), h({ applied: 5 }), DAY)).toEqual({ action: "promote", to: "early" });
    expect(decide(rollout({ maxFailurePct: 100 }), h({ failed: 1 }), DAY)).toEqual({ action: "none" });
    expect(decide(rollout(), h({ ringSize: 1, applied: 0, waiting: 1 }), 100 * DAY)).toEqual({ action: "none" });
    expect(decide(rollout(), h({ ringSize: 1, applied: 1 }), DAY)).toEqual({ action: "promote", to: "early" });
    expect(decide(rollout({ enabled: false }), h(), DAY)).toEqual({ action: "none" });
    expect(decide(rollout({}, null), h(), DAY)).toEqual({ action: "none" });
    expect(decide(rollout(), h({ stage: { ring: "early", version: 2 } }), DAY)).toEqual({ action: "promote", to: "everyone" });
    expect(decide(rollout(), EMPTY_HEALTH, DAY)).toEqual({ action: "none" });
  });

  test("halt at the failure share, or on a pilot rollback, whatever the bake time; halting beats promoting", () => {
    expect(decide(rollout({ enabled: false }), h({ applied: 9, failed: 1 }), 0)).toEqual({ action: "halt", reason: "failure_rate" }); // 10 %
    expect(decide(rollout({ enabled: false }), h({ applied: 10, failed: 1 }), 0)).toEqual({ action: "none" }); // 9.09 %
    expect(decide(rollout(), h({ pilotRolledBack: true }), DAY)).toEqual({ action: "halt", reason: "pilot_rolled_back" });
    expect(decide(rollout(), h({ applied: 9, failed: 1 }), 100 * DAY)).toEqual({ action: "halt", reason: "failure_rate" });
    expect(decide(rollout(), h({ applied: 0, failed: 0, waiting: 10 }), 0)).toEqual({ action: "none" });
  });

  test("the version list keeps the newest KEEP versions and any a pointer names, and reports no change when nothing changes", () => {
    const entry = (version: number) => ({ version, reason: `r${version}`, createdAt: version });
    const have = [entry(1), entry(2)];
    expect(withVersion(have, entry(2), 1, { pilot: 2, early: 2, everyone: 2 })).toBeNull();
    expect(withVersion(have, entry(3), 1, { pilot: 3, early: 2, everyone: 2 })!.map((x) => x.version)).toEqual([1, 2, 3]);
    // keepFrom 3: version 1 is pointed at, version 2 is not.
    expect(withVersion(have, entry(3), 3, { pilot: 3, early: 1, everyone: 1 })!.map((x) => x.version)).toEqual([1, 3]);
    expect(withVersion(undefined, entry(1), 1, { pilot: 1, early: 1, everyone: 1 })!.map((x) => x.version)).toEqual([1]);
  });
});
