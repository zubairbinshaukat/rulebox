/**
 * Demo step-up hooks (`VITE_DEMO=1`): the rules of `convex/stepUp.ts` and
 * `convex/passkeys.ts` against the in-memory store, so every screen state can
 * be tried without a backend. The demo Owner's action PIN is
 * `DEMO_ACTION_PIN`.
 *
 * Passkeys use the browser's real WebAuthn prompt (relying party = this
 * host), but the demo "server" only checks the challenge and the credential
 * id, never a signature: it is a demo, not a verifier.
 */
import { useCallback } from "react";
import type { StepUpStatus } from "../types";
import { actionPinProblem } from "../../lib/stepup/pin";
import { withStepUp } from "../../lib/stepUpRetry";
import {
  STEP_UP,
  authorizeFactorChange,
  clearSessionStepUp,
  currentMember,
  factorsFor,
  factorsOf,
  fail,
  hasFactor,
  latency,
  markVerified,
  newId,
  runMutation,
  session,
  setSession,
  sleep,
  touch,
  useDemoQuery,
} from "../demo/store";
import type { StepUpApi } from "./api";

function me() {
  const m = currentMember();
  if (!m) fail("unauthenticated");
  if (m.status === "disabled") fail("forbidden");
  return m;
}

function pinBackoffMs(failures: number): number {
  if (failures <= STEP_UP.pinFreeFailures) return 0;
  const n = failures - STEP_UP.pinFreeFailures - 1;
  return Math.min(STEP_UP.pinBackoffMaxMs, STEP_UP.pinBackoffBaseMs * 2 ** Math.min(n, 20));
}

function base64Url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomB64(len: number): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

/** One outstanding challenge per purpose (the demo has one session per tab). */
const challenges = new Map<"register" | "verify", { challenge: string; expiresAt: number }>();

function newChallenge(purpose: "register" | "verify"): { challenge: string; expiresAt: number } {
  const c = { challenge: randomB64(32), expiresAt: Date.now() + 2 * 60_000 };
  challenges.set(purpose, c);
  return c;
}

/** The credential JSON's id and challenge; the challenge is single use. */
function consume(purpose: "register" | "verify", responseJson: string): { id: string } {
  const stored = challenges.get(purpose);
  challenges.delete(purpose);
  let parsed: { id?: unknown; response?: { clientDataJSON?: unknown } };
  try {
    parsed = JSON.parse(responseJson) as typeof parsed;
  } catch {
    fail("step_up_invalid");
  }
  const cd = parsed.response?.clientDataJSON;
  if (typeof parsed.id !== "string" || typeof cd !== "string" || !stored || stored.expiresAt <= Date.now()) fail("step_up_invalid");
  let challenge: unknown;
  try {
    challenge = (JSON.parse(atob(cd.replace(/-/g, "+").replace(/_/g, "/"))) as { challenge?: unknown }).challenge;
  } catch {
    fail("step_up_invalid");
  }
  if (challenge !== stored.challenge) fail("step_up_invalid");
  return { id: parsed.id };
}

function clearAllFactors(memberId: string) {
  const f = factorsFor(memberId);
  f.pin = undefined;
  f.pinFailures = 0;
  f.pinFailuresTotal = 0;
  f.pinLockedUntil = 0;
  f.passkeys = [];
}

const verified = (now: number) => ({ verifiedAt: now, freshUntil: now + STEP_UP.freshMs, serverNow: now });

