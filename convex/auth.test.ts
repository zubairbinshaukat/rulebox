import { describe, expect, test } from "vitest";
import { asToken, setupAuth, signIn } from "../tests/convex/auth";
import { asMember, asUser, codeOf, expectCode, expectNoSecrets, makeOrg, type T } from "../tests/convex/identity";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { beforeSessionCreation, createOrUpdateUser } from "./lib/authCallbacks";
import { codeHash } from "./lib/crypto";

const PASSWORD = "correct horse 42 battery";

async function ownerInvite(t: T, email = "owner@acme.test") {
  return await t.action(internal.setup.createOwnerInvite, { orgName: "Acme", email });
}

async function errorOf(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected an error");
}

describe("setup:createOwnerInvite", () => {
  test("creates the organization with defaults; a second call refuses", async () => {
    const t = await setupAuth();
    const first = await ownerInvite(t);
    expect(first.inviteCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    const rows = await t.run(async (ctx) => ({
      org: await ctx.db.get(first.orgId),
      stats: await ctx.db.query("orgStats").withIndex("by_org", (q) => q.eq("orgId", first.orgId)).first(),
      secrets: await ctx.db.query("orgSecrets").withIndex("by_org", (q) => q.eq("orgId", first.orgId)).first(),
      group: await ctx.db.query("groups").withIndex("by_org", (q) => q.eq("orgId", first.orgId)).first(),
      invite: await ctx.db.query("invites").withIndex("by_org", (q) => q.eq("orgId", first.orgId)).first(),
      audit: await ctx.db.query("auditLog").withIndex("by_org_at", (q) => q.eq("orgId", first.orgId)).first(),
    }));
    expect(rows.org?.settings?.offlineDays).toBe(3);
    // Step 5: limits live in orgPlans (self-host = "custom"), counters are exact.
    expect(rows.org?.maxDevices).toBeUndefined();
    // The Default group is not counted toward maxGroups (owner decision 2026-10-27).
    expect(rows.stats).toMatchObject({ deviceCount: 0, groupCount: 0, memberCount: 0 });
    expect(rows.stats?.pingIntervalMs).toBeUndefined();
    const plan = await t.run((ctx) => ctx.db.query("orgPlans").withIndex("by_org", (q) => q.eq("orgId", first.orgId)).unique());
    expect(plan).toMatchObject({ plan: "custom", status: "active", degradeLevel: 0 });
    expect(rows.secrets?.exitPinHash).toBeUndefined();
    expect(rows.group?.name).toBe("Default");
    expect(rows.group?.isDefault).toBe(true);
    expect(rows.invite).toMatchObject({ role: "owner", kind: "join", email: "owner@acme.test" });
    // Only the hash is stored, never the code; the audit row has no code either.
    expect(rows.invite?.tokenHash).toBe(codeHash(first.inviteCode));
    expect(JSON.stringify(rows)).not.toContain(first.inviteCode);
    await expectCode(ownerInvite(t, "other@acme.test"), "conflict");
    const extra = await t.action(internal.setup.createOwnerInvite, {
      orgName: "Second",
      email: "two@acme.test",
      allowAdditionalOrg: true,
    });
    expect(extra.orgId).not.toBe(first.orgId);
  });

  test("adopts an existing organization without members, refuses one with members", async () => {
    const t = await setupAuth();
    const legacy = await t.run((ctx) => ctx.db.insert("organizations", { name: "Rulebox VM test" }));
    const r = await t.action(internal.setup.createOwnerInvite, {
      orgName: "Acme",
      email: "owner@acme.test",
      existingOrgId: legacy,
    });
    expect(r.orgId).toBe(legacy);
    const org = await t.run((ctx) => ctx.db.get(legacy));
    expect(org?.name).toBe("Acme");
    expect(org?.settings).toBeDefined();
    await asMember(t, { role: "owner", orgId: legacy });
    await expectCode(
      t.action(internal.setup.createOwnerInvite, { orgName: "Acme", email: "x@acme.test", existingOrgId: legacy }),
      "conflict",
    );
  });
});

describe("Convex Auth callbacks", () => {
  async function invite(t: T, opts: { email?: string; kind?: "join" | "passwordReset"; expiresIn?: number; used?: boolean } = {}) {
    const orgId = await makeOrg(t);
    const code = "7K2M9QX4RZ0A8B6C5D3E1F7K2M";
    await t.run((ctx) =>
      ctx.db.insert("invites", {
        orgId,
        email: opts.email ?? "new@acme.test",
        role: "admin",
        kind: opts.kind ?? "join",
        tokenHash: codeHash(code),
        expiresAt: Date.now() + (opts.expiresIn ?? 60_000),
        usedAt: opts.used === true ? Date.now() : undefined,
      }),
    );
    return { orgId, code };
  }
  const create = (t: T, email: string, code: string | null) =>
    t.run((ctx) =>
      createOrUpdateUser(ctx, {
        existingUserId: null,
        profile: code === null ? { email } : { email, inviteTokenHash: codeHash(code) },
      }),
    );

  test("without an invite -> invite_invalid", async () => {
    const t = await setupAuth();
    await expectCode(create(t, "new@acme.test", null), "invite_invalid");
    await expectCode(create(t, "new@acme.test", "WRONGCODE"), "invite_invalid");
  });

  test.each([
    ["expired", { expiresIn: -1 }],
    ["used", { used: true }],
    ["other email", { email: "someone@acme.test" }],
    ["reset kind", { kind: "passwordReset" as const }],
  ])("%s invite -> invite_invalid", async (_name, opts) => {
    const t = await setupAuth();
    const { code } = await invite(t, opts);
    await expectCode(create(t, "new@acme.test", code), "invite_invalid");
  });

  test("valid invite -> member with the invite's role, invite used, audit row", async () => {
    const t = await setupAuth();
    const { orgId, code } = await invite(t);
    const userId = await create(t, "NEW@acme.test ", code);
    const state = await t.run(async (ctx) => ({
      member: await ctx.db.query("members").withIndex("by_user", (q) => q.eq("userId", userId)).first(),
      invite: await ctx.db.query("invites").withIndex("by_org", (q) => q.eq("orgId", orgId)).first(),
      audit: await ctx.db.query("auditLog").withIndex("by_org_at", (q) => q.eq("orgId", orgId)).first(),
    }));
    expect(state.member).toMatchObject({ orgId, role: "admin", status: "active", email: "new@acme.test" });
    expect(state.invite?.usedAt).toBeDefined();
    expect(state.audit?.action).toBe("member.joined");
    // One-time use.
    await expectCode(create(t, "new@acme.test", code), "invite_invalid");
  });

  test("an existing account keeps its user", async () => {
    const t = await setupAuth();
    const u = await asUser(t);
    const id = await t.run((ctx) => createOrUpdateUser(ctx, { existingUserId: u.userId, profile: {} }));
    expect(id).toBe(u.userId);
  });

  test("beforeSessionCreation refuses a disabled or missing member", async () => {
    const t = await setupAuth();
    const disabled = await asMember(t, { role: "viewer", status: "disabled" });
    await expectCode(t.run((ctx) => beforeSessionCreation(ctx, { userId: disabled.userId })), "account_disabled");
    const none = await asUser(t);
    await expectCode(t.run((ctx) => beforeSessionCreation(ctx, { userId: none.userId })), "account_disabled");
    const ok = await asMember(t, { role: "viewer" });
    await t.run((ctx) => beforeSessionCreation(ctx, { userId: ok.userId }));
  });
});

describe("sign-up and sign-in through Convex Auth", () => {
  async function joined(t: T) {
    const inv = await ownerInvite(t);
    const r = await signIn(t, { flow: "signUp", email: "Owner@Acme.test", password: PASSWORD, inviteCode: inv.inviteCode });
    return { ...inv, token: r.tokens!.token };
  }

  test("sign-up with the owner invite creates the owner and a session; the code is single-use", async () => {
    const t = await setupAuth();
    const { orgId, inviteCode, token } = await joined(t);
    const me = await asToken(t, token).query(api.account.me, {});
    expect(me).toMatchObject({ email: "owner@acme.test", role: "owner", orgId, mfa: { required: true, verified: false } });
    expectNoSecrets(me, [inviteCode]);
    // Same code again, other email or same email: refused.
    await expectCode(
      signIn(t, { flow: "signUp", email: "x@acme.test", password: PASSWORD, inviteCode }),
      "invite_invalid",
    );
  });

  test("open sign-up is impossible", async () => {
    const t = await setupAuth();
    await expectCode(signIn(t, { flow: "signUp", email: "a@acme.test", password: PASSWORD }), "invite_invalid");
    await expectCode(
      signIn(t, { flow: "signUp", email: "a@acme.test", password: PASSWORD, inviteCode: "0000000000" }),
      "invite_invalid",
    );
  });

  test("weak passwords are refused before the invite is used", async () => {
    const t = await setupAuth();
    const inv = await ownerInvite(t);
    for (const pw of ["short1", "no digits in this one", "123456789012345"]) {
      const e = await errorOf(signIn(t, { flow: "signUp", email: "owner@acme.test", password: pw, inviteCode: inv.inviteCode }));
      expect(codeOf(e)).toBe("invalid_argument");
    }
    const ok = await signIn(t, { flow: "signUp", email: "owner@acme.test", password: PASSWORD, inviteCode: inv.inviteCode });
    expect(ok.tokens?.token).toBeTruthy();
  });

  test("sign-in works; wrong password and unknown email fail with the same generic error", async () => {
    const t = await setupAuth();
    await joined(t);
    const ok = await signIn(t, { flow: "signIn", email: "owner@acme.test", password: PASSWORD });
    expect(ok.tokens?.token).toBeTruthy();
    const wrong = await errorOf(signIn(t, { flow: "signIn", email: "owner@acme.test", password: "nope nope 1234" }));
    const unknown = await errorOf(signIn(t, { flow: "signIn", email: "ghost@acme.test", password: "nope nope 1234" }));
    expect(codeOf(wrong)).toBeNull();
    expect(codeOf(unknown)).toBeNull();
    expect(String(wrong)).toContain("Invalid credentials");
    expect(String(unknown)).toContain("Invalid credentials");
    // Other flows of the Password provider do not exist here.
    const reset = await errorOf(t.action(api.auth.signIn, { provider: "password", params: { flow: "reset", email: "owner@acme.test" } }));
    expect(String(reset)).toContain("Invalid credentials");
  });

  test("sign-up for an existing email with a wrong password does not reveal the account", async () => {
    const t = await setupAuth();
    await joined(t);
    const extra = await t.action(internal.setup.createOwnerInvite, {
      orgName: "Two",
      email: "owner@acme.test",
      allowAdditionalOrg: true,
    });
    const e = await errorOf(
      signIn(t, { flow: "signUp", email: "owner@acme.test", password: "another pass 99", inviteCode: extra.inviteCode }),
    );
    expect(codeOf(e)).toBeNull();
    expect(String(e)).toContain("Invalid credentials");
  });

  test("rate limit per email: the 11th attempt in an hour is rate_limited, existing or not", async () => {
    const t = await setupAuth();
    await joined(t);
    for (const email of ["owner@acme.test", "ghost@acme.test"]) {
      for (let i = 0; i < 10; i++) {
        await errorOf(signIn(t, { flow: "signIn", email, password: "wrong wrong 1" }));
      }
      const e = await errorOf(signIn(t, { flow: "signIn", email, password: PASSWORD }));
      expect(codeOf(e)).toBe("rate_limited");
    }
  }, 60_000);

  test("a disabled member cannot sign in (account_disabled after a correct password)", async () => {
    const t = await setupAuth();
    const { orgId } = await joined(t);
    await t.run(async (ctx) => {
      const m = await ctx.db.query("members").withIndex("by_org_email", (q) => q.eq("orgId", orgId).eq("email", "owner@acme.test")).first();
      await ctx.db.patch(m!._id, { status: "disabled" });
    });
    await expectCode(signIn(t, { flow: "signIn", email: "owner@acme.test", password: PASSWORD }), "account_disabled");
  });
});

describe("account:me", () => {
  test("null when signed out; noAccess without a member row", async () => {
    const t = await setupAuth();
    expect(await t.query(api.account.me, {})).toBeNull();
    const u = await asUser(t);
    expect(await u.as.query(api.account.me, {})).toEqual({ noAccess: true, serverApiVersion: 1 });
  });

  test("memberships lists active ones only, with names", async () => {
    const t = await setupAuth();
    const a = await asMember(t, { role: "viewer" });
    const orgB = await makeOrg(t, "Bravo");
    await asMember(t, { role: "admin", orgId: orgB, userId: a.userId, email: a.email, status: "disabled" });
    const me = await a.as.query(api.account.me, {});
    expect(me).toMatchObject({ role: "viewer", memberships: [{ orgId: a.orgId, orgName: "Acme", role: "viewer" }] });
  });
});

describe("account:redeemReset", () => {
  test("sets a new password once, signs out every session, audits", async () => {
    const t = await setupAuth();
    const inv = await ownerInvite(t);
    const first = await signIn(t, { flow: "signUp", email: "owner@acme.test", password: PASSWORD, inviteCode: inv.inviteCode });
    const memberId = await t.run(async (ctx) =>
      (await ctx.db.query("members").withIndex("by_org_email", (q) => q.eq("orgId", inv.orgId).eq("email", "owner@acme.test")).first())!._id,
    );
    const code = "ABCDEFGHJKMNPQRSTVWXYZ0123";
    await t.run((ctx) =>
      ctx.db.insert("invites", {
        orgId: inv.orgId,
        email: "owner@acme.test",
        role: "owner",
        kind: "passwordReset",
        tokenHash: codeHash(code),
        expiresAt: Date.now() + 60_000,
        createdBy: memberId as Id<"members">,
      }),
    );
    const NEW = "brand new pass 77";
    await expectCode(
      t.action(api.account.redeemReset, { email: "other@acme.test", code, newPassword: NEW }),
      "invite_invalid",
    );
    await t.action(api.account.redeemReset, { email: "Owner@acme.test", code: code.toLowerCase(), newPassword: NEW });
    // The old session is gone.
    expect(await asToken(t, first.tokens!.token).query(api.account.me, {})).toBeNull();
    await errorOf(signIn(t, { flow: "signIn", email: "owner@acme.test", password: PASSWORD }));
    expect((await signIn(t, { flow: "signIn", email: "owner@acme.test", password: NEW })).tokens?.token).toBeTruthy();
    await expectCode(
      t.action(api.account.redeemReset, { email: "owner@acme.test", code, newPassword: "yet another 55 x" }),
      "invite_invalid",
    );
    const audit = await t.run((ctx) =>
      ctx.db.query("auditLog").withIndex("by_org_at", (q) => q.eq("orgId", inv.orgId)).order("desc").first(),
    );
    expect(audit?.action).toBe("member.passwordReset");
  });
});
