/**
 * Enrollment screen rules that do not need React: the form's validators
 * (mirroring `convex/enrollmentCodes.ts` `checkBounds` and
 * `lib/enrollmentCodes.ts` `normalizeLabel`), the displayed state of a row and
 * the screen's sentences for the server's refusals.
 */
import { serverFieldError } from "../../components/serverField";
import type { EnrollmentCodeRow, EnrollmentCodeState, EnrollmentPc, EnrollmentProgress, PlanScreen } from "../../data/types";
import { toAppError } from "../../lib/errors";
import { readStorage, writeStorage } from "../../lib/storage";
import { strings } from "../../lib/strings";
import { planLimitMessage } from "../settings/strings";
import { enrollText } from "./strings";

/** `convex/lib/limits.ts`: MIN/MAX_CODE_USES, MIN/MAX_CODE_TTL_MINUTES, MAX_CODE_LABEL. */
export const CODE_LIMITS = { minUses: 1, maxUses: 100, minTtl: 15, maxTtl: 7 * 24 * 60, maxLabel: 64 } as const;

export type TtlUnit = "minutes" | "hours" | "days";
const UNIT_MINUTES: Record<TtlUnit, number> = { minutes: 1, hours: 60, days: 24 * 60 };

// A type (not an interface) so it fits `useForm`'s `Record<string, unknown>`.
export type EnrollForm = {
  groupId: string;
  uses: string;
  /** A preset in minutes ("15", "60", …) or "custom". */
  ttl: string;
  customAmount: string;
  customUnit: TtlUnit;
  label: string;
};

/** The chosen lifetime in minutes, or null when the custom value is not a whole number. */
export function ttlMinutesOf(x: Pick<EnrollForm, "ttl" | "customAmount" | "customUnit">): number | null {
  if (x.ttl !== "custom") return Number(x.ttl);
  const t = x.customAmount.trim();
  if (!/^\d{1,6}$/.test(t)) return null;
  return Number(t) * UNIT_MINUTES[x.customUnit];
}

/** The server's label rule: trimmed, at most 64 characters (code points), no control characters. */
export function labelProblem(value: string): string | null {
  const t = value.trim();
  if (t === "") return null;
  // eslint-disable-next-line no-control-regex
  if (Array.from(t).length > CODE_LIMITS.maxLabel || /[\u0000-\u001f\u007f]/.test(t)) return enrollText.labelInvalid;
  return null;
}

export function validateEnrollForm(x: EnrollForm): Partial<Record<"groupId" | "uses" | "ttl" | "label", string>> {
  const uses = x.uses.trim();
  const usesOk = /^\d{1,3}$/.test(uses) && Number(uses) >= CODE_LIMITS.minUses && Number(uses) <= CODE_LIMITS.maxUses;
  const ttl = ttlMinutesOf(x);
  return {
    groupId: x.groupId ? undefined : strings.validate.pickGroup,
    uses: usesOk ? undefined : strings.validate.integerRange(CODE_LIMITS.minUses, CODE_LIMITS.maxUses),
    ttl: ttl !== null && ttl >= CODE_LIMITS.minTtl && ttl <= CODE_LIMITS.maxTtl ? undefined : enrollText.ttlRange,
    label: labelProblem(x.label) ?? undefined,
  };
}

/**
 * The state shown for a row. The server computes it from the minute the list
 * was asked for; a code that expires while the page is open turns "Expired"
 * here without a new query.
 */
export function displayState(row: Pick<EnrollmentCodeRow, "state" | "expiresAt">, now: number): EnrollmentCodeState {
  return row.state === "active" && row.expiresAt <= now ? "expired" : row.state;
}

/**
 * The code in blocks of `size` for reading. Display only: the agent accepts
 * the code exactly as created (no spaces inside), so Copy always copies the
 * ungrouped text.
 */
export function codeBlocks(code: string, size = 4): string[] {
  // The version prefix ("RBX1.") is a block of its own.
  const head = /^[A-Z0-9]+\./.exec(code)?.[0] ?? "";
  const out: string[] = head ? [head] : [];
  for (let i = head.length; i < code.length; i += size) out.push(code.slice(i, i + size));
  return out;
}

// ---------------------------------------------------------------- the Add a PC wizard (UI pass, enrollment plan 3)
// New pure helpers. The form model above (`EnrollForm`, `ttlMinutesOf`, `validateEnrollForm`, the "custom" lifetime) belongs to the old
// dialog and is removed together with it when the wizard replaces `Enrollment.tsx` (plan step 8): nothing new uses it.

/** The lifetimes the wizard offers under "More options", in minutes (the server's bounds are unchanged: 15 minutes to 7 days). */
export const TTL_PRESETS = [15, 60, 24 * 60, 7 * 24 * 60] as const;
/** What a code works for unless the admin changes it: one day. */
export const DEFAULT_TTL_MINUTES = 24 * 60;
/** "How many PCs?" starts at one. */
export const DEFAULT_USES = 1;

