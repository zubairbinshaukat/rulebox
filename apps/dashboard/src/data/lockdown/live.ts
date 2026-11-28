/**
 * Live lockdown hooks (Phase 5 Step 19, `convex/lockdown.ts`, `fleet:allowUsb`). The device page's lockdown fields come with
 * `fleet:page` (`useDevicePage`), not from here.
 * `lockdown:update` is major only for a mode change: `useMapped` opens the step-up dialog when the server asks.
 */
import { useMutation } from "convex/react";
import { useCallback } from "react";
import { api } from "@convex/_generated/api";
import { useMapped, useMemberQuery } from "../live/convex";
import { useServerPage } from "../live/serverList";
import { listArgs } from "../serverList";
import type { FindingRow } from "../types";
import type { LockdownApi } from "./api";

export const liveLockdownApi: LockdownApi = {
  useLockdownView(groupId) {
    return useMemberQuery(api.lockdown.groupView, { groupId });
  },
  useLockdownSync(groupId) {
    return useMemberQuery(api.lockdown.groupSync, { groupId });
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
  useAllowUsb() {
    return useMapped(useMutation(api.fleet.allowUsb));
  },
};

/** Resolved through the `@rulebox/lockdown-impl` alias in live builds. */
export const lockdownApi = liveLockdownApi;
