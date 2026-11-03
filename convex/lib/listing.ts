import type { PaginationOptions, PaginationResult } from "convex/server";
import { v, type GenericValidator, type Infer } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseReader } from "../_generated/server";
import { fail } from "./errors";
import { MAX_LIST_PAGE, MAX_SEARCH_TEXT } from "./limits";

// The list contract (Phase 4b Part A, `docs/plans/phase-4b-tables-and-pin.md`).
// Every list a dashboard table shows is sorted, searched and paged IN THE QUERY
// (index + cursor); the browser never sorts or filters rows it loaded.
//
// Arguments of a list query:
// - `paginationOpts`: `numItems` is a whole number 1..MAX_LIST_PAGE (50). The
//   pager offers 10 / 25 / 50; any smaller positive number is accepted too so
//   the LAST page can be read as "the opposite `sort.dir`, numItems = total mod
//   pageSize" (one cheap query; the client reverses those rows for display).
// - `sort` (optional): `{ key, dir }`; `key` must be one of the table's keys in
//   LIST_SORTS, else `invalid_argument` field "sort". Omitted = the table's
//   default (today's order). Every key is index-backed in both directions on
//   growing tables; small bounded tables sort the bounded read in the query.
// - `search` (optional): trimmed, at most MAX_SEARCH_TEXT (100) characters
//   (more = `invalid_argument` field "search"), blank = no search. The UI sends
//   it on Enter only.
//   On tables with a SEARCH INDEX (devices, employees, apps) the matches come in
//   RELEVANCE order: `sort` is IGNORED while `search` is set (Convex cannot
//   order a full-text search by another field). The UI should show the sort
//   headers as inactive while a search is active and has no total for it.
//   On small bounded tables (groups, members, invites, file types) search is a
//   case-insensitive "contains" on the bounded read and `sort` still applies.
// - plus the table's own filters.
// Short pages are normal (rows that stop counting are dropped after paging):
// `isDone` alone decides whether there is a next page.
//
// Totals: a `<table>:count` query of its own (it reads only `orgStats`, so a
// counter write never re-runs a list) answers `{ total }`, or `total: null`
// when no exact counter covers the filter (any search, most filters). Small
// bounded tables return their exact `total` inside the page instead (they
// read every row anyway). Tables with neither show no total.

export const sortDir = v.union(v.literal("asc"), v.literal("desc"));
export type SortDir = Infer<typeof sortDir>;

/** The `sort` argument of every list query. */
export const sortArg = v.optional(v.object({ key: v.string(), dir: sortDir }));
export type SortInput = Infer<typeof sortArg>;

/**
 * Allowed sort keys per table, the first being the default, with what backs
 * each key (index name, or "memory" for a bounded read sorted in the query).
 */
export const LIST_SORTS = {
  devices: { created: "by_org | by_group | by_org_group", name: "by_org_name | by_org_group_name" },
  employees: { created: "by_org (group filter: groupMembers.by_group)", name: "by_org_name", username: "by_org_username" },
  apps: { created: "by_org_archived", name: "by_org_archived_name" },
  audit: { at: "by_org_at | by_org_target" },
  enrollmentCodes: { created: "by_org_created", expires: "by_org_expires" },
  installs: { updated: "by_app_state_updated | by_device_updated | by_org_state_updated" },
  groups: { name: "memory", created: "memory" },
  members: { email: "memory", role: "memory", status: "memory", created: "memory" },
  invites: { created: "memory", email: "memory", expires: "memory" },
  fileTypes: { extension: "memory", app: "memory" },
} as const satisfies Record<string, Record<string, string>>;

export type ListTable = keyof typeof LIST_SORTS;
export type SortKey<T extends ListTable> = keyof (typeof LIST_SORTS)[T] & string;

/** The table's default direction: newest first for time keys, A-Z for names. */
const DEFAULT_DIR: Record<ListTable, SortDir> = {
  devices: "desc",
  employees: "desc",
  apps: "desc",
  audit: "desc",
  enrollmentCodes: "desc",
  installs: "desc",
  groups: "asc",
  members: "asc",
  invites: "desc",
  fileTypes: "asc",
};

