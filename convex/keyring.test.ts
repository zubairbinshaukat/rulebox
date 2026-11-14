import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { setupAuth } from "../tests/convex/auth";
import { enrollDevice } from "../tests/convex/devices";
import { asMember, expectCode, giveStepUp, makeOrg, type T } from "../tests/convex/identity";
import { insertKeyRow, setSeeds, TEST_KEY, TEST_KEY_2, TEST_SEED_B64 } from "../tests/convex/keys";
import { createKeys, MASTER_A, MASTER_B, setMaster } from "../tests/convex/phase5";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { auditPolicy } from "./lib/audit";
import { base64Decode } from "./lib/crypto";
import { masterKeyIds, masterKeys, openOrgKey, rewrapSecret, unwrapSecret, wrapSecret } from "./lib/keyring";
import { REWRAP_BATCH } from "./lib/limits";
import { decodeKey32, keyFromSeed, loadOrgSigningKey, signPayload, verifyPayload } from "./lib/signing";

// The keyring (Phase 5 Step 10, plan 4.18): per-organization signing and sealing keys wrapped by the deployment master key,
// the one-time move of the Phase 4 deployment key (`keys:migrateFromEnv`), master key rotation, and isolation between
// organizations. Only throwaway keys (tests/convex/phase5.ts, the RFC 8032 test keys).

beforeEach(() => {
  vi.useFakeTimers();
  auditPolicy.strict = true;
  setMaster(MASTER_A);
});
afterEach(() => {
  vi.useRealTimers();
  auditPolicy.strict = false;
  setMaster(undefined);
  setSeeds(TEST_SEED_B64);
});

const drain = (t: T) => t.finishAllScheduledFunctions(vi.runAllTimers);
const ctx = { runAction: null };

async function owner(t: T, orgId: Id<"organizations">) {
  const m = await asMember(t, { role: "owner", orgId });
  await giveStepUp(t, m);
  return m;
}

/** What `loadOrgSigningKey` gives, reduced to plain values (a key object cannot leave `t.run`). */
const signingInfo = (t: T, orgId: Id<"organizations">, which: "active" | "next" = "active") =>
  t.run(async (ctx) => {
    const r = await loadOrgSigningKey(ctx, orgId, which);
    if (!r.ok) return { ok: false as const, reason: r.reason };
    return { ok: true as const, keyId: r.key.keyId, publicKey: r.row.publicKey, signature: signPayload("payload", r.key.seed) };
  });
/** `openOrgKey`, reduced to plain values; `publicKey` is derived from an opened signing seed. */
const keyState = (t: T, orgId: Id<"organizations">, purpose: "signing" | "sealing", status: "active" | "next" | "retired" = "active") =>
  t.run(async (ctx) => {
    const s = await openOrgKey(ctx, orgId, purpose, status);
    if (s.kind !== "open") return { kind: s.kind };
    return { kind: s.kind, keyId: s.key.keyId, publicKey: purpose === "signing" ? keyFromSeed(s.key.secret).publicKeyB64 : null };
  });

const orgKeyRows = (t: T, orgId: Id<"organizations">) =>
  t.run((ctx) => ctx.db.query("orgKeys").withIndex("by_org_purpose_status", (q) => q.eq("orgId", orgId)).take(20));
const policyRows = (t: T, orgId: Id<"organizations">) =>
  t.run((ctx) => ctx.db.query("policyKeys").withIndex("by_org_key_id", (q) => q.eq("orgId", orgId)).take(20));
const auditActions = async (t: T, orgId: Id<"organizations">) =>
  (await t.run((ctx) => ctx.db.query("auditLog").withIndex("by_org_at", (q) => q.eq("orgId", orgId)).take(100))).map((r) => r.action);

