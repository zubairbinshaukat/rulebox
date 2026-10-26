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
  system: { volume: null, battery: null, network: "none", canPowerOff: false, canSleep: false, brightness: null },
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

/** JSON of each top-level slice of `current`, to tell a changed slice from an untouched one. */
let sliceJson: Partial<Record<keyof ShellState, string>> = {};

/**
 * Keep the object of every slice that did not change, so selectors that return
 * a slice compare by identity (no serialising on every render), and tell the
 * listeners nothing when a whole snapshot is the same as the last one.
 */
function setState(next: ShellState) {
  const keys = Object.keys(next) as (keyof ShellState)[];
  const shared = { ...next } as Record<keyof ShellState, unknown>;
  const json: Partial<Record<keyof ShellState, string>> = {};
  let changed = keys.length !== Object.keys(current).length;
  for (const key of keys) {
    const text = JSON.stringify(next[key]);
    json[key] = text;
    if (sliceJson[key] === text && key in current) {
      shared[key] = current[key];
    } else {
      changed = true;
    }
  }
  sliceJson = json;
  if (!changed) {
    return;
  }
  current = shared as unknown as ShellState;
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
  sliceJson = {};
  emit();
}

/** Test helper: deliver a snapshot the way a `shell://state` event does. */
export function __applySnapshotForTests(state: ShellState): void {
  setState(state);
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

  const cacheRef = useRef<{ raw: T; json: string; value: T } | null>(null);

  const getSnapshot = useCallback((): T => {
    const raw = selectRef.current(current);
    const cache = cacheRef.current;
    // The same object as last time (an untouched slice): nothing to compare.
    if (cache && Object.is(cache.raw, raw)) {
      return cache.value;
    }
    const json = JSON.stringify(raw);
    if (cache && cache.json === json) {
      cacheRef.current = { raw, json, value: cache.value };
      return cache.value;
    }
    const stable = JSON.parse(json) as T;
    cacheRef.current = { raw, json, value: stable };
    return stable;
  }, []);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
