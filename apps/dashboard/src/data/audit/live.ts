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
  // `since` is sent only when set; with a `targetId` the screen reads `audit:forTarget` (the same pages, one target's rows).
  useAuditScreen({ since, targetId, ...query }) {
    const args = { ...listArgs(byTime(query)), ...(since === undefined ? {} : { since }) };
    // Both hooks run on every render (rules of hooks); the one that is not wanted is skipped and subscribes to nothing.
    const all = useServerPage<AuditEntry>(api.audit.list, targetId === undefined ? args : "skip", "audit");
    const one = useServerPage<AuditEntry>(api.audit.forTarget, targetId === undefined ? "skip" : { targetId, ...args }, `audit:${targetId ?? ""}`);
    return targetId === undefined ? all : one;
  },
  useHistory(targetId, query) {
    return useServerPage<AuditEntry>(api.audit.forTarget, { targetId, ...listArgs(byTime(query)) }, `history:${targetId}`);
  },
};

/** Resolved through the `@rulebox/audit-impl` alias in live builds. */
export const auditApi = liveAuditApi;
