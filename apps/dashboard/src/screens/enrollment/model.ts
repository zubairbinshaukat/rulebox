/**
 * Enrollment screen rules that do not need React: the form's validators
 * (mirroring `convex/enrollmentCodes.ts` `checkBounds` and
 * `lib/enrollmentCodes.ts` `normalizeLabel`), the displayed state of a row and
 * the screen's sentences for the server's refusals.
 */
import { serverFieldError } from "../../components/serverField";
import type { EnrollmentCodeRow, EnrollmentCodeState, PlanScreen } from "../../data/types";
import { toAppError } from "../../lib/errors";
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
