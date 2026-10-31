import type { AppInstallRow, AppRow, Id, InstallState, PagedState } from "../types";

/**
 * The paginated app lists (plan Step 10). A seam of their own, like
 * `../devices` and `../enrollment`: the live lists need Convex's
 * `usePaginatedQuery`, which must not reach the first load (sign-in). Only the
 * lazy Apps and App screens import `data/apps`.
 */
export interface AppsApi {
  /** `apps:list({ archived })`, paginated (50), newest first. */
  useAppsScreen: (filter: { archived: boolean }) => PagedState<AppRow>;
  /** `apps:installs` (Step 17): paginated install results of one app in one state. */
  useAppInstalls: (appId: Id, state: InstallState) => PagedState<AppInstallRow>;
}
