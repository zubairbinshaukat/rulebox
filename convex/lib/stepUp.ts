import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseReader, DatabaseWriter } from "../_generated/server";
import { fail } from "./errors";
import {
  MAX_PASSKEYS,
  MAX_PIN_WINDOW_ENTRIES,
  PIN_BACKOFF_BASE_MS,
  PIN_BACKOFF_MAX_MS,
  PIN_FREE_FAILURES,
  PIN_HARD_LIMIT,
  PIN_LOCKOUT_MS,
  PIN_LOCKOUT_STEPS_MS,
  PIN_WINDOW_MS,
  STEP_UP_ACTIVITY_QUANTUM_MS,
  STEP_UP_BOOTSTRAP_MS,
  STEP_UP_CLOCK_SLACK_MS,
  STEP_UP_FRESH_MS,
  STEP_UP_IDLE_MS,
  STEP_UP_KEEPALIVE_MS,
  STEP_UP_MAX_AGE_MS,
} from "./limits";

// Step-up authentication (plan 4.16, Step 5a). Shared by the wrappers in
// lib/functions.ts and the functions in stepUp.ts / passkeys.ts.
//
// Nothing here can unlock a device or loosen a lock: step-up only gates
// dashboard functions.

/**
 * "unlocked": the session verified recently and is not idle (any member write
 * outside this table needs it). "fresh": verified within STEP_UP_FRESH_MS
 * (major actions).
 */
export type StepUpLevel = "unlocked" | "fresh";

export type MajorActionSpec = {
  /** "always": the wrapper enforces it. "conditional": the handler calls requireStepUp for some arguments. */
  when: "always" | "conditional";
  why: string;
};

/**
 * Every major action, by `file:function`. The single source the wrappers and
 * tests read: `memberMutation(role, { major: "<file>:<name>" })` enforces a
 * fresh step-up, and `stepUp.test.ts` fails when a listed function exists
 * but does not refuse without one, or when a `major:` name does not match the
 * export it is attached to. Functions of later steps are listed now so a new
 * function cannot forget it (the test checks them as soon as they exist).
 */
export const MAJOR_ACTIONS = {
  // Members and roles.
  "members:invite": { when: "always", why: "gives a person access" },
  "members:revokeInvite": { when: "always", why: "deletes an invite or reset code" },
  "members:changeRole": { when: "always", why: "changes a role" },
  "members:setDisabled": { when: "always", why: "disables or enables a member" },
  "members:createResetCode": { when: "always", why: "lets someone set a member's password" },
  // Phase 4b security review: self-service password change (also needs the current password).
  "account:changePassword": { when: "always", why: "changes the sign-in password" },
  // Step-up factors themselves. (`clearActionPin` always refuses since Phase
  // 4b: the PIN is required; it stays major so it cannot even be probed stale.)
  "stepUp:clearActionPin": { when: "always", why: "removes a step-up factor" },
  "stepUp:generateRecoveryCodes": { when: "always", why: "replaces the recovery codes of the action PIN" },
  "stepUp:removePasskey": { when: "always", why: "removes a step-up factor" },
  "stepUp:resetMember": { when: "always", why: "removes another member's step-up factors" },
  // Step 5: organization settings and groups.
  "settings:setExitPin": { when: "always", why: "changes the device exit PIN" },
  "settings:clearExitPin": { when: "always", why: "removes the device exit PIN" },
  "settings:update": { when: "conditional", why: "changes the admin exit (lock) settings" },
  // Plan 4.16 says `groups:delete`; `delete` is a reserved word in JS, so the
  // function is `groups:remove` like apps:/employees:/fleet:remove.
  "groups:remove": { when: "always", why: "deletes a group" },
  // Step 6-8: enrollment, devices, signing keys.
  "enrollmentCodes:revoke": { when: "always", why: "deletes an enrollment code" },
  "fleet:setKiosk": { when: "conditional", why: "turns kiosk mode off" },
  "fleet:revoke": { when: "always", why: "revokes a device" },
  "fleet:remove": { when: "always", why: "removes a device" },
  "keys:registerActive": { when: "always", why: "signing key" },
  "keys:prepareRotation": { when: "always", why: "signing key" },
  "keys:finishRotation": { when: "always", why: "signing key" },
  // Phase 5 Step 10: wraps the deployment signing key as the organization's own key.
  "keys:migrateFromEnv": { when: "always", why: "signing key" },
  // Step 10-11: apps and employees (deletes).
  "apps:remove": { when: "always", why: "deletes an app" },
  "fileHandlers:remove": { when: "always", why: "deletes a file type rule" },
  "employees:remove": { when: "always", why: "deletes an employee" },
  // Phase 5: device lock, lockdown, rollback.
  "fleet:lock": { when: "always", why: "locks a device" },
  "fleet:unlock": { when: "always", why: "unlocks a device" },
  "lockdown:update": { when: "conditional", why: "publishes a policy that changes lock or kiosk settings" },
  // Plan and limit changes are made by an OPERATOR through the platform API,
  // never by a member function; the operator console has its own step-up
  // (post-Phase-5 plan 5.3), so they are not in this table.
} as const satisfies Record<string, MajorActionSpec>;

