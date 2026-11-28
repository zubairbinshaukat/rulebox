import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { setupAuth } from "../tests/convex/auth";
import { enrollDevice, probe } from "../tests/convex/devices";
import { expectCode, makeOrg, type T } from "../tests/convex/identity";
import { setSeeds, TEST_SEED_B64 } from "../tests/convex/keys";
import { APPLY_REPORT, FINDING, SEAL_PUBLIC_KEY, SECURITY_DAILY } from "../tests/convex/matrixRows";
import { addWifi, createKeys, giveSealKey, MASTER_A, sealKeyPair, setMaster } from "../tests/convex/phase5";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { auditPolicy } from "./lib/audit";
import { MAX_ACKS_PER_CALL, MAX_FINDINGS_PER_CALL, MAX_ITEM_STATES, MAX_PERMISSION_DENIALS } from "./lib/limits";

// The Phase 5 device reports (plan 4.11, 4.17, 4.19; Step 10 item 6, 8): every one is change-driven. The write-count tests
// below pin that a report that changes nothing writes NOTHING (and takes no rate-limit token), cross-organization isolation,
// what is stored and what is dropped, and the 60-an-hour `deviceReports` bucket.

beforeEach(() => {
  vi.useFakeTimers();
  auditPolicy.strict = true;
});
afterEach(() => {
  vi.useRealTimers();
  auditPolicy.strict = false;
  setSeeds(TEST_SEED_B64);
  setMaster(undefined);
});

type Dev = { t: T; orgId: Id<"organizations">; deviceId: Id<"devices">; creds: { deviceId: Id<"devices">; deviceSecret: string }; groupId: Id<"groups"> };

async function setup(t?: T): Promise<Dev> {
  const tt = t ?? (await setupAuth());
  const orgId = await makeOrg(tt);
  const groupId = await tt.run((ctx) => ctx.db.insert("groups", { orgId, name: "Sales", revision: 0, createdAt: Date.now() }));
  const { deviceId, secret } = await enrollDevice(tt, orgId, { groupId });
  return { t: tt, orgId, deviceId, creds: { deviceId, deviceSecret: secret }, groupId };
}

const rows = <TName extends "deviceApplyReports" | "lockdownFindings" | "lockdownFindingDevices" | "deviceSecurityDaily" | "broadcastAcks" | "deviceSealedSecrets">(t: T, table: TName) =>
  t.run((ctx) => ctx.db.query(table).collect());

