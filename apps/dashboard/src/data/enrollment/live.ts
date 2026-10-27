/**
 * Live enrollment-code hooks (plan Step 6, `convex/enrollmentCodes.ts`).
 * `create` is an action that returns the code once; `revoke` is a major
 * action (fresh step-up, retried once through `useMapped`).
 */
import { useAction, useConvexAuth, useMutation, usePaginatedQuery } from "convex/react";
import { useCallback } from "react";
import { api } from "@convex/_generated/api";
import { useMapped, usePagedState } from "../live/convex";
import { PAGE_SIZE } from "../types";
import type { EnrollmentApi } from "./api";

export const liveEnrollmentApi: EnrollmentApi = {
  useEnrollmentScreen(nowMinute) {
    const { isAuthenticated } = useConvexAuth();
    const r = usePaginatedQuery(api.enrollmentCodes.list, isAuthenticated ? { nowMs: nowMinute } : "skip", { initialNumItems: PAGE_SIZE });
    return usePagedState(r, PAGE_SIZE);
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
