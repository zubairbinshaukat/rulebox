/**
 * Pure rules of the rollout page (UI pass, `docs/plans/ui-pass/other-pages.md` section 3): which state each stage is in, how many PCs
 * each stage has, the "Careful" / "Quick" presets of "Moves on by itself", and which older change "Undo the last change" goes back to.
 * No React, no data hooks: the page and the tests read the same functions.
 */
import type { Ring, RolloutRow, RolloutView } from "../../data/types";
import type { AutoPromoteDraft } from "../../lib/rolloutRules";

/** What a stage card says about its stage. `paused` = this is the stage in flight and the rollout is halted. */
export type StageState = "done" | "testing" | "waiting" | "paused";

/** The state of each stage from the rollout row and the stage in flight (`view.stage`, null when stages are off or all are level). */
export function stageStates(rollout: RolloutRow, stage: RolloutView["stage"]): Record<Ring, StageState> {
  const halted = rollout.state === "halted";
  const state = (ring: Ring): StageState => {
    if (stage === null) return "done";
    if (stage.ring === ring) return halted ? "paused" : "testing";
    // Pilot in flight: Early and Everyone wait. Early in flight: First is through, Everyone waits.
    return ring === "pilot" ? "done" : "waiting";
  };
  return { pilot: state("pilot"), early: state("early"), everyone: state("everyone") };
}

/** The stage a change moves on to from the stage in flight; null when nothing is in flight. */
export function nextStage(stage: RolloutView["stage"]): "early" | "everyone" | null {
  if (stage === null) return null;
  return stage.ring === "pilot" ? "early" : "everyone";
}

/** How many of the listed PCs each stage has. The list is the first 100 PCs: with `truncated` the numbers are "at least". */
export function stageCounts(view: Pick<RolloutView, "devices" | "devicesTruncated">): { counts: Record<Ring, number>; truncated: boolean } {
  const counts: Record<Ring, number> = { pilot: 0, early: 0, everyone: 0 };
  for (const d of view.devices) counts[d.ring] += 1;
  return { counts, truncated: view.devicesTruncated };
}

/** The version a stage follows. */
export function pointerOf(rollout: RolloutRow, ring: Ring): number {
  return rollout.pointers[ring];
}

/** The change (reason + date) behind a version, or undefined when it is no longer kept. */
export function changeOf(versions: RolloutView["versions"], version: number): RolloutView["versions"][number] | undefined {
  return versions.find((v) => v.version === version);
}

/** The change "Undo the last change" goes back to: the newest one older than the newest any stage follows. Undefined = nothing older kept. */
export function previousChange(rollout: RolloutRow, versions: RolloutView["versions"]): RolloutView["versions"][number] | undefined {
  const newest = Math.max(rollout.pointers.pilot, rollout.pointers.early, rollout.pointers.everyone);
  return [...versions].sort((a, b) => b.version - a.version).find((v) => v.version < newest);
}

// ---------------------------------------------------------------- "Moves on by itself"

export type AutoMode = "off" | "careful" | "quick" | "custom";

/** The numbers behind the two presets: hours to wait, and the share of failing PCs that stops it (percent). */
export const PRESETS = {
  careful: { bakeHours: 24, maxFailurePct: 10 },
  quick: { bakeHours: 4, maxFailurePct: 20 },
} as const;

/** Which choice the draft is: Off, one of the presets, or Custom (on, with numbers that match neither). */
export function modeOf(d: AutoPromoteDraft): AutoMode {
  if (!d.enabled) return "off";
  const bake = d.bake.trim();
  const pct = d.pct.trim();
  for (const key of ["careful", "quick"] as const) {
    if (bake === String(PRESETS[key].bakeHours) && pct === String(PRESETS[key].maxFailurePct)) return key;
  }
  return "custom";
}

/** The draft after choosing a card: Off keeps the numbers (they are saved but unused), a preset sets them. Custom changes nothing. */
export function applyMode(d: AutoPromoteDraft, mode: AutoMode): AutoPromoteDraft {
  if (mode === "off") return { ...d, enabled: false };
  if (mode === "custom") return d;
  return { ...d, enabled: true, bake: String(PRESETS[mode].bakeHours), pct: String(PRESETS[mode].maxFailurePct) };
}

/** When the stage in flight moves on by itself (ms since the epoch), or null: auto promotion off, nothing in flight, halted, or no start time. */
export function movesOnAt(rollout: RolloutRow, stage: RolloutView["stage"]): number | null {
  if (!rollout.enabled || rollout.state === "halted" || stage === null || !rollout.autoPromote.enabled || rollout.stageStartedAt === null) return null;
  return rollout.stageStartedAt + rollout.autoPromote.bakeHours * 3_600_000;
}
