import type { DeviceFilter, DeviceInstallRow, DeviceRow, Id, PagedState } from "../types";

/**
 * The paginated device lists (plan Step 7). A seam of their own, like
 * `../enrollment`: the live lists need Convex's `usePaginatedQuery`, which must
 * not reach the first load (sign-in). Only the lazy device and group screens
 * import `data/devices`.
 */
export interface DevicesApi {
  /**
   * `fleet:list({ groupId?, search? })`, paginated (50), newest first, or the
   * search index's best matches (`search` at most 100 characters). `groupId`
   * must be a real group id: the server cannot list ungrouped devices.
   */
  useDevicesScreen: (filter: DeviceFilter) => PagedState<DeviceRow>;
  /** `fleet:installs` (Step 17): paginated install results of one PC. */
  useDeviceInstalls: (deviceId: Id) => PagedState<DeviceInstallRow>;
}