describe("deviceApi:reportApply", () => {
  test("an unchanged report (same content hash) writes nothing; a changed one replaces the device's single row", async () => {
    const d = await setup();
    const call = (extra: object = {}) => d.t.mutation(api.deviceApi.reportApply, { ...d.creds, ...APPLY_REPORT, ...extra });
    expect(await call()).toEqual({ written: true });
    expect(await rows(d.t, "deviceApplyReports")).toHaveLength(1);

    const again = await probe(() => call());
    expect(again.result).toEqual({ written: false });
    expect(again.io.writes).toBe(0);
    expect(again.io.reads).toBeLessThanOrEqual(2); // credentials + the one report row

    const changed = await probe(() => call({ contentHash: "d".repeat(64), appliedVersion: 2, lkgVersion: 1 }));
    expect(changed.result).toEqual({ written: true });
    expect(changed.io.writes).toBe(1); // exactly the replace of the one row
    const stored = await rows(d.t, "deviceApplyReports");
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ appliedVersion: 2, lkgVersion: 1, contentHash: "d".repeat(64), orgId: d.orgId, deviceId: d.deviceId, capabilities: ["lockdown/1"] });
  });

  test("an unknown state becomes `partial`, free text is never stored, unknown layer states become `unknown`", async () => {
    const d = await setup();
    await d.t.mutation(api.deviceApi.reportApply, {
      ...d.creds,
      ...APPLY_REPORT,
      state: "exploding",
      refusal: "C:\\Users\\Maya\\Desktop\\secret plan.docx was blocked",
      layers: { ...APPLY_REPORT.layers, appLocker: { mode: "enforce", state: "not a code!", detail: "path\\to\\thing" } },
      wifi: [{ profileId: "p1", revision: 2, state: "waiting_for_key", detail: "Net: my home wifi" }],
    });
    const [r] = await rows(d.t, "deviceApplyReports");
    expect(r!.state).toBe("partial");
    expect(r!.refusal).toBeUndefined();
    expect(r!.layers.appLocker).toEqual({ mode: "enforce", state: "unknown" });
    expect(r!.wifi).toEqual([{ profileId: "p1", revision: 2, state: "waiting_for_key" }]);
    expect(JSON.stringify(r)).not.toContain("Maya");
  });

  // Step 20b: the codes the agent's Step 20 wiring sends must survive the cleaning (a code this server drops would hide the reason from the admin).
  test("the Step 20 codes are kept: machine partial / wifi_filters_error, a failed connection, a performance restartPending", async () => {
    const d = await setup();
    await d.t.mutation(api.deviceApi.reportApply, {
      ...d.creds,
      ...APPLY_REPORT,
      state: "partial",
      layers: {
        ...APPLY_REPORT.layers,
        machine: { mode: "enforce", state: "partial", detail: "wifi_filters_error" },
        performance: { mode: "enforce", state: "restartPending" },
      },
      wifi: [{ profileId: "p1", revision: 2, state: "failed", detail: "connect_failed" }],
    });
    const [r] = await rows(d.t, "deviceApplyReports");
    expect(r!.layers.machine).toEqual({ mode: "enforce", state: "partial", detail: "wifi_filters_error" });
    expect(r!.layers.performance).toEqual({ mode: "enforce", state: "restartPending" });
    expect(r!.wifi).toEqual([{ profileId: "p1", revision: 2, state: "failed", detail: "connect_failed" }]);
    expect(r!.state).toBe("partial");
  });

  // Owner decision 2026-11-28 (guard I7): a PC without E-71 skips only `hideAdminTiles` and says so as a layer note, not a refusal.
  test("the admin_tiles_skipped warning of the machine layer survives the cleaning and the report stays `applied`", async () => {
    const d = await setup();
    await d.t.mutation(api.deviceApi.reportApply, {
      ...d.creds,
      ...APPLY_REPORT,
      state: "applied",
      layers: { ...APPLY_REPORT.layers, machine: { mode: "on", state: "ok", detail: "admin_tiles_skipped" } },
    });
    const [r] = await rows(d.t, "deviceApplyReports");
    expect(r!.layers.machine).toEqual({ mode: "on", state: "ok", detail: "admin_tiles_skipped" });
    expect(r!.state).toBe("applied");
    expect(r!.refusal).toBeUndefined();
  });

  test("a group of another organization named in `config` is dropped; too many item states and a bad hash are refused", async () => {
    const d = await setup();
    const other = await setup(d.t);
    await d.t.mutation(api.deviceApi.reportApply, { ...d.creds, ...APPLY_REPORT, config: { groupId: other.groupId, version: 3, ring: "everyone" } });
    expect((await rows(d.t, "deviceApplyReports"))[0]!.config).toBeUndefined();
    await d.t.mutation(api.deviceApi.reportApply, { ...d.creds, ...APPLY_REPORT, contentHash: "1".repeat(64), config: { groupId: d.groupId, version: 3, ring: "mystery" } });
    expect((await rows(d.t, "deviceApplyReports"))[0]!.config).toEqual({ groupId: d.groupId, version: 3, ring: "everyone" });

    const many = Array.from({ length: MAX_ITEM_STATES + 1 }, (_, i) => ({ profileId: `p${i}`, revision: 1, state: "applied" }));
    await expectCode(d.t.mutation(api.deviceApi.reportApply, { ...d.creds, ...APPLY_REPORT, contentHash: "2".repeat(64), wifi: many }), "invalid_argument");
    await expectCode(d.t.mutation(api.deviceApi.reportApply, { ...d.creds, ...APPLY_REPORT, contentHash: "NOT-A-HASH" }), "invalid_argument");
    await expectCode(d.t.mutation(api.deviceApi.reportApply, { ...d.creds, ...APPLY_REPORT, contentHash: "3".repeat(64), appliedVersion: -1 }), "invalid_argument");
    // Another device's row is untouched: each device has its own.
    expect(await rows(d.t, "deviceApplyReports")).toHaveLength(1);
    await other.t.mutation(api.deviceApi.reportApply, { ...other.creds, ...APPLY_REPORT });
    expect(await rows(d.t, "deviceApplyReports")).toHaveLength(2);
  });
});

