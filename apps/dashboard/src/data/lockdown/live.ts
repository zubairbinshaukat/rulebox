/**
 * Live lockdown hooks (Phase 5 Step 19, `convex/lockdown.ts`, `fleet:allowUsb`, the lockdown part of `fleet:get`).
 * `lockdown:update` is major only for a mode change: `useMapped` opens the step-up dialog when the server asks.
 */
import { useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useCallback } from "react";
import { api } from "@convex/_generated/api";
import { useMapped, useMappedState, useMemberQuery } from "../live/convex";
import { useServerPage } from "../live/serverList";
import { listArgs } from "../serverList";
import type { DeviceLockdown, FindingRow } from "../types";
import type { LockdownApi } from "./api";

type FleetGet = FunctionReturnType<typeof api.fleet.get>;

/** The lockdown fields of `fleet:get`; an older server (rolling deploy) has none of them. */
export function deviceLockdownOf(d: FleetGet): DeviceLockdown {
  return {
    ring: d.ring ?? "everyone",
    groupId: d.group?._id ?? null,
    rolloutRevision: d.rolloutRevision ?? 0,
    revoked: d.flags.revoked,
    usbAllowUntil: d.usbAllowUntil ?? null,
    protection: d.protection ?? null,
    lockdownCapable: d.lockdownCapable ?? null,
    apply: d.apply ?? null,
  };
}

export const liveLockdownApi: LockdownApi = {
  useLockdownView(groupId) {
    return useMemberQuery(api.lockdown.groupView, { groupId });
  },
  useSaveLockdown() {
    return useMapped(useMutation(api.lockdown.update));
  },
  useFindingsPage({ status, ...query }) {
    const { paginationOpts } = listArgs(query);
    return useServerPage<FindingRow>(api.lockdown.findings, { status, paginationOpts, sort: { key: "seen", dir: query.sort?.dir ?? "desc" } }, `findings:${status}`);
  },
  useAllowOptions() {
    return useMemberQuery(api.lockdown.allowOptions, {});
  },
  useAllowFinding() {
    return useMapped(useMutation(api.lockdown.allow));
  },
  useIgnoreFinding() {
    const ignore = useMutation(api.lockdown.ignore);
    const call = useCallback(
      async (a: { findingId: string }) => {
        await ignore(a);
      },
      [ignore],
    );
    return useMapped(call);
  },
  useRemoveException() {
    const remove = useMutation(api.lockdown.removeException);
    const call = useCallback(
      async (a: { exceptionId: string }) => {
        await remove(a);
      },
      [remove],
    );
    return useMapped(call);
  },
  // The same query and arguments as the device page (`useDeviceDetail`): one subscription on the server.
  useDeviceLockdown(deviceId) {
    return useMappedState(useMemberQuery(api.fleet.get, { deviceId }), deviceLockdownOf);
  },
  useAllowUsb() {
    return useMapped(useMutation(api.fleet.allowUsb));
  },
};

/** Resolved through the `@rulebox/lockdown-impl` alias in live builds. */
export const lockdownApi = liveLockdownApi;
