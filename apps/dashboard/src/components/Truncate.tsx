import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties, type FocusEvent, type ReactNode } from "react";
import { placeFloating } from "@rulebox/ui";

/**
 * Text cut with an ellipsis (1 to 3 lines) whose full text shows in one shared tooltip, and only when it
 * is really cut: after 400 ms of hover, at once on keyboard focus (of the link inside, or of the text
 * itself), gone on leave, blur and Escape. The full text is always in the page for screen readers and
 * find-in-page, so the tooltip is `aria-hidden`. Touch devices get no tooltip: the record's page shows it all.
 *
 * Cut plain text (an email, a signer) is a tab stop so keyboard users can reach the tooltip; text that
 * fits, or that holds its own link or button, never is. One `ResizeObserver` and one tooltip node serve
 * the whole page.
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

const SHOW_DELAY_MS = 400;
const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex]';

/** True when the element's content does not fit its box. */
function isCut(el: HTMLElement, lines: number): boolean {
  return lines > 1 ? el.scrollHeight > el.clientHeight + 1 : el.scrollWidth > el.clientWidth + 1;
}

// ---- one observer, one tooltip for the whole page -------------------------------------------------

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

let tip: HTMLDivElement | null = null;
let owner: HTMLElement | null = null;
let timer = 0;
let listening = false;

function hide() {
  window.clearTimeout(timer);
  timer = 0;
  owner = null;
  if (tip) tip.hidden = true;
}

function onEscape(e: KeyboardEvent) {
  if (e.key === "Escape") hide();
}

function ensureTip(): HTMLDivElement {
  if (!tip || !tip.isConnected) {
    tip = document.createElement("div");
    tip.className = "dash-truncate-tip";
    tip.setAttribute("aria-hidden", "true");
    tip.hidden = true;
    document.body.appendChild(tip);
  }
  if (!listening) {
    listening = true;
    document.addEventListener("keydown", onEscape);
    window.addEventListener("scroll", hide, { capture: true, passive: true });
  }
  return tip;
}

function show(el: HTMLElement, text: string) {
  const t = ensureTip();
  t.textContent = text;
  t.hidden = false;
  owner = el;
  placeFloating(el, t, { side: "bottom", align: "start", gap: 6 });
}

function schedule(el: HTMLElement, text: () => string, lines: number, immediate: boolean) {
  window.clearTimeout(timer);
  // Touch: a tap fires "mouseenter" too, but there is nothing to hover; the record's page shows the full text.
  if (!immediate && window.matchMedia?.("(hover: none)").matches) return;
  if (!isCut(el, lines)) return;
  if (immediate) show(el, text());
  else timer = window.setTimeout(() => show(el, text()), SHOW_DELAY_MS);
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
      if (owner === el) hide();
    };
  }, [measure]);

  const text = () => full ?? ref.current?.textContent ?? "";
  const style: CSSProperties | undefined = maxWidth === undefined ? undefined : { maxWidth };

  return (
    <span
      ref={ref}
      className={["dash-truncate-box", lines > 1 ? "dash-truncate-box--lines" : "", className ?? ""].filter(Boolean).join(" ")}
      data-lines={lines}
      style={lines > 1 ? ({ ...style, "--dash-lines": lines } as CSSProperties) : style}
      tabIndex={tab ? 0 : undefined}
      onMouseEnter={(e) => schedule(e.currentTarget, text, lines, false)}
      onMouseLeave={hide}
      onFocus={(e: FocusEvent<HTMLSpanElement>) => schedule(e.currentTarget, text, lines, true)}
      onBlur={hide}
    >
      {children}
    </span>
  );
}