describe("deviceApi:report with the Phase 5 status fields (plan 4.16)", () => {
  test("posture and capabilities are cleaned to bounded fixed codes and stored; the same status again writes nothing", async () => {
    const d = await setup();
    const status = {
      agentVersion: "0.5.0",
      security: {
        safeModeAgent: true,
        autoRecovery: "off",
        serviceAcl: "ok",
        aclDrift: 2,
        secureBoot: "on",
        bitLocker: "C:\\Users\\Maya\\key.txt",
        tpm: "present",
        ciPolicies: ["{ABC-123}", "C:\\bad path", "x".repeat(80)],
        somethingNewer: { nested: true },
      },
      capabilities: ["lockdown/1", "drivers/1", "bad cap!", "lockdown/1"],
    };
    await d.t.mutation(api.deviceApi.report, { ...d.creds, status });
    const report = () => d.t.run((ctx) => ctx.db.query("deviceReports").withIndex("by_device", (q) => q.eq("deviceId", d.deviceId)).unique());
    const r = await report();
    expect(r!.capabilities).toEqual(["drivers/1", "lockdown/1"]);
    expect(r!.security).toEqual({ safeModeAgent: true, autoRecovery: "off", serviceAcl: "ok", aclDrift: 2, secureBoot: "on", tpm: "present", ciPolicies: ["{ABC-123}"] });
    expect(JSON.stringify(r)).not.toContain("Maya");
    const again = await probe(() => d.t.mutation(api.deviceApi.report, { ...d.creds, status }));
    expect(again.io.writes).toBe(0);
  });
});

describe("deviceApi:reportFindings", () => {
  const finding = (n: number, over: Record<string, unknown> = {}) => ({ ...FINDING, fingerprint: n.toString(16).padStart(64, "0"), ...over });

  test("a new fingerprint writes the finding and its device link; the same device again writes nothing; a second device adds a link and counts", async () => {
    const d = await setup();
    const second = await enrollDevice(d.t, d.orgId, { groupId: d.groupId, name: "PC 2" }).then((x) => ({ deviceId: x.deviceId, deviceSecret: x.secret }));
    const first = await probe(() => d.t.mutation(api.deviceApi.reportFindings, { ...d.creds, findings: [finding(1), finding(2)] }));
    expect(first.result).toEqual({ accepted: 2 });
    expect(first.io.writes).toBeLessThanOrEqual(5); // 2 x (finding + link) + the credentials settle
    expect(await rows(d.t, "lockdownFindings")).toHaveLength(2);
    expect(await rows(d.t, "lockdownFindingDevices")).toHaveLength(2);

    const repeat = await probe(() => d.t.mutation(api.deviceApi.reportFindings, { ...d.creds, findings: [finding(1), finding(2)] }));
    expect(repeat.result).toEqual({ accepted: 2 });
    expect(repeat.io.writes).toBe(0);

    await d.t.mutation(api.deviceApi.reportFindings, { ...second, findings: [finding(1)] });
    const f1 = (await rows(d.t, "lockdownFindings")).find((f) => f.fingerprint === finding(1).fingerprint)!;
    expect(f1.deviceCount).toBe(2);
    expect(await rows(d.t, "lockdownFindingDevices")).toHaveLength(3);
    expect(f1).toMatchObject({ status: "new", layer: "appLocker", fileName: "tool.exe", orgId: d.orgId, sampleDeviceId: d.deviceId });
  });

  test("organizations never share a finding row, even for the same fingerprint", async () => {
    const a = await setup();
    const b = await setup(a.t);
    await a.t.mutation(api.deviceApi.reportFindings, { ...a.creds, findings: [FINDING] });
    await b.t.mutation(api.deviceApi.reportFindings, { ...b.creds, findings: [FINDING] });
    const all = await rows(a.t, "lockdownFindings");
    expect(all.map((f) => [f.orgId, f.deviceCount]).sort()).toEqual([[a.orgId, 1], [b.orgId, 1]].sort());
    expect(await rows(a.t, "lockdownFindingDevices")).toHaveLength(2);
  });

  test("a path, a bad fingerprint, an unknown layer or a control character never reaches the table; more than 50 are refused", async () => {
    const d = await setup();
    const call = (findings: object[]) => d.t.mutation(api.deviceApi.reportFindings, { ...d.creds, findings: findings as never });
    expect(await call([finding(3, { fileName: "C:\\Users\\Maya\\tool.exe" }), finding(4, { fileName: "a/b.exe" }), finding(5, { fingerprint: "short" }), finding(6, { layer: "mystery" }), finding(7, { fileName: "x\u0001.exe" })])).toEqual({ accepted: 5 });
    expect(await rows(d.t, "lockdownFindings")).toEqual([]);
    expect(await call([finding(8, { folderClass: "C:\\Users", signer: "S".repeat(300), sha256: "nothex" })])).toEqual({ accepted: 1 });
    const [f] = await rows(d.t, "lockdownFindings");
    expect(f).toMatchObject({ folderClass: "other" });
    expect(f!.signer).toBeUndefined();
    expect(f!.sha256).toBeUndefined();
    await expectCode(call(Array.from({ length: MAX_FINDINGS_PER_CALL + 1 }, (_, i) => finding(100 + i))), "invalid_argument");
  });
});