describe("wrapping with the master key", () => {
  const binding = { orgId: "org_a", purpose: "signing" as const, keyId: "0123456789abcdef" };

  test("round trip; the org, purpose and key id are bound; a changed byte or another master key does not open", () => {
    const secret = Uint8Array.from({ length: 32 }, (_, i) => i);
    const w = wrapSecret(ctx, secret, binding)!;
    expect(w.masterKeyId).toBe(masterKeyIds().active);
    expect(w.masterKeyId).toMatch(/^[0-9a-f]{16}$/);
    expect(unwrapSecret(w, binding)).toEqual(secret);
    for (const other of [{ ...binding, orgId: "org_b" }, { ...binding, purpose: "sealing" as const }, { ...binding, keyId: "fedcba9876543210" }]) {
      expect(unwrapSecret(w, other)).toBeNull();
    }
    const raw = base64Decode(w.wrapped)!;
    raw[30] = raw[30]! ^ 1;
    expect(unwrapSecret({ ...w, wrapped: btoa(String.fromCharCode(...raw)) }, binding)).toBeNull();
    setMaster(MASTER_B);
    expect(unwrapSecret(w, binding)).toBeNull(); // wrapped by a master key this deployment no longer has
  });

  test("a missing or malformed master key wraps and opens nothing (fails closed)", () => {
    setMaster(undefined);
    expect(masterKeys()).toEqual({ active: null, next: null });
    expect(wrapSecret(ctx, new Uint8Array(32), binding)).toBeNull();
    for (const bad of ["", "not base64!!", btoa("short"), btoa("x".repeat(33))]) {
      setMaster(bad);
      expect(masterKeys().active, bad).toBeNull();
    }
  });

  test("rewrapSecret moves a row to the next master key and the next key alone then opens it", () => {
    const w = wrapSecret(ctx, new Uint8Array(32).fill(4), binding)!;
    setMaster(MASTER_A, MASTER_B);
    const moved = rewrapSecret(ctx, w, binding)!;
    expect(moved.masterKeyId).toBe(masterKeyIds().next);
    setMaster(MASTER_B);
    expect(unwrapSecret(moved, binding)).toEqual(new Uint8Array(32).fill(4));
  });
});

describe("keys:createOrgKeys", () => {
  test("a new organization gets its own signing key (registered as its active key, with a publish) and a sealing key; the keys do not show in the audit", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t, "Acme", { noKey: true });
    expect(await createKeys(t, orgId)).toEqual({ signing: "created", sealing: "created" });
    const rows = await orgKeyRows(t, orgId);
    expect(rows.map((r) => [r.purpose, r.status, r.origin ?? "generated"]).sort()).toEqual([
      ["sealing", "active", "generated"],
      ["signing", "active", "generated"],
    ]);
    const signing = rows.find((r) => r.purpose === "signing")!;
    const registered = await policyRows(t, orgId);
    expect(registered).toHaveLength(1);
    expect(registered[0]).toMatchObject({ keyId: signing.keyId, status: "active" });
    // The wrapped seed opens, derives the registered public key, and never appears in the clear.
    expect(await keyState(t, orgId, "signing")).toEqual({ kind: "open", keyId: signing.keyId, publicKey: registered[0]!.publicKey });
    expect(signing.wrapped).not.toContain(registered[0]!.publicKey);
    expect(await auditActions(t, orgId)).toContain("org.keysCreated");
    const queue = await t.run((ctx) => ctx.db.query("publishQueue").withIndex("by_org", (q) => q.eq("orgId", orgId)).unique());
    expect(queue).toMatchObject({ allDevices: true });
  });

  test("idempotent: a second call writes nothing; a Phase 4 organization keeps its registered key and gets only the sealing key", async () => {
    const t = await setupAuth();
    const fresh = await makeOrg(t, "Fresh", { noKey: true });
    await createKeys(t, fresh);
    const before = await orgKeyRows(t, fresh);
    expect(await createKeys(t, fresh)).toEqual({ signing: "exists", sealing: "exists" });
    expect(await orgKeyRows(t, fresh)).toEqual(before);

    const legacy = await makeOrg(t, "Legacy"); // TEST_KEY registered, no orgKeys
    expect(await createKeys(t, legacy)).toEqual({ signing: "legacy", sealing: "created" });
    expect((await orgKeyRows(t, legacy)).map((r) => r.purpose)).toEqual(["sealing"]);
    expect((await policyRows(t, legacy)).map((r) => r.keyId)).toEqual([TEST_KEY.keyId]);
  });

  test("without a master key nothing is created and nothing is returned but the state", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t, "Acme", { noKey: true });
    setMaster(undefined);
    expect(await createKeys(t, orgId)).toEqual({ signing: "no_master_key", sealing: "no_master_key" });
    expect(await orgKeyRows(t, orgId)).toEqual([]);
    expect(await policyRows(t, orgId)).toEqual([]);
  });

  test("setup:createOwnerInvite makes the keys of a new organization when the deployment has a master key", async () => {
    const t = await setupAuth();
    const r = await t.action(internal.setup.createOwnerInvite, { orgName: "Brand New", email: "owner@brand.test" });
    expect((await orgKeyRows(t, r.orgId)).map((x) => x.purpose).sort()).toEqual(["sealing", "signing"]);
    setMaster(undefined);
    const r2 = await t.action(internal.setup.createOwnerInvite, { orgName: "No Master", email: "owner@nomaster.test", allowAdditionalOrg: true });
    expect(await orgKeyRows(t, r2.orgId)).toEqual([]);
  });
});

