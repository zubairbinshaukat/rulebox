/**
 * Live app lists (plan Step 10, `convex/apps.ts`). Paginated, so they are a
 * seam of their own: `usePaginatedQuery` must stay out of the first load.
 */
import { useConvexAuth, usePaginatedQuery, type UsePaginatedQueryResult } from "convex/react";
import { api } from "@convex/_generated/api";
import { usePagedState } from "../live/convex";
import { PAGE_SIZE, type AppInstallRow, type AppRow } from "../types";
import type { AppsApi } from "./api";

export const liveAppsApi: AppsApi = {
  useAppsScreen({ archived }) {
    const { isAuthenticated } = useConvexAuth();
    const r = usePaginatedQuery(api.apps.list, isAuthenticated ? { archived } : "skip", { initialNumItems: PAGE_SIZE });
    return usePagedState(r as UsePaginatedQueryResult<AppRow>, PAGE_SIZE);
  },
  useAppInstalls(appId, state) {
    const { isAuthenticated } = useConvexAuth();
    const r = usePaginatedQuery(api.apps.installs, isAuthenticated ? { appId, state } : "skip", { initialNumItems: PAGE_SIZE });
    // Another app or state is another list: its rows must not show the previous ones while the first page loads.
    return usePagedState(r as UsePaginatedQueryResult<AppInstallRow>, PAGE_SIZE, `${appId}:${state}`);
  },
};

/** Resolved through the `@rulebox/apps-impl` alias in live builds. */
export const appsApi = liveAppsApi;
