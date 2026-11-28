import {
  MAX_ALLOW_GROUPS,
  MAX_EXCEPTION_REASON,
  MAX_LOCKOUT_MINUTES,
  MAX_LOCKOUT_THRESHOLD,
  MIN_LOCKOUT_THRESHOLD,
  type AppControlLevel,
  type ExceptionKind,
  type FindingLayer,
  type FindingStatus,
  type LayerMode,
  type LockdownSettings,
  type UsbStorageMode,
  type UsbSwitch,
} from "../../data/types";
import { toAppError } from "../../lib/errors";
import type { PresetId } from "./presets";

/**
 * Strings of the lockdown screens (UI pass, `docs/plans/ui-pass/lockdown.md` section 8). Plain words, short sentences.
 *
 * Mode words (UI only; the data stays `off | audit | enforce`): Off, Trial run (only report), Block.
 * Check names: appLocker = Employee program list, appControl = Windows safety list, procWatch = Rulebox program check.
 * The Windows feature names (AppLocker, App Control) appear only in `appLockerHelp` and `appControlHelp`, the (i) texts of those two
 * checks (`strings.test.ts` pins this). A key ending in `Help`, `Info` or `Hint`, and the second item of a `[label, info]` pair, is
 * an (i) text: at most three short sentences.
 */
const n = (count: number, one: string, other: string) => `${count} ${count === 1 ? one : other}`;
const plus = (more: boolean) => (more ? "+" : "");

/** Said once at the top of "Everyone" sections and in the (i) texts of settings that also change the PC for administrators. */
export const EVERYONE = "Everyone, including administrators.";
const EVERYONE_SHORT = "Everyone, incl. administrators.";
const STAFF_ONLY = "Employees only.";

type StaffKey = keyof LockdownSettings["staff"];
type MachineSwitch = Exclude<keyof LockdownSettings["machine"], "accountLockout">;
type PresetText = { name: string; lead: string; points: string[]; badge?: string };

