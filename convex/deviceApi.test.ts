import { argon2id } from "hash-wasm";
import { afterEach, describe, expect, test, vi } from "vitest";
import { setupAuth } from "../tests/convex/auth";
import { enrollDevice, legacyDevice, probe } from "../tests/convex/devices";
import { expectCode, expectNoSecrets, makeOrg, type T } from "../tests/convex/identity";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import source from "./deviceApi.ts?raw";
import { ARGON2_PARAMS, DUMMY_PHC, verifier } from "./lib/argon";
import { sha256HexSync } from "./lib/crypto";
import { BYTES_PER_GB, EMPLOYEE_LOCK_MS, EMPLOYEE_MAX_FAILURES } from "./lib/deviceApiRules";
import { DAY_MS, MINUTE_MS } from "./lib/limits";
import { rateLimiter } from "./lib/rateLimits";

// The device API (plan Step 12; 4.11, 4.12, 5.1 amended, A9, A12): employee
// sign-in, the batched report and credential rotation, as the agent calls them.

const PASSWORD = "correct horse 1";
const SALT = new TextEncoder().encode("rulebox-test-slt");
let phcOnce: Promise<string> | null = null;
/** One Argon2id hash for the whole file (fixed salt; the agent's parameters). */
const testPhc = () => (phcOnce ??= argon2id({ password: PASSWORD, salt: SALT, ...ARGON2_PARAMS, outputType: "encoded" }));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Freeze `Date.now()` (convex-test and the rate limiter read the same clock). */
function at(ms: number): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(ms);
}

type Seed = {
  t: T;
  orgId: Id<"organizations">;
  groupId: Id<"groups">;
  device: { deviceId: Id<"devices">; secret: string };
  employeeId: Id<"employees">;
  phc: string;
};

async function addEmployee(
  t: T,
  orgId: Id<"organizations">,
  opts: { username: string; name?: string; groupId?: Id<"groups">; disabled?: boolean; quotaGb?: number; password?: boolean },
): Promise<Id<"employees">> {
  const phc = await testPhc();
  return await t.run(async (ctx) => {
    const employeeId = await ctx.db.insert("employees", {
      orgId,
      name: opts.name ?? "Maya Lind",
      username: opts.username,
      searchText: `${opts.name ?? "maya lind"} ${opts.username}`,
      quotaGb: opts.quotaGb,
      disabled: opts.disabled === true,
      credentialRevision: 4,
      passwordSetAt: opts.password === false ? undefined : Date.now(),
      revision: 0,
      createdAt: Date.now(),
    });
    if (opts.password !== false) await ctx.db.insert("employeeSecrets", { employeeId, passwordHash: phc });
    if (opts.groupId !== undefined) await ctx.db.insert("groupMembers", { orgId, groupId: opts.groupId, employeeId });
    return employeeId;
  });
}

async function seed(): Promise<Seed> {
  const t = await setupAuth();
  const orgId = await makeOrg(t);
  const groupId = await t.run((ctx) => ctx.db.insert("groups", { orgId, name: "Front desk", revision: 0, createdAt: Date.now() }));
  const device = await enrollDevice(t, orgId, { groupId, name: "Desk 1" });
  const employeeId = await addEmployee(t, orgId, { username: "maya", groupId });
  return { t, orgId, groupId, device, employeeId, phc: await testPhc() };
}

const creds = (d: { deviceId: string; secret: string }) => ({ deviceId: d.deviceId, deviceSecret: d.secret });

function verify(t: T, d: { deviceId: string; secret: string }, username: string, password: string) {
  return t.action(api.deviceApi.verifyEmployee, { ...creds(d), username, password });
}

async function auditRows(t: T, orgId: Id<"organizations">) {
  return await t.run((ctx) => ctx.db.query("auditLog").withIndex("by_org_at", (q) => q.eq("orgId", orgId)).take(500));
}

async function lockRow(t: T, employeeId: Id<"employees">) {
  return await t.run((ctx) => ctx.db.query("employeeLockouts").withIndex("by_employee", (q) => q.eq("employeeId", employeeId)).unique());
}

/** Tokens left in the device's sign-in bucket (component state, read the way the limiter reads it). */
async function bucketValue(t: T, deviceId: string): Promise<number> {
  return await t.run(async (ctx) => (await rateLimiter.getValue(ctx, "verifyPerDevice", { key: deviceId })).value);
}

