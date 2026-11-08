import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { setupAuth, signIn } from "../tests/convex/auth";
import { asMember, expectCode, identityFor, type Member, type T } from "../tests/convex/identity";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { sha256HexSync } from "./lib/crypto";
import { MAX_USER_SESSIONS } from "./lib/limits";
import { beforeSessionCreation } from "./lib/authCallbacks";
import { matchRecoveryHash, recoveryHash } from "./lib/recoveryCodes";
import { runOrSchedule } from "./lib/retry";
import { deleteUserSessions } from "./lib/sessions";

declare const process: { env: Record<string, string | undefined> };

// Follow-ups of the WP5a security review: PIN notice and revocation, stale
// PIN verification, no Argon2 for members without a PIN, bounded sessions,
// sign-in charging only failures, the recovery-code pepper, and the
// password-change revocation fallback.

const argon = vi.hoisted(() => ({ verifies: 0 }));
vi.mock("hash-wasm", async (importOriginal) => {
  const real = await importOriginal<typeof import("hash-wasm")>();
  return {
    ...real,
    argon2Verify: async (options: Parameters<typeof real.argon2Verify>[0]) => {
      argon.verifies++;
      return await real.argon2Verify(options);
    },
  };
});

const PIN = "246813";
const NEW_PIN = "731942";
const PEPPER = "followup-test-pepper-0123456789abcdef";
const PASSWORD = "correct horse 42 battery";

beforeEach(() => {
  process.env.RULEBOX_RECOVERY_PEPPER = PEPPER;
  argon.verifies = 0;
});

afterEach(() => {
  delete process.env.RULEBOX_RECOVERY_PEPPER;
});

async function member(t: T): Promise<Member> {
  const m = await asMember(t, { role: "owner" });
  await t.run((ctx) => ctx.db.patch(m.sessionId, { expirationTime: Date.now() + 7 * 24 * 3_600_000 }));
  return m;
}

async function otherSession(t: T, m: Member) {
  const sessionId = await t.run((ctx) => ctx.db.insert("authSessions", { userId: m.userId, expirationTime: Date.now() + 7 * 24 * 3_600_000 }));
  return { sessionId, as: identityFor(t, m.userId, sessionId) };
}

async function stepUpRow(t: T, sessionId: Id<"authSessions">) {
  return await t.run((ctx) => ctx.db.query("stepUpSessions").withIndex("by_session", (q) => q.eq("sessionId", sessionId)).first());
}

async function mails(t: T): Promise<{ to: string; subject: string; text: string }[]> {
  const rows = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").take(100));
  return rows.filter((s) => s.name.includes("mail")).map((s) => s.args[0] as { to: string; subject: string; text: string });
}