export const lockdownStrings = {
  title: "Lockdown",
  titleFor: (group: string) => `Lockdown · ${group}`,
  lead: "What employees can and cannot do on this group's PCs.",
  back: "Back to the group",
  loadingTitle: "Loading",
  readOnly: "Only administrators can change these settings.",

  // ---- Your PCs (`lockdown:groupSync`)
  syncTitle: "Your PCs",
  upToDate: (upToDate: number, total: number, more: boolean) => `PCs up to date: ${upToDate} of ${total}${plus(more)}`,
  allUpToDate: (total: number) => (total === 1 ? "This PC is up to date." : `All ${total} PCs are up to date.`),
  sending: (upToDate: number, total: number) => (total === 1 ? `Sending: ${upToDate} of 1 PC has it` : `Sending: ${upToDate} of ${total} PCs have it`),
  waiting: (count: number) => `${count} waiting`,
  syncDetails: "Details",
  syncHide: "Hide details",
  syncBar: "PCs up to date",
  waitingInfo: "A PC gets the change the next time it is online. Rulebox never restarts a PC on its own.",
  problems: (count: number) => `${count} could not apply it:`,
  problemsInfo: "Open the PC to see why. Nothing was changed on it.",
  noPcs: "No PCs in this group yet.",
  noPcsAction: "Add a PC",
  notSent: "Not sent yet. Your PCs get these settings when you save.",
  ringsOn: "Rollout rings are on. Your first PCs get changes before the rest.",
  ringsHalted: "The rollout is paused. Other PCs wait until you resume it.",
  ringsAction: "Open rollout",
  reduced: (count: number) =>
    `${count === 1 ? "1 PC runs" : `${count} PCs run`} Windows Home: the employee program list does not work there. The Rulebox program check still does.`,
  adminTilesPending: (count: number) =>
    `Admin accounts stay visible on ${n(count, "PC", "PCs")} until Other user sign-in is confirmed there.`,

  // ---- Protection level (presets are derived on the client; nothing is stored)
  levelTitle: "Protection level",
  levelInfo: "Sets many Windows restrictions at once. Fine-tune them in Advanced settings.",
  presets: {
    basic: {
      name: "Basic",
      lead: "Hides the risky Windows tools. Everything else stays open.",
      points: ["USB drives allowed", "Settings app available", "Accessibility tools allowed"],
    },
    standard: {
      name: "Standard",
      badge: "Recommended",
      lead: "The usual kiosk lockdown. Good for most shops.",
      points: ["Windows tools hidden", "USB drives allowed", "Accounts lock after 10 wrong passwords"],
    },
    strict: {
      name: "Strict",
      lead: "For public or shared PCs. Also blocks USB drives and phones.",
      points: ["USB drives and phones blocked", "Accounts lock after 5 wrong passwords", "Also applies to devices already plugged in"],
    },
  } satisfies Record<PresetId, PresetText>,
  custom: (name: string, changes: number) => `Custom: ${name} with ${n(changes, "change", "changes")}`,
  customReset: (name: string) => `Reset to ${name}`,
  customShow: "Show changes",
  changed: "Changed",
  changedCount: (count: number) => `${count} changed`,

  // ---- Program blocking (one control for the three program checks)
  modeTitle: "Program blocking",
  modeInfo: "Decides which programs may start for employees. Start with a trial run, review the programs it finds, then block.",
  modes: { off: "Off", audit: "Trial run", enforce: "Block" } satisfies Record<LayerMode, string>,
  modeSub: { off: "Nothing is checked.", audit: "Only report", enforce: "Not allowed = does not start" } satisfies Record<LayerMode, string>,
  modeHelp: {
    off: "Programs are not checked or reported.",
    audit: "Nothing is blocked. Programs that would be blocked are listed for you to review.",
    enforce: "Only Windows, Rulebox, the apps you assigned and the programs you allowed can start.",
  } satisfies Record<LayerMode, string>,
  mixed: "Mixed: set per check in Advanced settings.",
  trialDays: (days: number) => `Trial run for ${n(days, "day", "days")}.`,
  trialLong: (days: number) => `Trial run for ${days} days. Review the programs, then switch to Block.`,

  // ---- Programs to review (card with a link to the list)
  reviewTitle: "Programs to review",
  reviewCount: (count: number, more: boolean) => `${count}${plus(more)}`,
  reviewLead: "Allow what employees need before you block.",
  reviewNone: "Nothing to review.",
  reviewOpen: "Review programs",

  // ---- Advanced settings
  advanced: "Advanced settings",
  tags: { staff: "Employees only", everyone: "Everyone, incl. administrators" },
  checksTitle: "Program checks",
  staffTitle: "Windows tools for employees",
  machineTitle: "Sign-in screen and PC",
  lockoutTitle: "Wrong passwords",
  usbTitle: "USB devices",
  inputTitle: "Keyboard and accessibility",
  bootTitle: "Start-up and recovery",
  perfTitle: "Speed",
  netTitle: "Wi-Fi",

  // program checks
  appLocker: "Employee program list",
  appLockerHelp:
    "Employees can start only Windows, Rulebox and the programs you assigned or allowed. Administrators are not affected. Uses Windows AppLocker (not on Windows Home).",
  appControl: "Windows safety list",
  appControlHelp:
    "Blocks programs that are known to get around security rules, for everyone on the PC, including administrators. Uses Windows App Control.",
  appControlLevel: "Safety list strength",
  levels: { recommendedBlocks: "Recommended list", allowlist: "Strict list" } satisfies Record<AppControlLevel, string>,
  levelHelp: {
    recommendedBlocks: "Blocks the programs Microsoft recommends blocking.",
    allowlist: "Only Windows and installed programs may run, also for administrators. Try it on one PC first.",
  } satisfies Record<AppControlLevel, string>,
  procWatch: "Rulebox program check",
  procWatchHelp:
    "Rulebox closes any program an employee starts that is not allowed. Works on every Windows edition. Administrators are not affected.",

  // Windows tools for employees: [label, (i) text]
  staff: {
    taskManager: ["Hide Task Manager", "Also removes it from the Ctrl+Alt+Del screen."],
    run: ["Hide the Run box", ""],
    commandPrompt: ["Block the command prompt", "Batch files are refused too."],
    registryTools: ["Block the registry editor", ""],
    settings: ["Hide Settings and Control Panel", ""],
    signOut: ["Remove Sign out from Ctrl+Alt+Del", "Employees sign out in the Staff App."],
    changePassword: ["Remove Change password from Ctrl+Alt+Del", ""],
    hideDrives: ["Hide drives in Open and Save windows", "This only hides them. Program blocking decides what can run."],
    accessibilityHotkeys: ["Turn off accessibility shortcut keys", "For example pressing Shift five times."],
    officeMacros: ["Turn off Office macros", "Macros in Word, Excel and PowerPoint do not run."],
  } satisfies Record<StaffKey, [string, string]>,

  // Sign-in screen and PC: [label, (i) text]
  machine: {
    hideSwitchUser: ["Hide Switch user", ""],
    hideSignInPower: ["Hide the power button on the sign-in screen", ""],
    hideAdminTiles: ["Hide administrator accounts", "Administrators sign in with Other user. Used only on PCs where that is confirmed to work."],
    noWakePassword: ["No password after sleep", ""],
    denyElevationRequests: ["Never ask employees for an admin password", "A program that needs administrator rights does not start for an employee."],
    restrictPrinterDrivers: ["Only administrators install printer drivers", ""],
    fileOutputPrinters: ["Hide Print to PDF and other print-to-file printers", "So employees cannot save documents that way."],
  } satisfies Record<MachineSwitch, [string, string]>,

  // wrong passwords
  lockout: "Lock an account after wrong passwords",
  lockoutHelp: "Off leaves the PC's own setting as it is. Applies to every account on the PC.",
  lockoutThreshold: "Wrong passwords allowed",
  lockoutThresholdHint: `A whole number from ${MIN_LOCKOUT_THRESHOLD} to ${MAX_LOCKOUT_THRESHOLD}.`,
  lockoutDuration: "Lock for (minutes)",
  lockoutWindow: "Count within (minutes)",
  lockoutWindowHint: "Wrong passwords are counted for this long. Not longer than the lock.",
  lockoutProblems: {
    threshold: `Use a whole number from ${MIN_LOCKOUT_THRESHOLD} to ${MAX_LOCKOUT_THRESHOLD}.`,
    duration: `Use a whole number from 1 to ${MAX_LOCKOUT_MINUTES}.`,
    window: "Use a whole number from 1 up to the lock time.",
  },

  // USB
  usbAlways: "Keyboards, mice and touch screens always work.",
  usb: {
    storage: "USB drives and memory cards",
    printers: "USB printers",
    imaging: "Scanners and cameras",
    phones: "Phones",
    other: "Other USB devices",
  } satisfies Record<"storage" | "printers" | "imaging" | "phones" | "other", string>,
  usbHelp: {
    storage: `Also covers card readers inside printers. Employees have no other way to hand in files yet. ${STAFF_ONLY}`,
    printers: `Network printers keep working. ${EVERYONE_SHORT}`,
    imaging: EVERYONE_SHORT,
    phones: STAFF_ONLY,
    other: `A fixed list of device kinds, for example serial ports and modems. ${EVERYONE_SHORT}`,
  } satisfies Record<"storage" | "printers" | "imaging" | "phones" | "other", string>,
  storageModes: { allow: "Allowed", readOnly: "Read only (open, not save)", block: "Blocked" } satisfies Record<UsbStorageMode, string>,
  usbModes: { allow: "Allowed", block: "Blocked" } satisfies Record<UsbSwitch, string>,
  usbOtherWarning: "Blocking other USB devices can stop special equipment from working. Test it on one PC first.",
  usbRetroactive: "Also apply to devices already plugged in",
  usbRetroactiveHint: "Without this, a block only affects devices plugged in later.",

  // keyboard and accessibility
  winCombos: "Block Windows-key shortcuts",
  winCombosHelp: "For example Windows+R and Windows+E. The admin exit keeps working.",
  accessibilityTools: "Allow Narrator, Magnifier and the on-screen keyboard",
  accessibilityToolsHelp: "The Staff App's own accessibility features are always on.",

  // start-up and recovery
  autoRecovery: "Hide the Windows recovery screen",
  autoRecoveryHelp: "Stops the PC from opening recovery after failed starts. Left on by itself on PCs that BitLocker protects.",
  safeModeGuard: "Keep employees out of Safe Mode",
  safeModeGuardHelp: "Rulebox also runs in Safe Mode and does not sign the employee account in there.",

  // speed
  staffTuning: "Make Windows lighter for employees",
  staffTuningHelp: "Turns off animations, background apps and start-up programs.",
  kioskProfile: "Turn off unneeded Windows services",
  kioskProfileHelp: EVERYONE_SHORT,
  noPrinting: "This group does not print",
  noPrintingHelp: "Stops the print service to save memory. It stays on whenever this group has printers.",

  // Wi-Fi
  wifiManagedOnly: "Only this group's Wi-Fi networks",
  wifiManagedOnlyHelp: "PCs can join only the Wi-Fi networks you added for this group. Needs at least one.",
  wifiManagedOnlyConfirm: "Apply even if a PC goes offline",
  wifiManagedOnlyConfirmHint: "A PC on another network goes offline until it sees one of this group's networks.",

  // ---- Extra allowed programs (the programs allowed from the review list)
  exceptionsTitle: "Extra allowed programs",
  exceptionsInfo: "Programs you allowed from the review list. The apps you assigned to this group are always allowed.",
  exceptionsNone: "None yet.",
  exceptionsTruncated: "Showing the newest 50.",
  exceptionKinds: { publisher: "By publisher", hash: "This exact version", path: "By folder" } satisfies Record<ExceptionKind, string>,
  /** The row text: what was allowed, in plain words (no fingerprint; `exceptionTitle` has the technical value for the hover text). */
  exceptionWhat: (r: { kind: ExceptionKind; subject: string | null; fileName: string | null; hashStart: string | null; path: string | null }) => {
    if (r.kind === "publisher") return `${r.fileName ?? "Any program"} from ${r.subject ?? "the publisher"}`;
    if (r.kind === "hash") return `${r.fileName ?? "A program"} (this exact version)`;
    const parts = (r.path ?? "").split("\\").filter((p) => p !== "");
    return parts.slice(-2).join("\\");
  },
  /** The hover text of a row: the exact value (the start of the fingerprint, or the whole folder). */
  exceptionTitle: (r: { kind: ExceptionKind; hashStart: string | null; path: string | null }) =>
    r.kind === "hash" ? `Fingerprint ${r.hashStart ?? ""}…` : r.kind === "path" ? (r.path ?? "") : "",
  breaksOnUpdate: "Allow again after updates",
  breaksOnUpdateHelp: "This matches one exact version. After an update the program is blocked until you allow it again.",
  forApp: (app: string) => `For ${app}`,
  removeException: "Remove",
  removeExceptionTitle: (file: string) => `Remove ${file}?`,
  removeExceptionBody: "It is blocked again once the group blocks programs. It goes back to the review list.",
  exceptionRemoved: "Removed.",

  // ---- Save bar and confirmations
  save: "Save",
  discard: "Undo changes",
  unsaved: (count: number) => n(count, "unsaved change", "unsaved changes"),
  saveBarLabel: "Unsaved changes",
  changesInfoLabel: "What changed",
  changesInfoMore: (count: number) => `and ${count} more`,
  saved: "Saved. Your PCs get this within a minute.",
  savedRings: "Saved. Your first PCs get this within a minute.",
  enforceTitle: "Start blocking programs?",
  enforceIntro: "From now on, programs that are not allowed do not start on this group's PCs.",
  enforceFindings: (count: number, more: boolean) =>
    count === 0 ? "Nothing is waiting for review." : `${count}${plus(more)} ${count === 1 && !more ? "program is" : "programs are"} still waiting for review. They will be blocked.`,
  enforceAppControl: "The Windows safety list also applies to administrators.",
  enforceAuditFirst: "A PC that never had a trial run does one for 24 hours first.",
  enforceReview: "Review programs first",
  managedConfirm:
    "Only this group's Wi-Fi: a PC on another network keeps it and reports a problem. A PC with none of these networks in range goes offline, and then Rulebox cannot reach it.",
  enforceConfirm: "Save and apply",

  // ---- errors
  managedEmpty: "Add a Wi-Fi network to this group first.",
  badLockout: "Check the wrong-password numbers.",
};

