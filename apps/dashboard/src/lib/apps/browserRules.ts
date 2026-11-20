// Browser web apps (Phase 6 Step 16): the inline checks of the form and the permissions that do nothing in a browser window. They mirror
// convex/lib/appRules.ts (`normalizeBrowserSites`) and plan 4.9.3; the server decides. Not part of `validate.ts` (the first load carries
// that): only the App screen and the demo use them.
import type { WebPermissions } from "../../data/types";
import * as v from "../validate";

/** The most allowed sites a Chrome or Edge program may have (`MAX_BROWSER_SITES` on the server). */
export const MAX_BROWSER_SITES = 200;

/** The first problem of an allowed-sites list (already split into lines), as a sentence, or null. */
export function browserSitesProblem(lines: string[], tooMany: string): string | null {
  const unique = [...new Set(lines)];
  if (unique.length > MAX_BROWSER_SITES) return tooMany;
  for (const line of unique) {
    const err = v.domain(line);
    if (err) return err;
  }
  return null;
}

/**
 * The permissions that stay blocked whatever is saved while a website opens in Chrome or Edge (plan 4.9.3, PRD 24.1): screen sharing,
 * clipboard read, location (defaults set to block) and downloads (`DownloadRestrictions` = all). Camera, microphone, notifications and
 * printing are enforced by the browser per site, so they keep working.
 */
export const BROWSER_BLOCKED_PERMISSIONS = ["screenShare", "clipboardRead", "downloads", "geolocation"] as const satisfies readonly (keyof WebPermissions)[];
export type BrowserBlockedPermission = (typeof BROWSER_BLOCKED_PERMISSIONS)[number];

export const isBrowserBlocked = (key: keyof WebPermissions): key is BrowserBlockedPermission => (BROWSER_BLOCKED_PERMISSIONS as readonly string[]).includes(key);