describe("deviceApi:reportSecurityDaily", () => {
  test("an all-zero day writes nothing; the first non-zero call inserts one row; a second call the same day ADDS", async () => {
    const d = await setup();
    const zero = { ...SECURITY_DAILY, blocked: { appLocker: 0, appControl: 0, procWatch: 0, elevation: 0 }, permissionDenials: [], drift: 0, tamper: 0 };
    const z = await probe(() => d.t.mutation(api.deviceApi.reportSecurityDaily, { ...d.creds, ...zero }));
    expect(z.result).toEqual({ written: false });
    expect(z.io.writes).toBe(0);
    expect(await rows(d.t, "deviceSecurityDaily")).toEqual([]);

    const day = { ...SECURITY_DAILY, permissionDenials: [{ appId: "app1", kind: "camera", count: 2 }], drift: 1 };
    expect(await d.t.mutation(api.deviceApi.reportSecurityDaily, { ...d.creds, ...day })).toEqual({ written: true });
    await d.t.mutation(api.deviceApi.reportSecurityDaily, { ...d.creds, ...day, permissionDenials: [{ appId: "app1", kind: "camera", count: 3 }, { appId: "app2", kind: "printing", count: 1 }], tamper: 4 });
    const stored = await rows(d.t, "deviceSecurityDaily");
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ orgId: d.orgId, deviceId: d.deviceId, day: SECURITY_DAILY.day, blocked: { appLocker: 4, appControl: 0, procWatch: 2, elevation: 0 }, drift: 2, tamper: 4 });
    expect(stored[0]!.permissionDenials).toEqual([{ appId: "app1", kind: "camera", count: 5 }, { appId: "app2", kind: "printing", count: 1 }]);
  });

  test("the day must be today or at most two days back; counters must be counts; unknown permission kinds are dropped; more than 100 denial rows are refused", async () => {
    const d = await setup();
    const call = (over: object) => d.t.mutation(api.deviceApi.reportSecurityDaily, { ...d.creds, ...SECURITY_DAILY, ...over } as never);
    const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
    await expectCode(call({ day: day(1) }), "invalid_argument");
    await expectCode(call({ day: day(-3) }), "invalid_argument");
    await expectCode(call({ day: "2026-02-30" }), "invalid_argument");
    await expectCode(call({ day: "yesterday" }), "invalid_argument");
    await expectCode(call({ blocked: { appLocker: -1, appControl: 0, procWatch: 0, elevation: 0 } }), "invalid_argument");
    await expectCode(call({ drift: 1.5 }), "invalid_argument");
    expect(await call({ day: day(-2), blocked: { appLocker: 0, appControl: 0, procWatch: 0, elevation: 0 }, permissionDenials: [{ appId: "a", kind: "nosuchkind", count: 1 }] })).toEqual({ written: false });
    await expectCode(call({ permissionDenials: Array.from({ length: MAX_PERMISSION_DENIALS + 1 }, (_, i) => ({ appId: `a${i}`, kind: "camera", count: 1 })) }), "invalid_argument");
    expect(await rows(d.t, "deviceSecurityDaily")).toEqual([]);
  });
});

