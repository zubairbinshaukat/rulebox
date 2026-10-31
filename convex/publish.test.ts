import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { setupAuth } from "../tests/convex/auth";
import { enrollDevice, probe } from "../tests/convex/devices";
import { makeOrg, type T } from "../tests/convex/identity";
import { setSeeds, TEST_KEY, TEST_SEED_2_B64, TEST_SEED_B64 } from "../tests/convex/keys";
import { VECTOR_PIN_HASH } from "../tests/convex/vectors";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { auditPolicy, looksSecret } from "./lib/audit";
import { sha256HexSync } from "./lib/crypto";
import { PAYLOAD_FORMAT } from "./lib/desired";
import { KEEP_VERSIONS, MINUTE_MS, PUBLISH_BATCH, ROSTER_SNAPSHOT_EVERY } from "./lib/limits";
import { PUBLISH_LEASE_MS, requestPublish } from "./lib/publish";
import { MAX_APPLIED_VERSION } from "./lib/versions";
import { appendRosterEntries, rosterEntryMessage } from "./lib/roster";
import { decodeKey32, verifyPayload } from "./lib/signing";

// The publisher (plan 4.4 amended, Step 8 item 3, A5/A6/A13) and the agent's
// signed-document functions (`devices:headState`, `fetchDesired`,
// `fetchRoster`). Fake timers: scheduled runs happen only when `drain` says so.

beforeEach(() => {
  vi.useFakeTimers();
  auditPolicy.strict = true;
});
afterEach(() => {
  vi.useRealTimers();
  auditPolicy.strict = false;
  setSeeds(TEST_SEED_B64);
});

const drain = (t: T) => t.finishAllScheduledFunctions(vi.runAllTimers);

async function rows(t: T, deviceId: Id<"devices">) {
  return await t.run(async (ctx) => ({
    head: await ctx.db.query("desiredHeads").withIndex("by_device", (q) => q.eq("deviceId", deviceId)).unique(),
    bodies: await ctx.db.query("desiredBodies").withIndex("by_device_version", (q) => q.eq("deviceId", deviceId)).take(50),
    versions: await ctx.db.query("desiredVersions").withIndex("by_device_version", (q) => q.eq("deviceId", deviceId)).take(50),
  }));
}

async function queueOf(t: T, orgId: Id<"organizations">) {
  return await t.run((ctx) => ctx.db.query("publishQueue").withIndex("by_org", (q) => q.eq("orgId", orgId)).unique());
}

async function auditOf(t: T, orgId: Id<"organizations">, action: string) {
  const all = await t.run((ctx) => ctx.db.query("auditLog").withIndex("by_org_at", (q) => q.eq("orgId", orgId)).take(200));
  return all.filter((r) => r.action === action);
}

async function setKiosk(t: T, deviceId: Id<"devices">, orgId: Id<"organizations">, enabled: boolean) {
  await t.run(async (ctx) => {
    await ctx.db.patch(deviceId, { kioskEnabled: enabled });
    await requestPublish(ctx, orgId, { deviceIds: [deviceId] });
  });
  await drain(t);
}

async function enrolled(t: T, opts: { groupId?: Id<"groups"> } = {}) {
  const orgId = await makeOrg(t);
  const { deviceId, secret } = await enrollDevice(t, orgId, opts);
  return { orgId, deviceId, secret, dev: { deviceId, deviceSecret: secret } };
}

