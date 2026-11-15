import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseReader, MutationCtx } from "../_generated/server";
import { SYSTEM_ACTOR, writeAudit } from "./audit";
import { fail } from "./errors";
import { PROMOTE_MIN_SHARE, RING_COUNT_CAP, ROLLOUT_HEALTH_READ } from "./limits";
import { requestPublish } from "./publish";

// Rollout rings (Phase 5 Step 16, plan 4.14): the pure decisions (which stage is in flight, what the health numbers say, whether to
// halt or promote) and the loaders and writers shared by `rollouts.ts` (admin mutations, the health query) and the 15-minute tick.
// A "stage" is the ring that is currently receiving the newest version: `pilot` while the pilot pointer is ahead of `early`, then
// `early` while `early` is ahead of `everyone`. No stage = every pointer names the same version (state `idle`).

export type Pointers = Doc<"groupRollouts">["pointers"];
export type Stage = { ring: "pilot" | "early"; version: number };

export function stageOf(p: Pointers): Stage | null {
  if (p.pilot !== p.early) return { ring: "pilot", version: p.pilot };
  if (p.early !== p.everyone) return { ring: "early", version: p.early };
  return null;
}

/** `idle` when every pointer names one version, else `rolling`. */
export function stateAfter(p: Pointers): "idle" | "rolling" {
  return stageOf(p) === null ? "idle" : "rolling";
}

export type Health = {
  /** The stage the numbers belong to; null = nothing is rolling out. */
  stage: Stage | null;
  /** PCs of the stage's ring (at most RING_COUNT_CAP; `ringCapped` says there are more). */
  ringSize: number;
  ringCapped: boolean;
  applied: number;
  /** `refused`, `failed` or `rolledBack` for the stage's version. */
  failed: number;
  /** `partial`: neither a success nor a failure. */
  partial: number;
  /** Ring PCs without a report for the stage's version (offline, not applied yet). Never counts as a success. */
  waiting: number;
  /** A pilot PC reported `rolledBack` for the stage's version. */
  pilotRolledBack: boolean;
  /** More reports exist for the version than were read (the numbers are a lower bound). */
  reportsCapped: boolean;
};

export const EMPTY_HEALTH: Health = {
  stage: null,
  ringSize: 0,
  ringCapped: false,
  applied: 0,
  failed: 0,
  partial: 0,
  waiting: 0,
  pilotRolledBack: false,
  reportsCapped: false,
};

/** PCs of the pilot or early ring in a group: `.take(limit)` through `devices.by_group_ring` (the "everyone" ring is the rest and is never listed here). */
export async function ringDevices(
  ctx: { db: DatabaseReader },
  groupId: Id<"groups">,
  ring: "pilot" | "early",
  limit: number,
): Promise<Doc<"devices">[]> {
  return await ctx.db
    .query("devices")
    .withIndex("by_group_ring", (q) => q.eq("groupId", groupId).eq("ring", ring))
    .take(limit);
}

/**
 * Plan 4.14 "ring health" for the stage in flight, from `deviceApplyReports.by_org_config` (one range, `.take(1001)`) and the stage
 * ring's devices (<= RING_COUNT_CAP + 1). Only reports of PCs that are in the ring NOW count (a PC moved to another ring or group stops
 * counting at once); `waiting` is the ring minus the PCs that have a report. When the stage is `early` the pilot ring is read too, for the
 * "any pilot device reported `rolledBack`" halt. Reads at most 1001 + 2 x 201 documents; nothing when idle.
 */
export async function ringHealth(
  ctx: { db: DatabaseReader },
  orgId: Id<"organizations">,
  groupId: Id<"groups">,
  pointers: Pointers,
): Promise<Health> {
  const stage = stageOf(pointers);
  if (stage === null) return EMPTY_HEALTH;
  const members = await ringDevices(ctx, groupId, stage.ring, RING_COUNT_CAP + 1);
  const ringCapped = members.length > RING_COUNT_CAP;
  const ids = new Set<string>(members.slice(0, RING_COUNT_CAP).map((d) => d._id));
  let pilotIds = ids;
  if (stage.ring === "early") {
    const pilots = await ringDevices(ctx, groupId, "pilot", RING_COUNT_CAP);
    pilotIds = new Set(pilots.map((d) => d._id as string));
  }
  const reports = await ctx.db
    .query("deviceApplyReports")
    .withIndex("by_org_config", (q) => q.eq("orgId", orgId).eq("config.groupId", groupId).eq("config.version", stage.version))
    .take(ROLLOUT_HEALTH_READ);
  let applied = 0;
  let failed = 0;
  let partial = 0;
  let pilotRolledBack = false;
  for (const r of reports) {
    if (r.state === "rolledBack" && pilotIds.has(r.deviceId)) pilotRolledBack = true;
    if (!ids.has(r.deviceId)) continue;
    if (r.state === "applied") applied++;
    else if (r.state === "partial") partial++;
    else failed++; // refused | failed | rolledBack
  }
  return {
    stage,
    ringSize: ids.size,
    ringCapped,
    applied,
    failed,
    partial,
    waiting: Math.max(0, ids.size - applied - failed - partial),
    pilotRolledBack,
    reportsCapped: reports.length >= ROLLOUT_HEALTH_READ,
  };
}

export type HaltReason = "failure_rate" | "pilot_rolled_back";
export type Decision =
  | { action: "none" }
  | { action: "halt"; reason: HaltReason }
  | { action: "promote"; to: "early" | "everyone" };

