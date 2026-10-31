/**
 * Employees from `convex/employees.ts` as the screens' types. Pure functions
 * (no Convex React imports), used by `live/hooks.ts`.
 */
import type { FunctionReturnType } from "convex/server";
import type { api } from "@convex/_generated/api";
import type { EmployeeDetail } from "../types";

type GetResult = FunctionReturnType<typeof api.employees.get>;
type OptionsResult = FunctionReturnType<typeof api.employees.options>;

/**
 * `employees:get` as the form's `EmployeeDetail`. The server sends the lockout
 * row as it is; it counts only while `lockedUntil` is in the future (the
 * banner is computed when the data arrives, so it can outlive the lock by
 * until the next change of the employee).
 */
export function employeeDetailOf(r: GetResult, now = Date.now()): EmployeeDetail {
  const { lockout, ...rest } = r;
  return { ...rest, lockout: lockout !== null && lockout.lockedUntil > now ? lockout : null };
}

/** The blank form of `/employees/new`: the server only supplies the pickers and the default quota (`employees:options`). */
export function newEmployeeOf(o: OptionsResult): EmployeeDetail {
  return {
    _id: "new",
    name: "",
    username: "",
    disabled: false,
    revision: 0,
    passwordSet: false,
    createdAt: 0,
    groupIds: [],
    appIds: [],
    lockout: null,
    ...o,
  };
}