describe("publish:run", () => {
  test("enroll -> first signed document: body + version + head in one run; the payload verifies with the org key", async () => {
    const t = await setupAuth();
    const { orgId, deviceId, dev } = await enrolled(t);
    expect(await t.query(api.devices.headState, dev)).toMatchObject({ kind: "ok", head: null });
    expect(await queueOf(t, orgId)).not.toBeNull();
    await drain(t);

    const r = await rows(t, deviceId);
    expect(r.bodies).toHaveLength(1);
    expect(r.versions).toEqual([expect.objectContaining({ version: 1, reason: "First signed document", bodyId: r.bodies[0]!._id })]);
    expect(r.head).toMatchObject({ version: 1, keyId: TEST_KEY.keyId, bodyId: r.bodies[0]!._id, pingNonce: 0, fastUntil: 0, planState: "ok" });
    expect(await queueOf(t, orgId)).toBeNull();

    const env = await t.query(api.devices.fetchDesired, { ...dev, version: 1 });
    expect(Object.keys(env).sort()).toEqual(["keyId", "payload", "signature", "version"]);
    expect(verifyPayload(env.payload, env.signature, TEST_KEY.publicKey)).toBe(true);
    expect(r.head!.contentHash).toBe(r.bodies[0]!.contentHash);
    const p = JSON.parse(env.payload) as { format: string; keyId: string; orgId: string; deviceId: string; version: number; doc: Record<string, unknown> };
    expect(p).toMatchObject({ format: PAYLOAD_FORMAT, keyId: TEST_KEY.keyId, orgId, deviceId, version: 1 });
    expect(p.doc).toMatchObject({ kioskEnabled: true, apps: ["files"], rosterGroupId: null, offlineDays: 3, orgName: "Acme" });
    // No exit PIN set and the exit enabled: `adminExit` is left out (rule 2).
    expect("adminExit" in p.doc).toBe(false);
    expect((await t.run((ctx) => ctx.db.query("orgStats").withIndex("by_org", (q) => q.eq("orgId", orgId)).unique()))?.publishBytesToday).toBe(
      env.payload.length,
    );
  });

  test("unchanged content writes nothing; changed content writes version + 1", async () => {
    const t = await setupAuth();
    const { orgId, deviceId } = await enrolled(t);
    await drain(t);
    const before = await rows(t, deviceId);

    await t.run((ctx) => requestPublish(ctx, orgId, { allDevices: true }));
    const { io } = await probe(() => drain(t));
    for (const table of ["desiredBodies", "desiredVersions"]) expect(io.tables.has(table), table).toBe(false);
    const same = await rows(t, deviceId);
    expect(same.head).toEqual(before.head);
    expect(same.bodies).toHaveLength(1);

    await setKiosk(t, deviceId, orgId, false);
    const after = await rows(t, deviceId);
    expect(after.head).toMatchObject({ version: 2 });
    expect(after.versions.map((v) => v.reason)).toEqual(["First signed document", "Policy changed"]);
    const doc = (JSON.parse(after.bodies[1]!.payload) as { doc: { kioskEnabled: boolean; version: number } }).doc;
    expect(doc).toMatchObject({ kioskEnabled: false, version: 2 });
  });

  test("pruning keeps the newest 5; a pruned version answers not_found", async () => {
    const t = await setupAuth();
    const { orgId, deviceId, dev } = await enrolled(t);
    await drain(t);
    for (let i = 0; i < 6; i++) await setKiosk(t, deviceId, orgId, i % 2 === 0 ? false : true);
    const r = await rows(t, deviceId);
    expect(r.head?.version).toBe(7);
    expect(r.versions.map((v) => v.version)).toEqual([3, 4, 5, 6, 7]);
    expect(r.bodies.map((b) => b.version)).toEqual([3, 4, 5, 6, 7]);
    expect(r.versions).toHaveLength(KEEP_VERSIONS);
    await expect(t.query(api.devices.fetchDesired, { ...dev, version: 2 })).rejects.toMatchObject({ data: { code: "not_found" } });
    expect((await t.query(api.devices.fetchDesired, { ...dev, version: 7 })).version).toBe(7);
  });

  test("the exit PIN reaches the signed document (and only the document)", async () => {
    const t = await setupAuth();
    const { orgId, deviceId } = await enrolled(t);
    await t.run(async (ctx) => {
      const s = (await ctx.db.query("orgSecrets").withIndex("by_org", (q) => q.eq("orgId", orgId)).unique())!;
      await ctx.db.patch(s._id, { exitPinHash: VECTOR_PIN_HASH });
    });
    await drain(t);
    const body = (await rows(t, deviceId)).bodies[0]!;
    expect((JSON.parse(body.payload) as { doc: { adminExit: unknown } }).doc.adminExit).toEqual({
      enabled: true,
      hotkey: "Ctrl+Shift+F12",
      pinHash: VECTOR_PIN_HASH,
    });
  });

  test("revoked devices are skipped", async () => {
    const t = await setupAuth();
    const { orgId, deviceId, dev } = await enrolled(t);
    await t.mutation(api.devices.unenroll, dev);
    await drain(t);
    expect((await rows(t, deviceId)).head).toBeNull();
    expect(await queueOf(t, orgId)).toBeNull();
  });

  test("a first version starts above what the device applied before (Phase 2 documents, its report)", async () => {
    const t = await setupAuth();
    const { orgId, deviceId, dev } = await enrolled(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("desiredStates", { orgId, scope: deviceId, version: 4, doc: { kioskEnabled: true } });
      const s = (await ctx.db.query("deviceSummary").withIndex("by_device", (q) => q.eq("deviceId", deviceId)).unique())!;
      await ctx.db.patch(s._id, { appliedVersion: 9 });
    });
    // Before the first publish the Phase 2 alias still answers the Phase 2 row.
    expect(await t.query(api.devices.desiredState, dev)).toEqual({
      kind: "ok",
      desired: { version: 4, doc: { kioskEnabled: true }, signature: null },
    });
    await drain(t);
    expect((await rows(t, deviceId)).head?.version).toBe(10);
    // The alias now answers the Phase 2 shape from the signed body.
    const alias = await t.query(api.devices.desiredState, dev);
    expect(alias).toMatchObject({ kind: "ok", desired: { version: 10, signature: null, doc: { kioskEnabled: true, version: 10 } } });
  });

  test(`batches of ${PUBLISH_BATCH}: the run reschedules itself until every device is done`, async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const ids: Id<"devices">[] = [];
    for (let i = 0; i < PUBLISH_BATCH + 5; i++) {
      if (i % 9 === 8) vi.setSystemTime(Date.now() + MINUTE_MS); // enrollPerOrg: 10 per minute (no timer fires)
      ids.push((await enrollDevice(t, orgId, { name: `PC ${i}` })).deviceId);
    }
    await t.run(async (ctx) => {
      const q = (await ctx.db.query("publishQueue").withIndex("by_org", (x) => x.eq("orgId", orgId)).unique())!;
      await ctx.db.patch(q._id, { deviceIds: [], allDevices: true });
    });
    await t.mutation(internal.publish.run, { orgId });
    const heads = async () =>
      (await t.run((ctx) => ctx.db.query("desiredHeads").withIndex("by_creation_time").take(100))).filter((h) => h.orgId === orgId).length;
    expect(await heads()).toBe(PUBLISH_BATCH);
    const q = await queueOf(t, orgId);
    expect(q).toMatchObject({ allDevices: true });
    expect(q?.cursor).toBeDefined();
    expect(q?.scheduled).toBeDefined();
    await drain(t);
    expect(await heads()).toBe(PUBLISH_BATCH + 5);
    expect(await queueOf(t, orgId)).toBeNull();
  });

  test("a group target publishes the group's devices (paginated) and nothing else", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const groupId = await t.run((ctx) => ctx.db.insert("groups", { orgId, name: "Sales" }));
    const inGroup = (await enrollDevice(t, orgId, { groupId })).deviceId;
    const other = (await enrollDevice(t, orgId)).deviceId;
    await t.run(async (ctx) => {
      const q = (await ctx.db.query("publishQueue").withIndex("by_org", (x) => x.eq("orgId", orgId)).unique())!;
      await ctx.db.patch(q._id, { deviceIds: [], groupIds: [groupId] });
    });
    await drain(t);
    expect((await rows(t, inGroup)).head).toMatchObject({ version: 1, rosterGroupId: groupId });
    expect((await rows(t, other)).head).toBeNull();
    const doc = (JSON.parse((await rows(t, inGroup)).bodies[0]!.payload) as { doc: { rosterGroupId: string } }).doc;
    expect(doc.rosterGroupId).toBe(groupId);
  });

  test("signing key missing: nothing written, one audit entry per run, queue kept unscheduled; fixed key publishes", async () => {
    const t = await setupAuth();
    const { orgId, deviceId } = await enrolled(t);
    setSeeds(undefined);
    const { io } = await probe(() => drain(t));
    expect([...io.tables].filter((x) => x.startsWith("desired"))).toEqual([]);
    expect((await rows(t, deviceId)).head).toBeNull();
    const failed = await auditOf(t, orgId, "policy.publishFailed");
    expect(failed).toHaveLength(1);
    expect(failed[0]!.summary).toBe("Could not publish: signing key not configured");
    const q = await queueOf(t, orgId);
    expect(q).toMatchObject({ deviceIds: [deviceId] });
    expect(q?.scheduled).toBeUndefined();
    const stats = await t.run((ctx) => ctx.db.query("orgStats").withIndex("by_org", (x) => x.eq("orgId", orgId)).unique());
    expect(stats?.publishFailedAt).toBeDefined();

    // A later request schedules a new run; with the key back it publishes and clears the failure.
    setSeeds(TEST_SEED_B64);
    await t.run((ctx) => requestPublish(ctx, orgId, { deviceIds: [deviceId] }));
    await drain(t);
    expect((await rows(t, deviceId)).head?.version).toBe(1);
    const fixed = await t.run((ctx) => ctx.db.query("orgStats").withIndex("by_org", (x) => x.eq("orgId", orgId)).unique());
    expect(fixed?.publishFailedAt).toBeUndefined();
    expect(await auditOf(t, orgId, "policy.publishFailed")).toHaveLength(1);
  });

  test("signing key mismatched (the deployment holds another key): nothing written, audited", async () => {
    const t = await setupAuth();
    const { orgId, deviceId } = await enrolled(t);
    setSeeds(TEST_SEED_2_B64);
    await drain(t);
    expect((await rows(t, deviceId)).head).toBeNull();
    const failed = await auditOf(t, orgId, "policy.publishFailed");
    expect(failed).toHaveLength(1);
    expect(looksSecret(failed[0]!.summary)).toBe(false);
  });

  test("an oversize document is skipped and audited `document too large`", async () => {
    const t = await setupAuth();
    const { orgId, deviceId } = await enrolled(t);
    await t.run((ctx) => ctx.db.patch(orgId, { name: "N ".repeat(140_000) })); // ~280 KB, twice in the document
    await drain(t);
    expect((await rows(t, deviceId)).head).toBeNull();
    const failed = await auditOf(t, orgId, "policy.publishFailed");
    expect(failed.map((r) => r.summary)).toEqual(["Could not publish to the PC PC: document too large"]);
  });

  test("organizations are isolated: a run touches only its own devices; a device sees only its own org's keys", async () => {
    const t = await setupAuth();
    const a = await enrolled(t);
    const b = await enrolled(t);
    await t.mutation(internal.publish.run, { orgId: a.orgId });
    expect((await rows(t, a.deviceId)).head?.version).toBe(1);
    expect((await rows(t, b.deviceId)).head).toBeNull();
    // Org B registers a second key; org A's device never hears of it.
    await t.run((ctx) =>
      ctx.db.insert("policyKeys", { orgId: b.orgId, keyId: "ffffffffffffffff", publicKey: TEST_KEY.publicKeyB64, status: "next", createdAt: Date.now() }),
    );
    const stateA = await t.query(api.devices.headState, a.dev);
    expect(stateA.kind === "ok" && stateA.keys.map((k) => k.keyId)).toEqual([TEST_KEY.keyId]);
    const stateB = await t.query(api.devices.headState, b.dev);
    expect(stateB.kind === "ok" && stateB.keys.map((k) => k.keyId)).toEqual([TEST_KEY.keyId, "ffffffffffffffff"]);
    // Device B cannot fetch device A's version (its own id only).
    await expect(t.query(api.devices.fetchDesired, { ...b.dev, version: 1 })).rejects.toMatchObject({ data: { code: "not_found" } });
  });

  test("a ping-interval change patches the head only (no new version)", async () => {
    const t = await setupAuth();
    const { orgId, deviceId } = await enrolled(t);
    await drain(t);
    await t.run(async (ctx) => {
      const { newOrgPlanFields } = await import("./lib/plans");
      await ctx.db.insert("orgPlans", { orgId, ...newOrgPlanFields(null, "custom", Date.now(), "test"), pingIntervalMs: 10 * MINUTE_MS });
    });
    await t.mutation(internal.presence.applyPingInterval, { orgId });
    const r = await rows(t, deviceId);
    expect(r.head).toMatchObject({ version: 1, pingIntervalMs: 10 * MINUTE_MS });
    expect(r.bodies).toHaveLength(1);
  });
});

