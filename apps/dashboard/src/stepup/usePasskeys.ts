import { useCallback } from "react";
import {
  useBeginPasskeyRegistration,
  useBeginPasskeyVerification,
  useFinishPasskeyRegistration,
  useFinishPasskeyVerification,
} from "../data/stepup";
import type { StepUpVerified } from "../data/types";
import { assertPasskey, createPasskey } from "../lib/stepup/passkey";

/** Begin → the browser's prompt → finish. Rejects with the browser's error when the prompt is closed. */
export function usePasskeyVerification(): (onPrompt?: () => void) => Promise<StepUpVerified> {
  const begin = useBeginPasskeyVerification();
  const finish = useFinishPasskeyVerification();
  return useCallback(
    async (onPrompt?: () => void) => {
      const options = await begin();
      onPrompt?.();
      const responseJson = await assertPasskey(options.optionsJson);
      return await finish({ responseJson });
    },
    [begin, finish],
  );
}

/**
 * Adds a passkey. `begin` needs the first-factor bootstrap or a fresh step-up
 * (the data seam opens the confirm dialog for the latter).
 */
export function useAddPasskey(): (name: string, onPrompt?: () => void) => Promise<void> {
  const begin = useBeginPasskeyRegistration();
  const finish = useFinishPasskeyRegistration();
  return useCallback(
    async (name: string, onPrompt?: () => void) => {
      const options = await begin();
      onPrompt?.();
      const responseJson = await createPasskey(options.optionsJson);
      await finish({ responseJson, name });
    },
    [begin, finish],
  );
}
