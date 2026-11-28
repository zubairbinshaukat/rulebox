import { calculateRateLimit } from "@convex-dev/rate-limiter";
import { x25519 } from "@noble/curves/ed25519.js";
import { v, type Infer } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { type DatabaseWriter } from "./_generated/server";
import { DUMMY_PHC, verifier } from "./lib/argon";
import { writeAudit, type AuditActor } from "./lib/audit";
import { checkDevice } from "./lib/deviceAuth";
import { MAX_VERSION_CHARS } from "./lib/feed/version";
import {
  actionOfKind,
  BYTES_PER_GB,
  cleanDetail,
  cleanUsername,
  EMPLOYEE_LOCK_MS,
  EMPLOYEE_MAX_FAILURES,
  INSTALL_DETAILS,
  isCount,
  MAX_INSTALL_DETAIL,
  MAX_REPORT_AUDIT,
  MAX_REPORT_INSTALLS,
  recordSummary,
  recordTime,
  isStoredInstallState,
  type StoredInstallState,
  validRecordId,
  VERIFY_RESERVE_BELOW,
} from "./lib/deviceApiRules";
import { cleanCapabilities, statusValidator, writeStatus } from "./lib/deviceReport";
import { setSyncRow, syncFieldsOf } from "./lib/lockdownSync";
import { layerStates } from "./lib/lockdownValidators";
import {
  addBlocked,
  applyStateOf,
  cleanCode,
  cleanDaily,
  cleanFindings,
  cleanItems,
  cleanLayer,
  isZeroDaily,
  mergeDenials,
  ringOf,
} from "./lib/lockdownReports";
import { decodeSealPublicKey, sealKeyIdOf } from "./lib/sealbox";
import { normalizeUsername } from "./lib/employeeRules";
import { fail } from "./lib/errors";
import { type DeviceIdentity, deviceMutation, deviceSelfCheckedAction, internalMutation, internalQuery } from "./lib/functions";
import { MAX_ACKS_PER_CALL, MAX_DEVICE_WIFI, MAX_EMPLOYEE_PASSWORD, MAX_PERMISSION_DENIALS, MAX_USERNAME } from "./lib/limits";
import { liveChecker } from "./lib/installs";
import { scopedDb } from "./lib/orgDb";
import { bumpOrgStatsIfPresent } from "./lib/plans";
import { contactDue, recordContact } from "./lib/presence";
import { consumeOrFail, consumeQuietly, rateLimiter } from "./lib/rateLimits";
import { sha256HexSync } from "./lib/crypto";
import { DEFAULT_ORG_SETTINGS } from "./lib/validators";

// The agent's device API (plan Step 12; 4.11, 4.12, 5.1 as amended by A2, A9,
// A12). Every function authenticates with the device id + secret; unknown,
// wrong secret and revoked answer `device_rejected`, and each touches only the
// calling device's own rows and its organization's.
//
// Arguments here carry employee passwords and device secret hashes: nothing in
// this file logs an argument, puts one in an error or an audit entry, or
// returns one. The only secret that leaves the database is the employee's
// Argon2id hash, from `loadForVerify` to the `verifyEmployee` action (both
// server side), never to the device.

// ---------------------------------------------------------------- verifyEmployee (4.12)

const verifyAnswer = v.union(
  v.object({
    kind: v.literal("ok"),
    employee: v.object({
      id: v.string(),
      username: v.string(),
      name: v.string(),
      role: v.null(),
      quotaBytes: v.number(),
    }),
    offlineDays: v.number(),
    credentialRevision: v.number(),
  }),
  v.object({ kind: v.literal("wrongCredentials") }),
  v.object({ kind: v.literal("disabled") }),
  v.object({ kind: v.literal("notAllowedHere") }),
  v.object({ kind: v.literal("lockedOut"), retryAfterMs: v.number() }),
);
type VerifyAnswer = Infer<typeof verifyAnswer>;

const loaded = v.union(
  v.object({ kind: v.literal("rejected") }),
  // The device's `verifyPerDevice` bucket is empty, or this employee is locked.
  v.object({ kind: v.literal("lockedOut"), retryAfterMs: v.number() }),
  v.object({
    kind: v.literal("check"),
    deviceId: v.id("devices"),
    orgId: v.id("organizations"),
    /** Null for an unknown (or malformed) username. */
    employee: v.union(
      v.null(),
      v.object({
        id: v.id("employees"),
        username: v.string(),
        name: v.string(),
        disabled: v.boolean(),
        /** In the device's group (`groupMembers.by_group_employee`, server truth). */
        member: v.boolean(),
        credentialRevision: v.number(),
        quotaBytes: v.number(),
        /** Argon2id PHC; null when no password was ever set. Server side only. */
        phc: v.union(v.string(), v.null()),
        /** A lockout row exists (failures or an expired lock): a correct password deletes it. */
        lockRow: v.boolean(),
      }),
    ),
    offlineDays: v.number(),
    /** The sign-in must refresh `deviceLiveness` (it counts as a ping). */
    contactDue: v.boolean(),
    /** The device's bucket is nearly empty: take the token before the Argon2id verify. */
    reserve: v.boolean(),
    /** The device had a recent failure (bucket below capacity): re-check the lock after a correct password. */
    watch: v.boolean(),
  }),
);
type Loaded = Infer<typeof loaded>;

/**
 * Everything one sign-in needs, in ONE query (plan 4.12 step 1, A9): the
 * device check, the read-only limiter check, the employee by username, the
 * password hash, the lockout row, the membership of the device's group, the
 * organization's settings and whether liveness needs a write. `now` comes
 * from the action (no clock in a query).
 */
