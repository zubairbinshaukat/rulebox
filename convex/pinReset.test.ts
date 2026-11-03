import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { setupAuth } from "../tests/convex/auth";
import { asMember, expectCode, expectNoSecrets, identityFor, type Member, type T } from "../tests/convex/identity";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { base64Encode, sha256HexSync } from "./lib/crypto";
import { HOUR_MS, MINUTE_MS, PIN_LOCKOUT_MS } from "./lib/limits";

// Forgot PIN by email (Phase 4b Part C), against a MOCKED Resend (fetch is
// stubbed; no test sends mail). Scheduled functions run on fake timers.

declare const process: { env: Record<string, string | undefined> };

const PIN = "246813";
const NEW_PIN = "731942";
const ORIGIN = "https://dashboard.rulebox.test";

type Sent = { to: string[]; subject: string; text: string };
let sent: Sent[] = [];

beforeEach(() => {
  sent = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      sent.push(JSON.parse(init!.body as string) as Sent);
      return new Response("{}", { status: 200 });
    }),
  );
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete process.env.RULEBOX_PLATFORM_KEY;
});

const drain = (t: T) => t.finishAllScheduledFunctions(vi.runAllTimers);

async function mailOn(t: T) {
  process.env.RULEBOX_PLATFORM_KEY = base64Encode(Uint8Array.from({ length: 32 }, (_, i) => i));
  await t.action(internal.platform.setSecret, { name: "resendApiKey", value: "re_TestKeyNotReal_0123456789" });
  await t.action(internal.platform.setSecret, { name: "resendFrom", value: "Rulebox <no-reply@rulebox.test>" });
  await t.action(internal.platform.setSecret, { name: "dashboardOrigin", value: ORIGIN });
}

/** A member with a PIN set from a fresh sign-in; their session lasts 7 days. */
async function memberWithPin(t: T, opts: { role?: "owner" | "admin" | "viewer"; orgId?: Id<"organizations">; email?: string } = {}) {
  const m = await asMember(t, { role: opts.role ?? "admin", orgId: opts.orgId, email: opts.email });
  await t.run((ctx) => ctx.db.patch(m.sessionId, { expirationTime: Date.now() + 7 * 24 * HOUR_MS }));
  await m.as.action(api.stepUp.setActionPin, { pin: PIN });
  return m;
}

/** A new session (a password sign-in) of the same person, created now. */
async function signInAgain(t: T, m: Member) {
  const sessionId = await t.run((ctx) => ctx.db.insert("authSessions", { userId: m.userId, expirationTime: Date.now() + 7 * 24 * HOUR_MS }));
  return { ...m, sessionId, as: identityFor(t, m.userId, sessionId) };
}

function tokenFrom(mail: Sent): string {
  const m = /\/pin-reset\?token=([A-Za-z0-9_-]+)/.exec(mail.text);
  expect(m, "the link").not.toBeNull();
  return m![1]!;
}

async function resetsOf(t: T, userId: Id<"users">) {
  return await t.run((ctx) => ctx.db.query("pinResets").withIndex("by_user_created", (q) => q.eq("userId", userId)).take(20));
}

async function requestLink(t: T, m: Member): Promise<string> {
  await t.action(api.account.requestPinReset, { email: m.email.toUpperCase() });
  await drain(t);
  return tokenFrom(sent.at(-1)!);
}

