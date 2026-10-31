import { useSyncExternalStore } from "react";
import { emit, listen } from "@tauri-apps/api/event";

import { isTauri } from "./tauri";

/**
 * Developer tool: "Force full motion" (resource monitor popup).
 *
 * A VM often runs in Lite mode, or Windows reports "reduce motion" there, so
 * the splash, logo, open/lock sequences and the Flip transitions cannot be seen.
 * With this switch on, every Rulebox window ignores both and plays all of them.
 *
 * It only exists in a debug build: `DEV_TOOLS_BUILD` is a compile-time constant,
 * true under `vite` (dev) and in `tauri build --debug` (the CLI sets
 * `TAURI_ENV_DEBUG=true`, which `vite.config.ts` exposes), and false in a release
 * build, where bundling removes everything behind it. Default off.
 *
 * The one place Lite and reduced motion are decided on the page is
 * `useMotionLevel()` (motion.ts) plus the `data-lite` attribute (each window's
 * main.tsx) plus the `prefers-reduced-motion` blocks in packages/ui; all three
 * read this switch (`useForcedFullMotion()` / `html[data-force-motion]`).
 */
export const DEV_TOOLS_BUILD: boolean = Boolean(
  import.meta.env.DEV || import.meta.env.TAURI_ENV_DEBUG === "true",
);

const STORAGE_KEY = "rulebox.dev.forceFullMotion";
const EVENT = "dev://force-full-motion";

let forced = false;
let started = false;
const listeners = new Set<() => void>();

function readStored(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeStored(on: boolean): void {
  try {
    if (on) {
      window.localStorage.setItem(STORAGE_KEY, "1");
    } else {
      window.localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // Storage can be blocked; the choice then lives in memory and the event only.
  }
}

/** Mark the page (for the `prefers-reduced-motion` CSS) and tell the components. */
function apply(on: boolean): void {
  if (forced === on) {
    return;
  }
  forced = on;
  if (typeof document !== "undefined") {
    if (on) {
      document.documentElement.setAttribute("data-force-motion", "true");
    } else {
      document.documentElement.removeAttribute("data-force-motion");
    }
  }
  for (const listener of listeners) {
    listener();
  }
}

export function isFullMotionForced(): boolean {
  return DEV_TOOLS_BUILD && forced;
}

/**
 * Called once by each window's entry file. Restores the choice made earlier in
 * this session and follows changes made in any other window. Does nothing in a
 * release build.
 */
export function startDevMotion(): void {
  if (!DEV_TOOLS_BUILD || started) {
    return;
  }
  started = true;
  apply(readStored());
  if (isTauri()) {
    void listen<boolean>(EVENT, (event) => {
      writeStored(event.payload === true);
      apply(event.payload === true);
    }).catch(() => undefined);
  }
}

/** Turn it on or off in every window. Does nothing in a release build. */
export function setFullMotionForced(on: boolean): void {
  if (!DEV_TOOLS_BUILD) {
    return;
  }
  writeStored(on);
  apply(on);
  if (isTauri()) {
    void emit(EVENT, on).catch(() => undefined);
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** True while "Force full motion" is on. Always false in a release build. */
export function useForcedFullMotion(): boolean {
  return useSyncExternalStore(subscribe, isFullMotionForced, () => false);
}
