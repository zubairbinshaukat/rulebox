import { afterEach, describe, expect, test, vi } from "vitest";
import { setupAuth } from "../tests/convex/auth";
import { asMember, expectCode, expectNoSecrets, type Member, type T } from "../tests/convex/identity";
import { FLAG_UP, SoftAuthenticator } from "../tests/convex/webauthn";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { MAX_PASSKEYS, MINUTE_MS } from "./lib/limits";
import { parseWebAuthnConfig } from "./lib/webauthnConfig";

// Passkeys for step-up (plan 4.16). Everything here runs against SIMULATED
// authenticator responses (tests/convex/webauthn.ts: ES256, attestation
// "none"); a real browser + authenticator is the manual check of Step 5a.

declare const process: { env: Record<string, string | undefined> };

afterEach(() => {
  vi.useRealTimers();
});

async function owner(t: T): Promise<Member> {
  return await asMember(t, { role: "owner", mfa: true });
}

/** Register a passkey for `m` (bootstrap when it is the first factor). */
async function register(m: Member, auth?: SoftAuthenticator) {
  const a = auth ?? (await SoftAuthenticator.create());
  const begin = await m.as.action(api.passkeys.beginRegistration, {});
  const { passkeyId } = await m.as.action(api.passkeys.finishRegistration, { responseJson: a.register(begin.optionsJson), name: "Laptop" });
  return { a, passkeyId };
}

async function verifyWith(m: Member, a: SoftAuthenticator, c: Parameters<SoftAuthenticator["assert"]>[1] = {}) {
  const begin = await m.as.action(api.passkeys.beginVerification, {});
  return await m.as.action(api.passkeys.finishVerification, { responseJson: await a.assert(begin.optionsJson, c) });
}

async function row(t: T, sessionId: Id<"authSessions">) {
  return await t.run((ctx) => ctx.db.query("stepUpSessions").withIndex("by_session", (q) => q.eq("sessionId", sessionId)).first());
}

describe("passkey registration", () => {
  test("first passkey right after sign-in: stored, unlocks the session, never returned in full", async () => {
    const t = await setupAuth();
    const o = await owner(t);
    const begin = await o.as.action(api.passkeys.beginRegistration, {});
    const options = JSON.parse(begin.optionsJson) as {
      rp: { id: string };
      attestation: string;
      authenticatorSelection: { userVerification: string };
      challenge: string;
      pubKeyCredParams: { alg: number }[];
    };
    expect(options.rp.id).toBe("localhost");
    expect(options.attestation).toBe("none");
    expect(options.authenticatorSelection.userVerification).toBe("required");
    expect(options.pubKeyCredParams.map((p) => p.alg)).toEqual([-8, -7, -257]);
    // The challenge is stored hashed only.
    const stored = await t.run((ctx) => ctx.db.query("stepUpChallenges").withIndex("by_session_purpose", (q) => q.eq("sessionId", o.sessionId)).take(5));
    expect(stored).toHaveLength(1);
    expect(JSON.stringify(stored)).not.toContain(options.challenge);

    const a = await SoftAuthenticator.create();
    await o.as.action(api.passkeys.finishRegistration, { responseJson: a.register(begin.optionsJson), name: "Laptop" });
    const key = await t.run((ctx) => ctx.db.query("passkeys").withIndex("by_user", (q) => q.eq("userId", o.userId)).first());
    expect(key).toMatchObject({ credentialId: a.credentialId, counter: 1, transports: ["internal"], name: "Laptop" });
    expect((await row(t, o.sessionId))?.method).toBe("passkey");
    const status = await o.as.query(api.stepUp.status, {});
    expect(status.passkeys).toHaveLength(1);
    expectNoSecrets(status, [a.credentialId, key!.credentialPublicKey]);
    // Challenge consumed.
    expect(await t.run((ctx) => ctx.db.query("stepUpChallenges").withIndex("by_session_purpose", (q) => q.eq("sessionId", o.sessionId)).take(5))).toHaveLength(0);
  });

  test("refused: no user verification, wrong origin, wrong RP ID, wrong ceremony type, replayed challenge", async () => {
    const t = await setupAuth();
    const o = await owner(t);
    const a = await SoftAuthenticator.create();
    for (const c of [{ flags: FLAG_UP }, { origin: "https://evil.test" }, { rpId: "evil.test" }, { type: "webauthn.get" }]) {
      const begin = await o.as.action(api.passkeys.beginRegistration, {});
      await expectCode(o.as.action(api.passkeys.finishRegistration, { responseJson: a.register(begin.optionsJson, c) }), "step_up_invalid");
    }
    const begin = await o.as.action(api.passkeys.beginRegistration, {});
    const json = a.register(begin.optionsJson);
    await o.as.action(api.passkeys.finishRegistration, { responseJson: json });
    await expectCode(o.as.action(api.passkeys.finishRegistration, { responseJson: json }), "step_up_invalid");
  });

  test("the same credential cannot be registered twice (also not by another person); a second passkey needs a fresh step-up; limit", async () => {
    const t = await setupAuth();
    const o = await owner(t);
    const { a } = await register(o);
    // Second registration of the same authenticator.
    let begin = await o.as.action(api.passkeys.beginRegistration, {});
    expect((JSON.parse(begin.optionsJson) as { excludeCredentials: { id: string }[] }).excludeCredentials.map((c) => c.id)).toEqual([a.credentialId]);
    await expect(o.as.action(api.passkeys.finishRegistration, { responseJson: a.register(begin.optionsJson) })).rejects.toMatchObject({
      data: { code: "conflict", detail: "passkey exists" },
    });
    const other = await asMember(t, { role: "admin", mfa: true, orgId: o.orgId });
    begin = await other.as.action(api.passkeys.beginRegistration, {});
    await expectCode(other.as.action(api.passkeys.finishRegistration, { responseJson: a.register(begin.optionsJson) }), "conflict");
    // Not fresh any more.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 6 * MINUTE_MS);
    await expectCode(o.as.action(api.passkeys.beginRegistration, {}), "step_up_required");
    await verifyWith(o, a);
    for (let i = 1; i < MAX_PASSKEYS; i++) await register(o);
    await expect(o.as.action(api.passkeys.beginRegistration, {})).rejects.toMatchObject({ data: { code: "conflict", detail: "passkey limit" } });
  });
});

