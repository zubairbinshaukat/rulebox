import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { setupAuth } from "../tests/convex/auth";
import { enrollDevice, newToken } from "../tests/convex/devices";
import { asMember, expectCode, expectNoSecrets, giveStepUp, makeOrg, type T } from "../tests/convex/identity";
import { insertKeyRow, setSeeds, TEST_KEY, TEST_KEY_2, TEST_SEED_2_B64, TEST_SEED_B64 } from "../tests/convex/keys";
import { VECTOR_PIN_HASH } from "../tests/convex/vectors";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { auditPolicy, looksSecret } from "./lib/audit";
import { base64Encode, sha256HexSync } from "./lib/crypto";
import { decodeKey32, endorsementMessage, verifyPayload } from "./lib/signing";

// Settings -> Signing (plan 4.5, Step 8 items 5, 6; Section 4.7). Only the
// published RFC 8032 test keys (tests/convex/keys.ts) are used.

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

async function owner(t: T, orgId: Id<"organizations">) {
  const m = await asMember(t, { role: "owner", mfa: true, orgId });
  await giveStepUp(t, m);
  return m;
}

async function keyRows(t: T, orgId: Id<"organizations">) {
  const rows = await t.run((ctx) => ctx.db.query("policyKeys").withIndex("by_org_key_id", (q) => q.eq("orgId", orgId)).take(20));
  return rows.map((r) => ({ keyId: r.keyId, status: r.status, endorsedBy: r.endorsement?.byKeyId ?? null }));
}

async function auditRows(t: T, orgId: Id<"organizations">) {
  return await t.run((ctx) => ctx.db.query("auditLog").withIndex("by_org_at", (q) => q.eq("orgId", orgId)).take(100));
}

async function enrollWithToken(t: T, orgId: Id<"organizations">) {
  const token = newToken();
  await t.run((ctx) =>
    ctx.db.insert("enrollmentTokens", { orgId, tokenHash: sha256HexSync(token), expiresAt: Date.now() + 3_600_000, usesLeft: 1, createdAt: Date.now() }),
  );
  return await t.mutation(api.enrollment.enroll, {
    token,
    deviceSecretHash: sha256HexSync(`s-${token}`),
    deviceName: "PC",
    agentVersion: "0.4.0",
    compat: {},
  });
}

