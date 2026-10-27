import { afterEach, describe, expect, test, vi } from "vitest";
import { setupAuth } from "../tests/convex/auth";
import { asMember, expectCode, expectNoSecrets, identityFor, makeOrg, type Member, type T } from "../tests/convex/identity";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { MINUTE_MS, HOUR_MS, PIN_HARD_LIMIT, STEP_UP_ACTIVITY_QUANTUM_MS } from "./lib/limits";
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

  test("a person with TOTP enrolled must have passed it in this session before the first factor", async () => {
    const t = await setupAuth();
    const v = await asMember(t, { role: "viewer" });
    await t.run((ctx) =>
      ctx.db.insert("memberSecrets", { userId: v.userId, totpSecret: "JBSWY3DPEHPK3PXP", recoveryHashes: [], lastTotpStep: 0, totpFailures: 0, totpLockedUntil: 0 }),
    );
    await expectCode(v.as.action(api.stepUp.setActionPin, { pin: PIN }), "mfa_required");
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

  test("failures persist although the action throws; backoff; the 10th failure disables the PIN with an audit row", async () => {
    const t = await setupAuth();
    const o = await owner(t);
    let now = Date.now();
    await o.as.action(api.stepUp.setActionPin, { pin: PIN });
    let failures = 0;
    let disabled = false;
    while (!disabled) {
      setNow(now);
      try {
        await o.as.action(api.stepUp.verifyActionPin, { pin: "731942" });
        throw new Error("wrong PIN accepted");
      } catch (e) {
        const data = (e as { data?: { code: string; retryAfterMs?: number; detail?: string } }).data;
        if (data?.code === "step_up_locked" && data.detail === "disabled") {
          failures++;
          disabled = true;
        } else if (data?.code === "step_up_locked") {
          now += (data.retryAfterMs ?? 0) + 1;
        } else {
          expect(data?.code).toBe("step_up_invalid");
          failures++;
          const f = await factors(t, o.userId);
          expect(f!.pinFailuresTotal).toBe(failures); // committed by the internal mutation
        }
      }
    }
    expect(failures).toBe(PIN_HARD_LIMIT);
    // Disabled: even the right PIN is refused.
    setNow(now + HOUR_MS);
    await expect(o.as.action(api.stepUp.verifyActionPin, { pin: PIN })).rejects.toMatchObject({ data: { code: "step_up_locked", detail: "disabled" } });
    expect(await auditActions(t, o.orgId)).toContain("member.actionPinLocked");
    // A disabled PIN still counts as a factor: a fresh sign-in cannot just set a new one.
    const again = await newSession(t, o);
    await expectCode(again.as.action(api.stepUp.setActionPin, { pin: "731942" }), "step_up_required");
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
