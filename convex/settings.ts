import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalMutation, type DatabaseWriter } from "./_generated/server";
import { hashSecret } from "./lib/argon";
import { writeAudit } from "./lib/audit";
import { checkRevision, nextRevision } from "./lib/authz";
import { fail } from "./lib/errors";
import { memberAction, memberMutation, memberQuery } from "./lib/functions";
import { changedSettings, exitPinProblem, normalizeOrgName, normalizeSettings } from "./lib/orgSettings";
import { counterOf, effectivePingInterval, LIMITS, loadOrgPlan, loadOrgStats, loadPlatformSettings } from "./lib/plans";
import { requestPublish } from "./lib/publish";
import { requireStepUp } from "./lib/stepUp";
import { DEFAULT_ORG_SETTINGS, orgSettings, planLimits, planName, planStatus } from "./lib/validators";

// Settings → Organization and Admin exit (plan Step 5, Section 4.10).
//
// The device EXIT PIN (Staff App admin exit) is not the member's ACTION PIN
// (step-up, plan 4.16); neither is ever accepted for the other. The exit PIN
// is hashed in an action (Argon2id, lib/argon.ts), stored in `orgSecrets`
// (written here, read only by the publisher from Step 8) and never returned,
// logged or audited: `get` answers `exitPin.set` from
// `organizations.exitPinSetAt` without touching `orgSecrets`.

/** Organization name, settings and whether an exit PIN is set (viewer). Never the hash. */
export const get = memberQuery("viewer")({
  args: {},
  returns: v.object({
    name: v.string(),
    revision: v.number(),
    settings: orgSettings,
    exitPin: v.object({ set: v.boolean(), setAt: v.optional(v.number()) }),
  }),
  handler: async (ctx) => {
    const org = await ctx.db.get(ctx.orgId);
    if (org === null) fail("not_found");
    return {
      name: org.name,
      revision: org.revision ?? 0,
      settings: org.settings ?? DEFAULT_ORG_SETTINGS,
      exitPin: { set: org.exitPinSetAt !== undefined, setAt: org.exitPinSetAt },
    };
  },
});

/**
 * Change the name and settings (admin). `stale_edit` when someone saved in
 * between. Changing the admin exit (enabled or key combination) is a major
 * action: it needs a fresh step-up; everything else an unlocked session.
 * Nothing changed = no write, no audit, no publish.
 */
export const update = memberMutation("admin")({
  args: { expectedRevision: v.number(), name: v.string(), settings: orgSettings },
  returns: v.object({ revision: v.number(), changed: v.array(v.string()) }),
  handler: async (ctx, args) => {
    const org = await ctx.db.get(ctx.orgId);
    if (org === null) fail("not_found");
    checkRevision(org, args.expectedRevision);
    const name = normalizeOrgName(args.name);
    const settings = normalizeSettings(args.settings);
    const before = org.settings ?? DEFAULT_ORG_SETTINGS;
    const changed: string[] = changedSettings(before, settings);
    if (name !== org.name) changed.unshift("name");
    if (changed.length === 0) return { revision: org.revision ?? 0, changed };
    if (changed.includes("adminExit")) await requireStepUp(ctx, "fresh");
    const revision = nextRevision(org);
    await ctx.db.patch(org._id, { name, settings, revision });
    await writeAudit(ctx, {
      orgId: ctx.orgId,
      actor: ctx.actor,
      action: "org.settingsChanged",
      targetType: "organization",
      targetId: org._id,
      targetLabel: name,
      summary: `Changed organization settings: ${changed.join(", ")}`,
    });
    await requestPublish(ctx, ctx.orgId, { allDevices: true });
    return { revision, changed };
  },
});

/**
 * Set or replace the device exit PIN (admin, major). The PIN is checked and
 * hashed here and only the Argon2id hash reaches the database.
 */
export const setExitPin = memberAction("admin", { major: "settings:setExitPin" })({
  args: { pin: v.string() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const problem = exitPinProblem(args.pin);
    if (problem !== null) fail("invalid_argument", { field: "pin", detail: problem });
    const phc = await hashSecret(ctx, args.pin);
    await ctx.runMutation(internal.settings.storeExitPin, { orgId: ctx.orgId, actor: ctx.actor, phc });
    return null;
  },
});

