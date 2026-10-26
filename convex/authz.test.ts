import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import {
  asMember,
  asUser,
  expectCode,
  identityFor,
  makeOrg,
  type T,
} from "../tests/convex/identity";
import { assertInOrg, checkRevision, nextRevision, requireMember, roleRank } from "./lib/authz";
import { insertMembership } from "./lib/members";
import schema from "./schema";
import { modules } from "./test.setup";

function setup(): T {
  return convexTest(schema, modules);
}

describe("requireMember", () => {
  test("unauthenticated without identity", async () => {
    const t = setup();
    await expectCode(t.run((ctx) => requireMember(ctx, "viewer")), "unauthenticated");
  });

  test("unauthenticated when the session row is gone", async () => {
    const t = setup();
    const m = await asMember(t, { role: "viewer" });
    await t.run((ctx) => ctx.db.delete(m.sessionId));
    await expectCode(m.as.run((ctx) => requireMember(ctx, "viewer")), "unauthenticated");
  });

  test("unauthenticated when the subject names another user's session", async () => {
    const t = setup();
    const a = await asMember(t, { role: "viewer" });
    const b = await asMember(t, { role: "owner", mfa: true, orgId: a.orgId });
    const forged = identityFor(t, a.userId, b.sessionId);
    await expectCode(forged.run((ctx) => requireMember(ctx, "viewer")), "unauthenticated");
  });

  test("forbidden for a user with no member row", async () => {
    const t = setup();
    const u = await asUser(t);
    await expectCode(u.as.run((ctx) => requireMember(ctx, "viewer")), "forbidden");
  });

  test("forbidden for a disabled member", async () => {
    const t = setup();
    const m = await asMember(t, { role: "owner", mfa: true, status: "disabled" });
    await expectCode(m.as.run((ctx) => requireMember(ctx, "viewer")), "forbidden");
  });

  test("role ranks: viewer < admin < owner", async () => {
    expect(roleRank("viewer")).toBeLessThan(roleRank("admin"));
    expect(roleRank("admin")).toBeLessThan(roleRank("owner"));
    const t = setup();
    const orgId = await makeOrg(t);
    const viewer = await asMember(t, { role: "viewer", orgId });
    const admin = await asMember(t, { role: "admin", mfa: true, orgId });
    const owner = await asMember(t, { role: "owner", mfa: true, orgId });
    await expectCode(viewer.as.run((ctx) => requireMember(ctx, "admin")), "forbidden");
    expect((await admin.as.run((ctx) => requireMember(ctx, "admin"))).member.role).toBe("admin");
    expect((await owner.as.run((ctx) => requireMember(ctx, "admin"))).member.role).toBe("owner");
    await expectCode(admin.as.run((ctx) => requireMember(ctx, "owner")), "forbidden");
  });

  test("mfa_required for an admin or owner without an mfaSessions row; success with one", async () => {
    const t = setup();
    const orgId = await makeOrg(t);
    const admin = await asMember(t, { role: "admin", orgId });
    const owner = await asMember(t, { role: "owner", orgId });
    await expectCode(admin.as.run((ctx) => requireMember(ctx, "viewer")), "mfa_required");
    await expectCode(owner.as.run((ctx) => requireMember(ctx, "viewer")), "mfa_required");
    // skipMfa is for the five mfa:* functions only.
    expect((await admin.as.run((ctx) => requireMember(ctx, "viewer", { skipMfa: true }))).orgId).toBe(orgId);
    await t.run((ctx) =>
      ctx.db.insert("mfaSessions", { sessionId: admin.sessionId, userId: admin.userId, verifiedAt: Date.now() }),
    );
    expect((await admin.as.run((ctx) => requireMember(ctx, "admin"))).member._id).toBe(admin.memberId);
  });

  test("an mfaSessions row of another user does not count", async () => {
    const t = setup();
    const orgId = await makeOrg(t);
    const admin = await asMember(t, { role: "admin", orgId });
    const other = await asMember(t, { role: "viewer", orgId });
    await t.run((ctx) =>
      ctx.db.insert("mfaSessions", { sessionId: admin.sessionId, userId: other.userId, verifiedAt: Date.now() }),
    );
    await expectCode(admin.as.run((ctx) => requireMember(ctx, "viewer")), "mfa_required");
  });

  test("a viewer without MFA passes", async () => {
    const t = setup();
    const viewer = await asMember(t, { role: "viewer" });
    expect((await viewer.as.run((ctx) => requireMember(ctx, "viewer"))).member.role).toBe("viewer");
  });
});

