import type { EmployeeRow, Id, PagedState } from "../types";

/**
 * The paginated employee list (plan Step 11). A seam of their own, like
 * `../devices` and `../apps`: the live list needs Convex's `usePaginatedQuery`,
 * which must not reach the first load (sign-in). Only the lazy Employees and
 * Group detail screens import `data/employees`.
 */
export interface EmployeesApi {
  /**
   * `employees:list({ groupId? })`, paginated (50), newest first; with `search`
   * the best matches of `employees:search` (at most 50, `searchCapped` when
   * there were more). Text that is empty after trimming (the group page's
   * "add" dialog before anything is typed) subscribes to nothing and shows no
   * rows.
   */
  useEmployeesScreen: (filter: { groupId?: Id; search?: string }) => PagedState<EmployeeRow> & { searchCapped?: boolean };
}
