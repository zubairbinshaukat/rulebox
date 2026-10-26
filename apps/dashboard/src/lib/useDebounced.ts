import { useEffect, useState } from "react";

/** The value, `delayMs` after it last changed (search boxes: 250 ms, Step 7). */
export function useDebounced<T>(value: T, delayMs = 250): T {
  const [out, setOut] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setOut(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return out;
}
