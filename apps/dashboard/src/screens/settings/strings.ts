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