describe("deviceApi:verifyEmployee (plan 4.12)", () => {
  test("ok: the employee, quota in bytes, offline days and credential revision; no audit, no limiter token, no secret", async () => {
    const s = await seed();
    const before = await bucketValue(s.t, s.device.deviceId);
    const answer = await verify(s.t, s.device, "  Maya ", PASSWORD);
    expect(answer).toEqual({
      kind: "ok",
      employee: { id: s.employeeId, username: "maya", name: "Maya Lind", role: null, quotaBytes: 10 * BYTES_PER_GB },
      offlineDays: 3,
      credentialRevision: 4,
    });
    expectNoSecrets(answer, [s.phc, PASSWORD]);
    expect(await bucketValue(s.t, s.device.deviceId)).toBe(before);
    expect(await auditRows(s.t, s.orgId)).toHaveLength(1); // only device.enrolled
    // The employee's own quota wins; 0 = unlimited.
    await addEmployee(s.t, s.orgId, { username: "ola", groupId: s.groupId, quotaGb: 0 });
    expect(await verify(s.t, s.device, "ola", PASSWORD)).toMatchObject({ kind: "ok", employee: { quotaBytes: 0 } });
  });

  test("a successful sign-in in the same minute writes nothing at all; it refreshes liveness when due (counts as a ping)", async () => {
    const s = await seed();
    const t0 = Date.UTC(2026, 10, 1, 9, 0, 10);
    at(t0);
    await s.t.run(async (ctx) => {
      const row = (await ctx.db.query("deviceLiveness").withIndex("by_device", (q) => q.eq("deviceId", s.device.deviceId)).unique())!;
      await ctx.db.patch(row._id, { seenBucket: Math.floor(t0 / MINUTE_MS) - 30 });
    });
    expect((await verify(s.t, s.device, "maya", PASSWORD)).kind).toBe("ok");
    const live = await s.t.run((ctx) => ctx.db.query("deviceLiveness").withIndex("by_device", (q) => q.eq("deviceId", s.device.deviceId)).unique());
    expect(live?.seenBucket).toBe(Math.floor(t0 / MINUTE_MS));
    const { io } = await probe(() => verify(s.t, s.device, "maya", PASSWORD));
    expect(io.writes).toBe(0);
    expect(io.tables.has("employeeLockouts")).toBe(true); // read by the query only
    expect(io.tables.has("deviceCredentials")).toBe(true);
  });

  test("wrong password: wrongCredentials, one limiter token and one failure counted", async () => {
    const s = await seed();
    const before = await bucketValue(s.t, s.device.deviceId);
    expect(await verify(s.t, s.device, "maya", "wrong password")).toEqual({ kind: "wrongCredentials" });
    expect(await bucketValue(s.t, s.device.deviceId)).toBe(before - 1);
    expect(await lockRow(s.t, s.employeeId)).toMatchObject({ failures: 1, lockedUntil: 0 });
  });

  test("unknown username: wrongCredentials after one verify against the dummy hash (same answer as a wrong password)", async () => {
    const s = await seed();
    const spy = vi.spyOn(verifier, "verify");
    expect(await verify(s.t, s.device, "nobody", PASSWORD)).toEqual({ kind: "wrongCredentials" });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[1]).toBe(DUMMY_PHC);
    // Malformed usernames and an employee without a password take the same path.
    spy.mockClear();
    expect(await verify(s.t, s.device, "x".repeat(65), PASSWORD)).toEqual({ kind: "wrongCredentials" });
    await addEmployee(s.t, s.orgId, { username: "nopass", groupId: s.groupId, password: false });
    expect(await verify(s.t, s.device, "nopass", PASSWORD)).toEqual({ kind: "wrongCredentials" });
    expect(spy.mock.calls.map((c) => c[1])).toEqual([DUMMY_PHC, DUMMY_PHC]);
  });

  test("disabled: only with the right password; a wrong one is wrongCredentials", async () => {
    const s = await seed();
    await addEmployee(s.t, s.orgId, { username: "gone", groupId: s.groupId, disabled: true });
    expect(await verify(s.t, s.device, "gone", "wrong password")).toEqual({ kind: "wrongCredentials" });
    expect(await verify(s.t, s.device, "gone", PASSWORD)).toEqual({ kind: "disabled" });
  });

  test("notAllowedHere: right password, not in the device's group (or the device has none); a wrong one is wrongCredentials", async () => {
    const s = await seed();
    const other = await s.t.run((ctx) => ctx.db.insert("groups", { orgId: s.orgId, name: "Back office", revision: 0, createdAt: Date.now() }));
    await addEmployee(s.t, s.orgId, { username: "back", groupId: other });
    expect(await verify(s.t, s.device, "back", "wrong password")).toEqual({ kind: "wrongCredentials" });
    expect(await verify(s.t, s.device, "back", PASSWORD)).toEqual({ kind: "notAllowedHere" });
    const loose = await enrollDevice(s.t, s.orgId, { name: "No group" });
    expect(await verify(s.t, loose, "maya", PASSWORD)).toEqual({ kind: "notAllowedHere" });
  });

  test("the same username in another organization is not found from this device", async () => {
    const s = await seed();
    const orgB = await makeOrg(s.t, "Other");
    const groupB = await s.t.run((ctx) => ctx.db.insert("groups", { orgId: orgB, name: "B", revision: 0, createdAt: Date.now() }));
    await addEmployee(s.t, orgB, { username: "sam", groupId: groupB });
    const spy = vi.spyOn(verifier, "verify");
    expect(await verify(s.t, s.device, "sam", PASSWORD)).toEqual({ kind: "wrongCredentials" });
    expect(spy.mock.calls[0]?.[1]).toBe(DUMMY_PHC);
    // And org B's device does not see org A's employee.
    const deviceB = await enrollDevice(s.t, orgB, { groupId: groupB });
    expect(await verify(s.t, deviceB, "maya", PASSWORD)).toEqual({ kind: "wrongCredentials" });
  });

  test(`${EMPLOYEE_MAX_FAILURES} wrong passwords lock for 15 minutes (audited once); the lock holds for the right password, then expires`, async () => {
    const s = await seed();
    const t0 = Date.UTC(2026, 10, 1, 10, 0, 0);
    at(t0);
    for (let i = 1; i < EMPLOYEE_MAX_FAILURES; i++) {
      expect(await verify(s.t, s.device, "maya", `wrong ${i}`)).toEqual({ kind: "wrongCredentials" });
    }
    expect(await verify(s.t, s.device, "maya", "wrong last")).toEqual({ kind: "lockedOut", retryAfterMs: EMPLOYEE_LOCK_MS });
    const locks = (await auditRows(s.t, s.orgId)).filter((r) => r.action === "employee.lockedOut");
    expect(locks).toHaveLength(1);
    expect(locks[0]).toMatchObject({ actorType: "device", actorId: s.device.deviceId, targetId: s.employeeId });
    const spy = vi.spyOn(verifier, "verify");
    at(t0 + 5 * MINUTE_MS);
    expect(await verify(s.t, s.device, "maya", PASSWORD)).toEqual({ kind: "lockedOut", retryAfterMs: EMPLOYEE_LOCK_MS - 5 * MINUTE_MS });
    expect(spy).not.toHaveBeenCalled();
    at(t0 + EMPLOYEE_LOCK_MS + 1);
    expect((await verify(s.t, s.device, "maya", PASSWORD)).kind).toBe("ok");
    expect(await lockRow(s.t, s.employeeId)).toBeNull();
    // Nothing secret in any audit row.
    expectNoSecrets(await auditRows(s.t, s.orgId), [s.phc, PASSWORD, "wrong last", s.device.secret]);
  });

  test("a correct password resets the failure count", async () => {
    const s = await seed();
    for (let i = 0; i < 3; i++) await verify(s.t, s.device, "maya", "nope nope");
    expect(await lockRow(s.t, s.employeeId)).toMatchObject({ failures: 3 });
    expect((await verify(s.t, s.device, "maya", PASSWORD)).kind).toBe("ok");
    expect(await lockRow(s.t, s.employeeId)).toBeNull();
    expect(await verify(s.t, s.device, "maya", "nope nope")).toEqual({ kind: "wrongCredentials" });
    expect(await lockRow(s.t, s.employeeId)).toMatchObject({ failures: 1 });
  });

  test("per-device limit: 30 failures per minute, then lockedOut with retryAfterMs; other devices are not affected", async () => {
    // Seed on the frozen clock: a limiter bucket must never see time run backwards.
    const t0 = Date.UTC(2026, 10, 1, 11, 0, 0);
    at(t0);
    const s = await seed();
    for (let i = 0; i < 30; i++) expect((await verify(s.t, s.device, `nobody${i}`, PASSWORD)).kind).toBe("wrongCredentials");
    const limited = await verify(s.t, s.device, "maya", PASSWORD);
    expect(limited.kind).toBe("lockedOut");
    expect(limited.kind === "lockedOut" && limited.retryAfterMs > 0).toBe(true);
    const second = await enrollDevice(s.t, s.orgId, { groupId: s.groupId, name: "Desk 2" });
    expect((await verify(s.t, second, "maya", PASSWORD)).kind).toBe("ok");
    at(t0 + 2 * MINUTE_MS);
    expect((await verify(s.t, s.device, "maya", PASSWORD)).kind).toBe("ok");
  }, 60_000); // 30 Argon2id hashes: slow under CPU contention

  test("nearly empty bucket: the token is taken BEFORE the Argon2id verify, once (not again for the wrong password)", async () => {
    const s = await seed();
    at(Date.UTC(2026, 10, 1, 12, 0, 0));
    const drain = (count: number) => s.t.run((ctx) => rateLimiter.limit(ctx, "verifyPerDevice", { key: s.device.deviceId, count }));
    await drain(25); // 5 tokens left: below the reserve threshold
    const original = verifier.verify.bind(verifier);
    let seenInVerify = NaN;
    vi.spyOn(verifier, "verify").mockImplementation(async (password, phc) => {
      seenInVerify = await bucketValue(s.t, s.device.deviceId);
      return original(password, phc);
    });
    expect(await verify(s.t, s.device, "maya", "wrong password")).toEqual({ kind: "wrongCredentials" });
    expect(seenInVerify).toBe(4); // already taken when the verify ran
    expect(await bucketValue(s.t, s.device.deviceId)).toBe(4); // and not taken twice
    expect(await lockRow(s.t, s.employeeId)).toMatchObject({ failures: 1 });
    // A correct password in this state also takes its token (the price of the guard) and signs in.
    expect((await verify(s.t, s.device, "maya", PASSWORD)).kind).toBe("ok");
    expect(await bucketValue(s.t, s.device.deviceId)).toBe(3);
    // Empty: refused with no verify at all.
    await drain(3);
    seenInVerify = NaN;
    expect((await verify(s.t, s.device, "maya", PASSWORD)).kind).toBe("lockedOut");
    expect(seenInVerify).toBeNaN();
  });

  test("a correct password re-checks the lock when the device had recent failures: locked meanwhile -> lockedOut; with a full bucket a sign-in stays at 0 writes", async () => {
    const s = await seed();
    const t0 = Date.UTC(2026, 10, 1, 13, 0, 0);
    at(t0);
    await s.t.run((ctx) => rateLimiter.limit(ctx, "verifyPerDevice", { key: s.device.deviceId, count: 2 }));
    const original = verifier.verify.bind(verifier);
    // A parallel burst locks the employee while this call is inside the Argon2id verify.
    vi.spyOn(verifier, "verify").mockImplementation(async (password, phc) => {
      await s.t.run((ctx) => ctx.db.insert("employeeLockouts", { employeeId: s.employeeId, orgId: s.orgId, failures: 10, lastFailureAt: t0, lockedUntil: t0 + EMPLOYEE_LOCK_MS }));
      return original(password, phc);
    });
    expect(await verify(s.t, s.device, "maya", PASSWORD)).toEqual({ kind: "lockedOut", retryAfterMs: EMPLOYEE_LOCK_MS });
    vi.restoreAllMocks();

    // Full bucket (no recent failure): the guard is not paid for; the accepted A9 trade-off.
    const other = await seed();
    at(t0);
    const originalB = verifier.verify.bind(verifier);
    vi.spyOn(verifier, "verify").mockImplementation(async (password, phc) => {
      await other.t.run((ctx) => ctx.db.insert("employeeLockouts", { employeeId: other.employeeId, orgId: other.orgId, failures: 10, lastFailureAt: t0, lockedUntil: t0 + EMPLOYEE_LOCK_MS }));
      return originalB(password, phc);
    });
    expect((await verify(other.t, other.device, "maya", PASSWORD)).kind).toBe("ok");
  });

  test("revoked device, wrong secret or unknown id: device_rejected before any verify", async () => {
    const s = await seed();
    const spy = vi.spyOn(verifier, "verify");
    await expectCode(verify(s.t, { deviceId: s.device.deviceId, secret: "wrong" }, "maya", PASSWORD), "device_rejected");
    await expectCode(verify(s.t, { deviceId: "nope", secret: s.device.secret }, "maya", PASSWORD), "device_rejected");
    await s.t.mutation(api.devices.unenroll, creds(s.device));
    await expectCode(verify(s.t, s.device, "maya", PASSWORD), "device_rejected");
    expect(spy).not.toHaveBeenCalled();
    // A Phase 2 device (credentials still on the devices row) works until revoked.
    const legacy = await legacyDevice(s.t, s.orgId, { secret: "legacy-secret", groupId: s.groupId });
    expect((await verify(s.t, { deviceId: legacy, secret: "legacy-secret" }, "maya", PASSWORD)).kind).toBe("ok");
  });
});

