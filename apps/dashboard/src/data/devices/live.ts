/**
 * Live device lists (plan Step 7, `convex/fleet.ts`). Paginated, so they are
 * a seam of their own: `usePaginatedQuery` must stay out of the first load.
 */
import { useConvexAuth, usePaginatedQuery, type UsePaginatedQueryResult } from "convex/react";
import { useMemo } from "react";
import { api } from "@convex/_generated/api";
import { deviceRowOf } from "../live/devices";
import { usePagedState } from "../live/convex";
import { PAGE_SIZE, type DeviceInstallRow, type DeviceRow } from "../types";
import type { DevicesApi } from "./api";

export const liveDevicesApi: DevicesApi = {
  useDevicesScreen({ groupId, search }) {
    const { isAuthenticated } = useConvexAuth();
    // `fleet:list` does the name search itself (the search index, same pages); only defined arguments are sent.
    const args = useMemo(() => ({ ...(groupId ? { groupId } : {}), ...(search ? { search } : {}) }), [groupId, search]);
    const r = usePaginatedQuery(api.fleet.list, isAuthenticated ? args : "skip", { initialNumItems: PAGE_SIZE });
    const results = useMemo(() => r.results.map(deviceRowOf), [r.results]);
    return usePagedState({ ...r, results } as UsePaginatedQueryResult<DeviceRow>, PAGE_SIZE);
  },
  useDeviceInstalls(deviceId) {
    const { isAuthenticated } = useConvexAuth();
    const r = usePaginatedQuery(api.fleet.installs, isAuthenticated ? { deviceId } : "skip", { initialNumItems: PAGE_SIZE });
    return usePagedState(r as UsePaginatedQueryResult<DeviceInstallRow>, PAGE_SIZE);
  },
};

/** Resolved through the `@rulebox/devices-impl` alias in live builds. */
export const devicesApi = liveDevicesApi;