describe("passkey verification", () => {
  test("verifies, bumps the counter, unlocks fresh; replay and expired challenges are refused", async () => {
    const t = await setupAuth();
    const o = await owner(t);
    const { a, passkeyId } = await register(o);
    await o.as.mutation(api.stepUp.lock, {});
    const r = await verifyWith(o, a);
    expect(r.freshUntil - r.verifiedAt).toBe(5 * MINUTE_MS);
    expect(await t.run((ctx) => ctx.db.get(passkeyId))).toMatchObject({ counter: 2 });
    expect((await row(t, o.sessionId))?.passkeyId).toBe(passkeyId);
    // Replay of a consumed assertion.
    const begin = await o.as.action(api.passkeys.beginVerification, {});
    const json = await a.assert(begin.optionsJson);
    await o.as.action(api.passkeys.finishVerification, { responseJson: json });
    await expectCode(o.as.action(api.passkeys.finishVerification, { responseJson: json }), "step_up_invalid");
    // Expired (2 minutes).
    const late = await o.as.action(api.passkeys.beginVerification, {});
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 3 * MINUTE_MS);
    await expectCode(o.as.action(api.passkeys.finishVerification, { responseJson: await a.assert(late.optionsJson) }), "step_up_invalid");
  });

  test("a second begin (cancelled prompt, other tab) replaces the first challenge", async () => {
    const t = await setupAuth();
    const o = await owner(t);
    const { a } = await register(o);
    const first = await o.as.action(api.passkeys.beginVerification, {});
    const second = await o.as.action(api.passkeys.beginVerification, {});
    await expectCode(o.as.action(api.passkeys.finishVerification, { responseJson: await a.assert(first.optionsJson) }), "step_up_invalid");
    await o.as.action(api.passkeys.finishVerification, { responseJson: await a.assert(second.optionsJson) });
  });

  test("refused: wrong origin, wrong RP ID, no user verification, bad signature, another person's passkey", async () => {
    const t = await setupAuth();
    const o = await owner(t);
    const { a } = await register(o);
    for (const c of [{ origin: "https://evil.test" }, { rpId: "evil.test" }, { flags: FLAG_UP }, { badSignature: true }]) {
      await expectCode(verifyWith(o, a, c), "step_up_invalid");
    }
    const other = await asMember(t, { role: "admin", mfa: true, orgId: o.orgId });
    const theirs = await register(other);
    const begin = await o.as.action(api.passkeys.beginVerification, {});
    await expectCode(o.as.action(api.passkeys.finishVerification, { responseJson: await theirs.a.assert(begin.optionsJson) }), "step_up_invalid");
    // None of these suspended anything.
    const keys = await t.run((ctx) => ctx.db.query("passkeys").take(5));
    expect(keys.every((k) => k.disabledAt === undefined)).toBe(true);
  });

  test("cloned authenticator: a validly signed counter that goes backwards suspends the passkey; a forged one does not", async () => {
    const t = await setupAuth();
    const o = await owner(t);
    const { a, passkeyId } = await register(o);
    await verifyWith(o, a); // counter 2
    await verifyWith(o, a); // counter 3
    // Forged (bad signature) with a low counter: refused, NOT suspended.
    await expectCode(verifyWith(o, a, { counter: 1, badSignature: true }), "step_up_invalid");
    expect((await t.run((ctx) => ctx.db.get(passkeyId)))?.disabledAt).toBeUndefined();
    // Genuine signature, counter not higher: clone suspected.
    await expectCode(verifyWith(o, a, { counter: 3 }), "step_up_invalid");
    expect((await t.run((ctx) => ctx.db.get(passkeyId)))?.disabledAt).toBeGreaterThan(0);
    await expectCode(o.as.action(api.passkeys.beginVerification, {}), "not_ready");
    const audit = await t.run((ctx) => ctx.db.query("auditLog").withIndex("by_org_at", (q) => q.eq("orgId", o.orgId)).take(20));
    expect(audit.map((x) => x.action)).toContain("member.passkeyCloneDetected");
  });

  test("an authenticator without a counter (synced passkey, always 0) keeps working", async () => {
    const t = await setupAuth();
    const o = await owner(t);
    const a = await SoftAuthenticator.create(0);
    await register(o, a);
    await verifyWith(o, a);
    await verifyWith(o, a);
  });
});

