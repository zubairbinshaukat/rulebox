// Shared rows of the authorization matrix (plan 4.6, Step 18): the fixture, one row per public
// function, and the function walk. Used by convex/matrix.test.ts, secrets.test.ts, crossOrg.test.ts.
// Kept outside convex/ so the Convex bundler never pushes it.
import { setupAuth } from "./auth";
import { enrollDevice, newToken } from "./devices";
import { asMember, giveStepUp, makeOrg, codeOf, type T } from "./identity";
import { sha256HexSync } from "../../convex/lib/crypto";
import { MINUTE_MS } from "../../convex/lib/limits";
import { DEFAULT_ORG_SETTINGS, DEFAULT_WEB_PERMISSIONS } from "../../convex/lib/validators";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { modules } from "../../convex/test.setup";
// Plan 4.6 authorization matrix as a test table, for every public function
// that exists after Step 3. A new public function without a row fails the
// completeness test at the bottom.

// admin, owner, foreign: a FRESH step-up. adminNoPin / ownerNoFactor: signed in,
// no action PIN or passkey yet. ownerStale: verified 6 minutes ago,
// active (unlocked, not fresh). ownerIdle: verified and last active 20 minutes
// ago (locked).
export type Caller =
  | "unauth" | "viewer" | "adminNoPin" | "admin" | "owner" | "disabled" | "foreign" | "device"
  | "ownerStale" | "ownerIdle" | "ownerNoFactor" | "ownerSuspended";
export const CALLERS: Caller[] = [
  "unauth", "viewer", "adminNoPin", "admin", "owner", "disabled", "foreign", "device",
  "ownerStale", "ownerIdle", "ownerNoFactor", "ownerSuspended",
];

export type Fixture = {
  t: T;
  orgId: Id<"organizations">;
  targetMemberId: Id<"members">;
  inviteId: Id<"invites">;
  groupId: Id<"groups">;
  tokenId: Id<"enrollmentTokens">;
  deviceId: Id<"devices">;
  /** The device's real secret (the matrix rows themselves present a wrong one). */
  deviceSecret: string;
  checkId: Id<"fleetChecks">;
  /** A website no group assigns, a program that can open files, a website assigned to `groupId`, and a rule for the program. */
  appId: Id<"apps">;
  desktopAppId: Id<"apps">;
  assignmentId: Id<"appAssignments">;
  handlerId: Id<"fileHandlers">;
  /** A WPA2 Wi-Fi profile ("Acme-Staff", revision 1, no passphrase) assigned to `groupId`. */
  wifiId: Id<"wifiProfiles">;
  /** A raw-TCP printer "Front desk" (Microsoft PCL6 Class Driver, revision 1) assigned to `groupId`, default there. */
  printerId: Id<"printers">;
  /** (Step 14b) An INF driver "Front desk driver" (revision 1) assigned to `groupId`. */
  driverId: Id<"drivers">;
  /** (Step 15) A live banner broadcast "Maintenance" aimed at `groupId`, no expiry, not cancelled. */
  broadcastId: Id<"broadcasts">;
  /** An enabled employee in no group. */
  employeeId: Id<"employees">;
  /** The device's stored secret hashes (current and previous). */
  storedHashes: string[];
  accessor: Record<Caller, ReturnType<T["withIdentity"]> | T>;
};

