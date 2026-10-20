import type { TaskItem } from "@rulebox/types";

/** The windows the switcher offers: the most recently used first; ties keep the taskbar order. */
export function switcherOrder(tasks: readonly TaskItem[]): TaskItem[] {
  return tasks
    .map((task, position) => ({ task, position }))
    .sort((a, b) => {
      // The active window counts as the most recent whatever its number says.
      const recent = (b.task.active ? Number.MAX_SAFE_INTEGER : b.task.recency) -
        (a.task.active ? Number.MAX_SAFE_INTEGER : a.task.recency);
      return recent !== 0 ? recent : a.position - b.position;
    })
    .map(({ task }) => task);
}

/**
 * Where the highlight starts. Like Windows' own switcher it is the window used
 * before this one (the second in the list), so Alt+Tab alone swaps between two.
 */
export function initialIndex(count: number): number {
  return count > 1 ? 1 : 0;
}

/** Move the highlight, wrapping at both ends. */
export function moveIndex(index: number, count: number, delta: 1 | -1): number {
  if (count <= 0) {
    return 0;
  }
  return (index + delta + count) % count;
}

export type SwitcherKey =
  | { type: "move"; delta: 1 | -1 }
  | { type: "activate" }
  | { type: "cancel" }
  | null;

export interface SwitcherKeyEvent {
  key: string;
  shiftKey: boolean;
  /** `keydown` or `keyup`. */
  phase: "down" | "up";
}

/**
 * What a key does in the switcher. The popup has the focus, so the keys come
 * here: Tab / Shift+Tab / arrows move, Enter or releasing Alt activates,
 * Escape cancels.
 */
export function switcherKey(event: SwitcherKeyEvent): SwitcherKey {
  if (event.phase === "up") {
    return event.key === "Alt" ? { type: "activate" } : null;
  }
  switch (event.key) {
    case "Tab":
      return { type: "move", delta: event.shiftKey ? -1 : 1 };
    case "ArrowRight":
    case "ArrowDown":
      return { type: "move", delta: 1 };
    case "ArrowLeft":
    case "ArrowUp":
      return { type: "move", delta: -1 };
    case "Enter":
      return { type: "activate" };
    case "Escape":
      return { type: "cancel" };
    default:
      return null;
  }
}
