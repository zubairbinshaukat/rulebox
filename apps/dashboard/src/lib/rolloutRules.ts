/**
 * Rules of the rollout screen (Phase 5 Step 16, plan 4.14): the same limits `convex/rollouts.ts` enforces, so the form can say
 * what is wrong before the server does.
 */
import { MAX_BAKE_HOURS, MAX_FAILURE_PCT, MIN_BAKE_HOURS, MIN_FAILURE_PCT, type RolloutRow } from "../data/types";

export type WholeProblem = "empty" | "notWhole" | "range";

/** The problem with a whole-number field (trimmed text, digits only), or null. */
export function wholeProblem(text: string, min: number, max: number): WholeProblem | null {
  const t = text.trim();
  if (t === "") return "empty";
  if (!/^\d+$/.test(t)) return "notWhole";
  const n = Number(t);
  return n < min || n > max ? "range" : null;
}

export const bakeProblem = (text: string) => wholeProblem(text, MIN_BAKE_HOURS, MAX_BAKE_HOURS);
export const failureProblem = (text: string) => wholeProblem(text, MIN_FAILURE_PCT, MAX_FAILURE_PCT);

/** Halt codes the screen has words for; any other code gets the generic sentence. */
export const KNOWN_HALT_REASONS = ["failure_rate", "pilot_rolled_back", "rolled_back"] as const;
export type KnownHaltReason = (typeof KNOWN_HALT_REASONS)[number];

export function knownHaltReason(code: string | null): KnownHaltReason | null {
  return KNOWN_HALT_REASONS.find((k) => k === code) ?? null;
}

/** The numbers `rollouts:setAutoPromote` is sent, from the draft text (the caller has checked the problems). */
export interface AutoPromoteDraft {
  enabled: boolean;
  bake: string;
  pct: string;
  autoRollback: boolean;
}

export function draftOf(r: RolloutRow): AutoPromoteDraft {
  return { enabled: r.autoPromote.enabled, bake: String(r.autoPromote.bakeHours), pct: String(r.autoPromote.maxFailurePct), autoRollback: r.autoRollback };
}

/** Whether the draft differs from what is saved (the text is compared as the number it will be sent as). */
export function draftChanged(d: AutoPromoteDraft, r: RolloutRow): boolean {
  return d.enabled !== r.autoPromote.enabled || d.autoRollback !== r.autoRollback || d.bake.trim() !== String(r.autoPromote.bakeHours) || d.pct.trim() !== String(r.autoPromote.maxFailurePct);
}
