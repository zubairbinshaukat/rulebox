import { MAX_BAKE_HOURS, MAX_FAILURE_PCT, MAX_RING_LIST, MIN_BAKE_HOURS, MIN_FAILURE_PCT, type Ring } from "../../data/types";
import type { KnownHaltReason, WholeProblem } from "../../lib/rolloutRules";
import { toAppError } from "../../lib/errors";
import type { AutoMode, StageState } from "./stages";

/**
 * Strings of the rollout page (UI pass, `docs/plans/ui-pass/other-pages.md` section 3.7). Plain words: the three stages are First, Early
 * and Everyone (the same words as "Gets changes" on the PC page). The code still says `pilot`; the screen never does. No version numbers
 * in the main text: they sit in "Technical details" and in a tooltip.
 */
const n = (count: number, one: string, other: string) => `${count} ${count === 1 ? one : other}`;

export const rolloutStrings = {
  title: "Staged rollout",
  lead: (group: string) => `${group}: send changes to a few PCs first.`,
  leadInfoLabel: "About staged rollout",
  leadInfo: "A change reaches the First PCs first. When they look fine you send it on to the Early PCs, then to everyone. It can also move on by itself.",
  backFallback: "Back to the group",
  loadingTitle: "Loading",
  moreLabel: "More about the rollout",
  // ---- no changes yet
  noneTitle: "This group has no changes to send yet",
  noneBody: "Assign an app or change a setting for the group first, then come back.",
  noneAction: "Open the group",
  // ---- stages
  stages: { pilot: "First", early: "Early", everyone: "Everyone" } satisfies Record<Ring, string>,
  stageHelp: {
    pilot: "One or two PCs you can check yourself.",
    early: "A few more PCs.",
    everyone: "All other PCs in the group.",
  } satisfies Record<Ring, string>,
  stagesLabel: "Stages of the rollout",
  stageHelpLabel: (stage: string) => `About ${stage}`,
  stageCount: (count: number, truncated: boolean) => (truncated ? `${count}+ PCs` : n(count, "PC", "PCs")),
  stageStates: { done: "Up to date", testing: "Testing now", waiting: "Waiting", paused: "Paused" } satisfies Record<StageState, string>,
  hasLabel: { done: "Has", testing: "Getting now", waiting: "Still has", paused: "Stopped on" } satisfies Record<StageState, string>,
  waitsFor: (stage: string) => `Gets it after ${stage}.`,
  versionTitle: (version: number) => `Version ${version}`,
  unknownChange: "No details kept for this change.",
  allLevel: "Every stage is up to date. The next change you make goes to First first.",
  // ---- stage progress
  progressLabel: (done: number, size: number) => `${done} of ${n(size, "PC", "PCs")} done`,
  done: "Done",
  failed: "Failed",
  partial: "Partly done",
  waiting: "Waiting",
  healthLabel: "How the PCs of this stage are doing",
  stageEmpty: "No PCs are in this stage yet.",
  noFirstDone: "No First PC has this change yet.",
  firstWentBack: "A First PC went back to its last working settings.",
  cappedInfoLabel: "About these numbers",
  cappedInfo: (cap: number) => `This stage has more than ${cap} PCs, so the numbers cover the first ${cap}.`,
  reportsCapped: "Reports may be incomplete: more reports exist than were read.",
  movesOnIn: (time: string) => `Moves on by itself in ${time} if nothing fails.`,
  movesOnSoon: "Moves on by itself soon if nothing fails.",
  // ---- actions
  sendEarly: "Send to Early PCs",
  sendEveryone: "Send to everyone",
  sendEveryoneNow: "Send to everyone now",
  sendEveryoneTitle: "Send to everyone now?",
  sendEveryoneBody: "Every PC in this group gets this change now, without waiting.",
  sendEveryoneConfirm: "Send to everyone",
  undo: "Undo the last change",
  resume: "Resume",
  sentToast: "Sent on.",
  resumedToast: "Rollout resumed.",
  // ---- turning on and off
  heroTitle: "Try changes on a few PCs first",
  heroBody: "Pick one or two PCs that get every change first. When they look fine, the change moves on to more PCs, then to everyone.",
  heroSteps: ["First", "Early", "Everyone"],
  heroViewer: "Staged rollout is off, so every PC in this group gets a change at once.",
  turnOn: "Turn on",
  turnOnNoPcs: "Add PCs to this group first.",
  turnOff: "Turn off",
  turnOffTitle: "Turn off the staged rollout?",
  turnOffBody: "Every PC in this group gets the newest change at once. PCs on an older change are updated.",
  turnOffConfirm: "Turn off",
  turnedOnToast: "Staged rollout is on.",
  turnedOffToast: "Staged rollout is off.",
  // ---- the first PCs dialog
  firstTitle: "Which PCs get changes first?",
  firstLead: "These PCs get every change before the rest. Pick one or two you can check yourself.",
  firstFind: "Find a PC",
  firstNone: "No PC matches.",
  firstPick: (count: number) => (count === 0 ? "Pick at least one PC." : `${n(count, "PC", "PCs")} picked`),
  firstConfirm: "Turn on",
  firstWorking: "Turning on…",
  // ---- halted
  haltedTitle: "This rollout is paused",
  haltReasons: {
    failure_rate: "Too many PCs could not apply the change.",
    pilot_rolled_back: "A first PC went back to its last working settings.",
    rolled_back: "Someone undid the change.",
  } satisfies Record<KnownHaltReason, string>,
  haltGeneric: "The rollout was stopped.",
  haltedHint: "Nothing moves on until you resume it.",
  // ---- technical details
  technical: "Technical details",
  technicalVersion: (stage: string, version: number) => `${stage} follows version ${version}`,
  // ---- undo dialog
  undoTitle: "Undo the last change",
  undoLead: "Your settings stay as they are; only the PCs go back.",
  undoInfoLabel: "About undoing a change",
  undoInfo: "The next change you make is sent as a new one.",
  undoGoesBack: "PCs go back to",
  undoNothing: "There is no older change to go back to.",
  undoConfirm: "Undo the change",
  undoWorking: "Going back…",
  undoToast: "The PCs are going back.",
  undoAdvanced: "Advanced",
  undoPick: "Choose another change",
  undoPickOption: (reason: string, date: string) => `${date}: ${reason}`,
  undoPickHint: (version: number) => `Version ${version}`,
  undoStages: "Which stages go back",
  undoStagesHint: "The stages you leave unticked keep what they have.",
  undoStagesProblem: "Choose at least one stage.",
  undoStagesOff: "Every PC in this group goes back.",
  // ---- moves on by itself
  autoTitle: "Moves on by itself",
  autoInfoLabel: "About moving on by itself",
  autoInfo: "A change waits in each stage, then moves to the next one if the PCs have not failed. It stops if too many fail.",
  autoModes: { off: "Off", careful: "Careful", quick: "Quick", custom: "Custom" } satisfies Record<AutoMode, string>,
  autoModeHint: {
    off: "You send each step yourself.",
    careful: "After 24 hours, if fewer than 10 % fail.",
    quick: "After 4 hours, if fewer than 20 % fail.",
  },
  autoCustomHint: (hours: string, pct: string) => `${hours} ${hours === "1" ? "hour" : "hours"}, stops at ${pct} %`,
  autoChoose: "How should it move on?",
  autoAdvanced: "Advanced",
  autoBake: "Wait before moving on (hours)",
  autoBakeInfo: `Each stage waits this long before the change moves on. A whole number from ${MIN_BAKE_HOURS} to ${MAX_BAKE_HOURS}.`,
  autoPct: "Stop when this share fails (%)",
  autoPctInfo: `If this share of the PCs in a stage fails, nothing moves on and the rollout pauses. A whole number from ${MIN_FAILURE_PCT} to ${MAX_FAILURE_PCT}.`,
  autoBack: "Send the first PCs back when it stops",
  autoBackInfoLabel: "About sending the first PCs back",
  autoBackInfo: "When the rollout pauses, the First PCs go back to the previous change. You can resume or undo it yourself.",
  autoSave: "Save",
  autoReset: "Discard changes",
  autoSaved: "Saved.",
  autoReadOnly: (mode: AutoMode, hours: number, pct: number) =>
    mode === "off" ? "You send each step yourself." : `Moves on by itself after ${n(hours, "hour", "hours")} if fewer than ${pct} % fail.`,
  autoReadOnlyBack: (back: boolean) => (back ? "The First PCs go back if it stops." : "The First PCs keep the change if it stops."),
  whole: {
    empty: "Enter a number.",
    notWhole: "Use a whole number, digits only.",
  } satisfies Record<Exclude<WholeProblem, "range">, string>,
  bakeRange: `Use a number from ${MIN_BAKE_HOURS} to ${MAX_BAKE_HOURS}.`,
  pctRange: `Use a number from ${MIN_FAILURE_PCT} to ${MAX_FAILURE_PCT}.`,
  // ---- which PCs go first
  membersTitle: "Which PCs go first",
  membersInfoLabel: "About the stages of a PC",
  membersInfo: "A PC in First gets every change first. A PC with no stage set is in Everyone.",
  membersNone: "No PCs in this group yet.",
  membersTruncated: `Showing the first ${MAX_RING_LIST} PCs`,
  membersFind: "Find a PC",
  membersNoMatch: "No PC matches.",
  selectAll: "Select all shown",
  selected: (count: number) => `${count} selected`,
  moveTo: "Move to",
  move: "Move",
  moving: "Moving…",
  selectPc: (name: string) => `Select ${name}`,
  ringChanged: (changed: number) => (changed === 0 ? "No PC changed: they were already there." : `${n(changed, "PC", "PCs")} moved.`),
  // ---- errors
  noPilotEnable: "Pick at least one PC for First before turning this on.",
  noPilotRings: "This would leave First with no PC.",
  ringsDisabled: "The staged rollout is off for this group.",
  halted: "The rollout is paused. Resume it first.",
  nothingToPromote: "There is nothing to send on: every stage already has this change.",
  versionMissing: "That change is no longer kept. Pick another one.",
  notHalted: "The rollout is not paused.",
  deviceRevoked: "A revoked PC cannot be put in a stage.",
  badBake: `Use a whole number of hours from ${MIN_BAKE_HOURS} to ${MAX_BAKE_HOURS}.`,
  badPct: `Use a whole percentage from ${MIN_FAILURE_PCT} to ${MAX_FAILURE_PCT}.`,
};

/** Which action an error belongs to: the same `conflict` reads differently when turning on and when moving PCs. */
export type RolloutContext = "enable" | "rings" | "other";

/** The sentence for the refusals of the rollout functions that need their own words (null = the usual sentence). */
export function rolloutErrorMessage(error: unknown, context: RolloutContext = "other"): string | null {
  const e = toAppError(error);
  if (!e) return null;
  const s = rolloutStrings;
  if (e.code === "conflict") {
    switch (e.detail) {
      case "no_pilot_devices":
        return context === "rings" ? s.noPilotRings : s.noPilotEnable;
      case "rings_disabled":
        return s.ringsDisabled;
      case "halted":
        return s.halted;
      case "nothing_to_promote":
        return s.nothingToPromote;
      case "version_missing":
        return s.versionMissing;
      case "not_halted":
        return s.notHalted;
      case "device revoked":
        return s.deviceRevoked;
      default:
        return null;
    }
  }
  if (e.code === "invalid_argument") {
    if (e.field === "bakeHours") return s.badBake;
    if (e.field === "maxFailurePct") return s.badPct;
  }
  return null;
}
