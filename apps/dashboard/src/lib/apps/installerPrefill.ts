// What "Detect" fills into the form (Phase 6 Step 13). Only the lazy installer chunk uses it, so it is not part of `installerRules.ts`
// (which the App screen itself carries for its inline checks).
import type { InstallerInspection, WizardTech } from "../../data/types";
import { formatExitCodes, parseExitCodes, storedTech } from "./installerRules";
/** The fields a detection may fill (all text in the form). */
export interface PrefillTarget {
  silentArgs: string;
  successCodes: string;
  tech: WizardTech | "";
  answerOn: boolean;
}

export type PrefillKey = "silentArgs" | "successCodes" | "tech";

/**
 * What a detection fills in. NEVER overwrites what the admin typed: switches only when the field is empty, success codes only
 * while they are still the default `0`, the technology only while none is picked. `kept` lists the fields that had text of the
 * admin's own that differs from the suggestion, so the screen can say so. Nothing is saved: the admin presses Save.
 */
export function prefillFrom(current: PrefillTarget, r: InstallerInspection, joinArgs: (a: string[]) => string): { patch: Partial<PrefillTarget>; kept: PrefillKey[]; prefilled: { silentArgs?: string; successCodes?: string } } {
  const patch: Partial<PrefillTarget> = {};
  const kept: PrefillKey[] = [];
  const suggestedArgs = joinArgs(r.silentArgs);
  const suggestedCodes = formatExitCodes(r.successExitCodes);
  // An MSI package gets its switches from the agent: there is nothing to fill.
  if (r.kind === "exe") {
    if (current.silentArgs.trim() === "") {
      if (suggestedArgs !== "") patch.silentArgs = suggestedArgs;
    }
    else if (current.silentArgs.trim() !== suggestedArgs) kept.push("silentArgs");
    const codes = parseExitCodes(current.successCodes);
    if (codes !== null && codes.length === 1 && codes[0] === 0) {
      if (suggestedCodes !== current.successCodes.trim()) patch.successCodes = suggestedCodes;
    }
    else if (formatExitCodes(codes ?? []) !== suggestedCodes) kept.push("successCodes");
  }
  const tech = storedTech(r.tech);
  if (current.tech === "") {
    if (tech !== "") patch.tech = tech;
  } else if (current.tech !== tech) {
    kept.push("tech");
  }
  if (r.needsAnswerFile && !current.answerOn) patch.answerOn = true;
  return {
    patch,
    kept,
    // Only what was filled in carries an "edited" mark later: a field the admin typed is theirs.
    prefilled: { ...(patch.silentArgs !== undefined ? { silentArgs: patch.silentArgs } : {}), ...(patch.successCodes !== undefined ? { successCodes: patch.successCodes } : {}) },
  };
}
