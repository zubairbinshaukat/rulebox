import { useCallback, useState } from "react";

/**
 * One write at a time for a card: remembers which one is running (`busy`) and its error, so the buttons disable while it runs and the
 * card shows the refusal next to them. `done` runs after a success.
 */
export function useRun() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const run = useCallback(async (key: string, call: () => Promise<unknown>, done?: () => void) => {
    setBusy(key);
    setError(null);
    try {
      await call();
      done?.();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  }, []);
  const clear = useCallback(() => setError(null), []);
  return { busy, error, run, clear };
}
