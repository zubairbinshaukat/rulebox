import { describe, expect, test } from "vitest";
import { setupAuth } from "../tests/convex/auth";
import { asMember, codeOf, expectNoSecrets, giveStepUp, makeOrg, type T } from "../tests/convex/identity";
import { MAJOR_ACTIONS } from "./lib/stepUp";
import { MINUTE_MS } from "./lib/limits";
import { DEFAULT_ORG_SETTINGS } from "./lib/validators";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { modules } from "./test.setup";

// Plan 4.6 authorization matrix as a test table, for every public function
// that exists after Step 3. A new public function without a row fails the
// completeness test at the bottom.

// admin, owner, foreign: MFA and a FRESH step-up. ownerStale: verified 6
// minutes ago, active (unlocked, not fresh). ownerIdle: verified and last
// active 20 minutes ago (locked). ownerNoFactor: MFA, no action PIN or passkey.
type Caller =
  | "unauth" | "viewer" | "adminNoMfa" | "admin" | "ownerNoMfa" | "owner" | "disabled" | "foreign" | "device"
  | "ownerStale" | "ownerIdle" | "ownerNoFactor";
const CALLERS: Caller[] = [
  "unauth", "viewer", "adminNoMfa", "admin", "ownerNoMfa", "owner", "disabled", "foreign", "device",
  "ownerStale", "ownerIdle", "ownerNoFactor",
];

