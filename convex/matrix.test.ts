import { describe, expect, test } from "vitest";
import { setupAuth } from "../tests/convex/auth";
import { enrollDevice } from "../tests/convex/devices";
import { asMember, codeOf, expectNoSecrets, giveStepUp, makeOrg, type T } from "../tests/convex/identity";
import { MAJOR_ACTIONS } from "./lib/stepUp";
import { MINUTE_MS } from "./lib/limits";
import { DEFAULT_ORG_SETTINGS, DEFAULT_WEB_PERMISSIONS } from "./lib/validators";
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
  tokenId: Id<"enrollmentTokens">;
  deviceId: Id<"devices">;
  checkId: Id<"fleetChecks">;
  /** A website no group assigns, a program that can open files, a website assigned to `groupId`, and a rule for the program. */
  appId: Id<"apps">;
  desktopAppId: Id<"apps">;
  assignmentId: Id<"appAssignments">;
  handlerId: Id<"fileHandlers">;
  /** An enabled employee in no group. */
  employeeId: Id<"employees">;
  /** The device's stored secret hashes (current and previous). */
  storedHashes: string[];
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
  const { groupId, tokenId } = await t.run(async (ctx) => {
    const g = await ctx.db.insert("groups", { orgId, name: "Sales", revision: 0, createdAt: Date.now() });
    const tok = await ctx.db.insert("enrollmentTokens", {
      orgId,
      tokenHash: "1".repeat(64),
      expiresAt: Date.now() + 3_600_000,
      usesLeft: 1,
      groupId: g,
      createdAt: Date.now(),
    });
    return { groupId: g, tokenId: tok };
  });
  const { deviceId } = await enrollDevice(t, orgId, { groupId });
  // A credential mid-rotation: both hashes are stored, neither may ever be returned.
  const storedHashes = await t.run(async (ctx) => {
    const c = (await ctx.db.query("deviceCredentials").withIndex("by_device", (q) => q.eq("deviceId", deviceId)).unique())!;
    const previousSecretHash = "9".repeat(64);
    await ctx.db.patch(c._id, { previousSecretHash });
    return [c.secretHash, previousSecretHash];
  });
  const checkId = await t.run((ctx) =>
    ctx.db.insert("fleetChecks", { orgId, deviceIds: [deviceId], requestedAt: Date.now(), requestedBy: target.memberId }),
  );
  const { appId, desktopAppId, assignmentId, handlerId } = await t.run(async (ctx) => {
    const web = (name: string) => ({
      orgId,
      name,
      kind: "web" as const,
      web: { url: "https://example.com", allowedDomains: ["example.com"], permissions: DEFAULT_WEB_PERMISSIONS },
      archived: false,
      revision: 0,
      createdAt: Date.now(),
    });
    const appId = await ctx.db.insert("apps", web("Docs"));
    const wiki = await ctx.db.insert("apps", web("Wiki"));
    const desktopAppId = await ctx.db.insert("apps", {
      orgId,
      name: "Reader",
      kind: "desktop",
      desktop: { source: "preinstalled", exe: "{ProgramFiles}\\Reader\\reader.exe", args: [], fileArgTemplate: ["{file}"], resetFolders: [] },
      archived: false,
      revision: 0,
      createdAt: Date.now(),
    });
    const assignmentId = await ctx.db.insert("appAssignments", { orgId, groupId, appId: wiki, audience: "everyone", pinnedTaskbar: false, pinnedDesktop: true });
    const handlerId = await ctx.db.insert("fileHandlers", { orgId, extension: ".txt", appId: desktopAppId });
    return { appId, desktopAppId, assignmentId, handlerId };
  });
  const employeeId = await t.run((ctx) =>
    ctx.db.insert("employees", {
      orgId,
      name: "Maya",
      username: "maya",
      searchText: "maya maya",
      disabled: false,
      credentialRevision: 0,
      revision: 0,
      createdAt: Date.now(),
    }),
  );
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
    tokenId,
    deviceId,
    checkId,
    appId,
    desktopAppId,
    assignmentId,
    handlerId,
    employeeId,
    storedHashes,
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
/** The smallest PNG the icon check accepts: signature + a 1 x 1 IHDR chunk (the pixel data is not decoded). */
const TINY_PNG_B64 = btoa(
  String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1f, 0x15, 0xc4, 0x89),
);
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
  // Step 7: the liveness ping of Phase 4 agents. Device credentials only; no member identity helps.
  { name: "devices:ping", call: (a) => a.mutation(api.devices.ping, deviceArgs), expect: { default: "device_rejected" } },
  // Step 8: the signed-document head (subscription) and the one-shot fetches.
  { name: "devices:headState", call: (a) => a.query(api.devices.headState, deviceArgs), expect: { default: "kind:unknownDevice" } },
  {
    name: "devices:fetchDesired",
    call: (a) => a.query(api.devices.fetchDesired, { ...deviceArgs, version: 1 }),
    expect: { default: "device_rejected" },
  },
  {
    name: "devices:fetchRoster",
    call: (a) => a.query(api.devices.fetchRoster, { ...deviceArgs, sinceEpoch: 0 }),
    expect: { default: "device_rejected" },
  },
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
  // ---- Step 6: enrollment codes
  {
    name: "enrollmentCodes:list",
    call: (a) => a.query(api.enrollmentCodes.list, { paginationOpts: { numItems: 10, cursor: null }, nowMs: Date.now() }),
    expect: { ...VIEWER, foreign: "ok" }, // the foreign owner lists THEIR codes
  },
  {
    name: "enrollmentCodes:create",
    call: (a, f) => a.action(api.enrollmentCodes.create, { groupId: f.groupId, uses: 1, ttlMinutes: 60 }),
    expect: { ...ADMIN_UNLOCKED, foreign: "not_found" },
    returnsSecretOnce: true, // the code, once, by design (plan 4.7)
  },
  {
    name: "enrollmentCodes:revoke",
    call: (a, f) => a.mutation(api.enrollmentCodes.revoke, { tokenId: f.tokenId }),
    expect: { ...ADMIN_MAJOR, foreign: "not_found" },
  },
  // ---- Step 7: devices (fleet)
  {
    name: "fleet:list",
    call: (a) => a.query(api.fleet.list, { paginationOpts: { numItems: 50, cursor: null } }),
    expect: { ...VIEWER, foreign: "ok" }, // the foreign owner lists THEIR devices
  },
  { name: "fleet:get", call: (a, f) => a.query(api.fleet.get, { deviceId: f.deviceId }), expect: { ...VIEWER, foreign: "not_found" } },
  {
    name: "fleet:rename",
    // Unchanged name: no write, every allowed caller gets the same answer.
    call: (a, f) => a.mutation(api.fleet.rename, { deviceId: f.deviceId, expectedRevision: 0, name: "PC" }),
    expect: { ...ADMIN_UNLOCKED, foreign: "not_found" },
  },
  {
    name: "fleet:move",
    call: (a, f) => a.mutation(api.fleet.move, { deviceId: f.deviceId, expectedRevision: 0, groupId: f.groupId }),
    expect: { ...ADMIN_UNLOCKED, foreign: "not_found" },
  },
  {
    name: "fleet:setKiosk",
    // Turning it ON (unchanged here) needs an unlocked session; OFF is major (fleet.test.ts).
    call: (a, f) => a.mutation(api.fleet.setKiosk, { deviceId: f.deviceId, expectedRevision: 0, enabled: true }),
    expect: { ...ADMIN_UNLOCKED, foreign: "not_found" },
  },
  { name: "fleet:revoke", call: (a, f) => a.mutation(api.fleet.revoke, { deviceId: f.deviceId }), expect: { ...ADMIN_MAJOR, foreign: "not_found" } },
  {
    name: "fleet:remove",
    call: (a, f) => a.mutation(api.fleet.remove, { deviceId: f.deviceId }),
    expect: { ...ADMIN_MAJOR, default: "conflict", foreign: "not_found" }, // not revoked
  },
  {
    name: "fleet:requestCredentialRotation",
    call: (a, f) => a.mutation(api.fleet.requestCredentialRotation, { deviceId: f.deviceId }),
    expect: { ...ADMIN_UNLOCKED, foreign: "not_found" },
  },
  {
    name: "fleet:watch",
    // A view aid (stepUp "none"): any member who can see the device; rate limited.
    call: (a, f) => a.mutation(api.fleet.watch, { deviceId: f.deviceId }),
    expect: { ...VIEWER, foreign: "not_found" },
  },
  { name: "fleet:liveness", call: (a, f) => a.query(api.fleet.liveness, { deviceId: f.deviceId }), expect: { ...VIEWER, foreign: "not_found" } },
  {
    name: "fleet:checkNow",
    // 1 per minute per organization: the first allowed caller (admin) uses the token.
    call: (a, f) => a.mutation(api.fleet.checkNow, { deviceIds: [f.deviceId] }),
    expect: { ...ADMIN_UNLOCKED, owner: "rate_limited", ownerStale: "rate_limited", foreign: "not_found" },
  },
  // ---- Step 8: signing keys. Every organization of the fixture already has the
  // TEST key active and the env holds no next seed, so an Owner with a fresh
  // step-up reaches the handler and gets its refusal (never a secret).
  { name: "keys:status", call: (a) => a.query(api.keys.status, {}), expect: { ...VIEWER, foreign: "ok" } },
  {
    name: "keys:trustProgress",
    call: (a) => a.query(api.keys.trustProgress, { paginationOpts: { numItems: 50, cursor: null } }),
    expect: { ...VIEWER, foreign: "ok" },
  },
  // The env key is already each organization's active key: the retry path (publishes again, registers nothing).
  { name: "keys:registerActive", call: (a) => a.mutation(api.keys.registerActive, {}), expect: { ...OWNER, owner: "ok", foreign: "ok" } },
  { name: "keys:prepareRotation", call: (a) => a.mutation(api.keys.prepareRotation, {}), expect: { ...OWNER, owner: "not_ready", foreign: "not_ready" } },
  { name: "keys:finishRotation", call: (a) => a.mutation(api.keys.finishRotation, {}), expect: { ...OWNER, owner: "conflict", foreign: "conflict" } },
  // ---- Step 10: apps, assignments, file types. Writes that need nothing but the caller's rights
  // are chosen so that every allowed caller gets the same answer (no-op updates, or a refusal
  // that comes after the authorization); the foreign owner acts on THEIR organization.
  {
    name: "apps:list",
    call: (a) => a.query(api.apps.list, { paginationOpts: { numItems: 10, cursor: null }, archived: false }),
    expect: { ...VIEWER, foreign: "ok" },
  },
  { name: "apps:get", call: (a, f) => a.query(api.apps.get, { appId: f.appId }), expect: { ...VIEWER, foreign: "not_found" } },
  { name: "apps:options", call: (a) => a.query(api.apps.options, {}), expect: { ...VIEWER, foreign: "ok" } },
  {
    name: "apps:createWeb",
    call: (a) => a.mutation(api.apps.createWeb, { name: unique(), url: "https://example.com", allowedDomains: [] }),
    expect: { ...ADMIN_UNLOCKED, foreign: "ok" },
  },
  {
    name: "apps:createDesktop",
    call: (a) =>
      a.mutation(api.apps.createDesktop, {
        name: unique(),
        desktop: { source: "preinstalled", exe: "{ProgramFiles}\\Acme\\a.exe", args: [], fileArgTemplate: [], resetFolders: [] },
      }),
    expect: { ...ADMIN_UNLOCKED, foreign: "ok" },
  },
  {
    name: "apps:update",
    // The same values again: no write, every allowed caller gets the same answer.
    call: (a, f) =>
      a.mutation(api.apps.update, { appId: f.appId, expectedRevision: 0, web: { name: "Docs", url: "https://example.com", allowedDomains: [] } }),
    expect: { ...ADMIN_UNLOCKED, foreign: "not_found" },
  },
  {
    name: "apps:setArchived",
    call: (a, f) => a.mutation(api.apps.setArchived, { appId: f.appId, archived: false }),
    expect: { ...ADMIN_UNLOCKED, foreign: "not_found" },
  },
  {
    name: "apps:remove",
    call: (a, f) => a.mutation(api.apps.remove, { appId: f.appId }),
    expect: { ...ADMIN_MAJOR, default: "invalid_argument", foreign: "not_found" }, // not archived
  },
  {
    name: "apps:retry",
    call: (a, f) => a.mutation(api.apps.retry, { appId: f.appId }),
    expect: { ...ADMIN_UNLOCKED, default: "invalid_argument", foreign: "not_found" }, // a website has nothing to install
  },
  {
    name: "apps:saveIcon",
    call: (a, f) => a.action(api.apps.saveIcon, { appId: f.appId, png: TINY_PNG_B64 }),
    expect: { ...ADMIN_UNLOCKED, foreign: "not_found" },
  },
  {
    name: "apps:fetchWebMeta",
    // An address no web app may have is refused before anything is fetched.
    call: (a) => a.action(api.apps.fetchWebMeta, { url: "http://example.com" }),
    expect: { ...ADMIN_UNLOCKED, default: "invalid_argument" },
  },
  {
    name: "apps:resolveWinget",
    call: (a) => a.action(api.apps.resolveWinget, { packageId: "not a package" }),
    expect: { ...ADMIN_UNLOCKED, default: "invalid_argument" },
  },
  { name: "fileHandlers:list", call: (a) => a.query(api.fileHandlers.list, {}), expect: { ...VIEWER, foreign: "ok" } },
  {
    name: "fileHandlers:set",
    call: (a, f) => a.mutation(api.fileHandlers.set, { extension: ".pdf", appId: f.desktopAppId }),
    expect: { ...ADMIN_UNLOCKED, foreign: "not_found" },
  },
  {
    name: "fileHandlers:remove",
    // The first allowed caller deletes the rule; the next ones find nothing.
    call: (a, f) => a.mutation(api.fileHandlers.remove, { handlerId: f.handlerId }),
    expect: { ...ADMIN_MAJOR, owner: "not_found", foreign: "not_found" },
  },
  {
    name: "groups:assignApp",
    call: (a, f) =>
      a.mutation(api.groups.assignApp, { groupId: f.groupId, appId: f.appId, audience: "everyone", pinnedTaskbar: false, pinnedDesktop: true }),
    // The first allowed caller assigns; the next ones find the pair taken.
    expect: { ...ADMIN_UNLOCKED, owner: "conflict", ownerStale: "conflict", foreign: "not_found" },
  },
  {
    name: "groups:updateAssignment",
    call: (a, f) =>
      a.mutation(api.groups.updateAssignment, { assignmentId: f.assignmentId, audience: "everyone", pinnedTaskbar: false, pinnedDesktop: true }),
    expect: { ...ADMIN_UNLOCKED, foreign: "not_found" },
  },
  {
    name: "groups:unassignApp",
    call: (a, f) => a.mutation(api.groups.unassignApp, { assignmentId: f.assignmentId }),
    expect: { ...ADMIN_UNLOCKED, owner: "not_found", ownerStale: "not_found", foreign: "not_found" },
  },
  // ---- Step 11: employees. Writes are chosen so that every allowed caller gets the same answer
  // (no-op values, or a refusal that comes after the authorization); a password is never returned.
  {
    name: "employees:list",
    call: (a) => a.query(api.employees.list, { paginationOpts: { numItems: 10, cursor: null } }),
    expect: { ...VIEWER, foreign: "ok" },
  },
  { name: "employees:search", call: (a) => a.query(api.employees.search, { text: "maya" }), expect: { ...VIEWER, foreign: "ok" } },
  { name: "employees:options", call: (a) => a.query(api.employees.options, {}), expect: { ...VIEWER, foreign: "ok" } },
  { name: "employees:get", call: (a, f) => a.query(api.employees.get, { employeeId: f.employeeId }), expect: { ...VIEWER, foreign: "not_found" } },
  {
    name: "employees:create",
    call: (a) =>
      a.action(api.employees.create, { name: "New", username: `new.${Math.random().toString(36).slice(2, 10)}`, groupIds: [] }),
    expect: { ...ADMIN_UNLOCKED, foreign: "ok" },
  },
  {
    name: "employees:update",
    call: (a, f) => a.mutation(api.employees.update, { employeeId: f.employeeId, expectedRevision: 0, name: "Maya", username: "maya" }),
    expect: { ...ADMIN_UNLOCKED, foreign: "not_found" },
  },
  {
    name: "employees:setGroups",
    call: (a, f) => a.mutation(api.employees.setGroups, { employeeId: f.employeeId, expectedRevision: 0, groupIds: [] }),
    expect: { ...ADMIN_UNLOCKED, foreign: "not_found" },
  },
  {
    name: "employees:setDirectApps",
    call: (a, f) => a.mutation(api.employees.setDirectApps, { employeeId: f.employeeId, expectedRevision: 0, appIds: [] }),
    expect: { ...ADMIN_UNLOCKED, foreign: "not_found" },
  },
  {
    name: "employees:setPassword",
    // Too short: every allowed caller is refused after the authorization and the foreign owner finds no such employee.
    call: (a, f) => a.action(api.employees.setPassword, { employeeId: f.employeeId, password: "short" }),
    expect: { ...ADMIN_UNLOCKED, default: "invalid_argument", foreign: "not_found" },
  },
  {
    name: "employees:setDisabled",
    call: (a, f) => a.mutation(api.employees.setDisabled, { employeeId: f.employeeId, disabled: false }),
    expect: { ...ADMIN_UNLOCKED, foreign: "not_found" },
  },
  { name: "employees:unlock", call: (a, f) => a.mutation(api.employees.unlock, { employeeId: f.employeeId }), expect: { ...ADMIN_UNLOCKED, foreign: "not_found" } },
  {
    name: "employees:remove",
    call: (a, f) => a.mutation(api.employees.remove, { employeeId: f.employeeId }),
    expect: { ...ADMIN_MAJOR, default: "invalid_argument", foreign: "not_found" }, // still active
  },
  {
    name: "groups:addEmployee",
    // The first allowed caller adds; the next ones find the employee already in the group (no write).
    call: (a, f) => a.mutation(api.groups.addEmployee, { groupId: f.groupId, employeeId: f.employeeId }),
    expect: { ...ADMIN_UNLOCKED, foreign: "not_found" },
  },
  {
    name: "groups:removeEmployee",
    call: (a, f) => a.mutation(api.groups.removeEmployee, { groupId: f.groupId, employeeId: f.employeeId }),
    expect: { ...ADMIN_UNLOCKED, foreign: "not_found" },
  },
  {
    name: "fleet:checkResult",
    call: (a, f) => a.query(api.fleet.checkResult, { checkId: f.checkId }),
    expect: {
      default: "ok",
      unauth: "unauthenticated",
      device: "unauthenticated",
      viewer: "forbidden",
      adminNoMfa: "mfa_required",
      ownerNoMfa: "mfa_required",
      disabled: "forbidden",
      foreign: "not_found",
    },
  },
];

/** Member writes that are entry points of MFA or step-up themselves (no step-up level). */
const STEP_UP_EXEMPT = new Set([
  "mfa:beginSetup", "mfa:confirmSetup", "mfa:verify", "mfa:useRecoveryCode",
  "stepUp:lock", "stepUp:setActionPin", "stepUp:verifyActionPin", "stepUp:resetWithRecoveryCode",
  "passkeys:beginRegistration", "passkeys:finishRegistration", "passkeys:beginVerification", "passkeys:finishVerification",
  // A view aid of the device page (renews watch mode while the page is visible; the page is hidden when locked).
  "fleet:watch",
  // not member functions
  "account:redeemReset", "enrollment:enroll", "devices:heartbeat", "devices:unenroll", "devices:ping",
]);

async function outcome(p: Promise<unknown>): Promise<{ result: string; value: unknown }> {
  try {
    const value = await p;
    // `kind` is the Phase 2 wire answer of the device functions; `apps:get` has a `kind` field of its own.
    if (value !== null && typeof value === "object" && "kind" in value && !["ok", "web", "desktop"].includes((value as { kind: string }).kind)) {
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
        if (row.returnsSecretOnce !== true) expectNoSecrets(r.value, f.storedHashes);
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
