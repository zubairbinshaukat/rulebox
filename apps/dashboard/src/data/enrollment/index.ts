/**
 * Enrollment-code hooks. Like `../index.ts`, the implementation is picked at
 * build time: `vite.config.ts` points `@rulebox/enrollment-impl` at `demo.ts`
 * (VITE_DEMO=1) or `live.ts`. Imported only by the (lazy) Enrollment screen.
 */
import { enrollmentApi } from "@rulebox/enrollment-impl";
import type { EnrollmentApi } from "./api";

const api: EnrollmentApi = enrollmentApi;

export const { useEnrollmentScreen, useCreateEnrollmentCode, useRevokeEnrollmentCode } = api;