describe("signing with the organization's own key", () => {
  test("loadOrgSigningKey prefers the own key, even when the deployment key differs; it signs and the registered public key verifies", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t, "Acme", { noKey: true });
    await createKeys(t, orgId);
    // The deployment's env seed is another key entirely (TEST_KEY): it must never sign for this organization.
    const r = await signingInfo(t, orgId);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.keyId).not.toBe(TEST_KEY.keyId);
    expect(verifyPayload("payload", r.signature, decodeKey32(r.publicKey)!)).toBe(true);
    expect(verifyPayload("payload", r.signature, TEST_KEY.publicKey)).toBe(false);
  });

  test("when the own key cannot be opened (no master key, the wrong one) the answer is `missing` and the env seed is NOT tried", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t, "Acme", { noKey: true });
    await createKeys(t, orgId);
    for (const m of [undefined, MASTER_B]) {
      setMaster(m);
      expect(await signingInfo(t, orgId)).toEqual({ ok: false, reason: "missing" });
      expect(await keyState(t, orgId, "signing")).toEqual({ kind: "locked" });
    }
  });

  test("an organization without own keys signs with the deployment key exactly as in Phase 4", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const r = await signingInfo(t, orgId);
    expect(r.ok && r.keyId).toBe(TEST_KEY.keyId);
    expect(await keyState(t, orgId, "signing")).toEqual({ kind: "none" });
  });

  test("two organizations: each document verifies with its own key and fails with the other's (the payload also names the organization)", async () => {
    const t = await setupAuth();
    const a = await makeOrg(t, "Org A", { noKey: true });
    const b = await makeOrg(t, "Org B", { noKey: true });
    await createKeys(t, a);
    await createKeys(t, b);
    await drain(t); // the publish requests of the key creation
    const da = await enrollDevice(t, a);
    const db = await enrollDevice(t, b);
    await drain(t);
    const envelope = async (deviceId: Id<"devices">, secret: string) => await t.query(api.devices.fetchDesired, { deviceId, deviceSecret: secret, version: 1 });
    const ea = await envelope(da.deviceId, da.secret);
    const eb = await envelope(db.deviceId, db.secret);
    const keyOf = async (orgId: Id<"organizations">) => decodeKey32((await policyRows(t, orgId))[0]!.publicKey)!;
    expect(verifyPayload(ea.payload, ea.signature, await keyOf(a))).toBe(true);
    expect(verifyPayload(eb.payload, eb.signature, await keyOf(b))).toBe(true);
    expect(verifyPayload(ea.payload, ea.signature, await keyOf(b))).toBe(false);
    expect(verifyPayload(eb.payload, eb.signature, await keyOf(a))).toBe(false);
    expect(JSON.parse(ea.payload)).toMatchObject({ orgId: a });
    expect(JSON.parse(eb.payload)).toMatchObject({ orgId: b });
    expect((await policyRows(t, a))[0]!.keyId).not.toBe((await policyRows(t, b))[0]!.keyId);
  });

  test("a wrapped row copied into another organization (or another purpose or key id) does not open there", async () => {
    const t = await setupAuth();
    const a = await makeOrg(t, "Org A", { noKey: true });
    const b = await makeOrg(t, "Org B", { noKey: true });
    await createKeys(t, a);
    const rowA = (await orgKeyRows(t, a)).find((r) => r.purpose === "signing")!;
    await t.run((ctx) =>
      ctx.db.insert("orgKeys", { orgId: b, purpose: "signing", keyId: rowA.keyId, wrapped: rowA.wrapped, masterKeyId: rowA.masterKeyId, status: "active", createdAt: Date.now() }),
    );
    await t.run((ctx) => ctx.db.insert("policyKeys", { orgId: b, keyId: rowA.keyId, publicKey: "x", status: "active", createdAt: Date.now() }));
    expect(await keyState(t, b, "signing")).toEqual({ kind: "locked" });
    expect(await signingInfo(t, b)).toEqual({ ok: false, reason: "missing" });
    // The same row as a SEALING row of organization A does not open either.
    await t.run((ctx) =>
      ctx.db.insert("orgKeys", { orgId: a, purpose: "sealing", keyId: rowA.keyId, wrapped: rowA.wrapped, masterKeyId: rowA.masterKeyId, status: "next", createdAt: Date.now() }),
    );
    expect(await keyState(t, a, "sealing", "next")).toEqual({ kind: "locked" });
  });
});