describe("keys:registerActive and enrollment's root of trust", () => {
  test("no key: enroll is not_ready; Register key derives the env key's public half, audits, publishes every device", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t, "Acme", { noKey: true });
    await expectCode(enrollWithToken(t, orgId), "not_ready");
    const o = await owner(t, orgId);

    setSeeds(undefined);
    await expectCode(o.as.mutation(api.keys.registerActive, {}), "not_ready");
    setSeeds(TEST_SEED_B64);
    expect(await o.as.mutation(api.keys.registerActive, {})).toEqual({ keyId: TEST_KEY.keyId, fingerprint: "21fe 31df a154 a261" });
    expect(await keyRows(t, orgId)).toEqual([{ keyId: TEST_KEY.keyId, status: "active", endorsedBy: null }]);
    const row = (await t.run((ctx) => ctx.db.query("policyKeys").withIndex("by_org_key_id", (q) => q.eq("orgId", orgId)).first()))!;
    expect(row.publicKey).toBe(TEST_KEY.publicKeyB64);
    const audit = (await auditRows(t, orgId)).filter((r) => r.action === "policy.keyRegistered");
    expect(audit).toHaveLength(1);
    expect(looksSecret(audit[0]!.summary)).toBe(false);
    expect(JSON.stringify(audit)).not.toContain(TEST_SEED_B64);
    const queue = await t.run((ctx) => ctx.db.query("publishQueue").withIndex("by_org", (q) => q.eq("orgId", orgId)).unique());
    expect(queue).toMatchObject({ allDevices: true });

    // Now a device can enroll, and it is told to trust exactly that key.
    const r = await enrollWithToken(t, orgId);
    expect(r.policyKeys).toEqual([{ keyId: TEST_KEY.keyId, publicKey: TEST_KEY.publicKeyB64 }]);
  });

  test("a second active key is refused; `force` (key lost) retires the old one; the same key twice is key_exists", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t, "Acme", { noKey: true });
    await insertKeyRow(t, orgId, TEST_KEY_2, "active");
    const o = await owner(t, orgId);
    await expect(o.as.mutation(api.keys.registerActive, {})).rejects.toMatchObject({ data: { code: "conflict", detail: "an active key exists" } });
    expect((await o.as.mutation(api.keys.registerActive, { force: true })).keyId).toBe(TEST_KEY.keyId);
    expect((await keyRows(t, orgId)).sort((a, b) => (a.status < b.status ? -1 : 1))).toEqual([
      { keyId: TEST_KEY.keyId, status: "active", endorsedBy: null },
      { keyId: TEST_KEY_2.keyId, status: "retired", endorsedBy: null },
    ]);
    // `force` with the env key already active (or known) is refused.
    await expect(o.as.mutation(api.keys.registerActive, { force: true })).rejects.toMatchObject({ data: { code: "conflict", detail: "key_exists" } });
  });

  test("retry after a failed publish: with the seed restored, Register key again publishes (no second row, no conflict)", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const o = await owner(t, orgId);
    const { deviceId } = await enrollDevice(t, orgId);
    const head = () => t.run((ctx) => ctx.db.query("desiredHeads").withIndex("by_device", (q) => q.eq("deviceId", deviceId)).unique());

    // The seed is gone: the run fails, audits and leaves the queue unscheduled.
    setSeeds(undefined);
    await drain(t);
    expect(await head()).toBeNull();
    const failed = await t.run((ctx) => ctx.db.query("orgStats").withIndex("by_org", (q) => q.eq("orgId", orgId)).unique());
    expect(failed?.publishFailedAt).toBeDefined();

    // The Owner restores the same seed: nothing else would ever publish. The retry registers nothing.
    setSeeds(TEST_SEED_B64);
    const before = await keyRows(t, orgId);
    expect(await o.as.mutation(api.keys.registerActive, {})).toEqual({ keyId: TEST_KEY.keyId, fingerprint: "21fe 31df a154 a261" });
    expect(await keyRows(t, orgId)).toEqual(before);
    expect((await auditRows(t, orgId)).filter((r) => r.action === "policy.keyRegistered")).toHaveLength(0);
    await drain(t);
    expect((await head())?.version).toBe(1);
    const fixed = await t.run((ctx) => ctx.db.query("orgStats").withIndex("by_org", (q) => q.eq("orgId", orgId)).unique());
    expect(fixed?.publishFailedAt).toBeUndefined();
  });

  test("the env key known as `next` or `retired` stays a conflict (only the active key is a retry)", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t, "Acme", { noKey: true });
    await insertKeyRow(t, orgId, TEST_KEY_2, "active");
    await insertKeyRow(t, orgId, TEST_KEY, "retired");
    const o = await owner(t, orgId);
    await expect(o.as.mutation(api.keys.registerActive, {})).rejects.toMatchObject({ data: { code: "conflict", detail: "key_exists" } });
  });

  test("only the Owner, with a fresh step-up", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t, "Acme", { noKey: true });
    const admin = await asMember(t, { role: "admin", mfa: true, orgId });
    await giveStepUp(t, admin);
    await expectCode(admin.as.mutation(api.keys.registerActive, {}), "forbidden");
    const stale = await asMember(t, { role: "owner", mfa: true, orgId });
    await giveStepUp(t, stale, { verifiedAgoMs: 6 * 60_000, activeAgoMs: 0 });
    await expectCode(stale.as.mutation(api.keys.registerActive, {}), "step_up_required");
  });
});

