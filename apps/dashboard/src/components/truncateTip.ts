import { placeFloating } from "@rulebox/ui";

/**
 * The one shared tooltip of every `Truncate` on the page. Its own module, loaded by `Truncate` only when
 * a really cut text is first hovered or focused, so a list that never shows one does not pay for it
 * (nor for the floating-placement code it needs).
 */
const SHOW_DELAY_MS = 400;

let tip: HTMLDivElement | null = null;
let owner: HTMLElement | null = null;
let timer = 0;
let listening = false;

export function hideTip() {
  window.clearTimeout(timer);
  timer = 0;
  owner = null;
  if (tip) tip.hidden = true;
}

/** Hides the tooltip only if it belongs to `el` (the element went away). */
export function releaseTip(el: HTMLElement) {
  if (owner === el) hideTip();
}

function onEscape(e: KeyboardEvent) {
  if (e.key === "Escape") hideTip();
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
    window.addEventListener("scroll", hideTip, { capture: true, passive: true });
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

/** Shows `text` under `el`: at once (keyboard focus) or after 400 ms of hover. The caller checked the text is cut. */
export function scheduleTip(el: HTMLElement, text: string, immediate: boolean) {
  window.clearTimeout(timer);
  if (immediate) show(el, text);
  else timer = window.setTimeout(() => show(el, text), SHOW_DELAY_MS);
}
