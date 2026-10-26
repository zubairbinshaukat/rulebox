import type { KeyboardEvent } from "react";

export type RovingOrientation = "horizontal" | "vertical" | "both";

/**
 * Arrow-key movement inside a group of controls (tabs, radios, a toolbar).
 * Left/Right (horizontal), Up/Down (vertical) or both move to the next or
 * previous enabled item and wrap round; Home and End jump to the ends.
 *
 * Call it from the group's `onKeyDown`. It focuses the target and returns it
 * (the caller may then select it, for "automatic activation" tabs), or
 * returns `null` and leaves the event alone when the key is not a movement.
 */
export function rovingKeyDown(
  event: KeyboardEvent<HTMLElement>,
  itemSelector: string,
  orientation: RovingOrientation = "horizontal",
): HTMLElement | null {
  const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(itemSelector)).filter(
    (el) => !(el as HTMLButtonElement).disabled && el.getAttribute("aria-disabled") !== "true",
  );
  if (items.length === 0) return null;
  const from = items.indexOf((event.target as HTMLElement).closest<HTMLElement>(itemSelector) as HTMLElement);
  if (from < 0) return null;

  const next = event.key === "ArrowRight" || event.key === "ArrowDown";
  const prev = event.key === "ArrowLeft" || event.key === "ArrowUp";
  const horizontalKey = event.key === "ArrowRight" || event.key === "ArrowLeft";
  const verticalKey = event.key === "ArrowDown" || event.key === "ArrowUp";
  let to = from;
  if ((next || prev) && (orientation === "both" || (horizontalKey && orientation === "horizontal") || (verticalKey && orientation === "vertical"))) {
    to = (from + (next ? 1 : -1) + items.length) % items.length;
  } else if (event.key === "Home") {
    to = 0;
  } else if (event.key === "End") {
    to = items.length - 1;
  } else {
    return null;
  }
  event.preventDefault();
  const target = items[to]!;
  target.focus();
  return target;
}