export const findingsStrings = {
  title: "Programs to review",
  lead: "Programs your PCs stopped, or would stop in a trial run. Allow what employees need.",
  back: "Back",
  statuses: { new: "To review", allowed: "Allowed", ignored: "Ignored" } satisfies Record<FindingStatus, string>,
  statusLabel: "Show",
  colProgram: "Program",
  colWhere: "Found in",
  colDevices: "PCs",
  colSeen: "Last seen",
  colActions: "Actions",
  unsigned: "Unknown publisher",
  unsignedInfo: "The program is not signed, so it can only be allowed as this exact version.",
  folders: {
    windows: "Windows folder",
    programFiles: "Program Files",
    rulebox: "Rulebox folder",
    userProfile: "Employee's own folders",
    userTemp: "Temporary files",
    removable: "USB drive",
    network: "Network folder",
    other: "Another folder",
  } as Record<string, string>,
  layers: { appLocker: "Employee program list", appControl: "Windows safety list", procWatch: "Rulebox program check" } satisfies Record<FindingLayer, string>,
  pcs: (count: number) => n(count, "PC", "PCs"),
  allow: "Allow",
  ignore: "Ignore",
  ignoreTitle: (file: string) => `Ignore ${file}?`,
  ignoreBody: "It leaves the review list. Nothing is allowed. You can still allow it from Ignored.",
  ignored: "Ignored.",
  emptyTitle: { new: "Nothing to review", allowed: "Nothing allowed yet", ignored: "Nothing ignored" } satisfies Record<FindingStatus, string>,
  emptyBody: {
    new: "When a PC stops a program, or would in a trial run, it shows up here.",
    allowed: "Programs you allow from the review list show up here.",
    ignored: "Programs you ignore show up here.",
  } satisfies Record<FindingStatus, string>,
  appControlNote: "Can't be allowed",
  appControlInfo: "Windows blocks this one for everyone because it can get around security rules. It cannot be allowed one by one.",
  howTitle: "How to review",
  howSteps: ["Allow what your employees need.", "Ignore the rest.", "Switch the group to Block."],
  backToLockdown: "Back to lockdown settings",
  tabsLabel: "Programs by status",

  // ---- allow dialog
  allowTitle: (file: string) => `Allow ${file}`,
  allowLead: "Employees in the chosen groups can start this program.",
  recognisedBy: {
    publisher: (signer: string) => `Recognised by its publisher, ${signer}. Keeps working after updates.`,
    hash: "Recognised as this exact version. After an update, allow it again.",
    path: "Recognised by its folder.",
  },
  ruleKind: "How to recognise it",
  kinds: {
    publisher: "By publisher (recommended)",
    hash: "This exact version",
    path: "By folder",
  } satisfies Record<ExceptionKind, string>,
  kindUnavailable: {
    publisher: "Not signed",
    hash: "The PC did not send its fingerprint",
    path: "Not in a protected folder",
  } satisfies Record<ExceptionKind, string>,
  folder: "Folder",
  folderHint: "Start with {ProgramFiles}, {ProgramFilesX86} or {RuleboxApps}, for example {ProgramFiles}\\Acme.",
  folderProblem: "Enter a folder under {ProgramFiles}, {ProgramFilesX86} or {RuleboxApps}.",
  advanced: "Advanced",
  groups: "Allow in",
  groupsOne: (group: string) => `Allowed in ${group}`,
  groupsFilter: "Find a group",
  groupsHint: `Up to ${MAX_ALLOW_GROUPS} groups.`,
  groupsProblem: "Choose at least one group.",
  groupsTooMany: `Choose at most ${MAX_ALLOW_GROUPS} groups at a time.`,
  app: "Belongs to app",
  appNone: "No app",
  appSearch: "Find an app",
  appEmpty: "No app found.",
  reason: "Note",
  reasonProblem: `Use at most ${MAX_EXCEPTION_REASON} characters.`,
  allowConfirm: "Allow",
  allowing: "Allowing…",
  allowed: (added: number) => (added === 0 ? "These groups already had this rule." : `Allowed in ${n(added, "group", "groups")}.`),
  noGroups: "Create a group first.",
  // ---- refusals of `lockdown:allow`
  errors: {
    no_signer: "This program is not signed, so it cannot be allowed by publisher.",
    no_hash: "The PC did not send this program's fingerprint, so it cannot be allowed as an exact version.",
    app_control_finding: "Windows safety list programs cannot be allowed one by one.",
    path_not_admin_only: "This program is not in a folder that only administrators can change, so it cannot be allowed by folder.",
    already_allowed: "This program is allowed already. Remove its extra allowed programs first.",
  } as Record<string, string>,
  tooManyGroups: `Choose at most ${MAX_ALLOW_GROUPS} groups at a time.`,
  tooManyExceptions: "This group has 200 extra allowed programs already. Remove one first.",
};

/** The sentence for the refusals of the lockdown functions that need their own words (null = the usual sentence). */
export function lockdownErrorMessage(error: unknown): string | null {
  const e = toAppError(error);
  if (!e) return null;
  if (e.code === "conflict") {
    if (e.detail === "managed_networks_empty") return lockdownStrings.managedEmpty;
    return (e.detail !== undefined ? findingsStrings.errors[e.detail] : undefined) ?? null;
  }
  if (e.code === "too_large") {
    if (e.detail === "groups") return findingsStrings.tooManyGroups;
    if (e.detail === "exceptions") return findingsStrings.tooManyExceptions;
  }
  if (e.code === "invalid_argument") {
    if (e.field?.startsWith("accountLockout")) return lockdownStrings.badLockout;
    if (e.field === "folder") return findingsStrings.folderProblem;
    if (e.field === "groupIds") return findingsStrings.groupsProblem;
    if (e.field === "reason") return findingsStrings.reasonProblem;
  }
  return null;
}