type Fixture = {
  t: T;
  orgId: Id<"organizations">;
  targetMemberId: Id<"members">;
  inviteId: Id<"invites">;
  groupId: Id<"groups">;
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
  // A group that cannot be deleted (a usable enrollment code points at it), so
  // every authorized groups:remove answers the same `has_dependents`.
  const groupId = await t.run(async (ctx) => {
    const g = await ctx.db.insert("groups", { orgId, name: "Sales", revision: 0, createdAt: Date.now() });
    await ctx.db.insert("enrollmentTokens", {
      orgId,
      tokenHash: "1".repeat(64),
      expiresAt: Date.now() + 3_600_000,
      usesLeft: 1,
      groupId: g,
      createdAt: Date.now(),
    });
    return g;
  });
  const foreignOrg = await makeOrg(t, "Other");
  type StepUp = "fresh" | "stale" | "idle" | "factorOnly" | "none";
  const m = async (role: "owner" | "admin" | "viewer", mfa: boolean, status: "active" | "disabled" = "active", o = orgId, s: StepUp = "none") => {
    const x = await asMember(t, { role, mfa, status, orgId: o });
    if (s === "fresh") await giveStepUp(t, x);
    if (s === "stale") await giveStepUp(t, x, { verifiedAgoMs: 6 * MINUTE_MS, activeAgoMs: 0 });
    if (s === "idle") await giveStepUp(t, x, { verifiedAgoMs: 20 * MINUTE_MS });
    if (s === "factorOnly") await giveStepUp(t, x, { none: true });
    return x.as;
  };
  return {
    t,
    orgId,
    targetMemberId: target.memberId,
    inviteId,
    groupId,
    accessor: {
      unauth: t,
      viewer: await m("viewer", false),
      adminNoMfa: await m("admin", false),
      admin: await m("admin", true, "active", orgId, "fresh"),
      ownerNoMfa: await m("owner", false),
      owner: await m("owner", true, "active", orgId, "fresh"),
      disabled: await m("owner", true, "disabled"),
      foreign: await m("owner", true, "active", foreignOrg, "fresh"),
      ownerStale: await m("owner", true, "active", orgId, "stale"),
      ownerIdle: await m("owner", true, "active", orgId, "idle"),
      ownerNoFactor: await m("owner", true),
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
  // Every OWNER function today is a major action (plan 4.16).
  ownerStale: "step_up_required",
  ownerIdle: "step_up_required",
  ownerNoFactor: "step_up_setup_required",
};
// A member write at the "unlocked" level: viewer has no factor yet.
const UNLOCKED: Row["expect"] = {
  ...VIEWER,
  viewer: "step_up_setup_required",
  ownerIdle: "step_up_required",
  ownerNoFactor: "step_up_setup_required",
};
// A self-service major action (viewer level, fresh step-up).
const SELF_MAJOR: Row["expect"] = { ...UNLOCKED, ownerStale: "step_up_required" };
// An Admin write (Step 5 on): viewers are refused by role before any step-up check.
const ADMIN_UNLOCKED: Row["expect"] = {
  default: "ok",
  unauth: "unauthenticated",
  device: "unauthenticated",
  viewer: "forbidden",
  adminNoMfa: "mfa_required",
  ownerNoMfa: "mfa_required",
  disabled: "forbidden",
  ownerIdle: "step_up_required",
  ownerNoFactor: "step_up_setup_required",
};
const ADMIN_MAJOR: Row["expect"] = { ...ADMIN_UNLOCKED, ownerStale: "step_up_required" };
const unique = () => `G ${Math.random().toString(36).slice(2, 10)}`;
const fakePasskeyId = "jh7bp5vtxgdvg1vq4dzkrymc8s8gvwzm";

const ROWS: Row[] = [
  { name: "health:ping", call: (a) => a.query(api.health.ping, {}), expect: { default: "ok" } },
  { name: "account:me", call: (a) => a.query(api.account.me, {}), expect: { default: "ok" } },
  {
    name: "account:redeemReset",
    call: (a) => a.action(api.account.redeemReset, { email: `t${Math.random().toString(36).slice(2)}@acme.test`, code: "WRONG", newPassword: "valid pass 1234" }),
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
  // ---- Step-up (plan 4.16)
  { name: "stepUp:status", call: (a) => a.query(api.stepUp.status, {}), expect: { ...VIEWER, foreign: "ok" } },
  { name: "stepUp:keepAlive", call: (a) => a.mutation(api.stepUp.keepAlive, {}), expect: UNLOCKED },
  { name: "stepUp:lock", call: (a) => a.mutation(api.stepUp.lock, {}), expect: { ...VIEWER, foreign: "ok" } },
  {
    name: "stepUp:setActionPin",
    call: (a) => a.action(api.stepUp.setActionPin, { pin: "246813" }),
    // no factor + fresh sign-in = bootstrap; a factor needs a fresh step-up
    expect: { ...VIEWER, ownerStale: "step_up_required", ownerIdle: "step_up_required" },
  },
  {
    name: "stepUp:verifyActionPin",
    call: (a) => a.action(api.stepUp.verifyActionPin, { pin: "246813" }),
    expect: { ...VIEWER, default: "step_up_invalid", viewer: "not_ready", ownerNoFactor: "not_ready" },
  },
  {
    name: "stepUp:clearActionPin",
    call: (a) => a.mutation(api.stepUp.clearActionPin, {}),
    expect: { ...SELF_MAJOR, default: "step_up_last_factor" },
  },
  {
    name: "stepUp:renamePasskey",
    call: (a) => a.mutation(api.stepUp.renamePasskey, { passkeyId: fakePasskeyId, name: "Laptop" }),
    expect: { ...UNLOCKED, default: "not_found" },
  },
  {
    name: "stepUp:removePasskey",
    call: (a) => a.mutation(api.stepUp.removePasskey, { passkeyId: fakePasskeyId }),
    expect: { ...SELF_MAJOR, default: "not_found" },
  },
  { name: "stepUp:resetMember", call: (a, f) => a.mutation(api.stepUp.resetMember, { memberId: f.targetMemberId }), expect: OWNER },
  {
    name: "stepUp:resetWithRecoveryCode",
    call: (a) => a.action(api.stepUp.resetWithRecoveryCode, { code: "AAAA-AAAA" }),
    expect: { ...VIEWER, default: "not_ready" },
  },
  {
    name: "passkeys:beginRegistration",
    call: (a) => a.action(api.passkeys.beginRegistration, {}),
    expect: { ...VIEWER, ownerStale: "step_up_required", ownerIdle: "step_up_required" },
  },
  {
    name: "passkeys:finishRegistration",
    call: (a) => a.action(api.passkeys.finishRegistration, { responseJson: "{}" }),
    expect: { ...VIEWER, default: "step_up_invalid" },
  },
  {
    name: "passkeys:beginVerification",
    call: (a) => a.action(api.passkeys.beginVerification, {}),
    expect: { ...VIEWER, default: "not_ready" },
  },
  {
    name: "passkeys:finishVerification",
    call: (a) => a.action(api.passkeys.finishVerification, { responseJson: "{}" }),
    expect: { ...VIEWER, default: "step_up_invalid" },
  },
  // ---- Step 5: organization settings, exit PIN, plan, groups
  { name: "settings:get", call: (a) => a.query(api.settings.get, {}), expect: { ...VIEWER, foreign: "ok" } },
  { name: "settings:plan", call: (a) => a.query(api.settings.plan, {}), expect: { ...VIEWER, foreign: "ok" } },
  {
    name: "settings:update",
    // Unchanged values (no write) for this org; the foreign owner renames THEIR org.
    call: (a) => a.mutation(api.settings.update, { expectedRevision: 0, name: "Acme", settings: DEFAULT_ORG_SETTINGS }),
    expect: ADMIN_UNLOCKED,
  },
  { name: "settings:setExitPin", call: (a) => a.action(api.settings.setExitPin, { pin: "246813" }), expect: ADMIN_MAJOR },
  { name: "settings:clearExitPin", call: (a) => a.mutation(api.settings.clearExitPin, {}), expect: ADMIN_MAJOR },
  { name: "groups:list", call: (a) => a.query(api.groups.list, {}), expect: { ...VIEWER, foreign: "ok" } },
  { name: "groups:get", call: (a, f) => a.query(api.groups.get, { groupId: f.groupId }), expect: { ...VIEWER, foreign: "not_found" } },
  { name: "groups:create", call: (a) => a.mutation(api.groups.create, { name: unique() }), expect: ADMIN_UNLOCKED },
  {
    name: "groups:rename",
    call: (a, f) => a.mutation(api.groups.rename, { groupId: f.groupId, expectedRevision: 0, name: "Sales" }),
    expect: { ...ADMIN_UNLOCKED, foreign: "not_found" },
  },
  {
    name: "groups:remove",
    call: (a, f) => a.mutation(api.groups.remove, { groupId: f.groupId }),
    expect: { ...ADMIN_MAJOR, default: "has_dependents", foreign: "not_found" },
  },
];

/** Member writes that are entry points of MFA or step-up themselves (no step-up level). */
const STEP_UP_EXEMPT = new Set([
  "mfa:beginSetup", "mfa:confirmSetup", "mfa:verify", "mfa:useRecoveryCode",
  "stepUp:lock", "stepUp:setActionPin", "stepUp:verifyActionPin", "stepUp:resetWithRecoveryCode",
  "passkeys:beginRegistration", "passkeys:finishRegistration", "passkeys:beginVerification", "passkeys:finishVerification",
  // not member functions
  "account:redeemReset", "enrollment:enroll", "devices:heartbeat", "devices:unenroll",
]);

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

  // ---- Step-up wiring (plan 4.16): a new function cannot forget it.

  test("every MAJOR_ACTIONS function that exists refuses a step-up older than 5 minutes", async () => {
    const fns = await publicFunctions();
    const existing = Object.entries(MAJOR_ACTIONS)
      .filter(([name, spec]) => spec.when === "always" && fns.has(name))
      .map(([name]) => name);
    expect(existing.length).toBeGreaterThanOrEqual(9);
    for (const name of existing) {
      const row = ROWS.find((r) => r.name === name);
      expect(row, `${name} needs a matrix row`).toBeDefined();
      // The matrix test above runs these expectations against the real functions.
      expect(row!.expect.ownerStale ?? row!.expect.default, name).toBe("step_up_required");
    }
  });

  test("every other member write needs an unlocked session", async () => {
    const fns = await publicFunctions();
    for (const [name, fn] of fns) {
      if (fn.isQuery === true || STEP_UP_EXEMPT.has(name) || name.startsWith("auth:")) continue;
      const row = ROWS.find((r) => r.name === name);
      expect(row, `${name} needs a matrix row`).toBeDefined();
      expect(row!.expect.ownerIdle ?? row!.expect.default, name).toBe("step_up_required");
    }
  });

  test("a `major:` name is the function's own file:name and is in MAJOR_ACTIONS", async () => {
    const sources = import.meta.glob("./*.ts", { query: "?raw", import: "default" });
    let seen = 0;
    for (const [path, load] of Object.entries(sources)) {
      if (path.includes(".test.")) continue;
      const file = path.replace(/^\.\//, "").replace(/\.ts$/, "");
      const text = (await load()) as string;
      for (const m of text.matchAll(/export const (\w+) = member(?:Mutation|Action|Query)\([^)]*major:\s*"([^"]+)"/g)) {
        seen++;
        expect(m[2], `${file}:${m[1]}`).toBe(`${file}:${m[1]}`);
        expect(Object.keys(MAJOR_ACTIONS)).toContain(m[2]);
      }
    }
    expect(seen).toBeGreaterThanOrEqual(9);
  });
});

type Registered = { isPublic?: boolean; isQuery?: boolean; isMutation?: boolean; isAction?: boolean };

async function publicFunctions(): Promise<Map<string, Registered>> {
  const out = new Map<string, Registered>();
  for (const [path, load] of Object.entries(modules)) {
    if (path.includes(".test.") || path.includes("test.setup") || path.includes("/_generated/") || path.includes("/lib/")) continue;
    if (/\/(convex\.config|auth\.config|schema|crons|http)\.ts$/.test(path)) continue;
    const mod = (await load()) as Record<string, unknown>;
    const file = path.replace(/^\.\//, "").replace(/\.[jt]s$/, "");
    for (const [name, fn] of Object.entries(mod)) {
      const f = fn as Registered;
      if (typeof fn === "function" && f.isPublic === true) out.set(`${file}:${name}`, f);
    }
  }
  return out;
}