describe("rotation (plan 4.5)", () => {
  test("prepare: endorsed next key reaches devices and new enrollments; finish: retire, activate, re-sign everything", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const o = await owner(t, orgId);
    const { deviceId, secret } = await enrollDevice(t, orgId);
    const dev = { deviceId, deviceSecret: secret };
    await drain(t);

    await expectCode(o.as.mutation(api.keys.prepareRotation, {}), "not_ready"); // no NEXT seed yet
    setSeeds(TEST_SEED_B64, TEST_SEED_2_B64);
    expect((await o.as.mutation(api.keys.prepareRotation, {})).keyId).toBe(TEST_KEY_2.keyId);
    await expect(o.as.mutation(api.keys.prepareRotation, {})).rejects.toMatchObject({ data: { code: "conflict" } });

    const state = await t.query(api.devices.headState, dev);
    if (state.kind !== "ok") throw new Error("expected ok");
    expect(state.keys.map((k) => k.keyId)).toEqual([TEST_KEY.keyId, TEST_KEY_2.keyId]);
    const next = state.keys[1]!;
    expect(next.endorsement?.byKeyId).toBe(TEST_KEY.keyId);
    expect(verifyPayload(endorsementMessage(next.keyId, next.publicKey), next.endorsement!.signature, TEST_KEY.publicKey)).toBe(true);
    expect(verifyPayload(endorsementMessage(next.keyId, next.publicKey), next.endorsement!.signature, decodeKey32(next.publicKey)!)).toBe(false);
    expect((await enrollWithToken(t, orgId)).policyKeys.map((k) => k.keyId)).toEqual([TEST_KEY.keyId, TEST_KEY_2.keyId]);

    // Finish before the env swap: refused.
    await expect(o.as.mutation(api.keys.finishRotation, {})).rejects.toMatchObject({ data: { code: "not_ready" } });
    setSeeds(TEST_SEED_2_B64);
    expect((await o.as.mutation(api.keys.finishRotation, {})).keyId).toBe(TEST_KEY_2.keyId);
    expect((await keyRows(t, orgId)).find((k) => k.keyId === TEST_KEY.keyId)?.status).toBe("retired");
    expect((await keyRows(t, orgId)).find((k) => k.keyId === TEST_KEY_2.keyId)).toMatchObject({ status: "active", endorsedBy: TEST_KEY.keyId });
    await drain(t);

    const after = await t.query(api.devices.headState, dev);
    if (after.kind !== "ok") throw new Error("expected ok");
    expect(after.retiredKeyIds).toEqual([TEST_KEY.keyId]);
    expect(after.keys.map((k) => k.keyId)).toEqual([TEST_KEY.keyId, TEST_KEY_2.keyId]); // oldest first, retired too
    expect(after.head).toMatchObject({ version: 2, keyId: TEST_KEY_2.keyId });
    const env = await t.query(api.devices.fetchDesired, { ...dev, version: 2 });
    expect(verifyPayload(env.payload, env.signature, TEST_KEY_2.publicKey)).toBe(true);
    expect(verifyPayload(env.payload, env.signature, TEST_KEY.publicKey)).toBe(false);
    const versions = await t.run((ctx) => ctx.db.query("desiredVersions").withIndex("by_device_version", (q) => q.eq("deviceId", deviceId)).take(10));
    expect(versions.map((v) => v.reason)).toEqual(["First signed document", "Signed with a new key"]);
    const actions = (await auditRows(t, orgId)).map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(["policy.rotationPrepared", "policy.rotationFinished"]));
  });

  test("trustProgress counts non-revoked devices and those that report trusting the next key", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const viewer = await asMember(t, { role: "viewer", orgId });
    const a = await enrollDevice(t, orgId);
    const b = await enrollDevice(t, orgId);
    const c = await enrollDevice(t, orgId);
    await t.mutation(api.devices.unenroll, { deviceId: c.deviceId, deviceSecret: c.secret });
    const page = { paginationOpts: { numItems: 200, cursor: null } };
    expect((await viewer.as.query(api.keys.trustProgress, page)).page).toEqual({ total: 2, trustNext: 0 });
    await insertKeyRow(t, orgId, TEST_KEY_2, "next");
    await t.run(async (ctx) => {
      const r = (await ctx.db.query("deviceReports").withIndex("by_device", (q) => q.eq("deviceId", a.deviceId)).unique())!;
      await ctx.db.patch(r._id, { trustedKeyIds: [TEST_KEY.keyId, TEST_KEY_2.keyId] });
    });
    const res = await viewer.as.query(api.keys.trustProgress, page);
    expect(res).toMatchObject({ page: { total: 2, trustNext: 1 }, isDone: true });
    expect(b.deviceId).toBeDefined();
    await expectCode(viewer.as.query(api.keys.trustProgress, { paginationOpts: { numItems: 201, cursor: null } }), "invalid_argument");
  });
});