export type MajorAction = keyof typeof MAJOR_ACTIONS;

// ---------------------------------------------------------------- action PIN rules

/** Common PINs refused besides the pattern rules (all 6 digits). */
const COMMON_PINS = new Set([
  "123456", "654321", "123123", "121212", "112233", "111222", "123321", "102030", "101010",
  "696969", "159753", "147258", "258369", "963852", "741852", "000000", "999999", "135790",
  "246810", "202020", "131313", "007007", "520520", "147852", "789456", "456789",
]);

/**
 * Plan 4.16: 6-12 ASCII digits; refused: one digit repeated, a short pattern
 * repeated (12 12 12, 123 123), a run that goes up or down by one at every
 * step (with wrap: 890123, 210987), and a short list of common PINs.
 * Returns null when acceptable, else a fixed reason.
 */
export function actionPinProblem(pin: string): string | null {
  if (!/^[0-9]{6,12}$/.test(pin)) return "6 to 12 digits";
  for (let p = 1; p <= pin.length / 2; p++) {
    if (pin.length % p === 0 && pin.slice(0, p).repeat(pin.length / p) === pin) return "repeated pattern";
  }
  const d = [...pin].map(Number);
  const steps = d.slice(1).map((x, i) => (x - d[i]! + 10) % 10);
  if (steps.every((s) => s === 1) || steps.every((s) => s === 9)) return "sequence";
  if (COMMON_PINS.has(pin)) return "too common";
  return null;
}

/** Delay before the next attempt after `failures` consecutive failures. */
export function pinBackoffMs(failures: number): number {
  if (failures <= PIN_FREE_FAILURES) return 0;
  const n = failures - PIN_FREE_FAILURES - 1;
  return Math.min(PIN_BACKOFF_MAX_MS, PIN_BACKOFF_BASE_MS * 2 ** Math.min(n, 20));
}

// ---------------------------------------------------------------- reads

export type Who = { userId: Id<"users">; sessionId: Id<"authSessions"> };

export async function factorsOf(ctx: { db: DatabaseReader }, userId: Id<"users">): Promise<Doc<"stepUpFactors"> | null> {
  return await ctx.db
    .query("stepUpFactors")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .first();
}

export async function passkeysOf(ctx: { db: DatabaseReader }, userId: Id<"users">): Promise<Doc<"passkeys">[]> {
  return await ctx.db
    .query("passkeys")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .take(MAX_PASSKEYS);
}

export async function stepUpRowOf(ctx: { db: DatabaseReader }, who: Who): Promise<Doc<"stepUpSessions"> | null> {
  const row = await ctx.db
    .query("stepUpSessions")
    .withIndex("by_session", (q) => q.eq("sessionId", who.sessionId))
    .first();
  return row !== null && row.userId === who.userId ? row : null;
}

/**
 * The action PIN is REQUIRED for every member (Phase 4b): until one is
 * stored, member writes answer `step_up_setup_required`. A locked PIN still
 * counts (otherwise guessing it into the lockout would let a fresh sign-in set
 * a new one).
 *
 * Invariant: a `stepUpSessions` row is only written for a person with a PIN
 * (`markVerified` callers check it; the PIN cannot be removed, and every
 * reset that removes it also deletes ALL the person's step-up rows, walking
 * the whole per-user range: `deleteStepUpSessions`), so a valid row proves
 * the PIN exists without reading `stepUpFactors` on every write.
 */
