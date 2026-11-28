/**
 * Settings → General, Admin exit, Rulebox updates (plan Step 5, UI pass): the sentences of the
 * sections and of the plan panel. A lazily loaded part of `lib/strings.ts`
 * (same rules), so the sign-in page does not download them.
 *
 * "Exit PIN" is the PCs' admin-exit PIN. It is never the member's action PIN
 * (`lib/stepup/strings.ts`) and the two are never accepted for each other.
 */
import type { ExitPinProblem, HotkeyResult } from "../../lib/validate";
import type { LimitKind, PlanName, PlanStatus } from "../../data/types";
import type { GithubReleaseProblem } from "../../data/release/api";
import type { PickWarning } from "./updates/pickRules";
import { formatDate, formatNumber, plural } from "../../lib/format";
import { strings } from "../../lib/strings";

const count = (n: number, one: string, other: string) => `${formatNumber(n)} ${plural(n, { one, other })}`;

/** One noun per plan limit (`plan_limit` detail). */
const NOUNS: Record<LimitKind, [string, string]> = {
  devices: ["device", "devices"],
  employees: ["employee", "employees"],
  apps: ["app", "apps"],
  groups: ["group", "groups"],
  members: ["member", "members"],
  enrollmentCodes: ["active enrollment code", "active enrollment codes"],
};

/** "No limit" is `UNLIMITED` (1e9) on the server; anything at or above it reads as no limit. */
export const UNLIMITED = 1_000_000_000;

/** The presets of the two pickers: the stored value is added as one more option when it is not one of them. */
export const OFFLINE_PRESETS = [0, 1, 3, 7, 14, 30] as const;
export const QUOTA_PRESETS = [0, 1, 2, 5, 10, 20, 50, 100] as const;

export const org = {
  orgCard: "Your organization",
  name: "Organization name",
  nameInfo: "Shown on the sign-in screen of every PC.",
  pcsCard: "Employees on the PCs",
  offlineDays: "Offline sign-in",
  offlineInfo: "How long employees can still sign in on a PC without internet. Off: they need the internet to sign in.",
  /** `0` is "Off", 1 is "1 day", anything else "N days". */
  days: (n: number) => (n === 0 ? "Off" : n === 1 ? "1 day" : `${formatNumber(n)} days`),
  defaultQuota: "Storage per employee",
  quotaInfo: "Space for each employee's files. You can change it for one employee on their page.",
  /** `0` is unlimited on the server. */
  gb: (n: number) => (n === 0 ? "Unlimited" : `${formatNumber(n)} GB`),
  power: "Power buttons",
  powerInfo: "The power buttons employees see on the PCs.",
  sleep: "Sleep",
  restart: "Restart",
  shutDown: "Shut down",
  saved: "Settings saved.",
  noChange: "Nothing changed.",
};

export const exit = {
  card: "Open admin exit",
  enabled: "Allow admin exit on PCs",
  enabledInfo: "An administrator can leave the kiosk on a PC: press the key combination, then type the exit PIN. Employees don't see it.",
  hotkey: "Key combination",
  hotkeyInfo: "Ctrl or Alt, optional Shift, plus one letter, digit or F1-F12.",
  hotkeyHint: "Ctrl or Alt (Shift optional) plus one letter, digit or F1–F12. For example Ctrl+Shift+F12.",
  hotkeyCanonical: (canonical: string) => `Saved as ${canonical}.`,
  hotkeyNow: (keys: string) => `Current key combination: ${keys}`,
  change: "Change",
  recording: "Press the keys now",
  recordingHint: "Esc to cancel",
  recordingLabel: "Press the key combination",
  recordingStop: "Cancel",
  useDefault: (keys: string) => `Use ${keys}`,
  typeInstead: "Type it instead",
  typeInsteadHint: "For a combination the browser keeps for itself, such as Alt+F4 or Ctrl+W.",
  pin: "Exit PIN",
  pinSetOn: (ms: number) => `PIN set on ${formatDate(ms)}. It is never shown again.`,
  pinSet: "A PIN is set. It is never shown again.",
  pinIsSet: "PIN set",
  pinNotSet: "No PIN yet. Admin exit doesn't work until a PIN is set.",
  setPin: "Set PIN",
  changePin: "Change PIN",
  clearPin: "Clear PIN",
  pinTitle: "Set the exit PIN",
  pinInfo: "6 to 12 digits, no simple runs. It is not your own dashboard PIN.",
  newPin: "New exit PIN",
  repeatPin: "Repeat the exit PIN",
  pinSaved: "Exit PIN saved. PCs get it at their next update.",
  clearTitle: "Clear the exit PIN?",
  clearBody: "Admin exit stops working on every PC until a new PIN is set.",
  cleared: "Exit PIN cleared.",
  saved: "Admin exit saved.",
  howTitle: "How it works",
  how: [
    { title: "Press the keys on the PC", body: "Anywhere on the kiosk." },
    { title: "Type the exit PIN", body: "Only an administrator knows it." },
    { title: "The kiosk closes for you", body: "The PC goes back to Windows." },
  ],
};
/** The grammar rule a key combination broke (the Rust `HotkeyError`), as a sentence. */
export function hotkeyMessage(r: Extract<HotkeyResult, { ok: false }>): string {
  const why = ((): string => {
    switch (r.reason) {
      case "Empty":
        return "it is empty";
      case "UnknownToken": {
        const t = r.token ?? "";
        if (t === "") return "there is an empty part between two +";
        if (/^(win|windows|meta|super)$/i.test(t)) return "Windows key combinations are reserved";
        return `“${t}” is not a key Rulebox knows (use A–Z, 0–9 or F1–F12)`;
      }
      case "NoKey":
        return "add a letter, digit or F1–F12";
      case "TwoKeys":
        return "use only one key besides Ctrl, Alt and Shift";
      case "DuplicateModifier":
        return "a modifier appears twice";
      case "NeedsCtrlOrAlt":
        return "add Ctrl or Alt";
    }
  })();
  return `This key combination can't be used: ${why}.`;
}

