import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from "react";

export type FloatingSide = "bottom" | "top";
export type FloatingAlign = "start" | "end" | "center";

export interface FloatingOptions {
  /** Preferred side; flips when the other side has more room. Default `"bottom"`. */
  side?: FloatingSide;
  /** Which edge of the anchor the popup lines up with. Default `"start"`. */
  align?: FloatingAlign;
  /** Space between anchor and popup in px. Default 6. */
  gap?: number;
  /** The popup is at least as wide as the anchor (dropdowns). */
  matchWidth?: boolean;
  /** Smallest distance to the viewport edge in px (phones included). Default 8. */
  margin?: number;
}

/** Reads a computed max size ("320px"), `Infinity` for "none" or when there is no layout (tests). */
function cssCap(value: string): number {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : Infinity;
}

/**
 * Puts `floating` (a `position: fixed` popup) next to `anchor`, inside the viewport:
 * below the anchor, or above it when there is more room there; clamped sideways with
 * `margin` px to spare; `max-width` and `max-height` are cut to the room left, so a
 * long list scrolls inside the popup instead of leaving the screen. Returns the side
 * chosen (also written to `data-side` for the entrance animation's direction).
 *
 * The popup's own CSS `max-width` / `max-height` are kept as upper bounds. Without
 * layout (jsdom: every rect is 0) it still returns a side and never throws.
 */
export function placeFloating(anchor: HTMLElement, floating: HTMLElement, opts: FloatingOptions = {}): FloatingSide {
  const { side = "bottom", align = "start", gap = 6, matchWidth = false, margin = 8 } = opts;
  const vw = document.documentElement.clientWidth || window.innerWidth || 0;
  let vh = window.innerHeight || document.documentElement.clientHeight || 0;
  // A phone's on-screen keyboard shrinks the visual viewport, not always the layout one.
  const vv = window.visualViewport;
  if (vv && vv.height > 0) vh = Math.min(vh, vv.offsetTop + vv.height);
  const a =anchor.getBoundingClientRect();

  const s = floating.style;
  s.position = "fixed";
  s.left = "0px";
  s.top = "0px";
  s.maxWidth = "";
  s.maxHeight = "";
  s.minWidth = matchWidth ? `${Math.round(a.width)}px` : "";
  const computed = getComputedStyle(floating);
  const capW = cssCap(computed.maxWidth);
  const capH = cssCap(computed.maxHeight);

  const maxW = Math.max(0, Math.min(capW, vw - margin * 2));
  if (vw > 0) s.maxWidth = `${maxW}px`;
  const width = Math.min(floating.offsetWidth, maxW || Infinity);
  const wanted = floating.offsetHeight; // natural height, only the CSS cap applied

  const below = vh - a.bottom - gap - margin;
  const above = a.top - gap - margin;
  const preferred = side === "bottom" ? below : above;
  const other = side === "bottom" ? above : below;
  const chosen: FloatingSide = wanted > preferred && other > preferred ? (side === "bottom" ? "top" : "bottom") : side;
  const room = Math.max(0, chosen === "bottom" ? below : above);
  const height = vh > 0 ? Math.min(wanted || Infinity, capH, room) : wanted;
  if (vh > 0) s.maxHeight = `${Math.floor(Math.min(capH, room))}px`;

  let left = align === "end" ? a.right - width : align === "center" ? a.left + a.width / 2 - width / 2 : a.left;
  if (vw > 0) left = Math.min(Math.max(left, margin), Math.max(margin, vw - margin - width));
  const top = chosen === "bottom" ? a.bottom + gap : a.top - gap - (Number.isFinite(height) ? height : 0);

  s.left = `${Math.round(left)}px`;
  s.top = `${Math.round(Math.max(top, 0))}px`;
  floating.dataset.side = chosen;
  return chosen;
}

/**
 * Where a popup is mounted: `document.body`. A card with `overflow: hidden` (or a
 * transformed / filtered ancestor) would clip or re-anchor a `position: fixed` child.
 * The dialogs (`Dialog`, the dashboard `Modal`) are plain `div`s, not native `<dialog>`
 * elements, so there is no top layer to climb into: the popups' `z-index` sits above the
 * dialog backdrop's instead (`--rb-z-banner` + 10, see components.css).
 */
export function floatingRoot(): HTMLElement {
  return document.body;
}

/**
 * Keeps `floatingRef` placed next to `anchorRef` while `open`: once before the first paint,
 * then on scroll (any scroller, captured) and resize, throttled to one run per frame, with
 * passive listeners that are removed on close and unmount. `update()` re-places on demand
 * (the popup's content changed size). Scrolling inside the popup itself never re-places it.
 */
export function useFloating(
  open: boolean,
  anchorRef: RefObject<HTMLElement | null>,
  floatingRef: RefObject<HTMLElement | null>,
  opts: FloatingOptions = {},
): { update: () => FloatingSide | null } {
  const optsRef = useRef(opts);
  // Before the placing effect below (effects run in order), so it always sees this render's options.
  useLayoutEffect(() => {
    optsRef.current = opts;
  });

  const update = useCallback((): FloatingSide | null => {
    const anchor = anchorRef.current;
    const floating = floatingRef.current;
    if (!anchor || !floating) return null;
    return placeFloating(anchor, floating, optsRef.current);
  }, [anchorRef, floatingRef]);

  useLayoutEffect(() => {
    if (open) update();
  }, [open, update]);

  useEffect(() => {
    if (!open) return;
    let frame = 0;
    const onChange = (e: Event) => {
      const floating = floatingRef.current;
      if (floating && e.target instanceof Node && floating.contains(e.target)) return;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        update();
      });
    };
    window.addEventListener("scroll", onChange, { capture: true, passive: true });
    window.addEventListener("resize", onChange, { passive: true });
    window.visualViewport?.addEventListener("resize", onChange, { passive: true });
    return () => {
      window.removeEventListener("scroll", onChange, { capture: true });
      window.removeEventListener("resize", onChange);
      window.visualViewport?.removeEventListener("resize", onChange);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [open, update, floatingRef]);

  return { update };
}
