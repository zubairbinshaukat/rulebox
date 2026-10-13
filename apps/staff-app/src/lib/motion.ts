import { useEffect, useState } from "react";
import gsap from "gsap";

import { useShell } from "./store";

export type MotionLevel = "full" | "fade";

const EASE =
  typeof window !== "undefined"
    ? getComputedStyle(document.documentElement).getPropertyValue("--rb-ease").trim() ||
      "cubic-bezier(0.2, 0.8, 0.2, 1)"
    : "cubic-bezier(0.2, 0.8, 0.2, 1)";

/** Local override from the debug overlay (simulated reduced motion). */
let forceReducedMotion = false;
const forceListeners = new Set<() => void>();

export function setForceReducedMotion(value: boolean): void {
  forceReducedMotion = value;
  for (const listener of forceListeners) {
    listener();
  }
}

export function getForceReducedMotion(): boolean {
  return forceReducedMotion;
}

function systemPrefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) {
    return false;
  }
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * `"fade"` when Lite, OS reduced-motion, or the debug overlay forces it.
 * Otherwise `"full"`.
 */
export function useMotionLevel(): MotionLevel {
  const lite = useShell((s) => s.display.lite);
  const [reduced, setReduced] = useState(
    () => forceReducedMotion || systemPrefersReducedMotion(),
  );

  useEffect(() => {
    const sync = () => {
      setReduced(forceReducedMotion || systemPrefersReducedMotion());
    };
    forceListeners.add(sync);
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    mq.addEventListener("change", sync);
    return () => {
      forceListeners.delete(sync);
      mq.removeEventListener("change", sync);
    };
  }, []);

  return lite || reduced ? "fade" : "full";
}

export type MotionOpts = gsap.TweenVars;

/** Enter: full = y 8→0 + autoAlpha; fade = autoAlpha only. */
export function enter(
  el: Element,
  level: MotionLevel,
  opts?: MotionOpts,
): gsap.core.Tween {
  if (level === "fade") {
    return gsap.fromTo(
      el,
      { autoAlpha: 0 },
      { autoAlpha: 1, duration: 0.15, ease: EASE, ...opts },
    );
  }
  return gsap.fromTo(
    el,
    { y: 8, autoAlpha: 0 },
    { y: 0, autoAlpha: 1, duration: 0.2, ease: EASE, ...opts },
  );
}

/** Exit: full = y 0→8 + autoAlpha; fade = autoAlpha only. */
export function exit(
  el: Element,
  level: MotionLevel,
  opts?: MotionOpts,
): gsap.core.Tween {
  if (level === "fade") {
    return gsap.to(el, { autoAlpha: 0, duration: 0.15, ease: EASE, ...opts });
  }
  return gsap.to(el, {
    y: 8,
    autoAlpha: 0,
    duration: 0.2,
    ease: EASE,
    ...opts,
  });
}
