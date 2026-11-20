import { v } from "convex/values";
import { fail } from "./errors";

// (Phase 6 Step 19, plan 4.14) Rules shared by `groups:setDisplay` and `fleet:setDisplayMode`. The ranges are the ones the agent
// enforces on the signed document (`WEB_WINDOW_CAP_RANGE`, `WEB_IDLE_CLOSE_RANGE` in `rulebox-policy`): a value outside them would
// make the agent refuse the WHOLE document, so the server refuses it first.

export const MIN_WEB_WINDOW_CAP = 1;
export const MAX_WEB_WINDOW_CAP = 12;
export const MIN_IDLE_CLOSE_MIN = 5;
export const MAX_IDLE_CLOSE_MIN = 240;

/** `null` = no choice (the mode's default applies). */
export const nullableNumber = v.union(v.number(), v.null());

/** Whole number in `lo..hi`, or `invalid_argument` on `field`. */
function inRange(value: number, lo: number, hi: number, field: string): number {
  if (!Number.isInteger(value) || value < lo || value > hi) fail("invalid_argument", { field });
  return value;
}

/** `webWindowCap`: 1..12 or `null` (the default of the effective mode: Lite 3, Standard 8). Returns `undefined` for `null`. */
export function cleanWindowCap(value: number | null): number | undefined {
  return value === null ? undefined : inRange(value, MIN_WEB_WINDOW_CAP, MAX_WEB_WINDOW_CAP, "webWindowCap");
}

/** `webIdleCloseMin`: 0 (off) or 5..240, or `null` (the default: Lite 30, Standard off). Returns `undefined` for `null`. */
export function cleanIdleClose(value: number | null): number | undefined {
  if (value === null) return undefined;
  return value === 0 ? 0 : inRange(value, MIN_IDLE_CLOSE_MIN, MAX_IDLE_CLOSE_MIN, "webIdleCloseMin");
}

/** What the admin sees in an audit line. */
export function modeText(mode: "auto" | "standard" | "lite" | undefined): string {
  return mode === "lite" ? "Lite" : mode === "standard" ? "Standard" : "automatic (by memory)";
}
