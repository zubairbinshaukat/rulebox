import { useCallback, useEffect, useRef, type RefObject } from "react";

import { call, isTauri, type AnchorRect } from "../../lib/tauri";

/**
 * The pills of the taskbar and the toast cards above them: the only parts that
 * may take a click. (Pills share the taskbar window with the toasts.)
 */
const PILL = ".rb-dock, .rb-toast";

/**
 * After a change the shape is sent again once layout has settled (fonts, icons,
 * the monitor chip's text). Each send is skipped when nothing moved.
 */
const SETTLE_MS = [120, 400];

/** Whole pixels, so a sub-pixel wobble does not send the same shape twice. */
function key(rects: AnchorRect[]): string {
  return rects
    .map((r) => [r.x, r.y, r.width, r.height].map((n) => Math.round(n)).join(","))
    .join("|");
}

/**
 * Tells Rust where the taskbar's pills are, so the transparent strip around
 * and between them lets clicks through to the window behind (a program window
 * dragged under the bar, the desktop). The window is clipped to a union of
 * rounded rectangles; see `taskbar_shape` in the Staff App.
 *
 * The clip must never lag the picture: a pill that grows (an app opens) would
 * be cut off until the new shape arrives. Two things keep it in step:
 *
 * - The returned `refresh` is called from a layout effect right after React
 *   commits a change, so the shape is on its way to Rust before the browser
 *   paints the new pill (and not a frame later, when a ResizeObserver or an
 *   animation frame would send it; those slow down while the window is covered).
 * - A ResizeObserver on **every pill that exists now** sends it for anything
 *   `refresh` does not know about (the tray gains a battery, a font loads).
 *   `layoutKey` must change whenever pills appear or disappear (sign-in and
 *   sign-out): React turns the plain placeholder `<div />` into the apps pill in
 *   place, which no child-list observer can see, and a pill nobody observes
 *   only reached Rust at the next unrelated resize (seen on the VM: the pill
 *   grew up to several seconds after the app opened).
 *
 * Pills change size at once, not by animation; only the buttons inside them
 * animate.
 */
export function useTaskbarShape(bar: RefObject<HTMLElement | null>, layoutKey: string): () => void {
  const now = useRef<() => void>(() => undefined);
  // Stable, so it can sit in an effect's dependencies.
  const refresh = useCallback(() => now.current(), []);

  useEffect(() => {
    const root = bar.current;
    if (!root || !isTauri()) {
      return;
    }
    // The toast cards sit beside the bar, not inside it: look in its parent.
    const scope = root.parentElement ?? root;
    let sent = "";
    let disposed = false;
    const timers = new Set<number>();

    const send = () => {
      if (disposed) {
        return;
      }
      // Physical pixels, relative to this window's client area.
      const ratio = window.devicePixelRatio || 1;
      const rects = Array.from(scope.querySelectorAll<HTMLElement>(PILL))
        .map((pill) => pill.getBoundingClientRect())
        .filter((box) => box.width > 0 && box.height > 0)
        .map((box) => ({
          x: box.left * ratio,
          y: box.top * ratio,
          width: box.width * ratio,
          height: box.height * ratio,
        }));
      const next = key(rects);
      if (next === sent) {
        return;
      }
      sent = next;
      call("taskbar_shape", { rects }).catch(() => {
        // Not applied: ask again on the next change instead of trusting `sent`.
        sent = "";
      });
    };
    const settle = () => {
      for (const delay of SETTLE_MS) {
        const id = window.setTimeout(() => {
          timers.delete(id);
          send();
        }, delay);
        timers.add(id);
      }
    };
    const changed = () => {
      send();
      settle();
    };
    now.current = changed;

    // Any pill resizing can move the others (the apps pill is centred between
    // two flexible sides), so every change recomputes all of them.
    const resize = new ResizeObserver(changed);
    scope.querySelectorAll(PILL).forEach((pill) => resize.observe(pill));
    window.addEventListener("resize", changed);
    changed();

    return () => {
      disposed = true;
      now.current = () => undefined;
      resize.disconnect();
      window.removeEventListener("resize", changed);
      timers.forEach((id) => window.clearTimeout(id));
      timers.clear();
    };
  }, [bar, layoutKey]);

  return refresh;
}
