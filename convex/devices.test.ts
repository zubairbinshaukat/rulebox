import { afterEach, describe, expect, test, vi } from "vitest";
import { setupAuth } from "../tests/convex/auth";
import { deviceRows, enrollDevice, legacyDevice, onlineCount, orgStatsOf, probe } from "../tests/convex/devices";
import { makeOrg, type T } from "../tests/convex/identity";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { sha256HexSync } from "./lib/crypto";
import { checkDevice, settleRotation } from "./lib/deviceAuth";
import { diskBandOf } from "./lib/deviceReport";
import { isOutOfSupport, majorBuild, trackOf } from "./lib/lifecycle";
import { MINUTE_MS } from "./lib/limits";
import { scopedDb } from "./lib/orgDb";
import { offlineAfterBucket } from "./lib/presence";

// The agent's wire contract (plan 5.1 amended) on the Step 7 tables: the
// installed Phase 2 agent (apps/agent/src/backend/convex.rs) calls
// enrollment:enroll, devices:desiredState, devices:heartbeat and
// devices:unenroll with exactly these argument and answer shapes.

const SECRET = "device-secret-0123456789";
const TOKEN = "ABCDEFGHJKMNPQRSTVWX";
const DEFAULT_INTERVAL = 30 * MINUTE_MS;

afterEach(() => {
  vi.useRealTimers();
});

/** Freeze `Date.now()` (convex-test reads the same clock). */
function at(ms: number): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(ms);
}

async function seed(t: T) {
  const orgId = await makeOrg(t);
  const tokenId = await t.run((ctx) =>
    ctx.db.insert("enrollmentTokens", {
      orgId,
      tokenHash: sha256HexSync(TOKEN),
      expiresAt: Date.now() + 3_600_000,
      usesLeft: 1,
      createdAt: Date.now(),
    }),
  );
  return { orgId, tokenId };
}

const enrollArgs = {
  token: TOKEN,
  deviceSecretHash: sha256HexSync(SECRET),
  deviceName: "  Front desk PC  ",
  agentVersion: "0.4.0",
  compat: { blockers: [] },
};

/** The status object as the Phase 2 agent serializes it (`StatusReport`, 12 keys). */
const AGENT_STATUS = {
  agentVersion: "0.4.0",
  os: "Windows 11 Pro",
  osBuild: "26100.4351",
  osEdition: "Professional",
  ramMb: 4096,
  diskFreeGb: 31,
  lockdownLevel: "standard",
  kioskPhase: "applied",
  appliedVersion: 3,
  shellHealth: "ok",
  compat: { blockers: [], warnings: [], liteMode: true },
};

describe("enrollment:enroll (Step 7 rows)", () => {
  test("creates identity, credentials, presence (online), summary and report; idempotent; used-up token refused", async () => {
    const t = await setupAuth();
    const { orgId, tokenId } = await seed(t);
    const first = await t.mutation(api.enrollment.enroll, enrollArgs);
    expect(Object.keys(first).sort()).toEqual(["deviceId", "deviceName", "orgId", "serverTimeMs"]);
    expect(first).toMatchObject({ orgId, deviceName: "Front desk PC" });
    const rows = await deviceRows(t, first.deviceId);
    expect(rows.device?.secretHash).toBeUndefined();
    expect(rows.device?.agentVersion).toBeUndefined();
    expect(rows.cred).toMatchObject({ orgId, secretHash: sha256HexSync(SECRET), state: "active" });
    expect(rows.liveness).toMatchObject({ online: true, pingIntervalMs: DEFAULT_INTERVAL });
    expect(rows.presence).toMatchObject({ online: true });
    expect(rows.summary).toMatchObject({ agentVersion: "0.4.0", outOfSupport: false });
    expect(rows.report).toMatchObject({ agentVersion: "0.4.0", compat: { blockers: [] } });
    expect(await onlineCount(t, orgId)).toBe(1);
    expect(await orgStatsOf(t, orgId)).toMatchObject({ deviceCount: 1, noGroupDeviceCount: 1 });

    const again = await t.mutation(api.enrollment.enroll, enrollArgs);
    expect(again.deviceId).toBe(first.deviceId);
    expect((await t.run((ctx) => ctx.db.get(tokenId)))?.usesLeft).toBe(0);
    await expect(
      t.mutation(api.enrollment.enroll, { ...enrollArgs, deviceSecretHash: sha256HexSync("other") }),
    ).rejects.toMatchObject({ data: { code: "token_used_up" } });
  });

  test("wire error codes stay as in Phase 2", async () => {
    const t = await setupAuth();
    await seed(t);
    await expect(t.mutation(api.enrollment.enroll, { ...enrollArgs, token: "nope" })).rejects.toMatchObject({
      data: { code: "token_invalid" },
    });
    await expect(t.mutation(api.enrollment.enroll, { ...enrollArgs, deviceSecretHash: "xyz" })).rejects.toMatchObject({
      data: { code: "invalid_request" },
    });
  });
});

