import { useCallback, useLayoutEffect, useRef, useState, type FocusEvent, type ReactNode } from "react";
import { truncateBoxProps } from "./truncateBox";

/**
 * Text cut with an ellipsis (1 to 3 lines) whose full text shows in one shared tooltip, and only when it
 * is really cut: after 400 ms of hover, at once on keyboard focus (of the link inside, or of the text
 * itself), gone on leave, blur and Escape. The full text is always in the page for screen readers and
 * find-in-page, so the tooltip is `aria-hidden`. Touch devices get no tooltip: the record's page shows it all.
 *
 * Cut plain text (an email, a signer) is a tab stop so keyboard users can reach the tooltip; text that
 * fits, or that holds its own link or button, never is. One `ResizeObserver` serves the whole page, and
 * the tooltip itself (`truncateTip.ts`) is downloaded the first time a cut text is hovered or focused.
 */
export interface TruncateProps {
  /** The full text for the tooltip. Default: the text the element holds. */
  full?: string;
  lines?: 1 | 2 | 3;
  /** Caps the width (a number is px). Default: the room the parent gives. */
  maxWidth?: number | string;
  className?: string;
  children: ReactNode;
}

const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex]';

/** True when the element's content does not fit its box. */
function isCut(el: HTMLElement, lines: number): boolean {
  return lines > 1 ? el.scrollHeight > el.clientHeight + 1 : el.scrollWidth > el.clientWidth + 1;
}

// ---- one observer for the whole page --------------------------------------------------------------

const watchers = new Map<Element, () => void>();
let observer: ResizeObserver | null = null;

function watch(el: HTMLElement, onSize: () => void): () => void {
  if (typeof ResizeObserver === "undefined") {
    onSize();
    return () => undefined;
  }
  observer ??= new ResizeObserver((entries) => {
    for (const e of entries) watchers.get(e.target)?.();
  });
  watchers.set(el, onSize);
  observer.observe(el);
  return () => {
    watchers.delete(el);
    observer?.unobserve(el);
  };
}

// ---- the tooltip module, loaded on first use ------------------------------------------------------

type TipModule = typeof import("./truncateTip");
let loaded: TipModule | null = null;
let loading: Promise<TipModule> | null = null;
/** The element the person is pointing at or focused on: a tooltip that finishes loading late checks it is still wanted. */
let wanted: HTMLElement | null = null;

function loadTip(): Promise<TipModule> {
  loading ??= import("./truncateTip").then((m) => (loaded = m));
  return loading;
}

function hide() {
  wanted = null;
  loaded?.hideTip();
}

function request(el: HTMLElement, text: string, lines: number, immediate: boolean) {
  // Touch: a tap fires "mouseenter" too, but there is nothing to hover; the record's page shows the full text.
  if (!immediate && window.matchMedia?.("(hover: none)").matches) return;
  if (!isCut(el, lines)) return;
  wanted = el;
  if (loaded) loaded.scheduleTip(el, text, immediate);
  else void loadTip().then((m) => (wanted === el ? m.scheduleTip(el, text, immediate) : undefined));
}

export function Truncate({ full, lines = 1, maxWidth, className, children }: TruncateProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const [tab, setTab] = useState(false);

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setTab(isCut(el, lines) && !el.querySelector(FOCUSABLE));
  }, [lines]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const stop = watch(el, measure);
    return () => {
      stop();
      if (wanted === el) hide();
      loaded?.releaseTip(el);
    };
  }, [measure]);

  const text = () => full ?? ref.current?.textContent ?? "";

  return (
    <span
      ref={ref}
      {...truncateBoxProps(lines, maxWidth, className)}
      tabIndex={tab ? 0 : undefined}
      onMouseEnter={(e) => request(e.currentTarget, text(), lines, false)}
      onMouseLeave={hide}
      onFocus={(e: FocusEvent<HTMLSpanElement>) => request(e.currentTarget, text(), lines, true)}
      onBlur={hide}
    >
      {children}
    </span>
  );
}
