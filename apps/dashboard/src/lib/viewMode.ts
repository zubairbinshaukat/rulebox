import { useCallback, useEffect, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { readStorage, writeStorage } from "./storage";

/**
 * Table or cards, one global preference for every list (Phase 4b; the phone default is the UI pass).
 *
 * - A stored choice (`rulebox.view`) always wins, at every width.
 * - With nothing stored, a viewport under 600 px shows cards and a wider one the table. That follows
 *   the width live (`matchMedia`) until the person picks one with the switch.
 * - Printing always prints the table (`beforeprint` / `afterprint`).
 *
 * Kept in this browser only. `src/boot/boot.js` resolves the same rule and puts the result on
 * `<html data-view>` before the first paint.
 */
export type ViewMode = "table" | "cards";

export const VIEW_KEY = "rulebox.view";
/** Below this viewport width, with no stored choice, lists show as cards. Keep in sync with `boot/boot.js`. */
export const AUTO_CARDS_QUERY = "(max-width: 599px)";

const isView = (v: unknown): v is ViewMode => v === "table" || v === "cards";

/** The choice made with the switch in this tab when storage is blocked (it lasts until reload). */
let memory: ViewMode | null = null;
let printing = false;

/** The stored choice, or `null` when the person has not picked one. */
export function storedView(): ViewMode | null {
  const stored = readStorage(VIEW_KEY);
  return isView(stored) ? stored : memory;
}

function autoView(): ViewMode {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "table";
  return window.matchMedia(AUTO_CARDS_QUERY).matches ? "cards" : "table";
}

/** What lists show now: print forces the table, then the stored choice, then the width rule. */
export function resolveView(): ViewMode {
  if (printing) return "table";
  return storedView() ?? autoView();
}

function applyView(v: ViewMode) {
  if (typeof document !== "undefined") document.documentElement.setAttribute("data-view", v);
}

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

/** Sets and remembers the view; every `useViewMode` in this tab updates. */
export function setViewMode(v: ViewMode) {
  writeStorage(VIEW_KEY, v);
  // Only when storage refused it: the choice then lasts until reload.
  memory = readStorage(VIEW_KEY) === v ? null : v;
  applyView(resolveView());
  notify();
}

function setPrinting(on: boolean) {
  if (printing === on) return;
  printing = on;
  applyView(resolveView());
  // The browser prints right after the event: the table must be in the page by then.
  flushSync(notify);
}

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  // Another tab changed it.
  const onStorage = (e: StorageEvent) => {
    if (e.key !== null && e.key !== VIEW_KEY) return;
    applyView(resolveView());
    onChange();
  };
  const onBeforePrint = () => setPrinting(true);
  const onAfterPrint = () => setPrinting(false);
  // The width crossing 600 px matters only while nothing is stored (resolveView returns the same string otherwise).
  const media = typeof window.matchMedia === "function" ? window.matchMedia(AUTO_CARDS_QUERY) : null;
  const onMedia = () => {
    applyView(resolveView());
    onChange();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener("beforeprint", onBeforePrint);
  window.addEventListener("afterprint", onAfterPrint);
  media?.addEventListener?.("change", onMedia);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onStorage);
    window.removeEventListener("beforeprint", onBeforePrint);
    window.removeEventListener("afterprint", onAfterPrint);
    media?.removeEventListener?.("change", onMedia);
  };
}

/** `[view, setView]`: re-renders when the choice changes here or in another tab, or the width rule flips. */
export function useViewMode(): [ViewMode, (v: ViewMode) => void] {
  const view = useSyncExternalStore(subscribe, resolveView, () => "table" as ViewMode);
  useEffect(() => applyView(view), [view]);
  const set = useCallback((v: ViewMode) => setViewMode(v), []);
  return [view, set];
}