/** The server's `invalid_argument` detail for the exit PIN. */
export function exitPinMessage(problem: ExitPinProblem | string | undefined): string {
  return problem === "6 to 12 digits" || problem === undefined ? strings.validate.pin : strings.validate.pinWeak;
}

/** Settings → Rulebox updates (Phase 6 Step 20, UI pass): the Rulebox build the PCs update to, picked from the GitHub releases. */
export const updates = {
  currentTitle: "Your PCs update to",
  noneTitle: "No update chosen",
  noneBody: "PCs keep the version they have.",
  rulebox: (version: string) => `Rulebox ${version}`,
  current: "Current",
  technical: "Technical details",
  version: "Version",
  url: "Installer address",
  sha256: "SHA-256",
  size: "Size",
  sizeBytes: (bytes: number) => `${formatNumber(bytes)} bytes`,
  stop: "Stop updating",
  stopTitle: "Stop updating Rulebox?",
  stopBody: "PCs keep the version they have and no longer look for a newer one, until you set a release again.",
  cleared: "Release cleared. PCs no longer update Rulebox.",
  noChange: "Nothing changed.",
  ownerOnly: "Only an Owner can choose the update.",
  changedCurrent: "This release's installer was replaced on GitHub. Choose it again so your PCs get the new copy.",

  releasesTitle: "Releases",
  checked: "Checked",
  refresh: "Refresh",
  refreshing: "Checking…",
  newest: "Newest",
  testBuild: "Test build",
  testBuildInfo: "A pre-release for trying out first.",
  unsigned: "Not code-signed",
  unsignedInfo: "Windows may warn when someone opens this installer by hand. Your PCs install it without asking.",
  showNotes: "Show notes",
  hideNotes: "Hide notes",
  notesTruncated: "The notes are shortened. Read the rest on GitHub.",
  viewOnGithub: "View on GitHub",
  listLabel: "Rulebox releases",
  loadError: "Couldn't load the releases from GitHub.",
  busy: (time: string) => `GitHub is busy. Try again after ${time}.`,
  busyLater: "GitHub is busy. Try again in a few minutes.",
  busyInfo: "If this keeps happening, the person who runs your Rulebox server can add a GitHub token.",
  busyInfoLabel: "About GitHub being busy",
  stale: "Showing the list from",
  emptyTitle: "No releases yet",
  emptyBody: "New Rulebox versions appear here when they are published. To use your own build, open Advanced.",
  allUnusable: "None of these can be used. Use Advanced for your own build.",
  onNewest: "Your PCs are set to the newest release.",
  choose: "Choose a release to update your PCs.",
  selectedTitle: "Selected",
  ownBuild: "Your own build",
  mainAction: (version: string) => `Update PCs to ${version}`,
  saving: "Saving…",
  confirmTitle: (version: string) => `Update every PC to Rulebox ${version}?`,
  confirmBody: "Each PC downloads it, checks it and installs it when nobody is signed in. PCs never go back to an older version.",
  confirmButton: "Update PCs",
  saved: (version: string) => `Saved. PCs install Rulebox ${version} when nobody is signed in.`,
  unusable: {
    no_msi: "Can't be used: the release has no installer.",
    two_msis: "Can't be used: the release has two installers.",
    version_mismatch: "Can't be used: its version doesn't match.",
    no_checksums: "Can't be used: it has no checksum file.",
    checksums_unreadable: "Can't be used: its checksum file can't be read.",
    not_in_checksums: "Can't be used: the installer isn't in its checksum file.",
    hash_mismatch: "Can't be used: the checksum doesn't match.",
    too_large: "Can't be used: it is too large.",
    invalid: "Can't be used: it isn't a valid release.",
  } satisfies Record<GithubReleaseProblem, string>,
  warnings: {
    older: "This is older than the version you chose before. PCs that already have a newer one keep it.",
    sameVersionOtherBuild: "PCs that already run this version keep their copy.",
    changed: "This release's installer was replaced on GitHub. Choose it again so your PCs get the new copy.",
    prerelease: "This is a test build. It goes to every PC.",
  } satisfies Record<Exclude<PickWarning, "unsigned">, string>,

  advanced: "Advanced: use your own build",
  advancedLead: "Use this for an installer you built yourself. Picking a release above fills these in for you.",
  versionLabel: "Version",
  versionInfo: "For example 0.3.1. PCs only move to a higher version.",
  urlLabel: "Installer address",
  urlInfo: "A direct https:// link to the .msi file, without a user name or password.",
  shaLabel: "SHA-256",
  shaInfo: "The file's checksum, 64 characters. PCs refuse a file that doesn't match.",
  sizeLabel: "Size in bytes",
  sizeInfo: "The exact file size, up to 1 GB.",
  problems: {
    versionEmpty: "Enter the version.",
    versionLength: "A version has at most 40 characters.",
    versionNotOrdered: "Use up to four dotted numbers, then an optional -pre-release (0.1.2 or 1.0.0-rc.1).",
    urlEmpty: "Enter the installer address.",
    urlLength: "The address is too long (2,048 characters at most).",
    urlHttps: "Use an https:// address without a user name or password.",
    shaEmpty: "Enter the SHA-256.",
    shaFormat: "A SHA-256 is 64 hexadecimal digits (0–9, a–f).",
    sizeEmpty: "Enter the size in bytes.",
    sizeNumber: "Enter a whole number of bytes.",
    sizeRange: "The size must be from 1 byte to 1 GB.",
    serverRefused: "The server did not accept this value.",
  },
};

