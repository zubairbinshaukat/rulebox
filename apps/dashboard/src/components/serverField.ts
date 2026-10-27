import { messageFor, toAppError, type AppError } from "../lib/errors";

/**
 * The server's `invalid_argument` / `conflict` for one field, as the sentence
 * to show under that field (linked with `aria-describedby` by `Field`). Null
 * when the error is about something else.
 */
export function serverFieldError(error: unknown, field: string, describe: (e: AppError) => string = messageFor): string | null {
  const e = toAppError(error);
  if (!e || e.field !== field || (e.code !== "invalid_argument" && e.code !== "conflict")) return null;
  return describe(e);
}