async function enrolled(t: T): Promise<Id<"devices">> {
  await seed(t);
  return (await t.mutation(api.enrollment.enroll, enrollArgs)).deviceId;
}

describe("devices (Phase 2 agent functions)", () => {
  test("desiredState answers unknownDevice for a wrong secret or garbage id, ok otherwise", async () => {
    const t = await setupAuth();
    const deviceId = await enrolled(t);
    expect(await t.query(api.devices.desiredState, { deviceId, deviceSecret: "wrong" })).toEqual({ kind: "unknownDevice" });
    expect(await t.query(api.devices.desiredState, { deviceId: "garbage", deviceSecret: SECRET })).toEqual({
      kind: "unknownDevice",
    });
    expect(await t.query(api.devices.desiredState, { deviceId, deviceSecret: SECRET })).toEqual({ kind: "ok", desired: null });
  });

  test("desiredState returns the newest Phase 2 document, device scope first, then the group's", async () => {
    const t = await setupAuth();
    const deviceId = await enrolled(t);
    const device = (await t.run((ctx) => ctx.db.get(deviceId)))!;
    const groupId = await t.run((ctx) => ctx.db.insert("groups", { orgId: device.orgId, name: "G" }));
    await t.run((ctx) => ctx.db.patch(deviceId, { groupId }));
    await t.run((ctx) => ctx.db.insert("desiredStates", { orgId: device.orgId, scope: groupId, version: 7, doc: { kioskEnabled: false } }));
    expect(await t.query(api.devices.desiredState, { deviceId, deviceSecret: SECRET })).toEqual({
      kind: "ok",
      desired: { version: 7, doc: { kioskEnabled: false }, signature: null },
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("desiredStates", { orgId: device.orgId, scope: deviceId, version: 1, doc: { kioskEnabled: false } });
      await ctx.db.insert("desiredStates", { orgId: device.orgId, scope: deviceId, version: 2, doc: { kioskEnabled: true } });
    });
    expect(await t.query(api.devices.desiredState, { deviceId, deviceSecret: SECRET })).toEqual({
      kind: "ok",
      desired: { version: 2, doc: { kioskEnabled: true }, signature: null },
    });
  });

  test("heartbeat: Phase 2 answer (+ additive keys), interval from the settings, status written only on change, never `devices`", async () => {
    const t = await setupAuth();
    const deviceId = await enrolled(t);
    expect(await t.mutation(api.devices.heartbeat, { deviceId, deviceSecret: "wrong" })).toEqual({ kind: "rejected" });
    const now = Date.now();
    at(now);
    const before = await t.run((ctx) => ctx.db.get(deviceId));
    const first = await t.mutation(api.devices.heartbeat, { deviceId, deviceSecret: SECRET, status: AGENT_STATUS });
    expect(first).toEqual({ kind: "ok", nextPingInMs: DEFAULT_INTERVAL, serverTimeMs: now, rotateCredential: false, planState: "ok" });
    const rows = await deviceRows(t, deviceId);
    expect(rows.summary).toMatchObject({ windowsBuild: "26100.4351", kioskPhase: "applied", appliedVersion: 3, diskBand: "20to50" });
    expect(rows.report).toMatchObject({ osEdition: "Professional", diskFreeGb: 31, shellHealth: "ok" });

    // Same status within the same minute: nothing is written at all.
    const same = await probe(() => t.mutation(api.devices.heartbeat, { deviceId, deviceSecret: SECRET, status: AGENT_STATUS }));
    expect(same.result).toMatchObject({ kind: "ok" });
    expect(same.io.writes).toBe(0);
    // Disk 31 -> 33 GB stays in the 20-50 band: no write either.
    const band = await probe(() =>
      t.mutation(api.devices.heartbeat, { deviceId, deviceSecret: SECRET, status: { ...AGENT_STATUS, diskFreeGb: 33 } }),
    );
    expect(band.io.writes).toBe(0);
    // A list column changes: summary + report, nothing else.
    const phase = await probe(() =>
      t.mutation(api.devices.heartbeat, { deviceId, deviceSecret: SECRET, status: { ...AGENT_STATUS, kioskPhase: "pending" } }),
    );
    expect(phase.io.writes).toBe(2);
    expect([...phase.io.tables].sort()).toEqual(["deviceCredentials", "deviceLiveness", "deviceReports", "deviceSummary"]);
    // The device row (identity) never changes.
    expect(await t.run((ctx) => ctx.db.get(deviceId))).toEqual(before);
  });

  test("heartbeat accepts the two Step 7 status keys before any agent sends them", async () => {
    const t = await setupAuth();
    const deviceId = await enrolled(t);
    const status = { ...AGENT_STATUS, trustedKeyIds: ["0123456789abcdef"], restartPending: true };
    expect(await t.mutation(api.devices.heartbeat, { deviceId, deviceSecret: SECRET, status })).toMatchObject({ kind: "ok" });
    expect((await deviceRows(t, deviceId)).report).toMatchObject({ trustedKeyIds: ["0123456789abcdef"], restartPending: true });
    // Nulls (a Rust None) clear the fields again.
    const cleared = { ...AGENT_STATUS, trustedKeyIds: null, restartPending: null, kioskError: null };
    await t.mutation(api.devices.heartbeat, { deviceId, deviceSecret: SECRET, status: cleared });
    const report = (await deviceRows(t, deviceId)).report!;
    expect(report.trustedKeyIds).toBeUndefined();
    expect(report.restartPending).toBeUndefined();
  });

  test("unenroll revokes (counters, presence, audit by the device); afterwards revoked / rejected", async () => {
    const t = await setupAuth();
    const deviceId = await enrolled(t);
    const orgId = (await t.run((ctx) => ctx.db.get(deviceId)))!.orgId;
    expect(await t.mutation(api.devices.unenroll, { deviceId, deviceSecret: SECRET })).toEqual({ kind: "ok" });
    expect(await t.query(api.devices.desiredState, { deviceId, deviceSecret: SECRET })).toEqual({ kind: "revoked" });
    expect(await t.mutation(api.devices.unenroll, { deviceId, deviceSecret: SECRET })).toEqual({ kind: "rejected" });
    expect(await t.mutation(api.devices.heartbeat, { deviceId, deviceSecret: SECRET })).toEqual({ kind: "rejected" });
    await expect(t.mutation(api.devices.ping, { deviceId, deviceSecret: SECRET })).rejects.toMatchObject({ data: { code: "device_rejected" } });
    expect(await orgStatsOf(t, orgId)).toMatchObject({ deviceCount: 0, noGroupDeviceCount: 0 });
    expect(await onlineCount(t, orgId)).toBe(0);
    expect((await deviceRows(t, deviceId)).presence).toMatchObject({ online: false, revoked: true });
    const log = await t.run((ctx) => ctx.db.query("auditLog").withIndex("by_org_at", (q) => q.eq("orgId", orgId)).take(10));
    expect(log.map((r) => [r.action, r.actorType])).toEqual([["device.enrolled", "device"], ["device.revoked", "device"]]);
  });
});