export const loadForVerify = internalQuery({
  args: { deviceId: v.string(), deviceSecret: v.string(), username: v.string(), now: v.number() },
  returns: loaded,
  handler: async (ctx, args): Promise<Loaded> => {
    const db = scopedDb(ctx.db, null);
    const check = await checkDevice({ db }, args);
    if (check.kind !== "ok") return { kind: "rejected" };
    const deviceId = check.cred.deviceId;
    const orgId = check.cred.orgId;
    // Read-only limiter check (one component read, like `check`), done by hand so
    // the token count is known: `getValue` is the stored value, `calculateRateLimit`
    // refills it to `now`.
    const bucket = await rateLimiter.getValue(ctx, "verifyPerDevice", { key: deviceId });
    const after = calculateRateLimit(bucket, bucket.config, args.now, 1);
    if (after.value < 0) return { kind: "lockedOut", retryAfterMs: Math.max(0, Math.ceil(after.retryAfter ?? 0)) };
    const tokens = after.value + 1;
    const capacity = bucket.config.capacity ?? bucket.config.rate;

    const device = await db.get(deviceId);
    if (device === null) return { kind: "rejected" };
    const org = await db.get(orgId);
    const settings = org?.settings ?? DEFAULT_ORG_SETTINGS;
    const liveness = await db
      .query("deviceLiveness")
      .withIndex("by_device", (q) => q.eq("deviceId", deviceId))
      .unique();
    const base = {
      kind: "check" as const,
      deviceId,
      orgId,
      offlineDays: settings.offlineDays,
      contactDue: contactDue(liveness, args.now),
      reserve: tokens < VERIFY_RESERVE_BELOW,
      watch: tokens < capacity,
    };

    const username = args.username.length <= 4 * MAX_USERNAME ? normalizeUsername(args.username) : "";
    if (username.length < 1 || username.length > MAX_USERNAME) return { ...base, employee: null };
    const e = await db
      .query("employees")
      .withIndex("by_org_username", (q) => q.eq("orgId", orgId).eq("username", username))
      .first();
    if (e === null) return { ...base, employee: null };

    const lock = await db
      .query("employeeLockouts")
      .withIndex("by_employee", (q) => q.eq("employeeId", e._id))
      .unique();
    if (lock !== null && lock.lockedUntil > args.now) return { kind: "lockedOut", retryAfterMs: lock.lockedUntil - args.now };
    const secret = await db
      .query("employeeSecrets")
      .withIndex("by_employee", (q) => q.eq("employeeId", e._id))
      .unique();
    const groupId = device.groupId;
    const membership =
      groupId === undefined
        ? null
        : await db
            .query("groupMembers")
            .withIndex("by_group_employee", (q) => q.eq("groupId", groupId).eq("employeeId", e._id))
            .first();
    return {
      ...base,
      employee: {
        id: e._id,
        username: e.username,
        name: e.name,
        disabled: e.disabled,
        member: membership !== null && membership.orgId === orgId,
        credentialRevision: e.credentialRevision,
        quotaBytes: (e.quotaGb ?? settings.defaultQuotaGb) * BYTES_PER_GB,
        phc: secret?.passwordHash ?? null,
        lockRow: lock !== null,
      },
    };
  },
});

/**
 * The writes of a sign-in, only when there is one (A9): liveness when due; on
 * a wrong password the device's limiter token and the employee's failure
 * count (the 10th locks for 15 minutes and audits `employee.lockedOut`); on a
 * correct one the failure count is cleared. Answers `locked` when the
 * employee is locked by now (a parallel attempt locked them first).
 */
export const finishVerify = internalMutation({
  args: {
    deviceId: v.id("devices"),
    orgId: v.id("organizations"),
    employeeId: v.optional(v.id("employees")),
    failed: v.boolean(),
    contact: v.boolean(),
    /** The attempt's limiter token was already taken before the verify (`reserveAttempt`). */
    spent: v.optional(v.boolean()),
  },
  returns: v.union(
    v.object({ kind: v.literal("done") }),
    v.object({ kind: v.literal("rejected") }),
    v.object({ kind: v.literal("locked"), retryAfterMs: v.number() }),
  ),
  handler: async (ctx, args) => {
    const now = Date.now();
    const db = scopedDb(ctx.db, null);
    // Revoked while the password was being checked: nothing is written.
    const cred = await db
      .query("deviceCredentials")
      .withIndex("by_device", (q) => q.eq("deviceId", args.deviceId))
      .unique();
    const legacy = cred === null ? await db.get(args.deviceId) : null;
    const revoked = cred !== null ? cred.state === "revoked" : legacy === null || legacy.revoked === true;
    if (revoked) return { kind: "rejected" as const };
    const ids = { deviceId: args.deviceId, orgId: args.orgId };
    if (args.contact) await recordContact({ db }, ids, now);
    if (args.failed && args.spent !== true) await consumeQuietly(ctx, "verifyPerDevice", args.deviceId);
    if (args.employeeId === undefined) return { kind: "done" as const };

    const employeeId = args.employeeId;
    const lock = await db
      .query("employeeLockouts")
      .withIndex("by_employee", (q) => q.eq("employeeId", employeeId))
      .unique();
    if (lock !== null && lock.lockedUntil > now) return { kind: "locked" as const, retryAfterMs: lock.lockedUntil - now };
    if (!args.failed) {
      if (lock !== null) await db.delete(lock._id);
      return { kind: "done" as const };
    }
    const failures = (lock === null || lock.lockedUntil > 0 ? 0 : lock.failures) + 1;
    const lockedUntil = failures >= EMPLOYEE_MAX_FAILURES ? now + EMPLOYEE_LOCK_MS : 0;
    const row = { failures, lastFailureAt: now, lockedUntil };
    if (lock === null) await db.insert("employeeLockouts", { employeeId, orgId: args.orgId, ...row });
    else await db.patch(lock._id, row);
    if (lockedUntil === 0) return { kind: "done" as const };
    const employee = await db.get(employeeId);
    const device = await db.get(args.deviceId);
    const deviceName = device?.name ?? "PC";
    await writeAudit({ db }, {
      orgId: args.orgId,
      actor: { type: "device", id: args.deviceId, label: deviceName },
      action: "employee.lockedOut",
      targetType: "employee",
      targetId: employeeId,
      targetLabel: employee?.name,
      summary: `${employee?.name ?? "An employee"} was locked out for 15 minutes after ${EMPLOYEE_MAX_FAILURES} wrong passwords (last on the PC ${deviceName})`,
    });
    return { kind: "locked" as const, retryAfterMs: EMPLOYEE_LOCK_MS };
  },
});

