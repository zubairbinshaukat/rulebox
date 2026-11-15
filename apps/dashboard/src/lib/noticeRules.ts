/**
 * Rules of the lock and broadcast forms (Phase 5 Step 15, plan 4.17): the same ones `convex/lib/noticeText.ts`
 * enforces, so a form can say what is wrong before the server does. The text is plain text everywhere (the Staff App
 * never renders HTML), so nothing is escaped or stripped here: markup typed in is shown as typed.
 */
import { BROADCAST_ACTIVE_MAX, BROADCAST_BODY_MAX, BROADCAST_TITLE_MAX, LOCK_CONTACT_MAX, LOCK_MESSAGE_MAX } from "../data/types";

export { BROADCAST_ACTIVE_MAX, BROADCAST_BODY_MAX, BROADCAST_TITLE_MAX, LOCK_CONTACT_MAX, LOCK_MESSAGE_MAX };

export type NoticeProblem = "empty" | "tooLong" | "control";

/** Characters the server refuses: C0 / C1 controls (a multi-line text may have line breaks). */
function hasControl(text: string): boolean {
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    if (c < 0x20 || c === 0x7f || (c >= 0x80 && c < 0xa0)) return true;
  }
  return false;
}

/** The problem with a lock / broadcast text, or null. The text is judged trimmed, like the server does. */
export function noticeProblem(text: string, max: number, opts: { multiline: boolean; optional?: boolean }): NoticeProblem | null {
  const t = text.trim();
  if (t === "") return opts.optional === true ? null : "empty";
  if ([...t].length > max) return "tooLong";
  const normalized = opts.multiline ? t.replace(/\r\n?/g, "\n").replace(/\n/g, "") : t;
  return hasControl(normalized) ? "control" : null;
}

export type BroadcastStatus = "active" | "expired" | "cancelled";

/** What a list row says: cancelled wins over expired. `now` is the screen's clock (the query reads none). */
export function broadcastStatus(b: { cancelledAt: number | null; expiresAt: number | null }, now: number): BroadcastStatus {
  if (b.cancelledAt !== null) return "cancelled";
  if (b.expiresAt !== null && b.expiresAt <= now) return "expired";
  return "active";
}

const HOUR = 3_600_000;
/** The expiry choices of the send form: hours from now, `null` = no expiry. The server allows up to a year. */
export const EXPIRY_CHOICES: readonly { key: string; hours: number | null }[] = [
  { key: "1h", hours: 1 },
  { key: "4h", hours: 4 },
  { key: "24h", hours: 24 },
  { key: "7d", hours: 168 },
  { key: "none", hours: null },
];

/** The expiry in ms for a choice, `undefined` for "no expiry". */
export function expiryFor(key: string, now: number): number | undefined {
  const hours = EXPIRY_CHOICES.find((c) => c.key === key)?.hours ?? null;
  return hours === null ? undefined : now + hours * HOUR;
}

/** "14 of 20". The total is the count at send time, so a PC that joined the group later can push the first number past it. */
export function ackRatio(b: { ackCount: number; targetCount: number }): { acked: number; of: number } {
  return { acked: b.ackCount, of: Math.max(b.targetCount, b.ackCount) };
}