describe("checkDevice with credential rotation (plan 4.6)", () => {
  test("old and new secret both work until the new one is used in a mutation", async () => {
    const t = await setupAuth();
    const deviceId = await enrolled(t);
    const NEW = "new-device-secret-9876543210";
    await t.run(async (ctx) => {
      const c = (await ctx.db.query("deviceCredentials").withIndex("by_device", (q) => q.eq("deviceId", deviceId)).unique())!;
      await ctx.db.patch(c._id, { previousSecretHash: sha256HexSync(SECRET), secretHash: sha256HexSync(NEW) });
    });
    const viaOld = await t.run((ctx) => checkDevice(ctx, { deviceId, deviceSecret: SECRET }));
    expect(viaOld).toMatchObject({ kind: "ok", matched: "previous" });
    // A query never settles; a mutation with the old secret does not either.
    await t.run(async (ctx) => settleRotation(ctx, await checkDevice(ctx, { deviceId, deviceSecret: SECRET })));
    expect((await deviceRows(t, deviceId)).cred?.previousSecretHash).toBeDefined();
    expect(await t.mutation(api.devices.heartbeat, { deviceId, deviceSecret: NEW })).toMatchObject({ kind: "ok" });
    expect((await deviceRows(t, deviceId)).cred?.previousSecretHash).toBeUndefined();
    expect(await t.query(api.devices.desiredState, { deviceId, deviceSecret: SECRET })).toEqual({ kind: "unknownDevice" });
  });

  test("checkDevice reads only deviceCredentials (one row)", async () => {
    const t = await setupAuth();
    const deviceId = await enrolled(t);
    const { result, io } = await probe(() => t.run((ctx) => checkDevice({ db: scopedDb(ctx.db, null) }, { deviceId, deviceSecret: SECRET })));
    expect(result.kind).toBe("ok");
    expect([...io.tables]).toEqual(["deviceCredentials"]);
    expect(io.reads).toBe(1);
    expect(io.readBytes).toBeLessThan(400);
  });

  test("desiredState never reads presence, liveness, summary or report rows (status and pings do not re-run it)", async () => {
    const t = await setupAuth();
    const deviceId = await enrolled(t);
    await t.mutation(api.devices.heartbeat, { deviceId, deviceSecret: SECRET, status: AGENT_STATUS });
    const { io } = await probe(() => t.query(api.devices.desiredState, { deviceId, deviceSecret: SECRET }));
    for (const table of ["deviceReports", "deviceSummary", "deviceLiveness", "devicePresence", "deviceStatus", "orgStats", "orgPlans"]) {
      expect(io.tables.has(table), table).toBe(false);
    }
    expect([...io.tables].sort()).toEqual(["desiredStates", "deviceCredentials", "devices"]);
  });
});

