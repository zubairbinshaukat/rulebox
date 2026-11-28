import { useEffect, useState, type RefObject } from "react";

/** True while `target` has scrolled up behind the top bar: the tab bar then shows the group's name (like the device page). */
export function useScrolledPast(target: RefObject<HTMLElement | null>): boolean {
  const [past, setPast] = useState(false);
  useEffect(() => {
    const el = target.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    // The top bar is 64 px high and sticky: the title counts as gone when it slides under it.
    const io = new IntersectionObserver(([e]) => setPast(e !== undefined && !e.isIntersecting && e.boundingClientRect.top < 64), {
      rootMargin: "-64px 0px 0px 0px",
    });
    io.observe(el);
    return () => io.disconnect();
  }, [target]);
  return past;
}

/**
 * True once `target` has scrolled out of view upwards (the header's main button): a phone then shows the same button at the
 * bottom of the screen. No observer (an old browser, a test) means "still in view", so nothing doubles up.
 */
export function useScrolledAway(target: RefObject<HTMLElement | null>): boolean {
  const [away, setAway] = useState(false);
  useEffect(() => {
    const el = target.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([e]) => setAway(e !== undefined && !e.isIntersecting && e.boundingClientRect.bottom < 64));
    io.observe(el);
    return () => io.disconnect();
  }, [target]);
  return away;
}