/**
 * Take one `verifyPerDevice` token BEFORE the Argon2id verify. Only called when
 * the bucket is nearly empty (`loadForVerify`), so a burst against a drained
 * bucket is serialized here and refused once it is empty.
 */
export const reserveAttempt = internalMutation({
  args: { deviceId: v.id("devices") },
  returns: v.union(v.object({ kind: v.literal("ok") }), v.object({ kind: v.literal("limited"), retryAfterMs: v.number() })),
  handler: async (ctx, args) => {
    const status = await rateLimiter.limit(ctx, "verifyPerDevice", { key: args.deviceId });
    if (!status.ok) return { kind: "limited" as const, retryAfterMs: Math.max(0, Math.ceil(status.retryAfter)) };
    return { kind: "ok" as const };
  },
});

/**
 * Check an employee's username and password for the calling device (plan
 * 4.12; device action). One Argon2id verify runs on every path that reaches
 * the check, against a fixed dummy hash when there is no employee or no
 * password, so the answer time does not tell usernames apart. `disabled` and
 * `notAllowedHere` are only answered for a CORRECT password; a wrong one is
 * always `wrongCredentials`. `lockedOut` = the employee is locked (10 wrong
 * passwords: 15 minutes) or the device's `verifyPerDevice` bucket is empty.
 * Successful sign-ins are not audited and write nothing except liveness.
 *
 * Concurrency (A9 trade-off, accepted by the owner): the limiter and the
 * lockout are read BEFORE the verify and written AFTER it, so parallel calls
 * that all load while the device's bucket still holds >= VERIFY_RESERVE_BELOW
 * tokens and the employee is unlocked all run Argon2id, and each wrong one is
 * counted when it finishes. Two cheap guards narrow it: (1) with fewer than
 * VERIFY_RESERVE_BELOW tokens left, the token is taken before the verify
 * (`reserveAttempt`), so later waves are serialized and refused when the bucket
 * is empty; (2) after a CORRECT password, when the device had any recent failure
 * (bucket below capacity), `finishVerify` re-reads the lock and the answer
 * becomes `lockedOut` if the employee was locked meanwhile. A normal sign-in
 * (full bucket) keeps its 2 calls and 0 writes. REMAINING BOUND: one first wave
 * of parallel guesses, limited only by Convex's concurrent action limit (not by
 * this code), can exceed the 10-failure lockout; a right guess inside that wave
 * is answered as if it came just before the lock. The per-device bucket (30
 * failures a minute) and the 15-minute lock bound every later wave.
 */
export const verifyEmployee = deviceSelfCheckedAction({
  args: { username: v.string(), password: v.string() },
  returns: verifyAnswer,
  handler: async (ctx, args): Promise<VerifyAnswer> => {
    const load: Loaded = await ctx.runQuery(internal.deviceApi.loadForVerify, {
      deviceId: ctx.presented.deviceId,
      deviceSecret: ctx.presented.deviceSecret,
      username: args.username,
      now: Date.now(),
    });
    if (load.kind === "rejected") fail("device_rejected");
    if (load.kind === "lockedOut") return load;

    // Nearly empty bucket: the token is taken before the verify (see above).
    let spent = false;
    if (load.reserve) {
      const taken = await ctx.runMutation(internal.deviceApi.reserveAttempt, { deviceId: load.deviceId });
      if (taken.kind === "limited") return { kind: "lockedOut", retryAfterMs: taken.retryAfterMs };
      spent = true;
    }

    const e = load.employee;
    const fits = args.password.length >= 1 && args.password.length <= MAX_EMPLOYEE_PASSWORD;
    const phc = e?.phc ?? null;
    const usable = fits && phc !== null;
    // Always exactly one verify (equal work for every username).
    const matched = await verifier.verify(fits ? args.password : "", usable ? phc : DUMMY_PHC);
    const correct = usable && matched;

    let answer: VerifyAnswer;
    if (e === null || !correct) answer = { kind: "wrongCredentials" };
    else if (e.disabled) answer = { kind: "disabled" };
    else if (!e.member) answer = { kind: "notAllowedHere" };
    else {
      answer = {
        kind: "ok",
        employee: { id: e.id, username: e.username, name: e.name, role: null, quotaBytes: e.quotaBytes },
        offlineDays: load.offlineDays,
        credentialRevision: e.credentialRevision,
      };
    }

    const failed = answer.kind === "wrongCredentials";
    const clearFailures = !failed && e !== null && e.lockRow;
    // A correct password after recent failures on this device: re-read the lock.
    const recheck = !failed && load.watch;
    if (failed || clearFailures || recheck || load.contactDue) {
      const done = await ctx.runMutation(internal.deviceApi.finishVerify, {
        deviceId: load.deviceId,
        orgId: load.orgId,
        employeeId: e?.id,
        failed,
        contact: load.contactDue,
        spent,
      });
      if (done.kind === "rejected") fail("device_rejected");
      if (done.kind === "locked") return { kind: "lockedOut", retryAfterMs: done.retryAfterMs };
    }
    return answer;
  },
});

// ---------------------------------------------------------------- report (5.1 amended, A12)

const auditRecord = v.object({
  id: v.string(),
  atMs: v.number(),
  serverTimeOffsetMs: v.optional(v.union(v.number(), v.null())),
  kind: v.string(),
  username: v.optional(v.union(v.string(), v.null())),
  detail: v.optional(v.union(v.string(), v.null())),
});
type AuditRecord = Infer<typeof auditRecord>;