export const plan = {
  title: "Plan and usage",
  names: { free: "Free", team: "Team", custom: "Self-hosted" } satisfies Record<PlanName, string>,
  status: { active: "Active", suspended: "Suspended", pendingDeletion: "Being deleted" } satisfies Record<PlanStatus, string>,
  /** "Free plan: 1 of 2 devices, 3 of 3 groups." */
  headline: (name: PlanName, parts: string[]) => `${plan.names[name]} plan${parts.length ? `: ${parts.join(", ")}` : ""}.`,
  of: (kind: LimitKind, used: number, limit: number) =>
    limit >= UNLIMITED ? count(used, ...NOUNS[kind]) : `${formatNumber(used)} of ${count(limit, ...NOUNS[kind])}`,
  /** The value of a usage row: the label already names the thing (PCs), so only the numbers. */
  rowValue: (used: number, limit: number) => (limit >= UNLIMITED ? formatNumber(used) : `${formatNumber(used)} of ${formatNumber(limit)}`),
  noLimit: "No limit",
  info: "How much of your plan you use. Contact us to change the plan.",
  infoLabel: "About usage",
  reached: "Limit reached",
  contact: "Contact us to upgrade.",
  suspended: "This organization is suspended. Nothing new can be added. Contact us.",
  kinds: {
    devices: "PCs",
    employees: "Employees",
    apps: "Apps",
    groups: "Groups",
    members: "Dashboard members",
    enrollmentCodes: "Active enrollment codes",
  } satisfies Record<LimitKind, string>,
  auditDays: (days: number) => `Audit log kept for ${count(days, "day", "days")}.`,
};

/**
 * The `plan_limit` error as a sentence: which limit, how many the plan
 * allows when known, and "Contact us to upgrade." (no upgrade button).
 */
export function planLimitMessage(detail: string | undefined, name?: PlanName, limit?: number): string {
  if (detail === "suspended") return plan.suspended;
  const nouns = detail && detail in NOUNS ? NOUNS[detail as LimitKind] : null;
  if (!nouns) return strings.errors.planLimit;
  const head = name !== undefined && limit !== undefined && limit < UNLIMITED
    ? `Your ${plan.names[name]} plan allows ${count(limit, nouns[0], nouns[1])}, and all are in use.`
    : `Your plan's limit of ${nouns[1]} is reached.`;
  return `${head} ${plan.contact}`;
}