describe("PIN set or changed (items 1 and 4)", () => {
  test("the person is mailed on the first PIN and on every change, audited, and other sessions lose their unlock", async () => {
    const t = await setupAuth();
    const m = await member(t);
    await m.as.action(api.stepUp.setActionPin, { pin: PIN });
    const first = await mails(t);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ to: m.email, subject: "A PIN was set on your Rulebox account" });
    expect(JSON.stringify(first)).not.toContain(PIN);

    // A second session of the same person, unlocked with the old PIN.
    const other = await otherSession(t, m);
    await t.run((ctx) =>
      ctx.db.insert("stepUpSessions", { sessionId: other.sessionId, userId: m.userId, verifiedAt: Date.now(), lastActiveAt: Date.now(), method: "actionPin" }),
    );
    await other.as.action(api.stepUp.verifyActionPin, { pin: PIN });
    expect(await stepUpRow(t, other.sessionId)).not.toBeNull();

    await m.as.action(api.stepUp.setActionPin, { pin: NEW_PIN });
    const all = await mails(t);
    expect(all).toHaveLength(2);
    expect(all.map((x) => x.subject)).toContain("Your Rulebox PIN was changed");
    // The other session is locked again (its session itself stays); this one stays unlocked.
    expect(await stepUpRow(t, other.sessionId)).toBeNull();
    expect(await stepUpRow(t, m.sessionId)).not.toBeNull();
    await expectCode(other.as.mutation(api.stepUp.keepAlive, {}), "step_up_required");
    await m.as.mutation(api.stepUp.keepAlive, {});
    const audit = await t.run((ctx) => ctx.db.query("auditLog").withIndex("by_org_at", (q) => q.eq("orgId", m.orgId)).take(20));
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(["member.actionPinSet", "member.actionPinChanged"]));
  });

  test("a PIN changed while another verification was hashing: the old PIN does not unlock (finishPinSuccess)", async () => {
    const t = await setupAuth();
    const m = await member(t);
    await m.as.action(api.stepUp.setActionPin, { pin: PIN });
    const other = await otherSession(t, m);
    // The other session reserves an attempt (begin), then the owner changes the PIN before it finishes.
    const reservedAt = Date.now();
    const attempt = await t.mutation(internal.stepUp.beginPinAttempt, { userId: m.userId, now: reservedAt });
    expect(attempt.kind).toBe("go");
    if (attempt.kind !== "go") return;
    await m.as.action(api.stepUp.setActionPin, { pin: NEW_PIN });
    await expectCode(
      t.mutation(internal.stepUp.finishPinSuccess, {
        userId: m.userId,
        sessionId: other.sessionId,
        now: Date.now(),
        reservedAt,
        hashChecked: attempt.hash,
      }),
      "step_up_invalid",
    );
    expect(await stepUpRow(t, other.sessionId)).toBeNull();
    // The normal path (the hash that matched is still the stored one) still unlocks.
    await other.as.action(api.stepUp.verifyActionPin, { pin: NEW_PIN });
    expect(await stepUpRow(t, other.sessionId)).not.toBeNull();
    await expectCode(other.as.action(api.stepUp.verifyActionPin, { pin: PIN }), "step_up_invalid");
  });
});

describe("no PIN, no Argon2 (item 3)", () => {
  test("verifyActionPin answers not_ready at once, without hashing, and counts nothing", async () => {
    const t = await setupAuth();
    const m = await member(t);
    for (let i = 0; i < 3; i++) await expectCode(m.as.action(api.stepUp.verifyActionPin, { pin: PIN }), "not_ready");
    expect(argon.verifies).toBe(0);
    expect(await t.run((ctx) => ctx.db.query("pinCounters").withIndex("by_user", (q) => q.eq("userId", m.userId)).first())).toBeNull();
    // With a PIN the check does run Argon2.
    await m.as.action(api.stepUp.setActionPin, { pin: PIN });
    await m.as.action(api.stepUp.verifyActionPin, { pin: PIN });
    expect(argon.verifies).toBe(1);
  });
});