export const demoStepUpApi: StepUpApi = {
  useStepUpStatus() {
    return useDemoQuery("stepUp:status", (): StepUpStatus => {
      const m = me();
      const f = factorsOf(m._id);
      const s = session();
      const pinSet = f?.pin !== undefined;
      const now = Date.now();
      return {
        actionPin: {
          set: pinSet,
          lockedUntil: pinSet && f.pinLockedUntil > now ? f.pinLockedUntil : null,
          disabled: pinSet && f.pinFailuresTotal >= STEP_UP.pinHardLimit,
          attemptsBeforeDisable: pinSet ? Math.max(0, STEP_UP.pinHardLimit - f.pinFailuresTotal) : STEP_UP.pinHardLimit,
        },
        passkeys: (f?.passkeys ?? []).map((k) => ({
          _id: k._id,
          name: k.name,
          createdAt: k.createdAt,
          lastUsedAt: k.lastUsedAt ?? null,
          synced: k.synced,
          suspended: k.suspended,
        })),
        passkeysAvailable: true,
        session: {
          verifiedAt: s?.stepUp?.verifiedAt ?? null,
          lastActiveAt: s?.stepUp?.lastActiveAt ?? null,
          method: s?.stepUp?.method ?? null,
        },
        bootstrapUntil: hasFactor(m._id) ? null : (s?.createdAt ?? 0) + STEP_UP.bootstrapMs,
        policy: { idleMs: STEP_UP.idleMs, keepAliveMs: STEP_UP.keepAliveMs, freshMs: STEP_UP.freshMs, maxAgeMs: STEP_UP.maxAgeMs },
      };
    });
  },

  useVerifyActionPin() {
    return useCallback(async ({ pin }) => {
      await sleep(latency());
      const m = me();
      const f = factorsOf(m._id);
      const now = Date.now();
      if (!f || f.pin === undefined) fail("not_ready", { detail: "no action PIN" });
      if (f.pinFailuresTotal >= STEP_UP.pinHardLimit) fail("step_up_locked", { detail: "disabled" });
      if (f.pinLockedUntil > now) fail("step_up_locked", { retryAfterMs: f.pinLockedUntil - now });
      // Reserved before the check, like the backend: an attempt counts until it succeeds.
      f.pinFailures++;
      f.pinFailuresTotal++;
      const next = pinBackoffMs(f.pinFailures);
      f.pinLockedUntil = next > 0 ? now + next : 0;
      if (pin === f.pin) {
        f.pinFailures = 0;
        f.pinFailuresTotal = 0;
        f.pinLockedUntil = 0;
        markVerified("actionPin", now);
        return verified(now);
      }
      touch();
      if (f.pinFailuresTotal >= STEP_UP.pinHardLimit) fail("step_up_locked", { detail: "disabled" });
      fail("step_up_invalid", { retryAfterMs: next > 0 ? next : undefined });
    }, []);
  },

  useSetActionPin() {
    return useCallback(({ pin }) => withStepUp(async () => {
      await sleep(latency());
      const problem = actionPinProblem(pin);
      if (problem !== null) fail("invalid_argument", { field: "pin", detail: problem });
      const m = me();
      const now = Date.now();
      const mode = authorizeFactorChange(m, now);
      const f = factorsFor(m._id);
      Object.assign(f, { pin, pinFailures: 0, pinFailuresTotal: 0, pinLockedUntil: 0 });
      if (mode === "bootstrap") markVerified("actionPin", now);
      touch();
    }), []);
  },

  useClearActionPin() {
    return useCallback(
      () =>
        runMutation(
          "viewer",
          ({ me: m }) => {
            const f = factorsOf(m._id);
            if (!f || f.pin === undefined) return;
            if (!f.passkeys.some((k) => !k.suspended)) fail("step_up_last_factor");
            Object.assign(f, { pin: undefined, pinFailures: 0, pinFailuresTotal: 0, pinLockedUntil: 0 });
            if (session()?.stepUp?.method === "actionPin") clearSessionStepUp();
          },
          "fresh",
        ),
      [],
    );
  },

  useBeginPasskeyVerification() {
    return useCallback(async () => {
      await sleep(latency());
      const m = me();
      const usable = (factorsOf(m._id)?.passkeys ?? []).filter((k) => !k.suspended);
      if (usable.length === 0) fail("not_ready", { detail: "no passkey" });
      const c = newChallenge("verify");
      const options = {
        challenge: c.challenge,
        rpId: location.hostname,
        allowCredentials: usable.map((k) => ({ id: k.credentialId, type: "public-key" })),
        timeout: 120_000,
        userVerification: "required",
      };
      return { optionsJson: JSON.stringify(options), expiresAt: c.expiresAt };
    }, []);
  },

  useFinishPasskeyVerification() {
    return useCallback(async ({ responseJson }) => {
      await sleep(latency());
      const m = me();
      const { id } = consume("verify", responseJson);
      const key = factorsOf(m._id)?.passkeys.find((k) => k.credentialId === id && !k.suspended);
      if (!key) fail("step_up_invalid");
      const now = Date.now();
      key.lastUsedAt = now;
      markVerified("passkey", now, key._id);
      return verified(now);
    }, []);
  },

  useBeginPasskeyRegistration() {
    return useCallback(() => withStepUp(async () => {
      await sleep(latency());
      const m = me();
      authorizeFactorChange(m, Date.now());
      const keys = factorsOf(m._id)?.passkeys ?? [];
      if (keys.length >= STEP_UP.maxPasskeys) fail("conflict", { detail: "passkey limit" });
      const c = newChallenge("register");
      const options = {
        challenge: c.challenge,
        rp: { name: "Rulebox (demo)", id: location.hostname },
        user: { id: randomB64(16), name: m.email, displayName: m.email },
        pubKeyCredParams: [-8, -7, -257].map((alg) => ({ type: "public-key", alg })),
        timeout: 120_000,
        attestation: "none",
        excludeCredentials: keys.map((k) => ({ id: k.credentialId, type: "public-key" })),
        authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
      };
      return { optionsJson: JSON.stringify(options), expiresAt: c.expiresAt };
    }), []);
  },

  useFinishPasskeyRegistration() {
    return useCallback(async ({ responseJson, name }) => {
      await sleep(latency());
      const m = me();
      const { id } = consume("register", responseJson);
      const clean = (name ?? "Passkey").trim();
      if (!clean || clean.length > 64) fail("invalid_argument", { field: "name" });
      const f = factorsFor(m._id);
      if (f.passkeys.some((k) => k.credentialId === id)) fail("conflict", { detail: "passkey exists" });
      if (f.passkeys.length >= STEP_UP.maxPasskeys) fail("conflict", { detail: "passkey limit" });
      const first = !hasFactor(m._id);
      const now = Date.now();
      const passkeyId = newId("pk");
      f.passkeys.push({ _id: passkeyId, credentialId: id, name: clean, createdAt: now, synced: false, suspended: false });
      if (first) markVerified("passkey", now, passkeyId);
      touch();
      return { passkeyId };
    }, []);
  },

  useRenamePasskey() {
    return useCallback(
      ({ passkeyId, name }) =>
        runMutation("viewer", ({ me: m }) => {
          const key = factorsOf(m._id)?.passkeys.find((k) => k._id === passkeyId);
          if (!key) fail("not_found");
          const clean = name.trim();
          if (!clean || clean.length > 64) fail("invalid_argument", { field: "name" });
          key.name = clean;
        }),
      [],
    );
  },

  useRemovePasskey() {
    return useCallback(
      ({ passkeyId }) =>
        runMutation(
          "viewer",
          ({ me: m }) => {
            const f = factorsOf(m._id);
            const key = f?.passkeys.find((k) => k._id === passkeyId);
            if (!f || !key) fail("not_found");
            const others = f.passkeys.filter((k) => k._id !== passkeyId && !k.suspended);
            const pinUsable = f.pin !== undefined && f.pinFailuresTotal < STEP_UP.pinHardLimit;
            if (!pinUsable && others.length === 0) fail("step_up_last_factor");
            f.passkeys = f.passkeys.filter((k) => k._id !== passkeyId);
            if (session()?.stepUp?.passkeyId === passkeyId) clearSessionStepUp();
          },
          "fresh",
        ),
      [],
    );
  },

  useKeepAlive() {
    // No confirm dialog for the keep-alive: the shell locks instead (`lib/stepup/controller.ts`).
    return useCallback(() => runMutation("viewer", () => ({ serverNow: Date.now() }), "unlocked", false), []);
  },

  useLockSession() {
    return useCallback(() => runMutation("viewer", () => clearSessionStepUp(), "none"), []);
  },

  useResetMemberStepUp() {
    return useCallback(
      ({ memberId }) =>
        runMutation(
          "owner",
          ({ db, me: m, audit }) => {
            const target = db.members.find((x) => x._id === memberId);
            if (!target) fail("not_found");
            if (target._id === m._id) fail("forbidden", { detail: "use a recovery code" });
            if (!hasFactor(target._id)) return;
            clearAllFactors(target._id);
            audit({ action: "member.stepUpReset", targetLabel: target.email, summary: "Action PIN and passkeys reset." });
          },
          "fresh",
        ),
      [],
    );
  },

  useResetStepUpWithRecoveryCode() {
    return useCallback(async ({ code }) => {
      await sleep(latency());
      const m = me();
      const s = session();
      if (!s || Date.now() - (s.createdAt ?? 0) > STEP_UP.bootstrapMs || !s.mfaVerified) {
        fail("step_up_setup_required", { detail: "reauthenticate" });
      }
      if (!m.mfa.enrolled) fail("not_ready", { detail: "no recovery codes" });
      const norm = code.trim().toUpperCase();
      const i = m.mfa.recoveryCodes.indexOf(norm);
      if (i < 0) fail("mfa_invalid_code");
      m.mfa.recoveryCodes.splice(i, 1);
      clearAllFactors(m._id);
      setSession({ ...s, stepUp: undefined });
    }, []);
  },
};

/** Resolved through the `@rulebox/stepup-impl` alias in demo builds. */
export const stepUpApi = demoStepUpApi;