describe("deviceApi:reportAcks", () => {
  async function broadcast(d: Dev, target: { kind: "group" | "device"; id: string }, orgId = d.orgId) {
    return await d.t.run((ctx) =>
      ctx.db.insert("broadcasts", { orgId, target, style: "banner", title: "Hello", body: "Body", ackRequired: true, createdAt: Date.now() - 5000 }),
    );
  }

  test("one row per device and broadcast, never the employee; a repeat writes nothing; foreign and unrelated broadcasts are ignored", async () => {
    const d = await setup();
    const other = await setup(d.t);
    const mine = await broadcast(d, { kind: "group", id: d.groupId });
    const byDevice = await broadcast(d, { kind: "device", id: d.deviceId });
    const notMine = await broadcast(d, { kind: "group", id: (await d.t.run((ctx) => ctx.db.insert("groups", { orgId: d.orgId, name: "Other", revision: 0, createdAt: 1 }))) });
    const foreign = await broadcast(other, { kind: "group", id: other.groupId }, other.orgId);
    const acks = [mine, byDevice, notMine, foreign].map((broadcastId) => ({ broadcastId, atMs: Date.now() }));
    expect(await d.t.mutation(api.deviceApi.reportAcks, { ...d.creds, acks })).toEqual({ accepted: 4 });
    const stored = await rows(d.t, "broadcastAcks");
    expect(stored.map((a) => a.broadcastId).sort()).toEqual([mine, byDevice].sort());
    expect(stored.every((a) => a.deviceId === d.deviceId && a.orgId === d.orgId)).toBe(true);
    expect(JSON.stringify(stored)).not.toMatch(/employee/i);

    const again = await probe(() => d.t.mutation(api.deviceApi.reportAcks, { ...d.creds, acks }));
    expect(again.io.writes).toBe(0);
    // A bogus id and a malformed time are harmless.
    expect(await d.t.mutation(api.deviceApi.reportAcks, { ...d.creds, acks: [{ broadcastId: "nope", atMs: 1 }, { broadcastId: mine, atMs: Number.NaN }] })).toEqual({ accepted: 2 });
    await expectCode(d.t.mutation(api.deviceApi.reportAcks, { ...d.creds, acks: Array.from({ length: MAX_ACKS_PER_CALL + 1 }, () => ({ broadcastId: mine, atMs: 1 })) }), "invalid_argument");
  });
});

describe("deviceApi:registerSealKey", () => {
  const key2 = sealKeyPair(6).publicB64;

  test("a first key is stored; the same key again writes nothing; a different key replaces it, drops the old sealed boxes and asks to seal again", async () => {
    const d = await setup();
    const first = await d.t.mutation(api.deviceApi.registerSealKey, { ...d.creds, publicKey: SEAL_PUBLIC_KEY });
    expect(first.changed).toBe(true);
    expect(first.keyId).toMatch(/^[0-9a-f]{16}$/);
    const dev = await d.t.run((ctx) => ctx.db.get(d.deviceId));
    expect(dev).toMatchObject({ sealPublicKey: SEAL_PUBLIC_KEY, sealKeyId: first.keyId });

    const same = await probe(() => d.t.mutation(api.deviceApi.registerSealKey, { ...d.creds, publicKey: SEAL_PUBLIC_KEY }));
    expect(same.result).toEqual({ keyId: first.keyId, changed: false });
    expect(same.io.writes).toBe(0);

    await d.t.run((ctx) =>
      ctx.db.insert("deviceSealedSecrets", { orgId: d.orgId, deviceId: d.deviceId, purpose: "wifi", targetId: "profile", targetRevision: 1, sealKeyId: first.keyId, sealed: "AAAA", createdAt: 1 }),
    );
    const replaced = await d.t.mutation(api.deviceApi.registerSealKey, { ...d.creds, publicKey: key2 });
    expect(replaced.changed).toBe(true);
    expect(replaced.keyId).not.toBe(first.keyId);
    expect(await rows(d.t, "deviceSealedSecrets")).toEqual([]);
    const scheduled = await d.t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled.filter((s) => s.name.includes("seal:forDevices"))).toHaveLength(2); // one per change
  });

  test("a key that is not 32 bytes, all zero, malformed or a low-order point is refused", async () => {
    const d = await setup();
    const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
    const lowOrder = new Uint8Array(32);
    lowOrder[0] = 1;
    for (const bad of [b64(new Uint8Array(31)), b64(new Uint8Array(33)), b64(new Uint8Array(32)), "not base64!!", "", b64(lowOrder)]) {
      await expectCode(d.t.mutation(api.deviceApi.registerSealKey, { ...d.creds, publicKey: bad }), "invalid_argument");
    }
    expect((await d.t.run((ctx) => ctx.db.get(d.deviceId)))!.sealPublicKey).toBeUndefined();
  });

  test("the key is stored on the device's own row only; another organization's device is not touched", async () => {
    const a = await setup();
    const b = await setup(a.t);
    await a.t.mutation(api.deviceApi.registerSealKey, { ...a.creds, publicKey: SEAL_PUBLIC_KEY });
    expect((await a.t.run((ctx) => ctx.db.get(b.deviceId)))!.sealPublicKey).toBeUndefined();
  });

  test("end to end: the device registers, the sealing action boxes the Wi-Fi passphrase for exactly that device, and nothing readable is stored", async () => {
    const d = await setup();
    setMaster(MASTER_A);
    await createKeys(d.t, d.orgId);
    await addWifi(d.t, d.orgId, { groupIds: [d.groupId], passphrase: "correct horse battery" });
    const kp = sealKeyPair();
    await d.t.mutation(api.deviceApi.registerSealKey, { ...d.creds, publicKey: kp.publicB64 });
    await d.t.finishAllScheduledFunctions(vi.runAllTimers);
    const boxes = await rows(d.t, "deviceSealedSecrets");
    expect(boxes).toHaveLength(1);
    expect(boxes[0]).toMatchObject({ deviceId: d.deviceId, sealKeyId: kp.keyId, targetRevision: 1, purpose: "wifi" });
    expect(boxes[0]!.sealed).not.toContain("correct");
    expect(atob(boxes[0]!.sealed)).not.toContain("correct");
    // Running it again seals nothing new (the box is current).
    expect(await d.t.action(internal.seal.forDevices, { orgId: d.orgId, deviceIds: [d.deviceId] })).toEqual({ sealed: 0, skipped: 0 });
  });
});