describe("liveness, presence by transitions, sweep (A3)", () => {
  test("ping writes nothing within the same minute; one liveness write per new minute; 3 rows on offline -> online", async () => {
    const t = await setupAuth();
    const start = Date.now();
    at(start);
    const deviceId = await enrolled(t);
    const orgId = (await t.run((ctx) => ctx.db.get(deviceId)))!.orgId;
    const args = { deviceId, deviceSecret: SECRET };

    const same = await probe(() => t.mutation(api.devices.ping, args));
    expect(same.result).toEqual({ nextPingInMs: DEFAULT_INTERVAL, planState: "ok", rotateCredential: false });
    expect(same.io.writes).toBe(0);
    expect(same.io.reads).toBe(2); // credentials + liveness
    expect(same.io.readBytes).toBeLessThan(1_024);

    at(start + 2 * MINUTE_MS);
    const next = await probe(() => t.mutation(api.devices.ping, args));
    expect(next.io.writes).toBe(1);
    expect([...next.io.tables].sort()).toEqual(["deviceCredentials", "deviceLiveness"]);

    // Silent for longer than 2.5 x 30 min + 1 min: the sweep marks it offline once.
    const silentAt = start + 2 * MINUTE_MS + 77 * MINUTE_MS;
    expect(await t.mutation(internal.presence.sweep, { now: silentAt })).toEqual({ marked: 1 });
    expect(await t.mutation(internal.presence.sweep, { now: silentAt + 5 * MINUTE_MS })).toEqual({ marked: 0 });
    const offline = await deviceRows(t, deviceId);
    expect(offline.presence).toMatchObject({ online: false, since: Math.floor((start + 2 * MINUTE_MS) / MINUTE_MS) * MINUTE_MS });
    expect(await onlineCount(t, orgId)).toBe(0);

    at(silentAt + 6 * MINUTE_MS);
    const back = await probe(() => t.mutation(api.devices.ping, args));
    expect(back.io.writes).toBe(3);
    expect([...back.io.tables].sort()).toEqual(["deviceCredentials", "deviceLiveness", "devicePresence", "orgPresence"]);
    expect((await deviceRows(t, deviceId)).presence).toMatchObject({ online: true, since: silentAt + 6 * MINUTE_MS });
    expect(await onlineCount(t, orgId)).toBe(1);
  });

  test("the sweep leaves a device inside its deadline alone and reads only expired rows", async () => {
    const t = await setupAuth();
    const start = Date.now();
    at(start);
    const orgId = await makeOrg(t);
    const a = await enrollDevice(t, orgId);
    const b = await enrollDevice(t, orgId);
    at(start + 60 * MINUTE_MS);
    await t.mutation(api.devices.ping, { deviceId: b.deviceId, deviceSecret: b.secret });
    // a: last contact at start (deadline start + 77 min); b: start + 60 min.
    const deadline = offlineAfterBucket(Math.floor(start / MINUTE_MS), DEFAULT_INTERVAL) * MINUTE_MS;
    expect(await t.mutation(internal.presence.sweep, { now: deadline })).toEqual({ marked: 0 });
    expect(await t.mutation(internal.presence.sweep, { now: deadline + MINUTE_MS })).toEqual({ marked: 1 });
    expect((await deviceRows(t, a.deviceId)).presence?.online).toBe(false);
    expect((await deviceRows(t, b.deviceId)).presence?.online).toBe(true);
    expect(await onlineCount(t, orgId)).toBe(1);
  });
});