/**
 * PURE (plan 4.14). Halt first: the failure share `failed / (applied + failed)` reached `maxFailurePct`, or a pilot PC rolled back.
 * Else promote the stage when automatic promotion is on, the bake time has passed, nothing failed and at least `max(1, 50 % of the ring)`
 * PCs applied. Waiting PCs never block a promotion for ever (offline laptops are normal) but do not count as applied.
 */
export function decide(
  r: Pick<Doc<"groupRollouts">, "autoPromote" | "stageStartedAt">,
  h: Health,
  now: number,
): Decision {
  const stage = h.stage;
  if (stage === null) return { action: "none" };
  if (h.pilotRolledBack) return { action: "halt", reason: "pilot_rolled_back" };
  const judged = h.applied + h.failed;
  if (judged > 0 && (h.failed / judged) * 100 >= r.autoPromote.maxFailurePct) return { action: "halt", reason: "failure_rate" };
  if (!r.autoPromote.enabled || r.stageStartedAt === undefined) return { action: "none" };
  if (now - r.stageStartedAt < r.autoPromote.bakeHours * 3_600_000) return { action: "none" };
  if (h.failed > 0 || h.applied < Math.max(1, Math.ceil(h.ringSize * PROMOTE_MIN_SHARE))) return { action: "none" };
  return { action: "promote", to: stage.ring === "pilot" ? "early" : "everyone" };
}

/** The pointers after promoting `to` (`early` = the pilot version, `everyone` = the early version); null when there is nothing to promote. */
export function promotedPointers(p: Pointers, to: "early" | "everyone"): Pointers | null {
  if (to === "early") return p.pilot === p.early ? null : { ...p, early: p.pilot };
  return p.early === p.everyone ? null : { ...p, everyone: p.early };
}

export async function loadRollout(ctx: { db: DatabaseReader }, groupId: Id<"groups">): Promise<Doc<"groupRollouts"> | null> {
  return await ctx.db
    .query("groupRollouts")
    .withIndex("by_group", (q) => q.eq("groupId", groupId))
    .unique();
}

/** The audit actor of an automatic step. */
export const TICK_ACTOR = SYSTEM_ACTOR;

/**
 * Apply an automatic decision to a rollout (the tick). Halting stops promotions, audits `rollout.halted` and, when `autoRollback` is on
 * and the pilot ring was the stage, moves the pilot pointer back to the `early` version (audited `rollout.rolledBack`); the devices get it
 * as new content under a higher document version. A promotion audits `rollout.autoPromoted`. Every change bumps `revision`.
 */
export async function applyDecision(
  ctx: Pick<MutationCtx, "db" | "scheduler">,
  rollout: Doc<"groupRollouts">,
  group: Doc<"groups">,
  decision: Decision,
  health: Health,
  now: number,
): Promise<void> {
  if (decision.action === "none") return;
  const base = { orgId: rollout.orgId, actor: TICK_ACTOR, targetType: "group" as const, targetId: group._id, targetLabel: group.name };
  if (decision.action === "halt") {
    const stage = health.stage;
    const rollBack = rollout.autoRollback && stage !== null && stage.ring === "pilot";
    const pointers = rollBack ? { ...rollout.pointers, pilot: rollout.pointers.early } : rollout.pointers;
    await ctx.db.patch(rollout._id, {
      state: "halted",
      haltReason: decision.reason,
      pointers,
      stageStartedAt: undefined,
      revision: rollout.revision + 1,
    });
    await writeAudit(ctx, {
      ...base,
      action: "rollout.halted",
      summary: `Halted the rollout of the group ${group.name} because ${
        decision.reason === "pilot_rolled_back" ? "a pilot PC rolled the configuration back" : "too many PCs failed to apply it"
      }`,
    });
    if (rollBack) {
      await writeAudit(ctx, {
        ...base,
        action: "rollout.rolledBack",
        summary: `Automatically returned the pilot ring of the group ${group.name} to configuration version ${pointers.early}`,
      });
      await requestPublish(ctx, rollout.orgId, { groupIds: [group._id] });
    }
    return;
  }
  const next = promotedPointers(rollout.pointers, decision.to);
  if (next === null) return;
  await ctx.db.patch(rollout._id, {
    pointers: next,
    state: stateAfter(next),
    stageStartedAt: stateAfter(next) === "rolling" ? now : undefined,
    haltReason: undefined,
    revision: rollout.revision + 1,
  });
  await requestPublish(ctx, rollout.orgId, { groupIds: [group._id] });
  await writeAudit(ctx, {
    ...base,
    action: "rollout.autoPromoted",
    summary: `Automatically promoted the configuration of the group ${group.name} to the ${decision.to === "early" ? "early" : "everyone"} ring`,
  });
}

/** `no_pilot_devices`: a group with rings enabled needs at least one PC in the pilot ring. */
export async function requirePilotDevice(ctx: { db: DatabaseReader }, groupId: Id<"groups">, except?: Id<"devices">[]): Promise<void> {
  const pilots = await ctx.db
    .query("devices")
    .withIndex("by_group_ring", (q) => q.eq("groupId", groupId).eq("ring", "pilot"))
    .take((except?.length ?? 0) + 1);
  if (pilots.filter((d) => !(except ?? []).includes(d._id)).length === 0) fail("conflict", { detail: "no_pilot_devices" });
}
