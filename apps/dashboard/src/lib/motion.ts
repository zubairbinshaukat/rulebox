import { useEffect, useState } from "react";
import gsap from "gsap";

/**
 * Motion helpers (PRD 25). Same API as the Staff App's `lib/motion.ts`:
 * `"full"` = y 8→0 + opacity, `"fade"` = opacity only (reduced motion or
 * Lite). Only transform and opacity are ever animated. Unlike the Staff App
 * this uses `opacity`, not `autoAlpha`: `visibility: hidden` during the
 * entrance would make focus moves (dialogs, page titles) fail.
 */
export type MotionLevel = "full" | "fade";

const EASE = "power2.out";

function prefersReduced(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function isLite(): boolean {
  return typeof document !== "undefined" && document.documentElement.getAttribute("data-lite") === "true";
}

export function currentMotionLevel(): MotionLevel {
  return prefersReduced() || isLite() ? "fade" : "full";
}

export function useMotionLevel(): MotionLevel {
  const [level, setLevel] = useState<MotionLevel>(currentMotionLevel);
  useEffect(() => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setLevel(currentMotionLevel());
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  return level;
}

export type MotionOpts = gsap.TweenVars;

/** Enter: full = y 8→0 + opacity (200 ms); fade = opacity only (150 ms). */
export function enter(el: gsap.TweenTarget, level: MotionLevel, opts?: MotionOpts): gsap.core.Tween {
  if (level === "fade") {
    return gsap.fromTo(el, { opacity: 0 }, { opacity: 1, duration: 0.15, ease: EASE, ...opts });
  }
  return gsap.fromTo(el, { y: 8, opacity: 0 }, { y: 0, opacity: 1, duration: 0.2, ease: EASE, ...opts });
}

/** Exit: full = y 0→8 + opacity; fade = opacity only. */
export function exit(el: gsap.TweenTarget, level: MotionLevel, opts?: MotionOpts): gsap.core.Tween {
  if (level === "fade") {
    return gsap.to(el, { opacity: 0, duration: 0.15, ease: EASE, ...opts });
  }
  return gsap.to(el, { y: 8, opacity: 0, duration: 0.2, ease: EASE, ...opts });
}