describe("account:requestPinReset", () => {
  test("the same answer for an existing account, an unknown one and a malformed address; mail only to the member", async () => {
    const t = await setupAuth();
    await mailOn(t);
    const m = await memberWithPin(t);
    expect(await t.action(api.account.requestPinReset, { email: m.email })).toEqual({ ok: true });
    expect(await t.action(api.account.requestPinReset, { email: "ghost@acme.test" })).toEqual({ ok: true });
    expect(await t.action(api.account.requestPinReset, { email: "not an email" })).toEqual({ ok: true });
    await drain(t);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toEqual([m.email]);
    const token = tokenFrom(sent[0]!);
    expect(sent[0]!.text).toContain(`${ORIGIN}/pin-reset?token=${token}`);
    expect(token.length).toBeGreaterThanOrEqual(43); // 256 bits
    // Stored: the SHA-256 only, 30 minutes.
    const rows = await resetsOf(t, m.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).toBe(sha256HexSync(token));
    expect(rows[0]!.expiresAt - rows[0]!.createdAt).toBe(30 * MINUTE_MS);
    expect(JSON.stringify(rows)).not.toContain(token);
    // Audited in the member's organization, without the token.
    const audit = await t.run((ctx) => ctx.db.query("auditLog").withIndex("by_org_at", (q) => q.eq("orgId", m.orgId)).take(20));
    expect(audit.map((a) => a.action)).toContain("member.pinResetRequested");
    expect(JSON.stringify(audit)).not.toContain(token);
    // The scheduler never held the token (only the email address).
    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").take(50));
    expect(JSON.stringify(scheduled)).not.toContain(token);
  });

  test("mail off: the same answer, no link is created and nothing is sent", async () => {
    const t = await setupAuth();
    const m = await memberWithPin(t);
    expect(await t.action(api.account.requestPinReset, { email: m.email })).toEqual({ ok: true });
    await drain(t);
    expect(sent).toHaveLength(0);
    expect(await resetsOf(t, m.userId)).toHaveLength(0);
    expect(await m.as.query(api.account.me, {})).toMatchObject({ pin: { resetByEmail: false } });
  });

  test("a disabled member gets no mail; a new request retires the older link", async () => {
    const t = await setupAuth();
    await mailOn(t);
    const m = await memberWithPin(t);
    const first = await requestLink(t, m);
    const second = await requestLink(t, m);
    expect(first).not.toBe(second);
    const rows = await resetsOf(t, m.userId);
    expect(rows.map((r) => r.tokenHash)).toEqual([sha256HexSync(second)]);
    await t.run((ctx) => ctx.db.patch(m.memberId, { status: "disabled" }));
    const before = sent.length;
    await t.action(api.account.requestPinReset, { email: m.email });
    await drain(t);
    expect(sent).toHaveLength(before);
  });

  test("rate limits: 3 per hour per address (existing or not), 30 per minute in total", async () => {
    const t = await setupAuth();
    for (let i = 0; i < 3; i++) await t.action(api.account.requestPinReset, { email: "ghost@acme.test" });
    await expectCode(t.action(api.account.requestPinReset, { email: "Ghost@Acme.test " }), "rate_limited");
    for (let i = 0; i < 27; i++) await t.action(api.account.requestPinReset, { email: `g${i}@acme.test` });
    await expectCode(t.action(api.account.requestPinReset, { email: "another@acme.test" }), "rate_limited");
    vi.setSystemTime(Date.now() + 2 * MINUTE_MS);
    await t.action(api.account.requestPinReset, { email: "another@acme.test" });
  });
});

