import { useCallback, useEffect, useRef, useState } from "react";

/** The most often a dragged slider asks the system to change (milliseconds). */
const SEND_EVERY_MS = 80;

/**
 * A slider's value while it is dragged. The thumb follows the pointer at once
 * (`value` is the local choice), and the system is asked at most every
 * `SEND_EVERY_MS` with the latest value, first one immediately and the last
 * one always. When the system's own value arrives the local choice is dropped,
 * so a refused change snaps back instead of lying.
 */
export function useThrottledValue(
  external: number,
  send: (value: number) => void,
): { value: number; change: (value: number) => void } {
  const [local, setLocal] = useState<number | null>(null);
  const pending = useRef<number | null>(null);
  const timer = useRef<number | null>(null);
  const sendRef = useRef(send);
  useEffect(() => {
    sendRef.current = send;
  }, [send]);

  const change = useCallback((value: number) => {
    function flush() {
      timer.current = null;
      if (pending.current === null) {
        // Quiet for a moment: trust the system's value from here on.
        setLocal(null);
        return;
      }
      const next = pending.current;
      pending.current = null;
      sendRef.current(next);
      timer.current = window.setTimeout(flush, SEND_EVERY_MS);
    }
    setLocal(value);
    pending.current = value;
    if (timer.current === null) {
      flush();
    }
  }, []);

  // The system reported its value: unless more is on the way, show that one.
  useEffect(() => {
    if (timer.current === null && pending.current === null) {
      setLocal(null);
    }
  }, [external]);

  useEffect(
    () => () => {
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
      }
    },
    [],
  );

  return { value: local ?? external, change };
}
