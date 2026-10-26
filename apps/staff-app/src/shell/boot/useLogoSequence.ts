import { useCallback, useEffect, useState } from "react";
import type { LogoAnimation } from "@rulebox/ui";

import { note, startFrameMeter } from "../../lib/frameMeter";
import type { MotionLevel } from "../../lib/motion";

export type LogoKind = "splash" | "open" | "lock";

export interface LogoSequence {
  animation: LogoAnimation;
  key: number;
  onCovered: () => void;
  onDone: () => void;
  covered: boolean;
  done: boolean;
  skip: () => void;
}

const FULL_MS: Record<LogoKind, { covered: number; done: number }> = {
  splash: { covered: 3_500, done: 3_500 },
  lock: { covered: 3_000, done: 3_000 },
  open: { covered: 1_600, done: 2_100 },
};

const FADE_MS = 400;

/**
 * Owns LogoMotion timing so a missed CSS callback cannot strand the UI.
 * Fallback timers race the component callbacks; whichever fires first wins.
 * When `enabled` is false, timers are idle and covered/done stay false.
 */
export function useLogoSequence(
  kind: LogoKind,
  level: MotionLevel,
  enabled = true,
): LogoSequence {
  const [key, setKey] = useState(0);
  const [covered, setCovered] = useState(false);
  const [done, setDone] = useState(false);

  // Reset when the sequence identity changes (adjust state during render).
  const identity = `${kind}:${key}:${enabled ? 1 : 0}`;
  const [prevIdentity, setPrevIdentity] = useState(identity);
  if (identity !== prevIdentity) {
    setPrevIdentity(identity);
    setCovered(false);
    setDone(false);
  }

  const markCovered = useCallback(() => {
    if (!enabled) return;
    setCovered(true);
  }, [enabled]);

  const markDone = useCallback(() => {
    if (!enabled) return;
    setCovered(true);
    setDone(true);
  }, [enabled]);

  const skip = useCallback(() => {
    markDone();
  }, [markDone]);

  // Debug builds log which of the two paths (the animation's own callback or
  // the fallback timer) ended each step; the first one wins either way.
  const onCovered = useCallback(() => {
    note(`logo ${kind} covered via callback`);
    markCovered();
  }, [kind, markCovered]);
  const onDone = useCallback(() => {
    note(`logo ${kind} done via callback`);
    markDone();
  }, [kind, markDone]);

  useEffect(() => {
    if (!enabled) return;
    const times = level === "fade" ? { covered: FADE_MS, done: FADE_MS } : FULL_MS[kind];
    const stopMeter = startFrameMeter(`${kind}:${level}`);
    const tCover = window.setTimeout(() => {
      note(`logo ${kind} covered via timer`);
      markCovered();
    }, times.covered);
    const tDone = window.setTimeout(() => {
      note(`logo ${kind} done via timer`);
      markDone();
    }, times.done);
    return () => {
      window.clearTimeout(tCover);
      window.clearTimeout(tDone);
      stopMeter();
    };
  }, [kind, key, level, enabled, markCovered, markDone]);

  useEffect(() => {
    if (!enabled || kind !== "open" || done) return;
    const onResize = () => {
      setKey((k) => k + 1);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [kind, key, enabled, done]);

  return {
    animation: kind,
    key,
    onCovered,
    onDone,
    covered,
    done,
    skip,
  };
}
