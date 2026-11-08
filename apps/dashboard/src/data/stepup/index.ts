/**
 * Step-up hooks (plan 4.16). Like `../index.ts`, the implementation is picked
 * at build time: `vite.config.ts` points `@rulebox/stepup-impl` at `demo.ts`
 * (VITE_DEMO=1) or `live.ts`. Imported only by lazy chunks (the signed-in
 * shell, the Security tab and the `/pin-reset` page), never by the first load.
 */
import { stepUpApi } from "@rulebox/stepup-impl";
import type { StepUpApi } from "./api";

const api: StepUpApi = stepUpApi;

export const {
  useStepUpStatus,
  useVerifyActionPin,
  useSetActionPin,
  useGenerateRecoveryCodes,
  useBeginPasskeyVerification,
  useFinishPasskeyVerification,
  useBeginPasskeyRegistration,
  useFinishPasskeyRegistration,
  useRenamePasskey,
  useRemovePasskey,
  useKeepAlive,
  useLockSession,
  useResetMemberStepUp,
  useResetStepUpWithRecoveryCode,
  useRequestPinReset,
  useRedeemPinReset,
  useChangePassword,
} = api;