describe("rate limits: `deviceReports` (60 an hour per device), charged only when something was written", () => {
  test("unchanged reports are free; the 61st report that writes is refused", async () => {
    const d = await setup();
    await d.t.mutation(api.deviceApi.reportApply, { ...d.creds, ...APPLY_REPORT }); // token 1
    for (let i = 0; i < 59; i++) {
      await d.t.mutation(api.deviceApi.reportSecurityDaily, { ...d.creds, ...SECURITY_DAILY, drift: 1 });
    }
    // 100 unchanged reports in a row cost nothing, even with the bucket empty.
    for (let i = 0; i < 100; i++) expect(await d.t.mutation(api.deviceApi.reportApply, { ...d.creds, ...APPLY_REPORT })).toEqual({ written: false });
    await expectCode(d.t.mutation(api.deviceApi.reportSecurityDaily, { ...d.creds, ...SECURITY_DAILY, drift: 1 }), "rate_limited");
    // The refused call rolled back: the counter did not move past 59 additions.
    expect((await rows(d.t, "deviceSecurityDaily"))[0]!.drift).toBe(59);
    // Another device has its own bucket.
    const other = await setup(d.t);
    expect(await other.t.mutation(api.deviceApi.reportSecurityDaily, { ...other.creds, ...SECURITY_DAILY, drift: 1 })).toEqual({ written: true });
  });
});

describe("fleet:purgeDevice removes the Phase 5 rows of the PC", () => {
  test("finding links, sealed boxes, the apply report and the lock go; another PC's rows stay", async () => {
    const d = await setup();
    const other = await setup(d.t);
    await d.t.mutation(api.deviceApi.reportApply, { ...d.creds, ...APPLY_REPORT });
    await other.t.mutation(api.deviceApi.reportApply, { ...other.creds, ...APPLY_REPORT });
    await d.t.mutation(api.deviceApi.reportFindings, { ...d.creds, findings: [FINDING] });
    await giveSealKey(d.t, d.deviceId);
    await d.t.run(async (ctx) => {
      await ctx.db.insert("deviceSealedSecrets", { orgId: d.orgId, deviceId: d.deviceId, purpose: "wifi", targetId: "p", targetRevision: 1, sealKeyId: "k", sealed: "AAAA", createdAt: 1 });
      await ctx.db.insert("deviceLocks", { orgId: d.orgId, deviceId: d.deviceId, lockId: "l", message: "m", lockedAt: 1 });
    });
    await d.t.mutation(internal.fleet.purgeDevice, { deviceId: d.deviceId });
    expect(await rows(d.t, "lockdownFindingDevices")).toEqual([]);
    expect(await rows(d.t, "deviceSealedSecrets")).toEqual([]);
    expect(await d.t.run((ctx) => ctx.db.query("deviceLocks").collect())).toEqual([]);
    const reports = await rows(d.t, "deviceApplyReports");
    expect(reports.map((r) => r.deviceId)).toEqual([other.deviceId]);
  });
});
