import type { BroadcastRow } from "../../data/types";

/** "On your PCs now" shows at most this many messages (the server's limit of active ones). */
export const LIVE_MAX = 20;

/**
 * The messages still on the PCs by the screen's own clock. `broadcasts:live` reads no clock, so it also returns a few that ended
 * a moment ago (and the cancelled ones are never in it): they are dropped here. The server's order (newest first) is kept.
 */
export function stillLive(rows: readonly BroadcastRow[], now: number): BroadcastRow[] {
  return rows.filter((b) => b.cancelledAt === null && (b.expiresAt === null || b.expiresAt > now)).slice(0, LIVE_MAX);
}

const formats = new Map<string, Intl.DateTimeFormat>();
function fmt(key: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  let f = formats.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(undefined, options);
    formats.set(key, f);
  }
  return f;
}

const DAY = 24 * 3_600_000;
const startOfDay = (ms: number) => new Date(ms).setHours(0, 0, 0, 0);

/**
 * When a message ends, short: "17:00" today, "Tue 14:00" within the week, "3 Dec, 14:00" later. The caller adds "Until".
 * `now` is the screen's clock.
 */
export function endsLabel(ms: number, now: number): string {
  const days = Math.round((startOfDay(ms) - startOfDay(now)) / DAY);
  if (days <= 0) return fmt("time", { hour: "numeric", minute: "2-digit" }).format(ms);
  if (days < 7) return fmt("week", { weekday: "short", hour: "numeric", minute: "2-digit" }).format(ms);
  return fmt("far", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(ms);
}
