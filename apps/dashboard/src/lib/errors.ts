import { ERROR_CODES, type ErrorCode, type ErrorData } from "../data/types";
import { strings } from "./strings";

/**
 * A typed error from a mutation or query. With the real backend this is built
 * from a `ConvexError` whose `data` is `{ code, field?, retryAfterMs?, detail? }`
 * (see `toAppError`).
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly field?: string;
  readonly retryAfterMs?: number;
  readonly detail?: string;

  constructor(data: ErrorData) {
    super(data.detail ?? data.code);
    this.name = "AppError";
    this.code = data.code;
    this.field = data.field;
    this.retryAfterMs = data.retryAfterMs;
    this.detail = data.detail;
  }
}

const KNOWN_CODES: ReadonlySet<string> = new Set(ERROR_CODES);

/**
 * Sentences for an `invalid_argument` refusal that names a `detail` (the update-mode refusals of plan 4.4). A screen registers its own
 * when its chunk loads, so they are not part of the first load.
 */
const DETAIL_SENTENCES: Record<string, string> = {};
export const registerDetailSentences = (sentences: Readonly<Record<string, string>>): void => void Object.assign(DETAIL_SENTENCES, sentences);

/**
 * Accepts our `AppError` or anything shaped like a `ConvexError`
 * (`{ data: { code } }`) whose code is one of `ERROR_CODES`. Only the known
 * fields are copied (numbers and short strings), never the server's message.
 * Anything else is `null` and shows the generic sentence.
 */
export function toAppError(e: unknown): AppError | null {
  if (e instanceof AppError) return e;
  if (!e || typeof e !== "object" || !("data" in e)) return null;
  const data: unknown = (e as { data: unknown }).data;
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (typeof d.code !== "string" || !KNOWN_CODES.has(d.code)) return null;
  const out: ErrorData = { code: d.code as ErrorCode };
  if (typeof d.field === "string") out.field = d.field;
  if (typeof d.retryAfterMs === "number") out.retryAfterMs = d.retryAfterMs;
  if (typeof d.detail === "string") out.detail = d.detail;
  return new AppError(out);
}

export function errorCodeOf(e: unknown): ErrorCode | null {
  return toAppError(e)?.code ?? null;
}

/** One sentence per error code. The switch is exhaustive: a new code is a type error here. */
export function messageForCode(code: ErrorCode, data?: Omit<ErrorData, "code">): string {
  const e = strings.errors;
  switch (code) {
    case "unauthenticated":
      return e.unauthenticated;
    case "forbidden":
      return e.forbidden;
    case "not_found":
      return e.notFound;
    case "invalid_argument":
      // The member password rule (12-256, a letter and a digit) has its own sentence; so
      // does the employee rule (8-256, not the username), which the server marks with a detail.
      if (data?.field === "password") {
        if (data.detail === "length") return strings.validate.passwordEmployee;
        if (data.detail === "username") return strings.validate.passwordEqualsUsername;
        return strings.validate.passwordMember;
      }
      // A refusal with a registered sentence of its own (the update modes, plan 4.4).
      if (data?.detail !== undefined && Object.hasOwn(DETAIL_SENTENCES, data.detail)) return DETAIL_SENTENCES[data.detail]!;
      return data?.field ? e.invalidField(data.field) : e.invalidArgument;
    case "stale_edit":
      return e.staleEdit;
    case "conflict":
      return data?.field === "username" ? strings.validate.usernameTaken : e.conflict;
    case "last_owner":
      return e.lastOwner;
    case "rate_limited":
      return e.rateLimited;
    case "not_ready":
      return data?.detail === "signing key" ? e.notReadySigningKey : e.notReady;
    case "invite_invalid":
      return e.inviteInvalid;
    case "account_disabled":
      return e.accountDisabled;
    case "winget_unsupported":
      return data?.detail ? e.wingetUnsupportedBecause(data.detail) : e.wingetUnsupported;
    case "winget_unreachable":
      return e.wingetUnreachable;
    case "webmeta_failed":
      return e.webmetaFailed;
    case "device_rejected":
      return e.deviceRejected;
    case "too_large":
      return e.tooLarge;
    case "has_dependents":
      return e.hasDependents;
    case "org_required":
      return e.orgRequired;
    case "already_member":
      return e.alreadyMember;
    case "step_up_required":
      return e.stepUpRequired;
    case "step_up_setup_required":
      return data?.detail === "reauthenticate" ? e.stepUpReauthenticate : e.stepUpSetupRequired;
    case "step_up_invalid":
      return data?.retryAfterMs ? e.stepUpInvalidWait(data.retryAfterMs) : e.stepUpInvalid;
    case "step_up_locked":
      if (!data?.retryAfterMs) return e.stepUpLockedNoWait;
      return data.detail === "lockout" ? e.stepUpLockout(data.retryAfterMs) : e.stepUpLocked(data.retryAfterMs);
    case "step_up_last_factor":
      return e.stepUpLastFactor;
    case "plan_limit":
      return e.planLimit;
  }
}

/** Maps any error to a sentence for the UI. Unknown errors get the generic sentence. */
export function messageFor(error: unknown): string {
  const app = toAppError(error);
  if (!app) return strings.errors.unknown;
  return messageForCode(app.code, app);
}