export async function hasPin(ctx: { db: DatabaseReader }, userId: Id<"users">): Promise<boolean> {
  const f = await factorsOf(ctx, userId);
  return f?.actionPinHash !== undefined;
}

// ---------------------------------------------------------------- PIN attempt counters (`pinCounters`)
//
// Phase 4b security review. The counters live in their own row (they change on
// every attempt; `account:me` reads `stepUpFactors` and must not re-run then).
//
// - `failures`: consecutive failures, drives the short backoff.
// - `streak`: failures since the last success or lockout; PIN_HARD_LIMIT locks.
// - `windowFailures`: timestamps of failures in the last PIN_WINDOW_MS, NOT
//   reset by a success. PIN_HARD_LIMIT of them since the last lockout lock as
//   well, so a password thief guessing a few times a day while the owner
//   unlocks daily is still locked out after PIN_HARD_LIMIT guesses.
// - `windowLockouts`: lockouts in the window; each lockout lasts
//   PIN_LOCKOUT_STEPS_MS[number of earlier lockouts in the window] (24 h,
//   72 h, then 7 days).
// - `sinceUnlock`: failures since the last success (shown to the person; the
//   PIN_WARN_AT-th one emails them).

export type PinCounters = {
  failures: number;
  streak: number;
  sinceUnlock: number;
  lockedUntil: number;
  lockout: boolean;
  windowFailures: number[];
  windowLockouts: number[];
};

export const NO_PIN_COUNTERS: PinCounters = {
  failures: 0,
  streak: 0,
  sinceUnlock: 0,
  lockedUntil: 0,
  lockout: false,
  windowFailures: [],
  windowLockouts: [],
};

export async function pinCountersRowOf(ctx: { db: DatabaseReader }, userId: Id<"users">): Promise<Doc<"pinCounters"> | null> {
  return await ctx.db
    .query("pinCounters")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .first();
}

/**
 * The counters of a person: their `pinCounters` row, else seeded from the
 * legacy fields of `stepUpFactors` (rows written before the review: a hard
 * limit reached, or a pre-Phase-4b "disabled" PIN locked until
 * `pinDisabledAt + PIN_LOCKOUT_MS`).
 */
export function pinCountersOf(row: Doc<"pinCounters"> | null, f: Doc<"stepUpFactors"> | null): PinCounters {
  if (row !== null) {
    const { failures, streak, sinceUnlock, lockedUntil, lockout, windowFailures, windowLockouts } = row;
    return { failures, streak, sinceUnlock, lockedUntil, lockout, windowFailures, windowLockouts };
  }
  if (f === null) return NO_PIN_COUNTERS;
  const legacyLock = f.pinDisabledAt !== undefined || f.pinFailuresTotal >= PIN_HARD_LIMIT;
  const lockedUntil = f.pinDisabledAt !== undefined ? Math.max(f.pinLockedUntil, f.pinDisabledAt + PIN_LOCKOUT_MS) : f.pinLockedUntil;
  return {
    failures: legacyLock ? 0 : f.pinFailures,
    streak: legacyLock ? 0 : f.pinFailuresTotal,
    sinceUnlock: f.pinFailuresTotal,
    lockedUntil,
    lockout: legacyLock,
    windowFailures: [],
    windowLockouts: legacyLock && lockedUntil > 0 ? [lockedUntil - PIN_LOCKOUT_MS] : [],
  };
}

function lastN(list: number[]): number[] {
  return list.length > MAX_PIN_WINDOW_ENTRIES ? list.slice(-MAX_PIN_WINDOW_ENTRIES) : list;
}

/** Failures in the window after the last lockout in it (stored entries; pruned on every write). */
export function windowSinceLockout(c: PinCounters): number {
  const last = c.windowLockouts.at(-1) ?? 0;
  return c.windowFailures.filter((t) => t > last).length;
}

export type PinReservation = {
  next: PinCounters;
  /** The wait before the next attempt (a backoff, or the lockout when `locksOut`). */
  nextDelayMs: number;
  locksOut: boolean;
};

