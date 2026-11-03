import type { ListQuery, ServerList } from "../serverList";
import type { AppInstallRow, AppRow, FileTypeRow, Id, InstallState } from "../types";

/**
 * The server-driven app lists (plan Step 10, Phase 4b). A seam of their own, like
 * `../devices`: only the lazy Apps, App and File types screens import `data/apps`.
 * Each hook answers ONE page (a cursor stack lives in the screen, `useListPaging`).
 */
export interface AppsApi {
  /**
   * `apps:list`: sort keys `created` (default, newest first) and `name`; a `search` (name words, relevance
   * order) ignores `sort` on the server. `archived` is the tab.
   */
  useAppsScreen: (query: ListQuery & { archived: boolean }) => ServerList<AppRow>;
  /** `apps:count`: the total of the active tab; `null` for the archived tab or a search, `undefined` while it loads. */
  useAppsCount: (filter: { archived: boolean; search?: string }) => number | null | undefined;
  /** `apps:installs`: install results of one app in one state, sort key `updated` only, no total. */
  useAppInstalls: (appId: Id, state: InstallState, query: ListQuery) => ServerList<AppInstallRow>;
  /**
   * `fileHandlers:page`: a bounded list with its exact `total` inline and offset cursors. Sort keys `extension`
   * (default) and `app`; the search is a contains match on extension and program name.
   */
  useFileTypesPage: (query: ListQuery) => ServerList<FileTypeRow>;
}