describe("passkey management", () => {
  test("removing the passkey this session used ends the unlock; the last factor stays; rename", async () => {
    const t = await setupAuth();
    const o = await owner(t);
    const first = await register(o);
    const second = await register(o);
    await o.as.mutation(api.stepUp.renamePasskey, { passkeyId: second.passkeyId, name: "  Phone " });
    expect((await t.run((ctx) => ctx.db.get(second.passkeyId)))?.name).toBe("Phone");
    await expectCode(o.as.mutation(api.stepUp.renamePasskey, { passkeyId: second.passkeyId, name: "" }), "invalid_argument");
    await verifyWith(o, first.a);
    await o.as.mutation(api.stepUp.removePasskey, { passkeyId: first.passkeyId });
    expect(await row(t, o.sessionId)).toBeNull();
    await verifyWith(o, second.a);
    await expectCode(o.as.mutation(api.stepUp.removePasskey, { passkeyId: second.passkeyId }), "step_up_last_factor");
    // With an action PIN as well, the last passkey may go; then the PIN is the last factor.
    await o.as.action(api.stepUp.setActionPin, { pin: "246813" });
    await o.as.mutation(api.stepUp.removePasskey, { passkeyId: second.passkeyId });
    await o.as.action(api.stepUp.verifyActionPin, { pin: "246813" });
    await expectCode(o.as.mutation(api.stepUp.clearActionPin, {}), "step_up_last_factor");
  });

  test("a forgotten action PIN is changed after a passkey step-up (the passkey is on this device)", async () => {
    const t = await setupAuth();
    const o = await owner(t);
    const { a } = await register(o);
    await o.as.action(api.stepUp.setActionPin, { pin: "246813" });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 6 * MINUTE_MS);
    await expectCode(o.as.action(api.stepUp.setActionPin, { pin: "731942" }), "step_up_required");
    await verifyWith(o, a);
    await o.as.action(api.stepUp.setActionPin, { pin: "731942" });
  });

  test("passkeys off when not configured (fail closed); the PIN still works", async () => {
    const t = await setupAuth();
    const o = await owner(t);
    const saved = process.env.RULEBOX_WEBAUTHN_ORIGINS;
    process.env.RULEBOX_WEBAUTHN_ORIGINS = "http://evil.test";
    try {
      await expect(o.as.action(api.passkeys.beginRegistration, {})).rejects.toMatchObject({ data: { code: "not_ready", detail: "passkeys not configured" } });
      expect((await o.as.query(api.stepUp.status, {})).passkeysAvailable).toBe(false);
      await o.as.action(api.stepUp.setActionPin, { pin: "246813" });
    } finally {
      process.env.RULEBOX_WEBAUTHN_ORIGINS = saved;
    }
  });

  test("configuration rules", () => {
    expect(parseWebAuthnConfig("rulebox.app", "https://dash.rulebox.app", undefined)).toEqual({
      rpId: "rulebox.app",
      rpName: "Rulebox",
      origins: ["https://dash.rulebox.app"],
    });
    expect(parseWebAuthnConfig("localhost", "http://localhost:5173", "Dev")?.origins).toEqual(["http://localhost:5173"]);
    expect(parseWebAuthnConfig("rulebox.app", "http://dash.rulebox.app", undefined)).toBeNull(); // not https
    expect(parseWebAuthnConfig("rulebox.app", "https://evil.test", undefined)).toBeNull(); // not under the RP ID
    expect(parseWebAuthnConfig("rulebox.app", "https://rulebox.app/path", undefined)).toBeNull();
    expect(parseWebAuthnConfig("https://rulebox.app", "https://rulebox.app", undefined)).toBeNull();
    expect(parseWebAuthnConfig(undefined, undefined, undefined)).toBeNull();
  });
});