/** The validated sort: the table's default when omitted; an unknown key is `invalid_argument` (field "sort"). */
export function pickSort<T extends ListTable>(table: T, sort: SortInput): { key: SortKey<T>; dir: SortDir } {
  const keys = Object.keys(LIST_SORTS[table]) as SortKey<T>[];
  if (sort === undefined) return { key: keys[0]!, dir: DEFAULT_DIR[table] };
  if (!(keys as string[]).includes(sort.key)) fail("invalid_argument", { field: "sort" });
  return { key: sort.key as SortKey<T>, dir: sort.dir };
}

/** `paginationOpts.numItems`: a whole number 1..max (else `invalid_argument` field "paginationOpts"). */
export function checkPageSize(numItems: number, max: number = MAX_LIST_PAGE): void {
  if (!Number.isInteger(numItems) || numItems < 1 || numItems > max) fail("invalid_argument", { field: "paginationOpts" });
}

/** Search text: trimmed; over MAX_SEARCH_TEXT is `invalid_argument` (field "search"); blank = undefined. */
export function cleanSearch(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const t = text.trim();
  if (t.length > MAX_SEARCH_TEXT) fail("invalid_argument", { field: "search" });
  return t === "" ? undefined : t;
}

/** Case-insensitive "contains" for searches over a small bounded read. */
export function matches(needle: string | undefined, ...haystack: (string | undefined)[]): boolean {
  if (needle === undefined) return true;
  const n = needle.toLowerCase();
  return haystack.some((h) => h !== undefined && h.toLowerCase().includes(n));
}

/** A comparator for one field, in `dir` order, ties broken by `_id` so pages are stable. */
export function byField<R extends { _id: string }>(get: (r: R) => string | number, dir: SortDir): (a: R, b: R) => number {
  const sign = dir === "asc" ? 1 : -1;
  return (a, b) => {
    const x = get(a);
    const y = get(b);
    const c = typeof x === "string" && typeof y === "string" ? x.localeCompare(y) : x < y ? -1 : x > y ? 1 : 0;
    return c !== 0 ? sign * c : sign * (a._id < b._id ? -1 : a._id > b._id ? 1 : 0);
  };
}

/** The caller's counter row, the ONLY read of a `<table>:count` query (null before migration). */
export async function orgStatsRow(ctx: { db: DatabaseReader; orgId: Id<"organizations"> }): Promise<Doc<"orgStats"> | null> {
  return await ctx.db
    .query("orgStats")
    .withIndex("by_org", (q) => q.eq("orgId", ctx.orgId))
    .unique();
}

/** The `returns` of a `<table>:count` query. */
export const countResult = v.object({ total: v.union(v.number(), v.null()) });

/** The `returns` of a bounded in-memory list: a page plus its exact `total`. */
export function boundedPageValidator<R extends GenericValidator>(row: R) {
  return v.object({ page: v.array(row), isDone: v.boolean(), continueCursor: v.string(), total: v.number() });
}

/** Offset cursor of a bounded in-memory list: "o:<n>". */
const OFFSET_CURSOR = /^o:(\d{1,6})$/;

/**
 * One page of rows that were read in full (a SMALL bounded table) and already
 * sorted and filtered in the query. The cursor is an offset ("o:<n>"); any
 * other cursor is `invalid_argument`. `total` = every matching row.
 */
export function pageInMemory<R>(rows: R[], opts: PaginationOptions): PaginationResult<R> & { total: number } {
  let start = 0;
  if (opts.cursor !== null) {
    const m = OFFSET_CURSOR.exec(opts.cursor);
    if (m === null) fail("invalid_argument", { field: "paginationOpts" });
    start = Math.min(Number(m[1]), rows.length);
  }
  const end = Math.min(start + opts.numItems, rows.length);
  return { page: rows.slice(start, end), isDone: end >= rows.length, continueCursor: `o:${end}`, total: rows.length };
}
