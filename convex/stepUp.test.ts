import { afterEach, describe, expect, test, vi } from "vitest";
import { setupAuth } from "../tests/convex/auth";
import { asMember, expectCode, expectNoSecrets, identityFor, makeOrg, type Member, type T } from "../tests/convex/identity";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { MINUTE_MS, HOUR_MS, PIN_HARD_LIMIT, PIN_LOCKOUT_MS, STEP_UP_ACTIVITY_QUANTUM_MS } from "./lib/limits";
import { recoveryHash } from "./lib/totp";
import { actionPinProblem, pinBackoffMs } from "./lib/stepUp";

// Step-up authentication (plan 4.16, Step 5a): action PIN, windows, lockout,
// resets, multi-organization. Passkeys: passkeys.test.ts.

const PIN = "246813";

afterEach(() => {
  vi.useRealTimers();
});

/** Move the server clock (Date only; convex-test keeps creation times increasing). */
function setNow(ms: number): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(ms);
}

async function owner(t: T, orgId?: Id<"organizations">): Promise<Member> {
  const m = await asMember(t, { role: "owner", mfa: true, orgId });
  // asMember sessions last an hour; some tests move the clock further.
  await t.run((ctx) => ctx.db.patch(m.sessionId, { expirationTime: Date.now() + 7 * 24 * HOUR_MS }));
  return m;
}

async function newSession(t: T, m: Member, mfa = true) {
  const sessionId = await t.run(async (ctx) => {
    const s = await ctx.db.insert("authSessions", { userId: m.userId, expirationTime: Date.now() + 7 * 24 * HOUR_MS });
    if (mfa) await ctx.db.insert("mfaSessions", { sessionId: s, userId: m.userId, verifiedAt: Date.now() });
    return s;
  });
  return { sessionId, as: identityFor(t, m.userId, sessionId) };
}

async function stepUpRow(t: T, sessionId: Id<"authSessions">) {
  return await t.run((ctx) => ctx.db.query("stepUpSessions").withIndex("by_session", (q) => q.eq("sessionId", sessionId)).first());
}

async function factors(t: T, userId: Id<"users">) {
  return await t.run((ctx) => ctx.db.query("stepUpFactors").withIndex("by_user", (q) => q.eq("userId", userId)).first());
}

/**
 * Guess wrong PINs as `m` from `start`, waiting out every backoff, until the
 * hard lockout. Returns the failures counted and the time of the locking one.
 */
async function guessUntilLockout(t: T, m: { as: Member["as"]; userId: Id<"users"> }, start: number) {
  let now = start;
  let failures = 0;
  for (;;) {
    setNow(now);
    try {
      await m.as.action(api.stepUp.verifyActionPin, { pin: "731942" });
      throw new Error("wrong PIN accepted");
    } catch (e) {
      const data = (e as { data?: { code: string; retryAfterMs?: number; detail?: string } }).data;
      if (data?.code === "step_up_locked" && data.detail === "lockout") {
        failures++;
        expect(data.retryAfterMs).toBe(PIN_LOCKOUT_MS);
        return { failures, lockedAt: now };
      } else if (data?.code === "step_up_locked") {
        now += (data.retryAfterMs ?? 0) + 1;
      } else {
        expect(data?.code).toBe("step_up_invalid");
        failures++;
        const f = await factors(t, m.userId);
        expect(f!.pinFailuresTotal).toBe(failures); // committed by the internal mutation
      }
    }
  }
}

async function auditActions(t: T, orgId: Id<"organizations">) {
  return await t.run(async (ctx) =>
    (await ctx.db.query("auditLog").withIndex("by_org_at", (q) => q.eq("orgId", orgId)).take(50)).map((r) => r.action),
  );
}

