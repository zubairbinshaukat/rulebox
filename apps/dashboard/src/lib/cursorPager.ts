import { useCallback, useMemo, useState } from "react";

/**
 * Page numbers on top of cursor-only pagination (Convex gives a `continueCursor`,
 * never a page number). The client keeps the stack of cursors it has seen:
 *
 *   cursors[i] = the cursor that starts page i + 1   (cursors[0] is always null)
 *
 * Reachable pages are the visited ones, the next one (when the server said there
 * is one), and, when a total is known, the last one: it is read in the OPPOSITE
 * order with `numItems = total % pageSize || pageSize`, so no cursors are needed
 * to jump there. Everything here is pure; `useCursorPager` is a thin React shell.
 * Nothing in this file talks to Convex: the screen maps `request()` onto its
 * query arguments.
 */

export type SortDir = "asc" | "desc";

export const flipDir = (dir: SortDir): SortDir => (dir === "asc" ? "desc" : "asc");

/** Rows per page the owner can pick (the backend accepts up to 50). */
export const PAGE_SIZES = [10, 25, 50] as const;

/** The page numbers to draw: the first, the neighbours of the current page and the last, when reachable. `"gap"` = an ellipsis. */
export function pageItems(page: number, reachable: ReadonlySet<number>, last: number | null): (number | "gap")[] {
  const want = new Set<number>([page]);
  for (const n of [1, page - 1, page + 1, last ?? -1]) if (n >= 1 && reachable.has(n)) want.add(n);
  const sorted = [...want].sort((a, b) => a - b);
  const out: (number | "gap")[] = [];
  sorted.forEach((n, i) => {
    if (i > 0 && n - sorted[i - 1]! > 1) out.push("gap");
    out.push(n);
  });
  return out;
}

export interface PagerState {
  cursors: (string | null)[];
  page: number;
  /** On the last page, read in the opposite order (its rows come back reversed). */
  last: boolean;
  /** `pageSize` + reset key the state belongs to; a new key starts over. */
  key: string;
}

export const initialPagerState = (key = ""): PagerState => ({ cursors: [null], page: 1, last: false, key });

/** The number of the last page, or null when the total is not known. */
export function lastPageNumber(total: number | null, pageSize: number): number | null {
  if (total === null) return null;
  return Math.max(1, Math.ceil(total / pageSize));
}

export interface PageRequest {
  dir: SortDir;
  numItems: number;
  cursor: string | null;
  /** The rows come back in the opposite order: show them reversed. */
  reverse: boolean;
}

/** The one cheap query that reads the last page: the flipped order, the remainder of the total. */
export function lastPageRequest(dir: SortDir, total: number, pageSize: number): PageRequest {
  return { dir: flipDir(dir), numItems: total % pageSize || pageSize, cursor: null, reverse: true };
}

/** What to ask the server for the current page. */
export function pageRequest(state: PagerState, dir: SortDir, total: number | null, pageSize: number): PageRequest {
  if (state.last && total !== null) return lastPageRequest(dir, total, pageSize);
  return { dir, numItems: pageSize, cursor: state.cursors[state.page - 1] ?? null, reverse: false };
}

/** Pages that can be opened right now. `hasNext`: the server said the current page is not the end. */
export function reachablePages(state: PagerState, total: number | null, pageSize: number, hasNext: boolean): Set<number> {
  const out = new Set<number>();
  for (let i = 1; i <= state.cursors.length; i++) out.add(i);
  if (hasNext && !state.last) out.add(state.page + 1);
  const last = lastPageNumber(total, pageSize);
  if (last !== null) out.add(last);
  return out;
}

/**
 * Opens page `n`. A visited page uses its stored cursor; the last page (when the
 * total is known) switches to the opposite-order read; the page after the
 * frontier needs the current page's `continueCursor`. Anything else is ignored.
 */
export function goToPage(state: PagerState, n: number, total: number | null, pageSize: number, continueCursor?: string | null): PagerState {
  if (!Number.isInteger(n) || n < 1) return state;
  if (n <= state.cursors.length) return n === state.page && !state.last ? state : { ...state, page: n, last: false };
  if (n === state.page + 1 && !state.last && continueCursor) {
    return { ...state, cursors: [...state.cursors.slice(0, state.page), continueCursor], page: n, last: false };
  }
  const last = lastPageNumber(total, pageSize);
  if (last !== null && n === last) return { ...state, page: n, last: true };
  return state;
}

export interface CursorPager {
  /** 1-based. */
  page: number;
  pageSize: number;
  /** The visited cursors; `cursors[page - 1]` starts the current page. */
  cursors: (string | null)[];
  /** The number of the last page, or null without a total. */
  lastPage: number | null;
  /** Reading the last page in the opposite order. */
  isLastJump: boolean;
  /** Query arguments for the current page in the list's sort direction. */
  request: (dir: SortDir) => PageRequest;
  /** Pages the pager may offer; `hasNext` comes from the list result (`!isDone`). */
  reachablePages: (hasNext: boolean) => Set<number>;
  /** Opens page `n` if it is reachable. Pass the current page's `continueCursor` to open page + 1. */
  go: (n: number, continueCursor?: string | null) => void;
  /** Page + 1: stored cursor if visited, else `cursor` (the current page's `continueCursor`). */
  next: (cursor?: string | null) => void;
  prev: () => void;
  /** Back to page 1 and forget every cursor. */
  reset: () => void;
}

/**
 * The cursor stack of one list. Changing `pageSize` or `resetKey` (put the sort,
 * the search text and the filters in it) starts over on page 1, so a stale
 * cursor is never sent with different arguments.
 */
export function useCursorPager({ pageSize, total, resetKey = "" }: { pageSize: number; total: number | null; resetKey?: string }): CursorPager {
  const key = `${pageSize}|${resetKey}`;
  const [stored, setStored] = useState<PagerState>(() => initialPagerState(key));
  let state = stored;
  if (stored.key !== key) {
    // Derived during render (React re-runs this component at once), so no frame shows a stale cursor.
    state = initialPagerState(key);
    setStored(state);
  }

  const go = useCallback(
    (n: number, continueCursor?: string | null) => setStored((s) => (s.key === key ? goToPage(s, n, total, pageSize, continueCursor) : s)),
    [key, total, pageSize],
  );
  const next = useCallback((cursor?: string | null) => go(state.page + 1, cursor), [go, state.page]);
  const prev = useCallback(() => go(state.page - 1), [go, state.page]);
  const reset = useCallback(() => setStored(initialPagerState(key)), [key]);
  const request = useCallback((dir: SortDir) => pageRequest(state, dir, total, pageSize), [state, total, pageSize]);
  const reachable = useCallback((hasNext: boolean) => reachablePages(state, total, pageSize, hasNext), [state, total, pageSize]);

  return useMemo(
    () => ({
      page: state.page,
      pageSize,
      cursors: state.cursors,
      lastPage: lastPageNumber(total, pageSize),
      isLastJump: state.last,
      request,
      reachablePages: reachable,
      go,
      next,
      prev,
      reset,
    }),
    [state, pageSize, total, request, reachable, go, next, prev, reset],
  );
}