describe("review fixes: hostile reported versions, a dead run, one bad device", () => {
  const BAD_VERSIONS: [string, number][] = [
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["negative", -3],
    ["fraction", 2.5],
    ["1e300", 1e300],
    ["above the bound", MAX_APPLIED_VERSION + 1],
  ];

  test.each(BAD_VERSIONS)("the publisher ignores a stored appliedVersion that is %s: version 1, nothing aborted", async (_name, bad) => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const a = (await enrollDevice(t, orgId, { name: "A" })).deviceId;
    const b = (await enrollDevice(t, orgId, { name: "B" })).deviceId;
    await t.run(async (ctx) => {
      const s = (await ctx.db.query("deviceSummary").withIndex("by_device", (q) => q.eq("deviceId", a)).unique())!;
      await ctx.db.patch(s._id, { appliedVersion: bad });
    });
    await drain(t);
    expect((await rows(t, a)).head?.version).toBe(1);
    expect((await rows(t, b)).head?.version).toBe(1);
    expect(await auditOf(t, orgId, "policy.publishFailed")).toEqual([]);
    expect(await queueOf(t, orgId)).toBeNull();
  });

  test("the largest accepted appliedVersion still gives a valid version above it", async () => {
    const t = await setupAuth();
    const { deviceId } = await enrolled(t);
    await t.run(async (ctx) => {
      const s = (await ctx.db.query("deviceSummary").withIndex("by_device", (q) => q.eq("deviceId", deviceId)).unique())!;
      await ctx.db.patch(s._id, { appliedVersion: MAX_APPLIED_VERSION });
    });
    await drain(t);
    expect((await rows(t, deviceId)).head?.version).toBe(MAX_APPLIED_VERSION + 1);
  });

  test.each(BAD_VERSIONS)("a report with appliedVersion %s is stored without it (summary and report); a sane one is kept", async (_name, bad) => {
    const t = await setupAuth();
    const { deviceId, dev } = await enrolled(t);
    await t.mutation(api.devices.heartbeat, { ...dev, status: { agentVersion: "0.4.0", appliedVersion: 5 } });
    const stored = async () =>
      await t.run(async (ctx) => ({
        summary: (await ctx.db.query("deviceSummary").withIndex("by_device", (q) => q.eq("deviceId", deviceId)).unique())?.appliedVersion,
        report: (await ctx.db.query("deviceReports").withIndex("by_device", (q) => q.eq("deviceId", deviceId)).unique())?.appliedVersion,
      }));
    expect(await stored()).toEqual({ summary: 5, report: 5 });
    await t.mutation(api.devices.heartbeat, { ...dev, status: { agentVersion: "0.4.0", appliedVersion: bad } });
    expect(await stored()).toEqual({ summary: undefined, report: undefined });
  });

  test("a device whose own data breaks its publish is skipped with an audit entry; the rest of the batch publishes", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const bad = (await enrollDevice(t, orgId, { name: "Broken PC" })).deviceId;
    const good = (await enrollDevice(t, orgId, { name: "Good PC" })).deviceId;
    // Two credential rows for one device: `.unique()` throws inside that device's publish.
    await t.run(async (ctx) => {
      const c = (await ctx.db.query("deviceCredentials").withIndex("by_device", (q) => q.eq("deviceId", bad)).unique())!;
      const { _id, _creationTime, ...copy } = c;
      void _id;
      void _creationTime;
      await ctx.db.insert("deviceCredentials", copy);
    });
    await drain(t);
    expect((await rows(t, bad)).head).toBeNull();
    expect((await rows(t, good)).head?.version).toBe(1);
    const failed = await auditOf(t, orgId, "policy.publishFailed");
    expect(failed.map((r) => r.summary)).toEqual(["Could not publish to the PC Broken PC: unexpected error"]);
    expect(await queueOf(t, orgId)).toBeNull();
  });

  test("a run that threw leaves the queue scheduled; once the lease ran out the next request reschedules and publishes", async () => {
    const t = await setupAuth();
    const { orgId, deviceId } = await enrolled(t);
    // A second `orgSecrets` row makes the run throw before it touches a device.
    const dup = await t.run(async (ctx) => {
      const s = (await ctx.db.query("orgSecrets").withIndex("by_org", (q) => q.eq("orgId", orgId)).unique())!;
      const { _id, _creationTime, ...copy } = s;
      void _id;
      void _creationTime;
      return await ctx.db.insert("orgSecrets", copy);
    });
    await drain(t).catch(() => undefined); // the failed run may surface here
    const dead = await queueOf(t, orgId);
    expect(dead).toMatchObject({ deviceIds: [deviceId] });
    expect(dead?.scheduled).toBeDefined(); // the dead run's id: nothing will ever clear it
    expect((await rows(t, deviceId)).head).toBeNull();

    // Within the lease a request changes nothing (no write, no second run).
    await t.run((ctx) => requestPublish(ctx, orgId, { deviceIds: [deviceId] }));
    expect(await queueOf(t, orgId)).toEqual(dead);

    // The poisoned row is gone and the lease ran out: the same request now schedules a run.
    await t.run((ctx) => ctx.db.delete(dup));
    vi.setSystemTime(Date.now() + PUBLISH_LEASE_MS + 1);
    await t.run((ctx) => requestPublish(ctx, orgId, { deviceIds: [deviceId] }));
    const healed = await queueOf(t, orgId);
    expect(healed?.scheduled).toBeDefined();
    expect(healed?.scheduled).not.toBe(dead?.scheduled);
    expect(healed!.requestedAt).toBeGreaterThan(dead!.requestedAt);
    await drain(t);
    expect((await rows(t, deviceId)).head?.version).toBe(1);
    expect(await queueOf(t, orgId)).toBeNull();
  });

  test("a hop of a long walk renews the lease (requestedAt), so a healthy chain is never rescheduled", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    for (let i = 0; i < PUBLISH_BATCH + 2; i++) {
      if (i % 9 === 8) vi.setSystemTime(Date.now() + MINUTE_MS);
      await enrollDevice(t, orgId, { name: `PC ${i}` });
    }
    await t.run(async (ctx) => {
      const q = (await ctx.db.query("publishQueue").withIndex("by_org", (x) => x.eq("orgId", orgId)).unique())!;
      await ctx.db.patch(q._id, { deviceIds: [], allDevices: true, requestedAt: 0 });
    });
    await t.mutation(internal.publish.run, { orgId });
    const q = await queueOf(t, orgId);
    expect(q?.scheduled).toBeDefined();
    expect(q!.requestedAt).toBeGreaterThan(0);
    const before = q!.scheduled;
    await t.run((ctx) => requestPublish(ctx, orgId, { allDevices: true }));
    // The walk restarted (cursor reset) but the live run is kept.
    expect((await queueOf(t, orgId))?.scheduled).toBe(before);
  });
});

