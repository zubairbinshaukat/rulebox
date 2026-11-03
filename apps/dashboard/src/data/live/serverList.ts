/**
 * Live adapters for the server-driven lists (Phase 4b): ONE subscription to the
 * page being shown (`paginationOpts: { numItems, cursor }`), never
 * `usePaginatedQuery`, which accumulates pages. The cursor stack lives in the
 * screen (`useCursorPager`). Used by the list seams (`apps/`, `audit/`,
 * `enrollment/`, `members/`).
 */
import type { FunctionArgs, FunctionReference } from "convex/server";
import { useKeepPrevious, toServerList, type PageResult, type ServerList } from "../serverList";
import type { QueryState } from "../types";
import { useMemberQuery } from "./convex";

/** One page of a list query. `identity` names what the list is about (see `useKeepPrevious`). */
export function useServerPage<T, Q extends FunctionReference<"query"> = FunctionReference<"query">>(
  query: Q,
  args: FunctionArgs<Q> | "skip",
  identity: string,
): ServerList<T> {
  const state = useMemberQuery(query, args) as unknown as QueryState<PageResult<T>>;
  return useKeepPrevious(toServerList(state), identity);
}

/**
 * A `<table>:count` query: the total, `null` when no exact counter covers the filter, `undefined` while it
 * loads. An error counts as "no total" (the pager then shows Previous / Next and "Page N" only).
 */
export function useServerCount<Q extends FunctionReference<"query">>(query: Q, args: FunctionArgs<Q> | "skip"): number | null | undefined {
  const state = useMemberQuery(query, args) as unknown as QueryState<{ total: number | null }>;
  if (state.status === "error") return null;
  return state.status === "ready" ? state.data.total : undefined;
}