const actorArg = v.object({ type: v.literal("member"), id: v.string(), label: v.string() });

/** The single writer of `orgSecrets.exitPinHash` (plan 4.7). */
export const storeExitPin = internalMutation({
  args: { orgId: v.id("organizations"), actor: actorArg, phc: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (!args.phc.startsWith("$argon2id$")) fail("invalid_argument");
    const replaced = await writeExitPinHash(ctx, args.orgId, args.phc);
    await writeAudit(ctx, {
      orgId: args.orgId,
      actor: args.actor,
      action: "org.exitPinSet",
      targetType: "organization",
      targetId: args.orgId,
      summary: replaced ? "Changed the device exit PIN" : "Set the device exit PIN",
    });
    await requestPublish(ctx, args.orgId, { allDevices: true });
    return null;
  },
});

/** Remove the device exit PIN (admin, major). No PIN set = no write. */
export const clearExitPin = memberMutation("admin", { major: "settings:clearExitPin" })({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const org = await ctx.db.get(ctx.orgId);
    if (org === null) fail("not_found");
    if (org.exitPinSetAt === undefined) return null;
    await writeExitPinHash(ctx, ctx.orgId, undefined);
    await writeAudit(ctx, {
      orgId: ctx.orgId,
      actor: ctx.actor,
      action: "org.exitPinCleared",
      targetType: "organization",
      targetId: ctx.orgId,
      summary: "Removed the device exit PIN",
    });
    await requestPublish(ctx, ctx.orgId, { allDevices: true });
    return null;
  },
});

/** Write (or clear) the hash and the "set" marker together. True when a PIN was set before. */
async function writeExitPinHash(
  ctx: { db: DatabaseWriter },
  orgId: Id<"organizations">,
  phc: string | undefined,
): Promise<boolean> {
  const org = await ctx.db.get(orgId);
  if (org === null) fail("not_found");
  const secrets = await ctx.db
    .query("orgSecrets")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .unique();
  if (secrets === null) {
    if (phc !== undefined) await ctx.db.insert("orgSecrets", { orgId, exitPinHash: phc });
  } else {
    await ctx.db.patch(secrets._id, { exitPinHash: phc });
  }
  await ctx.db.patch(orgId, { exitPinSetAt: phc === undefined ? undefined : Date.now() });
  return org.exitPinSetAt !== undefined;
}

/**
 * The organization's plan, limits and usage (viewer), for the "Add" dialogs
 * and a plan banner (post-Phase-5 3.3). Changes only when the operator edits
 * the plan or a counted thing is created or deleted.
 */
export const plan = memberQuery("viewer")({
  args: {},
  returns: v.object({
    plan: planName,
    status: planStatus,
    suspendedReason: v.optional(v.string()),
    limits: planLimits,
    usage: v.object({
      devices: v.number(),
      employees: v.number(),
      apps: v.number(),
      groups: v.number(),
      members: v.number(),
      enrollmentCodes: v.number(),
    }),
    pingIntervalMs: v.number(),
  }),
  handler: async (ctx) => {
    const p = await loadOrgPlan(ctx, ctx.orgId);
    const stats = await loadOrgStats(ctx, ctx.orgId);
    const global = p.pingIntervalMs === undefined ? await loadPlatformSettings(ctx) : null;
    return {
      plan: p.plan,
      status: p.status,
      suspendedReason: p.row?.suspendedReason,
      limits: p.limits,
      usage: {
        devices: counterOf(stats, LIMITS.devices.counter),
        employees: counterOf(stats, LIMITS.employees.counter),
        apps: counterOf(stats, LIMITS.apps.counter),
        groups: counterOf(stats, LIMITS.groups.counter),
        members: counterOf(stats, LIMITS.members.counter),
        enrollmentCodes: counterOf(stats, LIMITS.enrollmentCodes.counter),
      },
      pingIntervalMs: effectivePingInterval(p, global),
    };
  },
});