// ---------------------------------------------------------------- report

const record = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  atMs: Date.now(),
  serverTimeOffsetMs: null,
  kind: "adminExitWrongPin",
  username: null,
  detail: null,
  ...extra,
});

describe("deviceApi:report audit part (plan 4.11)", () => {
  test("records become audit rows; duplicates ignored; bad kind skipped but counted and reported; bad detail and username dropped; no secrets", async () => {
    const s = await seed();
    const records = [
      record("a".repeat(32)),
      record("b".repeat(32), { kind: "employeeLockedOut", username: " Maya ", detail: "after_10" }),
      record("c".repeat(32), { kind: "adminExitFailed", detail: "PIN=123456; drop table" }),
      record("d".repeat(32), { kind: "somethingNew" }),
      record("e".repeat(32), { kind: "employeeLockedOut", username: "$argon2id$v=19$m=1" }),
    ];
    const first = await s.t.mutation(api.deviceApi.report, { ...creds(s.device), audit: { records, dropped: 0 } });
    // The unknown kind is not stored but counted, so the agent can ack the whole batch.
    expect(first).toEqual({ accepted: { installs: 0, audit: 5 } });
    const rows = (await auditRows(s.t, s.orgId)).filter((r) => r.actorType === "device" && r.action !== "device.enrolled");
    expect(rows.map((r) => r.action).sort()).toEqual([
      "device.adminExitFailed",
      "device.adminExitWrongPin",
      "device.auditDropped",
      "device.employeeLockedOut",
      "device.employeeLockedOut",
    ]);
    expect(rows.find((r) => r.action === "device.auditDropped")?.summary).toBe(
      "1 audit records were lost on the PC Desk 1 (0 while its queue was full, 1 not understood by this server)",
    );
    const byKey = new Map(rows.map((r) => [r.eventKey, r]));
    expect(byKey.get(`dev:${s.device.deviceId}:${"b".repeat(32)}`)?.summary).toBe(
      "maya was locked out after too many wrong passwords on the PC Desk 1 (after_10)",
    );
    expect(byKey.get(`dev:${s.device.deviceId}:${"c".repeat(32)}`)?.summary).toBe("The admin exit failed on the PC Desk 1");
    expect(byKey.get(`dev:${s.device.deviceId}:${"e".repeat(32)}`)?.summary).toContain("An employee was locked out");
    expectNoSecrets(rows, [s.device.secret]);
    // The same batch again: all known, nothing new.
    const again = await probe(() => s.t.mutation(api.deviceApi.report, { ...creds(s.device), audit: { records, dropped: 0 } }));
    expect(again.result).toEqual({ accepted: { installs: 0, audit: 5 } });
    expect(again.io.writes).toBe(0);
  });

  test("clock: offset applied; > 7 days ahead or before enrollment -> server time and '(device clock wrong)'", async () => {
    const now = Date.UTC(2026, 10, 2, 12, 0, 0);
    at(now - DAY_MS);
    const s = await seed();
    at(now);
    const enrolledAt = (await s.t.run((ctx) => ctx.db.get(s.device.deviceId)))!.enrolledAt;
    const records = [
      record("1".repeat(32), { atMs: now - 10_000, serverTimeOffsetMs: 4_000 }),
      record("2".repeat(32), { atMs: now + 8 * DAY_MS }),
      record("3".repeat(32), { atMs: enrolledAt - 1 }),
      record("4".repeat(32), { atMs: now - 5_000 }),
    ];
    await s.t.mutation(api.deviceApi.report, { ...creds(s.device), audit: { records, dropped: 0 } });
    const rows = new Map((await auditRows(s.t, s.orgId)).map((r) => [r.eventKey, r]));
    const row = (c: string) => rows.get(`dev:${s.device.deviceId}:${c.repeat(32)}`)!;
    expect(row("1").at).toBe(now - 6_000);
    expect(row("2")).toMatchObject({ at: now });
    expect(row("2").summary).toContain("(device clock wrong)");
    expect(row("3")).toMatchObject({ at: now });
    expect(row("3").summary).toContain("(device clock wrong)");
    expect(row("4")).toMatchObject({ at: now - 5_000 });
    expect(row("4").summary).not.toContain("clock");
  });

  test("clock (Step 17 review): a time ahead of the server by less than 7 days is clamped to the server's now", async () => {
    const now = Date.UTC(2026, 10, 2, 12, 0, 0);
    at(now - DAY_MS);
    const s = await seed();
    at(now);
    const records = [
      record("6".repeat(32), { atMs: now + 6 * DAY_MS }),
      record("7".repeat(32), { atMs: now + 1_000 }),
      record("8".repeat(32), { atMs: now - 1_000, serverTimeOffsetMs: 3_000 }),
    ];
    await s.t.mutation(api.deviceApi.report, { ...creds(s.device), audit: { records, dropped: 0 } });
    const rows = new Map((await auditRows(s.t, s.orgId)).map((r) => [r.eventKey, r]));
    for (const c of ["6", "7", "8"]) {
      const r = rows.get(`dev:${s.device.deviceId}:${c.repeat(32)}`)!;
      expect(r.at, c).toBe(now);
      expect(r.summary, c).not.toContain("clock");
    }
  });

  test("dropped > 0: one device.auditDropped row, not repeated on a replay; > 50 records refused", async () => {
    const s = await seed();
    const records = [record("f".repeat(32))];
    expect(await s.t.mutation(api.deviceApi.report, { ...creds(s.device), audit: { records, dropped: 3 } })).toEqual({ accepted: { installs: 0, audit: 1 } });
    await s.t.mutation(api.deviceApi.report, { ...creds(s.device), audit: { records, dropped: 3 } });
    const dropped = (await auditRows(s.t, s.orgId)).filter((r) => r.action === "device.auditDropped");
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.summary).toBe("3 audit records were lost on the PC Desk 1 (its queue was full)");
    const many = Array.from({ length: 51 }, (_, i) => record(i.toString(16).padStart(32, "0")));
    await expectCode(s.t.mutation(api.deviceApi.report, { ...creds(s.device), audit: { records: many, dropped: 0 } }), "invalid_argument");
    await expectCode(s.t.mutation(api.deviceApi.report, { ...creds(s.device), audit: { records: [], dropped: -1 } }), "invalid_argument");
  });

  test("no valid record at all (unknown kinds, bad ids): all counted as accepted so the agent can ack; one auditDropped row, none on a replay or a re-batch", async () => {
    const s = await seed();
    const bad = [record("k".repeat(32), { kind: "fromTheFuture" }), record("not valid!", { kind: "adminExitFailed" })];
    const args = { ...creds(s.device), audit: { records: bad, dropped: 2 } };
    expect(await s.t.mutation(api.deviceApi.report, args)).toEqual({ accepted: { installs: 0, audit: 2 } });
    const dropped = async () => (await auditRows(s.t, s.orgId)).filter((r) => r.action === "device.auditDropped");
    expect(await dropped()).toHaveLength(1);
    expect((await dropped())[0]?.summary).toBe(
      "4 audit records were lost on the PC Desk 1 (2 while its queue was full, 2 not understood by this server)",
    );
    const replay = await probe(() => s.t.mutation(api.deviceApi.report, args));
    expect(replay.result).toEqual({ accepted: { installs: 0, audit: 2 } });
    expect(replay.io.writes).toBe(0);
    // Re-batched (the queue grew, the first record is the same): still one row.
    await s.t.mutation(api.deviceApi.report, { ...args, audit: { records: [...bad, record("m".repeat(32), { kind: "fromTheFuture" })], dropped: 2 } });
    expect(await dropped()).toHaveLength(1);
    // Only malformed ids: the key is a hash of the batch, so a replay is still free.
    const worse = { ...creds(s.device), audit: { records: [record("???", { kind: "adminExitFailed" })], dropped: 0 } };
    expect(await s.t.mutation(api.deviceApi.report, worse)).toEqual({ accepted: { installs: 0, audit: 1 } });
    const again = await probe(() => s.t.mutation(api.deviceApi.report, worse));
    expect(again.io.writes).toBe(0);
    expect(await dropped()).toHaveLength(2);
  });

  test("record ids are per device: another device's identical id is its own row", async () => {
    const s = await seed();
    const other = await enrollDevice(s.t, s.orgId, { groupId: s.groupId, name: "Desk 2" });
    const records = [record("9".repeat(32))];
    await s.t.mutation(api.deviceApi.report, { ...creds(s.device), audit: { records, dropped: 0 } });
    await s.t.mutation(api.deviceApi.report, { ...creds(other), audit: { records, dropped: 0 } });
    const rows = (await auditRows(s.t, s.orgId)).filter((r) => r.action === "device.adminExitWrongPin");
    expect(rows.map((r) => r.actorId).sort()).toEqual([s.device.deviceId, other.deviceId].sort());
  });
});

