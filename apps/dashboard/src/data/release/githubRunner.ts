/**
 * The state machine behind `useGithubReleases` (settings plan 5.3), shared by `live.ts` and `demo.ts` so both behave the same:
 * an ACTION is not reactive, so it runs once when the Updates section opens for an owner (`enabled`), never polls, never on focus.
 * The last `ok` answer is kept in module memory for 5 minutes (no storage: a stale hash never survives a reload); "Refresh" calls
 * again with `refresh: true`, keeps the old list on screen while it runs and is locked for 30 s after any call. The answer of a
 * call lands in the module store, not in a component: a screen that was left meanwhile simply is not updated (the next one finds
 * the answer). Components read the store with `useSyncExternalStore`, so no state is set from an effect.
 */
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { GithubReleasesHandle, GithubReleasesResult, GithubReleasesState } from "./api";

/** How long the last `ok` answer is reused without calling again. */
export const CLIENT_CACHE_MS = 5 * 60_000;
/** How long Refresh stays disabled after a call (the server asks GitHub at most every 30 s anyway). */
export const REFRESH_LOCK_MS = 30_000;

type Settled =
  | { status: "ready"; data: GithubReleasesResult; at: number; cacheable: boolean }
  | { status: "error"; error: unknown };
type View = { settled: Settled | null; refreshing: boolean };
type Entry = { view: View; listeners: Set<() => void>; inflight: Promise<void> | null };

const EMPTY: View = { settled: null, refreshing: false };
const IDLE: GithubReleasesState = { status: "idle" };
const LOADING: GithubReleasesState = { status: "loading" };

const entries = new Map<string, Entry>();

const lockListeners = new Set<() => void>();
let lastCallAt = 0;
let lockTimer: ReturnType<typeof setTimeout> | undefined;

const lockLeft = () => Math.max(0, lastCallAt + REFRESH_LOCK_MS - Date.now());
const lockOpen = () => lockLeft() === 0;
const notifyLock = () => lockListeners.forEach((l) => l());
function subscribeLock(l: () => void): () => void {
  lockListeners.add(l);
  return () => void lockListeners.delete(l);
}
function armLock(): void {
  clearTimeout(lockTimer);
  lockTimer = setTimeout(notifyLock, REFRESH_LOCK_MS);
  notifyLock();
}

/** Tests only: forget every answer, running call and the refresh lock. */
export function resetGithubReleasesClient(): void {
  entries.clear();
  lastCallAt = 0;
  clearTimeout(lockTimer);
  notifyLock();
}

function entryOf(key: string): Entry {
  let e = entries.get(key);
  if (e === undefined) {
    e = { view: EMPTY, listeners: new Set(), inflight: null };
    entries.set(key, e);
  }
  return e;
}

/** An `ok` answer younger than `CLIENT_CACHE_MS`. */
function isFresh(e: Entry): boolean {
  const s = e.view.settled;
  return s !== null && s.status === "ready" && s.cacheable && Date.now() - s.at < CLIENT_CACHE_MS;
}

/** Before a screen opens: an answer that is old, or not an `ok` one, is forgotten (when no screen shows it and no call is running). */
function purgeUnused(key: string): null {
  const e = entries.get(key);
  if (e !== undefined && e.listeners.size === 0 && e.inflight === null && !isFresh(e)) entries.delete(key);
  return null;
}

function setView(e: Entry, view: View): void {
  e.view = view;
  e.listeners.forEach((l) => l());
}

/** One call. Its answer is stored whether or not a screen is still there. */
function start(key: string, refresh: boolean, call: (refresh: boolean) => Promise<GithubReleasesResult>): void {
  const e = entryOf(key);
  lastCallAt = Date.now();
  armLock();
  if (refresh) setView(e, { ...e.view, refreshing: true });
  let pending: Promise<GithubReleasesResult>;
  try {
    pending = call(refresh);
  } catch (error) {
    pending = Promise.reject(error);
  }
  const done: Promise<void> = pending.then(
    (data) => setView(e, { settled: { status: "ready", data, at: Date.now(), cacheable: data.status === "ok" }, refreshing: false }),
    (error: unknown) => setView(e, { settled: { status: "error", error }, refreshing: false }),
  );
  e.inflight = done;
  void done.then(() => {
    if (e.inflight === done) e.inflight = null;
  });
}

/**
 * `key` names what is cached (live: one key; demo: the `demoReleases` variant); `call` is the one network (or fake) call.
 * `enabled` false: `idle`, nothing is called.
 */
export function useGithubReleasesRunner(
  enabled: boolean,
  key: string,
  call: (refresh: boolean) => Promise<GithubReleasesResult>,
): GithubReleasesHandle {
  const callRef = useRef(call);
  useEffect(() => {
    callRef.current = call;
  });
  useMemo(() => purgeUnused(key), [key]);
  const subscribe = useCallback(
    (l: () => void) => {
      const e = entryOf(key);
      e.listeners.add(l);
      return () => void e.listeners.delete(l);
    },
    [key],
  );
  const view = useSyncExternalStore(subscribe, () => entries.get(key)?.view ?? EMPTY);
  const canRefresh = useSyncExternalStore(subscribeLock, lockOpen);

  useEffect(() => {
    if (!enabled) return;
    const e = entryOf(key);
    if (e.inflight === null && !isFresh(e)) start(key, false, (r) => callRef.current(r));
  }, [enabled, key]);

  const refresh = useCallback(() => {
    if (lockLeft() > 0) return;
    start(key, true, (r) => callRef.current(r));
  }, [key]);

  const state = useMemo<GithubReleasesState>(() => {
    if (!enabled) return IDLE;
    const s = view.settled;
    if (s === null) return LOADING;
    return s.status === "ready" ? { status: "ready", data: s.data } : { status: "error", error: s.error };
  }, [enabled, view]);

  return { state, refreshing: view.refreshing, canRefresh, refresh };
}
