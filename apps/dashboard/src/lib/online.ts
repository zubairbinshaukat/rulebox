/** Section 4.9: online when the last heartbeat is within 2.5 intervals + 60 s. */
export function isOnline(lastSeenAt: number | undefined, pingIntervalMs: number, now: number): boolean {
  if (lastSeenAt === undefined) return false;
  return now - lastSeenAt <= 2.5 * pingIntervalMs + 60_000;
}

/** The "seen recently" window the overview counts with (`overview:get`). */
export function onlineWindowMs(pingIntervalMs: number): number {
  return 2.5 * pingIntervalMs + 60_000;
}
