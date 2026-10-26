import { describe, expect, test } from "vitest";
import { setupAuth } from "../tests/convex/auth";
import { asMember, codeOf, expectNoSecrets, makeOrg, type T } from "../tests/convex/identity";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { modules } from "./test.setup";

// Plan 4.6 authorization matrix as a test table, for every public function
// that exists after Step 3. A new public function without a row fails the
// completeness test at the bottom.

type Caller = "unauth" | "viewer" | "adminNoMfa" | "admin" | "ownerNoMfa" | "owner" | "disabled" | "foreign" | "device";
const CALLERS: Caller[] = ["unauth", "viewer", "adminNoMfa", "admin", "ownerNoMfa", "owner", "disabled", "foreign", "device"];

type Fixture = {
  t: T;
  orgId: Id<"organizations">;
  targetMemberId: Id<"members">;
  inviteId: Id<"invites">;
  accessor: Record<Caller, ReturnType<T["withIdentity"]> | T>;
};

async function fixture(): Promise<Fixture> {
  const t = await setupAuth();
  const orgId = await makeOrg(t);
  const target = await asMember(t, { role: "viewer", orgId, email: "target@acme.test" });
  const inviteId = await t.run((ctx) =>
    ctx.db.insert("invites", {
      orgId,
      email: "inv@acme.test",
      role: "viewer",
      kind: "join",
      tokenHash: "0".repeat(64),
      expiresAt: Date.now() + 60_000,
    }),
  );
  const foreignOrg = await makeOrg(t, "Other");
  const m = async (role: "owner" | "admin" | "viewer", mfa: boolean, status: "active" | "disabled" = "active", o = orgId) =>
    (await asMember(t, { role, mfa, status, orgId: o })).as;
  return {
    t,
    orgId,
    targetMemberId: target.memberId,
    inviteId,
    accessor: {
      unauth: t,
      viewer: await m("viewer", false),
      adminNoMfa: await m("admin", false),
      admin: await m("admin", true),
      ownerNoMfa: await m("owner", false),
      owner: await m("owner", true),
      disabled: await m("owner", true, "disabled"),
      foreign: await m("owner", true, "active", foreignOrg),
      device: t, // a device has no member identity; it can only present device credentials
    },
  };
}

type Expect = "ok" | string;
type Row = {
  name: string;
  call: (a: Fixture["accessor"][Caller], f: Fixture) => Promise<unknown>;
  expect: Partial<Record<Caller, Expect>> & { default: Expect };
  /** mfa:beginSetup returns the new TOTP secret once, by design (plan 4.7). */
  returnsSecretOnce?: true;
};

const deviceArgs = { deviceId: "jh7bp5vtxgdvg1vq4dzkrymc8s8gvwzm", deviceSecret: "not-a-real-secret" };

// Outcomes for member functions by minimum role (plan 4.6).
const VIEWER_ANY_MFA: Row["expect"] = {
  default: "ok",
  unauth: "unauthenticated",
  device: "unauthenticated",
  disabled: "forbidden",
};
const VIEWER: Row["expect"] = { ...VIEWER_ANY_MFA, adminNoMfa: "mfa_required", ownerNoMfa: "mfa_required" };
const OWNER: Row["expect"] = {
  default: "forbidden",
  unauth: "unauthenticated",
  device: "unauthenticated",
  ownerNoMfa: "mfa_required",
  owner: "ok",
  // Owner of another organization: the id is not in their org.
  foreign: "not_found",
};

