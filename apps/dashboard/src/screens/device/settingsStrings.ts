import type { Ring } from "../../data/types";
import { toAppError } from "../../lib/errors";

/**
 * The words of the device page's Settings tab (UI pass 2026-11, `docs/plans/ui-pass/device-detail.md` section 7): General, Kiosk mode,
 * Advanced and the Danger zone. The one short line a user needs sits under a control; every longer explanation is an (i).
 * "Revoke" is "Disconnect this PC" in the UI only: the mutation, the audit action and the PRD term are unchanged.
 */
export const settingsText = {
  // ---- General
  general: "General",
  name: "Name",
  rename: "Rename",
  group: "Group",
  groupInfo: "The group decides which apps, settings and employees this PC gets. A move reaches the PC within a minute.",
  groupSearch: "Find a group",
  groupEmpty: "No group matches",
  chooseGroup: "Choose a group",
  noGroup: "No group",
  move: "Move",
  enrolled: "Enrolled",

  // ---- Kiosk mode
  kiosk: "Kiosk mode",
  kioskInfo: "Off shows a normal Windows desktop, for maintenance. Turn it back on when you are done.",
  kioskOn: "On",
  kioskOff: "Off",
  kioskOnLine: "Employees see the Rulebox desktop on this PC.",
  kioskOffLine: "This PC shows a normal Windows desktop.",

  // ---- Advanced
  advanced: "Advanced",
  ring: "Gets changes",
  ringInfo: "PCs set to First get every change before the others, so you can check it on one PC. Most PCs stay on With everyone.",
  ringNoGroup: "Put this PC in a group to choose when it gets changes.",
  ringSaved: "Saved.",
  rings: { pilot: "First (pilot)", early: "Early", everyone: "With everyone" } satisfies Record<Ring, string>,
  rotate: "Renew this PC's key",
  rotateInfo: "Gives the PC a new secret at its next check-in. Use it if you think the PC's key was copied. Nothing changes for employees.",
  rotateAction: "Renew key",
  rotateTitle: "Renew this PC's key?",
  rotateBody: "The PC gets a new secret the next time it checks in. Nothing changes for employees.",
  rotateRequested: "Done. The PC picks it up at its next check-in.",
  rotatePending: "Waiting for the PC to pick up its new key.",

  // ---- Danger zone
  dangerZone: "Danger zone",
  revoke: "Disconnect this PC",
  revokeLine: "It stops getting changes and keeps its current settings.",
  revokeInfo: "The PC stops getting changes and keeps its current settings. You can enroll it again later.",
  revokeTitle: "Disconnect this PC?",
  revokeBody: "The PC stops getting changes and can no longer talk to Rulebox. It keeps its current settings until you enroll it again or reset it.",
  remove: "Remove this PC",
  removeLine: "Deletes its reports and history from Rulebox.",
  removeInfo: "Deletes its reports and history from Rulebox. The audit log keeps a record.",
  removeTitle: "Remove this PC from Rulebox?",
  removeBody: "Its reports, install results and settings history are deleted. The audit log keeps the record.",
  removed: (name: string) => `${name} was removed.`,
  disconnectedNote: "This PC is disconnected. Remove it, or enroll it again with a new code.",
};

/** The refusals of `rollouts:setRings` for one PC, in words (null = the usual sentence). */
export function ringErrorMessage(error: unknown): string | null {
  const e = toAppError(error);
  if (e?.code !== "conflict") return null;
  if (e.detail === "no_pilot_devices") return "Rings are on and this would leave the first group empty.";
  if (e.detail === "device revoked") return "A disconnected PC cannot be put in a ring.";
  return null;
}
