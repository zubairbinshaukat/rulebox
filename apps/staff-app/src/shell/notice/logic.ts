import type { BroadcastDto } from "@rulebox/types";

/**
 * Which broadcast the strip shows (Phase 5 Step 12, plan 4.17): the newest one that is not a
 * full-screen notice, that nobody has acknowledged, and that the employee has not closed. A broadcast
 * that needs an acknowledgement cannot be closed, only acknowledged ("OK"). A style this app does not
 * know is shown as a strip: the least intrusive reading.
 */
export function pickBanner(list: readonly BroadcastDto[], closed: ReadonlySet<string>): BroadcastDto | null {
  return (
    list.find(
      (item) =>
        item.style !== "fullscreen" &&
        !item.acknowledged &&
        (item.ackRequired || !closed.has(item.id)),
    ) ?? null
  );
}

/** The full-screen notice that still waits for "OK": the newest one, or none. */
export function pickFullscreen(list: readonly BroadcastDto[]): BroadcastDto | null {
  return list.find((item) => item.style === "fullscreen" && !item.acknowledged) ?? null;
}

/** What the lock view says when the administrator wrote no message. */
export const DEFAULT_LOCK_MESSAGE = "This PC has been locked by your administrator.";

/** The text of the lock view's message: the administrator's own, or the default. */
export function lockMessage(message: string): string {
  return message.trim() === "" ? DEFAULT_LOCK_MESSAGE : message;
}