describe("maintenance:dropDesiredStates (A5 migration guard)", () => {
  test("refuses while a non-revoked device has no signed head; deletes once every one has", async () => {
    const t = await setupAuth();
    const { orgId, deviceId } = await enrolled(t);
    const gone = await enrollDevice(t, orgId, { name: "Gone" });
    await t.mutation(api.devices.unenroll, { deviceId: gone.deviceId, deviceSecret: gone.secret });
    await t.run((ctx) => ctx.db.insert("desiredStates", { orgId, scope: deviceId, version: 4, doc: { kioskEnabled: true } }));

    // Nothing is published yet: refused, rows kept, nothing scheduled to delete.
    const refused = await t.mutation(internal.maintenance.dropDesiredStates, {});
    expect(refused).toEqual({ deleted: 0, done: true, blocked: 1 });
    expect((await t.run((ctx) => ctx.db.query("desiredStates").withIndex("by_creation_time").take(10))).length).toBe(1);

    // Everything published (the revoked device never gets a head): the guard passes, the delete follows.
    await drain(t);
    expect((await rows(t, deviceId)).head).not.toBeNull();
    const verifying = await t.mutation(internal.maintenance.dropDesiredStates, {});
    expect(verifying).toEqual({ deleted: 0, done: false, blocked: 0 });
    await drain(t);
    expect(await t.run((ctx) => ctx.db.query("desiredStates").withIndex("by_creation_time").take(10))).toEqual([]);
  });
});

