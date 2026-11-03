/**
 * The shape of one server-driven list page (Phase 4b, list contract in
 * `convex/lib/listing.ts`). A screen reads ONE page: the sort, the search text,
 * the page size and the cursor are arguments of the query, so the browser never
 * sorts, filters or accumulates rows (Convex free-tier I/O budget). Next and
 * previous pages come from `useCursorPager` (`lib/cursorPager.ts`).
 *
 * Both data implementations (live: Convex, demo: in-memory) return this.
 */
import { useState } from "react";
import type { SortDir } from "../lib/cursorPager";
import type { QueryState } from "./types";

export interface ListSort {
  /** A server sort key of that table (allow-list in `convex/lib/listing.ts`). */
  key: string;
  dir: SortDir;
}

/** What a list hook needs to ask for one page. `dir` is already the page's direction (`pager.request(sort.dir).dir`). */
export interface ListQuery {
  sort?: ListSort;
  /** Applied search text (Enter); empty or undefined = no search. */
  search?: string;
  /** 1..50 (the pager offers 10, 25 and 50). */
  numItems: number;
  /** Null = the first page of this order. */
  cursor: string | null;
}

/** A Convex pagination result; the small bounded tables add their exact `total`. */
export interface PageResult<T> {
  page: T[];
  isDone: boolean;
  continueCursor: string;
  total?: number;
}

export type ServerList<T> =
  | { status: "loading" }
  | { status: "error"; error: unknown; retry: () => void }
  | {
      status: "ready";
      items: T[];
      /** The server has no more rows after this page. Decides whether Next is offered. */
      isDone: boolean;
      /** Pass to `pager.go(page + 1, continueCursor)`. */
      continueCursor: string;
      /** Exact total of the bounded tables (members, file types, invites); null when the list has no inline total. */
      total: number | null;
      /** New arguments are loading: these are the previous page's rows, kept on screen (dimmed). */
      busy: boolean;
    };

export type ReadyList<T> = Extract<ServerList<T>, { status: "ready" }>;

/** The Convex arguments every list query shares: `paginationOpts`, plus `sort` and `search` only when set. */
export function listArgs(q: ListQuery): {
  paginationOpts: { numItems: number; cursor: string | null };
  sort?: ListSort;
  search?: string;
} {
  const search = q.search?.trim();
  return {
    paginationOpts: { numItems: q.numItems, cursor: q.cursor },
    ...(q.sort ? { sort: { key: q.sort.key, dir: q.sort.dir } } : {}),
    ...(search ? { search } : {}),
  };
}

/** A query state of a page result as a `ServerList` (no row is kept here; see `useKeepPrevious`). */
export function toServerList<T>(state: QueryState<PageResult<T>>): ServerList<T> {
  if (state.status !== "ready") return state;
  const r = state.data;
  return { status: "ready", items: r.page, isDone: r.isDone, continueCursor: r.continueCursor, total: r.total ?? null, busy: false };
}

/**
 * While the arguments of the SAME list change (next page, new sort, new search)
 * the previous page's rows stay on screen, dimmed, instead of flashing a
 * skeleton. `identity` names WHAT the list is about (the app and the install
 * state, the archived tab): when it changes the kept rows belong to something
 * else and are dropped.
 */
export function useKeepPrevious<T>(list: ServerList<T>, identity: string): ServerList<T> {
  const [kept, setKept] = useState<{ identity: string; list: ReadyList<T> } | null>(null);
  // Compared by the page's rows (stable while the server's answer is the same object), never by the wrapper.
  if (list.status === "ready" && (kept === null || kept.identity !== identity || kept.list.items !== list.items)) {
    setKept({ identity, list });
  }
  if (list.status === "loading" && kept !== null && kept.identity === identity) return { ...kept.list, busy: true };
  return list;
}

/** The exact total a bounded list reports, remembered for the pager (the pager is configured before the list is read). */
export function useAdoptedTotal(): [number | null, (list: ServerList<unknown>) => void] {
  const [total, setTotal] = useState<number | null>(null);
  const adopt = (list: ServerList<unknown>) => {
    if (list.status === "ready" && !list.busy && list.total !== null && list.total !== total) setTotal(list.total);
  };
  return [total, adopt];
}
