// Test seeding (Phase 4 Steps 18-20; replaces the Phase 2 `dev.ts`).
//
// INTERNAL functions only: nothing here is reachable from a client, only with
// `npx convex run testing:<name> '<json args>'` or from another function.
// Every handler starts with `allowTestSeed()`, which refuses with `forbidden`
// unless the deployment has the environment variable `RULEBOX_ALLOW_TEST_SEED`
// set to `1`. Set it on a DEV deployment only, and never on production:
//
//   npx convex env set RULEBOX_ALLOW_TEST_SEED 1      # before a test run
//   npx convex env remove RULEBOX_ALLOW_TEST_SEED     # after it
//
// Second safety net: every function that takes an organization refuses one
// whose name does not start with "E2E " or "Load test", so a typo in an id can
// never wipe or edit a real organization (`forbidden`).
//
// `convex/testing.test.ts` checks that every export starts with the guard.

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id, TableNames } from "./_generated/dataModel";
import { env, internalAction, type MutationCtx } from "./_generated/server";
import { internalMutation } from "./lib/functions";
import { nextRevision } from "./lib/authz";
import { sha256HexSync, normalizeEmail } from "./lib/crypto";
import { createPresence, orgPingInterval } from "./lib/presence";
import { fail } from "./lib/errors";
import { writeStatus } from "./lib/deviceReport";
import { newWaitingRow } from "./lib/lockdownSync";
import { ensureOrgRows } from "./lib/orgRows";
import { assertWithinLimit, bumpStats, ensurePlatformSettings, newOrgPlanFields } from "./lib/plans";
import { requestPublish } from "./lib/publish";
import { envPublicKey } from "./lib/signing";
import { actionPinProblem, deleteStepUpSessions, storePinHash } from "./lib/stepUp";
import { hashSecret } from "./lib/argon";
import { DEFAULT_ORG_SETTINGS } from "./lib/validators";

/** Names of organizations these helpers may touch. */
const E2E_PREFIX = "E2E ";
const LOAD_PREFIX = "Load test";
/** Devices one `seedFleet` call creates at most (one transaction). */
const MAX_FLEET = 200;
/** Rows one `deleteOrg` run deletes at most before it reschedules itself. */
const DELETE_BUDGET = 400;
/** Parents (devices, groups, employees, members) handled per batch. */
const PARENT_BATCH = 10;
const RUN_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

/** The guard. Every handler in this file calls it first. */
function allowTestSeed(): void {
  if (env.RULEBOX_ALLOW_TEST_SEED !== "1") fail("forbidden");
}

function assertTestOrg(org: Doc<"organizations">): void {
  if (!org.name.startsWith(E2E_PREFIX) && !org.name.startsWith(LOAD_PREFIX)) fail("forbidden");
}

async function loadTestOrg(ctx: Pick<MutationCtx, "db">, orgId: Id<"organizations">): Promise<Doc<"organizations">> {
  const org = await ctx.db.get(orgId);
  if (org === null) fail("not_found");
  assertTestOrg(org);
  return org;
}

// ---------------------------------------------------------------- seeding

/**
 * A new `E2E <runId>` organization and a one-time OWNER invite code for
 * `ownerEmail` (default `e2e-<runId>@example.test`), through the same code as
 * the real bootstrap (`setup:createOwnerInvite`). The organization also gets
 * the deployment's active signing key registered (when `RULEBOX_POLICY_KEY` is
 * set) so seeded devices get signed documents. The spec joins with the code,
 * then sets a known PIN with `testing:setKnownPin`.
 */
