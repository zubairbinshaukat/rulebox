/**
 * Audit list hooks. Like `../index.ts`, the implementation is picked at build
 * time: `vite.config.ts` points `@rulebox/audit-impl` at `demo.ts`
 * (VITE_DEMO=1) or `live.ts`. Imported only by lazy screens.
 */
import { auditApi } from "@rulebox/audit-impl";
import type { AuditApi } from "./api";

const api: AuditApi = auditApi;

export const { useAuditScreen, useHistory } = api;
