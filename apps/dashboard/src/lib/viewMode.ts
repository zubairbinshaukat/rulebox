import { useCallback, useEffect, useSyncExternalStore } from "react";
import { readStorage, writeStorage } from "./storage";

/**
 * Table or cards, one global preference for every list (Phase 4b).
 * Kept in this browser only. `src/boot/boot.js` puts it on `<html data-view>`
 * before the first paint; the CSS in dashboard.css reads that attribute, so a
 * switch needs no re-render of the tables themselves.
 */
export type ViewMode = "table" | "cards";

export const VIEW_KEY = "rulebox.view";

const isView = (v: unknown): v is ViewMode => v === "table" || v === "cards";

/** The stored choice. The attribute on `<html>` is the fallback when storage is blocked. */
export function savedView(): ViewMode {
  const stored = readStorage(VIEW_KEY);
  if (isView(stored)) return stored;
  const attr = typeof document === "undefined" ? null : document.documentElement.getAttribute("data-view");
  return isView(attr) ? attr : "table";
}

function applyView(v: ViewMode) {
  if (typeof document !== "undefined") document.documentElement.setAttribute("data-view", v);
}

const listeners = new Set<() => void>();

/** Sets and remembers the view; every `useViewMode` in this tab updates. */
export function setViewMode(v: ViewMode) {
  applyView(v);
  writeStorage(VIEW_KEY, v);
  listeners.forEach((l) => l());
}

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  // Another tab changed it.
  const onStorage = (e: StorageEvent) => {
    if (e.key !== null && e.key !== VIEW_KEY) return;
    applyView(savedView());
    onChange();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onStorage);
  };
}

/** `[view, setView]`: re-renders when the choice changes here or in another tab. */
export function useViewMode(): [ViewMode, (v: ViewMode) => void] {
  const view = useSyncExternalStore(subscribe, savedView, () => "table" as ViewMode);
  useEffect(() => applyView(view), [view]);
  const set = useCallback((v: ViewMode) => setViewMode(v), []);
  return [view, set];
}