export const seedE2E = internalAction({
  args: { runId: v.string(), ownerEmail: v.optional(v.string()) },
  returns: v.object({
    orgId: v.id("organizations"),
    orgName: v.string(),
    ownerEmail: v.string(),
    inviteCode: v.string(),
    keyId: v.union(v.string(), v.null()),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{ orgId: Id<"organizations">; orgName: string; ownerEmail: string; inviteCode: string; keyId: string | null }> => {
    allowTestSeed();
    if (!RUN_ID_RE.test(args.runId)) fail("invalid_argument", { field: "runId" });
    const ownerEmail = args.ownerEmail ?? `e2e-${args.runId.toLowerCase()}@example.test`;
    const orgName = `${E2E_PREFIX}${args.runId}`;
    const invite: { orgId: Id<"organizations">; inviteCode: string } = await ctx.runAction(
      internal.setup.createOwnerInvite,
      { orgName, email: ownerEmail, allowAdditionalOrg: true },
    );
    const keyId: string | null = await ctx.runMutation(internal.testing.registerSeedKey, { orgId: invite.orgId });
    return { orgId: invite.orgId, orgName, ownerEmail, inviteCode: invite.inviteCode, keyId };
  },
});

/**
 * Register the deployment's active signing key (`RULEBOX_POLICY_KEY`) as the
 * organization's active key when it has none. Returns the key id, or null when
 * the deployment has no seed. Used by `seedE2E` and `seedFleet`.
 */
export const registerSeedKey = internalMutation({
  args: { orgId: v.id("organizations") },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    allowTestSeed();
    const org = await loadTestOrg(ctx, args.orgId);
    return await registerKey(ctx, org._id);
  },
});

async function registerKey(ctx: Pick<MutationCtx, "db">, orgId: Id<"organizations">): Promise<string | null> {
  const key = envPublicKey("active");
  if (key === null) return null;
  const active = await ctx.db
    .query("policyKeys")
    .withIndex("by_org_status", (q) => q.eq("orgId", orgId).eq("status", "active"))
    .first();
  if (active !== null) return active.keyId;
  await ctx.db.insert("policyKeys", {
    orgId,
    keyId: key.keyId,
    publicKey: key.publicKey,
    status: "active",
    createdAt: Date.now(),
  });
  return key.keyId;
}

/**
 * Set a KNOWN action PIN for a member of a test organization (replaces the old
 * TOTP-code helper; Phase 4b). Hashes with Argon2id like `stepUp:setActionPin`.
 * The member must already exist (joined with the invite). Every other session
 * of that person loses its unlock.
 */
export const setKnownPin = internalAction({
  args: { orgId: v.id("organizations"), email: v.string(), pin: v.string() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    allowTestSeed();
    const problem = actionPinProblem(args.pin);
    if (problem !== null) fail("invalid_argument", { field: "pin", detail: problem });
    const hash = await hashSecret(ctx, args.pin);
    await ctx.runMutation(internal.testing.storeKnownPin, { orgId: args.orgId, email: args.email, hash });
    return null;
  },
});

export const storeKnownPin = internalMutation({
  args: { orgId: v.id("organizations"), email: v.string(), hash: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    allowTestSeed();
    const org = await loadTestOrg(ctx, args.orgId);
    if (!args.hash.startsWith("$argon2id$")) fail("invalid_argument", { field: "hash" });
    const email = normalizeEmail(args.email);
    if (email === null) fail("invalid_argument", { field: "email" });
    const member = await ctx.db
      .query("members")
      .withIndex("by_org_email", (q) => q.eq("orgId", org._id).eq("email", email))
      .first();
    if (member === null) fail("not_found");
    await storePinHash(ctx, member.userId, args.hash, Date.now());
    await deleteStepUpSessions(ctx, member.userId);
    return null;
  },
});

/** One test device exactly as `enrollment:enroll` leaves it (without the rate limit and the code). */
async function insertDevice(
  ctx: MutationCtx,
  a: { orgId: Id<"organizations">; groupId?: Id<"groups">; name: string; secret: string; tokenId: Id<"enrollmentTokens">; now: number; intervalMs: number },
): Promise<Id<"devices">> {
  const deviceId = await ctx.db.insert("devices", {
    orgId: a.orgId,
    groupId: a.groupId,
    name: a.name,
    enrolledAt: a.now,
    enrollmentTokenId: a.tokenId,
  });
  const ids = { deviceId, orgId: a.orgId };
  if (a.groupId !== undefined) await ctx.db.insert("deviceLockdownSync", newWaitingRow({ _id: deviceId, orgId: a.orgId }, a.groupId, a.now));
  await ctx.db.insert("deviceCredentials", { ...ids, secretHash: sha256HexSync(a.secret), state: "active" });
  await createPresence(ctx, ids, a.now, a.intervalMs);
  await writeStatus(ctx, ids, { agentVersion: "0.4.0", compat: { blockers: [] } }, a.now, { counters: false });
  return deviceId;
}

/** A spent enrollment token for the seeded devices to point at (`devices.enrollmentTokenId` is required). */
async function spentToken(ctx: MutationCtx, orgId: Id<"organizations">, now: number, groupId?: Id<"groups">) {
  return await ctx.db.insert("enrollmentTokens", {
    orgId,
    tokenHash: sha256HexSync(`testing:${orgId}:${now}:${groupId ?? ""}`),
    expiresAt: 0,
    usesLeft: 0,
    groupId,
    createdAt: now,
  });
}

/**
 * A fake device with a KNOWN secret in a test organization (optionally in a
 * group). It counts against the plan like a real one. The device sends its
 * secret itself afterwards; only the SHA-256 is stored.
 */
export const seedDevice = internalMutation({
  args: {
    orgId: v.id("organizations"),
    secret: v.string(),
    name: v.optional(v.string()),
    groupId: v.optional(v.id("groups")),
  },
  returns: v.object({ deviceId: v.id("devices") }),
  handler: async (ctx, args) => {
    allowTestSeed();
    const org = await loadTestOrg(ctx, args.orgId);
    if (args.secret.length < 16 || args.secret.length > 200) fail("invalid_argument", { field: "secret" });
    if (args.groupId !== undefined) {
      const group = await ctx.db.get(args.groupId);
      if (group === null || group.orgId !== org._id) fail("not_found");
    }
    const taken = await ctx.db
      .query("deviceCredentials")
      .withIndex("by_secret_hash", (q) => q.eq("secretHash", sha256HexSync(args.secret)))
      .first();
    if (taken !== null) fail("conflict", { detail: "secret already in use" });
    const now = Date.now();
    const stats = await assertWithinLimit(ctx, org._id, "devices");
    const tokenId = await spentToken(ctx, org._id, now, args.groupId);
    const deviceId = await insertDevice(ctx, {
      orgId: org._id,
      groupId: args.groupId,
      name: args.name ?? "Test PC",
      secret: args.secret,
      tokenId,
      now,
      intervalMs: await orgPingInterval(ctx, org._id),
    });
    await bumpStats(ctx, stats, {
      deviceCount: 1,
      noGroupDeviceCount: args.groupId === undefined ? 1 : 0,
    });
    await requestPublish(ctx, org._id, { deviceIds: [deviceId] });
    return { deviceId };
  },
});

/**
 * A separate "Load test" organization (unlimited `custom` plan, a Default
 * group, the deployment's signing key) with `count` devices (1 to 200) and
 * KNOWN secrets `fleet-<orgId>-<n>`. Returns the secrets for the load script
 * (`scripts/fleet-sim.mjs`). Remove it with `testing:deleteOrg`.
 */
export const seedFleet = internalMutation({
  args: { count: v.number(), runId: v.optional(v.string()) },
  returns: v.object({
    orgId: v.id("organizations"),
    keyId: v.union(v.string(), v.null()),
    devices: v.array(v.object({ deviceId: v.id("devices"), name: v.string(), secret: v.string() })),
  }),
  handler: async (ctx, args) => {
    allowTestSeed();
    if (!Number.isInteger(args.count) || args.count < 1 || args.count > MAX_FLEET) {
      fail("invalid_argument", { field: "count" });
    }
    if (args.runId !== undefined && !RUN_ID_RE.test(args.runId)) fail("invalid_argument", { field: "runId" });
    const now = Date.now();
    const orgId = await ctx.db.insert("organizations", {
      name: args.runId === undefined ? LOAD_PREFIX : `${LOAD_PREFIX} ${args.runId}`,
      settings: DEFAULT_ORG_SETTINGS,
      revision: 0,
      createdAt: now,
    });
    // Unlimited plan first, so `ensureOrgRows` keeps it instead of the free defaults.
    const settings = await ensurePlatformSettings(ctx);
    await ctx.db.insert("orgPlans", { orgId, ...newOrgPlanFields(settings, "custom", now, "testing") });
    const groupId = await ctx.db.insert("groups", { orgId, name: "Default", revision: 0, createdAt: now, isDefault: true });
    const org = (await ctx.db.get(orgId))!;
    await ensureOrgRows(ctx, org, { updatedBy: "testing", now });
    const keyId = await registerKey(ctx, orgId);

    const intervalMs = await orgPingInterval(ctx, orgId);
    const tokenId = await spentToken(ctx, orgId, now, groupId);
    const devices: { deviceId: Id<"devices">; name: string; secret: string }[] = [];
    for (let i = 1; i <= args.count; i++) {
      const name = `Load PC ${String(i).padStart(3, "0")}`;
      const secret = `fleet-${orgId}-${i}`;
      const deviceId = await insertDevice(ctx, { orgId, groupId, name, secret, tokenId, now, intervalMs });
      devices.push({ deviceId, name, secret });
    }
    const stats = await ctx.db
      .query("orgStats")
      .withIndex("by_org", (q) => q.eq("orgId", orgId))
      .unique();
    if (stats === null) fail("not_ready", { detail: "organization counters missing" });
    await bumpStats(ctx, stats, { deviceCount: args.count });
    await requestPublish(ctx, orgId, { allDevices: true });
    return { orgId, keyId, devices };
  },
});

/**
 * One simulated admin edit: flips `offlineDays` between 3 and 4, bumps the
 * revision and queues a publish to every device (the same path as
 * `settings:update`). The load script calls it ~20 times over a run.
 */
export const simulateEdit = internalMutation({
  args: { orgId: v.id("organizations") },
  returns: v.object({ revision: v.number(), offlineDays: v.number() }),
  handler: async (ctx, args) => {
    allowTestSeed();
    const org = await loadTestOrg(ctx, args.orgId);
    const settings = org.settings ?? DEFAULT_ORG_SETTINGS;
    const offlineDays = settings.offlineDays === 3 ? 4 : 3;
    const revision = nextRevision(org);
    await ctx.db.patch(org._id, { settings: { ...settings, offlineDays }, revision });
    await requestPublish(ctx, org._id, { allDevices: true });
    return { revision, offlineDays };
  },
});

// ---------------------------------------------------------------- cleanup

type Budget = { left: number; deleted: number };
type Fetch = (n: number) => Promise<{ _id: Id<TableNames> }[]>;

/**
 * Delete up to the remaining budget of the rows `fetch` returns. True when
 * `fetch` ran dry (nothing of it is left); false when the budget ran out
 * first, so there may be more.
 */
async function drain(ctx: MutationCtx, b: Budget, fetch: Fetch): Promise<boolean> {
  if (b.left <= 0) return false;
  const want = b.left;
  const rows = await fetch(want);
  for (const row of rows) await ctx.db.delete(row._id as Id<never>);
  b.left -= rows.length;
  b.deleted += rows.length;
  return rows.length < want;
}

async function dropRow(ctx: MutationCtx, b: Budget, id: Id<TableNames>): Promise<void> {
  await ctx.db.delete(id as Id<never>);
  b.left -= 1;
  b.deleted += 1;
}

/** Fetchers for the rows hanging off one device. */
function deviceChildren(ctx: MutationCtx, deviceId: Id<"devices">): Fetch[] {
  const db = ctx.db;
  const scope: string = deviceId;
  return [
    (n) => db.query("deviceCredentials").withIndex("by_device", (q) => q.eq("deviceId", deviceId)).take(n),
    (n) => db.query("deviceLiveness").withIndex("by_device", (q) => q.eq("deviceId", deviceId)).take(n),
    (n) => db.query("devicePresence").withIndex("by_device", (q) => q.eq("deviceId", deviceId)).take(n),
    (n) => db.query("deviceSummary").withIndex("by_device", (q) => q.eq("deviceId", deviceId)).take(n),
    (n) => db.query("deviceReports").withIndex("by_device", (q) => q.eq("deviceId", deviceId)).take(n),
    (n) => db.query("deviceStatus").withIndex("by_device", (q) => q.eq("deviceId", deviceId)).take(n),
    (n) => db.query("desiredHeads").withIndex("by_device", (q) => q.eq("deviceId", deviceId)).take(n),
    (n) => db.query("desiredBodies").withIndex("by_device_version", (q) => q.eq("deviceId", deviceId)).take(n),
    (n) => db.query("desiredVersions").withIndex("by_device_version", (q) => q.eq("deviceId", deviceId)).take(n),
    (n) => db.query("installResults").withIndex("by_device_updated", (q) => q.eq("deviceId", deviceId)).take(n),
    (n) => db.query("driverResults").withIndex("by_device_driver", (q) => q.eq("deviceId", deviceId)).take(n),
    // Phase 5 (Step 20b): the PC's apply report, daily counters, lock, findings seen and sealed Wi-Fi boxes.
    (n) => db.query("deviceApplyReports").withIndex("by_device", (q) => q.eq("deviceId", deviceId)).take(n),
    (n) => db.query("deviceLockdownSync").withIndex("by_device", (q) => q.eq("deviceId", deviceId)).take(n),
    (n) => db.query("deviceSecurityDaily").withIndex("by_device_day", (q) => q.eq("deviceId", deviceId)).take(n),
    (n) => db.query("deviceLocks").withIndex("by_device", (q) => q.eq("deviceId", deviceId)).take(n),
    (n) => db.query("lockdownFindingDevices").withIndex("by_device", (q) => q.eq("deviceId", deviceId)).take(n),
    (n) => db.query("deviceSealedSecrets").withIndex("by_device_target", (q) => q.eq("deviceId", deviceId)).take(n),
    (n) => db.query("desiredStates").withIndex("by_device_version", (q) => q.eq("deviceId", deviceId)).take(n),
    (n) => db.query("desiredStates").withIndex("by_scope_version", (q) => q.eq("scope", scope)).take(n),
  ];
}

/** Everything of a person that is not an organization row (account, sessions, PIN, passkeys). */
function userChildren(ctx: MutationCtx, userId: Id<"users">): Fetch[] {
  const db = ctx.db;
  return [
    (n) => db.query("stepUpFactors").withIndex("by_user", (q) => q.eq("userId", userId)).take(n),
    (n) => db.query("pinCounters").withIndex("by_user", (q) => q.eq("userId", userId)).take(n),
    (n) => db.query("pinResets").withIndex("by_user_created", (q) => q.eq("userId", userId)).take(n),
    (n) => db.query("passkeys").withIndex("by_user", (q) => q.eq("userId", userId)).take(n),
    (n) => db.query("stepUpSessions").withIndex("by_user", (q) => q.eq("userId", userId)).take(n),
    (n) => db.query("stepUpChallenges").withIndex("by_user", (q) => q.eq("userId", userId)).take(n),
  ];
}

/**
 * Walk the organization's rows children first. True when everything is gone
 * (the organization row itself is deleted by the caller), false when the
 * budget ran out.
 */
async function sweepOrg(ctx: MutationCtx, orgId: Id<"organizations">, b: Budget): Promise<boolean> {
  const db = ctx.db;

  // Devices with their per-device rows.
  for (;;) {
    if (b.left <= 0) return false;
    const batch = await db.query("devices").withIndex("by_org", (q) => q.eq("orgId", orgId)).take(PARENT_BATCH);
    if (batch.length === 0) break;
    for (const device of batch) {
      for (const fetch of deviceChildren(ctx, device._id)) if (!(await drain(ctx, b, fetch))) return false;
      await dropRow(ctx, b, device._id);
    }
  }

  // Groups with their members, assignments and roster log.
  for (;;) {
    if (b.left <= 0) return false;
    const batch = await db.query("groups").withIndex("by_org", (q) => q.eq("orgId", orgId)).take(PARENT_BATCH);
    if (batch.length === 0) break;
    for (const group of batch) {
      const id = group._id;
      const fetches: Fetch[] = [
        (n) => db.query("groupMembers").withIndex("by_group", (q) => q.eq("groupId", id)).take(n),
        (n) => db.query("appAssignments").withIndex("by_group", (q) => q.eq("groupId", id)).take(n),
        (n) => db.query("rosterEntries").withIndex("by_group_epoch", (q) => q.eq("groupId", id)).take(n),
        // Phase 5 (Step 20b): its lockdown settings, rollout row and configuration versions.
        (n) => db.query("groupLockdown").withIndex("by_group", (q) => q.eq("groupId", id)).take(n),
        (n) => db.query("groupRollouts").withIndex("by_group", (q) => q.eq("groupId", id)).take(n),
        (n) => db.query("groupConfigs").withIndex("by_group_version", (q) => q.eq("groupId", id)).take(n),
      ];
      for (const fetch of fetches) if (!(await drain(ctx, b, fetch))) return false;
      const roster = await db.query("groupRoster").withIndex("by_group", (q) => q.eq("groupId", id)).first();
      if (roster !== null) {
        if (roster.snapshotId !== undefined && (await db.get(roster.snapshotId)) !== null) {
          await dropRow(ctx, b, roster.snapshotId);
        }
        await dropRow(ctx, b, roster._id);
      }
      await dropRow(ctx, b, id);
    }
  }

  // Employees with their secrets, lockouts and grants.
  for (;;) {
    if (b.left <= 0) return false;
    const batch = await db.query("employees").withIndex("by_org", (q) => q.eq("orgId", orgId)).take(PARENT_BATCH);
    if (batch.length === 0) break;
    for (const employee of batch) {
      const id = employee._id;
      const fetches: Fetch[] = [
        (n) => db.query("employeeSecrets").withIndex("by_employee", (q) => q.eq("employeeId", id)).take(n),
        (n) => db.query("employeeLockouts").withIndex("by_employee", (q) => q.eq("employeeId", id)).take(n),
        (n) => db.query("employeeApps").withIndex("by_employee", (q) => q.eq("employeeId", id)).take(n),
        (n) => db.query("groupMembers").withIndex("by_employee", (q) => q.eq("employeeId", id)).take(n),
      ];
      for (const fetch of fetches) if (!(await drain(ctx, b, fetch))) return false;
      await dropRow(ctx, b, id);
    }
  }

  // Phase 5 (Step 20b): broadcasts with their acknowledgements.
  for (;;) {
    if (b.left <= 0) return false;
    const batch = await db.query("broadcasts").withIndex("by_org_created", (q) => q.eq("orgId", orgId)).take(PARENT_BATCH);
    if (batch.length === 0) break;
    for (const broadcast of batch) {
      const id = broadcast._id;
      const fetch: Fetch = (n) => db.query("broadcastAcks").withIndex("by_broadcast", (q) => q.eq("broadcastId", id)).take(n);
      if (!(await drain(ctx, b, fetch))) return false;
      await dropRow(ctx, b, id);
    }
  }

  // The rows that carry the organization id directly.
  const direct: Fetch[] = [
    (n) => db.query("installResults").withIndex("by_org_state_updated", (q) => q.eq("orgId", orgId)).take(n),
    (n) => db.query("rosterPending").withIndex("by_org", (q) => q.eq("orgId", orgId)).take(n),
    (n) => db.query("fileHandlers").withIndex("by_org_ext", (q) => q.eq("orgId", orgId)).take(n),
    (n) => db.query("apps").withIndex("by_org", (q) => q.eq("orgId", orgId)).take(n),
    (n) => db.query("drivers").withIndex("by_org", (q) => q.eq("orgId", orgId)).take(n),
    (n) => db.query("enrollmentTokens").withIndex("by_org", (q) => q.eq("orgId", orgId)).take(n),
    (n) => db.query("invites").withIndex("by_org", (q) => q.eq("orgId", orgId)).take(n),
    (n) => db.query("publishQueue").withIndex("by_org", (q) => q.eq("orgId", orgId)).take(n),
    (n) => db.query("policyKeys").withIndex("by_org_key_id", (q) => q.eq("orgId", orgId)).take(n),
    (n) => db.query("auditLog").withIndex("by_org_at", (q) => q.eq("orgId", orgId)).take(n),
    (n) => db.query("orgPresence").withIndex("by_org_shard", (q) => q.eq("orgId", orgId)).take(n),
    (n) => db.query("deviceLiveness").withIndex("by_org", (q) => q.eq("orgId", orgId)).take(n),
    (n) => db.query("deviceStatus").withIndex("by_org_last_seen", (q) => q.eq("orgId", orgId)).take(n),
    // Phase 5 (Step 20b). `drivers` is above; the per-PC rows went with the devices, the per-group rows with the groups.
    (n) => db.query("wifiProfiles").withIndex("by_org", (q) => q.eq("orgId", orgId)).take(n),
    (n) => db.query("printers").withIndex("by_org", (q) => q.eq("orgId", orgId)).take(n),
    (n) => db.query("lockdownExceptions").withIndex("by_org_group", (q) => q.eq("orgId", orgId)).take(n),
    (n) => db.query("lockdownFindings").withIndex("by_org_fingerprint", (q) => q.eq("orgId", orgId)).take(n),
    (n) => db.query("orgSecurityDaily").withIndex("by_org_day", (q) => q.eq("orgId", orgId)).take(n),
    (n) => db.query("orgKeys").withIndex("by_org_purpose_status", (q) => q.eq("orgId", orgId)).take(n),
    (n) => db.query("deviceApplyReports").withIndex("by_org_config", (q) => q.eq("orgId", orgId)).take(n),
    (n) => db.query("deviceSecurityDaily").withIndex("by_org_day", (q) => q.eq("orgId", orgId)).take(n),
    (n) => db.query("deviceLocks").withIndex("by_org", (q) => q.eq("orgId", orgId)).take(n),
  ];
  for (const fetch of direct) if (!(await drain(ctx, b, fetch))) return false;

  // Members, and the person behind each one when this was their only organization.
  for (;;) {
    if (b.left <= 0) return false;
    const batch = await db.query("members").withIndex("by_org_user", (q) => q.eq("orgId", orgId)).take(PARENT_BATCH);
    if (batch.length === 0) break;
    for (const member of batch) {
      const memberships = await db.query("members").withIndex("by_user", (q) => q.eq("userId", member.userId)).take(2);
      if (memberships.every((m) => m._id === member._id)) {
        if (!(await dropUser(ctx, b, member.userId))) return false;
      }
      await dropRow(ctx, b, member._id);
    }
  }

  // The one-per-organization rows.
  const last: Fetch[] = [
    (n) => db.query("orgSecrets").withIndex("by_org", (q) => q.eq("orgId", orgId)).take(n),
    (n) => db.query("orgStats").withIndex("by_org", (q) => q.eq("orgId", orgId)).take(n),
    (n) => db.query("orgPlans").withIndex("by_org", (q) => q.eq("orgId", orgId)).take(n),
  ];
  for (const fetch of last) if (!(await drain(ctx, b, fetch))) return false;
  return b.left > 0;
}

/** Delete a person's step-up rows, sessions (with refresh tokens), sign-in accounts and the user row. */
async function dropUser(ctx: MutationCtx, b: Budget, userId: Id<"users">): Promise<boolean> {
  const db = ctx.db;
  for (const fetch of userChildren(ctx, userId)) if (!(await drain(ctx, b, fetch))) return false;
  for (;;) {
    if (b.left <= 0) return false;
    const sessions = await db.query("authSessions").withIndex("userId", (q) => q.eq("userId", userId)).take(PARENT_BATCH);
    if (sessions.length === 0) break;
    for (const s of sessions) {
      const fetch: Fetch = (n) => db.query("authRefreshTokens").withIndex("sessionId", (q) => q.eq("sessionId", s._id)).take(n);
      if (!(await drain(ctx, b, fetch))) return false;
      await dropRow(ctx, b, s._id);
    }
  }
  for (;;) {
    if (b.left <= 0) return false;
    const accounts = await db.query("authAccounts").withIndex("userIdAndProvider", (q) => q.eq("userId", userId)).take(PARENT_BATCH);
    if (accounts.length === 0) break;
    for (const a of accounts) {
      const fetch: Fetch = (n) => db.query("authVerificationCodes").withIndex("accountId", (q) => q.eq("accountId", a._id)).take(n);
      if (!(await drain(ctx, b, fetch))) return false;
      await dropRow(ctx, b, a._id);
    }
  }
  if ((await db.get(userId)) !== null) await dropRow(ctx, b, userId);
  return true;
}

/**
 * Delete a TEST organization and everything under it, in bounded batches:
 * one run deletes at most 400 rows, then schedules itself again. Returns
 * `{ done, deleted }` for this run; call it again (or wait) until `done`.
 * The organization row goes last, so an interrupted run resumes by itself.
 * Not removed (no index to find them by organization): the pruned-daily
 * `fleetChecks` rows and a group's older roster snapshots. Phase 5 tables (Step 20b): all are removed (wifiProfiles, printers,
 * drivers, driverResults, deviceSealedSecrets, deviceApplyReports, deviceSecurityDaily, orgSecurityDaily, deviceLocks, lockdown*,
 * groupLockdown / groupRollouts / groupConfigs, broadcasts and broadcastAcks, orgKeys).
 */
export const deleteOrg = internalMutation({
  args: { orgId: v.id("organizations") },
  returns: v.object({ done: v.boolean(), deleted: v.number() }),
  handler: async (ctx, args) => {
    allowTestSeed();
    const org = await ctx.db.get(args.orgId);
    if (org === null) return { done: true, deleted: 0 };
    assertTestOrg(org);
    const b: Budget = { left: DELETE_BUDGET, deleted: 0 };
    if (await sweepOrg(ctx, org._id, b)) {
      await ctx.db.delete(org._id);
      return { done: true, deleted: b.deleted + 1 };
    }
    await ctx.scheduler.runAfter(0, internal.testing.deleteOrg, { orgId: org._id });
    return { done: false, deleted: b.deleted };
  },
});
