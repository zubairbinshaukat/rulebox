import { useSyncExternalStore } from "react";

/**
 * A clock that ticks every `intervalMs` (Section 4.9: `useNow(30_000)`).
 * One shared timer per interval no matter how many components read it, so a
 * list of 50 "last seen" cells does not start 50 timers.
 */
interface Clock {
  subscribe: (listener: () => void) => () => void;
  read: () => number;
}

const clocks = new Map<number, Clock>();

function makeClock(intervalMs: number): Clock {
  let now = Date.now();
  let timer: ReturnType<typeof setInterval> | undefined;
  const listeners = new Set<() => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      if (!timer) {
        now = Date.now();
        timer = setInterval(() => {
          now = Date.now();
          for (const l of listeners) l();
        }, intervalMs);
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && timer) {
          clearInterval(timer);
          timer = undefined;
        }
      };
    },
    // React reads the snapshot before it subscribes: a clock that sat idle
    // (no reader for a while) refreshes first, so the first render is not stale.
    // Only when a whole interval passed (or the system clock jumped back), so
    // repeated reads stay equal.
    read: () => {
      if (!timer && Math.abs(Date.now() - now) >= intervalMs) now = Date.now();
      return now;
    },
  };
}

function clockFor(intervalMs: number): Clock {
  let c = clocks.get(intervalMs);
  if (!c) {
    c = makeClock(intervalMs);
    clocks.set(intervalMs, c);
  }
  return c;
}

export function useNow(intervalMs = 30_000): number {
  const clock = clockFor(intervalMs);
  return useSyncExternalStore(clock.subscribe, clock.read, clock.read);
}

/** `now` rounded down to the minute (queries take `nowMs` this way so results cache). */
export function minuteOf(ms: number): number {
  return Math.floor(ms / 60_000) * 60_000;
}

/**
 * The current minute (`minuteOf(now)`), read from the shared 30 s clock. The
 * component re-renders only when the minute changes, not on every tick, so a
 * query argument built from it changes at most once a minute.
 */
export function useMinute(): number {
  const clock = clockFor(30_000);
  const read = () => minuteOf(clock.read());
  return useSyncExternalStore(clock.subscribe, read, read);
}