describe("ping interval from the settings, watch mode, check now (A4)", () => {
  test("a per-tenant override and the global default reach the device in its next answer", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const d = await enrollDevice(t, orgId);
    const hb = () => t.mutation(api.devices.heartbeat, { deviceId: d.deviceId, deviceSecret: d.secret });
    expect(await hb()).toMatchObject({ nextPingInMs: DEFAULT_INTERVAL });
    await t.mutation(internal.plans.setOrgPingInterval, { orgId, pingIntervalMs: 5 * MINUTE_MS });
    await t.finishAllScheduledFunctions(() => {});
    expect(await hb()).toMatchObject({ nextPingInMs: 5 * MINUTE_MS });
    // The global default does not override a tenant override...
    await t.mutation(internal.plans.setGlobalPingInterval, { pingIntervalMs: 60 * MINUTE_MS });
    await t.finishAllScheduledFunctions(() => {});
    expect(await hb()).toMatchObject({ nextPingInMs: 5 * MINUTE_MS });
    // ...until the override is removed.
    await t.mutation(internal.plans.setOrgPingInterval, { orgId, pingIntervalMs: null });
    await t.finishAllScheduledFunctions(() => {});
    expect(await hb()).toMatchObject({ nextPingInMs: 60 * MINUTE_MS });
  });

  test("the offline deadline follows the interval the device was told", () => {
    expect(offlineAfterBucket(100, 30 * MINUTE_MS) - 100).toBe(76);
    expect(offlineAfterBucket(100, MINUTE_MS) - 100).toBe(4);
  });
});