describe("deviceApi:report installs part (plan 4.8 amended, A12)", () => {
  async function apps(s: Seed) {
    return await s.t.run(async (ctx) => {
      const mk = (orgId: Id<"organizations">, name: string) =>
        ctx.db.insert("apps", {
          orgId,
          name,
          kind: "desktop",
          desktop: { source: "preinstalled", exe: "{ProgramFiles}\\X\\x.exe", args: [], fileArgTemplate: [], resetFolders: [] },
          archived: false,
          revision: 1,
          createdAt: Date.now(),
        });
      const foreignOrg = await ctx.db.insert("organizations", { name: "Other" });
      const ids = { a: await mk(s.orgId, "A"), b: await mk(s.orgId, "B"), c: await mk(s.orgId, "C"), foreign: await mk(foreignOrg, "F") };
      // Assigned to the PC's group: only then do their results count (Step 17 review).
      for (const appId of [ids.a, ids.b, ids.c]) {
        await ctx.db.insert("appAssignments", { orgId: s.orgId, groupId: s.groupId, appId, audience: "everyone", pinnedTaskbar: false, pinnedDesktop: false });
      }
      return ids;
    });
  }
  const result = (appId: string, state: string, extra: Record<string, unknown> = {}) => ({
    appId,
    state: state as "installed",
    appRevision: 1,
    attempts: 1,
    exitCode: null,
    detail: null,
    ...extra,
  });
  async function installRows(s: Seed) {
    return await s.t.run((ctx) => ctx.db.query("installResults").withIndex("by_device_updated", (q) => q.eq("deviceId", s.device.deviceId)).take(100));
  }

  test("upsert, write only on change; passing states and foreign or unknown apps ignored but accepted; failedInstallCount kept", async () => {
    const s = await seed();
    const ids = await apps(s);
    const batch = [
      result(ids.a, "installed"),
      result(ids.b, "failed", { exitCode: 1603, detail: "exit_code", attempts: 2 }),
      result(ids.c, "downloading"),
      result(ids.foreign, "installed"),
      result("not-an-id", "installed"),
    ];
    expect(await s.t.mutation(api.deviceApi.report, { ...creds(s.device), installs: batch })).toEqual({ accepted: { installs: 5, audit: 0 } });
    const rows = await installRows(s);
    expect(rows.map((r) => [r.appId, r.state]).sort()).toEqual([[ids.a, "installed"], [ids.b, "failed"]].sort());
    expect(rows.find((r) => r.appId === ids.b)).toMatchObject({ exitCode: 1603, detail: "exit_code", attempts: 2 });
    const stats = async () => (await s.t.run((ctx) => ctx.db.query("orgStats").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).unique()))?.failedInstallCount ?? 0;
    expect(await stats()).toBe(1);
    const again = await probe(() => s.t.mutation(api.deviceApi.report, { ...creds(s.device), installs: batch }));
    expect(again.io.writes).toBe(0);
    // b installs on retry: exit code and detail are cleared, the failed count drops.
    await s.t.mutation(api.deviceApi.report, { ...creds(s.device), installs: [result(ids.b, "installed", { attempts: 3 })] });
    const b = (await installRows(s)).find((r) => r.appId === ids.b);
    expect(b).toMatchObject({ state: "installed", attempts: 3 });
    expect(b?.exitCode).toBeUndefined();
    expect(b?.detail).toBeUndefined();
    expect(await stats()).toBe(0);
  });

  test("installedVersion (Phase 6): stored, an unchanged report writes nothing, a change writes once, absent keeps, null or removed clears, a bad value is dropped not refused", async () => {
    const s = await seed();
    const ids = await apps(s);
    const send = (...installs: ReturnType<typeof result>[]) => s.t.mutation(api.deviceApi.report, { ...creds(s.device), installs });
    const versionOf = async () => (await installRows(s)).find((r) => r.appId === ids.a)?.installedVersion;

    await send(result(ids.a, "installed", { installedVersion: "1.2.3" }));
    expect(await versionOf()).toBe("1.2.3");
    const same = await probe(() => send(result(ids.a, "installed", { installedVersion: "1.2.3" })));
    expect(same.io.writes).toBe(0);
    // Absent keeps the stored value, and writes nothing when the rest is the same.
    const absent = await probe(() => send(result(ids.a, "installed")));
    expect(absent.io.writes).toBe(0);
    expect(await versionOf()).toBe("1.2.3");
    // A change is one row write; a state change without a version keeps it.
    const changed = await probe(() => send(result(ids.a, "installed", { installedVersion: "1.2.4-beta.1+7" })));
    expect(changed.io.writes).toBe(1);
    expect(await versionOf()).toBe("1.2.4-beta.1+7");
    await send(result(ids.a, "failed", { detail: "exit_code", attempts: 2 }));
    expect(await versionOf()).toBe("1.2.4-beta.1+7");
    // Bad values (spaces, too long, empty, a path) are dropped: the report is accepted and the stored value stays.
    for (const bad of ["1.0 beta", "9".repeat(41), "", "C:\\x\\y.exe"]) {
      const out = await send(result(ids.a, "failed", { detail: "exit_code", attempts: 2, installedVersion: bad }));
      expect(out).toEqual({ accepted: { installs: 1, audit: 0 } });
      expect(await versionOf()).toBe("1.2.4-beta.1+7");
    }
    // A bad value on a new row stores no version.
    await send(result(ids.b, "installed", { installedVersion: "not a version" }));
    expect((await installRows(s)).find((r) => r.appId === ids.b)?.installedVersion).toBeUndefined();
    // An explicit null clears it, and so does `removed`.
    await send(result(ids.a, "installed", { installedVersion: null }));
    expect(await versionOf()).toBeUndefined();
    await send(result(ids.a, "installed", { installedVersion: "2.0.0" }));
    expect(await versionOf()).toBe("2.0.0");
    await send(result(ids.a, "removed", { installedVersion: "2.0.0" }));
    expect(await versionOf()).toBeUndefined();
  });

  test("a detail outside the fixed list is dropped, the result is stored and the status and audit parts still go through", async () => {
    const s = await seed();
    const ids = await apps(s);
    const out = await s.t.mutation(api.deviceApi.report, {
      ...creds(s.device),
      status: { agentVersion: "9.9.9" },
      installs: [
        result(ids.a, "installed"),
        result(ids.b, "failed", { detail: "C:\\Users\\x\\secret.txt", exitCode: 7 }),
        result(ids.c, "failed", { detail: "x".repeat(201) }),
        result(ids.a, "failed", { detail: "hash_mismatch" }),
      ],
      audit: { records: [record("5".repeat(32))], dropped: 0 },
    });
    expect(out).toEqual({ accepted: { installs: 4, audit: 1 } });
    const rows = await installRows(s);
    expect(rows.find((r) => r.appId === ids.b)).toMatchObject({ state: "failed", exitCode: 7 });
    expect(rows.find((r) => r.appId === ids.b)?.detail).toBeUndefined();
    expect(rows.find((r) => r.appId === ids.c)?.detail).toBeUndefined();
    expect(rows.find((r) => r.appId === ids.a)).toMatchObject({ state: "failed", detail: "hash_mismatch" });
    expectNoSecrets(rows, ["secret.txt"]);
    const summary = await s.t.run((ctx) => ctx.db.query("deviceSummary").withIndex("by_device", (q) => q.eq("deviceId", s.device.deviceId)).unique());
    expect(summary?.agentVersion).toBe("9.9.9");
    expect((await auditRows(s.t, s.orgId)).filter((r) => r.action === "device.adminExitWrongPin")).toHaveLength(1);
  });

  test("a state this server does not know (a newer agent) is ignored but accepted; the rest of the report goes through", async () => {
    const s = await seed();
    const ids = await apps(s);
    const out = await s.t.mutation(api.deviceApi.report, {
      ...creds(s.device),
      status: { agentVersion: "9.9.9" },
      installs: [result(ids.a, "verifying"), result(ids.b, "failed", { detail: "exit_code" }), result(ids.c, "")],
      audit: { records: [record("4".repeat(32))], dropped: 0 },
    });
    expect(out).toEqual({ accepted: { installs: 3, audit: 1 } });
    expect((await installRows(s)).map((r) => [r.appId, r.state])).toEqual([[ids.b, "failed"]]);
    const summary = await s.t.run((ctx) => ctx.db.query("deviceSummary").withIndex("by_device", (q) => q.eq("deviceId", s.device.deviceId)).unique());
    expect(summary?.agentVersion).toBe("9.9.9");
  });

  test("rows are tagged with the PC's group; a failure of an app the group does not assign (or an archived app) is stored but not counted", async () => {
    const s = await seed();
    const ids = await apps(s);
    const stats = async () => (await s.t.run((ctx) => ctx.db.query("orgStats").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).unique()))?.failedInstallCount ?? 0;
    const { loose, archived } = await s.t.run(async (ctx) => {
      const base = { orgId: s.orgId, kind: "web" as const, revision: 1, createdAt: 0 };
      const loose = await ctx.db.insert("apps", { ...base, name: "Loose", archived: false });
      const archived = await ctx.db.insert("apps", { ...base, name: "Old", archived: true });
      await ctx.db.insert("appAssignments", { orgId: s.orgId, groupId: s.groupId, appId: archived, audience: "everyone", pinnedTaskbar: false, pinnedDesktop: false });
      return { loose, archived };
    });
    await s.t.mutation(api.deviceApi.report, { ...creds(s.device), installs: [result(loose, "failed"), result(archived, "failed"), result(ids.a, "failed")] });
    const rows = await installRows(s);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.groupId === s.groupId)).toBe(true);
    expect(await stats()).toBe(1);
    // A failure turning into success of an uncounted app does not lower the count.
    await s.t.mutation(api.deviceApi.report, { ...creds(s.device), installs: [result(loose, "installed")] });
    expect(await stats()).toBe(1);
  });

  test("a bad count or more than 50 results is refused and nothing is written", async () => {
    const s = await seed();
    const ids = await apps(s);
    const bad = [
      [result(ids.a, "installed", { attempts: -1 })],
      [result(ids.a, "installed", { appRevision: 1.5 })],
      Array.from({ length: 51 }, () => result(ids.a, "installed")),
    ];
    for (const results of bad) {
      await expectCode(s.t.mutation(api.deviceApi.report, { ...creds(s.device), status: { agentVersion: "9.9.9" }, installs: results }), "invalid_argument");
    }
    expect(await installRows(s)).toEqual([]);
    const summary = await s.t.run((ctx) => ctx.db.query("deviceSummary").withIndex("by_device", (q) => q.eq("deviceId", s.device.deviceId)).unique());
    expect(summary?.agentVersion).not.toBe("9.9.9");
  });
});

