"use node";

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { decodeClientDataJSON, isoBase64URL } from "@simplewebauthn/server/helpers";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { constantTimeEqual, randomBytes, sha256HexSync } from "./lib/crypto";
import { fail } from "./lib/errors";
import { memberAction } from "./lib/functions";
import { MAX_WEBAUTHN_RESPONSE_BYTES, STEP_UP_CHALLENGE_TTL_MS, STEP_UP_FRESH_MS } from "./lib/limits";
import { consumeQuietly } from "./lib/rateLimits";
import { webauthnConfig, type WebAuthnConfig } from "./lib/webauthnConfig";

// Passkeys for step-up (plan 4.16, Step 5a): WebAuthn ceremonies verified on
// the server with @simplewebauthn/server in a Node action. Convex Auth has no
// WebAuthn support, so nothing here touches sign-in: a passkey only confirms
// dashboard actions of an already signed-in session.
//
// - Challenges: 32 bytes from the CSPRNG of this action, stored as SHA-256,
//   single use (deleted when a finish call presents them), 2 minutes, bound to
//   the session and the purpose.
// - `userVerification: "required"` in options AND in verification;
//   attestation "none" (no attestation statements are trusted or stored).
// - Origins and RP ID come from configuration (lib/webauthnConfig.ts).
// - Clone detection: the signature counter must go up when either side is
//   non-zero; checked AFTER the signature verified, so a forged response
//   cannot suspend someone's passkey.
// - Every failure answers `step_up_invalid` with no detail from the library
//   (its messages contain the challenge and origins).

/** EdDSA, ES256, RS256: fixed, so the library does not probe the runtime for post-quantum algorithms. */
const ALGORITHMS = [-8, -7, -257];

const TRANSPORTS: readonly string[] = ["ble", "cable", "hybrid", "internal", "nfc", "smart-card", "usb"];

function config(): WebAuthnConfig {
  const c = webauthnConfig();
  if (c === null) fail("not_ready", { detail: "passkeys not configured" });
  return c;
}

function newChallenge(ctx: { runAction: unknown }): { challenge: string; hash: string } {
  const challenge = isoBase64URL.fromBuffer(randomBytes(ctx, 32));
  return { challenge, hash: sha256HexSync(challenge) };
}

type Parsed<T> = { response: T; challengeHash: string };

/** Parse a credential JSON from the browser; only shape checks (the library verifies). */
function parseResponse<T extends { id: string; rawId: string; response: { clientDataJSON: string } }>(
  json: string,
  kind: "register" | "verify",
): Parsed<T> {
  if (json.length > MAX_WEBAUTHN_RESPONSE_BYTES) fail("step_up_invalid");
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    fail("step_up_invalid");
  }
  const r = value as { id?: unknown; rawId?: unknown; type?: unknown; response?: Record<string, unknown> };
  const ok =
    r !== null &&
    typeof r === "object" &&
    typeof r.id === "string" &&
    r.id === r.rawId &&
    isoBase64URL.isBase64URL(r.id) &&
    r.type === "public-key" &&
    typeof r.response === "object" &&
    r.response !== null &&
    typeof r.response.clientDataJSON === "string" &&
    (kind === "register"
      ? typeof r.response.attestationObject === "string"
      : typeof r.response.authenticatorData === "string" && typeof r.response.signature === "string");
  if (!ok) fail("step_up_invalid");
  let challenge: string;
  try {
    challenge = decodeClientDataJSON(r.response!.clientDataJSON as string).challenge;
  } catch {
    fail("step_up_invalid");
  }
  if (typeof challenge !== "string" || challenge.length === 0 || challenge.length > 128) fail("step_up_invalid");
  return { response: value as T, challengeHash: sha256HexSync(challenge) };
}

/** The library's challenge check: our stored hash, compared in constant time. */
function challengeMatcher(hash: string) {
  return (challenge: string) => constantTimeEqual(sha256HexSync(challenge), hash);
}

async function failed(ctx: Parameters<typeof consumeQuietly>[0]): Promise<never> {
  await consumeQuietly(ctx, "stepUpFailuresGlobal");
  fail("step_up_invalid");
}

const optionsResult = v.object({ optionsJson: v.string(), expiresAt: v.number() });

// ---------------------------------------------------------------- registration

/**
 * Start adding a passkey: the first factor right after sign-in (bootstrap), or
 * an extra one after a fresh step-up. Returns the options for
 * `navigator.credentials.create` as JSON (pass to @simplewebauthn/browser
 * `startRegistration({ optionsJSON })`).
 */
export const beginRegistration = memberAction("viewer", { stepUp: "none" })({
  args: {},
  returns: optionsResult,
  handler: async (ctx) => {
    const c = config();
    const now = Date.now();
    const { challenge, hash } = newChallenge(ctx);
    const prepared = await ctx.runMutation(internal.stepUp.createChallenge, {
      userId: ctx.userId,
      sessionId: ctx.sessionId,
      purpose: "register",
      challengeHash: hash,
      webauthnUserIdCandidate: isoBase64URL.fromBuffer(randomBytes(ctx, 16)),
      now,
    });
    const options = await generateRegistrationOptions({
      rpName: c.rpName,
      rpID: c.rpId,
      userName: ctx.member.email,
      userDisplayName: ctx.member.email,
      userID: isoBase64URL.toBuffer(prepared.webauthnUserId),
      challenge: isoBase64URL.toBuffer(challenge),
      timeout: STEP_UP_CHALLENGE_TTL_MS,
      attestationType: "none",
      excludeCredentials: prepared.credentials.map((k) => ({ id: k.id, transports: k.transports })),
      authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
      supportedAlgorithmIDs: ALGORITHMS,
    });
    return { optionsJson: JSON.stringify(options), expiresAt: now + STEP_UP_CHALLENGE_TTL_MS };
  },
});

