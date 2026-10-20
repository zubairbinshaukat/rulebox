import type { ViewMode } from "./types";

export type NavKey = "up" | "down" | "left" | "right" | "home" | "end" | "pageUp" | "pageDown";

export interface NavContext {
  /** Items shown. */
  count: number;
  /** Index of the focused item, or -1 when nothing is focused. */
  index: number;
  view: ViewMode;
  /** Grid columns (1 in the list view). */
  columns: number;
  /** Items a Page Up / Page Down moves. */
  pageSize: number;
}

/** Index of the item a navigation key moves the focus to. -1 when there is nothing to focus. */
export function nextIndex(key: NavKey, ctx: NavContext): number {
  const { count, index, view } = ctx;
  if (count <= 0) {
    return -1;
  }
  const last = count - 1;
  const clamp = (n: number) => Math.min(last, Math.max(0, n));
  const columns = view === "grid" ? Math.max(1, ctx.columns) : 1;
  const page = Math.max(1, ctx.pageSize);

  if (key === "home") return 0;
  if (key === "end") return last;
  // Nothing focused yet: any other key lands on the first item.
  if (index < 0) return 0;

  switch (key) {
    case "up":
      return view === "grid" ? clamp(index - columns) : clamp(index - 1);
    case "down": {
      if (view !== "grid") return clamp(index + 1);
      const below = index + columns;
      if (below <= last) return below;
      // A short last row: from any row above it, land on its last item.
      const inLastRow = Math.floor(index / columns) === Math.floor(last / columns);
      return inLastRow ? index : last;
    }
    case "left":
      return view === "grid" ? clamp(index - 1) : index;
    case "right":
      return view === "grid" ? clamp(index + 1) : index;
    case "pageUp":
      return clamp(index - page);
    case "pageDown":
      return clamp(index + page);
  }
}

/** Back / forward history of folders. */
export interface History {
  stack: string[];
  index: number;
}

export function newHistory(start: string): History {
  return { stack: [start], index: 0 };
}

export function currentOf(history: History): string {
  return history.stack[history.index] ?? "";
}

/** Visiting a new folder drops everything ahead of the current one. */
export function pushHistory(history: History, path: string): History {
  if (currentOf(history) === path) {
    return history;
  }
  const stack = [...history.stack.slice(0, history.index + 1), path];
  return { stack, index: stack.length - 1 };
}

export function canGoBack(history: History): boolean {
  return history.index > 0;
}

export function canGoForward(history: History): boolean {
  return history.index < history.stack.length - 1;
}

export function goBack(history: History): History {
  return canGoBack(history) ? { ...history, index: history.index - 1 } : history;
}

export function goForward(history: History): History {
  return canGoForward(history) ? { ...history, index: history.index + 1 } : history;
}

/** `a/b/c` → `a/b`; a top-level folder → `""` (the root). */
export function parentOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash > 0 ? path.slice(0, slash) : "";
}

export function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

/** `New folder`, then `New folder (2)`, `New folder (3)`... the first name not in `taken`. */
export function uniqueName(base: string, taken: Iterable<string>): string {
  const used = new Set(Array.from(taken, (name) => name.toLowerCase()));
  if (!used.has(base.toLowerCase())) {
    return base;
  }
  for (let n = 2; n < 10_000; n++) {
    const candidate = `${base} (${n})`;
    if (!used.has(candidate.toLowerCase())) {
      return candidate;
    }
  }
  return base;
}
