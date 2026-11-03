import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  goToPage,
  initialPagerState,
  lastPageNumber,
  lastPageRequest,
  pageItems,
  pageRequest,
  reachablePages,
  useCursorPager,
} from "./cursorPager";

const sorted = (s: Set<number>) => [...s].sort((a, b) => a - b);

describe("cursor stack (pure)", () => {
  it("starts on page 1 with only page 1 reachable (nothing known yet)", () => {
    const s = initialPagerState();
    expect(s.cursors).toEqual([null]);
    expect(sorted(reachablePages(s, null, 10, false))).toEqual([1]);
  });

  it("offers the next page only when the server says there is one", () => {
    const s = initialPagerState();
    expect(sorted(reachablePages(s, null, 10, true))).toEqual([1, 2]);
  });

  it("moving on records the cursor and keeps the visited pages reachable", () => {
    let s = initialPagerState();
    s = goToPage(s, 2, null, 10, "c1");
    s = goToPage(s, 3, null, 10, "c2");
    expect(s.cursors).toEqual([null, "c1", "c2"]);
    expect(s.page).toBe(3);
    // Back to a visited page: its stored cursor, no new request needed.
    s = goToPage(s, 2, null, 10);
    expect(s.page).toBe(2);
    expect(pageRequest(s, "asc", null, 10)).toEqual({ dir: "asc", numItems: 10, cursor: "c1", reverse: false });
    expect(sorted(reachablePages(s, null, 10, true))).toEqual([1, 2, 3]);
  });

  it("ignores a page that is not reachable, and the next page without a cursor", () => {
    const s = initialPagerState();
    expect(goToPage(s, 5, null, 10)).toBe(s);
    expect(goToPage(s, 2, null, 10)).toBe(s);
    expect(goToPage(s, 0, null, 10)).toBe(s);
    expect(goToPage(s, 1.5, null, 10)).toBe(s);
  });

  it("computes the last page and its opposite-order request from the total", () => {
    expect(lastPageNumber(null, 10)).toBeNull();
    expect(lastPageNumber(0, 10)).toBe(1);
    expect(lastPageNumber(147, 10)).toBe(15);
    expect(lastPageNumber(150, 10)).toBe(15);
    expect(lastPageRequest("asc", 147, 10)).toEqual({ dir: "desc", numItems: 7, cursor: null, reverse: true });
    expect(lastPageRequest("desc", 150, 10)).toEqual({ dir: "asc", numItems: 10, cursor: null, reverse: true });
  });

  it("the last page is reachable only when a total is known, and reads in reverse", () => {
    let s = initialPagerState();
    expect(sorted(reachablePages(s, null, 10, true))).toEqual([1, 2]);
    expect(sorted(reachablePages(s, 147, 10, true))).toEqual([1, 2, 15]);
    s = goToPage(s, 15, 147, 10);
    expect(s).toMatchObject({ page: 15, last: true });
    expect(pageRequest(s, "asc", 147, 10)).toEqual({ dir: "desc", numItems: 7, cursor: null, reverse: true });
    // The last page offers no next page, and page 1 still works.
    expect(sorted(reachablePages(s, 147, 10, true))).toEqual([1, 15]);
    expect(goToPage(s, 1, 147, 10)).toMatchObject({ page: 1, last: false });
  });

  it("a last page already visited forward is read forward", () => {
    let s = initialPagerState();
    s = goToPage(s, 2, 15, 10, "c1");
    expect(goToPage(s, 2, 15, 10)).toMatchObject({ page: 2, last: false });
  });

  it("draws the first, the neighbours and the last, with an ellipsis between gaps", () => {
    expect(pageItems(1, new Set([1, 2, 15]), 15)).toEqual([1, 2, "gap", 15]);
    expect(pageItems(5, new Set([1, 2, 3, 4, 5, 6, 15]), 15)).toEqual([1, "gap", 4, 5, 6, "gap", 15]);
    expect(pageItems(3, new Set([1, 2, 3, 4]), null)).toEqual([1, 2, 3, 4]);
    expect(pageItems(1, new Set([1]), null)).toEqual([1]);
  });
});

describe("useCursorPager", () => {
  const setup = (props: { pageSize: number; total: number | null; resetKey?: string }) => renderHook((p) => useCursorPager(p), { initialProps: props });

  it("walks forward with next(cursor) and back with prev()", () => {
    const { result } = setup({ pageSize: 10, total: null });
    expect(result.current.page).toBe(1);
    act(() => result.current.next("c1"));
    act(() => result.current.next("c2"));
    expect(result.current.page).toBe(3);
    expect(result.current.cursors).toEqual([null, "c1", "c2"]);
    act(() => result.current.prev());
    expect(result.current.page).toBe(2);
    expect(result.current.request("asc").cursor).toBe("c1");
    // Already visited: next() needs no cursor.
    act(() => result.current.next());
    expect(result.current.page).toBe(3);
    expect(result.current.lastPage).toBeNull();
  });

  it("go(n, continueCursor) opens page + 1 and jumps back to visited pages", () => {
    const { result } = setup({ pageSize: 25, total: null });
    act(() => result.current.go(2, "c1"));
    expect(result.current.page).toBe(2);
    act(() => result.current.go(1));
    expect(result.current.page).toBe(1);
    // Page 2 is known; page 3 needs page 2's cursor, so it is offered only from page 2.
    expect(sorted(result.current.reachablePages(true))).toEqual([1, 2]);
    act(() => result.current.go(2));
    expect(sorted(result.current.reachablePages(true))).toEqual([1, 2, 3]);
  });

  it("jumps to the last page in the opposite order when the total is known", () => {
    const { result } = setup({ pageSize: 10, total: 147 });
    expect(result.current.lastPage).toBe(15);
    act(() => result.current.go(15));
    expect(result.current.page).toBe(15);
    expect(result.current.isLastJump).toBe(true);
    expect(result.current.request("asc")).toEqual({ dir: "desc", numItems: 7, cursor: null, reverse: true });
    act(() => result.current.go(1));
    expect(result.current.isLastJump).toBe(false);
    expect(result.current.request("asc")).toEqual({ dir: "asc", numItems: 10, cursor: null, reverse: false });
  });

  it("starts over when the page size or the reset key (sort, search, filter) changes", () => {
    const { result, rerender } = setup({ pageSize: 10, total: null, resetKey: "name:asc|" });
    act(() => result.current.next("c1"));
    act(() => result.current.next("c2"));
    expect(result.current.page).toBe(3);
    rerender({ pageSize: 10, total: null, resetKey: "name:desc|" });
    expect(result.current.page).toBe(1);
    expect(result.current.cursors).toEqual([null]);
    act(() => result.current.next("d1"));
    expect(result.current.page).toBe(2);
    rerender({ pageSize: 25, total: null, resetKey: "name:desc|" });
    expect(result.current.page).toBe(1);
    expect(result.current.cursors).toEqual([null]);
  });

  it("reset() goes back to page 1 and forgets the cursors", () => {
    const { result } = setup({ pageSize: 10, total: null });
    act(() => result.current.next("c1"));
    act(() => result.current.reset());
    expect(result.current.page).toBe(1);
    expect(result.current.cursors).toEqual([null]);
  });
});