/**
 * Count one failed attempt at `now` (the caller checked `lockedUntil <= now`).
 * A lockout that ended starts the streak and the backoff over; the window
 * keeps its history.
 */
export function reservePinFailure(c: PinCounters, now: number): PinReservation {
  const since = now - PIN_WINDOW_MS;
  const fresh = c.lockout; // the previous lockout ended (else the caller refused)
  const priorLockouts = c.windowLockouts.filter((t) => t > since);
  const windowFailures = lastN([...c.windowFailures.filter((t) => t > since), now]);
  const failures = (fresh ? 0 : c.failures) + 1;
  const streak = (fresh ? 0 : c.streak) + 1;
  const sinceUnlock = c.sinceUnlock + 1;
  const lastLockout = priorLockouts.at(-1) ?? 0;
  const inWindow = windowFailures.filter((t) => t > lastLockout).length;
  if (streak >= PIN_HARD_LIMIT || inWindow >= PIN_HARD_LIMIT) {
    const ms = PIN_LOCKOUT_STEPS_MS[Math.min(priorLockouts.length, PIN_LOCKOUT_STEPS_MS.length - 1)]!;
    return {
      next: {
        failures: 0,
        streak: 0,
        sinceUnlock,
        lockedUntil: now + ms,
        lockout: true,
        windowFailures,
        windowLockouts: lastN([...priorLockouts, now]),
      },
      nextDelayMs: ms,
      locksOut: true,
    };
  }
  const nextDelayMs = pinBackoffMs(failures);
  return {
    next: {
      failures,
      streak,
      sinceUnlock,
      lockedUntil: nextDelayMs > 0 ? now + nextDelayMs : 0,
      lockout: false,
      windowFailures,
      windowLockouts: priorLockouts,
    },
    nextDelayMs,
    locksOut: false,
  };
}

function withoutOne(list: number[], value: number): number[] {
  const i = list.lastIndexOf(value);
  return i < 0 ? list : [...list.slice(0, i), ...list.slice(i + 1)];
}

/**
 * The attempt reserved at `reservedAt` was the right PIN: it is not a failure
 * (removed from the window, with the lockout it may have triggered), and the
 * streak, backoff and "since unlock" count start over. The window's other
 * failures stay (a success does not reset the long-term limit).
 */
export function pinSuccess(c: PinCounters, reservedAt: number): PinCounters {
  return {
    failures: 0,
    streak: 0,
    sinceUnlock: 0,
    lockedUntil: 0,
    lockout: false,
    windowFailures: withoutOne(c.windowFailures, reservedAt),
    windowLockouts: withoutOne(c.windowLockouts, reservedAt),
  };
}

/** Write the counters row (insert, patch, or nothing when unchanged). */
export async function writePinCounters(
  ctx: { db: DatabaseWriter },
  userId: Id<"users">,
  row: Doc<"pinCounters"> | null,
  next: PinCounters,
): Promise<void> {
  if (row === null) {
    await ctx.db.insert("pinCounters", { userId, ...next });
    return;
  }
  const same =
    row.failures === next.failures &&
    row.streak === next.streak &&
    row.sinceUnlock === next.sinceUnlock &&
    row.lockedUntil === next.lockedUntil &&
    row.lockout === next.lockout &&
    row.windowFailures.join() === next.windowFailures.join() &&
    row.windowLockouts.join() === next.windowLockouts.join();
  if (!same) await ctx.db.patch(row._id, next);
}

/** A new PIN (set, changed, reset) or a factor reset: the old PIN's counters go. */
export async function deletePinCounters(ctx: { db: DatabaseWriter }, userId: Id<"users">): Promise<void> {
  const row = await pinCountersRowOf(ctx, userId);
  if (row !== null) await ctx.db.delete(row._id);
}

/**
 * Store a new action PIN hash for a person (insert or patch their factor
 * row) and drop the old PIN's counters. The only writer of `actionPinHash`.
 * Returns true when it replaced an existing PIN.
 */
