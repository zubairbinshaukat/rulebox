import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import type { ListQuery, ListSort } from "../data/serverList";
import { lastPageNumber, PAGE_SIZES, useCursorPager, type CursorPager, type PageRequest } from "./cursorPager";

/**
 * The state of one server-driven list (Phase 4b): page, page size, sort,
 * search text and filters. A main list keeps it in the URL query string
 * (`?page=&size=&sort=&dir=&q=` plus its own filters) so it survives a refresh
 * and the Back button; a small list inside a card or panel keeps it in
 * component state (`storage: "local"`), because several lists share one page.
 * Invalid values fall back to the defaults silently. Any change of sort,
 * search, size or filter starts over on page 1.
 */

export const DEFAULT_PAGE_SIZE = PAGE_SIZES[0];
/** The longest search text the backend accepts (`MAX_SEARCH_TEXT`). */
export const LIST_SEARCH_MAX = 100;

export interface ListConfig {
  /** Server sort keys the table allows. */
  sorts: readonly string[];
  /** The server's default order; omitted from the URL. */
  defaultSort: ListSort;
  /** "url" (default) or "local" (component state, for lists inside cards and panels). */
  storage?: "url" | "local";
  /** Query-string prefix when a page has two lists (invites use "i"). */
  prefix?: string;
  /** Names of filter parameters kept in the URL next to the list state (e.g. "archived"). */
  filters?: readonly string[];
}

interface Raw {
  sort: ListSort;
  search: string;
  size: number;
  page: number;
  filters: Record<string, string>;
}

type Patch = Partial<Pick<Raw, "sort" | "search" | "size" | "page">> & { filter?: readonly [name: string, value: string | null] };

const names = (prefix: string) => ({
  page: `${prefix}page`,
  size: `${prefix}size`,
  sort: `${prefix}sort`,
  dir: `${prefix}dir`,
  q: `${prefix}q`,
});

function defaultsOf(cfg: ListConfig): Raw {
  return { sort: cfg.defaultSort, search: "", size: DEFAULT_PAGE_SIZE, page: 1, filters: {} };
}

function parse(params: URLSearchParams, cfg: ListConfig): Raw {
  const n = names(cfg.prefix ?? "");
  const out = defaultsOf(cfg);
  const key = params.get(n.sort);
  if (key !== null && cfg.sorts.includes(key)) {
    const dir = params.get(n.dir);
    const fallback = key === cfg.defaultSort.key ? cfg.defaultSort.dir : "asc";
    out.sort = { key, dir: dir === "asc" || dir === "desc" ? dir : fallback };
  }
  const size = Number(params.get(n.size));
  if ((PAGE_SIZES as readonly number[]).includes(size)) out.size = size;
  const q = params.get(n.q);
  if (q !== null) out.search = q.trim().slice(0, LIST_SEARCH_MAX);
  const page = Number(params.get(n.page));
  if (Number.isInteger(page) && page > 1 && page < 100_000) out.page = page;
  for (const f of cfg.filters ?? []) {
    const v = params.get(f);
    if (v !== null) out.filters[f] = v;
  }
  return out;
}

function serialize(params: URLSearchParams, cfg: ListConfig, raw: Raw): URLSearchParams {
  const n = names(cfg.prefix ?? "");
  const set = (name: string, value: string | null) => (value === null ? params.delete(name) : params.set(name, value));
  const isDefaultSort = raw.sort.key === cfg.defaultSort.key && raw.sort.dir === cfg.defaultSort.dir;
  set(n.sort, isDefaultSort ? null : raw.sort.key);
  set(n.dir, isDefaultSort ? null : raw.sort.dir);
  set(n.q, raw.search ? raw.search : null);
  set(n.size, raw.size === DEFAULT_PAGE_SIZE ? null : String(raw.size));
  set(n.page, raw.page > 1 ? String(raw.page) : null);
  for (const f of cfg.filters ?? []) set(f, raw.filters[f] ?? null);
  return params;
}

/** The new state after `patch`: any change other than the page itself starts over on page 1. */
function merge(cur: Raw, patch: Patch): Raw {
  const next: Raw = { ...cur, filters: { ...cur.filters } };
  let reset = false;
  if (patch.sort) {
    next.sort = patch.sort;
    reset = true;
  }
  if (patch.search !== undefined) {
    next.search = patch.search.trim().slice(0, LIST_SEARCH_MAX);
    reset = true;
  }
  if (patch.size !== undefined) {
    next.size = patch.size;
    reset = true;
  }
  if (patch.filter) {
    const [name, value] = patch.filter;
    if (value === null) delete next.filters[name];
    else next.filters[name] = value;
    reset = true;
  }
  next.page = reset ? 1 : (patch.page ?? cur.page);
  return next;
}

