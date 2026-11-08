import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { setupAuth } from "../tests/convex/auth";
import { asMember, expectCode, expectNoSecrets, identityFor, makeOrg, type Member, type T } from "../tests/convex/identity";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { MINUTE_MS, HOUR_MS, PIN_HARD_LIMIT, PIN_LOCKOUT_MS, PIN_LOCKOUT_STEPS_MS, PIN_WARN_AT, STEP_UP_ACTIVITY_QUANTUM_MS } from "./lib/limits";
import { recoveryHash } from "./lib/recoveryCodes";
import { actionPinProblem, pinBackoffMs } from "./lib/stepUp";

declare const process: { env: Record<string, string | undefined> };

// Step-up authentication (plan 4.16, Step 5a): action PIN, windows, lockout,
// resets, multi-organization. Passkeys: passkeys.test.ts.

const PIN = "246813";
const PEPPER = "test-recovery-pepper-0123456789abcdef-xyz";

beforeEach(() => {
  process.env.RULEBOX_RECOVERY_PEPPER = PEPPER;
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.RULEBOX_RECOVERY_PEPPER;
});

/** Move the server clock (Date only; convex-test keeps creation times increasing). */
function setNow(ms: number): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(ms);
}

async function owner(t: T, orgId?: Id<"organizations">): Promise<Member> {
  const m = await asMember(t, { role: "owner", orgId });
  // asMember sessions last an hour; some tests move the clock further.
  await t.run((ctx) => ctx.db.patch(m.sessionId, { expirationTime: Date.now() + 7 * 24 * HOUR_MS }));
  return m;
}

async function newSession(t: T, m: Member) {
  const sessionId = await t.run((ctx) =>
    ctx.db.insert("authSessions", { userId: m.userId, expirationTime: Date.now() + 7 * 24 * HOUR_MS }),
  );
  return { sessionId, as: identityFor(t, m.userId, sessionId) };
}

async function stepUpRow(t: T, sessionId: Id<"authSessions">) {
  return await t.run((ctx) => ctx.db.query("stepUpSessions").withIndex("by_session", (q) => q.eq("sessionId", sessionId)).first());
}

async function factors(t: T, userId: Id<"users">) {
  return await t.run((ctx) => ctx.db.query("stepUpFactors").withIndex("by_user", (q) => q.eq("userId", userId)).first());
}

/** The attempt counters (`pinCounters`, split from `stepUpFactors` by the security review). */
async function counters(t: T, userId: Id<"users">) {
  return await t.run((ctx) => ctx.db.query("pinCounters").withIndex("by_user", (q) => q.eq("userId", userId)).first());
}

/**
 * Guess wrong PINs as `m` from `start`, waiting out every backoff, until the
 * hard lockout. Returns the failures counted and the time of the locking one.
 */