describe("bounded sessions (item 5)", () => {
  test("a new sign-in keeps at most MAX_USER_SESSIONS: the oldest go with their tokens and rows; a reset ends the rest at once", async () => {
    const t = await setupAuth();
    const m = await member(t);
    const extra = MAX_USER_SESSIONS + 5;
    const ids = await t.run(async (ctx) => {
      const list: Id<"authSessions">[] = [m.sessionId];
      for (let i = 0; i < extra; i++) {
        const s = await ctx.db.insert("authSessions", { userId: m.userId, expirationTime: Date.now() + 3_600_000 });
        await ctx.db.insert("authRefreshTokens", { sessionId: s, expirationTime: Date.now() + 3_600_000 });
        await ctx.db.insert("stepUpSessions", { sessionId: s, userId: m.userId, verifiedAt: Date.now(), lastActiveAt: Date.now(), method: "actionPin" });
        list.push(s);
      }
      return list;
    });
    await t.run((ctx) => beforeSessionCreation(ctx, { userId: m.userId }));
    const left = await t.run((ctx) => ctx.db.query("authSessions").withIndex("userId", (q) => q.eq("userId", m.userId)).collect());
    // One slot is left for the session being created.
    expect(left).toHaveLength(MAX_USER_SESSIONS - 1);
    const kept = new Set(left.map((s) => s._id));
    const gone = ids.filter((id) => !kept.has(id));
    expect(gone.length).toBe(ids.length - (MAX_USER_SESSIONS - 1));
    expect(kept.has(ids.at(-1)!)).toBe(true); // the newest survive
    expect(kept.has(ids[0]!)).toBe(false); // the oldest do not
    for (const id of gone) {
      expect(await stepUpRow(t, id)).toBeNull();
      expect(await t.run((ctx) => ctx.db.query("authRefreshTokens").withIndex("sessionId", (q) => q.eq("sessionId", id)).first())).toBeNull();
    }
    // A reset (everything but the caller's session) is one transaction and leaves exactly that session.
    const keep = ids.at(-1)!;
    const deleted = await t.run((ctx) => deleteUserSessions(ctx, m.userId, keep));
    expect(deleted).toBe(MAX_USER_SESSIONS - 2);
    const after = await t.run((ctx) => ctx.db.query("authSessions").withIndex("userId", (q) => q.eq("userId", m.userId)).collect());
    expect(after.map((s) => s._id)).toEqual([keep]);
    expect(await t.run((ctx) => ctx.db.query("stepUpSessions").withIndex("by_user", (q) => q.eq("userId", m.userId)).collect())).toHaveLength(1);
  });

  test("a person under the cap loses nothing", async () => {
    const t = await setupAuth();
    const m = await member(t);
    await otherSession(t, m);
    await t.run((ctx) => beforeSessionCreation(ctx, { userId: m.userId }));
    expect(await t.run((ctx) => ctx.db.query("authSessions").withIndex("userId", (q) => q.eq("userId", m.userId)).collect())).toHaveLength(2);
  });
});