export async function storePinHash(ctx: { db: DatabaseWriter }, userId: Id<"users">, hash: string, now: number): Promise<boolean> {
  const f = await factorsOf(ctx, userId);
  const fields = {
    actionPinHash: hash,
    actionPinSetAt: now,
    // Legacy counter fields (superseded by `pinCounters`; narrowed in WP5b).
    pinFailures: 0,
    pinFailuresTotal: 0,
    pinLockedUntil: 0,
    pinDisabledAt: undefined,
  };
  if (f === null) await ctx.db.insert("stepUpFactors", { userId, ...fields });
  else await ctx.db.patch(f._id, fields);
  await deletePinCounters(ctx, userId);
  return f?.actionPinHash !== undefined;
}

/** What the lock screen shows (no clock: the client compares `lockedUntil` with its own time). */
export function pinView(c: PinCounters) {
  return {
    lockedUntil: c.lockedUntil > 0 ? c.lockedUntil : null,
    lockKind: c.lockedUntil > 0 ? (c.lockout ? ("lockout" as const) : ("backoff" as const)) : null,
    failedSinceUnlock: c.sinceUnlock,
    // After a lockout ends the count starts over; stale window entries (> 30 days) are pruned on the next attempt.
    attemptsBeforeLockout: c.lockout ? PIN_HARD_LIMIT : Math.max(0, PIN_HARD_LIMIT - Math.max(c.streak, windowSinceLockout(c))),
  };
}

/**
 * A person "has a factor" when an action PIN is stored (even a locked one) or
 * any passkey is registered (even a suspended one). Used by the Owner reset
 * (nothing to reset otherwise).
 */
export async function hasFactor(ctx: { db: DatabaseReader }, userId: Id<"users">): Promise<boolean> {
  const f = await factorsOf(ctx, userId);
  if (f?.actionPinHash !== undefined) return true;
  const one = await ctx.db
    .query("passkeys")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .first();
  return one !== null;
}

export type StepUpState = { unlocked: boolean; fresh: boolean };

/** Pure: what a step-up row allows at `now`. */
export function stepUpState(row: Doc<"stepUpSessions"> | null, now: number): StepUpState {
  if (row === null) return { unlocked: false, fresh: false };
  const age = now - row.verifiedAt;
  if (age < -STEP_UP_CLOCK_SLACK_MS || age > STEP_UP_MAX_AGE_MS) return { unlocked: false, fresh: false };
  const idle = now - row.lastActiveAt;
  const unlocked = idle <= STEP_UP_IDLE_MS + STEP_UP_KEEPALIVE_MS;
  return { unlocked, fresh: unlocked && age <= STEP_UP_FRESH_MS };
}

/**
 * Throw unless the session meets `level`: `step_up_setup_required` when the
 * person has no action PIN yet (every role; a passkey alone is not enough),
 * else `step_up_required` (detail = the level). Success costs one read (the
 * session's step-up row; see the invariant at `hasPin`).
 */
export async function checkStepUpOrFail(
  ctx: { db: DatabaseReader },
  who: Who,
  level: StepUpLevel,
  now: number,
): Promise<Doc<"stepUpSessions">> {
  const row = await stepUpRowOf(ctx, who);
  const state = stepUpState(row, now);
  if (row !== null && (level === "fresh" ? state.fresh : state.unlocked)) return row;
  if (!(await hasPin(ctx, who.userId))) fail("step_up_setup_required", { detail: level });
  fail("step_up_required", { detail: level });
}

/** Record activity: rewrite `lastActiveAt` only when it is a quantum old (write budget). */
export async function touchActivity(ctx: { db: DatabaseWriter }, row: Doc<"stepUpSessions">, now: number): Promise<void> {
  if (now - row.lastActiveAt >= STEP_UP_ACTIVITY_QUANTUM_MS) await ctx.db.patch(row._id, { lastActiveAt: now });
}

/**
 * For handlers whose major-ness depends on the arguments (`when:
 * "conditional"`), e.g. `settings:update` when it changes the admin exit.
 * Mutations only (it may record activity).
 */
export async function requireStepUp(
  ctx: { db: DatabaseWriter; userId: Id<"users">; sessionId: Id<"authSessions"> },
  level: StepUpLevel,
): Promise<void> {
  const now = Date.now();
  const row = await checkStepUpOrFail(ctx, ctx, level, now);
  await touchActivity(ctx, row, now);
}