describe("keys:migrateFromEnv", () => {
  test("wraps the deployment key as the organization's own key with the SAME key id; signing then works without the env seed; nothing is republished", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t); // TEST_KEY registered and active, as in Phase 4
    const o = await owner(t, orgId);
    const before = await policyRows(t, orgId);
    expect(await o.as.action(api.keys.migrateFromEnv, {})).toEqual({ keyId: TEST_KEY.keyId, fingerprint: "21fe 31df a154 a261" });

    const rows = await orgKeyRows(t, orgId);
    expect(rows.map((r) => [r.purpose, r.origin ?? null]).sort()).toEqual([["sealing", null], ["signing", "env"]]);
    expect(rows.find((r) => r.purpose === "signing")!.keyId).toBe(TEST_KEY.keyId);
    expect(JSON.stringify(rows)).not.toContain(TEST_SEED_B64);
    expect(await policyRows(t, orgId)).toEqual(before); // the key id did not change: no device is re-enrolled
    expect(await t.run((ctx) => ctx.db.query("publishQueue").withIndex("by_org", (q) => q.eq("orgId", orgId)).unique())).toBeNull();
    expect(await auditActions(t, orgId)).toContain("org.keysCreated");

    setSeeds(undefined); // the env variable can go away once everyone has moved
    const r = await signingInfo(t, orgId);
    expect(r.ok && r.keyId).toBe(TEST_KEY.keyId);

    const status = await o.as.query(api.keys.status, {});
    expect(status.orgKeys).toEqual({
      master: true,
      signing: { keyId: TEST_KEY.keyId, fingerprint: "21fe 31df a154 a261", origin: "env" },
      sealing: { keyId: rows.find((r) => r.purpose === "sealing")!.keyId },
      locked: false,
    });
    expect(status.signing).toBe("ok");
    expect(JSON.stringify(status)).not.toContain("wrapped");
  });

  test("refusals: no master key, no env seed, the env key is not this organization's active key, already migrated", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const o = await owner(t, orgId);
    setMaster(undefined);
    await expectCode(o.as.action(api.keys.migrateFromEnv, {}), "not_ready");
    setMaster(MASTER_A);
    setSeeds(undefined);
    await expectCode(o.as.action(api.keys.migrateFromEnv, {}), "not_ready");
    setSeeds(TEST_SEED_B64);

    const other = await makeOrg(t, "Other", { noKey: true });
    await insertKeyRow(t, other, TEST_KEY_2, "active"); // the deployment key is TEST_KEY, not this organization's key
    const o2 = await owner(t, other);
    await expect(o2.as.action(api.keys.migrateFromEnv, {})).rejects.toMatchObject({ data: { code: "conflict", detail: "key_not_registered" } });
    expect(await orgKeyRows(t, other)).toEqual([]);

    await o.as.action(api.keys.migrateFromEnv, {});
    await expect(o.as.action(api.keys.migrateFromEnv, {})).rejects.toMatchObject({ data: { code: "conflict", detail: "already_migrated" } });
    expect(await orgKeyRows(t, orgId)).toHaveLength(2);
  });

  test("needs a fresh step-up and the Owner role; a viewer or an admin is refused", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const admin = await asMember(t, { role: "admin", orgId });
    await giveStepUp(t, admin);
    await expectCode(admin.as.action(api.keys.migrateFromEnv, {}), "forbidden");
    const stale = await asMember(t, { role: "owner", orgId });
    await giveStepUp(t, stale, { verifiedAgoMs: 6 * 60_000, activeAgoMs: 0 });
    await expectCode(stale.as.action(api.keys.migrateFromEnv, {}), "step_up_required");
    expect(await orgKeyRows(t, orgId)).toEqual([]);
  });

  test("the Phase 4 key functions are refused for an organization whose keys live in the keyring", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const o = await owner(t, orgId);
    await o.as.action(api.keys.migrateFromEnv, {});
    for (const fn of [api.keys.registerActive, api.keys.prepareRotation, api.keys.finishRotation]) {
      await expect(o.as.mutation(fn, {})).rejects.toMatchObject({ data: { code: "conflict", detail: "org_keys" } });
    }
  });

  test("keys:status for a locked organization says so, without any key material", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const o = await owner(t, orgId);
    await o.as.action(api.keys.migrateFromEnv, {});
    setMaster(undefined);
    const s = await o.as.query(api.keys.status, {});
    expect(s.orgKeys.master).toBe(false);
    expect(s.orgKeys.locked).toBe(true);
    expect(s.signing).toBe("missing");
  });
});

