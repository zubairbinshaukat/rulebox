import { afterEach, describe, expect, test, vi } from "vitest";
import { setupAuth } from "../tests/convex/auth";
import { asMember, expectCode, expectNoSecrets, type T } from "../tests/convex/identity";
import { api } from "./_generated/api";
import { base32Decode, base32Encode, codeHash } from "./lib/crypto";
import { requireMember } from "./lib/authz";
import { hotp, stepAt, verifyTotp } from "./lib/totp";

const RFC_SECRET = base32Encode(new TextEncoder().encode("12345678901234567890"));

describe("TOTP (RFC 6238, SHA-1, last 6 digits)", () => {
  test.each([
    [59, "287082"],
    [1111111109, "081804"],
    [1234567890, "005924"],
    [2000000000, "279037"],
  ])("t=%i -> %s", (seconds, code) => {
    const key = base32Decode(RFC_SECRET)!;
    expect(hotp(key, Math.floor(seconds / 30))).toBe(code);
    expect(verifyTotp(RFC_SECRET, code, seconds * 1000, 0)).toBe(Math.floor(seconds / 30));
  });

  test("window +-1 accepted, +-2 refused, replay refused", () => {
    const key = base32Decode(RFC_SECRET)!;
    const now = 1_700_000_000_000;
    const s = stepAt(now);
    expect(verifyTotp(RFC_SECRET, hotp(key, s - 1), now, 0)).toBe(s - 1);
    expect(verifyTotp(RFC_SECRET, hotp(key, s + 1), now, 0)).toBe(s + 1);
    expect(verifyTotp(RFC_SECRET, hotp(key, s - 2), now, 0)).toBeNull();
    expect(verifyTotp(RFC_SECRET, hotp(key, s + 2), now, 0)).toBeNull();
    expect(verifyTotp(RFC_SECRET, hotp(key, s), now, s)).toBeNull();
    expect(verifyTotp(RFC_SECRET, hotp(key, s), now, s - 1)).toBe(s);
    expect(verifyTotp(RFC_SECRET, "12345", now, 0)).toBeNull();
    expect(verifyTotp("not base32!", "123456", now, 0)).toBeNull();
  });

  test("base32 round trip", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 255, 7, 8, 9, 10]);
    expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
  });
});

function codeFor(secret: string, offsetSteps = 0): string {
  return hotp(base32Decode(secret)!, stepAt(Date.now()) + offsetSteps);
}

async function enrolled(t: T, role: "owner" | "admin" | "viewer" = "admin") {
  const m = await asMember(t, { role });
  const setup = await m.as.action(api.mfa.beginSetup, {});
  const codes = await m.as.action(api.mfa.confirmSetup, { code: codeFor(setup.secret) });
  return { ...m, secret: setup.secret, codes };
}

