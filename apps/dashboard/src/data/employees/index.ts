/**
 * Employee list hook. Like `../index.ts`, the implementation is picked at build
 * time: `vite.config.ts` points `@rulebox/employees-impl` at `demo.ts`
 * (VITE_DEMO=1) or `live.ts`. Imported only by lazy screens.
 */
import { employeesApi } from "@rulebox/employees-impl";
import type { EmployeesApi } from "./api";

const api: EmployeesApi = employeesApi;

export const { useEmployeesCount, useEmployeesScreen, useEmployeePicker } = api;
