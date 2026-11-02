/**
 * Live audit lists (plan Step 17, `convex/audit.ts`). Paginated, so they are a
 * seam of their own: `usePaginatedQuery` must stay out of the first load.
 */
import { useConvexAuth, usePaginatedQuery, type UsePaginatedQueryResult } from "convex/react";
import { api } from "@convex/_generated/api";
import { usePagedState } from "../live/convex";
import { PAGE_SIZE, type AuditEntry } from "../types";
import type { AuditApi } from "./api";

/** A history panel opens on 10 rows and adds 10 per click: a detail page should not read 50 audit rows. */
const HISTORY_PAGE = 10;

export const liveAuditApi: AuditApi = {
  useAuditScreen() {
    const { isAuthenticated } = useConvexAuth();
    const r = usePaginatedQuery(api.audit.list, isAuthenticated ? {} : "skip", { initialNumItems: PAGE_SIZE });
    return usePagedState(r as UsePaginatedQueryResult<AuditEntry>, PAGE_SIZE);
  },
  useHistory(targetId) {
    const { isAuthenticated } = useConvexAuth();
    const r = usePaginatedQuery(api.audit.forTarget, isAuthenticated ? { targetId } : "skip", { initialNumItems: HISTORY_PAGE });
    return usePagedState(r as UsePaginatedQueryResult<AuditEntry>, HISTORY_PAGE, targetId);
  },
};

/** Resolved through the `@rulebox/audit-impl` alias in live builds. */
export const auditApi = liveAuditApi;
