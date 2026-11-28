import { useCallback } from "react";
import { useSearchParams } from "react-router";

/**
 * The open tab, kept in the address (`?tab=apps`) so a reload or a shared link opens the same tab.
 * A missing or unknown value is the `fallback` tab. Choosing a tab replaces the history entry (tabs are
 * not pages to go "back" through), leaves every other query parameter alone and leaves the address clean
 * (no `?tab=`) for the fallback tab.
 */
export function useUrlTab<T extends string>(tabs: readonly T[], fallback: T, param = "tab"): [T, (next: T) => void] {
  const [params, setParams] = useSearchParams();
  const raw = params.get(param);
  const tab = raw !== null && (tabs as readonly string[]).includes(raw) ? (raw as T) : fallback;

  const setTab = useCallback(
    (next: T) => {
      setParams(
        (prev) => {
          const out = new URLSearchParams(prev);
          if (next === fallback) out.delete(param);
          else out.set(param, next);
          return out;
        },
        { replace: true },
      );
    },
    [setParams, fallback, param],
  );

  return [tab, setTab];
}
