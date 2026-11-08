/**
 * The forgot-PIN link (`/pin-reset#token=...`, Phase 4b Part C). The token is
 * in the URL FRAGMENT, which browsers never send to a server. The first thing
 * the app does on that path (`main.tsx`, before React or the router start) is
 * to take the token out of the address with `history.replaceState`, so it does
 * not stay in the address bar, the history entry, a bookmark, a screenshot or
 * a later `Referer` (the page is also served with `Referrer-Policy: no-referrer`).
 *
 * The token then lives in this module's memory only (never storage), so the
 * sign-in detour of a signed-out visitor, a single-page navigation, keeps it;
 * a reload loses it, and the person opens the email link again. Tiny on
 * purpose: it is part of the first load.
 */

/** The server's `MAX_PIN_RESET_TOKEN` and the base64url alphabet of the token it mails. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{1,128}$/;

let held: string | null = null;

/**
 * Moves a `#token=` fragment out of the address bar into memory and returns
 * the token held (this call's or an earlier one's), or null. The fragment is
 * removed even when its token has the wrong shape. Safe to call again.
 */
export function captureResetToken(win: Window = window): string | null {
  const hash = win.location.hash;
  if (hash.length > 1) {
    const token = new URLSearchParams(hash.slice(1)).get("token");
    // Keep the router's history state; only the URL changes.
    win.history.replaceState(win.history.state, "", win.location.pathname + win.location.search);
    if (token !== null) held = TOKEN_SHAPE.test(token) ? token : null;
  }
  return held;
}

/** The token held in memory (null when none, or after `forgetResetToken`). */
export function heldResetToken(): string | null {
  return held;
}

/** Drops the token: after it was used, or refused. */
export function forgetResetToken(): void {
  held = null;
}
