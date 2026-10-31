import type { NoticeItem } from "@rulebox/types";

import {
  addNotices,
  dismiss,
  freshNotices,
  newestVisible,
  remove,
  tick,
  type ToastEntry,
} from "./toastQueue";

/** What the host draws. */
export interface ToastView {
  toasts: ToastEntry[];
  /** The pointer or the keyboard focus is on the cards: the countdown waits. */
  held: boolean;
}

/**
 * The cards on screen, outside React so that events (a new notice, a timer, a
 * click) change it without effects that set state. `ToastHost` reads it with
 * `useSyncExternalStore`. One per host.
 */
export function createToastStore() {
  let view: ToastView = { toasts: [], held: false };
  // The newest notice looked at: a card is made once per notice.
  let lastId = -1;
  const listeners = new Set<() => void>();

  function set(next: Partial<ToastView>) {
    const merged = { ...view, ...next };
    // Nothing left under the pointer to say "pointer left".
    if (merged.toasts.length === 0) {
      merged.held = false;
    }
    if (merged.toasts === view.toasts && merged.held === view.held) {
      return;
    }
    view = merged;
    for (const listener of listeners) {
      listener();
    }
  }

  return {
    get: () => view,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /**
     * The notice list changed. New, recent ones become cards, but only while an
     * employee is signed in (nothing on the sign-in or lock screen); signing out
     * or locking clears the screen.
     */
    ingest(notices: NoticeItem[], signedIn: boolean, now: number) {
      const fresh = freshNotices(notices, lastId, now);
      for (const notice of notices) {
        lastId = Math.max(lastId, notice.id);
      }
      if (!signedIn) {
        set({ toasts: [] });
      } else if (fresh.length > 0) {
        set({ toasts: addNotices(view.toasts, fresh) });
      }
    },
    tick: (elapsedMs: number) => set({ toasts: tick(view.toasts, elapsedMs) }),
    dismiss: (id: number) => set({ toasts: dismiss(view.toasts, id) }),
    /** Esc: the newest card that is not already leaving. */
    dismissNewest() {
      const newest = newestVisible(view.toasts);
      if (newest) {
        set({ toasts: dismiss(view.toasts, newest.id) });
      }
    },
    remove: (id: number) => set({ toasts: remove(view.toasts, id) }),
    hold: (held: boolean) => set({ held }),
  };
}

export type ToastStore = ReturnType<typeof createToastStore>;
