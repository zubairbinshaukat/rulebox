/**
 * Live app lists (plan Step 10, Phase 4b; `convex/apps.ts`, `convex/fileHandlers.ts`). One page per
 * subscription (`useServerPage`: a plain query with `paginationOpts`, never `usePaginatedQuery`), so only
 * the visible page is subscribed. The apps total is `apps:count`, a separate small query.
 */
import { api } from "@convex/_generated/api";
import { useServerCount, useServerPage } from "../live/serverList";
import { listArgs, type ListQuery } from "../serverList";
import type { AppInstallRow, AppRow, FileTypeRow } from "../types";
import type { AppsApi } from "./api";

export const liveAppsApi: AppsApi = {
  useAppsScreen({ archived, ...query }) {
    // A search is answered by the search index in relevance order: the server ignores `sort`, so none is sent.
    const q: ListQuery = query.search?.trim() ? { ...query, sort: undefined } : query;
    return useServerPage<AppRow>(api.apps.list, { archived, ...listArgs(q) }, `apps:${archived}`);
  },
  useAppsCount({ archived, search }) {
    const text = search?.trim();
    return useServerCount(api.apps.count, { archived, ...(text ? { search: text } : {}) });
  },
  useAppInstalls(appId, state, query) {
    // `apps:installs` sorts by "updated" only and has no search.
    const args = { appId, state, paginationOpts: listArgs(query).paginationOpts, sort: { key: "updated", dir: query.sort?.dir ?? "desc" } };
    // Another app or state is another list: its rows must not show the previous ones while the first page loads.
    return useServerPage<AppInstallRow>(api.apps.installs, args, `${appId}:${state}`);
  },
  useFileTypesPage(query) {
    return useServerPage<FileTypeRow>(api.fileHandlers.page, listArgs(query), "fileTypes");
  },
};

/** Resolved through the `@rulebox/apps-impl` alias in live builds. */
export const appsApi = liveAppsApi;
