import { useCallback, useState } from "react";
import { usePublishAgain } from "../data";
import { errorCodeOf } from "./errors";
import { strings } from "./strings";
import { useToast } from "./toast";

const s = strings.publish;

/** The sentence for a failed "Publish again": its two refusals have their own wording (null = the usual one). */
export function publishErrorMessage(error: unknown): string | null {
  const code = errorCodeOf(error);
  if (code === "not_ready") return s.notReady;
  if (code === "conflict") return s.mismatch;
  return null;
}

/**
 * "Publish again" with its progress and error state, for every place that offers it (the global banner, the
 * Signing tab). One call at a time; a success toasts, a failure stays in `error` for the caller to show.
 */
export function usePublishAgainFlow() {
  const publishAgain = usePublishAgain();
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const run = useCallback(() => {
    setPending(true);
    setError(null);
    publishAgain().then(
      () => {
        setPending(false);
        toast(s.done);
      },
      (e) => {
        setPending(false);
        setError(e);
      },
    );
  }, [publishAgain, toast]);
  return { run, pending, error };
}
