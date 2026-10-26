import type { ErrorCode, ErrorData } from "../data/types";
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

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}

/** Accepts our `AppError` or anything shaped like a `ConvexError` (`{ data: { code } }`). */
export function toAppError(e: unknown): AppError | null {
  if (e instanceof AppError) return e;
  if (e && typeof e === "object" && "data" in e) {
    const data = (e as { data: unknown }).data;
    if (data && typeof data === "object" && "code" in data && typeof (data as { code: unknown }).code === "string") {
      return new AppError(data as ErrorData);
    }
  }
  return null;
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
    case "mfa_required":
      return e.mfaRequired;
    case "not_found":
      return e.notFound;
    case "invalid_argument":
      return data?.field ? e.invalidField(data.field) : e.invalidArgument;
    case "stale_edit":
      return e.staleEdit;
    case "conflict":
      return e.conflict;
    case "last_owner":
      return e.lastOwner;
    case "rate_limited":
      return e.rateLimited;
    case "not_ready":
      return e.notReady;
    case "invite_invalid":
      return e.inviteInvalid;
    case "account_disabled":
      return e.accountDisabled;
    case "mfa_invalid_code":
      return e.mfaInvalidCode;
    case "mfa_locked":
      return data?.retryAfterMs ? e.mfaLockedFor(data.retryAfterMs) : e.mfaLocked;
    case "mfa_already_enabled":
      return e.mfaAlreadyEnabled;
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
  }
}

/** Maps any error to a sentence for the UI. Unknown errors get the generic sentence. */
export function messageFor(error: unknown): string {
  const app = toAppError(error);
  if (!app) return strings.errors.unknown;
  return messageForCode(app.code, app);
}