describe("Phase 2 device on the dev deployment: migration (A2, A3, A8; widen then narrow)", () => {
  // The exact shape of the real VM device (`npx convex data devices`, read-only, 2026-10-27).
  const VM_SECRET = "vm-device-secret-0123456789abcdef";
  const statusCall = (deviceId: Id<"devices">, secret: string) => ({ deviceId, deviceSecret: secret, status: AGENT_STATUS });

  test("before the migration the Phase 2 calls still authenticate (fallback to the devices row)", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const deviceId = await legacyDevice(t, orgId, { secret: VM_SECRET });
    await t.run((ctx) => ctx.db.insert("desiredStates", { orgId, scope: deviceId, version: 1, doc: { kioskEnabled: true } }));
    expect(await t.query(api.devices.desiredState, { deviceId, deviceSecret: VM_SECRET })).toMatchObject({ kind: "ok", desired: { version: 1 } });
    expect(await t.mutation(api.devices.heartbeat, statusCall(deviceId, VM_SECRET))).toMatchObject({ kind: "ok", nextPingInMs: DEFAULT_INTERVAL });
    expect(await t.mutation(api.devices.heartbeat, { deviceId, deviceSecret: "wrong" })).toEqual({ kind: "rejected" });
  });

  test("migrateDevices copies credentials, presence and status without touching the devices row; Phase 2 calls work after; idempotent; exact counters", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const now = Date.now();
    at(now);
    const vm = await legacyDevice(t, orgId, { secret: VM_SECRET, lastSeenAt: now - 3 * MINUTE_MS });
    const stale = await legacyDevice(t, orgId, { secret: "stale-secret", lastSeenAt: now - 10 * 24 * 60 * MINUTE_MS });
    const revoked = await legacyDevice(t, orgId, { secret: "revoked-secret", revoked: true, status: false });
    const before = await t.run((ctx) => ctx.db.get(vm));

    const first = await t.mutation(internal.maintenance.migrateDevices, {});
    expect(first).toEqual({ devices: 3, credentials: 3, liveness: 3, summaries: 2, done: true });
    await t.finishAllScheduledFunctions(() => {}); // migratePlans: exact recount

    const rows = await deviceRows(t, vm);
    expect(rows.device).toEqual(before); // the real device's row is not modified
    expect(rows.cred).toMatchObject({ deviceId: vm, orgId, secretHash: sha256HexSync(VM_SECRET), state: "active" });
    expect(rows.cred?.previousSecretHash).toBeUndefined();
    expect(rows.liveness).toMatchObject({ online: true, pingIntervalMs: DEFAULT_INTERVAL });
    expect(rows.presence).toMatchObject({ online: true });
    expect(rows.summary).toMatchObject({ windowsBuild: "26300.9457", kioskPhase: "applied", appliedVersion: 1, outOfSupport: false });
    expect(rows.report).toMatchObject({ compat: { blockers: [], liteMode: true }, diskFreeGb: 31 });
    expect((await deviceRows(t, stale)).presence).toMatchObject({ online: false });
    expect((await deviceRows(t, revoked)).cred?.state).toBe("revoked");
    expect((await deviceRows(t, revoked)).presence).toMatchObject({ online: false, revoked: true });
    expect(await orgStatsOf(t, orgId)).toMatchObject({ deviceCount: 2, noGroupDeviceCount: 2, outOfSupportCount: 0 });
    expect(await onlineCount(t, orgId)).toBe(1);

    // Replay the Phase 2 agent's calls with the exact shapes it sends.
    expect(await t.query(api.devices.desiredState, { deviceId: vm, deviceSecret: VM_SECRET })).toEqual({ kind: "ok", desired: null });
    const hb = await t.mutation(api.devices.heartbeat, statusCall(vm, VM_SECRET));
    expect(hb).toMatchObject({ kind: "ok", nextPingInMs: DEFAULT_INTERVAL, serverTimeMs: now });
    expect(await t.mutation(api.devices.heartbeat, { deviceId: vm, deviceSecret: VM_SECRET })).toMatchObject({ kind: "ok" });
    expect(await t.query(api.devices.desiredState, { deviceId: revoked, deviceSecret: "revoked-secret" })).toEqual({ kind: "revoked" });

    // Second run: nothing to create.
    expect(await t.mutation(internal.maintenance.migrateDevices, {})).toEqual({ devices: 3, credentials: 0, liveness: 0, summaries: 0, done: true });
    await t.finishAllScheduledFunctions(() => {});
    expect(await orgStatsOf(t, orgId)).toMatchObject({ deviceCount: 2, noGroupDeviceCount: 2 });
  });

  test("a newer credential written by the new code is never overwritten by the migration", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const deviceId = await legacyDevice(t, orgId, { secret: "old" });
    await t.run((ctx) => ctx.db.patch(deviceId, { previousSecretHash: sha256HexSync("old"), secretHash: sha256HexSync("new") }));
    // The agent adopts the new secret before the migration ran: settled on the devices row.
    expect(await t.mutation(api.devices.heartbeat, { deviceId, deviceSecret: "new" })).toMatchObject({ kind: "ok" });
    await t.mutation(internal.maintenance.migrateDevices, {});
    const cred = (await deviceRows(t, deviceId)).cred!;
    expect(cred.secretHash).toBe(sha256HexSync("new"));
    expect(cred.previousSecretHash).toBeUndefined();
    // A later change on the credentials row survives another run.
    await t.run((ctx) => ctx.db.patch(cred._id, { rotate: true }));
    await t.mutation(internal.maintenance.migrateDevices, {});
    expect((await deviceRows(t, deviceId)).cred?.rotate).toBe(true);
    expect(await t.mutation(api.devices.heartbeat, { deviceId, deviceSecret: "new" })).toMatchObject({ rotateCredential: true });
  });

  test("narrowDevices removes the deprecated fields of migrated devices only; the agent keeps working", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const migrated = await legacyDevice(t, orgId, { secret: VM_SECRET });
    await t.mutation(internal.maintenance.migrateDevices, {});
    await t.finishAllScheduledFunctions(() => {});
    const notYet = await legacyDevice(t, orgId, { secret: "late" });
    expect(await t.mutation(internal.maintenance.narrowDevices, {})).toEqual({ devices: 2, narrowed: 1, skipped: 1, done: true });
    const d = (await t.run((ctx) => ctx.db.get(migrated)))!;
    expect(d.secretHash).toBeUndefined();
    expect(d.revoked).toBeUndefined();
    expect(d.compat).toBeUndefined();
    expect(d.name).toBe("RULEBOX");
    expect(await t.run((ctx) => ctx.db.query("deviceStatus").withIndex("by_device", (q) => q.eq("deviceId", migrated)).first())).toBeNull();
    expect(await t.mutation(api.devices.heartbeat, statusCall(migrated, VM_SECRET))).toMatchObject({ kind: "ok" });
    expect((await t.run((ctx) => ctx.db.get(notYet)))?.secretHash).toBeDefined();
    expect(await t.mutation(internal.maintenance.narrowDevices, {})).toMatchObject({ narrowed: 0, skipped: 1 });
  });
});

