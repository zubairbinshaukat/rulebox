import { useEffect } from "react";

/** What the Tab key can reach. */
const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function isFocusable(el: HTMLElement): boolean {
  if (el.hidden || el.closest("[hidden], [inert]")) return false;
  // `offsetParent` is null for fixed elements and in test DOMs; `checkVisibility` is not.
  return typeof el.checkVisibility === "function" ? el.checkVisibility({ visibilityProperty: true }) : true;
}

/** The focusable elements inside `root`, in tab order. */
export function focusablesIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(isFocusable);
}

/**
 * Keeps Tab and Shift+Tab inside `root` (a popup that holds the focus): from the
 * last element it goes to the first, from the first back to the last.
 */
export function trapTab(event: { key: string; shiftKey: boolean; preventDefault: () => void }, root: HTMLElement): void {
  if (event.key !== "Tab") return;
  const items = focusablesIn(root);
  if (items.length === 0) {
    event.preventDefault();
    root.focus();
    return;
  }
  const first = items[0]!;
  const last = items[items.length - 1]!;
  const active = document.activeElement;
  if (event.shiftKey && (active === first || active === root || !root.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || !root.contains(active))) {
    event.preventDefault();
    first.focus();
  }
}

/**
 * Puts the keyboard focus inside `root`: on the element marked `data-autofocus`,
 * else the first focusable one, else `root` itself. Does nothing when the focus
 * is already inside.
 */
export function focusInside(root: HTMLElement): void {
  if (root.contains(document.activeElement) && document.activeElement !== root) return;
  const target = root.querySelector<HTMLElement>("[data-autofocus]") ?? focusablesIn(root)[0] ?? root;
  target.focus();
}

/** Sets the window's title (what Windows and a screen reader call the page). */
export function useDocumentTitle(title: string): void {
  useEffect(() => {
    document.title = title;
  }, [title]);
}
