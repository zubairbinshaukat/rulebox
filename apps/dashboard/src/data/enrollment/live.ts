/**
 * Live enrollment-code hooks (plan Step 6, `convex/enrollmentCodes.ts`).
 * `create` is an action that returns the code once (and the row id); `revoke` is a major
 * action (fresh step-up, retried once through `useMapped`). `progress` is the one query
 * the "Add a PC" wizard subscribes to, only while step 2 or 3 is on screen.
 */
import { useAction, useMutation } from "convex/react";
import { useCallback } from "react";
import { api } from "@convex/_generated/api";
import type { FunctionReturnType } from "convex/server";
import { useMapped, useMappedState, useMemberQuery } from "../live/convex";
import { kioskPhaseOf } from "../live/devices";
import { useServerPage } from "../live/serverList";
import { listArgs } from "../serverList";
import type { EnrollmentCodeRow, EnrollmentProgress } from "../types";
import type { EnrollmentApi } from "./api";

type ProgressResult = FunctionReturnType<typeof api.enrollmentCodes.progress>;

/** The agent reports the kiosk phase as free text: a value we do not know shows as "unknown" (see `kioskPhaseOf`). */
function progressOf(d: ProgressResult): EnrollmentProgress {
  return {
    ...(d.label === undefined ? {} : { label: d.label }),
    ...(d.groupId === undefined ? {} : { groupId: d.groupId }),
    ...(d.groupName === undefined ? {} : { groupName: d.groupName }),
    usesTotal: d.usesTotal,
    usesLeft: d.usesLeft,
    expiresAt: d.expiresAt,
    revoked: d.revoked,
    joined: d.joined,
    pcs: d.pcs.map((p) => {
      const kioskPhase = kioskPhaseOf(p.kioskPhase);
      return { _id: p._id, name: p.name, enrolledAt: p.enrolledAt, online: p.online, ...(kioskPhase === undefined ? {} : { kioskPhase }) };
    }),
    download: d.download,
  };
}

export const liveEnrollmentApi: EnrollmentApi = {
  useEnrollmentScreen(nowMinute, query) {
    // No search on this table. `nowMs` is the minute, so the subscription changes at most once a minute.
    return useServerPage<EnrollmentCodeRow>(api.enrollmentCodes.list, { nowMs: nowMinute, ...listArgs({ ...query, search: undefined }) }, "enrollment");
  },
  useCreateEnrollmentCode() {
    return useMapped(useAction(api.enrollmentCodes.create));
  },
  useRevokeEnrollmentCode() {
    const revoke = useMutation(api.enrollmentCodes.revoke);
    const call = useCallback(
      async (a: { tokenId: string }) => {
        await revoke(a);
      },
      [revoke],
    );
    return useMapped(call);
  },
  useEnrollmentProgress(tokenId) {
    // `null` = "skip": no subscription, state `loading`. The query takes no clock, so it re-runs only when the code, one of its PCs'
    // presence / summary rows or the organization row changes (convex/ioBudgets.ts).
    return useMappedState(useMemberQuery(api.enrollmentCodes.progress, tokenId === null ? "skip" : { tokenId }), progressOf);
  },
};

/** Resolved through the `@rulebox/enrollment-impl` alias in live builds. */
export const enrollmentApi = liveEnrollmentApi;