describe("helpers", () => {
  test("assertInOrg answers not_found for another organization's document", async () => {
    const t = setup();
    const a = await makeOrg(t, "A");
    const b = await makeOrg(t, "B");
    const groupId = await t.run((ctx) => ctx.db.insert("groups", { orgId: b, name: "B group" }));
    await expectCode(
      t.run(async (ctx) => {
        assertInOrg(await ctx.db.get(groupId), a);
      }),
      "not_found",
    );
    const ok = await t.run(async (ctx) => assertInOrg(await ctx.db.get(groupId), b));
    expect(ok.name).toBe("B group");
    await expectCode(
      t.run(async () => {
        assertInOrg(null, a);
      }),
      "not_found",
    );
  });

  test("checkRevision and nextRevision", async () => {
    const t = setup();
    expect(() => checkRevision({ revision: 2 }, 2)).not.toThrow();
    expect(() => checkRevision({}, 0)).not.toThrow();
    await expectCode(
      t.run(async () => {
        checkRevision({ revision: 3 }, 2);
      }),
      "stale_edit",
    );
    expect(nextRevision({})).toBe(1);
    expect(nextRevision({ revision: 4 })).toBe(5);
  });
});

describe("two organizations, one user", () => {
  async function twoOrgs(t: T) {
    const orgA = await makeOrg(t, "A");
    const orgB = await makeOrg(t, "B");
    const inA = await asMember(t, { role: "admin", mfa: true, orgId: orgA, email: "both@acme.test" });
    // Same user, second membership (new session; the MFA row covers only the first).
    const inB = await asMember(t, { role: "viewer", orgId: orgB, userId: inA.userId, email: "both@acme.test" });
    return { orgA, orgB, inA, inB };
  }

  test("org_required without orgId; the right member with it", async () => {
    const t = setup();
    const { orgA, orgB, inA } = await twoOrgs(t);
    await expectCode(inA.as.run((ctx) => requireMember(ctx, "viewer")), "org_required");
    const a = await inA.as.run((ctx) => requireMember(ctx, "viewer", { orgId: orgA }));
    expect(a.member.role).toBe("admin");
    const b = await inA.as.run((ctx) => requireMember(ctx, "viewer", { orgId: orgB }));
    expect(b.member.role).toBe("viewer");
    expect(b.orgId).toBe(orgB);
  });

  test("orgId of an organization the user does not belong to answers not_found", async () => {
    const t = setup();
    const { inA } = await twoOrgs(t);
    const orgC = await makeOrg(t, "C");
    await expectCode(inA.as.run((ctx) => requireMember(ctx, "viewer", { orgId: orgC })), "not_found");
  });

  test("one membership disabled: the other works without orgId, the disabled one is forbidden", async () => {
    const t = setup();
    const { orgA, orgB, inA, inB } = await twoOrgs(t);
    await t.run((ctx) => ctx.db.patch(inB.memberId, { status: "disabled" }));
    const m = await inA.as.run((ctx) => requireMember(ctx, "viewer"));
    expect(m.orgId).toBe(orgA);
    await expectCode(inA.as.run((ctx) => requireMember(ctx, "viewer", { orgId: orgB })), "forbidden");
  });

  test("every membership disabled answers forbidden", async () => {
    const t = setup();
    const { inA, inB } = await twoOrgs(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(inA.memberId, { status: "disabled" });
      await ctx.db.patch(inB.memberId, { status: "disabled" });
    });
    await expectCode(inA.as.run((ctx) => requireMember(ctx, "viewer")), "forbidden");
  });

  test("one MFA verification covers every organization of that session", async () => {
    const t = setup();
    const { orgB, inA } = await twoOrgs(t);
    // Promote the user in B to admin: the session that verified for A covers B.
    await t.run(async (ctx) => {
      const rows = await ctx.db
        .query("members")
        .withIndex("by_org_user", (q) => q.eq("orgId", orgB).eq("userId", inA.userId))
        .take(1);
      await ctx.db.patch(rows[0]!._id, { role: "admin" });
    });
    const b = await inA.as.run((ctx) => requireMember(ctx, "admin", { orgId: orgB }));
    expect(b.member.role).toBe("admin");
  });

  test("a second insert for the same (orgId, userId) answers already_member", async () => {
    const t = setup();
    const { orgA, inA } = await twoOrgs(t);
    await expectCode(
      t.run((ctx) => insertMembership(ctx, { orgId: orgA, userId: inA.userId, email: inA.email, role: "viewer" })),
      "already_member",
    );
  });

  test("the same public key registers in both organizations as two rows", async () => {
    const t = setup();
    const { orgA, orgB } = await twoOrgs(t);
    const keyId = "0123456789abcdef";
    await t.run(async (ctx) => {
      for (const orgId of [orgA, orgB]) {
        await ctx.db.insert("policyKeys", {
          orgId,
          keyId,
          publicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
          status: "active",
          createdAt: Date.now(),
        });
      }
    });
    const rows = await t.run(async (ctx) => ({
      a: await ctx.db
        .query("policyKeys")
        .withIndex("by_org_key_id", (q) => q.eq("orgId", orgA).eq("keyId", keyId))
        .take(2),
      b: await ctx.db
        .query("policyKeys")
        .withIndex("by_org_status", (q) => q.eq("orgId", orgB).eq("status", "active"))
        .take(2),
    }));
    expect(rows.a).toHaveLength(1);
    expect(rows.b).toHaveLength(1);
    expect(rows.a[0]!._id).not.toBe(rows.b[0]!._id);
  });
});
