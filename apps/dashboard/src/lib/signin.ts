import { errorCodeOf, messageFor } from "./errors";
import { strings } from "./strings";

/**
 * The sentence for a failed sign-in. Convex Auth throws a plain error for a
 * wrong email or password (it does not say which), so anything without one
 * of our codes is "Email or password is not right."
 */
export function signInMessage(error: unknown): string {
  const code = errorCodeOf(error);
  if (code === "rate_limited") return strings.errors.rateLimited;
  if (code) return messageFor(error);
  return strings.auth.wrongCredentials;
}