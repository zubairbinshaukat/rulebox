import { MAX_USB_ALLOW_HOURS, type ApplyState, type LayerName, type Ring } from "../../data/types";
import { toAppError } from "../../lib/errors";

/**
 * Strings of the device page's Protection, Lockdown and USB cards (Phase 5 Step 19). A file of their own so the device page
 * does not load the strings of the group lockdown and findings screens.
 */
const n = (count: number, one: string, other: string) => `${count} ${count === 1 ? one : other}`;
export const deviceLockdownStrings = {
  unavailable: "This could not be loaded.",
  // ---- protection card
  protectionTitle: "Physical protection",
  protectionNone: "This PC has not reported its protection yet.",
  protectionOk: "This PC is protected against start-up tricks.",
  protectionMissing: "Someone with physical access and boot media can bypass software controls on this PC.",
  secureBoot: "Secure Boot",
  bitLocker: "BitLocker drive encryption",
  autoRecovery: "Automatic Windows recovery",
  safeMode: "Rulebox in Safe Mode",
  tpm: "TPM chip",
  serviceAcl: "Rulebox service protection",
  aclDrift: "Folder protection repairs",
  values: {
    on: "On",
    off: "Off",
    suspended: "Suspended",
    unknown: "Unknown",
    unsupported: "Not supported",
    ready: "Ready",
    present: "Present, not ready",
    absent: "None",
    ok: "In place",
    drift: "Was changed, repaired",
  } as Record<string, string>,
  registered: "Registered",
  notRegistered: "Not registered",
  missing: {
    secureBoot: "Secure Boot is not on",
    bitLocker: "BitLocker is not on",
    autoRecovery: "automatic recovery is still on",
    safeMode: "Rulebox is not registered for Safe Mode",
  },
  missingList: (items: string[]) => `Missing: ${items.join(", ")}.`,
  never: "Rulebox never turns BitLocker on and never sets firmware passwords. Do that yourself.",
  // ---- lockdown card
  lockdownTitle: "Lockdown",
  tooOld: "Agent too old for lockdown",
  tooOldDetail: "This PC runs an agent from before lockdown. Update the agent to apply the lockdown settings.",
  noReport: "This PC has not reported its lockdown yet.",
  states: {
    applied: "Applied",
    partial: "Partly applied",
    refused: "Refused",
    failed: "Failed",
    rolledBack: "Rolled back",
  } satisfies Record<ApplyState, string>,
  stateTones: { applied: "success", partial: "warning", refused: "danger", failed: "danger", rolledBack: "danger" } satisfies Record<ApplyState, "success" | "warning" | "danger">,
  refusedTitle: "This PC refused the lockdown policy",
  rolledBackTitle: "This PC went back to its last working policy",
  rolledBackDetail: "The Staff App did not work with the new policy. The PC will not try that version again.",
  reducedHome: "Reduced protection (Home)",
  reducedHomeDetail: "This Windows edition does not support all program rules. The other protections still apply.",
  layers: {
    staff: "Employee restrictions",
    machine: "PC restrictions",
    appLocker: "AppLocker",
    appControl: "App Control",
    procWatch: "Process watch",
    boot: "Start-up and tamper protection",
    performance: "Performance",
  } satisfies Record<LayerName, string>,
  layerList: "Protection layers",
  configVersion: "Group configuration",
  lkg: "Last working version",
  reported: "Reported",
  version: (v: number) => `Version ${v}`,
  // ---- ring
  ring: "Rollout ring",
  ringHint: "Pilot PCs get every change first.",
  ringSaved: "Ring changed.",
  ringNoGroup: "Put this PC in a group to choose a ring.",
  // ---- USB allow
  usbTitle: "Allow USB for this PC",
  usbLead: "Lifts this group's USB blocks on this PC for a short time, for example for maintenance. It ends by itself.",
  usbAlways: "Keyboards, mice and touch screens always work.",
  usbHours: "For how long",
  usbHour: (h: number) => n(h, "hour", "hours"),
  usbAllow: "Allow USB",
  usbEnd: "End now",
  usbOn: (until: string) => `USB devices are allowed on this PC until ${until}.`,
  usbOff: "The group's USB rules apply.",
  usbStarted: (h: number) => `USB devices are allowed for ${n(h, "hour", "hours")}.`,
  usbEnded: "The USB allowance has ended.",
  usbMax: `At most ${MAX_USB_ALLOW_HOURS} hours.`,
};

/** The ring names (the same words as the rollout screen). */
export const RING_LABELS: Record<Ring, string> = { pilot: "Pilot", early: "Early", everyone: "Everyone" };

/** The refusals of `rollouts:setRings` for one PC, in words (null = the usual sentence). */
export function ringErrorMessage(error: unknown): string | null {
  const e = toAppError(error);
  if (e?.code !== "conflict") return null;
  if (e.detail === "no_pilot_devices") return "Rings are on and this would leave the pilot ring empty.";
  if (e.detail === "device revoked") return "A revoked PC cannot be put in a ring.";
  return null;
}
