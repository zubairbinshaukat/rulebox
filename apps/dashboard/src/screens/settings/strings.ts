/**
 * Settings → Organization and Admin exit (plan Step 5): the sentences of the
 * two tabs and of the plan panel. A lazily loaded part of `lib/strings.ts`
 * (same rules), so the sign-in page does not download them.
 *
 * "Exit PIN" is the PCs' admin-exit PIN. It is never the member's action PIN
 * (`lib/stepup/strings.ts`) and the two are never accepted for each other.
 */
import type { ExitPinProblem, HotkeyResult } from "../../lib/validate";
import type { LimitKind, PlanName, PlanStatus } from "../../data/types";
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

export const org = {
  name: "Organization name",
  nameHint: "Shown on the PCs' sign-in screen.",
  offlineDays: "Offline sign-in",
  offlineDaysHint: "How many days employees can sign in while a PC has no internet. 0 turns offline sign-in off.",
  days: "days",
  defaultQuota: "Default storage quota (GB)",
  defaultQuotaHint: "Per employee. 0 = unlimited.",
  power: "Power options for employees",
  powerHint: "Which power buttons employees see on the PCs.",
  sleep: "Sleep",
  restart: "Restart",
  shutDown: "Shut down",
  saved: "Settings saved.",
  noChange: "Nothing changed.",
};

export const exit = {
  lead: "A hidden way for an administrator to leave the kiosk on a PC: a key combination, then the exit PIN.",
  enabled: "Allow admin exit",
  enabledHint: "Changing the admin exit asks you to confirm with your action PIN or a passkey.",
  hotkey: "Key combination",
  hotkeyHint: "Ctrl or Alt (Shift optional) plus one letter, digit or F1–F12. For example Ctrl+Shift+F12.",
  hotkeyCanonical: (canonical: string) => `Saved as ${canonical}.`,
  useDefault: "Use default",
  pin: "Exit PIN",
  pinSetOn: (ms: number) => `PIN set on ${formatDate(ms)}. It is never shown again.`,
  pinSet: "A PIN is set. It is never shown again.",
  pinNotSet: "No PIN yet. Admin exit doesn't work until a PIN is set.",
  setPin: "Set PIN",
  changePin: "Change PIN",
  clearPin: "Clear PIN",
  pinTitle: "Set the exit PIN",
  pinBody: "6 to 12 digits. Avoid repeated digits and simple runs. The PIN is never shown again. This is not your action PIN.",
  newPin: "New exit PIN",
  repeatPin: "Repeat the exit PIN",
  pinSaved: "Exit PIN saved. PCs get it at their next update.",
  clearTitle: "Clear the exit PIN?",
  clearBody: "Admin exit stops working on every PC until a new PIN is set.",
  cleared: "Exit PIN cleared.",
  saved: "Admin exit saved.",
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

/** Settings → Updates (Phase 6 Step 20): the Rulebox build the PCs update to. */
export const updates = {
  title: "Rulebox update",
  lead: "The Rulebox build your PCs update to. Each PC downloads it, checks its SHA-256 and installs it when nobody is signed in.",
  currentTitle: "Current release",
  noneTitle: "No release set",
  noneBody: "PCs keep the Rulebox version they have. Set a release to update them.",
  version: "Version",
  url: "Installer address",
  sha256: "SHA-256",
  size: "Size",
  sizeBytes: (bytes: number, pretty: string) => `${pretty} (${formatNumber(bytes)} bytes)`,
  formTitle: "Set the release",
  formLead: "Use the numbers of the installer you published (the release page shows the version, the SHA-256 and the size).",
  versionLabel: "Version",
  versionHint: "For example 0.1.2. PCs only update to a higher version than they have, never down, and never retry a release that failed.",
  urlLabel: "Installer address (https)",
  urlHint: "A direct https:// link to the .msi, without a user name or password.",
  shaLabel: "SHA-256",
  shaHint: "64 hexadecimal digits. A PC refuses an installer that does not match.",
  sizeLabel: "Size in bytes",
  sizeHint: "Up to 1 GB (1,073,741,824 bytes).",
  setRelease: "Set release",
  saving: "Setting…",
  stop: "Stop updating",
  stopTitle: "Stop updating Rulebox?",
  stopBody: "PCs keep the version they have and no longer look for a newer one, until you set a release again.",
  saved: "Release set. Every PC gets a newly signed policy.",
  cleared: "Release cleared. PCs no longer update Rulebox.",
  noChange: "Nothing changed.",
  ownerOnly: "You can view this. Only an Owner can set the release.",
  fresh: "Setting the release installs it on every PC as an administrator, so it asks you to confirm with your action PIN or a passkey.",
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
  noLimit: "No limit",
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
