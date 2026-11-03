/**
 * Live employee list (plan Step 11, Phase 4b; `convex/employees.ts`). One page per
 * subscription (`useServerPage`), the total from `employees:count` (a separate small
 * query). `employees:search` stays for the group page's bounded picker.
 */
import { api } from "@convex/_generated/api";
import { useMemberQuery } from "../live/convex";
import { useServerCount, useServerPage } from "../live/serverList";
import { listArgs } from "../serverList";
import type { EmployeeRow, QueryState } from "../types";
import type { EmployeesApi } from "./api";

const NO_PICK: QueryState<{ rows: EmployeeRow[]; capped: boolean }> = { status: "ready", data: { rows: [], capped: false } };

export const liveEmployeesApi: EmployeesApi = {
  useEmployeesCount({ groupId, search }) {
    const text = search?.trim();
    return useServerCount(api.employees.count, { ...(groupId ? { groupId } : {}), ...(text ? { search: text } : {}) });
  },
  useEmployeesScreen({ groupId, ...query }) {
    // The server ignores `sort` for a search, and with a group filter only knows "created" (= added to the group).
    const searching = Boolean(query.search?.trim());
    const sort = searching ? undefined : groupId && query.sort ? { key: "created", dir: query.sort.dir } : query.sort;
    const args = { ...listArgs({ ...query, sort }), ...(groupId ? { groupId } : {}) };
    return useServerPage<EmployeeRow>(api.employees.list, args, groupId ?? "");
  },
  useEmployeePicker(text) {
    const t = text.trim();
    const found = useMemberQuery(api.employees.search, t ? { text: t } : "skip");
    return t ? found : NO_PICK;
  },
};

/** Resolved through the `@rulebox/employees-impl` alias in live builds. */
export const employeesApi = liveEmployeesApi;
