import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseReader, DatabaseWriter } from "../_generated/server";
import { fail } from "./errors";
import {
  MAX_PASSKEYS,
  PIN_BACKOFF_BASE_MS,
  PIN_BACKOFF_MAX_MS,
  PIN_FREE_FAILURES,
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
  // Members, roles, MFA (exist today).
  "members:invite": { when: "always", why: "gives a person access" },
  "members:revokeInvite": { when: "always", why: "deletes an invite or reset code" },
  "members:changeRole": { when: "always", why: "changes a role" },
  "members:setDisabled": { when: "always", why: "disables or enables a member" },
  "members:createResetCode": { when: "always", why: "lets someone set a member's password" },
  "members:resetMfa": { when: "always", why: "removes a member's second factor" },
  // Step-up factors themselves.
  "stepUp:clearActionPin": { when: "always", why: "removes a step-up factor" },
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
 * A person "has a factor" when an action PIN is stored (even a disabled one:
 * otherwise guessing it into the hard lock would let a fresh sign-in set a new
 * one) or any passkey is registered (even a suspended one).
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
 * person has no factor yet, else `step_up_required` (detail = the level).
 * Success costs one read (the session's step-up row).
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
  if (!(await hasFactor(ctx, who.userId))) fail("step_up_setup_required", { detail: level });
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

/**
 * May this session add or change a factor? "bootstrap": the person has none
 * yet and signed in with their password (and TOTP when enrolled) less than
 * STEP_UP_BOOTSTRAP_MS ago. "fresh": a fresh step-up. Otherwise it throws:
 * `step_up_setup_required` (detail "reauthenticate": sign in again) or
 * `step_up_required` (detail "fresh").
 */
export async function authorizeFactorChange(
  ctx: { db: DatabaseReader },
  who: Who,
  now: number,
): Promise<"bootstrap" | "fresh"> {
  if (!(await hasFactor(ctx, who.userId))) {
    const session = await ctx.db.get(who.sessionId);
    const recent = session !== null && now - session._creationTime <= STEP_UP_BOOTSTRAP_MS;
    if (!recent) fail("step_up_setup_required", { detail: "reauthenticate" });
    const mfa = await ctx.db
      .query("memberSecrets")
      .withIndex("by_user", (q) => q.eq("userId", who.userId))
      .first();
    if (mfa?.totpSecret !== undefined) {
      const passed = await ctx.db
        .query("mfaSessions")
        .withIndex("by_session", (q) => q.eq("sessionId", who.sessionId))
        .first();
      if (passed === null) fail("mfa_required");
    }
    return "bootstrap";
  }
  await checkStepUpOrFail(ctx, who, "fresh", now);
  return "fresh";
}

/** Delete every step-up row of a user (optionally only those verified with one passkey). */
export async function deleteStepUpSessions(
  ctx: { db: DatabaseWriter },
  userId: Id<"users">,
  onlyPasskey?: Id<"passkeys">,
  limit = 100,
): Promise<void> {
  const rows = await ctx.db
    .query("stepUpSessions")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .take(limit);
  for (const r of rows) {
    if (onlyPasskey === undefined || r.passkeyId === onlyPasskey) await ctx.db.delete(r._id);
  }
}
