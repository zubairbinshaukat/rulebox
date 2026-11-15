import {
  MAX_ALLOW_GROUPS,
  MAX_EXCEPTION_REASON,
  MAX_LOCKOUT_MINUTES,
  MAX_LOCKOUT_THRESHOLD,
  MIN_LOCKOUT_THRESHOLD,
  OPEN_FINDINGS_CAP,
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

/** Strings of the lockdown screens (Phase 5 Step 19, plan 4.20). Plain words, short sentences. */
const n = (count: number, one: string, other: string) => `${count} ${count === 1 ? one : other}`;

/** Said next to every setting that also changes the PC for administrators (plan 4.20 text rule). */
export const EVERYONE = "Applies to everyone on this PC, including administrators.";
const STAFF_ONLY = "Applies to employees only. Administrators are not affected.";

type StaffKey = keyof LockdownSettings["staff"];
type MachineSwitch = Exclude<keyof LockdownSettings["machine"], "accountLockout">;

export const lockdownStrings = {
  title: "Lockdown",
  titleFor: (group: string) => `Lockdown of ${group}`,
  lead: "What employees can and cannot do on the PCs of this group. Changes reach the pilot ring first when rings are on.",
  back: "Back to the group",
  loadingTitle: "Loading",
  readOnly: "Only administrators can change these settings.",
  // ---- findings link
  findingsNone: "No program is waiting for a decision.",
  findingsNew: (count: number, more: boolean) => `Audit findings: ${more ? `${OPEN_FINDINGS_CAP}+` : count} new`,
  findingsDetail: "Programs that the rules would block. Allow the ones your employees need before you enforce.",
  findingsOpen: "Review findings",
  auditLong: (days: number) => `The program rules have been in audit mode for ${n(days, "day", "days")}.`,
  auditLongDetail: "Audit mode only records what would be blocked. Review the findings, then switch to Enforce.",
  // ---- program rules
  rulesTitle: "Program rules",
  rulesLead: "Three checks decide which programs may start. Start in Audit, review the findings, then switch to Enforce.",
  modes: { off: "Off", audit: "Audit", enforce: "Enforce" } satisfies Record<LayerMode, string>,
  modeHelp: {
    off: "Nothing is checked or recorded.",
    audit: "Nothing is blocked. Programs that would be blocked are listed as findings.",
    enforce: "Programs outside the rules are blocked.",
  } satisfies Record<LayerMode, string>,
  appLocker: "Allowed programs for employees (AppLocker)",
  appLockerHelp: `Employees can start only Windows, Rulebox and the programs you assigned. ${STAFF_ONLY}`,
  appControl: "App Control",
  appControlHelp: `Blocks programs that are known to get around security rules. ${EVERYONE}`,
  appControlLevel: "App Control level",
  levels: { recommendedBlocks: "Recommended blocks", allowlist: "Allow list only" } satisfies Record<AppControlLevel, string>,
  levelHelp: {
    recommendedBlocks: "Blocks a list of programs that Microsoft recommends blocking. Everything else is allowed.",
    allowlist: "Only Windows, the Program Files folders and Rulebox may run. This also restricts administrators. Check each PC first.",
  } satisfies Record<AppControlLevel, string>,
  procWatch: "Process watch",
  procWatchHelp: `Rulebox watches what the employee account starts and closes anything that is not allowed. ${STAFF_ONLY}`,
  // ---- employee restrictions
  staffTitle: "Employee restrictions",
  staffLead: `Windows features hidden or turned off for the employee account. ${STAFF_ONLY}`,
  staff: {
    taskManager: ["Turn off Task Manager", "Also removes it from the Ctrl+Alt+Del screen."],
    run: ["Turn off the Run dialog", ""],
    commandPrompt: ["Turn off the command prompt", "Batch files are refused too."],
    registryTools: ["Turn off the registry editor", ""],
    settings: ["Turn off Settings and Control Panel", ""],
    signOut: ["Remove Sign out from Ctrl+Alt+Del", "Employees sign out in the Staff App."],
    changePassword: ["Remove Change password from Ctrl+Alt+Del", ""],
    hideDrives: ["Hide drives in file dialogs", "This only hides them. The program rules decide what can run."],
    accessibilityHotkeys: ["Turn off accessibility shortcut keys", "For example pressing Shift five times."],
    officeMacros: ["Turn off Office macros", "Macros in Word, Excel and PowerPoint do not run."],
  } satisfies Record<StaffKey, [string, string]>,
  // ---- PC restrictions
  machineTitle: "PC restrictions",
  machineLead: `Settings of the whole PC. ${EVERYONE}`,
  machine: {
    hideSwitchUser: ["Hide Switch user", ""],
    hideSignInPower: ["Hide the power button on the sign-in screen", ""],
    denyElevationRequests: ["Never ask employees for an administrator password", "A program that needs administrator rights does not start for an employee."],
    hideAdminTiles: ["Hide administrator accounts on the sign-in screen", "Administrators sign in with Other user. Used only on PCs where that is confirmed to work."],
    noWakePassword: ["Do not ask for a password after sleep", ""],
    restrictPrinterDrivers: ["Only administrators may install printer drivers", ""],
    fileOutputPrinters: ["Hide printers that save to a file", "For example Print to PDF, so employees cannot save documents that way."],
  } satisfies Record<MachineSwitch, [string, string]>,
  lockout: "Lock an account after wrong passwords",
  lockoutHelp: "Off leaves the PC's own setting as it is.",
  lockoutThreshold: "Wrong passwords before the lock",
  lockoutThresholdHint: `A whole number from ${MIN_LOCKOUT_THRESHOLD} to ${MAX_LOCKOUT_THRESHOLD}.`,
  lockoutDuration: "Lock for (minutes)",
  lockoutWindow: "Count wrong passwords within (minutes)",
  lockoutWindowHint: "Not longer than the lock itself.",
  lockoutProblems: {
    threshold: `Use a whole number from ${MIN_LOCKOUT_THRESHOLD} to ${MAX_LOCKOUT_THRESHOLD}.`,
    duration: `Use a whole number from 1 to ${MAX_LOCKOUT_MINUTES}.`,
    window: "Use a whole number from 1 up to the lock time.",
  },
  // ---- USB
  usbTitle: "USB devices",
  usbLead: "Choose which kinds of USB devices may be used. Each kind has its own switch.",
  usbAlways: "Keyboards, mice and touch screens always work.",
  usb: {
    storage: "USB drives and memory cards",
    printers: "USB printers",
    imaging: "Scanners and cameras",
    phones: "Phones",
    other: "Other USB devices",
  } satisfies Record<"storage" | "printers" | "imaging" | "phones" | "other", string>,
  usbHelp: {
    storage: `Also covers memory-card readers inside printers. The Staff App has no other way to hand in files in this version. ${STAFF_ONLY}`,
    printers: `Network printers keep working. ${EVERYONE}`,
    imaging: EVERYONE,
    phones: STAFF_ONLY,
    other: `A fixed list of device kinds, for example serial ports and modems. ${EVERYONE}`,
  } satisfies Record<"storage" | "printers" | "imaging" | "phones" | "other", string>,
  storageModes: { allow: "Allowed", readOnly: "Read only", block: "Blocked" } satisfies Record<UsbStorageMode, string>,
  usbModes: { allow: "Allowed", block: "Blocked" } satisfies Record<UsbSwitch, string>,
  usbOtherWarning: "Blocking other USB devices can stop special equipment from working. Test it on one PC first.",
  usbRetroactive: "Also apply to devices that are already plugged in",
  usbRetroactiveHint: "Without this, a block only affects devices that are plugged in later.",
  // ---- keyboard and accessibility
  inputTitle: "Keyboard and accessibility",
  winCombos: "Block Windows-key shortcuts",
  winCombosHelp: "For example Windows+R and Windows+E. The administrator exit keeps working.",
  accessibilityTools: "Allow the Windows accessibility tools",
  accessibilityToolsHelp: "Narrator, Magnifier and the on-screen keyboard. The Staff App's own accessibility features are always on.",
  // ---- start-up
  bootTitle: "Start-up and recovery",
  autoRecovery: "Turn off automatic Windows recovery",
  autoRecoveryHelp: "Stops the PC from opening the recovery screen after failed starts. Left on by itself on PCs that BitLocker protects.",
  safeModeGuard: "Keep employees out of Safe Mode",
  safeModeGuardHelp: "Rulebox also runs in Safe Mode and does not sign the employee account in there.",
  // ---- performance
  perfTitle: "Performance",
  perfLead: "Makes slow PCs feel faster.",
  staffTuning: "Tune Windows for the employee account",
  staffTuningHelp: "Turns off animations, background apps and start-up programs for employees.",
  kioskProfile: "Use the kiosk performance profile",
  kioskProfileHelp: `Stops Windows services a kiosk PC does not need. ${EVERYONE}`,
  noPrinting: "This group does not print",
  noPrintingHelp: "Stops the print service to save memory. The print service stays on whenever this group has printers.",
  // ---- networks
  netTitle: "Networks",
  wifiManagedOnly: "Managed Wi-Fi networks only",
  wifiManagedOnlyHelp: `The PC can join only the Wi-Fi networks you assigned to this group. Needs at least one. ${EVERYONE}`,
  // ---- exceptions
  exceptionsTitle: "Exceptions",
  exceptionsLead: "Programs you allowed from the findings. They are allowed for employees on the PCs of this group.",
  exceptionsNone: "No exceptions yet. Allow a program from the findings list.",
  exceptionsTruncated: "Showing the newest 50 exceptions.",
  exceptionKinds: { publisher: "Publisher", hash: "This exact file", path: "Folder" } satisfies Record<ExceptionKind, string>,
  exceptionWhat: (r: { kind: ExceptionKind; subject: string | null; fileName: string | null; hashStart: string | null; path: string | null }) =>
    r.kind === "publisher" ? `${r.fileName ?? "Any program"} signed by ${r.subject ?? "the publisher"}` : r.kind === "hash" ? `File ${r.hashStart ?? ""}…` : (r.path ?? ""),
  breaksOnUpdate: "Breaks on update",
  breaksOnUpdateHelp: "This rule matches one exact file. When the program updates, it is blocked again.",
  forApp: (app: string) => `For ${app}`,
  removeException: "Remove",
  removeExceptionTitle: "Remove this exception?",
  removeExceptionBody: "The program is blocked again once the rules are enforced. Its finding goes back to the open list.",
  exceptionRemoved: "Exception removed.",
  // ---- save
  save: "Save settings",
  discard: "Discard changes",
  saved: "Lockdown settings saved.",
  enforceTitle: "Save these settings?",
  enforceIntro: (layers: string[]) => `You are switching ${layers.join(" and ")} to Enforce. Programs outside the rules will be blocked.`,
  enforceFindings: (count: number, more: boolean) =>
    count === 0 ? "No finding is waiting for a decision." : `${more ? `More than ${OPEN_FINDINGS_CAP}` : count} ${count === 1 && !more ? "finding is" : "findings are"} still open. Those programs will be blocked.`,
  enforceAppControl: "App Control applies to everyone on this PC, including administrators.",
  enforceAuditFirst: "A PC that has never run in audit mode audits for 24 hours first.",
  managedConfirm: "Managed networks only: a PC that is on another Wi-Fi network stays as it is and reports a refusal. A PC with no managed network in range goes offline, and then Rulebox cannot reach it.",
  enforceConfirm: "Save and apply",
  // ---- errors
  managedEmpty: "Assign a Wi-Fi network to this group first. Managed networks only needs at least one.",
  badLockout: "Check the account lockout numbers.",
};

export const findingsStrings = {
  title: "Findings",
  lead: "Programs the rules blocked or would block on your PCs. Allow what your employees need. Ignore the rest.",
  back: "Back",
  statuses: { new: "Open", allowed: "Allowed", ignored: "Ignored" } satisfies Record<FindingStatus, string>,
  statusLabel: "Show",
  colProgram: "Program",
  colSigner: "Signed by",
  colWhere: "Found in",
  colLayer: "Rule",
  colDevices: "PCs",
  colSeen: "Last seen",
  colActions: "Actions",
  unsigned: "Not signed",
  folders: {
    windows: "Windows folder",
    programFiles: "Program Files",
    rulebox: "Rulebox folder",
    userProfile: "Employee's own folders",
    userTemp: "Temporary files",
    removable: "USB drive",
    network: "Network share",
    other: "Another folder",
  } as Record<string, string>,
  layers: { appLocker: "AppLocker", appControl: "App Control", procWatch: "Process watch" } satisfies Record<FindingLayer, string>,
  pcs: (count: number) => n(count, "PC", "PCs"),
  allow: "Allow for app…",
  ignore: "Ignore",
  ignoreTitle: (file: string) => `Ignore ${file}?`,
  ignoreBody: "It leaves the open list. Nothing is allowed. You can still allow it later from the Ignored list.",
  ignored: "Finding ignored.",
  emptyTitle: { new: "No open findings", allowed: "Nothing allowed yet", ignored: "Nothing ignored" } satisfies Record<FindingStatus, string>,
  emptyBody: {
    new: "When a program is blocked, or would be blocked in audit mode, it shows up here.",
    allowed: "Programs you allow from the open list show up here.",
    ignored: "Findings you ignore show up here.",
  } satisfies Record<FindingStatus, string>,
  appControlNote: "App Control findings cannot be allowed per program.",
  // ---- allow dialog
  allowTitle: (file: string) => `Allow ${file}`,
  allowLead: "Rulebox adds a rule so employees can start this program. It applies to AppLocker and the process watch.",
  ruleKind: "How to recognise the program",
  kinds: {
    publisher: "By its publisher (recommended)",
    hash: "This exact file",
    path: "By its folder",
  } satisfies Record<ExceptionKind, string>,
  kindHelp: {
    publisher: (signer: string) => `Any version of this program signed by ${signer}. Keeps working after updates.`,
    hash: "Only this one file. Breaks on update: a new version is blocked until you allow it again.",
    path: "Any file with this name in a folder only administrators can change.",
  },
  kindUnavailable: {
    publisher: "Not possible: the program is not signed.",
    hash: "Not possible: the PC did not send the file's fingerprint.",
    path: "Not possible: the program is not in a folder that only administrators can change.",
  } satisfies Record<ExceptionKind, string>,
  folder: "Folder",
  folderHint: "Start with {ProgramFiles}, {ProgramFilesX86} or {RuleboxApps}, for example {ProgramFiles}\\Acme.",
  folderProblem: "Enter a folder under {ProgramFiles}, {ProgramFilesX86} or {RuleboxApps}.",
  groups: "Allow in these groups",
  groupsHint: `Choose up to ${MAX_ALLOW_GROUPS} groups.`,
  groupsProblem: "Choose at least one group.",
  groupsTooMany: `Choose at most ${MAX_ALLOW_GROUPS} groups at a time.`,
  app: "Program it belongs to",
  appNone: "No program",
  appHint: "Optional. Helps you find the exception later.",
  reason: "Note",
  reasonHint: `Optional. Why this is allowed. Up to ${MAX_EXCEPTION_REASON} characters.`,
  reasonProblem: `Use at most ${MAX_EXCEPTION_REASON} characters.`,
  allowConfirm: "Allow",
  allowing: "Allowing…",
  allowed: (added: number) => (added === 0 ? "These groups already had this rule." : `Allowed in ${n(added, "group", "groups")}.`),
  noGroups: "Create a group first.",
  // ---- refusals of `lockdown:allow`
  errors: {
    no_signer: "This program is not signed, so it cannot be allowed by publisher.",
    no_hash: "The PC did not send this file's fingerprint, so it cannot be allowed as an exact file.",
    app_control_finding: "App Control findings cannot be allowed per program.",
    path_not_admin_only: "This program is not in a folder that only administrators can change, so it cannot be allowed by folder.",
    already_allowed: "This finding is allowed already. Remove its exceptions first.",
  } as Record<string, string>,
  tooManyGroups: `Choose at most ${MAX_ALLOW_GROUPS} groups at a time.`,
  tooManyExceptions: "This group has 200 exceptions already. Remove one first.",
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