/** `given`: build the organization inside an existing deployment (two tenants with identical names). */
export async function fixture(given?: T): Promise<Fixture> {
  const t = given ?? (await setupAuth());
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
  const { deviceId, secret: deviceSecret } = await enrollDevice(t, orgId, { groupId });
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
  const wifiId = await t.run((ctx) =>
    ctx.db.insert("wifiProfiles", {
      orgId,
      name: "Acme staff",
      ssid: "Acme-Staff",
      hidden: false,
      security: "wpa2Personal",
      autoConnect: true,
      groupIds: [groupId],
      revision: 1,
      createdAt: Date.now(),
    }),
  );
  const printerId = await t.run((ctx) =>
    ctx.db.insert("printers", {
      orgId,
      name: "Front desk",
      kind: "raw",
      address: "10.0.0.20",
      driver: "Microsoft PCL6 Class Driver",
      groupIds: [groupId],
      defaultForGroupIds: [groupId],
      revision: 1,
      createdAt: Date.now(),
    }),
  );
  const driverId = await t.run((ctx) => ctx.db.insert("drivers", DRIVER_ROW(orgId, "Front desk driver", [groupId])));
  const broadcastId = await t.run((ctx) =>
    ctx.db.insert("broadcasts", {
      orgId,
      target: { kind: "group", id: groupId },
      style: "banner",
      title: "Maintenance",
      body: "The network is down tonight.",
      ackRequired: false,
      createdAt: Date.now(),
      targetCount: 1,
      ackCount: 0,
    }),
  );
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
  // An organization whose plan is suspended (plan 4.2.1): its owner acts on THEIR org, like `foreign`.
  const suspendedOrg = await makeOrg(t, "Suspended", { plan: "team" });
  await t.run(async (ctx) => {
    const plan = (await ctx.db.query("orgPlans").withIndex("by_org", (q) => q.eq("orgId", suspendedOrg)).unique())!;
    await ctx.db.patch(plan._id, { status: "suspended", suspendedReason: "matrix test" });
  });
  type StepUp = "fresh" | "stale" | "idle" | "factorOnly" | "none";
  const m = async (role: "owner" | "admin" | "viewer", status: "active" | "disabled" = "active", o = orgId, s: StepUp = "none") => {
    const x = await asMember(t, { role, status, orgId: o });
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
    deviceSecret,
    checkId,
    appId,
    desktopAppId,
    assignmentId,
    handlerId,
    wifiId,
    printerId,
    driverId,
    broadcastId,
    employeeId,
    storedHashes,
    accessor: {
      unauth: t,
      viewer: await m("viewer"),
      adminNoPin: await m("admin"),
      admin: await m("admin", "active", orgId, "fresh"),
      owner: await m("owner", "active", orgId, "fresh"),
      disabled: await m("owner", "disabled"),
      foreign: await m("owner", "active", foreignOrg, "fresh"),
      ownerStale: await m("owner", "active", orgId, "stale"),
      ownerIdle: await m("owner", "active", orgId, "idle"),
      ownerNoFactor: await m("owner"),
      ownerSuspended: await m("owner", "active", suspendedOrg, "fresh"),
      device: t, // a device has no member identity; it can only present device credentials
    },
  };
}

/** A valid INF driver row (Step 14b). */
export const DRIVER_ROW = (orgId: Id<"organizations">, name: string, groupIds: Id<"groups">[]) => ({
  orgId,
  name,
  kind: "inf" as const,
  deviceClass: "printer" as const,
  url: "https://downloads.example.test/front-desk.zip",
  sha256: "a".repeat(64),
  sizeBytes: 1_000_000,
  inf: "Drivers/front.inf",
  silentArgs: [] as string[],
  successExitCodes: [] as number[],
  provides: ["Front Desk Series"],
  groupIds,
  revision: 1,
  createdAt: Date.now(),
});

export type Expect = "ok" | string;
export type Row = {
  name: string;
  call: (a: Fixture["accessor"][Caller], f: Fixture) => Promise<unknown>;
  expect: Partial<Record<Caller, Expect>> & { default: Expect };
  /** A function that returns a secret once by design (plan 4.7). None today. */
  returnsSecretOnce?: true;
};

const deviceArgs = { deviceId: "jh7bp5vtxgdvg1vq4dzkrymc8s8gvwzm", deviceSecret: "not-a-real-secret" };

// Outcomes for member functions by minimum role (plan 4.6).
const VIEWER: Row["expect"] = {
  default: "ok",
  unauth: "unauthenticated",
  device: "unauthenticated",
  disabled: "forbidden",
};
// Having no action PIN, every write of `adminNoPin` and `ownerNoFactor` answers
// `step_up_setup_required` (the PIN is required for every role).
const NO_PIN = "step_up_setup_required";
const OWNER: Row["expect"] = {
  default: "forbidden",
  unauth: "unauthenticated",
  device: "unauthenticated",
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
  adminNoPin: NO_PIN,
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
  adminNoPin: NO_PIN,
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
/** Valid arguments of the Phase 5 device reports (Step 10); the matrix presents a wrong secret, the I/O and secrets tests the real one. */
const OFF_LAYER = { mode: "off", state: "off" };
export const APPLY_REPORT = {
  appliedVersion: 1,
  state: "applied",
  layers: { staff: OFF_LAYER, machine: OFF_LAYER, appLocker: OFF_LAYER, appControl: OFF_LAYER, procWatch: OFF_LAYER, boot: OFF_LAYER, performance: OFF_LAYER },
  wifi: [] as { profileId: string; revision: number; state: string }[],
  printers: [] as { printerId: string; revision: number; state: string }[],
  capabilities: ["lockdown/1"],
  contentHash: "c".repeat(64),
};
export const FINDING = {
  fingerprint: "d".repeat(64),
  layer: "appLocker",
  fileName: "tool.exe",
  folderClass: "userProfile",
  signer: "Contoso Ltd",
  product: "Tool",
  sha256: "e".repeat(64),
};
export const SECURITY_DAILY = {
  day: new Date().toISOString().slice(0, 10),
  blocked: { appLocker: 2, appControl: 0, procWatch: 1, elevation: 0 },
  permissionDenials: [] as { appId: string; kind: string; count: number }[],
  drift: 0,
  tamper: 0,
};
/** A valid X25519 public key (the base point's u = 9 is a fine public key; any 32 non-zero bytes that are not low-order work). */
export const SEAL_PUBLIC_KEY = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => (i === 0 ? 9 : 0))));
const fakePasskeyId = "jh7bp5vtxgdvg1vq4dzkrymc8s8gvwzm";