const installResult = v.object({
  appId: v.string(),
  // A string, not the stored union (Step 17 review): a newer agent's state must not fail the
  // whole report and stall its queue. States outside STORED_INSTALL_STATES are ignored but acked.
  state: v.string(),
  appRevision: v.number(),
  attempts: v.number(),
  exitCode: v.optional(v.union(v.number(), v.null())),
  detail: v.optional(v.union(v.string(), v.null())),
  // Phase 6 Step 10: the version the PC has (plan 4.4.1). Absent = keep what is stored; null = clear it.
  installedVersion: v.optional(v.union(v.string(), v.null())),
});
type InstallResult = Infer<typeof installResult>;

const auditPart = v.object({ records: v.array(auditRecord), dropped: v.number() });

type Ctx = { db: DatabaseWriter; device: DeviceIdentity };

function checkAuditPart(part: { records: AuditRecord[]; dropped: number }): void {
  if (part.records.length > MAX_REPORT_AUDIT) fail("invalid_argument", { field: "records" });
  if (!isCount(part.dropped)) fail("invalid_argument", { field: "dropped" });
}

function checkInstalls(results: InstallResult[]): void {
  if (results.length > MAX_REPORT_INSTALLS) fail("invalid_argument", { field: "installs" });
  for (const r of results) {
    if (!isCount(r.appRevision)) fail("invalid_argument", { field: "appRevision" });
    if (!isCount(r.attempts)) fail("invalid_argument", { field: "attempts" });
    if (r.exitCode !== undefined && r.exitCode !== null && !Number.isSafeInteger(r.exitCode)) fail("invalid_argument", { field: "exitCode" });
    // A `detail` outside the fixed list is NOT a reason to refuse the report (it
    // would stall the agent's queue for good on version skew): `ingestInstalls`
    // stores the result without it.
  }
}

/** The install `detail` when it is on the fixed list, else undefined (dropped). */
function cleanInstallDetail(detail: string | null | undefined): string | undefined {
  if (detail === null || detail === undefined) return undefined;
  return detail.length <= MAX_INSTALL_DETAIL && INSTALL_DETAILS.has(detail) ? detail : undefined;
}

/** `[0-9A-Za-z.+-]`, 1 to `MAX_VERSION_CHARS`: the version text of plan 4.3 (the same rule as `apps.desktop.version`). */
const INSTALLED_VERSION = /^[0-9A-Za-z.+-]+$/;

/**
 * The reported `installedVersion` as the server understands it: a string to store, `null` to clear, `undefined` to leave the
 * stored value alone. A value that is not version text is dropped (= `undefined`), never a reason to refuse the report (version
 * skew must not stall the agent's queue, like `cleanInstallDetail`).
 */
function cleanInstalledVersion(value: string | null | undefined): string | null | undefined {
  if (value === undefined || value === null) return value;
  return value.length >= 1 && value.length <= MAX_VERSION_CHARS && INSTALLED_VERSION.test(value) ? value : undefined;
}

/**
 * Per-device write limit (`deviceWrites`): one token per row this call really
 * wrote, taken at the END so a call that wrote nothing (a replay, an unchanged
 * status) is free and a refused one (`rate_limited`) rolls back everything it
 * wrote. Called by `report` and `rotateCredential`.
 */
async function chargeWrites(ctx: Parameters<typeof consumeOrFail>[0], deviceId: string, rows: number): Promise<void> {
  if (rows > 0) await consumeOrFail(ctx, "deviceWrites", deviceId, rows);
}

async function deviceRow(ctx: Ctx): Promise<Doc<"devices">> {
  const d = await ctx.db.get(ctx.device._id);
  if (d === null) fail("device_rejected");
  return d;
}

async function knownEvent(ctx: Ctx, eventKey: string): Promise<boolean> {
  const row = await ctx.db
    .query("auditLog")
    .withIndex("by_event_key", (q) => q.eq("eventKey", eventKey))
    .first();
  return row !== null;
}

/**
 * The device's audit records (4.11): idempotent on `eventKey`; a bad `detail`
 * or `username` is dropped from the record. An unknown kind or a malformed id
 * is not stored but IS counted as accepted (the agent acks only when
 * `accepted == records.len()`, so version skew or one corrupt local record can
 * never stall its queue) and is reported in the `device.auditDropped` row with
 * the agent's own `dropped` count. That row is written once per batch, keyed on
 * the batch's first record id (stable when the agent re-batches), or on a hash
 * of the ids when none is valid. Returns `accepted` (= the records the server
 * has dealt with: new, duplicate or skipped) and the rows written.
 */
async function ingestAudit(
  ctx: Ctx,
  part: { records: AuditRecord[]; dropped: number },
  now: number,
): Promise<{ accepted: number; written: number }> {
  if (part.records.length === 0 && part.dropped === 0) return { accepted: 0, written: 0 };
  const device = await deviceRow(ctx);
  const actor: AuditActor = { type: "device", id: device._id, label: device.name };
  const target = { targetType: "device", targetId: device._id, targetLabel: device.name };
  let written = 0;
  let skipped = 0;
  let firstId: string | null = null;
  for (const r of part.records) {
    if (validRecordId(r.id)) firstId ??= r.id;
    const action = actionOfKind(r.kind);
    if (action === null || !validRecordId(r.id)) {
      skipped++;
      continue;
    }
    const eventKey = `dev:${device._id}:${r.id}`;
    if (await knownEvent(ctx, eventKey)) continue;
    const time = recordTime(r, device.enrolledAt, now);
    const summary = recordSummary(action, device.name, {
      username: action === "device.employeeLockedOut" ? cleanUsername(r.username) : null,
      detail: cleanDetail(r.detail),
      clockWrong: time.clockWrong,
    });
    await writeAudit(ctx, { orgId: device.orgId, actor, action, ...target, summary, eventKey, at: time.at });
    written++;
  }
  const lost = part.dropped + skipped;
  if (lost > 0) {
    const batchKey =
      firstId ?? sha256HexSync(JSON.stringify([part.dropped, part.records.map((r) => r.id.slice(0, 64))]));
    const eventKey = `dev:${device._id}:${batchKey}:dropped`;
    if (!(await knownEvent(ctx, eventKey))) {
      const summary =
        skipped === 0
          ? `${lost} audit records were lost on the PC ${device.name} (its queue was full)`
          : `${lost} audit records were lost on the PC ${device.name} (${part.dropped} while its queue was full, ${skipped} not understood by this server)`;
      await writeAudit(ctx, { orgId: device.orgId, actor, action: "device.auditDropped", ...target, summary, eventKey });
      written++;
    }
  }
  return { accepted: part.records.length, written };
}

