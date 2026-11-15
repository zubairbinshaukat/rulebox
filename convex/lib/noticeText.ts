import { fail } from "./errors";
import { hasControlChars } from "./networkShared";

/**
 * Free text of the lock and broadcast forms (Phase 5 Step 15): trimmed, 1..max characters (or empty when `optional`),
 * no control characters. A `multiline` text may have line breaks (normalised to `\n`). The Staff App shows it as plain
 * text, so no markup is stripped or interpreted here. `invalid_argument` with `field` and `detail` otherwise.
 */
export function cleanNoticeText(text: string, max: number, field: string, opts: { multiline: boolean; optional?: boolean }): string {
  if (text.length > max * 4) fail("invalid_argument", { field, detail: "too_long" });
  const t = text.trim();
  if (t === "") {
    if (opts.optional === true) return "";
    fail("invalid_argument", { field, detail: "empty" });
  }
  if ([...t].length > max) fail("invalid_argument", { field, detail: "too_long" });
  const normalized = opts.multiline ? t.replace(/\r\n?/g, "\n") : t;
  if (hasControlChars(opts.multiline ? normalized.replace(/\n/g, "") : normalized)) fail("invalid_argument", { field, detail: "control_characters" });
  return normalized;
}