/** Finish adding a passkey with the browser's `PublicKeyCredential` JSON. */
export const finishRegistration = memberAction("viewer", { stepUp: "none" })({
  args: { responseJson: v.string(), name: v.optional(v.string()) },
  returns: v.object({ passkeyId: v.id("passkeys") }),
  handler: async (ctx, args): Promise<{ passkeyId: Id<"passkeys"> }> => {
    const c = config();
    const { response, challengeHash } = parseResponse<RegistrationResponseJSON>(args.responseJson, "register");
    const consumed = await ctx.runMutation(internal.stepUp.consumeChallenge, {
      userId: ctx.userId,
      sessionId: ctx.sessionId,
      purpose: "register",
      challengeHash,
      now: Date.now(),
    });
    if (!consumed.ok) return await failed(ctx);
    let info;
    try {
      const result = await verifyRegistrationResponse({
        response,
        expectedChallenge: challengeMatcher(challengeHash),
        expectedOrigin: c.origins,
        expectedRPID: c.rpId,
        expectedType: "webauthn.create",
        requireUserPresence: true,
        requireUserVerification: true,
        supportedAlgorithmIDs: ALGORITHMS,
      });
      if (!result.verified) return await failed(ctx);
      info = result.registrationInfo;
    } catch {
      return await failed(ctx);
    }
    const transports = (response.response.transports ?? []).filter((t) => TRANSPORTS.includes(t)).slice(0, 8);
    return await ctx.runMutation(internal.stepUp.storePasskey, {
      userId: ctx.userId,
      sessionId: ctx.sessionId,
      orgId: ctx.orgId,
      actor: ctx.actor,
      credentialId: info.credential.id,
      credentialPublicKey: isoBase64URL.fromBuffer(info.credential.publicKey),
      counter: info.credential.counter,
      transports,
      name: args.name ?? "Passkey",
      aaguid: info.aaguid,
      deviceType: info.credentialDeviceType,
      backedUp: info.credentialBackedUp,
    });
  },
});

// ---------------------------------------------------------------- verification

/** Start a step-up with a passkey: options for `navigator.credentials.get` as JSON. */
export const beginVerification = memberAction("viewer", { stepUp: "none" })({
  args: {},
  returns: optionsResult,
  handler: async (ctx) => {
    const c = config();
    const now = Date.now();
    const { challenge, hash } = newChallenge(ctx);
    const prepared = await ctx.runMutation(internal.stepUp.createChallenge, {
      userId: ctx.userId,
      sessionId: ctx.sessionId,
      purpose: "verify",
      challengeHash: hash,
      webauthnUserIdCandidate: "",
      now,
    });
    const options = await generateAuthenticationOptions({
      rpID: c.rpId,
      allowCredentials: prepared.credentials.map((k) => ({ id: k.id, transports: k.transports })),
      challenge: isoBase64URL.toBuffer(challenge),
      timeout: STEP_UP_CHALLENGE_TTL_MS,
      userVerification: "required",
    });
    return { optionsJson: JSON.stringify(options), expiresAt: now + STEP_UP_CHALLENGE_TTL_MS };
  },
});

/** Finish a passkey step-up: unlocks this session and makes it fresh. */
export const finishVerification = memberAction("viewer", { stepUp: "none" })({
  args: { responseJson: v.string() },
  returns: v.object({ verifiedAt: v.number(), freshUntil: v.number(), serverNow: v.number() }),
  handler: async (ctx, args) => {
    const c = config();
    const { response, challengeHash } = parseResponse<AuthenticationResponseJSON>(args.responseJson, "verify");
    const consumed = await ctx.runMutation(internal.stepUp.consumeChallenge, {
      userId: ctx.userId,
      sessionId: ctx.sessionId,
      purpose: "verify",
      challengeHash,
      credentialId: response.id,
      now: Date.now(),
    });
    if (!consumed.ok || consumed.passkey === null) return await failed(ctx);
    const key = consumed.passkey;
    let newCounter: number;
    try {
      const result = await verifyAuthenticationResponse({
        response,
        expectedChallenge: challengeMatcher(challengeHash),
        expectedOrigin: c.origins,
        expectedRPID: c.rpId,
        expectedType: "webauthn.get",
        // Counter 0 here: the clone check runs below, only after the signature verified.
        credential: {
          id: key.credentialId,
          publicKey: isoBase64URL.toBuffer(key.credentialPublicKey),
          counter: 0,
          transports: key.transports,
        },
        requireUserVerification: true,
      });
      if (!result.verified) return await failed(ctx);
      newCounter = result.authenticationInfo.newCounter;
    } catch {
      return await failed(ctx);
    }
    if ((key.counter > 0 || newCounter > 0) && newCounter <= key.counter) {
      await ctx.runMutation(internal.stepUp.flagClone, {
        userId: ctx.userId,
        passkeyId: key._id,
        orgId: ctx.orgId,
        actor: ctx.actor,
      });
      return await failed(ctx);
    }
    const now = Date.now();
    const ok = await ctx.runMutation(internal.stepUp.finishPasskeySuccess, {
      userId: ctx.userId,
      sessionId: ctx.sessionId,
      passkeyId: key._id,
      newCounter,
      now,
    });
    if (!ok) return await failed(ctx);
    return { verifiedAt: now, freshUntil: now + STEP_UP_FRESH_MS, serverNow: now };
  },
});