describe("password change revocation fallback (item 6)", () => {
  test("runOrSchedule: runs once on success, retries, then schedules when every attempt fails", async () => {
    const schedule = vi.fn(async () => undefined);
    const ok = vi.fn(async () => undefined);
    expect(await runOrSchedule(ok, schedule)).toBe("ran");
    expect(ok).toHaveBeenCalledTimes(1);
    expect(schedule).not.toHaveBeenCalled();

    let calls = 0;
    const flaky = vi.fn(async () => {
      if (++calls < 2) throw new Error("transient");
    });
    expect(await runOrSchedule(flaky, schedule)).toBe("ran");
    expect(flaky).toHaveBeenCalledTimes(2);
    expect(schedule).not.toHaveBeenCalled();

    const broken = vi.fn(async () => {
      throw new Error("down");
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await runOrSchedule(broken, schedule)).toBe("scheduled");
    expect(broken).toHaveBeenCalledTimes(3);
    expect(schedule).toHaveBeenCalledTimes(1);
    // If even the scheduling fails, the caller hears about it.
    await expect(runOrSchedule(broken, async () => Promise.reject(new Error("no scheduler")))).rejects.toThrow("no scheduler");
  });

  test("the scheduled continuation (finishPasswordChange) ends the other sessions, keeps the caller's, and is audited and mailed", async () => {
    const t = await setupAuth();
    const m = await member(t);
    const other = await otherSession(t, m);
    await t.mutation(internal.account.finishPasswordChange, { userId: m.userId, sessionId: m.sessionId });
    expect(await t.run((ctx) => ctx.db.get(other.sessionId))).toBeNull();
    expect(await t.run((ctx) => ctx.db.get(m.sessionId))).not.toBeNull();
    expect((await mails(t)).some((x) => x.subject === "Your Rulebox password was changed")).toBe(true);
  });
});

describe("sign-in charges only failures (item 2)", () => {
  async function owner(t: T) {
    const inv = await t.action(internal.setup.createOwnerInvite, { orgName: "Acme", email: "owner@acme.test" });
    await signIn(t, { flow: "signUp", email: "owner@acme.test", password: PASSWORD, inviteCode: inv.inviteCode });
  }

  test("any number of successful sign-ins never rate limits; failures still do after 10", async () => {
    const t = await setupAuth();
    await owner(t);
    for (let i = 0; i < 12; i++) {
      expect((await signIn(t, { flow: "signIn", email: "owner@acme.test", password: PASSWORD })).tokens?.token).toBeTruthy();
    }
    for (let i = 0; i < 9; i++) await expect(signIn(t, { flow: "signIn", email: "owner@acme.test", password: "wrong wrong 1" })).rejects.toBeTruthy();
    // 9 failures: the right password still works, and costs nothing.
    expect((await signIn(t, { flow: "signIn", email: "owner@acme.test", password: PASSWORD })).tokens?.token).toBeTruthy();
    await expect(signIn(t, { flow: "signIn", email: "owner@acme.test", password: "wrong wrong 1" })).rejects.toBeTruthy();
    await expectCode(signIn(t, { flow: "signIn", email: "owner@acme.test", password: PASSWORD }), "rate_limited");
  }, 90_000);

  test("failed sign-UPS for an email do not touch that email's sign-in budget", async () => {
    const t = await setupAuth();
    await owner(t);
    for (let i = 0; i < 11; i++) {
      await expect(
        signIn(t, { flow: "signUp", email: "owner@acme.test", password: PASSWORD, inviteCode: "0000000000" }),
      ).rejects.toBeTruthy();
    }
    expect((await signIn(t, { flow: "signIn", email: "owner@acme.test", password: PASSWORD })).tokens?.token).toBeTruthy();
  }, 60_000);
});

describe("recovery-code pepper (item 7)", () => {
  test("hashes are HMAC-SHA-256 under the pepper: not the bare SHA-256, different per pepper, stable per code", () => {
    const h = recoveryHash("abcd-efgh");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).toBe(recoveryHash("ABCD-EFGH"));
    expect(h).toBe(recoveryHash("abcdefgh"));
    expect(h).not.toBe(sha256HexSync("ABCD-EFGH"));
    expect(matchRecoveryHash([recoveryHash("WXYZ-2345"), h], "abcd efgh")).toBe(1);
    process.env.RULEBOX_RECOVERY_PEPPER = "another-pepper-0123456789abcdefghijk";
    expect(recoveryHash("ABCD-EFGH")).not.toBe(h);
    expect(matchRecoveryHash([h], "ABCD-EFGH")).toBeNull(); // rotating the pepper retires old codes
  });

  test("no pepper (or a too short one): nothing is hashed or matched, every entry point answers not_ready", async () => {
    const t = await setupAuth();
    const m = await member(t);
    await m.as.action(api.stepUp.setActionPin, { pin: PIN });
    const codes = await m.as.action(api.stepUp.generateRecoveryCodes, {});
    expect((await t.run((ctx) => ctx.db.query("stepUpFactors").withIndex("by_user", (q) => q.eq("userId", m.userId)).first()))!.recoveryHashes).toEqual(
      codes.map((c) => recoveryHash(c)),
    );
    for (const value of [undefined, "", "too-short"]) {
      if (value === undefined) delete process.env.RULEBOX_RECOVERY_PEPPER;
      else process.env.RULEBOX_RECOVERY_PEPPER = value;
      expect(() => recoveryHash(codes[0]!)).toThrow();
      expect(() => matchRecoveryHash(["x"], "garbage")).toThrow();
      await expectCode(m.as.action(api.stepUp.generateRecoveryCodes, {}), "not_ready");
      const fresh = await otherSession(t, m);
      await expectCode(fresh.as.action(api.stepUp.resetWithRecoveryCode, { code: codes[0]!, newPin: NEW_PIN }), "not_ready");
    }
    // Nothing was spent: the codes are all still there once the pepper is back.
    process.env.RULEBOX_RECOVERY_PEPPER = PEPPER;
    expect((await t.run((ctx) => ctx.db.query("stepUpFactors").withIndex("by_user", (q) => q.eq("userId", m.userId)).first()))!.recoveryHashes).toHaveLength(10);
    const fresh = await otherSession(t, m);
    await fresh.as.action(api.stepUp.resetWithRecoveryCode, { code: codes[0]!, newPin: NEW_PIN });
  });
});
