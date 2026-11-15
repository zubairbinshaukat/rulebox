import { MAX_BAKE_HOURS, MAX_FAILURE_PCT, MAX_RING_LIST, MIN_BAKE_HOURS, MIN_FAILURE_PCT, type Ring } from "../../data/types";
import type { KnownHaltReason, WholeProblem } from "../../lib/rolloutRules";
import { toAppError } from "../../lib/errors";

/** Strings of the rollout screen (Phase 5 Step 16, plan 4.14). Plain words: a "ring" is a set of PCs that get a change in turn. */
const n = (count: number, one: string, other: string) => `${count} ${count === 1 ? one : other}`;

export const rolloutStrings = {
  title: "Rollout",
  titleFor: (group: string) => `Rollout of ${group}`,
  lead: "Roll a change out to a few PCs first, then to more, instead of to every PC at once.",
  back: "Back to the group",
  loadingTitle: "Loading",
  // ---- no configuration yet
  noneTitle: "No configuration yet",
  noneBody: "Rings start once this group has a configuration. Assign an app or change a setting for the group, then come back.",
  // ---- the rings switch
  ringsTitle: "Staged rollout",
  ringsLead: "With rings on, a change reaches the pilot PCs first. You move it on to the early PCs and then to everyone, or let it move on by itself.",
  ringsOn: "Rings are on",
  ringsOff: "Rings are off",
  ringsSwitch: "Use rings for this group",
  ringsOffNote: "With rings off, every PC in this group gets the newest version at once.",
  ringsOnToast: "Rings turned on.",
  ringsOffToast: "Rings turned off.",
  ringsOffTitle: "Turn rings off?",
  ringsOffBody: "Every ring will get the newest version at once. PCs on an older version are updated.",
  ringsOffConfirm: "Turn off rings",
  // ---- rings
  rings: { pilot: "Pilot", early: "Early", everyone: "Everyone" } satisfies Record<Ring, string>,
  ringHelp: {
    pilot: "A few PCs that get every change first.",
    early: "More PCs that get it once the pilot looks fine.",
    everyone: "All other PCs.",
  } satisfies Record<Ring, string>,
  pointersTitle: "What each ring follows",
  pointersLead: "Each ring follows one configuration version.",
  pointersLeadOff: "Rings are off, so every ring follows the same version.",
  version: (v: number) => `Version ${v}`,
  versionUnknown: "No details kept for this version.",
  inFlight: "Getting it now",
  // ---- health
  healthTitle: "How the rollout is going",
  healthFor: (ring: string, version: number) => `${ring} ring, version ${version}`,
  healthNone: "Nothing is rolling out right now. Every ring follows the same version.",
  applied: "Applied",
  failed: "Failed",
  partial: "Partly applied",
  waiting: "Waiting",
  ringSize: (size: number) => `${n(size, "PC", "PCs")} in this ring`,
  ringCapped: (cap: number) => `This ring is larger than ${cap} PCs, so the numbers cover the first ${cap}.`,
  reportsCapped: "Reports may be incomplete: more reports exist than were read.",
  noPilotApplied: "No pilot PC has applied this version yet.",
  pilotRolledBack: "A pilot PC rolled this version back.",
  // ---- actions
  actionsTitle: "Move it on",
  actionsLead: "Promote a version to the next ring when the numbers look fine.",
  promoteEarly: "Promote to Early",
  promoteEveryone: "Promote to Everyone",
  promoteAll: "Promote all",
  rollback: "Roll back",
  resume: "Resume",
  promotedToast: "Promoted.",
  resumedToast: "Rollout resumed.",
  rolledBackToast: "Rolled back.",
  promoteAllTitle: "Promote to every ring?",
  promoteAllBody: (version: number) => `The Early and Everyone rings will get version ${version} now, without waiting.`,
  promoteAllConfirm: "Promote all",
  actionsHalted: "Resume the rollout before promoting.",
  actionsOff: "Rings are off. Turn them on to promote a version in steps.",
  actionsNothing: "Nothing to promote: every ring follows the same version.",
  // ---- halted
  haltedTitle: "This rollout is paused",
  haltReasons: {
    failure_rate: "Too many PCs failed to apply the new configuration.",
    pilot_rolled_back: "A pilot PC rolled the new configuration back.",
    rolled_back: "An administrator rolled this group back.",
  } satisfies Record<KnownHaltReason, string>,
  haltGeneric: "The rollout was stopped.",
  haltedHint: "Nothing moves on until you resume it.",
  // ---- rollback dialog
  rollbackTitle: "Roll back",
  rollbackLead: "Rollback makes the PCs use an older configuration. It does not change your current settings: the next edit takes a new version.",
  rollbackVersion: "Go back to",
  rollbackVersionOption: (v: number, reason: string, date: string) => `Version ${v}: ${reason} (${date})`,
  rollbackNoVersions: "No older version is kept for this group.",
  rollbackRings: "Which rings go back",
  rollbackRingsHint: "The rings you leave unticked keep their version.",
  rollbackRingsOff: "Rings are off, so every PC in this group goes back to this version.",
  rollbackRingsProblem: "Choose at least one ring.",
  rollbackConfirm: "Roll back",
  rollingBack: "Rolling back…",
  // ---- auto promotion
  autoTitle: "Automatic promotion",
  autoLead: "Let the rollout move on by itself when a stage has run long enough without failures, and stop it when too many PCs fail.",
  autoSwitch: "Promote automatically",
  autoSwitchHint: "Off by default. When off, you promote each stage yourself.",
  autoBake: "Wait before promoting (hours)",
  autoBakeHint: `A whole number from ${MIN_BAKE_HOURS} to ${MAX_BAKE_HOURS}. The stage must run this long first.`,
  autoPct: "Stop the rollout when this share of PCs fail (%)",
  autoPctHint: `A whole number from ${MIN_FAILURE_PCT} to ${MAX_FAILURE_PCT}.`,
  autoRollback: "Return the pilot ring to the early version when the rollout halts",
  autoRollbackHint: "Only the pilot ring goes back. You can resume or roll back further yourself.",
  autoSave: "Save settings",
  autoReset: "Discard changes",
  autoSaved: "Settings saved.",
  autoReadOnly: (on: boolean, bake: number, pct: number, back: boolean) =>
    `${on ? `Automatic promotion is on: ${n(bake, "hour", "hours")} per stage` : "Automatic promotion is off"}. A rollout stops at ${pct} % failures. ${back ? "The pilot ring goes back to the early version when it stops." : "The pilot ring stays on the new version when it stops."}`,
  whole: {
    empty: "Enter a number.",
    notWhole: "Use a whole number, digits only.",
  } satisfies Record<Exclude<WholeProblem, "range">, string>,
  bakeRange: `Use a number from ${MIN_BAKE_HOURS} to ${MAX_BAKE_HOURS}.`,
  pctRange: `Use a number from ${MIN_FAILURE_PCT} to ${MAX_FAILURE_PCT}.`,
  // ---- members
  membersTitle: "PCs and their rings",
  membersLead: "Choose PCs, then put them in a ring. A PC with no ring set is in Everyone.",
  membersNone: "No PCs in this group yet.",
  membersTruncated: `Showing the first ${MAX_RING_LIST} PCs`,
  selectAll: "Select all shown",
  selected: (count: number) => `${count} selected`,
  putIn: "Put selected PCs in:",
  selectPc: (name: string) => `Select ${name}`,
  ringChanged: (changed: number) => (changed === 0 ? "No PC changed: they were already there." : `${n(changed, "PC", "PCs")} moved.`),
  colPc: "PC",
  colRing: "Ring",
  // ---- errors
  noPilotEnable: "Put at least one PC in the pilot ring first.",
  noPilotRings: "Rings are on and this would leave the pilot ring empty.",
  ringsDisabled: "Rings are off for this group.",
  halted: "The rollout is paused. Resume it first.",
  nothingToPromote: "There is nothing to promote: every ring already follows that version.",
  versionMissing: "That version is no longer kept. Pick another one.",
  notHalted: "The rollout is not paused.",
  deviceRevoked: "A revoked PC cannot be put in a ring.",
  badBake: `Use a whole number of hours from ${MIN_BAKE_HOURS} to ${MAX_BAKE_HOURS}.`,
  badPct: `Use a whole percentage from ${MIN_FAILURE_PCT} to ${MAX_FAILURE_PCT}.`,
};

/** Which action an error belongs to: the same `conflict` reads differently when turning rings on and when moving PCs. */
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