const ROWS: Row[] = [
  { name: "health:ping", call: (a) => a.query(api.health.ping, {}), expect: { default: "ok" } },
  { name: "account:me", call: (a) => a.query(api.account.me, {}), expect: { default: "ok" } },
  {
    name: "account:redeemReset",
    call: (a) => a.action(api.account.redeemReset, { email: "target@acme.test", code: "WRONG", newPassword: "valid pass 1234" }),
    expect: { default: "invite_invalid" }, // public; needs a valid code whoever calls
  },
  {
    name: "enrollment:enroll",
    call: (a) =>
      a.mutation(api.enrollment.enroll, {
        token: "nope",
        deviceSecretHash: "a".repeat(64),
        deviceName: "x",
        agentVersion: "0",
        compat: null,
      }),
    expect: { default: "token_invalid" }, // token-checked whoever calls
  },
  { name: "devices:desiredState", call: (a) => a.query(api.devices.desiredState, deviceArgs), expect: { default: "kind:unknownDevice" } },
  { name: "devices:heartbeat", call: (a) => a.mutation(api.devices.heartbeat, deviceArgs), expect: { default: "kind:rejected" } },
  { name: "devices:unenroll", call: (a) => a.mutation(api.devices.unenroll, deviceArgs), expect: { default: "kind:rejected" } },
  { name: "mfa:status", call: (a) => a.query(api.mfa.status, {}), expect: { ...VIEWER_ANY_MFA, foreign: "ok" } },
  { name: "mfa:beginSetup", call: (a) => a.action(api.mfa.beginSetup, {}), expect: { ...VIEWER_ANY_MFA, foreign: "ok" }, returnsSecretOnce: true },
  {
    name: "mfa:confirmSetup",
    call: (a) => a.action(api.mfa.confirmSetup, { code: "000000" }),
    expect: { ...VIEWER_ANY_MFA, default: "not_ready", foreign: "not_ready" },
  },
  {
    name: "mfa:verify",
    call: (a) => a.action(api.mfa.verify, { code: "000000" }),
    expect: { ...VIEWER_ANY_MFA, default: "mfa_invalid_code", foreign: "mfa_invalid_code" },
  },
  {
    name: "mfa:useRecoveryCode",
    call: (a) => a.action(api.mfa.useRecoveryCode, { code: "AAAA-AAAA" }),
    expect: { ...VIEWER_ANY_MFA, default: "mfa_invalid_code", foreign: "mfa_invalid_code" },
  },
  { name: "members:list", call: (a) => a.query(api.members.list, {}), expect: { ...VIEWER, foreign: "ok" } },
  {
    name: "members:invite",
    call: (a) => a.action(api.members.invite, { email: "fresh@acme.test", role: "viewer" }),
    expect: { ...OWNER, foreign: "ok" }, // no id argument: the foreign owner invites into THEIR org
  },
  { name: "members:revokeInvite", call: (a, f) => a.mutation(api.members.revokeInvite, { inviteId: f.inviteId }), expect: OWNER },
  {
    name: "members:changeRole",
    call: (a, f) => a.mutation(api.members.changeRole, { memberId: f.targetMemberId, role: "admin", expectedRevision: 0 }),
    expect: OWNER,
  },
  {
    name: "members:setDisabled",
    call: (a, f) => a.mutation(api.members.setDisabled, { memberId: f.targetMemberId, disabled: true, expectedRevision: 0 }),
    expect: OWNER,
  },
  { name: "members:createResetCode", call: (a, f) => a.action(api.members.createResetCode, { memberId: f.targetMemberId }), expect: OWNER },
  { name: "members:resetMfa", call: (a, f) => a.mutation(api.members.resetMfa, { memberId: f.targetMemberId }), expect: OWNER },
];

async function outcome(p: Promise<unknown>): Promise<{ result: string; value: unknown }> {
  try {
    const value = await p;
    if (value !== null && typeof value === "object" && "kind" in value && (value as { kind: string }).kind !== "ok") {
      return { result: `kind:${(value as { kind: string }).kind}`, value };
    }
    return { result: "ok", value };
  } catch (e) {
    return { result: codeOf(e) ?? `error:${String(e).slice(0, 80)}`, value: null };
  }
}

describe("authorization matrix (plan 4.6)", () => {
  for (const row of ROWS) {
    test(row.name, async () => {
      const f = await fixture();
      const got: Record<string, string> = {};
      const want: Record<string, string> = {};
      for (const caller of CALLERS) {
        const r = await outcome(row.call(f.accessor[caller], f));
        got[caller] = r.result;
        want[caller] = row.expect[caller] ?? row.expect.default;
        // Whatever comes back, it never carries a secret (plan 4.7).
        if (row.returnsSecretOnce !== true) expectNoSecrets(r.value);
      }
      expect(got).toEqual(want);
    });
  }

  test("every public function has a row", async () => {
    const publicNames: string[] = [];
    for (const [path, load] of Object.entries(modules)) {
      if (path.includes(".test.") || path.includes("test.setup") || path.includes("/_generated/") || path.includes("/lib/")) continue;
      if (/\/(convex\.config|auth\.config|schema|crons|http)\.ts$/.test(path)) continue;
      const mod = (await load()) as Record<string, unknown>;
      const file = path.replace(/^\.\//, "").replace(/\.[jt]s$/, "");
      for (const [name, fn] of Object.entries(mod)) {
        const f: unknown = fn;
        if (typeof f === "function" && (f as { isPublic?: boolean }).isPublic === true) publicNames.push(`${file}:${name}`);
      }
    }
    // Convex Auth's own entry points are covered by auth.test.ts.
    const authOwn = ["auth:signIn", "auth:signOut", "auth:isAuthenticated"];
    const covered = new Set([...ROWS.map((r) => r.name), ...authOwn]);
    expect(publicNames.filter((n) => !covered.has(n))).toEqual([]);
    expect(publicNames.length).toBeGreaterThan(15);
  });
});
