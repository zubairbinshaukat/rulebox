import { afterEach, describe, expect, test, vi } from "vitest";
import { setupAuth, signIn, asToken } from "../tests/convex/auth";
import { asMember, expectCode, makeOrg, type T } from "../tests/convex/identity";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  DAY_MS,
  HOUR_MS,
  JWT_DURATION_MS,
  MINUTE_MS,
  SESSION_INACTIVE_MS,
  SESSION_TOTAL_MS,
} from "./lib/limits";

// A10 (owner Q7): 60-minute JWT, instant revocation, and a daily job that
// reads only dead rows through index bounds.

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Insert rows "at" a past time: convex-test stamps _creationTime from
 * Date.now() but keeps it strictly increasing, so rows are created in
 * chronological order.
 */
async function at<R>(when: number, f: () => Promise<R>): Promise<R> {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(when);
  try {
    return await f();
  } finally {
    vi.useRealTimers();
  }
}

async function runDaily(t: T) {
  await t.mutation(internal.maintenance.daily, {});
  await t.finishAllScheduledFunctions(() => {});
}

describe("JWT lifetime and revocation (A10)", () => {
  test("sign-in issues a 60-minute JWT", async () => {
    expect(JWT_DURATION_MS).toBe(60 * MINUTE_MS);
    const t = await setupAuth();
    const orgId = await makeOrg(t);
    const code = "J".repeat(26);
    const { codeHash } = await import("./lib/crypto");
    await t.run((ctx) =>
      ctx.db.insert("invites", {
        orgId,
        email: "jwt@acme.test",
        role: "viewer",
        kind: "join",
        tokenHash: codeHash(code),
        expiresAt: Date.now() + HOUR_MS,
      }),
    );
    const r = await signIn(t, { email: "jwt@acme.test", password: "a long pass 1234", flow: "signUp", inviteCode: code });
    const token = r.tokens!.token;
    const claims = JSON.parse(atob(token.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/"))) as { iat: number; exp: number };
    expect(claims.exp - claims.iat).toBe(3600);
    // The session row is checked on every call: deleting it signs out at once.
    const as = asToken(t, token);
    expect(await as.query(api.account.me, {})).not.toBeNull();
    const sessions = await t.run((ctx) => ctx.db.query("authSessions").take(10));
    await t.run(async (ctx) => {
      for (const s of sessions) await ctx.db.delete(s._id);
    });
    expect(await as.query(api.account.me, {})).toBeNull();
  });

  test("mutations and actions refuse a session past its expiry; queries only read", async () => {
    const t = await setupAuth();
    const owner = await asMember(t, { role: "owner", mfa: true });
    await t.run((ctx) => ctx.db.patch(owner.sessionId, { expirationTime: Date.now() - 1 }));
    // Mutation wrapper (members:revokeInvite) and action wrapper (members:invite).
    const inviteId = await t.run((ctx) =>
      ctx.db.insert("invites", { orgId: owner.orgId, email: "x@acme.test", role: "viewer", kind: "join", tokenHash: "1".repeat(64), expiresAt: Date.now() + HOUR_MS }),
    );
    await expectCode(owner.as.mutation(api.members.revokeInvite, { inviteId }), "unauthenticated");
    await expectCode(owner.as.action(api.members.invite, { email: "y@acme.test", role: "viewer" }), "unauthenticated");
    // A query still answers within the last JWT's lifetime (no Date.now() in queries).
    expect((await owner.as.query(api.members.list, {})).members.length).toBe(1);
  });
});

describe("maintenance:daily (A10)", () => {
  test("deletes expired sessions, old MFA rows, expired and used refresh tokens; keeps the active token and its parent", async () => {
    const t = await setupAuth();
    const now = Date.now();

    // An expired session (created 8 days ago) with an MFA row and a token.
    const { user, ...old } = await at(now - SESSION_TOTAL_MS - DAY_MS, () =>
      t.run(async (ctx) => {
        const user = await ctx.db.insert("users", { email: "u@acme.test" });
        const s = await ctx.db.insert("authSessions", { userId: user, expirationTime: Date.now() + SESSION_TOTAL_MS });
        await ctx.db.insert("mfaSessions", { sessionId: s, userId: user, verifiedAt: Date.now() });
        const tok = await ctx.db.insert("authRefreshTokens", { sessionId: s, expirationTime: Date.now() + SESSION_INACTIVE_MS });
        return { user, s, tok };
      }),
    );

    // A live session with a chain: t1 (used 3 h ago) -> t2 (used 2 h ago) -> t3 (used 30 s ago) -> t4 (active).
    const live = await at(now - 4 * HOUR_MS, () =>
      t.run(async (ctx) => {
        const s = await ctx.db.insert("authSessions", { userId: user, expirationTime: Date.now() + SESSION_TOTAL_MS });
        await ctx.db.insert("mfaSessions", { sessionId: s, userId: user, verifiedAt: Date.now() });
        return s;
      }),
    );
    const mk = (when: number, parent: Id<"authRefreshTokens"> | undefined, firstUsedTime: number | undefined) =>
      at(when, () =>
        t.run((ctx) =>
          ctx.db.insert("authRefreshTokens", {
            sessionId: live,
            expirationTime: Date.now() + SESSION_INACTIVE_MS,
            parentRefreshTokenId: parent,
            firstUsedTime,
          }),
        ),
      );
    const t1 = await mk(now - 4 * HOUR_MS, undefined, now - 3 * HOUR_MS);
    const t2 = await mk(now - 3 * HOUR_MS, t1, now - 2 * HOUR_MS);
    const t3 = await mk(now - 2 * HOUR_MS, t2, now - 30_000);
    // A used token still in its 60-second grace (no child): kept.
    const g1 = await at(now - 5 * MINUTE_MS, () =>
      t.run(async (ctx) => {
        const live2 = await ctx.db.insert("authSessions", { userId: user, expirationTime: now + SESSION_TOTAL_MS });
        return await ctx.db.insert("authRefreshTokens", { sessionId: live2, expirationTime: Date.now() + SESSION_INACTIVE_MS, firstUsedTime: now - 10_000 });
      }),
    );
    const t4 = await mk(now - 30_000, t3, undefined);

    await runDaily(t);

    const left = await t.run(async (ctx) => ({
      oldSession: await ctx.db.get(old.s),
      oldToken: await ctx.db.get(old.tok),
      liveSession: await ctx.db.get(live),
      mfa: (await ctx.db.query("mfaSessions").withIndex("by_user", (q) => q.eq("userId", user)).take(10)).map((r) => r.sessionId),
      tokens: (await ctx.db.query("authRefreshTokens").withIndex("sessionId", (q) => q.eq("sessionId", live)).take(10)).map((r) => r._id),
      grace: await ctx.db.get(g1),
    }));
    expect(left.oldSession).toBeNull();
    expect(left.oldToken).toBeNull();
    expect(left.liveSession).not.toBeNull();
    expect(left.mfa).toEqual([live]);
    // t1, t2 deleted; t3 (parent of the active token) and t4 (active) kept.
    expect(new Set(left.tokens)).toEqual(new Set([t3, t4]));
    expect(left.grace).not.toBeNull();
    expect(t2).toBeDefined();
  });

  test("invites by expiry, audit by age, refilled authRateLimits rows; live rows untouched", async () => {
    const t = await setupAuth();
    const now = Date.now();
    await at(now - 2 * HOUR_MS, () =>
      t.run(async (ctx) => {
        await ctx.db.insert("authRateLimits", { identifier: "refilled", lastAttemptTime: now - 2 * HOUR_MS, attemptsLeft: 3 });
        await ctx.db.insert("authRateLimits", { identifier: "underAttack", lastAttemptTime: now - MINUTE_MS, attemptsLeft: 0 });
      }),
    );
    const orgId = await makeOrg(t);
    const old = now - 400 * DAY_MS;
    await t.run(async (ctx) => {
      await ctx.db.insert("invites", { orgId, email: "a@x.test", role: "viewer", kind: "join", tokenHash: "h1", expiresAt: old });
      await ctx.db.insert("invites", { orgId, email: "b@x.test", role: "viewer", kind: "join", tokenHash: "h2", expiresAt: now + 1000 });
      await ctx.db.insert("invites", { orgId, email: "c@x.test", role: "viewer", kind: "join", tokenHash: "h3", expiresAt: now - DAY_MS });
      await ctx.db.insert("auditLog", { orgId, at: old, actorType: "system", actorLabel: "x", action: "group.created", summary: "old" });
      await ctx.db.insert("auditLog", { orgId, at: now, actorType: "system", actorLabel: "x", action: "group.created", summary: "new" });
    });
    await runDaily(t);
    const left = await t.run(async (ctx) => ({
      invites: (await ctx.db.query("invites").withIndex("by_org", (q) => q.eq("orgId", orgId)).take(10)).map((i) => i.email).sort(),
      audit: (await ctx.db.query("auditLog").withIndex("by_org_at", (q) => q.eq("orgId", orgId)).take(10)).map((a) => a.summary),
      limits: (await ctx.db.query("authRateLimits").withIndex("identifier").take(10)).map((r) => r.identifier),
    }));
    // c expired a day ago: kept until 30 days after expiry.
    expect(left.invites).toEqual(["b@x.test", "c@x.test"]);
    expect(left.audit).toEqual(["new"]);
    expect(left.limits).toEqual(["underAttack"]);
  });

  test("rate-limiter rows older than 7 days are cleared; new ones stay", async () => {
    const t = await setupAuth();
    const { rateLimiter } = await import("./lib/rateLimits");
    const now = Date.now();
    await at(now - 8 * DAY_MS, () => t.run((ctx) => rateLimiter.limit(ctx, "signInPerEmail", { key: "old" })));
    await t.run((ctx) => rateLimiter.limit(ctx, "signInPerEmail", { key: "new" }));
    await runDaily(t);
    const values = await t.run(async (ctx) => ({
      old: await rateLimiter.getValue(ctx, "signInPerEmail", { key: "old" }),
      fresh: await rateLimiter.getValue(ctx, "signInPerEmail", { key: "new" }),
    }));
    // A cleared row reads as a full bucket with ts 0; the new one keeps its state.
    expect(values.old.ts).toBe(0);
    expect(values.fresh.ts).toBeGreaterThan(0);
  });
});
