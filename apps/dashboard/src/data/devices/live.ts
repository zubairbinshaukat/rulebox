/**
 * Live device lists (plan Step 7, Phase 4b; `convex/fleet.ts`). One page per
 * subscription (`useServerPage`: a plain query with `paginationOpts`, never
 * `usePaginatedQuery`), so only the visible page is subscribed. The total is
 * `fleet:count`, a separate small query that reads `orgStats` only.
 */
import { api } from "@convex/_generated/api";
import { useMemberQuery } from "../live/convex";
import { useServerCount, useServerPage } from "../live/serverList";
import { useMappedList } from "../live/mapList";
import { deviceRowOf } from "../live/devices";
import { listArgs, type ListQuery } from "../serverList";
import type { DeviceInstallRow } from "../types";
import type { DevicesApi } from "./api";

/** While a search is set the server ignores `sort` (relevance order): none is sent. */
const searched = (q: ListQuery): ListQuery => (q.search?.trim() ? { ...q, sort: undefined } : q);

export const liveDevicesApi: DevicesApi = {
  useDevicesCount({ groupId, search }) {
    const text = search?.trim();
    return useServerCount(api.fleet.count, { ...(groupId ? { groupId } : {}), ...(text ? { search: text } : {}) });
  },
  useDevicesScreen({ groupId, ...query }) {
    const args = { ...listArgs(searched(query)), ...(groupId ? { groupId } : {}) };
    const page = useServerPage<Parameters<typeof deviceRowOf>[0]>(api.fleet.list, args, groupId ?? "");
    return useMappedList(page, deviceRowOf);
  },
  useDeviceInstalls(deviceId, query) {
    // `fleet:installs` sorts by "updated" only, and has no search.
    const args = { deviceId, paginationOpts: listArgs(query).paginationOpts, sort: { key: "updated", dir: query.sort?.dir ?? "desc" } };
    return useServerPage<DeviceInstallRow>(api.fleet.installs, args, deviceId);
  },
  // The device page's per-tab queries: each is subscribed only while its tab is open (the screen mounts the hook then).
  useDeviceSettingsOptions(deviceId) {
    return useMemberQuery(api.fleet.deviceSettings, { deviceId });
  },
  // `enabled: false` subscribes to nothing (the disclosure is closed).
  useDeviceVersions(deviceId, enabled) {
    return useMemberQuery(api.fleet.versions, enabled ? { deviceId } : "skip");
  },
  useDeviceNetwork(deviceId) {
    return useMemberQuery(api.fleet.network, { deviceId });
  },
};

/** Resolved through the `@rulebox/devices-impl` alias in live builds. */
export const devicesApi = liveDevicesApi;
