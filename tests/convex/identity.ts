// Test-only helpers for convex-test. Kept OUTSIDE convex/ so the Convex
// bundler never pushes them (plan Step 2).
//
// Convex Auth reads the JWT `subject` as "<userId>|<sessionId>"
// (@convex-dev/auth 0.0.96: getAuthUserId / getAuthSessionId split on "|",
// TOKEN_SUB_CLAIM_DIVIDER), so an identity with that subject is a signed-in
// session for every function under test.

import type { TestConvex } from "convex-test";
import { expect } from "vitest";
import type { Id } from "../../convex/_generated/dataModel";
import type schema from "../../convex/schema";
import { newOrgPlanFields } from "../../convex/lib/plans";
import { DEFAULT_ORG_SETTINGS } from "../../convex/lib/validators";

export type T = TestConvex<typeof schema>;
export type Role = "owner" | "admin" | "viewer";

/**
 * An organization with its counter and secret rows. `plan` adds an `orgPlans`
 * row with that plan's default limits; without it the organization has none
 * and gets the deployment default (`custom`, no limits, in tests).
 */
export async function makeOrg(
  t: T,
  name = "Acme",
  opts: { plan?: "free" | "team" | "custom" } = {},
): Promise<Id<"organizations">> {
  return await t.run(async (ctx) => {
    const orgId = await ctx.db.insert("organizations", {
      name,
      settings: DEFAULT_ORG_SETTINGS,
      revision: 0,
      createdAt: Date.now(),
    });
    await ctx.db.insert("orgStats", { orgId, deviceCount: 0, groupCount: 0, memberCount: 0 });
    await ctx.db.insert("orgSecrets", { orgId });
    if (opts.plan !== undefined) {
      await ctx.db.insert("orgPlans", { orgId, ...newOrgPlanFields(null, opts.plan, Date.now(), "test") });
    }
    return orgId;
  });
}

export type Member = {
  as: ReturnType<T["withIdentity"]>;
  userId: Id<"users">;
  sessionId: Id<"authSessions">;
  memberId: Id<"members">;
  orgId: Id<"organizations">;
  email: string;
};

let counter = 0;

/**
 * Inserts `users`, `authSessions`, `members` (and `mfaSessions` when `mfa`),
 * returns the identity-bound accessor plus the ids. Pass `userId` to add a
 * second membership for the same person (a new session is created).
 */
export async function asMember(
  t: T,
  opts: {
    role: Role;
    mfa?: boolean;
    orgId?: Id<"organizations">;
    status?: "active" | "disabled";
    userId?: Id<"users">;
    email?: string;
  },
): Promise<Member> {
  const orgId = opts.orgId ?? (await makeOrg(t));
  const email = opts.email ?? `member${++counter}@acme.test`;
  const ids = await t.run(async (ctx) => {
    const userId = opts.userId ?? (await ctx.db.insert("users", { email }));
    const sessionId = await ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 3_600_000,
    });
    const memberId = await ctx.db.insert("members", {
      orgId,
      userId,
      email,
      role: opts.role,
      status: opts.status ?? "active",
      createdAt: Date.now(),
      revision: 0,
    });
    if (opts.mfa === true) {
      await ctx.db.insert("mfaSessions", { sessionId, userId, verifiedAt: Date.now() });
    }
    return { userId, sessionId, memberId };
  });
  return { ...ids, orgId, email, as: identityFor(t, ids.userId, ids.sessionId) };
}

/** A signed-in session for a user with no member row (or any user). */
export async function asUser(t: T, email = `user${++counter}@acme.test`) {
  const ids = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { email });
    const sessionId = await ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 3_600_000,
    });
    return { userId, sessionId };
  });
  return { ...ids, email, as: identityFor(t, ids.userId, ids.sessionId) };
}

export function identityFor(t: T, userId: Id<"users">, sessionId: Id<"authSessions">) {
  return t.withIdentity({ subject: `${userId}|${sessionId}`, issuer: "https://convex.test" });
}

/** Asserts that `promise` rejects with a ConvexError whose `data.code` is `code`. */
export async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  let error: unknown = null;
  try {
    await promise;
  } catch (e) {
    error = e;
  }
  expect(error, `expected ConvexError ${code}`).not.toBeNull();
  expect(codeOf(error)).toBe(code);
}

export function codeOf(error: unknown): string | null {
  if (error && typeof error === "object" && "data" in error) {
    const data = (error as { data: unknown }).data;
    if (data && typeof data === "object" && "code" in data) {
      return String((data as { code: unknown }).code);
    }
    if (typeof data === "string") {
      try {
        const parsed: unknown = JSON.parse(data);
        if (parsed && typeof parsed === "object" && "code" in parsed) {
          return String((parsed as { code: unknown }).code);
        }
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Field names that must never appear in a value returned to a client (plan 4.7). */
export const FORBIDDEN_KEYS = [
  "secretHash",
  "previousSecretHash",
  "tokenHash",
  "passwordHash",
  "exitPinHash",
  "pinHash",
  "totpSecret",
  "totpPending",
  "recoveryHashes",
  "secret",
  "hardwareIdHash",
  // Step-up (plan 4.16)
  "actionPinHash",
  "credentialPublicKey",
  "credentialId",
  "challengeHash",
  "webauthnUserId",
];

/**
 * Give a member's session a step-up state (plan 4.16): a factor (an action
 * PIN hash, not a real one unless `pinHash` is given) and a step-up row
 * verified `verifiedAgoMs` ago, last active `activeAgoMs` ago. `none` adds
 * only the factor.
 */
export async function giveStepUp(
  t: T,
  m: { userId: Id<"users">; sessionId: Id<"authSessions"> },
  opts: { verifiedAgoMs?: number; activeAgoMs?: number; none?: true; pinHash?: string } = {},
): Promise<void> {
  await t.run(async (ctx) => {
    const now = Date.now();
    const existing = await ctx.db.query("stepUpFactors").withIndex("by_user", (q) => q.eq("userId", m.userId)).first();
    if (existing === null) {
      await ctx.db.insert("stepUpFactors", {
        userId: m.userId,
        actionPinHash: opts.pinHash ?? "not-a-real-hash",
        actionPinSetAt: now,
        pinFailures: 0,
        pinFailuresTotal: 0,
        pinLockedUntil: 0,
      });
    }
    if (opts.none === true) return;
    const verifiedAt = now - (opts.verifiedAgoMs ?? 0);
    await ctx.db.insert("stepUpSessions", {
      sessionId: m.sessionId,
      userId: m.userId,
      verifiedAt,
      lastActiveAt: now - (opts.activeAgoMs ?? opts.verifiedAgoMs ?? 0),
      method: "actionPin",
    });
  });
}

/** Recursively collects every object key in `value`. */
export function allKeys(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) allKeys(item, out);
  } else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      allKeys(v, out);
    }
  }
  return out;
}

/** Asserts no forbidden key and none of `secrets` (exact strings) appear anywhere in `value`. */
export function expectNoSecrets(value: unknown, secrets: string[] = []): void {
  const keys = allKeys(value);
  for (const k of FORBIDDEN_KEYS) expect(keys.has(k), `forbidden key ${k}`).toBe(false);
  const text = JSON.stringify(value ?? null);
  expect(text).not.toMatch(/\$argon2|\$scrypt/i);
  for (const s of secrets) {
    if (s.length > 0) expect(text.includes(s), "a stored secret leaked").toBe(false);
  }
}