/** Mark this session verified (one insert or patch). */
export async function markVerified(
  ctx: { db: DatabaseWriter },
  who: Who,
  method: "actionPin" | "passkey",
  now: number,
  passkeyId?: Id<"passkeys">,
): Promise<void> {
  const existing = await ctx.db
    .query("stepUpSessions")
    .withIndex("by_session", (q) => q.eq("sessionId", who.sessionId))
    .first();
  const fields = { userId: who.userId, verifiedAt: now, lastActiveAt: now, method, passkeyId };
  if (existing === null) await ctx.db.insert("stepUpSessions", { sessionId: who.sessionId, ...fields });
  else await ctx.db.patch(existing._id, fields);
}

/** True when the session was created (a password sign-in) less than STEP_UP_BOOTSTRAP_MS ago. */
export async function sessionIsFresh(ctx: { db: DatabaseReader }, sessionId: Id<"authSessions">, now: number): Promise<boolean> {
  const session = await ctx.db.get(sessionId);
  return session !== null && now - session._creationTime <= STEP_UP_BOOTSTRAP_MS;
}

/**
 * May this session set or change the action PIN (`factor: "pin"`) or add a
 * passkey (`"passkey"`)?
 *
 * - No PIN yet, `"pin"`: "bootstrap" when the session comes from a password
 *   sign-in less than STEP_UP_BOOTSTRAP_MS ago (Convex Auth's only provider is
 *   the password; the session row's creation time is the sign-in). Else `step_up_setup_required`
 *   (detail "reauthenticate": sign in again).
 * - No PIN yet, `"passkey"`: `step_up_setup_required` (detail "pin"): the
 *   PIN comes first, a passkey is an optional extra.
 * - A PIN exists: "fresh" after a fresh step-up, else `step_up_required`.
 */
export async function authorizeFactorChange(
  ctx: { db: DatabaseReader },
  who: Who,
  now: number,
  factor: "pin" | "passkey" = "pin",
): Promise<"bootstrap" | "fresh"> {
  if (!(await hasPin(ctx, who.userId))) {
    if (factor === "passkey") fail("step_up_setup_required", { detail: "pin" });
    if (!(await sessionIsFresh(ctx, who.sessionId, now))) fail("step_up_setup_required", { detail: "reauthenticate" });
    return "bootstrap";
  }
  await checkStepUpOrFail(ctx, who, "fresh", now);
  return "fresh";
}

/**
 * Most step-up rows (or WebAuthn challenges) of ONE user a reset walks. Far
 * above real use (one row per signed-in session, sessions last 7 days); above
 * it the reset throws and rolls back (fail closed) rather than leave a row
 * that would still "prove" a removed PIN (see `hasPin`).
 */
const MAX_USER_ROWS_WALKED = 5_000;

/**
 * Delete every step-up row of a user (optionally only those verified with one
 * passkey, or all but `except`). Walks the whole per-user index range (not a
 * fixed `.take`), so the invariant at `hasPin` holds for any number of rows.
 */
export async function deleteStepUpSessions(
  ctx: { db: DatabaseWriter },
  userId: Id<"users">,
  onlyPasskey?: Id<"passkeys">,
  except?: Id<"authSessions">,
): Promise<void> {
  let seen = 0;
  const victims: Id<"stepUpSessions">[] = [];
  for await (const r of ctx.db.query("stepUpSessions").withIndex("by_user", (q) => q.eq("userId", userId))) {
    if (++seen > MAX_USER_ROWS_WALKED) throw new Error("deleteStepUpSessions: too many rows for one user");
    if (r.sessionId === except) continue;
    if (onlyPasskey === undefined || r.passkeyId === onlyPasskey) victims.push(r._id);
  }
  for (const id of victims) await ctx.db.delete(id);
}

/** Delete every WebAuthn challenge of a user (a registration begun before a reset must not finish after it). */
export async function deleteChallenges(ctx: { db: DatabaseWriter }, userId: Id<"users">): Promise<void> {
  let seen = 0;
  const victims: Id<"stepUpChallenges">[] = [];
  for await (const c of ctx.db.query("stepUpChallenges").withIndex("by_user", (q) => q.eq("userId", userId))) {
    if (++seen > MAX_USER_ROWS_WALKED) throw new Error("deleteChallenges: too many rows for one user");
    victims.push(c._id);
  }
  for (const id of victims) await ctx.db.delete(id);
}