describe("mfa functions", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("setup: begin returns the secret once, confirm stores it and returns 10 codes once", async () => {
    const t = await setupAuth();
    const m = await asMember(t, { role: "admin" });
    // Before MFA an admin can reach only the mfa:* functions.
    await expectCode(m.as.query(api.members.list, {}), "mfa_required");
    const before = await m.as.query(api.mfa.status, {});
    expect(before).toMatchObject({ enrolled: false, required: true, verified: false });
    const setup = await m.as.action(api.mfa.beginSetup, {});
    expect(setup.uri).toContain(`secret=${setup.secret}`);
    expect(base32Decode(setup.secret)?.length).toBe(20);
    await expectCode(m.as.action(api.mfa.confirmSetup, { code: "000000" === codeFor(setup.secret) ? "111111" : "000000" }), "mfa_invalid_code");
    const codes = await m.as.action(api.mfa.confirmSetup, { code: codeFor(setup.secret) });
    expect(codes).toHaveLength(10);
    for (const c of codes) expect(c).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    const after = await m.as.query(api.mfa.status, {});
    expect(after).toMatchObject({ enrolled: true, verified: true, recoveryCodesLeft: 10 });
    expectNoSecrets(after, [setup.secret, ...codes]);
    const me = await m.as.query(api.account.me, {});
    expectNoSecrets(me, [setup.secret, ...codes]);
    // Stored: secret base32 in memberSecrets, recovery codes only hashed.
    const s = await t.run((ctx) => ctx.db.query("memberSecrets").withIndex("by_user", (q) => q.eq("userId", m.userId)).first());
    expect(s?.totpSecret).toBe(setup.secret);
    expect(s?.totpPending).toBeUndefined();
    expect(JSON.stringify(s?.recoveryHashes)).not.toContain(codes[0]!);
    await expectCode(m.as.action(api.mfa.beginSetup, {}), "mfa_already_enabled");
    // Now the gate is open for this session.
    expect((await m.as.query(api.members.list, {})).members.length).toBeGreaterThan(0);
  });

  test("verify: a new session needs a code; replay refused; 5 failures lock 15 minutes", async () => {
    const t = await setupAuth();
    const m = await enrolled(t);
    // A second session of the same user (no MFA row yet).
    const s2 = await t.run((ctx) => ctx.db.insert("authSessions", { userId: m.userId, expirationTime: Date.now() + 3_600_000 }));
    const as2 = t.withIdentity({ subject: `${m.userId}|${s2}` });
    await expectCode(as2.run((ctx) => requireMember(ctx, "admin")), "mfa_required");
    // The code used by confirmSetup (same step) is a replay.
    await expectCode(as2.action(api.mfa.verify, { code: codeFor(m.secret) }), "mfa_invalid_code");
    await as2.action(api.mfa.verify, { code: codeFor(m.secret, 1) });
    expect((await as2.run((ctx) => requireMember(ctx, "admin"))).member.role).toBe("admin");

    const s3 = await t.run((ctx) => ctx.db.insert("authSessions", { userId: m.userId, expirationTime: Date.now() + 3_600_000 }));
    const as3 = t.withIdentity({ subject: `${m.userId}|${s3}` });
    for (let i = 0; i < 4; i++) await expectCode(as3.action(api.mfa.verify, { code: "000000" }), "mfa_invalid_code");
    await expectCode(as3.action(api.mfa.verify, { code: "000000" }), "mfa_locked");
    // Locked: even a correct code is refused, with retryAfterMs.
    await expect(as3.action(api.mfa.verify, { code: codeFor(m.secret, 2) })).rejects.toMatchObject({
      data: { code: "mfa_locked" },
    });
    const st = await as3.query(api.mfa.status, {});
    expect(st.lockedUntil).toBeGreaterThan(Date.now());
  });

  test("recovery code works once and shares the lockout counter", async () => {
    const t = await setupAuth();
    const m = await enrolled(t);
    const s2 = await t.run((ctx) => ctx.db.insert("authSessions", { userId: m.userId, expirationTime: Date.now() + 3_600_000 }));
    const as2 = t.withIdentity({ subject: `${m.userId}|${s2}` });
    const code = m.codes[3]!;
    await as2.action(api.mfa.useRecoveryCode, { code: code.toLowerCase().replace("-", " ") });
    expect((await as2.query(api.mfa.status, {})).recoveryCodesLeft).toBe(9);
    const s3 = await t.run((ctx) => ctx.db.insert("authSessions", { userId: m.userId, expirationTime: Date.now() + 3_600_000 }));
    const as3 = t.withIdentity({ subject: `${m.userId}|${s3}` });
    await expectCode(as3.action(api.mfa.useRecoveryCode, { code }), "mfa_invalid_code");
    const audit = await t.run((ctx) =>
      ctx.db.query("auditLog").withIndex("by_org_at", (q) => q.eq("orgId", m.orgId)).order("desc").first(),
    );
    expect(audit?.action).toBe("member.recoveryCodeUsed");
    expectNoSecrets(audit, m.codes);
    expect(JSON.stringify(audit)).not.toContain(codeHash(code));
  });

  test("viewers may enrol; it is not required", async () => {
    const t = await setupAuth();
    const v = await asMember(t, { role: "viewer" });
    expect(await v.as.query(api.mfa.status, {})).toMatchObject({ required: false, enrolled: false });
    expect((await v.as.query(api.members.list, {})).members).toHaveLength(1);
  });
});