/**
 * One driver result (Step 14b): upserted per (device, driver) into `driverResults`, written only when a field differs. A driver of
 * another organization, an unknown id and a passing state are ignored (the caller still counts them as accepted). It does not touch
 * `orgStats.failedInstallCount` (drivers are not apps). Returns the rows written.
 */
async function ingestDriverResult(
  ctx: Ctx,
  r: InstallResult,
  state: StoredInstallState,
  groupId: Id<"groups"> | undefined,
  now: number,
): Promise<number> {
  const driverId = ctx.db.normalizeId("drivers", r.appId);
  if (driverId === null) return 0;
  // The scoped `get` answers null for another organization's driver.
  const driver = await ctx.db.get(driverId);
  if (driver === null) return 0;
  const next = {
    state,
    driverRevision: r.appRevision,
    attempts: r.attempts,
    exitCode: r.exitCode ?? undefined,
    detail: cleanInstallDetail(r.detail),
    groupId,
  };
  const row = await ctx.db
    .query("driverResults")
    .withIndex("by_device_driver", (q) => q.eq("deviceId", ctx.device._id).eq("driverId", driver._id))
    .first();
  if (row === null) {
    await ctx.db.insert("driverResults", { orgId: ctx.device.orgId, deviceId: ctx.device._id, driverId: driver._id, ...next, updatedAt: now });
    return 1;
  }
  const same =
    row.state === next.state &&
    row.driverRevision === next.driverRevision &&
    row.attempts === next.attempts &&
    row.exitCode === next.exitCode &&
    row.detail === next.detail &&
    row.groupId === next.groupId;
  if (same) return 0;
  // `undefined` removes a stale exit code, detail or tag.
  await ctx.db.patch(row._id, { ...next, updatedAt: now });
  return 1;
}

/**
 * Install results (4.8 amended, A12): `pending` and the terminal states are
 * upserted per (device, app) and written only when a field differs; the
 * passing states (`downloading`, `installing`, `removing`) and apps that are
 * not in the device's organization are ignored but counted as accepted, and so
 * is a `state` this server does not know (a newer agent). Every row is tagged
 * with the PC's group; `orgStats.failedInstallCount` (live failed rows only,
 * lib/installs.ts) moves in the same mutation. A `detail` outside
 * the fixed list is dropped (the result is stored without it). An id that is a driver (Step 14b) goes to `driverResults`
 * (`ingestDriverResult`; `appRevision` is then the driver revision). `installedVersion` (Phase 6) rides the same upsert and counts
 * as a difference only when the stored value would change (absent keeps, null or `removed` clears, a malformed one is dropped).
 * Returns `accepted` (= every result) and the rows written.
 */
async function ingestInstalls(ctx: Ctx, results: InstallResult[], now: number): Promise<{ accepted: number; written: number }> {
  let failedDelta = 0;
  let written = 0;
  // Tag every row with the PC's group; `failedInstallCount` counts only rows that are live
  // (lib/installs.ts), before and after this write.
  const groupId = results.length > 0 ? (await deviceRow(ctx)).groupId : undefined;
  const check = liveChecker(ctx);
  for (const r of results) {
    if (!isStoredInstallState(r.state)) continue;
    const appId = ctx.db.normalizeId("apps", r.appId);
    if (appId === null) {
      // Step 14b: the id of a driver (`drivers`), reported through the same list with `appRevision` = the driver revision.
      written += await ingestDriverResult(ctx, r, r.state, groupId, now);
      continue;
    }
    // The scoped `get` answers null for another organization's app.
    const app = await check.app(appId);
    if (app === null) continue;
    const next = {
      state: r.state,
      appRevision: r.appRevision,
      attempts: r.attempts,
      exitCode: r.exitCode ?? undefined,
      detail: cleanInstallDetail(r.detail),
      groupId,
    };
    // Phase 6: a version is reported by the agent next to the state. `removed` (the app is gone) and an explicit null clear it;
    // an absent (or malformed) value keeps what is stored.
    const reported = cleanInstalledVersion(r.installedVersion);
    const counts = next.state === "failed" && (await check.live(groupId, app._id)) ? 1 : 0;
    const row = await ctx.db
      .query("installResults")
      .withIndex("by_device_app", (q) => q.eq("deviceId", ctx.device._id).eq("appId", app._id))
      .first();
    if (row === null) {
      const installedVersion = next.state === "removed" || reported === null ? undefined : reported;
      await ctx.db.insert("installResults", {
        orgId: ctx.device.orgId,
        deviceId: ctx.device._id,
        appId: app._id,
        ...next,
        ...(installedVersion !== undefined ? { installedVersion } : {}),
        updatedAt: now,
      });
      written++;
      failedDelta += counts;
      continue;
    }
    const installedVersion = next.state === "removed" || reported === null ? undefined : (reported ?? row.installedVersion);
    const same =
      row.state === next.state &&
      row.appRevision === next.appRevision &&
      row.attempts === next.attempts &&
      row.exitCode === next.exitCode &&
      row.detail === next.detail &&
      row.groupId === next.groupId &&
      row.installedVersion === installedVersion;
    if (same) continue;
    const counted = row.state === "failed" && (await check.live(row.groupId, app._id)) ? 1 : 0;
    // `undefined` removes a stale exit code, detail, tag or version.
    await ctx.db.patch(row._id, { ...next, installedVersion, updatedAt: now });
    written++;
    failedDelta += counts - counted;
  }
  if (failedDelta !== 0) {
    await bumpOrgStatsIfPresent(ctx, ctx.device.orgId, { failedInstallCount: failedDelta });
    written++;
  }
  return { accepted: results.length, written };
}