describe("devices:headState / fetchDesired / fetchRoster", () => {
  test("headState: small (<= 2 KB), never a payload, never the status rows; keys oldest first with endorsements", async () => {
    const t = await setupAuth();
    const { deviceId, dev } = await enrolled(t);
    await drain(t);
    await t.mutation(api.devices.heartbeat, { ...dev, status: { agentVersion: "0.4.0", compat: { blockers: [] } } });
    const { result, io } = await probe(() => t.query(api.devices.headState, dev));
    expect(result.kind).toBe("ok");
    const text = JSON.stringify(result);
    expect(text.length).toBeLessThanOrEqual(2_048);
    expect(io.readBytes).toBeLessThanOrEqual(2_048);
    expect(io.reads).toBeLessThanOrEqual(20);
    expect(text).not.toContain("payload");
    expect(text).not.toContain("$argon2");
    for (const table of ["desiredBodies", "deviceReports", "deviceSummary", "deviceLiveness", "devicePresence", "deviceStatus", "devices"]) {
      expect(io.tables.has(table), table).toBe(false);
    }
    const head = (await rows(t, deviceId)).head!;
    expect(result).toEqual({
      kind: "ok",
      head: {
        version: 1,
        contentHash: head.contentHash,
        keyId: TEST_KEY.keyId,
        bodyId: head.bodyId,
        pingIntervalMs: head.pingIntervalMs,
        pingNonce: 0,
        fastUntil: 0,
        rosterEpoch: 0,
        planState: "ok",
      },
      keys: [{ keyId: TEST_KEY.keyId, publicKey: TEST_KEY.publicKeyB64, endorsement: null }],
      retiredKeyIds: [],
    });
    // The head's checks match the body the agent fetches (Step 9 HeadMismatch).
    const env = await t.query(api.devices.fetchDesired, { ...dev, version: 1 });
    expect(env.keyId).toBe(head.keyId);
    expect(sha256HexSync(env.payload)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("headState answers revoked / unknownDevice like the Phase 2 subscription; fetches refuse", async () => {
    const t = await setupAuth();
    const { dev } = await enrolled(t);
    expect(await t.query(api.devices.headState, { ...dev, deviceSecret: "wrong" })).toEqual({ kind: "unknownDevice" });
    await t.mutation(api.devices.unenroll, dev);
    expect(await t.query(api.devices.headState, dev)).toEqual({ kind: "revoked" });
    await expect(t.query(api.devices.fetchDesired, { ...dev, version: 1 })).rejects.toMatchObject({ data: { code: "device_rejected" } });
    await expect(t.query(api.devices.fetchRoster, { ...dev, sinceEpoch: 0 })).rejects.toMatchObject({ data: { code: "device_rejected" } });
  });

  test("a republish keeps the head's watch / check-now signals (fastUntil, pingNonce) and writes no new version", async () => {
    const t = await setupAuth();
    const { orgId, deviceId } = await enrolled(t);
    await drain(t);
    await t.run(async (ctx) => {
      const h = (await ctx.db.query("desiredHeads").withIndex("by_device", (q) => q.eq("deviceId", deviceId)).unique())!;
      await ctx.db.patch(h._id, { pingNonce: h.pingNonce + 1, fastUntil: 123 });
    });
    await t.run((ctx) => requestPublish(ctx, orgId, { deviceIds: [deviceId] }));
    await drain(t);
    // The publisher keeps the signal fields and writes no new version.
    expect((await rows(t, deviceId)).head).toMatchObject({ version: 1, pingNonce: 1, fastUntil: 123 });
  });

  test("roster: a change bumps the epoch the head reports and writes no body; entries verify; snapshot past the limit", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const groupId = await t.run((ctx) => ctx.db.insert("groups", { orgId, name: "Sales" }));
    const { deviceId, secret } = await enrollDevice(t, orgId, { groupId });
    const dev = { deviceId, deviceSecret: secret };
    await drain(t);
    expect(await t.query(api.devices.fetchRoster, { ...dev, sinceEpoch: 0 })).toEqual({ epoch: 0, entries: [] });

    const emp = await t.run((ctx) =>
      ctx.db.insert("employees", { orgId, name: "Ann", username: "ann", searchText: "ann ann", disabled: false, credentialRevision: 1, revision: 0, createdAt: 0 }),
    );
    const before = await rows(t, deviceId);
    await t.run((ctx) => appendRosterEntries(ctx, TEST_KEY, orgId, groupId, [{ employeeId: emp, credentialRevision: 1 }], Date.now()));
    const after = await rows(t, deviceId);
    expect(after.bodies).toHaveLength(before.bodies.length);
    expect(after.head).toEqual(before.head);
    const state = await t.query(api.devices.headState, dev);
    expect(state.kind === "ok" && state.head?.rosterEpoch).toBe(1);

    const delta = await t.query(api.devices.fetchRoster, { ...dev, sinceEpoch: 0 });
    if (!("entries" in delta)) throw new Error("expected entries");
    expect(delta.epoch).toBe(1);
    const e = delta.entries[0]!;
    expect(e).toMatchObject({ epoch: 1, employeeId: emp, credentialRevision: 1, keyId: TEST_KEY.keyId });
    const message = rosterEntryMessage({ keyId: TEST_KEY.keyId, orgId, groupId, epoch: 1, employeeId: emp, credentialRevision: 1 });
    expect(verifyPayload(message, e.signature, TEST_KEY.publicKey)).toBe(true);
    expect(verifyPayload(message.replace(/\n1$/, "\n2"), e.signature, TEST_KEY.publicKey)).toBe(false);

    // Past ROSTER_SNAPSHOT_EVERY entries: a signed snapshot replaces the old entries.
    const changes = Array.from({ length: ROSTER_SNAPSHOT_EVERY }, (_, i) => ({ employeeId: emp, credentialRevision: i + 2 }));
    await t.run((ctx) => appendRosterEntries(ctx, TEST_KEY, orgId, groupId, changes, Date.now()));
    const snap = await t.query(api.devices.fetchRoster, { ...dev, sinceEpoch: 0 });
    if (!("snapshot" in snap)) throw new Error("expected a snapshot");
    expect(snap.snapshot.epoch).toBe(ROSTER_SNAPSHOT_EVERY + 1);
    expect(verifyPayload(snap.snapshot.payload, snap.snapshot.signature, decodeKey32(TEST_KEY.publicKeyB64)!)).toBe(true);
    expect(JSON.parse(snap.snapshot.payload)).toMatchObject({ format: "rulebox.roster-snapshot/1", epoch: ROSTER_SNAPSHOT_EVERY + 1, members: [[emp, ROSTER_SNAPSHOT_EVERY + 1]] });
    const left = await t.run((ctx) => ctx.db.query("rosterEntries").withIndex("by_group_epoch", (q) => q.eq("groupId", groupId)).take(500));
    expect(left).toHaveLength(0);
    expect(await t.query(api.devices.fetchRoster, { ...dev, sinceEpoch: ROSTER_SNAPSHOT_EVERY + 1 })).toEqual({
      epoch: ROSTER_SNAPSHOT_EVERY + 1,
      entries: [],
    });
  });
});
