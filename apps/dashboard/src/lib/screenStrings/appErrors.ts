import { messageFor, toAppError } from "../errors";

/**
 * A catalogue edit (an app's record, permissions, archive, retry, icon, or a file-type rule) takes a new configuration
 * version of every group that assigns the app, and the server does at most 10 groups in one go (`too_large`, detail
 * "groups"; Phase 5 Step 16b). The general "too large" sentence does not say what to do, so these screens say this.
 */
export const APP_TOO_MANY_GROUPS = "This app is in more than 10 groups. Remove it from some groups first, or wait for an update that handles larger changes.";

/** The app screens' own sentence for an error (null = the usual one). */
export function appErrorMessage(error: unknown): string | null {
  const e = toAppError(error);
  return e?.code === "too_large" && e.detail === "groups" ? APP_TOO_MANY_GROUPS : null;
}

/** `messageFor` with the app screens' own sentences first (for toasts). */
export function appMessageFor(error: unknown): string {
  return appErrorMessage(error) ?? messageFor(error);
}