/**
 * The agent's batched report (plan 5.1 amended, A12; at most one per 60 s):
 * the status snapshot (`deviceSummary` / `deviceReports`, each written only on
 * change), install results and audit records. One credentials read per call
 * (the wrapper). Every part is checked before anything is written, so a
 * refused report writes nothing. Phase 5 adds `apply`, `findings` and daily
 * summaries (A19). A replay of the same report writes nothing and consumes no
 * `deviceWrites` tokens; a report that writes more than the device's bucket
 * holds is refused with `rate_limited` (and rolled back). Answer: `accepted` =
 * installs and audit records the server has dealt with (stored, duplicate,
 * ignored or skipped), so the agent may ack its queues when each equals what it
 * sent.
 */
export const report = deviceMutation({
  args: {
    status: v.optional(statusValidator),
    installs: v.optional(v.array(installResult)),
    audit: v.optional(auditPart),
  },
  returns: v.object({ accepted: v.object({ installs: v.number(), audit: v.number() }) }),
  handler: async (ctx, args) => {
    if (args.installs !== undefined) checkInstalls(args.installs);
    if (args.audit !== undefined) checkAuditPart(args.audit);
    const now = Date.now();
    let written = 0;
    if (args.status !== undefined) {
      const wrote = await writeStatus(ctx, { deviceId: ctx.device._id, orgId: ctx.device.orgId }, args.status, now);
      written += (wrote.summary ? 1 : 0) + (wrote.report ? 1 : 0);
    }
    const installs = args.installs === undefined ? { accepted: 0, written: 0 } : await ingestInstalls(ctx, args.installs, now);
    const audit = args.audit === undefined ? { accepted: 0, written: 0 } : await ingestAudit(ctx, args.audit, now);
    await chargeWrites(ctx, ctx.device._id, written + installs.written + audit.written);
    return { accepted: { installs: installs.accepted, audit: audit.accepted } };
  },
});

// ---------------------------------------------------------------- rotateCredential (Step 12 item 4, A2)

/**
 * The agent's new secret (it generated it and stored it as pending first;
 * only the SHA-256 travels). Authenticated with the CURRENT secret: the
 * current hash becomes `previousSecretHash`, the new one `secretHash`, the
 * dashboard's request is cleared and `device.credentialRotated` is audited.
 * Authenticated with the PREVIOUS secret and `secretHash` already equal to
 * `newSecretHash`: ok without a write (the agent retries after a lost
 * answer). The first mutation made with the new secret drops the old one
 * (`settleRotation` in the wrapper); after that the old secret is refused.
 * Anything else with the previous secret is `conflict` (a second rotation
 * before the first was adopted).
 */
export const rotateCredential = deviceMutation({
  args: { newSecretHash: v.string() },
  returns: v.object({ kind: v.literal("ok") }),
  handler: async (ctx, args) => {
    if (!/^[0-9a-f]{64}$/.test(args.newSecretHash)) fail("invalid_argument", { field: "newSecretHash" });
    const cred = await ctx.db
      .query("deviceCredentials")
      .withIndex("by_device", (q) => q.eq("deviceId", ctx.device._id))
      .unique();
    // A device enrolled before the Step 7 split has no row until `maintenance:migrateDevices` ran.
    if (cred === null) fail("not_ready", { detail: "credentials" });
    if (cred.secretHash === args.newSecretHash) return { kind: "ok" as const };
    if (ctx.device.matched === "previous") fail("conflict", { detail: "rotation" });
    await ctx.db.patch(cred._id, { previousSecretHash: cred.secretHash, secretHash: args.newSecretHash, rotate: undefined });
    const device = await ctx.db.get(ctx.device._id);
    const name = device?.name ?? "PC";
    await writeAudit(ctx, {
      orgId: ctx.device.orgId,
      actor: { type: "device", id: ctx.device._id, label: name },
      action: "device.credentialRotated",
      targetType: "device",
      targetId: ctx.device._id,
      targetLabel: name,
      summary: `The PC ${name} replaced its credential`,
    });
    // Two rows written (credentials, audit); the idempotent retry above writes none and costs nothing.
    await chargeWrites(ctx, ctx.device._id, 2);
    return { kind: "ok" as const };
  },
});

// ---------------------------------------------------------------- Phase 5 lockdown reports (plan 4.11, 4.17, 4.19; Step 10)
//
// All five are CHANGE-DRIVEN: a call that finds nothing to change writes no document, takes no
// rate-limit token and costs the agent nothing (the write-count tests in `lockdownReports.test.ts`
// pin every one of them). A call that writes takes one `deviceReports` token (60 an hour per
// device) and one `deviceWrites` token per document written, at the END, so a refused call rolls
// everything back. The payloads are those of `apps/agent/src/backend/reports.rs`; a value this
// server does not know is stored as a fixed code or dropped, never a reason to stall the agent.

/** Charge a report that wrote `rows` documents (nothing when it wrote none). */
async function chargeReport(ctx: Parameters<typeof consumeOrFail>[0], deviceId: string, rows: number): Promise<void> {
  if (rows <= 0) return;
  await consumeOrFail(ctx, "deviceReports", deviceId, 1);
  await consumeOrFail(ctx, "deviceWrites", deviceId, rows);
}

const wifiItem = v.object({ profileId: v.string(), revision: v.number(), state: v.string(), detail: v.optional(v.string()) });
const printerItem = v.object({ printerId: v.string(), revision: v.number(), state: v.string(), detail: v.optional(v.string()) });