export interface ListView {
  sort: ListSort;
  /** The applied search text (after Enter). */
  search: string;
  size: number;
  /** The page the URL (or local state) asks for. The pager's own page is what the table shows. */
  page: number;
  /** Values of the configured filter parameters (a missing one is absent). */
  filters: Readonly<Record<string, string>>;
  setSort: (next: ListSort) => void;
  setSearch: (text: string) => void;
  setSize: (size: number) => void;
  setPage: (page: number) => void;
  /** Sets (or, with `null`, removes) one filter parameter and starts over on page 1. */
  setFilter: (name: string, value: string | null) => void;
  /** Changes whenever sort, search or a filter changes: the pager starts over. */
  resetKey: string;
}

export function useListView(cfg: ListConfig): ListView {
  const [params, setParams] = useSearchParams();
  const [local, setLocal] = useState<Raw>(() => defaultsOf(cfg));
  const url = (cfg.storage ?? "url") === "url";
  const cfgRef = useRef(cfg);
  useEffect(() => {
    cfgRef.current = cfg;
  });

  const raw = useMemo(() => (url ? parse(params, cfg) : local), [url, params, cfg, local]);

  const commit = useCallback(
    (patch: Patch) => {
      if (url) setParams((prev) => serialize(new URLSearchParams(prev), cfgRef.current, merge(parse(prev, cfgRef.current), patch)), { replace: true });
      else setLocal((cur) => merge(cur, patch));
    },
    [url, setParams],
  );

  const filterKey = (cfg.filters ?? []).map((f) => `${f}=${raw.filters[f] ?? ""}`).join("&");
  return useMemo(
    () => ({
      sort: raw.sort,
      search: raw.search,
      size: raw.size,
      page: raw.page,
      filters: raw.filters,
      setSort: (sort) => commit({ sort }),
      setSearch: (search) => commit({ search }),
      setSize: (size) => commit({ size }),
      setPage: (page) => commit({ page }),
      setFilter: (name, value) => commit({ filter: [name, value] }),
      resetKey: `${raw.sort.key}:${raw.sort.dir}|${raw.search}|${filterKey}`,
    }),
    [raw, commit, filterKey],
  );
}

export interface ListPaging {
  view: ListView;
  pager: CursorPager;
  /** The current page's request: pass `view.sort` with `dir: req.dir` to the list hook. */
  req: PageRequest;
  /** The arguments for the list hook. */
  query: ListQuery;
}

interface PagingOptions {
  /**
   * Total from a count query: a number, `null` when the table has none (audit, enrollment codes, installs),
   * `undefined` while the count loads. For bounded tables pass the total the list reported (`useAdoptedTotal`).
   */
  total: number | null | undefined;
  /** The list uses offset cursors ("o:<n>"): any page can be reopened after a refresh. */
  offset?: boolean;
  /** More arguments the pager must start over for (the install state, the app). */
  scope?: string;
}

/**
 * The cursor pager of a list view (`useListView`; the screen reads the view first because the count query and the
 * list hook need its search text and filters). Mirrors the pager's page into the URL
 * (replace) and, on a refresh, reopens the page the URL names when that is
 * possible without cursors: page 1, the last page (a total is known), or any
 * page of an offset-cursor table. Anything else falls back to page 1.
 */
export function useListPaging(view: ListView, opts: PagingOptions): ListPaging {
  const total = opts.total ?? null;
  const pager = useCursorPager({ pageSize: view.size, total, resetKey: `${view.resetKey}|${opts.scope ?? ""}` });
  const req = pager.request(view.sort.dir);

  const wanted = useRef(view.page);
  const [restored, setRestored] = useState(view.page <= 1);
  const { go, reset } = pager;
  const { offset, total: rawTotal } = opts;
  const size = view.size;
  useEffect(() => {
    if (restored) return;
    if (offset) {
      for (let n = 2; n <= wanted.current; n++) go(n, `o:${(n - 1) * size}`);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time restore of the page named by the URL
      setRestored(true);
      return;
    }
    if (rawTotal === undefined) return; // the count is still loading
    if (rawTotal !== null && lastPageNumber(rawTotal, size) === wanted.current) go(wanted.current);
    setRestored(true);
  }, [restored, offset, rawTotal, size, go]);

  const { setPage } = view;
  useEffect(() => {
    if (restored && pager.page !== view.page) setPage(pager.page);
  }, [restored, pager.page, view.page, setPage]);

  // A page past the end (a stale URL, rows removed meanwhile) goes back to the first.
  useEffect(() => {
    if (restored && total !== null && pager.page > (lastPageNumber(total, size) ?? 1)) reset();
  }, [restored, total, size, pager.page, reset]);

  const query: ListQuery = {
    sort: { key: view.sort.key, dir: req.dir },
    search: view.search,
    numItems: req.numItems,
    cursor: req.cursor,
  };
  return { view, pager, req, query };
}
