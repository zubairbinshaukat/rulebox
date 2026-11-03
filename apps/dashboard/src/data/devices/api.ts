import type { ListQuery, ServerList } from "../serverList";
import type { DeviceInstallRow, DeviceRow, Id } from "../types";

/** The filter of `fleet:list` / `fleet:count`: a real group id or "none" (PCs without a group). */
export interface DevicesFilter {
  groupId?: string;
  search?: string;
}

/**
 * The server-driven device lists (plan Step 7, Phase 4b). A seam of their own, like
 * `../enrollment`: only the lazy device and group screens import `data/devices`.
 * Each hook answers ONE page (the pager keeps the cursors), never an accumulating list.
 */
export interface DevicesApi {
  /**
   * `fleet:count`, a query of its own that reads `orgStats` only: all PCs, or the PCs without a
   * group. `null` for one group or any search (no exact counter), `undefined` while it loads.
   */
  useDevicesCount: (filter: DevicesFilter) => number | null | undefined;
  /**
   * `fleet:list`, one page. Sort keys: `created` (newest first, the default) and `name`. A `search`
   * (best matches by name) makes the server ignore `sort` (relevance order); the hook then sends none.
   */
  useDevicesScreen: (query: ListQuery & { groupId?: string }) => ServerList<DeviceRow>;
  /** `fleet:installs`: install results of one PC, sort key `updated` only, no total. */
  useDeviceInstalls: (deviceId: Id, query: ListQuery) => ServerList<DeviceInstallRow>;
}
