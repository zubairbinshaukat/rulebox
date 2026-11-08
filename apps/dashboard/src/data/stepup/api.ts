/**
 * The step-up part of the data seam (plan 4.16): the action PIN, passkeys and
 * the session's unlock, plus the PIN-reset and password-change calls that go
 * with them. Kept apart from `DataApi` so none of it reaches the first load:
 * only the signed-in shell, the Security tab and the `/pin-reset` page import
 * it (the `core` chunk rule in `vite.config.ts` skips `stepup/` folders).
 * `demo.ts` and `live.ts` both satisfy this type.
 */
import type { Id, PasskeyOptions, QueryState, StepUpStatus, StepUpVerified } from "../types";

type Call<A, R = void> = () => (args: A) => Promise<R>;

export interface StepUpApi {
  /** `stepUp:status` (any role). */
  useStepUpStatus: () => QueryState<StepUpStatus>;
  /** `stepUp:verifyActionPin` (action): unlocks this session and makes it fresh. */
  useVerifyActionPin: Call<{ pin: string }, StepUpVerified>;
  /** `stepUp:setActionPin` (action): the first PIN (bootstrap, right after a password sign-in) or a change after a fresh step-up. */
  useSetActionPin: Call<{ pin: string }>;
  /** `stepUp:generateRecoveryCodes` (action, major): 10 new codes for the PIN, returned once. The bootstrap counts as fresh. */
  useGenerateRecoveryCodes: Call<void, string[]>;
  /** `passkeys:beginVerification` / `finishVerification` (Node actions). */
  useBeginPasskeyVerification: Call<void, PasskeyOptions>;
  useFinishPasskeyVerification: Call<{ responseJson: string }, StepUpVerified>;
  /** `passkeys:beginRegistration` / `finishRegistration` (Node actions). */
  useBeginPasskeyRegistration: Call<void, PasskeyOptions>;
  useFinishPasskeyRegistration: Call<{ responseJson: string; name?: string }, { passkeyId: Id }>;
  /** `stepUp:renamePasskey`, `stepUp:removePasskey` (major). */
  useRenamePasskey: Call<{ passkeyId: Id; name: string }>;
  useRemovePasskey: Call<{ passkeyId: Id }>;
  /** `stepUp:keepAlive`: at most every `policy.keepAliveMs` while there is input. */
  useKeepAlive: Call<void, { serverNow: number }>;
  /** `stepUp:lock`: idle timer and "Lock now". */
  useLockSession: Call<void>;
  /** `stepUp:resetMember` (Owner, major): removes another member's PIN and passkeys. */
  useResetMemberStepUp: Call<{ memberId: Id }>;
  /**
   * `stepUp:resetWithRecoveryCode` (action): a password sign-in under 15 minutes old + one recovery code +
   * the NEW PIN, set in the same step. The passkeys go; this session is unlocked.
   */
  useResetStepUpWithRecoveryCode: Call<{ code: string; newPin: string }>;
  /** `account:requestPinReset` (action): no arguments; mails the signed-in member's own address (always answers ok). */
  useRequestPinReset: Call<void>;
  /**
   * `account:redeemPinReset` (action): the `/pin-reset#token=` token + the new PIN. Needs a password sign-in under
   * 15 minutes old (`step_up_setup_required`, detail `reauthenticate`); every token problem is `step_up_invalid`.
   */
  useRedeemPinReset: Call<{ token: string; newPin: string }>;
  /** `account:changePassword` (action, major: fresh step-up): the current password is checked on the server. */
  useChangePassword: Call<{ currentPassword: string; newPassword: string }>;
}