describe("deviceApi:report batched (A12)", () => {
  test("status + 3 installs + 5 audit records: one credentials read, only changed rows written; the replay writes nothing", async () => {
    const s = await seed();
    const ids = await s.t.run(async (ctx) => {
      const out: Id<"apps">[] = [];
      for (const name of ["A", "B", "C"]) {
        out.push(
          await ctx.db.insert("apps", {
            orgId: s.orgId,
            name,
            kind: "web",
            web: { url: "https://a.example.test", allowedDomains: [], permissions: { camera: false, microphone: false, screenShare: false, clipboardRead: false, notifications: true, downloads: true, printing: false, geolocation: false } },
            archived: false,
            revision: 1,
            createdAt: Date.now(),
          }),
        );
      }
      return out;
    });
    const args = {
      ...creds(s.device),
      status: { agentVersion: "0.5.0", diskFreeGb: 40, kioskPhase: "applied", appliedVersion: 2 },
      installs: ids.map((appId) => ({ appId, state: "installed" as const, appRevision: 1, attempts: 1 })),
      audit: { records: ["1", "2", "3", "4", "5"].map((c) => record(c.repeat(32))), dropped: 0 },
    };
    const first = await probe(() => s.t.mutation(api.deviceApi.report, args));
    expect(first.result).toEqual({ accepted: { installs: 3, audit: 5 } });
    // summary + report (status changed since enrollment) + 3 installs + 5 audit rows.
    expect(first.io.writes).toBe(10);
    const replay = await probe(() => s.t.mutation(api.deviceApi.report, args));
    expect(replay.result).toEqual(first.result);
    expect(replay.io.writes).toBe(0);
    // 1 credentials + summary + report + 3 apps + 3 install rows + device (read for the install tag
    // and again for the audit part) + 5 event keys.
    expect(replay.io.reads).toBe(16);
    expect(replay.io.tables.has("deviceCredentials")).toBe(true);
  });

  test("write limit: one token per row written; replays and unchanged reports are free; over the limit -> rate_limited and everything rolled back", async () => {
    const s = await seed();
    at(Date.UTC(2026, 10, 1, 14, 0, 0));
    const left = async () => (await s.t.run((ctx) => rateLimiter.getValue(ctx, "deviceWrites", { key: s.device.deviceId }))).value;
    const take = (count: number) => s.t.run((ctx) => rateLimiter.limit(ctx, "deviceWrites", { key: s.device.deviceId, count }));
    const batch = (prefix: string, n: number) => ({ records: Array.from({ length: n }, (_, i) => record(`${prefix}${i}`.padEnd(32, "0"))), dropped: 0 });

    const first = { ...creds(s.device), status: { agentVersion: "0.5.0" }, audit: batch("a", 5) };
    await s.t.mutation(api.deviceApi.report, first);
    // summary + report + 5 audit rows (the status is new for the device: both status rows change).
    const afterFirst = await left();
    expect(afterFirst).toBe(600 - 7);
    // Replay: nothing written, nothing charged.
    await s.t.mutation(api.deviceApi.report, first);
    expect(await left()).toBe(afterFirst);
    // An idempotent rotation retry and a read-only call charge nothing either (see the rotation test).

    await take(Math.floor(await left()) - 3); // 3 tokens left
    // A replay is still free at 3 tokens.
    await s.t.mutation(api.deviceApi.report, first);
    // 5 new rows do not fit: refused, and the rows are not there.
    await expectCode(s.t.mutation(api.deviceApi.report, { ...creds(s.device), audit: batch("b", 5) }), "rate_limited");
    const known = async (prefix: string) =>
      (await auditRows(s.t, s.orgId)).filter((r) => r.eventKey?.startsWith(`dev:${s.device.deviceId}:${prefix}`) === true).length;
    expect(await known("b")).toBe(0);
    expect(await left()).toBeCloseTo(3, 0);
    // 2 rows fit.
    await s.t.mutation(api.deviceApi.report, { ...creds(s.device), audit: batch("c", 2) });
    expect(await known("c")).toBe(2);
  });

  test("revoked device: device_rejected, nothing written", async () => {
    const s = await seed();
    await s.t.mutation(api.devices.unenroll, creds(s.device));
    await expectCode(s.t.mutation(api.deviceApi.report, { ...creds(s.device), audit: { records: [record("7".repeat(32))], dropped: 0 } }), "device_rejected");
    expect((await auditRows(s.t, s.orgId)).filter((r) => r.eventKey !== undefined)).toEqual([]);
  });
});