describe("lifecycle and quantization", () => {
  const OCT_2026_14 = Date.UTC(2026, 9, 14);
  test("outOfSupport by build, edition track and date", () => {
    expect(majorBuild("26100.4351")).toBe(26100);
    expect(majorBuild(undefined)).toBeNull();
    expect(trackOf("Professional")).toBe("consumer");
    expect(trackOf("Core")).toBe("consumer");
    expect(trackOf("Enterprise")).toBe("enterprise");
    expect(trackOf("IoTEnterpriseS")).toBe("ltscIot");
    // 24H2 Home/Pro ended 2026-10-13; Enterprise continues.
    expect(isOutOfSupport("26100.1", "Professional", OCT_2026_14)).toBe(true);
    expect(isOutOfSupport("26100.1", "Professional", Date.UTC(2026, 9, 12))).toBe(false);
    expect(isOutOfSupport("26100.1", "Enterprise", OCT_2026_14)).toBe(false);
    expect(isOutOfSupport("26100.1", "EnterpriseS", OCT_2026_14)).toBe(false);
    // Windows 10 ended 2025-10-14, except LTSC 2021.
    expect(isOutOfSupport("19045.5000", "Professional", OCT_2026_14)).toBe(true);
    expect(isOutOfSupport("19044.5000", "EnterpriseS", OCT_2026_14)).toBe(false);
    expect(isOutOfSupport("18363.1", "Professional", Date.UTC(2020, 0, 1))).toBe(true);
    // Newer or Insider builds and unknown values: no badge.
    expect(isOutOfSupport("26300.9457", "Professional", OCT_2026_14)).toBe(false);
    expect(isOutOfSupport(undefined, undefined, OCT_2026_14)).toBe(false);
  });

  test("disk bands", () => {
    expect([undefined, 0, 4.9, 5, 9, 10, 19, 20, 49, 50, 100, 101].map(diskBandOf)).toEqual([
      undefined, "lt5", "lt5", "5to10", "5to10", "10to20", "10to20", "20to50", "20to50", "50to100", "50to100", "gt100",
    ]);
  });

  test("an out-of-support flip moves outOfSupportCount", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const d = await enrollDevice(t, orgId);
    const send = (osBuild: string) =>
      t.mutation(api.devices.heartbeat, { deviceId: d.deviceId, deviceSecret: d.secret, status: { ...AGENT_STATUS, osBuild, osEdition: "Professional" } });
    await send("19045.1");
    expect((await orgStatsOf(t, orgId))?.outOfSupportCount).toBe(1);
    await send("19045.2");
    expect((await orgStatsOf(t, orgId))?.outOfSupportCount).toBe(1);
    await send("26300.1");
    expect((await orgStatsOf(t, orgId))?.outOfSupportCount).toBe(0);
  });
});