async function guessUntilLockout(t: T, m: { as: Member["as"]; userId: Id<"users"> }, start: number, lockoutMs: number = PIN_LOCKOUT_MS) {
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
        expect(data.retryAfterMs).toBe(lockoutMs);
        return { failures, lockedAt: now };
      } else if (data?.code === "step_up_locked") {
        now += (data.retryAfterMs ?? 0) + 1;
      } else {
        expect(data?.code).toBe("step_up_invalid");
        failures++;
        const c = await counters(t, m.userId);
        expect(c!.streak).toBe(failures); // committed by the internal mutation, although the action threw
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
    // Signing in again with the password gives a new session: bootstrap works.
    const again = await newSession(t, o);
    await again.as.action(api.stepUp.setActionPin, { pin: PIN });
    expect((await again.as.query(api.stepUp.status, {})).actionPin.set).toBe(true);
  });

  test("the first PIN needs only the fresh password sign-in", async () => {
    const t = await setupAuth();
    const v = await asMember(t, { role: "viewer" });
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
      expect(await m.as.query(api.account.me, {})).toMatchObject({ pin: { required: true, set: false } });
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
    const admin = await asMember(t, { role: "admin", orgId: o.orgId });
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
    expect(await counters(t, o.userId)).toMatchObject({ lockedUntil: lockedAt + PIN_LOCKOUT_MS, lockout: true });
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
    expect(status).toMatchObject({
      actionPin: { set: true, disabled: false, lockedUntil: lockedAt + PIN_LOCKOUT_MS },
      pin: { set: true, lockKind: "lockout", lockedUntil: lockedAt + PIN_LOCKOUT_MS, failedSinceUnlock: PIN_HARD_LIMIT },
    });
    // `account:me` stays small and stable: a wrong PIN never re-runs it (finding 7).
    expect(await o.as.query(api.account.me, {})).toMatchObject({ pin: { required: true, set: true } });
    // A locked PIN still counts: a fresh sign-in cannot just set a new one.
    const again = await newSession(t, o);
    await expectCode(again.as.action(api.stepUp.setActionPin, { pin: "731942" }), "step_up_required");
    // After 24 h the right PIN works again and clears everything.
    setNow(lockedAt + PIN_LOCKOUT_MS + 1);
    await o.as.action(api.stepUp.verifyActionPin, { pin: PIN });
    expect(await counters(t, o.userId)).toMatchObject({ failures: 0, streak: 0, sinceUnlock: 0, lockedUntil: 0, lockout: false });
  });

  test("wrong guesses are never silent (finding 4): the person can see the count, the audit log and an email at 5", async () => {
    const t = await setupAuth();
    const o = await owner(t);
    await o.as.action(api.stepUp.setActionPin, { pin: PIN });
    const mailsTo = async () =>
      (await t.run((ctx) => ctx.db.system.query("_scheduled_functions").take(50))).filter((s) => s.name.includes("mail")).length;
    let now = Date.now();
    for (let i = 1; i <= PIN_WARN_AT; i++) {
      setNow(now);
      try {
        await o.as.action(api.stepUp.verifyActionPin, { pin: "731942" });
      } catch (e) {
        const data = (e as { data: { retryAfterMs?: number } }).data;
        now += (data.retryAfterMs ?? 0) + 1;
      }
      // The status the lock screen reads counts every wrong attempt since the last unlock.
      expect((await o.as.query(api.stepUp.status, {})).pin.failedSinceUnlock).toBe(i);
      if (i < PIN_WARN_AT) expect(await auditActions(t, o.orgId)).not.toContain("member.actionPinWrongAttempts");
    }
    expect(await auditActions(t, o.orgId)).toContain("member.actionPinWrongAttempts");
    expect(await mailsTo()).toBe(2); // the "PIN was set" notice, then the wrong-attempts one
    // Unlocking resets what is shown.
    setNow(now + HOUR_MS);
    await o.as.action(api.stepUp.verifyActionPin, { pin: PIN });
    expect((await o.as.query(api.stepUp.status, {})).pin.failedSinceUnlock).toBe(0);
  });

  test("a thief guessing a few times a day while the owner unlocks daily is still locked out (30-day window, a success does not reset it)", async () => {
    const t = await setupAuth();
    const o = await owner(t);
    await o.as.action(api.stepUp.setActionPin, { pin: PIN });
    let now = Date.now();
    let lockedOut = false;
    for (let day = 0; day < 6 && !lockedOut; day++) {
      for (let i = 0; i < 2 && !lockedOut; i++) {
        setNow(now);
        try {
          await o.as.action(api.stepUp.verifyActionPin, { pin: "731942" });
        } catch (e) {
          const data = (e as { data: { code: string; detail?: string; retryAfterMs?: number } }).data;
          if (data.detail === "lockout") lockedOut = true;
          else now += (data.retryAfterMs ?? 0) + 1;
        }
      }
      now += 5 * MINUTE_MS;
      setNow(now);
      if (!lockedOut) await o.as.action(api.stepUp.verifyActionPin, { pin: PIN }); // the owner unlocks: streak resets
      now += 24 * HOUR_MS;
    }
    expect(lockedOut).toBe(true);
  });

  test("an attacker with only the password cannot permanently disable the PIN: each lockout ends, the count starts over", async () => {
    const t = await setupAuth();
    const o = await owner(t);
    await o.as.action(api.stepUp.setActionPin, { pin: PIN });
    // The attacker signs in with the stolen password (a fresh session) and guesses.
    const thief = await newSession(t, o);
    let now = Date.now();
    for (let round = 0; round < 2; round++) {
      // Repeated lockouts last longer each time (24 h, then 72 h, then 7 days).
      const ms = PIN_LOCKOUT_STEPS_MS[round]!;
      const r = await guessUntilLockout(t, { ...o, ...thief }, now, ms);
      expect(r.failures).toBe(PIN_HARD_LIMIT);
      const f = await factors(t, o.userId);
      expect(f!.pinDisabledAt).toBeUndefined();
      now = r.lockedAt + ms + 1;
      setNow(now);
    }
    // The owner's PIN is intact and works once the lockout ended.
    await o.as.action(api.stepUp.verifyActionPin, { pin: PIN });
    expect((await counters(t, o.userId))?.streak).toBe(0);
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
    expect(await counters(t, o.userId)).toMatchObject({ lockedUntil: 0, lockout: false, streak: 0, sinceUnlock: 0 });
    await o.as.action(api.stepUp.verifyActionPin, { pin: PIN });
  });

  test("a locked PIN: an Owner reset still works (passkey: passkeys.test.ts; email: pinReset.test.ts)", async () => {
    const t = await setupAuth();
    const o = await owner(t);
    await o.as.action(api.stepUp.setActionPin, { pin: PIN });
    const admin = await asMember(t, { role: "admin", orgId: o.orgId });
    await t.run((ctx) => ctx.db.patch(admin.sessionId, { expirationTime: Date.now() + 7 * 24 * HOUR_MS }));
    await admin.as.action(api.stepUp.setActionPin, { pin: "582019" });
    // A password thief with a fresh session of the admin, open while the Owner resets (the race of finding 6).
    const thief = await newSession(t, admin);
    const r = await guessUntilLockout(t, admin, Date.now());
    setNow(r.lockedAt + MINUTE_MS);
    // Owner reset of the locked member (the owner re-verifies first: time moved on).
    await o.as.action(api.stepUp.verifyActionPin, { pin: PIN });
    await o.as.mutation(api.stepUp.resetMember, { memberId: admin.memberId });
    expect(await factors(t, admin.userId)).toBeNull();
    expect(await counters(t, admin.userId)).toBeNull();
    // Every session of the member ended with the reset: the racing session cannot fill the empty PIN.
    await expectCode(thief.as.action(api.stepUp.setActionPin, { pin: "731942" }), "unauthenticated");
    await expectCode(admin.as.action(api.stepUp.setActionPin, { pin: "731942" }), "unauthenticated");
    // Only a session created by a NEW password sign-in after the reset can set the first PIN.
    const fresh = await newSession(t, admin);
    await fresh.as.action(api.stepUp.setActionPin, { pin: "906417" });
  });

  test("a correct PIN resets the counters", async () => {
    const t = await setupAuth();
    const o = await owner(t);
    await o.as.action(api.stepUp.setActionPin, { pin: PIN });
    await expectCode(o.as.action(api.stepUp.verifyActionPin, { pin: "731942" }), "step_up_invalid");
    await expectCode(o.as.action(api.stepUp.verifyActionPin, { pin: "731942" }), "step_up_invalid");
    await o.as.action(api.stepUp.verifyActionPin, { pin: PIN });
    expect(await counters(t, o.userId)).toMatchObject({ failures: 0, streak: 0, sinceUnlock: 0, lockedUntil: 0 });
  });

  test("a recovery reset before any recovery codes were generated answers not_ready and changes nothing", async () => {
    const t = await setupAuth();
    const v = await asMember(t, { role: "viewer" });
    await v.as.action(api.stepUp.setActionPin, { pin: PIN });
    const thief = await newSession(t, v);
    await expectCode(thief.as.action(api.stepUp.resetWithRecoveryCode, { code: "AAAA-AAAA", newPin: "731942" }), "not_ready");
    expect((await factors(t, v.userId))?.actionPinHash).toBeDefined();
    await v.as.action(api.stepUp.verifyActionPin, { pin: PIN });
    expect(await auditActions(t, v.orgId)).not.toContain("member.stepUpReset");
  });

  test("recovery codes of the PIN: generated once after the PIN, hashed, one use each, the reset sets the new PIN in one transaction", async () => {
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
    expect(status.pin.recoveryCodesLeft).toBe(10);
    expectNoSecrets(status, codes);
    expectNoSecrets(await v.as.query(api.account.me, {}), codes);
    const audit = await t.run((ctx) => ctx.db.query("auditLog").withIndex("by_org_at", (q) => q.eq("orgId", v.orgId)).take(20));
    expect(audit.map((a) => a.action)).toContain("member.recoveryCodesGenerated");
    expectNoSecrets(audit, codes);

    // Stale: generating again needs a fresh step-up.
    setNow(Date.now() + 6 * MINUTE_MS);
    await expectCode(v.as.action(api.stepUp.generateRecoveryCodes, {}), "step_up_required");

    // Lost PIN: a fresh sign-in + one code + the NEW PIN. A wrong code is step_up_invalid; a call without newPin is refused.
    const fresh = await newSession(t, v);
    await expectCode(fresh.as.action(api.stepUp.resetWithRecoveryCode, { code: "QQQQ-QQQQ", newPin: "731942" }), "step_up_invalid");
    // `newPin` is a required argument: a call without it never reaches the handler (the argument validator refuses it).
    await expect(fresh.as.action(api.stepUp.resetWithRecoveryCode, { code: codes[3]! } as never)).rejects.toThrow();
    await expectCode(fresh.as.action(api.stepUp.resetWithRecoveryCode, { code: codes[3]!, newPin: "123456" }), "invalid_argument");
    await fresh.as.action(api.stepUp.resetWithRecoveryCode, { code: codes[3]!.toLowerCase(), newPin: "731942" });
    // Atomic (finding 6): the PIN is never empty. It is the new one at once, this session is unlocked, the old session ended.
    const after = await factors(t, v.userId);
    expect(after!.actionPinHash).toBeDefined();
    expect(after!.recoveryHashes).toHaveLength(9); // the other codes stay
    expect(await stepUpRow(t, v.sessionId)).toBeNull();
    expect(await t.run((ctx) => ctx.db.get(v.sessionId))).toBeNull();
    expect((await stepUpRow(t, fresh.sessionId))?.method).toBe("actionPin");
    await fresh.as.mutation(api.stepUp.keepAlive, {});
    await fresh.as.action(api.stepUp.verifyActionPin, { pin: "731942" });
    await expectCode(fresh.as.action(api.stepUp.verifyActionPin, { pin: PIN }), "step_up_invalid");
    expect((await fresh.as.query(api.stepUp.status, {})).pin.recoveryCodesLeft).toBe(9);
    expect(await auditActions(t, v.orgId)).toContain("member.stepUpReset");
    // Used up; another code still works (fresh sign-in again).
    const fresh2 = await newSession(t, v);
    await expectCode(fresh2.as.action(api.stepUp.resetWithRecoveryCode, { code: codes[3]!, newPin: "906417" }), "step_up_invalid");
    await fresh2.as.action(api.stepUp.resetWithRecoveryCode, { code: codes[4]!, newPin: "906417" });
    // An old session cannot use a code.
    setNow(Date.now() + 20 * MINUTE_MS);
    await expectCode(fresh2.as.action(api.stepUp.resetWithRecoveryCode, { code: codes[5]!, newPin: "582019" }), "step_up_setup_required");
  });

  test("reset atomicity (finding 6): a session that was open before a recovery reset cannot fill the empty PIN or survive", async () => {
    const t = await setupAuth();
    const v = await asMember(t, { role: "viewer" });
    await t.run((ctx) => ctx.db.patch(v.sessionId, { expirationTime: Date.now() + 7 * 24 * HOUR_MS }));
    await v.as.action(api.stepUp.setActionPin, { pin: PIN });
    const codes = await v.as.action(api.stepUp.generateRecoveryCodes, {});
    // A racing password thief with a fresh session of the same person.
    const thief = await newSession(t, v);
    const owner1 = await newSession(t, v);
    await owner1.as.action(api.stepUp.resetWithRecoveryCode, { code: codes[0]!, newPin: "731942" });
    // The thief's session is gone: it cannot set (or overwrite) the PIN.
    await expectCode(thief.as.action(api.stepUp.setActionPin, { pin: "906417" }), "unauthenticated");
    // The PIN is the owner's new one.
    await owner1.as.action(api.stepUp.verifyActionPin, { pin: "731942" });
  });

  test("recovery codes: the rate limit is charged BEFORE the work (5 per 15 minutes per person), also in a parallel burst", async () => {
    const t = await setupAuth();
    const v = await asMember(t, { role: "viewer" });
    await v.as.action(api.stepUp.setActionPin, { pin: PIN });
    const codes = await v.as.action(api.stepUp.generateRecoveryCodes, {});
    for (let i = 0; i < 5; i++) await expectCode(v.as.action(api.stepUp.resetWithRecoveryCode, { code: "QQQQ-QQQQ", newPin: "731942" }), "step_up_invalid");
    // Even the right code waits now.
    await expectCode(v.as.action(api.stepUp.resetWithRecoveryCode, { code: codes[0]!, newPin: "731942" }), "rate_limited");
    expect((await factors(t, v.userId))!.recoveryHashes).toHaveLength(10);
    // A burst of parallel guesses by another person: at most 5 get through to the check.
    const w = await asMember(t, { role: "viewer" });
    await w.as.action(api.stepUp.setActionPin, { pin: PIN });
    await w.as.action(api.stepUp.generateRecoveryCodes, {});
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, () => w.as.action(api.stepUp.resetWithRecoveryCode, { code: "QQQQ-QQQQ", newPin: "731942" })),
    );
    const codesSeen = results.map((r) => (r.status === "rejected" ? ((r.reason as { data?: { code?: string } }).data?.code ?? "other") : "ok"));
    expect(codesSeen.filter((c) => c === "step_up_invalid")).toHaveLength(5);
    expect(codesSeen.filter((c) => c === "rate_limited")).toHaveLength(7);
  });

  test("one person cannot block everyone's PIN unlocks: a flood of recovery-code guesses barely touches the global bucket", async () => {
    const t = await setupAuth();
    const attacker = await asMember(t, { role: "viewer" });
    await attacker.as.action(api.stepUp.setActionPin, { pin: PIN });
    await attacker.as.action(api.stepUp.generateRecoveryCodes, {});
    // 350 attempts (> the 300-token global bucket): only 5 are charged to the person, so only 5 reach the global bucket.
    for (let i = 0; i < 350; i++) {
      await attacker.as.action(api.stepUp.resetWithRecoveryCode, { code: "QQQQ-QQQQ", newPin: "731942" }).catch(() => undefined);
    }
    // Someone else with a wrong PIN still gets a normal answer (not rate_limited), and the right PIN works.
    const other = await asMember(t, { role: "viewer" });
    await other.as.action(api.stepUp.setActionPin, { pin: "582019" });
    await expectCode(other.as.action(api.stepUp.verifyActionPin, { pin: "731942" }), "step_up_invalid");
    await other.as.action(api.stepUp.verifyActionPin, { pin: "582019" });
  }, 120_000);

  test("another Owner resets a member's factors; not their own, not a member of another organization", async () => {
    const t = await setupAuth();
    const o = await owner(t);
    await o.as.action(api.stepUp.setActionPin, { pin: PIN });
    const admin = await asMember(t, { role: "admin", orgId: o.orgId });
    await admin.as.action(api.stepUp.setActionPin, { pin: "731942" });
    await o.as.mutation(api.stepUp.resetMember, { memberId: admin.memberId });
    expect(await factors(t, admin.userId)).toBeNull();
    expect(await stepUpRow(t, admin.sessionId)).toBeNull();
    await expectCode(o.as.mutation(api.stepUp.resetMember, { memberId: o.memberId }), "forbidden");
    // A person who is also active in another organization.
    const other = await asMember(t, { role: "admin", orgId: o.orgId });
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
