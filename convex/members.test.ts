import { describe, expect, test } from "vitest";
import { asToken, setupAuth, signIn } from "../tests/convex/auth";
import { asMember, expectCode, expectNoSecrets, giveStepUp, makeOrg, type T } from "../tests/convex/identity";
import { api, internal } from "./_generated/api";
import { codeHash } from "./lib/crypto";

const PASSWORD = "correct horse 42 battery";

/** An Owner/Admin with MFA and a fresh step-up (members:* are major actions, plan 4.16). */
async function fresh(t: T, opts: Parameters<typeof asMember>[1]) {
  const m = await asMember(t, opts);
  await giveStepUp(t, m);
  return m;
}

async function team(t: T) {
  const orgId = await makeOrg(t);
  const owner = await fresh(t, { role: "owner", mfa: true, orgId, email: "owner@acme.test" });
  const admin = await fresh(t, { role: "admin", mfa: true, orgId, email: "admin@acme.test" });
  const viewer = await asMember(t, { role: "viewer", orgId, email: "viewer@acme.test" });
  return { orgId, owner, admin, viewer };
}

async function revisionOf(t: T, memberId: string) {
  return await t.run(async (ctx) => (await ctx.db.get(ctx.db.normalizeId("members", memberId)!))!.revision);
}

describe("members", () => {
  test("list: members and invites, no secrets, isYou", async () => {
    const t = await setupAuth();
    const { owner } = await team(t);
    const { code } = await owner.as.action(api.members.invite, { email: "New@Acme.test", role: "viewer" });
    const list = await owner.as.query(api.members.list, {});
    expect(list.members).toHaveLength(3);
    expect(list.members.find((m) => m.isYou)?.email).toBe("owner@acme.test");
    expect(list.invites[0]).toMatchObject({ email: "new@acme.test", role: "viewer", kind: "join" });
    expectNoSecrets(list, [code, codeHash(code)]);
  });

  test("invite: owner only; admins and viewers are refused; duplicate member refused", async () => {
    const t = await setupAuth();
    const { owner, admin, viewer } = await team(t);
    await expectCode(admin.as.action(api.members.invite, { email: "x@acme.test", role: "owner" }), "forbidden");
    await expectCode(admin.as.action(api.members.invite, { email: "x@acme.test", role: "viewer" }), "forbidden");
    await expectCode(viewer.as.action(api.members.invite, { email: "x@acme.test", role: "viewer" }), "forbidden");
    await expectCode(owner.as.action(api.members.invite, { email: "admin@acme.test", role: "viewer" }), "already_member");
    await expectCode(owner.as.action(api.members.invite, { email: "not-an-email", role: "viewer" }), "invalid_argument");
    const r = await owner.as.action(api.members.invite, { email: "o2@acme.test", role: "owner" });
    expect(r.code).toHaveLength(26);
  });

  test("an admin caller can never create an Owner invite (storeInvite rule)", async () => {
    const t = await setupAuth();
    const { orgId, admin } = await team(t);
    await expectCode(
      t.mutation(internal.members.storeInvite, {
        orgId,
        actor: { type: "member", id: admin.memberId, label: admin.email },
        callerRole: "admin",
        email: "boss@acme.test",
        role: "owner",
        tokenHash: codeHash("X"),
      }),
      "forbidden",
    );
  });

  test("invite -> sign-up -> member with that role", async () => {
    const t = await setupAuth();
    const { owner, orgId } = await team(t);
    const { code } = await owner.as.action(api.members.invite, { email: "new@acme.test", role: "admin" });
    const r = await signIn(t, { flow: "signUp", email: "new@acme.test", password: PASSWORD, inviteCode: code });
    const me = await asToken(t, r.tokens!.token).query(api.account.me, {});
    expect(me).toMatchObject({ role: "admin", orgId });
  });

  test("revokeInvite makes the code unusable", async () => {
    const t = await setupAuth();
    const { owner } = await team(t);
    const { code } = await owner.as.action(api.members.invite, { email: "new@acme.test", role: "viewer" });
    const inviteId = (await owner.as.query(api.members.list, {})).invites[0]!._id;
    await owner.as.mutation(api.members.revokeInvite, { inviteId });
    await expectCode(signIn(t, { flow: "signUp", email: "new@acme.test", password: PASSWORD, inviteCode: code }), "invite_invalid");
  });

  test("changeRole: last owner cannot be demoted; no self change; stale_edit", async () => {
    const t = await setupAuth();
    const { owner, admin } = await team(t);
    await expectCode(
      owner.as.mutation(api.members.changeRole, { memberId: owner.memberId, role: "admin", expectedRevision: 0 }),
      "forbidden",
    );
    await owner.as.mutation(api.members.changeRole, { memberId: admin.memberId, role: "owner", expectedRevision: 0 });
    await expectCode(
      owner.as.mutation(api.members.changeRole, { memberId: admin.memberId, role: "viewer", expectedRevision: 0 }),
      "stale_edit",
    );
    // Two owners now: one may be demoted, then the remaining one is the last.
    await owner.as.mutation(api.members.changeRole, {
      memberId: admin.memberId,
      role: "admin",
      expectedRevision: await revisionOf(t, admin.memberId),
    });
    // The admin (MFA'd) cannot change roles at all.
    await expectCode(
      admin.as.mutation(api.members.changeRole, { memberId: owner.memberId, role: "viewer", expectedRevision: 0 }),
      "forbidden",
    );
  });

  test("last owner cannot be disabled; last owner rule is per organization", async () => {
    const t = await setupAuth();
    const { owner, orgId } = await team(t);
    const second = await fresh(t, { role: "owner", mfa: true, orgId });
    // Another org whose only owner is a different user: unaffected.
    const orgB = await makeOrg(t, "B");
    await fresh(t, { role: "owner", mfa: true, orgId: orgB });
    await second.as.mutation(api.members.setDisabled, { memberId: owner.memberId, disabled: true, expectedRevision: 0 });
    await expectCode(
      t.run(async (ctx) => {
        const { assertNotLastOwner } = await import("./lib/members");
        await assertNotLastOwner(ctx, (await ctx.db.get(second.memberId))!);
      }),
      "last_owner",
    );
  });

  test("disabling removes the person's sessions and MFA rows", async () => {
    const t = await setupAuth();
    const { owner, admin } = await team(t);
    await owner.as.mutation(api.members.setDisabled, { memberId: admin.memberId, disabled: true, expectedRevision: 0 });
    const left = await t.run(async (ctx) => ({
      session: await ctx.db.get(admin.sessionId),
      mfa: await ctx.db.query("mfaSessions").withIndex("by_user", (q) => q.eq("userId", admin.userId)).first(),
    }));
    expect(left).toEqual({ session: null, mfa: null });
    expect(await admin.as.query(api.account.me, {})).toBeNull();
    await expectCode(admin.as.query(api.members.list, {}), "unauthenticated");
    await owner.as.mutation(api.members.setDisabled, { memberId: admin.memberId, disabled: false, expectedRevision: 1 });
  });

  test("two organizations: disabling in one keeps sessions while another membership is active", async () => {
    const t = await setupAuth();
    const { owner, orgId } = await team(t);
    const orgB = await makeOrg(t, "B");
    const inB = await fresh(t, { role: "owner", mfa: true, orgId: orgB });
    // The same person is also a viewer in A.
    const alsoA = await asMember(t, { role: "viewer", orgId, userId: inB.userId, email: inB.email });
    await owner.as.mutation(api.members.setDisabled, { memberId: alsoA.memberId, disabled: true, expectedRevision: 0 });
    expect(await t.run((ctx) => ctx.db.get(inB.sessionId))).not.toBeNull();
    expect(await t.run((ctx) => ctx.db.query("mfaSessions").withIndex("by_session", (q) => q.eq("sessionId", inB.sessionId)).first())).not.toBeNull();
    // Their B membership still works without orgId; A answers forbidden with it.
    expect((await inB.as.query(api.members.list, {})).members.length).toBe(1);
    await expectCode(inB.as.query(api.members.list, { orgId }), "forbidden");
  });

  test("cross-org ids answer not_found", async () => {
    const t = await setupAuth();
    const { owner } = await team(t);
    const orgB = await makeOrg(t, "B");
    const other = await fresh(t, { role: "admin", mfa: true, orgId: orgB });
    await expectCode(
      owner.as.mutation(api.members.changeRole, { memberId: other.memberId, role: "viewer", expectedRevision: 0 }),
      "not_found",
    );
    await expectCode(owner.as.mutation(api.members.resetMfa, { memberId: other.memberId }), "not_found");
    await expectCode(owner.as.action(api.members.createResetCode, { memberId: other.memberId }), "not_found");
    await expectCode(owner.as.mutation(api.members.revokeInvite, { inviteId: "garbage" }), "not_found");
  });

  test("createResetCode -> redeemReset; resetMfa clears the authenticator", async () => {
    const t = await setupAuth();
    const { owner, orgId } = await team(t);
    const { code } = await owner.as.action(api.members.invite, { email: "new@acme.test", role: "admin" });
    await signIn(t, { flow: "signUp", email: "new@acme.test", password: PASSWORD, inviteCode: code });
    const target = (await owner.as.query(api.members.list, {})).members.find((m) => m.email === "new@acme.test")!;
    const reset = await owner.as.action(api.members.createResetCode, { memberId: target._id });
    await t.action(api.account.redeemReset, { email: "new@acme.test", code: reset.code, newPassword: "fresh pass 1234" });
    expect((await signIn(t, { flow: "signIn", email: "new@acme.test", password: "fresh pass 1234" })).tokens).toBeTruthy();

    const userId = await t.run(async (ctx) => (await ctx.db.get(target._id))!.userId);
    await t.run((ctx) =>
      ctx.db.insert("memberSecrets", { userId, totpSecret: "JBSWY3DPEHPK3PXP", recoveryHashes: [], lastTotpStep: 0, totpFailures: 0, totpLockedUntil: 0 }),
    );
    await owner.as.mutation(api.members.resetMfa, { memberId: target._id });
    expect(await t.run((ctx) => ctx.db.query("memberSecrets").withIndex("by_user", (q) => q.eq("userId", userId)).first())).toBeNull();
    const actions = await t.run(async (ctx) =>
      (await ctx.db.query("auditLog").withIndex("by_org_at", (q) => q.eq("orgId", orgId)).take(20)).map((r) => r.action),
    );
    expect(actions).toEqual(
      expect.arrayContaining(["member.invited", "member.joined", "member.resetCodeCreated", "member.passwordReset", "member.mfaReset"]),
    );
  });

  test("maintenance:resetMfaByEmail (CLI) clears the only owner's authenticator", async () => {
    const t = await setupAuth();
    const { owner } = await team(t);
    await t.run((ctx) =>
      ctx.db.insert("memberSecrets", { userId: owner.userId, totpSecret: "JBSWY3DPEHPK3PXP", recoveryHashes: [], lastTotpStep: 0, totpFailures: 0, totpLockedUntil: 0 }),
    );
    expect(await t.mutation(internal.maintenance.resetMfaByEmail, { email: "OWNER@acme.test" })).toEqual({ reset: true });
    expect(await t.run((ctx) => ctx.db.query("mfaSessions").withIndex("by_user", (q) => q.eq("userId", owner.userId)).first())).toBeNull();
  });

  test("maintenance:daily deletes old invites and old audit rows only (indexed, A10)", async () => {
    const t = await setupAuth();
    const { owner, orgId } = await team(t);
    const old = Date.now() - 400 * 86_400_000;
    await t.run(async (ctx) => {
      // A signed-out session's MFA row is no longer looked up by a full-table
      // scan: it is harmless (requireMember checks the session row first) and
      // deleted by age once its session would have expired (maintenance.test.ts).
      await ctx.db.delete(owner.sessionId);
      await ctx.db.insert("invites", { orgId, email: "a@x.test", role: "viewer", kind: "join", tokenHash: "h1", expiresAt: old });
      await ctx.db.insert("invites", { orgId, email: "b@x.test", role: "viewer", kind: "join", tokenHash: "h2", expiresAt: Date.now() + 1000 });
      await ctx.db.insert("auditLog", { orgId, at: old, actorType: "system", actorLabel: "x", action: "group.created", summary: "old" });
      await ctx.db.insert("auditLog", { orgId, at: Date.now(), actorType: "system", actorLabel: "x", action: "group.created", summary: "new" });
    });
    await t.mutation(internal.maintenance.daily, {});
    await t.finishAllScheduledFunctions(() => {});
    const left = await t.run(async (ctx) => ({
      mfa: await ctx.db.query("mfaSessions").withIndex("by_user", (q) => q.eq("userId", owner.userId)).first(),
      invites: (await ctx.db.query("invites").withIndex("by_org", (q) => q.eq("orgId", orgId)).take(10)).map((i) => i.email),
      audit: (await ctx.db.query("auditLog").withIndex("by_org_at", (q) => q.eq("orgId", orgId)).take(10)).map((a) => a.summary),
    }));
    expect(left.mfa).not.toBeNull();
    expect(left.invites).toEqual(["b@x.test"]);
    expect(left.audit).toEqual(["new"]);
  });
});
