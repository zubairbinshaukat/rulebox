import type { NoticeItem } from "@rulebox/types";

/** How many cards are on screen at once; a fourth pushes the oldest out. */
export const MAX_VISIBLE = 3;

/** How long a card stays when nobody points at it. */
export const TOAST_MS = 6000;

/** A notice older than this when the page first sees it is history, not news. */
export const FRESH_MS = 15_000;

/** One card on screen. */
export interface ToastEntry {
  /** The notice's id (unique per run). */
  id: number;
  notice: NoticeItem;
  /** Time left before it goes away by itself. */
  remainingMs: number;
  /** Fading out; it leaves the list when the exit animation ends. */
  leaving: boolean;
}

function sameMessage(a: NoticeItem, b: NoticeItem): boolean {
  return a.tone === b.tone && a.title === b.title && a.detail === b.detail;
}

/**
 * Add new notices, oldest first. A notice that says the same as a card already
 * on screen only restarts that card's timer (no stack of "Saved a.txt" copies),
 * and when more than `MAX_VISIBLE` cards would show, the oldest start leaving.
 */
export function addNotices(list: ToastEntry[], incoming: NoticeItem[]): ToastEntry[] {
  let next = list;
  for (const notice of incoming) {
    const twin = next.find((entry) => !entry.leaving && sameMessage(entry.notice, notice));
    if (twin) {
      next = next.map((entry) => (entry === twin ? { ...entry, remainingMs: TOAST_MS } : entry));
      continue;
    }
    next = [...next, { id: notice.id, notice, remainingMs: TOAST_MS, leaving: false }];
    let over = next.filter((entry) => !entry.leaving).length - MAX_VISIBLE;
    if (over > 0) {
      next = next.map((entry) => {
        if (over > 0 && !entry.leaving) {
          over -= 1;
          return { ...entry, leaving: true };
        }
        return entry;
      });
    }
  }
  return next;
}

/** Time has passed with nobody pointing at the cards: spend it, retire the expired. */
export function tick(list: ToastEntry[], elapsedMs: number): ToastEntry[] {
  let changed = false;
  const next = list.map((entry) => {
    if (entry.leaving) {
      return entry;
    }
    changed = true;
    const remainingMs = entry.remainingMs - elapsedMs;
    return remainingMs <= 0 ? { ...entry, remainingMs: 0, leaving: true } : { ...entry, remainingMs };
  });
  return changed ? next : list;
}

/** Start one card's exit (a click, the close button, Esc). */
export function dismiss(list: ToastEntry[], id: number): ToastEntry[] {
  return list.map((entry) => (entry.id === id && !entry.leaving ? { ...entry, leaving: true } : entry));
}

/** The card is gone from the screen. */
export function remove(list: ToastEntry[], id: number): ToastEntry[] {
  return list.filter((entry) => entry.id !== id);
}

/** The newest card that is not already leaving: what Esc closes. */
export function newestVisible(list: ToastEntry[]): ToastEntry | undefined {
  return [...list].reverse().find((entry) => !entry.leaving);
}

/**
 * The notices worth a card: not seen before, not history. `lastId` is the
 * highest id the page has already looked at.
 */
export function freshNotices(notices: NoticeItem[], lastId: number, now: number): NoticeItem[] {
  return notices.filter((notice) => notice.id > lastId && now - notice.atMs < FRESH_MS);
}
