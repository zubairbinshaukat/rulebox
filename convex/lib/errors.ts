import { ConvexError } from "convex/values";

/**
 * Every error code a dashboard-facing function throws (plan Step 2). The
 * dashboard mirrors this list in `apps/dashboard/src/data/types.ts`
 * (`ERROR_CODES`); `errors.test.ts` keeps the two in sync.
 */
export const ERROR_CODES = [
  "unauthenticated",
  "forbidden",
  "mfa_required",
  "not_found",
  "invalid_argument",
  "stale_edit",
  "conflict",
  "last_owner",
  "rate_limited",
  "not_ready",
  "invite_invalid",
  "account_disabled",
  "mfa_invalid_code",
  "mfa_locked",
  "mfa_already_enabled",
  "winget_unsupported",
  "winget_unreachable",
  "webmeta_failed",
  "device_rejected",
  "too_large",
  "has_dependents",
  // Plan 4.6 ("Ready for more than one organization"); not in the Step 2 list.
  "org_required",
  "already_member",
  // Step-up authentication (plan 4.16, Step 5a). `detail` names the level
  // ("unlocked" | "fresh") or the reason; `retryAfterMs` on step_up_locked.
  "step_up_required",
  "step_up_setup_required",
  "step_up_invalid",
  "step_up_locked",
  "step_up_last_factor",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export type ErrorData = {
  code: ErrorCode;
  field?: string;
  retryAfterMs?: number;
  detail?: string;
};

/**
 * Throw a typed application error. `detail` is a short fixed English text for
 * logs and tests, never a value supplied by a user and never a secret.
 */
export function fail(code: ErrorCode, extra?: Omit<ErrorData, "code">): never {
  const data: ErrorData = { code };
  if (extra?.field !== undefined) data.field = extra.field;
  if (extra?.retryAfterMs !== undefined) data.retryAfterMs = Math.max(0, Math.ceil(extra.retryAfterMs));
  if (extra?.detail !== undefined) data.detail = extra.detail;
  throw new ConvexError(data);
}

/**
 * Phase 2 wire codes of `enrollment:enroll`, read by the agent
 * (`apps/agent/src/enroll.rs`). Kept byte-for-byte so a Phase 2 agent sees
 * no change (plan 5.1). Dashboard functions never throw these.
 */
export type WireErrorCode =
  | "token_invalid"
  | "token_revoked"
  | "token_expired"
  | "token_used_up"
  | "invalid_request";

export function failWire(code: WireErrorCode, message?: string): never {
  throw new ConvexError(message === undefined ? { code } : { code, message });
}
