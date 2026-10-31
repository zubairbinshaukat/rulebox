/**
 * Live employee list (plan Step 11, `convex/employees.ts`). Paginated, so it is
 * a seam of its own: `usePaginatedQuery` must stay out of the first load.
 *
 * Two server queries behind one hook: `employees:list` (a page of 50, optionally
 * one group's members) while the search box is empty, `employees:search` (the
 * best 50, optionally within the group) while it has text. Only one of them is
 * subscribed at a time; the other gets `"skip"`.
 */
import { useConvexAuth, usePaginatedQuery, type UsePaginatedQueryResult } from "convex/react";
import { api } from "@convex/_generated/api";
import { useMemberQuery, usePagedState } from "../live/convex";
import { PAGE_SIZE, type EmployeeRow, type PagedState } from "../types";
import type { EmployeesApi } from "./api";

const READY_EMPTY: PagedState<EmployeeRow> = { status: "ready", items: [], canLoadMore: false, isLoadingMore: false, loadMore: () => undefined };

export const liveEmployeesApi: EmployeesApi = {
  useEmployeesScreen({ groupId, search }) {
    const { isAuthenticated } = useConvexAuth();
    const text = search?.trim();
    const searching = text !== undefined && text !== "";
    // Asked to search for nothing: no subscription at all.
    const idle = search !== undefined && !searching;
    const list = usePaginatedQuery(api.employees.list, isAuthenticated && !searching && !idle ? { groupId } : "skip", { initialNumItems: PAGE_SIZE });
    const listed = usePagedState(list as UsePaginatedQueryResult<EmployeeRow>, PAGE_SIZE);
    const found = useMemberQuery(api.employees.search, searching ? { text, groupId } : "skip");
    if (idle) return READY_EMPTY;
    if (!searching) return listed;
    if (found.status === "loading") return { status: "loading" };
    if (found.status === "error") return found;
    return { status: "ready", items: found.data.rows, canLoadMore: false, isLoadingMore: false, loadMore: () => undefined, searchCapped: found.data.capped };
  },
};

/** Resolved through the `@rulebox/employees-impl` alias in live builds. */
export const employeesApi = liveEmployeesApi;