export const ROWS: Row[] = [
  { name: "health:ping", call: (a) => a.query(api.health.ping, {}), expect: { default: "ok" } },
  { name: "account:me", call: (a) => a.query(api.account.me, {}), expect: { default: "ok" } },
  {
    name: "account:redeemReset",
    call: (a) => a.action(api.account.redeemReset, { email: `t${Math.random().toString(36).slice(2)}@acme.test`, code: "WRONG", newPassword: "valid pass 1234" }),
    expect: { default: "invite_invalid" }, // public; needs a valid code whoever calls
  },
  // Phase 4b Part C: forgot PIN by email. SESSION-BOUND since the security review (no email argument:
  // it mails the signed-in person only); any signed-in session gets the same answer (mail is off here).
  {
    name: "account:requestPinReset",
    call: (a) => a.action(api.account.requestPinReset, {}),
    expect: { default: "ok", unauth: "unauthenticated", device: "unauthenticated" },
  },
  // Security review finding 5: self-service password change. Major (fresh step-up); a caller with a
  // fresh step-up reaches the password check and, having no password account here, gets the one
  // answer for any problem with the current password.
  {
    name: "account:changePassword",
    call: (a) => a.action(api.account.changePassword, { currentPassword: "not the password 1", newPassword: "valid pass 1234 x" }),
    expect: { ...SELF_MAJOR, default: "invalid_argument" },
  },
  {
    // Needs a signed-in (fresh) session; the link token decides the rest. A disabled member's session
    // still exists in this fixture (setDisabled deletes it in real life): the token check refuses it.
    name: "account:redeemPinReset",
    call: (a) => a.action(api.account.redeemPinReset, { token: "not-a-link-token", newPin: "246813" }),
    expect: { default: "step_up_invalid", unauth: "unauthenticated", device: "unauthenticated" },
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
  // Step 12: the device API. Device credentials only; no member identity helps.
  {
    name: "deviceApi:verifyEmployee",
    call: (a) => a.action(api.deviceApi.verifyEmployee, { ...deviceArgs, username: "maya", password: "not the password" }),
    expect: { default: "device_rejected" },
  },
  { name: "deviceApi:report", call: (a) => a.mutation(api.deviceApi.report, { ...deviceArgs }), expect: { default: "device_rejected" } },
  {
    name: "deviceApi:reportAudit",
    call: (a) => a.mutation(api.deviceApi.reportAudit, { ...deviceArgs, records: [], dropped: 0 }),
    expect: { default: "device_rejected" },
  },
  {
    name: "deviceApi:reportInstalls",
    call: (a) => a.mutation(api.deviceApi.reportInstalls, { ...deviceArgs, results: [] }),
    expect: { default: "device_rejected" },
  },
  {
    name: "deviceApi:rotateCredential",
    call: (a) => a.mutation(api.deviceApi.rotateCredential, { ...deviceArgs, newSecretHash: "a".repeat(64) }),
    expect: { default: "device_rejected" },
  },
  // Phase 5 Step 10: the lockdown reports and the sealing key. Device credentials only; no member identity helps.
  {
    name: "deviceApi:reportApply",
    call: (a) => a.mutation(api.deviceApi.reportApply, { ...deviceArgs, ...APPLY_REPORT }),
    expect: { default: "device_rejected" },
  },
  {
    name: "deviceApi:reportFindings",
    call: (a) => a.mutation(api.deviceApi.reportFindings, { ...deviceArgs, findings: [] }),
    expect: { default: "device_rejected" },
  },
  {
    name: "deviceApi:reportSecurityDaily",
    call: (a) => a.mutation(api.deviceApi.reportSecurityDaily, { ...deviceArgs, ...SECURITY_DAILY }),
    expect: { default: "device_rejected" },
  },
  {
    name: "deviceApi:reportAcks",
    call: (a) => a.mutation(api.deviceApi.reportAcks, { ...deviceArgs, acks: [] }),
    expect: { default: "device_rejected" },
  },
  {
    name: "deviceApi:registerSealKey",
    call: (a) => a.mutation(api.deviceApi.registerSealKey, { ...deviceArgs, publicKey: SEAL_PUBLIC_KEY }),
    expect: { default: "device_rejected" },
  },
  { name: "members:page", call: (a) => a.query(api.members.page, { paginationOpts: { numItems: 10, cursor: null } }), expect: { ...VIEWER, foreign: "ok" } },
  {
    name: "members:invitesPage",
    call: (a) => a.query(api.members.invitesPage, { paginationOpts: { numItems: 10, cursor: null }, nowMs: Date.now() }),
    expect: { ...VIEWER, foreign: "ok" },
  },
  {
    name: "members:invite",
    call: (a) => a.action(api.members.invite, { email: "fresh@acme.test", role: "viewer" }),
    expect: { ...OWNER, foreign: "ok", ownerSuspended: "plan_limit" }, // no id argument: the foreign owner invites into THEIR org; a suspended plan adds nobody
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
    expect: { ...VIEWER, default: "step_up_invalid", viewer: "not_ready", adminNoPin: "not_ready", ownerNoFactor: "not_ready" },
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
    // newPin is required (the reset sets it in the same transaction); nobody here has recovery codes.
    call: (a) => a.action(api.stepUp.resetWithRecoveryCode, { code: "AAAA-AAAA", newPin: "731942" }),
    expect: { ...VIEWER, default: "not_ready" },
  },
  {
    // Phase 4b: returns the new codes once (not a stored secret); a fresh step-up on any role.
    name: "stepUp:generateRecoveryCodes",
    call: (a) => a.action(api.stepUp.generateRecoveryCodes, {}),
    expect: SELF_MAJOR,
  },
  {
    name: "passkeys:beginRegistration",
    call: (a) => a.action(api.passkeys.beginRegistration, {}),
    // Phase 4b: the action PIN first (no passkey bootstrap), then a fresh step-up.
    expect: { ...VIEWER, ownerStale: "step_up_required", ownerIdle: "step_up_required", viewer: NO_PIN, adminNoPin: NO_PIN, ownerNoFactor: NO_PIN },
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
  { name: "groups:page", call: (a) => a.query(api.groups.page, { paginationOpts: { numItems: 10, cursor: null } }), expect: { ...VIEWER, foreign: "ok" } },
  { name: "groups:get", call: (a, f) => a.query(api.groups.get, { groupId: f.groupId }), expect: { ...VIEWER, foreign: "not_found" } },
  { name: "groups:create", call: (a) => a.mutation(api.groups.create, { name: unique() }), expect: { ...ADMIN_UNLOCKED, ownerSuspended: "plan_limit" } },
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
  // Phase 5 Step 15: the device lock (the same text again = no change) and broadcasts.
  {
    name: "fleet:lock",
    call: (a, f) => a.mutation(api.fleet.lock, { deviceId: f.deviceId, message: "This PC is locked. Please call the front desk.", contact: "Front desk, ext. 12" }),
    expect: { ...ADMIN_MAJOR, foreign: "not_found" },
  },
  { name: "fleet:unlock", call: (a, f) => a.mutation(api.fleet.unlock, { deviceId: f.deviceId }), expect: { ...ADMIN_MAJOR, foreign: "not_found" } },
  { name: "broadcasts:list", call: (a) => a.query(api.broadcasts.list, { paginationOpts: { numItems: 25, cursor: null } }), expect: { ...VIEWER, foreign: "ok" } },
  {
    name: "broadcasts:send",
    call: (a, f) =>
      a.mutation(api.broadcasts.send, {
        target: { kind: "group", id: f.groupId },
        style: "banner",
        title: "Maintenance",
        body: "The network is down tonight.",
        ackRequired: false,
      }),
    expect: { ...ADMIN_UNLOCKED, foreign: "not_found" },
  },
  { name: "broadcasts:cancel", call: (a, f) => a.mutation(api.broadcasts.cancel, { id: f.broadcastId }), expect: { ...ADMIN_UNLOCKED, foreign: "not_found" } },
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
    // A view aid (stepUp "pinSet"): no unlock needed (it keeps working behind the lock screen), but the
    // person must have finished sign-in (a PIN). Any member who can see the device; rate limited.
    call: (a, f) => a.mutation(api.fleet.watch, { deviceId: f.deviceId }),
    expect: { ...VIEWER, viewer: NO_PIN, adminNoPin: NO_PIN, ownerNoFactor: NO_PIN, foreign: "not_found" },
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
  // Phase 5 Step 10: the test deployment has no master key, so an Owner with a fresh step-up reaches the handler and is
  // refused `not_ready` (the I/O test runs the complete call with a master key set). A major action like the three above.
  { name: "keys:migrateFromEnv", call: (a) => a.action(api.keys.migrateFromEnv, {}), expect: { ...OWNER, owner: "not_ready", foreign: "not_ready" } },
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
    expect: { ...ADMIN_UNLOCKED, foreign: "ok", ownerSuspended: "plan_limit" },
  },
  {
    name: "apps:createDesktop",
    call: (a) =>
      a.mutation(api.apps.createDesktop, {
        name: unique(),
        desktop: { source: "preinstalled", exe: "{ProgramFiles}\\Acme\\a.exe", args: [], fileArgTemplate: [], resetFolders: [] },
      }),
    expect: { ...ADMIN_UNLOCKED, foreign: "ok", ownerSuspended: "plan_limit" },
  },
  {
    name: "apps:update",
    // The same values again: no write, every allowed caller gets the same answer.
    call: (a, f) =>
      a.mutation(api.apps.update, { appId: f.appId, expectedRevision: 0, web: { name: "Docs", url: "https://example.com", allowedDomains: [] } }),
    expect: { ...ADMIN_UNLOCKED, foreign: "not_found" },
  },
  {
    name: "apps:setPermissions",
    // The app's own permissions again: no write, every allowed caller gets the same answer.
    call: (a, f) => a.mutation(api.apps.setPermissions, { appId: f.appId, expectedRevision: 0, permissions: DEFAULT_WEB_PERMISSIONS }),
    expect: { ...ADMIN_UNLOCKED, foreign: "not_found" },
  },
  // Phase 5 Step 13: Wi-Fi profiles. Writes are the profile as it is (no change), a too-short passphrase, and a fresh profile each call.
  { name: "networks:list", call: (a) => a.query(api.networks.list, {}), expect: { ...VIEWER, foreign: "ok" } },
  { name: "networks:wifiDetail", call: (a, f) => a.query(api.networks.wifiDetail, { id: f.wifiId }), expect: { ...VIEWER, foreign: "not_found" } },
  {
    name: "networks:saveWifi",
    call: (a, f) =>
      a.mutation(api.networks.saveWifi, {
        id: f.wifiId,
        expectedRevision: 1,
        name: "Acme staff",
        ssid: "Acme-Staff",
        hidden: false,
        security: "wpa2Personal",
        autoConnect: true,
        groupIds: [f.groupId],
      }),
    expect: { ...ADMIN_UNLOCKED, foreign: "not_found" },
  },
  {
    name: "networks:deleteWifi",
    call: async (a, f) => {
      const id = await f.t.run((ctx) =>
        ctx.db.insert("wifiProfiles", { orgId: f.orgId, name: "Spare", ssid: "Spare", hidden: false, security: "open", autoConnect: true, groupIds: [], revision: 1, createdAt: Date.now() }),
      );
      return a.mutation(api.networks.deleteWifi, { id });
    },
    expect: { ...ADMIN_UNLOCKED, foreign: "not_found" },
  },
  {
    name: "wifi:setPassphrase",
    call: (a, f) => a.action(api.wifi.setPassphrase, { id: f.wifiId, passphrase: "short", expectedRevision: 1 }),
    expect: { ...ADMIN_UNLOCKED, default: "invalid_argument", foreign: "not_found" },
  },
  // Phase 5 Step 14: printers (the printer as it is = no change; a fresh printer is deleted).
  { name: "networks:printerDetail", call: (a, f) => a.query(api.networks.printerDetail, { id: f.printerId }), expect: { ...VIEWER, foreign: "not_found" } },
  {
    name: "networks:savePrinter",
    call: (a, f) =>
      a.mutation(api.networks.savePrinter, {
        id: f.printerId,
        expectedRevision: 1,
        name: "Front desk",
        kind: "raw",
        address: "10.0.0.20",
        driver: "Microsoft PCL6 Class Driver",
        groupIds: [f.groupId],
        defaultForGroupIds: [f.groupId],
      }),
    expect: { ...ADMIN_UNLOCKED, foreign: "not_found" },
  },
  {
    name: "networks:deletePrinter",
    call: async (a, f) => {
      const id = await f.t.run((ctx) =>
        ctx.db.insert("printers", { orgId: f.orgId, name: "Spare", kind: "raw", address: "10.0.0.21", driver: "Generic / Text Only", groupIds: [], defaultForGroupIds: [], revision: 1, createdAt: Date.now() }),
      );
      return a.mutation(api.networks.deletePrinter, { id });
    },
    expect: { ...ADMIN_UNLOCKED, foreign: "not_found" },
  },
  // Phase 5 Step 14b: the approved printer driver names (no names = no change), and drivers (the driver as it is = no change; a fresh one is deleted / retried).
  {
    name: "networks:setApprovedPrinterDrivers",
    call: (a) => a.mutation(api.networks.setApprovedPrinterDrivers, { names: [] }),
    expect: { ...ADMIN_UNLOCKED, foreign: "ok" },
  },
  { name: "drivers:detail", call: (a, f) => a.query(api.drivers.detail, { id: f.driverId }), expect: { ...VIEWER, foreign: "not_found" } },
  {
    name: "drivers:save",
    call: (a, f) =>
      a.mutation(api.drivers.save, {
        id: f.driverId,
        expectedRevision: 1,
        name: "Front desk driver",
        kind: "inf",
        deviceClass: "printer",
        url: "https://downloads.example.test/front-desk.zip",
        sha256: "a".repeat(64),
        sizeBytes: 1_000_000,
        inf: "Drivers/front.inf",
        silentArgs: [],
        successExitCodes: [],
        provides: ["Front Desk Series"],
        groupIds: [f.groupId],
      }),
    expect: { ...ADMIN_UNLOCKED, foreign: "not_found" },
  },
  {
    name: "drivers:remove",
    call: async (a, f) => {
      const id = await f.t.run((ctx) => ctx.db.insert("drivers", DRIVER_ROW(f.orgId, "Spare driver", [])));
      return a.mutation(api.drivers.remove, { id });
    },
    expect: { ...ADMIN_UNLOCKED, foreign: "not_found" },
  },
  {
    name: "drivers:retry",
    call: async (a, f) => {
      const id = await f.t.run((ctx) => ctx.db.insert("drivers", DRIVER_ROW(f.orgId, "Retry driver", [])));
      return a.mutation(api.drivers.retry, { id });
    },
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
  { name: "fileHandlers:page", call: (a) => a.query(api.fileHandlers.page, { paginationOpts: { numItems: 10, cursor: null } }), expect: { ...VIEWER, foreign: "ok" } },
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
  // Counts read only the caller's own counter row: a foreign owner gets THEIR total.
  { name: "employees:count", call: (a) => a.query(api.employees.count, {}), expect: { ...VIEWER, foreign: "ok" } },
  { name: "fleet:count", call: (a) => a.query(api.fleet.count, {}), expect: { ...VIEWER, foreign: "ok" } },
  { name: "apps:count", call: (a) => a.query(api.apps.count, { archived: false }), expect: { ...VIEWER, foreign: "ok" } },
  { name: "employees:options", call: (a) => a.query(api.employees.options, {}), expect: { ...VIEWER, foreign: "ok" } },
  { name: "employees:get", call: (a, f) => a.query(api.employees.get, { employeeId: f.employeeId }), expect: { ...VIEWER, foreign: "not_found" } },
  {
    name: "employees:create",
    call: (a) =>
      a.action(api.employees.create, { name: "New", username: `new.${Math.random().toString(36).slice(2, 10)}`, groupIds: [] }),
    expect: { ...ADMIN_UNLOCKED, foreign: "ok", ownerSuspended: "plan_limit" },
  },
  {
    name: "employees:update",
    call: (a, f) => a.mutation(api.employees.update, { employeeId: f.employeeId, expectedRevision: 0, name: "Maya", username: "maya" }),
    expect: { ...ADMIN_UNLOCKED, foreign: "not_found" },
  },
  {
    name: "employees:save",
    call: (a, f) =>
      a.mutation(api.employees.save, { employeeId: f.employeeId, expectedRevision: 0, name: "Maya", username: "maya", groupIds: [], appIds: [] }),
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
      disabled: "forbidden",
      foreign: "not_found",
    },
  },
  // ---- Step 17: install status, overview, audit, history (all viewer queries; the foreign owner reads THEIR data).
  { name: "apps:installSummary", call: (a, f) => a.query(api.apps.installSummary, { appId: f.appId }), expect: { ...VIEWER, foreign: "not_found" } },
  {
    name: "apps:installs",
    call: (a, f) => a.query(api.apps.installs, { appId: f.appId, state: "failed", paginationOpts: { numItems: 10, cursor: null } }),
    expect: { ...VIEWER, foreign: "not_found" },
  },
  {
    name: "fleet:installs",
    call: (a, f) => a.query(api.fleet.installs, { deviceId: f.deviceId, paginationOpts: { numItems: 10, cursor: null } }),
    expect: { ...VIEWER, foreign: "not_found" },
  },
  { name: "overview:get", call: (a) => a.query(api.overview.get, {}), expect: { ...VIEWER, foreign: "ok" } },
  {
    name: "overview:failedInstallsPage",
    call: (a) => a.query(api.overview.failedInstallsPage, { paginationOpts: { numItems: 10, cursor: null } }),
    expect: { ...VIEWER, foreign: "ok" },
  },
  { name: "audit:list", call: (a) => a.query(api.audit.list, { paginationOpts: { numItems: 10, cursor: null } }), expect: { ...VIEWER, foreign: "ok" } },
  {
    name: "audit:forTarget",
    call: (a, f) => a.query(api.audit.forTarget, { targetId: f.deviceId, paginationOpts: { numItems: 10, cursor: null } }),
    expect: { ...VIEWER, foreign: "ok" }, // the foreign owner asks for THEIR history of that id: empty
  },
];

/** Member writes that are entry points of step-up themselves (no step-up level). */
export const STEP_UP_EXEMPT = new Set([
  "stepUp:lock", "stepUp:setActionPin", "stepUp:verifyActionPin", "stepUp:resetWithRecoveryCode",
  "passkeys:beginRegistration", "passkeys:finishRegistration", "passkeys:beginVerification", "passkeys:finishVerification",
  // A view aid of the device page (renews watch mode while the page is visible; the page is hidden when locked).
  "fleet:watch",
  // not member functions
  "account:redeemReset", "account:requestPinReset", "account:redeemPinReset", "enrollment:enroll", "devices:heartbeat", "devices:unenroll", "devices:ping",
  "deviceApi:verifyEmployee", "deviceApi:report", "deviceApi:reportAudit", "deviceApi:reportInstalls", "deviceApi:rotateCredential",
  "deviceApi:reportApply", "deviceApi:reportFindings", "deviceApi:reportSecurityDaily", "deviceApi:reportAcks", "deviceApi:registerSealKey",
]);

export async function outcome(p: Promise<unknown>): Promise<{ result: string; value: unknown }> {
  try {
    const value = await p;
    // `kind` is the Phase 2 wire answer of the device functions; `apps:get` and `networks:printerDetail` have a `kind` field of their own.
    if (value !== null && typeof value === "object" && "kind" in value && !["ok", "web", "desktop", "ipp", "raw", "lpr", "share", "inf", "exe", "msi"].includes((value as { kind: string }).kind)) {
      return { result: `kind:${(value as { kind: string }).kind}`, value };
    }
    return { result: "ok", value };
  } catch (e) {
    return { result: codeOf(e) ?? `error:${String(e).slice(0, 80)}`, value: null };
  }
}

export type Registered = { isPublic?: boolean; isInternal?: boolean; isQuery?: boolean; isMutation?: boolean; isAction?: boolean };

/** Every registered function of the app's modules for which `pick` is true, by `file:name`. */
async function registeredFunctions(pick: (f: Registered) => boolean): Promise<Map<string, Registered>> {
  const out = new Map<string, Registered>();
  for (const [path, load] of Object.entries(modules)) {
    if (path.includes(".test.") || path.includes("test.setup") || path.includes("/_generated/") || path.includes("/lib/")) continue;
    if (/\/(convex\.config|auth\.config|schema|crons|http)\.ts$/.test(path)) continue;
    const mod = (await load()) as Record<string, unknown>;
    const file = path.replace(/^\.\//, "").replace(/\.[jt]s$/, "");
    for (const [name, fn] of Object.entries(mod)) {
      const f = fn as Registered;
      if (typeof fn === "function" && pick(f)) out.set(`${file}:${name}`, f);
    }
  }
  return out;
}

export async function publicFunctions(): Promise<Map<string, Registered>> {
  return await registeredFunctions((f) => f.isPublic === true);
}

/** Internal queries, mutations and actions (scheduler, CLI, other functions), by `file:name`. */
export async function internalFunctions(): Promise<Map<string, Registered>> {
  return await registeredFunctions((f) => f.isInternal === true);
}

/**
 * The exact expected answer of `caller` for `row`. The owner of a suspended organization acts on
 * THEIR organization, so it answers like the foreign owner unless the row says otherwise.
 */
export function expectedFor(row: Row, caller: Caller): string {
  if (caller === "ownerSuspended") return row.expect.ownerSuspended ?? row.expect.foreign ?? row.expect.default;
  return row.expect[caller] ?? row.expect.default;
}

export const creds = (f: Fixture) => ({ deviceId: f.deviceId, deviceSecret: f.deviceSecret });

/** Device functions are called with the REAL credentials of the fixture's device (the matrix rows present a wrong secret). */
export const DEVICE_CALLS: Record<string, (f: Fixture, c?: { deviceId: string; deviceSecret: string }) => Promise<() => Promise<unknown>>> = {
  "devices:desiredState": async (f, c = creds(f)) => () => f.t.query(api.devices.desiredState, c),
  "devices:headState": async (f, c = creds(f)) => () => f.t.query(api.devices.headState, c),
  "devices:fetchDesired": async (f, c = creds(f)) => () => f.t.query(api.devices.fetchDesired, { ...c, version: 1 }),
  "devices:fetchRoster": async (f, c = creds(f)) => () => f.t.query(api.devices.fetchRoster, { ...c, sinceEpoch: 0 }),
  "devices:heartbeat": async (f, c = creds(f)) => () => f.t.mutation(api.devices.heartbeat, c),
  "devices:ping": async (f, c = creds(f)) => () => f.t.mutation(api.devices.ping, c),
  "devices:unenroll": async (f, c = creds(f)) => () => f.t.mutation(api.devices.unenroll, c),
  "deviceApi:verifyEmployee": async (f, c = creds(f)) => () => f.t.action(api.deviceApi.verifyEmployee, { ...c, username: "maya", password: "not the password" }),
  "deviceApi:report": async (f, c = creds(f)) => () => f.t.mutation(api.deviceApi.report, c),
  "deviceApi:reportAudit": async (f, c = creds(f)) => () => f.t.mutation(api.deviceApi.reportAudit, { ...c, records: [], dropped: 0 }),
  "deviceApi:reportInstalls": async (f, c = creds(f)) => () => f.t.mutation(api.deviceApi.reportInstalls, { ...c, results: [] }),
  "deviceApi:rotateCredential": async (f, c = creds(f)) => () => f.t.mutation(api.deviceApi.rotateCredential, { ...c, newSecretHash: sha256HexSync("a new secret") }),
  "deviceApi:reportApply": async (f, c = creds(f)) => () => f.t.mutation(api.deviceApi.reportApply, { ...c, ...APPLY_REPORT }),
  "deviceApi:reportFindings": async (f, c = creds(f)) => () => f.t.mutation(api.deviceApi.reportFindings, { ...c, findings: [FINDING] }),
  "deviceApi:reportSecurityDaily": async (f, c = creds(f)) => () => f.t.mutation(api.deviceApi.reportSecurityDaily, { ...c, ...SECURITY_DAILY }),
  "deviceApi:reportAcks": async (f, given) => {
    const c = given ?? creds(f);
    // With credentials passed in (the cross-organization walk, which must leave the fixture untouched) nothing is seeded.
    if (given !== undefined) return () => f.t.mutation(api.deviceApi.reportAcks, { ...c, acks: [{ broadcastId: "jh7bp5vtxgdvg1vq4dzkrymc8s8gvwzm", atMs: Date.now() }] });
    // A live broadcast aimed at the device's group: the one acknowledgement is stored.
    const broadcastId = await f.t.run((ctx) =>
      ctx.db.insert("broadcasts", {
        orgId: f.orgId,
        target: { kind: "group", id: f.groupId },
        style: "banner",
        title: "Hello",
        body: "Body",
        ackRequired: true,
        createdAt: Date.now() - 1000,
      }),
    );
    return () => f.t.mutation(api.deviceApi.reportAcks, { ...c, acks: [{ broadcastId, atMs: Date.now() }] });
  },
  "deviceApi:registerSealKey": async (f, c = creds(f)) => () => f.t.mutation(api.deviceApi.registerSealKey, { ...c, publicKey: SEAL_PUBLIC_KEY }),
  "enrollment:enroll": async (f) => {
    const token = newToken();
    await f.t.run((ctx) =>
      ctx.db.insert("enrollmentTokens", { orgId: f.orgId, tokenHash: sha256HexSync(token), expiresAt: Date.now() + 3_600_000, usesLeft: 1, createdAt: Date.now() }),
    );
    return () =>
      f.t.mutation(api.enrollment.enroll, { token, deviceSecretHash: sha256HexSync("fresh device"), deviceName: "New PC", agentVersion: "0.4.0", compat: { blockers: [] } });
  },
};
