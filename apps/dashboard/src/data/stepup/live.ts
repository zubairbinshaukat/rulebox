/**
 * Live step-up hooks (Convex, plan 4.16). Each one is a thin adapter like the
 * hooks in `../live/hooks.ts`: queries through `useMemberQuery`, calls
 * through `useMapped` (a thrown `ConvexError` becomes an `AppError`).
 */
import { useAction, useMutation } from "convex/react";
import { useCallback } from "react";
import { api } from "@convex/_generated/api";
import { mapError, useMapped, useMemberQuery } from "../live/convex";
import type { StepUpApi } from "./api";

/** Drops the `null` a Convex function returns, so the seam's `void` holds. */
function useVoid<A>(fn: (args: A) => Promise<unknown>): (args: A) => Promise<void> {
  const call = useCallback(
    async (args: A) => {
      await fn(args);
    },
    [fn],
  );
  return useMapped(call);
}

/** A Convex function without arguments as `() => Promise<R>`. */
function useNoArgs<R>(fn: (args: Record<string, never>) => Promise<R>): (args: void) => Promise<R> {
  const call = useCallback<(args: void) => Promise<R>>(async () => await fn({}), [fn]);
  return useMapped(call);
}

export const liveStepUpApi: StepUpApi = {
  useStepUpStatus() {
    return useMemberQuery(api.stepUp.status, {});
  },
  useVerifyActionPin() {
    return useMapped(useAction(api.stepUp.verifyActionPin));
  },
  useSetActionPin() {
    return useVoid(useAction(api.stepUp.setActionPin));
  },
  useGenerateRecoveryCodes() {
    return useNoArgs(useAction(api.stepUp.generateRecoveryCodes));
  },
  useBeginPasskeyVerification() {
    return useNoArgs(useAction(api.passkeys.beginVerification));
  },
  useFinishPasskeyVerification() {
    return useMapped(useAction(api.passkeys.finishVerification));
  },
  useBeginPasskeyRegistration() {
    return useNoArgs(useAction(api.passkeys.beginRegistration));
  },
  useFinishPasskeyRegistration() {
    return useMapped(useAction(api.passkeys.finishRegistration));
  },
  useRenamePasskey() {
    return useVoid(useMutation(api.stepUp.renamePasskey));
  },
  useRemovePasskey() {
    return useVoid(useMutation(api.stepUp.removePasskey));
  },
  useKeepAlive() {
    // Not `useMapped`: a stale session must not open the confirm dialog here;
    // the shell's controller locks instead.
    const keepAlive = useMutation(api.stepUp.keepAlive);
    return useCallback(async () => {
      try {
        return await keepAlive({});
      } catch (e) {
        throw mapError(e);
      }
    }, [keepAlive]);
  },
  useLockSession() {
    const lock = useMutation(api.stepUp.lock);
    const call = useCallback(async () => {
      await lock({});
    }, [lock]);
    return useMapped(call);
  },
  useResetMemberStepUp() {
    return useVoid(useMutation(api.stepUp.resetMember));
  },
  useResetStepUpWithRecoveryCode() {
    return useVoid(useAction(api.stepUp.resetWithRecoveryCode));
  },
  useRequestPinReset() {
    const request = useAction(api.account.requestPinReset);
    const call = useCallback(async () => {
      await request({});
    }, [request]);
    return useMapped(call);
  },
  useRedeemPinReset() {
    return useVoid(useAction(api.account.redeemPinReset));
  },
  useChangePassword() {
    return useVoid(useAction(api.account.changePassword));
  },
};

/** Resolved through the `@rulebox/stepup-impl` alias in live builds. */
export const stepUpApi = liveStepUpApi;
