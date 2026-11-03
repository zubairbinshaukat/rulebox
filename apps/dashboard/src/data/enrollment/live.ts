/**
 * Live enrollment-code hooks (plan Step 6, `convex/enrollmentCodes.ts`).
 * `create` is an action that returns the code once; `revoke` is a major
 * action (fresh step-up, retried once through `useMapped`).
 */
import { useAction, useMutation } from "convex/react";
import { useCallback } from "react";
import { api } from "@convex/_generated/api";
import { useMapped } from "../live/convex";
import { useServerPage } from "../live/serverList";
import { listArgs } from "../serverList";
import type { EnrollmentCodeRow } from "../types";
import type { EnrollmentApi } from "./api";

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
};

/** Resolved through the `@rulebox/enrollment-impl` alias in live builds. */
export const enrollmentApi = liveEnrollmentApi;
