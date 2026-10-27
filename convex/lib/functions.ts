import { customAction, customMutation, customQuery, NoOp } from "convex-helpers/server/customFunctions";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { action, mutation, query } from "../_generated/server";
import { requireMember, type Role } from "./authz";
import { checkDevice, settleRotation, type DeviceCheck } from "./deviceAuth";
import { fail } from "./errors";
import { checkStepUpOrFail, touchActivity, type MajorAction, type StepUpLevel } from "./stepUp";

// The only place that turns Convex's raw builders into public functions
// (plan Phase 4, rule 3; a lint rule forbids `query` / `mutation` / `action`
// imports anywhere else).
//
// - member*: signed-in members of an organization, by minimum role. Owners
//   and Admins also need a TOTP-verified session (`mfa_required`) unless the
//   function is one of the five mfa:* entry points (`skipMfa`).
// - device*: the agent with its device id + secret (consumed by the wrapper).
// - public*: unauthenticated; ONLY health:ping, account:me,
//   account:redeemReset and enrollment:enroll.

export type { Role };

/**
 * - `skipMfa`: the mfa:* entry points (how a session passes MFA); also skips
 *   step-up.
 * - `major`: a major action (plan 4.16): needs a fresh step-up. The name must
 *   be this function's own `file:name` and be listed in `MAJOR_ACTIONS`
 *   (`stepUp.test.ts` checks both).
 * - `stepUp: "none"`: the step-up entry points themselves (verify, set up,
 *   lock). Every other member mutation or action needs an UNLOCKED session.
 *   Queries never check step-up (the dashboard's idle lock hides screens).
 */
export type MemberOpts = { skipMfa?: true; stepUp?: "none"; major?: MajorAction };

export function stepUpLevelOf(opts: MemberOpts): StepUpLevel | null {
  if (opts.major !== undefined) return "fresh";
  if (opts.skipMfa === true || opts.stepUp === "none") return null;
  return "unlocked";
}

/** The wrappers add no arguments to the handler's own. */
type NoArgs = Record<never, never>;

export type AuditActorCtx = { type: "member"; id: string; label: string };

export type MemberCtx = {
  member: Doc<"members">;
  orgId: Id<"organizations">;
  userId: Id<"users">;
  sessionId: Id<"authSessions">;
  actor: AuditActorCtx;
};

/** Consumed by every member wrapper; the Phase 4 dashboard never sends it. */
const orgIdArg = { orgId: v.optional(v.id("organizations")) };

function actorOf(member: Doc<"members">): AuditActorCtx {
  return { type: "member", id: member._id, label: member.email };
}

export function memberQuery(minRole: Role, opts: MemberOpts = {}) {
  return customQuery(query, {
    args: orgIdArg,
    input: async (ctx, args): Promise<{ ctx: MemberCtx; args: NoArgs }> => {
      const m = await requireMember(ctx, minRole, { skipMfa: opts.skipMfa, orgId: args.orgId });
      return { ctx: { ...m, actor: actorOf(m.member) }, args: {} };
    },
  });
}

export function memberMutation(minRole: Role, opts: MemberOpts = {}) {
  return customMutation(mutation, {
    args: orgIdArg,
    input: async (ctx, args): Promise<{ ctx: MemberCtx; args: NoArgs }> => {
      const now = Date.now();
      const m = await requireMember(ctx, minRole, { skipMfa: opts.skipMfa, orgId: args.orgId, now });
      const level = stepUpLevelOf(opts);
      if (level !== null) {
        const row = await checkStepUpOrFail(ctx, m, level, now);
        // A member write is activity: at most one patch per quantum.
        await touchActivity(ctx, row, now);
      }
      return { ctx: { ...m, actor: actorOf(m.member) }, args: {} };
    },
  });
}

/** Actions have no `db`: the check runs in `internal.account.authorize` (an internal query). */
export function memberAction(minRole: Role, opts: MemberOpts = {}) {
  return customAction(action, {
    args: orgIdArg,
    input: async (ctx, args): Promise<{ ctx: MemberCtx; args: NoArgs }> => {
      const m: Omit<MemberCtx, "actor"> = await ctx.runQuery(internal.account.authorize, {
        minRole,
        skipMfa: opts.skipMfa === true,
        orgId: args.orgId,
        now: Date.now(),
        stepUp: stepUpLevelOf(opts) ?? undefined,
      });
      return { ctx: { ...m, actor: actorOf(m.member) }, args: {} };
    },
  });
}

// ---------------------------------------------------------------- devices

const deviceArgs = { deviceId: v.string(), deviceSecret: v.string() };

export type DeviceCtx = { device: Doc<"devices"> };

/** New device functions: unknown, wrong secret and revoked all answer `device_rejected`. */
export const deviceQuery = customQuery(query, {
  args: deviceArgs,
  input: async (ctx, args): Promise<{ ctx: DeviceCtx; args: NoArgs }> => {
    const check = await checkDevice(ctx, args);
    if (check.kind !== "ok") fail("device_rejected");
    return { ctx: { device: check.device }, args: {} };
  },
});

export const deviceMutation = customMutation(mutation, {
  args: deviceArgs,
  input: async (ctx, args): Promise<{ ctx: DeviceCtx; args: NoArgs }> => {
    const check = await checkDevice(ctx, args);
    if (check.kind !== "ok") fail("device_rejected");
    await settleRotation(ctx, check);
    return { ctx: { device: check.device }, args: {} };
  },
});

/** What a device action knows about its device (no secret hashes). */
export type DeviceRef = {
  _id: Id<"devices">;
  orgId: Id<"organizations">;
  groupId?: Id<"groups">;
  name: string;
};

export const deviceAction = customAction(action, {
  args: deviceArgs,
  input: async (ctx, args): Promise<{ ctx: { device: DeviceRef }; args: NoArgs }> => {
    const device: DeviceRef | null = await ctx.runQuery(internal.devices.authorizeDevice, args);
    if (device === null) fail("device_rejected");
    return { ctx: { device }, args: {} };
  },
});

/**
 * The three Phase 2 agent functions keep their wire answers
 * (`unknownDevice` / `revoked` / `rejected`, plan 5.1), so they get the
 * check result instead of an error.
 */
export const phase2DeviceQuery = customQuery(query, {
  args: deviceArgs,
  input: async (ctx, args): Promise<{ ctx: { deviceCheck: DeviceCheck }; args: NoArgs }> => {
    return { ctx: { deviceCheck: await checkDevice(ctx, args) }, args: {} };
  },
});

export const phase2DeviceMutation = customMutation(mutation, {
  args: deviceArgs,
  input: async (ctx, args): Promise<{ ctx: { deviceCheck: DeviceCheck }; args: NoArgs }> => {
    const check = await checkDevice(ctx, args);
    await settleRotation(ctx, check);
    return { ctx: { deviceCheck: check }, args: {} };
  },
});

// ---------------------------------------------------------------- public

/** ONLY health:ping, account:me (plan 4.6). */
export const publicQuery = customQuery(query, NoOp);
/** ONLY enrollment:enroll. */
export const publicMutation = customMutation(mutation, NoOp);
/** ONLY account:redeemReset. */
export const publicAction = customAction(action, NoOp);