describe("action PIN rules", () => {
  test.each([
    ["12345", "6 to 12 digits"],
    ["1234567890123", "6 to 12 digits"],
    ["12a456", "6 to 12 digits"],
    ["000000", "repeated pattern"],
    ["111111", "repeated pattern"],
    ["121212", "repeated pattern"],
    ["123123", "repeated pattern"],
    ["123456", "sequence"],
    ["890123", "sequence"],
    ["987654", "sequence"],
    ["210987", "sequence"],
    ["112233", "too common"],
    ["159753", "too common"],
  ])("%s refused (%s)", (pin, reason) => {
    expect(actionPinProblem(pin)).toBe(reason);
  });

  test.each(["246813", "731942", "58201946", "906417352813"])("%s accepted", (pin) => {
    expect(actionPinProblem(pin)).toBeNull();
  });

  test("backoff: 2 free failures, then 30 s doubling to 15 minutes", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9].map(pinBackoffMs)).toEqual([0, 0, 30e3, 60e3, 120e3, 240e3, 480e3, 900e3, 900e3]);
  });
});

describe("bootstrap: the first factor", () => {
  test("a major action without any factor asks for setup; a fresh sign-in sets the PIN and unlocks", async () => {
    const t = await setupAuth();
    const o = await owner(t);
    const target = await asMember(t, { role: "viewer", orgId: o.orgId });
    await expectCode(o.as.mutation(api.members.changeRole, { memberId: target.memberId, role: "admin", expectedRevision: 0 }), "step_up_setup_required");
    await expectCode(o.as.action(api.stepUp.setActionPin, { pin: "123456" }), "invalid_argument");
    await o.as.action(api.stepUp.setActionPin, { pin: PIN });
    // Bootstrap unlocked and freshened the session: the major action works now.
    await o.as.mutation(api.members.changeRole, { memberId: target.memberId, role: "admin", expectedRevision: 0 });
    const f = await factors(t, o.userId);
    expect(f?.actionPinHash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    const status = await o.as.query(api.stepUp.status, {});
    expect(status.actionPin).toMatchObject({ set: true, disabled: false, lockedUntil: null });
    expect(status.session.method).toBe("actionPin");
    expect(status.bootstrapUntil).toBeNull();
    expectNoSecrets(status, [PIN, f!.actionPinHash!]);
    const audit = await t.run((ctx) => ctx.db.query("auditLog").withIndex("by_org_at", (q) => q.eq("orgId", o.orgId)).take(20));
    expect(audit.map((a) => a.action)).toContain("member.actionPinSet");
    expectNoSecrets(audit, [PIN]);
  });

  test("an Owner who never set one is never locked out: an old session must sign in again, a fresh one may set it", async () => {
    const t = await setupAuth();
    const o = await owner(t);
    setNow(Date.now() + 16 * MINUTE_MS);
    await expect(o.as.action(api.stepUp.setActionPin, { pin: PIN })).rejects.toMatchObject({
      data: { code: "step_up_setup_required", detail: "reauthenticate" },
    });
    // Signing in again (password + TOTP) gives a new session: bootstrap works.
    const again = await newSession(t, o);
    await again.as.action(api.stepUp.setActionPin, { pin: PIN });
    expect((await again.as.query(api.stepUp.status, {})).actionPin.set).toBe(true);
  });

  test("Phase 4b: the first PIN needs only the fresh password sign-in, also for a person with a (legacy) TOTP enrolment", async () => {
    const t = await setupAuth();
    const v = await asMember(t, { role: "viewer" });
    await t.run((ctx) =>
      ctx.db.insert("memberSecrets", { userId: v.userId, totpSecret: "JBSWY3DPEHPK3PXP", recoveryHashes: [], lastTotpStep: 0, totpFailures: 0, totpLockedUntil: 0 }),
    );
    // No mfaSessions row for this session: no longer needed.
    await v.as.action(api.stepUp.setActionPin, { pin: PIN });
    expect((await v.as.query(api.stepUp.status, {})).session.method).toBe("actionPin");
  });

  test("every role needs the PIN: a viewer, an admin and an owner without one are refused every write", async () => {
    const t = await setupAuth();
    const o = await asMember(t, { role: "owner" });
    const a = await asMember(t, { role: "admin", orgId: o.orgId });
    const v = await asMember(t, { role: "viewer", orgId: o.orgId });
    for (const m of [o, a, v]) {
      await expectCode(m.as.mutation(api.stepUp.keepAlive, {}), "step_up_setup_required");
      expect(await m.as.query(api.account.me, {})).toMatchObject({ pin: { required: true, set: false, locked: false } });
    }
    await expectCode(a.as.mutation(api.groups.create, { name: "Ops" }), "step_up_setup_required");
    await expectCode(o.as.mutation(api.members.setDisabled, { memberId: v.memberId, disabled: true, expectedRevision: 0 }), "step_up_setup_required");
    // Not even the passkey route: the PIN comes first.
    await expectCode(v.as.action(api.passkeys.beginRegistration, {}), "step_up_setup_required");
    await v.as.action(api.stepUp.setActionPin, { pin: PIN });
    await v.as.mutation(api.stepUp.keepAlive, {});
  });

  test("the PIN can never be removed (major action, always refused)", async () => {
    const t = await setupAuth();
    const o = await owner(t);
    await o.as.action(api.stepUp.setActionPin, { pin: PIN });
    await expect(o.as.mutation(api.stepUp.clearActionPin, {})).rejects.toMatchObject({ data: { code: "step_up_last_factor" } });
    expect((await factors(t, o.userId))?.actionPinHash).toBeDefined();
  });
});

describe("windows: unlocked (idle 10 min) and fresh (5 min)", () => {
  test("fresh for 5 minutes, unlocked while active, locked after idling, re-verified with the PIN", async () => {
    const t = await setupAuth();
    const o = await owner(t);
    const target = await asMember(t, { role: "viewer", orgId: o.orgId });
    const t0 = Date.now();
    await o.as.action(api.stepUp.setActionPin, { pin: PIN });

    setNow(t0 + 6 * MINUTE_MS);
    // Not fresh: a major action is refused, a normal write passes.
    await expectCode(o.as.mutation(api.members.setDisabled, { memberId: target.memberId, disabled: true, expectedRevision: 0 }), "step_up_required");
    await o.as.mutation(api.stepUp.keepAlive, {});
    const afterKeep = await stepUpRow(t, o.sessionId);
    expect(afterKeep!.lastActiveAt).toBe(t0 + 6 * MINUTE_MS);

    // keepAlive within the activity quantum writes nothing.
    setNow(t0 + 6 * MINUTE_MS + STEP_UP_ACTIVITY_QUANTUM_MS - 1000);
    await o.as.mutation(api.stepUp.keepAlive, {});
    expect((await stepUpRow(t, o.sessionId))!.lastActiveAt).toBe(t0 + 6 * MINUTE_MS);

    // Active every 5 minutes: still unlocked at 40 minutes.
    for (let m = 11; m <= 40; m += 5) {
      setNow(t0 + m * MINUTE_MS);
      await o.as.mutation(api.stepUp.keepAlive, {});
    }
    // Idle 16 minutes: locked.
    setNow(t0 + 56 * MINUTE_MS);
    await expect(o.as.mutation(api.stepUp.keepAlive, {})).rejects.toMatchObject({ data: { code: "step_up_required", detail: "unlocked" } });
    // The PIN unlocks and freshens again.
    const r = await o.as.action(api.stepUp.verifyActionPin, { pin: PIN });
    expect(r.freshUntil - r.verifiedAt).toBe(5 * MINUTE_MS);
    await o.as.mutation(api.members.setDisabled, { memberId: target.memberId, disabled: true, expectedRevision: 0 });
  });

  test("an unlock never lasts longer than 8 hours, even while active", async () => {
    const t = await setupAuth();
    const o = await owner(t);
    const t0 = Date.now();
    await o.as.action(api.stepUp.setActionPin, { pin: PIN });
    for (let m = 5; m <= 8 * 60 + 5; m += 5) {
      setNow(t0 + m * MINUTE_MS);
      if (m <= 8 * 60) await o.as.mutation(api.stepUp.keepAlive, {});
    }
    await expectCode(o.as.mutation(api.stepUp.keepAlive, {}), "step_up_required");
  });

  test("lock ends the unlock at once; another session of the same person is locked independently", async () => {
    const t = await setupAuth();
    const o = await owner(t);
    await o.as.action(api.stepUp.setActionPin, { pin: PIN });
    const other = await newSession(t, o);
    await expectCode(other.as.mutation(api.stepUp.keepAlive, {}), "step_up_required");
    await o.as.mutation(api.stepUp.lock, {});
    await expectCode(o.as.mutation(api.stepUp.keepAlive, {}), "step_up_required");
  });

  test("step-up belongs to the person: one verification covers every organization of the session", async () => {
    const t = await setupAuth();
    const a = await owner(t);
    const orgB = await makeOrg(t, "Beta");
    await t.run((ctx) =>
      ctx.db.insert("members", { orgId: orgB, userId: a.userId, email: a.email, role: "owner", status: "active", createdAt: Date.now(), revision: 0 }),
    );
    await a.as.action(api.stepUp.setActionPin, { pin: PIN, orgId: a.orgId });
    await a.as.mutation(api.stepUp.keepAlive, { orgId: orgB });
    // The audit row is in the organization the person acted in.
    expect(await auditActions(t, a.orgId)).toContain("member.actionPinSet");
    expect(await auditActions(t, orgB)).not.toContain("member.actionPinSet");
  });

  test("a deleted or expired session is out before step-up is looked at; disabling a member removes their step-up rows", async () => {
    const t = await setupAuth();
    const o = await owner(t);
    await o.as.action(api.stepUp.setActionPin, { pin: PIN });
    const admin = await asMember(t, { role: "admin", mfa: true, orgId: o.orgId });
    await t.run((ctx) =>
      ctx.db.insert("stepUpSessions", { sessionId: admin.sessionId, userId: admin.userId, verifiedAt: Date.now(), lastActiveAt: Date.now(), method: "actionPin" }),
    );
    await o.as.mutation(api.members.setDisabled, { memberId: admin.memberId, disabled: true, expectedRevision: 0 });
    expect(await stepUpRow(t, admin.sessionId)).toBeNull();
    await expectCode(admin.as.mutation(api.stepUp.keepAlive, {}), "unauthenticated");
    await t.run((ctx) => ctx.db.patch(o.sessionId, { expirationTime: Date.now() - 1 }));
    await expectCode(o.as.mutation(api.stepUp.keepAlive, {}), "unauthenticated");
  });
});

describe("action PIN: change, brute force, resets", () => {
  test("changing the PIN needs a fresh step-up; the new PIN works and the old one does not", async () => {
    const t = await setupAuth();
    const o = await owner(t);
    const t0 = Date.now();
    await o.as.action(api.stepUp.setActionPin, { pin: PIN });
    setNow(t0 + 6 * MINUTE_MS);
    await expectCode(o.as.action(api.stepUp.setActionPin, { pin: "731942" }), "step_up_required");
    await o.as.action(api.stepUp.verifyActionPin, { pin: PIN });
    await o.as.action(api.stepUp.setActionPin, { pin: "731942" });
    await expectCode(o.as.action(api.stepUp.verifyActionPin, { pin: PIN }), "step_up_invalid");
    await o.as.action(api.stepUp.verifyActionPin, { pin: "731942" });
    expect(await auditActions(t, o.orgId)).toContain("member.actionPinChanged");
  });

  test("failures persist although the action throws; backoff; the 10th failure LOCKS the PIN for 24 h (not disabled), audited, emailed", async () => {
    const t = await setupAuth();
    const o = await owner(t);
    let now = Date.now();
    await o.as.action(api.stepUp.setActionPin, { pin: PIN });
    const { failures, lockedAt } = await guessUntilLockout(t, o, now);
    now = lockedAt;
    expect(failures).toBe(PIN_HARD_LIMIT);
    const f = await factors(t, o.userId);
    expect(f!.pinDisabledAt).toBeUndefined();
    expect(f!.pinLockedUntil).toBe(lockedAt + PIN_LOCKOUT_MS);
    // Locked: even the right PIN is refused, with the time left.
    setNow(now + HOUR_MS);
    await expect(o.as.action(api.stepUp.verifyActionPin, { pin: PIN })).rejects.toMatchObject({
      data: { code: "step_up_locked", detail: "lockout", retryAfterMs: PIN_LOCKOUT_MS - HOUR_MS },
    });
    expect(await auditActions(t, o.orgId)).toContain("member.actionPinLocked");
    // The "your PIN is locked" notice was scheduled (best effort; mail is off in tests, so nothing is sent).
    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").take(20));
    expect(scheduled.some((s) => s.name.includes("mail") && (s.args[0] as { to?: string }).to === o.email)).toBe(true);
    const status = await o.as.query(api.stepUp.status, {});
    expect(status).toMatchObject({ pinLockout: true, actionPin: { set: true, disabled: false, lockedUntil: lockedAt + PIN_LOCKOUT_MS } });
    expect(await o.as.query(api.account.me, {})).toMatchObject({ pin: { set: true, locked: true, lockedUntil: lockedAt + PIN_LOCKOUT_MS } });
    // A locked PIN still counts: a fresh sign-in cannot just set a new one.
    const again = await newSession(t, o);
    await expectCode(again.as.action(api.stepUp.setActionPin, { pin: "731942" }), "step_up_required");
    // After 24 h the right PIN works again and clears everything.
    setNow(lockedAt + PIN_LOCKOUT_MS + 1);
    await o.as.action(api.stepUp.verifyActionPin, { pin: PIN });
    expect(await factors(t, o.userId)).toMatchObject({ pinFailures: 0, pinFailuresTotal: 0, pinLockedUntil: 0 });
  });

  test("an attacker with only the password cannot permanently disable the PIN: each lockout ends, the count starts over", async () => {
    const t = await setupAuth();
    const o = await owner(t);
    await o.as.action(api.stepUp.setActionPin, { pin: PIN });
    // The attacker signs in with the stolen password (a fresh session) and guesses.
    const thief = await newSession(t, o, false);
    let now = Date.now();
    for (let round = 0; round < 2; round++) {
      const r = await guessUntilLockout(t, { ...o, ...thief }, now);
      expect(r.failures).toBe(PIN_HARD_LIMIT);
      const f = await factors(t, o.userId);
      expect(f!.pinDisabledAt).toBeUndefined();
      now = r.lockedAt + PIN_LOCKOUT_MS + 1;
      setNow(now);
    }
    // The owner's PIN is intact and works once the lockout ended.
    await o.as.action(api.stepUp.verifyActionPin, { pin: PIN });
    expect((await factors(t, o.userId))?.pinFailuresTotal).toBe(0);
  });

  test("a legacy disabled PIN (before Phase 4b) is only locked until 24 h after it was disabled", async () => {
    const t = await setupAuth();
    const o = await owner(t);
    await o.as.action(api.stepUp.setActionPin, { pin: PIN });
    const disabledAt = Date.now();
    await t.run(async (ctx) => {
      const f = (await ctx.db.query("stepUpFactors").withIndex("by_user", (q) => q.eq("userId", o.userId)).first())!;
      await ctx.db.patch(f._id, { pinFailuresTotal: PIN_HARD_LIMIT, pinFailures: 0, pinLockedUntil: 0, pinDisabledAt: disabledAt });
    });
    await expect(o.as.action(api.stepUp.verifyActionPin, { pin: PIN })).rejects.toMatchObject({ data: { code: "step_up_locked", detail: "lockout" } });
    setNow(disabledAt + PIN_LOCKOUT_MS + 1);
    await o.as.action(api.stepUp.verifyActionPin, { pin: PIN });
    expect((await factors(t, o.userId))?.pinDisabledAt).toBeUndefined();
  });

  test("a locked PIN: an Owner reset still works (passkey: passkeys.test.ts; email: pinReset.test.ts)", async () => {
    const t = await setupAuth();
    const o = await owner(t);
    await o.as.action(api.stepUp.setActionPin, { pin: PIN });
    const admin = await asMember(t, { role: "admin", orgId: o.orgId });
    await t.run((ctx) => ctx.db.patch(admin.sessionId, { expirationTime: Date.now() + 7 * 24 * HOUR_MS }));
    await admin.as.action(api.stepUp.setActionPin, { pin: "582019" });
    const r = await guessUntilLockout(t, admin, Date.now());
    setNow(r.lockedAt + MINUTE_MS);
    // Owner reset of the locked member (the owner re-verifies first: time moved on).
    await o.as.action(api.stepUp.verifyActionPin, { pin: PIN });
    await o.as.mutation(api.stepUp.resetMember, { memberId: admin.memberId });
    expect(await factors(t, admin.userId)).toBeNull();
    const fresh = await newSession(t, admin, false);
    await fresh.as.action(api.stepUp.setActionPin, { pin: "906417" });
  });

  test("a correct PIN resets the counters", async () => {
    const t = await setupAuth();
    const o = await owner(t);
    await o.as.action(api.stepUp.setActionPin, { pin: PIN });
    await expectCode(o.as.action(api.stepUp.verifyActionPin, { pin: "731942" }), "step_up_invalid");
    await expectCode(o.as.action(api.stepUp.verifyActionPin, { pin: "731942" }), "step_up_invalid");
    await o.as.action(api.stepUp.verifyActionPin, { pin: PIN });
    expect(await factors(t, o.userId)).toMatchObject({ pinFailures: 0, pinFailuresTotal: 0, pinLockedUntil: 0 });
  });

  test("lost PIN: a recovery code after a fresh password + TOTP sign-in clears the factors; an old session cannot", async () => {
    const t = await setupAuth();
    const o = await owner(t);
    await o.as.action(api.stepUp.setActionPin, { pin: PIN });
    const code = "ABCD-EFGH";
    await t.run((ctx) =>
      ctx.db.insert("memberSecrets", {
        userId: o.userId,
        totpSecret: "JBSWY3DPEHPK3PXP",
        recoveryHashes: [recoveryHash(code), recoveryHash("WXYZ-2345")],
        lastTotpStep: 0,
        totpFailures: 0,
        totpLockedUntil: 0,
      }),
    );
    setNow(Date.now() + 20 * MINUTE_MS);
    await expectCode(o.as.action(api.stepUp.resetWithRecoveryCode, { code }), "step_up_setup_required");
    const fresh = await newSession(t, o);
    await expectCode(fresh.as.action(api.stepUp.resetWithRecoveryCode, { code: "QQQQ-QQQQ" }), "mfa_invalid_code");
    const s = await t.run((ctx) => ctx.db.query("memberSecrets").withIndex("by_user", (q) => q.eq("userId", o.userId)).first());
    expect(s!.totpFailures).toBe(1);
    await fresh.as.action(api.stepUp.resetWithRecoveryCode, { code });
    expect(await factors(t, o.userId)).toBeNull();
    expect(await stepUpRow(t, o.sessionId)).toBeNull();
    await fresh.as.action(api.stepUp.setActionPin, { pin: "731942" });
    expect(await auditActions(t, o.orgId)).toContain("member.stepUpReset");
    // The code is used up.
    const fresh2 = await newSession(t, o);
    await expectCode(fresh2.as.action(api.stepUp.resetWithRecoveryCode, { code }), "mfa_invalid_code");
  });

  test("recovery codes of the PIN (no TOTP): generated once after the PIN, hashed, one use each, kept across the reset", async () => {
    const t = await setupAuth();
    const v = await asMember(t, { role: "viewer" });
    await t.run((ctx) => ctx.db.patch(v.sessionId, { expirationTime: Date.now() + 7 * 24 * HOUR_MS }));
    // Needs the PIN (and a fresh step-up) first.
    await expectCode(v.as.action(api.stepUp.generateRecoveryCodes, {}), "step_up_setup_required");
    await v.as.action(api.stepUp.setActionPin, { pin: PIN });
    const codes = await v.as.action(api.stepUp.generateRecoveryCodes, {});
    expect(codes).toHaveLength(10);
    for (const c of codes) expect(c).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(new Set(codes).size).toBe(10);
    const f = await factors(t, v.userId);
    expect(f!.recoveryHashes).toEqual(codes.map(recoveryHash));
    expect(JSON.stringify(f)).not.toContain(codes[0]!);
    const status = await v.as.query(api.stepUp.status, {});
    expect(status.recoveryCodesLeft).toBe(10);
    expectNoSecrets(status, codes);
    expectNoSecrets(await v.as.query(api.account.me, {}), codes);
    const audit = await t.run((ctx) => ctx.db.query("auditLog").withIndex("by_org_at", (q) => q.eq("orgId", v.orgId)).take(20));
    expect(audit.map((a) => a.action)).toContain("member.recoveryCodesGenerated");
    expectNoSecrets(audit, codes);
    // No memberSecrets / TOTP row was involved.
    expect(await t.run((ctx) => ctx.db.query("memberSecrets").withIndex("by_user", (q) => q.eq("userId", v.userId)).first())).toBeNull();

    // Stale: generating again needs a fresh step-up.
    setNow(Date.now() + 6 * MINUTE_MS);
    await expectCode(v.as.action(api.stepUp.generateRecoveryCodes, {}), "step_up_required");

    // Lost PIN: a fresh sign-in + one code resets the PIN; a wrong code is step_up_invalid.
    const fresh = await newSession(t, v, false);
    await expectCode(fresh.as.action(api.stepUp.resetWithRecoveryCode, { code: "QQQQ-QQQQ" }), "step_up_invalid");
    await fresh.as.action(api.stepUp.resetWithRecoveryCode, { code: codes[3]!.toLowerCase() });
    const after = await factors(t, v.userId);
    expect(after!.actionPinHash).toBeUndefined();
    expect(after!.recoveryHashes).toHaveLength(9); // the other codes stay
    expect(await stepUpRow(t, v.sessionId)).toBeNull();
    await fresh.as.action(api.stepUp.setActionPin, { pin: "731942" });
    expect((await fresh.as.query(api.stepUp.status, {})).recoveryCodesLeft).toBe(9);
    // Used up; another code still works (fresh sign-in again).
    const fresh2 = await newSession(t, v, false);
    await expectCode(fresh2.as.action(api.stepUp.resetWithRecoveryCode, { code: codes[3]! }), "step_up_invalid");
    await fresh2.as.action(api.stepUp.resetWithRecoveryCode, { code: codes[4]! });
    // An old session cannot use a code.
    setNow(Date.now() + 20 * MINUTE_MS);
    await expectCode(fresh2.as.action(api.stepUp.resetWithRecoveryCode, { code: codes[5]! }), "step_up_setup_required");
  });

  test("recovery codes: wrong guesses are rate limited per person (5 per 15 minutes)", async () => {
    const t = await setupAuth();
    const v = await asMember(t, { role: "viewer" });
    await v.as.action(api.stepUp.setActionPin, { pin: PIN });
    const codes = await v.as.action(api.stepUp.generateRecoveryCodes, {});
    for (let i = 0; i < 5; i++) await expectCode(v.as.action(api.stepUp.resetWithRecoveryCode, { code: "QQQQ-QQQQ" }), "step_up_invalid");
    // Even the right code waits now.
    await expectCode(v.as.action(api.stepUp.resetWithRecoveryCode, { code: codes[0]! }), "rate_limited");
    expect((await factors(t, v.userId))!.recoveryHashes).toHaveLength(10);
  });

  test("another Owner resets a member's factors; not their own, not a member of another organization", async () => {
    const t = await setupAuth();
    const o = await owner(t);
    await o.as.action(api.stepUp.setActionPin, { pin: PIN });
    const admin = await asMember(t, { role: "admin", mfa: true, orgId: o.orgId });
    await admin.as.action(api.stepUp.setActionPin, { pin: "731942" });
    await o.as.mutation(api.stepUp.resetMember, { memberId: admin.memberId });
    expect(await factors(t, admin.userId)).toBeNull();
    expect(await stepUpRow(t, admin.sessionId)).toBeNull();
    await expectCode(o.as.mutation(api.stepUp.resetMember, { memberId: o.memberId }), "forbidden");
    // A person who is also active in another organization.
    const other = await asMember(t, { role: "admin", mfa: true, orgId: o.orgId });
    const orgB = await makeOrg(t, "Beta");
    await t.run((ctx) =>
      ctx.db.insert("members", { orgId: orgB, userId: other.userId, email: other.email, role: "owner", status: "active", createdAt: Date.now(), revision: 0 }),
    );
    await expect(o.as.mutation(api.stepUp.resetMember, { memberId: other.memberId })).rejects.toMatchObject({
      data: { code: "forbidden", detail: "member of another organization" },
    });
  });

  test("the last factor cannot be removed; verifying without a PIN set spends the same work and says not_ready", async () => {
    const t = await setupAuth();
    const o = await owner(t);
    await expectCode(o.as.action(api.stepUp.verifyActionPin, { pin: PIN }), "not_ready");
    await o.as.action(api.stepUp.setActionPin, { pin: PIN });
    await expectCode(o.as.mutation(api.stepUp.clearActionPin, {}), "step_up_last_factor");
  });
});
