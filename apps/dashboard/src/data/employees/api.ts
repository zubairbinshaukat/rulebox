import type { ListQuery, ServerList } from "../serverList";
import type { EmployeeRow, QueryState } from "../types";

export interface EmployeesFilter {
  groupId?: string;
  search?: string;
}

/**
 * The server-driven employee list (plan Step 11, Phase 4b). A seam of its own, like
 * `../devices`: only the lazy Employees and Group detail screens import `data/employees`.
 */
export interface EmployeesApi {
  /** `employees:count` (`employeeCount` from `orgStats`): `null` with a group filter or a search, `undefined` while it loads. */
  useEmployeesCount: (filter: EmployeesFilter) => number | null | undefined;
  /**
   * `employees:list`, one page. Sort keys: `created` (newest first, the default), `name`, `username`; with a
   * `groupId` only `created` (= added to the group). A `search` (name or username words) makes the server ignore
   * `sort`; with a group filter the page may be short (non-members are dropped after paging).
   */
  useEmployeesScreen: (query: ListQuery & { groupId?: string }) => ServerList<EmployeeRow>;
  /**
   * `employees:search`, the bounded picker form (best matches, `capped` = there may be more): the group page's
   * "Add employee" dialog. Blank text subscribes to nothing and shows no rows.
   */
  useEmployeePicker: (text: string) => QueryState<{ rows: EmployeeRow[]; capped: boolean }>;
}