describe("keys:rewrapAll (master key rotation)", () => {
  async function twoOrgs(t: T) {
    const a = await makeOrg(t, "Org A", { noKey: true });
    const b = await makeOrg(t, "Org B", { noKey: true });
    await createKeys(t, a);
    await createKeys(t, b);
    return [a, b] as const;
  }

  test("re-wraps every row with the next master key, audits once per organization, and the swapped env opens them all", async () => {
    const t = await setupAuth();
    const [a, b] = await twoOrgs(t);
    const signing = (orgId: Id<"organizations">) => signingInfo(t, orgId);
    const keyA = await signing(a);
    setMaster(MASTER_A, MASTER_B);
    const nextId = masterKeyIds().next;
    expect(await t.action(internal.keys.rewrapAll, {})).toEqual({ rewrapped: 4, failed: 0, state: "ok" });
    for (const orgId of [a, b]) for (const r of await orgKeyRows(t, orgId)) expect(r.masterKeyId).toBe(nextId);
    expect((await auditActions(t, a)).filter((x) => x === "org.keysRewrapped")).toHaveLength(1);
    // Both master keys are set, so both generations open; then the operator swaps the values and drops the old one.
    expect((await signing(a)).ok).toBe(true);
    setMaster(MASTER_B);
    const after = await signing(a);
    expect(after.ok && keyA.ok && after.keyId === keyA.keyId).toBe(true);
    expect((await signing(b)).ok).toBe(true);
    // Nothing left to do: the next run finds no row wrapped by the (now) active key... it is the new active key, so a rotation
    // with no `_NEXT` set reports it.
    expect(await t.action(internal.keys.rewrapAll, {})).toEqual({ rewrapped: 0, failed: 0, state: "no_next_key" });
  });

  test("rows that cannot be opened are counted and left alone; a run with no progress does not reschedule", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t, "Org A", { noKey: true });
    const active = masterKeyIds().active!;
    await t.run(async (ctx) => {
      for (let i = 0; i < REWRAP_BATCH; i++) {
        await ctx.db.insert("orgKeys", { orgId, purpose: "sealing", keyId: String(i).padStart(16, "0"), wrapped: "AAAA", masterKeyId: active, status: "retired", createdAt: 1 });
      }
    });
    setMaster(MASTER_A, MASTER_B);
    expect(await t.action(internal.keys.rewrapAll, {})).toEqual({ rewrapped: 0, failed: REWRAP_BATCH, state: "ok" });
    expect(await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).toEqual([]);
    expect((await orgKeyRows(t, orgId)).every((r) => r.wrapped === "AAAA" && r.masterKeyId === active)).toBe(true);
  });

  test("storeRewrapped is compare-and-set: a row that moved meanwhile is left alone", async () => {
    const t = await setupAuth();
    const orgId = await makeOrg(t, "Org A", { noKey: true });
    const id = await t.run((ctx) =>
      ctx.db.insert("orgKeys", { orgId, purpose: "sealing", keyId: "0000000000000001", wrapped: "AAAA", masterKeyId: "bbbbbbbbbbbbbbbb", status: "active", createdAt: 1 }),
    );
    expect(await t.mutation(internal.keys.storeRewrapped, { updates: [{ id, from: "aaaaaaaaaaaaaaaa", wrapped: "ZZZZ", masterKeyId: "cccccccccccccccc" }] })).toBe(0);
    expect((await orgKeyRows(t, orgId))[0]).toMatchObject({ wrapped: "AAAA", masterKeyId: "bbbbbbbbbbbbbbbb" });
    expect(await t.mutation(internal.keys.storeRewrapped, { updates: [{ id, from: "bbbbbbbbbbbbbbbb", wrapped: "ZZZZ", masterKeyId: "cccccccccccccccc" }] })).toBe(1);
  });
});