/** The stepper: a whole number from 1 to 100. */
export function clampUses(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_USES;
  return Math.min(CODE_LIMITS.maxUses, Math.max(CODE_LIMITS.minUses, Math.round(value)));
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/**
 * The name a code gets when the admin gives none: `"{group} · {28 Nov}"`, at most 64 characters (code points), the group name cut with
 * an ellipsis when it does not fit. The date is the browser's local day. Never empty: a group without a name is "Code".
 */
export function autoLabel(groupName: string, now: number): string {
  const d = new Date(now);
  const date = `${d.getDate()} ${MONTHS[d.getMonth()] ?? ""}`;
  const suffix = ` · ${date}`;
  // eslint-disable-next-line no-control-regex
  const name = groupName.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (name === "") return `Code${suffix}`;
  const room = CODE_LIMITS.maxLabel - Array.from(suffix).length;
  const chars = Array.from(name);
  const head = chars.length <= room ? name : `${chars.slice(0, Math.max(1, room - 1)).join("").trimEnd()}…`;
  return `${head}${suffix}`;
}

/**
 * The group the picker starts on: the one used last in this browser when it still exists, else the only group, else the first by name.
 * Null when there is no group (the wizard then asks for a first group).
 */
export function pickDefaultGroup(groups: readonly { _id: string; name: string }[], lastUsedId: string | null): string | null {
  if (groups.length === 0) return null;
  if (lastUsedId !== null && groups.some((g) => g._id === lastUsedId)) return lastUsedId;
  if (groups.length === 1) return groups[0]!._id;
  return [...groups].sort((a, b) => a.name.localeCompare(b.name))[0]!._id;
}

/** localStorage key of the group used last (an id only, never a code). */
export const LAST_GROUP_KEY = "rulebox.enrollment.lastGroup";

/** Per browser, best effort (private windows and blocked storage answer null / do nothing). */
export function readLastGroup(): string | null {
  return readStorage(LAST_GROUP_KEY);
}
export function writeLastGroup(groupId: string): void {
  writeStorage(LAST_GROUP_KEY, groupId);
}

/**
 * "Install without clicks" for IT: the MSI command (`ENROLLCODE` is a hidden property of the installer; the file name carries the
 * version of the release the dashboard knows, else just `Rulebox-x64.msi`) and the agent's own command line.
 */
export function silentCommand(code: string, version?: string | null): { msi: string; cli: string } {
  const file = version ? `Rulebox-${version}-x64.msi` : "Rulebox-x64.msi";
  return { msi: `msiexec /i ${file} /qn ENROLLCODE=${code}`, cli: `rulebox-agent enroll ${code}` };
}

/** The state of the code being watched, with the screen's clock (the same order as the server's `codeState`: revoked, used up, expired, active). */
export function progressState(p: Pick<EnrollmentProgress, "revoked" | "usesLeft" | "expiresAt">, now: number): EnrollmentCodeState {
  if (p.revoked) return "revoked";
  if (p.usesLeft <= 0) return "usedUp";
  if (p.expiresAt <= now) return "expired";
  return "active";
}

/** How far a PC that joined has come: the stage chips of the progress step, in order. */
export type PcStage = "joined" | "online" | "settingUp" | "ready" | "needsAttention";
export const PC_STAGES: readonly PcStage[] = ["joined", "online", "settingUp", "ready"];

/**
 * From what the PC reported. The kiosk phase wins once the PC reports one (`applied` = ready, `applying` = setting up, `failed` =
 * needs attention); before that it is online or just joined. A PC that went offline again after it was ready stays "ready".
 */
export function pcStage(pc: Pick<EnrollmentPc, "online" | "kioskPhase">): PcStage {
  if (pc.kioskPhase === "failed") return "needsAttention";
  if (pc.kioskPhase === "applied") return "ready";
  if (pc.kioskPhase === "applying") return "settingUp";
  return pc.online ? "online" : "joined";
}

/** The server's `invalid_argument` for one form field (server field name → our field). */
export function enrollFieldError(error: unknown, field: "uses" | "ttlMinutes" | "label"): string | null {
  return serverFieldError(error, field, () =>
    field === "uses"
      ? strings.validate.integerRange(CODE_LIMITS.minUses, CODE_LIMITS.maxUses)
      : field === "ttlMinutes"
        ? enrollText.ttlRange
        : enrollText.labelInvalid,
  );
}

/** Screen sentences for `plan_limit`, `not_found` (the group) and `not_ready`; null = the usual one. */
export function enrollErrorMessage(error: unknown, plan?: PlanScreen | null): string | null {
  const e = toAppError(error);
  if (e?.code === "plan_limit") return planLimitMessage(e.detail, plan?.plan, plan?.limits.maxEnrollmentCodesActive);
  if (e?.code === "not_found") return enrollText.groupGoneError;
  if (e?.code === "not_ready") return enrollText.notReady;
  return null;
}
