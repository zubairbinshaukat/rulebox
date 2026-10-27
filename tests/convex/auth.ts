// Convex Auth in convex-test: an RS256 key pair for the JWTs Convex Auth
// signs (JWT_PRIVATE_KEY / JWKS), generated once per test process.

import rateLimiterTest from "@convex-dev/rate-limiter/test";
import { convexTest } from "convex-test";
import { api } from "../../convex/_generated/api";
import schema from "../../convex/schema";
import { modules } from "../../convex/test.setup";
import type { T } from "./identity";

// Convex Auth reads its keys from process.env (also in convex-test).
declare const process: { env: Record<string, string | undefined> };

function pem(bytes: ArrayBuffer): string {
  let bin = "";
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  const b64 = btoa(bin).replace(/(.{64})/g, "$1\n");
  return `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----`;
}

let ready: Promise<void> | null = null;

export async function ensureAuthEnv(): Promise<void> {
  ready ??= (async () => {
    const pair = (await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const pkcs8 = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
    const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
    process.env.JWT_PRIVATE_KEY = pem(pkcs8);
    process.env.JWKS = JSON.stringify({ keys: [{ use: "sig", ...jwk }] });
    process.env.CONVEX_SITE_URL = "https://test.convex.site";
    // Step-up passkeys (plan 4.16): the dashboard's dev origin.
    process.env.RULEBOX_WEBAUTHN_RP_ID = "localhost";
    process.env.RULEBOX_WEBAUTHN_ORIGINS = "http://localhost:5173";
  })();
  await ready;
}

/** A convex-test instance with the rate-limiter component registered. */
export async function setupAuth(): Promise<T> {
  await ensureAuthEnv();
  const t = convexTest(schema, modules);
  rateLimiterTest.register(t);
  return t;
}

export type SignInResult = { tokens?: { token: string; refreshToken: string } | null };

export async function signIn(
  t: T,
  params: { email: string; password: string; flow: "signIn" | "signUp"; inviteCode?: string },
): Promise<SignInResult> {
  return (await t.action(api.auth.signIn, { provider: "password", params })) as SignInResult;
}

/** The `sub` claim of a Convex Auth JWT: "<userId>|<sessionId>". */
export function subjectOf(token: string): string {
  const payload = token.split(".")[1] ?? "";
  const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
  return (JSON.parse(json) as { sub: string }).sub;
}

/** An accessor authenticated as the session a sign-in created. */
export function asToken(t: T, token: string) {
  return t.withIdentity({ subject: subjectOf(token), issuer: "https://test.convex.site" });
}
