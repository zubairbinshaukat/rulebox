/**
 * Server-driven lists in the demo store (Phase 4b): the same contract as the Convex
 * queries (`convex/lib/listing.ts`), so the demo behaves like the live app.
 *
 *   - the demo "server" sorts and filters the whole list IN THE QUERY (`compute`),
 *     `demoPage` then cuts one page by cursor;
 *   - cursors are opaque (`c:<n>`); the bounded in-memory lists use offset cursors
 *     (`o:<n>`) and return their exact `total` inside the page;
 *   - the last page is read as the same list in the opposite direction with
 *     `numItems = total mod pageSize` (the screen reverses it): that falls out of
 *     `demoPage` because `compute` sorts by the direction the pager asked for.
 */
import type { DemoDb } from "../fixtures/seed";
import { toServerList, useKeepPrevious, type ListQuery, type ListSort, type PageResult, type ServerList } from "../serverList";
import { fail, useDemoQuery } from "./store";

/** One page of an already sorted list. `prefix` "o" = a bounded list (offset cursors, `total` inside the page). */
export function demoPage<R>(all: R[], numItems: number, cursor: string | null, prefix: "c" | "o"): PageResult<R> {
  if (!Number.isInteger(numItems) || numItems < 1 || numItems > 50) fail("invalid_argument", { field: "paginationOpts" });
  let start = 0;
  if (cursor !== null) {
    const m = new RegExp(`^${prefix}:(\\d{1,6})$`).exec(cursor);
    if (m === null) fail("invalid_argument", { field: "paginationOpts" });
    start = Math.min(Number(m[1]), all.length);
  }
  const end = Math.min(start + numItems, all.length);
  const page: PageResult<R> = { page: all.slice(start, end), isDone: end >= all.length, continueCursor: `${prefix}:${end}` };
  if (prefix === "o") page.total = all.length;
  return page;
}

/** A comparator in `dir` order, ties broken by `_id` (as the server's `byField` does), strings by code point like an index. */
export function byKey<R extends { _id: string }>(get: (r: R) => string | number, dir: "asc" | "desc"): (a: R, b: R) => number {
  const sign = dir === "asc" ? 1 : -1;
  return (a, b) => {
    const x = get(a);
    const y = get(b);
    const c = x < y ? -1 : x > y ? 1 : 0;
    return c !== 0 ? sign * c : sign * (a._id < b._id ? -1 : a._id > b._id ? 1 : 0);
  };
}

/**
 * A reactive list page (what `useQuery(api.x.list, { paginationOpts, sort, search })` returns).
 * `compute` returns the WHOLE list in the order of `query.sort` (it also applies the search and the
 * filters); `scope` names what the list is about (the group, the device), so the previous page's
 * rows stay on screen, dimmed, while the next one loads for one simulated round trip.
 */
export function useDemoServerPage<R>(
  name: string,
  scope: string,
  query: ListQuery,
  compute: (db: DemoDb, sort: ListSort | undefined, search: string) => R[],
  prefix: "c" | "o" = "c",
): ServerList<R> {
  const search = query.search?.trim() ?? "";
  const state = useDemoQuery(`${name}:${scope}:${JSON.stringify([query.sort, search])}:${query.numItems}:${query.cursor ?? ""}`, (db) =>
    demoPage(compute(db, query.sort, search), query.numItems, query.cursor, prefix),
  );
  return useKeepPrevious(toServerList(state), `${name}:${scope}`);
}

/** Case-insensitive "contains" (the demo's search on the bounded lists). */
export function contains(needle: string, ...haystack: (string | undefined)[]): boolean {
  const n = needle.toLowerCase();
  return haystack.some((h) => h !== undefined && h.toLowerCase().includes(n));
}

/**
 * The demo twin of a search index: best matches first (the text starts the value, then a word
 * starts with it, then the rest), newest first inside a rank. `sort` is ignored, like on the server.
 */
export function relevance<R extends { _id: string }>(rows: R[], text: string, haystack: (r: R) => string, created: (r: R) => number): R[] {
  const n = text.toLowerCase();
  const rank = (r: R) => {
    const h = haystack(r).toLowerCase();
    if (h.startsWith(n)) return 0;
    return h.split(/[^a-z0-9]+/).some((w) => w.startsWith(n)) ? 1 : 2;
  };
  return rows
    .filter((r) => haystack(r).toLowerCase().includes(n))
    .sort((a, b) => rank(a) - rank(b) || created(b) - created(a) || (a._id < b._id ? -1 : 1));
}