// ---------------------------------------------------------------- rotation

describe("deviceApi:rotateCredential (Step 12 item 4, A2)", () => {
  async function credRow(s: Seed) {
    return await s.t.run((ctx) => ctx.db.query("deviceCredentials").withIndex("by_device", (q) => q.eq("deviceId", s.device.deviceId)).unique());
  }
  const NEW_SECRET = "new-device-secret-0123456789";

  test("happy path, retry with the old secret, old secret refused once the new one was used; audited once", async () => {
    const s = await seed();
    await s.t.run(async (ctx) => {
      const c = (await ctx.db.query("deviceCredentials").withIndex("by_device", (q) => q.eq("deviceId", s.device.deviceId)).unique())!;
      await ctx.db.patch(c._id, { rotate: true });
    });
    const oldHash = sha256HexSync(s.device.secret);
    const newHash = sha256HexSync(NEW_SECRET);
    expect(await s.t.mutation(api.deviceApi.rotateCredential, { ...creds(s.device), newSecretHash: newHash })).toEqual({ kind: "ok" });
    const after = await credRow(s);
    expect(after).toMatchObject({ secretHash: newHash, previousSecretHash: oldHash });
    expect(after?.rotate).toBeUndefined();
    // The answer was lost: the agent retries with the old secret.
    const retry = await probe(() => s.t.mutation(api.deviceApi.rotateCredential, { ...creds(s.device), newSecretHash: newHash }));
    expect(retry.result).toEqual({ kind: "ok" });
    expect(retry.io.writes).toBe(0);
    // A second, different rotation with the old secret is refused.
    await expectCode(
      s.t.mutation(api.deviceApi.rotateCredential, { ...creds(s.device), newSecretHash: sha256HexSync("third") }),
      "conflict",
    );
    // The first mutation with the new secret drops the old one.
    const fresh = { deviceId: s.device.deviceId, secret: NEW_SECRET };
    expect((await s.t.mutation(api.devices.ping, creds(fresh))).planState).toBe("ok");
    expect((await credRow(s))?.previousSecretHash).toBeUndefined();
    await expectCode(s.t.mutation(api.devices.ping, creds(s.device)), "device_rejected");
    await expectCode(s.t.mutation(api.deviceApi.rotateCredential, { ...creds(s.device), newSecretHash: newHash }), "device_rejected");
    const rotated = (await auditRows(s.t, s.orgId)).filter((r) => r.action === "device.credentialRotated");
    expect(rotated).toHaveLength(1);
    expectNoSecrets(rotated, [oldHash, newHash, s.device.secret, NEW_SECRET]);
  });

  test("the dashboard's rotate request is not required; a rotation costs 2 write tokens, its idempotent retry none; over the limit it is refused and not applied", async () => {
    at(Date.UTC(2026, 10, 1, 15, 0, 0));
    const s = await seed();
    const left = async () => (await s.t.run((ctx) => rateLimiter.getValue(ctx, "deviceWrites", { key: s.device.deviceId }))).value;
    const newHash = sha256HexSync(NEW_SECRET);
    expect((await credRow(s))?.rotate).toBeUndefined();
    await s.t.mutation(api.deviceApi.rotateCredential, { ...creds(s.device), newSecretHash: newHash });
    expect(await left()).toBe(598);
    await s.t.mutation(api.deviceApi.rotateCredential, { ...creds(s.device), newSecretHash: newHash });
    expect(await left()).toBe(598);

    const other = await enrollDevice(s.t, s.orgId, { groupId: s.groupId, name: "Desk 2" });
    await s.t.run((ctx) => rateLimiter.limit(ctx, "deviceWrites", { key: other.deviceId, count: 599 }));
    await expectCode(s.t.mutation(api.deviceApi.rotateCredential, { ...creds(other), newSecretHash: sha256HexSync("another") }), "rate_limited");
    const row = await s.t.run((ctx) => ctx.db.query("deviceCredentials").withIndex("by_device", (q) => q.eq("deviceId", other.deviceId)).unique());
    expect(row?.secretHash).toBe(sha256HexSync(other.secret));
    expect(row?.previousSecretHash).toBeUndefined();
  });

  test("wrong secret, revoked device, malformed hash", async () => {
    const s = await seed();
    const newHash = sha256HexSync(NEW_SECRET);
    await expectCode(
      s.t.mutation(api.deviceApi.rotateCredential, { deviceId: s.device.deviceId, deviceSecret: "wrong", newSecretHash: newHash }),
      "device_rejected",
    );
    await expectCode(s.t.mutation(api.deviceApi.rotateCredential, { ...creds(s.device), newSecretHash: "ABC" }), "invalid_argument");
    await expectCode(s.t.mutation(api.deviceApi.rotateCredential, { ...creds(s.device), newSecretHash: newHash.toUpperCase() }), "invalid_argument");
    await s.t.mutation(api.devices.unenroll, creds(s.device));
    await expectCode(s.t.mutation(api.deviceApi.rotateCredential, { ...creds(s.device), newSecretHash: newHash }), "device_rejected");
    expect((await credRow(s))?.secretHash).toBe(sha256HexSync(s.device.secret));
  });
});

describe("deviceApi source rules (PRD 11.1)", () => {
  test("no .collect(), no .filter() over a query, no console logging of arguments", () => {
    expect(source).not.toMatch(/\.collect\(/);
    expect(source).not.toMatch(/\.query\([^)]*\)\s*\.filter\(/);
    expect(source).not.toMatch(/console\./);
  });
});
