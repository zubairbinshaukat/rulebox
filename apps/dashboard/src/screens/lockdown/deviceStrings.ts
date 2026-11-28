import { MAX_USB_ALLOW_HOURS, type ApplyState, type LayerName } from "../../data/types";

/**
 * The words of the device page's Protection tab (Phase 5 Step 19, UI pass 2026-11): the Lockdown, Physical protection and Allow USB
 * cards. A file of their own so the device page does not load the strings of the group lockdown and findings screens. The layer,
 * mode and check names are the plain words of `docs/plans/ui-pass/lockdown.md` section 8, so the group lockdown page and this page
 * name the same thing the same way (data stays `off | audit | enforce | on`; only the words change).
 */
const n = (count: number, one: string, other: string) => `${count} ${count === 1 ? one : other}`;
export const deviceLockdownStrings = {
  unavailable: "This could not be loaded.",
  // ---- physical protection
  protectionTitle: "Physical protection",
  protectionNone: "This PC has not sent this yet.",
  protectionOk: "This PC is protected against start-up tricks.",
  protectionMissing: "Someone with the PC in hand could get around Rulebox.",
  protectionInfo: "Rulebox reports this but cannot change it. Turn these on in Windows or in the PC's firmware.",
  secureBoot: "Secure Boot",
  secureBootInfo: "Stops the PC from starting a different system from a USB stick.",
  bitLocker: "BitLocker",
  bitLockerInfo: "Locks the PC's drive, so nobody can read it by taking it out.",
  autoRecovery: "Automatic recovery",
  autoRecoveryInfo: "The Windows recovery screen can open a command prompt. Off is safer on a kiosk PC.",
  safeMode: "Rulebox in Safe Mode",
  safeModeInfo: "Rulebox keeps protecting the PC when Windows starts in Safe Mode.",
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
  yes: "Yes",
  no: "No",
  registered: "Registered",
  notRegistered: "Not registered",
  missing: {
    secureBoot: "Secure Boot is not on",
    bitLocker: "BitLocker is not on",
    autoRecovery: "automatic recovery is still on",
    safeMode: "Rulebox is not registered for Safe Mode",
  },
  missingList: (items: string[]) => `Missing: ${items.join(", ")}.`,
  /** The one action line under the verdict: only what an administrator can do (Rulebox never does it). */
  turnOn: (items: string[]) => `Turn on ${items.join(" and ")} on this PC.`,
  never: "Rulebox never turns BitLocker on and never sets firmware passwords. Do that yourself.",
  // ---- lockdown
  lockdownTitle: "Lockdown",
  tooOld: "Rulebox on this PC is too old for lockdown",
  tooOldDetail: "Update Rulebox on this PC to apply the group's lockdown settings.",
  noReport: "This PC has not sent this yet.",
  states: {
    applied: "Applied",
    partial: "Partly applied",
    refused: "Not applied",
    failed: "Failed",
    rolledBack: "Went back",
  } satisfies Record<ApplyState, string>,
  stateTones: { applied: "success", partial: "warning", refused: "danger", failed: "danger", rolledBack: "danger" } satisfies Record<ApplyState, "success" | "warning" | "danger">,
  refusedTitle: "This PC did not apply the lockdown settings",
  rolledBackTitle: "This PC went back to its last working settings",
  rolledBackDetail: "The Staff App did not start with the new ones. It will not try that version again.",
  reducedTitle: "Reduced protection",
  /** The apply report says a check cannot run on this Windows edition (Home). */
  reducedHome: "Windows Home has no employee program list. The Rulebox program check still works.",
  /** The compatibility report names what cannot be used. */
  reducedDetail: (missing: string[]) => `${missing.join(" and ")} cannot be used on this PC. The other protections apply.`,
  layerAppLocker: "The employee program list",
  layerAppControl: "The Windows safety list",
  /** The seven layers, by the plain names of the group lockdown page. */
  layers: {
    staff: "Windows tools for employees",
    machine: "Sign-in screen and PC",
    appLocker: "Employee program list",
    appControl: "Windows safety list",
    procWatch: "Rulebox program check",
    boot: "Start-up protection",
    performance: "Speed",
  } satisfies Record<LayerName, string>,
  /** One (i) per layer. */
  layerInfo: {
    staff: "Hides Windows tools such as Task Manager and the command prompt for employees.",
    machine: "What the sign-in screen and the PC itself allow, such as the power button and USB devices.",
    appLocker: "Employees can start only Windows, Rulebox and the programs you allowed.",
    appControl: "Blocks programs that are known to get around security rules, for everyone on the PC.",
    procWatch: "Rulebox closes any program an employee starts that is not allowed.",
    boot: "Keeps employees out of Safe Mode and the recovery screen, and protects Rulebox's own files.",
    performance: "Turns off animations and background programs so older PCs stay fast.",
  } satisfies Record<LayerName, string>,
  /** How a layer works now: the mode words of the group lockdown page (Off, Trial run, Block). */
  modes: {
    off: "Off",
    audit: "Trial run (only report)",
    enforce: "Block",
    on: "On",
  } as Record<string, string>,
  /** The state of a layer whose first run is a trial (the PC audits for a day before it blocks). */
  auditFirst: "Trial run first",
  layerList: "Protection layers",
  // ---- technical details (support only)
  configVersion: "Settings version",
  lkg: "Last working settings",
  refusalCode: "Reason code",
  layerCode: (layer: string) => `${layer}: code`,
  reported: "Reported",
  version: (v: number) => `Version ${v}`,
  // ---- USB allow
  usbTitle: "Allow USB for this PC",
  usbInfo: "Lifts this group's USB blocks on this PC for a short time, for example for maintenance. Keyboards, mice and touch screens always work.",
  usbHours: "For",
  usbHour: (h: number) => n(h, "hour", "hours"),
  usbAllow: "Allow USB",
  usbEnd: "End now",
  usbOn: (until: string) => `USB devices are allowed until ${until}. It ends by itself.`,
  usbOff: "The group's USB rules apply.",
  usbOpenPill: "Allowed for now",
  usbStarted: (h: number) => `USB devices are allowed for ${n(h, "hour", "hours")}.`,
  usbEnded: "The USB allowance has ended.",
  usbMax: `At most ${MAX_USB_ALLOW_HOURS} hours.`,
};