describe("account:redeemPinReset", () => {
  test("happy path: new PIN, lockout cleared, every other session ends, this one is unlocked, audited, notice sent", async () => {
    const t = await setupAuth();
    await mailOn(t);
    const m = await memberWithPin(t);
    const other = await signInAgain(t, m);
    await t.run((ctx) =>
      ctx.db.insert("stepUpSessions", { sessionId: other.sessionId, userId: m.userId, verifiedAt: Date.now(), lastActiveAt: Date.now(), method: "actionPin" }),
    );
    // Locked out (24 h): the email link still works.
    await t.run(async (ctx) => {
      const f = (await ctx.db.query("stepUpFactors").withIndex("by_user", (q) => q.eq("userId", m.userId)).first())!;
      await ctx.db.patch(f._id, { pinFailuresTotal: 10, pinFailures: 0, pinLockedUntil: Date.now() + PIN_LOCKOUT_MS });
    });
    const token = await requestLink(t, m);
    // The page signs the person in with their password: a fresh session.
    const page = await signInAgain(t, m);
    await page.as.action(api.account.redeemPinReset, { token, newPin: NEW_PIN });
    const f = await t.run((ctx) => ctx.db.query("stepUpFactors").withIndex("by_user", (q) => q.eq("userId", m.userId)).first());
    expect(f).toMatchObject({ pinFailures: 0, pinFailuresTotal: 0, pinLockedUntil: 0 });
    // Other sessions (the old one and `other`) are gone, with their step-up rows.
    expect(await t.run((ctx) => ctx.db.get(m.sessionId))).toBeNull();
    expect(await t.run((ctx) => ctx.db.get(other.sessionId))).toBeNull();
    await expectCode(other.as.mutation(api.stepUp.keepAlive, {}), "unauthenticated");
    // This session is unlocked and the new PIN works; the old one does not.
    await page.as.mutation(api.stepUp.keepAlive, {});
    await page.as.action(api.stepUp.verifyActionPin, { pin: NEW_PIN });
    await expectCode(page.as.action(api.stepUp.verifyActionPin, { pin: PIN }), "step_up_invalid");
    expect(await page.as.query(api.account.me, {})).toMatchObject({ pin: { set: true, locked: false } });
    const audit = await t.run((ctx) => ctx.db.query("auditLog").withIndex("by_org_at", (q) => q.eq("orgId", m.orgId)).take(30));
    expect(audit.map((a) => a.action)).toContain("member.pinReset");
    expectNoSecrets(audit, [token, NEW_PIN]);
    await drain(t);
    expect(sent.at(-1)).toMatchObject({ to: [m.email], subject: "Your Rulebox PIN was reset" });
    expect(sent.at(-1)!.text).not.toContain(token);
    // Single use.
    const again = await signInAgain(t, m);
    await expectCode(again.as.action(api.account.redeemPinReset, { token, newPin: "906417" }), "step_up_invalid");
  });

  test("the link alone is not enough: no session, an old session, another person's session", async () => {
    const t = await setupAuth();
    await mailOn(t);
    const m = await memberWithPin(t);
    const someone = await memberWithPin(t, { orgId: m.orgId });
    const token = await requestLink(t, m);
    await expectCode(t.action(api.account.redeemPinReset, { token, newPin: NEW_PIN }), "unauthenticated");
    // An old session (signed in more than 15 minutes ago) must sign in again.
    vi.setSystemTime(Date.now() + 16 * MINUTE_MS);
    await expect(m.as.action(api.account.redeemPinReset, { token, newPin: NEW_PIN })).rejects.toMatchObject({
      data: { code: "step_up_setup_required", detail: "reauthenticate" },
    });
    // Another person's fresh session: refused, and the link is spent.
    const theirs = await signInAgain(t, someone);
    await expectCode(theirs.as.action(api.account.redeemPinReset, { token, newPin: NEW_PIN }), "step_up_invalid");
    const mine = await signInAgain(t, m);
    await expectCode(mine.as.action(api.account.redeemPinReset, { token, newPin: NEW_PIN }), "step_up_invalid");
    // Nothing changed for either person.
    await mine.as.action(api.stepUp.verifyActionPin, { pin: PIN });
    await theirs.as.action(api.stepUp.verifyActionPin, { pin: PIN });
  });

  test("expired after 30 minutes; a wrong or oversized token and a weak PIN are refused", async () => {
    const t = await setupAuth();
    await mailOn(t);
    const m = await memberWithPin(t);
    const token = await requestLink(t, m);
    const page = await signInAgain(t, m);
    await expectCode(page.as.action(api.account.redeemPinReset, { token, newPin: "123456" }), "invalid_argument");
    await expectCode(page.as.action(api.account.redeemPinReset, { token: token.slice(0, -1) + "A", newPin: NEW_PIN }), "step_up_invalid");
    await expectCode(page.as.action(api.account.redeemPinReset, { token: "x".repeat(10_000), newPin: NEW_PIN }), "step_up_invalid");
    // The weak PIN and wrong tokens did not spend the link; time does.
    vi.setSystemTime(Date.now() + 31 * MINUTE_MS);
    const late = await signInAgain(t, m);
    await expectCode(late.as.action(api.account.redeemPinReset, { token, newPin: NEW_PIN }), "step_up_invalid");
  });

  test("redeem attempts are rate limited per person", async () => {
    const t = await setupAuth();
    const m = await memberWithPin(t);
    const page = await signInAgain(t, m);
    for (let i = 0; i < 10; i++) await expectCode(page.as.action(api.account.redeemPinReset, { token: `nope${i}`, newPin: NEW_PIN }), "step_up_invalid");
    await expectCode(page.as.action(api.account.redeemPinReset, { token: "nope", newPin: NEW_PIN }), "rate_limited");
  });
});
