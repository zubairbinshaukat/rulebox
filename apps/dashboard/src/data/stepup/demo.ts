/**
 * Demo step-up hooks (`VITE_DEMO=1`): the rules of `convex/stepUp.ts` and
 * `convex/passkeys.ts` against the in-memory store, so every screen state can
 * be tried without a backend. The demo Owner's action PIN is
 * `DEMO_ACTION_PIN`; the other demo members have none and set one right after
 * signing in. "Forgot PIN" sends no email: the link
 * `/pin-reset#token=DEMO_PIN_RESET_TOKEN` always works for a signed-in member
 * whose password sign-in is under 15 minutes old.
 *
 * Passkeys use the browser's real WebAuthn prompt (relying party = this
 * host), but the demo "server" only checks the challenge and the credential
 * id, never a signature: it is a demo, not a verifier.
 */
import { useCallback } from "react";
import type { StepUpStatus } from "../types";
import { actionPinProblem } from "../../lib/stepup/pin";
import { withStepUp } from "../../lib/stepUpRetry";
import * as validate from "../../lib/validate";
import { DEMO_PIN_RESET_TOKEN } from "../fixtures/seed";
import {
  STEP_UP,
  authorizeFactorChange,
  clearSessionStepUp,
  currentMember,
  db as getDb,
  factorsFor,
  factorsOf,
  fail,
  hasFactor,
  hasPin,
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

type Counters = { pinFailures: number; pinLockedUntil: number; pinLockKind: "backoff" | "lockout" | null };

function clearPinCounters(f: Counters) {
  f.pinFailures = 0;
  f.pinLockedUntil = 0;
  f.pinLockKind = null;
}

/** A new PIN: stored, with its counters and any lockout cleared (`storePinHash`). */
function storePin(memberId: string, pin: string) {
  const f = factorsFor(memberId);
  f.pin = pin;
  clearPinCounters(f);
}

/** Removes the PIN, its counters and every passkey; the unused recovery codes stay (`keepRecovery` replaces them). */
function clearAllFactors(memberId: string, keepRecovery?: string[]) {
  const f = factorsFor(memberId);
  f.pin = undefined;
  clearPinCounters(f);
  f.passkeys = [];
  if (keepRecovery) f.recoveryCodes = keepRecovery;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function newRecoveryCodes(): string[] {
  const bytes = new Uint8Array(80);
  crypto.getRandomValues(bytes);
  return Array.from({ length: 10 }, (_, i) => {
    let s = "";
    for (let j = 0; j < 8; j++) s += CROCKFORD[bytes[i * 8 + j]! % 32];
    return `${s.slice(0, 4)}-${s.slice(4)}`;
  });
}

/** Both the recovery reset and the emailed link need a password sign-in under 15 minutes old. */
function requireFreshSignIn() {
  const s = session();
  if (!s || Date.now() - (s.createdAt ?? 0) > STEP_UP.bootstrapMs) fail("step_up_setup_required", { detail: "reauthenticate" });
  return s;
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
      const locked = pinSet && f.pinLockedUntil > now;
      const longLockout = locked && f.pinLockKind === "lockout";
      return {
        pin: {
          set: pinSet,
          lockedUntil: locked ? f.pinLockedUntil : null,
          lockKind: locked ? f.pinLockKind : null,
          failedSinceUnlock: pinSet ? f.pinFailures : 0,
          attemptsBeforeLockout: pinSet && !longLockout ? Math.max(0, STEP_UP.pinHardLimit - f.pinFailures) : STEP_UP.pinHardLimit,
          recoveryCodesLeft: f?.recoveryCodes.length ?? 0,
          resetByEmail: true,
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
        bootstrapUntil: pinSet ? null : (s?.createdAt ?? 0) + STEP_UP.bootstrapMs,
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
      if (f.pinLockedUntil > now) {
        fail("step_up_locked", { retryAfterMs: f.pinLockedUntil - now, detail: f.pinLockKind === "lockout" ? "lockout" : undefined });
      }
      // A lockout that has ended: the count starts over.
      if (f.pinLockKind === "lockout") clearPinCounters(f);
      // Reserved before the check, like the backend: an attempt counts until it succeeds.
      f.pinFailures++;
      const right = pin === f.pin;
      const locksOut = !right && f.pinFailures >= STEP_UP.pinHardLimit;
      const next = locksOut ? STEP_UP.pinLockoutMs : pinBackoffMs(f.pinFailures);
      f.pinLockedUntil = next > 0 ? now + next : 0;
      f.pinLockKind = locksOut ? "lockout" : next > 0 ? "backoff" : null;
      if (right) {
        clearPinCounters(f);
        markVerified("actionPin", now);
        return verified(now);
      }
      touch();
      if (locksOut) fail("step_up_locked", { retryAfterMs: STEP_UP.pinLockoutMs, detail: "lockout" });
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
      storePin(m._id, pin);
      if (mode === "bootstrap") markVerified("actionPin", now);
      touch();
    }), []);
  },

  useGenerateRecoveryCodes() {
    return useCallback(
      () =>
        runMutation(
          "viewer",
          ({ me: m, audit }) => {
            if (!hasPin(m._id)) fail("step_up_setup_required", { detail: "pin" });
            const codes = newRecoveryCodes();
            factorsFor(m._id).recoveryCodes = codes;
            audit({ action: "member.recoveryCodesGenerated", targetLabel: m.email, summary: "New recovery codes for the action PIN." });
            return codes;
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
      // A passkey can only be added after the PIN (Phase 4b).
      if (!hasPin(m._id)) fail("step_up_setup_required", { detail: "pin" });
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
      const now = Date.now();
      const passkeyId = newId("pk");
      f.passkeys.push({ _id: passkeyId, credentialId: id, name: clean, createdAt: now, synced: false, suspended: false });
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
    return useCallback(async ({ code, newPin }) => {
      await sleep(latency());
      const m = me();
      const s = requireFreshSignIn();
      const problem = actionPinProblem(newPin);
      if (problem !== null) fail("invalid_argument", { field: "newPin", detail: problem });
      const f = factorsFor(m._id);
      if (f.recoveryCodes.length === 0) fail("not_ready", { detail: "no recovery codes" });
      const i = f.recoveryCodes.indexOf(validate.normalizeRecoveryCode(code));
      if (i < 0) fail("step_up_invalid");
      // The PIN is set in the same step; the unused codes stay, the passkeys go, this session is unlocked.
      clearAllFactors(m._id, f.recoveryCodes.filter((_, j) => j !== i));
      storePin(m._id, newPin);
      setSession({ ...s, stepUp: undefined });
      markVerified("actionPin", Date.now());
    }, []);
  },

  useRequestPinReset() {
    // The demo sends no email: the link is `/pin-reset#token=…` (see the hint on the lock screen).
    return useCallback(async () => {
      await sleep(latency());
      me();
    }, []);
  },

  useRedeemPinReset() {
    return useCallback(async ({ token, newPin }) => {
      await sleep(latency());
      const m = me();
      requireFreshSignIn();
      const problem = actionPinProblem(newPin);
      if (problem !== null) fail("invalid_argument", { field: "newPin", detail: problem });
      if (token !== DEMO_PIN_RESET_TOKEN) fail("step_up_invalid");
      storePin(m._id, newPin);
      markVerified("actionPin", Date.now());
      touch();
    }, []);
  },

  useChangePassword() {
    return useCallback(
      ({ currentPassword, newPassword }) =>
        runMutation(
          "viewer",
          ({ me: m, audit }) => {
            const row = getDb().members.find((x) => x._id === m._id);
            if (!row || row.password !== currentPassword) fail("invalid_argument", { field: "currentPassword" });
            if (validate.memberPassword(newPassword)) fail("invalid_argument", { field: "password" });
            if (newPassword === currentPassword) fail("invalid_argument", { field: "newPassword", detail: "same as current" });
            row.password = newPassword;
            audit({ action: "member.passwordChanged", targetLabel: m.email, summary: "Password changed." });
          },
          "fresh",
        ),
      [],
    );
  },
};

/** Resolved through the `@rulebox/stepup-impl` alias in demo builds. */
export const stepUpApi = demoStepUpApi;