/**
 * The agent's apply report (4.11), sent when the applied version, a layer state, a Wi-Fi or
 * printer state or the last-known-good version changed. Upserts the device's one
 * `deviceApplyReports` row ONLY when the agent's content hash differs from the stored one: an
 * unchanged report writes nothing. Free text is never stored (fixed codes only).
 */
export const reportApply = deviceMutation({
  args: {
    appliedVersion: v.number(),
    config: v.optional(v.object({ groupId: v.string(), version: v.number(), ring: v.string() })),
    state: v.string(),
    refusal: v.optional(v.string()),
    layers: layerStates,
    wifi: v.array(wifiItem),
    printers: v.array(printerItem),
    lkgVersion: v.optional(v.number()),
    capabilities: v.array(v.string()),
    contentHash: v.string(),
  },
  returns: v.object({ written: v.boolean() }),
  handler: async (ctx, args) => {
    if (!/^[0-9a-f]{64}$/.test(args.contentHash)) fail("invalid_argument", { field: "contentHash" });
    if (!isCount(args.appliedVersion)) fail("invalid_argument", { field: "appliedVersion" });
    if (args.lkgVersion !== undefined && !isCount(args.lkgVersion)) fail("invalid_argument", { field: "lkgVersion" });
    if (args.capabilities.length > 50) fail("invalid_argument", { field: "capabilities" });
    const existing = await ctx.db
      .query("deviceApplyReports")
      .withIndex("by_device", (q) => q.eq("deviceId", ctx.device._id))
      .unique();
    if (existing !== null && existing.contentHash === args.contentHash) return { written: false };

    const wifi = cleanItems("wifi", "profileId", args.wifi);
    const printers = cleanItems("printers", "printerId", args.printers);
    let config: Doc<"deviceApplyReports">["config"];
    if (args.config !== undefined && isCount(args.config.version)) {
      // The scoped `get` answers null for another organization's group.
      const gid = ctx.db.normalizeId("groups", args.config.groupId);
      const group = gid === null ? null : await ctx.db.get(gid);
      if (group !== null) config = { groupId: group._id, version: args.config.version, ring: ringOf(args.config.ring) };
    }
    const row = {
      orgId: ctx.device.orgId,
      deviceId: ctx.device._id,
      appliedVersion: args.appliedVersion,
      config,
      state: applyStateOf(args.state),
      refusal: cleanCode(args.refusal, 64),
      layers: {
        staff: cleanLayer(args.layers.staff),
        machine: cleanLayer(args.layers.machine),
        appLocker: cleanLayer(args.layers.appLocker),
        appControl: cleanLayer(args.layers.appControl),
        procWatch: cleanLayer(args.layers.procWatch),
        boot: cleanLayer(args.layers.boot),
        performance: cleanLayer(args.layers.performance),
      },
      wifi,
      printers,
      lkgVersion: args.lkgVersion,
      capabilities: cleanCapabilities(args.capabilities) ?? [],
      contentHash: args.contentHash,
      updatedAt: Date.now(),
    };
    if (existing === null) await ctx.db.insert("deviceApplyReports", row);
    else await ctx.db.replace(existing._id, row);
    // The small row `lockdown:groupSync` counts: written only when one of its five facts changes (a Wi-Fi or printer state change, for
    // example, changes the report but not them).
    // Only a configuration of the group the PC is in NOW counts (a PC that was just moved may still report its old group's): else the row
    // says "waiting".
    const pc = await ctx.db.get(ctx.device._id);
    const syncWrites = await setSyncRow(ctx, ctx.device, syncFieldsOf(row, pc?.groupId), row.updatedAt);
    await chargeReport(ctx, ctx.device._id, 1 + syncWrites);
    return { written: true };
  },
});

/**
 * New program fingerprints (4.10), at most 50 per call, each new to THIS device (the agent never
 * re-sends one). Upserts `lockdownFindings` by `(orgId, fingerprint)`; inserts the
 * `lockdownFindingDevices` row only when the (finding, device) pair is new; a repeat writes
 * nothing. No path, title or command line is accepted (`cleanFindings`). `accepted` = findings
 * sent, so the agent may drop them from its queue.
 */
export const reportFindings = deviceMutation({
  args: {
    findings: v.array(
      v.object({
        fingerprint: v.string(),
        layer: v.string(),
        fileName: v.string(),
        folderClass: v.string(),
        signer: v.optional(v.string()),
        product: v.optional(v.string()),
        sha256: v.optional(v.string()),
      }),
    ),
  },
  returns: v.object({ accepted: v.number() }),
  handler: async (ctx, args) => {
    const findings = cleanFindings(args.findings);
    const now = Date.now();
    let written = 0;
    for (const f of findings) {
      const finding = await ctx.db
        .query("lockdownFindings")
        .withIndex("by_org_fingerprint", (q) => q.eq("orgId", ctx.device.orgId).eq("fingerprint", f.fingerprint))
        .unique();
      if (finding === null) {
        const findingId = await ctx.db.insert("lockdownFindings", {
          orgId: ctx.device.orgId,
          ...f,
          firstSeenAt: now,
          lastSeenAt: now,
          deviceCount: 1,
          sampleDeviceId: ctx.device._id,
          status: "new",
        });
        await ctx.db.insert("lockdownFindingDevices", { orgId: ctx.device.orgId, findingId, deviceId: ctx.device._id, firstSeenAt: now });
        written += 2;
        continue;
      }
      const seen = await ctx.db
        .query("lockdownFindingDevices")
        .withIndex("by_finding_device", (q) => q.eq("findingId", finding._id).eq("deviceId", ctx.device._id))
        .first();
      if (seen !== null) continue; // this device reported it before: nothing to change
      await ctx.db.insert("lockdownFindingDevices", { orgId: ctx.device.orgId, findingId: finding._id, deviceId: ctx.device._id, firstSeenAt: now });
      await ctx.db.patch(finding._id, { deviceCount: finding.deviceCount + 1, lastSeenAt: Math.max(finding.lastSeenAt, now) });
      written += 2;
    }
    await chargeReport(ctx, ctx.device._id, written);
    return { accepted: args.findings.length };
  },
});

