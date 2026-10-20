import { parentOf } from "./navigation";

/**
 * Moving files by dragging, built on pointer events (see `useDragMove`). The
 * WebView's own drag-and-drop does not fire under Tauri's window drop handler,
 * and a pointer drag can never carry anything in from outside the explorer.
 * Drop targets mark themselves with `data-drop-dir="<relative folder>"`.
 */

/** Pixels the pointer must travel before a press becomes a drag. */
export const DRAG_START_DISTANCE = 6;

export interface DragState {
  paths: string[];
  label: string;
  x: number;
  y: number;
  /** The folder it would land in, when that is allowed. */
  target: string | null;
}

/** Whether `paths` may be dropped on the folder `dir` (never on itself, inside itself, or where they already are). */
export function canDropOn(paths: readonly string[], dir: string): boolean {
  return paths.some((path) => {
    if (path === dir) return false;
    if (dir.startsWith(`${path}/`)) return false;
    return parentOf(path) !== dir;
  });
}

/** The drop folder under an element, or `null`. The root is `""`. */
export function dropDirOf(element: Element | null): string | null {
  const target = element?.closest("[data-drop-dir]");
  return target ? (target.getAttribute("data-drop-dir") ?? "") : null;
}
