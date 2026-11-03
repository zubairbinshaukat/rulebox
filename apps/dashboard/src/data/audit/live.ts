/**
 * Live audit lists (plan Step 17, Phase 4b; `convex/audit.ts`). One page per subscription
 * (`useServerPage`: a plain query with `paginationOpts`, never `usePaginatedQuery`).
 */
import { api } from "@convex/_generated/api";
import { useServerPage } from "../live/serverList";
import { listArgs, type ListQuery } from "../serverList";
import type { AuditEntry } from "../types";
import type { AuditApi } from "./api";

/** The only sort key of the audit log is "at"; whatever the person picked, that is what is sent. */
const byTime = (q: ListQuery): ListQuery => ({ ...q, sort: { key: "at", dir: q.sort?.dir ?? "desc" }, search: undefined });

export const liveAuditApi: AuditApi = {
  useAuditScreen(query) {
    return useServerPage<AuditEntry>(api.audit.list, listArgs(byTime(query)), "audit");
  },
  useHistory(targetId, query) {
    return useServerPage<AuditEntry>(api.audit.forTarget, { targetId, ...listArgs(byTime(query)) }, `history:${targetId}`);
  },
};

/** Resolved through the `@rulebox/audit-impl` alias in live builds. */
export const auditApi = liveAuditApi;