describe("many retired keys", () => {
  test("a device is told the NEWEST 20 retired keys plus the active one, oldest first (never the oldest 20)", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const viewer = await asMember(t, { role: "viewer", orgId });
    await t.run(async (ctx) => {
      for (let i = 0; i < 25; i++) {
        await ctx.db.insert("policyKeys", {
          orgId,
          keyId: `retired${String(i).padStart(2, "0")}`,
          publicKey: TEST_KEY_2.publicKeyB64,
          status: "retired",
          createdAt: i + 1, // older than the active key, which was created "now"
        });
      }
    });
    const ids = (await viewer.as.query(api.keys.status, {})).keys.map((k) => k.keyId);
    const retired = ids.filter((id) => id.startsWith("retired"));
    expect(retired).toEqual(Array.from({ length: 20 }, (_, i) => `retired${String(i + 5).padStart(2, "0")}`));
    expect(ids.at(-1)).toBe(TEST_KEY.keyId);
    expect(ids).toHaveLength(21);

    const { deviceId, secret } = await enrollDevice(t, orgId);
    await drain(t);
    const state = await t.query(api.devices.headState, { deviceId, deviceSecret: secret });
    if (state.kind !== "ok") throw new Error("expected ok");
    expect(state.keys.map((k) => k.keyId)).toEqual(ids);
    expect(state.retiredKeyIds).toEqual(retired);
  });
});

describe("keys:status and secrets (plan 4.7)", () => {
  test("status reports ok / missing / mismatch and the env key ids, never a seed", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const viewer = await asMember(t, { role: "viewer", orgId });
    const s = await viewer.as.query(api.keys.status, {});
    expect(s).toMatchObject({ signing: "ok", env: { active: { keyId: TEST_KEY.keyId }, next: null }, publishFailedAt: null });
    expect(s.keys).toEqual([
      expect.objectContaining({ keyId: TEST_KEY.keyId, fingerprint: "21fe 31df a154 a261", status: "active", endorsedBy: null }),
    ]);
    setSeeds(undefined);
    expect((await viewer.as.query(api.keys.status, {})).signing).toBe("missing");
    setSeeds(TEST_SEED_2_B64, TEST_SEED_B64);
    const mismatch = await viewer.as.query(api.keys.status, {});
    expect(mismatch).toMatchObject({ signing: "mismatch", env: { active: { keyId: TEST_KEY_2.keyId }, next: { keyId: TEST_KEY.keyId } } });
    expect(JSON.stringify(mismatch)).not.toContain(TEST_SEED_B64);
    expect(JSON.stringify(mismatch)).not.toContain(TEST_SEED_2_B64);
  });

  test("no member query returns a seed, the exit-PIN hash, a document payload or a signature", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const o = await owner(t, orgId);
    const groupId = await t.run((ctx) => ctx.db.insert("groups", { orgId, name: "Sales" }));
    const { deviceId } = await enrollDevice(t, orgId, { groupId });
    await t.run(async (ctx) => {
      const s = (await ctx.db.query("orgSecrets").withIndex("by_org", (q) => q.eq("orgId", orgId)).unique())!;
      await ctx.db.patch(s._id, { exitPinHash: VECTOR_PIN_HASH });
      await ctx.db.patch(orgId, { exitPinSetAt: Date.now() });
    });
    await drain(t);
    const body = (await t.run((ctx) => ctx.db.query("desiredBodies").withIndex("by_device_version", (q) => q.eq("deviceId", deviceId)).first()))!;
    expect(body.payload).toContain(VECTOR_PIN_HASH); // the device needs it, signed

    const results = [
      await o.as.query(api.keys.status, {}),
      await o.as.query(api.keys.trustProgress, { paginationOpts: { numItems: 50, cursor: null } }),
      await o.as.query(api.fleet.get, { deviceId }),
      await o.as.query(api.fleet.list, { paginationOpts: { numItems: 50, cursor: null } }),
      await o.as.query(api.settings.get, {}),
      await o.as.query(api.groups.get, { groupId }),
    ];
    const secrets = [TEST_SEED_B64, TEST_SEED_2_B64, base64Encode(TEST_KEY.seed), VECTOR_PIN_HASH, body.payload, body.signature];
    for (const r of results) {
      expectNoSecrets(r, secrets);
      expect(JSON.stringify(r)).not.toContain("payload");
    }
    // The device page shows the published versions (Step 8) and the list the newest one.
    expect((results[2] as { versions: { version: number; reason: string }[] }).versions).toEqual([
      expect.objectContaining({ version: 1, reason: "First signed document" }),
    ]);
    const list = results[3] as { page: { _id: string; latestVersion: number | null }[] };
    expect(list.page.find((d) => d._id === deviceId)?.latestVersion).toBe(1);
    // And no audit row carries one either.
    const audit = JSON.stringify(await auditRows(t, orgId));
    for (const s of secrets) expect(audit.includes(s)).toBe(false);
  });
});
