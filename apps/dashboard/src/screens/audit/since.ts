/** The When filter of the audit log (`?since=today|7d|30d`; no parameter is "all time"). */
export type When = "all" | "today" | "7d" | "30d";

export const WHEN_CHOICES: readonly When[] = ["all", "today", "7d", "30d"];

/** The URL value back to a choice; anything else (a hand-edited address) is "all time". */
export function parseWhen(value: string | undefined): When {
  return value === "today" || value === "7d" || value === "30d" ? value : "all";
}

/**
 * The first moment the filter shows, in ms: the start of a local day (today, 6 days ago, 29 days ago), so the number stays
 * the same all day and the live query does not re-run every minute. `undefined` for all time.
 */
export function sinceFor(when: When, now: Date = new Date()): number | undefined {
  if (when === "all") return undefined;
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (when === "7d") start.setDate(start.getDate() - 6);
  if (when === "30d") start.setDate(start.getDate() - 29);
  return start.getTime();
}