/**
 * One device's security counters for one server (UTC) day (4.2): blocked programs per layer,
 * refused elevation prompts, web-app permission denials, drift and tamper counts. A day with
 * every counter zero writes nothing. A second call for the same day MERGES BY ADDING (the plan's
 * rule; the agent sends at most one per day). One row per device per day, kept 14 days.
 */
export const reportSecurityDaily = deviceMutation({
  args: {
    day: v.string(),
    blocked: v.object({ appLocker: v.number(), appControl: v.number(), procWatch: v.number(), elevation: v.number() }),
    permissionDenials: v.array(v.object({ appId: v.string(), kind: v.string(), count: v.number() })),
    drift: v.number(),
    tamper: v.number(),
  },
  returns: v.object({ written: v.boolean() }),
  handler: async (ctx, args) => {
    const now = Date.now();
    const d = cleanDaily(args, now);
    if (isZeroDaily(d)) return { written: false };
    const row = await ctx.db
      .query("deviceSecurityDaily")
      .withIndex("by_device_day", (q) => q.eq("deviceId", ctx.device._id).eq("day", d.day))
      .unique();
    if (row === null) {
      await ctx.db.insert("deviceSecurityDaily", { orgId: ctx.device.orgId, deviceId: ctx.device._id, ...d });
    } else {
      await ctx.db.patch(row._id, {
        blocked: addBlocked(row.blocked, d.blocked),
        permissionDenials: mergeDenials([...row.permissionDenials, ...d.permissionDenials], MAX_PERMISSION_DENIALS),
        drift: row.drift + d.drift,
        tamper: row.tamper + d.tamper,
      });
    }
    await chargeReport(ctx, ctx.device._id, 1);
    return { written: true };
  },
});

/**
 * Broadcast acknowledgements (4.17): one `broadcastAcks` row per device per broadcast, never the
 * employee's identity. A broadcast that is not this PC's (another organization's, or aimed at
 * another group or device) or an id that is not a broadcast is ignored but counted as accepted.
 * A repeated acknowledgement writes nothing.
 */
export const reportAcks = deviceMutation({
  args: { acks: v.array(v.object({ broadcastId: v.string(), atMs: v.number() })) },
  returns: v.object({ accepted: v.number() }),
  handler: async (ctx, args) => {
    if (args.acks.length > MAX_ACKS_PER_CALL) fail("invalid_argument", { field: "acks" });
    const now = Date.now();
    const device = await deviceRow(ctx);
    let written = 0;
    for (const a of args.acks) {
      const id = ctx.db.normalizeId("broadcasts", a.broadcastId);
      const b = id === null ? null : await ctx.db.get(id);
      if (b === null) continue;
      const mine = b.target.kind === "device" ? b.target.id === device._id : device.groupId !== undefined && b.target.id === device.groupId;
      if (!mine) continue;
      const had = await ctx.db
        .query("broadcastAcks")
        .withIndex("by_broadcast_device", (q) => q.eq("broadcastId", b._id).eq("deviceId", device._id))
        .first();
      if (had !== null) continue;
      const at = Number.isFinite(a.atMs) ? Math.min(Math.max(a.atMs, b.createdAt), now) : now;
      await ctx.db.insert("broadcastAcks", { orgId: device.orgId, broadcastId: b._id, deviceId: device._id, at });
      // The counter of the list ("acknowledged on 14 of 20 devices"): one patch per NEW ack row.
      await ctx.db.patch(b._id, { ackCount: (b.ackCount ?? 0) + 1 });
      written++;
    }
    await chargeReport(ctx, ctx.device._id, written);
    return { accepted: args.acks.length };
  },
});

/**
 * The agent's X25519 sealing public key (4.18). The device's secret already authenticated this
 * call, which is the "proof of device identity" of edge case 35: a first key is stored, the
 * same key again is a no-op, and a DIFFERENT key replaces the old one (the agent lost its
 * private half). A replacement drops the device's sealed boxes (they were for the old key) and
 * the device is sealed again (`seal:forDevices`) and published.
 */
export const registerSealKey = deviceMutation({
  args: { publicKey: v.string() },
  returns: v.object({ keyId: v.string(), changed: v.boolean() }),
  handler: async (ctx, args) => {
    const pk = decodeSealPublicKey(args.publicKey);
    if (pk === null) fail("invalid_argument", { field: "publicKey" });
    try {
      // A low-order point gives an all-zero shared secret (the library refuses it).
      x25519.getSharedSecret(new Uint8Array(32).fill(7), pk);
    } catch {
      fail("invalid_argument", { field: "publicKey" });
    }
    const keyId = sealKeyIdOf(pk);
    const device = await deviceRow(ctx);
    if (device.sealPublicKey === args.publicKey.trim() && device.sealKeyId === keyId) return { keyId, changed: false };
    let written = 1;
    if (device.sealPublicKey !== undefined) {
      const stale = await ctx.db
        .query("deviceSealedSecrets")
        .withIndex("by_device_target", (q) => q.eq("deviceId", device._id).eq("purpose", "wifi"))
        .take(MAX_DEVICE_WIFI + 1);
      for (const s of stale) {
        await ctx.db.delete(s._id);
        written++;
      }
    }
    await ctx.db.patch(device._id, { sealPublicKey: args.publicKey.trim(), sealKeyId: keyId });
    await ctx.scheduler.runAfter(0, internal.seal.forDevices, { orgId: device.orgId, deviceIds: [device._id] });
    await chargeReport(ctx, ctx.device._id, written);
    return { keyId, changed: true };
  },
});