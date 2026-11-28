import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
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

// The first PIN needs the recovery-code secret (setup would otherwise stop after step 1).
beforeEach(() => {
  process.env.RULEBOX_RECOVERY_PEPPER = "passkeys-test-recovery-pepper-0123456789abc";
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.RULEBOX_RECOVERY_PEPPER;
});

/**
 * A member who finished sign-in: the action PIN is required first (Phase 4b),
 * and setting it from the fresh sign-in unlocks the session (fresh), so a
 * passkey can be added right away.
 */
async function withPin(m: Member): Promise<Member> {
  await m.as.action(api.stepUp.setActionPin, { pin: "246813" });
  return m;
}

async function owner(t: T): Promise<Member> {
  return await withPin(await asMember(t, { role: "owner" }));
}

/** Register a passkey for `m` (needs a fresh step-up; the PIN's bootstrap counts). */
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
  test("no passkey before the action PIN (Phase 4b): a passkey is never the first factor", async () => {
    const t = await setupAuth();
    const m = await asMember(t, { role: "viewer" });
    await expect(m.as.action(api.passkeys.beginRegistration, {})).rejects.toMatchObject({ data: { code: "step_up_setup_required", detail: "pin" } });
    // A legacy passkey-only person (registered before Phase 4b) cannot unlock with it until the PIN is set.
    await t.run((ctx) =>
      ctx.db.insert("passkeys", {
        userId: m.userId,
        credentialId: "legacy-cred",
        credentialPublicKey: "x",
        counter: 0,
        transports: [],
        name: "Old",
        aaguid: "",
        deviceType: "multiDevice",
        backedUp: true,
        createdAt: Date.now(),
      }),
    );
    await expect(m.as.action(api.passkeys.beginVerification, {})).rejects.toMatchObject({ data: { code: "step_up_setup_required", detail: "pin" } });
    await expectCode(m.as.mutation(api.stepUp.keepAlive, {}), "step_up_setup_required");
    // ...and the fresh sign-in may set it (bootstrap is for the PIN, passkeys or not).
    await withPin(m);
    await m.as.mutation(api.stepUp.keepAlive, {});
  });

  test("first passkey after the PIN: stored, never returned in full; the session stays unlocked by the PIN", async () => {
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
    expect((await row(t, o.sessionId))?.method).toBe("actionPin");
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
    const other = await withPin(await asMember(t, { role: "admin", orgId: o.orgId }));
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
    const other = await withPin(await asMember(t, { role: "admin", orgId: o.orgId }));
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
  test("removing the passkey this session used ends the unlock; every passkey may go, the PIN never; rename", async () => {
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
    // The required action PIN stays, so the last passkey may go too.
    await o.as.mutation(api.stepUp.removePasskey, { passkeyId: second.passkeyId });
    await o.as.action(api.stepUp.verifyActionPin, { pin: "246813" });
    // The PIN can never be removed, even with a passkey (Phase 4b).
    await register(o);
    await expect(o.as.mutation(api.stepUp.clearActionPin, {})).rejects.toMatchObject({ data: { code: "step_up_last_factor" } });
  });

  test("a forgotten action PIN is changed after a passkey step-up (the passkey is on this device)", async () => {
    const t = await setupAuth();
    const o = await owner(t);
    const { a } = await register(o);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 6 * MINUTE_MS);
    await expectCode(o.as.action(api.stepUp.setActionPin, { pin: "731942" }), "step_up_required");
    await verifyWith(o, a);
    await o.as.action(api.stepUp.setActionPin, { pin: "731942" });
  });

  test("a PIN in its 24 h lockout: a passkey still unlocks, and then the PIN can be changed", async () => {
    const t = await setupAuth();
    const o = await owner(t);
    const { a } = await register(o);
    await t.run(async (ctx) => {
      const f = (await ctx.db.query("stepUpFactors").withIndex("by_user", (q) => q.eq("userId", o.userId)).first())!;
      await ctx.db.patch(f._id, { pinFailuresTotal: 10, pinFailures: 0, pinLockedUntil: Date.now() + 24 * 60 * MINUTE_MS });
    });
    await o.as.mutation(api.stepUp.lock, {});
    await expect(o.as.action(api.stepUp.verifyActionPin, { pin: "246813" })).rejects.toMatchObject({ data: { code: "step_up_locked", detail: "lockout" } });
    await verifyWith(o, a);
    await o.as.mutation(api.stepUp.keepAlive, {});
    await o.as.action(api.stepUp.setActionPin, { pin: "731942" });
    await o.as.action(api.stepUp.verifyActionPin, { pin: "731942" });
  });

  test("passkeys off when not configured (fail closed); the PIN still works", async () => {
    const t = await setupAuth();
    const o = await owner(t);
    const saved = process.env.RULEBOX_WEBAUTHN_ORIGINS;
    process.env.RULEBOX_WEBAUTHN_ORIGINS = "http://evil.test";
    try {
      await expect(o.as.action(api.passkeys.beginRegistration, {})).rejects.toMatchObject({ data: { code: "not_ready", detail: "passkeys not configured" } });
      expect((await o.as.query(api.stepUp.status, {})).passkeysAvailable).toBe(false);
      await o.as.action(api.stepUp.verifyActionPin, { pin: "246813" });
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
