/**
 * The step-up part of the data seam (plan 4.16): the action PIN, passkeys and
 * the session's unlock. Kept apart from `DataApi` so none of it reaches the
 * first load: only the signed-in shell and the Security tab import it (the
 * `core` chunk rule in `vite.config.ts` skips `stepup/` folders).
 * `demo.ts` and `live.ts` both satisfy this type.
 */
import type { Id, PasskeyOptions, QueryState, StepUpStatus, StepUpVerified } from "../types";

type Call<A, R = void> = () => (args: A) => Promise<R>;

export interface StepUpApi {
  /** `stepUp:status` (any role). */
  useStepUpStatus: () => QueryState<StepUpStatus>;
  /** `stepUp:verifyActionPin` (action): unlocks this session and makes it fresh. */
  useVerifyActionPin: Call<{ pin: string }, StepUpVerified>;
  /** `stepUp:setActionPin` (action): the first factor (bootstrap) or a change after a fresh step-up. */
  useSetActionPin: Call<{ pin: string }>;
  /** `stepUp:clearActionPin` (major). */
  useClearActionPin: Call<void>;
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
  /** `stepUp:resetWithRecoveryCode` (action): fresh sign-in + TOTP + one recovery code. */
  useResetStepUpWithRecoveryCode: Call<{ code: string }>;
}
