import { useCallback, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import type { ShellState } from "@rulebox/types";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { call, isTauri } from "./tauri";

type Listener = () => void;

/** Matches Rust `ShellState::initial(Dev)` until the first real snapshot. */
export const EMPTY_SHELL_STATE: ShellState = {
  mode: "dev",
  link: "disconnected",
  agent: null,
  display: { lite: false, theme: "auto", reducedMotion: false },
  session: { status: "signedOut", last: null },
  apps: { status: "idle", items: [] },
  tasks: [],
  system: { volume: null, battery: null, network: "none", canPowerOff: false, brightness: null },
  notices: [],
  banner: null,
  capabilities: [],
};

let current: ShellState = EMPTY_SHELL_STATE;
const listeners = new Set<Listener>();
let started = false;
let unlisten: UnlistenFn | null = null;

function emit() {
  for (const listener of listeners) {
    listener();
  }
}

function setState(next: ShellState) {
  current = next;
  emit();
}

export function getShellState(): ShellState {
  return current;
}

function subscribe(onStoreChange: Listener): () => void {
  listeners.add(onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
  };
}

/** Subscribe to `shell://state` and load the initial snapshot (once). */
export async function startShellStore(): Promise<void> {
  if (started) {
    return;
  }
  started = true;

  if (!isTauri()) {
    return;
  }

  try {
    const initial = await call("shell_state", {});
    setState(initial);
    unlisten = await listen<ShellState>("shell://state", (event) => {
      setState(event.payload);
    });
  } catch (error) {
    console.warn("shell store: could not bind to Tauri", error);
  }
}

export function stopShellStore(): void {
  if (unlisten) {
    void unlisten();
    unlisten = null;
  }
  started = false;
}

/** Test helper: push a full shell state without Tauri. */
export function __setShellStateForTests(state: ShellState): void {
  current = state;
  emit();
}

/**
 * Select a slice of `ShellState`. Re-renders only when `JSON.stringify` of the
 * selection changes (`useSyncExternalStore` + stable snapshot reference).
 */
export function useShell<T>(select: (s: ShellState) => T): T {
  const selectRef = useRef(select);
  useLayoutEffect(() => {
    selectRef.current = select;
  });

  const cacheRef = useRef<{ json: string; value: T } | null>(null);

  const getSnapshot = useCallback((): T => {
    const value = selectRef.current(current);
    const json = JSON.stringify(value);
    if (cacheRef.current && cacheRef.current.json === json) {
      return cacheRef.current.value;
    }
    const stable = JSON.parse(json) as T;
    cacheRef.current = { json, value: stable };
    return stable;
  }, []);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
