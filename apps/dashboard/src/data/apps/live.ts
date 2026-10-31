/**
 * Live app lists (plan Step 10, `convex/apps.ts`). Paginated, so they are a
 * seam of their own: `usePaginatedQuery` must stay out of the first load.
 */
import { useConvexAuth, usePaginatedQuery, type UsePaginatedQueryResult } from "convex/react";
import { api } from "@convex/_generated/api";
import { AppError } from "../../lib/errors";
import { NOT_DEPLOYED } from "../api";
import { usePagedState } from "../live/convex";
import { PAGE_SIZE, type AppRow } from "../types";
import type { AppsApi } from "./api";

export const liveAppsApi: AppsApi = {
  useAppsScreen({ archived }) {
    const { isAuthenticated } = useConvexAuth();
    const r = usePaginatedQuery(api.apps.list, isAuthenticated ? { archived } : "skip", { initialNumItems: PAGE_SIZE });
    return usePagedState(r as UsePaginatedQueryResult<AppRow>, PAGE_SIZE);
  },
  // Install results arrive with Step 17 (`apps:installs`); until then the card says so.
  useAppInstalls() {
    return { status: "error", error: new AppError({ code: "not_ready", detail: NOT_DEPLOYED }), retry: () => undefined };
  },
};

/** Resolved through the `@rulebox/apps-impl` alias in live builds. */
export const appsApi = liveAppsApi;
